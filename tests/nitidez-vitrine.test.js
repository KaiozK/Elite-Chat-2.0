// AS ARTES DA VITRINE PRECISAM SOBRAR PIXEL NO TAMANHO EM QUE APARECEM.
//
// Já cortei estes arquivos uma vez, pela regra "o dobro do tamanho em que
// aparece, que é o que uma tela retina desenha". A regra é boa para uma imagem
// parada numa tela 2x, e errada aqui por três motivos ao mesmo tempo:
//
//   1. A JOIA é UM arquivo para SETE paradas de tamanhos diferentes. Quem manda
//      é a MAIOR (240px) — dimensionar pela média deixa a maior borrada.
//   2. CELULAR DESENHA EM 3x. 240 CSS x 3 = 720 pixels reais; o arquivo tinha
//      480, então o navegador ESTICAVA a arte em 1,5x.
//   3. A joia é desenhada sob `transform` (translate + rotate): é reamostrada
//      em posição quebrada. A 1:1 não sobra nada para perder.
//
// O sintoma era exatamente esse, e foi assim que ele chegou: borrada no alto da
// página, onde a peça é grande, e nítida assim que encolhe — nas paradas de
// baixo sobravam de 2x a 3,4x de pixel.
//
// Este teste é a trava. Ele lê a LARGURA REAL de cada arquivo e o tamanho em
// que a página o exibe, e cobra folga em 3x. Se alguém (eu, de novo) reduzir
// uma arte "para economizar", o teste cai aqui, com a conta na tela, em vez de
// o defeito aparecer na home meses depois.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
const fs = require('fs');
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// Largura e altura de um WebP, direto do cabeçalho — sem depender de biblioteca
// de imagem, que este projeto não tem instalada.
function medirWebp(caminho) {
  const b = fs.readFileSync(caminho);
  if (b.slice(0, 4).toString() !== 'RIFF' || b.slice(8, 12).toString() !== 'WEBP') return null;
  const forma = b.slice(12, 16).toString();
  if (forma === 'VP8X') return { w: (b[24] | b[25] << 8 | b[26] << 16) + 1, h: (b[27] | b[28] << 8 | b[29] << 16) + 1 };
  if (forma === 'VP8L') { const p = b.readUInt32LE(21); return { w: (p & 0x3FFF) + 1, h: ((p >> 14) & 0x3FFF) + 1 }; }
  if (forma === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  return null;
}

// `exibida` é a MAIOR largura em CSS px em que a peça aparece na vitrine.
// `motivo` existe para quem for mexer entender por que aquele número, sem ter
// de reabrir o HTML e caçar a regra.
const ARTES = [
  { arq: 'koonfy-joia.webp', exibida: 240,
    motivo: 'a primeira parada da joia, no herói — a maior das sete' },
  { arq: 'meta-tech-partner.webp', exibida: 420,
    motivo: 'min(420px,80vw) no herói, e é tipografia fina: meio pixel de borrão se vê' },
  { arq: 'figma-celular.webp', exibida: 360,
    motivo: 'o aparelho na seção do produto' },
  { arq: 'koonfy-marca.webp', exibida: 120,
    motivo: 'a palavra da marca no rodapé, maior que os 104 da barra' }
];

console.log('=== 1. Toda arte da vitrine sobra pixel num celular 3x ===');
for (const a of ARTES) {
  const d = medirWebp(R + 'public/assets/' + a.arq);
  if (!d) { ok(false, a.arq + ': não consegui ler o cabeçalho do WebP'); continue; }
  const folga = d.w / (a.exibida * 3);
  ok(folga >= 1, `${a.arq}: ${d.w}px para ${a.exibida} exibidos = ${folga.toFixed(2)}x em 3x (${a.motivo})`);
}

console.log('\n=== 2. O HTML declara o tamanho REAL do arquivo ===');
// O atributo `width`/`height` não dimensiona nada aqui (o CSS vence), mas é
// dele que o navegador tira a proporção antes da imagem chegar. Declarar um
// tamanho que não é o do arquivo foi o que quebrou o iPhone da landing uma vez:
// o atributo passou a valer porque o CSS não tinha `height`.
const html = fs.readFileSync(R + 'public/nova.html', 'utf8');
for (const a of ARTES) {
  const tag = (html.match(new RegExp('<img[^>]*' + a.arq.replace('.', '\\.') + '[^>]*>')) || [])[0];
  if (!tag) { console.log(`  --   ${a.arq}: sem <img> direto no HTML (vem por CSS), nada a conferir`); continue; }
  const d = medirWebp(R + 'public/assets/' + a.arq);
  const w = Number((tag.match(/width="(\d+)"/) || [])[1]);
  const h = Number((tag.match(/height="(\d+)"/) || [])[1]);
  if (!w) { console.log(`  --   ${a.arq}: <img> sem width declarado`); continue; }
  ok(w === d.w, `${a.arq}: width="${w}" bate com o arquivo (${d.w})`);
  // A proporção pode arredondar 1px; o que não pode é estar trocada.
  if (h) ok(Math.abs(h / w - d.h / d.w) < 0.02, `${a.arq}: e a proporção declarada é a do arquivo`);
}

console.log('\n=== 3. E nenhuma delas virou peso morto ===');
// A folga é para ser folga, não desperdício: uma arte com 6x de sobra são
// pixels que ninguém vê e todo mundo baixa — foi o erro oposto, e o que me fez
// cortar demais da primeira vez.
for (const a of ARTES) {
  const d = medirWebp(R + 'public/assets/' + a.arq);
  if (!d) continue;
  const folga = d.w / (a.exibida * 3);
  ok(folga <= 2.5, `${a.arq}: ${folga.toFixed(2)}x de folga — sobra sem exagero`);
}

encerrar(null, falhas);
