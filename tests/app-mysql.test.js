// O APLICATIVO INTEIRO rodando sobre o MySQL (com o driver simulado).
//
// Os testes do motor provam o motor. Este prova o que interessa: sobe o
// servidor de verdade com DB_DRIVER=mysql, faz o caminho de um cliente real
// (cadastro, login, uso, reinício) e confere que nada se perde nem se duplica.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

// ---- MySQL de mentira, mas PERSISTENTE entre "reinícios" do processo --------
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
process.env.PORT = '3991';

// "Reinicia o servidor": limpa o cache dos módulos para tudo recarregar do
// banco, como aconteceria num deploy.
function reiniciar() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('whatsapp-crm') && !k.includes('node_modules')) delete require.cache[k];
  }
}

const base = 'http://127.0.0.1:3991';
const chamar = async (metodo, rota, corpo, token) => {
  const r = await fetch(base + rota, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  let j = null; try { j = await r.json(); } catch {}
  return { http: r.status, ...j };
};

let servidor = null;
async function subir() {
  reiniciar();
  const express = require('express');
  const db = require(R + 'src/db');
  await db.loadAsync();
  const app = express();
  app.use(express.json());
  const broadcast = () => {};
  app.use('/api', require(R + 'src/api')(broadcast));
  servidor = app.listen(3991);
  await new Promise(r => setTimeout(r, 120));
  return db;
}
async function derrubar(db) {
  await new Promise(r => servidor.close(r));
  await new Promise(r => setTimeout(r, 250));   // deixa a fila de gravação drenar
  if (db) await db.close();
}

(async () => {
  console.log('=== 1. Primeira partida, banco vazio ===');
  let db = await subir();
  ok(db.storage.nome === 'mysql', 'o motor em uso é o MySQL');
  ok(tabela.size > 0, 'a partida gravou os padrões: ' + tabela.size + ' pedaço(s)');
  ok(db.get().platform.adminUser === 'admin', 'plataforma criada');

  console.log('\n=== 2. Um cliente se cadastra ===');
  const reg = await chamar('POST', '/api/register', {
    name: 'Loja do Teste', email: 'mysql@exemplo.com', pass: 'senhaMysql123',
    profile: { country: 'BR', phone: '(11) 97777-8888', segment: 'iGaming' }
  });
  ok(reg.http === 200 && !!reg.token, 'cadastrou');
  ok(reg.planRequired === true, 'e nasceu trancado, esperando assinar');
  const token = reg.token;

  console.log('\n=== 3. O que ele faz é gravado ===');
  await chamar('PUT', '/api/account', { name: 'Loja Renomeada' }, token);
  const conta = db.get().accounts.find(a => a.email === 'mysql@exemplo.com');
  ok(conta.name === 'Loja Renomeada', 'a mudança está na memória');
  ok(conta.profile.phone === '+5511977778888', 'telefone em E.164: ' + conta.profile.phone);
  await new Promise(r => setTimeout(r, 350));
  const gravado = JSON.parse(tabela.get('account:' + conta.id) || '{}');
  ok(gravado.name === 'Loja Renomeada', 'e chegou ao MySQL');

  console.log('\n=== 4. REINÍCIO: nada se perde ===');
  const idAntes = conta.id;
  const totalAntes = tabela.size;
  await derrubar(db);
  db = await subir();
  const depois = db.get().accounts.find(a => a.id === idAntes);
  ok(!!depois, 'a conta voltou depois do reinício');
  ok(depois.name === 'Loja Renomeada', 'com o nome que tinha');
  ok(depois.profile.phone === '+5511977778888', 'e o telefone');
  ok(db.get().accounts.length === 1, 'sem duplicar: ' + db.get().accounts.length + ' conta(s)');
  ok(tabela.size === totalAntes, 'sem pedaço órfão: ' + tabela.size);

  console.log('\n=== 5. Login sobrevive ao reinício ===');
  const login = await chamar('POST', '/api/login', { user: 'mysql@exemplo.com', pass: 'senhaMysql123' });
  ok(login.http === 200 && !!login.token, 'entrou com a mesma senha (scrypt veio do MySQL)');
  const errada = await chamar('POST', '/api/login', { user: 'mysql@exemplo.com', pass: 'senhaErrada' });
  ok(errada.http === 401, 'e a senha errada continua sendo recusada');

  console.log('\n=== 6. A trava de assinatura funciona igual ===');
  const bloq = await chamar('GET', '/api/contacts', null, login.token);
  ok(bloq.http === 402 && /Escolha um plano/.test(bloq.error || ''), 'sem plano, 402: ' + bloq.error);
  const bill = await chamar('GET', '/api/billing', null, login.token);
  ok(bill.http === 200, 'e a tela de assinatura abre');

  console.log('\n=== 7. Assinatura ativa destranca, e persiste ===');
  const g = db.get();
  g.plans.push({ id: 'pl_m', name: 'Pro', price: 9900, periodDays: 30, archived: false,
    limits: db.defaultLimits(), modules: db.defaultFeatures() });
  const c2 = g.accounts.find(a => a.id === idAntes);
  c2.billing.status = 'active'; c2.billing.planId = 'pl_m'; c2.billing.periodEnd = Date.now() + 30 * 86400000;
  db.save();
  await new Promise(r => setTimeout(r, 350));
  const liberado = await chamar('GET', '/api/contacts', null, login.token);
  ok(liberado.http === 200, 'com plano, a API abre');

  await derrubar(db);
  db = await subir();
  const c3 = db.get().accounts.find(a => a.id === idAntes);
  ok(c3.billing.status === 'active' && c3.billing.planId === 'pl_m', 'a assinatura sobreviveu ao reinício');
  ok(db.get().plans.some(p => p.id === 'pl_m'), 'e o plano também');

  console.log('\n=== 8. Volume: 300 mensagens numa conta ===');
  const c4 = db.get().accounts.find(a => a.id === idAntes);
  for (let i = 0; i < 300; i++) c4.messages.push({ id: 'm' + i, waId: '5511', direction: 'in', timestamp: Date.now(), text: 'msg ' + i + ' 🎉' });
  db.save();
  await new Promise(r => setTimeout(r, 400));
  await derrubar(db);
  db = await subir();
  const c5 = db.get().accounts.find(a => a.id === idAntes);
  ok(c5.messages.length === 300, '300 mensagens voltaram: ' + c5.messages.length);
  ok(c5.messages[299].text === 'msg 299 🎉', 'com o emoji intacto');

  console.log('\n=== 9. Excluir conta some do banco ===');
  const g2 = db.get();
  const outra = db.newAccount({ name: 'Some', email: 'some@exemplo.com', pass: 'senha123456' });
  g2.accounts.push(outra);
  db.save();
  await new Promise(r => setTimeout(r, 300));
  ok(tabela.has('account:' + outra.id), 'a conta nova foi gravada');
  g2.accounts = g2.accounts.filter(a => a.id !== outra.id);
  db.save();
  await new Promise(r => setTimeout(r, 300));
  ok(!tabela.has('account:' + outra.id), 'e o pedaço dela foi apagado');

  await derrubar(db);
  db = await subir();
  ok(db.get().accounts.length === 1, 'depois do reinício, só a conta que ficou');
  await derrubar(db);

  Module._load = origLoad;
  console.log(falhas ? '\n' + falhas + ' FALHA(S)' : '\nTODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { Module._load = origLoad; console.log('ERRO:', e.message, e.stack); process.exit(1); });
