// ============================================================================
// AGENTE DE IA
//
// Responde o cliente quando não há ninguém para responder: atendimento aberto,
// sem atendente assumido e fora de automação. É um substituto do silêncio, não
// do time.
//
// POR QUE A RESPONSES API, E NÃO A DE ASSISTENTES
//
// A API de Assistentes (aquela de `asst_...`) foi descontinuada pela OpenAI e
// desliga em 26 de agosto de 2026. Guardar um ID de assistente aqui seria
// construir sobre algo com data para parar de funcionar — e, pior, com a
// configuração do agente morando fora do Koonfy. Aqui o prompt é do cliente e
// fica no Koonfy, como pedido; para a OpenAI vai só a chave da conta dele.
//
// Docs: https://developers.openai.com/api/docs/api-reference/responses/create
// ============================================================================
const db = require('./db');
const store = require('./store');
const wa = require('./whatsapp');

const API = 'https://api.openai.com/v1/responses';

// Modelos oferecidos no painel. Lista curta de propósito: o cliente escolhe
// entre "mais barato" e "mais capaz", não entre trinta nomes.
const MODELOS = [
  ['gpt-4.1-mini', 'GPT-4.1 mini, rápido e barato (recomendado)'],
  ['gpt-4.1', 'GPT-4.1, mais capaz e mais caro'],
  ['gpt-4o-mini', 'GPT-4o mini'],
  ['gpt-4o', 'GPT-4o']
];

function padrao() {
  return {
    enabled: false,
    apiKey: '',
    model: 'gpt-4.1-mini',
    prompt: '',
    channels: [],          // vazio = todos os WhatsApps da conta
    historico: 12,         // mensagens anteriores enviadas como contexto
    maxSaida: 600,         // teto de caracteres da resposta
    assinatura: '',        // sufixo opcional ("— atendimento automático")
    logs: []
  };
}

function ensure(acc) {
  if (!acc.ia) acc.ia = padrao();
  for (const [k, v] of Object.entries(padrao())) {
    if (acc.ia[k] === undefined) acc.ia[k] = v;
  }
  return acc.ia;
}

function configurada(acc) {
  const c = ensure(acc);
  return !!(c.enabled && c.apiKey && String(c.prompt || '').trim());
}

function log(acc, item) {
  const c = ensure(acc);
  c.logs.unshift({ ts: Date.now(), ...item });
  if (c.logs.length > 120) c.logs.length = 120;
}

// ---------------------------------------------------------------------------
// QUANDO A IA PODE FALAR
//
// Cada linha aqui é uma forma de atropelar alguém. A ordem importa menos que o
// fato de todas serem verificadas: basta uma para a IA ficar calada.
// ---------------------------------------------------------------------------
function podeResponder(acc, contact, opts = {}) {
  const c = ensure(acc);
  if (!configurada(acc)) return { ok: false, motivo: 'ia_desligada' };
  if (contact.iaOff) return { ok: false, motivo: 'desligada_nesta_conversa' };
  if (contact.blocked) return { ok: false, motivo: 'contato_em_opt_out' };

  // Canal: o cliente escolhe em quais WhatsApps a IA atende.
  if (c.channels.length && contact.chId && !c.channels.includes(contact.chId)) {
    return { ok: false, motivo: 'canal_fora_do_escopo' };
  }
  // Atendimento precisa estar ABERTO. Finalizado, quem reabre é o cliente
  // falando de novo — e aí o webhook chama isto outra vez.
  const att = contact.attendance || {};
  if (att.status !== 'open') return { ok: false, motivo: 'atendimento_finalizado' };
  // Alguém assumiu: a IA não fala por cima de um atendente humano.
  if (contact.assignedTo) return { ok: false, motivo: 'tem_atendente' };
  // No meio de uma automação, quem conduz é o fluxo.
  if (contact.flowWait) return { ok: false, motivo: 'em_automacao' };
  if (opts.flowRespondeu) return { ok: false, motivo: 'fluxo_respondeu' };
  // Fora da janela de 24h só sai template, e template a IA não escreve.
  if (contact.windowExpiresAt && contact.windowExpiresAt < Date.now()) {
    return { ok: false, motivo: 'fora_da_janela' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CHAMADA À OPENAI
//
// O formato da resposta é lido de forma tolerante: a Responses API já mudou o
// nome do campo de saída entre versões da documentação, e uma resposta boa
// descartada por causa de um nome de campo seria o pior dos mundos. Procura o
// texto onde ele pode estar, em vez de exigir um caminho exato.
// ---------------------------------------------------------------------------
function extrairTexto(j) {
  if (!j) return '';
  if (typeof j.output_text === 'string' && j.output_text.trim()) return j.output_text.trim();
  const pedacos = [];
  const varrer = (itens) => {
    if (!Array.isArray(itens)) return;
    for (const it of itens) {
      if (!it || typeof it !== 'object') continue;
      if (it.role && it.role !== 'assistant') continue;
      const conteudo = Array.isArray(it.content) ? it.content : [];
      for (const c of conteudo) {
        if (!c || typeof c !== 'object') continue;
        if (typeof c.text === 'string') pedacos.push(c.text);
        else if (c.text && typeof c.text.value === 'string') pedacos.push(c.text.value);
      }
    }
  };
  varrer(j.output);
  if (!pedacos.length) varrer(j.instructions);
  if (!pedacos.length) varrer(j.input_items);
  return pedacos.join('\n').trim();
}

async function chamar(cfg, entrada) {
  const corpo = {
    model: cfg.model || 'gpt-4.1-mini',
    input: entrada,
    max_output_tokens: 800
  };
  const ctrl = new AbortController();
  // Sem teto, uma chamada pendurada seguraria o webhook da Meta, que tem os
  // seus próprios limites de tempo e reenviaria a mensagem.
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let r, texto;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify(corpo),
      signal: ctrl.signal
    });
    texto = await r.text();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'A OpenAI não respondeu a tempo' : ('Falha ao falar com a OpenAI: ' + e.message));
  } finally { clearTimeout(timer); }

  let j = {};
  try { j = JSON.parse(texto); } catch { j = {}; }
  if (!r.ok) {
    const msg = (j.error && j.error.message) || ('HTTP ' + r.status);
    // A chave errada é o erro mais comum, e "HTTP 401" não ajuda ninguém.
    if (r.status === 401) throw new Error('A OpenAI recusou a chave da API. Gere uma nova em platform.openai.com e cole em Agente de IA.');
    if (r.status === 429) throw new Error('Limite da OpenAI atingido (cota ou velocidade): ' + msg);
    throw new Error('OpenAI: ' + msg);
  }
  const saida = extrairTexto(j);
  if (!saida) throw new Error('A OpenAI respondeu sem texto utilizável');
  return saida;
}

// Monta a conversa para o modelo: instrução do cliente + histórico recente.
function montarEntrada(acc, contact) {
  const c = ensure(acc);
  const quantas = Math.max(2, Math.min(40, Number(c.historico) || 12));
  const msgs = (acc.messages || [])
    .filter(m => m.waId === contact.waId && (m.type === 'text' || !m.type) && m.text)
    .slice(-quantas);

  const instrucao = [
    String(c.prompt || '').trim(),
    '',
    'Você atende pelo WhatsApp. Responda em português do Brasil, com mensagens curtas.',
    'Não invente preços, prazos, políticas ou dados que não estejam nas instruções acima.',
    'Se não souber, diga que vai chamar um atendente humano.',
    `Escreva no máximo ${Math.max(120, Math.min(2000, Number(c.maxSaida) || 600))} caracteres.`
  ].join('\n');

  const entrada = [{ role: 'developer', content: instrucao }];
  for (const m of msgs) {
    entrada.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: String(m.text).slice(0, 4000) });
  }
  // Se a última for nossa, ainda assim há o que responder — mas sem nenhuma
  // mensagem do cliente não há pergunta nenhuma.
  if (!entrada.some(e => e.role === 'user')) return null;
  return entrada;
}

// ---------------------------------------------------------------------------
// RESPONDER
//
// Falha aqui NUNCA derruba o recebimento da mensagem: o cliente vê a mensagem
// no painel de qualquer jeito, e o erro fica no log da IA para o dono ver.
// ---------------------------------------------------------------------------
async function responder(acc, contact, deliver, opts = {}) {
  const pode = podeResponder(acc, contact, opts);
  if (!pode.ok) return { enviou: false, motivo: pode.motivo };

  const c = ensure(acc);
  const entrada = montarEntrada(acc, contact);
  if (!entrada) return { enviou: false, motivo: 'sem_pergunta' };

  let texto;
  try {
    texto = await chamar(c, entrada);
  } catch (e) {
    log(acc, { tipo: 'erro', waId: contact.waId, erro: e.message });
    db.save();
    store.logEvent({ type: 'ia_error', accountId: acc.id, error: e.message });
    return { enviou: false, motivo: 'erro', erro: e.message };
  }

  const teto = Math.max(120, Math.min(2000, Number(c.maxSaida) || 600));
  if (texto.length > teto) texto = texto.slice(0, teto).replace(/\s+\S*$/, '') + '…';
  if (String(c.assinatura || '').trim()) texto += '\n\n' + String(c.assinatura).trim();

  try {
    // chanCtx quer o OBJETO do canal, não o id: passando a string ele monta um
    // contexto sem `wa`, e o envio morre com "Phone Number ID ausente".
    const ctx = db.chanCtx(acc, db.findChannel(acc, contact.chId));
    const r = await wa.sendText(ctx, contact.waId, texto);
    if (deliver) deliver(acc, contact.waId, { type: 'text', text: texto, byIA: true }, r);
    log(acc, { tipo: 'resposta', waId: contact.waId, chars: texto.length });
    db.save();
    return { enviou: true, texto };
  } catch (e) {
    log(acc, { tipo: 'erro_envio', waId: contact.waId, erro: e.message });
    db.save();
    return { enviou: false, motivo: 'erro_envio', erro: e.message };
  }
}

// Liga/desliga a IA numa conversa específica (botão do chat).
function alternarNaConversa(acc, contact, ligada) {
  contact.iaOff = !ligada;
  db.save();
  return !contact.iaOff;
}

// Teste do painel: usa o prompt salvo, sem mandar nada para o WhatsApp.
async function testar(acc, pergunta) {
  const c = ensure(acc);
  if (!c.apiKey) { const e = new Error('Informe a chave da API da OpenAI'); e.status = 400; throw e; }
  if (!String(c.prompt || '').trim()) { const e = new Error('Escreva as instruções do agente'); e.status = 400; throw e; }
  const entrada = [
    { role: 'developer', content: String(c.prompt).trim() },
    { role: 'user', content: String(pergunta || 'Olá, tudo bem?').slice(0, 2000) }
  ];
  return chamar(c, entrada);
}

module.exports = { MODELOS, padrao, ensure, configurada, podeResponder, responder, alternarNaConversa, testar, extrairTexto, chamar };
