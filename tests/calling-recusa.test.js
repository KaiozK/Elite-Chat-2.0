// ============================================================================
// QUANDO A META RECUSA HABILITAR LIGAÇÕES
//
// O caso relatado: o cliente liga a chave e recebe "Calling APIs cannot be
// enabled for this phone number" (erro 2593145). A MESMA recusa acontece no
// painel da própria Meta — o que descarta ser defeito do Koonfy.
//
// O problema não era a recusa: era a RESPOSTA. A Meta usa a mesma frase para
// causas diferentes e não diz qual é. A tela repetia essa frase, e o cliente
// ficava com um erro sem saída — nada a fazer, nada a conferir.
//
// Este arquivo prende as duas melhorias:
//   · o que dá para conferir ANTES é conferido aqui (número não registrado);
//   · o que só a Meta sabe vira uma lista do que checar, e não uma frase seca.
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
const meta = require(R + 'src/meta');
const wa = require(R + 'src/whatsapp');

let statusDoNumero = 'CONNECTED';
// O TETO DIÁRIO. A documentação da Calling API exige pelo menos 2.000
// destinatários únicos por dia, e um número recém-conectado nasce em TIER_250.
let tetoDoNumero = 'TIER_10K';
meta.phoneStatus = async () => ({ id: 'PHONE1', status: statusDoNumero, messaging_limit_tier: tetoDoNumero });

// A recusa REAL da Meta, com o código e a frase que ela devolve.
let recusar = true;
let chamou = 0;
wa.setCallingSettings = async () => {
  chamou++;
  if (!recusar) return { success: true };
  const e = new Error('Calling APIs cannot be enabled for this phone number.');
  e.status = 400;
  e.meta = { code: 2593145, message: 'Calling APIs cannot be enabled for this phone number.' };
  throw e;
};

const BASE = 'http://127.0.0.1:3997';
const json = r => r.json();

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3997);
  await new Promise(r => setTimeout(r, 150));

  db.get().platform.billing.requirePlan = false;
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
  acc.channels[0].wa = { connected: true, accessToken: 'T', wabaId: 'W', phoneNumberId: 'PHONE1' };
  db.save();

  const ligar = () => fetch(BASE + '/api/settings/calling', {
    method: 'PUT', headers: cab, body: JSON.stringify({ enabled: true })
  });

  console.log('=== 1. Número NÃO registrado: a recusa é nossa, e é útil ===');
  // Um número compartilhado com o app mas não registrado aparece "Pendente" no
  // WhatsApp Manager, e a Meta recusa chamadas nele — com a mesma frase opaca.
  // Perguntar antes evita mandar o cliente atrás do motivo errado.
  statusDoNumero = 'PENDING';
  chamou = 0;
  const r1 = await ligar();
  const c1 = await r1.json();
  ok(r1.status === 409, `recusa local: ${r1.status}`);
  ok(c1.code === 'nao_registrado', 'dizendo qual é o problema');
  ok(/Registre-o na Cloud API/i.test(c1.error), 'e o que fazer: ' + c1.error);
  ok(/PENDING/.test(c1.error), 'com o estado que a Meta reporta');
  ok(chamou === 0, 'sem gastar uma chamada na Meta para ouvir a frase opaca');

  console.log('\n=== 2. Registrado, mas a Meta recusa: a lista do que checar ===');
  statusDoNumero = 'CONNECTED';
  recusar = true;
  const r2 = await ligar();
  const c2 = await r2.json();
  ok(r2.status === 409, `a recusa vira 409, e não um 400 cru: ${r2.status}`);
  ok(c2.code === 'calling_indisponivel', 'com um código nosso, não o número da Meta');
  ok(Array.isArray(c2.meta.motivos) && c2.meta.motivos.length === 4,
     `quatro motivos conhecidos: ${(c2.meta.motivos || []).length}`);
  // OS MOTIVOS SÃO OS DA DOCUMENTAÇÃO, e não um palpite:
  // developers.facebook.com/docs/whatsapp/cloud-api/calling
  ok(/webhook "calls"/i.test(c2.meta.motivos[0]),
     'o primeiro é a inscrição no webhook calls, que só se marca no painel da Meta');
  ok(c2.meta.motivos.some(m => /disponibilidade limitada/i.test(m)), 'a liberação limitada da API');
  ok(c2.meta.motivos.some(m => /Business Verification/i.test(m)), 'a verificação do negócio');
  ok(c2.meta.motivos.some(m => /Cloud API/i.test(m)), 'e o número em uso pela Cloud API');
  // Os dois que o servidor confere sozinho não aparecem na lista: eles já
  // passaram para a recusa ter chegado aqui, e repeti-los mandaria o cliente
  // conferir o que já está certo.
  ok(!c2.meta.motivos.some(m => /2\.000|teto diário/i.test(m)),
     'sem repetir o que o servidor já conferiu');

  // O CLIENTE PRECISA SABER QUE NÃO É NOSSO. Sem isto ele passa a tarde
  // procurando defeito no Koonfy por uma porta que a Meta fechou.
  ok(/painel da própria Meta/i.test(c2.meta.nota || ''),
     'e a nota diz que a mesma recusa acontece na Meta: ' + c2.meta.nota);
  ok(/não é uma limitação do Koonfy/i.test(c2.meta.nota || ''), 'sem rodeio');

  // Fica registrado para o Admin ver no Webhook & Logs.
  const log = db.get().webhookLog.find(e => e.type === 'calling_recusado');
  ok(!!log, 'a recusa entra no log do Admin');
  ok(log && log.accountId === acc.id, 'com a conta que tentou');

  console.log('\n=== 2b. TETO DIÁRIO ABAIXO DE 2.000: recusa nossa, e explicada ===');
  // É o requisito que a documentação lista e que quase ninguém sabe — e o mais
  // provável num número recém-conectado, que nasce em TIER_250. Não se resolve
  // clicando: o teto sobe sozinho conforme o número envia com qualidade.
  //
  // Sem esta conferência, a pessoa lia "cannot be enabled" e ia procurar defeito
  // na integração por semanas.
  chamou = 0;
  tetoDoNumero = 'TIER_250';
  const rT = await ligar();
  const cT = await rT.json();
  ok(rT.status === 409, `recusa local: ${rT.status}`);
  ok(cT.code === 'teto_baixo', 'com o código do motivo');
  ok(/2\.000 destinatários únicos/.test(cT.error), 'citando a exigência da Meta');
  ok(/250/.test(cT.error), 'e o teto atual do número: ' + cT.error);
  ok(/sobe sozinho/.test(cT.error), 'dizendo que não há botão para acelerar');
  ok(chamou === 0, 'sem gastar chamada na Meta para ouvir a frase opaca');

  tetoDoNumero = 'TIER_10K';
  const rOk = await ligar();
  ok((await rOk.json()).code === 'calling_indisponivel',
     'com teto suficiente, a conversa segue para a Meta');

  console.log('\n=== 3. Outros erros da Meta NÃO viram essa lista ===');
  // Uma lista de motivos genérica em cima de um erro diferente seria pior que
  // a frase crua: mandaria o cliente conferir quatro coisas que não têm nada a
  // ver com o problema dele.
  wa.setCallingSettings = async () => {
    const e = new Error('Invalid OAuth access token');
    e.status = 401; e.meta = { code: 190 };
    throw e;
  };
  const r3 = await ligar();
  const c3 = await r3.json();
  ok(r3.status !== 409 || c3.code !== 'calling_indisponivel',
     `token inválido segue o próprio caminho: ${r3.status}`);
  ok(!(c3.meta && c3.meta.motivos), 'sem a lista de motivos que não é dele');

  console.log('\n=== 4. E quando dá certo, dá certo ===');
  wa.setCallingSettings = async () => ({ success: true });
  const r4 = await ligar();
  ok(r4.status === 200, `habilitar funciona: ${r4.status}`);

  console.log('\n=== 5. A tela mostra a lista, não a frase seca ===');
  const app_js = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(/m\.motivos \|\| \[\]/.test(app_js), 'o painel lê os motivos');
  ok(!/'A Meta recusou: ' \+ e\.message/.test(app_js),
     'e não repete mais só a frase da Meta, que não tem saída');

  srv.close();
  await encerrar(null, falhas);
})();
