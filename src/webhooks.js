// Webhooks de entrada (aba Webhooks) — recebem eventos de sistemas externos
// (checkout, formulário, CRM...) e, via MAPEAMENTO DE CAMPOS, criam/atualizam
// o contato e disponibilizam as variáveis para os flows/templates.
const db = require('./db');
const store = require('./store');

// Achata um objeto aninhado em caminhos com ponto: { data:{member:{name}} } → "data.member.name"
// Arrays viram índice: itens[0].preco. Limita profundidade e quantidade por segurança.
function flatten(obj, prefix = '', out = {}, depth = 0) {
  if (depth > 6 || Object.keys(out).length > 300) return out;
  if (obj === null || typeof obj !== 'object') { if (prefix) out[prefix] = obj; return out; }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, out, depth + 1);
    else out[key] = v;
  }
  return out;
}

// Só valores escalares viram "variáveis" selecionáveis no mapeamento
function scalarPaths(flat) {
  const o = {};
  for (const [k, v] of Object.entries(flat)) {
    if (['string', 'number', 'boolean'].includes(typeof v)) o[k] = v;
  }
  return o;
}

function emptyMapping() {
  return { name: '', phone: '', email: '', custom: [] }; // custom: [{ key, path }]
}

// Resolve as variáveis a partir do payload achatado, seguindo o mapeamento.
// Retorna { phone, name, email, vars:{...custom} }.
function applyMapping(mapping, flat) {
  const get = p => (p && flat[p] !== undefined ? flat[p] : undefined);
  const phoneRaw = get(mapping.phone);
  const phone = phoneRaw != null ? store.normalizeWaId(phoneRaw) : '';
  const vars = {};
  for (const c of mapping.custom || []) {
    if (c && c.key && c.path && flat[c.path] !== undefined) vars[c.key] = String(flat[c.path]);
  }
  return {
    phone,
    name: get(mapping.name) != null ? String(get(mapping.name)) : '',
    email: get(mapping.email) != null ? String(get(mapping.email)) : '',
    vars
  };
}

// Processa um evento recebido: guarda amostra, aplica mapeamento, faz upsert do
// contato (telefone é obrigatório) e devolve o resultado p/ eventual disparo de flow.
function ingest(acc, webhook, payload, broadcast) {
  const flat = scalarPaths(flatten(payload || {}));
  webhook.lastPayload = flat;
  webhook.lastPayloadAt = Date.now();
  webhook.hits = (webhook.hits || 0) + 1;

  const mapping = webhook.mapping || emptyMapping();
  const mapped = applyMapping(mapping, flat);

  let contact = null;
  if (mapped.phone) {
    // Cadastro automático: cria (com a etapa padrão) ou preenche só as lacunas.
    contact = store.upsertContact(acc, mapped.phone, mapped.name || undefined, {
      email: mapped.email,
      source: { type: 'webhook', id: webhook.id, headline: webhook.name, ts: Date.now() }
    });
    // variáveis do evento: o valor mais recente prevalece (é dado do evento, não cadastro)
    contact.vars = { ...(contact.vars || {}), ...mapped.vars };
    if (webhook.tags && webhook.tags.length) {
      contact.tags = contact.tags || [];
      for (const t of webhook.tags) if (!contact.tags.includes(t)) contact.tags.push(t);
    }
    contact.lastMessageAt = contact.lastMessageAt || Date.now();
  }
  db.save();
  store.logEvent({
    type: 'webhook_in', accountId: acc.id, webhookId: webhook.id,
    matched: !!contact, phone: mapped.phone || null
  });
  if (broadcast) broadcast('webhook', { accountId: acc.id, webhookId: webhook.id });
  return { flat, mapped, contact };
}

module.exports = { flatten, scalarPaths, emptyMapping, applyMapping, ingest };
