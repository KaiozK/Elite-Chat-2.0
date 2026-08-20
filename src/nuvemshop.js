// Integração com a Nuvemshop / Tiendanube (aba Integrações).
//
// Fluxo: o lojista cria um app no Portal de Parceiros da Nuvemshop, cola aqui o
// App ID + Secret, e clica em "Conectar loja". Isso abre o consentimento OAuth
// da Nuvemshop; o callback devolve um `code` que trocamos por um access_token
// permanente (a Nuvemshop não expira o token).
//
// Depois de conectada, registramos webhooks na loja (pedido criado/pago/cancelado
// e cliente novo). Cada evento vira contato + variáveis no Koonfy e pode
// disparar automações do Flow Builder — mesma mecânica dos webhooks de entrada.
//
// Docs: https://tiendanube.github.io/api-documentation/
const crypto = require('crypto');
const db = require('./db');
const store = require('./store');

const AUTH_BASE = 'https://www.tiendanube.com/apps';
const API_BASE = 'https://api.nuvemshop.com.br';
const API_VERSION = '2025-03';
const UA = 'Koonfy CRM (suporte@koonfy.com.br)'; // a Nuvemshop exige User-Agent

// Eventos que assinamos na loja do cliente.
//
// A lista é a que a Nuvemshop publica para pedidos e clientes. Assinamos
// todos: o custo de um webhook a mais é zero, e é a automação que escolhe
// qual evento a interessa. Assinar só alguns significaria voltar aqui e
// reconectar a loja toda vez que alguém quisesse um aviso novo.
const EVENTS = [
  { event: 'order/created', label: 'Pedido criado', desc: 'Assim que o pedido é fechado, antes do pagamento' },
  { event: 'order/paid', label: 'Compra aprovada', desc: 'O pagamento foi confirmado' },
  { event: 'order/packed', label: 'Pedido embalado', desc: 'A loja separou e embalou' },
  { event: 'order/fulfilled', label: 'Pedido enviado', desc: 'Saiu para entrega, com código de rastreio quando houver' },
  { event: 'order/cancelled', label: 'Pedido cancelado', desc: 'A loja ou o cliente cancelou' },
  { event: 'order/pending', label: 'Pagamento pendente', desc: 'Boleto ou Pix gerado e ainda não pago' },
  { event: 'order/voided', label: 'Pedido estornado', desc: 'O valor foi devolvido ao cliente' },
  { event: 'order/updated', label: 'Pedido alterado', desc: 'Qualquer mudança no pedido' },
  { event: 'customer/created', label: 'Cliente novo', desc: 'Alguém se cadastrou na loja' }
];

// CARRINHO ABANDONADO não é webhook: a Nuvemshop não publica evento para ele.
// O carrinho vive em `GET /checkouts` e sai de lá quando vira pedido, então
// quem quer saber precisa perguntar de tempos em tempos. Ele entra na lista de
// gatilhos das automações, mas nunca na de webhooks assinados na loja.
const EVENTO_CARRINHO = 'cart/abandoned';
const GATILHOS = EVENTS.concat([{
  event: EVENTO_CARRINHO,
  label: 'Carrinho abandonado',
  desc: 'O cliente encheu o carrinho, chegou no checkout e não terminou'
}]);

// Estado da LOJA conectada (por conta). As credenciais do app são da plataforma.
function empty() {
  return {
    storeId: '', accessToken: '', storeName: '', storeUrl: '',
    scope: '', connectedAt: 0,
    hooks: [],          // [{ id, event }] registrados na loja
    events: 0, lastEventAt: 0, lastEvent: '',
    tags: [],           // tags aplicadas ao contato criado
    autoContact: true,  // criar/atualizar contato a cada evento
    // RECUPERAÇÃO DE CARRINHO. `minutos` é quanto se espera antes de
    // considerar o carrinho abandonado: mandar mensagem no minuto seguinte
    // alcança quem só foi buscar o cartão na carteira.
    carrinho: { ligado: false, minutos: 60 },
    // Carrinhos já avisados, para não mandar duas vezes o mesmo. Guarda id e
    // quando: a lista é podada, senão cresce para sempre.
    carrinhosVistos: [],
    ultimaVarredura: 0
  };
}

function cfg(acc) {
  if (!acc.nuvemshop) acc.nuvemshop = empty();
  else for (const [k, v] of Object.entries(empty())) if (acc.nuvemshop[k] === undefined) acc.nuvemshop[k] = v;
  return acc.nuvemshop;
}

// Credenciais do app da PLATAFORMA (Admin SaaS). O cliente nunca vê nem informa.
function platformCfg() {
  const p = db.get().platform;
  if (!p.nuvemshop) p.nuvemshop = { enabled: false, appId: '', appSecret: '' };
  return p.nuvemshop;
}
// A integração só existe para o cliente se o admin ligou E preencheu o app.
function isAvailable() {
  const p = platformCfg();
  return !!(p.enabled && p.appId && p.appSecret);
}

// Nunca devolve secret nem token para o navegador.
function publicCfg(acc, origin) {
  const c = cfg(acc);
  const p = platformCfg();
  return {
    available: isAvailable(),
    enabled: !!p.enabled,
    connected: !!(c.storeId && c.accessToken),
    storeId: c.storeId, storeName: c.storeName, storeUrl: c.storeUrl,
    scope: c.scope, connectedAt: c.connectedAt,
    hooks: c.hooks, events: c.events, lastEventAt: c.lastEventAt, lastEvent: c.lastEvent,
    tags: c.tags, autoContact: c.autoContact,
    carrinho: c.carrinho, ultimaVarredura: c.ultimaVarredura,
    authorizeUrl: p.appId ? `${AUTH_BASE}/${encodeURIComponent(p.appId)}/authorize` : '',
    webhookUrl: origin ? `${origin}/nuvemshop-webhook` : '',
    availableEvents: EVENTS, gatilhos: GATILHOS
  };
}

// Visão do admin: inclui appId e se o secret está preenchido (nunca o valor).
function adminCfg(origin) {
  const p = platformCfg();
  const lojas = (db.get().accounts || []).filter(a => a.nuvemshop && a.nuvemshop.storeId).length;
  return {
    enabled: !!p.enabled, appId: p.appId, hasSecret: !!p.appSecret,
    available: isAvailable(), lojasConectadas: lojas,
    redirectUri: origin ? `${origin}/auth/nuvemshop/callback` : '',
    webhookUrl: origin ? `${origin}/nuvemshop-webhook` : ''
  };
}

// ---------- OAuth ----------

// Troca o `code` do callback por um access_token permanente.
async function exchangeCode(acc, code) {
  const c = cfg(acc);
  const p = platformCfg();
  if (!isAvailable()) throw new Error('A integração com a Nuvemshop está indisponível no momento');
  const resp = await fetch(`${AUTH_BASE}/authorize/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({
      client_id: String(p.appId),
      client_secret: String(p.appSecret),
      grant_type: 'authorization_code',
      code: String(code)
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'A Nuvemshop recusou a autorização. Confira o App ID/Secret e tente conectar de novo.');
  }
  c.accessToken = data.access_token;
  c.storeId = String(data.user_id || '');
  c.scope = data.scope || '';
  c.connectedAt = Date.now();
  db.save();
  return c;
}

// Chamada autenticada à API da loja.
async function apiFetch(acc, path, opts = {}) {
  const c = cfg(acc);
  if (!c.accessToken || !c.storeId) throw new Error('Nenhuma loja Nuvemshop conectada');
  const url = `${API_BASE}/${API_VERSION}/${c.storeId}${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      'Authentication': `bearer ${c.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': UA,
      ...(opts.headers || {})
    }
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!resp.ok) {
    const msg = (data && (data.description || data.message || data.error)) || `Erro ${resp.status} na API da Nuvemshop`;
    const err = new Error(msg); err.status = resp.status; throw err;
  }
  return data;
}

// Busca os dados da loja para exibir o nome no painel.
async function fetchStore(acc) {
  const c = cfg(acc);
  try {
    const s = await apiFetch(acc, '/store');
    c.storeName = pickLang(s.name) || `Loja ${c.storeId}`;
    c.storeUrl = pickLang(s.url) || '';
    db.save();
  } catch (e) { /* nome é cosmético, não derruba a conexão */ }
  return c;
}

// Campos multilíngues vêm como { pt: "...", es: "..." }.
function pickLang(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return v.pt || v.pt_BR || v.es || v.en || Object.values(v)[0] || '';
}

// ---------- webhooks na loja ----------

// Registra (ou re-registra) os webhooks na loja do cliente, apontando para cá.
async function registerWebhooks(acc, origin) {
  const c = cfg(acc);
  const url = `${origin}/nuvemshop-webhook`;
  // Limpa os que já apontam para esta URL, para não duplicar em reconexões.
  try {
    const existing = await apiFetch(acc, '/webhooks');
    for (const w of existing || []) {
      if (w && w.url === url) await apiFetch(acc, '/webhooks/' + w.id, { method: 'DELETE' }).catch(() => {});
    }
  } catch (e) { /* segue: se listar falhar, tentamos criar mesmo assim */ }

  const created = [];
  const erros = [];
  for (const { event } of EVENTS) {
    try {
      const w = await apiFetch(acc, '/webhooks', { method: 'POST', body: JSON.stringify({ event, url }) });
      created.push({ id: w.id, event });
    } catch (e) { erros.push(`${event}: ${e.message}`); }
  }
  c.hooks = created;
  db.save();
  if (!created.length) throw new Error('Não foi possível registrar os webhooks na loja. ' + erros.join(' · '));
  return { created, erros };
}

async function disconnect(acc) {
  const c = cfg(acc);
  // Melhor esforço: remove os webhooks lá antes de esquecer o token.
  for (const h of c.hooks || []) {
    await apiFetch(acc, '/webhooks/' + h.id, { method: 'DELETE' }).catch(() => {});
  }
  acc.nuvemshop = empty();
  db.save();
  return acc.nuvemshop;
}

// ---------- recebimento dos eventos ----------

// A Nuvemshop assina o corpo com HMAC-SHA256 usando o secret do app.
function validSignature(secret, rawBody, signature) {
  if (!secret || !signature || !rawBody) return false;
  const calc = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(calc, 'utf8'), b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Descobre a conta dona pelo store_id do evento.
function findAccountByStore(storeId) {
  const data = db.get();
  return (data.accounts || []).find(a => a.nuvemshop && String(a.nuvemshop.storeId) === String(storeId)) || null;
}

// Dinheiro em texto de gente: 1234.5 vira "R$ 1.234,50". O que sai daqui vai
// direto para uma mensagem de WhatsApp, e "1234.5" ali parece defeito.
function moeda(v, cur) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v || '');
  const simbolo = (cur || 'BRL').toUpperCase() === 'BRL' ? 'R$ ' : '';
  return simbolo + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Primeiro nome: "Maria Aparecida da Silva" numa saudação soa formulário.
function primeiroNome(nome) { return String(nome || '').trim().split(/\s+/)[0] || ''; }

// AS VARIÁVEIS DO PEDIDO, do jeito que a mensagem precisa.
//
// Cada uma existe porque alguma mensagem a pede: o rastreio é o "cadê meu
// pedido", o link é o "paga aqui", o primeiro nome é a saudação. Tudo já
// formatado — a automação não tem onde fazer conta nem trocar ponto por
// vírgula.
function orderVars(order) {
  const itens = (order.products || []).map(p => `${p.quantity}x ${p.name}`).join(', ');
  const env = (order.shipping_tracking_number || order.shipping_tracking_url) ? order : {};
  return {
    pedido_numero: String(order.number || order.id || ''),
    pedido_total: moeda(order.total, order.currency),
    pedido_subtotal: moeda(order.subtotal, order.currency),
    pedido_frete: moeda(order.shipping_cost_customer, order.currency),
    pedido_moeda: String(order.currency || 'BRL'),
    pedido_status: String(order.status || ''),
    pedido_pagamento: String(order.payment_status || ''),
    pedido_envio: String(order.shipping_status || ''),
    pedido_itens: itens.slice(0, 400),
    pedido_qtd: String((order.products || []).reduce((a, x) => a + (Number(x.quantity) || 0), 0)),
    pedido_cupom: String(((order.coupon || [])[0] || {}).code || ''),
    pedido_link: String(order.checkout_enabled === false ? '' : (order.landing_url || '')),
    // O que o cliente pergunta quando some: onde está e por onde acompanhar.
    pedido_rastreio: String(env.shipping_tracking_number || ''),
    pedido_rastreio_url: String(env.shipping_tracking_url || ''),
    pedido_transportadora: String(order.shipping_option || ''),
    pedido_entrega_previsao: String(order.shipping_min_days && order.shipping_max_days
      ? `${order.shipping_min_days} a ${order.shipping_max_days} dias úteis` : ''),
    loja_pedido_url: String(order.admin_url || '')
  };
}

// AS VARIÁVEIS DO CARRINHO ABANDONADO.
//
// `carrinho_link` é a razão de existir da recuperação: é o endereço que
// devolve a pessoa ao checkout com tudo dentro. Sem ele, a mensagem manda o
// cliente começar de novo, e ele não começa.
function cartVars(cart) {
  const itens = (cart.products || []).map(p => `${p.quantity}x ${p.name}`).join(', ');
  return {
    carrinho_id: String(cart.id || ''),
    carrinho_total: moeda(cart.total, cart.currency),
    carrinho_moeda: String(cart.currency || 'BRL'),
    carrinho_itens: itens.slice(0, 400),
    carrinho_qtd: String((cart.products || []).reduce((a, x) => a + (Number(x.quantity) || 0), 0)),
    carrinho_link: String(cart.abandoned_checkout_url || ''),
    carrinho_criado: String(cart.created_at || '')
  };
}

// Processa um evento já validado: busca o recurso completo na API, cria/atualiza
// o contato e devolve o que for preciso para disparar as automações.
async function handleEvent(acc, event, resourceId, broadcast) {
  const c = cfg(acc);
  c.events = (c.events || 0) + 1;
  c.lastEventAt = Date.now();
  c.lastEvent = event;

  let nome = '', telefone = '', email = '', vars = {};

  if (event.startsWith('order/')) {
    const order = await apiFetch(acc, '/orders/' + resourceId);
    nome = order.contact_name || (order.customer && order.customer.name) || '';
    telefone = order.contact_phone || (order.customer && order.customer.phone) || '';
    email = order.contact_email || (order.customer && order.customer.email) || '';
    vars = orderVars(order);
  } else if (event.startsWith('customer/')) {
    const cli = await apiFetch(acc, '/customers/' + resourceId);
    nome = cli.name || '';
    telefone = cli.phone || '';
    email = cli.email || '';
    vars = { cliente_total_gasto: String(cli.total_spent || ''), cliente_pedidos: String(cli.total_orders || '') };
  }
  vars.evento_nuvemshop = event;

  let contact = null;
  const waId = telefone ? store.normalizeWaId(telefone) : '';
  if (c.autoContact && waId) {
    contact = store.upsertContact(acc, waId, nome || undefined, {
      email,
      source: { type: 'nuvemshop', id: c.storeId, headline: c.storeName || 'Nuvemshop', ts: Date.now() }
    });
    contact.vars = { ...(contact.vars || {}), ...vars };
    if (c.tags && c.tags.length) {
      contact.tags = contact.tags || [];
      for (const t of c.tags) if (!contact.tags.includes(t)) contact.tags.push(t);
    }
    contact.lastMessageAt = contact.lastMessageAt || Date.now();
    // MARCA DA LOJA no contato. `source` só é gravado na criação, então um
    // contato que já existia (veio pelo WhatsApp antes de comprar) ficava sem
    // nenhum sinal de que também é cliente da loja — e some do disparo
    // segmentado, que é justamente onde ele mais importa.
    contact.ns = Object.assign({}, contact.ns, {
      storeId: String(c.storeId), loja: c.storeName || '', visto: Date.now()
    });
    if (event === 'order/paid') {
      contact.ns.pedidos = (contact.ns.pedidos || 0) + 1;
      contact.ns.ultimoPedido = Date.now();
    }
  }
  db.save();
  store.logEvent({ type: 'nuvemshop_event', accountId: acc.id, event, matched: !!contact, phone: waId || null });
  if (broadcast) broadcast('nuvemshop', { accountId: acc.id, event });
  return { contact, nome, telefone: waId, email, vars };
}

// ---------------------------------------------------------------------------
// QUAIS AUTOMAÇÕES RODAM NESTE EVENTO
//
// Antes, qualquer evento da loja acionava TODA automação ligada a ela: quem
// quisesse avisar do envio mandava a mesma mensagem no pedido criado, no pago
// e no cancelado. Aqui o evento é comparado com o gatilho escolhido.
//
// O formato ANTIGO (gatilho `webhook` com `source: nuvemshop`, sem evento)
// continua valendo e recebe tudo: são automações que alguém montou antes de
// existir escolha, e desligá-las por causa da mudança seria quebrar o que
// está no ar.
// ---------------------------------------------------------------------------
function fluxosDoEvento(acc, evento) {
  return (acc.flows || []).filter(f => {
    if (!f.enabled || !f.trigger) return false;
    if (f.trigger.type === 'nuvemshop') return f.trigger.nsEvent === evento;
    return f.trigger.type === 'webhook' && f.trigger.source === 'nuvemshop';
  });
}

async function dispararFluxos(acc, evento, dados, deliver) {
  const flows = require('./flows');
  const alvo = fluxosDoEvento(acc, evento);
  if (!alvo.length || !dados.telefone) return 0;
  let n = 0;
  for (const flow of alvo) {
    await flows.runFlow(acc, flow, {
      to: dados.telefone, contactName: dados.nome || '', text: '',
      vars: Object.assign({}, dados.vars, {
        nome: dados.nome, primeiro_nome: primeiroNome(dados.nome),
        email: dados.email, telefone: dados.telefone,
        loja: cfg(acc).storeName || ''
      })
    }, deliver).then(() => { n++; }).catch(() => {});
  }
  return n;
}

// ---------------------------------------------------------------------------
// CARRINHO ABANDONADO — por varredura, porque não há webhook
//
// A Nuvemshop não publica evento de carrinho abandonado. O carrinho existe em
// `GET /checkouts` e SAI de lá quando vira pedido, então "abandonado" é o que
// continua na lista depois de um tempo. A conta é essa: passou dos minutos
// configurados e ainda está lá.
//
// Cada carrinho é avisado UMA vez. A lista de vistos guarda id e data, e é
// podada em 500 — sem poda ela cresceria para sempre dentro da conta.
// ---------------------------------------------------------------------------
const VISTOS_MAX = 500;

async function varrerCarrinhos(acc, deliver, broadcast) {
  const c = cfg(acc);
  if (!c.accessToken || !c.carrinho || !c.carrinho.ligado) return { avisados: 0 };
  // SEM AUTOMAÇÃO NÃO SE VARRE. Varrer marcaria os carrinhos como avisados
  // sem ter enviado nada, e eles nunca mais entrariam — o lojista montaria o
  // fluxo no dia seguinte e acharia que a recuperação não funciona.
  if (!fluxosDoEvento(acc, EVENTO_CARRINHO).length) {
    return { avisados: 0, motivo: 'sem_automacao' };
  }
  const minutos = Math.max(5, Number(c.carrinho.minutos) || 60);
  const limite = Date.now() - minutos * 60000;
  // Carrinho velho demais não é recuperação, é incômodo: quem abandonou há
  // três dias já comprou em outro lugar ou desistiu.
  const chao = Date.now() - 3 * 86400000;

  let lista = [];
  try { lista = await apiFetch(acc, '/checkouts?per_page=50') || []; }
  catch (e) { store.logEvent({ type: 'nuvemshop_erro_carrinho', accountId: acc.id, error: e.message }); return { avisados: 0, erro: e.message }; }

  c.ultimaVarredura = Date.now();
  c.carrinhosVistos = c.carrinhosVistos || [];
  const jaVistos = new Set(c.carrinhosVistos.map(v => String(v.id)));
  let avisados = 0;

  for (const cart of lista) {
    const id = String(cart.id || '');
    if (!id || jaVistos.has(id)) continue;
    const quando = Date.parse(cart.updated_at || cart.created_at || 0) || 0;
    if (!quando || quando > limite || quando < chao) continue;
    // Sem telefone não há para quem mandar. O carrinho fica sem marca: se a
    // pessoa voltar e preencher o telefone, ele entra na próxima varredura.
    const tel = cart.contact_phone ? store.normalizeWaId(cart.contact_phone) : '';
    if (!tel) continue;

    const rodou = await dispararFluxos(acc, EVENTO_CARRINHO, {
      telefone: tel, nome: cart.contact_name || '', email: cart.contact_email || '',
      vars: cartVars(cart)
    }, deliver);
    // Só marca o que de fato virou mensagem. Um fluxo que falhou no meio
    // volta a ser tentado na próxima varredura, que é o certo: o carrinho
    // continua lá e o cliente continua sem o recado.
    if (rodou) { c.carrinhosVistos.push({ id, ts: Date.now() }); avisados++; }
  }

  if (c.carrinhosVistos.length > VISTOS_MAX) {
    c.carrinhosVistos = c.carrinhosVistos.slice(-VISTOS_MAX);
  }
  db.save();
  if (avisados && broadcast) broadcast('nuvemshop', { accountId: acc.id, event: EVENTO_CARRINHO });
  return { avisados, carrinhos: lista.length };
}

// Roda a varredura em TODAS as contas com a recuperação ligada. Chamado pelo
// relógio do servidor.
async function varrerTodas(deliver, broadcast) {
  const contas = (db.get().accounts || []).filter(a => a.nuvemshop && a.nuvemshop.accessToken
    && a.nuvemshop.carrinho && a.nuvemshop.carrinho.ligado);
  let total = 0;
  for (const acc of contas) {
    try { const r = await varrerCarrinhos(acc, deliver, broadcast); total += r.avisados || 0; }
    catch (e) { /* uma loja com problema não pode parar as outras */ }
  }
  return total;
}

// Handler do POST /nuvemshop-webhook — precisa do req.rawBody para o HMAC.
function webhookHandler(broadcast) {
  return async (req, res) => {
    const body = req.body || {};
    const acc = findAccountByStore(body.store_id);
    if (!acc) return res.status(200).json({ ok: true, ignored: 'loja não conectada' });

    const sig = req.get('x-linkedstore-hmac-sha256');
    if (!validSignature(platformCfg().appSecret, req.rawBody, sig)) {
      store.logEvent({ type: 'nuvemshop_bad_signature', accountId: acc.id, event: body.event || '' });
      return res.status(401).json({ error: 'assinatura inválida' });
    }

    // Responde rápido: a Nuvemshop espera 200 em poucos segundos.
    res.json({ ok: true });
    try {
      const evento = String(body.event || '');
      const r = await handleEvent(acc, evento, body.id, broadcast);
      // Só as automações que escolheram ESTE evento.
      await dispararFluxos(acc, evento, r, req.app.get('flowDeliver'));
    } catch (e) {
      store.logEvent({ type: 'nuvemshop_error', accountId: acc.id, error: e.message });
    }
  };
}

module.exports = {
  EVENTS, GATILHOS, EVENTO_CARRINHO, empty, cfg, platformCfg, isAvailable, publicCfg, adminCfg,
  exchangeCode, apiFetch, fetchStore, registerWebhooks, disconnect,
  handleEvent, webhookHandler, validSignature,
  orderVars, cartVars, moeda, primeiroNome,
  fluxosDoEvento, dispararFluxos, varrerCarrinhos, varrerTodas
};
