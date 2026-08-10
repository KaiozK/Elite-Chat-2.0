// ============================================================================
// DISPAROS DE SMS — provedor Integra X
//
// A plataforma contrata a Integra X e revende o disparo aos clientes: o admin
// liga a funcionalidade no Admin SaaS, informa o token e o remetente, e os
// planos que tiverem o módulo `sms` passam a enxergar a tela.
//
// Tudo que é específico do provedor mora no bloco CONTRATO logo abaixo. O
// restante do arquivo (fila, limites, histórico, variáveis) não sabe qual
// provedor está atrás e não muda se ele mudar.
//
// O opt-in/opt-out do Koonfy é do WhatsApp: as palavras-chave chegam por
// mensagem recebida e valem para aquele canal. O SMS não participa desse
// controle — quem for enviar responde pela lista que usa.
// ============================================================================

const db = require('./db');
const store = require('./store');
const limits = require('./limits');

// ============================================================================
// CONTRATO DA API DA INTEGRA X  ← ÚNICO PONTO A AJUSTAR
//
// Documentação oficial (painel → /dashboard/external). Três pontos merecem
// atenção porque fogem do REST comum:
//
//   1. O TOKEN VIAJA NO CAMINHO, não em header:
//        POST https://sms.aresfun.com/v1/integration/{TOKEN}/send-sms
//      Por isso a URL é secreta e nunca aparece inteira em log nem em erro
//      (ver `mascarar`).
//   2. `to` é uma LISTA, mesmo para um destinatário só. É o que permite mandar
//      o disparo em massa numa chamada só (ver LOTE).
//   3. Sucesso vem com `success` / `error: 0`; erro vem com HTTP 4xx e
//      `message`.
//
// A API não expõe consulta de status por mensagem no SMS (só a chamada de voz
// tem campo `dlr`), então o histórico marca "enviado" quando o provedor aceita
// e só muda se um webhook de entrega chegar.
// ============================================================================
const CONTRATO = {
  base: 'https://sms.aresfun.com',

  // Quantos destinatários por chamada. A doc não publica um teto; 100 é
  // conservador e mantém o corpo pequeno.
  LOTE: 100,

  rotas: {
    enviar: token => `/v1/integration/${encodeURIComponent(token)}/send-sms`,
    saldo: token => `/v1/integration/${encodeURIComponent(token)}/consult/credits`
  },

  // Corpo do envio. `to` é sempre lista, em E.164 sem "+" (5511999998888).
  corpoEnvio: ({ to, text, from }) => ({
    to: Array.isArray(to) ? to : [to],
    from: from || undefined,
    message: text
  }),

  // Lê a resposta do envio. A doc não documenta id por mensagem no SMS, então
  // aceitamos o que vier e seguimos sem id quando não houver.
  lerEnvio: d => {
    const dd = (d && d.data) || d || {};
    const falhou = d && (d.error === 1 || d.error === true || d.success === false);
    return {
      id: dd.id || dd.messageId || dd.message_id || '',
      status: falhou ? 'failed' : normalizarStatus(dd.status || 'sent'),
      erro: falhou ? (d.message || dd.message || 'recusado pelo provedor') : ''
    };
  },

  // Lê o saldo de créditos.
  lerSaldo: d => {
    const dd = (d && d.data) || d || {};
    return {
      creditos: Number(dd.credits ?? dd.balance ?? dd.saldo ?? dd.amount ?? 0),
      moeda: dd.currency || 'BRL'
    };
  },

  // Corpo do webhook de entrega (DLR) → { id, to, status }.
  // O número importa: no disparo em lote uma única resposta do provedor cobre
  // vários destinatários, então só o id não diz de quem é o status.
  lerWebhook: b => {
    const dd = (b && b.data) || b || {};
    return {
      id: dd.id || dd.messageId || dd.message_id || '',
      to: String(dd.to || dd.phone || dd.msisdn || dd.number || ''),
      status: normalizarStatus(dd.status || '')
    };
  }
};

// O token faz parte da URL: nunca deixar a URL crua vazar em log ou mensagem.
function mascarar(txt) {
  const t = (cfg().token || '').trim();
  if (!t) return String(txt || '');
  return String(txt || '').split(t).join('***');
}

// Status normalizado do Koonfy, independente do vocabulário do provedor:
//   queued | sent | delivered | undelivered | failed
function normalizarStatus(s) {
  const v = String(s || '').toLowerCase();
  if (/deliver(ed)?|entregue|success/.test(v)) return 'delivered';
  if (/undeliver|nao_?entregue|rejected|rejeit/.test(v)) return 'undelivered';
  if (/fail|error|erro|invalid/.test(v)) return 'failed';
  if (/queue|fila|pending|accepted|scheduled/.test(v)) return 'queued';
  return 'sent';
}

// ---------------------------------------------------------------------------
// Configuração (Admin SaaS → Pagamentos/Integrações → SMS)
// ---------------------------------------------------------------------------
function cfg() {
  const p = db.get().platform;
  if (!p.sms || typeof p.sms !== 'object') p.sms = emptyConfig();
  for (const [k, v] of Object.entries(emptyConfig())) if (p.sms[k] === undefined) p.sms[k] = v;
  return p.sms;
}

function emptyConfig() {
  return {
    enabled: false,      // liga a funcionalidade para os clientes
    token: '',           // token da conta Integra X (nunca sai do servidor)
    from: '',            // remetente / sender id, quando a conta tiver um
    base: '',            // sobrescreve CONTRATO.base quando a conta usa outro host
    callbackUrl: '',     // URL pública que recebe o status de entrega
    maxLen: 160,         // acima disso o provedor cobra mais de um SMS
    priceCents: 0,       // quanto a PLATAFORMA cobra do cliente por SMS enviado
    lastBalance: null,   // último saldo consultado { creditos, moeda, ts }
    logs: []             // últimos eventos (erros de envio, testes de conexão)
  };
}

// Disponível para os clientes? Precisa estar ligado E configurado.
function configured() { const c = cfg(); return !!(c.enabled && c.token); }

function baseUrl() { return (cfg().base || CONTRATO.base).replace(/\/+$/, ''); }

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function plog(entry) {
  const c = cfg();
  c.logs.unshift({ id: db.genId('sms'), ts: Date.now(), ...entry });
  if (c.logs.length > 200) c.logs.length = 200;
  db.save();
}

// ---------------------------------------------------------------------------
// Chamada HTTP genérica ao provedor.
// `rota` é uma função que recebe o token — ele faz parte do caminho.
// ---------------------------------------------------------------------------
async function call(method, rota, body) {
  const c = cfg();
  const token = (c.token || '').trim();
  if (!token) throw erro('SMS não configurado: informe o token da Integra X no Admin SaaS');

  const url = baseUrl() + rota(token);
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw erro(`Não foi possível falar com a Integra X: ${mascarar(e.message)}`, 502);
  }

  const texto = await r.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto }; }

  if (!r.ok) {
    let msg = data.message || data.error || data.detail ||
      (data.raw ? String(data.raw).slice(0, 200) : `Integra X respondeu HTTP ${r.status}`);
    // O token faz PARTE DO CAMINHO, então um token errado não devolve 401: a
    // Integra X responde 404 com `INTEGRATION_NOT_FOUND`, que lido cru vira um
    // "Erro 404" e faz parecer que a integração do Koonfy está quebrada.
    // Traduzimos para o que realmente aconteceu. (As rotas foram conferidas
    // contra o host: uma rota inexistente devolve `Cannot GET ...`, texto
    // diferente deste — dá para distinguir os dois casos com segurança.)
    if (data.code === 'INTEGRATION_NOT_FOUND' || /integration not found/i.test(String(msg))) {
      msg = 'A Integra X não reconheceu este token. Confira se o valor foi copiado inteiro '
          + 'do painel (Integrações → API) e se a integração continua ativa por lá.';
    } else if (r.status === 404 && /cannot (get|post)/i.test(String(msg))) {
      msg = `A Integra X não tem a rota ${mascarar(rota('{TOKEN}'))}. A API do provedor mudou; `
          + 'ajuste o bloco CONTRATO em src/sms.js.';
    }
    const e = erro(mascarar(String(msg)), r.status === 401 || r.status === 403 ? 400 : 502);
    e.http = r.status;
    e.code = data.code || '';
    throw e;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Número no formato que o provedor espera: dígitos, com DDI do Brasil quando
// vier só com DDD. É o mesmo tratamento que o WhatsApp já faz.
// ---------------------------------------------------------------------------
function normalizarNumero(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11) d = '55' + d;          // 11987654321 → 5511987654321
  return d;
}

function valido(n) {
  const d = normalizarNumero(n);
  return d.length >= 12 && d.length <= 15;
}

// Quantos SMS o provedor vai cobrar por esta mensagem.
function segmentos(texto) {
  const max = Math.max(70, Number(cfg().maxLen) || 160);
  return Math.max(1, Math.ceil(String(texto || '').length / max));
}

// ---------------------------------------------------------------------------
// ENVIO. Guarda o resultado no histórico da conta, sempre — inclusive falhas,
// porque é por ali que o cliente descobre por que a mensagem não chegou.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PREÇO DO DISPARO
//
// O SMS não tem cota no plano: o plano só diz que o módulo existe. Cada envio
// é pago na hora com o saldo da carteira, ao preço por SEGMENTO que o admin
// define (uma mensagem longa vale mais de um segmento e a operadora cobra
// por isso, então cobramos igual).
//
// Preço zero = a plataforma está oferecendo o disparo; nada é debitado.
// Saldo insuficiente para no envio, com a mensagem que a carteira já produz.
// ---------------------------------------------------------------------------
function precoDe(qtdSegmentos) {
  const p = Math.max(0, Math.round(Number(cfg().priceCents) || 0));
  return p * Math.max(0, Math.round(qtdSegmentos) || 0);
}

function cobrar(acc, qtdSegmentos, label) {
  const total = precoDe(qtdSegmentos);
  if (!total) return 0;
  require('./elitepay').spendWallet(acc, total, label);
  return total;
}

async function enviar(acc, { to, text, contato = null, origem = 'manual', por = null }) {
  if (!configured()) throw erro('O envio de SMS não está disponível na plataforma');
  const bloqueio = limits.checkFeature(acc, 'sms');
  if (bloqueio) throw erro(bloqueio, 402);

  const corpo = String(text || '').trim();
  if (!corpo) throw erro('Escreva a mensagem');
  const numero = normalizarNumero(to);
  if (!valido(numero)) throw erro(`Número inválido: ${to}`);

  const c = contato || store.findContact(acc, numero);

  const custo = cobrar(acc, segmentos(corpo), `SMS para ${numero}`);

  const cfgSms = cfg();
  const registro = {
    id: db.genId('sms'),
    ts: Date.now(),
    to: numero,
    name: (c && c.name) || '',
    text: corpo,
    segments: segmentos(corpo),
    origem,                       // manual | massa | flow | api
    por: por || null,             // quem disparou (atendente/dono)
    status: 'queued',
    providerId: '',
    error: ''
  };

  try {
    const d = await call('POST', CONTRATO.rotas.enviar, CONTRATO.corpoEnvio({
      to: [numero],
      text: corpo,
      from: cfgSms.from
    }));
    const lido = CONTRATO.lerEnvio(d);
    registro.providerId = lido.id;
    registro.status = lido.status;
    if (lido.erro) { registro.status = 'failed'; registro.error = lido.erro; }
  } catch (e) {
    registro.status = 'failed';
    registro.error = e.message;
    plog({ type: 'sms_error', accountId: acc.id, to: numero, error: e.message });
  }

  guardar(acc, registro);
  if (registro.status === 'failed') throw erro(registro.error || 'Falha ao enviar o SMS');
  return registro;
}

// ---------------------------------------------------------------------------
// DISPARO EM MASSA.
// A Integra X recebe `to` como lista, então mandamos em lotes em vez de uma
// chamada por número: menos viagem de rede e menos chance de esbarrar em limite
// de requisições. Cada destinatário continua com a própria linha no histórico.
// ---------------------------------------------------------------------------
async function enviarMassa(acc, { numeros, text, por = null }) {
  if (!configured()) throw erro('O envio de SMS não está disponível na plataforma');
  const bloqueio = limits.checkFeature(acc, 'sms');
  if (bloqueio) throw erro(bloqueio, 402);

  const corpo = String(text || '').trim();
  if (!corpo) throw erro('Escreva a mensagem');
  const lista = [...new Set((numeros || []).map(normalizarNumero).filter(valido))];
  if (!lista.length) throw erro('Nenhum número válido na seleção');

  const seg = segmentos(corpo);
  const custo = cobrar(acc, seg * lista.length, `Disparo de SMS, ${lista.length} número(s)`);

  const cfgSms = cfg();
  const r = { total: lista.length, enviados: 0, falhas: 0, lotes: 0, erros: [] };

  for (let i = 0; i < lista.length; i += CONTRATO.LOTE) {
    const lote = lista.slice(i, i + CONTRATO.LOTE);
    r.lotes++;
    let status = 'sent', falha = '', providerId = '';
    try {
      const d = await call('POST', CONTRATO.rotas.enviar, CONTRATO.corpoEnvio({
        to: lote, text: corpo, from: cfgSms.from
      }));
      const lido = CONTRATO.lerEnvio(d);
      providerId = lido.id;
      status = lido.status;
      if (lido.erro) { status = 'failed'; falha = lido.erro; }
    } catch (e) {
      status = 'failed';
      falha = e.message;
      plog({ type: 'sms_error', accountId: acc.id, lote: lote.length, error: e.message });
    }

    for (const numero of lote) {
      const c = store.findContact(acc, numero);
      guardar(acc, {
        id: db.genId('sms'), ts: Date.now(), to: numero,
        name: (c && c.name) || '', text: corpo, segments: seg,
        origem: 'massa', por: por || null,
        status, providerId, error: falha
      });
    }
    if (status === 'failed') {
      r.falhas += lote.length;
      if (r.erros.length < 10) r.erros.push({ lote: lote.length, erro: falha });
    } else {
      r.enviados += lote.length;
    }
  }

  store.logEvent({ type: 'sms_bulk', accountId: acc.id, ...r, erros: undefined });
  return r;
}

function historico(acc) {
  if (!Array.isArray(acc.smsLog)) acc.smsLog = [];
  return acc.smsLog;
}

function guardar(acc, registro) {
  const h = historico(acc);
  h.unshift(registro);
  if (h.length > 2000) h.length = 2000;
  db.save();
  return registro;
}

// ---------------------------------------------------------------------------
// Saldo de créditos na Integra X (é da PLATAFORMA, não do cliente).
// ---------------------------------------------------------------------------
async function saldo() {
  const d = await call('GET', CONTRATO.rotas.saldo);
  const s = { ...CONTRATO.lerSaldo(d), ts: Date.now() };
  cfg().lastBalance = s;
  db.save();
  return s;
}

// Caminho da rota com o token escondido — para mostrar na tela sem vazar nada.
function rotaVisivel(rota) { return rota('{TOKEN}'); }

// Teste de conexão do Admin SaaS: diz qual parte do contrato falhou.
async function testar() {
  const c = cfg();
  const rota = rotaVisivel(CONTRATO.rotas.saldo);
  if (!c.token) return { ok: false, etapa: 'AUTH', msg: 'Informe o token da Integra X', base: baseUrl(), rota };
  try {
    const s = await saldo();
    plog({ type: 'sms_test_ok', creditos: s.creditos });
    return { ok: true, saldo: s, base: baseUrl(), rota };
  } catch (e) {
    // O token viaja no caminho: token errado devolve 404 ("rota inexistente"),
    // não 401. Por isso 404 aponta para AUTH, e não para ROTAS.
    const etapa = /Não foi possível falar/i.test(e.message) ? 'BASE'
      : e.code === 'INTEGRATION_NOT_FOUND' || [401, 403].includes(e.http) ? 'AUTH'
      : e.http === 404 ? 'ROTAS'
      : e.http >= 400 && e.http < 500 ? 'ROTAS'
      : 'CAMPOS';
    plog({ type: 'sms_test_fail', etapa, http: e.http || 0, error: e.message });
    return { ok: false, etapa, msg: e.message, http: e.http || 0, base: baseUrl(), rota };
  }
}

// ---------------------------------------------------------------------------
// STATUS DE ENTREGA
//
// A API da Integra X não expõe consulta de status por mensagem no SMS — só a
// chamada de VOZ tem campo `dlr`. Então o histórico marca "enviado" quando o
// provedor aceita o disparo, e só muda se um webhook de entrega chegar em
// /sms-webhook. Se a conta tiver DLR habilitado, é só apontar para lá.
// ---------------------------------------------------------------------------
// `to` opcional: quando vem, é ele que diz de qual destinatário é o status —
// no envio em lote o mesmo providerId cobre a lista inteira. Sem `to`, o status
// vale para todo o lote.
function aplicarStatus(providerId, status, broadcast, to) {
  if (!providerId) return { ok: false, reason: 'sem id' };
  const numero = to ? normalizarNumero(to) : '';
  const atingidos = [];

  for (const acc of db.get().accounts) {
    const alvos = (acc.smsLog || []).filter(x =>
      x.providerId === providerId && (!numero || x.to === numero));
    if (!alvos.length) continue;
    for (const reg of alvos) {
      reg.status = status;
      reg.updatedAt = Date.now();
      atingidos.push({ accountId: acc.id, id: reg.id });
    }
    if (broadcast) broadcast('sms', { accountId: acc.id, status });
    // Para na primeira conta que casa. O id é do provedor e não deveria se
    // repetir entre contas, mas se repetir um DLR nunca pode mexer no
    // histórico de outro cliente.
    break;
  }

  if (!atingidos.length) {
    plog({ type: 'sms_webhook_unmatched', providerId, to: numero, status });
    return { ok: false, reason: 'não encontrado' };
  }
  db.save();
  return { ok: true, total: atingidos.length, ...atingidos[0] };
}

// Webhook público de entrega (DLR). Não confia no corpo para nada além do id e
// do status; qualquer outro campo é ignorado.
function webhookHandler(broadcast) {
  return (req, res) => {
    res.json({ ok: true });
    try {
      const { id, to, status } = CONTRATO.lerWebhook(req.body || {});
      if (!id || !status) return;
      aplicarStatus(id, status, broadcast, to);
    } catch (e) {
      plog({ type: 'sms_webhook_error', error: e.message });
    }
  };
}

// ---------------------------------------------------------------------------
// Visões
// ---------------------------------------------------------------------------
// Para o cliente: nunca expõe token nem o saldo da plataforma.
function publicView(acc) {
  const c = cfg();
  return {
    available: configured() && limits.featureOn(acc, 'sms'),
    from: c.from || '',
    maxLen: c.maxLen,
    priceCents: c.priceCents || 0,
    // sem cota: o que limita é o saldo. A tela mostra quantos SMS ele paga.
    balance: acc.wallet.balance,
    creditos: (c.priceCents || 0) ? Math.floor(acc.wallet.balance / c.priceCents) : -1
  };
}

// ---------------------------------------------------------------------------
// ENVIO DA PRÓPRIA PLATAFORMA
//
// Usado pelo Marketing do Admin SaaS, quando é o Koonfy que fala com os
// clientes dele. Não passa por plano, cota nem carteira: o crédito na Integra
// X é da plataforma, e quem dispara é a plataforma.
// ---------------------------------------------------------------------------
async function enviarPlataforma(to, text) {
  if (!configured()) throw erro('O envio de SMS não está configurado');
  const numero = normalizarNumero(to);
  if (!valido(numero)) throw erro('número inválido');
  const corpo = String(text || '').trim();
  if (!corpo) throw erro('mensagem vazia');
  const d = await call('POST', CONTRATO.rotas.enviar, CONTRATO.corpoEnvio({
    to: [numero], text: corpo, from: cfg().from
  }));
  const lido = CONTRATO.lerEnvio(d);
  if (lido.erro) throw erro(lido.erro);
  plog({ type: 'sms_plataforma', to: numero, status: lido.status });
  return { ok: true, id: lido.id, status: lido.status };
}

// Para o admin: diz se o token existe, nunca o valor.
function adminView() {
  const c = cfg();
  return {
    enabled: !!c.enabled,
    hasToken: !!c.token,
    from: c.from || '',
    base: c.base || '',
    baseEfetiva: baseUrl(),
    callbackUrl: c.callbackUrl || '',
    maxLen: c.maxLen,
    priceCents: c.priceCents || 0,
    lastBalance: c.lastBalance || null,
    configured: configured(),
    lote: CONTRATO.LOTE,
    // caminho com o token substituído por {TOKEN} — a URL real é secreta
    rotas: {
      enviar: rotaVisivel(CONTRATO.rotas.enviar),
      saldo: rotaVisivel(CONTRATO.rotas.saldo)
    },
    logs: (c.logs || []).slice(0, 30)
  };
}

module.exports = {
  CONTRATO, cfg, emptyConfig, configured, baseUrl,
  precoDe, cobrar,
  enviarPlataforma,
  normalizarNumero, valido, segmentos, normalizarStatus,
  enviar, enviarMassa, historico, saldo, testar, rotaVisivel,
  aplicarStatus, webhookHandler,
  publicView, adminView
};
