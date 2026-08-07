// ============================================================================
// ADQUIRENTES — cartão de CRÉDITO e BOLETO.
//
// Os três meios aceitos no EliteChat são Pix, crédito e boleto. O Pix (Woovi)
// não passa por aqui; crédito e boleto sim, com dois adquirentes
// intercambiáveis: o admin escolhe um no Admin SaaS e o resto do sistema não
// muda nada.
//
// Não há cartão de débito: para pagamento à vista o Pix resolve melhor (cai na
// hora, sem taxa de adquirente). Registros antigos com kind 'debit' continuam
// sendo lidos para não quebrar o histórico de recebíveis.
//
// Interface única de cada driver:
//   configured(cfg)                      -> bool
//   charge({ cfg, valueCents, installments, card, holder, customer,
//            description, correlationID, softDescriptor })
//        -> { ok, status, gatewayId, brand, last4, authCode, message, raw }
//   boleto({ cfg, valueCents, customer, description, correlationID, dueDays })
//        -> { ok, status, gatewayId, url, line, barcode, dueDate }
//   getCharge({ cfg, gatewayId })        -> { status, paidAt }
//   refund({ cfg, gatewayId, valueCents })-> { ok }
//
// status normalizado: 'paid' | 'pending' | 'refused' | 'refunded' | 'canceled'
//
// Docs:
//   Pagar.me v5 — https://docs.pagar.me/reference  (Basic auth: sk_ como usuário, senha vazia)
//   Asaas v3    — https://docs.asaas.com/reference (header access_token)
// ============================================================================

const PAGARME_BASE = 'https://api.pagar.me/core/v5';
const ASAAS_BASE = { prod: 'https://api.asaas.com/v3', sandbox: 'https://api-sandbox.asaas.com/v3' };

// Erro com status HTTP para a API repassar direito ao checkout.
function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

// ---------------------------------------------------------------------------
// PAGAR.ME (v5)
// ---------------------------------------------------------------------------
const pagarme = {
  id: 'pagarme',
  label: 'Pagar.me',
  configured: cfg => !!(cfg && cfg.secretKey),

  async call(cfg, method, path, body) {
    // Basic auth: secret key como usuário, senha vazia.
    const auth = Buffer.from(`${cfg.secretKey}:`).toString('base64');
    const resp = await fetch(PAGARME_BASE + path, {
      method,
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data.errors && JSON.stringify(data.errors)) || data.message || `Erro ${resp.status} no Pagar.me`;
      throw erro(msg, resp.status === 401 ? 500 : 400);  // 401 = credencial da plataforma, não culpa do pagador
    }
    return data;
  },

  async charge({ cfg, valueCents, installments, card, holder, customer, description, correlationID, softDescriptor, split }) {
    const metodo = 'credit_card';
    const pagamento = {
      payment_method: metodo,
      split: split && split.length ? split : undefined,
      [metodo]: {
        installments: Math.max(1, Number(installments) || 1),
        statement_descriptor: (softDescriptor || '').slice(0, 13) || undefined,
        // `card_id` é o cartão que o próprio Pagar.me já guardou (vem em
        // last_transaction.card.id de uma cobrança aprovada). É o que permite
        // cobrar de novo sem pedir o número outra vez.
        card_id: card.token || undefined,
        card: card.token
          ? undefined
          : {
            number: onlyDigits(card.number),
            holder_name: card.holderName,
            exp_month: Number(card.expMonth),
            exp_year: Number(card.expYear),
            cvv: String(card.cvv),
            billing_address: holder && holder.zip ? {
              line_1: holder.address || 'n/d',
              zip_code: onlyDigits(holder.zip),
              city: holder.city || 'n/d',
              state: (holder.state || 'SP').slice(0, 2).toUpperCase(),
              country: 'BR'
            } : undefined
          },
      }
    };

    const body = {
      closed: true,
      code: correlationID,
      customer: {
        name: customer.name,
        email: customer.email || 'sem-email@elitechat.com.br',
        type: 'individual',
        document: onlyDigits(customer.taxId),
        document_type: onlyDigits(customer.taxId).length > 11 ? 'CNPJ' : 'CPF',
        phones: customer.phone ? {
          mobile_phone: {
            country_code: '55',
            area_code: onlyDigits(customer.phone).slice(-11, -9) || '11',
            number: onlyDigits(customer.phone).slice(-9)
          }
        } : undefined
      },
      items: [{ amount: valueCents, description: (description || 'Pagamento').slice(0, 60), quantity: 1 }],
      payments: [pagamento]
    };

    const d = await pagarme.call(cfg, 'POST', '/orders', body);
    const charge = (d.charges && d.charges[0]) || {};
    const tx = charge.last_transaction || {};
    return {
      ok: charge.status === 'paid',
      status: mapPagarme(charge.status),
      gatewayId: charge.id || d.id || '',
      brand: tx.card ? tx.card.brand : '',
      last4: tx.card ? tx.card.last_four_digits : '',
      // id do cartão salvo no adquirente — guardado para a próxima cobrança
      cardToken: (tx.card && tx.card.id) || '',
      holderName: (tx.card && tx.card.holder_name) || '',
      authCode: tx.acquirer_auth_code || '',
      message: tx.acquirer_message || charge.status || '',
      raw: undefined
    };
  },

  // ---- BOLETO ----
  // Assíncrono por natureza: nasce 'pending' e só vira 'paid' quando o banco
  // compensa (1 a 2 dias úteis). Quem confirma é a consulta/webhook, igual Pix.
  async boleto({ cfg, valueCents, customer, description, correlationID, dueDays, split }) {
    const venc = new Date(Date.now() + (Number(dueDays) || 3) * 86400000);
    const body = {
      closed: true,
      code: correlationID,
      customer: {
        name: customer.name,
        email: customer.email || 'sem-email@elitechat.com.br',
        type: onlyDigits(customer.taxId).length > 11 ? 'company' : 'individual',
        document: onlyDigits(customer.taxId),
        document_type: onlyDigits(customer.taxId).length > 11 ? 'CNPJ' : 'CPF'
      },
      items: [{ amount: valueCents, description: (description || 'Pagamento').slice(0, 60), quantity: 1 }],
      payments: [{
        payment_method: 'boleto',
        split: split && split.length ? split : undefined,
        boleto: {
          instructions: (description || 'Pagamento EliteChat').slice(0, 255),
          due_at: venc.toISOString(),
          document_number: String(correlationID).slice(-16)
        }
      }]
    };
    const d = await pagarme.call(cfg, 'POST', '/orders', body);
    const charge = (d.charges && d.charges[0]) || {};
    const tx = charge.last_transaction || {};
    return {
      ok: true,
      status: mapPagarme(charge.status) || 'pending',
      gatewayId: charge.id || d.id || '',
      url: tx.pdf || tx.url || '',
      line: tx.line || '',
      barcode: tx.barcode || '',
      dueDate: venc.getTime(),
      message: charge.status || ''
    };
  },

  async getCharge({ cfg, gatewayId }) {
    const d = await pagarme.call(cfg, 'GET', '/charges/' + encodeURIComponent(gatewayId));
    return { status: mapPagarme(d.status), paidAt: d.paid_at ? new Date(d.paid_at).getTime() : null };
  },

  async refund({ cfg, gatewayId, valueCents }) {
    await pagarme.call(cfg, 'DELETE', '/charges/' + encodeURIComponent(gatewayId), valueCents ? { amount: valueCents } : undefined);
    return { ok: true };
  },

  // ---- RECEBEDOR (KYC) ----
  // Cada cliente do Elite Pay vira um "recipient" com dados cadastrais e conta
  // bancária própria. Obrigatório desde a circular 3.978/20 do Banco Central.
  async createRecipient({ cfg, f, code }) {
    const pf = f.docType !== 'company';
    const doc = onlyDigits(f.document);
    const registro = pf ? {
      type: 'individual',
      document: doc,
      name: f.name,
      email: f.email,
      mother_name: f.motherName,
      birthdate: f.birthdate,                    // DD/MM/AAAA
      monthly_income: Math.round(Number(f.monthlyIncome) || 0),
      professional_occupation: f.occupation || 'Empresário',
      address: enderecoPagarme(f),
      phone_numbers: [telefonePagarme(f.phone)]
    } : {
      type: 'corporation',
      document: doc,
      company_name: f.companyName || f.name,
      trading_name: f.name,
      annual_revenue: Math.round(Number(f.annualRevenue) || Number(f.monthlyIncome) * 12 || 0),
      founding_date: f.foundingDate || f.birthdate,
      address: enderecoPagarme(f),
      phone_numbers: [telefonePagarme(f.phone)],
      main_address: enderecoPagarme(f),
      managing_partners: [{
        name: f.name, email: f.email, document: onlyDigits(f.partnerDocument || f.document),
        type: 'individual', mother_name: f.motherName, birthdate: f.birthdate,
        monthly_income: Math.round(Number(f.monthlyIncome) || 0),
        professional_occupation: f.occupation || 'Sócio',
        self_declared_legal_representative: true,
        address: enderecoPagarme(f), phone_numbers: [telefonePagarme(f.phone)]
      }]
    };

    const body = {
      code,
      register_information: registro,
      default_bank_account: {
        holder_name: f.bankHolderName || f.name,
        holder_type: pf ? 'individual' : 'company',
        holder_document: onlyDigits(f.bankHolderDocument || f.document),
        bank: onlyDigits(f.bank),
        branch_number: onlyDigits(f.branch),
        branch_check_digit: onlyDigits(f.branchDigit) || undefined,
        account_number: onlyDigits(f.accountNumber),
        account_check_digit: onlyDigits(f.accountDigit),
        type: f.accountType === 'savings' ? 'savings' : 'checking'
      },
      transfer_settings: { transfer_enabled: true, transfer_interval: 'Daily', transfer_day: 0 }
    };
    const d = await pagarme.call(cfg, 'POST', '/recipients', body);
    return { id: d.id, status: mapRecipientPagarme(d.status), raw: d.status };
  },

  async getRecipient({ cfg, id }) {
    const d = await pagarme.call(cfg, 'GET', '/recipients/' + encodeURIComponent(id));
    return { id: d.id, status: mapRecipientPagarme(d.status), raw: d.status, balance: null };
  },

  // Split: o recebedor do cliente fica com o líquido, a plataforma com a taxa.
  // `liable` = quem responde por chargeback; `charge_processing_fee` = quem paga
  // a taxa do adquirente. Ambos ficam com o cliente (padrão de marketplace).
  splitFor({ recipientId, platformRecipientId, valueCents, platformCut }) {
    const doCliente = Math.max(0, valueCents - platformCut);
    const split = [{
      amount: doCliente, type: 'flat', recipient_id: recipientId,
      options: { liable: true, charge_processing_fee: true, charge_remainder_fee: true }
    }];
    if (platformCut > 0 && platformRecipientId) {
      split.push({
        amount: platformCut, type: 'flat', recipient_id: platformRecipientId,
        options: { liable: false, charge_processing_fee: false, charge_remainder_fee: false }
      });
    }
    return split;
  }
};

// Endereço no formato do Pagar.me.
function enderecoPagarme(f) {
  return {
    street: f.street || 'n/d',
    complementary: f.complement || undefined,
    street_number: String(f.number || 'S/N'),
    neighborhood: f.neighborhood || 'n/d',
    city: f.city || 'n/d',
    state: String(f.state || 'SP').slice(0, 2).toUpperCase(),
    zip_code: onlyDigits(f.zip),
    reference_point: undefined
  };
}
function telefonePagarme(phone) {
  const d = onlyDigits(phone);
  return { ddd: d.slice(-11, -9) || '11', number: d.slice(-9), type: 'mobile' };
}
function mapRecipientPagarme(s) {
  switch (String(s || '').toLowerCase()) {
    case 'active': return 'active';
    case 'registration': case 'affiliation': return 'pending';
    case 'refused': return 'refused';
    case 'blocked': case 'inactive': case 'suspended': return 'blocked';
    default: return 'pending';
  }
}

function mapPagarme(s) {
  switch (String(s || '').toLowerCase()) {
    case 'paid': case 'captured': return 'paid';
    case 'pending': case 'processing': case 'authorized_pending_capture': return 'pending';
    case 'refunded': case 'partial_refunded': return 'refunded';
    case 'canceled': case 'voided': return 'canceled';
    default: return 'refused';
  }
}

// ---------------------------------------------------------------------------
// ASAAS (v3)
// ---------------------------------------------------------------------------
const asaas = {
  id: 'asaas',
  label: 'Asaas',
  configured: cfg => !!(cfg && cfg.apiKey),

  base(cfg) { return cfg.sandbox ? ASAAS_BASE.sandbox : ASAAS_BASE.prod; },

  async call(cfg, method, path, body) {
    const resp = await fetch(asaas.base(cfg) + path, {
      method,
      headers: {
        'access_token': cfg.apiKey,
        'Content-Type': 'application/json',
        'User-Agent': 'EliteChat'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = (data.errors && data.errors[0] && data.errors[0].description) || data.message || `Erro ${resp.status} no Asaas`;
      throw erro(msg, resp.status === 401 ? 500 : 400);
    }
    return data;
  },

  // O Asaas exige criar/reaproveitar o cliente antes da cobrança.
  async ensureCustomer(cfg, customer) {
    const doc = onlyDigits(customer.taxId);
    if (doc) {
      const busca = await asaas.call(cfg, 'GET', '/customers?cpfCnpj=' + encodeURIComponent(doc)).catch(() => null);
      if (busca && busca.data && busca.data[0]) return busca.data[0].id;
    }
    const novo = await asaas.call(cfg, 'POST', '/customers', {
      name: customer.name,
      cpfCnpj: doc || undefined,
      email: customer.email || undefined,
      mobilePhone: onlyDigits(customer.phone) || undefined
    });
    return novo.id;
  },

  async charge({ cfg, valueCents, installments, card, holder, customer, description, correlationID, split }) {
    const customerId = await asaas.ensureCustomer(cfg, customer);
    const parcelas = Math.max(1, Number(installments) || 1);
    const valor = valueCents / 100;

    const body = {
      customer: customerId,
      billingType: 'CREDIT_CARD',
      value: valor,
      dueDate: new Date().toISOString().slice(0, 10),
      description: (description || 'Pagamento').slice(0, 500),
      externalReference: correlationID,
      // Com o cartão já tokenizado, `creditCardToken` SUBSTITUI `creditCard` e
      // `creditCardHolderInfo` — mandar os três junto é recusado.
      creditCardToken: card.token || undefined,
      creditCard: card.token ? undefined : {
        holderName: card.holderName,
        number: onlyDigits(card.number),
        expiryMonth: String(card.expMonth).padStart(2, '0'),
        expiryYear: String(card.expYear).length === 2 ? '20' + card.expYear : String(card.expYear),
        ccv: String(card.cvv)
      },
      creditCardHolderInfo: card.token ? undefined : {
        name: card.holderName,
        email: customer.email || 'sem-email@elitechat.com.br',
        cpfCnpj: onlyDigits(customer.taxId),
        postalCode: onlyDigits(holder && holder.zip),
        addressNumber: (holder && holder.number) || 'S/N',
        phone: onlyDigits(customer.phone) || undefined
      }
    };
    if (parcelas > 1) { body.installmentCount = parcelas; body.totalValue = valor; delete body.value; }
    if (split && split.length) body.split = split;   // manda o líquido à carteira do lojista

    const d = await asaas.call(cfg, 'POST', '/payments', body);
    return {
      ok: mapAsaas(d.status) === 'paid',
      status: mapAsaas(d.status),
      gatewayId: d.id || '',
      brand: (d.creditCard && d.creditCard.creditCardBrand) || '',
      last4: (d.creditCard && d.creditCard.creditCardNumber) || '',
      // Token para cobrar de novo sem pedir o cartão. Em produção a Asaas só
      // devolve depois de liberar a tokenização com o gerente da conta; sem
      // isso ele vem vazio e o cliente segue digitando o cartão.
      cardToken: (d.creditCard && d.creditCard.creditCardToken) || '',
      holderName: card.holderName || '',
      authCode: '',
      message: d.status || '',
      raw: undefined
    };
  },

  // ---- BOLETO ----
  async boleto({ cfg, valueCents, customer, description, correlationID, dueDays, split }) {
    const customerId = await asaas.ensureCustomer(cfg, customer);
    const venc = new Date(Date.now() + (Number(dueDays) || 3) * 86400000);
    const body = {
      customer: customerId,
      billingType: 'BOLETO',
      value: valueCents / 100,
      dueDate: venc.toISOString().slice(0, 10),
      description: (description || 'Pagamento').slice(0, 500),
      externalReference: correlationID
    };
    if (split && split.length) body.split = split;

    const d = await asaas.call(cfg, 'POST', '/payments', body);
    // A linha digitável vem num endpoint separado.
    let line = '', barcode = '';
    try {
      const b = await asaas.call(cfg, 'GET', `/payments/${encodeURIComponent(d.id)}/identificationField`);
      line = b.identificationField || '';
      barcode = b.barCode || '';
    } catch {}
    return {
      ok: true,
      status: mapAsaas(d.status) || 'pending',
      gatewayId: d.id || '',
      url: d.bankSlipUrl || d.invoiceUrl || '',
      line, barcode,
      dueDate: venc.getTime(),
      message: d.status || ''
    };
  },

  async getCharge({ cfg, gatewayId }) {
    const d = await asaas.call(cfg, 'GET', '/payments/' + encodeURIComponent(gatewayId));
    return { status: mapAsaas(d.status), paidAt: d.confirmedDate ? new Date(d.confirmedDate).getTime() : null };
  },

  async refund({ cfg, gatewayId, valueCents }) {
    await asaas.call(cfg, 'POST', '/payments/' + encodeURIComponent(gatewayId) + '/refund',
      valueCents ? { value: valueCents / 100 } : {});
    return { ok: true };
  },

  // ---- SUBCONTA (KYC) ----
  // No Asaas cada cliente vira uma subconta white label, com walletId próprio.
  // Só conta PJ (CNPJ) pode criar subcontas — limitação do próprio Asaas.
  async createRecipient({ cfg, f }) {
    const body = {
      name: f.name,
      email: f.email,
      loginEmail: f.email,
      cpfCnpj: onlyDigits(f.document),
      mobilePhone: onlyDigits(f.phone),
      phone: onlyDigits(f.phone) || undefined,
      address: f.street,
      addressNumber: String(f.number || 'S/N'),
      complement: f.complement || undefined,
      province: f.neighborhood,               // "province" = bairro no Asaas
      postalCode: onlyDigits(f.zip),
      incomeValue: Number(f.monthlyIncome) / 100 || 0   // Asaas usa reais
    };
    if (onlyDigits(f.document).length === 11) body.birthDate = isoDate(f.birthdate);
    else body.companyType = f.companyType || 'LIMITED';

    const d = await asaas.call(cfg, 'POST', '/accounts', body);
    // apiKey só volta UMA vez — precisa ser guardada agora.
    return { id: d.id, walletId: d.walletId, apiKey: d.apiKey || '', status: 'pending', raw: d.status || '' };
  },

  async getRecipient({ cfg, id, walletId }) {
    // Consulta a subconta pela listagem (a API não tem GET /accounts/:id público).
    const d = await asaas.call(cfg, 'GET', '/accounts?limit=100').catch(() => null);
    const sub = d && d.data ? d.data.find(a => a.id === id || a.walletId === walletId) : null;
    if (!sub) return { id, walletId, status: 'pending', raw: '' };
    // No Asaas a subconta já nasce operante, com limites até a análise concluir.
    return { id: sub.id, walletId: sub.walletId, status: 'active', raw: sub.status || '' };
  },

  // No Asaas a cobrança é emitida pela PLATAFORMA e o split manda a parte do
  // cliente para a carteira dele — o resto (a taxa) fica com quem emitiu.
  // O split incide sobre o netValue (líquido após taxa do Asaas).
  // SPLIT no Asaas: a cobrança é emitida pela conta da PLATAFORMA e o líquido
  // é repassado para a carteira (walletId) do lojista. O que sobra fica na
  // conta emissora — a menos que o admin informe uma carteira própria
  // (platformWalletId), caso em que a taxa é enviada explicitamente para ela.
  splitFor({ walletId, platformWalletId, valueCents, platformCut }) {
    const doCliente = Math.max(0, valueCents - platformCut);
    const split = [];
    if (walletId && doCliente > 0) split.push({ walletId, fixedValue: Number((doCliente / 100).toFixed(2)) });
    if (platformWalletId && platformCut > 0) {
      split.push({ walletId: platformWalletId, fixedValue: Number((platformCut / 100).toFixed(2)) });
    }
    return split;
  }
};

// "DD/MM/AAAA" → "AAAA-MM-DD" (formato que o Asaas espera).
function isoDate(br) {
  const m = String(br || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(br || '');
}

function mapAsaas(s) {
  switch (String(s || '').toUpperCase()) {
    case 'CONFIRMED': case 'RECEIVED': case 'RECEIVED_IN_CASH': return 'paid';
    case 'PENDING': case 'AWAITING_RISK_ANALYSIS': return 'pending';
    case 'REFUNDED': case 'REFUND_REQUESTED': return 'refunded';
    case 'OVERDUE': case 'DELETED': return 'canceled';
    default: return 'refused';
  }
}

const DRIVERS = { pagarme, asaas };

// Config padrão do bloco de cartão (fica em platform.elitepay.card).
// ---------------------------------------------------------------------------
// PRAZO DE LIQUIDAÇÃO — exatamente a regra que cada adquirente pratica.
// Não é configurável: quem define é a adquirente, então o EliteChat só reproduz.
//
//   Pagar.me · crédito  D+30 corridos, UMA parcela por mês (D+30, D+60, D+90…)
//              débito   D+1 útil
//   Asaas    · crédito  D+32 corridos, UMA parcela por mês (D+32, D+64, D+96…)
//              débito   D+3 úteis
//
// `business: true` = o prazo é contado em DIAS ÚTEIS (pula sábado e domingo),
// como o Asaas faz no débito e o Pagar.me no D+1.
// `perInstallment` = o adquirente repassa parcela a parcela, não tudo de uma vez.
const SETTLE_RULES = {
  pagarme: {
    label: 'Pagar.me',
    credit: { days: 30, business: false, perInstallment: true, text: 'D+30 corridos, uma parcela por mês' },
    boleto: { days: 2, business: true, perInstallment: false, text: 'D+2 úteis após a compensação' }
  },
  asaas: {
    label: 'Asaas',
    credit: { days: 32, business: false, perInstallment: true, text: 'D+32 corridos, uma parcela por mês' },
    boleto: { days: 1, business: true, perInstallment: false, text: 'D+1 útil após a compensação' }
  }
};
// compat: alguns pontos só querem o número de dias
const SETTLE_DEFAULTS = Object.fromEntries(
  Object.entries(SETTLE_RULES).map(([k, v]) => [k, { credit: v.credit.days, boleto: v.boleto.days }])
);

// Regra vigente para um adquirente + meio de pagamento.
// 'debit' ainda é aceito aqui porque existem recebíveis antigos gravados com
// esse tipo; o prazo do boleto é o mais próximo e evita quebrar o histórico.
function settleRule(card, kind) {
  const r = SETTLE_RULES[(card && card.provider)] || SETTLE_RULES.pagarme;
  return (kind === 'boleto' || kind === 'debit') ? r.boleto : r.credit;
}

// Soma dias corridos ou úteis a partir de uma data.
// Em dias úteis, sábado e domingo não contam (é como as adquirentes contam).
function addDays(from, days, business) {
  const d = new Date(from);
  if (!business) { d.setDate(d.getDate() + days); return d.getTime(); }
  let restam = days;
  while (restam > 0) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) restam--;
  }
  return d.getTime();
}

// CRONOGRAMA de liberação de uma venda, do jeito que a adquirente paga.
// Crédito parcelado → uma liberação por parcela, mês a mês.
// Débito / crédito à vista → uma liberação só.
// Devolve [{ amount, availableAt, installment, of }] somando exatamente `net`.
function settleSchedule(card, kind, netCents, installments, from) {
  const regra = settleRule(card, kind);
  const base = from || Date.now();
  const n = regra.perInstallment ? Math.max(1, Math.min(12, Number(installments) || 1)) : 1;

  const porParcela = Math.floor(netCents / n);
  const out = [];
  for (let i = 0; i < n; i++) {
    // a última parcela absorve o arredondamento — a soma bate com o líquido
    const amount = i === n - 1 ? netCents - porParcela * (n - 1) : porParcela;
    out.push({
      amount,
      availableAt: addDays(base, regra.days * (i + 1), regra.business),
      installment: i + 1,
      of: n
    });
  }
  return out;
}

function emptyCard() {
  return {
    enabled: false,             // cartão ligado/desligado no Elite Pay
    provider: 'pagarme',        // pagarme | asaas
    credit: true,               // aceita cartão de crédito
    boleto: false,              // aceita boleto bancário
    boletoDueDays: 3,           // prazo de vencimento do boleto, em dias
    maxInstallments: 12,        // parcelas máximas no crédito
    feeCardPercent: 0,          // taxa da PLATAFORMA sobre o valor (além da do adquirente)
    feeCardFixed: 0,            // taxa fixa da plataforma, em centavos
    softDescriptor: 'ELITECHAT',

    // ---- Como o lojista recebe o dinheiro da venda no cartão ----
    // 'wallet' → cai na CARTEIRA dele dentro do EliteChat (liberada após o
    //            prazo do adquirente) e pode ser usada para pagar o plano,
    //            comprar conexões, links etc. ou ser sacada (com taxa de saque).
    // 'split'  → vai direto para o recebedor dele no adquirente (modelo antigo).
    settleMode: 'wallet',
    // Os PRAZOS não ficam aqui de propósito: quem manda é a adquirente
    // (ver SETTLE_RULES). Assim eles nunca divergem do repasse real.

    // Taxa de SAQUE das vendas no cartão (espelha a de PIX Out, mas própria:
    // o custo de repassar dinheiro de cartão é outro).
    feeOutCardPercent: 0,
    feeOutCardFixed: 0,

    // recebedor da PLATAFORMA no Pagar.me — recebe a taxa via split.
    platformRecipientId: '',
    requireApproval: false,     // exigir aprovação manual do admin antes de vender
    pagarme: { secretKey: '', publicKey: '' },
    // walletId: carteira da PLATAFORMA no Asaas que recebe a taxa no split.
    // Vazio = a taxa simplesmente fica na conta que emitiu a cobrança.
    asaas: { apiKey: '', sandbox: true, walletId: '' }
  };
}

// Prazo (em dias) para liberar uma venda — sempre o da adquirente.
function settleDays(card, kind) { return settleRule(card, kind).days; }

// Taxa retida no SAQUE de dinheiro vindo de venda no cartão.
function computeCardOutFee(card, valueCents) {
  const pct = Number(card.feeOutCardPercent) || 0;
  const fixo = Math.max(0, Math.round(Number(card.feeOutCardFixed) || 0));
  const cut = Math.floor(valueCents * pct / 100) + fixo;
  return { feePercent: pct, feeFixed: fixo, fee: Math.min(cut, valueCents) };
}

// Campos exigidos no cadastro do recebedor, por adquirente e tipo de documento.
// O Pagar.me pede KYC completo; o Asaas pede menos, mas exige endereço.
function onboardingFields(provider, docType) {
  const comuns = ['name', 'email', 'document', 'phone', 'zip', 'street', 'number', 'neighborhood', 'city', 'state', 'monthlyIncome'];
  if (provider === 'asaas') return comuns.concat(docType === 'company' ? [] : ['birthdate']);
  return comuns.concat(
    ['birthdate', 'bank', 'branch', 'accountNumber', 'accountDigit'],
    docType === 'company' ? ['companyName'] : ['motherName']
  );
}

// Valida o formulário antes de mandar ao adquirente (erro claro > erro genérico).
function validateOnboarding(provider, f) {
  const rotulos = {
    name: 'Nome completo / Razão social', email: 'E-mail', document: 'CPF ou CNPJ',
    phone: 'Celular', zip: 'CEP', street: 'Endereço', number: 'Número',
    neighborhood: 'Bairro', city: 'Cidade', state: 'Estado',
    monthlyIncome: 'Faturamento mensal', birthdate: 'Data de nascimento',
    motherName: 'Nome da mãe', companyName: 'Razão social',
    bank: 'Banco', branch: 'Agência', accountNumber: 'Conta', accountDigit: 'Dígito da conta'
  };
  const doc = onlyDigits(f.document);
  const docType = doc.length > 11 ? 'company' : 'individual';
  const faltando = onboardingFields(provider, docType)
    .filter(k => !String(f[k] == null ? '' : f[k]).trim())
    .map(k => rotulos[k] || k);
  if (faltando.length) return `Preencha: ${faltando.join(', ')}`;
  if (doc.length !== 11 && doc.length !== 14) return 'CPF ou CNPJ inválido';
  if (provider === 'asaas' && docType === 'individual' && !/^\d{2}\/\d{2}\/\d{4}$/.test(f.birthdate || ''))
    return 'Informe a data de nascimento no formato DD/MM/AAAA';
  if (provider === 'pagarme' && !/^\d{2}\/\d{2}\/\d{4}$/.test(f.birthdate || ''))
    return 'Informe a data de nascimento no formato DD/MM/AAAA';
  return null;
}

// Normaliza a config vinda do banco (preenche campos novos).
function cardCfg(ep) {
  if (!ep.card) ep.card = emptyCard();
  else for (const [k, v] of Object.entries(emptyCard())) {
    if (ep.card[k] === undefined) ep.card[k] = v;
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) if (ep.card[k][kk] === undefined) ep.card[k][kk] = vv;
    }
  }
  return ep.card;
}

function driver(card) { return DRIVERS[card.provider] || DRIVERS.pagarme; }
// Credenciais do adquirente ativo.
function creds(card) { return card.provider === 'asaas' ? card.asaas : card.pagarme; }
function isConfigured(card) { return driver(card).configured(creds(card)); }
// Só existe para o cliente se estiver ligado, configurado e com algum meio ativo.
function isAvailable(card) { return !!(card.enabled && isConfigured(card) && (card.credit || card.boleto)); }

// Taxa da PLATAFORMA sobre a venda no cartão (o que o admin cobra do cliente
// Elite Pay, por cima do que o adquirente já cobra) — espelha o modelo do Pix.
function computeCardFee(card, valueCents) {
  const pct = Number(card.feeCardPercent) || 0;
  const fixo = Math.max(0, Math.round(Number(card.feeCardFixed) || 0));
  const cut = Math.floor(valueCents * pct / 100) + fixo;
  return { feePercent: pct, feeFixed: fixo, platformCut: Math.min(cut, valueCents) };
}

// Visão pública (checkout): nunca expõe chave secreta.
function publicCard(card) {
  return {
    available: isAvailable(card),
    credit: !!card.credit && isAvailable(card),
    boleto: !!card.boleto && isAvailable(card),
    boletoDueDays: Math.max(1, Number(card.boletoDueDays) || 3),
    maxInstallments: Math.min(12, Math.max(1, Number(card.maxInstallments) || 1)),
    provider: card.provider
  };
}

// Visão do admin: diz se a chave existe, nunca o valor.
function adminCard(card) {
  return {
    enabled: !!card.enabled, provider: card.provider,
    credit: !!card.credit, boleto: !!card.boleto,
    boletoDueDays: Math.max(1, Number(card.boletoDueDays) || 3),
    maxInstallments: card.maxInstallments,
    feeCardPercent: card.feeCardPercent, feeCardFixed: card.feeCardFixed,
    feeOutCardPercent: card.feeOutCardPercent, feeOutCardFixed: card.feeOutCardFixed,
    settleMode: card.settleMode || 'wallet',
    // prazos: só leitura — vêm da adquirente, não do banco
    settleCredit: settleDays(card, 'credit'), settleBoleto: settleDays(card, 'boleto'),
    settleRules: SETTLE_RULES[card.provider] || SETTLE_RULES.pagarme,
    softDescriptor: card.softDescriptor,
    platformRecipientId: card.platformRecipientId || '',
    requireApproval: !!card.requireApproval,
    configured: isConfigured(card), available: isAvailable(card),
    pagarme: { hasSecret: !!card.pagarme.secretKey, publicKey: card.pagarme.publicKey || '' },
    asaas: { hasKey: !!card.asaas.apiKey, sandbox: !!card.asaas.sandbox, walletId: card.asaas.walletId || '' },
    drivers: Object.values(DRIVERS).map(d => ({ id: d.id, label: d.label }))
  };
}

module.exports = {
  DRIVERS, SETTLE_DEFAULTS, SETTLE_RULES, emptyCard, cardCfg, driver, creds,
  isConfigured, isAvailable, computeCardFee, computeCardOutFee,
  settleDays, settleRule, settleSchedule, addDays,
  publicCard, adminCard, onboardingFields, validateOnboarding
};
