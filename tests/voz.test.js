// GRAVAÇÃO DE VOZ: a reembalagem de webm/opus para ogg/opus.
//
// Existe porque este é o ponto onde o recado de voz quebra em silêncio. A Cloud
// API aceita OGG só com codec Opus, e o Chrome — que é a maioria — grava
// audio/webm. Os dois carregam os MESMOS pacotes Opus, então o áudio é
// reembalado no navegador, sem recodificar. Se o Ogg sair malformado, a Meta
// recusa o envio e o atendente não entende por quê.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

global.window = undefined;
const voz = require(R + 'public/app/voz.js');

// ---- monta um webm mínimo, do jeito que o MediaRecorder entrega ------------
function vint(n) {                    // tamanho em 1 byte (só valores pequenos)
  return [0x80 | n];
}
function elem(id, corpo) {
  const idb = [];
  let x = id;
  const bytes = [];
  while (x > 0) { bytes.unshift(x & 0xff); x = Math.floor(x / 256); }
  idb.push(...bytes);
  return [...idb, ...vint(corpo.length), ...corpo];
}
function simpleBlock(pacote) {
  // faixa 1 (vint 0x81) + timecode 2 bytes + flags 1 byte + dados
  return elem(0xA3, [0x81, 0, 0, 0x80, ...pacote]);
}

// Pacotes Opus de mentira, mas com TOC real: config 3 (20 ms), mono, 1 quadro.
const TOC_20MS = 0x08;   // cfg=1 → 20 ms, c=0 → 1 quadro
function pacote(n) { return [TOC_20MS, ...Array.from({ length: n }, (_, i) => (i * 7) & 0xff)]; }

const PACOTES = [pacote(40), pacote(38), pacote(44), pacote(41), pacote(39)];
const cluster = elem(0x1F43B675, PACOTES.flatMap(simpleBlock));
const webm = new Uint8Array(elem(0x18538067, cluster));

(async () => {
  console.log('=== 1. Os pacotes Opus são recuperados do webm ===');
  const ogg = voz.webmParaOgg(webm.buffer);
  ok(!!ogg, 'a reembalagem devolveu bytes');
  ok(ogg.length > 0, `tamanho: ${ogg ? ogg.length : 0} bytes`);

  console.log('\n=== 2. O arquivo é um Ogg de verdade ===');
  const txt = (a, i, n) => String.fromCharCode(...a.slice(i, i + n));
  ok(txt(ogg, 0, 4) === 'OggS', 'começa com a assinatura OggS');

  // percorre as páginas conferindo assinatura, CRC e ordem
  const paginas = [];
  let p = 0;
  while (p < ogg.length) {
    if (txt(ogg, p, 4) !== 'OggS') { ok(false, 'página malformada em ' + p); break; }
    const nsegs = ogg[p + 26];
    let corpo = 0;
    for (let i = 0; i < nsegs; i++) corpo += ogg[p + 27 + i];
    const fim = p + 27 + nsegs + corpo;
    paginas.push({ ini: p, fim, tipo: ogg[p + 5], nsegs });
    p = fim;
  }
  ok(paginas.length >= 3, `páginas geradas: ${paginas.length} (cabeçalho, tags e áudio)`);
  ok(paginas[0].tipo === 2, 'a primeira página é marcada como início do fluxo');
  ok(paginas[paginas.length - 1].tipo === 4, 'a última é marcada como fim do fluxo');

  console.log('\n=== 3. Os cabeçalhos que o Opus exige ===');
  const c0 = paginas[0];
  const h = ogg.slice(c0.ini + 27 + c0.nsegs, c0.fim);
  ok(txt(h, 0, 8) === 'OpusHead', 'a primeira página carrega OpusHead');
  const taxa = h[12] | (h[13] << 8) | (h[14] << 16) | (h[15] << 24);
  ok(taxa === 48000, `taxa declarada: ${taxa} Hz`);
  const c1 = paginas[1];
  ok(txt(ogg.slice(c1.ini + 27 + c1.nsegs, c1.fim), 0, 8) === 'OpusTags', 'a segunda carrega OpusTags');

  console.log('\n=== 4. O CRC de cada página confere ===');
  // CRC errado é o erro que faz TODO tocador recusar o arquivo sem dizer nada.
  let crcOk = true;
  for (const pg of paginas) {
    const bytes = ogg.slice(pg.ini, pg.fim);
    const gravado = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24);
    const zerado = Uint8Array.from(bytes);
    zerado[22] = zerado[23] = zerado[24] = zerado[25] = 0;
    if ((voz.crcOgg(zerado) >>> 0) !== (gravado >>> 0)) crcOk = false;
  }
  ok(crcOk, 'todas as páginas passam na verificação de CRC');

  console.log('\n=== 5. A duração sai certa ===');
  // 5 pacotes de 20 ms = 100 ms = 4800 amostras a 48 kHz. Granulo errado faz o
  // tocador mostrar a duração errada e a barra de progresso não bater.
  ok(voz.amostrasDoPacote(Uint8Array.from(pacote(40))) === 960, 'pacote de 20 ms = 960 amostras');
  const ult = paginas[paginas.length - 1];
  const g = ogg[ult.ini + 6] | (ogg[ult.ini + 7] << 8) | (ogg[ult.ini + 8] << 16) | (ogg[ult.ini + 9] << 24);
  ok(g === 4800, `granulo final = ${g} amostras (100 ms de áudio)`);

  console.log('\n=== 6. O formato escolhido é sempre um que a Meta aceita ===');
  // A lista de preferência não pode deixar webm passar na frente de ogg/mp4.
  const fonte = require('fs').readFileSync(R + 'public/app/voz.js', 'utf8');
  const lista = fonte.slice(fonte.indexOf('const PREFERIDOS'), fonte.indexOf('];', fonte.indexOf('const PREFERIDOS')));
  ok(lista.indexOf("'audio/ogg;codecs=opus'") < lista.indexOf("'audio/webm"), 'ogg/opus vem antes de webm');
  ok(lista.indexOf("'audio/mp4'") < lista.indexOf("'audio/webm"), 'mp4 vem antes de webm');

  console.log('\n=== 7. Entrada sem áudio não vira arquivo quebrado ===');
  ok(voz.webmParaOgg(new Uint8Array([1, 2, 3]).buffer) === null, 'lixo devolve null, não um Ogg vazio');

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
