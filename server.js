const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./src/db');
const push = require('./src/push');
const pushNative = require('./src/pushnative');

// CARGA DO BANCO
//
// No arquivo é síncrona e acontece aqui mesmo. No MySQL não dá: a conexão é
// assíncrona, então a partida espera em `pronto` e o servidor só escuta a
// porta depois que o banco está em memória. Sem isso, a primeira requisição
// chegaria antes dos dados.
const pronto = db.storage.nome === 'mysql'
  ? db.loadAsync()
  : Promise.resolve(db.load());

pronto.then(() => { try { push.ensureKeys(); } catch (e) { console.warn('[push] VAPID indisponível:', e.message); } });

const app = express();

// ---------------------------------------------------------------------------
// ATRÁS DE PROXY (Cloudflare + DigitalOcean)
//
// Sem isto, `req.protocol` responde "http" mesmo o site estando em HTTPS: o TLS
// termina no proxy, e o Express só descobre o esquema original pelo cabeçalho
// X-Forwarded-Proto, que ele ignora até ser mandado confiar.
//
// Não era detalhe de exibição. `req.protocol` monta as URLs PÚBLICAS do
// produto: o link de pagamento enviado ao cliente, o event_source_url do
// CAPI da Meta, o webhook do adquirente e — o pior — a URI de redirecionamento
// que o painel manda cadastrar no app da Meta. Cadastrar
// `http://.../auth/meta/callback` quando o retorno vem por `https://` faz o
// OAuth recusar, porque a Meta compara a URI inteira.
//
// Confiar no cabeçalho é seguro aqui porque nada no app autoriza por IP: o
// único uso de X-Forwarded-For é atribuição do CAPI, e o tráfego sempre entra
// pelo proxy da plataforma.
app.set('trust proxy', true);

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
  // Com a API num host próprio (api.koonfy.com), o painel em app.koonfy.com
  // passa a fazer chamada CROSS-ORIGIN: mesmo servidor, origens diferentes
  // para o navegador. Sem liberar, o painel para de funcionar. A lista é
  // fechada nos endereços do próprio produto — vitrine, painel e checkout.
  const doProduto = require('./src/hosts').ehHostDaApi(req) && origin &&
    require('./src/hosts').origensDoProduto(req).has(origin.replace(/\/+$/, ''));
  if (origin && (NATIVE_ORIGINS.has(origin) || doProduto)) {
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
    // O fuso vem da CONTA: sem ele o texto saía no fuso do processo (UTC em
    // produção) e um compromisso das 9h era anunciado como 12h.
    const when = require('./src/datas').hora(ev.start, db.findAccount(data.accountId));
    type = 'reminder';
    payload = { title: 'Lembrete ' + (data.label || 'Agendamento'), body: `${ev.title || ''}${when ? ' · ' + when : ''}`, tag: 'ev:' + (ev.id || ''), requireInteraction: true, data: { type, waId: ev.contact ? ev.contact.waId : null, url: ev.contact ? url : '/app/#/schedule' } };
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
  const ver = db.get().platform.graphVersion || 'v26.0';
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

// No domínio de checkout a cobrança fica na raiz: pay.koonfy.com/<id>, sem o
// /pay/ repetindo o que o próprio endereço já diz. O caminho antigo continua
// valendo em todos os hosts, porque as cobranças já emitidas gravaram o link
// com ele e precisam continuar abrindo.
app.get('/:id', (req, res, next) => {
  if (!hosts.ehHostDoPay(req)) return next();
  // Só o que tem cara de id de cobrança; o resto (favicon, assets) segue o
  // fluxo normal e é servido pelo express.static.
  if (!/^epc_[a-z0-9]+$/i.test(req.params.id)) return next();
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// Webhook de pagamentos Woovi (Pix / Pix Automático) — configurar em app.woovi.com → Webhooks
app.post('/woovi-webhook', require('./src/woovi').webhookHandler(broadcast));
// Webhook da Simplify. O endereço é mandado em cada cobrança (a Simplify não
// tem cadastro fixo de webhook), então nada precisa ser configurado no painel
// dela — mas ele também não é assinado, e por isso o handler confere o valor
// antes de dar a cobrança como paga.
app.post('/simplify-webhook', require('./src/simplify').webhookHandler(broadcast));

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
// A VITRINE PRINCIPAL é a nova (nova.html). A antiga continua no arquivo
// index.html e acessível por /antiga — trocar é mudar esta linha, e manter a
// anterior de pé é o que permite voltar atrás sem deploy de emergência.
const LANDING_FILE = path.join(__dirname, 'public', 'nova.html');
const LANDING_ANTIGA = path.join(__dirname, 'public', 'index.html');
let _landingHtml = null;
function landingHtml() {
  if (_landingHtml == null) { try { _landingHtml = fs.readFileSync(LANDING_FILE, 'utf8'); } catch { _landingHtml = ''; } }
  return _landingHtml;
}
function seoEsc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function buildSeoHead(seo, origin) {
  seo = seo || {};
  // O título da aba nasce do NOME e da DESCRIÇÃO em Personalização. O campo
  // do bloco de SEO continua valendo e vence, para quem já escreveu um título
  // pensado para o buscador não perdê-lo.
  const mk = db.get().platform.marca || {};
  const nomeMarca = (mk.nome || '').trim() || 'Koonfy';
  const descrMarca = (mk.descricao || '').trim();
  const title = seo.title || (descrMarca ? `${nomeMarca} | ${descrMarca}` : nomeMarca);
  const desc = seo.description || 'Automatize o atendimento no WhatsApp, gerencie leads no CRM e dispare campanhas em massa com o Koonfy.';
  const ogTitle = seo.ogTitle || title;
  const ogDesc = seo.ogDescription || desc;
  // Imagem do preview quando o link é compartilhado (WhatsApp, redes, buscador).
  // Ficou apontando para a logo antiga depois da troca da marca — e é
  // justamente onde ninguém olha, porque só aparece fora do produto.
  const ogImg = seo.ogImage || (origin + '/assets/koonfy-512.png');
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
  t.push(`<meta property="og:site_name" content="Koonfy">`);
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
  return '\n<!-- SEO Koonfy -->\n' + t.join('\n') + '\n';
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
// ---------------------------------------------------------------------------
// SUBDOMÍNIO DO PAINEL
//
// koonfy.com     -> a landing (vitrine)
// app.koonfy.com -> o painel
//
// É o mesmo servidor nos dois: o que muda é o que a RAIZ de cada host entrega.
// Não é separar back de front — é só dar um endereço próprio ao painel, sem
// CORS e sem mais nada para operar, já que cada host serve tanto a página
// quanto as chamadas dela.
//
// Redireciona para /app/ em vez de servir o HTML direto porque o Service
// Worker do PWA tem escopo "/app/": servido em "/", ele não controlaria a
// página, e o app instalado pararia de funcionar offline.
//
// O host do painel é configurável (PANEL_HOST) e, sem isso, qualquer host que
// comece com "app." serve — assim funciona em qualquer domínio sem ajuste.
// A decisão mora em src/hosts.js, que é o mesmo lugar consultado para saber
// qual endereço pode ser escrito num link enviado ao cliente.
const hosts = require('./src/hosts');
app.get(['/', '/index.html'], (req, res, next) => {
  if (hosts.ehHostDoPainel(req)) return res.redirect(302, '/app/');
  // Raiz do domínio de checkout: não há cobrança nenhuma para mostrar, então
  // manda para a vitrine em vez de devolver a landing num endereço que o
  // cliente associa a pagamento.
  if (hosts.ehHostDoPay(req)) {
    const pub = hosts.PUBLIC_URL || '';
    return pub ? res.redirect(302, pub) : res.status(404).send('Cobrança não encontrada');
  }
  // O host da API não serve página: quem chega aqui pelo navegador se enganou.
  if (hosts.ehHostDaApi(req)) return res.status(404).json({ error: 'Este endereço serve apenas a API' });
  next();
});

app.get('/', serveLanding);
app.get('/index.html', serveLanding);

// Política de privacidade e termos com URL limpa. App Store e Play Store
// exigem o link da política no cadastro do app, e ele precisa continuar
// funcionando enquanto o app estiver publicado.
// ---------------------------------------------------------------------------
// A MARCA, num endereço só
//
// Todo lugar que mostra a logo aponta para cá. Assim, trocar a arte no Admin
// SaaS muda o produto inteiro de uma vez — painel, landing, checkout, páginas
// legais, favicon e ícone do app — sem editar arquivo nenhum.
//
// Sem logo enviada, cai no arquivo do repositório. O cache é curto de
// propósito: quem acabou de trocar a logo precisa VER a troca, e o `?v=` que
// as telas mandam já resolve o cache longo quando ela não muda.
// ---------------------------------------------------------------------------
// MANIFESTO DO APP — montado, e não servido de arquivo.
//
// Nome, descrição e ícones vinham escritos à mão em manifest.webmanifest,
// então trocar a marca no Admin não mudava a caixa "Instale o app" do
// navegador: ela seguia com a arte de fábrica. Aqui o nome sai de
// Personalização e os ícones apontam para /marca/logo.
//
// Os ícones MASCARÁVEIS continuam vindo dos arquivos de public/assets: eles
// exigem uma área de segurança no desenho que uma logo qualquer não tem, e
// um upload comum ali sairia cortado no Android.
app.get('/app/manifest.webmanifest', (req, res) => {
  const mk = (db.get().platform && db.get().platform.marca) || {};
  const nome = String(mk.nome || '').trim() || 'Koonfy';
  const descr = String(mk.descricao || '').trim();
  const manifesto = {
    id: '/app/',
    name: descr ? nome + ' | ' + descr : nome,
    short_name: nome.slice(0, 12),
    description: descr || 'CRM de WhatsApp com atendimento, automações e campanhas.',
    start_url: '/app/?src=pwa',
    scope: '/app/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'portrait-primary',
    background_color: '#EAFBF0',
    theme_color: '#2ED378',
    lang: 'pt-BR', dir: 'ltr',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/marca/logo', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/marca/logo', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/assets/koonfy-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/assets/koonfy-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ],
    shortcuts: [
      { name: 'Conversas', short_name: 'Inbox', url: '/app/?src=pwa#/inbox', icons: [{ src: '/marca/logo', sizes: '192x192' }] },
      { name: 'Agenda', short_name: 'Agenda', url: '/app/?src=pwa#/schedule', icons: [{ src: '/marca/logo', sizes: '192x192' }] },
      { name: 'Automações', short_name: 'Flows', url: '/app/?src=pwa#/flows', icons: [{ src: '/marca/logo', sizes: '192x192' }] }
    ]
  };
  const corpo = JSON.stringify(manifesto);
  const etag = '"mf-' + crypto.createHash('sha1').update(corpo).digest('hex').slice(0, 16) + '"';
  res.set('ETag', etag);
  res.set('Content-Type', 'application/manifest+json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.send(corpo);
});

app.get('/marca/logo', (req, res) => {
  const m = (db.get().platform && db.get().platform.marca) || {};

  // Com `?v=` o endereço muda a cada troca, então pode cachear para sempre.
  // SEM ele, o cache tem que ser revalidado: guardar por uma hora fazia o
  // admin trocar a logo e continuar vendo a antiga na aba já aberta — sem
  // nenhum erro, o que é o pior tipo de bug para diagnosticar.
  // O ETag precisa mudar quando a IMAGEM muda — inclusive quando é a arte
  // padrão que foi trocada no repositório. Usando só `updatedAt`, ele ficava
  // "marca-0" antes e depois de um deploy com logo nova: o navegador mandava o
  // ETag, recebia 304 e continuava desenhando a logo antiga por tempo
  // indeterminado. A marca do arquivo entra na conta.
  let selo = String(m.updatedAt || 0);
  if (!m.logo) {
    try {
      const st = fs.statSync(path.join(__dirname, 'public', 'assets', 'koonfy-192.png'));
      selo = 'p' + st.size + '-' + Math.floor(st.mtimeMs);
    } catch { selo = 'p'; }
  }
  const etag = '"marca-' + selo + '"';
  res.set('ETag', etag);
  res.set('Cache-Control', req.query.v
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=0, must-revalidate');
  if (req.get('if-none-match') === etag) return res.status(304).end();

  // Sem logo enviada pelo painel, vale a arte do repositório — o PNG de 192px,
  // com 36 KB.
  //
  // Cheguei a servir o WEBP aqui por ele ser 30% menor que o PNG do MESMO
  // tamanho, mas o webp original tem 1254px e 674 KB: seriam 674 KB baixados
  // para desenhar um símbolo de 38px, quase 19x mais que o PNG reduzido. O que
  // pesa numa logo é a DIMENSÃO, não o formato. O webp fica guardado como
  // arte-fonte; quem quiser um webp pequeno servido aqui envia pelo Admin.
  if (!m.logo) return res.sendFile(path.join(__dirname, 'public', 'assets', 'koonfy-192.png'));

  const buf = Buffer.from(m.logo, 'base64');
  res.set('Content-Type', m.mime || 'image/png');
  res.set('Content-Length', String(buf.length));
  res.send(buf);
});

// ---------------------------------------------------------------------------
// TEMA — as cores da marca, editáveis no Admin (aba Personalização)
//
// Mesma ideia da logo: sai do banco e vale para o PAINEL, sem deploy. A
// vitrine e o checkout NÃO leem esta folha: eles têm sistema de cores
// próprio (carbono + o verde da logo), e uma cor escolhida para a tela de
// trabalho repintando a página de vendas era efeito colateral, não recurso.
// deploy. O que vem daqui são só REDEFINIÇÕES das variáveis que o CSS já usa —
// campo vazio simplesmente não é escrito, e o padrão do style.css continua
// valendo. Uma instalação nova funciona sem ninguém preencher nada.
//
// O ETag carrega o conteúdo do tema: sem isso o navegador guardaria as cores
// antigas e o admin trocaria a cor sem ver diferença nenhuma.
app.get('/tema.css', (req, res) => {
  const t = (db.get().platform && db.get().platform.tema) || {};
  const cor = (v) => {
    const s = String(v || '').trim();
    // Só hex: este valor entra numa folha de estilo, e aceitar texto livre
    // seria deixar o campo do admin escrever CSS arbitrário.
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : '';
  };
  const linhas = [];
  const por = (nome, valor) => { const c = cor(valor); if (c) linhas.push(`  ${nome}: ${c};`); };
  // A cor da MARCA deixou de ser configurável quando a palavra virou desenho:
  // não há mais "fy" para pintar. O token segue existindo para ícones e
  // destaques, com o verde da logo, e qualquer valor antigo é ignorado.
  por('--btn-verde', t.botao);          // fundo do botão principal
  por('--btn-verde-hover', t.botaoHover);
  por('--btn-tinta', t.tintaBotao);     // texto dentro do botão
  por('--verde-deep', t.verdeDeep);     // verde fechado, para TEXTO sobre fundo claro
  por('--menu-ativo', t.menu);          // item ativo do menu lateral e contadores
  por('--menu-tinta', t.menuTinta);     // texto/ícone dentro do item ativo
  // O brilho embaixo do item ativo acompanha a cor escolhida: com uma cor nova
  // e a sombra antiga, o menu ficava com um halo de outra cor por baixo.
  const menu = cor(t.menu);
  if (menu) {
    const rgb = menu.length === 4
      ? menu.slice(1).split('').map(h => parseInt(h + h, 16))
      : [menu.slice(1, 3), menu.slice(3, 5), menu.slice(5, 7)].map(h => parseInt(h, 16));
    linhas.push(`  --menu-brilho: rgba(${rgb.join(', ')}, .35);`);
  }
  // O BOTÃO BRILHANTE também vale no painel: a tela de entrar é a emenda
  // entre a vitrine e o produto, e ali os dois botões precisam ser o mesmo.
  const br = t.brilho || {};
  const coresBr = (Array.isArray(br.cores) ? br.cores.map(cor).filter(Boolean) : []);
  const paleta = coresBr.length >= 2 ? coresBr : ['#1c834a', '#2ed378'];
  if (br.ligado !== false) {
    const paradas = [paleta[0], paleta[0]].concat(paleta.slice(1)).concat([paleta[0], paleta[0]]);
    linhas.push('  --btn-grad: linear-gradient(' + ((Number(br.angulo) || 45) + 'deg') + ', ' + paradas.join(', ') + ');');
  }
  linhas.push('  --btn-base: ' + paleta[0] + ';');

  const funil = Array.isArray(t.funil) ? t.funil.map(cor).filter(Boolean) : [];
  funil.forEach((c, i) => linhas.push(`  --funil-${i + 1}: ${c};`));
  if (funil.length) linhas.push(`  --funil-n: ${funil.length};`);
  // O modo escuro reescreve alguns destes tokens no próprio style.css, com
  // seletor mais específico que `:root` — a cor do admin perdia a disputa e
  // o campo parecia morto no escuro. Repetimos os afetados no mesmo seletor;
  // campo vazio não entra e o ajuste de legibilidade do escuro segue valendo.
  const noEscuro = [];
  const deep = cor(t.verdeDeep);
  if (deep) noEscuro.push(`  --verde-deep: ${deep};`, `  --brand-dark: ${deep};`);

  const blocos = [];
  if (linhas.length) blocos.push(`:root{\n${linhas.join('\n')}\n}`);
  if (noEscuro.length) blocos.push(`:root[data-theme="dark"]{\n${noEscuro.join('\n')}\n}`);
  const css = blocos.length ? blocos.join('\n') + '\n' : '/* tema padrão */\n';

  const etag = '"tema-' + crypto.createHash('sha1').update(css).digest('hex').slice(0, 16) + '"';
  res.set('ETag', etag);
  res.set('Content-Type', 'text/css; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=0, must-revalidate');
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.send(css);
});

app.get('/privacidade', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacidade.html')));
app.get('/termos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'termos.html')));
// O endereço oficial é sem extensão. Quem já tem o .html salvo (ou registrado
// na Meta) cai no mesmo lugar, com 301 para o buscador não indexar dois
// endereços com o mesmo texto.
app.get('/privacidade.html', (req, res) => res.redirect(301, '/privacidade'));
app.get('/termos.html', (req, res) => res.redirect(301, '/termos'));

// VITRINE NOVA (sistema visual de carbono + verde da logo). Fica aqui, em
// endereço próprio, enquanto a landing atual segue na raiz — trocar é mudar
// o arquivo que `serveLanding` lê.
// /nova continua respondendo (links já enviados) e /antiga guarda a vitrine
// anterior enquanto ela for útil para comparar.
app.get('/nova', (req, res) => res.redirect(301, '/'));
app.get('/antiga', (req, res) => res.sendFile(LANDING_ANTIGA));

// CHECKOUT DA ASSINATURA: quem compra antes de ter conta entra por aqui.
app.get('/assinar', (req, res) => res.sendFile(path.join(__dirname, 'public', 'assinar.html')));

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

// Desligar direito: grava o que está pendente e fecha a conexão. Sem isto, um
// deploy no meio de uma escrita deixaria a última mudança só na memória.
function desligar(sinal) {
  return async () => {
    console.log('\n[' + sinal + '] encerrando, gravando o banco…');
    try { await db.close(); } catch (e) { console.error(e.message); }
    process.exit(0);
  };
}
process.on('SIGINT', desligar('SIGINT'));
process.on('SIGTERM', desligar('SIGTERM'));

pronto.then(() => app.listen(PORT, () => {
  const p = db.get().platform;
  console.log('==============================================');
  console.log(`  Koonfy rodando em http://localhost:${PORT}`);
  console.log(`  Site (marketing):    http://localhost:${PORT}/`);
  console.log(`  Painel:              http://localhost:${PORT}/app`);
  console.log(`  Webhook Meta:        POST/GET /webhook`);
  console.log(`  Verify Token:        ${p.verifyToken}`);
  console.log(`  Graph API:           ${p.graphVersion}`);
  console.log(`  Banco:               ${db.storage.nome}`);
  console.log('==============================================');
  // Em host de container (DigitalOcean App Platform, Railway, Render, Heroku)
  // o disco é recriado a cada deploy e a cada restart: o db.json volta ao
  // estado da imagem e TODO o cadastro some. O sintoma é o app "esquecer"
  // tudo sempre que reinicia, inclusive a senha do admin, que volta ao padrão.
  if (db.storage.efemero()) {
    console.warn('');
    console.warn('  !!  ATENÇÃO: disco efêmero + banco em arquivo  !!');
    console.warn('  Este host recria o disco a cada deploy/restart, então tudo');
    console.warn('  que for gravado em data/db.json se perde no próximo restart.');
    console.warn('  Use um banco de verdade:');
    console.warn('    DB_DRIVER=mysql  DATABASE_URL=mysql://user:senha@host:3306/koonfy');
    console.warn('  Detalhes em docs/mysql.md e DEPLOY.md.');
    console.warn('');
  }
})).catch(e => {
  console.error('Falha ao carregar o banco:', e.message);
  process.exit(1);
});
