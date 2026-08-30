// ============================================================================
// O POP-UP DE "DEU CERTO"
//
// O mesmo visto e o mesmo som da confirmação de pagamento, agora nas ações do
// painel que também não voltam atrás. Disparar uma campanha manda mensagem
// para milhares de pessoas: um toast que some pelo canto serve para "copiado",
// não para isso.
//
// Este arquivo prende três coisas que já quebraram uma vez cada:
//   · o som preso ao CSS, e não a um número copiado dele;
//   · o arquivo no pré-carregamento, senão ele chega depois do evento;
//   · a troca de tela DEPOIS do pop-up, e não por baixo dele.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
const fs = require('fs');
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const app = fs.readFileSync(R + 'public/app/app.js', 'utf8');
const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
const notif = fs.readFileSync(R + 'public/app/notifications.js', 'utf8');
const sw = fs.readFileSync(R + 'public/app/sw.js', 'utf8');

(async () => {
  console.log('=== 1. O pop-up existe, e é o mesmo desenho do checkout ===');
  ok(/function popupFeito\(/.test(app), 'existe o pop-up de confirmação');
  const assinar = fs.readFileSync(R + 'public/assinar.html', 'utf8');
  const traco = 'M30 49.5 L43 62 L67 36';
  ok(app.includes(traco) && assinar.includes(traco),
     'com o MESMO traço do visto do checkout — é a mesma marca de "deu certo"');
  ok(/\.feito \.risco/.test(css) && /\.feito \.visto/.test(css), 'e o mesmo desenho no CSS do app');
  ok(/stroke-dasharray: 277/.test(css), 'com o anel que se fecha');

  console.log('\n=== 2. O som sai NO TRAÇO, e a hora vem do CSS ===');
  // Som e desenho juntos são um acontecimento só; separados por meio segundo,
  // viram duas interrupções.
  const corpo = app.slice(app.indexOf('function popupFeito'), app.indexOf('function popupFeito') + 1600);
  ok(/parseFloat\(getComputedStyle\(visto\)\.animationDelay\)/.test(corpo),
     'a hora é lida do animation-delay, não copiada dele');
  ok(/ECNotify\.playSound\('confirm'\)/.test(corpo),
     'e passa pela máquina de sons do app, que respeita quem desligou o som');
  ok(/confirm: '\/assets\/sons\/confirmado\.mp3'/.test(notif),
     'com o arquivo registrado: ' + (notif.match(/confirm: '[^']+'/) || [''])[0]);
  ok(fs.existsSync(R + 'public/assets/sons/confirmado.mp3'), 'e o arquivo no lugar');

  console.log('\n=== 3. O som está pronto ANTES do evento ===');
  // Buscar o arquivo na hora faria o som chegar depois da animação.
  ok(/'\/assets\/sons\/confirmado\.mp3'/.test(sw), 'o Service Worker pré-carrega o som');
  const versao = (sw.match(/const VERSION = '([^']+)'/) || [])[1];
  ok(versao !== 'koonfy-v12',
     `com a versão do cache trocada (${versao}) — sem isso o navegador serviria a lista antiga`);

  console.log('\n=== 4. Fecha sozinho, e não derruba o que não é dele ===');
  ok(/if \(\$\('\.feito'\)\) closeModal\(\);/.test(corpo),
     'só fecha se o pop-up ainda for dele — a pessoa pode ter aberto outra coisa');
  ok(/atraso \? 1900 : 700/.test(corpo),
     'e a espera encurta quando não há animação, em vez de segurar por nada');

  console.log('\n=== 5. Campanha disparada ===');
  const camp = app.slice(app.indexOf('async function createCampaign'), app.indexOf('async function createCampaign') + 1600);
  ok(/popupFeito\('Campanha disparada'/.test(camp), 'o disparo abre o pop-up');
  ok(!/toast\(`Campanha iniciada/.test(camp), 'no lugar do toast, que sumia pelo canto');
  // A LISTA SÓ ABRE DEPOIS. Trocar de tela por baixo faria a confirmação
  // piscar sobre uma página que já mudou.
  ok(/\(\) => \{ location\.hash = '#\/campaigns'; \}\)/.test(camp),
     'e a lista só abre quando ele fecha, não por baixo dele');

  console.log('\n=== 6. Agendamento criado ===');
  const sc = app.slice(app.indexOf('async function scSave'), app.indexOf('async function scSave') + 1400);
  ok(/popupFeito\('Agendamento criado'/.test(sc), 'criar um agendamento abre o pop-up');
  // Editar é ajuste; criar é compromisso novo. Marcar os dois igual tiraria o
  // peso do que importa.
  ok(/if \(id\) toast\('Agendamento salvo'\)/.test(sc),
     'e editar segue com o toast — não é a mesma coisa');

  console.log('\n=== 7. Movimento reduzido não perde a informação ===');
  const bloco = css.slice(css.indexOf('prefers-reduced-motion', css.indexOf('.feito .visto')));
  ok(/\.feito \.risco, \.feito \.visto \{ animation: none; stroke-dashoffset: 0; \}/.test(bloco.slice(0, 300)),
     'o visto aparece pronto em vez de sumir');

  await encerrar(null, falhas);
})();
