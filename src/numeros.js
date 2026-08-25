// ============================================================================
// NÚMEROS VIRTUAIS — provedor Integra X
//
// Números que existem só para RECEBER SMS. Servem para o código de verificação
// que chega por mensagem: cadastrar um WhatsApp novo, validar uma conta, testar
// um fluxo de OTP sem queimar o telefone de alguém.
//
// É a MESMA Integra X do disparo de SMS (src/sms.js) e o MESMO token, mas é
// outra API: outro host, outro caminho e — o detalhe que engana — outra forma
// de autenticar. Ver o CONTRATO abaixo.
//
// Fica em módulo separado, e não dentro de sms.js, porque são dois produtos
// diferentes com ciclos diferentes: o SMS é um disparo que termina em segundos,
// o número é uma ASSINATURA que fica viva, recebe mensagens e é cancelada.
// Misturar os dois faria um arquivo que fala de duas coisas ao mesmo tempo.
// ============================================================================

const db = require('./db');

// ============================================================================
// CONTRATO DA API DE NÚMEROS DA INTEGRA X  ← ÚNICO PONTO A AJUSTAR
//
// Documentação oficial (painel → /dashboard/external). Quatro pontos que fogem
// do que o resto do projeto faz:
//
//   1. O TOKEN VAI NO HEADER, e não no caminho.
//        Authorization: Bearer {TOKEN}
//      No disparo de SMS o mesmo token viaja DENTRO da URL. É a mesma conta e o
//      mesmo segredo, com dois jeitos de mandar — quem copiar o call() do
//      sms.js para cá manda o token no lugar errado e leva 401 sem entender.
//
//   2. O HOST É OUTRO: api.integraflux.com, não sms.aresfun.com.
//
//   3. COMPRAR GASTA DINHEIRO DE VERDADE, na hora. `mode: "subscription"` cobra
//      no ato e deixa o número ativo. Não existe simulação: por isso a compra
//      nunca acontece sem alguém pedir explicitamente, e o painel mostra o
//      número antes de confirmar.
//
//   4. O REEMBOLSO DO CANCELAMENTO É CONDICIONAL, e a condição é do provedor,
//      não nossa: se o número AINDA NÃO recebeu nenhum SMS com código, volta o
//      valor integral; se já recebeu, o cancelamento acontece igual, mas sem
//      reembolso — só para de cobrar a próxima mensalidade. A resposta diz o
//      que aconteceu em `refunded`, `refunded_brl` e `otp_sms_count`, e é isso
//      que o painel repete para quem clicou.
// ============================================================================
const CONTRATO = {
  base: 'https://api.integraflux.com',

  rotas: {
    disponiveis: '/phone-numbers/api/available',
    comprar: '/phone-numbers/api/buy',
    meus: '/phone-numbers/api/rentals',
    sms: id => `/phone-numbers/api/rentals/${encodeURIComponent(id)}/sms`,
    cancelar: id => `/phone-numbers/api/rentals/${encodeURIComponent(id)}/cancel-refund`
  },

  // `status` aceito pela rota "meus números". Fora desta lista o provedor
  // ignora o filtro e devolve tudo — o que parece um bug do nosso lado.
  STATUS: ['reserved', 'active', 'expired', 'cancelled'],

  // Sem `limit` o provedor devolve tudo, com teto de 1000. 200 é o suficiente
  // para escolher um número sem trazer uma lista que ninguém lê.
  LIMITE_PADRAO: 200,
  LIMITE_MAX: 1000,

  // A doc lista dois modos. `temporary` não aceita cancelamento com reembolso,
  // então o padrão é `subscription`.
  MODOS: ['subscription', 'temporary'],

  // Um número da lista de disponíveis, normalizado. Os nomes de campo variam
  // entre as rotas do provedor (`id` na lista, `phone_id` na compra), então a
  // leitura é tolerante e o resto do arquivo só vê o formato daqui.
  lerDisponivel: n => ({
    id: String(n.id ?? n.phone_id ?? n.phoneId ?? ''),
    numero: String(n.phone ?? n.number ?? n.msisdn ?? ''),
    ddd: String(n.ddd ?? n.area_code ?? '').replace(/\D/g, ''),
    precoCents: dinheiroEmCentavos(n.price_brl ?? n.price ?? n.valor)
  }),

  // Um número que já é meu.
  lerAluguel: r => ({
    rentalId: String(r.rental_id ?? r.id ?? ''),
    numero: String(r.phone ?? r.number ?? r.msisdn ?? ''),
    ddd: String(r.ddd ?? r.area_code ?? '').replace(/\D/g, ''),
    status: String(r.status || '').toLowerCase(),
    modo: String(r.mode || r.modo || ''),
    criadoEm: dataEmMs(r.created_at ?? r.createdAt ?? r.bought_at),
    expiraEm: dataEmMs(r.expires_at ?? r.expiresAt ?? r.expire_at)
  }),

  // Uma mensagem recebida no número.
  lerSms: s => ({
    de: String(s.from ?? s.sender ?? s.origin ?? ''),
    texto: String(s.body ?? s.text ?? s.message ?? ''),
    codigo: String(s.otp ?? s.code ?? s.otp_code ?? ''),
    recebidoEm: dataEmMs(s.received_at ?? s.receivedAt ?? s.created_at ?? s.date)
  }),

  // Resposta do cancelamento.
  lerCancelamento: d => ({
    reembolsado: d.refunded === true,
    reembolsoCents: dinheiroEmCentavos(d.refunded_brl ?? d.refunded_amount ?? 0),
    smsComCodigo: Number(d.otp_sms_count ?? d.otpSmsCount ?? 0)
  })
};

// O provedor manda dinheiro em reais (7.9), às vezes como texto ("7,90"). O
// resto do Koonfy trabalha em centavos inteiros — converter na porta de entrada
// evita que um float de reais atravesse o sistema.
function dinheiroEmCentavos(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

// Datas chegam como ISO ou epoch, em segundos ou em milissegundos. Um epoch em
// SEGUNDOS interpretado como milissegundos vira 1970 e a tela mostra uma data
// absurda sem erro nenhum — por isso o corte pelos 10 dígitos.
function dataEmMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

// ---------------------------------------------------------------------------
// Configuração (Admin SaaS → Integrações → Números virtuais)
// ---------------------------------------------------------------------------
function cfg() {
  const p = db.get().platform;
  if (!p.numeros || typeof p.numeros !== 'object') p.numeros = emptyConfig();
  for (const [k, v] of Object.entries(emptyConfig())) if (p.numeros[k] === undefined) p.numeros[k] = v;
  return p.numeros;
}

function emptyConfig() {
  return {
    enabled: false,   // liga a tela no Admin
    token: '',        // vazio = usa o token do SMS, que é o mesmo da integração
    base: '',         // sobrescreve CONTRATO.base quando a conta usa outro host
    logs: []          // últimos eventos (compras, cancelamentos, erros)
  };
}

// O TOKEN É UM SÓ. A documentação da Integra X diz "toda rota usa o TOKEN da
// integração", e as duas APIs são da mesma conta — então quem já configurou o
// SMS não precisa digitar de novo. O campo próprio existe só para o caso de a
// conta de números ser separada um dia; enquanto estiver vazio, vale o do SMS.
function token() {
  const meu = (cfg().token || '').trim();
  if (meu) return meu;
  try { return (require('./sms').cfg().token || '').trim(); } catch { return ''; }
}

function configured() { return !!(cfg().enabled && token()); }

function baseUrl() { return (cfg().base || CONTRATO.base).replace(/\/+$/, ''); }

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// O token não viaja na URL aqui, mas viaja no header — e um erro do provedor
// pode ecoar o header de volta. Mascarar é barato.
function mascarar(txt) {
  const t = token();
  if (!t) return String(txt || '');
  return String(txt || '').split(t).join('***');
}

function plog(entry) {
  const c = cfg();
  c.logs.unshift({ id: db.genId('num'), ts: Date.now(), ...entry });
  if (c.logs.length > 200) c.logs.length = 200;
  db.save();
}

// ---------------------------------------------------------------------------
// Chamada HTTP ao provedor. Bearer no header — ver ponto 1 do CONTRATO.
// ---------------------------------------------------------------------------
async function call(method, caminho, body) {
  const t = token();
  if (!t) throw erro('Números virtuais sem token: configure a Integra X no Admin SaaS');

  const url = baseUrl() + caminho;
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${t}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw erro(`Não foi possível falar com a Integra X: ${mascarar(e.message)}`, 502);
  }

  const texto = await r.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto }; }

  if (!r.ok) {
    const msg = data.message || data.error || data.detail || `HTTP ${r.status}`;
    throw erro(`Integra X: ${mascarar(String(msg))}`, r.status === 401 ? 401 : 502);
  }
  return data;
}

// A resposta às vezes vem como lista crua, às vezes embrulhada em `data` ou
// `items`. Desembrulhar num lugar só evita `d.data.data` espalhado pelo arquivo.
function lista(d, ...chaves) {
  if (Array.isArray(d)) return d;
  for (const k of ['data', 'items', 'results', ...chaves]) {
    if (Array.isArray(d?.[k])) return d[k];
    if (Array.isArray(d?.data?.[k])) return d.data[k];
  }
  return [];
}

// ---------------------------------------------------------------------------
// As cinco operações
// ---------------------------------------------------------------------------

// Números à venda. `ddd` filtra; `limite` corta.
async function disponiveis({ ddd, limite } = {}) {
  const q = new URLSearchParams();
  const d = String(ddd || '').replace(/\D/g, '');
  if (d) q.set('ddd', d);
  const n = Math.max(1, Math.min(CONTRATO.LIMITE_MAX, Number(limite) || CONTRATO.LIMITE_PADRAO));
  q.set('limit', String(n));

  const r = await call('GET', `${CONTRATO.rotas.disponiveis}?${q}`);
  const itens = lista(r, 'numbers', 'phones', 'available').map(CONTRATO.lerDisponivel);
  return {
    total: Number(r.total ?? r.data?.total ?? itens.length),
    count: Number(r.count ?? r.data?.count ?? itens.length),
    numeros: itens
  };
}

// COMPRA — gasta dinheiro de verdade, na hora. Ver ponto 3 do CONTRATO.
//
// Os três campos são opcionais e formam três compras diferentes:
//   sem nada          → qualquer número disponível
//   com ddd           → qualquer número daquele DDD
//   com numeroId      → aquele número exato
// Mandar `null` explicitamente é o que a doc pede quando não se escolhe.
async function comprar({ modo, ddd, numeroId } = {}) {
  const m = CONTRATO.MODOS.includes(modo) ? modo : 'subscription';
  const d = String(ddd || '').replace(/\D/g, '');
  const corpo = {
    mode: m,
    ddd: d || null,
    phone_id: numeroId ? String(numeroId) : null
  };

  const r = await call('POST', CONTRATO.rotas.comprar, corpo);
  const dd = r.data || r;
  const compra = {
    rentalId: String(dd.rental_id ?? dd.rentalId ?? dd.id ?? ''),
    numero: String(dd.phone ?? dd.number ?? dd.msisdn ?? ''),
    modo: m
  };
  plog({ tipo: 'compra', rentalId: compra.rentalId, numero: compra.numero, modo: m, ddd: d || '' });
  return compra;
}

// Meus números. `status` aceita um ou vários, separados por vírgula.
async function meus({ status } = {}) {
  const pedidos = String(status || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const validos = pedidos.filter(s => CONTRATO.STATUS.includes(s));
  if (pedidos.length && !validos.length) {
    throw erro(`status inválido: use ${CONTRATO.STATUS.join(', ')}`);
  }
  const q = validos.length ? `?status=${encodeURIComponent(validos.join(','))}` : '';
  const r = await call('GET', CONTRATO.rotas.meus + q);
  return lista(r, 'rentals', 'numbers').map(CONTRATO.lerAluguel);
}

// SMS recebidos num número. É a razão de o número existir.
async function mensagens(rentalId) {
  const id = String(rentalId || '').trim();
  if (!id) throw erro('informe o número (rental_id)');
  const r = await call('GET', CONTRATO.rotas.sms(id));
  return lista(r, 'sms', 'messages').map(CONTRATO.lerSms)
    .sort((a, b) => b.recebidoEm - a.recebidoEm);
}

// CANCELAR — o reembolso é condicional, e a condição é do provedor. Ver ponto 4
// do CONTRATO. Devolve o que de fato aconteceu, para o painel repetir.
async function cancelar(rentalId) {
  const id = String(rentalId || '').trim();
  if (!id) throw erro('informe o número (rental_id)');
  const r = await call('POST', CONTRATO.rotas.cancelar(id), {});
  const fim = CONTRATO.lerCancelamento(r.data || r);
  plog({ tipo: 'cancelamento', rentalId: id, ...fim });
  return fim;
}

// ---------------------------------------------------------------------------
// Visões
// ---------------------------------------------------------------------------

// O token NUNCA volta para o navegador — nem o do SMS, que é o mesmo segredo.
// O painel só precisa saber SE existe um, e de onde ele veio.
function adminView() {
  const c = cfg();
  const proprio = !!(c.token || '').trim();
  return {
    enabled: !!c.enabled,
    temToken: !!token(),
    tokenProprio: proprio,
    herdaDoSms: !proprio && !!token(),
    base: c.base || '',
    baseEfetiva: baseUrl(),
    logs: (c.logs || []).slice(0, 30)
  };
}

module.exports = {
  CONTRATO, cfg, emptyConfig, configured, baseUrl, token,
  disponiveis, comprar, meus, mensagens, cancelar,
  adminView,
  // exportados para teste
  dinheiroEmCentavos, dataEmMs
};
