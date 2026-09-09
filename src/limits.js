// ============================================================================
// LIMITES DE PLANO — quanto cada cliente pode usar de cada recurso.
//
// O plano define o teto de: disparos/mês, contatos (leads), fluxos, pixels,
// links rastreáveis e conexões WhatsApp.
//
//   -1 = ilimitado · 0 = bloqueado · N = teto
//
// WhatsApp e Links têm um extra: o plano inclui X e Y grátis, e o cliente pode
// COMPRAR unidades adicionais (preço definido pelo admin em
// platform.billing.extras). O teto efetivo é:  incluso no plano + extras pagos.
// ============================================================================

const db = require('./db');

// Recursos que aceitam compra de unidades avulsas.
// `whatsapps` saiu daqui: a conta tem UMA conexão de WhatsApp e não há como
// criar a segunda, então vender conexão avulsa seria cobrar por nada. O preço
// continua no Admin para não invalidar cobrança já feita, mas não é ofertado.
const PAID_EXTRAS = ['links'];

const LABEL = {
  sends: 'disparos por ciclo',
  campaigns: 'campanhas por ciclo',
  contacts: 'contatos (leads)',
  flows: 'fluxos de automação',
  pixels: 'pixels de rastreamento',
  links: 'links rastreáveis',
  whatsapps: 'conexões WhatsApp',
  agents: 'atendentes',
  webhooks: 'webhooks de entrada'
};

function planOf(acc) {
  const b = acc.billing || {};
  return db.get().plans.find(p => p.id === b.planId) || null;
}

// Preço unitário (centavos/ciclo) de cada extra, definido no Admin SaaS.
function extraPrices() {
  const e = (db.get().platform.billing || {}).extras || {};
  return {
    whatsapps: Math.max(0, Math.round(Number(e.whatsappPrice) || 0)),
    links: Math.max(0, Math.round(Number(e.linkPrice) || 0))
  };
}

// Teto efetivo de um recurso: o que o plano inclui + o que foi comprado à parte.
// Sem plano (trial) o cliente roda no plano mais barato publicado; se não houver
// nenhum plano, cai nos limites padrão.
// Conta interna do dono: sem teto e com todos os módulos. É o mesmo produto,
// só que sem a camada comercial.
// A conta do DONO entra aqui junto com as internas: ela é a conta
// operacional de quem opera a plataforma, e cobrar assinatura de si mesmo
// (ou barrá-lo por cota) não faz sentido nenhum.
function isUnlimited(acc) { return !!(acc && (acc.unlimited || acc.isAdmin)); }

function limitOf(acc, key) {
  if (isUnlimited(acc)) return -1;
  // TESTER TEM TETO PRÓPRIO, e vem ANTES do plano porque ele não tem plano
  // nenhum: caindo na regra de baixo, herdaria os limites do plano mais barato
  // publicado — que não é o que o admin configurou para as contas de teste, e
  // muda sozinho toda vez que alguém mexe na tabela de preços.
  const doTester = require('./testers').limiteDe(acc, key);
  if (doTester !== undefined) return doTester;
  const plan = planOf(acc);
  const base = (plan && plan.limits) || fallbackLimits();
  let v = base[key];
  if (v === undefined) v = db.defaultLimits()[key];
  if (v === -1) return -1;                                   // ilimitado
  if (PAID_EXTRAS.includes(key)) {
    v += Math.max(0, Number(((acc.billing || {}).extras || {})[key]) || 0);
  }
  return v;
}

// Trial / conta sem plano: usa o plano publicado mais barato como referência.
function fallbackLimits() {
  const pubs = db.get().plans.filter(p => !p.archived);
  if (!pubs.length) return db.defaultLimits();
  const cheapest = pubs.reduce((a, b) => (b.price < a.price ? b : a));
  return cheapest.limits || db.defaultLimits();
}

// Início do ciclo vigente — os disparos são contados por ciclo de cobrança.
function cycleStart(acc) {
  const b = acc.billing || {};
  const plan = planOf(acc);
  const days = (plan && plan.periodDays) || 30;
  if (b.periodEnd) return b.periodEnd - days * 86400000;
  return Date.now() - days * 86400000;
}

// Uso atual de cada recurso.
function usage(acc) {
  const t0 = cycleStart(acc);
  return {
    // DISPARO É TEMPLATE ENVIADO — campanha, envio avulso de template ou
    // template disparado por um fluxo. Antes esta linha contava toda
    // mensagem de saída: resposta do atendente, encerramento do
    // atendimento, mídia, confirmação de pagamento. Quem atendia bem
    // gastava o plano atendendo, e o teto que existe para limitar campanha
    // castigava justamente quem conversa. Mensagem dentro da janela de 24h
    // é atendimento, não disparo.
    sends: acc.messages.filter(m => m.direction === 'out' && m.type === 'template' && m.timestamp >= t0).length,
    // CAMPANHAS criadas no ciclo. Conta a criação, não o envio: uma campanha
    // agendada ou pausada já ocupou a vaga do mês.
    campaigns: (acc.campaigns || []).filter(c => (c.createdAt || 0) >= t0).length,
    contacts: acc.contacts.length,
    flows: (acc.flows || []).length,
    pixels: (acc.pixels || []).length,
    links: (acc.links || []).length,
    whatsapps: (acc.channels || []).filter(c => !c.archived).length,
    // ATENDENTES: só os ativos ocupam vaga. Quem foi desativado continua no
    // histórico das conversas que atendeu — apagar seria perder de quem foi o
    // atendimento — mas não pode custar uma vaga de plano.
    agents: (acc.team || []).filter(a => a.active !== false).length,
    webhooks: (acc.webhooks || []).length,
    // SMS conta por SEGMENTO enviado no ciclo (é assim que o provedor cobra)
    sms: (acc.smsLog || [])
      .filter(m => m.ts >= t0 && m.status !== 'failed')
      .reduce((n, m) => n + (Number(m.segments) || 1), 0)
  };
}

// Resumo pronto para a UI: usado, limite, incluso no plano, extras pagos, %.
function report(acc) {
  const u = usage(acc);
  const plan = planOf(acc);
  const base = (plan && plan.limits) || fallbackLimits();
  const prices = extraPrices();
  const out = {};
  for (const k of db.LIMIT_KEYS) {
    const limit = limitOf(acc, k);
    const included = base[k] === undefined ? db.defaultLimits()[k] : base[k];
    const extras = PAID_EXTRAS.includes(k) ? (Number(((acc.billing || {}).extras || {})[k]) || 0) : 0;
    out[k] = {
      key: k, label: LABEL[k], used: u[k], limit, included, extras,
      unlimited: limit === -1,
      extraPrice: prices[k] || 0,
      buyable: PAID_EXTRAS.includes(k) && !!prices[k],
      percent: limit === -1 ? 0 : Math.min(100, Math.round(u[k] / Math.max(1, limit) * 100)),
      exceeded: limit !== -1 && u[k] >= limit
    };
  }
  return out;
}

// Pode consumir mais `n` unidades de `key`? Retorna null (ok) ou a mensagem.
function check(acc, key, n = 1) {
  const limit = limitOf(acc, key);
  if (limit === -1) return null;
  const used = usage(acc)[key] || 0;
  if (used + n <= limit) return null;
  const price = extraPrices()[key];
  const comprar = PAID_EXTRAS.includes(key) && price
    ? ` Compre unidades adicionais em Assinatura → Extras.`
    : ` Faça upgrade de plano para liberar mais.`;
  return `Limite do plano atingido: ${limit} ${LABEL[key]}.${comprar}`;
}

// ---------------------------------------------------------------------------
// PODE CRIAR MAIS UM CONTATO?
//
// O teto de contatos vazava por todo lado: as ROTAS o respeitavam, mas quase
// nenhum contato nasce por rota. Ele nasce de webhook de integração, de evento
// da loja, de pagamento confirmado, de automação — e nenhum desses olhava o
// limite. Na prática o plano só limitava quem cadastrava na mão.
//
// A REGRA, e ela tem uma exceção de propósito:
//
//   · CONVERSA RECEBIDA NUNCA É BARRADA. Se alguém manda mensagem no WhatsApp
//     do cliente, essa mensagem TEM de ser guardada. Recusar seria perder a
//     conversa de um cliente real para proteger uma cota — e o prejuízo cai
//     sobre quem não tem culpa nenhuma, que é quem mandou a mensagem. Fica
//     acima do teto, e o painel mostra que estourou.
//   · TODO O RESTO RESPEITA. Integração, importação, evento de loja e
//     automação são crescimento automático de base: é exatamente o que o plano
//     dimensiona, e é aí que o teto tem de valer.
//
// Devolve true/false em vez de lançar: quem chama aqui está no meio de um
// webhook, e derrubar o webhook por causa de uma cota faria a integração
// inteira parecer quebrada.
function podeCriarContato(acc) {
  const teto = limitOf(acc, 'contacts');
  if (teto === -1) return true;
  return ((acc.contacts || []).length) < teto;
}

// O mesmo, mas já sabendo se o contato existe: quem já está na base não ocupa
// vaga nova, e atualizá-lo nunca é barrado.
function podeTocarContato(acc, waId, chId) {
  if (require('./store').findContact(acc, waId, chId)) return true;
  return podeCriarContato(acc);
}

// ---------------------------------------------------------------------------
// A ASSINATURA AINDA VALE HOJE?
//
// A regra existia numa só função — `requireActive`, no api.js — e ela cobre as
// ROTAS de envio manual. Só que quase nada do que a plataforma envia passa por
// rota: fluxo disparado por mensagem recebida, campanha rodando em segundo
// plano, recuperação de carrinho, SMS de automação. Nenhum desses olhava a
// assinatura.
//
// O resultado é o furo mais caro que existe num SaaS: o cliente para de pagar,
// as automações continuam rodando, e cada mensagem dessas é custo real na Meta
// e no provedor de SMS — pago pela plataforma, por uma conta que não paga mais.
//
// Aqui a regra fica num lugar só, e `requireActive` passa a usá-la também.
//
// `canceled` continua valendo até o fim do período: quem cancelou pagou pelo
// mês corrente e tem direito a usá-lo até o último dia — é o contrário de
// punir quem avisou que ia sair.
function assinaturaVale(acc) {
  if (isUnlimited(acc)) return true;
  const p = (db.get().platform || {}).billing || {};
  if (!p.enforce) return true;               // plataforma não está cobrando
  const b = acc.billing || {};
  return (b.status === 'trial' || b.status === 'active' || b.status === 'canceled')
      && b.periodEnd > Date.now();
}

// Versão que lança erro HTTP 402 — para usar direto nas rotas.
function enforce(acc, key, n = 1) {
  const msg = check(acc, key, n);
  if (msg) { const e = new Error(msg); e.status = 402; e.limit = key; throw e; }
}

// Custo mensal dos extras já contratados (entra na renovação).
function extrasCost(acc) {
  const prices = extraPrices();
  const ex = (acc.billing || {}).extras || {};
  return PAID_EXTRAS.reduce((s, k) => s + (Math.max(0, Number(ex[k]) || 0) * (prices[k] || 0)), 0);
}

// Total cobrado na renovação: plano + extras.
function chargeTotal(acc, plan) {
  const p = plan || planOf(acc);
  return (p ? p.price : 0) + extrasCost(acc);
}

// ---------------------------------------------------------------------------
// FUNCIONALIDADES (toggles do plano). Booleano por módulo: desligado no plano,
// a rota recusa com 402 e o menu do cliente esconde a tela.
// ---------------------------------------------------------------------------
const FEATURE_LABEL = {
  campaigns: 'Campanhas em massa',
  flows: 'Automações (Flow Builder)',
  schedule: 'Agendamentos',
  team: 'Chat interno',
  agents: 'Atendentes (equipe)',
  pagamentos: 'Pagamentos (cobranças)',
  links: 'Links rastreáveis',
  pixels: 'Pixels de rastreamento',
  tracking: 'Tracking (atribuição)',
  integrations: 'Integrações (webhooks/Nuvemshop)',
  sms: 'Disparos de SMS'
};

// Módulos do plano vigente. Trial/sem plano usa o plano mais barato publicado
// (mesma regra dos limites); sem nenhum plano, tudo liberado.
function featuresOf(acc) {
  // Os módulos de um tester são os que o admin liberou para TODOS os testers,
  // num lugar só. Sem esta linha ele cairia no plano mais barato publicado, e
  // o que o teste enxerga mudaria sozinho a cada mexida na tabela de planos.
  const doTester = require('./testers').modulosDe(acc);
  if (doTester) return doTester;
  const plan = planOf(acc);
  if (plan) return db.normFeatures(plan.modules, plan.modules);
  const pubs = db.get().plans.filter(p => !p.archived);
  if (!pubs.length) return db.defaultFeatures();
  const cheapest = pubs.reduce((a, b) => (b.price < a.price ? b : a));
  return db.normFeatures(cheapest.modules, cheapest.modules);
}

// O SMS não é cobrado pelo plano: cada disparo é debitado da carteira, e sem
// saldo ele não sai de qualquer jeito. Trancá-lo por plano cobrava duas vezes
// pela mesma coisa — quem paga o envio pode enviar, esteja em que plano
// estiver. O interruptor continua no cadastro do plano por compatibilidade,
// mas não decide mais nada.
const SEMPRE_LIBERADOS = ['sms'];

// O INTERRUPTOR DA PLATAFORMA VEM ANTES DE TUDO — inclusive de superconta e
// tester. Se o recurso está quebrado, ele está quebrado para todo mundo, e
// deixar o dono do SaaS entrar num módulo desligado é justamente o caminho de
// descobrir o problema pelo cliente.
function moduloDaPlataforma(key) {
  const m = (db.get().platform || {}).modulos || {};
  return m[key] !== false;   // ausente = ligado
}

function featureOn(acc, key) {
  if (!moduloDaPlataforma(key)) return false;
  if (isUnlimited(acc)) return true;
  if (SEMPRE_LIBERADOS.includes(key)) return true;
  if (!db.FEATURE_KEYS.includes(key)) return true;   // módulo essencial: sempre on
  return !!featuresOf(acc)[key];
}

// null = liberado; string = mensagem de bloqueio.
function checkFeature(acc, key) {
  if (featureOn(acc, key)) return null;
  // DUAS RECUSAS DIFERENTES, e confundi-las é caro. "Faça upgrade" para um
  // módulo que a plataforma desligou manda o cliente pagar por algo que não vai
  // funcionar — e ele volta pedindo reembolso.
  if (!moduloDaPlataforma(key)) {
    return `${FEATURE_LABEL[key] || key} está temporariamente indisponível. Estamos trabalhando nisso — nada do que você já configurou foi perdido.`;
  }
  return `${FEATURE_LABEL[key] || key} não faz parte do seu plano. Faça upgrade em Assinatura para liberar.`;
}

module.exports = {
  podeCriarContato, podeTocarContato, assinaturaVale,
  isUnlimited,
  PAID_EXTRAS, LABEL, FEATURE_LABEL, planOf, extraPrices, limitOf, usage, report,
  check, enforce, extrasCost, chargeTotal,
  featuresOf, featureOn, checkFeature, moduloDaPlataforma
};
