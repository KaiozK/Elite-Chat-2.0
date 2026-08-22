// O MÓDULO DE PAGAMENTOS TROCOU DE NOME NO DISCO.
//
// Ele se chamava `elitepay`, do produto anterior. Renomear no código sem mover
// os dados não daria erro — daria SILÊNCIO, que é pior: o módulo de cada conta
// nasceria vazio (sem subconta, sem cobranças, sem carteira), o plano deixaria
// de liberar a tela e o atendente perderia a permissão de cobrar. Nenhum log,
// nenhuma exceção: para o código novo, essas contas simplesmente nunca teriam
// tido nada.
//
// Este teste existe porque a migração roda UMA VEZ, no primeiro carregamento
// depois do deploy. Se ela estiver errada, ninguém descobre por um teste que
// falha — descobre por um cliente ligando para perguntar onde foi parar o
// dinheiro dele.
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

const db = require(R + 'src/db');

(async () => {
  await db.loadAsync();

  // ---- O BANCO COMO ESTAVA ANTES DO DEPLOY: tudo sob o nome antigo.
  const acc = db.newAccount({ name: 'Loja da Bia', email: 'bia@loja.com', pass: 'segredo123' });
  delete acc.pagamentos;
  acc.elitepay = {
    subaccount: { status: 'active', name: 'Loja da Bia', pixKey: 'bia@pix.com' },
    settings: { expiresMin: 1440, notifyPaid: true },
    charges: [
      { id: 'epc_antiga1', value: 15900, status: 'paid', method: 'pix', platformCut: 300 },
      { id: 'epc_antiga2', value: 4900, status: 'active', method: 'pix' }
    ],
    products: [{ id: 'prd_1', name: 'Camiseta' }],
    checkouts: [{ id: 'ckt_1', name: 'Meu checkout' }],
    logs: []
  };
  acc.team = [{ id: 'ag1', name: 'Ana', permissions: { elitepay: { view: true, create: true, edit: false, delete: false } } }];
  db.get().accounts.push(acc);
  db.get().platform.elitepay = { gateway: 'woovi', feeInPercent: 7, splitPixKey: 'chave@plataforma', logs: [] };
  delete db.get().platform.pagamentos;
  db.get().plans.push({ id: 'pl_pro', name: 'Pro', price: 19700, periodDays: 30, modules: { elitepay: true, campaigns: true }, limits: {}, archived: false });
  db.save();
  await new Promise(r => setTimeout(r, 300));

  // ---- O DEPLOY: o processo sobe e carrega o banco. É aí que a migração roda.
  await db.loadAsync();
  const d = db.get();
  const conta = d.accounts.find(a => (a.email || '').toLowerCase() === 'bia@loja.com');

  console.log('=== 1. O módulo da conta muda de nome com tudo dentro ===');
  ok(!!conta, 'a conta continua no banco');
  ok(conta.elitepay === undefined, 'a chave antiga sumiu');
  ok(!!conta.pagamentos, 'e a nova existe');
  ok((conta.pagamentos.charges || []).length === 2, `as cobranças vieram junto: ${(conta.pagamentos.charges || []).length}`);
  ok(conta.pagamentos.subaccount && conta.pagamentos.subaccount.status === 'active',
     'a subconta do adquirente continua ativa — sem ela o cliente não recebe');
  ok((conta.pagamentos.products || []).length === 1, 'os produtos vieram');
  ok((conta.pagamentos.checkouts || []).length === 1, 'e os checkouts também');
  ok(conta.pagamentos.settings && conta.pagamentos.settings.expiresMin === 1440, 'com as configurações de antes');

  console.log('\n=== 2. O plano continua liberando a tela ===');
  // Sem isto, todo cliente pagante perderia o módulo no dia do deploy.
  const plano = d.plans.find(p => p.id === 'pl_pro');
  ok(plano.modules.elitepay === undefined, 'a chave antiga sumiu do plano');
  ok(plano.modules.pagamentos === true, 'e o plano libera Pagamentos');
  ok(plano.modules.campaigns === true, 'sem mexer no que não era dele');

  console.log('\n=== 3. O atendente continua podendo cobrar ===');
  const perm = conta.team[0].permissions;
  ok(perm.elitepay === undefined, 'a permissão antiga sumiu');
  ok(perm.pagamentos && perm.pagamentos.view === true && perm.pagamentos.create === true,
     'e a nova preserva o que estava marcado');

  console.log('\n=== 4. A configuração da plataforma vem junto ===');
  ok(d.platform.elitepay === undefined, 'a chave antiga sumiu da plataforma');
  ok(d.platform.pagamentos && d.platform.pagamentos.feeInPercent === 7,
     `a taxa configurada continua de pé: ${d.platform.pagamentos && d.platform.pagamentos.feeInPercent}%`);
  ok(d.platform.pagamentos.splitPixKey === 'chave@plataforma', 'e a chave de split também');

  console.log('\n=== 5. A troca é gravada, e o próximo boot não refaz nada ===');
  // A migração grava o resultado. Sem isso ela rodaria de novo a cada partida
  // do processo — trabalho repetido e uma linha de log para sempre, com o disco
  // preso no nome antigo. O processo reinicia várias vezes por dia.
  const antes = JSON.stringify(conta.pagamentos);
  await new Promise(r => setTimeout(r, 400));   // deixa a gravação cair no disco
  await db.loadAsync();
  const conta2 = db.get().accounts.find(a => (a.email || '').toLowerCase() === 'bia@loja.com');
  ok(JSON.stringify(conta2.pagamentos) === antes, 'o segundo carregamento deixa tudo como estava');

  console.log('\n=== 6. Conta que já nasceu com o nome novo não é tocada ===');
  const nova = db.newAccount({ name: 'Nova', email: 'nova@loja.com', pass: 'segredo123' });
  // O módulo nasce sob demanda, no primeiro uso — não junto com a conta.
  require(R + 'src/pagamentos').ensure(nova);
  nova.pagamentos.charges = [{ id: 'epc_nova', value: 100, status: 'active' }];
  db.get().accounts.push(nova);
  db.save();
  await new Promise(r => setTimeout(r, 300));
  await db.loadAsync();
  const nova2 = db.get().accounts.find(a => (a.email || '').toLowerCase() === 'nova@loja.com');
  ok((nova2.pagamentos.charges || []).length === 1, 'a cobrança dela continua lá');

  await encerrar(null, falhas);
})();
