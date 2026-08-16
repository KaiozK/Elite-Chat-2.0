// REABRIR O ATENDIMENTO NÃO PODE DISPARAR A PESQUISA DE SATISFAÇÃO.
//
// O fechamento automático media a inatividade só por `lastInboundAt` — a última
// mensagem RECEBIDA do cliente. Uma conversa cuja última mensagem era antiga
// fechava sozinha; o atendente reabria; a varredura seguinte via o mesmo
// `lastInboundAt` vencido e finalizava de novo NA HORA, disparando a pesquisa
// outra vez. Na prática, reabrir não servia para nada e o cliente levava um
// pedido de nota do nada.
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

// O WhatsApp é simulado: o que interessa é QUANTAS vezes a pesquisa sai.
const enviadas = [];
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  if (String(u).includes('graph.facebook.com')) {
    const corpo = o && o.body ? JSON.parse(o.body) : {};
    if (corpo.type === 'interactive') enviadas.push(corpo);
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.' + enviadas.length }] }), text: async () => '{}', clone() { return this; } };
  }
  return fetchReal(u, o);
};

const db = require(R + 'src/db');
const session = require(R + 'src/session');
const survey = require(R + 'src/survey');

const MIN = 60000;

(async () => {
  await db.loadAsync();
  const acc = db.findAdminAccount();
  acc.channels[0].wa = { connected: true, accessToken: 'x', phoneNumberId: '1', wabaId: '1' };
  // A pesquisa vive em acc.service.survey (e não em acc.survey).
  acc.service = {
    autoClose: { enabled: true, minutes: 30 },
    survey: {
      enabled: true,
      message: 'Como foi o atendimento?',
      footer: '', listButton: 'Avaliar',
      notes: [{ id: 'n1', label: 'Ótimo' }, { id: 'n2', label: 'Ruim' }]
    }
  };
  session.onFinished(survey.makeOnFinished(null));

  const contato = () => {
    acc.contacts = [{
      waId: '5511900001111', chId: acc.channels[0].id, name: 'Cliente', tags: [], vars: {},
      lastInboundAt: Date.now() - 90 * MIN,          // última mensagem dele: 1h30 atrás
      windowExpiresAt: Date.now() + 20 * 3600000,    // janela de 24h ainda aberta
      attendance: { status: 'open', openedAt: Date.now() - 120 * MIN, closedAt: null, closeType: null, closedBy: null, reopenedAt: null, reopenedBy: null },
      attendanceHistory: [], surveys: []
    }];
    return acc.contacts[0];
  };

  console.log('=== 1. A conversa parada fecha sozinha e a pesquisa sai (uma vez) ===');
  let c = contato();
  enviadas.length = 0;
  session.autoCloseSweep(null);
  await new Promise(r => setTimeout(r, 80));
  ok(c.attendance.status === 'finished', 'fechou por inatividade: ' + c.attendance.status);
  ok(enviadas.length === 1, `a pesquisa saiu uma vez: ${enviadas.length}`);

  console.log('\n=== 2. REABRIR e varrer de novo NÃO manda outra pesquisa ===');
  // Este é o defeito relatado: reabrir e a pesquisa ir junto.
  enviadas.length = 0;
  session.reopen(acc, c, 'Atendente');
  ok(c.attendance.status === 'open', 'reabriu: ' + c.attendance.status);
  ok(!c.surveyPending, 'e a pesquisa pendente do ciclo anterior foi encerrada');

  session.autoCloseSweep(null);
  await new Promise(r => setTimeout(r, 80));
  ok(c.attendance.status === 'open', `continua ABERTO depois da varredura: ${c.attendance.status}`);
  ok(enviadas.length === 0, `nenhuma pesquisa nova: ${enviadas.length}`);

  console.log('\n=== 3. Depois do tempo, contado da REABERTURA, fecha de novo ===');
  // Reabrir zera o relógio, não o desliga.
  c.attendance.reopenedAt = Date.now() - 45 * MIN;
  c.attendance.openedAt = Date.now() - 45 * MIN;
  enviadas.length = 0;
  session.autoCloseSweep(null);
  await new Promise(r => setTimeout(r, 80));
  ok(c.attendance.status === 'finished', `fechou por inatividade real: ${c.attendance.status}`);
  ok(enviadas.length === 1, `e aí sim a pesquisa saiu: ${enviadas.length}`);

  console.log('\n=== 4. Pesquisa AGUARDANDO resposta não é repetida ===');
  // Qualquer caminho que finalize de novo cai nesta trava.
  c.attendance.status = 'open';
  enviadas.length = 0;
  session.finish(acc, c, { type: 'manual', by: 'Atendente' });
  await new Promise(r => setTimeout(r, 80));
  ok(enviadas.length === 0, `com uma pesquisa pendente, não manda outra: ${enviadas.length}`);

  console.log('\n=== 5. Respondida a nota, um novo ciclo pode pedir de novo ===');
  survey.handleReply(acc, c, 'survey_n1', 'Ótimo');
  ok(!c.surveyPending, 'a resposta encerrou a pendência');
  session.reopen(acc, c, 'Atendente');
  c.attendance.reopenedAt = Date.now() - 45 * MIN;
  c.attendance.openedAt = Date.now() - 45 * MIN;
  c.lastInboundAt = Date.now() - 45 * MIN;
  enviadas.length = 0;
  session.autoCloseSweep(null);
  await new Promise(r => setTimeout(r, 80));
  ok(enviadas.length === 1, `novo atendimento, nova pesquisa: ${enviadas.length}`);

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exitCode = falhas ? 1 : 0;
  setTimeout(() => process.exit(falhas ? 1 : 0), 50).unref();
})().catch(e => { console.error(e); process.exit(1); });
