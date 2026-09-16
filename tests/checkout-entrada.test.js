// ============================================================================
// A ENTRADA DO CHECKOUT: BANNER, ANIMAÇÃO E A ESCRITA DO PLACEHOLDER
//
// Três coisas que o cliente vê nos primeiros dois segundos, e que por isso são
// as que mais custam quando quebram sem ninguém notar.
//
//   O BANNER agora pertence à página. Ele era um `<img>` solto, colado nas
//   bordas da janela, passando por baixo da estrutura de 1000px e dos cantos
//   arredondados de todo o resto. A PROPORÇÃO FIXA é o que torna o recorte
//   previsível — e é dela que saem os tamanhos sugeridos no Checkout Builder,
//   então os dois lados precisam contar a mesma história. Um número mudando
//   sozinho aqui faz o lojista enviar a arte errada e só descobrir publicando.
//
//   A ESCRITA DO PLACEHOLDER é devagar de propósito. O que se guarda aqui não
//   é o efeito, são as três coisas que o tornam usável: terminar no foco,
//   pular campo já preenchido e cancelar ao repintar.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const pay = fs.readFileSync(R + 'public/pay.html', 'utf8');
  const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');

  console.log('=== 1. O banner mora DENTRO da estrutura ===');
  ok(/<div class="head-bannerwrap"><img class="head-banner"/.test(pay),
     'ele vai dentro de um container, e não solto no cabeçalho');
  const wrapW = /\.wrap \{ max-width: (\d+)px; margin: 0 auto; padding: 0 (\d+)px/.exec(pay);
  const banW = /\.head-bannerwrap \{ max-width: (\d+)px; margin: 0 auto; padding: [\d.]+px (\d+)px/.exec(pay);
  ok(!!wrapW && !!banW, 'as duas caixas são mensuráveis');
  ok(wrapW && banW && wrapW[1] === banW[1],
     `mesma largura máxima do resto da página (${banW && banW[1]}px)`);
  ok(wrapW && banW && wrapW[2] === banW[2],
     `e o mesmo recuo lateral (${banW && banW[2]}px) — é o que alinha o banner com os cartões`);
  ok(/\.head-banner \{[\s\S]{0,180}border-radius: var\(--rc\)/.test(pay),
     'com o mesmo raio dos cartões, e não quina viva');
  ok(!/\.head-banner \{[\s\S]{0,180}max-height/.test(pay),
     'sem `max-height`: quem manda na altura é a proporção');

  console.log('\n=== 2. No celular sobra 10% de cada lado ===');
  const mob = pay.slice(pay.indexOf('@media (max-width: 860px)'));
  ok(/\.head-bannerwrap \{ padding: [\d.]+px 10%/.test(mob),
     'o banner não encosta nas bordas do aparelho');
  ok(/\.head-banner \{ aspect-ratio: 16 \/ 9; \}/.test(mob),
     'e usa 16:9, que é a proporção de tela estreita');

  console.log('\n=== 3. A proporção do CSS é a mesma que o builder sugere ===');
  // É aqui que o lojista erra: ele envia pelo número que leu no painel. Se o
  // painel disser 3:1 e o CSS recortar em 2:1, a arte chega cortada.
  const deskProp = /\.head-banner \{[\s\S]{0,200}aspect-ratio: (\d+) \/ (\d+)/.exec(pay);
  ok(!!deskProp, 'o computador tem proporção declarada', deskProp && `${deskProp[1]}:${deskProp[2]}`);
  const dica = js.slice(js.indexOf("up('banner'"), js.indexOf("up('banner'") + 240);
  ok(deskProp && dica.includes(`${deskProp[1]}:${deskProp[2]}`),
     'e o painel sugere exatamente ela');
  const [dw, dh] = (/(\d{3,4})×(\d{3,4}) px/.exec(dica) || []).slice(1).map(Number);
  ok(dw && dh && Math.abs(dw / dh - Number(deskProp[1]) / Number(deskProp[2])) < 0.02,
     `e o tamanho sugerido fecha na proporção (${dw}×${dh})`);

  const dicaM = js.slice(js.indexOf("up('bannerMobile'"), js.indexOf("up('bannerMobile'") + 240);
  ok(/16:9/.test(dicaM), 'no celular o painel sugere 16:9, como o CSS recorta');
  const [mw, mh] = (/(\d{3,4})×(\d{3,4}) px/.exec(dicaM) || []).slice(1).map(Number);
  ok(mw && mh && Math.abs(mw / mh - 16 / 9) < 0.02,
     `e o tamanho sugerido também fecha (${mw}×${mh})`);
  // O sugerido tem de COBRIR a caixa real, senão sobe borrado.
  ok(dw >= 952, 'o banner de computador cobre os 952px da caixa real', dw + 'px');
  ok(mw >= 344, 'e o de celular cobre os 344px da maior tela comum', mw + 'px');

  console.log('\n=== 4. A prévia do builder mostra a MESMA caixa ===');
  ok(/epk2-bannerwrap\$\{mob \? ' mob' : ''\}/.test(js), 'a prévia sabe em qual dispositivo está');
  ok(/\.epk2-bannerwrap\.mob \{ padding: 0 10%; \}/.test(css), 'com a mesma folga de 10% no celular');
  ok(/\.epk2-headbanner \{[^}]*aspect-ratio: 3 \/ 1/.test(css), 'a mesma proporção de computador');
  ok(/\.epk2-bannerwrap\.mob \.epk2-headbanner \{ aspect-ratio: 16 \/ 9; \}/.test(css), 'e a de celular');
  ok(!/\.epk2-headbanner \{[^}]*max-height/.test(css),
     'sem `max-height` na prévia: ela mostraria um recorte que a página real não faz');

  console.log('\n=== 5. Os blocos entram animados ===');
  ok(/@keyframes entraSobe \{ from \{ opacity: 0; transform: translateY\(\d+px\); \} \}/.test(pay),
     'há a animação de entrada');
  ok(/\.wrap \.card \{ animation: entraSobe [\d.]+s [^;]+ both; \}/.test(pay),
     'e todo cartão entra por ela');
  ok(/both/.test(pay.slice(pay.indexOf('.wrap .card { animation'), pay.indexOf('.wrap .card { animation') + 90)),
     'com `both` — sem ele o bloco pisca no lugar final antes de começar');
  ok(/\.wrap \.card:nth-child\(1\) \{ animation-delay: \.10s; \}/.test(pay),
     'em sequência, de cima para baixo');
  const red = pay.slice(pay.indexOf('@media (prefers-reduced-motion: reduce) {'));
  ok(/\.head-inner, \.head-bannerwrap, \.wrap \.card \{ animation: none; \}/.test(red),
     'quem pediu menos movimento não recebe nenhuma');

  console.log('\n=== 6. O placeholder é escrito letra a letra ===');
  ok(/function escreverPlaceholders\(raiz\)/.test(pay), 'a escrita existe');
  ok(/escreverPlaceholders\(root\);/.test(pay), 'e roda a cada pintura');
  const fn = pay.slice(pay.indexOf('function escreverPlaceholders'), pay.indexOf('// ---------- etapa 1'));
  ok(/var espera = 48 \+/.test(fn), 'devagar: 48ms por letra, e não um piscar');
  ok(/\[ ,\.;:!\?@\]/.test(fn),
     'com pausa maior no espaço e na pontuação — é o que separa escrita de contador');
  ok(/el\.addEventListener\('focus', pronto\)/.test(fn),
     'clicar no campo completa o texto na hora, em vez de deixar meia frase');
  ok(/if \(!texto \|\| el\.value\) return;/.test(fn),
     'campo já preenchido não anima: o placeholder nem está à vista');
  ok(/prefers-reduced-motion/.test(fn), 'e quem pediu menos movimento recebe o texto pronto');

  console.log('\n=== 7. E não deixa temporizador vivo para trás ===');
  // `render()` troca o HTML inteiro. Sem cancelar, os temporizadores da pintura
  // anterior continuam escrevendo em elementos que já saíram da tela.
  ok(/function pararEscrita\(\)/.test(pay), 'há como parar tudo');
  ok(/pararEscrita\(\);\s*\n\s*if \(!raiz\) return;/.test(fn),
     'e a primeira coisa que cada pintura faz é parar a anterior');

  await encerrar(null, falhas);
})();
