// CARTEIRA: saldo Pix + cartão no mesmo lugar, e o que acontece quando a venda
// é contestada.
//
// Existe porque venda no Pix não entrava na carteira — o dinheiro ficava na
// subconta da Woovi e o cliente não tinha como ver nem sacar. E porque um
// chargeback virava "recusado" no mapeamento dos adquirentes: o valor
// continuava no saldo depois de já ter voltado para o comprador, e quem
// cobriria o rombo seria a plataforma.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');
const brl = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// BANCO DE MENTIRA — igual aos outros testes.
//
// Este arquivo rodava contra o banco de DESENVOLVIMENTO e dava
// `plans.push(plano)` a cada execução: depois de algumas rodadas havia 38
// planos "Starter" duplicados no db.json, todos sem periodDays, e eles
// apareciam na tela de assinatura como planos de verdade. Teste não pode
// escrever no banco de ninguém.
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

const db = require(R + 'src/db');
const ep = require(R + 'src/elitepay');
const cards = require(R + 'src/cardgateways');

// Conta limpa só para este teste, para não sujar a carteira de ninguém.
function contaNova() {
  // Banco de mentira começa vazio: `findAdminAccount` cria a conta com o
  // formato completo (carteira, billing, afiliação) em vez de montar à mão.
  const acc = db.get().accounts[0] || db.findAdminAccount();
  acc.wallet.balance = 0; acc.wallet.pending = 0; acc.wallet.cardAvailable = 0;
  acc.wallet.receivables = []; acc.wallet.transactions = [];
  return acc;
}
// Uma cobrança já paga, do jeito que `finalizePaid` recebe.
function cobranca(acc, { valor, metodo, taxa }) {
  const ch = {
    id: db.genId('epc'), value: valor, platformCut: taxa, method: metodo,
    status: 'paid', contactName: 'Cliente Teste', comment: 'Venda', card: metodo === 'card' ? { kind: 'credit', installments: 1, status: 'paid' } : null
  };
  ep.ensure(acc).charges.unshift(ch);
  return ch;
}

(async () => {
  await db.loadAsync();     // com o motor mysql (falso) a carga é assíncrona
  console.log('=== 1. Venda no Pix cai disponível na hora ===');
  let acc = contaNova();
  let pix = cobranca(acc, { valor: 10000, metodo: 'pix', taxa: 250 });
  ep.creditPixSale(acc, pix, null);
  ok(acc.wallet.balance === 9750, `disponível = líquido da venda: ${brl(acc.wallet.balance)}`);
  ok(acc.wallet.pending === 0, 'e nada fica pendente, Pix não tem prazo');
  ok(acc.wallet.transactions.some(t => t.type === 'pix_sale'), 'o extrato registra a venda no Pix');

  // O webhook da Woovi repete o mesmo evento com frequência.
  ep.creditPixSale(acc, pix, null);
  ok(acc.wallet.balance === 9750, 'creditar duas vezes não dobra o saldo (idempotente)');

  console.log('\n=== 2. A assinatura do Koonfy não é venda do cliente ===');
  const assinatura = cobranca(acc, { valor: 19900, metodo: 'pix', taxa: 0 });
  assinatura.saas = { accountId: 'x', planId: 'y' };
  ep.creditPixSale(acc, assinatura, null);
  ok(acc.wallet.balance === 9750, 'o saldo não mudou: aquele dinheiro é da plataforma');

  console.log('\n=== 3. Cartão entra como PENDENTE, não disponível ===');
  acc = contaNova();
  const cartao = cobranca(acc, { valor: 20000, metodo: 'card', taxa: 500 });
  ep.creditCardSale(acc, cartao, null);
  const temAgenda = acc.wallet.receivables.length > 0;
  ok(temAgenda, `a venda virou ${acc.wallet.receivables.length} recebível(is) com data`);
  ok(acc.wallet.pending === 19500, `pendente = líquido: ${brl(acc.wallet.pending)}`);
  ok(acc.wallet.balance === 0, 'e o disponível continua zero até liberar');

  console.log('\n=== 4. Os dois somam na MESMA carteira ===');
  const pix2 = cobranca(acc, { valor: 5000, metodo: 'pix', taxa: 125 });
  ep.creditPixSale(acc, pix2, null);
  ok(acc.wallet.balance === 4875, `disponível só com o Pix: ${brl(acc.wallet.balance)}`);
  ok(acc.wallet.pending === 19500, `pendente só com o cartão: ${brl(acc.wallet.pending)}`);
  // força a liberação do cartão adiantando a data
  acc.wallet.receivables.forEach(r => { r.availableAt = Date.now() - 1000; });
  ep.releaseFor(acc, null);
  ok(acc.wallet.balance === 24375, `depois de liberar, um saldo só: ${brl(acc.wallet.balance)}`);
  ok(acc.wallet.pending === 0, 'e o pendente zera');
  ok(acc.wallet.cardAvailable === 19500, `o Koonfy lembra quanto veio de cartão: ${brl(acc.wallet.cardAvailable)}`);

  console.log('\n=== 5. Chargeback: o adquirente avisa e o valor SAI da carteira ===');
  ok(cards.DRIVERS.pagarme && true, 'driver do Pagar.me presente');
  const antes = acc.wallet.balance;
  ep.reverterVenda(acc, cartao, 'chargeback', null);
  ok(acc.wallet.balance === antes - 19500, `saiu o líquido contestado: ${brl(acc.wallet.balance)}`);
  ok(acc.wallet.cardAvailable === 0, 'e sai também do contador de origem cartão');
  ok(acc.wallet.transactions.some(t => t.type === 'chargeback'), 'o extrato mostra o chargeback');
  ep.reverterVenda(acc, cartao, 'chargeback', null);
  ok(acc.wallet.balance === antes - 19500, 'reverter duas vezes não cobra dobrado (idempotente)');

  console.log('\n=== 6. Contestação ANTES de liberar cancela o pendente ===');
  acc = contaNova();
  const c2 = cobranca(acc, { valor: 30000, metodo: 'card', taxa: 750 });
  ep.creditCardSale(acc, c2, null);
  ok(acc.wallet.pending === 29250, `pendente antes: ${brl(acc.wallet.pending)}`);
  ep.reverterVenda(acc, c2, 'chargeback', null);
  ok(acc.wallet.pending === 0, 'o pendente foi cancelado');
  ok(acc.wallet.balance === 0, 'e o disponível NÃO foi tocado: o dinheiro nunca chegou lá');

  console.log('\n=== 7. Chargeback sem saldo deixa a conta devedora, e isso aparece ===');
  acc = contaNova();
  const c3 = cobranca(acc, { valor: 10000, metodo: 'card', taxa: 250 });
  ep.creditCardSale(acc, c3, null);
  acc.wallet.receivables.forEach(r => { r.availableAt = Date.now() - 1000; });
  ep.releaseFor(acc, null);
  acc.wallet.balance = 0; acc.wallet.cardAvailable = 0;   // simula ter sacado tudo
  ep.reverterVenda(acc, c3, 'chargeback', null);
  ok(acc.wallet.balance === -9750, `saldo fica negativo e visível: ${brl(acc.wallet.balance)}`);

  console.log('\n=== 8. O adquirente traduz chargeback como chargeback ===');
  // Sem isto o status caía em "recusado" e nada saía da carteira.
  const via = (drv, s) => { const r = require(R + 'src/cardgateways'); return r; };
  const mapPagarme = ['chargedback', 'chargeback'];
  const mapAsaas = ['CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL'];
  const fonte = require('fs').readFileSync(R + 'src/cardgateways.js', 'utf8');
  for (const s of mapPagarme) ok(fonte.includes(`'${s}'`), `Pagar.me reconhece "${s}"`);
  for (const s of mapAsaas) ok(fonte.includes(`'${s}'`), `Asaas reconhece "${s}"`);

  console.log('\n=== 9. Assinatura no Pix SEM Pix Automático é debitada da carteira ===');
  // Este grupo não renovava por NADA: não entra em cartão nem em boleto, e a
  // recorrência da Woovi que renovaria não existe sem `wooviSubId`. A
  // assinatura vencia com o dinheiro parado na carteira.
  const billing = require(R + 'src/saasbilling');
  const limits = require(R + 'src/limits');
  const plano = { id: 'p_teste', name: 'Starter', price: 9700, limits: {} };
  db.get().plans.push(plano);

  acc = contaNova();
  acc.billing = { planId: plano.id, status: 'active', method: 'pix', wooviSubId: '', periodEnd: Date.now() + 3600000, card: {} };
  const custo = limits.chargeTotal(acc, plano);
  acc.wallet.balance = custo;
  await billing.runRenewals(null);
  ok(acc.wallet.balance === 0, `o saldo pagou a assinatura: sobrou ${brl(acc.wallet.balance)}`);
  ok(acc.billing.status === 'active', 'e a conta continua ativa: ' + acc.billing.status);
  ok(acc.wallet.transactions.some(t => /Pix Automático não ativado/.test(t.label || '')),
    'o extrato explica de onde saiu o débito');

  console.log('\n=== 10. Sem saldo, NÃO derruba a conta antes da hora ===');
  acc = contaNova();
  acc.billing = { planId: plano.id, status: 'active', method: 'pix', wooviSubId: '', periodEnd: Date.now() + 3600000, card: {} };
  acc.wallet.balance = 100;   // muito abaixo do plano
  await billing.runRenewals(null);
  ok(acc.billing.status === 'active', 'conta sem saldo segue ativa, não vai para past_due: ' + acc.billing.status);
  ok(acc.wallet.balance === 100, 'e o saldo não foi tocado');

  console.log('\n=== 11. Quem TEM Pix Automático não é debitado duas vezes ===');
  acc = contaNova();
  acc.billing = { planId: plano.id, status: 'active', method: 'pix', wooviSubId: 'sub_woovi_123', periodEnd: Date.now() + 3600000, card: {} };
  acc.wallet.balance = 50000;
  await billing.runRenewals(null);
  ok(acc.wallet.balance === 50000, 'a recorrência da Woovi cobra, a carteira fica quieta');
  await encerrar(null, falhas);
})().catch(e => { console.error(e); process.exit(1); });
