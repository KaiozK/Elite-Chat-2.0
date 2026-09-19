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

  console.log('\n=== 4. O balão segue a paleta do painel, não a do WhatsApp ===');
  // O verde-claro do WhatsApp brigava com o resto do Flow Builder. O balão
  // agora é a superfície do painel: claro com texto escuro, e no escuro o
  // mesmo gradiente preto dos widgets da dashboard, com texto branco.
  ok(/\.fb-wa-bolha \{[^}]*background: var\(--card\)/.test(css), 'fundo claro do painel');
  ok(/\.fb-wa-bolha \{[^}]*color: var\(--text\)/.test(css), 'com o texto escuro padrão');
  ok(/\.fb-wa-bolha \{[^}]*border-radius: 10px 10px 10px 3px/.test(css),
     'mantendo o canto vivo embaixo à esquerda, que é a ponta da bolha');
  ok(!/#d9fdd3/.test(css), 'nada do verde-claro do WhatsApp sobrou');
  ok(!/#027eb5/.test(css), 'nem do azul do botão dele');

  console.log('   -- botão de contorno: só o traço é verde --');
  // Preenchido, o botão era a mancha mais forte do canvas e cada nó competia
  // com o fluxo. Contornado, o verde volta a significar uma coisa só: caminho.
  ok(/\.fb-wa-btn \{[^}]*background: transparent/.test(css), 'o botão herda o fundo do balão');
  ok(/\.fb-wa-btn \{[^}]*color: var\(--text\)/.test(css), 'com o texto na cor do tema');
  ok(/\.fb-wa-btn \{[^}]*border-top: 1px solid var\(--brand\)/.test(css),
     'e o traço verde, que também é o que separa um botão do outro');
  ok(/:root\[data-theme="dark"\] \.fb-wa-btn \{ color: #fff; \}/.test(css),
     'no escuro o texto vira branco junto com o balão');
  ok(!/\.fb-wa-btn\[data-branch\]:hover \{ background: var\(--verde-deep\)/.test(css),
     'e o hover não volta a preencher de verde');

  console.log('   -- a bolinha fica no meio da linha lateral do balão --');
  // Ela ficava na borda do CARD, 16px fora do balão: lia como um enfeite do nó
  // e não como a ponta do botão de onde o caminho sai.
  ok(/\.fb-port\.out\.opt \{ right: 9\.5px/.test(css), 'encostada na borda do balão');
  ok(/const FB_BOLHA_DX = 16;/.test(app), 'o mesmo recuo do balão vira constante');
  ok(/fbIsOptBranch\(branch\) \? NODE_W - FB_BOLHA_DX : NODE_W/.test(app),
     'e a linha nasce daí, e não da borda do nó — senão ela descolaria da bolinha');
  // 13px é o tamanho real da bolinha no CSS; com 7,5 de meio ela nascia 1px
  // acima do centro do botão.
  ok(/const FB_PORT_HALF = 6\.5;/.test(app), 'o meio da bolinha bate com o tamanho dela');
  ok(/\.fb-port \{[^}]*height: 13px/.test(css), 'que é 13px — os dois números andam juntos');

  console.log('   -- modo escuro: o gradiente dos widgets da dashboard --');
  ok(/:root\[data-theme="dark"\] \.fb-wa-bolha \{[^}]*background: var\(--card-grad\)/.test(css),
     'o mesmo --card-grad que todo widget do painel usa');
  ok(/:root\[data-theme="dark"\] \.fb-wa-bolha \{[^}]*color: #fff/.test(css),
     'com o texto branco por cima');

  console.log('   -- e a mesa embaixo dos cards vira junto --');
  // O canvas era o único fundo do app escrito em hex e não em token: no escuro
  // o painel inteiro escurecia e a mesa do Flow Builder continuava creme, com
  // os cards pretos boiando num retângulo claro.
  ok(/:root\[data-theme="dark"\] \.fb2-canvas \{[\s\S]{0,240}linear-gradient\(180deg, #0b0e0d, #070908\)/.test(css),
     'o fundo desce para o preto do app (--bg é #070908)');
  ok(/:root\[data-theme="dark"\] \.fb2-canvas \{[\s\S]{0,200}rgba\(255, 255, 255, \.06\) 1\.1px/.test(css),
     'e a malha de pontos vira luz sobre ele, em vez de sombra');

  console.log('   -- o miolo do balão acompanha --');
  // A etiqueta do template e o cartão Pix são véus PRETOS sobre o balão claro.
  // Sobre o gradiente preto viravam um chip invisível com texto sumido.
  ok(/:root\[data-theme="dark"\] \.fb-wa-tpl \{ background: rgba\(255, 255, 255, \.09\)/.test(css),
     'o véu da etiqueta inverte para branco');
  ok(/:root\[data-theme="dark"\] \.fb-wa-pix \{ background: rgba\(255, 255, 255, \.07\)/.test(css),
     'o do cartão Pix também');
  ok(/:root\[data-theme="dark"\] \.fb-wa-pix-tx b \{ color: #fff/.test(css),
     'e o título do Pix, que era quase preto, sobe para branco');

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
  // Fatia até a PRÓXIMA função, e não por contagem de caracteres: um comentário
  // novo dentro de `refreshPreview` empurrava a linha para fora da janela de
  // 700 e o teste passava a falhar por causa do próprio comentário.
  const rp = app.slice(app.indexOf('function refreshPreview('), app.indexOf('function fbSetNode('));
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
