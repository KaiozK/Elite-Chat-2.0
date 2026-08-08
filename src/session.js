// Janela de atendimento de 24h (Meta) + ciclo de vida do atendimento — EliteChat
//
// Fonte única de verdade para:
//   • Janela de 24h: aberta enquanto passarem <24h da ÚLTIMA mensagem recebida
//     do cliente. Fora dela a Meta só aceita TEMPLATES aprovados.
//   • Atendimento: aberto | finalizado (manual ou automático), com atendente,
//     data e tipo de finalização.
//
// Este módulo é puro/estável: a API, o webhook e o sweeper apenas o consomem.
// O futuro módulo de Pesquisa de Satisfação se registra em onFinished() — não
// será preciso alterar nada aqui.
const db = require('./db');

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24h, regra da Meta
const WARN_MS = 60 * 60 * 1000;        // < 1h  → amarelo
const CRIT_MS = 15 * 60 * 1000;        // < 15min → vermelho

// Opções de inatividade para a finalização automática (Configurações → Atendimento)
const AUTO_CLOSE_OPTIONS = [30, 60, 120, 360, 720, 1440]; // minutos

function defaultService() {
  return { autoClose: { enabled: false, minutes: 60 } };
}

function emptyAttendance() {
  return {
    status: 'open',      // open | finished
    openedAt: null,
    closedAt: null,
    closeType: null,     // manual | auto
    closedBy: null,      // atendente responsável (usuário que finalizou)
    reopenedAt: null,
    reopenedBy: null
  };
}

// ---------- Janela de 24h ----------

// Estado da janela para um contato. Deriva sempre de lastInboundAt (nunca fica
// "velho" no banco): o expiresAt persistido é só cache/relatório.
function windowState(contact, now = Date.now()) {
  const lastInboundAt = (contact && contact.lastInboundAt) || null;
  if (!lastInboundAt) {
    // Nunca recebemos mensagem deste contato → não há janela aberta.
    return { open: false, level: 'never', lastInboundAt: null, expiresAt: null, msLeft: 0, msSinceInbound: null };
  }
  const expiresAt = lastInboundAt + WINDOW_MS;
  const msLeft = expiresAt - now;
  const open = msLeft > 0;
  let level = 'expired';
  if (open) level = msLeft <= CRIT_MS ? 'critical' : (msLeft <= WARN_MS ? 'warning' : 'open');
  return {
    open, level, lastInboundAt, expiresAt,
    msLeft: Math.max(0, msLeft),
    msSinceInbound: now - lastInboundAt
  };
}

// Estado completo (janela + atendimento) — o que o front consome.
function sessionState(contact, now = Date.now()) {
  const win = windowState(contact, now);
  const att = (contact && contact.attendance) || emptyAttendance();
  return {
    window: win,
    attendance: {
      status: att.status || 'open',
      openedAt: att.openedAt || null,
      closedAt: att.closedAt || null,
      closeType: att.closeType || null,
      closedBy: att.closedBy || null
    },
    // Só é possível mandar mensagem livre (texto/mídia/áudio/botões) se a janela
    // está aberta E o atendimento não foi finalizado.
    canSendSession: win.open && (att.status || 'open') !== 'finished',
    canSendTemplate: true // template sempre pode, é o que reabre a conversa
  };
}

// Tipos de envio que dependem da janela (mensagens "de sessão").
// Template fica de fora: é o único caminho permitido fora da janela.
const SESSION_KINDS = ['text', 'media', 'buttons', 'interactive', 'location', 'contacts', 'reaction'];

// Regra central de permissão — usada pelo backend (guard) e pelo front (UI).
function canSend(contact, kind) {
  if (!SESSION_KINDS.includes(kind)) return { allowed: true };
  const st = sessionState(contact);
  if (st.attendance.status === 'finished') {
    return {
      allowed: false,
      code: 'attendance_finished',
      error: 'Atendimento finalizado. Reabra o atendimento para voltar a enviar mensagens.'
    };
  }
  if (!st.window.open) {
    return {
      allowed: false,
      code: 'window_closed',
      error: 'A janela de 24h expirou. Só é possível enviar um Template aprovado da Meta para reabrir a conversa.'
    };
  }
  return { allowed: true };
}

// ---------- Mensagem recebida do cliente ----------

// Chamado pelo webhook a cada mensagem recebida: renova a janela de 24h e,
// se o atendimento estava finalizado, abre um NOVO atendimento (o cliente
// voltou a falar) — mantendo o histórico da finalização anterior.
function touchInbound(acc, contact, ts = Date.now()) {
  if (!contact) return null;
  contact.lastInboundAt = ts;
  contact.windowExpiresAt = ts + WINDOW_MS;
  if (!contact.attendance) contact.attendance = emptyAttendance();
  const att = contact.attendance;
  let reopened = false;
  if (att.status === 'finished') {
    contact.attendanceHistory = contact.attendanceHistory || [];
    contact.attendanceHistory.push({ ...att });
    if (contact.attendanceHistory.length > 50) contact.attendanceHistory.shift();
    contact.attendance = { ...emptyAttendance(), status: 'open', openedAt: ts };
    reopened = true;
  } else if (!att.openedAt) {
    att.openedAt = ts;
  }
  db.save();
  return { reopened };
}

// ---------- Finalização / reabertura do atendimento ----------

// Handlers registrados para o evento "atendimento finalizado".
// O futuro módulo de Pesquisa de Satisfação faz:
//   require('./session').onFinished(({ acc, contact, attendance }) => { ...enviar pesquisa... })
// e nada aqui precisa mudar.
const finishedHandlers = [];
function onFinished(fn) { if (typeof fn === 'function') finishedHandlers.push(fn); }
function emitFinished(payload) {
  for (const fn of finishedHandlers) {
    try { fn(payload); } catch (e) { /* um handler nunca derruba a finalização */ }
  }
}

// by: nome/identificação do atendente. type: 'manual' | 'auto'.
function finish(acc, contact, { by = null, type = 'manual' } = {}) {
  if (!contact) return null;
  if (!contact.attendance) contact.attendance = emptyAttendance();
  const att = contact.attendance;
  if (att.status === 'finished') return att; // idempotente

  att.status = 'finished';
  att.closedAt = Date.now();
  att.closeType = type === 'auto' ? 'auto' : 'manual';
  att.closedBy = by || (type === 'auto' ? 'Sistema (automático)' : null);
  db.save();

  // Gatilho para o futuro módulo de Pesquisa de Satisfação (não implementado agora)
  emitFinished({ acc, contact, attendance: { ...att }, waId: contact.waId });
  return att;
}

function reopen(acc, contact, by = null) {
  if (!contact) return null;
  if (!contact.attendance) contact.attendance = emptyAttendance();
  const att = contact.attendance;
  if (att.status !== 'finished') return att;
  contact.attendanceHistory = contact.attendanceHistory || [];
  contact.attendanceHistory.push({ ...att });
  if (contact.attendanceHistory.length > 50) contact.attendanceHistory.shift();
  contact.attendance = {
    ...emptyAttendance(),
    status: 'open',
    openedAt: Date.now(),
    reopenedAt: Date.now(),
    reopenedBy: by || null
  };
  db.save();
  return contact.attendance;
}

// ---------- Finalização automática por inatividade ----------

// Percorre as contas e finaliza os atendimentos abertos cuja última atividade
// (mensagem recebida) passou do tempo configurado. Roda em intervalo no server.
function autoCloseSweep(broadcast) {
  const now = Date.now();
  let closed = 0;
  for (const acc of db.get().accounts) {
    const cfg = (acc.service && acc.service.autoClose) || null;
    if (!cfg || !cfg.enabled) continue;
    const limitMs = Math.max(1, Number(cfg.minutes) || 60) * 60 * 1000;
    for (const c of acc.contacts || []) {
      const att = c.attendance;
      if (!att || att.status === 'finished') continue;
      if (!c.lastInboundAt) continue;              // nunca houve atendimento de fato
      if (now - c.lastInboundAt < limitMs) continue;
      finish(acc, c, { type: 'auto' });
      closed++;
      if (broadcast) broadcast('attendance', { accountId: acc.id, waId: c.waId, status: 'finished', closeType: 'auto' });
    }
  }
  return closed;
}

// ---------- Métricas para o Dashboard ----------

function metrics(acc, now = Date.now()) {
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const today = +startOfDay;
  let expiringSoon = 0, expired = 0, finishedToday = 0, autoClosedToday = 0, openWindows = 0;
  for (const c of acc.contacts || []) {
    const w = windowState(c, now);
    if (w.level === 'warning' || w.level === 'critical') expiringSoon++;
    if (w.open) openWindows++;
    else if (w.lastInboundAt) expired++;   // já teve conversa e a janela fechou
    const att = c.attendance;
    if (att && att.status === 'finished' && att.closedAt >= today) {
      finishedToday++;
      if (att.closeType === 'auto') autoClosedToday++;
    }
  }
  return { openWindows, expiringSoon, expired, finishedToday, autoClosedToday };
}

module.exports = {
  WINDOW_MS, WARN_MS, CRIT_MS, AUTO_CLOSE_OPTIONS, SESSION_KINDS,
  defaultService, emptyAttendance,
  windowState, sessionState, canSend,
  touchInbound, finish, reopen, onFinished,
  autoCloseSweep, metrics
};
