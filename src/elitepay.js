// ============================================================================
// ELITE PAY — pagamentos Pix por cliente (SaaS) via SUBCONTAS do gateway.
//
// Arquitetura DESACOPLADA: toda chamada externa passa pelo "driver" do gateway
// ativo (hoje: Woovi). Para adicionar outro gateway no futuro, basta criar um
// novo driver com a mesma interface — nada do Elite Pay muda.
//
// SPLIT-READY: cada cobrança já calcula e registra a comissão da plataforma
// (platformCut). Quando o admin configurar feeInPercent + splitPixKey, o split
// é enviado ao gateway automaticamente — sem reestruturar o módulo.
// ============================================================================
const crypto = require('crypto');
const db = require('./db');
const store = require('./store');
const woovi = require('./woovi');

// ---------------------------------------------------------------------------
// DRIVERS de gateway — interface única:
//   configured() · createSubaccount({name,pixKey}) · getSubBalance(pixKey)
//   createCharge({correlationID,value,comment,customer,expiresIn,subPixKey,splits})
//   getCharge(correlationID) · cancelCharge(correlationID) · withdraw(pixKey)
// ---------------------------------------------------------------------------
const DRIVERS = {
  woovi: {
    id: 'woovi',
    label: 'Woovi (OpenPix)',
    configured: () => woovi.configured(),
    async createSubaccount({ name, pixKey }) {
      const d = await woovi.call('POST', '/api/v1/subaccount', { name, pixKey });
      const s = d.subAccount || d.subaccount || d;
      return { gatewayId: s.pixKey || pixKey, raw: s };
    },
    // ---- KYC / KYB (fluxo BaaS da Woovi) ----
    // Abre o onboarding com verificação de identidade. A aprovação chega depois
    // pelo webhook ACCOUNT_REGISTER_APPROVED (casado pelo correlationID).
    async submitKyc({ taxID, correlationID, redirectUrl, representatives }) {
      const body = { taxID, correlationID, representatives };
      if (redirectUrl) body.redirectUrl = redirectUrl;
      const d = await woovi.call('POST', '/api/v1/kyc/onboarding', body);
      const o = d.onboarding || d.kyc || d;
      return { onboardingUrl: o.onboardingUrl || o.url || o.redirectUrl || o.link || '', accountId: o.accountId || null, raw: o };
    },
    // Cria a chave Pix da conta aprovada (BaaS) — usa a chave informada no cadastro.
    async createPixKey({ accountId, key, type }) {
      const body = { key, type };
      if (accountId) body.accountId = accountId;
      const d = await woovi.call('POST', '/api/v1/pix-keys', body);
      return d.pixKey || d;
    },
    async getSubBalance(pixKey) {
      try {
        const d = await woovi.call('GET', '/api/v1/subaccount/' + encodeURIComponent(pixKey));
        const s = d.subAccount || d.subaccount || d;
        return Number(s.balance || 0);
      } catch { return null; }
    },
    async withdraw(pixKey) {
      const d = await woovi.call('POST', '/api/v1/subaccount/' + encodeURIComponent(pixKey) + '/withdraw', {});
      return d.transaction || d;
    },
    async createCharge({ correlationID, value, comment, customer, expiresIn, subPixKey, splits }) {
      const body = { correlationID, value, comment: comment || '', expiresIn: expiresIn || 86400 };
      if (customer && (customer.name || customer.phone)) body.customer = customer;
      if (subPixKey) body.subaccount = subPixKey;                 // credita a subconta do cliente
      if (splits && splits.length) body.splits = splits;          // comissão da plataforma (split)
      const d = await woovi.call('POST', '/api/v1/charge', body);
      const c = d.charge || d;
      return {
        gatewayId: c.identifier || c.transactionID || '',
        brCode: c.brCode || '',
        qrCodeImage: c.qrCodeImage || '',
        paymentLinkUrl: c.paymentLinkUrl || c.paymentLinkID || '',
        expiresAt: c.expiresDate ? new Date(c.expiresDate).getTime() : Date.now() + (expiresIn || 86400) * 1000,
        raw: undefined
      };
    },
    async getCharge(correlationID) { return woovi.getCharge(correlationID); },
    async cancelCharge(correlationID) { return woovi.deleteCharge(correlationID); },
    // Cria/atualiza o CLIENTE na Woovi (dados coletados no checkout).
    async createCustomer({ name, taxID, email, phone, correlationID }) {
      const body = { name, taxID, correlationID };
      if (email) body.email = email;
      if (phone) body.phone = phone.startsWith('+') ? phone : '+' + phone;
      const d = await woovi.call('POST', '/api/v1/customer', body);
      return d.customer || d;
    }
  }
};

function platformCfg() {
  const p = db.get().platform;
  if (!p.elitepay) {
    p.elitepay = { gateway: 'woovi', onboardingMode: 'subaccount', feeInPercent: 0, feeOutPercent: 0, splitPixKey: '', requireApproval: false, logs: [] };
  }
  const ep = p.elitepay;
  // onboardingMode: 'subaccount' (chave Pix, KYC via DICT) | 'kyc' (BaaS com KYC/KYB completo)
  if (!ep.onboardingMode) ep.onboardingMode = 'subaccount';
  // Taxas separadas: PIX In (split sobre vendas recebidas) e PIX Out (saques).
  // Migração do antigo feePercent único → feeInPercent.
  if (ep.feeInPercent === undefined) ep.feeInPercent = (ep.feePercent !== undefined ? ep.feePercent : 0);
  if (ep.feeOutPercent === undefined) ep.feeOutPercent = 0;
  delete ep.feePercent;
  return ep;
}
function gateway() { return DRIVERS[platformCfg().gateway] || DRIVERS.woovi; }
function configured() { return gateway().configured(); }

// ---------------------------------------------------------------------------
// URL pública — capturada dos requests da API (para montar o link /pay/:id).
// Persistida em platform.baseUrl para funcionar também fora de um request
// (ex.: cobrança criada por um Flow).
// ---------------------------------------------------------------------------
let _baseUrl = '';
function noteBaseUrl(url) {
  if (!url || url === _baseUrl) return;
  _baseUrl = url;
  const p = db.get().platform;
  if (p.baseUrl !== url) { p.baseUrl = url; db.save(); }
}
function baseUrl() { return _baseUrl || db.get().platform.baseUrl || ''; }
// Link de pagamento da cobrança: o checkout hospedado no EliteChat.
// Fallback: o link do gateway (cobranças antigas / base URL desconhecida).
function payLink(ch) {
  const b = baseUrl();
  return b ? `${b}/pay/${ch.id}` : (ch.paymentLinkUrl || '');
}

// ---------------------------------------------------------------------------
// Estrutura por conta
// ---------------------------------------------------------------------------
// Personalização do checkout público (/pay/:id) — Checkout Builder.
// ---------------------------------------------------------------------------
// PRODUTO — o que é vendido (nome, preço e imagens). O CHECKOUT é só o layout:
// nele o produto entra como VARIÁVEL, então o mesmo template serve para vários
// produtos. Na cobrança o usuário escolhe Produto + Checkout.
// ---------------------------------------------------------------------------
function defaultProduct() {
  return {
    id: '', name: '', description: '', price: 0,     // price em centavos
    banner: '', bannerMobile: '', logo: '', logoMobile: '',
    checkoutId: '',        // checkout preferido deste produto
    active: true, createdAt: Date.now()
  };
}

function defaultCheckout() {
  return {
    id: '', name: 'Checkout padrão', isDefault: true,
    // ---- imagens/textos de FALLBACK (usados quando o produto não tiver os seus) ----
    banner: '',          // capa desktop 1200×360
    bannerMobile: '',    // capa celular  800×500
    logo: '',            // logo desktop  512×512
    logoMobile: '',      // logo celular  256×256 (opcional; cai p/ a desktop)
    title: '',           // nome do produto (fallback: nome do negócio)
    description: '',     // descrição exibida abaixo do título
    color: '#10b981',    // cor de destaque (botões, barra superior)
    successMsg: '',      // mensagem exibida após o pagamento
    supportText: '',     // rodapé: contato/suporte do vendedor
    // ---- blocos opcionais, reordenáveis por arrastar e soltar ----
    blocks: defaultBlocks(),
    timer: { on: false, minutes: 15, text: 'Oferta por tempo limitado!' },
    benefits: { on: false, title: 'O que você recebe', items: [] },
    testimonial: { on: false, name: '', text: '', role: '' },
    guarantee: { on: false, days: 7, text: 'Garantia incondicional de {dias} dias, devolvemos 100% do valor.' },
    faq: { on: false, items: [] },
    notice: { on: false, text: '' },
    badges: { on: true },       // selos de segurança no rodapé
    // formas de pagamento aceitas NESTE checkout. Cartão só surte efeito se o
    // admin ligou o adquirente E o lojista concluiu a conta de cartão (KYC).
    methods: { pix: true, credit: true, boleto: false }
  };
}
// ordem padrão dos blocos do checkout (arrastáveis no builder)
function defaultBlocks() {
  return ['banner', 'timer', 'product', 'notice', 'benefits', 'testimonial', 'guarantee', 'faq'];
}
const BLOCK_KEYS = ['banner', 'timer', 'product', 'notice', 'benefits', 'testimonial', 'guarantee', 'faq'];

// ============================================================================
// PAPÉIS DE TEMPLATE
// Um modelo aprovado na Meta pode ter um papel dentro do Elite Pay:
//   'cobranca'    → enviado ao gerar uma cobrança
//   'confirmacao' → enviado quando o pagamento é confirmado
//   ''            → modelo comum (campanha) — não aparece no Elite Pay
// Os dois papéis são MUTUAMENTE EXCLUSIVOS: um modelo é uma coisa ou outra.
//
// As variáveis de cada papel são fixas e posicionais ({{1}}, {{2}}…), porque é
// assim que a Meta preenche o template no envio.
const TPL_ROLES = ['cobranca', 'confirmacao'];

const TPL_VARS = {
  cobranca: [
    { n: 1, key: 'nome', label: 'Nome do cliente', example: 'Maria Silva' },
    { n: 2, key: 'valor', label: 'Valor da cobrança', example: 'R$ 149,90' },
    { n: 3, key: 'link', label: 'Link de pagamento', example: 'https://pay.elitechat.com.br/abc123' },
    { n: 4, key: 'codigo', label: 'Pix copia e cola', example: '00020126580014BR.GOV.BCB.PIX...' },
    { n: 5, key: 'descricao', label: 'Descrição / produto', example: 'Plano Premium' },
    { n: 6, key: 'vencimento', label: 'Vencimento', example: '31/12/2026' }
  ],
  confirmacao: [
    { n: 1, key: 'nome', label: 'Nome do cliente', example: 'Maria Silva' },
    { n: 2, key: 'valor', label: 'Valor pago', example: 'R$ 149,90' },
    { n: 3, key: 'descricao', label: 'Descrição / produto', example: 'Plano Premium' },
    { n: 4, key: 'data', label: 'Data e hora do pagamento', example: '23/07/2026 14:32' },
    { n: 5, key: 'metodo', label: 'Forma de pagamento', example: 'Pix' },
    { n: 6, key: 'codigo', label: 'Código da transação', example: 'EP-7F3A21' }
  ]
};

// Valores reais das variáveis, na ordem, para uma cobrança concreta.
function tplValues(acc, ch, role) {
  const dt = new Date(ch.paidAt || Date.now());
  const metodo = ch.method === 'card'
    ? `Cartão de ${(ch.card && ch.card.kind) === 'debit' ? 'débito' : 'crédito'}`
    : 'Pix';
  const mapa = {
    nome: ch.contactName || 'cliente',
    valor: fmtBRL(ch.value),
    link: ch.payUrl || payLink(ch) || '',
    codigo: role === 'confirmacao' ? (ch.id || '') : (ch.brCode || ''),
    descricao: ch.comment || 'Pagamento',
    data: dt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    metodo,
    vencimento: ch.expiresAt ? new Date(ch.expiresAt).toLocaleDateString('pt-BR') : ''
  };
  return (TPL_VARS[role] || []).map(v => String(mapa[v.key] == null ? '' : mapa[v.key]));
}

// Papel salvo de um modelo.
function roleOf(acc, name) { return (ensure(acc).templateRoles || {})[name] || ''; }

// Define/limpa o papel de um modelo. Exclusividade garantida aqui: gravar um
// papel simplesmente sobrescreve o anterior — nunca acumula os dois.
function setTemplateRole(acc, name, role, lang) {
  const ep = ensure(acc);
  if (!name) return '';
  if (!TPL_ROLES.includes(role)) {
    delete ep.templateRoles[name];
    // era o selecionado? o Elite Pay volta a não ter modelo designado
    if (ep.chargeTemplateName === name) ep.chargeTemplateName = '';
    if (ep.confirmTemplateName === name) ep.confirmTemplateName = '';
    db.save();
    return '';
  }
  ep.templateRoles[name] = role;
  // Primeiro modelo daquele papel vira o selecionado automaticamente — com um
  // só, não faz sentido obrigar o usuário a escolher.
  if (role === 'cobranca' && !ep.chargeTemplateName) {
    ep.chargeTemplateName = name; ep.chargeTemplateLang = lang || 'pt_BR';
  }
  if (role === 'confirmacao' && !ep.confirmTemplateName) {
    ep.confirmTemplateName = name; ep.confirmTemplateLang = lang || 'pt_BR';
  }
  db.save();
  return role;
}

// Modelos APROVADOS de um papel — é a lista que o Elite Pay oferece para escolha.
function templatesByRole(acc, role) {
  const ep = ensure(acc);
  const list = (acc.templatesCache && acc.templatesCache.list) || [];
  return list
    .filter(t => (ep.templateRoles || {})[t.name] === role)
    .map(t => ({
      name: t.name,
      language: t.language || 'pt_BR',
      status: t.status || '',
      approved: /APPROVED/i.test(t.status || ''),
      body: ((t.components || []).find(c => String(c.type || '').toUpperCase() === 'BODY') || {}).text || '',
      vars: (((t.components || []).find(c => String(c.type || '').toUpperCase() === 'BODY') || {}).text || '')
        .match(/\{\{\s*\d+\s*\}\}/g) || []
    }));
}

// O modelo efetivamente usado para um papel: o selecionado, se aprovado;
// senão o primeiro aprovado daquele papel (evita ficar sem enviar por engano).
function pickTemplate(acc, role) {
  const ep = ensure(acc);
  const escolhido = role === 'cobranca' ? ep.chargeTemplateName : ep.confirmTemplateName;
  const aprovados = templatesByRole(acc, role).filter(t => t.approved);
  return aprovados.find(t => t.name === escolhido) || aprovados[0] || null;
}

function ensure(acc) {
  if (!acc.elitepay) {
    acc.elitepay = {
      subaccount: null,   // { status, name, document, email, phone, pixKey, pixKeyType, gatewayId, synced, createdAt, approvedAt }
      settings: {
        chargeTemplateEnabled: true,   // usa o Template de Cobrança (senão, mensagem padrão)
        autoMessage: 'Olá {nome}! 💳 Aqui está sua cobrança de {valor}.\n{descricao}\nPague pelo link: {link}\n\nOu use o Pix copia e cola:\n{codigo}',
        expiresMin: 1440,       // 24h
        notifyPaid: true        // envia confirmação no WhatsApp quando pago
      },
      templateRoles: {},        // nome do modelo -> 'cobranca' | 'confirmacao'
      chargeTemplateName: '', chargeTemplateLang: 'pt_BR',
      confirmTemplateName: '', confirmTemplateLang: 'pt_BR',
      checkout: defaultCheckout(),
      charges: [],
      logs: []
    };
  }
  if (!acc.elitepay.checkout) acc.elitepay.checkout = defaultCheckout();
  // migração: contas antigas ganham os campos novos sem perder o que já tinham
  const ck = acc.elitepay.checkout, d = defaultCheckout();
  for (const k in d) if (ck[k] === undefined) ck[k] = d[k];
  if (!Array.isArray(ck.blocks) || !ck.blocks.length) ck.blocks = defaultBlocks();
  else { for (const b of BLOCK_KEYS) if (!ck.blocks.includes(b)) ck.blocks.push(b); }

  // ---- PRODUTOS + CHECKOUTS (múltiplos templates) ----
  const ep = acc.elitepay;
  // ---- Papéis dos modelos (contas antigas ganham os campos novos) ----
  if (!ep.templateRoles || typeof ep.templateRoles !== 'object') ep.templateRoles = {};
  for (const k of ['chargeTemplateName', 'confirmTemplateName']) if (typeof ep[k] !== 'string') ep[k] = '';
  for (const k of ['chargeTemplateLang', 'confirmTemplateLang']) if (typeof ep[k] !== 'string') ep[k] = 'pt_BR';
  // o modelo de cobrança que já estava designado passa a ter papel explícito
  if (ep.chargeTemplateName && !ep.templateRoles[ep.chargeTemplateName]) {
    ep.templateRoles[ep.chargeTemplateName] = 'cobranca';
  }
  if (!Array.isArray(ep.products)) ep.products = [];
  if (!Array.isArray(ep.checkouts) || !ep.checkouts.length) {
    // o checkout único que já existia vira o primeiro template da lista
    ck.id = ck.id || db.genId('ckt');
    ck.name = ck.name || 'Checkout padrão';
    ck.isDefault = true;
    ep.checkouts = [ck];
    // se ele já tinha produto configurado (título/imagens), vira o 1º produto
    if (!ep.products.length && (ck.title || ck.logo || ck.banner)) {
      ep.products.push({
        ...defaultProduct(), id: db.genId('prd'),
        name: ck.title || 'Meu produto', description: ck.description || '',
        banner: ck.banner || '', bannerMobile: ck.bannerMobile || '',
        logo: ck.logo || '', logoMobile: ck.logoMobile || '',
        checkoutId: ck.id
      });
    }
  }
  for (const c of ep.checkouts) {
    for (const k in d) if (c[k] === undefined) c[k] = d[k];
    if (!c.id) c.id = db.genId('ckt');
    if (!Array.isArray(c.blocks) || !c.blocks.length) c.blocks = defaultBlocks();
  }
  if (!ep.checkouts.some(c => c.isDefault)) ep.checkouts[0].isDefault = true;
  for (const p of ep.products) { const dp = defaultProduct(); for (const k in dp) if (p[k] === undefined) p[k] = dp[k]; }
  return acc.elitepay;
}

function log(acc, entry) {
  const ep = ensure(acc);
  ep.logs.unshift({ id: db.genId('epl'), ts: Date.now(), ...entry });
  if (ep.logs.length > 400) ep.logs.length = 400;
}
function plog(entry) {
  const cfg = platformCfg();
  cfg.logs.unshift({ id: db.genId('eppl'), ts: Date.now(), ...entry });
  if (cfg.logs.length > 600) cfg.logs.length = 600;
}

// ---------------------------------------------------------------------------
// SUBCONTA — cadastro, sincronização com o gateway e aprovação
// ---------------------------------------------------------------------------
const PIX_TYPES = ['cpf', 'cnpj', 'email', 'telefone', 'aleatoria'];

function validateOnboarding(f, mode) {
  const errs = [];
  if (!String(f.name || '').trim() || String(f.name).trim().length < 3) errs.push('Nome/Razão social inválido');
  const doc = String(f.document || '').replace(/\D/g, '');
  if (doc.length !== 11 && doc.length !== 14) errs.push('CPF/CNPJ inválido');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(f.email || ''))) errs.push('E-mail inválido');
  const phone = String(f.phone || '').replace(/\D/g, '');
  if (phone.length < 10) errs.push('Telefone inválido');
  if (!String(f.pixKey || '').trim()) errs.push('Chave Pix obrigatória');
  if (!PIX_TYPES.includes(f.pixKeyType)) errs.push('Tipo de chave Pix inválido');
  // KYC/KYB (BaaS): exige o representante legal (nome + CPF)
  if (mode === 'kyc') {
    if (!String(f.repName || '').trim() || String(f.repName).trim().length < 3) errs.push('Nome do representante legal inválido');
    const rep = String(f.repDocument || '').replace(/\D/g, '');
    if (rep.length !== 11) errs.push('CPF do representante legal inválido');
  }
  return errs;
}

// Cria/atualiza a subconta no gateway (idempotente pela chave Pix).
async function syncSubaccount(acc) {
  const ep = ensure(acc);
  const sub = ep.subaccount;
  if (!sub || sub.synced) return sub;
  if (!configured()) return sub; // sincroniza depois, quando o admin configurar o gateway
  const r = await gateway().createSubaccount({ name: sub.name, pixKey: sub.pixKey });
  sub.gatewayId = r.gatewayId;
  sub.synced = true;
  db.save();
  return sub;
}

async function registerSubaccount(acc, fields) {
  const ep = ensure(acc);
  if (ep.subaccount && ep.subaccount.status !== 'rejected') {
    const e = new Error('Esta conta já possui uma subconta Elite Pay'); e.status = 400; throw e;
  }
  const cfg = platformCfg();
  const mode = cfg.onboardingMode === 'kyc' ? 'kyc' : 'subaccount';
  const errs = validateOnboarding(fields, mode);
  if (errs.length) { const e = new Error(errs.join(' · ')); e.status = 400; throw e; }

  const base = {
    mode,
    name: String(fields.name).trim().slice(0, 120),
    document: String(fields.document).replace(/\D/g, ''),
    email: String(fields.email).trim().toLowerCase().slice(0, 140),
    phone: String(fields.phone).replace(/\D/g, '').slice(0, 15),
    pixKey: String(fields.pixKey).trim().slice(0, 140),
    pixKeyType: fields.pixKeyType,
    repName: String(fields.repName || '').trim().slice(0, 120),
    repDocument: String(fields.repDocument || '').replace(/\D/g, ''),
    gatewayId: null, synced: false, createdAt: Date.now(), approvedAt: null
  };

  // ---- Modo KYC/KYB (BaaS): abre o onboarding com verificação e aguarda aprovação ----
  if (mode === 'kyc') {
    ep.subaccount = { ...base, status: 'pending', kyc: {
      status: 'submitting', correlationID: `epkyc-${acc.id}-${crypto.randomBytes(5).toString('hex')}`,
      onboardingUrl: '', accountId: null, redirectUrl: String(fields.redirectUrl || '').slice(0, 300),
      submittedAt: Date.now(), approvedAt: null
    } };
    db.save();
    if (configured()) {
      try {
        const r = await gateway().submitKyc({
          taxID: base.document, correlationID: ep.subaccount.kyc.correlationID,
          redirectUrl: ep.subaccount.kyc.redirectUrl,
          representatives: [{ name: base.repName, taxID: base.repDocument }]
        });
        ep.subaccount.kyc.status = 'onboarding';
        ep.subaccount.kyc.onboardingUrl = r.onboardingUrl || '';
        if (r.accountId) ep.subaccount.kyc.accountId = r.accountId;
      } catch (e) {
        ep.subaccount.kyc.status = 'error';
        log(acc, { type: 'kyc_error', detail: 'Falha ao abrir o KYC: ' + e.message });
      }
    } else {
      ep.subaccount.kyc.status = 'awaiting_gateway';
    }
    log(acc, { type: 'kyc_started', detail: `KYC iniciado, ${ep.subaccount.kyc.status}` });
    plog({ type: 'kyc_started', accountId: acc.id, accountName: acc.name, mode: 'kyc' });
    db.save();
    return ep.subaccount;
  }

  // ---- Modo subconta simples (chave Pix; KYC delegado à validação DICT) ----
  ep.subaccount = { ...base, status: cfg.requireApproval ? 'pending' : 'active', approvedAt: cfg.requireApproval ? null : Date.now() };
  log(acc, { type: 'subaccount_created', detail: ep.subaccount.status === 'active' ? 'Subconta criada e ativada' : 'Subconta aguardando aprovação' });
  plog({ type: 'subaccount_created', accountId: acc.id, accountName: acc.name, status: ep.subaccount.status });
  db.save();
  if (ep.subaccount.status === 'active') {
    try { await syncSubaccount(acc); }
    catch (e) { log(acc, { type: 'gateway_error', detail: 'Sincronização adiada: ' + e.message }); }
  }
  return ep.subaccount;
}

// Webhook ACCOUNT_REGISTER_APPROVED (BaaS): compliance aprovou → ativa a conta.
function applyAccountApproved(payload, broadcast) {
  const cid = (payload && payload.correlationID) || '';
  if (!cid) return { ok: false };
  const acc = db.get().accounts.find(a => a.elitepay && a.elitepay.subaccount &&
    a.elitepay.subaccount.kyc && a.elitepay.subaccount.kyc.correlationID === cid);
  if (!acc) { store.logEvent({ type: 'elitepay_kyc_unmatched', correlationID: cid }); return { ok: false }; }
  const sub = acc.elitepay.subaccount;
  if (sub.status === 'active') return { ok: true, duplicate: true };
  sub.kyc.status = 'approved';
  sub.kyc.approvedAt = Date.now();
  if (payload.accountId) sub.kyc.accountId = payload.accountId;
  if (payload.officialName) sub.name = payload.officialName;
  sub.status = 'active';
  sub.approvedAt = Date.now();
  log(acc, { type: 'kyc_approved', detail: `KYC aprovado, conta ${payload.accountId || ''} ativada` });
  plog({ type: 'kyc_approved', accountId: acc.id, accountName: acc.name });
  db.save();
  // registra a chave Pix informada na conta recém-aprovada (BaaS)
  if (configured() && sub.pixKey) {
    (async () => {
      try { await gateway().createPixKey({ accountId: sub.kyc.accountId, key: sub.pixKey, type: sub.pixKeyType }); sub.synced = true; db.save(); }
      catch (e) { log(acc, { type: 'gateway_error', detail: 'Chave Pix adiada: ' + e.message }); db.save(); }
    })();
  }
  if (broadcast) broadcast('elitepay', { accountId: acc.id, kind: 'subaccount', status: 'active' });
  return { ok: true, acc };
}

async function setSubaccountStatus(acc, status) {
  const ep = ensure(acc);
  if (!ep.subaccount) { const e = new Error('Conta sem subconta'); e.status = 404; throw e; }
  ep.subaccount.status = status;
  if (status === 'active' && !ep.subaccount.approvedAt) ep.subaccount.approvedAt = Date.now();
  log(acc, { type: 'subaccount_' + status, detail: `Status alterado para ${status}` });
  plog({ type: 'subaccount_' + status, accountId: acc.id, accountName: acc.name });
  db.save();
  if (status === 'active') { try { await syncSubaccount(acc); } catch {} }
  return ep.subaccount;
}

// ---------------------------------------------------------------------------
// COBRANÇAS
// ---------------------------------------------------------------------------
function activeSubaccount(acc) {
  const ep = ensure(acc);
  if (!ep.subaccount) { const e = new Error('Crie sua conta Elite Pay primeiro'); e.status = 400; throw e; }
  if (ep.subaccount.status !== 'active') { const e = new Error('Sua conta Elite Pay ainda não está ativa'); e.status = 400; throw e; }
  return ep.subaccount;
}

// Taxa de PIX In (split retido sobre a venda recebida pelo cliente).
function computeSplit(valueCents) {
  const cfg = platformCfg();
  const pct = Number(cfg.feeInPercent) || 0;
  const cut = Math.floor(valueCents * pct / 100);
  return { feePercent: pct, platformCut: cut };
}
// Taxa de PIX Out (retida no saque do cliente) — usada quando o saque for feito.
function computeOutFee(valueCents) {
  const cfg = platformCfg();
  const pct = Number(cfg.feeOutPercent) || 0;
  return { feeOutPercent: pct, fee: Math.floor(valueCents * pct / 100) };
}

// ---------------------------------------------------------------------------
// CARTEIRA — taxa de saque combinada.
//
// O saldo mistura dinheiro de Pix e de cartão, e cada origem tem a sua taxa de
// saque. Sacamos primeiro o dinheiro de CARTÃO (o mais "caro" de reter parado),
// e a taxa sai proporcional a cada parte. Assim o cliente sempre vê de onde
// veio cada centavo da taxa.
function computeWithdrawFee(acc, valueCents) {
  const card = cardConfig();
  const doCartao = Math.min(valueCents, Math.max(0, Number(acc.wallet.cardAvailable) || 0));
  const doPix = Math.max(0, valueCents - doCartao);

  const fCard = doCartao > 0 ? cards.computeCardOutFee(card, doCartao) : { fee: 0, feePercent: card.feeOutCardPercent || 0, feeFixed: 0 };
  const fPix = computeOutFee(doPix);

  const fee = Math.min(valueCents, (doCartao > 0 ? fCard.fee : 0) + fPix.fee);
  return {
    fee,
    net: valueCents - fee,
    fromCard: doCartao, fromPix: doPix,
    cardFee: doCartao > 0 ? fCard.fee : 0, pixFee: fPix.fee,
    cardPercent: Number(card.feeOutCardPercent) || 0,
    cardFixed: Number(card.feeOutCardFixed) || 0,
    pixPercent: fPix.feeOutPercent
  };
}

// Debita um saque da carteira, consumindo primeiro a parte vinda de cartão.
function debitWithdraw(acc, valueCents) {
  const w = acc.wallet;
  const doCartao = Math.min(valueCents, Math.max(0, Number(w.cardAvailable) || 0));
  w.balance -= valueCents;
  w.cardAvailable = Math.max(0, (Number(w.cardAvailable) || 0) - doCartao);
  db.save();
  return { fromCard: doCartao };
}

// ---------------------------------------------------------------------------
// RECEBÍVEIS — a venda no cartão entra como "a liberar" e vira saldo no prazo
// do adquirente (Pagar.me D+30 crédito / D+1 débito; Asaas D+32 / D+3).
// ---------------------------------------------------------------------------
function creditCardSale(acc, ch, broadcast) {
  const card = cardConfig();
  if (card.settleMode !== 'wallet') return null;    // modo split: o dinheiro vai direto ao lojista

  const liquido = Math.max(0, ch.value - (ch.platformCut || 0));
  if (liquido <= 0) return null;

  const kind = (ch.card && ch.card.kind) === 'debit' ? 'debit' : 'credit';
  const parcelas = (ch.card && ch.card.installments) || 1;
  const regra = cards.settleRule(card, kind);

  // Cronograma IGUAL ao da adquirente: crédito parcelado libera uma parcela por
  // mês (D+30/D+60… no Pagar.me, D+32/D+64… no Asaas); débito, de uma vez em
  // dias úteis. Nada aqui é configurável — é a regra deles.
  const agenda = cards.settleSchedule(card, kind, liquido, parcelas, Date.now());
  const criados = [];
  for (const p of agenda) {
    const rec = {
      id: db.genId('rcv'),
      chargeId: ch.id,
      amount: p.amount,
      kind,
      installment: p.installment,
      installments: p.of,
      createdAt: Date.now(),
      availableAt: p.availableAt,
      released: false
    };
    acc.wallet.receivables.push(rec);
    criados.push(rec);
  }
  acc.wallet.pending += liquido;

  const quando = agenda.length > 1
    ? `${agenda.length}x, de ${new Date(agenda[0].availableAt).toLocaleDateString('pt-BR')} a ${new Date(agenda[agenda.length - 1].availableAt).toLocaleDateString('pt-BR')}`
    : `libera em ${new Date(agenda[0].availableAt).toLocaleDateString('pt-BR')}`;
  acc.wallet.transactions.push({
    id: db.genId('tx'), ts: Date.now(), amount: liquido, type: 'card_sale', pending: true,
    label: `Venda no cartão (${kind === 'debit' ? 'débito' : 'crédito'}${parcelas > 1 ? ` ${parcelas}x` : ''}), ${quando}`
  });
  if (acc.wallet.transactions.length > 400) acc.wallet.transactions.splice(0, acc.wallet.transactions.length - 400);
  db.save();
  log(acc, {
    type: 'card_receivable', chargeId: ch.id, amount: liquido,
    detail: `${cards.SETTLE_RULES[card.provider].label} · ${regra.text} · ${quando}`
  });
  if (broadcast) broadcast('wallet', { accountId: acc.id });
  return criados;
}

// Libera os recebíveis vencidos de UMA conta. Retorna quanto foi liberado.
function releaseFor(acc, broadcast) {
  const w = acc.wallet;
  const agora = Date.now();
  let total = 0;
  for (const r of w.receivables) {
    if (r.released || r.availableAt > agora) continue;
    r.released = true;
    r.releasedAt = agora;
    total += r.amount;
    w.balance += r.amount;
    w.cardAvailable = (Number(w.cardAvailable) || 0) + r.amount;
    w.pending = Math.max(0, w.pending - r.amount);
    w.transactions.push({
      id: db.genId('tx'), ts: agora, amount: r.amount, type: 'card_release',
      label: `Venda no cartão liberada para saque (${r.kind === 'debit' ? 'débito' : 'crédito'}${r.installments > 1 ? ` · parcela ${r.installment}/${r.installments}` : ''})`
    });
  }
  // guarda só os últimos 500 recebíveis já liberados (histórico enxuto)
  const liberados = w.receivables.filter(r => r.released);
  if (liberados.length > 500) {
    const cortar = liberados.slice(0, liberados.length - 500).map(r => r.id);
    w.receivables = w.receivables.filter(r => !cortar.includes(r.id));
  }
  if (total > 0) {
    db.save();
    log(acc, { type: 'card_released', amount: total, detail: 'Recebíveis liberados' });
    if (broadcast) broadcast('wallet', { accountId: acc.id });
  }
  return total;
}

// Varredura de todas as contas — roda de hora em hora (server.js).
function releaseReceivables(broadcast) {
  let contas = 0, total = 0;
  for (const acc of db.get().accounts) {
    if (!acc.wallet || !acc.wallet.receivables || !acc.wallet.receivables.length) continue;
    const v = releaseFor(acc, broadcast);
    if (v > 0) { contas++; total += v; }
  }
  if (total > 0) plog({ type: 'card_release_batch', accounts: contas, amount: total });
  return { contas, total };
}

// Debita a carteira para pagar algo DENTRO da plataforma (plano, conexão
// WhatsApp extra, link rastreável…). É a razão de o saldo existir.
function spendWallet(acc, valueCents, label, broadcast) {
  const v = Math.max(0, Math.round(valueCents));
  const w = acc.wallet;
  if (w.balance < v) {
    const e = new Error(`Saldo insuficiente na carteira, disponível ${fmtBRL(w.balance)}, necessário ${fmtBRL(v)}`);
    e.status = 402; e.code = 'saldo'; throw e;
  }
  const doCartao = Math.min(v, Math.max(0, Number(w.cardAvailable) || 0));
  w.balance -= v;
  w.cardAvailable = Math.max(0, (Number(w.cardAvailable) || 0) - doCartao);
  w.transactions.push({ id: db.genId('tx'), ts: Date.now(), amount: -v, type: 'spend', label });
  db.save();
  if (broadcast) broadcast('wallet', { accountId: acc.id });
  return { ok: true, spent: v, balance: w.balance };
}

function findCharge(acc, id) { return ensure(acc).charges.find(c => c.id === id || c.correlationID === id); }

async function createCharge(acc, { valueCents, comment, waId, contactName, origin, byName, expiresMin, productId, checkoutId }) {
  const sub = activeSubaccount(acc);
  // Produto escolhido preenche valor e descrição quando não vierem explícitos
  const prod = productId ? findProduct(acc, productId) : null;
  if (prod) {
    if (!valueCents && prod.price) valueCents = prod.price;
    if (!comment) comment = prod.name;
    if (!checkoutId && prod.checkoutId) checkoutId = prod.checkoutId;
  }
  valueCents = Math.round(Number(valueCents) || 0);
  if (valueCents < 100) { const e = new Error('Valor mínimo: R$ 1,00'); e.status = 400; throw e; }
  if (!configured()) { const e = new Error('Gateway de pagamento não configurado. Peça ao administrador em Admin, Pagamentos'); e.status = 400; throw e; }

  const ep = ensure(acc);
  const { feePercent, platformCut } = computeSplit(valueCents);
  const cfg = platformCfg();
  const correlationID = `ep-${acc.id}-${crypto.randomBytes(6).toString('hex')}`;
  const expiresIn = Math.max(300, (Number(expiresMin) || ep.settings.expiresMin || 1440) * 60);

  // split da plataforma: só entra no payload quando configurado (arquitetura pronta)
  const splits = (platformCut > 0 && cfg.splitPixKey) ? [{ pixKey: cfg.splitPixKey, value: platformCut }] : null;

  const g = await gateway().createCharge({
    correlationID, value: valueCents, comment: (comment || '').slice(0, 140),
    customer: contactName ? { name: contactName, phone: waId ? '+' + waId : undefined } : null,
    expiresIn, subPixKey: sub.pixKey, splits
  });

  const ch = {
    id: db.genId('epc'),
    correlationID,
    status: 'active',                          // active | paid | cancelled | expired
    value: valueCents, comment: (comment || '').slice(0, 140),
    waId: waId || null, contactName: contactName || null,
    brCode: g.brCode, qrCodeImage: g.qrCodeImage, paymentLinkUrl: g.paymentLinkUrl,
    createdAt: Date.now(), paidAt: null, expiresAt: g.expiresAt,
    origin: origin || 'manual', byName: byName || null,
    productId: prod ? prod.id : '', checkoutId: checkoutId || '',
    feePercent, platformCut, gateway: gateway().id, gatewayId: g.gatewayId
  };
  ch.payUrl = payLink(ch);   // link enviado ao cliente → checkout hospedado (/pay/:id)
  ep.charges.unshift(ch);
  if (ep.charges.length > 2000) ep.charges.length = 2000;
  log(acc, { type: 'charge_created', chargeId: ch.id, amount: valueCents, detail: `Cobrança criada (${origin || 'manual'})${byName ? ' por ' + byName : ''}` });
  plog({ type: 'charge_created', accountId: acc.id, accountName: acc.name, amount: valueCents, fee: platformCut });
  db.save();
  return ch;
}

async function cancelCharge(acc, id) {
  const ch = findCharge(acc, id);
  if (!ch) { const e = new Error('Cobrança não encontrada'); e.status = 404; throw e; }
  if (ch.status !== 'active') { const e = new Error('Só cobranças ativas podem ser canceladas'); e.status = 400; throw e; }
  try { await gateway().cancelCharge(ch.correlationID); } catch {}
  ch.status = 'cancelled';
  ch.cancelledAt = Date.now();
  log(acc, { type: 'charge_cancelled', chargeId: ch.id, amount: ch.value, detail: 'Cobrança cancelada' });
  plog({ type: 'charge_cancelled', accountId: acc.id, accountName: acc.name, amount: ch.value });
  db.save();
  return ch;
}

// Texto da cobrança enviado no WhatsApp (placeholders simples)
const DEFAULT_CHARGE_MSG = 'Olá {nome}! Sua cobrança de {valor} está pronta.\n{descricao}\nPague pelo link: {link}\n\nOu use o Pix copia e cola:\n{codigo}';
function chargeMessage(acc, ch) {
  const ep = ensure(acc);
  // Template de Cobrança ativo → usa o modelo do usuário; senão, a mensagem padrão.
  const tpl = (ep.settings.chargeTemplateEnabled === false)
    ? DEFAULT_CHARGE_MSG
    : (ep.settings.autoMessage || DEFAULT_CHARGE_MSG);
  return tpl
    .replace(/\{nome\}/g, ch.contactName || 'cliente')
    .replace(/\{valor\}/g, fmtBRL(ch.value))
    .replace(/\{descricao\}/g, ch.comment || '')
    .replace(/\{link\}/g, ch.payUrl || payLink(ch))
    .replace(/\{codigo\}/g, ch.brCode || '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function fmtBRL(cents) { return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

// ---------------------------------------------------------------------------
// IDENTIFICAÇÃO DO PAGADOR (etapa 1 do checkout público)
// Cria o cliente na Woovi, cadastra/atualiza o CONTATO no EliteChat e
// registra os eventos na pipeline (funil) — tudo automático.
// ---------------------------------------------------------------------------
function normalizePayerPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  // números BR digitados sem DDI ganham o 55 (padrão do WhatsApp waId)
  if ((d.length === 10 || d.length === 11) && !d.startsWith('55')) d = '55' + d;
  return d;
}

function validatePayer(f) {
  const errs = [];
  if (!String(f.name || '').trim() || String(f.name).trim().length < 3) errs.push('Informe seu nome completo');
  const doc = String(f.taxID || '').replace(/\D/g, '');
  if (doc.length !== 11 && doc.length !== 14) errs.push('CPF/CNPJ inválido');
  else if (/^(\d)\1+$/.test(doc)) errs.push('CPF/CNPJ inválido');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(f.email || ''))) errs.push('E-mail inválido');
  const phone = normalizePayerPhone(f.phone);
  if (phone.length < 12 || phone.length > 15) errs.push('Celular/WhatsApp inválido');
  return { errs, doc, phone };
}

function findChargeAnywhere(id) {
  id = String(id || '');
  for (const acc of db.get().accounts) {
    if (!acc.elitepay) continue;
    const ch = (acc.elitepay.charges || []).find(c => c.id === id || c.correlationID === id);
    if (ch) return { acc, ch };
  }
  return null;
}

async function identifyPayer(chargeId, fields, broadcast) {
  const found = findChargeAnywhere(chargeId);
  if (!found) { const e = new Error('Cobrança não encontrada'); e.status = 404; throw e; }
  const { acc, ch } = found;
  if (ch.status !== 'active') { const e = new Error('Esta cobrança não está mais aberta para pagamento'); e.status = 400; throw e; }
  if (ch.expiresAt && ch.expiresAt < Date.now()) { const e = new Error('Esta cobrança expirou'); e.status = 400; throw e; }

  const { errs, doc, phone } = validatePayer(fields || {});
  if (errs.length) { const e = new Error(errs.join(' · ')); e.status = 400; throw e; }

  const name = String(fields.name).trim().slice(0, 120);
  const email = String(fields.email).trim().toLowerCase().slice(0, 140);
  ch.payer = { name, taxID: doc, email, phone, at: Date.now() };
  if (!ch.contactName) ch.contactName = name;

  // Tracking: guarda os dados de origem capturados na página do checkout
  // (fbclid/gclid/ttclid, UTMs e sessão) e vincula a sessão ao cliente.
  if (fields.trk && typeof fields.trk === 'object') {
    const trk = fields.trk;
    ch.trk = {
      sid: String(trk.sid || '').slice(0, 64),
      fbclid: String(trk.fbclid || '').slice(0, 200), gclid: String(trk.gclid || '').slice(0, 200), ttclid: String(trk.ttclid || '').slice(0, 200),
      utm: {}
    };
    for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
      if (trk.utm && trk.utm[k]) ch.trk.utm[k] = String(trk.utm[k]).slice(0, 120);
    }
    try { require('./tracking').upsertSession(acc, { ...ch.trk, waId: phone, email, doc }); } catch {}
  }

  // 1) CONTATO no EliteChat — telefone é o identificador; nunca duplica.
  //    Novo → entra na etapa padrão do funil; existente → só preenche vazios.
  const contact = store.upsertContact(acc, phone, name, {
    email,
    source: { type: 'checkout', id: ch.id, headline: 'Checkout Elite Pay', body: ch.comment || '', ts: Date.now() }
  });
  if (!contact.email) contact.email = email;
  contact.vars = contact.vars || {};
  if (!contact.vars.cpf_cnpj) contact.vars.cpf_cnpj = doc;
  if (!contact.tags.includes('Checkout')) contact.tags.push('Checkout');
  if (!ch.waId) ch.waId = contact.waId;

  // 2) CLIENTE na Woovi (API /customer) — casado por taxID; não bloqueia o pagamento.
  ch.payerSynced = false;
  if (configured()) {
    try {
      await gateway().createCustomer({ name, taxID: doc, email, phone, correlationID: `cus-${acc.id}-${doc}` });
      ch.payerSynced = true;
    } catch (e) {
      log(acc, { type: 'customer_error', chargeId: ch.id, detail: 'Cliente Woovi adiado: ' + e.message });
    }
  }

  // 3) EVENTOS — trilha no Elite Pay + log da plataforma + tempo real no painel
  log(acc, { type: 'payer_identified', chargeId: ch.id, amount: ch.value, detail: `${name} preencheu os dados no checkout (${fmtCpfCnpj(doc)})` });
  store.logEvent({ type: 'elitepay_checkout_identify', accountId: acc.id, chargeId: ch.id, waId: contact.waId });
  db.save();
  if (broadcast) {
    broadcast('elitepay', { accountId: acc.id, kind: 'charge', chargeId: ch.id, status: 'identified', contactName: name });
    broadcast('contact', { accountId: acc.id, waId: contact.waId });
  }
  return { acc, ch, contact };
}

function fmtCpfCnpj(d) {
  d = String(d || '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

// Pipeline pós-pagamento: contato vira "Ganho" no funil + tag Cliente.
function advancePipelineOnPaid(acc, ch) {
  const waId = ch.waId || (ch.payer && ch.payer.phone);
  if (!waId) return;
  const contact = store.findContact(acc, waId);
  if (!contact) return;
  const stages = acc.stages || [];
  if (stages.includes('Ganho') && contact.stage !== 'Ganho') {
    const from = contact.stage;
    contact.stage = 'Ganho';
    log(acc, { type: 'pipeline_moved', chargeId: ch.id, detail: `${contact.name}: ${from} → Ganho (pagamento confirmado)` });
  }
  contact.tags = contact.tags || [];
  if (!contact.tags.includes('Cliente')) contact.tags.push('Cliente');
}

// ---------------------------------------------------------------------------
// CHECKOUT PÚBLICO — dados sanitizados servidos em /api/public/pay/:id
// (sem autenticação: expõe SOMENTE o necessário para pagar a cobrança).
// ---------------------------------------------------------------------------
function findProduct(acc, id) { return ensure(acc).products.find(p => p.id === id) || null; }
function findCheckout(acc, id) {
  const ep = ensure(acc);
  return ep.checkouts.find(c => c.id === id) || ep.checkouts.find(c => c.isDefault) || ep.checkouts[0];
}

// Resolve a página final: LAYOUT vem do checkout, CONTEÚDO vem do produto.
// (o produto substitui as variáveis; sem produto, usa o fallback do checkout)
function checkoutBranding(acc, opts) {
  const ep = ensure(acc);
  const o = opts || {};
  const ck = findCheckout(acc, o.checkoutId) || defaultCheckout();
  const prod = o.productId ? findProduct(acc, o.productId) : null;
  const sub = ep.subaccount || {};
  const pick = (a, b) => (a && String(a).trim()) ? a : (b || '');
  return {
    // ---- variáveis do PRODUTO (com fallback no checkout) ----
    banner: pick(prod && prod.banner, ck.banner),
    bannerMobile: pick(prod && prod.bannerMobile, ck.bannerMobile),
    logo: pick(prod && prod.logo, ck.logo),
    logoMobile: pick(prod && prod.logoMobile, ck.logoMobile),
    title: pick(prod && prod.name, ck.title),
    description: pick(prod && prod.description, ck.description),
    // ---- layout do CHECKOUT ----
    color: /^#[0-9a-fA-F]{3,8}$/.test(ck.color || '') ? ck.color : '#10b981',
    successMsg: ck.successMsg || '', supportText: ck.supportText || '',
    merchant: sub.name || acc.name || '',
    blocks: Array.isArray(ck.blocks) && ck.blocks.length ? ck.blocks : defaultBlocks(),
    timer: ck.timer || {}, benefits: ck.benefits || {}, testimonial: ck.testimonial || {},
    guarantee: ck.guarantee || {}, faq: ck.faq || {}, notice: ck.notice || {}, badges: ck.badges || {},
    methods: Object.assign({ pix: true, credit: true, boleto: false }, ck.methods || {}),
    checkoutName: ck.name || '', productId: prod ? prod.id : '', checkoutId: ck.id || ''
  };
}

function publicChargeView(id) {
  id = String(id || '');
  // Modo demo (preview do Checkout Builder): /pay/demo-<accountId>
  if (id.startsWith('demo-')) {
    // /pay/demo-<accId>[:checkoutId[:productId]] — prévia do builder
    const parts = id.slice(5).split(':');
    const acc = db.findAccount(parts[0]);
    if (!acc || !acc.elitepay) return null;
    const prod = parts[2] ? findProduct(acc, parts[2]) : null;
    return {
      demo: true, id, status: 'active',
      value: (prod && prod.price) || 9700, comment: (prod && prod.name) || 'Exemplo: Plano mensal',
      brCode: '00020126580014BR.GOV.BCB.PIX0136demo-elitechat-checkout-preview520400005303986540597.005802BR5909ELITECHAT6009SAO PAULO62070503***6304DEMO',
      qrCodeImage: '', createdAt: Date.now(), paidAt: null,
      expiresAt: Date.now() + 86400000,
      needsId: true, prefill: { name: '', phone: '' },
      checkout: checkoutBranding(acc, { checkoutId: parts[1] || '', productId: parts[2] || '' })
    };
  }
  const found = findChargeAnywhere(id);
  if (!found) return null;
  const { acc, ch } = found;
  // expiração exibida em tempo real (o status persistido muda via sweep/webhook)
  const status = (ch.status === 'active' && ch.expiresAt && ch.expiresAt < Date.now()) ? 'expired' : ch.status;
  return {
    id: ch.id, status, accId: acc.id,
    value: ch.value, comment: ch.comment || '',
    brCode: ch.brCode || '', qrCodeImage: ch.qrCodeImage || '',
    createdAt: ch.createdAt, paidAt: ch.paidAt, expiresAt: ch.expiresAt,
    // etapa 1 (identificação) pendente? pré-preenche o que a cobrança já sabe
    needsId: !ch.payer,
    prefill: { name: ch.contactName || '', phone: ch.waId || '' },
    payerName: ch.payer ? ch.payer.name : '',
    // cartão: só aparece no checkout se o admin ligou e configurou o adquirente
    card: { ...cardPublic(), installments: installmentOptions(ch.value) },
    // como foi pago (recibo) — sem nenhum dado sensível do cartão
    method: ch.method || 'pix',
    paidCard: ch.card ? { kind: ch.card.kind, brand: ch.card.brand, last4: ch.card.last4, installments: ch.card.installments } : null,
    // a página monta com o CHECKOUT escolhido + as variáveis do PRODUTO
    checkout: checkoutBranding(acc, { checkoutId: ch.checkoutId, productId: ch.productId })
  };
}

// ---------------------------------------------------------------------------
// WEBHOOK — pagamento confirmado (chamado pelo handler da Woovi)
// ---------------------------------------------------------------------------
function isElitePayCharge(correlationID) { return String(correlationID || '').startsWith('ep-'); }

function applyPaid(freshCharge, broadcast) {
  const cid = freshCharge.correlationID || '';
  const accId = cid.split('-')[1];
  const acc = db.findAccount(accId);
  if (!acc) { store.logEvent({ type: 'elitepay_unmatched', correlationID: cid }); return { ok: false }; }
  const ch = findCharge(acc, cid);
  if (!ch) { store.logEvent({ type: 'elitepay_unmatched', accountId: acc.id, correlationID: cid }); return { ok: false }; }
  return finalizePaid(acc, ch, broadcast);
}

// Marca a cobrança como paga e dispara tudo que depende disso (funil, tracking,
// tracking de conversão, notificação no WhatsApp). Usado tanto pelo webhook do
// Pix quanto pela aprovação no cartão — a confirmação é uma só.
function finalizePaid(acc, ch, broadcast) {
  if (ch.status === 'paid') return { ok: true, duplicate: true };
  ch.status = 'paid';
  ch.paidAt = Date.now();
  const via = ch.method === 'card' ? ` (${ch.card && ch.card.kind === 'debit' ? 'débito' : 'crédito'})` : '';
  log(acc, { type: 'charge_paid', chargeId: ch.id, amount: ch.value, detail: `Pagamento confirmado${via}${ch.contactName ? ', ' + ch.contactName : ''}` });
  plog({ type: 'charge_paid', accountId: acc.id, accountName: acc.name, amount: ch.value, fee: ch.platformCut });
  advancePipelineOnPaid(acc, ch);   // funil: contato → "Ganho" + tag Cliente
  // Venda no CARTÃO: o líquido entra na carteira do cliente aqui no EliteChat
  // (a liberar, conforme o prazo do adquirente) para ele usar na plataforma
  // ou sacar depois.
  if (ch.method === 'card') { try { creditCardSale(acc, ch, broadcast); } catch (e) { log(acc, { type: 'wallet_error', chargeId: ch.id, detail: e.message }); } }
  // Tracking: atribui a venda à campanha de origem + reenvia a conversão
  // (Meta CAPI / GA4 / TikTok) automaticamente — não bloqueia a confirmação.
  try { require('./tracking').onPaid(acc, ch, broadcast); } catch {}
  db.save();
  if (broadcast) broadcast('elitepay', { accountId: acc.id, chargeId: ch.id, status: 'paid', amount: ch.value, contactName: ch.contactName, waId: ch.waId });

  // Confirmação automática ao cliente no WhatsApp (quando ativado nas configurações).
  // Vai como TEMPLATE aprovado — assim chega mesmo fora da janela de 24h, que é
  // o caso comum: o cliente paga horas depois de ter falado no chat.
  const ep = ensure(acc);
  if (ep.settings.notifyPaid && ch.waId) {
    (async () => {
      try {
        const wa = require('./whatsapp');
        const tpl = pickTemplate(acc, 'confirmacao');
        let r, texto;
        if (tpl) {
          const nVars = tpl.vars.length;
          const vals = tplValues(acc, ch, 'confirmacao');
          const components = nVars ? [{ type: 'body', parameters: vals.slice(0, nVars).map(t => ({ type: 'text', text: String(t || '-') })) }] : [];
          r = await wa.sendTemplate(acc, ch.waId, tpl.name, tpl.language || ep.confirmTemplateLang || 'pt_BR', components);
          texto = `✅ Confirmação de pagamento (${tpl.name}) · ${fmtBRL(ch.value)}`;
          log(acc, { type: 'confirm_sent', chargeId: ch.id, amount: ch.value, detail: `Confirmação enviada via template "${tpl.name}"` });
        } else {
          // Sem modelo de confirmação designado: cai na mensagem de texto, que
          // só funciona dentro da janela de 24h (limitação da Meta).
          texto = `✅ Pagamento confirmado! Recebemos ${fmtBRL(ch.value)}${ch.comment ? ', ' + ch.comment : ''}. Obrigado! 💚`;
          r = await wa.sendText(acc, ch.waId, texto);
          log(acc, { type: 'confirm_sent', chargeId: ch.id, amount: ch.value, detail: 'Confirmação enviada como texto (sem modelo designado)' });
        }
        store.storeOutbound(acc, ch.waId, { type: tpl ? 'template' : 'text', text: texto }, r);
        db.save();
        if (broadcast) broadcast('message', { accountId: acc.id, waId: ch.waId });
      } catch (e) { log(acc, { type: 'notify_error', chargeId: ch.id, detail: e.message }); db.save(); }
    })();
  }
  return { ok: true, acc, charge: ch };
}

// ---------------------------------------------------------------------------
// CARTÃO — crédito/débito pelo adquirente escolhido no Admin SaaS.
// O Pix continua sendo o meio principal; o cartão é uma alternativa opcional
// dentro da MESMA cobrança (/pay/:id).
// ---------------------------------------------------------------------------
const cards = require('./cardgateways');

function cardConfig() { return cards.cardCfg(platformCfg()); }
function cardPublic() { return cards.publicCard(cardConfig()); }

// ---- RECEBEDOR do cliente (KYC) ----
// Sem isso o dinheiro do cartão cairia na conta da PLATAFORMA. Cada cliente tem
// o próprio recebedor (Pagar.me) ou subconta (Asaas), e o split manda o líquido
// direto para ele — mesma lógica das subcontas Woovi no Pix.
function cardAccount(acc) {
  const ep = ensure(acc);
  if (!ep.cardAccount) {
    ep.cardAccount = {
      provider: '', status: 'none',   // none | pending | active | refused | blocked
      recipientId: '', walletId: '', subApiKey: '',
      fields: null, createdAt: 0, updatedAt: 0, refusedReason: ''
    };
  }
  return ep.cardAccount;
}

// Pode vender no cartão? Precisa do recebedor ativo (e aprovado, se exigido).
function cardReady(acc) {
  const ca = cardAccount(acc);
  const card = cardConfig();
  if (!cards.isAvailable(card)) return { ok: false, reason: 'Pagamento com cartão indisponível' };
  if (ca.provider && ca.provider !== card.provider) {
    return { ok: false, reason: 'O adquirente mudou. Refaça o cadastro de recebimento no cartão' };
  }
  if (ca.status === 'none') return { ok: false, reason: 'Conta de recebimento no cartão ainda não cadastrada' };
  if (ca.status === 'refused') return { ok: false, reason: 'Cadastro de recebimento recusado pelo adquirente' };
  if (ca.status === 'blocked') return { ok: false, reason: 'Conta de recebimento bloqueada pelo adquirente' };
  if (ca.status !== 'active') return { ok: false, reason: 'Conta de recebimento em análise pelo adquirente' };
  if (card.requireApproval && !ca.approvedByAdmin) return { ok: false, reason: 'Conta aguardando liberação da plataforma' };
  return { ok: true, ca };
}

// Cria o recebedor/subconta no adquirente a partir do formulário de KYC.
async function registerCardAccount(acc, fields) {
  const card = cardConfig();
  if (!cards.isConfigured(card)) { const e = new Error('O adquirente ainda não foi configurado pela plataforma'); e.status = 400; throw e; }
  const ca = cardAccount(acc);
  if (ca.status === 'active') { const e = new Error('Sua conta de recebimento já está ativa'); e.status = 400; throw e; }

  const erro = cards.validateOnboarding(card.provider, fields);
  if (erro) { const e = new Error(erro); e.status = 400; throw e; }

  const r = await cards.driver(card).createRecipient({
    cfg: cards.creds(card), f: fields, code: `ec-${acc.id}`
  });

  ca.provider = card.provider;
  ca.recipientId = r.id || '';
  ca.walletId = r.walletId || '';
  if (r.apiKey) ca.subApiKey = r.apiKey;          // Asaas devolve só uma vez
  ca.status = r.status || 'pending';
  ca.createdAt = ca.createdAt || Date.now();
  ca.updatedAt = Date.now();
  ca.refusedReason = '';
  // Guarda só o que é útil para reexibir — nunca dado bancário completo.
  ca.fields = {
    name: fields.name, email: fields.email,
    document: fmtCpfCnpj(String(fields.document || '').replace(/\D/g, '')),
    bank: fields.bank || '', accountLast: String(fields.accountNumber || '').slice(-4)
  };
  log(acc, { type: 'card_account', detail: `Cadastro de recebimento enviado ao ${card.provider} (${ca.status})` });
  plog({ type: 'card_account', accountId: acc.id, accountName: acc.name, provider: card.provider, status: ca.status });
  db.save();
  return ca;
}

// Reconsulta o status do recebedor no adquirente.
async function syncCardAccount(acc) {
  const ca = cardAccount(acc);
  if (!ca.recipientId && !ca.walletId) return ca;
  const card = cardConfig();
  try {
    const r = await cards.driver(card).getRecipient({
      cfg: cards.creds(card), id: ca.recipientId, walletId: ca.walletId
    });
    const antes = ca.status;
    ca.status = r.status;
    ca.updatedAt = Date.now();
    if (antes !== ca.status) log(acc, { type: 'card_account', detail: `Recebedor mudou de ${antes} para ${ca.status}` });
    db.save();
  } catch (e) { /* falha de consulta não muda o status */ }
  return ca;
}

// O que este lojista PODE aceitar no cartão, hoje. Cruza a permissão do admin
// (adquirente ligado + método liberado) com o KYC concluído do lojista.
// Usado pelo Checkout Builder para liberar/travar os toggles de crédito/débito.
function cardCapability(acc) {
  const pub = cardPublic();
  const card = cardConfig();
  // Modo carteira: não exige recebedor do lojista no adquirente — basta o
  // cartão estar ligado e configurado pela plataforma.
  const ready = card.settleMode === 'wallet' ? cards.isAvailable(card) : cardReady(acc).ok;
  return {
    ready,
    mode: card.settleMode || 'wallet',
    settleCredit: cards.settleDays(card, 'credit'),
    settleBoleto: cards.settleDays(card, 'boleto'),
    settleRules: cards.SETTLE_RULES[card.provider] || cards.SETTLE_RULES.pagarme,
    credit: ready && !!pub.credit,
    boleto: ready && !!pub.boleto,
    boletoDueDays: pub.boletoDueDays
  };
}

// Visão para o painel do cliente — sem chave de subconta.
function cardAccountView(acc) {
  const ca = cardAccount(acc);
  const card = cardConfig();
  const pronto = cardReady(acc);
  return {
    available: cards.isAvailable(card),
    provider: card.provider,
    status: ca.status,
    ready: pronto.ok,
    reason: pronto.ok ? '' : pronto.reason,
    fields: ca.fields,
    createdAt: ca.createdAt,
    refusedReason: ca.refusedReason || '',
    requiredFields: cards.onboardingFields(card.provider, 'individual'),
    requiredFieldsCompany: cards.onboardingFields(card.provider, 'company')
  };
}

// Parcelas oferecidas no checkout (sem juros — o repasse é do lojista).
function installmentOptions(valueCents) {
  const card = cardConfig();
  const max = Math.min(12, Math.max(1, Number(card.maxInstallments) || 1));
  const out = [];
  for (let i = 1; i <= max; i++) {
    const parcela = Math.floor(valueCents / i);
    if (i > 1 && parcela < 500) break;    // não parcela abaixo de R$ 5,00 por parcela
    out.push({ n: i, valueCents: parcela, label: `${i}x de ${fmtBRL(parcela)}${i === 1 ? ' à vista' : ''}` });
  }
  return out;
}

// Cobra no cartão uma cobrança já existente (criada como Pix).
async function payWithCard(chargeId, body, broadcast) {
  const found = findChargeAnywhere(chargeId);
  if (!found) { const e = new Error('Cobrança não encontrada'); e.status = 404; throw e; }
  const { acc, ch } = found;

  const card = cardConfig();
  // No modo SPLIT o lojista precisa ter recebedor ativo no adquirente, senão o
  // dinheiro cairia na conta da plataforma sem controle. No modo CARTEIRA isso
  // é justamente o desenho: recebemos e creditamos o saldo dele aqui dentro.
  const pronto = card.settleMode === 'wallet' ? { ok: true, ca: {} } : cardReady(acc);
  if (!pronto.ok) { const e = new Error(pronto.reason); e.status = 400; throw e; }
  if (ch.status === 'paid') { const e = new Error('Esta cobrança já foi paga'); e.status = 400; throw e; }
  if (ch.status !== 'active') { const e = new Error('Esta cobrança não está mais ativa'); e.status = 400; throw e; }
  if (ch.expiresAt && ch.expiresAt < Date.now()) { const e = new Error('Esta cobrança expirou'); e.status = 400; throw e; }

  const kind = 'credit';   // não há débito: à vista o Pix cobre melhor
  if (!card.credit) { const e = new Error('Cartão de crédito indisponível'); e.status = 400; throw e; }
  // Blindagem por checkout: o lojista pode ter desligado o cartão nesta página.
  // Não confia no front — revalida contra o que foi salvo no checkout.
  const ckMethods = Object.assign({ pix: true, credit: true, boleto: false }, (findCheckout(acc, ch.checkoutId) || {}).methods || {});
  if (!ckMethods[kind]) { const e = new Error('Este checkout não aceita esse método de pagamento'); e.status = 400; throw e; }

  const c = body.card || {};
  const faltando = ['number', 'holderName', 'expMonth', 'expYear', 'cvv'].filter(k => !String(c[k] || '').trim());
  if (faltando.length) { const e = new Error('Preencha todos os dados do cartão'); e.status = 400; throw e; }

  const pagador = body.customer || {};
  const nome = String(pagador.name || (ch.payer && ch.payer.name) || ch.contactName || '').trim();
  const doc = String(pagador.taxId || (ch.payer && ch.payer.taxID) || '').replace(/\D/g, '');
  if (!nome) { const e = new Error('Informe o nome do titular'); e.status = 400; throw e; }
  if (doc.length !== 11 && doc.length !== 14) { const e = new Error('Informe um CPF ou CNPJ válido'); e.status = 400; throw e; }

  const parcelas = Math.max(1, Math.min(Number(body.installments) || 1, Number(card.maxInstallments) || 1));
  const fee = cards.computeCardFee(card, ch.value);

  // REPASSE. No modo 'wallet' NÃO há split: o valor cheio entra na conta da
  // plataforma e o líquido vira saldo na carteira do lojista aqui dentro,
  // liberado no prazo do adquirente. No modo 'split' o adquirente já divide.
  const ca = pronto.ca;
  const split = card.settleMode === 'wallet' ? null : cards.driver(card).splitFor({
    recipientId: ca.recipientId,
    walletId: ca.walletId,
    platformRecipientId: card.platformRecipientId,
    platformWalletId: (card.asaas && card.asaas.walletId) || '',
    valueCents: ch.value,
    platformCut: fee.platformCut
  });

  let r;
  try {
    r = await cards.driver(card).charge({
      cfg: cards.creds(card),
      valueCents: ch.value,
      installments: parcelas,
      kind,
      card: c,
      holder: body.holder || {},
      customer: { name: nome, taxId: doc, email: pagador.email || (ch.payer && ch.payer.email) || '', phone: pagador.phone || ch.waId || '' },
      description: ch.comment || 'Pagamento',
      correlationID: ch.correlationID,
      softDescriptor: card.softDescriptor,
      split
    });
  } catch (e) {
    log(acc, { type: 'card_error', chargeId: ch.id, detail: e.message });
    plog({ type: 'card_error', accountId: acc.id, accountName: acc.name, error: e.message });
    db.save();
    throw e;
  }

  // Registra a tentativa (nunca guardamos número completo nem CVV).
  ch.method = 'card';
  ch.card = {
    provider: card.provider, kind, installments: parcelas,
    brand: r.brand || '', last4: r.last4 || String(c.number).replace(/\D/g, '').slice(-4),
    status: r.status, gatewayId: r.gatewayId, authCode: r.authCode || '',
    attemptedAt: Date.now()
  };
  // A taxa da plataforma no cartão substitui a do Pix nesta cobrança.
  ch.feePercent = fee.feePercent;
  ch.feeFixed = fee.feeFixed;
  ch.platformCut = fee.platformCut;

  if (r.status === 'paid') {
    plog({ type: 'card_paid', accountId: acc.id, accountName: acc.name, amount: ch.value, fee: fee.platformCut, provider: card.provider });
    const res = finalizePaid(acc, ch, broadcast);
    db.save();
    return { ok: true, status: 'paid', charge: publicChargeView(ch.id), duplicate: !!res.duplicate };
  }

  if (r.status === 'pending') {
    log(acc, { type: 'card_pending', chargeId: ch.id, detail: 'Pagamento em análise pelo adquirente' });
    db.save();
    return { ok: true, status: 'pending', message: 'Pagamento em análise. Avisaremos assim que for aprovado.' };
  }

  log(acc, { type: 'card_refused', chargeId: ch.id, detail: r.message || 'Recusado pelo emissor' });
  db.save();
  const e = new Error(cardRefusalMessage(r.message));
  e.status = 400;
  throw e;
}

// ---------------------------------------------------------------------------
// BOLETO no checkout do lojista.
// Diferente do cartão, não aprova na hora: emitimos, devolvemos a linha
// digitável e o PDF, e a cobrança só vira 'paid' quando o adquirente avisa a
// compensação pelo /card-webhook (que já reconfere o status na API).
// ---------------------------------------------------------------------------
async function payWithBoleto(chargeId, body, broadcast) {
  const found = findChargeAnywhere(chargeId);
  if (!found) { const e = new Error('Cobrança não encontrada'); e.status = 404; throw e; }
  const { acc, ch } = found;

  const card = cardConfig();
  const pronto = card.settleMode === 'wallet' ? { ok: true, ca: {} } : cardReady(acc);
  if (!pronto.ok) { const e = new Error(pronto.reason); e.status = 400; throw e; }
  if (ch.status === 'paid') { const e = new Error('Esta cobrança já foi paga'); e.status = 400; throw e; }
  if (ch.status !== 'active') { const e = new Error('Esta cobrança não está mais ativa'); e.status = 400; throw e; }
  if (!card.boleto) { const e = new Error('Boleto indisponível'); e.status = 400; throw e; }

  const ckMethods = Object.assign({ pix: true, credit: true, boleto: false }, (findCheckout(acc, ch.checkoutId) || {}).methods || {});
  if (!ckMethods.boleto) { const e = new Error('Este checkout não aceita boleto'); e.status = 400; throw e; }

  const pagador = body.customer || {};
  const nome = String(pagador.name || (ch.payer && ch.payer.name) || ch.contactName || '').trim();
  const doc = String(pagador.taxId || (ch.payer && ch.payer.taxID) || '').replace(/\D/g, '');
  if (!nome) { const e = new Error('Informe o nome do pagador'); e.status = 400; throw e; }
  if (doc.length !== 11 && doc.length !== 14) { const e = new Error('Informe um CPF ou CNPJ válido'); e.status = 400; throw e; }

  const fee = cards.computeCardFee(card, ch.value);
  const ca = pronto.ca;
  const split = card.settleMode === 'wallet' ? null : cards.driver(card).splitFor({
    recipientId: ca.recipientId,
    walletId: ca.walletId,
    platformRecipientId: card.platformRecipientId,
    platformWalletId: (card.asaas && card.asaas.walletId) || '',
    valueCents: ch.value,
    platformCut: fee.platformCut
  });

  let r;
  try {
    r = await cards.driver(card).boleto({
      cfg: cards.creds(card),
      valueCents: ch.value,
      customer: { name: nome, taxId: doc, email: pagador.email || (ch.payer && ch.payer.email) || '', phone: pagador.phone || ch.waId || '' },
      description: ch.comment || 'Pagamento',
      correlationID: ch.correlationID,
      dueDays: Math.max(1, Number(card.boletoDueDays) || 3),
      split
    });
  } catch (e) {
    log(acc, { type: 'boleto_error', chargeId: ch.id, detail: e.message });
    plog({ type: 'boleto_error', accountId: acc.id, accountName: acc.name, error: e.message });
    db.save();
    throw e;
  }

  ch.method = 'boleto';
  // Reaproveita `ch.card` de propósito: é onde o webhook procura o gatewayId.
  ch.card = {
    provider: card.provider, kind: 'boleto', installments: 1,
    brand: '', last4: '',
    status: r.status, gatewayId: r.gatewayId, authCode: '',
    boletoUrl: r.url || '', boletoLine: r.line || '', boletoBarcode: r.barcode || '',
    dueDate: r.dueDate || 0,
    attemptedAt: Date.now()
  };
  ch.feePercent = fee.feePercent;
  ch.feeFixed = fee.feeFixed;
  ch.platformCut = fee.platformCut;
  db.save();

  log(acc, { type: 'boleto_issued', chargeId: ch.id, detail: `Boleto emitido, ${fmtBRL(ch.value)}` });
  plog({ type: 'boleto_issued', accountId: acc.id, accountName: acc.name, amount: ch.value, provider: card.provider });
  return {
    ok: true, status: 'pending',
    boleto: { url: r.url || '', line: r.line || '', barcode: r.barcode || '', dueDate: r.dueDate || 0 },
    message: 'Boleto emitido. A confirmação chega assim que o banco compensar o pagamento.'
  };
}

// Traduz o retorno do adquirente para algo que o pagador entenda.
function cardRefusalMessage(msg) {
  const m = String(msg || '').toLowerCase();
  if (m.includes('insufficient') || m.includes('saldo')) return 'Cartão recusado: saldo ou limite insuficiente.';
  if (m.includes('expired') || m.includes('expirado')) return 'Cartão recusado: cartão vencido.';
  if (m.includes('cvv') || m.includes('security')) return 'Cartão recusado: código de segurança inválido.';
  if (m.includes('invalid') || m.includes('inválid')) return 'Cartão recusado: dados inválidos. Confira o número e a validade.';
  return 'Cartão recusado pelo emissor. Tente outro cartão ou pague com Pix.';
}

// ---------------------------------------------------------------------------
// WEBHOOK do adquirente de cartão (Pagar.me / Asaas)
//
// Segurança em duas camadas:
//   1) Autenticação — Asaas manda `asaas-access-token`; Pagar.me usa Basic auth
//      (a única opção que ele oferece: não assina o payload).
//   2) Reconferência — antes de confirmar, o status é lido DE NOVO na API do
//      adquirente. Assim, mesmo um POST forjado que passe pela camada 1 não
//      consegue marcar uma cobrança como paga.
// ---------------------------------------------------------------------------
function cardWebhookToken() {
  const card = cardConfig();
  if (!card.webhookToken) {
    card.webhookToken = 'ec_' + crypto.randomBytes(24).toString('hex');
    db.save();
  }
  return card.webhookToken;
}

function cardWebhookAuthOk(req) {
  const esperado = cardWebhookToken();
  const card = cardConfig();
  if (card.provider === 'asaas') {
    return timingEq(req.get('asaas-access-token') || '', esperado);
  }
  // Pagar.me: Basic auth — usuário livre, senha = token.
  const h = String(req.get('authorization') || '');
  if (!/^basic /i.test(h)) return false;
  const senha = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  return timingEq(senha, esperado);
}
function timingEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// Localiza a cobrança pelo id do adquirente ou pelo correlationID no payload.
function findChargeByGateway(gatewayId, correlationID) {
  const data = db.get();
  for (const acc of data.accounts || []) {
    const lista = (acc.elitepay && acc.elitepay.charges) || [];
    const ch = lista.find(c =>
      (correlationID && c.correlationID === correlationID) ||
      (gatewayId && c.card && c.card.gatewayId === gatewayId));
    if (ch) return { acc, ch };
  }
  return null;
}

function cardWebhookHandler(broadcast) {
  return async (req, res) => {
    const card = cardConfig();
    if (!cards.isConfigured(card)) return res.status(200).json({ ok: true, ignored: 'cartão não configurado' });
    if (!cardWebhookAuthOk(req)) {
      plog({ type: 'card_webhook_denied', detail: 'token inválido' });
      return res.status(401).json({ error: 'não autorizado' });
    }

    const b = req.body || {};
    res.json({ ok: true });   // responde rápido; o resto é assíncrono

    try {
      if (card.provider === 'asaas') await onAsaasEvent(b, broadcast);
      else await onPagarmeEvent(b, broadcast);
    } catch (e) {
      plog({ type: 'card_webhook_error', detail: e.message });
      db.save();
    }
  };
}

async function onPagarmeEvent(b, broadcast) {
  const tipo = String(b.type || '');
  const d = b.data || {};

  // Status do recebedor mudou (aprovado/recusado na análise).
  if (tipo.startsWith('recipient.')) return applyRecipientEvent(d.code, d.status, d.id);

  if (!tipo.startsWith('charge.') && !tipo.startsWith('order.')) return;
  const gatewayId = d.id || '';
  const correlationID = d.code || (d.order && d.order.code) || '';
  const found = findChargeByGateway(gatewayId, correlationID);
  if (!found) { plog({ type: 'card_webhook_unmatched', detail: `${tipo} ${gatewayId}` }); db.save(); return; }

  // Reconfere na API — não confia no corpo recebido.
  const card = cardConfig();
  const real = await cards.DRIVERS.pagarme.getCharge({ cfg: cards.creds(card), gatewayId: gatewayId || found.ch.card.gatewayId });
  applyCardStatus(found.acc, found.ch, real.status, broadcast);
}

async function onAsaasEvent(b, broadcast) {
  const evento = String(b.event || '');
  const p = b.payment || {};
  if (!evento.startsWith('PAYMENT_')) return;

  const found = findChargeByGateway(p.id, p.externalReference);
  if (!found) { plog({ type: 'card_webhook_unmatched', detail: `${evento} ${p.id || ''}` }); db.save(); return; }

  const card = cardConfig();
  const real = await cards.DRIVERS.asaas.getCharge({ cfg: cards.creds(card), gatewayId: p.id });
  applyCardStatus(found.acc, found.ch, real.status, broadcast);
}

// Aplica o status confirmado pela API na cobrança.
function applyCardStatus(acc, ch, status, broadcast) {
  if (!ch.card) ch.card = {};
  const antes = ch.card.status;
  ch.card.status = status;

  if (status === 'paid') {
    finalizePaid(acc, ch, broadcast);           // idempotente
  } else if (status === 'refunded' && ch.status === 'paid') {
    ch.status = 'refunded';
    log(acc, { type: 'card_refunded', chargeId: ch.id, amount: ch.value, detail: 'Pagamento estornado pelo adquirente' });
    plog({ type: 'card_refunded', accountId: acc.id, accountName: acc.name, amount: ch.value });
    if (broadcast) broadcast('elitepay', { accountId: acc.id, chargeId: ch.id, status: 'refunded' });
  } else if (status === 'refused' && antes === 'pending') {
    log(acc, { type: 'card_refused', chargeId: ch.id, detail: 'Recusado após análise do adquirente' });
  }
  db.save();
}

// Recebedor aprovado/recusado — o code é "ec-<accountId>".
function applyRecipientEvent(code, statusBruto, recipientId) {
  const accId = String(code || '').replace(/^ec-/, '');
  const acc = db.findAccount(accId);
  if (!acc) return;
  const ca = cardAccount(acc);
  if (recipientId && ca.recipientId && ca.recipientId !== recipientId) return;
  const mapa = { active: 'active', registration: 'pending', affiliation: 'pending', refused: 'refused', blocked: 'blocked', inactive: 'blocked', suspended: 'blocked' };
  const novo = mapa[String(statusBruto || '').toLowerCase()] || 'pending';
  if (ca.status === novo) return;
  ca.status = novo;
  ca.updatedAt = Date.now();
  log(acc, { type: 'card_account', detail: `Recebedor ${novo === 'active' ? 'aprovado' : novo} pelo adquirente` });
  plog({ type: 'card_account', accountId: acc.id, accountName: acc.name, status: novo });
  db.save();
}

// Consulta o status no adquirente (para cobranças que ficaram em análise).
async function refreshCardStatus(chargeId, broadcast) {
  const found = findChargeAnywhere(chargeId);
  if (!found || !found.ch.card || !found.ch.card.gatewayId) return null;
  const { acc, ch } = found;
  const card = cardConfig();
  try {
    const r = await cards.driver(card).getCharge({ cfg: cards.creds(card), gatewayId: ch.card.gatewayId });
    ch.card.status = r.status;
    if (r.status === 'paid' && ch.status !== 'paid') finalizePaid(acc, ch, broadcast);
    db.save();
    return r.status;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// MÉTRICAS — cliente e plataforma
// ---------------------------------------------------------------------------
function metrics(acc) {
  const ep = ensure(acc);
  const now = Date.now(), d30 = now - 30 * 86400000;
  const paid = ep.charges.filter(c => c.status === 'paid');
  const sum = a => a.reduce((s, c) => s + c.value, 0);
  return {
    totalPaid: sum(paid),
    paid30d: sum(paid.filter(c => c.paidAt >= d30)),
    countPaid: paid.length,
    pendingCount: ep.charges.filter(c => c.status === 'active').length,
    pendingValue: sum(ep.charges.filter(c => c.status === 'active')),
    feesPaid: paid.reduce((s, c) => s + (c.platformCut || 0), 0),
    // série diária dos últimos 14 dias (gráfico do dashboard financeiro)
    series: Array.from({ length: 14 }, (_, i) => {
      const day = new Date(); day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - (13 - i));
      const next = day.getTime() + 86400000;
      return { day: day.getTime(), value: sum(paid.filter(c => c.paidAt >= day.getTime() && c.paidAt < next)) };
    })
  };
}

function adminOverview() {
  const data = db.get();
  const cfg = platformCfg();
  // TODAS as contas com Elite Pay entram na gestão financeira (inclusive a do
  // admin, que também pode vender) — diferente do billing, que só lista clientes.
  const accounts = data.accounts.filter(a => a.elitepay);
  const rows = accounts.map(a => {
    const ep = a.elitepay;
    const paid = (ep.charges || []).filter(c => c.status === 'paid');
    const pixIn = paid.reduce((s, c) => s + c.value, 0);
    const fees = paid.reduce((s, c) => s + (c.platformCut || 0), 0);
    const pixOut = (ep.logs || []).filter(l => l.type === 'withdraw').reduce((s, l) => s + (l.amount || 0), 0);
    return {
      accountId: a.id, name: a.name, email: a.email,
      sub: ep.subaccount ? { status: ep.subaccount.status, name: ep.subaccount.name, pixKey: ep.subaccount.pixKey, createdAt: ep.subaccount.createdAt } : null,
      pixIn, pixOut, fees, charges: (ep.charges || []).length, pending: (ep.charges || []).filter(c => c.status === 'active').length
    };
  });
  // Cartão: totais separados do Pix, para o admin ver de onde vem a receita.
  const todas = accounts.flatMap(a => (a.elitepay.charges || []));
  const cartaoPagas = todas.filter(c => c.status === 'paid' && c.method === 'card');
  return {
    config: { gateway: cfg.gateway, onboardingMode: cfg.onboardingMode, feeInPercent: cfg.feeInPercent, feeOutPercent: cfg.feeOutPercent, splitPixKey: cfg.splitPixKey, requireApproval: cfg.requireApproval, configured: configured() },
    card: cards.adminCard(cardConfig()),
    totals: {
      pixIn: rows.reduce((s, r) => s + r.pixIn, 0),
      pixOut: rows.reduce((s, r) => s + r.pixOut, 0),
      fees: rows.reduce((s, r) => s + r.fees, 0),
      cardIn: cartaoPagas.reduce((s, c) => s + c.value, 0),
      cardFees: cartaoPagas.reduce((s, c) => s + (c.platformCut || 0), 0),
      cardCount: cartaoPagas.length,
      subActive: rows.filter(r => r.sub && r.sub.status === 'active').length,
      subPending: rows.filter(r => r.sub && r.sub.status === 'pending').length,
      charges: rows.reduce((s, r) => s + r.charges, 0)
    },
    accounts: rows.sort((a, b) => b.pixIn - a.pixIn),
    logs: cfg.logs.slice(0, 80)
  };
}

module.exports = {
  ensure, configured, platformCfg, gateway,
  registerSubaccount, setSubaccountStatus, syncSubaccount, applyAccountApproved,
  createCharge, cancelCharge, findCharge, chargeMessage, computeOutFee,
  isElitePayCharge, applyPaid, metrics, adminOverview, log, plog, fmtBRL,
  noteBaseUrl, payLink, publicChargeView, defaultCheckout, defaultProduct, defaultBlocks,
  identifyPayer, fmtCpfCnpj, findProduct, findCheckout, checkoutBranding,
  TPL_ROLES, TPL_VARS, tplValues, roleOf, setTemplateRole, templatesByRole, pickTemplate,
  findChargeAnywhere,
  cardConfig, cardPublic, payWithCard, payWithBoleto, refreshCardStatus, installmentOptions,
  cardAccount, cardAccountView, cardCapability, cardReady, registerCardAccount, syncCardAccount,
  creditCardSale, releaseFor, releaseReceivables, spendWallet, computeWithdrawFee, debitWithdraw,
  cardWebhookHandler, cardWebhookToken,
  DRIVERS
};
