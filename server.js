const express = require('express');
const path = require('path');
const db = require('./src/db');
const push = require('./src/push');
const pushNative = require('./src/pushnative');

db.load();
try { push.ensureKeys(); } catch (e) { console.warn('[push] VAPID indisponível:', e.message); }

const app = express();

// CORS para os apps das lojas. O WebView do app nativo não roda no nosso
// domínio — no iOS a página vem de capacitor://localhost e no Android de
// https://localhost — então toda chamada à API é cross-origin e o navegador
// exige estes cabeçalhos. A lista é fechada nessas origens (mais quaisquer
// extras em CORS_ORIGINS) para não abrir a API para qualquer site.
const NATIVE_ORIGINS = new Set([
  'capacitor://localhost',   // iOS
  'https://localhost',       // Android
  'http://localhost',        // `npx cap run` com live reload
  ...String(process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && NATIVE_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-channel');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
  }
  next();
});

app.use(express.json({
  limit: '80mb',
  verify: (req, res, buf) => { req.rawBody = buf; } // corpo bruto p/ validar X-Hub-Signature-256
}));

// Clientes SSE conectados: { res, accountId, isAdmin }
// Eventos com accountId vão só para a conta dona (admin vê tudo).
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (data && data.accountId && !c.isAdmin && c.accountId !== data.accountId) continue;
    try { c.res.write(payload); } catch {}
  }
  // Push Notification (WebApp instalado, mesmo com o app fechado)
  try { maybePush(event, data); } catch (e) {}
}

// Traduz eventos SSE em notificações push (nome do contato = título, mensagem = corpo).
function maybePush(event, data) {
  if (!data || !data.accountId) return;
  let type = null, payload = null;
  const url = '/app/#/inbox';
  if (event === 'message' && data.notify && data.notify.direction === 'in') {
    type = 'message';
    payload = { title: data.notify.name || 'Nova mensagem', body: data.notify.text || '', tag: 'msg:' + data.waId, data: { type, waId: data.waId, url } };
  } else if (event === 'call' && data.kind === 'incoming') {
    const c = data.call || {};
    type = 'call';
    payload = { title: 'Chamada de voz', body: ((c.name || c.contactName || ('+' + (c.waId || ''))) + ' está te ligando…'), tag: 'call:' + (c.id || ''), requireInteraction: true, data: { type, waId: c.waId, url } };
  } else if (event === 'attendance' && data.status === 'open' && data.reason === 'inbound') {
    type = 'attendance';
    payload = { title: 'Novo atendimento', body: (data.name || 'Cliente') + ' iniciou uma conversa', tag: 'att:' + data.waId, data: { type, waId: data.waId, url } };
  } else if (event === 'elitepay' && data.status === 'paid') {
    // VENDA APROVADA no Elite Pay. O dinheiro entrou: é a notificação que o
    // lojista mais espera, e era a única do fluxo de venda que não existia.
    const fmt = require('./src/elitepay').fmtBRL;
    type = 'sale';
    payload = {
      title: 'Venda aprovada ✅',
      body: fmt(data.amount || 0) + (data.contactName ? ' · ' + data.contactName : ''),
      tag: 'sale:' + (data.chargeId || Date.now()),
      data: { type, waId: data.waId || null, url: '/app/#/elitepay' }
    };
  } else if (event === 'commission') {
    // Venda do indicado aprovada — o afiliado recebe o valor da comissão.
    type = 'commission';
    payload = {
      title: 'Venda Aprovada✅',
      body: 'Sua comissão: ' + require('./src/elitepay').fmtBRL(data.amount || 0),
      tag: 'com:' + (data.accountId || '') + ':' + Date.now(),
      data: { type, url: '/app/#/billing' }
    };
  } else if (event === 'reminder') {
    const ev = data.event || {};
    const when = ev.start ? new Date(ev.start).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
    type = 'reminder';
    payload = { title: 'Lembrete — ' + (data.label || 'Agendamento'), body: `${ev.title || ''}${when ? ' · ' + when : ''}`, tag: 'ev:' + (ev.id || ''), requireInteraction: true, data: { type, waId: ev.contact ? ev.contact.waId : null, url: ev.contact ? url : '/app/#/schedule' } };
  }
  if (!type) return;
  const acc = db.findAccount(data.accountId);
  if (!acc) return;
  push.sendToAccount(acc, type, payload);              // navegador (Web Push)
  pushNative.sendToAccount(acc, type, payload);        // apps das lojas (FCM/APNs)
}

// Callback do Embedded Signup (fluxo de diálogo OAuth com redirect).
// Recebe code + state e repassa para a janela do app via postMessage.
app.get('/auth/meta/callback', (req, res) => {
  const payload = JSON.stringify({
    type: 'ELITECHAT_META_CALLBACK',
    code: String(req.query.code || ''),
    state: String(req.query.state || ''),
    error: String(req.query.error || ''),
    errorDescription: String(req.query.error_description || '')
  });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Conectando…</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#101828;background:#f6f8fa}div{text-align:center}</style>
</head><body><div><b>Conectando seu WhatsApp…</b><p>Você já pode fechar esta janela.</p></div>
<script>
  (function () {
    var payload = ${payload};
    try {
      if (window.opener) {
        window.opener.postMessage(payload, window.location.origin);
        setTimeout(function () { window.close(); }, 900);
        return;
      }
    } catch (e) {}
    // Sem opener: veio do app das lojas (navegador do sistema). Devolve
    // pelo deep link; se o app nao estiver instalado, cai no painel web.
    var deep = 'elitechat://auth/meta?' + new URLSearchParams({ code: payload.code, state: payload.state, error: payload.error, error_description: payload.errorDescription });
    setTimeout(function () { window.location.replace('/app/#/settings'); }, 1200);
    window.location.href = deep;
  })();
</script></body></html>`);
});

// Callback do OAuth do META ADS (permissão ads_read, usado pelo Tracking).
// Mesma mecânica do Embedded Signup: devolve o code para a janela do painel.
app.get('/auth/meta-ads/callback', (req, res) => {
  const payload = JSON.stringify({
    type: 'ELITECHAT_METAADS_CALLBACK',
    code: String(req.query.code || ''),
    state: String(req.query.state || ''),
    error: String(req.query.error_description || req.query.error || '')
  });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Conectando…</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#101828;background:#f6f8fa}div{text-align:center}</style>
</head><body><div><b>Conectando sua conta de anúncios…</b><p>Você já pode fechar esta janela.</p></div>
<script>
  (function () {
    var payload = ${payload};
    try {
      if (window.opener) {
        window.opener.postMessage(payload, window.location.origin);
        setTimeout(function () { window.close(); }, 900);
        return;
      }
    } catch (e) {}
    var deep = 'elitechat://auth/meta-ads?' + new URLSearchParams({ code: payload.code, state: payload.state, error: payload.error });
    setTimeout(function () { window.location.replace('/app/#/tracking'); }, 1200);
    window.location.href = deep;
  })();
</script></body></html>`);
});

// Callback do OAuth da Nuvemshop — mesma mecânica do Embedded Signup da Meta:
// recebe o `code`, repassa para a janela do painel via postMessage e fecha.
app.get('/auth/nuvemshop/callback', (req, res) => {
  const payload = JSON.stringify({
    type: 'ELITECHAT_NUVEMSHOP_CALLBACK',
    code: String(req.query.code || ''),
    state: String(req.query.state || ''),
    error: String(req.query.error || '')
  });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Conectando…</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#101828;background:#f6f8fa}div{text-align:center}</style>
</head><body><div><b>Conectando sua loja Nuvemshop…</b><p>Você já pode fechar esta janela.</p></div>
<script>
  (function () {
    var payload = ${payload};
    try {
      if (window.opener) {
        window.opener.postMessage(payload, window.location.origin);
        setTimeout(function () { window.close(); }, 900);
        return;
      }
    } catch (e) {}
    var deep = 'elitechat://auth/nuvemshop?' + new URLSearchParams({ code: payload.code, state: payload.state, error: payload.error });
    setTimeout(function () { window.location.replace('/app/#/integrations'); }, 1200);
    window.location.href = deep;
  })();
</script></body></html>`);
});

// Gatilho de automação por webhook externo (Flow Builder).
// POST /flow-hook/:token  body: { to, vars? }  → executa a automação.
const flows = require('./src/flows');
const store = require('./src/store');
function flowDeliver(acc, to, content, apiResp) {
  const msg = store.storeOutbound(acc, to, content, apiResp);
  broadcast('message', { accountId: acc.id, waId: msg.waId });
  return msg;
}
app.all('/flow-hook/:token', async (req, res) => {
  const found = flows.findFlowByHook(req.params.token);
  if (!found) return res.status(404).json({ error: 'Automação não encontrada ou desativada' });
  const body = req.body || {};
  const to = body.to || (req.query && req.query.to);
  // Captura as variáveis recebidas (só valores simples) — ficam disponíveis
  // como {webhook.<flow>.<campo>} nos disparos e no Flow Builder.
  const incoming = { ...(req.query || {}), ...(typeof body.vars === 'object' && body.vars ? body.vars : body) };
  const lastVars = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (['to', 'name', 'text'].includes(k)) continue;
    if (['string', 'number', 'boolean'].includes(typeof v)) lastVars[String(k).slice(0, 40)] = String(v).slice(0, 500);
  }
  if (Object.keys(lastVars).length) {
    found.flow.lastVars = { ...(found.flow.lastVars || {}), ...lastVars };
    found.flow.lastVarsAt = Date.now();
    db.save();
  }
  try {
    const log = await flows.runFlow(found.acc, found.flow, {
      to: to ? String(to) : '',
      contactName: body.name || '',
      text: body.text || '',
      vars: body.vars || body
    }, flowDeliver);
    res.json({ ok: true, ran: found.flow.name, steps: log });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Webhook de ENTRADA (aba Webhooks): recebe evento externo, mapeia campos →
// cria/atualiza contato e dispara os flows vinculados a este webhook.
const webhooks = require('./src/webhooks');
app.all('/hook/:token', async (req, res) => {
  const found = db.findWebhookByToken(req.params.token);
  if (!found) return res.status(404).json({ error: 'Webhook não encontrado' });
  const { acc, webhook } = found;
  const payload = (req.body && Object.keys(req.body).length) ? req.body : (req.query || {});
  const { mapped, contact } = webhooks.ingest(acc, webhook, payload, broadcast);
  // dispara automações que usam este webhook como gatilho
  const linked = (acc.flows || []).filter(f => f.enabled && f.trigger && f.trigger.type === 'webhook' && f.trigger.webhookId === webhook.id);
  for (const flow of linked) {
    try {
      await flows.runFlow(acc, flow, {
        to: mapped.phone || '',
        contactName: (contact && contact.name) || mapped.name || '',
        text: '',
        vars: { ...mapped.vars, nome: mapped.name, email: mapped.email, telefone: mapped.phone }
      }, flowDeliver);
    } catch (e) { store.logEvent({ type: 'flow_error', accountId: acc.id, error: e.message }); }
  }
  res.json({ ok: true, contact: contact ? { waId: contact.waId, name: contact.name } : null, triggered: linked.length });
});

// Monta o destino final com os parâmetros UTM do link.
function destWithUtm(link) {
  const u = link.utm || {};
  if (!Object.keys(u).length) return link.dest;
  try {
    const url = new URL(link.dest);
    for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
      if (u[k] && !url.searchParams.has('utm_' + k)) url.searchParams.set('utm_' + k, u[k]);
    }
    return url.toString();
  } catch { return link.dest; }
}

// Conversions API (server-side) da Meta — mais confiável que o pixel do navegador.
function fireCapi(acc, link, req) {
  const metas = (acc.pixels || []).filter(p => p.type === 'meta' && p.pixelId && p.capiToken);
  if (!metas.length) return;
  const ver = db.get().platform.graphVersion || 'v25.0';
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  const ua = String(req.get('user-agent') || '');
  const evName = link.event || 'PageView';
  const custom = {};
  if (link.value) { custom.value = Number(link.value); custom.currency = link.currency || 'BRL'; }
  for (const p of metas) {
    const payload = {
      data: [{
        event_name: evName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: `${req.protocol}://${req.get('host')}/l/${link.slug}`,
        user_data: { client_ip_address: ip, client_user_agent: ua },
        ...(Object.keys(custom).length ? { custom_data: custom } : {})
      }],
      ...(p.testCode ? { test_event_code: p.testCode } : {})
    };
    fetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(idOk(p.pixelId))}/events?access_token=${encodeURIComponent(p.capiToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(() => { p.lastEventAt = Date.now(); db.save(); }).catch(() => {});
  }
}

// Link rastreável encurtado (público). Registra o clique, dispara os pixels do
// navegador + Conversions API server-side, aplica UTM e redireciona ao destino.
app.get('/l/:slug', (req, res) => {
  const found = db.findLinkBySlug(req.params.slug);
  if (!found) return res.status(404).send('<meta charset="utf-8"><title>Link não encontrado</title><p style="font-family:sans-serif;text-align:center;margin-top:80px">Link não encontrado ou removido.</p>');
  const { acc, link } = found;
  link.clicks.push({
    ts: Date.now(),
    ua: String(req.get('user-agent') || '').slice(0, 300),
    ref: String(req.get('referer') || '').slice(0, 300)
  });
  if (link.clicks.length > 5000) link.clicks.splice(0, link.clicks.length - 5000);
  db.save();
  fireCapi(acc, link, req);   // server-side (não bloqueia)

  const dest = destWithUtm(link);
  const pixels = (acc.pixels || []).filter(p => p && p.pixelId);
  // Tags de navegador ligadas em Tracking (LinkedIn, UET, Snapchat, Pinterest,
  // GTM, Meta Pixel, Google Ads). Sem elas o clique não seria registrado nessas
  // plataformas, mesmo com o ID preenchido no painel.
  let tags = '';
  try { tags = require('./src/tracking').clientTags(acc, { event: link.event || 'PageView' }); } catch {}
  if (!pixels.length && !tags) return res.redirect(302, dest);

  // Mesmo cuidado das tags de Tracking: JSON.stringify NAO escapa "</script>",
  // entao um pixelId com HTML fecharia a tag e injetaria script nesta pagina
  // publica. Filtramos para alfanumerico e escapamos "<" no serializador.
  const idOk = v => String(v || '').replace(/[^\w.:-]/g, '').slice(0, 64);
  const js = v => JSON.stringify(v === undefined ? '' : v).replace(/</g, '\\u003c');
  const metas = pixels.filter(p => p.type === 'meta');
  const gtags = pixels.filter(p => p.type === 'gtag');
  const ttks = pixels.filter(p => p.type === 'tiktok');
  const ev = link.event || 'PageView';
  const val = link.value ? { value: Number(link.value), currency: link.currency || 'BRL' } : {};
  const evParams = { slug: link.slug, title: link.title || '', ...val };
  const gaVal = link.value ? `,value:${Number(link.value)},currency:${JSON.stringify(link.currency || 'BRL')}` : '';
  const destJson = JSON.stringify(dest);
  const destAttr = dest.replace(/"/g, '&quot;');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redirecionando…</title>
<meta http-equiv="refresh" content="2;url=${destAttr}">
${tags}
${metas.length ? `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');${metas.map(p => `fbq('init',${js(idOk(p.pixelId))});`).join('')}fbq('track',${js(ev)},${JSON.stringify(val).replace(/</g,"\u003c")});fbq('trackCustom','LinkClick',${JSON.stringify(evParams).replace(/</g,"\u003c")});</script><noscript>${metas.map(p => `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${encodeURIComponent(idOk(p.pixelId))}&ev=${encodeURIComponent(ev)}&noscript=1">`).join('')}</noscript>` : ''}
${gtags.length ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(idOk(gtags[0].pixelId))}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());${gtags.map(p => `gtag('config',${js(idOk(p.pixelId))});`).join('')}gtag('event',${js(ev.toLowerCase())},{link_slug:${js(link.slug)}${gaVal}});</script>` : ''}
${ttks.length ? `<script>!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie"];ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.load=function(e,n){var i="https://analytics.tiktok.com/i18n/pixel/events.js";ttq._i=ttq._i||{};ttq._i[e]=[];ttq._i[e]._u=i;ttq._t=ttq._t||{};ttq._t[e]=+new Date;ttq._o=ttq._o||{};ttq._o[e]=n||{};var o=document.createElement("script");o.type="text/javascript";o.async=!0;o.src=i+"?sdkid="+e+"&lib="+t;var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(o,a)};${ttks.map(p => `ttq.load(${js(idOk(p.pixelId))});`).join('')}ttq.page();ttq.track(${js(ev)});}(window,document,'ttq');</script>` : ''}
<style>body{font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f7faf6;color:#0f1f15}div{text-align:center}.sp{width:34px;height:34px;border:3px solid #d7eee3;border-top-color:#10b981;border-radius:50%;margin:0 auto 14px;animation:r .8s linear infinite}@keyframes r{to{transform:rotate(360deg)}}</style>
</head><body><div><div class="sp"></div><b>Redirecionando…</b></div>
<script>setTimeout(function(){window.location.replace(${destJson})},700);</script>
</body></html>`);
});

// Snippet de rastreamento do Tracking (instalável em qualquer site do cliente):
// <script src="https://SEU-DOMINIO/t.js?a=ACCOUNT_ID"></script>
// Captura fbclid/gclid/ttclid + UTMs, mantém a sessão e envia PageView.
app.get('/t.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.send(`(function(){try{
var a=new URL(document.currentScript.src).searchParams.get('a');if(!a)return;
var q=new URLSearchParams(location.search);
var st=JSON.parse(localStorage.getItem('ec_trk')||'{}');
st.sid=st.sid||(Date.now().toString(36)+Math.random().toString(36).slice(2,10));
['fbclid','gclid','ttclid'].forEach(function(k){if(q.get(k))st[k]=q.get(k);});
st.utm=st.utm||{};['source','medium','campaign','content','term'].forEach(function(k){if(q.get('utm_'+k))st.utm[k]=q.get('utm_'+k);});
localStorage.setItem('ec_trk',JSON.stringify(st));
fetch(new URL('/api/public/track/'+a,document.currentScript.src).href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'PageView',source:'site',sid:st.sid,url:location.href,fbclid:st.fbclid,gclid:st.gclid,ttclid:st.ttclid,utm:st.utm})});
}catch(e){}})();`);
});

// Checkout público do Elite Pay — página de pagamento das cobranças (/pay/:id).
// A página busca os dados em /api/public/pay/:id (rota sem autenticação).
app.get('/pay/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// Webhook de pagamentos Woovi (Pix / Pix Automático) — configurar em app.woovi.com → Webhooks
app.post('/woovi-webhook', require('./src/woovi').webhookHandler(broadcast));

// Eventos do adquirente de cartão (Pagar.me / Asaas): pagamento confirmado,
// estorno e aprovação do recebedor. Autenticado + reconferido na API.
app.post('/card-webhook', require('./src/elitepay').cardWebhookHandler(broadcast));

// Status de entrega dos SMS (DLR da Integra X). Informe esta URL no campo
// "callback" do Admin SaaS → SMS: <SEU_DOMINIO>/sms-webhook
app.post('/sms-webhook', require('./src/sms').webhookHandler(broadcast));

// Eventos da loja Nuvemshop (pedido criado/pago/cancelado, cliente novo).
// Assinado com HMAC-SHA256 — a validação usa req.rawBody.
app.set('flowDeliver', flowDeliver);
app.post('/nuvemshop-webhook', require('./src/nuvemshop').webhookHandler(broadcast));

app.use(require('./src/webhook')(broadcast));
app.use('/api', require('./src/api')(broadcast, clients));

// ---------- SEO da página de marketing (personalizável no Admin SaaS) ----------
// Injeta as meta tags no <head> do HTML inicial (o que os buscadores leem),
// usando o que o admin salvou em platform.seo.
const fs = require('fs');
const LANDING_FILE = path.join(__dirname, 'public', 'index.html');
let _landingHtml = null;
function landingHtml() {
  if (_landingHtml == null) { try { _landingHtml = fs.readFileSync(LANDING_FILE, 'utf8'); } catch { _landingHtml = ''; } }
  return _landingHtml;
}
function seoEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function buildSeoHead(seo, origin) {
  seo = seo || {};
  const title = seo.title || 'EliteChat — CRM de WhatsApp com IA';
  const desc = seo.description || 'Automatize o atendimento no WhatsApp, gerencie leads no CRM e dispare campanhas em massa com o EliteChat.';
  const ogTitle = seo.ogTitle || title;
  const ogDesc = seo.ogDescription || desc;
  const ogImg = seo.ogImage || (origin + '/assets/elitechat-logo.png');
  const url = seo.canonical || origin + '/';
  const theme = seo.themeColor || '#34D399';
  const t = [];
  t.push(`<title>${seoEsc(title)}</title>`);
  t.push(`<meta name="description" content="${seoEsc(desc)}">`);
  if (seo.keywords) t.push(`<meta name="keywords" content="${seoEsc(seo.keywords)}">`);
  if (seo.author) t.push(`<meta name="author" content="${seoEsc(seo.author)}">`);
  t.push(`<meta name="robots" content="${seoEsc(seo.robots || 'index, follow')}">`);
  t.push(`<meta name="theme-color" content="${seoEsc(theme)}">`);
  t.push(`<link rel="canonical" href="${seoEsc(url)}">`);
  t.push(`<meta property="og:type" content="website">`);
  t.push(`<meta property="og:site_name" content="EliteChat">`);
  t.push(`<meta property="og:title" content="${seoEsc(ogTitle)}">`);
  t.push(`<meta property="og:description" content="${seoEsc(ogDesc)}">`);
  t.push(`<meta property="og:image" content="${seoEsc(ogImg)}">`);
  t.push(`<meta property="og:url" content="${seoEsc(url)}">`);
  t.push(`<meta name="twitter:card" content="summary_large_image">`);
  t.push(`<meta name="twitter:title" content="${seoEsc(ogTitle)}">`);
  t.push(`<meta name="twitter:description" content="${seoEsc(ogDesc)}">`);
  t.push(`<meta name="twitter:image" content="${seoEsc(ogImg)}">`);
  if (seo.gaId) t.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(seo.gaId)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',${JSON.stringify(seo.gaId)});</script>`);
  if (seo.extraHead) t.push(seo.extraHead);
  return '\n<!-- SEO EliteChat -->\n' + t.join('\n') + '\n';
}
function serveLanding(req, res) {
  let html = landingHtml();
  if (!html) return res.status(404).send('Página não encontrada');
  const origin = `${req.protocol}://${req.get('host')}`;
  const head = buildSeoHead(db.get().platform.seo, origin);
  html = html.replace(/<title>[\s\S]*?<\/title>/i, '');
  html = html.replace(/<\/head>/i, head + '</head>');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
app.get('/', serveLanding);
app.get('/index.html', serveLanding);

// Política de privacidade e termos com URL limpa. App Store e Play Store
// exigem o link da política no cadastro do app, e ele precisa continuar
// funcionando enquanto o app estiver publicado.
app.get('/privacidade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacidade.html')));
app.get('/termos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'termos.html')));

app.use(express.static(path.join(__dirname, 'public')));

// Finalização automática por inatividade (Configurações → Atendimento).
// Varre a cada minuto; o intervalo configurado por conta é respeitado no módulo.
const session = require('./src/session');
setInterval(() => {
  try {
    const n = session.autoCloseSweep(broadcast);
    if (n) console.log(`[atendimento] ${n} atendimento(s) finalizado(s) automaticamente por inatividade`);
  } catch (e) { console.error('[atendimento] erro no sweep:', e.message); }
}, 60 * 1000);

// PESQUISA DE SATISFAÇÃO — plugada no gatilho da finalização.
// Nada da janela de 24h nem da finalização precisou ser alterado: o módulo só
// registra um handler no evento "atendimento encerrado".
const survey = require('./src/survey');
session.onFinished(({ acc, contact, attendance }) => {
  store.logEvent({
    type: 'attendance_closed', accountId: acc.id, waId: contact.waId,
    closeType: attendance.closeType, closedBy: attendance.closedBy
  });
});
session.onFinished(survey.makeOnFinished(broadcast));

// Lembretes de agendamentos — dispara via SSE (in-app) e Push Notification.
const schedule = require('./src/schedule');
setInterval(() => {
  try { schedule.sweepReminders(broadcast); }
  catch (e) { console.error('[agenda] erro no sweep de lembretes:', e.message); }
}, 30 * 1000);

// Liberação dos recebíveis de cartão: a venda entra como "a liberar" e vira
// saldo sacável quando vence o prazo do adquirente (D+30/D+32). Tick de 1h.
const elitepayMod = require('./src/elitepay');
setInterval(() => {
  try { elitepayMod.releaseReceivables(broadcast); }
  catch (e) { console.error('[carteira] erro ao liberar recebíveis:', e.message); }
}, 60 * 60 * 1000);
setTimeout(() => { try { elitepayMod.releaseReceivables(broadcast); } catch {} }, 20000);

// Renovação automática das assinaturas pagas no CARTÃO (tick diário).
// O Pix recorrente é renovado pela própria Woovi; o cartão é por nossa conta.
require('./src/saasbilling').startRenewalJob(broadcast);

const PORT = process.env.PORT || 3900;
app.listen(PORT, () => {
  const p = db.get().platform;
  console.log('==============================================');
  console.log(`  EliteChat rodando em http://localhost:${PORT}`);
  console.log(`  Site (marketing):    http://localhost:${PORT}/`);
  console.log(`  Painel:              http://localhost:${PORT}/app`);
  console.log(`  Webhook Meta:        POST/GET /webhook`);
  console.log(`  Verify Token:        ${p.verifyToken}`);
  console.log(`  Graph API:           ${p.graphVersion}`);
  console.log('==============================================');
});
