// Atendentes, Permissões, Presença e Logs — EliteChat
//
// Antes deste módulo, `acc.team[]` guardava só rótulos para o chat interno.
// Agora cada membro é um ATENDENTE de verdade: tem login próprio (e-mail+senha),
// permissões por módulo, cargo, foto, status de presença e histórico de ações.
//
// Hierarquia:
//   • DONO da conta (login por acc.email) e ADMIN da plataforma → acesso total,
//     não passam por checagem de permissão (não podem se trancar para fora).
//   • ATENDENTE (agent) → tudo é validado contra agent.permissions.
const db = require('./db');

// Módulos protegidos (batem 1:1 com os itens do menu lateral)
const MODULES = [
  { key: 'dashboard', label: 'Dashboard', view: 'dashboard' },
  { key: 'inbox', label: 'Conversas', view: 'inbox' },
  { key: 'team', label: 'Chat Interno', view: 'team' },
  { key: 'contacts', label: 'Contatos', view: 'contacts' },
  { key: 'funnel', label: 'Funil de Vendas', view: 'funnel' },
  { key: 'consent', label: 'Opt-in & Opt-out', view: 'consent' },
  { key: 'flows', label: 'Flow Builder', view: 'flows' },
  { key: 'campaigns', label: 'Campanhas', view: 'campaigns' },
  { key: 'templates', label: 'Modelos', view: 'templates' },
  { key: 'quick', label: 'Respostas Rápidas', view: 'quick' },
  { key: 'webhooks', label: 'Webhooks', view: 'webhooks' },
  { key: 'pixels', label: 'Pixels', view: 'pixels' },
  { key: 'links', label: 'Links Rastreáveis', view: 'links' },
  { key: 'schedule', label: 'Agendamentos', view: 'schedule' },
  { key: 'agents', label: 'Atendentes', view: 'agents' },
  { key: 'settings', label: 'Configurações', view: 'settings' }
];
const MODULE_KEYS = MODULES.map(m => m.key);
const ACTIONS = ['view', 'create', 'edit', 'delete'];

// Presença
const STATUSES = {
  online: 'Online',
  away: 'Ausente',
  busy: 'Em atendimento',
  offline: 'Offline'
};
const PRESENCE_TIMEOUT = 3 * 60 * 1000; // sem heartbeat por 3min → offline

function emptyPerms(value = false) {
  const p = {};
  for (const k of MODULE_KEYS) {
    p[k] = {};
    for (const a of ACTIONS) p[k][a] = value;
  }
  return p;
}

// Perfis prontos (o admin pode ajustar cada caixinha depois)
const PRESETS = {
  admin: () => emptyPerms(true),
  supervisor: () => {
    const p = emptyPerms(true);
    for (const a of ACTIONS) { p.agents[a] = a === 'view'; p.settings[a] = a === 'view'; }
    return p;
  },
  atendente: () => {
    const p = emptyPerms(false);
    const allow = (mod, acts) => { for (const a of acts) p[mod][a] = true; };
    allow('dashboard', ['view']);
    allow('inbox', ['view', 'create', 'edit']);
    allow('team', ['view', 'create']);
    allow('contacts', ['view', 'create', 'edit']);
    allow('funnel', ['view', 'edit']);
    allow('templates', ['view']);
    allow('quick', ['view']);
    allow('schedule', ['view', 'create', 'edit', 'delete']);
    return p;
  }
};

function newAgent({ name, email, pass, role, phone, photo, preset = 'atendente' }) {
  return {
    id: db.genId('ag'),
    name: String(name || '').trim(),
    email: String(email || '').toLowerCase().trim(),
    passHash: pass ? db.hash(pass) : '',
    phone: String(phone || '').trim(),
    role: String(role || 'Atendente').trim(),   // cargo (texto livre)
    photo: photo || '',                          // dataURL
    active: true,
    permissions: (PRESETS[preset] || PRESETS.atendente)(),
    status: 'offline',                           // status manual escolhido pelo atendente
    lastSeenAt: null,                            // heartbeat (presença real)
    lastLoginAt: null,
    createdAt: Date.now(),
    sectorId: null,
    mustChangePassword: true
  };
}

// Garante o shape em membros antigos (migração de acc.team[])
function ensureAgent(a, accStages) {
  if (!a.permissions || typeof a.permissions !== 'object') a.permissions = PRESETS.atendente();
  for (const k of MODULE_KEYS) {
    if (!a.permissions[k]) a.permissions[k] = {};
    for (const act of ACTIONS) if (typeof a.permissions[k][act] !== 'boolean') a.permissions[k][act] = false;
  }
  if (typeof a.name !== 'string') a.name = 'Atendente';
  if (typeof a.email !== 'string') a.email = '';
  if (typeof a.passHash !== 'string') a.passHash = '';
  if (typeof a.phone !== 'string') a.phone = '';
  if (typeof a.role !== 'string') a.role = 'Atendente';
  if (typeof a.photo !== 'string') a.photo = '';
  if (typeof a.active !== 'boolean') a.active = true;
  if (!STATUSES[a.status]) a.status = 'offline';
  if (a.lastSeenAt === undefined) a.lastSeenAt = null;
  if (a.lastLoginAt === undefined) a.lastLoginAt = null;
  if (a.createdAt === undefined) a.createdAt = Date.now();
  if (a.mustChangePassword === undefined) a.mustChangePassword = !a.passHash;
  return a;
}

function findAgent(acc, id) { return (acc.team || []).find(a => a.id === id) || null; }
function findAgentByEmail(email) {
  const mail = String(email || '').toLowerCase().trim();
  if (!mail) return null;
  for (const acc of db.get().accounts) {
    const a = (acc.team || []).find(x => x.email && x.email === mail && x.active);
    if (a) return { acc, agent: a };
  }
  return null;
}

// ---------- Permissões ----------

// req vindo da API: { acc, agent } — agent null significa DONO/ADMIN (acesso total)
function can(agent, moduleKey, action = 'view') {
  if (!agent) return true;                 // dono da conta / admin da plataforma
  if (!agent.active) return false;
  const p = agent.permissions || {};
  return !!(p[moduleKey] && p[moduleKey][action]);
}

// Módulos visíveis no menu lateral (o front esconde o que não tiver `view`)
function allowedViews(agent) {
  if (!agent) return MODULE_KEYS.slice();
  return MODULE_KEYS.filter(k => can(agent, k, 'view'));
}

// ---------- Presença ----------

// Status efetivo: sem heartbeat recente → offline, independente do status manual.
function presenceOf(agent, now = Date.now()) {
  if (!agent || !agent.active) return 'offline';
  if (!agent.lastSeenAt || now - agent.lastSeenAt > PRESENCE_TIMEOUT) return 'offline';
  return STATUSES[agent.status] ? agent.status : 'online';
}

function touchPresence(acc, agent, status) {
  if (!agent) return;
  agent.lastSeenAt = Date.now();
  if (status && STATUSES[status]) agent.status = status;
  else if (agent.status === 'offline') agent.status = 'online'; // voltou a dar sinal
  db.save();
}

// ---------- Logs de ação ----------

const LOG_ACTIONS = {
  login: 'Login', logout: 'Logout',
  conversation_assigned: 'Conversa assumida',
  conversation_transferred: 'Conversa transferida',
  conversation_finished: 'Conversa finalizada',
  contact_updated: 'Alteração em contato',
  contact_deleted: 'Contato excluído',
  funnel_updated: 'Alteração no funil',
  settings_updated: 'Alteração em configurações',
  agent_created: 'Atendente criado',
  agent_updated: 'Atendente alterado',
  agent_deleted: 'Atendente excluído',
  schedule_created: 'Agendamento criado',
  schedule_updated: 'Agendamento alterado',
  schedule_deleted: 'Agendamento excluído',
  campaign_sent: 'Campanha disparada',
  message_sent: 'Mensagem enviada',
  call_answered: 'Ligação atendida',
  call_rejected: 'Ligação recusada',
  call_ended: 'Ligação encerrada',
  call_started: 'Ligação realizada'
};

// `who` = { agentId, name } — o dono da conta também é registrado (agentId null)
function log(acc, who, action, detail = '', meta = null) {
  acc.logs = acc.logs || [];
  acc.logs.unshift({
    id: db.genId('lg'),
    ts: Date.now(),
    agentId: (who && who.agentId) || null,
    agentName: (who && who.name) || 'Sistema',
    action,
    label: LOG_ACTIONS[action] || action,
    detail: String(detail || ''),
    meta: meta || null
  });
  if (acc.logs.length > 3000) acc.logs.length = 3000;
  db.save();
}

// ---------- Métricas de desempenho ----------

// Calcula, por atendente: conversas atendidas/finalizadas/em andamento,
// tempo médio da 1ª resposta e tempo médio de atendimento, e nota média.
function metricsOf(acc, agentId, now = Date.now()) {
  const msgs = acc.messages || [];
  const byContact = {};
  for (const m of msgs) (byContact[m.waId] = byContact[m.waId] || []).push(m);

  let handled = 0, finished = 0, ongoing = 0;
  const firstResp = [], handleTime = [], ratings = [];

  for (const c of acc.contacts || []) {
    const att = c.attendance || {};
    const mine = agentId
      ? (c.assignedTo === agentId || att.closedBy === agentId || c.lastAgentId === agentId)
      : true;
    if (!mine) continue;

    const list = (byContact[c.waId] || []).sort((a, b) => a.timestamp - b.timestamp);
    const outByAgent = list.filter(m => m.direction === 'out' && (!agentId || m.agentId === agentId));
    if (!outByAgent.length && c.assignedTo !== agentId) continue;

    handled++;
    if (att.status === 'finished' && (!agentId || att.closedBy === agentId)) finished++;
    else if (c.assignedTo === agentId && att.status !== 'finished') ongoing++;

    // 1ª resposta: primeiro inbound → primeiro outbound depois dele
    const firstIn = list.find(m => m.direction === 'in');
    if (firstIn) {
      const reply = outByAgent.find(m => m.timestamp > firstIn.timestamp);
      if (reply) firstResp.push(reply.timestamp - firstIn.timestamp);
      // tempo de atendimento: abertura → finalização
      if (att.status === 'finished' && att.closedAt && att.openedAt) {
        handleTime.push(att.closedAt - att.openedAt);
      }
    }
    for (const s of c.surveys || []) ratings.push(s.score / s.scale);
  }

  const avg = arr => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
  return {
    handled, finished, ongoing,
    avgFirstResponseMs: avg(firstResp),
    avgHandleTimeMs: avg(handleTime),
    avgRatingPercent: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) : null,
    ratingCount: ratings.length
  };
}

// Ranking de produtividade: finalizadas pesam mais que atendidas; resposta rápida bonifica.
function ranking(acc, now = Date.now()) {
  return (acc.team || [])
    .filter(a => a.active)
    .map(a => {
      const m = metricsOf(acc, a.id, now);
      const speedBonus = m.avgFirstResponseMs ? Math.max(0, 20 - m.avgFirstResponseMs / 60000) : 0;
      return {
        id: a.id, name: a.name, role: a.role, photo: a.photo,
        presence: presenceOf(a, now),
        ...m,
        score: Math.round(m.finished * 3 + m.handled + speedBonus)
      };
    })
    .sort((x, y) => y.score - x.score);
}

module.exports = {
  MODULES, MODULE_KEYS, ACTIONS, STATUSES, PRESETS, LOG_ACTIONS, PRESENCE_TIMEOUT,
  emptyPerms, newAgent, ensureAgent, findAgent, findAgentByEmail,
  can, allowedViews, presenceOf, touchPresence, log, metricsOf, ranking
};
