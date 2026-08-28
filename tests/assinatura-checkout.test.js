// ============================================================================
// ASSINATURA NO CHECKOUT — Pix Automático para o cliente cobrar os clientes dele
//
// Existem TRÊS recorrências no produto e o dinheiro anda em direções
// diferentes em cada uma. Confundi-las é o erro caro deste arquivo:
//
//   1. O PLANO DA KOONFY        cliente   → plataforma
//   2. A RECARGA AUTOMÁTICA     cliente   → plataforma
//   3. A ASSINATURA DO CHECKOUT comprador → CLIENTE (menos a taxa)
//
// As duas primeiras JÁ EXISTIAM antes deste trabalho, e o teste as visita
// mesmo assim: elas dividem o `createSubscription` com a terceira, e mexer
// nele sem cobrir as três é como se quebra o faturamento da plataforma
// enquanto se constrói o do cliente.
//
// O QUE ESTÁ SENDO PROTEGIDO, do mais caro para o mais barato:
//
// 1. PARA ONDE VAI O DINHEIRO. A assinatura do cliente tem de sair com a
//    subconta dele e o split da plataforma. Sem isso a receita recorrente dos
//    clientes cai na conta da plataforma — e ninguém percebe até alguém pedir
//    para sacar e o número não bater.
//
// 2. O CICLO MENSAL PRECISA VIRAR UMA VENDA DE VERDADE. A cobrança do mês vem
//    com um id que o Koonfy nunca viu, e é casada pela assinatura que a gerou.
//    Se esse casamento falhar, a venda mensal some em silêncio, mês após mês,
//    e o log só diz "unmatched".
//
// 3. O PREFIXO. Uma assinatura de cliente que começasse com `sub-` seria lida
//    como assinatura do PLANO e ativaria plano na conta errada.
//
// 4. O COMPRADOR PRECISA SABER QUE É MENSAL antes de clicar. Quem descobre
//    depois pede o dinheiro de volta, e com razão.
//
// A Woovi é sempre a de mentira aqui: criar assinatura de verdade cria
// obrigação de cobrança no banco de alguém.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
const fs = require('fs');
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const Module = require('module');
const tabela = new Map();
function executar(sql, params) {
  if (/^CREATE TABLE/i.test(sql)) return [[], []];
  if (/^SELECT chunk, data/i.test(sql)) return [[...tabela].map(([chunk, v]) => ({ chunk, data: v })), []];
  if (/^SELECT chunk, LENGTH/i.test(sql)) return [[...tabela].map(([chunk, v]) => ({ chunk, bytes: v.length })), []];
  if (/^INSERT INTO/i.test(sql)) { for (const [c, d] of params[0]) tabela.set(c, d); return [{}, []]; }
  if (/WHERE chunk IN/i.test(sql)) { for (const c of params[0]) tabela.delete(c); return [{}, []]; }
  if (/^DELETE FROM/i.test(sql)) { tabela.clear(); return [{}, []]; }
  return [[], []];
}
const cx = { query: async (s, p) => executar(s, p), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { query: async (s, p) => executar(s, p), getConnection: async () => cx, end: async () => {} };
const origLoad = Module._load;
Module._load = function (p) { if (p === 'mysql2/promise') return { createPool: () => pool }; return origLoad.apply(this, arguments); };
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

// ---- Woovi de mentira: guarda o que recebeu, para o teste conferir ----
const chamadas = [];
const fetchReal = global.fetch;
let proxima = null;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (!/woovi/.test(url)) return fetchReal(u, o);
  const corpo = o.body ? JSON.parse(o.body) : null;
  chamadas.push({ url, metodo: o.method, corpo });
  const r = proxima || { ok: true, status: 200, body: {} };
  proxima = null;
  return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body) };
};
const responder = (body, ok = true, status = 200) => { proxima = { ok, status, body }; };
const ultima = re => [...chamadas].reverse().find(c => re.test(c.url)) || null;

// ---- adquirente de mentira ----
// O driver de cartão é substituído inteiro, e não a rede embaixo dele: o que
// este teste precisa dizer é "o cartão passou" ou "o cartão recusou", e montar
// a resposta HTTP da Pagar.me para isso seria reescrever o driver dentro do
// teste — que é a maneira mais rápida de um teste passar enquanto o código de
// verdade está quebrado.
const cards = require(R + 'src/cardgateways');
let cartaoResponde = { status: 'paid', gatewayId: 'g1', brand: 'visa', last4: '4242', cardToken: 'tok_1' };
let cobrancasNoCartao = [];
cards.DRIVERS.pagarme.charge = async (args) => {
  cobrancasNoCartao.push(args);
  return { ok: cartaoResponde.status === 'paid', ...cartaoResponde };
};
cards.DRIVERS.pagarme.splitFor = () => null;

const db = require(R + 'src/db');
const assinaturas = require(R + 'src/assinaturas');
const pagamentos = require(R + 'src/pagamentos');
const BASE = 'http://127.0.0.1:3983';

(async () => {
  await db.loadAsync();

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3983);
  await new Promise(r => setTimeout(r, 150));

  // Plataforma com a Woovi de pé e o Pix Automático ligado.
  const P = db.get().platform;
  P.woovi.appId = 'APPID-DE-MENTIRA';
  P.woovi.pixAutomatic = true;
  P.pagamentos = P.pagamentos || {};
  P.pagamentos.gateway = 'woovi';
  P.pagamentos.splitPixKey = 'chave-da-plataforma';
  // A TAXA PRECISA EXISTIR para haver split. Com ela em zero (o padrão) a
  // assinatura sai sem split nenhum, e isso está certo — mandar uma linha de
  // split que não cobra nada é pedir para a Woovi recusar a assinatura inteira.
  P.pagamentos.feeInPercent = 5;
  db.save();

  console.log('=== 1. Só existe com a Woovi, configurada e ligada ===');
  ok(assinaturas.disponivel(), 'com tudo em ordem, o Pix Automático está de pé');

  P.pagamentos.gateway = 'simplify'; db.save();
  ok(!assinaturas.disponivel(), 'com a Simplify não existe — ela não tem produto recorrente');
  ok(/Woovi/.test(assinaturas.porQueNao({})), 'e o motivo é dito por extenso: ' + assinaturas.porQueNao({}));
  P.pagamentos.gateway = 'woovi'; db.save();

  // O INTERRUPTOR DO ADMIN vale para as três recorrências. Se valesse só para a
  // do plano, desligar no painel pararia uma e deixaria a outra correndo.
  P.woovi.pixAutomatic = false; db.save();
  ok(!assinaturas.disponivel(), 'desligado no painel, some para os clientes também');
  P.woovi.pixAutomatic = true; db.save();

  console.log('\n=== 2. A conta precisa da subconta pronta ===');
  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Loja Mensal', email: 'm@loja.com', pass: 'segredo123' })
  });
  const acc = db.findAccountByEmail('m@loja.com');
  acc.unlimited = true;
  db.save();
  ok(!assinaturas.contaPode(acc), 'sem conta de recebimento não dá — o dinheiro não teria para onde ir');

  const ep = pagamentos.ensure(acc);
  ep.subaccount = { pixKey: 'chave-da-loja', status: 'active', name: 'Loja Mensal' };
  db.save();
  ok(assinaturas.contaPode(acc), 'com a subconta pronta, pode');

  const login = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'm@loja.com', pass: 'segredo123' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  console.log('\n=== 3. O produto vira assinatura, e só onde a recorrência existe ===');
  const criado = await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Mentoria Mensal', price: 9700, recorrente: true })
  })).json();
  ok(criado.product && criado.product.recorrente === true, 'produto marcado como assinatura');
  const prod = criado.product;

  // SER MENSAL NÃO DEPENDE DO PIX AUTOMÁTICO, e esta asserção já disse o
  // contrário: enquanto o único meio recorrente era o Pix Automático, marcar um
  // produto como mensal sem ele era criar algo que não vendia. Com cartão e
  // boleto no jogo isso deixou de valer — o produto continua mensal e passa a
  // ser cobrado pelos outros dois. Amarrar o TIPO do produto à disponibilidade
  // de UM dos meios faria desligar o Pix Automático no painel converter, em
  // silêncio, toda assinatura da plataforma em venda avulsa.
  P.woovi.pixAutomatic = false; db.save();
  const semRec = await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Outro', price: 5000, recorrente: true })
  })).json();
  ok(semRec.product.recorrente === true,
     'sem Pix Automático a plataforma, o produto CONTINUA mensal — sobra cartão e boleto');
  P.woovi.pixAutomatic = true; db.save();

  console.log('\n=== 4. O checkout anuncia que é mensal ANTES de clicar ===');
  const vista = await (await fetch(BASE + '/api/public/produto/' + encodeURIComponent(prod.slug))).json();
  ok(vista.assinatura && vista.assinatura.on === true, 'a visão pública diz que é assinatura');
  ok(vista.assinatura.disponivel === true, 'e que dá para usar');
  ok(vista.assinatura.valueCents === 9700, `com o valor do ciclo: ${vista.assinatura.valueCents}`);
  ok(vista.assinatura.ciclo === 'mensal', 'e o ciclo por extenso');

  // A página usa esses campos para trocar o botão. "Pagar R$ 97" e "Assinar por
  // R$ 97/mês" são compromissos diferentes.
  const pagina = fs.readFileSync(R + 'public/pay.html', 'utf8');
  ok(/Assinar por.*\/mês/.test(pagina), 'o botão do checkout diz que é por mês');
  ok(/function ehAssinatura/.test(pagina) && /assinatura\.disponivel/.test(pagina),
     'e só considera assinatura quando o servidor disse que dá para usar');
  ok(/A cobrança se repete todo mês/.test(pagina),
     'o aviso de recorrência aparece na tela, e não em letra miúda no rodapé');

  console.log('\n=== 5. A assinatura sai com a SUBCONTA e o SPLIT ===');
  // É o ponto mais caro do arquivo: errar aqui manda a receita recorrente dos
  // clientes para a conta da plataforma, e ninguém percebe até o saque.
  responder({ subscription: { globalID: 'woo-sub-1', paymentLinkUrl: 'https://woovi.test/autorizar/1' } });
  const r1 = await (await fetch(BASE + '/api/public/produto/' + encodeURIComponent(prod.slug) + '/identify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'João Comprador', email: 'joao@ex.com', taxID: '39053344705', phone: '11987654321' })
  })).json();
  ok(r1.assinatura && r1.assinatura.id, 'a assinatura nasceu');
  ok(!r1.view, 'e NÃO veio uma cobrança: não há QR a pagar, há autorização a dar');

  const chamada = ultima(/subscriptions/);
  ok(!!chamada, 'a Woovi foi chamada na rota de assinatura');
  ok(chamada.corpo.subaccount === 'chave-da-loja',
     `com a SUBCONTA da loja: ${chamada.corpo.subaccount}`);
  ok(Array.isArray(chamada.corpo.splits) && chamada.corpo.splits[0].pixKey === 'chave-da-plataforma',
     'e o split da plataforma junto');
  ok(chamada.corpo.value === 9700, 'pelo valor do produto');
  const esperado = pagamentos.computeSplit(9700).platformCut;
  ok(chamada.corpo.splits[0].value === esperado,
     `o split é o mesmo que a cobrança avulsa cobraria: ${chamada.corpo.splits[0].value}`);
  ok(chamada.corpo.dayGenerateCharge >= 1 && chamada.corpo.dayGenerateCharge <= 28,
     `o dia do ciclo cabe no mês mais curto: ${chamada.corpo.dayGenerateCharge}`);

  console.log('\n=== 6. O PREFIXO separa da assinatura do PLANO ===');
  const reg = assinaturas.lista(acc)[0];
  ok(reg.correlationID.startsWith('eps-'),
     `começa com eps-: ${reg.correlationID}`);
  const saaspix = require(R + 'src/saaspix');
  ok(!saaspix.ehCobrancaSaaS(reg.correlationID),
     'e o faturamento do SaaS NÃO o reconhece como coisa dele — senão ativaria plano na conta errada');
  ok(!pagamentos.isPagamentosCharge(reg.correlationID), 'nem o módulo de cobranças avulsas');

  console.log('\n=== 7. O valor vem do PRODUTO, nunca de quem compra ===');
  responder({ subscription: { globalID: 'woo-sub-2' } });
  await assinaturas.criar(acc, {
    productId: prod.id, valueCents: 1, price: 1,      // tentativa de mandar o preço
    pagador: { name: 'Maria', email: 'maria@ex.com' }
  }, null);
  ok(ultima(/subscriptions/).corpo.value === 9700,
     'o valor continua o do produto, e não o que veio no corpo da requisição');

  console.log('\n=== 8. O CICLO MENSAL vira uma venda de verdade ===');
  // A cobrança do mês vem com um id que o Koonfy nunca viu. Se o casamento com
  // a assinatura falhar, a venda some em silêncio.
  const antesCobrancas = pagamentos.ensure(acc).charges.length;
  const cicloA = {
    correlationID: 'woovi-ciclo-abc', value: 9700, status: 'COMPLETED',
    subscription: { correlationID: reg.correlationID }
  };
  ok(assinaturas.ehCicloDeAssinatura(cicloA), 'o ciclo é reconhecido pela assinatura que o gerou');
  const res1 = assinaturas.aoPagarCiclo(cicloA, null);
  ok(res1.ok, 'e é processado');
  const chs = pagamentos.ensure(acc).charges;
  ok(chs.length === antesCobrancas + 1, 'uma cobrança nasceu na conta certa');
  const nova = chs[0];
  ok(nova.status === 'paid', 'já paga');
  ok(nova.origin === 'assinatura',
     'com origem "assinatura" — receita nova e receita que se repete não se leem do mesmo jeito');
  ok(nova.ciclo === 1, 'e o número do ciclo: ' + nova.ciclo);
  ok(nova.productId === prod.id, 'ligada ao produto');
  ok(assinaturas.lista(acc).find(s => s.id === reg.id).ciclos === 1, 'a assinatura contou o ciclo');

  // Passou pelo MESMO finalizePaid: a carteira do cliente foi creditada.
  ok(acc.wallet.balance > 0, `o líquido caiu na carteira do cliente: ${acc.wallet.balance}`);

  console.log('\n=== 9. Webhook repetido não cobra duas vezes ===');
  // A Woovi reenvia quando não recebe 200 a tempo. Um ciclo contado duas vezes
  // credita a carteira duas vezes.
  const saldoAntes = acc.wallet.balance;
  const res2 = assinaturas.aoPagarCiclo(cicloA, null);
  ok(res2.duplicate === true, 'o reenvio é reconhecido como repetido');
  ok(acc.wallet.balance === saldoAntes, `e a carteira não mexeu: ${acc.wallet.balance}`);
  ok(pagamentos.ensure(acc).charges.length === antesCobrancas + 1, 'nem nasceu outra cobrança');

  console.log('\n=== 10. O vínculo é lido nos dois formatos que a Woovi usa ===');
  // Ler só um formato significa perder o ciclo em silêncio quando ela usar o
  // outro — e "em silêncio" aqui é a venda mensal do cliente sumindo.
  ok(assinaturas.correlacaoDaAssinatura({ subscription: { correlationID: 'x' } }) === 'x', 'objeto com correlationID');
  ok(assinaturas.correlacaoDaAssinatura({ subscription: 'y' }) === 'y', 'string solta');
  ok(assinaturas.correlacaoDaAssinatura({ subscriptionCorrelationID: 'z' }) === 'z', 'campo no topo');
  ok(assinaturas.correlacaoDaAssinatura({}) === '', 'e nada quando não há vínculo');

  console.log('\n=== 11. Cancelar é primeiro na Woovi ===');
  // Marcar cancelada aqui com a chamada falhando lá deixa o comprador sendo
  // cobrado por algo que a tela diz que acabou — e a reclamação chega no banco.
  responder({ error: 'indisponivel' }, false, 502);
  let erro502 = null;
  try { await assinaturas.cancelar(acc, reg.id, 'teste', null); }
  catch (e) { erro502 = e; }
  ok(!!erro502, 'a falha na Woovi impede o cancelamento');
  ok(assinaturas.achar(acc, reg.id).status === 'ativa',
     'e a assinatura continua ATIVA aqui — esconder isso seria pior do que o erro');

  responder({ ok: true });
  const canc = await assinaturas.cancelar(acc, reg.id, 'pedido do cliente', null);
  ok(canc.status === 'cancelada', 'com a Woovi respondendo, cancela');

  console.log('\n=== 12. Uma assinatura é de UMA conta só ===');
  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Outra', email: 'o@loja.com', pass: 'segredo123' })
  });
  const outra = db.findAccountByEmail('o@loja.com');
  outra.unlimited = true; db.save();
  const l2 = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'o@loja.com', pass: 'segredo123' })
  })).json();
  const aut2 = { Authorization: 'Bearer ' + l2.token, 'Content-Type': 'application/json' };
  const alheio = await fetch(BASE + '/api/pagamentos/assinaturas/' + encodeURIComponent(reg.id) + '/cancelar',
    { method: 'POST', headers: aut2, body: '{}' });
  ok(alheio.status === 404, `a outra conta não cancela esta assinatura: ${alheio.status}`);

  console.log('\n=== 13. As outras DUAS recorrências continuam de pé ===');
  // Elas já existiam e dividem o `createSubscription` com a nova. Este bloco é
  // o que impede de quebrar o faturamento da plataforma construindo o do
  // cliente — e foi o que me fez ver que eu tinha lido o código errado: achei
  // que o plano no Pix não criava recorrência nenhuma, e cria.
  const apiSrc = fs.readFileSync(R + 'src/api.js', 'utf8');
  const rotaPlano = apiSrc.slice(apiSrc.indexOf("router.post('/billing/subscribe'"), apiSrc.indexOf("router.post('/billing/subscribe'") + 2200);
  ok(/woovi\.createSubscription/.test(rotaPlano), 'o PLANO da Koonfy cria Pix Automático ao assinar');
  // A CONDIÇÃO SAIU DAQUI e virou uma função só, em assinaturas.disponivel()
  // — ver a seção 24. Estas duas asserções liam a condição escrita à mão na
  // rota, e deixaram de valer no momento em que ela foi centralizada:
  // continuar exigindo o texto antigo seria exigir a duplicação de volta.
  ok(rotaPlano.includes("require('./assinaturas').disponivel()"),
     'e a regra do gateway vem da função central, não copiada aqui');

  const topupSrc = fs.readFileSync(R + 'src/topup.js', 'utf8');
  ok(/woovi\.createSubscription/.test(topupSrc), 'a RECARGA AUTOMÁTICA também usa Pix Automático');

  // E a chamada compartilhada continua servindo quem NÃO tem subconta: sem
  // esses dois campos, o dinheiro do plano tem de ir inteiro para a plataforma.
  const woovi = require(R + 'src/woovi');
  responder({ subscription: { globalID: 'woo-plano' } });
  await woovi.createSubscription({ correlationID: 'sub-teste', value: 4990, customer: { name: 'X' }, comment: 'plano' });
  const doPlano = ultima(/subscriptions/);
  ok(doPlano.corpo.subaccount === undefined,
     'sem subconta quando não se passa uma — o dinheiro do plano é da plataforma, inteiro');
  ok(doPlano.corpo.splits === undefined, 'e sem split');

  console.log('\n=== 14. A tela do cliente lista e explica ===');
  const visao = await (await fetch(BASE + '/api/pagamentos/assinaturas', { headers: aut })).json();
  ok(Array.isArray(visao.assinaturas) && visao.assinaturas.length >= 1,
     `o dono vê as assinaturas dele: ${visao.assinaturas.length}`);
  const uma = visao.assinaturas.find(s => s.id === reg.id);
  ok(uma.assinante && uma.assinante.nome === 'João Comprador', 'com quem assinou');
  ok(typeof uma.autorizada === 'boolean',
     'e se já foi autorizada no banco — "criada" e "cobrando" parecem a mesma coisa e não são');
  ok(visao.receitaMensalCents >= 0, 'com a receita recorrente somada');


  console.log('\n=== 15. O produto manda nos MEIOS, e a plataforma tem a última palavra ===');
  // Três camadas precisam concordar. Perguntar só ao produto é como se acaba
  // oferecendo um meio que morre na hora de cobrar, com o comprador já com o
  // cartão na mão.
  const cfgCartao = pagamentos.cardConfig();
  // `enabled` também: sem ele o adquirente existe configurado e continua
  // indisponível para os clientes, que é o desenho — ligar é ato do admin.
  cfgCartao.enabled = true;
  cfgCartao.provider = 'pagarme';
  cfgCartao.credit = true;
  cfgCartao.boleto = true;
  cfgCartao.settleMode = 'wallet';       // sem exigir recebedor por conta
  cfgCartao.pagarme = { secretKey: 'sk_de_mentira' };
  db.save();

  const prodM = (await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Clube', price: 5000, recorrente: true,
      metodos: { pix: true, credito: true, boleto: false } })
  })).json()).product;
  ok(prodM.metodos && prodM.metodos.boleto === false, 'o produto guarda os meios escolhidos');

  const m1 = pagamentos.metodosDoProduto(acc, prodM, prodM.checkoutId);
  ok(m1.pix === true, 'Pix Automático liberado');
  ok(m1.credito === true, 'cartão liberado');
  ok(m1.boleto === false, 'e o boleto fica de fora porque o PRODUTO o desligou');
  ok(/desligado neste produto/.test(m1.motivos.boleto), 'com o motivo dito: ' + m1.motivos.boleto);

  // A plataforma desligando o cartão derruba o produto junto, mesmo marcado.
  cfgCartao.credit = false; db.save();
  ok(pagamentos.metodosDoProduto(acc, prodM, prodM.checkoutId).credito === false,
     'plataforma sem cartão: o produto não aceita cartão, por mais que esteja marcado');
  cfgCartao.credit = true; db.save();

  // E `null` continua herdando do checkout, que é como todo produto antigo se
  // comporta — mudar isso por baixo alteraria em silêncio o que cada página aceita.
  const prodHerda = (await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Antigo', price: 3000 })
  })).json()).product;
  ok(prodHerda.metodos === null, 'produto sem escolha nasce herdando');
  const mh = pagamentos.metodosDoProduto(acc, prodHerda, prodHerda.checkoutId);
  ok(mh.pix === true && mh.credito === true, 'e herda pix+cartão do checkout padrão');

  console.log('\n=== 16. O método é revalidado contra o PRODUTO ===');
  // O que chega vem da página, e a página é do comprador. Sem revalidar,
  // qualquer um assina no boleto um produto que só aceita cartão editando a
  // requisição.
  let recusou = null;
  try {
    await assinaturas.criar(acc, {
      productId: prodM.id, metodo: 'boleto',
      pagador: { name: 'Fulano', email: 'f@ex.com', document: '39053344705', phone: '11966665555' }
    }, null);
  } catch (e) { recusou = e; }
  ok(!!recusou, 'assinar no boleto um produto que não aceita boleto é recusado');
  ok(/boleto/.test(recusou.message), 'com a mensagem certa: ' + recusou.message);

  console.log('\n=== 17. Assinatura no CARTÃO: primeiro ciclo é uma cobrança normal ===');
  responder({ subscription: {} });   // não deve ser usada: cartão não fala com a Woovi
  const noCartao = await assinaturas.criar(acc, {
    productId: prodM.id, metodo: 'credito',
    pagador: { name: 'Ana Cartão', email: 'ana@ex.com', document: '39053344705', phone: '11999998888' }
  }, null);
  ok(noCartao.metodo === 'credito', 'a assinatura sabe o meio dela');
  ok(noCartao.status === 'pendente',
     'e nasce PENDENTE — entre "criada" e "cobrando" existe o cartão passar');
  const regC = assinaturas.achar(acc, noCartao.id);
  ok(!!regC.primeiraCobrancaId, 'com uma cobrança de verdade para o primeiro ciclo');
  const ch1 = pagamentos.ensure(acc).charges.find(c => c.id === regC.primeiraCobrancaId);
  ok(ch1 && ch1.subscriptionId === regC.id, 'a cobrança aponta de volta para a assinatura');
  ok(ch1.ciclo === 1, 'e é o ciclo 1');
  ok(!regC.wooviSubId, 'nenhuma recorrência foi criada na Woovi — quem repete aqui somos nós');

  console.log('\n=== 18. Pagar o primeiro ciclo LIGA a assinatura e guarda o token ===');
  // O token é a única coisa do cartão que fica guardada, e é o que faz o mês
  // seguinte existir sem pedir o cartão de novo.
  ch1.card = { brand: 'visa', last4: '4242', token: 'tok_do_adquirente' };
  pagamentos.finalizePaid(acc, ch1, null);
  ok(regC.status === 'ativa', `saiu de pendente: ${regC.status}`);
  ok(regC.ciclos === 1, 'contou o ciclo');
  ok(regC.cartao && regC.cartao.token === 'tok_do_adquirente', 'e guardou o token do cartão');
  ok(regC.cartao.last4 === '4242', 'com os últimos quatro, para a tela mostrar qual cartão é');
  ok(regC.proximoCicloEm > Date.now() + 29 * 864e5,
     'o próximo ciclo foi marcado para daqui a um mês');

  console.log('\n=== 19. A varredura cobra o ciclo vencido no cartão salvo ===');
  regC.proximoCicloEm = Date.now() - 1000;
  db.save();
  const antesCh = pagamentos.ensure(acc).charges.length;
  cartaoResponde = { status: 'paid', gatewayId: 'g2', brand: 'visa', last4: '4242', cardToken: 'tok_do_adquirente' };
  let r19 = await assinaturas.varrer(null);
  ok(r19.cobrados === 1, `cobrou: ${r19.cobrados}`);
  ok(pagamentos.ensure(acc).charges.length === antesCh + 1, 'uma cobrança nova nasceu');
  const ch2 = pagamentos.ensure(acc).charges[0];
  ok(ch2.status === 'paid', 'já paga');
  ok(ch2.ciclo === 2, `e é o ciclo 2: ${ch2.ciclo}`);
  ok(ch2.card && ch2.card.recorrente === true, 'marcada como cobrança recorrente');
  ok(regC.ciclos === 2 && regC.falhas === 0, 'a assinatura avançou e zerou falhas');
  ok(regC.proximoCicloEm > Date.now() + 29 * 864e5, 'com o ciclo seguinte marcado');

  console.log('\n=== 20. Cartão recusado NÃO cancela — tenta de novo ===');
  // Cartão recusa por motivo passageiro o tempo todo. Cancelar na primeira
  // negativa perde assinante que teria pago três dias depois.
  regC.proximoCicloEm = Date.now() - 1000;
  db.save();
  cartaoResponde = { status: 'refused', message: 'Saldo insuficiente' };
  let r20 = await assinaturas.varrer(null);
  ok(r20.falhas === 1, `a recusa foi contada como falha: ${r20.falhas}`);
  ok(regC.status === 'inadimplente', `a assinatura fica inadimplente: ${regC.status}`);
  ok(regC.falhas === 1, 'com uma falha');
  ok(/Saldo insuficiente/.test(regC.ultimaFalha), 'e o motivo guardado: ' + regC.ultimaFalha);
  ok(regC.proximoCicloEm > Date.now(), 'a próxima tentativa está marcada, não cancelada');

  // Duas, três… e só então para de tentar.
  for (const n of [2, 3]) {
    regC.proximoCicloEm = Date.now() - 1000; db.save();
    cartaoResponde = { status: 'refused', message: 'Recusado' };
    await assinaturas.varrer(null);
    ok(regC.falhas === n, `${n}ª falha contada`);
  }
  ok(regC.proximoCicloEm === 0,
     'depois das três tentativas para de cobrar — mas continua existindo, para o lojista decidir');
  ok(regC.status === 'inadimplente', 'e fica visível como inadimplente, não apagada');

  console.log('\n=== 21. Sem token não se tenta cobrar todo dia ===');
  const semTok = await assinaturas.criar(acc, {
    productId: prodM.id, metodo: 'credito',
    pagador: { name: 'Sem Token', email: 's@ex.com', document: '39053344705', phone: '11977776666' }
  }, null);
  const regS = assinaturas.achar(acc, semTok.id);
  regS.status = 'ativa';
  regS.proximoCicloEm = Date.now() - 1000;
  regS.cartao = null;
  db.save();
  const r21 = await assinaturas.varrer(null);
  ok(r21.inadimplentes >= 1, 'vira inadimplente');
  ok(regS.proximoCicloEm === 0,
     'e PARA de tentar: sem cartão salvo não é falha do cartão, é assinatura que nunca teve um');

  console.log('\n=== 21b. As TRÊS saídas do link, cada uma com o que a página precisa ===');
  // Aqui escapou um defeito de verdade: `publico()` não devolvia
  // `primeiraCobrancaId`, então a rota nunca via a cobrança do cartão e a
  // página caía na tela de "autorize no seu banco" do Pix Automático —
  // oferecendo um link de autorização que nunca existiu, para quem tinha
  // escolhido cartão. Achado abrindo a tela, não rodando teste.
  const linkProd = (await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Tres Saidas', price: 6000, recorrente: true,
      metodos: { pix: true, credito: true, boleto: true } })
  })).json()).product;

  const identificar = async metodo => (await (await fetch(
    BASE + '/api/public/produto/' + encodeURIComponent(linkProd.slug) + '/identify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Comprador', email: 'c@ex.com', taxID: '39053344705', phone: '11988887777', metodo })
    })).json());

  responder({ subscription: { globalID: 'w9', paymentLinkUrl: 'https://woovi.test/aut/9' } });
  const saiPix = await identificar('pix');
  ok(!!saiPix.assinatura && !saiPix.view,
     'PIX AUTOMÁTICO devolve só a assinatura: não há nada a pagar, há uma autorização a dar');
  ok(!!saiPix.assinatura.autorizacaoUrl, 'com o link do banco');

  const saiCartao = await identificar('credito');
  ok(!!saiCartao.assinatura && !!saiCartao.view,
     'CARTÃO devolve assinatura E cobrança — o primeiro ciclo se paga como qualquer venda');
  ok(saiCartao.view.id === saiCartao.assinatura.primeiraCobrancaId,
     'e as duas apontam para a MESMA cobrança');
  ok(saiCartao.assinatura.metodo === 'credito', 'com o meio escolhido: ' + saiCartao.assinatura.metodo);

  const saiBoleto = await identificar('boleto');
  ok(!!saiBoleto.view, 'BOLETO também devolve cobrança');
  ok(saiBoleto.assinatura.metodo === 'boleto', 'com o meio certo');

  // E A COBRANÇA JÁ NASCE IDENTIFICADA. Sem isso ela vem com `needsId`, e a
  // página — que acabou de mandar nome, documento, e-mail e telefone — volta
  // para o formulário e pede tudo de novo. Quem preenche duas vezes a mesma
  // tela desiste na segunda; foi assim que apareceu, abrindo a tela.
  ok(saiCartao.view.needsId === false,
     'a cobrança do primeiro ciclo já vem com o pagador identificado');
  ok(saiCartao.view.payerName === 'Comprador',
     'com o nome de quem assinou: ' + saiCartao.view.payerName);

  console.log('\n=== 22. O Pix Automático fica FORA da varredura ===');
  // Quem repete lá é a Woovi. Uma segunda cobrança nossa seria cobrança em
  // dobro no cartão de alguém.
  const regPix = assinaturas.lista(acc).find(x => x.metodo === 'pix' && x.status !== 'cancelada');
  if (regPix) {
    regPix.status = 'ativa';
    regPix.proximoCicloEm = Date.now() - 999999;   // vencidíssimo de propósito
    db.save();
    const nAntes = pagamentos.ensure(acc).charges.length;
    await assinaturas.varrer(null);
    ok(pagamentos.ensure(acc).charges.length === nAntes,
       'nenhuma cobrança foi criada para a assinatura de Pix Automático, por mais vencida que estivesse');
  } else {
    ok(true, '(sem assinatura de Pix ativa neste ponto do teste)');
  }

  console.log('\n=== 23. O ciclo aceita UM meio só, e a página abre na aba certa ===');
  // Achado abrindo a tela: a cobrança do primeiro ciclo de uma assinatura de
  // CARTÃO estava oferecendo aba de Pix. Pago no Pix, a assinatura ficaria
  // ativa e SEM cartão salvo — e o mês seguinte falharia com "sem cartão para
  // cobrar", num assinante que tinha pago direitinho.
  const vistaCartao = pagamentos.publicChargeView(saiCartao.assinatura.primeiraCobrancaId);
  ok(vistaCartao.card.pixOff === true, 'a cobrança do ciclo de cartão desliga o Pix');
  ok(vistaCartao.card.credit === true, 'e mantém o cartão');
  ok(vistaCartao.card.boleto === false, 'sem boleto: o meio foi escolhido ao assinar');
  ok(vistaCartao.assinaturaDoCiclo && vistaCartao.assinaturaDoCiclo.metodo === 'credito',
     'a página sabe de qual assinatura é o ciclo, e por qual meio');
  ok(vistaCartao.assinaturaDoCiclo.ciclo === 1, 'e qual ciclo é');

  const vistaBoleto = pagamentos.publicChargeView(saiBoleto.assinatura.primeiraCobrancaId);
  ok(vistaBoleto.card.boleto === true && vistaBoleto.card.credit === false,
     'no boleto é o contrário: boleto sim, cartão não');

  // E uma cobrança AVULSA continua aceitando tudo o que a plataforma oferece —
  // a trava vale para ciclo de assinatura, e não para o checkout inteiro.
  const avulsa = await pagamentos.createCharge(acc, {
    valueCents: 5000, comment: 'Avulsa', origin: 'manual'
  }, null);
  const vistaAvulsa = pagamentos.publicChargeView(avulsa.id);
  ok(!vistaAvulsa.card.pixOff, 'venda avulsa continua com Pix');
  ok(vistaAvulsa.assinaturaDoCiclo === null, 'e não é ciclo de assinatura nenhuma');

  // A página lê exatamente esses campos.
  const pagina2 = fs.readFileSync(R + 'public/pay.html', 'utf8');
  ok(/if \(c\.pixOff\) pix = false;/.test(pagina2), 'a página desliga o Pix quando o servidor manda');
  ok(/data\.assinaturaDoCiclo/.test(pagina2), 'e abre já na aba do meio escolhido');
  ok(/Primeira cobrança da sua assinatura/.test(pagina2),
     'dizendo que é o começo de uma assinatura — o valor é o mesmo de uma compra avulsa, o compromisso não');

  console.log('\n=== 24. A regra do gateway vale para as TRÊS recorrências ===');
  // Pix Automático é produto do Banco Central que o gateway precisa oferecer.
  // A Woovi oferece; a Simplify, na integração que temos, não. Com a Simplify
  // ativa existe Pix, e só Pix — avulso, uma cobrança de cada vez.
  //
  // A regra estava escrita em três lugares, e um deles estava errado: `topup`
  // conferia apenas se a Woovi estava CONFIGURADA, sem olhar se ela era o
  // adquirente ATIVO. Com a Simplify selecionada, ligar a recarga automática
  // criava uma recorrência numa Woovi que não processa mais nada, e o cliente
  // ficava com um débito agendado num gateway fora de uso — sem erro nenhum.
  const topup = require(R + 'src/topup');

  // Todas perguntam à MESMA função.
  const srcTopup = fs.readFileSync(R + 'src/topup.js', 'utf8');
  const srcApi = fs.readFileSync(R + 'src/api.js', 'utf8');
  ok(/require\('\.\/assinaturas'\)\.disponivel\(\)/.test(srcTopup),
     'a recarga automática pergunta à regra central');
  const rotaPlano2 = srcApi.slice(srcApi.indexOf("router.post('/billing/subscribe'"), srcApi.indexOf("router.post('/billing/subscribe'") + 2000);
  ok(/require\('\.\/assinaturas'\)\.disponivel\(\)/.test(rotaPlano2),
     'o plano da Koonfy também');
  ok(!/woovi\.pixAutomatic/.test(rotaPlano2),
     'e a condição escrita à mão saiu de lá — regra repetida é regra que um dia diverge');

  // COM A SIMPLIFY, nenhuma das três oferece Pix Automático.
  P.pagamentos.gateway = 'simplify'; db.save();
  ok(assinaturas.disponivel() === false, 'assinatura do checkout: fora');

  const meSimplify = await (await fetch(BASE + '/api/me', { headers: aut })).json();
  ok(meSimplify.pixAutomatico === false,
     'o app do cliente sabe que não há Pix Automático — o editor de produto não oferece a opção');

  let recusouTopup = null;
  try {
    await topup.configurarAuto(acc, { enabled: true, method: 'pix', amount: 5000, threshold: 1000 }, null);
  } catch (e) { recusouTopup = e; }
  ok(!!recusouTopup, 'recarga automática no Pix: recusada');
  ok(/Pix Automático/.test(recusouTopup.message),
     'com o motivo por extenso, e uma saída: ' + recusouTopup.message);

  // E DE VOLTA COM A WOOVI, as três voltam.
  P.pagamentos.gateway = 'woovi'; db.save();
  ok(assinaturas.disponivel() === true, 'com a Woovi ativa, volta');
  const meWoovi = await (await fetch(BASE + '/api/me', { headers: aut })).json();
  ok(meWoovi.pixAutomatico === true, 'e o app do cliente volta a oferecer');

  // O interruptor do admin continua valendo por cima do gateway.
  P.woovi.pixAutomatic = false; db.save();
  ok(assinaturas.disponivel() === false,
     'desligado no painel, some mesmo com a Woovi ativa');
  P.woovi.pixAutomatic = true; db.save();

  srv.close();
  global.fetch = fetchReal;
  await encerrar(srv, falhas);
})();
