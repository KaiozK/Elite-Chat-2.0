// O MAPA DE LEADS: rampa de cor, placa preta no escuro, e o zero fora da escala.
//
// Três decisões que se desfazem calado, e a razão de cada uma.
//
// 1. O VERDE MUSGO. Cada estado era uma opacidade da MESMA tinta verde, e o
//    estado vazio levava 7%. No claro isso dá um cinza-esverdeado quase branco,
//    discreto, que era a intenção. No escuro, 7% de #50ea5f sobre o card #141a18
//    dá #18291d — musgo. E o mapa de uma conta nova está TODO vazio, então o
//    país inteiro nascia dessa cor.
//
// 2. UM MATIZ SÓ obriga o olho a comparar SATURAÇÃO entre estados que não se
//    tocam — a comparação que a vista humana faz pior. Com uma rampa de quatro
//    matizes, dois estados distantes se comparam por COR, que é imediato.
//    A luminância precisa subir do frio ao quente: é o que mantém a escala
//    legível em preto e branco e para quem não distingue verde de vermelho.
//
// 3. ZERO NÃO É POUCO. O estado sem lead nenhum fica FORA da rampa, num cinza
//    neutro. Pintá-lo com a ponta fria diria "poucos leads", que é outra coisa.
const fs = require('fs');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');

// Os dois blocos de variáveis do mapa. A âncora do escuro é --geo-placa-1, que
// só existe lá; a do claro é o comentário que abre a seção.
const escuro = css.slice(css.indexOf('--geo-placa-1: #151a1b'), css.indexOf('/* O viewBox'));
const claro = css.slice(css.indexOf('/* MAPA DE CALOR.'), css.indexOf(':root[data-theme="dark"] {', css.indexOf('/* MAPA DE CALOR.')));

// ---------------------------------------------------------------------------
console.log('=== 1. A rampa vai do frio ao quente, e a luminância acompanha ===');
const rampa = js.slice(js.indexOf('const GEO_RAMPA = ['), js.indexOf('function geoCorDoCalor'));
const cores = [...rampa.matchAll(/\[0x([0-9A-Fa-f]{2}), 0x([0-9A-Fa-f]{2}), 0x([0-9A-Fa-f]{2})\]/g)]
  .map(m => m.slice(1).map(h => parseInt(h, 16)));
ok(cores.length === 4, `quatro paradas na rampa: ${cores.length}`);

const lum = (c) => {
  const a = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
};
let sobe = true;
for (let i = 1; i < cores.length; i++) if (lum(cores[i]) <= lum(cores[i - 1])) sobe = false;
ok(sobe, `a luminância SOBE em toda a rampa: ${cores.map(c => lum(c).toFixed(2)).join(' < ')}`);

// Matizes de verdade diferentes, senão é a escala antiga com outro nome.
const matiz = (c) => {
  const [r, g, b] = c.map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};
const hs = cores.map(matiz);
ok(Math.abs(hs[0] - hs[3]) > 100, `a ponta fria e a quente estão longe no círculo: ${Math.round(hs[0])}° e ${Math.round(hs[3])}°`);
// O verde da marca no MEIO: ele é o centro de gravidade do mapa, não uma ponta.
ok(/0x2E, 0xD3, 0x78/.test(rampa), 'e o verde da marca (#2ED378) é uma das paradas do meio');

console.log('\n=== 2. A cor é escolhida pelo dado, e a legenda usa a mesma função ===');
ok(/fill="\$\{geoCorDoCalor\(frac\)\}"/.test(js), 'o estado com leads é pintado pela rampa');
ok(/fill-opacity="\$\{\(0\.22 \+ frac \* 0\.70\)/.test(js),
   'e a opacidade sobe junto — é ela que faz a mesma rampa servir aos dois temas');
ok(/geoCorDoCalor\(i \/ 10\)/.test(js), 'a legenda é desenhada com a MESMA função, então não sai de sincronia');
ok(/if \(!max\) return ''/.test(js), 'e não aparece num mapa vazio, onde seria escala para nenhum dado');

console.log('\n=== 3. Zero fica fora da escala ===');
ok(/--geo-vazio-cor:\s*#64748b/.test(claro), 'o estado sem lead é um cinza neutro, não a ponta fria da rampa');
ok(/\.geo-tile:not\(\.hot\) use \{[^}]*fill: var\(--geo-vazio-cor\)/.test(css),
   'e é o CSS que o pinta, porque a resposta depende do tema');
ok(/const paint = count/.test(js), 'o JS só manda tinta inline quando HÁ leads');

console.log('\n=== 4. No escuro, a placa é o preto gradiente dos cards ===');
ok(/--geo-vazio:\s*0\s*;/.test(escuro), 'no escuro o vazio some de vez — quem aparece é a placa');
const grad = (css.match(/--card-grad:\s*linear-gradient\(([^;]+)\);/) || [])[1] || '';
for (const cor of ['#151a1b', '#121516', '#0e1112']) {
  ok(grad.includes(cor) && new RegExp('--geo-placa-[123]:\\s*' + cor).test(escuro),
     `${cor} está no gradiente dos cards E na placa do mapa`);
}
ok(/160deg/.test(grad) && /160 \* Math\.PI \/ 180/.test(js), 'e os dois no mesmo ângulo (160deg)');
// A armadilha: no padrão do SVG cada estado ganharia o próprio gradiente e o
// país viraria um mosaico de 27 placas com emenda em toda divisa.
ok(/gradientUnits="userSpaceOnUse"/.test(js), 'o gradiente é UM só, medido no espaço do desenho');
ok(/fill: url\(#geo-placa\)/.test(css), 'e é ele que pinta a base do mapa');

console.log('\n=== 5. A placa precisa parecer ERGUIDA do card ===');
// Placa e card ficam na mesma luminância (1,08:1) — é o mesmo gradiente. Então
// o relevo é a única coisa que separa os dois.
ok(/--geo-wall:\s*#394347/.test(escuro), 'a parede da extrusão tem contraste com a placa (1,87:1)');
ok(/--geo-sep:\s*rgba\(255, 255, 255, \.30\)/.test(escuro),
   'e a divisa é luz fraca: branco puro virava grade acesa sobre a placa preta');

console.log('\n=== 6. O tema claro continua de pé ===');
ok(/--geo-placa-1:\s*var\(--card\)/.test(claro), 'no claro a placa é chapada, na cor do card');
ok(/--geo-sep:\s*#161b1d/.test(claro), 'e a divisa é escura, porque ali o fundo é branco');

encerrar(null, falhas);
