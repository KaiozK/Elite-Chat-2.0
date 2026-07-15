const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const consentDefaults = require('./consent-defaults');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function hash(pass) {
  return crypto.createHash('sha256').update('wacrm:' + String(pass)).digest('hex');
}

// Configuração da PLATAFORMA (Tech Provider) — definida uma vez pelo admin/dono.
// Os clientes nunca preenchem isso; eles conectam via Embedded Signup.
const DEFAULTS = {
  platform: {
    graphVersion: 'v25.0',
    appId: '',
    appSecret: '',
    configId: '',        // ID da configuração de login do Embedded Signup
    systemToken: '',     // token de usuário do sistema (fallback / envio pela plataforma)
    verifyToken: crypto.randomBytes(12).toString('hex'),
    adminUser: 'admin',
    adminPassHash: hash('admin'),
    // ---- SaaS: pagamentos via Woovi (Pix / Pix Automático) ----
    woovi: {
      appId: '',              // AppID gerado em app.woovi.com → API/Plugins
      pixAutomatic: true,     // tenta assinatura recorrente (Pix Automático) quando disponível
      sandbox: false
    },
    billing: { trialDays: 7, enforce: false }, // enforce: bloquear envio quando expirado
    affiliate: { percentFirst: 30, percentRenewal: 15 }, // % de comissão do afiliado
    landing: { ctaText: '' } // copy do botão principal da landing (vazio = automático pelos dias de teste)
  },
  plans: [],             // planos de assinatura { id, name, price(centavos), periodDays, features[] }
  withdrawals: [],       // pedidos de saque { id, accountId, amount, pixKey, status, ts }
  revenue: [],           // pagamentos confirmados { ts, accountId, planId, amount, kind: first|renewal|topup, chargeId }
  accounts: [],          // tenants (clientes) — ver newAccount()
  sessions: {},          // token -> { kind:'account'|'admin', accountId }
  webhookLog: []
};

const DEFAULT_STAGES = ['Novo', 'Em atendimento', 'Qualificado', 'Negociação', 'Ganho', 'Perdido'];

// Estado da conexão WhatsApp de cada conta — preenchido pelo Embedded Signup.
// Campos persistidos conforme o fluxo oficial da Meta (Cloud API v25.0).
function emptyWa() {
  return {
    connected: false,
    authorizationCode: '',
    accessToken: '',
    tokenType: '',
    businessId: '',
    wabaId: '',
    phoneNumberId: '',
    displayPhoneNumber: '',
    verifiedName: '',
    systemUserId: '',
    appSubscribed: false,
    graphVersion: '',
    callbackUrl: '',
    connectedAt: null,
    updatedAt: null,
    lastHealth: null
  };
}

function newAccount({ name, email, pass }) {
  return {
    id: genId('acc'),
    name: name || email,
    email: String(email || '').toLowerCase().trim(),
    passHash: hash(pass || ''),
    createdAt: Date.now(),
    wa: { ...emptyWa() },
    stages: [...DEFAULT_STAGES],
    contacts: [],
    messages: [],
    campaigns: [],
    quickReplies: [
      { id: genId('qr'), title: 'Saudação', text: 'Olá! Como posso ajudar você hoje?' },
      { id: genId('qr'), title: 'Aguarde', text: 'Um momento, por favor. Já vou te responder!' }
    ],
    templatesCache: { fetchedAt: 0, list: [] },
    team: [],            // ATENDENTES (login próprio, permissões, presença) — ver src/agents.js
    logs: [],            // ações dos atendentes (login, transferências, alterações…)
    schedules: [],       // agendamentos (calendário + lembretes) — ver src/schedule.js
    sectors: [],         // setores/departamentos (canais)
    chatThreads: {},     // threadId -> [ { id, from, fromId, text, ts } ]
    chatReads: {},       // threadId -> ts da última leitura
    teamChat: [],        // legado (canal geral) — migrado para chatThreads.group
    flows: [],           // automações (Flow Builder)
    links: [],           // links rastreáveis encurtados { id, slug, title, dest, clicks[] }
    webhooks: [],        // webhooks de entrada { id, name, token, mapping, lastPayload, hits } — aba Webhooks
    pixels: [],          // pixels de rastreamento { id, type: meta|gtag|tiktok, pixelId, name }
    linkDomain: '',      // domínio personalizado exibido nos links curtos
    tracking: { metaPixelId: '', gtagId: '' },  // legado — migrado para pixels[]
    billing: emptyBilling(),
    wallet: { balance: 0, transactions: [] },   // saldo em centavos + extrato
    affiliate: { code: genRefCode(), refBy: '', earned: 0 }, // indicação: código próprio + quem indicou
    service: {                                   // Configurações → Atendimento / Finalização
      autoClose: { enabled: false, minutes: 60 },
      survey: defaultSurvey()                    // pesquisa de satisfação enviada ao finalizar
    },
    consent: require('./consent-defaults')()     // Opt-in & Opt-out
  };
}

// Pesquisa de satisfação: modelo da mensagem + notas.
// Até 3 notas → botões interativos; acima de 3 → lista (regra da Meta).
function defaultSurvey() {
  return {
    enabled: false,
    message: 'Obrigado pelo contato! 🙏\n\nComo você avalia o nosso atendimento?',
    footer: 'Sua opinião nos ajuda a melhorar',
    listButton: 'Avaliar atendimento',   // texto do botão que abre a lista (>3 notas)
    notes: [
      { id: 'n1', label: '⭐ Ruim' },
      { id: 'n2', label: '🙂 Bom' },
      { id: 'n3', label: '🤩 Excelente' }
    ]
  };
}

// Assinatura da conta (SaaS). status: trial | active | past_due | canceled
function emptyBilling() {
  return {
    status: 'trial',
    planId: '',
    periodEnd: 0,          // fim do período pago/trial (ms)
    wooviSubId: '',        // globalID da assinatura na Woovi (Pix Automático)
    subCorrelationID: '',  // correlationID da assinatura (casa cobranças de renovação)
    pendingCharge: null,   // { correlationID, kind, planId, amount, brCode, qrCodeImage, paymentLinkUrl, ts }
    startedAt: 0, canceledAt: 0
  };
}

function genRefCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

let db = null;
let saveTimer = null;

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
    catch (e) { console.error('db.json corrompido, recriando:', e.message); db = null; }
  }
  if (!db) db = JSON.parse(JSON.stringify(DEFAULTS));
  for (const k of Object.keys(DEFAULTS)) if (db[k] === undefined) db[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
  for (const k of Object.keys(DEFAULTS.platform)) if (db.platform[k] === undefined) db.platform[k] = JSON.parse(JSON.stringify(DEFAULTS.platform[k]));
  // merge raso dos sub-objetos da plataforma (woovi/billing/affiliate ganham chaves novas)
  for (const k of ['woovi', 'billing', 'affiliate', 'landing']) {
    for (const kk of Object.keys(DEFAULTS.platform[k])) {
      if (db.platform[k][kk] === undefined) db.platform[k][kk] = DEFAULTS.platform[k][kk];
    }
  }
  migrateLegacy();
  for (const a of db.accounts) ensureAccountShape(a);
  flush();
}

// Migra o db.json single-tenant antigo (settings/contacts/messages na raiz)
// para o modelo multi-conta: dados viram a conta do administrador.
function migrateLegacy() {
  const legacy = db.settings;
  if (!legacy) return;
  const p = db.platform;
  if (legacy.adminUser) p.adminUser = legacy.adminUser;
  if (legacy.adminPassHash) p.adminPassHash = legacy.adminPassHash;
  if (legacy.graphVersion) p.graphVersion = legacy.graphVersion;
  if (legacy.appId) p.appId = legacy.appId;
  if (legacy.appSecret) p.appSecret = legacy.appSecret;
  if (legacy.verifyToken) p.verifyToken = legacy.verifyToken;

  let acc = db.accounts.find(a => a.isAdmin);
  if (!acc) {
    acc = newAccount({ name: 'Administrador', email: 'admin@elitechat.local', pass: crypto.randomBytes(12).toString('hex') });
    acc.isAdmin = true;
    db.accounts.push(acc);
  }
  acc.passHash = p.adminPassHash; // mesma senha do login admin
  if (Array.isArray(legacy.stages) && legacy.stages.length) acc.stages = legacy.stages;
  if (Array.isArray(db.contacts)) acc.contacts = db.contacts;
  if (Array.isArray(db.messages)) acc.messages = db.messages;
  if (Array.isArray(db.campaigns)) acc.campaigns = db.campaigns;
  if (Array.isArray(db.quickReplies) && db.quickReplies.length) acc.quickReplies = db.quickReplies;
  if (db.templatesCache) acc.templatesCache = db.templatesCache;
  // credenciais manuais antigas viram conexão manual da conta admin
  if (legacy.accessToken) acc.wa.accessToken = legacy.accessToken;
  if (legacy.wabaId) acc.wa.wabaId = legacy.wabaId;
  if (legacy.phoneNumberId) acc.wa.phoneNumberId = legacy.phoneNumberId;
  acc.wa.connected = !!(acc.wa.accessToken && acc.wa.phoneNumberId);

  delete db.settings;
  delete db.contacts;
  delete db.messages;
  delete db.campaigns;
  delete db.quickReplies;
  delete db.templatesCache;
  db.sessions = {}; // sessões antigas têm outro formato
}

// Garante que contas antigas ganhem os campos novos (wa do Embedded Signup etc.)
function ensureAccountShape(acc) {
  if (!acc.wa) acc.wa = emptyWa();
  const base = emptyWa();
  for (const k of Object.keys(base)) if (acc.wa[k] === undefined) acc.wa[k] = base[k];
  // compat: shape antiga usava token/phoneNumber
  if (acc.wa.token && !acc.wa.accessToken) acc.wa.accessToken = acc.wa.token;
  if (acc.wa.phoneNumber && !acc.wa.displayPhoneNumber) acc.wa.displayPhoneNumber = acc.wa.phoneNumber;
  delete acc.wa.token;
  delete acc.wa.phoneNumber;
  if (!Array.isArray(acc.stages) || !acc.stages.length) acc.stages = [...DEFAULT_STAGES];
  if (!Array.isArray(acc.contacts)) acc.contacts = [];
  if (!Array.isArray(acc.messages)) acc.messages = [];
  if (!Array.isArray(acc.campaigns)) acc.campaigns = [];
  if (!Array.isArray(acc.quickReplies)) acc.quickReplies = [];
  if (!acc.templatesCache) acc.templatesCache = { fetchedAt: 0, list: [] };
  if (!Array.isArray(acc.team)) acc.team = [];
  if (!Array.isArray(acc.logs)) acc.logs = [];
  if (!Array.isArray(acc.schedules)) acc.schedules = [];
  if (!Array.isArray(acc.calls)) acc.calls = [];   // histórico de ligações (Calling API)
  // ATENDENTES: membros antigos do chat interno viram atendentes completos
  // (sem login até o admin definir e-mail/senha; permissões de atendente).
  for (const a of acc.team) require('./agents').ensureAgent(a);
  if (!Array.isArray(acc.sectors)) acc.sectors = [];
  if (!acc.chatThreads || typeof acc.chatThreads !== 'object') acc.chatThreads = {};
  if (!acc.chatReads || typeof acc.chatReads !== 'object') acc.chatReads = {};
  if (!Array.isArray(acc.teamChat)) acc.teamChat = [];
  // migra o canal de grupo antigo (teamChat) para chatThreads.group
  if (acc.teamChat.length && !acc.chatThreads.group) { acc.chatThreads.group = acc.teamChat; acc.teamChat = []; }
  if (!Array.isArray(acc.flows)) acc.flows = [];
  if (!Array.isArray(acc.links)) acc.links = [];
  if (!Array.isArray(acc.webhooks)) acc.webhooks = [];
  if (!Array.isArray(acc.pixels)) acc.pixels = [];
  if (typeof acc.linkDomain !== 'string') acc.linkDomain = '';
  // SaaS: contas antigas ganham assinatura/carteira/afiliação
  if (!acc.billing || typeof acc.billing !== 'object') acc.billing = emptyBilling();
  const eb = emptyBilling();
  for (const k of Object.keys(eb)) if (acc.billing[k] === undefined) acc.billing[k] = eb[k];
  if (acc.billing.status === 'trial' && !acc.billing.periodEnd) {
    acc.billing.periodEnd = (acc.createdAt || Date.now()) + (get().platform.billing.trialDays || 7) * 86400000;
  }
  if (!acc.wallet || typeof acc.wallet !== 'object') acc.wallet = { balance: 0, transactions: [] };
  if (!Array.isArray(acc.wallet.transactions)) acc.wallet.transactions = [];
  if (typeof acc.wallet.balance !== 'number') acc.wallet.balance = 0;
  if (!acc.affiliate || typeof acc.affiliate !== 'object') acc.affiliate = { code: genRefCode(), refBy: '', earned: 0 };
  if (!acc.affiliate.code) acc.affiliate.code = genRefCode();
  if (typeof acc.affiliate.earned !== 'number') acc.affiliate.earned = 0;

  // ---- Janela de 24h / atendimento (migração de contas e contatos antigos) ----
  if (!acc.service || typeof acc.service !== 'object') acc.service = { autoClose: { enabled: false, minutes: 60 } };
  if (!acc.service.autoClose || typeof acc.service.autoClose !== 'object') acc.service.autoClose = { enabled: false, minutes: 60 };
  if (typeof acc.service.autoClose.enabled !== 'boolean') acc.service.autoClose.enabled = false;
  if (typeof acc.service.autoClose.minutes !== 'number') acc.service.autoClose.minutes = 60;
  // pesquisa de satisfação (contas antigas ganham o padrão)
  if (!acc.service.survey || typeof acc.service.survey !== 'object') acc.service.survey = defaultSurvey();
  const ds = defaultSurvey();
  for (const k of Object.keys(ds)) if (acc.service.survey[k] === undefined) acc.service.survey[k] = ds[k];
  if (!Array.isArray(acc.service.survey.notes)) acc.service.survey.notes = ds.notes;

  // Backfill: deriva a última mensagem RECEBIDA de cada contato a partir do histórico
  const lastInBy = {};
  for (const m of acc.messages) {
    if (m.direction === 'in' && (!lastInBy[m.waId] || m.timestamp > lastInBy[m.waId])) lastInBy[m.waId] = m.timestamp;
  }
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  for (const c of acc.contacts) {
    if (c.lastInboundAt === undefined) c.lastInboundAt = lastInBy[c.waId] || null;
    c.windowExpiresAt = c.lastInboundAt ? c.lastInboundAt + WINDOW_MS : null;
    if (!c.attendance || typeof c.attendance !== 'object') {
      c.attendance = {
        status: 'open', openedAt: c.lastInboundAt || c.createdAt || null,
        closedAt: null, closeType: null, closedBy: null, reopenedAt: null, reopenedBy: null
      };
    }
    if (!Array.isArray(c.attendanceHistory)) c.attendanceHistory = [];
    if (!Array.isArray(c.surveys)) c.surveys = [];   // respostas da pesquisa de satisfação
    // ---- Opt-in / Opt-out ----
    if (!c.consent || typeof c.consent !== 'object') {
      // contatos que já conversavam entram como opt-in implícito (falaram conosco)
      const implied = !!c.lastInboundAt;
      c.consent = {
        ...consentDefaults.emptyContactConsent(),
        status: implied ? 'opted_in' : 'pending',
        optInAt: implied ? c.lastInboundAt : null,
        optInSource: implied ? 'inbound' : null,
        history: implied ? [{ ts: c.lastInboundAt, action: 'opt_in', source: 'inbound', reason: 'Migração: contato já conversava', by: null }] : []
      };
    }
    if (!Array.isArray(c.consent.history)) c.consent.history = [];
    if (typeof c.city !== 'string') c.city = '';       // cidade (webhook mapeado ou manual)
    if (!c.vars || typeof c.vars !== 'object') c.vars = {};
    // Atribuição a atendente + histórico de transferências
    if (c.assignedTo === undefined) c.assignedTo = null;   // agentId responsável
    if (c.assignedAt === undefined) c.assignedAt = null;
    if (!Array.isArray(c.transfers)) c.transfers = [];     // [{ts, fromId, fromName, toId, toName, by, reason}]
    if (c.lastAgentId === undefined) c.lastAgentId = null;
  }

  // ---- Configuração de Opt-in/Opt-out da conta ----
  if (!acc.consent || typeof acc.consent !== 'object') acc.consent = consentDefaults.defaultConsent();
  const dc = consentDefaults.defaultConsent();
  for (const k of Object.keys(dc)) if (acc.consent[k] === undefined) acc.consent[k] = dc[k];
  if (!Array.isArray(acc.consent.keywords)) acc.consent.keywords = dc.keywords;
  if (!Array.isArray(acc.consent.history)) acc.consent.history = [];
  // migra os campos antigos de tracking para o CRUD de pixels
  if (acc.tracking && typeof acc.tracking === 'object') {
    if (acc.tracking.metaPixelId) {
      acc.pixels.push({ id: genId('px'), type: 'meta', pixelId: acc.tracking.metaPixelId, name: 'Meta Pixel', createdAt: Date.now() });
      acc.tracking.metaPixelId = '';
    }
    if (acc.tracking.gtagId) {
      acc.pixels.push({ id: genId('px'), type: 'gtag', pixelId: acc.tracking.gtagId, name: 'Google tag', createdAt: Date.now() });
      acc.tracking.gtagId = '';
    }
  }
}

function flush() { clearTimeout(saveTimer); fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250); }
function get() { if (!db) load(); return db; }

function genId(prefix = 'id') { return prefix + '_' + crypto.randomBytes(8).toString('hex'); }

// Helpers de conta
function findAccount(id) { return get().accounts.find(a => a.id === id); }
function findAccountByEmail(email) { return get().accounts.find(a => a.email === String(email || '').toLowerCase().trim()); }
function findAccountByPhoneId(phoneNumberId) { return get().accounts.find(a => a.wa && a.wa.phoneNumberId === phoneNumberId); }

function findAccountByRefCode(code) {
  const c = String(code || '').toUpperCase().trim();
  if (!c) return null;
  return get().accounts.find(a => a.affiliate && a.affiliate.code === c) || null;
}

// Slug é namespace global (rota pública /l/:slug)
function findLinkBySlug(slug) {
  for (const acc of get().accounts) {
    const link = (acc.links || []).find(l => l.slug === slug);
    if (link) return { acc, link };
  }
  return null;
}

// Webhook de entrada por token (namespace global — rota pública /hook/:token)
function findWebhookByToken(token) {
  for (const acc of get().accounts) {
    const wh = (acc.webhooks || []).find(w => w.token === token);
    if (wh) return { acc, webhook: wh };
  }
  return null;
}

// Conta do administrador da plataforma (criada na migração ou no primeiro login)
function findAdminAccount() {
  let acc = get().accounts.find(a => a.isAdmin);
  if (!acc) {
    acc = newAccount({ name: 'Administrador', email: 'admin@elitechat.local', pass: crypto.randomBytes(12).toString('hex') });
    acc.isAdmin = true;
    acc.passHash = get().platform.adminPassHash;
    get().accounts.push(acc);
    save();
  }
  return acc;
}

process.on('exit', () => { try { if (db) flush(); } catch {} });

module.exports = { get, save, load, flush, genId, hash, newAccount, emptyWa, emptyBilling, defaultSurvey, findAccount, findAccountByEmail, findAccountByPhoneId, findAccountByRefCode, findAdminAccount, findLinkBySlug, findWebhookByToken, DEFAULT_STAGES };
