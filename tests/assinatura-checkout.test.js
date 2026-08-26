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

  // Com a plataforma sem Pix Automático, marcar não pega: seria criar um
  // produto que o checkout recusa na hora da venda.
  P.woovi.pixAutomatic = false; db.save();
  const semRec = await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Outro', price: 5000, recorrente: true })
  })).json();
  ok(semRec.product.recorrente === false,
     'sem Pix Automático na plataforma, a marca não gruda — produto que não vende é pior que campo que não aparece');
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
  ok(/pixAutomatic/.test(rotaPlano), 'respeitando o interruptor do admin');
  ok(/gateway\(\)\.id === 'woovi'/.test(rotaPlano), 'e só com a Woovi ativa');

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

  srv.close();
  global.fetch = fetchReal;
  await encerrar(srv, falhas);
})();
