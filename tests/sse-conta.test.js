// ============================================================================
// O TOQUE DE LIGAÇÃO QUE VINHA DA CONTA DE OUTRA PESSOA
//
// Relato: "começou do nada o som de ligação sem ter ligação no telefone" — e,
// logo depois, "a ligação neste número do WhatsApp nem está habilitado".
//
// As duas frases juntas dizem tudo: a chamada era REAL, mas era de outra
// conta. O `broadcast` do server.js tinha a exceção `!c.isAdmin` — o admin
// recebia o fluxo ao vivo da plataforma inteira. Como o app não filtra o que
// chega pelo SSE (ele toca, notifica, abre tela), a ligação de qualquer
// cliente fazia o aparelho do dono da plataforma tocar.
//
// O mesmo furo entregava a ele CADA MENSAGEM de CADA conta, com nome do
// contato e texto, como notificação — o que também explica a outra metade do
// relato: as notificações que ele via no computador não eram push da conta
// dele, eram o vazamento das outras contas chegando pelo SSE do painel aberto.
//
// A segunda metade do arquivo cobre o outro caminho que faz tocar sem ligação:
// a Meta REENTREGA webhook, e um `connect` repetido ressuscitava uma chamada
// já encerrada.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');
const crypto = require('crypto');

// ---- Harness do webhook, igual ao de calls.test.js ----
const WABA = '1362414642618793';
const PHONE_ID = '1132426636626799';
const CLIENTE = '5511988887777';
const SDP_OFERTA = 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('graph.facebook.com')) {
    if (/\/messages$/.test(url)) return resp({ messages: [{ id: 'wamid.x' }] });
    if (/subscribed_apps/.test(url)) return resp({ data: [{ whatsapp_business_api_data: { id: '1' } }] });
    return resp({ id: WABA, display_phone_number: '+55 11 93623-5758', verified_name: 'Loja Teste' });
  }
  return fetchReal(u, o);
};
function resp(j) { return { ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j), clone() { return this; } }; }

const avisos = [];
const broadcast = (tipo, dados) => avisos.push({ tipo, dados });
const chamadasIncoming = () => avisos.filter(a => a.tipo === 'call' && a.dados.kind === 'incoming').length;

const porta = 3992;
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
function corpoChamada(ev) {
  return { object: 'whatsapp_business_account', entry: [{ id: WABA, changes: [{ field: 'calls', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '5511936235758', phone_number_id: PHONE_ID },
    contacts: [{ profile: { name: 'Cliente Teste' }, wa_id: CLIENTE }],
    calls: [ev]
  } }] }] };
}
async function entregar(db, corpo) {
  const bruto = JSON.stringify(corpo);
  const segredo = db.get().platform.appSecret;
  const headers = { 'Content-Type': 'application/json' };
  if (segredo) headers['X-Hub-Signature-256'] = 'sha256=' + crypto.createHmac('sha256', segredo).update(Buffer.from(bruto)).digest('hex');
  const r = await fetch(base() + '/webhook', { method: 'POST', headers, body: bruto });
  await new Promise(res => setTimeout(res, 350));
  return r.status;
}
const agora = () => String(Math.floor(Date.now() / 1000));

(async () => {
  const sse = require(R + 'src/sse');

  const dono  = { accountId: 'acc_dono',  isAdmin: false };
  const admin = { accountId: 'acc_admin', isAdmin: true };
  const daOutra = { accountId: 'acc_dono' };   // evento nascido na conta do cliente

  console.log('=== 1. A ligação de um cliente NÃO toca no aparelho do admin ===');
  ok(sse.entrega(dono, 'call', daOutra), 'o dono da conta recebe a chamada dele');
  ok(!sse.entrega(admin, 'call', daOutra), 'e o admin não recebe a chamada de outra conta');

  console.log('\n=== 2. Nem as mensagens, nem o dinheiro das outras contas ===');
  // Este é o vazamento: o payload de `message` leva nome do contato e texto,
  // e o app transforma isso em notificação do sistema no aparelho do admin.
  for (const ev of ['message', 'attendance', 'commission', 'wallet', 'reminder', 'assign']) {
    ok(!sse.entrega(admin, ev, daOutra), `${ev} de outra conta não atravessa`);
  }

  console.log('\n=== 3. O que o painel do admin realmente usa continua chegando ===');
  // `admEpPaint` é a única tela do admin que se alimenta de evento de outra
  // conta. Fechar tudo quebraria o painel de Pagamentos da plataforma.
  ok(sse.entrega(admin, 'pagamentos', daOutra), 'pagamentos atravessa, que é o que o painel repinta');
  const app = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(/es\.addEventListener\('pagamentos'[\s\S]{0,700}state\.view === 'admin'/.test(app),
     'e é mesmo o painel do admin que escuta esse evento — a exceção tem uma razão verificável');

  console.log('\n=== 4. O resto das regras continua de pé ===');
  ok(sse.entrega(dono, 'message', daOutra), 'a conta dona recebe o que é dela');
  ok(sse.entrega(dono, 'hello', {}), 'evento sem dono vai para todos');
  const espectador = { accountId: 'acc_x', campanha: 'cmp1' };
  ok(sse.entrega(espectador, 'campaign', { id: 'cmp1' }), 'o link público ouve a campanha dele');
  ok(!sse.entrega(espectador, 'campaign', { id: 'cmp2' }), 'e só a dele');
  ok(!sse.entrega(espectador, 'message', { accountId: 'acc_x' }),
     'e nada mais da conta, que não é o que o link concede');

  console.log('\n=== 5. server.js usa o módulo, e não uma cópia da regra ===');
  const srv = fs.readFileSync(R + 'server.js', 'utf8');
  ok(/if \(!sse\.entrega\(c, event, data\)\) continue;/.test(srv), 'o broadcast pergunta ao módulo');
  ok(!/!c\.isAdmin/.test(srv), 'e a exceção antiga não sobrou em lugar nenhum');

  console.log('\n=== 6. O `connect` reentregue não ressuscita uma chamada ===');
  // A Meta reentrega webhook quando a resposta não é 200 no prazo dela. O
  // mesmo `connect` chegava de novo, `rec.status` voltava para 'ringing' numa
  // chamada já encerrada e o `incoming` era reemitido: todos os aparelhos da
  // conta tocando por uma ligação que já acabou.
  const wh = fs.readFileSync(R + 'src/webhook.js', 'utf8');
  const bloco = wh.slice(wh.indexOf("if (ev.event === 'connect')"), wh.indexOf("} else if (ev.event === 'terminate')"));
  ok(/rec\.endedAt \|\| ESTADOS_FIM\.includes/.test(bloco), 'chamada já encerrada é ignorada');
  ok(/if \(rec\.avisadoEm\)/.test(bloco), 'e a reentrega do mesmo connect também');
  ok(/rec\.avisadoEm = Date\.now\(\);/.test(bloco), 'marcando que já avisou uma vez');
  ok(/Date\.now\(\) - tsEv > MAX_IDADE_CONNECT/.test(bloco),
     'e um connect velho não toca — é o que sobra quando o terminate nunca chega');
  ok(bloco.indexOf('continue;') < bloco.indexOf("rec.status = 'ringing'"),
     'as guardas saem ANTES de mexer no registro: ignorar é não tocar em nada');

  console.log('\n=== 7. O MESMO connect, EXECUTADO de verdade, só toca uma vez ===');
  // As verificações acima leem o código; esta ENTREGA o webhook no servidor e
  // conta quantos `incoming` saíram. É a diferença entre "a guarda está
  // escrita" e "a guarda funciona".
  const express = require('express');
  const dbm = require(R + 'src/db');
  await dbm.loadAsync();
  const srvApp = express();
  srvApp.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  srvApp.use('/api', require(R + 'src/api')(broadcast));
  srvApp.use('/', require(R + 'src/webhook')(broadcast));
  const servidor = srvApp.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const ent = await chamar('POST', '/api/adm/login', { user: 'admin', pass: 'admin' });
  await chamar('PUT', '/api/settings', { accessToken: 'EAA-teste', wabaId: WABA, phoneNumberId: PHONE_ID }, ent.token);

  const connect = id => corpoChamada({
    id, from: CLIENTE, to: '5511936235758', event: 'connect', direction: 'USER_INITIATED',
    timestamp: agora(), session: { sdp_type: 'offer', sdp: SDP_OFERTA }
  });

  avisos.length = 0;
  await entregar(dbm, connect('call_dup_1'));
  ok(chamadasIncoming() === 1, 'a ligação de verdade toca: ' + chamadasIncoming() + ' incoming');

  await entregar(dbm, connect('call_dup_1'));
  ok(chamadasIncoming() === 1, 'a reentrega do mesmo connect NÃO toca de novo: ' + chamadasIncoming());

  console.log('\n=== 8. Depois de encerrada, nada a ressuscita ===');
  avisos.length = 0;
  await entregar(dbm, corpoChamada({
    id: 'call_dup_2', from: CLIENTE, to: '5511936235758', event: 'connect',
    direction: 'USER_INITIATED', timestamp: agora(), session: { sdp_type: 'offer', sdp: SDP_OFERTA }
  }));
  ok(chamadasIncoming() === 1, 'toca uma vez');
  await entregar(dbm, corpoChamada({
    id: 'call_dup_2', from: CLIENTE, to: '5511936235758', event: 'terminate',
    status: 'completed', duration: 12, timestamp: agora()
  }));
  avisos.length = 0;
  await entregar(dbm, corpoChamada({
    id: 'call_dup_2', from: CLIENTE, to: '5511936235758', event: 'connect',
    direction: 'USER_INITIATED', timestamp: agora(), session: { sdp_type: 'offer', sdp: SDP_OFERTA }
  }));
  ok(chamadasIncoming() === 0, 'e o connect que chega DEPOIS do terminate não toca: ' + chamadasIncoming());

  console.log('\n=== 9. Um connect velho não toca (o caso sem terminate) ===');
  avisos.length = 0;
  await entregar(dbm, corpoChamada({
    id: 'call_velho_1', from: CLIENTE, to: '5511936235758', event: 'connect',
    direction: 'USER_INITIATED',
    timestamp: String(Math.floor((Date.now() - 5 * 60000) / 1000)),   // 5 min atrás
    session: { sdp_type: 'offer', sdp: SDP_OFERTA }
  }));
  ok(chamadasIncoming() === 0, 'ninguém está esperando no telefone há 5 minutos: ' + chamadasIncoming());

  servidor.close();
  await encerrar(null, falhas);
})();
