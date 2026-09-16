// ============================================================================
// AS REGRAS DA META COBRADAS NO FLOW BUILDER, E A SAÍDA QUE NASCE DO BOTÃO
//
// `interactive.type` é `button` (respostas rápidas) OU `cta_url` (um botão de
// link). Não existe um terceiro que junte os dois — a Meta recusa a mensagem.
// A tela já dizia isso num parágrafo cinza, e um aviso que não impede nada é um
// aviso que só aparece depois, no disparo, com a mensagem não entregue.
//
// A OUTRA METADE é onde a linha começa. As saídas eram empilhadas na borda
// direita por uma fórmula, com o texto da opção repetido num rótulo: o desenho
// não dizia de qual botão cada fio partia, era preciso contar de cima para
// baixo e torcer para a ordem bater. Agora a bolinha é posta na altura REAL do
// botão, medida depois de pintar — e o botão de link não tem bolinha nenhuma,
// porque dele não há retorno.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');

  console.log('=== 1. O conflito é DETECTADO, e não só avisado ===');
  ok(/function fbConflito\(n\)/.test(js), 'existe quem detecte');
  const cf = js.slice(js.indexOf('function fbConflito'), js.indexOf('function fbResolver'));
  ok(/const temLink = !!String\(n\.url \|\| ''\)\.trim\(\)/.test(cf), 'olha o link');
  ok(/n\.buttons \|\| \[\]\)\.filter\(b => String\(b\.title \|\| ''\)\.trim\(\)\)/.test(cf),
     'e os botões com texto — um botão vazio não é conflito, é campo por preencher');
  ok(/tipo: 'link-com-botoes'/.test(cf), 'e nomeia o caso');
  ok(/acoes: \[/.test(cf), 'oferecendo saída, e não só o diagnóstico');

  console.log('\n=== 2. O conflito se desfaz sozinho, e sempre para o mesmo lado ===');
  // Sai o LINK, ficam os botões. Não é moeda ao ar: os botões continuam o fluxo
  // e carregam os caminhos já desenhados a partir deles; o link encerra a
  // conversa ali. Apagar os botões apagaria junto os ramos e o trabalho de quem
  // desenhou; apagar o link custa uma URL. Entre as duas perdas, esta é a barata.
  const rs = js.slice(js.indexOf('function fbResolver'), js.indexOf('function fbErroHtml'));
  ok(/n\.url = ''; n\.urlText = '';/.test(rs), 'o link é o que sai');
  ok(!/n\.buttons = \[\]/.test(rs), 'os botões nunca são apagados por esta via');
  ok(/function fbAutoResolver\(id\)/.test(js), 'e há quem desfaça sem pedir confirmação');
  const ar = js.slice(js.indexOf('function fbAutoResolver'), js.indexOf('function fbErroHtml'));
  ok(/if \(!fbConflito\(n\)\) return false;/.test(ar), 'só age quando o conflito existe');
  ok(/toast\(/.test(ar), 'e avisa por toast — a correção já aconteceu, não há o que pedir');

  // Os quatro caminhos por onde o conflito pode nascer desfazem na hora.
  for (const fn of ['fbSetNode', 'fbSetBtn', 'addButton', 'fbAddBtn', 'fbBtnTitle']) {
    const corpo = js.slice(js.indexOf('function ' + fn + '('), js.indexOf('function ' + fn + '(') + 700);
    ok(/fbAutoResolver\(id\)/.test(corpo), `${fn} desfaz o conflito no ato`);
  }

  console.log('\n=== 3. A borda acusa; o componente fica como está ===');
  const er = css.slice(css.indexOf('.fb-erro {'), css.indexOf('.fb-erro-msg {'));
  ok(/background: linear-gradient\(45deg, #b42318/.test(er), 'degradê vermelho, e não cor chapada');
  ok(/animation: brilhoPassar/.test(er), 'com a MESMA faixa de luz do botão brilhante verde');
  ok(/background-size: 200% 200%/.test(er), 'e o mesmo truque de fundo que a faz andar');
  ok(/\.fb-erro > \* \{[^}]*background: var\(--card\)/.test(css),
     'o miolo fica opaco por cima: anima a MOLDURA, não o conteúdo');
  ok(/\.fb-n\.tem-erro \{ box-shadow: 0 0 0 2px #b42318/.test(css),
     'e o card no canvas ganha o anel, para achar o erro sem abrir cada nó');
  ok(!/\.fb-erro[^{]*\{[^}]*color: #fff/.test(er),
     'nada de repintar o componente: a cor dele continua a dele');
  ok(/prefers-reduced-motion[\s\S]{0,80}\.fb-erro \{ animation: none/.test(css),
     'quem pediu menos movimento leva a moldura parada, não some com ela');

  console.log('\n=== 4. A bolinha sai do BOTÃO ===');
  ok(/function fbMedirPortas\(el, n\)/.test(js), 'a posição é medida, e não calculada por fórmula');
  const md = js.slice(js.indexOf('function fbMedirPortas'), js.indexOf('function fbMedirPortas') + 700);
  ok(/b\.offsetTop \+ b\.offsetHeight \/ 2 - FB_PORT_HALF/.test(md),
     'no centro exato do botão');
  ok(/FB_PORT_Y\[fbChaveporta\(n\.id, b\.dataset\.branch\)\]/.test(md),
     'guardada para quem desenha o fio usar o mesmo número');
  ok(/const medido = FB_PORT_Y\[fbChaveporta\(n\.id, branch\)\];[\s\S]{0,80}if \(medido != null\) return medido;/.test(js),
     'e `portTop` consulta a medida antes da fórmula');
  ok(/fbMedirPortas\(el, n\);/.test(js) && js.indexOf('world.appendChild(el);') < js.indexOf('fbMedirPortas(el, n);'),
     'medindo DEPOIS de pôr na árvore — `offsetTop` de nó solto é zero');
  ok(!/<em>\$\{esc\(o\.title\.slice\(0, 14\)\)\}<\/em>/.test(js),
     'o rótulo saiu da porta: ele repetia o texto do botão que agora está ao lado');
  ok(!/com-opts/.test(js) && !/\.fb-n\.com-opts/.test(css),
     'e com ele saiu o recuo de 72px que existia só para acomodá-lo');

  console.log('\n=== 5. Link não tem continuidade ===');
  ok(/branch: ''/.test(js), 'o botão de link nasce sem ramo');
  ok(/b\.branch \? '' : ' sem-saida'/.test(js), 'e é marcado como tal no desenho');
  ok(/\.fb-wa-btn\.sem-saida::after \{[\s\S]{0,60}content: 'sem retorno'/.test(css),
     'dizendo por escrito que dele não há retorno — senão a pessoa procuraria a bolinha');
  ok(/\.fb-wa-btn\[data-branch\] \{ padding-right: 16px; cursor: crosshair; \}/.test(css),
     'e só quem TEM ramo ganha o espaço e o cursor de puxar o fio');

  console.log('\n=== 6. O verde dos conectores é o da marca ===');
  // `--verde` (#50ea5f) é um lima de realce; o verde do produto é `--brand`
  // (#2ed378). Com os dois no canvas, a linha sendo arrastada tinha uma cor e a
  // recém-solta tinha outra.
  ok(/\.fb-edge-temp \{ fill: none; stroke: var\(--brand\)/.test(css),
     'a linha que está sendo arrastada usa o verde da marca');
  ok(/\.fb-port\.out\.opt \{ border-color: var\(--brand\); background: var\(--brand\); \}/.test(css),
     'e as bolinhas de saída também');
  ok(/\.fb-edge \{ fill: none; stroke: var\(--verde-esc\)/.test(css),
     'a linha já traçada continua no mesmo verde — que é o mesmo valor');

  console.log('\n=== 6b. O anel de erro APAGA quando o erro acaba ===');
  // Ele é posto em `renderNodes`, que repinta o nó inteiro. Mas apagar a URL à
  // mão passa por `refreshPreview`, que troca só o balão: o botão de link sumia
  // da bolha e a moldura vermelha continuava acesa num nó já correto. Quem
  // repinta o conteúdo tem de repintar o diagnóstico junto, senão divergem.
  const rp = js.slice(js.indexOf('function refreshPreview'), js.indexOf('function fbSetNode'));
  ok(/card\.classList\.toggle\('tem-erro', !!fbConflito\(n\)\)/.test(rp),
     'repintar o balão reavalia o anel');
  ok(rp.indexOf("classList.toggle('tem-erro'") < rp.indexOf('alvo.outerHTML'),
     'e faz isso ANTES de trocar o conteúdo — depois de `outerHTML` a referência ao card ainda vale, mas a ordem deixa claro que uma coisa não depende da outra');

  console.log('\n=== 7. A lixeira cabe dentro do card ===');
  // Os quatro botões somavam mais que a largura e nenhum encolhia: `flex: 1`
  // cresce, mas sem `min-width: 0` o item nunca fica menor que o conteúdo, e a
  // sobra vazava — a lixeira, sendo a última, ficava fora da borda arredondada.
  ok(/\.flow-actions \{ display: flex; flex-wrap: wrap;/.test(css),
     'a linha de botões quebra em vez de estourar');
  ok(/\.flow-actions \.btn \{ flex: 1 1 auto; min-width: 0; overflow: hidden; \}/.test(css),
     'e os botões encolhem até o rótulo cortar');

  console.log('\n=== 8. O botão Desempenho voltou a responder ===');
  // A rota chamava `flows.relatorioCtr` com `flows` fora de escopo: 500 em TODA
  // chamada. O botão existia e nunca mostrou número nenhum.
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  const rota = api.slice(api.indexOf("router.get('/flows/:id/ctr'"), api.indexOf("router.get('/flows/:id/ctr'") + 700);
  ok(/require\('\.\/flows'\)\.relatorioCtr\(f\)/.test(rota), 'o módulo é trazido onde é usado');
  ok(!/res\.json\(\{ nos: flows\.relatorioCtr/.test(api), 'e a referência solta sumiu');

  console.log('\n=== 9. As métricas dizem quantos e quanto por cento ===');
  const perf = js.slice(js.indexOf('async function verCtrFluxo'), js.indexOf('async function editFlow'));
  ok(/passou' : 'contatos passaram'\} por esta etapa/.test(perf),
     'quantos contatos passaram pela etapa');
  ok(/CTR da etapa/.test(perf), 'o CTR');
  ok(/ctr-opt-bar/.test(perf) && /width:\$\{Math\.min\(100, o\.ctr\)\}%/.test(perf),
     'e uma barra por botão — comparar dois números soltos obriga a fazer a conta de cabeça');
  ok(/title="\$\{esc\(o\.titulo\)\}: \$\{pessoa\(o\.cliques\)\} de \$\{fmtN\(enviados\)\} que receberam · \$\{o\.ctr\}%"/.test(perf),
     'com a quantidade exata e a porcentagem ao passar o mouse');
  ok(/Não clicou em nada/.test(perf),
     'e a sobra aparece: sem ela as porcentagens não fecham 100 e a leitura engana');
  ok(/\.ctr-opt-sobra \.ctr-opt-bar i \{ background: var\(--border2\); \}/.test(css),
     'em cinza, porque quem não clicou é informação e não conquista');

  await encerrar(null, falhas);
})();
