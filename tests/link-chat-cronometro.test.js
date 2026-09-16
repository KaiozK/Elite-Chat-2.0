// ============================================================================
// LINK CLICÁVEL NO BALÃO, E A COR DOS WIDGETS DO CHECKOUT
//
// Duas coisas sem parentesco, num arquivo só porque as duas são a mesma
// pergunta: o que o painel FAZ com texto que veio de fora.
//
//   NO CHAT, o texto é da pessoa do outro lado. Transformar link em <a> é
//   montar HTML a partir do que um estranho escreveu, e é aí que mora o
//   perigo: escapar depois de montar destruiria as tags que acabamos de criar;
//   não escapar deixaria qualquer um injetar HTML na tela do atendente
//   mandando uma mensagem. Os casos abaixo existem para que a ordem certa
//   (escapar cada pedaço ANTES de juntar) não se perca numa refatoração.
//
//   NO CRONÔMETRO, a cor é do lojista e vai parar dentro de um atributo
//   `style` do checkout público. Só hexadecimal entra.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
  const pay = fs.readFileSync(R + 'public/pay.html', 'utf8');
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');

  console.log('=== 1. O balão transforma link em link ===');
  ok(/function autoLink\(/.test(js), 'existe a função que faz isso');
  ok(/content \+= \(content \? '<div>' : ''\) \+ autoLink\(m\.text\)/.test(js),
     'e é por ela que o texto da mensagem passa — não mais por `esc` puro');

  // Roda a função de verdade, em vez de conferir se o código "parece" certo.
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const i = js.indexOf('const RE_LINK'), j = js.indexOf('// ---------- dropdown customizado');
  ok(i > 0 && j > i, 'e dá para carregá-la isolada para testar');
  // `eval` do trecho e devolve a função pelo valor da última expressão: um
  // `let autoLink` do lado de fora colidiria com a declaração de dentro.
  const autoLink = eval('(function(){' + js.slice(i, j) + '\nreturn autoLink;})()');

  const saida = autoLink('Segue: https://koonfy.com/pay/a?x=1&y=2 valeu');
  ok(/<a class="msg-link" href="https:\/\/koonfy\.com\/pay\/a\?x=1&amp;y=2"/.test(saida),
     'o endereço vira âncora, com o & escapado no atributo');
  ok(/target="_blank" rel="noopener noreferrer"/.test(saida),
     'abre em outra aba SEM dar acesso à nossa janela (noopener)');

  ok(/href="https:\/\/www\.koonfy\.com"/.test(autoLink('vai em www.koonfy.com')),
     'endereço sem http ganha https — senão o navegador trata como caminho relativo');
  ok(/koonfy\.com<\/a>\./.test(autoLink('entra em koonfy.com... ') .replace(/\s+$/, '')) === false,
     'texto sem www nem http NÃO vira link — seria adivinhar');

  const pont = autoLink('olha https://ex.com/a.');
  ok(/href="https:\/\/ex\.com\/a"/.test(pont) && /<\/a>\./.test(pont),
     'o ponto final fica FORA do link, senão o endereço abre com ele e dá 404');
  const par = autoLink('(veja https://ex.com/b)');
  ok(/href="https:\/\/ex\.com\/b"/.test(par) && /<\/a>\)/.test(par),
     'e o parêntese que fecha a frase também');

  console.log('\n=== 2. E não abre porta para HTML de fora ===');
  const ataque = autoLink('<img src=x onerror=alert(1)> e https://ok.com');
  ok(!/<img/.test(ataque), 'a tag mandada na mensagem sai escapada, e não vira elemento');
  ok(/&lt;img/.test(ataque), 'aparece como texto, que é o que a pessoa escreveu');
  ok(/<a class="msg-link"/.test(ataque), 'e o link legítimo da mesma mensagem continua funcionando');

  ok(!/<a/.test(autoLink('javascript:alert(1)')), 'javascript: não vira link');
  ok(!/<a/.test(autoLink('data:text/html,<script>')), 'data: também não');
  const aspas = autoLink('https://ex.com/"onmouseover="alert(1)');
  ok(/href="https:\/\/ex\.com\/"/.test(aspas) && !/onmouseover="alert/.test(aspas.split('</a>')[0]),
     'aspa encerra o endereço: não dá para sair do atributo e colar um evento');

  console.log('\n=== 3. O link se vê dentro do balão ===');
  ok(/\.msg-link \{[^}]*text-decoration: underline/.test(css),
     'sublinhado, e não só colorido — no balão verde a cor sozinha quase não separa');
  ok(/\.msg-link \{[^}]*word-break: break-word/.test(css),
     'e um endereço longo quebra em vez de esticar o balão');

  console.log('\n=== 4. O relógio do cronômetro ALINHA com o texto ===');
  // Um <svg> solto dentro de texto se apoia na linha de base, não no meio da
  // letra: ele descia e a linha ficava torta. Flex resolve, e é o que se exige.
  const tt = pay.slice(pay.indexOf('.timer-txt {'), pay.indexOf('.timer-txt svg'));
  ok(/display: inline-flex/.test(tt) && /align-items: center/.test(tt),
     'ícone e texto se centram um pelo outro');
  ok(/'<span class="timer-txt">' \+ ico\('clock', 15\) \+ '<span>'/.test(pay),
     'e o texto vai dentro de um <span>, para haver dois itens a centrar');

  console.log('\n=== 5. A contagem diz o que cada número é ===');
  ok(/timer-casa/.test(pay) && /timer-sep/.test(pay),
     'cada casa é um bloco com rótulo, separados por ":"');
  ok(/casa\(m, 'min'\) \+ sep \+ casa\(ss, 'seg'\)/.test(pay),
     'minuto e segundo sempre aparecem');
  ok(/h > 0 \? casa\(h, 'horas'\) \+ sep : ''/.test(pay),
     'e a HORA só entra quando existe — "00" de hora numa oferta de 15min diz o contrário do que o bloco quer');

  console.log('\n=== 5b. FAIXA FIXA NO TOPO, numa linha só ===');
  // O cronômetro era um cartão no meio da página e saía da tela na primeira
  // rolagem — escassez que some não é escassez. Virou faixa presa no topo.
  ok(/\.timer-bar \{[\s\S]{0,120}position: fixed; top: 0; left: 0; right: 0/.test(pay),
     'presa no topo e de ponta a ponta');
  ok(/'<div class="timer-bar" id="offer-box"'/.test(pay), 'e é ela que o relógio pinta');
  ok(/else if \(k === 'timer'\) continue;/.test(pay),
     'saiu da coluna de blocos: faixa presa no topo não tem posição para arrastar');
  ok(/function ajustarTopo\(\)/.test(pay) && /document\.body\.style\.paddingTop = bar \? bar\.offsetHeight/.test(pay),
     'a altura é MEDIDA e devolvida como recuo do corpo — fixa, ela cobriria a marca do lojista');

  // "o texto com o cronômetro deve ser na mesma linha": é o `nowrap` que garante.
  const barra = pay.slice(pay.indexOf('.timer-in {'), pay.indexOf('.timer-in {') + 300);
  ok(/flex-wrap: nowrap/.test(barra),
     'texto e relógio na MESMA linha — com wrap o relógio caía embaixo da frase');
  ok(/align-items: center/.test(barra), 'e centrados um pelo outro');
  ok(/\.timer-txt > span \{ overflow: hidden; text-overflow: ellipsis/.test(pay),
     'quem encolhe numa tela apertada é o texto, não o relógio');
  const relogio = pay.slice(pay.indexOf('.timer-clock {'), pay.indexOf('.timer-clock {') + 200);
  ok(/align-items: center/.test(relogio),
     'o ":" e os rótulos centram pelo número — medido na página: desvio 0');

  console.log('\n=== 6. CADA WIDGET tem cor própria, e só hexadecimal passa ===');
  const rota = api.slice(api.indexOf('const cor = v => typeof v'), api.indexOf("if (b.badges && "));
  ok(/\/\^#\[0-9a-fA-F\]\{6\}\$\/\.test/.test(rota),
     'o servidor só aceita #rrggbb — a cor vai parar num atributo style');
  ok(/: ''/.test(rota), 'qualquer outra coisa vira vazio');
  for (const w of ['timer', 'benefits', 'testimonial', 'guarantee', 'faq', 'notice']) {
    ok(new RegExp('color: cor\\(b\\.' + w + '\\.color\\)').test(rota), `${w} guarda a cor conferida`);
  }

  ok(/function corValida\(c\) \{ return typeof c === 'string' && \/\^#\[0-9a-f\]\{6\}\$\/i\.test\(c\); \}/.test(pay),
     'o checkout confere de novo antes de escrever no style — não confia no que está gravado');
  ok(/function corDo\(w\) \{ return corValida\(w && w\.color\)/.test(pay),
     'e é um helper só que põe `--w` em todos os blocos');
  ok((pay.match(/corDo\(/g) || []).length >= 7, 'usado nos seis widgets');

  console.log('\n=== 6b. SEM COR ESCOLHIDA, NADA MUDA ===');
  // Aqui mora o risco desta mudança: um padrão único (`--w: var(--ac)`) teria
  // deixado o aviso verde e as estrelas verdes da noite para o dia, em todo
  // checkout que já existe. O padrão vive no FALLBACK do `var()`, um por
  // propriedade, e é isso que estes casos guardam.
  ok(!/--w:\s*var\(--ac\)/.test(pay),
     'nenhum bloco recebe uma cor padrão: sem escolha, a variável nem existe');
  ok(/color: var\(--w, #e3c46a\)/.test(pay), 'o aviso continua âmbar por padrão');
  ok(/\.stars \{ color: var\(--w, #e3c46a\)/.test(pay), 'as estrelas continuam douradas');
  for (const alvo of ['.benef li svg', '.faq summary::after']) {
    const i = pay.indexOf(alvo);
    ok(i > 0 && /var\(--w, var\(--ac\)\)/.test(pay.slice(i, i + 200)),
       `${alvo} continua no acento do lojista`);
  }

  console.log('\n=== 7. A prévia do builder mostra o mesmo que o checkout ===');
  ok(/EPK_WID_CORES/.test(js), 'há uma paleta para os widgets');
  ok(/function epkCorWidget\(bloco\)/.test(js) && /function epkWidCor\(bloco, c\)/.test(js),
     'e um seletor só, usado por todos os blocos');
  ok((js.match(/epkCorWidget\('/g) || []).length === 6, 'nas seis seções', (js.match(/epkCorWidget\('/g) || []).length + '');
  ok(/epk-swatch-auto/.test(js) && /\.epk-swatch-auto \{/.test(css),
     'com uma opção para VOLTAR ao padrão — senão não há como desfazer');
  // O nome do padrão difere por bloco; dizer "cor de destaque" no aviso seria
  // mentir sobre o que o botão faz.
  ok(/notice:\s*\{ nome: 'o âmbar de aviso'/.test(js), 'o aviso diz que volta para o âmbar');
  ok(/testimonial: \{ nome: 'o dourado'/.test(js), 'o depoimento, para o dourado');

  const prev = js.slice(js.indexOf('const bTimer = () =>'), js.indexOf('const BLK ='));
  ok(/h > 0 \? casa\(h, 'horas'\)/.test(prev),
     'a prévia converte 75 minutos em 01:15, como o checkout faria');
  ok(/const cw = k =>/.test(js) && (prev.match(/cw\('/g) || []).length >= 5,
     'e cada bloco da prévia recebe a cor escolhida');
  ok(/\.epk2-notice \{[\s\S]{0,200}var\(--w, #8a6412\)/.test(css),
     'a prévia repete o MESMO encadeamento de padrão, inclusive o âmbar do aviso');

  console.log('\n=== 8. A contagem "Expira em…" saiu do painel do Pix ===');
  // Duas contagens regressivas na mesma tela, medindo coisas diferentes, e sem
  // como saber qual é qual. A que vende é a da oferta.
  ok(!/id="cd"/.test(pay) && !/function countdown\(/.test(pay),
     'não há mais contagem de validade dentro do painel do Pix');
  ok(!/\.expiry \{/.test(pay), 'nem o estilo dela sobrando');
  ok(/setInterval\(function \(\) \{ if \(data && data\.status === 'active'/.test(pay),
     'e a expiração continua sendo percebida: a página já recarrega sozinha enquanto a cobrança está aberta');

  await encerrar(null, falhas);
})();
