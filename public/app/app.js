/* WA CRM — painel admin */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let TOKEN = localStorage.getItem('wacrm_token') || '';
// Link de afiliado: /app/?ref=CODIGO — guarda o código p/ o cadastro
try {
  const refParam = new URLSearchParams(location.search).get('ref');
  if (refParam) localStorage.setItem('ec_ref', refParam.toUpperCase());
} catch {}
const state = {
  user: null,
  kind: 'account',
  wa: null,
  settings: null,
  view: 'dashboard',
  currentWaId: null,
  currentSession: null,   // janela de 24h + atendimento da conversa aberta
  currentConsent: null,
  conversations: [],
  mustChangePassword: false,
  agent: null,            // dados do atendente logado (null = dono/admin)
  permissions: null,      // null = acesso total
  allowedViews: null
};
let es = null;
let pollTimer = null;
let presenceTimer = null;

// Lembrete de agendamento: Centro + notificação nativa + som/vibração (via ECNotify).
function onReminder(d) {
  // se o lembrete é de um atendente específico, só notifica ele
  if (d.agentId && state.agent && d.agentId !== state.agent.id) return;
  const ev = d.event || {};
  const when = new Date(ev.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const body = `${ev.title} · ${when}${ev.contact ? ' · ' + ev.contact.name : ''}`;
  if (window.ECNotify) {
    ECNotify.notify({
      type: 'reminder', title: 'Lembrete — ' + d.label, body,
      waId: ev.contact ? ev.contact.waId : null,
      url: ev.contact ? '/app/#/inbox' : '/app/#/schedule',
      tag: 'ev-' + ev.id, requireInteraction: true
    });
  } else { toast(`⏰ ${d.label}: ${body}`); }
}
// Pede permissão de notificação uma vez (após login)
function askNotifPermission() {
  setTimeout(() => { try { if (window.ECNotify) ECNotify.requestPermission(); } catch {} }, 4000);
}

// ---------- Notificação de nova mensagem (via SSE) ----------
// d = { accountId, waId, notify:{ direction, name, text, type } }
function maybeNotifyMessage(d) {
  if (!window.ECNotify || !d || !d.notify || d.notify.direction !== 'in') return;
  // não notifica a conversa que já está aberta e em foco (você está lendo)
  if (!document.hidden && state.view === 'inbox' && d.waId === state.currentWaId) return;
  ECNotify.notify({
    type: 'message', title: d.notify.name || 'Nova mensagem', body: d.notify.text || '',
    waId: d.waId, url: '/app/#/inbox', tag: 'msg:' + d.waId
  });
}

// ---------- Centro de Notificações (sino no topbar) ----------
function notifOpenFromData(data) {
  data = data || {};
  if (data.waId) { location.hash = '#/inbox'; setTimeout(() => { try { openChat(data.waId); } catch {} }, 180); }
  else if (data.url) { const h = data.url.split('#')[1]; if (h) location.hash = h; }
}
function notifResync() {
  refreshBadge();
  if (state.view === 'inbox') loadConversations();
}
function paintNotifBell() {
  if (!window.ECNotify) return;
  const dot = $('#notif-dot'); if (!dot) return;
  const n = ECNotify.unreadCount();
  if (n > 0) { dot.textContent = n > 9 ? '9+' : n; dot.classList.remove('hidden'); }
  else dot.classList.add('hidden');
  const panel = $('#notif-panel');
  if (panel && !panel.classList.contains('hidden')) renderNotifPanel();
}
function toggleNotifCenter(e) {
  if (e) e.stopPropagation();
  const panel = $('#notif-panel'); if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden');
  if (willOpen) {
    renderNotifPanel();
    setTimeout(() => document.addEventListener('click', closeNotifOnOutside), 0);
  } else document.removeEventListener('click', closeNotifOnOutside);
}
function closeNotifOnOutside(e) {
  if (e.target.closest && e.target.closest('.notif-wrap')) return;
  const panel = $('#notif-panel'); if (panel) panel.classList.add('hidden');
  document.removeEventListener('click', closeNotifOnOutside);
}
const NOTIF_IC = { message: 'message', call: 'phone', attendance: 'users', reminder: 'calendar' };
function renderNotifPanel() {
  const panel = $('#notif-panel'); if (!panel) return;
  const list = ECNotify.getCenter();
  panel.innerHTML = `
    <div class="notif-hd">
      <b>Notificações</b>
      <div class="notif-acts">
        <button class="btn small" onclick="ECNotify.markAllRead();paintNotifBell()">Marcar lidas</button>
        <button class="btn small ghost" onclick="ECNotify.clearCenter();paintNotifBell()">Limpar</button>
      </div>
    </div>
    <div class="notif-list">
      ${list.length ? list.map(n => `
        <div class="notif-item${n.read ? '' : ' unread'}" onclick="notifItemClick('${n.id}')">
          <span class="notif-ic type-${n.type}">${ico(NOTIF_IC[n.type] || 'bell', 15)}</span>
          <div class="notif-tx">
            <b>${esc(n.title)}</b>
            ${n.body ? `<span>${esc(n.body)}</span>` : ''}
            <em>${timeAgo(n.ts)}</em>
          </div>
        </div>`).join('')
      : '<div class="notif-empty">Nenhuma notificação por aqui.</div>'}
    </div>`;
}
function notifItemClick(id) {
  const n = ECNotify.getCenter().find(x => x.id === id);
  ECNotify.markRead(id); paintNotifBell();
  const panel = $('#notif-panel'); if (panel) panel.classList.add('hidden');
  if (n) notifOpenFromData({ waId: n.waId, url: n.url });
}

// ---------- Configurações → Notificações ----------
function renderNotifSettings() {
  if (!window.ECNotify) return `<h2>${ico('bell')} Notificações</h2><p class="muted" style="margin:0;font-size:13px">Indisponível neste navegador.</p>`;
  const p = ECNotify.getPrefs();
  const perm = ECNotify.permission();
  const permBadge = perm === 'granted'
    ? '<span class="notif-perm ok">Permitidas</span>'
    : perm === 'denied'
      ? '<span class="notif-perm bad">Bloqueadas no navegador</span>'
      : '<span class="notif-perm warn">Não ativadas</span>';
  const ck = (path, val, label, hint) =>
    `<label class="chk notif-chk"><input type="checkbox" ${val ? 'checked' : ''} onchange="notifSet('${path}', this.checked)"> <span><b>${label}</b>${hint ? `<em>${hint}</em>` : ''}</span></label>`;
  return `
    <h2>${ico('bell')} Notificações & sons ${permBadge}</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">Controle os avisos do EliteChat instalado como aplicativo (Desktop, Android e iOS). ${perm !== 'granted' ? `<button class="btn small primary" style="margin-left:6px" onclick="notifEnable()">${ico('bell', 13)} Ativar notificações</button>` : ''}</p>
    <div class="notif-grid">
      ${ck('enabled', p.enabled, 'Notificações do sistema', 'Avisos nativos com o app em segundo plano')}
      ${ck('sounds', p.sounds, 'Sons', 'Toca um som ao chegar novidade')}
      ${ck('vibrate', p.vibrate, 'Vibração', 'Dispositivos compatíveis')}
      ${ck('badge', p.badge, 'Badge no ícone', 'Número de não lidas no ícone do app')}
    </div>
    <h3 class="notif-sub">Avisar sobre</h3>
    <div class="notif-grid">
      ${ck('types.message', p.types.message, 'Novas mensagens', 'Nome do contato + prévia')}
      ${ck('types.call', p.types.call, 'Ligações', 'Chamadas de voz recebidas')}
      ${ck('types.attendance', p.types.attendance, 'Atendimentos', 'Novo cliente iniciou conversa')}
      ${ck('types.reminder', p.types.reminder, 'Lembretes', 'Agendamentos da agenda')}
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn no-grow" onclick="notifTestFire()">${ico('bell', 14)} Testar notificação</button>
    </div>`;
}
function notifSet(path, val) { ECNotify.setPref(path, val); }
function notifEnable() {
  ECNotify.requestPermission().then(() => { const c = $('#notif-card'); if (c) c.innerHTML = renderNotifSettings(); });
}
function notifTestFire() {
  ECNotify.notify({ type: 'message', title: 'EliteChat', body: 'Notificação de teste — está funcionando! 🎉', url: '/app/#/settings', tag: 'test' });
  toast('Notificação de teste enviada');
}

// Heartbeat de presença: mantém o atendente "online" e recupera de "offline".
function startPresence() {
  clearInterval(presenceTimer);
  if (!state.agent) return; // dono/admin não têm presença
  const beat = () => api('/agents/me/status', { method: 'PUT', body: {} }).catch(() => {});
  beat();
  presenceTimer = setInterval(beat, 60000);
  // marca ausente quando a aba perde o foco por muito tempo
  document.addEventListener('visibilitychange', () => {
    if (!state.agent) return;
    api('/agents/me/status', { method: 'PUT', body: { status: document.hidden ? 'away' : 'online' } }).catch(() => {});
  });
}
function setMyStatus(st) {
  api('/agents/me/status', { method: 'PUT', body: { status: st } }).then(() => {
    if (state.agent) state.agent.presence = st;
    toast('Status: ' + ({ online: 'Online', away: 'Ausente', busy: 'Em atendimento', offline: 'Offline' }[st] || st));
    if (state.view === 'team') paintTeamSide();
  }).catch(e => toast(e.message, 'error'));
}

// ---------- infra ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { logout(true); throw new Error('Sessão expirada'); }
  if (!res.ok) {
    const err = new Error(data.error || 'Erro ' + res.status);
    err.meta = data.meta;
    throw err;
  }
  return data;
}

// ---------- ícones (SVG inline, traço fino — estilo Feather) ----------
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 20l1.1-4.3A8.5 8.5 0 1 1 21 11.5z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 15.2c2.4.3 4.2 1.9 4.9 4.3"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 5-5"/>',
  check: '<path d="M4.5 12.5 10 18 19.5 6.5"/>',
  arrowleft: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  mail: '<rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="m3 6 9 6 9-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  braces: '<path d="M8 3c-2 0-3 1-3 3v2c0 1.5-.7 2.5-2 3 1.3.5 2 1.5 2 3v2c0 2 1 3 3 3M16 3c2 0 3 1 3 3v2c0 1.5.7 2.5 2 3-1.3.5-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  paperclip: '<path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  file: '<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4M9 12h6M9 16h6"/>',
  buttons: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="12" height="6" rx="2"/>',
  zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  send: '<path d="m22 2-11 11"/><path d="M22 2 15 21l-4-8-8-4 19-7z"/>',
  edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  refresh: '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  columns: '<rect x="3" y="4" width="5.5" height="16" rx="1.5"/><rect x="9.8" y="4" width="5.5" height="10" rx="1.5"/><rect x="16.5" y="4" width="4.5" height="13" rx="1.5"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  shield: '<path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z"/>',
  megaphone: '<path d="M3 10v4l4 .8V9.2L3 10z"/><path d="M7 9l11-5v16L7 15z"/><path d="M9.5 15.6V19a2 2 0 0 0 4 0v-2.4"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  slash: '<circle cx="12" cy="12" r="9"/><path d="M5.5 5.5l13 13"/>',
  'download-circle': '<circle cx="12" cy="12" r="9"/><path d="M12 8v7M9 12.5 12 15.5l3-3"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M6 6a8.5 8.5 0 0 0 0 12M18 6a8.5 8.5 0 0 1 0 12"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.5a2.8 2.8 0 0 1 5.4 1c0 1.8-2.6 2.5-2.6 2.5"/><path d="M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  flow: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h5a4 4 0 0 1 4 4v5"/>',
  http: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
  chat2: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="10" r="1"/><circle cx="13" cy="10" r="1"/><circle cx="17" cy="10" r="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  clock2: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  mousepointer: '<path d="M5 3.5 11 20l2.3-6.4L20 11 5 3.5z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  sparkles: '<path d="M12 3.5 13.6 8 18 9.6 13.6 11.2 12 15.7 10.4 11.2 6 9.6 10.4 8 12 3.5z"/><path d="M18.5 15.5 19.3 17.7 21.5 18.5 19.3 19.3 18.5 21.5 17.7 19.3 15.5 18.5 17.7 17.7 18.5 15.5z"/>',
  branch: '<line x1="6" y1="4" x2="6" y2="15"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="6" r="2.6"/><path d="M18 8.6A9 9 0 0 1 9 17.6"/>',
  tag: '<path d="M20.6 13.4 13 21a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.4 12.4V5a2 2 0 0 1 2-2h7.4a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.4z"/><path d="M7.5 7.5h.01"/>',
  arrowright: '<path d="M4 12h15M13 5.5 19.5 12 13 18.5"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9.5 12h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  hashtag: '<path d="M9 4 7 20M17 4l-2 16M5 9h15M4 15h15"/>',
  headset: '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="2.5" y="13" width="4" height="6" rx="1.5"/><rect x="17.5" y="13" width="4" height="6" rx="1.5"/><path d="M20 19a4 4 0 0 1-4 3.5h-2"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>'
};
function ico(name, size = 16) {
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- dropdown customizado (substitui todo <select> nativo) ----------
// ecSelect(id, [{value,label}], value, onpick?, cls?) → HTML; leia com ecSelVal(id).
// onpick: trecho JS executado ao escolher (variáveis disponíveis: val, id).
// cls: classes extras no wrapper (ex.: 'sm' compacto, 'up' abre para cima).
const ecChk = '<svg class="ecsel-chk" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
function ecSelect(id, options, value, onpick, cls) {
  const val = value != null ? value : (options[0] && options[0].value);
  const cur = options.find(o => String(o.value) === String(val)) || options[0] || { label: '', value: '' };
  const isPh = cur.value === '' || cur.value == null;
  const opAttr = onpick ? ` data-onpick="${String(onpick).replace(/"/g, '&quot;')}"` : '';
  return `<div class="ecsel ${cls || ''}" id="${id}" data-val="${esc(val == null ? '' : val)}"${opAttr}>
    <button type="button" class="ecsel-btn${isPh ? ' ph' : ''}" onclick="ecSelToggle('${id}')">
      <span>${esc(cur.label)}</span>
      <svg class="ecsel-chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    <div class="ecsel-menu">${options.map(o => `<div class="ecsel-opt ${String(o.value) === String(val) ? 'on' : ''}" data-val="${esc(o.value)}" onclick="ecSelPick('${id}',this.dataset.val,event)">${esc(o.label)}${String(o.value) === String(val) ? ecChk : ''}</div>`).join('')}</div>
  </div>`;
}
function ecSelToggle(id) {
  const el = document.getElementById(id); if (!el) return;
  document.querySelectorAll('.ecsel.open').forEach(x => { if (x !== el) x.classList.remove('open'); });
  el.classList.toggle('open');
}
function ecSelPick(id, val, ev) {
  if (ev) ev.stopPropagation();
  const el = document.getElementById(id); if (!el) return;
  el.dataset.val = val;
  const btn = el.querySelector('.ecsel-btn');
  const opt = [...el.querySelectorAll('.ecsel-opt')].find(o => o.dataset.val === String(val));
  btn.querySelector('span').textContent = opt ? opt.textContent.trim() : val;
  btn.classList.toggle('ph', val === '' || val == null);
  el.querySelectorAll('.ecsel-opt').forEach(o => {
    const on = o.dataset.val === String(val);
    o.classList.toggle('on', on);
    const chk = o.querySelector('.ecsel-chk');
    if (on && !chk) o.insertAdjacentHTML('beforeend', ecChk);
    if (!on && chk) chk.remove();
  });
  el.classList.remove('open');
  const snip = el.dataset.onpick;
  if (snip) { try { new Function('val', 'id', snip)(val, id); } catch (e) { console.error('ecSelect onpick', e); } }
  else { const cb = el.dataset.cb; if (cb && typeof window[cb] === 'function') window[cb](); }
}
function ecSelVal(id) { const el = document.getElementById(id); return el ? el.dataset.val : ''; }
document.addEventListener('click', e => { if (!e.target.closest('.ecsel')) document.querySelectorAll('.ecsel.open').forEach(x => x.classList.remove('open')); });

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return d >= today ? hm : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return Math.floor(s / 60) + ' min';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (ts >= +today) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (ts >= +today - 86400000) return 'ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function dayLabel(ts) {
  const d = new Date(ts); d.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (+d === +today) return 'Hoje';
  if (+d === +today - 86400000) return 'Ontem';
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long' });
}

function skel(n = 4) {
  return Array.from({ length: n }, (_, i) => `<div class="skel" style="width:${88 - (i % 4) * 14}%"></div>`).join('');
}

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.innerHTML = `${ico(type === 'error' ? 'alert' : 'check-circle', 16)}<span>${esc(msg)}</span>`;
  $('#toast-root').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function avatarHtml(c, cls = '') {
  const name = c.name || c.waId || '?';
  const initials = name.replace(/[^\p{L}\d ]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
  let h = 0;
  for (const ch of (c.waId || name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<div class="avatar ${cls}" style="background:hsl(${h},55%,50%)">${esc(initials)}</div>`;
}

function openModal(html) {
  $('#modal-root').innerHTML = `<div class="modal-back"><div class="modal"><button class="modal-x" onclick="closeModal()" title="Fechar (Esc)">${ico('x', 16)}</button>${html}</div></div>`;
  $('.modal-back').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
}

function confirmModal({ title, text, ok = 'Confirmar', danger = false }) {
  return new Promise(res => {
    openModal(`
      <h2>${danger ? ico('alert') : ico('check-circle')} ${esc(title)}</h2>
      <p class="muted" style="margin:0">${esc(text)}</p>
      <div class="row" style="margin-top:8px">
        <button class="btn" id="cm-no">Cancelar</button>
        <button class="btn ${danger ? 'danger-solid' : 'primary'}" id="cm-yes">${esc(ok)}</button>
      </div>`);
    $('#cm-no').onclick = () => { closeModal(); res(false); };
    $('#cm-yes').onclick = () => { closeModal(); res(true); };
  });
}
function closeModal() { $('#modal-root').innerHTML = ''; }

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copiado!'); }
  catch { toast('Não foi possível copiar', 'error'); }
}

// ---------- auth ----------
async function init() {
  $('#login-form').addEventListener('submit', doLogin);
  if (TOKEN) {
    try {
      const me = await api('/me');
      state.user = me.user;
      state.kind = me.kind;
      state.accountId = me.accountId;
      state.wa = me.wa;
      state.mustChangePassword = me.mustChangePassword;
      state.agent = me.agent || null;
      state.permissions = me.permissions || null;   // null = acesso total (dono/admin)
      state.allowedViews = me.allowedViews || null;
      return enterApp();
    } catch {}
  }
  showLogin();
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  // Vindo da landing com ?novo=1 (CTAs "Começar agora"/"Assinar"), abre o cadastro
  try {
    const p = new URLSearchParams(location.search);
    if ((p.get('novo') === '1' || p.get('cadastro') === '1') && !registerMode) toggleRegister();
  } catch {}
}

let registerMode = false;
function toggleRegister(e) {
  if (e) e.preventDefault();
  registerMode = !registerMode;
  $('#reg-name-wrap').classList.toggle('hidden', !registerMode);
  const rw = $('#reg-ref-wrap');
  if (rw) {
    rw.classList.toggle('hidden', !registerMode);
    // ?ref=CODIGO na URL (link de afiliado) pré-preenche o código
    const saved = localStorage.getItem('ec_ref') || '';
    if (registerMode && saved && !$('#reg-ref').value) $('#reg-ref').value = saved;
  }
  $('#auth-title').textContent = registerMode ? 'Crie sua conta' : 'Acesse sua conta';
  $('#auth-sub').textContent = registerMode ? 'Conecte seu WhatsApp em minutos — sem configuração técnica' : 'Painel de atendimento e vendas';
  $('#auth-btn').textContent = registerMode ? 'Criar conta' : 'Entrar';
  $('#auth-toggle').innerHTML = registerMode
    ? 'Já tem conta? <a href="#" onclick="toggleRegister(event)">Entrar</a>'
    : 'Não tem conta? <a href="#" onclick="toggleRegister(event)">Criar conta grátis</a>';
  $('#login-err').textContent = '';
}

async function doLogin(e) {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const user = $('#login-user').value.trim();
    const pass = $('#login-pass').value;
    const r = registerMode
      ? await api('/register', { body: { name: $('#reg-name').value.trim(), email: user, pass, refCode: ($('#reg-ref')?.value || '').trim() } })
      : await api('/login', { body: { user, pass } });
    TOKEN = r.token;
    localStorage.setItem('wacrm_token', TOKEN);
    state.user = r.user;
    state.kind = r.kind;
    state.accountId = r.accountId;
    state.wa = r.wa;
    state.mustChangePassword = !!r.mustChangePassword;
    state.agent = r.agent || null;
    state.permissions = r.permissions || null;
    state.allowedViews = r.allowedViews || null;
    enterApp();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
}

async function logout(silent) {
  try { if (!silent) await api('/logout', { body: {} }); } catch {}
  TOKEN = '';
  localStorage.removeItem('wacrm_token');
  if (es) { es.close(); es = null; }
  clearInterval(pollTimer);
  location.hash = '';
  showLogin();
}

async function enterApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').textContent = state.user || '';
  const na = $('#nav-admin'); if (na) na.classList.toggle('hidden', state.kind !== 'admin');
  const av = $('#tb-avatar');
  if (av) av.textContent = (state.user || 'A')[0].toUpperCase();
  paintTopbarAvatar(); // usa a foto do perfil conectado quando existir
  applyNavPermissions();   // esconde do menu os módulos sem permissão de visualizar
  startPresence();         // heartbeat de presença (atendente)
  if (window.ECNotify) { ECNotify.setHooks({ onOpen: notifOpenFromData, onResync: notifResync, onChange: paintNotifBell }); paintNotifBell(); }
  askNotifPermission();    // permissão + push do WebApp
  initSearch();
  try { const st = await api('/settings'); state.settings = st.settings; state.wa = st.wa; } catch {}
  connectSSE();
  refreshBadge();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshBadge, 30000);
  if (state.mustChangePassword) toast('Troque a senha padrão em Configurações → Segurança', 'error');
  route();
}

function connectSSE() {
  if (es) es.close();
  es = new EventSource('/api/events?token=' + TOKEN);
  es.addEventListener('message', e => { const d = JSON.parse(e.data || '{}'); maybeNotifyMessage(d); onLive(d); });
  es.addEventListener('status', e => onLive(JSON.parse(e.data || '{}')));
  es.addEventListener('campaign', () => { if (state.view === 'campaigns') paintCampaigns(); });
  // opt-in / opt-out (palavra-chave do cliente, flow ou ação manual)
  es.addEventListener('consent', e => {
    const d = JSON.parse(e.data || '{}');
    if (state.view === 'consent') { loadConsentCfg(); if ($('[data-pane=co-list]')?.classList.contains('show')) loadConsentContacts(); }
    if (state.view === 'inbox' && d.waId === state.currentWaId) loadChat(d.waId, true);
  });
  // atendimento finalizado/reaberto (inclusive pela finalização automática)
  es.addEventListener('attendance', e => {
    const d = JSON.parse(e.data || '{}');
    // novo atendimento aberto por mensagem do cliente → notifica
    if (d.status === 'open' && d.reason === 'inbound' && window.ECNotify) {
      ECNotify.notify({ type: 'attendance', title: 'Novo atendimento', body: (d.name || 'Cliente') + ' iniciou uma conversa', waId: d.waId, url: '/app/#/inbox', tag: 'att:' + d.waId });
    }
    if (state.view !== 'inbox') return;
    loadConversations();
    if (d.waId && d.waId === state.currentWaId) loadChat(d.waId, true);
  });
  // webhook de entrada recebeu um evento (usado pelo modo "aguardar evento")
  es.addEventListener('webhook', e => {
    const d = JSON.parse(e.data || '{}');
    if (typeof whOnEvent === 'function') whOnEvent(d);
  });
  // ligações (Calling API) — tela de chamada estilo WhatsApp
  es.addEventListener('call', e => onCallEvent(JSON.parse(e.data || '{}')));
  // presença de atendentes
  es.addEventListener('presence', () => {
    if (state.view === 'team') paintTeamSide();
    if (state.view === 'agents') loadAgents();
  });
  // conversa atribuída/transferida
  es.addEventListener('assign', e => {
    const d = JSON.parse(e.data || '{}');
    if (state.view === 'inbox') { loadConversations(); if (d.waId === state.currentWaId) loadChat(d.waId, true); }
  });
  // agendamento criado/alterado
  es.addEventListener('schedule', () => { if (state.view === 'schedule') loadSchedule(); });
  // LEMBRETE de agendamento — in-app + Push Notification
  es.addEventListener('reminder', e => {
    const d = JSON.parse(e.data || '{}');
    onReminder(d);
  });
  es.addEventListener('wa_status', () => { refreshBadge(); if (state.view === 'settings') renderSettings(); });
  es.addEventListener('team', e => {
    const d = JSON.parse(e.data || '{}');
    const mine = d.msg && (d.msg.fromId === state.accountId);
    if (state.view === 'team' && d.threadId === state.teamThread) appendTeamMsg(d.msg);
    else if (state.view === 'team') paintTeamSide();
    if (!mine && d.threadId !== state.teamThread) { const b = $('#badge-team'); if (b) { b.textContent = '•'; b.classList.remove('hidden'); } }
  });
}

function onLive(d) {
  refreshBadge();
  if (state.view === 'inbox') {
    loadConversations();
    if (state.currentWaId && (!d.waId || d.waId === state.currentWaId)) loadChat(state.currentWaId, true);
  }
}

async function refreshBadge() {
  try {
    const d = await api('/dashboard');
    const b = $('#badge-unread');
    if (d.unread > 0) { b.textContent = d.unread; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
    const chip = $('#tb-status');
    if (chip) {
      const ok = d.configured.connected;
      chip.className = 'status-chip ' + (ok ? 'on' : 'warn');
      chip.innerHTML = ok ? '<i></i> WhatsApp conectado' : '<i></i> Conectar WhatsApp';
      chip.onclick = () => { location.hash = '#/settings'; };
    }
  } catch {}
}

// ---------- roteamento ----------
const views = {
  dashboard: renderDashboard, inbox: renderInbox, contacts: renderContacts,
  funnel: renderFunnel, campaigns: renderCampaigns, templates: renderTemplates, quick: renderQuick,
  logs: renderLogs, settings: renderSettings, team: renderTeam, flows: renderFlows, links: renderLinks,
  pixels: renderPixels, billing: renderBilling, admin: renderAdmin, webhooks: renderWebhooks,
  consent: renderConsent, agents: renderAgents, 'agents/perf': renderAgentPerf,
  'agents/logs': renderAgentLogs, schedule: renderSchedule,
  reports: () => { location.hash = '#/dashboard'; }, // aba Relatórios foi absorvida pelo Dashboard
  'templates/new': renderTemplateNew, 'campaigns/new': renderCampaignNew,
  'links/new': renderLinkForm, 'links/edit': renderLinkForm, 'links/stats': renderLinkStats
};
// qual item da sidebar destacar para cada view (rotas com "/" caem no pai)
const NAV_OF = {
  'templates/new': 'templates', 'campaigns/new': 'campaigns',
  'links/new': 'links', 'links/edit': 'links', 'links/stats': 'links',
  'agents/perf': 'agents', 'agents/logs': 'agents'
};

// ---------- permissões (front) ----------
// state.permissions === null → dono/admin (acesso total).
function can(moduleKey, action = 'view') {
  if (!state.permissions) return true;
  const p = state.permissions[moduleKey];
  return !!(p && p[action]);
}
// mapeia a view atual (inclui sub-rotas) para o módulo protegido
const VIEW_MODULE = {
  'templates/new': 'templates', 'campaigns/new': 'campaigns',
  'links/new': 'links', 'links/edit': 'links', 'links/stats': 'links',
  'agents/perf': 'agents', 'agents/logs': 'agents',
  billing: null, admin: null, logs: null   // sempre acessíveis (donos/config próprios)
};
function moduleOfView(v) {
  if (v in VIEW_MODULE) return VIEW_MODULE[v];
  return v;
}
// Esconde do menu lateral os módulos sem permissão de visualizar
function applyNavPermissions() {
  // Assinatura e Admin são do DONO/admin — atendentes nunca veem
  const ownerOnly = new Set(['billing', 'admin']);
  $$('.nav-item[data-view]').forEach(n => {
    const v = n.dataset.view;
    if (state.agent && ownerOnly.has(v)) { n.style.display = 'none'; return; }
    const mod = moduleOfView(v);
    n.style.display = (mod === null || can(mod, 'view')) ? '' : 'none';
  });
  // esconde rótulos de grupo que ficaram sem itens visíveis
  $$('.nav-label').forEach(lbl => {
    let el = lbl.nextElementSibling, anyVisible = false;
    while (el && !el.classList.contains('nav-label')) {
      if (el.classList.contains('nav-item') && el.style.display !== 'none') { anyVisible = true; break; }
      el = el.nextElementSibling;
    }
    lbl.style.display = anyVisible ? '' : 'none';
  });
}

window.addEventListener('hashchange', route);
function route() {
  if (!TOKEN) return;
  if (window._fbMove) cleanupBuilder();  // sai do canvas do Flow Builder
  const v = (location.hash || '#/dashboard').replace('#/', '') || 'dashboard';
  let target = views[v] ? v : 'dashboard';
  // guard de permissão no front (o backend valida de novo em cada rota)
  const mod = moduleOfView(target);
  if (mod !== null && !can(mod, 'view')) {
    const home = can('dashboard', 'view') ? 'dashboard' : (state.allowedViews && state.allowedViews[0]) || 'dashboard';
    if (target !== home) { toast('Você não tem acesso a esse módulo', 'error'); location.hash = '#/' + home; return; }
    target = home;
  }
  state.view = target;
  const navKey = NAV_OF[state.view] || state.view;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === navKey));
  updateTopbar();
  views[state.view]();
}

// ---------- dashboard ----------
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

function setDashDays(n) { state.dashDays = n; renderDashboard(); }
function setChartKind(k) { localStorage.setItem('ec_chartkind', k); renderDashboard(); }

async function renderDashboard() {
  const hoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  const dd = state.dashDays || 14;
  const kind = localStorage.getItem('ec_chartkind') || 'bars';
  const segKind = [['bars', 'Barras'], ['line', 'Linhas'], ['area', 'Área']];
  $('#view').innerHTML = `<div class="page">
    <div class="hero-head">
      <div>
        <span class="hh-date">${esc(hoje.charAt(0).toUpperCase() + hoje.slice(1))}</span>
        <h1>${greeting()}, <span class="gt">${esc(state.user || 'admin')}</span></h1>
        <p>Veja o que está acontecendo no seu atendimento agora.</p>
      </div>
      <div class="hh-actions">
        <div class="seg">${[7, 14, 30, 90].map(p => `<button class="${p === dd ? 'on' : ''}" onclick="setDashDays(${p})">${p}d</button>`).join('')}</div>
        <div class="seg">${segKind.map(([k, l]) => `<button class="${k === kind ? 'on' : ''}" title="${l}" onclick="setChartKind('${k}')">${l}</button>`).join('')}</div>
      </div>
    </div>
    <div class="dash-tiles">
      <a class="tile" href="#/inbox"><span class="tile-ic">${ico('message', 19)}</span><b>Conversas</b></a>
      <a class="tile" href="#/contacts"><span class="tile-ic">${ico('users', 19)}</span><b>Novo contato</b></a>
      <a class="tile" href="#/campaigns"><span class="tile-ic">${ico('megaphone', 19)}</span><b>Campanha</b></a>
      <a class="tile" href="#/flows"><span class="tile-ic">${ico('flow', 19)}</span><b>Automação</b></a>
      <a class="tile" href="#/links"><span class="tile-ic">${ico('link', 19)}</span><b>Link rastreável</b></a>
    </div>
    <div id="dash"><div class="card">${skel(6)}</div></div>
  </div>`;
  try {
    const [d, rep] = await Promise.all([api('/dashboard'), api('/reports?days=' + dd)]);
    const cfg = d.configured;
    const check = (ok, label) => `<li>${ok ? '<span class="ok-dot">●</span>' : '<span class="bad-dot">●</span>'} ${label}</li>`;
    const t = rep.totals;
    const pend = Math.max(0, t.out - t.delivered - t.failed);
    const clicksPeriod = (rep.advanced || {}).linkClicks || 0;
    const topFlows = rep.topFlows || [], topLinks = rep.topLinks || [];
    $('#dash').innerHTML = `
      <div class="dash-kpis">
        <div class="stat"><span class="stat-ico">${ico('users', 17)}</span><div class="num">${fmtN(d.contacts)}</div><div class="lbl">Contatos</div></div>
        <div class="stat"><span class="stat-ico">${ico('bell', 17)}</span><div class="num ${d.unread ? 'bad' : ''}">${fmtN(d.unread)}</div><div class="lbl">Não lidas</div></div>
        <div class="stat"><span class="stat-ico">${ico('arrow-up', 17)}</span><div class="num">${fmtN(t.out)}</div><div class="lbl">Enviadas · ${dd}d</div>${spark(rep.days.map(x => x.out), '#10B981', 96, 22)}</div>
        <div class="stat"><span class="stat-ico">${ico('arrow-down', 17)}</span><div class="num">${fmtN(t.in)}</div><div class="lbl">Recebidas · ${dd}d</div>${spark(rep.days.map(x => x.in), '#53BDEB', 96, 22)}</div>
      </div>
      ${dashScheduleCard(d.schedule)}
      ${d.agents ? dashAgentsCard(d.agents) : ''}
      <div class="card svc-card">
        <div class="row" style="align-items:center;margin-bottom:12px">
          <h2 style="margin:0;flex:1">${ico('clock')} Janela de atendimento (24h)</h2>
          <a class="btn small no-grow" href="#/inbox">Ver conversas</a>
        </div>
        <div class="svc-kpis">
          <a class="svc-kpi warn" href="#/inbox"><span class="svc-ic">${ico('alert', 16)}</span><b>${fmtN((d.service || {}).expiringSoon)}</b><span>Próximas de expirar</span></a>
          <a class="svc-kpi crit" href="#/inbox"><span class="svc-ic">${ico('clock', 16)}</span><b>${fmtN((d.service || {}).expired)}</b><span>Com janela encerrada</span></a>
          <a class="svc-kpi ok" href="#/inbox"><span class="svc-ic">${ico('check-circle', 16)}</span><b>${fmtN((d.service || {}).finishedToday)}</b><span>Finalizadas hoje</span></a>
          <a class="svc-kpi" href="#/settings"><span class="svc-ic">${ico('zap', 16)}</span><b>${fmtN((d.service || {}).autoClosedToday)}</b><span>Encerradas automaticamente</span></a>
        </div>
      </div>
      <div class="two-col">
        <div class="card chart-card">
          <div class="row" style="align-items:flex-start;margin-bottom:6px">
            <div style="flex:1">
              <h2 style="margin:0 0 2px">Mensagens no período</h2>
              <span class="big-num">${fmtN(t.out + t.in)}</span><span class="muted" style="font-weight:600;margin-left:8px">${fmtN(t.out)} enviadas · ${fmtN(t.in)} recebidas</span>
            </div>
            <span class="legend"><i style="background:#10B981"></i> Enviadas</span>
            <span class="legend"><i style="background:#53BDEB"></i> Recebidas</span>
          </div>
          ${chVolume(rep.days, kind)}
        </div>
        <div class="card">
          <h2>Status dos envios</h2>
          ${donut([
            { label: 'Lidas', value: t.read, color: '#10B981' },
            { label: 'Entregues', value: Math.max(0, t.delivered - t.read), color: '#34D399' },
            { label: 'Enviadas', value: pend, color: '#A7F3D0' },
            { label: 'Falhas', value: t.failed, color: '#E5484D' }
          ])}
        </div>
      </div>
      <div class="two-col even">
        <div class="card">
          <h2>${ico('columns')} Funil de vendas</h2>
          ${funnelChart(rep.stages || d.stageCounts)}
        </div>
        <div class="card">
          <div class="row" style="align-items:center;margin-bottom:4px">
            <h2 style="margin:0;flex:1">Cliques em links</h2>
            <span class="big-num sm">${fmtN(clicksPeriod)}</span>
          </div>
          ${dayBars(rep.linksByDay || [], '#10B981')}
        </div>
      </div>
      <div class="card svc-card">
        <div class="row" style="align-items:center;margin-bottom:12px">
          <h2 style="margin:0;flex:1">${ico('shield')} Consentimento (Opt-in &amp; Opt-out)</h2>
          <a class="btn small no-grow" href="#/consent">Gerenciar</a>
        </div>
        <div class="svc-kpis">
          <a class="svc-kpi ok" href="#/consent"><span class="svc-ic">${ico('check-circle', 16)}</span><b>${fmtN((d.consent || {}).active)}</b><span>Contatos ativos</span></a>
          <a class="svc-kpi crit" href="#/consent"><span class="svc-ic">${ico('slash', 16)}</span><b>${fmtN((d.consent || {}).optedOut)}</b><span>Em opt-out · ${(d.consent || {}).optOutRate || 0}%</span></a>
          <a class="svc-kpi" href="#/consent"><span class="svc-ic">${ico('arrow-up', 16)}</span><b>${fmtN((d.consent || {}).optInsToday)}</b><span>Novos opt-ins hoje</span></a>
          <a class="svc-kpi warn" href="#/consent"><span class="svc-ic">${ico('arrow-down', 16)}</span><b>${fmtN((d.consent || {}).optOutsToday)}</b><span>Novos opt-outs hoje</span></a>
          <a class="svc-kpi" href="#/consent"><span class="svc-ic">${ico('activity', 16)}</span><b>${coGrowth((d.consent || {}).growthToday)}</b><span>Crescimento diário</span></a>
          <a class="svc-kpi" href="#/consent"><span class="svc-ic">${ico('columns', 16)}</span><b>${coGrowth((d.consent || {}).growthMonth)}</b><span>Crescimento mensal</span></a>
        </div>
      </div>
      <div class="card map-card">
        <div class="row" style="align-items:center;margin-bottom:10px">
          <h2 style="margin:0;flex:1">${ico('target')} Mapa de leads — Brasil</h2>
          <span class="pill" id="geo-total"></span>
        </div>
        <div id="geo-box" class="geo-box">${skel(4)}</div>
      </div>
      <div class="two-col even">
        <div class="card">
          <h2>${ico('flow')} Funis em destaque</h2>
          ${topFlows.length ? `<table><thead><tr><th>Automação</th><th style="text-align:right">Execuções</th><th style="text-align:right">Conclusão</th></tr></thead><tbody>
            ${topFlows.map(f => `<tr><td><b>${esc(f.name)}</b> ${f.enabled ? '' : '<span class="pill">pausado</span>'}</td><td style="text-align:right"><b>${fmtN(f.runs)}</b></td><td style="text-align:right">${f.okRate === null ? '—' : `<span class="pill ${f.okRate >= 80 ? 'done' : 'pending'}">${f.okRate}%</span>`}</td></tr>`).join('')}
          </tbody></table>` : `<p class="muted" style="font-size:13px">Crie automações no <a href="#/flows">Flow Builder</a> para ver o desempenho aqui.</p>`}
        </div>
        <div class="card">
          <h2>${ico('link')} Links em destaque</h2>
          ${topLinks.length ? `<table><thead><tr><th>Link</th><th style="text-align:right">7 dias</th><th style="text-align:right">Total</th></tr></thead><tbody>
            ${topLinks.map(l => `<tr><td><b>${esc(l.title)}</b><div class="muted" style="font-size:11px">/l/${esc(l.slug)}</div></td><td style="text-align:right"><b>${fmtN(l.clicks7d)}</b></td><td style="text-align:right"><b>${fmtN(l.clicks)}</b></td></tr>`).join('')}
          </tbody></table>` : `<p class="muted" style="font-size:13px">Crie <a href="#/links">links rastreáveis</a> para acompanhar os cliques aqui.</p>`}
        </div>
      </div>
      <div class="two-col even">
        <div class="card">
          <h2>${ico('radio')} Eventos de webhook</h2>
          ${dayBars(rep.webhookByDay || [], '#53BDEB')}
        </div>
        <div class="card">
          <h2>${ico('check-circle')} Status da integração</h2>
          <ul class="check-list">
            ${check(cfg.connected, cfg.connected ? 'WhatsApp conectado' : 'WhatsApp não conectado')}
            ${check(cfg.appSubscribed, 'Webhook assinado na WABA')}
            ${check(cfg.appId && cfg.appSecret, 'Plataforma Meta configurada')}
            ${check(!!d.lastWebhookAt, d.lastWebhookAt ? 'Último evento: ' + fmtTime(d.lastWebhookAt) : 'Nenhum evento de webhook ainda')}
          </ul>
          <p class="muted" style="margin:12px 0 0">Configure tudo em <a href="#/settings">Configurações</a>.</p>
        </div>
      </div>`;
    loadGeo();
  } catch (e) {
    $('#dash').innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

async function loadGeo() {
  const box = $('#geo-box'); if (!box) return;
  try {
    const g = await api('/geo');
    const tot = $('#geo-total');
    if (tot) tot.textContent = `${fmtN(g.brTotal)} lead(s) localizados`;
    box.innerHTML = brazilMap3D(g);
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------- inbox ----------
async function renderInbox() {
  $('#view').innerHTML = `
    <div class="inbox">
      <div class="conv-list">
        <div class="conv-head">
          <div class="row"><h1 style="flex:1">Conversas</h1><button class="btn small no-grow" onclick="newChatModal()">${ico('plus', 13)} Nova</button></div>
          <input id="conv-search" placeholder="Buscar contato..." oninput="paintConversations()">
        </div>
        <div class="conv-scroll" id="conv-scroll"></div>
      </div>
      <div class="chat" id="chat-pane">
        <div class="chat-empty"><div class="ce-ic">${ico('message', 44)}</div><p>Selecione uma conversa ao lado<br>ou clique em <b>Nova</b> para iniciar.</p></div>
      </div>
    </div>`;
  await loadConversations();
  if (state.currentWaId) openChat(state.currentWaId);
}

async function loadConversations() {
  try {
    state.conversations = (await api('/conversations')).conversations;
    paintConversations();
  } catch (e) { toast(e.message, 'error'); }
}

function paintConversations() {
  const box = $('#conv-scroll');
  if (!box) return;
  const q = ($('#conv-search')?.value || '').toLowerCase();
  const list = state.conversations.filter(c => !q || (c.name || '').toLowerCase().includes(q) || c.waId.includes(q));
  if (!list.length) {
    box.innerHTML = `<div class="empty-state" style="padding:36px 18px"><div class="big">${ico('message', 34)}</div><b>Nenhuma conversa</b><p class="muted" style="margin:6px 0 14px;font-size:13px">As mensagens recebidas pelo webhook aparecem aqui automaticamente.</p><button class="btn primary small" onclick="newChatModal()">${ico('plus', 13)} Iniciar conversa</button></div>`;
    return;
  }
  box.innerHTML = list.map(c => {
    const lm = c.lastMessage;
    const prev = lm ? (lm.direction === 'out' ? '↗ ' : '') + (lm.text || '[' + lm.type + ']') : 'Sem mensagens';
    return `<div class="conv-item ${c.waId === state.currentWaId ? 'active' : ''} ${convStateCls(c)}" onclick="openChat('${c.waId}')">
      ${avatarHtml(c)}
      <div class="conv-meta">
        <div class="name"><span>${esc(c.name)}</span><time>${timeAgo(c.lastMessageAt)}</time></div>
        <div class="prev"><span style="overflow:hidden;text-overflow:ellipsis">${esc(prev)}</span>${c.unread ? `<b class="badge">${c.unread}</b>` : ''}</div>
        ${convStateTag(c)}
      </div>
    </div>`;
  }).join('');
}

// Marcadores de estado na lista de conversas (janela/atendimento)
function convStateCls(c) {
  const s = c.session; if (!s) return '';
  if (s.attendance.status === 'finished') return 'is-done';
  if (!s.window.open && s.window.lastInboundAt) return 'is-expired';
  return '';
}
function convStateTag(c) {
  const s = c.session; if (!s) return '';
  const w = liveWindow(s);
  if (s.attendance.status === 'finished') return `<span class="conv-tag done">${ico('check-circle', 10)} Finalizada</span>`;
  if (!w.open && w.level !== 'never') return `<span class="conv-tag off">${ico('clock', 10)} Janela encerrada</span>`;
  if (w.level === 'critical') return `<span class="conv-tag crit">${ico('clock', 10)} Expira em ${fmtDur(w.msLeft)}</span>`;
  if (w.level === 'warning') return `<span class="conv-tag warn">${ico('clock', 10)} Expira em ${fmtDur(w.msLeft)}</span>`;
  return '';
}

async function openChat(waId) {
  state.currentWaId = waId;
  paintConversations();
  document.querySelector('.inbox')?.classList.add('chat-open'); // mobile: mostra o chat
  await loadChat(waId);
  api(`/messages/${waId}/read`, { body: {} }).then(loadConversations).catch(() => {});
}

// Mobile: volta da conversa para a lista
function closeChatMobile() {
  document.querySelector('.inbox')?.classList.remove('chat-open');
  clearInterval(sessTicker);
}

async function loadChat(waId, keepScroll) {
  const pane = $('#chat-pane');
  if (!pane) return;
  try {
    const { messages, contact, session: sess, consent: cons } = await api('/messages/' + waId);
    const c = contact || { waId, name: waId };
    state.currentSession = sess || null;
    state.currentConsent = cons || null;
    const prevScroll = $('#chat-scroll');
    const wasBottom = !prevScroll || (prevScroll.scrollHeight - prevScroll.scrollTop - prevScroll.clientHeight < 80);
    const draft = $('#composer-text')?.value || '';
    const locked = sess ? !sess.canSendSession : false;
    pane.innerHTML = `
      <div class="chat-head">
        <button class="icon-btn chat-back" title="Voltar" onclick="closeChatMobile()">${ico('arrowleft', 18)}</button>
        ${avatarHtml(c)}
        <div class="info"><b>${esc(c.name)}</b><span>+${esc(c.waId)} · ${esc(c.stage || '')}</span></div>
        <div class="chat-head-actions" id="sess-actions"></div>
      </div>
      <div id="sess-bar"></div>
      <div class="chat-scroll" id="chat-scroll">
        ${renderThread(messages) || '<p class="muted">Sem mensagens. Fora da janela de 24h só é possível iniciar com um template aprovado.</p>'}
      </div>
      <div class="composer" id="composer">
        <div id="sess-notice"></div>
        <div class="tools">
          <button class="btn small" id="tool-file" onclick="attachFile()">${ico('paperclip', 13)} Anexo</button>
          <button class="btn small" id="tool-tpl" onclick="templateModal('${c.waId}')">${ico('file', 13)} Template</button>
          <button class="btn small" id="tool-btns" onclick="buttonsModal('${c.waId}')">${ico('buttons', 13)} Botões</button>
          <span id="qr-wrap" class="qr-wrap"></span>
        </div>
        <div class="line">
          <textarea id="composer-text" placeholder="Digite uma mensagem... (Enter envia, Shift+Enter quebra linha)"></textarea>
          <button class="btn primary send-btn no-grow" id="send-btn" onclick="sendTextNow()" title="Enviar (Enter)">${ico('send', 18)}</button>
        </div>
        <input type="file" id="file-input" class="hidden" onchange="fileChosen(this)">
      </div>`;
    $('#composer-text').value = draft;
    $('#composer-text').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextNow(); }
    });
    loadQuickIntoSelect();
    paintSession();          // indicador, cronômetro, botões e bloqueio do composer
    startSessionTicker();    // atualização em tempo real (1s)
    const sc = $('#chat-scroll');
    if (!keepScroll || wasBottom) sc.scrollTop = sc.scrollHeight;
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== JANELA DE 24H + ATENDIMENTO (UI) ====================
// O estado vem do backend (state.currentSession); a contagem é recalculada no
// cliente a cada segundo a partir de lastInboundAt/expiresAt — sem polling.
let sessTicker = null;

function fmtDur(ms, withSeconds) {
  ms = Math.max(0, ms);
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}min`;
  if (m > 0) return withSeconds ? `${String(m).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s` : `${m}min`;
  return `${s}s`;
}

// Recalcula a janela no cliente (mesma regra do backend: 24h desde a última recebida)
const WIN_MS = 24 * 60 * 60 * 1000;
function liveWindow(sess) {
  const li = sess && sess.window && sess.window.lastInboundAt;
  if (!li) return { open: false, level: 'never', msLeft: 0, msSinceInbound: null };
  const now = Date.now();
  const msLeft = li + WIN_MS - now;
  const open = msLeft > 0;
  let level = 'expired';
  if (open) level = msLeft <= 15 * 60 * 1000 ? 'critical' : (msLeft <= 60 * 60 * 1000 ? 'warning' : 'open');
  return { open, level, msLeft: Math.max(0, msLeft), msSinceInbound: now - li };
}

const SESS_LEVEL = {
  open: { cls: 'ok', dot: '🟢', label: 'Janela aberta' },
  warning: { cls: 'warn', dot: '🟡', label: 'Janela aberta' },
  critical: { cls: 'crit', dot: '🔴', label: 'Janela aberta' },
  expired: { cls: 'off', dot: '🔴', label: 'Janela encerrada' },
  never: { cls: 'off', dot: '⚪', label: 'Sem janela' }
};

function paintSession() {
  const sess = state.currentSession;
  const actions = $('#sess-actions'), bar = $('#sess-bar'), notice = $('#sess-notice');
  if (!sess || !actions) return;
  const w = liveWindow(sess);
  const finished = sess.attendance.status === 'finished';
  const L = SESS_LEVEL[finished ? 'off' : w.level] || SESS_LEVEL.never;

  // --- Header: indicador da janela + cronômetro de atendimento ---
  bar.innerHTML = `<div class="sess-bar ${finished ? 'done' : L.cls}">
    <div class="sess-chip">
      <span class="sess-dot"></span>
      <div><b id="sess-title">${finished ? 'Atendimento finalizado' : L.label}</b>
        <span id="sess-left">${w.open && !finished ? fmtDur(w.msLeft) + ' restantes' : (w.level === 'never' ? 'aguardando o cliente' : 'apenas templates')}</span></div>
    </div>
    ${w.msSinceInbound !== null ? `<div class="sess-timers">
      <div><span>Cliente respondeu há</span><b id="sess-since">${fmtDur(w.msSinceInbound, true)}</b></div>
      <div><span>Janela expira em</span><b id="sess-exp">${w.open ? fmtDur(w.msLeft) : '—'}</b></div>
    </div>` : ''}
    ${finished ? `<div class="sess-closed">${ico('check-circle', 13)} ${esc(sess.attendance.closeType === 'auto' ? 'Encerrado automaticamente' : 'Encerrado por ' + (sess.attendance.closedBy || 'atendente'))} · ${sess.attendance.closedAt ? new Date(sess.attendance.closedAt).toLocaleString('pt-BR') : ''}</div>` : ''}
  </div>`;

  // --- Header: ações de atendimento ---
  const assigned = state.currentConsent && state.currentConsent.assignedAgent;
  actions.innerHTML = `
    ${assigned ? `<span class="assign-chip" title="Responsável">${agAvatar ? agAvatar(assigned, 22) : ''}<span>${esc(assigned.name)}</span></span>` : ''}
    <button class="btn small" onclick="startCallFromChat()" title="Ligar pelo WhatsApp">${ico('phone', 13)} Ligar</button>
    <button class="btn small" onclick="transferModal('${state.currentWaId}')">${ico('arrowright', 13)} Transferir</button>
    <button class="btn small" onclick="editContactModal('${state.currentWaId}')">${ico('edit', 13)} Editar</button>
    ${finished
      ? `<button class="btn small primary" onclick="reopenAttendance()">${ico('refresh', 13)} Reabrir Atendimento</button>`
      : `<button class="btn small" onclick="finishAttendance()">${ico('check-circle', 13)} Finalizar Atendimento</button>`}`;

  // --- Composer: bloqueio total fora da janela / atendimento finalizado / OPT-OUT ---
  const optedOut = !!(state.currentConsent && state.currentConsent.blocked);
  const locked = finished || !w.open || optedOut;
  const ta = $('#composer-text'), sendBtn = $('#send-btn');
  const file = $('#tool-file'), btns = $('#tool-btns'), qsel = $('#qr-select');
  $('#composer')?.classList.toggle('locked', locked);
  if (ta) {
    ta.disabled = locked;
    ta.placeholder = optedOut
      ? 'Contato em opt-out — reative para voltar a enviar'
      : locked
        ? (finished ? 'Atendimento finalizado — reabra para enviar mensagens' : 'Janela de 24h expirada — envie um Template para reabrir')
        : 'Digite uma mensagem... (Enter envia, Shift+Enter quebra linha)';
  }
  if (sendBtn) sendBtn.disabled = locked;
  if (file) file.disabled = locked;
  if (btns) btns.disabled = locked;
  if (qsel) qsel.disabled = locked;
  // Template só é bloqueado no OPT-OUT (fora da janela ele é justamente a saída)
  const tplBtn = $('#tool-tpl');
  if (tplBtn) tplBtn.disabled = optedOut;

  // Opt-out tem prioridade: bloqueia até template/campanha, não só a janela.
  if (optedOut) {
    notice.innerHTML = `<div class="sess-notice expired">
      ${ico('slash', 15)}
      <div><b>Contato em opt-out.</b> Ele pediu para não receber mais mensagens, então <b>nenhum envio é permitido</b> — nem template, nem campanha. Reative para voltar a conversar.</div>
      <button class="btn small primary no-grow" onclick="coReactivateFromChat('${state.currentWaId}')">${ico('refresh', 12)} Reativar contato</button>
    </div>`;
    return;
  }
  const never = w.level === 'never';
  const title = finished ? 'Atendimento finalizado.' : (never ? 'Este contato ainda não te enviou mensagens.' : 'A janela de 24h expirou.');
  const body = finished
    ? 'Reabra o atendimento para voltar a enviar mensagens, imagens, áudios e documentos.'
    : (never
      ? 'A janela de 24h só abre quando o cliente responde. Para iniciar a conversa, envie um <b>Template aprovado da Meta</b>.'
      : 'Não é possível enviar mensagens comuns, imagens, áudios, vídeos, documentos ou respostas rápidas. <b>Apenas Templates aprovados da Meta</b> podem ser enviados para reabrir a conversa.');
  notice.innerHTML = locked ? `<div class="sess-notice ${finished || never ? '' : 'expired'}">
    ${ico(finished ? 'check-circle' : (never ? 'info' : 'alert'), 15)}
    <div><b>${title}</b> ${body}</div>
    ${finished
      ? `<button class="btn small primary no-grow" onclick="reopenAttendance()">Reabrir</button>`
      : `<button class="btn small primary no-grow" onclick="templateModal('${state.currentWaId}')">${ico('file', 12)} Enviar Template</button>`}
  </div>` : '';
}

// Atualiza os contadores a cada segundo (sem recarregar a conversa)
function startSessionTicker() {
  clearInterval(sessTicker);
  sessTicker = setInterval(() => {
    if (state.view !== 'inbox' || !state.currentSession) return clearInterval(sessTicker);
    const sess = state.currentSession;
    const w = liveWindow(sess);
    const finished = sess.attendance.status === 'finished';
    const since = $('#sess-since'), exp = $('#sess-exp'), left = $('#sess-left');
    if (!since && !left) return;
    if (since && w.msSinceInbound !== null) since.textContent = fmtDur(w.msSinceInbound, true);
    if (exp) exp.textContent = w.open && !finished ? fmtDur(w.msLeft) : '—';
    if (left && !finished) left.textContent = w.open ? fmtDur(w.msLeft) + ' restantes' : 'apenas templates';
    // mudou de faixa (verde→amarelo→vermelho→expirada)? repinta tudo (cores + bloqueio)
    const bar = $('.sess-bar');
    const want = finished ? 'done' : (SESS_LEVEL[w.level] || SESS_LEVEL.never).cls;
    if (bar && !bar.classList.contains(want)) paintSession();
  }, 1000);
}

// Transferência de conversa entre atendentes (com histórico)
function transferModal(waId) {
  const cons = state.currentConsent || {};
  const list = (cons.agents || []).filter(a => !cons.assignedAgent || a.id !== cons.assignedAgent.id);
  if (!list.length) return toast('Nenhum outro atendente disponível', 'error');
  const opts = list.map(a => ({ value: a.id, label: a.name + (a.presence === 'offline' ? ' (offline)' : '') }));
  openModal(`<h2>${ico('arrowright')} Transferir conversa</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">${cons.assignedAgent ? 'Responsável atual: <b>' + esc(cons.assignedAgent.name) + '</b>' : 'Conversa ainda não atribuída.'}</p>
    <label>Transferir para${ecSelect('tr-agent', opts, opts[0].value, null, '')}</label>
    <label style="margin-top:10px">Motivo (opcional)<input id="tr-reason" placeholder="Ex.: especialista no assunto"></label>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="doTransfer('${waId}')">${ico('arrowright', 14)} Transferir</button></div>`);
}
async function doTransfer(waId) {
  try {
    await api(`/conversations/${waId}/transfer`, { body: { agentId: ecSelVal('tr-agent'), reason: $('#tr-reason').value } });
    closeModal(); toast('Conversa transferida'); loadChat(waId, true); loadConversations();
  } catch (e) { toast(e.message, 'error'); }
}

async function finishAttendance() {
  if (!await confirmModal({
    title: 'Finalizar atendimento',
    text: 'A conversa será marcada como Finalizada e o envio de novas mensagens ficará bloqueado até que o atendimento seja reaberto. A data, o horário e o seu nome serão registrados.',
    ok: 'Finalizar atendimento'
  })) return;
  try {
    const r = await api(`/conversations/${state.currentWaId}/finish`, { body: {} });
    state.currentSession = r.session;
    paintSession();
    toast('Atendimento finalizado');
    loadConversations();
  } catch (e) { toast(e.message, 'error'); }
}

// Reativa o contato direto do chat (mesma rota da página de Opt-in & Opt-out)
async function coReactivateFromChat(waId) {
  if (!await confirmModal({ title: 'Reativar contato', text: 'O contato voltará a receber mensagens e campanhas. A reativação fica registrada no histórico com o seu nome.', ok: 'Reativar' })) return;
  try {
    await api(`/consent/${waId}/reactivate`, { body: {} });
    toast('Contato reativado');
    loadChat(waId, true);
    loadConversations();
  } catch (e) { toast(e.message, 'error'); }
}

async function reopenAttendance() {
  try {
    const r = await api(`/conversations/${state.currentWaId}/reopen`, { body: {} });
    state.currentSession = r.session;
    paintSession();
    toast('Atendimento reaberto');
    loadConversations();
  } catch (e) { toast(e.message, 'error'); }
}

function renderThread(messages) {
  let html = '', prevDay = '';
  messages.forEach((m, i) => {
    const dl = dayLabel(m.timestamp);
    if (dl !== prevDay) { html += `<div class="date-sep"><span>${esc(dl)}</span></div>`; prevDay = dl; }
    const next = messages[i + 1];
    const tail = !next || next.direction !== m.direction || dayLabel(next.timestamp) !== dl;
    html += renderMsg(m, tail);
  });
  return html;
}

function renderMsg(m, tail = true) {
  let content = '';
  const mediaSrc = m.media && m.media.id ? `/api/media/${encodeURIComponent(m.media.id)}?token=${TOKEN}` : (m.media && m.media.link) || '';
  if (['image', 'sticker'].includes(m.type) && mediaSrc) content += `<img src="${mediaSrc}" loading="lazy" alt="">`;
  else if (m.type === 'video' && mediaSrc) content += `<video src="${mediaSrc}" controls preload="metadata"></video>`;
  else if (m.type === 'audio' && mediaSrc) content += `<audio src="${mediaSrc}" controls preload="none"></audio>`;
  else if (m.type === 'document' && mediaSrc) content += `<a class="doc" href="${mediaSrc}&dl=${encodeURIComponent(m.media.filename || 'documento')}" target="_blank">${ico('file', 14)} ${esc(m.media.filename || 'Documento')}</a>`;
  if (m.text) content += (content ? '<div>' : '') + esc(m.text) + (content.includes('<img') || content.includes('<video') || content.includes('<audio') || content.includes('doc') ? '</div>' : '');
  if (!content) content = `<span class="muted">[${esc(m.type)}]</span>`;
  return `<div class="msg ${m.direction} ${tail ? 'tail' : ''}">
    ${content}
    <div class="meta"><time>${fmtTime(m.timestamp)}</time>${statusIcon(m)}</div>
  </div>`;
}

function statusIcon(m) {
  if (m.direction !== 'out') return '';
  if (m.status === 'failed') return `<span class="st fail" title="${esc(m.error || 'Falha no envio')}">${ico('alert', 11)} falhou</span>`;
  if (m.status === 'read') return '<span class="st read">✓✓</span>';
  if (m.status === 'delivered') return '<span class="st">✓✓</span>';
  return '<span class="st">✓</span>';
}

async function sendTextNow() {
  const ta = $('#composer-text');
  const text = ta.value.trim();
  if (!text || !state.currentWaId) return;
  ta.value = '';
  try {
    await api('/send/text', { body: { to: state.currentWaId, text } });
    await loadChat(state.currentWaId, true);
    $('#composer-text')?.focus();
    loadConversations();
  } catch (e) {
    ta.value = text;
    toast(e.message, 'error');
  }
}

function attachFile() { $('#file-input').click(); }

function fileChosen(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > 60 * 1024 * 1024) return toast('Arquivo muito grande (máx. 60 MB)', 'error');
  const reader = new FileReader();
  reader.onload = async () => {
    const base64 = reader.result.split(',')[1];
    const kind = file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('video/') ? 'video'
      : file.type.startsWith('audio/') ? 'audio' : 'document';
    try {
      toast('Enviando ' + file.name + '...');
      const up = await api('/media/upload', { body: { filename: file.name, mime: file.type, data: base64 } });
      await api('/send/media', { body: { to: state.currentWaId, kind, mediaId: up.id, filename: file.name } });
      loadChat(state.currentWaId, true);
    } catch (e) { toast(e.message, 'error'); }
  };
  reader.readAsDataURL(file);
}

async function loadQuickIntoSelect() {
  try {
    const { quickReplies } = await api('/quick-replies');
    const wrap = $('#qr-wrap');
    if (!wrap) return;
    const opts = [{ value: '', label: 'Resposta rápida…' }, ...quickReplies.map(q => ({ value: q.text, label: q.title }))];
    wrap.innerHTML = ecSelect('qr-select', opts, '', 'insertQuickVal(val)', 'sm up');
  } catch {}
}

function insertQuickVal(val) {
  if (!val) return;
  const ta = $('#composer-text');
  ta.value = (ta.value ? ta.value + ' ' : '') + val;
  ecSelPick('qr-select', '');   // volta ao placeholder
  ta.focus();
}

function newChatModal() {
  openModal(`
    <h2>Nova conversa</h2>
    <label>Telefone (formato internacional)<input id="nc-phone" placeholder="5511999998888"></label>
    <label>Nome (opcional)<input id="nc-name" placeholder="Maria Silva"></label>
    <p class="hint">Fora da janela de 24h, a primeira mensagem precisa ser um <b>template aprovado</b>.</p>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="createChat()">Abrir conversa</button></div>`);
  $('#nc-phone').focus();
}

async function createChat() {
  try {
    const r = await api('/contacts', { body: { phone: $('#nc-phone').value, name: $('#nc-name').value.trim() } });
    closeModal();
    await loadConversations();
    openChat(r.contact.waId);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- template modal ----------
async function templateModal(waId) {
  openModal(`<h2>${ico('file')} Enviar template</h2><p class="muted">Carregando modelos...</p>`);
  let templates = [];
  try { templates = (await api('/templates')).templates.filter(t => t.status === 'APPROVED'); }
  catch (e) { return openModal(`<h2>${ico('file')} Enviar template</h2><p class="err">${esc(e.message)}</p><button class="btn" onclick="closeModal()">Fechar</button>`); }
  if (!templates.length) {
    return openModal(`<h2>${ico('file')} Enviar template</h2><p class="muted">Nenhum template aprovado. Crie um em <a href="#/templates" onclick="closeModal()">Modelos</a> e aguarde a aprovação da Meta.</p><button class="btn" onclick="closeModal()">Fechar</button>`);
  }
  window._tplList = templates;
  openModal(`
    <h2>${ico('file')} Enviar template</h2>
    <label>Modelo${ecSelect('tpl-select', templates.map((t, i) => ({ value: String(i), label: `${t.name} (${t.language})` })), '0', 'tplChanged()')}</label>
    <div id="tpl-vars"></div>
    <div class="tpl-preview-lbl" style="margin-top:6px">Pré-visualização</div>
    <div id="tpl-preview"></div>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="sendTpl('${waId}')">${ico('send', 14)} Enviar</button></div>`);
  tplChanged();
}

function tplBody(t) {
  const b = (t.components || []).find(c => c.type === 'BODY');
  return (b && b.text) || '';
}

// Extrai as partes de um template aprovado (para preview no celular)
function tplParts(t) {
  const comp = t.components || [];
  const hdr = comp.find(c => c.type === 'HEADER');
  const ft = comp.find(c => c.type === 'FOOTER');
  const btns = comp.find(c => c.type === 'BUTTONS');
  return {
    headerType: (hdr && hdr.format) || '',
    header: hdr && hdr.format === 'TEXT' ? hdr.text : '',
    body: tplBody(t),
    footer: (ft && ft.text) || '',
    buttons: (btns && btns.buttons) || []
  };
}

// Substitui {{1}}, {{2}}… pelos valores informados (para preview realista)
function fillVars(text, vars) {
  return String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => vars[+n - 1] || m);
}

function tplChanged() {
  const t = window._tplList[+ecSelVal('tpl-select')];
  const body = tplBody(t);
  const nVars = (body.match(/\{\{\d+\}\}/g) || []).reduce((max, v) => Math.max(max, +v.replace(/\D/g, '')), 0);
  $('#tpl-vars').innerHTML = nVars
    ? '<span class="fb-sub">Variáveis do corpo</span>' +
      Array.from({ length: nVars }, (_, i) => `<label style="margin-top:2px">{{${i + 1}}}<input class="tpl-var" oninput="tplPreview()" placeholder="Valor da variável ${i + 1}"></label>`).join('')
    : '';
  tplPreview();
}

function tplPreview() {
  const el = $('#tpl-preview'); if (!el) return;
  const t = window._tplList[+ecSelVal('tpl-select')];
  const parts = tplParts(t);
  const vars = $$('.tpl-var').map(i => i.value);
  el.innerHTML = phonePreview({
    headerType: parts.headerType,
    header: fillVars(parts.header, vars), body: fillVars(parts.body, vars), footer: parts.footer,
    buttons: parts.buttons.map(b => ({ type: b.type, text: b.text, url: b.url, phone_number: b.phone_number }))
  }, { highlightVars: false });
}

async function sendTpl(waId) {
  const t = window._tplList[+ecSelVal('tpl-select')];
  const vars = $$('.tpl-var').map(i => i.value);
  const components = vars.length
    ? [{ type: 'body', parameters: vars.map(v => ({ type: 'text', text: v })) }]
    : undefined;
  try {
    await api('/send/template', { body: { to: waId, name: t.name, language: t.language, components } });
    closeModal();
    toast('Template enviado!');
    if (state.view === 'inbox') loadChat(waId, true);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- botões interativos ----------
function buttonsModal(waId) {
  openModal(`
    <h2>${ico('buttons')} Mensagem com botões</h2>
    <label>Texto da mensagem<textarea id="bt-body" placeholder="Escolha uma opção:"></textarea></label>
    <label>Botão 1<input id="bt-1" maxlength="20" placeholder="Sim"></label>
    <label>Botão 2 (opcional)<input id="bt-2" maxlength="20" placeholder="Não"></label>
    <label>Botão 3 (opcional)<input id="bt-3" maxlength="20" placeholder="Falar com atendente"></label>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="sendButtons('${waId}')">Enviar</button></div>`);
}

async function sendButtons(waId) {
  const body = $('#bt-body').value.trim();
  const buttons = ['#bt-1', '#bt-2', '#bt-3'].map(s => $(s).value.trim()).filter(Boolean).map(t => ({ title: t }));
  if (!body || !buttons.length) return toast('Preencha o texto e ao menos 1 botão', 'error');
  try {
    await api('/send/buttons', { body: { to: waId, body, buttons } });
    closeModal();
    if (state.view === 'inbox') loadChat(waId, true);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- contatos ----------
async function renderContacts() {
  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head row">
        <div style="flex:1"><h1>Contatos</h1><p>Leads e clientes do seu WhatsApp</p></div>
        <button class="btn no-grow" onclick="window.open('/api/contacts/export?token=' + TOKEN)" title="CSV com telefones no padrão E.164 aceito pela API">${ico('download-circle', 14)} Exportar CSV</button>
        <button class="btn primary no-grow" onclick="newContactModal()">${ico('plus', 14)} Novo contato</button>
      </div>
      <div class="card">
        <input id="ct-search" placeholder="Buscar por nome, telefone ou tag..." oninput="loadContactsTable()" style="margin-bottom:12px">
        <div id="ct-table"></div>
      </div>
    </div>`;
  loadContactsTable();
}

// Badge de origem do lead (anúncio Click-to-WhatsApp capturado pelo webhook)
function sourceBadge(c) {
  if (!c.source) return '';
  const s = c.source;
  const label = s.type === 'ad' ? 'Anúncio' : s.type === 'post' ? 'Publicação' : 'Origem';
  const tip = [s.headline, s.sourceUrl].filter(Boolean).join(' · ');
  return `<span class="src-badge" title="${esc(tip || 'Click-to-WhatsApp')}">${ico('target', 10)} ${label}</span>`;
}

async function loadContactsTable() {
  try {
    const q = encodeURIComponent($('#ct-search')?.value || '');
    const { contacts } = await api('/contacts?search=' + q);
    const stages = state.settings?.stages || [];
    $('#ct-table').innerHTML = contacts.length ? `
      <table><thead><tr><th>Contato</th><th>Etapa</th><th>Tags</th><th>Última atividade</th><th></th></tr></thead>
      <tbody>${contacts.map(c => `
        <tr>
          <td><div class="cell-user">${avatarHtml(c, 'sm')}<div><b>${esc(c.name)}</b>${sourceBadge(c)}<div class="muted" style="font-size:11.5px">+${esc(c.waId)}</div></div></div></td>
          <td>${ecSelect('qs-' + c.waId, stages.map(s => ({ value: s, label: s })), c.stage, `quickStage('${c.waId}', val)`, 'sm')}</td>
          <td>${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">—</span>'}</td>
          <td class="muted">${timeAgo(c.lastMessageAt)}</td>
          <td style="white-space:nowrap">
            <button class="btn small" title="Abrir conversa" onclick="location.hash='#/inbox';openChat('${c.waId}')">${ico('message', 14)}</button>
            <button class="btn small" title="Editar" onclick="editContactModal('${c.waId}')">${ico('edit', 14)}</button>
            <button class="btn small danger" title="Excluir" onclick="deleteContact('${c.waId}')">${ico('trash', 14)}</button>
          </td>
        </tr>`).join('')}</tbody></table>`
      : '<p class="muted">Nenhum contato. Eles são criados automaticamente quando alguém manda mensagem, ou crie manualmente.</p>';
  } catch (e) { toast(e.message, 'error'); }
}

async function quickStage(waId, stage) {
  try { await api('/contacts/' + waId, { method: 'PUT', body: { stage } }); toast('Etapa atualizada'); }
  catch (e) { toast(e.message, 'error'); }
}

function newContactModal() {
  openModal(`
    <h2>Novo contato</h2>
    <label>Telefone (formato internacional)<input id="nct-phone" placeholder="5511999998888"></label>
    <label>Nome<input id="nct-name" placeholder="Maria Silva"></label>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveNewContact()">Salvar</button></div>`);
}

async function saveNewContact() {
  try {
    await api('/contacts', { body: { phone: $('#nct-phone').value, name: $('#nct-name').value.trim() } });
    closeModal();
    toast('Contato criado');
    loadContactsTable();
  } catch (e) { toast(e.message, 'error'); }
}

async function editContactModal(waId) {
  try {
    const { contact: c } = await api('/messages/' + waId).then(r => ({ contact: r.contact }));
    if (!c) return toast('Contato não encontrado', 'error');
    const stages = state.settings?.stages || [];
    const src = c.source ? `
      <div class="src-card">
        <div class="src-card-h">${ico('target', 14)} Origem do lead${c.source.type === 'ad' ? ' · Anúncio' : c.source.type === 'post' ? ' · Publicação' : ''}</div>
        ${c.source.headline ? `<div class="src-line"><span>Título</span><b>${esc(c.source.headline)}</b></div>` : ''}
        ${c.source.body ? `<div class="src-line"><span>Texto</span><b>${esc(c.source.body.slice(0, 80))}</b></div>` : ''}
        ${c.source.sourceUrl ? `<div class="src-line"><span>URL</span><a href="${esc(c.source.sourceUrl)}" target="_blank" rel="noopener">${esc(c.source.sourceUrl.slice(0, 50))}</a></div>` : ''}
        ${c.source.ctwaClid ? `<div class="src-line"><span>Click ID</span><code>${esc(c.source.ctwaClid.slice(0, 26))}…</code></div>` : ''}
        <div class="src-line"><span>Chegou em</span><b>${new Date(c.source.ts).toLocaleString('pt-BR')}</b></div>
      </div>` : '';
    openModal(`
      <h2>${ico('edit')} ${esc(c.name)}</h2>
      <label>Nome<input id="ec-name" value="${esc(c.name)}"></label>
      <label>E-mail<input id="ec-email" type="email" value="${esc(c.email || '')}" placeholder="cliente@email.com"></label>
      <label>Etapa do funil${ecSelect('ec-stage', stages.map(s => ({ value: s, label: s })), c.stage)}</label>
      <label>Tags (separadas por vírgula)<input id="ec-tags" value="${esc((c.tags || []).join(', '))}"></label>
      <label>Anotações<textarea id="ec-notes">${esc(c.notes || '')}</textarea></label>
      ${src}
      <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveContact('${waId}')">Salvar</button></div>`);
  } catch (e) { toast(e.message, 'error'); }
}

async function saveContact(waId) {
  try {
    await api('/contacts/' + waId, {
      method: 'PUT',
      body: {
        name: $('#ec-name').value,
        email: $('#ec-email')?.value || '',
        stage: ecSelVal('ec-stage'),
        tags: $('#ec-tags').value.split(',').map(t => t.trim()).filter(Boolean),
        notes: $('#ec-notes').value
      }
    });
    closeModal();
    toast('Contato salvo');
    if (state.view === 'contacts') loadContactsTable();
    if (state.view === 'inbox') { loadConversations(); loadChat(waId, true); }
    if (state.view === 'funnel') renderFunnel();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteContact(waId) {
  if (!await confirmModal({ title: 'Excluir contato', text: 'Excluir este contato e todo o histórico de mensagens? Essa ação não pode ser desfeita.', ok: 'Excluir', danger: true })) return;
  try {
    await api('/contacts/' + waId, { method: 'DELETE' });
    toast('Contato excluído');
    if (state.currentWaId === waId) state.currentWaId = null;
    loadContactsTable();
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- funil (kanban) ----------
async function renderFunnel() {
  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Funil de vendas</h1><p>Arraste os cards entre as etapas</p></div>
      <div class="kanban" id="kanban"></div>
    </div>`;
  try {
    const { contacts } = await api('/contacts');
    const stages = state.settings?.stages || [];
    $('#kanban').innerHTML = stages.map(st => {
      const cards = contacts.filter(c => c.stage === st);
      return `<div class="kcol" data-stage="${esc(st)}">
        <h3><span>${esc(st)}</span><span>${cards.length}</span></h3>
        <div class="kbody">
          ${cards.map(c => `
            <div class="kcard" draggable="true" data-waid="${c.waId}" onclick="editContactModal('${c.waId}')">
              <b>${esc(c.name)}</b>
              <div class="sub">+${esc(c.waId)} · ${fmtTime(c.lastMessageAt)}</div>
              ${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('');
    wireKanban();
  } catch (e) { toast(e.message, 'error'); }
}

function wireKanban() {
  let dragged = null;
  $$('.kcard').forEach(card => {
    card.addEventListener('dragstart', () => { dragged = card.dataset.waid; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  $$('.kcol').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      if (!dragged) return;
      try {
        await api('/contacts/' + dragged, { method: 'PUT', body: { stage: col.dataset.stage } });
        renderFunnel();
      } catch (err) { toast(err.message, 'error'); }
      dragged = null;
    });
  });
}

// ---------- templates ----------
async function renderTemplates() {
  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head row">
        <div style="flex:1"><h1>Modelos (Templates)</h1><p>Mensagens aprovadas pela Meta — obrigatórias fora da janela de 24h</p></div>
        <button class="btn no-grow" onclick="syncTemplates()">${ico('refresh', 14)} Sincronizar</button>
        <a class="btn primary no-grow" href="#/templates/new">${ico('plus', 14)} Criar modelo</a>
      </div>
      <div class="card" id="tpl-table">${skel(4)}</div>
    </div>`;
  paintTemplates(false);
}

async function paintTemplates(sync) {
  try {
    const { templates } = await api('/templates' + (sync ? '?sync=1' : ''));
    $('#tpl-table').innerHTML = templates.length ? `
      <table><thead><tr><th>Nome</th><th>Categoria</th><th>Idioma</th><th>Status</th><th>Corpo</th><th></th></tr></thead>
      <tbody>${templates.map(t => `
        <tr>
          <td><b>${esc(t.name)}</b></td>
          <td>${esc(t.category || '')}</td>
          <td>${esc(t.language || '')}</td>
          <td><span class="pill ${esc(t.status)}">${esc(t.status)}</span>${t.rejected_reason && t.rejected_reason !== 'NONE' ? `<div class="muted" style="font-size:11px">${esc(t.rejected_reason)}</div>` : ''}</td>
          <td class="muted" style="max-width:320px;font-size:12.5px">${esc(tplBody(t)).slice(0, 140)}</td>
          <td><button class="btn small danger" title="Excluir" onclick="removeTemplate('${esc(t.name)}')">${ico('trash', 14)}</button></td>
        </tr>`).join('')}</tbody></table>`
      : '<p class="muted">Nenhum modelo. Clique em Sincronizar (exige WABA ID + token) ou crie um novo.</p>';
  } catch (e) {
    $('#tpl-table').innerHTML = `<p class="err">${esc(e.message)}</p><p class="muted">Verifique WABA ID e Access Token em Configurações.</p>`;
  }
}

async function syncTemplates() { toast('Sincronizando com a Meta...'); paintTemplates(true); }

// ============ PREVIEW DE CELULAR (estilo WhatsApp) ============
// Formata *negrito*, _itálico_, ~tachado~ e realça variáveis {{n}}.
function waFmt(text, { highlightVars = true } = {}) {
  let s = esc(text || '');
  s = s.replace(/\*(?!\s)([^*\n]+?)\*/g, '<b>$1</b>')
       .replace(/_(?!\s)([^_\n]+?)_/g, '<i>$1</i>')
       .replace(/~(?!\s)([^~\n]+?)~/g, '<s>$1</s>');
  if (highlightVars) s = s.replace(/\{\{\d+\}\}/g, '<span class="wa-var">$&</span>');
  return s.replace(/\n/g, '<br>');
}

const WA_BTN_IC = {
  URL: '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5"/><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7L12 5.5"/>',
  PHONE_NUMBER: '<path d="M15.5 20.5a13 13 0 0 1-8.4-4A13 13 0 0 1 3 8V6.3A1.3 1.3 0 0 1 4.3 5H7l1.4 3.5-1.8 1.4a10.5 10.5 0 0 0 4.5 4.5l1.4-1.8L16 18v2.7c0 .9-.9 1.5-1.8 1.4z"/>',
  QUICK_REPLY: '<path d="M9 15 4 10l5-5"/><path d="M4 10h10a6 6 0 0 1 6 6v2"/>',
  LIST: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>'
};
function waBtnIcon(type) {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${WA_BTN_IC[type] || WA_BTN_IC.QUICK_REPLY}</svg>`;
}
function waInitials(name) {
  return String(name || 'E').replace(/[^\p{L}\d ]/gu, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || 'E';
}

// Mockup do iPhone (WhatsApp iOS) — 100% dirigido por variáveis:
// data: { headerType: TEXT|IMAGE|VIDEO|DOCUMENT, header, headerMedia(dataURL),
//         headerFilename, body, footer, buttons:[{type,text,url,phone_number}] }
function phonePreview(data, opts = {}) {
  const hl = opts.highlightVars !== false;
  const now = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const hType = (data.headerType || (data.header ? 'TEXT' : '')).toUpperCase();
  const header = (data.header || '').trim();
  const media = data.headerMedia || '';
  const fname = data.headerFilename || 'documento.pdf';
  const body = (data.body || '').trim();
  const footer = (data.footer || '').trim();
  const buttons = data.buttons || [];
  const name = (state.wa && state.wa.verifiedName) || 'Sua Empresa';

  // cabeçalho variável: texto, imagem, vídeo ou documento
  let hdrHtml = '';
  if (hType === 'TEXT' && header) hdrHtml = `<div class="wa-hd">${waFmt(header, { highlightVars: hl })}</div>`;
  else if (hType === 'IMAGE') {
    hdrHtml = `<div class="wa-mhd">${media
      ? `<img src="${esc(media)}" alt="">`
      : `<div class="wa-mhd-ph"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg><span>Imagem</span></div>`}</div>`;
  } else if (hType === 'VIDEO') {
    hdrHtml = `<div class="wa-mhd wa-vid">${media
      ? `<video src="${esc(media)}" muted playsinline></video>`
      : `<div class="wa-mhd-ph dark"><span class="wa-play"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span><span>Vídeo</span></div>`}
      ${media ? `<span class="wa-play ov"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg></span>` : ''}</div>`;
  } else if (hType === 'DOCUMENT') {
    hdrHtml = `<div class="wa-doc">
      <span class="wa-doc-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/></svg></span>
      <div class="wa-doc-tx"><b>${esc(fname)}</b><span>PDF · 1 página</span></div>
    </div>`;
  }

  const bodyHtml = `<div class="wa-bd">${body ? waFmt(body, { highlightVars: hl }) : '<span class="wa-ph">Sua mensagem aparece aqui…</span>'}</div>`;
  const ftHtml = footer ? `<div class="wa-ft">${waFmt(footer, { highlightVars: hl })}</div>` : '';
  // Botões no estilo iOS: presos à bolha, separados por hairline, texto azul
  const btnHtml = buttons.length
    ? `<div class="wa-btns">${buttons.map(b => `<div class="wa-btn">${waBtnIcon(b.type)}<span>${esc(b.text || 'Botão')}</span></div>`).join('')}</div>`
    : '';
  // Mensagem de LISTA: as opções abrem numa folha inferior (preview do menu)
  const rows = data.listRows || null;
  const listHtml = rows && rows.length
    ? `<div class="wa-sheet">
        <div class="wa-sheet-h">Sua avaliação</div>
        ${rows.map(r => `<div class="wa-sheet-row"><span>${esc(r)}</span><i></i></div>`).join('')}
      </div>`
    : '';
  return `<div class="ph-device">
    <div class="ph-island"></div>
    <div class="ph-screen">
      <div class="ph-status">
        <span class="ph-time">9:41</span>
        <span class="ph-sys">
          <svg viewBox="0 0 18 12" width="17" height="11"><rect x="0" y="7" width="3" height="5" rx="1" fill="currentColor"/><rect x="4.5" y="5" width="3" height="7" rx="1" fill="currentColor"/><rect x="9" y="2.5" width="3" height="9.5" rx="1" fill="currentColor"/><rect x="13.5" y="0" width="3" height="12" rx="1" fill="currentColor" opacity=".4"/></svg>
          <svg viewBox="0 0 16 12" width="16" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1 4.2a10 10 0 0 1 14 0"/><path d="M3.3 6.9a6.5 6.5 0 0 1 9.4 0"/><path d="M5.7 9.4a3 3 0 0 1 4.6 0"/><circle cx="8" cy="11" r=".6" fill="currentColor" stroke="none"/></svg>
          <svg viewBox="0 0 26 12" width="24" height="11"><rect x="0.5" y="1" width="21" height="10" rx="2.6" fill="none" stroke="currentColor" stroke-opacity=".4"/><rect x="2" y="2.5" width="18" height="7" rx="1.4" fill="currentColor"/><rect x="23" y="4" width="1.8" height="4" rx=".9" fill="currentColor" opacity=".5"/></svg>
        </span>
      </div>
      <div class="wa-top">
        <svg class="wa-back" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m15 19-7-7 7-7"/></svg>
        <span class="wa-av">${state.wa && state.wa.profilePictureUrl ? `<img src="${esc(state.wa.profilePictureUrl)}" alt="">` : waInitials(name)}</span>
        <div class="wa-top-info"><b>${esc(name)} <svg class="wa-verified" viewBox="0 0 24 24" width="13" height="13" fill="#00A884"><path d="M12 1.8 14.8 4l3.5-.4 1 3.4 3 1.8-1.4 3.2 1.4 3.2-3 1.8-1 3.4-3.5-.4L12 22.2 9.2 20l-3.5.4-1-3.4-3-1.8L3.1 12 1.7 8.8l3-1.8 1-3.4L9.2 4 12 1.8z"/><path d="m8.6 12.2 2.3 2.3 4.6-4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></b><span>conta comercial</span></div>
        <svg class="wa-hicon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m23 7-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="3"/></svg>
        <svg class="wa-hicon" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 20.5a13 13 0 0 1-8.4-4A13 13 0 0 1 3 8V6.3A1.3 1.3 0 0 1 4.3 5H7l1.4 3.5-1.8 1.4a10.5 10.5 0 0 0 4.5 4.5l1.4-1.8L16 18v2.7c0 .9-.9 1.5-1.8 1.4z"/></svg>
      </div>
      <div class="wa-chat">
        <div class="wa-daychip">HOJE</div>
        <div class="wa-card">
          <div class="wa-msg">
            ${hdrHtml}${bodyHtml}${ftHtml}
            <span class="wa-time">${now}</span>
          </div>
          ${btnHtml}
        </div>
        ${listHtml}
      </div>
      <div class="wa-input">
        <svg class="wa-plus" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>
        <div class="wa-bar">
          <span class="wa-ph2"></span>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4 4 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01" stroke-width="2.2"/><path d="M17.5 3.5 21 7M21 3.5 17.5 7" stroke-width="1.8"/></svg>
        </div>
        <svg class="wa-in-ic" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 8.5a2 2 0 0 0-2-2h-2.4l-1-1.7A1.5 1.5 0 0 0 15.3 4H8.7a1.5 1.5 0 0 0-1.3.8l-1 1.7H4a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8.5z"/><circle cx="12" cy="13" r="3.2"/></svg>
        <svg class="wa-in-ic" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3.5"/></svg>
      </div>
      <div class="ph-home"></div>
    </div>
  </div>`;
}

// ============ CRIAÇÃO DE MODELO (com botões e preview) ============
// Regras da Meta: até 10 botões; no máx. 2 de URL e 1 de telefone;
// respostas rápidas (quick reply) vêm sempre antes dos de ação.
let tplBtns = [];
function tplBtnRules() {
  const url = tplBtns.filter(b => b.type === 'URL').length;
  const phone = tplBtns.filter(b => b.type === 'PHONE_NUMBER').length;
  return { total: tplBtns.length, url, phone, canQuick: tplBtns.length < 10, canUrl: tplBtns.length < 10 && url < 2, canPhone: tplBtns.length < 10 && phone < 1 };
}
function orderTplBtns() {
  const order = { QUICK_REPLY: 0, URL: 1, PHONE_NUMBER: 2 };
  tplBtns.sort((a, b) => order[a.type] - order[b.type]);
}

// Cabeçalho do modelo em criação: tipo + arquivo de exemplo (handle da Meta)
let tplHeader = { type: 'NONE', text: '', dataUrl: '', filename: '', mime: '', handle: '', uploading: false };
// Valores de EXEMPLO das variáveis — exigidos pela Meta na aprovação
// (example.header_text / example.body_text na API oficial)
let tplEx = { header: '', body: [] };

// Índice máximo de variável {{n}} num texto
function tplVarCount(text) {
  return (String(text || '').match(/\{\{(\d+)\}\}/g) || []).reduce((m, v) => Math.max(m, +v.replace(/\D/g, '')), 0);
}

// Insere a próxima variável {{n}} na posição do cursor (cabeçalho ou corpo)
function tplInsertVar(target) {
  const el = target === 'header' ? $('#nt-header') : $('#nt-body');
  if (!el) return;
  if (target === 'header' && tplVarCount(el.value) >= 1) return toast('O cabeçalho aceita no máximo 1 variável ({{1}})', 'error');
  const n = target === 'header' ? 1 : tplVarCount(el.value) + 1;
  const token = `{{${n}}}`;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + token + el.value.slice(e);
  el.focus();
  el.selectionStart = el.selectionEnd = s + token.length;
  if (target === 'header') tplHeader.text = el.value;
  renderTplVarExamples();
  renderTplPreview();
}

// Campos de exemplo (header {{1}} + corpo {{1..n}}) — atualizam em tempo real
function renderTplVarExamples() {
  const box = $('#nt-var-ex'); if (!box) return;
  const hVars = tplHeader.type === 'TEXT' ? tplVarCount($('#nt-header')?.value) : 0;
  const bVars = tplVarCount($('#nt-body')?.value);
  tplEx.body = tplEx.body.slice(0, bVars);
  if (!hVars && !bVars) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="var-ex-box">
    <div class="var-ex-head">${ico('sparkles', 13)} Exemplos das variáveis <span class="capi-tag">exigido pela Meta</span></div>
    <p class="muted" style="font-size:11.5px;margin:4px 0 10px">A Meta usa esses valores para avaliar e aprovar o modelo. No disparo, você define os valores reais.</p>
    ${hVars ? `<label style="margin-bottom:8px">Cabeçalho · {{1}}<input value="${esc(tplEx.header)}" oninput="tplEx.header=this.value;renderTplPreview()" placeholder="ex.: Maria"></label>` : ''}
    ${bVars ? Array.from({ length: bVars }, (_, i) => `<label style="margin-bottom:6px">Corpo · {{${i + 1}}}<input value="${esc(tplEx.body[i] || '')}" oninput="tplEx.body[${i}]=this.value;renderTplPreview()" placeholder="ex.: ${['Maria', '20% OFF', 'sexta-feira', 'R$ 97'][i] || 'valor ' + (i + 1)}"></label>`).join('') : ''}
  </div>`;
}
const TPL_HDR_TYPES = [
  { value: 'NONE', label: 'Sem cabeçalho' }, { value: 'TEXT', label: 'Texto' },
  { value: 'IMAGE', label: 'Imagem' }, { value: 'VIDEO', label: 'Vídeo' }, { value: 'DOCUMENT', label: 'Documento (PDF)' }
];
const TPL_HDR_ACCEPT = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: 'application/pdf' };

function tplHdrTypeChanged(type) {
  tplHeader = { type, text: '', dataUrl: '', filename: '', mime: '', handle: '', uploading: false };
  tplEx.header = '';
  paintTplHeader();
  renderTplVarExamples();
  renderTplPreview();
}

function paintTplHeader() {
  const box = $('#nt-hd-extra'); if (!box) return;
  const t = tplHeader.type;
  if (t === 'TEXT') {
    box.innerHTML = `<label style="margin-top:9px">Texto do cabeçalho — aceita 1 variável {{1}}<input id="nt-header" maxlength="60" oninput="tplHeader.text=this.value;renderTplVarExamples();renderTplPreview()" value="${esc(tplHeader.text)}" placeholder="Oferta especial para {{1}}! 🎉"></label>
      <div class="row" style="margin-top:7px"><button type="button" class="btn small ghost no-grow" onclick="tplInsertVar('header')">${ico('plus', 12)} Inserir variável {{1}}</button></div>`;
  } else if (t === 'IMAGE' || t === 'VIDEO' || t === 'DOCUMENT') {
    const lbl = { IMAGE: 'Imagem (JPG/PNG)', VIDEO: 'Vídeo (MP4)', DOCUMENT: 'PDF' }[t];
    box.innerHTML = `
      <div class="hd-media" style="margin-top:9px">
        <input type="file" id="nt-hd-file" accept="${TPL_HDR_ACCEPT[t]}" hidden onchange="tplHdrFile(this)">
        <button class="btn no-grow" onclick="$('#nt-hd-file').click()">${ico('image', 14)} Escolher ${lbl}</button>
        <span class="muted" id="nt-hd-status" style="font-size:12px">${tplHeader.filename
          ? (tplHeader.handle ? `✓ ${esc(tplHeader.filename)} — exemplo enviado à Meta` : esc(tplHeader.filename))
          : 'A Meta exige um arquivo de exemplo para aprovar o modelo.'}</span>
      </div>`;
  } else box.innerHTML = '';
}

// Lê o arquivo, mostra no preview na hora e sobe o exemplo p/ a Meta (handle)
function tplHdrFile(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (f.size > 16 * 1024 * 1024) return toast('Arquivo muito grande (máx. 16 MB)', 'error');
  const reader = new FileReader();
  reader.onload = async () => {
    tplHeader.dataUrl = reader.result;
    tplHeader.filename = f.name;
    tplHeader.mime = f.type;
    tplHeader.handle = '';
    renderTplPreview();
    const st = $('#nt-hd-status');
    if (st) st.textContent = 'Enviando exemplo para a Meta…';
    try {
      const r = await api('/templates/example-upload', { body: { filename: f.name, mime: f.type, data: reader.result } });
      tplHeader.handle = r.handle;
      if (st) st.textContent = `✓ ${f.name} — exemplo enviado à Meta`;
    } catch (e) {
      if (st) st.textContent = `⚠ ${f.name} — falha no envio: ${e.message}`;
      toast(e.message, 'error');
    }
  };
  reader.readAsDataURL(f);
}

function renderTemplateNew() {
  tplBtns = [];
  tplHeader = { type: 'NONE', text: '', dataUrl: '', filename: '', mime: '', handle: '', uploading: false };
  tplEx = { header: '', body: [] };
  $('#view').innerHTML = `<div class="page editor-page">
    <div class="page-head row" style="align-items:center">
      <a class="btn no-grow" href="#/templates">${ico('arrow-up', 14)} Voltar</a>
      <div style="flex:1"><h1>Criar modelo</h1><p>Monte a mensagem, adicione botões e veja o preview em tempo real</p></div>
      <button class="btn primary no-grow" onclick="createTpl()">${ico('send', 14)} Enviar p/ aprovação</button>
    </div>
    <div class="tpl-editor">
      <div class="tpl-form">
        <div class="card">
          <label>Nome do modelo<input id="nt-name" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9_]+/g,'_')" placeholder="boas_vindas_promo"></label>
          <div class="row" style="margin-top:11px">
            <label style="flex:1">Categoria${ecSelect('nt-cat', [{ value: 'MARKETING', label: 'Marketing' }, { value: 'UTILITY', label: 'Utilidade' }, { value: 'AUTHENTICATION', label: 'Autenticação' }], 'MARKETING')}</label>
            <label style="flex:1">Idioma${ecSelect('nt-lang', [{ value: 'pt_BR', label: 'Português (BR)' }, { value: 'en_US', label: 'Inglês (US)' }, { value: 'es', label: 'Espanhol' }], 'pt_BR')}</label>
          </div>
        </div>
        <div class="card">
          <label>Cabeçalho${ecSelect('nt-htype', TPL_HDR_TYPES, 'NONE', 'tplHdrTypeChanged(val)')}</label>
          <div id="nt-hd-extra"></div>
          <label style="margin-top:11px">Corpo (use {{1}}, {{2}}… para variáveis, em sequência)<textarea id="nt-body" rows="4" oninput="renderTplVarExamples();renderTplPreview()" placeholder="Olá {{1}}! Temos uma condição exclusiva para você…"></textarea></label>
          <div class="row" style="margin-top:7px"><button type="button" class="btn small ghost no-grow" onclick="tplInsertVar('body')">${ico('plus', 12)} Inserir variável</button></div>
          <div id="nt-var-ex" style="margin-top:11px"></div>
          <label style="margin-top:11px">Rodapé — opcional<input id="nt-footer" maxlength="60" oninput="renderTplPreview()" placeholder="Responda SAIR para não receber mais"></label>
        </div>
        <div class="card">
          <div class="tpl-btns-head">
            <h2 style="margin:0">${ico('buttons')} Botões</h2>
            <span class="muted" id="nt-btn-count" style="font-size:12px"></span>
          </div>
          <p class="muted" style="font-size:12px;margin:2px 0 12px">Até 10 no total · máx. 2 links · máx. 1 telefone. Respostas rápidas aparecem antes dos botões de ação.</p>
          <div id="nt-btns"></div>
          <div class="row" id="nt-btn-actions" style="gap:7px"></div>
        </div>
        <p class="hint" style="text-align:left">O modelo passa pela aprovação da Meta (minutos a 24h).</p>
      </div>
      <div class="tpl-preview"><div class="tpl-preview-lbl">Pré-visualização</div><div id="tpl-phone"></div></div>
    </div>
  </div>`;
  paintTplHeader();
  renderTplButtons();
  renderTplPreview();
}

function renderTplButtons() {
  const r = tplBtnRules();
  $('#nt-btn-count').textContent = `${r.total}/10`;
  $('#nt-btns').innerHTML = tplBtns.map((b, i) => {
    const typeSel = ecSelect('nt-btype-' + i, [{ value: 'QUICK_REPLY', label: 'Resposta rápida' }, { value: 'URL', label: 'Link (URL)' }, { value: 'PHONE_NUMBER', label: 'Telefone' }], b.type, `tplBtnType(${i},val)`, 'sm');
    const extra = b.type === 'URL'
      ? `<input value="${esc(b.url || '')}" oninput="tplBtnField(${i},'url',this.value)" placeholder="https://…">`
      : b.type === 'PHONE_NUMBER'
      ? `<input value="${esc(b.phone_number || '')}" oninput="tplBtnField(${i},'phone_number',this.value)" placeholder="+5511999998888">`
      : '';
    return `<div class="tpl-btn-row">
      <div class="tpl-btn-line">${typeSel}<input value="${esc(b.text || '')}" maxlength="25" oninput="tplBtnField(${i},'text',this.value)" placeholder="Texto do botão">
      <button class="icon-btn danger" title="Remover" onclick="tplBtnDel(${i})">${ico('trash', 14)}</button></div>
      ${extra ? `<div class="tpl-btn-line">${extra}</div>` : ''}</div>`;
  }).join('');
  const acts = [];
  if (r.canQuick) acts.push(`<button class="btn small" onclick="tplBtnAdd('QUICK_REPLY')">${ico('plus', 12)} Resposta rápida</button>`);
  if (r.canUrl) acts.push(`<button class="btn small" onclick="tplBtnAdd('URL')">${ico('link', 12)} Link</button>`);
  if (r.canPhone) acts.push(`<button class="btn small" onclick="tplBtnAdd('PHONE_NUMBER')">${ico('phone', 12)} Telefone</button>`);
  $('#nt-btn-actions').innerHTML = acts.join('') || '<span class="muted" style="font-size:11.5px">Limite de botões atingido (10 no total · 2 links · 1 telefone).</span>';
}
function tplBtnAdd(type) {
  const r = tplBtnRules();
  if ((type === 'URL' && !r.canUrl) || (type === 'PHONE_NUMBER' && !r.canPhone) || (type === 'QUICK_REPLY' && !r.canQuick)) return;
  tplBtns.push({ type, text: '' });
  orderTplBtns(); renderTplButtons(); renderTplPreview();
}
function tplBtnType(i, type) {
  // impede exceder limites ao trocar o tipo
  const without = tplBtns.filter((_, k) => k !== i);
  const url = without.filter(b => b.type === 'URL').length, phone = without.filter(b => b.type === 'PHONE_NUMBER').length;
  if ((type === 'URL' && url >= 2) || (type === 'PHONE_NUMBER' && phone >= 1)) { toast(type === 'URL' ? 'Máximo de 2 botões de link' : 'Máximo de 1 botão de telefone', 'error'); renderTplButtons(); return; }
  tplBtns[i] = { type, text: tplBtns[i].text || '' };
  orderTplBtns(); renderTplButtons(); renderTplPreview();
}
function tplBtnField(i, k, v) { tplBtns[i][k] = v; renderTplPreview(); }
function tplBtnDel(i) { tplBtns.splice(i, 1); renderTplButtons(); renderTplPreview(); }

// Substitui {{n}} pelo exemplo digitado (vazio mantém o {{n}} destacado)
function fillExamples(text, list) {
  return String(text || '').replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const v = (list[+n - 1] || '').trim();
    return v || m;
  });
}

function renderTplPreview() {
  const el = $('#tpl-phone'); if (!el) return;
  el.innerHTML = phonePreview({
    headerType: tplHeader.type === 'NONE' ? '' : tplHeader.type,
    header: tplHeader.type === 'TEXT' ? fillExamples($('#nt-header')?.value || tplHeader.text, [tplEx.header]) : '',
    headerMedia: tplHeader.dataUrl,
    headerFilename: tplHeader.filename,
    body: fillExamples($('#nt-body')?.value, tplEx.body),
    footer: $('#nt-footer')?.value,
    buttons: tplBtns.map(b => ({ type: b.type, text: b.text, url: b.url, phone_number: b.phone_number }))
  });
}

async function createTpl() {
  const buttons = tplBtns
    .map(b => {
      const o = { type: b.type, text: (b.text || '').trim() };
      if (b.type === 'URL') o.url = (b.url || '').trim();
      if (b.type === 'PHONE_NUMBER') o.phone_number = (b.phone_number || '').trim();
      return o;
    })
    .filter(b => b.text && (b.type === 'QUICK_REPLY' || (b.type === 'URL' && b.url) || (b.type === 'PHONE_NUMBER' && b.phone_number)));
  if (!$('#nt-name').value.trim()) return toast('Dê um nome ao modelo', 'error');
  if (!$('#nt-body').value.trim()) return toast('Escreva o corpo da mensagem', 'error');
  const mediaHdr = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(tplHeader.type);
  if (mediaHdr && !tplHeader.handle) return toast('Envie o arquivo de exemplo do cabeçalho (a Meta exige a amostra)', 'error');
  // validações das variáveis conforme a API oficial
  const hTxt = tplHeader.type === 'TEXT' ? ($('#nt-header')?.value || '').trim() : '';
  const hVars = tplVarCount(hTxt);
  if (hVars > 1) return toast('O cabeçalho aceita no máximo 1 variável ({{1}})', 'error');
  if (hVars === 1 && !tplEx.header.trim()) return toast('Informe o exemplo da variável {{1}} do cabeçalho', 'error');
  const bVars = tplVarCount($('#nt-body').value);
  for (let i = 0; i < bVars; i++) {
    if (!(tplEx.body[i] || '').trim()) return toast(`Informe o exemplo da variável {{${i + 1}}} do corpo`, 'error');
  }
  try {
    await api('/templates', {
      body: {
        name: $('#nt-name').value,
        category: ecSelVal('nt-cat'),
        language: ecSelVal('nt-lang'),
        headerType: mediaHdr ? tplHeader.type : (tplHeader.type === 'TEXT' ? 'TEXT' : ''),
        headerText: hTxt,
        headerHandle: mediaHdr ? tplHeader.handle : '',
        headerExample: tplEx.header.trim(),
        bodyText: $('#nt-body').value.trim(),
        footerText: $('#nt-footer').value.trim(),
        bodyExamples: tplEx.body.map(s => (s || '').trim()),
        buttons
      }
    });
    toast('Modelo enviado para aprovação da Meta!');
    location.hash = '#/templates';
  } catch (e) { toast(e.message + (e.meta && e.meta.error_user_msg ? ' — ' + e.meta.error_user_msg : ''), 'error'); }
}

async function removeTemplate(name) {
  if (!await confirmModal({ title: 'Excluir modelo', text: `O modelo "${name}" será excluído da sua conta na Meta.`, ok: 'Excluir', danger: true })) return;
  try { await api('/templates/' + encodeURIComponent(name), { method: 'DELETE' }); toast('Modelo excluído'); paintTemplates(false); }
  catch (e) { toast(e.message, 'error'); }
}

// ---------- respostas rápidas ----------
async function renderQuick() {
  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Respostas rápidas</h1><p>Atalhos de texto disponíveis no chat</p></div>
      <div class="card">
        <div class="row">
          <label>Título<input id="qk-title" placeholder="Saudação"></label>
          <label style="flex:2">Texto<input id="qk-text" placeholder="Olá! Como posso ajudar?"></label>
          <button class="btn primary no-grow" onclick="addQuick()">+ Adicionar</button>
        </div>
      </div>
      <div class="card" id="qk-list"></div>
    </div>`;
  paintQuick();
}

async function paintQuick() {
  const { quickReplies } = await api('/quick-replies');
  const list = $('#qk-list');
  if (!list) return; // usuário saiu da tela durante o fetch
  list.innerHTML = quickReplies.length
    ? `<table><thead><tr><th>Título</th><th>Texto</th><th></th></tr></thead><tbody>
      ${quickReplies.map(q => `<tr><td><b>${esc(q.title)}</b></td><td class="muted">${esc(q.text)}</td>
      <td><button class="btn small danger" title="Excluir" onclick="delQuick('${q.id}')">${ico('trash', 14)}</button></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nenhuma resposta rápida.</p>';
}

async function addQuick() {
  try {
    await api('/quick-replies', { body: { title: $('#qk-title').value.trim(), text: $('#qk-text').value.trim() } });
    $('#qk-title').value = ''; $('#qk-text').value = '';
    paintQuick();
  } catch (e) { toast(e.message, 'error'); }
}

async function delQuick(id) {
  await api('/quick-replies/' + id, { method: 'DELETE' });
  paintQuick();
}

// ---------- logs ----------
async function renderLogs() {
  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head row">
        <div style="flex:1"><h1>Webhook / Logs</h1><p>Últimos eventos recebidos da Meta (útil para depurar a integração)</p></div>
        <button class="btn no-grow" onclick="renderLogs()">${ico('refresh', 14)} Atualizar</button>
      </div>
      <div id="log-list"><p class="muted">Carregando...</p></div>
    </div>`;
  try {
    const { events } = await api('/webhook-log');
    const icon = { webhook: ico('download-circle', 15), verify_attempt: ico('shield', 15), signature_invalid: ico('slash', 15), process_error: ico('alert', 15) };
    $('#log-list').innerHTML = events.length ? events.map(e => `
      <details class="log">
        <summary>${icon[e.type] || '•'} <b>${esc(e.type)}</b>
          ${e.type === 'verify_attempt' ? (e.ok ? '<span class="ok-dot">verificado ✓</span>' : '<span class="bad-dot">token incorreto ✗</span>') : ''}
          <span class="muted" style="margin-left:auto">${new Date(e.ts).toLocaleString('pt-BR')}</span>
        </summary>
        <pre class="out">${esc(JSON.stringify(e.body || e, null, 2))}</pre>
      </details>`).join('')
      : '<div class="card"><p class="muted">Nenhum evento ainda. Configure a Callback URL no painel da Meta e clique em "Verificar e salvar" — a tentativa aparecerá aqui.</p></div>';
  } catch (e) { $('#log-list').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------- configurações ----------
async function renderSettings() {
  let cfg = {};
  try { cfg = await api('/settings'); state.settings = cfg.settings; state.wa = cfg.wa; } catch (e) { return toast(e.message, 'error'); }
  const s = cfg.settings || {};
  const w = cfg.wa || {};
  const p = cfg.platform || {};
  const m = cfg.manual || {};
  const isAdmin = cfg.kind === 'admin';
  const origin = location.origin;

  const connCard = w.connected ? `
      <div class="card">
        <h2>${ico('check-circle')} WhatsApp conectado</h2>
        <div class="conn-id">
          <div class="pf-avatar sm" id="conn-photo">${w.profilePictureUrl ? `<img src="${esc(w.profilePictureUrl)}" alt="">` : waInitials(w.verifiedName || state.user)}</div>
          <div style="min-width:0">
            <b style="font-size:15px;display:block">${esc(w.verifiedName || 'Perfil do WhatsApp')}</b>
            <span class="muted" style="font-size:12.5px">${esc(w.displayPhoneNumber || '')} · foto e nome que seus clientes veem</span>
          </div>
        </div>
        <div class="wa-status">
          <div class="wa-row"><span>Número</span><b>${esc(w.displayPhoneNumber || '—')}</b></div>
          <div class="wa-row"><span>Nome verificado</span><b>${esc(w.verifiedName || '—')}</b></div>
          <div class="wa-row"><span>WABA ID</span><b>${esc(w.wabaId || '—')}</b></div>
          <div class="wa-row"><span>Business ID</span><b>${esc(w.businessId || '—')}</b></div>
          <div class="wa-row"><span>Webhook assinado</span><b>${w.appSubscribed ? 'Sim' : 'Não'}</b></div>
          <div class="wa-row"><span>Conectado em</span><b>${w.connectedAt ? new Date(w.connectedAt).toLocaleString('pt-BR') : '—'}</b></div>
          <div class="wa-row"><span>Graph API</span><b>${esc(w.graphVersion || 'v25.0')}</b></div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn no-grow" onclick="testConn()">${ico('activity', 14)} Testar conexão</button>
          <button class="btn no-grow" onclick="connectWhatsApp()">${ico('refresh', 14)} Reconectar</button>
          <button class="btn danger no-grow" onclick="disconnectWa()">Desconectar</button>
        </div>
      </div>` : `
      <div class="card wa-connect-hero">
        <div class="wa-hero-ic"><svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" aria-hidden="true"><path d="M12 2C6.5 2 2 6.4 2 11.9c0 1.9.5 3.7 1.5 5.3L2 22l4.9-1.4c1.5.9 3.3 1.4 5.1 1.4 5.5 0 10-4.4 10-9.9S17.5 2 12 2zm0 18.2c-1.6 0-3.2-.5-4.6-1.3l-.33-.2-2.9.83.85-2.8-.22-.34a8.1 8.1 0 0 1-1.3-4.4c0-4.5 3.8-8.2 8.5-8.2s8.5 3.7 8.5 8.2-3.8 8.24-8.5 8.24zm4.7-6.1c-.26-.13-1.5-.75-1.74-.83-.23-.09-.4-.13-.57.13-.17.25-.66.83-.8 1-.15.17-.3.19-.55.06-.26-.13-1.08-.4-2.06-1.28a7.8 7.8 0 0 1-1.43-1.78c-.15-.26-.02-.4.11-.52.12-.12.26-.3.39-.45.13-.15.17-.26.26-.43.09-.17.04-.32-.02-.45-.06-.13-.57-1.4-.79-1.9-.2-.5-.42-.43-.57-.44h-.49c-.17 0-.45.06-.68.32-.23.25-.9.88-.9 2.14s.92 2.49 1.05 2.66c.13.17 1.8 2.77 4.4 3.88.61.27 1.09.42 1.47.54.62.2 1.18.17 1.62.1.5-.07 1.5-.62 1.72-1.22.21-.6.21-1.1.15-1.21-.06-.11-.23-.18-.5-.3z"/></svg></div>
        <h2 style="justify-content:center">Conecte seu WhatsApp</h2>
        <p class="muted" style="max-width:480px;margin:6px auto 18px;text-align:center">
          Clique no botão abaixo e siga o cadastro oficial da Meta na janela que vai abrir.
          Número, conta e webhooks são configurados <b>automaticamente</b> — você não precisa copiar nenhum ID ou token.
        </p>
        <button class="btn primary lg" onclick="connectWhatsApp()">${ico('zap', 16)} Conectar WhatsApp</button>
        <p class="hint" style="margin-top:12px">Embedded Signup oficial · WhatsApp Business Platform (Cloud API ${esc(s.graphVersion || 'v25.0')})</p>
      </div>`;

  const platformCards = !isAdmin ? '' : `
      <div class="card">
        <h2>${ico('key')} Plataforma — Embedded Signup (Tech Provider)</h2>
        <p class="muted" style="margin:0 0 12px">Credenciais do <b>app da Meta da plataforma</b>. Seus clientes nunca preenchem nada — eles só clicam em "Conectar WhatsApp".</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>App ID<input id="pl-appid" value="${esc(p.appId || '')}" placeholder="Painel do app da Meta"></label>
          <label>App Secret<input id="pl-appsecret" type="password" value="${esc(p.appSecret || '')}" placeholder="Configurações do app → Básico"></label>
          <label>Config ID (Embedded Signup)<input id="pl-configid" value="${esc(p.configId || '')}" placeholder="Login do Facebook p/ Empresas → Configurações"></label>
          <label>System User Token (fallback)<input id="pl-systoken" type="password" value="${esc(p.systemToken || '')}" placeholder="Opcional"></label>
          <label>Versão da Graph API${ecSelect('pl-version', ['v25.0', 'v24.0', 'v23.0', 'v22.0', 'v21.0'].map(v => ({ value: v, label: v })), p.graphVersion || 'v25.0')}</label>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn primary no-grow" onclick="savePlatform()">${ico('save', 14)} Salvar plataforma</button>
        </div>
      </div>

      <div class="card">
        <h2>${ico('link')} Webhook (cole no painel da Meta)</h2>
        <p class="muted" style="margin:0 0 10px">No app da Meta: <b>WhatsApp → Configuração → Webhook</b>. A URL precisa ser <b>pública com HTTPS</b>. Assine os campos: <code>messages</code>, <code>message_template_status_update</code>, <code>phone_number_quality_update</code>, <code>account_update</code>.</p>
        <label>Callback URL</label>
        <div class="copy-box"><code id="wh-url">${esc(origin)}/webhook</code><button class="btn small" onclick="copyText($('#wh-url').textContent)">Copiar</button></div>
        <label style="margin-top:10px">Verify Token</label>
        <div class="copy-box"><code id="wh-token">${esc(p.verifyToken || '')}</code>
          <button class="btn small" onclick="copyText($('#wh-token').textContent)">Copiar</button>
          <button class="btn small" onclick="regenToken()">${ico('refresh', 13)} Gerar novo</button>
        </div>
      </div>

      <details class="card adv">
        <summary><h2>${ico('shield')} Credenciais manuais (avançado)</h2></summary>
        <p class="muted" style="margin:8px 0 12px">Alternativa ao Embedded Signup para a conta do administrador (testes e desenvolvimento).</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Access Token<textarea id="st-token" rows="2">${esc(m.accessToken || '')}</textarea></label>
          <label>WABA ID<input id="st-waba" value="${esc(m.wabaId || '')}"></label>
          <label>Phone Number ID<input id="st-phoneid" value="${esc(m.phoneNumberId || '')}"></label>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary no-grow" onclick="saveManual()">${ico('save', 14)} Salvar manuais</button>
          <button class="btn no-grow" onclick="subscribeWaba()">${ico('radio', 14)} Assinar app na WABA</button>
        </div>
      </details>`;

  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Configurações</h1><p>${isAdmin ? 'Conexão do WhatsApp, plataforma e administração' : 'Conexão do WhatsApp e preferências'}</p></div>

      <div class="tabs">
        <button class="active" data-tab="conexao" onclick="showSettingsTab('conexao')">Conexão & API</button>
        <button data-tab="numero" onclick="showSettingsTab('numero')">Número & Perfil</button>
        <button data-tab="atendimento" onclick="showSettingsTab('atendimento')">Atendimento</button>
        <button data-tab="finalizacao" onclick="showSettingsTab('finalizacao')">Finalização</button>
        <button data-tab="prefs" onclick="showSettingsTab('prefs')">Preferências</button>
      </div>

      <div class="tabpane" data-pane="finalizacao">
        <div id="sv-box">${skel(5)}</div>
      </div>

      <div class="tabpane" data-pane="atendimento">
        <div class="card">
          <h2>${ico('clock')} Janela de atendimento de 24h</h2>
          <p class="muted" style="margin:0;font-size:13px">Pela regra da Meta, você só pode enviar mensagens livres (texto, imagens, áudios, vídeos, documentos e respostas rápidas) <b>dentro de 24h</b> após a última mensagem do cliente. Fora dela, o EliteChat bloqueia o envio automaticamente e libera <b>apenas Templates aprovados</b>, que reabrem a conversa.</p>
        </div>
        <div class="card">
          <h2>${ico('check-circle')} Finalização automática</h2>
          <p class="muted" style="margin:0 0 14px;font-size:13px">Encerra sozinho os atendimentos parados há muito tempo, registrando que a finalização foi automática.</p>
          <label class="chk"><input type="checkbox" id="sv-auto" onchange="saveService()"> Ativar finalização automática por inatividade</label>
          <div class="row" style="margin-top:14px;align-items:flex-end">
            <label style="flex:1;max-width:280px">Tempo de inatividade${ecSelect('sv-min', [
              { value: '30', label: '30 minutos' }, { value: '60', label: '1 hora' }, { value: '120', label: '2 horas' },
              { value: '360', label: '6 horas' }, { value: '720', label: '12 horas' }, { value: '1440', label: '24 horas' }
            ], '60', 'saveService()')}</label>
            <span class="muted" id="sv-status" style="font-size:12.5px;padding-bottom:10px"></span>
          </div>
        </div>
        <a class="card link-card" href="#" onclick="showSettingsTab('finalizacao');return false">
          <span class="lc-ic">${ico('sparkles', 22)}</span>
          <div style="flex:1"><h2 style="margin:0 0 3px">Pesquisa de satisfação</h2>
            <p class="muted" style="margin:0;font-size:13px">Monte a mensagem e as notas enviadas ao cliente quando o atendimento for finalizado — na aba <b>Finalização</b>.</p></div>
          <span class="lc-arrow">${ico('arrowright', 18)}</span>
        </a>
      </div>

      <div class="tabpane show" data-pane="conexao">
      ${connCard}
      ${platformCards}
      <div class="card"><h2>${ico('activity')} Diagnóstico</h2>
        <div class="row" style="margin-bottom:10px">
          <button class="btn no-grow" onclick="testConn()">${ico('activity', 14)} Testar conexão</button>
          <button class="btn no-grow" onclick="runDiag('/debug-token')">${ico('shield', 14)} Validar token</button>
          <button class="btn no-grow" onclick="runDiag('/waba')">Ver WABA + números</button>
          <button class="btn no-grow" onclick="runDiag('/waba/subscriptions')">Ver assinaturas</button>
        </div>
        <pre class="out" id="diag-out">O resultado das chamadas à Graph API aparece aqui.</pre>
      </div>
      </div>

      <div class="tabpane" data-pane="numero">
      <div class="card">
        <h2>${ico('briefcase')} Perfil comercial do WhatsApp</h2>
        <div class="pf-photo-row">
          <div class="pf-avatar" id="pf-photo">${waInitials((state.wa && state.wa.verifiedName) || state.user)}</div>
          <div style="flex:1;min-width:0">
            <b style="font-size:13.5px">Foto do perfil</b>
            <p class="muted" style="margin:2px 0 8px;font-size:12.5px">É a foto que seus clientes veem no WhatsApp. O EliteChat também a usa no topo do painel e nos previews.</p>
            <input type="file" id="pf-photo-file" accept="image/jpeg,image/png" hidden onchange="changeProfilePhoto(this)">
            <div class="row" style="gap:8px">
              <button class="btn small no-grow" onclick="$('#pf-photo-file').click()">${ico('image', 13)} Trocar foto</button>
              <span class="muted" id="pf-photo-status" style="font-size:12px"></span>
            </div>
          </div>
        </div>
        <div class="row" style="margin-bottom:10px"><button class="btn no-grow" onclick="loadProfile()">Carregar perfil atual</button></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label>Recado (about)<input id="pf-about"></label>
          <label>E-mail<input id="pf-email"></label>
          <label>Endereço<input id="pf-address"></label>
          <label>Segmento (vertical)${ecSelect('pf-vertical', [['', 'Selecione…'], ['OTHER', 'Outro'], ['AUTO', 'Automotivo'], ['BEAUTY', 'Beleza'], ['APPAREL', 'Vestuário'], ['EDU', 'Educação'], ['ENTERTAIN', 'Entretenimento'], ['EVENT_PLAN', 'Eventos'], ['FINANCE', 'Finanças'], ['GROCERY', 'Mercado'], ['GOVT', 'Governo'], ['HOTEL', 'Hotelaria'], ['HEALTH', 'Saúde'], ['NONPROFIT', 'ONG'], ['PROF_SERVICES', 'Serviços'], ['RETAIL', 'Varejo'], ['TRAVEL', 'Viagens'], ['RESTAURANT', 'Restaurante']].map(([v, l]) => ({ value: v, label: l })), '')}</label>
          <label style="grid-column:1/-1">Descrição<textarea id="pf-desc" rows="2"></textarea></label>
          <label style="grid-column:1/-1">Sites (um por linha, máx. 2)<textarea id="pf-sites" rows="2"></textarea></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary no-grow" onclick="saveProfile()">${ico('save', 14)} Salvar perfil</button></div>
      </div>

      <div class="card">
        <h2>${ico('phone')} Ligações no WhatsApp</h2>
        <p class="muted" style="margin:0 0 12px;font-size:13px">Com a <b>API oficial de chamadas da Meta</b> habilitada, o botão de ligação aparece no seu perfil e seus clientes podem te ligar de graça pelo WhatsApp. As chamadas chegam no sistema que você conectar à Calling API.</p>
        <div class="row" style="align-items:center">
          <label class="chk"><input type="checkbox" id="cl-toggle" onchange="toggleCalling(this.checked)"> Habilitar ligações neste número</label>
          <button class="btn small no-grow" onclick="loadCalling()">${ico('refresh', 13)} Ver status</button>
        </div>
        <p class="muted" id="cl-status" style="font-size:12.5px;margin:10px 0 0"></p>
        <p class="muted" style="font-size:11.5px;margin:10px 0 0">${ico('shield', 12)} Sobre fotos de contatos: a Meta não expõe a foto de perfil dos seus clientes pela API oficial (privacidade) — por isso os avatares deles usam iniciais. A foto do <b>seu</b> perfil conectado aparece normalmente.</p>
      </div>

      <div class="card">
        <h2>${ico('gear')} Registro / verificação do número</h2>
        <p class="muted" style="margin:0 0 12px">Necessário apenas para números próprios ainda não registrados na Cloud API.</p>
        <div class="row">
          <label>Método${ecSelect('ph-method', [{ value: 'SMS', label: 'SMS' }, { value: 'VOICE', label: 'Chamada de voz' }], 'SMS')}</label>
          <button class="btn no-grow" onclick="phoneAction('request-code',{method:ecSelVal('ph-method')})">1. Solicitar código</button>
          <label>Código recebido<input id="ph-code" placeholder="123456"></label>
          <button class="btn no-grow" onclick="phoneAction('verify-code',{code:$('#ph-code').value})">2. Verificar código</button>
        </div>
        <div class="row" style="margin-top:10px">
          <label>PIN (verificação em 2 etapas, 6 dígitos)<input id="ph-pin" placeholder="000000"></label>
          <button class="btn no-grow" onclick="phoneAction('register',{pin:$('#ph-pin').value})">3. Registrar número</button>
          <button class="btn danger no-grow" onclick="confirmDeregister()">Desregistrar</button>
        </div>
      </div>

      </div>

      <div class="tabpane" data-pane="prefs">
      <div class="card" id="notif-card">${renderNotifSettings()}</div>

      <a class="card link-card" href="#/pixels">
        <span class="lc-ic">${ico('target', 22)}</span>
        <div style="flex:1"><h2 style="margin:0 0 3px">Pixels &amp; rastreamento</h2>
          <p class="muted" style="margin:0;font-size:13px">Configure os pixels da Meta, Google e TikTok, a Conversions API e o domínio dos links — agora em página própria.</p></div>
        <span class="lc-arrow">${ico('arrowright', 18)}</span>
      </a>

      <div class="card">
        <h2>${ico('columns')} Etapas do funil</h2>
        <label>Uma etapa por linha<textarea id="st-stages" rows="5">${esc((s.stages || []).join('\n'))}</textarea></label>
        <div class="row" style="margin-top:10px"><button class="btn primary no-grow" onclick="saveStages()">${ico('save', 14)} Salvar etapas</button></div>
      </div>

      <div class="card">
        <h2>${ico('lock')} Segurança — senha de acesso ${state.mustChangePassword ? '<span class="bad-dot">(troque a senha padrão!)</span>' : ''}</h2>
        <div class="row">
          <label>Senha atual<input id="pw-cur" type="password"></label>
          <label>Nova senha (mín. 6)<input id="pw-new" type="password"></label>
          <button class="btn primary no-grow" onclick="changePass()">Alterar senha</button>
        </div>
      </div>
      </div>
    </div>`;
  paintProfilePhoto();
  loadService();
  loadSurvey();
  if (state.wa && state.wa.connected) { loadCalling(); loadProfile(true); }
}

// ==================== FINALIZAÇÃO → PESQUISA DE SATISFAÇÃO ====================
// Cada nota vira um botão. Regra da Meta: até 3 notas → botões interativos;
// acima disso → lista. O formato troca sozinho conforme você adiciona notas.
let svCfg = null;   // { enabled, message, footer, listButton, notes[] }
let svMeta = null;  // { format, limits, metrics }

async function loadSurvey() {
  const box = $('#sv-box'); if (!box) return;
  try {
    const d = await api('/settings/survey');
    svCfg = d.survey;
    svMeta = { format: d.format, limits: d.limits, metrics: d.metrics };
    paintSurvey();
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

function svFormat() {
  const n = (svCfg.notes || []).filter(x => (x.label || '').trim()).length;
  return n <= svMeta.limits.maxButtons ? 'buttons' : 'list';
}
function svTitleMax() {
  return svFormat() === 'buttons' ? svMeta.limits.btnTitleMax : svMeta.limits.rowTitleMax;
}

function paintSurvey() {
  const box = $('#sv-box'); if (!box || !svCfg) return;
  const fmt = svFormat();
  const notes = svCfg.notes || [];
  const max = svTitleMax();
  const m = svMeta.metrics || {};
  const full = notes.length >= svMeta.limits.maxRows;

  box.innerHTML = `
    <div class="sv-grid">
      <div class="sv-form">
        <div class="card">
          <h2>${ico('sparkles')} Pesquisa de satisfação</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Enviada automaticamente ao <b>finalizar o atendimento</b> (manual ou automático), enquanto a janela de 24h estiver aberta.</p>
          <label class="chk"><input type="checkbox" id="sv-on" ${svCfg.enabled ? 'checked' : ''} onchange="svSet('enabled', this.checked)"> Enviar pesquisa ao finalizar o atendimento</label>
        </div>

        <div class="card">
          <h2>${ico('file')} Modelo da mensagem</h2>
          <label>Mensagem<textarea id="sv-msg" rows="3" maxlength="1024" oninput="svSet('message', this.value)" placeholder="Como você avalia o nosso atendimento?">${esc(svCfg.message || '')}</textarea></label>
          <label style="margin-top:11px">Rodapé — opcional<input id="sv-ft" maxlength="60" value="${esc(svCfg.footer || '')}" oninput="svSet('footer', this.value)" placeholder="Sua opinião nos ajuda a melhorar"></label>
          ${fmt === 'list' ? `<label style="margin-top:11px">Texto do botão que abre a lista<input id="sv-lb" maxlength="${svMeta.limits.btnTitleMax}" value="${esc(svCfg.listButton || '')}" oninput="svSet('listButton', this.value)" placeholder="Avaliar atendimento"></label>` : ''}
        </div>

        <div class="card">
          <div class="row" style="align-items:center;margin-bottom:4px">
            <h2 style="margin:0;flex:1">${ico('buttons')} Notas</h2>
            <span class="pill ${fmt === 'buttons' ? 'done' : ''}">${fmt === 'buttons' ? 'Botões' : 'Lista'} · ${notes.length}/${svMeta.limits.maxRows}</span>
          </div>
          <p class="muted" style="font-size:12px;margin:2px 0 12px">
            Cada nota vira um botão. <b>Até ${svMeta.limits.maxButtons} notas</b> a Meta envia como <b>botões</b>; a partir de ${svMeta.limits.maxButtons + 1} vira <b>lista</b> (máx. ${svMeta.limits.maxRows}). Limite atual: ${max} caracteres por nota.
          </p>
          <div id="sv-notes">${svNotesHtml()}</div>
          <div class="row" style="margin-top:9px">
            <button class="btn small no-grow" ${full ? 'disabled' : ''} onclick="svAddNote()">${ico('plus', 12)} Adicionar nota</button>
            ${full ? `<span class="muted" style="font-size:11.5px">Limite de ${svMeta.limits.maxRows} notas atingido.</span>` : ''}
          </div>
        </div>

        <div class="row" style="justify-content:flex-end">
          <button class="btn primary no-grow" onclick="saveSurvey()">${ico('save', 14)} Salvar pesquisa</button>
        </div>

        ${m.answered ? `<div class="card">
          <h2>${ico('activity')} Respostas</h2>
          <div class="lk-kpis">
            <div><b>${fmtN(m.answered)}</b><span>Respondidas</span></div>
            <div><b>${fmtN(m.answeredToday)}</b><span>Hoje</span></div>
            <div><b>${m.avgPercent === null ? '—' : m.avgPercent + '%'}</b><span>Satisfação média</span></div>
          </div>
          ${(m.distribution || []).length ? `<div style="margin-top:12px">${m.distribution.map(x => hrow(esc(x.label), x.count, m.distribution[0].count)).join('')}</div>` : ''}
        </div>` : ''}
      </div>

      <div class="tpl-preview">
        <div class="tpl-preview-lbl">Como o cliente vê</div>
        <div id="sv-phone"></div>
      </div>
    </div>`;
  svPreview();
}

function svNotesHtml() {
  const max = svTitleMax();
  return (svCfg.notes || []).map((n, i) => {
    const len = (n.label || '').length;
    return `<div class="sv-note">
      <span class="sv-num">${i + 1}</span>
      <input value="${esc(n.label || '')}" maxlength="${max}" oninput="svNoteLabel(${i}, this.value)" placeholder="Ex.: 🤩 Excelente">
      <span class="sv-count ${len > max ? 'over' : ''}">${len}/${max}</span>
      <button class="icon-btn danger" title="Remover" onclick="svDelNote(${i})">${ico('trash', 13)}</button>
    </div>`;
  }).join('') || '<p class="muted" style="font-size:12.5px;margin:0">Nenhuma nota. Adicione pelo menos uma.</p>';
}

function svSet(k, v) { svCfg[k] = v; svPreview(); }
function svNoteLabel(i, v) {
  const before = svFormat();
  svCfg.notes[i].label = v;
  // preencher/esvaziar um rótulo pode cruzar o limite de 3 notas válidas e
  // trocar o formato (botões ↔ lista) — nesse caso a tela inteira é repintada
  if (svFormat() !== before) { paintSurvey(); $$('.sv-note')[i]?.querySelector('input')?.focus(); return; }
  const c = $$('.sv-note')[i]?.querySelector('.sv-count');
  if (c) { const max = svTitleMax(); c.textContent = `${v.length}/${max}`; c.classList.toggle('over', v.length > max); }
  svPreview();
}
function svAddNote() {
  svCfg.notes = svCfg.notes || [];
  if (svCfg.notes.length >= svMeta.limits.maxRows) return;
  const before = svFormat();
  svCfg.notes.push({ id: 'n' + Date.now().toString(36), label: '' });
  // ao cruzar 3 notas o formato muda (botões → lista): repinta a tela inteira
  if (svFormat() !== before) paintSurvey();
  else { $('#sv-notes').innerHTML = svNotesHtml(); svPreview(); }
}
function svDelNote(i) {
  const before = svFormat();
  svCfg.notes.splice(i, 1);
  if (svFormat() !== before) paintSurvey();
  else { $('#sv-notes').innerHTML = svNotesHtml(); svPreview(); }
}

// Preview no mockup do iPhone (mesmo componente dos templates/campanhas)
function svPreview() {
  const el = $('#sv-phone'); if (!el) return;
  const notes = (svCfg.notes || []).filter(n => (n.label || '').trim());
  const fmt = svFormat();
  el.innerHTML = phonePreview({
    body: svCfg.message,
    footer: svCfg.footer,
    buttons: fmt === 'buttons'
      ? notes.map(n => ({ type: 'QUICK_REPLY', text: n.label }))
      : [{ type: 'LIST', text: svCfg.listButton || 'Avaliar' }],
    listRows: fmt === 'list' ? notes.map(n => n.label) : null
  }, { highlightVars: false });
}

async function saveSurvey() {
  try {
    const d = await api('/settings/survey', { method: 'PUT', body: svCfg });
    svCfg = d.survey;
    svMeta = { format: d.format, limits: d.limits, metrics: d.metrics };
    paintSurvey();
    toast(`Pesquisa salva — será enviada como ${d.format === 'buttons' ? 'botões' : 'lista'}`);
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Configurações → Atendimento (finalização automática) ----
async function loadService() {
  try {
    const { service } = await api('/settings/service');
    const ac = service.autoClose || {};
    const cb = $('#sv-auto'); if (cb) cb.checked = !!ac.enabled;
    ecSelPick('sv-min', String(ac.minutes || 60));
    const st = $('#sv-status');
    if (st) st.textContent = ac.enabled ? 'Atendimentos parados serão finalizados automaticamente.' : 'Desativada — os atendimentos só são finalizados manualmente.';
  } catch {}
}
async function saveService() {
  try {
    const { service } = await api('/settings/service', {
      method: 'PUT',
      body: { autoClose: { enabled: $('#sv-auto').checked, minutes: Number(ecSelVal('sv-min')) } }
    });
    const ac = service.autoClose;
    const st = $('#sv-status');
    if (st) st.textContent = ac.enabled ? 'Atendimentos parados serão finalizados automaticamente.' : 'Desativada — os atendimentos só são finalizados manualmente.';
    toast('Configuração de atendimento salva');
  } catch (e) { toast(e.message, 'error'); }
}

async function savePlatform() {
  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        appId: $('#pl-appid').value,
        appSecret: $('#pl-appsecret').value,
        configId: $('#pl-configid').value,
        systemToken: $('#pl-systoken').value,
        graphVersion: ecSelVal('pl-version')
      }
    });
    toast('Configurações da plataforma salvas!');
  } catch (e) { toast(e.message, 'error'); }
}

async function saveManual() {
  try {
    await api('/settings', {
      method: 'PUT',
      body: {
        accessToken: $('#st-token').value,
        wabaId: $('#st-waba').value,
        phoneNumberId: $('#st-phoneid').value
      }
    });
    toast('Credenciais manuais salvas!');
    refreshBadge();
    renderSettings();
  } catch (e) { toast(e.message, 'error'); }
}

// ---- pixels (CRUD) ----
const PIXEL_LBL = { meta: 'Meta Pixel', gtag: 'Google tag', tiktok: 'TikTok Pixel' };
const PIXEL_ICON = { meta: 'target', gtag: 'globe', tiktok: 'zap' };

function pixelsTableHtml(pixels) {
  if (!pixels.length) return '<p class="muted" style="font-size:13px;margin:0">Nenhum pixel cadastrado ainda.</p>';
  return `<table><thead><tr><th>Plataforma</th><th>Nome</th><th>ID</th><th>Evento</th><th>Rastreamento</th><th></th></tr></thead><tbody>
    ${pixels.map(p => `<tr>
      <td><span class="pill">${ico(PIXEL_ICON[p.type] || 'target', 12)} ${PIXEL_LBL[p.type] || p.type}</span></td>
      <td><b>${esc(p.name)}</b></td>
      <td><code>${esc(p.pixelId)}</code></td>
      <td>${esc(p.defaultEvent || 'PageView')}</td>
      <td>${p.type === 'meta' && p.capiToken
        ? '<span class="pill done">Navegador + Servidor</span>'
        : '<span class="pill">Navegador</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="icon-btn" title="Editar" onclick="openPixelForm('${p.id}')">${ico('edit', 14)}</button>
        <button class="icon-btn danger" title="Excluir" onclick="delPixel('${p.id}')">${ico('trash', 14)}</button>
      </td>
    </tr>`).join('')}</tbody></table>`;
}

async function paintPixels() {
  const box = $('#px-list'); if (!box) return;
  try { const { pixels } = await api('/pixels'); box.innerHTML = pixelsTableHtml(pixels); } catch {}
}

const CONV_EVENTS = ['PageView', 'ViewContent', 'Lead', 'Contact', 'InitiateCheckout', 'Subscribe', 'CompleteRegistration', 'Purchase'];
const PIXEL_ID_PH = { meta: 'ex.: 123456789012345', gtag: 'ex.: G-XXXXXXX ou AW-XXXXXXX', tiktok: 'ex.: C4A1B2C3D4E5F6' };

// ==================== PIXELS (página dedicada) ====================
async function renderPixels() {
  let cfg = {};
  try { cfg = await api('/settings'); } catch {}
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Pixels &amp; rastreamento</h1><p>Configure os pixels que disparam nos seus links rastreáveis — no navegador e no servidor (Conversions API)</p></div>
      <button class="btn primary no-grow" onclick="openPixelForm(null)">${ico('plus', 14)} Adicionar pixel</button>
    </div>
    <div id="px-form"></div>
    <div class="card">
      <h2>${ico('target')} Pixels configurados</h2>
      <p class="muted" style="margin:0 0 14px">Disparados automaticamente nos seus <a href="#/links">links rastreáveis</a> — cada clique vira evento <code>LinkClick</code> (Meta), <code>link_click</code> (Google) e <code>page</code> (TikTok).</p>
      <div id="px-list">${skel(3)}</div>
    </div>
    <div class="card">
      <h2>${ico('link')} Domínio personalizado dos links</h2>
      <div class="row">
        <label style="flex:1">Domínio dos links curtos<input id="tk-domain" value="${esc(cfg.linkDomain || '')}" placeholder="ex.: link.suaempresa.com.br"></label>
        <button class="btn primary no-grow" onclick="saveLinkDomain()">${ico('save', 14)} Salvar domínio</button>
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Aponte o DNS do seu domínio para este servidor — os links curtos passam a sair como <code>https://seu-dominio/l/apelido</code>.</p>
    </div>
    <div class="card px-guide">
      <h2>${ico('help')} Onde encontrar o ID de cada pixel</h2>
      <div class="pxg-grid">
        <div><b>${ico(PIXEL_ICON.meta, 15)} Meta (Facebook/Instagram)</b><p>Gerenciador de Eventos → seu dataset → <b>ID</b> (15–16 dígitos). O token da CAPI fica em <i>Configurações → Gerar token de acesso</i>.</p></div>
        <div><b>${ico(PIXEL_ICON.gtag, 15)} Google Ads / GA4</b><p>Painel do Google → tag <code>G-XXXX</code> (GA4) ou <code>AW-XXXX</code> (Ads). Cole o ID exatamente como aparece.</p></div>
        <div><b>${ico(PIXEL_ICON.tiktok, 15)} TikTok</b><p>TikTok Ads → Ferramentas → Eventos → Web → <b>Pixel ID</b> (código alfanumérico).</p></div>
      </div>
    </div>
  </div>`;
  paintPixels();
}

// Painel de edição inline (sem popup) — abre acima da lista de pixels
async function openPixelForm(id) {
  let px = { type: 'meta', pixelId: '', name: '', capiToken: '', testCode: '', defaultEvent: '' };
  if (id) { const { pixels } = await api('/pixels'); px = Object.assign(px, pixels.find(p => p.id === id) || {}); }
  window._pxEdit = id || null;
  const box = $('#px-form'); if (!box) return;
  box.innerHTML = `<div class="card px-editor">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="flex:1;margin:0">${ico(id ? 'edit' : 'plus')} ${id ? 'Editar' : 'Novo'} pixel</h2>
      <button class="icon-btn" title="Fechar" onclick="closePixelForm()">${ico('x', 16)}</button>
    </div>
    <div class="row">
      <label style="flex:1">Plataforma${ecSelect('px-type', Object.entries(PIXEL_LBL).map(([k, v]) => ({ value: k, label: v })), px.type || 'meta', 'pxTypeChanged(val)')}</label>
      <label style="flex:1">Nome (opcional)<input id="px-name" value="${esc(px.name)}" placeholder="ex.: Pixel campanha julho"></label>
    </div>
    <label style="margin-top:9px">ID do pixel<input id="px-id" value="${esc(px.pixelId)}" placeholder="${PIXEL_ID_PH[px.type] || ''}"></label>
    <div id="px-extra">${pixelExtraHtml(px)}</div>
    <div class="row" style="margin-top:8px;justify-content:flex-end">
      <button class="btn no-grow" onclick="closePixelForm()">Cancelar</button>
      ${id ? `<button class="btn no-grow" id="px-test-btn" onclick="testPixel('${id}')">${ico('activity', 14)} Testar evento</button>` : ''}
      <button class="btn primary no-grow" onclick="savePixel(${id ? `'${id}'` : 'null'})">${ico('save', 14)} Salvar</button>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('#px-id')?.focus(), 80);
}
function closePixelForm() { const b = $('#px-form'); if (b) b.innerHTML = ''; }
function pixelExtraHtml(px) {
  const evOpts = CONV_EVENTS.map(e => ({ value: e, label: e }));
  const evSel = `<label>Evento de conversão padrão${ecSelect('px-event', evOpts, px.defaultEvent || 'PageView')}</label>`;
  if (px.type !== 'meta') return `${evSel}<p class="muted" style="font-size:11.5px;margin:8px 0 0">Disparado no navegador quando alguém clica nos seus links rastreáveis.</p>`;
  return `${evSel}
    <div class="capi-box">
      <div class="capi-head">${ico('shield', 14)} Conversions API <span class="capi-tag">server-side</span></div>
      <p class="muted" style="font-size:11.5px;margin:2px 0 10px">Rastreamento pelo servidor (à prova de bloqueadores e iOS). Gere o token em Eventos → Configurações do dataset na Meta.</p>
      <label>Access Token (CAPI)<input id="px-capi" type="password" value="${esc(px.capiToken || '')}" placeholder="EAAG… (opcional, mas recomendado)"></label>
      <label style="margin-top:9px">Código de teste (test_event_code)<input id="px-testcode" value="${esc(px.testCode || '')}" placeholder="TEST12345 — opcional, só p/ validar"></label>
    </div>`;
}
function pxTypeChanged(type) {
  const box = $('#px-extra'); if (box) box.innerHTML = pixelExtraHtml({ type, defaultEvent: ecSelVal('px-event') });
  const inp = $('#px-id'); if (inp) inp.placeholder = PIXEL_ID_PH[type] || '';
}
async function savePixel(id) {
  const type = ecSelVal('px-type');
  const body = {
    type, pixelId: $('#px-id').value, name: $('#px-name').value,
    defaultEvent: ecSelVal('px-event') || 'PageView',
    capiToken: $('#px-capi')?.value || '', testCode: $('#px-testcode')?.value || ''
  };
  try {
    if (id) await api('/pixels/' + id, { method: 'PUT', body });
    else await api('/pixels', { body });
    closePixelForm(); paintPixels(); toast('Pixel salvo!');
  } catch (e) { toast(e.message, 'error'); }
}
async function testPixel(id) {
  const btn = $('#px-test-btn'); if (btn) { btn.disabled = true; btn.innerHTML = `${ico('refresh', 14)} Enviando…`; }
  try {
    const r = await api('/pixels/' + id + '/test', { body: {} });
    toast(`Evento de teste enviado! Recebido pela Meta (${r.received}). Confira no Gerenciador de Eventos.`);
  } catch (e) { toast(e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = `${ico('activity', 14)} Testar evento`; } }
}
async function delPixel(id) {
  if (!await confirmModal({ title: 'Excluir pixel', text: 'Ele deixará de ser disparado nos seus links rastreáveis.', ok: 'Excluir', danger: true })) return;
  try { await api('/pixels/' + id, { method: 'DELETE' }); paintPixels(); } catch (e) { toast(e.message, 'error'); }
}

async function saveLinkDomain() {
  try {
    await api('/settings', { method: 'PUT', body: { linkDomain: $('#tk-domain').value } });
    toast('Domínio salvo! Os links curtos já usam o novo endereço.');
  } catch (e) { toast(e.message, 'error'); }
}

async function disconnectWa() {
  if (!await confirmModal({
    title: 'Desconectar WhatsApp',
    text: 'O número deixará de enviar e receber mensagens pelo EliteChat até uma nova conexão.',
    ok: 'Desconectar', danger: true
  })) return;
  try {
    await api('/wa/disconnect', { body: {} });
    toast('WhatsApp desconectado');
    refreshBadge();
    renderSettings();
  } catch (e) { toast(e.message, 'error'); }
}

function diagOut(data) { $('#diag-out').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2); }

async function runDiag(path) {
  diagOut('Consultando Graph API...');
  try { diagOut(await api(path)); toast('Consulta OK'); }
  catch (e) { diagOut('ERRO: ' + e.message + (e.meta ? '\n\n' + JSON.stringify(e.meta, null, 2) : '')); toast(e.message, 'error'); }
}

async function testConn() {
  diagOut('Testando conexão com a Cloud API...');
  try {
    const r = await api('/settings/test');
    diagOut(r);
    toast(`Conectado: ${r.verified_name || ''} ${r.display_phone_number || ''}`);
  } catch (e) {
    diagOut('ERRO: ' + e.message + (e.meta ? '\n\n' + JSON.stringify(e.meta, null, 2) : ''));
    toast(e.message, 'error');
  }
}

async function subscribeWaba() {
  diagOut('Assinando app na WABA...');
  try { diagOut(await api('/waba/subscribe', { body: {} })); toast('App assinado na WABA!'); }
  catch (e) { diagOut('ERRO: ' + e.message); toast(e.message, 'error'); }
}

async function regenToken() {
  if (!await confirmModal({ title: 'Gerar novo Verify Token', text: 'Você precisará atualizar o token no painel da Meta para o webhook continuar verificado.', ok: 'Gerar novo' })) return;
  const r = await api('/settings/verify-token/regenerate', { body: {} });
  $('#wh-token').textContent = r.verifyToken;
  toast('Novo verify token gerado');
}

async function loadProfile(silent) {
  try {
    const p = await api('/profile');
    $('#pf-about').value = p.about || '';
    $('#pf-email').value = p.email || '';
    $('#pf-address').value = p.address || '';
    $('#pf-desc').value = p.description || '';
    ecSelPick('pf-vertical', p.vertical || '');
    $('#pf-sites').value = (p.websites || []).join('\n');
    if (p.profile_picture_url) {
      state.wa.profilePictureUrl = p.profile_picture_url;
      paintProfilePhoto();
      paintTopbarAvatar();
    }
    if (!silent) toast('Perfil carregado');
  } catch (e) { if (!silent) toast(e.message, 'error'); }
}

async function saveProfile() {
  try {
    const body = {
      about: $('#pf-about').value,
      email: $('#pf-email').value,
      address: $('#pf-address').value,
      description: $('#pf-desc').value,
      websites: $('#pf-sites').value.split('\n').map(x => x.trim()).filter(Boolean).slice(0, 2)
    };
    if (ecSelVal('pf-vertical')) body.vertical = ecSelVal('pf-vertical');
    await api('/profile', { method: 'PUT', body });
    toast('Perfil atualizado na Meta!');
  } catch (e) { toast(e.message, 'error'); }
}

// Foto do perfil conectado — exibida no painel e trocada via API oficial
function paintProfilePhoto() {
  const url = state.wa && state.wa.profilePictureUrl;
  const html = url ? `<img src="${esc(url)}" alt="Foto do perfil">` : waInitials((state.wa && state.wa.verifiedName) || state.user);
  const el = $('#pf-photo'); if (el) el.innerHTML = html;
  const cp = $('#conn-photo'); if (cp) cp.innerHTML = html; // card "WhatsApp conectado"
}
function paintTopbarAvatar() {
  const av = $('#tb-avatar'); if (!av) return;
  const url = state.wa && state.wa.profilePictureUrl;
  if (url) av.innerHTML = `<img src="${esc(url)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
}
function changeProfilePhoto(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (!/^image\/(jpeg|png)$/.test(f.type)) return toast('Use uma imagem JPG ou PNG', 'error');
  if (f.size > 5 * 1024 * 1024) return toast('Imagem muito grande (máx. 5 MB)', 'error');
  const reader = new FileReader();
  reader.onload = async () => {
    const st = $('#pf-photo-status'); if (st) st.textContent = 'Enviando para a Meta…';
    try {
      const r = await api('/profile/photo', { body: { filename: f.name, mime: f.type, data: reader.result } });
      state.wa.profilePictureUrl = r.url || reader.result;
      paintProfilePhoto(); paintTopbarAvatar();
      if (st) st.textContent = '';
      toast('Foto do perfil atualizada no WhatsApp!');
    } catch (e) { if (st) st.textContent = ''; toast(e.message, 'error'); }
  };
  reader.readAsDataURL(f);
}

// Ligações — WhatsApp Business Calling API (habilita o ícone de chamada)
async function loadCalling() {
  const st = $('#cl-status'); if (!st) return;
  st.textContent = 'Consultando…';
  try {
    const r = await api('/settings/calling');
    const c = r.calling;
    const on = c && c.status === 'ENABLED';
    const tg = $('#cl-toggle'); if (tg) tg.checked = on;
    st.textContent = c ? (on ? 'Ligações habilitadas — seus clientes podem te ligar pelo WhatsApp.' : 'Ligações desabilitadas.') : 'Recurso ainda não configurado neste número.';
  } catch (e) { st.textContent = 'Não foi possível consultar: ' + e.message; }
}
async function toggleCalling(enabled) {
  const st = $('#cl-status');
  try {
    await api('/settings/calling', { method: 'PUT', body: { enabled } });
    if (st) st.textContent = enabled ? 'Ligações habilitadas — seus clientes podem te ligar pelo WhatsApp.' : 'Ligações desabilitadas.';
    toast(enabled ? 'Ligações habilitadas!' : 'Ligações desabilitadas');
  } catch (e) {
    const tg = $('#cl-toggle'); if (tg) tg.checked = !enabled; // reverte
    if (st) st.textContent = 'A Meta recusou: ' + e.message;
    toast(e.message, 'error');
  }
}

async function phoneAction(action, body) {
  diagOut(`Executando ${action}...`);
  try { diagOut(await api('/phone/' + action, { body })); toast('OK: ' + action); }
  catch (e) { diagOut('ERRO: ' + e.message + (e.meta ? '\n\n' + JSON.stringify(e.meta, null, 2) : '')); toast(e.message, 'error'); }
}

async function saveStages() {
  try {
    const stages = $('#st-stages').value.split('\n').map(x => x.trim()).filter(Boolean);
    const r = await api('/settings', { method: 'PUT', body: { stages } });
    state.settings = r.settings;
    toast('Etapas salvas');
  } catch (e) { toast(e.message, 'error'); }
}

async function changePass() {
  try {
    await api('/settings/password', { body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
    state.mustChangePassword = false;
    toast('Senha alterada com sucesso!');
    $('#pw-cur').value = ''; $('#pw-new').value = '';
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== TOPBAR ====================
const TITLES = {
  dashboard: 'Dashboard', reports: 'Métricas & Relatórios', inbox: 'Conversas', contacts: 'Contatos',
  funnel: 'Funil de vendas', campaigns: 'Campanhas', templates: 'Modelos de mensagem',
  quick: 'Respostas rápidas', logs: 'Webhook & Logs', settings: 'Configurações',
  team: 'Chat interno', flows: 'Flow Builder', links: 'Links rastreáveis',
  'templates/new': 'Criar modelo', 'campaigns/new': 'Nova campanha'
};
function updateTopbar() {
  const t = $('#tb-title');
  if (t) t.textContent = TITLES[state.view] || 'Elite Chat';
}

// ==================== GRÁFICOS (SVG puro, sem libs) ====================
function fmtN(n) { return new Intl.NumberFormat('pt-BR').format(n || 0); }
// centavos → "R$ 97,00"
function fmtBRL(cents) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100); }
// Crescimento líquido (opt-ins − opt-outs): mostra o sinal
function coGrowth(n) { n = n || 0; return (n > 0 ? '+' : '') + fmtN(n); }

// Card de agendamentos no dashboard (hoje / próximos / atrasados)
function dashScheduleCard(s) {
  s = s || { todayCount: 0, upcomingCount: 0, lateCount: 0, today: [], next: [], late: [] };
  const evLine = e => `<a class="dash-ev" onclick="${e.contact ? `location.hash='#/inbox';setTimeout(()=>openChat('${e.contact.waId}'),150)` : `location.hash='#/schedule'`}" style="--evc:${SC_COLORS[e.color] || 'var(--verde-esc)'}">
    <b>${new Date(e.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b>
    <span>${esc(e.title)}${e.contact ? ' · ' + esc(e.contact.name) : ''}</span></a>`;
  const items = (s.late.length ? s.late : (s.today.length ? s.today : s.next)).slice(0, 4);
  return `<div class="card svc-card">
    <div class="row" style="align-items:center;margin-bottom:12px">
      <h2 style="margin:0;flex:1">${ico('calendar')} Agendamentos</h2>
      <a class="btn small no-grow" href="#/schedule">Abrir agenda</a>
    </div>
    <div class="svc-kpis" style="margin-bottom:${items.length ? '14px' : '0'}">
      <a class="svc-kpi" href="#/schedule"><span class="svc-ic">${ico('calendar', 16)}</span><b>${fmtN(s.todayCount)}</b><span>Hoje</span></a>
      <a class="svc-kpi ok" href="#/schedule"><span class="svc-ic">${ico('clock', 16)}</span><b>${fmtN(s.upcomingCount)}</b><span>Próximos</span></a>
      <a class="svc-kpi crit" href="#/schedule"><span class="svc-ic">${ico('alert', 16)}</span><b>${fmtN(s.lateCount)}</b><span>Atrasados</span></a>
    </div>
    ${items.length ? `<div class="dash-ev-list">${items.map(evLine).join('')}</div>` : ''}
  </div>`;
}

// Card de atendentes no dashboard (só quando há atendentes cadastrados)
function dashAgentsCard(a) {
  return `<div class="card svc-card">
    <div class="row" style="align-items:center;margin-bottom:12px">
      <h2 style="margin:0;flex:1">${ico('users')} Atendentes</h2>
      <a class="btn small no-grow" href="#/agents/perf">Ver desempenho</a>
    </div>
    <div class="svc-kpis" style="margin-bottom:14px">
      <div class="svc-kpi ok"><span class="svc-ic">${ico('check-circle', 16)}</span><b>${fmtN(a.online)}</b><span>Online</span></div>
      <div class="svc-kpi"><span class="svc-ic">${ico('slash', 16)}</span><b>${fmtN(a.offline)}</b><span>Offline</span></div>
      <div class="svc-kpi"><span class="svc-ic">${ico('message', 16)}</span><b>${fmtDur2(a.avgFirstResponseMs)}</b><span>1ª resposta média</span></div>
      <div class="svc-kpi"><span class="svc-ic">${ico('clock', 16)}</span><b>${fmtDur2(a.avgHandleTimeMs)}</b><span>Atendimento médio</span></div>
    </div>
    ${a.ranking.length ? `<div class="rank-list">${a.ranking.map((r, i) => `
      <div class="rank-row">
        <span class="rank-pos">${i + 1}º</span>
        ${agAvatar(r, 28)}
        <div style="flex:1;min-width:0"><b>${esc(r.name)}</b> ${presenceDot(r.presence)}<div class="muted" style="font-size:11px">${r.handled} atendidas · ${r.finished} finalizadas</div></div>
        <b class="pill done">${r.score}</b>
      </div>`).join('')}</div>` : ''}
  </div>`;
}

function chLine(days, h = 230) {
  const w = 780, pL = 38, pR = 12, pB = 26, pT = 12;
  const max = Math.max(1, ...days.map(d => Math.max(d.in, d.out)));
  const X = i => pL + i * (w - pL - pR) / Math.max(1, days.length - 1);
  const Y = v => pT + (1 - v / max) * (h - pT - pB);
  const line = k => days.map((d, i) => `${X(i).toFixed(1)},${Y(d[k]).toFixed(1)}`).join(' ');
  const area = `M${X(0).toFixed(1)},${Y(days[0].out).toFixed(1)} L` +
    days.map((d, i) => `${X(i).toFixed(1)},${Y(d.out).toFixed(1)}`).join(' L') +
    ` L${X(days.length - 1).toFixed(1)},${(h - pB).toFixed(1)} L${X(0).toFixed(1)},${(h - pB).toFixed(1)} Z`;
  const grid = [0, .5, 1].map(f => {
    const y = Y(max * f).toFixed(1);
    return `<line x1="${pL}" x2="${w - pR}" y1="${y}" y2="${y}" stroke="#eef1f5"/><text x="${pL - 7}" y="${+y + 3}" text-anchor="end" font-size="10" fill="#98a2b3">${Math.round(max * f)}</text>`;
  }).join('');
  const step = Math.ceil(days.length / 8);
  const labels = days.map((d, i) => i % step ? '' :
    `<text x="${X(i).toFixed(1)}" y="${h - 8}" font-size="10" fill="#98a2b3" text-anchor="middle">${d.date.slice(8)}/${d.date.slice(5, 7)}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;margin-top:8px">
    <defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#10B981" stop-opacity=".22"/><stop offset="1" stop-color="#10B981" stop-opacity="0"/></linearGradient></defs>
    ${grid}${labels}
    <path d="${area}" fill="url(#gA)"/>
    <polyline points="${line('out')}" fill="none" stroke="#10B981" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${line('in')}" fill="none" stroke="#53BDEB" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function spark(values, color = '#10B981', w = 110, h = 30) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1) * w).toFixed(1)},${(h - 3 - (v / max) * (h - 8)).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// Donut SVG (estilo referência: centro com % e legenda com barras)
function donut(items, size = 168, thick = 22) {
  const total = items.reduce((a, x) => a + x.value, 0);
  const cx = size / 2, cy = size / 2, r = (size - thick) / 2;
  let arcs = '';
  if (!total) {
    arcs = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e8f3ec" stroke-width="${thick}"/>`;
  } else {
    let a0 = -Math.PI / 2;
    for (const x of items) {
      if (!x.value) continue;
      const frac = x.value / total;
      if (frac >= 0.999) { arcs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${x.color}" stroke-width="${thick}"/>`; break; }
      const a1 = a0 + frac * 2 * Math.PI;
      const large = frac > 0.5 ? 1 : 0;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1 - 0.02), y1 = cy + r * Math.sin(a1 - 0.02);
      arcs += `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" fill="none" stroke="${x.color}" stroke-width="${thick}" stroke-linecap="round"/>`;
      a0 = a1;
    }
  }
  const main = items[0] || { label: '', value: 0 };
  const pct = total ? Math.round(main.value / total * 100) : 0;
  const maxV = Math.max(1, ...items.map(x => x.value));
  return `<div class="donut-wrap">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${arcs}
      <text x="${cx}" y="${cy - 1}" text-anchor="middle" style="font:800 26px 'Inter Tight',sans-serif;letter-spacing:-1px" fill="var(--text)">${pct}%</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" style="font:700 10px 'Inter Tight',sans-serif;letter-spacing:.8px" fill="#93a092">${esc(main.label.toUpperCase())}</text>
    </svg>
    <div class="donut-leg">${items.map(x => `
      <div class="dl-row"><span class="dl-name"><i style="background:${x.color}"></i>${esc(x.label)}</span><b>${fmtN(x.value)}</b>
      <div class="dl-track"><div style="width:${Math.round(x.value / maxV * 100)}%;background:${x.color}"></div></div></div>`).join('')}</div>
  </div>`;
}

// Gráfico de funil (trapézios centrados)
// Funil de vendas — barras centralizadas que formam a silhueta do funil,
// com % de conversão (relativo à 1ª etapa) e queda entre etapas.
function funnelChart(stages) {
  if (!stages || !stages.length) return '<p class="muted">Sem etapas.</p>';
  const n = stages.length;
  const max = Math.max(1, ...stages.map(s => s.count));
  const first = stages[0].count || 0;
  return `<div class="funnel3">${stages.map((s, i) => {
    const w = Math.max(9, Math.round(s.count / max * 100));           // largura da barra (%)
    const t = n > 1 ? i / (n - 1) : 0;                                 // 0 (topo) → 1 (base)
    const l1 = (26 + t * 20).toFixed(0), l2 = (40 + t * 22).toFixed(0);
    const conv = first ? Math.round(s.count / first * 100) : 0;        // conversão desde a 1ª etapa
    const prev = i > 0 ? stages[i - 1].count : null;
    const drop = (prev != null && prev > 0 && s.count < prev) ? Math.round((prev - s.count) / prev * 100) : null;
    return `<div class="fn3-row">
      <div class="fn3-label" title="${esc(s.stage)}">
        <span class="fn3-idx">${i + 1}</span>
        <span class="fn3-name">${esc(s.stage)}</span>
      </div>
      <div class="fn3-track">
        <div class="fn3-bar" style="width:${w}%;background:linear-gradient(180deg,hsl(158 58% ${l2}%),hsl(160 62% ${l1}%))">
          <b class="fn3-count">${fmtN(s.count)}</b>
        </div>
        ${drop != null ? `<span class="fn3-drop" title="Queda em relação à etapa anterior">▼ ${drop}%</span>` : ''}
      </div>
      <div class="fn3-conv"><b>${conv}%</b><span>conv.</span></div>
    </div>`;
  }).join('')}</div>`;
}

// ==================== MAPA 3D DO BRASIL (leads por estado) ====================
// Grade de tiles por UF (col,row) no estilo "statebin", projetada em isométrico
// com extrusão 3D — a altura da coluna cresce com o nº de leads do estado.
const BR_GRID = {
  RR: [2, 0], AP: [4, 0],
  AM: [1, 1], PA: [3, 1], MA: [4, 1], CE: [5, 1], RN: [6, 1],
  AC: [0, 2], RO: [1, 2], TO: [3, 2], PI: [4, 2], PE: [5, 2], PB: [6, 2],
  MT: [2, 3], GO: [3, 3], BA: [4, 3], SE: [5, 3], AL: [6, 3],
  MS: [2, 4], DF: [3, 4], MG: [4, 4], ES: [5, 4],
  SP: [3, 5], RJ: [4, 5],
  PR: [2, 5], SC: [2, 6], RS: [2, 7]
};
const UF_NAME = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins'
};

function brazilMap3D(g) {
  const counts = g.states || {};
  const max = Math.max(1, ...Object.values(counts));
  // Projeção oblíqua: norte fica em cima, sul embaixo; a profundidade (SK)
  // desloca cada linha p/ a esquerda e as colunas extrudam p/ baixo (3D).
  const TW = 56, TD = 26, SK = 13, GX = 7, GY = 9, HMAX = 58;
  const pos = (c, r) => ({ x: c * (TW + GX) - r * SK, y: r * (TD + GY) });

  let minX = 1e9, maxX = -1e9, maxY = -1e9;
  for (const [c, r] of Object.values(BR_GRID)) {
    const p = pos(c, r);
    minX = Math.min(minX, p.x - SK); maxX = Math.max(maxX, p.x + TW);
    maxY = Math.max(maxY, p.y + TD);
  }
  const PAD = 26;
  const ox = -minX + PAD, oy = PAD + HMAX * 0.55;
  const W = (maxX - minX) + PAD * 2, H = maxY + HMAX * 0.55 + PAD * 2.1;

  // pinta de trás (norte) pra frente (sul) — painter's algorithm
  const items = Object.entries(BR_GRID)
    .map(([uf, [c, r]]) => ({ uf, c, r, ...pos(c, r), count: counts[uf] || 0 }))
    .sort((a, b) => a.r - b.r || a.c - b.c);

  let svg = '';
  for (const it of items) {
    const x = it.x + ox, y = it.y + oy;
    const frac = it.count / max;
    const h = it.count ? 12 + frac * (HMAX - 12) : 5;   // altura da coluna 3D
    const l = it.count ? (60 - frac * 24) : 87;          // luminância (mais leads = mais escuro)
    const sat = it.count ? 56 : 22;
    const top = `hsl(157 ${sat}% ${l}%)`;
    const front = `hsl(160 ${sat}% ${Math.max(18, l - 16)}%)`;
    const side = `hsl(162 ${sat}% ${Math.max(14, l - 24)}%)`;
    const ty = y - h;
    const cx = x + TW / 2 - SK / 2, cy = ty + TD / 2;
    // topo (paralelogramo) + face frontal + face lateral direita
    svg += `<g class="geo-tile${it.count ? ' hot' : ''}">
      <title>${UF_NAME[it.uf]} — ${fmtN(it.count)} lead(s)</title>
      <polygon points="${x - SK},${ty + TD} ${x + TW - SK},${ty + TD} ${x + TW - SK},${y + TD} ${x - SK},${y + TD}" fill="${front}"/>
      <polygon points="${x + TW - SK},${ty + TD} ${x + TW},${ty} ${x + TW},${y} ${x + TW - SK},${y + TD}" fill="${side}"/>
      <polygon points="${x},${ty} ${x + TW},${ty} ${x + TW - SK},${ty + TD} ${x - SK},${ty + TD}" fill="${top}" stroke="rgba(255,255,255,.5)" stroke-width="1"/>
      <text x="${cx}" y="${cy + 3.5}" text-anchor="middle" class="geo-uf" fill="${it.count && frac > 0.3 ? '#fff' : '#4c5f53'}">${it.uf}</text>
      ${it.count ? `<text x="${cx}" y="${ty - 7}" text-anchor="middle" class="geo-n">${fmtN(it.count)}</text>` : ''}
    </g>`;
  }

  const top5 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxSrc = Math.max(1, ...(g.sources || []).map(s => s.count));
  const maxRef = Math.max(1, ...(g.referrers || []).map(r => r.count));
  return `
    <div class="geo-map">
      <svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" style="width:100%;height:auto">${svg}</svg>
      ${g.brTotal ? '' : '<p class="muted geo-empty">Sem leads brasileiros localizados ainda — os estados acendem conforme os contatos chegam pelo WhatsApp.</p>'}
    </div>
    <div class="geo-side">
      <div class="geo-block">
        <span class="fb-sub">Top estados</span>
        ${top5.length ? top5.map(([uf, n]) => hrow(`${uf} — ${UF_NAME[uf]}`, n, top5[0][1])).join('') : '<p class="muted" style="font-size:12.5px">Nenhum lead localizado ainda.</p>'}
        ${g.foreign ? `<p class="muted" style="font-size:12px;margin-top:6px">${fmtN(g.foreign)} contato(s) fora do Brasil / sem DDD.</p>` : ''}
      </div>
      <div class="geo-block">
        <span class="fb-sub">Origem do tráfego</span>
        ${(g.sources || []).map(s => hrow(esc(s.label), s.count, maxSrc)).join('')}
      </div>
      ${(g.referrers || []).length ? `<div class="geo-block">
        <span class="fb-sub">Sites que mais clicam nos seus links</span>
        ${g.referrers.map(r => hrow(esc(r.host), r.count, maxRef)).join('')}
      </div>` : ''}
    </div>`;
}

// Barras por dia (série única) — divs, com tooltip e eixo
function dayBars(series, color = '#10B981') {
  const max = Math.max(1, ...series.map(d => d.count));
  const fmtD = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
  return `<div class="hbars" style="height:130px">${series.map(d =>
    `<div class="hb" style="height:${Math.max(3, d.count / max * 100)}%;background:${color}" title="${fmtD(d.date)} — ${d.count}"></div>`).join('')}</div>
  <div class="hbars-x"><span>${fmtD(series[0].date)}</span><span>${fmtD(series[Math.floor(series.length / 2)].date)}</span><span>${fmtD(series[series.length - 1].date)}</span></div>`;
}

// Volume in/out com 3 tipos de gráfico (linha, barras, área) — escolha do usuário
function chVolume(days, kind = 'line', h = 240) {
  if (kind === 'line') return chLine(days, h);
  const w = 560, padB = 22;
  const max = Math.max(1, ...days.map(d => Math.max(d.in, d.out)));
  const fmtD = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
  const grid = [0.25, 0.5, 0.75].map(f => `<line x1="0" y1="${(h - padB) * f}" x2="${w}" y2="${(h - padB) * f}" stroke="#e8f3ec" stroke-dasharray="3 4"/>`).join('');
  const labels = `<text x="2" y="${h - 6}" style="font:600 10px 'Inter Tight'" fill="#93a092">${fmtD(days[0].date)}</text>
    <text x="${w - 2}" y="${h - 6}" text-anchor="end" style="font:600 10px 'Inter Tight'" fill="#93a092">${fmtD(days[days.length - 1].date)}</text>`;
  if (kind === 'bars') {
    const slot = w / days.length, bw = Math.max(3, Math.min(16, slot * 0.34));
    let bars = '';
    days.forEach((d, i) => {
      const xm = i * slot + slot / 2;
      const ho = d.out / max * (h - padB - 8), hi = d.in / max * (h - padB - 8);
      bars += `<rect x="${(xm - bw - 0.5).toFixed(1)}" y="${(h - padB - ho).toFixed(1)}" width="${bw}" height="${Math.max(2.5, ho).toFixed(1)}" rx="${Math.min(4, bw / 2)}" fill="url(#gvb)"><title>${fmtD(d.date)} — ${d.out} enviadas</title></rect>`;
      bars += `<rect x="${(xm + 0.5).toFixed(1)}" y="${(h - padB - hi).toFixed(1)}" width="${bw}" height="${Math.max(2.5, hi).toFixed(1)}" rx="${Math.min(4, bw / 2)}" fill="#53BDEB" opacity=".8"><title>${fmtD(d.date)} — ${d.in} recebidas</title></rect>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" class="chv">
      <defs><linearGradient id="gvb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34D399"/><stop offset="1" stop-color="#0B815A"/></linearGradient></defs>
      ${grid}${bars}${labels}</svg>`;
  }
  // área dupla
  const pt = (v, i) => `${(i / Math.max(1, days.length - 1) * w).toFixed(1)},${(h - padB - v / max * (h - padB - 10)).toFixed(1)}`;
  const lineOut = days.map((d, i) => pt(d.out, i)).join(' ');
  const lineIn = days.map((d, i) => pt(d.in, i)).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" class="chv">
    <defs>
      <linearGradient id="gaO" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#10B981" stop-opacity=".30"/><stop offset="1" stop-color="#10B981" stop-opacity="0"/></linearGradient>
      <linearGradient id="gaI" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#53BDEB" stop-opacity=".25"/><stop offset="1" stop-color="#53BDEB" stop-opacity="0"/></linearGradient>
    </defs>
    ${grid}
    <polygon points="0,${h - padB} ${lineIn} ${w},${h - padB}" fill="url(#gaI)"/>
    <polyline points="${lineIn}" fill="none" stroke="#53BDEB" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <polygon points="0,${h - padB} ${lineOut} ${w},${h - padB}" fill="url(#gaO)"/>
    <polyline points="${lineOut}" fill="none" stroke="#10B981" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    ${labels}</svg>`;
}

function hrow(label, val, max, suffix = '') {
  const pct = max ? Math.round(val / max * 100) : 0;
  return `<div class="hrow"><span class="hl">${label}</span><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="hv">${fmtN(val)}${suffix}</span></div>`;
}

function deltaChip(cur, prev) {
  if (!prev && !cur) return '<span class="delta flat">—</span>';
  if (!prev) return '<span class="delta up">novo</span>';
  const p = Math.round((cur - prev) / prev * 100);
  if (p > 0) return `<span class="delta up">▲ ${p}%</span>`;
  if (p < 0) return `<span class="delta down">▼ ${Math.abs(p)}%</span>`;
  return '<span class="delta flat">0%</span>';
}

// ==================== RELATÓRIOS ====================
async function renderReports(daysOverride) {
  if (typeof daysOverride === 'number') state.reportDays = daysOverride;
  const dd = state.reportDays || 14;
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Relatórios</h1><p>Desempenho de envios, entregas e atendimento</p></div>
      ${[7, 14, 30].map(p => `<button class="btn small no-grow ${p === dd ? 'primary' : ''}" onclick="renderReports(${p})">${p} dias</button>`).join('')}
    </div>
    <div id="rep"><div class="card">${skel(6)}</div></div>
  </div>`;
  try {
    const r = await api('/reports?days=' + dd);
    const outArr = r.days.map(x => x.out), inArr = r.days.map(x => x.in);
    const half = Math.floor(r.days.length / 2);
    const sum = a => a.reduce((x, y) => x + y, 0);
    const maxHour = Math.max(1, ...r.byHour);
    const adv = r.advanced || {};
    const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m} min`;
    const maxType = Math.max(1, ...(r.sentByType || []).map(t => t.count));
    const TYPE_LBL = { text: 'Texto', template: 'Template', interactive: 'Interativa/Botões', image: 'Imagem', video: 'Vídeo', audio: 'Áudio', document: 'Documento', location: 'Localização', contacts: 'Contato' };
    const SUG_LV = { warn: 'warn', info: 'info', ok: 'ok' };
    $('#rep').innerHTML = `
      ${(r.suggestions || []).length ? `<div class="card sug-card">
        <h2>${ico('zap')} Sugestões para melhorar seu funil</h2>
        <div class="sug-grid">${r.suggestions.map(s => `
          <div class="sug ${SUG_LV[s.level] || 'info'}">
            <span class="sug-ic">${ico(s.icon || 'zap', 16)}</span>
            <div class="sug-tx"><b>${esc(s.title)}</b><p>${esc(s.text)}</p>
            ${s.action ? `<a class="sug-act" href="${esc(s.action.hash)}">${esc(s.action.label)} →</a>` : ''}</div>
          </div>`).join('')}</div>
      </div>` : ''}
      <div class="metric-hero">
        <div class="mh-card"><span class="mh-ic">${ico('clock', 20)}</span><div class="mh-val">${fmtDur(adv.avgResponseMin || 0)}</div><div class="mh-lbl">Tempo médio de resposta</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('users', 20)}</span><div class="mh-val">${fmtN(adv.activeContacts || 0)}</div><div class="mh-lbl">Contatos ativos no período</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('plus', 20)}</span><div class="mh-val">${fmtN(adv.newContacts || 0)}</div><div class="mh-lbl">Novos contatos</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('flow', 20)}</span><div class="mh-val">${fmtN(adv.automationRuns || 0)}</div><div class="mh-lbl">Automações executadas</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('link', 20)}</span><div class="mh-val">${fmtN(adv.linkClicks || 0)}</div><div class="mh-lbl">Cliques em links</div></div>
        <div class="mh-card hi"><span class="mh-ic">${ico('target', 20)}</span><div class="mh-val">${fmtN(adv.leadsWon || 0)}</div><div class="mh-lbl">Leads ganhos</div></div>
      </div>
      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-top"><span class="lbl">Mensagens enviadas</span>${deltaChip(sum(outArr.slice(half)), sum(outArr.slice(0, half)))}</div><div class="val">${fmtN(r.totals.out)}</div>${spark(outArr)}</div>
        <div class="kpi"><div class="kpi-top"><span class="lbl">Mensagens recebidas</span>${deltaChip(sum(inArr.slice(half)), sum(inArr.slice(0, half)))}</div><div class="val">${fmtN(r.totals.in)}</div>${spark(inArr, '#53BDEB')}</div>
        <div class="kpi"><div class="kpi-top"><span class="lbl">Taxa de entrega</span></div><div class="val">${r.totals.deliveryRate}%</div><div class="muted" style="font-size:12px;margin-top:6px">${fmtN(r.totals.delivered)} entregues</div></div>
        <div class="kpi"><div class="kpi-top"><span class="lbl">Taxa de leitura</span></div><div class="val">${r.totals.readRate}%</div><div class="muted" style="font-size:12px;margin-top:6px">${fmtN(r.totals.read)} lidas</div></div>
        <div class="kpi"><div class="kpi-top"><span class="lbl">Falhas</span></div><div class="val" style="color:${r.totals.failed ? 'var(--red)' : 'inherit'}">${fmtN(r.totals.failed)}</div><div class="muted" style="font-size:12px;margin-top:6px">no período</div></div>
      </div>
      <div class="two-col">
        <div class="card chart-card">
          <div class="row" style="align-items:center;margin-bottom:2px">
            <h2 style="margin:0;flex:1">Volume de mensagens</h2>
            <span class="legend"><i style="background:#10B981"></i> Enviadas</span>
            <span class="legend"><i style="background:#53BDEB"></i> Recebidas</span>
          </div>
          ${chLine(r.days)}
        </div>
        <div class="card">
          <h2>Funil de entrega</h2>
          ${hrow('Enviadas', r.totals.out, r.totals.out)}
          ${hrow('Entregues', r.totals.delivered, r.totals.out)}
          ${hrow('Lidas', r.totals.read, r.totals.out)}
          ${hrow('Falhas', r.totals.failed, r.totals.out)}
          <p class="muted" style="font-size:12px;margin-top:14px">Status confirmados pelo webhook da Meta (sent → delivered → read).</p>
        </div>
      </div>
      <div class="two-col even">
        <div class="card">
          <h2>Horários de pico (recebidas)</h2>
          <div class="hbars">${r.byHour.map((v, i) => `<div class="hb" style="height:${Math.max(3, v / maxHour * 100)}%" title="${i}h — ${v} mensagem(ns)"></div>`).join('')}</div>
          <div class="hbars-x"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
        </div>
        <div class="card">
          <h2>Contatos mais ativos</h2>
          ${r.topContacts.length ? `<table><thead><tr><th>Contato</th><th>Telefone</th><th style="text-align:right">Mensagens</th></tr></thead><tbody>
            ${r.topContacts.map(c => `<tr><td><b>${esc(c.name)}</b></td><td class="muted">+${esc(c.waId)}</td><td style="text-align:right"><b>${c.count}</b></td></tr>`).join('')}
          </tbody></table>` : '<p class="muted">Sem dados no período.</p>'}
        </div>
      </div>
      <div class="two-col even">
        <div class="card">
          <h2>Mensagens enviadas por tipo</h2>
          ${(r.sentByType || []).length
            ? r.sentByType.map(t => hrow(TYPE_LBL[t.type] || t.type, t.count, maxType)).join('')
            : '<p class="muted">Nenhuma mensagem enviada no período.</p>'}
        </div>
        <div class="card">
          <h2>Distribuição do funil</h2>
          ${funnelChart(r.stages)}
        </div>
      </div>
      <div class="two-col even">
        <div class="card">
          <h2>Templates mais enviados</h2>
          ${r.templatesUsed.length
            ? r.templatesUsed.map(t => hrow(esc(t.name), t.count, r.templatesUsed[0].count)).join('')
            : '<p class="muted">Nenhum template enviado no período. Dispare em <a href="#/campaigns">Campanhas</a>.</p>'}
        </div>
        <div class="card">
          <h2>${ico('link')} Cliques por link</h2>
          ${(r.topLinks || []).length ? `<table><thead><tr><th>Link</th><th style="text-align:right">7 dias</th><th style="text-align:right">Total</th><th></th></tr></thead><tbody>
            ${r.topLinks.map(l => `<tr>
              <td><b>${esc(l.title)}</b><div class="muted" style="font-size:12px"><code>/l/${esc(l.slug)}</code></div></td>
              <td style="text-align:right"><b>${fmtN(l.clicks7d)}</b></td>
              <td style="text-align:right"><b>${fmtN(l.clicks)}</b></td>
              <td style="text-align:right;white-space:nowrap"><button class="btn small" onclick="openLinkStats('${l.id}')">${ico('activity', 12)} Detalhes</button></td>
            </tr>`).join('')}
          </tbody></table>` : '<p class="muted">Nenhum clique em links no período. Crie e divulgue links em <a href="#/links">Links rastreáveis</a>.</p>'}
        </div>
      </div>`;
  } catch (e) {
    $('#rep').innerHTML = `<div class="card err">${esc(e.message)}</div>`;
  }
}

// ==================== CAMPANHAS ====================
const CAMP_ST = { sent: 'Enviada', delivered: 'Entregue', read: 'Lida', failed: 'Falhou', pending: 'Pendente', accepted: 'Enviada' };

async function renderCampaigns() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Campanhas</h1><p>Disparos em massa com templates aprovados e relatório de envio em tempo real</p></div>
      <a class="btn primary no-grow" href="#/campaigns/new">${ico('plus', 14)} Nova campanha</a>
    </div>
    <div class="card" id="camp-table">${skel(4)}</div>
  </div>`;
  paintCampaigns();
}

async function paintCampaigns() {
  const box = $('#camp-table');
  if (!box) return;
  try {
    const { campaigns } = await api('/campaigns');
    if (!campaigns.length) {
      box.innerHTML = `<div class="empty-state"><div class="big">${ico('megaphone', 40)}</div><b>Nenhuma campanha ainda</b>
        <p class="muted" style="margin:6px auto 16px;max-width:420px">Dispare um template aprovado para todos os contatos, para uma etapa do funil ou para uma tag — e acompanhe entregas, leituras e falhas por destinatário.</p>
        <a class="btn primary" href="#/campaigns/new">Criar primeira campanha</a></div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Campanha</th><th>Modelo</th><th>Público</th><th>Progresso</th><th>Entregues</th><th>Lidas</th><th>Falhas</th><th>Status</th><th></th></tr></thead><tbody>
      ${campaigns.map(c => {
        const s = c.stats, done = s.total - s.pending;
        const pct = s.total ? Math.round(done / s.total * 100) : 0;
        const audVals = (c.audience.values && c.audience.values.length ? c.audience.values : [c.audience.value]).filter(Boolean).join(', ');
        const aud = c.audience.type === 'all' ? 'Todos os contatos' : (c.audience.type === 'stage' ? 'Etapas: ' : 'Tags: ') + audVals;
        return `<tr>
          <td><b>${esc(c.name)}</b><div class="muted" style="font-size:11.5px">${new Date(c.createdAt).toLocaleString('pt-BR')}</div></td>
          <td><code>${esc(c.templateName)}</code></td>
          <td class="muted">${esc(aud)}</td>
          <td><div class="progress"><i style="width:${pct}%"></i></div><div class="muted" style="font-size:11.5px;margin-top:3px">${done}/${s.total}</div></td>
          <td><b>${s.delivered + s.read}</b></td>
          <td><b>${s.read}</b></td>
          <td style="color:${s.failed ? 'var(--red)' : 'inherit'}"><b>${s.failed}</b></td>
          <td><span class="pill ${c.status}">${c.status === 'running' ? 'Enviando' : 'Concluída'}</span></td>
          <td><button class="btn small" onclick="campaignDetail('${c.id}')">Ver relatório</button></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    if (campaigns.some(c => c.status === 'running')) {
      clearTimeout(window._campTimer);
      window._campTimer = setTimeout(() => { if (state.view === 'campaigns') paintCampaigns(); }, 4000);
    }
  } catch (e) {
    box.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

async function renderCampaignNew() {
  $('#view').innerHTML = `<div class="page editor-page"><div class="card">${skel(4)}</div></div>`;
  let templates = [];
  try { templates = (await api('/templates')).templates.filter(t => t.status === 'APPROVED'); } catch {}
  if (!templates.length) {
    $('#view').innerHTML = `<div class="page">
      <div class="page-head row" style="align-items:center">
        <a class="btn no-grow" href="#/campaigns">${ico('arrow-up', 14)} Voltar</a>
        <div style="flex:1"><h1>Nova campanha</h1></div>
      </div>
      <div class="empty-state card"><div class="big">${ico('megaphone', 40)}</div><b>Nenhum modelo aprovado</b>
        <p class="muted" style="margin:6px auto 16px;max-width:440px">Campanhas usam <b>templates aprovados pela Meta</b>. Crie um modelo, aguarde a aprovação e volte para disparar.</p>
        <a class="btn primary" href="#/templates/new">Criar modelo</a></div>
    </div>`;
    return;
  }
  window._campTpls = templates;
  try { window._campContacts = (await api('/contacts')).contacts || []; } catch { window._campContacts = []; }
  try { window._campHooks = ((await api('/hook-vars')).hooks || []).filter(h => h.enabled); } catch { window._campHooks = []; }
  window._campSel = new Set(); // etapas/tags marcadas
  $('#view').innerHTML = `<div class="page editor-page">
    <div class="page-head row" style="align-items:center">
      <a class="btn no-grow" href="#/campaigns">${ico('arrow-up', 14)} Voltar</a>
      <div style="flex:1"><h1>Nova campanha</h1><p>Escolha o modelo, preencha as variáveis e veja o preview antes de disparar</p></div>
      <button class="btn primary no-grow" onclick="createCampaign()">${ico('send', 14)} Disparar campanha</button>
    </div>
    <div class="tpl-editor">
      <div class="tpl-form">
        <div class="card">
          <label>Nome da campanha<input id="cp-name" placeholder="Promoção de julho"></label>
          <label style="margin-top:11px">Modelo (template aprovado)${ecSelect('cp-tpl', templates.map((t, i) => ({ value: String(i), label: `${t.name} (${t.language})` })), '0', 'campTplChanged()')}</label>
          <div id="cp-vars" style="margin-top:11px"></div>
        </div>
        <div class="card">
          <div class="row" style="align-items:flex-end;gap:12px">
            <label style="flex:1">Público${ecSelect('cp-aud', [{ value: 'all', label: 'Todos os contatos' }, { value: 'stage', label: 'Etapas do funil' }, { value: 'tag', label: 'Tags' }], 'all', 'campAudChanged()')}</label>
            <span class="reach-pill" id="cp-reach"></span>
          </div>
          <div id="cp-aud-extra" style="margin-top:11px"></div>
        </div>
        <p class="hint" style="text-align:left">Os botões vêm do modelo aprovado. Disparos seguem as regras da Meta: apenas templates aprovados, para contatos que aceitaram receber.</p>
      </div>
      <div class="tpl-preview"><div class="tpl-preview-lbl">Pré-visualização</div><div id="cp-phone"></div></div>
    </div>
  </div>`;
  campTplChanged();
  campAudChanged();
}

// Fontes de valor para cada variável do disparo: texto fixo, dados do sistema
// (por contato) ou variáveis capturadas nos webhooks do Flow Builder.
const CAMP_VAR_SOURCES = [
  { value: '', label: 'Texto fixo' },
  { value: '{contato.nome}', label: 'Sistema · Nome do contato' },
  { value: '{contato.email}', label: 'Sistema · E-mail do contato' },
  { value: '{contato.telefone}', label: 'Sistema · Telefone do contato' },
  { value: '__wh', label: 'Webhook · variável recebida…' }
];

function campTplChanged() {
  const t = window._campTpls[+ecSelVal('cp-tpl')];
  const body = tplBody(t);
  const nVars = (body.match(/\{\{\d+\}\}/g) || []).reduce((m, v) => Math.max(m, +v.replace(/\D/g, '')), 0);
  $('#cp-vars').innerHTML = nVars
    ? `<span class="fb-sub">Variáveis</span>` + Array.from({ length: nVars }, (_, i) => `
      <div class="cvar-row">
        <label style="flex:1.4;min-width:0">{{${i + 1}}}<input class="cp-var" data-i="${i}" oninput="campPreview()" placeholder="Valor ${i + 1} (igual para todos)"></label>
        <label style="flex:1;min-width:0">Fonte${ecSelect('cp-src-' + i, CAMP_VAR_SOURCES, '', `campVarSrc(${i},val)`, 'sm')}</label>
      </div>
      <div id="cp-wh-${i}" class="cvar-wh hidden"></div>`).join('')
    : '<p class="muted" style="font-size:12px;margin:0">Este modelo não tem variáveis.</p>';
  campPreview();
}

// Fonte escolhida p/ a variável i (token do sistema ou fluxo de webhook)
function campVarSrc(i, val) {
  const input = document.querySelector(`.cp-var[data-i="${i}"]`);
  const whBox = $('#cp-wh-' + i);
  if (val === '__wh') {
    const hooks = window._campHooks || [];
    if (!hooks.length) {
      toast('Nenhuma automação com gatilho de webhook — crie uma no Flow Builder e ela aparece aqui', 'error');
      ecSelPick('cp-src-' + i, '');
      return;
    }
    // mais de um webhook: escolhe o webhook primeiro, depois a variável
    whBox.innerHTML = `
      ${hooks.length > 1 ? `<label>Webhook${ecSelect('cp-whf-' + i, hooks.map(h => ({ value: h.flowId, label: h.name })), hooks[0].flowId, `campVarHook(${i},val)`, 'sm')}</label>` : ''}
      <div id="cp-whv-${i}" style="flex:1"></div>`;
    whBox.classList.remove('hidden');
    campVarHook(i, hooks[0].flowId);
  } else {
    whBox.classList.add('hidden');
    whBox.innerHTML = '';
    if (input) { input.value = val; campPreview(); }
  }
}

// Variáveis já recebidas pelo webhook escolhido
function campVarHook(i, flowId) {
  const h = (window._campHooks || []).find(x => x.flowId === flowId);
  const box = $('#cp-whv-' + i); if (!box || !h) return;
  box.innerHTML = h.vars.length
    ? `<label>Variável do webhook "${esc(h.name)}"${ecSelect('cp-whk-' + i, h.vars.map(k => ({ value: k, label: `${k} — último: ${String(h.lastVars[k]).slice(0, 24)}` })), '', `campVarField(${i},'${flowId}',val)`, 'sm')}</label>`
    : `<p class="muted" style="font-size:12px;margin:8px 0 0">O webhook "${esc(h.name)}" ainda não recebeu dados. Dispare um teste para ele e as variáveis aparecem aqui.</p>`;
}

function campVarField(i, flowId, key) {
  const input = document.querySelector(`.cp-var[data-i="${i}"]`);
  if (input && key) { input.value = `{webhook.${flowId}.${key}}`; campPreview(); }
}

// Amostra dos tokens no preview (nome do 1º contato do público, últimos valores do webhook)
function campSampleFill(v) {
  const c0 = (window._campContacts || [])[0];
  return String(v || '')
    .replace(/\{contato\.nome\}/gi, (c0 && c0.name) || 'Maria')
    .replace(/\{contato\.email\}/gi, (c0 && c0.email) || 'cliente@email.com')
    .replace(/\{contato\.telefone\}/gi, c0 ? '+' + c0.waId : '+55 11 99999-8888')
    .replace(/\{webhook\.([\w-]+)\.([\w.-]+)\}/gi, (m, f, k) => {
      const h = (window._campHooks || []).find(x => x.flowId === f);
      return (h && h.lastVars && h.lastVars[k] !== undefined) ? String(h.lastVars[k]) : '[' + k + ']';
    });
}

function campPreview() {
  const el = $('#cp-phone'); if (!el) return;
  const t = window._campTpls[+ecSelVal('cp-tpl')];
  const parts = tplParts(t);
  const vars = $$('.cp-var').map(i => campSampleFill(i.value));
  el.innerHTML = phonePreview({
    headerType: parts.headerType,
    header: fillVars(parts.header, vars),
    body: fillVars(parts.body, vars),
    footer: parts.footer,
    buttons: parts.buttons.map(b => ({ type: b.type, text: b.text, url: b.url, phone_number: b.phone_number }))
  }, { highlightVars: false });
}

// Público com seleção múltipla: chips de etapas do funil ou de tags, com
// contagem por opção e alcance total em tempo real.
function campAudChanged() {
  window._campSel = new Set();
  const v = ecSelVal('cp-aud');
  const contacts = window._campContacts || [];
  const box = $('#cp-aud-extra');
  if (v === 'stage') {
    const stages = state.settings?.stages || [];
    box.innerHTML = `<span class="fb-sub">Marque uma ou mais etapas</span>
      <div class="aud-chips">${stages.map(s => {
        const n = contacts.filter(c => c.stage === s).length;
        return `<button type="button" class="aud-chip" data-v="${esc(s)}" onclick="campAudToggle(this)">${esc(s)} <b>${n}</b></button>`;
      }).join('')}</div>`;
  } else if (v === 'tag') {
    const tagCount = {};
    for (const c of contacts) for (const t of c.tags || []) tagCount[t] = (tagCount[t] || 0) + 1;
    const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]);
    box.innerHTML = tags.length
      ? `<span class="fb-sub">Marque uma ou mais tags</span>
        <div class="aud-chips">${tags.map(([t, n]) => `<button type="button" class="aud-chip" data-v="${esc(t)}" onclick="campAudToggle(this)">${esc(t)} <b>${n}</b></button>`).join('')}</div>`
      : '<p class="muted" style="font-size:12.5px;margin:0">Nenhuma tag ainda — adicione tags aos contatos na aba <a href="#/contacts">Contatos</a>.</p>';
  } else box.innerHTML = '';
  campReach();
}

function campAudToggle(btn) {
  const v = btn.dataset.v;
  if (window._campSel.has(v)) { window._campSel.delete(v); btn.classList.remove('on'); }
  else { window._campSel.add(v); btn.classList.add('on'); }
  campReach();
}

// Alcance calculado na hora (mesma regra do backend)
function campReach() {
  const el = $('#cp-reach'); if (!el) return;
  const v = ecSelVal('cp-aud');
  const contacts = window._campContacts || [];
  const sel = [...(window._campSel || [])];
  let n = contacts.length;
  if (v === 'stage') n = sel.length ? contacts.filter(c => sel.includes(c.stage)).length : 0;
  if (v === 'tag') n = sel.length ? contacts.filter(c => (c.tags || []).some(t => sel.includes(t))).length : 0;
  el.innerHTML = `${ico('users', 13)} Alcance: <b>${fmtN(n)}</b> contato(s)`;
  el.classList.toggle('empty', n === 0);
}

async function createCampaign() {
  const t = window._campTpls[+ecSelVal('cp-tpl')];
  const audType = ecSelVal('cp-aud');
  const values = [...(window._campSel || [])];
  if (audType !== 'all' && !values.length) {
    return toast(audType === 'stage' ? 'Marque pelo menos uma etapa do funil' : 'Marque pelo menos uma tag', 'error');
  }
  const audience = audType === 'all' ? { type: 'all' } : { type: audType, values };
  try {
    const r = await api('/campaigns', {
      body: {
        name: $('#cp-name').value.trim() || t.name,
        templateName: t.name,
        language: t.language,
        vars: $$('.cp-var').map(i => i.value),
        audience
      }
    });
    toast(`Campanha iniciada para ${r.total} contato(s)!`);
    location.hash = '#/campaigns';
  } catch (e) { toast(e.message, 'error'); }
}

async function campaignDetail(id) {
  openModal('<h2>Relatório da campanha</h2><p class="muted">Carregando…</p>');
  try {
    const { campaign: c, stats: s, recipients } = await api('/campaigns/' + id);
    openModal(`
      <h2>${ico('megaphone')} ${esc(c.name)}</h2>
      <p class="muted" style="margin:0;font-size:12.5px">Modelo <code>${esc(c.templateName)}</code> · ${new Date(c.createdAt).toLocaleString('pt-BR')} · <span class="pill ${c.status}">${c.status === 'running' ? 'Enviando' : 'Concluída'}</span></p>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);gap:10px">
        <div class="kpi" style="padding:12px 14px"><span class="lbl">Enviadas</span><div class="val" style="font-size:20px">${s.sent + s.delivered + s.read}</div></div>
        <div class="kpi" style="padding:12px 14px"><span class="lbl">Entregues</span><div class="val" style="font-size:20px">${s.delivered + s.read}</div></div>
        <div class="kpi" style="padding:12px 14px"><span class="lbl">Lidas</span><div class="val" style="font-size:20px">${s.read}</div></div>
        <div class="kpi" style="padding:12px 14px"><span class="lbl">Falhas</span><div class="val" style="font-size:20px;color:${s.failed ? 'var(--red)' : 'inherit'}">${s.failed}</div></div>
      </div>
      <div style="max-height:280px;overflow:auto">
        <table><thead><tr><th>Contato</th><th>Status</th><th>Erro</th></tr></thead><tbody>
          ${recipients.map(rc => `<tr>
            <td><b>${esc(rc.name)}</b><div class="muted" style="font-size:11px">+${esc(rc.waId)}</div></td>
            <td><span class="pill ${esc(rc.status)}">${CAMP_ST[rc.status] || esc(rc.status)}</span></td>
            <td class="muted" style="font-size:12px">${esc(rc.error || '—')}</td>
          </tr>`).join('')}
        </tbody></table>
      </div>
      <div class="row"><button class="btn" onclick="closeModal()">Fechar</button></div>`);
  } catch (e) {
    openModal(`<h2>Relatório</h2><p class="err">${esc(e.message)}</p><button class="btn" onclick="closeModal()">Fechar</button>`);
  }
}

// ==================== BUSCA GLOBAL + ATALHOS ====================
function initSearch() {
  if (window._searchInit) return;
  window._searchInit = true;
  const inp = $('#global-search'), box = $('#tb-results');
  if (!inp || !box) return;
  let t;
  inp.addEventListener('input', () => {
    clearTimeout(t);
    const q = inp.value.trim();
    if (!q) { box.classList.add('hidden'); return; }
    t = setTimeout(async () => {
      try {
        const { contacts } = await api('/contacts?search=' + encodeURIComponent(q));
        box.innerHTML = contacts.length
          ? contacts.slice(0, 8).map(c => `
            <div class="tb-res" onclick="goChat('${c.waId}')">
              ${avatarHtml(c, 'sm')}
              <div><b style="font-size:13px">${esc(c.name)}</b><div class="muted" style="font-size:11.5px">+${esc(c.waId)} · ${esc(c.stage || '')}</div></div>
            </div>`).join('')
          : '<div class="tb-res" style="cursor:default"><span class="muted">Nenhum contato encontrado</span></div>';
        box.classList.remove('hidden');
      } catch {}
    }, 250);
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.tb-search')) box.classList.add('hidden');
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      inp.focus();
    }
    if (e.key === 'Escape') { box.classList.add('hidden'); closeModal(); }
  });
}

function goChat(waId) {
  $('#tb-results').classList.add('hidden');
  $('#global-search').value = '';
  location.hash = '#/inbox';
  setTimeout(() => openChat(waId), 180);
}

// ==================== ABAS DE CONFIGURAÇÕES ====================
function showSettingsTab(name) {
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tabpane').forEach(p => p.classList.toggle('show', p.dataset.pane === name));
}

async function confirmDeregister() {
  if (await confirmModal({
    title: 'Desregistrar número',
    text: 'O número será removido da Cloud API e deixará de enviar e receber mensagens até um novo registro.',
    ok: 'Desregistrar', danger: true
  })) phoneAction('deregister', {});
}

// ==================== CHAT INTERNO (equipe) ====================
let teamData = { threads: [], team: [], sectors: [] };

async function renderTeam() {
  const b = $('#badge-team'); if (b) b.classList.add('hidden');
  if (!state.teamThread) state.teamThread = 'group';
  $('#view').innerHTML = `<div class="inbox team-view">
    <div class="conv-list">
      <div class="conv-head" style="display:block">
        <h1 style="font-size:17px;margin:0 0 10px">Chat interno</h1>
        ${state.agent ? `<div class="my-status">${['online', 'busy', 'away', 'offline'].map(s => {
          const [lbl, cls] = AG_PRESENCE[s];
          return `<button class="stbtn ${state.agent.presence === s ? 'on' : ''}" onclick="setMyStatus('${s}')" title="${lbl}"><span class="pres-dot ${cls}"></span>${lbl}</button>`;
        }).join('')}</div>` : ''}
        <div class="row" style="gap:7px">
          <button class="btn small" style="flex:1" onclick="addMemberModal()">${ico('plus', 12)} Novo membro</button>
          <button class="btn small" style="flex:1" onclick="addSectorModal()">${ico('hashtag', 12)} Adicionar setor</button>
        </div>
      </div>
      <div class="conv-scroll" id="team-side">${skel(4)}</div>
    </div>
    <div class="chat">
      <div class="chat-head" id="team-head"></div>
      <div class="chat-scroll" id="team-scroll">${skel(4)}</div>
      <div class="composer">
        <div class="line">
          <textarea id="team-input" rows="1" placeholder="Escreva uma mensagem… (Enter envia)"></textarea>
          <button class="btn primary send-btn" onclick="sendTeamMsg()">${ico('send', 18)}</button>
        </div>
      </div>
    </div>
  </div>`;
  const inp = $('#team-input');
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTeamMsg(); } });
  try {
    const d = await api('/team');
    teamData = d;
    paintTeamSide();
    if (!d.threads.some(t => t.id === state.teamThread)) state.teamThread = 'group';
    await openThread(state.teamThread, true);
  } catch (e) { toast(e.message, 'error'); }
}

function threadIcon(t) {
  if (t.kind === 'group') return ico('users', 15);
  if (t.kind === 'sector') return ico('hashtag', 15);
  return null; // dm usa avatar
}
function paintTeamSide() {
  const side = $('#team-side'); if (!side) return;
  const channels = teamData.threads.filter(t => t.kind === 'group' || t.kind === 'sector');
  const dms = teamData.threads.filter(t => t.kind === 'dm');
  const row = t => {
    const active = t.id === state.teamThread ? ' active' : '';
    const av = t.kind === 'dm'
      ? `<span class="team-dm-av">${avatarHtml({ name: t.name }, 'sm')}${presenceDot(t.presence || 'offline')}</span>`
      : `<span class="team-chan-ic">${threadIcon(t)}</span>`;
    const sub = t.kind === 'dm'
      ? `${(AG_PRESENCE[t.presence] || ['Offline'])[0]} · ${esc(t.role || 'Atendente')}`
      : (t.last ? esc((t.last.from ? t.last.from + ': ' : '') + t.last.text) : (t.desc || 'Canal'));
    const del = t.kind === 'sector' ? `<button class="icon-btn tiny" title="Excluir setor" onclick="event.stopPropagation();delSector('${t.sectorId}')">${ico('trash', 13)}</button>`
      : t.kind === 'dm' ? `<button class="icon-btn tiny" title="Remover membro" onclick="event.stopPropagation();removeMember('${t.memberId}')">${ico('trash', 13)}</button>` : '';
    return `<div class="conv-item team-item${active}" onclick="openThread('${t.id}')">
      ${av}
      <div class="conv-meta"><div class="name"><span>${esc(t.name)}</span>${t.last ? `<time>${timeAgo(t.last.ts)}</time>` : ''}</div>
      <div class="prev">${sub}${t.unread ? `<b class="badge">${t.unread}</b>` : ''}</div></div>
      ${del}</div>`;
  };
  side.innerHTML = `
    <div class="team-me"><span class="avatar sm" style="background:#10B981">${esc((state.user || 'V')[0].toUpperCase())}</span><div><b style="font-size:13px">${esc(state.user || 'Você')}</b><div class="muted" style="font-size:11px">Você · online</div></div></div>
    <div class="team-grp">Canais</div>
    ${channels.map(row).join('')}
    <div class="team-grp">Mensagens diretas</div>
    ${dms.length ? dms.map(row).join('') : '<p class="muted" style="padding:8px 12px;font-size:12px">Adicione membros para conversar em particular.</p>'}`;
}

async function openThread(id, initial) {
  state.teamThread = id;
  document.querySelectorAll('.team-item').forEach(el => el.classList.remove('active'));
  paintTeamSide();
  const head = $('#team-head'), sc = $('#team-scroll');
  if (sc) sc.innerHTML = skel(3);
  try {
    const { thread, messages } = await api('/team/thread/' + id);
    if (head) {
      const av = thread.kind === 'dm' ? avatarHtml({ name: thread.name }) : `<span class="avatar" style="background:#10B981">${thread.kind === 'sector' ? '#' : '@'}</span>`;
      const sub = thread.kind === 'dm' ? `Conversa privada · ${esc(thread.role || 'Atendente')}`
        : thread.kind === 'sector' ? 'Canal do setor — visível para a equipe' : 'Canal geral — todos os atendentes';
      head.innerHTML = `${av}<div class="info"><b>${esc(thread.name)}</b><span>${sub}</span></div>`;
    }
    if (sc) {
      sc.innerHTML = messages.length ? messages.map(teamBubble).join('')
        : `<div class="chat-empty"><div class="ce-ic">${ico('chat2', 44)}</div><b>${thread.kind === 'dm' ? 'Converse em particular' : 'Comece a conversa'}</b><p class="muted" style="font-size:13px">Mensagens internas — não vão para o WhatsApp dos clientes.</p></div>`;
      sc.scrollTop = sc.scrollHeight;
    }
    if (!initial) $('#team-input')?.focus();
  } catch (e) { toast(e.message, 'error'); }
}

function teamBubble(m) {
  const mine = m.fromId === state.accountId || m.from === state.user;
  return `<div class="tmsg ${mine ? 'mine' : ''}">
    ${mine ? '' : `<span class="tmsg-from">${esc(m.from)}</span>`}
    <div class="tmsg-bub">${esc(m.text)}<time>${fmtTime(m.ts)}</time></div>
  </div>`;
}

function appendTeamMsg(msg) {
  const sc = $('#team-scroll'); if (!sc || !msg) return;
  const empty = sc.querySelector('.chat-empty'); if (empty) sc.innerHTML = '';
  sc.insertAdjacentHTML('beforeend', teamBubble(msg));
  sc.scrollTop = sc.scrollHeight;
}

async function sendTeamMsg() {
  const inp = $('#team-input'); const text = inp.value.trim(); if (!text) return;
  inp.value = '';
  try { await api('/team/thread/' + state.teamThread, { body: { text } }); inp.focus(); }
  catch (e) { toast(e.message, 'error'); inp.value = text; }
}

function addMemberModal() {
  openModal(`<h2>${ico('users')} Novo membro da equipe</h2>
    <label>Nome<input id="mb-name" placeholder="Ex.: Ana Souza"></label>
    <label>Função / setor<input id="mb-role" placeholder="Ex.: Vendas" value="Atendente"></label>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveMember()">${ico('plus', 14)} Adicionar</button></div>`);
  setTimeout(() => $('#mb-name')?.focus(), 60);
}
async function saveMember() {
  const name = $('#mb-name').value.trim(); if (!name) return toast('Informe o nome', 'error');
  try { await api('/team/members', { body: { name, role: $('#mb-role').value.trim() } }); closeModal(); renderTeam(); toast('Membro adicionado'); }
  catch (e) { toast(e.message, 'error'); }
}
async function removeMember(id) {
  if (!await confirmModal({ title: 'Remover membro', text: 'Remover este membro e a conversa privada dele?', ok: 'Remover', danger: true })) return;
  try { await api('/team/members/' + id, { method: 'DELETE' }); if (state.teamThread === 'dm:' + id) state.teamThread = 'group'; renderTeam(); } catch (e) { toast(e.message, 'error'); }
}

function addSectorModal() {
  openModal(`<h2>${ico('hashtag')} Novo setor</h2>
    <label>Nome do setor<input id="sec-name" placeholder="Ex.: Suporte, Financeiro, Vendas"></label>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveSector()">${ico('plus', 14)} Criar setor</button></div>`);
  setTimeout(() => $('#sec-name')?.focus(), 60);
}
async function saveSector() {
  const name = $('#sec-name').value.trim(); if (!name) return toast('Informe o nome', 'error');
  try { const r = await api('/team/sectors', { body: { name } }); closeModal(); state.teamThread = 'sector:' + r.sector.id; renderTeam(); toast('Setor criado'); }
  catch (e) { toast(e.message, 'error'); }
}
async function delSector(id) {
  if (!await confirmModal({ title: 'Excluir setor', text: 'O canal do setor e suas mensagens serão removidos.', ok: 'Excluir', danger: true })) return;
  try { await api('/team/sectors/' + id, { method: 'DELETE' }); if (state.teamThread === 'sector:' + id) state.teamThread = 'group'; renderTeam(); } catch (e) { toast(e.message, 'error'); }
}

// ==================== LINKS RASTREÁVEIS ====================
async function renderLinks() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Links rastreáveis</h1><p>Links curtos com contagem de cliques e disparo de pixels (Meta e Google)</p></div>
      <button class="btn primary no-grow" onclick="openLinkNew()">${ico('plus', 14)} Novo link</button>
    </div>
    <div class="card" id="links-table">${skel(4)}</div>
  </div>`;
  paintLinks();
}

async function paintLinks() {
  const box = $('#links-table'); if (!box) return;
  try {
    const { links } = await api('/links');
    if (!links.length) {
      box.innerHTML = `<div class="empty-state"><div class="big">${ico('link', 40)}</div><b>Nenhum link ainda</b>
        <p class="muted" style="margin:6px auto 16px;max-width:440px">Crie links curtos para bio, anúncios e campanhas. Cada clique é registrado — e, com os pixels configurados, alimenta a Meta e o Google automaticamente.</p>
        <button class="btn primary" onclick="openLinkNew()">Criar primeiro link</button></div>`;
      return;
    }
    box.innerHTML = `<table><thead><tr><th>Link</th><th>Destino</th><th style="text-align:right">Hoje</th><th style="text-align:right">7 dias</th><th style="text-align:right">Total</th><th>Último clique</th><th></th></tr></thead><tbody>
      ${links.map(l => `<tr>
        <td><b>${esc(l.title)}</b><div class="linkrow"><code>${esc(l.shortUrl)}</code><button class="icon-btn" title="Copiar" onclick="copyText('${esc(l.shortUrl)}')">${ico('copy', 13)}</button></div></td>
        <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.dest)}">${esc(l.dest)}</td>
        <td style="text-align:right"><b>${fmtN(l.clicksToday)}</b></td>
        <td style="text-align:right"><b>${fmtN(l.clicks7d)}</b></td>
        <td style="text-align:right"><b>${fmtN(l.clicks)}</b></td>
        <td class="muted">${l.lastClick ? timeAgo(l.lastClick) : '—'}</td>
        <td style="white-space:nowrap">
          <button class="btn small" onclick="openLinkStats('${l.id}')">${ico('activity', 13)} Métricas</button>
          <button class="icon-btn" title="Editar" onclick="openLinkEdit('${l.id}')">${ico('edit', 14)}</button>
          <button class="icon-btn danger" title="Excluir" onclick="delLink('${l.id}')">${ico('trash', 14)}</button>
        </td>
      </tr>`).join('')}</tbody></table>`;
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

const LINK_EVENTS = ['PageView', 'ViewContent', 'Lead', 'Contact', 'InitiateCheckout', 'Subscribe', 'CompleteRegistration', 'Purchase'];
function linkFormHtml(l) {
  l = l || {};
  const u = l.utm || {};
  const phone = (state.wa && state.wa.displayPhoneNumber || '').replace(/\D/g, '');
  return `
    <label>Título<input id="lk-title" value="${esc(l.title || '')}" placeholder="Ex.: Bio do Instagram"></label>
    <label style="margin-top:9px">URL de destino<input id="lk-dest" value="${esc(l.dest || '')}" placeholder="https://… ou wa.me/…"></label>
    ${phone ? `<button class="btn small no-grow" style="margin-top:6px" onclick="$('#lk-dest').value='https://wa.me/${phone}?text='+encodeURIComponent('Olá! Vim pelo link.')">${ico('zap', 12)} Usar meu WhatsApp como destino</button>` : ''}
    ${l.id ? `<p class="muted" style="font-size:12px;margin:8px 0 0">Link curto: <code>${esc(l.shortUrl)}</code></p>`
      : `<label style="margin-top:9px">Apelido personalizado (opcional)<input id="lk-slug" placeholder="ex.: promo-julho → /l/promo-julho"></label>`}
    <div class="row" style="margin-top:11px">
      <label style="flex:1">Evento de conversão${ecSelect('lk-event', LINK_EVENTS.map(e => ({ value: e, label: e })), l.event || 'PageView', 'lkEventChanged()')}</label>
      <label style="flex:1" id="lk-val-wrap" ${(l.event || 'PageView') === 'Purchase' ? '' : 'hidden'}>Valor (R$)<input id="lk-value" value="${esc(l.value || '')}" placeholder="ex.: 97.00"></label>
    </div>
    <details class="utm-box" ${Object.keys(u).length ? 'open' : ''}>
      <summary>${ico('target', 13)} Parâmetros UTM (rastreamento de campanha)</summary>
      <div class="row" style="margin-top:10px">
        <label style="flex:1">utm_source<input id="lk-utm-source" value="${esc(u.source || '')}" placeholder="instagram"></label>
        <label style="flex:1">utm_medium<input id="lk-utm-medium" value="${esc(u.medium || '')}" placeholder="bio, cpc, story"></label>
      </div>
      <div class="row" style="margin-top:9px">
        <label style="flex:1">utm_campaign<input id="lk-utm-campaign" value="${esc(u.campaign || '')}" placeholder="promo-julho"></label>
        <label style="flex:1">utm_content<input id="lk-utm-content" value="${esc(u.content || '')}" placeholder="anuncio-a"></label>
      </div>
    </details>`;
}
function lkEventChanged() { const w = $('#lk-val-wrap'); if (w) w.hidden = ecSelVal('lk-event') !== 'Purchase'; }
function linkBody() {
  return {
    title: $('#lk-title').value, dest: $('#lk-dest').value,
    event: ecSelVal('lk-event'), value: $('#lk-value')?.value || '',
    utm: { source: $('#lk-utm-source').value, medium: $('#lk-utm-medium').value, campaign: $('#lk-utm-campaign').value, content: $('#lk-utm-content').value }
  };
}

// --- Links: criação/edição em página dedicada (sem popup) ---
function openLinkNew() { window._lkEdit = null; location.hash = '#/links/new'; }
function openLinkEdit(id) { window._lkEdit = id; location.hash = '#/links/edit'; }
function openLinkStats(id) { window._lkStats = id; location.hash = '#/links/stats'; }

async function renderLinkForm() {
  const id = state.view === 'links/edit' ? (window._lkEdit || null) : null;
  let l = {};
  if (id) {
    try { const { links } = await api('/links'); l = links.find(x => x.id === id) || {}; } catch {}
    if (!l.id) { toast('Link não encontrado', 'error'); location.hash = '#/links'; return; }
  }
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>${id ? 'Editar link' : 'Novo link rastreável'}</h1><p>${id ? 'Ajuste destino, evento de conversão e parâmetros de rastreamento' : 'Link curto com contagem de cliques e disparo automático dos pixels'}</p></div>
      <button class="btn no-grow" onclick="location.hash='#/links'">← Voltar</button>
    </div>
    <div class="form-2col">
      <div class="card">
        ${linkFormHtml(l)}
        <div class="row" style="margin-top:16px;justify-content:flex-end">
          <button class="btn no-grow" onclick="location.hash='#/links'">Cancelar</button>
          <button class="btn primary no-grow" onclick="${id ? `updateLink('${id}')` : 'saveLink()'}">${ico(id ? 'save' : 'plus', 14)} ${id ? 'Salvar alterações' : 'Criar link'}</button>
        </div>
      </div>
      <div class="card lk-side">
        <h2>${ico('help')} Como funciona</h2>
        <ul class="lk-tips">
          <li><b>Evento de conversão:</b> o que será disparado nos seus pixels a cada clique (Lead, Purchase…). Escolha <b>Purchase</b> para informar o valor da venda.</li>
          <li><b>UTMs:</b> anexados automaticamente à URL de destino — aparecem no Google Analytics e no gerenciador de anúncios.</li>
          <li><b>Pixels:</b> configure em <a href="#/pixels">Pixels</a>. Com a Conversions API ligada, o clique também é enviado pelo servidor (à prova de bloqueadores).</li>
        </ul>
      </div>
    </div>
  </div>`;
  setTimeout(() => $('#lk-title')?.focus(), 60);
}
async function saveLink() {
  try {
    const body = linkBody(); body.slug = $('#lk-slug')?.value || '';
    const r = await api('/links', { body });
    location.hash = '#/links';
    copyText(r.link.shortUrl);
    toast('Link criado e copiado: ' + r.link.shortUrl);
  } catch (e) { toast(e.message, 'error'); }
}
async function updateLink(id) {
  try { await api('/links/' + id, { method: 'PUT', body: linkBody() }); location.hash = '#/links'; toast('Link atualizado'); }
  catch (e) { toast(e.message, 'error'); }
}
async function delLink(id) {
  if (!await confirmModal({ title: 'Excluir link', text: 'Quem clicar no link curto verá "não encontrado". As métricas serão perdidas.', ok: 'Excluir', danger: true })) return;
  try { await api('/links/' + id, { method: 'DELETE' }); paintLinks(); } catch (e) { toast(e.message, 'error'); }
}

async function renderLinkStats() {
  const id = window._lkStats || null;
  if (!id) { location.hash = '#/links'; return; }
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(6)}</div></div>`;
  try {
    const s = await api('/links/' + id + '/stats');
    const total = s.devices.mobile + s.devices.desktop || 1;
    const maxRef = Math.max(1, ...s.referrers.map(r => r.count));
    const u = s.link.utm || {};
    const utmChips = Object.entries(u).map(([k, v]) => `<span class="utm-chip">utm_${k}=<b>${esc(v)}</b></span>`).join('');
    $('#view').innerHTML = `<div class="page">
      <div class="page-head row">
        <div style="flex:1"><h1>${esc(s.link.title)}</h1><p>Métricas e cliques deste link</p></div>
        <button class="btn no-grow" onclick="location.hash='#/links'">← Voltar</button>
        <button class="btn no-grow" onclick="copyText('${esc(s.link.shortUrl)}')">${ico('copy', 13)} Copiar link</button>
        <button class="btn primary no-grow" onclick="openLinkEdit('${id}')">${ico('edit', 13)} Editar</button>
      </div>
      <div class="lk-meta">
        <span class="linkrow"><code>${esc(s.link.shortUrl)}</code></span>
        <span class="lk-meta-arrow">${ico('arrowright', 14)}</span>
        <span class="muted" title="${esc(s.link.dest)}" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.link.dest)}</span>
        <span class="pill">${esc(s.link.event)}${s.link.event === 'Purchase' && s.link.value ? ` · ${s.link.currency} ${esc(s.link.value)}` : ''}</span>
        ${utmChips ? `<span class="utm-chips">${utmChips}</span>` : ''}
      </div>
      <div class="lk-kpis" style="margin-bottom:16px">
        <div><b>${fmtN(s.link.clicks)}</b><span>Total</span></div>
        <div><b>${fmtN(s.link.clicks7d)}</b><span>7 dias</span></div>
        <div><b>${fmtN(s.link.clicksToday)}</b><span>Hoje</span></div>
        <div><b>${s.link.lastClick ? timeAgo(s.link.lastClick) : '—'}</b><span>Último clique</span></div>
      </div>
      <div class="card">
        <h2>${ico('activity')} Cliques — últimos 30 dias</h2>
        ${dayBars(s.byDay)}
      </div>
      <div class="two-col even">
        <div class="card">
          <h2>${ico('radio')} Dispositivos</h2>
          ${hrow('Celular', s.devices.mobile, total)}
          ${hrow('Computador', s.devices.desktop, total)}
        </div>
        <div class="card">
          <h2>${ico('link')} Origens dos cliques</h2>
          ${s.referrers.length ? s.referrers.map(r => hrow(esc(r.host), r.count, maxRef)).join('') : '<p class="muted">Sem origens registradas ainda.</p>'}
        </div>
      </div>
      <div class="card">
        <h2>${ico('clock')} Cliques recentes</h2>
        ${s.recent && s.recent.length ? `<table><thead><tr><th>Quando</th><th>Dispositivo</th><th>Origem</th></tr></thead><tbody>
          ${s.recent.map(c => `<tr><td>${timeAgo(c.ts)}</td><td>${c.mobile ? '📱 Celular' : '💻 Computador'}</td><td class="muted" style="max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.ref ? esc(c.ref) : 'Direto'}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted">Nenhum clique ainda. Divulgue o link para começar a rastrear.</p>'}
      </div>
    </div>`;
  } catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; }
}

// ==================== ASSINATURA & CARTEIRA (SaaS · Woovi Pix) ====================
const BILL_ST = {
  trial: ['Período de teste', 'pill pending'], active: ['Assinatura ativa', 'pill done'],
  past_due: ['Pagamento pendente', 'pill warn'], canceled: ['Cancelada', 'pill']
};
let payPoll = null;

async function renderBilling() {
  clearInterval(payPoll);
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Assinatura &amp; Carteira</h1><p>Plano, pagamentos via Pix, saldo e programa de indicação</p></div>
    <div id="bill-box"><div class="card">${skel(5)}</div></div>
  </div>`;
  paintBilling();
}

async function paintBilling() {
  const box = $('#bill-box'); if (!box) return;
  try {
    const d = await api('/billing');
    const b = d.billing;
    const [stLbl, stCls] = BILL_ST[b.status] || [b.status, 'pill'];
    const plan = b.plan;
    const pc = b.pendingCharge;
    const refLink = `${location.origin}/app/?ref=${d.affiliate.code}`;
    box.innerHTML = `
      ${d.wooviReady ? '' : `<div class="card warn-card">${ico('alert', 16)} <b>Pagamentos ainda não configurados.</b> ${state.kind === 'admin' ? 'Informe o AppID da Woovi em <a href="#/admin">Admin SaaS → Pagamentos</a>.' : 'A plataforma ainda não ativou os pagamentos — fale com o suporte.'}</div>`}

      <div class="card bill-status">
        <div class="bs-main">
          <span class="${stCls}">${stLbl}</span>
          <h2 style="margin:8px 0 2px">${plan ? esc(plan.name) : 'Nenhum plano contratado'}</h2>
          <p class="muted" style="margin:0">
            ${plan ? `${fmtBRL(plan.price)}/mês · ` : ''}
            ${b.periodEnd ? (b.status === 'canceled' ? 'Acesso até ' : (b.status === 'trial' ? 'Teste termina em ' : 'Renova em ')) + new Date(b.periodEnd).toLocaleDateString('pt-BR') : ''}
            ${b.pixAutomatic ? ' · <b style="color:var(--verde-deep)">Pix Automático ativo</b>' : ''}
          </p>
        </div>
        ${b.status === 'active' && !b.canceledAt ? `<button class="btn danger no-grow" onclick="cancelSub()">Cancelar assinatura</button>` : ''}
      </div>

      ${pc ? payBoxHtml(pc) : ''}

      <div class="card">
        <h2>${ico('zap')} Planos</h2>
        ${d.plans.length ? `<div class="plans-grid">${d.plans.map(p => `
          <div class="plan ${plan && plan.id === p.id ? 'current' : ''}">
            <b class="pl-name">${esc(p.name)}</b>
            <div class="pl-price">${fmtBRL(p.price)}<span>/mês</span></div>
            <ul class="pl-feats">${(p.features || []).map(f => `<li>${ico('check', 13)} ${esc(f)}</li>`).join('')}</ul>
            ${plan && plan.id === p.id && b.status === 'active'
              ? '<span class="pill done" style="align-self:center">Plano atual</span>'
              : `<button class="btn primary block" ${d.wooviReady ? '' : 'disabled'} onclick="subscribePlan('${p.id}')">Assinar com Pix</button>`}
          </div>`).join('')}</div>
          <p class="muted" style="font-size:12px;margin:12px 0 0">${ico('shield', 13)} Pagamento processado pela <b>Woovi</b> — Pix na hora e, quando disponível no seu banco, renovação por <b>Pix Automático</b> (sem precisar pagar todo mês manualmente).</p>`
          : '<p class="muted">Nenhum plano publicado ainda.</p>'}
      </div>

      <div class="two-col even">
        <div class="card">
          <h2>${ico('briefcase')} Carteira</h2>
          <div class="wallet-bal"><span>Saldo disponível</span><b>${fmtBRL(d.wallet.balance)}</b></div>
          <div class="row" style="margin-top:12px">
            <label style="flex:1">Adicionar saldo (R$)<input id="wal-amount" placeholder="ex.: 50,00" inputmode="decimal"></label>
            <button class="btn primary no-grow" ${d.wooviReady ? '' : 'disabled'} onclick="topupWallet()">${ico('plus', 14)} Gerar Pix</button>
          </div>
          ${d.wallet.transactions.length ? `<span class="fb-sub" style="margin-top:14px">Extrato</span>
          <div class="tx-list">${d.wallet.transactions.map(t => `
            <div class="tx"><span class="tx-lbl">${esc(t.label)}</span><span class="muted" style="font-size:11px">${timeAgo(t.ts)}</span>
            <b class="${t.amount >= 0 ? 'tx-in' : 'tx-out'}">${t.amount >= 0 ? '+' : ''}${fmtBRL(t.amount)}</b></div>`).join('')}</div>` : ''}
        </div>

        <div class="card aff-card">
          <h2>${ico('sparkles')} Indique e ganhe</h2>
          <p class="muted" style="margin:0 0 10px;font-size:13px">Ganhe <b style="color:var(--verde-deep)">${d.affiliate.percentFirst}%</b> de cada nova assinatura e <b style="color:var(--verde-deep)">${d.affiliate.percentRenewal}%</b> de cada renovação dos indicados — direto na sua carteira.</p>
          <div class="linkrow"><code>${esc(refLink)}</code><button class="icon-btn" title="Copiar" onclick="copyText('${esc(refLink)}')">${ico('copy', 13)}</button></div>
          <div class="lk-kpis" style="margin-top:12px">
            <div><b>${d.affiliate.referrals.length}</b><span>Indicados</span></div>
            <div><b>${fmtBRL(d.affiliate.earned)}</b><span>Comissões</span></div>
          </div>
          ${d.affiliate.referrals.length ? `<span class="fb-sub" style="margin-top:12px">Seus indicados</span>
            ${d.affiliate.referrals.map(r => `<div class="tx"><span class="tx-lbl">${esc(r.name)}</span><span class="pill ${r.status === 'active' ? 'done' : ''}">${(BILL_ST[r.status] || [r.status])[0]}</span></div>`).join('')}` : ''}
          <div class="row" style="margin-top:14px">
            <label style="flex:1.4">Chave Pix p/ saque<input id="wd-key" placeholder="CPF, e-mail ou aleatória"></label>
            <label style="flex:1">Valor (R$)<input id="wd-amount" placeholder="mín. 20,00" inputmode="decimal"></label>
            <button class="btn no-grow" onclick="withdrawWallet()">Sacar</button>
          </div>
          ${d.withdrawals.length ? `<div class="tx-list" style="margin-top:10px">${d.withdrawals.map(w => `
            <div class="tx"><span class="tx-lbl">Saque ${fmtBRL(w.amount)}</span><span class="muted" style="font-size:11px">${timeAgo(w.ts)}</span>
            <span class="pill ${w.status === 'paid' ? 'done' : w.status === 'rejected' ? '' : 'pending'}">${{ pending: 'Em análise', paid: 'Pago', rejected: 'Recusado' }[w.status] || w.status}</span></div>`).join('')}</div>` : ''}
        </div>
      </div>`;
    if (pc) startPayPoll();
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// QR do Pix inline (sem pop-up) + copia-e-cola + polling
function payBoxHtml(pc) {
  return `<div class="card pay-card" id="pay-card">
    <div class="pay-grid">
      <div class="pay-qr">${pc.qrCodeImage ? `<img src="${esc(pc.qrCodeImage)}" alt="QR Code Pix">` : `<div class="pay-qr-ph">${ico('clock', 26)}</div>`}</div>
      <div style="flex:1;min-width:0">
        <h2 style="margin:0 0 4px">${ico('zap')} Pague com Pix para ativar</h2>
        <p class="muted" style="margin:0 0 10px;font-size:13px">${pc.kind === 'topup' ? 'Recarga de saldo' : 'Assinatura'} — <b>${fmtBRL(pc.amount)}</b>. Escaneie o QR ou use o copia-e-cola. A confirmação é automática.</p>
        ${pc.brCode ? `<label>Pix copia-e-cola<textarea readonly rows="3" style="font-size:11px" onclick="this.select()">${esc(pc.brCode)}</textarea></label>` : ''}
        <div class="row" style="margin-top:10px">
          ${pc.brCode ? `<button class="btn no-grow" onclick="copyText(${JSON.stringify(esc(pc.brCode))})">${ico('copy', 13)} Copiar código</button>` : ''}
          ${pc.paymentLinkUrl ? `<a class="btn no-grow" href="${esc(pc.paymentLinkUrl)}" target="_blank" rel="noopener">${ico('link', 13)} Abrir página de pagamento</a>` : ''}
          <button class="btn no-grow" onclick="checkPending(true)">${ico('refresh', 13)} Já paguei</button>
          <button class="btn danger no-grow" onclick="cancelPending()">Cancelar</button>
        </div>
        <p class="muted" id="pay-status" style="font-size:12px;margin:10px 0 0">${ico('clock', 12)} Aguardando pagamento…</p>
      </div>
    </div>
  </div>`;
}

function startPayPoll() {
  clearInterval(payPoll);
  payPoll = setInterval(() => { if (state.view !== 'billing') return clearInterval(payPoll); checkPending(false); }, 5000);
}
async function checkPending(manual) {
  try {
    const r = await api('/billing/pending');
    if (r.paid) {
      clearInterval(payPoll);
      toast('Pagamento confirmado! 🎉');
      paintBilling();
    } else if (manual) {
      const el = $('#pay-status');
      if (el) el.innerHTML = `${ico('clock', 12)} Ainda não identificamos o pagamento (status: ${esc(r.status || 'aguardando')}). Ele confirma em segundos após o Pix.`;
    }
  } catch (e) { if (manual) toast(e.message, 'error'); }
}
async function subscribePlan(planId) {
  try {
    await api('/billing/subscribe', { body: { planId } });
    toast('Cobrança Pix gerada — escaneie o QR para ativar');
    paintBilling();
    setTimeout(() => $('#pay-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  } catch (e) { toast(e.message, 'error'); }
}
async function topupWallet() {
  try {
    await api('/billing/topup', { body: { amount: $('#wal-amount').value } });
    toast('Pix de recarga gerado');
    paintBilling();
    setTimeout(() => $('#pay-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  } catch (e) { toast(e.message, 'error'); }
}
async function cancelPending() {
  try { await api('/billing/pending/cancel', { body: {} }); clearInterval(payPoll); paintBilling(); } catch (e) { toast(e.message, 'error'); }
}
async function cancelSub() {
  if (!await confirmModal({ title: 'Cancelar assinatura', text: 'Você mantém o acesso até o fim do período já pago. A renovação automática será desativada.', ok: 'Cancelar assinatura', danger: true })) return;
  try { await api('/billing/cancel', { body: {} }); toast('Assinatura cancelada'); paintBilling(); } catch (e) { toast(e.message, 'error'); }
}
async function withdrawWallet() {
  try {
    await api('/wallet/withdraw', { body: { pixKey: $('#wd-key').value, amount: $('#wd-amount').value } });
    toast('Saque solicitado! Cai na análise do admin.');
    paintBilling();
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== ADMIN SaaS (plataforma) ====================
async function renderAdmin() {
  if (state.kind !== 'admin') { location.hash = '#/dashboard'; return; }
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Admin SaaS</h1><p>Receita, contas, planos, afiliados e pagamentos Woovi</p></div>
    <div class="tabs">
      <button class="active" data-tab="adm-vis" onclick="showSettingsTab('adm-vis')">Visão geral</button>
      <button data-tab="adm-acc" onclick="showSettingsTab('adm-acc')">Contas</button>
      <button data-tab="adm-pl" onclick="showSettingsTab('adm-pl')">Planos</button>
      <button data-tab="adm-aff" onclick="showSettingsTab('adm-aff')">Afiliados</button>
      <button data-tab="adm-pay" onclick="showSettingsTab('adm-pay')">Pagamentos</button>
      <button data-tab="adm-wd" onclick="showSettingsTab('adm-wd')">Saques</button>
      <button data-tab="adm-seo" onclick="showSettingsTab('adm-seo')">SEO</button>
    </div>
    <div id="adm-box"><div class="card">${skel(6)}</div></div>
  </div>`;
  paintAdmin();
}

async function paintAdmin() {
  const box = $('#adm-box'); if (!box) return;
  try {
    const d = await api('/admin/saas');
    const m = d.metrics;
    const activeTab = $('.tabs button.active')?.dataset.tab || 'adm-vis';
    box.innerHTML = `
      <div class="tabpane ${activeTab === 'adm-vis' ? 'show' : ''}" data-pane="adm-vis">
        <div class="metric-hero">
          <div class="mh-card hi"><span class="mh-ic">${ico('zap', 20)}</span><div class="mh-val">${fmtBRL(m.mrr)}</div><div class="mh-lbl">MRR (receita recorrente)</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('activity', 20)}</span><div class="mh-val">${fmtBRL(m.revenue30d)}</div><div class="mh-lbl">Receita — 30 dias</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('briefcase', 20)}</span><div class="mh-val">${fmtBRL(m.totalRevenue)}</div><div class="mh-lbl">Receita total</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('users', 20)}</span><div class="mh-val">${fmtN(m.accounts)}</div><div class="mh-lbl">Contas</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('check', 20)}</span><div class="mh-val">${fmtN(m.activeSubs)}</div><div class="mh-lbl">Assinaturas ativas</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('clock', 20)}</span><div class="mh-val">${fmtN(m.trials)}</div><div class="mh-lbl">Em teste</div></div>
        </div>
        <div class="card">
          <h2>${ico('activity')} Últimos pagamentos</h2>
          ${d.revenue.length ? `<table><thead><tr><th>Quando</th><th>Conta</th><th>Tipo</th><th style="text-align:right">Valor</th></tr></thead><tbody>
            ${d.revenue.slice(0, 12).map(r => { const a = d.accounts.find(x => x.id === r.accountId); return `<tr><td>${timeAgo(r.ts)}</td><td><b>${esc(a ? a.name : r.accountId)}</b></td><td><span class="pill">${{ first: 'Nova assinatura', renewal: 'Renovação', topup: 'Recarga' }[r.kind] || r.kind}</span></td><td style="text-align:right"><b>${fmtBRL(r.amount)}</b></td></tr>`; }).join('')}
          </tbody></table>` : '<p class="muted">Nenhum pagamento confirmado ainda.</p>'}
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-acc' ? 'show' : ''}" data-pane="adm-acc">
        <div class="card">
          <h2>${ico('users')} Contas (${d.accounts.length})</h2>
          ${d.accounts.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Conta</th><th>Plano</th><th>Status</th><th>Expira</th><th>WA</th><th style="text-align:right">Carteira</th><th>Indicações</th><th></th></tr></thead><tbody>
            ${d.accounts.map(a => {
              const pl = d.plans.find(p => p.id === a.billing.planId);
              const [sl, sc] = BILL_ST[a.billing.status] || [a.billing.status, 'pill'];
              return `<tr>
                <td><b>${esc(a.name)}</b><div class="muted" style="font-size:11.5px">${esc(a.email)}</div></td>
                <td>${pl ? esc(pl.name) : '—'}</td>
                <td><span class="${sc}">${sl}</span></td>
                <td class="muted">${a.billing.periodEnd ? new Date(a.billing.periodEnd).toLocaleDateString('pt-BR') : '—'}</td>
                <td>${a.waConnected ? '<span class="ok-dot">●</span>' : '<span class="bad-dot">●</span>'}</td>
                <td style="text-align:right">${fmtBRL(a.walletBalance)}</td>
                <td>${a.referrals ? `<b>${a.referrals}</b> · ${fmtBRL(a.affEarned)}` : '—'}</td>
                <td style="white-space:nowrap"><button class="btn small" onclick="admExtend('${a.id}')">+30 dias</button></td>
              </tr>`;
            }).join('')}
          </tbody></table></div>` : '<p class="muted">Nenhuma conta de cliente ainda. Divulgue o link de cadastro!</p>'}
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-pl' ? 'show' : ''}" data-pane="adm-pl">
        <div class="card">
          <h2>${ico('plus')} Novo plano</h2>
          <div class="row">
            <label style="flex:1.2">Nome<input id="pl-name" placeholder="ex.: Profissional"></label>
            <label>Preço mensal (R$)<input id="pl-price" placeholder="97,00" inputmode="decimal"></label>
            <label>Dias por ciclo<input id="pl-days" value="30" inputmode="numeric"></label>
          </div>
          <label style="margin-top:9px">Recursos (um por linha)<textarea id="pl-feats" rows="3" placeholder="Atendimento ilimitado&#10;Campanhas e automações&#10;Suporte prioritário"></textarea></label>
          <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn primary no-grow" onclick="admCreatePlan()">${ico('save', 14)} Criar plano</button></div>
        </div>
        <div class="card">
          <h2>${ico('columns')} Planos publicados</h2>
          ${d.plans.filter(p => !p.archived).length ? `<table><thead><tr><th>Plano</th><th>Preço</th><th>Ciclo</th><th>Assinantes</th><th></th></tr></thead><tbody>
            ${d.plans.filter(p => !p.archived).map(p => `<tr>
              <td><b>${esc(p.name)}</b><div class="muted" style="font-size:11.5px">${(p.features || []).join(' · ')}</div></td>
              <td><b>${fmtBRL(p.price)}</b></td><td>${p.periodDays}d</td>
              <td>${d.accounts.filter(a => a.billing.planId === p.id && a.billing.status === 'active').length}</td>
              <td style="text-align:right"><button class="icon-btn danger" title="Arquivar" onclick="admDelPlan('${p.id}')">${ico('trash', 14)}</button></td>
            </tr>`).join('')}
          </tbody></table>` : '<p class="muted">Nenhum plano ainda — crie o primeiro acima.</p>'}
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-aff' ? 'show' : ''}" data-pane="adm-aff">
        <div class="card">
          <h2>${ico('sparkles')} Programa de afiliados</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Todo cliente tem um link de indicação. A comissão cai na carteira do afiliado <b>automaticamente</b> a cada pagamento confirmado do indicado — na primeira assinatura e em toda renovação.</p>
          <div class="row">
            <label>% na 1ª assinatura<input id="aff-first" value="${d.config.affiliate.percentFirst}" inputmode="numeric"></label>
            <label>% nas renovações<input id="aff-ren" value="${d.config.affiliate.percentRenewal}" inputmode="numeric"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({percentFirst:$('#aff-first').value,percentRenewal:$('#aff-ren').value})">${ico('save', 14)} Salvar</button>
          </div>
        </div>
        <div class="card">
          <h2>${ico('users')} Top afiliados</h2>
          ${d.accounts.filter(a => a.referrals > 0).length ? `<table><thead><tr><th>Afiliado</th><th>Código</th><th>Indicados</th><th style="text-align:right">Comissões</th></tr></thead><tbody>
            ${d.accounts.filter(a => a.referrals > 0).sort((a, b) => b.affEarned - a.affEarned).map(a => `<tr>
              <td><b>${esc(a.name)}</b></td><td><code>${a.refCode}</code></td><td>${a.referrals}</td><td style="text-align:right"><b>${fmtBRL(a.affEarned)}</b></td>
            </tr>`).join('')}
          </tbody></table>` : '<p class="muted">Nenhuma indicação registrada ainda.</p>'}
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-pay' ? 'show' : ''}" data-pane="adm-pay">
        <div class="card">
          <h2>${ico('shield')} Woovi — Pix &amp; Pix Automático</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Crie uma conta em <b>app.woovi.com</b>, gere um <b>AppID</b> em API/Plugins → Nova integração e cole abaixo. Método de pagamento: <b>apenas Pix</b> (cobrança na hora) e <b>Pix Automático</b> (recorrência) — sem cartão.</p>
          <div class="row">
            <label style="flex:2">AppID da Woovi ${d.config.woovi.configured ? `<span class="pill done" style="margin-left:6px">Configurado ${esc(d.config.woovi.appId)}</span>` : ''}<input id="wv-appid" type="password" placeholder="Q2xpZW50X0lkX…"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({wooviAppId:$('#wv-appid').value})">${ico('save', 14)} Salvar</button>
            <button class="btn no-grow" onclick="admTestWoovi(this)">${ico('activity', 14)} Testar conexão</button>
          </div>
          <label class="chk" style="margin-top:12px"><input type="checkbox" id="wv-auto" ${d.config.woovi.pixAutomatic ? 'checked' : ''} onchange="admSaveConfig({pixAutomatic:this.checked})"> Tentar Pix Automático (assinatura recorrente) — se indisponível, cai para Pix avulso por renovação</label>
          <div class="capi-box" style="margin-top:14px">
            <div class="capi-head">${ico('webhook', 14)} Webhook de confirmação <span class="capi-tag">obrigatório em produção</span></div>
            <p class="muted" style="font-size:12px;margin:6px 0 0">Em app.woovi.com → Webhooks, cadastre a URL <code>${location.origin}/woovi-webhook</code> para os eventos de <b>cobrança paga</b>. Cada pagamento é verificado de novo na API antes de ativar (anti-fraude).</p>
          </div>
        </div>
        <div class="card">
          <h2>${ico('gear')} Regras de cobrança</h2>
          <div class="row">
            <label>Dias de teste grátis<input id="bl-trial" value="${d.config.billing.trialDays}" inputmode="numeric"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({trialDays:$('#bl-trial').value})">${ico('save', 14)} Salvar</button>
          </div>
          <label class="chk" style="margin-top:12px"><input type="checkbox" id="bl-enforce" ${d.config.billing.enforce ? 'checked' : ''} onchange="admSaveConfig({enforce:this.checked})"> Bloquear envios quando a assinatura expirar (senão, apenas avisa)</label>
          <div class="row" style="margin-top:16px;align-items:flex-end">
            <label style="flex:2">Texto do botão da landing (opcional)<input id="bl-cta" value="${esc(d.config.landing && d.config.landing.ctaText || '')}" placeholder="${(d.config.billing.trialDays > 0 ? 'Testar por ' + d.config.billing.trialDays + ' dias' : 'Começar agora')} (automático se vazio)"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({ctaText:$('#bl-cta').value})">${ico('save', 14)} Salvar copy</button>
          </div>
          <p class="muted" style="font-size:11.5px;margin:8px 0 0">Vazio = automático: <b>“Testar por N dias”</b> quando há teste grátis, ou <b>“Começar agora”</b> quando são 0 dias.</p>
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-wd' ? 'show' : ''}" data-pane="adm-wd">
        <div class="card">
          <h2>${ico('download-circle')} Saques de afiliados</h2>
          ${d.withdrawals.length ? `<table><thead><tr><th>Quando</th><th>Conta</th><th>Chave Pix</th><th style="text-align:right">Valor</th><th>Status</th><th></th></tr></thead><tbody>
            ${d.withdrawals.map(w => `<tr>
              <td>${timeAgo(w.ts)}</td><td><b>${esc(w.accountName || w.accountId)}</b></td><td><code>${esc(w.pixKey)}</code></td>
              <td style="text-align:right"><b>${fmtBRL(w.amount)}</b></td>
              <td><span class="pill ${w.status === 'paid' ? 'done' : w.status === 'rejected' ? '' : 'pending'}">${{ pending: 'Pendente', paid: 'Pago', rejected: 'Recusado' }[w.status]}</span></td>
              <td style="white-space:nowrap">${w.status === 'pending' ? `
                <button class="btn small" onclick="admWithdraw('${w.id}','paid')">Marcar pago</button>
                <button class="btn small danger" onclick="admWithdraw('${w.id}','reject')">Recusar</button>` : ''}</td>
            </tr>`).join('')}
          </tbody></table>` : '<p class="muted">Nenhum pedido de saque.</p>'}
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-seo' ? 'show' : ''}" data-pane="adm-seo">
        ${admSeoForm(d.seo || {})}
      </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function admCreatePlan() {
  try {
    await api('/admin/plans', { body: { name: $('#pl-name').value, price: $('#pl-price').value, periodDays: $('#pl-days').value, features: $('#pl-feats').value } });
    toast('Plano criado!'); paintAdmin();
    setTimeout(() => showSettingsTab('adm-pl'), 60);
  } catch (e) { toast(e.message, 'error'); }
}
async function admDelPlan(id) {
  if (!await confirmModal({ title: 'Arquivar plano', text: 'Novos clientes não poderão assiná-lo. Assinantes atuais continuam até cancelarem.', ok: 'Arquivar', danger: true })) return;
  try { await api('/admin/plans/' + id, { method: 'DELETE' }); paintAdmin(); setTimeout(() => showSettingsTab('adm-pl'), 60); } catch (e) { toast(e.message, 'error'); }
}
async function admSaveConfig(body) {
  try { await api('/admin/config', { method: 'PUT', body }); toast('Configuração salva'); } catch (e) { toast(e.message, 'error'); }
}
async function admTestWoovi(btn) {
  if (btn) { btn.disabled = true; }
  try { const r = await api('/admin/woovi/test'); toast(`Woovi conectada! API respondeu (${r.charges} cobrança(s) na 1ª página).`); }
  catch (e) { toast('Falha na Woovi: ' + e.message, 'error'); }
  finally { if (btn) btn.disabled = false; }
}
async function admWithdraw(id, action) {
  try { await api('/admin/withdrawals/' + id, { method: 'PUT', body: { action } }); paintAdmin(); setTimeout(() => showSettingsTab('adm-wd'), 60); } catch (e) { toast(e.message, 'error'); }
}
async function admExtend(id) {
  try { await api('/admin/accounts/' + id + '/billing', { method: 'PUT', body: { extendDays: 30, status: 'active' } }); toast('Assinatura estendida por 30 dias'); paintAdmin(); setTimeout(() => showSettingsTab('adm-acc'), 60); } catch (e) { toast(e.message, 'error'); }
}

// ---------- Admin → SEO da página de marketing ----------
function admSeoForm(seo) {
  const v = k => esc(seo[k] || '');
  return `
    <div class="card">
      <h2>${ico('target')} SEO da página de marketing</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">Personalize como sua página inicial (a landing pública em <code>${location.origin}/</code>) aparece no Google e ao ser compartilhada. As tags são injetadas no HTML lido pelos buscadores.</p>
      <div class="row">
        <label style="flex:2">Título (title / aba do navegador)<input id="seo-title" maxlength="180" value="${v('title')}" placeholder="EliteChat — CRM de WhatsApp com IA"></label>
        <label style="flex:1">Theme color<input id="seo-theme" value="${v('themeColor')}" placeholder="#34D399"></label>
      </div>
      <label style="margin-top:9px">Descrição (meta description — ideal até 160 caracteres)<textarea id="seo-desc" rows="2" maxlength="400" placeholder="Automatize o atendimento no WhatsApp, gerencie leads e dispare campanhas com o EliteChat.">${v('description')}</textarea></label>
      <div class="row" style="margin-top:9px">
        <label style="flex:2">Palavras-chave (separadas por vírgula)<input id="seo-keywords" maxlength="400" value="${v('keywords')}" placeholder="crm whatsapp, disparo em massa, chatbot"></label>
        <label style="flex:1">Autor<input id="seo-author" maxlength="120" value="${v('author')}" placeholder="EliteChat"></label>
      </div>
      <h3 class="notif-sub">Compartilhamento (Open Graph / redes sociais)</h3>
      <div class="row">
        <label style="flex:1">Título ao compartilhar<input id="seo-ogtitle" maxlength="180" value="${v('ogTitle')}" placeholder="(usa o título acima se vazio)"></label>
      </div>
      <label style="margin-top:9px">Descrição ao compartilhar<textarea id="seo-ogdesc" rows="2" maxlength="400" placeholder="(usa a descrição acima se vazio)">${v('ogDescription')}</textarea></label>
      <label style="margin-top:9px">Imagem de preview (URL — 1200×630 recomendado)<input id="seo-ogimage" maxlength="600" value="${v('ogImage')}" placeholder="${location.origin}/assets/elitechat-logo.png"></label>
      <h3 class="notif-sub">Avançado</h3>
      <div class="row">
        <label style="flex:2">URL canônica<input id="seo-canonical" maxlength="400" value="${v('canonical')}" placeholder="${location.origin}/"></label>
        <label style="flex:1">Robots<input id="seo-robots" maxlength="60" value="${v('robots')}" placeholder="index, follow"></label>
      </div>
      <label style="margin-top:9px">Google Analytics ID (opcional)<input id="seo-ga" maxlength="40" value="${v('gaId')}" placeholder="G-XXXXXXXXXX"></label>
      <label style="margin-top:9px">HTML extra no &lt;head&gt; (opcional — verificação de domínio, scripts)<textarea id="seo-extra" rows="3" maxlength="4000" placeholder="<meta name=&quot;google-site-verification&quot; content=&quot;...&quot;>">${v('extraHead')}</textarea></label>
      <div class="row" style="margin-top:14px;justify-content:space-between;align-items:center">
        <a class="btn no-grow" href="/" target="_blank" rel="noopener">${ico('activity', 14)} Ver a página</a>
        <button class="btn primary no-grow" onclick="admSaveSeo()">${ico('save', 14)} Salvar SEO</button>
      </div>
    </div>`;
}
async function admSaveSeo() {
  const body = {
    title: $('#seo-title').value, description: $('#seo-desc').value, keywords: $('#seo-keywords').value,
    author: $('#seo-author').value, themeColor: $('#seo-theme').value,
    ogTitle: $('#seo-ogtitle').value, ogDescription: $('#seo-ogdesc').value, ogImage: $('#seo-ogimage').value,
    canonical: $('#seo-canonical').value, robots: $('#seo-robots').value, gaId: $('#seo-ga').value,
    extraHead: $('#seo-extra').value
  };
  try { await api('/admin/seo', { method: 'PUT', body }); toast('SEO salvo — já vale na página inicial'); } catch (e) { toast(e.message, 'error'); }
}

// ==================== LIGAÇÕES (Calling API) — tela de chamada WhatsApp ====================
// Recebida: webhook "calls" (connect) chega por SSE com o SDP offer → overlay
// toca → Atender cria o RTCPeerConnection no navegador (áudio via WebRTC) e
// envia o SDP answer para a Meta. Recusar/Desligar usam as ações oficiais.
let callUI = null; // { id, waId, name, direction, phase: incoming|calling|active|ended, sdpOffer, pc, stream, timer, startedAt, muted }

function onCallEvent(d) {
  if (d.kind === 'incoming') {
    if (callUI) return; // já em chamada — a Meta trata o busy do outro lado
    callUI = { ...d.call, sdpOffer: d.sdpOffer, phase: 'incoming', muted: false };
    paintCall();
    if (window.ECNotify) {
      const who = (d.call && (d.call.name || d.call.contactName)) || (d.call && d.call.waId ? '+' + d.call.waId : 'Contato');
      ECNotify.notify({ type: 'call', title: 'Chamada de voz', body: who + ' está te ligando…', waId: d.call && d.call.waId, url: '/app/#/inbox', tag: 'call:' + (d.call && d.call.id), requireInteraction: true });
    }
  } else if (d.kind === 'terminate') {
    if (callUI && callUI.id === d.call.id) {
      endCallUI(d.call.duration ? `Encerrada · ${fmtDur(d.call.duration * 1000, true)}` : 'Encerrada');
    }
  } else if (d.kind === 'update') {
    if (callUI && callUI.id === d.call.id && ['accepted', 'ringing'].includes(d.call.status)) {
      if (d.call.status === 'accepted' && callUI.phase === 'calling') { callUI.phase = 'active'; callUI.startedAt = Date.now(); }
      paintCall();
    }
  }
}

const CALL_PHASE_LBL = {
  incoming: 'Chamada de voz recebida…',
  calling: 'Chamando…',
  active: '',
  ended: ''
};

function paintCall() {
  let root = $('#call-root');
  if (!root) { root = document.createElement('div'); root.id = 'call-root'; document.body.appendChild(root); }
  if (!callUI) { root.innerHTML = ''; return; }
  const c = callUI;
  const status = c.phase === 'active'
    ? `<span id="call-timer">00:00</span>`
    : `<span class="call-status-txt">${c.statusMsg || CALL_PHASE_LBL[c.phase] || ''}</span>`;
  root.innerHTML = `
    <div class="call-overlay">
      <div class="call-top">
        ${ico('lock', 12)} <span>Criptografia de ponta a ponta</span>
      </div>
      <div class="call-brand"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.5 2 2 6.4 2 11.9c0 1.9.5 3.7 1.5 5.3L2 22l4.9-1.4c1.5.9 3.3 1.4 5.1 1.4 5.5 0 10-4.4 10-9.9S17.5 2 12 2z"/></svg> WhatsApp · Chamada de voz</div>
      <div class="call-center">
        <span class="call-av ${c.phase === 'incoming' || c.phase === 'calling' ? 'ring' : ''}">${esc(waInitials(c.name || c.waId))}</span>
        <h2>${esc(c.name || '+' + c.waId)}</h2>
        <p class="call-status">${status}</p>
      </div>
      <div class="call-actions">
        ${c.phase === 'incoming' ? `
          <div class="call-act"><button class="call-btn red" onclick="rejectCall()" title="Recusar">${callIcon('down')}</button><span>Recusar</span></div>
          <div class="call-act"><button class="call-btn green pulse" onclick="answerCall()" title="Atender">${callIcon('up')}</button><span>Atender</span></div>
        ` : c.phase === 'ended' ? '' : `
          <div class="call-act"><button class="call-btn dark ${c.muted ? 'on' : ''}" onclick="toggleMute()" title="Mudo">${callIcon('mic')}</button><span>${c.muted ? 'Ativar som' : 'Mudo'}</span></div>
          <div class="call-act"><button class="call-btn red" onclick="hangupCall()" title="Desligar">${callIcon('down')}</button><span>Desligar</span></div>
        `}
      </div>
      <audio id="call-audio" autoplay></audio>
    </div>`;
  if (c.phase === 'active') startCallTimer();
}

function callIcon(kind) {
  if (kind === 'mic') return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v3.5"/></svg>`;
  const up = kind === 'up';
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" style="${up ? '' : 'transform:rotate(135deg)'}"><path d="M6.6 10.8a15.5 15.5 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.2 2.2z"/></svg>`;
}

function startCallTimer() {
  clearInterval(callUI && callUI.timerIv);
  if (!callUI) return;
  callUI.startedAt = callUI.startedAt || Date.now();
  callUI.timerIv = setInterval(() => {
    const el = $('#call-timer');
    if (!el || !callUI) return clearInterval(callUI && callUI.timerIv);
    const s = Math.floor((Date.now() - callUI.startedAt) / 1000);
    el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

// Espera o ICE terminar de colher candidatos (SDP completo, sem trickle)
function waitIce(pc, ms = 2500) {
  return new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const to = setTimeout(res, ms);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(to); res(); } };
  });
}

// ATENDER — WebRTC no navegador: mic local + SDP answer para a Meta
async function answerCall() {
  const c = callUI; if (!c || c.phase !== 'incoming') return;
  try {
    c.statusMsg = 'Conectando…'; paintCall();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection();
    c.pc = pc; c.stream = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = ev => { const a = $('#call-audio'); if (a) a.srcObject = ev.streams[0]; };
    await pc.setRemoteDescription({ type: 'offer', sdp: c.sdpOffer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    await api(`/calls/${c.id}/accept`, { body: { sdp: pc.localDescription.sdp } });
    c.phase = 'active'; c.statusMsg = ''; c.startedAt = Date.now();
    paintCall();
  } catch (e) {
    toast(e.message, 'error');
    endCallUI('Falha ao conectar');
  }
}

async function rejectCall() {
  const c = callUI; if (!c) return;
  try { await api(`/calls/${c.id}/reject`, { body: {} }); } catch {}
  endCallUI('Recusada');
}

async function hangupCall() {
  const c = callUI; if (!c) return;
  try { await api(`/calls/${c.id}/terminate`, { body: {} }); } catch {}
  endCallUI('Encerrada');
}

function toggleMute() {
  const c = callUI; if (!c || !c.stream) { if (c) { c.muted = !c.muted; paintCall(); } return; }
  c.muted = !c.muted;
  c.stream.getAudioTracks().forEach(t => { t.enabled = !c.muted; });
  paintCall();
}

// Ligar a partir da conversa aberta (nome vem do estado, sem escapar em atributo)
function startCallFromChat() {
  const waId = state.currentWaId; if (!waId) return;
  const conv = (state.conversations || []).find(c => c.waId === waId);
  startCall(waId, (conv && conv.name) || waId);
}

// LIGAR para o cliente (business-initiated). Sem permissão prévia, a Meta
// recusa — aí oferecemos enviar o pedido de permissão oficial.
async function startCall(waId, name) {
  if (callUI) return toast('Você já está em uma chamada', 'error');
  callUI = { id: null, waId, name, direction: 'BUSINESS_INITIATED', phase: 'calling', muted: false };
  paintCall();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection();
    callUI.pc = pc; callUI.stream = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = ev => { const a = $('#call-audio'); if (a) a.srcObject = ev.streams[0]; };
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    const r = await api('/calls/start', { body: { to: waId, sdp: pc.localDescription.sdp } });
    if (callUI) callUI.id = r.callId;
  } catch (e) {
    endCallUI('');
    // sem permissão do cliente → oferece o pedido oficial
    if (await confirmModal({
      title: 'Não foi possível ligar',
      text: (e.message || '') + '\n\nLigações para o cliente exigem a permissão dele (regra da Meta). Quer enviar agora o pedido de permissão oficial pelo WhatsApp?',
      ok: 'Enviar pedido de permissão'
    })) {
      try { await api('/calls/permission', { body: { to: waId } }); toast('Pedido de permissão enviado!'); if (state.view === 'inbox') loadChat(waId, true); }
      catch (err) { toast(err.message, 'error'); }
    }
  }
}

function endCallUI(msg) {
  const c = callUI; if (!c) return;
  clearInterval(c.timerIv);
  try { c.stream && c.stream.getTracks().forEach(t => t.stop()); } catch {}
  try { c.pc && c.pc.close(); } catch {}
  c.phase = 'ended'; c.statusMsg = msg || 'Encerrada';
  paintCall();
  const root = $('#call-root');
  if (root) root.querySelector('.call-status').innerHTML = `<span class="call-status-txt">${esc(c.statusMsg)}</span>`;
  setTimeout(() => { callUI = null; paintCall(); }, 1400);
}

// ==================== ATENDENTES · PERMISSÕES · DESEMPENHO · LOGS ====================
let agData = null;
const AG_PRESENCE = {
  online: ['Online', 'ok'], busy: ['Em atendimento', 'warn'],
  away: ['Ausente', 'pending'], offline: ['Offline', 'off']
};

function presenceDot(p) { const [lbl, cls] = AG_PRESENCE[p] || AG_PRESENCE.offline; return `<span class="pres-dot ${cls}" title="${lbl}"></span>`; }
function agAvatar(a, size = 40) {
  const s = `width:${size}px;height:${size}px;font-size:${Math.round(size / 2.6)}px`;
  return a && a.photo
    ? `<span class="ag-av" style="${s}"><img src="${esc(a.photo)}" alt=""></span>`
    : `<span class="ag-av" style="${s}">${esc(waInitials((a && a.name) || '?'))}</span>`;
}
function fmtDur2(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
}

async function renderAgents() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row" style="align-items:center">
      <div style="flex:1"><h1>Atendentes</h1><p>Equipe, permissões e acessos ao sistema</p></div>
      <a class="btn no-grow" href="#/agents/perf">${ico('activity', 14)} Desempenho</a>
      <a class="btn no-grow" href="#/agents/logs">${ico('file', 14)} Logs</a>
      ${can('agents', 'create') ? `<button class="btn primary no-grow" onclick="agEdit()">${ico('plus', 14)} Novo atendente</button>` : ''}
    </div>
    <div id="ag-box">${skel(4)}</div>
  </div>`;
  await loadAgents();
}

async function loadAgents() {
  try { agData = await api('/agents'); } catch (e) { $('#ag-box').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  paintAgents();
}

function paintAgents() {
  const box = $('#ag-box'); if (!box || !agData) return;
  const list = agData.agents;
  if (!list.length) {
    box.innerHTML = `<div class="empty-state card"><div class="big">${ico('users', 38)}</div><b>Nenhum atendente ainda</b>
      <p class="muted" style="margin:6px auto 16px;max-width:440px">Crie atendentes com login próprio e defina o que cada um pode acessar.</p>
      ${can('agents', 'create') ? `<button class="btn primary" onclick="agEdit()">${ico('plus', 14)} Criar atendente</button>` : ''}</div>`;
    return;
  }
  box.innerHTML = `<div class="ag-grid">${list.map(a => `
    <div class="card ag-card ${a.active ? '' : 'inactive'}">
      <div class="ag-head">
        ${agAvatar(a, 46)}
        <div style="flex:1;min-width:0">
          <b class="ag-name">${esc(a.name)} ${presenceDot(a.presence)}</b>
          <span class="muted" style="font-size:12.5px">${esc(a.role || 'Atendente')}</span>
        </div>
        ${a.active ? '' : '<span class="pill">Inativo</span>'}
      </div>
      <div class="ag-info">
        ${a.email ? `<div>${ico('mail', 12)} ${esc(a.email)}</div>` : '<div class="muted">Sem login (só chat interno)</div>'}
        ${a.phone ? `<div>${ico('phone', 12)} ${esc(a.phone)}</div>` : ''}
        <div class="muted">${ico('clock', 12)} ${a.lastLoginAt ? 'Último acesso ' + timeAgo(a.lastLoginAt) : 'Nunca acessou'}</div>
        <div class="muted">Criado ${new Date(a.createdAt).toLocaleDateString('pt-BR')}</div>
      </div>
      <div class="ag-perms">${agPermsSummary(a)}</div>
      <div class="ag-actions">
        ${can('agents', 'edit') ? `<button class="btn small" onclick="agEdit('${a.id}')">${ico('edit', 12)} Editar</button>` : ''}
        ${can('agents', 'edit') ? `<button class="btn small" onclick="agResetPass('${a.id}')">${ico('lock', 12)} Senha</button>` : ''}
        ${can('agents', 'edit') ? `<button class="btn small" onclick="agToggle('${a.id}', ${a.active})">${a.active ? ico('slash', 12) + ' Desativar' : ico('check', 12) + ' Ativar'}</button>` : ''}
        ${can('agents', 'delete') ? `<button class="icon-btn danger" title="Excluir" onclick="agDelete('${a.id}')">${ico('trash', 14)}</button>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

function agPermsSummary(a) {
  const mods = agData.modules.filter(m => a.permissions[m.key] && a.permissions[m.key].view);
  if (mods.length === agData.modules.length) return '<span class="pill done">Acesso total</span>';
  if (!mods.length) return '<span class="pill">Sem acesso</span>';
  return mods.slice(0, 6).map(m => `<span class="pill sm">${esc(m.label)}</span>`).join('') + (mods.length > 6 ? ` <span class="muted" style="font-size:11px">+${mods.length - 6}</span>` : '');
}

// ---- Editor de atendente (foto, dados, permissões) ----
let agDraft = null;
function agEdit(id) {
  const a = id ? agData.agents.find(x => x.id === id) : null;
  agDraft = a
    ? JSON.parse(JSON.stringify(a))
    : { name: '', email: '', phone: '', role: 'Atendente', photo: '', active: true, preset: 'atendente', permissions: null };
  openModal(agFormHtml(!!a));
  // novo atendente: já aplica as permissões do preset escolhido (padrão: atendente)
  setTimeout(() => { if (!a && agDraft.preset && agDraft.preset !== 'custom') agApplyPreset(agDraft.preset); else paintAgPerms(); }, 30);
}

function agFormHtml(isEdit) {
  const a = agDraft;
  const presetOpts = [{ value: 'atendente', label: 'Atendente (padrão)' }, { value: 'supervisor', label: 'Supervisor' }, { value: 'admin', label: 'Acesso total' }, { value: 'custom', label: 'Personalizado' }];
  return `<div class="ag-modal">
    <h2>${ico(isEdit ? 'edit' : 'plus')} ${isEdit ? 'Editar atendente' : 'Novo atendente'}</h2>
    <div class="ag-form-top">
      <label class="ag-photo-pick" title="Escolher foto">
        <input type="file" accept="image/*" hidden onchange="agPickPhoto(this)">
        <span id="ag-photo">${agAvatar(a, 64)}</span>
        <em>${ico('image', 12)} Foto</em>
      </label>
      <div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label>Nome<input id="ag-name" value="${esc(a.name)}" placeholder="Nome do atendente"></label>
        <label>Cargo<input id="ag-role" value="${esc(a.role)}" placeholder="Ex.: Vendas"></label>
        <label>E-mail (login)<input id="ag-email" type="email" value="${esc(a.email)}" placeholder="atendente@empresa.com"></label>
        <label>Telefone<input id="ag-phone" value="${esc(a.phone)}" placeholder="(11) 99999-8888"></label>
      </div>
    </div>
    ${isEdit ? '' : `<label>Senha inicial<input id="ag-pass" type="password" placeholder="mín. 6 caracteres (opcional se sem e-mail)"></label>`}
    <div class="ag-perm-head">
      <b>Permissões</b>
      <label class="ag-preset">Perfil${ecSelect('ag-preset', presetOpts, a.preset || 'custom', 'agApplyPreset(val)', 'sm')}</label>
    </div>
    <div id="ag-perms" class="ag-perm-grid"></div>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="agSave('${isEdit ? a.id : ''}')">${ico('save', 14)} Salvar</button>
    </div>
  </div>`;
}

const AG_ACTION_LBL = { view: 'Ver', create: 'Criar', edit: 'Editar', delete: 'Excluir' };
function ensureDraftPerms() {
  if (!agDraft.permissions) {
    agDraft.permissions = {};
    for (const m of agData.modules) { agDraft.permissions[m.key] = { view: false, create: false, edit: false, delete: false }; }
  }
  return agDraft.permissions;
}
// Um botão ligar/desligar por módulo. LIGADO = acesso completo (ver, criar,
// editar e excluir) — sem seleção de ações individuais.
function paintAgPerms() {
  const box = $('#ag-perms'); if (!box) return;
  const p = ensureDraftPerms();
  const onCount = agData.modules.filter(m => p[m.key] && p[m.key].view).length;
  box.innerHTML = `
    <div class="ag-perm-top">
      <span class="muted">${onCount} de ${agData.modules.length} módulos liberados · módulo ativado = acesso completo</span>
      <span><button class="btn small ghost no-grow" onclick="agAllPerms(true)">Liberar tudo</button>
        <button class="btn small ghost no-grow" onclick="agAllPerms(false)">Limpar</button></span>
    </div>
    ${agData.modules.map(m => {
      const on = !!(p[m.key] && p[m.key].view);
      return `<div class="ag-perm-item ${on ? 'on' : ''}">
        <div class="ag-perm-line">
          <b>${esc(m.label)}</b>
          <button type="button" class="toggle ${on ? 'on' : ''}" onclick="agToggleModule('${m.key}')"><span></span></button>
        </div>
      </div>`;
    }).join('')}`;
}
// LIGADO = todas as ações; DESLIGADO = nenhuma.
function agToggleModule(mod) {
  const p = ensureDraftPerms();
  const on = !p[mod].view;
  p[mod] = { view: on, create: on, edit: on, delete: on };
  agSetCustom();
  paintAgPerms();
}
function agAllPerms(val) {
  const p = ensureDraftPerms();
  for (const m of agData.modules) p[m.key] = { view: val, create: val, edit: val, delete: val };
  agSetCustom();
  paintAgPerms();
}
function agSetCustom() { agDraft.preset = 'custom'; ecSelPick('ag-preset', 'custom'); }
function agApplyPreset(preset) {
  agDraft.preset = preset;
  if (preset === 'custom') return;
  // pede o preset pronto ao backend seria ideal; aqui replicamos as regras
  const all = (v) => { const o = {}; for (const m of agData.modules) o[m.key] = { view: v, create: v, edit: v, delete: v }; return o; };
  if (preset === 'admin') agDraft.permissions = all(true);
  else if (preset === 'supervisor') { agDraft.permissions = all(true); for (const ac of agData.actions) { agDraft.permissions.agents[ac] = ac === 'view'; agDraft.permissions.settings[ac] = ac === 'view'; } }
  else { // atendente
    agDraft.permissions = all(false);
    const allow = (mod, acts) => acts.forEach(a => { if (agDraft.permissions[mod]) agDraft.permissions[mod][a] = true; });
    allow('dashboard', ['view']); allow('inbox', ['view', 'create', 'edit']); allow('team', ['view', 'create']);
    allow('contacts', ['view', 'create', 'edit']); allow('funnel', ['view', 'edit']);
    allow('templates', ['view']); allow('quick', ['view']); allow('schedule', ['view', 'create', 'edit', 'delete']);
  }
  paintAgPerms();
}
function agPickPhoto(input) {
  const f = input.files && input.files[0]; if (!f) return;
  if (f.size > 3 * 1024 * 1024) return toast('Imagem muito grande (máx. 3 MB)', 'error');
  const reader = new FileReader();
  reader.onload = () => { agDraft.photo = reader.result; $('#ag-photo').innerHTML = agAvatar(agDraft, 64); };
  reader.readAsDataURL(f);
}
async function agSave(id) {
  // módulo ligado = acesso completo (regra da UI simplificada)
  const norm = {};
  const p = ensureDraftPerms();
  for (const m of agData.modules) {
    const on = !!(p[m.key] && p[m.key].view);
    norm[m.key] = { view: on, create: on, edit: on, delete: on };
  }
  const body = {
    name: $('#ag-name').value.trim(),
    email: $('#ag-email').value.trim(),
    phone: $('#ag-phone').value.trim(),
    role: $('#ag-role').value.trim(),
    photo: agDraft.photo || '',
    permissions: norm
  };
  if (!id) body.pass = $('#ag-pass').value;
  if (!body.name) return toast('Informe o nome', 'error');
  try {
    if (id) await api('/agents/' + id, { method: 'PUT', body });
    else await api('/agents', { body });
    closeModal(); toast('Atendente salvo'); loadAgents();
  } catch (e) { toast(e.message, 'error'); }
}
async function agToggle(id, active) {
  try { await api('/agents/' + id, { method: 'PUT', body: { active: !active } }); loadAgents(); }
  catch (e) { toast(e.message, 'error'); }
}
async function agDelete(id) {
  const a = agData.agents.find(x => x.id === id);
  if (!await confirmModal({ title: 'Excluir atendente', text: `"${a.name}" perderá o acesso e as conversas dele serão liberadas. Esta ação não pode ser desfeita.`, ok: 'Excluir', danger: true })) return;
  try { await api('/agents/' + id, { method: 'DELETE' }); toast('Atendente excluído'); loadAgents(); }
  catch (e) { toast(e.message, 'error'); }
}
async function agResetPass(id) {
  const pass = await promptModal({ title: 'Redefinir senha', label: 'Nova senha (mín. 6)', placeholder: '••••••' });
  if (!pass) return;
  try { await api('/agents/' + id + '/password', { body: { pass } }); toast('Senha redefinida'); }
  catch (e) { toast(e.message, 'error'); }
}

// ---- Desempenho ----
async function renderAgentPerf() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row" style="align-items:center">
      <a class="btn no-grow" href="#/agents">${ico('arrowleft', 14)} Voltar</a>
      <div style="flex:1"><h1>Desempenho dos atendentes</h1><p>Produtividade, tempos de resposta e atendimento</p></div>
    </div>
    <div id="perf-box">${skel(4)}</div>
  </div>`;
  try {
    const d = await api('/agents/performance');
    const rk = d.ranking;
    $('#perf-box').innerHTML = `
      <div class="svc-kpis" style="margin-bottom:18px">
        <div class="svc-kpi ok"><span class="svc-ic">${ico('users', 16)}</span><b>${d.online}</b><span>Online agora</span></div>
        <div class="svc-kpi"><span class="svc-ic">${ico('slash', 16)}</span><b>${d.offline}</b><span>Offline</span></div>
        <div class="svc-kpi"><span class="svc-ic">${ico('message', 16)}</span><b>${d.overall.handled}</b><span>Conversas atendidas</span></div>
        <div class="svc-kpi"><span class="svc-ic">${ico('check-circle', 16)}</span><b>${d.overall.finished}</b><span>Finalizadas</span></div>
      </div>
      <div class="card">
        <h2>${ico('activity')} Ranking de produtividade</h2>
        ${rk.length ? `<div style="overflow-x:auto"><table><thead><tr>
          <th>#</th><th>Atendente</th><th>Status</th><th style="text-align:right">Atendidas</th><th style="text-align:right">Finalizadas</th>
          <th style="text-align:right">Em andamento</th><th style="text-align:right">1ª resposta</th><th style="text-align:right">Atendimento</th><th style="text-align:right">Avaliação</th><th style="text-align:right">Score</th>
        </tr></thead><tbody>
          ${rk.map((r, i) => `<tr>
            <td><b>${i + 1}º</b></td>
            <td><div class="cell-user">${agAvatar(r, 30)} <b>${esc(r.name)}</b></div></td>
            <td>${presenceDot(r.presence)} ${(AG_PRESENCE[r.presence] || [''])[0]}</td>
            <td style="text-align:right">${r.handled}</td>
            <td style="text-align:right">${r.finished}</td>
            <td style="text-align:right">${r.ongoing}</td>
            <td style="text-align:right">${fmtDur2(r.avgFirstResponseMs)}</td>
            <td style="text-align:right">${fmtDur2(r.avgHandleTimeMs)}</td>
            <td style="text-align:right">${r.avgRatingPercent == null ? '—' : r.avgRatingPercent + '%'}</td>
            <td style="text-align:right"><b class="pill done">${r.score}</b></td>
          </tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Nenhum atendente ativo ainda.</p>'}
        <p class="muted" style="font-size:11.5px;margin-top:10px">A avaliação média será alimentada pela Pesquisa de Satisfação conforme os clientes respondem.</p>
      </div>`;
  } catch (e) { $('#perf-box').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// ---- Logs de ações ----
let logFilters = { agentId: '', action: '', from: '', to: '' };
async function renderAgentLogs() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row" style="align-items:center">
      <a class="btn no-grow" href="#/agents">${ico('arrowleft', 14)} Voltar</a>
      <div style="flex:1"><h1>Logs de ações</h1><p>Tudo o que os atendentes fizeram no sistema</p></div>
    </div>
    <div id="log-box">${skel(4)}</div>
  </div>`;
  loadLogs();
}
async function loadLogs() {
  const box = $('#log-box'); if (!box) return;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(logFilters)) if (v) qs.set(k, v);
  try {
    const d = await api('/agents/logs?' + qs.toString());
    const agOpts = [{ value: '', label: 'Todos os atendentes' }].concat(d.agents.map(a => ({ value: a.id, label: a.name })));
    const acOpts = [{ value: '', label: 'Todas as ações' }].concat(Object.entries(d.actions).map(([k, l]) => ({ value: k, label: l })));
    box.innerHTML = `
      <div class="card">
        <div class="co-filters">
          <label style="min-width:170px">Atendente${ecSelect('lg-ag', agOpts, logFilters.agentId, "logFilter('agentId',val)", 'sm')}</label>
          <label style="min-width:180px">Tipo de ação${ecSelect('lg-ac', acOpts, logFilters.action, "logFilter('action',val)", 'sm')}</label>
          <label>De<input type="date" id="lg-from" value="${logFilters.from ? new Date(+logFilters.from).toISOString().slice(0, 10) : ''}" onchange="logFilter('from', this.value ? +new Date(this.value) : '')"></label>
          <label>Até<input type="date" id="lg-to" value="${logFilters.to ? new Date(+logFilters.to).toISOString().slice(0, 10) : ''}" onchange="logFilter('to', this.value ? +new Date(this.value)+86399999 : '')"></label>
        </div>
      </div>
      <div class="card">
        <h2 style="margin-bottom:10px">${ico('file')} ${d.total} registro(s)</h2>
        ${d.logs.length ? `<div class="log-list">${d.logs.map(l => `
          <div class="log-row">
            <span class="log-ic">${ico(LOG_ICON[l.action] || 'activity', 14)}</span>
            <div style="flex:1;min-width:0">
              <b>${esc(l.label)}</b> ${l.detail ? `<span class="muted">— ${esc(l.detail)}</span>` : ''}
              <div class="muted" style="font-size:11.5px">${esc(l.agentName)}</div>
            </div>
            <time class="muted" style="font-size:11.5px;white-space:nowrap">${new Date(l.ts).toLocaleString('pt-BR')}</time>
          </div>`).join('')}</div>`
        : '<p class="muted">Nenhum registro com esses filtros.</p>'}
      </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
function logFilter(k, v) { logFilters[k] = v; loadLogs(); }
const LOG_ICON = {
  login: 'check-circle', logout: 'slash', conversation_assigned: 'users', conversation_transferred: 'arrowright',
  conversation_finished: 'check-circle', contact_updated: 'edit', settings_updated: 'gear',
  agent_created: 'plus', agent_updated: 'edit', agent_deleted: 'trash',
  schedule_created: 'calendar', schedule_updated: 'edit', schedule_deleted: 'trash', campaign_sent: 'megaphone'
};

// ==================== AGENDAMENTOS (calendário) ====================
const SC_COLORS = {
  green: 'var(--verde-esc)', blue: '#2f7fb5', amber: '#e79009',
  red: 'var(--red)', violet: '#8b5cf6', gray: 'var(--muted)'
};
const sc = { view: 'month', cursor: startOfDay(Date.now()), events: [], meta: null, filters: { agentId: '', stage: '' } };

function startOfDay(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return +d; }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return +d; }
function scRangeFor() {
  if (sc.view === 'day') return { from: sc.cursor, to: addDays(sc.cursor, 1) - 1 };
  if (sc.view === 'week') { const d = new Date(sc.cursor); const from = addDays(sc.cursor, -d.getDay()); return { from, to: addDays(from, 7) - 1 }; }
  const d = new Date(sc.cursor); const first = startOfDay(new Date(d.getFullYear(), d.getMonth(), 1)); const gridStart = addDays(first, -new Date(first).getDay());
  return { from: gridStart, to: addDays(gridStart, 42) - 1 };
}

async function renderSchedule() {
  $('#view').innerHTML = `<div class="page sched-page">
    <div class="page-head row" style="align-items:center;gap:10px">
      <div style="flex:1"><h1>Agendamentos</h1><p id="sc-period"></p></div>
      <div class="seg" id="sc-views">
        ${[['month', 'Mês'], ['week', 'Semana'], ['day', 'Dia']].map(([k, l]) => `<button class="${sc.view === k ? 'on' : ''}" onclick="scSetView('${k}')">${l}</button>`).join('')}
      </div>
      ${can('schedule', 'create') ? `<button class="btn primary no-grow" onclick="scEdit()">${ico('plus', 14)} Novo</button>` : ''}
    </div>
    <div class="card sched-toolbar">
      <button class="icon-btn" onclick="scNav(-1)">${ico('arrowleft', 16)}</button>
      <button class="btn small no-grow" onclick="scToday()">Hoje</button>
      <button class="icon-btn" onclick="scNav(1)" title="Próximo">${ico('arrowright', 16)}</button>
      <div style="flex:1"></div>
      <span id="sc-filters"></span>
    </div>
    <div class="card sched-cal" id="sc-cal">${skel(4)}</div>
  </div>`;
  await loadSchedule();
}

async function loadSchedule() {
  const r = scRangeFor();
  const qs = new URLSearchParams({ from: r.from, to: r.to });
  if (sc.filters.agentId) qs.set('agentId', sc.filters.agentId);
  if (sc.filters.stage) qs.set('stage', sc.filters.stage);
  try {
    const d = await api('/schedules?' + qs.toString());
    sc.events = d.events; sc.meta = d;
    paintSchedule();
  } catch (e) { $('#sc-cal').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function scSetView(v) { sc.view = v; $$('#sc-views button').forEach(b => b.classList.toggle('on', b.textContent === ({ month: 'Mês', week: 'Semana', day: 'Dia' }[v]))); loadSchedule(); }
function scToday() { sc.cursor = startOfDay(Date.now()); loadSchedule(); }
function scNav(dir) {
  if (sc.view === 'day') sc.cursor = addDays(sc.cursor, dir);
  else if (sc.view === 'week') sc.cursor = addDays(sc.cursor, dir * 7);
  else { const d = new Date(sc.cursor); sc.cursor = +new Date(d.getFullYear(), d.getMonth() + dir, 1); }
  loadSchedule();
}
function scFilter(k, v) { sc.filters[k] = v; loadSchedule(); }

function paintSchedule() {
  const meta = sc.meta;
  const agOpts = [{ value: '', label: 'Todos os atendentes' }].concat((meta.agents || []).map(a => ({ value: a.id, label: a.name })));
  const stOpts = [{ value: '', label: 'Todos os funis' }].concat((meta.stages || []).map(s => ({ value: s, label: s })));
  $('#sc-filters').innerHTML = `<span style="display:inline-flex;gap:8px;align-items:center">
    ${ecSelect('sc-f-ag', agOpts, sc.filters.agentId, "scFilter('agentId',val)", 'sm')}
    ${ecSelect('sc-f-st', stOpts, sc.filters.stage, "scFilter('stage',val)", 'sm')}
  </span>`;
  const d = new Date(sc.cursor);
  $('#sc-period').textContent = sc.view === 'day'
    ? d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
    : d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const cal = $('#sc-cal');
  if (sc.view === 'month') cal.innerHTML = scMonthHtml();
  else cal.innerHTML = scTimeGridHtml();
  scBindDnD();
}

function scEventsOn(dayStart) {
  const dayEnd = addDays(dayStart, 1);
  return sc.events.filter(e => e.start < dayEnd && e.end > dayStart).sort((a, b) => a.start - b.start);
}
function scChip(e, opts = {}) {
  const late = !e.done && e.end < Date.now();
  return `<div class="sc-ev ${e.done ? 'done' : ''} ${late ? 'late' : ''}" draggable="${can('schedule', 'edit')}" data-id="${e.id}"
    style="--evc:${SC_COLORS[e.color] || SC_COLORS.green}" onclick="event.stopPropagation();scOpen('${e.id}')">
    ${opts.time !== false ? `<b>${new Date(e.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b> ` : ''}${esc(e.title)}
    ${e.contact ? `<span class="sc-ev-sub">${esc(e.contact.name)}</span>` : ''}
  </div>`;
}

function scMonthHtml() {
  const r = scRangeFor();
  const dows = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  let cells = '';
  const month = new Date(sc.cursor).getMonth();
  for (let i = 0; i < 42; i++) {
    const day = addDays(r.from, i);
    const dd = new Date(day);
    const evs = scEventsOn(day);
    const isToday = day === startOfDay(Date.now());
    cells += `<div class="sc-cell ${dd.getMonth() === month ? '' : 'out'} ${isToday ? 'today' : ''}" data-day="${day}" onclick="scEdit(null, ${day + 9 * 3600000})">
      <span class="sc-daynum">${dd.getDate()}</span>
      <div class="sc-cell-evs">${evs.slice(0, 4).map(e => scChip(e)).join('')}${evs.length > 4 ? `<span class="sc-more">+${evs.length - 4}</span>` : ''}</div>
    </div>`;
  }
  return `<div class="sc-month"><div class="sc-dow">${dows.map(x => `<span>${x}</span>`).join('')}</div><div class="sc-grid">${cells}</div></div>`;
}

function scTimeGridHtml() {
  const r = scRangeFor();
  const days = sc.view === 'day' ? [sc.cursor] : Array.from({ length: 7 }, (_, i) => addDays(r.from, i));
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const head = `<div class="sc-tg-head"><span class="sc-tg-corner"></span>${days.map(d => {
    const dt = new Date(d); const today = d === startOfDay(Date.now());
    return `<span class="${today ? 'today' : ''}">${dt.toLocaleDateString('pt-BR', { weekday: 'short' })}<b>${dt.getDate()}</b></span>`;
  }).join('')}</div>`;
  const rows = hours.map(h => `<div class="sc-tg-row"><span class="sc-tg-hour">${String(h).padStart(2, '0')}:00</span>${days.map(d => `<span class="sc-tg-cell" data-slot="${d + h * 3600000}" onclick="scEdit(null, ${d + h * 3600000})"></span>`).join('')}</div>`).join('');
  // eventos posicionados
  const evLayer = days.map((d, di) => scEventsOn(d).map(e => {
    const top = ((new Date(e.start).getHours() * 60 + new Date(e.start).getMinutes()) / 60) * 48;
    const h = Math.max(22, (e.durationMin / 60) * 48);
    const colW = 100 / days.length;
    return `<div class="sc-tg-ev ${e.done ? 'done' : ''}" draggable="${can('schedule', 'edit')}" data-id="${e.id}"
      style="--evc:${SC_COLORS[e.color] || SC_COLORS.green};top:${top}px;height:${h}px;left:calc(48px + ${di * colW}% * ${(days.length) / days.length});width:calc(${colW}% - 6px)"
      onclick="event.stopPropagation();scOpen('${e.id}')">
      <b>${new Date(e.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</b> ${esc(e.title)}
      ${e.contact ? `<span class="sc-ev-sub">${esc(e.contact.name)}</span>` : ''}</div>`;
  }).join('')).join('');
  return `<div class="sc-tg" style="--cols:${days.length}">${head}<div class="sc-tg-body">${rows}<div class="sc-tg-layer">${evLayer}</div></div></div>`;
}

// Drag-and-drop: soltar em outro dia/horário move o evento
function scBindDnD() {
  if (!can('schedule', 'edit')) return;
  let dragId = null;
  $$('.sc-ev[draggable=true], .sc-tg-ev[draggable=true]').forEach(el => {
    el.addEventListener('dragstart', e => { dragId = el.dataset.id; e.dataTransfer.effectAllowed = 'move'; });
  });
  const drop = (sel, getTs) => $$(sel).forEach(cell => {
    cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('sc-drop'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('sc-drop'));
    cell.addEventListener('drop', async e => {
      e.preventDefault(); cell.classList.remove('sc-drop');
      if (!dragId) return;
      const ev = sc.events.find(x => x.id === dragId); if (!ev) return;
      const base = getTs(cell);
      let newStart;
      if (sc.view === 'month') { const od = new Date(ev.start); newStart = base + od.getHours() * 3600000 + od.getMinutes() * 60000; }
      else newStart = base;
      try { await api('/schedules/' + dragId, { method: 'PUT', body: { start: newStart } }); dragId = null; loadSchedule(); }
      catch (err) { toast(err.message, 'error'); }
    });
  });
  drop('.sc-cell', c => Number(c.dataset.day));
  drop('.sc-tg-cell', c => Number(c.dataset.slot));
}

// ---- Modal de agendamento ----
let scDraft = null;
function scEdit(id, presetStart) {
  const e = id ? sc.events.find(x => x.id === id) : null;
  scDraft = e ? JSON.parse(JSON.stringify(e)) : {
    title: '', description: '', notes: '', color: 'green',
    start: presetStart || (startOfDay(Date.now()) + 9 * 3600000), durationMin: 30,
    contactWaId: '', agentId: '', stage: '', reminders: [15]
  };
  openModal(scFormHtml(!!e));
}
function scFormHtml(isEdit) {
  const e = scDraft, meta = sc.meta;
  const dt = new Date(e.start);
  const dateVal = dt.toISOString().slice(0, 10);
  const timeVal = dt.toTimeString().slice(0, 5);
  const agOpts = [{ value: '', label: 'Nenhum' }].concat((meta.agents || []).map(a => ({ value: a.id, label: a.name })));
  const stOpts = [{ value: '', label: 'Nenhum' }].concat((meta.stages || []).map(s => ({ value: s, label: s })));
  const contactOpts = [{ value: '', label: 'Nenhum contato' }].concat((state.conversations || []).slice(0, 200).map(c => ({ value: c.waId, label: c.name })));
  const durOpts = [15, 30, 45, 60, 90, 120].map(m => ({ value: String(m), label: m < 60 ? m + ' min' : (m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'min' : '') }));
  return `<div class="sc-modal">
    <h2>${ico(isEdit ? 'edit' : 'plus')} ${isEdit ? 'Editar agendamento' : 'Novo agendamento'}</h2>
    <label>Título<input id="sc-title" value="${esc(e.title)}" placeholder="Ex.: Ligar para o cliente"></label>
    <div class="row" style="gap:10px">
      <label style="flex:1">Data<input type="date" id="sc-date" value="${dateVal}"></label>
      <label style="flex:1">Hora<input type="time" id="sc-time" value="${timeVal}"></label>
      <label style="flex:1">Duração${ecSelect('sc-dur', durOpts, String(e.durationMin), null, 'sm')}</label>
    </div>
    <div class="row" style="gap:10px">
      <label style="flex:1">Contato${ecSelect('sc-contact', contactOpts, e.contactWaId, null, 'sm')}</label>
      <label style="flex:1">Atendente${ecSelect('sc-agent', agOpts, e.agentId, null, 'sm')}</label>
      <label style="flex:1">Funil${ecSelect('sc-stage', stOpts, e.stage, null, 'sm')}</label>
    </div>
    <label>Cor
      <div class="sc-colors">${schedColorPick()}</div>
    </label>
    <label>Descrição<textarea id="sc-desc" rows="2" placeholder="O que precisa ser feito">${esc(e.description)}</textarea></label>
    <label>Observações<textarea id="sc-notes" rows="2" placeholder="Notas internas">${esc(e.notes)}</textarea></label>
    <label>Lembretes
      <div class="sc-reminders">${(meta.reminderOptions || []).map(m => `
        <label class="chk"><input type="checkbox" value="${m}" ${(e.reminders || []).includes(m) ? 'checked' : ''}> ${esc(meta.reminderLabels[m] || m + ' min')}</label>`).join('')}</div>
    </label>
    <div class="row" style="justify-content:space-between;margin-top:14px">
      <div>${isEdit && can('schedule', 'create') ? `<button class="btn small" onclick="scDuplicate('${e.id}')">${ico('copy', 12)} Duplicar</button>` : ''}
        ${isEdit && can('schedule', 'delete') ? `<button class="btn small danger" onclick="scDelete('${e.id}')">${ico('trash', 12)} Excluir</button>` : ''}</div>
      <div class="row" style="gap:8px"><button class="btn" onclick="closeModal()">Cancelar</button>
        <button class="btn primary" onclick="scSave('${isEdit ? e.id : ''}')">${ico('save', 14)} Salvar</button></div>
    </div>
  </div>`;
}
function schedColorPick() {
  return (sc.meta.colors || Object.keys(SC_COLORS)).map(c =>
    `<span class="sc-color ${scDraft.color === c ? 'on' : ''}" style="background:${SC_COLORS[c]}" onclick="scDraft.color='${c}';$$('.sc-color').forEach(x=>x.classList.remove('on'));this.classList.add('on')"></span>`).join('');
}
async function scSave(id) {
  const date = $('#sc-date').value, time = $('#sc-time').value || '09:00';
  const start = +new Date(date + 'T' + time);
  const reminders = $$('.sc-reminders input:checked').map(i => Number(i.value));
  const body = {
    title: $('#sc-title').value.trim() || 'Agendamento',
    start, durationMin: Number(ecSelVal('sc-dur')),
    contactWaId: ecSelVal('sc-contact'), agentId: ecSelVal('sc-agent'), stage: ecSelVal('sc-stage'),
    color: scDraft.color,
    description: $('#sc-desc').value, notes: $('#sc-notes').value,
    reminders
  };
  try {
    if (id) await api('/schedules/' + id, { method: 'PUT', body });
    else await api('/schedules', { body });
    closeModal(); toast('Agendamento salvo'); loadSchedule();
  } catch (e) { toast(e.message, 'error'); }
}
async function scDelete(id) {
  if (!await confirmModal({ title: 'Excluir agendamento', ok: 'Excluir', danger: true })) return;
  try { await api('/schedules/' + id, { method: 'DELETE' }); closeModal(); loadSchedule(); }
  catch (e) { toast(e.message, 'error'); }
}
async function scDuplicate(id) {
  try { await api('/schedules/' + id + '/duplicate', { body: {} }); closeModal(); toast('Agendamento duplicado'); loadSchedule(); }
  catch (e) { toast(e.message, 'error'); }
}
// Abrir evento: se tiver contato/conversa, oferece ir direto
function scOpen(id) {
  const e = sc.events.find(x => x.id === id);
  if (e && e.contact) { scEditWithGoto(e); } else scEdit(id);
}
function scEditWithGoto(e) {
  scEdit(e.id);
  // adiciona botão "Abrir conversa" no topo do modal
  setTimeout(() => {
    const h = $('.sc-modal h2');
    if (h && e.contact) {
      const b = document.createElement('button');
      b.className = 'btn small no-grow'; b.style.marginLeft = 'auto';
      b.innerHTML = `${ico('message', 12)} Abrir conversa`;
      b.onclick = () => { closeModal(); location.hash = '#/inbox'; setTimeout(() => openChat(e.contact.waId), 150); };
      h.style.display = 'flex'; h.style.alignItems = 'center'; h.appendChild(b);
    }
  }, 30);
}

// ==================== OPT-IN & OPT-OUT ====================
// Consentimento do contato: quem pediu para sair (opt-out) é bloqueado no
// BACKEND em todos os envios — inclusive templates e campanhas.
let coCfg = null, coMeta = null, coRows = [], coFilters = { status: 'opted_out', uf: '', stage: '', search: '' };

const CO_STATUS = {
  opted_in: { label: 'Ativo (opt-in)', cls: 'done' },
  opted_out: { label: 'Opt-out', cls: 'off' },
  pending: { label: 'Pendente', cls: 'pending' }
};

async function renderConsent() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Opt-in &amp; Opt-out</h1><p>Consentimento dos contatos, palavras-chave de cancelamento e reativação</p></div>
    <div class="tabs">
      <button class="active" data-tab="co-cfg" onclick="showSettingsTab('co-cfg')">Configurações</button>
      <button data-tab="co-list" onclick="showSettingsTab('co-list');loadConsentContacts()">Contatos Opt-out</button>
    </div>
    <div class="tabpane show" data-pane="co-cfg"><div id="co-cfg-box">${skel(5)}</div></div>
    <div class="tabpane" data-pane="co-list"><div id="co-list-box">${skel(4)}</div></div>
  </div>`;
  await loadConsentCfg();
}

async function loadConsentCfg() {
  try {
    const d = await api('/consent');
    coCfg = d.config;
    coMeta = { vars: d.vars, sources: d.sources, stages: d.stages, metrics: d.metrics };
    paintConsentCfg();
  } catch (e) { $('#co-cfg-box').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

function paintConsentCfg() {
  const box = $('#co-cfg-box'); if (!box || !coCfg) return;
  const m = coMeta.metrics || {};
  const stageOpts = [{ value: '', label: 'Primeira etapa do funil (padrão)' }]
    .concat((coMeta.stages || []).map(s => ({ value: s, label: s })));

  box.innerHTML = `
    <div class="co-kpis">
      <div class="svc-kpi ok"><span class="svc-ic">${ico('check-circle', 16)}</span><b>${fmtN(m.active)}</b><span>Contatos ativos</span></div>
      <div class="svc-kpi crit"><span class="svc-ic">${ico('slash', 16)}</span><b>${fmtN(m.optedOut)}</b><span>Em opt-out</span></div>
      <div class="svc-kpi"><span class="svc-ic">${ico('arrow-up', 16)}</span><b>${fmtN(m.optInsToday)}</b><span>Novos opt-ins hoje</span></div>
      <div class="svc-kpi warn"><span class="svc-ic">${ico('arrow-down', 16)}</span><b>${fmtN(m.optOutsToday)}</b><span>Novos opt-outs hoje</span></div>
    </div>

    <div class="sv-grid">
      <div class="sv-form">
        <div class="card">
          <h2>${ico('shield')} Sistema de consentimento</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Com o módulo ativo, contatos em opt-out são <b>bloqueados no backend</b> em qualquer envio (mensagem, template ou campanha), até serem reativados.</p>
          <label class="chk"><input type="checkbox" ${coCfg.enabled ? 'checked' : ''} onchange="coSet('enabled', this.checked)"> Ativar o sistema de Opt-in / Opt-out</label>
          <label class="chk" style="margin-top:10px"><input type="checkbox" ${coCfg.autoOptIn ? 'checked' : ''} onchange="coSet('autoOptIn', this.checked)"> Opt-in automático quando o cliente enviar uma mensagem</label>
        </div>

        <div class="card">
          <h2>${ico('message')} Mensagem de Opt-in</h2>
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">Confirmação enviada quando o contato entra (ou volta) para a lista.</p>
          ${coVarChips('co-in')}
          <textarea id="co-in" rows="5" maxlength="1024" oninput="coSet('optInMessage', this.value)" placeholder="Olá {{nome}}! ✅ ...">${esc(coCfg.optInMessage || '')}</textarea>
          <label class="chk" style="margin-top:10px"><input type="checkbox" ${coCfg.sendOptInMessage ? 'checked' : ''} onchange="coSet('sendOptInMessage', this.checked)"> Enviar esta mensagem no primeiro contato</label>
        </div>

        <div class="card">
          <h2>${ico('slash')} Mensagem de Opt-out</h2>
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">Enviada automaticamente quando o cliente pede o cancelamento (palavra-chave) ou quando um Flow executa a ação.</p>
          ${coVarChips('co-out')}
          <textarea id="co-out" rows="5" maxlength="1024" oninput="coSet('optOutMessage', this.value)" placeholder="Tudo bem, {{nome}}. 👋 ...">${esc(coCfg.optOutMessage || '')}</textarea>
          <label class="chk" style="margin-top:10px"><input type="checkbox" ${coCfg.sendOptOutMessage ? 'checked' : ''} onchange="coSet('sendOptOutMessage', this.checked)"> Confirmar o opt-out para o cliente</label>
        </div>

        <div class="card">
          <h2>${ico('tag')} Palavras-chave de Opt-out</h2>
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">Se o cliente enviar uma destas palavras, o opt-out é registrado automaticamente. A comparação <b>ignora maiúsculas, minúsculas e acentos</b> (CANCELÁR = cancelar).</p>
          <div class="kw-chips" id="co-kw">${coKwHtml('keywords')}</div>
          <div class="row" style="margin-top:9px">
            <input id="co-kw-new" placeholder="Nova palavra (ex.: DESCADASTRAR)" onkeydown="if(event.key==='Enter'){event.preventDefault();coAddKw('keywords','co-kw-new')}">
            <button class="btn small no-grow" onclick="coAddKw('keywords','co-kw-new')">${ico('plus', 12)} Adicionar</button>
          </div>
        </div>

        <div class="card">
          <h2>${ico('refresh')} Palavras-chave de reativação</h2>
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">Permitem que o próprio cliente volte a receber mensagens.</p>
          <div class="kw-chips" id="co-kwin">${coKwHtml('optInKeywords')}</div>
          <div class="row" style="margin-top:9px">
            <input id="co-kwin-new" placeholder="Ex.: VOLTAR" onkeydown="if(event.key==='Enter'){event.preventDefault();coAddKw('optInKeywords','co-kwin-new')}">
            <button class="btn small no-grow" onclick="coAddKw('optInKeywords','co-kwin-new')">${ico('plus', 12)} Adicionar</button>
          </div>
        </div>

        <div class="card">
          <h2>${ico('columns')} Cadastro automático</h2>
          <p class="muted" style="margin:0 0 10px;font-size:12.5px">Contatos novos criados por webhook entram nesta etapa. Quem <b>já existe no funil não é recriado</b> nem movido.</p>
          <label style="max-width:320px">Etapa padrão do funil${ecSelect('co-stage', stageOpts, coCfg.defaultStage || '', "coSet('defaultStage', val)")}</label>
        </div>

        <div class="row" style="justify-content:flex-end">
          <button class="btn primary no-grow" onclick="saveConsentCfg()">${ico('save', 14)} Salvar configurações</button>
        </div>

        ${(coCfg.history || []).length ? `<div class="card">
          <h2>${ico('activity')} Histórico de alterações</h2>
          <div class="tx-list">${coCfg.history.slice(0, 15).map(h => `
            <div class="tx"><span class="tx-lbl">${esc((h.changes || []).join(', '))}</span>
            <span class="muted" style="font-size:11px">${esc(h.by || '')} · ${timeAgo(h.ts)}</span></div>`).join('')}</div>
        </div>` : ''}
      </div>

      <div class="tpl-preview">
        <div class="tpl-preview-lbl">Pré-visualização</div>
        <div class="seg" style="margin:0 auto 12px;display:flex">
          <button class="on" id="co-pv-in" onclick="coPreview('in')">Opt-in</button>
          <button id="co-pv-out" onclick="coPreview('out')">Opt-out</button>
        </div>
        <div id="co-phone"></div>
      </div>
    </div>`;
  coPreview(window._coPv || 'in');
}

// Chips de variáveis dinâmicas — clicar insere no textarea
function coVarChips(target) {
  return `<div class="fb-var-chips" style="margin-bottom:8px">${(coMeta.vars || [])
    .map(v => `<code title="${esc(v.label)}" onclick="coInsertVar('${target}','${v.key}')">{{${v.key}}}</code>`).join('')}</div>`;
}
function coInsertVar(id, key) {
  const el = $('#' + id); if (!el) return;
  const tok = `{{${key}}}`;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + tok + el.value.slice(e);
  el.focus(); el.selectionStart = el.selectionEnd = s + tok.length;
  coSet(id === 'co-in' ? 'optInMessage' : 'optOutMessage', el.value);
}

function coKwHtml(field) {
  const list = coCfg[field] || [];
  return list.length
    ? list.map((k, i) => `<span class="kw-chip">${esc(k)}<button class="icon-btn" title="Remover" onclick="coDelKw('${field}',${i})">${ico('x', 11)}</button></span>`).join('')
    : '<span class="muted" style="font-size:12.5px">Nenhuma palavra cadastrada.</span>';
}
function coAddKw(field, inputId) {
  const el = $('#' + inputId);
  const v = (el.value || '').trim().toUpperCase();
  if (!v) return;
  coCfg[field] = coCfg[field] || [];
  if (coCfg[field].includes(v)) return toast('Essa palavra já está na lista', 'error');
  coCfg[field].push(v);
  el.value = '';
  $(field === 'keywords' ? '#co-kw' : '#co-kwin').innerHTML = coKwHtml(field);
}
function coDelKw(field, i) {
  coCfg[field].splice(i, 1);
  $(field === 'keywords' ? '#co-kw' : '#co-kwin').innerHTML = coKwHtml(field);
}

function coSet(k, v) { coCfg[k] = v; if (k === 'optInMessage' || k === 'optOutMessage') coPreview(window._coPv || 'in'); }

// Preview no mockup do iPhone, com as variáveis resolvidas por um contato de exemplo
function coPreview(which) {
  window._coPv = which;
  $('#co-pv-in')?.classList.toggle('on', which === 'in');
  $('#co-pv-out')?.classList.toggle('on', which === 'out');
  const el = $('#co-phone'); if (!el) return;
  const sample = { nome: 'Maria', empresa: (state.wa && state.wa.verifiedName) || 'Sua Empresa', telefone: '+55 11 99999-8888', email: 'maria@email.com', cidade: 'São Paulo', etapa: 'Novo' };
  const tpl = which === 'in' ? coCfg.optInMessage : coCfg.optOutMessage;
  const body = String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (sample[k] !== undefined ? sample[k] : m));
  el.innerHTML = phonePreview({ body }, { highlightVars: false });
}

async function saveConsentCfg() {
  try {
    const d = await api('/consent', { method: 'PUT', body: coCfg });
    coCfg = d.config; coMeta.metrics = d.metrics;
    paintConsentCfg();
    toast('Configurações de consentimento salvas');
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- Aba: Contatos Opt-out ----------
async function loadConsentContacts() {
  const box = $('#co-list-box'); if (!box) return;
  const qs = new URLSearchParams({
    status: coFilters.status, uf: coFilters.uf, stage: coFilters.stage, search: coFilters.search
  }).toString();
  try {
    const d = await api('/consent/contacts?' + qs);
    coRows = d.contacts;
    paintConsentContacts(d);
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

function coFilter(k, v) { coFilters[k] = v; loadConsentContacts(); }

function paintConsentContacts(d) {
  const box = $('#co-list-box'); if (!box) return;
  const statusOpts = [
    { value: 'opted_out', label: 'Em opt-out' }, { value: 'opted_in', label: 'Ativos (opt-in)' },
    { value: 'pending', label: 'Pendentes' }, { value: 'all', label: 'Todos' }
  ];
  const ufOpts = [{ value: '', label: 'Todos os estados' }].concat((d.ufs || []).map(u => ({ value: u, label: u })));
  const stageOpts = [{ value: '', label: 'Todas as etapas' }].concat((d.stages || []).map(s => ({ value: s, label: s })));

  box.innerHTML = `
    <div class="card">
      <div class="co-filters">
        <label style="flex:1.4;min-width:180px">Buscar<input id="co-q" value="${esc(coFilters.search)}" placeholder="Nome, telefone, cidade ou atendente" oninput="clearTimeout(window._coQt);window._coQt=setTimeout(()=>coFilter('search',this.value),350)"></label>
        <label style="min-width:150px">Status${ecSelect('co-f-st', statusOpts, coFilters.status, "coFilter('status', val)", 'sm')}</label>
        <label style="min-width:130px">Estado${ecSelect('co-f-uf', ufOpts, coFilters.uf, "coFilter('uf', val)", 'sm')}</label>
        <label style="min-width:150px">Etapa${ecSelect('co-f-sg', stageOpts, coFilters.stage, "coFilter('stage', val)", 'sm')}</label>
        <a class="btn small no-grow" href="/api/consent/export?status=${coFilters.status}&token=${TOKEN}">${ico('download-circle', 13)} Exportar CSV</a>
      </div>
    </div>

    <div class="card">
      <div class="row" style="align-items:center;margin-bottom:10px">
        <h2 style="margin:0;flex:1">${ico('users')} ${coRows.length} contato(s)</h2>
      </div>
      ${coRows.length ? `<div style="overflow-x:auto"><table class="co-table"><thead><tr>
        <th>Nome</th><th>Telefone</th><th>Estado</th><th>Cidade</th><th>Origem</th>
        <th>Última campanha</th><th>Último atendente</th><th>Etapa</th><th>Data</th><th>Motivo</th><th></th>
      </tr></thead><tbody>
        ${coRows.map(r => {
          const S = CO_STATUS[r.status] || CO_STATUS.pending;
          return `<tr>
            <td><b>${esc(r.name)}</b><div><span class="pill ${S.cls}">${S.label}</span></div></td>
            <td><code>+${esc(r.waId)}</code></td>
            <td>${r.uf ? `<span title="${esc(r.ufName)}">${esc(r.uf)}</span>` : '<span class="muted">—</span>'}</td>
            <td>${r.city ? esc(r.city) : '<span class="muted">—</span>'}</td>
            <td>${coSourceHtml(r.source)}</td>
            <td>${r.lastCampaign ? esc(r.lastCampaign) : '<span class="muted">—</span>'}</td>
            <td>${r.lastAgent ? esc(r.lastAgent) : '<span class="muted">—</span>'}</td>
            <td>${r.stage ? esc(r.stage) : '<span class="muted">—</span>'}</td>
            <td class="muted" style="white-space:nowrap">${r.optOutAt ? new Date(r.optOutAt).toLocaleString('pt-BR') : '—'}</td>
            <td>${r.optOutReason ? esc(r.optOutReason) : '<span class="muted">—</span>'}</td>
            <td style="white-space:nowrap">${r.status === 'opted_out'
              ? `<button class="btn small primary" onclick="coReactivate('${r.waId}')">${ico('refresh', 12)} Reativar</button>`
              : `<button class="btn small danger" onclick="coOptOut('${r.waId}')">${ico('slash', 12)} Opt-out</button>`}</td>
          </tr>`;
        }).join('')}
      </tbody></table></div>`
      : `<div class="empty-state" style="padding:30px"><div class="big">${ico('shield', 34)}</div><b>Nenhum contato ${coFilters.status === 'opted_out' ? 'em opt-out' : 'encontrado'}</b>
         <p class="muted" style="margin:6px 0 0;font-size:13px">${coFilters.status === 'opted_out' ? 'Ótimo sinal — ninguém pediu para sair da sua lista.' : 'Ajuste os filtros para ver outros contatos.'}</p></div>`}
    </div>`;
}

function coSourceHtml(s) {
  if (!s || !s.type) return '<span class="pill">Orgânico</span>';
  if (s.type === 'ad') return `<span class="src-badge" title="${esc(s.headline || '')}">${ico('target', 10)} Anúncio</span>`;
  if (s.type === 'webhook') return `<span class="pill" title="${esc(s.headline || '')}">${ico('webhook', 10)} Webhook</span>`;
  return `<span class="pill">${esc(s.type)}</span>`;
}

async function coReactivate(waId) {
  if (!await confirmModal({ title: 'Reativar contato', text: 'O contato voltará a receber mensagens e campanhas. A reativação fica registrada no histórico com o seu nome.', ok: 'Reativar' })) return;
  try { await api(`/consent/${waId}/reactivate`, { body: {} }); toast('Contato reativado'); loadConsentContacts(); }
  catch (e) { toast(e.message, 'error'); }
}
async function coOptOut(waId) {
  const reason = await promptModal({ title: 'Registrar opt-out', label: 'Motivo (opcional)', placeholder: 'Ex.: pedido por telefone' });
  if (reason === null) return;
  try { await api(`/consent/${waId}/optout`, { body: { reason } }); toast('Opt-out registrado'); loadConsentContacts(); }
  catch (e) { toast(e.message, 'error'); }
}

// ==================== WEBHOOKS + MAPEAMENTO DE CAMPOS ====================
// Aba dedicada: recebe eventos externos, mapeia as variáveis para os campos do
// contato (Nome/Telefone/E-mail + personalizadas) e alimenta os flows/templates.
let whList = [];
let whMap = null;        // webhook em edição de mapeamento (null = tela de lista)
let whMapDraft = null;   // rascunho do mapeamento sendo editado

async function renderWebhooks() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row" style="align-items:center">
      <div style="flex:1"><h1>Webhooks</h1><p>Receba eventos de sistemas externos e transforme em contatos e automações</p></div>
      <button class="btn primary no-grow" onclick="createWebhook()">${ico('plus', 14)} Novo webhook</button>
    </div>
    <div id="wh-box">${skel(4)}</div>
  </div>`;
  whMap = null;
  whStopWait();
  await loadWebhooks();
}

async function loadWebhooks() {
  try { whList = (await api('/webhooks')).webhooks || []; } catch (e) { $('#wh-box').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  paintWebhooks();
}

function paintWebhooks() {
  const box = $('#wh-box'); if (!box) return;
  if (whMap) return paintWhMapping();
  if (!whList.length) {
    box.innerHTML = `<div class="empty-state card"><div class="big">${ico('webhook', 38)}</div><b>Nenhum webhook ainda</b>
      <p class="muted" style="margin:6px auto 16px;max-width:460px">Crie um webhook para receber eventos de checkout, formulários ou outro CRM. Cada evento vira um contato no EliteChat e pode disparar uma automação.</p>
      <button class="btn primary" onclick="createWebhook()">${ico('plus', 14)} Criar webhook</button></div>`;
    return;
  }
  box.innerHTML = whList.map(w => {
    const nFields = Object.keys(w.fields || {}).length;
    const mapped = [w.mapping.name && 'Nome', w.mapping.phone && 'Telefone', w.mapping.email && 'E-mail'].filter(Boolean);
    const nCustom = (w.mapping.custom || []).length;
    return `<div class="card wh-card">
      <div class="row" style="align-items:center;gap:12px">
        <span class="wh-ic">${ico('webhook', 18)}</span>
        <div style="flex:1;min-width:0">
          <b style="font-size:14.5px">${esc(w.name)}</b>
          <div class="muted" style="font-size:12px">${w.hits} evento(s) recebido(s)${w.lastPayloadAt ? ' · último ' + timeAgo(w.lastPayloadAt) : ' · nenhum ainda'}</div>
        </div>
        <button class="btn small no-grow" onclick="editWhMapping('${w.id}')">${ico('columns', 13)} Mapear campos</button>
        <button class="icon-btn danger" title="Excluir" onclick="delWebhook('${w.id}')">${ico('trash', 14)}</button>
      </div>
      <div class="wh-url"><span class="muted" style="font-size:11px">URL (POST)</span>
        <div class="linkrow"><code>${esc(w.url)}</code><button class="icon-btn" title="Copiar" onclick="copyText('${esc(w.url)}')">${ico('copy', 13)}</button></div>
      </div>
      <div class="wh-meta">
        <span class="pill ${nFields ? 'done' : ''}">${nFields} variáve${nFields === 1 ? 'l' : 'is'} recebida${nFields === 1 ? '' : 's'}</span>
        ${mapped.length ? mapped.map(m => `<span class="pill">${m} ✓</span>`).join('') : '<span class="pill pending">Campos não mapeados</span>'}
        ${nCustom ? `<span class="pill">${nCustom} personalizada(s)</span>` : ''}
        <span style="margin-left:auto;display:inline-flex;gap:6px">
          <button class="btn small no-grow" onclick="whStartWait('${w.id}')">${ico('radio', 12)} Aguardar evento (3 min)</button>
          <button class="btn small ghost no-grow" onclick="simulateWebhook('${w.id}')">${ico('activity', 12)} Simular</button>
        </span>
      </div>
    </div>`;
  }).join('');
}

async function createWebhook() {
  const name = await promptModal({ title: 'Novo webhook', label: 'Nome do webhook', placeholder: 'Ex.: Checkout Hotmart', ok: 'Criar' });
  if (name === null) return;
  try {
    const r = await api('/webhooks', { body: { name: name || 'Novo webhook' } });
    await loadWebhooks();
    // fluxo oficial: aguarda o POST real (até 3 min) para capturar as variáveis,
    // e só então abre o Mapeamento de Campos para salvar.
    whStartWait(r.webhook.id);
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Modo escuta: aguarda o evento POST real por até 3 minutos ----
const WH_WAIT_MS = 3 * 60 * 1000;
let whWait = null; // { id, until, tick, poll, since }

function whStartWait(id) {
  whStopWait();
  whWait = { id, until: Date.now() + WH_WAIT_MS, since: Date.now() };
  whWait.tick = setInterval(paintWhWaitClock, 1000);
  // fallback por polling (caso o SSE caia): confere a cada 5s se chegou payload
  whWait.poll = setInterval(async () => {
    if (!whWait) return;
    try {
      const d = await api('/webhooks');
      const w = (d.webhooks || []).find(x => x.id === whWait.id);
      if (w && w.lastPayloadAt && w.lastPayloadAt >= whWait.since) whWaitSuccess();
    } catch {}
  }, 5000);
  paintWhWait();
}
function whStopWait() {
  if (!whWait) return;
  clearInterval(whWait.tick);
  clearInterval(whWait.poll);
  whWait = null;
}
// chamado pelo SSE quando o webhook recebe um POST
function whOnEvent(d) {
  if (whWait && d.webhookId === whWait.id) whWaitSuccess();
  else if (state.view === 'webhooks' && !whMap) loadWebhooks();
}
async function whWaitSuccess() {
  const id = whWait && whWait.id;
  whStopWait();
  toast('🎉 Evento recebido — variáveis capturadas!');
  await loadWebhooks();
  if (id) editWhMapping(id); // agora sim: mapear e salvar
}

function paintWhWait() {
  const box = $('#wh-box'); if (!box || !whWait) return;
  const w = whList.find(x => x.id === whWait.id);
  if (!w) { whStopWait(); paintWebhooks(); return; }
  box.innerHTML = `
    <div class="card wh-wait">
      <div class="wh-wait-anim"><span class="wh-pulse"></span>${ico('webhook', 26)}</div>
      <h2 style="justify-content:center">Aguardando o evento…</h2>
      <p class="muted" style="max-width:480px;margin:6px auto 4px;text-align:center">
        Dispare um <b>POST</b> do seu sistema (checkout, formulário, CRM) para a URL abaixo.
        Assim que o evento chegar, as variáveis serão capturadas e o <b>Mapeamento de Campos</b> abre automaticamente.
      </p>
      <div class="linkrow" style="max-width:520px;margin:12px auto"><code>${esc(w.url)}</code><button class="icon-btn" title="Copiar" onclick="copyText('${esc(w.url)}')">${ico('copy', 13)}</button></div>
      <div class="wh-wait-clock" id="wh-clock">3:00</div>
      <p class="muted" style="font-size:11.5px;text-align:center;margin:4px 0 14px">tempo restante de escuta</p>
      <div class="row" style="justify-content:center;gap:8px">
        <button class="btn no-grow" onclick="simulateWebhook('${w.id}')">${ico('activity', 13)} Simular evento</button>
        <button class="btn no-grow" onclick="whStopWait();paintWebhooks()">Cancelar</button>
      </div>
    </div>`;
  paintWhWaitClock();
}
function paintWhWaitClock() {
  if (!whWait) return;
  const left = whWait.until - Date.now();
  if (left <= 0) {
    const id = whWait.id;
    whStopWait();
    const box = $('#wh-box');
    if (box) box.innerHTML = `
      <div class="card wh-wait">
        <div class="wh-wait-anim off">${ico('clock', 26)}</div>
        <h2 style="justify-content:center">Nenhum evento em 3 minutos</h2>
        <p class="muted" style="max-width:440px;margin:6px auto 16px;text-align:center">Confira se a URL foi cadastrada no sistema externo e se o método é <b>POST</b>. Você pode escutar de novo ou simular um evento.</p>
        <div class="row" style="justify-content:center;gap:8px">
          <button class="btn primary no-grow" onclick="whStartWait('${id}')">${ico('refresh', 13)} Escutar de novo</button>
          <button class="btn no-grow" onclick="simulateWebhook('${id}')">${ico('activity', 13)} Simular evento</button>
          <button class="btn no-grow" onclick="paintWebhooks()">Voltar</button>
        </div>
      </div>`;
    return;
  }
  const el = $('#wh-clock');
  if (el) {
    const s = Math.ceil(left / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.classList.toggle('crit', s <= 30);
  }
}

async function delWebhook(id) {
  if (!await confirmModal({ title: 'Excluir webhook', text: 'A URL deixará de funcionar e os flows vinculados serão desvinculados.', ok: 'Excluir', danger: true })) return;
  try { await api('/webhooks/' + id, { method: 'DELETE' }); await loadWebhooks(); } catch (e) { toast(e.message, 'error'); }
}

async function simulateWebhook(id) {
  try {
    const r = await api('/webhooks/' + id + '/simulate', { body: {} });
    toast(r.matched ? 'Evento de teste recebido — contato criado/atualizado!' : 'Evento recebido, mas o telefone não foi mapeado ainda.');
    whList = whList.map(w => w.id === id ? r.webhook : w);
    if (whMap && whMap.id === id) { whMap = r.webhook; whMapDraft = JSON.parse(JSON.stringify(r.webhook.mapping)); }
    paintWebhooks();
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Editor de Mapeamento de Campos (igual EliteChat 1.0, em página) ----
function editWhMapping(id) {
  whMap = whList.find(w => w.id === id);
  whMapDraft = JSON.parse(JSON.stringify(whMap.mapping || { name: '', phone: '', email: '', custom: [] }));
  paintWhMapping();
}

function whFieldOptions(fields, extraSelected) {
  const paths = Object.keys(fields || {});
  if (extraSelected && !paths.includes(extraSelected)) paths.push(extraSelected);
  return [{ value: '', label: '— não mapear —' }].concat(paths.map(p => ({ value: p, label: p })));
}
function whSampleOf(path) {
  if (!whMap || !path) return '';
  const v = whMap.fields[path];
  return v === undefined ? '' : String(v);
}
function whSampleHtml(path) {
  if (!path) return '<span class="muted">Selecione a variável recebida</span>';
  const v = esc(whSampleOf(path));
  return `<code>${esc(path)}</code> = <b>${v || '<span class="muted">(vazio)</span>'}</b>`;
}
function whFieldRow(icon, title, key, required) {
  const fields = whMap.fields || {};
  const sel = whMapDraft[key] || '';
  return `<div class="wm-field">
    <div class="wm-label">${ico(icon, 15)} ${title}${required ? ' <span class="wm-req">*</span>' : ''}</div>
    ${ecSelect('wm-' + key, whFieldOptions(fields, sel), sel, `whMapPick('${key}',val)`)}
    <div class="wm-sample" id="wm-sample-${key}">${whSampleHtml(sel)}</div>
  </div>`;
}

function paintWhMapping() {
  const box = $('#wh-box'); if (!box || !whMap) return;
  const nFields = Object.keys(whMap.fields || {}).length;
  box.innerHTML = `
    <button class="btn small no-grow" style="margin-bottom:14px" onclick="closeWhMapping()">${ico('arrow-up', 13)} Voltar aos webhooks</button>
    <div class="card wm-card">
      <div class="wm-head">
        <h2 style="margin:0">${ico('columns')} Mapeamento de Campos</h2>
        <p class="muted" style="margin:4px 0 0;font-size:13px">Escolha qual variável recebida representa cada campo do contato. Isso evita mapeamentos automáticos incorretos.</p>
      </div>
      ${nFields ? '' : `<div class="wm-warn">${ico('alert', 15)} Este webhook ainda não recebeu nenhum evento. <b>Envie um evento de teste</b> ou dispare do seu sistema para listar as variáveis disponíveis.
        <button class="btn small no-grow" style="margin-top:8px" onclick="simulateWebhook('${whMap.id}')">${ico('activity', 12)} Enviar evento de teste</button></div>`}
      ${nFields ? `
        <div class="wm-fields">
          ${whFieldRow('user', 'Nome do contato', 'name', false)}
          ${whFieldRow('phone', 'Telefone (WhatsApp)', 'phone', true)}
          ${whFieldRow('mail', 'E-mail', 'email', false)}
        </div>
        <div class="wm-custom">
          <div class="row" style="align-items:center">
            <div style="flex:1"><b style="font-size:13.5px">${ico('braces', 14)} Variáveis personalizadas</b>
              <p class="muted" style="margin:2px 0 0;font-size:12px">Ex.: cpf, plano, valor. Ficam disponíveis para flows e templates.</p></div>
            <button class="btn small no-grow" onclick="whAddCustom()">${ico('plus', 12)} Adicionar</button>
          </div>
          <div id="wm-custom-list">${whCustomRows()}</div>
        </div>
        <div class="wm-note">${ico('info', 14)} O telefone é obrigatório para criar/atualizar o contato. Se ele não estiver mapeado, o evento continua salvando o log mas não gera contato.</div>
      ` : ''}
    </div>
    ${nFields ? `<div class="wm-actions">
      <button class="btn no-grow" onclick="closeWhMapping()">Cancelar</button>
      <button class="btn primary no-grow" onclick="saveWhMapping()">${ico('save', 14)} Salvar mapeamento</button>
    </div>` : ''}`;
}

function whCustomRows() {
  const fields = whMap.fields || {};
  return (whMapDraft.custom || []).map((c, i) => `
    <div class="wm-crow">
      <input value="${esc(c.key || '')}" placeholder="nome da variável (ex.: cpf)" oninput="whMapDraft.custom[${i}].key=this.value">
      <span class="wm-eq">=</span>
      ${ecSelect('wm-cpath-' + i, whFieldOptions(fields, c.path), c.path || '', `whMapCustomPath(${i},val)`, 'sm')}
      <button class="icon-btn danger" title="Remover" onclick="whDelCustom(${i})">${ico('trash', 13)}</button>
    </div>`).join('') || '<p class="muted" style="font-size:12px;margin:8px 0 0">Nenhuma variável personalizada.</p>';
}

function whMapPick(key, val) {
  whMapDraft[key] = val;
  const el = $('#wm-sample-' + key);
  if (el) el.innerHTML = whSampleHtml(val);
}
function whMapCustomPath(i, val) { whMapDraft.custom[i].path = val; }
function whAddCustom() { whMapDraft.custom = whMapDraft.custom || []; whMapDraft.custom.push({ key: '', path: '' }); $('#wm-custom-list').innerHTML = whCustomRows(); }
function whDelCustom(i) { whMapDraft.custom.splice(i, 1); $('#wm-custom-list').innerHTML = whCustomRows(); }
function closeWhMapping() { whMap = null; whMapDraft = null; paintWebhooks(); }

async function saveWhMapping() {
  if (!whMapDraft.phone) return toast('Mapeie o Telefone (WhatsApp) — é obrigatório para gerar o contato', 'error');
  const custom = (whMapDraft.custom || []).filter(c => c.key && c.path);
  try {
    const r = await api('/webhooks/' + whMap.id, { method: 'PUT', body: { mapping: { ...whMapDraft, custom } } });
    whList = whList.map(w => w.id === whMap.id ? r.webhook : w);
    toast('Mapeamento salvo!');
    closeWhMapping();
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== FLOW BUILDER (automações) ====================
let flowDraft = null;

// Gatilhos (subtipos do nó inicial)
const TRIGGERS = {
  keyword: { icon: 'hash', label: 'Palavra-chave', color: 'amber', desc: 'Dispara quando o cliente envia uma mensagem com o termo' },
  link: { icon: 'link', label: 'Link do WhatsApp', color: 'violet', desc: 'Gera um link wa.me com uma frase pronta que aciona o fluxo' },
  webhook: { icon: 'webhook', label: 'Webhook', color: 'blue', desc: 'Dispara via chamada HTTP externa a uma URL exclusiva' },
  button: { icon: 'mousepointer', label: 'Botão clicado', color: 'pink', desc: 'Dispara quando o cliente toca num botão interativo' },
  list: { icon: 'list', label: 'Item selecionado', color: 'blue', desc: 'Dispara quando o cliente escolhe um item de uma lista' }
};

// Tipos de nó de ação (canvas) — cada um com ícone, rótulo, subtítulo e cor
const NODE_TYPES = {
  text: { icon: 'message', label: 'Enviar texto', sub: 'Mensagem', color: 'green', cat: 'messages' },
  buttons: { icon: 'buttons', label: 'Botões interativos', sub: 'Interação', color: 'violet', cat: 'messages' },
  list: { icon: 'list', label: 'Lista interativa', sub: 'Interação', color: 'blue', cat: 'messages' },
  media: { icon: 'image', label: 'Enviar mídia', sub: 'Mídia', color: 'orange', cat: 'messages' },
  template: { icon: 'file', label: 'Enviar template', sub: 'Template', color: 'indigo', cat: 'messages' },
  ai: { icon: 'sparkles', label: 'Responder com IA', sub: 'IA', color: 'violet', cat: 'messages' },
  delay: { icon: 'clock', label: 'Delay', sub: 'Espera', color: 'amber', cat: 'logic' },
  condition: { icon: 'branch', label: 'Condição', sub: 'Ramificação', color: 'blue', cat: 'logic' },
  addtag: { icon: 'tag', label: 'Adicionar tag', sub: 'CRM', color: 'green', cat: 'logic' },
  removetag: { icon: 'tag', label: 'Remover tag', sub: 'CRM', color: 'red', cat: 'logic' },
  movestage: { icon: 'arrowright', label: 'Mover no funil', sub: 'CRM', color: 'violet', cat: 'logic' },
  optin: { icon: 'check-circle', label: 'Registrar Opt-in', sub: 'Consentimento', color: 'green', cat: 'consent' },
  optout: { icon: 'slash', label: 'Registrar Opt-out', sub: 'Consentimento', color: 'red', cat: 'consent' },
  reactivate: { icon: 'refresh', label: 'Reativar contato', sub: 'Consentimento', color: 'blue', cat: 'consent' },
  http: { icon: 'globe', label: 'HTTP Request', sub: 'Integração', color: 'orange', cat: 'logic' },
  end: { icon: 'square', label: 'Fim', sub: 'Encerrar', color: 'gray', cat: 'logic' }
};
const FB_PALETTE = {
  triggers: { label: 'Gatilhos', items: ['keyword', 'webhook', 'link', 'button', 'list'] },
  // "Enviar texto" cobre botões e lista (opcionais). Os nós antigos `buttons` e
  // `list` continuam funcionando em automações já criadas, mas saíram da paleta.
  messages: { label: 'Mensagens', items: ['text', 'media', 'template', 'ai'] },
  logic: { label: 'Lógica', items: ['delay', 'condition', 'addtag', 'removetag', 'movestage', 'http', 'end'] },
  consent: { label: 'Opt-in & Opt-out', items: ['optin', 'optout', 'reactivate'] }
};

async function renderFlows() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Flow Builder</h1><p>Automações com gatilhos e ações — sem código</p></div>
      <button class="btn primary no-grow" onclick="newFlow()">${ico('plus', 14)} Nova automação</button>
    </div>
    <div id="flow-list">${skel(4)}</div>
  </div>`;
  paintFlows();
}

function flowActionCount(f) {
  if (f.graph && Array.isArray(f.graph.nodes) && f.graph.nodes.length)
    return f.graph.nodes.filter(n => n.type !== 'trigger').length;
  return (f.nodes || []).length;
}

async function paintFlows() {
  const box = $('#flow-list'); if (!box) return;
  try {
    const { flows } = await api('/flows');
    if (!flows.length) {
      box.innerHTML = `<div class="empty-state"><div class="big">${ico('flow', 40)}</div><b>Nenhuma automação ainda</b>
        <p class="muted" style="margin:6px auto 16px;max-width:440px">Crie fluxos que respondem sozinhos: gatilho por palavra-chave, link do WhatsApp ou webhook, e ações como enviar mensagem, botões ou fazer uma requisição HTTP.</p>
        <button class="btn primary" onclick="newFlow()">Criar primeira automação</button></div>`;
      return;
    }
    box.innerHTML = `<div class="flow-grid">${flows.map(f => {
      const tr = TRIGGERS[f.trigger.type] || TRIGGERS.keyword;
      const trDetail = f.trigger.type === 'keyword' ? `"${esc(f.trigger.keyword || '')}"`
        : f.trigger.type === 'link' ? `"${esc(f.trigger.phrase || '')}"` : 'URL exclusiva';
      return `<div class="flow-card ${f.enabled ? '' : 'off'}">
        <div class="flow-card-top">
          <span class="flow-badge">${ico(tr.icon, 13)} ${tr.label}</span>
          <button class="toggle ${f.enabled ? 'on' : ''}" title="${f.enabled ? 'Ativa' : 'Pausada'}" onclick="toggleFlow('${f.id}', ${!f.enabled})"><span></span></button>
        </div>
        <b class="flow-name">${esc(f.name)}</b>
        <div class="muted" style="font-size:12px;margin-top:2px">Gatilho: ${trDetail}</div>
        <div class="flow-meta">${ico('flow', 12)} ${flowActionCount(f)} ação(ões) · ${f.runs || 0} execução(ões)</div>
        <div class="flow-actions">
          <button class="btn small" onclick="editFlow('${f.id}')">${ico('edit', 13)} Editar</button>
          <button class="btn small" onclick="testFlow('${f.id}')">${ico('play', 13)} Testar</button>
          <button class="btn small danger" onclick="delFlow('${f.id}')">${ico('trash', 13)}</button>
        </div>
      </div>`;
    }).join('')}</div>`;
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

function newFlow() {
  flowDraft = {
    name: '', enabled: true,
    trigger: { type: 'keyword', keyword: '', match: 'contains', phrase: '' },
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', x: 60, y: 140 },
        { id: 'n1', type: 'text', x: 380, y: 110, text: 'Olá {{nome}}! 👋 Recebemos sua mensagem e já vamos te atender.' }
      ],
      edges: [{ id: 'e1', from: 'trigger', to: 'n1' }]
    }
  };
  openBuilder();
}

function migrateToGraph(f) {
  if (f.graph && Array.isArray(f.graph.nodes) && f.graph.nodes.length) return f;
  const nodes = [{ id: 'trigger', type: 'trigger', x: 60, y: 140 }];
  const edges = [];
  let prev = 'trigger';
  (f.nodes || []).forEach((n, i) => {
    const node = { ...n, id: n.id || 'n' + i, x: 380, y: 60 + i * 170 };
    nodes.push(node);
    edges.push({ id: 'e' + i, from: prev, to: node.id });
    prev = node.id;
  });
  f.graph = { nodes, edges };
  return f;
}

async function editFlow(id) {
  try {
    const { flows } = await api('/flows');
    const f = flows.find(x => x.id === id); if (!f) return;
    flowDraft = migrateToGraph(JSON.parse(JSON.stringify(f)));
    openBuilder();
  } catch (e) { toast(e.message, 'error'); }
}

async function toggleFlow(id, enabled) {
  try { await api('/flows/' + id, { method: 'PUT', body: { enabled } }); paintFlows(); } catch (e) { toast(e.message, 'error'); }
}
async function delFlow(id) {
  if (!await confirmModal({ title: 'Excluir automação', text: 'A automação será removida permanentemente.', ok: 'Excluir', danger: true })) return;
  try { await api('/flows/' + id, { method: 'DELETE' }); paintFlows(); } catch (e) { toast(e.message, 'error'); }
}
async function testFlow(id) {
  const to = await promptModal({ title: 'Testar automação', label: 'Número de destino (formato internacional)', placeholder: '5511999998888', value: (state.wa && state.wa.displayPhoneNumber || '').replace(/\D/g, '') });
  if (to === null) return;
  try {
    const r = await api('/flows/' + id + '/test', { body: { to, text: 'teste' } });
    const okAll = r.steps.every(s => s.ok);
    toast(okAll ? 'Automação executada com sucesso!' : 'Executada com avisos — veja os passos', okAll ? 'ok' : 'error');
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== CANVAS ARRASTA-E-SOLTA (n8n-style) ====================
const NODE_W = 236;         // largura do nó (px, coords do mundo)
const PORT_DY = 40;         // âncora vertical das portas
const fbV = { s: 1, tx: 60, ty: 40 };
let fbSel = null, fbInter = null, fbSaveTimer = null;

// Paleta alinhada ao Design System do app (verde da marca + âmbar/vermelho/azul
// de apoio). Os tons antigos "arco-íris" (violeta/rosa/laranja/índigo) foram
// remapeados para não destoar do restante da interface.
const FB_COLORS = {
  green: ['var(--brand-bg)', 'var(--verde-deep)'],
  blue: ['#eef5fb', '#2f7fb5'],
  violet: ['#eef5fb', '#2f7fb5'],
  indigo: ['#eef5fb', '#2f7fb5'],
  amber: ['var(--amber-bg)', '#b26205'],
  orange: ['var(--amber-bg)', '#b26205'],
  pink: ['var(--brand-bg)', 'var(--verde-deep)'],
  red: ['var(--red-bg)', 'var(--red)'],
  gray: ['var(--bg2)', 'var(--muted)']
};
function iconChip(icon, color, size) {
  const [bg, fg] = FB_COLORS[color] || FB_COLORS.gray;
  return `<span class="fb-n-ic" style="background:${bg};color:${fg}">${ico(icon, size)}</span>`;
}
function nodeMeta(n) {
  if (n.type === 'trigger') { const t = TRIGGERS[flowDraft.trigger.type]; return { icon: t.icon, label: t.label, sub: 'Gatilho', color: t.color }; }
  return NODE_TYPES[n.type] || { icon: 'flow', label: n.type, sub: '', color: 'gray' };
}
function nodeById(id) { return flowDraft.graph.nodes.find(n => n.id === id); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
const OP_LBL = { contains: 'contém', equals: 'é igual a', notEquals: 'é diferente de', startsWith: 'começa com', exists: 'existe', empty: 'está vazio' };

function nodeSummary(n) {
  switch (n.type) {
    case 'trigger': {
      const tr = flowDraft.trigger;
      return tr.type === 'keyword' ? `"${tr.keyword || '—'}"` : tr.type === 'link' ? `"${tr.phrase || '—'}"`
        : tr.type === 'webhook' ? 'URL exclusiva' : tr.keyword ? `"${tr.keyword}"` : 'qualquer interação';
    }
    case 'text': {
      const txt = (n.text || '').slice(0, 48) || 'Mensagem vazia';
      if (n.url && n.url.trim()) return `${txt} · 🔗 ${n.urlText || 'link'}`;
      const nb = (n.buttons || []).filter(b => (b.title || '').trim()).length;
      if (!nb) return txt;
      return `${txt} · ${nb <= 3 ? `${nb} botão(ões)` : `lista (${nb})`}`;
    }
    case 'buttons': return n.url && n.url.trim() ? `${(n.body || 'Mensagem').slice(0, 30)} · 🔗 ${n.urlText || 'link'}` : `${(n.body || 'Pergunta').slice(0, 34)} · ${(n.buttons || []).length} botões`;
    case 'list': return `${(n.body || 'Lista').slice(0, 30)} · ${(n.items || []).length} itens`;
    case 'media': return `${n.kind || 'image'} · ${(n.link || '—').slice(0, 30)}`;
    case 'template': return `Template: ${n.templateName || '—'}`;
    case 'ai': return (n.prompt || 'Resposta automática por IA').slice(0, 52);
    case 'http': return `${n.method || 'POST'} ${(n.url || '—').slice(0, 34)}`;
    case 'delay': return `Aguardar ${n.seconds || 0}s`;
    case 'condition': return `Se ${n.field || 'texto'} ${OP_LBL[n.op] || 'contém'} "${(n.value || '').slice(0, 18)}"`;
    case 'addtag': return `+ tag "${n.tag || '—'}"`;
    case 'removetag': return `− tag "${n.tag || '—'}"`;
    case 'movestage': return `→ ${n.stage || '—'}`;
    case 'end': return 'Encerra a automação';
    default: return '';
  }
}
function nodeDefaults(type) {
  const d = { type };
  if (type === 'text') { d.text = ''; d.buttons = []; d.listButton = 'Ver opções'; d.url = ''; d.urlText = ''; }
  else if (type === 'buttons') { d.body = ''; d.buttons = [{ title: 'Sim' }, { title: 'Não' }]; }
  else if (type === 'list') { d.header = 'Opções'; d.body = ''; d.buttonText = 'Ver opções'; d.items = [{ title: 'Opção 1' }, { title: 'Opção 2' }]; }
  else if (type === 'media') { d.kind = 'image'; d.link = ''; d.caption = ''; }
  else if (type === 'template') { d.templateName = ''; d.language = 'pt_BR'; }
  else if (type === 'ai') d.prompt = '';
  else if (type === 'delay') d.seconds = 3;
  else if (type === 'condition') { d.field = 'texto'; d.op = 'contains'; d.value = ''; }
  else if (type === 'addtag' || type === 'removetag') d.tag = '';
  else if (type === 'movestage') d.stage = (state.settings && state.settings.stages && state.settings.stages[0]) || '';
  else if (type === 'http') { d.method = 'POST'; d.url = ''; d.headers = []; d.body = ''; }
  return d;
}

function openBuilder() {
  cleanupBuilder();
  const en = flowDraft.enabled;
  $('#view').innerHTML = `<div class="fb2">
    <header class="fb2-top">
      <button class="icon-btn" title="Voltar" onclick="renderFlows()">${ico('arrow-up', 17)}</button>
      <input id="fb-name" class="fb2-name" placeholder="Nome da automação" value="${esc(flowDraft.name)}">
      <span class="fb2-pill ${en ? 'on' : ''}" id="fb-pill">${en ? '▶ Ativo' : '⏸ Pausado'}</span>
      <span class="fb2-save" id="fb-savestate">Auto-save ativo</span>
      <div class="fb-tb-spacer"></div>
      <button class="btn no-grow" onclick="flowStatsModal()">${ico('activity', 14)} Métricas</button>
      <button class="btn no-grow" onclick="saveFlow()">${ico('save', 14)} Salvar</button>
      <button class="btn primary no-grow" id="fb-activate" onclick="fbToggleEnabled()">${ico('power', 14)} ${en ? 'Desativar' : 'Ativar'}</button>
    </header>
    <div class="fb2-body">
      <aside class="fb2-palette">${paletteHtml()}</aside>
      <div class="fb2-canvas" id="fb-canvas">
        <div class="fb-world" id="fb-world"><svg class="fb-edges" id="fb-edges" width="6000" height="4000"></svg></div>
        <div class="fb2-zoom">
          <button class="icon-btn" title="Mais zoom" onclick="fbZoom(1)">${ico('plus', 15)}</button>
          <span id="fb-zoomlbl">100%</span>
          <button class="icon-btn" title="Menos zoom" onclick="fbZoom(-1)">${icoMinus()}</button>
          <button class="icon-btn" title="Centralizar" onclick="fbFit()">${ico('target', 15)}</button>
        </div>
        <div class="fb2-mini" id="fb-mini"></div>
      </div>
      <aside class="fb2-inspector" id="fb-inspector"></aside>
    </div>
  </div>`;
  const canvas = $('#fb-canvas');
  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('wheel', onCanvasWheel, { passive: false });
  canvas.addEventListener('dragover', e => e.preventDefault());
  canvas.addEventListener('drop', onPaletteDrop);
  window._fbMove = onDocMove; window._fbUp = onDocUp; window._fbKey = onBuilderKey;
  document.addEventListener('pointermove', window._fbMove);
  document.addEventListener('pointerup', window._fbUp);
  document.addEventListener('keydown', window._fbKey);
  $('#fb-name').addEventListener('input', e => { flowDraft.name = e.target.value; scheduleSave(); });
  applyTransform(); renderNodes(); renderEdges(); renderInspector(); renderMini();
  loadFbWebhooks(); // webhooks disponíveis p/ o gatilho webhook
}
function icoMinus() { return `<svg class="ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>`; }

function paletteHtml() {
  return Object.entries(FB_PALETTE).map(([cat, group]) => `
    <div class="fb2-pgroup">${group.label}</div>
    ${group.items.map(key => {
      const meta = cat === 'triggers' ? TRIGGERS[key] : NODE_TYPES[key];
      return `<div class="fb2-pitem" draggable="true" data-cat="${cat}" data-key="${key}"
        ondragstart="event.dataTransfer.setData('text/plain','${cat}:${key}')"
        onclick="paletteClick('${cat}','${key}')">
        ${iconChip(meta.icon, meta.color, 16)}<span>${meta.label}</span></div>`;
    }).join('')}`).join('');
}
function paletteClick(cat, key) {
  if (cat === 'triggers') { fbChangeTrigger(key); selectNode('trigger'); }
  else addNodeAt(key);
}
function onPaletteDrop(e) {
  e.preventDefault();
  const data = e.dataTransfer.getData('text/plain'); if (!data) return;
  const [cat, key] = data.split(':');
  if (cat === 'triggers') { fbChangeTrigger(key); selectNode('trigger'); return; }
  const wp = screenToWorld(e.clientX, e.clientY);
  addNodeAt(key, Math.round(wp.x - NODE_W / 2), Math.round(wp.y - 30));
}

function cleanupBuilder() {
  if (window._fbMove) document.removeEventListener('pointermove', window._fbMove);
  if (window._fbUp) document.removeEventListener('pointerup', window._fbUp);
  if (window._fbKey) document.removeEventListener('keydown', window._fbKey);
  window._fbMove = window._fbUp = window._fbKey = null;
  clearTimeout(fbSaveTimer);
}

async function loadFbWebhooks() {
  try { window._fbWebhooks = (await api('/webhooks')).webhooks || []; } catch { window._fbWebhooks = []; }
  if (fbSel === 'trigger' && flowDraft && flowDraft.trigger.type === 'webhook') renderInspector();
}

function fbToggleEnabled() {
  flowDraft.enabled = !flowDraft.enabled;
  const pill = $('#fb-pill'), btn = $('#fb-activate');
  if (pill) { pill.className = 'fb2-pill ' + (flowDraft.enabled ? 'on' : ''); pill.textContent = flowDraft.enabled ? '▶ Ativo' : '⏸ Pausado'; }
  if (btn) btn.innerHTML = `${ico('power', 14)} ${flowDraft.enabled ? 'Desativar' : 'Ativar'}`;
  scheduleSave();
}

// ---------- auto-save ----------
function scheduleSave() {
  const st = $('#fb-savestate'); if (st) st.textContent = 'Salvando…';
  clearTimeout(fbSaveTimer);
  fbSaveTimer = setTimeout(doAutoSave, 900);
}
async function doAutoSave() {
  const st = $('#fb-savestate');
  if (!flowDraft.name.trim()) { if (st) st.textContent = 'Defina um nome para salvar'; return; }
  flowDraft.nodes = [];
  try {
    if (flowDraft.id) await api('/flows/' + flowDraft.id, { method: 'PUT', body: flowDraft });
    else {
      const r = await api('/flows', { body: flowDraft });
      flowDraft.id = r.flow.id; flowDraft.hookUrl = r.flow.hookUrl; flowDraft.waLink = r.flow.waLink;
      if (fbSel === 'trigger') renderInspector();
    }
    if (st) st.textContent = 'Auto-save ativo';
  } catch (e) { if (st) st.textContent = 'Erro ao salvar'; }
}

function applyTransform() {
  const w = $('#fb-world'); if (!w) return;
  w.style.transform = `translate(${fbV.tx}px, ${fbV.ty}px) scale(${fbV.s})`;
  const lbl = $('#fb-zoomlbl'); if (lbl) lbl.textContent = Math.round(fbV.s * 100) + '%';
}
function fbZoom(dir) { const r = $('#fb-canvas').getBoundingClientRect(); zoomAround(r.width / 2, r.height / 2, fbV.s * (dir > 0 ? 1.15 : 0.87)); }
function zoomAround(mx, my, ns) {
  ns = clamp(ns, 0.4, 1.8);
  fbV.tx = mx - (mx - fbV.tx) * (ns / fbV.s);
  fbV.ty = my - (my - fbV.ty) * (ns / fbV.s);
  fbV.s = ns; applyTransform();
}
function onCanvasWheel(e) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); zoomAround(e.clientX - r.left, e.clientY - r.top, fbV.s * (e.deltaY < 0 ? 1.1 : 0.9)); }
function fbFit() { fbV.s = 1; fbV.tx = 60; fbV.ty = 40; applyTransform(); }

function screenToWorld(cx, cy) { const r = $('#fb-canvas').getBoundingClientRect(); return { x: (cx - r.left - fbV.tx) / fbV.s, y: (cy - r.top - fbV.ty) / fbV.s }; }
function portY(n, branch) { if (n.type === 'condition') return branch === 'no' ? 66 : 36; return PORT_DY; }
function portPos(n, side, branch) { return { x: n.x + (side === 'out' ? NODE_W : 0), y: n.y + (side === 'out' ? portY(n, branch) : PORT_DY) }; }
function edgeD(a, b) { const dx = Math.max(46, Math.abs(b.x - a.x) / 2); return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; }

function renderNodes() {
  const world = $('#fb-world');
  world.querySelectorAll('.fb-n').forEach(el => el.remove());
  for (const n of flowDraft.graph.nodes) {
    const M = nodeMeta(n);
    const el = document.createElement('div');
    el.className = 'fb-n type-' + n.type + (fbSel === n.id ? ' sel' : '') + (n.type === 'trigger' ? ' trig' : '');
    el.dataset.id = n.id;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = NODE_W + 'px';
    const ports = n.type === 'condition'
      ? `<span class="fb-port out yes" data-id="${n.id}" data-side="out" data-branch="yes"><em>Sim</em></span>
         <span class="fb-port out no" data-id="${n.id}" data-side="out" data-branch="no"><em>Não</em></span>`
      : (n.type === 'end' ? '' : `<span class="fb-port out" data-id="${n.id}" data-side="out"></span>`);
    el.innerHTML = `
      ${n.type !== 'trigger' ? `<span class="fb-port in" data-id="${n.id}" data-side="in"></span>` : ''}
      ${ports}
      <div class="fb-n-hd">${iconChip(M.icon, M.color, 15)}<div class="fb-n-tt"><b>${M.label}</b><span>${M.sub}</span></div><span class="fb-n-gear">${ico('gear', 14)}</span></div>
      <div class="fb-n-prev">${esc(nodeSummary(n))}</div>`;
    world.appendChild(el);
  }
  renderMini();
}

function renderEdges() {
  const svg = $('#fb-edges'); if (!svg) return;
  let html = '';
  for (const e of flowDraft.graph.edges) {
    const a = nodeById(e.from), b = nodeById(e.to); if (!a || !b) continue;
    const d = edgeD(portPos(a, 'out', e.branch), portPos(b, 'in'));
    html += `<path class="fb-edge-hit" data-id="${e.id}" d="${d}"/><path class="fb-edge${e.branch === 'no' ? ' no' : ''}" d="${d}"/>`;
  }
  html += '<path class="fb-edge-temp" id="fb-temp" style="display:none"/>';
  svg.innerHTML = html;
}

function renderMini() {
  const mini = $('#fb-mini'); if (!mini) return;
  const ns = flowDraft.graph.nodes;
  if (!ns.length) { mini.innerHTML = ''; return; }
  const pad = 40;
  const minX = Math.min(...ns.map(n => n.x)) - pad, minY = Math.min(...ns.map(n => n.y)) - pad;
  const maxX = Math.max(...ns.map(n => n.x)) + NODE_W + pad, maxY = Math.max(...ns.map(n => n.y)) + 80 + pad;
  const sc = Math.min(168 / (maxX - minX), 104 / (maxY - minY));
  mini.innerHTML = ns.map(n => {
    const [, fg] = FB_COLORS[nodeMeta(n).color] || FB_COLORS.gray;
    return `<i style="left:${(n.x - minX) * sc}px;top:${(n.y - minY) * sc}px;width:${Math.max(5, NODE_W * sc)}px;height:${Math.max(4, 56 * sc)}px;background:${fg}"></i>`;
  }).join('');
}

// ---------- interações ----------
function onCanvasDown(e) {
  const port = e.target.closest('.fb-port');
  const node = e.target.closest('.fb-n');
  const edgeHit = e.target.closest('.fb-edge-hit');
  if (port && port.dataset.side === 'out') {
    const n = nodeById(port.dataset.id);
    fbInter = { mode: 'link', from: n.id, branch: port.dataset.branch || null, start: portPos(n, 'out', port.dataset.branch) };
    e.preventDefault(); return;
  }
  if (edgeHit) { flowDraft.graph.edges = flowDraft.graph.edges.filter(x => x.id !== edgeHit.dataset.id); renderEdges(); scheduleSave(); return; }
  if (node) {
    const n = nodeById(node.dataset.id);
    selectNode(n.id);
    const wp = screenToWorld(e.clientX, e.clientY);
    fbInter = { mode: 'drag', id: n.id, offX: wp.x - n.x, offY: wp.y - n.y, moved: false };
    e.preventDefault(); return;
  }
  selectNode(null);
  fbInter = { mode: 'pan', sx: e.clientX, sy: e.clientY, tx0: fbV.tx, ty0: fbV.ty };
}
function onDocMove(e) {
  if (!fbInter) return;
  if (fbInter.mode === 'pan') {
    fbV.tx = fbInter.tx0 + (e.clientX - fbInter.sx); fbV.ty = fbInter.ty0 + (e.clientY - fbInter.sy); applyTransform();
  } else if (fbInter.mode === 'drag') {
    const wp = screenToWorld(e.clientX, e.clientY); const n = nodeById(fbInter.id);
    n.x = Math.round(wp.x - fbInter.offX); n.y = Math.round(wp.y - fbInter.offY); fbInter.moved = true;
    const el = $(`.fb-n[data-id="${n.id}"]`); if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
    renderEdges(); renderMini();
  } else if (fbInter.mode === 'link') {
    const wp = screenToWorld(e.clientX, e.clientY); const t = $('#fb-temp'); if (t) { t.style.display = ''; t.setAttribute('d', edgeD(fbInter.start, wp)); }
  }
}
function onDocUp(e) {
  if (!fbInter) return;
  if (fbInter.mode === 'link') {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const port = el && el.closest && el.closest('.fb-port.in');
    if (port && port.dataset.id !== fbInter.from) {
      const to = port.dataset.id, branch = fbInter.branch;
      // uma saída por (origem, ramo): substitui a existente
      flowDraft.graph.edges = flowDraft.graph.edges.filter(x => !(x.from === fbInter.from && (x.branch || null) === (branch || null)));
      flowDraft.graph.edges.push({ id: 'e' + Date.now().toString(36), from: fbInter.from, to, branch });
      renderEdges(); scheduleSave();
    }
    const t = $('#fb-temp'); if (t) t.style.display = 'none';
  } else if (fbInter.mode === 'drag' && fbInter.moved) { scheduleSave(); }
  fbInter = null;
}
function onBuilderKey(e) {
  if ((e.key === 'Delete' || e.key === 'Backspace') && fbSel && fbSel !== 'trigger') {
    if (/input|textarea|select/i.test(document.activeElement.tagName)) return;
    removeNode(fbSel);
  }
}
function selectNode(id) {
  fbSel = id;
  document.querySelectorAll('.fb-n').forEach(el => el.classList.toggle('sel', el.dataset.id === id));
  $('#fb-inspector')?.classList.toggle('open', !!id);
  renderInspector();
}

// ---------- inspetor ----------
function renderInspector() {
  const box = $('#fb-inspector'); if (!box) return;
  if (!fbSel) { box.classList.remove('open'); box.innerHTML = ''; return; }
  const n = nodeById(fbSel); if (!n) { box.innerHTML = ''; return; }
  box.classList.add('open');
  box.innerHTML = n.type === 'trigger' ? triggerInspector() : nodeInspector(n);
}
function inspHead(icon, color, label, id) {
  return `<div class="fb-insp-hd">${iconChip(icon, color, 15)}<b>${label}</b>
    <button class="icon-btn" style="margin-left:auto" title="Fechar" onclick="selectNode(null)">${ico('x', 15)}</button>
    ${id && id !== 'trigger' ? `<button class="icon-btn danger" title="Remover" onclick="removeNode('${id}')">${ico('trash', 15)}</button>` : ''}</div>`;
}
function triggerInspector() {
  const tr = flowDraft.trigger, T = TRIGGERS[tr.type];
  const trigOpts = Object.entries(TRIGGERS).map(([k, v]) => ({ value: k, label: v.label }));
  let cfg = '';
  if (tr.type === 'keyword') {
    cfg = `<label>Palavra-chave<input value="${esc(tr.keyword || '')}" oninput="fbSetTrig('keyword',this.value)" placeholder="ex.: promoção"></label>
      <label>Correspondência${ecSelect('fb-trig-match', [{ value: 'contains', label: 'Contém o termo' }, { value: 'exact', label: 'Mensagem exata' }], tr.match === 'exact' ? 'exact' : 'contains', "fbSetTrig('match',val)")}</label>`;
  } else if (tr.type === 'link') {
    const phone = (state.wa && state.wa.displayPhoneNumber || '').replace(/\D/g, '');
    const link = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(tr.phrase || '')}` : '';
    cfg = `<label>Frase do gatilho<input value="${esc(tr.phrase || '')}" oninput="fbSetTrig('phrase',this.value)" placeholder="ex.: Quero a promoção"></label>
      <div class="fb-linkbox">${phone ? `<code id="fb-linkout">${esc(link)}</code><button class="btn small" onclick="copyText($('#fb-linkout').textContent)">${ico('copy', 13)}</button>` : '<span class="muted" style="font-size:12px">Conecte um número para gerar o link wa.me.</span>'}</div>`;
  } else if (tr.type === 'webhook') {
    const hooks = window._fbWebhooks || [];
    const wh = hooks.find(w => w.id === tr.webhookId);
    const opts = [{ value: '', label: hooks.length ? '— selecione um webhook —' : 'Nenhum webhook criado' }]
      .concat(hooks.map(w => ({ value: w.id, label: w.name })));
    // variáveis disponíveis a partir do mapeamento do webhook escolhido
    let varsHtml = '';
    if (wh) {
      const vars = ['nome', 'telefone', 'email'].concat((wh.mapping.custom || []).map(c => c.key)).filter(Boolean);
      varsHtml = `<div class="fb-vars"><span class="fb-sub">Variáveis disponíveis neste fluxo</span>
        <div class="fb-var-chips">${vars.map(v => `<code onclick="copyText('{{${v}}}')" title="Copiar">{{${v}}}</code>`).join('')}</div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Use em textos, botões e templates. O contato é criado/atualizado pelo mapeamento do webhook.</p></div>`;
    } else if (tr.webhookId) {
      varsHtml = '<p class="muted" style="font-size:12px;margin-top:8px">Webhook não encontrado (foi excluído?). Selecione outro.</p>';
    }
    cfg = `<label>Webhook de gatilho${ecSelect('fb-trig-wh', opts, tr.webhookId || '', "fbSetTrig('webhookId',val)")}</label>
      ${hooks.length ? '' : `<p class="muted" style="font-size:12px;margin-top:6px">Crie um webhook na aba <a href="#/webhooks">Webhooks</a> e mapeie os campos primeiro.</p>`}
      ${wh ? `<div class="fb-linkbox" style="margin-top:8px"><code>${esc(wh.url)}</code><button class="btn small" onclick="copyText('${esc(wh.url)}')">${ico('copy', 13)}</button></div>` : ''}
      ${varsHtml}`;
  } else if (tr.type === 'button' || tr.type === 'list') {
    cfg = `<label>Filtrar por texto (opcional)<input value="${esc(tr.keyword || '')}" oninput="fbSetTrig('keyword',this.value)" placeholder="deixe vazio p/ qualquer ${tr.type === 'button' ? 'botão' : 'item'}"></label>`;
  }
  return `${inspHead(T.icon, T.color, 'Gatilho', 'trigger')}<p class="fb-insp-desc">${T.desc}</p>
    <label>Tipo de gatilho${ecSelect('fb-trig-type', trigOpts, tr.type, 'fbChangeTrigger(val)')}</label>${cfg}`;
}
// ---- Enviar texto: botões OPCIONAIS, formato automático (regra da Meta) ----
// 0 botões → texto simples · 1–3 → botões interativos · 4–10 → lista
const FB_BTN_MAX = 10;
function fbTextFormat(n) {
  if (n.url && n.url.trim()) return 'cta';
  const nb = (n.buttons || []).length;
  if (!nb) return 'text';
  return nb <= 3 ? 'buttons' : 'list';
}
function fbTextInspector(n, set) {
  const fmt = fbTextFormat(n);
  const btns = n.buttons || [];
  const max = fmt === 'list' ? 24 : 20;
  const FMT = {
    text: ['Texto simples', ''],
    buttons: ['Botões interativos', 'done'],
    list: ['Lista interativa', 'done'],
    cta: ['Botão de link (CTA)', 'pending']
  }[fmt];

  return `
    <label>Texto da mensagem<textarea rows="4" ${set('text')} placeholder="Use {{nome}} para personalizar">${esc(n.text || '')}</textarea></label>

    <div class="fb-sec">
      <div class="row" style="align-items:center;margin-bottom:2px">
        <span class="fb-sub" style="flex:1;margin:0">Botões — opcional</span>
        <span class="pill ${FMT[1]}">${FMT[0]}</span>
      </div>
      <p class="muted" style="font-size:11.5px;margin:4px 0 9px">
        Sem botões vira <b>texto simples</b>. Até <b>3</b> a Meta envia como <b>botões</b>; a partir de <b>4</b> vira <b>lista</b> (máx. ${FB_BTN_MAX}). Limite: ${max} caracteres por opção.
      </p>

      ${n.url && n.url.trim() ? `<p class="muted" style="font-size:11.5px;margin:0 0 8px">
        <b>Com link (CTA), a Meta não permite botões de resposta</b> — limpe a URL abaixo para usar botões.</p>` : ''}

      <div id="fb-btns">${fbBtnRows(n, max)}</div>

      <div class="row" style="gap:7px;margin-top:8px">
        <button class="btn small no-grow" ${btns.length >= FB_BTN_MAX || (n.url || '').trim() ? 'disabled' : ''} onclick="fbAddBtn('${n.id}')">${ico('plus', 12)} Adicionar opção</button>
        ${btns.length >= FB_BTN_MAX ? `<span class="muted" style="font-size:11px">Limite de ${FB_BTN_MAX} atingido.</span>` : ''}
      </div>

      ${fmt === 'list' ? `<label style="margin-top:11px">Texto do botão que abre a lista<input value="${esc(n.listButton || 'Ver opções')}" maxlength="20" ${set('listButton')} placeholder="Ver opções"></label>` : ''}
    </div>

    <details class="utm-box" ${(n.url || '').trim() ? 'open' : ''}>
      <summary>${ico('link', 13)} Botão de link (CTA) — opcional</summary>
      <label style="margin-top:8px">URL<input value="${esc(n.url || '')}" ${set('url')} placeholder="https://..."></label>
      <label style="margin-top:8px">Texto do botão<input value="${esc(n.urlText || '')}" maxlength="20" ${set('urlText')} placeholder="Abrir link"></label>
      <p class="muted" style="font-size:11px;margin:8px 0 0">A Meta permite <b>1 botão de link</b> por mensagem e ele <b>não pode ser combinado</b> com botões de resposta.</p>
    </details>`;
}

function fbBtnRows(n, max) {
  const btns = n.buttons || [];
  if (!btns.length) return '<p class="muted" style="font-size:12px;margin:0">Nenhum botão — será enviado como texto simples.</p>';
  return btns.map((b, i) => {
    const len = (b.title || '').length;
    return `<div class="fb-btn-row">
      <span class="sv-num">${i + 1}</span>
      <input value="${esc(b.title || '')}" maxlength="${max}" oninput="fbBtnTitle('${n.id}',${i},this.value)" placeholder="Ex.: Quero falar com vendas">
      <span class="sv-count ${len > max ? 'over' : ''}">${len}/${max}</span>
      <button class="icon-btn danger" title="Remover" onclick="fbDelBtn('${n.id}',${i})">${ico('trash', 13)}</button>
    </div>`;
  }).join('');
}

function fbAddBtn(id) {
  const n = nodeById(id); if (!n) return;
  n.buttons = n.buttons || [];
  if (n.buttons.length >= FB_BTN_MAX) return;
  const before = fbTextFormat(n);
  n.buttons.push({ id: 'b' + Date.now().toString(36), title: '' });
  // cruzar 3 opções troca o formato (botões → lista): repinta o inspetor inteiro
  if (fbTextFormat(n) !== before) renderInspector(); else $('#fb-btns').innerHTML = fbBtnRows(n, fbTextFormat(n) === 'list' ? 24 : 20);
  refreshPreview(id); scheduleSave();
}
function fbDelBtn(id, i) {
  const n = nodeById(id); if (!n) return;
  const before = fbTextFormat(n);
  n.buttons.splice(i, 1);
  if (fbTextFormat(n) !== before) renderInspector(); else $('#fb-btns').innerHTML = fbBtnRows(n, fbTextFormat(n) === 'list' ? 24 : 20);
  refreshPreview(id); scheduleSave();
}
function fbBtnTitle(id, i, v) {
  const n = nodeById(id); if (!n) return;
  n.buttons[i].title = v;
  const max = fbTextFormat(n) === 'list' ? 24 : 20;
  const c = $$('.fb-btn-row')[i]?.querySelector('.sv-count');
  if (c) { c.textContent = `${v.length}/${max}`; c.classList.toggle('over', v.length > max); }
  refreshPreview(id); scheduleSave();
}

function nodeInspector(n) {
  const M = NODE_TYPES[n.type];
  const set = (k, extra = '') => `oninput="fbSetNode('${n.id}','${k}',this.value)"${extra}`;
  let body = '';
  if (n.type === 'text') body = fbTextInspector(n, set);
  else if (n.type === 'delay') body = `<label>Aguardar (segundos)<input type="number" min="0" max="300" value="${n.seconds || 3}" oninput="fbSetNode('${n.id}','seconds',Number(this.value))"></label>`;
  else if (n.type === 'buttons') {
    n.buttons = n.buttons || [{ title: 'Sim' }];
    const hasUrl = !!(n.url && n.url.trim());
    body = `<label>Texto<textarea rows="3" ${set('body')} placeholder="Pergunta ou mensagem">${esc(n.body || '')}</textarea></label>
      <div class="fb-btnmode">
        <button class="${!hasUrl ? 'on' : ''}" onclick="fbBtnMode('${n.id}','reply')">Respostas rápidas</button>
        <button class="${hasUrl ? 'on' : ''}" onclick="fbBtnMode('${n.id}','url')">Botão de link</button>
      </div>
      ${hasUrl ? `
        <label>Texto do botão<input value="${esc(n.urlText || '')}" maxlength="20" oninput="fbSetNode('${n.id}','urlText',this.value)" placeholder="Ex.: Ver oferta"></label>
        <label>URL de destino<input value="${esc(n.url || '')}" oninput="fbSetNode('${n.id}','url',this.value)" placeholder="https://…"></label>
        <p class="muted" style="font-size:11.5px">A Meta permite <b>1 botão de link</b> por mensagem — não pode ser combinado com respostas rápidas.</p>`
      : `
        <span class="fb-sub">Botões de resposta (máx. 3)</span><div class="fb-btns">${n.buttons.map((b, i) => `<div class="fb-btn-row"><input value="${esc(b.title || '')}" maxlength="20" oninput="fbSetBtn('${n.id}',${i},this.value)" placeholder="Botão ${i + 1}"><button class="icon-btn" onclick="rmButton('${n.id}',${i})">${ico('x', 13)}</button></div>`).join('')}</div>
        ${n.buttons.length < 3 ? `<button class="btn small" onclick="addButton('${n.id}')">${ico('plus', 12)} Botão</button>` : ''}`}`;
  } else if (n.type === 'list') {
    n.items = n.items || [{ title: 'Opção 1' }];
    body = `<label>Título<input value="${esc(n.header || '')}" ${set('header')} placeholder="Cabeçalho da lista"></label>
      <label>Texto<textarea rows="2" ${set('body')} placeholder="Mensagem">${esc(n.body || '')}</textarea></label>
      <label>Rótulo do botão<input value="${esc(n.buttonText || '')}" ${set('buttonText')} placeholder="Ver opções"></label>
      <span class="fb-sub">Itens (máx. 10)</span><div class="fb-btns">${n.items.map((it, i) => `<div class="fb-btn-row"><input value="${esc(it.title || '')}" maxlength="24" oninput="fbSetItem('${n.id}',${i},this.value)" placeholder="Item ${i + 1}"><button class="icon-btn" onclick="rmItem('${n.id}',${i})">${ico('x', 13)}</button></div>`).join('')}</div>
      ${n.items.length < 10 ? `<button class="btn small" onclick="addItem('${n.id}')">${ico('plus', 12)} Item</button>` : ''}`;
  } else if (n.type === 'media') {
    const mk = { image: 'Imagem', video: 'Vídeo', document: 'Documento', audio: 'Áudio' };
    body = `<label>Tipo${ecSelect('fb-media-kind', ['image', 'video', 'document', 'audio'].map(k => ({ value: k, label: mk[k] })), n.kind || 'image', `fbSetNode('${n.id}','kind',val)`)}</label>
      <label>URL do arquivo<input value="${esc(n.link || '')}" ${set('link')} placeholder="https://.../arquivo.jpg"></label>
      ${n.kind !== 'audio' ? `<label>Legenda<input value="${esc(n.caption || '')}" ${set('caption')} placeholder="opcional"></label>` : ''}`;
  } else if (n.type === 'template') {
    const tpls = (state.templatesCache && state.templatesCache.list) || [];
    body = `<label>Nome do template<input value="${esc(n.templateName || '')}" ${set('templateName')} list="fb-tpls" placeholder="nome_aprovado"></label>
      <datalist id="fb-tpls">${tpls.map(t => `<option value="${esc(t.name)}">`).join('')}</datalist>
      <label>Idioma<input value="${esc(n.language || 'pt_BR')}" ${set('language')} placeholder="pt_BR"></label>`;
  } else if (n.type === 'ai') {
    body = `<label>Instruções para a IA<textarea rows="4" ${set('prompt')} placeholder="Ex.: responda dúvidas sobre entrega com tom simpático">${esc(n.prompt || '')}</textarea></label>
      <p class="muted" style="font-size:11.5px">A resposta com IA requer um provedor configurado. Este nó já fica registrado no fluxo.</p>`;
  } else if (n.type === 'http') {
    n.headers = n.headers || [];
    body = `<div class="row"><label style="flex:0 0 100px">Método${ecSelect('fb-http-method', ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map(m => ({ value: m, label: m })), n.method || 'POST', `fbSetNode('${n.id}','method',val)`)}</label>
      <label style="flex:1">URL<input value="${esc(n.url || '')}" ${set('url')} placeholder="https://api.exemplo.com"></label></div>
      <span class="fb-sub">Cabeçalhos</span><div class="fb-headers">${n.headers.map((hh, i) => `<div class="fb-btn-row"><input value="${esc(hh.key || '')}" placeholder="Header" style="flex:0 0 40%" oninput="fbSetHdr('${n.id}',${i},'key',this.value)"><input value="${esc(hh.value || '')}" placeholder="Valor" oninput="fbSetHdr('${n.id}',${i},'value',this.value)"><button class="icon-btn" onclick="rmHeader('${n.id}',${i})">${ico('x', 13)}</button></div>`).join('')}</div>
      <button class="btn small" onclick="addHeader('${n.id}')">${ico('plus', 12)} Cabeçalho</button>
      <label>Corpo (JSON)<textarea rows="4" ${set('body')} placeholder='{"nome":"{{nome}}"}'>${esc(n.body || '')}</textarea></label>`;
  } else if (n.type === 'condition') {
    const fieldOpts = [['texto', 'Texto recebido'], ['nome', 'Nome do contato'], ['telefone', 'Telefone'], ['optin', 'Está em opt-in? (sim/nao)'], ['optout', 'Está em opt-out? (sim/nao)'], ['http', 'Resposta HTTP'], ['httpstatus', 'Status HTTP']].map(([v, l]) => ({ value: v, label: l }));
    const opOpts = Object.entries(OP_LBL).map(([v, l]) => ({ value: v, label: l }));
    body = `<label>Campo${ecSelect('fb-cond-field', fieldOpts, n.field || 'texto', `fbSetNode('${n.id}','field',val)`)}</label>
      <label>Operador${ecSelect('fb-cond-op', opOpts, n.op || 'contains', `fbSetNode('${n.id}','op',val)`)}</label>
      ${n.op === 'exists' || n.op === 'empty' ? '' : `<label>Valor<input value="${esc(n.value || '')}" ${set('value')} placeholder="ex.: sim"></label>`}
      <p class="muted" style="font-size:11.5px">Conecte a saída <b>Sim</b> e a saída <b>Não</b> a caminhos diferentes.</p>`;
  } else if (n.type === 'addtag' || n.type === 'removetag') {
    body = `<label>Tag<input value="${esc(n.tag || '')}" ${set('tag')} placeholder="ex.: lead-quente"></label>`;
  } else if (n.type === 'movestage') {
    const stages = (state.settings && state.settings.stages) || [];
    body = `<label>Etapa do funil${ecSelect('fb-move-stage', stages.map(s => ({ value: s, label: s })), n.stage || stages[0], `fbSetNode('${n.id}','stage',val)`)}</label>`;
  } else if (n.type === 'optin' || n.type === 'optout' || n.type === 'reactivate') {
    const desc = {
      optin: 'Marca o contato como <b>opt-in</b> — ele volta a receber mensagens e entra nas campanhas.',
      optout: 'Marca o contato como <b>opt-out</b>. Ele deixa de receber <b>qualquer</b> envio (bloqueado no backend) e recebe a mensagem de opt-out configurada.',
      reactivate: 'Reativa um contato que estava em opt-out, registrando a origem <b>Automação</b> no histórico.'
    }[n.type];
    body = `<p class="fb-insp-desc">${desc}</p>
      <label>Motivo (opcional)<input value="${esc(n.reason || '')}" ${set('reason')} placeholder="ex.: Pediu no menu de opções"></label>
      <p class="muted" style="font-size:11.5px;margin-top:8px">Configure as mensagens em <a href="#/consent">Opt-in &amp; Opt-out</a>.</p>`;
  } else if (n.type === 'end') {
    body = `<p class="muted" style="font-size:12.5px">Este nó encerra a automação. Nada depois dele é executado.</p>`;
  }
  return `${inspHead(M.icon, M.color, M.label, n.id)}${body}`;
}

// ---------- setters ----------
function refreshPreview(id) { const el = $(`.fb-n[data-id="${id}"] .fb-n-prev`); if (el) el.textContent = nodeSummary(nodeById(id)); }
function fbSetNode(id, k, v) { nodeById(id)[k] = v; refreshPreview(id); if (k === 'field' || k === 'op' || k === 'kind') renderInspector(); scheduleSave(); }
function fbSetBtn(id, i, v) { nodeById(id).buttons[i].title = v; refreshPreview(id); scheduleSave(); }
function fbBtnMode(id, mode) {
  const n = nodeById(id);
  if (mode === 'url') { if (!n.url) n.url = 'https://'; if (!n.urlText) n.urlText = 'Abrir link'; }
  else { n.url = ''; n.urlText = ''; }
  renderInspector(); refreshPreview(id); scheduleSave();
}
function fbSetItem(id, i, v) { nodeById(id).items[i].title = v; refreshPreview(id); scheduleSave(); }
function fbSetHdr(id, i, k, v) { nodeById(id).headers[i][k] = v; scheduleSave(); }
function fbSetTrig(k, v) {
  flowDraft.trigger[k] = v; refreshPreview('trigger');
  if (k === 'phrase') { const out = $('#fb-linkout'); const phone = (state.wa && state.wa.displayPhoneNumber || '').replace(/\D/g, ''); if (out && phone) out.textContent = `https://wa.me/${phone}?text=${encodeURIComponent(v)}`; }
  scheduleSave();
}
function fbChangeTrigger(type) {
  const cur = flowDraft.trigger;
  flowDraft.trigger = { type, keyword: cur.keyword || '', match: cur.match || 'contains', phrase: cur.phrase || '', hookToken: cur.hookToken, webhookId: cur.webhookId || '' };
  renderNodes(); renderInspector(); scheduleSave();
}

// ---------- adicionar / remover ----------
function addNodeAt(type, x, y) {
  const id = 'n' + Date.now().toString(36);
  if (x === undefined) {
    const c = $('#fb-canvas').getBoundingClientRect();
    const wp = screenToWorld(c.left + c.width / 2 - NODE_W / 2 * fbV.s, c.top + c.height / 2 - 30 * fbV.s);
    x = Math.round(wp.x); y = Math.round(wp.y);
  }
  const node = { ...nodeDefaults(type), id, x, y };
  flowDraft.graph.nodes.push(node);
  const src = fbSel && fbSel !== id ? fbSel : 'trigger';
  const srcNode = nodeById(src);
  if (srcNode && srcNode.type !== 'condition' && srcNode.type !== 'end' && !flowDraft.graph.edges.some(e => e.from === src && !e.branch)) {
    flowDraft.graph.edges.push({ id: 'e' + Date.now().toString(36), from: src, to: id });
  }
  renderNodes(); renderEdges(); selectNode(id); scheduleSave();
}
function removeNode(id) {
  if (id === 'trigger') return;
  flowDraft.graph.nodes = flowDraft.graph.nodes.filter(n => n.id !== id);
  flowDraft.graph.edges = flowDraft.graph.edges.filter(e => e.from !== id && e.to !== id);
  if (fbSel === id) fbSel = null;
  renderNodes(); renderEdges(); renderInspector(); scheduleSave();
}
function addButton(id) { const n = nodeById(id); if (n.buttons.length < 3) n.buttons.push({ title: '' }); renderInspector(); refreshPreview(id); scheduleSave(); }
function rmButton(id, i) { nodeById(id).buttons.splice(i, 1); renderInspector(); refreshPreview(id); scheduleSave(); }
function addItem(id) { const n = nodeById(id); if (n.items.length < 10) n.items.push({ title: '' }); renderInspector(); refreshPreview(id); scheduleSave(); }
function rmItem(id, i) { nodeById(id).items.splice(i, 1); renderInspector(); refreshPreview(id); scheduleSave(); }
function addHeader(id) { nodeById(id).headers.push({ key: '', value: '' }); renderInspector(); scheduleSave(); }
function rmHeader(id, i) { nodeById(id).headers.splice(i, 1); renderInspector(); scheduleSave(); }

async function flowStatsModal() {
  if (!flowDraft.id) return toast('Salve a automação primeiro para ver as métricas', 'error');
  try {
    const s = await api('/flows/' + flowDraft.id + '/stats');
    openModal(`<h2>${ico('activity')} Métricas — ${esc(s.name)}</h2>
      <div class="lk-kpis">
        <div><b>${fmtN(s.runs)}</b><span>Execuções</span></div>
        <div><b>${fmtN(s.runsToday)}</b><span>Hoje</span></div>
        <div><b>${s.lastRun ? timeAgo(s.lastRun) : '—'}</b><span>Última execução</span></div>
      </div>
      ${s.history.length ? `<span class="fb-sub">Histórico recente</span>
        <div class="flow-hist">${s.history.map(h => `
          <details class="log"><summary>${ico(h.log.every(l => l.ok) ? 'check-circle' : 'alert', 14)} ${new Date(h.ts).toLocaleString('pt-BR')} · ${h.log.length} passo(s)</summary>
          <pre class="out">${esc(h.log.map(l => `${l.ok ? '✓' : '✗'} ${l.node}${l.detail ? ' — ' + l.detail : ''}`).join('\n'))}</pre></details>`).join('')}</div>`
        : '<p class="muted" style="font-size:13px">Nenhuma execução ainda. A automação roda quando o gatilho for acionado.</p>'}
      <div class="row"><button class="btn primary" onclick="closeModal()">Fechar</button></div>`);
  } catch (e) { toast(e.message, 'error'); }
}

async function saveFlow() {
  if (!flowDraft.name.trim()) return toast('Dê um nome à automação', 'error');
  clearTimeout(fbSaveTimer);
  flowDraft.nodes = [];
  try {
    if (flowDraft.id) await api('/flows/' + flowDraft.id, { method: 'PUT', body: flowDraft });
    else { const r = await api('/flows', { body: flowDraft }); flowDraft = migrateToGraph(r.flow); }
    toast('Automação salva!');
    cleanupBuilder();
    renderFlows();
  } catch (e) { toast(e.message, 'error'); }
}

// prompt simples reutilizável
function promptModal({ title, label, placeholder = '', value = '' }) {
  return new Promise(res => {
    openModal(`<h2>${ico('edit')} ${esc(title)}</h2>
      <label>${esc(label)}<input id="pm-in" placeholder="${esc(placeholder)}" value="${esc(value)}"></label>
      <div class="row"><button class="btn" id="pm-no">Cancelar</button><button class="btn primary" id="pm-yes">Confirmar</button></div>`);
    setTimeout(() => $('#pm-in')?.focus(), 60);
    $('#pm-no').onclick = () => { closeModal(); res(null); };
    $('#pm-yes').onclick = () => { const v = $('#pm-in').value.trim(); closeModal(); res(v); };
  });
}

// ==================== EMBEDDED SIGNUP (Conectar WhatsApp) ====================
// Fluxo oficial Meta v25.0: popup -> authorization_code -> backend faz
// token -> business -> WABA -> número -> subscribed_apps -> teste, tudo automático.
let esOAuthState = null;
let esSessionInfo = null;
let esDone = false;

function loadFbSdk(appId, version) {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve();
    const timer = setTimeout(() => reject(new Error('SDK da Meta não carregou (bloqueado?)')), 8000);
    window.fbAsyncInit = function () {
      clearTimeout(timer);
      FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    const sc = document.createElement('script');
    sc.src = 'https://connect.facebook.net/pt_BR/sdk.js';
    sc.async = true; sc.defer = true; sc.crossOrigin = 'anonymous';
    sc.onerror = () => { clearTimeout(timer); reject(new Error('Não foi possível carregar o SDK da Meta')); };
    document.head.appendChild(sc);
  });
}

// Escuta o popup: sessionInfo do Embedded Signup (origem facebook.com)
// e o authorization_code do nosso callback (mesma origem).
window.addEventListener('message', (e) => {
  if (e.origin === 'https://www.facebook.com') {
    try {
      const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (d && d.type === 'WA_EMBEDDED_SIGNUP') esSessionInfo = d.data || null;
    } catch {}
    return;
  }
  if (e.origin === location.origin && e.data && e.data.type === 'ELITECHAT_META_CALLBACK') {
    if (!esOAuthState || e.data.state !== esOAuthState) return;
    if (e.data.error) return esFail(e.data.errorDescription || e.data.error);
    esFinish(e.data.code, true);
  }
});

const ES_STEPS = [
  ['access_token', 'Trocar código por Access Token'],
  ['business', 'Localizar Business'],
  ['waba', 'Localizar WhatsApp Business Account'],
  ['phone', 'Localizar número de telefone'],
  ['subscribed_apps', 'Assinar app na WABA (webhooks)'],
  ['health', 'Testar conexão']
];

function esProgress() {
  openModal(`
    <h2>${ico('zap')} Conectando seu WhatsApp</h2>
    <div class="es-steps">
      <div class="es-step wait" data-st="popup"><span class="dot"></span> Autorização na Meta (janela popup)</div>
      ${ES_STEPS.map(([k, label]) => `<div class="es-step" data-st="${k}"><span class="dot"></span> ${label}</div>`).join('')}
    </div>
    <p class="muted" id="es-msg" style="margin:10px 0 0">Complete o cadastro na janela da Meta…</p>`);
}

function esMark(name, ok, detail) {
  const el = document.querySelector(`.es-step[data-st="${name}"]`);
  if (el) {
    el.classList.remove('wait');
    el.classList.add(ok ? 'ok' : 'fail');
    if (detail) el.title = detail;
  }
}

function esFail(msg) {
  esDone = true;
  const box = $('#es-msg');
  if (box) { box.textContent = 'Falhou: ' + msg; box.classList.add('err'); }
  toast(msg, 'error');
}

async function esFinish(code, usedRedirect) {
  if (esDone) return;
  esDone = true;
  esMark('popup', true);
  const msg = $('#es-msg');
  if (msg) msg.textContent = 'Código recebido — finalizando a integração automaticamente…';
  try {
    const r = await api('/wa/connect', {
      body: {
        code,
        redirectUri: usedRedirect ? location.origin + '/auth/meta/callback' : undefined,
        sessionInfo: esSessionInfo
      }
    });
    (r.steps || []).forEach(st => esMark(st.name, st.ok, st.detail));
    state.wa = r.wa;
    if (msg) msg.textContent = `Conectado: ${r.wa.displayPhoneNumber || ''} ${r.wa.verifiedName ? '(' + r.wa.verifiedName + ')' : ''}`;
    toast('WhatsApp conectado com sucesso!');
    refreshBadge();
    setTimeout(() => { closeModal(); if (state.view === 'settings') renderSettings(); }, 1800);
  } catch (e) {
    ((e.meta && e.meta.steps) || []).forEach(st => esMark(st.name, st.ok, st.detail));
    esFail(e.message);
  }
}

async function connectWhatsApp() {
  let cfg;
  try { cfg = await api('/wa/config'); } catch (e) { return toast(e.message, 'error'); }
  if (!cfg.ready) {
    return toast(state.kind === 'admin'
      ? 'Preencha App ID e App Secret na seção Plataforma antes de conectar.'
      : 'A plataforma ainda não foi configurada pelo administrador.', 'error');
  }
  esOAuthState = (crypto.randomUUID && crypto.randomUUID()) || (String(Math.random()).slice(2) + Date.now());
  esSessionInfo = null;
  esDone = false;
  esProgress();

  // Caminho oficial: SDK da Meta com Config ID do Embedded Signup
  if (cfg.configId) {
    try {
      await loadFbSdk(cfg.appId, cfg.graphVersion);
      FB.login(resp => {
        const code = resp && resp.authResponse && resp.authResponse.code;
        if (code) esFinish(code, false);
        else if (!esDone) esFail('Cadastro cancelado ou não autorizado na Meta.');
      }, {
        config_id: cfg.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: '3' }
      });
      return;
    } catch (err) {
      // SDK bloqueado (adblock etc.) — cai para o diálogo OAuth com redirect
    }
  }

  // Fallback: diálogo OAuth oficial em popup com redirect p/ /auth/meta/callback
  const redirectUri = location.origin + '/auth/meta/callback';
  const url = `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth` +
    `?client_id=${encodeURIComponent(cfg.appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(esOAuthState)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('business_management,whatsapp_business_management,whatsapp_business_messaging')}`;
  const pop = window.open(url, 'elitechat_es', 'width=700,height=780');
  if (!pop) esFail('Popup bloqueado pelo navegador. Libere popups para este site.');
}

init();
