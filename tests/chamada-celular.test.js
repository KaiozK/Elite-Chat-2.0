// A LIGAÇÃO PRECISA CHEGAR NO CELULAR — que é onde o app quase nunca está aberto.
//
// No computador o painel fica aberto o dia inteiro: o SSE já está conectado
// quando o telefone toca, e a tela aparece sozinha. No celular é o contrário —
// a partida fria é a regra. Existem quatro caminhos até a tela de chamada, e
// três deles dependem de dados que só o servidor tem:
//
//   1. SSE ao vivo                        (só com o app aberto)
//   2. volta do segundo plano             → GET /calls/pending
//   3. toque na notificação, app fechado  → o push precisa levar o `callId`
//   4. abrir pelo ícone com o telefone tocando → GET /calls/pending
//
// Este teste cobre o que o servidor precisa entregar para os caminhos 2, 3 e 4
// existirem, e a regra que impede a mesma ligação de tocar em dois lugares
// depois de atendida.
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
const cx = { query: async (s, p) => executar(s, p), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { query: async (s, p) => executar(s, p), getConnection: async () => cx, end: async () => {} };
const origLoad = Module._load;
Module._load = function (p) { if (p === 'mysql2/promise') return { createPool: () => pool }; return origLoad.apply(this, arguments); };
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

const db = require(R + 'src/db');
const BASE = 'http://127.0.0.1:3983';

// O QUE SAI COMO NOTIFICAÇÃO. O push é o único caminho que existe com o app
// fechado, e é ele que carrega (ou não) o que o toque precisa para atender.
const avisos = [];
const push = require(R + 'src/push');
push.sendToAccount = async (acc, tipo, payload) => { avisos.push({ tipo, payload }); return 1; };
const pushNative = require(R + 'src/pushnative');
pushNative.sendToAccount = async () => 0;

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());

  // O MESMO CÓDIGO DO SERVIDOR, e não uma cópia dele: a tradução de evento em
  // notificação mora em src/avisospush.js justamente para poder ser conferida
  // aqui. Um teste que reimplementa o que deveria conferir passa mesmo quando
  // o código de verdade quebra.
  const { avisoDoEvento } = require(R + 'src/avisospush');
  const clients = new Set();
  const broadcast = (event, data) => {
    const aviso = avisoDoEvento(event, data);
    if (!aviso) return;
    const conta = db.findAccount(data.accountId);
    if (conta) push.sendToAccount(conta, aviso.type, aviso.payload);
  };

  app.use('/api', require(R + 'src/api')(broadcast, clients));
  const srv = app.listen(3983);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  const acc = db.get().accounts.find(a => a.isAdmin) || db.get().accounts[0];
  acc.contacts = [{ waId: '5511988880001', name: 'Roberto Alves', vars: {} }];
  acc.calls = [];
  db.save();

  const tocando = (id, quando) => {
    acc.calls.push({
      id, waId: '5511988880001', direction: 'USER_INITIATED', status: 'ringing',
      startedAt: quando || Date.now(), endedAt: null, duration: null,
      sdpOffer: 'v=0 oferta-do-cliente', canal: 'WhatsApp principal'
    });
    db.save();
  };

  console.log('=== 1. Abrir o app com o telefone tocando ===');
  // É o caminho do celular: o evento ao vivo se perdeu porque o app estava
  // fechado, e a tela só existe se o servidor souber contar o que está tocando.
  tocando('call_1');
  const pend = await (await fetch(BASE + '/api/calls/pending', { headers: aut })).json();
  ok(pend.call && pend.call.id === 'call_1', `a ligação que está tocando é recuperada: ${pend.call && pend.call.id}`);
  ok(!!pend.sdpOffer, 'com o SDP offer — sem ele não há como atender');
  ok(pend.call.name === 'Roberto Alves', 'e com o nome do contato, não só o número');
  ok(pend.call.canal === 'WhatsApp principal', 'sabendo por qual número tocou');

  console.log('\n=== 2. A notificação leva o id da chamada ===');
  // Sem `callId`, tanto o Service Worker quanto o app tratam o aviso como uma
  // notificação comum: o toque abre a lista de conversas em vez de atender.
  avisos.length = 0;
  broadcast('call', { accountId: acc.id, kind: 'incoming', call: { id: 'call_1', waId: '5511988880001', name: 'Roberto Alves' } });
  const aviso = avisos.find(a => a.tipo === 'call');
  ok(!!aviso, 'o aviso de chamada sai');
  ok(aviso && aviso.payload.data.callId === 'call_1', `com o id dentro: ${aviso && aviso.payload.data.callId}`);
  ok(aviso && aviso.payload.data.type === 'call', 'e marcado como chamada');
  ok(aviso && aviso.payload.tag === 'call:call_1', 'com a etiqueta da chamada, que é o que permite apagá-la depois');
  ok(aviso && aviso.payload.requireInteraction === true, 'e fixo na tela: uma ligação não pode sumir sozinha');

  console.log('\n=== 3. Atendida num aparelho, o aviso some no outro ===');
  // Era o defeito antigo: o computador atendia e o celular seguia tocando na
  // tela de bloqueio, por uma ligação que já estava acontecendo.
  avisos.length = 0;
  broadcast('call', { accountId: acc.id, kind: 'claimed', call: { id: 'call_1', waId: '5511988880001' }, por: 'Computador' });
  const fecha = avisos.find(a => a.payload && a.payload.close);
  ok(!!fecha, 'sai um push de FECHAMENTO');
  ok(fecha && fecha.payload.tag === 'call:call_1', 'apontando para a etiqueta daquela chamada');
  ok(fecha && fecha.payload.data.type === 'call_end', 'e marcado como fechamento, não como aviso novo');
  ok(fecha && !fecha.payload.title, 'sem título: ele não mostra nada, ele apaga');

  console.log('\n=== 4. E encerrar também apaga ===');
  avisos.length = 0;
  broadcast('call', { accountId: acc.id, kind: 'terminate', call: { id: 'call_1', waId: '5511988880001', status: 'ended' } });
  ok(avisos.some(a => a.payload && a.payload.close), 'o fim da ligação também manda apagar o aviso');

  console.log('\n=== 5. O que não dá mais para atender não volta ===');
  // Recuperar uma ligação já pega faria o celular tocar sozinho por uma chamada
  // que está acontecendo em outro lugar.
  acc.calls = [];
  tocando('call_2');
  const c2 = acc.calls.find(c => c.id === 'call_2');
  c2.claimedBy = 'Computador'; c2.claimedAt = Date.now();
  db.save();
  const pego = await (await fetch(BASE + '/api/calls/pending', { headers: aut })).json();
  ok(!pego.call, 'ligação já atendida em outro aparelho não é recuperada');

  acc.calls = [];
  tocando('call_3', Date.now() - 5 * 60 * 1000);
  const velha = await (await fetch(BASE + '/api/calls/pending', { headers: aut })).json();
  ok(!velha.call, 'e uma de cinco minutos atrás também não — a Meta já desistiu');

  console.log('\n=== 6. Tocar na notificação ABRE a tela, não atende ===');
  // ERA O BUG RELATADO: tocar na notificação da ligação levava para a tela
  // principal em vez da tela da chamada.
  //
  // A causa: o toque chamava `answerCall()`, que pede o MICROFONE. Num celular
  // que acabou de abrir o app essa permissão quase sempre ainda não foi dada —
  // então o que aparecia era o pedido de permissão, e se ela demorasse ou
  // fosse negada, `endCallUI('Falha ao conectar')` fechava tudo e deixava a
  // pessoa no dashboard, com o telefone ainda tocando do outro lado.
  //
  // Um toque numa notificação não é consentimento para abrir o microfone: é
  // intenção de VER quem está ligando.
  const fs = require('fs');
  const tela = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const abre = tela.slice(tela.indexOf('function notifOpenFromData'), tela.indexOf('function notifOpenFromData') + 1400);
  ok(/abrirChamadaPorId\(data\.callId\)/.test(abre),
     'o toque na notificação abre a tela da chamada');
  ok(!/atenderChamadaPorId\(data\.callId\)/.test(abre),
     'e NÃO atende sozinho — abrir o microfone é sempre gesto explícito');
  ok(/data\.action === 'reject'/.test(abre),
     'o botão Recusar da notificação continua recusando na hora, sem abrir tela');

  // ATENDER continua existindo, e agora só é alcançado pelo botão Atender.
  ok(/async function atenderChamadaPorId/.test(tela) && /async function abrirChamadaPorId/.test(tela),
     'abrir e atender são funções separadas');
  const atende = tela.slice(tela.indexOf('async function atenderChamadaPorId'), tela.indexOf('async function atenderChamadaPorId') + 320);
  ok(/await abrirChamadaPorId\(id\)/.test(atende),
     'atender passa por abrir: a tela aparece antes de o microfone ser pedido');

  console.log('\n=== 7. A chamada ERRADA não é atendida ===');
  // Com `callUI` preenchido e um id DIFERENTE, o código antigo não fazia nada —
  // nem buscava, nem avisava — e caía direto no `answerCall()`, atendendo a
  // chamada que estava na tela em vez da que a pessoa tocou.
  const abrir = tela.slice(tela.indexOf('async function abrirChamadaPorId'), tela.indexOf('async function abrirChamadaPorId') + 1200);
  ok(/callUI && \(!id \|\| callUI\.id === id\)/.test(abrir),
     'só reusa o que está na tela quando é a MESMA chamada');
  ok(/await recuperarChamadaPendente\(true\)/.test(abrir),
     'sendo outra, busca a que está tocando de verdade');
  ok(/callUI\.min = false/.test(abrir),
     'e desminimiza: uma chamada em pastilha era o estado em que tocar na notificação parecia não fazer nada');

  console.log('\n=== 8. Uma busca de pendente por vez ===');
  // `if (callUI) return` era conferido ANTES do await, e a partida fria chamava
  // por dois caminhos quase juntos: duas buscas, dois `callUI`, duas pinturas e
  // duas campainhas sobrepostas — a lentidão que se sente ao abrir com o
  // telefone tocando.
  const rec = tela.slice(tela.indexOf('async function recuperarChamadaPendente'), tela.indexOf('async function recuperarChamadaPendente') + 1400);
  ok(/let buscandoPendente = null;/.test(tela), 'existe uma trava de busca em voo');
  ok(/if \(buscandoPendente\) return buscandoPendente;/.test(rec),
     'a segunda chamada espera a primeira em vez de abrir outra busca');
  ok((rec.match(/if \(callUI\) return callUI;/g) || []).length >= 2,
     'e o estado é reconferido DEPOIS do await — o SSE pode ter entregue a mesma chamada no meio');

  // E o arranque não dispara os dois caminhos de uma vez.
  ok(/if \(!abrirChamadaPelaUrl\(\)\) recuperarChamadaPendente\(true\);/.test(tela),
     'aberto pela notificação OU pelo ícone, nunca os dois ao mesmo tempo');
  ok(!/atenderPelaUrl\(\)/.test(tela),
     'e a partida fria não atende mais às cegas');

  console.log('\n=== 9. O Service Worker foca a aba certa ===');
  const sw = fs.readFileSync(R + 'public/app/sw.js', 'utf8');
  ok(/doApp\.find\(c => c\.focused\)/.test(sw),
     'prefere a aba em foco — mandar o aviso para uma de fundo tira a pessoa de onde ela estava');
  ok(/visibilityState === .visible./.test(sw), 'depois uma visível');
  ok(/koonfy-v12/.test(sw), 'e a versão do cache subiu, senão o navegador serve o SW antigo');

  srv.close();
  await encerrar(srv, falhas);
})();
