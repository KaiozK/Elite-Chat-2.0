// O MAPA DE LEADS NO ESCURO: placa preta, verde só onde há lead.
//
// O defeito que este teste tranca era de ARITMÉTICA DE COR, não de gosto.
//
// Cada estado é uma opacidade da mesma tinta verde sobre a placa. O estado
// VAZIO levava 7%. No claro isso dá um cinza-esverdeado quase branco, discreto,
// que era a intenção. No escuro, 7% de #50ea5f sobre o card #141a18 dá #18291d
// — verde musgo. E como o mapa de uma conta nova está TODO vazio, o país
// inteiro nascia dessa cor: o verde deixava de significar "aqui tem lead" e
// virava a cor do mapa.
//
// A correção tem duas metades, e as duas precisam continuar de pé:
//
//   1. O estado vazio não recebe tinta no escuro (--geo-vazio: 0). Quem aparece
//      é a placa.
//   2. A placa é o MESMO gradiente preto dos cards do modo escuro (--card-grad).
//      Como SVG não aponta para um gradiente do CSS, ele é redesenhado no JS com
//      as mesmas paradas — e é por isso que este teste compara os dois lados.
//
// E uma armadilha técnica: `gradientUnits="userSpaceOnUse"`. Sem isso o padrão
// é objectBoundingBox e CADA estado ganha o próprio gradiente — o país vira um
// mosaico de 27 placas com emenda em toda divisa.
const fs = require('fs');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');

// O bloco :root[data-theme="dark"] que define as variáveis do mapa.
const escuro = css.slice(css.indexOf('--geo-ink: var(--verde);'), css.indexOf('/* O viewBox'));
const claro = css.slice(css.indexOf('--geo-ink: var(--verde-esc)'), css.indexOf('--geo-ink: var(--verde);'));

console.log('=== 1. O estado sem lead não é pintado de verde no escuro ===');
ok(/--geo-vazio:\s*0\s*;/.test(escuro), 'no escuro o vazio tem opacidade 0 — quem aparece é a placa');
ok(/--geo-vazio:\s*\.07\s*;/.test(claro), 'e no claro segue os 7% de sempre, que ali funcionam');
// A tinta do vazio saiu do JS de propósito: lá não há como saber o tema.
ok(/const paint = count/.test(js), 'o JS só manda tinta inline quando HÁ leads');
ok(/\.geo-tile:not\(\.hot\) use \{[^}]*fill-opacity: var\(--geo-vazio\)/.test(css),
   'e o vazio é pintado no CSS, que sabe o tema');

console.log('\n=== 2. A placa é o mesmo preto gradiente dos cards ===');
// As três paradas do --card-grad, que é o gradiente de TODO card no escuro.
const grad = (css.match(/--card-grad:\s*linear-gradient\(([^;]+)\);/) || [])[1] || '';
ok(!!grad, `o --card-grad existe: ${grad.slice(0, 60)}`);
for (const cor of ['#151a1b', '#121516', '#0e1112']) {
  ok(grad.includes(cor), `parada ${cor} está no gradiente dos cards`);
  ok(new RegExp('--geo-placa-[123]:\\s*' + cor).test(escuro), `e a placa do mapa usa a mesma ${cor}`);
}
ok(/160deg/.test(grad), 'o gradiente dos cards é 160deg');
ok(/160 \* Math\.PI \/ 180/.test(js), 'e o mapa desenha o dele no mesmo ângulo');

console.log('\n=== 3. UMA placa, e não 27 ===');
ok(/gradientUnits="userSpaceOnUse"/.test(js),
   'o gradiente é medido no espaço do desenho — sem isso cada estado ganharia o seu, com emenda em toda divisa');
ok(/fill: url\(#geo-placa\)/.test(css), 'e a base do mapa é pintada com ele');

console.log('\n=== 4. O claro não foi mexido ===');
// A queixa era do escuro. O tema claro tinha um mapa que funcionava, e a
// correção não podia cobrar o preço dele.
ok(/--geo-placa-1:\s*var\(--card\)/.test(claro), 'no claro a placa continua chapada, na cor do card');
ok(/--geo-sep:\s*#161b1d/.test(claro), 'a divisa continua escura');

console.log('\n=== 5. A placa precisa parecer ERGUIDA do card ===');
// Placa e card ficaram na mesma luminância (1,08:1) — é o mesmo gradiente. Então
// o que separa os dois é só a parede da extrusão e a divisa. Se alguém apagar
// esses dois, o mapa vira um recorte invisível dentro do card.
ok(/--geo-wall:\s*#394347/.test(escuro), 'a parede da extrusão tem contraste com a placa (1,87:1)');
ok(/--geo-sep:\s*rgba\(255, 255, 255, \.30\)/.test(escuro),
   'e a divisa é luz fraca: branco puro virava grade acesa sobre a placa preta');

encerrar(null, falhas);
