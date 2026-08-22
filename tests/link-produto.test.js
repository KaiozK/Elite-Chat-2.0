// O LINK DE CHECKOUT DO PRODUTO.
//
// Até agora só existia link de COBRANÇA: um endereço por cliente, criado depois
// que alguém gera a cobrança. Serve para cobrar uma pessoa; não serve para
// vender. Para vender é preciso um endereço FIXO — o que vai na bio, no
// anúncio, no grupo — e que qualquer um pode abrir.
//
// A DECISÃO QUE ESTE TESTE PROTEGE: a cobrança nasce quando a pessoa se
// identifica, e não quando abre o link.
//
// O caminho óbvio seria criar a cobrança ao abrir o endereço e redirecionar. Aí
// cada visita vira uma cobrança: o robô do WhatsApp que gera a prévia do link, o
// do Google, quem abriu só para ver o preço, quem abriu duas vezes. Em uma
// semana a lista do lojista seria lixo e a métrica de "abandonadas" — que ele
// usa para decidir o que recuperar — viraria ficção.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
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

// O adquirente é simulado: o que se testa é o caminho do Koonfy até ele.
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('simplifybr.com')) {
    return { ok: true, status: 201, text: async () => JSON.stringify({
      internal_id: 'TXN_LINK', external_id: '', status: 'pending',
      qrcode: '00020126580014BR.GOV.BCB.PIX0136link-de-produto', amount: '197.00'
    }) };
  }
  return fetchReal(u, o);
};

const db = require(R + 'src/db');
const pagamentos = require(R + 'src/pagamentos');
const BASE = 'http://127.0.0.1:3981';

(async () => {
  await db.loadAsync();
  const plat = db.get().platform;
  plat.simplify = { clientId: 'CID', clientSecret: 'SEG', splitUsername: '', splitPercent: 0 };
  plat.baseUrl = 'https://koonfy.com';
  pagamentos.platformCfg().gateway = 'simplify';

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3981);
  await new Promise(r => setTimeout(r, 150));

  const acc = db.newAccount({ name: 'Loja da Bia', email: 'bia@loja.com', pass: 'segredo123' });
  acc.billing.status = 'active';
  acc.billing.periodEnd = Date.now() + 30 * 86400000;
  db.get().accounts.push(acc);
  pagamentos.ensure(acc).subaccount = { status: 'active', pixKey: '82981440676', name: 'Loja da Bia' };
  db.save();

  const login = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'bia@loja.com', pass: 'segredo123' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  console.log('=== 1. O produto nasce com um apelido legível ===');
  // Um endereço que a pessoa consegue ditar no telefone vale mais que um id
  // aleatório: ele vai para o anúncio, para o story, para o grupo.
  const criado = await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Mentoria Élite · Plano Mensal', price: 19700, description: 'Encontro semanal' })
  })).json();
  const prod = criado.product;
  ok(prod.slug === 'mentoria-elite-plano-mensal', `sem acento e sem espaço: ${prod.slug}`);
  ok(/\/c\/mentoria-elite-plano-mensal$/.test(prod.link || ''), `e o link vem pronto: ${prod.link}`);

  console.log('\n=== 2. Abrir o link NÃO cria cobrança ===');
  // É a decisão central: cada visita virando cobrança encheria a lista do
  // lojista de lixo e estragaria a métrica de carrinho abandonado.
  const antes = pagamentos.ensure(acc).charges.length;
  const vitrine = await (await fetch(BASE + '/api/public/produto/' + prod.slug)).json();
  ok(vitrine.needsId === true, 'a página abre pedindo os dados');
  ok(vitrine.value === 19700, `com o preço do produto: ${vitrine.value}`);
  ok(vitrine.comment === 'Mentoria Élite · Plano Mensal', 'e o nome dele');
  ok(!vitrine.brCode, 'sem código Pix, porque não há cobrança');
  ok(pagamentos.ensure(acc).charges.length === antes, `nenhuma cobrança criada: ${pagamentos.ensure(acc).charges.length}`);

  // Duas visitas seguidas também não criam nada — é o caso do robô que gera a
  // prévia do link e da pessoa que abre, fecha e volta.
  await fetch(BASE + '/api/public/produto/' + prod.slug);
  await fetch(BASE + '/api/public/produto/' + prod.slug);
  ok(pagamentos.ensure(acc).charges.length === antes, 'nem três visitas seguidas');

  console.log('\n=== 3. A cobrança nasce quando a pessoa se identifica ===');
  const pago = await (await fetch(BASE + '/api/public/produto/' + prod.slug + '/identify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Roberto Alves', taxID: '11144477735', email: 'roberto@ex.com', phone: '11988887777' })
  })).json();
  ok(pago.ok === true, 'a identificação passa');
  ok(!!pago.view && !!pago.view.id, `e devolve a cobrança criada: ${pago.view && pago.view.id}`);
  ok(pago.view.value === 19700, 'com o valor do produto');
  ok(pagamentos.ensure(acc).charges.length === antes + 1, 'uma cobrança, e só uma');
  const nova = pagamentos.ensure(acc).charges.find(c => c.id === pago.view.id);
  ok(nova && nova.productId === prod.id, 'ligada ao produto, para o relatório saber o que foi vendido');
  ok(nova && nova.origin === 'link', `e marcada como vinda do link: ${nova && nova.origin}`);

  console.log('\n=== 4. O apelido não muda sozinho quando o nome muda ===');
  // O endereço já pode estar num anúncio: trocá-lo por baixo derruba a campanha
  // de quem confiou nele.
  const renomeado = await (await fetch(BASE + '/api/pagamentos/products/' + prod.id, {
    method: 'PUT', headers: aut, body: JSON.stringify({ name: 'Mentoria Élite · Plano Anual' })
  })).json();
  ok(renomeado.product.slug === prod.slug, `o link continua o mesmo: ${renomeado.product.slug}`);

  // Mas trocar de propósito funciona.
  const trocado = await (await fetch(BASE + '/api/pagamentos/products/' + prod.id, {
    method: 'PUT', headers: aut, body: JSON.stringify({ slug: 'Plano ANUAL!!' })
  })).json();
  ok(trocado.product.slug === 'plano-anual', `e trocar de propósito limpa o apelido: ${trocado.product.slug}`);

  console.log('\n=== 5. Dois produtos não disputam o mesmo endereço ===');
  const outro = await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut, body: JSON.stringify({ name: 'Plano Anual', price: 99700 })
  })).json();
  ok(outro.product.slug !== 'plano-anual', `o segundo ganha sufixo: ${outro.product.slug}`);

  console.log('\n=== 6. Link desligado e produto sem preço não abrem ===');
  await fetch(BASE + '/api/pagamentos/products/' + outro.product.id, {
    method: 'PUT', headers: aut, body: JSON.stringify({ linkOn: false })
  });
  const desligado = await fetch(BASE + '/api/public/produto/' + outro.product.slug);
  ok(desligado.status === 404, `link desligado não abre: ${desligado.status}`);

  const semPreco = await (await fetch(BASE + '/api/pagamentos/products', {
    method: 'POST', headers: aut, body: JSON.stringify({ name: 'Combinar valor', price: 0 })
  })).json();
  ok(!semPreco.product.link, 'produto sem preço não ganha link — não há o que pagar');
  const abrir = await fetch(BASE + '/api/public/produto/' + semPreco.product.slug);
  ok(abrir.status === 404, `e o endereço dele não abre: ${abrir.status}`);

  const inventado = await fetch(BASE + '/api/public/produto/nao-existe-isso');
  ok(inventado.status === 404, 'apelido inventado dá 404, e não uma tela vazia');

  srv.close();
  global.fetch = fetchReal;
  await encerrar(srv, falhas);
})();
