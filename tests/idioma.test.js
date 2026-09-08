// ============================================================================
// IDIOMA DO PAINEL — Português (BR), English, Español
//
// A tradução acontece por CORRESPONDÊNCIA EXATA da frase em português: o
// português é a própria chave. O painel tem 19 mil linhas com o texto escrito
// direto no HTML gerado, e trocar tudo por chaves de uma vez seria reescrever o
// arquivo inteiro — com o agravante de que um erro de digitação numa chave não
// aparece como erro, aparece como texto sumido na tela do cliente.
//
// A REGRA QUE NÃO PODE SER QUEBRADA: só traduz o texto que for igual, INTEIRO,
// a uma entrada do dicionário. Nunca um pedaço. Sem isso, o nome de um cliente
// que contivesse uma palavra conhecida seria alterado na tela — o sistema
// adulterando o dado de quem usa.
// ============================================================================
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(R, 'public', 'app', 'i18n.js'), 'utf8');
const html = fs.readFileSync(path.join(R, 'public', 'app', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(R, 'public', 'app', 'style.css'), 'utf8');

(async () => {
  console.log('=== 1. Os três idiomas existem ===');
  for (const [k, nome] of [['pt-BR', 'Português (BR)'], ['en', 'English'], ['es', 'Español']]) {
    ok(src.includes(`'${k}':`) || src.includes(`${k}:`), `${nome} está na lista`);
  }
  ok(/nome: 'Português \(BR\)'/.test(src) && /nome: 'English'/.test(src) && /nome: 'Español'/.test(src),
     'cada um com o nome no próprio idioma — é assim que a pessoa se reconhece na lista');

  console.log('\n=== 2. O seletor fica no topo, não escondido ===');
  // Quem precisa dele com mais urgência é quem abriu o painel e não lê
  // português — inclusive o revisor da Meta durante a aprovação do aplicativo.
  ok(/id="sel-idioma"/.test(html), 'o seletor está no cabeçalho do painel');
  ok(/KoonfyIdioma\.aplicar\(this\.value\)/.test(html), 'e trocar de idioma é um clique');
  ok(/<select/.test(html.slice(html.indexOf('sel-idioma') - 200, html.indexOf('sel-idioma') + 200)),
     'é um select nativo: no celular abre a roda do sistema, que a pessoa já sabe usar');
  ok(/\.lang-sel \{/.test(css), 'com estilo próprio, na mesma pele do botão de tema ao lado');
  ok(/i18n\.js/.test(html), 'e o idioma carrega ANTES do app, para a primeira pintura já sair traduzida');
  ok(html.indexOf('i18n.js') < html.indexOf('app.js?'), 'nessa ordem');

  console.log('\n=== 3. Só traduz a frase INTEIRA ===');
  // É o que separa "traduzir a interface" de "adulterar o dado do cliente".
  ok(/d\[t\.trim\(\)\] === undefined\) return NodeFilter\.FILTER_REJECT/.test(src),
     'um texto que não seja exatamente uma entrada do dicionário é ignorado');
  ok(!/replace\(new RegExp/.test(src) && !/indexOf\(chave\)/.test(src),
     'não há substituição por pedaço de texto em lugar nenhum');

  console.log('\n=== 4. O conteúdo do cliente nunca é tocado ===');
  const pular = src.slice(src.indexOf('const PULAR'), src.indexOf('const DIC'));
  for (const area of ['.chat-msgs', '.msg', '.conv-list', '.contact-list', '.tag', 'textarea']) {
    ok(pular.includes(area), `${area} fica fora da tradução`);
  }
  ok(pular.includes('[data-sem-traducao]'),
     'e qualquer elemento pode se declarar fora, sem mexer nesta lista');

  console.log('\n=== 5. O que não foi traduzido continua legível ===');
  // Um dicionário incompleto não pode produzir tela vazia nem "inbox.title".
  ok(/return d\[t\] !== undefined \? d\[t\] : \(d\[t\.trim\(\)\] !== undefined \? d\[t\.trim\(\)\] : pt\)/.test(src),
     'sem tradução, devolve o português original');

  console.log('\n=== 6. A escolha sobrevive, e o navegador é o palpite inicial ===');
  ok(/localStorage\.setItem\(CHAVE/.test(src), 'a escolha fica guardada');
  ok(/try \{ localStorage/.test(src),
     'e o painel abre mesmo se o armazenamento estiver bloqueado (aba anônima)');
  ok(/navigator\.language/.test(src),
     'sem escolha, segue o idioma do navegador — quem abre em inglês já vê em inglês');
  ok(/document\.documentElement\.setAttribute\('lang', idioma\)/.test(src),
     'e o `lang` do documento acompanha, para leitor de tela e tradutor do navegador');

  console.log('\n=== 7. Tela nova traduz sozinha ===');
  // Pedir para cada tela chamar a tradução é pedir que alguém esqueça.
  ok(/new MutationObserver\(agendar\)/.test(src), 'um observador traduz o que aparece depois');
  ok(/requestAnimationFrame\(\(\) => \{ pendente = false/.test(src),
     'agrupado por quadro, para não rodar uma vez por nó inserido');

  console.log('\n=== 8. O menu inteiro tem tradução ===');
  const menu = ['Conversas', 'Contatos', 'Campanhas', 'Pagamentos', 'Assinatura',
                'Atendentes', 'Configurações', 'Integrações', 'Agendamentos'];
  const en = src.slice(src.indexOf('en: {'), src.indexOf('es: {'));
  const es = src.slice(src.indexOf('es: {'));
  for (const item of menu) {
    ok(en.includes(`'${item}':`) && es.includes(`'${item}':`), `${item} — em inglês e espanhol`);
  }

  await encerrar(null, falhas);
})();
