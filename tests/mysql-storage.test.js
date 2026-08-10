// Motor MySQL sem servidor MySQL: um driver simulado guarda as linhas em
// memória e registra o SQL exato, para provar o fatiamento, a gravação só do
// que mudou e o caminho de volta.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

// ---- banco de mentira -------------------------------------------------------
const tabela = new Map();       // chunk -> { data, updated_at }
const sqls = [];
let commits = 0, rollbacks = 0, falharProxima = false;

function executar(sql, params) {
  // guarda o SQL inteiro: cortar escondia o utf8mb4, que fica no fim do CREATE
  sqls.push(sql.replace(/\s+/g, ' ').trim());
  if (/^CREATE TABLE/i.test(sql)) return [[], []];
  if (/^SELECT chunk, data/i.test(sql)) {
    return [[...tabela].map(([chunk, v]) => ({ chunk, data: v.data })), []];
  }
  if (/^SELECT chunk, LENGTH/i.test(sql)) {
    return [[...tabela].map(([chunk, v]) => ({ chunk, bytes: v.data.length, updated_at: v.updated_at })), []];
  }
  if (/^INSERT INTO/i.test(sql)) {
    if (falharProxima) { falharProxima = false; throw new Error('conexão caiu no meio'); }
    for (const [chunk, data, ts] of params[0]) tabela.set(chunk, { data, updated_at: ts });
    return [{ affectedRows: params[0].length }, []];
  }
  if (/^DELETE FROM \w+ WHERE chunk IN/i.test(sql)) {
    for (const c of params[0]) tabela.delete(c);
    return [{}, []];
  }
  if (/^DELETE FROM/i.test(sql)) { tabela.clear(); return [{}, []]; }
  return [[], []];
}

const conexao = {
  query: async (sql, params) => executar(sql, params),
  beginTransaction: async () => {},
  commit: async () => { commits++; },
  rollback: async () => { rollbacks++; },
  release: () => {}
};

const poolFalso = {
  query: async (sql, params) => executar(sql, params),
  getConnection: async () => conexao,
  end: async () => {}
};

// intercepta o require do mysql2/promise
const origLoad = Module._load;
Module._load = function (pedido, pai, isMain) {
  if (pedido === 'mysql2/promise') return { createPool: () => poolFalso };
  return origLoad.apply(this, arguments);
};

process.env.DATABASE_URL = 'mysql://u:p@localhost:3306/koonfy_teste';
const motor = require(R + 'src/storage/mysql');

// ---- um banco de exemplo ----------------------------------------------------
const bancoBase = () => ({
  platform: { adminUser: 'admin', billing: { requirePlan: true } },
  plans: [{ id: 'pl_1', name: 'Pro', price: 19700 }],
  revenue: [], withdrawals: [], sessions: {}, loginChallenges: {}, webhookLog: [],
  accounts: [
    { id: 'acc_a', email: 'a@x.com', name: 'Conta A', messages: [{ id: 'm1', text: 'oi 👋' }] },
    { id: 'acc_b', email: 'b@x.com', name: 'Conta B', messages: [] }
  ]
});

(async () => {
  console.log('=== 1. Fatiamento ===');
  const db = bancoBase();
  const pedacos = motor.fatiar(db);
  ok(pedacos.has('platform') && pedacos.has('plans'), 'blocos do topo viram pedaços');
  ok(pedacos.has('account:acc_a') && pedacos.has('account:acc_b'), 'cada conta vira um pedaço próprio');
  ok(pedacos.has('__accounts_order'), 'a ordem das contas é guardada');
  ok(!pedacos.has('accounts'), 'o array inteiro de contas NÃO vira um pedaço só');

  console.log('\n=== 2. Primeira gravação ===');
  sqls.length = 0;
  await motor.gravar(db);
  ok(tabela.size === pedacos.size, 'gravou ' + tabela.size + ' pedaço(s)');
  ok(commits === 1, 'numa transação só');
  ok(sqls.some(s => /ON DUPLICATE KEY UPDATE/.test(s)), 'com upsert, para regravar sem duplicar');
  ok(/utf8mb4/.test(sqls.find(s => /CREATE TABLE/.test(s)) || ''), 'a tabela é utf8mb4 (emoji do WhatsApp)');

  console.log('\n=== 3. Só o que MUDOU vai para o banco ===');
  sqls.length = 0; commits = 0;
  await motor.gravar(db);   // nada mudou
  ok(commits === 0, 'gravar de novo sem mudança não abre transação');
  ok(!sqls.some(s => /INSERT/.test(s)), 'e não manda INSERT nenhum');

  db.accounts[0].messages.push({ id: 'm2', text: 'tudo bem?' });
  sqls.length = 0; commits = 0;
  const antes = tabela.get('account:acc_b').updated_at;
  await new Promise(r => setTimeout(r, 5));
  await motor.gravar(db);
  ok(commits === 1, 'mudar UMA conta grava');
  ok(tabela.get('account:acc_b').updated_at === antes, 'e a outra conta não é tocada');
  ok(JSON.parse(tabela.get('account:acc_a').data).messages.length === 2, 'a conta mexida foi atualizada');

  console.log('\n=== 4. Conta apagada some do banco ===');
  db.accounts = db.accounts.filter(a => a.id !== 'acc_b');
  await motor.gravar(db);
  ok(!tabela.has('account:acc_b'), 'o pedaço da conta removida é apagado');
  ok(tabela.has('account:acc_a'), 'a que ficou continua lá');

  console.log('\n=== 5. Volta idêntica ===');
  const volta = await motor.carregar();
  ok(!!volta, 'carregou');
  ok(volta.accounts.length === 1 && volta.accounts[0].id === 'acc_a', 'contas certas');
  ok(volta.accounts[0].messages[0].text === 'oi 👋', 'emoji sobreviveu: ' + volta.accounts[0].messages[0].text);
  ok(volta.platform.billing.requirePlan === true, 'configuração da plataforma intacta');
  ok(JSON.stringify(volta.plans) === JSON.stringify(db.plans), 'planos idênticos');

  console.log('\n=== 6. A ordem das contas é preservada ===');
  const d2 = bancoBase();
  d2.accounts = [{ id: 'acc_z', email: 'z@x.com' }, { id: 'acc_a', email: 'a@x.com' }, { id: 'acc_m', email: 'm@x.com' }];
  await motor.apagarTudo();
  await motor.gravar(d2);
  const v2 = await motor.carregar();
  ok(v2.accounts.map(a => a.id).join(',') === 'acc_z,acc_a,acc_m', 'ordem: ' + v2.accounts.map(a => a.id).join(','));

  console.log('\n=== 7. Falha no meio não corrompe nem mente ===');
  await motor.apagarTudo();
  await motor.gravar(d2);
  const antesDaFalha = tabela.get('account:acc_a').data;
  d2.accounts[1].email = 'novo@x.com';
  falharProxima = true;
  rollbacks = 0;
  await motor.gravar(d2);           // a fila engole o erro e loga
  ok(rollbacks === 1, 'a transação foi desfeita');
  ok(tabela.get('account:acc_a').data === antesDaFalha, 'o banco ficou como estava');
  falharProxima = false;
  await motor.gravar(d2);           // tenta de novo
  ok(JSON.parse(tabela.get('account:acc_a').data).email === 'novo@x.com',
     'a gravação seguinte reenvia o que falhou (o cache não mentiu que já gravou)');

  console.log('\n=== 8. Banco vazio ===');
  await motor.apagarTudo();
  ok((await motor.carregar()) === null, 'destino vazio devolve null, para o db.js criar os padrões');

  console.log('\n=== 9. Escolha do motor ===');
  delete require.cache[require.resolve(R + 'src/storage/index')];
  delete process.env.DB_DRIVER;
  ok(require(R + 'src/storage/index').nome === 'file', 'sem variável, usa arquivo');
  delete require.cache[require.resolve(R + 'src/storage/index')];
  process.env.DB_DRIVER = 'mysql';
  ok(require(R + 'src/storage/index').nome === 'mysql', 'DB_DRIVER=mysql usa MySQL');
  delete require.cache[require.resolve(R + 'src/storage/index')];
  delete process.env.DB_DRIVER;

  await motor.fechar();
  Module._load = origLoad;
  console.log(falhas ? '\n' + falhas + ' FALHA(S)' : '\nTODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { Module._load = origLoad; console.log('ERRO:', e.message, e.stack); process.exit(1); });
