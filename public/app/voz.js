/* ===========================================================================
 * GRAVAR MENSAGEM DE VOZ
 *
 * Enviar áudio pela API oficial sempre funcionou — o que faltava era GRAVAR:
 * só dava para anexar um arquivo que já existisse no aparelho, e ninguém grava
 * um .mp3 no celular para responder um cliente.
 *
 * O nó do problema é o FORMATO. A Cloud API aceita AAC, AMR, MP3, MP4 e OGG
 * (este último só com codec Opus). O `MediaRecorder` de cada navegador grava
 * uma coisa diferente:
 *
 *   Firefox → audio/ogg;codecs=opus   ✅ a Meta aceita direto
 *   Safari  → audio/mp4               ✅ a Meta aceita direto
 *   Chrome  → audio/webm;codecs=opus  ❌ a Meta RECUSA o container webm
 *
 * Como o Chrome é a maioria, gravar e mandar direto falharia para quase todo
 * mundo. Mas webm e ogg aqui carregam exatamente os mesmos pacotes Opus — muda
 * só a embalagem. Então o áudio é REEMBALADO de webm para ogg no próprio
 * navegador, sem recodificar: nada de perda de qualidade e nada de biblioteca
 * externa.
 * =========================================================================== */
(function (global) {
  'use strict';

  // ---- formato a gravar -----------------------------------------------------
  // Ordem de preferência: o que a Meta aceita sem conversão vem primeiro.
  const PREFERIDOS = [
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
    'audio/webm;codecs=opus',   // exige reembalagem
    'audio/webm'
  ];

  function formatoSuportado() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const t of PREFERIDOS) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {}
    }
    return '';
  }

  function suportado() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && formatoSuportado());
  }

  // ===========================================================================
  // LEITURA DO WEBM (Matroska)
  //
  // Só o necessário: achar os SimpleBlock dentro dos Clusters e tirar deles os
  // pacotes Opus. O `MediaRecorder` grava uma faixa só e sem lacing, o que
  // deixa a leitura direta.
  // ===========================================================================
  // Os limites são conferidos a cada leitura: o buffer pode não ser um webm
  // (navegador que mudou de formato, gravação truncada), e ler fora do fim
  // derrubava a função inteira com um erro de DataView em vez de simplesmente
  // não achar áudio.
  function lerVint(dv, pos, mascarar) {
    if (pos < 0 || pos >= dv.byteLength) return null;
    const b0 = dv.getUint8(pos);
    if (b0 === 0) return null;
    let tam = 1, mask = 0x80;
    while (!(b0 & mask)) { mask >>= 1; tam++; }
    if (tam > 8 || pos + tam > dv.byteLength) return null;
    let v = mascarar ? (b0 & (mask - 1)) : b0;
    for (let i = 1; i < tam; i++) v = v * 256 + dv.getUint8(pos + i);
    return { valor: v, tam };
  }

  const ID_SEGMENT = 0x18538067, ID_CLUSTER = 0x1F43B675;
  const ID_TRACKS = 0x1654AE6B, ID_TRACKENTRY = 0xAE, ID_CODECPRIVATE = 0x63A2;
  // Estes contêm outros elementos: entra-se neles em vez de pular.
  const RECIPIENTES = new Set([ID_SEGMENT, ID_CLUSTER, ID_TRACKS, ID_TRACKENTRY]);

  function extrairOpusDoWebm(buf) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    const pacotes = [];
    let opusHead = null;
    let pos = 0;

    while (pos < dv.byteLength - 1) {
      const id = lerVint(dv, pos, false);
      if (!id) { pos++; continue; }
      const tamPos = pos + id.tam;
      if (tamPos >= dv.byteLength) break;
      const tam = lerVint(dv, tamPos, true);
      if (!tam) { pos++; continue; }
      const corpo = tamPos + tam.tam;

      if (RECIPIENTES.has(id.valor)) { pos = corpo; continue; }

      if (id.valor === ID_CODECPRIVATE && !opusHead) {
        opusHead = u8.slice(corpo, corpo + tam.valor);
      } else if (id.valor === 0xA3) {              // SimpleBlock
        const faixa = lerVint(dv, corpo, true);
        if (faixa) {
          // vint da faixa + 2 bytes de timecode + 1 de flags
          const ini = corpo + faixa.tam + 3;
          const fim = corpo + tam.valor;
          if (fim > ini && fim <= u8.length) pacotes.push(u8.slice(ini, fim));
        }
      }
      const prox = corpo + tam.valor;
      if (prox <= pos) break;        // trava contra laço infinito em lixo
      pos = prox;
    }
    return { pacotes, opusHead };
  }

  // ===========================================================================
  // ESCRITA DO OGG
  // ===========================================================================
  // CRC do Ogg: polinômio 0x04c11db7, sem reflexão e sem inversão final — não é
  // o CRC32 comum do zlib, e usar o comum faria todo tocador recusar o arquivo.
  const TAB_CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = (r & 0x80000000) ? ((r << 1) ^ 0x04c11db7) : (r << 1);
      t[i] = r >>> 0;
    }
    return t;
  })();

  function crcOgg(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc = ((crc << 8) ^ TAB_CRC[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
    }
    return crc >>> 0;
  }

  // Uma página Ogg com os pacotes dados. `tipo`: 2=início, 4=fim, 0=meio.
  function paginaOgg(pacotes, granulo, serial, seq, tipo) {
    const segs = [];
    for (const p of pacotes) {
      let resto = p.length;
      while (resto >= 255) { segs.push(255); resto -= 255; }
      segs.push(resto);
    }
    const corpo = pacotes.reduce((n, p) => n + p.length, 0);
    const pag = new Uint8Array(27 + segs.length + corpo);
    const dv = new DataView(pag.buffer);
    pag.set([0x4f, 0x67, 0x67, 0x53], 0);           // "OggS"
    pag[4] = 0;                                      // versão
    pag[5] = tipo;
    // granulo é de 64 bits; áudio de recado nunca chega perto do limite de 32,
    // mas os 8 bytes são escritos assim mesmo para o cabeçalho ficar correto.
    dv.setUint32(6, granulo >>> 0, true);
    dv.setUint32(10, Math.floor(granulo / 4294967296), true);
    dv.setUint32(14, serial, true);
    dv.setUint32(18, seq, true);
    dv.setUint32(22, 0, true);                       // CRC entra depois
    pag[26] = segs.length;
    pag.set(segs, 27);
    let off = 27 + segs.length;
    for (const p of pacotes) { pag.set(p, off); off += p.length; }
    dv.setUint32(22, crcOgg(pag), true);
    return pag;
  }

  const OPUS_HEAD_PADRAO = (() => {
    const h = new Uint8Array(19);
    h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);   // "OpusHead"
    h[8] = 1;            // versão
    h[9] = 1;            // canais (mono: o recado de voz não precisa de estéreo)
    h[10] = 0x38; h[11] = 0x01;    // pré-corte 312
    h[12] = 0x80; h[13] = 0xbb; h[14] = 0; h[15] = 0;   // 48000 Hz
    return h;
  })();

  function opusTags() {
    const nome = new TextEncoder().encode('Koonfy');
    const t = new Uint8Array(8 + 4 + nome.length + 4);
    t.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0);   // "OpusTags"
    new DataView(t.buffer).setUint32(8, nome.length, true);
    t.set(nome, 12);
    return t;
  }

  // Duração de um pacote Opus, em amostras de 48 kHz, lida do byte TOC.
  // Sem isto o granulo sairia errado e o tocador mostraria a duração errada.
  function amostrasDoPacote(p) {
    if (!p || !p.length) return 960;
    const toc = p[0], cfg = toc >> 3;
    let ms;
    if (cfg < 12) ms = [10, 20, 40, 60][cfg % 4];
    else if (cfg < 16) ms = [10, 20][cfg % 2];
    else ms = [2.5, 5, 10, 20][cfg % 4];
    const c = toc & 0x03;
    const quadros = c === 0 ? 1 : c === 3 ? (p.length > 1 ? (p[1] & 0x3f) : 1) : 2;
    return Math.round(ms * 48) * quadros;
  }

  function webmParaOgg(buf) {
    const { pacotes, opusHead } = extrairOpusDoWebm(buf);
    if (!pacotes.length) return null;

    const serial = (Math.random() * 0xffffffff) >>> 0;
    const paginas = [];
    let seq = 0;
    paginas.push(paginaOgg([opusHead && opusHead.length >= 19 ? opusHead : OPUS_HEAD_PADRAO], 0, serial, seq++, 2));
    paginas.push(paginaOgg([opusTags()], 0, serial, seq++, 0));

    // Até 50 pacotes por página: o limite do formato é 255 segmentos, e agrupar
    // demais estoura em pacotes grandes.
    let granulo = 0;
    for (let i = 0; i < pacotes.length; i += 50) {
      const lote = pacotes.slice(i, i + 50);
      for (const p of lote) granulo += amostrasDoPacote(p);
      const ultimo = i + 50 >= pacotes.length;
      paginas.push(paginaOgg(lote, granulo, serial, seq++, ultimo ? 4 : 0));
    }

    const total = paginas.reduce((n, p) => n + p.length, 0);
    const saida = new Uint8Array(total);
    let off = 0;
    for (const p of paginas) { saida.set(p, off); off += p.length; }
    return saida;
  }

  // ---- gravação -------------------------------------------------------------
  let gravador = null, pedacos = [], fluxo = null, inicio = 0;

  async function iniciar(aoAtualizar) {
    if (gravador) return false;
    const mime = formatoSuportado();
    if (!mime) throw new Error('Este navegador não grava áudio');
    fluxo = await navigator.mediaDevices.getUserMedia({ audio: true });
    pedacos = [];
    gravador = new MediaRecorder(fluxo, { mimeType: mime });
    gravador.ondataavailable = e => { if (e.data && e.data.size) pedacos.push(e.data); };
    gravador.start(250);
    inicio = Date.now();
    if (aoAtualizar) {
      gravador._tick = setInterval(() => aoAtualizar(Math.floor((Date.now() - inicio) / 1000)), 250);
    }
    return true;
  }

  // Encerra e devolve o áudio JÁ no formato que a Meta aceita.
  function parar() {
    return new Promise((resolve, reject) => {
      if (!gravador) return resolve(null);
      const g = gravador, mime = g.mimeType || '';
      clearInterval(g._tick);
      g.onstop = async () => {
        try {
          const bruto = new Blob(pedacos, { type: mime });
          soltarMicrofone();
          if (!/webm/i.test(mime)) {
            return resolve({ blob: bruto, mime: mime.split(';')[0], ext: extDe(mime), segundos: dur() });
          }
          const ogg = webmParaOgg(await bruto.arrayBuffer());
          if (!ogg) return reject(new Error('Não foi possível preparar o áudio'));
          resolve({ blob: new Blob([ogg], { type: 'audio/ogg' }), mime: 'audio/ogg', ext: 'ogg', segundos: dur() });
        } catch (e) { soltarMicrofone(); reject(e); }
      };
      const dur = () => Math.max(1, Math.round((Date.now() - inicio) / 1000));
      g.stop();
      gravador = null;
    });
  }

  function cancelar() {
    if (!gravador) return;
    clearInterval(gravador._tick);
    gravador.onstop = null;
    try { gravador.stop(); } catch (e) {}
    gravador = null;
    pedacos = [];
    soltarMicrofone();
  }

  // O ponto vermelho do navegador só some quando as trilhas param de verdade.
  function soltarMicrofone() {
    if (!fluxo) return;
    try { fluxo.getTracks().forEach(t => t.stop()); } catch (e) {}
    fluxo = null;
  }

  function extDe(mime) {
    if (/ogg/i.test(mime)) return 'ogg';
    if (/mp4|aac/i.test(mime)) return 'm4a';
    if (/mpeg/i.test(mime)) return 'mp3';
    return 'ogg';
  }

  global.ECVoz = {
    suportado, formatoSuportado, iniciar, parar, cancelar,
    gravando: () => !!gravador,
    // exportados para teste
    webmParaOgg, crcOgg, amostrasDoPacote, paginaOgg
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).ECVoz;
}
