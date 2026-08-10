// Agendamentos e Lembretes — Koonfy
//
// Um agendamento pode se relacionar com contato, conversa, etapa do funil e
// atendente. Os lembretes disparam via SSE (dentro do app) e Push Notification
// no WebApp — o mesmo evento serve para os dois.
const db = require('./db');

// Opções de lembrete (minutos ANTES do início; 0 = no horário)
const REMINDER_OPTIONS = [0, 5, 15, 30, 60, 1440];
const REMINDER_LABEL = {
  0: 'No horário', 5: '5 minutos antes', 15: '15 minutos antes',
  30: '30 minutos antes', 60: '1 hora antes', 1440: '24 horas antes'
};

// Cores do evento — todas do Design System do app
const COLORS = ['green', 'blue', 'amber', 'red', 'violet', 'gray'];

function defaultEvent() {
  return {
    title: '', description: '', notes: '',
    color: 'green',
    start: Date.now(), durationMin: 30,
    contactWaId: '', agentId: '', stage: '',
    reminders: [15],
    done: false
  };
}

function normalize(e, body, acc) {
  const b = body || {};
  if (typeof b.title === 'string') e.title = b.title.trim().slice(0, 120);
  if (typeof b.description === 'string') e.description = b.description.slice(0, 2000);
  if (typeof b.notes === 'string') e.notes = b.notes.slice(0, 2000);
  if (COLORS.includes(b.color)) e.color = b.color;
  if (b.start !== undefined) {
    const t = Number(b.start);
    if (Number.isFinite(t) && t > 0) e.start = t;
  }
  if (b.durationMin !== undefined) {
    const d = Math.max(5, Math.min(1440, Number(b.durationMin) || 30));
    e.durationMin = d;
  }
  if (typeof b.contactWaId === 'string') e.contactWaId = b.contactWaId.replace(/\D/g, '');
  if (typeof b.agentId === 'string') e.agentId = b.agentId;
  if (typeof b.stage === 'string') e.stage = (acc.stages || []).includes(b.stage) ? b.stage : '';
  if (Array.isArray(b.reminders)) {
    e.reminders = [...new Set(b.reminders.map(Number).filter(n => REMINDER_OPTIONS.includes(n)))].sort((x, y) => x - y);
  }
  if (b.done !== undefined) e.done = !!b.done;
  return e;
}

function create(acc, body, createdBy) {
  const e = {
    id: db.genId('ev'),
    ...defaultEvent(),
    createdAt: Date.now(),
    createdBy: createdBy || null,
    sentReminders: []   // minutos já disparados (evita repetir)
  };
  normalize(e, body, acc);
  if (!e.title) e.title = 'Agendamento';
  acc.schedules = acc.schedules || [];
  acc.schedules.push(e);
  db.save();
  return e;
}

function update(acc, id, body) {
  const e = (acc.schedules || []).find(x => x.id === id);
  if (!e) return null;
  const oldStart = e.start;
  normalize(e, body, acc);
  // mudou o horário? os lembretes voltam a valer
  if (e.start !== oldStart) e.sentReminders = [];
  db.save();
  return e;
}

function remove(acc, id) {
  const before = (acc.schedules || []).length;
  acc.schedules = (acc.schedules || []).filter(e => e.id !== id);
  db.save();
  return acc.schedules.length < before;
}

function duplicate(acc, id, createdBy) {
  const src = (acc.schedules || []).find(x => x.id === id);
  if (!src) return null;
  const copy = {
    ...JSON.parse(JSON.stringify(src)),
    id: db.genId('ev'),
    title: src.title + ' (cópia)',
    createdAt: Date.now(),
    createdBy: createdBy || null,
    done: false,
    sentReminders: []
  };
  acc.schedules.push(copy);
  db.save();
  return copy;
}

// Enriquecido com o contato/atendente para o front não precisar cruzar dados
function publicOf(acc, e) {
  const c = e.contactWaId ? (acc.contacts || []).find(x => x.waId === e.contactWaId) : null;
  const a = e.agentId ? (acc.team || []).find(x => x.id === e.agentId) : null;
  return {
    ...e,
    end: e.start + e.durationMin * 60000,
    contact: c ? { waId: c.waId, name: c.name, stage: c.stage } : null,
    agent: a ? { id: a.id, name: a.name, photo: a.photo, role: a.role } : null
  };
}

function list(acc, { from, to, agentId, stage } = {}) {
  let arr = (acc.schedules || []).slice();
  if (from) arr = arr.filter(e => e.start + e.durationMin * 60000 >= from);
  if (to) arr = arr.filter(e => e.start <= to);
  if (agentId) arr = arr.filter(e => e.agentId === agentId);
  if (stage) arr = arr.filter(e => e.stage === stage);
  return arr.sort((a, b) => a.start - b.start).map(e => publicOf(acc, e));
}

// ---------- Indicadores do Dashboard ----------
function summary(acc, now = Date.now()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const all = (acc.schedules || []);
  const today = all.filter(e => e.start >= +start && e.start <= +end);
  const upcoming = all.filter(e => !e.done && e.start > now).sort((a, b) => a.start - b.start);
  const late = all.filter(e => !e.done && e.start + e.durationMin * 60000 < now);
  return {
    todayCount: today.length,
    upcomingCount: upcoming.length,
    lateCount: late.length,
    today: today.sort((a, b) => a.start - b.start).map(e => publicOf(acc, e)).slice(0, 6),
    next: upcoming.slice(0, 6).map(e => publicOf(acc, e)),
    late: late.sort((a, b) => b.start - a.start).slice(0, 6).map(e => publicOf(acc, e))
  };
}

// ---------- Motor de lembretes ----------
// Roda em intervalo no server. Dispara uma vez por (evento, minutos).
function sweepReminders(broadcast) {
  const now = Date.now();
  let fired = 0;
  for (const acc of db.get().accounts) {
    for (const e of acc.schedules || []) {
      if (e.done) continue;
      for (const min of e.reminders || []) {
        if ((e.sentReminders || []).includes(min)) continue;
        const when = e.start - min * 60000;
        // dispara na janela [when, when+90s] — evita avalanche de lembretes velhos
        if (now >= when && now - when < 90000) {
          e.sentReminders = e.sentReminders || [];
          e.sentReminders.push(min);
          db.save();
          fired++;
          if (broadcast) {
            broadcast('reminder', {
              accountId: acc.id,
              agentId: e.agentId || null,
              event: publicOf(acc, e),
              minutes: min,
              label: REMINDER_LABEL[min] || `${min} min antes`
            });
          }
        }
      }
    }
  }
  return fired;
}

module.exports = {
  REMINDER_OPTIONS, REMINDER_LABEL, COLORS,
  create, update, remove, duplicate, list, publicOf, summary, sweepReminders
};
