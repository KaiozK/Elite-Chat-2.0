/* WA CRM — painel admin */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// PAINEL DA PLATAFORMA (/adm/) ou painel do cliente (/app/).
//
// Os dois moram na mesma origem e dividem o mesmo localStorage. Com uma
// chave de token só, entrar como cliente numa aba derrubava a sessão do
// admin na outra — e era a mesma sessão, o que anula a separação.
const ADM = /^\/adm(\/|$)/.test(location.pathname);
const TOKEN_KEY = ADM ? 'koonfy_adm_token' : 'wacrm_token';

let TOKEN = localStorage.getItem(TOKEN_KEY) || '';

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
      Koonfy fechado. Sem isso, você só vê a mensagem ao abrir o painel.
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
  const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', t === 'dark' ? '#080a08' : '#50EA5F');
  if (window.ECNative) ECNative.syncTheme();   // status bar do app acompanha o tema
}
function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
// O fuso NÃO é preferência de aparelho como o tema: ele decide o horário que
// sai escrito nas notificações e nas cobranças, então fica na conta, no
// servidor. Sem ele, o texto saía no fuso do processo — em produção, UTC.
function renderFusoSettings(cfg) {
  const atual = (cfg && cfg.timezone) || 'America/Sao_Paulo';
  const lista = (cfg && cfg.fusos) || [['America/Sao_Paulo', 'Brasília (GMT-3)']];
  const doNavegador = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
  const agora = (() => {
    try { return new Date().toLocaleString('pt-BR', { timeZone: atual, hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  })();
  const diferente = doNavegador && doNavegador !== atual && lista.some(([v]) => v === doNavegador);
  return `
    <h2>${ico('clock')} Fuso horário</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      Define o horário escrito nos lembretes de agendamento, nas cobranças e nos avisos.
      Agora são <b>${esc(agora)}</b> para esta conta.
    </p>
    <div class="row" style="align-items:flex-end">
      <label style="flex:1;max-width:360px">Fuso da conta${ecSelect('cfg-fuso',
        lista.map(([v, l]) => ({ value: v, label: l })), atual, 'salvarFuso()')}</label>
    </div>
    ${diferente ? `<p class="hint" style="margin-top:10px">${ico('info', 11)}
      Este dispositivo está em <b>${esc(doNavegador)}</b>, diferente do fuso da conta.
      <a href="#" onclick="usarFusoDoAparelho('${esc(doNavegador)}');return false">Usar o daqui</a>.</p>` : ''}`;
}
async function salvarFuso() {
  const tz = $('#cfg-fuso')?.value;
  if (!tz) return;
  try { await api('/settings', { method: 'PUT', body: { timezone: tz } }); toast('Fuso salvo'); renderSettings(); }
  catch (e) { toast(e.message, 'error'); }
}
async function usarFusoDoAparelho(tz) {
  try { await api('/settings', { method: 'PUT', body: { timezone: tz } }); toast('Fuso salvo'); renderSettings(); }
  catch (e) { toast(e.message, 'error'); }
}

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
  // LIGAÇÃO: tocar na notificação é o gesto de atender, não de "abrir o app e
  // procurar". O botão "Recusar" da notificação recusa; qualquer outro toque
  // atende.
  if (data.type === 'call' && data.callId) {
    if (data.action === 'reject') { recusarChamadaPorId(data.callId); return; }
    atenderChamadaPorId(data.callId);
    return;
  }
  if (data.waId) { location.hash = '#/inbox'; setTimeout(() => { try { openChat(data.waId); } catch {} }, 180); }
  else if (data.url) { const h = data.url.split('#')[1]; if (h) location.hash = h; }
}
// ---------------------------------------------------------------------------
// EXPORTAR CONTATOS
//
// A planilha respeita o limite de contatos do plano. Quando a base é maior que
// o teto, o download não pode simplesmente vir cortado sem explicação — o
// cliente contaria as linhas e acharia que perdeu contatos. Então o aviso vem
// ANTES, dizendo quantos saem, quantos ficam e por quê.
// ---------------------------------------------------------------------------
async function exportarContatos() {
  let info = null;
  try { info = await api('/contacts/export/info'); } catch { /* segue e baixa */ }
  const baixar = () => openExternal(API.api('/contacts/export?token=' + TOKEN));
  if (!info || !info.cortados) return baixar();
  openModal(`<h2>${ico('download-circle')} Exportar contatos</h2>
    <p class="muted" style="margin:8px 0 0;font-size:13.5px;line-height:1.6">
      Sua base tem <b>${fmtN(info.total)}</b> contatos e o seu plano dá direito a
      <b>${fmtN(info.limite)}</b>. A planilha sai com os <b>${fmtN(info.exporta)} mais recentes</b>;
      ${fmtN(info.cortados)} ${info.cortados === 1 ? 'fica' : 'ficam'} de fora.
    </p>
    <p class="muted" style="margin:12px 0 0;font-size:12.5px">
      ${ico('help', 12)} Para exportar a base inteira, mude para um plano com mais contatos em
      <b>Assinatura</b>. Nenhum contato é apagado, eles continuam aqui.
    </p>
    <div class="row" style="margin-top:18px;justify-content:flex-end">
      <button class="btn no-grow" onclick="closeModal()">Cancelar</button>
      <a class="btn no-grow" href="#/billing" onclick="closeModal()">Ver planos</a>
      <button class="btn primary no-grow" onclick="closeModal();openExternal(API.api('/contacts/export?token=' + TOKEN))">
        ${ico('download-circle', 14)} Baixar ${fmtN(info.exporta)}</button>
    </div>`);
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
  if (TOKEN) { try { connectSSE(); } catch {} notifResync(); recuperarChamadaPendente(true); }
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
    <p class="muted" style="margin:0 0 14px;font-size:13px">Controle os avisos do Koonfy instalado como aplicativo (Desktop, Android e iOS). ${perm !== 'granted' ? `<button class="btn small primary" style="margin-left:6px" onclick="notifEnable()">${ico('bell', 13)} Ativar notificações</button>` : ''}</p>
    <div class="notif-grid">
      ${ck('enabled', p.enabled, 'Notificações do sistema', 'Avisos nativos com o app em segundo plano')}
      ${ck('sounds', p.sounds, 'Sons', 'Toca um som ao chegar novidade')}
      ${ck('vibrate', p.vibrate, 'Vibração', 'Dispositivos compatíveis')}
      ${ck('badge', p.badge, 'Badge no ícone', 'Número de não lidas no ícone do app')}
      ${ck('systemWhenOpen', p.systemWhenOpen !== false, 'Avisar mesmo com o app aberto', 'Notificação do sistema além do aviso interno')}
    </div>
    <h3 class="notif-sub">Avisar sobre</h3>
    <div class="notif-grid">
      ${ck('types.message', p.types.message, 'Novas mensagens', 'Nome do contato + prévia')}
      ${ck('types.call', p.types.call, 'Ligações', 'Chamadas de voz recebidas')}
      ${ck('types.attendance', p.types.attendance, 'Atendimentos', 'Novo cliente iniciou conversa')}
      ${ck('types.reminder', p.types.reminder, 'Lembretes', 'Agendamentos da agenda')}
      ${ck('types.sale', p.types.sale !== false, 'Vendas aprovadas', 'Pagamento confirmado no Pagamentos')}
      ${ck('types.commission', p.types.commission !== false, 'Comissões de indicação', 'Sua parte na venda de um indicado')}
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn no-grow" onclick="notifTestFire(this)">${ico('bell', 14)} Enviar notificação de teste</button>
    </div>`;
}
function notifSet(path, val) { ECNotify.setPref(path, val); }
function notifEnable() {
  ECNotify.requestPermission().then(() => { const c = $('#notif-card'); if (c) c.innerHTML = renderNotifSettings(); });
}
// ---------------------------------------------------------------------------
// TESTE DE NOTIFICAÇÃO
//
// O teste antigo só chamava notify() no próprio navegador, então provava
// apenas o aviso interno. Este pede ao SERVIDOR que mande um push de verdade:
// se ele chegar, a cadeia inteira está de pé (inscrição, VAPID, service worker
// e a bandeja do sistema) e vai chegar também com o app fechado.
// ---------------------------------------------------------------------------
async function notifTestFire(btn) {
  const perm = ECNotify.permission();
  if (perm !== 'granted') {
    toast('Ative as notificações antes de testar.', 'error');
    return;
  }
  const txt = btn && btn.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }
  try {
    // garante que ESTE aparelho está inscrito antes de pedir o envio
    await ECNotify.subscribePush();
    const r = await api('/push/test', { body: { endpoint: await esteAparelho() } });
    toast(r.sent
      ? `Enviado para ${r.sent} aparelho(s). Feche o app e veja se chega.`
      : 'Nenhum aparelho inscrito ainda. Recarregue a página e tente de novo.', r.sent ? 'ok' : 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = txt; } }
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
// o retorno vem por deep link (koonfy://auth/...) e o native.js reemite o
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
  // 401 numa tela JÁ ABERTA é sessão vencida. 401 numa TENTATIVA DE ENTRAR é
  // senha errada, e responder "Sessão expirada" a quem nunca entrou é uma
  // mensagem sem sentido — pior, o logout() apagava o campo preenchido.
  const ehLogin = path === '/login' || path === '/adm/login';
  if (res.status === 401 && !ehLogin) { logout(true); throw new Error('Sessão expirada'); }
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
  'chevron-up': '<path d="m6 15 6-6 6 6"/>',
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
  mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  minimize: '<path d="M5 12h14"/>',
  maximize: '<path d="M4 10V5.5A1.5 1.5 0 0 1 5.5 4H10M14 4h4.5A1.5 1.5 0 0 1 20 5.5V10M20 14v4.5a1.5 1.5 0 0 1-1.5 1.5H14M10 20H5.5A1.5 1.5 0 0 1 4 18.5V14"/>',
  upload: '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
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
  // logotipo oficial do Pix: preenchido, desenhado em 16 e escalado para os 24
  // do restante do conjunto
  pix: '<g fill="currentColor" stroke="none" transform="scale(1.5)"><path d="M11.917 11.71a2.046 2.046 0 0 1-1.454-.602l-2.1-2.1a.4.4 0 0 0-.551 0l-2.108 2.108a2.044 2.044 0 0 1-1.454.602h-.414l2.66 2.66c.83.83 2.177.83 3.007 0l2.667-2.668h-.253zM4.25 4.282c.55 0 1.066.214 1.454.602l2.108 2.108a.39.39 0 0 0 .552 0l2.1-2.1a2.044 2.044 0 0 1 1.453-.602h.253L9.503 1.623a2.127 2.127 0 0 0-3.007 0l-2.66 2.66h.414z"/><path d="m14.377 6.496-1.612-1.612a.307.307 0 0 1-.114.023h-.733c-.379 0-.75.154-1.017.422l-2.1 2.1a1.005 1.005 0 0 1-1.425 0L5.268 5.32a1.448 1.448 0 0 0-1.018-.422h-.9a.306.306 0 0 1-.109-.021L1.623 6.496c-.83.83-.83 2.177 0 3.008l1.618 1.618a.305.305 0 0 1 .108-.022h.901c.38 0 .75-.153 1.018-.421L7.375 8.57a1.034 1.034 0 0 1 1.426 0l2.1 2.1c.267.268.638.421 1.017.421h.733c.04 0 .079.01.114.024l1.612-1.612c.83-.83.83-2.178 0-3.008z"/></g>',
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
// ---------------------------------------------------------------------------
// ABRIR O SELETOR SEM SER CORTADO
//
// O menu é `position: absolute` dentro do próprio seletor. Isso quebra quando
// algum ancestral tem overflow: no celular, a barra de ferramentas do chat rola
// na horizontal (overflow:auto) e tem 42px de altura — o menu das RESPOSTAS
// RÁPIDAS abria acima dela e era cortado inteiro. O select existia, as opções
// existiam, e não aparecia nada.
//
// Quando há um ancestral que corta, o menu passa a `position: fixed` com as
// coordenadas medidas na hora: fora de qualquer overflow, e continua colado no
// botão. Vale para todo seletor do app, não só este.
// ---------------------------------------------------------------------------
function temAncestralQueCorta(el) {
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible') return true;
  }
  return false;
}

function ecSelSoltar(el) {
  const menu = el.querySelector('.ecsel-menu'); if (!menu) return;
  if (!temAncestralQueCorta(el)) return;
  const r = el.getBoundingClientRect();
  const alturaMenu = Math.min(menu.scrollHeight + 12, 280);
  // Abre para CIMA quando não há espaço embaixo — a barra do chat fica no pé
  // da tela, então esse é o caso normal aqui.
  const cabeEmbaixo = r.bottom + alturaMenu + 8 <= window.innerHeight;
  // `min-width: 100%` do CSS passa a valer contra a JANELA quando o menu vira
  // fixed — ele saía com a largura da tela inteira e vazava pela direita. Some
  // aqui, e a largura passa a ser a do botão (com um mínimo para caber o texto).
  const largura = Math.min(Math.max(r.width, 168), window.innerWidth - 16);
  menu.style.position = 'fixed';
  menu.style.minWidth = '0';
  menu.style.width = largura + 'px';
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - largura - 8)) + 'px';
  menu.style.right = 'auto';
  if (cabeEmbaixo) { menu.style.top = (r.bottom + 5) + 'px'; menu.style.bottom = 'auto'; }
  else { menu.style.bottom = (window.innerHeight - r.top + 5) + 'px'; menu.style.top = 'auto'; }
  el.dataset.solto = '1';
}

function ecSelPrender(el) {
  if (!el.dataset.solto) return;
  const menu = el.querySelector('.ecsel-menu');
  if (menu) menu.style.cssText = '';
  delete el.dataset.solto;
}

function ecSelToggle(id) {
  const el = document.getElementById(id); if (!el) return;
  document.querySelectorAll('.ecsel.open').forEach(x => { if (x !== el) { x.classList.remove('open'); ecSelPrender(x); } });
  const abrindo = !el.classList.contains('open');
  el.classList.toggle('open', abrindo);
  if (abrindo) ecSelSoltar(el); else ecSelPrender(el);
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
  ecSelPrender(el);          // devolve o menu ao lugar quando ele foi solto
  const snip = el.dataset.onpick;
  if (snip) { try { new Function('val', 'id', snip)(val, id); } catch (e) { console.error('ecSelect onpick', e); } }
  else { const cb = el.dataset.cb; if (cb && typeof window[cb] === 'function') window[cb](); }
}
function ecSelVal(id) { const el = document.getElementById(id); return el ? el.dataset.val : ''; }
document.addEventListener('click', e => { if (!e.target.closest('.ecsel')) document.querySelectorAll('.ecsel.open').forEach(x => { x.classList.remove('open'); ecSelPrender(x); }); });

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  return d >= today ? hm : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
}

// Dentro do balão vai SÓ a hora. `fmtTime` acrescenta a data em mensagens de
// outros dias, o que na lista de conversas é necessário — mas na conversa a
// data já está no separador de dia logo acima, e "12/07 12:40" custava 63px
// de largura em todo balão, inclusive num "Oi" de 24px.
function fmtHora(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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

// `classe` permite variações de largura/disposição sem duplicar o esqueleto.
function openModal(html, classe) {
  $('#modal-root').innerHTML = `<div class="modal-back"><div class="modal ${classe || ''}"><button class="modal-x" onclick="closeModal()" title="Fechar (Esc)">${ico('x', 16)}</button>${html}</div></div>`;
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
      state.planRequired = !!me.planRequired;   // um F5 não pode destrancar a tela
      state.agent = me.agent || null;
      state.permissions = me.permissions || null;   // null = acesso total (dono/admin)
      state.planFeatures = me.planFeatures || null; // null = admin da plataforma (tudo liberado)
      // O SMS só aparece se o provedor estiver ligado na plataforma: o
      // módulo do plano sozinho abria uma tela que não envia nada.
      state.smsPlataforma = me.smsPlataforma !== false;
      // A loja no menu só depois de conectada, em Integrações.
      state.nsConectada = !!me.nsConectada;
      state.allowedViews = me.allowedViews || null;
      // O painel da plataforma só abre para o admin. Um token de cliente
      // guardado nesta chave abriria um menu cujas telas respondem 403.
      if (ADM && me.kind !== 'admin') { TOKEN = ''; localStorage.removeItem(TOKEN_KEY); return showLogin(); }
      return enterApp();
    } catch {}
  }
  showLogin();
}

function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  // A barra de baixo some junto: ela leva a telas que exigem sessão.
  const bar = document.getElementById('tabbar');
  if (bar) bar.classList.add('hidden');
  document.body.classList.remove('has-tabbar');
  // Link antigo (/app?novo=1) leva ao checkout: a conta nasce quando o
  // pagamento é confirmado, e abrir cadastro aqui devolveria o caminho que o
  // fluxo novo fechou.
  try {
    const p = new URLSearchParams(location.search);
    if (p.get('novo') === '1' || p.get('cadastro') === '1') location.replace('/assinar');
  } catch {}
}

// ---------------------------------------------------------------------------
// PERFIL DA EMPRESA NO CADASTRO
//
// Os três campos usam ecSelect(), o mesmo dropdown do resto do app: o <select>
// nativo abre uma lista desenhada pelo sistema, que não aceita a tipografia
// nem as cores do Koonfy e destoava do cartão de login.
// ---------------------------------------------------------------------------
const REG_SEGMENTOS = [
  'iGaming', 'Infoprodutos e cursos', 'E-commerce', 'Agência de marketing',
  'Clínica e saúde', 'Beleza e estética', 'Imobiliária', 'Educação',
  'Serviços financeiros', 'Seguros', 'Turismo e viagens', 'Automotivo',
  'Alimentação e delivery', 'Varejo físico', 'Tecnologia e SaaS', 'Consultoria',
  'Academia e esportes', 'Eventos', 'Logística', 'Outro'
];
const REG_TAMANHOS = ['Só eu', '2 a 5', '6 a 10', '11 a 25', '26 a 50', '51 a 100', 'Mais de 100'];
const REG_OBJETIVOS = [
  'Atender mais rápido', 'Vender pelo WhatsApp', 'Recuperar carrinho e lead frio',
  'Automatizar o atendimento', 'Organizar a equipe', 'Disparar campanhas',
  'Cobrar e receber (Pagamentos)'
];

// Monta uma vez só: remontar a cada abertura apagaria o que a pessoa escolheu
// antes de trocar de tela e voltar.
// Países do seletor de WhatsApp. Vêm do servidor porque a mesma lista decide
// a validação lá: duas listas separadas viram divergência na primeira edição.
let REG_PAISES = null;

async function montarPaises() {
  const box = document.getElementById('reg-country');
  if (!box || box.classList.contains('ecsel')) return;
  if (!REG_PAISES) {
    try { REG_PAISES = (await api('/public/countries')).countries; }
    catch { REG_PAISES = [{ value: 'BR', label: '🇧🇷 Brasil +55' }]; }
  }
  // no botão fica só a bandeira e o código; o nome do país ocuparia a linha
  // inteira e sobraria pouco para o número
  const curtos = REG_PAISES.map(p => ({
    value: p.value,
    label: p.flag + ' +' + p.dial,
    full: p.label
  }));
  // Trocar de país reformata o que já está digitado: a máscara do Brasil não
  // pode continuar valendo depois de escolher Portugal.
  box.outerHTML = ecSelect('reg-country', curtos, 'BR', 'mascararTelefone($("#reg-phone"))', 'fone-pais');
  // a lista aberta mostra o nome completo
  document.querySelectorAll('#reg-country .ecsel-opt').forEach(o => {
    const p = curtos.find(x => String(x.value) === o.dataset.val);
    if (p) o.textContent = p.full;
  });
}

function montarCamposDoPerfil() {
  const opcoes = (lista, vazio) => [{ value: '', label: vazio }].concat(lista.map(x => ({ value: x, label: x })));
  const por = [
    ['reg-segment', REG_SEGMENTOS, 'Selecione o segmento…'],
    ['reg-size', REG_TAMANHOS, 'Quantas pessoas…'],
    ['reg-goal', REG_OBJETIVOS, 'Selecione…']
  ];
  montarPaises();
  for (const [id, lista, vazio] of por) {
    const box = document.getElementById(id);
    if (!box || box.classList.contains('ecsel')) continue;   // já montado
    box.outerHTML = ecSelect(id, opcoes(lista, vazio), '');
  }
  // Tipo da chave Pix: os mesmos valores que o servidor aceita em
  // validateOnboarding — uma lista diferente aqui só viraria erro 400.
  const tipo = document.getElementById('reg-pixtipo');
  if (tipo && !tipo.classList.contains('ecsel')) {
    tipo.outerHTML = ecSelect('reg-pixtipo', [
      { value: '', label: 'Selecione…' },
      { value: 'cpf', label: 'CPF' },
      { value: 'cnpj', label: 'CNPJ' },
      { value: 'email', label: 'E-mail' },
      { value: 'telefone', label: 'Telefone' },
      { value: 'aleatoria', label: 'Chave aleatória' }
    ], '');
  }
}

let registerMode = false;
function toggleRegister(e) {
  if (e) e.preventDefault();
  registerMode = !registerMode;
  $('#reg-name-wrap').classList.toggle('hidden', !registerMode);
  const perfil = $('#reg-perfil');
  if (perfil) perfil.classList.toggle('hidden', !registerMode);
  if (registerMode) montarCamposDoPerfil();
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
  // Ao entrar no cadastro a trilha aparece e volta para a primeira etapa; ao
  // sair, tudo se recolhe e a tela vira o login simples de e-mail e senha.
  const trilha = $('#reg-trilha');
  if (trilha) trilha.classList.toggle('hidden', !registerMode);
  const pag = $('#reg-pag');
  if (pag) pag.classList.toggle('hidden', true);
  if (registerMode) {
    mostrarPasso(1);
  } else {
    $('#login-form').querySelectorAll('[data-etapa]').forEach(el => {
      // Fora do cadastro só sobram os campos da etapa 1 que o login usa; o
      // nome da empresa e o resto voltam a ficar escondidos pelos ids.
      el.classList.toggle('hidden', el.dataset.etapa !== '1');
    });
    $('#reg-name-wrap').classList.add('hidden');
    $('#reg-voltar').classList.add('hidden');
    $('#reg-pular').classList.add('hidden');
    passoAtual = 1;
  }
  $('#auth-title').textContent = registerMode ? 'Crie sua conta' : 'Acesse sua conta';
  $('#auth-sub').textContent = registerMode ? 'Conecte seu WhatsApp em minutos, sem configuração técnica' : 'Painel de atendimento e vendas';
  // No cadastro quem manda no rótulo é a etapa (mostrarPasso já ajustou):
  // sobrescrever aqui faria a etapa 1 dizer "Criar conta" antes da hora.
  if (!registerMode) $('#auth-btn').textContent = 'Entrar';
  $('#auth-toggle').innerHTML = registerMode
    ? 'Já tem conta? <a href="#" onclick="toggleRegister(event)">Entrar</a>'
    : 'Ainda não é cliente? <a href="/assinar">Ver os planos</a>';
  // O aceite só aparece no CADASTRO: em quem já tem conta seria ruído.
  $('#auth-legal').classList.toggle('hidden', !registerMode);
  $('#login-err').textContent = '';
}

// ---------------------------------------------------------------------------
// SEGUNDO PASSO DO LOGIN
//
// A senha já conferiu no servidor, mas nenhum token foi emitido: só o código
// certo troca o ticket por uma sessão. Por isso a tela de login continua no
// lugar, apenas com outro formulário.
// ---------------------------------------------------------------------------
let TFA_TICKET = null;

function pedirCodigo2FA(ticket, email) {
  TFA_TICKET = ticket;
  const box = $('#login-form');
  if (!box) return;
  box.innerHTML = `
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      Enviamos um código de 6 dígitos para <b>${esc(email || "seu e-mail")}</b>.
      Ele vale por 10 minutos.
    </p>
    <label>Código<input id="tfa-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
      placeholder="000000" style="letter-spacing:8px;text-align:center;font-size:20px;font-weight:800"></label>
    <button type="button" class="btn primary" style="margin-top:14px;width:100%" onclick="enviarCodigo2FA(this)">Entrar</button>
    <button type="button" class="btn" style="margin-top:8px;width:100%" onclick="location.reload()">Voltar</button>`;
  setTimeout(() => { const i = $('#tfa-code'); if (i) i.focus(); }, 60);
  const inp = $('#tfa-code');
  if (inp) inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') enviarCodigo2FA(); });
}

async function enviarCodigo2FA(btn) {
  const el = $('#tfa-code'); if (!el) return;
  $('#login-err').textContent = '';
  if (btn) btn.disabled = true;
  try {
    const r = await api('/login/2fa', { body: { ticket: TFA_TICKET, code: el.value.trim() } });
    TOKEN = r.token;
    localStorage.setItem(TOKEN_KEY, TOKEN);
    state.user = r.user; state.kind = r.kind; state.accountId = r.accountId;
    state.iaLigada = !!r.iaLigada;
    state.wa = r.wa; state.agent = null; state.permissions = null;
    enterApp();
  } catch (err) {
    $('#login-err').textContent = err.message;
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// CADASTRO EM ETAPAS
//
// Eram dez campos de uma vez no mesmo cartão. Divididos em três, cada tela
// pede uma coisa só: quem é você, o que você faz, e por onde recebe. A última
// abre a conta de Pagamentos junto — e é opcional, porque o cadastro não pode
// depender do gateway estar de pé.
// ---------------------------------------------------------------------------
let passoAtual = 1;
const ULTIMO_PASSO = 3;

function mostrarPasso(n) {
  passoAtual = n;
  const form = $('#login-form');
  form.querySelectorAll('[data-etapa]').forEach(el => {
    el.classList.toggle('hidden', String(n) !== el.dataset.etapa);
  });
  $('#reg-trilha').querySelectorAll('[data-passo]').forEach(s => {
    const p = Number(s.dataset.passo);
    s.classList.toggle('feito', p < n);
    s.classList.toggle('agora', p === n);
  });
  $('#reg-voltar').classList.toggle('hidden', n === 1);
  $('#reg-pular').classList.toggle('hidden', n !== ULTIMO_PASSO);
  $('#auth-btn').textContent = n < ULTIMO_PASSO ? 'Continuar' : 'Criar conta';
  $('#login-err').textContent = '';
}
function passoAnterior() { if (passoAtual > 1) mostrarPasso(passoAtual - 1); }

// Cada etapa confere o que é dela antes de deixar passar: descobrir no fim que
// o e-mail estava errado obrigaria a voltar três telas.
// ---------------------------------------------------------------------------
// TELEFONE DO CADASTRO
//
// O campo aceitava qualquer coisa: "1198388348343434" passava. É um campo de
// WhatsApp, então no Brasil só serve celular — 11 dígitos, DDD e o 9 na frente.
// A máscara desenha (XX) 9XXXX-XXXX enquanto se digita; fora do Brasil ela sai
// do caminho, porque cada país tem o seu formato e forçar o nosso só atrapalha.
// ---------------------------------------------------------------------------
function mascararTelefone(input) {
  const br = (ecSelVal('reg-country') || 'BR') === 'BR';
  let d = (input.value || '').replace(/\D/g, '');
  if (!br) { input.value = d.slice(0, 15); return; }
  d = d.slice(0, 11);
  let out = d;
  if (d.length > 2) out = `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length > 7) out = `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  input.value = out;
}

// ---------------------------------------------------------------------------
// CPF / CNPJ — os mesmos dígitos verificadores que o servidor confere
// (src/documento.js) e que o checkout já usa. Aqui a conta é feita no
// navegador para o erro sair na hora de digitar, sem ida ao servidor.
// ---------------------------------------------------------------------------
function mascararDoc(v) {
  const d = String(v || '').replace(/\D/g, '').slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
            .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
          .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}
function cpfValido(d) {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (let r = 0; r < 2; r++) {
    const ate = 9 + r; let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    if ((resto === 10 ? 0 : resto) !== Number(d[ate])) return false;
  }
  return true;
}
function cnpjValido(d) {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const confere = (ate) => {
    let soma = 0, peso = ate - 7;
    for (let i = 0; i < ate; i++) { soma += Number(d[i]) * peso; peso = peso === 2 ? 9 : peso - 1; }
    const resto = soma % 11;
    return (resto < 2 ? 0 : 11 - resto) === Number(d[ate]);
  };
  return confere(12) && confere(13);
}
function docValido(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false;
}
// Mensagem que diz onde olhar: "CPF inválido", não "documento inválido".
function erroDoc(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return 'Informe o CPF ou CNPJ';
  if (d.length !== 11 && d.length !== 14) {
    return 'CPF ou CNPJ incompleto: ' + (d.length < 11 ? 'faltam dígitos' : 'dígitos a mais');
  }
  if (docValido(d)) return '';
  return d.length === 11 ? 'CPF inválido. Confira os números digitados'
                         : 'CNPJ inválido. Confira os números digitados';
}

// Mesma regra do servidor (`paises.paraE164`), para o erro aparecer na hora de
// digitar e não depois de enviar o cadastro inteiro.
function erroTelefone(valor, iso) {
  const d = String(valor || '').replace(/\D/g, '');
  if (!d) return 'Informe o WhatsApp';
  if ((iso || 'BR') !== 'BR') return d.length < 7 ? 'Número de WhatsApp inválido' : null;
  if (d.length !== 11) return 'WhatsApp inválido. Use (XX) 9XXXX-XXXX, com DDD e 11 dígitos.';
  if (Number(d.slice(0, 2)) < 11) return 'DDD inválido. Use o DDD de 2 dígitos, como (11).';
  if (d[2] !== '9') return 'Celular no Brasil começa com 9 depois do DDD: (XX) 9XXXX-XXXX.';
  return null;
}

function validarPasso(n) {
  if (n === 1) {
    if (!$('#reg-name').value.trim()) return 'Informe o nome da empresa';
    const mail = $('#login-user').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return 'Informe um e-mail válido';
    if (($('#login-pass').value || '').length < 6) return 'A senha precisa de pelo menos 6 caracteres';
  }
  if (n === 2) {
    if (!ecSelVal('reg-segment')) return 'Escolha o segmento';
    const err = erroTelefone(($('#reg-phone') || {}).value, ecSelVal('reg-country') || 'BR');
    if (err) { const c = $('#reg-phone'); if (c) c.focus(); return err; }
  }
  if (n === 3) {
    // Vazio é válido: quem pula termina o Pagamentos depois. Preenchido pela
    // metade não é — o gateway recusaria e o erro apareceria fora de hora.
    const doc = ($('#reg-doc').value || '').replace(/\D/g, '');
    const chave = ($('#reg-pixkey').value || '').trim();
    if (!doc && !chave) return null;
    if (doc.length !== 11 && doc.length !== 14) return 'CPF ou CNPJ inválido';
    if (!chave) return 'Informe a chave Pix que vai receber';
    if (!ecSelVal('reg-pixtipo')) return 'Escolha o tipo da chave Pix';
  }
  return null;
}

// "Pular": manda criar a conta sem os dados de recebimento.
function pularRecebimento(e) {
  if (e) e.preventDefault();
  $('#reg-doc').value = '';
  $('#reg-pixkey').value = '';
  $('#login-form').requestSubmit();
}

async function doLogin(e) {
  e.preventDefault();
  $('#login-err').textContent = '';
  // No cadastro, o botão avança de etapa até a última.
  if (registerMode) {
    const erro = validarPasso(passoAtual);
    if (erro) { $('#login-err').textContent = erro; return; }
    if (passoAtual < ULTIMO_PASSO) return mostrarPasso(passoAtual + 1);
  }
  try {
    const user = $('#login-user').value.trim();
    const pass = $('#login-pass').value;
    const r = registerMode
      // o código da janela de 7 dias tem prioridade sobre o que estiver no campo
      ? await api('/register', { body: {
          name: $('#reg-name').value.trim(), email: user, pass,
          refCode: refAtivo() || ($('#reg-ref')?.value || '').trim(),
          // perfil da empresa: orienta o onboarding e o atendimento comercial
          profile: {
            segment: ecSelVal('reg-segment'),
            size: ecSelVal('reg-size'),
            phone: ($('#reg-phone') || {}).value || '',
            country: ecSelVal('reg-country') || 'BR',
            goal: ecSelVal('reg-goal')
          },
          // Recebimento: vazio quando o cliente pulou a etapa. O servidor
          // decide o que fazer — aqui não se supõe que o gateway respondeu.
          recebimento: {
            document: ($('#reg-doc')?.value || '').replace(/\D/g, ''),
            pixKey: ($('#reg-pixkey')?.value || '').trim(),
            pixKeyType: ecSelVal('reg-pixtipo') || ''
          }
        } })
      : await api(ADM ? '/adm/login' : '/login', { body: { user, pass } });
    // Senha certa, mas a conta pede o segundo fator: ainda NÃO existe token.
    if (r.twoFactor) return pedirCodigo2FA(r.ticket, r.email);
    TOKEN = r.token;
    localStorage.setItem(TOKEN_KEY, TOKEN);
    state.user = r.user;
    state.kind = r.kind;

    state.iaLigada = !!r.iaLigada;
    state.accountId = r.accountId;
    state.wa = r.wa;
    state.mustChangePassword = !!r.mustChangePassword;
    state.planRequired = !!r.planRequired;
    state.agent = r.agent || null;
    state.permissions = r.permissions || null;
    state.allowedViews = r.allowedViews || null;
    // A aba da loja segue o estado dela desde o primeiro instante da sessão.
    state.nsConectada = !!r.nsConectada;
    enterApp();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
}

async function logout(silent) {
  try { if (!silent) await api('/logout', { body: {} }); } catch {}
  TOKEN = '';
  localStorage.removeItem(TOKEN_KEY);
  if (es) { es.close(); es = null; }
  clearInterval(pollTimer);
  location.hash = '';
  showLogin();
}

async function enterApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').textContent = state.user || '';
  const av = $('#tb-avatar');
  if (av) av.textContent = (state.user || 'A')[0].toUpperCase();

  // PAINEL DA PLATAFORMA: entrada curta. Não há canal de WhatsApp para
  // escolher, carteira para somar, presença de atendente nem conversa para
  // avisar — o resto desta função é o painel do cliente se montando.
  if (ADM) {
    setTheme(currentTheme());
    // O PUSH ENTRA AQUI. O teste de venda do painel manda para os aparelhos
    // inscritos NESTA conta, e sem isto o painel nunca inscrevia nenhum: o
    // botão disparava para ninguém e parecia que o push estava quebrado.
    if (window.ECNotify) {
      ECNotify.setHooks({ onChange: paintNotifBell });
      askNotifPermission();
    }
    route();
    if (state.mustChangePassword) toast('Troque a senha padrão em Configurações → Segurança', 'error');
    return;
  }
  paintTopbarAvatar(); // usa a foto do perfil conectado quando existir
  applyNavPermissions();   // esconde do menu os módulos sem permissão de visualizar
  startPresence();         // heartbeat de presença (atendente)
  if (window.ECNotify) { ECNotify.setHooks({ onOpen: notifOpenFromData, onResync: notifResync, onChange: paintNotifBell, onCallEnd: chamadaEncerradaEmOutroAparelho }); paintNotifBell(); }
  setTheme(currentTheme());   // sincroniza o ícone de tema do topbar
  askNotifPermission();    // permissão + push do WebApp
  refreshWallet();         // saldo no cabeçalho
  initSearch();
  await loadChannels();    // canais (conexões WhatsApp) antes de qualquer listagem
  try { const st = await api('/settings'); state.settings = st.settings; state.wa = st.wa; } catch {}
  connectSSE();
  refreshBadge();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshBadge, 30000);
  if (state.mustChangePassword) toast('Troque a senha padrão em Configurações → Segurança', 'error');
  route();
  atenderPelaUrl();
  // PARTIDA FRIA COM O TELEFONE TOCANDO. No celular o app quase sempre está
  // fechado, então abrir pelo ícone é a regra e não a exceção — e numa
  // partida fria o documento já nasce visível, então `visibilitychange` não
  // dispara. Sem esta linha o app subia, pintava o dashboard e ficava calado
  // com uma ligação tocando do outro lado. No computador nunca apareceu
  // porque lá o app fica aberto o dia inteiro e o SSE já está conectado.
  recuperarChamadaPendente(true);
}

// O app pode ter sido ABERTO pelo toque na notificação de chamada — o Service
// Worker põe `?atender=<id>` na URL justamente porque, com o app fechado, não
// há a quem mandar mensagem. A intenção é consumida uma vez e apagada da barra
// de endereços, senão um F5 tentaria atender de novo uma chamada encerrada.
function atenderPelaUrl() {
  let id = '';
  try { id = new URLSearchParams(location.search).get('atender') || ''; } catch {}
  if (!id) return;
  try { history.replaceState(null, '', location.pathname + location.hash); } catch {}
  atenderChamadaPorId(id);
}

// No PWA do navegador ninguém chama `__ecOnResume`: quem avisa que o app voltou
// à tela é o `visibilitychange`. Sem isto, quem abriu o app pelo ícone (em vez
// da notificação) voltava para uma tela parada, sem sinal nenhum de que o
// telefone estava tocando.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !TOKEN) return;
  recuperarChamadaPendente(true);
});

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
      ${/* Um único botão, sem preço à mostra: dentro do plano ele cria a conexão
            direto; com o plano no limite, abre o pop-up, onde o cliente escolhe
            quantas quer e como pagar. */''}
      <button class="btn primary no-grow" onclick="${cheio ? "openExtraPay('whatsapps')" : 'createChannel()'}">
        ${ico('plus', 14)} Adicionar conexão</button>
    </div>
    ${cheio ? `<p class="hint" style="margin-top:10px">${ico('alert', 12)} Você já utiliza as <b>${fmtN(lim.limit)}</b> conexão(ões) disponíveis no seu plano.</p>`
    : '<p class="hint" style="margin-top:10px">Depois de criar a conexão, selecione-a no seletor do topo e clique em <b>Conectar WhatsApp</b> para vincular o número.</p>'}
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
  es.addEventListener('campaign', () => {
    if (state.view === 'campaigns') paintCampaigns();
    // O relatório é a tela que existe para ver isto acontecer: repinta a cada
    // destinatário processado, que é de onde vem a sensação de ao vivo.
    if (state.view === 'campaigns/report') rcAoVivo();
  });
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
  // Pagamentos — status das cobranças em tempo real (pago/cancelado/subconta)
  es.addEventListener('pagamentos', e => {
    const d = JSON.parse(e.data || '{}');
    if (d.status === 'paid' && window.ECNotify) {
      ECNotify.notify({
        // 'sale' e não 'message': é o aviso que toca a caixa registradora, para
        // dar para reconhecer uma venda sem olhar a tela.
        type: 'sale', title: '💸 Pagamento recebido!',
        body: `${fmtBRL(d.amount || 0)}${d.contactName ? ', ' + d.contactName : ''}`,
        waId: d.waId || null, url: '/app/#/pagamentos', tag: 'ep:' + (d.chargeId || '')
      });
    }
    if (state.view === 'pagamentos') { epPaintTab(); }
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
// ---------------------------------------------------------------------------
// AS ABAS DO ADMIN SaaS
//
// Cada uma é uma ROTA e um item do menu lateral do painel da plataforma.
// Eram treze abas numa barra horizontal: no computador passava do fim da
// tela, no celular viravam treze botões que ninguém acerta com o dedo, e
// nenhuma tinha endereço — não dava para salvar nem voltar direto.
//
// Fica AQUI, e não junto do código do Admin, porque `views` espalha estas
// chaves na avaliação do arquivo: declarado depois, o const ainda estaria na
// zona morta e o app morreria antes de pintar.
// ---------------------------------------------------------------------------
const ADM_ABAS = {
  'adm/vis':            { aba: 'adm-vis',  titulo: 'Visão geral do SaaS', sub: 'Receita, assinaturas e crescimento' },
  'adm/contas':         { aba: 'adm-acc',  titulo: 'Contas',              sub: 'Todos os clientes da plataforma' },
  'adm/planos':         { aba: 'adm-pl',   titulo: 'Planos',              sub: 'Preço, limites e recursos de cada plano' },
  'adm/afiliados':      { aba: 'adm-aff',  titulo: 'Afiliados',           sub: 'Comissões e indicações' },
  'adm/gateways':       { aba: 'adm-pay',  titulo: 'Gateways',            sub: 'Provedores, taxas e regras de cobrança' },
  'adm/notificacoes':   { aba: 'adm-notif',titulo: 'Notificações',        sub: 'Testar os avisos que chegam no celular' },
  'adm/saques':         { aba: 'adm-wd',   titulo: 'Saques',              sub: 'Pedidos de saque dos clientes' },
  'adm/pagamentos':     { aba: 'adm-ep',   titulo: 'Pagamentos',          sub: 'Subcontas, cobranças e taxas recebidas' },
  'adm/integracoes':    { aba: 'adm-int',  titulo: 'Integrações',         sub: 'Serviços externos e SMS' },
  'adm/plataforma':     { aba: 'adm-plat', titulo: 'Plataforma',          sub: 'Credenciais do app da Meta' },
  'adm/marketing':      { aba: 'adm-mkt',  titulo: 'Marketing',           sub: 'Pixels e rastreamento da vitrine' },
  'adm/seguranca':      { aba: 'adm-sec',  titulo: 'Segurança',           sub: 'Senha, sessões e acesso' },
  'adm/seo':            { aba: 'adm-seo',  titulo: 'SEO',                 sub: 'Como a vitrine aparece no Google' },
  'adm/personalizacao': { aba: 'adm-tema', titulo: 'Personalização',      sub: 'Logo, nome e cores da marca' },
  'adm/banners':        { aba: 'adm-bnr',  titulo: 'Banners',             sub: 'A faixa de avisos no topo da dashboard dos clientes' }
};

// Tudo que pertence ao painel da plataforma, para o roteador do app do
// cliente saber o que mandar embora daqui.
function ehRotaDoAdmin(v) { return v === 'admin' || v.indexOf('adm/') === 0; }

// A aba pedida pela rota. Fora do painel da plataforma, e sem rota de aba,
// vale a que estiver marcada na barra — o comportamento de antes.
function admAbaDaRota() {
  const v = (location.hash || '').replace('#/', '').split('?')[0];
  return ADM_ABAS[v] || null;
}

const views = {
  dashboard: renderDashboard, inbox: renderInbox, contacts: renderContacts,
  funnel: renderFunnel, campaigns: renderCampaigns, templates: renderTemplates, quick: renderQuick,
  logs: renderLogs, settings: renderSettings, team: renderTeam, flows: renderFlows, links: renderLinks,
  pixels: renderPixels, billing: renderBilling, sms: renderSms,
  afiliacao: renderAfiliacao,
  integrations: renderIntegrations, webhooks: renderIntegrations, // #/webhooks continua funcionando
  pagamentos: renderPagamentos, tracking: renderTracking,
  consent: renderConsent, agents: renderAgents, 'agents/perf': renderAgentPerf,
  ia: renderIA,
  'agents/logs': renderAgentLogs, schedule: renderSchedule,
  reports: () => { location.hash = '#/dashboard'; }, // aba Relatórios foi absorvida pelo Dashboard
  'templates/new': renderTemplateNew, 'campaigns/new': renderCampaignNew,
  'links/new': renderLinkForm, 'links/edit': renderLinkForm, 'links/stats': renderLinkStats,
  'campaigns/report': renderCampaignReport, 'campaigns/mapa': renderMapaLeads,
  'pagamentos/checkout': renderCheckoutBuilder,
  checkouts: renderCheckoutList,
  nuvemshop: renderNuvemshop,
  // ---- painel da plataforma (/adm/) ----
  'adm/visao': renderAdmVisao,
  'adm/contatos': renderAdmContatos,
  'adm/usuarios': renderAdmUsuarios,
  'adm/supers': renderAdmSupers,
  // As abas do Admin SaaS, cada uma com o seu endereço.
  ...Object.fromEntries(Object.keys(ADM_ABAS).map(k => [k, renderAdmin]))
};

// Em /adm/ o destino padrão é a operação, não o dashboard de um cliente, e
// as telas do cliente não fazem parte do menu.
const VIEW_PADRAO = ADM ? 'adm/visao' : 'dashboard';
// qual item da sidebar destacar para cada view (rotas com "/" caem no pai)
const NAV_OF = {
  'templates/new': 'templates', 'campaigns/new': 'campaigns',
  'links/new': 'links', 'links/edit': 'links', 'links/stats': 'links',

  'agents/perf': 'agents', 'agents/logs': 'agents',
  'campaigns/report': 'campaigns', 'campaigns/mapa': 'campaigns',
  'pagamentos/checkout': 'checkouts',
  // Pixels virou aba de Tracking: a rota continua, o menu é o mesmo.
  pixels: 'tracking'
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
  'pagamentos/checkout': 'pagamentos', checkouts: 'pagamentos',
  billing: null, admin: null, logs: null   // sempre acessíveis (donos/config próprios)
};
// O plano do cliente inclui este módulo? (null = sem restrição de plano)
// checkouts pertence ao Pagamentos; integrations cobre webhooks/Nuvemshop.
// A loja faz parte do módulo de Integrações: o plano que libera um libera a
// outra, e não faz sentido ter a tela da loja sem poder conectá-la.
const VIEW_FEATURE = { checkouts: 'pagamentos', webhooks: 'integrations', nuvemshop: 'integrations' };
// ---------------------------------------------------------------------------
// ASSINATURA OBRIGATÓRIA
//
// Enquanto não houver plano ativo, a conta só alcança Assinatura e as
// Configurações da própria conta. O servidor recusa o resto com 402; aqui a
// navegação some, para a pessoa não bater na parede e achar que quebrou.
// ---------------------------------------------------------------------------
const VIEWS_SEM_PLANO = ['billing', 'settings'];

function precisaAssinar() { return !!state.planRequired; }

function planHas(view) {
  // O SMS tem DUAS chaves: o módulo no plano e o provedor ligado na
  // plataforma. Sem a segunda, a tela existe mas não envia.
  if (view === 'sms' && state.smsPlataforma === false) return false;
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
// O FUNIL NÃO ESTÁ AQUI. Ele é um quadro de colunas que se opera ARRASTANDO
// o cartão de uma etapa para a outra — e arrastar de lado num aparelho é o
// gesto de rolar a tela. Sobra um quadro que só se olha, com as colunas
// espremidas em 375px: a tela existe, mas não faz o que ela é. Fica no
// computador, onde o gesto é o mouse e as colunas cabem lado a lado.
const MOBILE_VIEWS = new Set([
  'dashboard', 'inbox', 'team', 'schedule', 'contacts',
  'quick', 'billing', 'afiliacao', 'settings',
  // Pagamentos no celular é uma tela PRÓPRIA, enxuta: cobrar na frente do
  // cliente e mandar o Pix. O módulo completo (produtos, checkout, relatórios,
  // saque) continua só no computador — ali é trabalho de mesa.
  'pagamentos',
  // ACOMPANHAR um disparo é o oposto de montá-lo: é a tela que se olha no
  // elevador, no carro, no meio da reunião. Um tempo real que só existe no
  // computador é um tempo real que não está onde a pessoa está. Montar a
  // campanha continua sendo trabalho de mesa; ver o resultado, não.
  'campaigns/report'
]);
// 820px é o mesmo ponto em que a sidebar já vira gaveta (style.css).
const MOBILE_MQ = window.matchMedia('(max-width: 820px)');
function isMobileLayout() { return API.native || MOBILE_MQ.matches; }

function applyNavPermissions() {
  // Assinatura e Admin são do DONO/admin — atendentes nunca veem
  const ownerOnly = new Set(['billing']);
  const mobile = isMobileLayout();
  $$('.nav-item[data-view]').forEach(n => {
    const v = n.dataset.view;
    if (mobile && !MOBILE_VIEWS.has(v)) { n.style.display = 'none'; return; }
    if (state.agent && ownerOnly.has(v)) { n.style.display = 'none'; return; }
    if (precisaAssinar() && !VIEWS_SEM_PLANO.includes(v)) { n.style.display = 'none'; return; }
    if (!planHas(v)) { n.style.display = 'none'; return; }   // fora do plano contratado
    // A LOJA só entra no menu depois de conectada. A conexão se faz em
    // Integrações; antes disso a aba abre numa tela que só sabe falar com uma
    // Nuvemshop, e o erro parece defeito do produto.
    if (v === 'nuvemshop' && !state.nsConectada) { n.style.display = 'none'; return; }
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
const TABBAR_VIEWS = ['dashboard', 'inbox', 'contacts', 'pagamentos'];
const TABBAR_LABEL = {
  dashboard: 'Início', inbox: 'Conversas', contacts: 'Contatos', pagamentos: 'Cobrar',
  schedule: 'Agenda',
  team: 'Chat interno', quick: 'Respostas', billing: 'Assinatura',
  afiliacao: 'Afiliação', settings: 'Ajustes'
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
  // A barra só faz sentido DEPOIS de entrar: todos os destinos dela exigem
  // sessão, e no login ela aparecia oferecendo caminhos que não abrem.
  const dentro = !document.getElementById('login') || document.getElementById('login').classList.contains('hidden');
  const mobile = isMobileLayout() && dentro;
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

// ---------- CARTEIRA NO CABEÇALHO ----------
// Saldo sempre à vista e depósito a um toque, no celular e no computador. O
// saldo também mora na tela de Assinatura, mas é o número que o lojista mais
// confere: deixar no cabeçalho evita uma viagem de tela a cada consulta.
let WALLET = { balance: 0, deposito: { min: 100, max: 0 } };

async function refreshWallet() {
  const caixa = document.getElementById('tb-wallet');
  if (!caixa) return;
  // Atendente não tem carteira própria: a da empresa não é assunto dele.
  if (state.agent) { caixa.classList.add('hidden'); return; }
  try {
    WALLET = await api('/wallet/summary');
    const val = document.getElementById('tb-wallet-val');
    if (val) val.textContent = fmtBRL(WALLET.balance);
    caixa.classList.remove('hidden');
  } catch { caixa.classList.add('hidden'); }
}

// Pop-up de depósito. A faixa vem do Admin SaaS; validamos aqui só para dar
// resposta imediata — quem decide de verdade é o servidor.
// ---------------------------------------------------------------------------
// DEPOSITAR NA CARTEIRA
//
// Atalhos de valor em duas fileiras de cinco: quem recarrega quase nunca digita
// um número quebrado, e a faixa vai de R$ 10 a R$ 2.000 para atender tanto o
// teste inicial quanto quem opera em volume.
//
// Dois meios, com naturezas diferentes: o Pix espera o pagamento cair (QR na
// própria janela) e o CARTÃO credita na hora, porque o adquirente responde
// síncrono. Só aparece o que o admin habilitou.
// ---------------------------------------------------------------------------
const DEP_ATALHOS = [1000, 2000, 3000, 5000, 10000, 20000, 30000, 50000, 100000, 200000];
const DEP_PADRAO = 5000;   // R$ 50 já vem preenchido

function depositModal() {
  const min = WALLET.deposito.min, max = WALLET.deposito.max;
  const meios = WALLET.methods || {};
  const salvo = WALLET.savedCard || {};
  const auto = WALLET.autoTopup || {};
  const faixa = `Mínimo ${fmtBRL(min)}${max ? ' · máximo ' + fmtBRL(max) : ''}`;
  const atalhos = DEP_ATALHOS.filter(v => v >= min && (!max || v <= max));
  const inicial = Math.min(Math.max(DEP_PADRAO, min), max || DEP_PADRAO);

  openModal(`
    <h2>${ico('plus')} Depositar na carteira</h2>
    <p class="muted" style="font-size:12.5px;margin:-4px 0 0">
      O saldo paga assinatura, conexões extras e disparos. <b>${faixa}</b>
    </p>

    <label>Valor (R$)<input id="dep-val" inputmode="decimal" value="${(inicial / 100).toFixed(2)}" autocomplete="off"></label>
    <div class="dep-chips">
      ${atalhos.map(v => `<button type="button" class="dep-chip" onclick="depSet(${v})">${fmtBRL(v)}</button>`).join('')}
    </div>

    ${meios.credit ? `
    <label style="margin-bottom:-3px">Como pagar</label>
    <div class="pay-methods compact">
      <label class="pay-method">
        <input type="radio" name="depm" value="pix" checked onchange="depMeio()">
        <span class="pay-ic">${ico('pix', 17)}</span>
        <span><b>Pix</b><em>QR na tela, cai em segundos</em></span>
      </label>
      <label class="pay-method">
        <input type="radio" name="depm" value="card" onchange="depMeio()">
        <span class="pay-ic">${ico('card', 17)}</span>
        <span><b>Cartão de crédito</b><em>${salvo.reusable ? esc((salvo.brand || 'Cartão') + ' •••• ' + salvo.last4) + ', em um clique' : 'Crédito na hora'}</em></span>
      </label>
    </div>` : ''}

    ${autoBoxHtml(auto, meios, salvo, min)}

    <div class="row">
      <button class="btn no-grow" onclick="closeModal()">Cancelar</button>
      <button class="btn primary no-grow" id="dep-go" onclick="doDeposit(this)">${ico('pix', 14)} Gerar Pix</button>
    </div>
    <div id="dep-pix"></div>`, 'modal-dep');
}

function depSet(cents) {
  const el = $('#dep-val'); if (!el) return;
  el.value = (cents / 100).toFixed(2);
  $$('.dep-chip').forEach(b => b.classList.toggle('on', b.textContent.trim() === fmtBRL(cents)));
}

function depMeioEscolhido() {
  const r = document.querySelector('input[name="depm"]:checked');
  return r ? r.value : 'pix';
}

// O rótulo do botão muda com o meio: "Gerar Pix" e "Pagar no cartão" descrevem
// ações bem diferentes, e o cliente precisa saber qual vai acontecer.
function depMeio() {
  const b = $('#dep-go'); if (!b) return;
  b.innerHTML = depMeioEscolhido() === 'card'
    ? ico('card', 14) + ' Pagar no cartão'
    : ico('pix', 14) + ' Gerar Pix';
}

// ---------------------------------------------------------------------------
// RECARGA AUTOMÁTICA
//
// Ficar sem saldo no meio de uma campanha é o pior momento possível. Com isto
// ligado, o saldo se repõe sozinho ao cruzar um piso: no Pix pela assinatura da
// Woovi (Pix Automático), que o cliente autoriza uma vez no banco; no cartão
// pelo cartão salvo da fatura, cobrado como assinatura.
// ---------------------------------------------------------------------------
function autoBoxHtml(auto, meios, salvo, min) {
  const on = !!auto.enabled;
  return `
    <div class="auto-topup ${on ? 'on' : ''}" id="auto-box">
      <label class="chk auto-head">
        <input type="checkbox" id="auto-on" ${on ? 'checked' : ''} onchange="autoToggle()">
        <span><b>Recarga automática</b>
          <em>Repõe o saldo sozinho quando ele ficar baixo.</em></span>
      </label>
      <div id="auto-cfg" ${on ? '' : 'hidden'}>
        <div class="row" style="gap:8px;margin-top:10px">
          <label style="flex:1">Quando o saldo ficar abaixo de
            <input id="auto-thr" inputmode="decimal" value="${((auto.threshold || 2000) / 100).toFixed(2)}"></label>
          <label style="flex:1">Recarregar
            <input id="auto-amt" inputmode="decimal" value="${((auto.amount || 5000) / 100).toFixed(2)}"></label>
        </div>
        <label style="margin-top:8px;margin-bottom:6px">Cobrar em</label>
        <div class="pay-methods compact">
          <label class="pay-method">
            <input type="radio" name="autom" value="pix" ${auto.method !== 'card' ? 'checked' : ''}>
            <span class="pay-ic">${ico('pix', 17)}</span>
            <span><b>Pix Automático</b><em>Você autoriza uma vez no seu banco e a cobrança passa a ser automática</em></span>
          </label>
          <label class="pay-method ${meios.credit && salvo.reusable ? '' : 'off'}">
            <input type="radio" name="autom" value="card" ${auto.method === 'card' ? 'checked' : ''}
                   ${meios.credit && salvo.reusable ? '' : 'disabled'}>
            <span class="pay-ic">${ico('card', 17)}</span>
            <span><b>Cartão de crédito</b><em>${meios.credit && salvo.reusable
              ? esc((salvo.brand || 'Cartão') + ' •••• ' + salvo.last4) + ', cobrado como assinatura'
              : 'Pague uma vez no cartão para salvá-lo e liberar esta opção'}</em></span>
          </label>
        </div>
        ${auto.lastError ? `<p class="hint" style="color:var(--red);text-align:left;margin-top:8px">${esc(auto.lastError)}</p>` : ''}
        <div class="row" style="margin-top:10px">
          <button class="btn small no-grow" onclick="autoSave(this)">${ico('save', 13)} Salvar recarga automática</button>
        </div>
        <div id="auto-out"></div>
      </div>
    </div>`;
}

function autoToggle() {
  const on = $('#auto-on').checked;
  const cfg = $('#auto-cfg');
  const box = $('#auto-box');
  if (cfg) cfg.hidden = !on;
  if (box) box.classList.toggle('on', on);
  if (!on) autoSave(null, true);   // desmarcou: desliga na hora
}

const centavos = v => Math.round(Number(String(v || '').replace(',', '.')) * 100);

async function autoSave(btn, desligando) {
  const corpo = desligando
    ? { enabled: false }
    : {
      enabled: true,
      method: (document.querySelector('input[name="autom"]:checked') || {}).value || 'pix',
      threshold: centavos($('#auto-thr').value),
      amount: centavos($('#auto-amt').value)
    };
  const txt = btn && btn.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
  try {
    const r = await api('/wallet/auto-topup', { method: 'PUT', body: corpo });
    WALLET.autoTopup = r.autoTopup;
    // Pix Automático: o cliente ainda precisa autorizar o débito no banco dele.
    const out = $('#auto-out');
    if (out && r.subscription && (r.subscription.brCode || r.subscription.paymentLinkUrl)) {
      out.innerHTML = payBoxHtml(r.subscription);
    } else if (out) out.innerHTML = '';
    toast(desligando ? 'Recarga automática desligada' : 'Recarga automática ligada');
  } catch (e) {
    toast(e.message, 'error');
    if (!desligando && $('#auto-on')) $('#auto-on').checked = false;
  } finally { if (btn) { btn.disabled = false; btn.innerHTML = txt; } }
}

async function doDeposit(btn) {
  const bruto = String($('#dep-val').value || '').replace(',', '.');
  const cents = Math.round(Number(bruto) * 100);
  if (!cents || cents < 0) return toast('Informe um valor', 'error');
  if (cents < WALLET.deposito.min) return toast(`Depósito mínimo: ${fmtBRL(WALLET.deposito.min)}`, 'error');
  if (WALLET.deposito.max && cents > WALLET.deposito.max) {
    return toast(`Depósito máximo: ${fmtBRL(WALLET.deposito.max)}`, 'error');
  }

  const meio = depMeioEscolhido();
  const txt = btn.innerHTML;
  btn.disabled = true;

  // CARTÃO: sem cartão salvo, o formulário do cartão assume daqui.
  if (meio === 'card') {
    btn.disabled = false;
    closeModal();
    return openCardPay('topup', 'wallet', cents, 1);
  }

  try {
    const r = await api('/billing/topup', { body: { amount: bruto } });
    // Mostra o Pix na própria janela: fechar e procurar a tela de Assinatura
    // no meio do pagamento é o caminho mais curto para desistir.
    $('#dep-pix').innerHTML = payBoxHtml(r.charge);
    toast('Pix gerado, pague para creditar o saldo');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = txt;
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
  refreshWallet();   // saldo do topo acompanha a troca de layout/conta
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
  // O MÓDULO DE PAGAMENTOS SE CHAMAVA OUTRA COISA, e endereços antigos ainda
  // chegam: notificações push já entregues carregam `#/elitepay` no payload,
  // e há favoritos e abas abertas desde antes. `replace` para não empilhar no
  // histórico — senão "voltar" fica preso alternando entre os dois endereços.
  if (/^#\/elitepay(\/|\?|$)/.test(location.hash || '')) {
    location.replace(location.hash.replace('#/elitepay', '#/pagamentos'));
    return;
  }
  // O PAINEL DA PLATAFORMA NÃO ABRE AQUI. Ele é outro endereço, com outra
  // sessão: /adm/. Endereços antigos (#/admin, e as abas #/adm/...) ainda
  // chegam por favorito e por notificação já entregue, então em vez de cair
  // no dashboard sem explicação, atravessam para o painel de verdade.
  const pedida = (location.hash || '').replace('#/', '').split('?')[0];
  if (!ADM && ehRotaDoAdmin(pedida)) {
    // Quem administra a plataforma atravessa para o painel de verdade, na aba
    // que pediu. Quem é cliente vai para a casa dele: mandá-lo para /adm/ o
    // deixaria numa tela de login que ele não tem como passar.
    if (state.kind === 'admin') location.replace('/adm/#/' + (admAbaDaRota() ? pedida : 'adm/visao'));
    else location.hash = '#/' + VIEW_PADRAO;
    return;
  }
  // O FUNIL NÃO ABRE NO CELULAR, nem por link direto. Tirar do menu não basta:
  // o endereço continua guardado em favorito e no histórico de quem já usou no
  // computador, e a tela que abriria é um quadro de arrastar sem como arrastar.
  // Aqui a pessoa fica sabendo POR QUÊ, em vez de bater num destino que some.
  if (isMobileLayout() && pedida === 'funnel') {
    toast('O funil é um quadro de arrastar: abra no computador.');
    location.hash = '#/' + VIEW_PADRAO;
    return;
  }
  if (window._fbMove) cleanupBuilder();  // sai do canvas do Flow Builder
  // o hash pode trazer query (#/pagamentos/checkout?c=<id>) — ela NÃO faz parte
  // do nome da view; sem separar, a rota não é encontrada e cai no dashboard.
  const v = ((location.hash || '#/' + VIEW_PADRAO).replace('#/', '') || VIEW_PADRAO).split('?')[0];
  let target = views[v] ? v : VIEW_PADRAO;
  // guard de PLANO: digitar a URL de um módulo fora do plano não entra
  // (o backend também recusa com 402; aqui é só para não abrir uma tela vazia)
    // Sem plano, qualquer destino cai em Assinatura: é o único lugar que
    // resolve a situação.
    if (precisaAssinar() && !VIEWS_SEM_PLANO.includes(target.split('/')[0])) {
      location.hash = '#/billing';
      return;
    }
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
  // O Checkout Builder é uma página FOCADA: esconde a sidebar e o topo do app
  const appEl = document.getElementById('app');
  if (appEl) appEl.classList.toggle('builder-mode', target === 'pagamentos/checkout');
  const navKey = NAV_OF[state.view] || state.view;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === navKey));
  updateTopbar();
  views[state.view]();
}

// ===========================================================================
// PAINEL DA PLATAFORMA (/adm/)
//
// O Admin sabia de dinheiro e não sabia de OPERAÇÃO. Estas telas mostram o
// que está acontecendo em todas as contas: quantos contatos existem, quem
// são, quem atende e onde o movimento está. Tudo por leitura: nada é
// copiado, e o dado continua na conta de origem.
// ===========================================================================

// Cartão de número grande, o mesmo desenho do topo de Pagamentos.
function admCartao(icone, valor, rotulo, destaque) {
  return `<div class="mh-card ${destaque ? 'hi' : ''}"><span class="mh-ic">${ico(icone, 20)}</span>` +
    `<div class="mh-val">${valor}</div><div class="mh-lbl">${esc(rotulo)}</div></div>`;
}

async function renderAdmVisao() {
  $('#view').innerHTML = `<div class="page"><div class="page-head"><h1>Visão geral da operação</h1>` +
    `<p class="muted">Tudo o que acontece em todas as contas, somado.</p></div>` + skel(4) + `</div>`;
  try {
    const d = await api('/adm/overview');
    const t = d.totais;
    $('#view').innerHTML = `<div class="page">
      <div class="page-head">
        <h1>Visão geral da operação</h1>
        <p class="muted">Tudo o que acontece em todas as contas, somado.</p>
      </div>
      <div class="metric-hero">
        ${admCartao('users', fmtN(t.contatos), 'Contatos em todas as contas', true)}
        ${admCartao('message', fmtN(t.conversasAbertas), 'Conversas nas últimas 24h')}
        ${admCartao('send', fmtN(t.msg24h), 'Mensagens nas últimas 24h')}
        ${admCartao('briefcase', fmtN(t.clientes), 'Contas de clientes')}
        ${admCartao('sparkles', fmtN(t.supercontas), 'Supercontas')}
        ${admCartao('headset', fmtN(t.pessoas), 'Pessoas com acesso')}
      </div>
      <div class="card">
        <h2>${ico('activity')} Onde a operação está</h2>
        <p class="muted" style="margin:0 0 12px;font-size:13px">Contas ordenadas pelo movimento dos últimos 7 dias.</p>
        <div class="tab-mob-wrap" style="overflow-x:auto"><table class="tab-mob"><thead><tr>
          <th>Conta</th><th>Plano</th><th style="text-align:right">Contatos</th>
          <th style="text-align:right">Mensagens 7d</th><th style="text-align:right">Pessoas</th><th>WhatsApp</th>
        </tr></thead><tbody>
        ${d.ranking.map(a => `<tr>
          <td><b>${esc(a.nome)}</b><div class="muted" style="font-size:11.5px">${esc(a.email)}</div></td>
          <td data-r="Plano">${a.super ? '<span class="pill done">Superconta</span>' : esc(a.plano)}</td>
          <td data-r="Contatos" style="text-align:right">${fmtN(a.contatos)}</td>
          <td data-r="Mensagens 7d" style="text-align:right"><b>${fmtN(a.mensagens7d)}</b></td>
          <td data-r="Pessoas" style="text-align:right">${fmtN(a.pessoas)}</td>
          <td data-r="WhatsApp">${a.conectado ? '<span class="pill done">conectado</span>' : '<span class="muted">fora do ar</span>'}</td>
        </tr>`).join('')}
        </tbody></table></div>
        ${d.ranking.length ? '' : '<p class="muted">Nenhuma conta ainda.</p>'}
      </div></div>`;
  } catch (e) { $('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// TODOS OS CONTATOS. A busca e o filtro por conta vão para o servidor: somar
// as bases de todos os clientes não cabe numa resposta só.
let ADM_CT = { q: '', conta: '', pagina: 0 };
async function renderAdmContatos() {
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Contatos</h1>
      <p class="muted">De todas as contas, com o cliente ao lado.</p></div>
    <div class="card"><div class="row" style="align-items:flex-end">
      <label style="flex:2">Buscar<input id="admct-q" placeholder="nome, telefone ou e-mail" value="${esc(ADM_CT.q)}"></label>
      <button class="btn primary no-grow" onclick="admCtBuscar()">Buscar</button>
    </div></div>
    <div id="admct-box">${skel(4)}</div></div>`;
  const inp = document.getElementById('admct-q');
  if (inp) inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') admCtBuscar(); });
  admCtCarregar();
}
function admCtBuscar() {
  ADM_CT.q = ($('#admct-q') || {}).value || '';
  ADM_CT.pagina = 0;
  admCtCarregar();
}
function admCtPagina(n) { ADM_CT.pagina = Math.max(0, n); admCtCarregar(); }
async function admCtCarregar() {
  const box = document.getElementById('admct-box'); if (!box) return;
  const porPagina = 100;
  try {
    const q = new URLSearchParams({
      q: ADM_CT.q, accountId: ADM_CT.conta,
      limit: String(porPagina), offset: String(ADM_CT.pagina * porPagina)
    });
    const d = await api('/adm/contacts?' + q.toString());
    const ini = ADM_CT.pagina * porPagina;
    box.innerHTML = `<div class="card">
      <h2>${ico('users')} ${fmtN(d.total)} contato(s)</h2>
      <div class="tab-mob-wrap" style="overflow-x:auto"><table class="tab-mob"><thead><tr>
        <th>Contato</th><th>Conta</th><th>Etapa</th><th>Última mensagem</th>
      </tr></thead><tbody>
      ${d.itens.map(c => `<tr>
        <td><b>${esc(c.nome || 'sem nome')}</b><div class="muted" style="font-size:11.5px">+${esc(c.waId)}${c.email ? ' · ' + esc(c.email) : ''}</div></td>
        <td data-r="Conta">${esc(c.conta)}${c.super ? ' <span class="pill done">Super</span>' : ''}</td>
        <td data-r="Etapa">${c.etapa ? esc(c.etapa) : '<span class="muted">-</span>'}${c.optOut ? ' <span class="pill">opt-out</span>' : ''}</td>
        <td data-r="Última mensagem">${c.ultimaMensagem ? timeAgo(c.ultimaMensagem) : '<span class="muted">nunca</span>'}</td>
      </tr>`).join('')}
      </tbody></table></div>
      ${d.total ? '' : '<p class="muted">Nenhum contato encontrado.</p>'}
      ${d.total > porPagina ? `<div class="row" style="margin-top:14px;justify-content:space-between;align-items:center">
        <span class="muted" style="font-size:12.5px">${fmtN(ini + 1)} a ${fmtN(Math.min(ini + porPagina, d.total))} de ${fmtN(d.total)}</span>
        <span>
          <button class="btn small no-grow" ${ADM_CT.pagina ? '' : 'disabled'} onclick="admCtPagina(${ADM_CT.pagina - 1})">Anterior</button>
          <button class="btn small no-grow" ${ini + porPagina >= d.total ? 'disabled' : ''} onclick="admCtPagina(${ADM_CT.pagina + 1})">Próxima</button>
        </span>
      </div>` : ''}
    </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// TODA A GENTE: donos e atendentes, de todas as contas.
async function renderAdmUsuarios() {
  $('#view').innerHTML = `<div class="page"><div class="page-head"><h1>Usuários</h1>` +
    `<p class="muted">Todo mundo que entra no sistema: titulares e atendentes.</p></div>` + skel(4) + `</div>`;
  try {
    const d = await api('/adm/users');
    $('#view').innerHTML = `<div class="page">
      <div class="page-head"><h1>Usuários</h1>
        <p class="muted">Todo mundo que entra no sistema: titulares e atendentes.</p></div>
      <div class="card">
        <h2>${ico('headset')} ${fmtN(d.total)} pessoa(s)</h2>
        <div class="tab-mob-wrap" style="overflow-x:auto"><table class="tab-mob"><thead><tr>
          <th>Pessoa</th><th>Conta</th><th>Papel</th><th>Último acesso</th>
        </tr></thead><tbody>
        ${d.itens.map(u => `<tr>
          <td><b>${esc(u.nome)}</b><div class="muted" style="font-size:11.5px">${esc(u.email)}</div></td>
          <td data-r="Conta">${esc(u.conta)}${u.super ? ' <span class="pill done">Super</span>' : ''}</td>
          <td data-r="Papel">${esc(u.papel)}${u.ativo ? '' : ' <span class="pill">inativo</span>'}</td>
          <td data-r="Último acesso">${u.ultimoAcesso ? timeAgo(u.ultimoAcesso) : '<span class="muted">nunca entrou</span>'}</td>
        </tr>`).join('')}
        </tbody></table></div>
        ${d.total ? '' : '<p class="muted">Nenhum usuário ainda.</p>'}
      </div></div>`;
  } catch (e) { $('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// SUPERCONTAS — as contas dos negócios do próprio dono.
//
// São contas comuns em tudo, menos em três coisas: rodam sem plano, sem
// teto de uso e sem cobrança, e ficam fora das métricas de clientes (contar
// uma conta que não paga como assinante inflaria MRR e conversão).
async function renderAdmSupers() {
  $('#view').innerHTML = `<div class="page"><div class="page-head"><h1>Supercontas</h1>` +
    `<p class="muted">As contas dos seus próprios negócios.</p></div>` + skel(3) + `</div>`;
  try {
    const d = await api('/adm/supers');
    $('#view').innerHTML = `<div class="page">
      <div class="page-head"><h1>Supercontas</h1>
        <p class="muted">As contas dos seus próprios negócios, uma por empresa.</p></div>
      <div class="card">
        <h2>${ico('plus')} Criar uma Superconta</h2>
        <p class="muted" style="margin:0 0 14px;font-size:13px">
          Conta completa e sem limites: todos os recursos liberados, sem plano, sem cobrança e fora das
          métricas de clientes. Você entra nela pelo <b>painel do cliente</b>, em <code>/app/</code>, com o
          e-mail e a senha definidos aqui.
        </p>
        <div class="row" style="align-items:flex-end">
          <label style="flex:1.2">Nome da empresa<input id="sup-nome" placeholder="Minha outra empresa"></label>
          <label style="flex:1.2">E-mail de acesso<input id="sup-email" placeholder="voce@empresa.com"></label>
          <label style="flex:1">Senha<input id="sup-senha" type="password" placeholder="mínimo 6 caracteres"></label>
          <button class="btn primary no-grow" onclick="admSuperCriar(this)">${ico('plus', 14)} Criar</button>
        </div>
      </div>
      <div class="card">
        <h2>${ico('sparkles')} ${fmtN(d.itens.length)} Superconta(s)</h2>
        ${d.itens.length ? `<div class="tab-mob-wrap" style="overflow-x:auto"><table class="tab-mob"><thead><tr>
          <th>Empresa</th><th style="text-align:right">Contatos</th><th style="text-align:right">Pessoas</th>
          <th>WhatsApp</th><th>Criada</th><th></th>
        </tr></thead><tbody>
        ${d.itens.map(a => `<tr>
          <td><b>${esc(a.nome)}</b><div class="muted" style="font-size:11.5px">${esc(a.email)}</div></td>
          <td data-r="Contatos" style="text-align:right">${fmtN(a.contatos)}</td>
          <td data-r="Pessoas" style="text-align:right">${fmtN(a.pessoas)}</td>
          <td data-r="WhatsApp">${a.conectado ? '<span class="pill done">conectado</span>' : '<span class="muted">fora do ar</span>'}</td>
          <td data-r="Criada">${timeAgo(a.criadaEm)}</td>
          <td style="text-align:right"><button class="btn small" onclick="admSuperDesligar('${a.id}')">Virar conta comum</button></td>
        </tr>`).join('')}
        </tbody></table></div>` : '<p class="muted">Nenhuma Superconta ainda. Crie a primeira acima.</p>'}
      </div></div>`;
  } catch (e) { $('#view').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function admSuperCriar(btn) {
  const nome = ($('#sup-nome') || {}).value || '';
  const email = ($('#sup-email') || {}).value || '';
  const senha = ($('#sup-senha') || {}).value || '';
  const txt = btn.innerHTML; btn.disabled = true;
  try {
    await api('/adm/supers', { body: { name: nome, email, pass: senha } });
    toast('Superconta criada');
    renderAdmSupers();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

async function admSuperDesligar(id) {
  if (!await confirmModal({
    title: 'Virar conta comum?',
    text: 'A conta passa a ter plano, teto de uso e cobrança, e volta a contar nas métricas de clientes. Os dados dela não mudam.',
    ok: 'Virar conta comum'
  })) return;
  try {
    await api('/admin/accounts/' + id + '/unlimited', { method: 'PUT', body: { unlimited: false } });
    toast('Agora é uma conta comum');
    renderAdmSupers();
  } catch (e) { toast(e.message, 'error'); }
}

// ===========================================================================
// LOJA NUVEMSHOP
//
// Pedidos, carrinhos abandonados e a base de clientes da loja, lidos da API
// na hora. Nada é copiado para o banco: pedido muda de status o tempo todo,
// e uma cópia velha dizendo "pago" sobre um pedido cancelado é pior do que
// não mostrar nada.
// ===========================================================================
let NS_TAB = 'pedidos';

// Link de parceiro da Nuvemshop. Quem chega na aba sem loja pode não ter loja
// NENHUMA, e para essa pessoa "conectar" não quer dizer nada: ela precisa
// primeiro abrir a dela.
const NS_AFILIADO = 'https://www.nuvemshop.com.br/partners/52795162-kaio-caglioni-de-oliveira';

async function renderNuvemshop() {
  // Chegando aqui sem loja (link antigo, endereço digitado), o lugar certo é
  // Integrações: é lá que se conecta.
  if (!state.nsConectada) {
    $('#view').innerHTML = `<div class="page">
      <div class="page-head"><h1>Nuvemshop</h1>
        <p class="muted">Conecte a sua loja para ver pedidos e recuperar carrinhos.</p></div>
      <div class="card">
        <h2>${logoInt('nuvemshop', 20)} Nenhuma loja conectada</h2>
        <p class="muted" style="margin:0 0 14px;font-size:13px">
          Depois de conectar, esta aba mostra os pedidos, os carrinhos abandonados e a base da loja.
          O menu passa a trazer a Nuvemshop sozinho.
        </p>
        <div class="row">
          <a class="btn primary no-grow" href="#/integrations">Conectar minha loja</a>
        </div>
      </div>

      <div class="card">
        <h2>${logoInt('nuvemshop', 20)} Ainda não tem loja na Nuvemshop?</h2>
        <p class="muted" style="margin:0 0 14px;font-size:13px">
          Crie a sua e volte aqui para conectar. É a plataforma de loja virtual que o Koonfy integra:
          os pedidos, os carrinhos e a base de clientes passam a chegar direto no seu WhatsApp.
        </p>
        <div class="row">
          <a class="btn no-grow" href="${NS_AFILIADO}" target="_blank" rel="noopener">${ico('globe', 14)} Criar minha loja na Nuvemshop</a>
        </div>
      </div></div>`;
    return;
  }
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Nuvemshop</h1>
      <p class="muted">Pedidos, carrinhos e a base da sua loja.</p></div>
    <div id="ns-topo">${skel(2)}</div>
    <div class="tabs">
      <button class="${NS_TAB === 'pedidos' ? 'active' : ''}" onclick="nsAba('pedidos')">Pedidos</button>
      <button class="${NS_TAB === 'carrinhos' ? 'active' : ''}" onclick="nsAba('carrinhos')">Carrinhos abandonados</button>
      <button class="${NS_TAB === 'clientes' ? 'active' : ''}" onclick="nsAba('clientes')">Clientes</button>
    </div>
    <div id="ns-box">${skel(4)}</div>
  </div>`;
  nsTopo();
  nsCarregar();
}

function nsAba(t) {
  NS_TAB = t;
  $$('#view .tabs button').forEach((b, i) => b.classList.toggle('active', ['pedidos', 'carrinhos', 'clientes'][i] === t));
  nsCarregar();
}

async function nsTopo() {
  const box = document.getElementById('ns-topo'); if (!box) return;
  try {
    const d = await api('/nuvemshop/summary');
    if (!d.conectada) {
      box.innerHTML = `<div class="card"><h2>${ico('cart')} Loja não conectada</h2>
        <p class="muted" style="margin:0 0 12px;font-size:13px">Conecte a sua Nuvemshop para ver pedidos, recuperar carrinhos e falar com a sua base pelo WhatsApp.</p>
        <a class="btn primary no-grow" href="#/integrations">Conectar minha loja</a></div>`;
      return;
    }
    box.innerHTML = `<div class="metric-hero">
      ${admCartao('cart', fmtN(d.pedidos30d), 'Pedidos em 30 dias', true)}
      ${admCartao('check-circle', fmtN(d.pagos30d), 'Pagos em 30 dias')}
      ${admCartao('pix', d.receita30d, 'Receita em 30 dias')}
      ${admCartao('clock', fmtN(d.carrinhosAbertos), 'Carrinhos em aberto')}
      ${admCartao('users', fmtN(d.contatosDaLoja), 'Contatos vindos da loja')}
    </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

function nsCarregar() {
  if (NS_TAB === 'pedidos') return nsPedidos();
  if (NS_TAB === 'carrinhos') return nsCarrinhos();
  return nsClientes();
}

// Cada status ganha a cor que ele merece: pago é bom, cancelado é ruim, o
// resto é neutro. Sem isso a tabela é uma parede de texto cinza.
const NS_PILL = {
  paid: ['pago', 'done'], pending: ['pendente', 'pending'], abandoned: ['abandonado', ''],
  authorized: ['autorizado', 'done'], refunded: ['estornado', ''], voided: ['estornado', ''],
  open: ['aberto', 'pending'], closed: ['fechado', 'done'], cancelled: ['cancelado', ''],
  unpacked: ['a embalar', 'pending'], unfulfilled: ['a enviar', 'pending'],
  fulfilled: ['enviado', 'done'], shipped: ['enviado', 'done']
};
function nsPill(v) {
  const m = NS_PILL[String(v || '').toLowerCase()];
  if (!m) return v ? `<span class="pill">${esc(v)}</span>` : '<span class="muted">-</span>';
  return `<span class="pill ${m[1]}">${m[0]}</span>`;
}

async function nsPedidos() {
  const box = document.getElementById('ns-box'); if (!box) return;
  box.innerHTML = skel(4);
  try {
    const d = await api('/nuvemshop/orders?limit=30');
    box.innerHTML = `<div class="card">
      <h2>${ico('cart')} Últimos pedidos</h2>
      ${d.itens.length ? `<div class="tab-mob-wrap" style="overflow-x:auto"><table class="tab-mob"><thead><tr>
        <th>Pedido</th><th>Pagamento</th><th>Envio</th><th style="text-align:right">Total</th><th>Quando</th><th></th>
      </tr></thead><tbody>
      ${d.itens.map(o => `<tr>
        <td><b>#${esc(String(o.numero))} · ${esc(o.cliente || 'sem nome')}</b>
          <div class="muted" style="font-size:11.5px">${esc(o.itens.map(i => i.qtd + 'x ' + i.nome).join(', ').slice(0, 70))}</div></td>
        <td data-r="Pagamento">${nsPill(o.pagamento)}</td>
        <td data-r="Envio">${nsPill(o.envio)}</td>
        <td data-r="Total" style="text-align:right"><b>${esc(o.total)}</b></td>
        <td data-r="Quando">${timeAgo(Date.parse(o.criadoEm))}</td>
        <td style="text-align:right">${o.telefone ? `<button class="btn small" onclick="nsFalar('${esc(o.telefone)}')">${ico('message', 13)} Falar</button>` : ''}</td>
      </tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Nenhum pedido ainda.</p>'}
    </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

// Abre a conversa com quem comprou. Se o contato ainda não existe no Koonfy,
// a inbox cria na hora — é o mesmo caminho de quem chega por qualquer canal.
function nsFalar(telefone) {
  const wa = String(telefone).replace(/\D/g, '');
  if (!wa) return toast('Este pedido não tem telefone', 'error');
  location.hash = '#/inbox';
  setTimeout(() => openChat(wa), 300);
}

async function nsCarrinhos() {
  const box = document.getElementById('ns-box'); if (!box) return;
  box.innerHTML = skel(4);
  try {
    const d = await api('/nuvemshop/carts');
    const c = d.carrinho || { ligado: false, minutos: 60 };
    box.innerHTML = `<div class="card">
      <h2>${ico('refresh')} Recuperação automática</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        A Nuvemshop não avisa quando alguém abandona o carrinho, então o Koonfy consulta a loja de 5 em 5 minutos.
        Um carrinho parado há mais tempo que o escolhido aciona a automação com o gatilho
        <b>Loja Nuvemshop → Carrinho abandonado</b>. Cada carrinho é avisado <b>uma vez só</b>.
      </p>
      <div class="row" style="align-items:flex-end">
        <label class="chk" style="flex:1.4"><input type="checkbox" ${c.ligado ? 'checked' : ''} onchange="nsCarrinhoSalvar({ligado:this.checked})">
          <span><b>Recuperar carrinhos</b><em>Precisa de uma automação com esse gatilho, senão não há o que enviar.</em></span></label>
        <label style="max-width:200px">Esperar (minutos)
          <input id="ns-min" inputmode="numeric" value="${esc(String(c.minutos || 60))}"></label>
        <button class="btn no-grow" onclick="nsCarrinhoSalvar({minutos: ($('#ns-min')||{}).value})">${ico('save', 14)} Salvar</button>
        <button class="btn no-grow" onclick="nsVarrer(this)">${ico('refresh', 14)} Varrer agora</button>
      </div>
      <p class="hint" style="margin-top:10px">${d.ultimaVarredura ? 'Última varredura ' + timeAgo(d.ultimaVarredura) + '.' : 'Ainda não varreu.'}</p>
    </div>

    <div class="card">
      <h2>${ico('clock')} Carrinhos em aberto</h2>
      ${d.itens.length ? `<div class="tab-mob-wrap" style="overflow-x:auto"><table class="tab-mob"><thead><tr>
        <th>Cliente</th><th style="text-align:right">Total</th><th>Parado há</th><th>Aviso</th><th></th>
      </tr></thead><tbody>
      ${d.itens.map(x => `<tr>
        <td><b>${esc(x.cliente || 'sem nome')}</b>
          <div class="muted" style="font-size:11.5px">${esc(x.telefone || 'sem telefone')} · ${esc(x.itens.map(i => i.qtd + 'x ' + i.nome).join(', ').slice(0, 60))}</div></td>
        <td data-r="Total" style="text-align:right"><b>${esc(x.total)}</b></td>
        <td data-r="Parado há">${timeAgo(Date.parse(x.atualizadoEm || x.criadoEm))}</td>
        <td data-r="Aviso">${x.avisado ? '<span class="pill done">enviado</span>' : '<span class="muted">não enviado</span>'}</td>
        <td style="text-align:right">${x.telefone ? `<button class="btn small" onclick="nsFalar('${esc(x.telefone)}')">${ico('message', 13)} Falar</button>` : ''}</td>
      </tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Nenhum carrinho em aberto. Eles aparecem aqui enquanto o cliente não termina a compra.</p>'}
    </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function nsCarrinhoSalvar(corpo) {
  try {
    await api('/nuvemshop/carrinho', { method: 'PUT', body: corpo });
    toast('Salvo');
    if (corpo.minutos === undefined) nsCarrinhos();
  } catch (e) { toast(e.message, 'error'); }
}

async function nsVarrer(btn) {
  const txt = btn.innerHTML; btn.disabled = true;
  try {
    const r = await api('/nuvemshop/carrinho/varrer', { body: {} });
    // Três respostas diferentes, porque são três situações diferentes: não há
    // automação, não há carrinho no ponto, ou saiu mensagem.
    toast(r.motivo === 'sem_automacao'
      ? 'Crie uma automação com o gatilho Loja Nuvemshop, Carrinho abandonado. Sem ela não há o que enviar.'
      : r.avisados ? `${r.avisados} carrinho(s) entraram na automação` : 'Nenhum carrinho no ponto ainda',
      r.motivo === 'sem_automacao' ? 'error' : 'ok');
    nsCarrinhos();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

async function nsClientes() {
  const box = document.getElementById('ns-box'); if (!box) return;
  box.innerHTML = skel(4);
  try {
    const d = await api('/nuvemshop/customers?limit=50');
    const fora = d.itens.filter(x => x.waId && !x.noKoonfy).length;
    box.innerHTML = `<div class="card">
      <h2>${ico('users')} Trazer a base para o Koonfy</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        Cria um contato para cada cliente da loja que tenha telefone, marcado como <b>vindo da Nuvemshop</b>.
        É o que permite disparar campanha só para eles, em <b>Campanhas → Público</b>.
        Quem já existe é atualizado, não duplicado.
      </p>
      <div class="row">
        <button class="btn primary no-grow" onclick="nsImportar(this)">${ico('download-circle', 14)} Importar clientes da loja</button>
      </div>
      ${fora ? `<p class="hint" style="margin-top:10px">${fora} cliente(s) desta página ainda não estão no Koonfy.</p>` : ''}
    </div>

    <div class="card">
      <h2>${ico('cart')} Clientes da loja</h2>
      ${(d.lgpd || []).length ? `<div class="capi-box" style="margin:0 0 16px">
        <div class="capi-head">${ico('shield', 14)} Pedidos de acesso aos dados (LGPD)
          <span class="capi-tag">${fmtN(d.lgpd.length)}</span></div>
        <p class="muted" style="font-size:12px;margin:8px 0 10px">
          Consumidores que pediram, pela Nuvemshop, para saber o que existe sobre eles. Quem responde é você:
          abaixo está o que o Koonfy tem guardado de cada um.
        </p>
        ${d.lgpd.map(x => `<div class="wh-meta" style="margin-top:8px">
          <span class="pill">${timeAgo(x.quando)}</span>
          <span class="pill">${esc(x.email || x.telefone || 'sem identificação')}</span>
          ${x.encontrado ? `<span class="pill done">${fmtN((x.dados || {}).mensagens || 0)} mensagem(ns) no Koonfy</span>`
            : '<span class="muted">nada encontrado aqui</span>'}
        </div>`).join('')}
      </div>` : ''}
      ${d.itens.length ? `<div class="tab-mob-wrap" style="overflow-x:auto"><table class="tab-mob"><thead><tr>
        <th>Cliente</th><th style="text-align:right">Pedidos</th><th style="text-align:right">Gasto</th><th>No Koonfy</th>
      </tr></thead><tbody>
      ${d.itens.map(x => `<tr>
        <td><b>${esc(x.nome || 'sem nome')}</b><div class="muted" style="font-size:11.5px">${esc(x.telefone || 'sem telefone')}${x.email ? ' · ' + esc(x.email) : ''}</div></td>
        <td data-r="Pedidos" style="text-align:right">${fmtN(x.pedidos)}</td>
        <td data-r="Gasto" style="text-align:right">${esc(x.gasto)}</td>
        <td data-r="No Koonfy">${x.noKoonfy ? '<span class="pill done">sim</span>' : (x.waId ? '<span class="muted">não</span>' : '<span class="pill">sem telefone</span>')}</td>
      </tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Nenhum cliente cadastrado na loja ainda.</p>'}
    </div>`;
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function nsImportar(btn) {
  if (!await confirmModal({
    title: 'Importar a base da loja?',
    text: 'Cada cliente com telefone vira um contato no Koonfy, marcado como vindo da Nuvemshop. Quem já existe é atualizado, não duplicado.',
    ok: 'Importar'
  })) return;
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Importando…';
  try {
    const r = await api('/nuvemshop/import', { body: {} });
    toast(`${r.criados} novo(s), ${r.atualizados} atualizado(s)` +
      (r.semTelefone ? ` · ${r.semTelefone} sem telefone ficaram de fora` : ''));
    nsClientes(); nsTopo();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

// ===========================================================================
// FICHA DA CONTA (painel da plataforma)
//
// Tudo o que existe sobre uma conta, num lugar só. O que a pessoa preencheu
// no cadastro estava guardado e não aparecia em tela nenhuma.
// ===========================================================================
function admLinha(rotulo, valor, destaque) {
  const v = valor === 0 || valor ? valor : '<span class="muted">-</span>';
  const cor = destaque ? ' style="color:var(--verde-deep)"' : '';
  return `<div class="wa-row"><span>${esc(rotulo)}</span><b${cor}>${v}</b></div>`;
}

async function admFicha(id, comDocumento) {
  try {
    const d = await api('/adm/accounts/' + id + (comDocumento ? '?doc=1' : ''));
    const c = d.cadastro, pf = d.perfil, as = d.assinatura, ca = d.carteira, u = d.uso;
    const dinheiro = v => fmtBRL(v || 0);
    openModal(`
      <h2>${ico('briefcase')} ${esc(c.nome)}</h2>
      <p class="muted" style="margin:2px 0 0;font-size:13px">${esc(c.email)} · ${esc(c.tipo)}</p>

      <div class="fb-sub" style="margin-top:16px">Cadastro</div>
      <div class="wa-status">
        ${admLinha('Criada em', new Date(c.criadaEm).toLocaleString('pt-BR'))}
        ${admLinha('Último acesso', c.ultimoAcesso ? timeAgo(c.ultimoAcesso) : null)}
        ${admLinha('ID interno', '<code>' + esc(c.id) + '</code>')}
      </div>

      <div class="fb-sub" style="margin-top:16px">A empresa</div>
      <div class="wa-status">
        ${admLinha(pf.documentoTipo || 'CPF / CNPJ', pf.documento ? esc(pf.documento) +
          (pf.documentoCompleto ? '' : ` <button class="btn small" style="margin-left:8px" onclick="admFicha('${id}', true)">Ver completo</button>`) : null)}
        ${admLinha('Segmento', pf.segmento ? esc(pf.segmento) : null)}
        ${admLinha('Colaboradores', pf.colaboradores ? esc(pf.colaboradores) : null)}
        ${admLinha('Telefone', pf.telefone ? esc(pf.telefone) : null)}
        ${admLinha('País', pf.pais ? esc(pf.pais) : null)}
        ${admLinha('O que quer resolver', pf.objetivo ? esc(pf.objetivo) : null)}
        ${admLinha('Chave Pix', pf.chavePix ? esc(pf.chavePix) + (pf.chavePixTipo ? ' (' + esc(pf.chavePixTipo) + ')' : '') : null)}
      </div>

      <div class="fb-sub" style="margin-top:16px">Assinatura</div>
      <div class="wa-status">
        ${admLinha('Situação', esc(as.status))}
        ${admLinha('Plano', as.plano ? esc(as.plano) + ' · ' + dinheiro(as.preco) : null)}
        ${admLinha('Expira em', as.expiraEm ? new Date(as.expiraEm).toLocaleDateString('pt-BR') : null)}
        ${admLinha('Cliente desde', as.comecouEm ? new Date(as.comecouEm).toLocaleDateString('pt-BR') : null)}
        ${admLinha('Meio de pagamento', as.meio ? esc(as.meio) + (as.cartao ? ' · ' + esc(as.cartao) : '') : null)}
      </div>

      <div class="fb-sub" style="margin-top:16px">Carteira</div>
      <div class="wa-status">
        ${admLinha('Saldo', dinheiro(ca.saldo), true)}
        ${admLinha('A liberar', dinheiro(ca.aLiberar))}
        ${admLinha('Movimentos', fmtN(ca.movimentos))}
      </div>

      <div class="fb-sub" style="margin-top:16px">Uso</div>
      <div class="wa-status">
        ${admLinha('Contatos', fmtN(u.contatos))}
        ${admLinha('Mensagens', fmtN(u.mensagens) + ' <span class="muted">(' + fmtN(u.mensagens30d) + ' em 30 dias)</span>')}
        ${admLinha('Campanhas', fmtN(u.campanhas))}
        ${admLinha('Automações', fmtN(u.automacoes))}
        ${admLinha('Agendamentos', fmtN(u.agendamentos))}
        ${admLinha('Atendentes', fmtN(u.atendentes))}
      </div>

      <div class="fb-sub" style="margin-top:16px">Conexões de WhatsApp</div>
      ${u.canais.length ? `<div class="wa-status">${u.canais.map(ch => admLinha(
        esc(ch.rotulo || 'sem nome'),
        (ch.numero ? esc(ch.numero) : '<span class="muted">sem número</span>') +
        (ch.conectado ? ' <span class="pill done">conectada</span>' : ' <span class="pill">fora do ar</span>')
      )).join('')}</div>` : '<p class="muted" style="font-size:13px">Nenhuma conexão.</p>'}

      <div class="fb-sub" style="margin-top:16px">Integrações e afiliação</div>
      <div class="wa-status">
        ${admLinha('Nuvemshop', d.integracoes.nuvemshop ? esc(d.integracoes.nuvemshop) : null)}
        ${admLinha('Webhooks', fmtN(d.integracoes.webhooks))}
        ${admLinha('Links rastreáveis', fmtN(d.integracoes.links))}
        ${admLinha('Código de indicação', '<code>' + esc(d.afiliacao.codigo) + '</code>')}
        ${admLinha('Indicado por', d.afiliacao.indicadoPor ? '<code>' + esc(d.afiliacao.indicadoPor) + '</code>' : null)}
        ${admLinha('Indicou', fmtN(d.afiliacao.indicados) + ' conta(s) · ' + dinheiro(d.afiliacao.ganhos))}
      </div>

      <div class="row" style="margin-top:18px;justify-content:flex-end">
        <button class="btn primary no-grow" onclick="closeModal()">Fechar</button>
      </div>`);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- dashboard ----------
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

// Mantido para links antigos que chamavam com um número de dias.
function setDashDays(n) { periodoSalvar({ dias: n }); renderDashboard(); }

// ===========================================================================
// PERÍODO DOS GRÁFICOS
//
// Antes eram quatro botões fixos (7/14/30/90 dias). Dava para ver "os últimos
// 30 dias", mas não "março", nem "2025", nem "de 12 a 19" — que é exatamente o
// que se pede na hora de fechar o mês.
//
// O seletor guarda o período escolhido em `state.periodo` e sobrevive ao
// recarregar. Os atalhos continuam ali porque são o uso de todo dia; o mês, o
// ano e o intervalo livre ficam a um clique.
// ===========================================================================
const MESES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// O PAINEL NASCE OLHANDO HOJE. Antes o padrão eram 14 dias, que é resposta de
// relatório: quem abre o painel de manhã quer saber do dia que está correndo.
function periodoAtual() {
  if (!state.periodo) {
    let salvo = null;
    try { salvo = JSON.parse(localStorage.getItem('ec_periodo') || 'null'); } catch {}
    state.periodo = salvo && (salvo.dias || (salvo.de && salvo.ate)) ? salvo : { dias: 1 };
  }
  return state.periodo;
}

function periodoSalvar(p) {
  state.periodo = p;
  try { localStorage.setItem('ec_periodo', JSON.stringify(p)); } catch {}
}

// Vira query string para a API. É o mesmo formato que `periodoDaQuery` lê no
// servidor: `de`/`ate` quando há intervalo, `days` quando é atalho.
function periodoQuery() {
  const p = periodoAtual();
  return p.de && p.ate ? `de=${p.de}&ate=${p.ate}` : `days=${p.dias || 14}`;
}

function periodoRotulo() {
  const p = periodoAtual();
  if (p.dias) return p.dias === 1 ? 'Hoje' : `${p.dias} dias`;
  const [a1, m1, d1] = p.de.split('-').map(Number);
  const [a2, m2, d2] = p.ate.split('-').map(Number);
  // Mês inteiro e ano inteiro ganham nome — "março de 2025" lê melhor que
  // "01/03/2025 a 31/03/2025".
  const ultimoDia = new Date(a1, m1, 0).getDate();
  if (a1 === a2 && m1 === m2 && d1 === 1 && d2 === ultimoDia) return `${MESES_PT[m1 - 1]} de ${a1}`;
  if (a1 === a2 && m1 === 1 && d1 === 1 && m2 === 12 && d2 === 31) return String(a1);
  const f = (d, m) => String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0');
  return `${f(d1, m1)} a ${f(d2, m2)}`;
}

// O controle: atalhos + um botão que abre o calendário/mês/ano.
// DUAS FORMAS. Em relatórios e campanhas, os atalhos de dias continuam: ali
// a pergunta é sobre um período. No painel a pergunta é "e hoje?", então o
// lugar dos atalhos é ocupado pela DATA de hoje e o resto vai para o Filtrar.
function periodoSeletor(opts) {
  const p = periodoAtual();
  const o = opts || {};
  if (o.hoje) {
    const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    // O chip mostra o que está sendo olhado: hoje, ou o recorte que o Filtrar
    // deixou. Sem isso, escolher "março" e ver a data de hoje ao lado mentiria.
    const rot = (p.dias === 1 || (!p.dias && !p.de)) ? hoje : periodoRotulo();
    return `<div class="per">
      <span class="per-hoje">${ico('calendar', 13)} ${esc(rot)}</span>
      <button class="per-btn ${p.dias === 1 ? '' : 'on'}" onclick="periodoModal()" title="Escolher um dia, mês, ano ou intervalo">
        ${ico('search', 13)}<span>Filtrar</span></button>
    </div>`;
  }
  const atalhos = [7, 14, 30, 90];
  return `<div class="per">
    <div class="seg">${atalhos.map(n => `<button class="${p.dias === n ? 'on' : ''}" onclick="periodoDias(${n})">${n}d</button>`).join('')}</div>
    <button class="per-btn ${p.dias ? '' : 'on'}" onclick="periodoModal()" title="Escolher mês, ano ou um intervalo">
      ${ico('calendar', 13)}<span>${esc(periodoRotulo())}</span>${ico('chevron-down', 12)}</button>
  </div>`;
}

function periodoDias(n) { periodoSalvar({ dias: n }); periodoAplicar(); }

// Quem estiver na tela decide o que repintar. Sem isto, o seletor teria de
// saber de cada tela que usa gráfico.
function periodoAplicar() {
  if (state.view === 'dashboard') renderDashboard();
  else if (state.view === 'reports') renderReports();
  else if (state.view === 'campaigns') paintCampaigns();
  else route();
}

function periodoModal() {
  const p = periodoAtual();
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const anos = [];
  for (let a = anoAtual; a >= anoAtual - 4; a--) anos.push(a);
  const dd = (n) => String(n).padStart(2, '0');
  const hojeTxt = `${anoAtual}-${dd(hoje.getMonth() + 1)}-${dd(hoje.getDate())}`;

  openModal(`<h2>${ico('calendar')} Período dos gráficos</h2>
    <p class="muted" style="margin:6px 0 0;font-size:13px">Escolha um mês, um ano ou um intervalo de datas.</p>

    <div class="per-sec">Mês</div>
    <div class="per-meses">
      ${MESES_PT.map((nome, i) => `<button class="per-chip" onclick="periodoMes(${i}, ${anoAtual})">${nome.slice(0, 3)}</button>`).join('')}
    </div>
    <label style="max-width:150px;margin-top:10px">Ano do mês${ecSelect('per-ano-mes', anos.map(a => ({ value: String(a), label: String(a) })), String(anoAtual))}</label>

    <div class="per-sec">Ano inteiro</div>
    <div class="per-meses">
      ${anos.map(a => `<button class="per-chip" onclick="periodoAno(${a})">${a}</button>`).join('')}
    </div>

    <div class="per-sec">Intervalo</div>
    <div class="row">
      <label style="flex:1">De<input type="date" id="per-de" max="${hojeTxt}" value="${esc(p.de || hojeTxt)}"></label>
      <label style="flex:1">Até<input type="date" id="per-ate" max="${hojeTxt}" value="${esc(p.ate || hojeTxt)}"></label>
    </div>

    <div class="row" style="margin-top:18px;justify-content:flex-end">
      <button class="btn no-grow" onclick="closeModal()">Cancelar</button>
      <button class="btn primary no-grow" onclick="periodoIntervalo()">${ico('check', 14)} Aplicar intervalo</button>
    </div>`);
}

function periodoMes(mes, anoPadrao) {
  const ano = Number(ecSelVal('per-ano-mes')) || anoPadrao;
  const dd = (n) => String(n).padStart(2, '0');
  const ultimo = new Date(ano, mes + 1, 0).getDate();
  periodoSalvar({ de: `${ano}-${dd(mes + 1)}-01`, ate: `${ano}-${dd(mes + 1)}-${dd(ultimo)}` });
  closeModal(); periodoAplicar();
}

function periodoAno(ano) {
  periodoSalvar({ de: ano + '-01-01', ate: ano + '-12-31' });
  closeModal(); periodoAplicar();
}

function periodoIntervalo() {
  const de = $('#per-de').value, ate = $('#per-ate').value;
  if (!de || !ate) return toast('Escolha as duas datas', 'error');
  periodoSalvar({ de, ate });
  closeModal(); periodoAplicar();
}

// ===========================================================================
// BANNERS DA DASHBOARD (protótipo)
//
// Faixa de avisos no topo: novidade, campanha, chamada para um recurso que o
// cliente ainda não usa. O conteúdo está aqui no código de propósito — esta
// versão existe para ver como fica. Se prestar, a lista passa para o Admin.
//
// A sensação de 3D vem de uma peça que ATRAVESSA a borda do cartão (ver
// .bnr-3d no style.css). A peça é a joia, que já é um render com fundo
// transparente.
// ===========================================================================
// A LISTA VEM DO ADMIN, e não daqui. Enquanto a copy morava no código,
// trocar a frase de uma campanha custava um deploy — e o que custa um deploy
// ninguém troca. Nasce vazia: a dashboard é desenhada antes de a resposta
// chegar.
let BANNERS = [];

let bnrAtual = 0, bnrTimer = null;

// O carrossel ocupa o lugar dele DESDE O COMEÇO, mesmo vazio: preencher
// depois empurraria a tela inteira para baixo no meio da leitura de quem já
// está olhando os números.
function bannersHtml() {
  return '<div id="bnr-area">' + bannersCorpo() + '</div>';
}

async function bannersCarregar() {
  const area = $('#bnr-area'); if (!area) return;
  try {
    const r = await api('/banners');
    BANNERS = r.banners || [];
  } catch (e) { BANNERS = []; }
  area.innerHTML = bannersCorpo();
  if (BANNERS.length) bnrLigar();
}

function bannersCorpo() {
  if (!BANNERS.length) return '';
  return `<div class="bnr-wrap" id="bnr-wrap">
    <div class="bnr-janela">
      <div class="bnr-trilho" id="bnr-trilho">
        ${BANNERS.map((b, i) => `
          <article class="bnr">
            <div class="bnr-fundo">
              <img class="bnr-bg" ${i ? '' : `src="/assets/banner-bg-${b.fundo}.webp"`}
                   data-src="/assets/banner-bg-${b.fundo}.webp" alt="" decoding="async">
              <span class="bnr-veu"></span>
            </div>
            <!-- Largura e altura reais: sem elas, uma peça ainda não
                 carregada nasce sem largura e pula ao chegar. -->
            <img class="bnr-3d" ${i ? '' : `src="/assets/banner-${b.peca}.webp"`}
                 data-src="/assets/banner-${b.peca}.webp" alt="" aria-hidden="true"
                 width="${b.pw}" height="${b.ph}" decoding="async">
            <div class="bnr-txt">
              <span class="bnr-tag">${esc(b.tag)}</span>
              <h3>${esc(b.titulo)}</h3>
              <p>${esc(b.texto)}</p>
              <a class="bnr-btn" href="${b.href}">${esc(b.acao)} ${ico('arrowright', 13)}</a>
            </div>
          </article>`).join('')}
      </div>
    </div>
    ${BANNERS.length > 1 ? `<div class="bnr-pontos" id="bnr-pontos">${BANNERS.map((_, i) =>
      `<button class="${i === 0 ? 'on' : ''}" onclick="bnrIr(${i}, true)" aria-label="Banner ${i + 1}"></button>`
    ).join('')}</div>` : ''}
  </div>`;
}

// SÓ O SLIDE QUE VAI APARECER BAIXA. Os cinco banners são 282 KB de imagem, e
// a dashboard mostra UM. `loading="lazy"` não resolvia: os slides estão todos
// dentro da faixa visível da tela (o trilho é deslocado por transform, e isso
// não tira a imagem do campo que o navegador considera "perto"), então os dez
// arquivos vinham juntos na primeira pintura.
//
// O próximo também é carregado, e não só o atual: a troca é automática a cada
// 4,5s, e um slide que começa a baixar no instante em que entra aparece vazio
// e preenche na frente da pessoa.
function bnrCarregar(i) {
  const slide = document.querySelectorAll('#bnr-trilho .bnr')[(i + BANNERS.length) % BANNERS.length];
  if (!slide) return;
  slide.querySelectorAll('img[data-src]').forEach(img => {
    if (!img.getAttribute('src')) img.src = img.dataset.src;
  });
}

function bnrIr(i, manual) {
  const trilho = document.getElementById('bnr-trilho'); if (!trilho) return;
  bnrAtual = (i + BANNERS.length) % BANNERS.length;
  bnrCarregar(bnrAtual);
  bnrCarregar(bnrAtual + 1);
  trilho.style.transform = `translate3d(-${bnrAtual * 100}%, 0, 0)`;
  document.querySelectorAll('#bnr-pontos button').forEach((b, n) => b.classList.toggle('on', n === bnrAtual));
  if (manual) bnrRelogio();   // clicou: o tempo do próximo recomeça do zero
}

function bnrRelogio() {
  clearInterval(bnrTimer);
  if (BANNERS.length < 2) return;
  bnrTimer = setInterval(() => {
    // Aba escondida não avança: senão a pessoa volta do almoço no slide 7 e
    // não viu nenhum.
    if (document.hidden) return;
    bnrIr(bnrAtual + 1);
    // 4,5s: seis segundos parecia travado. Tempo suficiente para ler duas
    // linhas e curto o bastante para a pessoa perceber que há mais.
  }, 4500);
}

function bnrLigar() {
  const wrap = document.getElementById('bnr-wrap'); if (!wrap) return;
  bnrAtual = 0;
  // O primeiro já veio com src no HTML; aqui entra o segundo, que é o que a
  // pessoa vê em 4,5 segundos.
  bnrCarregar(1);
  bnrRelogio();
  // PARA COM O DEDO OU O MOUSE EM CIMA. Trocar no meio da leitura é o jeito
  // mais rápido de garantir que ninguém leia.
  wrap.addEventListener('mouseenter', () => clearInterval(bnrTimer));
  wrap.addEventListener('mouseleave', bnrRelogio);

  // ARRASTAR NO CELULAR: ali ninguém procura setinha, e os pontos são alvos
  // pequenos demais para o polegar.
  let x0 = null, y0 = null;
  wrap.addEventListener('touchstart', e => {
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    clearInterval(bnrTimer);
  }, { passive: true });
  wrap.addEventListener('touchend', e => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    // Só conta como troca de slide se o dedo andou mais na HORIZONTAL: sem
    // isso, rolar a página de leve troca o banner sem querer.
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) bnrIr(bnrAtual + (dx < 0 ? 1 : -1));
    x0 = null; bnrRelogio();
  }, { passive: true });
}

async function renderDashboard() {
  const hoje = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' });
  // Só barras: os três tipos eram três jeitos de olhar o mesmo número, e a
  // barra já é a leitura certa para contagem por dia.
  $('#view').innerHTML = `<div class="page">
    <div class="hero-head">
      <div>
        <span class="hh-date">${esc(hoje.charAt(0).toUpperCase() + hoje.slice(1))}</span>
        <h1>${greeting()}, ${esc(state.user || 'admin')}</h1>
        <p>Veja o que está acontecendo no seu atendimento agora.</p>
      </div>
      <div class="hh-actions">
        ${periodoSeletor({ hoje: true })}
      </div>
    </div>
    ${bannersHtml()}
    <div class="dash-tiles">
      ${(() => {
        // Os atalhos seguem o mesmo recorte do menu: no celular não faz sentido
        // oferecer Campanha ou Flow Builder aqui se eles não estão na navegação.
        const atalhos = [
          ['inbox', 'message', 'Conversas'],
          ['contacts', 'users', 'Novo contato'],
          ['schedule', 'calendar', 'Agendamento'],
          ['campaigns', 'megaphone', 'Campanha'],
          ['tracking', 'trend', 'Tracking'],
          ['pagamentos', 'pix', 'Pagamentos']
        ];
        const mobile = isMobileLayout();
        return atalhos
          // No celular a Agenda sai também dos atalhos: ela já não está na
          // barra de baixo, e com ela sobravam 4 itens quebrando em duas
          // fileiras — uma delas com um item solto. Três é uma fileira só.
          .filter(([v]) => (mobile ? (MOBILE_VIEWS.has(v) && v !== 'schedule') : v !== 'schedule'))
          // um atalho para um módulo fora do plano só levaria o cliente a um
          // redirecionamento para Assinatura, então nem aparece
          .filter(([v]) => planHas(v))
          .map(([v, icone, rotulo]) =>
            `<a class="tile" href="#/${v}"><span class="tile-ic">${ico(icone, 19)}</span><b>${rotulo}</b></a>`)
          .join('');
      })()}
    </div>
    <div id="dash"><div class="card">${skel(6)}</div></div>
  </div>`;
  try {
    const [d, rep] = await Promise.all([api('/dashboard'), api('/reports?' + periodoQuery())]);
    const cfg = d.configured;
    const check = (ok, label) => `<li>${ok ? '<span class="ok-dot">●</span>' : '<span class="bad-dot">●</span>'} ${label}</li>`;
    const t = rep.totals;
    const pend = Math.max(0, t.out - t.delivered - t.failed);
    const clicksPeriod = (rep.advanced || {}).linkClicks || 0;
    const topFlows = rep.topFlows || [], topLinks = rep.topLinks || [];
    const sl = d.sales || { todayCount: 0, todayValue: 0, totalCount: 0, totalValue: 0 };
    $('#dash').innerHTML = `
      <div class="dash-kpis">
        <div class="stat"><span class="stat-ico">${ico('users', 17)}</span>${kpiNum(fmtNk(d.contacts), fmtN(d.contacts))}<div class="lbl">Contatos</div></div>
        <a class="stat" href="#/pagamentos"><span class="stat-ico">${ico('zap', 17)}</span>${kpiNum(fmtBRLk(sl.todayValue), fmtBRL(sl.todayValue))}<div class="lbl">Vendas hoje${sl.todayCount ? ` · ${fmtN(sl.todayCount)} venda${sl.todayCount > 1 ? 's' : ''}` : ''}</div></a>
        <a class="stat" href="#/pagamentos"><span class="stat-ico">${ico('card', 17)}</span>${kpiNum(fmtBRLk(sl.totalValue), fmtBRL(sl.totalValue))}<div class="lbl">Total em vendas</div></a>
        <a class="stat" href="#/pagamentos"><span class="stat-ico">${ico('activity', 17)}</span>${kpiNum(fmtNk(sl.totalCount), fmtN(sl.totalCount))}<div class="lbl">Quantidade de vendas</div></a>
      </div>
      <div class="two-col">
        <div class="card chart-card">
          <div class="row" style="align-items:flex-start;margin-bottom:6px">
            <div style="flex:1">
              <h2 style="margin:0 0 2px">Mensagens no período</h2>
              <span class="big-num">${fmtN(t.out + t.in)}</span><span class="muted" style="font-weight:600;margin-left:8px">${fmtN(t.out)} enviadas · ${fmtN(t.in)} recebidas</span>
            </div>
            <span class="legend"><i style="background:#2ED378"></i> Enviadas</span>
            <span class="legend"><i style="background:#53BDEB"></i> Recebidas</span>
          </div>
          ${chVolume(rep.days, 'bars')}
        </div>
        <div class="card">
          <h2>Status dos envios</h2>
          ${donut([
            { label: 'Lidas', value: t.read, color: '#2ED378' },
            { label: 'Entregues', value: Math.max(0, t.delivered - t.read), color: '#50EA5F' },
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
          ${dayBars(rep.linksByDay || [], '#2ED378')}
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
            ${topFlows.map(f => `<tr><td><b>${esc(f.name)}</b> ${f.enabled ? '' : '<span class="pill">pausado</span>'}</td><td style="text-align:right"><b>${fmtN(f.runs)}</b></td><td style="text-align:right">${f.okRate === null ? '-' : `<span class="pill ${f.okRate >= 80 ? 'done' : 'pending'}">${f.okRate}%</span>`}</td></tr>`).join('')}
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
    bannersCarregar();   // busca a lista no Admin e liga o carrossel
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
  const caixa = document.querySelector('.inbox');
  caixa?.classList.add('chat-open');   // mobile: mostra o chat
  ligarGestoVoltar(caixa);             // e passa a aceitar o arrasto de voltar
  await loadChat(waId);
  api(`/messages/${waId}/read`, { body: {} }).then(loadConversations).catch(() => {});
}

// Mobile: volta da conversa para a lista
function closeChatMobile() {
  document.querySelector('.inbox')?.classList.remove('chat-open');
  clearInterval(sessTicker);
}

// ---------------------------------------------------------------------------
// VOLTAR ARRASTANDO (mobile)
//
// A conversa é uma camada por cima da lista. Arrastar para a direita move a
// camada junto com o dedo e vai descobrindo a lista atrás; ao soltar, ela
// completa o movimento ou volta para o lugar. É o gesto do WhatsApp.
//
// Enquanto o dedo manda, quem posiciona é este código (transform inline, sem
// transição). No fim as posições voltam a ser as do CSS, para o fechamento ou
// o recuo saírem animados.
// ---------------------------------------------------------------------------
function ligarGestoVoltar(inbox) {
  if (!inbox || inbox._gestoLigado) return;
  inbox._gestoLigado = true;

  var x0 = 0, y0 = 0, t0 = 0, dx = 0, largura = 1;
  var tocando = false, arrastando = false;

  // A faixa de ícones do topo e a do composer rolam de lado. Um arrasto que
  // comece nelas é rolagem, não navegação.
  function rolaDeLado(alvo) {
    for (var e = alvo; e && e !== inbox; e = e.parentElement) {
      var ox = getComputedStyle(e).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && e.scrollWidth > e.clientWidth + 2) return true;
    }
    return false;
  }

  // p = 0 conversa inteira na tela; p = 1 conversa toda fora, lista no lugar.
  function posicionar(p) {
    var chat = inbox.querySelector('.chat');
    var lista = inbox.querySelector('.conv-list');
    if (chat) chat.style.transform = 'translateX(' + (p * 100) + '%)';
    if (lista) lista.style.transform = 'translateX(' + (-22 + 22 * p) + '%)';
  }
  function devolverAoCss() {
    var chat = inbox.querySelector('.chat');
    var lista = inbox.querySelector('.conv-list');
    if (chat) chat.style.transform = '';
    if (lista) lista.style.transform = '';
  }

  inbox.addEventListener('touchstart', function (ev) {
    if (!inbox.classList.contains('chat-open') || ev.touches.length !== 1) return;
    if (rolaDeLado(ev.target)) return;
    var t = ev.touches[0];
    x0 = t.clientX; y0 = t.clientY; t0 = Date.now(); dx = 0;
    largura = inbox.clientWidth || 1;
    tocando = true; arrastando = false;
  }, { passive: true });

  inbox.addEventListener('touchmove', function (ev) {
    if (!tocando) return;
    var t = ev.touches[0];
    var ax = t.clientX - x0, ay = t.clientY - y0;
    if (!arrastando) {
      if (Math.abs(ax) < 8 && Math.abs(ay) < 8) return;   // ainda pode virar toque
      // Só assume o gesto se for claramente horizontal e para a direita; caso
      // contrário devolve o movimento para a rolagem das mensagens.
      if (Math.abs(ax) <= Math.abs(ay) || ax <= 0) { tocando = false; return; }
      arrastando = true;
      inbox.classList.add('arrastando');
    }
    dx = Math.max(0, ax);
    ev.preventDefault();          // daqui em diante o movimento é nosso
    posicionar(dx / largura);
  }, { passive: false });

  function soltar() {
    if (!tocando) return;
    tocando = false;
    if (!arrastando) return;
    arrastando = false;
    var p = dx / largura;
    var velocidade = dx / Math.max(1, Date.now() - t0);   // px por ms
    inbox.classList.remove('arrastando');
    devolverAoCss();
    // Passou de um terço, ou foi um lance rápido: completa. Senão, recua.
    if (p > 0.33 || velocidade > 0.5) closeChatMobile();
    dx = 0;
  }
  inbox.addEventListener('touchend', soltar, { passive: true });
  inbox.addEventListener('touchcancel', soltar, { passive: true });
}

async function loadChat(waId, keepScroll) {
  const pane = $('#chat-pane');
  if (!pane) return;
  try {
    const { messages, contact, session: sess, consent: cons } = await api('/messages/' + waId);
    const c = contact || { waId, name: waId };
    state.currentContact = c;          // o botão da IA lê o iaOff deste contato
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
          <button class="btn small" id="tool-file" onclick="attachFile()" title="Anexo">${ico('paperclip', 13)}<i class="blbl">Anexo</i></button>
          <button class="btn small" id="tool-tpl" onclick="templateModal('${c.waId}')" title="Template">${ico('file', 13)}<i class="blbl">Template</i></button>
          <button class="btn small" id="tool-btns" onclick="buttonsModal('${c.waId}')" title="Botões">${ico('buttons', 13)}<i class="blbl">Botões</i></button>
          <button class="btn small" id="tool-pay" onclick="chatChargeModal('${c.waId}')" title="Cobrança">${ico('pix', 13)}<i class="blbl">Cobrança</i></button>
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
      <div><span>Janela expira em</span><b id="sess-exp">${w.open ? fmtDur(w.msLeft) : '-'}</b></div>
    </div>` : ''}
    ${finished ? `<div class="sess-closed">${ico('check-circle', 13)} ${esc(sess.attendance.closeType === 'auto' ? 'Encerrado automaticamente' : 'Encerrado por ' + (sess.attendance.closedBy || 'atendente'))} · ${sess.attendance.closedAt ? new Date(sess.attendance.closedAt).toLocaleString('pt-BR') : ''}</div>` : ''}
  </div>`;

  // --- Header: ações de atendimento ---
  const assigned = state.currentConsent && state.currentConsent.assignedAgent;
  actions.innerHTML = `
    ${assigned ? `<span class="assign-chip" title="Responsável">${agAvatar ? agAvatar(assigned, 22) : ''}<span>${esc(assigned.name)}</span></span>` : ''}
    <button class="btn small" onclick="transferModal('${state.currentWaId}')" title="Transferir">${ico('arrowright', 13)}<i class="blbl">Transferir</i></button>
    <button class="btn small" onclick="editContactModal('${state.currentWaId}')" title="Editar contato">${ico('edit', 13)}<i class="blbl">Editar</i></button>
    ${finished
      ? `<button class="btn small primary" onclick="reopenAttendance('${state.currentWaId}')" title="Reabrir Atendimento">${ico('refresh', 13)}<i class="blbl">Reabrir Atendimento</i></button>`
      : `<button class="btn small" onclick="finishAttendance('${state.currentWaId}')" title="Finalizar Atendimento">${ico('check-circle', 13)}<i class="blbl">Finalizar Atendimento</i></button>`}
    ${iaBotaoChat()}`;

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
      <div><b>Contato em opt-out.</b> <span class="sn-body">Ele pediu para não receber mais mensagens, então <b>nenhum envio é permitido</b>, nem template, nem campanha. Reative para voltar a conversar.</span></div>
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
    <div><b>${title}</b> <span class="sn-body">${body}</span></div>
    ${finished
      ? `<button class="btn small primary no-grow" onclick="reopenAttendance('${state.currentWaId}')">Reabrir</button>`
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
    if (exp) exp.textContent = w.open && !finished ? fmtDur(w.msLeft) : '-';
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

// O ALVO VEM DE FORA. Ler `state.currentWaId` depois da confirmação era ler
// a conversa que estivesse aberta no momento do clique em "Finalizar" — que
// não é necessariamente a mesma de quando a caixa abriu.
async function finishAttendance(waId) {
  waId = waId || state.currentWaId;
  if (!waId) return;
  if (!await confirmModal({
    title: 'Finalizar atendimento',
    text: 'A conversa será marcada como Finalizada e o envio de novas mensagens ficará bloqueado até que o atendimento seja reaberto. A data, o horário e o seu nome serão registrados.',
    ok: 'Finalizar atendimento'
  })) return;
  try {
    const r = await api(`/conversations/${waId}/finish`, { body: {} });
    // Só repinta se esta ainda é a conversa na tela: pintar o estado de uma
    // conversa por cima de outra é o mesmo bug com outra roupa.
    if (state.currentWaId === waId) { state.currentSession = r.session; paintSession(); }
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

async function reopenAttendance(waId) {
  waId = waId || state.currentWaId;
  if (!waId) return;
  try {
    const r = await api(`/conversations/${waId}/reopen`, { body: {} });
    if (state.currentWaId === waId) { state.currentSession = r.session; paintSession(); }
    toast('Atendimento reaberto');
    loadConversations();
  } catch (e) { toast(e.message, 'error'); }
}

function renderThread(messages) {
  // Hora estimada para o que chegar sem ela: a lista está em ordem, então a
  // mensagem anterior (ou a seguinte, no começo) é o palpite certo. Serve para
  // o balão e para o separador de dia — sem isto, uma mensagem sem hora abria
  // um separador "Invalid Date" no meio da conversa.
  const valida = (t) => Number.isFinite(t) && t > 0;
  let ultima = null;
  for (const m of messages) if (valida(m.timestamp)) { ultima = m.timestamp; break; }
  const quando = messages.map(m => {
    if (valida(m.timestamp)) { ultima = m.timestamp; return m.timestamp; }
    return ultima;
  });

  let html = '', prevDay = '';
  messages.forEach((m, i) => {
    if (!valida(m.timestamp) && quando[i]) m = { ...m, horaEstimada: quando[i] };
    const dl = dayLabel(quando[i]);
    if (dl !== prevDay) { html += `<div class="date-sep"><span>${esc(dl)}</span></div>`; prevDay = dl; }
    const next = messages[i + 1];
    const tail = !next || next.direction !== m.direction || dayLabel(quando[i + 1]) !== dl;
    html += renderMsg(m, tail);
  });
  return html;
}

// ---------------------------------------------------------------------------
// MENSAGEM DE VOZ
//
// A onda é decorativa e desenhada a partir do ID da mensagem: barras iguais
// para todo mundo seria pior, e ler o áudio inteiro só para desenhar a forma
// de onda real custaria o download de cada mensagem ao abrir a conversa.
// Sendo derivada do id, ela é ESTÁVEL — a mesma mensagem tem sempre a mesma
// onda, e não fica dançando a cada repintura.
// ---------------------------------------------------------------------------
function ondaDe(id, n = 34) {
  let h = 0;
  const s = String(id || 'x');
  const barras = [];
  for (let i = 0; i < n; i++) {
    h = (h * 31 + s.charCodeAt(i % s.length) + i * 7) % 997;
    barras.push(30 + (h % 70));            // 30% a 100% da altura
  }
  return barras;
}

function audioBubble(m, src) {
  const id = 'aud_' + String(m.id || Math.random()).replace(/\W/g, '').slice(-12);
  const voz = !!m.voice;
  const barras = ondaDe(m.id).map(h => `<i style="height:${h}%"></i>`).join('');
  // A onda vai DUAS vezes: a de baixo cinza, e a de cima verde recortada no
  // ponto tocado. Sem quebra de linha entre as tags — o balão usa
  // `white-space: pre-wrap` e a indentação do template apareceria na tela.
  return `<div class="voz ${voz ? 'is-voz' : ''}" id="${id}">` +
    `<button class="voz-play" type="button" onclick="tocarAudio('${id}')" aria-label="Tocar">${ico('play', 15)}</button>` +
    `<div class="voz-onda" onclick="buscarAudio('${id}', event)">${barras}<span class="voz-prog">${barras}</span></div>` +
    `<span class="voz-tempo">--:--</span>` +
    `<audio src="${src}" preload="metadata"></audio>` +
    `</div>`;
}

function segParaMin(s) {
  if (!isFinite(s) || s < 0) return '--:--';
  const t = Math.round(s);
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

// Um de cada vez: começar um áudio para o anterior, como no WhatsApp.
function tocarAudio(id) {
  const box = document.getElementById(id); if (!box) return;
  const a = box.querySelector('audio');
  document.querySelectorAll('.voz audio').forEach(o => { if (o !== a) { o.pause(); } });
  if (a.paused) a.play().catch(() => {}); else a.pause();
}
function buscarAudio(id, ev) {
  const box = document.getElementById(id); if (!box) return;
  const a = box.querySelector('audio');
  const onda = box.querySelector('.voz-onda');
  if (!a.duration || !isFinite(a.duration)) return;
  const r = onda.getBoundingClientRect();
  a.currentTime = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * a.duration;
}
// Um listener só, no container: as mensagens são repintadas o tempo todo, e
// prender um listener em cada <audio> vazaria a cada recarga da conversa.
document.addEventListener('DOMContentLoaded', () => {
  const alvo = document.body;
  const achar = (e) => e.target && e.target.closest ? e.target.closest('.voz') : null;
  const pinta = (box, a) => {
    if (!box) return;
    const pct = a.duration && isFinite(a.duration) ? (a.currentTime / a.duration) * 100 : 0;
    const p = box.querySelector('.voz-prog');
    if (p) p.style.clipPath = `inset(0 ${(100 - pct).toFixed(2)}% 0 0)`;
    const t = box.querySelector('.voz-tempo');
    if (t) t.textContent = segParaMin(a.currentTime > 0 ? a.duration - a.currentTime : a.duration);
    box.classList.toggle('tocando', !a.paused && !a.ended);
  };
  for (const ev of ['timeupdate', 'loadedmetadata', 'play', 'pause', 'ended']) {
    alvo.addEventListener(ev, (e) => {
      if (!e.target || e.target.tagName !== 'AUDIO') return;
      pinta(achar(e), e.target);
    }, true);
  }
});

function renderMsg(m, tail = true) {
  let content = '';
  const mediaSrc = m.media && m.media.id ? `/api/media/${encodeURIComponent(m.media.id)}?token=${TOKEN}` : (m.media && m.media.link) || '';
  if (['image', 'sticker'].includes(m.type) && mediaSrc) content += `<img src="${mediaSrc}" loading="lazy" alt="">`;
  else if (m.type === 'video' && mediaSrc) content += `<video src="${mediaSrc}" controls preload="metadata"></video>`;
  // Áudio e mensagem de voz: o player cru do navegador tem 300px de barra
  // cinza e não combina com nada. Aqui vira uma faixa própria, com botão de
  // tocar, onda e tempo — e o <audio> real fica escondido, tocando por trás.
  else if (m.type === 'audio' && mediaSrc) content += audioBubble(m, mediaSrc);
  else if (m.type === 'document' && mediaSrc) content += `<a class="doc" href="${mediaSrc}&dl=${encodeURIComponent(m.media.filename || 'documento')}" target="_blank">${ico('file', 14)} ${esc(m.media.filename || 'Documento')}</a>`;
  if (m.text) content += (content ? '<div>' : '') + esc(m.text) + (content.includes('<img') || content.includes('<video') || content.includes('<audio') || content.includes('doc') ? '</div>' : '');
  if (!content) content = `<span class="muted">[${esc(m.type)}]</span>`;
  // Sem quebras de linha entre as tags: o balão usa `white-space: pre-wrap`
  // para respeitar as quebras que o cliente digitou, e com isso a indentação
  // do próprio template virava espaço em branco DENTRO da mensagem — a
  // primeira linha saía deslocada e sobrava uma linha vazia no fim.
  // TODA mensagem mostra a hora. O banco carimba na gravação e a migração
  // preencheu o histórico antigo (ver `carimbarHorasFaltantes`), mas aqui fica
  // a rede: se algo chegar sem hora, `m.horaEstimada` — posta por
  // `renderThread` a partir da mensagem vizinha — evita o balão mudo.
  const quando = Number.isFinite(m.timestamp) && m.timestamp > 0 ? m.timestamp : m.horaEstimada;
  const hora = fmtHora(quando), st = statusIcon(m);
  const meta = (hora || st)
    ? `<div class="meta" title="${esc(fmtTime(quando))}"><time>${hora}</time>${st}</div>`
    : '';

  // BOTÕES enviados ao lead aparecem como botões, e não como "[Sim] [Não]"
  // grudado no texto. É o que permite conferir, olhando a conversa, se o
  // disparo saiu com os botões certos — e qual deles a pessoa tocou, porque a
  // resposta dela chega logo abaixo, na própria conversa.
  const btns = Array.isArray(m.buttons) && m.buttons.length
    ? `<div class="msg-btns">${m.buttons.map(b =>
        `<span class="msg-btn" title="${esc(b.id || '')}">${esc(b.title || b)}</span>`).join('')}</div>`
    : '';

  return `<div class="msg ${m.direction} ${tail ? 'tail' : ''}${btns ? ' com-btns' : ''}">${content}${meta}${btns}</div>`;
}

function statusIcon(m) {
  if (m.direction !== 'out') return '';
  // Ainda não saiu daqui: reloginho, como no WhatsApp. É o que diz à pessoa
  // que a mensagem não se perdeu, ela só está indo.
  if (m.status === 'pending') {
    return `<span class="st pend" title="Enviando…">` +
      `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">` +
      `<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/></svg></span>`;
  }
  if (m.status === 'failed') return `<span class="st fail" title="${esc(m.error || 'Falha no envio')}">${ico('alert', 11)} falhou</span>`;
  if (m.status === 'read') return '<span class="st read">✓✓</span>';
  if (m.status === 'delivered') return '<span class="st">✓✓</span>';
  return '<span class="st">✓</span>';
}

async function sendTextNow() {
  const ta = $('#composer-text');
  const text = ta.value.trim();
  if (!text || !state.currentWaId) return;
  const waId = state.currentWaId;
  ta.value = '';
  ta.style.height = '';                 // o textarea cresce ao digitar; volta a uma linha
  // O balão aparece na hora, com o reloginho, e só depois vira ✓. Antes o texto
  // sumia do campo e não havia nada na tela até a Meta responder — em rede
  // ruim isso são dois segundos parecendo que a mensagem se perdeu.
  const provisoria = balaoProvisorio(waId, text);
  try {
    await api('/send/text', { body: { to: waId, text } });
    await loadChat(waId, true);
    $('#composer-text')?.focus();
    loadConversations();
  } catch (e) {
    if (provisoria) provisoria.remove();
    ta.value = text;
    toast(e.message, 'error');
  }
}

// Pinta o balão pendente direto no fim da conversa. Devolve o elemento para
// quem chamou poder tirá-lo se o envio falhar.
function balaoProvisorio(waId, text) {
  const sc = $('#chat-scroll');
  if (!sc || state.currentWaId !== waId) return null;
  const vazio = sc.querySelector('p.muted');
  if (vazio) vazio.remove();
  const div = document.createElement('div');
  div.innerHTML = renderMsg({ direction: 'out', text, timestamp: Date.now(), status: 'pending' }, true);
  const balao = div.firstElementChild;
  if (!balao) return null;
  balao.classList.add('subindo');       // a animação que sai do campo de texto
  sc.appendChild(balao);
  sc.scrollTop = sc.scrollHeight;
  return balao;
}
// ---------------------------------------------------------------------------
// MENSAGEM DE VOZ, DESLIGADA
//
// O botao do microfone gravava, convertia e mandava, e o envio nao chegava
// pela API. Um botao que promete e nao entrega e pior do que a ausencia dele:
// a pessoa grava, acha que mandou, e a mensagem some sem erro visivel.
//
// O que saiu foi a GRAVACAO. Audio RECEBIDO continua tocando na conversa (o
// player fica logo acima) e o anexo continua aceitando um arquivo de audio
// pronto: os dois caminhos funcionam. A conversao de formato segue em voz.js,
// para o dia em que o envio voltar a valer.
// ---------------------------------------------------------------------------


function attachFile() { $('#file-input').click(); }

function fileChosen(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  // O destinatário é quem estava na tela quando o arquivo foi escolhido. Um
  // vídeo de 40 MB leva tempo para subir, e reler a conversa aberta depois
  // mandava o arquivo para quem tivesse sido aberto nesse meio-tempo.
  const waId = state.currentWaId;
  if (!waId) return toast('Abra uma conversa antes de enviar um arquivo', 'error');
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
      await api('/send/media', { body: { to: waId, kind, mediaId: up.id, filename: file.name } });
      if (state.currentWaId === waId) loadChat(waId, true);
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
    <label>E-mail (opcional)<input id="nc-email" type="email" placeholder="cliente@email.com"></label>
    <label>CPF ou CNPJ (opcional)<input id="nc-doc" inputmode="numeric" placeholder="000.000.000-00"
      oninput="this.value=mascararDoc(this.value)"></label>
    <p class="hint">O e-mail e o documento não são obrigatórios agora, mas são o que o checkout pede
      na hora da compra. Guardados aqui, a cobrança sai sem pedir nada de novo.</p>
    <p class="hint">Fora da janela de 24h, a primeira mensagem precisa ser um <b>template aprovado</b>.</p>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="createChat()">Abrir conversa</button></div>`);
  $('#nc-phone').focus();
}

async function createChat() {
  try {
    const doc = ($('#nc-doc') && $('#nc-doc').value || '').replace(/D/g, '');
    if (doc && erroDoc(doc)) return toast(erroDoc(doc), 'error');
    const r = await api('/contacts', { body: {
      phone: $('#nc-phone').value, name: $('#nc-name').value.trim(),
      email: ($('#nc-email') && $('#nc-email').value || '').trim(), document: doc
    } });
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
        <button class="btn no-grow" onclick="exportarContatos()" title="CSV com telefones no padrão E.164 aceito pela API">${ico('download-circle', 14)} Exportar CSV</button>
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
          <td>${(c.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted">-</span>'}</td>
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
    <label>E-mail<input id="nct-email" type="email" placeholder="cliente@email.com"></label>
    <label>CPF ou CNPJ<input id="nct-doc" inputmode="numeric" placeholder="000.000.000-00"
      oninput="this.value=mascararDoc(this.value)"></label>
    <p class="hint">E-mail e documento são o que o checkout pede na hora da compra.
      Preenchidos aqui, a cobrança seguinte não pergunta de novo.</p>
    <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveNewContact()">Salvar</button></div>`);
}

async function saveNewContact() {
  const doc = ($('#nct-doc')?.value || '').replace(/D/g, '');
  if (doc && erroDoc(doc)) return toast(erroDoc(doc), 'error');
  try {
    await api('/contacts', { body: {
      phone: $('#nct-phone').value, name: $('#nct-name').value.trim(),
      email: ($('#nct-email')?.value || '').trim(), document: doc
    } });
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
      <label>CPF ou CNPJ<input id="ec-doc" inputmode="numeric" value="${esc(mascararDoc((c.vars && c.vars.cpf_cnpj) || ''))}"
        placeholder="000.000.000-00" oninput="this.value=mascararDoc(this.value)"></label>
      <label>Etapa do funil${ecSelect('ec-stage', stages.map(s => ({ value: s, label: s })), c.stage)}</label>
      <label>Tags (separadas por vírgula)<input id="ec-tags" value="${esc((c.tags || []).join(', '))}"></label>
      <label>Anotações<textarea id="ec-notes">${esc(c.notes || '')}</textarea></label>
      ${src}
      <div class="row"><button class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary" onclick="saveContact('${waId}')">Salvar</button></div>`);
  } catch (e) { toast(e.message, 'error'); }
}

async function saveContact(waId) {
  // O documento é conferido aqui (dígito verificador) para o erro aparecer no
  // formulário, e não como resposta seca do servidor.
  const doc = ($('#ec-doc')?.value || '').replace(/D/g, '');
  if (doc && erroDoc(doc)) return toast(erroDoc(doc), 'error');
  try {
    await api('/contacts/' + waId, {
      method: 'PUT',
      body: {
        name: $('#ec-name').value,
        email: $('#ec-email')?.value || '',
        document: ($('#ec-doc')?.value || '').replace(/D/g, ''),
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

async function togglePipeCfg() {
  if (pipeCfg && pipeCfg.open) { pipeCfg.open = false; paintPipeCfg(); return; }
  // As etapas vêm de `state.settings`, que é carregado na entrada do app. Se
  // alguém abre o Pipeline direto pelo endereço (ou recarrega em cima dele),
  // isso pode ainda não ter chegado — e o editor abria VAZIO, sem nenhuma
  // etapa para editar. Pior: salvar assim apagaria o funil inteiro.
  if (!(state.settings && Array.isArray(state.settings.stages) && state.settings.stages.length)) {
    try { const st = await api('/settings'); state.settings = st.settings; }
    catch (e) { return toast('Não consegui carregar as etapas: ' + e.message, 'error'); }
  }
  const stages = (state.settings && state.settings.stages) || [];
  if (!stages.length) return toast('Nenhuma etapa encontrada. Recarregue a página.', 'error');
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

async function pipeDel(id) {
  if (pipeCfg.list.length <= 1) return;   // o pipeline não pode ficar sem coluna
  const s = pipeFind(id);
  const usados = pipeContagem(s && s.de);
  // `confirm()` do navegador é suprimido no app instalado (PWA/WebView): ele
  // devolve false calado, e o botão de remover simplesmente não fazia nada.
  // O resto do app já usa a caixa própria; esta era a exceção.
  if (s && s.de) {
    const ok = await confirmModal({
      title: 'Remover etapa',
      text: usados
        ? `Remover "${s.de}"? Os ${usados} contato(s) dessa etapa vão para a primeira da lista.`
        : `Remover a etapa "${s.de}"?`,
      ok: 'Remover', danger: true
    });
    if (!ok) return;
  }
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
      <table><thead><tr><th>Nome</th><th>Uso no Pagamentos</th><th>Idioma</th><th>Status</th><th>Corpo</th><th></th></tr></thead>
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
        você escolhe qual é enviado em <a href="#/pagamentos">Pagamentos → Mensagens</a>.</p>`
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
  // O APARELHO É O RENDER DA VITRINE, o mesmo da seção "No seu bolso". Antes
  // era um telefone desenhado em CSS: funcionava, mas eram dois telefones
  // diferentes no mesmo produto — e isso faz a tela parecer montada por duas
  // pessoas que não se falaram. A TELA continua a mesma: só a moldura mudou.
  return `<div class="ph-device">
    <img class="ph-mock" src="/assets/figma-celular.webp" width="720" height="1472" alt="" aria-hidden="true" loading="lazy" decoding="async">
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
            <div class="role-head">${ico('pix', 13)} Uso no Pagamentos <span class="role-hint">escolha um, ou nenhum, para campanha comum</span></div>
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
    desc: 'Enviado quando você gera uma cobrança no Pagamentos, funciona <b>fora da janela de 24h</b>.',
    vars: [
      ['nome do cliente', 'Maria Silva'],
      ['valor da cobrança', 'R$ 149,90'],
      ['link de pagamento', 'https://pay.koonfy.com.br/abc123'],
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
    $('#log-list').innerHTML = events.length ? events.map(logLinha).join('')
      : '<div class="card"><p class="muted">Nenhum evento ainda. Configure a Callback URL no painel da Meta e clique em "Verificar e salvar", a tentativa aparecerá aqui.</p></div>';
  } catch (e) { $('#log-list').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------------------------------------------------------------------------
// O QUE CADA EVENTO É, EM PORTUGUÊS
//
// A tela mostrava o nome interno do evento — "webhook" repetido vinte vezes —,
// e para saber o que tinha acontecido era preciso abrir o JSON e lê-lo. O nome
// interno não some: ele vira o detalhe técnico, atrás de "Visualização
// avançada". O que fica à vista é a frase.
// ---------------------------------------------------------------------------
const LOG_TEXTOS = {
  verify_attempt:      ['Verificação do webhook', 'A Meta conferiu a URL e o Verify Token deste servidor.'],
  signature_invalid:   ['Assinatura recusada', 'Chegou uma chamada em /webhook cuja assinatura não bate com o App Secret. Foi descartada.'],
  process_error:       ['Erro ao processar', 'O evento chegou, mas algo falhou ao tratá-lo.'],
  unrouted:            ['Mensagem sem dono', 'A Meta entregou uma mensagem de um número que nenhuma conexão deste servidor reconhece.'],
  embedded_signup:     ['Conexão do WhatsApp', 'Resultado do cadastro incorporado da Meta.'],
  opt_in:              ['Contato aceitou receber', 'O contato entrou (ou voltou) para a lista de envios.'],
  opt_out:             ['Contato pediu para sair', 'Nenhum envio é permitido para ele até ser reativado.'],
  opt_out_msg_error:   ['Falha ao avisar do opt-out', 'A confirmação de saída não pôde ser enviada.'],
  flow_run:            ['Automação executada', 'Um fluxo do Flow Builder rodou.'],
  flow_error:          ['Erro em automação', 'Um fluxo falhou no meio.'],
  ia_error:            ['Erro do Agente de IA', 'A resposta automática não pôde ser gerada.'],
  survey_sent:         ['Pesquisa enviada', 'A pesquisa de satisfação foi para o cliente.'],
  survey_answered:     ['Pesquisa respondida', 'O cliente deu a nota.'],
  survey_skipped:      ['Pesquisa não enviada', 'A pesquisa foi pulada nesta finalização.'],
  survey_error:        ['Erro na pesquisa', 'A pesquisa de satisfação falhou.'],
  attendance_finished: ['Atendimento finalizado', 'A conversa foi encerrada.'],
  attendance_reopened: ['Atendimento reaberto', 'O cliente voltou a falar e a conversa reabriu.'],
  call_connect:        ['Chamada de voz', 'Evento da API de ligações.'],
  woovi_webhook:       ['Aviso do gateway', 'O gateway de pagamento notificou um evento.'],
  woovi_paid:          ['Pagamento confirmado', 'Uma cobrança foi paga e conferida na API do gateway.'],
  woovi_webhook_error: ['Erro no aviso do gateway', 'A notificação do gateway não pôde ser tratada.'],
  woovi_unmatched:     ['Pagamento sem dono', 'Um pagamento chegou sem cobrança correspondente aqui.'],
  sms_bulk:            ['Disparo de SMS', 'Um envio em massa de SMS foi processado.'],
  subscribe_waba_falhou: ['Falha ao assinar a WABA', 'Sem essa assinatura a Meta não entrega mensagens deste número.'],
  business_id_falhou:  ['Business ID não obtido', 'A conexão foi salva, mas o identificador do negócio não pôde ser lido.'],
  register_pagamentos_falhou: ['Conta de Pagamentos não criada', 'O cadastro foi concluído, mas a conta de recebimento não abriu.']
};

// O `webhook` é o mais comum e o mais vago: o que importa é o que veio DENTRO.
function descreverWebhook(e) {
  const v = ((((e.body || {}).entry || [])[0] || {}).changes || [])[0];
  const val = (v && v.value) || {};
  const campo = e.field || (v && v.field) || '';
  if (Array.isArray(val.messages) && val.messages.length) {
    const m = val.messages[0];
    const quem = ((val.contacts || [])[0] || {}).profile;
    const nome = (quem && quem.name) || m.from || 'contato';
    const tipos = { text: 'mensagem', image: 'imagem', audio: 'áudio', video: 'vídeo',
      document: 'documento', sticker: 'figurinha', location: 'localização',
      contacts: 'contato', interactive: 'resposta de botão', button: 'resposta de botão',
      reaction: 'reação', order: 'pedido' };
    const oque = tipos[m.type] || (m.type || 'mensagem');
    const texto = (m.text && m.text.body) || '';
    return ['Mensagem recebida',
      `${nome} enviou ${oque}${texto ? ': “' + texto.slice(0, 60) + (texto.length > 60 ? '…' : '') + '”' : '.'}`];
  }
  if (Array.isArray(val.statuses) && val.statuses.length) {
    const st = val.statuses[0];
    const nomes = { sent: 'enviada', delivered: 'entregue', read: 'lida', failed: 'falhou' };
    return ['Status de mensagem', `Uma mensagem que você enviou está ${nomes[st.status] || st.status}.`];
  }
  const porCampo = {
    message_template_status_update: ['Modelo revisado pela Meta', 'A situação de um modelo de mensagem mudou (aprovado, rejeitado ou pausado).'],
    message_template_quality_update: ['Qualidade do modelo', 'A Meta reavaliou a qualidade de um modelo.'],
    phone_number_quality_update: ['Qualidade do número', 'A Meta reavaliou a qualidade do seu número.'],
    phone_number_name_update: ['Nome do número', 'O nome verificado do número mudou.'],
    account_update: ['Conta da Meta', 'Houve uma mudança na sua conta do WhatsApp Business.'],
    account_alerts: ['Aviso da Meta', 'A Meta emitiu um alerta sobre a conta.'],
    calls: ['Chamada de voz', 'Evento da API de ligações.'],
    business_capability_update: ['Limites da conta', 'Os limites de envio da conta mudaram.']
  };
  if (porCampo[campo]) return porCampo[campo];
  return ['Evento da Meta', campo ? `Campo “${campo}”. Abra a visualização avançada para ver o conteúdo.`
    : 'Abra a visualização avançada para ver o conteúdo.'];
}

function logLinha(e) {
  const icones = {
    webhook: 'download-circle', verify_attempt: 'shield', signature_invalid: 'slash',
    process_error: 'alert', unrouted: 'alert', opt_in: 'check', opt_out: 'slash',
    woovi_paid: 'pix', flow_run: 'flow', ia_error: 'alert', call_connect: 'phone'
  };
  const ruins = ['signature_invalid', 'process_error', 'unrouted', 'flow_error', 'ia_error',
    'woovi_webhook_error', 'woovi_unmatched', 'survey_error', 'subscribe_waba_falhou',
    'business_id_falhou', 'register_pagamentos_falhou', 'opt_out_msg_error'];

  let [titulo, detalhe] = e.type === 'webhook' ? descreverWebhook(e)
    : (LOG_TEXTOS[e.type] || ['Evento do sistema', 'Registro interno: ' + e.type + '.']);

  // Alguns eventos carregam a própria explicação, mais precisa que a genérica.
  if (e.explicacao) detalhe = e.explicacao;
  if (e.type === 'verify_attempt') detalhe = e.ok
    ? 'A Meta conferiu a URL e o Verify Token, e aceitou. O webhook está válido.'
    : 'A Meta tentou verificar, mas o Verify Token não confere com o deste servidor.';
  if (e.error) detalhe += ' Erro: ' + e.error;

  const ruim = ruins.includes(e.type) || (e.type === 'verify_attempt' && e.ok === false);
  return `<div class="log-item ${ruim ? 'ruim' : ''}">
    <div class="log-top">
      <span class="log-ic">${ico(icones[e.type] || 'info', 15)}</span>
      <b>${esc(titulo)}</b>
      <span class="muted log-quando">${fmtDataHora(e.ts)}</span>
    </div>
    <p class="log-desc">${esc(detalhe)}</p>
    <details class="log-cru">
      <summary>Visualização avançada</summary>
      <pre class="out">${esc(JSON.stringify(e.body || e, null, 2))}</pre>
    </details>
  </div>`;
}

// Nas tabelas de dinheiro a hora não acrescenta nada e, no celular, empurra a
// coluna do VALOR para fora da tela — que é a coluna que a pessoa foi ver.
function fmtDataCurta(ts) {
  try { return new Date(ts).toLocaleDateString('pt-BR'); } catch { return ''; }
}

function fmtDataHora(ts) {
  try { return new Date(ts).toLocaleString('pt-BR'); } catch { return ''; }
}

// ---------- configurações ----------
// Trava de uma vez por sessao: sem ela o renderSettings chamado de dentro do
// .then() dispararia a consulta de novo, em laco.
let SETTINGS_RECONCILIADO = false;
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
          <div class="wa-row"><span>Número</span><b>${esc(w.displayPhoneNumber || '-')}</b></div>
          <div class="wa-row"><span>Nome verificado</span><b>${esc(w.verifiedName || '-')}</b></div>
          <div class="wa-row"><span>WABA ID</span><b>${esc(w.wabaId || '-')}</b></div>
          <div class="wa-row"><span>Qualidade do número</span><b>${w.qualityRating
            ? `<span class="pill ${w.qualityRating === 'GREEN' ? 'done' : 'warn'}">${esc(w.qualityRating)}</span>` : '-'}</b></div>
          <div class="wa-row"><span>Limite diário</span><b>${limiteDiarioHtml(w)}</b></div>
          <div class="wa-row"><span>Business ID</span><b>${esc(w.businessId || '-')}${w.businessName
            ? ` <span class="muted" style="font-weight:600">(${esc(w.businessName)})</span>` : ''}</b></div>
          <div class="wa-row"><span>Webhook assinado</span><b>${w.appSubscribed
            ? '<span class="pill done">Sim</span>'
            : '<span class="pill warn">Não, a Meta não vai entregar mensagem</span>'}</b></div>
          <div class="wa-row"><span>Conectado em</span><b>${w.connectedAt ? new Date(w.connectedAt).toLocaleString('pt-BR') : '-'}</b></div>
          <div class="wa-row"><span>Graph API</span><b>${esc(w.graphVersion || 'v26.0')}</b></div>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn no-grow" onclick="atualizarDadosWa(this)">${ico('refresh', 14)} Atualizar dados</button>
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
        <p class="hint" style="margin-top:12px">Embedded Signup oficial · WhatsApp Business Platform (Cloud API ${esc(s.graphVersion || 'v26.0')})</p>
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
        ${state.agent ? '' : `<button data-tab="conta" onclick="showSettingsTab('conta');loadAccount()">${ico('user', 14)} Minha conta</button>`}
      </div>

      <div class="tabpane" data-pane="finalizacao">
        <div id="sv-box">${skel(5)}</div>
      </div>

      <div class="tabpane" data-pane="atendimento">
        <div class="card">
          <h2>${ico('clock')} Janela de atendimento de 24h</h2>
          <p class="muted" style="margin:0;font-size:13px">Pela regra da Meta, você só pode enviar mensagens livres (texto, imagens, áudios, vídeos, documentos e respostas rápidas) <b>dentro de 24h</b> após a última mensagem do cliente. Fora dela, o Koonfy bloqueia o envio automaticamente e libera <b>apenas Templates aprovados</b>, que reabrem a conversa.</p>
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

      ${state.kind === 'admin' ? `<div class="card">
        <h2>${ico('shield')} Conexão manual (só o administrador)</h2>
        <p class="muted" style="margin:0 0 12px;font-size:13px">
          Ligue o número da plataforma direto pelas credenciais, sem passar pelo
          Embedded Signup. Os clientes não veem isto: para eles existe só o botão
          <b>Conectar WhatsApp</b>.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <label style="grid-column:1/-1">Access Token permanente
            <textarea id="st-token" rows="2" placeholder="EAA…">${esc((state.manual || {}).accessToken || '')}</textarea></label>
          <label>WABA ID<input id="st-waba" value="${esc((state.manual || {}).wabaId || '')}" placeholder="123456789012345"></label>
          <label>Phone Number ID<input id="st-phoneid" value="${esc((state.manual || {}).phoneNumberId || '')}" placeholder="123456789012345"></label>
        </div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary no-grow" onclick="saveManual()">${ico('save', 14)} Salvar e conectar</button>
          <button class="btn no-grow" onclick="subscribeWaba()">${ico('radio', 14)} Assinar app na WABA</button>
          <button class="btn no-grow" onclick="metaDiag(this)">${ico('activity', 14)} Diagnosticar app da Meta</button>
        </div>
        <div id="meta-diag-out"></div>
      </div>` : ''}
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
            <p class="muted" style="margin:2px 0 8px;font-size:12.5px">É a foto que seus clientes veem no WhatsApp. O Koonfy também a usa no topo do painel e nos previews.</p>
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

      <div class="tabpane" data-pane="conta">
        <div id="conta-box">${skel(4)}</div>
      </div>

      <div class="tabpane" data-pane="prefs">
      <div class="card" id="appearance-card">${renderThemeSettings()}</div>
      <div class="card" id="fuso-card">${renderFusoSettings(cfg)}</div>
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

      ${state.agent ? '' : `<a class="card link-card" href="#" onclick="showSettingsTab('conta');loadAccount();return false">
        <span class="lc-ic">${ico('user', 22)}</span>
        <div style="flex:1"><h2 style="margin:0 0 3px">Minha conta</h2>
          <p class="muted" style="margin:0;font-size:13px">Nome, e-mail, senha e verificação em duas etapas ficam na aba <b>Minha conta</b>.</p></div>
        <span class="lc-arrow">${ico('arrowright', 18)}</span>
      </a>` }
      </div>
    </div>`;
  // As credenciais manuais moram em /admin/saas (adminOnly). Buscar aqui deixa
  // o card preenchido sem duplicar a informação em outra rota.
  if (state.kind === 'admin' && !state.manual) {
    api('/admin/saas').then(d => { state.manual = d.manual || {}; renderSettings(); }).catch(() => {});
  }
  paintProfilePhoto();
  loadService();
  loadSurvey();
  if (state.wa && state.wa.connected) { loadCalling(); loadProfile(true); }
  // Conexão ligada mas com o cartão incompleto (Business ID vazio ou webhook
  // marcado como não assinado): busca a verdade na Meta uma vez, sem esperar
  // que a pessoa descubra o botão. Só nesse caso, para não gastar três
  // chamadas à Graph a cada visita.
  if (state.wa && state.wa.connected && (!state.wa.businessId || !state.wa.appSubscribed) && !SETTINGS_RECONCILIADO) {
    SETTINGS_RECONCILIADO = true;
    api('/wa/status?health=1').then(r => { state.wa = r.wa; renderSettings(); }).catch(() => {});
  }
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
            <div><b>${m.avgPercent === null ? '-' : m.avgPercent + '%'}</b><span>Satisfação média</span></div>
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

// Traduz o que a Graph API responde sobre o app. A Meta mostra "Falha ao
// iniciar sessão" para causas bem diferentes; aqui cada uma vira uma linha.
async function metaDiag(btn) {
  const out = $('#meta-diag-out');
  const t = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Consultando a Meta…';
  try {
    const r = await api('/admin/meta/diag');
    const cor = { erro: 'var(--red)', aviso: 'var(--amber)', ok: 'var(--verde-deep)', info: 'var(--muted)' };
    const marca = { erro: 'alert', aviso: 'alert', ok: 'check', info: 'info' };
    out.innerHTML = `<div class="capi-box" style="margin-top:12px">
      <div class="capi-head">${ico('shield', 14)} Diagnóstico do app da Meta
        <span class="capi-tag">${r.ok ? 'sem erro' : 'com erro'}</span></div>
      <div class="meta-diag">${r.achados.map(x => `<div style="color:${cor[x.nivel]}">
        ${ico(marca[x.nivel], 13)} <span>${esc(x.texto)}</span></div>`).join('')}</div>
    </div>`;
  } catch (e) {
    out.innerHTML = `<div class="danger-box" style="margin-top:12px">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.innerHTML = t; }
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
      <div style="flex:1"><h1>Tracking</h1><p>Configure os pixels que disparam nos seus links rastreáveis, no navegador e no servidor (Conversions API)</p></div>
      <button class="btn primary no-grow" onclick="openPixelForm(null)">${ico('plus', 14)} Adicionar pixel</button>
    </div>
    <!-- A MESMA barra do Tracking, com Pixels aceso: as duas telas são a
         mesma seção, e a pessoa troca entre elas sem voltar ao menu. -->
    <div class="tabs">
      <button onclick="location.hash='#/tracking'">Visão geral</button>
      <button onclick="location.hash='#/tracking'">Conexões</button>
      <button onclick="location.hash='#/tracking'">Campanhas</button>
      <button onclick="location.hash='#/tracking'">Funil</button>
      <button onclick="location.hash='#/tracking'">Eventos</button>
      <button onclick="location.hash='#/tracking'">Alertas</button>
      <button class="active" data-tab="px-pixels">Pixels</button>
    </div>
    <div id="px-form"></div>
    <div class="card">
      <h2>${ico('target')} Pixels configurados</h2>
      <p class="muted" style="margin:0 0 14px">Disparados automaticamente nos seus <a href="#/links">links rastreáveis</a>, cada clique vira evento <code>LinkClick</code> (Meta), <code>link_click</code> (Google) e <code>page</code> (TikTok).</p>
      <div id="px-list">${skel(3)}</div>
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
    text: 'O número deixará de enviar e receber mensagens pelo Koonfy até uma nova conexão.',
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

// Reconcilia o cartão da conexão com a Meta: número, nome verificado,
// qualidade, Business ID e se a WABA está assinada. A rota existia desde
// sempre, mas nenhuma tela a chamava — por isso Business ID e "Webhook
// assinado" ficavam parados no que o Embedded Signup tivesse gravado.
async function atualizarDadosWa(btn) {
  const t = btn && btn.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Consultando a Meta…'; }
  try {
    const r = await api('/wa/status?health=1');
    state.wa = r.wa;
    toast(r.health && r.health.error ? ('Meta: ' + r.health.error) : 'Dados atualizados');
    renderSettings();
  } catch (e) { toast(e.message, 'error'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = t; } }
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

// ---------------------------------------------------------------------------
// MINHA CONTA
//
// Reúne o que é da PESSOA e não do WhatsApp: nome, e-mail, senha e o segundo
// fator. Antes a troca de senha morava no fim da aba Preferências, embaixo de
// meia dúzia de cards de outra natureza, e ninguém achava.
// ---------------------------------------------------------------------------
let ACC_INFO = null;

async function loadAccount() {
  const box = $('#conta-box'); if (!box) return;
  try { ACC_INFO = (await api('/account')).account; }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  paintAccount();
}

function paintAccount() {
  const box = $('#conta-box'); if (!box || !ACC_INFO) return;
  const a = ACC_INFO;
  box.innerHTML = `
    <div class="card">
      <h2>${ico('user')} Dados da conta</h2>
      <div class="row">
        <label style="flex:1">Nome<input id="ac-name" value="${esc(a.name)}" maxlength="80"></label>
        <label style="flex:1.4">E-mail de acesso
          <input id="ac-email" value="${esc(a.email)}" inputmode="email" autocomplete="email"></label>
      </div>
      <div class="row" style="align-items:center;margin-top:10px">
        ${a.emailVerified
          ? `<span class="pill done">${ico('check', 12)} E-mail confirmado</span>`
          : `<span class="pill pending">E-mail não confirmado</span>`}
        <div style="flex:1"></div>
        <button class="btn primary no-grow" onclick="saveAccount(this)">${ico('save', 14)} Salvar</button>
      </div>
      ${a.canVerifyEmail && !a.emailVerified ? `
      <div class="capi-box" style="margin-top:14px">
        <div class="capi-head">${ico('mail', 14)} Confirmar e-mail</div>
        <p class="muted" style="font-size:12px;margin:6px 0 10px">
          Confirmar o endereço é o que permite recuperar o acesso e ligar a verificação em duas etapas.</p>
        <div class="row">
          <button class="btn small no-grow" onclick="sendEmailCode(this)">Enviar código</button>
          <label style="flex:1"><input id="ac-code" inputmode="numeric" maxlength="6" placeholder="000000"></label>
          <button class="btn small primary no-grow" onclick="verifyEmailCode(this)">Confirmar</button>
        </div>
      </div>` : ''}
    </div>

    <div class="card">
      <h2>${ico('lock')} Senha de acesso ${state.mustChangePassword ? '<span class="bad-dot">(troque a senha padrão!)</span>' : ''}</h2>
      <div class="row">
        <label>Senha atual<input id="pw-cur" type="password" autocomplete="current-password"></label>
        <label>Nova senha (mín. 6)<input id="pw-new" type="password" autocomplete="new-password"></label>
        <button class="btn primary no-grow" onclick="changePass()">Alterar senha</button>
      </div>
    </div>

    ${a.twoFactorAvailable || a.twoFactor ? `
    <div class="card">
      <h2>${ico('shield')} Verificação em duas etapas</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        Com isto ligado, entrar na conta pede um código enviado para o seu e-mail,
        além da senha. Uma senha vazada deixa de ser suficiente para entrar.</p>
      <label class="chk"><input type="checkbox" ${a.twoFactor ? 'checked' : ''}
        onchange="setTwoFactor(this)"> Exigir código por e-mail ao entrar</label>
    </div>` : `
    <div class="card">
      <h2>${ico('shield')} Verificação em duas etapas</h2>
      <p class="muted" style="margin:0;font-size:13px">${
        a.twoFactorBlockedBy === 'plataforma' ? 'Este recurso ainda não foi habilitado pela plataforma.'
        : a.twoFactorBlockedBy === 'email' ? 'O envio de e-mail ainda não foi configurado pela plataforma.'
        : 'Confirme seu e-mail acima para liberar a verificação em duas etapas.'}</p>
    </div>`}

    ${state.kind === 'account' ? `<div class="card danger-card">
      <h2>${ico('trash')} Excluir minha conta</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        Apaga definitivamente sua conta e <b>tudo que está nela</b>: conversas, contatos,
        mensagens, automações, agendamentos e atendentes. Não há como desfazer nem recuperar depois.</p>
      <button class="btn danger no-grow" onclick="deleteAccountModal()">Excluir minha conta</button>
    </div>` : ''}`;
}

async function saveAccount(btn) {
  btn.disabled = true;
  try {
    const r = await api('/account', { method: 'PUT', body: { name: $('#ac-name').value, email: $('#ac-email').value } });
    ACC_INFO = r.account;
    state.user = ACC_INFO.name;
    toast('Dados salvos');
    paintAccount();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function sendEmailCode(btn) {
  const t = btn.innerHTML; btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const r = await api('/account/email/send-code', { body: {} });
    ACC_INFO = r.account;
    toast('Código enviado para ' + ACC_INFO.email);
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = t; }
}

async function verifyEmailCode(btn) {
  btn.disabled = true;
  try {
    const r = await api('/account/email/verify', { body: { code: $('#ac-code').value.trim() } });
    ACC_INFO = r.account;
    toast('E-mail confirmado!');
    paintAccount();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

async function setTwoFactor(el) {
  const querLigar = el.checked;
  el.disabled = true;
  try {
    const r = await api('/account/2fa', { method: 'PUT', body: { enabled: querLigar } });
    ACC_INFO = r.account;
    toast(querLigar ? 'Verificação em duas etapas ligada' : 'Verificação em duas etapas desligada');
    paintAccount();
  } catch (e) { toast(e.message, 'error'); el.checked = !querLigar; el.disabled = false; }
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
      <b>Não é possível desfazer.</b> Se você tem uma assinatura ativa, cancele-a antes 
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
  pagamentos: 'Pagamentos', 'pagamentos/checkout': 'Checkout Builder', checkouts: 'Checkout Builder', tracking: 'Tracking',
  schedule: 'Agendamentos', consent: 'Opt-in & Opt-out', pixels: 'Tracking',
  agents: 'Atendentes', billing: 'Assinatura & Carteira', admin: 'Admin SaaS', sms: 'Disparos de SMS',
  'templates/new': 'Criar modelo', 'campaigns/new': 'Nova campanha'
};
function updateTopbar() {
  const t = $('#tb-title');
  if (t) t.textContent = TITLES[state.view] || 'Koonfy';
  markTabbarActive();   // o destino aceso na barra de baixo segue a rota
}

// ==================== GRÁFICOS (SVG puro, sem libs) ====================
function fmtN(n) { return new Intl.NumberFormat('pt-BR').format(n || 0); }
// centavos → "R$ 97,00"
function fmtBRL(cents) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100); }
// ---------------------------------------------------------------------------
// NÚMERO CURTO para os cartões de KPI.
//
// "R$ 1.284.390,00" não cabe embaixo do ícone do cartão e o valor ficava
// tapado. Aqui ele vira "R$ 1,2M" e o valor exato fica no title (o balãozinho
// do navegador ao passar o mouse) — ver `kpiNum()`.
//
// Só encurta quando precisa: até R$ 9.999,99 o valor aparece inteiro, porque
// "R$ 1,2K" é pior de ler que "R$ 1.234,50" e o espaço dá conta.
// ---------------------------------------------------------------------------
function curto(n, casas) {
  const abs = Math.abs(n);
  const corta = (div, suf) => {
    const v = n / div;
    // 1 casa decimal, mas sem ",0" pendurado: 20,5K e 20K, não 20,0K.
    const s = v.toFixed(Math.abs(v) >= 100 ? 0 : (casas === undefined ? 1 : casas));
    // Só corta o zero DEPOIS da vírgula: "20.0"→"20", mas "250" continua 250.
    return s.replace(/\.0+$/, '').replace('.', ',') + suf;
  };
  // O corte é 999,5 e não 1000: acima disso o arredondamento para inteiro dá
  // "1000" e sairia "R$ 1000M" em vez de "R$ 1B".
  if (abs >= 999.5e6) return corta(1e9, 'B');
  if (abs >= 999.5e3) return corta(1e6, 'M');
  if (abs >= 999.5) return corta(1e3, 'K');
  return fmtN(n);
}
// centavos → "R$ 20,5K" (a partir de dez mil reais; abaixo disso, valor cheio)
function fmtBRLk(cents) {
  const reais = (cents || 0) / 100;
  // Espaço RÍGIDO depois do "R$": em tela estreita a linha quebrava entre o
  // símbolo e o número, e o valor virava duas linhas dentro do cartão.
  return Math.abs(reais) < 10000 ? fmtBRL(cents) : 'R$ ' + curto(reais);
}
// contagem → "12.480" vira "12,5K" só quando passa de cinco dígitos
function fmtNk(n) { return Math.abs(n || 0) < 100000 ? fmtN(n) : curto(n); }
// O <div class="num"> do cartão, com o valor exato no balãozinho do navegador.
// `title` só aparece quando encurtou — senão o balão repetiria o que já se lê.
function kpiNum(curtoTxt, exato, cls) {
  const t = curtoTxt !== exato ? ` title="${esc(exato)}"` : '';
  return `<div class="num${cls ? ' ' + cls : ''}"${t}>${curtoTxt}</div>`;
}
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

// A grade vazia: eixo, linhas de apoio e nada em cima. É o que um dia sem
// movimento deve mostrar — zero é um número, não a ausência de resposta.
function chVazio(h = 240) {
  const w = 560, padB = 22;
  const grid = [0.25, 0.5, 0.75].map(f =>
    `<line x1="0" y1="${(h - padB) * f}" x2="${w}" y2="${(h - padB) * f}" stroke="#e8f3ec" stroke-dasharray="3 4"/>`).join('');
  return `<svg class="ch" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Sem movimento no período">
    ${grid}<line x1="0" y1="${h - padB}" x2="${w}" y2="${h - padB}" stroke="#e8f3ec"/>
    <text x="${w / 2}" y="${(h - padB) / 2}" text-anchor="middle" dominant-baseline="middle"
          style="font:600 13px 'Inter Tight'" fill="var(--faint)">Sem movimento no período</text>
  </svg>`;
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
    <defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2ED378" stop-opacity=".22"/><stop offset="1" stop-color="#2ED378" stop-opacity="0"/></linearGradient></defs>
    ${grid}${labels}
    <path d="${area}" fill="url(#gA)"/>
    <polyline points="${line('out')}" fill="none" stroke="#2ED378" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <polyline points="${line('in')}" fill="none" stroke="#53BDEB" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function spark(values, color = '#2ED378', w = 110, h = 30) {
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

// ---------------------------------------------------------------------------
// FUNIL DE VENDAS — trapézios empilhados, no formato de funil de verdade
//
// Substitui as barras horizontais que havia aqui: elas mostravam os números
// certos, mas não pareciam um funil — a silhueta que faz a pessoa entender de
// relance onde o lead trava.
//
// A largura de cada etapa é FIXA e decrescente (não proporcional ao volume),
// como no desenho de referência. É de propósito: com uma etapa em 2 e as
// outras em 0, o proporcional achata tudo numa tira e o gráfico não comunica
// nada. A silhueta mostra a JORNADA; os números e as porcentagens ao lado
// mostram o volume.
//
// Clicar numa etapa abre o detalhe (volume, conversão e quantos vieram da
// etapa anterior), como no protótipo.
// ---------------------------------------------------------------------------
// Paleta padrão do funil — uma cor por etapa, como no desenho de referência.
// Cada etapa com a sua cor separa as fases melhor que seis tons do mesmo verde,
// onde as três últimas ficavam quase iguais.
//
// O admin troca isto em Admin → Personalização; as variáveis --funil-N chegam
// por /tema.css e, quando existem, mandam.
const FUNIL_PADRAO = ['#ec4899', '#64748b', '#f59e0b', '#0ea5e9', '#10b981', '#16a34a'];

function funilCores(i, n) {
  const raiz = getComputedStyle(document.documentElement);
  const quantas = Number(raiz.getPropertyValue('--funil-n')) || 0;
  const doTema = quantas ? (raiz.getPropertyValue(`--funil-${(i % quantas) + 1}`) || '').trim() : '';
  const base = doTema || FUNIL_PADRAO[i % FUNIL_PADRAO.length];
  // Com MAIS etapas que cores, a paleta repete — e as repetidas escurecem um
  // passo, para duas etapas com a mesma cor não parecerem a mesma etapa.
  const volta = Math.floor(i / (quantas || FUNIL_PADRAO.length));
  const escuro = volta ? ` color-mix(in srgb, ${base} ${Math.max(40, 100 - volta * 22)}%, #000)` : ` ${base}`;
  return [escuro.trim(), `color-mix(in srgb, ${escuro.trim()} 78%, #000)`];
}

function funnelChart(stages) {
  if (!stages || !stages.length) return '<p class="muted">Sem etapas.</p>';
  const n = stages.length;
  const first = stages[0].count || 0;
  const larguras = stages.map((_, i) => 100 - (i * (n > 1 ? 46 / (n - 1) : 0)));  // 100% → 54%
  return `<div class="funil" onclick="funilToggle(event)">${stages.map((s, i) => {
    const conv = first ? Math.round(s.count / first * 100) : 0;   // conversão desde a 1ª etapa
    const prev = i > 0 ? stages[i - 1].count : null;
    const passo = (prev != null && prev > 0) ? Math.round(s.count / prev * 100) : null;
    const drop = (prev != null && prev > 0 && s.count < prev) ? Math.round((prev - s.count) / prev * 100) : null;
    const [c1, c2] = funilCores(i, n);
    const ultima = i === n - 1;
    return `<div class="fn-etapa" data-i="${i}" style="width:${larguras[i].toFixed(1)}%">
      <div class="fn-forma" style="background:linear-gradient(160deg,${c1},${c2});
           clip-path:polygon(0 0, 100% 0, ${ultima ? '92% 100%, 8%' : '94% 100%, 6%'} 100%)">
        <span class="fn-nome">${esc(s.stage)}</span>
        <b class="fn-num">${fmtNk(s.count)}</b>
        ${passo != null ? `<span class="fn-taxa">${passo}% da anterior</span>` : ''}
      </div>
      ${drop != null && drop > 0 ? `<span class="fn-queda" title="Queda em relação à etapa anterior">▼ ${drop}%</span>` : ''}
      <div class="fn-detalhe"><div class="fn-det-in">
        <div class="fn-det-linha"><span>Volume</span><b>${fmtN(s.count)}</b></div>
        <div class="fn-det-linha"><span>Conversão desde ${esc(stages[0].stage)}</span><b class="ok">${conv}%</b></div>
        ${i > 0 ? `<div class="fn-det-nota">${fmtN(s.count)} de ${fmtN(prev)} avançaram de <b>${esc(stages[i - 1].stage)}</b> para cá</div>` : ''}
      </div></div>
    </div>`;
  }).join('')}</div>`;
}

// Uma etapa aberta por vez: duas abertas empurram o cartão e a silhueta do
// funil se perde no meio dos detalhes.
function funilToggle(ev) {
  const et = ev.target.closest('.fn-etapa'); if (!et) return;
  const abrir = !et.classList.contains('aberta');
  et.closest('.funil').querySelectorAll('.fn-etapa.aberta').forEach(e => e.classList.remove('aberta'));
  if (abrir) et.classList.add('aberta');
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

// A PLACA DO MAPA usa o MESMO gradiente dos cards do modo escuro (--card-grad,
// 160deg). Em SVG não dá para apontar para uma variável de gradiente do CSS,
// então ele é redesenhado aqui com as mesmas paradas — as cores vêm de
// variáveis, e é o tema que troca.
//
// `userSpaceOnUse` NÃO é detalhe: no padrão (objectBoundingBox) cada estado
// receberia o seu próprio gradiente e o país viraria um mosaico de 27 placas
// com emenda em cada divisa. Assim é UMA superfície, e o degradê atravessa o
// Brasil inteiro como atravessa um card.
function geoPlacaGrad() {
  const [, , W, H] = geoViewBox().split(' ').map(Number);
  // 160deg do CSS: o vetor aponta para (sen θ, -cos θ), ou seja, direita e para
  // baixo. O comprimento da linha do degradê é a projeção da caixa nesse vetor.
  const t = 160 * Math.PI / 180, dx = Math.sin(t), dy = -Math.cos(t);
  const L = Math.abs(W * dx) + Math.abs(H * dy);
  const cx = W / 2, cy = H / 2;
  const x1 = (cx - dx * L / 2).toFixed(1), y1 = (cy - dy * L / 2).toFixed(1);
  const x2 = (cx + dx * L / 2).toFixed(1), y2 = (cy + dy * L / 2).toFixed(1);
  return `<linearGradient id="geo-placa" gradientUnits="userSpaceOnUse"
      x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">
    <stop offset="0" stop-color="var(--geo-placa-1)"/>
    <stop offset=".62" stop-color="var(--geo-placa-2)"/>
    <stop offset="1" stop-color="var(--geo-placa-3)"/>
  </linearGradient>`;
}

// A RAMPA DE CALOR. Era um verde só, em opacidades diferentes — e um verde só
// obriga o olho a comparar SATURAÇÃO entre estados que não se tocam, que é a
// comparação que a vista humana faz pior. Com quatro matizes, dois estados
// distantes se comparam por COR, que é imediato.
//
// A ordem das paradas não é decorativa: a luminância sobe do frio ao quente
// (0,32 → 0,49 → 0,65 → 0,75). É o que mantém a escala legível em preto e
// branco e para quem não distingue verde de vermelho — a intensidade continua
// dizendo a mesma coisa que a cor.
//
// O verde da marca fica no MEIO, e não numa ponta: ele é o centro de gravidade
// do mapa, e as pontas são o desvio para menos e para mais.
const GEO_RAMPA = [
  [0.00, [0x22, 0xA5, 0xD6]],   // azul-piscina: frio, poucos leads
  [0.33, [0x2E, 0xD3, 0x78]],   // verde Koonfy
  [0.66, [0xA3, 0xE6, 0x35]],   // lima
  [1.00, [0xFD, 0xE0, 0x47]]    // ouro: quente, onde a venda está
];
function geoCorDoCalor(frac) {
  const f = Math.max(0, Math.min(1, frac));
  let i = 0;
  while (i < GEO_RAMPA.length - 2 && f > GEO_RAMPA[i + 1][0]) i++;
  const [f0, c0] = GEO_RAMPA[i], [f1, c1] = GEO_RAMPA[i + 1];
  const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0);
  const m = c0.map((v, k) => Math.round(v + (c1[k] - v) * t));
  return '#' + m.map(v => v.toString(16).padStart(2, '0')).join('');
}

// A LEGENDA. Com um matiz só dava para adivinhar que mais escuro era mais; com
// quatro, não dá — e um mapa que precisa ser adivinhado não informa. A faixa
// usa a MESMA função de cor do mapa, então nunca sai de sincronia com ele.
// Só aparece quando há o que legendar: num mapa vazio ela seria uma escala
// para nenhum dado.
function geoLegenda(max) {
  if (!max) return '';
  const paradas = [];
  for (let i = 0; i <= 10; i++) paradas.push(`${geoCorDoCalor(i / 10)} ${i * 10}%`);
  return `<div class="geo-legenda">
    <span>menos</span>
    <i style="background:linear-gradient(90deg, ${paradas.join(', ')})"></i>
    <span>mais</span>
    <b>${fmtN(max)}</b>
  </div>`;
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
  const defs = geoPlacaGrad() + ufs.map(uf => `<path id="geo-p-${uf}" d="${BR_UF_PATHS[uf]}"/>`).join('');

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
    // MAPA DE CALOR: uma única escala de verde Koonfy, do frio ao quente.
    // DUAS coisas crescem juntas: o MATIZ percorre a rampa (frio → quente) e a
    // OPACIDADE vai de 22% a 92%. A opacidade é o que faz a mesma rampa servir
    // aos dois temas sem JS ciente do tema: no claro o estado fraco quase some
    // no branco, no escuro quase some na placa, e o forte grita nos dois.
    //
    // O estado COM leads leva a tinta aqui, porque a intensidade é dado. O
    // VAZIO não leva nenhuma: quem pinta é o CSS, que sabe o tema. Era daí que
    // vinha o "verde musgo": 7% de verde sobre um card quase preto não dá um
    // verde discreto, dá #18291d — e o mapa de uma conta nova está TODO vazio.
    const paint = count
      ? `fill="${geoCorDoCalor(frac)}" fill-opacity="${(0.22 + frac * 0.70).toFixed(3)}"`
      : '';
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

  // O relatório da campanha quer SÓ o desenho: ele tem a própria tabela por
  // estado, e os blocos laterais do Dashboard (origem do tráfego, top 5)
  // apareciam vazios ou repetindo a tabela logo abaixo. `g.soMapa` corta.
  if (g.soMapa) {
    return `<div class="geo-map geo-solo">
      <svg viewBox="${geoViewBox()}" style="width:100%;height:auto">${svg}</svg>
      <div class="geo-tip" id="geo-tip" aria-hidden="true"></div>
      ${geoLegenda(Object.keys(counts).length ? max : 0)}
    </div>`;
  }

  const top5 = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxSrc = Math.max(1, ...(g.sources || []).map(s => s.count));
  const maxRef = Math.max(1, ...(g.referrers || []).map(r => r.count));
  return `
    <div class="geo-map">
      <svg viewBox="${geoViewBox()}" style="width:100%;height:auto">${svg}</svg>
      <div class="geo-tip" id="geo-tip" aria-hidden="true"></div>
      ${g.brTotal ? geoLegenda(max) : '<p class="muted geo-empty">Sem leads brasileiros localizados ainda, os estados acendem conforme os contatos chegam pelo WhatsApp.</p>'}
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
function dayBars(series, color = '#2ED378') {
  const max = Math.max(1, ...series.map(d => d.count));
  const fmtD = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
  return `<div class="hbars" style="height:130px">${series.map(d =>
    `<div class="hb" style="height:${Math.max(3, d.count / max * 100)}%;background:${color}" title="${fmtD(d.date)}, ${d.count}"></div>`).join('')}</div>
  <div class="hbars-x"><span>${fmtD(series[0].date)}</span><span>${fmtD(series[Math.floor(series.length / 2)].date)}</span><span>${fmtD(series[series.length - 1].date)}</span></div>`;
}

// Volume in/out com 3 tipos de gráfico (linha, barras, área) — escolha do usuário
function chVolume(days, kind = 'bars', h = 240) {
  // Período sem dia nenhum não é erro, é um dia que ainda não começou: a
  // grade aparece vazia em vez de o gráfico inteiro sumir.
  if (!days || !days.length) return chVazio(h);
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
      <defs><linearGradient id="gvb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#50EA5F"/><stop offset="1" stop-color="#178048"/></linearGradient></defs>
      ${grid}${bars}${labels}</svg>`;
  }
  // área dupla
  const pt = (v, i) => `${(i / Math.max(1, days.length - 1) * w).toFixed(1)},${(h - padB - v / max * (h - padB - 10)).toFixed(1)}`;
  const lineOut = days.map((d, i) => pt(d.out, i)).join(' ');
  const lineIn = days.map((d, i) => pt(d.in, i)).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto" class="chv">
    <defs>
      <linearGradient id="gaO" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2ED378" stop-opacity=".30"/><stop offset="1" stop-color="#2ED378" stop-opacity="0"/></linearGradient>
      <linearGradient id="gaI" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#53BDEB" stop-opacity=".25"/><stop offset="1" stop-color="#53BDEB" stop-opacity="0"/></linearGradient>
    </defs>
    ${grid}
    <polygon points="0,${h - padB} ${lineIn} ${w},${h - padB}" fill="url(#gaI)"/>
    <polyline points="${lineIn}" fill="none" stroke="#53BDEB" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <polygon points="0,${h - padB} ${lineOut} ${w},${h - padB}" fill="url(#gaO)"/>
    <polyline points="${lineOut}" fill="none" stroke="#2ED378" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    ${labels}</svg>`;
}

function hrow(label, val, max, suffix = '') {
  const pct = max ? Math.round(val / max * 100) : 0;
  return `<div class="hrow"><span class="hl">${label}</span><div class="track"><div class="fill" style="width:${pct}%"></div></div><span class="hv">${fmtN(val)}${suffix}</span></div>`;
}

function deltaChip(cur, prev) {
  if (!prev && !cur) return '<span class="delta flat">-</span>';
  if (!prev) return '<span class="delta up">novo</span>';
  const p = Math.round((cur - prev) / prev * 100);
  if (p > 0) return `<span class="delta up">▲ ${p}%</span>`;
  if (p < 0) return `<span class="delta down">▼ ${Math.abs(p)}%</span>`;
  return '<span class="delta flat">0%</span>';
}

// ==================== RELATÓRIOS ====================
async function renderReports(daysOverride) {
  // O período é global agora (state.periodo). O parâmetro fica por
  // compatibilidade: chamadas antigas passavam um número de dias.
  if (typeof daysOverride === 'number') periodoSalvar({ dias: daysOverride });
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Relatórios</h1><p>Desempenho de envios, entregas e atendimento</p></div>
      ${periodoSeletor()}
    </div>
    <div id="rep"><div class="card">${skel(6)}</div></div>
  </div>`;
  try {
    const r = await api('/reports?' + periodoQuery());
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
            <span class="legend"><i style="background:#2ED378"></i> Enviadas</span>
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
      <a class="btn no-grow" href="#/campaigns/mapa">${ico('globe', 14)} Mapa de leads</a>
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
          <td><a class="btn small" href="#/campaigns/report?c=${c.id}">Ver relatório</a></td>
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
            <label style="flex:1">Público${ecSelect('cp-aud', [
              { value: 'all', label: 'Todos os contatos' },
              { value: 'stage', label: 'Etapas do funil' },
              { value: 'tag', label: 'Tags' },
              // A origem se mantém sozinha: cada evento da loja marca o
              // contato, inclusive quem já existia antes de comprar.
              { value: 'nuvemshop', label: 'Base da Nuvemshop' },
              { value: 'nuvemshop_comprou', label: 'Compradores da Nuvemshop' }
            ], 'all', 'campAudChanged()')}</label>
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
  } else if (v === 'nuvemshop' || v === 'nuvemshop_comprou') {
    // Não há o que marcar: o filtro é a própria origem. O que cabe aqui é
    // dizer QUEM é esse público, senão "Base da Nuvemshop" é um nome sem
    // conteúdo e ninguém dispara com segurança.
    const daLoja = contacts.filter(c => (c.ns && c.ns.storeId) || (c.source && c.source.type === 'nuvemshop'));
    const compradores = contacts.filter(c => c.ns && (c.ns.pedidos || 0) > 0);
    const alvo = v === 'nuvemshop' ? daLoja : compradores;
    const quem = v === 'nuvemshop'
      ? 'Contatos vindos da sua loja: por pedido, por cadastro ou pela importação da base.'
      : 'Contatos com pelo menos uma compra aprovada na loja.';
    box.innerHTML = alvo.length
      ? `<p class="muted" style="font-size:12.5px;margin:0">${quem} <b>${fmtN(alvo.length)}</b> contato(s).</p>`
      : `<p class="muted" style="font-size:12.5px;margin:0">Nenhum contato da loja ainda. Conecte a loja e importe a base em <a href="#/nuvemshop">Nuvemshop, Clientes</a>.</p>`;
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
  // Mesma conta que o servidor faz, para o número na tela não mentir.
  if (v === 'nuvemshop') n = contacts.filter(c => (c.ns && c.ns.storeId) || (c.source && c.source.type === 'nuvemshop')).length;
  if (v === 'nuvemshop_comprou') n = contacts.filter(c => c.ns && (c.ns.pedidos || 0) > 0).length;
  el.innerHTML = `${ico('users', 13)} Alcance: <b>${fmtN(n)}</b> contato(s)`;
  el.classList.toggle('empty', n === 0);
}

async function createCampaign() {
  const t = window._campTpls[+ecSelVal('cp-tpl')];
  const audType = ecSelVal('cp-aud');
  const values = [...(window._campSel || [])];
  // Os públicos de ORIGEM não têm o que marcar: o filtro é a própria origem.
  const porOrigem = audType === 'nuvemshop' || audType === 'nuvemshop_comprou';
  if (audType !== 'all' && !porOrigem && !values.length) {
    return toast(audType === 'stage' ? 'Marque pelo menos uma etapa do funil' : 'Marque pelo menos uma tag', 'error');
  }
  const audience = audType === 'all' ? { type: 'all' }
    : porOrigem ? { type: 'origem', values: [audType] }
    : { type: audType, values };
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

// ===========================================================================
// RELATÓRIO DA CAMPANHA
//
// O funil de um disparo é: enviada → entregue → LIDA → clicou. As duas últimas
// são as que dizem se a mensagem funcionou, e eram as que não apareciam.
//
// O MAPA responde "onde estão os leads mais quentes". Quente aqui não é quem
// recebeu — é quem LEU e CLICOU; por isso o mapa é pintado pela métrica que se
// escolhe, e não sempre pelo volume, que só mostra onde há mais gente.
// ===========================================================================
let RC = { id: null, rel: null, metrica: 'cliques', ordem: 'total', filtro: '' };

const RC_METRICAS = [
  ['total', 'Leads (enviadas)'],
  ['entregues', 'Entregues'],
  ['lidas', 'Lidas'],
  ['cliques', 'Clicaram'],
  ['taxaLeitura', '% que leu'],
  ['taxaClique', '% que clicou'],
  ['ctrSobreLidas', 'CTR sobre quem leu']
];
const RC_PCT = new Set(['taxaLeitura', 'taxaClique', 'ctrSobreLidas']);
const rcVal = (e, k) => (RC_PCT.has(k) ? e[k] + '%' : fmtN(e[k]));

async function renderCampaignReport() {
  const id = new URLSearchParams((location.hash.split('?')[1] || '')).get('c');
  if (!id) { location.hash = '#/campaigns'; return; }
  RC.id = id;
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(6)}</div></div>`;
  try {
    RC.rel = await api('/campaigns/' + id + '/report');
    RC.filtro = '';
    pintarRelatorio();
  } catch (e) {
    $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`;
  }
}

// AO VIVO. Chega um evento por destinatário processado; aqui só os números
// são atualizados. Remontar a tela a cada evento apagaria o filtro digitado,
// devolveria a rolagem ao topo e mataria a animação — 2 mil vezes num disparo
// de 2 mil contatos.
async function rcAoVivo() {
  if (!RC.id || !document.getElementById('rc-core')) return;
  if (RC._buscando) return;
  RC._buscando = true;
  try { RC.rel = await api('/campaigns/' + RC.id + '/report'); } catch (e) { RC._buscando = false; return; }
  RC._buscando = false;
  rcAtualizar();
}

function rcAtualizar() {
  const r = RC.rel;
  KoonfyBI.pintar($('#rc-core'), r);
  const selo = $('#rc-selo');
  if (selo) selo.outerHTML = rcSelo(r);
  const tab = $('#rc-tabela'); if (tab) tab.innerHTML = rcTabela();
  // O MAPA só é redesenhado quando os números mudam de verdade: ele monta um
  // SVG inteiro, e refazê-lo a cada evento pisca a tela sem dizer nada novo.
  const mapa = $('#rc-mapa');
  const chave = JSON.stringify(rcMapaCounts());
  if (mapa && mapa.dataset.chave !== chave) {
    mapa.dataset.chave = chave;
    mapa.innerHTML = brazilMap3D({ states: rcMapaCounts(), soMapa: true });
  }
}

// Enquanto o disparo corre, o selo pulsa; terminado, ele só informa.
function rcSelo(r) {
  const rodando = r.status !== 'done';
  return `<span class="bi-vivo${rodando ? '' : ' fim'}" id="rc-selo"><i></i>${rodando ? 'ao vivo' : 'concluída'}</span>`;
}

function pintarRelatorio() {
  const r = RC.rel;
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row" style="align-items:center">
      <a class="btn no-grow" href="#/campaigns">${ico('arrowleft', 14)} Voltar</a>
      <div style="flex:1">
        <h1>${esc(r.nome)}</h1>
        <p>Modelo <code>${esc(r.template)}</code>${r.canal ? ' · ' + esc(r.canal) : ''} · ${fmtDataHora(r.criadaEm)}</p>
      </div>
      ${rcSelo(r)}
    </div>

    <div class="card" id="rc-share"></div>

    <!-- O MIOLO. Desenhado por /bi.js, o mesmo arquivo que desenha a página
         pública do link de acompanhamento: quem dispara precisa saber
         exatamente o que o cliente dele está vendo. -->
    <div id="rc-core"></div>

    <div class="card">
      <div class="row" style="align-items:center;margin-bottom:12px">
        <h2 style="flex:1;margin:0">${ico('globe')} Mapa de leads</h2>
        <label style="margin:0">Pintar por
          ${ecSelect('rc-metrica', RC_METRICAS.map(([v, l]) => ({ value: v, label: l })), RC.metrica, 'rcSetMetrica(val)')}
        </label>
      </div>
      <p class="muted" style="margin:0 0 10px;font-size:12.5px">Quanto mais escuro, maior o valor da métrica escolhida.
      Passe o mouse num estado para ver o número exato.</p>
      <div id="rc-mapa">${brazilMap3D({ states: rcMapaCounts(), soMapa: true })}</div>
    </div>

    <div class="card">
      <div class="row" style="align-items:center;margin-bottom:12px">
        <h2 style="flex:1;margin:0">${ico('list')} Por estado</h2>
        <input id="rc-busca" placeholder="Filtrar estado…" value="${esc(RC.filtro)}" oninput="rcFiltrar(this.value)" style="max-width:200px">
        <label style="margin:0">Ordenar por
          ${ecSelect('rc-ordem', RC_METRICAS.map(([v, l]) => ({ value: v, label: l })), RC.ordem, 'rcSetOrdem(val)')}
        </label>
      </div>
      <div id="rc-tabela">${rcTabela()}</div>
      ${r.semUf ? `<p class="muted" style="margin:10px 0 0;font-size:12px">${fmtN(r.semUf.total)} contato(s) sem estado identificado
      (número de fora do Brasil ou sem DDD reconhecível) ficam fora do mapa.</p>` : ''}
    </div>
  </div>`;
  $('#rc-mapa').dataset.chave = JSON.stringify(rcMapaCounts());
  KoonfyBI.pintar($('#rc-core'), r);
  rcShare();
}

// ---------------------------------------------------------------------------
// LINK DE ACOMPANHAMENTO
//
// Quem dispara para outras empresas precisa mostrar o resultado a quem
// contratou, e quem contratou não tem conta no painel. O link é um endereço
// só de leitura desta campanha, ao vivo.
//
// O TELEFONE SAI MASCARADO por padrão. Um link é um portador: quem tem o
// endereço vê. A base de contatos é o ativo do cliente, e um endereço
// repassado num grupo vira vazamento. Quem quiser mostrar o número inteiro
// liga a opção aqui, e assume.
// ---------------------------------------------------------------------------
function rcShare() {
  const cx = $('#rc-share'); if (!cx) return;
  const sh = RC.rel.share;
  const url = sh ? location.origin + '/campanha/' + sh.token : '';
  cx.innerHTML = `
    <h2 style="margin:0 0 6px">${ico('link')} Link de acompanhamento</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">Um endereço só de leitura desta campanha, ao vivo, para mandar a quem contratou o disparo. Quem abrir não precisa de conta e vê os telefones ${sh && sh.telefones ? '<b>inteiros</b>' : '<b>mascarados</b>'}.</p>
    ${sh ? `<div class="copy-box"><code id="rc-url">${esc(url)}</code>
        <button class="btn small" onclick="copyText($('#rc-url').textContent)">Copiar</button>
        <a class="btn small" href="${esc(url)}" target="_blank" rel="noopener">Abrir</a>
        <button class="btn small danger" onclick="rcRevogar()">Revogar</button></div>` : `
      <label class="chk" style="margin-bottom:10px"><input type="checkbox" id="rc-fones"> <span>Mostrar os telefones inteiros para quem abrir o link</span></label>
      <button class="btn primary no-grow" onclick="rcGerarLink()">${ico('link', 14)} Gerar link</button>`}`;
}

async function rcGerarLink() {
  const telefones = !!($('#rc-fones') && $('#rc-fones').checked);
  try {
    const r = await api('/campaigns/' + RC.id + '/share', { method: 'POST', body: { telefones } });
    RC.rel.share = r.share;
    rcShare();
    toast('Link criado');
  } catch (e) { toast(e.message, 'err'); }
}

async function rcRevogar() {
  if (!await confirmModal({ title: 'Revogar link', text: 'Quem já tem o endereço deixa de ver esta campanha. Você pode gerar um novo depois.', ok: 'Revogar', danger: true })) return;
  try {
    await api('/campaigns/' + RC.id + '/share', { method: 'DELETE' });
    RC.rel.share = null;
    rcShare();
    toast('Link revogado');
  } catch (e) { toast(e.message, 'err'); }
}
function rcMapaCounts() {
  const out = {};
  for (const e of RC.rel.estados) {
    if (RC_PCT.has(RC.metrica) && e.enviadas < 5) continue;
    out[e.uf] = e[RC.metrica] || 0;
  }
  return out;
}

function rcTabela() {
  const q = RC.filtro.trim().toLowerCase();
  const linhas = RC.rel.estados
    .filter(e => !q || e.uf.toLowerCase().includes(q) || e.nome.toLowerCase().includes(q))
    .sort((a, b) => b[RC.ordem] - a[RC.ordem]);
  if (!linhas.length) return '<p class="muted" style="margin:0;font-size:13px">Nenhum estado com esse filtro.</p>';
  const max = Math.max(1, ...linhas.map(e => e[RC.ordem]));
  return `<table><thead><tr>
      <th>Estado</th><th style="text-align:right">Leads</th><th style="text-align:right">Entregues</th>
      <th style="text-align:right">Lidas</th><th style="text-align:right">Clicaram</th>
      <th style="text-align:right">% leu</th><th style="text-align:right">% clicou</th><th></th>
    </tr></thead><tbody>
    ${linhas.map(e => `<tr>
      <td><b>${e.uf}</b> <span class="muted">${esc(e.nome)}</span></td>
      <td style="text-align:right">${fmtN(e.total)}</td>
      <td style="text-align:right">${fmtN(e.entregues)}</td>
      <td style="text-align:right">${fmtN(e.lidas)}</td>
      <td style="text-align:right"><b>${fmtN(e.cliques)}</b></td>
      <td style="text-align:right">${e.taxaLeitura}%</td>
      <td style="text-align:right"><b>${e.taxaClique}%</b></td>
      <td style="width:110px"><div class="rc-bar"><i style="width:${Math.round((e[RC.ordem] / max) * 100)}%"></i></div></td>
    </tr>`).join('')}
  </tbody></table>`;
}

// Trocar a métrica repinta SÓ o mapa: remontar a tela apagaria o filtro
// digitado ao lado e devolveria a rolagem ao topo.
function rcSetMetrica(v) {
  RC.metrica = v;
  const mapa = $('#rc-mapa'); if (!mapa) return;
  mapa.dataset.chave = JSON.stringify(rcMapaCounts());
  mapa.innerHTML = brazilMap3D({ states: rcMapaCounts(), soMapa: true });
}
function rcSetOrdem(v) { RC.ordem = v; const t = $('#rc-tabela'); if (t) t.innerHTML = rcTabela(); }
function rcFiltrar(v) { RC.filtro = v; const t = $('#rc-tabela'); if (t) t.innerHTML = rcTabela(); }

// Mapa consolidado de TODAS as campanhas do período — para achar o estado mais
// quente sem abrir campanha por campanha.
let RM = { dados: null, dias: 90, metrica: 'cliques', ordem: 'total', filtro: '' };

async function renderMapaLeads() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(6)}</div></div>`;
  try {
    RM.dados = await api('/campaigns/mapa?dias=' + RM.dias);
    RC.rel = { estados: RM.dados.estados, semUf: null };   // reaproveita o desenho
    RC.metrica = RM.metrica; RC.ordem = RM.ordem; RC.filtro = RM.filtro;
    $('#view').innerHTML = `<div class="page">
      <div class="page-head row" style="align-items:center">
        <a class="btn no-grow" href="#/campaigns">${ico('arrowleft', 14)} Voltar</a>
        <div style="flex:1"><h1>Mapa de leads</h1>
          <p>${fmtN(RM.dados.campanhas)} campanha(s) nos últimos ${RM.dias} dias, somadas por estado</p></div>
        ${ecSelect('rm-dias', [{ value: '30', label: '30 dias' }, { value: '90', label: '90 dias' }, { value: '180', label: '180 dias' }, { value: '365', label: '1 ano' }], String(RM.dias), 'rmSetDias(val)')}
      </div>
      <div class="card">
        <div class="row" style="align-items:center;margin-bottom:12px">
          <h2 style="flex:1;margin:0">${ico('globe')} Onde estão os leads quentes</h2>
          <label style="margin:0">Pintar por
            ${ecSelect('rc-metrica', RC_METRICAS.map(([v, l]) => ({ value: v, label: l })), RC.metrica, 'rcSetMetricaMapa(val)')}
          </label>
        </div>
        ${brazilMap3D({ states: rcMapaCounts(), soMapa: true })}
      </div>
      <div class="card">
        <div class="row" style="align-items:center;margin-bottom:12px">
          <h2 style="flex:1;margin:0">${ico('list')} Por estado</h2>
          <input id="rc-busca" placeholder="Filtrar estado…" value="${esc(RC.filtro)}" oninput="rcFiltrar(this.value)" style="max-width:200px">
          <label style="margin:0">Ordenar por
            ${ecSelect('rc-ordem', RC_METRICAS.map(([v, l]) => ({ value: v, label: l })), RC.ordem, 'rcSetOrdem(val)')}
          </label>
        </div>
        <div id="rc-tabela">${rcTabela()}</div>
      </div>
    </div>`;
  } catch (e) {
    $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`;
  }
}
function rmSetDias(v) { RM.dias = Number(v) || 90; renderMapaLeads(); }
function rcSetMetricaMapa(v) { RM.metrica = v; renderMapaLeads(); }

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
            <td class="muted" style="font-size:12px">${esc(rc.error || '-')}</td>
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
    <div class="team-me"><span class="avatar sm" style="background:#2ED378">${esc((state.user || 'V')[0].toUpperCase())}</span><div><b style="font-size:13px">${esc(state.user || 'Você')}</b><div class="muted" style="font-size:11px">Você · online</div></div></div>
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
      const av = thread.kind === 'dm' ? avatarHtml({ name: thread.name }) : `<span class="avatar" style="background:#2ED378">${thread.kind === 'sector' ? '#' : '@'}</span>`;
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
  // O domínio dos links curtos morava na tela de Pixels, que é sobre outra
  // coisa. Ele pertence aqui, junto dos links que ele encurta.
  let cfg = {};
  try { cfg = await api('/settings'); } catch {}
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Links rastreáveis</h1><p>Links curtos com contagem de cliques e disparo de pixels (Meta e Google)</p></div>
      <button class="btn primary no-grow" onclick="openLinkNew()">${ico('plus', 14)} Novo link</button>
    </div>
    <div class="card" id="links-table">${skel(4)}</div>
    <div class="card">
      <h2>${ico('link')} Domínio personalizado</h2>
      <div class="row">
        <label style="flex:1">Domínio dos links curtos<input id="tk-domain" value="${esc(cfg.linkDomain || '')}" placeholder="ex.: link.suaempresa.com.br"></label>
        <button class="btn primary no-grow" onclick="saveLinkDomain()">${ico('save', 14)} Salvar domínio</button>
      </div>
      <p class="muted" style="font-size:12px;margin:8px 0 0">Aponte o DNS do seu domínio para este servidor, os links curtos passam a sair como <code>https://seu-dominio/l/apelido</code>.</p>
    </div>
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
        <td class="muted">${l.lastClick ? timeAgo(l.lastClick) : '-'}</td>
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
        <div><b>${s.link.lastClick ? timeAgo(s.link.lastClick) : '-'}</b><span>Último clique</span></div>
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

// ---------------------------------------------------------------------------
// ESCOLHA DE PLANO (conta ainda sem assinatura)
//
// Uma decisão por tela. A pessoa acabou de se cadastrar; carteira, indicações
// e histórico de pagamento não têm o que dizer ainda, e só atrapalhariam a
// única coisa que destrava o produto.
//
// Ao escolher, o servidor abre a cobrança no CHECKOUT que o dono montou e
// manda para lá. A tela fica esperando: quando o pagamento cai, o SSE avisa e
// ela recarrega já liberada.
// ---------------------------------------------------------------------------
async function renderEscolherPlano() {
  clearInterval(payPoll);
  $('#view').innerHTML = `<div class="page planos-page">
    <div class="planos-head">
      <h1>Escolha seu plano</h1>
      <p>Sua conta está criada. Escolha um plano para liberar o Koonfy.</p>
    </div>
    <div id="planos-box">${skel(3)}</div>
  </div>`;
  pintarPlanos();
}

async function pintarPlanos() {
  const box = $('#planos-box'); if (!box) return;
  let d;
  try { d = await api('/billing'); }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  BILL_CACHE = d;

  const planos = (d.plans || []).filter(p => !p.archived);
  if (!planos.length) {
    box.innerHTML = `<div class="card"><h2>${ico('alert')} Nenhum plano disponível</h2>
      <p class="muted" style="margin:8px 0 0;font-size:13px">A plataforma ainda não publicou planos. Fale com o suporte.</p></div>`;
    return;
  }

  box.innerHTML = `<div class="planos-grid">${planos.map((p, i) => {
    const lim = p.limits || {};
    const mods = p.modules || {};
    // o que o plano ENTREGA, na ordem em que a pessoa pergunta
    const itens = [
      lim.whatsapps === -1 ? 'Conexões de WhatsApp ilimitadas' : fmtN(lim.whatsapps || 1) + ' conexão(ões) de WhatsApp',
      lim.sends === -1 ? 'Disparos ilimitados' : fmtN(lim.sends) + ' disparos por ciclo',
      lim.contacts === -1 ? 'Contatos ilimitados' : fmtN(lim.contacts) + ' contatos',
      lim.campaigns === -1 ? 'Campanhas ilimitadas' : fmtN(lim.campaigns) + ' campanhas por ciclo'
    ];
    const extras = FEATURE_META.filter(f => mods[f.key] !== false).map(f => f.label);
    // O ciclo vinha como "por undefined dias" em qualquer plano salvo sem
    // periodDays — o campo é opcional no cadastro e ninguém tratava a falta.
    const dias = Number(p.periodDays) || 30;
    // Mais barato = o do meio da grade não serve como regra; o DESTAQUE é o
    // plano do meio da lista, que é onde o olho cai e onde costuma estar a
    // oferta que o dono quer vender.
    const destaque = planos.length > 2 && i === Math.floor(planos.length / 2);
    // Em ciclo longo, o preço mensal equivalente é a informação que a pessoa
    // realmente usa para comparar — e é ele que mostra a vantagem do plano.
    const porMes = dias > 31 ? Math.round(p.price / (dias / 30)) : 0;
    return `<div class="plano-card${destaque ? ' hi' : ''}">
      ${destaque ? '<span class="plano-tag">Mais escolhido</span>' : ''}
      <h3>${esc(p.name)}</h3>
      <div class="plano-preco"><b>${fmtBRL(p.price)}</b><em>${epCicloLabel(dias)}</em></div>
      ${porMes ? `<div class="plano-equiv">equivale a <b>${fmtBRL(porMes)}</b> por mês</div>` : ''}
      <ul class="plano-itens">
        ${itens.map(i2 => `<li>${ico('check', 13)}<span>${i2}</span></li>`).join('')}
      </ul>
      ${extras.length ? `
        <div class="plano-sec">Módulos inclusos</div>
        <div class="plano-mods">${extras.map(x => `<span class="pill">${esc(x)}</span>`).join('')}</div>` : ''}
      <button class="btn primary block" onclick="assinarPlano('${p.id}', this)">
        ${ico('zap', 14)} Assinar ${esc(p.name)}</button>
    </div>`;
  }).join('')}</div>`;
}

// "por mês" lê melhor que "por 30 dias"; os ciclos redondos ganham nome e o
// resto cai no genérico em vez de inventar um rótulo errado.
function epCicloLabel(dias) {
  const nomes = { 7: 'por semana', 15: 'por quinzena', 30: 'por mês', 60: 'a cada 2 meses',
    90: 'por trimestre', 180: 'por semestre', 365: 'por ano' };
  return nomes[dias] || `a cada ${fmtN(dias)} dias`;
}

// Abre a cobrança no checkout que o dono montou. Sai em outra aba: fechar o
// Koonfy no meio do pagamento é o caminho curto para desistir.
async function assinarPlano(planId, btn) {
  const txt = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Abrindo checkout…';
  try {
    const r = await api('/billing/checkout', { body: { planId } });
    window.open(r.payUrl, '_blank', 'noopener');
    esperandoPagamento(r);
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false; btn.innerHTML = txt;
  }
}

// Enquanto o pagamento não cai, a tela diz o que está acontecendo e oferece o
// link de novo — a aba pode ter sido fechada sem querer.
function esperandoPagamento(r) {
  $('#planos-box').innerHTML = `<div class="card aguardando">
    <h2>${ico('clock')} Aguardando o pagamento</h2>
    <p class="muted" style="margin:8px 0 14px;font-size:13.5px">
      O checkout abriu em outra aba. Assim que o pagamento for confirmado, esta
      tela libera sozinha.</p>
    <div class="row">
      <a class="btn primary no-grow" href="${esc(r.payUrl)}" target="_blank" rel="noopener">
        ${ico('arrowright', 14)} Abrir o checkout de novo</a>
      <button class="btn no-grow" onclick="pintarPlanos()">Escolher outro plano</button>
    </div>` + `</div>`;

  // O SSE avisa quando o pagamento entra; este intervalo é a rede de
  // segurança para quando a conexão de eventos cair.
  clearInterval(payPoll);
  payPoll = setInterval(async () => {
    try {
      const me = await api('/me');
      if (!me.planRequired) {
        clearInterval(payPoll);
        state.planRequired = false;
        toast('Assinatura ativada! 🎉');
        applyNavPermissions();
        location.hash = '#/dashboard';
      }
    } catch {}
  }, 5000);
}

async function renderBilling() {
  // Sem assinatura, a tela cheia não ajuda: leva para a escolha do plano.
  if (precisaAssinar()) return renderEscolherPlano();
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
      ${d.wooviReady ? '' : `<div class="card warn-card">${ico('alert', 16)} <b>Pagamentos ainda não configurados.</b> ${state.kind === 'admin' ? 'Configure o adquirente em <a href="/adm/#/adm/gateways">Admin SaaS → Gateways</a>.' : 'A plataforma ainda não ativou os pagamentos, fale com o suporte.'}</div>`}

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
            Formas de pagamento aceitas: <b>Pix</b>, com renovação automática por Pix Automático quando o seu banco oferece o recurso${cardOn
              ? `; <b>cartão de crédito</b>, com ativação imediata e renovação no cartão salvo` : ''}${(d.card || {}).boleto
              ? `; e <b>boleto bancário</b>, com liberação após a compensação` : ''}.</p>`
          : '<p class="muted">Nenhum plano publicado ainda.</p>'}
      </div>

      ${walletCard(d)}

      <div class="card">
        <h2>${ico('sparkles')} Indique e ganhe</h2>
        <p class="muted" style="margin:0;font-size:13px">O seu link de indicação, os indicados e o saque das comissões
        agora ficam na aba <b>Afiliação</b>, no menu. Aqui dentro de Assinatura quase ninguém achava.</p>
        <div class="row" style="margin-top:12px"><a class="btn primary no-grow" href="#/afiliacao">${ico('sparkles', 14)} Abrir Afiliação</a></div>
      </div>`;
    if (pc) startPayPoll();
  } catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; }
}

// ---------------------------------------------------------------------------
// AFILIAÇÃO — página própria
//
// Estava como um cartão no fim de "Assinatura & Carteira", abaixo dos planos:
// quem não rolasse a tela até o fim nunca descobria que o programa existe. É um
// canal de aquisição, e canal de aquisição escondido não é usado.
// ---------------------------------------------------------------------------
// ============================================================================
// AFILIAÇÃO
//
// Esta tela vende uma coisa só: o LINK. Ela estava com quatro caixas de número
// e três cartões iguais empilhados — tudo com o mesmo peso visual, e o link,
// que é o produto, perdido no meio de um deles.
//
// Agora há uma ordem de leitura: (1) quanto eu ganho e por quanto tempo,
// (2) o link, grande e pronto para compartilhar, (3) quanto isso dá em dinheiro
// no MEU caso, com o preço real do plano publicado, e só depois a lista de
// indicados e o saque.
// ============================================================================
let AFF = null;
let AFF_SIM = 5;   // quantos indicados a simulação considera

async function renderAfiliacao() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(5)}</div></div>`;
  try {
    AFF = await api('/billing');
    pintarAfiliacao();
  } catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; }
}

// O plano de referência da simulação é o mais CARO publicado: é o teto honesto
// do que dá para ganhar, e é o número que faz a pessoa querer indicar.
function affPlano() {
  const planos = ((AFF && AFF.plans) || []).filter(p => !p.archived && p.price > 0);
  return planos.length ? planos.reduce((x, y) => (y.price > x.price ? y : x)) : null;
}

function pintarAfiliacao() {
  const d = AFF, a = d.affiliate;
  const refLink = `${API.webOrigin}/app/?ref=${a.code}`;
  const ativos = a.referrals.filter(r => r.status === 'active').length;
  const plano = affPlano();
  const porMes = plano ? Math.floor(plano.price * a.percentRenewal / 100) : 0;
  const primeira = plano ? Math.floor(plano.price * a.percentFirst / 100) : 0;
  const zap = 'Uso o Koonfy para atender e vender pelo WhatsApp. Se quiser testar: ' + refLink;

  $('#view').innerHTML = `<div class="page aff">
    <div class="page-head">
      <h1>Afiliação</h1>
      <p>Indique o Koonfy e receba comissão de cada assinatura, todo mês, enquanto ela durar</p>
    </div>

    <div class="aff-top">
      <div class="aff-oferta">
        <span class="aff-tag">${ico('sparkles', 12)} Programa de indicação</span>
        <div class="aff-nums">
          <div class="aff-num">
            <b>${a.percentFirst}<i>%</i></b>
            <span>na <b>1ª</b> assinatura</span>
          </div>
          <span class="aff-mais">+</span>
          <div class="aff-num">
            <b>${a.percentRenewal}<i>%</i></b>
            <span>em <b>toda</b> renovação</span>
          </div>
        </div>
        <p class="aff-recorrente">
          ${ico('refresh', 14)}
          <span>A comissão de renovação <b>não tem prazo</b>. Enquanto o seu indicado pagar, você recebe.</span>
        </p>
      </div>

      <div class="aff-link-box">
        <span class="aff-lbl">${ico('link', 13)} Seu link de indicação</span>
        <div class="aff-link"><code>${esc(refLink)}</code></div>
        <div class="aff-acoes">
          <button class="btn primary" onclick="copyText('${esc(refLink)}')">${ico('copy', 14)} Copiar link</button>
          <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(zap)}">
            ${waLogo(14, 'currentColor')} Enviar no WhatsApp</a>
        </div>
        <p class="aff-cod">Código <b>${esc(a.code)}</b>. Quem entrar por ele fica marcado como seu indicado <b>para sempre</b>.</p>
      </div>
    </div>

    <div class="aff-placar">
      <div class="aff-placar-i hi">
        <span class="aff-placar-lbl">${ico('briefcase', 13)} Já ganho</span>
        <b>${fmtBRL(a.earned)}</b>
      </div>
      <div class="aff-placar-i">
        <span class="aff-placar-lbl">${ico('users', 13)} Indicados</span>
        <b>${fmtN(a.referrals.length)}</b>
      </div>
      <div class="aff-placar-i">
        <span class="aff-placar-lbl">${ico('check-circle', 13)} Assinando agora</span>
        <b>${fmtN(ativos)}</b>
      </div>
      <div class="aff-placar-i">
        <span class="aff-placar-lbl">${ico('zap', 13)} Recorrente por mês</span>
        <b>${fmtBRL(ativos * porMes)}</b>
      </div>
    </div>

    ${plano ? `
    <div class="card aff-sim">
      <h2>${ico('trend')} Quanto isso dá por mês</h2>
      <p class="muted" style="margin:2px 0 0;font-size:13px">
        Contas com o plano <b>${esc(plano.name)}</b> (${fmtBRL(plano.price)}/mês). Arraste para ver com mais indicados.
      </p>
      <div class="aff-sim-linha">
        <input type="range" min="1" max="50" value="${AFF_SIM}" oninput="affSim(this.value)" class="aff-range" aria-label="Quantidade de indicados">
        <span class="aff-sim-qtd"><b id="aff-sim-n">${AFF_SIM}</b> indicados</span>
      </div>
      <div class="aff-sim-out">
        <div class="aff-sim-box"><span>Entra no 1º mês</span><b id="aff-sim-1">${fmtBRL(AFF_SIM * primeira)}</b></div>
        <div class="aff-sim-box hi"><span>Todo mês, depois</span><b id="aff-sim-m">${fmtBRL(AFF_SIM * porMes)}</b></div>
        <div class="aff-sim-box"><span>Em 12 meses</span><b id="aff-sim-a">${fmtBRL(AFF_SIM * primeira + AFF_SIM * porMes * 11)}</b></div>
      </div>
      <p class="hint" style="text-align:left;margin-top:12px">
        ${ico('help', 12)} Estimativa com todos no mesmo plano e sem cancelamentos. O que conta é o pagamento confirmado.
      </p>
    </div>` : ''}

    <div class="two-col even">
      <div class="card">
        <h2>${ico('users')} Seus indicados</h2>
        ${a.referrals.length ? `
          <div class="aff-lista">
            ${a.referrals.map(r => `
              <div class="aff-ref">
                <span class="aff-ref-av">${esc(waInitials(r.name))}</span>
                <div class="aff-ref-tx">
                  <b>${esc(r.name)}</b>
                  <span>entrou ${timeAgo(r.createdAt)}</span>
                </div>
                <span class="pill ${r.status === 'active' ? 'done' : 'pending'}">${(BILL_ST[r.status] || [r.status])[0]}</span>
              </div>`).join('')}
          </div>` : `
          <div class="aff-vazio">
            <span class="aff-vazio-ic">${ico('send', 22)}</span>
            <b>Ninguém ainda</b>
            <p>Mande o seu link para quem atende no WhatsApp e responde tudo à mão. A comissão começa no primeiro pagamento.</p>
            <button class="btn primary no-grow" onclick="copyText('${esc(refLink)}')">${ico('copy', 14)} Copiar meu link</button>
          </div>`}
      </div>

      <div class="card aff-card">
        <h2>${ico('download-circle')} Sacar comissões</h2>
        <p class="muted" style="margin:0 0 4px;font-size:13px">Saldo da carteira: <b>${fmtBRL(d.wallet.balance)}</b>. O saque cai na chave Pix que você informar.</p>
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
    </div>
  </div>`;
}

// Recalcula sem repintar a tela: repintar perderia o foco do controle
// deslizante no meio do arrasto.
function affSim(n) {
  AFF_SIM = Math.max(1, Math.min(50, Number(n) || 1));
  const a = AFF.affiliate, plano = affPlano();
  if (!plano) return;
  const prim = Math.floor(plano.price * a.percentFirst / 100);
  const mes = Math.floor(plano.price * a.percentRenewal / 100);
  $('#aff-sim-n').textContent = AFF_SIM;
  $('#aff-sim-1').textContent = fmtBRL(AFF_SIM * prim);
  $('#aff-sim-m').textContent = fmtBRL(AFF_SIM * mes);
  $('#aff-sim-a').textContent = fmtBRL(AFF_SIM * prim + AFF_SIM * mes * 11);
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
  // [valor, rótulo, explicação, ícone]
  const meios = [
    d.wooviReady && ['pix', 'Pix', 'Liberação imediata', 'pix'],
    c.credit && ['card', 'Cartão de crédito', 'Liberação imediata', 'card'],
    c.boleto && ['boleto', 'Boleto', `Compensa em até ${c.boletoDueDays || 3} dias úteis`, 'file'],
    saldo > 0 && ['wallet', 'Saldo em carteira', `Disponível: ${fmtBRL(saldo)}`, 'briefcase']
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
      ${meios.map(([v, l, sub, ic], i) => `<label class="pay-method">
        <input type="radio" name="xpm" value="${v}" ${i === 0 ? 'checked' : ''}>
        <span class="pay-ic">${ico(ic, 17)}</span>
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
    <h2>${ico('pix')} Pague o Pix para liberar</h2>
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
  // Recarga não parcela: o saldo entra inteiro, parcelar não faria sentido.
  const maxP = mode === 'topup' ? 1 : Math.max(1, c.maxInstallments || 1);

  // CARTÃO JÁ CADASTRADO NA FATURA
  //
  // Quem já pagou o Koonfy no cartão não deveria digitar tudo de novo.
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
      ${mode === 'plan' ? 'Assinatura do Koonfy'
        : mode === 'topup' ? 'Recarga da carteira'
        : `${qty}x ${esc(extraLabel(id))}`}
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
    <p class="hint" style="margin-top:10px">${ico('lock', 12)} Os dados vão direto para o adquirente, o Koonfy guarda só a bandeira e os 4 últimos dígitos para renovar.</p>
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
    // Recarga: o cartão é síncrono, então o saldo já volta creditado.
    else if (ctx.mode === 'topup') {
      await api('/billing/topup', { body: { ...body, method: 'card', amount: (ctx.amount / 100).toFixed(2) } });
    } else await api('/billing/extras', { body: { ...body, key: ctx.id, qty: ctx.qty } });
    closeModal();
    // o cartão acabou de ser salvo: o cache precisa reler para a próxima
    // compra já oferecer "usar o cartão salvo"
    BILL_CACHE = null;
    toast(ctx.mode === 'plan' ? 'Assinatura ativada! 🎉'
      : ctx.mode === 'topup' ? 'Saldo creditado! 💚' : 'Contratado! Já pode usar.');
    if (ctx.mode === 'plan') paintBilling();
    else if (ctx.mode === 'topup') { await refreshWallet(); if (state.view === 'billing') paintBilling(); }
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
      <div class="pay-info">
        <h2 style="margin:0 0 4px">${ico('pix')} Pague com Pix para ativar</h2>
        <p class="muted" style="margin:0 0 12px;font-size:13px">${pc.kind === 'topup' ? 'Recarga de saldo' : 'Assinatura'}, <b>${fmtBRL(pc.amount)}</b>. Escaneie o QR ou use o copia-e-cola. A confirmação é automática.</p>
        <div class="pay-acoes">
          ${pc.brCode ? `<button class="btn primary" onclick="copyText(${JSON.stringify(esc(pc.brCode))})">${ico('copy', 13)} Copiar código Pix</button>` : ''}
          <button class="btn" onclick="checkPending(true)">${ico('refresh', 13)} Já paguei</button>
          <button class="btn danger" onclick="cancelPending()">Cancelar</button>
        </div>
        ${pc.brCode ? `<details class="pay-codigo">
          <summary>Ver o código para colar manualmente</summary>
          <textarea readonly rows="3" onclick="this.select()">${esc(pc.brCode)}</textarea>
        </details>` : ''}
        <p class="muted" id="pay-status" style="font-size:12px;margin:12px 0 0">${ico('clock', 12)} Aguardando pagamento…</p>
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
  if (state.kind !== 'admin') { location.hash = '#/' + VIEW_PADRAO; return; }
  // No painel da plataforma o menu lateral já diz onde se está: repetir a
  // barra de abas seria navegar duas vezes pela mesma coisa.
  const rota = admAbaDaRota();
  const cab = rota || { titulo: 'Admin SaaS', sub: 'Receita, contas, planos, afiliados e pagamentos' };
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>${esc(cab.titulo)}</h1><p>${esc(cab.sub)}</p></div>
    <div class="tabs${rota ? ' hidden' : ''}">
      <button class="active" data-tab="adm-vis" onclick="showSettingsTab('adm-vis')">Visão geral</button>
      <button data-tab="adm-acc" onclick="showSettingsTab('adm-acc')">Contas</button>
      <button data-tab="adm-pl" onclick="showSettingsTab('adm-pl')">Planos</button>
      <button data-tab="adm-aff" onclick="showSettingsTab('adm-aff')">Afiliados</button>
      <!-- "Gateways" e não "Pagamentos": esta aba é a dos provedores (Woovi,
           cartão) e das regras de cobrança. A do MÓDULO, com as subcontas e as
           cobranças dos clientes, é a adm-ep, e as duas ficaram com o mesmo
           nome quando o Pagamentos virou Pagamentos. -->
      <button data-tab="adm-pay" onclick="showSettingsTab('adm-pay');admFeesPaint()">Gateways</button>
      <button data-tab="adm-wd" onclick="showSettingsTab('adm-wd')">Saques</button>
      <button data-tab="adm-ep" onclick="showSettingsTab('adm-ep');admEpPaint()">Pagamentos</button>
      <button data-tab="adm-int" onclick="showSettingsTab('adm-int');admIntLoad()">Integrações</button>
      <button data-tab="adm-plat" onclick="showSettingsTab('adm-plat')">Plataforma</button>
      <button data-tab="adm-mkt" onclick="showSettingsTab('adm-mkt');admMktLoad()">Marketing</button>
      <button data-tab="adm-sec" onclick="showSettingsTab('adm-sec');admSecLoad()">Segurança</button>
      <button data-tab="adm-seo" onclick="showSettingsTab('adm-seo')">SEO</button>
      <button data-tab="adm-tema" onclick="showSettingsTab('adm-tema');admTemaLoad()">Personalização</button>
      <button data-tab="adm-bnr" onclick="showSettingsTab('adm-bnr');admBannersLoad()">Banners</button>
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
          <label>App Secret ${p.hasAppSecret ? '<em class="lim-extra">já salvo, deixe vazio para manter</em>' : ''}<input id="pl-appsecret" type="password" autocomplete="new-password" placeholder="${p.hasAppSecret ? '••••••••' : 'Configurações do app → Básico'}"></label>
          <label>Config ID (Embedded Signup)<input id="pl-configid" value="${esc(p.configId || '')}" placeholder="Login do Facebook p/ Empresas → Configurações"></label>
          <label>System User Token (fallback) ${p.hasSystemToken ? '<em class="lim-extra">já salvo, deixe vazio para manter</em>' : ''}<input id="pl-systoken" type="password" autocomplete="new-password" placeholder="${p.hasSystemToken ? '••••••••' : 'Opcional'}"></label>
          <label>Versão da Graph API${ecSelect('pl-version', ['v26.0', 'v26.0', 'v24.0', 'v23.0', 'v22.0'].map(v => ({ value: v, label: v })), p.graphVersion || 'v26.0')}</label>
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
            <label>App Secret (Meta Ads) ${(p.metaAds || {}).hasAppSecret ? '<em class="lim-extra">já salvo</em>' : ''}<input id="pl-ads-secret" type="password" autocomplete="new-password" placeholder="${(p.metaAds || {}).hasAppSecret ? '••••••••' : 'deixe vazio p/ usar o do WhatsApp'}"></label>
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

      ${''/* A conexão manual mora em Configurações → Conexão & API, junto do
          botão de conectar. Duplicar o formulário aqui criaria dois campos com
          o mesmo id, e o salvar passaria a ler o errado. */}
      <a class="card link-card" href="#" onclick="location.hash='#/settings';setTimeout(()=>showSettingsTab('conexao'),120);return false">
        <span class="lc-ic">${ico('shield', 22)}</span>
        <div style="flex:1"><h2 style="margin:0 0 3px">Conexão manual do WhatsApp</h2>
          <p class="muted" style="margin:0;font-size:13px">Ligar o número da plataforma pelas credenciais, sem o Embedded Signup, fica em <b>Configurações → Conexão &amp; API</b>.</p></div>
        <span class="lc-arrow">${ico('arrowright', 18)}</span>
      </a>`;
}
// O banco em arquivo num host de container some a cada deploy/restart: é o
// motivo de o app "esquecer" tudo, senha do admin inclusive. Fica no topo do
// painel porque ninguém lê o log do servidor.
function armazenamentoAviso(a) {
  if (!a || !a.efemero) return '';
  return `<div class="danger-box" style="margin-bottom:16px">
    <b>${ico('alert', 14)} Os dados se perdem a cada restart.</b>
    Este servidor recria o disco a cada deploy e a cada reinício, e o banco está
    gravando em arquivo (<code>data/db.json</code>). Tudo que foi cadastrado
    volta ao zero, inclusive a senha do administrador.
    Ligue o MySQL definindo as variáveis de ambiente
    <code>DB_DRIVER=mysql</code> e <code>DATABASE_URL=mysql://usuario:senha@host:3306/koonfy</code>,
    depois rode <code>node scripts/migrar-mysql.js</code> para levar o que existe hoje.
  </div>`;
}

// ---------------------------------------------------------------------------
// O QUE OS CLIENTES VENDEM PELA PLATAFORMA
//
// A assinatura paga a conta hoje; a taxa das vendas e o que cresce. Sem este
// bloco o painel respondia "quanto entrou de mensalidade" e nao respondia
// "vale a pena baixar a mensalidade e subir a taxa?", que e a pergunta que
// decide o preco do produto.
//
// PIX, CARTAO E BOLETO SEPARADOS porque sao tres negocios diferentes: o Pix
// cai na hora, o cartao tem prazo e chargeback, o boleto tem compensacao.
// Somados num numero so, ninguem ve qual esta crescendo.
// ---------------------------------------------------------------------------
function admVendasHtml(d) {
  const v = d.vendas || {}, mets = d.metodos || [], S = d.serieMetodo || [], fun = d.funil || [], afs = d.afiliados || [];
  const maxMet = Math.max(1, ...mets.map(m => m.volume));
  const maxSerie = Math.max(1, ...S.map(x => x.total));
  const maxFun = Math.max(1, ...fun.map(f => f.qtd));
  return `
  <div class="card">
    <h2 style="margin:0 0 4px">${ico('card')} Vendas dos clientes</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">Tudo o que passou pelo checkout da plataforma. A coluna que interessa para a Koonfy é a <b>taxa</b>: o volume é dos clientes.</p>

    <div class="kpi-strip" style="margin-bottom:16px">
      <div class="kpi-mini"><span>Volume transacionado</span><b>${fmtBRL(v.volume || 0)}</b><em>${fmtN(v.pagas || 0)} venda(s) paga(s)</em></div>
      <div class="kpi-mini"><span>Taxas recebidas</span><b>${fmtBRL(v.taxas || 0)}</b><em>a receita da plataforma</em></div>
      <div class="kpi-mini"><span>Ticket médio</span><b>${fmtBRL(v.ticket || 0)}</b><em>por venda paga</em></div>
      <div class="kpi-mini ${(v.conversao || 0) >= 50 ? 'up' : ''}"><span>Conversão do checkout</span><b>${(v.conversao || 0).toLocaleString('pt-BR')}%</b><em>${fmtN(v.pagas || 0)} de ${fmtN(v.criadas || 0)} cobranças</em></div>
      <div class="kpi-mini"><span>Aguardando</span><b>${fmtN(v.pendentes || 0)}</b><em>cobranças no prazo</em></div>
      <div class="kpi-mini"><span>Abandonadas</span><b>${fmtN(v.abandonadas || 0)}</b><em>venceram sem pagar</em></div>
    </div>

    <h3 style="margin:0 0 10px;font-size:14px">Por forma de pagamento</h3>
    ${mets.some(m => m.qtd) ? mets.map(m => `
      <div class="ep-volrow"><span>${esc(m.rotulo)} <em style="color:var(--muted);font-weight:600;font-style:normal">· ${fmtN(m.qtd)}</em></span>
        <div class="ep-volbar"><i style="width:${Math.max(2, Math.round(m.volume / maxMet * 100))}%"></i></div>
        <b>${fmtBRL(m.volume)}<small style="display:block;font-weight:600;color:var(--muted)">taxa ${fmtBRL(m.taxas)}</small></b></div>`).join('')
      : '<p class="muted">Nenhuma venda paga ainda.</p>'}
  </div>

  <div class="two-col even">
    <div class="card">
      <div class="row" style="align-items:center;margin-bottom:4px">
        <h2 style="margin:0;flex:1">${ico('activity')} Vendas. 12 meses</h2>
        <div class="chart-legend"><span><i class="lg-first"></i>Pix</span><span><i class="lg-renewal"></i>Cartão</span><span><i class="lg-topup"></i>Boleto</span></div>
      </div>
      <div class="bar-chart sm">
        ${S.map(x => `<div class="bar-col" title="${esc(x.label)}: ${fmtBRL(x.total)}&#10;Pix ${fmtBRL(x.pix)} · Cartão ${fmtBRL(x.card)} · Boleto ${fmtBRL(x.boleto)}&#10;Taxa ${fmtBRL(x.taxas)}">
          <div class="bar-stack">
            <div class="bar-seg seg-topup" style="height:${Math.round((x.boleto || 0) / maxSerie * 100)}%"></div>
            <div class="bar-seg seg-renewal" style="height:${Math.round((x.card || 0) / maxSerie * 100)}%"></div>
            <div class="bar-seg seg-first" style="height:${Math.round((x.pix || 0) / maxSerie * 100)}%"></div>
          </div><span class="bar-x">${esc(x.label)}</span></div>`).join('')}
      </div>
    </div>

    <div class="card">
      <h2 style="margin:0 0 4px">${ico('columns')} Funil da conta</h2>
      <p class="muted" style="margin:0 0 12px;font-size:12.5px">Onde as contas param. Cada degrau perdido é um lugar em que o produto não se sustenta sozinho.</p>
      ${fun.map(f => `<div class="ep-volrow"><span>${esc(f.etapa)}</span>
        <div class="ep-volbar"><i style="width:${Math.max(2, Math.round(f.qtd / maxFun * 100))}%"></i></div>
        <b>${fmtN(f.qtd)}<small style="display:block;font-weight:600;color:var(--muted)">${f.pct.toLocaleString('pt-BR')}%</small></b></div>`).join('')}
    </div>
  </div>

  ${afs.length ? `<div class="card">
    <h2 style="margin:0 0 10px">${ico('users')} Quem indica</h2>
    <div style="overflow-x:auto"><table class="tab-mob"><thead><tr><th>Conta</th><th>Código</th><th style="text-align:right">Indicados</th><th style="text-align:right">Viraram assinantes</th><th style="text-align:right">Comissão</th></tr></thead><tbody>
      ${afs.map(a => `<tr>
        <td data-r="Conta"><b>${esc(a.nome)}</b></td>
        <td data-r="Código"><span class="pill">${esc(a.codigo)}</span></td>
        <td data-r="Indicados" style="text-align:right">${fmtN(a.indicados)}</td>
        <td data-r="Assinantes" style="text-align:right">${fmtN(a.assinantes)}</td>
        <td data-r="Comissão" style="text-align:right"><b>${fmtBRL(a.ganhou)}</b></td>
      </tr>`).join('')}
    </tbody></table></div>
  </div>` : ''}`;
}

// ---------------------------------------------------------------------------
// BANNERS DA DASHBOARD
//
// A faixa de avisos que o cliente vê no topo da dashboard. A copy vive na
// configuração da plataforma: trocar a frase de uma campanha não pode custar
// um deploy, e o que custa um deploy ninguém troca.
// ---------------------------------------------------------------------------
let ADM_BNR = { lista: [], artes: [] };

// Os destinos são as telas do próprio painel. Endereço livre seria um jeito de
// mandar todo cliente para fora do produto, e um endereço digitado errado vira
// um botão que não faz nada.
const BNR_DESTINOS = [
  ['#/dashboard', 'Dashboard'], ['#/inbox', 'Conversas'], ['#/contacts', 'Contatos'],
  ['#/campaigns', 'Campanhas'], ['#/flows', 'Flow Builder'], ['#/integrations', 'Integrações'],
  ['#/nuvemshop', 'Nuvemshop'], ['#/pagamentos', 'Pagamentos'], ['#/checkouts', 'Checkout Builder'],
  ['#/tracking', 'Tracking'], ['#/links', 'Links'], ['#/afiliacao', 'Indique e ganhe'],
  ['#/billing', 'Assinatura & Carteira'], ['#/templates', 'Modelos'], ['#/sms', 'SMS'],
  ['#/settings', 'Configurações']
];

async function admBannersLoad() {
  const box = $('#adm-bnr-box'); if (!box) return;
  try {
    const r = await api('/admin/banners');
    ADM_BNR = { lista: r.banners || [], artes: r.artes || [] };
    admBannersPaint();
  } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

function admBannersPaint() {
  const box = $('#adm-bnr-box'); if (!box) return;
  const artes = ADM_BNR.artes.map(a => ({ value: a.id, label: a.nome }));
  box.innerHTML = `
    <div class="row" style="align-items:center;margin-bottom:6px">
      <h2 style="margin:0;flex:1">${ico('megaphone')} Banners da dashboard</h2>
      <button class="btn no-grow" onclick="admBannerNovo()">${ico('plus', 14)} Novo banner</button>
      <button class="btn primary no-grow" onclick="admBannersSalvar(this)">${ico('save', 14)} Salvar</button>
    </div>
    <p class="muted" style="margin:0 0 16px;font-size:13px">
      É a faixa que o cliente vê no topo da dashboard. Desligar um banner não o apaga —
      serve para a campanha que acabou e pode voltar. A ordem aqui é a ordem no carrossel.</p>

    ${ADM_BNR.lista.length ? ADM_BNR.lista.map((b, i) => `
      <div class="bnr-edit ${b.ativo === false ? 'off' : ''}">
        <div class="row" style="align-items:center;margin-bottom:10px">
          <label class="chk" style="margin:0;flex:1"><input type="checkbox" ${b.ativo !== false ? 'checked' : ''}
            onchange="admBannerSet(${i}, 'ativo', this.checked)"> <span>${b.ativo !== false ? 'No ar' : 'Desligado'}</span></label>
          <button class="btn small no-grow" onclick="admBannerMover(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Subir">${ico('chevron-up', 13)}</button>
          <button class="btn small no-grow" onclick="admBannerMover(${i}, 1)" ${i === ADM_BNR.lista.length - 1 ? 'disabled' : ''} title="Descer">${ico('chevron-down', 13)}</button>
          <button class="btn small danger no-grow" onclick="admBannerRemover(${i})">${ico('trash', 13)}</button>
        </div>
        <div class="row">
          <label style="flex:1">Etiqueta <em class="lim-extra">acima do título</em>
            <input value="${esc(b.tag)}" maxlength="40" oninput="admBannerSet(${i}, 'tag', this.value)" placeholder="Novidade"></label>
          <label style="flex:1">Arte${ecSelect('bnr-arte-' + i, artes, b.arte, `admBannerSet(${i}, 'arte', val)`)}</label>
        </div>
        <label>Título <em class="lim-extra">até 80 caracteres</em>
          <input value="${esc(b.titulo)}" maxlength="80" oninput="admBannerSet(${i}, 'titulo', this.value)" placeholder="Venda dentro do WhatsApp"></label>
        <label>Texto <em class="lim-extra">cabe em três linhas no celular; a quarta estoura o cartão</em>
          <textarea rows="2" maxlength="200" oninput="admBannerSet(${i}, 'texto', this.value)"
            placeholder="Cobrança por Pix e cartão no chat, checkout próprio e o dinheiro na sua conta.">${esc(b.texto)}</textarea></label>
        <div class="row">
          <label style="flex:1">Texto do botão
            <input value="${esc(b.acao)}" maxlength="40" oninput="admBannerSet(${i}, 'acao', this.value)" placeholder="Ver Pagamentos"></label>
          <label style="flex:1">Leva para${ecSelect('bnr-href-' + i, BNR_DESTINOS.map(([v, l]) => ({ value: v, label: l })), b.href, `admBannerSet(${i}, 'href', val)`)}</label>
        </div>
      </div>`).join('') : '<p class="muted">Nenhum banner. A faixa não aparece na dashboard dos clientes.</p>'}`;
}

// A edição é só na memória; o disco só é tocado no Salvar. Gravar a cada tecla
// deixaria um banner pela metade no ar enquanto a frase está sendo escrita.
function admBannerSet(i, campo, valor) {
  if (!ADM_BNR.lista[i]) return;
  ADM_BNR.lista[i][campo] = valor;
  if (campo === 'ativo') admBannersPaint();   // muda o rótulo e a opacidade do cartão
}

function admBannerMover(i, d) {
  const l = ADM_BNR.lista, k = i + d;
  if (k < 0 || k >= l.length) return;
  [l[i], l[k]] = [l[k], l[i]];
  l.forEach((b, n) => { b.ordem = n + 1; });
  admBannersPaint();
}

function admBannerNovo() {
  ADM_BNR.lista.push({
    id: '', ativo: false, ordem: ADM_BNR.lista.length + 1,
    arte: (ADM_BNR.artes[0] || {}).id || 'integracoes',
    tag: '', titulo: '', texto: '', acao: 'Saiba mais', href: '#/dashboard'
  });
  admBannersPaint();
}

async function admBannerRemover(i) {
  const b = ADM_BNR.lista[i]; if (!b) return;
  if (b.titulo && !await confirmModal({ title: 'Excluir banner', text: `Apagar "${b.titulo}"? Se for uma campanha que pode voltar, desligue em vez de apagar.`, ok: 'Excluir', danger: true })) return;
  ADM_BNR.lista.splice(i, 1);
  ADM_BNR.lista.forEach((x, n) => { x.ordem = n + 1; });
  admBannersPaint();
}

async function admBannersSalvar(btn) {
  const semTitulo = ADM_BNR.lista.filter(b => !String(b.titulo || '').trim()).length;
  if (semTitulo) return toast('Banner sem título não vai para o ar. Preencha ou remova.', 'error');
  const txt = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Salvando…';
  try {
    const r = await api('/admin/banners', { method: 'PUT', body: { banners: ADM_BNR.lista } });
    ADM_BNR.lista = r.banners || [];
    admBannersPaint();
    toast('Banners salvos. Os clientes veem na próxima vez que abrirem a dashboard.');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

async function paintAdmin() {
  await admCarregarCheckouts();   // para o seletor de checkout dos planos
  const box = $('#adm-box'); if (!box) return;
  try {
    const d = await api('/admin/saas');
    const m = d.metrics;
    const ad = d.advanced || {};
    const S = d.series || [];
    // A rota manda; sem rota de aba, vale o botão marcado na barra.
    const rota = admAbaDaRota();
    const activeTab = rota ? rota.aba : ($('.tabs button.active')?.dataset.tab || 'adm-vis');
    box.innerHTML = `
      <div class="tabpane ${activeTab === 'adm-vis' ? 'show' : ''}" data-pane="adm-vis">
        ${armazenamentoAviso(d.armazenamento)}
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

        ${admVendasHtml(d)}

        <div class="card">
          <h2>${ico('activity')} Últimos pagamentos</h2>
          ${d.revenue.length ? `<table><thead><tr><th>Quando</th><th>Conta</th><th>Tipo</th><th style="text-align:right">Valor</th></tr></thead><tbody>
            ${d.revenue.slice(0, 12).map(r => { const a = d.accounts.find(x => x.id === r.accountId); return `<tr><td>${timeAgo(r.ts)}</td><td><b>${esc(a ? a.name : r.accountId)}</b></td><td><span class="pill">${{ first: 'Nova assinatura', renewal: 'Renovação', topup: 'Recarga' }[r.kind] || r.kind}</span></td><td style="text-align:right"><b>${fmtBRL(r.amount)}</b></td></tr>`; }).join('')}
          </tbody></table>` : '<p class="muted">Nenhum pagamento confirmado ainda.</p>'}
        </div>
      </div>

      <div class="tabpane ${activeTab === 'adm-acc' ? 'show' : ''}" data-pane="adm-acc">
        <div class="card">
          <div class="row" style="align-items:center;margin-bottom:6px">
            <h2 style="margin:0;flex:1">${ico('users')} Contas (${d.accounts.length})</h2>
            <button class="btn primary no-grow" onclick="admNovaConta()">${ico('plus', 14)} Criar conta</button>
          </div>
          <p class="muted" style="margin:0 0 14px;font-size:13px">
            Contas marcadas como <b>internas</b> rodam sem plano, sem cota e sem cobrança,
            e ficam fora das métricas. Use para os seus próprios negócios.</p>
          ${d.accounts.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Conta</th><th>Plano</th><th>Status</th><th>Expira</th><th>WA</th><th style="text-align:right">Carteira</th><th>Indicações</th><th></th></tr></thead><tbody>
            ${d.accounts.map(a => {
              const pl = d.plans.find(p => p.id === a.billing.planId);
              const [sl, sc] = BILL_ST[a.billing.status] || [a.billing.status, 'pill'];
              return `<tr>
                <td><b>${esc(a.name)}</b>
                  <div class="muted" style="font-size:11.5px">${esc(a.email)}${(a.profile || {}).phone ? ' · ' + esc(a.profile.phone) : ''}</div>
                  ${(a.profile || {}).segment || (a.profile || {}).size ? `<div class="acc-perfil">
                    ${a.profile.segment ? `<span class="pill">${esc(a.profile.segment)}</span>` : ''}
                    ${a.profile.size ? `<span class="pill">${esc(a.profile.size)}</span>` : ''}
                    ${a.profile.goal ? `<span class="pill">${esc(a.profile.goal)}</span>` : ''}
                  </div>` : ''}</td>
                <td>${pl ? esc(pl.name) : '-'}</td>
                <td><span class="${sc}">${sl}</span></td>
                <td class="muted">${a.billing.periodEnd ? new Date(a.billing.periodEnd).toLocaleDateString('pt-BR') : '-'}</td>
                <td>${a.waConnected ? '<span class="ok-dot">●</span>' : '<span class="bad-dot">●</span>'}</td>
                <td style="text-align:right">${fmtBRL(a.walletBalance)}</td>
                <td>${a.unlimited ? `<span class="pill done">interna</span>`
                  : (a.referrals ? `<b>${a.referrals}</b> · ${fmtBRL(a.affEarned)}` : '-')}</td>
                <td style="white-space:nowrap">
                  <button class="btn small" onclick="admFicha('${a.id}')">${ico('search', 12)} Ficha</button>
                  ${a.unlimited ? '' : `<button class="btn small" onclick="admExtend(\'${a.id}\')">+30 dias</button>`}
                  <button class="btn small" onclick="admToggleIlimitada('${a.id}', ${a.unlimited ? 'false' : 'true'})">
                    ${a.unlimited ? 'Tornar cliente' : 'Tornar interna'}</button>
                </td>
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
          ${planCheckoutField('new', '')}
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
                <button class="btn small no-grow" title="Recomendar este plano na página pública"
                        onclick="admDestacarPlano('${p.id}', ${p.destaque ? 'false' : 'true'})">${ico(p.destaque ? 'star' : 'star', 13)} ${p.destaque ? 'Mais escolhido' : 'Destacar'}</button>
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
                ${planCheckoutField(p.id, p.checkoutId || '')}
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
            O máximo vale <b>por saque</b>, não por período, ele pode sacar de novo depois.
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
          <h2>${ico('pix')} Adquirente do Pix</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">
            Quem processa as cobranças. A troca vale para as <b>próximas</b> cobranças. As já emitidas continuam
            sendo confirmadas pelo gateway que as criou.
          </p>
          <p class="muted" style="margin:0 0 12px;font-size:12.5px;padding:10px 12px;border-radius:10px;background:var(--bg2)">
            ${ico('help', 12)} <b>Nos dois, quem aparece como recebedor do Pix é você.</b> A subconta da Woovi é
            uma reserva de saldo <i>dentro</i> da sua conta (o valor só sai no saque), e a Simplify não tem
            subconta. Em ambos o dinheiro entra no seu CNPJ e a carteira do Koonfy registra o quanto é de cada
            cliente. Para o pagador ver o nome do <b>seu cliente</b> no Pix, ele precisaria de conta própria no
            adquirente, com CNPJ e KYC dele.
          </p>
          <div class="gw-picker">
            <label class="gw-opt ${(d.config.gateway || 'woovi') === 'woovi' ? 'on' : ''}">
              <input type="radio" name="gw" value="woovi" ${(d.config.gateway || 'woovi') === 'woovi' ? 'checked' : ''}
                     onchange="admSaveConfig({gateway:'woovi'})">
              <b>Woovi</b>
              <span>Subconta por cliente, Pix Automático e KYC pelo Koonfy.</span>
              <i class="pill ${d.config.woovi.configured ? 'done' : ''}">${d.config.woovi.configured ? 'Configurado' : 'Sem credencial'}</i>
            </label>
            <label class="gw-opt ${d.config.gateway === 'simplify' ? 'on' : ''}">
              <input type="radio" name="gw" value="simplify" ${d.config.gateway === 'simplify' ? 'checked' : ''}
                     onchange="admSaveConfig({gateway:'simplify'})">
              <b>Simplify</b>
              <span>Mais simples: sem subconta e sem KYC. O dinheiro cai na conta da plataforma e a carteira do
              Koonfy registra o saldo de cada cliente.</span>
              <i class="pill ${d.config.simplify.configured ? 'done' : ''}">${d.config.simplify.configured ? 'Configurado' : 'Sem credencial'}</i>
            </label>
          </div>
        </div>

        <div class="card">
          <h2>${ico('shield')} Simplify. Credenciais</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">
            Pegue em <b>simplifybr.com</b> → API. O webhook <b>não precisa ser cadastrado lá</b>: o Koonfy manda o
            endereço em cada cobrança.
          </p>
          <div class="row">
            <label style="flex:1">Client ID ${d.config.simplify.clientId ? `<span class="pill done" style="margin-left:6px">${esc(d.config.simplify.clientId)}</span>` : ''}
              <input id="sp-id" type="password" placeholder="client id"></label>
            <label style="flex:1">Client Secret
              <input id="sp-secret" type="password" placeholder="client secret"></label>
          </div>
          <!-- O split da Simplify manda uma fatia para OUTRO usuário dela, e não
               para a plataforma: aqui o depósito já cai inteiro na conta das
               credenciais. Ficava logo abaixo do Client Secret e era lido como
               "a sua taxa" — que é outra coisa, e mora no card de taxas. -->
          <div class="row">
            <button class="btn primary no-grow" onclick="admSalvarSimplify(this)">${ico('save', 14)} Salvar credenciais</button>
          </div>
          <p class="muted" style="margin:10px 0 0;font-size:12px">
            ${ico('help', 12)} A Simplify exige <b>nome, CPF/CNPJ, e-mail e telefone do pagador</b> para gerar o Pix.
            Cobranças pelo checkout funcionam sempre (o cliente preenche na hora); geradas direto do chat, só se o
            contato já tiver esses dados.
          </p>
        </div>

        <div class="card">
          <h2>${ico('shield')} Woovi. Pix &amp; Pix Automático</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">Gere um <b>AppID</b> em API/Plugins → Nova integração e cole abaixo. Método de pagamento: <b>apenas Pix</b> (cobrança na hora) e <b>Pix Automático</b> (recorrência), sem cartão.</p>
          <label class="chk" style="margin:0 0 12px"><input type="checkbox" ${d.config.woovi.sandbox ? 'checked' : ''} onchange="admSaveConfig({wooviSandbox:this.checked})"> Usar o <b>ambiente de testes</b> da Woovi</label>
          <p class="muted" style="margin:0 0 12px;font-size:12.5px">
            As contas são separadas e cada uma tem o seu AppID: produção em <b>app.woovi.com</b>,
            testes em <b>app.woovi-sandbox.com</b>. Um AppID de testes enviado para a API de
            produção é recusado com 401. Ambiente atual: <b>${d.config.woovi.sandbox ? 'testes' : 'produção'}</b>
            (<code>${esc(d.config.woovi.base || '')}</code>).
          </p>
          <div class="row">
            <label style="flex:2">AppID da Woovi ${d.config.woovi.configured ? `<span class="pill done" style="margin-left:6px">Configurado ${esc(d.config.woovi.appId)}</span>` : ''}<input id="wv-appid" type="password" placeholder="Q2xpZW50X0lkX…"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({wooviAppId:$('#wv-appid').value})">${ico('save', 14)} Salvar</button>
            <button class="btn no-grow" onclick="admTestWoovi(this)">${ico('activity', 14)} Testar conexão</button>
          </div>
          <div id="wv-out"></div>
          <label class="chk" style="margin-top:12px"><input type="checkbox" id="wv-auto" ${d.config.woovi.pixAutomatic ? 'checked' : ''} onchange="admSaveConfig({pixAutomatic:this.checked})"> Tentar Pix Automático (assinatura recorrente), se indisponível, cai para Pix avulso por renovação</label>
          <div class="capi-box" style="margin-top:14px">
            <div class="capi-head">${ico('webhook', 14)} Webhook de confirmação <span class="capi-tag">obrigatório em produção</span></div>
            <p class="muted" style="font-size:12px;margin:6px 0 0">Em ${d.config.woovi.sandbox ? 'app.woovi-sandbox.com' : 'app.woovi.com'} → Webhooks, cadastre a URL <code>${API.webOrigin}/woovi-webhook</code> para os eventos de <b>cobrança paga</b>. Cada pagamento é verificado de novo na API antes de ativar (anti-fraude).</p>
            ${d.config.woovi.sandbox ? `<p class="muted" style="font-size:12px;margin:8px 0 0">Em testes o webhook é dispensável: o painel confere a cobrança na API ao voltar da tela de pagamento. Para valer em produção ele é obrigatório, porque lá o pagamento pode chegar com o navegador fechado.</p>` : ''}
          </div>
        </div>
        ${admCardSection(d.card || {}, null)}

        <!-- TAXAS DA PLATAFORMA. Moram aqui, junto dos gateways: o que se
             cobra depende de qual gateway está ativo, e ler as duas coisas
             em telas diferentes era o que confundia. O conteúdo vem de
             /admin/pagamentos, que esta aba não carrega. -->
        <div id="adm-fees-box">${skel(3)}</div>
        <div class="card">
          <h2>${ico('gear')} Regras de cobrança</h2>
          <div class="row">
            <p class="muted" style="font-size:13px;margin:0">A conta do cliente nasce quando o pagamento é confirmado, no checkout. Não há período de teste para configurar.</p>
          </div>
          <label class="chk" style="margin-top:12px"><input type="checkbox" ${d.config.billing.requirePlan !== false ? 'checked' : ''} onchange="admSaveConfig({requirePlan:this.checked})"> <span><b>Exigir plano para usar</b><em>Sem assinatura ativa, a conta só enxerga a tela de Assinatura. Desligado, o cadastro libera o app inteiro.</em></span></label>
          <label class="chk" style="margin-top:12px"><input type="checkbox" id="bl-enforce" ${d.config.billing.enforce ? 'checked' : ''} onchange="admSaveConfig({enforce:this.checked})"> Bloquear envios quando a assinatura expirar (senão, apenas avisa)</label>
          <div class="row" style="margin-top:16px;align-items:flex-end">
            <label style="flex:2">Texto do botão da landing (opcional)<input id="bl-cta" value="${esc(d.config.landing && d.config.landing.ctaText || '')}" placeholder="Começar agora (automático se vazio)"></label>
            <button class="btn primary no-grow" onclick="admSaveConfig({ctaText:$('#bl-cta').value})">${ico('save', 14)} Salvar copy</button>
          </div>
          <p class="muted" style="font-size:11.5px;margin:8px 0 0">Vazio = <b>“Começar agora”</b>.</p>
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

      <div class="tabpane ${activeTab === 'adm-bnr' ? 'show' : ''}" data-pane="adm-bnr">
        <div class="card" id="adm-bnr-box">${skel(4)}</div>
      </div>

      <div class="tabpane ${activeTab === 'adm-notif' ? 'show' : ''}" data-pane="adm-notif">
        <div class="card">
          <h2>${ico('zap')} Testar notificação de venda</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">
            Uma venda dispara <b>dois</b> avisos diferentes: o do <b>lojista</b>, que vê o valor que entrou, e o da
            <b>plataforma</b>, que vê a comissão que ficou. Aqui sai o texto real de cada um, com o som de caixa
            registradora. Nenhuma cobrança é criada e nada entra na carteira.
          </p>
          <p class="hint" style="margin:0 0 12px">O aviso chega <b>só neste aparelho</b>, o que está com esta tela aberta. Os outros aparelhos da conta não tocam.</p>
          <div class="row" style="align-items:flex-end">
            <label style="flex:1">Valor da venda (R$)<input id="ts-valor" inputmode="decimal" placeholder="97,00"></label>
            <label style="flex:1.4">Qual aviso${ecSelect('ts-tipo', [
              { value: 'venda', label: 'Do cliente: "Venda Aprovada · Valor"' },
              { value: 'comissao', label: 'Da plataforma: "Venda aprovada · Sua comissão"' }
            ], 'venda')}</label>
            <button class="btn primary no-grow" id="ts-btn" onclick="admTestarVenda(this)">${ico('bell', 14)} Disparar</button>
          </div>
        </div>

        <div class="card">
          <h2>${ico('bell')} Este aparelho está recebendo?</h2>
          <p class="muted" style="margin:0 0 12px;font-size:13px">
            Aviso simples, sem valor e sem som de venda. Serve para separar dois problemas: o aparelho não
            está inscrito, ou está inscrito e o aviso de venda é que não sai. Teste este primeiro.
          </p>
          <div class="row">
            <button class="btn no-grow" onclick="notifTestFire(this)">${ico('bell', 14)} Disparar aviso de teste</button>
          </div>
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

      <div class="tabpane ${activeTab === 'adm-mkt' ? 'show' : ''}" data-pane="adm-mkt">
        <div id="adm-mkt-box">${skel(4)}</div>
      </div>

      <div class="tabpane ${activeTab === 'adm-sec' ? 'show' : ''}" data-pane="adm-sec">
        <div id="adm-sec-box">${skel(4)}</div>
      </div>

      <div class="tabpane ${activeTab === 'adm-plat' ? 'show' : ''}" data-pane="adm-plat">
        ${admPlatformCard(d.platform || {}, d.manual || {}, API.webOrigin)}
      </div>

      <div class="tabpane ${activeTab === 'adm-seo' ? 'show' : ''}" data-pane="adm-seo">
        ${admSeoForm(d.seo || {})}
      </div>

      <div class="tabpane ${activeTab === 'adm-tema' ? 'show' : ''}" data-pane="adm-tema">
        <div id="adm-tema-box">${skel(3)}</div>
      </div>`;
    // Painéis que buscam os próprios dados. Antes só três eram chamados aqui,
    // porque os outros dependiam do clique na aba para carregar — entrando
    // direto pela rota, ficariam no esqueleto para sempre.
    if (activeTab === 'adm-ep') admEpPaint();
    if (activeTab === 'adm-pay') admFeesPaint();
    if (activeTab === 'adm-int') admIntLoad();
    if (activeTab === 'adm-mkt') admMktLoad();
    if (activeTab === 'adm-sec') admSecLoad();
    if (activeTab === 'adm-tema') admTemaLoad();
    if (activeTab === 'adm-bnr') admBannersLoad();
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
  { key: 'pagamentos',     label: 'Pagamentos (cobranças)' },
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
  { key: 'campaigns', label: 'Campanhas por ciclo',        short: 'Campanhas', ph: 'ilimitado' },
  { key: 'contacts',  label: 'Contatos (leads)',          short: 'Leads',    ph: 'ilimitado' },
  { key: 'flows',     label: 'Fluxos de automação',       short: 'Fluxos',   ph: 'ilimitado' },
  { key: 'pixels',    label: 'Pixels de rastreamento',    short: 'Pixels',   ph: 'ilimitado' },
  // `buy` é como o item é chamado na hora de contratar unidades a mais — os
  // rótulos acima descrevem o que o PLANO inclui, e ficam estranhos no "Contratar…".
  { key: 'links',     label: 'Links rastreáveis grátis',  short: 'Links',    ph: '1', extra: true, buy: 'links rastreáveis' },
  { key: 'whatsapps', label: 'WhatsApps inclusos',        short: 'WhatsApp', ph: '1', extra: true, buy: 'conexões de WhatsApp' }
];

// Qual CHECKOUT cobra este plano. A lista vem dos checkouts que o dono montou
// no Checkout Builder da própria conta; vazio usa o padrão dele.
let ADM_CHECKOUTS = [];

function planCheckoutField(scope, atual) {
  const opcoes = [{ value: '', label: 'Checkout padrão' }]
    .concat(ADM_CHECKOUTS.map(c => ({ value: c.id, label: c.name + (c.isDefault ? ' (padrão)' : '') })));
  return `<label style="margin-top:10px">Checkout da cobrança
    ${ecSelect('pl-ck-' + scope, opcoes, atual || '')}
    <em class="lim-extra">Montado por você em Pagamentos, Checkout Builder</em></label>`;
}

// Carregada uma vez, ao abrir o Admin: os checkouts mudam pouco.
async function admCarregarCheckouts() {
  try { ADM_CHECKOUTS = (await api('/pagamentos/checkouts')).checkouts || []; }
  catch { ADM_CHECKOUTS = []; }
}

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

// O plano recomendado na vitrine. Um so por vez: a API apaga a marca dos
// outros, e aqui a tela repinta para mostrar de quem ela saiu.
async function admDestacarPlano(id, ligar) {
  try {
    await api('/admin/plans/' + id, { method: 'PUT', body: { destaque: ligar } });
    toast(ligar ? 'Este plano passa a ser o mais escolhido na página' : 'Destaque removido');
    paintAdmin(); setTimeout(() => showSettingsTab('adm-pl'), 60);
  } catch (e) { toast(e.message, 'error'); }
}

async function admSavePlanLimits(id) {
  try {
    await api('/admin/plans/' + id, { method: 'PUT', body: { limits: readLimitFields(id), checkoutId: ecSelVal('pl-ck-' + id), modules: readFeatureFields(id) } });
    toast('Funcionalidades e limites atualizados'); paintAdmin();
    setTimeout(() => showSettingsTab('adm-pl'), 60);
  } catch (e) { toast(e.message, 'error'); }
}

async function admCreatePlan() {
  try {
    await api('/admin/plans', { body: { name: $('#pl-name').value, price: $('#pl-price').value, periodDays: $('#pl-days').value, modules: readFeatureFields('new'), limits: readLimitFields('new'), checkoutId: ecSelVal('pl-ck-new') } });
    toast('Plano criado!'); paintAdmin();
    setTimeout(() => showSettingsTab('adm-pl'), 60);
  } catch (e) { toast(e.message, 'error'); }
}
async function admDelPlan(id) {
  if (!await confirmModal({ title: 'Arquivar plano', text: 'Novos clientes não poderão assiná-lo. Assinantes atuais continuam até cancelarem.', ok: 'Arquivar', danger: true })) return;
  try { await api('/admin/plans/' + id, { method: 'DELETE' }); paintAdmin(); setTimeout(() => showSettingsTab('adm-pl'), 60); } catch (e) { toast(e.message, 'error'); }
}
// ---------------------------------------------------------------------------
// Admin → MARKETING
//
// A plataforma falando com os PRÓPRIOS clientes. Duas coisas na mesma tela
// porque uma serve à outra: os templates são o que se dispara, e o disparo é
// o que dá sentido a guardar template.
//
// O público é sempre um filtro explícito, com a contagem ao lado, e a prévia
// mostra o texto já preenchido com um destinatário real. Mandar para dezenas
// de contas sem ver como a mensagem fica é o caminho curto para o vexame.
// ---------------------------------------------------------------------------
let MKT = null;
let mktEdit = null;   // template em edição (null = novo)

async function admMktLoad() {
  const box = $('#adm-mkt-box'); if (!box) return;
  try { MKT = await api('/admin/marketing'); }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  admMktPaint();
}

const MKT_CANAL = { push: "Notificação push", whatsapp: "WhatsApp", sms: "SMS" };

function admMktPaint() {
  const box = $('#adm-mkt-box'); if (!box || !MKT) return;
  const t = mktEdit || {};
  const canais = MKT.canais || {};
  box.innerHTML = `
    <div class="card">
      <h2>${ico('megaphone')} ${mktEdit && mktEdit.id ? 'Editar template' : 'Novo template'}</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        Mensagens que a plataforma envia para as contas do Koonfy. Use as
        variáveis para cada cliente receber os próprios dados:
        ${mktChips()}
      </p>
      <div class="row">
        <label style="flex:1.4">Nome do template<input id="mk-name" value="${esc(t.name || '')}" placeholder="Ex.: Aviso de vencimento"></label>
        <label style="flex:1">Tipo${ecSelect('mk-kind', [{ value: 'cobranca', label: 'Cobrança' }, { value: 'aviso', label: 'Aviso' }], t.kind || 'cobranca')}</label>
        <label style="flex:1">Canal${ecSelect('mk-channel', [
          { value: 'push', label: 'Notificação push' },
          { value: 'whatsapp', label: 'WhatsApp' },
          { value: 'sms', label: 'SMS' }], t.channel || 'push')}</label>
      </div>
      <label style="margin-top:10px">Título (push)<input id="mk-title" value="${esc(t.title || '')}" placeholder="Sua assinatura vence em {{dias}} dias"></label>
      <label style="margin-top:10px">Mensagem<textarea id="mk-text" rows="4" placeholder="Olá {{nome}}, seu plano {{plano}} de {{valor}} vence em {{vencimento}}.">${esc(t.text || '')}</textarea></label>
      <div class="row" style="margin-top:12px">
        <button class="btn primary no-grow" onclick="mktSave(this)">${ico('save', 14)} ${mktEdit && mktEdit.id ? 'Salvar alterações' : 'Criar template'}</button>
        ${mktEdit ? `<button class="btn no-grow" onclick="mktNovo()">Cancelar</button>` : ''}
      </div>
    </div>

    <div class="card">
      <h2>${ico('send')} Disparar</h2>
      <div class="row">
        <label style="flex:1.3">Público${ecSelect('mk-aud', (MKT.publicos || []).map(p => ({ value: p.key, label: p.label + ' (' + p.total + ')' })), 'vencendo')}</label>
        <label style="flex:1">Canal do disparo${ecSelect('mk-sendch', [
          { value: 'push', label: 'Notificação push' + (canais.push ? '' : ' (indisponível)') },
          { value: 'whatsapp', label: 'WhatsApp' + (canais.whatsapp ? '' : ' (conexão da plataforma desligada)') },
          { value: 'sms', label: 'SMS' + (canais.sms ? '' : ' (Integra X não configurada)') }], 'push')}</label>
      </div>
      <p class="hint" style="text-align:left;margin-top:8px">
        O texto vem do formulário acima. Carregue um template salvo na lista abaixo para preencher.</p>
      <div class="row" style="margin-top:12px">
        <button class="btn no-grow" onclick="mktPreview(this)">${ico('eye', 14)} Ver prévia</button>
        <button class="btn primary no-grow" onclick="mktSend(this)">${ico('send', 14)} Disparar agora</button>
      </div>
      <div id="mk-prev"></div>
    </div>

    <div class="card">
      <h2>${ico('file')} Templates (${(MKT.templates || []).length})</h2>
      ${(MKT.templates || []).length ? `<div class="mkt-list">${MKT.templates.map(x => `
        <div class="mkt-item">
          <div style="flex:1;min-width:0">
            <b>${esc(x.name)}</b>
            <div class="mkt-tags">
              <span class="pill">${x.kind === 'cobranca' ? 'Cobrança' : 'Aviso'}</span>
              <span class="pill">${MKT_CANAL[x.channel] || x.channel}</span>
            </div>
            <div class="muted mkt-prev">${esc((x.text || '').slice(0, 110))}</div>
          </div>
          <button class="btn small no-grow" onclick="mktUsar('${x.id}')">Carregar</button>
          <button class="icon-btn danger" title="Excluir" onclick="mktDel('${x.id}')">${ico('trash', 14)}</button>
        </div>`).join('')}</div>`
        : `<p class="muted">Nenhum template ainda. Crie o primeiro acima.</p>`}
    </div>

    ${(MKT.campaigns || []).length ? `<div class="card">
      <h2>${ico('activity')} Últimos disparos</h2>
      <table><thead><tr><th>Quando</th><th>Canal</th><th>Público</th><th style="text-align:right">Enviados</th><th style="text-align:right">Falhas</th></tr></thead><tbody>
        ${MKT.campaigns.map(c => `<tr>
          <td>${timeAgo(c.ts)}</td>
          <td>${MKT_CANAL[c.channel] || c.channel}</td>
          <td class="muted">${esc(c.audienceLabel || c.audience)}</td>
          <td style="text-align:right"><b>${c.ok}</b> / ${c.total}</td>
          <td style="text-align:right">${mktFalhas(c)}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>` : ''}`;
}

// Insere a variável onde o cursor está, em vez de obrigar a digitar as chaves.
function mktVar(nome) {
  const el = document.activeElement;
  const alvo = (el && (el.id === 'mk-text' || el.id === 'mk-title')) ? el : $('#mk-text');
  if (!alvo) return;
  const marca = '{{' + nome + '}}';
  const i = alvo.selectionStart == null ? alvo.value.length : alvo.selectionStart;
  alvo.value = alvo.value.slice(0, i) + marca + alvo.value.slice(alvo.selectionEnd == null ? i : alvo.selectionEnd);
  alvo.focus();
  alvo.selectionStart = alvo.selectionEnd = i + marca.length;
}

// Etiquetas clicáveis das variáveis. Escrever {{vencimento}} à mão convida ao
// erro de digitação, e um {{vencimeto}} sai como texto cru na mensagem do
// cliente, sem nada que avise.
function mktChips() {
  return (MKT.variaveis || [])
    .map(v => `<code class="var-chip" onclick="mktVar('${v}')">{{${v}}}</code>`)
    .join(' ');
}

// Falhas com o motivo no title: "3 falhas" sem dizer por quê não ajuda ninguém
// a consertar o disparo seguinte.
function mktFalhas(c) {
  if (!c.falhas) return '0';
  const motivos = (c.erros || []).map(e => `${e.conta}: ${e.erro}`).join(' | ');
  return `<span class="pill pending" title="${esc(motivos)}">${c.falhas}</span>`;
}

function mktCorpo() {
  return {
    id: (mktEdit && mktEdit.id) || undefined,
    name: $('#mk-name').value,
    kind: ecSelVal('mk-kind'), channel: ecSelVal('mk-channel'),
    title: $('#mk-title').value, text: $('#mk-text').value
  };
}

async function mktSave(btn) {
  btn.disabled = true;
  try {
    const r = await api('/admin/marketing/templates', { body: mktCorpo() });
    MKT = r.view; mktEdit = null;
    toast('Template salvo');
    admMktPaint();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

function mktUsar(id) {
  mktEdit = (MKT.templates || []).find(x => x.id === id) || null;
  admMktPaint();
  $('#adm-mkt-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function mktNovo() { mktEdit = null; admMktPaint(); }

async function mktDel(id) {
  const t = (MKT.templates || []).find(x => x.id === id);
  if (!await confirmModal({ title: 'Excluir template', text: 'Apagar "' + (t ? t.name : '') + '"? Isto não desfaz disparos já feitos.', ok: 'Excluir', danger: true })) return;
  try {
    MKT = (await api('/admin/marketing/templates/' + id, { method: 'DELETE' })).view;
    if (mktEdit && mktEdit.id === id) mktEdit = null;
    toast('Template excluído');
    admMktPaint();
  } catch (e) { toast(e.message, 'error'); }
}

async function mktPreview(btn) {
  const out = $('#mk-prev');
  btn.disabled = true;
  try {
    const { preview } = await api('/admin/marketing/preview', { body: { ...mktCorpo(), audience: ecSelVal('mk-aud') } });
    out.innerHTML = `<div class="mkt-preview">
      <div class="mkt-prev-head">${ico('eye', 13)} Como <b>${esc(preview.exemplo)}</b> vai receber</div>
      ${preview.title ? `<b>${esc(preview.title)}</b>` : ''}
      <p>${esc(preview.text) || '<span class="muted">Mensagem vazia</span>'}</p>
      <div class="muted" style="font-size:12px">Vai para <b>${preview.total}</b> conta(s)</div>
    </div>`;
  } catch (e) { out.innerHTML = `<div class="danger-box" style="margin-top:10px">${esc(e.message)}</div>`; }
  finally { btn.disabled = false; }
}

async function mktSend(btn) {
  const corpo = { ...mktCorpo(), audience: ecSelVal('mk-aud'), channel: ecSelVal('mk-sendch') };
  const pub = (MKT.publicos || []).find(p => p.key === corpo.audience) || { label: '', total: 0 };
  // Disparo não tem desfazer: a confirmação diz para quantos e por onde.
  const ok = await confirmModal({
    title: 'Confirmar disparo',
    text: 'Enviar por ' + (MKT_CANAL[corpo.channel] || corpo.channel) + ' para ' + pub.total + ' conta(s) do público "' + pub.label + '". Não há como desfazer.',
    ok: 'Disparar'
  });
  if (!ok) return;
  const t = btn.innerHTML; btn.disabled = true; btn.textContent = 'Disparando…';
  try {
    const r = await api('/admin/marketing/send', { body: corpo });
    MKT = r.view;
    const c = r.campaign;
    toast(c.falhas ? c.ok + ' enviado(s), ' + c.falhas + ' falha(s)' : c.ok + ' enviado(s)!', c.falhas ? 'error' : 'ok');
    admMktPaint();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = t; }
}

// ---------------------------------------------------------------------------
// Admin → SEGURANÇA
//
// Duas coisas que andam juntas: o envio de e-mail e a verificação em duas
// etapas. O segundo fator manda o código POR E-MAIL, então sem SMTP ele não
// tem como funcionar, e a tela deixa isso explícito em vez de oferecer um
// interruptor que não faria nada.
// ---------------------------------------------------------------------------
let ADM_SEC = null;

async function admSecLoad() {
  const box = $('#adm-sec-box'); if (!box) return;
  try { ADM_SEC = await api('/admin/mail'); }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  admSecPaint();
}

function admSecPaint() {
  const box = $('#adm-sec-box'); if (!box || !ADM_SEC) return;
  const m = ADM_SEC.mail, sec = ADM_SEC.security || {};
  box.innerHTML = `
    <div class="card">
      <div class="row" style="align-items:center;margin-bottom:6px">
        <h2 style="margin:0;flex:1">${ico('mail')} Envio de e-mail (SMTP)</h2>
        <span class="pill ${m.configured ? 'done' : 'pending'}">${m.configured ? 'configurado' : 'pendente'}</span>
      </div>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        Usado para confirmar o e-mail dos clientes e mandar o código da verificação
        em duas etapas. Sem isto, os dois recursos ficam indisponíveis para todo mundo.
      </p>
      <label class="chk" style="margin-bottom:12px"><input type="checkbox" ${m.enabled ? 'checked' : ''}
        onchange="admMailSave({enabled:this.checked})"> Habilitar envio de e-mail</label>
      <div class="row">
        <label style="flex:2">Servidor (host)<input id="ml-host" value="${esc(m.host)}" placeholder="smtp.seuprovedor.com"></label>
        <label style="flex:.7">Porta<input id="ml-port" inputmode="numeric" value="${m.port}"></label>
      </div>
      <label class="chk" style="margin-top:10px"><input type="checkbox" id="ml-secure" ${m.secure ? 'checked' : ''}>
        TLS direto (porta 465). Desmarcado, usa STARTTLS na 587.</label>
      <div class="row" style="margin-top:10px">
        <label style="flex:1">Usuário<input id="ml-user" value="${esc(m.user)}" autocomplete="off"></label>
        <label style="flex:1">Senha ${m.hasPass ? '<em class="lim-extra">já salva, deixe vazio para manter</em>' : ''}
          <input id="ml-pass" type="password" autocomplete="new-password" placeholder="${m.hasPass ? '••••••••' : ''}"></label>
      </div>
      <div class="row" style="margin-top:10px">
        <label style="flex:1.2">Remetente (from)<input id="ml-from" value="${esc(m.from)}" placeholder="nao-responda@seudominio.com"></label>
        <label style="flex:1">Nome exibido<input id="ml-fromname" value="${esc(m.fromName)}"></label>
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary no-grow" onclick="admMailSaveForm(this)">${ico('save', 14)} Salvar</button>
        <button class="btn no-grow" onclick="admMailTest(this)">${ico('activity', 14)} Enviar teste</button>
      </div>
      <div id="ml-out">${m.lastError ? `<div class="danger-box" style="margin-top:10px">${esc(m.lastError)}</div>` : ''}</div>
    </div>

    <div class="card">
      <h2>${ico('shield')} Verificação em duas etapas</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        Libera o recurso para os clientes. Cada um decide se liga na própria conta,
        em <b>Configurações, Minha conta</b>. Quem ligar passa a receber um código
        por e-mail a cada login.
      </p>
      <label class="chk"><input type="checkbox" ${sec.twoFactor ? 'checked' : ''}
        onchange="admSecSave(this.checked)"> Permitir verificação em duas etapas</label>
      ${!m.configured ? `<p class="hint" style="text-align:left;margin-top:10px">
        ${ico('alert', 12)} Sem o envio de e-mail configurado acima, o código não tem como chegar
        e o recurso continua indisponível para os clientes.</p>` : ''}
    </div>`;
}

async function admMailSave(patch) {
  try {
    ADM_SEC.mail = (await api('/admin/mail', { method: 'PUT', body: patch })).mail;
    toast('Configuração salva');
    admSecPaint();
  } catch (e) { toast(e.message, 'error'); }
}

function admMailSaveForm(btn) {
  btn.disabled = true;
  admMailSave({
    host: $('#ml-host').value, port: $('#ml-port').value,
    secure: $('#ml-secure').checked,
    user: $('#ml-user').value, pass: $('#ml-pass').value,
    from: $('#ml-from').value, fromName: $('#ml-fromname').value
  }).finally(() => { btn.disabled = false; });
}

// O prompt() nativo é bloqueado no PWA: o endereço do teste é pedido no modal
// do próprio app.
function admMailTest() {
  openModal(`
    <h2>${ico('mail')} Enviar e-mail de teste</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">Para qual endereço mandamos a mensagem de teste?</p>
    <label>E-mail<input id="ml-test-to" inputmode="email" placeholder="voce@empresa.com"></label>
    <div class="row" style="margin-top:14px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="admMailTestGo(this)">Enviar</button>
    </div>
    <div id="ml-test-out"></div>`);
}

async function admMailTestGo(btn) {
  const out = $('#ml-test-out');
  const t = btn.innerHTML; btn.disabled = true; btn.textContent = 'Enviando…';
  try {
    const r = await api('/admin/mail/test', { body: { to: $('#ml-test-to').value.trim() } });
    if (r.ok) { closeModal(); toast('E-mail de teste enviado!'); }
    else out.innerHTML = `<div class="danger-box" style="margin-top:10px">${esc(r.error)}</div>`;
  } catch (e) { out.innerHTML = `<div class="danger-box" style="margin-top:10px">${esc(e.message)}</div>`; }
  finally { btn.disabled = false; btn.innerHTML = t; admSecLoad(); }
}

async function admSecSave(on) {
  try {
    ADM_SEC.security = (await api('/admin/security', { method: 'PUT', body: { twoFactor: on } })).security;
    toast(on ? 'Verificação em duas etapas liberada' : 'Verificação em duas etapas desligada');
    admSecPaint();
  } catch (e) { toast(e.message, 'error'); admSecLoad(); }
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
      Acima do limite de caracteres a operadora cobra mais de um SMS, é assim que o consumo é contado no plano do cliente.
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
      ${ico('zap', 12)} O disparo em massa vai em lotes de <b>${fmtN(c.lote || 100)}</b> números por chamada 
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
        AUTH: 'O token foi recusado. Como ele faz parte do endereço, um token errado responde 404, confira se copiou o valor inteiro do painel da Integra X.',
        ROTAS: 'O endereço existe, mas a conta não tem acesso a esta rota. Confira o plano contratado na Integra X.',
        CAMPOS: 'A conexão funcionou, mas a resposta veio em outro formato. Ajuste a leitura em src/sms.js (bloco CONTRATO).'
      }[r.etapa] || '';
      out.innerHTML = `<div class="danger-box" style="margin-top:10px">
        <b>${ico('alert', 13)} Falhou em: ${esc(r.etapa)}</b>
        <p style="margin:0 0 6px">${esc(dica)}</p>
        <p style="margin:0"><code>${esc(r.base || '')}${esc(r.rota || '')}</code>, ${esc(r.msg || '')}</p>
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
      <div class="capi-head">${ico('webhook', 14)} URL para colar no app <span class="capi-tag">Portal de Parceiros</span></div>
      <p class="muted" style="font-size:12px;margin:8px 0 5px">URL de redirecionamento (OAuth), no campo <b>Redirect URI</b>:</p>
      <div class="linkrow"><code>${esc(n.redirectUri)}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(n.redirectUri)}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0">
        Escopos necessários: <b>read_orders</b> e <b>read_customers</b>. Em produção, o domínio precisa ser HTTPS.
      </p>
    </div>

    <div class="capi-box" style="margin-top:16px">
      <div class="capi-head">${ico('activity', 14)} Notificações de evento <span class="capi-tag">automático</span></div>
      <p class="muted" style="font-size:12px;margin:8px 0 10px">
        <b>Esta URL não se cadastra no Portal de Parceiros</b>, e não existe campo para ela lá.
        Na Nuvemshop os webhooks de evento são criados <b>por API, um por loja</b>: o Koonfy registra
        os dele no momento em que cada lojista conecta a loja. É só para conferência e diagnóstico.
      </p>
      <div class="linkrow"><code>${esc(n.webhookUrl)}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(n.webhookUrl)}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0">
        Se os eventos de uma loja pararem de chegar, o lojista clica em <b>Reassinar eventos</b> na tela de
        Integrações dele. Isso apaga os webhooks antigos naquela loja e cria de novo, apontando para cá.
      </p>
    </div>

    <div class="capi-box" style="margin-top:16px">
      <div class="capi-head">${ico('shield', 14)} LGPD <span class="capi-tag">obrigatório para publicar</span></div>
      <p class="muted" style="font-size:12px;margin:8px 0 10px">
        A Nuvemshop exige as três URLs abaixo no seu app. Elas já respondem: a primeira apaga a conexão da loja
        quando o lojista desinstala, a segunda remove os dados de um consumidor que pediu para ser esquecido, e a
        terceira registra o pedido de acesso aos dados na conta do lojista, que é quem responde ao consumidor.
      </p>
      <p class="muted" style="font-size:12px;margin:0 0 5px">URL webhook store redact:</p>
      <div class="linkrow"><code>${esc(n.lgpd && n.lgpd.storeRedact || '')}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(n.lgpd && n.lgpd.storeRedact || '')}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:12px;margin:10px 0 5px">URL webhook customers redact:</p>
      <div class="linkrow"><code>${esc(n.lgpd && n.lgpd.customersRedact || '')}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(n.lgpd && n.lgpd.customersRedact || '')}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:12px;margin:10px 0 5px">URL webhook customers data request:</p>
      <div class="linkrow"><code>${esc(n.lgpd && n.lgpd.customersDataRequest || '')}</code>
        <button class="icon-btn" title="Copiar" onclick="copyText('${esc(n.lgpd && n.lgpd.customersDataRequest || '')}')">${ico('copy', 13)}</button></div>
      <p class="muted" style="font-size:11.5px;margin:10px 0 0">
        As três são assinadas com o mesmo Client Secret acima. Sem o secret salvo, elas recusam tudo com 401,
        que é o certo: um POST de qualquer lugar apagaria dados de qualquer loja.
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

// ---------------------------------------------------------------------------
// MARCA — trocar a logo pelo painel
//
// Antes, mudar a logo era editar arquivo e subir deploy. Agora é enviar aqui e
// pronto: tudo aponta para /marca/logo, que serve o que estiver guardado.
// ---------------------------------------------------------------------------
async function admMarcaCarregar() {
  const info = $('#mk-info'); if (!info) return;
  try {
    const d = await api('/admin/brand');
    const img = $('#mk-prev img');
    if (img) img.src = d.url + (d.url.includes('?') ? '' : '?t=' + Date.now());
    info.innerHTML = d.temLogo
      ? `<b>${esc(d.arquivo || d.nome || 'logo enviada')}</b> · ${(d.bytes / 1024).toFixed(0)} KB · ${esc((d.mime || '').replace('image/', '').toUpperCase())}
         <br><span style="font-size:12px">Enviada em ${fmtDataHora(d.updatedAt)}</span>`
      : 'Usando a logo padrão do repositório. Envie um arquivo para trocar.';
    const rm = $('#mk-limpar');
    if (rm) rm.style.display = d.temLogo ? '' : 'none';
  } catch (e) { info.textContent = e.message; }
}

async function admMarcaEnviar(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) return toast('Máximo 2 MB', 'error');
  const info = $('#mk-info');
  const antes = info.innerHTML;
  info.textContent = 'Enviando…';
  try {
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1]);
      r.onerror = () => rej(new Error('Não consegui ler o arquivo'));
      r.readAsDataURL(file);
    });
    // O SVG chega como image/svg+xml; alguns sistemas mandam o tipo vazio, e aí
    // a extensão do nome é o que sobra para identificar.
    const mime = file.type || ({ svg: 'image/svg+xml', webp: 'image/webp', png: 'image/png', ico: 'image/x-icon' })[
      (file.name.split('.').pop() || '').toLowerCase()] || '';
    await api('/admin/brand', { body: { data, mime, nome: file.name } });
    toast('Logo atualizada! Recarregue as abas abertas para ver em todo lugar.');
    admMarcaCarregar();
    // troca a marca desta tela na hora, sem esperar recarregar
    document.querySelectorAll('img[src^="/marca/logo"]').forEach(i => { i.src = '/marca/logo?t=' + Date.now(); });
  } catch (e) { info.innerHTML = antes; toast(e.message, 'error'); }
}

async function admMarcaRemover() {
  if (!await confirmModal({ title: 'Voltar à logo padrão?', text: 'A imagem enviada é apagada e o Koonfy volta a usar a logo do repositório.', ok: 'Voltar ao padrão', danger: true })) return;
  try {
    await api('/admin/brand', { method: 'DELETE' });
    toast('Logo padrão restaurada');
    admMarcaCarregar();
    document.querySelectorAll('img[src^="/marca/logo"]').forEach(i => { i.src = '/marca/logo?t=' + Date.now(); });
  } catch (e) { toast(e.message, 'error'); }
}

// Teste da notificação de VENDA. Existe porque o som e o texto de venda são o
// aviso que o cliente mais espera e o mais difícil de conferir: só aparece
// quando alguém paga de verdade. Aqui o valor e o destinatário são escolhidos
// na hora, e o aviso chega SÓ NESTE APARELHO — o endereço da inscrição deste
// navegador vai junto no pedido.
async function admTestarVenda(btn) {
  const cents = epParseReais($('#ts-valor').value);
  if (!cents) return toast('Informe o valor da venda', 'error');
  const txt = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Disparando…';
  try {
    // este aparelho precisa estar inscrito, senão o envio sai para ninguém
    if (window.ECNotify && ECNotify.subscribePush) { try { await ECNotify.subscribePush(); } catch {} }
    const r = await api('/push/test-sale', { body: {
      amount: cents,
      kind: (($('#ts-tipo') || {}).value) || 'venda',
      endpoint: await esteAparelho()
    } });
    toast(r.sent
      ? `Enviado para este aparelho: "${r.titulo} · ${r.corpo}". Feche o app para ver como chega.`
      : 'Este aparelho não está inscrito. Ative as notificações em Configurações e tente de novo.',
      r.sent ? 'ok' : 'error');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

// O ENDEREÇO DESTE APARELHO. É o endpoint da inscrição de push do navegador —
// o próprio serviço de push o entrega, e é ele que o servidor usa para
// entregar em um aparelho só. Vazio = o servidor manda para todos, que é o
// comportamento antigo e o que vale para quem não tem push ligado.
async function esteAparelho() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    return (sub && sub.endpoint) || '';
  } catch (e) { return ''; }
}

// As credenciais só sobem quando preenchidas: o campo volta vazio depois de
// salvo (nunca devolvemos o segredo), e mandar vazio apagaria o que já está lá.
async function admSalvarSimplify(btn) {
  const body = {};
  const id = $('#sp-id').value.trim(), seg = $('#sp-secret').value.trim();
  if (id) body.simplifyClientId = id;
  if (seg) body.simplifyClientSecret = seg;
  btn.disabled = true;
  try {
    await api('/admin/config', { method: 'PUT', body });
    toast('Simplify salva');
    $('#sp-id').value = ''; $('#sp-secret').value = '';
    paintAdmin();
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function admSaveConfig(body) {
  try {
    await api('/admin/config', { method: 'PUT', body });
    toast('Configuração salva');
    // Trocar o ambiente da Woovi muda o endereço da API e o painel onde o
    // webhook é cadastrado. Sem repintar, o cartão seguia dizendo "produção"
    // depois de marcar testes — parecia que não tinha salvado.
    if (body && (body.wooviSandbox !== undefined || body.gateway !== undefined)) paintAdmin();
  } catch (e) { toast(e.message, 'error'); }
}
async function admTestWoovi(btn) {
  if (btn) { btn.disabled = true; }
  const out = $('#wv-out');
  try {
    const r = await api('/admin/woovi/test');
    if (out) out.innerHTML = `<p class="hint" style="text-align:left;margin-top:10px;color:var(--verde-deep)">${ico('check', 12)} Conectada ao ambiente de <b>${esc(r.ambiente || '')}</b> (<code>${esc(r.base || '')}</code>). A API respondeu com ${r.charges} cobrança(s) na primeira página.</p>`;
    toast('Woovi conectada em ' + (r.ambiente || '') + '!');
  }
  catch (e) {
    // "Woovi HTTP 401" não diz o que fazer. Cada erro que a Woovi devolve tem
    // uma causa concreta, e é ela que o admin precisa ler.
    const m = String(e.message || '');
    const dica = /401|Unauthorized/i.test(m)
      ? 'A Woovi recusou o AppID. Gere um novo em app.woovi.com → API/Plugins → Nova integração e cole aqui inteiro.'
      : /não configurada|informe o AppID/i.test(m) ? 'Salve o AppID antes de testar.'
      : /403/.test(m) ? 'O AppID existe, mas não tem permissão para esta operação. Confira o escopo da integração na Woovi.'
      : /ENOTFOUND|ECONN|fetch failed|timeout/i.test(m) ? 'Não foi possível alcançar a Woovi. Confira a saída de internet do servidor.'
      : m;
    if (out) out.innerHTML = `<div class="danger-box" style="margin-top:10px"><b>Falha na conexão</b><p style="margin:0">${esc(dica)}</p></div>`;
    toast(dica, 'error');
  }
  finally { if (btn) btn.disabled = false; }
}
async function admWithdraw(id, action) {
  try { await api('/admin/withdrawals/' + id, { method: 'PUT', body: { action } }); paintAdmin(); setTimeout(() => showSettingsTab('adm-wd'), 60); } catch (e) { toast(e.message, 'error'); }
}
// ---------------------------------------------------------------------------
// CONTAS INTERNAS
//
// A conta do admin é para gerir os clientes. Os negócios do próprio dono
// pedem contas comuns do Koonfy, com inbox e funil próprios, mas sem plano
// nem cobrança. É o que o interruptor "interna" faz, e é por isso que elas
// saem das métricas: contar a própria casa como assinante inflaria o MRR.
// ---------------------------------------------------------------------------
function admNovaConta() {
  openModal(`
    <h2>${ico('plus')} Criar conta</h2>
    <p class="muted" style="margin:0 0 14px;font-size:13px">
      A pessoa entra com este e-mail e senha, como qualquer cliente.
    </p>
    <div class="row">
      <label style="flex:1.2">Nome da empresa<input id="nc-name" placeholder="Meu outro negócio"></label>
      <label style="flex:1.4">E-mail<input id="nc-email" inputmode="email" placeholder="voce@empresa.com"></label>
    </div>
    <label style="margin-top:10px">Senha (mín. 6)<input id="nc-pass" type="password" autocomplete="new-password"></label>
    <label class="chk" style="margin-top:14px"><input type="checkbox" id="nc-unl" checked>
      <span><b>Conta interna, ilimitada</b>
      <em>Sem plano, sem cota, sem cobrança e fora das métricas do SaaS.</em></span></label>
    <div class="row" style="margin-top:16px">
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary" onclick="admCriarConta(this)">Criar conta</button>
    </div>`);
}

async function admCriarConta(btn) {
  btn.disabled = true;
  try {
    await api('/admin/accounts', { body: {
      name: $('#nc-name').value, email: $('#nc-email').value,
      pass: $('#nc-pass').value, unlimited: $('#nc-unl').checked
    } });
    closeModal();
    toast('Conta criada');
    paintAdmin();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

async function admToggleIlimitada(id, ligar) {
  const ok = await confirmModal({
    title: ligar ? 'Tornar interna' : 'Tornar cliente',
    text: ligar
      ? 'A conta passa a rodar sem plano, sem cota e sem cobrança, e sai das métricas do SaaS.'
      : 'A conta volta a valer as regras de plano e cobrança, e entra de novo nas métricas.',
    ok: 'Confirmar'
  });
  if (!ok) return;
  try {
    await api('/admin/accounts/' + id + '/unlimited', { method: 'PUT', body: { unlimited: ligar } });
    toast(ligar ? 'Conta marcada como interna' : 'Conta voltou a ser cliente');
    paintAdmin();
  } catch (e) { toast(e.message, 'error'); }
}

async function admExtend(id) {
  try { await api('/admin/accounts/' + id + '/billing', { method: 'PUT', body: { extendDays: 30, status: 'active' } }); toast('Assinatura estendida por 30 dias'); paintAdmin(); setTimeout(() => showSettingsTab('adm-acc'), 60); } catch (e) { toast(e.message, 'error'); }
}

// ---------- Admin → SEO da página de marketing ----------
// ===========================================================================
// PERSONALIZAÇÃO — as cores da marca, editadas pelo Admin
//
// Mesma ideia da logo: muda no painel e vale para o app inteiro e para a
// landing, sem deploy. As cores viram variáveis CSS servidas em /tema.css.
//
// Campo VAZIO = padrão do sistema. É assim que se desfaz um ajuste ruim sem
// precisar lembrar qual era o valor original.
// ===========================================================================
let ADM_TEMA = null;

async function admTemaLoad() {
  const box = $('#adm-tema-box'); if (!box) return;
  try { ADM_TEMA = await api('/admin/tema'); }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  admTemaPaint();
}

function admTemaCampo(chave, rot, ajuda) {
  const val = (ADM_TEMA.tema[chave] || '');
  const pad = ADM_TEMA.padrao[chave] || '#000000';
  return `<div class="tema-campo">
    <label>${esc(rot)}
      <span class="tema-ajuda">${esc(ajuda)}</span>
    </label>
    <div class="tema-input">
      <input type="color" id="tm-c-${chave}" value="${esc(val || pad)}"
             oninput="$('#tm-${chave}').value=this.value.toUpperCase();admTemaPreview()">
      <input id="tm-${chave}" value="${esc(val)}" placeholder="${esc(pad)} (padrão)" maxlength="7"
             oninput="admTemaSync('${chave}')">
      <button class="btn small no-grow" onclick="$('#tm-${chave}').value='';admTemaSync('${chave}')"
              title="Voltar ao padrão do sistema">${ico('refresh', 12)}</button>
    </div>
  </div>`;
}

function admTemaPaint() {
  const box = $('#adm-tema-box'); if (!box) return;
  // Sem cores salvas, o padrão é o desenho de hoje: verde fechado no fundo,
  // verde da logo na faixa.
  const brP = ADM_TEMA.padrao.brilho || { ligado: true, angulo: 45, cores: [] };
  const brS = ADM_TEMA.tema.brilho || {};
  const brilho = {
    ligado: brS.ligado === undefined ? brP.ligado : brS.ligado,
    angulo: brS.angulo || brP.angulo || 45,
    cores: (brS.cores && brS.cores.length) ? brS.cores : brP.cores
  };
  const funil = ADM_TEMA.tema.funil.length ? ADM_TEMA.tema.funil : ADM_TEMA.padrao.funil;
  box.innerHTML = `
    <div class="card">
      <h2>${ico('image')} Logo do Koonfy</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        Aparece no painel, na landing, no checkout, nas páginas de Termos e Privacidade, na aba do navegador e no
        splash. Trocar aqui muda tudo de uma vez. Aceita <b>PNG, WEBP, SVG, JPG e ICO</b>, até 2 MB.
        de preferência quadrada e com <b>fundo transparente</b>.
      </p>
      <div class="marca-linha">
        <span class="marca-prev" id="mk-prev"><img src="/marca/logo" alt=""></span>
        <div style="flex:1;min-width:0">
          <div id="mk-info" class="muted" style="font-size:12.5px">Carregando…</div>
          <div class="row" style="margin-top:10px">
            <button class="btn no-grow" onclick="$('#mk-file').click()">${ico('upload', 14)} Escolher arquivo</button>
            <button class="btn no-grow danger" id="mk-limpar" onclick="admMarcaRemover()" style="display:none">${ico('trash', 13)} Voltar ao padrão</button>
          </div>
        </div>
      </div>
      <input type="file" id="mk-file" class="hidden" accept="image/png,image/webp,image/svg+xml,image/jpeg,image/x-icon,image/gif,image/avif" onchange="admMarcaEnviar(this)">
      <p class="muted" style="margin:12px 0 0;font-size:12px">
        ${ico('help', 12)} O ícone do aplicativo instalado (PWA e lojas) continua vindo dos arquivos em
        <code>public/assets</code>: as lojas exigem tamanhos exatos declarados no pacote.
      </p>
    </div>

    <div class="card">
      <h2>${ico('braces')} Nome e descrição</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        O que aparece na <b>aba do navegador</b>, no atalho salvo no celular e quando alguém compartilha o link.
        Em branco, vale o padrão do sistema.
      </p>
      <div class="row">
        <label style="flex:1.2">Nome
          <input id="tm-nome" maxlength="60" placeholder="Koonfy" value="${esc(ADM_TEMA.marca && ADM_TEMA.marca.nome || '')}"></label>
        <label style="flex:2">Descrição ao lado do nome
          <input id="tm-descr" maxlength="120" placeholder="CRM de WhatsApp com IA" value="${esc(ADM_TEMA.marca && ADM_TEMA.marca.descricao || '')}"></label>
      </div>
      <p class="hint" style="margin-top:10px">${ico('help', 12)} Na aba sai <b>Nome</b> e, se houver descrição, <b>Nome | descrição</b>.</p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn primary no-grow" onclick="admMarcaNomeSalvar(this)">${ico('check', 14)} Salvar nome</button>
      </div>
    </div>

    <div class="card">
      <h2>${ico('sparkles')} Cores da marca</h2>
      <p class="muted" style="margin:0 0 16px;font-size:13px">
        Valem para o painel de todos os clientes, na hora. A página pública tem sistema de cores próprio e não muda por aqui.
        Deixe em branco para voltar ao padrão do Koonfy.
      </p>
      <div class="tema-grid">
        ${admTemaCampo('botao', 'Botão principal', 'Fundo dos botões de ação')}
        ${admTemaCampo('botaoHover', 'Botão ao passar o mouse', 'Um passo mais escuro que o botão')}
        ${admTemaCampo('tintaBotao', 'Texto do botão', 'A cor da letra dentro do botão')}
        ${admTemaCampo('verdeDeep', 'Verde de texto', 'Texto verde sobre fundo claro, onde é preciso contraste')}
        ${admTemaCampo('menu', 'Menu lateral', 'Item ativo do menu e os contadores de não lidas')}
        ${admTemaCampo('menuTinta', 'Texto do menu ativo', 'A cor da letra e do ícone dentro do item ativo')}
      </div>
      <div class="tema-previa" id="tema-previa">
        <span class="tema-previa-rot">Prévia</span>
        <i class="brand-name" role="img" aria-label="Koonfy"></i>
        <button class="btn primary no-grow">Botão principal</button>
        <button class="btn no-grow">Secundário</button>
        <span class="pill done">Selo</span>
      </div>
      <div class="row" style="margin-top:16px;justify-content:flex-end">
        <button class="btn primary no-grow" onclick="admTemaSalvar(this)">${ico('check', 14)} Salvar cores</button>
      </div>
    </div>

    <div class="card">
      <h2>${ico('sparkles')} Botão brilhante</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        O botão de ação da página pública e do checkout da assinatura. A faixa de luz atravessa em diagonal:
        a <b>primeira cor</b> é o fundo e as seguintes formam a faixa que passa. Duas cores bastam.
      </p>
      <label class="sw-row" style="margin-bottom:14px">
        <input type="checkbox" id="tm-brilho-on" ${brilho.ligado ? 'checked' : ''} onchange="admBrilhoPreview()">
        <span>Botão brilhante ligado <i class="muted">desligado, ele fica chapado na primeira cor</i></span>
      </label>
      <div class="tema-funil" id="tema-brilho">
        ${brilho.cores.map((c, i) => `
          <div class="tema-fcor">
            <input type="color" value="${esc(c)}" data-i="${i}" oninput="admBrilhoPreview()">
            <span>${i === 0 ? 'fundo' : i + 'ª'}</span>
          </div>`).join('')}
      </div>
      <div class="row" style="margin-top:12px;align-items:flex-end;gap:10px">
        <button class="btn small no-grow" onclick="admBrilhoMais()">${ico('plus', 12)} Mais uma cor</button>
        <button class="btn small no-grow" onclick="admBrilhoMenos()">${ico('trash', 12)} Tirar a última</button>
        <label style="max-width:150px">Ângulo do gradiente
          <input id="tm-brilho-ang" value="${brilho.angulo}" inputmode="numeric" placeholder="45"
                 oninput="admBrilhoPreview()"></label>
      </div>
      <div class="tema-previa" id="brilho-previa" style="margin-top:16px">
        <span class="tema-previa-rot">Prévia</span>
        <button class="btn-brilho" id="brilho-btn" type="button">Começar agora</button>
      </div>
      <div class="row" style="margin-top:16px;justify-content:flex-end">
        <button class="btn no-grow" onclick="admBrilhoPadrao()">Voltar ao padrão</button>
        <button class="btn primary no-grow" onclick="admBrilhoSalvar(this)">${ico('check', 14)} Salvar botão</button>
      </div>
    </div>

    <div class="card">
      <h2>${ico('columns')} Cores do funil</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">
        Uma cor por etapa do funil da dashboard, do topo para a base. Com mais etapas que cores,
        a sequência se repete um tom mais escuro.
      </p>
      <div class="tema-funil" id="tema-funil">
        ${funil.map((c, i) => `
          <div class="tema-fcor">
            <input type="color" value="${esc(c)}" data-i="${i}" oninput="admTemaPreviaFunil()">
            <span>${i + 1}ª</span>
          </div>`).join('')}
      </div>
      <div class="funil tema-funil-previa" id="tema-funil-previa" style="max-width:340px;margin:18px auto 0"></div>
      <div class="row" style="margin-top:16px;justify-content:flex-end">
        <button class="btn no-grow" onclick="admTemaFunilPadrao()">Voltar ao padrão</button>
        <button class="btn primary no-grow" onclick="admTemaSalvarFunil(this)">${ico('check', 14)} Salvar funil</button>
      </div>
    </div>`;
  admTemaPreview();
  admTemaPreviaFunil();
}

// O texto e o seletor de cor andam juntos; o texto é a fonte da verdade porque
// é ele que aceita "vazio" (= padrão), coisa que o <input type=color> não faz.
function admTemaSync(chave) {
  const t = $('#tm-' + chave), c = $('#tm-c-' + chave);
  let v = (t.value || '').trim();
  if (v && !v.startsWith('#')) { v = '#' + v; t.value = v; }
  const ok = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v);
  t.classList.toggle('bad', !!v && !ok);
  if (ok) c.value = v;
  else if (!v) c.value = ADM_TEMA.padrao[chave] || '#000000';
  admTemaPreview();
}

// A prévia aplica as cores só no bloco, para dar para ver antes de salvar.
function admTemaPreview() {
  const p = $('#tema-previa'); if (!p) return;
  const val = (k) => { const v = ($('#tm-' + k) && $('#tm-' + k).value || '').trim(); return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : (ADM_TEMA.padrao[k] || ''); };
  p.style.setProperty('--btn-verde', val('botao'));
  p.style.setProperty('--btn-verde-hover', val('botaoHover'));
  p.style.setProperty('--btn-tinta', val('tintaBotao'));
  p.style.setProperty('--verde-deep', val('verdeDeep'));
  p.style.setProperty('--menu-ativo', val('menu'));
  p.style.setProperty('--menu-tinta', val('menuTinta'));
}

function admTemaCoresFunil() {
  return [...document.querySelectorAll('#tema-funil input[type=color]')].map(i => i.value);
}
function admTemaPreviaFunil() {
  const alvo = $('#tema-funil-previa'); if (!alvo) return;
  const cores = admTemaCoresFunil();
  const nomes = ['Novo', 'Em atendimento', 'Qualificado', 'Negociação', 'Ganho', 'Perdido'];
  alvo.innerHTML = cores.map((c, i) => {
    const l = 100 - i * (cores.length > 1 ? 46 / (cores.length - 1) : 0);
    return `<div class="fn-etapa" style="width:${l.toFixed(1)}%;cursor:default">
      <div class="fn-forma" style="min-height:34px;padding:4px 18px;background:linear-gradient(160deg,${c},color-mix(in srgb,${c} 78%,#000));
           clip-path:polygon(0 0, 100% 0, 94% 100%, 6% 100%)">
        <span class="fn-nome" style="font-size:9px">${esc(nomes[i] || 'Etapa ' + (i + 1))}</span>
      </div></div>`;
  }).join('');
}
function admTemaFunilPadrao() {
  ADM_TEMA.tema.funil = [];
  admTemaPaint();
}

// ---- botão brilhante ----
// A primeira cor é o FUNDO e as seguintes formam a faixa. Repetir a
// primeira nas pontas é o que faz as do meio atravessarem em vez de
// virarem um degradê chapado de canto a canto.
function admBrilhoCores() {
  return [...document.querySelectorAll('#tema-brilho input[type=color]')].map(i => i.value);
}
function admBrilhoGradiente() {
  const c = admBrilhoCores();
  if (c.length < 2) return c[0] || '#1c834a';
  const ang = (parseInt($('#tm-brilho-ang').value, 10) || 45) + 'deg';
  const par = [c[0], c[0]].concat(c.slice(1)).concat([c[0], c[0]]);
  return 'linear-gradient(' + ang + ', ' + par.join(', ') + ')';
}
function admBrilhoPreview() {
  const b = $('#brilho-btn'); if (!b) return;
  const on = $('#tm-brilho-on').checked;
  const c = admBrilhoCores();
  b.style.background = on ? admBrilhoGradiente() : (c[0] || '#1c834a');
  b.style.backgroundSize = on ? '200% 200%' : 'auto';
  b.style.animation = on ? 'brilhoPassar 5s ease-in-out infinite' : 'none';
}
function admBrilhoMais() {
  const c = admBrilhoCores();
  if (c.length >= 6) return toast('Seis cores é o limite: acima disso a faixa vira arco-íris', 'error');
  ADM_TEMA.tema.brilho = Object.assign({}, ADM_TEMA.tema.brilho, { cores: c.concat([c[c.length - 1] || '#2ed378']) });
  admTemaPaint();
}
function admBrilhoMenos() {
  const c = admBrilhoCores();
  if (c.length <= 2) return toast('O botão brilhante precisa de pelo menos duas cores', 'error');
  ADM_TEMA.tema.brilho = Object.assign({}, ADM_TEMA.tema.brilho, { cores: c.slice(0, -1) });
  admTemaPaint();
}
function admBrilhoPadrao() {
  ADM_TEMA.tema.brilho = { ligado: true, angulo: 45, cores: [] };
  admTemaPaint();
}
async function admBrilhoSalvar(btn) {
  btn.disabled = true;
  const corpo = {
    ligado: $('#tm-brilho-on').checked,
    angulo: parseInt($('#tm-brilho-ang').value, 10) || 45,
    cores: admBrilhoCores()
  };
  try {
    await api('/admin/tema', { method: 'PUT', body: { brilho: corpo } });
    ADM_TEMA.tema.brilho = corpo;
    toast('Botão salvo! Já vale na página pública.');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

// O nome e a descrição da aba do navegador. Ficavam só no bloco de SEO, que
// ninguém associa a "trocar o nome do produto".
async function admMarcaNomeSalvar(btn) {
  btn.disabled = true;
  try {
    const corpo = { nome: $('#tm-nome').value.trim(), descricao: $('#tm-descr').value.trim() };
    await api('/admin/brand/nome', { method: 'PUT', body: corpo });
    ADM_TEMA.marca = Object.assign({}, ADM_TEMA.marca, corpo);
    toast('Nome salvo! Recarregue para ver na aba do navegador.');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function admTemaSalvar(btn) {
  const corpo = {};
  // 'verde' NÃO entra aqui: o campo saiu da tela quando a marca virou
  // imagem, e procurá-lo quebrava o laço na primeira volta — o Salvar
  // morria antes de chamar a API, sem erro visível.
  for (const k of ['botao', 'botaoHover', 'tintaBotao', 'verdeDeep', 'menu', 'menuTinta']) {
    corpo[k] = ($('#tm-' + k).value || '').trim();
  }
  btn.disabled = true;
  try {
    await api('/admin/tema', { method: 'PUT', body: corpo });
    ADM_TEMA.tema = Object.assign(ADM_TEMA.tema, corpo);
    aplicarTemaAgora();
    toast('Cores salvas! Já valem para todo mundo.');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

async function admTemaSalvarFunil(btn) {
  btn.disabled = true;
  try {
    await api('/admin/tema', { method: 'PUT', body: { funil: admTemaCoresFunil() } });
    ADM_TEMA.tema.funil = admTemaCoresFunil();
    aplicarTemaAgora();
    toast('Cores do funil salvas!');
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; }
}

// Recarrega /tema.css sem F5: sem isto o admin salva e continua vendo as cores
// antigas na própria tela, que é o jeito mais rápido de achar que não funcionou.
function aplicarTemaAgora() {
  const link = document.querySelector('link[href^="/tema.css"]');
  if (link) link.href = '/tema.css?v=' + Date.now();
}

function admSeoForm(seo) {
  const v = k => esc(seo[k] || '');
  return `
    <div class="card">
      <h2>${ico('target')} SEO da página de marketing</h2>
      <p class="muted" style="margin:0 0 14px;font-size:13px">Personalize como sua página inicial (a landing pública em <code>${API.webOrigin}/</code>) aparece no Google e ao ser compartilhada. As tags são injetadas no HTML lido pelos buscadores.</p>
      <div class="row">
        <label style="flex:2">Título (title / aba do navegador)<input id="seo-title" maxlength="180" value="${v('title')}" placeholder="Koonfy. CRM de WhatsApp com IA"></label>
        <label style="flex:1">Theme color<input id="seo-theme" value="${v('themeColor')}" placeholder="#50EA5F"></label>
      </div>
      <label style="margin-top:9px">Descrição (meta description, ideal até 160 caracteres)<textarea id="seo-desc" rows="2" maxlength="400" placeholder="Automatize o atendimento no WhatsApp, gerencie leads e dispare campanhas com o Koonfy.">${v('description')}</textarea></label>
      <div class="row" style="margin-top:9px">
        <label style="flex:2">Palavras-chave (separadas por vírgula)<input id="seo-keywords" maxlength="400" value="${v('keywords')}" placeholder="crm whatsapp, disparo em massa, chatbot"></label>
        <label style="flex:1">Autor<input id="seo-author" maxlength="120" value="${v('author')}" placeholder="Koonfy"></label>
      </div>
      <h3 class="notif-sub">Compartilhamento (Open Graph / redes sociais)</h3>
      <div class="row">
        <label style="flex:1">Título ao compartilhar<input id="seo-ogtitle" maxlength="180" value="${v('ogTitle')}" placeholder="(usa o título acima se vazio)"></label>
      </div>
      <label style="margin-top:9px">Descrição ao compartilhar<textarea id="seo-ogdesc" rows="2" maxlength="400" placeholder="(usa a descrição acima se vazio)">${v('ogDescription')}</textarea></label>
      <label style="margin-top:9px">Imagem de preview (URL. 1200×630 recomendado)<input id="seo-ogimage" maxlength="600" value="${v('ogImage')}" placeholder="${API.webOrigin}/assets/koonfy-og.png"></label>
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

// ---------- Admin → Pagamentos (gestão financeira da plataforma) ----------
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
// ---- Admin → Pagamentos → adquirente de cartão (Pagar.me / Asaas) ----
// ============================================================================
// TAXAS DA PLATAFORMA — Pix e Cartão no MESMO painel.
// Entradas (Pix In / Cartão) e saídas (Pix Out) ficam lado a lado: é uma decisão
// só, de quanto a plataforma retém em cada meio, então não faz sentido estarem
// em abas diferentes.
// ============================================================================
// Vendas que não fecharam. Pendente = o Pix ainda é pagável; abandonada =
// passou do vencimento sem pagamento. É a lista de quem quase comprou, que o
// painel contava mas nunca mostrava.
function admEmAbertoSection(p) {
  if (!p) return '';
  const linha = (c) => {
    const quem = c.contactName || (c.waId ? '+' + c.waId : 'sem contato');
    const quando = new Date(c.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<tr>
      <td><b>${esc(quem)}</b>${c.comment ? `<div class="muted" style="font-size:11.5px">${esc(c.comment)}</div>` : ''}</td>
      <td>${esc(c.accountName || '')}</td>
      <td><b>${fmtBRL(c.value)}</b></td>
      <td><span class="pill ${c.situacao === 'pendente' ? 'warn' : ''}">${c.situacao === 'pendente' ? 'Pendente' : 'Abandonada'}</span></td>
      <td class="muted" style="font-size:12px">${quando}</td>
      <td class="muted" style="font-size:12px">${esc(c.origin || '')}</td>
    </tr>`;
  };
  return `<div class="card">
    <h2>${ico('clock')} Vendas em aberto</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">
      Cobranças geradas que ainda não foram pagas. <b>Pendente</b> é a que ainda dá para pagar;
      <b>abandonada</b> é a que passou do vencimento. Não depende do webhook: ela nasce aqui no
      momento em que a cobrança é criada, e o webhook só serve para tirá-la desta lista quando o
      pagamento entra.
    </p>
    <div class="kpi-strip">
      <div class="kpi-mini"><span>Pendentes</span><b>${fmtN(p.pendentes.qtd)}</b><em>${fmtBRL(p.pendentes.valor)} a receber</em></div>
      <div class="kpi-mini ${p.abandonadas.qtd ? 'down' : ''}"><span>Abandonadas</span><b>${fmtN(p.abandonadas.qtd)}</b><em>${fmtBRL(p.abandonadas.valor)} perdidos</em></div>
    </div>
    ${p.itens.length
      ? `<table style="margin-top:14px">
          <thead><tr><th>Contato</th><th>Conta</th><th>Valor</th><th>Situação</th><th>Criada</th><th>Origem</th></tr></thead>
          <tbody>${p.itens.map(linha).join('')}</tbody>
        </table>`
      : `<p class="muted" style="margin-top:12px;font-size:13px">Nenhuma cobrança em aberto no momento.</p>`}
  </div>`;
}

function admFeesSection(cfg, c, t) {
  const isPag = c.provider === 'pagarme';
  const exemplo = 10000;
  const cartaoCut = Math.floor(exemplo * (Number(c.feeCardPercent) || 0) / 100) + (c.feeCardFixed || 0);
  // O caminho do dinheiro no Pix depende do gateway ligado, e é ele que diz
  // se a chave Pix do split faz falta ou não faz sentido.
  const simp = cfg.gateway === 'simplify';
  const pixCut = Math.floor(exemplo * (Number(cfg.feeInPercent) || 0) / 100);
  const semChave = !simp && pixCut > 0 && !cfg.splitPixKey;

  return `<div class="card">
    <h2>${ico('zap')} Taxas da plataforma</h2>
    <p class="muted" style="margin:0 0 12px;font-size:13px">
      Quanto você retém em cada meio de pagamento, <b>entradas e saídas, Pix e cartão, tudo aqui</b>.
      Com <b>0%</b> e <b>R$ 0,00</b> a taxa fica desativada.
    </p>
    <div class="capi-box" style="margin:0 0 16px">
      <div class="capi-head">${ico('activity', 14)} Como a sua parte chega até você
        <span class="capi-tag">${simp ? 'Simplify' : 'Woovi'}</span></div>
      <p class="muted" style="font-size:12.5px;margin:6px 0 0">${simp
        ? 'Na Simplify <b>não há subconta</b>: o pagamento cai <b>inteiro na sua conta</b>, e a carteira do Koonfy credita ao lojista o líquido. A sua taxa já fica retida na origem, sem split e sem chave Pix — o que o lojista vê como saldo é a venda menos a taxa.'
        : 'Na Woovi o pagamento cai na <b>subconta do lojista</b>. A sua parte só chega até você por <b>split</b>, e o split precisa da chave Pix abaixo.'}</p>
      <p class="muted" style="font-size:12.5px;margin:8px 0 0">Venda de ${fmtBRL(exemplo)} com ${esc(String(cfg.feeInPercent || 0).replace(".", ","))}%: <b>${fmtBRL(pixCut)}</b> para você, <b>${fmtBRL(exemplo - pixCut)}</b> para o lojista.</p>
      ${semChave ? `<p class="muted" style="font-size:12.5px;margin:8px 0 0;color:var(--amber)"><b>A taxa de Pix não está sendo cobrada:</b> sem a chave Pix o split não sai e a Woovi entrega o valor cheio ao lojista.</p>` : ''}
    </div>

    <div class="fee-grid">
      <div class="fee-col">
        <div class="fee-tag in">${ico('arrow-down', 13)} Entrada · Pix</div>
        <label>Taxa PIX In (%)<input id="adm-ep-fee-in" value="${esc(String(cfg.feeInPercent))}" inputmode="decimal" placeholder="0"></label>
        <p class="hint">${simp ? 'Retida na origem: o depósito é seu e a carteira credita o líquido ao lojista.' : 'Sai por split da subconta do lojista para a sua chave Pix.'}</p>
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
        <p class="hint">Saque de dinheiro que entrou via Pix ou comissão. ${simp ? 'O saque é pago por você, em <b>Saques</b>, já com a taxa descontada.' : 'Retida no pedido de saque.'}</p>
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
      na carteira do lojista dentro do Koonfy como <b>“a liberar”</b> e vira saldo sacável quando o prazo vence.
      Ele pode gastar esse saldo aqui (plano, conexões, links) sem nem sacar.
    </p>
    <div class="row" style="align-items:flex-end">
      <label style="max-width:340px">Modo de repasse${ecSelect('adm-card-mode', [
        { value: 'wallet', label: 'Carteira no Koonfy (recomendado)' },
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
        Não são editáveis de propósito: o Koonfy libera o saldo <b>no mesmo dia em que a adquirente repassa</b>.
        Se fosse possível digitar um prazo menor, o cliente sacaria dinheiro que ainda não entrou.
        Trocar de adquirente troca o prazo automaticamente.
      </p>
    </div>

    <div class="row" style="margin-top:16px;align-items:flex-end">
      ${simp ? '' : `<label style="flex:1.6">Chave Pix da plataforma (recebe o split do Pix)
        <input id="adm-ep-splitkey" value="${esc(cfg.splitPixKey || '')}" placeholder="chave Pix que recebe a comissão"></label>`}
      <label style="max-width:190px">Nome na fatura do cartão<input id="adm-card-sd" value="${esc(c.softDescriptor || '')}" maxlength="13" placeholder="KOONFY"></label>
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
    </p>
  </div>`;
}

// Salva Pix In/Out + taxa de cartão numa tacada só (o painel é um só).
async function admSaveAllFees(btn) {
  const txt = btn.innerHTML; btn.disabled = true; btn.textContent = 'Salvando…';
  const num = id => { const el = $(id); return el ? el.value : undefined; };
  try {
    await api('/admin/pagamentos/config', {
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
    await api('/admin/pagamentos/card', { method: 'PUT', body: card });
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
      Aceitar cartão no Pagamentos</label>

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
    <p class="hint" style="margin-top:12px">${ico('zap', 12)} A <b>taxa que você cobra sobre as vendas no cartão</b> fica junto das taxas de Pix, no card <b>Taxas da plataforma</b>, logo abaixo.</p>

    ${t ? `<div class="wh-meta" style="margin-top:16px">
      <span class="pill ${t.cardCount ? 'done' : ''}">${fmtN(t.cardCount || 0)} venda(s) no cartão</span>
      <span class="pill">${fmtBRL(t.cardIn || 0)} processado</span>
      <span class="pill">${fmtBRL(t.cardFees || 0)} em taxas suas</span>
    </div>` : ''}
  </div>`;
}

async function admCardSave(body) {
  // a config vive na aba Pagamentos (paintAdmin); refaz esse painel, não o Pagamentos
  try { await api('/admin/pagamentos/card', { method: 'PUT', body }); toast('Cartão atualizado'); paintAdmin(); }
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
  try { const r = await api('/admin/pagamentos/card/test'); toast(`Conexão OK, ${r.provider} (${r.ambiente})`); }
  catch (e) { toast(e.message, 'error'); }
  btn.disabled = false; btn.innerHTML = txt;
}

// O card das taxas vive na aba dos GATEWAYS, que não carrega /admin/pagamentos:
// ela é montada com /admin/config. Então o card busca os próprios dados.
async function admFeesPaint() {
  const box = document.getElementById('adm-fees-box'); if (!box) return;
  try {
    const d = await api('/admin/pagamentos');
    box.innerHTML = admFeesSection(d.config, d.card || {}, d.totals || {});
  } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function admEpPaint() {
  const box = $('#adm-ep-box'); if (!box) return;
  try {
    const d = await api('/admin/pagamentos');
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

      ${admEmAbertoSection(d.pendentes)}

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

      <div class="card">
        <h2>${ico('zap')} Taxas da plataforma</h2>
        <p class="muted" style="margin:0;font-size:13px">
          O que você retém em cada venda e em cada saque agora fica junto dos gateways, em
          <a href="javascript:showSettingsTab('adm-pay')"><b>Gateways</b></a> — a taxa depende de qual
          gateway está ativo, e ler as duas coisas em telas separadas confundia.
        </p>
        <div class="wh-meta" style="margin-top:14px">
          <span class="pill ${t.fees ? 'done' : ''}">${fmtBRL(t.fees || 0)} em taxas de Pix</span>
          <span class="pill ${t.cardFees ? 'done' : ''}">${fmtBRL(t.cardFees || 0)} em taxas de cartão</span>
        </div>
      </div>

      <div class="card">
        <h2>${ico('users')} Subcontas dos clientes</h2>
        ${d.accounts.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Cliente</th><th>Subconta</th><th>Status</th><th style="text-align:right">PIX In</th><th style="text-align:right">Taxas</th><th style="text-align:right">Cobranças</th><th></th></tr></thead><tbody>
          ${d.accounts.map(a => {
            const st = a.sub ? (EP_SUB_ST[a.sub.status] || [a.sub.status, 'pill']) : null;
            return `<tr>
              <td><b>${esc(a.name)}</b><div class="muted" style="font-size:11.5px">${esc(a.email)}</div></td>
              <td>${a.sub ? `${esc(a.sub.name)}<div class="muted" style="font-size:11px">${esc(a.sub.pixKey)}</div>` : '<span class="muted">-</span>'}</td>
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
        </tbody></table></div>` : '<p class="muted">Nenhum cliente ativou o Pagamentos ainda.</p>'}
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
            <td>${esc(l.accountName || '-')}</td>
            <td style="text-align:right">${l.amount ? fmtBRL(l.amount) : '-'}${l.fee ? `<div class="muted" style="font-size:11px">taxa ${fmtBRL(l.fee)}</div>` : ''}</td>
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
    await api('/admin/pagamentos/config', { method: 'PUT', body });
    toast('Configuração do Pagamentos salva');
  } catch (e) { toast(e.message, 'error'); }
}
async function admEpSubStatus(accId, status) {
  const lbl = { active: 'aprovar/reativar', suspended: 'suspender', rejected: 'rejeitar' }[status] || status;
  if (status !== 'active' && !confirm(`Tem certeza que deseja ${lbl} esta subconta?`)) return;
  try { await api('/admin/pagamentos/subaccounts/' + accId, { method: 'PUT', body: { status } }); toast('Subconta atualizada'); admEpPaint(); }
  catch (e) { toast(e.message, 'error'); }
}

// ==================== LIGAÇÕES (Calling API) — tela de chamada WhatsApp ====================
// Recebida: webhook "calls" (connect) chega por SSE com o SDP offer → overlay
// toca → Atender cria o RTCPeerConnection no navegador (áudio via WebRTC) e
// envia o SDP answer para a Meta. Recusar/Desligar usam as ações oficiais.
let callUI = null; // { id, waId, name, direction, phase: incoming|calling|active|ended, sdpOffer, pc, stream, timer, startedAt, muted }

// A FOTO DO CONTATO, se houver, vai para a tela da ligação: é ela que fica
// desfocada no fundo e dentro do círculo, como no iPhone.
function fotoDoContato(waId) {
  try {
    const c = (state.contacts || []).find(x => x.waId === waId);
    return (c && (c.photo || c.avatar || c.profilePic)) || '';
  } catch (e) { return ''; }
}

function onCallEvent(d) {
  if (d.kind === 'incoming') {
    if (callUI) return; // já em chamada, a Meta trata o busy do outro lado
    callUI = { ...d.call, sdpOffer: d.sdpOffer, phase: 'incoming', muted: false, foto: fotoDoContato(d.call && d.call.waId) };
    paintCall();
    if (window.ECNotify && ECNotify.startRing) ECNotify.startRing();
    if (window.ECNotify) {
      const who = (d.call && (d.call.name || d.call.contactName)) || (d.call && d.call.waId ? '+' + d.call.waId : 'Contato');
      ECNotify.notify({ type: 'call', title: 'Chamada de voz', body: who + ' está te ligando…', waId: d.call && d.call.waId, url: '/app/#/inbox', tag: 'call:' + (d.call && d.call.id), requireInteraction: true, callId: d.call && d.call.id });
    }
  } else if (d.kind === 'claimed') {
    // Outro aparelho (ou outro atendente) pegou a chamada. Este aqui para de
    // tocar na hora e diz quem atendeu — antes ficava chamando sozinho por uma
    // ligação que já estava acontecendo em outro lugar.
    if (!callUI || (d.call.id && callUI.id && callUI.id !== d.call.id)) return;
    if (eusQueAtendi) return;           // fui eu: a minha tela segue na chamada
    endCallUI(d.recusada ? `Recusada por ${d.por}` : `Atendida por ${d.por}`);
  } else if (d.kind === 'terminate') {
    if (callUI && callUI.id === d.call.id) {
      endCallUI(d.call.duration ? `Encerrada · ${fmtDur(d.call.duration * 1000, true)}` : 'Encerrada');
    }
  } else if (d.kind === 'update') {
    // O id só chega quando /calls/start responde; um `accept` que corra na
    // frente disso não pode ser descartado, senão a resposta SDP se perde.
    const minha = callUI && (!callUI.id || !d.call.id || callUI.id === d.call.id);
    if (!minha) return;
    if (d.sdp && d.sdpType === 'answer') aplicarResposta(d.sdp);
    if (['accepted', 'ringing'].includes(d.call.status)) {
      if (d.call.status === 'accepted' && callUI.phase === 'calling') { callUI.phase = 'active'; callUI.startedAt = Date.now(); }
      paintCall();
    }
  }
}

// Ligação nossa: a Meta devolve a resposta SDP do cliente por webhook. Sem
// aplicá-la o RTCPeerConnection fica só com a oferta local e nunca abre mídia
// — a chamada "completa" e ninguém ouve ninguém.
async function aplicarResposta(sdp) {
  const c = callUI;
  if (!c || !c.pc || c.pc.signalingState !== 'have-local-offer') return;
  try { await c.pc.setRemoteDescription({ type: 'answer', sdp }); }
  catch (e) { toast('Falha ao abrir o áudio da chamada', 'error'); }
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
  if (!callUI) { root.innerHTML = ''; marcarBarraChamada(false); return; }
  const c = callUI;
  const status = c.phase === 'active'
    ? `<span id="call-timer">00:00</span>`
    : `<span class="call-status-txt">${c.statusMsg || CALL_PHASE_LBL[c.phase] || ''}</span>`;
  // MINIMIZADA: vira uma pastilha que fica por cima do app e sai do caminho.
  // A ligação continua ativa — o que muda é só o tamanho. Sem isso, atender
  // significava perder o painel inteiro até desligar, e o atendente não
  // conseguia consultar a conversa enquanto falava, que é justamente a hora em
  // que ele mais precisa dela.
  if (c.min && c.phase !== 'ended') {
    root.innerHTML = `
      <div class="call-mini ${c.lado || 'dir'}" id="call-mini">
        <span class="call-mini-av">${esc(waInitials(c.name || c.waId))}</span>
        <div class="call-mini-tx">
          <b>${esc(c.name || '+' + c.waId)}</b>
          <span>${c.phase === 'active' ? `<i id="call-timer">00:00</i>` : (CALL_PHASE_LBL[c.phase] || '')}</span>
        </div>
        ${c.phase === 'incoming' ? `
          <button class="call-mini-btn green" onclick="answerCall()" title="Atender">${callIcon('up')}</button>
          <button class="call-mini-btn red" onclick="rejectCall()" title="Recusar">${callIcon('down')}</button>
        ` : `
          <button class="call-mini-btn" onclick="toggleMute()" title="${c.muted ? 'Ativar som' : 'Mudo'}">${callIcon('mic')}</button>
          <button class="call-mini-btn red" onclick="hangupCall()" title="Desligar">${callIcon('down')}</button>
        `}
        <button class="call-mini-btn ghost" onclick="restaurarChamada()" title="Abrir">${ico('maximize', 14)}</button>
      </div>`;
    if (c.phase === 'active') startCallTimer();
    ligarArrasto();
    marcarBarraChamada(true);
    return;
  }

  const chamando = c.phase === 'incoming' || c.phase === 'calling';
  root.innerHTML = `
    <div class="call-overlay">
      <!-- A FOTO DO CONTATO DESFOCADA no fundo, como no iPhone: diz de quem é
           a chamada sem disputar com o nome. Sem foto, fica o preto — e o
           preto é o certo: numa ligação não há nada para ler no fundo. -->
      ${c.foto ? `<img class="call-fundo" src="${esc(c.foto)}" alt="" aria-hidden="true">` : ''}
      <div class="call-veu"></div>

      <!-- Canto superior ESQUERDO e com rótulo: é o primeiro lugar onde se
           procura por "voltar/reduzir", e um ícone solto e translúcido no
           canto direito passava despercebido. -->
      <button class="call-min" onclick="minimizarChamada()" title="Minimizar a chamada">
        ${ico('minimize', 16)}<span>Minimizar</span>
      </button>

      <!-- O NOME NO PRIMEIRO TERÇO, não no centro: quem atende lê o nome
           primeiro e procura os botões depois. Centralizar tudo faz o olho
           percorrer a tela inteira duas vezes. -->
      <div class="call-id">
        <h2>${esc(c.name || '+' + c.waId)}</h2>
        <p class="call-status">${status}</p>
        <div class="call-selo">
          ${ico('lock', 11)} <span>${c.canal ? esc(c.canal) : 'WhatsApp'} · ponta a ponta</span>
        </div>
      </div>

      <div class="call-center">
        <span class="call-av ${chamando ? 'ring' : ''}">${c.foto
          ? `<img src="${esc(c.foto)}" alt="">`
          : esc(waInitials(c.name || c.waId))}</span>
      </div>

      <!-- ATENDER e RECUSAR nas PONTAS, e nunca lado a lado. São as duas ações
           irreversíveis da tela: errar o alvo aqui é desligar na cara do
           cliente. -->
      <div class="call-actions ${chamando ? 'atender' : ''}">
        ${c.phase === 'incoming' ? `
          <div class="call-act"><button class="call-btn red" onclick="rejectCall()" title="Recusar">${callIcon('down')}</button><span>Recusar</span></div>
          <div class="call-act"><button class="call-btn green pulse" onclick="answerCall()" title="Atender">${callIcon('up')}</button><span>Atender</span></div>
        ` : c.phase === 'ended' ? '' : `
          <div class="call-act"><button class="call-btn fosco ${c.muted ? 'on' : ''}" onclick="toggleMute()" title="Mudo">${callIcon('mic')}</button><span>${c.muted ? 'Ativar som' : 'Mudo'}</span></div>
          <div class="call-act"><button class="call-btn red" onclick="hangupCall()" title="Desligar">${callIcon('down')}</button><span>Desligar</span></div>
        `}
      </div>
    </div>`;
  marcarBarraChamada(false);       // em tela cheia não há barra para caber
  if (c.phase === 'active') startCallTimer();
}

// `body.em-chamada` é o que faz o app descer para caber a barra da ligação no
// celular (ver style.css). Sem isso a barra deitava por cima do cabeçalho e
// minimizar tirava justamente o que ela deveria devolver: o resto do app.
function marcarBarraChamada(ligada) {
  document.body.classList.toggle('em-chamada', !!ligada);
}
function minimizarChamada() { if (callUI) { callUI.min = true; paintCall(); } }
function restaurarChamada() { if (callUI) { callUI.min = false; paintCall(); } }

// ---------------------------------------------------------------------------
// ARRASTAR A PASTILHA
//
// No COMPUTADOR ela pode ir para qualquer canto: a pessoa arrasta e ela gruda
// no lado mais próximo, em cima ou embaixo. Grudar (em vez de parar solta no
// meio) é de propósito — a pastilha fica sempre fora do caminho do conteúdo, e
// a posição escolhida é lembrada.
//
// No CELULAR não há espaço para uma janela flutuando sobre o conteúdo: ela
// ocupa a largura toda no topo, como a barra verde do WhatsApp, e não arrasta.
// ---------------------------------------------------------------------------
const CALL_POS = 'ec_call_pos';
function ligarArrasto() {
  const el = $('#call-mini'); if (!el) return;
  if (isMobileLayout()) return;              // no celular a barra é fixa no topo

  const salvo = (() => { try { return JSON.parse(localStorage.getItem(CALL_POS) || 'null'); } catch { return null; } })();
  if (salvo) posicionarMini(el, salvo.x, salvo.y);

  let arrastando = false, dx = 0, dy = 0;
  const pegar = (e) => {
    // os botões continuam clicáveis: arrastar começa só pelo corpo da pastilha
    if (e.target.closest('button')) return;
    arrastando = true;
    const r = el.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    el.classList.add('arrastando');
    el.setPointerCapture(e.pointerId);
  };
  const mover = (e) => {
    if (!arrastando) return;
    posicionarMini(el, e.clientX - dx, e.clientY - dy);
  };
  const soltar = () => {
    if (!arrastando) return;
    arrastando = false;
    el.classList.remove('arrastando');
    // gruda no lado mais próximo
    const r = el.getBoundingClientRect();
    const margem = 16;
    const x = (r.left + r.width / 2) < window.innerWidth / 2
      ? margem : window.innerWidth - r.width - margem;
    const y = Math.max(margem, Math.min(window.innerHeight - r.height - margem, r.top));
    posicionarMini(el, x, y);
    try { localStorage.setItem(CALL_POS, JSON.stringify({ x, y })); } catch {}
  };
  el.addEventListener('pointerdown', pegar);
  el.addEventListener('pointermove', mover);
  el.addEventListener('pointerup', soltar);
  el.addEventListener('pointercancel', soltar);
}

function posicionarMini(el, x, y) {
  const m = 8;
  const maxX = window.innerWidth - el.offsetWidth - m;
  const maxY = window.innerHeight - el.offsetHeight - m;
  el.style.left = Math.max(m, Math.min(maxX, x)) + 'px';
  el.style.top = Math.max(m, Math.min(maxY, y)) + 'px';
  el.style.right = 'auto'; el.style.bottom = 'auto';
}

// O <audio> que toca a voz do cliente NÃO pode morar dentro do HTML que
// `paintCall` reescreve. Ele ficava lá: `ontrack` prendia o stream no elemento
// e, no repaint seguinte (o que troca a tela para "em chamada"), o elemento era
// jogado fora junto com o stream. A chamada conectava, o microfone ia embora
// normalmente e do outro lado não saía som nenhum — exatamente o sintoma.
function audioDaChamada() {
  let a = document.getElementById('call-audio');
  if (!a) {
    a = document.createElement('audio');
    a.id = 'call-audio';
    a.autoplay = true;
    a.setAttribute('playsinline', '');   // iOS não toca sem isto
    a.style.display = 'none';
    document.body.appendChild(a);
  }
  return a;
}

// Guarda o stream remoto e o liga no elemento persistente. O autoplay pode ser
// barrado quando a aba nunca recebeu um clique; aqui houve (Atender/Ligar), mas
// o play() explícito cobre o resto.
function ligarAudioRemoto(stream) {
  if (callUI) callUI.remoteStream = stream;
  const a = audioDaChamada();
  a.srcObject = stream;
  a.muted = false;
  a.volume = 1;
  const p = a.play();
  if (p && p.catch) p.catch(() => toast('Toque na tela para liberar o áudio da chamada'));
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

// Sem servidor STUN o navegador só descobre endereços da rede local, e atrás de
// qualquer NAT doméstico a mídia não acha caminho até a Meta: a chamada
// "conecta" na sinalização e fica muda. Os STUN públicos do Google resolvem o
// caso comum; redes corporativas fechadas ainda precisariam de um TURN, que é
// serviço pago e fica para quando alguém reclamar.
const RTC_CFG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
};

// Espera o ICE terminar de colher candidatos (SDP completo, sem trickle)
function waitIce(pc, ms = 2500) {
  return new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const to = setTimeout(res, ms);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(to); res(); } };
  });
}

// ATENDER — WebRTC no navegador: mic local + SDP answer para a Meta
// Marca que ESTE aparelho é quem está atendendo: sem isso, o aviso de "chamada
// atendida" que o servidor manda para todos fecharia também a tela de quem
// acabou de atender.
let eusQueAtendi = false;

async function answerCall() {
  const c = callUI; if (!c || c.phase !== 'incoming') return;
  pararToque();
  eusQueAtendi = true;
  try {
    c.statusMsg = 'Conectando…'; paintCall();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection(RTC_CFG);
    c.pc = pc; c.stream = stream;
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.ontrack = ev => ligarAudioRemoto(ev.streams[0]);
    await pc.setRemoteDescription({ type: 'offer', sdp: c.sdpOffer });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitIce(pc);
    await api(`/calls/${c.id}/accept`, { body: { sdp: pc.localDescription.sdp } });
    c.phase = 'active'; c.statusMsg = ''; c.startedAt = Date.now();
    paintCall();
  } catch (e) {
    eusQueAtendi = false;
    // Corrida perdida: outro aparelho pegou a chamada primeiro. Não é erro do
    // atendente, então a tela se fecha com o motivo em vez de mostrar falha.
    if (/já foi atendida/i.test(e.message || '')) {
      endCallUI(e.message.replace(/^Esta ligação /, '').replace(/\.$/, ''));
      return;
    }
    toast(e.message, 'error');
    endCallUI('Falha ao conectar');
  }
}

// ---------------------------------------------------------------------------
// ATENDER VINDO DA NOTIFICAÇÃO (ou depois do app ter dormido)
//
// No celular a ligação quase sempre chega com o app em segundo plano. O sistema
// operacional derruba o SSE nessa hora, então o evento "está tocando" nunca
// chegou nesta aba: `callUI` está vazio e não há o que atender.
//
// Aqui a chamada é remontada a partir do servidor (/calls/pending, que devolve
// o SDP offer) e só então atendida. Se ela já acabou ou outro aparelho pegou,
// avisa em vez de deixar a pessoa esperando uma tela que não vem.
// ---------------------------------------------------------------------------
// `tocar` só na volta do segundo plano: aí a tela aparece chamando, com o botão
// Atender, como se o evento nunca tivesse se perdido. Vindo da notificação a
// chamada é atendida em seguida, e começar a tocar para parar meio segundo
// depois seria só um susto.
async function recuperarChamadaPendente(tocar) {
  if (callUI) return callUI;
  let r = null;
  try { r = await api('/calls/pending'); } catch { return null; }
  if (!r || !r.call || !r.sdpOffer) return null;
  callUI = { ...r.call, sdpOffer: r.sdpOffer, phase: 'incoming', muted: false };
  paintCall();
  if (tocar && window.ECNotify && ECNotify.startRing) ECNotify.startRing();
  return callUI;
}

async function atenderChamadaPorId(id) {
  // Já está na tela: é a mesma chamada, atende direto.
  if (!callUI || (id && callUI.id !== id)) {
    if (!callUI && !(await recuperarChamadaPendente())) {
      toast('Esta ligação já foi encerrada ou atendida em outro aparelho');
      return;
    }
  }
  if (callUI && callUI.phase === 'incoming') answerCall();
}

async function recusarChamadaPorId(id) {
  if (callUI && (!id || callUI.id === id)) { rejectCall(); return; }
  try { await api(`/calls/${id}/reject`, { body: {} }); } catch {}
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

// LIGAR PARA O CLIENTE SAIU DO PRODUTO.
//
// A Calling API da Meta só permite a ligação partindo do CLIENTE, a não ser
// que ele tenha dado permissão explícita antes — e essa permissão é rara na
// prática. Um botão "Ligar" que quase sempre falha e abre um pedido de
// permissão no lugar da chamada não é um recurso, é uma armadilha: o atendente
// aperta esperando falar com a pessoa e recebe um erro.
//
// O que fica: RECEBER ligações, que funciona sempre. As rotas /calls/start e
// /calls/permission continuam no servidor — se a Meta liberar, é só voltar a
// chamar. O restante do fluxo (atender, recusar, mudo, desligar) é o mesmo.

// O toque precisa parar por QUALQUER saída da chamada — atender, recusar,
// desligar, o cliente desistir ou uma falha de conexão. Todas passam por aqui
// ou por answerCall, então é nesses dois pontos que ele para.
function pararToque() { if (window.ECNotify && ECNotify.stopRing) ECNotify.stopRing(); }

// Apaga a notificação daquela chamada, esteja ela onde estiver: a que este
// navegador criou e a que o Service Worker mostrou com o app fechado.
async function fecharAvisoDaChamada(id) {
  if (!id) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const abertas = reg ? await reg.getNotifications({ tag: 'call:' + id }) : [];
    abertas.forEach(n => n.close());
  } catch (e) { /* sem service worker: não há o que fechar */ }
}

// A CHAMADA FOI RESOLVIDA EM OUTRO APARELHO. O aviso na tela de bloqueio ja
// foi apagado pelo Service Worker; aqui a tela de chamada fecha junto, para
// nao sobrar um "Atender" que nao atende mais nada.
function chamadaEncerradaEmOutroAparelho(d) {
  d = d || {};
  if (!callUI) return;
  if (d.callId && callUI.id && d.callId !== callUI.id) return;
  endCallUI('Atendida em outro aparelho');
}

function endCallUI(msg) {
  const c = callUI; if (!c) return;
  pararToque();
  // A NOTIFICAÇÃO DA CHAMADA SOME JUNTO. Ela é `requireInteraction`: fica na
  // tela até alguém tocar. Encerrada a ligação, ela vira um convite para
  // atender uma chamada que não existe mais.
  fecharAvisoDaChamada(c.id);
  eusQueAtendi = false;          // a próxima chamada começa do zero
  clearInterval(c.timerIv);
  try { c.stream && c.stream.getTracks().forEach(t => t.stop()); } catch {}
  try { c.pc && c.pc.close(); } catch {}
  // o elemento de áudio é persistente agora: solta o stream para o navegador
  // não segurar o microfone/alto-falante depois de desligar
  try { const a = document.getElementById('call-audio'); if (a) { a.pause(); a.srcObject = null; } } catch {}
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
  if (ms == null) return '-';
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
            <td style="text-align:right">${r.avgRatingPercent == null ? '-' : r.avgRatingPercent + '%'}</td>
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

// Botão da IA no cabeçalho da conversa. Só aparece se o agente estiver ligado
// na conta: um interruptor para algo que não existe só confundiria.
// `iaOff` é por CONVERSA — desligar aqui não mexe nas outras.
function iaBotaoChat() {
  // Sem o agente ligado na CONTA não há o que alternar aqui: um interruptor
  // para algo que não existe só faria o atendente procurar o problema no
  // lugar errado. O aviso diz onde ligar.
  if (!state.iaLigada) {
    return `<a class="ia-switch off" href="#/ia" title="O Agente de IA ainda não está configurado nesta conta. Clique para configurar">
      ${ico('zap', 13)}<i class="blbl">IA desativada</i></a>`;
  }
  const c = state.currentContact || {};
  const ligada = !c.iaOff;
  // Interruptor de verdade, e não um botão que "parece" um: o atendente
  // precisa ver o ESTADO de relance no meio do atendimento, sem ler o rótulo.
  return `<button class="ia-switch ${ligada ? 'on' : ''}" onclick="alternarIAConversa(${!ligada})"
    aria-pressed="${ligada}"
    title="${ligada
      ? 'A IA está respondendo esta conversa. Clique para assumir você'
      : 'Você está atendendo. Clique para devolver esta conversa à IA'}">
    ${ico('zap', 13)}<i class="blbl">IA</i><span class="ia-track"><span class="ia-knob"></span></span></button>`;
}
async function alternarIAConversa(ligar) {
  if (!state.currentWaId) return;
  try {
    const r = await api('/ia/conversa/' + encodeURIComponent(state.currentWaId), { method: 'PUT', body: { ligada: !!ligar } });
    if (state.currentContact) state.currentContact.iaOff = !r.ligada;
    toast(r.ligada ? 'IA respondendo nesta conversa' : 'IA desligada nesta conversa');
    paintSession();
  } catch (e) { toast(e.message, 'error'); }
}

// ==================== AGENTE DE IA ====================
// A chave da OpenAI é do cliente e fica na conta dele. O prompt também: é aqui
// que ele escreve como o agente deve atender, sem sair do Koonfy.
async function renderIA() {
  $('#view').innerHTML = `<div class="page"><div id="ia-box">${skel(5)}</div></div>`;
  paintIA();
}

async function paintIA() {
  const box = $('#ia-box'); if (!box) return;
  let d;
  try { d = await api('/ia'); } catch (e) { box.innerHTML = `<div class="danger-box">${esc(e.message)}</div>`; return; }
  const c = d.config;
  const canais = d.canais || [];
  box.innerHTML = `
    <div class="page-head row">
      <div style="flex:1"><h1>Agente de IA</h1><p>Responde sozinho quando o atendimento está aberto, ninguém assumiu e não há automação rodando</p></div>
    </div>

    <div class="card">
      <h2>${ico('zap')} Ligar o agente</h2>
      <label class="chk"><input type="checkbox" id="ia-on" ${c.enabled ? 'checked' : ''} onchange="salvarIA({enabled:this.checked})">
        Deixar a IA responder automaticamente</label>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">
        A IA fica calada quando: um atendente assumiu a conversa, o contato está no meio de uma
        automação, o atendimento foi finalizado, a janela de 24h fechou, ou você desligou a IA
        naquela conversa pelo botão do chat.
      </p>
    </div>

    <div class="card">
      <h2>${ico('shield')} Chave da OpenAI</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        Crie uma chave em <b>platform.openai.com → API keys</b> e cole abaixo. O consumo é cobrado
        pela OpenAI direto no seu cartão, não passa pelo Koonfy.
      </p>
      <div class="row">
        <label style="flex:2">Chave da API ${c.temChave ? `<span class="pill done" style="margin-left:6px">Salva ••••${esc(c.chaveFim)}</span>` : ''}
          <input id="ia-key" type="password" placeholder="sk-..."></label>
        <button class="btn primary no-grow" onclick="salvarIA({apiKey:$('#ia-key').value})">${ico('save', 14)} Salvar chave</button>
      </div>
      <div class="row" style="margin-top:12px">
        <label style="flex:1;max-width:340px">Modelo${ecSelect('ia-model',
          (d.modelos || []).map(([v, l]) => ({ value: v, label: l })), c.model, 'salvarModeloIA()')}</label>
      </div>
    </div>

    <div class="card">
      <h2>${ico('file')} Instruções do agente</h2>
      <p class="muted" style="margin:0 0 12px;font-size:13px">
        Escreva como ele deve atender: quem é a empresa, o que vende, preços, prazos, o que pode e o
        que não pode prometer. Quanto mais específico, menos ele inventa.
      </p>
      <textarea id="ia-prompt" rows="12" placeholder="Você é o atendente da Loja X, que vende...">${esc(c.prompt || '')}</textarea>
      <div class="row" style="margin-top:12px">
        <button class="btn primary no-grow" onclick="salvarIA({prompt:$('#ia-prompt').value})">${ico('save', 14)} Salvar instruções</button>
        <button class="btn no-grow" onclick="testarIA(this)">${ico('activity', 14)} Testar resposta</button>
      </div>
      <div id="ia-teste"></div>
    </div>

    <div class="card">
      <h2>${ico('phone')} Em quais WhatsApps</h2>
      ${canais.length > 1
        ? `<p class="muted" style="margin:0 0 12px;font-size:13px">Deixe tudo desmarcado para a IA atender em todos os números.</p>
           <div class="ia-canais">${canais.map(ch => `
             <label class="chk"><input type="checkbox" value="${esc(ch.id)}" ${(c.channels || []).includes(ch.id) ? 'checked' : ''} onchange="salvarCanaisIA()">
               <span><b>${esc(ch.label)}</b>${ch.numero ? `<em>${esc(ch.numero)}</em>` : ''}</span></label>`).join('')}</div>`
        : `<p class="muted" style="margin:0;font-size:13px">Você tem um número só, então a IA atende nele. Ao conectar outro WhatsApp, dá para escolher aqui em quais ela responde.</p>`}
    </div>

    <div class="card">
      <h2>${ico('gear')} Ajustes</h2>
      <div class="row">
        <label style="flex:1">Mensagens de contexto<input id="ia-hist" inputmode="numeric" value="${esc(String(c.historico))}"></label>
        <label style="flex:1">Tamanho máximo da resposta<input id="ia-max" inputmode="numeric" value="${esc(String(c.maxSaida))}"></label>
      </div>
      <label style="margin-top:12px">Assinatura no fim da mensagem (opcional)
        <input id="ia-assin" value="${esc(c.assinatura || '')}" placeholder="atendimento automático"></label>
      <button class="btn primary no-grow" style="margin-top:12px" onclick="salvarIA({historico:$('#ia-hist').value,maxSaida:$('#ia-max').value,assinatura:$('#ia-assin').value})">${ico('save', 14)} Salvar ajustes</button>
    </div>

    ${(d.logs || []).length ? `<div class="card">
      <h2>${ico('activity')} Últimas respostas</h2>
      <table><thead><tr><th>Quando</th><th>Contato</th><th>O que houve</th></tr></thead><tbody>
        ${d.logs.map(l => `<tr>
          <td class="muted" style="font-size:12px">${fmtTime(l.ts)}</td>
          <td>${esc(l.waId || '')}</td>
          <td>${l.tipo === 'resposta'
            ? `<span class="pill done">respondeu</span> ${l.chars} caracteres`
            : `<span class="pill">${esc(l.tipo)}</span> <span class="muted">${esc(l.erro || '')}</span>`}</td>
        </tr>`).join('')}
      </tbody></table></div>` : ''}`;
}

async function salvarIA(patch) {
  try { await api('/ia', { method: 'PUT', body: patch }); toast('Salvo'); paintIA(); }
  catch (e) { toast(e.message, 'error'); }
}
function salvarModeloIA() { salvarIA({ model: ecSelVal('ia-model') }); }
async function salvarCanaisIA() {
  const ids = [...document.querySelectorAll('.ia-canais input:checked')].map(i => i.value);
  await salvarIA({ channels: ids });
}
async function testarIA(btn) {
  const out = $('#ia-teste');
  const t = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Perguntando…';
  try {
    // Salva o prompt antes: testar o texto que está na tela, e não o que foi
    // salvo da última vez, é o que a pessoa espera.
    await api('/ia', { method: 'PUT', body: { prompt: $('#ia-prompt').value } });
    const r = await api('/ia/testar', { body: { pergunta: 'Olá! Vocês estão atendendo?' } });
    out.innerHTML = `<div class="capi-box" style="margin-top:12px">
      <div class="capi-head">${ico('check', 14)} Resposta do agente</div>
      <p style="margin:8px 0 0;font-size:13.5px;white-space:pre-wrap">${esc(r.texto)}</p></div>`;
  } catch (e) {
    out.innerHTML = `<div class="danger-box" style="margin-top:12px">${esc(e.message)}</div>`;
  } finally { btn.disabled = false; btn.innerHTML = t; }
}

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
  const saldo = d.balance || 0;
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

  const preco = d.priceCents || 0;
  box.innerHTML = `
  <div class="two-col">
    <div class="card">
      <h2>${ico('send')} Enviar SMS</h2>
      <p class="muted" style="margin:2px 0 14px;font-size:13px">
        ${d.from ? `Remetente <b>${esc(d.from)}</b>. ` : ''}Cada ${fmtN(d.maxLen)} caracteres contam como um SMS${preco ? `, cobrado a ${fmtBRL(preco)} do seu saldo` : ' e o envio é por nossa conta'}.
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
      <h2>${ico('activity')} Custo do disparo</h2>
      <p class="muted" style="margin:2px 0 0;font-size:13px">
        O SMS não tem cota no seu plano: você paga por envio, com o saldo da carteira.
      </p>
      <div class="wallet-bal" style="margin-top:12px">
        <div><span class="muted" style="font-size:12px">Preço por SMS</span>
          <div style="font-size:26px;font-weight:800;color:var(--verde-deep)">${preco ? fmtBRL(preco) : 'grátis'}</div></div>
        <div style="text-align:right"><span class="muted" style="font-size:12px">Seu saldo</span>
          <div style="font-size:20px;font-weight:800">${fmtBRL(saldo)}</div>
          <span class="muted" style="font-size:11.5px">${preco ? fmtN(Math.floor(saldo / preco)) + ' SMS' : 'sem custo'}</span></div>
      </div>
      ${preco && saldo < preco ? `<p class="hint" style="text-align:left;margin-top:10px">${ico('alert', 12)} Saldo insuficiente para enviar. <a href="#/billing"><b>Recarregar carteira</b></a></p>` : ''}
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
            <td>${r.uf ? `<span title="${esc(r.ufName)}">${esc(r.uf)}</span>` : '<span class="muted">-</span>'}</td>
            <td>${r.city ? esc(r.city) : '<span class="muted">-</span>'}</td>
            <td>${coSourceHtml(r.source)}</td>
            <td>${r.lastCampaign ? esc(r.lastCampaign) : '<span class="muted">-</span>'}</td>
            <td>${r.lastAgent ? esc(r.lastAgent) : '<span class="muted">-</span>'}</td>
            <td>${r.stage ? esc(r.stage) : '<span class="muted">-</span>'}</td>
            <td class="muted" style="white-space:nowrap">${r.optOutAt ? new Date(r.optOutAt).toLocaleString('pt-BR') : '-'}</td>
            <td>${r.optOutReason ? esc(r.optOutReason) : '<span class="muted">-</span>'}</td>
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
//
// Cada uma com o LOGO de quem é. Um carrinho de linha não diz "Nuvemshop"
// para ninguém: marca se reconhece pelo desenho dela. Os arquivos são os
// mesmos da esteira de integrações da vitrine.
function logoInt(arq, tam) {
  const t = tam || 16;
  return `<img src="/assets/logos/${arq}.webp" alt="" width="${t}" height="${t}"
    style="border-radius:4px;flex:none" decoding="async">`;
}
let intTab = 'webhooks';
let nsAvailable = null;   // cache: admin liberou a integração Nuvemshop?
function setIntTab(t) { intTab = t; renderIntegrations(); }

async function renderIntegrations() {
  // Integrações ainda não liberadas pelo admin nem aparecem na lista de abas —
  // nada de "em breve" entregando roadmap para concorrente.
  if (nsAvailable === null) { try { nsAvailable = (await api('/integrations/nuvemshop')).nuvemshop.available; } catch { nsAvailable = false; } }
  if (!nsAvailable && intTab === 'nuvemshop') intTab = 'webhooks';
  // O webhook fica com o desenho de conexão: ali não há marca, é o encaixe
  // genérico para qualquer sistema que fale HTTP.
  const tabs = [['webhooks', 'Webhooks', 'webhook']];
  if (nsAvailable) tabs.push(['nuvemshop', 'Nuvemshop', 'nuvemshop']);
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row" style="align-items:center">
      <div style="flex:1"><h1>Integrações</h1><p>Conecte o Koonfy às ferramentas e à loja que você já usa</p></div>
      ${intTab === 'webhooks' ? `<button class="btn primary no-grow" onclick="createWebhook()">${ico('plus', 14)} Novo webhook</button>` : ''}
    </div>
    <div class="seg int-tabs">${tabs.map(([k, l, i]) => `<button class="${k === intTab ? 'on' : ''}" onclick="setIntTab('${k}')">${logoInt(i, 15)} ${l}</button>`).join('')}</div>
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
      <p class="muted" style="margin:6px auto 16px;max-width:460px">Crie um webhook para receber eventos de checkout, formulários ou outro CRM. Cada evento vira um contato no Koonfy e pode disparar uma automação.</p>
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

// ---- Editor de Mapeamento de Campos (igual Koonfy 1.0, em página) ----
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
  // O menu acompanha na hora: quem acabou de conectar não deveria precisar
  // recarregar a página para a aba da loja aparecer, nem ficar com ela no
  // menu depois de desconectar.
  if (state.nsConectada !== !!nsCfg.connected) {
    state.nsConectada = !!nsCfg.connected;
    applyNavPermissions();
  }
  paintNuvemshop();
}

function paintNuvemshop() {
  const box = $('#int-body'); if (!box || intTab !== 'nuvemshop') return;
  const c = nsCfg;

  // Admin ainda não liberou a integração.
  if (!c.available) {
    box.innerHTML = `<div class="empty-state card"><div class="big">${ico('cart', 38)}</div>
      <b>Integração com a Nuvemshop em breve</b>
      <p class="muted" style="margin:6px auto 0;max-width:520px">Estamos finalizando a publicação do app oficial do Koonfy na Nuvemshop.
      Assim que estiver disponível, você conecta sua loja aqui em um clique, sem precisar de código, App ID ou chaves.</p></div>`;
    return;
  }

  // Cabeçalho padrão dos passos: ícone + título/descrição + status.
  // `icon` pode ser um ícone do sistema ou o nome de um arquivo de logo. Os
  // dois cabem na mesma caixa de 40px, e é o que permite trocar o carrinho
  // genérico pela marca sem mexer no layout.
  const LOGOS_INT = ['nuvemshop', 'webhook'];
  const hd = (icon, num, titulo, desc, pill) => `<div class="ns-hd">
    <span class="ns-ic">${LOGOS_INT.includes(icon) ? logoInt(icon, 22) : ico(icon, 18)}</span>
    <div class="ns-hd-txt"><b>${num ? num + '. ' : ''}${titulo}</b><span>${desc}</span></div>
    ${pill}
  </div>`;

  // Passo 1 — conexão OAuth com a loja (é tudo que o cliente precisa fazer).
  const passo1 = `<div class="card">
    ${hd(c.connected ? 'check-circle' : 'nuvemshop', 1, 'Conectar sua loja',
      c.connected
        ? `Loja <b>${esc(c.storeName || c.storeId)}</b> conectada ${c.connectedAt ? timeAgo(c.connectedAt) : ''}`
        : 'Autorize o Koonfy a ler os pedidos e clientes da sua loja',
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
          ['Confirme as permissões', 'O Koonfy pede acesso de leitura a pedidos e clientes, nada é alterado na sua loja'],
          ['Pronto', 'A janela fecha sozinha e sua loja aparece conectada aqui']
        ].map(([t, d], i) => `<div class="ns-step"><span class="ns-step-n">${i + 1}</span>
          <div><b>${t}</b><span>${d}</span></div></div>`).join('')}
      </div>
      <div class="ns-actions">
        <button class="btn primary no-grow" onclick="connectNs()">${ico('link', 13)} Conectar loja Nuvemshop</button>
        <span class="ns-nota">Permita pop-ups no navegador para a janela abrir.</span>
      </div>
      <p class="muted" style="font-size:12.5px;margin:14px 0 0">
        Ainda não tem loja na Nuvemshop?
        <a href="${NS_AFILIADO}" target="_blank" rel="noopener"><b>Crie a sua aqui</b></a>
        e volte para conectar.
      </p>`}
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
    if (d.type !== 'KOONFY_NUVEMSHOP_CALLBACK') return;
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
  if (!await confirmModal({ title: 'Desconectar loja', text: 'O Koonfy deixa de receber pedidos e clientes desta loja. As credenciais do app são mantidas.', ok: 'Desconectar', danger: true })) return;
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
  list: { icon: 'list', label: 'Item selecionado', color: 'blue', desc: 'Dispara quando o cliente escolhe um item de uma lista' },
  nuvemshop: { icon: 'cart', label: 'Loja Nuvemshop', color: 'blue', desc: 'Dispara num evento da loja: compra aprovada, pedido enviado, carrinho abandonado' }
};

// OS EVENTOS DA LOJA e o que cada um entrega para a mensagem.
//
// A lista de variáveis não é decoração: sem saber que `{{pedido_rastreio}}`
// existe, ninguém escreve o aviso de envio. Elas aparecem no inspetor do
// gatilho, prontas para copiar.
const NS_EVENTOS = [
  { v: 'order/paid', l: 'Compra aprovada', d: 'O pagamento foi confirmado' },
  { v: 'order/fulfilled', l: 'Pedido enviado', d: 'Saiu para entrega, com rastreio quando houver' },
  { v: 'cart/abandoned', l: 'Carrinho abandonado', d: 'Chegou no checkout e não terminou' },
  { v: 'order/created', l: 'Pedido criado', d: 'Fechou o pedido, ainda sem pagar' },
  { v: 'order/pending', l: 'Pagamento pendente', d: 'Boleto ou Pix gerado e não pago' },
  { v: 'order/packed', l: 'Pedido embalado', d: 'A loja separou e embalou' },
  { v: 'order/cancelled', l: 'Pedido cancelado', d: 'A loja ou o cliente cancelou' },
  { v: 'order/voided', l: 'Pedido estornado', d: 'O valor foi devolvido' },
  { v: 'order/updated', l: 'Pedido alterado', d: 'Qualquer mudança no pedido' },
  { v: 'customer/created', l: 'Cliente novo', d: 'Alguém se cadastrou na loja' }
];
// As variáveis mudam conforme o evento: carrinho não tem número de pedido,
// pedido não tem link de carrinho.
const NS_VARS_PEDIDO = ['primeiro_nome', 'nome', 'telefone', 'email', 'loja',
  'pedido_numero', 'pedido_total', 'pedido_itens', 'pedido_qtd', 'pedido_status',
  'pedido_pagamento', 'pedido_envio', 'pedido_frete', 'pedido_cupom', 'pedido_link',
  'pedido_rastreio', 'pedido_rastreio_url', 'pedido_transportadora', 'pedido_entrega_previsao'];
const NS_VARS_CARRINHO = ['primeiro_nome', 'nome', 'telefone', 'email', 'loja',
  'carrinho_link', 'carrinho_total', 'carrinho_itens', 'carrinho_qtd'];
const NS_VARS_CLIENTE = ['primeiro_nome', 'nome', 'telefone', 'email', 'loja',
  'cliente_total_gasto', 'cliente_pedidos'];
function nsVarsDoEvento(ev) {
  if (ev === 'cart/abandoned') return NS_VARS_CARRINHO;
  if (String(ev).startsWith('customer/')) return NS_VARS_CLIENTE;
  return NS_VARS_PEDIDO;
}

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
  payment: { icon: 'pix', label: 'Cobrança Pix', sub: 'Pagamentos', color: 'green', cat: 'messages' },
  sms: { icon: 'message', label: 'Enviar SMS', sub: 'Mensagem', color: 'blue', cat: 'messages' },
  end: { icon: 'square', label: 'Fim', sub: 'Encerrar', color: 'gray', cat: 'logic' }
};
const FB_PALETTE = {
  triggers: { label: 'Gatilhos', items: ['keyword', 'nuvemshop', 'webhook', 'link', 'button', 'list'] },
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
          <button class="btn small" onclick="verCtrFluxo('${f.id}')" title="Quantos clicaram em cada botão">${ico('activity', 13)} Desempenho</button>
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

// Desempenho dos botões do fluxo. Para o botão de LINK é a única medida que
// existe: a pessoa sai para o site e não volta com resposta que o fluxo leia.
async function verCtrFluxo(id) {
  let d;
  try { d = await api('/flows/' + id + '/ctr'); }
  catch (e) { return toast(e.message, 'error'); }
  const nos = d.nos || [];
  const barra = (pct) => `<div class="ctr-bar"><i style="width:${Math.min(100, pct)}%"></i></div>`;
  openModal(`<h2>${ico('activity')} Desempenho dos botões</h2>
    ${nos.length ? nos.map(n => `
      <div class="card" style="margin-top:12px">
        <div class="row" style="align-items:baseline">
          <b style="flex:1">${esc(n.texto || 'Mensagem com opções')}</b>
          <span class="muted" style="font-size:12px">${fmtN(n.enviados)} receberam</span>
        </div>
        <div class="row" style="align-items:baseline;margin-top:2px">
          <span class="muted" style="flex:1;font-size:12.5px">${fmtN(n.cliques)} clicaram em alguma opção</span>
          <b style="font-size:15px">${n.ctr}%</b>
        </div>
        ${barra(n.ctr)}
        <table style="margin-top:12px"><thead><tr><th>Botão</th><th style="text-align:right">Cliques</th><th style="text-align:right">CTR</th></tr></thead><tbody>
          ${n.opcoes.map(o => `<tr>
            <td>${esc(o.titulo)}</td>
            <td style="text-align:right">${fmtN(o.cliques)}</td>
            <td style="text-align:right"><b>${o.ctr}%</b></td>
          </tr>`).join('')}
        </tbody></table>
      </div>`).join('')
      : `<p class="muted" style="margin:10px 0 0;font-size:13px">Este fluxo ainda não enviou nenhuma mensagem com botões.
         Assim que enviar, aparece aqui quantas pessoas receberam e quantas clicaram em cada opção.</p>`}
    <p class="hint" style="margin-top:14px">${ico('info', 11)} Contagem por pessoa: quem toca duas vezes no mesmo botão conta uma vez só.</p>
    <div class="row" style="margin-top:14px"><button class="btn no-grow" onclick="closeModal()">Fechar</button></div>`);
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
      return tr.type === 'keyword' ? `"${tr.keyword || '-'}"` : tr.type === 'link' ? `"${tr.phrase || '-'}"`
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
    case 'media': return `${n.kind || 'image'} · ${(n.link || '-').slice(0, 30)}`;
    case 'template': return `Template: ${n.templateName || '-'}`;
    case 'ai': return (n.prompt || 'Resposta automática por IA').slice(0, 52);
    case 'http': return `${n.method || 'POST'} ${(n.url || '-').slice(0, 34)}`;
    case 'payment': return `Pix de R$ ${n.value || '-'}${n.description ? ' · ' + n.description.slice(0, 24) : ''}`;
    case 'delay': return `Aguardar ${n.seconds || 0}s`;
    case 'condition': return `Se ${n.field || 'texto'} ${OP_LBL[n.op] || 'contém'} "${(n.value || '').slice(0, 18)}"`;
    case 'sms': return n.text ? `SMS: ${String(n.text).slice(0, 40)}${n.text.length > 40 ? '…' : ''}` : 'SMS sem mensagem';
    case 'addtag': return `+ tag "${n.tag || '-'}"`;
    case 'removetag': return `− tag "${n.tag || '-'}"`;
    case 'movestage': return `→ ${n.stage || '-'}`;
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
  } else if (tr.type === 'nuvemshop') {
    const opts = NS_EVENTOS.map(e => ({ value: e.v, label: e.l }));
    const ev = tr.nsEvent || opts[0].value;
    const meta = NS_EVENTOS.find(e => e.v === ev);
    const vars = nsVarsDoEvento(ev);
    cfg = `<label>Evento da loja${ecSelect('fb-trig-ns', opts, ev, "fbSetTrig('nsEvent',val)")}</label>
      ${meta ? `<p class="muted" style="font-size:12px;margin:6px 0 0">${esc(meta.d)}.</p>` : ''}
      ${ev === 'cart/abandoned' ? `<p class="muted" style="font-size:12px;margin:8px 0 0">
        O tempo de espera antes de considerar o carrinho abandonado fica em
        <a href="#/nuvemshop">Nuvemshop → Carrinhos</a>.</p>` : ''}
      <div class="fb-vars"><span class="fb-sub">Variáveis deste evento</span>
        <div class="fb-var-chips">${vars.map(v => `<code onclick="copyText('{{${v}}}')" title="Copiar">{{${v}}}</code>`).join('')}</div>
        <p class="muted" style="font-size:11px;margin:6px 0 0">Use em textos, botões e templates. Valor já vem formatado.</p></div>`;
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

// Cada botão tem a SUA porta de saída no nó do canvas, e é dela que se puxa o
// caminho daquela resposta. A porta é desenhada por `renderNodes`, então mexer
// nos botões sem repintar o nó deixava o inspetor cheio de botões e o canvas
// sem nenhuma saída para ligar — que era o motivo de não dar para ramificar.
function fbRepintarPortas(id) { renderNodes(); renderEdges(); refreshPreview(id); scheduleSave(); }

// O id do botão É o caminho dele. `Date.now()` sozinho não serve: dois botões
// criados no mesmo milissegundo saíam com o MESMO id, os dois ramos viravam
// "opt:<mesmo id>" e as duas respostas caíam no mesmo lugar — o cliente
// escolhia uma coisa e recebia outra. O contador garante que não se repita.
let fbBtnSeq = 0;
function fbNovoIdBotao() { return 'b' + Date.now().toString(36) + (++fbBtnSeq).toString(36); }

function fbAddBtn(id) {
  const n = nodeById(id); if (!n) return;
  n.buttons = n.buttons || [];
  if (n.buttons.length >= FB_BTN_MAX) return;
  const before = fbTextFormat(n);
  n.buttons.push({ id: fbNovoIdBotao(), title: '' });
  // cruzar 3 opções troca o formato (botões → lista): repinta o inspetor inteiro
  if (fbTextFormat(n) !== before) renderInspector(); else $('#fb-btns').innerHTML = fbBtnRows(n, fbTextFormat(n) === 'list' ? 24 : 20);
  fbRepintarPortas(id);
}
function fbDelBtn(id, i) {
  const n = nodeById(id); if (!n) return;
  const before = fbTextFormat(n);
  // O caminho que saía deste botão morre com ele. Sem isto ficava uma linha
  // apontando para um botão que não existe mais, e o fluxo travava ali.
  const morto = n.buttons[i];
  if (morto) {
    const ramo = fbOptBranch(morto.id || `btn_${i + 1}`);
    flowDraft.graph.edges = flowDraft.graph.edges.filter(e => !(e.from === id && e.branch === ramo));
  }
  n.buttons.splice(i, 1);
  if (fbTextFormat(n) !== before) renderInspector(); else $('#fb-btns').innerHTML = fbBtnRows(n, fbTextFormat(n) === 'list' ? 24 : 20);
  fbRepintarPortas(id);
}
function fbBtnTitle(id, i, v) {
  const n = nodeById(id); if (!n) return;
  n.buttons[i].title = v;
  const max = fbTextFormat(n) === 'list' ? 24 : 20;
  const c = $$('.fb-btn-row')[i]?.querySelector('.sv-count');
  if (c) { c.textContent = `${v.length}/${max}`; c.classList.toggle('over', v.length > max); }
  // A porta só existe quando o botão tem título — é digitando que ela nasce.
  // Repintar só o canvas: o inspetor fica de pé e o campo não perde o foco.
  fbRepintarPortas(id);
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
      <p class="muted" style="font-size:11.5px;margin-top:8px">${ico('shield', 11)} Requer conta Pagamentos ativa. O valor aceita variáveis (ex.: {{valor}} vindo de um webhook).</p>`;
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
    body = `<p class="fb-insp-desc">Envia um <b>SMS</b> para o mesmo número do contato.
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
  flowDraft.trigger = {
    type, keyword: cur.keyword || '', match: cur.match || 'contains',
    phrase: cur.phrase || '', hookToken: cur.hookToken, webhookId: cur.webhookId || '',
    // O evento da loja sobrevive à troca de tipo: quem experimenta outro
    // gatilho e volta não perde a escolha.
    nsEvent: cur.nsEvent || 'order/paid'
  };
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
// O id é o que amarra o caminho ao botão. Sem ele o ramo virava "btn_2" pela
// POSIÇÃO, e apagar o primeiro botão fazia o segundo herdar o caminho do que
// foi apagado.
function addButton(id) { const n = nodeById(id); if (n.buttons.length < 3) n.buttons.push({ id: fbNovoIdBotao(), title: '' }); renderInspector(); renderNodes(); renderEdges(); refreshPreview(id); scheduleSave(); }
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
        <div><b>${s.lastRun ? timeAgo(s.lastRun) : '-'}</b><span>Última execução</span></div>
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
// Fluxo oficial Meta v26.0: popup -> authorization_code -> backend faz
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
  if (e.origin === location.origin && e.data && e.data.type === 'KOONFY_META_CALLBACK') {
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
  const pop = openAuthWindow(url, 'koonfy_es', 'width=700,height=780');
  if (!pop) esFail('Popup bloqueado pelo navegador. Libere popups para este site.');
}

// ==================== PAGAMENTOS — pagamentos Pix do cliente ====================
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

// ===========================================================================
// PAGAMENTOS NO CELULAR — cobrar e mandar
//
// Uma tela, um caminho: digita o valor, gera, copia. O Pix copia e cola e o
// link do checkout ficam a um toque, com botão de compartilhar do próprio
// aparelho quando existe — que é como se manda para o cliente na prática.
// ===========================================================================
let epCel = null;   // { charge } — a última cobrança gerada nesta tela

function epRenderCobrarNoCelular(d) {
  const prods = (d.products || []).filter(p => p.price);
  const semConta = !d.subaccount || d.subaccount.status !== 'active';

  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Cobrar</h1><p>Gere um Pix e mande para o cliente</p></div>

    ${semConta ? `<div class="card">
      <b>${ico('alert', 14)} Conta de recebimento pendente</b>
      <p class="muted" style="margin:6px 0 0;font-size:13px">
        ${d.subaccount ? 'Sua conta de Pagamentos ainda está em análise.' : 'Você ainda não criou a conta de Pagamentos.'}
        Isso é feito no computador, em <b>Pagamentos</b>.
      </p></div>` : ''}

    <div class="card cel-cob">
      <label class="cel-valor">
        <span>Valor</span>
        <div class="cel-valor-in">
          <i>R$</i>
          <input id="cel-val" inputmode="decimal" placeholder="0,00" autocomplete="off"
                 oninput="epCelPreco()" ${semConta ? 'disabled' : ''}>
        </div>
      </label>

      ${prods.length ? `
        <span class="fb-sub">Produtos</span>
        <div class="cel-prods">
          ${prods.slice(0, 8).map(p => `
            <button type="button" class="cel-prod" onclick="epCelProduto('${esc(p.id)}', ${p.price}, this)">
              <b>${esc(p.name)}</b><span>${fmtBRL(p.price)}</span>
            </button>`).join('')}
        </div>` : ''}

      <label style="margin-top:12px">Descrição (opcional)
        <input id="cel-desc" maxlength="140" placeholder="Ex.: Consultoria" ${semConta ? 'disabled' : ''}>
      </label>

      <button class="btn primary block" id="cel-btn" onclick="epCelGerar()" ${semConta ? 'disabled' : ''}
              style="margin-top:14px">${ico('pix', 15)} Gerar cobrança</button>
    </div>

    <div id="cel-result"></div>

  </div>`;
}

function epCelProduto(id, preco, botao) {
  $('#cel-val').value = (preco / 100).toFixed(2).replace('.', ',');
  const p = ((state.epInfo && state.epInfo.products) || []).find(x => x.id === id);
  if (p && $('#cel-desc')) $('#cel-desc').value = p.name || '';
  $$('.cel-prod').forEach(b => b.classList.toggle('on', b === botao));
  epCelPreco();
}

// Deixa o valor sempre com duas casas enquanto digita, para não sair cobrança
// de R$ 9,00 quando a pessoa quis R$ 9,90.
function epCelPreco() {
  const el = $('#cel-val'); if (!el) return;
  const d = (el.value || '').replace(/\D/g, '');
  el.value = d ? (Number(d) / 100).toFixed(2).replace('.', ',') : '';
}

async function epCelGerar() {
  const cents = epParseReais($('#cel-val').value);
  if (!cents || cents < 100) return toast('Valor mínimo: R$ 1,00', 'error');
  const btn = $('#cel-btn'); btn.disabled = true;
  const txt = btn.innerHTML; btn.textContent = 'Gerando…';
  try {
    const r = await api('/pagamentos/charges', {
      body: { valueCents: cents, comment: $('#cel-desc').value, origin: 'mobile' }
    });
    epCel = { charge: r.charge };
    epCelPintarResultado(r.charge);
  } catch (e) { toast(e.message, 'error'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

function epCelPintarResultado(ch) {
  const link = ch.payUrl || ch.paymentLinkUrl || '';
  const box = $('#cel-result');
  box.innerHTML = `
    <div class="card cel-pronto">
      <div class="cel-ok">${ico('check-circle', 18)}<b>${fmtBRL(ch.value)} pronto para enviar</b></div>
      ${ch.qrCodeImage ? `<img class="cel-qr" src="${esc(ch.qrCodeImage)}" alt="QR Code Pix">` : ''}

      ${ch.brCode ? `
        <button class="btn block" onclick="epCelCopiar('pix')">${ico('copy', 14)} Copiar Pix copia e cola</button>` : ''}
      ${link ? `
        <button class="btn block" style="margin-top:8px" onclick="epCelCopiar('link')">${ico('link', 14)} Copiar link do checkout</button>` : ''}
      ${link && navigator.share ? `
        <button class="btn primary block" style="margin-top:8px" onclick="epCelCompartilhar()">${ico('send', 14)} Compartilhar</button>` : ''}

      <button class="btn ghost block" style="margin-top:10px" onclick="epCelNova()">Nova cobrança</button>
    </div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function epCelCopiar(qual) {
  const ch = epCel && epCel.charge; if (!ch) return;
  const v = qual === 'pix' ? ch.brCode : (ch.payUrl || ch.paymentLinkUrl);
  if (!v) return toast('Nada para copiar', 'error');
  copyText(v);
  toast(qual === 'pix' ? 'Pix copiado! Cole na conversa' : 'Link copiado! Cole na conversa');
}

// O compartilhar do próprio aparelho abre a lista de apps, com o WhatsApp em
// primeiro — é o caminho mais curto entre gerar e mandar.
async function epCelCompartilhar() {
  const ch = epCel && epCel.charge; if (!ch) return;
  const link = ch.payUrl || ch.paymentLinkUrl || '';
  try {
    await navigator.share({
      title: 'Cobrança ' + fmtBRL(ch.value),
      text: `Segue o link para pagamento de ${fmtBRL(ch.value)}${ch.comment ? ', ' + ch.comment : ''}:`,
      url: link
    });
  } catch { /* cancelado pelo usuário: não é erro */ }
}

function epCelNova() {
  epCel = null;
  $('#cel-result').innerHTML = '';
  $('#cel-val').value = ''; $('#cel-desc').value = '';
  $$('.cel-prod').forEach(b => b.classList.remove('on'));
  $('#cel-val').focus();
}

async function renderPagamentos() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(6)}</div></div>`;
  let d;
  try { d = await api('/pagamentos'); } catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; return; }
  state.epInfo = d;
  // No CELULAR o módulo inteiro não cabe nem faz sentido: abas de produtos,
  // checkout, relatórios e saque são trabalho de mesa. Do telefone se faz uma
  // coisa — cobrar na frente do cliente e mandar o Pix.
  if (isMobileLayout()) return epRenderCobrarNoCelular(d);
  // A aba Cartão só existe se a plataforma habilitou o adquirente.
  try { epCardTabVisible = (await api('/pagamentos/card-account')).account.available; } catch { epCardTabVisible = false; }
  if (!epCardTabVisible && epState.tab === 'card') epState.tab = 'dash';

  // ---- Sem subconta → fluxo de cadastro (onboarding) ----
  if (!d.subaccount || d.subaccount.status === 'rejected') { epRenderOnboarding(d); return; }
  if (d.subaccount.status === 'pending') {
    const kyc = d.subaccount.kyc;
    if (kyc && kyc.onboardingUrl) {
      epRenderGate(d, 'shield', 'Conclua sua verificação (KYC)',
        'Falta pouco! Finalize a verificação de identidade na página segura da Woovi. Assim que a compliance aprovar, sua conta Pagamentos é liberada automaticamente.',
        `<a class="btn primary no-grow" href="${esc(kyc.onboardingUrl)}" target="_blank" rel="noopener">${ico('shield', 14)} Continuar verificação</a>`);
    } else if (kyc && (kyc.status === 'awaiting_gateway' || kyc.status === 'error')) {
      epRenderGate(d, 'clock', 'Verificação iniciada',
        'Recebemos seu cadastro. A verificação KYC será aberta assim que o gateway estiver disponível, você será avisado quando for aprovado.');
    } else {
      epRenderGate(d, 'clock', 'Cadastro em análise', 'Sua conta Pagamentos foi criada e está aguardando aprovação. Você será liberado automaticamente, não precisa fazer mais nada.');
    }
    return;
  }
  if (d.subaccount.status === 'suspended') { epRenderGate(d, 'slash', 'Conta suspensa', 'Sua conta Pagamentos está suspensa. Fale com o suporte da plataforma para reativar.'); return; }

  // ---- Subconta ativa → módulo completo ----
  $('#view').innerHTML = `<div class="page">
    <div class="page-head row">
      <div style="flex:1"><h1>Pagamentos</h1><p>Receba por Pix direto nas suas conversas, ${esc(d.subaccount.name)}</p></div>
      <button class="btn primary no-grow" onclick="epNewChargeModal()">${ico('plus', 14)} Gerar cobrança</button>
    </div>
    ${!d.configured ? `<div class="card" style="border-color:var(--amber-border);background:var(--amber-bg)"><b>⚠ Gateway não configurado.</b><p class="muted" style="margin:4px 0 0;font-size:13px">O administrador precisa informar o AppID da Woovi em Admin → Pagamentos para gerar cobranças reais.</p></div>` : ''}
    <div class="tabs">
      <button class="${epState.tab === 'dash' ? 'active' : ''}" data-tab="ep-dash" onclick="epTab('dash')">Dashboard</button>
      <button class="${epState.tab === 'charges' ? 'active' : ''}" data-tab="ep-charges" onclick="epTab('charges')">Cobranças</button>
      <button class="${epState.tab === 'products' ? 'active' : ''}" data-tab="ep-products" onclick="epTab('products')">Produtos</button>
      <button class="${epState.tab === 'saque' ? 'active' : ''}" data-tab="ep-saque" onclick="epTab('saque')">Saque</button>
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
    <div class="page-head"><h1>Pagamentos</h1><p>Pagamentos Pix integrados ao seu atendimento</p></div>
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
  // O que a conta já informou no cadastro entra pronto nos campos: nome,
  // e-mail e telefone o Koonfy já tem, e digitar de novo é trabalho à toa.
  const cta = d.conta || {};
  $('#view').innerHTML = `<div class="page">
    <div class="page-head"><h1>Pagamentos</h1><p>Crie sua conta de pagamentos e receba por Pix sem sair do Koonfy</p></div>
    <div class="card" style="max-width:720px">
      <h2>${ico('sparkles')} Ative o Pagamentos</h2>
      <p class="muted" style="margin:0 0 16px;font-size:13px">${kyc
        ? 'Preencha os dados da empresa e do representante legal. Após enviar, você concluirá a <b>verificação de identidade (KYC/KYB)</b> na página segura da Woovi. Assim que a compliance aprovar, sua conta é liberada automaticamente.'
        : 'Preencha os dados abaixo para criar sua conta de recebimentos. O dinheiro das suas vendas cai na <b>sua chave Pix</b>, cobranças, QR Code e links são gerados aqui dentro, direto nas conversas.'}</p>
      <div class="row">
        <label style="flex:2">Nome / Razão social<input id="ep-ob-name" value="${esc(cta.name || '')}" placeholder="Minha Empresa LTDA"></label>
        <label style="flex:1">CPF / CNPJ<input id="ep-ob-doc" value="${esc(cta.document || '')}" placeholder="00.000.000/0000-00" inputmode="numeric"></label>
      </div>
      <div class="row" style="margin-top:9px">
        <label style="flex:1.4">E-mail financeiro<input id="ep-ob-email" type="email" value="${esc(cta.email || '')}" placeholder="financeiro@empresa.com"></label>
        <label style="flex:1">Telefone<input id="ep-ob-phone" value="${esc(cta.phone || '')}" placeholder="(11) 99999-9999" inputmode="tel"></label>
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
        <label style="flex:1.4">Chave Pix (onde você recebe)<input id="ep-ob-pix" value="${esc(cta.pixKey || '')}" placeholder="sua chave Pix"></label>
        <label style="flex:1">Tipo da chave${ecSelect('ep-ob-pixtype', [
          { value: 'cpf', label: 'CPF' }, { value: 'cnpj', label: 'CNPJ' }, { value: 'email', label: 'E-mail' },
          { value: 'telefone', label: 'Telefone' }, { value: 'aleatoria', label: 'Aleatória' }
        ], cta.pixKeyType || 'cpf')}</label>
      </div>
      <p class="hint" style="margin-top:12px">${ico('shield', 12)} ${kyc
        ? 'A verificação de identidade é feita diretamente pela Woovi (instituição de pagamento regulada pelo Banco Central).'
        : 'Seus dados são usados apenas para criar a subconta de recebimento no gateway de pagamentos da plataforma.'}</p>
      <div class="row" style="margin-top:14px;justify-content:flex-end">
        <button class="btn primary no-grow" id="ep-ob-btn" onclick="epSubmitOnboarding()">${ico('zap', 14)} ${kyc ? 'Iniciar verificação' : 'Criar minha conta Pagamentos'}</button>
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
    const r = await api('/pagamentos/subaccount', { body });
    // Modo KYC: abre a verificação hospedada da Woovi em nova aba
    if (r.onboardingUrl) { openExternal(r.onboardingUrl); toast('Conclua a verificação KYC na aba que abriu'); }
    else toast(r.subaccount.status === 'active' ? 'Conta Pagamentos criada e ativada! 🎉' : 'Conta criada, aguardando aprovação');
    renderPagamentos();
  } catch (e) { const el = $('#ep-ob-err'); if (el) el.textContent = e.message; toast(e.message, 'error'); }
  finally { if ($('#ep-ob-btn')) $('#ep-ob-btn').disabled = false; }
}

// ---- Abas ----
async function epPaintTab() {
  const box = $('#ep-box'); if (!box) return;
  if (epState.tab === 'dash') return epPaintDash(box);
  if (epState.tab === 'charges') return epPaintCharges(box);
  if (epState.tab === 'products') return epPaintProducts(box);
  if (epState.tab === 'saque') return epPaintSaque(box);
  if (epState.tab === 'card') return epPaintCard(box);
  return epPaintCfg(box);
}

// ---------------------------------------------------------------------------
// PAGAMENTOS → SAQUE
//
// Uma carteira só, com os dois tempos do dinheiro à vista:
//   · DISPONÍVEL — Pix cai na hora, mais o cartão que já passou do prazo
//   · PENDENTE   — cartão dentro do prazo do adquirente, com a data de cada parcela
// As contestações ficam na mesma tela de propósito: um chargeback tira dinheiro
// da carteira, e quem vê o saldo cair precisa achar o motivo sem procurar.
// ---------------------------------------------------------------------------
let epSaldo = null;

async function epPaintSaque(box) {
  box.innerHTML = `<div class="card">${skel(5)}</div>`;
  try { epSaldo = await api('/pagamentos/saldo'); }
  catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  const d = epSaldo;
  const devendo = d.disponivel < 0;

  box.innerHTML = `
    <div class="sq-cards">
      <div class="sq-card ${devendo ? 'neg' : 'ok'}">
        <span class="sq-lbl">${ico('zap', 13)} Disponível para saque</span>
        <b class="sq-val">${fmtBRL(d.disponivel)}</b>
        <span class="sq-hint">Pix cai na hora${d.doCartao ? `, ${fmtBRL(d.doCartao)} veio de cartão` : ''}</span>
      </div>
      <div class="sq-card">
        <span class="sq-lbl">${ico('clock', 13)} Saldo pendente</span>
        <b class="sq-val">${fmtBRL(d.pendente)}</b>
        <span class="sq-hint">${d.proximaLiberacao
          ? `Próxima liberação: ${fmtBRL(d.proximaLiberacao.valor)} em ${fmtDataHora(d.proximaLiberacao.quando)}`
          : 'Cartão de crédito, dentro do prazo do adquirente'}</span>
      </div>
    </div>

    ${devendo ? `<div class="card" style="border-color:var(--red-border);background:var(--red-bg)">
      <b>${ico('alert', 14)} Saldo negativo</b>
      <p class="muted" style="margin:5px 0 0;font-size:13px">Uma venda foi contestada depois de o valor já ter sido liberado.
      O saldo volta ao positivo com as próximas vendas, e o saque fica bloqueado até lá.</p></div>` : ''}

    <div class="card">
      <h2>${ico('download-circle')} Sacar para a sua chave Pix</h2>
      <p class="muted" style="margin:0;font-size:13px">
        ${d.chavePix ? `Cai na chave cadastrada em Pagamentos: <b>${esc(d.chavePix)}</b>.` : 'Cadastre a sua chave Pix na conta de Pagamentos para sacar.'}
        Mínimo ${fmtBRL(d.limites.min)}${d.limites.max > 0 ? `, máximo ${fmtBRL(d.limites.max)} por saque` : ''}.
      </p>
      <div class="row" style="margin-top:12px;align-items:flex-end">
        <label style="flex:1">Valor<input id="sq-val" inputmode="decimal" placeholder="0,00" oninput="epSaqueQuote()"></label>
        <button class="btn no-grow" onclick="epSaqueTudo()">Sacar tudo</button>
        <button class="btn primary no-grow" id="sq-btn" onclick="epSacar()" ${d.disponivel < d.limites.min ? 'disabled' : ''}>${ico('zap', 14)} Solicitar saque</button>
      </div>
      <p class="muted" id="sq-quote" style="margin:10px 0 0;font-size:12.5px"></p>
    </div>

    ${d.aLiberar.length ? `<div class="card">
      <h2>${ico('calendar')} A liberar</h2>
      <table><thead><tr><th>Quando</th><th>Origem</th><th style="text-align:right">Valor</th></tr></thead><tbody>
      ${d.aLiberar.map(r => `<tr><td>${fmtDataCurta(r.quando)}</td>
        <td>${r.tipo === 'debit' ? 'Débito' : 'Crédito'}${r.de > 1 ? ` · parcela ${r.parcela}/${r.de}` : ''}</td>
        <td style="text-align:right"><b>${fmtBRL(r.valor)}</b></td></tr>`).join('')}
      </tbody></table></div>` : ''}

    <div class="card">
      <h2>${ico('alert')} Contestações</h2>
      ${d.contestadas.length ? `
        <p class="muted" style="margin:0 0 10px;font-size:12.5px">Vendas estornadas ou contestadas pelo comprador. O valor sai da carteira automaticamente.</p>
        <table><thead><tr><th>Quando</th><th>Cliente</th><th>Tipo</th><th style="text-align:right">Valor</th></tr></thead><tbody>
        ${d.contestadas.map(c => `<tr>
          <td>${c.quando ? fmtDataCurta(c.quando) : '-'}</td>
          <td>${esc(c.contato || '-')}${c.descricao ? `<br><span class="muted" style="font-size:11.5px">${esc(c.descricao)}</span>` : ''}</td>
          <td><span class="pill ${c.status === 'chargeback' ? 'err' : ''}">${c.status === 'chargeback' ? 'Chargeback' : 'Estorno'}</span> <span class="muted" style="font-size:11.5px">${esc(c.metodo)}</span></td>
          <td style="text-align:right"><b style="color:var(--red)">-${fmtBRL(c.valor)}</b></td></tr>`).join('')}
        </tbody></table>`
        : '<p class="muted" style="margin:0;font-size:13px">Nenhuma contestação até agora.</p>'}
    </div>

    <div class="card">
      <h2>${ico('activity')} Extrato</h2>
      ${d.extrato.length ? `<table><tbody>
        ${d.extrato.map(t => `<tr><td>${fmtDataCurta(t.ts)}</td><td>${esc(t.label || t.type)}</td>
          <td style="text-align:right"><b style="color:${t.amount < 0 ? 'var(--red)' : 'var(--verde-deep)'}">${t.amount < 0 ? '-' : '+'}${fmtBRL(Math.abs(t.amount))}</b></td></tr>`).join('')}
        </tbody></table>` : '<p class="muted" style="margin:0;font-size:13px">Sem movimentação ainda.</p>'}
    </div>`;
}

function epSaqueTudo() {
  if (!epSaldo) return;
  $('#sq-val').value = (Math.max(0, epSaldo.disponivel) / 100).toFixed(2).replace('.', ',');
  epSaqueQuote();
}

// Mostra a taxa ANTES de confirmar. A taxa depende da origem do dinheiro —
// cartão tem taxa própria — e descobrir isso só depois de sacar seria ruim.
async function epSaqueQuote() {
  const el = $('#sq-quote'); if (!el) return;
  const cents = epParseReais($('#sq-val').value);
  if (!cents) { el.textContent = ''; return; }
  try {
    const q = await api('/wallet/withdraw/quote?amount=' + cents);
    el.innerHTML = q.fee
      ? `Taxa de ${fmtBRL(q.fee)} · você recebe <b>${fmtBRL(q.net)}</b>`
      : `Sem taxa · você recebe <b>${fmtBRL(cents)}</b>`;
  } catch { el.textContent = ''; }
}

async function epSacar() {
  const cents = epParseReais($('#sq-val').value);
  if (!cents) return toast('Informe o valor do saque', 'error');
  if (!epSaldo.chavePix) return toast('Cadastre a sua chave Pix na conta de Pagamentos', 'error');
  if (!await confirmModal({
    title: 'Confirmar saque',
    text: `${fmtBRL(cents)} para a chave ${epSaldo.chavePix}. O valor sai da carteira agora e o pagamento é processado pela plataforma.`,
    ok: 'Solicitar saque'
  })) return;
  const btn = $('#sq-btn'); btn.disabled = true;
  try {
    const r = await api('/wallet/withdraw', { body: { amount: (cents / 100).toFixed(2), pixKey: epSaldo.chavePix } });
    toast(`Saque de ${fmtBRL(cents)} solicitado! Você recebe ${fmtBRL(r.net)}`);
    epPaintSaque($('#ep-box'));
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

// ---------- Pagamentos → Cartão: conta de recebimento do lojista ----------
// Sem recebedor próprio o dinheiro do cartão cairia na conta da plataforma —
// por isso o cadastro (KYC) é obrigatório antes de vender no cartão.
let epCardTabVisible = false;
let epCardAcc = null;

async function epPaintCard(box) {
  box.innerHTML = skel(4);
  try { epCardAcc = (await api('/pagamentos/card-account')).account; }
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
    await api('/pagamentos/card-account', {
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
    const { metrics: m, recent, logs } = await api('/pagamentos/dashboard');
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
      <td>${c.contactName ? `<b>${esc(c.contactName)}</b>` : '<span class="muted">-</span>'}${c.waId ? `<div class="muted" style="font-size:11px">+${esc(c.waId)}</div>` : ''}</td>
      <td class="muted">${esc(c.comment || '-')}</td>
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
    const { charges, total } = await api(`/pagamentos/charges?q=${encodeURIComponent(epState.q)}&status=${encodeURIComponent(epState.status)}`);
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
      <p class="muted" style="margin:16px 0 8px;font-size:12.5px">
        ${ico('help', 12)} Quando o pagamento é confirmado, o contato <b>anda no funil sozinho</b>. Escolha para onde,
        e qual etiqueta ele recebe. Quem já era contato <b>não vira ficha nova</b>: a compra entra na ficha que já existe.
      </p>
      <div class="row" style="align-items:flex-end">
        <label style="max-width:280px">Mover para a etapa${ecSelect('ep-cfg-stage',
          [{ value: '', label: 'Automático (etapa de fechamento)' }].concat(((state.settings && state.settings.stages) || []).map(x => ({ value: x, label: x }))),
          s.paidStage || '')}</label>
        <label style="max-width:220px">Etiqueta na compra
          <input id="ep-cfg-tag" value="${esc(s.paidTag === undefined ? 'Cliente' : s.paidTag)}" maxlength="40" placeholder="deixe vazio para nenhuma"></label>
      </div>
      <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn primary no-grow" onclick="epSaveCfg()">${ico('save', 14)} Salvar</button></div>
    </div>
    <div class="card">
      <h2>${ico('shield')} Sua conta de recebimento</h2>
      <div class="wa-status">
        <div class="wa-row"><span>Titular</span><b>${esc(sub.name || '-')}</b></div>
        <div class="wa-row"><span>Documento</span><b>${esc(sub.document || '-')}</b></div>
        <div class="wa-row"><span>Chave Pix</span><b>${esc(sub.pixKey || '-')} (${esc(sub.pixKeyType || '')})</b></div>
        <div class="wa-row"><span>Status</span><b>${sub.status === 'active' ? 'Ativa ✅' : esc(sub.status || '')}</b></div>
        <div class="wa-row"><span>Criada em</span><b>${sub.createdAt ? new Date(sub.createdAt).toLocaleDateString('pt-BR') : '-'}</b></div>
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
    const r = await api('/pagamentos/settings', { method: 'PUT', body: { [campo]: name } });
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
    '{link}': 'pay.koonfy.app/x7Qk2', '{codigo}': '00020126…5204000053039865802BR6304AB12'
  };
  let txt = el.value || '';
  for (const k in sample) txt = txt.split(k).join(sample[k]);
  prev.innerHTML = txt.trim()
    ? esc(txt).replace(/\*(.+?)\*/g, '<b>$1</b>').replace(/\n/g, '<br>')
    : '<span class="muted">Escreva a mensagem acima para ver a prévia…</span>';
}
async function epSaveCfg() {
  try {
    const body = {
      expiresMin: Number(ecVal('ep-cfg-exp') || 1440),
      notifyPaid: $('#ep-cfg-notify').checked,
      paidStage: ecVal('ep-cfg-stage') || '',
      paidTag: ($('#ep-cfg-tag') && $('#ep-cfg-tag').value) || ''
    };
    if ($('#ep-cfg-msg')) body.autoMessage = $('#ep-cfg-msg').value;   // só se o editor estiver presente
    const r = await api('/pagamentos/settings', { method: 'PUT', body });
    state.epInfo.settings = r.settings;
    toast('Preferências de cobrança salvas');
  } catch (e) { toast(e.message, 'error'); }
}

// ---- CHECKOUT BUILDER: página dedicada (#/pagamentos/checkout) ----
let epkState = null;
let epkPrevStep = 1;   // etapa exibida na prévia: 1 dados · 2 pix
const EPK_COLORS = ['#2ed378', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#111827'];

async function renderCheckoutBuilder() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(6)}</div></div>`;
  if (!state.epInfo) {
    try { state.epInfo = await api('/pagamentos'); }
    catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; return; }
  }
  if (!state.epInfo.subaccount || state.epInfo.subaccount.status !== 'active') { location.hash = '#/pagamentos'; return; }
  // ?c=<id> abre um template específico; sem isso, o padrão
  const wanted = new URLSearchParams((location.hash.split('?')[1] || '')).get('c');
  let ck = state.epInfo.checkout || {};
  if (wanted) {
    try { const r = await api('/pagamentos/checkouts'); ck = r.checkouts.find(c => c.id === wanted) || ck; } catch {}
  }
  epkCheckoutId = ck.id || '';
  epkCheckoutName = ck.name || 'Checkout padrão';
  epkState = {
    banner: ck.banner || '', bannerMobile: ck.bannerMobile || '',
    logo: ck.logo || '', logoMobile: ck.logoMobile || '',
    title: ck.title || '', description: ck.description || '',
    color: ck.color || '#2ed378', successMsg: ck.successMsg || '', supportText: ck.supportText || '',
    // Botão brilhante ou chapado. Nasce brilhante, que é como o checkout já
    // vinha; quem preferir o bloco liso desliga aqui.
    botao: Object.assign({ brilhante: true, angulo: 45, cores: [] }, ck.botao || {}),
    // Claro ou escuro. A página de pagamento precisa parecer a marca de quem
    // vende: o escuro é bonito num infoproduto e péssimo numa loja infantil.
    tema: ck.tema === 'claro' ? 'claro' : 'escuro',
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
      <button class="icon-btn" title="Voltar ao Pagamentos" onclick="location.hash='#/pagamentos'">${ico('arrowleft', 17)}</button>
      <div class="brand ckb-brand">
        <span class="brand-mark"><img src="/marca/logo" alt="Checkout Builder"></span>
        <div><b class="ckb-titulo">Checkout<i> Builder</i></b>
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
            <div class="epk-bbar"><i></i><i></i><i></i><span>koonfy.app/pay/x7Qk2</span></div>
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
      ${epkTab === 'cfg' ? `<a class="card link-card" style="margin-top:14px" href="#/pagamentos">
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
    body = `
      <p class="muted" style="font-size:13px;margin:0 0 14px">Escolha o que este checkout aceita. O cliente vê só os métodos ligados.</p>
      ${linha('pix', 'Pix', 'Aprovação na hora, menor taxa', true, '')}
      ${/* Sem adquirente configurado pela plataforma, cartão e boleto não
            existem para este cliente: mostrar a linha travada só anunciava um
            recurso que ele não pode contratar. Some por inteiro. */''}
      ${cap.ready ? `
      ${linha('credit', 'Cartão de crédito', 'Parcelável, aprovação imediata', cap.credit, 'Crédito não liberado pela plataforma')}
      ${linha('boleto', 'Boleto bancário', 'Compensa em até 2 dias úteis', cap.boleto, 'Boleto não liberado pela plataforma')}` : ''}
      <p class="hint" style="margin-top:14px">${ico('shield', 12)} O dinheiro do cartão cai direto na <b>sua</b> conta, o Koonfy só intermedeia.</p>`;
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
      <p class="hint" style="margin-top:14px">${ico('shield', 12)} O contraste do texto do botão é ajustado sozinho conforme a cor escolhida.</p>

      <span class="fb-sub" style="margin-top:22px;display:block">Modo da página</span>
      <p class="muted" style="font-size:13px;margin:0 0 10px">O fundo do checkout inteiro. A cor de destaque acima vale nos dois.</p>
      <div class="epk-btnkind">
        <button class="epk-bk${ck.tema === 'claro' ? '' : ' on'}" onclick="epkSetTema('escuro')">
          <span class="epk-bk-demo" style="background:#131816;border:1px solid #2b3330"></span> Escuro</button>
        <button class="epk-bk${ck.tema === 'claro' ? ' on' : ''}" onclick="epkSetTema('claro')">
          <span class="epk-bk-demo" style="background:#ffffff;border:1px solid #d8ded9"></span> Claro</button>
      </div>

      <span class="fb-sub" style="margin-top:22px;display:block">Botão de pagar</span>
      <p class="muted" style="font-size:13px;margin:0 0 10px">No brilhante, uma faixa de luz atravessa o botão em diagonal. No chapado, ele é a cor de destaque, sem movimento.</p>
      <div class="epk-btnkind">
        <button class="epk-bk${ck.botao.brilhante ? ' on' : ''}" onclick="epkSetBotao(true)">
          <span class="epk-bk-demo brilha" style="--c:${esc(ck.color)}"></span> Brilhante</button>
        <button class="epk-bk${ck.botao.brilhante ? '' : ' on'}" onclick="epkSetBotao(false)">
          <span class="epk-bk-demo" style="background:${esc(ck.color)}"></span> Chapado</button>
      </div>`;
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
        <div><i>2</i><span><b>Automático</b>, vira <b>cliente</b>, <b>contato</b> no Koonfy e entra no <b>funil</b></span></div>
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

// A escolha do botão. Repinta o painel para o exemplo ao lado de cada opção
// sair na cor certa, e atualiza a prévia da página.
function epkSetTema(t) {
  epkState.tema = t === 'claro' ? 'claro' : 'escuro';
  epkPaintSide(); epkPrev();
}

function epkSetBotao(brilhante) {
  epkState.botao = Object.assign({ angulo: 45, cores: [] }, epkState.botao, { brilhante: !!brilhante });
  epkPaintSide(); epkPrev();
}

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
    const r = await api('/pagamentos/checkout', { method: 'PUT', body: { ...epkState, id: epkCheckoutId, name: epkCheckoutName } });
    state.epInfo.checkout = r.checkout;
    const s = $('#epk-saved');
    if (s) { s.innerHTML = '<i></i> ✓ Salvo agora'; setTimeout(() => { if ($('#epk-saved')) $('#epk-saved').innerHTML = '<i></i> Tudo certo!'; }, 2600); }
    toast('Checkout salvo! Seus links de cobrança já usam o novo visual 🎨');
  } catch (e) { toast(e.message, 'error'); }
  finally { if ($('#epk-save')) $('#epk-save').disabled = false; }
}

// ---- PRODUTOS (Pagamentos → Produtos): preenchem as variáveis do checkout ----
async function epPaintProducts(box) {
  box.innerHTML = skel(4);
  let d;
  try { d = await api('/pagamentos/products'); } catch (e) { box.innerHTML = `<div class="card err">${esc(e.message)}</div>`; return; }
  state.epProducts = d.products; state.epCheckouts = d.checkouts;
  box.innerHTML = `
    <div class="card">
      <div class="row" style="align-items:center;margin-bottom:4px">
        <h2 style="flex:1;margin:0">${ico('sparkles')} Produtos</h2>
        <button class="btn primary no-grow" onclick="epProdForm(null)">${ico('plus', 14)} Novo produto</button>
      </div>
      <p class="muted" style="margin:0 0 14px;font-size:13px">O produto preenche as <b>variáveis</b> do checkout: nome, descrição e imagens. Na cobrança você escolhe o produto e o layout.</p>
      <div id="ep-prod-form"></div>
      ${d.products.length ? `<div style="overflow-x:auto"><table class="tab-mob"><thead><tr><th>Produto</th><th>Preço</th><th>Checkout</th><th>Link de venda</th><th></th></tr></thead><tbody>
        ${d.products.map(p => `<tr>
          <td><div class="cell-user">${p.logo ? `<img class="avatar sm" src="${esc(p.logo)}" style="object-fit:cover">` : `<div class="avatar sm">${esc((p.name || '?').charAt(0).toUpperCase())}</div>`}
            <div><b>${esc(p.name)}</b>${p.description ? `<div class="muted" style="font-size:11.5px">${esc(p.description.slice(0, 46))}</div>` : ''}</div></div></td>
          <td data-r="Preço"><b>${p.price ? fmtBRL(p.price) : '<span class="muted">livre</span>'}</b></td>
          <td data-r="Checkout" class="muted">${esc((d.checkouts.find(c => c.id === p.checkoutId) || {}).name || 'padrão')}</td>
          <td data-r="Link de venda">${p.link
            ? `<button class="btn small" onclick="epProdCopiarLink('${p.id}')" title="${esc(p.link)}">${ico('copy', 12)} Copiar</button>
               <a class="btn small" href="${esc(p.link)}" target="_blank" rel="noopener" title="Abrir o checkout">${ico('link', 12)}</a>`
            : `<span class="muted" style="font-size:12px">${p.price ? 'link desligado' : 'defina um preço'}</span>`}</td>
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
    ${id ? `<span class="fb-sub" style="margin-top:14px">Link de venda</span>
      <p class="muted" style="margin:0 0 8px;font-size:12.5px">O endereço fixo deste produto: qualquer pessoa abre, preenche os dados e paga.
        A cobrança nasce quando ela se identifica — abrir o link não cria venda nenhuma.</p>
      ${p.price ? `
        <div class="copy-box"><code id="epp-link">${esc(p.link || '—')}</code>
          <button class="btn small" onclick="copyText($('#epp-link').textContent)">Copiar</button>
          ${p.link ? `<a class="btn small" href="${esc(p.link)}" target="_blank" rel="noopener">Abrir</a>` : ''}</div>
        <label class="chk" style="margin-top:10px"><input type="checkbox" id="epp-linkon" ${p.linkOn === false ? '' : 'checked'}>
          <span>Link ativo</span></label>
        <p class="hint">O endereço é gerado a partir do nome do produto e não muda depois: se ele já está num anúncio, continua valendo.</p>
      ` : '<p class="hint">Defina um preço para este produto ganhar um link de venda.</p>'}` : ''}

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
// Copiar da LISTA: o produto já está pronto e a pessoa só quer o endereço
// para colar no anúncio. Abrir o formulário para isso seria cobrar dois
// cliques por um.
function epProdCopiarLink(id) {
  const p = (state.epProducts || []).find(x => x.id === id);
  if (!p || !p.link) return toast('Este produto ainda não tem link', 'error');
  copyText(p.link);
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
    // O apelido do link não vem daqui: quem gera é o servidor. O endereço é
    // global para toda a plataforma, e um campo aberto vira corrida pelas
    // palavras boas — e pelas perigosas.
    const linkon = $('#epp-linkon');
    if (linkon) body.linkOn = linkon.checked;
    await api('/pagamentos/products' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', body });
    toast(id ? 'Produto atualizado!' : 'Produto criado!');
    epPaintProducts($('#ep-box'));
  } catch (e) { toast(e.message, 'error'); }
}
async function epProdDel(id) {
  if (!await confirmModal('Excluir este produto?', 'As cobranças já criadas continuam válidas.')) return;
  try { await api('/pagamentos/products/' + id, { method: 'DELETE' }); toast('Produto excluído'); epPaintProducts($('#ep-box')); }
  catch (e) { toast(e.message, 'error'); }
}

// ---- Checkout Builder: lista de templates (Vendas → Checkout Builder) ----
async function renderCheckoutList() {
  $('#view').innerHTML = `<div class="page"><div class="card">${skel(4)}</div></div>`;
  let d;
  try { d = await api('/pagamentos'); } catch (e) { $('#view').innerHTML = `<div class="page"><div class="card err">${esc(e.message)}</div></div>`; return; }
  state.epInfo = d;
  if (!d.subaccount || d.subaccount.status !== 'active') { location.hash = '#/pagamentos'; return; }
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
          <td class="muted">-</td>
          <td><span style="display:inline-block;width:16px;height:16px;border-radius:5px;background:${esc(c.color || '#2ed378')};vertical-align:middle"></span></td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn small" onclick="ckEdit('${c.id}')">${ico('edit', 13)} Editar</button>
            ${cks.length > 1 ? `<button class="btn small danger" onclick="ckDel('${c.id}')">${ico('trash', 13)}</button>` : ''}
          </td></tr>`).join('')}
      </tbody></table></div>
      <p class="hint" style="margin-top:12px">${ico('shield', 12)} Na hora de gerar a cobrança no Pagamentos você escolhe o <b>produto</b> e qual destes <b>checkouts</b> usar.</p>
    </div>
    <a class="card link-card" href="#/pagamentos">
      <span class="lc-ic">${ico('sparkles', 20)}</span>
      <div style="flex:1"><h2 style="margin:0 0 3px">Produtos</h2>
        <p class="muted" style="margin:0;font-size:13px">Cadastre nome, preço e imagens em <b>Pagamentos → Produtos</b>, eles preenchem as variáveis do checkout.</p></div>
      <span class="lc-arrow">${ico('arrowright', 18)}</span></a>
  </div>`;
}
function ckEdit(id) { window.open('/app/#/pagamentos/checkout?c=' + encodeURIComponent(id), '_blank', 'noopener'); }
async function ckNew() {
  const name = prompt('Nome do novo checkout:', 'Checkout promocional');
  if (!name) return;
  try { const r = await api('/pagamentos/checkouts', { body: { name } }); toast('Checkout criado!'); ckEdit(r.checkout.id); renderCheckoutList(); }
  catch (e) { toast(e.message, 'error'); }
}
async function ckDel(id) {
  if (!await confirmModal('Excluir este checkout?', 'As cobranças que já usam ele passam a exibir o checkout padrão.')) return;
  try { await api('/pagamentos/checkouts/' + id, { method: 'DELETE' }); toast('Checkout excluído'); renderCheckoutList(); }
  catch (e) { toast(e.message, 'error'); }
}

// ---- Nova cobrança (também usada pelo botão do chat) ----
// ---------------------------------------------------------------------------
// COBRANÇA EM DUAS ETAPAS
//
// Era um formulário só, num modal estreito: valor, descrição, produto, checkout
// e destinatário empilhados, e a mensagem que o cliente recebe nem aparecia —
// vinha de um modelo escondido em Pagamentos. Agora a etapa 1 é o dinheiro
// (produto, valor, para quem) e a etapa 2 é o texto, escrito na hora, com as
// variáveis à mão e prévia do balão como o cliente vai ver.
// ---------------------------------------------------------------------------

// Só entram aqui as variáveis que o servidor realmente substitui em
// `chargeMessage`. Oferecer uma que ele ignora seria mandar o cliente receber
// "{vencimento}" escrito na mensagem.
const EP_VARS = [
  { k: 'nome', rot: 'Nome do cliente' },
  { k: 'valor', rot: 'Valor' },
  { k: 'descricao', rot: 'Descrição' },
  { k: 'link', rot: 'Link de pagamento' },
  { k: 'codigo', rot: 'Pix copia e cola' }
];
const EP_MSG_PADRAO = 'Olá {nome}! Sua cobrança de {valor} está pronta.\n{descricao}\n\nPague pelo link: {link}\n\nOu use o Pix copia e cola:\n{codigo}';

let epNC = null;   // { waId, contactName, etapa }

// O RÓTULO DO BOTÃO de pagar, que sai no WhatsApp junto da cobrança. A regra
// da Meta fica escrita ao lado do campo: 20 caracteres, sem quebra de linha.
// Ler a regra antes é melhor do que descobrir por um erro de envio.
function epCampoBotao() {
  const padrao = (state.epInfo && state.epInfo.buttonText) || 'Pagar agora';
  return `
    <div class="ep-botao-campo">
      <label>Texto do botão de pagar
        <input id="ep-nc-btntxt" maxlength="20" placeholder="${esc(padrao)}" value=""
               oninput="epContarBotao(this)"></label>
      <div class="ep-botao-regra" id="ep-nc-btntxt-regra">
        ${ico('help', 12)} Até <b>20 caracteres</b>, numa linha só. Emoji conta como caractere.
        Em branco, sai <b>${esc(padrao)}</b>.
      </div>
    </div>`;
}

// A contagem aparece enquanto se digita: o limite deixa de ser surpresa.
function epContarBotao(el) {
  const box = $('#ep-nc-btntxt-regra'); if (!box) return;
  const n = el.value.length;
  box.classList.toggle('perto', n >= 16);
  const sobra = 20 - n;
  const aviso = n
    ? `${ico('help', 12)} <b>${sobra}</b> caractere${sobra === 1 ? '' : 's'} restante${sobra === 1 ? '' : 's'}.`
    : '';
  if (n) box.innerHTML = aviso;
  else epRepintarRegra(box);
}
function epRepintarRegra(box) {
  const padrao = (state.epInfo && state.epInfo.buttonText) || 'Pagar agora';
  box.innerHTML = `${ico('help', 12)} Até <b>20 caracteres</b>, numa linha só. Emoji conta como caractere.`
    + ` Em branco, sai <b>${esc(padrao)}</b>.`;
}

function epNewChargeModal(waId, contactName) {
  epNC = { waId: waId || null, contactName: contactName || null, etapa: 1 };
  const prods = (state.epInfo && state.epInfo.products) || [];
  const cks = (state.epInfo && state.epInfo.checkouts) || [];
  const padrao = (state.epInfo && state.epInfo.settings && state.epInfo.settings.autoMessage) || EP_MSG_PADRAO;

  openModal(`<h2>${ico('pix')} Gerar cobrança Pix</h2>
    <div class="ep-trilha" id="ep-nc-trilha">
      <span data-passo="1" class="on"><i>1</i>Cobrança e produto</span>
      <span data-passo="2"><i>2</i>Mensagem</span>
    </div>

    <div class="ep-etapa" data-etapa="1">
      <div class="ep-grid">
        ${prods.length ? `<label>Produto
          ${ecSelect('ep-nc-prod', [{ value: '', label: 'Cobrança avulsa (sem produto)' }].concat(prods.map(p => ({ value: p.id, label: p.name + (p.price ? ', ' + fmtBRL(p.price) : '') }))), '', 'epPickProduct(val)')}</label>`
          : `<p class="hint" style="grid-column:1/-1;margin:0">${ico('help', 12)} Cadastre produtos em <b>Pagamentos → Produtos</b> para preencher valor, descrição e imagens automaticamente.</p>`}
        ${cks.length ? `<label>Checkout
          ${ecSelect('ep-nc-ckt', cks.map(c => ({ value: c.id, label: c.name + (c.isDefault ? ' (padrão)' : '') })), (cks.find(c => c.isDefault) || cks[0]).id)}</label>` : ''}
        <label>Valor (R$)<input id="ep-nc-val" placeholder="97,00" inputmode="decimal" autofocus oninput="epPreviewMsg()"></label>
        <label>Descrição (opcional)<input id="ep-nc-desc" maxlength="140" placeholder="Ex.: Consultoria, plano mensal" oninput="epPreviewMsg()"></label>
      </div>
      ${waId
        ? `<div class="ep-para">${ico('user', 14)} Para <b>${esc(contactName || '+' + waId)}</b></div>
           <label class="chk"><input type="checkbox" id="ep-nc-send" checked> Enviar a cobrança na conversa agora</label>
           <input type="hidden" id="ep-nc-waid" value="${esc(waId)}">`
        : `<label>Vincular a um contato (opcional)<input id="ep-nc-phone" placeholder="5511999999999, deixe em branco para cobrança avulsa" inputmode="tel"></label>
           <label class="chk"><input type="checkbox" id="ep-nc-send"> Enviar no WhatsApp do contato</label>`}
    </div>

    <div class="ep-etapa hidden" data-etapa="2">
      <div class="ep-msg-cols">
        <div>
          <span class="fb-sub">Mensagem que o cliente recebe</span>
          <textarea id="ep-nc-msg" class="ep-msg" rows="9" oninput="epPreviewMsg()">${esc(padrao)}</textarea>
          <span class="fb-sub" style="margin-top:12px">Toque para inserir onde está o cursor</span>
          <div class="ep-vars">${EP_VARS.map(v => `<button type="button" class="ep-var" onclick="epInsertVar('${v.k}')" title="${esc(v.rot)}">{${v.k}}</button>`).join('')}</div>
          ${epCampoBotao()}
          <label class="chk" style="margin-top:12px"><input type="checkbox" id="ep-nc-def"> Usar este texto e este botão como padrão nas próximas cobranças</label>
        </div>
        <div class="ep-preview-wrap">
          <span class="fb-sub">Prévia</span>
          <div class="ep-preview"><div class="msg out tail" id="ep-nc-prev"></div></div>
        </div>
      </div>
    </div>

    <div class="row ep-acoes">
      <button class="btn" id="ep-nc-voltar" onclick="epStep(1)" style="display:none">${ico('arrowleft', 13)} Voltar</button>
      <span style="flex:1"></span>
      <button class="btn" onclick="closeModal()">Cancelar</button>
      <button class="btn primary no-grow" id="ep-nc-next" onclick="epStep(2)">Continuar ${ico('arrowright', 13)}</button>
      <button class="btn primary no-grow" id="ep-nc-btn" onclick="epCreateCharge()" style="display:none">${ico('zap', 14)} Gerar e enviar</button>
    </div>`, 'cob');
  epPreviewMsg();
}

function epStep(n) {
  if (!epNC) return;
  // Valor é o único campo sem o qual a etapa 2 não faz sentido: a mensagem
  // mostraria "R$ 0,00" e a cobrança seria recusada no fim de qualquer jeito.
  if (n === 2 && epParseReais($('#ep-nc-val').value) < 100) {
    toast('Informe o valor da cobrança (mínimo R$ 1,00)', 'error');
    $('#ep-nc-val').focus();
    return;
  }
  epNC.etapa = n;
  $$('.ep-etapa').forEach(el => el.classList.toggle('hidden', Number(el.dataset.etapa) !== n));
  $$('#ep-nc-trilha span').forEach(el => el.classList.toggle('on', Number(el.dataset.passo) <= n));
  $('#ep-nc-voltar').style.display = n === 2 ? '' : 'none';
  $('#ep-nc-next').style.display = n === 2 ? 'none' : '';
  $('#ep-nc-btn').style.display = n === 2 ? '' : 'none';
  if (n === 2) { epPreviewMsg(); $('#ep-nc-msg').focus(); }
}

// Insere a variável exatamente onde o cursor está, sem apagar o que já foi
// escrito — colar no fim obrigaria a pessoa a recortar e mover na mão.
function epInsertVar(k) {
  const ta = $('#ep-nc-msg'); if (!ta) return;
  const tag = '{' + k + '}';
  const ini = ta.selectionStart, fim = ta.selectionEnd;
  ta.value = ta.value.slice(0, ini) + tag + ta.value.slice(fim);
  ta.selectionStart = ta.selectionEnd = ini + tag.length;
  ta.focus();
  epPreviewMsg();
}

// A prévia usa os MESMOS nomes de variável do servidor, com valores de exemplo
// no lugar do link e do código, que só existem depois da cobrança criada.
function epPreviewMsg() {
  const alvo = $('#ep-nc-prev'); if (!alvo || !epNC) return;
  const cents = epParseReais(($('#ep-nc-val') || {}).value || '');
  const txt = (($('#ep-nc-msg') || {}).value || EP_MSG_PADRAO)
    .replace(/\{nome\}/g, epNC.contactName || 'cliente')
    .replace(/\{valor\}/g, fmtBRL(cents || 0))
    .replace(/\{descricao\}/g, (($('#ep-nc-desc') || {}).value || '').trim())
    .replace(/\{link\}/g, 'https://pay.koonfy.com/epc_exemplo')
    .replace(/\{codigo\}/g, '00020126580014BR.GOV.BCB.PIX…')
    .replace(/\n{3,}/g, '\n\n').trim();
  // A prévia mostra o BOTÃO junto: é o que o cliente recebe, e ver o rótulo
  // dentro do balão é o que revela quando ele ficou grande demais.
  const rot = (($('#ep-nc-btntxt') || {}).value || '').trim()
    || (state.epInfo && state.epInfo.buttonText) || 'Pagar agora';
  alvo.innerHTML = esc(txt)
    + `<div class="meta"><time>${fmtHora(Date.now())}</time><span class="st">✓</span></div>`
    + `<div class="msg-btns"><span class="msg-btn">${esc(rot.slice(0, 20))}</span></div>`;
  alvo.classList.add('com-btns');
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
    const r = await api('/pagamentos/charges', { body: {
      valueCents: epParseReais($('#ep-nc-val').value),
      comment: $('#ep-nc-desc').value,
      productId: ecVal('ep-nc-prod') || '', checkoutId: ecVal('ep-nc-ckt') || '',
      message: ($('#ep-nc-msg') && $('#ep-nc-msg').value.trim()) || '',
      saveAsDefault: !!($('#ep-nc-def') && $('#ep-nc-def').checked),
      waId, send: !!($('#ep-nc-send') && $('#ep-nc-send').checked),
      origin: state.view === 'inbox' ? 'chat' : 'manual',
      // O rótulo do botão. Em branco, o servidor usa o padrão da conta.
      buttonText: ($('#ep-nc-btntxt') && $('#ep-nc-btntxt').value.trim()) || ''
    } });
    closeModal();
    if (r.sent) toast('Cobrança gerada e enviada na conversa! 💸');
    else if (r.sendError) toast('Cobrança gerada, mas NÃO enviada: ' + r.sendError, 'error');
    else toast('Cobrança gerada!');
    epShowCharge(r.charge, r.sendError);
    if (state.view === 'pagamentos') epPaintTab();
  } catch (e) { toast(e.message, 'error'); }
  finally { if ($('#ep-nc-btn')) $('#ep-nc-btn').disabled = false; }
}

// ---- Detalhe da cobrança: QR Code, copia e cola, link e ações ----
async function epChargeDetail(id) {
  try {
    const { charges } = await api('/pagamentos/charges?q=' + encodeURIComponent(id));
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
            <button class="btn small" onclick="epCopy(this.previousElementSibling.value)">${ico('copy', 13)}</button></div>`
        /* Sem aviso quando o código ainda não existe: o checkout recolhe os
           dados obrigatórios e mostra o Pix na própria página. */
        : ''}
        ${ch.payer ? `
          <span class="fb-sub" style="margin-top:10px">Dados do pagador (checkout)</span>
          <div class="wa-status" style="margin-top:4px">
            <div class="wa-row"><span>Nome</span><b>${esc(ch.payer.name)}</b></div>
            <div class="wa-row"><span>CPF/CNPJ</span><b>${esc(epFmtDoc(ch.payer.taxID))}</b></div>
            <div class="wa-row"><span>E-mail</span><b>${esc(ch.payer.email)}</b></div>
            <div class="wa-row"><span>WhatsApp</span><b>+${esc(ch.payer.phone)}</b></div>
            ${ch.payerSynced ? '<div class="wa-row"><span>Cadastro</span><b>Cliente sincronizado ✅</b></div>' : ''}
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
  try { await api(`/pagamentos/charges/${id}/cancel`, { method: 'POST', body: {} }); toast('Cobrança cancelada'); if (state.view === 'pagamentos') epPaintTab(); } catch (e) { toast(e.message, 'error'); }
}
async function epResend(id) {
  try { await api(`/pagamentos/charges/${id}/resend`, { method: 'POST', body: {} }); toast('Cobrança reenviada na conversa 📨'); } catch (e) { toast(e.message, 'error'); }
}
async function epDuplicate(id) {
  try { const r = await api(`/pagamentos/charges/${id}/duplicate`, { method: 'POST', body: {} }); toast('Cobrança duplicada'); epShowCharge(r.charge); if (state.view === 'pagamentos') epPaintTab(); } catch (e) { toast(e.message, 'error'); }
}

// Botão "Cobrança" dentro da conversa (composer do inbox)
async function chatChargeModal(waId) {
  const c = state.conversations.find(x => x.waId === waId);
  // `epInfo` só era buscado ao entrar em Pagamentos. Abrindo a cobrança pelo
  // chat, produtos, checkouts e a mensagem padrão da conta vinham vazios —
  // justamente onde a cobrança é mais usada.
  if (!state.epInfo) {
    try { state.epInfo = await api('/pagamentos'); }
    catch (e) { return toast(e.message, 'error'); }
  }
  // Sem conta de recebimento ativa, a cobrança seria montada inteira só para
  // morrer num aviso de "crie sua conta primeiro" no fim. Em vez desse beco,
  // vai direto para a tela que resolve — já preenchida com o que o Koonfy
  // sabe. Nada de pop-up no meio do caminho.
  const sub = state.epInfo.subaccount;
  if (!sub || sub.status !== 'active') {
    location.hash = '#/pagamentos';
    return;
  }
  epNewChargeModal(waId, c ? c.name : null);
}

// ==================== TRACKING — atribuição + ROAS (estilo UTMify) ====================
let trkState = { tab: 'overview', data: null };
const trkBRL = v => fmtBRL(v || 0);

// ---------------------------------------------------------------------------
// GRÁFICOS DO TRACKING
//
// Mesmo desenho dos gráficos do Dashboard: SVG inline, sem biblioteca. Três
// séries que existem por dia de verdade — receita, pedidos e cliques. O gasto
// com anúncio não entra: a Meta devolve o total do período, e não o dia a dia.
// ---------------------------------------------------------------------------
function trkGraficos(serie) {
  if (!serie || !serie.length) return '';
  const temAlgo = serie.some(d => d.receita || d.criados || d.aprovados || d.cliques);
  if (!temAlgo) {
    return `<div class="card"><h2>${ico('activity')} Evolução</h2>
      <p class="muted" style="margin:0;font-size:13px">Sem movimento nos últimos 30 dias. Assim que entrarem cliques e cobranças, os gráficos aparecem aqui.</p></div>`;
  }
  const W = 560, H = 200, padB = 22, padT = 10;
  const dia = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
  const eixo = `<text x="2" y="${H - 6}" style="font:600 10px 'Inter Tight'" fill="var(--faint)">${dia(serie[0].date)}</text>
    <text x="${W - 2}" y="${H - 6}" text-anchor="end" style="font:600 10px 'Inter Tight'" fill="var(--faint)">${dia(serie[serie.length - 1].date)}</text>`;
  const grade = [0.25, 0.5, 0.75].map(f => `<line x1="0" y1="${((H - padB) * f).toFixed(1)}" x2="${W}" y2="${((H - padB) * f).toFixed(1)}" stroke="#e8f3ec" stroke-dasharray="3 4"/>`).join('');

  // área: uma série contínua (receita)
  const area = (vals, cor, id, rotulo, fmt) => {
    const max = Math.max(1, ...vals);
    const px = (v, i) => `${(i / Math.max(1, vals.length - 1) * W).toFixed(1)},${(H - padB - v / max * (H - padB - padT)).toFixed(1)}`;
    const linha = vals.map(px).join(' ');
    const pontos = vals.map((v, i) => {
      const [x, y] = px(v, i).split(',');
      return `<circle cx="${x}" cy="${y}" r="7" fill="transparent"><title>${dia(serie[i].date)}, ${fmt(v)}</title></circle>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="${rotulo}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${cor}" stop-opacity=".32"/><stop offset="1" stop-color="${cor}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grade}
      <polygon points="0,${H - padB} ${linha} ${W},${H - padB}" fill="url(#${id})"/>
      <polyline points="${linha}" fill="none" stroke="${cor}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      ${pontos}${eixo}</svg>`;
  };

  // barras lado a lado: criados x aprovados
  const barras = () => {
    const max = Math.max(1, ...serie.map(d => Math.max(d.criados, d.aprovados)));
    const slot = W / serie.length, bw = Math.max(3, Math.min(14, slot * 0.34));
    const b = serie.map((d, i) => {
      const xm = i * slot + slot / 2;
      const hc = d.criados / max * (H - padB - padT), ha = d.aprovados / max * (H - padB - padT);
      return `<rect x="${(xm - bw - 0.5).toFixed(1)}" y="${(H - padB - hc).toFixed(1)}" width="${bw}" height="${Math.max(2, hc).toFixed(1)}" rx="${Math.min(4, bw / 2)}" fill="#94a3b8" opacity=".55"><title>${dia(d.date)}, ${d.criados} criada(s)</title></rect>
        <rect x="${(xm + 0.5).toFixed(1)}" y="${(H - padB - ha).toFixed(1)}" width="${bw}" height="${Math.max(2, ha).toFixed(1)}" rx="${Math.min(4, bw / 2)}" fill="#2ED378"><title>${dia(d.date)}, ${d.aprovados} aprovada(s)</title></rect>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img" aria-label="Cobranças por dia">
      ${grade}${b}${eixo}</svg>`;
  };

  const legenda = (itens) => `<div class="trk-leg">${itens.map(([cor, txt]) =>
    `<span><i style="background:${cor}"></i>${txt}</span>`).join('')}</div>`;

  return `<div class="card">
    <h2>${ico('activity')} Evolução, últimos 30 dias</h2>
    <div class="trk-graficos">
      <div>
        <h3>Receita por dia</h3>
        ${area(serie.map(d => d.receita), '#2ED378', 'trkRev', 'Receita por dia', v => fmtBRL(v))}
        ${legenda([['#2ED378', 'Receita aprovada']])}
      </div>
      <div>
        <h3>Cobranças por dia</h3>
        ${barras()}
        ${legenda([['#94a3b8', 'Criadas'], ['#2ED378', 'Aprovadas']])}
      </div>
      <div>
        <h3>Cliques por dia</h3>
        ${area(serie.map(d => d.cliques), '#53BDEB', 'trkClk', 'Cliques por dia', v => v + ' clique(s)')}
        ${legenda([['#53BDEB', 'Cliques em links rastreáveis']])}
      </div>
    </div>
  </div>`;
}
const trkPct = v => v === null || v === undefined ? '-' : v + '%';
const trkX = v => v === null || v === undefined ? '-' : v + 'x';

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
      <button data-tab="trk-pixels" onclick="location.hash='#/pixels'">Pixels</button>
    </div>
    <div id="trk-box">${skel(5)}</div>
  </div>`;
  trkPaintTab();
}
function trkTab(t) { trkState.tab = t; $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === 'trk-' + t)); trkPaintTab(); }

async function trkPaintTab() {
  const box = $('#trk-box'); if (!box) return;
  // O `await` nao e enfeite: sem ele o `return` devolve a promessa e o catch
  // abaixo nunca ve a falha — quem espera passa a ser o chamador. O efeito era
  // uma aba do Tracking em branco, sem a mensagem de erro que este catch
  // existe para mostrar, e um "unhandled rejection" no console.
  try {
    if (trkState.tab === 'overview') return await trkPaintOverview(box);
    if (trkState.tab === 'conn') return await trkPaintConn(box);
    if (trkState.tab === 'camp') return await trkPaintCamp(box);
    if (trkState.tab === 'funnel') return await trkPaintFunnel(box);
    if (trkState.tab === 'events') return await trkPaintEvents(box);
    return await trkPaintAlerts(box);
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
      <div class="mh-card"><span class="mh-ic">${ico('activity', 20)}</span><div class="mh-val">${d.roas === null ? '-' : d.roas + 'x'}</div><div class="mh-lbl">ROAS</div></div>
      <div class="mh-card"><span class="mh-ic">${ico('trend', 20) || ico('activity', 20)}</span><div class="mh-val">${trkBRL(d.lucro)}</div><div class="mh-lbl">Lucro (receita − anúncios)</div></div>
      <div class="mh-card"><span class="mh-ic">${ico('check', 20)}</span><div class="mh-val">${fmtN(d.pedidos.aprovados)}</div><div class="mh-lbl">Pedidos aprovados</div></div>
    </div>
    ${trkGraficos(d.serie)}
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
        ${card('CPA', d.cpa === null ? '-' : trkBRL(d.cpa))}${card('CAC', d.cac === null ? '-' : trkBRL(d.cac))}
        ${card('LTV', trkBRL(d.ltv))}${card('Margem', trkPct(d.margem))}${card('Conversão', trkPct(d.conversao))}
        ${card('EPC', d.epc === null ? '-' : trkBRL(d.epc))}${card('RPC', d.rpc === null ? '-' : trkBRL(d.rpc))}
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
        <div class="ep-bar-w" title="${lbl} · ${trkBRL(p.receita)} · ROAS ${p.roas ?? '-'}">
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
              ? 'O Koonfy envia pelo servidor. Não morre em bloqueador de anúncio.'
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
            <span>Sync: ${c.lastSync ? timeAgo(c.lastSync) : '-'}</span>
            <span>↑ ${fmtN(c.sent || 0)} enviados</span>
            <span class="${c.errors ? 'err2' : ''}">${c.errors || 0} erro(s)</span>`
          : '<span>Dispara no link rastreável e no checkout</span>'}
        </div>
        ${c.key === 'ga4' && c.sent ? '<p class="muted" style="font-size:11.5px;margin:6px 0 0">O Google não devolve confirmação de recebimento. Confira em GA4, Tempo real.</p>' : ''}
        ${c.lastError ? `<p class="muted" style="font-size:11.5px;margin:6px 0 0;color:#f87171">${esc(c.lastError)}</p>` : ''}
      </div>`).join('')}</div>
    <div class="card"><h2>${ico('shield')} Envio automático de conversões</h2>
      <p class="muted" style="font-size:13px;margin:0">Toda venda confirmada no Pagamentos é enviada sozinha para <b>Meta Conversions API</b>, <b>GA4 / Google Ads</b> e <b>TikTok Events API</b> (as que estiverem ativas acima), com e-mail/telefone/CPF criptografados (SHA-256) e o click ID da origem.</p></div>`;
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
    h.push(`<p class="hint" style="margin-top:10px;text-align:left">Abre a autorização da Meta. Você escolhe a conta de anúncios e pronto: a permissão pedida é só de <b>leitura</b> (ads_read). A autorização vale <b>60 dias</b>, quando estiver perto de vencer, avisamos aqui para você reconectar em um clique, sem perder nada.</p>`);
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
    texto = 'A Meta parou de enviar o gasto das campanhas. Clique em <b>Reconectar</b> para voltar a sincronizar, leva 10 segundos.';
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
    if (d.type !== 'KOONFY_METAADS_CALLBACK') return;
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
      <td>${c.cpa === null ? '-' : trkBRL(c.cpa)}</td><td>${trkBRL(c.ticket)}</td>
      <td class="muted" style="font-size:12px">${c.produtos.map(esc).join('<br>') || '-'}</td>
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
        <td><b>${esc(e.name)}</b></td><td>${esc(e.source || '-')}</td>
        <td class="muted" style="white-space:nowrap">${new Date(e.ts).toLocaleDateString('pt-BR')} · ${new Date(e.ts).toLocaleTimeString('pt-BR').slice(0, 5)}</td>
        <td class="muted" style="font-size:11.5px">${esc((e.sid || '').slice(0, 10) || '-')}</td>
        <td>${esc((e.payload && e.payload.utm && e.payload.utm.campaign) || (e.payload && e.payload.campaign) || '-')}</td>
        <td>${e.payload && e.payload.value ? trkBRL(Math.round(e.payload.value * 100)) : '-'}</td>
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
    <p class="muted" style="font-size:13px;margin:4px 0 12px">Cole antes do <b>&lt;/body&gt;</b> das suas páginas (landing, vendas, obrigado). Ele captura <b>fbclid, gclid, ttclid e UTMs</b> e liga cada visita à venda no Pagamentos.</p>
    <div class="ep-copy"><input readonly value='<script src="${esc(url)}"></script>' onclick="this.select()">
      <button class="btn small" onclick="epCopy(this.previousElementSibling.value)">${ico('copy', 13)}</button></div>
    <p class="hint" style="margin-top:12px">${ico('shield', 12)} O checkout do Pagamentos já rastreia sozinho, o snippet é para as SUAS páginas.</p>
    <div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn primary no-grow" onclick="closeModal()">Fechar</button></div>`);
}

init();


// Traduz a faixa da Meta para o que a pessoa precisa saber: quantas conversas
// NOVAS este número pode iniciar em 24 horas. Não é o total de mensagens —
// responder quem já falou com você não entra nessa conta, e é por isso que o
// rótulo diz "conversas" e o detalhe explica.
function limiteDiarioHtml(w) {
  const TETO = {
    TIER_50: '50 conversas', TIER_250: '250 conversas', TIER_1K: '1.000 conversas',
    TIER_10K: '10.000 conversas', TIER_100K: '100.000 conversas', TIER_UNLIMITED: 'Sem teto'
  };
  const faixa = w.messagingTier || '';
  if (!faixa) return '<span class="muted">clique em Atualizar dados</span>';
  const rotulo = TETO[faixa] || faixa;
  const semTeto = faixa === 'TIER_UNLIMITED';
  return `<span class="pill ${semTeto ? 'done' : ''}">${esc(rotulo)}</span>` +
    `<div class="muted" style="font-weight:600;font-size:11.5px;margin-top:3px">conversas novas por 24h, informado pela Meta</div>`;
}
