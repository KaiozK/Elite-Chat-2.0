const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const consentDefaults = require('./consent-defaults');
const storage = require('./storage');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------------------------------------------------------------------------
// SENHAS
//
// hash() é SHA-256 puro: rápido de calcular. Isso serve para um código de
// verificação de 6 dígitos que vive 10 minutos, e atrapalha numa senha. Uma
// GPU testa bilhões de SHA-256 por segundo, e sem sal duas contas com a mesma
// senha viram o mesmo hash, o que entrega as duas de uma vez.
//
// Senha usa scrypt: caro de propósito (memória e CPU) e com um sal por conta.
// O formato guardado carrega os parâmetros, então dá para encarecer o custo
// mais tarde sem invalidar o que já está gravado:
//
//   scrypt$N$r$p$<sal em base64>$<derivado em base64>
//
// Os hashes antigos continuam valendo: verifyPassword aceita os dois formatos
// e needsRehash avisa quando o guardado é do formato velho, para o login
// regravá-lo com a senha que o usuário acabou de digitar. Ninguém precisa
// trocar de senha por causa da migração.
// ---------------------------------------------------------------------------
function hash(pass) {
  return crypto.createHash('sha256').update('wacrm:' + String(pass)).digest('hex');
}

// N=16384 leva por volta de 50ms por verificação: imperceptível num login e
// proibitivo para quem quer testar uma lista inteira.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const PREFIXO = "scrypt" + "$";

function hashPassword(pass) {
  const sal = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pass), sal, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, sal.toString("base64"), dk.toString("base64")].join("$");
}

// Comparação em tempo constante: com === o tempo de resposta diria quantos
// bytes iniciais bateram.
function verifyPassword(pass, guardado) {
  const g = String(guardado || "");
  if (!g) return false;
  if (!g.startsWith(PREFIXO)) {
    const a = Buffer.from(hash(pass), "utf8");
    const b = Buffer.from(g, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const partes = g.split("$");
  if (partes.length !== 6) return false;
  try {
    const esperado = Buffer.from(partes[5], "base64");
    const obtido = crypto.scryptSync(String(pass), Buffer.from(partes[4], "base64"), esperado.length,
      { N: Number(partes[1]), r: Number(partes[2]), p: Number(partes[3]) });
    return crypto.timingSafeEqual(obtido, esperado);
  } catch { return false; }
}

// Guardado no formato antigo? Quem acabou de conferir a senha regrava.
function needsRehash(guardado) { return !String(guardado || "").startsWith(PREFIXO); }

// Configuração da PLATAFORMA (Tech Provider) — definida uma vez pelo admin/dono.
// Os clientes nunca preenchem isso; eles conectam via Embedded Signup.
const DEFAULTS = {
  platform: {
    graphVersion: 'v26.0',
    // Fuso usado para ESCREVER horários (notificação, cobrança, lembrete). Sem
    // ele o servidor formatava no fuso do processo, que em produção é UTC: um
    // agendamento das 9h virava "12h" no aviso. Cada conta pode ter o seu.
    timezone: 'America/Sao_Paulo',
    appId: '',
    appSecret: '',
    configId: '',        // ID da configuração de login do Embedded Signup
    systemToken: '',     // token de usuário do sistema (fallback / envio pela plataforma)
    verifyToken: crypto.randomBytes(12).toString('hex'),
    adminUser: 'admin',
    adminPassHash: hash('admin'),
    // ---- MARCA ----
    // A logo enviada pelo admin, guardada aqui e servida por /marca/logo. Sem
    // ela, vale o arquivo em public/assets. Fica no banco (e não em disco)
    // porque a DigitalOcean recria o sistema de arquivos a cada deploy: um
    // arquivo enviado pelo painel sumiria na atualização seguinte.
    marca: { logo: '', mime: '', nome: '', bytes: 0, updatedAt: 0 },
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
      // Assinatura OBRIGATÓRIA: sem plano ativo, a conta só enxerga a tela de
      // Assinatura. Ligado por padrão — um SaaS que entrega o produto antes
      // de cobrar depende da boa vontade de quem entrou.
      requirePlan: true,
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
  // ---- BANNERS DA DASHBOARD ----
  // A faixa de avisos no topo da dashboard. Vive aqui, e não no código do
  // painel, porque trocar a frase de uma campanha não pode custar um deploy
  // — e o que custa um deploy ninguém troca.
  //
  // `arte` aponta para um par de arquivos já desenhados (fundo + peça 3D);
  // `ordem` é a posição no carrossel; `ativo` desliga sem apagar, que é o
  // que se quer quando a campanha acaba e pode voltar.
  banners: [
    { id: 'bn_integracoes', ativo: true, ordem: 1, arte: 'integracoes',
      tag: 'Integrações', titulo: 'Tudo o que você já usa, conversando',
      texto: 'Nuvemshop, Meta Ads e webhooks viram mensagem no WhatsApp, sem você fazer nada.',
      acao: 'Ver integrações', href: '#/integrations' },
    { id: 'bn_ligacao', ativo: true, ordem: 2, arte: 'ligacao',
      tag: 'Ligação', titulo: 'Ligue de dentro da conversa',
      texto: 'Chamada de voz pelo WhatsApp sem sair do atendimento, com o histórico no mesmo lugar.',
      acao: 'Abrir Conversas', href: '#/inbox' },
    { id: 'bn_indique', ativo: true, ordem: 3, arte: 'indique',
      tag: 'Indique e ganhe', titulo: 'Indique a Koonfy e receba',
      texto: 'Comissão automática em toda assinatura de quem você indicar. O link é seu e o saldo cai na carteira.',
      acao: 'Ver meu link', href: '#/afiliacao' },
    { id: 'bn_vender', ativo: true, ordem: 4, arte: 'vender',
      tag: 'Vender com a Koonfy', titulo: 'Venda dentro do WhatsApp',
      texto: 'Cobrança por Pix e cartão no chat, checkout próprio e o dinheiro na sua conta.',
      acao: 'Ver Pagamentos', href: '#/pagamentos' },
    { id: 'bn_tracking', ativo: true, ordem: 5, arte: 'tracking',
      tag: 'Tracking', titulo: 'Saiba de onde vem cada venda',
      texto: 'Links rastreáveis e pixels: a campanha que traz cliente aparece no relatório, com nome e número.',
      acao: 'Abrir Tracking', href: '#/tracking' }
  ],
    affiliate: { percentFirst: 30, percentRenewal: 15, withdraw: { min: 2000, max: 0 } },
    // Verificação em duas etapas do login, ligada pelo admin.
    security: { twoFactor: false },
    landing: { ctaText: '' }, // copy do botão principal da landing (vazio = automático pelos dias de teste)
    // ---- SUPORTE ----
    // O WhatsApp que aparece no rodapé do checkout. Configurável porque é o
    // número que o dono atende, e um número escrito no HTML vira telefone
    // errado no dia em que ele mudar — no pior lugar possível, que é a tela de
    // quem está pagando. Vazio = o rodapé não mostra suporte nenhum, e é
    // melhor assim: link para número que ninguém atende é pior que a ausência.
    suporte: { whatsapp: '' },
    // ---- PERSONALIZAÇÃO (cores da marca) ----
    // Mesma ideia da logo: o admin muda no painel e vale para o app inteiro e
    // para a landing, sem deploy. Vazio = usa o padrão do CSS, então uma
    // instalação nova não depende de ninguém preencher nada.
    //
    // `funil` são as cores das etapas do gráfico de funil, do topo para a base.
    tema: {
      // `verde` saiu: a marca virou imagem e a cor dela não é mais escolhida
      botao: '',        // fundo do botão principal (mais fechado que o da marca)
      botaoHover: '',   // o mesmo, um passo mais escuro
      tintaBotao: '',   // cor do texto dentro do botão
      verdeDeep: '',    // verde fechado, para TEXTO verde sobre fundo claro
      menu: '',         // item ativo do menu lateral (e os contadores)
      menuTinta: '',    // texto e ícone dentro do item ativo
      funil: []         // uma cor por etapa do funil, do topo para a base
    }
  },
  // plano: { id, name, price, periodDays, limits, modules, checkoutId }
  // `checkoutId` aponta para um checkout montado pelo dono no Checkout Builder
  plans: [],             // planos de assinatura { id, name, price(centavos), periodDays, features[], limits{} }
  withdrawals: [],       // pedidos de saque { id, accountId, amount, pixKey, status, ts }
  revenue: [],           // pagamentos confirmados { ts, accountId, planId, amount, kind: first|renewal|topup, chargeId }
  accounts: [],          // tenants (clientes), ver newAccount()
  sessions: {},          // token -> { kind:'account'|'admin', accountId }
  // Login em duas etapas: senha conferida, código pendente. Vive aqui e não
  // em sessions porque ainda NÃO é uma sessão: nada dá acesso a nada até o
  // código certo chegar.
  loginChallenges: {},   // ticket -> { accountId, hash, exp, tentativas }
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
// O SMS NÃO entra aqui: ele não tem cota por ciclo. O plano só liga ou desliga
// o módulo (FEATURE_KEYS) e cada disparo é pago na hora, com o saldo da
// carteira, ao preço que o admin define em Admin SaaS.
const LIMIT_KEYS = ['sends', 'campaigns', 'contacts', 'flows', 'pixels', 'links', 'whatsapps'];
function defaultLimits() {
  return { sends: -1, campaigns: -1, contacts: -1, flows: -1, pixels: -1, links: 1, whatsapps: 1 };
}
// ---------------------------------------------------------------------------
// FUNCIONALIDADES POR PLANO (toggles)
// Cada plano liga/desliga módulos inteiros. Diferente dos LIMITES (quantidade),
// aqui é booleano: desligado, o módulo some do menu do cliente e as rotas
// recusam com 402. Módulos essenciais (conversas, contatos, funil, modelos,
// LGPD) não entram na lista: fazem parte de qualquer plano.
const FEATURE_KEYS = ['campaigns', 'flows', 'schedule', 'team', 'agents', 'pagamentos', 'links', 'pixels', 'tracking', 'integrations', 'sms'];
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
// Campos persistidos conforme o fluxo oficial da Meta (Cloud API v26.0).
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
    passHash: hashPassword(pass || ''),
    createdAt: Date.now(),
    // PERFIL DA EMPRESA, informado no cadastro. Não muda nada no produto:
    // serve para o onboarding e para o time comercial saber com quem fala.
    // phone em E.164. document/pixKey vêm da etapa de recebimento do cadastro e
    // ficam aqui para o formulário do Pagamentos já nascer preenchido.
    // `responsavel` é o nome da PESSOA; `name` na conta é o da empresa. No
    // cadastro público os dois são pedidos e só o segundo sobrevivia — quem
    // preencheu o formulário se perdia. Testers guardam os dois.
    profile: { segment: '', site: '', size: '', phone: '', country: 'BR', goal: '', document: '', pixKey: '', pixKeyType: '', responsavel: '' },
    // CONTA INTERNA: ligada pelo admin, roda sem plano, sem cota e sem
    // cobrança, e fica fora das métricas do SaaS. É para os negócios do
    // próprio dono, não para um cliente.
    unlimited: false,
    // CONTA DE TESTE: criada pelo admin, roda sem plano e sem cobrança —
    // mas, diferente da superconta, COM TETO. Os módulos e os limites vêm
    // de um lugar só (platform.testers) e não de um plano, porque ela não
    // tem um. Fica fora da contagem de clientes: não paga, não é receita.
    tester: false,
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
    method: 'pix',         // pix | credit | boleto | wallet, como o cliente paga o Koonfy
    taxId: '',             // CPF/CNPJ do titular, exigido para emitir boleto
    card: {                // cartão tokenizado para renovar automaticamente
      token: '', brand: '', last4: '', holderName: '', gatewayCustomerId: ''
    },
    // ---- Unidades EXTRAS compradas (além do que o plano inclui) ----
    extras: { whatsapps: 0, links: 0 }
  };
}

// CARTEIRA do cliente dentro do Koonfy.
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

// A carga é SÍNCRONA no arquivo e ASSÍNCRONA no MySQL. Para o resto do
// código nada muda: quem usa MySQL chama loadAsync() uma vez na partida
// (server.js faz isso) e daí em diante get() encontra o banco já em memória.
function load() {
  if (storage.nome === 'mysql') {
    if (!db) throw new Error('Com DB_DRIVER=mysql, chame db.loadAsync() na partida antes de usar o banco');
    return db;
  }
  db = storage.carregar();
  return migrar();
}

// Tudo que o load fazia depois de ler o arquivo: defaults novos, limpeza de
// campos mortos e o formato das contas. Vale para os dois motores.
// ---------------------------------------------------------------------------
// O MÓDULO DE PAGAMENTOS TROCOU DE NOME NO DISCO
//
// Ele se chamava `elitepay`, do produto anterior. O nome saiu do código; aqui
// os DADOS acompanham. Sem esta função a renomeação não daria erro — daria
// SILÊNCIO: o módulo de cada conta nasceria vazio (sem subconta, sem
// cobranças, sem carteira), o plano deixaria de liberar a tela e o atendente
// perderia a permissão de cobrar. Tudo sem um log, porque para o código novo
// essas contas simplesmente nunca teriam tido nada.
//
// Roda uma vez e apaga a chave antiga; rodar de novo não faz nada.
// ---------------------------------------------------------------------------
function renomearModuloDePagamentos(d) {
  const mover = (o, de, para) => {
    if (!o || typeof o !== 'object') return false;
    if (o[de] === undefined) return false;
    if (o[para] === undefined) o[para] = o[de];
    delete o[de];
    return true;
  };
  let n = 0;
  if (mover(d.platform, 'elitepay', 'pagamentos')) n++;
  for (const a of d.accounts || []) {
    if (mover(a, 'elitepay', 'pagamentos')) n++;
    for (const ag of a.team || []) if (mover(ag.permissions, 'elitepay', 'pagamentos')) n++;
  }
  for (const pl of d.plans || []) if (mover(pl.modules, 'elitepay', 'pagamentos')) n++;

  // A ORIGEM DOS EVENTOS DE TRACKING também é um dado, e ficou para trás na
  // primeira renomeação: o código passou a gravar a origem nova, mas as vendas
  // já registradas continuaram mostrando "elitepay" na tela de Eventos — o nome
  // de um produto que não existe mais, à vista do cliente.
  //
  // Agora o módulo chama Koonpay, que é o nome da marca, então as duas origens
  // antigas convergem para ele: quem tem histórico vê uma coluna só.
  for (const a of d.accounts || []) {
    for (const ev of ((a.tracking && a.tracking.events) || [])) {
      if (ev.source === 'elitepay' || ev.source === 'pagamentos') { ev.source = 'koonpay'; n++; }
    }
  }

  if (n) {
    console.log('[db] Koonpay: ' + n + ' registro(s) migrado(s) do nome antigo');
    // GRAVA. Sem isto a troca acontece só na memória, o disco continua com o
    // nome antigo e a migração roda de novo a cada partida do processo —
    // barulho no log e trabalho repetido para sempre. O agendamento do save
    // é o normal (250ms), então não há gravação síncrona no meio da carga.
    save();
  }
  return n;
}

function migrar() {
  if (!db) db = JSON.parse(JSON.stringify(DEFAULTS));
  // ANTES de qualquer outra coisa: o resto de migrar() completa objetos com os
  // padrões, e completar `pagamentos` vazio antes de mover apagaria o que a
  // conta já tem.
  renomearModuloDePagamentos(db);
  for (const k of Object.keys(DEFAULTS)) if (db[k] === undefined) db[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
  for (const k of Object.keys(DEFAULTS.platform)) if (db.platform[k] === undefined) db.platform[k] = JSON.parse(JSON.stringify(DEFAULTS.platform[k]));
  // merge raso dos sub-objetos da plataforma (woovi/billing/affiliate ganham chaves novas).
  // O valor é CLONADO: alguns desses padrões são objetos (extras, deposit,
  // withdraw) e copiá-los por referência faria o banco e o DEFAULTS
  // compartilharem a mesma memória — editar um mexeria no outro.
  // O Pix Indireto foi descontinuado: limpa a config de bancos antigos para não
  // ficar lixo no db.json (as assinaturas usam o Pix/Woovi e o cartão).
  delete db.platform.pixIndirect;
  // A versão da Graph API fica GRAVADA, então mudar o padrão não move quem já
  // instalou. Sobe só quem está na v25.0, que era o padrão anterior: se o
  // administrador escolheu outra versão à mão, a escolha dele fica de pé.
  if (db.platform.graphVersion === 'v25.0') db.platform.graphVersion = 'v26.0';
  for (const k of ['woovi', 'billing', 'affiliate', 'landing', 'metaAds', 'nuvemshop', 'security', 'tema']) {
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
    // Cota que deixou de existir (o `sms` virou pagamento por disparo) ficaria
    // guardada para sempre, sem nada que a leia. Sai do banco.
    for (const k of Object.keys(p.limits)) if (!LIMIT_KEYS.includes(k)) delete p.limits[k];
  }
  migrateLegacy();
  nomeDeArquivoNaMarca(db);
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
    acc = newAccount({ name: 'Administrador', email: 'admin@koonfy.local', pass: crypto.randomBytes(12).toString('hex') });
    acc.isAdmin = true;
    // O Modo Bet nasce ligado aqui também, e não só no shape: esta conta é
    // criada DEPOIS da migração, então a regra de lá nunca a alcançaria na
    // primeira partida — que é justamente quando ela nasce.
    acc.profile.betMode = true;
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
// ---------------------------------------------------------------------------
// TODA MENSAGEM COM HORA
//
// `addMessage` carimba a hora desde sempre, mas o histórico tem mensagens
// antigas de antes disso — e elas apareciam no chat sem horário nenhum, o que
// no meio de uma conversa parece defeito.
//
// A hora que falta é DEDUZIDA da vizinhança: a lista está em ordem de
// chegada, então uma mensagem sem hora fica entre duas que têm. Usar a
// anterior mantém a ordem e não inventa um horário no futuro. Sem vizinho
// anterior, usa o seguinte; sem nenhum dos dois, a criação da conta.
//
// Roda uma vez na migração e o valor fica GRAVADO: o conserto é do dado, não
// da tela.
// ---------------------------------------------------------------------------
function carimbarHorasFaltantes(acc) {
  const msgs = acc.messages;
  if (!Array.isArray(msgs) || !msgs.length) return 0;
  const valida = (t) => Number.isFinite(t) && t > 0;
  let corrigidas = 0;

  for (let i = 0; i < msgs.length; i++) {
    if (valida(msgs[i].timestamp)) continue;
    let t = null;
    for (let j = i - 1; j >= 0; j--) if (valida(msgs[j].timestamp)) { t = msgs[j].timestamp; break; }
    if (t === null) for (let j = i + 1; j < msgs.length; j++) if (valida(msgs[j].timestamp)) { t = msgs[j].timestamp; break; }
    msgs[i].timestamp = t !== null ? t : (acc.createdAt || Date.now());
    corrigidas++;
  }
  return corrigidas;
}

// ---------------------------------------------------------------------------
// BOTÕES DAS MENSAGENS ANTIGAS
//
// Antes de o envio guardar o botão estruturado, o rótulo era colado no fim do
// texto entre colchetes, e a lista virava uma sequência de marcadores. O chat
// desenha botões de verdade quando a mensagem traz `buttons`; o que faltava
// era o histórico. Aqui o formato antigo é lido e convertido — conserto do
// dado, não da tela.
// ---------------------------------------------------------------------------
function botoesDasAntigas(acc) {
  const msgs = acc.messages;
  if (!Array.isArray(msgs) || !msgs.length) return 0;
  let convertidas = 0;
  for (const m of msgs) {
    if (m.type !== 'interactive' || (Array.isArray(m.buttons) && m.buttons.length)) continue;
    const txt = String(m.text || '');
    // "corpo\n[🔗 Rótulo]" — o botão de link, do jeito que era gravado.
    const cta = txt.match(/^([\s\S]*?)\n\[\uD83D\uDD17 ([^\]]{1,40})\]\s*$/);
    if (cta) {
      m.text = cta[1].trim();
      m.buttons = [{ id: 'cta_url', title: cta[2].trim() }];
      convertidas++;
      continue;
    }
    // "corpo\n• opção\n• opção" — a lista. O balão fica com o corpo, e as
    // opções viram botões: é o mais perto do que o cliente viu.
    const linhas = txt.split('\n');
    const corte = linhas.findIndex(l => l.trim().startsWith('• '));
    if (corte > 0) {
      const opcoes = linhas.slice(corte).filter(l => l.trim().startsWith('• '));
      if (opcoes.length && opcoes.length === linhas.length - corte) {
        m.text = linhas.slice(0, corte).join('\n').trim();
        m.buttons = opcoes.slice(0, 3).map((l, i) => ({ id: 'row_' + (i + 1), title: l.trim().slice(2).slice(0, 24) }));
        convertidas++;
      }
    }
  }
  return convertidas;
}

// ---------------------------------------------------------------------------
// O NOME DO APP QUE VIROU NOME DE ARQUIVO
//
// A rota de upload da logo gravava `marca` inteiro e punha o nome do ARQUIVO
// no campo `nome`, que é a marca escrita — a que sai na aba do navegador e na
// tela "Adicionar à Tela de Início" do iPhone. A rota já foi corrigida, mas o
// valor ruim continua gravado, e corrigir a rota não desfaz o que ela gravou.
//
// Só limpa o que é CLARAMENTE um arquivo de imagem: termina em .png, .jpg,
// .webp, .svg, .ico, .gif ou .avif. Uma marca de verdade não se chama assim, e
// um nome legítimo que por acaso termine em ".png" é preferível perder do que
// arriscar apagar o nome que alguém escolheu.
// ---------------------------------------------------------------------------
function nomeDeArquivoNaMarca(data) {
  const m = data.platform && data.platform.marca;
  if (!m) return false;
  const nome = String(m.nome || '').trim();
  if (!nome || !/.(png|jpe?g|webp|svg|ico|gif|avif)$/i.test(nome)) return false;
  // O que era nome de arquivo vira a etiqueta do arquivo, que é o seu lugar.
  if (!m.arquivo) m.arquivo = nome;
  m.nome = '';
  return true;
}

function ensureAccountShape(acc) {
  carimbarHorasFaltantes(acc);
  botoesDasAntigas(acc);
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
  if (!acc.profile || typeof acc.profile !== 'object') acc.profile = { segment: '', site: '', size: '', phone: '', country: 'BR', goal: '' };
  if (acc.profile.site === undefined) acc.profile.site = '';
  // O MODO BET NASCE LIGADO NA CONTA DO ADMIN.
  //
  // Ela é a única conta que nunca passa pelo formulário de cadastro, então
  // nunca teria segmento e nunca alcançaria a aba — justamente a conta de quem
  // precisa ver o recurso para atender cliente e conferir se funciona.
  //
  // `undefined` e não `false` é o que distingue "nunca foi decidido" de
  // "o admin desligou". Sem essa diferença, desligar no painel seria desfeito
  // na próxima partida do processo.
  if (acc.isAdmin && acc.profile.betMode === undefined) acc.profile.betMode = true;
  if (typeof acc.profile.country !== 'string' || !acc.profile.country) acc.profile.country = 'BR';
  if (typeof acc.unlimited !== 'boolean') acc.unlimited = false;
  // Precisa de `false` EXPLÍCITO: `undefined` funcionaria na comparação, mas
  // some do JSON, e o campo nunca se materializaria no banco.
  if (typeof acc.tester !== 'boolean') acc.tester = false;
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

function flush() { clearTimeout(saveTimer); storage.gravar(db); }

// Partida com MySQL: carrega, aplica as mesmas migrações do arquivo e deixa o
// banco em memória, exatamente como o load() síncrono faz.
async function loadAsync() {
  const dados = await storage.carregar();
  db = dados || null;
  migrar();
  return db;
}

async function close() {
  try { flush(); } catch {}
  await storage.fechar();
}
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
    acc = newAccount({ name: 'Administrador', email: 'admin@koonfy.local', pass: crypto.randomBytes(12).toString('hex') });
    acc.isAdmin = true;
    // O Modo Bet nasce ligado aqui também, e não só no shape: esta conta é
    // criada DEPOIS da migração, então a regra de lá nunca a alcançaria na
    // primeira partida — que é justamente quando ela nasce.
    acc.profile.betMode = true;
    acc.passHash = get().platform.adminPassHash;
    get().accounts.push(acc);
    save();
  }
  return acc;
}

process.on('exit', () => { try { if (db) flush(); } catch {} });

module.exports = {
  loadAsync, close, storage,
  hashPassword, verifyPassword, needsRehash, get, save, load, flush, genId, hash, newAccount, emptyWa, emptyBilling, defaultSurvey, findAccount, findAccountByEmail, findAccountByPhoneId, findAccountByRefCode, findAdminAccount, findLinkBySlug, findWebhookByToken, DEFAULT_STAGES, emptyWallet, attachTplAlias, FEATURE_KEYS, defaultFeatures, normFeatures, LIMIT_KEYS, defaultLimits, normLimits, emptyChannel, chanCtx, findChannel, channelByPhoneId, ensureAccountShape };
