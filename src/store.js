const db = require('./db');
const consentDefaults = require('./consent-defaults');

function normalizeWaId(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// Canal "corrente" de um contexto de conta.
// Quando `acc` é um contexto de canal (db.chanCtx), `acc.wa` é o wa DAQUELE
// canal — então basta achar o canal dono desse objeto. Para a conta crua isso
// resolve no canal padrão, mantendo o comportamento antigo.
function defChId(acc) {
  const list = (acc && acc.channels) || [];
  const own = acc && acc.wa && list.find(c => c.wa === acc.wa);
  return (own || list[0] || {}).id || '';
}

// Um contato pertence a UM canal: a mesma pessoa falando com dois números da
// empresa vira duas conversas separadas, como pedido. Quando `chId` não é
// informado, mantém o comportamento antigo (procura em qualquer canal).
function findContact(acc, waId, chId) {
  const ch = chId || defChId(acc);
  const dflt = ((acc.channels || [])[0] || {}).id || '';
  return acc.contacts.find(c => c.waId === waId && (c.chId || dflt) === ch)
    // rede de segurança: contato ainda sem canal carimbado
    || (ch === dflt ? acc.contacts.find(c => c.waId === waId && !c.chId) : undefined);
}

// CADASTRO AUTOMÁTICO (ver docs/WEBHOOKS.md)
// O telefone é o identificador principal — nunca há duplicados.
//   • contato novo  → cria com a ETAPA PADRÃO do funil (Opt-in & Opt-out → Cadastro automático)
//   • já existe     → preenche APENAS os campos vazios; nunca sobrescreve dado bom
//                     nem reposiciona quem já está no funil.
// `extra` é opcional: { email, city, vars, source } vindo de webhooks mapeados.
function upsertContact(acc, waId, name, extra, chId) {
  waId = normalizeWaId(waId);
  const ch = chId || defChId(acc);
  let c = findContact(acc, waId, ch);
  const e = extra || {};

  if (!c) {
    const cfg = acc.consent || {};
    const stages = acc.stages || [];
    // etapa padrão configurada, se ainda existir no funil; senão a 1ª
    const stage = (cfg.defaultStage && stages.includes(cfg.defaultStage)) ? cfg.defaultStage : (stages[0] || 'Novo');
    c = {
      waId, chId: ch, name: name || waId, phone: waId, tags: [],
      stage,
      email: e.email || '', city: e.city || '', vars: { ...(e.vars || {}) },
      notes: '', unread: 0, createdAt: Date.now(), lastMessageAt: Date.now(),
      // janela de 24h / atendimento — preenchidos quando o cliente escrever
      lastInboundAt: null, windowExpiresAt: null,
      attendance: {
        status: 'open', openedAt: Date.now(), closedAt: null,
        closeType: null, closedBy: null, reopenedAt: null, reopenedBy: null
      },
      attendanceHistory: [],
      surveys: [],
      consent: consentDefaults.emptyContactConsent()
    };
    if (e.source && !c.source) c.source = e.source;
    acc.contacts.push(c);
    db.save();
    return c;
  }

  // --- já existe: completa somente o que falta ---
  let touched = false;
  if (!c.chId) { c.chId = ch; touched = true; }
  if (name && (!c.name || c.name === c.waId)) { c.name = name; touched = true; }
  if (e.email && !c.email) { c.email = e.email; touched = true; }
  if (e.city && !c.city) { c.city = e.city; touched = true; }
  if (e.source && !c.source) { c.source = e.source; touched = true; }
  if (e.vars) {
    c.vars = c.vars || {};
    for (const [k, v] of Object.entries(e.vars)) {
      if (v !== undefined && v !== null && v !== '' && !c.vars[k]) { c.vars[k] = v; touched = true; }
    }
  }
  if (touched) db.save();
  return c;
}

function addMessage(acc, msg) {
  if (msg.id && acc.messages.some(m => m.id === msg.id)) return null; // dedupe (retries do webhook)
  if (!msg.chId) msg.chId = defChId(acc);   // toda mensagem carimba o canal
  // Toda mensagem carimba a hora, aconteça o que acontecer. Vários chamadores
  // montam o objeto espalhando conteúdo por cima (`...content`), e um
  // `timestamp: undefined` nesse conteúdo apagava a hora que já estava lá — no
  // chat o balão saía sem horário nenhum.
  if (!Number.isFinite(msg.timestamp) || msg.timestamp <= 0) msg.timestamp = Date.now();
  acc.messages.push(msg);
  if (acc.messages.length > 20000) acc.messages.splice(0, acc.messages.length - 20000);
  db.save();
  return msg;
}

// Persiste uma mensagem enviada (por envio manual, campanha ou automação).
function storeOutbound(acc, to, content, apiResp, chId) {
  const waId = normalizeWaId(to);
  const ch = chId || defChId(acc);
  const contact = upsertContact(acc, waId, undefined, undefined, ch);
  const id = (apiResp && apiResp.messages && apiResp.messages[0] && apiResp.messages[0].id) || db.genId('local');
  const msg = { id, waId, chId: ch, direction: 'out', timestamp: Date.now(), status: 'accepted', ...content };
  addMessage(acc, msg);
  contact.lastMessageAt = msg.timestamp;
  db.save();
  return msg;
}

function logEvent(entry) {
  const data = db.get();
  data.webhookLog.unshift({ ts: Date.now(), ...entry });
  if (data.webhookLog.length > 300) data.webhookLog.length = 300;
  db.save();
}

// ---------------------------------------------------------------------------
// APAGAR UMA CONEXÃO E TUDO QUE É DELA.
//
// Usado quando o cliente cancela uma conexão extra e o período pago termina.
// Não é arquivamento: some mesmo — conversas, mensagens, contatos (com o funil e
// o consentimento, que moram no contato), campanhas e agendamentos daquele
// número. Os outros canais da conta não são tocados.
//
// Devolve o que foi removido, para registrar no log e avisar o cliente.
function purgeChannel(acc, chId) {
  const padrao = defChId(acc);
  const doCanal = o => (o.chId || padrao) === chId;

  const contatos = (acc.contacts || []).filter(doCanal);
  const waIds = new Set(contatos.map(c => c.waId));
  const conta = {
    contacts: contatos.length,
    messages: (acc.messages || []).filter(doCanal).length,
    campaigns: (acc.campaigns || []).filter(doCanal).length,
    schedules: (acc.schedules || []).filter(e => e.contactWaId && waIds.has(e.contactWaId)).length
  };

  acc.contacts = (acc.contacts || []).filter(c => !doCanal(c));
  acc.messages = (acc.messages || []).filter(m => !doCanal(m));
  acc.campaigns = (acc.campaigns || []).filter(c => !doCanal(c));
  acc.schedules = (acc.schedules || []).filter(e => !(e.contactWaId && waIds.has(e.contactWaId)));

  // conversas do chat interno atreladas a esses contatos
  if (acc.chatThreads && typeof acc.chatThreads === 'object') {
    for (const k of Object.keys(acc.chatThreads)) {
      if (waIds.has(String(k).replace(/^wa:/, ''))) delete acc.chatThreads[k];
    }
  }

  acc.channels = (acc.channels || []).filter(c => c.id !== chId);
  db.save();
  return conta;
}

module.exports = {
  normalizeWaId, defChId, findContact, upsertContact, addMessage,
  storeOutbound, logEvent, purgeChannel
};
