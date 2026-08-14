// A etapa de recebimento do CADASTRO tem que virar a subconta no gateway.
//
// Existe porque a etapa 3 do cadastro pede CPF/CNPJ e chave Pix exatamente
// para o cliente NÃO ter que preencher os mesmos dados de novo ao entrar em
// Pagamentos. Duas coisas precisam valer sempre:
//   · com os dados, a subconta nasce junto com a conta;
//   · quando o gateway falha, o cadastro NÃO se perde e os dados ficam
//     guardados, para o formulário do Pagamentos já vir preenchido.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

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

// O gateway é simulado: `quebrado` liga a falha para testar o segundo caso.
let quebrado = false;
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('woovi') || url.includes('openpix') || url.includes('asaas')) {
    if (quebrado) throw new Error('gateway indisponível');
    return { ok: true, status: 200, json: async () => ({ subAccount: { pixKey: 'x' } }), text: async () => '{}', clone() { return this; } };
  }
  return fetchReal(u, o);
};

let servidor = null; const porta = 3995;
const base = () => 'http://127.0.0.1:' + porta;
const chamar = async (metodo, rota, corpo, token) => {
  const r = await fetch(base() + rota, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  let j = null; try { j = await r.json(); } catch {}
  return { http: r.status, ...j };
};

const cadastro = (email, receb) => ({
  name: 'Loja do Teste', email, pass: 'senha123',
  profile: { segment: 'varejo', size: '1-5', phone: '11987654321', country: 'BR', goal: 'vender' },
  recebimento: receb
});

(async () => {
  const express = require('express');
  const db = require(R + 'src/db');
  await db.loadAsync();
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api', require(R + 'src/api')(() => {}));
  servidor = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  // O gateway precisa estar configurado, senão a subconta nem é tentada.
  const plat = db.get().platform;
  plat.woovi = plat.woovi || {};
  plat.woovi.appId = 'APPID-DE-TESTE';
  plat.woovi.sandbox = true;
  plat.elitepay = plat.elitepay || {};
  plat.elitepay.onboardingMode = 'subaccount';
  db.save();

  console.log('=== 1. Cadastro COM os dados de recebimento ===');
  let r = await chamar('POST', '/api/register', cadastro('com@teste.com', {
    document: '52795162000167', pixKey: '11987654931', pixKeyType: 'telefone'
  }));
  ok(r.http === 200, 'conta criada');
  ok(!!r.token, 'e já entrou');
  const acc1 = db.get().accounts.find(a => a.email === 'com@teste.com');
  ok(!!acc1, 'a conta existe no banco');
  ok(!!(acc1 && acc1.elitepay && acc1.elitepay.subaccount),
    'a SUBCONTA de Pagamentos nasceu junto com o cadastro');
  ok(!!(acc1 && acc1.profile.document === '52795162000167'),
    'o documento ficou guardado na conta: ' + (acc1 && acc1.profile.document));

  // O 402 de 'escolha um plano' é outra história: aqui se testa o Pagamentos.
  acc1.unlimited = true; db.save();
  r = await chamar('GET', '/api/elitepay', null, r.token);
  ok(r.http === 200, '/elitepay responde: ' + r.http + ' ' + (r.error||''));
  ok(!!(r.conta && r.conta.name && r.conta.email),
    'e devolve os dados da conta para o formulário nascer preenchido');
  ok(r.conta && r.conta.document === '52795162000167', 'inclusive o CPF/CNPJ');

  console.log('\n=== 2. Gateway fora do ar: o cadastro NÃO pode se perder ===');
  quebrado = true;
  r = await chamar('POST', '/api/register', cadastro('falha@teste.com', {
    document: '11144477735', pixKey: 'chave@teste.com', pixKeyType: 'email'
  }));
  ok(r.http === 200, 'a conta é criada mesmo assim');
  const acc2 = db.get().accounts.find(a => a.email === 'falha@teste.com');
  ok(!!acc2, 'e existe no banco');
  ok(acc2 && acc2.profile.document === '11144477735',
    'os dados de recebimento ficaram guardados apesar da falha: ' + (acc2 && acc2.profile.document));
  ok(acc2 && acc2.profile.pixKey === 'chave@teste.com', 'a chave Pix também');

  acc2.unlimited = true; db.save();
  const r2 = await chamar('POST', '/api/login', { user: 'falha@teste.com', pass: 'senha123' });
  const info = await chamar('GET', '/api/elitepay', null, r2.token);
  ok(info.conta && info.conta.document === '11144477735',
    'e voltam no /elitepay, então ele NÃO redigita nada em Pagamentos');
  quebrado = false;

  console.log('\n=== 3. Cadastro sem os dados (pulou a etapa) ===');
  r = await chamar('POST', '/api/register', cadastro('pulou@teste.com', {}));
  ok(r.http === 200, 'a conta é criada sem recebimento');
  const acc3 = db.get().accounts.find(a => a.email === 'pulou@teste.com');
  ok(acc3 && !acc3.profile.document, 'e sem documento guardado, como esperado');

  await new Promise(res => servidor.close(res));
  await db.close();
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
