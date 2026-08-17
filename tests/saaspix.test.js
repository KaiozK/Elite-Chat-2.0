// COBRANÇAS DO PRÓPRIO KOONFY passam pelo adquirente ESCOLHIDO.
//
// Recarga da carteira, conexão extra, link rastreável e a 1ª cobrança da
// assinatura nasciam chamando a Woovi direto, de três lugares diferentes.
// Resultado: escolher a Simplify em Admin → Gateways mudava só as vendas dos
// clientes; o dinheiro que entra para a PLATAFORMA continuava batendo na Woovi
// — e, sem Woovi configurada, simplesmente não dava para pagar.
//
// E o outro lado do mesmo problema: o webhook da Simplify só conhecia venda de
// cliente. O cliente pagava a recarga e o saldo nunca entrava.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

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

// Quem foi chamado: a Simplify ou a Woovi?
let chamadas = [];
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  const corpo = o && o.body ? JSON.parse(o.body) : null;
  if (url.includes('simplifybr.com')) {
    chamadas.push({ quem: 'simplify', url, corpo });
    return { ok: true, status: 201, text: async () => JSON.stringify({ internal_id: 'TXN1', qrcode: '00020126-SIMPLIFY', status: 'pending' }) };
  }
  if (url.includes('openpix') || url.includes('woovi')) {
    chamadas.push({ quem: 'woovi', url, corpo });
    const j = { charge: { brCode: '00020126-WOOVI', identifier: 'W1' } };
    return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), clone() { return this; } };
  }
  return fetchReal(u, o);
};

const db = require(R + 'src/db');
const elitepay = require(R + 'src/elitepay');
const saaspix = require(R + 'src/saaspix');
const saas = require(R + 'src/saasbilling');

(async () => {
  await db.loadAsync();
  const p = db.get().platform;
  p.simplify = { clientId: 'CID', clientSecret: 'SEG', splitUsername: '', splitPercent: 0 };
  p.baseUrl = 'https://koonfy.com';
  p.billing.extras = { whatsappPrice: 5000, linkPrice: 2000 };

  const acc = db.findAdminAccount();
  acc.name = 'Loja do Teste';
  acc.email = 'loja@teste.com';
  acc.profile = { document: '84748914009', phone: '5582981440676' };
  acc.wallet = { balance: 0, pending: 0, cardAvailable: 0, receivables: [], transactions: [] };
  acc.billing = { status: 'active', planId: '', periodEnd: Date.now() + 30 * 86400000, extras: {}, pendingCharge: null };
  db.get().revenue = [];

  console.log('=== 1. Com a SIMPLIFY ativa, a recarga vai para a Simplify ===');
  elitepay.platformCfg().gateway = 'simplify';
  chamadas = [];
  let r = await saaspix.criarCobranca(acc, { correlationID: 'topup-' + acc.id + '-abc', valueCents: 5000, comment: 'recarga' });
  ok(chamadas.length === 1 && chamadas[0].quem === 'simplify', 'quem recebeu a cobrança: ' + (chamadas[0] || {}).quem);
  ok(r.brCode === '00020126-SIMPLIFY', 'e o Pix veio de lá: ' + r.brCode);
  ok(chamadas[0].corpo.payer.document === '84748914009', 'com o CPF/CNPJ da CONTA como pagador');
  ok(chamadas[0].corpo.payer.phone === '82981440676', 'e o telefone sem o DDI: ' + chamadas[0].corpo.payer.phone);

  console.log('\n=== 2. Com a WOOVI ativa, vai para a Woovi ===');
  elitepay.platformCfg().gateway = 'woovi';
  p.woovi.appId = 'APPID';
  chamadas = [];
  r = await saaspix.criarCobranca(acc, { correlationID: 'topup-' + acc.id + '-def', valueCents: 5000, comment: 'recarga' });
  ok(chamadas.length === 1 && chamadas[0].quem === 'woovi', 'quem recebeu: ' + (chamadas[0] || {}).quem);
  ok(r.brCode === '00020126-WOOVI', 'e o Pix veio de lá: ' + r.brCode);

  console.log('\n=== 3. CONEXÃO EXTRA e LINK também seguem o adquirente ===');
  elitepay.platformCfg().gateway = 'simplify';
  for (const [chave, rot] of [['whatsapps', 'conexão'], ['links', 'link rastreável']]) {
    chamadas = [];
    const resp = await saas.buyExtra(acc, chave, 2, { pay: 'pix' }, null);
    ok(chamadas.length === 1 && chamadas[0].quem === 'simplify', `${rot}: foi para a Simplify`);
    ok(resp.charge.brCode === '00020126-SIMPLIFY', `${rot}: com o Pix da Simplify`);
    ok(/^xtr-/.test(resp.charge.correlationID), `${rot}: identificada como cobrança do Koonfy (${resp.charge.correlationID.split('-')[0]}-)`);
  }

  console.log('\n=== 4. O webhook da Simplify CREDITA a recarga ===');
  // Era aqui que o dinheiro sumia: o webhook chegava, não achava venda de
  // cliente nenhuma e ia embora como "não identificada".
  const simplify = require(R + 'src/simplify');
  const cidTopup = 'topup-' + acc.id + '-xyz';
  const antes = acc.wallet.balance;
  const chamar = (corpo) => new Promise(res => {
    simplify.webhookHandler(() => {})({ body: corpo }, { sendStatus: () => {} });
    setTimeout(res, 60);
  });
  await chamar({ event: 'deposit.paid', external_id: cidTopup, status: 'approved', amount: '50.00' });
  ok(acc.wallet.balance === antes + 5000, `o saldo entrou: ${(acc.wallet.balance / 100).toFixed(2)}`);
  ok(acc.wallet.transactions.some(t => t.type === 'topup'), 'e o extrato registra a recarga');

  console.log('\n=== 5. O webhook LIBERA a conexão extra paga ===');
  const cidExtra = `xtr-${acc.id}-whatsapps-3-zzz`;
  await chamar({ event: 'deposit.paid', external_id: cidExtra, status: 'approved', amount: '150.00' });
  ok((acc.billing.extras.whatsapps || 0) === 3, `3 conexões liberadas: ${acc.billing.extras.whatsapps}`);

  console.log('\n=== 6. Pagamento repetido não credita duas vezes ===');
  const saldo = acc.wallet.balance;
  await chamar({ event: 'deposit.paid', external_id: cidTopup, status: 'approved', amount: '50.00' });
  ok(acc.wallet.balance === saldo, `reenvio do webhook não dobra o saldo: ${(acc.wallet.balance / 100).toFixed(2)}`);

  console.log('\n=== 7. Cadastro incompleto avisa o que falta, em vez de falhar feio ===');
  // A Simplify exige os dados do pagador. Aqui o pagador é a própria conta.
  chamadas = [];
  acc.profile.document = '';
  let e = null;
  try { await saaspix.criarCobranca(acc, { correlationID: 'topup-x', valueCents: 5000, comment: 'x' }); }
  catch (err) { e = err; }
  ok(!!e, 'recusou');
  ok(e && /CPF\/CNPJ/.test(e.message), `dizendo o que falta: "${e && e.message.slice(0, 62)}…"`);
  ok(e && /Configurações/.test(e.message), 'e onde resolver');
  ok(chamadas.length === 0, 'sem chamar o adquirente com dado faltando');
  acc.profile.document = '84748914009';

  console.log('\n=== 8. Na WOOVI o cadastro incompleto não atrapalha ===');
  // Ela não exige o pagador; travar ali seria inventar uma regra que não existe.
  elitepay.platformCfg().gateway = 'woovi';
  acc.profile.document = '';
  chamadas = [];
  r = await saaspix.criarCobranca(acc, { correlationID: 'topup-' + acc.id + '-w2', valueCents: 5000, comment: 'x' });
  ok(chamadas.length === 1 && chamadas[0].quem === 'woovi', 'cobrança criada normalmente na Woovi');

  elitepay.platformCfg().gateway = 'woovi';
  await encerrar(null, falhas);
})().catch(e => { console.error(e); process.exit(1); });
