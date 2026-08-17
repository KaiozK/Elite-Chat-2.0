// EXPORTAÇÃO DE CONTATOS — a planilha não pode passar do plano.
//
// Existe porque a exportação levava a base INTEIRA: um cliente no plano de
// 10 mil contatos baixava os 50 mil que estivessem na conta. A base passa do
// limite por caminhos que não são cadastro manual — troca para um plano menor,
// ou mensagem recebida criando contato — então o teto tem de ser aplicado na
// hora de exportar, não só na hora de cadastrar.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// Banco de mentira: o teste não pode escrever no banco de desenvolvimento.
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

const porta = 3992;
const baixar = async (rota, tok) => {
  const r = await fetch('http://127.0.0.1:' + porta + rota, { headers: { Authorization: 'Bearer ' + tok } });
  return { http: r.status, texto: await r.text(), limite: r.headers.get('x-koonfy-limite'), cortados: r.headers.get('x-koonfy-cortados') };
};

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch('http://127.0.0.1:' + porta + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  ok(!!tok, 'admin entrou');

  const acc = db.get().accounts[0];
  acc.unlimited = false;                 // o admin é ilimitado por padrão; aqui ele é um cliente

  // Plano de 10 contatos (a escala não muda a regra) e 50 contatos na base.
  db.get().plans = [{ id: 'pl_teste', name: 'Starter', price: 9700, periodDays: 30, limits: { contacts: 10 }, modules: {} }];
  acc.billing = { status: 'active', planId: 'pl_teste', periodEnd: Date.now() + 30 * 86400000, extras: {} };
  acc.contacts = Array.from({ length: 50 }, (_, i) => ({
    waId: '55119000000' + String(i).padStart(2, '0'),
    name: 'Contato ' + i, stage: 'Novo', tags: [], createdAt: 1000 + i
  }));

  console.log('=== 1. A planilha para no teto do plano ===');
  let info = await (await fetch('http://127.0.0.1:' + porta + '/api/contacts/export/info', { headers: { Authorization: 'Bearer ' + tok } })).json();
  ok(info.total === 50, `a conta tem ${info.total} contatos`);
  ok(info.limite === 10, `o plano dá direito a ${info.limite}`);
  ok(info.exporta === 10, `a exportação traz ${info.exporta}`);
  ok(info.cortados === 40, `e avisa que ${info.cortados} ficaram de fora`);

  const csv = await baixar('/api/contacts/export', tok);
  const linhas = csv.texto.trim().split('\r\n');
  ok(csv.http === 200, 'o download responde 200');
  ok(linhas.length === 11, `10 contatos + cabeçalho = ${linhas.length} linhas`);
  ok(csv.cortados === '40', 'o corte também vai no cabeçalho da resposta');

  console.log('\n=== 2. Saem os MAIS RECENTES ===');
  // Se algo tem de ficar de fora, que seja o mais antigo: o lead novo é o que
  // ainda está em jogo.
  ok(linhas.some(l => l.includes('Contato 49')), 'o contato mais novo está na planilha');
  ok(!linhas.some(l => l.includes('Contato 0;')), 'o mais antigo ficou de fora');

  console.log('\n=== 3. A lista de consentimento tem o mesmo teto ===');
  // Sem isso ela viraria o atalho para levar a base inteira por outra porta.
  const cons = await baixar('/api/consent/export?status=all', tok);
  const lc = cons.texto.trim().split('\r\n');
  ok(lc.length <= 11, `no máximo 10 + cabeçalho: ${lc.length} linhas`);
  ok(cons.cortados === '40', 'e avisa o mesmo corte');

  console.log('\n=== 4. Plano ILIMITADO exporta tudo ===');
  db.get().plans[0].limits.contacts = -1;
  info = await (await fetch('http://127.0.0.1:' + porta + '/api/contacts/export/info', { headers: { Authorization: 'Bearer ' + tok } })).json();
  ok(info.exporta === 50 && info.cortados === 0, `exporta os 50 sem cortar: ${info.exporta}`);

  console.log('\n=== 5. Base MENOR que o limite não é cortada ===');
  db.get().plans[0].limits.contacts = 100;
  info = await (await fetch('http://127.0.0.1:' + porta + '/api/contacts/export/info', { headers: { Authorization: 'Bearer ' + tok } })).json();
  ok(info.exporta === 50 && info.cortados === 0, `exporta os 50 que existem: ${info.exporta}`);
  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
