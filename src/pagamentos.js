// ============================================================================
// PAGAMENTOS — pagamentos Pix por cliente (SaaS) via SUBCONTAS do gateway.
//
// Arquitetura DESACOPLADA: toda chamada externa passa pelo "driver" do gateway
// ativo (hoje: Woovi). Para adicionar outro gateway no futuro, basta criar um
// novo driver com a mesma interface — nada do Pagamentos muda.
//
// SPLIT-READY: cada cobrança já calcula e registra a comissão da plataforma
// (platformCut). Quando o admin configurar feeInPercent + splitPixKey, o split
// é enviado ao gateway automaticamente — sem reestruturar o módulo.
// ============================================================================
const crypto = require('crypto');
const db = require('./db');
const store = require('./store');
const woovi = require('./woovi');
const simplify = require('./simplify');
const documento = require('./documento');
const datas = require('./datas');

// ---------------------------------------------------------------------------
// DRIVERS de gateway — interface única:
//   configured() · createSubaccount({name,pixKey}) · getSubBalance(pixKey)
//   createCharge({correlationID,value,comment,customer,expiresIn,subPixKey,splits})
//   getCharge(correlationID) · cancelCharge(correlationID) · withdraw(pixKey)
// ---------------------------------------------------------------------------
const DRIVERS = {
  // -------------------------------------------------------------------------
  // SIMPLIFY — https://simplifybr.gitbook.io/documentacao-simplify
  //
  // Não tem subconta: o depósito cai INTEIRO na conta da PLATAFORMA e a
  // carteira do Koonfy é quem registra quanto é de cada cliente — a venda
  // credita o LÍQUIDO (valor menos a taxa) e o cliente saca em Pagamentos.
  // A taxa de PIX In, portanto, já fica retida na origem, sem split nenhum:
  // é o contrário da Woovi, onde ela só chega à plataforma POR split.
  // Por isso `createSubaccount` aqui não chama
  // a Simplify — ele apenas confirma o cadastro local, e a conta do cliente
  // nasce ativa em vez de ficar esperando aprovação que não existe.
  // -------------------------------------------------------------------------
  simplify: {
    id: 'simplify',
    label: 'Simplify (Pix)',
    configured: () => simplify.configured(),
    // A Simplify EXIGE nome, CPF/CNPJ, e-mail e telefone do pagador para gerar
    // o depósito — a Woovi não. Com esta marca, o Koonfy adia a criação do Pix
    // até o cliente se identificar no checkout, em vez de tentar gerar sem os
    // dados e falhar. Ver `criarCobrancaNoGateway` e `identifyPayer`.
    requiresPayer: true,

    async createSubaccount({ name, pixKey }) {
      return { gatewayId: pixKey || name, raw: { local: true } };
    },

    async createCharge({ correlationID, value, comment, customer, expiresIn, splits }) {
      // Os dados do pagador são obrigatórios: sem eles, `dadosDoPagador` levanta
      // um erro que já diz o que falta e onde resolver.
      const payer = simplify.dadosDoPagador({
        contactName: customer && customer.name,
        waId: customer && customer.phone,
        payer: customer && customer.payer
      });

      const body = {
        amount: Number((value / 100).toFixed(2)),   // a Simplify quer reais, não centavos
        external_id: correlationID,
        payer
      };
      const url = webhookUrlPublica('/simplify-webhook');
      if (url) body.webhookURL = url;

      // -------------------------------------------------------------------
      // A TAXA DA PLATAFORMA **NÃO** SAI COMO SPLIT AQUI. Isto é importante.
      //
      // Na Woovi o depósito cai na SUBCONTA do cliente, então a taxa precisa
      // ser retirada por split para chegar à plataforma. Na Simplify não há
      // subconta: o depósito inteiro já cai na conta da PLATAFORMA, e é a
      // carteira do Koonfy que credita ao cliente o líquido
      // (`creditPixSale` = valor − platformCut). Ou seja, a taxa já está
      // retida por construção.
      //
      // Mandar `splits` (que chega em centavos, com a taxa) como split aqui
      // faria a taxa sair da conta da plataforma para outro usuário — a
      // plataforma perderia o que acabou de cobrar, e o cliente continuaria
      // recebendo o líquido. Prejuízo dos dois lados.
      //
      // O `split` da Simplify manda uma fatia para OUTRO usuário dela. Não é o
      // que a plataforma cobra, e não há mais onde configurá-lo: um campo que
      // parecia ser "a sua taxa", logo abaixo do Client Secret, custava caro
      // para quem o preenchesse achando isso.
      // -------------------------------------------------------------------

      const d = await simplify.call('POST', '/pix/deposit', body);
      const codigo = d.qrcode || d.qrCode || d.pix || '';
      return {
        gatewayId: d.internal_id || d.id || '',
        brCode: codigo,
        // A Simplify devolve só o código copia e cola; a imagem do QR é gerada
        // no navegador a partir dele, então não há imagem para guardar aqui.
        qrCodeImage: '',
        paymentLinkUrl: '',
        expiresAt: Date.now() + (expiresIn || 86400) * 1000,
        raw: undefined
      };
    },

    // A documentação não expõe consulta de transação nem cancelamento: a
    // confirmação vem só pelo webhook. Devolver `null` mantém a interface e
    // deixa claro para quem chama que não há o que perguntar.
    async getCharge() { return null; },
    async cancelCharge() { return null; },
    async getSubBalance() { return null; },
    async withdraw() {
      const e = new Error('Saque pela Simplify é feito no painel dela; o Koonfy registra o pedido.');
      e.status = 400; throw e;
    },
    async createCustomer() { return null; },
    async createPixKey() { return null; },
    async submitKyc() {
      const e = new Error('A Simplify não usa KYC pelo Koonfy: a conta é criada direto com ela.');
      e.status = 400; throw e;
    }
  },

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
  if (!p.pagamentos) {
    p.pagamentos = { gateway: 'woovi', onboardingMode: 'subaccount', feeInPercent: 0, feeOutPercent: 0, splitPixKey: '', requireApproval: false, logs: [] };
  }
  const ep = p.pagamentos;
  // onboardingMode: 'subaccount' (chave Pix, KYC via DICT) | 'kyc' (BaaS com KYC/KYB completo)
  if (!ep.onboardingMode) ep.onboardingMode = 'subaccount';
  // KYC MANUAL: enquanto desligado, ninguém precisa passar por análise e quem
  // já vende continua vendendo. Ligar é decisão do admin, e vale dali para a
  // frente — ver src/kyc.js.
  if (ep.kycObrigatorio === undefined) ep.kycObrigatorio = false;
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

// Endereço público de um webhook. A Simplify recebe a URL em CADA cobrança —
// não há cadastro fixo no painel dela —, então ela é montada a partir da mesma
// origem que o sistema já usa nos links enviados ao cliente.
function webhookUrlPublica(rota) {
  const base = baseUrl();
  return base ? base.replace(/\/+$/, '') + rota : '';
}
// Link de pagamento da cobrança: o checkout hospedado no Koonfy.
// Fallback: o link do gateway (cobranças antigas / base URL desconhecida).
function payLink(ch) {
  // Com um domínio de checkout configurado, a cobrança sai por ele, em forma
  // curta: pay.koonfy.com/<id>. Sem isso, continua <publico>/pay/<id>, que é
  // o formato que as cobranças já emitidas gravaram.
  const { base, curto } = require('./hosts').basePagamento(baseUrl());
  if (!base) return ch.paymentLinkUrl || '';
  return curto ? `${base}/${ch.id}` : `${base}/pay/${ch.id}`;
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
    // O APELIDO DO LINK. É o endereço fixo do produto — o que vai na bio, no
    // anúncio, no grupo. Nasce do nome e pode ser trocado; o que não pode é
    // repetir dentro da conta, senão dois produtos disputariam o mesmo
    // endereço e quem abrisse cairia no que o banco devolvesse primeiro.
    slug: '', linkOn: true,
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
// Um modelo aprovado na Meta pode ter um papel dentro do Pagamentos:
//   'cobranca'    → enviado ao gerar uma cobrança
//   'confirmacao' → enviado quando o pagamento é confirmado
//   ''            → modelo comum (campanha) — não aparece no Pagamentos
// Os dois papéis são MUTUAMENTE EXCLUSIVOS: um modelo é uma coisa ou outra.
//
// As variáveis de cada papel são fixas e posicionais ({{1}}, {{2}}…), porque é
// assim que a Meta preenche o template no envio.
const TPL_ROLES = ['cobranca', 'confirmacao'];

const TPL_VARS = {
  cobranca: [
    { n: 1, key: 'nome', label: 'Nome do cliente', example: 'Maria Silva' },
    { n: 2, key: 'valor', label: 'Valor da cobrança', example: 'R$ 149,90' },
    { n: 3, key: 'link', label: 'Link de pagamento', example: 'https://pay.koonfy.com.br/abc123' },
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
    data: datas.dataHora(dt.getTime(), acc),
    metodo,
    vencimento: datas.data(ch.expiresAt, acc)
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
    // era o selecionado? o Pagamentos volta a não ter modelo designado
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

// Modelos APROVADOS de um papel — é a lista que o Pagamentos oferece para escolha.
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
  if (!acc.pagamentos) {
    acc.pagamentos = {
      subaccount: null,   // { status, name, document, email, phone, pixKey, pixKeyType, gatewayId, synced, createdAt, approvedAt }
      settings: {
        chargeTemplateEnabled: true,   // usa o Template de Cobrança (senão, mensagem padrão)
        autoMessage: 'Olá {nome}! 💳 Aqui está sua cobrança de {valor}.\n{descricao}\nPague pelo link: {link}\n\nOu use o Pix copia e cola:\n{codigo}',
        expiresMin: 1440,       // 24h
        notifyPaid: true,       // envia confirmação no WhatsApp quando pago
        // Para onde o contato vai quando a compra é confirmada. Era fixo em
        // "Ganho"; cada operação nomeia o funil do seu jeito, e num funil sem
        // "Ganho" o contato simplesmente não se movia.
        // Vazio = a etapa que PARECE de fechamento (ganho/fechado/cliente…);
        // sem nenhuma, não move e não inventa.
        paidStage: '',
        paidTag: 'Cliente'      // etiqueta aplicada na compra ('' = nenhuma)
      },
      templateRoles: {},        // nome do modelo -> 'cobranca' | 'confirmacao'
      chargeTemplateName: '', chargeTemplateLang: 'pt_BR',
      confirmTemplateName: '', confirmTemplateLang: 'pt_BR',
      checkout: defaultCheckout(),
      charges: [],
      logs: []
    };
  }
  if (!acc.pagamentos.checkout) acc.pagamentos.checkout = defaultCheckout();
  // migração: contas antigas ganham os campos novos sem perder o que já tinham
  const ck = acc.pagamentos.checkout, d = defaultCheckout();
  for (const k in d) if (ck[k] === undefined) ck[k] = d[k];
  if (!Array.isArray(ck.blocks) || !ck.blocks.length) ck.blocks = defaultBlocks();
  else { for (const b of BLOCK_KEYS) if (!ck.blocks.includes(b)) ck.blocks.push(b); }

  // ---- PRODUTOS + CHECKOUTS (múltiplos templates) ----
  const ep = acc.pagamentos;
  // Contas antigas ganham os ajustes novos sem perder o que já tinham.
  if (!ep.settings) ep.settings = {};
  if (ep.settings.paidStage === undefined) ep.settings.paidStage = '';
  if (ep.settings.paidTag === undefined) ep.settings.paidTag = 'Cliente';
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
  return acc.pagamentos;
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
  const eDoc = documento.erroDoc(doc);
  if (eDoc) errs.push(eDoc);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(f.email || ''))) errs.push('E-mail inválido');
  const phone = String(f.phone || '').replace(/\D/g, '');
  if (phone.length < 10) errs.push('Telefone inválido');
  if (!String(f.pixKey || '').trim()) errs.push('Chave Pix obrigatória');
  if (!PIX_TYPES.includes(f.pixKeyType)) errs.push('Tipo de chave Pix inválido');
  // KYC/KYB (BaaS): exige o representante legal (nome + CPF)
  if (mode === 'kyc') {
    if (!String(f.repName || '').trim() || String(f.repName).trim().length < 3) errs.push('Nome do representante legal inválido');
    const rep = String(f.repDocument || '').replace(/\D/g, '');
    if (!documento.cpfValido(rep)) errs.push('CPF do representante legal inválido');
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
    const e = new Error('Esta conta já possui uma subconta Pagamentos'); e.status = 400; throw e;
  }
  const cfg = platformCfg();
  // COM A WOOVI E A EXIGÊNCIA LIGADA, o caminho é o KYC DELA: a Woovi abre a
  // página de verificação e avisa por webhook. Não é preciso o admin marcar
  // `onboardingMode` também — um interruptor que precisa de outro para
  // funcionar é um interruptor que um dia fica pela metade.
  const mode = (require('./kyc').modo() === 'woovi' || cfg.onboardingMode === 'kyc') ? 'kyc' : 'subaccount';
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


// ---------------------------------------------------------------------------
// A CONTA DE PAGAMENTOS NASCE SOZINHA.
//
// Os dados são os mesmos do cadastro do Koonfy: razão social, CPF/CNPJ,
// e-mail, telefone e chave Pix. Estando todos gravados, não há formulário
// nenhum a preencher — a conta de Pagamentos é criada quando a pessoa assina.
// Faltando a chave Pix (que é do banco do cliente e não dá para deduzir), o
// formulário do Pagamentos continua existindo, já pré-preenchido com o resto.
//
// Na Simplify não existe subconta do lado do adquirente: `createSubaccount`
// registra localmente e o dinheiro é separado pela carteira do Koonfy, com o
// split da plataforma configurado em Admin → Gateways. Na Woovi a subconta é
// criada de verdade. Quem chama aqui não precisa saber a diferença.
//
// Nunca levanta erro: assinatura paga não pode falhar por causa disto.
// ---------------------------------------------------------------------------
async function garantirPagamentos(acc) {
  const ep = ensure(acc);
  if (ep.subaccount && ep.subaccount.status !== 'rejected') return ep.subaccount;
  const p = acc.profile || {};
  const campos = {
    name: acc.name, document: p.document || '', email: acc.email,
    phone: p.phone || '', pixKey: p.pixKey || '', pixKeyType: p.pixKeyType || '',
    repName: '', repDocument: ''
  };
  const mode = platformCfg().onboardingMode === 'kyc' ? 'kyc' : 'subaccount';
  if (validateOnboarding(campos, mode).length) return null;   // dado faltando: fica para o formulário
  try {
    return await registerSubaccount(acc, campos);
  } catch (e) {
    log(acc, { type: 'gateway_error', detail: 'Conta de Pagamentos automática adiada: ' + e.message });
    return null;
  }
}

// Webhook ACCOUNT_REGISTER_APPROVED (BaaS): compliance aprovou → ativa a conta.
function applyAccountApproved(payload, broadcast) {
  const cid = (payload && payload.correlationID) || '';
  if (!cid) return { ok: false };
  const acc = db.get().accounts.find(a => a.pagamentos && a.pagamentos.subaccount &&
    a.pagamentos.subaccount.kyc && a.pagamentos.subaccount.kyc.correlationID === cid);
  if (!acc) { store.logEvent({ type: 'pagamentos_kyc_unmatched', correlationID: cid }); return { ok: false }; }
  const sub = acc.pagamentos.subaccount;
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
  if (broadcast) broadcast('pagamentos', { accountId: acc.id, kind: 'subaccount', status: 'active' });
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
  if (!ep.subaccount) { const e = new Error('Crie a sua conta Koonpay primeiro'); e.status = 400; throw e; }
  // O KYC VEM ANTES DA SUBCONTA na ordem das perguntas: enquanto a análise não
  // termina, não importa se a subconta está ativa — a conta não recebe. E a
  // mensagem precisa dizer em qual dos dois estados a pessoa está, senão ela
  // fica reenviando documento achando que o problema é outro.
  const kyc = require('./kyc');
  if (!kyc.podeReceber(acc)) {
    const st = kyc.ensure(acc).status;
    const msg = st === 'em_analise' ? 'A sua conta está em análise. Assim que for aprovada, você volta a cobrar.'
      : st === 'reprovado' ? 'A sua verificação foi reprovada. Abra o Koonpay para corrigir e reenviar.'
      : 'Envie a verificação de identidade no Koonpay para começar a receber.';
    const e = new Error(msg); e.status = 403; throw e;
  }
  if (ep.subaccount.status !== 'active') { const e = new Error('A sua conta Koonpay ainda não está ativa'); e.status = 400; throw e; }
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
// Venda no PIX cai disponível na hora — não existe prazo de liberação como no
// cartão. A assinatura do próprio Koonfy paga pelo checkout do dono NÃO entra:
// aquele dinheiro é da plataforma, não venda do cliente.
function creditPixSale(acc, ch, broadcast) {
  if (ch.saas) return null;
  if (ch.walletCredited) return null;              // idempotente: webhook repete
  const liquido = Math.max(0, ch.value - (ch.platformCut || 0));
  if (liquido <= 0) return null;

  acc.wallet.balance += liquido;
  ch.walletCredited = liquido;
  acc.wallet.transactions.push({
    id: db.genId('tx'), ts: Date.now(), amount: liquido, type: 'pix_sale',
    label: `Venda no Pix${ch.contactName ? ', ' + ch.contactName : ''}, disponível para saque`
  });
  if (acc.wallet.transactions.length > 400) acc.wallet.transactions.splice(0, acc.wallet.transactions.length - 400);
  db.save();
  log(acc, { type: 'pix_receivable', chargeId: ch.id, amount: liquido, detail: 'Pix disponível na carteira' });
  if (broadcast) broadcast('wallet', { accountId: acc.id });
  return liquido;
}

// ---------------------------------------------------------------------------
// CONTESTAÇÕES — estorno e chargeback
//
// Uma venda contestada tem que sair da carteira, senão o cliente saca dinheiro
// que já voltou para o comprador e a plataforma cobre o rombo. O desfazer
// segue a ordem do que dói menos:
//   1) recebíveis do cartão ainda NÃO liberados são cancelados (some do pendente)
//   2) o que já virou saldo é debitado do disponível
// O saldo PODE ficar negativo — é a verdade da conta, e o saque já barra quem
// não tem saldo. Esconder isso seria deixar a dívida invisível.
// ---------------------------------------------------------------------------
function reverterVenda(acc, ch, motivo, broadcast) {
  const w = acc.wallet;
  if (ch.walletReversed) return null;              // idempotente
  const liquido = Math.max(0, ch.value - (ch.platformCut || 0));
  if (liquido <= 0) return null;

  let cancelado = 0;
  for (const r of w.receivables) {
    if (r.chargeId !== ch.id || r.released) continue;
    r.released = true; r.cancelled = true; r.releasedAt = Date.now();
    cancelado += r.amount;
    w.pending = Math.max(0, w.pending - r.amount);
  }
  const doSaldo = Math.max(0, liquido - cancelado);
  if (doSaldo > 0) {
    w.balance -= doSaldo;
    // o que veio de cartão sai também do contador de origem, para a taxa de
    // saque seguinte não cobrar como se ainda houvesse dinheiro de cartão ali
    if (ch.method === 'card') w.cardAvailable = Math.max(0, (Number(w.cardAvailable) || 0) - doSaldo);
  }

  ch.walletReversed = liquido;
  w.transactions.push({
    id: db.genId('tx'), ts: Date.now(), amount: -liquido, type: motivo,
    label: `${motivo === 'chargeback' ? 'Chargeback' : 'Estorno'} de venda${ch.contactName ? ', ' + ch.contactName : ''}` +
      (cancelado ? ` (${fmtBRL(cancelado)} cancelado antes de liberar)` : '')
  });
  if (w.transactions.length > 400) w.transactions.splice(0, w.transactions.length - 400);
  db.save();
  log(acc, { type: motivo, chargeId: ch.id, amount: liquido, detail: `Valor retirado da carteira${cancelado ? `, ${fmtBRL(cancelado)} ainda não liberado` : ''}` });
  plog({ type: motivo, accountId: acc.id, accountName: acc.name, amount: liquido });
  if (broadcast) { broadcast('wallet', { accountId: acc.id }); broadcast('pagamentos', { accountId: acc.id, chargeId: ch.id, status: ch.status }); }
  return { liquido, cancelado, doSaldo };
}

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
    ? `${agenda.length}x, de ${datas.data(agenda[0].availableAt, acc)} a ${datas.data(agenda[agenda.length - 1].availableAt, acc)}`
    : `libera em ${datas.data(agenda[0].availableAt, acc)}`;
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
  // Recarga automática no cartão: se o saldo cruzou o piso, repõe sozinho.
  // Não é aguardado de propósito — a compra que acabou de acontecer não deve
  // esperar (nem falhar por causa de) uma cobrança futura.
  try { require('./topup').checarSaldo(acc, broadcast); } catch {}
  return { ok: true, spent: v, balance: w.balance };
}

function findCharge(acc, id) { return ensure(acc).charges.find(c => c.id === id || c.correlationID === id); }

async function createCharge(acc, { valueCents, comment, waId, contactName, origin, byName, expiresMin, productId, checkoutId, saas, message, buttonText, pagador }) {
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

  // -------------------------------------------------------------------------
  // PIX AGORA OU DEPOIS DA IDENTIFICAÇÃO?
  //
  // A Woovi gera o Pix na hora, sem saber quem vai pagar. A Simplify não: ela
  // exige nome, CPF/CNPJ, e-mail e telefone do pagador, dados que a cobrança
  // criada do chat não tem (ali só se sabe o nome e o WhatsApp).
  //
  // Tentar gerar assim mesmo derrubaria TODA cobrança feita pelo chat. Então o
  // Pix é ADIADO: a cobrança nasce sem código, o cliente abre o link, preenche
  // os dados no checkout e é aí que o Pix é gerado — em `identifyPayer`.
  // -------------------------------------------------------------------------
  // Só conta como "tem pagador" o que o gateway consegue usar de fato: nome,
  // e-mail e um documento que fecha a conta dos dígitos. Documento inválido
  // aqui derrubaria a criação da cobrança inteira — melhor adiar o Pix.
  const temPagador = !!(pagador && pagador.email && pagador.name &&
    documento.docValido(pagador.document));
  const adiar = !!gateway().requiresPayer && !temPagador;
  const g = adiar ? { brCode: '', qrCodeImage: '', paymentLinkUrl: '', gatewayId: '', expiresAt: Date.now() + expiresIn * 1000 }
    : await gateway().createCharge({
      correlationID, value: valueCents, comment: (comment || '').slice(0, 140),
      customer: contactName || temPagador
        ? { name: contactName, phone: waId ? '+' + waId : undefined, payer: pagador || null }
        : null,
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
    // Assinatura do próprio Koonfy sendo cobrada pelo checkout do dono:
    // guarda de quem é e de qual plano, senão o pagamento cai aqui e não há
    // como saber qual conta ativar.
    saas: saas || null,
    // Mensagem escrita para ESTA cobrança, com as variáveis ainda cruas. Fica
    // guardada para que reenviar mande o mesmo texto, e não o modelo padrão.
    message: (message || '').slice(0, 1500) || null,
    // Rotulo do botao de pagar: a Meta corta em 20 caracteres e recusa quebra
    // de linha, entao o corte acontece aqui e nao vira erro no envio.
    buttonText: String(buttonText || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 20) || null,
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
function chargeMessage(acc, ch, opts) {
  const o = opts || {};
  const ep = ensure(acc);
  // Template de Cobrança ativo → usa o modelo do usuário; senão, a mensagem padrão.
  // A mensagem escrita na hora da cobrança manda em tudo: é a decisão mais
  // recente e mais específica de quem cobrou.
  const tpl = ch.message
    || ((ep.settings.chargeTemplateEnabled === false)
      ? DEFAULT_CHARGE_MSG
      : (ep.settings.autoMessage || DEFAULT_CHARGE_MSG));

  // O que NÃO cabe nesta mensagem:
  //  · o código Pix, quando ele ainda não existe (adquirente que só emite o
  //    código depois de o cliente se identificar) ou quando a mensagem vai
  //    sair com botão — aí o lugar de pagar é o checkout;
  //  · o link cru, quando ele já vai dentro do botão.
  // Some junto a linha de chamada ("Ou use o Pix copia e cola:"), senão sobra
  // um dois-pontos apontando para o vazio.
  const semCodigo = o.semCodigo || !ch.brCode;
  const semLink = !!o.semLink;
  let texto = tpl;
  if (semCodigo || semLink) {
    texto = texto.split('\n')
      .filter((linha, k, todas) => {
        if (semCodigo && linha.includes('{codigo}')) return false;
        if (semLink && linha.includes('{link}')) return false;
        const prox = todas[k + 1] || '';
        const proxSai = (semCodigo && prox.includes('{codigo}')) || (semLink && prox.includes('{link}'));
        return !(proxSai && /:\s*$/.test(linha));
      })
      .join('\n');
  }
  return texto
    .replace(/\{nome\}/g, ch.contactName || 'cliente')
    .replace(/\{valor\}/g, fmtBRL(ch.value))
    .replace(/\{descricao\}/g, ch.comment || '')
    .replace(/\{link\}/g, ch.payUrl || payLink(ch))
    .replace(/\{codigo\}/g, ch.brCode || '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// A COBRANÇA COMO BOTÃO (CTA URL do WhatsApp).
//
// Mandar o QR e o copia-e-cola dentro da conversa só funciona quando o Pix já
// existe — e com adquirente que exige CPF/CNPJ do pagador (Simplify, e o
// mercado caminha para lá) ele ainda não existe na hora do disparo. Fora isso,
// código no meio do texto é ruim de pagar: copiar, sair, achar o banco.
//
// Com o botão, quem paga cai no CHECKOUT da conta: lá informa o documento,
// escolhe o meio e recebe o Pix pronto — o mesmo lugar que já trata cartão e
// boleto. Serve para qualquer adquirente, hoje e depois.
// ---------------------------------------------------------------------------
function chargeButton(acc, ch) {
  const url = ch.payUrl || payLink(ch);
  let body = chargeMessage(acc, ch, { semCodigo: true, semLink: true });
  if (!body) body = `Sua cobrança de ${fmtBRL(ch.value)} está pronta.`;
  body = body.slice(0, 1024);                      // limite do corpo na Meta
  // O RÓTULO DO BOTÃO. Vem da cobrança, das configurações do lojista ou do
  // padrão, nesta ordem. A Meta corta em 20 caracteres e recusa quebra de
  // linha, então o corte acontece aqui e não vira erro no envio.
  const displayText = botaoTexto(acc, ch);
  return {
    url, body, displayText,
    interactive: {
      type: 'cta_url',
      body: { text: body },
      action: { name: 'cta_url', parameters: { display_text: displayText, url } }
    }
  };
}
// O rótulo do botão de pagar, dentro do que a Meta aceita: 20 caracteres, sem
// quebra de linha. Vazio em todos os níveis, volta para "Pagar agora".
function botaoTexto(acc, ch) {
  const ep = ensure(acc);
  const bruto = (ch && ch.buttonText) || (ep.settings && ep.settings.buttonText) || '';
  const limpo = String(bruto).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 20).trim();
  return limpo || 'Pagar agora';
}

function fmtBRL(cents) { return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

// ---------------------------------------------------------------------------
// IDENTIFICAÇÃO DO PAGADOR (etapa 1 do checkout público)
// Cria o cliente na Woovi, cadastra/atualiza o CONTATO no Koonfy e
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
  // Dígitos verificadores de verdade: antes bastava ter 11 ou 14 dígitos, e um
  // CPF inventado passava direto — para ser recusado depois pelo adquirente,
  // com uma mensagem que não ajudava quem estava preenchendo.
  const erroDoc = documento.erroDoc(doc);
  if (erroDoc) errs.push(erroDoc);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(f.email || ''))) errs.push('E-mail inválido');
  const phone = normalizePayerPhone(f.phone);
  if (phone.length < 12 || phone.length > 15) errs.push('Celular/WhatsApp inválido');
  return { errs, doc, phone };
}

function findChargeAnywhere(id) {
  id = String(id || '');
  for (const acc of db.get().accounts) {
    if (!acc.pagamentos) continue;
    const ch = (acc.pagamentos.charges || []).find(c => c.id === id || c.correlationID === id);
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

  // CNPJ: além dos dígitos, confere na Receita Federal se a empresa existe.
  // Para CPF não há consulta pública gratuita — quem confirma a existência é o
  // adquirente ao gerar a cobrança, e a mensagem dele já chega ao cliente.
  // Consulta fora do ar não reprova ninguém (ver src/documento.js).
  if (doc.length === 14) {
    const eCnpj = await documento.erroDocCompleto(doc);
    if (eCnpj) { const e = new Error(eCnpj); e.status = 400; throw e; }
  }

  const name = String(fields.name).trim().slice(0, 120);
  const email = String(fields.email).trim().toLowerCase().slice(0, 140);
  ch.payer = { name, taxID: doc, email, phone, at: Date.now() };
  if (!ch.contactName) ch.contactName = name;

  // -------------------------------------------------------------------------
  // PIX ADIADO: agora dá para gerar
  //
  // Com um gateway que exige o pagador (Simplify), a cobrança nasceu sem
  // código — era impossível gerá-lo antes de saber quem ia pagar. Os dados
  // acabaram de chegar, então o Pix é criado AQUI, e o cliente vê o código na
  // tela seguinte sem perceber que houve duas etapas.
  //
  // Se o gateway recusar (CPF que passa nos dígitos mas não existe, por
  // exemplo), o erro dele sobe para o formulário: é a única verificação de
  // existência que se tem para CPF, e ela é boa.
  // -------------------------------------------------------------------------
  if (!ch.brCode && gateway().requiresPayer && ch.status === 'active') {
    const sub = activeSubaccount(acc);
    const cfg = platformCfg();
    const splits = (ch.platformCut > 0 && cfg.splitPixKey)
      ? [{ pixKey: cfg.splitPixKey, value: ch.platformCut }] : null;
    const expiresIn = Math.max(300, Math.round(((ch.expiresAt || 0) - Date.now()) / 1000) || 86400);
    const g = await gateway().createCharge({
      correlationID: ch.correlationID, value: ch.value, comment: ch.comment || '',
      customer: {
        name, phone: phone ? '+' + phone : undefined,
        payer: { name, document: doc, email, phone }
      },
      expiresIn, subPixKey: sub && sub.pixKey, splits
    });
    ch.brCode = g.brCode || '';
    ch.qrCodeImage = g.qrCodeImage || '';
    if (g.paymentLinkUrl) ch.paymentLinkUrl = g.paymentLinkUrl;
    if (g.gatewayId) ch.gatewayId = g.gatewayId;
    if (g.expiresAt) ch.expiresAt = g.expiresAt;
    log(acc, { type: 'charge_pix_gerado', chargeId: ch.id, amount: ch.value, detail: 'Pix gerado após a identificação no checkout' });
  }

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

  // -------------------------------------------------------------------------
  // 1) CONTATO no Koonfy — NUNCA duas fichas para a mesma pessoa
  //
  // Quem já conversou no WhatsApp e depois compra pelo checkout costuma digitar
  // o celular de outro jeito (sem o 9, com DDI, com o fixo). Só pelo telefone,
  // isso criava um segundo contato: a compra ia para a ficha nova e todo o
  // histórico de conversa ficava na antiga.
  //
  // Então procura primeiro por CPF/CNPJ, e-mail ou final do telefone (ver
  // `contatoDaCobranca`); só cria ficha nova quando é gente nova mesmo.
  // -------------------------------------------------------------------------
  const origem = { type: 'checkout', id: ch.id, headline: 'Checkout Koonfy', body: ch.comment || '', ts: Date.now() };
  let contact = contatoDaCobranca(acc, { waId: phone, payer: { taxID: doc, email, phone } });
  if (contact) {
    // Reaproveita a ficha e completa só o que falta — o que o cliente já tinha
    // preenchido vale mais que o que ele digitou com pressa no checkout.
    if (!contact.email) contact.email = email;
    if (!contact.name || contact.name === contact.waId) contact.name = name;
    if (!contact.source) contact.source = origem;
    log(acc, { type: 'contato_reaproveitado', chargeId: ch.id, detail: `${contact.name} já era contato (${contact.waId}); a compra entrou na ficha existente` });
  } else {
    contact = store.upsertContact(acc, phone, name, { email, source: origem });
  }
  if (!contact.email) contact.email = email;
  contact.vars = contact.vars || {};
  if (!contact.vars.cpf_cnpj) contact.vars.cpf_cnpj = doc;
  contact.tags = contact.tags || [];
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

  // 3) EVENTOS — trilha no Pagamentos + log da plataforma + tempo real no painel
  log(acc, { type: 'payer_identified', chargeId: ch.id, amount: ch.value, detail: `${name} preencheu os dados no checkout (${fmtCpfCnpj(doc)})` });
  store.logEvent({ type: 'pagamentos_checkout_identify', accountId: acc.id, chargeId: ch.id, waId: contact.waId });
  db.save();
  if (broadcast) {
    broadcast('pagamentos', { accountId: acc.id, kind: 'charge', chargeId: ch.id, status: 'identified', contactName: name });
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
// ---------------------------------------------------------------------------
// COMPRA CONFIRMADA → o contato anda no funil
//
// A etapa de destino é ESCOLHIDA pelo cliente (Pagamentos → Ajustes). Antes
// era "Ganho" no código: quem renomeou a etapa ou montou outro funil ficava com
// o contato parado onde estava, sem erro nenhum aparecendo.
//
// Sem etapa configurada, procura uma que pareça de fechamento. Não achando,
// não move — inventar uma etapa é pior que deixar quieto.
// ---------------------------------------------------------------------------
function etapaDeCompra(acc) {
  const stages = acc.stages || [];
  const escolhida = (ensure(acc).settings || {}).paidStage;
  if (escolhida && stages.includes(escolhida)) return escolhida;
  // Os nomes que uma etapa de fechamento costuma ter. Não é adivinhação
  // elegante — é o que evita o contato ficar parado em quem nunca abriu os
  // Ajustes. Quem usa outro nome escolhe na mão, ali do lado.
  return stages.find(s => /ganho|fechad|conclu|client|vend|compr|pago/i.test(s)) || '';
}

function advancePipelineOnPaid(acc, ch) {
  const contact = contatoDaCobranca(acc, ch);
  if (!contact) return;
  const alvo = etapaDeCompra(acc);
  if (alvo && contact.stage !== alvo) {
    const from = contact.stage;
    contact.stage = alvo;
    log(acc, { type: 'pipeline_moved', chargeId: ch.id, detail: `${contact.name}: ${from} → ${alvo} (pagamento confirmado)` });
  }
  const tag = (ensure(acc).settings || {}).paidTag;
  if (tag) {
    contact.tags = contact.tags || [];
    if (!contact.tags.includes(tag)) contact.tags.push(tag);
  }
}

// ---------------------------------------------------------------------------
// QUEM É O CONTATO DESTA COBRANÇA
//
// O telefone sozinho não basta. Quem já é contato pode comprar "por fora" — no
// checkout, digitando o celular com outro formato, sem o 9, ou o fixo — e aí
// nascia um SEGUNDO contato para a mesma pessoa: a compra ficava no contato
// novo e o histórico de conversa no antigo.
//
// Aqui a busca é por CPF/CNPJ e e-mail além do telefone, e em TODOS os canais.
// Documento e e-mail são únicos por pessoa de um jeito que o telefone digitado
// à mão não é.
// ---------------------------------------------------------------------------
function contatoDaCobranca(acc, ch) {
  const p = ch.payer || {};
  const doc = String(p.taxID || '').replace(/\D/g, '');
  const email = String(p.email || '').trim().toLowerCase();
  const waId = ch.waId || p.phone;

  if (waId) {
    const porFone = store.findContact(acc, store.normalizeWaId(waId));
    if (porFone) return porFone;
  }
  const lista = acc.contacts || [];
  if (doc) {
    const porDoc = lista.find(c => String((c.vars || {}).cpf_cnpj || '').replace(/\D/g, '') === doc);
    if (porDoc) return porDoc;
  }
  if (email) {
    const porEmail = lista.find(c => String(c.email || '').trim().toLowerCase() === email);
    if (porEmail) return porEmail;
  }
  // Telefone digitado diferente (com/sem o 9, com/sem DDI): compara só os 8
  // últimos dígitos, que é a parte que não muda.
  const fim = String(waId || '').replace(/\D/g, '').slice(-8);
  if (fim.length === 8) {
    const porFim = lista.find(c => String(c.waId || '').replace(/\D/g, '').slice(-8) === fim);
    if (porFim) return porFim;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CHECKOUT PÚBLICO — dados sanitizados servidos em /api/public/pay/:id
// (sem autenticação: expõe SOMENTE o necessário para pagar a cobrança).
// ---------------------------------------------------------------------------
function findProduct(acc, id) { return ensure(acc).products.find(p => p.id === id) || null; }

// ---------------------------------------------------------------------------
// LINK DE CHECKOUT DO PRODUTO
//
// Um endereço FIXO por produto, que qualquer pessoa pode abrir — diferente do
// link de cobrança, que é um por cliente e nasce depois que alguém cobra.
// ---------------------------------------------------------------------------

// O apelido sai do nome: sem acento, sem espaço, minúsculo. Um endereço que
// a pessoa consegue ditar no telefone vale mais que um id aleatório.
function apelidar(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// O APELIDO É GERADO, e nunca escolhido. O endereço é GLOBAL: um só espaço de
// nomes para todas as contas. Com o campo aberto, o primeiro cliente a chegar
// leva "curso", "mentoria", "black-friday" — e leva também "koonfy",
// "pagamento-seguro", "suporte-oficial", e aí o endereço da plataforma passa a
// hospedar uma página de cobrança que qualquer um pode ter escrito. Nenhuma
// lista de palavras proibidas resolve: sempre falta uma, e a que falta é a que
// vai ser usada.
//
// Nome do produto + quatro caracteres aleatórios. Continua legível e ditável no
// telefone — que é o motivo de não ser só um id —, e o sufixo tira a disputa:
// ninguém escolhe, ninguém toma o do outro, e não dá para montar de propósito
// um endereço parecido com o de outra pessoa.
function apelidoLivre(base, ignorarId) {
  const raiz = apelidar(base) || 'produto';
  const usado = (slug) => {
    for (const a of db.get().accounts) {
      for (const pr of ((a.pagamentos && a.pagamentos.products) || [])) {
        if (pr.slug === slug && pr.id !== ignorarId) return true;
      }
    }
    return false;
  };
  // Vinte tentativas antes de desistir do nome: com 4 caracteres em base 36 são
  // 1,6 milhão de combinações por raiz, então a segunda colisão já é folclore.
  for (let i = 0; i < 20; i++) {
    const t = raiz + '-' + crypto.randomBytes(3).toString('hex').slice(0, 4);
    if (!usado(t)) return t;
  }
  return raiz + '-' + crypto.randomBytes(6).toString('hex');
}

// O endereço do produto. Sai pelo mesmo domínio das cobranças, para o cliente
// ver sempre o mesmo lugar quando vai pagar.
function productLink(prod) {
  if (!prod || !prod.slug || prod.linkOn === false) return '';
  // SEM PREÇO NÃO HÁ LINK. O endereço leva direto ao pagamento, e produto de
  // valor combinado não tem o que pagar — devolver um link que abre num 404 é
  // pior do que não devolver nada: a tela mostraria um endereço para copiar e
  // o cliente descobriria o problema depois de colá-lo no anúncio.
  if (!prod.price || prod.price < 100) return '';
  const { base, curto } = require('./hosts').basePagamento(baseUrl());
  if (!base) return '';
  return curto ? `${base}/c/${prod.slug}` : `${base}/c/${prod.slug}`;
}

// Procura o produto pelo apelido em todas as contas — como as cobranças, o
// endereço é público e não carrega a conta junto.
function produtoPorApelido(slug) {
  const alvo = String(slug || '').toLowerCase();
  if (!alvo) return null;
  for (const acc of db.get().accounts) {
    for (const prod of ((acc.pagamentos && acc.pagamentos.products) || [])) {
      if (prod.slug === alvo) return { acc, prod };
    }
  }
  return null;
}

// A vitrine do produto: o mesmo desenho do checkout, sem cobrança ainda.
// `needsId` é o que faz a página abrir no passo da identificação — e é
// verdade aqui de um jeito mais forte que numa cobrança: sem os dados não
// existe cobrança nenhuma para pagar.
function publicProductView(slug) {
  const achado = produtoPorApelido(slug);
  if (!achado) return null;
  const { acc, prod } = achado;
  if (prod.linkOn === false || prod.active === false) return null;
  if (!prod.price || prod.price < 100) return null;   // produto sem preço não vende
  return {
    produto: prod.slug, status: 'active', accId: acc.id,
    value: prod.price, comment: prod.name,
    brCode: '', qrCodeImage: '', createdAt: Date.now(), paidAt: null, expiresAt: null,
    needsId: true, prefill: {},
    payerName: '',
    card: (() => {
      const pub = cardPublic();
      const podeReceber = cardConfig().settleMode === 'wallet' ? true : cardReady(acc).ok;
      return { ...pub, credit: pub.credit && podeReceber, boleto: pub.boleto && podeReceber,
               installments: installmentOptions(prod.price) };
    })(),
    method: 'pix', paidCard: null,
    checkout: checkoutBranding(acc, { checkoutId: prod.checkoutId, productId: prod.id })
  };
}

// A COBRANÇA NASCE AQUI, e não ao abrir o link: uma cobrança por visita faria
// o robô que gera a prévia do link no WhatsApp virar uma venda pendente, e a
// lista do lojista virar lixo em uma semana.
async function cobrancaDoLink(slug, dados, broadcast) {
  const achado = produtoPorApelido(slug);
  if (!achado) { const e = new Error('Produto não encontrado'); e.status = 404; throw e; }
  const { acc, prod } = achado;
  if (prod.linkOn === false || prod.active === false) { const e = new Error('Este link não está mais ativo'); e.status = 404; throw e; }
  const ch = await createCharge(acc, {
    valueCents: prod.price, comment: prod.name,
    origin: 'link', productId: prod.id, checkoutId: prod.checkoutId,
    pagador: dados
  }, broadcast);
  await identifyPayer(ch.id, dados, broadcast);
  return ch.id;
}
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
    // Claro ou escuro. Nasce escuro, que é como o checkout já vinha.
    tema: ck.tema === 'claro' ? 'claro' : 'escuro',
    // O botão: brilhante (faixa atravessando) ou chapado. Quem escolhe é o
    // dono do checkout. Sem cores próprias, a faixa é derivada do acento
    // dele, para o checkout de quem escolheu roxo continuar roxo.
    botao: {
      brilhante: (ck.botao && ck.botao.brilhante !== undefined) ? !!ck.botao.brilhante : true,
      angulo: (ck.botao && Number(ck.botao.angulo)) || 45,
      cores: (ck.botao && Array.isArray(ck.botao.cores)) ? ck.botao.cores.filter(c => /^#[0-9a-fA-F]{3,8}$/.test(c)) : []
    },
    merchant: sub.name || acc.name || '',
    blocks: Array.isArray(ck.blocks) && ck.blocks.length ? ck.blocks : defaultBlocks(),
    timer: ck.timer || {}, benefits: ck.benefits || {}, testimonial: ck.testimonial || {},
    guarantee: ck.guarantee || {}, faq: ck.faq || {}, notice: ck.notice || {}, badges: ck.badges || {},
    methods: Object.assign({ pix: true, credit: true, boleto: false }, ck.methods || {}),
    checkoutName: ck.name || '', productId: prod ? prod.id : '', checkoutId: ck.id || ''
  };
}

// O que já se sabe de quem vai pagar, para o checkout nascer preenchido.
// Ordem: o que a COBRANÇA já tem (o pagador identificado nela) manda, porque é
// o dado mais específico; depois o CONTATO, que guarda o que ele preencheu na
// compra anterior.
function dadosConhecidos(acc, ch) {
  const p = ch.payer || {};
  const ct = ch.waId ? store.findContact(acc, ch.waId) : null;
  const vars = (ct && ct.vars) || {};
  return {
    name: p.name || ch.contactName || (ct && ct.name) || '',
    phone: p.phone || ch.waId || (ct && ct.waId) || '',
    email: p.email || (ct && ct.email) || '',
    taxID: p.taxID || vars.cpf_cnpj || '',
    // A tela avisa que reconheceu o cliente em vez de mostrar os campos
    // preenchidos sem explicação — o que faria a pessoa achar que o site
    // sabe mais dela do que devia.
    conhecido: !!(!ch.payer && ct && (ct.email || vars.cpf_cnpj))
  };
}

function publicChargeView(id) {
  id = String(id || '');
  // Modo demo (preview do Checkout Builder): /pay/demo-<accountId>
  if (id.startsWith('demo-')) {
    // /pay/demo-<accId>[:checkoutId[:productId]] — prévia do builder
    const parts = id.slice(5).split(':');
    const acc = db.findAccount(parts[0]);
    if (!acc || !acc.pagamentos) return null;
    const prod = parts[2] ? findProduct(acc, parts[2]) : null;
    return {
      demo: true, id, status: 'active',
      value: (prod && prod.price) || 9700, comment: (prod && prod.name) || 'Exemplo: Plano mensal',
      brCode: '00020126580014BR.GOV.BCB.PIX0136demo-koonfy-checkout-preview520400005303986540597.005802BR5909KOONFY6009SAO PAULO62070503***6304DEMO',
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
    // -----------------------------------------------------------------------
    // CLIENTE QUE JÁ COMPROU não digita tudo de novo
    //
    // A primeira compra cria o CONTATO com nome, telefone, e-mail e CPF. Na
    // compra seguinte esses dados já existem — pedir de novo é atrito puro, e
    // atrito no checkout é carrinho abandonado.
    //
    // Vem preenchido, mas os campos continuam editáveis: mudar de e-mail ou
    // comprar no CPF da empresa é normal, e travar isso seria pior que pedir.
    // -----------------------------------------------------------------------
    prefill: dadosConhecidos(acc, ch),
    payerName: ch.payer ? ch.payer.name : '',
    // CARTÃO E BOLETO: além de o admin ter ligado e configurado o adquirente,
    // no modo SPLIT o LOJISTA precisa ter recebedor ativo — ali o dinheiro vai
    // direto para ele, e sem o recebedor o pagamento falha depois de a pessoa
    // digitar número, validade, CVV e CPF. Oferecer um método que não pode ser
    // cobrado é pior que não oferecer: ela desiste achando que o cartão dela é
    // que não presta. No modo CARTEIRA quem recebe é a plataforma, e aí a
    // conta do lojista não entra na decisão.
    card: (() => {
      const pub = cardPublic();
      const podeReceber = cardConfig().settleMode === 'wallet' ? true : cardReady(acc).ok;
      return {
        ...pub,
        credit: pub.credit && podeReceber,
        boleto: pub.boleto && podeReceber,
        installments: installmentOptions(ch.value)
      };
    })(),
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
function isPagamentosCharge(correlationID) { return String(correlationID || '').startsWith('ep-'); }

function applyPaid(freshCharge, broadcast) {
  const cid = freshCharge.correlationID || '';
  const accId = cid.split('-')[1];
  const acc = db.findAccount(accId);
  if (!acc) { store.logEvent({ type: 'pagamentos_unmatched', correlationID: cid }); return { ok: false }; }
  const ch = findCharge(acc, cid);
  if (!ch) { store.logEvent({ type: 'pagamentos_unmatched', accountId: acc.id, correlationID: cid }); return { ok: false }; }
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
  // Venda no CARTÃO: o líquido entra na carteira do cliente aqui no Koonfy
  // (a liberar, conforme o prazo do adquirente) para ele usar na plataforma
  // ou sacar depois.
  if (ch.method === 'card') { try { creditCardSale(acc, ch, broadcast); } catch (e) { log(acc, { type: 'wallet_error', chargeId: ch.id, detail: e.message }); } }
  // Venda no PIX: o líquido entra na MESMA carteira, já disponível. O dinheiro
  // fica na subconta da Woovi; a carteira é o registro do quanto é do cliente.
  // Sem isto o Pix não aparecia em lugar nenhum e o cliente não tinha como
  // saber quanto tinha para sacar.
  else { try { creditPixSale(acc, ch, broadcast); } catch (e) { log(acc, { type: 'wallet_error', chargeId: ch.id, detail: e.message }); } }
  // AVISO nos aparelhos: o dono da conta e, quando é venda de cliente, o admin
  // da plataforma. Best-effort — push com problema não pode impedir a
  // confirmação de um pagamento que já entrou.
  try { require('./avisos').avisarVenda(acc, ch); } catch (e) { log(acc, { type: 'push_error', chargeId: ch.id, detail: e.message }); }
  // Tracking: atribui a venda à campanha de origem + reenvia a conversão
  // (Meta CAPI / GA4 / TikTok) automaticamente — não bloqueia a confirmação.
  try { require('./tracking').onPaid(acc, ch, broadcast); } catch {}
  // ASSINATURA DO KOONFY paga pelo checkout do dono. Reaproveita a ativação
  // do Pix (que também cuida de período, receita e comissão de afiliado)
  // montando o mesmo correlationID que ela espera.
  if (ch.saas && ch.saas.accountId && ch.saas.planId) {
    try {
      require('./woovi').applyPayment({
        correlationID: 'sub-' + ch.saas.accountId + '-' + ch.saas.planId + '-' + ch.id,
        value: ch.value
      }, broadcast);
    } catch (err) {
      log(acc, { type: 'saas_activate_error', chargeId: ch.id, detail: err.message });
    }
  }
  db.save();
  if (broadcast) broadcast('pagamentos', { accountId: acc.id, chargeId: ch.id, status: 'paid', amount: ch.value, contactName: ch.contactName, waId: ch.waId });

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
  const errDoc = documento.erroDoc(doc);
  if (errDoc) { const e = new Error(errDoc); e.status = 400; throw e; }

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
  const errDoc = documento.erroDoc(doc);
  if (errDoc) { const e = new Error(errDoc); e.status = 400; throw e; }

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
    const lista = (acc.pagamentos && acc.pagamentos.charges) || [];
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
  } else if ((status === 'refunded' || status === 'chargeback') && ch.status === 'paid') {
    ch.status = status;
    ch.contestedAt = Date.now();
    log(acc, { type: status === 'chargeback' ? 'card_chargeback' : 'card_refunded', chargeId: ch.id, amount: ch.value,
      detail: status === 'chargeback' ? 'Compra contestada pelo portador (chargeback)' : 'Pagamento estornado pelo adquirente' });
    plog({ type: status === 'chargeback' ? 'card_chargeback' : 'card_refunded', accountId: acc.id, accountName: acc.name, amount: ch.value });
    // Tira o valor da carteira: sem isto o cliente sacaria dinheiro que já
    // voltou para o comprador, e o rombo sobraria para a plataforma.
    try { reverterVenda(acc, ch, status === 'chargeback' ? 'chargeback' : 'refund_sale', broadcast); }
    catch (e) { log(acc, { type: 'wallet_error', chargeId: ch.id, detail: e.message }); }
    if (broadcast) broadcast('pagamentos', { accountId: acc.id, chargeId: ch.id, status });
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
  // TODAS as contas com Pagamentos entram na gestão financeira (inclusive a do
  // admin, que também pode vender) — diferente do billing, que só lista clientes.
  const accounts = data.accounts.filter(a => a.pagamentos);
  const rows = accounts.map(a => {
    const ep = a.pagamentos;
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
  const todas = accounts.flatMap(a => (a.pagamentos.charges || []));
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
    pendentes: cobrancasEmAberto(accounts),
    logs: cfg.logs.slice(0, 80)
  };
}

// ---------------------------------------------------------------------------
// COBRANÇAS EM ABERTO (vendas pendentes e carrinhos abandonados)
//
// Elas sempre existiram no banco — toda cobrança nasce 'active' e só vira
// 'paid' quando o pagamento entra —, mas o painel só mostrava a CONTAGEM
// delas. Sem a lista não dá para saber quem quase comprou, que é justamente
// quem vale a pena recuperar.
//
// A separação entre as duas é o vencimento, não um estado guardado: enquanto
// o Pix é pagável a venda está pendente; passou do prazo sem pagar, virou
// carrinho abandonado.
// ---------------------------------------------------------------------------
function cobrancasEmAberto(accounts) {
  const agora = Date.now();
  const lista = [];
  for (const a of accounts) {
    for (const c of (a.pagamentos.charges || [])) {
      if (c.status !== 'active' && c.status !== 'expired') continue;
      const vencida = c.status === 'expired' || (c.expiresAt && c.expiresAt < agora);
      lista.push({
        id: c.id, accountId: a.id, accountName: a.name,
        value: c.value, comment: c.comment || '',
        contactName: c.contactName || null, waId: c.waId || null,
        createdAt: c.createdAt, expiresAt: c.expiresAt || null,
        origin: c.origin || 'manual', method: c.method || 'pix',
        situacao: vencida ? 'abandonada' : 'pendente'
      });
    }
  }
  lista.sort((x, y) => y.createdAt - x.createdAt);
  const soma = (f) => lista.filter(f).reduce((s, c) => s + c.value, 0);
  return {
    itens: lista.slice(0, 200),
    pendentes: { qtd: lista.filter(c => c.situacao === 'pendente').length, valor: soma(c => c.situacao === 'pendente') },
    abandonadas: { qtd: lista.filter(c => c.situacao === 'abandonada').length, valor: soma(c => c.situacao === 'abandonada') }
  };
}

module.exports = {
  ensure, configured, platformCfg, gateway,
  activeSubaccount,   // exportado para o teste do portão do KYC
  registerSubaccount, garantirPagamentos, setSubaccountStatus, syncSubaccount, applyAccountApproved,
  createCharge, cancelCharge, findCharge, chargeMessage, chargeButton, computeOutFee,
  isPagamentosCharge, applyPaid, metrics, adminOverview, log, plog, fmtBRL,
  apelidoLivre, productLink, produtoPorApelido, publicProductView, cobrancaDoLink,
  noteBaseUrl, payLink, publicChargeView, defaultCheckout, defaultProduct, defaultBlocks,
  identifyPayer, fmtCpfCnpj, findProduct, findCheckout, checkoutBranding,
  TPL_ROLES, TPL_VARS, tplValues, roleOf, setTemplateRole, templatesByRole, pickTemplate,
  findChargeAnywhere,
  // Ponto de entrada dos webhooks de gateway: confirma o pagamento sem que cada
  // adquirente precise conhecer o funil (funil, tracking, aviso no WhatsApp).
  markPaidFromGateway: (acc, ch, broadcast) => finalizePaid(acc, ch, broadcast),
  cardConfig, cardPublic, payWithCard, payWithBoleto, refreshCardStatus, installmentOptions,
  cardAccount, cardAccountView, cardCapability, cardReady, registerCardAccount, syncCardAccount,
  creditCardSale, creditPixSale, reverterVenda,
  releaseFor, releaseReceivables, spendWallet, computeSplit, computeWithdrawFee, debitWithdraw,
  cardWebhookHandler, cardWebhookToken,
  DRIVERS
};
