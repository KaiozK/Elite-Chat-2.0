// ============================================================================
// TRACKING — atribuição de vendas + métricas de marketing (estilo UTMify).
//
// Multi-tenant por construção: TUDO vive dentro de acc.trk (workspace próprio,
// nada compartilhado entre contas). Integra com o Pagamentos: cada pagamento é
// atribuído à campanha de origem e reenviado às plataformas de anúncio.
// ============================================================================
const https = require('https');
const crypto = require('crypto');
const db = require('./db');

// ---------------------------------------------------------------------------
// Conexões suportadas (o usuário liga/desliga e informa o ID/token de cada uma)
// ---------------------------------------------------------------------------
// `mode` diz COMO a conexão entrega o evento, e isso muda o que ela exige:
//   'server' → o Koonfy chama a API do destino pelo servidor. Precisa de
//              token. Não morre em bloqueador de anúncio.
//   'client' → é uma tag de navegador, injetada nas páginas públicas (link
//              rastreável e checkout). Só precisa do ID, nunca de token.
const CONNECTIONS = [
  { key: 'meta_capi',   label: 'Meta Conversions API',  idLabel: 'Pixel ID', tokenLabel: 'Token CAPI', mode: 'server' },
  { key: 'ga4',         label: 'Google Analytics 4',    idLabel: 'Measurement ID (G-…)', tokenLabel: 'API Secret', mode: 'server' },
  { key: 'tiktok',      label: 'TikTok Events API',     idLabel: 'Pixel ID', tokenLabel: 'Access Token (Events API)', mode: 'server' },
  { key: 'meta_pixel',  label: 'Meta Pixel',            idLabel: 'Pixel ID', mode: 'client' },
  { key: 'google_ads',  label: 'Google Ads',            idLabel: 'ID de conversão (AW-…)', mode: 'client' },
  { key: 'gtm',         label: 'Google Tag Manager',    idLabel: 'Container (GTM-…)', mode: 'client' },
  { key: 'linkedin',    label: 'LinkedIn Insight',      idLabel: 'Partner ID', mode: 'client' },
  { key: 'microsoft',   label: 'Microsoft Ads (UET)',   idLabel: 'UET Tag ID', mode: 'client' },
  { key: 'snapchat',    label: 'Snapchat Pixel',        idLabel: 'Pixel ID', mode: 'client' },
  { key: 'pinterest',   label: 'Pinterest Tag',         idLabel: 'Tag ID', mode: 'client' }
];

// Tags de navegador das conexões ligadas, prontas para injetar no <head> das
// páginas públicas. Antes esses 7 destinos aceitavam o ID e não faziam nada.
function clientTags(acc, ctx) {
  const t = ensure(acc);
  // IDs de pixel são alfanuméricos. Filtrar aqui evita que um valor com
  // "</script>" feche a tag e injete HTML na página pública do lojista:
  // JSON.stringify escapa aspas, mas NÃO escapa </script>.
  const limpo = v => String(v || '').replace(/[^\w.:-]/g, '').slice(0, 64);
  const on = k => { const c = t.connections[k]; return c && c.enabled && c.id ? limpo(c.id) : ''; };
  const j = v => JSON.stringify(String(v)).replace(/</g, '\\u003c');
  const ev = limpo((ctx && ctx.event) || 'PageView') || 'PageView';
  const out = [];

  const gtm = on('gtm');
  if (gtm) out.push(`<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${j(gtm)});</script>`);

  const px = on('meta_pixel');
  if (px) out.push(`<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${j(px)});fbq('track',${j(ev)});</script>`);

  const aw = on('google_ads');
  if (aw) out.push(`<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(aw)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config',${j(aw)});</script>`);

  const li = on('linkedin');
  if (li) out.push(`<script>_linkedin_partner_id=${j(li)};window._linkedin_data_partner_ids=window._linkedin_data_partner_ids||[];window._linkedin_data_partner_ids.push(_linkedin_partner_id);</script><script async src="https://snap.licdn.com/li.lms-analytics/insight.min.js"></script>`);

  const uet = on('microsoft');
  if (uet) out.push(`<script>(function(w,d,t,r,u){var f,n,i;w[u]=w[u]||[],f=function(){var o={ti:${j(uet)}};o.q=w[u],w[u]=new UET(o),w[u].push("pageLoad")},n=d.createElement(t),n.src=r,n.async=1,n.onload=n.onreadystatechange=function(){var s=this.readyState;s&&s!=="loaded"&&s!=="complete"||(f(),n.onload=n.onreadystatechange=null)},i=d.getElementsByTagName(t)[0],i.parentNode.insertBefore(n,i)})(window,document,"script","//bat.bing.com/bat.js","uetq");</script>`);

  const sc = on('snapchat');
  if (sc) out.push(`<script>(function(e,t,n){if(e.snaptr)return;var a=e.snaptr=function(){a.handleRequest?a.handleRequest.apply(a,arguments):a.queue.push(arguments)};a.queue=[];var s='script',r=t.createElement(s);r.async=!0;r.src=n;var u=t.getElementsByTagName(s)[0];u.parentNode.insertBefore(r,u)})(window,document,'https://sc-static.net/scevent.min.js');snaptr('init',${j(sc)});snaptr('track','PAGE_VIEW');</script>`);

  const pin = on('pinterest');
  if (pin) out.push(`<script>!function(e){if(!window.pintrk){window.pintrk=function(){window.pintrk.queue.push(Array.prototype.slice.call(arguments))};var n=window.pintrk;n.queue=[],n.version="3.0";var t=document.createElement("script");t.async=!0,t.src=e;var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r)}}("https://s.pinimg.com/ct/core.js");pintrk('load',${j(pin)});pintrk('page');</script>`);

  return out.join('\n');
}

function ensure(acc) {
  if (!acc.trk) {
    acc.trk = {
      connections: {},          // key → { enabled, id, token, lastSync, recv, sent, errors, lastError }
      sessions: [],             // { sid, ts, last, fbclid, gclid, ttclid, utm{}, waId, email, doc, events }
      events: [],               // { id, ts, name, source, pixel, sid, status, payload }
      meta: { token: '', adAccountId: '', lastSync: null, error: '', campaigns: [] },
      alerts: { cfg: { roasMin: 1.5, cpaMax: 0 }, seen: {} }
    };
  }
  const t = acc.trk;
  for (const c of CONNECTIONS) {
    if (!t.connections[c.key]) t.connections[c.key] = { enabled: false, id: '', token: '', lastSync: null, recv: 0, sent: 0, errors: 0, lastError: '' };
  }
  return t;
}

function log(acc, entry) {
  const t = ensure(acc);
  t.events.unshift({ id: db.genId('tev'), ts: Date.now(), status: 'ok', ...entry });
  if (t.events.length > 1500) t.events.length = 1500;
}

// ---------------------------------------------------------------------------
// CAPTURA — sessões e eventos (vindos do checkout /pay e do snippet /t.js)
// ---------------------------------------------------------------------------
function upsertSession(acc, d) {
  const t = ensure(acc);
  const sid = String(d.sid || '').slice(0, 64);
  if (!sid) return null;
  let s = t.sessions.find(x => x.sid === sid);
  if (!s) {
    s = { sid, ts: Date.now(), last: Date.now(), fbclid: '', gclid: '', ttclid: '', utm: {}, waId: '', email: '', doc: '', events: 0 };
    t.sessions.unshift(s);
    if (t.sessions.length > 2000) t.sessions.length = 2000;
  }
  s.last = Date.now();
  for (const k of ['fbclid', 'gclid', 'ttclid']) if (d[k]) s[k] = String(d[k]).slice(0, 200);
  if (d.utm) for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
    if (d.utm[k]) { s.utm = s.utm || {}; s.utm[k] = String(d.utm[k]).slice(0, 120); }
  }
  for (const k of ['waId', 'email', 'doc']) if (d[k] && !s[k]) s[k] = String(d[k]).slice(0, 140);
  return s;
}

// Evento recebido (PageView, InitiateCheckout, Purchase, custom…)
function trackEvent(acc, d) {
  const t = ensure(acc);
  const s = d.sid ? upsertSession(acc, d) : null;
  if (s) s.events++;
  const name = String(d.name || 'Event').slice(0, 60);
  log(acc, {
    name, source: String(d.source || 'site').slice(0, 40), sid: s ? s.sid : '',
    pixel: String(d.pixel || '').slice(0, 60),
    payload: { url: String(d.url || '').slice(0, 300), utm: s ? s.utm : (d.utm || {}), value: d.value || 0 }
  });
  // contadores por conexão (eventos recebidos)
  const conn = t.connections.meta_pixel;
  if (conn) conn.recv++;
  db.save();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ATRIBUIÇÃO — encontra a campanha que originou a venda (ordem de prioridade)
//   fbclid → gclid → ttclid → sessão c/ UTM → UTM direta → telefone → email → CPF
// ---------------------------------------------------------------------------
function attribute(acc, ch) {
  const t = ensure(acc);
  const direct = ch.trk || {};                                   // capturado na página do checkout
  const bySid = direct.sid ? t.sessions.find(s => s.sid === direct.sid) : null;
  const payer = ch.payer || {};
  const byPhone = payer.phone ? t.sessions.find(s => s.waId === payer.phone) : null;
  const byEmail = payer.email ? t.sessions.find(s => s.email === payer.email) : null;
  const byDoc = payer.taxID ? t.sessions.find(s => s.doc === payer.taxID) : null;

  const pick = (method, src) => {
    if (!src) return null;
    const utm = src.utm || {};
    return {
      method,
      clickId: src.fbclid || src.gclid || src.ttclid || '',
      network: src.fbclid ? 'meta' : src.gclid ? 'google' : src.ttclid ? 'tiktok' : (utm.source || ''),
      source: utm.source || (src.fbclid ? 'facebook' : src.gclid ? 'google' : src.ttclid ? 'tiktok' : ''),
      medium: utm.medium || '', campaign: utm.campaign || '', content: utm.content || '', term: utm.term || '',
      sid: src.sid || direct.sid || '', at: Date.now()
    };
  };

  // prioridade
  if (direct.fbclid) return pick('fbclid', { ...direct, ...((bySid || {})) , fbclid: direct.fbclid });
  if (bySid && bySid.fbclid) return pick('fbclid', bySid);
  if (direct.gclid) return pick('gclid', { ...(bySid || {}), ...direct });
  if (bySid && bySid.gclid) return pick('gclid', bySid);
  if (direct.ttclid) return pick('ttclid', { ...(bySid || {}), ...direct });
  if (bySid && bySid.ttclid) return pick('ttclid', bySid);
  if (bySid && bySid.utm && (bySid.utm.campaign || bySid.utm.source)) return pick('session', bySid);
  if (direct.utm && (direct.utm.campaign || direct.utm.source)) return pick('utm', direct);
  if (byPhone) return pick('phone', byPhone);
  if (byEmail) return pick('email', byEmail);
  if (byDoc) return pick('cpf', byDoc);
  return null;
}

// ---------------------------------------------------------------------------
// PAGAMENTO CONFIRMADO — atribui + reenvia a conversão às plataformas
// ---------------------------------------------------------------------------
function sha256(v) { return crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex'); }

function post(host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ host, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...(headers || {}) } }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { try { const j = JSON.parse(out || '{}'); (res.statusCode < 300) ? resolve(j) : reject(new Error(j.error && j.error.message || j.message || ('HTTP ' + res.statusCode))); } catch { (res.statusCode < 300) ? resolve({}) : reject(new Error('HTTP ' + res.statusCode)); } });
    });
    req.on('error', reject); req.setTimeout(12000, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

function get(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, method: 'GET' }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { try { const j = JSON.parse(out || '{}'); (res.statusCode < 300) ? resolve(j) : reject(new Error(j.error && j.error.message || ('HTTP ' + res.statusCode))); } catch { reject(new Error('HTTP ' + res.statusCode)); } });
    });
    req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function sendConversions(acc, ch) {
  const t = ensure(acc);
  const payer = ch.payer || {};
  const results = [];
  const mark = (key, ok, err) => {
    const c = t.connections[key]; if (!c) return;
    if (ok) { c.sent++; c.lastSync = Date.now(); } else { c.errors++; c.lastError = String(err || '').slice(0, 200); }
    results.push({ key, ok, err: err ? String(err).slice(0, 120) : '' });
  };

  // Meta Conversions API (server-side)
  const capi = t.connections.meta_capi;
  const capiPixel = (capi && capi.enabled && capi.id && capi.token) ? capi
    : (acc.pixels || []).filter(p => p.type === 'meta' && p.capiToken).map(p => ({ id: p.pixelId, token: p.capiToken }))[0];
  if (capiPixel) {
    try {
      await post('graph.facebook.com', `/${db.get().platform.graphVersion || 'v26.0'}/${encodeURIComponent(capiPixel.id)}/events?access_token=${encodeURIComponent(capiPixel.token)}`, {
        data: [{
          event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000),
          action_source: 'website', event_id: ch.id,
          user_data: {
            ph: payer.phone ? [sha256(payer.phone)] : undefined,
            em: payer.email ? [sha256(payer.email)] : undefined,
            external_id: payer.taxID ? [sha256(payer.taxID)] : undefined,
            fbc: (ch.attribution && ch.attribution.clickId && ch.attribution.method === 'fbclid') ? `fb.1.${Date.now()}.${ch.attribution.clickId}` : undefined
          },
          custom_data: { currency: 'BRL', value: ch.value / 100, content_name: ch.comment || 'Pagamento Pix' }
        }]
      });
      mark('meta_capi', true);
    } catch (e) { mark('meta_capi', false, e.message); }
  }

  // GA4 Measurement Protocol (purchase), usado tb p/ conversões do Google Ads via GA4
  //
  // LIMITAÇÃO DO GOOGLE, verificada na prática: o /mp/collect responde 204 e o
  // /debug/mp/collect responde validationMessages VAZIO mesmo com api_secret
  // errado ou measurement_id inexistente. Ou seja, o Google não confirma
  // entrega nem valida credencial por API. O /debug só pega payload malformado.
  // Então: usamos o debug para garantir que o evento está bem formado (isso ele
  // pega), mas marcamos a conexão como "não confirmável" para o painel não
  // vender certeza que não existe. A conferência real é no GA4 → Tempo real.
  const ga4 = t.connections.ga4;
  if (ga4 && ga4.enabled && ga4.id && ga4.token) {
    const corpo = {
      client_id: (ch.trk && ch.trk.sid) || ch.id,
      events: [{ name: 'purchase', params: { currency: 'BRL', value: ch.value / 100, transaction_id: ch.id } }]
    };
    const qs = `measurement_id=${encodeURIComponent(ga4.id)}&api_secret=${encodeURIComponent(ga4.token)}`;
    try {
      const dbg = await post('www.google-analytics.com', `/debug/mp/collect?${qs}`, corpo);
      const msgs = (dbg && dbg.validationMessages) || [];
      if (msgs.length) throw new Error(msgs.map(m => m.description || m.validationCode).join(' · '));
      await post('www.google-analytics.com', `/mp/collect?${qs}`, corpo);
      mark('ga4', true);
      ga4.unverified = true;   // o painel avisa que o GA4 não devolve confirmação
    } catch (e) { mark('ga4', false, e.message); }
  }

  // TikTok Events API
  const tk = t.connections.tiktok;
  if (tk && tk.enabled && tk.id && tk.token) {
    try {
      await post('business-api.tiktok.com', '/open_api/v1.3/event/track/', {
        event_source: 'web', event_source_id: tk.id,
        data: [{ event: 'CompletePayment', event_time: Math.floor(Date.now() / 1000), event_id: ch.id,
          user: { phone: payer.phone ? sha256('+' + payer.phone) : undefined, email: payer.email ? sha256(payer.email) : undefined, ttclid: (ch.attribution && ch.attribution.method === 'ttclid') ? ch.attribution.clickId : undefined },
          properties: { currency: 'BRL', value: ch.value / 100 } }]
      }, { 'Access-Token': tk.token });
      mark('tiktok', true);
    } catch (e) { mark('tiktok', false, e.message); }
  }
  db.save();
  return results;
}

// Chamado pelo Pagamentos quando o webhook confirma o pagamento
function onPaid(acc, ch, broadcast) {
  const t = ensure(acc);
  ch.attribution = attribute(acc, ch);
  log(acc, {
    name: 'Purchase', source: 'koonpay', sid: (ch.attribution && ch.attribution.sid) || '',
    pixel: '', payload: { value: ch.value / 100, campaign: ch.attribution ? ch.attribution.campaign : '', method: ch.attribution ? ch.attribution.method : 'sem origem' }
  });
  db.save();
  // envio automático (não bloqueia a confirmação)
  sendConversions(acc, ch).catch(() => {});
  if (broadcast) broadcast('tracking', { accountId: acc.id, kind: 'purchase', chargeId: ch.id, attributed: !!ch.attribution });
}

// ---------------------------------------------------------------------------
// META ADS — leitura automática de campanhas/gasto pela Marketing API
// ---------------------------------------------------------------------------
async function syncMetaAds(acc) {
  const t = ensure(acc);
  const m = t.meta;
  if (!m.token || !m.adAccountId) {
    const e = new Error('Conecte sua conta Meta Ads primeiro'); e.status = 400; throw e;
  }
  const actId = m.adAccountId.startsWith('act_') ? m.adAccountId : 'act_' + m.adAccountId;
  const fields = 'campaign_id,campaign_name,spend,impressions,clicks,ctr,cpm,cpc,frequency,actions';
  const ver = (db.get().platform.graphVersion || 'v26.0');   // acompanha a versão do painel
  const preset = m.preset || 'last_30d';

  try {
    // PAGINAÇÃO: uma conta com muitas campanhas volta em páginas. Sem seguir o
    // cursor, o gasto ficaria subestimado e o ROAS sairia inflado.
    let path = `/${ver}/${encodeURIComponent(actId)}/insights?level=campaign&date_preset=${encodeURIComponent(preset)}`
      + `&fields=${fields}&limit=100&access_token=${encodeURIComponent(m.token)}`;
    const linhas = [];
    for (let pagina = 0; pagina < 20 && path; pagina++) {
      const d = await get('graph.facebook.com', path);
      linhas.push(...(d.data || []));
      const prox = d.paging && d.paging.next;
      path = prox ? prox.replace(/^https:\/\/graph\.facebook\.com/, '') : '';
    }

    m.campaigns = linhas.map(c => ({
      id: c.campaign_id, name: c.campaign_name,
      spend: Math.round(parseFloat(c.spend || 0) * 100),          // centavos
      impressions: +c.impressions || 0, clicks: +c.clicks || 0,
      ctr: parseFloat(c.ctr || 0), cpm: Math.round(parseFloat(c.cpm || 0) * 100), cpc: Math.round(parseFloat(c.cpc || 0) * 100),
      frequency: parseFloat(c.frequency || 0),
      results: (c.actions || []).reduce((s, a) => s + (+a.value || 0), 0)
    }));
    m.lastSync = Date.now(); m.error = ''; m.expired = false;
  } catch (e) {
    const msg = String(e.message || e);
    // Token vencido/revogado tem tratamento próprio: o cliente precisa
    // reconectar, e dizer "erro na API" não ajudaria em nada.
    if (/expired|session has been invalidated|OAuth|access token/i.test(msg)) {
      m.expired = true;
      m.error = 'Sessão da Meta expirou. Clique em Conectar Meta Ads para reautorizar.';
    } else if (/\(#(10|200|294)\)|permission/i.test(msg)) {
      m.error = 'O app não tem permissão ads_read nesta conta de anúncios.';
    } else {
      m.error = msg.slice(0, 200);
    }
    m.lastSync = Date.now();
    db.save();
    const err = new Error('Meta Ads: ' + m.error); err.status = 400; throw err;
  }
  db.save();
  return m;
}

function adSpend(acc) {
  const t = ensure(acc);
  return (t.meta.campaigns || []).reduce((s, c) => s + (c.spend || 0), 0);
}
function adClicks(acc) {
  const t = ensure(acc);
  return (t.meta.campaigns || []).reduce((s, c) => s + (c.clicks || 0), 0);
}

// ---------------------------------------------------------------------------
// MÉTRICAS — dashboard financeiro/marketing calculado dos dados reais
// ---------------------------------------------------------------------------
function charges(acc) { return (acc.pagamentos && acc.pagamentos.charges) || []; }
function paidIn(acc, from, to) { return charges(acc).filter(c => c.status === 'paid' && c.paidAt >= from && (!to || c.paidAt < to)); }
const sum = a => a.reduce((s, c) => s + c.value, 0);

// Série diária dos últimos N dias, para os gráficos do Tracking.
//
// Só entra aqui o que existe por DIA de verdade: receita e pedidos saem do
// carimbo de cada cobrança, cliques saem do carimbo de cada clique. O gasto
// com anúncio fica de fora de propósito — a Meta devolve o total do período,
// não o dia a dia, e desenhar uma curva a partir de um total só seria inventar
// um formato que o dado não tem.
function serieDiaria(acc, dias = 30) {
  const t = ensure(acc);
  const day = 86400000;
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const inicio = d0.getTime() - (dias - 1) * day;
  const balde = [];
  for (let i = 0; i < dias; i++) {
    const ini = inicio + i * day;
    balde.push({ date: new Date(ini).toISOString().slice(0, 10), ini, fim: ini + day,
      receita: 0, aprovados: 0, criados: 0, cliques: 0 });
  }
  const posicao = (ts) => {
    if (!ts || ts < inicio) return -1;
    const i = Math.floor((ts - inicio) / day);
    return i >= 0 && i < dias ? i : -1;
  };
  for (const c of charges(acc)) {
    const iCriada = posicao(c.createdAt);
    if (iCriada >= 0) balde[iCriada].criados++;
    if (c.status === 'paid') {
      const iPaga = posicao(c.paidAt);
      if (iPaga >= 0) { balde[iPaga].aprovados++; balde[iPaga].receita += c.value; }
    }
  }
  for (const l of (acc.links || [])) {
    for (const k of (l.clicks || [])) { const i = posicao(k.ts); if (i >= 0) balde[i].cliques++; }
  }
  for (const e of (t.events || [])) {
    if (e.name !== 'LinkClick') continue;
    const i = posicao(e.ts); if (i >= 0) balde[i].cliques++;
  }
  return balde.map(({ ini, fim, ...resto }) => resto);
}

function dashboard(acc) {
  const t = ensure(acc);
  const now = Date.now();
  const day = 86400000;
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const today0 = d0.getTime();

  const all = charges(acc);
  const paid = all.filter(c => c.status === 'paid');
  const paid30 = paidIn(acc, now - 30 * day);
  const rev30 = sum(paid30);
  const spend = adSpend(acc);                                    // últimos 30d (sync Meta)
  const fees = paid30.reduce((s, c) => s + (c.platformCut || 0), 0);
  const clicks = adClicks(acc) + (acc.links || []).reduce((s, l) => s + ((l.clicks || []).filter(k => k.ts >= now - 30 * day).length), 0);
  const checkouts = t.events.filter(e => e.name === 'InitiateCheckout' && e.ts >= now - 30 * day).length || all.filter(c => c.createdAt >= now - 30 * day).length;
  const customers = [...new Set(paid.map(c => c.waId || (c.payer && c.payer.phone) || c.id))];
  const refunds = all.filter(c => c.status === 'refunded');
  const chargebacks = all.filter(c => c.status === 'chargeback');
  const lucro = rev30 - spend;
  const lucroLiq = rev30 - spend - fees - sum(refunds) - sum(chargebacks);

  return {
    receita: { total: sum(paid), hoje: sum(paidIn(acc, today0)), ontem: sum(paidIn(acc, today0 - day, today0)), d7: sum(paidIn(acc, now - 7 * day)), d30: rev30 },
    pedidos: {
      total: all.length, aprovados: paid.length, pendentes: all.filter(c => c.status === 'active').length,
      recusados: all.filter(c => c.status === 'cancelled' || c.status === 'expired').length
    },
    serie: serieDiaria(acc, 30),
    ticketMedio: paid.length ? Math.round(sum(paid) / paid.length) : 0,
    gastoAnuncios: spend,
    lucro, roi: spend ? +( (lucro / spend) * 100 ).toFixed(1) : null,
    roas: spend ? +(rev30 / spend).toFixed(2) : null,
    cpa: paid30.length && spend ? Math.round(spend / paid30.length) : null,
    cac: customers.length && spend ? Math.round(spend / customers.length) : null,
    ltv: customers.length ? Math.round(sum(paid) / customers.length) : 0,
    margem: rev30 ? +((lucroLiq / rev30) * 100).toFixed(1) : null,
    conversao: checkouts ? +((paid30.length / checkouts) * 100).toFixed(1) : null,
    epc: clicks ? Math.round(rev30 / clicks) : null,
    rpc: clicks ? Math.round(rev30 / clicks) : null,
    aov: paid30.length ? Math.round(rev30 / paid30.length) : 0,
    refund: { qtd: refunds.length, valor: sum(refunds) },
    chargeback: { qtd: chargebacks.length, valor: sum(chargebacks) },
    roiLiquido: spend ? +((lucroLiq / spend) * 100).toFixed(1) : null,
    roasLiquido: spend ? +(( (rev30 - fees) / spend )).toFixed(2) : null,
    taxas: fees
  };
}

// Relatório por campanha (gasto Meta × receita atribuída)
function campaignReport(acc) {
  const t = ensure(acc);
  const paid = charges(acc).filter(c => c.status === 'paid');
  const rows = {};
  const rowOf = name => rows[name] = rows[name] || { nome: name, gasto: 0, receita: 0, pedidos: 0, clicks: 0, impressoes: 0, refund: 0, chargeback: 0, produtos: {} };

  for (const c of (t.meta.campaigns || [])) {
    const r = rowOf(c.name);
    r.gasto += c.spend; r.clicks += c.clicks; r.impressoes += c.impressions;
  }
  for (const ch of paid) {
    const name = (ch.attribution && (ch.attribution.campaign || ch.attribution.source)) || 'Sem atribuição';
    const r = rowOf(name);
    r.receita += ch.value; r.pedidos++;
    const prod = ch.comment || 'Pagamento Pix';
    r.produtos[prod] = (r.produtos[prod] || 0) + 1;
  }
  for (const ch of charges(acc)) {
    const name = (ch.attribution && (ch.attribution.campaign || ch.attribution.source)) || 'Sem atribuição';
    if (ch.status === 'refunded') rowOf(name).refund += ch.value;
    if (ch.status === 'chargeback') rowOf(name).chargeback += ch.value;
  }
  return Object.values(rows).map(r => ({
    ...r,
    lucro: r.receita - r.gasto,
    roas: r.gasto ? +(r.receita / r.gasto).toFixed(2) : null,
    roi: r.gasto ? +(((r.receita - r.gasto) / r.gasto) * 100).toFixed(1) : null,
    conversao: r.clicks ? +((r.pedidos / r.clicks) * 100).toFixed(2) : null,
    cpa: r.pedidos && r.gasto ? Math.round(r.gasto / r.pedidos) : null,
    cac: r.pedidos && r.gasto ? Math.round(r.gasto / r.pedidos) : null,
    ticket: r.pedidos ? Math.round(r.receita / r.pedidos) : 0,
    produtos: Object.entries(r.produtos).map(([n, q]) => `${n} (${q})`).slice(0, 4)
  })).sort((a, b) => b.receita - a.receita);
}

// Funil: clique → visita → lead → checkout → pagamento → upsell → downsell → recompra
function funnel(acc) {
  const t = ensure(acc);
  const now = Date.now(), d30 = now - 30 * 86400000;
  const ev = n => t.events.filter(e => e.name === n && e.ts >= d30).length;
  const all = charges(acc);
  const paid = all.filter(c => c.status === 'paid' && c.paidAt >= d30);
  const clicks = adClicks(acc) + (acc.links || []).reduce((s, l) => s + ((l.clicks || []).filter(k => k.ts >= d30).length), 0);
  const visitas = ev('PageView') || clicks;
  const leads = (acc.contacts || []).filter(c => c.createdAt >= d30).length + ev('Lead');
  const checkouts = ev('InitiateCheckout') || all.filter(c => c.createdAt >= d30).length;
  const byCustomer = {};
  for (const c of charges(acc).filter(x => x.status === 'paid')) {
    const k = c.waId || (c.payer && c.payer.phone) || c.id;
    byCustomer[k] = (byCustomer[k] || 0) + 1;
  }
  const recompra = Object.values(byCustomer).filter(n => n > 1).length;
  const steps = [
    { nome: 'Clique', qtd: clicks }, { nome: 'Visita', qtd: visitas }, { nome: 'Lead', qtd: leads },
    { nome: 'Checkout', qtd: checkouts }, { nome: 'Pagamento', qtd: paid.length },
    { nome: 'Upsell', qtd: ev('Upsell') }, { nome: 'Downsell', qtd: ev('Downsell') }, { nome: 'Recompra', qtd: recompra }
  ];
  return steps.map((s, i) => ({ ...s, taxa: i && steps[i - 1].qtd ? +((s.qtd / steps[i - 1].qtd) * 100).toFixed(1) : null }));
}

// Comparativos por período (receita/pedidos/lucro/roas/roi/conversão)
function compare(acc) {
  const now = Date.now(), day = 86400000;
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const spendDaily = adSpend(acc) / 30;                          // distribuição diária do gasto sincronizado
  const range = (from, to, dias) => {
    const paid = paidIn(acc, from, to);
    const rev = sum(paid);
    const spend = Math.round(spendDaily * dias);
    const all = charges(acc).filter(c => c.createdAt >= from && (!to || c.createdAt < to));
    return {
      receita: rev, pedidos: paid.length, lucro: rev - spend,
      roas: spend ? +(rev / spend).toFixed(2) : null,
      roi: spend ? +(((rev - spend) / spend) * 100).toFixed(1) : null,
      conversao: all.length ? +((paid.length / all.length) * 100).toFixed(1) : null
    };
  };
  const y0 = new Date(); y0.setMonth(0, 1); y0.setHours(0, 0, 0, 0);
  return {
    hoje: range(d0.getTime(), null, 1),
    ontem: range(d0.getTime() - day, d0.getTime(), 1),
    d7: range(now - 7 * day, null, 7),
    d30: range(now - 30 * day, null, 30),
    d90: range(now - 90 * day, null, 30),                        // gasto conhecido = 30d
    ano: range(y0.getTime(), null, 30)
  };
}

// Timeline do cliente (jornada completa)
function customerTimeline(acc, waId) {
  const t = ensure(acc);
  const contact = (acc.contacts || []).find(c => c.waId === waId);
  const chs = charges(acc).filter(c => c.waId === waId || (c.payer && c.payer.phone === waId));
  const paid = chs.filter(c => c.status === 'paid');
  const sessions = t.sessions.filter(s => s.waId === waId);
  const first = sessions.length ? Math.min(...sessions.map(s => s.ts)) : (contact ? contact.createdAt : null);
  const attr = paid.map(c => c.attribution).find(Boolean) || (sessions[0] && (sessions[0].utm.campaign || sessions[0].fbclid) ? { campaign: sessions[0].utm.campaign, source: sessions[0].utm.source, method: 'session' } : null);
  const msgs = (acc.messages || []).filter(m => m.waId === waId);
  return {
    contato: contact ? { nome: contact.name, etapa: contact.stage, tags: contact.tags, origem: contact.source || null } : null,
    atribuicao: attr,
    utms: sessions[0] ? sessions[0].utm : {},
    primeiraVisita: first, ultimaVisita: sessions.length ? Math.max(...sessions.map(s => s.last)) : null,
    eventos: t.events.filter(e => sessions.some(s => s.sid === e.sid)).slice(0, 40),
    mensagens: { enviadas: msgs.filter(m => m.direction === 'out').length, recebidas: msgs.filter(m => m.direction === 'in').length },
    pagamentos: chs.map(c => ({ id: c.id, status: c.status, valor: c.value, produto: c.comment, quando: c.paidAt || c.createdAt, campanha: c.attribution ? c.attribution.campaign : '' })),
    reembolsos: chs.filter(c => c.status === 'refunded').length,
    chargebacks: chs.filter(c => c.status === 'chargeback').length,
    totalGasto: sum(paid), ltv: sum(paid)
  };
}

// ---------------------------------------------------------------------------
// ALERTAS INTELIGENTES — avaliados sobre os dados reais
// ---------------------------------------------------------------------------
function alerts(acc) {
  const t = ensure(acc);
  const d = dashboard(acc);
  const now = Date.now();
  const out = [];
  const cfg = t.alerts.cfg;
  if (d.roas !== null && d.roas < (cfg.roasMin || 1.5)) out.push({ level: 'warn', icon: 'activity', title: `ROAS abaixo do mínimo (${d.roas} < ${cfg.roasMin})`, text: 'A receita atribuída não está cobrindo o gasto configurado como aceitável.' });
  if (cfg.cpaMax && d.cpa !== null && d.cpa > cfg.cpaMax * 100) out.push({ level: 'warn', icon: 'zap', title: 'CPA acima do limite', text: `Custo por aquisição atual: R$ ${(d.cpa / 100).toFixed(2)}.` });
  const lastPaid = charges(acc).filter(c => c.status === 'paid').map(c => c.paidAt);
  const spend = adSpend(acc);
  if (spend > 0 && lastPaid.length && Math.max(...lastPaid) < now - 3 * 86400000) out.push({ level: 'warn', icon: 'slash', title: 'Campanhas gastando sem vender', text: 'Há gasto de anúncios sincronizado, mas nenhuma venda nos últimos 3 dias.' });
  const lastEv = t.events[0];
  if (t.connections.meta_pixel.enabled && (!lastEv || lastEv.ts < now - 2 * 86400000)) out.push({ level: 'warn', icon: 'shield', title: 'Pixel sem receber eventos', text: 'Nenhum evento chegou nas últimas 48h, verifique a instalação do pixel.' });
  const semOrigem = charges(acc).filter(c => c.status === 'paid' && c.paidAt >= now - 7 * 86400000 && !c.attribution).length;
  if (semOrigem) out.push({ level: 'info', icon: 'help', title: `${semOrigem} venda(s) sem origem identificada`, text: 'Pagamentos confirmados sem clique/UTM/sessão associados nos últimos 7 dias.' });
  const prev = compare(acc);
  if (prev.d7.conversao !== null && prev.d30.conversao !== null && prev.d7.conversao < prev.d30.conversao * 0.6) out.push({ level: 'warn', icon: 'activity', title: 'Queda de conversão', text: `Conversão 7d (${prev.d7.conversao}%) bem abaixo da média 30d (${prev.d30.conversao}%).` });
  if (!out.length) out.push({ level: 'ok', icon: 'check', title: 'Tudo saudável por aqui', text: 'Nenhum alerta ativo, métricas dentro do esperado.' });
  return out;
}

function overview(acc) {
  const t = ensure(acc);
  return {
    connections: CONNECTIONS.map(c => ({ ...c, ...t.connections[c.key], token: t.connections[c.key].token ? '••••' : '' })),
    meta: {
      adAccountId: t.meta.adAccountId, hasToken: !!t.meta.token,
      lastSync: t.meta.lastSync, error: t.meta.error, campaigns: t.meta.campaigns.length,
      expiresAt: t.meta.expiresAt || 0, expired: !!t.meta.expired,
      adAccounts: t.meta.adAccounts || [],
      // o admin já configurou o app da Meta? (senão, o botão nem deve tentar)
      available: (() => { try { return require('./meta').adsConfigured(); } catch { return false; } })()
    },
    alertsCfg: t.alerts.cfg,
    // A aba do Modo Bet só é desenhada quando existe. Quem decide é o segmento
    // da conta, e a tela pergunta em vez de adivinhar.
    bet: { disponivel: require('./segmentos').ehIGaming(acc) },
    dashboard: dashboard(acc),
    alerts: alerts(acc),
    eventsCount: t.events.length, sessionsCount: t.sessions.length
  };
}

module.exports = {
  CONNECTIONS, clientTags, ensure, upsertSession, trackEvent, attribute, onPaid, sendConversions,
  adSpend,
  syncMetaAds, dashboard, campaignReport, funnel, compare, customerTimeline, alerts, overview
};
