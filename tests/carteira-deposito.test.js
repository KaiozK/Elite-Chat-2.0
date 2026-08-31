// ============================================================================
// A CARTEIRA: DEPÓSITO, GASTO E SAQUE
//
// É o caminho do dinheiro do cliente dentro do produto, e não tinha teste
// nenhum. Cada bloco aqui é uma pergunta cuja resposta errada custa dinheiro —
// de um lado ou do outro:
//
//   · o webhook repetido credita duas vezes? (a Meta e os gateways REENVIAM)
//   · dá para depositar fora da faixa que o admin definiu?
//   · dá para sacar mais do que se tem?
//   · a taxa de saque é cobrada, e sobre o que?
//   · um atendente consegue mexer no dinheiro do dono?
//
// O DINHEIRO NÃO TEM DESFAZER: creditar a mais é prejuízo, creditar a menos é
// cliente reclamando com razão. Por isso cada valor aqui é conferido em
// centavos, e não "mudou".
// ============================================================================
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
const cx = { query: async (a, b) => executar(a, b), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { query: async (a, b) => executar(a, b), getConnection: async () => cx, end: async () => {} };
const origLoad = Module._load;
Module._load = function (m) { if (m === 'mysql2/promise') return { createPool: () => pool }; return origLoad.apply(this, arguments); };
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

// Gateway de mentira: o Pix nasce sem rede. NUNCA um gateway de verdade num
// teste — cobrança criada de brincadeira é obrigação de pagamento no banco de
// alguém.
const fetchReal = global.fetch;
global.fetch = async (u, o = {}) => {
  if (!/woovi/.test(String(u))) return fetchReal(u, o);
  return { ok: true, status: 200, text: async () => JSON.stringify({
    charge: { brCode: '00020126BR...', qrCodeImage: '', identifier: 'x', status: 'ACTIVE', value: 5000 }
  }) };
};

const db = require(R + 'src/db');
const woovi = require(R + 'src/woovi');
const saaspix = require(R + 'src/saaspix');

const BASE = 'http://127.0.0.1:4001';
const json = r => r.json();

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(4001);
  await new Promise(r => setTimeout(r, 150));

  const P = db.get().platform;
  P.woovi.appId = 'APPID';
  P.billing.requirePlan = false;
  // A FAIXA É DO ADMIN: mínimo R$ 20, máximo R$ 500.
  P.billing.deposit = { min: 2000, max: 50000 };
  P.affiliate.withdraw = { min: 3000, max: 0 };
  db.save();

  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Loja', email: 'loja@ex.com', pass: 'segredo123',
      profile: { phone: '11988887777', country: 'BR' }, recebimento: { document: '39053344705' }
    })
  });
  const ent = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'loja@ex.com', pass: 'segredo123' })
  }));
  const cab = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ent.token };
  const acc = db.findAccountByEmail('loja@ex.com');

  const depositar = (valor, extra) => fetch(BASE + '/api/billing/topup', {
    method: 'POST', headers: cab, body: JSON.stringify({ amount: valor, ...extra })
  });

  console.log('=== 1. A FAIXA DO ADMIN é respeitada ===');
  // Sem isto, um cliente deposita R$ 0,01 e a plataforma paga a taxa do
  // gateway por uma cobrança que não cobre nem o custo dela.
  const baixo = await depositar('10');
  ok(baixo.status === 400, `abaixo do mínimo é recusado: ${baixo.status}`);
  ok(/mínimo: R\$\s?20,00/.test((await baixo.json()).error), 'dizendo qual é o mínimo');

  const alto = await depositar('900');
  ok(alto.status === 400, `acima do máximo é recusado: ${alto.status}`);
  ok(/máximo/.test((await alto.json()).error), 'dizendo qual é o máximo');

  const zero = await depositar('0');
  ok(zero.status === 400, 'e zero também');

  console.log('\n=== 2. O Pix nasce, mas o saldo NÃO entra antes de pagar ===');
  const saldoAntes = acc.wallet.balance;
  const dep = await json(await depositar('50'));
  ok(!!dep.charge && !!dep.charge.brCode, 'a cobrança volta com o código Pix');
  ok(dep.charge.correlationID.startsWith('topup-'), 'marcada como recarga: ' + dep.charge.correlationID);
  ok(dep.charge.amount === 5000, `no valor pedido: ${dep.charge.amount}`);
  ok(acc.wallet.balance === saldoAntes, 'e o saldo NÃO se mexe antes de o dinheiro entrar');

  console.log('\n=== 3. Pago: o saldo entra, uma vez só ===');
  woovi.applyPayment({ correlationID: dep.charge.correlationID, value: 5000 }, null);
  ok(acc.wallet.balance === saldoAntes + 5000, `saldo: ${saldoAntes} → ${acc.wallet.balance}`);
  const tx = acc.wallet.transactions.slice(-1)[0];
  ok(tx && tx.type === 'topup' && tx.amount === 5000, 'com o lançamento no extrato');

  // O WEBHOOK REPETIDO é o caso que mais dói: os gateways reenviam quando não
  // recebem 200 na primeira, e creditar de novo é dinheiro dado.
  woovi.applyPayment({ correlationID: dep.charge.correlationID, value: 5000 }, null);
  ok(acc.wallet.balance === saldoAntes + 5000,
     `o reenvio NÃO credita de novo: ${acc.wallet.balance}`);
  ok(acc.wallet.transactions.filter(t => t.type === 'topup').length === 1,
     'e o extrato tem um lançamento só');

  console.log('\n=== 4. Pagamento de valor DIFERENTE do pedido ===');
  // Acontece: a pessoa edita o valor no app do banco. O que entra é o que foi
  // PAGO, e não o que foi pedido — creditar o pedido seria dar troco do que
  // não entrou.
  const d2 = await json(await depositar('50'));
  const saldo2 = acc.wallet.balance;
  woovi.applyPayment({ correlationID: d2.charge.correlationID, value: 3000 }, null);
  ok(acc.wallet.balance === saldo2 + 3000,
     `credita o que foi pago (30), não o que foi pedido (50): +${acc.wallet.balance - saldo2}`);

  console.log('\n=== 5. O SAQUE respeita saldo, faixa e taxa ===');
  const semSaldo = await fetch(BASE + '/api/wallet/withdraw', {
    method: 'POST', headers: cab, body: JSON.stringify({ amount: '9999', pixKey: 'x@y.com' })
  });
  ok(semSaldo.status === 400, `sacar mais do que tem é recusado: ${semSaldo.status}`);
  ok(/insuficiente/i.test((await semSaldo.json()).error), 'dizendo que o saldo não dá');

  const semChave = await fetch(BASE + '/api/wallet/withdraw', {
    method: 'POST', headers: cab, body: JSON.stringify({ amount: '50' })
  });
  ok(semChave.status === 400, 'sem chave Pix, não saca');

  const abaixo = await fetch(BASE + '/api/wallet/withdraw', {
    method: 'POST', headers: cab, body: JSON.stringify({ amount: '10', pixKey: 'x@y.com' })
  });
  ok(abaixo.status === 400, `abaixo do mínimo de saque: ${abaixo.status}`);

  const saldoPreSaque = acc.wallet.balance;
  const saque = await json(await fetch(BASE + '/api/wallet/withdraw', {
    method: 'POST', headers: cab, body: JSON.stringify({ amount: '50', pixKey: 'chave@ex.com' })
  }));
  ok(saque.ok === true, 'o saque válido passa');
  ok(acc.wallet.balance === saldoPreSaque - 5000,
     `e o saldo cai pelo VALOR PEDIDO: ${saldoPreSaque} → ${acc.wallet.balance}`);
  ok(typeof saque.net === 'number' && saque.net <= 5000,
     `com o líquido depois da taxa: ${saque.net} (taxa ${saque.fee})`);

  const pedido = db.get().withdrawals.slice(-1)[0];
  ok(pedido && pedido.status === 'pending', 'o pedido nasce pendente, para o admin aprovar');
  ok(pedido.accountId === acc.id && pedido.pixKey === 'chave@ex.com', 'com a conta e a chave');

  console.log('\n=== 6. O ATENDENTE não mexe no dinheiro do dono ===');
  // O menu esconde, mas esconder não é proteger: sem a guarda, um atendente
  // autenticado chamava a rota na mão e pedia saque para a própria chave.
  const atendente = { id: db.genId('ag'), name: 'Ana', email: 'ana@ex.com', active: true,
    passHash: db.hashPassword('segredo123'), permissions: {} };
  acc.team = [atendente];
  db.save();
  const entAg = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'ana@ex.com', pass: 'segredo123' })
  }));
  if (entAg.token) {
    const cabAg = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + entAg.token };
    const rSaque = await fetch(BASE + '/api/wallet/withdraw', {
      method: 'POST', headers: cabAg, body: JSON.stringify({ amount: '30', pixKey: 'ana@ex.com' })
    });
    ok(rSaque.status === 403, `atendente não saca: ${rSaque.status}`);
    const rDep = await fetch(BASE + '/api/billing/topup', {
      method: 'POST', headers: cabAg, body: JSON.stringify({ amount: '50' })
    });
    ok(rDep.status === 403, `nem deposita: ${rDep.status}`);
  } else {
    ok(false, 'o atendente não conseguiu entrar — o teste não mediu a guarda');
  }

  console.log('\n=== 7. O resumo do topo bate com a carteira ===');
  const resumo = await json(await fetch(BASE + '/api/wallet/summary', { headers: cab }));
  ok(resumo.balance === acc.wallet.balance, `saldo igual ao do banco: ${resumo.balance}`);
  ok(resumo.deposito && resumo.deposito.min === 2000,
     'com a faixa de depósito que o admin definiu');

  console.log('\n=== 8. Recarga automática: só liga com o que precisa ===');
  const semCartao = await fetch(BASE + '/api/wallet/auto-topup', {
    method: 'PUT', headers: cab,
    body: JSON.stringify({ enabled: true, method: 'card', threshold: '10', amount: '50' })
  });
  ok(semCartao.status >= 400, `sem cartão salvo, não liga: ${semCartao.status}`);

  const desligar = await fetch(BASE + '/api/wallet/auto-topup', {
    method: 'PUT', headers: cab, body: JSON.stringify({ enabled: false })
  });
  ok(desligar.status === 200, 'e desligar sempre funciona');

  console.log('\n=== 9. O prefixo topup- é reconhecido pelos DOIS caminhos ===');
  // Woovi manda pelo webhook dela; a Simplify pelo `saaspix`. Um prefixo que só
  // um dos dois reconhece é dinheiro que entra e não credita.
  ok(saaspix.ehCobrancaSaaS('topup-abc'), 'saaspix reconhece a recarga');
  ok(saaspix.metodoDeCid('topup-abc') === 'pix', 'e sabe que é Pix');

  srv.close();
  await encerrar(null, falhas);
})();
