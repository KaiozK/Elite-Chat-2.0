// Motor de automações (Flow Builder) — Koonfy
// Gatilhos: keyword (palavra-chave em mensagem recebida), link (frase do wa.me),
// webhook (POST externo em /flow-hook/:token).
// Ações (nós): text, buttons, http, delay.
const wa = require('./whatsapp');
const db = require('./db');
const store = require('./store');
const consent = require('./consent');

function normText(s) { return String(s || '').trim().toLowerCase(); }

// Casa a mensagem recebida com o gatilho. `kind`: 'text' | 'interactive'.
// Gatilhos por texto: keyword, link (frase exata). Por interação: button, list.
function triggerMatches(flow, text, kind) {
  if (!flow || !flow.enabled || !flow.trigger) return false;
  const t = normText(text);
  if (!t) return false;
  const tr = flow.trigger;
  if (tr.type === 'keyword') {
    const kw = normText(tr.keyword);
    if (!kw) return false;
    return tr.match === 'exact' ? t === kw : t.includes(kw);
  }
  if (tr.type === 'link') return t === normText(tr.phrase);
  if ((tr.type === 'button' || tr.type === 'list') && kind === 'interactive') {
    const kw = normText(tr.keyword);
    return !kw || t === kw || t.includes(kw); // sem termo = qualquer clique dispara
  }
  return false; // webhook só dispara pela URL
}

// Encontra a 1ª automação ativa cujo gatilho casa com a mensagem recebida.
function findMatchingFlow(acc, text, kind) {
  return (acc.flows || []).find(f => f.enabled && triggerMatches(f, text, kind)) || null;
}

function findFlowByHook(token) {
  for (const acc of db.get().accounts) {
    const f = (acc.flows || []).find(x => x.trigger && x.trigger.type === 'webhook' && x.trigger.hookToken === token && x.enabled);
    if (f) return { acc, flow: f };
  }
  return null;
}

// Interpola {{campo}} com o contexto (nome, telefone, texto recebido e vars extras)
function interpolate(str, ctx) {
  if (typeof str !== 'string') return str;
  const map = {
    nome: ctx.contactName || '',
    name: ctx.contactName || '',
    telefone: ctx.to || '',
    phone: ctx.to || '',
    texto: ctx.text || '',
    message: ctx.text || '',
    ...(ctx.vars || {})
  };
  return str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, k) => (map[k] !== undefined ? String(map[k]) : m));
}

// Avalia um nó de condição → true/false (define qual saída seguir: Sim/Não).
function evalCondition(node, ctx) {
  const src = {
    texto: ctx.text || '', message: ctx.text || '',
    nome: ctx.contactName || '', name: ctx.contactName || '',
    telefone: ctx.to || '', phone: ctx.to || '',
    http: (ctx.vars && ctx.vars.http) || '', httpstatus: (ctx.vars && ctx.vars.httpStatus) || '',
    // status do consentimento: use "sim"/"nao" (opt-in) ou o status cru
    optin: ctx.consentStatus === 'opted_in' ? 'sim' : 'nao',
    optout: ctx.consentStatus === 'opted_out' ? 'sim' : 'nao',
    consent: ctx.consentStatus || 'pending',
    ...(ctx.vars || {})
  };
  const field = String(node.field || 'texto').toLowerCase();
  const left = String(src[field] !== undefined ? src[field] : '').toLowerCase();
  const val = interpolate(String(node.value || ''), ctx).toLowerCase();
  switch (node.op) {
    case 'equals': return left === val;
    case 'notEquals': return left !== val;
    case 'exists': return left.length > 0;
    case 'empty': return left.length === 0;
    case 'startsWith': return left.startsWith(val);
    default: return left.includes(val); // contains
  }
}

// Executa um único nó de ação. Atualiza ctx.vars (ex.: resposta HTTP). Retorna {ok, detail}.
async function execNode(acc, node, ctx, deliver) {
  const to = ctx.to ? store.normalizeWaId(ctx.to) : '';
  const need = () => { if (!to) throw new Error('sem destinatário'); };

  // ENVIAR TEXTO — com botões OPCIONAIS. O formato segue a regra da Meta:
  //   sem botões  → mensagem de texto simples
  //   1 a 3       → mensagem interativa de BOTÕES (reply, título ≤ 20 chars)
  //   4 a 10      → mensagem interativa de LISTA  (linha ≤ 24 chars)
  //   com URL     → CTA de link (a Meta não permite combinar com reply buttons)
  if (node.type === 'text') {
    need();
    const body = interpolate(node.text || node.body || '', ctx);

    // Botão de link (CTA URL): 1 por mensagem e não combina com botões de resposta.
    const url = interpolate(node.url || '', ctx).trim();
    if (url) {
      const displayText = (interpolate(node.urlText || 'Abrir link', ctx) || 'Abrir link').slice(0, 20);
      const interactive = { type: 'cta_url', body: { text: body }, action: { name: 'cta_url', parameters: { display_text: displayText, url } } };
      const r = await wa.sendInteractive(acc, to, interactive);
      if (deliver) deliver(acc, to, { type: 'interactive', text: `${body}\n[🔗 ${displayText}]` }, r);
      return { ok: true, detail: 'cta_url' };
    }

    const titles = (node.buttons || [])
      .map(b => interpolate(String((b && b.title) || b || ''), ctx).trim())
      .filter(Boolean);

    if (!titles.length) {
      const r = await wa.sendText(acc, to, body);
      if (deliver) deliver(acc, to, { type: 'text', text: body }, r);
      return { ok: true };
    }

    if (titles.length <= 3) {
      const buttons = titles.map((t, i) => ({ type: 'reply', reply: { id: (node.buttons[i] && node.buttons[i].id) || `btn_${i + 1}`, title: t.slice(0, 20) } }));
      const r = await wa.sendInteractive(acc, to, { type: 'button', body: { text: body }, action: { buttons } });
      if (deliver) deliver(acc, to, { type: 'interactive', text: `${body}\n${buttons.map(b => `[${b.reply.title}]`).join(' ')}` }, r);
      return { ok: true, detail: `${buttons.length} botões` };
    }

    const rows = titles.slice(0, 10).map((t, i) => ({ id: (node.buttons[i] && node.buttons[i].id) || `row_${i + 1}`, title: t.slice(0, 24) }));
    const interactive = {
      type: 'list',
      body: { text: body },
      action: {
        button: (interpolate(node.listButton || 'Ver opções', ctx) || 'Ver opções').slice(0, 20),
        sections: [{ title: (node.listTitle || 'Opções').slice(0, 24), rows }]
      }
    };
    const r = await wa.sendInteractive(acc, to, interactive);
    if (deliver) deliver(acc, to, { type: 'interactive', text: `${body}\n${rows.map(x => '• ' + x.title).join('\n')}` }, r);
    return { ok: true, detail: `lista (${rows.length} itens)` };
  }
  if (node.type === 'buttons') {
    need();
    const body = interpolate(node.body, ctx);
    // Botão de link (CTA URL): a Meta permite 1 botão de URL por mensagem interativa,
    // e ele NÃO pode ser combinado com botões de resposta. Se houver URL, prevalece o CTA.
    const url = interpolate(node.url || '', ctx).trim();
    if (url) {
      const displayText = (interpolate(node.urlText || 'Abrir link', ctx) || 'Abrir link').slice(0, 20);
      const interactive = { type: 'cta_url', body: { text: body }, action: { name: 'cta_url', parameters: { display_text: displayText, url } } };
      const r = await wa.sendInteractive(acc, to, interactive);
      if (deliver) deliver(acc, to, { type: 'interactive', text: `${body}\n[🔗 ${displayText}]` }, r);
      return { ok: true, detail: 'cta_url' };
    }
    const buttons = (node.buttons || []).slice(0, 3).map((b, i) => ({
      type: 'reply',
      reply: { id: b.id || `btn_${i + 1}`, title: interpolate(String(b.title || b), ctx).slice(0, 20) }
    }));
    const r = await wa.sendInteractive(acc, to, { type: 'button', body: { text: body }, action: { buttons } });
    const resumo = buttons.map(b => `[${b.reply.title}]`).join(' ');
    if (deliver) deliver(acc, to, { type: 'interactive', text: `${body}\n${resumo}` }, r);
    return { ok: true };
  }
  if (node.type === 'list') {
    need();
    const rows = (node.items || []).slice(0, 10).map((it, i) => ({ id: it.id || `row_${i + 1}`, title: interpolate(String(it.title || it), ctx).slice(0, 24) }));
    const interactive = {
      type: 'list',
      body: { text: interpolate(node.body || '', ctx) },
      action: { button: (node.buttonText || 'Ver opções').slice(0, 20), sections: [{ title: (node.header || 'Opções').slice(0, 24), rows }] }
    };
    const r = await wa.sendInteractive(acc, to, interactive);
    if (deliver) deliver(acc, to, { type: 'interactive', text: `${interpolate(node.body || '', ctx)}\n${rows.map(x => '• ' + x.title).join('\n')}` }, r);
    return { ok: true };
  }
  if (node.type === 'media') {
    need();
    const kind = node.kind || 'image';
    const media = { link: interpolate(node.link || '', ctx) };
    if (node.caption && kind !== 'audio') media.caption = interpolate(node.caption, ctx);
    if (kind === 'document' && node.filename) media.filename = node.filename;
    const r = await wa.sendMedia(acc, to, kind, media);
    if (deliver) deliver(acc, to, { type: kind, text: media.caption || `[${kind}]`, media: { link: media.link, caption: media.caption || '' } }, r);
    return { ok: true, detail: kind };
  }
  if (node.type === 'template') {
    need();
    if (!node.templateName) throw new Error('template não informado');
    const r = await wa.sendTemplate(acc, to, node.templateName, node.language || 'pt_BR');
    if (deliver) deliver(acc, to, { type: 'template', text: `📋 Template: ${node.templateName}` }, r);
    return { ok: true, detail: node.templateName };
  }
  if (node.type === 'http') {
    const url = interpolate(node.url, ctx);
    const method = (node.method || 'POST').toUpperCase();
    const headers = {};
    for (const h of node.headers || []) if (h && h.key) headers[h.key] = interpolate(h.value, ctx);
    let bodyStr;
    if (method !== 'GET' && method !== 'HEAD' && node.body) {
      bodyStr = interpolate(node.body, ctx);
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    }
    const resp = await fetch(url, { method, headers, body: bodyStr });
    const text = (await resp.text()).slice(0, 500);
    ctx.vars = { ...(ctx.vars || {}), http: text, httpStatus: String(resp.status) };
    return { ok: resp.ok, detail: `HTTP ${resp.status}` };
  }
  if (node.type === 'delay') {
    const s = Math.min(300, Math.max(0, Number(node.seconds) || 0));
    await new Promise(r => setTimeout(r, s * 1000));
    return { ok: true, detail: `${s}s` };
  }
  // ENVIAR SMS (Integra X). Vai para o mesmo número do contato, a menos que a
  // etapa informe outro. Falhar aqui não derruba o fluxo: o passo é registrado
  // como não executado e o restante do caminho continua.
  if (node.type === 'sms') {
    const sms = require('./sms');
    const texto = interpolate(node.text || node.body || '', ctx).trim();
    if (!texto) return { ok: false, detail: 'mensagem vazia' };
    const destino = interpolate(node.to || '', ctx).trim() || to;
    if (!destino) return { ok: false, detail: 'sem destinatário' };
    try {
      const r = await sms.enviar(acc, { to: destino, text: texto, origem: 'flow' });
      return { ok: true, detail: `SMS para ${r.to} (${r.segments} seg.)` };
    } catch (e) {
      return { ok: false, detail: e.message };
    }
  }
  if (node.type === 'addtag' || node.type === 'removetag') {
    const c = store.findContact(acc, to);
    if (!c) return { ok: false, detail: 'contato não encontrado' };
    const tag = interpolate(node.tag || '', ctx).trim();
    if (!tag) return { ok: false, detail: 'tag vazia' };
    c.tags = c.tags || [];
    if (node.type === 'addtag') { if (!c.tags.includes(tag)) c.tags.push(tag); }
    else c.tags = c.tags.filter(t => t !== tag);
    db.save();
    return { ok: true, detail: tag };
  }
  if (node.type === 'movestage') {
    const c = store.findContact(acc, to);
    if (!c) return { ok: false, detail: 'contato não encontrado' };
    if (node.stage) { c.stage = node.stage; db.save(); }
    return { ok: true, detail: node.stage || '' };
  }
  // ---- Opt-in / Opt-out (módulo de consentimento) ----
  if (node.type === 'optin' || node.type === 'reactivate') {
    const c = store.findContact(acc, to);
    if (!c) return { ok: false, detail: 'contato não encontrado' };
    const reason = interpolate(node.reason || '', ctx).trim() || null;
    consent.optIn(acc, c, { source: 'flow', reason, by: 'Automação' });
    store.logEvent({ type: 'opt_in', accountId: acc.id, waId: c.waId, source: 'flow', reason });
    return { ok: true, detail: node.type === 'reactivate' ? 'reativado' : 'opt-in registrado' };
  }
  if (node.type === 'optout') {
    const c = store.findContact(acc, to);
    if (!c) return { ok: false, detail: 'contato não encontrado' };
    const reason = interpolate(node.reason || '', ctx).trim() || 'Opt-out por automação';
    consent.optOut(acc, c, { source: 'flow', reason, by: 'Automação' });
    store.logEvent({ type: 'opt_out', accountId: acc.id, waId: c.waId, source: 'flow', reason });
    // envia a confirmação configurada (é o próprio opt-out — não passa pelo guard)
    const cfg = consent.cfgOf(acc);
    if (cfg.sendOptOutMessage && cfg.optOutMessage) {
      const body = consent.renderMessage(acc, c, cfg.optOutMessage);
      try {
        const r = await wa.sendText(acc, to, body);
        if (deliver) deliver(acc, to, { type: 'text', text: body }, r);
      } catch (e) { /* opt-out vale mesmo se a confirmação falhar */ }
    }
    return { ok: true, detail: 'opt-out registrado' };
  }
  // ---- ELITE PAY: gerar cobrança Pix e enviar na conversa ----
  // Disponibiliza as variáveis {{pagamento.link}}, {{pagamento.valor}},
  // {{pagamento.codigo}} e {{pagamento.id}} para os nós seguintes do fluxo.
  if (node.type === 'payment') {
    need();
    const elitepay = require('./elitepay');
    const reais = Number(String(interpolate(String(node.value || ''), ctx)).replace(/[^\d,.]/g, '').replace(',', '.')) || 0;
    const c = store.findContact(acc, to);
    const ch = await elitepay.createCharge(acc, {
      valueCents: Math.round(reais * 100),
      comment: interpolate(node.description || '', ctx),
      waId: to, contactName: (c && c.name) || ctx.contactName || '',
      origin: 'flow', byName: 'Automação'
    });
    ctx.vars = {
      ...(ctx.vars || {}),
      'pagamento.link': ch.payUrl || ch.paymentLinkUrl, 'pagamento.valor': elitepay.fmtBRL(ch.value),
      'pagamento.codigo': ch.brCode, 'pagamento.id': ch.id,
      'pagamento.qrcode': ch.qrCodeImage || ''   // imagem do QR Code Pix (URL) p/ um nó de mídia
    };
    if (node.sendMessage !== false) {
      const text = elitepay.chargeMessage(acc, ch);
      const r = await wa.sendText(acc, to, text);
      if (deliver) deliver(acc, to, { type: 'text', text }, r);
    }
    // Envia o QR Code como imagem quando marcado no nó (fica "top" no chat)
    if (node.sendQr && ch.qrCodeImage) {
      try {
        const r2 = await wa.sendMedia(acc, to, 'image', { link: ch.qrCodeImage, caption: 'Escaneie o QR Code para pagar' });
        if (deliver) deliver(acc, to, { type: 'image', text: '[QR Code Pix]', media: { link: ch.qrCodeImage, caption: 'Escaneie o QR Code para pagar' } }, r2);
      } catch (e) { /* segue mesmo se a imagem falhar */ }
    }
    return { ok: true, detail: `cobrança ${elitepay.fmtBRL(ch.value)}` };
  }
  if (node.type === 'ai') {
    // Este nó era um placeholder que não fazia nada. Agora usa o Agente de IA
    // da conta: a mesma chave e as mesmas instruções configuradas em
    // Agente de IA, mais o que estiver escrito no próprio nó.
    //
    // As guardas do agente (atendente assumido, opt-out, janela) NÃO valem
    // aqui: quem mandou responder foi o fluxo, e o fluxo é uma ordem explícita
    // do dono da conta. Só a configuração é reaproveitada.
    const ia = require('./ia');
    const cfg = ia.ensure(acc);
    if (!cfg.apiKey || !String(cfg.prompt || '').trim()) {
      return { ok: false, detail: 'Agente de IA sem chave ou sem instruções' };
    }
    const extra = interpolate(String(node.text || node.prompt || '').trim(), ctx);
    const instrucao = [String(cfg.prompt).trim(), extra && ('\nNesta etapa: ' + extra)]
      .filter(Boolean).join('\n');
    const entrada = [
      { role: 'developer', content: instrucao },
      { role: 'user', content: String(ctx.text || 'Olá').slice(0, 2000) }
    ];
    let texto;
    try { texto = await ia.chamar(cfg, entrada); }
    catch (e) { return { ok: false, detail: 'IA: ' + e.message }; }
    const teto = Math.max(120, Math.min(2000, Number(cfg.maxSaida) || 600));
    if (texto.length > teto) texto = texto.slice(0, teto).replace(/\s+\S*$/, '') + '…';
    const r = await wa.sendText(acc, to, texto);
    if (deliver) deliver(acc, to, { type: 'text', text: texto }, r);
    return { ok: true, detail: 'IA respondeu (' + texto.length + ' caracteres)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// ESPERA POR RESPOSTA DO CLIENTE
//
// Um nó com botões (ou itens de lista) pode ter UMA SAÍDA POR OPÇÃO. Quando
// tem, o fluxo não segue em frente na hora: ele para, anota no contato que
// está esperando, e só continua quando a pessoa toca num botão — aí retoma
// pelo caminho daquela opção.
//
// Quando o nó tem apenas a saída única e sem rótulo (fluxos montados antes
// disso existir), o comportamento antigo é preservado: segue direto.
// ---------------------------------------------------------------------------

// Identificador da saída de uma opção. Usa o id do botão quando existe, senão
// a posição — é o mesmo id que volta no `replyId` do clique.
function optBranch(id) { return 'opt:' + id; }

// Opções de um nó, na ordem, já com o id que vai no botão enviado.
function nodeOptions(node) {
  if (!node) return [];
  const brutos = (node.type === 'list') ? (node.items || []) : (node.buttons || []);
  return brutos.map((o, i) => ({
    id: (o && o.id) || (node.type === 'list' ? `row_${i + 1}` : `btn_${i + 1}`),
    title: optTitle(o)
  })).filter(o => o.title.trim());
}

// O nó espera resposta? Só se tiver opções E pelo menos uma saída por opção.
function esperaResposta(node, saidas) {
  if (!nodeOptions(node).length) return false;
  return (saidas || []).some(e => String(e.branch || '').startsWith('opt:'));
}

// Janela de espera: 24h, a mesma da conversa no WhatsApp. Passou disso, a
// resposta não retoma nada — vira mensagem normal e pode disparar outro fluxo.
const ESPERA_MS = 24 * 60 * 60 * 1000;

function marcarEspera(acc, ctx, flow, nodeId) {
  const c = ctx.to ? store.findContact(acc, store.normalizeWaId(ctx.to)) : null;
  if (!c) return;
  c.flowWait = { flowId: flow.id, nodeId, at: Date.now(), vars: ctx.vars || {} };
  db.save();
}

function limparEspera(acc, contact) {
  if (contact && contact.flowWait) { delete contact.flowWait; db.save(); }
}

// Percorre o grafo a partir de um ponto, seguindo as conexões.
// Ramifica em condição (Sim/Não) e em botões (uma saída por opção).
// Para em "Fim" e ao chegar num nó que espera resposta.
async function runGraph(acc, flow, ctx, deliver, log, inicio) {
  const nodes = {};
  for (const n of flow.graph.nodes) nodes[n.id] = n;
  const out = {};
  for (const e of flow.graph.edges) (out[e.from] = out[e.from] || []).push(e);

  // Retomada: começa depois da aresta da opção escolhida.
  let curId = inicio && inicio.nodeId
    ? inicio.nodeId
    : (flow.graph.nodes.find(n => n.type === 'trigger') || {}).id || 'trigger';
  let escolha = inicio ? inicio.optId : null;   // opção clicada, só no 1º salto

  let lastCond = false;
  const visited = new Set();
  let steps = 0;
  while (curId && steps++ < 200) {
    const edges = out[curId] || [];
    const curNode = nodes[curId];
    let edge;

    if (escolha) {
      // Primeiro salto da retomada: segue a saída do botão que a pessoa tocou.
      edge = edges.find(e => e.branch === optBranch(escolha));
      if (!edge) {
        // Opção sem caminho montado: encerra em silêncio em vez de cair num
        // ramo aleatório, que mandaria a mensagem errada para o cliente.
        log.push({ node: 'wait', ok: true, detail: `opção "${escolha}" sem caminho` });
        break;
      }
      escolha = null;
    } else if (curNode && curNode.type === 'condition') {
      const branch = lastCond ? 'yes' : 'no';
      edge = edges.find(e => e.branch === branch) || edges.find(e => !e.branch) || edges[0];
    } else {
      // Nunca segue uma saída de opção por engano: ela só vale na retomada.
      edge = edges.find(e => !String(e.branch || '').startsWith('opt:'));
    }

    if (!edge) break;
    const nxt = nodes[edge.to];
    if (!nxt || visited.has(nxt.id)) break;
    visited.add(nxt.id);

    if (nxt.type === 'end') { log.push({ node: 'end', ok: true, detail: null }); break; }
    if (nxt.type === 'condition') {
      // status do consentimento é lido AGORA (um nó anterior pode tê-lo mudado)
      const cc = ctx.to ? store.findContact(acc, store.normalizeWaId(ctx.to)) : null;
      ctx.consentStatus = cc ? consent.statusOf(cc) : 'pending';
      lastCond = evalCondition(nxt, ctx);
      log.push({ node: 'condition', ok: true, detail: lastCond ? 'Sim' : 'Não' });
      curId = nxt.id; continue;
    }

    try {
      const r = await execNode(acc, nxt, ctx, deliver);
      log.push({ node: nxt.type, ok: r.ok !== false, detail: r.detail || null });
    } catch (e) {
      log.push({ node: nxt.type, ok: false, detail: e.message });
    }

    // A pergunta foi enviada: para aqui e espera o toque do cliente.
    if (esperaResposta(nxt, out[nxt.id])) {
      marcarEspera(acc, ctx, flow, nxt.id);
      log.push({ node: 'wait', ok: true, detail: 'aguardando resposta do cliente' });
      break;
    }

    curId = nxt.id;
  }
}

// Executa uma automação. deliver(acc, to, content, apiResp) persiste+broadcast a saída.
async function runFlow(acc, flow, ctx, deliver, inicio) {
  const log = [];
  if (flow.graph && Array.isArray(flow.graph.nodes) && flow.graph.nodes.length) {
    await runGraph(acc, flow, ctx, deliver, log, inicio);
  } else {
    // compatibilidade: fluxos lineares antigos (flow.nodes[])
    for (const node of flow.nodes || []) {
      try {
        const r = await execNode(acc, node, ctx, deliver);
        log.push({ node: node.type, ok: r.ok !== false, detail: r.detail || null });
      } catch (e) { log.push({ node: node.type, ok: false, detail: e.message }); }
    }
  }
  flow.runs = (flow.runs || 0) + 1;
  flow.lastRun = Date.now();
  flow.lastResult = log.every(l => l.ok) ? 'ok' : 'partial';
  store.logEvent({ type: 'flow_run', accountId: acc.id, flowId: flow.id, flowName: flow.name, log });
  db.save();
  return log;
}

// Chamado pelo webhook a cada mensagem recebida. kind: 'text' | 'interactive'.
// `replyId` identifica o botão/item tocado (vazio em mensagem de texto).
//
// Ordem de prioridade: se o contato está no meio de uma automação esperando
// resposta, o clique dele RETOMA aquela automação. Só quem não está esperando
// passa pela busca de gatilho — senão um "Sim" no meio de um atendimento
// dispararia outro fluxo qualquer que tivesse "sim" como palavra-chave.
async function onInbound(acc, contact, text, kind, deliver, replyId) {
  const espera = contact && contact.flowWait;
  if (espera && kind === 'interactive') {
    const fluxo = (acc.flows || []).find(f => f.id === espera.flowId);
    const expirou = Date.now() - (espera.at || 0) > ESPERA_MS;

    if (fluxo && fluxo.enabled && !expirou) {
      // Casa pelo id do botão; se o id não vier, casa pelo título.
      const opcoes = nodeOptions((fluxo.graph.nodes || []).find(n => n.id === espera.nodeId));
      const alvo = opcoes.find(o => o.id === replyId)
        || opcoes.find(o => normText(o.title) === normText(text));

      limparEspera(acc, contact);
      if (alvo) {
        await runFlow(acc, fluxo, {
          to: contact.waId, contactName: contact.name, text, vars: espera.vars || {}
        }, deliver, { nodeId: espera.nodeId, optId: alvo.id });
        return fluxo;
      }
      // Tocou em algo que não é opção deste passo: segue o caminho normal.
    } else {
      limparEspera(acc, contact);   // fluxo apagado, desativado ou expirado
    }
  }

  const flow = findMatchingFlow(acc, text, kind);
  if (!flow) return null;
  await runFlow(acc, flow, { to: contact.waId, contactName: contact.name, text }, deliver);
  return flow;
}

// Espelha a validação do Flow Builder: um nó que pede orientação ao cliente
// (botões, lista, CTA de link ou condição) precisa ter o desfecho definido.
// Roda no servidor para que nenhuma automação incompleta entre no ar — nem pelo
// toggle da listagem, nem por chamada direta à API.
// Opção pode ser string ("Sim") ou objeto ({ title: 'Sim' }).
function optTitle(o) { return typeof o === 'string' ? o : String((o && o.title) || ''); }
function validateGraph(flow) {
  const g = (flow && flow.graph) || {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  if (!nodes.some(n => n.type === 'trigger')) return 'A automação precisa de um gatilho.';
  const from = (id, branch) => edges.some(e => e.from === id && (branch ? e.branch === branch : !e.branch));

  for (const n of nodes) {
    if (n.type === 'trigger') continue;
    const opts = (n.type === 'text' || n.type === 'buttons') ? (n.buttons || [])
      : n.type === 'list' ? (n.items || []) : [];
    const palavra = n.type === 'list' ? 'item da lista' : 'botão de resposta';

    if (opts.length) {
      const vazio = opts.findIndex(o => !optTitle(o).trim());
      if (vazio >= 0) return `Há um ${palavra} sem texto (opção ${vazio + 1}).`;

      // Duas formas de continuar depois de perguntar:
      //   · uma saída POR OPÇÃO  → o fluxo espera o clique e ramifica (preferida)
      //   · uma saída única      → segue direto, sem esperar (fluxos antigos)
      const porOpcao = edges.filter(e => e.from === n.id && String(e.branch || '').startsWith('opt:'));
      if (porOpcao.length) {
        // Escolheu ramificar: toda opção precisa levar a algum lugar, senão o
        // cliente toca num botão e a conversa morre sem resposta.
        const semCaminho = nodeOptions(n).find(o => !porOpcao.some(e => e.branch === optBranch(o.id)));
        if (semCaminho) return `O ${palavra} "${semCaminho.title}" não leva a lugar nenhum, conecte a saída dele.`;
      } else if (!from(n.id)) {
        return `Um passo pergunta ao cliente mas não tem resposta, conecte a saída de cada ${palavra} ao próximo passo.`;
      }
    }
    if (n.type === 'text') {
      const url = String(n.url || '').trim(), urlText = String(n.urlText || '').trim();
      if (urlText && !url) return `O botão de link "${urlText}" está sem redirecionamento.`;
      if (url && !/^https?:\/\/\S+\.\S+/i.test(url)) return 'A URL de um botão de link é inválida.';
      if (url && !urlText) return 'Um botão de link está sem texto.';
    }
    if (n.type === 'condition') {
      if (!from(n.id, 'yes')) return 'A saída "Sim" de uma condição não leva a lugar nenhum.';
      if (!from(n.id, 'no')) return 'A saída "Não" de uma condição não leva a lugar nenhum.';
    }
    if (n.type === 'sms' && !String(n.text || n.body || '').trim()) {
      return 'Uma etapa de SMS está sem mensagem.';
    }
  }
  return null;
}

module.exports = { runFlow, onInbound, findFlowByHook, triggerMatches, interpolate, validateGraph };
