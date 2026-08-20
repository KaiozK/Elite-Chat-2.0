// LIGAÇÕES (Calling API): o que o servidor manda para o navegador quando a
// Meta avisa de uma chamada.
//
// Existe porque ligar para o cliente não funcionava. A chamada completava, o
// cliente atendia, e ninguém ouvia nada: o evento `accept` traz a RESPOSTA SDP
// do cliente e o servidor jogava essa resposta fora, repassando só o status. Sem
// a resposta o navegador fica com a oferta local e nunca abre a mídia.
const Module = require('module');
const crypto = require('crypto');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// MySQL de mentira, igual aos outros testes: o que importa aqui é o caminho do
// Koonfy, não o banco.
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
const SDP_OFERTA = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const SDP_RESPOSTA = 'v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n';

const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('graph.facebook.com')) {
    if (/\/messages$/.test(url)) return resposta({ messages: [{ id: 'wamid.x' }] });
    if (/subscribed_apps/.test(url)) return resposta({ data: [{ whatsapp_business_api_data: { id: '1' } }] });
    return resposta({ id: WABA, display_phone_number: '+55 11 93623-5758', verified_name: 'Loja Teste' });
  }
  return fetchReal(u, o);
};
function resposta(j) { return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), clone() { return this; } }; }

// Tudo que o servidor empurraria para o navegador por SSE.
const avisos = [];
const broadcast = (tipo, dados) => avisos.push({ tipo, dados });
const ultimaChamada = () => [...avisos].reverse().find(a => a.tipo === 'call');

let servidor = null; const porta = 3994;
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

// Um evento do campo "calls", no formato que a Meta entrega.
function corpoChamada(ev) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: WABA, changes: [{ field: 'calls', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '5511936235758', phone_number_id: PHONE_ID },
      contacts: [{ profile: { name: 'Cliente Teste' }, wa_id: CLIENTE }],
      calls: [ev]
    } }] }]
  };
}
async function entregar(db, corpo) {
  const bruto = JSON.stringify(corpo);
  const segredo = db.get().platform.appSecret;
  const headers = { 'Content-Type': 'application/json' };
  if (segredo) {
    headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', segredo).update(Buffer.from(bruto)).digest('hex');
  }
  const r = await fetch(base() + '/webhook', { method: 'POST', headers, body: bruto });
  await new Promise(res => setTimeout(res, 350));
  return r.status;
}

(async () => {
  const express = require('express');
  const db = require(R + 'src/db');
  await db.loadAsync();
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/api', require(R + 'src/api')(broadcast));
  app.use('/', require(R + 'src/webhook')(broadcast));
  servidor = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  console.log('=== Preparo: WhatsApp conectado ===');
  let r = await chamar('POST', '/api/adm/login', { user: 'admin', pass: 'admin' });
  const token = r.token;
  ok(!!token, 'admin entrou');
  r = await chamar('PUT', '/api/settings', { accessToken: 'EAA-teste', wabaId: WABA, phoneNumberId: PHONE_ID }, token);
  ok(r.http === 200, 'conexão salva');

  console.log('\n=== 1. Cliente liga para nós (o navegador precisa da OFERTA) ===');
  avisos.length = 0;
  let http = await entregar(db, corpoChamada({
    id: 'call_entrada_1', from: CLIENTE, to: '5511936235758',
    event: 'connect', direction: 'USER_INITIATED',
    timestamp: String(Math.floor(Date.now() / 1000)),
    session: { sdp_type: 'offer', sdp: SDP_OFERTA }
  }));
  ok(http === 200, 'a Meta recebe 200');
  let a = ultimaChamada();
  ok(!!a, 'o navegador foi avisado');
  ok(a && a.dados.kind === 'incoming', 'como chamada RECEBIDA: ' + (a && a.dados.kind));
  ok(a && a.dados.sdpOffer === SDP_OFERTA, 'com a oferta SDP para o navegador responder');
  ok(a && a.dados.sdpType === 'offer', 'marcada como oferta: ' + (a && a.dados.sdpType));

  console.log('\n=== 2. Nós ligamos e o cliente atende (o navegador precisa da RESPOSTA) ===');
  avisos.length = 0;
  http = await entregar(db, corpoChamada({
    id: 'call_saida_1', from: '5511936235758', to: CLIENTE,
    event: 'connect', direction: 'BUSINESS_INITIATED',
    timestamp: String(Math.floor(Date.now() / 1000))
  }));
  ok(http === 200, 'o connect da nossa ligação é aceito');
  a = ultimaChamada();
  ok(a && a.dados.kind === 'update', 'não abre tela de chamada recebida: ' + (a && a.dados.kind));

  avisos.length = 0;
  http = await entregar(db, corpoChamada({
    id: 'call_saida_1', from: '5511936235758', to: CLIENTE,
    event: 'accept', direction: 'BUSINESS_INITIATED',
    timestamp: String(Math.floor(Date.now() / 1000)),
    session: { sdp_type: 'answer', sdp: SDP_RESPOSTA }
  }));
  ok(http === 200, 'o accept é aceito');
  a = ultimaChamada();
  ok(!!a, 'o navegador foi avisado do atendimento');
  // ESTE é o teste que falhava antes da correção
  ok(a && a.dados.sdp === SDP_RESPOSTA, 'a RESPOSTA SDP do cliente chegou ao navegador');
  ok(a && a.dados.sdpType === 'answer', 'marcada como resposta: ' + (a && a.dados.sdpType));
  ok(a && a.dados.call.status === 'accepted', 'e o status vira "accepted": ' + (a && a.dados.call.status));

  console.log('\n=== 3. Encerrada: entra no histórico da conversa ===');
  avisos.length = 0;
  http = await entregar(db, corpoChamada({
    id: 'call_saida_1', from: '5511936235758', to: CLIENTE,
    event: 'terminate', direction: 'BUSINESS_INITIATED', status: 'COMPLETED',
    timestamp: String(Math.floor(Date.now() / 1000)), duration: 42
  }));
  ok(http === 200, 'o terminate é aceito');
  a = ultimaChamada();
  ok(a && a.dados.kind === 'terminate', 'o navegador fecha a tela de chamada');
  r = await chamar('GET', '/api/messages/' + CLIENTE, null, token);
  const reg = (r.messages || []).find(m => m.type === 'call');
  ok(!!reg, 'a ligação virou registro na conversa');
  ok(reg && reg.timestamp > 0, 'com hora carimbada: ' + (reg && reg.timestamp));

  await new Promise(res => servidor.close(res));
  await encerrar(null, falhas);
})().catch(e => { console.error(e); process.exit(1); });
