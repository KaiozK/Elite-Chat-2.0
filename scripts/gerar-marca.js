/* ===========================================================================
 * TAMANHOS DA MARCA KOONFY
 *
 * A arte oficial é public/assets/koonfy-logo.png, com 1254×1254 e quase 1 MB.
 * Servir esse arquivo para desenhar um logotipo de 34px na barra lateral é
 * desperdício em toda visita — e no celular, em dado de quem está pagando por
 * ele. Este script reduz a arte para os tamanhos que a interface realmente
 * usa, mantendo o arquivo original como fonte.
 *
 * Sem dependência de imagem: o PNG é lido e escrito com o zlib que já vem no
 * Node. Redução por MÉDIA de área (box filter) — para diminuir, dá resultado
 * melhor que interpolação, sem serrilhado nas diagonais do K.
 *
 * Rodar:  node scripts/gerar-marca.js
 * =========================================================================== */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const RAIZ = path.join(__dirname, '..', 'public', 'assets');
const FONTE = path.join(RAIZ, 'koonfy-logo.png');
const TAMANHOS = [32, 64, 128, 180, 192, 512];

// ---- leitura do PNG --------------------------------------------------------
function lerPng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('não é PNG');
  let pos = 8, larg = 0, alt = 0, prof = 0, tipo = 0;
  const pedacos = [];
  let paleta = null, trans = null;

  while (pos < buf.length) {
    const tam = buf.readUInt32BE(pos);
    const nome = buf.toString('ascii', pos + 4, pos + 8);
    const dados = buf.slice(pos + 8, pos + 8 + tam);
    if (nome === 'IHDR') {
      larg = dados.readUInt32BE(0); alt = dados.readUInt32BE(4);
      prof = dados[8]; tipo = dados[9];
      if (prof !== 8) throw new Error('só 8 bits por canal (veio ' + prof + ')');
      if (dados[12] !== 0) throw new Error('PNG entrelaçado não é suportado');
    } else if (nome === 'PLTE') paleta = dados;
    else if (nome === 'tRNS') trans = dados;
    else if (nome === 'IDAT') pedacos.push(dados);
    else if (nome === 'IEND') break;
    pos += 12 + tam;
  }

  const canais = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[tipo];
  if (!canais) throw new Error('tipo de cor não suportado: ' + tipo);
  const bruto = zlib.inflateSync(Buffer.concat(pedacos));
  const linha = larg * canais;
  const out = Buffer.alloc(larg * alt * 4);
  const ant = Buffer.alloc(linha);
  const atual = Buffer.alloc(linha);

  for (let y = 0; y < alt; y++) {
    const filtro = bruto[y * (linha + 1)];
    bruto.copy(atual, 0, y * (linha + 1) + 1, (y + 1) * (linha + 1));
    // Desfaz o filtro da linha. São os 5 do formato; pular qualquer um faz a
    // imagem sair rasgada em vez de dar erro, que é pior.
    for (let i = 0; i < linha; i++) {
      const a = i >= canais ? atual[i - canais] : 0;
      const b = ant[i];
      const c = i >= canais ? ant[i - canais] : 0;
      let v = atual[i];
      if (filtro === 1) v += a;
      else if (filtro === 2) v += b;
      else if (filtro === 3) v += (a + b) >> 1;
      else if (filtro === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      atual[i] = v & 0xff;
    }
    for (let x = 0; x < larg; x++) {
      const s = x * canais, d = (y * larg + x) * 4;
      if (tipo === 6) { out[d] = atual[s]; out[d + 1] = atual[s + 1]; out[d + 2] = atual[s + 2]; out[d + 3] = atual[s + 3]; }
      else if (tipo === 2) { out[d] = atual[s]; out[d + 1] = atual[s + 1]; out[d + 2] = atual[s + 2]; out[d + 3] = 255; }
      else if (tipo === 0) { out[d] = out[d + 1] = out[d + 2] = atual[s]; out[d + 3] = 255; }
      else if (tipo === 4) { out[d] = out[d + 1] = out[d + 2] = atual[s]; out[d + 3] = atual[s + 1]; }
      else if (tipo === 3) {
        const i = atual[s] * 3;
        out[d] = paleta[i]; out[d + 1] = paleta[i + 1]; out[d + 2] = paleta[i + 2];
        out[d + 3] = trans && atual[s] < trans.length ? trans[atual[s]] : 255;
      }
    }
    atual.copy(ant);
  }
  return { larg, alt, px: out };
}

// ---- cantos transparentes --------------------------------------------------
// A arte veio em RGB, SEM canal alfa: os cantos arredondados são pixels PRETOS,
// não vazios. Sobre o fundo claro do app isso aparecia como quatro cunhas
// escuras em volta do símbolo.
//
// A marca não tem nenhum pixel escuro — é verde e branco —, então tudo que for
// quase preto é o fundo que deveria estar vazio. A varredura parte dos quatro
// cantos e só apaga o que está LIGADO a eles, para que um pixel escuro no meio
// do desenho (se um dia existir) não seja comido junto.
function recortarFundo(img) {
  const { larg, alt, px } = img;
  const escuro = i => px[i] < 40 && px[i + 1] < 40 && px[i + 2] < 40;
  const visto = new Uint8Array(larg * alt);
  const fila = [];
  const por = (x, y) => {
    if (x < 0 || y < 0 || x >= larg || y >= alt) return;
    const p = y * larg + x;
    if (visto[p]) return;
    if (!escuro(p * 4)) return;
    visto[p] = 1; fila.push(p);
  };
  for (let x = 0; x < larg; x++) { por(x, 0); por(x, alt - 1); }
  for (let y = 0; y < alt; y++) { por(0, y); por(larg - 1, y); }
  while (fila.length) {
    const p = fila.pop();
    const x = p % larg, y = (p / larg) | 0;
    px[p * 4 + 3] = 0;
    por(x + 1, y); por(x - 1, y); por(x, y + 1); por(x, y - 1);
  }
  return img;
}

// ---- redução por média de área --------------------------------------------
// A cor é ponderada pelo alfa: sem isso, pixels transparentes das bordas
// puxariam a média para o preto e a marca ficaria com um contorno sujo.
function reduzir(img, lado) {
  const out = Buffer.alloc(lado * lado * 4);
  const ex = img.larg / lado, ey = img.alt / lado;
  for (let j = 0; j < lado; j++) {
    const y0 = Math.floor(j * ey), y1 = Math.max(y0 + 1, Math.floor((j + 1) * ey));
    for (let i = 0; i < lado; i++) {
      const x0 = Math.floor(i * ex), x1 = Math.max(x0 + 1, Math.floor((i + 1) * ex));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const s = (y * img.larg + x) * 4, al = img.px[s + 3];
          r += img.px[s] * al; g += img.px[s + 1] * al; b += img.px[s + 2] * al;
          a += al; n++;
        }
      }
      const d = (j * lado + i) * 4;
      if (a === 0) { out[d] = out[d + 1] = out[d + 2] = out[d + 3] = 0; continue; }
      out[d] = Math.round(r / a); out[d + 1] = Math.round(g / a); out[d + 2] = Math.round(b / a);
      out[d + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---- escrita do PNG --------------------------------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function bloco(tipo, dados) {
  const t = Buffer.from(tipo, 'ascii');
  const tam = Buffer.alloc(4); tam.writeUInt32BE(dados.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, dados])), 0);
  return Buffer.concat([tam, t, dados, crc]);
}
function escreverPng(lado, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const linhas = Buffer.alloc((lado * 4 + 1) * lado);
  for (let j = 0; j < lado; j++) {
    linhas[j * (lado * 4 + 1)] = 0;
    px.copy(linhas, j * (lado * 4 + 1) + 1, j * lado * 4, (j + 1) * lado * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(linhas, { level: 9 })),
    bloco('IEND', Buffer.alloc(0))
  ]);
}

// ---- ícone MASKABLE --------------------------------------------------------
// O Android não usa o ícone como ele é: recorta em círculo, squircle ou gota,
// conforme o aparelho. O que sobra garantido é a "zona segura" — os 80%
// centrais. Uma arte que sangra até a borda, como a nossa, tem as pontas
// comidas: o símbolo do infinito perde as duas voltas.
//
// Este ícone é o mesmo desenho REDUZIDO dentro de um campo verde, de modo que
// tudo que importa caiba na zona segura, e a moldura que o sistema corta seja
// só cor. Por isso ele é um arquivo separado do ícone comum.
// A moldura não é uma cor chapada: ela CONTINUA o degradê da própria arte. Com
// verde chapado dava para ver a emenda — um quadrado desenhado dentro de outro.
// Os cantos são lidos do arquivo, então a moldura acompanha qualquer arte nova.
function comMargem(img, lado) {
  const cantoDe = (fx, fy) => {
    const x = Math.round((img.larg - 1) * fx), y = Math.round((img.alt - 1) * fy);
    const o = (y * img.larg + x) * 4;
    return [img.px[o], img.px[o + 1], img.px[o + 2]];
  };
  const c0 = cantoDe(0.02, 0.02), c1 = cantoDe(0.98, 0.98);

  const arte = 0.74;                       // dentro dos 80% que o sistema preserva
  const interno = Math.round(lado * arte);
  const pequeno = reduzir(img, interno);
  const out = Buffer.alloc(lado * lado * 4);

  const off = Math.round((lado - interno) / 2);

  // O fundo CONTINUA o degradê da arte na MESMA escala dela — por isso o `t` é
  // medido no sistema de coordenadas da arte e extrapolado para fora. Medindo
  // sobre a tela inteira, o degradê de dentro ficaria comprimido em relação ao
  // de fora e a emenda aparecia como um quadrado mais claro no meio.
  for (let j = 0; j < lado; j++) {
    for (let i = 0; i < lado; i++) {
      const tx = (i - off) / (interno - 1);
      const ty = (j - off) / (interno - 1);
      const t = (tx + ty) / 2;
      const d = (j * lado + i) * 4;
      for (let k = 0; k < 3; k++) {
        const v = c0[k] + (c1[k] - c0[k]) * t;
        out[d + k] = Math.max(0, Math.min(255, Math.round(v)));
      }
      out[d + 3] = 255;
    }
  }
  for (let j = 0; j < interno; j++) {
    for (let i = 0; i < interno; i++) {
      const s = (j * interno + i) * 4, d = ((j + off) * lado + (i + off)) * 4;
      const a = pequeno[s + 3] / 255;
      if (!a) continue;
      for (let k = 0; k < 3; k++) out[d + k] = Math.round(pequeno[s + k] * a + out[d + k] * (1 - a));
    }
  }
  return out;
}

// ---- saída -----------------------------------------------------------------
const orig = recortarFundo(lerPng(fs.readFileSync(FONTE)));
console.log(`fonte: koonfy-logo.png ${orig.larg}×${orig.alt}, ${(fs.statSync(FONTE).size / 1024).toFixed(0)} KB`);
for (const t of [192, 512]) {
  const arq = path.join(RAIZ, `koonfy-maskable-${t}.png`);
  fs.writeFileSync(arq, escreverPng(t, comMargem(orig, t)));
  console.log(`  koonfy-maskable-${t}.png  ${(fs.statSync(arq).size / 1024).toFixed(1)} KB`);
}
for (const t of TAMANHOS) {
  const arq = path.join(RAIZ, `koonfy-${t}.png`);
  fs.writeFileSync(arq, escreverPng(t, reduzir(orig, t)));
  console.log(`  koonfy-${t}.png  ${(fs.statSync(arq).size / 1024).toFixed(1)} KB`);
}
