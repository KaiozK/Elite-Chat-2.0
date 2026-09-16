// ============================================================================
// O NÓ MOSTRA A MENSAGEM, E NÃO UMA DESCRIÇÃO DELA
//
// O card do Flow Builder mostrava uma linha de texto: "Olá {{nome}} · 3
// botão(ões)". Ela dizia o que o passo faz e não dizia a única coisa que
// importa na hora de montar um fluxo — COMO A MENSAGEM VAI CHEGAR. Quem monta
// precisa ver o balão, o tamanho do texto, os botões um embaixo do outro: é
// isso que revela que o título ficou comprido demais ou que são botões de mais.
//
// A prévia do Template já desenhava isso. O que faltava era trazer o MESMO
// desenho para cá, em escala de card — e não inventar um segundo jeito de
// mostrar a mesma coisa, que é como uma tela passa a parecer montada por duas
// pessoas que não se falaram.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const app = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');

  console.log('=== 1. Só quem vira mensagem ganha balão ===');
  // Um "Aguardar 30s" ou um "Adicionar tag" não chega ao cliente. Desenhar um
  // balão ali seria mentir sobre o que o passo faz.
  const lista = (app.match(/const FB_COM_BOLHA = \[([^\]]+)\]/) || [])[1] || '';
  for (const t of ['text', 'buttons', 'list', 'media', 'template', 'payment', 'ai']) {
    ok(lista.includes("'" + t + "'"), `${t} desenha o balão`);
  }
  for (const t of ['delay', 'condition', 'addtag', 'http', 'end', 'trigger']) {
    ok(!lista.includes("'" + t + "'"), `${t} NÃO desenha — não vira mensagem`);
  }
  ok(/\$\{fbBolha\(n\) \|\| `<div class="fb-n-prev">/.test(app),
     'e quem não tem balão continua com o resumo em texto, em vez de ficar vazio');

  console.log('\n=== 2. Os botões seguem a regra da META, não a nossa ===');
  // Acima de três respostas rápidas a Meta entrega como LISTA, que abre numa
  // folha. Desenhar cinco botões aqui prometeria uma tela que o cliente não vai
  // ver — e o fluxo só se revelaria errado depois de publicado.
  const fn = app.slice(app.indexOf('function fbBolha('), app.indexOf('const FB_MIDIA_LBL'));
  ok(/rapidas\.length > 3/.test(fn), 'mais de 3 respostas rápidas viram lista');
  ok(/waBtnIcon\('LIST'\)/.test(fn), 'e a lista usa o ícone de lista');
  ok(/linha\.slice\(0, 3\)/.test(fn), 'até 3, desenha os botões mesmo');
  // O botão de link é de OUTRO tipo: abre o navegador, e o WhatsApp o mostra
  // separado das respostas rápidas.
  ok(fn.indexOf("tipo: 'URL'") < fn.indexOf("fbNodeOptions(n)"),
     'o botão de link vem ANTES das respostas rápidas, como o WhatsApp mostra');

  console.log('\n=== 3. Cada tipo de mídia tem o seu ícone ===');
  // Antes um só, de imagem, servia aos cinco — e "enviar áudio" com desenho de
  // foto é o tipo de detalhe que faz a pessoa conferir duas vezes se escolheu
  // certo.
  for (const k of ['image', 'video', 'audio', 'document', 'sticker']) {
    ok(new RegExp('^\\s+' + k + ": '<", 'm').test(app.slice(app.indexOf('const FB_MIDIA_IC'), app.indexOf('function fbIconeMidia'))),
       `${k} tem desenho próprio`);
  }

  console.log('\n=== 4. O balão é o do WhatsApp, e não o do painel ===');
  // Um balão que seguisse o tema do painel ficaria escuro no modo escuro — e a
  // pergunta que o card responde é "como o CLIENTE vai ver", que não muda com
  // o tema de quem monta.
  ok(/\.fb-wa-bolha \{[^}]*background: #d9fdd3/.test(css), 'o verde do WhatsApp, fixo');
  ok(/\.fb-wa-bolha \{[^}]*border-radius: 8px 8px 8px 2px/.test(css),
     'com o canto vivo embaixo à esquerda, que é a ponta da bolha');
  ok(/\.fb-wa-btn \{[^}]*color: #027eb5/.test(css), 'e o azul do botão do WhatsApp');
  ok(/\.fb-wa-btn \+ \.fb-wa-btn \{ border-top: \.5px/.test(css),
     'separados por hairline, um por linha');

  console.log('\n=== 5. O rótulo de saída não existe mais, e nem o recuo dele ===');
  // Havia um rótulo repetindo o texto da opção na borda direita, e o balão
  // recuava 72px para não passar por baixo dele. Com a bolinha saindo do
  // PRÓPRIO botão, o texto já está ao lado dela: o rótulo virou repetição e o
  // recuo, espaço vazio no nó mais cheio — justamente onde ele faltava.
  ok(!/com-opts/.test(app), 'o card não precisa mais avisar o CSS');
  ok(!/\.fb-n\.com-opts/.test(css), 'e o recuo de 72px saiu junto');
  ok(/b\.offsetTop \+ b\.offsetHeight \/ 2 - FB_PORT_HALF/.test(app),
     'quem diz onde a bolinha fica agora é a posição medida do botão');

  console.log('\n=== 6. Editar um nó repinta o balão inteiro ===');
  // `refreshPreview` trocava só o texto do resumo. Com o balão, trocar texto
  // sem trocar os botões deixaria o card mentindo até o próximo redesenho.
  const rp = app.slice(app.indexOf('function refreshPreview('), app.indexOf('function refreshPreview(') + 700);
  ok(/alvo\.outerHTML = novo/.test(rp), 'o bloco inteiro é substituído, não só o texto');
  ok(/\.fb-wa, \.fb-n-prev/.test(rp), 'achando tanto o balão quanto o resumo');

  console.log('\n=== 7. O SMS não sobrou no menu ===');
  // Ele saiu do produto, mas o item do menu ficou para trás na primeira
  // passada — e um menu que leva a uma tela inexistente é pior que nenhum.
  const html = fs.readFileSync(R + 'public/app/index.html', 'utf8');
  ok(!/data-view="sms"/.test(html), 'nenhum item de menu aponta para o SMS');
  ok(!/>SMS</.test(html), 'e a palavra não aparece na barra lateral');

  await encerrar(null, falhas);
})();
