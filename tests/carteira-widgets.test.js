// ============================================================================
// A CARTEIRA VOLTOU — E O SAQUE VIROU UM POP-UP
//
// O saldo tinha saído do cabeçalho porque ali ele era só consulta disputando o
// lugar mais caro da tela. O que trouxe ele de volta foi a AÇÃO: sacar. Com um
// botão de saque ao lado, a caixa deixa de ser um número exposto e passa a ser
// o caminho mais curto para a coisa que o lojista mais procura depois de
// vender.
//
// São DOIS widgets para UM número, e é por isso que este arquivo existe:
//
//   COMPUTADOR — barra lateral, abaixo da marca, com o fundo do botão
//   brilhante da vitrine e texto branco.
//   CELULAR    — barra de cima, onde a carteira sempre esteve, no estilo
//   discreto dos outros widgets do cabeçalho.
//
// Quem troca um pelo outro é o CSS, em 960px, que é onde a barra lateral
// encolhe para só ícones. Três regras precisam concordar nesse número: o
// `@media` da sidebar, o que esconde a `.sb-wallet` e o que esconde a
// `.tb-wallet`. Se um sair de sincronia, ou aparecem duas carteiras na mesma
// tela, ou some a caixa verde espremida ao lado dos ícones — e nenhum dos dois
// quebra nada, então nenhum dos dois aparece num teste de rota.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const html = fs.readFileSync(R + 'public/app/index.html', 'utf8');
  const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
  const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');

  console.log('=== 1. Os dois widgets existem, cada um no seu lugar ===');
  const iBrand = html.indexOf('class="brand"');
  const iSb = html.indexOf('id="sb-wallet"');
  const iNav = html.indexOf('<nav>');
  ok(iSb > 0, 'a carteira do computador está no HTML');
  ok(iBrand > 0 && iSb > iBrand && iSb < iNav,
     'e fica ENTRE a marca e o menu — abaixo da Koonfy, como pedido');

  const iTb = html.indexOf('id="tb-wallet"');
  const iStatus = html.indexOf('id="tb-status"');
  ok(iTb > 0, 'a carteira do celular voltou para a barra de cima');
  ok(iStatus > 0 && iTb < iStatus, 'no mesmo ponto de antes, antes do chip de status');

  console.log('\n=== 2. Os dois botões abrem o pop-up de saque ===');
  const botaoSb = html.slice(iSb, iSb + 900);
  const botaoTb = html.slice(iTb, iTb + 900);
  ok(/onclick="saqueModal\(\)"/.test(botaoSb), 'o botão do computador chama o pop-up');
  ok(/onclick="saqueModal\(\)"/.test(botaoTb), 'o do celular também');
  // Ícone de carteira, e não um "+": o "+" dizia depositar, e a ação aqui é
  // a contrária.
  ok(/<path d="M21 9\.5h-4a2\.5 2\.5 0 0 0 0 5h4z"\/>/.test(botaoSb) &&
     /<path d="M21 9\.5h-4a2\.5 2\.5 0 0 0 0 5h4z"\/>/.test(botaoTb),
     'os dois usam o desenho de carteira (o bolso do fecho é o que a identifica)');

  console.log('\n=== 3. O visual pedido: fundo do botão brilhante, texto branco ===');
  const bloco = css.slice(css.indexOf('.sb-wallet {'), css.indexOf('.sb-wallet-btn:active'));
  ok(/background:\s*linear-gradient\(45deg[^;]*2ed378/.test(bloco),
     'o mesmo gradiente do botão brilhante da vitrine');
  ok(/animation:\s*brilhoPassar/.test(bloco), 'com a mesma faixa de luz passando');
  ok(/color:\s*#fff/.test(bloco), 'e o texto branco');
  // A animação existe de verdade, e não é um nome solto que nunca casa.
  ok(/@keyframes\s+brilhoPassar/.test(css), 'a animação citada está definida');
  ok(/prefers-reduced-motion[\s\S]{0,120}\.sb-wallet\s*\{\s*animation:\s*none/.test(css),
     'quem pediu menos movimento não leva a faixa de luz junto');

  console.log('\n=== 4. Os TRÊS 960px concordam ===');
  // O número que importa é o da sidebar: é ele que manda, os outros dois só
  // acompanham. Achamos o `@media` que encolhe a barra lateral e conferimos.
  const mSidebar = /@media \(max-width:\s*(\d+)px\)\s*\{\s*\n\s*\.sidebar\s*\{\s*width:\s*64px/.exec(css);
  ok(!!mSidebar, 'achamos o ponto em que a barra lateral vira só ícones',
     mSidebar ? mSidebar[1] + 'px' : 'NÃO ACHOU');
  const P = mSidebar ? Number(mSidebar[1]) : 0;

  const escondeSb = new RegExp('@media \\(max-width:\\s*' + P + 'px\\)\\s*\\{\\s*\\.sb-wallet').test(css);
  ok(escondeSb, `a carteira do computador some no MESMO ponto (${P}px)`);
  // A DO TOPO NÃO SOME MAIS NO COMPUTADOR, e isso mudou de propósito: as duas
  // não fazem a mesma coisa. A da lateral é a vitrine do saldo; a do topo é o
  // atalho que acompanha a pessoa em qualquer página, e é dela que sai o saque.
  // O espaço para isso veio do "Sair", que saiu do topo e virou item do menu do
  // perfil — testado logo abaixo, porque foi a troca que permitiu as duas.
  ok(!/@media \(min-width:[^)]*\)\s*\{\s*\.tb-wallet/.test(css),
     'a carteira do topo vale em toda largura, e não só no celular');

  console.log('\n=== 4b. O "Sair" mora no menu do perfil ===');
  // Ele era um botão solto no topo, de largura fixa, encostado no saldo — e
  // saldo de seis dígitos não cabia junto. Sem esta troca a carteira do topo
  // não teria onde crescer no computador.
  ok(!/<button class="btn small" onclick="logout\(\)">/.test(html),
     'não há mais botão de sair solto no cabeçalho');
  ok(/onclick="closeChannelMenu\(\);logout\(\)"/.test(js),
     'sair é um item do menu que abre no perfil');
  ok(/\.ch-item\.ch-sair b \{ color: var\(--red\)/.test(css),
     'em vermelho, como todo destrutivo do painel');

  console.log('\n=== 4c. No celular, a marca no lugar do nome da tela ===');
  // Com a gaveta fechada a barra lateral some inteira, e com ela a única
  // Koonfy da tela. O nome da página já está aceso na barra de baixo.
  ok(/id="tb-marca"/.test(html), 'a marca está no cabeçalho');
  ok(/\.tb-marca \{[^}]*display: none/.test(css), 'escondida por padrão');
  ok(/koonfy-marca\.webp/.test(css.slice(css.indexOf('.tb-marca'), css.indexOf('.tb-marca') + 400)),
     'e usa a MESMA imagem da marca da lateral — dois desenhos seriam duas marcas');
  // `indexOf` não serve aqui: existem VÁRIOS `@media (max-width: 900px)` no
  // arquivo, e o primeiro deles é de outra coisa. O bloco certo é o que trata
  // da `.topbar`, então é por ele que se procura.
  const iMob = css.indexOf('@media (max-width: 900px)', css.indexOf('RESPONSIVO — TABLET / MOBILE'));
  const mob = css.slice(iMob, css.indexOf('@media', iMob + 10));
  ok(/\.tb-marca \{ display: block; \}/.test(mob), 'no celular ela aparece');
  ok(/\.topbar h2 \{ display: none; \}/.test(mob), 'e o nome da tela sai');

  console.log('\n=== 5. O mesmo saldo pinta nos dois ===');
  ok(/function pintaCarteira\(\)/.test(js), 'existe uma função só que pinta os dois');
  const pinta = js.slice(js.indexOf('function pintaCarteira()'), js.indexOf('function pintaCarteira()') + 700);
  ok(/#sb-wallet-num/.test(pinta) && /#tb-wallet-val/.test(pinta),
     'ela escreve no número do computador E no do celular');
  ok(/state\.agent/.test(pinta), 'e esconde os dois do atendente — a carteira é da empresa');
  const refresh = js.slice(js.indexOf('async function refreshWallet()'), js.indexOf('function pintaCarteira()'));
  ok((refresh.match(/pintaCarteira\(\)/g) || []).length >= 2,
     'o refresh pinta nos dois caminhos — inclusive quando a busca do saldo falha');

  console.log('\n=== 6. O pop-up de saque ===');
  ok(/async function saqueModal\(\)/.test(js), 'o pop-up existe');
  const modal = js.slice(js.indexOf('async function saqueModal()'), js.indexOf('function saqueTudo()'));
  ok(/\/pagamentos\/saldo/.test(modal), 'ele busca o saldo de verdade, e não repete o número do widget');
  ok(/chavePix/.test(modal), 'mostra para onde o dinheiro vai');
  ok(/saqueTudo\(\)/.test(modal), 'e traz o "sacar tudo" — que é o caso que sai automático');
  // `openModal` troca o #modal-root inteiro: se a pessoa fechar enquanto o
  // saldo carrega, escrever no box seria escrever num nó que já saiu da tela.
  ok(/const box = \$\('#sq-modal'\); if \(!box\) return;/.test(modal),
     'e desiste em silêncio se o pop-up for fechado no meio do carregamento');

  console.log('\n=== 7. O DEPÓSITO NÃO FICOU SEM PORTA ===');
  // Quando a carteira saiu do cabeçalho, o "+" que abria o depósito foi junto —
  // e com ele o único caminho para a RECARGA AUTOMÁTICA, que mora dentro desse
  // pop-up. Ficou código vivo e inalcançável, que nenhum teste pegaria.
  ok(/function depositModal\(\)/.test(js), 'o pop-up de depósito existe');
  ok(/onclick="depositModal\(\)"/.test(js), 'e alguma tela o abre');
  ok(/function autoBoxHtml\(/.test(js) && /autoBoxHtml\(auto, min\)/.test(js),
     'a recarga automática continua alcançável por dentro dele');

  console.log('\n=== 8. A tela sabe ANTES do clique se o saque cai na hora ===');
  const quote = api.slice(api.indexOf("router.get('/wallet/withdraw/quote'"), api.indexOf("router.get('/wallet/withdraw/quote'") + 900);
  ok(/automatico:/.test(quote) && /podeSaqueAuto/.test(quote),
     'a prévia responde se aquele valor sai sozinho');
  ok(/motivo:/.test(quote), 'e, quando não sai, por quê');
  ok(/q\.automatico/.test(js), 'o pop-up mostra isso antes de a pessoa confirmar');

  await encerrar(null, falhas);
})();
