// PAGAR PRIMEIRO, CADASTRAR DEPOIS.
//
// A conta nascia no cadastro e a cobrança vinha atrás: quem desistia no
// pagamento deixava conta vazia, e o CPF/CNPJ que o adquirente exige só
// aparecia num segundo formulário. Agora o checkout cobra tudo de uma vez,
// paga, e só então a conta existe — com os mesmos dados, travados, no cadastro.
//
// O que precisa valer sempre:
//   · sem os quatro dados válidos não há cobrança;
//   · sem pagamento confirmado não há conta;
//   · a conta que nasce traz o documento e o telefone de quem pagou;
//   · quem pagou e não terminou o cadastro não entra com senha nenhuma;
//   · terminar o cadastro define a senha e já devolve a sessão.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// BANCO DE MENTIRA: teste não escreve no banco de ninguém.
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

// O adquirente é simulado: o que interessa é o caminho, não a rede.
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('simplifybr.com')) {
    return { ok: true, status: 201, text: async () => JSON.stringify({ internal_id: 'TXN1', qrcode: '00020126-PIX-NOVO', status: 'pending' }) };
  }
  if (url.includes('openpix') || url.includes('woovi')) {
    const j = { charge: { brCode: '00020126-PIX-NOVO', identifier: 'W1' } };
    return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), clone() { return this; } };
  }
  return fetchReal(u, o);
};

const porta = 3992;
const post = (rota, corpo) => fetch('http://127.0.0.1:' + porta + '/api' + rota,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) })
  .then(async r => ({ st: r.status, b: await r.json() }));
const get = (rota) => fetch('http://127.0.0.1:' + porta + '/api' + rota).then(async r => ({ st: r.status, b: await r.json() }));

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const pagamentos = require(R + 'src/pagamentos');
  const woovi = require(R + 'src/woovi');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const d = db.get();
  d.platform.woovi.appId = 'APPID';
  d.platform.baseUrl = 'https://koonfy.com';
  pagamentos.platformCfg().gateway = 'woovi';
  const plano = { id: 'p_premium', name: 'Premium', price: 19700, periodDays: 30, limits: {}, features: ['3 números'] };
  d.plans.push(plano);
  const contasAntes = d.accounts.length;

  const bons = { planId: plano.id, nome: 'Maria Souza', email: 'maria@loja.com',
                 telefone: '(11) 98888-7777', documento: '847.489.140-09', pais: 'BR' };

  console.log('=== 1. Sem dado válido, não há cobrança ===');
  let r = await post('/public/assinatura', { ...bons, documento: '111.111.111-11' });
  ok(r.st === 400, 'CPF inventado é recusado: ' + r.st);
  ok(/CPF/i.test(r.b.error || ''), 'dizendo o motivo: ' + r.b.error);
  r = await post('/public/assinatura', { ...bons, email: 'sem-arroba' });
  ok(r.st === 400, 'e-mail torto é recusado: ' + r.st);
  r = await post('/public/assinatura', { ...bons, telefone: '123' });
  ok(r.st === 400, 'telefone curto é recusado: ' + r.st);
  ok(db.get().accounts.length === contasAntes, 'e nada disso criou conta');

  console.log('\n=== 2. Dados completos geram a cobrança ===');
  r = await post('/public/assinatura', bons);
  ok(r.st === 200, 'cobrança criada: ' + r.st);
  const token = r.b.token;
  ok(!!token, 'com um token para acompanhar');
  ok(r.b.cobranca && r.b.cobranca.brCode === '00020126-PIX-NOVO', 'e o Pix do adquirente: ' + (r.b.cobranca || {}).brCode);
  ok(db.get().accounts.length === contasAntes, 'a conta AINDA não existe: quem manda é o pagamento');

  console.log('\n=== 3. Enquanto não cai, a tela sabe esperar ===');
  let v = await get('/public/assinatura/' + token);
  ok(v.b.status === 'pending', 'status pendente: ' + v.b.status);
  ok(!!(v.b.cobranca && v.b.cobranca.brCode), 'e o Pix volta para quem recarregou a página');

  console.log('\n=== 4. Pagou: a conta nasce com os dados de quem pagou ===');
  const pre = require(R + 'src/preassinatura');
  const cid = db.get().preassinaturas[0].correlationID;
  ok(/^nov-/.test(cid), 'a cobrança é identificada como compra sem conta: ' + cid.split('-')[0] + '-');
  woovi.applyPayment({ correlationID: cid, value: 19700 }, null);
  await new Promise(r2 => setTimeout(r2, 60));
  const acc = db.get().accounts.find(a => a.email === 'maria@loja.com');
  ok(!!acc, 'a conta existe agora');
  ok(acc && acc.profile.document === '84748914009', 'com o CPF do checkout: ' + (acc && acc.profile.document));
  ok(acc && String(acc.profile.phone).replace(/\D/g, '') === '5511988887777',
    'e o WhatsApp no mesmo formato do cadastro comum: ' + (acc && acc.profile.phone));
  ok(acc && acc.billing.status === 'active' && acc.billing.planId === plano.id, 'plano ativo desde a confirmação');
  ok(db.get().revenue.some(x => x.chargeId === cid), 'a receita foi registrada');
  ok(acc && acc.pendenteCadastro === true, 'e ela nasce marcada como cadastro pendente');

  console.log('\n=== 5. Webhook repetido não cria conta duas vezes ===');
  woovi.applyPayment({ correlationID: cid, value: 19700 }, null);
  ok(db.get().accounts.filter(a => a.email === 'maria@loja.com').length === 1, 'continua uma conta só');

  console.log('\n=== 6. Sem terminar o cadastro, ninguém entra ===');
  r = await post('/login', { user: 'maria@loja.com', pass: 'qualquer' });
  ok(r.st === 409, 'o login avisa em vez de dizer "senha inválida": ' + r.st);
  ok(/cadastro/i.test(r.b.error || ''), 'e explica o que falta: ' + (r.b.error || '').slice(0, 46) + '…');

  console.log('\n=== 7. Os dados do checkout voltam para o cadastro ===');
  v = await get('/public/assinatura/' + token);
  ok(v.b.status === 'paid', 'status pago: ' + v.b.status);
  ok(v.b.dados.documento === '84748914009' && v.b.dados.email === 'maria@loja.com',
    'com documento e e-mail para o formulário travar');

  console.log('\n=== 8. Empresa e senha fecham o cadastro ===');
  r = await post('/public/assinatura/' + token + '/concluir', { empresa: 'Loja da Maria', senha: '123' });
  ok(r.st === 400, 'senha curta é recusada: ' + r.st);
  r = await post('/public/assinatura/' + token + '/concluir', { empresa: 'Loja da Maria', senha: 'segredo123', size: '2 a 5' });
  ok(r.st === 200, 'concluiu: ' + r.st);
  ok(!!r.b.token, 'e já devolve a sessão, sem pedir para entrar de novo');
  const acc2 = db.get().accounts.find(a => a.email === 'maria@loja.com');
  ok(acc2.name === 'Loja da Maria', 'a conta passa a se chamar como a empresa: ' + acc2.name);
  ok(acc2.pendenteCadastro === false, 'e deixa de estar pendente');
  r = await post('/login', { user: 'maria@loja.com', pass: 'segredo123' });
  ok(r.st === 200 && !!r.b.token, 'agora o login funciona com a senha criada: ' + r.st);

  console.log('\n=== 9. O mesmo link não serve duas vezes ===');
  r = await post('/public/assinatura/' + token + '/concluir', { empresa: 'Outra', senha: 'segredo123' });
  ok(r.st === 409, 'cadastro já concluído é recusado: ' + r.st);

  console.log('\n=== 10. E-mail que já tem conta não abre outra ===');
  r = await post('/public/assinatura', bons);
  ok(r.st === 409, 'recusa e manda entrar pela conta existente: ' + r.st);

  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
