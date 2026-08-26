// ============================================================================
// HUB DE INTEGRAÇÕES — a aba abre por logos, não por uma pilha de cartões
//
// A aba de Integrações do Admin era uma pilha vertical de cartões de
// configuração. Achar a Nuvemshop no meio dela era rolar até reconhecer o
// título escrito em corpo 14 — e marca não se lê, se reconhece pelo desenho.
//
// Este teste é quase todo de LEITURA DE FONTE, e isso é deliberado: o que ele
// protege são duas armadilhas que já morderam durante a construção e que um
// teste de comportamento não pegaria sem subir um navegador inteiro.
//
//   1. O onerror do logo rodava no escopo GLOBAL da página e lia uma variável
//      LOCAL da função. O logo que faltasse não caía no monograma: estourava
//      ReferenceError e deixava a imagem quebrada na tela. O sintoma aparece
//      só quando um arquivo falta, que é justamente o caso que o fallback
//      existe para cobrir — ou seja, o caminho quebrado era o único caminho
//      que o fallback tinha.
//
//   2. O hub desenhava ANTES de a revenda de números carregar, e lia um estado
//      ainda nulo. O ladrilho abria dizendo "incompleta" numa integração
//      inteira e se corrigia sozinho meio segundo depois — tempo de sobra para
//      alguém ler e sair achando que falta configurar alguma coisa.
//
// E uma terceira, do CSS: as primeiras regras usavam variáveis que não existem
// nesta folha (--chip, --sinal). Variável inexistente não é erro em CSS — a
// propriedade simplesmente não se aplica, e o ponto de status ficava invisível
// sem nada quebrar em lugar nenhum.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
const fs = require('fs');
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const tela = fs.readFileSync(R + 'public/app/app.js', 'utf8');
const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');

(async () => {
  console.log('=== 1. A aba abre por uma grade, e cada painel tem nome ===');
  ok(/id="adm-int-hub"/.test(tela), 'o painel de Integrações tem a caixa do hub');
  for (const k of ['nuvemshop', 'sms', 'numeros']) {
    ok(new RegExp(`data-int="${k}"`).test(tela), `o painel de ${k} é endereçável pelo hub`);
  }
  ok(/function admIntSel\(qual\)/.test(tela), 'e existe quem troque o painel visível');
  const sel = tela.slice(tela.indexOf('function admIntSel'), tela.indexOf('function admIntSel') + 500);
  ok(/display = el\.dataset\.int === qual \? '' : 'none'/.test(sel),
     'mostrando UM e escondendo os outros — sem isso o hub seria só um índice bonito em cima da mesma pilha comprida');
  ok(/aria-pressed/.test(sel) && /aria-pressed/.test(tela.slice(tela.indexOf('function admIntHubPaint'))),
     'o ladrilho é um botão com estado, e não um cartão decorativo');

  console.log('\n=== 2. O logo de quem é, com monograma quando o arquivo falta ===');
  const logo = tela.slice(tela.indexOf('function admIntLogo'), tela.indexOf('function admIntLogo') + 900);
  ok(/\/assets\/logos\/\$\{arq\}\.webp/.test(logo), 'o logo sai da pasta que já existe, a mesma da tela do cliente');
  ok(/onerror=/.test(logo), 'e há um fallback para o arquivo que não existir');

  // A ARMADILHA 1. O atributo roda no escopo da página; qualquer identificador
  // solto ali dentro é ReferenceError. O monograma tem de ir PRONTO.
  const dentroDoOnerror = (logo.match(/onerror="([^"]*)"/) || [])[1] || '';
  ok(dentroDoOnerror.length > 0, 'o onerror foi encontrado para conferir: ' + dentroDoOnerror.slice(0, 60));
  ok(!/\biniciais\b/.test(dentroDoOnerror),
     'o onerror NÃO lê `iniciais` — é variável local, e o atributo roda no escopo global');
  ok(/\$\{fallback\}/.test(dentroDoOnerror),
     'o monograma vai interpolado pronto na string, montado antes');
  // E o monograma interpolado não pode carregar aspas que fechem o atributo.
  const monta = logo.slice(logo.indexOf('const fallback'));
  ok(/replace\(\/"\/g, '&quot;'\)/.test(monta), 'as aspas duplas viram entidade, senão fecham o atributo');
  ok(/replace\(\/'\/g, '&#39;'\)/.test(monta), 'e as simples também, que fechariam a string de dentro');

  console.log('\n=== 3. O hub só desenha depois que os três carregaram ===');
  // A ARMADILHA 2.
  const load = tela.slice(tela.indexOf('async function admIntLoad'), tela.indexOf('async function admIntLoad') + 400);
  ok(/await Promise\.all\(\[admNsLoad\(\), admSmsLoad\(\), admNumLoad\(\)\]\)/.test(load),
     'admIntLoad espera os três antes de pintar a grade');
  ok(load.indexOf('admIntHubPaint') > load.indexOf('await Promise.all'),
     'e o hub é pintado DEPOIS da espera, não antes');

  const numLoad = tela.slice(tela.indexOf('async function admNumLoad'), tela.indexOf('async function admNumLoad') + 600);
  ok(/await admNumRevendaLoad\(\)/.test(numLoad),
     'admNumLoad espera a revenda — é dela que sai o preço que decide se a integração está inteira');
  const paint = tela.slice(tela.indexOf('function admNumPaint'), tela.indexOf('function admNumLogTexto'));
  ok(!/admNumRevendaLoad\(\)/.test(paint),
     'e o disparo saiu de admNumPaint, que não é esperado por ninguém');

  console.log('\n=== 4. Status é um ponto, e os três estados existem ===');
  const hub = tela.slice(tela.indexOf('function admIntHubPaint'), tela.indexOf('function admIntSel'));
  ok(/admNs\.available \? 'on'/.test(hub), 'Nuvemshop: ativa só quando está de fato disponível para os clientes');
  ok(/admSms\.configured \? 'on'/.test(hub), 'SMS: ativo só com token');
  ok(/admNumRev && admNumRev\.preco > 0/.test(hub),
     'Números: só está inteiro com provedor E preço — sem preço a revenda não existe');
  ok(/'meio'/.test(hub), 'e existe o estado do meio, para o "ligado mas falta algo"');

  console.log('\n=== 5. Os atalhos são atalhos, e não uma segunda configuração ===');
  // Duplicar a configuração de gateway em duas telas é como as duas versões
  // começam a discordar. Os atalhos LEVAM para a aba certa e mais nada.
  ok(/adm\/gateways/.test(hub) && /adm\/plataforma/.test(hub),
     'o hub aponta para Gateways e Plataforma, que é onde quem procura "onde ligo o Pix" chega primeiro');
  const bloco = hub.slice(hub.indexOf('const atalhos'));
  ok(/<a class="int-tile atalho" href="#\//.test(bloco), 'são links, e não botões que configuram');
  ok(/int-tile\.atalho \{[^}]*dashed/.test(css),
     'e são tracejados: com o mesmo peso visual pareceriam integrações desligadas');

  console.log('\n=== 6. O CSS usa variáveis que EXISTEM nesta folha ===');
  // A terceira armadilha. Variável inexistente não quebra nada em CSS: a
  // propriedade só não se aplica. O ponto de status ficava invisível em
  // silêncio, e nada no console dizia por quê.
  const usadas = [...css.slice(css.indexOf('.int-hub {')).matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]);
  const raiz = css.slice(css.indexOf(':root'), css.indexOf(':root') + 6000);
  const inexistentes = [...new Set(usadas)].filter(v => !new RegExp('\\' + v + '\\s*:').test(css));
  ok(inexistentes.length === 0,
     `toda variável usada no hub está definida${inexistentes.length ? ': faltam ' + inexistentes.join(', ') : ''}`);
  ok(usadas.length >= 5, `e o hub se veste pelo tema, não por cor fixa: ${[...new Set(usadas)].length} variáveis`);
  ok(/\.int-tile:focus-visible/.test(css), 'o ladrilho tem foco visível — é botão, e teclado alcança botão');

  await encerrar(null, falhas);
})();
