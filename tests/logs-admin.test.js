// ============================================================================
// WEBHOOK & LOGS: DO ADMIN, DE TODO O SaaS, COM AS FALHAS SEPARADAS
//
// A tela vivia no painel do CLIENTE, e não é dele. Assinatura recusada,
// mensagem sem dono, erro de automação: é depuração de integração, e quem
// resolve isso é quem administra a plataforma. Para o cliente era ruído com
// cara de problema — cada linha vermelha ali virava um chamado no suporte por
// algo que ele não podia consertar.
//
// SOBRE "CÓDIGO DE ERRO vs 200": para a maioria destes eventos não existe
// código HTTP. O /webhook responde 200 à Meta mesmo quando o processamento
// falha depois — é o que a Meta exige para não reenviar em laço. O que separa
// um do outro é o DESFECHO, e é ele que fica registrado. Onde há status de
// verdade (chamada nossa a um gateway), ele aparece junto.
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

const fs = require('fs');
const db = require(R + 'src/db');

const BASE = 'http://127.0.0.1:3996';
const json = r => r.json();

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3996);
  await new Promise(r => setTimeout(r, 150));

  db.get().plans.push({ id: 'pro', name: 'Pro', price: 19700, periodDays: 30, limits: {}, modules: {} });
  db.save();

  // Duas contas de cliente, para provar que o admin vê as DUAS.
  for (const [nome, email] of [['Loja A', 'a@ex.com'], ['Loja B', 'b@ex.com']]) {
    await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nome, email, pass: 'segredo123',
        profile: { phone: '1198888' + (email === 'a@ex.com' ? '7777' : '6666'), country: 'BR' },
        recebimento: { document: email === 'a@ex.com' ? '39053344705' : '11144477735' }
      })
    });
  }
  const contaA = db.findAccountByEmail('a@ex.com');
  const contaB = db.findAccountByEmail('b@ex.com');
  // Plano ativo: sem isso a parede de assinatura responde 402 antes de qualquer
  // guarda de admin, e o teste mediria a parede errada.
  for (const c of [contaA, contaB]) {
    c.billing.status = 'active'; c.billing.planId = 'pro';
    c.billing.periodEnd = Date.now() + 30 * 86400000;
  }

  // Eventos das duas contas, uns bons e uns ruins.
  db.get().webhookLog = [
    { ts: 7, type: 'webhook', accountId: contaA.id, body: {} },
    { ts: 6, type: 'signature_invalid', accountId: contaA.id },
    { ts: 5, type: 'flow_run', accountId: contaB.id },
    { ts: 4, type: 'woovi_webhook_error', accountId: contaB.id, error: 'timeout' },
    { ts: 3, type: 'verify_attempt', ok: false },
    { ts: 2, type: 'verify_attempt', ok: true },
    { ts: 1, type: 'call_connect', accountId: contaA.id, status: 502 }
  ];
  db.save();

  const entrar = async (user, pass, rota) => json(await fetch(BASE + '/api/' + rota, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, pass })
  }));
  const adm = await entrar('admin', 'admin', 'adm/login');
  const cli = await entrar('a@ex.com', 'segredo123', 'login');
  const como = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  console.log('=== 1. O CLIENTE não alcança mais os logs ===');
  const rCli = await fetch(BASE + '/api/webhook-log', { headers: como(cli.token) });
  ok(rCli.status === 403, `cliente autenticado recebe 403: ${rCli.status}`);
  // A guarda é no SERVIDOR, e não só no menu: tirar o link esconde a porta,
  // não a tranca — e a rota era chamável na mão.
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  ok(/router\.get\('\/webhook-log', auth, adminOnly/.test(api),
     'a rota exige admin, e não só some do menu');

  console.log('\n=== 2. E o link sumiu do painel dele ===');
  const html = fs.readFileSync(R + 'public/app/index.html', 'utf8');
  ok(!/data-view="logs"/.test(html), 'sem item de menu no painel do cliente');
  const appjs = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(/ADM \? renderLogs\(\.\.\.a\) : \(location\.hash = '#\/dashboard'\)/.test(appjs),
     'e #/logs digitado na barra volta para o começo, em vez de dar erro seco');

  console.log('\n=== 3. O ADMIN vê o SaaS INTEIRO ===');
  const tudo = await json(await fetch(BASE + '/api/webhook-log', { headers: como(adm.token) }));
  ok(tudo.events.length === 7, `todos os eventos: ${tudo.events.length}`);
  const contas = new Set(tudo.events.map(e => e.conta).filter(Boolean));
  ok(contas.has('Loja A') && contas.has('Loja B'),
     'de todas as contas, com o nome de cada uma: ' + [...contas].join(', '));
  // Uma falha sem dono obriga a abrir o JSON para saber quem ela atingiu.
  ok(tudo.events.find(e => e.type === 'signature_invalid').conta === 'Loja A',
     'cada evento diz de quem é');

  console.log('\n=== 4. FALHAS separadas do que deu certo ===');
  // Num log corrido, os poucos que importam somem no meio dos que deram certo.
  ok(tudo.contagem.erro === 4, `falhas: ${tudo.contagem.erro}`);
  ok(tudo.contagem.ok === 3, `tudo certo: ${tudo.contagem.ok}`);
  ok(tudo.contagem.total === 7, `total: ${tudo.contagem.total}`);

  const erros = await json(await fetch(BASE + '/api/webhook-log?nivel=erro', { headers: como(adm.token) }));
  ok(erros.events.length === 4, `a aba de falhas traz só elas: ${erros.events.length}`);
  ok(erros.events.every(e => e.nivel === 'erro'), 'todas marcadas como erro');
  const tipos = erros.events.map(e => e.type).sort().join(',');
  ok(tipos === 'call_connect,signature_invalid,verify_attempt,woovi_webhook_error',
     'e são estas: ' + tipos);

  const bons = await json(await fetch(BASE + '/api/webhook-log?nivel=ok', { headers: como(adm.token) }));
  ok(bons.events.length === 3, `a aba do que deu certo: ${bons.events.length}`);
  ok(bons.events.every(e => e.nivel === 'ok'), 'nenhuma falha escapa para cá');
  // As contagens são do TOTAL, e não da fatia: são elas que dizem se vale
  // abrir a aba de falhas.
  ok(bons.contagem.erro === 4, 'e a contagem continua sendo do total, mesmo filtrando');

  console.log('\n=== 5. As três formas de ser uma falha ===');
  // O tipo do evento, a marca `ok:false` e o código HTTP quando existe.
  const porTipo = t => erros.events.find(e => e.type === t);
  ok(!!porTipo('signature_invalid'), 'pelo TIPO do evento (assinatura recusada)');
  ok(!!porTipo('verify_attempt'), 'pela marca ok:false (verificação que a Meta recusou)');
  ok(porTipo('call_connect') && porTipo('call_connect').status === 502,
     'e pelo código HTTP, onde ele existe: ' + porTipo('call_connect').status);
  ok(bons.events.some(e => e.type === 'verify_attempt'),
     'a verificação que deu certo fica do outro lado — mesmo tipo, desfecho oposto');

  console.log('\n=== 6. Dá para olhar uma conta só ===');
  const soB = await json(await fetch(BASE + '/api/webhook-log?conta=' + contaB.id, { headers: como(adm.token) }));
  ok(soB.events.length === 2, `os eventos da Loja B: ${soB.events.length}`);
  ok(soB.events.every(e => e.conta === 'Loja B'), 'e só dela');

  console.log('\n=== 7. A tela do admin mostra as abas ===');
  ok(/let LOG_NIVEL = 'erro'/.test(appjs),
     'e abre nas FALHAS: a primeira pergunta é "está quebrando alguma coisa?"');
  ok(/\['erro', 'Falhas'\]/.test(appjs) && /\['ok',   'Tudo certo'\]/.test(appjs),
     'com as duas abas e a visão completa');
  ok(/class="log-conta"/.test(appjs), 'mostrando de qual conta é cada evento');
  ok(/HTTP \$\{Number\(e\.status\)\}/.test(appjs), 'e o código HTTP quando existe');

  srv.close();
  await encerrar(null, falhas);
})();
