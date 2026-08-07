/* WA CRM — painel admin */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let TOKEN = localStorage.getItem('wacrm_token') || '';

// ---------------------------------------------------------------------------
// ATRIBUIÇÃO DE AFILIADO (janela de 7 dias)
// Quem chega por /app/?ref=CODIGO fica marcado por 7 dias. Guardamos em cookie
// E em localStorage: o cookie expira sozinho na data certa e sobrevive a
// navegações entre subdomínios; o localStorage cobre quem bloqueia cookie.
// Assim o afiliado continua recebendo a comissão mesmo se a pessoa só voltar
// para assinar dias depois.
// ---------------------------------------------------------------------------
const REF_DIAS = 7;

function setRefCookie(code) {
  const exp = new Date(Date.now() + REF_DIAS * 86400000).toUTCString();
  document.cookie = 'ec_ref=' + encodeURIComponent(code) + '; expires=' + exp + '; path=/; SameSite=Lax';
}
function getRefCookie() {
  const m = document.cookie.match(/(?:^|;\s*)ec_ref=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
// Código de indicação válido agora: cookie primeiro; o localStorage só vale
// enquanto estiver dentro dos 7 dias (ele não expira sozinho).
function refAtivo() {
  const c = getRefCookie();
  if (c) return c;
  try {
    const salvo = localStorage.getItem('ec_ref');
    const quando = Number(localStorage.getItem('ec_ref_ts') || 0);
    if (salvo && quando && Date.now() - quando < REF_DIAS * 86400000) return salvo;
    if (salvo) { localStorage.removeItem('ec_ref'); localStorage.removeItem('ec_ref_ts'); }
  } catch {}
  return '';
}
try {
  const refParam = new URLSearchParams(location.search).get('ref');
  if (refParam) {
    const code = refParam.toUpperCase().trim().slice(0, 16);
    setRefCookie(code);
    localStorage.setItem('ec_ref', code);
    localStorage.setItem('ec_ref_ts', String(Date.now()));
  }
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
      type: 'reminder', title: 'Lembrete, ' + d.label, body,
      waId: ev.contact ? ev.contact.waId : null,
      url: ev.contact ? '/app/#/inbox' : '/app/#/schedule',
      tag: 'ev-' + ev.id, requireInteraction: true
    });
  } else { toast(`⏰ ${d.label}: ${body}`); }
}
// ---------------------------------------------------------------------------
// PERMISSÃO DE NOTIFICAÇÃO (PWA)
//
// O navegador só concede a permissão quando o pedido nasce de um GESTO do
// usuário. Antes, requestPermission() era chamado dentro de um setTimeout, sem
// clique nenhum: o Safari/iOS ignorava e o Chrome tratava como pedido abusivo.
// Agora: mostramos NOSSO modal (não custa permissão) e o clique em "Ativar"
// dispara o pedido real. A escolha fica salva para não perguntar todo login.
// ---------------------------------------------------------------------------
const LS_NOTIF_ASK = 'ec_notif_ask';   // '' | 'on' | 'off' | 'blocked'

function notifChoice() { try { return localStorage.getItem(LS_NOTIF_ASK) || ''; } catch { return ''; } }
function setNotifChoice(v) { try { localStorage.setItem(LS_NOTIF_ASK, v); } catch {} }
function notifPermission() {
  try { return window.ECNotify ? ECNotify.permission() : 'unsupported'; } catch { return 'unsupported'; }
}

function askNotifPermission() {
  // O token do aparelho pode ter chegado antes do login (o SO entrega assim que
  // o app abre). Agora que existe sessão, vincula-o à conta.
  if (window.ECNative) { try { ECNative.sendToken(); } catch {} }
  if (!window.ECNotify) return;

  const perm = notifPermission();
  if (perm === 'unsupported') return;

  // Já concedida: só garante a inscrição (troca de aparelho, cache limpo).
  if (perm === 'granted') {
    try { ECNotify.subscribePush(); } catch {}
    setNotifChoice('on');
    return;
  }

  // Bloqueada: pedir de novo não abre nada. Avisa uma vez como reverter.
  if (perm === 'denied') {
    if (notifChoice() !== 'blocked') {
      setNotifChoice('blocked');
      setTimeout(() => toast('Notificações bloqueadas no navegador. Libere no cadeado da barra de endereços.', 'error'), 1500);
    }
    return;
  }

  if (notifChoice() === 'off') return;          // já disse não
  setTimeout(() => notifOptInModal(), 1200);    // deixa a tela pintar antes
}

// Nosso modal: não consome a permissão do navegador.
function notifOptInModal() {
  if (document.querySelector('.modal')) return;   // não atropela outro modal
  openModal(`
    <h2>${ico('bell')} Ativar notificações?</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13.5px">
      Receba o aviso na hora em que um cliente mandar mensagem, mesmo com o
      EliteChat fechado. Sem isso, você só vê a mensagem ao abrir o painel.
    </p>
    <div class="notif-perks">
      <div>${ico('message', 14)} Nova mensagem de cliente</div>
      <div>${ico('phone', 14)} Chamada de voz recebida</div>
      <div>${ico('clock', 14)} Lembrete de agendamento</div>
    </div>
    <p class="hint" style="margin-top:12px;text-align:left">Você escolhe quais avisos quer em Configurações e pode desligar quando quiser.</p>
    <div class="row" style="margin-top:16px">
      <button class="btn" onclick="notifOptIn(false)">Agora não</button>
      <button class="btn primary" onclick="notifOptIn(true)">${ico('bell', 14)} Ativar notificações</button>
    </div>`);
}

// Chamado pelo CLIQUE: é este gesto que autoriza o pedido ao navegador.
async function notifOptIn(sim) {
  closeModal();
  if (!sim) {
    setNotifChoice('off');
    toast('Tudo bem. Você pode ativar depois em Configurações.');
    return;
  }
  try {
    const r = await ECNotify.requestPermission();
    if (r === 'granted') {
      setNotifChoice('on');
      ECNotify.setPref('enabled', true);
      toast('Notificações ativadas! 🔔');
    } else if (r === 'denied') {
      setNotifChoice('blocked');
      toast('O navegador bloqueou. Libere no cadeado da barra de endereços.', 'error');
    } else {
      setNotifChoice('');   // fechou sem escolher: perguntamos depois
    }
  } catch (e) { toast('Não foi possível ativar: ' + e.message, 'error'); }
  if (typeof paintNotifBell === 'function') paintNotifBell();
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

// ---------- Tema (claro / escuro estilo Simplify) ----------
const THEME_IC = {
  // lua (modo escuro ativo → oferece voltar ao claro) e sol (modo claro ativo)
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>'
};
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
function setTheme(t) {
  t = t === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('ec_theme', t); } catch (e) {}
  const ic = $('#theme-ic'); if (ic) ic.innerHTML = t === 'dark' ? THEME_IC.sun : THEME_IC.moon;
  const btn = $('#theme-btn'); if (btn) btn.title = t === 'dark' ? 'Mudar para claro' : 'Mudar para escuro';
  const card = $('#appearance-card'); if (card) card.innerHTML = renderThemeSettings();
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', t === 'dark' ? '#080a08' : '#34D399');
  if (window.ECNative) ECNative.syncTheme();   // status bar do app acompanha o tema
}
function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
function renderThemeSettings() {
  const t = currentTheme();
  return `
    <h2>${ico('sparkles')} Aparência</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">Escolha como o painel aparece para você. A preferência fica salva neste dispositivo.</p>
    <div class="seg-theme">
      <button class="${t === 'light' ? 'on' : ''}" onclick="setTheme('light')">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${THEME_IC.sun}</svg> Claro
      </button>
      <button class="${t === 'dark' ? 'on' : ''}" onclick="setTheme('dark')">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${THEME_IC.moon}</svg> Escuro
      </button>
    </div>`;
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

// ---------- Ganchos usados pelo app nativo (native.js) ----------
// No navegador ninguém chama isto; no app das lojas são os pontos de entrada
// do toque na notificação, da volta do segundo plano e do botão voltar.
window.__ecOnNotifOpen = notifOpenFromData;

window.__ecOnResume = function () {
  // O SO derruba a conexão SSE quando o app fica em segundo plano.
  if (TOKEN) { try { connectSSE(); } catch {} notifResync(); }
};

// Botão físico de voltar do Android. Retorna true quando já tratou o toque —
// aí o native.js não navega nem fecha o app.
window.__ecHandleBack = function () {
  const modal = $('#modal-root');
  if (modal && modal.innerHTML.trim()) { closeModal(); return true; }
  const folha = document.getElementById('more-sheet');
  if (folha && !folha.classList.contains('hidden')) { toggleMoreSheet(false); return true; }
  const app = document.getElementById('app');
  if (app && app.classList.contains('nav-open')) { toggleNav(false); return true; }
  // Dentro de uma conversa, voltar retorna para a lista em vez de sair do app.
  if (document.querySelector('.inbox.chat-open')) { closeChatMobile(); return true; }
  return false;
};
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
      ${ck('types.commission', p.types.commission !== false, 'Vendas aprovadas', 'Comissão de indicação na carteira')}
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
  ECNotify.notify({ type: 'message', title: 'EliteChat', body: 'Notificação de teste, está funcionando! 🎉', url: '/app/#/settings', tag: 'test' });
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
// ---------- CANAL ATIVO (conexão WhatsApp) ----------
// Cada número conectado é um canal com conversas e contatos próprios. O canal
// escolhido viaja em TODA requisição no header `x-channel`, então o backend já
// devolve só o que pertence àquele número — nada se mistura.
let CHANNELS = [];
let CH_ID = localStorage.getItem('ec_channel') || '';
function chActive() { return CHANNELS.find(c => c.id === CH_ID) || CHANNELS[0] || null; }
function chName(id) { const c = CHANNELS.find(x => x.id === id); return c ? c.label : ''; }

// Base da API: vazia no navegador (mesmo host), absoluta nos apps nativos —
// lá o HTML vem do bundle e um caminho relativo não chegaria ao backend.
const API = window.EC_CONFIG || { api: p => '/api' + p, url: p => location.origin + p, webOrigin: location.origin, native: false };

// Abre uma URL fora do painel (download de CSV, link externo, checkout).
// No navegador é uma aba nova; no app nativo vai para o navegador do sistema,
// que sabe lidar com download de arquivo — o WebView do app não sabe.
function openExternal(url) {
  if (API.native && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
    window.Capacitor.Plugins.Browser.open({ url }).catch(() => window.open(url, '_blank'));
    return;
  }
  window.open(url, '_blank');
}

// Abre uma autorização OAuth (Meta, Meta Ads, Nuvemshop).
// Navegador: popup que devolve o código por postMessage.
// App nativo: navegador do sistema — não existe popup com `opener` ali, então
// o retorno vem por deep link (elitechat://auth/...) e o native.js reemite o
// mesmo postMessage que estes fluxos já escutam.
function openAuthWindow(url, name, features) {
  if (API.native && window.ECNative) return ECNative.openAuthWindow(url);
  return window.open(url, name, features);
}

async function api(path, opts = {}) {
  const res = await fetch(API.api(path), {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(CH_ID ? { 'x-channel': CH_ID } : {}),
      ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {})
    },
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
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
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
  cart: '<circle cx="9" cy="20" r="1.6"/><circle cx="18" cy="20" r="1.6"/><path d="M2 3h3l2.6 12.4a1.6 1.6 0 0 0 1.6 1.3h8.5a1.6 1.6 0 0 0 1.6-1.3L21 7H6"/>',
  funnel: '<path d="M3 4.5h18l-7.2 8.4V20l-3.6 1.6v-8.7L3 4.5Z" stroke-linejoin="round"/>',
  flow: '<path d="M3 4.5h18l-7.2 8.4V20l-3.6 1.6v-8.7L3 4.5Z" stroke-linejoin="round"/>',
  http: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  pix: '<path d="M12 2.5 21.5 12 12 21.5 2.5 12z"/><path d="M8.6 10.2 12 6.8l3.4 3.4M8.6 13.8 12 17.2l3.4-3.4"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  power: '<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
  chat2: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="10" r="1"/><circle cx="13" cy="10" r="1"/><circle cx="17" cy="10" r="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  clock2: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5"/>',
  trend: '<path d="M3 17l5-5 4 4 6.5-7"/><path d="M14.5 9H19v4.5"/>',
  smartphone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.6h2"/>',
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
// valor atual de um ecSelect (guardado em data-val)
function ecVal(id) { const el = document.getElementById(id); return el ? el.dataset.val : ''; }
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
      state.planFeatures = me.planFeatures || null; // null = admin da plataforma (tudo liberado)
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
    // Veio de link de afiliado: o campo já vem preenchido e TRAVADO, para que
    // ninguém apague por engano (ou de propósito) a comissão de quem indicou.
    const inp = $('#reg-ref'), nota = $('#reg-ref-note');
    const code = refAtivo();
    if (registerMode && code) {
      inp.value = code;
      inp.readOnly = true;
      inp.classList.add('locked');
      inp.tabIndex = -1;
      if (nota) {
        nota.textContent = 'Você chegou pela indicação de ' + code + '. O código fica travado.';
        nota.classList.remove('hidden');
      }
    } else if (inp) {
      // Sem indicação ativa: se o campo estava travado, o código veio de uma
      // janela que já expirou. Limpa, senão o cadastro levaria um código velho.
      if (inp.classList.contains('locked')) inp.value = '';
      inp.readOnly = false;
      inp.classList.remove('locked');
      inp.removeAttribute('tabindex');
      if (nota) nota.classList.add('hidden');
    }
  }
  $('#auth-title').textContent = registerMode ? 'Crie sua conta' : 'Acesse sua conta';
  $('#auth-sub').textContent = registerMode ? 'Conecte seu WhatsApp em minutos, sem configuração técnica' : 'Painel de atendimento e vendas';
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
      // o código da janela de 7 dias tem prioridade sobre o que estiver no campo
      ? await api('/register', { body: { name: $('#reg-name').value.trim(), email: user, pass, refCode: refAtivo() || ($('#reg-ref')?.value || '').trim() } })
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
  setTheme(currentTheme());   // sincroniza o ícone de tema do topbar
  askNotifPermission();    // permissão + push do WebApp
  refreshWallet();         // saldo no cabeçalho (celular)
  initSearch();
  await loadChannels();    // canais (conexões WhatsApp) antes de qualquer listagem
  try { const st = await api('/settings'); state.settings = st.settings; state.wa = st.wa; } catch {}
  connectSSE();
  refreshBadge();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshBadge, 30000);
  if (state.mustChangePassword) toast('Troque a senha padrão em Configurações → Segurança', 'error');
  route();
}

// Card de gestão das conexões (Configurações → Conexão & API).
// Cada linha é um número; a linha marcada é o canal que o painel está usando.
function channelsCard() {
  if (CHANNELS.length < 1) return '';
  const lim = CH_LIMIT || {};
  const cheio = !podeMaisCanais();
  const at = chActive() || {};
  return `<div class="card">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="margin:0;flex:1">${waLogo(17, '#25D366')} Contas do WhatsApp conectadas</h2>
      <span class="pill ${cheio ? 'pending' : 'done'}">${fmtN(lim.used || CHANNELS.length)}${lim.unlimited ? '' : ' / ' + fmtN(lim.limit)} conexões</span>
    </div>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      Cada número é um <b>canal separado</b>: as conversas e os contatos de um não aparecem no outro.
      Use o seletor no topo da tela para alternar entre eles.
    </p>
    <div class="ch-list">
      ${CHANNELS.map(c => `<div class="ch-row ${c.id === at.id ? 'sel' : ''}">
        <i class="ch-dot ${c.connected ? 'on' : 'off'}"></i>
        <div class="ch-row-main" role="button" tabindex="0" title="Renomear esta conta"
             onclick="renameChannel('${c.id}')"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();renameChannel('${c.id}')}">
          <b>${esc(c.label)}</b>${c.isDefault ? ' <span class="pill" style="font-size:10px">principal</span>' : ''}
          <div class="muted" style="font-size:12px;margin-top:2px">
            ${c.connected
              ? (c.displayPhoneNumber ? esc(c.displayPhoneNumber) : '<b style="color:var(--verde-deep)">conectado</b>')
              : '<b style="color:var(--amber)">não conectado</b>'}
            · ${fmtN(c.contacts)} contato(s)${c.unread ? ` · ${fmtN(c.unread)} não lida(s)` : ''}
            ${c.identityError ? `<div style="color:var(--red);font-size:11px;margin-top:2px">${esc(c.identityError)}</div>` : ''}
            ${c.cancelAt ? `<div class="ch-cancel-note">${ico('alert', 11)}
              Cancelada. Funciona até <b>${new Date(c.cancelAt).toLocaleDateString('pt-BR')}</b> e, nessa data,
              a conexão e todos os dados dela serão excluídos.
              <button class="linkish" onclick="undoCancelChannel('${c.id}')">Reativar</button></div>` : ''}
          </div>
        </div>
        ${c.id === at.id
          ? '<span class="pill done">em uso</span>'
          : `<button class="btn small no-grow" onclick="switchChannel('${c.id}')">Usar</button>`}
        <button class="icon-btn" title="Sincronizar número com a Meta" onclick="syncChannel('${c.id}', this)">${ico('refresh', 14)}</button>
        <button class="icon-btn" title="Renomear" onclick="renameChannel('${c.id}')">${ico('edit', 14)}</button>
        ${c.isDefault || state.agent || c.cancelAt ? '' :
          `<button class="icon-btn danger" title="Cancelar esta conexão" onclick="cancelChannel('${c.id}')">${ico('trash', 14)}</button>`}
      </div>`).join('')}
    </div>
    <div class="row" style="margin-top:14px;align-items:flex-end">
      <label style="flex:1;max-width:280px">Nome da nova conexão<input id="ch-new" placeholder="ex.: Vendas · Suporte · Filial SP"></label>
      ${cheio
        // Limite cheio: a conexão passa a ser paga. O botão mostra o valor
        // adicional ao lado e abre o pagamento — nunca fica desabilitado nem
        // manda o cliente para outra aba no meio da compra.
        ? `<button class="btn primary no-grow" onclick="openExtraPay('whatsapps')">
             ${ico('plus', 14)} Adicionar conexão
             ${lim.extraPrice ? `<span class="btn-price">+${fmtBRL(lim.extraPrice)}/mês</span>` : ''}
           </button>`
        : `<button class="btn primary no-grow" onclick="createChannel()">${ico('plus', 14)} Adicionar conexão</button>`}
    </div>
    ${cheio ? `<p class="hint" style="margin-top:10px">${ico('alert', 12)} Você já utiliza as <b>${fmtN(lim.limit)}</b> conexão(ões) disponíveis no seu plano.</p>`
    : '<p class="hint" style="margin-top:10px">Depois de criar a conexão, selecione-a no seletor do topo e clique em <b>Conectar WhatsApp</b> para vincular o número.</p>'}
    ${extraChannelsBox(lim)}
  </div>`;
}

// ---------------------------------------------------------------------------
// CANCELAR UMA CONEXÃO EXTRA.
// O aviso é o ponto central: cancelar não é desativar, é excluir. Mostramos o
// que será apagado, a data em que isso acontece, e exigimos que o cliente
// digite o nome da conexão para confirmar.
// ---------------------------------------------------------------------------
async function cancelChannel(id) {
  let p;
  try { p = await api('/channels/' + id + '/cancel/preview'); }
  catch (e) { return toast(e.message, 'error'); }

  const data = new Date(p.until).toLocaleDateString('pt-BR');
  const itens = [
    [p.apaga.contacts, 'contato(s), com histórico e posição no funil'],
    [p.apaga.messages, 'mensagem(ns) de conversa'],
    [p.apaga.campaigns, 'campanha(s)'],
    [p.apaga.schedules, 'agendamento(s)']
  ].filter(([n]) => n > 0);

  openModal(`
    <h2 style="color:var(--red)">${ico('alert')} Cancelar a conexão ${esc(p.label)}</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">
      A conexão permanece ativa até <b>${data}</b>, data em que o período já pago se encerra.
      A partir dela, a cobrança mensal desta unidade deixa de ser feita.
    </p>
    <div class="danger-box">
      <b>${ico('trash', 13)} Em ${data}, tudo desta conexão será excluído em definitivo:</b>
      <ul>
        ${itens.length
          ? itens.map(([n, l]) => `<li>${fmtN(n)} ${l}</li>`).join('')
          : '<li>nenhum dado registrado até agora</li>'}
        <li>o número deixa de estar vinculado à sua conta na Meta</li>
      </ul>
      <p>Esta ação <b>não pode ser desfeita</b> depois da data e os dados <b>não poderão ser recuperados</b>.
      Se precisar do histórico, exporte seus contatos antes.</p>
    </div>
    <label style="margin-top:14px"><span>Para confirmar, digite <b>${esc(p.label)}</b></span>
      <input id="ch-conf" autocomplete="off" placeholder="${esc(p.label)}"
             data-alvo="${esc(p.label)}" oninput="confChannelName(this)"></label>
    <div class="row" style="margin-top:14px">
      <button class="btn" onclick="closeModal()">Manter conexão</button>
      <button class="btn danger" id="ch-go" disabled onclick="doCancelChannel('${id}', this)">
        ${ico('trash', 14)} Cancelar e agendar exclusão</button>
    </div>`);
}

// O nome esperado vai num data-attribute: interpolar a string direto no
// oninput quebraria o HTML em nomes com aspas.
function confChannelName(el) {
  const btn = $('#ch-go');
  if (btn) btn.disabled = el.value.trim() !== (el.dataset.alvo || '');
}

async function doCancelChannel(id, btn) {
  btn.disabled = true; btn.textContent = 'Cancelando…';
  try {
    const r = await api('/channels/' + id + '/cancel', { body: {} });
    closeModal();
    toast(`Conexão cancelada. Ativa até ${new Date(r.channel.cancelAt).toLocaleDateString('pt-BR')}.`);
    await loadChannels();
    if (state.view === 'settings') renderSettings();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = 'Tentar de novo'; }
}

async function undoCancelChannel(id) {
  try {
    await api('/channels/' + id + '/cancel/undo', { body: {} });
    toast('Conexão reativada, a cobrança mensal continua normalmente.');
    await loadChannels();
    if (state.view === 'settings') renderSettings();
  } catch (e) { toast(e.message, 'error'); }
}

// Contratar conexões a mais sem sair da tela de Conexões: escolhe a quantidade,
// vê o total somando e paga no pop-up. É mensal — entra na renovação.
function extraChannelsBox(lim) {
  if (state.agent) return '';   // atendente não contrata nada

  // Sem preço definido no Admin não há o que cobrar: o card de quantidade some,
  // mas o botão "Adicionar conexão" continua abrindo o pagamento — a compra se
  // resolve ali mesmo, sem jogar o cliente para a aba de planos.
  if (!lim.buyable || !lim.extraPrice) return '';

  return `<div class="extra-buy" id="extra-buy-whatsapps">
    <div class="extra-buy-head">
      ${ico('plus', 15)}
      <div style="flex:1;min-width:0">
        <b>Amplie sua operação</b>
        <em>Conexões adicionais por ${fmtBRL(lim.extraPrice)}/mês cada${lim.extras ? ` · ${fmtN(lim.extras)} já contratada(s)` : ''}</em>
      </div>
    </div>
    <div class="extra-buy-row">
      <div class="qty">
        <button type="button" class="qty-b" onclick="extraQty('whatsapps',-1)" aria-label="Menos uma">−</button>
        <input id="xq-whatsapps" class="qty-i" type="number" min="1" max="20" value="1"
               inputmode="numeric" oninput="extraQty('whatsapps',0)" aria-label="Quantas conexões">
        <button type="button" class="qty-b" onclick="extraQty('whatsapps',1)" aria-label="Mais uma">+</button>
      </div>
      <div class="extra-total">
        <b id="xt-whatsapps">${fmtBRL(lim.extraPrice)}</b>
        <em>por mês</em>
      </div>
      <button class="btn primary no-grow" onclick="openExtraPay('whatsapps')">
        ${ico('card', 14)} Adicionar conexão</button>
    </div>
  </div>`;
}

// +/- na quantidade (d=0 só recalcula depois de digitar) e total ao vivo.
function extraQty(key, d) {
  const el = document.getElementById('xq-' + key);
  const out = document.getElementById('xt-' + key);
  if (!el) return;
  let n = Math.floor(Number(el.value) || 1) + d;
  n = Math.max(1, Math.min(20, n));
  el.value = n;
  const preco = extraUnitPrice(key);
  if (out) out.textContent = fmtBRL(preco * n);
  return n;
}

// Preço unitário do extra: o card de Conexões usa o limite já carregado; a tela
// de Assinatura usa o cache dela.
function extraUnitPrice(key) {
  if (key === 'whatsapps' && CH_LIMIT && CH_LIMIT.extraPrice) return CH_LIMIT.extraPrice;
  return (((BILL_CACHE || {}).usage || {})[key] || {}).extraPrice || 0;
}

async function createChannel() {
  const el = $('#ch-new');
  try {
    const r = await api('/channels', { body: { label: el ? el.value : '' } });
    await loadChannels();
    await switchChannel(r.channel.id);   // já entra no canal novo para conectar o número
    toast('Canal criado, agora conecte o número');
  } catch (e) { toast(e.message, 'error'); }
}

// Renomear a conta de WhatsApp. Usa o modal do app: o prompt() nativo é
// bloqueado em vários navegadores e no app instalado (PWA), e o botão parecia
// simplesmente não fazer nada.
// Busca na Meta o número e o nome verificado deste canal e regrava, para a
// tela nunca mais dizer "não conectado" para um número que está funcionando.
async function syncChannel(id, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api('/channels/' + id + '/sync', { method: 'POST', body: {} });
    await loadChannels();
    route();
    if (r.error) toast(r.error, 'error');
    else toast(r.channel.displayPhoneNumber
      ? 'Número sincronizado: ' + r.channel.displayPhoneNumber
      : 'Sincronizado com a Meta');
  } catch (e) { toast(e.message, 'error'); }
  finally { if (btn) btn.disabled = false; }
}

function renameChannel(id) {
  const ch = CHANNELS.find(c => c.id === id) || {};
  openModal(`
    <h2>${ico('edit')} Renomear conta</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">
      É só o apelido que aparece no painel${ch.displayPhoneNumber ? ` para o número <b>${esc(ch.displayPhoneNumber)}</b>` : ''}.
      O número conectado na Meta não muda.</p>
    <label>Nome da conta<input id="ch-rename" value="${esc(ch.label || '')}" maxlength="40" placeholder="ex.: Vendas · Suporte · Filial SP"></label>
    <p id="ch-rename-err" class="err"></p>
    <div class="row" style="margin-top:14px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="renameChannelSave('${id}', this)">${ico('save', 14)} Salvar</button>
    </div>`);
  setTimeout(() => { const i = $('#ch-rename'); if (i) { i.focus(); i.select(); } }, 40);
  const inp = $('#ch-rename');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') renameChannelSave(id, null); });
}

async function renameChannelSave(id, btn) {
  const inp = $('#ch-rename'); if (!inp) return;
  const nome = inp.value.trim();
  const err = $('#ch-rename-err');
  if (!nome) { if (err) err.textContent = 'Dê um nome para a conta.'; return; }
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
  try {
    await api('/channels/' + id, { method: 'PUT', body: { label: nome } });
    closeModal();
    await loadChannels();
    route();
    toast('Conta renomeada');
  } catch (e) {
    if (err) err.textContent = e.message;
    if (btn) { btn.disabled = false; btn.innerHTML = `${ico('save', 14)} Salvar`; }
  }
}

async function removeChannel(id) {
  const ok = await confirmModal({
    title: 'Desconectar este número?',
    text: `O número "${chName(id)}" deixa de enviar e receber mensagens. As conversas permanecem no histórico da conta.`,
    ok: 'Desconectar', danger: true
  });
  if (!ok) return;
  try {
    await api('/channels/' + id, { method: 'DELETE' });
    if (CH_ID === id) CH_ID = '';
    await loadChannels(); route();
    toast('Conexão removida');
  } catch (e) { toast(e.message, 'error'); }
}

// ============ CANAIS — seleção da conta do WhatsApp ============
// Trocar de canal troca TUDO que é conversa/contato: o header x-channel vai em
// toda chamada e o backend devolve só o que é daquele número.
let CH_LIMIT = null;

async function loadChannels() {
  try {
    const d = await api('/channels');
    CHANNELS = d.channels || [];
    CH_LIMIT = d.limit || null;
    if (!CHANNELS.find(c => c.id === CH_ID)) CH_ID = (CHANNELS[0] || {}).id || '';
    localStorage.setItem('ec_channel', CH_ID);
  } catch { CHANNELS = []; }
  paintChannelPicker();
}

// O avatar do topo é o seletor de conta: clicar abre a lista de números
// conectados, com atalho para conectar mais um e para gerenciar todos.
function paintChannelPicker() {
  const menu = $('#ch-menu'); if (!menu) return;
  const at = chActive() || {};

  // nome do canal ativo embaixo do usuário, para nunca haver dúvida de por qual
  // número a pessoa está atendendo
  const nome = $('#tb-chname');
  if (nome) nome.textContent = CHANNELS.length ? (at.label || 'WhatsApp') : 'Nenhum número conectado';

  // aviso de não lidas em OUTROS canais (o do canal ativo já aparece no menu)
  const outras = CHANNELS.reduce((s, c) => s + (c.id === at.id ? 0 : (c.unread || 0)), 0);
  const badge = $('#tb-chbadge');
  if (badge) {
    badge.textContent = outras > 99 ? '99+' : outras;
    badge.classList.toggle('hidden', !outras);
    badge.title = outras ? `${outras} não lida(s) em outros números` : '';
  }

  const cabe = podeMaisCanais();
  menu.innerHTML = `
    <div class="ch-menu-head">Contas de WhatsApp${CH_LIMIT && !CH_LIMIT.unlimited
      ? ` <span class="ch-lim">${fmtN(CH_LIMIT.used)} de ${fmtN(CH_LIMIT.limit)}</span>` : ''}</div>
    ${CHANNELS.length ? CHANNELS.map(c => `
      <button class="ch-item ${c.id === at.id ? 'sel' : ''}" onclick="switchChannel('${c.id}')">
        <i class="ch-dot ${c.connected ? 'on' : 'off'}"></i>
        <span class="ch-item-txt">
          <b>${esc(c.label)}</b>
          <em>${c.connected
            ? (c.displayPhoneNumber ? esc(c.displayPhoneNumber) : 'conectado')
            : 'número não conectado'} · ${fmtN(c.contacts)} contato(s)</em>
        </span>
        ${c.unread ? `<b class="ch-badge">${c.unread > 99 ? '99+' : c.unread}</b>` : ''}
        ${c.id === at.id ? ico('check', 14) : ''}
      </button>`).join('')
    : '<p class="ch-empty">Nenhuma conta conectada ainda.</p>'}
    <div class="ch-menu-sep"></div>
    <button class="ch-item add" onclick="closeChannelMenu();goChannels(1)">
      ${ico('plus', 14)}
      <span class="ch-item-txt"><b>Conectar outra conta</b>
        <em>${cabe ? 'Adicione um novo número de WhatsApp' : 'Limite do plano atingido, veja os extras'}</em></span>
    </button>
    <button class="ch-item" onclick="closeChannelMenu();goChannels()">
      ${ico('gear', 14)}
      <span class="ch-item-txt"><b>Gerenciar contas</b>
        <em>Renomear, trocar de número ou remover</em></span>
    </button>`;
}

// Leva direto para a aba de contas em Configurações. `novo` já abre o campo de
// criação, porque o caminho mais pedido é "quero mais um número".
function goChannels(novo) {
  PENDING_TAB = 'contas';
  PENDING_CH_NEW = !!novo;
  if (state.view === 'settings') { renderSettings(); }
  else location.hash = '#/settings';
}
let PENDING_TAB = '', PENDING_CH_NEW = false;

function podeMaisCanais() {
  return !CH_LIMIT || CH_LIMIT.unlimited || CH_LIMIT.used < CH_LIMIT.limit;
}

function toggleChannelMenu(e) {
  if (e) e.stopPropagation();
  const m = $('#ch-menu'); if (!m) return;
  m.classList.toggle('hidden');
  const aberto = !m.classList.contains('hidden');
  const btn = $('#tb-user');
  if (btn) btn.setAttribute('aria-expanded', String(aberto));
  if (aberto) setTimeout(() => document.addEventListener('click', closeChannelMenu, { once: true }), 0);
}
function closeChannelMenu() {
  const m = $('#ch-menu'); if (m) m.classList.add('hidden');
  const btn = $('#tb-user'); if (btn) btn.setAttribute('aria-expanded', 'false');
}

async function switchChannel(id) {
  if (id === CH_ID) return closeChannelMenu();
  CH_ID = id;
  localStorage.setItem('ec_channel', id);
  closeChannelMenu();
  state.currentWaId = null;          // a conversa aberta é de outro número
  await loadChannels();
  try { const st = await api('/settings'); state.wa = st.wa; } catch {}
  refreshBadge();
  route();                            // repinta a tela atual já filtrada
  toast(`Canal: ${chName(id)}`);
}

function connectSSE() {
  if (es) es.close();
  es = new EventSource(API.api('/events?token=' + TOKEN));
  es.addEventListener('message', e => { const d = JSON.parse(e.data || '{}'); maybeNotifyMessage(d); onLive(d); });
  es.addEventListener('status', e => onLive(JSON.parse(e.data || '{}')));
  // saldo mudou (venda liberada, comissão, recarga paga, saque)
  es.addEventListener('wallet', () => { refreshWallet(); if (state.view === 'billing') paintBilling(); });
  // venda do indicado aprovada → comissão na carteira
  es.addEventListener('commission', e => {
    const d = JSON.parse(e.data || '{}');
    if (!window.ECNotify) return;
    ECNotify.notify({
      type: 'commission', title: 'Venda Aprovada✅',
      body: 'Sua comissão: ' + fmtBRL(d.amount || 0),
      url: '/app/#/billing', tag: 'com:' + (d.kind || '') + ':' + Date.now()
    });
  });
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
  // Elite Pay — status das cobranças em tempo real (pago/cancelado/subconta)
  es.addEventListener('elitepay', e => {
    const d = JSON.parse(e.data || '{}');
    if (d.status === 'paid' && window.ECNotify) {
      ECNotify.notify({
        type: 'message', title: '💸 Pagamento recebido!',
        body: `${fmtBRL(d.amount || 0)}${d.contactName ? ', ' + d.contactName : ''}`,
        waId: d.waId || null, url: '/app/#/elitepay', tag: 'ep:' + (d.chargeId || '')
      });
    }
    if (state.view === 'elitepay') { epPaintTab(); }
    if (state.view === 'admin') { const p = $('[data-pane="adm-ep"]'); if (p && p.classList.contains('show')) admEpPaint(); }
  });
  // Tracking: vendas atribuídas / sync de campanhas atualizam o painel ao vivo
  es.addEventListener('tracking', () => { if (state.view === 'tracking') trkPaintTab(); });
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
  // Mensagem de OUTRO número conectado: não mexe na conversa aberta; só atualiza
  // o contador do seletor de canal para o atendente saber que chegou algo lá.
  if (d && d.chId && CH_ID && d.chId !== CH_ID) { loadChannels(); return; }
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
    syncTabbarBadge();
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
  pixels: renderPixels, billing: renderBilling, admin: renderAdmin, sms: renderSms,
  integrations: renderIntegrations, webhooks: renderIntegrations, // #/webhooks continua funcionando
  elitepay: renderElitePay, tracking: renderTracking,
  consent: renderConsent, agents: renderAgents, 'agents/perf': renderAgentPerf,
  'agents/logs': renderAgentLogs, schedule: renderSchedule,
  reports: () => { location.hash = '#/dashboard'; }, // aba Relatórios foi absorvida pelo Dashboard
  'templates/new': renderTemplateNew, 'campaigns/new': renderCampaignNew,
  'links/new': renderLinkForm, 'links/edit': renderLinkForm, 'links/stats': renderLinkStats,
  'elitepay/checkout': renderCheckoutBuilder,
  checkouts: renderCheckoutList
};
// qual item da sidebar destacar para cada view (rotas com "/" caem no pai)
const NAV_OF = {
  'templates/new': 'templates', 'campaigns/new': 'campaigns',
  'links/new': 'links', 'links/edit': 'links', 'links/stats': 'links',
  'agents/perf': 'agents', 'agents/logs': 'agents',
  'elitepay/checkout': 'checkouts'
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
  'elitepay/checkout': 'elitepay', checkouts: 'elitepay',
  billing: null, admin: null, logs: null   // sempre acessíveis (donos/config próprios)
};
// O plano do cliente inclui este módulo? (null = sem restrição de plano)
// checkouts pertence ao Elite Pay; integrations cobre webhooks/Nuvemshop.
const VIEW_FEATURE = { checkouts: 'elitepay', webhooks: 'integrations' };
function planHas(view) {
  const f = state.planFeatures;
  if (!f) return true;
  const key = VIEW_FEATURE[view] || view;
  return f[key] !== false;
}

function moduleOfView(v) {
  if (v in VIEW_MODULE) return VIEW_MODULE[v];
  return v;
}
// Esconde do menu lateral os módulos sem permissão de visualizar
// ---------- MENU ENXUTO NO CELULAR ----------
// Num aparelho o menu completo vira uma lista infinita e ninguém acha nada.
// No celular mostramos só o que se usa fora do escritório: atender, consultar
// cadastro, ver compromisso e conferir a conexão. As demais telas continuam
// existindo e acessíveis por link direto (inclusive pelo toque na notificação)
// — elas somem da navegação, não do produto.
//
// Construir campanha, desenhar automação no Flow Builder ou montar checkout são
// trabalhos de tela grande; ficam no navegador do computador.
const MOBILE_VIEWS = new Set([
  'dashboard', 'inbox', 'team', 'schedule', 'contacts',
  'funnel', 'quick', 'billing', 'settings'
]);
// 820px é o mesmo ponto em que a sidebar já vira gaveta (style.css).
const MOBILE_MQ = window.matchMedia('(max-width: 820px)');
function isMobileLayout() { return API.native || MOBILE_MQ.matches; }

function applyNavPermissions() {
  // Assinatura e Admin são do DONO/admin — atendentes nunca veem
  const ownerOnly = new Set(['billing', 'admin']);
  const mobile = isMobileLayout();
  $$('.nav-item[data-view]').forEach(n => {
    const v = n.dataset.view;
    if (mobile && !MOBILE_VIEWS.has(v)) { n.style.display = 'none'; return; }
    if (state.agent && ownerOnly.has(v)) { n.style.display = 'none'; return; }
    if (!planHas(v)) { n.style.display = 'none'; return; }   // fora do plano contratado
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
  // Explica no próprio menu onde foi parar o que não está ali.
  const hint = document.getElementById('nav-hint');
  if (hint) hint.classList.toggle('hidden', !mobile);

  buildTabbar();   // a barra do rodapé espelha o que sobrou visível aqui
}

// ---------- BARRA DE NAVEGAÇÃO DO RODAPÉ (celular) ----------
// No celular a gaveta lateral dá lugar a uma barra fixa embaixo, do jeito que
// se espera de um aplicativo: o polegar alcança sem esticar a mão.
// Cabem quatro destinos; o quinto botão abre uma folha com o restante.
//
// Os ícones são clonados da própria sidebar — assim a barra nunca diverge
// visualmente do menu e não existe um segundo conjunto de ícones para manter.
const TABBAR_VIEWS = ['dashboard', 'inbox', 'contacts', 'schedule'];
const TABBAR_LABEL = {
  dashboard: 'Início', inbox: 'Conversas', contacts: 'Contatos', schedule: 'Agenda',
  team: 'Chat interno', funnel: 'Funil', quick: 'Respostas', billing: 'Assinatura', settings: 'Ajustes'
};

function navItemVisivel(v) {
  const el = document.querySelector(`.sidebar .nav-item[data-view="${v}"]`);
  return !!el && el.style.display !== 'none';
}
function iconeDaView(v) {
  const svg = document.querySelector(`.sidebar .nav-item[data-view="${v}"] svg`);
  return svg ? svg.outerHTML : '';
}

function buildTabbar() {
  const bar = document.getElementById('tabbar');
  if (!bar) return;
  const mobile = isMobileLayout();
  bar.classList.toggle('hidden', !mobile);
  document.body.classList.toggle('has-tabbar', mobile);
  if (!mobile) { toggleMoreSheet(false); return; }

  const principais = TABBAR_VIEWS.filter(navItemVisivel);
  const restantes = [...MOBILE_VIEWS].filter(v => !TABBAR_VIEWS.includes(v) && navItemVisivel(v));

  bar.innerHTML = principais.map(v => `
    <a class="tabbar-item" data-view="${v}" href="#/${v}">
      ${iconeDaView(v)}
      <span>${TABBAR_LABEL[v] || v}</span>
      ${v === 'inbox' ? '<b class="tabbar-dot hidden" id="tabbar-unread"></b>' : ''}
    </a>`).join('') + (restantes.length ? `
    <button class="tabbar-item" id="tabbar-more" onclick="toggleMoreSheet()" aria-haspopup="dialog">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      <span>Mais</span>
    </button>` : '');

  const folha = document.getElementById('more-sheet');
  if (folha) {
    folha.innerHTML = `
      <div class="sheet-grip"></div>
      <h3>Mais</h3>
      <div class="sheet-grid">
        ${restantes.map(v => `
          <a class="sheet-item" href="#/${v}" onclick="toggleMoreSheet(false)">
            ${iconeDaView(v)}<span>${TABBAR_LABEL[v] || TITLES[v] || v}</span>
          </a>`).join('')}
      </div>`;
  }
  markTabbarActive();
  syncTabbarBadge();
}

// Marca o destino atual. Telas que não estão na barra (nem na folha) deixam
// tudo apagado — é honesto: o usuário chegou ali por um link, não pela barra.
function markTabbarActive() {
  const atual = state.view;
  $$('#tabbar .tabbar-item[data-view]').forEach(a => {
    a.classList.toggle('on', a.dataset.view === atual);
  });
  const more = document.getElementById('tabbar-more');
  if (more) {
    const naFolha = [...MOBILE_VIEWS].some(v => v === atual && !TABBAR_VIEWS.includes(v));
    more.classList.toggle('on', naFolha);
  }
}

// Espelha o contador de não lidas da sidebar na barra de baixo.
function syncTabbarBadge() {
  const origem = $('#badge-unread'), destino = $('#tabbar-unread');
  if (!destino) return;
  const tem = origem && !origem.classList.contains('hidden');
  destino.textContent = tem ? origem.textContent : '';
  destino.classList.toggle('hidden', !tem);
}

// ---------- CARTEIRA NO CABEÇALHO (celular) ----------
// Saldo sempre à vista e depósito a um toque. No computador o saldo já mora
// na tela de Assinatura, que está sempre no menu — aqui ele resolve a distância
// extra que o celular impõe.
let WALLET = { balance: 0, deposito: { min: 100, max: 0 } };

async function refreshWallet() {
  const caixa = document.getElementById('tb-wallet');
  if (!caixa) return;
  // Atendente não tem carteira própria: a da empresa não é assunto dele.
  if (state.agent || !isMobileLayout()) { caixa.classList.add('hidden'); return; }
  try {
    WALLET = await api('/wallet/summary');
    const val = document.getElementById('tb-wallet-val');
    if (val) val.textContent = fmtBRL(WALLET.balance);
    caixa.classList.remove('hidden');
  } catch { caixa.classList.add('hidden'); }
}

// Pop-up de depósito. A faixa vem do Admin SaaS; validamos aqui só para dar
// resposta imediata — quem decide de verdade é o servidor.
function depositModal() {
  const min = WALLET.deposito.min, max = WALLET.deposito.max;
  const faixa = `Mínimo ${fmtBRL(min)}${max ? ` · máximo ${fmtBRL(max)}` : ''}`;
  // Atalhos partindo do mínimo, dobrando, sem passar do teto.
  const sugestoes = [min, min * 2, min * 5, min * 10]
    .filter(v => !max || v <= max)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 4);

  openModal(`
    <h2 style="margin:0 0 6px">${ico('plus')} Depositar na carteira</h2>
    <p class="muted" style="font-size:13px;margin:0 0 14px">
      O saldo paga assinatura, conexões extras e disparos. Pagamento por Pix, confirmação automática.
      <br><b>${faixa}</b>
    </p>
    <label>Valor (R$)<input id="dep-val" inputmode="decimal" placeholder="${(min / 100).toFixed(2)}" autocomplete="off"></label>
    <div class="row" style="gap:7px;margin-top:9px">
      ${sugestoes.map(v => `<button class="btn small no-grow" onclick="$('#dep-val').value='${(v / 100).toFixed(2)}'">${fmtBRL(v)}</button>`).join('')}
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn no-grow" onclick="closeModal()">Cancelar</button>
      <button class="btn primary no-grow" onclick="doDeposit(this)">${ico('zap', 14)} Gerar Pix</button>
    </div>
    <div id="dep-pix"></div>`);
}

async function doDeposit(btn) {
  const bruto = String($('#dep-val').value || '').replace(',', '.');
  const cents = Math.round(Number(bruto) * 100);
  if (!cents || cents < 0) return toast('Informe um valor', 'error');
  if (cents < WALLET.deposito.min) return toast(`Depósito mínimo: ${fmtBRL(WALLET.deposito.min)}`, 'error');
  if (WALLET.deposito.max && cents > WALLET.deposito.max) {
    return toast(`Depósito máximo: ${fmtBRL(WALLET.deposito.max)}`, 'error');
  }
  btn.disabled = true;
  try {
    const r = await api('/billing/topup', { body: { amount: bruto } });
    // Mostra o Pix na própria janela: fechar e procurar a tela de Assinatura
    // no meio do pagamento é o caminho mais curto para desistir.
    $('#dep-pix').innerHTML = payBoxHtml(r.charge);
    toast('Pix gerado — pague para creditar o saldo');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function toggleMoreSheet(force) {
  const folha = document.getElementById('more-sheet');
  const fundo = document.getElementById('more-back');
  if (!folha || !fundo) return;
  const abrir = force === undefined ? folha.classList.contains('hidden') : !!force;
  folha.classList.toggle('hidden', !abrir);
  fundo.classList.toggle('hidden', !abrir);
}

// Girar o aparelho ou redimensionar a janela cruza o limite dos 820px:
// o menu se reajusta na hora, sem precisar recarregar.
MOBILE_MQ.addEventListener('change', () => {
  if (!state.user) return;
  applyNavPermissions();
  refreshWallet();   // o saldo no topo só existe no celular
});

// ---------- menu lateral em gaveta (celular) ----------
// No celular a sidebar sai do fluxo e desliza por cima, devolvendo a largura
// inteira para o conteúdo. Fecha ao navegar, no backdrop ou com Esc.
function toggleNav(force) {
  const app = document.getElementById('app'); if (!app) return;
  const abrir = force === undefined ? !app.classList.contains('nav-open') : !!force;
  app.classList.toggle('nav-open', abrir);
}
document.addEventListener('click', e => {
  if (e.target.closest('.sidebar .nav-item')) toggleNav(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleNav(false); });

window.addEventListener('hashchange', route);
function route() {
  if (!TOKEN) return;
  if (window._fbMove) cleanupBuilder();  // sai do canvas do Flow Builder
  // o hash pode trazer query (#/elitepay/checkout?c=<id>) — ela NÃO faz parte
  // do nome da view; sem separar, a rota não é encontrada e cai no dashboard.
  const v = ((location.hash || '#/dashboard').replace('#/', '') || 'dashboard').split('?')[0];
  let target = views[v] ? v : 'dashboard';
  // guard de PLANO: digitar a URL de um módulo fora do plano não entra
  // (o backend também recusa com 402; aqui é só para não abrir uma tela vazia)
  if (!planHas(target.split('/')[0])) {
    toast('Esse recurso não faz parte do seu plano. Faça upgrade em Assinatura.', 'error');
    location.hash = '#/billing';
    return;
  }
  // guard de permissão no front (o backend valida de novo em cada rota)
  const mod = moduleOfView(target);
  if (mod !== null && !can(mod, 'view')) {
    const home = can('dashboard', 'view') ? 'dashboard' : (state.allowedViews && state.allowedViews[0]) || 'dashboard';
    if (target !== home) { toast('Você não tem acesso a esse módulo', 'error'); location.hash = '#/' + home; return; }
    target = home;
  }
  state.view = target;
  // EliteBuilder é uma página FOCADA: esconde a sidebar e o topo do app
  const appEl = document.getElementById('app');
  if (appEl) appEl.classList.toggle('builder-mode', target === 'elitepay/checkout');
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
      ${(() => {
        // Os atalhos seguem o mesmo recorte do menu: no celular não faz sentido
        // oferecer Campanha ou Flow Builder aqui se eles não estão na navegação.
        const atalhos = [
          ['inbox', 'message', 'Conversas'],
          ['contacts', 'users', 'Novo contato'],
          ['schedule', 'calendar', 'Agendamento'],
          ['campaigns', 'megaphone', 'Campanha'],
          ['flows', 'flow', 'Automação'],
          ['links', 'link', 'Link rastreável']
        ];
        const mobile = isMobileLayout();
        return atalhos
          .filter(([v]) => (mobile ? MOBILE_VIEWS.has(v) : v !== 'schedule'))
          .map(([v, icone, rotulo]) =>
            `<a class="tile" href="#/${v}"><span class="tile-ic">${ico(icone, 19)}</span><b>${rotulo}</b></a>`)
          .join('');
      })()}
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
    const sl = d.sales || { todayCount: 0, todayValue: 0, totalCount: 0, totalValue: 0 };
    $('#dash').innerHTML = `
      <div class="dash-kpis">
        <div class="stat"><span class="stat-ico">${ico('users', 17)}</span><div class="num">${fmtN(d.contacts)}</div><div class="lbl">Contatos</div></div>
        <a class="stat" href="#/elitepay"><span class="stat-ico">${ico('zap', 17)}</span><div class="num">${fmtBRL(sl.todayValue)}</div><div class="lbl">Vendas hoje${sl.todayCount ? ` · ${fmtN(sl.todayCount)} venda${sl.todayCount > 1 ? 's' : ''}` : ''}</div></a>
        <a class="stat" href="#/elitepay"><span class="stat-ico">${ico('card', 17)}</span><div class="num">${fmtBRL(sl.totalValue)}</div><div class="lbl">Total em vendas</div></a>
        <a class="stat" href="#/elitepay"><span class="stat-ico">${ico('activity', 17)}</span><div class="num">${fmtN(sl.totalCount)}</div><div class="lbl">Quantidade de vendas</div></a>
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
          <h2>${ico('columns')} Pipeline</h2>
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
          <h2 style="margin:0;flex:1">${ico('target')} Mapa de leads. Brasil</h2>
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
      </div>
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
      ${dashScheduleCard(d.schedule)}
      ${d.agents ? dashAgentsCard(d.agents) : ''}`;
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
    geoBindTooltip();
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// Tooltip que segue o cursor sobre o mapa: nome do estado + nº de leads.
// Custom (não o <title> nativo) para aparecer na hora e casar com o tema.
function geoBindTooltip() {
  const map = $('.geo-map'); if (!map) return;
  const svg = map.querySelector('svg'), tip = map.querySelector('#geo-tip');
  if (!svg || !tip) return;
  let atual = null;
  svg.addEventListener('mousemove', e => {
    const g = e.target.closest('.geo-tile');
    if (!g) { tip.classList.remove('on'); atual = null; return; }
    if (g !== atual) {
      atual = g;
      const n = +g.getAttribute('data-n');
      tip.innerHTML = `<b>${esc(g.getAttribute('data-name'))}</b><i>${fmtN(n)} lead${n === 1 ? '' : 's'}</i>`;
    }
    const r = map.getBoundingClientRect();
    // fixa dentro da largura do mapa para não vazar nas bordas
    const x = Math.max(46, Math.min(r.width - 46, e.clientX - r.left));
    tip.style.left = x + 'px';
    tip.style.top = (e.clientY - r.top) + 'px';
    tip.classList.add('on');
  });
  svg.addEventListener('mouseleave', () => { tip.classList.remove('on'); atual = null; });
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
          <button class="btn small" id="tool-pay" onclick="chatChargeModal('${c.waId}')">${ico('pix', 13)} Cobrança</button>
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
      ? 'Contato em opt-out, reative para voltar a enviar'
      : locked
        ? (finished ? 'Atendimento finalizado, reabra para enviar mensagens' : 'Janela de 24h expirada, envie um Template para reabrir')
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
      <div><b>Contato em opt-out.</b> Ele pediu para não receber mais mensagens, então <b>nenhum envio é permitido</b>, nem template, nem campanha. Reative para voltar a conversar.</div>
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
        <button class="btn no-grow" onclick="openExternal(API.api('/contacts/export?token=' + TOKEN))" title="CSV com telefones no padrão E.164 aceito pela API">${ico('download-circle', 14)} Exportar CSV</button>
        <button class="btn primary no-grow" onclick="newContactModal()">${ico('plus', 14)} Novo contato</button>
      </div>
      <div class="card">
        <div class="ct-tools">
          <input id="ct-search" placeholder="Buscar por nome, telefone ou tag..." oninput="loadContactsTable()">
          <div id="ct-scope"></div>
        </div>
        <div id="ct-table"></div>
      </div>
    </div>`;
  loadContactsTable();
}

// ---------------------------------------------------------------------------
// FILTRO POR CONTA (contatos e funil)
// Sem filtro escolhido, mostra TODOS os contatos de todas as contas. Escolhendo
// uma conta, a lista fica só com os leads daquele número, que é o que interessa
// antes de disparar, editar ou excluir em massa.
// ---------------------------------------------------------------------------
let CT_SCOPE = localStorage.getItem('ec_ct_scope') || 'all';

function scopeQuery() { return CT_SCOPE && CT_SCOPE !== 'all' ? '&ch=' + encodeURIComponent(CT_SCOPE) : '&ch=all'; }

function paintScopePicker(boxId, canais, total, onPick) {
  const box = document.getElementById(boxId); if (!box) return;
  if (!canais || canais.length < 2) { box.innerHTML = ''; return; }   // uma conta só: filtro não faz sentido
  box.innerHTML = `
    <div class="scope-pick">
      <span class="scope-lbl">${ico('smartphone', 13)} Conta</span>
      <button class="scope-btn ${CT_SCOPE === 'all' ? 'on' : ''}" onclick="${onPick}('all')">
        Todas <b>${fmtN(total)}</b></button>
      ${canais.map(c => `
        <button class="scope-btn ${CT_SCOPE === c.id ? 'on' : ''}" onclick="${onPick}('${c.id}')" title="${c.connected ? 'Conectado' : 'Número não conectado'}">
          <i class="ch-dot ${c.connected ? 'on' : 'off'}"></i>${esc(c.label)} <b>${fmtN(c.count)}</b></button>`).join('')}
    </div>`;
}

function setContactScope(id) {
  CT_SCOPE = id;
  localStorage.setItem('ec_ct_scope', id);
  loadContactsTable();
}
function setFunnelScope(id) {
  CT_SCOPE = id;
  localStorage.setItem('ec_ct_scope', id);
  renderFunnel();
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
    const d = await api('/contacts?search=' + q + scopeQuery());
    const contacts = d.contacts || [];
    paintScopePicker('ct-scope', d.channels, d.total, 'setContactScope');
    const stages = state.settings?.stages || [];
    const varios = (d.channels || []).length > 1;
    $('#ct-table').innerHTML = contacts.length ? `
      <table><thead><tr><th>Contato</th>${varios ? '<th>Conta</th>' : ''}<th>Etapa</th><th>Tags</th><th>Última atividade</th><th></th></tr></thead>
      <tbody>${contacts.map(c => `
        <tr>
          <td><div class="cell-user">${avatarHtml(c, 'sm')}<div><b>${esc(c.name)}</b>${sourceBadge(c)}<div class="muted" style="font-size:11.5px">+${esc(c.waId)}</div></div></div></td>
          ${varios ? `<td><span class="ch-tag">${esc(c.chLabel || '')}</span></td>` : ''}
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
      <div class="page-head row">
        <div style="flex:1"><h1>Pipeline</h1><p>Arraste os cards entre as etapas</p></div>
        <button class="btn no-grow" onclick="togglePipeCfg()" id="pipe-cfg-btn">${ico('gear', 14)} Configurar etapas</button>
      </div>
      <div id="pipe-cfg"></div>
      <div id="fn-scope"></div>
      <div class="kanban" id="kanban"></div>
    </div>`;
  try {
    const d = await api('/contacts?ch=' + (CT_SCOPE || 'all'));
    const contacts = d.contacts || [];
    paintScopePicker('fn-scope', d.channels, d.total, 'setFunnelScope');
    const varios = (d.channels || []).length > 1;
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
              ${varios && c.chLabel ? `<span class="ch-tag">${esc(c.chLabel)}</span>` : ''}
              ${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('');
    wireKanban();
    paintPipeCfg();   // o quadro foi repintado; o editor mora nesta aba
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------------------------------------------------------------------
// EDITOR DE ETAPAS DO PIPELINE
//
// Antes as etapas eram um textarea "uma por linha": trocar uma letra num nome
// já existente equivalia a apagar a etapa e criar outra, e todo contato que
// estava lá sumia do quadro. Agora cada etapa é uma linha com controles, e o
// que mudou vai para o servidor como um mapa antigo->novo, que migra os
// contatos, a etapa padrão do cadastro e os nós "mover etapa" das automações.
// ---------------------------------------------------------------------------
let pipeCfg = null;   // { open, orig: [...], list: [{ id, nome, de }] }

function togglePipeCfg() {
  if (pipeCfg && pipeCfg.open) { pipeCfg.open = false; paintPipeCfg(); return; }
  const stages = (state.settings && state.settings.stages) || [];
  pipeCfg = {
    open: true,
    orig: stages.slice(),
    // `de` guarda o nome com que a etapa chegou: é o que permite detectar rename
    list: stages.map((s, i) => ({ id: 'sg' + i + '_' + Date.now(), nome: s, de: s }))
  };
  paintPipeCfg();
}

function paintPipeCfg() {
  const box = $('#pipe-cfg');
  const btn = $('#pipe-cfg-btn');
  if (!box) return;
  if (!pipeCfg || !pipeCfg.open) {
    box.innerHTML = '';
    if (btn) btn.innerHTML = ico('gear', 14) + ' Configurar etapas';
    return;
  }
  if (btn) btn.innerHTML = ico('x', 14) + ' Fechar configuração';

  const n = pipeCfg.list.length;
  box.innerHTML = `
    <div class="card pipe-cfg">
      <h2>${ico('columns')} Etapas do Pipeline</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        A ordem aqui é a ordem das colunas. Ao renomear uma etapa, os contatos vão
        junto; ao remover, eles caem na primeira etapa da lista.
      </p>
      <div class="pipe-rows">
        ${pipeCfg.list.map((s, i) => `
          <div class="pipe-row">
            <span class="pipe-num">${i + 1}</span>
            <input value="${esc(s.nome)}" maxlength="40" placeholder="Nome da etapa"
                   oninput="pipeSet('${s.id}', this.value)">
            <button class="btn small no-grow" title="Subir" ${i === 0 ? 'disabled' : ''}
                    onclick="pipeMove('${s.id}', -1)">↑</button>
            <button class="btn small no-grow" title="Descer" ${i === n - 1 ? 'disabled' : ''}
                    onclick="pipeMove('${s.id}', 1)">↓</button>
            <button class="btn small danger no-grow" title="Remover" ${n === 1 ? 'disabled' : ''}
                    onclick="pipeDel('${s.id}')">${ico('trash', 13)}</button>
          </div>`).join('')}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn no-grow" onclick="pipeAdd()">${ico('plus', 14)} Adicionar etapa</button>
        <div style="flex:1"></div>
        <button class="btn no-grow" onclick="togglePipeCfg()">Cancelar</button>
        <button class="btn primary no-grow" onclick="pipeSave()">${ico('save', 14)} Salvar etapas</button>
      </div>
    </div>`;
}

function pipeFind(id) { return pipeCfg.list.find(s => s.id === id); }

// O input não é repintado a cada tecla: o cursor pularia para o fim.
function pipeSet(id, v) { const s = pipeFind(id); if (s) s.nome = v; }

function pipeAdd() {
  pipeCfg.list.push({ id: 'sg_' + Date.now(), nome: '', de: '' });
  paintPipeCfg();
  const ins = $$('.pipe-row input');
  if (ins.length) ins[ins.length - 1].focus();
}

function pipeMove(id, dir) {
  const i = pipeCfg.list.findIndex(s => s.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pipeCfg.list.length) return;
  const [s] = pipeCfg.list.splice(i, 1);
  pipeCfg.list.splice(j, 0, s);
  paintPipeCfg();
}

function pipeDel(id) {
  if (pipeCfg.list.length <= 1) return;   // o pipeline não pode ficar sem coluna
  const s = pipeFind(id);
  const usados = pipeContagem(s && s.de);
  const aviso = usados
    ? `Remover "${s.de}"? Os ${usados} contato(s) dessa etapa vão para a primeira da lista.`
    : 'Remover esta etapa?';
  if (s && s.de && !confirm(aviso)) return;
  pipeCfg.list = pipeCfg.list.filter(x => x.id !== id);
  paintPipeCfg();
}

// Quantos cards estão hoje naquela coluna (já pintados no quadro).
function pipeContagem(nome) {
  if (!nome) return 0;
  const col = $$('.kcol').find(c => c.dataset.stage === nome);
  return col ? col.querySelectorAll('.kcard').length : 0;
}

async function pipeSave() {
  const list = pipeCfg.list.map(s => ({ ...s, nome: s.nome.trim() })).filter(s => s.nome);
  if (!list.length) return toast('O Pipeline precisa de pelo menos uma etapa.', 'error');
  const nomes = list.map(s => s.nome);
  const dup = nomes.find((x, i) => nomes.indexOf(x) !== i);
  if (dup) return toast('Etapa repetida: "' + dup + '".', 'error');

  // só renomeadas entram no mapa; as removidas o servidor realoca sozinho
  const stageMap = {};
  for (const s of list) if (s.de && s.de !== s.nome) stageMap[s.de] = s.nome;

  try {
    await api('/settings', { method: 'PUT', body: { stages: nomes, stageMap } });
    // a rota responde só { ok: true } — o estado local é atualizado aqui, com a
    // mesma higiene que o servidor aplicou (aparar, sem vazios, sem repetidos).
    state.settings = { ...(state.settings || {}), stages: nomes };
    pipeCfg.open = false;
    toast('Etapas salvas');
    renderFunnel();
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
        <div style="flex:1"><h1>Modelos (Templates)</h1><p>Mensagens aprovadas pela Meta, obrigatórias fora da janela de 24h</p></div>
        <button class="btn no-grow" onclick="syncTemplates()">${ico('refresh', 14)} Sincronizar</button>
        <a class="btn primary no-grow" href="#/templates/new">${ico('plus', 14)} Criar modelo</a>
      </div>
      <div class="card" id="tpl-table">${skel(4)}</div>
    </div>`;
  paintTemplates(false);
}

async function paintTemplates(sync) {
  try {
    const d = await api('/templates' + (sync ? '?sync=1' : ''));
    const templates = d.templates || [];
    const sel = d.selected || {};
    $('#tpl-table').innerHTML = templates.length ? `
      <table><thead><tr><th>Nome</th><th>Uso no Elite Pay</th><th>Idioma</th><th>Status</th><th>Corpo</th><th></th></tr></thead>
      <tbody>${templates.map(t => `
        <tr>
          <td><b>${esc(t.name)}</b><div class="muted" style="font-size:11px">${esc(t.category || '')}</div></td>
          <td>${ecSelect('tplrole-' + t.name, [
            { value: '', label: 'Campanha comum' },
            { value: 'cobranca', label: 'Cobrança' },
            { value: 'confirmacao', label: 'Confirmação de pagamento' }
          ], t.purpose || '', `setTplRole('${esc(t.name)}',val)`)}
          ${t.purpose && sel[t.purpose] === t.name ? '<span class="pill done" style="margin-top:5px">em uso</span>' : ''}</td>
          <td>${esc(t.language || '')}</td>
          <td><span class="pill ${esc(t.status)}">${esc(t.status)}</span>${t.rejected_reason && t.rejected_reason !== 'NONE' ? `<div class="muted" style="font-size:11px">${esc(t.rejected_reason)}</div>` : ''}</td>
          <td class="muted" style="max-width:280px;font-size:12.5px">${esc(tplBody(t)).slice(0, 120)}</td>
          <td><button class="btn small danger" title="Excluir" onclick="removeTemplate('${esc(t.name)}')">${ico('trash', 14)}</button></td>
        </tr>`).join('')}</tbody></table>
      <p class="hint" style="margin-top:12px;text-align:left">${ico('info', 12)}
        Um modelo é <b>cobrança</b> ou <b>confirmação de pagamento</b>, nunca os dois.
        Sem papel, ele é um modelo comum de campanha. Com mais de um do mesmo papel,
        você escolhe qual é enviado em <a href="#/elitepay">Elite Pay → Mensagens</a>.</p>`
      : '<p class="muted">Nenhum modelo. Clique em Sincronizar (exige WABA ID + token) ou crie um novo.</p>';
  } catch (e) {
    $('#tpl-table').innerHTML = `<p class="err">${esc(e.message)}</p><p class="muted">Verifique WABA ID e Access Token em Configurações.</p>`;
  }
}

async function syncTemplates() { toast('Sincronizando com a Meta...'); paintTemplates(true); }

// Troca o papel de um modelo já criado (cobrança x confirmação x nenhum).
async function setTplRole(name, purpose) {
  try {
    await api(`/templates/${encodeURIComponent(name)}/role`, { method: 'PUT', body: { purpose } });
    toast(purpose ? `"${name}" agora é modelo de ${purpose === 'cobranca' ? 'cobrança' : 'confirmação de pagamento'}` : `"${name}" voltou a ser modelo comum`);
    paintTemplates();
  } catch (e) { toast(e.message, 'error'); paintTemplates(); }
}

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
        <span class="wa-av">${state.wa && state.wa.profilePictureUrl ? avatarImg(state.wa.profilePictureUrl, '', waInitials(name)) : waInitials(name)}</span>
        <div class="wa-top-info"><b>${esc(name)} <svg class="wa-verified" viewBox="0 0 24 24" width="13" height="13" fill="#00A884"><path d="M12 1.8 14.8 4l3.5-.4 1 3.4 3 1.8-1.4 3.2 1.4 3.2-3 1.8-1 3.4-3.5-.4L12 22.2 9.2 20l-3.5.4-1-3.4-3-1.8L3.1 12 1.7 8.8l3-1.8 1-3.4L9.2 4 12 1.8z"/><path d="m8.6 12.2 2.3 2.3 4.6-4.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></b><span>conta comercial</span></div>
        <svg class="wa-hicon" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.9.36 1.79.7 2.63a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.45-1.27a2 2 0 0 1 2.11-.45c.84.34 1.73.57 2.63.7A2 2 0 0 1 22 16.92z"/></svg>
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
    ${bVars ? Array.from({ length: bVars }, (_, i) => {
      // Com um papel marcado, o rótulo mostra o que a variável significa de fato.
      const rv = (TPL_ROLE_INFO[tplRole()] || {}).vars;
      const lbl = rv && rv[i] ? ` · ${esc(rv[i][0])}` : '';
      const ph = (rv && rv[i] ? rv[i][1] : ['Maria', '20% OFF', 'sexta-feira', 'R$ 97'][i]) || 'valor ' + (i + 1);
      return `<label style="margin-bottom:6px">Corpo · {{${i + 1}}}${lbl}<input value="${esc(tplEx.body[i] || '')}" oninput="tplEx.body[${i}]=this.value;renderTplPreview()" placeholder="ex.: ${esc(ph)}"></label>`;
    }).join('') : ''}
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
    box.innerHTML = `<label style="margin-top:9px">Texto do cabeçalho, aceita 1 variável {{1}}<input id="nt-header" maxlength="60" oninput="tplHeader.text=this.value;renderTplVarExamples();renderTplPreview()" value="${esc(tplHeader.text)}" placeholder="Oferta especial para {{1}}! 🎉"></label>
      <div class="row" style="margin-top:7px"><button type="button" class="btn small ghost no-grow" onclick="tplInsertVar('header')">${ico('plus', 12)} Inserir variável {{1}}</button></div>`;
  } else if (t === 'IMAGE' || t === 'VIDEO' || t === 'DOCUMENT') {
    const lbl = { IMAGE: 'Imagem (JPG/PNG)', VIDEO: 'Vídeo (MP4)', DOCUMENT: 'PDF' }[t];
    box.innerHTML = `
      <div class="hd-media" style="margin-top:9px">
        <input type="file" id="nt-hd-file" accept="${TPL_HDR_ACCEPT[t]}" hidden onchange="tplHdrFile(this)">
        <button class="btn no-grow" onclick="$('#nt-hd-file').click()">${ico('image', 14)} Escolher ${lbl}</button>
        <span class="muted" id="nt-hd-status" style="font-size:12px">${tplHeader.filename
          ? (tplHeader.handle ? `✓ ${esc(tplHeader.filename)}, exemplo enviado à Meta` : esc(tplHeader.filename))
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
      if (st) st.textContent = `✓ ${f.name}, exemplo enviado à Meta`;
    } catch (e) {
      if (st) st.textContent = `⚠ ${f.name}, falha no envio: ${e.message}`;
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
      <a class="btn no-grow" href="#/templates">${ico('arrowleft', 14)} Voltar</a>
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
          <div class="role-box">
            <div class="role-head">${ico('pix', 13)} Uso no Elite Pay <span class="role-hint">escolha um, ou nenhum, para campanha comum</span></div>
            <label class="chk"><input type="checkbox" id="nt-role-cobranca" onchange="tplRolePick('cobranca')">
              É um modelo de <b style="margin:0 4px">Cobrança</b></label>
            <label class="chk" style="margin-top:9px"><input type="checkbox" id="nt-role-confirmacao" onchange="tplRolePick('confirmacao')">
              É um modelo de <b style="margin:0 4px">Confirmação de pagamento</b></label>
            <div id="nt-role-hint" class="var-ex-box hidden" style="margin-top:11px"></div>
          </div>
        </div>
        <div class="card">
          <label>Cabeçalho${ecSelect('nt-htype', TPL_HDR_TYPES, 'NONE', 'tplHdrTypeChanged(val)')}</label>
          <div id="nt-hd-extra"></div>
          <label style="margin-top:11px">Corpo (use {{1}}, {{2}}… para variáveis, em sequência)<textarea id="nt-body" rows="4" oninput="renderTplVarExamples();renderTplPreview()" placeholder="Olá {{1}}! Temos uma condição exclusiva para você…"></textarea></label>
          <div class="row" style="margin-top:7px"><button type="button" class="btn small ghost no-grow" onclick="tplInsertVar('body')">${ico('plus', 12)} Inserir variável</button></div>
          <div id="nt-var-ex" style="margin-top:11px"></div>
          <label style="margin-top:11px">Rodapé, opcional<input id="nt-footer" maxlength="60" oninput="renderTplPreview()" placeholder="Responda SAIR para não receber mais"></label>
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

// ---------------------------------------------------------------------------
// PAPEL DO MODELO — cobrança OU confirmação de pagamento, nunca os dois.
// Sem nenhum marcado, é um modelo comum (campanha).
// ---------------------------------------------------------------------------
const TPL_ROLE_INFO = {
  cobranca: {
    label: 'Cobrança',
    desc: 'Enviado quando você gera uma cobrança no Elite Pay, funciona <b>fora da janela de 24h</b>.',
    vars: [
      ['nome do cliente', 'Maria Silva'],
      ['valor da cobrança', 'R$ 149,90'],
      ['link de pagamento', 'https://pay.elitechat.com.br/abc123'],
      ['Pix copia e cola', '00020126580014BR.GOV.BCB.PIX...'],
      ['descrição / produto', 'Plano Premium'],
      ['vencimento', '31/12/2026']
    ]
  },
  confirmacao: {
    label: 'Confirmação de pagamento',
    desc: 'Enviado automaticamente assim que o pagamento é confirmado, também <b>fora da janela de 24h</b>.',
    vars: [
      ['nome do cliente', 'Maria Silva'],
      ['valor pago', 'R$ 149,90'],
      ['descrição / produto', 'Plano Premium'],
      ['data e hora', '23/07/2026 14:32'],
      ['forma de pagamento', 'Pix'],
      ['código da transação', 'EP-7F3A21']
    ]
  }
};

function tplRole() {
  for (const r of ['cobranca', 'confirmacao']) {
    const el = $('#nt-role-' + r);
    if (el && el.checked) return r;
  }
  return '';
}

// Exclusividade: marcar um desmarca o outro.
function tplRolePick(role) {
  const outro = role === 'cobranca' ? 'confirmacao' : 'cobranca';
  const a = $('#nt-role-' + role), b = $('#nt-role-' + outro);
  if (a && a.checked && b) b.checked = false;
  tplRoleHint();
}

function tplRoleHint() {
  const box = $('#nt-role-hint'); if (!box) return;
  const role = tplRole();
  box.classList.toggle('hidden', !role);
  if (!role) return;
  const info = TPL_ROLE_INFO[role];
  box.innerHTML = `
    <p class="muted" style="font-size:11.5px;margin:0"><b>${esc(info.label)}:</b> ${info.desc}
      Clique numa variável para inserir no corpo, elas são preenchidas automaticamente no envio.</p>
    <div class="var-chips">
      ${info.vars.map(([lbl], i) => `<button type="button" class="var-chip" onclick="tplInsertVar(${i + 1})">
        <b>{{${i + 1}}}</b> ${esc(lbl)}</button>`).join('')}
    </div>
    <p class="muted" style="font-size:11px;margin:8px 0 0">Use as variáveis em ordem, sem pular números, é regra da Meta para aprovar o modelo.</p>`;
}

// Insere {{n}} no corpo e já preenche o exemplo daquela variável.
function tplInsertVar(n) {
  const ta = $('#nt-body'); if (!ta) return;
  const tag = `{{${n}}}`;
  const p = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
  ta.value = ta.value.slice(0, p) + tag + ta.value.slice(ta.selectionEnd != null ? ta.selectionEnd : p);
  const pos = p + tag.length;
  ta.focus(); ta.setSelectionRange(pos, pos);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  // já preenche o exemplo daquela variável — a Meta exige um para cada
  const info = TPL_ROLE_INFO[tplRole()];
  const ex = info && info.vars[n - 1] && info.vars[n - 1][1];
  if (ex && !(tplEx.body[n - 1] || '').trim()) {
    tplEx.body[n - 1] = ex;
    renderTplVarExamples();
    renderTplPreview();
  }
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
        buttons,
        purpose: tplRole()   // '' | 'cobranca' | 'confirmacao'
      }
    });
    const papel = TPL_ROLE_INFO[tplRole()];
    toast(papel ? `Modelo enviado à Meta e marcado como ${papel.label}!` : 'Modelo enviado para aprovação da Meta!');
    location.hash = '#/templates';
  } catch (e) { toast(e.message + (e.meta && e.meta.error_user_msg ? ', ' + e.meta.error_user_msg : ''), 'error'); }
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
      : '<div class="card"><p class="muted">Nenhum evento ainda. Configure a Callback URL no painel da Meta e clique em "Verificar e salvar", a tentativa aparecerá aqui.</p></div>';
  } catch (e) { $('#log-list').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------- configurações ----------
async function renderSettings() {
  let cfg = {};
  try { cfg = await api('/settings'); state.settings = cfg.settings; state.wa = cfg.wa; } catch (e) { return toast(e.message, 'error'); }
  const s = cfg.settings || {};
  const w = cfg.wa || {};
  // A configuração da PLATAFORMA (app da Meta, webhook, Meta Ads) e a conexão
  // manual vivem no Admin SaaS, aba Plataforma. Esta tela é a do cliente.
  const isAdmin = cfg.kind === 'admin';

  const connCard = w.connected ? `
      <div class="card">
        <h2>${waLogo(18, '#25D366')} WhatsApp conectado</h2>
        <div class="conn-id">
          <div class="pf-avatar sm" id="conn-photo">${w.profilePictureUrl ? avatarImg(w.profilePictureUrl, '', waInitials(w.verifiedName || state.user)) : waInitials(w.verifiedName || state.user)}</div>
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
        <div class="wa-hero-ic">${waLogo(40)}</div>
        <h2 style="justify-content:center">Conecte seu WhatsApp</h2>
        <p class="muted" style="max-width:480px;margin:6px auto 18px;text-align:center">
          Clique no botão abaixo e siga o cadastro oficial da Meta na janela que vai abrir.
          Número, conta e webhooks são configurados <b>automaticamente</b>, você não precisa copiar nenhum ID ou token.
        </p>
        <button class="btn primary lg" onclick="connectWhatsApp()">${waLogo(18)} Conectar WhatsApp</button>
        <p class="hint" style="margin-top:12px">Embedded Signup oficial · WhatsApp Business Platform (Cloud API ${esc(s.graphVersion || 'v25.0')})</p>
      </div>`;


  $('#view').innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Configurações</h1><p>${isAdmin ? 'Conexão do WhatsApp, plataforma e administração' : 'Conexão do WhatsApp e preferências'}</p></div>

      <div class="tabs">
        <button class="active" data-tab="contas" onclick="showSettingsTab('contas')">${ico('smartphone', 14)} Contas de WhatsApp</button>
        <button data-tab="conexao" onclick="showSettingsTab('conexao')">Conexão & API</button>
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
            <p class="muted" style="margin:0;font-size:13px">Monte a mensagem e as notas enviadas ao cliente quando o atendimento for finalizado, na aba <b>Finalização</b>.</p></div>
          <span class="lc-arrow">${ico('arrowright', 18)}</span>
        </a>
      </div>

      <div class="tabpane show" data-pane="contas">
      ${channelsCard()}
      </div>

      <div class="tabpane" data-pane="conexao">
      ${connCard}
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
        <p class="muted" style="font-size:11.5px;margin:10px 0 0">${ico('shield', 12)} Sobre fotos de contatos: a Meta não expõe a foto de perfil dos seus clientes pela API oficial (privacidade), por isso os avatares deles usam iniciais. A foto do <b>seu</b> perfil conectado aparece normalmente.</p>
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
      <div class="card" id="appearance-card">${renderThemeSettings()}</div>
      <div class="card" id="notif-card">${renderNotifSettings()}</div>

      <a class="card link-card" href="#/pixels">
        <span class="lc-ic">${ico('target', 22)}</span>
        <div style="flex:1"><h2 style="margin:0 0 3px">Pixels &amp; rastreamento</h2>
          <p class="muted" style="margin:0;font-size:13px">Configure os pixels da Meta, Google e TikTok, a Conversions API e o domínio dos links, agora em página própria.</p></div>
        <span class="lc-arrow">${ico('arrowright', 18)}</span>
      </a>

      <a class="card link-card" href="#/funnel">
        <div class="lc-ico">${ico('columns')}</div>
        <div style="flex:1"><h2 style="margin:0 0 3px">Etapas do Pipeline</h2>
          <p class="muted" style="margin:0;font-size:13px">As etapas passaram a ser configuradas dentro da própria aba Pipeline, junto do quadro.</p></div>
        <span class="lc-arrow">${ico('arrowright', 18)}</span>
      </a>

      <div class="card">
        <h2>${ico('lock')} Segurança, senha de acesso ${state.mustChangePassword ? '<span class="bad-dot">(troque a senha padrão!)</span>' : ''}</h2>
        <div class="row">
          <label>Senha atual<input id="pw-cur" type="password"></label>
          <label>Nova senha (mín. 6)<input id="pw-new" type="password"></label>
          <button class="btn primary no-grow" onclick="changePass()">Alterar senha</button>
        </div>
      </div>

      ${state.kind === 'account' && !state.agent ? `<div class="card danger-card">
        <h2>${ico('trash')} Excluir minha conta</h2>
        <p class="muted" style="margin:0 0 14px;font-size:13px">
          Apaga definitivamente sua conta e <b>tudo que está nela</b>: conversas, contatos,
          mensagens, automações, agendamentos e atendentes. Não há como desfazer nem recuperar depois.
        </p>
        <button class="btn danger no-grow" onclick="deleteAccountModal()">Excluir minha conta</button>
        <p class="muted" style="margin:14px 0 0;font-size:12.5px">
          <a href="#" onclick="openExternal(API.url('/privacidade'));return false">Política de Privacidade</a>
          ·
          <a href="#" onclick="openExternal(API.url('/termos'));return false">Termos de Uso</a>
        </p>
      </div>` : ''}
      </div>
    </div>`;
  paintProfilePhoto();
  loadService();
  loadSurvey();
  if (state.wa && state.wa.connected) { loadCalling(); loadProfile(true); }
  // veio do menu do avatar: abre direto a aba certa (e o campo de novo canal)
  if (PENDING_TAB) {
    showSettingsTab(PENDING_TAB);
    if (PENDING_CH_NEW) {
      const el = $('#ch-new');
      if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    PENDING_TAB = ''; PENDING_CH_NEW = false;
  }
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
          <label style="margin-top:11px">Rodapé, opcional<input id="sv-ft" maxlength="60" value="${esc(svCfg.footer || '')}" oninput="svSet('footer', this.value)" placeholder="Sua opinião nos ajuda a melhorar"></label>
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
    toast(`Pesquisa salva, será enviada como ${d.format === 'buttons' ? 'botões' : 'lista'}`);
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
    if (st) st.textContent = ac.enabled ? 'Atendimentos parados serão finalizados automaticamente.' : 'Desativada, os atendimentos só são finalizados manualmente.';
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
    if (st) st.textContent = ac.enabled ? 'Atendimentos parados serão finalizados automaticamente.' : 'Desativada, os atendimentos só são finalizados manualmente.';
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
        graphVersion: ecSelVal('pl-version'),
        metaAds: { appId: ($('#pl-ads-appid') || {}).value || '', appSecret: ($('#pl-ads-secret') || {}).value || '' }
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
    // os campos manuais vivem no Admin SaaS, aba Plataforma
    if (state.view === 'admin') { paintAdmin(); setTimeout(() => showSettingsTab('adm-plat'), 60); }
    else renderSettings();
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
      <div style="flex:1"><h1>Pixels &amp; rastreamento</h1><p>Configure os pixels que disparam nos seus links rastreáveis, no navegador e no servidor (Conversions API)</p></div>
      <button class="btn primary no-grow" onclick="openPixelForm(null)">${ico('plus', 14)} Adicionar pixel</button>
    </div>
    <div id="px-form"></div>
    <div class="card">
      <h2>${ico('target')} Pixels configurados</h2>
      <p class="muted" style="margin:0 0 14px">Disparados automaticamente nos seus <a href="#/links">links rastreáveis</a>, cada clique vira evento <code>LinkClick</code> (Meta), <code>link_click</code> (Google) e <code>page</code> (TikTok).</p>
      <div id="px-list">${skel(3)}</div>
    </div>
    <div class="card">
      <h2>${ico('link')} Domínio personalizado dos links</h2>
      <div class="row">
        <label style="flex:1">Domínio dos links curtos<input id="tk-domain" value="${esc(cfg.linkDomain || '')}" placeholder="ex.: link.suaempresa.com.br"></label>
        <button class="btn primary no-grow" onclick="saveLinkDomain()">${ico('save', 14)} Salvar domínio</button>
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Aponte o DNS do seu domínio para este servidor, os links curtos passam a sair como <code>https://seu-dominio/l/apelido</code>.</p>
    </div>
    <div class="card px-guide">
      <h2>${ico('help')} Onde encontrar o ID de cada pixel</h2>
      <div class="pxg-grid">
        <div><b>${ico(PIXEL_ICON.meta, 15)} Meta (Facebook/Instagram)</b><p>Gerenciador de Eventos → seu dataset → <b>ID</b> (15 a 16 dígitos). O token da CAPI fica em <i>Configurações → Gerar token de acesso</i>.</p></div>
        <div><b>${ico(PIXEL_ICON.gtag, 15)} Google Ads / GA4</b><p>Painel do Google → tag <code>G-XXXX</code> (GA4) ou <code>AW-XXXX</code> (Ads). Cole o ID exatamente como aparece.</p></div>
        <div><b>${ico(PIXEL_ICON.tiktok, 15)} TikTok</b><p>TikTok Ads → Ferramentas → Eventos → Web → <b>Pixel ID</b> (código alfanumérico).</p></div>
      </div>
    </div>
  </div>`;
  openPixelForm(null, true);   // formulário já exposto ao abrir a página
  paintPixels();
}

// Painel de edição inline (sem popup) — abre acima da lista de pixels
async function openPixelForm(id, silent) {
  let px = { type: 'meta', pixelId: '', name: '', capiToken: '', testCode: '', defaultEvent: '' };
  if (id) { const { pixels } = await api('/pixels'); px = Object.assign(px, pixels.find(p => p.id === id) || {}); }
  window._pxEdit = id || null;
  const box = $('#px-form'); if (!box) return;
  box.innerHTML = `<div class="card px-editor">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="flex:1;margin:0">${ico(id ? 'edit' : 'plus')} ${id ? 'Editar' : 'Novo'} pixel</h2>
      ${id ? `<button class="icon-btn" title="Fechar" onclick="closePixelForm()">${ico('x', 16)}</button>` : ''}
    </div>
    <div class="row">
      <label style="flex:1">Plataforma${ecSelect('px-type', Object.entries(PIXEL_LBL).map(([k, v]) => ({ value: k, label: v })), px.type || 'meta', 'pxTypeChanged(val)')}</label>
      <label style="flex:1">Nome (opcional)<input id="px-name" value="${esc(px.name)}" placeholder="ex.: Pixel campanha julho"></label>
    </div>
    <label style="margin-top:9px">ID do pixel<input id="px-id" value="${esc(px.pixelId)}" placeholder="${PIXEL_ID_PH[px.type] || ''}"></label>
    <div id="px-extra">${pixelExtraHtml(px)}</div>
    <div class="row" style="margin-top:8px;justify-content:flex-end">
      ${id ? `<button class="btn no-grow" onclick="closePixelForm()">Cancelar</button>
      <button class="btn no-grow" id="px-test-btn" onclick="testPixel('${id}')">${ico('activity', 14)} Testar evento</button>` : ''}
      <button class="btn primary no-grow" onclick="savePixel(${id ? `'${id}'` : 'null'})">${ico('save', 14)} Salvar</button>
    </div>`;
  if (!silent) { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); setTimeout(() => $('#px-id')?.focus(), 80); }
}
// volta ao formulário "novo" em vez de sumir (fica sempre exposto)
function closePixelForm() { openPixelForm(null, true); }
function pixelExtraHtml(px) {
  const evOpts = CONV_EVENTS.map(e => ({ value: e, label: e }));
  const evSel = `<label>Evento de conversão padrão${ecSelect('px-event', evOpts, px.defaultEvent || 'PageView')}</label>`;
  if (px.type !== 'meta') return `${evSel}<p class="muted" style="font-size:11.5px;margin:8px 0 0">Disparado no navegador quando alguém clica nos seus links rastreáveis.</p>`;
  return `${evSel}
    <div class="capi-box">
      <div class="capi-head">${ico('shield', 14)} Conversions API <span class="capi-tag">server-side</span></div>
      <p class="muted" style="font-size:11.5px;margin:2px 0 10px">Rastreamento pelo servidor (à prova de bloqueadores e iOS). Gere o token em Eventos → Configurações do dataset na Meta.</p>
      <label>Access Token (CAPI)<input id="px-capi" type="password" value="${esc(px.capiToken || '')}" placeholder="EAAG… (opcional, mas recomendado)"></label>
      <label style="margin-top:9px">Código de teste (test_event_code)<input id="px-testcode" value="${esc(px.testCode || '')}" placeholder="TEST12345, opcional, só p/ validar"></label>
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

function diagOut(data) {
  const el = $('#diag-out');
  const txt = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (el) el.textContent = txt;         // caixa de diagnostico existe so em Configuracoes
  else console.log('[diag]', txt);      // chamado do Admin: nao quebra
}

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
  const el = $('#wh-token');
  if (el) el.textContent = r.verifyToken;
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
  const iniciais = waInitials((state.wa && state.wa.verifiedName) || state.user);
  // URL da Meta expira: se a imagem falhar, volta para as iniciais
  const html = url ? avatarImg(url, 'Foto do perfil', iniciais) : iniciais;
  const el = $('#pf-photo'); if (el) el.innerHTML = html;
  const cp = $('#conn-photo'); if (cp) cp.innerHTML = html; // card "WhatsApp conectado"
}
// Logo OFICIAL do WhatsApp (glifo do balão com o telefone). Vetor: nítido em
// qualquer tamanho e sem baixar os 2 MB do PNG.
function waLogo(size, color) {
  const c = color || 'currentColor';
  return `<svg viewBox="0 0 24 24" width="${size || 24}" height="${size || 24}" fill="${c}" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.75-.86-2.02-.96-.27-.1-.47-.15-.66.15-.2.3-.76.96-.94 1.16-.17.2-.34.22-.63.08-.3-.15-1.25-.46-2.38-1.47-.88-.79-1.48-1.75-1.65-2.05-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.38-.02-.53-.08-.15-.66-1.6-.9-2.19-.24-.57-.48-.5-.66-.5l-.57-.01c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.06 2.88 1.21 3.08c.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.75-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.13-.27-.2-.57-.35z"/><path d="M12.05 2C6.6 2 2.18 6.42 2.18 11.87c0 1.74.46 3.44 1.32 4.94L2.1 22l5.33-1.4a9.83 9.83 0 0 0 4.62 1.18h.01c5.44 0 9.87-4.42 9.87-9.87A9.8 9.8 0 0 0 19 4.87 9.8 9.8 0 0 0 12.05 2zm0 17.93h-.01a8.2 8.2 0 0 1-4.17-1.14l-.3-.18-3.1.81.83-3.02-.2-.31a8.16 8.16 0 0 1-1.25-4.36c0-4.52 3.68-8.2 8.2-8.2a8.15 8.15 0 0 1 5.8 2.4 8.15 8.15 0 0 1 2.4 5.8c0 4.53-3.68 8.2-8.2 8.2z"/></svg>`;
}

// Foto de perfil da Meta: a URL de pps.whatsapp.net EXPIRA. Quando falha, o
// <img> quebrado aparecia no lugar do avatar; agora cai nas iniciais.
function avatarImg(url, alt, fallbackHtml, style) {
  const fb = String(fallbackHtml || '').replace(/"/g, '&quot;');
  return `<img src="${esc(url)}" alt="${esc(alt || '')}"${style ? ' style="' + style + '"' : ''} onerror="this.parentElement.innerHTML=this.dataset.fb" data-fb="${fb}">`;
}
function paintTopbarAvatar() {
  const av = $('#tb-avatar'); if (!av) return;
  const url = state.wa && state.wa.profilePictureUrl;
  if (!url) return;
  const iniciais = waInitials(state.user || 'A');
  av.innerHTML = avatarImg(url, '', iniciais, 'width:100%;height:100%;object-fit:cover;border-radius:50%');
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
    st.textContent = c ? (on ? 'Ligações habilitadas, seus clientes podem te ligar pelo WhatsApp.' : 'Ligações desabilitadas.') : 'Recurso ainda não configurado neste número.';
  } catch (e) { st.textContent = 'Não foi possível consultar: ' + e.message; }
}
async function toggleCalling(enabled) {
  const st = $('#cl-status');
  try {
    await api('/settings/calling', { method: 'PUT', body: { enabled } });
    if (st) st.textContent = enabled ? 'Ligações habilitadas, seus clientes podem te ligar pelo WhatsApp.' : 'Ligações desabilitadas.';
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

async function changePass() {
  try {
    await api('/settings/password', { body: { current: $('#pw-cur').value, next: $('#pw-new').value } });
    state.mustChangePassword = false;
    toast('Senha alterada com sucesso!');
    $('#pw-cur').value = ''; $('#pw-new').value = '';
  } catch (e) { toast(e.message, 'error'); }
}

// Exclusão da conta pelo próprio dono — exigência da App Store (5.1.1(v)) e
// também o caminho correto de LGPD. Pede senha e confirmação escrita porque a
// operação apaga tudo e não tem volta.
function deleteAccountModal() {
  openModal(`
    <h2 style="margin:0 0 6px">${ico('alert')} Excluir minha conta</h2>
    <p class="muted" style="font-size:13px;line-height:1.6;margin:0 0 14px">
      Isto apaga <b>permanentemente</b> a conta <b>${esc(state.user || '')}</b> e todo o seu conteúdo:
      conversas, contatos, mensagens, automações, agendamentos, atendentes e integrações.
      <br><br>
      <b>Não é possível desfazer.</b> Se você tem uma assinatura ativa, cancele-a antes —
      a exclusão não gera reembolso automático.
    </p>
    <label>Sua senha<input id="del-pass" type="password" autocomplete="current-password"></label>
    <label style="margin-top:9px"><span>Digite <b>EXCLUIR</b> para confirmar</span>
      <input id="del-confirm" placeholder="EXCLUIR" autocapitalize="characters">
    </label>
    <div class="row" style="margin-top:14px">
      <button class="btn no-grow" onclick="closeModal()">Cancelar</button>
      <button class="btn danger no-grow" onclick="doDeleteAccount(this)">Excluir definitivamente</button>
    </div>`);
}

async function doDeleteAccount(btn) {
  const pass = $('#del-pass').value;
  const confirm = $('#del-confirm').value;
  if (!pass) return toast('Informe sua senha', 'error');
  if (confirm.trim().toUpperCase() !== 'EXCLUIR') return toast('Digite EXCLUIR para confirmar', 'error');
  btn.disabled = true;
  try {
    await api('/account/delete', { body: { pass, confirm } });
    closeModal();
    // A sessão já morreu no servidor; limpa o que ficou no aparelho.
    try { localStorage.clear(); } catch {}
    TOKEN = '';
    toast('Conta excluída. Até logo.');
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    btn.disabled = false;
    toast(e.message, 'error');
  }
}

// ==================== TOPBAR ====================
const TITLES = {
  dashboard: 'Dashboard', reports: 'Métricas & Relatórios', inbox: 'Conversas', contacts: 'Contatos',
  funnel: 'Pipeline', campaigns: 'Campanhas', templates: 'Modelos de mensagem',
  quick: 'Respostas rápidas', logs: 'Webhook & Logs', settings: 'Configurações',
  team: 'Chat interno', flows: 'Flow Builder', links: 'Links rastreáveis',
  integrations: 'Integrações', webhooks: 'Integrações',
  elitepay: 'Elite Pay', 'elitepay/checkout': 'Checkout Builder', checkouts: 'Checkout Builder', tracking: 'Tracking',
  schedule: 'Agendamentos', consent: 'Opt-in & Opt-out', pixels: 'Pixels & rastreamento',
  agents: 'Atendentes', billing: 'Assinatura & Carteira', admin: 'Admin SaaS', sms: 'Disparos de SMS',
  'templates/new': 'Criar modelo', 'campaigns/new': 'Nova campanha'
};
function updateTopbar() {
  const t = $('#tb-title');
  if (t) t.textContent = TITLES[state.view] || 'Elite Chat';
  markTabbarActive();   // o destino aceso na barra de baixo segue a rota
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
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" style="font:700 10px 'Inter Tight',sans-serif;letter-spacing:.8px" fill="var(--faint)">${esc(main.label.toUpperCase())}</text>
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

// ==================== MAPA DO BRASIL (leads por estado) ====================
// Mapa geográfico real: contornos das 27 UFs vêm da malha oficial do IBGE
// (public/app/br-uf.js). Coloração choropleth — quanto mais leads, mais escuro.
const UF_NAME = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins'
};

// Estados pequenos: o rótulo não cabe dentro do contorno e sai numa "perna".
// Os cinco do litoral nordestino ficam a ~30 unidades um do outro — menos que a
// altura de linha —, então vão para uma coluna fixa à direita, espaçados em 38.
// Os demais recebem uma âncora curta na área de oceano ao lado. [x, y] absolutos.
const UF_LABEL_X = 1022;
const UF_LEADER = {
  RN: [UF_LABEL_X, 262], PB: [UF_LABEL_X, 300], PE: [UF_LABEL_X, 338],
  AL: [UF_LABEL_X, 376], SE: [UF_LABEL_X, 414],
  ES: [858, 620], RJ: [828, 690], DF: [690, 524]
};

// Espessura da "placa" 3D, em unidades do viewBox. A parede é desenhada como
// N cópias da silhueta descendo — o passo precisa ficar abaixo de 1px em tela
// (escala ~0.45) para as cópias se fundirem numa massa sólida, sem listras.
const GEO_DEPTH = 19, GEO_STEPS = 13;

// A malha vai de 0 a 1000; a coluna de rótulos do Nordeste fica além disso,
// e a extrusão precisa de folga embaixo. Derivado do viewBox da malha para
// não quebrar se ela for regerada.
function geoViewBox() {
  const [, , w, h] = BR_UF_VIEWBOX.split(' ').map(Number);
  return `0 0 ${w + 185} ${h + GEO_DEPTH + 10}`;
}

function brazilMap3D(g) {
  const counts = g.states || {};
  const max = Math.max(1, ...Object.values(counts));

  // Sem a malha carregada não há o que desenhar — avisa em vez de quebrar.
  if (typeof BR_UF_PATHS === 'undefined') {
    return '<div class="geo-map"><p class="muted geo-empty">Mapa indisponível: malha das UFs não carregou.</p></div>';
  }

  const ufs = Object.keys(BR_UF_PATHS);

  // A geometria entra UMA vez em <defs>; parede e face de cima são <use>.
  // Sem isso os ~120KB de path se repetiriam 14x no DOM.
  const defs = ufs.map(uf => `<path id="geo-p-${uf}" d="${BR_UF_PATHS[uf]}"/>`).join('');

  // Base OPACA entre a parede e as faces. Sem ela a parede aparece através do
  // preenchimento semitransparente dos estados e contamina a cor de todos eles
  // — o estado mais fraco (opacidade .14) fica 86% cor-de-parede.
  const base = ufs.map(uf => `<use href="#geo-p-${uf}"/>`).join('');

  // Parede lateral: como todas as cópias usam a mesma cor chapada, as divisas
  // internas somem e o conjunto lê como um bloco único de terra.
  let wall = '';
  for (let i = 1; i <= GEO_STEPS; i++) {
    const dy = (GEO_DEPTH * i / GEO_STEPS).toFixed(2);
    wall += ufs.map(uf => `<use href="#geo-p-${uf}" y="${dy}"/>`).join('');
  }

  let svg = '';
  for (const uf of ufs) {
    const count = counts[uf] || 0;
    // raiz quadrada em vez de razão direta: com um estado dominante (ex.: SP com
    // 10x o segundo), a escala linear jogaria todo o resto no tom mais claro.
    const frac = count ? Math.sqrt(count / max) : 0;
    // MAPA DE CALOR: uma única escala de verde EliteChat, do frio ao quente.
    // Tudo é opacidade sobre --geo-ink (a cor da marca), então o tema claro
    // escurece o estado conforme cresce e o escuro o acende — sem JS por tema.
    //  · 0 leads  = 7%  (verde bem apagado, "frio")
    //  · 1 lead   = 22% (já visivelmente mais verde que o vazio)
    //  · máximo   = 92% (verde cheio da marca, "quente")
    const op = count ? (0.22 + frac * 0.70) : 0.07;
    const paint = `fill="var(--geo-ink)" fill-opacity="${op.toFixed(3)}"`;
    const [cx, cy] = BR_UF_CENTROIDS[uf] || [0, 0];
    const lead = UF_LEADER[uf];
    const tx = lead ? lead[0] : cx;
    const ty = lead ? lead[1] : cy + 4;
    // O halo do CSS (paint-order) separa a sigla do preenchimento, então ela
    // continua legível tanto sobre o verde mais forte quanto sobre o mais fraco.
    // O mapa mostra só a SIGLA: a quantidade já é lida pela intensidade do verde
    // e aparece exata no tooltip ao passar o mouse. Number solto sobre o estado
    // poluía o desenho e repetia a informação.
    svg += `<g class="geo-tile${count ? ' hot' : ''}" role="img" aria-label="${UF_NAME[uf]}: ${fmtN(count)} lead(s)"
      data-name="${UF_NAME[uf]}" data-n="${count}">
      <use href="#geo-p-${uf}" ${paint} stroke="var(--geo-sep)" stroke-width="2.4" stroke-linejoin="round"/>
      ${lead ? `<line x1="${cx}" y1="${cy}" x2="${tx - 7}" y2="${ty}" class="geo-lead"/>` : ''}
      <text x="${tx}" y="${ty}" text-anchor="${lead ? 'start' : 'middle'}" dominant-baseline="middle"
            class="geo-uf${count ? (frac > 0.65 ? ' strong' : '') : ' off'}">${uf}</text>
    </g>`;
  }

  svg = `<defs>${defs}</defs>
    <g class="geo-wall">${wall}</g>
    <g class="geo-base">${base}</g>
    <g class="geo-faces">${svg}</g>`;

  const top5 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxSrc = Math.max(1, ...(g.sources || []).map(s => s.count));
  const maxRef = Math.max(1, ...(g.referrers || []).map(r => r.count));
  return `
    <div class="geo-map">
      <svg viewBox="${geoViewBox()}" style="width:100%;height:auto">${svg}</svg>
      <div class="geo-tip" id="geo-tip" aria-hidden="true"></div>
      ${g.brTotal ? '' : '<p class="muted geo-empty">Sem leads brasileiros localizados ainda, os estados acendem conforme os contatos chegam pelo WhatsApp.</p>'}
    </div>
    <div class="geo-side">
      <div class="geo-block">
        <span class="fb-sub">Top estados</span>
        ${top5.length ? top5.map(([uf, n]) => hrow(`${uf}, ${UF_NAME[uf]}`, n, top5[0][1])).join('') : '<p class="muted" style="font-size:12.5px">Nenhum lead localizado ainda.</p>'}
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
    `<div class="hb" style="height:${Math.max(3, d.count / max * 100)}%;background:${color}" title="${fmtD(d.date)}, ${d.count}"></div>`).join('')}</div>
  <div class="hbars-x"><span>${fmtD(series[0].date)}</span><span>${fmtD(series[Math.floor(series.length / 2)].date)}</span><span>${fmtD(series[series.length - 1].date)}</span></div>`;
}

// Volume in/out com 3 tipos de gráfico (linha, barras, área) — escolha do usuário
function chVolume(days, kind = 'line', h = 240) {
  if (kind === 'line') return chLine(days, h);
  const w = 560, padB = 22;
  const max = Math.max(1, ...days.map(d => Math.max(d.in, d.out)));
  const fmtD = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
  const grid = [0.25, 0.5, 0.75].map(f => `<line x1="0" y1="${(h - padB) * f}" x2="${w}" y2="${(h - padB) * f}" stroke="#e8f3ec" stroke-dasharray="3 4"/>`).join('');
  const labels = `<text x="2" y="${h - 6}" style="font:600 10px 'Inter Tight'" fill="var(--faint)">${fmtD(days[0].date)}</text>
    <text x="${w - 2}" y="${h - 6}" text-anchor="end" style="font:600 10px 'Inter Tight'" fill="var(--faint)">${fmtD(days[days.length - 1].date)}</text>`;
  if (kind === 'bars') {
    const slot = w / days.length, bw = Math.max(3, Math.min(16, slot * 0.34));
    let bars = '';
    days.forEach((d, i) => {
      const xm = i * slot + slot / 2;
      const ho = d.out / max * (h - padB - 8), hi = d.in / max * (h - padB - 8);
      bars += `<rect x="${(xm - bw - 0.5).toFixed(1)}" y="${(h - padB - ho).toFixed(1)}" width="${bw}" height="${Math.max(2.5, ho).toFixed(1)}" rx="${Math.min(4, bw / 2)}" fill="url(#gvb)"><title>${fmtD(d.date)}, ${d.out} enviadas</title></rect>`;
      bars += `<rect x="${(xm + 0.5).toFixed(1)}" y="${(h - padB - hi).toFixed(1)}" width="${bw}" height="${Math.max(2.5, hi).toFixed(1)}" rx="${Math.min(4, bw / 2)}" fill="#53BDEB" opacity=".8"><title>${fmtD(d.date)}, ${d.in} recebidas</title></rect>`;
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
          <div class="hbars">${r.byHour.map((v, i) => `<div class="hb" style="height:${Math.max(3, v / maxHour * 100)}%" title="${i}h, ${v} mensagem(ns)"></div>`).join('')}</div>
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
        <p class="muted" style="margin:6px auto 16px;max-width:420px">Dispare um template aprovado para todos os contatos, para uma etapa do funil ou para uma tag, e acompanhe entregas, leituras e falhas por destinatário.</p>
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
        <a class="btn no-grow" href="#/campaigns">${ico('arrowleft', 14)} Voltar</a>
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
      <a class="btn no-grow" href="#/campaigns">${ico('arrowleft', 14)} Voltar</a>
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
      toast('Nenhuma automação com gatilho de webhook, crie uma no Flow Builder e ela aparece aqui', 'error');
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
    ? `<label>Variável do webhook "${esc(h.name)}"${ecSelect('cp-whk-' + i, h.vars.map(k => ({ value: k, label: `${k}, último: ${String(h.lastVars[k]).slice(0, 24)}` })), '', `campVarField(${i},'${flowId}',val)`, 'sm')}</label>`
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
      : '<p class="muted" style="font-size:12.5px;margin:0">Nenhuma tag ainda, adicione tags aos contatos na aba <a href="#/contacts">Contatos</a>.</p>';
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
        : thread.kind === 'sector' ? 'Canal do setor, visível para a equipe' : 'Canal geral, todos os atendentes';
      head.innerHTML = `${av}<div class="info"><b>${esc(thread.name)}</b><span>${sub}</span></div>`;
    }
    if (sc) {
      sc.innerHTML = messages.length ? messages.map(teamBubble).join('')
        : `<div class="chat-empty"><div class="ce-ic">${ico('chat2', 44)}</div><b>${thread.kind === 'dm' ? 'Converse em particular' : 'Comece a conversa'}</b><p class="muted" style="font-size:13px">Mensagens internas, não vão para o WhatsApp dos clientes.</p></div>`;
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
        <p class="muted" style="margin:6px auto 16px;max-width:440px">Crie links curtos para bio, anúncios e campanhas. Cada clique é registrado, e, com os pixels configurados, alimenta a Meta e o Google automaticamente.</p>
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
          <li><b>UTMs:</b> anexados automaticamente à URL de destino, aparecem no Google Analytics e no gerenciador de anúncios.</li>
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
        <h2>${ico('activity')} Cliques, últimos 30 dias</h2>
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
    const refLink = `${API.webOrigin}/app/?ref=${d.affiliate.code}`;
    const cardOn = !!(d.card && d.card.credit);
    BILL_CACHE = d;
    box.innerHTML = `
      ${d.wooviReady ? '' : `<div class="card warn-card">${ico('alert', 16)} <b>Pagamentos ainda não configurados.</b> ${state.kind === 'admin' ? 'Informe o AppID da Woovi em <a href="#/admin">Admin SaaS → Pagamentos</a>.' : 'A plataforma ainda não ativou os pagamentos, fale com o suporte.'}</div>`}

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

      ${usageSection(d)}

      <div class="card">
        <h2>${ico('zap')} Planos</h2>
        ${d.plans.length ? `<div class="plans-grid">${d.plans.map(p => `
          <div class="plan ${plan && plan.id === p.id ? 'current' : ''}">
            <b class="pl-name">${esc(p.name)}</b>
            <div class="pl-price">${fmtBRL(p.price)}<span>/mês</span></div>
            <ul class="pl-feats">
              ${FEATURE_META.filter(m => !p.modules || p.modules[m.key] !== false)
                .map(m => `<li>${ico('check', 13)} ${esc(m.label)}</li>`).join('')}
              ${(p.features || []).map(f => `<li>${ico('check', 13)} ${esc(f)}</li>`).join('')}
              ${LIMIT_META.map(m => {
                const v = (p.limits || {})[m.key];
                return `<li class="pl-lim">${ico('check', 13)} <b>${v === -1 || v === undefined ? 'Ilimitado' : fmtN(v)}</b> ${esc(m.label.toLowerCase())}</li>`;
              }).join('')}
            </ul>
            ${plan && plan.id === p.id && b.status === 'active'
              ? '<span class="pill done" style="align-self:center">Plano atual</span>'
              : `<div class="pl-btns">
                  <button class="btn primary block" ${d.wooviReady ? '' : 'disabled'} onclick="subscribePlan('${p.id}')">${ico('pix', 14)} Pix</button>
                  ${cardOn ? `<button class="btn block" onclick="openCardPay('plan','${p.id}',${p.price})">${ico('card', 14)} Cartão</button>` : ''}
                  ${(d.card || {}).boleto ? `<button class="btn block" onclick="subscribeBoleto('${p.id}')">${ico('file', 14)} Boleto</button>` : ''}
                </div>
                ${d.wallet.balance >= p.price + (d.extrasCost || 0) ? `<button class="btn block" style="margin-top:7px" onclick="payWithWallet('${p.id}')">${ico('briefcase', 13)} Usar saldo (${fmtBRL(d.wallet.balance)})</button>` : ''}`}
          </div>`).join('')}</div>
          <p class="muted" style="font-size:12px;margin:12px 0 0">${ico('shield', 13)}
            Formas de pagamento aceitas: <b>Pix</b> pela Woovi, com renovação automática por Pix Automático quando o seu banco oferece o recurso${cardOn
              ? `; <b>cartão de crédito</b>, com ativação imediata e renovação no cartão salvo` : ''}${(d.card || {}).boleto
              ? `; e <b>boleto bancário</b>, com liberação após a compensação` : ''}.</p>`
          : '<p class="muted">Nenhum plano publicado ainda.</p>'}
      </div>

      <div class="two-col even">
        ${walletCard(d)}

        <div class="card aff-card">
          <h2>${ico('sparkles')} Indique e ganhe</h2>
          <p class="muted" style="margin:0 0 10px;font-size:13px">Ganhe <b style="color:var(--verde-deep)">${d.affiliate.percentFirst}%</b> de cada nova assinatura e <b style="color:var(--verde-deep)">${d.affiliate.percentRenewal}%</b> de cada renovação dos indicados, direto na sua carteira.</p>
          <div class="linkrow"><code>${esc(refLink)}</code><button class="icon-btn" title="Copiar" onclick="copyText('${esc(refLink)}')">${ico('copy', 13)}</button></div>
          <div class="lk-kpis" style="margin-top:12px">
            <div><b>${d.affiliate.referrals.length}</b><span>Indicados</span></div>
            <div><b>${fmtBRL(d.affiliate.earned)}</b><span>Comissões</span></div>
          </div>
          ${d.affiliate.referrals.length ? `<span class="fb-sub" style="margin-top:12px">Seus indicados</span>
            ${d.affiliate.referrals.map(r => `<div class="tx"><span class="tx-lbl">${esc(r.name)}</span><span class="pill ${r.status === 'active' ? 'done' : ''}">${(BILL_ST[r.status] || [r.status])[0]}</span></div>`).join('')}` : ''}
          <div class="row" style="margin-top:14px">
            <label style="flex:1.4">Chave Pix p/ saque<input id="wd-key" placeholder="CPF, e-mail ou aleatória"></label>
            <label style="flex:1">Valor (R$)<input id="wd-amount" placeholder="mín. 20,00" inputmode="decimal" oninput="wdQuote()"></label>
            <button class="btn no-grow" onclick="withdrawWallet()">Sacar</button>
          </div>
          <p class="hint" id="wd-quote" style="margin-top:8px;text-align:left"></p>
          ${d.withdrawals.length ? `<div class="tx-list" style="margin-top:10px">${d.withdrawals.map(w => `
            <div class="tx"><span class="tx-lbl">Saque ${fmtBRL(w.amount)}</span><span class="muted" style="font-size:11px">${timeAgo(w.ts)}</span>
            <span class="pill ${w.status === 'paid' ? 'done' : w.status === 'rejected' ? '' : 'pending'}">${{ pending: 'Em análise', paid: 'Pago', rejected: 'Recusado' }[w.status] || w.status}</span></div>`).join('')}</div>` : ''}
        </div>
      </div>`;
    if (pc) startPayPoll();
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// ============================================================================
// CARTEIRA — vendas no cartão entram aqui e viram saldo utilizável na plataforma
// ============================================================================
let BILL_CACHE = null;

function walletCard(d) {
  const w = d.walletDetail || { balance: d.wallet.balance, pending: 0, cardAvailable: 0, receivables: [] };
  const ca = d.cardAccount || {};
  const prox = w.nextRelease;

  return `<div class="card">
    <h2>${ico('briefcase')} Carteira</h2>
    <div class="wallet-split">
      <div class="wal-box hi">
        <span class="wal-lbl">Disponível para usar ou sacar</span>
        <b class="wal-val">${fmtBRL(w.balance)}</b>
        ${w.cardAvailable ? `<span class="wal-sub">${fmtBRL(w.cardAvailable)} vieram de venda no cartão</span>` : ''}
      </div>
      <div class="wal-box">
        <span class="wal-lbl">A liberar (vendas no cartão)</span>
        <b class="wal-val">${fmtBRL(w.pending)}</b>
        <span class="wal-sub">${prox
          ? `Próxima: ${fmtBRL(prox.amount)} em ${new Date(prox.at).toLocaleDateString('pt-BR')}`
          : 'Nenhuma venda aguardando liberação'}</span>
      </div>
    </div>

    <p class="hint" style="margin-top:12px;text-align:left">${ico('clock', 12)}
      O dinheiro do cartão é liberado <b>no mesmo prazo da adquirente</b>:
      crédito <b>${esc(((ca.settleRules || {}).credit || {}).text || 'D+30')}</b> ·
      boleto <b>${esc(((ca.settleRules || {}).boleto || {}).text || 'D+2 úteis')}</b>.
      Até lá o valor fica em “a liberar”.
      O saldo disponível pode <b>pagar o seu plano, conexões WhatsApp e links extras</b>, sem taxa de saque.
    </p>

    ${w.receivables && w.receivables.length ? `
      <span class="fb-sub" style="margin-top:14px">Próximas liberações</span>
      <div class="tx-list">${w.receivables.map(r => `
        <div class="tx"><span class="tx-lbl">${{ debit: 'Débito', boleto: 'Boleto' }[r.kind] || 'Crédito'}${r.installments > 1 ? ` · parcela ${r.installment}/${r.installments}` : ''} · libera ${new Date(r.at).toLocaleDateString('pt-BR')}</span>
        <b class="tx-in">${fmtBRL(r.amount)}</b></div>`).join('')}</div>` : ''}

    <div class="row" style="margin-top:14px">
      <label style="flex:1">Adicionar saldo via Pix (R$)<input id="wal-amount" placeholder="ex.: 50,00" inputmode="decimal"></label>
      <button class="btn primary no-grow" ${d.wooviReady ? '' : 'disabled'} onclick="topupWallet()">${ico('plus', 14)} Gerar Pix</button>
    </div>

    ${d.wallet.transactions.length ? `<span class="fb-sub" style="margin-top:14px">Extrato</span>
    <div class="tx-list">${d.wallet.transactions.map(t => `
      <div class="tx"><span class="tx-lbl">${esc(t.label)}${t.pending ? ' <span class="pill pending" style="margin-left:6px">a liberar</span>' : ''}</span>
      <span class="muted" style="font-size:11px">${timeAgo(t.ts)}</span>
      <b class="${t.amount >= 0 ? 'tx-in' : 'tx-out'}">${t.amount >= 0 ? '+' : ''}${fmtBRL(t.amount)}</b></div>`).join('')}</div>` : ''}
  </div>`;
}

// Prévia da taxa de saque conforme a origem do dinheiro (cartão x Pix).
let wdQuoteTimer = null;
function wdQuote() {
  clearTimeout(wdQuoteTimer);
  wdQuoteTimer = setTimeout(async () => {
    const el = $('#wd-amount'), out = $('#wd-quote');
    if (!el || !out) return;
    const v = String(el.value || '').trim();
    if (!v) { out.innerHTML = ''; return; }
    try {
      const q = await api('/wallet/withdraw/quote?amount=' + encodeURIComponent(v));
      if (!q.amount) { out.innerHTML = ''; return; }
      out.innerHTML = q.fee
        ? `Taxa ${fmtBRL(q.fee)}${q.fromCard ? ` (cartão ${fmtBRL(q.cardFee)}${q.pixFee ? ` + Pix ${fmtBRL(q.pixFee)}` : ''})` : ''} · você recebe <b>${fmtBRL(q.net)}</b>`
        : `Sem taxa · você recebe <b>${fmtBRL(q.net)}</b>`;
    } catch { out.innerHTML = ''; }
  }, 350);
}

// ============================================================================
// CONSUMO x LIMITES DO PLANO + compra de unidades extras
// ============================================================================

function usageSection(d) {
  const u = d.usage || {};
  const cardOn = !!(d.card && d.card.credit);
  const compraveis = LIMIT_META.filter(m => m.extra && (u[m.key] || {}).extraPrice);

  return `<div class="card">
    <h2>${ico('activity')} Seu consumo no ciclo</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">O que o seu plano libera e quanto já foi usado. Ao bater o teto, o recurso trava até você liberar mais.</p>
    <div class="use-grid">
      ${LIMIT_META.map(m => {
        const r = u[m.key]; if (!r) return '';
        const cls = r.unlimited ? '' : r.exceeded ? 'full' : r.percent >= 80 ? 'warn' : '';
        return `<div class="use-item ${cls}">
          <div class="use-top"><span>${esc(m.label)}</span><b>${fmtN(r.used)}${r.unlimited ? '' : ' / ' + fmtN(r.limit)}</b></div>
          <div class="use-bar"><i style="width:${r.unlimited ? 0 : Math.max(2, r.percent)}%"></i></div>
          <span class="use-sub">${r.unlimited
            ? 'Ilimitado no seu plano'
            : `${fmtN(r.included)} do plano${r.extras ? ` + ${fmtN(r.extras)} extra(s)` : ''}${r.exceeded ? ' · <b>limite atingido</b>' : ''}`}</span>
        </div>`;
      }).join('')}
    </div>

    ${compraveis.length ? `
      <div class="fee-sep"></div>
      <h2 style="font-size:14px">${ico('plus')} Comprar unidades extras</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">Precisa de mais um número de WhatsApp ou mais links rastreáveis? Compre avulso, o valor entra na sua renovação mensal.</p>
      <div class="extra-grid">
        ${compraveis.map(m => {
          const r = u[m.key];
          return `<div class="extra-item">
            <div style="flex:1;min-width:0">
              <b>${esc(m.label)}</b>
              <div class="muted" style="font-size:12px;margin-top:2px">${fmtBRL(r.extraPrice)}/mês por unidade · você tem ${fmtN(r.extras)} extra(s)</div>
            </div>
            <div class="qty">
              <button type="button" class="qty-b" onclick="extraQty('${m.key}',-1)" aria-label="Menos uma">−</button>
              <input id="xq-${m.key}" class="qty-i" type="number" min="1" max="20" value="1"
                     inputmode="numeric" oninput="extraQty('${m.key}',0)" aria-label="Quantidade">
              <button type="button" class="qty-b" onclick="extraQty('${m.key}',1)" aria-label="Mais uma">+</button>
            </div>
            <div class="extra-total"><b id="xt-${m.key}">${fmtBRL(r.extraPrice)}</b><em>por mês</em></div>
            <button class="btn primary no-grow" onclick="openExtraPay('${m.key}')">${ico('card', 13)} Contratar</button>
          </div>`;
        }).join('')}
      </div>
      ${d.extrasCost ? `<p class="hint" style="margin-top:12px">Seus extras somam <b>${fmtBRL(d.extrasCost)}/mês</b>, cobrados junto com o plano na renovação.</p>` : ''}
      ${d.wooviReady || cardOn ? '' : '<p class="hint" style="margin-top:12px">Nenhum meio de pagamento foi ativado pela plataforma ainda.</p>'}`
    : ''}
  </div>`;
}

async function payExtraWallet(key, qty, total) {
  const ok = await confirmModal({
    title: 'Pagar com o saldo?',
    text: `${qty}x ${extraLabel(key)}, ${fmtBRLp(total)} serão debitados da sua carteira. A partir do próximo mês esse valor entra na renovação.`,
    ok: 'Confirmar'
  });
  if (!ok) return;
  try {
    await api('/billing/extras', { body: { key, qty, pay: 'wallet' } });
    closeModal();
    toast('Contratado! Já pode usar.');
    afterExtraBought(key);
  } catch (e) { toast(e.message, 'error'); }
}

function extraLabel(key) {
  const m = LIMIT_META.find(x => x.key === key) || {};
  return m.buy || m.label || key;
}

// Recarrega o que mudou depois de contratar: os canais liberam na hora e a tela
// de Assinatura passa a mostrar o novo custo mensal.
function afterExtraBought(key) {
  if (key === 'whatsapps') loadChannels().then(() => { if (state.view === 'settings') renderSettings(); });
  if (state.view === 'billing') paintBilling();
}

// ---------------------------------------------------------------------------
// POP-UP DE CONTRATAÇÃO DE EXTRAS — quantidade + escolha do meio de pagamento.
// É assinatura: o valor passa a ser cobrado em toda renovação, seja no Pix
// Automático, no cartão salvo ou no saldo.
// ---------------------------------------------------------------------------
let EXTRA_CTX = null, extraPoll = null;

async function openExtraPay(key) {
  const qty = extraQty(key, 0) || 1;
  let d = BILL_CACHE;
  if (!d) { try { d = BILL_CACHE = await api('/billing'); } catch (e) { return toast(e.message, 'error'); } }

  const unit = extraUnitPrice(key) || (((d.usage || {})[key] || {}).extraPrice || 0);
  // Sem preço cadastrado não há como cobrar, mas o cliente clicou para comprar:
  // o pop-up abre e diz o que falta, em vez de sumir num toast.
  if (!unit) {
    return openModal(`
      <h2>${ico('plus')} Adicionar ${esc(extraLabel(key))}</h2>
      <p class="muted" style="margin:0 0 16px;font-size:13px">
        O valor da unidade adicional ainda não foi definido, então a compra não pode
        ser concluída agora. Fale com o suporte para liberar ${esc(extraLabel(key))} na sua conta.
      </p>
      <div class="row"><button class="btn primary" onclick="closeModal()">Entendi</button></div>`);
  }
  EXTRA_CTX = { key, qty, unit };

  const c = d.card || {};
  const saldo = (d.wallet || {}).balance || 0;
  const meios = [
    d.wooviReady && ['pix', 'Pix', 'Liberação imediata'],
    c.credit && ['card', 'Cartão de crédito', 'Liberação imediata'],
    c.boleto && ['boleto', 'Boleto', `Compensa em até ${c.boletoDueDays || 3} dias úteis`],
    saldo > 0 && ['wallet', 'Saldo em carteira', `Disponível: ${fmtBRL(saldo)}`]
  ].filter(Boolean);

  const nome = esc(extraLabel(key));
  openModal(`
    <h2>${ico('plus')} Adicionar ${nome}</h2>
    <p class="muted" style="margin:0 0 16px;font-size:13px">
      Amplie a capacidade do seu plano com ${nome} adicionais.
      <b>${fmtBRL(unit)} por unidade ao mês</b>, liberadas assim que o pagamento for confirmado.
    </p>
    <label style="margin-bottom:6px">Quantas unidades você precisa?</label>
    <div class="extra-buy-row" style="margin-bottom:16px">
      <div class="qty">
        <button type="button" class="qty-b" onclick="modalQty(-1)" aria-label="Diminuir">−</button>
        <input id="mq" class="qty-i" type="number" min="1" max="20" value="${qty}"
               inputmode="numeric" oninput="modalQty(0)" aria-label="Quantidade">
        <button type="button" class="qty-b" onclick="modalQty(1)" aria-label="Aumentar">+</button>
      </div>
      <div class="extra-total"><b id="mt">${fmtBRL(unit * qty)}</b><em>por mês</em></div>
    </div>
    ${meios.length ? `<label style="margin-bottom:6px">Forma de pagamento</label>
    <div class="pay-methods">
      ${meios.map(([v, l, sub], i) => `<label class="pay-method">
        <input type="radio" name="xpm" value="${v}" ${i === 0 ? 'checked' : ''}>
        <span><b>${l}</b><em>${esc(sub)}</em></span>
      </label>`).join('')}
    </div>`
    : '<p class="hint">Nenhuma forma de pagamento está habilitada no momento. Fale com o suporte.</p>'}
    <p class="hint" style="margin-top:14px">${ico('refresh', 12)} <b>Assinatura mensal.</b> O valor passa a compor a sua fatura e é cobrado a cada renovação. Você pode cancelar quando quiser, com uso garantido até o fim do período já pago.</p>
    <div class="row" style="margin-top:16px">
      <button class="btn" onclick="closeModal()">Voltar</button>
      <button class="btn primary" ${meios.length ? '' : 'disabled'} onclick="confirmExtraPay(this)">Continuar</button>
    </div>`);
}

function modalQty(d) {
  const el = $('#mq'); if (!el || !EXTRA_CTX) return;
  let n = Math.max(1, Math.min(20, Math.floor(Number(el.value) || 1) + d));
  el.value = n; EXTRA_CTX.qty = n;
  const t = $('#mt'); if (t) t.textContent = fmtBRL(EXTRA_CTX.unit * n);
}

async function confirmExtraPay(btn) {
  if (!EXTRA_CTX) return;
  modalQty(0);
  const { key, qty, unit } = EXTRA_CTX;
  const total = unit * qty;
  const m = document.querySelector('input[name="xpm"]:checked');
  const meio = m ? m.value : 'pix';

  if (meio === 'card') { closeModal(); return openCardPay('extra', key, total, qty); }
  if (meio === 'wallet') return payExtraWallet(key, qty, total);

  const txt = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = meio === 'boleto' ? 'Emitindo boleto…' : 'Gerando Pix…';
  try {
    const body = { key, qty, pay: meio };
    if (meio === 'boleto') {
      const doc = await pedirCpfCnpj();
      if (!doc) { btn.disabled = false; btn.innerHTML = txt; return; }
      body.taxId = doc;
    }
    const r = await api('/billing/extras', { body });
    if (meio === 'boleto') boletoModal(r.charge, () => afterExtraBought(key));
    else extraPixModal(r.charge);
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = txt;
  }
}

// O boleto sai no nome do titular: sem CPF/CNPJ o adquirente recusa a emissão.
function pedirCpfCnpj() {
  return new Promise(resolve => {
    const salvo = ((BILL_CACHE || {}).savedCard || {}).taxId || '';
    openModal(`
      <h2>${ico('user')} Dados do pagador</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        O boleto é emitido em nome do titular da conta. Informe o CPF ou CNPJ para prosseguir.
      </p>
      <label>CPF ou CNPJ<input id="bol-doc" inputmode="numeric" value="${esc(salvo)}" placeholder="000.000.000-00"></label>
      <div class="row" style="margin-top:14px">
        <button class="btn" onclick="closeModal();window.__docResolve&&window.__docResolve('')">Cancelar</button>
        <button class="btn primary" onclick="window.__docResolve&&window.__docResolve(($('#bol-doc').value||'').replace(/\\D/g,''))">Emitir boleto</button>
      </div>`);
    window.__docResolve = valor => {
      if (valor && valor.length !== 11 && valor.length !== 14) return toast('Informe um CPF ou CNPJ válido', 'error');
      window.__docResolve = null;
      resolve(valor);
    };
  });
}

// Boleto emitido: linha digitável, PDF e confirmação automática ao compensar.
function boletoModal(pc, aoPagar) {
  const venc = pc.dueDate ? new Date(pc.dueDate).toLocaleDateString('pt-BR') : '';
  openModal(`
    <h2>${ico('file')} Boleto emitido</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      <b style="color:var(--verde-deep)">${fmtBRL(pc.amount)}</b>${venc ? ` · vence em ${venc}` : ''}.
      A liberação é automática assim que o banco compensar o pagamento, o que costuma levar até 2 dias úteis.
    </p>
    ${pc.boletoLine ? `<label>Linha digitável<textarea readonly rows="2" style="font-size:12px;letter-spacing:.3px" onclick="this.select()">${esc(pc.boletoLine)}</textarea></label>` : ''}
    <div class="row" style="margin-top:10px">
      ${pc.boletoLine ? `<button class="btn no-grow" onclick="copyText(${JSON.stringify(esc(pc.boletoLine))})">${ico('copy', 13)} Copiar linha digitável</button>` : ''}
      ${pc.boletoUrl ? `<a class="btn primary no-grow" href="${esc(pc.boletoUrl)}" target="_blank" rel="noopener">${ico('link', 13)} Abrir boleto</a>` : ''}
    </div>
    <div class="row" style="margin-top:10px">
      <button class="btn no-grow" onclick="checkBoletoPago()">${ico('refresh', 13)} Já paguei</button>
      <button class="btn no-grow" onclick="closeModal()">Fechar</button>
    </div>
    <p class="muted" id="bol-status" style="font-size:12px;margin:12px 0 0">${ico('clock', 12)} Aguardando compensação bancária…</p>`);
  BOLETO_AFTER = aoPagar || null;
  clearInterval(extraPoll);
  extraPoll = setInterval(() => {
    if (!document.getElementById('bol-status')) return clearInterval(extraPoll);
    checkBoletoPago(true);
  }, 15000);
}
let BOLETO_AFTER = null;

async function checkBoletoPago(silencioso) {
  try {
    const r = await api('/billing/pending');
    if (r.paid) {
      clearInterval(extraPoll);
      closeModal();
      toast('Pagamento confirmado! 🎉');
      if (BOLETO_AFTER) BOLETO_AFTER();
      else paintBilling();
      BOLETO_AFTER = null;
    } else if (!silencioso) {
      const el = $('#bol-status');
      if (el) el.innerHTML = `${ico('clock', 12)} O banco ainda não informou a compensação. Boletos costumam levar até 2 dias úteis após o pagamento.`;
    }
  } catch (e) { if (!silencioso) toast(e.message, 'error'); }
}

// QR do Pix dentro do próprio pop-up, com confirmação automática.
function extraPixModal(pc) {
  const img = pc.qrCodeImage ? esc(pc.qrCodeImage) : localQrDataUrl(pc.brCode);
  openModal(`
    <h2>${ico('zap')} Pague o Pix para liberar</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">
      ${fmtN(pc.extraQty)}x ${esc(extraLabel(pc.extraKey))}, <b style="color:var(--verde-deep)">${fmtBRL(pc.amount)}</b>.
      Libera automaticamente assim que o pagamento cair.
    </p>
    <div class="pay-qr" style="margin:0 auto 12px">${img
      ? `<img src="${img}" alt="QR Code Pix">`
      : `<div class="pay-qr-ph">${ico('clock', 26)}</div>`}</div>
    ${pc.brCode ? `<label>Pix copia-e-cola<textarea readonly rows="3" style="font-size:11px" onclick="this.select()">${esc(pc.brCode)}</textarea></label>` : ''}
    <div class="row" style="margin-top:10px">
      ${pc.brCode ? `<button class="btn no-grow" onclick="copyText(${JSON.stringify(esc(pc.brCode))})">${ico('copy', 13)} Copiar código</button>` : ''}
      <button class="btn no-grow" onclick="checkExtraPix(true)">${ico('refresh', 13)} Já paguei</button>
      <button class="btn danger no-grow" onclick="cancelExtraPix()">Cancelar</button>
    </div>
    <p class="muted" id="xpix-status" style="font-size:12px;margin:10px 0 0">${ico('clock', 12)} Aguardando pagamento…</p>`);
  clearInterval(extraPoll);
  extraPoll = setInterval(() => {
    if (!document.getElementById('xpix-status')) return clearInterval(extraPoll);
    checkExtraPix(false);
  }, 5000);
}

async function checkExtraPix(manual) {
  try {
    const r = await api('/billing/pending');
    if (r.paid) {
      clearInterval(extraPoll);
      closeModal();
      toast('Pagamento confirmado! 🎉');
      afterExtraBought(EXTRA_CTX ? EXTRA_CTX.key : 'whatsapps');
    } else if (manual) {
      const el = $('#xpix-status');
      if (el) el.innerHTML = `${ico('clock', 12)} Ainda não identificamos o pagamento (${esc(r.status || 'aguardando')}). Confirma em segundos após o Pix.`;
    }
  } catch (e) { if (manual) toast(e.message, 'error'); }
}

async function cancelExtraPix() {
  clearInterval(extraPoll);
  try { await api('/billing/pending/cancel', { body: {} }); } catch {}
  closeModal();
}

// Assinar/renovar abatendo do saldo da carteira (dinheiro das vendas no cartão).
async function payWithWallet(planId) {
  const d = BILL_CACHE || {};
  const p = (d.plans || []).find(x => x.id === planId) || {};
  const total = (p.price || 0) + (d.extrasCost || 0);
  const ok = await confirmModal({
    title: 'Pagar o plano com o saldo?',
    text: `${p.name || 'Plano'}, ${fmtBRLp(total)} serão debitados da carteira. Saldo atual: ${fmtBRLp((d.wallet || {}).balance || 0)}.`,
    ok: 'Confirmar'
  });
  if (!ok) return;
  try {
    await api('/billing/subscribe-wallet', { body: { planId } });
    toast('Assinatura ativada com o saldo! 🎉');
    paintBilling();
  } catch (e) { toast(e.message, 'error'); }
}

// confirmModal usa esc() no texto — usa o valor já formatado sem HTML
function fmtBRLp(c) { return (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

// ---------------------------------------------------------------------------
// Formulário de cartão (assinatura do plano ou compra de extras)
// ---------------------------------------------------------------------------
let CARD_CTX = null;

function openCardPay(mode, id, amount, qty) {
  const d = BILL_CACHE || {};
  const c = d.card || {};
  if (!c.credit) return toast('Pagamento com cartão indisponível', 'error');
  CARD_CTX = { mode, id, amount, qty: qty || 1 };
  const maxP = Math.max(1, c.maxInstallments || 1);

  // CARTÃO JÁ CADASTRADO NA FATURA
  //
  // Quem já pagou o EliteChat no cartão não deveria digitar tudo de novo.
  // `reusable` só é verdadeiro quando o adquirente devolveu um identificador
  // reaproveitável — aí a compra sai em um clique. Quando não devolveu (a
  // tokenização da Asaas, por exemplo, precisa ser liberada na conta), ainda
  // assim conhecemos o titular e o CPF/CNPJ, e o formulário já vem preenchido:
  // só o número, a validade e o CVV ficam para o cliente.
  const s = d.savedCard || {};
  const temCartao = !!(s.last4 && s.reusable);
  const rotulo = `${esc(s.brand || 'Cartão')} •••• ${esc(s.last4 || '')}`;

  openModal(`
    <h2>${ico('card')} Pagar no cartão</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      ${mode === 'plan' ? 'Assinatura do EliteChat' : `${qty}x ${esc(extraLabel(id))}`}
     , <b style="color:var(--verde-deep)">${fmtBRL(amount)}</b>. A ativação é imediata após a aprovação.
    </p>
    ${temCartao ? `<div class="pay-methods" style="margin-bottom:14px">
      <label class="pay-method">
        <input type="radio" name="cpsrc" value="saved" checked onchange="cardSrcToggle()">
        <span><b>${ico('card', 13)} Usar ${rotulo}</b><em>O cartão que você já cadastrou na fatura</em></span>
      </label>
      <label class="pay-method">
        <input type="radio" name="cpsrc" value="new" onchange="cardSrcToggle()">
        <span><b>Usar outro cartão</b><em>Passa a valer também para as próximas renovações</em></span>
      </label>
    </div>` : ''}
    <div id="cp-form" ${temCartao ? 'hidden' : ''}>
    ${!temCartao && s.last4 ? `<p class="hint" style="margin:0 0 10px;text-align:left">
      ${ico('info', 12)} Cartão da sua fatura: <b>${rotulo}</b>. O adquirente não permite cobrar de novo sem os dados, então confirme o número abaixo.</p>` : ''}
    <label>Número do cartão<input id="cp-num" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000" oninput="maskCardNum(this)"></label>
    <label>Nome impresso no cartão<input id="cp-holder" autocomplete="cc-name" placeholder="COMO ESTÁ NO CARTÃO" value="${esc(s.holderName || '')}"></label>
    <div class="row">
      <label style="max-width:110px">Mês<input id="cp-mm" inputmode="numeric" maxlength="2" placeholder="MM"></label>
      <label style="max-width:110px">Ano<input id="cp-yy" inputmode="numeric" maxlength="4" placeholder="AAAA"></label>
      <label style="max-width:110px">CVV<input id="cp-cvv" inputmode="numeric" maxlength="4" placeholder="123"></label>
    </div>
    <label>CPF ou CNPJ do titular<input id="cp-doc" inputmode="numeric" placeholder="000.000.000-00" value="${esc(s.taxId || '')}"></label>
    </div>
    <label id="cp-inst-wrap">Parcelas
      <select id="cp-inst">${Array.from({ length: maxP }, (_, i) =>
        `<option value="${i + 1}">${i + 1}x de ${fmtBRL(Math.round(amount / (i + 1)))}${i ? '' : ' à vista'}</option>`).join('')}</select>
    </label>
    <p class="hint" style="margin-top:10px">${ico('lock', 12)} Os dados vão direto para o adquirente, o EliteChat guarda só a bandeira e os 4 últimos dígitos para renovar.</p>
    <div class="row" style="margin-top:14px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="submitCardPay(this)">${ico('lock', 14)} Pagar ${fmtBRL(amount)}</button>
    </div>`);
}

// Mostra ou esconde o formulário conforme a escolha entre o cartão salvo e um
// cartão novo. As parcelas ficam de fora: valem para os dois casos.
function cardSrcToggle() {
  const novo = usandoCartaoNovo();
  const f = $('#cp-form');
  if (f) f.hidden = !novo;
}

function usandoCartaoNovo() {
  const r = document.querySelector('input[name="cpsrc"]:checked');
  return !r || r.value === 'new';
}

function maskCardNum(el) {
  el.value = el.value.replace(/\D/g, '').slice(0, 19).replace(/(.{4})/g, '$1 ').trim();
}

async function submitCardPay(btn) {
  const ctx = CARD_CTX; if (!ctx) return;
  const novo = usandoCartaoNovo();
  const salvo = ((BILL_CACHE || {}).savedCard) || {};
  const nome = novo ? (($('#cp-holder') || {}).value || '').trim() : (salvo.holderName || '');
  const doc = novo ? (($('#cp-doc') || {}).value || '').replace(/\D/g, '') : (salvo.taxId || '');

  const body = {
    kind: 'credit',
    installments: Number(($('#cp-inst') || {}).value || 1),
    // No cartão salvo nada do cartão viaja: o servidor usa o identificador que
    // guardou do adquirente.
    useSaved: !novo,
    card: novo ? {
      number: ($('#cp-num').value || '').replace(/\D/g, ''),
      holderName: nome,
      expMonth: ($('#cp-mm').value || '').trim(),
      expYear: ($('#cp-yy').value || '').trim(),
      cvv: ($('#cp-cvv').value || '').trim()
    } : undefined,
    customer: { name: nome, taxId: doc }
  };
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Processando…';
  try {
    if (ctx.mode === 'plan') await api('/billing/subscribe-card', { body: { ...body, planId: ctx.id } });
    else await api('/billing/extras', { body: { ...body, key: ctx.id, qty: ctx.qty } });
    closeModal();
    // o cartão acabou de ser salvo: o cache precisa reler para a próxima
    // compra já oferecer "usar o cartão salvo"
    BILL_CACHE = null;
    toast(ctx.mode === 'plan' ? 'Assinatura ativada! 🎉' : 'Contratado! Já pode usar.');
    if (ctx.mode === 'plan') paintBilling();
    else afterExtraBought(ctx.id);
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = txt;
  }
}

// QR do Pix inline (sem pop-up) + copia-e-cola + polling
// Gera a IMAGEM do QR no navegador a partir do BR Code EMV (Pix Indireto não
// devolve imagem pronta; devolve o EMV, que é o conteúdo do QR). Usa a lib
// vendorizada qrcode-generator (MIT) carregada em /app/vendor/qrcode.js.
function localQrDataUrl(brCode) {
  try {
    if (typeof qrcode !== 'function' || !brCode) return '';
    const qr = qrcode(0, 'M');           // typeNumber automático, correção M (padrão Pix)
    qr.addData(String(brCode));
    qr.make();
    return qr.createDataURL(5, 12);
  } catch { return ''; }
}

function payBoxHtml(pc) {
  return `<div class="card pay-card" id="pay-card">
    <div class="pay-grid">
      <div class="pay-qr" id="pay-qr-box">${pc.qrCodeImage
        ? `<img src="${esc(pc.qrCodeImage)}" alt="QR Code Pix">`
        : pc.brCode
          ? `<img src="${localQrDataUrl(pc.brCode)}" alt="QR Code Pix">`
          : `<div class="pay-qr-ph">${ico('clock', 26)}</div>`}</div>
      <div style="flex:1;min-width:0">
        <h2 style="margin:0 0 4px">${ico('zap')} Pague com Pix para ativar</h2>
        <p class="muted" style="margin:0 0 10px;font-size:13px">${pc.kind === 'topup' ? 'Recarga de saldo' : 'Assinatura'}, <b>${fmtBRL(pc.amount)}</b>. Escaneie o QR ou use o copia-e-cola. A confirmação é automática.</p>
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
    toast('Cobrança Pix gerada, escaneie o QR para ativar');
    paintBilling();
    setTimeout(() => $('#pay-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
  } catch (e) { toast(e.message, 'error'); }
}
// Assinar o plano no boleto: emite e mostra a linha digitável no pop-up.
async function subscribeBoleto(planId) {
  const doc = await pedirCpfCnpj();
  if (!doc) return;
  try {
    const r = await api('/billing/subscribe-boleto', { body: { planId, taxId: doc } });
    boletoModal(r.charge, () => paintBilling());
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
      <button data-tab="adm-ep" onclick="showSettingsTab('adm-ep');admEpPaint()">Elite Pay</button>
      <button data-tab="adm-int" onclick="showSettingsTab('adm-int');admIntLoad()">Integrações</button>
      <button data-tab="adm-plat" onclick="showSettingsTab('adm-plat')">Plataforma</button>
      <button data-tab="adm-seo" onclick="showSettingsTab('adm-seo')">SEO</button>
    </div>
    <div id="adm-box"><div class="card">${skel(6)}</div></div>
  </div>`;
  paintAdmin();
}


// ---------------------------------------------------------------------------
// PLATAFORMA (Admin SaaS). Credenciais do app da Meta usadas pelo Embedded
// Signup do WhatsApp e pelo OAuth do Meta Ads. Fica SO aqui: o cliente nunca
// ve nem preenche nada disso, ele so clica em "Conectar".
// ---------------------------------------------------------------------------
  function admPlatformCard(p, m, origin) {
  return `
      <div class="card">
        <h2>${ico('key')} Plataforma. Embedded Signup (Tech Provider)</h2>
        <p class="muted" style="margin:0 0 12px">Credenciais do <b>app da Meta da plataforma</b>. Seus clientes nunca preenchem nada, eles só clicam em "Conectar WhatsApp".</p>
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
        <h2>${ico('trend')} Meta Ads (Tracking, permissão ads_read)</h2>
        <p class="muted" style="margin:0 0 12px">Para os clientes conectarem a conta de anúncios pelo botão <b>"Conectar Meta Ads"</b> no Tracking. Por padrão usa o <b>mesmo app da Meta acima</b> (o do WhatsApp), então normalmente você <b>não precisa preencher nada aqui</b>.</p>
        <div class="capi-box" style="margin-bottom:14px">
          <div class="capi-head">${ico('shield', 14)} O que o app da Meta precisa ter <span class="capi-tag">obrigatório</span></div>
          <p class="muted" style="font-size:12px;margin:6px 0 0">1. Produto <b>Login do Facebook</b> adicionado ao app.
          2. Permissão <b>ads_read</b> aprovada (App Review).
          3. A <b>URL de redirecionamento</b> abaixo cadastrada em <b>Login do Facebook → Configurações → URIs de redirecionamento OAuth válidos</b>.
          4. App em <b>modo Live</b> e servido por <b>HTTPS</b>.</p>
        </div>
        <label>URL de redirecionamento OAuth (cole no painel da Meta)</label>
        <div class="copy-box"><code id="ads-cb">${esc(origin)}/auth/meta-ads/callback</code><button class="btn small" onclick="copyText($('#ads-cb').textContent)">Copiar</button></div>
        <details class="adv" style="margin-top:14px">
          <summary class="muted" style="cursor:pointer;font-size:13px;font-weight:700">Usar um app da Meta SEPARADO para anúncios (opcional)</summary>
          <p class="muted" style="margin:8px 0 10px;font-size:12.5px">Só preencha se o seu <code>ads_read</code> está em um app diferente do WhatsApp. Vazio = reaproveita o app acima.</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label>App ID (Meta Ads)<input id="pl-ads-appid" value="${esc((p.metaAds || {}).appId || '')}" placeholder="deixe vazio p/ usar o do WhatsApp"></label>
            <label>App Secret (Meta Ads)<input id="pl-ads-secret" type="password" value="${esc((p.metaAds || {}).appSecret || '')}" placeholder="deixe vazio p/ usar o do WhatsApp"></label>
          </div>
          <p class="hint" style="margin-top:8px">Depois de preencher, clique em <b>Salvar plataforma</b> acima.</p>
        </details>
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
}
async function paintAdmin() {
  const box = $('#adm-box'); if (!box) return;
  try {
    const d = await api('/admin/saas');
    const m = d.metrics;
    const ad = d.advanced || {};
    const S = d.series || [];
    const activeTab = $('.tabs button.active')?.dataset.tab || 'adm-vis';
    box.innerHTML = `
      <div class="tabpane ${activeTab === 'adm-vis' ? 'show' : ''}" data-pane="adm-vis">
        <div class="metric-hero">
          <div class="mh-card hi"><span class="mh-ic">${ico('zap', 20)}</span><div class="mh-val">${fmtBRL(m.mrr)}</div><div class="mh-lbl">MRR (receita recorrente)</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('activity', 20)}</span><div class="mh-val">${fmtBRL(m.revenue30d)}</div><div class="mh-lbl">Receita. 30 dias</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('briefcase', 20)}</span><div class="mh-val">${fmtBRL(m.totalRevenue)}</div><div class="mh-lbl">Receita total</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('users', 20)}</span><div class="mh-val">${fmtN(m.accounts)}</div><div class="mh-lbl">Contas</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('check', 20)}</span><div class="mh-val">${fmtN(m.activeSubs)}</div><div class="mh-lbl">Assinaturas ativas</div></div>
          <div class="mh-card"><span class="mh-ic">${ico('clock', 20)}</span><div class="mh-val">${fmtN(m.trials)}</div><div class="mh-lbl">Em teste</div></div>
        </div>

        <div class="kpi-strip">
          <div class="kpi-mini"><span>ARPU</span><b>${fmtBRL(ad.arpu)}</b><em>por assinante ativo</em></div>
          <div class="kpi-mini"><span>Ticket médio</span><b>${fmtBRL(ad.avgTicket)}</b><em>por pagamento</em></div>
          <div class="kpi-mini"><span>Conversão</span><b>${ad.conversion || 0}%</b><em>contas → assinantes</em></div>
          <div class="kpi-mini ${(ad.momGrowth || 0) >= 0 ? 'up' : 'down'}"><span>Crescimento (MoM)</span><b>${(ad.momGrowth || 0) >= 0 ? '+' : ''}${ad.momGrowth || 0}%</b><em>receita vs mês anterior</em></div>
          <div class="kpi-mini"><span>Novas assinaturas</span><b>${fmtN(ad.newSubs30d)}</b><em>últimos 30 dias</em></div>
          <div class="kpi-mini"><span>Renovações</span><b>${fmtN(ad.renewals30d)}</b><em>últimos 30 dias</em></div>
          <div class="kpi-mini"><span>Depósitos (carteira)</span><b>${fmtBRL(m.deposits)}</b><em>recargas incluídas na receita</em></div>
        </div>

        <div class="card">
          <div class="row" style="align-items:center;margin-bottom:4px">
            <h2 style="margin:0;flex:1">${ico('activity')} Receita. 12 meses</h2>
            <div class="chart-legend"><span><i class="lg-first"></i>Novas</span><span><i class="lg-renewal"></i>Renovações</span><span><i class="lg-topup"></i>Recargas</span></div>
          </div>
          <div class="bar-chart">
            ${(() => { const mx = Math.max(1, ...S.map(x => x.total)); const h = v => Math.round((v || 0) / mx * 100); return S.map(s => `
              <div class="bar-col" title="${esc(s.label)}: ${fmtBRL(s.total)}&#10;Novas ${fmtBRL(s.first)} · Renov. ${fmtBRL(s.renewal)} · Recargas ${fmtBRL(s.topup)}">
                <div class="bar-stack">
                  <div class="bar-seg seg-topup" style="height:${h(s.topup)}%"></div>
                  <div class="bar-seg seg-renewal" style="height:${h(s.renewal)}%"></div>
                  <div class="bar-seg seg-first" style="height:${h(s.first)}%"></div>
                </div>
                <span class="bar-x">${esc(s.label)}</span>
              </div>`).join(''); })()}
          </div>
        </div>

        <div class="two-col even">
          <div class="card">
            <h2 style="margin:0 0 10px">${ico('users')} Novas contas. 12 meses</h2>
            <div class="bar-chart sm">
              ${(() => { const mx = Math.max(1, ...S.map(x => x.newAccounts)); return S.map(s => `
                <div class="bar-col" title="${esc(s.label)}: ${fmtN(s.newAccounts)} conta(s)">
                  <div class="bar-stack"><div class="bar-seg seg-acct" style="height:${Math.round((s.newAccounts || 0) / mx * 100)}%"></div></div>
                  <span class="bar-x">${esc(s.label)}</span>
                </div>`).join(''); })()}
            </div>
          </div>
          <div class="card">
            <h2 style="margin:0 0 12px">${ico('columns')} MRR por plano</h2>
            ${(d.byPlan && d.byPlan.length) ? (() => { const mx = Math.max(1, ...d.byPlan.map(x => x.mrr)); return d.byPlan.map(p => `
              <div class="ep-volrow"><span>${esc(p.name)} <em style="color:var(--muted);font-weight:600;font-style:normal">· ${fmtN(p.subscribers)}</em></span>
                <div class="ep-volbar"><i style="width:${Math.max(2, Math.round(p.mrr / mx * 100))}%"></i></div>
                <b>${fmtBRL(p.mrr)}</b></div>`).join(''); })() : '<p class="muted">Nenhum plano com assinantes ativos.</p>'}
          </div>
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
          ${planFeatureFields('new', null)}
          ${planLimitFields('new', null)}
          <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn primary no-grow" onclick="admCreatePlan()">${ico('save', 14)} Criar plano</button></div>
        </div>

        <div class="card">
          <h2>${ico('card')} Preço das unidades extras</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">
            Todo plano já inclui <b>X conexões WhatsApp</b> e <b>Y links rastreáveis</b> (definidos acima, por plano).
            Acima disso o cliente compra avulso, e é <b>você</b> quem define o preço de cada unidade aqui.
          </p>
          <div class="row" style="align-items:flex-end">
            <label style="max-width:230px">WhatsApp adicional (R$/mês)<input id="ex-wa" value="${((d.config.billing.extras && d.config.billing.extras.whatsappPrice || 0) / 100).toFixed(2)}" inputmode="decimal" placeholder="0,00"></label>
            <label style="max-width:230px">Link rastreável adicional (R$/mês)<input id="ex-lk" value="${((d.config.billing.extras && d.config.billing.extras.linkPrice || 0) / 100).toFixed(2)}" inputmode="decimal" placeholder="0,00"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({whatsappPrice:$('#ex-wa').value,linkPrice:$('#ex-lk').value})">${ico('save', 14)} Salvar preços</button>
          </div>
          <p class="hint" style="margin-top:10px">Com <b>R$ 0,00</b> o extra fica indisponível para compra, o cliente só consegue mais fazendo upgrade de plano.</p>
        </div>

        <div class="card">
          <h2>${ico('columns')} Planos publicados</h2>
          ${d.plans.filter(p => !p.archived).length ? d.plans.filter(p => !p.archived).map(p => {
            const subs = d.accounts.filter(a => a.billing.planId === p.id && a.billing.status === 'active').length;
            return `<div class="plan-row">
              <div class="plan-head">
                <div style="flex:1;min-width:0">
                  <b style="font-size:15px">${esc(p.name)}</b>
                  <div class="muted" style="font-size:11.5px;margin-top:2px">${fmtBRL(p.price)} / ${p.periodDays}d · ${fmtN(subs)} assinante(s)</div>
                </div>
                <button class="btn small no-grow" onclick="admTogglePlan('${p.id}')">${ico('edit', 13)} Limites</button>
                <button class="icon-btn danger" title="Arquivar" onclick="admDelPlan('${p.id}')">${ico('trash', 14)}</button>
              </div>
              <div class="plan-lims">
                ${planFeatureBadge(p)}
                ${LIMIT_META.map(m => {
                const v = (p.limits || {})[m.key];
                return `<span class="pill ${v === 0 ? 'pending' : ''}">${m.short}: <b>${v === -1 || v === undefined ? '∞' : fmtN(v)}</b></span>`;
              }).join('')}</div>
              <div class="plan-edit hidden" id="pl-ed-${p.id}">
                ${planFeatureFields(p.id, p.modules || null)}
                ${planLimitFields(p.id, p.limits || {})}
                <div class="row" style="margin-top:10px;justify-content:flex-end">
                  <button class="btn primary no-grow" onclick="admSavePlanLimits('${p.id}')">${ico('save', 14)} Salvar limites</button>
                </div>
              </div>
            </div>`;
          }).join('') : '<p class="muted">Nenhum plano ainda, crie o primeiro acima.</p>'}
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-aff' ? 'show' : ''}" data-pane="adm-aff">
        <div class="card">
          <h2>${ico('sparkles')} Programa de afiliados</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Todo cliente tem um link de indicação. A comissão cai na carteira do afiliado <b>automaticamente</b> a cada pagamento confirmado do indicado, na primeira assinatura e em toda renovação.</p>
          <div class="row">
            <label>% na 1ª assinatura<input id="aff-first" value="${d.config.affiliate.percentFirst}" inputmode="numeric"></label>
            <label>% nas renovações<input id="aff-ren" value="${d.config.affiliate.percentRenewal}" inputmode="numeric"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({percentFirst:$('#aff-first').value,percentRenewal:$('#aff-ren').value})">${ico('save', 14)} Salvar</button>
          </div>
        </div>

        <div class="card">
          <h2>${ico('download-circle')} Limites de saque</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">
            Faixa aceita quando o afiliado saca a comissão da carteira para a chave Pix dele.
            O máximo vale <b>por saque</b>, não por período — ele pode sacar de novo depois.
          </p>
          <div class="row" style="align-items:flex-end">
            <label>Saque mínimo (R$)<input id="wd-min" value="${(d.config.affiliate.withdraw.min / 100).toFixed(2)}" inputmode="decimal"></label>
            <label>Saque máximo (R$)<input id="wd-max" value="${d.config.affiliate.withdraw.max ? (d.config.affiliate.withdraw.max / 100).toFixed(2) : ''}" inputmode="decimal" placeholder="sem limite"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({withdrawMin:$('#wd-min').value,withdrawMax:$('#wd-max').value||0})">${ico('save', 14)} Salvar</button>
          </div>
          <p class="muted" style="font-size:11.5px;margin:8px 0 0">Máximo vazio ou <b>0</b> = sem teto.</p>
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
          <h2>${ico('shield')} Woovi. Pix &amp; Pix Automático</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Crie uma conta em <b>app.woovi.com</b>, gere um <b>AppID</b> em API/Plugins → Nova integração e cole abaixo. Método de pagamento: <b>apenas Pix</b> (cobrança na hora) e <b>Pix Automático</b> (recorrência), sem cartão.</p>
          <div class="row">
            <label style="flex:2">AppID da Woovi ${d.config.woovi.configured ? `<span class="pill done" style="margin-left:6px">Configurado ${esc(d.config.woovi.appId)}</span>` : ''}<input id="wv-appid" type="password" placeholder="Q2xpZW50X0lkX…"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({wooviAppId:$('#wv-appid').value})">${ico('save', 14)} Salvar</button>
            <button class="btn no-grow" onclick="admTestWoovi(this)">${ico('activity', 14)} Testar conexão</button>
          </div>
          <label class="chk" style="margin-top:12px"><input type="checkbox" id="wv-auto" ${d.config.woovi.pixAutomatic ? 'checked' : ''} onchange="admSaveConfig({pixAutomatic:this.checked})"> Tentar Pix Automático (assinatura recorrente), se indisponível, cai para Pix avulso por renovação</label>
          <div class="capi-box" style="margin-top:14px">
            <div class="capi-head">${ico('webhook', 14)} Webhook de confirmação <span class="capi-tag">obrigatório em produção</span></div>
            <p class="muted" style="font-size:12px;margin:6px 0 0">Em app.woovi.com → Webhooks, cadastre a URL <code>${API.webOrigin}/woovi-webhook</code> para os eventos de <b>cobrança paga</b>. Cada pagamento é verificado de novo na API antes de ativar (anti-fraude).</p>
          </div>
        </div>
        ${admCardSection(d.card || {}, null)}
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

        <div class="card">
          <h2>${ico('plus')} Depósito na carteira</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">
            Faixa aceita quando o cliente recarrega o saldo pelo botão <b>+</b> no topo do painel.
            O valor é cobrado por Pix e cai na carteira ao confirmar o pagamento.
          </p>
          <div class="row" style="align-items:flex-end">
            <label>Depósito mínimo (R$)<input id="dep-min" value="${(d.config.billing.deposit.min / 100).toFixed(2)}" inputmode="decimal"></label>
            <label>Depósito máximo (R$)<input id="dep-max" value="${d.config.billing.deposit.max ? (d.config.billing.deposit.max / 100).toFixed(2) : ''}" inputmode="decimal" placeholder="sem limite"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({depositMin:$('#dep-min').value,depositMax:$('#dep-max').value||0})">${ico('save', 14)} Salvar</button>
          </div>
          <p class="muted" style="font-size:11.5px;margin:8px 0 0">Máximo vazio ou <b>0</b> = sem teto.</p>
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

      <div class="tabpane ${activeTab === 'adm-ep' ? 'show' : ''}" data-pane="adm-ep">
        <div id="adm-ep-box">${skel(5)}</div>
      </div>

      <div class="tabpane ${activeTab === 'adm-int' ? 'show' : ''}" data-pane="adm-int">
        <div id="adm-int-box">${skel(4)}</div>
        <div id="adm-sms-box" style="margin-top:16px">${skel(3)}</div>
      </div>

      <div class="tabpane ${activeTab === 'adm-plat' ? 'show' : ''}" data-pane="adm-plat">
        ${admPlatformCard(d.platform || {}, d.manual || {}, API.webOrigin)}
      </div>

      <div class="tabpane ${activeTab === 'adm-seo' ? 'show' : ''}" data-pane="adm-seo">
        ${admSeoForm(d.seo || {})}
      </div>`;
    if (activeTab === 'adm-ep') admEpPaint();
    if (activeTab === 'adm-int') admIntLoad();
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// ---- LIMITES DE PLANO (admin) ----
// Vazio = ilimitado. WhatsApp e Links são "inclusos"; o excedente é vendido
// avulso pelo preço definido no card "Preço das unidades extras".
// Funcionalidades que cada plano liga/desliga (toggle). O que nao esta aqui
// (conversas, contatos, funil, modelos, LGPD) e essencial e vem em todo plano.
const FEATURE_META = [
  { key: 'campaigns',    label: 'Campanhas em massa' },
  { key: 'flows',        label: 'Automações (Flow Builder)' },
  { key: 'schedule',     label: 'Agendamentos' },
  { key: 'team',         label: 'Chat interno' },
  { key: 'agents',       label: 'Atendentes (equipe)' },
  { key: 'elitepay',     label: 'Elite Pay (cobranças)' },
  { key: 'links',        label: 'Links rastreáveis' },
  { key: 'pixels',       label: 'Pixels de rastreamento' },
  { key: 'tracking',     label: 'Tracking (atribuição)' },
  { key: 'integrations', label: 'Integrações' },
  { key: 'sms',          label: 'Disparos de SMS' }
];

// Grade de toggles: um por funcionalidade. Sem texto livre, sem erro de digitação.
function planFeatureFields(scope, mods) {
  const on = k => !mods || mods[k] !== false;
  const linhas = FEATURE_META.map(m =>
    `<label class="chk feat-row"><input type="checkbox" id="feat-${scope}-${m.key}" ${on(m.key) ? 'checked' : ''}><span>${esc(m.label)}</span></label>`).join('');
  return `<div class="lim-box" style="margin-top:10px"><div class="lim-head">${ico('zap', 13)} Funcionalidades do plano <span class="lim-hint">ligado = incluso</span></div><div class="feat-grid">${linhas}</div></div>`;
}

function readFeatureFields(scope) {
  const out = {};
  for (const m of FEATURE_META) {
    const el = document.getElementById('feat-' + scope + '-' + m.key);
    if (el) out[m.key] = !!el.checked;
  }
  return out;
}

// Resumo para a lista de planos: quantas funcoes ficaram de fora.
function planFeatureBadge(p) {
  const off = FEATURE_META.filter(m => p.modules && p.modules[m.key] === false);
  if (!off.length) return '<span class="pill done">todas as funções</span>';
  return `<span class="pill pending" title="Fora: ${esc(off.map(x => x.label).join(', '))}">${off.length} função(ões) fora</span>`;
}
const LIMIT_META = [
  { key: 'sends',     label: 'Disparos por ciclo',        short: 'Disparos', ph: 'ilimitado' },
  { key: 'contacts',  label: 'Contatos (leads)',          short: 'Leads',    ph: 'ilimitado' },
  { key: 'flows',     label: 'Fluxos de automação',       short: 'Fluxos',   ph: 'ilimitado' },
  { key: 'pixels',    label: 'Pixels de rastreamento',    short: 'Pixels',   ph: 'ilimitado' },
  // `buy` é como o item é chamado na hora de contratar unidades a mais — os
  // rótulos acima descrevem o que o PLANO inclui, e ficam estranhos no "Contratar…".
  { key: 'links',     label: 'Links rastreáveis grátis',  short: 'Links',    ph: '1', extra: true, buy: 'links rastreáveis' },
  { key: 'whatsapps', label: 'WhatsApps inclusos',        short: 'WhatsApp', ph: '1', extra: true, buy: 'conexões de WhatsApp' },
  { key: 'sms',       label: 'SMS por ciclo',             short: 'SMS',      ph: '0' }
];

function planLimitFields(scope, lims) {
  const val = k => {
    if (!lims) return '';
    const v = lims[k];
    return v === -1 || v === undefined ? '' : String(v);
  };
  return `<div class="lim-box">
    <div class="lim-head">${ico('shield', 13)} Limites do plano <span class="lim-hint">vazio = ilimitado · 0 = bloqueado</span></div>
    <div class="lim-grid">
      ${LIMIT_META.map(m => `<label>${m.label}${m.extra ? ' <em class="lim-extra">+ extras pagos</em>' : ''}
        <input id="lim-${scope}-${m.key}" value="${val(m.key)}" inputmode="numeric" placeholder="${m.ph}"></label>`).join('')}
    </div>
  </div>`;
}

function readLimitFields(scope) {
  const out = {};
  for (const m of LIMIT_META) {
    const el = $(`#lim-${scope}-${m.key}`);
    if (el) out[m.key] = el.value;
  }
  return out;
}

function admTogglePlan(id) {
  const el = $('#pl-ed-' + id);
  if (el) el.classList.toggle('hidden');
}

async function admSavePlanLimits(id) {
  try {
    await api('/admin/plans/' + id, { method: 'PUT', body: { limits: readLimitFields(id), modules: readFeatureFields(id) } });
    toast('Funcionalidades e limites atualizados'); paintAdmin();
    setTimeout(() => showSettingsTab('adm-pl'), 60);
  } catch (e) { toast(e.message, 'error'); }
}

async function admCreatePlan() {
  try {
    await api('/admin/plans', { body: { name: $('#pl-name').value, price: $('#pl-price').value, periodDays: $('#pl-days').value, modules: readFeatureFields('new'), limits: readLimitFields('new') } });
    toast('Plano criado!'); paintAdmin();
    setTimeout(() => showSettingsTab('adm-pl'), 60);
  } catch (e) { toast(e.message, 'error'); }
}
async function admDelPlan(id) {
  if (!await confirmModal({ title: 'Arquivar plano', text: 'Novos clientes não poderão assiná-lo. Assinantes atuais continuam até cancelarem.', ok: 'Arquivar', danger: true })) return;
  try { await api('/admin/plans/' + id, { method: 'DELETE' }); paintAdmin(); setTimeout(() => showSettingsTab('adm-pl'), 60); } catch (e) { toast(e.message, 'error'); }
}
// ---- Admin → Integrações da PLATAFORMA ----
// Reúne o que a plataforma conecta uma vez e oferece a todos os clientes: a
// loja Nuvemshop e os disparos de SMS da Integra X.
function admIntLoad() {
  admNsLoad();
  admSmsLoad();
}

// Um interruptor liga o SMS para os clientes; o token e o remetente são da
// plataforma e nunca voltam para o navegador.
let admSms = null;
async function admSmsLoad() {
  const box = $('#adm-sms-box'); if (!box) return;
  try { admSms = (await api('/admin/sms')).sms; }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  admSmsPaint();
}

function admSmsPaint() {
  const box = $('#adm-sms-box'); if (!box || !admSms) return;
  const c = admSms;
  const b = c.lastBalance;
  box.innerHTML = `
  <div class="card">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="margin:0;flex:1">${ico('message')} Disparos de SMS · Integra X</h2>
      <span class="pill ${c.configured ? 'done' : 'pending'}">${c.configured ? 'ativo' : c.enabled ? 'falta o token' : 'desligado'}</span>
    </div>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      Com o interruptor ligado, os planos que incluem o módulo <b>SMS</b> passam a exibir a
      tela de disparos no painel do cliente. O crédito é consumido da conta da plataforma
      na Integra X.
    </p>

    <label class="chk"><input type="checkbox" ${c.enabled ? 'checked' : ''}
      onchange="admSmsSave({enabled:this.checked})"> Oferecer SMS aos clientes</label>

    <div class="capi-box" style="margin-top:16px">
      <div class="capi-head">${ico('lock', 14)} Credenciais da Integra X
        <span class="capi-tag">${c.hasToken ? 'token salvo' : 'pendente'}</span></div>
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <label style="flex:1.4">Token da integração <em class="lim-extra">painel da Integra X → /dashboard/external</em>
          <input id="sms-token" type="password" placeholder="${c.hasToken ? '•••••••• (mantém o atual)' : 'cole o token aqui'}"></label>
        <label style="max-width:190px">Remetente <em class="lim-extra">short code</em>
          <input id="sms-from" value="${esc(c.from)}" placeholder="ex.: 29094"></label>
      </div>
      <div class="row" style="margin-top:10px;align-items:flex-end">
        <label style="flex:1">URL da API <em class="lim-extra">deixe vazio para o padrão</em>
          <input id="sms-base" value="${esc(c.base)}" placeholder="${esc(c.baseEfetiva)}"></label>
        <button class="btn primary no-grow" onclick="admSmsSaveForm(this)">${ico('save', 14)} Salvar</button>
      </div>
      <p class="hint" style="margin:10px 0 0">${ico('lock', 12)}
        O token da Integra X viaja <b>dentro do endereço</b> (<code>${esc(c.rotas ? c.rotas.enviar : '')}</code>),
        então ele nunca aparece em log nem em mensagem de erro.</p>
      <div class="row" style="margin-top:10px">
        <button class="btn no-grow" onclick="admSmsTest(this)">${ico('activity', 13)} Testar conexão</button>
        ${c.hasToken ? `<button class="btn danger no-grow" onclick="admSmsClearToken()">Remover token</button>` : ''}
      </div>
      <div id="sms-test"></div>
    </div>

    <div class="row" style="margin-top:16px;align-items:flex-end">
      <label style="max-width:220px">Caracteres por SMS
        <input id="sms-maxlen" value="${c.maxLen}" inputmode="numeric"></label>
      <label style="max-width:220px">Preço cobrado do cliente (R$/SMS)
        <input id="sms-price" value="${(c.priceCents / 100).toFixed(2)}" inputmode="decimal"></label>
      <button class="btn no-grow" onclick="admSmsSave({maxLen:$('#sms-maxlen').value,priceCents:$('#sms-price').value})">${ico('save', 14)} Salvar</button>
    </div>
    <p class="muted" style="font-size:11.5px;margin:8px 0 0">
      Acima do limite de caracteres a operadora cobra mais de um SMS — é assim que o consumo é contado no plano do cliente.
    </p>

    <div class="fee-sep"></div>
    <h2 style="font-size:14px">${ico('link')} Status de entrega</h2>
    <p class="muted" style="margin:2px 0 10px;font-size:13px">
      Informe esta URL no painel da Integra X para receber a confirmação de entrega de cada SMS:
    </p>
    <div class="copywrap"><input readonly value="${esc(API.webOrigin || location.origin)}/sms-webhook" onclick="this.select()"></div>
    <label style="margin-top:12px">URL de callback enviada em cada disparo
      <input id="sms-cb" value="${esc(c.callbackUrl)}" placeholder="${esc(API.webOrigin || location.origin)}/sms-webhook"></label>
    <div class="row" style="margin-top:10px;justify-content:flex-end">
      <button class="btn no-grow" onclick="admSmsSave({callbackUrl:$('#sms-cb').value})">${ico('save', 14)} Salvar callback</button>
    </div>

    ${b ? `<div class="fee-sep"></div>
      <div class="wallet-bal">
        <div><span class="muted" style="font-size:12px">Créditos na Integra X</span>
          <div style="font-size:24px;font-weight:800;color:var(--verde-deep)">${fmtN(b.creditos)}</div></div>
        <div style="text-align:right"><span class="muted" style="font-size:12px">consultado</span>
          <div style="font-size:13px;font-weight:700">${timeAgo(b.ts)}</div></div>
      </div>` : ''}

    <div class="fee-sep"></div>
    <p class="muted" style="font-size:11.5px;margin:0">
      ${ico('zap', 12)} O disparo em massa vai em lotes de <b>${fmtN(c.lote || 100)}</b> números por chamada —
      a Integra X aceita vários destinatários de uma vez.
    </p>

    ${(c.logs || []).length ? `<div class="fee-sep"></div>
      <h2 style="font-size:14px">${ico('list')} Últimos eventos</h2>
      <div class="tx-list">${c.logs.slice(0, 12).map(l => `<div class="tx">
        <span class="tx-lbl"><b>${esc(l.type)}</b>
          <em style="display:block;font-style:normal;color:var(--muted);font-size:11.5px">${esc(l.error || l.etapa || ('créditos: ' + (l.creditos ?? '')))}</em></span>
        <span class="muted" style="font-size:11px">${timeAgo(l.ts)}</span></div>`).join('')}</div>` : ''}
  </div>`;
}

async function admSmsSave(patch) {
  try {
    admSms = (await api('/admin/sms', { method: 'PUT', body: patch })).sms;
    toast('SMS atualizado');
    admSmsPaint();
  } catch (e) { toast(e.message, 'error'); }
}

function admSmsSaveForm(btn) {
  const patch = { from: $('#sms-from').value, base: $('#sms-base').value };
  const tok = ($('#sms-token').value || '').trim();
  if (tok) patch.token = tok;
  admSmsSave(patch);
}

async function admSmsClearToken() {
  if (!await confirmModal({
    title: 'Remover o token?',
    text: 'O envio de SMS para de funcionar até um novo token ser informado.',
    ok: 'Remover', danger: true
  })) return;
  admSmsSave({ token: null });
}

async function admSmsTest(btn) {
  const out = $('#sms-test');
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Testando…';
  try {
    const r = await api('/admin/sms/test', { body: {} });
    admSms = (await api('/admin/sms')).sms;
    if (r.ok) {
      out.innerHTML = `<p class="hint" style="margin-top:10px;color:var(--verde-deep)">
        ${ico('check', 12)} Conectado. Créditos: <b>${fmtN(r.saldo.creditos)}</b> ${esc(r.saldo.moeda || '')}.</p>`;
    } else {
      // O teste diz QUAL parte do contrato falhou, para não caçar no escuro.
      const dica = {
        BASE: 'Não foi possível alcançar o servidor. Confira a URL da API.',
        AUTH: 'O token foi recusado. Como ele faz parte do endereço, um token errado responde 404 — confira se copiou o valor inteiro do painel da Integra X.',
        ROTAS: 'O endereço existe, mas a conta não tem acesso a esta rota. Confira o plano contratado na Integra X.',
        CAMPOS: 'A conexão funcionou, mas a resposta veio em outro formato. Ajuste a leitura em src/sms.js (bloco CONTRATO).'
      }[r.etapa] || '';
      out.innerHTML = `<div class="danger-box" style="margin-top:10px">
        <b>${ico('alert', 13)} Falhou em: ${esc(r.etapa)}</b>
        <p style="margin:0 0 6px">${esc(dica)}</p>
        <p style="margin:0"><code>${esc(r.base || '')}${esc(r.rota || '')}</code> — ${esc(r.msg || '')}</p>
      </div>`;
    }
  } catch (e) { out.innerHTML = `<div class="danger-box" style="margin-top:10px"><b>${esc(e.message)}</b></div>`; }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

// ---- Admin → Integrações → Nuvemshop (app único da plataforma) ----
let admNs = null;
async function admNsLoad() {
  const box = $('#adm-int-box'); if (!box) return;
  try { admNs = (await api('/admin/nuvemshop')).nuvemshop; }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  admNsPaint();
}
function admNsPaint() {
  const box = $('#adm-int-box'); if (!box || !admNs) return;
  const n = admNs;
  const status = n.available
    ? '<span class="pill done">Ativa para os clientes</span>'
    : n.enabled ? '<span class="pill pending">Ligada, mas falta o app</span>' : '<span class="pill">Desligada</span>';

  box.innerHTML = `<div class="card">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="margin:0;flex:1">${ico('cart')} Nuvemshop</h2>
      ${status}
    </div>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      Um <b>único app</b> da plataforma atende todos os clientes. Eles não criam app nem informam credenciais,
      só clicam em “Conectar loja”. Enquanto estiver desligada, a integração <b>nem aparece</b> no painel deles.
    </p>

    <label class="chk"><input type="checkbox" ${n.enabled ? 'checked' : ''} onchange="admNsSave({enabled:this.checked})">
      Disponibilizar a integração com a Nuvemshop para os clientes</label>

    <div class="row" style="margin-top:16px;align-items:flex-end">
      <label style="flex:1">App ID ${n.appId ? '<span class="pill done" style="margin-left:6px">Preenchido</span>' : ''}
        <input id="adm-ns-appid" value="${esc(n.appId || '')}" placeholder="Ex.: 12345"></label>
      <label style="flex:1">Client Secret ${n.hasSecret ? '<span class="pill done" style="margin-left:6px">Salvo</span>' : ''}
        <input id="adm-ns-secret" type="password" placeholder="${n.hasSecret ? '•••••••• (deixe vazio p/ manter)' : 'Cole o secret do app'}"></label>
      <button class="btn primary no-grow" onclick="admNsSave({appId:$('#adm-ns-appid').value,appSecret:$('#adm-ns-secret').value})">${ico('save', 14)} Salvar</button>
    </div>

    <div class="capi-box" style="margin-top:16px">
      <div class="capi-head">${ico('webhook', 14)} URLs para cadastrar no app <span class="capi-tag">Portal de Parceiros</span></div>
      <p class="muted" style="font-size:12px;margin:8px 0 5px">URL de redirecionamento (OAuth):</p>
      <div class="linkrow"><code>${esc(n.redirectUri)}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(n.redirectUri)}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:12px;margin:10px 0 5px">URL de notificações (webhooks):</p>
      <div class="linkrow"><code>${esc(n.webhookUrl)}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(n.webhookUrl)}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0">
        Escopos necessários: <b>read_orders</b> e <b>read_customers</b>. Em produção, o domínio precisa ser HTTPS.
      </p>
    </div>

    <div class="wh-meta" style="margin-top:16px">
      <span class="pill ${n.lojasConectadas ? 'done' : ''}">${fmtN(n.lojasConectadas)} loja(s) conectada(s)</span>
    </div>
  </div>`;
}
async function admNsSave(body) {
  try {
    admNs = (await api('/admin/nuvemshop', { method: 'PUT', body })).nuvemshop;
    toast('Integração atualizada');
    admNsPaint();
  } catch (e) { toast(e.message, 'error'); }
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
      <p class="muted" style="margin:0 0 14px;font-size:13px">Personalize como sua página inicial (a landing pública em <code>${API.webOrigin}/</code>) aparece no Google e ao ser compartilhada. As tags são injetadas no HTML lido pelos buscadores.</p>
      <div class="row">
        <label style="flex:2">Título (title / aba do navegador)<input id="seo-title" maxlength="180" value="${v('title')}" placeholder="EliteChat. CRM de WhatsApp com IA"></label>
        <label style="flex:1">Theme color<input id="seo-theme" value="${v('themeColor')}" placeholder="#34D399"></label>
      </div>
      <label style="margin-top:9px">Descrição (meta description, ideal até 160 caracteres)<textarea id="seo-desc" rows="2" maxlength="400" placeholder="Automatize o atendimento no WhatsApp, gerencie leads e dispare campanhas com o EliteChat.">${v('description')}</textarea></label>
      <div class="row" style="margin-top:9px">
        <label style="flex:2">Palavras-chave (separadas por vírgula)<input id="seo-keywords" maxlength="400" value="${v('keywords')}" placeholder="crm whatsapp, disparo em massa, chatbot"></label>
        <label style="flex:1">Autor<input id="seo-author" maxlength="120" value="${v('author')}" placeholder="EliteChat"></label>
      </div>
      <h3 class="notif-sub">Compartilhamento (Open Graph / redes sociais)</h3>
      <div class="row">
        <label style="flex:1">Título ao compartilhar<input id="seo-ogtitle" maxlength="180" value="${v('ogTitle')}" placeholder="(usa o título acima se vazio)"></label>
      </div>
      <label style="margin-top:9px">Descrição ao compartilhar<textarea id="seo-ogdesc" rows="2" maxlength="400" placeholder="(usa a descrição acima se vazio)">${v('ogDescription')}</textarea></label>
      <label style="margin-top:9px">Imagem de preview (URL. 1200×630 recomendado)<input id="seo-ogimage" maxlength="600" value="${v('ogImage')}" placeholder="${API.webOrigin}/assets/elitechat-logo.png"></label>
      <h3 class="notif-sub">Avançado</h3>
      <div class="row">
        <label style="flex:2">URL canônica<input id="seo-canonical" maxlength="400" value="${v('canonical')}" placeholder="${API.webOrigin}/"></label>
        <label style="flex:1">Robots<input id="seo-robots" maxlength="60" value="${v('robots')}" placeholder="index, follow"></label>
      </div>
      <label style="margin-top:9px">Google Analytics ID (opcional)<input id="seo-ga" maxlength="40" value="${v('gaId')}" placeholder="G-XXXXXXXXXX"></label>
      <label style="margin-top:9px">HTML extra no &lt;head&gt; (opcional, verificação de domínio, scripts)<textarea id="seo-extra" rows="3" maxlength="4000" placeholder="<meta name=&quot;google-site-verification&quot; content=&quot;...&quot;>">${v('extraHead')}</textarea></label>
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
  try { await api('/admin/seo', { method: 'PUT', body }); toast('SEO salvo, já vale na página inicial'); } catch (e) { toast(e.message, 'error'); }
}

// ---------- Admin → Elite Pay (gestão financeira da plataforma) ----------
const EP_SUB_ST = {
  active: ['Ativa', 'pill done'], pending: ['Aguardando aprovação', 'pill pending'],
  suspended: ['Suspensa', 'pill'], rejected: ['Rejeitada', 'pill']
};
const EP_LOG_LBL = {
  subaccount_created: 'Subconta criada', subaccount_active: 'Subconta aprovada',
  subaccount_suspended: 'Subconta suspensa', subaccount_rejected: 'Subconta rejeitada',
  subaccount_pending: 'Subconta em análise', charge_created: 'Cobrança criada',
  charge_paid: 'PIX In, pagamento', charge_cancelled: 'Cobrança cancelada',
  config_updated: 'Configuração alterada', withdraw: 'PIX Out, saque'
};
// ---- Admin → Elite Pay → adquirente de cartão (Pagar.me / Asaas) ----
// ============================================================================
// TAXAS DA PLATAFORMA — Pix e Cartão no MESMO painel.
// Entradas (Pix In / Cartão) e saídas (Pix Out) ficam lado a lado: é uma decisão
// só, de quanto a plataforma retém em cada meio, então não faz sentido estarem
// em abas diferentes.
// ============================================================================
function admFeesSection(cfg, c, t) {
  const isPag = c.provider === 'pagarme';
  const exemplo = 10000;
  const cartaoCut = Math.floor(exemplo * (Number(c.feeCardPercent) || 0) / 100) + (c.feeCardFixed || 0);

  return `<div class="card">
    <h2>${ico('zap')} Taxas da plataforma</h2>
    <p class="muted" style="margin:0 0 16px;font-size:13px">
      Quanto você retém em cada meio de pagamento, <b>entradas e saídas, Pix e cartão, tudo aqui</b>.
      A retenção é automática (split): o líquido vai ao lojista e a sua parte vem para você. Com <b>0%</b> e <b>R$ 0,00</b> a taxa fica desativada.
    </p>

    <div class="fee-grid">
      <div class="fee-col">
        <div class="fee-tag in">${ico('arrow-down', 13)} Entrada · Pix</div>
        <label>Taxa PIX In (%)<input id="adm-ep-fee-in" value="${esc(String(cfg.feeInPercent))}" inputmode="decimal" placeholder="0"></label>
        <p class="hint">Incide sobre cada venda recebida pelo lojista.</p>
      </div>
      <div class="fee-col">
        <div class="fee-tag in">${ico('card', 13)} Entrada · Cartão</div>
        <div class="row" style="gap:8px">
          <label>Taxa (%)<input id="adm-card-fee" value="${esc(String(c.feeCardPercent))}" inputmode="decimal" placeholder="0"></label>
          <label>Fixa (R$)<input id="adm-card-fixed" value="${((c.feeCardFixed || 0) / 100).toFixed(2)}" inputmode="decimal" placeholder="0,00"></label>
        </div>
        <p class="hint">Por cima do que o adquirente já cobra. Venda de ${fmtBRL(exemplo)} → <b>${fmtBRL(cartaoCut)}</b> para você.</p>
      </div>
      <div class="fee-col">
        <div class="fee-tag out">${ico('arrow-up', 13)} Saída · Pix</div>
        <label>Taxa PIX Out (%)<input id="adm-ep-fee-out" value="${esc(String(cfg.feeOutPercent))}" inputmode="decimal" placeholder="0"></label>
        <p class="hint">Saque de dinheiro que entrou via Pix ou comissão.</p>
      </div>
      <div class="fee-col">
        <div class="fee-tag out">${ico('card', 13)} Saída · Cartão</div>
        <div class="row" style="gap:8px">
          <label>Taxa (%)<input id="adm-card-fee-out" value="${esc(String(c.feeOutCardPercent || 0))}" inputmode="decimal" placeholder="0"></label>
          <label>Fixa (R$)<input id="adm-card-fixed-out" value="${((c.feeOutCardFixed || 0) / 100).toFixed(2)}" inputmode="decimal" placeholder="0,00"></label>
        </div>
        <p class="hint">Saque do dinheiro vindo de venda no cartão. Saque de ${fmtBRL(exemplo)} retém <b>${fmtBRL(Math.floor(exemplo * (Number(c.feeOutCardPercent) || 0) / 100) + (c.feeOutCardFixed || 0))}</b>.</p>
      </div>
    </div>

    <div class="fee-sep"></div>
    <h2 style="font-size:14px">${ico('clock')} Repasse das vendas no cartão</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">
      O adquirente não libera o dinheiro do cartão no mesmo dia. No modo <b>Carteira</b>, a venda entra
      na carteira do lojista dentro do EliteChat como <b>“a liberar”</b> e vira saldo sacável quando o prazo vence.
      Ele pode gastar esse saldo aqui (plano, conexões, links) sem nem sacar.
    </p>
    <div class="row" style="align-items:flex-end">
      <label style="max-width:340px">Modo de repasse${ecSelect('adm-card-mode', [
        { value: 'wallet', label: 'Carteira no EliteChat (recomendado)' },
        { value: 'split', label: 'Split direto para o recebedor do lojista' }
      ], c.settleMode || 'wallet')}</label>
    </div>

    <div class="settle-box">
      <div class="settle-head">${ico('lock', 13)} Prazos do <b>${esc((c.settleRules || {}).label || (isPag ? 'Pagar.me' : 'Asaas'))}</b>
        <span class="settle-tag">definidos pela adquirente</span></div>
      <div class="settle-rows">
        <div class="settle-row"><span>Crédito</span><b>D+${(c.settleRules || {}).credit ? c.settleRules.credit.days : c.settleCredit}</b>
          <em>${esc((c.settleRules || {}).credit ? c.settleRules.credit.text : '')}</em></div>
        <div class="settle-row"><span>Boleto</span><b>D+${(c.settleRules || {}).boleto ? c.settleRules.boleto.days : c.settleBoleto}</b>
          <em>${esc((c.settleRules || {}).boleto ? c.settleRules.boleto.text : '')}</em></div>
      </div>
      <p class="hint" style="margin:10px 0 0;text-align:left">
        Não são editáveis de propósito: o EliteChat libera o saldo <b>no mesmo dia em que a adquirente repassa</b>.
        Se fosse possível digitar um prazo menor, o cliente sacaria dinheiro que ainda não entrou.
        Trocar de adquirente troca o prazo automaticamente.
      </p>
    </div>

    <div class="row" style="margin-top:16px;align-items:flex-end">
      <label style="flex:1.6">Chave Pix da plataforma (recebe o split do Pix)<input id="adm-ep-splitkey" value="${esc(cfg.splitPixKey || '')}" placeholder="chave Pix que recebe a comissão"></label>
      <label style="max-width:190px">Nome na fatura do cartão<input id="adm-card-sd" value="${esc(c.softDescriptor || '')}" maxlength="13" placeholder="ELITECHAT"></label>
      <label style="max-width:140px">Parcelas máx.<input id="adm-card-inst" value="${esc(String(c.maxInstallments || 1))}" inputmode="numeric"></label>
    </div>

    ${isPag ? `
      <div class="row" style="margin-top:12px;align-items:flex-end">
        <label style="flex:1">Seu recebedor no Pagar.me (recebe a taxa do cartão via split)
          <input id="adm-card-prid" value="${esc(c.platformRecipientId || '')}" placeholder="rp_..."></label>
      </div>
      <p class="hint" style="margin-top:8px">${c.platformRecipientId
        ? 'ID do recebedor padrão da sua conta Pagar.me, é para onde a taxa do cartão é enviada no split.'
        : '<b style="color:var(--amber)">Sem esse ID a taxa do cartão não é separada:</b> o valor cheio vai para o lojista. Pegue o <code>recipient_id</code> padrão no dashboard do Pagar.me.'}</p>`
    : `
      <div class="row" style="margin-top:12px;align-items:flex-end">
        <label style="flex:1">Sua carteira no Asaas, <b>Wallet ID</b> (recebe a taxa do cartão via split)
          <input id="adm-card-wallet" value="${esc((c.asaas && c.asaas.walletId) || '')}" placeholder="ex.: 5f1c8c1e-4a2b-4c7d-9e3f-0a1b2c3d4e5f"></label>
      </div>
      <p class="hint" style="margin-top:8px">${(c.asaas && c.asaas.walletId)
        ? 'A taxa é enviada <b>explicitamente</b> para essa carteira no split; o líquido vai para a carteira do lojista.'
        : 'Opcional: sem Wallet ID o split manda o líquido ao lojista e a <b>diferença fica na conta que emitiu a cobrança</b>, que já é a sua. Informe uma carteira só se quiser separar a taxa em outra conta Asaas. O ID fica em <b>Asaas → Minha conta → Integrações → Wallet ID</b>.'}</p>`}

    <div class="row" style="margin-top:16px;justify-content:flex-end">
      <button class="btn primary no-grow" onclick="admSaveAllFees(this)">${ico('save', 14)} Salvar todas as taxas</button>
    </div>

    <div class="fee-sep"></div>
    <label class="chk"><input type="checkbox" id="adm-ep-approval" ${cfg.requireApproval ? 'checked' : ''} onchange="admEpSaveCfg()"> Exigir aprovação manual das subcontas novas</label>

    <div class="wh-meta" style="margin-top:16px">
      <span class="pill ${t.fees ? 'done' : ''}">${fmtBRL(t.fees || 0)} em taxas de Pix</span>
      <span class="pill ${t.cardFees ? 'done' : ''}">${fmtBRL(t.cardFees || 0)} em taxas de cartão</span>
      <span class="pill">${fmtN(t.cardCount || 0)} venda(s) no cartão · ${fmtBRL(t.cardIn || 0)}</span>
    </div>
    <p class="hint" style="margin-top:12px">
      Gateway Pix: <b>${esc(cfg.gateway)}</b> · ${cfg.configured ? 'conectado ✅' : '<b style="color:var(--amber)">AppID não configurado</b>'}.
      Adquirente do cartão: <b>${esc(isPag ? 'Pagar.me' : 'Asaas')}</b> · ${c.configured ? 'conectado ✅' : '<b style="color:var(--amber)">credenciais pendentes</b>'}.
      As <b>credenciais e webhooks</b> ficam em <a href="javascript:showSettingsTab('adm-pay')"><b>Pagamentos</b></a>.
    </p>
  </div>`;
}

// Salva Pix In/Out + taxa de cartão numa tacada só (o painel é um só).
async function admSaveAllFees(btn) {
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Salvando…';
  const num = id => { const el = $(id); return el ? el.value : undefined; };
  try {
    await api('/admin/elitepay/config', {
      method: 'PUT',
      body: {
        feeInPercent: num('#adm-ep-fee-in'),
        feeOutPercent: num('#adm-ep-fee-out'),
        splitPixKey: num('#adm-ep-splitkey'),
        requireApproval: !!($('#adm-ep-approval') || {}).checked
      }
    });
    const cents = v => Math.round(Number(String(v || '0').replace(',', '.')) * 100) || 0;
    const card = {
      feeCardPercent: num('#adm-card-fee'),
      feeCardFixed: cents(num('#adm-card-fixed')),
      feeOutCardPercent: num('#adm-card-fee-out'),
      feeOutCardFixed: cents(num('#adm-card-fixed-out')),
      settleMode: ecSelVal('adm-card-mode'),   // prazos não vão: são da adquirente
      softDescriptor: num('#adm-card-sd'),
      maxInstallments: num('#adm-card-inst')
    };
    const prid = $('#adm-card-prid');
    if (prid) card.platformRecipientId = prid.value;
    const wal = $('#adm-card-wallet');
    if (wal) card.asaas = { walletId: wal.value.trim() };
    await api('/admin/elitepay/card', { method: 'PUT', body: card });
    toast('Taxas de Pix e cartão salvas');
    admEpPaint();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.innerHTML = txt; }
}


function admCardSection(c, t) {
  const isPag = c.provider === 'pagarme';
  const status = c.available
    ? '<span class="pill done">Ativo no checkout</span>'
    : c.enabled ? '<span class="pill pending">Ligado, falta configurar</span>' : '<span class="pill">Desligado</span>';

  return `<div class="card">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="margin:0;flex:1">${ico('card')} Cartão de crédito & boleto</h2>
      ${status}
    </div>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      O <b>Pix continua sendo o meio principal</b>. O cartão aparece como alternativa no mesmo checkout,
      processado pelo adquirente escolhido abaixo. Desligado, o checkout mostra só Pix.
    </p>

    <label class="chk"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="admCardSave({enabled:this.checked})">
      Aceitar cartão no Elite Pay</label>

    <div class="row" style="margin-top:16px;align-items:flex-end">
      <label style="max-width:260px">Adquirente${ecSelect('adm-card-prov',
        (c.drivers || []).map(d => ({ value: d.id, label: d.label })), c.provider, `admCardSave({provider:val})`)}</label>
      <label class="chk" style="flex:0 0 auto;margin-bottom:10px"><input type="checkbox" ${c.credit ? 'checked' : ''} onchange="admCardSave({credit:this.checked})"> Crédito</label>
      <label class="chk" style="flex:0 0 auto;margin-bottom:10px"><input type="checkbox" ${c.boleto ? 'checked' : ''} onchange="admCardSave({boleto:this.checked})"> Boleto</label>
      <label style="max-width:190px">Vencimento do boleto (dias)
        <input value="${c.boletoDueDays || 3}" inputmode="numeric" onchange="admCardSave({boletoDueDays:this.value})"></label>
    </div>
    <p class="hint" style="margin-top:8px">Não há cartão de débito: para pagamento à vista o <b>Pix</b> aprova na hora e sai mais barato para os dois lados.</p>

    <div class="capi-box" style="margin-top:16px">
      <div class="capi-head">${ico('gear', 14)} Credenciais, ${esc(isPag ? 'Pagar.me' : 'Asaas')} <span class="capi-tag">${c.configured ? 'configurado' : 'pendente'}</span></div>
      ${isPag ? `
        <div class="row" style="margin-top:10px;align-items:flex-end">
          <label style="flex:1">Secret Key ${c.pagarme.hasSecret ? '<span class="pill done" style="margin-left:6px">Salva</span>' : ''}
            <input id="adm-card-sk" type="password" placeholder="${c.pagarme.hasSecret ? '•••••••• (deixe vazio p/ manter)' : 'sk_...'}"></label>
          <label style="flex:1">Public Key
            <input id="adm-card-pk" value="${esc(c.pagarme.publicKey || '')}" placeholder="pk_..."></label>
          <button class="btn primary no-grow" onclick="admCardSaveKeys()">${ico('save', 14)} Salvar</button>
        </div>
        <p class="hint" style="margin-top:8px">Chaves em <b>Dashboard Pagar.me → Configurações → Chaves</b>. As de teste começam com <code>sk_test_</code>.</p>`
      : `
        <div class="row" style="margin-top:10px;align-items:flex-end">
          <label style="flex:1">API Key ${c.asaas.hasKey ? '<span class="pill done" style="margin-left:6px">Salva</span>' : ''}
            <input id="adm-card-ak" type="password" placeholder="${c.asaas.hasKey ? '•••••••• (deixe vazio p/ manter)' : '$aact_...'}"></label>
          <button class="btn primary no-grow" onclick="admCardSaveKeys()">${ico('save', 14)} Salvar</button>
        </div>
        <label class="chk" style="margin-top:12px"><input type="checkbox" ${c.asaas.sandbox ? 'checked' : ''} onchange="admCardSave({asaas:{sandbox:this.checked}})"> Usar ambiente <b>sandbox</b> (testes)</label>
        <p class="hint" style="margin-top:8px">API Key em <b>Asaas → Integrações → Gerar API Key</b>. Sandbox e produção têm chaves diferentes.</p>`}
      <div class="row" style="margin-top:12px">
        <button class="btn small no-grow" onclick="admCardTest(this)">${ico('activity', 13)} Testar credenciais</button>
      </div>
    </div>

    <div class="capi-box" style="margin-top:16px">
      <div class="capi-head">${ico('webhook', 14)} Webhook de confirmação <span class="capi-tag">obrigatório em produção</span></div>
      <p class="muted" style="font-size:12px;margin:8px 0 5px">URL de notificação:</p>
      <div class="linkrow"><code>${esc(c.webhookUrl || '')}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(c.webhookUrl || '')}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:12px;margin:10px 0 5px">${isPag ? 'Senha (Basic auth, usuário pode ser qualquer um):' : 'Token de acesso (campo <b>authToken</b>):'}</p>
      <div class="linkrow"><code>${esc(c.webhookToken || '')}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(c.webhookToken || '')}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0">
        ${isPag
          ? 'Em <b>Pagar.me → Configurações → Webhooks</b>, cadastre a URL com os eventos <code>charge.paid</code>, <code>charge.refunded</code>, <code>charge.payment_failed</code> e <code>recipient.updated</code>, e ative a autenticação com essa senha.'
          : 'Em <b>Asaas → Integrações → Webhooks</b>, cadastre a URL com os eventos de <b>cobrança</b> e cole esse valor no campo <b>authToken</b>, ele chega no header <code>asaas-access-token</code>.'}
        Todo pagamento é <b>reconferido na API</b> antes de ser confirmado, mesmo com o webhook autenticado.
      </p>
    </div>

    <label class="chk" style="margin-top:16px"><input type="checkbox" ${c.requireApproval ? 'checked' : ''} onchange="admCardSave({requireApproval:this.checked})"> Exigir minha aprovação manual antes do lojista vender no cartão</label>
    <p class="hint" style="margin-top:12px">${ico('zap', 12)} A <b>taxa que você cobra sobre as vendas no cartão</b> fica junto das taxas de Pix, em <a href="javascript:showSettingsTab('adm-ep')"><b>Elite Pay → Taxas da plataforma</b></a>.</p>

    ${t ? `<div class="wh-meta" style="margin-top:16px">
      <span class="pill ${t.cardCount ? 'done' : ''}">${fmtN(t.cardCount || 0)} venda(s) no cartão</span>
      <span class="pill">${fmtBRL(t.cardIn || 0)} processado</span>
      <span class="pill">${fmtBRL(t.cardFees || 0)} em taxas suas</span>
    </div>` : ''}
  </div>`;
}

async function admCardSave(body) {
  // a config vive na aba Pagamentos (paintAdmin); refaz esse painel, não o Elite Pay
  try { await api('/admin/elitepay/card', { method: 'PUT', body }); toast('Cartão atualizado'); paintAdmin(); }
  catch (e) { toast(e.message, 'error'); }
}
function admCardSaveKeys() {
  const sk = $('#adm-card-sk'), pk = $('#adm-card-pk'), ak = $('#adm-card-ak');
  const body = ak
    ? { asaas: { apiKey: ak.value.trim() } }
    : { pagarme: { secretKey: sk.value.trim(), publicKey: pk.value.trim() } };
  admCardSave(body);
}
async function admCardTest(btn) {
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Testando…';
  try { const r = await api('/admin/elitepay/card/test'); toast(`Conexão OK, ${r.provider} (${r.ambiente})`); }
  catch (e) { toast(e.message, 'error'); }
  btn.disabled = false; btn.innerHTML = txt;
}

async function admEpPaint() {
  const box = $('#adm-ep-box'); if (!box) return;
  try {
    const d = await api('/admin/elitepay');
    const t = d.totals, cfg = d.config;
    box.innerHTML = `
      <div class="metric-hero">
        <div class="mh-card hi"><span class="mh-ic">${ico('arrow-down', 20)}</span><div class="mh-val">${fmtBRL(t.pixIn)}</div><div class="mh-lbl">PIX In (recebido pelos clientes)</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('arrow-up', 20)}</span><div class="mh-val">${fmtBRL(t.pixOut)}</div><div class="mh-lbl">PIX Out (saques)</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('zap', 20)}</span><div class="mh-val">${fmtBRL(t.fees)}</div><div class="mh-lbl">Comissões via Split</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('users', 20)}</span><div class="mh-val">${fmtN(t.subActive)}</div><div class="mh-lbl">Subcontas ativas</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('clock', 20)}</span><div class="mh-val">${fmtN(t.subPending)}</div><div class="mh-lbl">Aguardando aprovação</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('activity', 20)}</span><div class="mh-val">${fmtN(t.charges)}</div><div class="mh-lbl">Cobranças geradas</div></div>
      </div>

      <div class="card">
        <h2>${ico('shield')} Onboarding & KYC das subcontas</h2>
        <p class="muted" style="margin:0 0 12px;font-size:13px">Como os clientes abrem a conta de recebimento:</p>
        <div class="row" style="align-items:flex-end">
          <label style="flex:1;max-width:340px">Modo de cadastro${ecSelect('adm-ep-mode', [
            { value: 'subaccount', label: 'Subconta (chave Pix. KYC via Banco Central)' },
            { value: 'kyc', label: 'KYC/KYB completo (BaaS, verificação de identidade)' }
          ], cfg.onboardingMode || 'subaccount', 'admEpSaveCfg()')}</label>
        </div>
        <p class="hint" style="margin-top:10px">${ico('shield', 11)} <b>Subconta:</b> cria a subconta com a chave Pix do cliente (a Woovi valida a chave no Banco Central). <b>KYC/KYB:</b> abre a verificação de identidade hospedada da Woovi e libera a conta pelo webhook <code>ACCOUNT_REGISTER_APPROVED</code> (requer BaaS habilitado na sua conta Woovi).</p>
      </div>

      ${admFeesSection(cfg, d.card || {}, t)}

      <div class="card">
        <h2>${ico('users')} Subcontas dos clientes</h2>
        ${d.accounts.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Cliente</th><th>Subconta</th><th>Status</th><th style="text-align:right">PIX In</th><th style="text-align:right">Taxas</th><th style="text-align:right">Cobranças</th><th></th></tr></thead><tbody>
          ${d.accounts.map(a => {
            const st = a.sub ? (EP_SUB_ST[a.sub.status] || [a.sub.status, 'pill']) : null;
            return `<tr>
              <td><b>${esc(a.name)}</b><div class="muted" style="font-size:11.5px">${esc(a.email)}</div></td>
              <td>${a.sub ? `${esc(a.sub.name)}<div class="muted" style="font-size:11px">${esc(a.sub.pixKey)}</div>` : '<span class="muted">—</span>'}</td>
              <td>${st ? `<span class="${st[1]}">${st[0]}</span>` : '<span class="muted">sem conta</span>'}</td>
              <td style="text-align:right"><b>${fmtBRL(a.pixIn)}</b></td>
              <td style="text-align:right">${fmtBRL(a.fees)}</td>
              <td style="text-align:right">${fmtN(a.charges)}${a.pending ? ` <span class="muted">(${a.pending} pend.)</span>` : ''}</td>
              <td style="white-space:nowrap;text-align:right">
                ${a.sub && a.sub.status === 'pending' ? `
                  <button class="btn small" onclick="admEpSubStatus('${a.accountId}','active')">${ico('check', 13)} Aprovar</button>
                  <button class="btn small danger" onclick="admEpSubStatus('${a.accountId}','rejected')">Rejeitar</button>` : ''}
                ${a.sub && a.sub.status === 'active' ? `<button class="btn small danger" onclick="admEpSubStatus('${a.accountId}','suspended')">${ico('slash', 13)} Suspender</button>` : ''}
                ${a.sub && a.sub.status === 'suspended' ? `<button class="btn small" onclick="admEpSubStatus('${a.accountId}','active')">${ico('refresh', 13)} Reativar</button>` : ''}
              </td>
            </tr>`; }).join('')}
        </tbody></table></div>` : '<p class="muted">Nenhum cliente ativou o Elite Pay ainda.</p>'}
      </div>

      <div class="card">
        <h2>${ico('activity')} Relatório, volume por cliente</h2>
        ${d.accounts.filter(a => a.pixIn > 0).length ? d.accounts.filter(a => a.pixIn > 0).map(a => {
          const max = Math.max(1, ...d.accounts.map(x => x.pixIn));
          return `<div class="ep-volrow"><span>${esc(a.name)}</span>
            <div class="ep-volbar"><i style="width:${Math.max(2, Math.round(a.pixIn / max * 100))}%"></i></div>
            <b>${fmtBRL(a.pixIn)}</b></div>`;
        }).join('') : '<p class="muted">Sem volume financeiro ainda.</p>'}
      </div>

      <div class="card">
        <h2>${ico('list')} Logs financeiros</h2>
        ${d.logs.length ? `<table><thead><tr><th>Quando</th><th>Evento</th><th>Cliente</th><th style="text-align:right">Valor</th></tr></thead><tbody>
          ${d.logs.map(l => `<tr>
            <td class="muted" style="white-space:nowrap">${timeAgo(l.ts)}</td>
            <td>${esc(EP_LOG_LBL[l.type] || l.type)}${l.detail ? `<div class="muted" style="font-size:11px">${esc(l.detail)}</div>` : ''}</td>
            <td>${esc(l.accountName || '—')}</td>
            <td style="text-align:right">${l.amount ? fmtBRL(l.amount) : '—'}${l.fee ? `<div class="muted" style="font-size:11px">taxa ${fmtBRL(l.fee)}</div>` : ''}</td>
          </tr>`).join('')}</tbody></table>` : '<p class="muted">Nenhum evento financeiro registrado.</p>'}
      </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
async function admEpSaveCfg() {
  try {
    const body = { onboardingMode: ecVal('adm-ep-mode') || 'subaccount' };
    if ($('#adm-ep-fee-in')) body.feeInPercent = $('#adm-ep-fee-in').value;
    if ($('#adm-ep-fee-out')) body.feeOutPercent = $('#adm-ep-fee-out').value;
    if ($('#adm-ep-splitkey')) body.splitPixKey = $('#adm-ep-splitkey').value;
    if ($('#adm-ep-approval')) body.requireApproval = $('#adm-ep-approval').checked;
    await api('/admin/elitepay/config', { method: 'PUT', body });
    toast('Configuração do Elite Pay salva');
  } catch (e) { toast(e.message, 'error'); }
}
async function admEpSubStatus(accId, status) {
  const lbl = { active: 'aprovar/reativar', suspended: 'suspender', rejected: 'rejeitar' }[status] || status;
  if (status !== 'active' && !confirm(`Tem certeza que deseja ${lbl} esta subconta?`)) return;
  try { await api('/admin/elitepay/subaccounts/' + accId, { method: 'PUT', body: { status } }); toast('Subconta atualizada'); admEpPaint(); }
  catch (e) { toast(e.message, 'error'); }
}

// ==================== LIGAÇÕES (Calling API) — tela de chamada WhatsApp ====================
// Recebida: webhook "calls" (connect) chega por SSE com o SDP offer → overlay
// toca → Atender cria o RTCPeerConnection no navegador (áudio via WebRTC) e
// envia o SDP answer para a Meta. Recusar/Desligar usam as ações oficiais.
let callUI = null; // { id, waId, name, direction, phase: incoming|calling|active|ended, sdpOffer, pc, stream, timer, startedAt, muted }

function onCallEvent(d) {
  if (d.kind === 'incoming') {
    if (callUI) return; // já em chamada, a Meta trata o busy do outro lado
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
              <b>${esc(l.label)}</b> ${l.detail ? `<span class="muted">· ${esc(l.detail)}</span>` : ''}
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
// Consentimento do contato no WhatsApp: quem pediu para sair (opt-out) é
// bloqueado no BACKEND em todos os envios do canal — inclusive templates e
// campanhas. Não alcança o SMS, que é outro canal e não tem palavra-chave de
// cancelamento chegando de volta.
let coCfg = null, coMeta = null, coRows = [], coFilters = { status: 'opted_out', uf: '', stage: '', search: '' };

const CO_STATUS = {
  opted_in: { label: 'Ativo (opt-in)', cls: 'done' },
  opted_out: { label: 'Opt-out', cls: 'off' },
  pending: { label: 'Pendente', cls: 'pending' }
};

// ==================== SMS (Integra X) ====================
// Envio avulso, disparo em massa por filtro e histórico com status de entrega.
let SMS_CACHE = null;

async function renderSms() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Disparos de SMS</h1><p>Mensagens de texto para o celular do lead, direto do painel</p></div>
    <div id="sms-box">${skel(4)}</div>
  </div>`;
  await loadSms();
}

async function loadSms() {
  try { SMS_CACHE = await api('/sms'); }
  catch (e) { $('#sms-box').innerHTML = `<div class="card"><p class="muted">${esc(e.message)}</p></div>`; return; }
  paintSms();
}

function paintSms() {
  const d = SMS_CACHE || {};
  const u = d.usage || {};
  const box = $('#sms-box'); if (!box) return;

  if (!d.available) {
    box.innerHTML = `<div class="card">
      <h2>${ico('alert')} SMS indisponível</h2>
      <p class="muted" style="margin:8px 0 0;font-size:13px">
        O envio de SMS não está habilitado para a sua conta. Fale com o suporte ou
        verifique o seu plano em <a href="#/billing"><b>Assinatura</b></a>.
      </p></div>`;
    return;
  }

  const restante = u.unlimited ? '∞' : fmtN(Math.max(0, (u.limit || 0) - (u.used || 0)));
  box.innerHTML = `
  <div class="two-col">
    <div class="card">
      <h2>${ico('send')} Enviar SMS</h2>
      <p class="muted" style="margin:2px 0 14px;font-size:13px">
        ${d.from ? `Remetente <b>${esc(d.from)}</b>. ` : ''}Cada ${fmtN(d.maxLen)} caracteres contam como um SMS.
      </p>
      <label>Número do destinatário<input id="sms-to" inputmode="tel" placeholder="(11) 98765-4321"></label>
      <label style="margin-top:10px">Mensagem
        <textarea id="sms-text" rows="4" maxlength="1600" placeholder="Escreva a mensagem…"
                  oninput="smsCount()"></textarea></label>
      <div class="row" style="align-items:center;margin-top:8px">
        <span class="muted" style="flex:1;font-size:12px" id="sms-count">0 caractere(s) · 1 SMS</span>
        <button class="btn primary no-grow" onclick="sendSms(this)">${ico('send', 14)} Enviar</button>
      </div>
      <p class="hint" style="margin-top:12px">${ico('shield', 12)} Envie apenas para quem autorizou receber suas mensagens.</p>
    </div>

    <div class="card">
      <h2>${ico('activity')} Consumo do ciclo</h2>
      <div class="wallet-bal" style="margin-top:12px">
        <div><span class="muted" style="font-size:12px">SMS enviados</span>
          <div style="font-size:26px;font-weight:800;color:var(--verde-deep)">${fmtN(u.used || 0)}</div></div>
        <div style="text-align:right"><span class="muted" style="font-size:12px">Disponível</span>
          <div style="font-size:20px;font-weight:800">${restante}</div></div>
      </div>
      ${u.unlimited ? '' : `<div class="lim-bar" style="margin-top:12px"><i style="width:${Math.min(100, u.percent || 0)}%"></i></div>`}
      <div class="fee-sep"></div>
      <h2 style="font-size:14px">${ico('users')} Disparo em massa</h2>
      <p class="muted" style="margin:2px 0 12px;font-size:13px">Envie para um grupo de contatos filtrado por etiqueta ou etapa do funil.</p>
      <div class="row">
        <label style="flex:1">Etapa do funil
          <select id="sms-stage"><option value="">Todas</option>
            ${(state.settings && state.settings.stages || []).map(x => `<option>${esc(x)}</option>`).join('')}
          </select></label>
        <label style="flex:1">Etiqueta<input id="sms-tag" placeholder="opcional"></label>
      </div>
      <label class="chk" style="margin-top:10px"><input type="checkbox" id="sms-ch" checked>
        Somente contatos da conexão em uso</label>
      <label style="margin-top:10px">Mensagem
        <textarea id="sms-bulk-text" rows="3" maxlength="1600" placeholder="Escreva a mensagem do disparo…"></textarea></label>
      <div class="row" style="margin-top:10px">
        <button class="btn no-grow" onclick="previewSmsBulk()">${ico('search', 13)} Ver quem vai receber</button>
      </div>
      <div id="sms-prev"></div>
    </div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="row" style="align-items:center;margin-bottom:8px">
      <h2 style="margin:0;flex:1">${ico('list')} Histórico de envios</h2>
      <button class="btn small no-grow" onclick="loadSms()">${ico('refresh', 13)} Atualizar</button>
    </div>
    ${(d.log || []).length ? `<div class="tx-list">
      ${d.log.slice(0, 100).map(m => `<div class="tx">
        <span class="tx-lbl">
          <b>${esc(m.name || m.to)}</b>${m.name ? ` · ${esc(m.to)}` : ''}
          <em style="display:block;font-style:normal;color:var(--muted);font-size:11.5px;margin-top:2px">
            ${esc(m.text.slice(0, 90))}${m.text.length > 90 ? '…' : ''}
          </em>
          <em style="display:block;font-style:normal;color:var(--faint);font-size:11px;margin-top:2px">
            ${new Date(m.ts).toLocaleString('pt-BR')} · ${m.segments} SMS · ${SMS_ORIGEM[m.origem] || m.origem}${m.error ? ` · ${esc(m.error)}` : ''}
          </em>
        </span>
        <span class="pill ${SMS_PILL[m.status] || ''}">${SMS_STATUS[m.status] || m.status}</span>
      </div>`).join('')}
    </div>` : '<p class="muted">Nenhum SMS enviado ainda.</p>'}
  </div>`;
  smsCount();
}

const SMS_STATUS = {
  queued: 'na fila', sent: 'enviado', delivered: 'entregue',
  undelivered: 'não entregue', failed: 'falhou'
};
const SMS_PILL = { delivered: 'done', failed: 'danger', undelivered: 'pending', queued: 'pending' };
const SMS_ORIGEM = { manual: 'avulso', massa: 'disparo em massa', flow: 'automação', api: 'API' };

function smsCount() {
  const el = $('#sms-text'), out = $('#sms-count');
  if (!el || !out) return;
  const n = el.value.length;
  const max = (SMS_CACHE && SMS_CACHE.maxLen) || 160;
  const seg = Math.max(1, Math.ceil(n / max));
  out.textContent = `${fmtN(n)} caractere(s) · ${seg} SMS`;
}

async function sendSms(btn) {
  const to = ($('#sms-to').value || '').trim();
  const text = ($('#sms-text').value || '').trim();
  if (!to) return toast('Informe o número do destinatário', 'error');
  if (!text) return toast('Escreva a mensagem', 'error');
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    await api('/sms/send', { body: { to, text } });
    toast('SMS enviado!');
    $('#sms-text').value = '';
    await loadSms();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

function smsBulkFiltro() {
  return {
    stage: ($('#sms-stage') || {}).value || '',
    tag: (($('#sms-tag') || {}).value || '').trim(),
    channelOnly: !!($('#sms-ch') || {}).checked,
    text: ($('#sms-bulk-text') || {}).value || ''
  };
}

async function previewSmsBulk() {
  const f = smsBulkFiltro();
  if (!f.text.trim()) return toast('Escreva a mensagem do disparo', 'error');
  try {
    const p = await api('/sms/bulk/preview', { body: f });
    $('#sms-prev').innerHTML = `
      <div class="extra-buy" style="margin-top:12px">
        <div class="extra-buy-head">${ico('users', 15)}
          <div style="flex:1"><b>${fmtN(p.enviaveis)} contato(s) vão receber</b>
            <em>${fmtN(p.creditos)} SMS no total (${p.segmentos} por contato)${p.invalidos ? ` · ${fmtN(p.invalidos)} com número inválido` : ''}</em>
          </div></div>
        ${p.amostra.length ? `<p class="muted" style="font-size:12px;margin:0 0 10px">
          Ex.: ${p.amostra.map(c => esc(c.name || c.waId)).join(', ')}${p.enviaveis > p.amostra.length ? '…' : ''}</p>` : ''}
        <button class="btn primary" ${p.enviaveis ? '' : 'disabled'} onclick="sendSmsBulk(this)">
          ${ico('send', 14)} Disparar para ${fmtN(p.enviaveis)} contato(s)</button>
      </div>`;
  } catch (e) { toast(e.message, 'error'); }
}

async function sendSmsBulk(btn) {
  const f = smsBulkFiltro();
  const ok = await confirmModal({
    title: 'Confirmar o disparo?',
    text: 'Os SMS serão enviados agora e o consumo do ciclo será debitado.',
    ok: 'Disparar'
  });
  if (!ok) return;
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Disparando…';
  try {
    const r = await api('/sms/bulk', { body: f });
    toast(`${r.enviados} enviado(s)${r.falhas ? ` · ${r.falhas} falha(s)` : ''}`);
    await loadSms();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.innerHTML = txt; }
}

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
          <p class="muted" style="margin:0 0 12px;font-size:13px">Com o módulo ativo, contatos em opt-out são <b>bloqueados no backend</b> em qualquer envio do WhatsApp (mensagem, template ou campanha), até serem reativados. Não se aplica ao SMS, que é outro canal.</p>
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
        <a class="btn small no-grow" href="#" onclick="openExternal(API.api('/consent/export?status=${coFilters.status}&token=' + TOKEN));return false">${ico('download-circle', 13)} Exportar CSV</a>
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
         <p class="muted" style="margin:6px 0 0;font-size:13px">${coFilters.status === 'opted_out' ? 'Ótimo sinal, ninguém pediu para sair da sua lista.' : 'Ajuste os filtros para ver outros contatos.'}</p></div>`}
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

// ==================== INTEGRAÇÕES ====================
// Duas abas: Webhooks (genéricos) e Nuvemshop (loja conectada por OAuth).
let intTab = 'webhooks';
let nsAvailable = null;   // cache: admin liberou a integração Nuvemshop?
function setIntTab(t) { intTab = t; renderIntegrations(); }

async function renderIntegrations() {
  // Integrações ainda não liberadas pelo admin nem aparecem na lista de abas —
  // nada de "em breve" entregando roadmap para concorrente.
  if (nsAvailable === null) { try { nsAvailable = (await api('/integrations/nuvemshop')).nuvemshop.available; } catch { nsAvailable = false; } }
  if (!nsAvailable && intTab === 'nuvemshop') intTab = 'webhooks';
  const tabs = [['webhooks', 'Webhooks', 'webhook']];
  if (nsAvailable) tabs.push(['nuvemshop', 'Nuvemshop', 'cart']);
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row" style="align-items:center">
      <div style="flex:1"><h1>Integrações</h1><p>Conecte o EliteChat às ferramentas e à loja que você já usa</p></div>
      ${intTab === 'webhooks' ? `<button class="btn primary no-grow" onclick="createWebhook()">${ico('plus', 14)} Novo webhook</button>` : ''}
    </div>
    <div class="seg int-tabs">${tabs.map(([k, l, i]) => `<button class="${k === intTab ? 'on' : ''}" onclick="setIntTab('${k}')">${ico(i, 13)} ${l}</button>`).join('')}</div>
    <div id="int-body">${skel(4)}</div>
  </div>`;
  if (intTab === 'nuvemshop') return loadNuvemshop();
  $('#int-body').innerHTML = `<div id="wh-box">${skel(4)}</div>`;
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
  else if ((state.view === 'integrations' || state.view === 'webhooks') && intTab === 'webhooks' && !whMap) loadWebhooks();
}
async function whWaitSuccess() {
  const id = whWait && whWait.id;
  whStopWait();
  toast('🎉 Evento recebido, variáveis capturadas!');
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
    toast(r.matched ? 'Evento de teste recebido, contato criado/atualizado!' : 'Evento recebido, mas o telefone não foi mapeado ainda.');
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
  return [{ value: '', label: 'não mapear' }].concat(paths.map(p => ({ value: p, label: p })));
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
    <button class="btn small no-grow" style="margin-bottom:14px" onclick="closeWhMapping()">${ico('arrowleft', 13)} Voltar aos webhooks</button>
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
  if (!whMapDraft.phone) return toast('Mapeie o Telefone (WhatsApp), é obrigatório para gerar o contato', 'error');
  const custom = (whMapDraft.custom || []).filter(c => c.key && c.path);
  try {
    const r = await api('/webhooks/' + whMap.id, { method: 'PUT', body: { mapping: { ...whMapDraft, custom } } });
    whList = whList.map(w => w.id === whMap.id ? r.webhook : w);
    toast('Mapeamento salvo!');
    closeWhMapping();
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== INTEGRAÇÃO NUVEMSHOP ====================
let nsCfg = null;

async function loadNuvemshop() {
  try { nsCfg = (await api('/integrations/nuvemshop')).nuvemshop; }
  catch (e) { $('#int-body').innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  paintNuvemshop();
}

function paintNuvemshop() {
  const box = $('#int-body'); if (!box || intTab !== 'nuvemshop') return;
  const c = nsCfg;

  // Admin ainda não liberou a integração.
  if (!c.available) {
    box.innerHTML = `<div class="empty-state card"><div class="big">${ico('cart', 38)}</div>
      <b>Integração com a Nuvemshop em breve</b>
      <p class="muted" style="margin:6px auto 0;max-width:520px">Estamos finalizando a publicação do app oficial do EliteChat na Nuvemshop.
      Assim que estiver disponível, você conecta sua loja aqui em um clique, sem precisar de código, App ID ou chaves.</p></div>`;
    return;
  }

  // Cabeçalho padrão dos passos: ícone + título/descrição + status.
  const hd = (icon, num, titulo, desc, pill) => `<div class="ns-hd">
    <span class="ns-ic">${ico(icon, 18)}</span>
    <div class="ns-hd-txt"><b>${num ? num + '. ' : ''}${titulo}</b><span>${desc}</span></div>
    ${pill}
  </div>`;

  // Passo 1 — conexão OAuth com a loja (é tudo que o cliente precisa fazer).
  const passo1 = `<div class="card">
    ${hd(c.connected ? 'check-circle' : 'cart', 1, 'Conectar sua loja',
      c.connected
        ? `Loja <b>${esc(c.storeName || c.storeId)}</b> conectada ${c.connectedAt ? timeAgo(c.connectedAt) : ''}`
        : 'Autorize o EliteChat a ler os pedidos e clientes da sua loja',
      c.connected ? '<span class="pill done">Conectada</span>' : '<span class="pill pending">Desconectada</span>')}
    ${c.connected ? `
      <div class="wh-meta">
        <span class="pill">${fmtN(c.events || 0)} evento(s) recebido(s)</span>
        ${c.lastEventAt ? `<span class="pill done">último: ${esc(c.lastEvent || '')} · ${timeAgo(c.lastEventAt)}</span>` : '<span class="pill pending">Nenhum evento ainda</span>'}
        <span class="pill">${(c.hooks || []).length} evento(s) assinado(s)</span>
        ${c.storeUrl ? `<a class="pill" href="${esc(c.storeUrl)}" target="_blank" rel="noopener">Abrir loja ↗</a>` : ''}
      </div>
      <div class="ns-actions">
        <button class="btn small no-grow" onclick="testNs()">${ico('activity', 13)} Testar conexão</button>
        <button class="btn small no-grow" onclick="rehookNs()">${ico('refresh', 13)} Reassinar eventos</button>
        <button class="btn small danger no-grow" onclick="disconnectNs()">${ico('slash', 13)} Desconectar</button>
      </div>`
    : `<div class="ns-steps">
        ${[
          ['Clique em <b>Conectar loja Nuvemshop</b> aqui embaixo', 'Uma janela da Nuvemshop vai abrir'],
          ['Entre com o login da sua loja', 'É o mesmo e-mail e senha que você usa no painel da Nuvemshop'],
          ['Confirme as permissões', 'O EliteChat pede acesso de leitura a pedidos e clientes, nada é alterado na sua loja'],
          ['Pronto', 'A janela fecha sozinha e sua loja aparece conectada aqui']
        ].map(([t, d], i) => `<div class="ns-step"><span class="ns-step-n">${i + 1}</span>
          <div><b>${t}</b><span>${d}</span></div></div>`).join('')}
      </div>
      <div class="ns-actions">
        <button class="btn primary no-grow" onclick="connectNs()">${ico('link', 13)} Conectar loja Nuvemshop</button>
        <span class="ns-nota">Permita pop-ups no navegador para a janela abrir.</span>
      </div>`}
  </div>`;

  // Passo 2 — o que fazer com os eventos.
  const passo2 = c.connected ? `<div class="card">
    ${hd('zap', 2, 'O que fazer com os eventos', 'Cada evento da loja vira contato no CRM e pode disparar automações', '')}
    <label class="chk">
      <input type="checkbox" id="ns-auto" ${c.autoContact ? 'checked' : ''} onchange="saveNsSettings()">
      Criar/atualizar o contato automaticamente a cada evento
    </label>
    <div class="ns-field">
      <span class="ns-lbl">Tags aplicadas ao contato (separadas por vírgula)</span>
      <input id="ns-tags" value="${esc((c.tags || []).join(', '))}" placeholder="Ex.: nuvemshop, loja" onchange="saveNsSettings()">
    </div>
    <div class="ns-field">
      <span class="ns-lbl">Eventos assinados na loja</span>
      <div class="wh-meta">
        ${(c.availableEvents || []).map(e => {
          const on = (c.hooks || []).some(h => h.event === e.event);
          return `<span class="pill ${on ? 'done' : 'pending'}">${esc(e.label)}</span>`;
        }).join('')}
      </div>
    </div>
    <div class="ns-field">
      <span class="ns-lbl">Variáveis disponíveis nas automações e campanhas</span>
      <div class="wh-meta">${['pedido_numero', 'pedido_total', 'pedido_status', 'pedido_pagamento', 'pedido_itens']
        .map(v => `<code class="ns-var">{{${v}}}</code>`).join('')}</div>
    </div>
  </div>` : '';

  box.innerHTML = passo1 + passo2;
}

async function saveNsSettings() {
  const tags = $('#ns-tags').value.split(',').map(t => t.trim()).filter(Boolean);
  const autoContact = $('#ns-auto').checked;
  try { nsCfg = (await api('/integrations/nuvemshop/settings', { method: 'PUT', body: { tags, autoContact } })).nuvemshop; }
  catch (e) { toast(e.message, 'error'); }
}

// Abre o consentimento da Nuvemshop numa janela e espera o postMessage do callback.
function connectNs() {
  const state = Math.random().toString(36).slice(2);
  const url = `${nsCfg.authorizeUrl}?state=${encodeURIComponent(state)}`;
  const win = openAuthWindow(url, 'nuvemshop', 'width=560,height=720');
  if (!win) return toast('Permita pop-ups para conectar a loja', 'error');

  const onMsg = async ev => {
    if (ev.origin !== window.location.origin) return;
    const d = ev.data || {};
    if (d.type !== 'ELITECHAT_NUVEMSHOP_CALLBACK') return;
    window.removeEventListener('message', onMsg);
    if (d.error) return toast('Autorização cancelada: ' + d.error, 'error');
    if (d.state !== state) return toast('Falha de segurança na autorização (state inválido)', 'error');
    try {
      const r = await api('/integrations/nuvemshop/connect', { body: { code: d.code } });
      nsCfg = r.nuvemshop;
      toast(r.aviso ? 'Loja conectada, mas os webhooks falharam: ' + r.aviso : 'Loja conectada!', r.aviso ? 'error' : '');
      paintNuvemshop();
    } catch (e) { toast(e.message, 'error'); }
  };
  window.addEventListener('message', onMsg);
}

async function testNs() {
  try { const r = await api('/integrations/nuvemshop/test'); toast('Conexão OK, ' + (r.store.name || r.store.id)); }
  catch (e) { toast(e.message, 'error'); }
}
async function rehookNs() {
  try { nsCfg = (await api('/integrations/nuvemshop/rehook', { body: {} })).nuvemshop; toast('Webhooks reassinados!'); paintNuvemshop(); }
  catch (e) { toast(e.message, 'error'); }
}
async function disconnectNs() {
  if (!await confirmModal({ title: 'Desconectar loja', text: 'O EliteChat deixa de receber pedidos e clientes desta loja. As credenciais do app são mantidas.', ok: 'Desconectar', danger: true })) return;
  try { nsCfg = (await api('/integrations/nuvemshop', { method: 'DELETE' })).nuvemshop; toast('Loja desconectada'); paintNuvemshop(); }
  catch (e) { toast(e.message, 'error'); }
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
  payment: { icon: 'pix', label: 'Cobrança Pix', sub: 'Elite Pay', color: 'green', cat: 'messages' },
  sms: { icon: 'message', label: 'Enviar SMS', sub: 'Integra X', color: 'blue', cat: 'messages' },
  end: { icon: 'square', label: 'Fim', sub: 'Encerrar', color: 'gray', cat: 'logic' }
};
const FB_PALETTE = {
  triggers: { label: 'Gatilhos', items: ['keyword', 'webhook', 'link', 'button', 'list'] },
  // "Enviar texto" cobre botões e lista (opcionais). Os nós antigos `buttons` e
  // `list` continuam funcionando em automações já criadas, mas saíram da paleta.
  messages: { label: 'Mensagens', items: ['text', 'media', 'template', 'payment', 'ai', 'sms'] },
  logic: { label: 'Lógica', items: ['delay', 'condition', 'addtag', 'removetag', 'movestage', 'http', 'end'] },
  consent: { label: 'Opt-in & Opt-out', items: ['optin', 'optout', 'reactivate'] }
};

async function renderFlows() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Flow Builder</h1><p>Automações com gatilhos e ações, sem código</p></div>
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

// Automação nova começa com o canvas VAZIO: o usuário arrasta o gatilho
// (um por fluxo) e monta o resto do fluxo do jeito dele.
function newFlow() {
  flowDraft = {
    name: '', enabled: true,
    trigger: { type: 'keyword', keyword: '', match: 'contains', phrase: '' },
    graph: { nodes: [], edges: [] }
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
    toast(okAll ? 'Automação executada com sucesso!' : 'Executada com avisos, veja os passos', okAll ? 'ok' : 'error');
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== CANVAS ARRASTA-E-SOLTA (n8n-style) ====================
const NODE_W = 236;         // largura do nó (px, coords do mundo)
const PORT_DY = 40;         // legado: âncora antiga (ver portY/portTop)
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
    case 'payment': return `Pix de R$ ${n.value || '—'}${n.description ? ' · ' + n.description.slice(0, 24) : ''}`;
    case 'delay': return `Aguardar ${n.seconds || 0}s`;
    case 'condition': return `Se ${n.field || 'texto'} ${OP_LBL[n.op] || 'contém'} "${(n.value || '').slice(0, 18)}"`;
    case 'sms': return n.text ? `SMS: ${String(n.text).slice(0, 40)}${n.text.length > 40 ? '…' : ''}` : 'SMS sem mensagem';
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
  else if (type === 'payment') { d.value = ''; d.description = ''; d.sendMessage = true; d.sendQr = false; }
  else if (type === 'sms') { d.text = ''; d.to = ''; }
  return d;
}

function openBuilder() {
  cleanupBuilder();
  const en = flowDraft.enabled;
  $('#view').innerHTML = `<div class="fb2">
    <header class="fb2-top">
      <button class="icon-btn" title="Voltar" onclick="renderFlows()">${ico('arrowleft', 17)}</button>
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
        <div class="fb2-hint" id="fb-hint">${ico('funnel', 34)}
          <b>Comece pelo gatilho</b>
          <span>Arraste um gatilho da barra lateral para o canvas, é um por automação. Depois vá montando o fluxo com as ações.</span>
        </div>
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
// Coloca o gatilho no canvas. É um só por fluxo: se já existe, apenas troca o
// tipo e seleciona o nó existente em vez de criar outro.
function placeTrigger(type, x, y) {
  if (!nodeById('trigger')) {
    if (x === undefined) { x = 60; y = 140; }
    flowDraft.graph.nodes.unshift({ id: 'trigger', type: 'trigger', x, y });
  }
  fbChangeTrigger(type);
  renderEdges(); selectNode('trigger');
}
function paletteClick(cat, key) {
  if (cat === 'triggers') placeTrigger(key);
  else addNodeAt(key);
}
function onPaletteDrop(e) {
  e.preventDefault();
  const data = e.dataTransfer.getData('text/plain'); if (!data) return;
  const [cat, key] = data.split(':');
  const wp = screenToWorld(e.clientX, e.clientY);
  const x = Math.round(wp.x - NODE_W / 2), y = Math.round(wp.y - 30);
  if (cat === 'triggers') return placeTrigger(key, x, y);
  addNodeAt(key, x, y);
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

function syncEnabledUi() {
  const pill = $('#fb-pill'), btn = $('#fb-activate');
  if (pill) { pill.className = 'fb2-pill ' + (flowDraft.enabled ? 'on' : ''); pill.textContent = flowDraft.enabled ? '▶ Ativo' : '⏸ Pausado'; }
  if (btn) btn.innerHTML = `${ico('power', 14)} ${flowDraft.enabled ? 'Desativar' : 'Ativar'}`;
}
function fbToggleEnabled() {
  // Só bloqueia ATIVAR — pausar é sempre permitido.
  if (!flowDraft.enabled) {
    if (!nodeById('trigger')) return toast('Adicione um gatilho antes de ativar', 'error');
    const issues = flowIssues();
    if (issues.length) return reportFlowIssue(issues);
  }
  flowDraft.enabled = !flowDraft.enabled;
  syncEnabledUi();
  scheduleSave();
}

// ---------- validação ----------
// Todo nó que PEDE uma orientação ao cliente (botões, lista, CTA de link ou
// condição) precisa ter o desfecho definido. Sem isso o cliente responde e o
// fluxo trava — então a automação não salva nem ativa.
// Opção pode ser string ("Sim") ou objeto ({ title: 'Sim' }).
function fbOptTitle(o) { return typeof o === 'string' ? o : String((o && o.title) || ''); }
function flowIssues() {
  if (!flowDraft || !flowDraft.graph) return [];
  const out = [];
  const nodes = flowDraft.graph.nodes || [], edges = flowDraft.graph.edges || [];
  const hasEdgeFrom = (id, branch) => edges.some(e => e.from === id && (branch ? e.branch === branch : !e.branch));
  const label = n => (NODE_TYPES[n.type] || {}).label || n.type;

  for (const n of nodes) {
    if (n.type === 'trigger') continue;

    // Botões de resposta (nó "text" com opções, ou o nó legado "buttons")
    const replies = (n.type === 'text' || n.type === 'buttons') ? (n.buttons || []) : [];
    // Itens de lista (nó legado "list")
    const items = n.type === 'list' ? (n.items || []) : [];
    const opts = replies.length ? replies : items;
    const optWord = items.length ? 'item da lista' : 'botão de resposta';

    if (opts.length) {
      const vazio = opts.findIndex(o => !fbOptTitle(o).trim());
      if (vazio >= 0) out.push({ nodeId: n.id, msg: `"${label(n)}": o ${optWord} ${vazio + 1} está sem texto.` });

      // Duas formas de continuar depois de perguntar:
      //   · uma saída POR OPÇÃO → o fluxo espera o toque e ramifica (preferida)
      //   · uma saída única     → segue direto, sem esperar (fluxos antigos)
      const porOpcao = edges.filter(e => e.from === n.id && fbIsOptBranch(e.branch));
      if (porOpcao.length) {
        for (const o of fbNodeOptions(n)) {
          if (!porOpcao.some(e => e.branch === fbOptBranch(o.id))) {
            out.push({ nodeId: n.id, msg: `"${label(n)}": o ${optWord} "${o.title}" não leva a lugar nenhum, conecte a saída dele.` });
          }
        }
      } else if (!hasEdgeFrom(n.id)) {
        out.push({ nodeId: n.id, msg: `"${label(n)}" pergunta ao cliente mas não tem resposta, conecte a saída de cada ${optWord} ao próximo passo (ou a um nó "Fim").` });
      }
    }

    // CTA de link: botão de link precisa de redirecionamento válido + rótulo
    if (n.type === 'text') {
      const url = String(n.url || '').trim(), urlText = String(n.urlText || '').trim();
      if (urlText && !url) out.push({ nodeId: n.id, msg: `"${label(n)}": o botão de link "${urlText}" está sem redirecionamento, informe a URL.` });
      if (url && !/^https?:\/\/\S+\.\S+/i.test(url)) out.push({ nodeId: n.id, msg: `"${label(n)}": a URL do botão de link é inválida, use o formato https://…` });
      if (url && !urlText) out.push({ nodeId: n.id, msg: `"${label(n)}": o botão de link está sem texto.` });
    }

    // Condição: as duas saídas precisam ter destino
    if (n.type === 'condition') {
      if (!hasEdgeFrom(n.id, 'yes')) out.push({ nodeId: n.id, msg: `"${label(n)}": a saída <b>Sim</b> não leva a lugar nenhum.` });
      if (!hasEdgeFrom(n.id, 'no')) out.push({ nodeId: n.id, msg: `"${label(n)}": a saída <b>Não</b> não leva a lugar nenhum.` });
    }

    // SMS sem texto não envia nada — o servidor recusa, então acusamos aqui
    if (n.type === 'sms' && !String(n.text || n.body || '').trim()) {
      out.push({ nodeId: n.id, msg: `"${label(n)}": a mensagem do SMS está vazia.` });
    }
  }
  return out;
}
// Mostra o primeiro problema e leva o usuário até o nó culpado.
function reportFlowIssue(issues) {
  const first = issues[0];
  toast(first.msg.replace(/<\/?b>/g, ''), 'error');
  if (first.nodeId) selectNode(first.nodeId);
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
  if (!nodeById('trigger')) { if (st) st.textContent = 'Adicione um gatilho para salvar'; return; }
  // Rascunho incompleto continua sendo guardado, mas nunca vai ao ar ativo.
  const pend = flowIssues();
  if (pend.length) flowDraft.enabled = false;
  flowDraft.nodes = [];
  try {
    if (flowDraft.id) await api('/flows/' + flowDraft.id, { method: 'PUT', body: flowDraft });
    else {
      const r = await api('/flows', { body: flowDraft });
      flowDraft.id = r.flow.id; flowDraft.hookUrl = r.flow.hookUrl; flowDraft.waLink = r.flow.waLink;
      if (fbSel === 'trigger') renderInspector();
    }
    if (st) st.textContent = pend.length ? `Rascunho salvo · pausado: ${pend.length} pendência(s)` : 'Auto-save ativo';
    if (pend.length) syncEnabledUi();
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
// ---------- SAÍDAS POR OPÇÃO (um caminho por botão / item de lista) ----------
// Perguntar e ramificar é a mesma coisa para quem monta o fluxo: cada botão
// tem a sua própria saída, e o fluxo espera o toque do cliente antes de seguir.
// O motor (src/flows.js) usa exatamente estes mesmos identificadores.
function fbNodeOptions(n) {
  if (!n) return [];
  const brutos = (n.type === 'list') ? (n.items || []) : (n.buttons || []);
  return brutos
    .map((o, i) => ({ id: (o && o.id) || (n.type === 'list' ? `row_${i + 1}` : `btn_${i + 1}`), title: fbOptTitle(o) }))
    .filter(o => o.title.trim());
}
function fbOptBranch(id) { return 'opt:' + id; }
function fbIsOptBranch(b) { return String(b || '').startsWith('opt:'); }

// ---------- GEOMETRIA DAS PORTAS ----------
// A bolinha é posicionada pelo TOPO (CSS `top`), mas a linha tem que sair do
// CENTRO dela. Misturar as duas referências é o que deixava as conexões tortas:
// a linha nascia 7,5px acima do ponto.
//
// Por isso o topo de cada porta é declarado uma vez aqui e o ponto de ancoragem
// da linha é sempre `topo + FB_PORT_HALF`. Quem mexer na posição de uma porta
// mexe nos dois ao mesmo tempo, e não há como um sair do lugar sem o outro.
const FB_PORT_HALF = 7.5;          // do topo da bolinha até o centro dela
const FB_PORT_TOP = 33;            // porta única (entrada e saída)
const FB_COND_TOP = { yes: 29, no: 59 };
const FB_OPT_TOP = 62, FB_OPT_STEP = 26;   // 1ª saída de opção e o passo entre elas

function fbOptTop(i) { return FB_OPT_TOP + Math.max(0, i) * FB_OPT_STEP; }

// Topo (CSS) da porta — usado para desenhar a bolinha.
function portTop(n, branch) {
  if (n.type === 'condition') return branch === 'no' ? FB_COND_TOP.no : FB_COND_TOP.yes;
  if (fbIsOptBranch(branch)) return fbOptTop(fbNodeOptions(n).findIndex(o => fbOptBranch(o.id) === branch));
  return FB_PORT_TOP;
}
// Centro da porta — é daqui que a linha sai/chega.
function portY(n, branch) { return portTop(n, branch) + FB_PORT_HALF; }
function portPos(n, side, branch) {
  // A entrada tem posição fixa; a saída depende do ramo (condição ou opção).
  const dy = side === 'out' ? portY(n, branch) : FB_PORT_TOP + FB_PORT_HALF;
  return { x: n.x + (side === 'out' ? NODE_W : 0), y: n.y + dy };
}
function edgeD(a, b) { const dx = Math.max(46, Math.abs(b.x - a.x) / 2); return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`; }

function renderNodes() {
  const world = $('#fb-world');
  world.querySelectorAll('.fb-n').forEach(el => el.remove());
  const hint = $('#fb-hint');
  if (hint) hint.style.display = flowDraft.graph.nodes.length ? 'none' : '';
  for (const n of flowDraft.graph.nodes) {
    const M = nodeMeta(n);
    const el = document.createElement('div');
    el.className = 'fb-n type-' + n.type + (fbSel === n.id ? ' sel' : '') + (n.type === 'trigger' ? ' trig' : '');
    el.dataset.id = n.id;
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = NODE_W + 'px';
    // O card cresce para caber as saídas das opções sem que elas vazem.
    const nOpts = fbNodeOptions(n).length;
    if (nOpts) el.style.minHeight = (fbOptTop(nOpts - 1) + FB_PORT_HALF * 2 + 10) + 'px';
    const opcoes = fbNodeOptions(n);
    const ports = n.type === 'condition'
      ? `<span class="fb-port out yes" data-id="${n.id}" data-side="out" data-branch="yes"><em>Sim</em></span>
         <span class="fb-port out no" data-id="${n.id}" data-side="out" data-branch="no"><em>Não</em></span>`
      : n.type === 'end' ? ''
      : opcoes.length
        // Uma saída por botão: o fluxo espera o toque e segue o caminho da opção.
        ? opcoes.map((o, i) => `<span class="fb-port out opt" data-id="${n.id}" data-side="out" data-branch="${esc(fbOptBranch(o.id))}" style="top:${fbOptTop(i)}px"><em>${esc(o.title.slice(0, 14))}</em></span>`).join('')
        : `<span class="fb-port out" data-id="${n.id}" data-side="out"></span>`;
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
    const opts = [{ value: '', label: hooks.length ? 'selecione um webhook' : 'Nenhum webhook criado' }]
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
      ${hooks.length ? '' : `<p class="muted" style="font-size:12px;margin-top:6px">Crie um webhook na aba <a href="#/integrations">Integrações</a> e mapeie os campos primeiro.</p>`}
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
        <span class="fb-sub" style="flex:1;margin:0">Botões, opcional</span>
        <span class="pill ${FMT[1]}">${FMT[0]}</span>
      </div>
      <p class="muted" style="font-size:11.5px;margin:4px 0 9px">
        Sem botões vira <b>texto simples</b>. Até <b>3</b> a Meta envia como <b>botões</b>; a partir de <b>4</b> vira <b>lista</b> (máx. ${FB_BTN_MAX}). Limite: ${max} caracteres por opção.
      </p>

      ${n.url && n.url.trim() ? `<p class="muted" style="font-size:11.5px;margin:0 0 8px">
        <b>Com link (CTA), a Meta não permite botões de resposta</b>, limpe a URL abaixo para usar botões.</p>` : ''}

      <div id="fb-btns">${fbBtnRows(n, max)}</div>

      <div class="row" style="gap:7px;margin-top:8px">
        <button class="btn small no-grow" ${btns.length >= FB_BTN_MAX || (n.url || '').trim() ? 'disabled' : ''} onclick="fbAddBtn('${n.id}')">${ico('plus', 12)} Adicionar opção</button>
        ${btns.length >= FB_BTN_MAX ? `<span class="muted" style="font-size:11px">Limite de ${FB_BTN_MAX} atingido.</span>` : ''}
      </div>

      ${fmt === 'list' ? `<label style="margin-top:11px">Texto do botão que abre a lista<input value="${esc(n.listButton || 'Ver opções')}" maxlength="20" ${set('listButton')} placeholder="Ver opções"></label>` : ''}
    </div>

    <details class="utm-box" ${(n.url || '').trim() ? 'open' : ''}>
      <summary>${ico('link', 13)} Botão de link (CTA), opcional</summary>
      <label style="margin-top:8px">URL<input value="${esc(n.url || '')}" ${set('url')} placeholder="https://..."></label>
      <label style="margin-top:8px">Texto do botão<input value="${esc(n.urlText || '')}" maxlength="20" ${set('urlText')} placeholder="Abrir link"></label>
      <p class="muted" style="font-size:11px;margin:8px 0 0">A Meta permite <b>1 botão de link</b> por mensagem e ele <b>não pode ser combinado</b> com botões de resposta.</p>
    </details>`;
}

function fbBtnRows(n, max) {
  const btns = n.buttons || [];
  if (!btns.length) return '<p class="muted" style="font-size:12px;margin:0">Nenhum botão, será enviado como texto simples.</p>';
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
  else if (n.type === 'payment') {
    body = `<label>Valor (R$)<input value="${esc(n.value || '')}" ${set('value')} placeholder="97,00" inputmode="decimal"></label>
      <label>Descrição da cobrança<input value="${esc(n.description || '')}" ${set('description')} maxlength="140" placeholder="Ex.: Pedido {{nome}}"></label>
      <label class="chk" style="margin-top:8px"><input type="checkbox" ${n.sendMessage !== false ? 'checked' : ''} onchange="fbSetNode('${n.id}','sendMessage',this.checked)"> Enviar a cobrança (texto) na conversa automaticamente</label>
      <label class="chk" style="margin-top:6px"><input type="checkbox" ${n.sendQr ? 'checked' : ''} onchange="fbSetNode('${n.id}','sendQr',this.checked)"> Enviar também a <b>imagem do QR Code Pix</b></label>
      <div class="var-ex-box" style="margin-top:10px">
        <p class="muted" style="font-size:11.5px;margin:0 0 6px"><b>Variáveis disponíveis nos próximos nós:</b></p>
        <p class="muted" style="font-size:11.5px;margin:0">{{pagamento.link}} · {{pagamento.valor}} · {{pagamento.codigo}} · {{pagamento.qrcode}} · {{pagamento.id}}</p>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Dica: use {{pagamento.qrcode}} num nó de <b>Mídia (imagem)</b> para enviar o QR Code.</p>
      </div>
      <p class="muted" style="font-size:11.5px;margin-top:8px">${ico('shield', 11)} Requer conta Elite Pay ativa. O valor aceita variáveis (ex.: {{valor}} vindo de um webhook).</p>`;
  }
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
        <p class="muted" style="font-size:11.5px">A Meta permite <b>1 botão de link</b> por mensagem, não pode ser combinado com respostas rápidas.</p>`
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
  } else if (n.type === 'sms') {
    body = `<p class="fb-insp-desc">Envia um <b>SMS</b> pela Integra X para o mesmo número do contato.
      Use <code>{{nome}}</code> e as demais variáveis normalmente.</p>
      <label>Mensagem<textarea rows="4" ${set('text')} placeholder="Olá {{nome}}, ...">${esc(n.text || '')}</textarea></label>
      <label>Enviar para outro número <em class="lim-extra">opcional</em>
        <input value="${esc(n.to || '')}" ${set('to')} placeholder="deixe vazio para usar o número do contato"></label>`;
  } else if (n.type === 'addtag' || n.type === 'removetag') {
    body = `<label>Tag<input value="${esc(n.tag || '')}" ${set('tag')} placeholder="ex.: lead-quente"></label>`;
  } else if (n.type === 'movestage') {
    const stages = (state.settings && state.settings.stages) || [];
    body = `<label>Etapa do funil${ecSelect('fb-move-stage', stages.map(s => ({ value: s, label: s })), n.stage || stages[0], `fbSetNode('${n.id}','stage',val)`)}</label>`;
  } else if (n.type === 'optin' || n.type === 'optout' || n.type === 'reactivate') {
    const desc = {
      optin: 'Marca o contato como <b>opt-in</b>, ele volta a receber mensagens e entra nas campanhas.',
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
function fbSetBtn(id, i, v) { nodeById(id).buttons[i].title = v; renderNodes(); renderEdges(); refreshPreview(id); scheduleSave(); }
function fbBtnMode(id, mode) {
  const n = nodeById(id);
  if (mode === 'url') { if (!n.url) n.url = 'https://'; if (!n.urlText) n.urlText = 'Abrir link'; }
  else { n.url = ''; n.urlText = ''; }
  renderInspector(); refreshPreview(id); scheduleSave();
}
function fbSetItem(id, i, v) { nodeById(id).items[i].title = v; renderNodes(); renderEdges(); refreshPreview(id); scheduleSave(); }
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
  const srcTemOpcoes = srcNode && fbNodeOptions(srcNode).length;
  if (srcNode && srcNode.type !== 'condition' && srcNode.type !== 'end' && !srcTemOpcoes && !flowDraft.graph.edges.some(e => e.from === src && !e.branch)) {
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
function addButton(id) { const n = nodeById(id); if (n.buttons.length < 3) n.buttons.push({ title: '' }); renderInspector(); renderNodes(); renderEdges(); refreshPreview(id); scheduleSave(); }
function rmButton(id, i) {
  const n = nodeById(id);
  // A saída daquele botão perde o dono: sem limpar, sobraria uma aresta
  // apontando para um caminho que ninguém mais alcança.
  const alvo = fbNodeOptions(n)[i];
  n.buttons.splice(i, 1);
  if (alvo) flowDraft.graph.edges = flowDraft.graph.edges.filter(e => !(e.from === id && e.branch === fbOptBranch(alvo.id)));
  renderInspector(); renderNodes(); renderEdges(); refreshPreview(id); scheduleSave();
}
function addItem(id) { const n = nodeById(id); if (n.items.length < 10) n.items.push({ title: '' }); renderInspector(); renderNodes(); renderEdges(); refreshPreview(id); scheduleSave(); }
function rmItem(id, i) {
  const n = nodeById(id);
  const alvo = fbNodeOptions(n)[i];
  n.items.splice(i, 1);
  if (alvo) flowDraft.graph.edges = flowDraft.graph.edges.filter(e => !(e.from === id && e.branch === fbOptBranch(alvo.id)));
  renderInspector(); renderNodes(); renderEdges(); refreshPreview(id); scheduleSave();
}
function addHeader(id) { nodeById(id).headers.push({ key: '', value: '' }); renderInspector(); scheduleSave(); }
function rmHeader(id, i) { nodeById(id).headers.splice(i, 1); renderInspector(); scheduleSave(); }

async function flowStatsModal() {
  if (!flowDraft.id) return toast('Salve a automação primeiro para ver as métricas', 'error');
  try {
    const s = await api('/flows/' + flowDraft.id + '/stats');
    openModal(`<h2>${ico('activity')} Métricas, ${esc(s.name)}</h2>
      <div class="lk-kpis">
        <div><b>${fmtN(s.runs)}</b><span>Execuções</span></div>
        <div><b>${fmtN(s.runsToday)}</b><span>Hoje</span></div>
        <div><b>${s.lastRun ? timeAgo(s.lastRun) : '—'}</b><span>Última execução</span></div>
      </div>
      ${s.history.length ? `<span class="fb-sub">Histórico recente</span>
        <div class="flow-hist">${s.history.map(h => `
          <details class="log"><summary>${ico(h.log.every(l => l.ok) ? 'check-circle' : 'alert', 14)} ${new Date(h.ts).toLocaleString('pt-BR')} · ${h.log.length} passo(s)</summary>
          <pre class="out">${esc(h.log.map(l => `${l.ok ? '✓' : '✗'} ${l.node}${l.detail ? ', ' + l.detail : ''}`).join('\n'))}</pre></details>`).join('')}</div>`
        : '<p class="muted" style="font-size:13px">Nenhuma execução ainda. A automação roda quando o gatilho for acionado.</p>'}
      <div class="row"><button class="btn primary" onclick="closeModal()">Fechar</button></div>`);
  } catch (e) { toast(e.message, 'error'); }
}

async function saveFlow() {
  if (!flowDraft.name.trim()) return toast('Dê um nome à automação', 'error');
  if (!nodeById('trigger')) return toast('Adicione um gatilho para salvar a automação', 'error');
  const issues = flowIssues();
  if (issues.length) return reportFlowIssue(issues);
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
  if (msg) msg.textContent = 'Código recebido, finalizando a integração automaticamente…';
  try {
    const r = await api('/wa/connect', {
      body: {
        code,
        redirectUri: usedRedirect ? API.webOrigin + '/auth/meta/callback' : undefined,
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
  const redirectUri = API.webOrigin + '/auth/meta/callback';
  const url = `https://www.facebook.com/${cfg.graphVersion}/dialog/oauth` +
    `?client_id=${encodeURIComponent(cfg.appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(esOAuthState)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent('business_management,whatsapp_business_management,whatsapp_business_messaging')}`;
  const pop = openAuthWindow(url, 'elitechat_es', 'width=700,height=780');
  if (!pop) esFail('Popup bloqueado pelo navegador. Libere popups para este site.');
}

// ==================== ELITE PAY — pagamentos Pix do cliente ====================
// Subconta própria por cliente (gateway Woovi via plataforma), cobranças Pix com
// QR Code + copia e cola + link, histórico com filtros e integração com o chat.
let epState = { tab: 'dash', q: '', status: '' };

const EP_ST = {
  active: ['Aguardando', 'pill pending'],
  paid: ['Pago', 'pill done'],
  cancelled: ['Cancelada', 'pill'],
  expired: ['Expirada', 'pill']
};
function epPill(st) { const [l, c] = EP_ST[st] || [st, 'pill']; return `<span class="${c}">${l}</span>`; }
function epParseReais(v) { return Math.round((Number(String(v || '').replace(/[^\d,.]/g, '').replace(/\./g, '').replace(',', '.')) || 0) * 100); }

async function renderElitePay() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(6)}</div></div>`;
  let d;
  try { d = await api('/elitepay'); } catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; return; }
  state.epInfo = d;
  // A aba Cartão só existe se a plataforma habilitou o adquirente.
  try { epCardTabVisible = (await api('/elitepay/card-account')).account.available; } catch { epCardTabVisible = false; }
  if (!epCardTabVisible && epState.tab === 'card') epState.tab = 'dash';

  // ---- Sem subconta → fluxo de cadastro (onboarding) ----
  if (!d.subaccount || d.subaccount.status === 'rejected') { epRenderOnboarding(d); return; }
  if (d.subaccount.status === 'pending') {
    const kyc = d.subaccount.kyc;
    if (kyc && kyc.onboardingUrl) {
      epRenderGate(d, 'shield', 'Conclua sua verificação (KYC)',
        'Falta pouco! Finalize a verificação de identidade na página segura da Woovi. Assim que a compliance aprovar, sua conta Elite Pay é liberada automaticamente.',
        `<a class="btn primary no-grow" href="${esc(kyc.onboardingUrl)}" target="_blank" rel="noopener">${ico('shield', 14)} Continuar verificação</a>`);
    } else if (kyc && (kyc.status === 'awaiting_gateway' || kyc.status === 'error')) {
      epRenderGate(d, 'clock', 'Verificação iniciada',
        'Recebemos seu cadastro. A verificação KYC será aberta assim que o gateway estiver disponível, você será avisado quando for aprovado.');
    } else {
      epRenderGate(d, 'clock', 'Cadastro em análise', 'Sua conta Elite Pay foi criada e está aguardando aprovação. Você será liberado automaticamente, não precisa fazer mais nada.');
    }
    return;
  }
  if (d.subaccount.status === 'suspended') { epRenderGate(d, 'slash', 'Conta suspensa', 'Sua conta Elite Pay está suspensa. Fale com o suporte da plataforma para reativar.'); return; }

  // ---- Subconta ativa → módulo completo ----
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Elite Pay</h1><p>Receba por Pix direto nas suas conversas, ${esc(d.subaccount.name)}</p></div>
      <button class="btn primary no-grow" onclick="epNewChargeModal()">${ico('plus', 14)} Gerar cobrança</button>
    </div>
    ${!d.configured ? `<div class="card" style="border-color:var(--amber-border);background:var(--amber-bg)"><b>⚠ Gateway não configurado.</b><p class="muted" style="margin:4px 0 0;font-size:13px">O administrador precisa informar o AppID da Woovi em Admin → Pagamentos para gerar cobranças reais.</p></div>` : ''}
    <div class="tabs">
      <button class="${epState.tab === 'dash' ? 'active' : ''}" data-tab="ep-dash" onclick="epTab('dash')">Dashboard</button>
      <button class="${epState.tab === 'charges' ? 'active' : ''}" data-tab="ep-charges" onclick="epTab('charges')">Cobranças</button>
      <button class="${epState.tab === 'products' ? 'active' : ''}" data-tab="ep-products" onclick="epTab('products')">Produtos</button>
      ${epCardTabVisible ? `<button class="${epState.tab === 'card' ? 'active' : ''}" data-tab="ep-card" onclick="epTab('card')">Cartão</button>` : ''}
      <button class="${epState.tab === 'cfg' ? 'active' : ''}" data-tab="ep-cfg" onclick="epTab('cfg')">Configurações</button>
    </div>
    <div id="ep-box">${skel(5)}</div>
  </div>`;
  epPaintTab();
}
function epTab(t) { epState.tab = t; $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'ep-' + t)); epPaintTab(); }

function epRenderGate(d, icon, title, text, actionHtml) {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Elite Pay</h1><p>Pagamentos Pix integrados ao seu atendimento</p></div>
    <div class="card empty-state" style="padding:46px 20px">
      <div class="big">${ico(icon, 38)}</div><b>${title}</b>
      <p class="muted" style="margin:8px auto 0;max-width:460px">${text}</p>
      ${actionHtml ? `<div style="margin-top:18px">${actionHtml}</div>` : ''}
    </div>
  </div>`;
}

// ---- Onboarding: criação da subconta (com KYC quando o admin exige BaaS) ----
function epRenderOnboarding(d) {
  const kyc = d.onboardingMode === 'kyc';
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Elite Pay</h1><p>Crie sua conta de pagamentos e receba por Pix sem sair do EliteChat</p></div>
    <div class="card" style="max-width:720px">
      <h2>${ico('sparkles')} Ative o Elite Pay</h2>
      <p class="muted" style="margin:0 0 16px;font-size:13px">${kyc
        ? 'Preencha os dados da empresa e do representante legal. Após enviar, você concluirá a <b>verificação de identidade (KYC/KYB)</b> na página segura da Woovi. Assim que a compliance aprovar, sua conta é liberada automaticamente.'
        : 'Preencha os dados abaixo para criar sua conta de recebimentos. O dinheiro das suas vendas cai na <b>sua chave Pix</b>, cobranças, QR Code e links são gerados aqui dentro, direto nas conversas.'}</p>
      <div class="row">
        <label style="flex:2">Nome / Razão social<input id="ep-ob-name" placeholder="Minha Empresa LTDA"></label>
        <label style="flex:1">CPF / CNPJ<input id="ep-ob-doc" placeholder="00.000.000/0000-00" inputmode="numeric"></label>
      </div>
      <div class="row" style="margin-top:9px">
        <label style="flex:1.4">E-mail financeiro<input id="ep-ob-email" type="email" placeholder="financeiro@empresa.com"></label>
        <label style="flex:1">Telefone<input id="ep-ob-phone" placeholder="(11) 99999-9999" inputmode="tel"></label>
      </div>
      ${kyc ? `
      <div class="var-ex-box" style="margin-top:14px">
        <p class="muted" style="font-size:11.5px;margin:0 0 8px"><b>${ico('shield', 11)} Representante legal</b>, exigido pela verificação KYC/KYB da Woovi.</p>
        <div class="row">
          <label style="flex:2">Nome completo do responsável<input id="ep-ob-repname" placeholder="Nome do sócio/representante"></label>
          <label style="flex:1">CPF do responsável<input id="ep-ob-repdoc" placeholder="000.000.000-00" inputmode="numeric"></label>
        </div>
      </div>` : ''}
      <div class="row" style="margin-top:9px;align-items:flex-end">
        <label style="flex:1.4">Chave Pix (onde você recebe)<input id="ep-ob-pix" placeholder="sua chave Pix"></label>
        <label style="flex:1">Tipo da chave${ecSelect('ep-ob-pixtype', [
          { value: 'cpf', label: 'CPF' }, { value: 'cnpj', label: 'CNPJ' }, { value: 'email', label: 'E-mail' },
          { value: 'telefone', label: 'Telefone' }, { value: 'aleatoria', label: 'Aleatória' }
        ], 'cpf')}</label>
      </div>
      <p class="hint" style="margin-top:12px">${ico('shield', 12)} ${kyc
        ? 'A verificação de identidade é feita diretamente pela Woovi (instituição de pagamento regulada pelo Banco Central).'
        : 'Seus dados são usados apenas para criar a subconta de recebimento no gateway de pagamentos da plataforma.'}</p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn primary no-grow" id="ep-ob-btn" onclick="epSubmitOnboarding()">${ico('zap', 14)} ${kyc ? 'Iniciar verificação' : 'Criar minha conta Elite Pay'}</button>
      </div>
      <p id="ep-ob-err" class="err"></p>
    </div>
  </div>`;
}
async function epSubmitOnboarding() {
  const btn = $('#ep-ob-btn'); btn.disabled = true;
  try {
    const body = {
      name: $('#ep-ob-name').value, document: $('#ep-ob-doc').value,
      email: $('#ep-ob-email').value, phone: $('#ep-ob-phone').value,
      pixKey: $('#ep-ob-pix').value, pixKeyType: ecVal('ep-ob-pixtype') || 'cpf'
    };
    if ($('#ep-ob-repname')) { body.repName = $('#ep-ob-repname').value; body.repDocument = $('#ep-ob-repdoc').value; }
    const r = await api('/elitepay/subaccount', { body });
    // Modo KYC: abre a verificação hospedada da Woovi em nova aba
    if (r.onboardingUrl) { openExternal(r.onboardingUrl); toast('Conclua a verificação KYC na aba que abriu'); }
    else toast(r.subaccount.status === 'active' ? 'Conta Elite Pay criada e ativada! 🎉' : 'Conta criada, aguardando aprovação');
    renderElitePay();
  } catch (e) { const el = $('#ep-ob-err'); if (el) el.textContent = e.message; toast(e.message, 'error'); }
  finally { if ($('#ep-ob-btn')) $('#ep-ob-btn').disabled = false; }
}

// ---- Abas ----
async function epPaintTab() {
  const box = $('#ep-box'); if (!box) return;
  if (epState.tab === 'dash') return epPaintDash(box);
  if (epState.tab === 'charges') return epPaintCharges(box);
  if (epState.tab === 'products') return epPaintProducts(box);
  if (epState.tab === 'card') return epPaintCard(box);
  return epPaintCfg(box);
}

// ---------- Elite Pay → Cartão: conta de recebimento do lojista ----------
// Sem recebedor próprio o dinheiro do cartão cairia na conta da plataforma —
// por isso o cadastro (KYC) é obrigatório antes de vender no cartão.
let epCardTabVisible = false;
let epCardAcc = null;

async function epPaintCard(box) {
  box.innerHTML = skel(4);
  try { epCardAcc = (await api('/elitepay/card-account')).account; }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const a = epCardAcc;

  if (!a.available) {
    box.innerHTML = `<div class="card empty-state"><div class="big">${ico('card', 36)}</div>
      <b>Cartão indisponível</b><p class="muted" style="margin:6px auto 0;max-width:460px">A plataforma ainda não habilitou o pagamento com cartão.</p></div>`;
    return;
  }

  const ST = {
    none: ['pending', 'Não cadastrado'], pending: ['pending', 'Em análise'],
    active: ['done', 'Ativo'], refused: ['failed', 'Recusado'], blocked: ['failed', 'Bloqueado']
  }[a.status] || ['pending', a.status];

  // Já cadastrado: mostra o status e não repete o formulário.
  if (a.status !== 'none' && a.status !== 'refused') {
    box.innerHTML = `<div class="card">
      <div class="row" style="align-items:center;margin-bottom:6px">
        <h2 style="margin:0;flex:1">${ico('card')} Conta de recebimento no cartão</h2>
        <span class="pill ${ST[0]}">${ST[1]}</span>
      </div>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        ${a.ready
          ? 'Tudo certo, as vendas no cartão caem direto na sua conta bancária, já descontada a taxa da plataforma.'
          : esc(a.reason || 'Seu cadastro está em análise pelo adquirente. Isso costuma levar de algumas horas a 2 dias úteis.')}
      </p>
      ${a.fields ? `<div class="wh-meta">
        <span class="pill">${esc(a.fields.name)}</span>
        <span class="pill">${esc(a.fields.document)}</span>
        ${a.fields.bank ? `<span class="pill">Banco ${esc(a.fields.bank)} · conta ••••${esc(a.fields.accountLast)}</span>` : ''}
        ${a.createdAt ? `<span class="pill">enviado ${timeAgo(a.createdAt)}</span>` : ''}
      </div>` : ''}
      <div class="row" style="margin-top:16px">
        <button class="btn small no-grow" onclick="epPaintCard($('#ep-box'))">${ico('refresh', 13)} Atualizar status</button>
      </div>
    </div>`;
    return;
  }

  // Não cadastrado (ou recusado): mostra o formulário de KYC.
  const pf = (epCardForm.docType || 'individual') === 'individual';
  const precisaBanco = a.provider === 'pagarme';
  box.innerHTML = `<div class="card">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="margin:0;flex:1">${ico('card')} Ative o recebimento no cartão</h2>
      <span class="pill ${ST[0]}">${ST[1]}</span>
    </div>
    ${a.status === 'refused' ? `<div class="card err" style="margin:0 0 14px">Cadastro recusado pelo adquirente${a.refusedReason ? ': ' + esc(a.refusedReason) : ''}. Revise os dados e envie de novo.</div>` : ''}
    <p class="muted" style="margin:0 0 16px;font-size:13px">
      Exigido pelo Banco Central para receber por cartão. Os dados vão direto para o adquirente
      (<b>${esc(a.provider === 'asaas' ? 'Asaas' : 'Pagar.me')}</b>), o dinheiro cai na <b>sua</b> conta, não na da plataforma.
    </p>

    <div class="kindrow" style="display:flex;gap:10px;margin-bottom:16px">
      <label class="chk"><input type="radio" name="ep-doctype" value="individual" ${pf ? 'checked' : ''} onchange="epCardSetType('individual')"> Pessoa física (CPF)</label>
      <label class="chk"><input type="radio" name="ep-doctype" value="company" ${pf ? '' : 'checked'} onchange="epCardSetType('company')"> Empresa (CNPJ)</label>
    </div>

    <div class="ns-grid">
      <label>${pf ? 'Nome completo' : 'Nome fantasia'}<input id="ep-c-name" value="${esc(epCardForm.name || state.user || '')}"></label>
      ${pf ? '' : `<label>Razão social<input id="ep-c-company" value="${esc(epCardForm.companyName || '')}"></label>`}
      <label>${pf ? 'CPF' : 'CNPJ'}<input id="ep-c-doc" value="${esc(epCardForm.document || '')}" inputmode="numeric" placeholder="${pf ? '000.000.000-00' : '00.000.000/0000-00'}"></label>
      <label>E-mail<input id="ep-c-email" type="email" value="${esc(epCardForm.email || '')}"></label>
      <label>Celular<input id="ep-c-phone" value="${esc(epCardForm.phone || '')}" inputmode="tel" placeholder="(11) 91234-5678"></label>
      ${pf ? `<label>Data de nascimento<input id="ep-c-birth" value="${esc(epCardForm.birthdate || '')}" placeholder="DD/MM/AAAA" maxlength="10"></label>` : ''}
      ${pf && precisaBanco ? `<label>Nome da mãe<input id="ep-c-mother" value="${esc(epCardForm.motherName || '')}"></label>` : ''}
      <label>Faturamento mensal (R$)<input id="ep-c-income" value="${esc(epCardForm.monthlyIncomeBRL || '')}" inputmode="decimal" placeholder="5000,00"></label>
    </div>

    <div class="ns-lbl" style="margin-top:18px">Endereço</div>
    <div class="ns-grid">
      <label>CEP<input id="ep-c-zip" value="${esc(epCardForm.zip || '')}" inputmode="numeric" placeholder="00000-000" maxlength="9"></label>
      <label>Rua / Avenida<input id="ep-c-street" value="${esc(epCardForm.street || '')}"></label>
      <label>Número<input id="ep-c-num" value="${esc(epCardForm.number || '')}"></label>
      <label>Complemento (opcional)<input id="ep-c-comp" value="${esc(epCardForm.complement || '')}"></label>
      <label>Bairro<input id="ep-c-hood" value="${esc(epCardForm.neighborhood || '')}"></label>
      <label>Cidade<input id="ep-c-city" value="${esc(epCardForm.city || '')}"></label>
      <label>Estado (UF)<input id="ep-c-state" value="${esc(epCardForm.state || '')}" maxlength="2" placeholder="SP"></label>
    </div>

    ${precisaBanco ? `
      <div class="ns-lbl" style="margin-top:18px">Conta bancária que vai receber</div>
      <div class="ns-grid">
        <label>Banco (código)<input id="ep-c-bank" value="${esc(epCardForm.bank || '')}" inputmode="numeric" placeholder="341" maxlength="3"></label>
        <label>Agência<input id="ep-c-branch" value="${esc(epCardForm.branch || '')}" inputmode="numeric" placeholder="1234"></label>
        <label>Conta<input id="ep-c-acc" value="${esc(epCardForm.accountNumber || '')}" inputmode="numeric" placeholder="56789"></label>
        <label>Dígito<input id="ep-c-accd" value="${esc(epCardForm.accountDigit || '')}" inputmode="numeric" placeholder="0" maxlength="2"></label>
        <label>Tipo de conta${ecSelect('ep-c-acctype', [
          { value: 'checking', label: 'Corrente' }, { value: 'savings', label: 'Poupança' }
        ], epCardForm.accountType || 'checking', '')}</label>
      </div>
      <p class="hint" style="margin-top:8px">O titular da conta precisa ser o mesmo do ${pf ? 'CPF' : 'CNPJ'} informado acima.</p>`
    : '<p class="hint" style="margin-top:16px">O Asaas cria sua carteira digital, você define a conta de saque depois, no painel dele.</p>'}

    <div class="ns-actions">
      <button class="btn primary no-grow" id="ep-c-go" onclick="epCardSubmit()">${ico('shield', 14)} Enviar cadastro</button>
      <span class="ns-nota">Análise do adquirente: de algumas horas a 2 dias úteis.</span>
    </div>
  </div>`;

  // máscaras
  const m = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('input', () => { el.value = fn(el.value); }); };
  m('ep-c-doc', v => (epCardForm.docType === 'company' ? maskCnpj(v) : maskCpf(v)));
  m('ep-c-zip', v => v.replace(/\D/g, '').slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'));
  m('ep-c-birth', v => { const d = v.replace(/\D/g, '').slice(0, 8); return d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; });
  m('ep-c-state', v => v.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 2));
}

let epCardForm = { docType: 'individual' };
function epCardSetType(t) { epCardCollect(); epCardForm.docType = t; epPaintCard($('#ep-box')); }
function maskCpf(v) { return v.replace(/\D/g, '').slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4'); }
function maskCnpj(v) { return v.replace(/\D/g, '').slice(0, 14).replace(/(\d{2})(\d)/, '$1.$2').replace(/(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2'); }

// Guarda o que já foi digitado (para não perder ao trocar PF/PJ ou reexibir).
function epCardCollect() {
  const g = id => { const el = $('#' + id); return el ? el.value.trim() : undefined; };
  const f = epCardForm;
  const set = (k, v) => { if (v !== undefined) f[k] = v; };
  set('name', g('ep-c-name')); set('companyName', g('ep-c-company'));
  set('document', g('ep-c-doc')); set('email', g('ep-c-email')); set('phone', g('ep-c-phone'));
  set('birthdate', g('ep-c-birth')); set('motherName', g('ep-c-mother'));
  set('monthlyIncomeBRL', g('ep-c-income'));
  set('zip', g('ep-c-zip')); set('street', g('ep-c-street')); set('number', g('ep-c-num'));
  set('complement', g('ep-c-comp')); set('neighborhood', g('ep-c-hood'));
  set('city', g('ep-c-city')); set('state', g('ep-c-state'));
  set('bank', g('ep-c-bank')); set('branch', g('ep-c-branch'));
  set('accountNumber', g('ep-c-acc')); set('accountDigit', g('ep-c-accd'));
  const t = $('#ep-c-acctype'); if (t) f.accountType = ecVal('ep-c-acctype') || 'checking';
  return f;
}

async function epCardSubmit() {
  const f = epCardCollect();
  const btn = $('#ep-c-go'); const txt = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    await api('/elitepay/card-account', {
      body: {
        ...f,
        docType: f.docType,
        // servidor espera centavos
        monthlyIncome: Math.round(Number(String(f.monthlyIncomeBRL || '').replace(/\./g, '').replace(',', '.')) * 100) || 0
      }
    });
    toast('Cadastro enviado! Acompanhe o status aqui.');
    epPaintCard($('#ep-box'));
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = txt;
  }
}

async function epPaintDash(box) {
  try {
    const { metrics: m, recent, logs } = await api('/elitepay/dashboard');
    const maxV = Math.max(1, ...m.series.map(s => s.value));
    box.innerHTML = `
      <div class="metric-hero">
        <div class="mh-card hi"><span class="mh-ic">${ico('zap', 20)}</span><div class="mh-val">${fmtBRL(m.totalPaid)}</div><div class="mh-lbl">Total recebido</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('activity', 20)}</span><div class="mh-val">${fmtBRL(m.paid30d)}</div><div class="mh-lbl">Recebido. 30 dias</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('clock', 20)}</span><div class="mh-val">${fmtBRL(m.pendingValue)}</div><div class="mh-lbl">${m.pendingCount} cobrança(s) aguardando</div></div>
        <div class="mh-card"><span class="mh-ic">${ico('check', 20)}</span><div class="mh-val">${fmtN(m.countPaid)}</div><div class="mh-lbl">Pagamentos confirmados</div></div>
      </div>
      <div class="card">
        <h2>${ico('activity')} Recebimentos, últimos 14 dias</h2>
        <div class="ep-chart">${m.series.map(s => `
          <div class="ep-bar-w" title="${new Date(s.day).toLocaleDateString('pt-BR')} · ${fmtBRL(s.value)}">
            <div class="ep-bar" style="height:${Math.max(3, Math.round(s.value / maxV * 100))}%"></div>
            <span>${new Date(s.day).toLocaleDateString('pt-BR', { day: '2-digit' })}</span>
          </div>`).join('')}</div>
      </div>
      <div class="card">
        <h2>${ico('clock')} Últimas cobranças</h2>
        ${recent.length ? epChargesTable(recent) : '<p class="muted">Nenhuma cobrança ainda, clique em <b>Gerar cobrança</b> para começar.</p>'}
      </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

function epChargesTable(list) {
  return `<div style="overflow-x:auto"><table><thead><tr><th>Criada</th><th>Contato</th><th>Descrição</th><th style="text-align:right">Valor</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.map(c => `<tr>
      <td class="muted" style="white-space:nowrap">${timeAgo(c.createdAt)}</td>
      <td>${c.contactName ? `<b>${esc(c.contactName)}</b>` : '<span class="muted">—</span>'}${c.waId ? `<div class="muted" style="font-size:11px">+${esc(c.waId)}</div>` : ''}</td>
      <td class="muted">${esc(c.comment || '—')}</td>
      <td style="text-align:right"><b>${fmtBRL(c.value)}</b></td>
      <td>${epPill(c.status)}</td>
      <td style="white-space:nowrap;text-align:right">
        <button class="btn small" title="Detalhes / QR Code" onclick="epChargeDetail('${c.id}')">${ico('eye', 13)}</button>
        ${c.status === 'active' && c.waId ? `<button class="btn small" title="Reenviar no WhatsApp" onclick="epResend('${c.id}')">${ico('send', 13)}</button>` : ''}
        <button class="btn small" title="Duplicar" onclick="epDuplicate('${c.id}')">${ico('copy', 13)}</button>
        ${c.status === 'active' ? `<button class="btn small danger" title="Cancelar" onclick="epCancel('${c.id}')">${ico('slash', 13)}</button>` : ''}
      </td>
    </tr>`).join('')}</tbody></table></div>`;
}

async function epPaintCharges(box) {
  box.innerHTML = `
    <div class="card">
      <div class="row" style="align-items:flex-end">
        <label style="flex:2">Pesquisar<input id="ep-q" placeholder="Contato, telefone ou descrição…" value="${esc(epState.q)}" oninput="epState.q=this.value;epDebounceList()"></label>
        <label style="flex:1">Status${ecSelect('ep-status', [
          { value: '', label: 'Todos' }, { value: 'active', label: 'Aguardando' }, { value: 'paid', label: 'Pagas' },
          { value: 'cancelled', label: 'Canceladas' }, { value: 'expired', label: 'Expiradas' }
        ], epState.status, 'epState.status=val;epListCharges()')}</label>
      </div>
      <div id="ep-list" style="margin-top:14px">${skel(4)}</div>
    </div>`;
  epListCharges();
}
let epListTimer = null;
function epDebounceList() { clearTimeout(epListTimer); epListTimer = setTimeout(epListCharges, 300); }
async function epListCharges() {
  const el = $('#ep-list'); if (!el) return;
  try {
    const { charges, total } = await api(`/elitepay/charges?q=${encodeURIComponent(epState.q)}&status=${encodeURIComponent(epState.status)}`);
    el.innerHTML = charges.length
      ? `<p class="muted" style="font-size:12px;margin:0 0 8px">${total} cobrança(s)</p>` + epChargesTable(charges)
      : '<p class="muted">Nenhuma cobrança com esses filtros.</p>';
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

async function epPaintCfg(box) {
  const s = (state.epInfo && state.epInfo.settings) || {};
  const sub = (state.epInfo && state.epInfo.subaccount) || {};
  const info = state.epInfo || {};
  box.innerHTML = `
    <div class="card">
      <h2>${ico('file')} Modelos de mensagem</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        Cobrança e confirmação de pagamento são enviadas como <b>Templates aprovados pela Meta</b>, por isso
        chegam mesmo <b>fora da janela de 24h</b>. Crie os modelos em <a href="#/templates/new">Modelos</a>
        marcando o papel de cada um; se tiver mais de um do mesmo papel, escolha aqui qual é enviado.
      </p>
      ${epTplPicker('cobranca', 'Cobrança', 'pix', info.chargeTemplates || [], info.chargeTemplateName)}
      ${epTplPicker('confirmacao', 'Confirmação de pagamento', 'check-circle', info.confirmTemplates || [], info.confirmTemplateName)}
    </div>
    <div class="card">
      <h2>${ico('gear')} Preferências de cobrança</h2>
      <div class="row" style="margin-top:4px;align-items:flex-end">
        <label style="max-width:260px">Validade da cobrança${ecSelect('ep-cfg-exp', [
          { value: '60', label: '1 hora' }, { value: '360', label: '6 horas' }, { value: '720', label: '12 horas' },
          { value: '1440', label: '24 horas' }, { value: '4320', label: '3 dias' }, { value: '10080', label: '7 dias' }
        ], String(s.expiresMin || 1440))}</label>
        <label class="chk" style="padding-bottom:8px"><input type="checkbox" id="ep-cfg-notify" ${s.notifyPaid ? 'checked' : ''}> Confirmar pagamento no WhatsApp automaticamente</label>
      </div>
      <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn primary no-grow" onclick="epSaveCfg()">${ico('save', 14)} Salvar</button></div>
    </div>
    <div class="card">
      <h2>${ico('shield')} Sua conta de recebimento</h2>
      <div class="wa-status">
        <div class="wa-row"><span>Titular</span><b>${esc(sub.name || '—')}</b></div>
        <div class="wa-row"><span>Documento</span><b>${esc(sub.document || '—')}</b></div>
        <div class="wa-row"><span>Chave Pix</span><b>${esc(sub.pixKey || '—')} (${esc(sub.pixKeyType || '')})</b></div>
        <div class="wa-row"><span>Status</span><b>${sub.status === 'active' ? 'Ativa ✅' : esc(sub.status || '')}</b></div>
        <div class="wa-row"><span>Criada em</span><b>${sub.createdAt ? new Date(sub.createdAt).toLocaleDateString('pt-BR') : '—'}</b></div>
        ${state.epInfo.feeInPercent ? `<div class="wa-row"><span>Taxa por venda (PIX In)</span><b>${state.epInfo.feeInPercent}%</b></div>` : ''}
        ${state.epInfo.feeOutPercent ? `<div class="wa-row"><span>Taxa por saque (PIX Out)</span><b>${state.epInfo.feeOutPercent}%</b></div>` : ''}
      </div>
    </div>`;
}
// Seletor do modelo usado em cada papel. Com um só, mostra qual é; com vários,
// vira um select; com nenhum, convida a criar.
function epTplPicker(role, label, icone, lista, atual) {
  const aprovados = lista.filter(t => t.approved);
  const pendentes = lista.length - aprovados.length;

  if (!lista.length) {
    return `<div class="tplpick vazio">
      <div class="tplpick-head">${ico(icone, 14)} <b>${esc(label)}</b></div>
      <p class="muted" style="margin:6px 0 10px;font-size:12.5px">
        Nenhum modelo de ${esc(label.toLowerCase())} ainda.
        ${role === 'confirmacao'
          ? 'Sem ele, a confirmação vai como texto simples, e só chega dentro das 24h.'
          : 'Sem ele, a cobrança vai como texto simples, e só chega dentro das 24h.'}
      </p>
      <a class="btn small no-grow" href="#/templates/new">${ico('plus', 13)} Criar modelo de ${esc(label.toLowerCase())}</a>
    </div>`;
  }

  return `<div class="tplpick">
    <div class="tplpick-head">${ico(icone, 14)} <b>${esc(label)}</b>
      <span class="pill ${aprovados.length ? 'done' : 'pending'}">${fmtN(aprovados.length)} aprovado(s)</span>
      ${pendentes ? `<span class="pill pending">${fmtN(pendentes)} em análise</span>` : ''}
    </div>
    ${aprovados.length > 1 ? `
      <label style="margin-top:10px">Modelo enviado${ecSelect('ep-tpl-' + role,
        aprovados.map(t => ({ value: t.name, label: `${t.name} (${t.language})` })),
        atual || aprovados[0].name, `epPickTpl('${role}',val)`)}</label>`
    : `<p class="muted" style="margin:8px 0 0;font-size:12.5px">Enviando <b>${esc((aprovados[0] || lista[0]).name)}</b>${aprovados.length ? '' : ', <b style="color:var(--amber)">aguardando aprovação da Meta</b>'}.</p>`}
    ${(aprovados.find(t => t.name === (atual || (aprovados[0] || {}).name)) || {}).body
      ? `<p class="tplpick-body">${esc((aprovados.find(t => t.name === (atual || aprovados[0].name)) || {}).body).slice(0, 180)}</p>` : ''}
  </div>`;
}

async function epPickTpl(role, name) {
  const campo = role === 'cobranca' ? 'chargeTemplateName' : 'confirmTemplateName';
  try {
    const r = await api('/elitepay/settings', { method: 'PUT', body: { [campo]: name } });
    if (state.epInfo) state.epInfo[campo] = r[campo];
    toast(`Modelo de ${role === 'cobranca' ? 'cobrança' : 'confirmação'}: ${name}`);
    epPaintCfg($('#ep-box'));
  } catch (e) { toast(e.message, 'error'); }
}

// Variáveis do modelo de cobrança (inseridas no cursor)
const EP_MSG_VARS = [
  { tag: '{nome}', label: 'contato' },
  { tag: '{valor}', label: 'valor' },
  { tag: '{descricao}', label: 'descrição' },
  { tag: '{link}', label: 'link de pagamento' },
  { tag: '{codigo}', label: 'Pix copia e cola' }
];
function epInsertVar(tag) {
  const el = document.getElementById('ep-cfg-msg'); if (!el) return;
  const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + tag + el.value.slice(e);
  el.focus(); el.selectionStart = el.selectionEnd = s + tag.length;
  epMsgPreview();
}
function epMsgPreview() {
  const el = document.getElementById('ep-cfg-msg'), prev = document.getElementById('ep-msg-preview');
  if (!el || !prev) return;
  const sample = {
    '{nome}': 'Maria', '{valor}': 'R$ 97,00', '{descricao}': 'Plano mensal, julho',
    '{link}': 'pay.elitechat.app/x7Qk2', '{codigo}': '00020126…5204000053039865802BR6304AB12'
  };
  let txt = el.value || '';
  for (const k in sample) txt = txt.split(k).join(sample[k]);
  prev.innerHTML = txt.trim()
    ? esc(txt).replace(/\*(.+?)\*/g, '<b>$1</b>').replace(/\n/g, '<br>')
    : '<span class="muted">Escreva a mensagem acima para ver a prévia…</span>';
}
async function epSaveCfg() {
  try {
    const body = { expiresMin: Number(ecVal('ep-cfg-exp') || 1440), notifyPaid: $('#ep-cfg-notify').checked };
    if ($('#ep-cfg-msg')) body.autoMessage = $('#ep-cfg-msg').value;   // só se o editor estiver presente
    const r = await api('/elitepay/settings', { method: 'PUT', body });
    state.epInfo.settings = r.settings;
    toast('Preferências de cobrança salvas');
  } catch (e) { toast(e.message, 'error'); }
}

// ---- CHECKOUT BUILDER: página dedicada (#/elitepay/checkout) ----
let epkState = null;
let epkPrevStep = 1;   // etapa exibida na prévia: 1 dados · 2 pix
const EPK_COLORS = ['#10b981', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#111827'];

async function renderCheckoutBuilder() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(6)}</div></div>`;
  if (!state.epInfo) {
    try { state.epInfo = await api('/elitepay'); }
    catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; return; }
  }
  if (!state.epInfo.subaccount || state.epInfo.subaccount.status !== 'active') { location.hash = '#/elitepay'; return; }
  // ?c=<id> abre um template específico; sem isso, o padrão
  const wanted = new URLSearchParams((location.hash.split('?')[1] || '')).get('c');
  let ck = state.epInfo.checkout || {};
  if (wanted) {
    try { const r = await api('/elitepay/checkouts'); ck = r.checkouts.find(c => c.id === wanted) || ck; } catch {}
  }
  epkCheckoutId = ck.id || '';
  epkCheckoutName = ck.name || 'Checkout padrão';
  epkState = {
    banner: ck.banner || '', bannerMobile: ck.bannerMobile || '',
    logo: ck.logo || '', logoMobile: ck.logoMobile || '',
    title: ck.title || '', description: ck.description || '',
    color: ck.color || '#10b981', successMsg: ck.successMsg || '', supportText: ck.supportText || '',
    blocks: (ck.blocks && ck.blocks.length) ? ck.blocks.slice() : EPK_BLOCK_KEYS.slice(),
    timer: Object.assign({ on: false, minutes: 15, text: 'Oferta por tempo limitado!' }, ck.timer || {}),
    benefits: Object.assign({ on: false, title: 'O que você recebe', items: [] }, ck.benefits || {}),
    testimonial: Object.assign({ on: false, name: '', role: '', text: '' }, ck.testimonial || {}),
    guarantee: Object.assign({ on: false, days: 7, text: 'Garantia incondicional de {dias} dias, devolvemos 100% do valor.' }, ck.guarantee || {}),
    faq: Object.assign({ on: false, items: [] }, ck.faq || {}),
    notice: Object.assign({ on: false, text: '' }, ck.notice || {}),
    badges: Object.assign({ on: true }, ck.badges || {}),
    methods: Object.assign({ pix: true, credit: true, boleto: false }, ck.methods || {})
  };
  epkPrevStep = 1;
  epkSection = null;          // null = paleta de componentes (estilo Kiwify)
  epkTab = 'comp';
  epkDevice = 'desktop';
  // Editor em tela cheia no formato Kiwify: canvas central grande com a página
  // sendo montada + painel DIREITO com abas Componentes/Configurações.
  $('#view').innerHTML = `<div class="ckb">
    <header class="ckb-top">
      <button class="icon-btn" title="Voltar ao Elite Pay" onclick="location.hash='#/elitepay'">${ico('arrowleft', 17)}</button>
      <div class="brand ckb-brand">
        <span class="brand-mark"><img src="/assets/elitechat-logo.png" alt="Elite Builder"></span>
        <div><b class="brand-name">Elite<span class="gt2">Builder</span></b>
          <input class="ckb-cname" id="epk-name" value="${esc(epkCheckoutName)}" maxlength="60"
            title="Nome deste checkout" oninput="epkCheckoutName=this.value"></div>
      </div>
      <div class="ckb-devices" id="epk-devseg">
        <button class="icon-btn on" data-dv="desktop" onclick="epkSetDevice('desktop')" title="Ver como computador">${ico('monitor', 16)}</button>
        <button class="icon-btn" data-dv="mobile" onclick="epkSetDevice('mobile')" title="Ver como celular">${ico('smartphone', 16)}</button>
      </div>
      <span class="ckb-status" id="epk-saved"><i></i> Tudo certo!</span>
      <div style="flex:1"></div>
      <button class="btn primary no-grow" id="epk-save" onclick="epkSave()">${ico('save', 14)} Salvar</button>
      <a class="btn no-grow" href="/pay/demo-${esc(state.accountId || '')}:${esc(epkCheckoutId)}" target="_blank" rel="noopener">${ico('globe', 14)} Ver página</a>
    </header>
    <div class="ckb-body">
      <div class="ckb-stagewrap">
        <div class="seg ckb-stepseg" id="epk-stepseg">
          <button class="on" data-pv="1" onclick="epkPrevTab(1)">Etapa 1 · Dados</button>
          <button data-pv="2" onclick="epkPrevTab(2)">Etapa 2 · Pix</button>
        </div>
        <div class="ckb-stage" id="epk-stage">
          <div class="epk-browser" id="epk-browser">
            <div class="epk-bbar"><i></i><i></i><i></i><span>elitechat.app/pay/x7Qk2</span></div>
            <div class="epk-page" id="epk-page"></div>
          </div>
        </div>
      </div>
      <aside class="ckb-side">
        <div class="ckb-tabs" id="epk-tabs">
          <button class="on" data-t="comp" onclick="epkSideTab('comp')">Componentes</button>
          <button data-t="cfg" onclick="epkSideTab('cfg')">Configurações</button>
        </div>
        <div class="ckb-panel" id="epk-side"></div>
      </aside>
    </div>
    <input type="file" id="epk-file" accept="image/png,image/jpeg,image/webp" style="display:none">
  </div>`;
  epkPaintSide();
  epkPrev();
}

// Blocos reordenáveis da página (arrastar e soltar)
const EPK_BLOCK_KEYS = ['banner', 'timer', 'product', 'notice', 'benefits', 'testimonial', 'guarantee', 'faq'];
const EPK_BLOCK_META = {
  banner:      { icon: 'image',    label: 'Banner',      hint: 'Capa no topo do site' },
  timer:       { icon: 'clock',    label: 'Cronômetro',  hint: 'Escassez / urgência' },
  product:     { icon: 'card',     label: 'Checkout',    hint: 'Formulário e Pix (fixo)', fixed: true },
  notice:      { icon: 'help',     label: 'Aviso',       hint: 'Faixa de destaque' },
  benefits:    { icon: 'check',    label: 'Vantagens',   hint: 'Lista do que o cliente recebe' },
  testimonial: { icon: 'chat2',    label: 'Depoimento',  hint: 'Prova social' },
  guarantee:   { icon: 'shield',   label: 'Garantia',    hint: 'Selo de garantia' },
  faq:         { icon: 'help',     label: 'FAQ',         hint: 'Perguntas frequentes' }
};

// Componentes do checkout (paleta do painel direito, estilo Kiwify)
const EPK_SECTIONS = [
  { key: 'marca',      icon: 'image',    label: 'Imagens',    hint: 'Logo e capa (desktop e celular)', tab: 'comp' },
  { key: 'produto',    icon: 'sparkles', label: 'Produto',    hint: 'Nome e descrição',        tab: 'comp' },
  { key: 'cor',        icon: 'target',   label: 'Aparência',  hint: 'Cor de destaque',         tab: 'comp' },
  { key: 'timer',      icon: 'clock',    label: 'Cronômetro', hint: 'Urgência na oferta',      tab: 'comp' },
  { key: 'benefits',   icon: 'check',    label: 'Vantagens',  hint: 'O que o cliente recebe',  tab: 'comp' },
  { key: 'testimonial',icon: 'chat2',    label: 'Depoimento', hint: 'Prova social',            tab: 'comp' },
  { key: 'guarantee',  icon: 'shield',   label: 'Garantia',   hint: 'Selo de garantia',        tab: 'comp' },
  { key: 'faq',        icon: 'help',     label: 'FAQ',        hint: 'Perguntas frequentes',    tab: 'comp' },
  { key: 'notice',     icon: 'help',     label: 'Aviso',      hint: 'Faixa de destaque',       tab: 'comp' },
  { key: 'pagamento',  icon: 'card',     label: 'Pagamento',  hint: 'Pix, crédito e boleto aceitos', tab: 'cfg' },
  { key: 'ordem',      icon: 'flow',     label: 'Ordem',      hint: 'Arraste os blocos da página', tab: 'cfg' },
  { key: 'mensagens',  icon: 'chat2',    label: 'Mensagens',  hint: 'Pós-pagamento e suporte', tab: 'cfg' },
  { key: 'fluxo',      icon: 'zap',      label: 'Fluxo',      hint: 'Como o checkout funciona',tab: 'cfg' }
];
let epkSection = null;
let epkTab = 'comp';
let epkDevice = 'desktop';
let epkCheckoutId = '';       // template sendo editado
let epkCheckoutName = '';

function epkSideTab(t) {
  epkTab = t; epkSection = null;
  $$('#epk-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  epkPaintSide();
}
function epkGo(k) { epkSection = k; epkPaintSide(); }
function epkBack() { epkSection = null; epkPaintSide(); }

// Painel direito: paleta de componentes OU os campos do componente aberto
function epkPaintSide() {
  const box = $('#epk-side'); if (!box) return;
  if (!epkSection) {
    const items = EPK_SECTIONS.filter(s => s.tab === epkTab);
    // widgets arrastáveis para o canvas (os que viram blocos na página)
    const BLOCO_DA_SECAO = { marca: 'banner', produto: 'product', timer: 'timer', benefits: 'benefits', testimonial: 'testimonial', guarantee: 'guarantee', faq: 'faq', notice: 'notice' };
    box.innerHTML = `<div class="ckb-grp">${epkTab === 'comp' ? 'Componentes' : 'Configurações'}</div>
      ${epkTab === 'comp' ? `<p class="muted" style="font-size:11.5px;margin:-4px 2px 10px">${ico('menu', 11)} Arraste um componente para a página ao lado, ou clique para configurar.</p>` : ''}
      <div class="ckb-comps">${items.map(s => {
        const blk = BLOCO_DA_SECAO[s.key];
        return `<button class="ckb-comp${blk ? ' drag' : ''}" onclick="epkGo('${s.key}')" title="${blk ? 'Arraste para a página ou clique para configurar' : s.hint}"
          ${blk ? `draggable="true" ondragstart="epkPalDrag(event,'${blk}')" ondragend="epkCanvasEnd()"` : ''}>
          <span class="ic">${ico(s.icon, 20)}</span><b>${s.label}</b>
        </button>`;
      }).join('')}</div>
      ${epkTab === 'cfg' ? `<a class="card link-card" style="margin-top:14px" href="#/elitepay">
        <span class="lc-ic">${ico('gear', 18)}</span>
        <div style="flex:1"><h2 style="margin:0 0 2px;font-size:13.5px">Preferências de cobrança</h2>
        <p class="muted" style="margin:0;font-size:12px">Validade do Pix e confirmação automática</p></div>
        <span class="lc-arrow">${ico('arrowright', 15)}</span></a>` : ''}`;
  } else {
    epkPaintForm();
    epkPaintThumbs();
  }
}
function epkSetDevice(d) {
  epkDevice = d;
  $$('#epk-devseg button').forEach(b => b.classList.toggle('on', b.dataset.dv === d));
  const st = $('#epk-stage'); if (st) st.classList.toggle('mobile', d === 'mobile');
}

// Campos do componente aberto (renderizados no painel direito)
function epkPaintForm() {
  const box = $('#epk-side'); if (!box) return;
  const ck = epkState;
  const sec = EPK_SECTIONS.find(s => s.key === epkSection) || EPK_SECTIONS[0];
  let body = '';

  // uploader reutilizável (cada imagem tem o seu tamanho recomendado)
  const up = (kind, titulo, dim, nota) => `
    <span class="fb-sub" style="margin-top:14px">${titulo} <span class="muted">(${dim})</span></span>
    <div class="epk-upload" id="epk-up-${kind}" onclick="epkPickImg('${kind}')">
      <div class="epk-thumb epk-thumb-${kind.startsWith('banner') ? 'banner' : 'logo'}" id="epk-th-${kind}"></div>
      <div class="epk-upmeta"><b id="epk-lbl-${kind}"></b><span class="muted">${nota} · clique para ${ck[kind] ? 'trocar' : 'enviar'}</span></div>
      <button class="btn small danger" id="epk-rm-${kind}" style="display:none" onclick="event.stopPropagation();epkRemoveImg('${kind}')">${ico('trash', 13)}</button>
    </div>`;

  if (epkSection === 'marca') {
    body = `
      <div class="ckb-devgrp">${ico('monitor', 13)} Computador</div>
      ${up('logo', 'Logo do produto', 'quadrada · 512×512 px', 'Marca no topo e miniatura no resumo')}
      ${up('banner', 'Banner / capa', 'larga · 1200×360 px', 'Aparece no header do site, abaixo da marca')}
      <div class="ckb-devgrp" style="margin-top:18px">${ico('smartphone', 13)} Celular</div>
      ${up('logoMobile', 'Logo do produto', 'quadrada · 256×256 px', 'Opcional, sem ela usamos a de computador')}
      ${up('bannerMobile', 'Banner / capa', 'vertical · 800×500 px', 'Opcional, enquadramento próprio p/ telas estreitas')}
      <p class="hint" style="margin-top:16px">${ico('shield', 12)} Envie PNG, JPG ou WebP. As imagens são <b>redimensionadas e comprimidas automaticamente</b> para o tamanho ideal, você só precisa mandar a maior versão que tiver.</p>`;
  } else if (epkSection === 'timer') {
    body = `
      <label class="chk"><input type="checkbox" ${ck.timer.on ? 'checked' : ''} onchange="epkState.timer.on=this.checked;epkPrev()"> Exibir cronômetro de oferta</label>
      <label style="margin-top:12px;display:block">Texto
        <input maxlength="120" value="${esc(ck.timer.text)}" placeholder="Oferta por tempo limitado!" oninput="epkState.timer.text=this.value;epkPrev()"></label>
      <label style="margin-top:10px;display:block">Duração (minutos)
        <input type="number" min="1" max="1440" value="${ck.timer.minutes}" oninput="epkState.timer.minutes=+this.value||15;epkPrev()"></label>
      <p class="hint" style="margin-top:12px">A contagem começa quando o cliente abre a página e continua se ele recarregar.</p>`;
  } else if (epkSection === 'benefits') {
    body = `
      <label class="chk"><input type="checkbox" ${ck.benefits.on ? 'checked' : ''} onchange="epkState.benefits.on=this.checked;epkPrev()"> Exibir lista de vantagens</label>
      <label style="margin-top:12px;display:block">Título da lista
        <input maxlength="80" value="${esc(ck.benefits.title)}" placeholder="O que você recebe" oninput="epkState.benefits.title=this.value;epkPrev()"></label>
      <span class="fb-sub" style="margin-top:14px">Itens</span>
      <div id="epk-benef-list">${epkListRows('benefits')}</div>
      <button class="btn small" style="margin-top:8px" onclick="epkAddItem('benefits')">${ico('plus', 12)} Adicionar vantagem</button>`;
  } else if (epkSection === 'testimonial') {
    body = `
      <label class="chk"><input type="checkbox" ${ck.testimonial.on ? 'checked' : ''} onchange="epkState.testimonial.on=this.checked;epkPrev()"> Exibir depoimento</label>
      <label style="margin-top:12px;display:block">Depoimento
        <textarea rows="4" maxlength="400" placeholder="Melhor investimento que fiz esse ano…" oninput="epkState.testimonial.text=this.value;epkPrev()">${esc(ck.testimonial.text)}</textarea></label>
      <div class="row" style="margin-top:10px">
        <label style="flex:1">Nome<input maxlength="60" value="${esc(ck.testimonial.name)}" placeholder="Maria S." oninput="epkState.testimonial.name=this.value;epkPrev()"></label>
        <label style="flex:1">Cargo<input maxlength="60" value="${esc(ck.testimonial.role)}" placeholder="Empreendedora" oninput="epkState.testimonial.role=this.value;epkPrev()"></label>
      </div>`;
  } else if (epkSection === 'guarantee') {
    body = `
      <label class="chk"><input type="checkbox" ${ck.guarantee.on ? 'checked' : ''} onchange="epkState.guarantee.on=this.checked;epkPrev()"> Exibir selo de garantia</label>
      <label style="margin-top:12px;display:block">Dias de garantia
        <input type="number" min="1" max="365" value="${ck.guarantee.days}" oninput="epkState.guarantee.days=+this.value||7;epkPrev()"></label>
      <label style="margin-top:10px;display:block">Texto <span class="muted">(use {dias})</span>
        <textarea rows="3" maxlength="240" oninput="epkState.guarantee.text=this.value;epkPrev()">${esc(ck.guarantee.text)}</textarea></label>`;
  } else if (epkSection === 'faq') {
    body = `
      <label class="chk"><input type="checkbox" ${ck.faq.on ? 'checked' : ''} onchange="epkState.faq.on=this.checked;epkPrev()"> Exibir perguntas frequentes</label>
      <div id="epk-faq-list" style="margin-top:12px">${epkFaqRows()}</div>
      <button class="btn small" style="margin-top:8px" onclick="epkAddFaq()">${ico('plus', 12)} Adicionar pergunta</button>`;
  } else if (epkSection === 'notice') {
    body = `
      <label class="chk"><input type="checkbox" ${ck.notice.on ? 'checked' : ''} onchange="epkState.notice.on=this.checked;epkPrev()"> Exibir faixa de aviso</label>
      <label style="margin-top:12px;display:block">Mensagem
        <textarea rows="3" maxlength="200" placeholder="Ex.: O acesso é liberado em até 5 minutos após o pagamento." oninput="epkState.notice.text=this.value;epkPrev()">${esc(ck.notice.text)}</textarea></label>
      <label class="chk" style="margin-top:14px"><input type="checkbox" ${ck.badges.on ? 'checked' : ''} onchange="epkState.badges.on=this.checked;epkPrev()"> Exibir selos de segurança no rodapé</label>`;
  } else if (epkSection === 'pagamento') {
    const cap = (state.epInfo && state.epInfo.card) || { ready: false, credit: false, boleto: false };
    const m = ck.methods;
    // linha de toggle: se o método não está liberado, trava e explica por quê
    const linha = (key, titulo, sub, liberado, motivo) => `
      <label class="chk epk-payrow${liberado ? '' : ' off'}">
        <input type="checkbox" ${m[key] && liberado ? 'checked' : ''} ${liberado ? '' : 'disabled'}
          onchange="epkState.methods.${key}=this.checked;epkPrev()">
        <span><b>${titulo}</b><em>${liberado ? sub : motivo}</em></span>
      </label>`;
    const setupLink = `<a href="#/elitepay" onclick="location.hash='#/elitepay';setTimeout(()=>epTab&&epTab('card'),120)">Configure a conta de cartão</a>`;
    body = `
      <p class="muted" style="font-size:13px;margin:0 0 14px">Escolha o que este checkout aceita. O cliente vê só os métodos ligados.</p>
      ${linha('pix', 'Pix', 'Aprovação na hora, menor taxa', true, '')}
      ${linha('credit', 'Cartão de crédito', 'Parcelável, aprovação imediata', cap.credit,
        cap.ready ? 'Crédito não liberado pela plataforma' : `Indisponível, ${setupLink}`)}
      ${linha('boleto', 'Boleto bancário', 'Compensa em até 2 dias úteis', cap.boleto,
        cap.ready ? 'Boleto não liberado pela plataforma' : `Indisponível, ${setupLink}`)}
      <p class="hint" style="margin-top:14px">${ico('shield', 12)} O dinheiro do cartão cai direto na <b>sua</b> conta do adquirente, o EliteChat só intermedeia.</p>`;
  } else if (epkSection === 'ordem') {
    body = `
      <p class="muted" style="font-size:13px;margin:0 0 12px">Arraste para reordenar os blocos da página. O bloco <b>Checkout</b> é fixo, mas pode mudar de posição.</p>
      <div class="ckb-order" id="epk-order">${epkOrderRows()}</div>
      <button class="btn small" style="margin-top:12px" onclick="epkResetOrder()">${ico('arrowleft', 12)} Restaurar ordem padrão</button>`;
  } else if (epkSection === 'produto') {
    body = `
      <label style="display:block">Nome do produto / título
        <input id="epk-title" maxlength="80" placeholder="Ex.: Mentoria Elite. Plano Mensal" value="${esc(ck.title)}" oninput="epkState.title=this.value;epkPrev()"></label>
      <label style="margin-top:12px;display:block">Descrição
        <textarea id="epk-desc" rows="5" maxlength="600" placeholder="O que o cliente está pagando? Benefícios, condições, o que acontece após o pagamento…" oninput="epkState.description=this.value;epkPrev()">${esc(ck.description)}</textarea></label>
      <p class="hint" style="margin-top:12px">Aparece no card de <b>Resumo do pedido</b>, ao lado da miniatura.</p>`;
  } else if (epkSection === 'cor') {
    body = `
      <span class="fb-sub">Cor de destaque</span>
      <p class="muted" style="font-size:13px;margin:0 0 10px">Usada no botão principal, no selo do Pix e nos destaques da página.</p>
      <div class="epk-colors" id="epk-colors">
        ${EPK_COLORS.map(c => `<button class="epk-swatch${c === ck.color ? ' on' : ''}" data-c="${c}" style="background:${c}" onclick="epkSetColor('${c}')"></button>`).join('')}
        <input type="color" id="epk-colorpick" value="${esc(ck.color)}" title="Cor personalizada" oninput="epkSetColor(this.value)">
      </div>
      <p class="hint" style="margin-top:14px">${ico('shield', 12)} O contraste do texto do botão é ajustado sozinho conforme a cor escolhida.</p>`;
  } else if (epkSection === 'mensagens') {
    body = `
      <label style="display:block">Mensagem após o pagamento <span class="muted">(opcional)</span>
        <input id="epk-success" maxlength="300" placeholder="Ex.: Pagamento confirmado! Seu acesso chega no WhatsApp em instantes 🎉" value="${esc(ck.successMsg)}" oninput="epkState.successMsg=this.value"></label>
      <label style="margin-top:12px;display:block">Suporte / rodapé <span class="muted">(opcional)</span>
        <input id="epk-support" maxlength="200" placeholder="Ex.: Dúvidas? Chame no WhatsApp (11) 99999-9999" value="${esc(ck.supportText)}" oninput="epkState.supportText=this.value;epkPrev()"></label>
      <p class="hint" style="margin-top:12px">A mensagem de sucesso aparece na tela de confirmação, veja em <b>Ver página real</b> com <code>?s=paid</code>.</p>`;
  } else {
    body = `
      <div class="epk-flowsteps">
        <div><i>1</i><span><b>Identificação</b>, o cliente preenche nome, CPF/CNPJ, e-mail e WhatsApp</span></div>
        <div><i>2</i><span><b>Automático</b>, vira <b>cliente na Woovi</b>, <b>contato</b> no EliteChat e entra no <b>funil</b></span></div>
        <div><i>3</i><span><b>Pagamento</b>. QR Code + copia e cola; ao pagar, o contato vai para <b>Ganho</b> com a tag <b>Cliente</b></span></div>
      </div>
      <p class="hint" style="margin-top:14px">${ico('shield', 12)} Tudo isso acontece sem você fazer nada, é só enviar o link da cobrança.</p>`;
  }

  box.innerHTML = `
    <button class="ckb-back" onclick="epkBack()">${ico('arrowleft', 13)} ${epkTab === 'comp' ? 'Componentes' : 'Configurações'}</button>
    <div class="ckb-sechead"><h2>${ico(sec.icon, 16)} ${sec.label}</h2><p>${sec.hint}</p></div>
    ${body}`;
}

function epkPrevTab(n) {
  epkPrevStep = n;
  $$('#epk-stepseg button').forEach(b => b.classList.toggle('on', b.dataset.pv == n));
  epkPrev();
}

function epkPaintThumbs() {
  const LBL = {
    banner: ['Banner enviado', 'Nenhum banner'], bannerMobile: ['Banner do celular enviado', 'Nenhum banner de celular'],
    logo: ['Logo enviada', 'Nenhuma logo'], logoMobile: ['Logo do celular enviada', 'Nenhuma logo de celular']
  };
  ['banner', 'bannerMobile', 'logo', 'logoMobile'].forEach(k => {
    const th = $('#epk-th-' + k), lbl = $('#epk-lbl-' + k), rm = $('#epk-rm-' + k);
    if (!th) return;
    if (epkState[k]) {
      th.style.backgroundImage = `url(${epkState[k]})`; th.classList.add('has');
      lbl.textContent = LBL[k][0]; rm.style.display = '';
    } else {
      th.style.backgroundImage = ''; th.classList.remove('has');
      th.innerHTML = ico('image', 20);
      lbl.textContent = LBL[k][1]; rm.style.display = 'none';
    }
  });
}

// ---- listas simples (vantagens) ----
function epkListRows(key) {
  return (epkState[key].items || []).map((v, i) => `
    <div class="epk-item">
      <input value="${esc(v)}" maxlength="120" placeholder="Ex.: Acesso vitalício ao conteúdo"
        oninput="epkState.${key}.items[${i}]=this.value;epkPrev()">
      <button class="btn small danger" onclick="epkDelItem('${key}',${i})">${ico('trash', 12)}</button>
    </div>`).join('') || '<p class="muted" style="font-size:12.5px">Nenhum item ainda.</p>';
}
function epkAddItem(key) { epkState[key].items.push(''); epkPaintForm(); epkPrev(); }
function epkDelItem(key, i) { epkState[key].items.splice(i, 1); epkPaintForm(); epkPrev(); }

// ---- FAQ (pergunta + resposta) ----
function epkFaqRows() {
  return (epkState.faq.items || []).map((it, i) => `
    <div class="epk-faqrow">
      <div class="row" style="align-items:center">
        <input style="flex:1" value="${esc(it.q)}" maxlength="140" placeholder="Pergunta" oninput="epkState.faq.items[${i}].q=this.value;epkPrev()">
        <button class="btn small danger no-grow" onclick="epkDelFaq(${i})">${ico('trash', 12)}</button>
      </div>
      <textarea rows="2" maxlength="500" placeholder="Resposta" oninput="epkState.faq.items[${i}].a=this.value;epkPrev()">${esc(it.a)}</textarea>
    </div>`).join('') || '<p class="muted" style="font-size:12.5px">Nenhuma pergunta ainda.</p>';
}
function epkAddFaq() { epkState.faq.items.push({ q: '', a: '' }); epkPaintForm(); epkPrev(); }
function epkDelFaq(i) { epkState.faq.items.splice(i, 1); epkPaintForm(); epkPrev(); }

// ---- ordem dos blocos: ARRASTAR E SOLTAR ----
function epkOrderRows() {
  return epkState.blocks.map((k, i) => {
    const m = EPK_BLOCK_META[k] || { icon: 'square', label: k, hint: '' };
    const ativo = k === 'product' || k === 'banner'
      ? (k === 'banner' ? !!(epkState.banner || epkState.bannerMobile) : true)
      : !!(epkState[k] && epkState[k].on);
    return `<div class="ckb-orow" draggable="true" data-k="${k}" data-i="${i}"
        ondragstart="epkDragStart(event)" ondragover="epkDragOver(event)" ondrop="epkDrop(event)" ondragend="epkDragEnd(event)">
      <span class="ckb-grip">${ico('menu', 14)}</span>
      <span class="ckb-oic">${ico(m.icon, 15)}</span>
      <span class="ckb-otxt"><b>${m.label}</b><small>${m.hint}</small></span>
      <span class="ckb-odot ${ativo ? 'on' : ''}" title="${ativo ? 'Visível na página' : 'Oculto, ative na aba do componente'}"></span>
    </div>`;
  }).join('');
}
// ===== ARRASTA-E-SOLTA NO CANVAS DO CHECKOUT =====
// Origem pode ser a PALETA (adiciona o widget) ou um bloco já na página (move).
let _epkCanvasDrag = null;

function epkPalDrag(e, key) {
  _epkCanvasDrag = key;
  e.dataTransfer.effectAllowed = 'copy';
  try { e.dataTransfer.setData('text/plain', key); } catch {}
  const c = $('#epk-canvas'); if (c) c.classList.add('dropping');
}
function epkCanvasDragStart(e) {
  _epkCanvasDrag = e.currentTarget.dataset.blk;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', _epkCanvasDrag); } catch {}
  e.stopPropagation();
  const c = $('#epk-canvas'); if (c) c.classList.add('dropping');
}
function epkCanvasOver(e) {
  if (!_epkCanvasDrag) return;
  e.preventDefault(); e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  const alvo = e.target.closest('.epk2-drop');
  $$('#epk-canvas .epk2-drop').forEach(d => d.classList.remove('over-before', 'over-after'));
  if (!alvo || alvo.dataset.blk === _epkCanvasDrag) return;
  const r = alvo.getBoundingClientRect();
  alvo.classList.add(e.clientY > r.top + r.height / 2 ? 'over-after' : 'over-before');
}
function epkCanvasDrop(e) {
  if (!_epkCanvasDrag) return;
  e.preventDefault(); e.stopPropagation();
  const key = _epkCanvasDrag;
  const alvo = e.target.closest('.epk2-drop');
  const arr = epkState.blocks.filter(x => x !== key);
  if (alvo && alvo.dataset.blk !== key) {
    const r = alvo.getBoundingClientRect();
    const at = arr.indexOf(alvo.dataset.blk) + (e.clientY > r.top + r.height / 2 ? 1 : 0);
    arr.splice(at, 0, key);
  } else {
    arr.push(key);                       // soltou no vazio → vai para o fim
  }
  epkState.blocks = arr;
  // arrastar da paleta LIGA o widget automaticamente
  if (epkState[key] && typeof epkState[key] === 'object' && 'on' in epkState[key] && !epkState[key].on) {
    epkState[key].on = true;
    toast(`"${(EPK_BLOCK_META[key] || {}).label || key}" adicionado, configure ao lado`);
  }
  epkCanvasEnd();
  epkPrev();
  if (epkSection === 'ordem') epkPaintForm();
}
function epkCanvasEnd() {
  _epkCanvasDrag = null;
  const c = $('#epk-canvas'); if (c) c.classList.remove('dropping');
  $$('#epk-canvas .epk2-drop').forEach(d => d.classList.remove('dragging', 'over-before', 'over-after'));
}
// clicar num bloco do canvas abre os campos dele no painel direito
function epkOpenBlock(k) {
  if (_epkCanvasDrag) return;
  const sec = EPK_SECTIONS.find(s => s.key === (k === 'banner' ? 'marca' : k === 'product' ? 'produto' : k));
  if (!sec) return;
  epkTab = sec.tab;
  $$('#epk-tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === epkTab));
  epkGo(sec.key);
}

let _epkDrag = null;
function epkDragStart(e) {
  _epkDrag = e.currentTarget.dataset.k;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', _epkDrag); } catch {}
}
function epkDragOver(e) {
  e.preventDefault();
  const row = e.currentTarget;
  if (!_epkDrag || row.dataset.k === _epkDrag) return;
  const r = row.getBoundingClientRect();
  row.classList.toggle('drop-after', e.clientY > r.top + r.height / 2);
  row.classList.toggle('drop-before', e.clientY <= r.top + r.height / 2);
}
function epkDrop(e) {
  e.preventDefault();
  const row = e.currentTarget, alvo = row.dataset.k;
  if (!_epkDrag || alvo === _epkDrag) return;
  const depois = row.classList.contains('drop-after');
  const arr = epkState.blocks.filter(x => x !== _epkDrag);
  const at = arr.indexOf(alvo) + (depois ? 1 : 0);
  arr.splice(at, 0, _epkDrag);
  epkState.blocks = arr;
  epkPaintForm(); epkPrev();
}
function epkDragEnd() {
  _epkDrag = null;
  $$('.ckb-orow').forEach(r => r.classList.remove('dragging', 'drop-before', 'drop-after'));
}
function epkResetOrder() { epkState.blocks = EPK_BLOCK_KEYS.slice(); epkPaintForm(); epkPrev(); }

function epkSetColor(c) {
  epkState.color = c;
  $$('#epk-colors .epk-swatch').forEach(b => b.classList.toggle('on', b.dataset.c === c));
  const p = $('#epk-colorpick'); if (p && p.value !== c) p.value = c;
  epkPrev();
}

// Upload → redimensiona no canvas (header 1200px / logo 512px) e comprime.
function epkPickImg(kind) {
  const inp = $('#epk-file'); if (!inp) return;
  inp.onchange = () => {
    const f = inp.files && inp.files[0]; inp.value = '';
    if (!f) return;
    // largura máxima por tipo de imagem (mesma recomendação mostrada ao usuário)
    const MAXW = { banner: 1200, bannerMobile: 800, logo: 512, logoMobile: 256 };
    const maxW = MAXW[kind] || 512;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      // logo mantém transparência (PNG); banner vira JPEG comprimido
      let out = (kind.startsWith('logo') && f.type === 'image/png') ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', .85);
      if (out.length > 800 * 1024) out = cv.toDataURL('image/jpeg', .6);
      if (out.length > 800 * 1024) return toast('Imagem muito grande mesmo comprimida, use uma menor', 'error');
      URL.revokeObjectURL(img.src);
      epkState[kind] = out;
      epkPaintThumbs(); epkPrev();
    };
    img.onerror = () => toast('Não foi possível ler a imagem', 'error');
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}
function epkRemoveImg(kind) { epkState[kind] = ''; epkPaintThumbs(); epkPrev(); }

// Prévia ao vivo — réplica fiel da página /pay/:id (modelo card em 2 colunas do Figma)
function epkPrev() {
  const el = $('#epk-page'); if (!el || !epkState) return;
  const s = epkState;
  const merchant = (state.epInfo && state.epInfo.subaccount && state.epInfo.subaccount.name) || '';
  const name = s.title || 'Pagamento Pix';
  const initial = (merchant || name).trim().charAt(0).toUpperCase();
  el.style.setProperty('--epkc', s.color);

  // imagens do dispositivo em pré-visualização (desktop/celular)
  const mob = epkDevice === 'mobile';
  const logoU = (mob && s.logoMobile) ? s.logoMobile : (s.logo || s.logoMobile || '');
  const bannerU = (mob && s.bannerMobile) ? s.bannerMobile : (s.banner || s.bannerMobile || '');
  const showBanner = bannerU && s.blocks.indexOf('banner') >= 0;

  const topbar = `
    <div class="epk2-topbar">
      <div class="epk2-brand">
        ${logoU ? `<img src="${esc(logoU)}">` : `<span class="ph">${esc(initial)}</span>`}
        <div><b>${esc(merchant || name)}</b><small>Pagamento via Pix</small></div>
      </div>
      <span class="epk2-secure">${ico('lock', 10)} Compra segura</span>
    </div>
    ${showBanner ? `<img class="epk2-headbanner" src="${esc(bannerU)}">` : ''}`;

  const steps = cur => `<div class="epk2-steps">
    <span class="epk2-stp ${cur > 1 ? 'done' : 'cur'}"><i>${cur > 1 ? '✓' : '1'}</i>Identificação</span>
    <span class="epk2-stpsep ${cur > 1 ? 'done' : ''}"></span>
    <span class="epk2-stp ${cur === 2 ? 'cur' : ''}"><i>2</i>Pagamento</span></div>`;

  const summary = cta => `
    <div class="epk2-summary">
      <div class="epk2-sumhead">Resumo do pedido</div>
      <div class="epk2-prod">
        ${logoU ? `<img class="epk2-thumb" src="${esc(logoU)}">` : `<div class="epk2-thumb ph">${esc(initial)}</div>`}
        <div class="epk2-pinfo"><b>${esc(name)}</b>${s.description ? `<span>${esc(s.description.length > 46 ? s.description.slice(0, 46) + '…' : s.description)}</span>` : ''}</div>
      </div>
      <div class="epk2-rows">
        <div class="epk2-row"><span>Subtotal</span><span>R$ 97,00</span></div>
        <div class="epk2-row"><span>Taxas</span><span>Grátis</span></div>
        <div class="epk2-row total"><span>Total</span><span>R$ 97,00</span></div>
      </div>
      ${cta}
    </div>`;

  const step1main = `
    <div class="epk2-main">${steps(1)}
      <div class="epk2-mtitle">Seus dados</div>
      <div class="epk2-msub">Preencha para gerar o seu Pix.</div>
      ${[['Nome completo', 'Maria Souza', 1], ['CPF ou CNPJ', '529.982.247-25', 1], ['E-mail', 'voce@email.com', 0], ['Celular / WhatsApp', '(11) 91234-5678', 0]]
        .map(([l, v, f]) => `<div class="epk2-fld"><small>${l}</small><span class="${f ? 'filled' : ''}">${v}</span></div>`).join('')}
    </div>`;

  const qr = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm4 4h2v2h-2v-2zm-4 0h2v2h-2v-2zm4-4h2v2h-2v-2z"/></svg>';
  const step2main = `
    <div class="epk2-main">${steps(2)}
      <div class="epk2-mtitle">Pague com Pix</div>
      <div class="epk2-msub">Aprovação na hora, confirma sozinho.</div>
      <div class="epk2-chip">Pagando como <b>&nbsp;Maria Souza</b></div>
      <div class="epk2-qrwrap"><div class="epk2-qrframe">${qr}</div>
        <div class="epk2-qrside"><b>Escaneie para pagar</b><span>1. Abra o Pix no seu banco</span><span>2. Aponte para o QR Code</span><span>3. Confirme na hora</span></div></div>
      <div class="epk2-orlbl">OU COPIA E COLA</div>
      <div class="epk2-copy">00020126580014BR.GOV.BCB.PIX0136…</div>
    </div>`;

  const step1cta = `<div class="epk2-btn">Continuar para o pagamento</div><div class="epk2-note">${ico('lock', 10)} Pagamento 100% seguro</div>`;
  const step2cta = `<div class="epk2-wait"><i></i> Aguardando pagamento</div>`;

  // ---- blocos opcionais na prévia (mesma ordem/regras da página real) ----
  const bTimer = () => s.timer.on ? `<div class="epk2-blk epk2-timer">${ico('clock', 11)} ${esc(s.timer.text || 'Oferta por tempo limitado!')}
      <span class="epk2-clock"><i>${String(s.timer.minutes || 15).padStart(2, '0')}</i><i>00</i></span></div>` : '';
  const bNotice = () => (s.notice.on && s.notice.text) ? `<div class="epk2-blk epk2-notice">${ico('help', 11)} ${esc(s.notice.text)}</div>` : '';
  const bBenef = () => (s.benefits.on && s.benefits.items.filter(Boolean).length)
    ? `<div class="epk2-blk"><b class="epk2-blkt">${esc(s.benefits.title || 'O que você recebe')}</b>
       ${s.benefits.items.filter(Boolean).map(i => `<div class="epk2-bitem">${ico('check', 11)} ${esc(i)}</div>`).join('')}</div>` : '';
  const bTesti = () => (s.testimonial.on && s.testimonial.text)
    ? `<div class="epk2-blk epk2-testi"><span class="av">${esc((s.testimonial.name || 'C').charAt(0).toUpperCase())}</span>
       <div><div class="st">★★★★★</div><p>“${esc(s.testimonial.text)}”</p>${s.testimonial.name ? `<b>${esc(s.testimonial.name)}</b>` : ''}</div></div>` : '';
  const bGuar = () => s.guarantee.on
    ? `<div class="epk2-blk epk2-guar">${ico('shield', 18)}<div><b>Garantia de ${s.guarantee.days || 7} dias</b>
       <span>${esc((s.guarantee.text || '').replace('{dias}', s.guarantee.days || 7))}</span></div></div>` : '';
  const bFaq = () => (s.faq.on && s.faq.items.filter(i => i.q).length)
    ? `<div class="epk2-blk"><b class="epk2-blkt">Perguntas frequentes</b>
       ${s.faq.items.filter(i => i.q).map(i => `<div class="epk2-faq">${esc(i.q)} <em>+</em></div>`).join('')}</div>` : '';
  const BLK = { timer: bTimer, notice: bNotice, benefits: bBenef, testimonial: bTesti, guarantee: bGuar, faq: bFaq };

  const mainCard = epkPrevStep === 2 ? step2main : step1main;

  // ---- CANVAS ARRASTA-E-SOLTA: cada bloco vira alvo posicionável ----
  // Widgets desligados aparecem como "fantasma" para o usuário ver onde ficam
  // e poder arrastá-los; arrastar da paleta para cá insere na posição do mouse.
  const vazio = (k) => {
    const m = EPK_BLOCK_META[k] || {};
    return `<div class="epk2-ghost">${ico(m.icon || 'square', 12)} ${m.label || k}
      <em>arraste para posicionar · clique para configurar</em></div>`;
  };
  const wrap = (k, html, fixo) => `<div class="epk2-drop${fixo ? ' fixed' : ''}${html ? '' : ' off'}" data-blk="${k}"
      draggable="true" ondragstart="epkCanvasDragStart(event)" ondragover="epkCanvasOver(event)"
      ondrop="epkCanvasDrop(event)" ondragend="epkCanvasEnd(event)"
      onclick="epkOpenBlock('${k}')" title="${fixo ? 'Checkout (fixo, mas pode mudar de posição)' : 'Arraste para reposicionar'}">
      <span class="epk2-handle">${ico('menu', 11)}</span>
      ${html || vazio(k)}
    </div>`;

  let coluna = '';
  for (const k of s.blocks) {
    if (k === 'banner') continue;                  // banner vive no header do site
    if (k === 'product') coluna += wrap(k, mainCard, true);
    else coluna += wrap(k, BLK[k] ? BLK[k]() : '');
  }
  if (s.blocks.indexOf('product') < 0) coluna += wrap('product', mainCard, true);

  const selos = s.badges.on ? `<div class="epk2-badges">
      <span>${ico('lock', 9)} Ambiente seguro</span><span>${ico('shield', 9)} Dados protegidos</span></div>` : '';

  el.innerHTML = topbar + `<div class="epk2-grid">` +
    `<div class="epk2-col" id="epk-canvas" ondragover="epkCanvasOver(event)" ondrop="epkCanvasDrop(event)">${coluna}</div>` +
    summary(epkPrevStep === 2 ? step2cta : step1cta) +
    `</div>` + selos + (s.supportText ? `<div class="epk2-support">${esc(s.supportText)}</div>` : '');
}

async function epkSave() {
  const btn = $('#epk-save'); if (btn) btn.disabled = true;
  try {
    const r = await api('/elitepay/checkout', { method: 'PUT', body: { ...epkState, id: epkCheckoutId, name: epkCheckoutName } });
    state.epInfo.checkout = r.checkout;
    const s = $('#epk-saved');
    if (s) { s.innerHTML = '<i></i> ✓ Salvo agora'; setTimeout(() => { if ($('#epk-saved')) $('#epk-saved').innerHTML = '<i></i> Tudo certo!'; }, 2600); }
    toast('Checkout salvo! Seus links de cobrança já usam o novo visual 🎨');
  } catch (e) { toast(e.message, 'error'); }
  finally { if ($('#epk-save')) $('#epk-save').disabled = false; }
}

// ---- PRODUTOS (Elite Pay → Produtos): preenchem as variáveis do checkout ----
async function epPaintProducts(box) {
  box.innerHTML = skel(4);
  let d;
  try { d = await api('/elitepay/products'); } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  state.epProducts = d.products; state.epCheckouts = d.checkouts;
  box.innerHTML = `
    <div class="card">
      <div class="row" style="align-items:center;margin-bottom:4px">
        <h2 style="flex:1;margin:0">${ico('sparkles')} Produtos</h2>
        <button class="btn primary no-grow" onclick="epProdForm(null)">${ico('plus', 14)} Novo produto</button>
      </div>
      <p class="muted" style="margin:0 0 14px;font-size:13px">O produto preenche as <b>variáveis</b> do checkout: nome, descrição e imagens. Na cobrança você escolhe o produto e o layout.</p>
      <div id="ep-prod-form"></div>
      ${d.products.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Produto</th><th>Preço</th><th>Checkout</th><th></th></tr></thead><tbody>
        ${d.products.map(p => `<tr>
          <td><div class="cell-user">${p.logo ? `<img class="avatar sm" src="${esc(p.logo)}" style="object-fit:cover">` : `<div class="avatar sm">${esc((p.name || '?').charAt(0).toUpperCase())}</div>`}
            <div><b>${esc(p.name)}</b>${p.description ? `<div class="muted" style="font-size:11.5px">${esc(p.description.slice(0, 46))}</div>` : ''}</div></div></td>
          <td><b>${p.price ? fmtBRL(p.price) : '<span class="muted">livre</span>'}</b></td>
          <td class="muted">${esc((d.checkouts.find(c => c.id === p.checkoutId) || {}).name || 'padrão')}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn small" onclick="epProdForm('${p.id}')">${ico('edit', 13)}</button>
            <button class="btn small danger" onclick="epProdDel('${p.id}')">${ico('trash', 13)}</button>
          </td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Nenhum produto ainda, crie o primeiro para agilizar suas cobranças.</p>'}
    </div>`;
}
function epProdForm(id) {
  const p = (state.epProducts || []).find(x => x.id === id) || { name: '', description: '', price: 0, checkoutId: '', logo: '', banner: '' };
  window._epProd = id || null;
  window._epProdImgs = { logo: p.logo || '', logoMobile: p.logoMobile || '', banner: p.banner || '', bannerMobile: p.bannerMobile || '' };
  const cks = state.epCheckouts || [];
  $('#ep-prod-form').innerHTML = `<div class="card px-editor" style="margin-bottom:14px">
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="flex:1;margin:0;font-size:15px">${ico(id ? 'edit' : 'plus')} ${id ? 'Editar' : 'Novo'} produto</h2>
      <button class="icon-btn" title="Fechar" onclick="$('#ep-prod-form').innerHTML=''">${ico('x', 16)}</button>
    </div>
    <div class="row">
      <label style="flex:2">Nome<input id="epp-name" maxlength="80" value="${esc(p.name)}" placeholder="Ex.: Mentoria Elite. Plano Mensal"></label>
      <label style="flex:1">Preço (R$)<input id="epp-price" inputmode="decimal" value="${p.price ? (p.price / 100).toFixed(2).replace('.', ',') : ''}" placeholder="97,00"></label>
    </div>
    <label style="margin-top:9px;display:block">Descrição<textarea id="epp-desc" rows="2" maxlength="600" placeholder="O que o cliente recebe">${esc(p.description || '')}</textarea></label>
    ${cks.length ? `<label style="margin-top:9px;display:block">Checkout deste produto
      ${ecSelect('epp-ckt', cks.map(c => ({ value: c.id, label: c.name + (c.isDefault ? ' (padrão)' : '') })), p.checkoutId || (cks.find(c => c.isDefault) || cks[0]).id)}</label>` : ''}
    <span class="fb-sub" style="margin-top:12px">Imagens do produto <span class="muted">(substituem as variáveis do checkout)</span></span>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${['logo', 'logoMobile', 'banner', 'bannerMobile'].map(k => `
        <button class="btn small" onclick="epProdImg('${k}')" id="epp-b-${k}">${ico('image', 12)} ${{ logo: 'Logo', logoMobile: 'Logo celular', banner: 'Banner', bannerMobile: 'Banner celular' }[k]}${window._epProdImgs[k] ? ' ✓' : ''}</button>`).join('')}
    </div>
    <p class="hint" style="margin-top:8px">Logo 512×512 · Logo celular 256×256 · Banner 1200×360 · Banner celular 800×500. Sem imagem aqui, o checkout usa a dele.</p>
    <div class="row" style="margin-top:10px;justify-content:flex-end">
      <button class="btn primary no-grow" onclick="epProdSave()">${ico('save', 14)} Salvar produto</button>
    </div>
    <input type="file" id="epp-file" accept="image/png,image/jpeg,image/webp" style="display:none">
  </div>`;
}
function epProdImg(kind) {
  const inp = $('#epp-file'); if (!inp) return;
  const MAXW = { banner: 1200, bannerMobile: 800, logo: 512, logoMobile: 256 };
  inp.onchange = () => {
    const f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, (MAXW[kind] || 512) / img.width);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      let out = (kind.startsWith('logo') && f.type === 'image/png') ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', .85);
      if (out.length > 800 * 1024) out = cv.toDataURL('image/jpeg', .6);
      if (out.length > 800 * 1024) return toast('Imagem muito grande, use uma menor', 'error');
      URL.revokeObjectURL(img.src);
      window._epProdImgs[kind] = out;
      const b = $('#epp-b-' + kind); if (b && !/✓/.test(b.textContent)) b.textContent += ' ✓';
      toast('Imagem carregada, salve o produto para aplicar');
    };
    img.onerror = () => toast('Não foi possível ler a imagem', 'error');
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}
async function epProdSave() {
  const body = {
    name: $('#epp-name').value.trim(),
    description: $('#epp-desc').value,
    price: epParseReais($('#epp-price').value || '0'),
    checkoutId: ecVal('epp-ckt') || '',
    ...window._epProdImgs
  };
  if (!body.name) return toast('Informe o nome do produto', 'error');
  try {
    const id = window._epProd;
    await api('/elitepay/products' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Produto atualizado!' : 'Produto criado!');
    epPaintProducts($('#ep-box'));
  } catch (e) { toast(e.message, 'error'); }
}
async function epProdDel(id) {
  if (!await confirmModal('Excluir este produto?', 'As cobranças já criadas continuam válidas.')) return;
  try { await api('/elitepay/products/' + id, { method: 'DELETE' }); toast('Produto excluído'); epPaintProducts($('#ep-box')); }
  catch (e) { toast(e.message, 'error'); }
}

// ---- Checkout Builder: lista de templates (Vendas → Checkout Builder) ----
async function renderCheckoutList() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(4)}</div></div>`;
  let d;
  try { d = await api('/elitepay'); } catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; return; }
  state.epInfo = d;
  if (!d.subaccount || d.subaccount.status !== 'active') { location.hash = '#/elitepay'; return; }
  const cks = d.checkouts || [];
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Checkout Builder</h1><p>Modelos de página de pagamento, o produto entra como <b>variável</b>, então o mesmo layout serve para vários produtos</p></div>
      <button class="btn primary no-grow" onclick="ckNew()">${ico('plus', 14)} Novo checkout</button>
    </div>
    <div class="card">
      <h2>${ico('card')} Seus checkouts</h2>
      <div style="overflow-x:auto"><table><thead><tr><th>Nome</th><th>Blocos ativos</th><th>Cor</th><th></th></tr></thead><tbody>
        ${cks.map(c => `<tr>
          <td><b>${esc(c.name)}</b> ${c.isDefault ? '<span class="pill on">Padrão</span>' : ''}</td>
          <td class="muted">—</td>
          <td><span style="display:inline-block;width:16px;height:16px;border-radius:5px;background:${esc(c.color || '#10b981')};vertical-align:middle"></span></td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn small" onclick="ckEdit('${c.id}')">${ico('edit', 13)} Editar</button>
            ${cks.length > 1 ? `<button class="btn small danger" onclick="ckDel('${c.id}')">${ico('trash', 13)}</button>` : ''}
          </td></tr>`).join('')}
      </tbody></table></div>
      <p class="hint" style="margin-top:12px">${ico('shield', 12)} Na hora de gerar a cobrança no Elite Pay você escolhe o <b>produto</b> e qual destes <b>checkouts</b> usar.</p>
    </div>
    <a class="card link-card" href="#/elitepay">
      <span class="lc-ic">${ico('sparkles', 20)}</span>
      <div style="flex:1"><h2 style="margin:0 0 3px">Produtos</h2>
        <p class="muted" style="margin:0;font-size:13px">Cadastre nome, preço e imagens em <b>Elite Pay → Produtos</b>, eles preenchem as variáveis do checkout.</p></div>
      <span class="lc-arrow">${ico('arrowright', 18)}</span></a>
  </div>`;
}
function ckEdit(id) { window.open('/app/#/elitepay/checkout?c=' + encodeURIComponent(id), '_blank', 'noopener'); }
async function ckNew() {
  const name = prompt('Nome do novo checkout:', 'Checkout promocional');
  if (!name) return;
  try { const r = await api('/elitepay/checkouts', { body: { name } }); toast('Checkout criado!'); ckEdit(r.checkout.id); renderCheckoutList(); }
  catch (e) { toast(e.message, 'error'); }
}
async function ckDel(id) {
  if (!await confirmModal('Excluir este checkout?', 'As cobranças que já usam ele passam a exibir o checkout padrão.')) return;
  try { await api('/elitepay/checkouts/' + id, { method: 'DELETE' }); toast('Checkout excluído'); renderCheckoutList(); }
  catch (e) { toast(e.message, 'error'); }
}

// ---- Nova cobrança (também usada pelo botão do chat) ----
function epNewChargeModal(waId, contactName) {
  const prods = (state.epInfo && state.epInfo.products) || [];
  const cks = (state.epInfo && state.epInfo.checkouts) || [];
  openModal(`<h2>${ico('plus')} Gerar cobrança Pix</h2>
    ${prods.length ? `<label style="display:block;margin-bottom:10px">Produto
      ${ecSelect('ep-nc-prod', [{ value: '', label: 'Cobrança avulsa (sem produto)' }].concat(prods.map(p => ({ value: p.id, label: p.name + (p.price ? ', ' + fmtBRL(p.price) : '') }))), '', 'epPickProduct(val)')}</label>`
      : `<p class="hint" style="margin-bottom:10px">${ico('help', 12)} Cadastre produtos em <b>Elite Pay → Produtos</b> para preencher valor, descrição e imagens automaticamente.</p>`}
    ${cks.length ? `<label style="display:block;margin-bottom:10px">Checkout
      ${ecSelect('ep-nc-ckt', cks.map(c => ({ value: c.id, label: c.name + (c.isDefault ? ' (padrão)' : '') })), (cks.find(c => c.isDefault) || cks[0]).id)}</label>` : ''}
    <div class="row">
      <label style="flex:1">Valor (R$)<input id="ep-nc-val" placeholder="97,00" inputmode="decimal" autofocus></label>
      <label style="flex:2">Descrição (opcional)<input id="ep-nc-desc" maxlength="140" placeholder="Ex.: Consultoria, plano mensal"></label>
    </div>
    ${waId
      ? `<p class="muted" style="font-size:13px;margin:12px 0 0">Para: <b>${esc(contactName || '+' + waId)}</b></p>
         <label class="chk" style="margin-top:8px"><input type="checkbox" id="ep-nc-send" checked> Enviar a cobrança na conversa agora</label>
         <input type="hidden" id="ep-nc-waid" value="${esc(waId)}">`
      : `<label style="margin-top:12px">Vincular a um contato (opcional)<input id="ep-nc-phone" placeholder="5511999999999, deixa em branco p/ cobrança avulsa" inputmode="tel"></label>
         <label class="chk" style="margin-top:8px"><input type="checkbox" id="ep-nc-send"> Enviar no WhatsApp do contato</label>`}
    <div class="row" style="margin-top:16px;justify-content:flex-end">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary no-grow" id="ep-nc-btn" onclick="epCreateCharge()">${ico('zap', 14)} Gerar cobrança</button>
    </div>`);
}
// ao escolher o produto, preenche valor/descrição e já aponta o checkout dele
function epPickProduct(id) {
  const p = ((state.epInfo && state.epInfo.products) || []).find(x => x.id === id);
  if (!p) return;
  if (p.price && $('#ep-nc-val')) $('#ep-nc-val').value = (p.price / 100).toFixed(2).replace('.', ',');
  if ($('#ep-nc-desc')) $('#ep-nc-desc').value = p.name || '';
  if (p.checkoutId && $('#ep-nc-ckt')) ecSelPick('ep-nc-ckt', p.checkoutId);
}

async function epCreateCharge() {
  const btn = $('#ep-nc-btn'); btn.disabled = true;
  try {
    const waId = ($('#ep-nc-waid') && $('#ep-nc-waid').value) || ($('#ep-nc-phone') && $('#ep-nc-phone').value.replace(/\D/g, '')) || null;
    const r = await api('/elitepay/charges', { body: {
      valueCents: epParseReais($('#ep-nc-val').value),
      comment: $('#ep-nc-desc').value,
      productId: ecVal('ep-nc-prod') || '', checkoutId: ecVal('ep-nc-ckt') || '',
      waId, send: !!($('#ep-nc-send') && $('#ep-nc-send').checked),
      origin: state.view === 'inbox' ? 'chat' : 'manual'
    } });
    closeModal();
    if (r.sent) toast('Cobrança gerada e enviada na conversa! 💸');
    else if (r.sendError) toast('Cobrança gerada, mas NÃO enviada: ' + r.sendError, 'error');
    else toast('Cobrança gerada!');
    epShowCharge(r.charge, r.sendError);
    if (state.view === 'elitepay') epPaintTab();
  } catch (e) { toast(e.message, 'error'); }
  finally { if ($('#ep-nc-btn')) $('#ep-nc-btn').disabled = false; }
}

// ---- Detalhe da cobrança: QR Code, copia e cola, link e ações ----
async function epChargeDetail(id) {
  try {
    const { charges } = await api('/elitepay/charges?q=' + encodeURIComponent(id));
    const ch = charges.find(c => c.id === id);
    if (!ch) return toast('Cobrança não encontrada', 'error');
    epShowCharge(ch);
  } catch (e) { toast(e.message, 'error'); }
}
function epShowCharge(ch, warn) {
  const payLink = ch.payUrl || ch.paymentLinkUrl;   // checkout hospedado (fallback: link do gateway)
  openModal(`<h2>${ico('activity')} Cobrança ${fmtBRL(ch.value)} ${epPill(ch.status)}</h2>
    ${ch.comment ? `<p class="muted" style="margin:2px 0 0;font-size:13px">${esc(ch.comment)}</p>` : ''}
    ${warn ? `<div class="card" style="margin:12px 0 0;border-color:var(--amber-border);background:var(--amber-bg);padding:12px 14px"><b>${ico('clock', 13)} Não enviada no WhatsApp.</b><p class="muted" style="margin:4px 0 0;font-size:12.5px">${esc(warn)} Copie o link/Pix abaixo e envie por outro canal, ou reabra a conversa com um Template aprovado.</p></div>` : ''}
    <div class="ep-detail">
      ${ch.qrCodeImage ? `<img class="ep-qr" src="${esc(ch.qrCodeImage)}" alt="QR Code Pix">` : ''}
      <div class="ep-detail-info">
        ${payLink ? `
          <span class="fb-sub">Link de pagamento (checkout)</span>
          <div class="ep-copy"><input readonly value="${esc(payLink)}" onclick="this.select()">
            <button class="btn small" title="Copiar link" onclick="epCopy('${esc(payLink)}')">${ico('copy', 13)}</button>
            <a class="btn small" title="Abrir checkout" href="${esc(payLink)}" target="_blank" rel="noopener">${ico('globe', 13)}</a></div>` : ''}
        ${ch.brCode ? `
          <span class="fb-sub" style="margin-top:10px">Pix copia e cola</span>
          <div class="ep-copy"><input readonly value="${esc(ch.brCode)}" onclick="this.select()">
            <button class="btn small" onclick="epCopy(this.previousElementSibling.value)">${ico('copy', 13)}</button></div>` : ''}
        ${ch.payer ? `
          <span class="fb-sub" style="margin-top:10px">Dados do pagador (checkout)</span>
          <div class="wa-status" style="margin-top:4px">
            <div class="wa-row"><span>Nome</span><b>${esc(ch.payer.name)}</b></div>
            <div class="wa-row"><span>CPF/CNPJ</span><b>${esc(epFmtDoc(ch.payer.taxID))}</b></div>
            <div class="wa-row"><span>E-mail</span><b>${esc(ch.payer.email)}</b></div>
            <div class="wa-row"><span>WhatsApp</span><b>+${esc(ch.payer.phone)}</b></div>
            ${ch.payerSynced ? '<div class="wa-row"><span>Woovi</span><b>Cliente sincronizado ✅</b></div>' : ''}
          </div>` : ''}
        <p class="muted" style="font-size:12px;margin:12px 0 0">
          Criada ${timeAgo(ch.createdAt)}${ch.byName ? ' por ' + esc(ch.byName) : ''} · origem: ${esc(ch.origin)}<br>
          ${ch.paidAt ? 'Paga em ' + new Date(ch.paidAt).toLocaleString('pt-BR') : ch.expiresAt ? 'Expira em ' + new Date(ch.expiresAt).toLocaleString('pt-BR') : ''}</p>
      </div>
    </div>
    <div class="row" style="margin-top:16px;justify-content:flex-end;flex-wrap:wrap">
      ${ch.status === 'active' && ch.waId ? `<button class="btn no-grow" onclick="epResend('${ch.id}');closeModal()">${ico('send', 14)} Reenviar no WhatsApp</button>` : ''}
      <button class="btn no-grow" onclick="epDuplicate('${ch.id}');closeModal()">${ico('copy', 14)} Duplicar</button>
      ${ch.status === 'active' ? `<button class="btn danger no-grow" onclick="epCancel('${ch.id}');closeModal()">${ico('slash', 14)} Cancelar cobrança</button>` : ''}
      <button class="btn primary no-grow" onclick="closeModal()">Fechar</button>
    </div>`);
}
function epCopy(v) { navigator.clipboard.writeText(v).then(() => toast('Copiado!')).catch(() => toast('Não foi possível copiar', 'error')); }
function epFmtDoc(d) {
  d = String(d || '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}
async function epCancel(id) {
  if (!confirm('Cancelar esta cobrança? O cliente não conseguirá mais pagar por ela.')) return;
  try { await api(`/elitepay/charges/${id}/cancel`, { method: 'POST', body: {} }); toast('Cobrança cancelada'); if (state.view === 'elitepay') epPaintTab(); } catch (e) { toast(e.message, 'error'); }
}
async function epResend(id) {
  try { await api(`/elitepay/charges/${id}/resend`, { method: 'POST', body: {} }); toast('Cobrança reenviada na conversa 📨'); } catch (e) { toast(e.message, 'error'); }
}
async function epDuplicate(id) {
  try { const r = await api(`/elitepay/charges/${id}/duplicate`, { method: 'POST', body: {} }); toast('Cobrança duplicada'); epShowCharge(r.charge); if (state.view === 'elitepay') epPaintTab(); } catch (e) { toast(e.message, 'error'); }
}

// Botão "Cobrança" dentro da conversa (composer do inbox)
function chatChargeModal(waId) {
  const c = state.conversations.find(x => x.waId === waId);
  epNewChargeModal(waId, c ? c.name : null);
}

// ==================== TRACKING — atribuição + ROAS (estilo UTMify) ====================
let trkState = { tab: 'overview', data: null };
const trkBRL = v => fmtBRL(v || 0);
const trkPct = v => v === null || v === undefined ? '—' : v + '%';
const trkX = v => v === null || v === undefined ? '—' : v + 'x';

async function renderTracking() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Tracking</h1><p>Atribuição de vendas, ROAS e métricas de marketing, cada workspace com seus próprios dados</p></div>
      <button class="btn no-grow" onclick="trkSnippetModal()">${ico('code', 14)} Instalar no site</button>
    </div>
    <div class="tabs">
      <button class="${trkState.tab === 'overview' ? 'active' : ''}" data-tab="trk-overview" onclick="trkTab('overview')">Visão geral</button>
      <button class="${trkState.tab === 'conn' ? 'active' : ''}" data-tab="trk-conn" onclick="trkTab('conn')">Conexões</button>
      <button class="${trkState.tab === 'camp' ? 'active' : ''}" data-tab="trk-camp" onclick="trkTab('camp')">Campanhas</button>
      <button class="${trkState.tab === 'funnel' ? 'active' : ''}" data-tab="trk-funnel" onclick="trkTab('funnel')">Funil</button>
      <button class="${trkState.tab === 'events' ? 'active' : ''}" data-tab="trk-events" onclick="trkTab('events')">Eventos</button>
      <button class="${trkState.tab === 'alerts' ? 'active' : ''}" data-tab="trk-alerts" onclick="trkTab('alerts')">Alertas</button>
    </div>
    <div id="trk-box">${skel(5)}</div>
  </div>`;
  trkPaintTab();
}
function trkTab(t) { trkState.tab = t; $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'trk-' + t)); trkPaintTab(); }

async function trkPaintTab() {
  const box = $('#trk-box'); if (!box) return;
  try {
    if (trkState.tab === 'overview') return trkPaintOverview(box);
    if (trkState.tab === 'conn') return trkPaintConn(box);
    if (trkState.tab === 'camp') return trkPaintCamp(box);
    if (trkState.tab === 'funnel') return trkPaintFunnel(box);
    if (trkState.tab === 'events') return trkPaintEvents(box);
    return trkPaintAlerts(box);
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// ---- Visão geral: todos os cards financeiros + comparativo ----
async function trkPaintOverview(box) {
  const [ov, cmp] = await Promise.all([api('/tracking'), api('/tracking/compare')]);
  trkState.data = ov;
  const d = ov.dashboard, c = cmp.compare;
  const spendOk = ov.meta.campaigns > 0;
  const card = (lbl, val, sub) => `<div class="trk-card"><span>${lbl}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const periods = [['Hoje', c.hoje], ['Ontem', c.ontem], ['7 dias', c.d7], ['30 dias', c.d30], ['90 dias', c.d90], ['Ano', c.ano]];
  const maxRev = Math.max(1, ...periods.map(([, p]) => p.receita));
  box.innerHTML = `
    ${!spendOk ? `<div class="card" style="border-color:var(--amber-border);background:var(--amber-bg)"><b>💡 Conecte o Meta Ads</b><p class="muted" style="margin:4px 0 0;font-size:13px">ROAS, ROI, CPA e CAC dependem do gasto das campanhas. Vá em <b>Conexões → Meta Ads</b> e sincronize, o resto é automático.</p></div>` : ''}
    <div class="metric-hero">
      <div class="mh-card hi"><span class="mh-ic">${ico('zap', 20)}</span><div class="mh-val">${trkBRL(d.receita.d30)}</div><div class="mh-lbl">Receita. 30 dias</div></div>
      <div class="mh-card"><span class="mh-ic">${ico('activity', 20)}</span><div class="mh-val">${d.roas === null ? '—' : d.roas + 'x'}</div><div class="mh-lbl">ROAS</div></div>
      <div class="mh-card"><span class="mh-ic">${ico('trend', 20) || ico('activity', 20)}</span><div class="mh-val">${trkBRL(d.lucro)}</div><div class="mh-lbl">Lucro (receita − anúncios)</div></div>
      <div class="mh-card"><span class="mh-ic">${ico('check', 20)}</span><div class="mh-val">${fmtN(d.pedidos.aprovados)}</div><div class="mh-lbl">Pedidos aprovados</div></div>
    </div>
    <div class="card"><h2>${ico('activity')} Receita</h2>
      <div class="trk-cards">
        ${card('Hoje', trkBRL(d.receita.hoje))}${card('Ontem', trkBRL(d.receita.ontem))}
        ${card('7 dias', trkBRL(d.receita.d7))}${card('30 dias', trkBRL(d.receita.d30))}
        ${card('Ticket médio', trkBRL(d.ticketMedio))}${card('AOV', trkBRL(d.aov))}
      </div></div>
    <div class="card"><h2>${ico('gear')} Marketing & performance</h2>
      <div class="trk-cards">
        ${card('Gasto em anúncios', trkBRL(d.gastoAnuncios), '30d · Meta Ads')}
        ${card('ROI', trkPct(d.roi))}${card('ROAS', trkX(d.roas))}
        ${card('CPA', d.cpa === null ? '—' : trkBRL(d.cpa))}${card('CAC', d.cac === null ? '—' : trkBRL(d.cac))}
        ${card('LTV', trkBRL(d.ltv))}${card('Margem', trkPct(d.margem))}${card('Conversão', trkPct(d.conversao))}
        ${card('EPC', d.epc === null ? '—' : trkBRL(d.epc))}${card('RPC', d.rpc === null ? '—' : trkBRL(d.rpc))}
        ${card('ROI líquido', trkPct(d.roiLiquido), 'desconta taxas/reembolsos')}
        ${card('ROAS líquido', trkX(d.roasLiquido))}
      </div></div>
    <div class="card"><h2>${ico('file')} Pedidos & saúde</h2>
      <div class="trk-cards">
        ${card('Aprovados', fmtN(d.pedidos.aprovados))}${card('Pendentes', fmtN(d.pedidos.pendentes))}
        ${card('Recusados/expirados', fmtN(d.pedidos.recusados))}
        ${card('Reembolsos', `${d.refund.qtd} · ${trkBRL(d.refund.valor)}`)}
        ${card('Chargebacks', `${d.chargeback.qtd} · ${trkBRL(d.chargeback.valor)}`)}
        ${card('Taxas da plataforma', trkBRL(d.taxas))}
      </div></div>
    <div class="card"><h2>${ico('activity')} Comparativo de receita</h2>
      <div class="ep-chart" style="height:130px">${periods.map(([lbl, p]) => `
        <div class="ep-bar-w" title="${lbl} · ${trkBRL(p.receita)} · ROAS ${p.roas ?? '—'}">
          <div class="ep-bar" style="height:${Math.max(3, Math.round(p.receita / maxRev * 100))}%"></div><span>${lbl}</span>
        </div>`).join('')}</div>
      <div style="overflow-x:auto;margin-top:10px"><table><thead><tr><th>Período</th><th>Receita</th><th>Pedidos</th><th>Lucro</th><th>ROAS</th><th>ROI</th><th>Conversão</th></tr></thead><tbody>
        ${periods.map(([lbl, p]) => `<tr><td><b>${lbl}</b></td><td>${trkBRL(p.receita)}</td><td>${p.pedidos}</td><td>${trkBRL(p.lucro)}</td><td>${trkX(p.roas)}</td><td>${trkPct(p.roi)}</td><td>${trkPct(p.conversao)}</td></tr>`).join('')}
      </tbody></table></div></div>`;
}

// ---- Conexões ----
async function trkPaintConn(box) {
  const ov = trkState.data || await api('/tracking');
  trkState.data = ov;
  box.innerHTML = `
    <div class="card">
      ${trkMetaCard(ov)}
      <p class="muted" style="font-size:12px;margin:10px 0 0">
        ${ov.meta.lastSync ? `Última sincronização: ${new Date(ov.meta.lastSync).toLocaleString('pt-BR')} · ${ov.meta.campaigns} campanha(s)` : 'Nunca sincronizado'}
        ${ov.meta.error ? ` · <span style="color:#f87171">${esc(ov.meta.error)}</span>` : ''}</p>
    </div>
    <div class="trk-conns">${ov.connections.map(c => `
      <div class="card trk-conn">
        <div class="row" style="align-items:center">
          <b style="flex:1">${esc(c.label)}
            <span class="trk-mode ${c.mode === 'server' ? 'srv' : ''}" title="${c.mode === 'server'
              ? 'O EliteChat envia pelo servidor. Não morre em bloqueador de anúncio.'
              : 'Tag de navegador, injetada no link rastreável e no checkout.'}">${c.mode === 'server' ? 'servidor' : 'navegador'}</span></b>
          <label class="chk" style="margin:0"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="trkConnSave('${c.key}', this.checked)"> ativa</label>
        </div>
        <div class="row" style="margin-top:8px">
          <label style="flex:1">${esc(c.idLabel)}<input id="trk-id-${c.key}" value="${esc(c.id || '')}" onblur="trkConnSave('${c.key}')"></label>
          ${c.tokenLabel ? `<label style="flex:1">${esc(c.tokenLabel)}<input id="trk-tk-${c.key}" type="password" placeholder="${c.token ? '•••• salvo' : ''}" onblur="trkConnSave('${c.key}')"></label>` : ''}
        </div>
        <div class="trk-connstats">
          <span class="${c.enabled && c.id ? 'ok' : ''}">${c.enabled && c.id ? '● Conectada' : '○ Inativa'}</span>
          ${c.mode === 'server' ? `
            <span>Sync: ${c.lastSync ? timeAgo(c.lastSync) : '—'}</span>
            <span>↑ ${fmtN(c.sent || 0)} enviados</span>
            <span class="${c.errors ? 'err2' : ''}">${c.errors || 0} erro(s)</span>`
          : '<span>Dispara no link rastreável e no checkout</span>'}
        </div>
        ${c.key === 'ga4' && c.sent ? '<p class="muted" style="font-size:11.5px;margin:6px 0 0">O Google não devolve confirmação de recebimento. Confira em GA4, Tempo real.</p>' : ''}
        ${c.lastError ? `<p class="muted" style="font-size:11.5px;margin:6px 0 0;color:#f87171">${esc(c.lastError)}</p>` : ''}
      </div>`).join('')}</div>
    <div class="card"><h2>${ico('shield')} Envio automático de conversões</h2>
      <p class="muted" style="font-size:13px;margin:0">Toda venda confirmada no Elite Pay é enviada sozinha para <b>Meta Conversions API</b>, <b>GA4 / Google Ads</b> e <b>TikTok Events API</b> (as que estiverem ativas acima), com e-mail/telefone/CPF criptografados (SHA-256) e o click ID da origem.</p></div>`;
}
async function trkConnSave(key, enabled) {
  const body = {};
  if (enabled !== undefined) body.enabled = enabled;
  const idEl = $('#trk-id-' + key); if (idEl) body.id = idEl.value;
  const tkEl = $('#trk-tk-' + key); if (tkEl && tkEl.value) body.token = tkEl.value;
  try { await api('/tracking/connections/' + key, { method: 'PUT', body }); trkState.data = null; if (enabled !== undefined) trkPaintTab(); }
  catch (e) { toast(e.message, 'error'); }
}

// Cartao do Meta Ads. Sem token colado a mao: o cliente autoriza pelo popup
// e escolhe a conta de anuncios numa lista.
function trkMetaCard(ov) {
  const m = ov.meta || {};
  const h = [];
  h.push(`<h2>${ico('sparkles')} Meta Ads, gasto automático das campanhas</h2>`);
  h.push(`<p class="muted" style="margin:0 0 12px;font-size:13px">Conecte sua conta de anúncios e o gasto, cliques, CTR, CPM e CPC entram sozinhos no cálculo de ROAS, ROI, CPA e CAC. Nenhum token para gerar à mão.</p>`);

  if (!m.hasToken) {
    h.push(`<button class="btn primary" onclick="trkMetaConnect()">${ico('sparkles', 15)} Conectar Meta Ads</button>`);
    h.push(`<p class="hint" style="margin-top:10px;text-align:left">Abre a autorização da Meta. Você escolhe a conta de anúncios e pronto: a permissão pedida é só de <b>leitura</b> (ads_read). A autorização vale <b>60 dias</b> — quando estiver perto de vencer, avisamos aqui para você reconectar em um clique, sem perder nada.</p>`);
    return h.join('');
  }

  const contas = m.adAccounts || [];
  const seletor = contas.length
    ? ecSelect('trk-meta-act', contas.map(a => ({ value: a.id, label: a.name + ' (' + a.id + ')' })), m.adAccountId, 'trkSaveMeta()')
    : `<input id="trk-meta-act" placeholder="act_123456789" value="${esc(m.adAccountId || '')}" onblur="trkSaveMeta()">`;

  h.push(`<div class="row" style="align-items:flex-end">`);
  h.push(`<label style="flex:1.4">Conta de anúncios${seletor}</label>`);
  h.push(`<button class="btn primary no-grow" id="trk-sync" onclick="trkSyncMeta()">${ico('activity', 14)} Sincronizar</button>`);
  h.push(`<button class="btn no-grow" onclick="trkMetaConnect()">${ico('refresh', 14)} Reconectar</button>`);
  h.push(`<button class="btn danger no-grow" onclick="trkMetaDisconnect()">Desconectar</button>`);
  h.push('</div>');

  h.push(metaTokenBar(m));
  return h.join('');
}

// Barra de validade do token. O OAuth da Meta dura 60 dias e o cliente precisa
// reconectar antes de vencer, então mostramos um contador honesto: quanto falta,
// e um alerta que fica mais forte conforme a data se aproxima.
function metaTokenBar(m) {
  const dias = m.expiresAt ? Math.floor((m.expiresAt - Date.now()) / 86400000) : null;
  const venc = m.expiresAt ? new Date(m.expiresAt).toLocaleDateString('pt-BR') : '';

  // estado visual conforme o tempo restante
  let cls = 'ok', titulo, texto;
  if (m.expired || (dias !== null && dias < 0)) {
    cls = 'crit';
    titulo = 'Autorização expirada';
    texto = 'A Meta parou de enviar o gasto das campanhas. Clique em <b>Reconectar</b> para voltar a sincronizar — leva 10 segundos.';
  } else if (dias === null) {
    cls = 'ok'; titulo = 'Conectado';
    texto = 'Sua conta de anúncios está enviando dados normalmente.';
  } else if (dias <= 5) {
    cls = 'crit';
    titulo = dias <= 0 ? 'Renove hoje' : `Renove em ${dias} dia${dias === 1 ? '' : 's'}`;
    texto = `A autorização vence ${dias <= 0 ? '<b>hoje</b>' : `em <b>${venc}</b>`}. Clique em <b>Reconectar</b> agora para não perder nenhum dado de campanha.`;
  } else if (dias <= 14) {
    cls = 'warn'; titulo = `Renove em breve · ${dias} dias`;
    texto = `Por segurança, a Meta limita a autorização a 60 dias. Ela vence em <b>${venc}</b>. Reconecte quando for cômodo.`;
  } else {
    cls = 'ok'; titulo = `Conectado · ${dias} dias restantes`;
    texto = `A autorização da Meta vale 60 dias e vence em <b>${venc}</b>. Quando faltar pouco, avisamos aqui para você reconectar em um clique.`;
  }

  // barra de progresso: 60 dias = cheia; vazia = na hora de renovar
  const pct = dias === null ? 100 : Math.max(0, Math.min(100, Math.round(dias / 60 * 100)));
  const ico2 = cls === 'crit' ? 'alert' : cls === 'warn' ? 'clock' : 'check-circle';

  return `<div class="meta-token ${cls}">
    <div class="mt-head">${ico(ico2, 15)} <b>${esc(titulo)}</b></div>
    <div class="mt-bar"><i style="width:${pct}%"></i></div>
    <p class="mt-txt">${texto}</p>
  </div>`;
}
async function trkSaveMeta() {
  try {
    const el = $('#trk-meta-act');
    const act = el ? (el.dataset.val !== undefined ? el.dataset.val : el.value) : '';
    await api('/tracking/meta', { method: 'PUT', body: { adAccountId: act } });
    trkState.data = null;
  } catch (e) { toast(e.message, 'error'); }
}

// ---- Conectar Meta Ads (OAuth, permissao ads_read) ----
// Abre o popup de autorizacao da Meta e espera o callback devolver o code.
async function trkMetaConnect() {
  let dados;
  try { dados = await api('/tracking/meta/auth-url'); }
  catch (e) { return toast(e.message, 'error'); }

  const w = openAuthWindow(dados.url, 'metaads', 'width=620,height=720');
  if (!w) return toast('Libere pop-ups para conectar o Meta Ads', 'error');

  const aoReceber = async ev => {
    if (ev.origin !== location.origin) return;                 // so aceita o nosso callback
    const d = ev.data || {};
    if (d.type !== 'ELITECHAT_METAADS_CALLBACK') return;
    window.removeEventListener('message', aoReceber);
    if (d.error) return toast(d.error, 'error');
    try {
      const r = await api('/tracking/meta/connect', { body: { code: d.code, state: d.state } });
      toast(r.adAccounts && r.adAccounts.length
        ? 'Meta Ads conectado! Escolha a conta de anúncios.'
        : 'Meta Ads conectado.');
      trkState.data = null;
      trkPaintTab();
    } catch (e) { toast(e.message, 'error'); }
  };
  window.addEventListener('message', aoReceber);
}

async function trkMetaDisconnect() {
  const ok = await confirmModal({
    title: 'Desconectar Meta Ads?',
    text: 'O gasto das campanhas deixa de entrar no cálculo de ROAS até você conectar de novo.',
    ok: 'Desconectar', danger: true
  });
  if (!ok) return;
  try {
    await api('/tracking/meta', { method: 'DELETE' });
    toast('Meta Ads desconectado');
    trkState.data = null; trkPaintTab();
  } catch (e) { toast(e.message, 'error'); }
}
async function trkSyncMeta() {
  const b = $('#trk-sync'); b.disabled = true;
  try {
    await trkSaveMeta();
    const r = await api('/tracking/meta/sync', { method: 'POST', body: {} });
    toast(`Sincronizado: ${r.campaigns} campanha(s) 🎯`); trkState.data = null; trkPaintTab();
  } catch (e) { toast(e.message, 'error'); }
  finally { if ($('#trk-sync')) $('#trk-sync').disabled = false; }
}

// ---- Campanhas ----
async function trkPaintCamp(box) {
  const { campaigns } = await api('/tracking/campaigns');
  box.innerHTML = `<div class="card"><h2>${ico('campaign') || ''} Relatório por campanha</h2>
    ${campaigns.length ? `<div style="overflow-x:auto"><table><thead><tr>
      <th>Campanha</th><th>Gasto</th><th>Receita</th><th>Lucro</th><th>ROAS</th><th>ROI</th><th>Pedidos</th><th>Conv.</th><th>CPA</th><th>Ticket</th><th>Produtos</th><th>Reemb./CB</th>
    </tr></thead><tbody>${campaigns.map(c => `<tr>
      <td><b>${esc(c.nome)}</b></td><td>${trkBRL(c.gasto)}</td><td>${trkBRL(c.receita)}</td>
      <td style="color:${c.lucro >= 0 ? 'var(--verde-esc)' : '#f87171'}"><b>${trkBRL(c.lucro)}</b></td>
      <td>${trkX(c.roas)}</td><td>${trkPct(c.roi)}</td><td>${c.pedidos}</td><td>${trkPct(c.conversao)}</td>
      <td>${c.cpa === null ? '—' : trkBRL(c.cpa)}</td><td>${trkBRL(c.ticket)}</td>
      <td class="muted" style="font-size:12px">${c.produtos.map(esc).join('<br>') || '—'}</td>
      <td>${trkBRL(c.refund + c.chargeback)}</td>
    </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Sem dados ainda, sincronize o Meta Ads e/ou receba vendas com UTM/click ID para ver o relatório.</p>'}</div>`;
}

// ---- Funil ----
async function trkPaintFunnel(box) {
  const { funnel } = await api('/tracking/funnel');
  const max = Math.max(1, ...funnel.map(f => f.qtd));
  box.innerHTML = `<div class="card"><h2>${ico('funnel') || ''} Funil de conversão, últimos 30 dias</h2>
    <div class="trk-funnel">${funnel.map(f => `
      <div class="trk-frow">
        <span class="trk-fname">${esc(f.nome)}</span>
        <div class="trk-fbar"><i style="width:${Math.max(2, Math.round(f.qtd / max * 100))}%"></i></div>
        <b>${fmtN(f.qtd)}</b>
        <span class="trk-frate">${f.taxa === null ? '' : '↳ ' + f.taxa + '%'}</span>
      </div>`).join('')}</div>
    <p class="muted" style="font-size:12px;margin:12px 0 0">Cliques = anúncios Meta + links rastreáveis · Visitas = PageView (snippet /t.js) · Leads = contatos novos · Checkout = aberturas do checkout · Upsell/Downsell = eventos customizados.</p></div>`;
}

// ---- Eventos ----
async function trkPaintEvents(box) {
  const { events } = await api('/tracking/events');
  box.innerHTML = `<div class="card"><h2>${ico('activity')} Eventos recebidos <span class="muted" style="font-weight:600;font-size:12.5px">· ${events.length} mais recentes</span></h2>
    ${events.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Evento</th><th>Origem</th><th>Data · Hora</th><th>Sessão</th><th>Campanha (UTM)</th><th>Valor</th><th>Status</th></tr></thead><tbody>
      ${events.map(e => `<tr>
        <td><b>${esc(e.name)}</b></td><td>${esc(e.source || '—')}</td>
        <td class="muted" style="white-space:nowrap">${new Date(e.ts).toLocaleDateString('pt-BR')} · ${new Date(e.ts).toLocaleTimeString('pt-BR').slice(0, 5)}</td>
        <td class="muted" style="font-size:11.5px">${esc((e.sid || '').slice(0, 10) || '—')}</td>
        <td>${esc((e.payload && e.payload.utm && e.payload.utm.campaign) || (e.payload && e.payload.campaign) || '—')}</td>
        <td>${e.payload && e.payload.value ? trkBRL(Math.round(e.payload.value * 100)) : '—'}</td>
        <td><span class="pill-ok">${esc(e.status || 'ok')}</span></td>
      </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted">Nenhum evento ainda. Instale o snippet no seu site ou receba visitas no checkout.</p>'}</div>`;
}

// ---- Alertas ----
async function trkPaintAlerts(box) {
  const ov = await api('/tracking');
  trkState.data = ov;
  box.innerHTML = `
    <div class="card"><h2>${ico('gear')} Limites dos alertas</h2>
      <div class="row" style="align-items:flex-end">
        <label style="max-width:200px">ROAS mínimo<input id="trk-al-roas" inputmode="decimal" value="${ov.alertsCfg.roasMin}"></label>
        <label style="max-width:220px">CPA máximo (R$, 0 = sem limite)<input id="trk-al-cpa" inputmode="decimal" value="${ov.alertsCfg.cpaMax}"></label>
        <button class="btn primary no-grow" onclick="trkSaveAlerts()">${ico('save', 14)} Salvar</button>
      </div></div>
    ${ov.alerts.map(a => `<div class="card sug-card ${a.level}">
      <span class="sug-ic">${ico(a.icon || 'activity', 18)}</span>
      <div><b>${esc(a.title)}</b><p class="muted" style="margin:3px 0 0;font-size:13px">${esc(a.text)}</p></div>
    </div>`).join('')}`;
}
async function trkSaveAlerts() {
  try {
    await api('/tracking/alerts', { method: 'PUT', body: { roasMin: $('#trk-al-roas').value, cpaMax: $('#trk-al-cpa').value } });
    toast('Alertas configurados'); trkState.data = null; trkPaintTab();
  } catch (e) { toast(e.message, 'error'); }
}

function trkSnippetModal() {
  const url = `${API.webOrigin}/t.js?a=${state.accountId}`;
  openModal(`<h2>${ico('code')} Instalar o Tracking no seu site</h2>
    <p class="muted" style="font-size:13px;margin:4px 0 12px">Cole antes do <b>&lt;/body&gt;</b> das suas páginas (landing, vendas, obrigado). Ele captura <b>fbclid, gclid, ttclid e UTMs</b> e liga cada visita à venda no Elite Pay.</p>
    <div class="ep-copy"><input readonly value='<script src="${esc(url)}"></script>' onclick="this.select()">
      <button class="btn small" onclick="epCopy(this.previousElementSibling.value)">${ico('copy', 13)}</button></div>
    <p class="hint" style="margin-top:12px">${ico('shield', 12)} O checkout do Elite Pay já rastreia sozinho, o snippet é para as SUAS páginas.</p>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn primary no-grow" onclick="closeModal()">Fechar</button></div>`);
}

init();
