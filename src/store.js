const db = require('./db');
const consentDefaults = require('./consent-defaults');

function normalizeWaId(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function findContact(acc, waId) {
  return acc.contacts.find(c => c.waId === waId);
}

// CADASTRO AUTOMÁTICO (ver docs/WEBHOOKS.md)
// O telefone é o identificador principal — nunca há duplicados.
//   • contato novo  → cria com a ETAPA PADRÃO do funil (Opt-in & Opt-out → Cadastro automático)
//   • já existe     → preenche APENAS os campos vazios; nunca sobrescreve dado bom
//                     nem reposiciona quem já está no funil.
// `extra` é opcional: { email, city, vars, source } vindo de webhooks mapeados.
function upsertContact(acc, waId, name, extra) {
  waId = normalizeWaId(waId);
  let c = acc.contacts.find(x => x.waId === waId);
  const e = extra || {};

  if (!c) {
    const cfg = acc.consent || {};
    const stages = acc.stages || [];
    // etapa padrão configurada, se ainda existir no funil; senão a 1ª
    const stage = (cfg.defaultStage && stages.includes(cfg.defaultStage)) ? cfg.defaultStage : (stages[0] || 'Novo');
    c = {
      waId, name: name || waId, phone: waId, tags: [],
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
  acc.messages.push(msg);
  if (acc.messages.length > 20000) acc.messages.splice(0, acc.messages.length - 20000);
  db.save();
  return msg;
}

// Persiste uma mensagem enviada (por envio manual, campanha ou automação).
function storeOutbound(acc, to, content, apiResp) {
  const waId = normalizeWaId(to);
  const contact = upsertContact(acc, waId);
  const id = (apiResp && apiResp.messages && apiResp.messages[0] && apiResp.messages[0].id) || db.genId('local');
  const msg = { id, waId, direction: 'out', timestamp: Date.now(), status: 'accepted', ...content };
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

module.exports = { normalizeWaId, findContact, upsertContact, addMessage, storeOutbound, logEvent };
