// Opt-in / Opt-out — consentimento do contato (Koonfy)
//
// Fonte única de verdade. Consumido pelo webhook (palavra-chave), pelo guard de
// envio da API, pelas campanhas, pelo Flow Builder e pelo Dashboard.
//
// Estados do contato (contact.consent.status):
//   opted_in  → pode receber (padrão de quem fala com a gente)
//   opted_out → NÃO pode receber nada (bloqueado no backend)
//   pending   → ainda não houve sinal de consentimento
const db = require('./db');
const defaults = require('./consent-defaults');

const DEFAULT_KEYWORDS = defaults.DEFAULT_KEYWORDS;

// Origens possíveis de um registro de consentimento
const SOURCES = {
  keyword: 'Palavra-chave do cliente',
  inbound: 'Mensagem recebida',
  flow: 'Automação (Flow Builder)',
  manual: 'Ação manual do atendente',
  webhook: 'Webhook externo',
  import: 'Importação'
};

// Normaliza para comparação: sem acento, sem caixa, sem pontuação nas bordas
function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos (CANCELAR = cancelar)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const defaultConsent = defaults.defaultConsent;
const emptyContactConsent = defaults.emptyContactConsent;

function cfgOf(acc) {
  return (acc.consent && typeof acc.consent === 'object') ? acc.consent : defaultConsent();
}

function stateOf(contact) {
  if (!contact) return emptyContactConsent();
  if (!contact.consent || typeof contact.consent !== 'object') return emptyContactConsent();
  return contact.consent;
}

function statusOf(contact) { return stateOf(contact).status || 'pending'; }
function isOptedOut(contact) { return statusOf(contact) === 'opted_out'; }
function isOptedIn(contact) { return statusOf(contact) === 'opted_in'; }

// ---------- Palavras-chave ----------

// Casa a mensagem do cliente com a lista de palavras. Ignora caixa e acentos.
// Considera match quando a mensagem É a palavra ou a contém como palavra isolada
// (evita que "não quero parar de comprar" derrube o cadastro por engano).
function matchKeyword(list, text) {
  const t = normalize(text);
  if (!t) return null;
  for (const raw of list || []) {
    const k = normalize(raw);
    if (!k) continue;
    if (t === k) return raw;
    if (new RegExp(`(^|\\s)${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(t)) return raw;
  }
  return null;
}

function matchOptOutKeyword(acc, text) { return matchKeyword(cfgOf(acc).keywords, text); }
function matchOptInKeyword(acc, text) { return matchKeyword(cfgOf(acc).optInKeywords, text); }

// ---------- Registro de consentimento ----------

function pushHistory(c, entry) {
  c.history = c.history || [];
  c.history.push(entry);
  if (c.history.length > 100) c.history.shift();
}

function optIn(acc, contact, { source = 'manual', by = null, reason = null } = {}) {
  if (!contact) return null;
  if (!contact.consent) contact.consent = emptyContactConsent();
  const c = contact.consent;
  const was = c.status;
  c.status = 'opted_in';
  c.optInAt = Date.now();
  c.optInSource = source;
  // sai do opt-out (reativação)
  if (was === 'opted_out') c.reactivatedAt = Date.now();
  pushHistory(c, { ts: Date.now(), action: was === 'opted_out' ? 'reactivate' : 'opt_in', source, reason, by });
  db.save();
  return { status: c.status, was };
}

function optOut(acc, contact, { source = 'manual', reason = null, by = null } = {}) {
  if (!contact) return null;
  if (!contact.consent) contact.consent = emptyContactConsent();
  const c = contact.consent;
  const was = c.status;
  c.status = 'opted_out';
  c.optOutAt = Date.now();
  c.optOutSource = source;
  c.optOutReason = reason || null;
  pushHistory(c, { ts: Date.now(), action: 'opt_out', source, reason, by });
  db.save();
  return { status: c.status, was };
}

// Reativação manual (atendente) — mesma coisa que opt-in, com origem explícita
function reactivate(acc, contact, { by = null, reason = null } = {}) {
  return optIn(acc, contact, { source: 'manual', by, reason: reason || 'Reativação manual' });
}

// ---------- Guard de envio ----------

// Regra: contato em opt-out NÃO recebe nada (nem template, nem campanha).
// A mensagem de confirmação do próprio opt-out é enviada internamente, fora
// deste guard (ver sendOptOutConfirmation no webhook).
function canSendTo(acc, contact) {
  if (!contact) return { allowed: true };
  if (!cfgOf(acc).enabled) return { allowed: true };   // módulo desligado = sem bloqueio
  if (isOptedOut(contact)) {
    return {
      allowed: false,
      code: 'opted_out',
      error: 'Este contato solicitou o cancelamento (opt-out) e não pode receber mensagens. Reative o contato em Opt-in & Opt-out para voltar a enviar.'
    };
  }
  return { allowed: true };
}

// ---------- Mensagens (variáveis dinâmicas) ----------

// Interpola {{nome}}, {{telefone}}, {{email}}, {{empresa}}, {{etapa}} e as
// variáveis personalizadas do contato (contact.vars).
function renderMessage(acc, contact, tpl) {
  const map = {
    nome: (contact && contact.name) || '',
    name: (contact && contact.name) || '',
    telefone: contact ? '+' + contact.waId : '',
    phone: contact ? '+' + contact.waId : '',
    email: (contact && contact.email) || '',
    cidade: (contact && contact.city) || '',
    etapa: (contact && contact.stage) || '',
    empresa: acc.name || '',
    ...((contact && contact.vars) || {})
  };
  return String(tpl || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (map[k] !== undefined ? String(map[k]) : m));
}

// Variáveis oferecidas na UI (chips clicáveis)
const VARS = [
  { key: 'nome', label: 'Nome do contato' },
  { key: 'empresa', label: 'Sua empresa' },
  { key: 'telefone', label: 'Telefone' },
  { key: 'email', label: 'E-mail' },
  { key: 'cidade', label: 'Cidade' },
  { key: 'etapa', label: 'Etapa do funil' }
];

// ---------- Histórico de alterações da CONFIGURAÇÃO ----------

function logConfigChange(acc, by, changes) {
  const cfg = cfgOf(acc);
  cfg.history = cfg.history || [];
  cfg.history.unshift({ ts: Date.now(), by: by || 'Sistema', changes });
  if (cfg.history.length > 50) cfg.history.length = 50;
  db.save();
}

// ---------- Métricas (Dashboard) ----------

function metrics(acc, now = Date.now()) {
  const day = 86400000;
  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const startMonth = new Date(now); startMonth.setDate(1); startMonth.setHours(0, 0, 0, 0);
  const yest = +startToday - day;

  let active = 0, out = 0, pending = 0;
  let inToday = 0, outToday = 0, inYest = 0, outYest = 0, inMonth = 0, outMonth = 0;

  for (const c of acc.contacts || []) {
    const s = stateOf(c);
    if (s.status === 'opted_out') out++;
    else if (s.status === 'opted_in') active++;
    else pending++;

    for (const h of s.history || []) {
      const isIn = h.action === 'opt_in' || h.action === 'reactivate';
      const isOut = h.action === 'opt_out';
      if (h.ts >= +startToday) { if (isIn) inToday++; if (isOut) outToday++; }
      else if (h.ts >= yest) { if (isIn) inYest++; if (isOut) outYest++; }
      if (h.ts >= +startMonth) { if (isIn) inMonth++; if (isOut) outMonth++; }
    }
  }

  const netToday = inToday - outToday;
  const netYest = inYest - outYest;
  return {
    active, optedOut: out, pending,
    total: (acc.contacts || []).length,
    optInsToday: inToday, optOutsToday: outToday,
    optInsMonth: inMonth, optOutsMonth: outMonth,
    growthToday: netToday,                                   // crescimento diário (líquido)
    growthMonth: inMonth - outMonth,                         // crescimento mensal (líquido)
    growthTrend: netYest === 0 ? null : Math.round(((netToday - netYest) / Math.abs(netYest)) * 100),
    optOutRate: (acc.contacts || []).length ? Math.round((out / acc.contacts.length) * 100) : 0
  };
}

module.exports = {
  DEFAULT_KEYWORDS, SOURCES, VARS,
  normalize, defaultConsent, emptyContactConsent, cfgOf, stateOf,
  statusOf, isOptedIn, isOptedOut,
  matchKeyword, matchOptOutKeyword, matchOptInKeyword,
  optIn, optOut, reactivate, canSendTo,
  renderMessage, logConfigChange, metrics
};
