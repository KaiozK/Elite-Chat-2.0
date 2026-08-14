// O CHAT INTEIRO sobre MySQL: conectar o WhatsApp, RECEBER pelo webhook da
// Meta e ENVIAR pelo painel — com um reinício no meio, que é o cenário de
// produção depois de um deploy.
//
// Existe porque uma mensagem chegou da Meta e sumiu: o webhook respondia 200,
// o log registrava "unrouted" e nada aparecia na conversa. Este teste percorre
// o caminho todo para que essa falha não volte em silêncio.
const Module = require('module');
const crypto = require('crypto');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

// ---- MySQL de mentira, persistente entre reinícios --------------------------
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

const WABA = '1362414642618793';
const PHONE_ID = '1132426636626799';
const CLIENTE = '5511988887777';

// A Graph API não é chamada de verdade: guarda o que sairia e devolve o que a
// Meta devolveria. O que se testa aqui é o caminho do Koonfy, não a Meta.
const enviados = [];
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('graph.facebook.com')) {
    const corpo = o && o.body ? JSON.parse(o.body) : null;
    if (corpo && corpo.messaging_product) enviados.push({ url, corpo });
    if (/\/messages$/.test(url)) return resposta({ messages: [{ id: 'wamid.' + crypto.randomBytes(4).toString('hex') }] });
    if (/subscribed_apps/.test(url)) return resposta(o && o.method === 'POST' ? { success: true } : { data: [{ whatsapp_business_api_data: { id: '1' } }] });
    return resposta({ id: WABA, owner_business_info: { id: '2502817489799431', name: 'Elite Chat' },
      display_phone_number: '+55 11 93623-5758', verified_name: 'Loja Teste', quality_rating: 'GREEN' });
  }
  return fetchReal(u, o);
};
function resposta(j) {
  return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), clone() { return this; } };
}

function reiniciar() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('whatsapp-crm') && !k.includes('node_modules')) delete require.cache[k];
  }
}

let servidor = null, porta = 3993;
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

async function subir() {
  reiniciar();
  const express = require('express');
  const db = require(R + 'src/db');
  await db.loadAsync();
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  const broadcast = () => {};
  app.use('/api', require(R + 'src/api')(broadcast));
  app.use('/', require(R + 'src/webhook')(broadcast));
  servidor = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));
  return db;
}
async function derrubar(db) {
  await new Promise(r => servidor.close(r));
  await new Promise(r => setTimeout(r, 300));
  if (db) await db.close();
}

// Uma mensagem recebida, no formato exato que a Meta entrega.
function corpoWebhook(phoneId, texto) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '5511936235758', phone_number_id: phoneId },
      contacts: [{ profile: { name: 'Cliente Teste' }, wa_id: CLIENTE }],
      messages: [{ from: CLIENTE, id: 'wamid.' + crypto.randomBytes(5).toString('hex'),
        timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }]
    } }] }]
  };
}
async function entregarWebhook(db, corpo) {
  const bruto = JSON.stringify(corpo);
  const segredo = db.get().platform.appSecret;
  const headers = { 'Content-Type': 'application/json' };
  if (segredo) {
    headers['X-Hub-Signature-256'] = 'sha256=' +
      crypto.createHmac('sha256', segredo).update(Buffer.from(bruto)).digest('hex');
  }
  const r = await fetch(base() + '/webhook', { method: 'POST', headers, body: bruto });
  await new Promise(res => setTimeout(res, 350));   // o processamento é assíncrono
  return r.status;
}

(async () => {
  console.log('=== 1. Banco novo, admin conecta o WhatsApp ===');
  let db = await subir();
  ok(db.storage.nome === 'mysql', 'o motor é o MySQL');

  let r = await chamar('POST', '/api/login', { user: 'admin', pass: 'admin' });
  ok(!!r.token, 'admin entrou');
  const token = r.token;

  r = await chamar('PUT', '/api/settings', {
    accessToken: 'EAA-token-de-teste', wabaId: WABA, phoneNumberId: PHONE_ID
  }, token);
  ok(r.http === 200, 'conexão manual salva');

  r = await chamar('GET', '/api/wa/status', null, token);
  ok(r.wa && r.wa.phoneNumberId === PHONE_ID, 'o Phone Number ID ficou gravado: ' + (r.wa && r.wa.phoneNumberId));
  ok(r.wa && r.wa.connected === true, 'e a conexão está marcada como ligada');

  console.log('\n=== 2. Mensagem recebida entra na conversa ===');
  let http = await entregarWebhook(db, corpoWebhook(PHONE_ID, 'Oi, vocês entregam hoje?'));
  ok(http === 200, 'a Meta recebe 200');
  r = await chamar('GET', '/api/conversations', null, token);
  const conversa = (r.conversations || []).find(c => c.waId === CLIENTE);
  ok(!!conversa, 'a conversa apareceu na lista');
  r = await chamar('GET', '/api/messages/' + CLIENTE, null, token);
  const recebida = (r.messages || []).find(m => m.direction === 'in');
  ok(!!recebida, 'a mensagem recebida está no chat');
  ok(recebida && recebida.text === 'Oi, vocês entregam hoje?', 'com o texto certo: ' + (recebida && recebida.text));
  ok(!!(r.contact && r.contact.name === 'Cliente Teste'), 'e o contato foi criado com o nome do perfil');

  console.log('\n=== 3. Resposta enviada pelo chat ===');
  enviados.length = 0;
  r = await chamar('POST', '/api/send/text', { to: CLIENTE, text: 'Entregamos sim!' }, token);
  ok(r.http === 200, 'o envio respondeu 200');
  ok(enviados.length === 1, 'uma chamada saiu para a Graph API');
  ok(enviados[0] && enviados[0].url.includes('/' + PHONE_ID + '/messages'), 'para o número certo');
  ok(enviados[0] && enviados[0].corpo.text && enviados[0].corpo.text.body === 'Entregamos sim!', 'com o texto certo');
  r = await chamar('GET', '/api/messages/' + CLIENTE, null, token);
  ok((r.messages || []).some(m => m.direction === 'out' && m.text === 'Entregamos sim!'), 'e ficou gravada no chat');

  console.log('\n=== 4. REINÍCIO: o deploy não pode quebrar o chat ===');
  await derrubar(db);
  db = await subir();
  r = await chamar('POST', '/api/login', { user: 'admin', pass: 'admin' });
  const token2 = r.token;
  r = await chamar('GET', '/api/wa/status', null, token2);
  ok(r.wa && r.wa.phoneNumberId === PHONE_ID, 'a conexão sobreviveu ao reinício');
  r = await chamar('GET', '/api/messages/' + CLIENTE, null, token2);
  ok((r.messages || []).length >= 2, 'o histórico continua lá: ' + (r.messages || []).length + ' mensagem(ns)');

  http = await entregarWebhook(db, corpoWebhook(PHONE_ID, 'Ainda estão aí?'));
  ok(http === 200, 'e uma mensagem nova depois do reinício é aceita');
  r = await chamar('GET', '/api/messages/' + CLIENTE, null, token2);
  ok((r.messages || []).some(m => m.text === 'Ainda estão aí?'), 'e aparece na conversa');

  console.log('\n=== 5. Número desconhecido não vira mensagem fantasma ===');
  const antes = (await chamar('GET', '/api/messages/' + CLIENTE, null, token2)).messages.length;
  http = await entregarWebhook(db, corpoWebhook('999999999999999', 'mensagem de outro numero'));
  ok(http === 200, 'responde 200 (a Meta não deve reenviar)');
  r = await chamar('GET', '/api/messages/' + CLIENTE, null, token2);
  ok(r.messages.length === antes, 'e nada foi gravado na conversa errada');
  const log = db.get().webhookLog || [];
  const semDono = log.find(e => e.type === 'unrouted');
  ok(!!semDono, 'o log registrou "unrouted"');
  ok(!!(semDono && semDono.explicacao), 'com explicação do que faltou');
  ok(!!(semDono && Array.isArray(semDono.cadastrados) && semDono.cadastrados.length), 'e a lista do que está cadastrado');

  await derrubar(db);
  console.log(falhas ? '\nFALHAS: ' + falhas : '\nTODOS OS TESTES PASSARAM');
  process.exit(falhas ? 1 : 0);
})();
