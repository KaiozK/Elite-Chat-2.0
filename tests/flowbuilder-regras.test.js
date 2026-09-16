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

  console.log('\n=== 2. Quem escolhe o que sai é a pessoa ===');
  // As duas metades são conteúdo dela. Um clique resolve, mas sem decidir
  // sozinho qual metade do trabalho vai embora.
  const rs = js.slice(js.indexOf('function fbResolver'), js.indexOf('function fbErroHtml'));
  ok(/if \(qual === 'link'\)/.test(rs) && /n\.url = ''/.test(rs), 'dá para tirar o link');
  ok(/n\.buttons = \[\]/.test(rs), 'ou tirar os botões');
  ok(/flowDraft\.graph\.edges = flowDraft\.graph\.edges\.filter/.test(rs),
     'e tirar os botões leva junto os caminhos que saíam deles — senão sobra fio solto no canvas');

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

  await encerrar(null, falhas);
})();
