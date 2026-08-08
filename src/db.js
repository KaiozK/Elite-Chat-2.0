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
    // ---- Integração Nuvemshop (app único da plataforma) ----
    // O ADMIN cria um app no Portal de Parceiros da Nuvemshop e preenche aqui.
    // Os clientes só clicam em "Conectar loja" — não veem nem informam credenciais.
    // Enquanto `enabled` for false, a integração nem aparece para os clientes.
    nuvemshop: { enabled: false, appId: '', appSecret: '' },
    // ---- Meta Ads (Tracking, permissão ads_read) ----
    // O OAuth de Meta Ads usa o MESMO app da Meta do WhatsApp por padrão (App ID
    // e Secret acima). Só preencha aqui se você usa um APP SEPARADO para anúncios
    // — nesse caso, estes campos têm prioridade. Vazio = reaproveita o do WhatsApp.
    metaAds: { appId: '', appSecret: '' },
    // enforce: bloquear envio quando expirado
    // extras: preço mensal (centavos) de cada unidade EXCEDENTE ao que o plano já inclui.
    //         O admin define aqui; o cliente compra na tela de Assinatura.
    billing: {
      trialDays: 7, enforce: false,
      extras: { whatsappPrice: 0, linkPrice: 0 },
      // Faixa aceita ao recarregar a carteira (centavos). max 0 = sem teto.
      deposit: { min: 100, max: 0 }
    },
    // ---- SMS (provedor Integra X) ----
    // Desligado por padrão: o admin liga, informa o token e escolhe em quais
    // planos o módulo `sms` fica disponível.
    sms: {
      enabled: false, token: '', from: '', base: '', callbackUrl: '',
      maxLen: 160, priceCents: 0, lastBalance: null, logs: []
    },
    // % de comissão do afiliado + faixa aceita ao sacar a comissão (centavos).
    affiliate: { percentFirst: 30, percentRenewal: 15, withdraw: { min: 2000, max: 0 } },
    landing: { ctaText: '' } // copy do botão principal da landing (vazio = automático pelos dias de teste)
  },
  plans: [],             // planos de assinatura { id, name, price(centavos), periodDays, features[], limits{} }
  withdrawals: [],       // pedidos de saque { id, accountId, amount, pixKey, status, ts }
  revenue: [],           // pagamentos confirmados { ts, accountId, planId, amount, kind: first|renewal|topup, chargeId }
  accounts: [],          // tenants (clientes), ver newAccount()
  sessions: {},          // token -> { kind:'account'|'admin', accountId }
  webhookLog: []
};

const DEFAULT_STAGES = ['Novo', 'Em atendimento', 'Qualificado', 'Negociação', 'Ganho', 'Perdido'];

// ---------------------------------------------------------------------------
// LIMITES DE PLANO
// Cada plano define quanto o cliente pode usar de cada recurso.
//   -1  = ilimitado
//    0  = recurso bloqueado
//   N   = teto
// `whatsapps` e `links` são os INCLUSOS no plano; acima disso o cliente compra
// unidades extras (preço em platform.billing.extras).
const LIMIT_KEYS = ['sends', 'contacts', 'flows', 'pixels', 'links', 'whatsapps', 'sms'];
function defaultLimits() {
  return { sends: -1, contacts: -1, flows: -1, pixels: -1, links: 1, whatsapps: 1, sms: 0 };
}
// ---------------------------------------------------------------------------
// FUNCIONALIDADES POR PLANO (toggles)
// Cada plano liga/desliga módulos inteiros. Diferente dos LIMITES (quantidade),
// aqui é booleano: desligado, o módulo some do menu do cliente e as rotas
// recusam com 402. Módulos essenciais (conversas, contatos, funil, modelos,
// LGPD) não entram na lista: fazem parte de qualquer plano.
const FEATURE_KEYS = ['campaigns', 'flows', 'schedule', 'team', 'agents', 'elitepay', 'links', 'pixels', 'tracking', 'integrations', 'sms'];
function defaultFeatures() {
  const o = {};
  for (const k of FEATURE_KEYS) o[k] = true;   // plano sem config libera tudo
  return o;
}
function normFeatures(src, base) {
  const out = Object.assign(defaultFeatures(), base || {});
  if (src && typeof src === 'object') {
    for (const k of FEATURE_KEYS) if (src[k] !== undefined) out[k] = !!src[k];
  }
  return out;
}

// Normaliza os limites vindos do body/banco: aceita '' (ilimitado) e números.
function normLimits(src, base) {
  const out = Object.assign(defaultLimits(), base || {});
  for (const k of LIMIT_KEYS) {
    if (!src || src[k] === undefined) continue;
    const raw = String(src[k]).trim();
    if (raw === '' || /^(ilimitado|unlimited|-1|∞)$/i.test(raw)) { out[k] = -1; continue; }
    const n = Math.floor(Number(raw));
    out[k] = Number.isFinite(n) && n >= 0 ? n : -1;
  }
  return out;
}

// Um CANAL é uma conexão WhatsApp independente: conversas e contatos ficam
// separados por canal para não misturar atendimentos de números diferentes.
function emptyChannel(label) {
  return {
    id: genId('ch'),
    label: label || 'WhatsApp',
    createdAt: Date.now(),
    archived: false,
    // Cancelamento de conexão EXTRA: continua funcionando até `cancelAt` e, na
    // virada, o canal é apagado com tudo que é dele (ver store.purgeChannel).
    canceledAt: 0,
    cancelAt: 0,
    wa: emptyWa(),
    // Os MODELOS aprovados pertencem à WABA, e cada canal tem a sua. Guardar o
    // cache por canal evita mostrar (e disparar) um template que não existe no
    // número que vai enviar.
    templatesCache: { fetchedAt: 0, list: [] }
  };
}

// Contexto de uma conta "visto pelo canal X": `ctx.wa` é o wa DAQUELE canal, e
// todo o resto continua vindo da conta (herança por protótipo). Permite reusar
// src/whatsapp.js — que lê acc.wa — sem reescrever as 50+ chamadas.
function chanCtx(acc, ch) {
  if (!ch || !acc || ch === (acc.channels || [])[0]) return acc;
  return Object.create(acc, {
    wa: { value: ch.wa, enumerable: false },
    // os modelos aprovados são da WABA daquele canal
    templatesCache: { value: ch.templatesCache, enumerable: false }
  });
}

// Canal pelo id (ou o padrão quando não informado / inexistente).
function findChannel(acc, chId) {
  const list = (acc && acc.channels) || [];
  return (chId && list.find(c => c.id === chId)) || list[0] || null;
}

// Canal dono de um phoneNumberId — usado pelo webhook para saber em qual
// conexão a mensagem chegou.
function channelByPhoneId(acc, phoneNumberId) {
  if (!phoneNumberId) return null;
  return ((acc && acc.channels) || []).find(c => c.wa && c.wa.phoneNumberId === phoneNumberId) || null;
}

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
  const acc = {
    id: genId('acc'),
    name: name || email,
    email: String(email || '').toLowerCase().trim(),
    passHash: hash(pass || ''),
    createdAt: Date.now(),
    channels: [emptyChannel('WhatsApp principal')],
    stages: [...DEFAULT_STAGES],
    contacts: [],
    messages: [],
    campaigns: [],
    quickReplies: [
      { id: genId('qr'), title: 'Saudação', text: 'Olá! Como posso ajudar você hoje?' },
      { id: genId('qr'), title: 'Aguarde', text: 'Um momento, por favor. Já vou te responder!' }
    ],
    team: [],            // ATENDENTES (login próprio, permissões, presença), ver src/agents.js
    logs: [],            // ações dos atendentes (login, transferências, alterações…)
    schedules: [],       // agendamentos (calendário + lembretes), ver src/schedule.js
    sectors: [],         // setores/departamentos (canais)
    chatThreads: {},     // threadId -> [ { id, from, fromId, text, ts } ]
    chatReads: {},       // threadId -> ts da última leitura
    teamChat: [],        // legado (canal geral), migrado para chatThreads.group
    flows: [],           // automações (Flow Builder)
    links: [],           // links rastreáveis encurtados { id, slug, title, dest, clicks[] }
    webhooks: [],        // webhooks de entrada { id, name, token, mapping, lastPayload, hits }, aba Integrações
    nuvemshop: null,     // loja Nuvemshop conectada, inicializado sob demanda por src/nuvemshop.js (cfg)
    pixels: [],          // pixels de rastreamento { id, type: meta|gtag|tiktok, pixelId, name }
    linkDomain: '',      // domínio personalizado exibido nos links curtos
    tracking: { metaPixelId: '', gtagId: '' },  // legado, migrado para pixels[]
    billing: emptyBilling(),
    wallet: emptyWallet(),                      // saldo, recebíveis e extrato
    affiliate: { code: genRefCode(), refBy: '', earned: 0 }, // indicação: código próprio + quem indicou
    service: {                                   // Configurações → Atendimento / Finalização
      autoClose: { enabled: false, minutes: 60 },
      survey: defaultSurvey()                    // pesquisa de satisfação enviada ao finalizar
    },
    consent: require('./consent-defaults')()     // Opt-in & Opt-out
  };
  attachWaAlias(acc);
  attachTplAlias(acc);
  return acc;
}

// `acc.wa` deixou de existir no banco: virou um APELIDO (não serializado) para o
// wa do canal padrão. Todo o código legado que lê/escreve acc.wa continua válido
// e passa a operar sobre channels[0].wa — sem duplicar dados no db.json.
function attachWaAlias(acc) {
  delete acc.wa;
  Object.defineProperty(acc, 'wa', {
    configurable: true,
    enumerable: false,          // fora do JSON.stringify → nada duplicado
    get() { return ((acc.channels || [])[0] || {}).wa || {}; }
  });
}

// Mesma ideia para os MODELOS: `acc.templatesCache` vira apelido do cache do
// canal padrão, então o código legado continua funcionando e o db.json não
// guarda duas cópias da mesma lista.
function attachTplAlias(acc) {
  delete acc.templatesCache;
  Object.defineProperty(acc, 'templatesCache', {
    configurable: true,
    enumerable: false,
    get() { return ((acc.channels || [])[0] || {}).templatesCache || { fetchedAt: 0, list: [] }; }
  });
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
    subValue: 0,           // valor da recorrência hoje (plano + extras); muda ao comprar extra
    pendingCharge: null,   // { correlationID, kind, planId, amount, brCode, qrCodeImage, paymentLinkUrl, ts }
    startedAt: 0, canceledAt: 0,
    // ---- Meio de pagamento da assinatura ----
    method: 'pix',         // pix | credit | boleto | wallet, como o cliente paga o EliteChat
    taxId: '',             // CPF/CNPJ do titular — exigido para emitir boleto
    card: {                // cartão tokenizado para renovar automaticamente
      token: '', brand: '', last4: '', holderName: '', gatewayCustomerId: ''
    },
    // ---- Unidades EXTRAS compradas (além do que o plano inclui) ----
    extras: { whatsapps: 0, links: 0 }
  };
}

// CARTEIRA do cliente dentro do EliteChat.
// As vendas no cartão caem aqui: primeiro como `pending` (a liberar, porque o
// adquirente só repassa em D+30/D+32) e, vencido o prazo, viram `balance`.
// O saldo disponível paga coisas na plataforma (plano, conexão WhatsApp extra,
// links…) ou é sacado — o saque de dinheiro de cartão tem taxa própria.
function emptyWallet() {
  return {
    balance: 0,        // disponível para usar/sacar (centavos)
    pending: 0,        // vendas no cartão ainda dentro do prazo de liberação
    cardAvailable: 0,  // quanto do `balance` veio de cartão (define a taxa de saque)
    receivables: [],   // { id, amount, availableAt, chargeId, kind, released }
    // RECARGA AUTOMÁTICA: quando o saldo cai abaixo de `threshold`, o sistema
    // recarrega sozinho. No Pix é a assinatura da Woovi (Pix Automático); no
    // cartão é o cartão salvo da fatura, cobrado como uma assinatura.
    autoTopup: {
      enabled: false,
      method: 'pix',      // pix | card
      threshold: 2000,    // recarrega quando o saldo ficar abaixo disso
      amount: 5000,       // quanto recarregar de cada vez
      wooviSubId: '',     // assinatura do Pix Automático, quando method=pix
      lastRunAt: 0,       // trava contra recarregar duas vezes seguidas
      lastError: ''
    },
    transactions: []
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
  // merge raso dos sub-objetos da plataforma (woovi/billing/affiliate ganham chaves novas).
  // O valor é CLONADO: alguns desses padrões são objetos (extras, deposit,
  // withdraw) e copiá-los por referência faria o banco e o DEFAULTS
  // compartilharem a mesma memória — editar um mexeria no outro.
  // O Pix Indireto foi descontinuado: limpa a config de bancos antigos para não
  // ficar lixo no db.json (as assinaturas usam o Pix/Woovi e o cartão).
  delete db.platform.pixIndirect;
  for (const k of ['woovi', 'billing', 'affiliate', 'landing', 'metaAds', 'nuvemshop']) {
    for (const kk of Object.keys(DEFAULTS.platform[k])) {
      if (db.platform[k][kk] === undefined) {
        db.platform[k][kk] = JSON.parse(JSON.stringify(DEFAULTS.platform[k][kk]));
      }
    }
  }
  // preço dos extras (WhatsApp / links avulsos) — planos e config antigos
  if (!db.platform.billing.extras || typeof db.platform.billing.extras !== 'object') {
    db.platform.billing.extras = { whatsappPrice: 0, linkPrice: 0 };
  }
  // Faixas de depósito e saque — bancos anteriores não tinham estes objetos.
  const faixa = (obj, campo, padrao) => {
    if (!obj[campo] || typeof obj[campo] !== 'object') obj[campo] = { ...padrao };
    else {
      if (typeof obj[campo].min !== 'number') obj[campo].min = padrao.min;
      if (typeof obj[campo].max !== 'number') obj[campo].max = padrao.max;
    }
  };
  faixa(db.platform.billing, 'deposit', { min: 1000, max: 0 });
  // O mínimo antigo era R$ 1,00, que não paga nem a taxa do Pix. Quem nunca
  // mexeu no campo sobe para R$ 10; um valor escolhido pelo admin é respeitado.
  if (db.platform.billing.deposit.min === 100) db.platform.billing.deposit.min = 1000;

  faixa(db.platform.affiliate, 'withdraw', { min: 2000, max: 0 });
  // limites (quantidade) + funcionalidades (toggles) de cada plano
  for (const p of db.plans) {
    p.limits = normLimits(p.limits, p.limits);
    p.modules = normFeatures(p.modules, p.modules);
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
  // ---- MULTI-CANAL: a conexão única (acc.wa) vira o canal padrão ----
  if (!Array.isArray(acc.channels) || !acc.channels.length) {
    const ch = emptyChannel('WhatsApp principal');
    // adota o objeto wa existente para não perder token/wabaId da conta antiga
    if (acc.wa && typeof acc.wa === 'object') ch.wa = acc.wa;
    acc.channels = [ch];
  }
  for (const ch of acc.channels) {
    if (!ch.id) ch.id = genId('ch');
    if (typeof ch.label !== 'string' || !ch.label) ch.label = 'WhatsApp';
    if (typeof ch.archived !== 'boolean') ch.archived = false;
    if (!ch.createdAt) ch.createdAt = acc.createdAt || Date.now();
    if (!ch.wa || typeof ch.wa !== 'object') ch.wa = emptyWa();
    const base = emptyWa();
    for (const k of Object.keys(base)) if (ch.wa[k] === undefined) ch.wa[k] = base[k];
    // compat: shape antiga usava token/phoneNumber
    if (ch.wa.token && !ch.wa.accessToken) ch.wa.accessToken = ch.wa.token;
    if (ch.wa.phoneNumber && !ch.wa.displayPhoneNumber) ch.wa.displayPhoneNumber = ch.wa.phoneNumber;
    delete ch.wa.token;
    delete ch.wa.phoneNumber;
    // cache de modelos por canal (contas antigas herdam o cache da conta)
    if (!ch.templatesCache || typeof ch.templatesCache !== 'object') {
      ch.templatesCache = (acc.templatesCache && acc.channels.indexOf(ch) === 0)
        ? acc.templatesCache
        : { fetchedAt: 0, list: [] };
    }
    if (!Array.isArray(ch.templatesCache.list)) ch.templatesCache.list = [];
    if (typeof ch.templatesCache.fetchedAt !== 'number') ch.templatesCache.fetchedAt = 0;
  }
  attachWaAlias(acc);
  attachTplAlias(acc);
  const defCh = acc.channels[0].id;
  if (!Array.isArray(acc.stages) || !acc.stages.length) acc.stages = [...DEFAULT_STAGES];
  if (!Array.isArray(acc.contacts)) acc.contacts = [];
  if (!Array.isArray(acc.messages)) acc.messages = [];
  if (!Array.isArray(acc.campaigns)) acc.campaigns = [];
  if (!Array.isArray(acc.quickReplies)) acc.quickReplies = [];
  // acc.templatesCache agora e apelido do canal padrao (attachTplAlias)
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
  for (const k of ['card', 'extras']) {
    if (!acc.billing[k] || typeof acc.billing[k] !== 'object') acc.billing[k] = eb[k];
    for (const kk of Object.keys(eb[k])) if (acc.billing[k][kk] === undefined) acc.billing[k][kk] = eb[k][kk];
  }
  // contatos e mensagens antigos pertencem ao canal padrão
  for (const c of acc.contacts) if (!c.chId) c.chId = defCh;
  for (const m of acc.messages) if (!m.chId) m.chId = defCh;
  if (acc.billing.status === 'trial' && !acc.billing.periodEnd) {
    acc.billing.periodEnd = (acc.createdAt || Date.now()) + (get().platform.billing.trialDays || 7) * 86400000;
  }
  if (!acc.wallet || typeof acc.wallet !== 'object') acc.wallet = emptyWallet();
  if (!Array.isArray(acc.wallet.transactions)) acc.wallet.transactions = [];
  if (!Array.isArray(acc.wallet.receivables)) acc.wallet.receivables = [];
  for (const k of ['balance', 'pending', 'cardAvailable']) {
    if (typeof acc.wallet[k] !== 'number' || !Number.isFinite(acc.wallet[k])) acc.wallet[k] = 0;
  }
  // recarga automática — contas criadas antes do recurso ganham o campo desligado
  if (!acc.wallet.autoTopup || typeof acc.wallet.autoTopup !== 'object') {
    acc.wallet.autoTopup = emptyWallet().autoTopup;
  } else {
    for (const [k, v] of Object.entries(emptyWallet().autoTopup)) {
      if (acc.wallet.autoTopup[k] === undefined) acc.wallet.autoTopup[k] = v;
    }
  }
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
// Procura em TODOS os canais da conta — o webhook chega pelo phoneNumberId e é
// ele que diz em qual conexão (canal) a mensagem entrou.
function findAccountByPhoneId(phoneNumberId) {
  if (!phoneNumberId) return undefined;
  return get().accounts.find(a => (a.channels || []).some(c => c.wa && c.wa.phoneNumberId === phoneNumberId));
}

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

module.exports = { get, save, load, flush, genId, hash, newAccount, emptyWa, emptyBilling, defaultSurvey, findAccount, findAccountByEmail, findAccountByPhoneId, findAccountByRefCode, findAdminAccount, findLinkBySlug, findWebhookByToken, DEFAULT_STAGES, emptyWallet, attachTplAlias, FEATURE_KEYS, defaultFeatures, normFeatures, LIMIT_KEYS, defaultLimits, normLimits, emptyChannel, chanCtx, findChannel, channelByPhoneId, ensureAccountShape };
