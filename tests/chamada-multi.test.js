// LIGAÇÃO COM VÁRIOS APARELHOS: só um atende, e os outros ficam sabendo.
//
// Existe porque atender no celular estando logado também no computador
// quebrava: o aviso vai para TODAS as sessões da conta, os dois mandavam SDP
// answer diferentes para a mesma chamada, a Meta ficava com um só e o outro
// travava em "conectando" — a ligação não subia em nenhum.
//
// A reserva é decidida no SERVIDOR porque é o único ponto que os aparelhos têm
// em comum. Este teste força a corrida de propósito.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// Banco de mentira: o teste não pode escrever no banco de desenvolvimento.
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

const WABA = '1362414642618793';
const PHONE_ID = '1132426636626799';
const CLIENTE = '5511977776666';

// A Graph API não é chamada de verdade. `atrasoMeta` simula o ida-e-volta com
// a Meta — é justamente durante essa janela que o segundo aparelho tenta
// atender, e é ela que fazia a trava ingênua (marcar DEPOIS) falhar.
let atrasoMeta = 120;
const chamadasAceitas = [];
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('graph.facebook.com')) {
    const corpo = o && o.body ? JSON.parse(o.body) : null;
    if (corpo && corpo.action === 'accept') {
      chamadasAceitas.push(corpo);
      await new Promise(r => setTimeout(r, atrasoMeta));
    }
    if (/subscribed_apps/.test(url)) return resposta({ data: [{ whatsapp_business_api_data: { id: '1' } }] });
    return resposta({ messaging_product: 'whatsapp', calls: [{ id: 'call_x' }], success: true });
  }
  return fetchReal(u, o);
};
function resposta(j) { return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), clone() { return this; } }; }

const avisos = [];
const broadcast = (tipo, dados) => avisos.push({ tipo, dados });

let servidor = null; const porta = 3996;
const chamar = async (metodo, rota, corpo, token) => {
  const r = await fetch('http://127.0.0.1:' + porta + rota, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined
  });
  let j = null; try { j = await r.json(); } catch {}
  return { http: r.status, ...j };
};

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(broadcast));
  servidor = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  console.log('=== Preparo ===');
  let r = await chamar('POST', '/api/login', { user: 'admin', pass: 'admin' });
  const tok = r.token;
  ok(!!tok, 'admin entrou');
  await chamar('PUT', '/api/settings', { accessToken: 'EAA-teste', wabaId: WABA, phoneNumberId: PHONE_ID }, tok);

  const acc = db.get().accounts[0];
  const novaChamada = (id) => {
    acc.calls = acc.calls || [];
    acc.calls = acc.calls.filter(c => c.id !== id);
    acc.calls.push({ id, waId: CLIENTE, direction: 'USER_INITIATED', status: 'ringing', startedAt: Date.now() });
  };

  console.log('\n=== 1. Dois aparelhos atendem AO MESMO TEMPO ===');
  novaChamada('call_1');
  avisos.length = 0; chamadasAceitas.length = 0;
  // sem await entre os dois: é a corrida real, celular e computador juntos
  const [a, b] = await Promise.all([
    chamar('POST', '/api/calls/call_1/accept', { sdp: 'v=0 aparelho-A' }, tok),
    chamar('POST', '/api/calls/call_1/accept', { sdp: 'v=0 aparelho-B' }, tok)
  ]);
  const ganhou = [a, b].filter(x => x.http === 200);
  const perdeu = [a, b].filter(x => x.http === 409);
  ok(ganhou.length === 1, `exatamente UM aparelho atendeu: ${ganhou.length}`);
  ok(perdeu.length === 1, `e o outro recebeu 409: ${perdeu.length}`);
  ok(perdeu[0] && /já foi atendida/i.test(perdeu[0].error || ''), `com motivo legível: "${perdeu[0] && perdeu[0].error}"`);
  // ESTE é o ponto: a Meta só pode receber UM SDP answer para a mesma chamada
  ok(chamadasAceitas.length === 1, `só um SDP foi para a Meta: ${chamadasAceitas.length}`);

  console.log('\n=== 2. Os outros aparelhos são avisados ===');
  const aviso = avisos.filter(x => x.tipo === 'call' && x.dados.kind === 'claimed');
  ok(aviso.length === 1, 'saiu um aviso de "atendida"');
  ok(aviso[0] && aviso[0].dados.call.id === 'call_1', 'para a chamada certa');
  ok(aviso[0] && !!aviso[0].dados.por, `dizendo quem atendeu: "${aviso[0] && aviso[0].dados.por}"`);

  console.log('\n=== 3. Tentar atender depois também é barrado ===');
  const tarde = await chamar('POST', '/api/calls/call_1/accept', { sdp: 'v=0 atrasado' }, tok);
  ok(tarde.http === 409, `409 para quem chega tarde: ${tarde.http}`);
  ok(chamadasAceitas.length === 1, 'e nada novo foi mandado para a Meta');

  console.log('\n=== 4. Se a META recusar, a reserva é liberada ===');
  // Sem liberar, uma falha de rede deixaria a chamada travada para sempre:
  // ninguém mais conseguiria atender aquela ligação.
  novaChamada('call_2');
  chamadasAceitas.length = 0;
  const fetchOk = global.fetch;
  global.fetch = async (u, o) => {
    if (String(u).includes('graph.facebook.com') && o && /"action":"accept"/.test(o.body || '')) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'Meta fora do ar' } }), text: async () => 'erro', clone() { return this; } };
    }
    return fetchOk(u, o);
  };
  const falhou = await chamar('POST', '/api/calls/call_2/accept', { sdp: 'v=0 x' }, tok);
  ok(falhou.http >= 400, `a falha da Meta volta como erro: ${falhou.http}`);
  const c2 = acc.calls.find(c => c.id === 'call_2');
  ok(c2 && !c2.claimedBy, 'a reserva foi liberada, outro aparelho pode tentar');
  global.fetch = fetchOk;
  const segunda = await chamar('POST', '/api/calls/call_2/accept', { sdp: 'v=0 y' }, tok);
  ok(segunda.http === 200, `e a segunda tentativa passa: ${segunda.http}`);

  console.log('\n=== 5. Recusar também avisa os outros ===');
  novaChamada('call_3');
  avisos.length = 0;
  const rec = await chamar('POST', '/api/calls/call_3/reject', {}, tok);
  ok(rec.http === 200, 'a recusa foi aceita');
  const avisoRec = avisos.find(x => x.tipo === 'call' && x.dados.kind === 'claimed');
  ok(!!avisoRec, 'os outros aparelhos são avisados da recusa');
  ok(avisoRec && avisoRec.dados.recusada === true, 'marcada como recusa, não como atendimento');

  console.log('\n=== 6. Atender pela NOTIFICAÇÃO, com o app vindo do segundo plano ===');
  // No celular a ligação chega com o app dormindo: o SO derruba o SSE e o
  // aviso de "está tocando" nunca chega na tela. Ao tocar na notificação, o app
  // precisa remontar a chamada pelo servidor — e para responder o WebRTC ele
  // depende do `sdpOffer`, que o GET /calls esconde de propósito.
  novaChamada('call_4');
  const c4 = acc.calls.find(c => c.id === 'call_4');
  c4.sdpOffer = 'v=0 oferta-do-cliente';
  c4.canal = 'Vendas';

  const lista = await chamar('GET', '/api/calls', null, tok);
  const naLista = (lista.calls || []).find(c => c.id === 'call_4');
  ok(!!naLista && naLista.sdpOffer === undefined, 'GET /calls continua sem devolver o SDP');

  let pend = await chamar('GET', '/api/calls/pending', null, tok);
  ok(pend.call && pend.call.id === 'call_4', `a chamada tocando é recuperada: ${pend.call && pend.call.id}`);
  ok(!!pend.sdpOffer, 'COM o SDP offer, senão não há como atender');
  ok(pend.call && pend.call.canal === 'Vendas', `sabendo por qual número tocou: "${pend.call && pend.call.canal}"`);

  // E o aparelho consegue atender com o que recebeu.
  chamadasAceitas.length = 0;
  const viaNotif = await chamar('POST', '/api/calls/call_4/accept', { sdp: 'v=0 resposta' }, tok);
  ok(viaNotif.http === 200, `atendeu pela notificação: ${viaNotif.http}`);
  ok(chamadasAceitas.length === 1, 'e o SDP chegou à Meta');

  console.log('\n=== 7. O que NÃO dá mais para atender não volta ===');
  // Devolver uma ligação já pega faria o aparelho tocar sozinho por uma
  // chamada que já está acontecendo em outro lugar.
  pend = await chamar('GET', '/api/calls/pending', null, tok);
  ok(!pend.call, 'a que acabou de ser atendida não aparece como pendente');

  novaChamada('call_5');
  const c5 = acc.calls.find(c => c.id === 'call_5');
  c5.sdpOffer = 'v=0 velha';
  c5.startedAt = Date.now() - 5 * 60 * 1000;   // 5 minutos atrás
  pend = await chamar('GET', '/api/calls/pending', null, tok);
  ok(!pend.call, 'uma ligação de 5 minutos atrás também não — a Meta já desistiu');
  await encerrar(servidor, falhas);
})().catch(e => { console.error(e); process.exit(1); });
