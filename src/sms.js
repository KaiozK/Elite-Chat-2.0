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
// O opt-in/opt-out do EliteChat é do WhatsApp: as palavras-chave chegam por
// mensagem recebida e valem para aquele canal. O SMS não participa desse
// controle — quem for enviar responde pela lista que usa.
// ============================================================================

const db = require('./db');
const store = require('./store');
const limits = require('./limits');

// ============================================================================
// CONTRATO DA API DA INTEGRA X  ← ÚNICO PONTO A AJUSTAR
//
// Documentação: https://www.integrax.app/dashboard/external/docs (exige login
// no painel da Integra X, então os nomes abaixo seguem o padrão REST que a
// própria Integra X descreve publicamente: token no header Authorization e
// corpo JSON). Confira os quatro itens ao conectar a conta de verdade:
//
//   1. BASE          — host da API
//   2. AUTH          — como o token viaja
//   3. ROTAS         — caminho de envio, saldo e consulta de status
//   4. CAMPOS        — nomes dos campos que entram e que voltam
//
// O teste de conexão do Admin SaaS aponta exatamente qual dos quatro está
// errado quando a resposta não bate.
// ============================================================================
const CONTRATO = {
  base: 'https://api.integrax.app',

  auth: (cfg, headers) => {
    headers['Authorization'] = `Bearer ${cfg.token}`;
    return headers;
  },

  rotas: {
    enviar: '/v1/sms/send',
    saldo: '/v1/account/balance',
    status: id => `/v1/sms/${encodeURIComponent(id)}`
  },

  // Corpo do envio. `to` já vai em E.164 sem o "+" (ex.: 5511999998888).
  corpoEnvio: ({ to, text, from, referencia, callbackUrl }) => ({
    to,
    message: text,
    from: from || undefined,
    reference: referencia || undefined,
    callback_url: callbackUrl || undefined
  }),

  // Lê a resposta do envio. Devolve sempre { id, status, erro }.
  lerEnvio: d => ({
    id: d.id || d.messageId || d.message_id || (d.data && (d.data.id || d.data.messageId)) || '',
    status: normalizarStatus(d.status || (d.data && d.data.status) || 'sent'),
    erro: d.error || d.message_error || ''
  }),

  // Lê o saldo. Devolve { creditos, moeda }.
  lerSaldo: d => ({
    creditos: Number(d.balance ?? d.credits ?? (d.data && (d.data.balance ?? d.data.credits)) ?? 0),
    moeda: d.currency || (d.data && d.data.currency) || 'BRL'
  }),

  // Lê a consulta de status de uma mensagem.
  lerStatus: d => normalizarStatus(d.status || (d.data && d.data.status) || ''),

  // Corpo do webhook de entrega (DLR) → { id, status }.
  lerWebhook: b => ({
    id: b.id || b.messageId || b.message_id || (b.data && (b.data.id || b.data.messageId)) || '',
    status: normalizarStatus(b.status || (b.data && b.data.status) || '')
  })
};

// Status normalizado do EliteChat, independente do vocabulário do provedor:
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
// ---------------------------------------------------------------------------
async function call(method, path, body) {
  const c = cfg();
  if (!c.token) throw erro('SMS não configurado: informe o token da Integra X no Admin SaaS');

  const headers = CONTRATO.auth(c, { 'Content-Type': 'application/json', 'Accept': 'application/json' });
  let r;
  try {
    r = await fetch(baseUrl() + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw erro(`Não foi possível falar com a Integra X: ${e.message}`, 502);
  }

  const texto = await r.text();
  let data = {};
  try { data = texto ? JSON.parse(texto) : {}; } catch { data = { raw: texto }; }

  if (!r.ok) {
    const msg = data.error || data.message || data.detail ||
      (data.raw ? String(data.raw).slice(0, 200) : `Integra X respondeu HTTP ${r.status}`);
    throw erro(msg, r.status === 401 || r.status === 403 ? 400 : 502);
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
async function enviar(acc, { to, text, contato = null, origem = 'manual', por = null }) {
  if (!configured()) throw erro('O envio de SMS não está disponível na plataforma');
  const bloqueio = limits.checkFeature(acc, 'sms');
  if (bloqueio) throw erro(bloqueio, 402);

  const corpo = String(text || '').trim();
  if (!corpo) throw erro('Escreva a mensagem');
  const numero = normalizarNumero(to);
  if (!valido(numero)) throw erro(`Número inválido: ${to}`);

  const c = contato || store.findContact(acc, numero);

  limits.enforce(acc, 'sms', segmentos(corpo));

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
      to: numero,
      text: corpo,
      from: cfgSms.from,
      referencia: registro.id,
      callbackUrl: cfgSms.callbackUrl
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

  historico(acc).unshift(registro);
  const h = historico(acc);
  if (h.length > 2000) h.length = 2000;
  db.save();

  if (registro.status === 'failed') throw erro(registro.error || 'Falha ao enviar o SMS');
  return registro;
}

// Disparo em massa. Devolve o resumo; os erros individuais ficam no histórico.
async function enviarMassa(acc, { numeros, text, por = null }) {
  const lista = [...new Set((numeros || []).map(normalizarNumero).filter(valido))];
  if (!lista.length) throw erro('Nenhum número válido na seleção');

  const seg = segmentos(text);
  limits.enforce(acc, 'sms', seg * lista.length);

  const r = { total: lista.length, enviados: 0, falhas: 0, erros: [] };
  for (const numero of lista) {
    const c = store.findContact(acc, numero);
    try {
      await enviar(acc, { to: numero, text, contato: c, origem: 'massa', por });
      r.enviados++;
    } catch (e) {
      r.falhas++;
      if (r.erros.length < 10) r.erros.push({ to: numero, erro: e.message });
    }
  }
  store.logEvent({ type: 'sms_bulk', accountId: acc.id, ...r, erros: undefined });
  return r;
}

function historico(acc) {
  if (!Array.isArray(acc.smsLog)) acc.smsLog = [];
  return acc.smsLog;
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

// Teste de conexão do Admin SaaS: diz qual parte do contrato falhou.
async function testar() {
  const c = cfg();
  if (!c.token) return { ok: false, etapa: 'AUTH', msg: 'Informe o token da Integra X' };
  try {
    const s = await saldo();
    plog({ type: 'sms_test_ok', creditos: s.creditos });
    return { ok: true, saldo: s, base: baseUrl(), rota: CONTRATO.rotas.saldo };
  } catch (e) {
    const etapa = /HTTP 404|not found/i.test(e.message) ? 'ROTAS'
      : /401|403|token|unauthor/i.test(e.message) ? 'AUTH'
      : /Não foi possível falar/i.test(e.message) ? 'BASE'
      : 'CAMPOS';
    plog({ type: 'sms_test_fail', etapa, error: e.message });
    return { ok: false, etapa, msg: e.message, base: baseUrl(), rota: CONTRATO.rotas.saldo };
  }
}

// ---------------------------------------------------------------------------
// STATUS DE ENTREGA
// O provedor avisa por webhook; a consulta manual existe para quem não tem URL
// pública configurada (desenvolvimento) e para reconferir um envio específico.
// ---------------------------------------------------------------------------
function aplicarStatus(providerId, status, broadcast) {
  if (!providerId) return { ok: false, reason: 'sem id' };
  for (const acc of db.get().accounts) {
    const reg = (acc.smsLog || []).find(x => x.providerId === providerId);
    if (!reg) continue;
    reg.status = status;
    reg.updatedAt = Date.now();
    db.save();
    if (broadcast) broadcast('sms', { accountId: acc.id, id: reg.id, status });
    return { ok: true, accountId: acc.id, id: reg.id };
  }
  plog({ type: 'sms_webhook_unmatched', providerId, status });
  return { ok: false, reason: 'não encontrado' };
}

async function consultarStatus(acc, id, broadcast) {
  const reg = (acc.smsLog || []).find(x => x.id === id);
  if (!reg) throw erro('Envio não encontrado', 404);
  if (!reg.providerId) return reg;
  const d = await call('GET', CONTRATO.rotas.status(reg.providerId));
  const st = CONTRATO.lerStatus(d);
  if (st) { reg.status = st; reg.updatedAt = Date.now(); db.save(); }
  if (broadcast) broadcast('sms', { accountId: acc.id, id: reg.id, status: reg.status });
  return reg;
}

// Webhook público de entrega (DLR). Não confia no corpo para nada além do id e
// do status; qualquer outro campo é ignorado.
function webhookHandler(broadcast) {
  return (req, res) => {
    res.json({ ok: true });
    try {
      const { id, status } = CONTRATO.lerWebhook(req.body || {});
      if (!id || !status) return;
      aplicarStatus(id, status, broadcast);
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
    usage: limits.report(acc).sms
  };
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
    rotas: CONTRATO.rotas,
    logs: (c.logs || []).slice(0, 30)
  };
}

module.exports = {
  CONTRATO, cfg, emptyConfig, configured, baseUrl,
  normalizarNumero, valido, segmentos, normalizarStatus,
  enviar, enviarMassa, historico, saldo, testar,
  aplicarStatus, consultarStatus, webhookHandler,
  publicView, adminView
};
