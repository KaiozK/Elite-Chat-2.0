// ============================================================================
// MARKETING DA PLATAFORMA
//
// Aqui a PLATAFORMA fala com os PRÓPRIOS clientes (as contas do Koonfy), e
// não com os contatos deles. São dois usos:
//
//   • COBRANÇA  — avisar quem está para vencer, vencido ou em teste acabando.
//                 O texto aceita variáveis do faturamento ({{plano}}, {{valor}},
//                 {{vencimento}}), que é o que torna a mensagem útil.
//   • AVISO     — novidade, manutenção, campanha, o que for.
//
// Três canais, com alcances diferentes:
//   push      — chega a quem instalou o app e aceitou notificação
//   whatsapp  — usa a conexão da PLATAFORMA (a conta do admin), não a do cliente
//   sms       — usa o crédito da plataforma na Integra X
//
// Um disparo nunca sai por engano para todo mundo: o público é sempre um filtro
// explícito, e o resultado guarda quem recebeu, quem falhou e por quê.
// ============================================================================

const db = require('./db');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function cfg() {
  const p = db.get().platform;
  if (!p.marketing || typeof p.marketing !== 'object') p.marketing = { templates: [], campaigns: [] };
  if (!Array.isArray(p.marketing.templates)) p.marketing.templates = [];
  if (!Array.isArray(p.marketing.campaigns)) p.marketing.campaigns = [];
  return p.marketing;
}

// ---------------------------------------------------------------------------
// PÚBLICO
//
// Cada filtro responde a uma pergunta de cobrança. "vencendo" é o que interessa
// para lembrete; "vencidos" para recuperação; "trial" para conversão.
// ---------------------------------------------------------------------------
const PUBLICOS = {
  todos: { label: 'Todas as contas', filtro: () => true },
  ativos: { label: 'Assinatura ativa', filtro: a => a.billing.status === 'active' },
  trial: { label: 'Em período de teste', filtro: a => a.billing.status === 'trial' },
  vencendo: {
    label: 'Vence nos próximos 5 dias',
    filtro: a => {
      const f = a.billing.periodEnd || 0;
      return f > Date.now() && f - Date.now() <= 5 * 86400000;
    }
  },
  vencidos: {
    label: 'Vencidos',
    filtro: a => ['expired', 'canceled'].includes(a.billing.status) ||
      (a.billing.periodEnd && a.billing.periodEnd < Date.now())
  },
  semPlano: { label: 'Sem plano contratado', filtro: a => !a.billing.planId }
};

function publicoDe(chave) {
  const p = PUBLICOS[chave] || PUBLICOS.todos;
  return db.get().accounts.filter(a => !a.isAdmin).filter(p.filtro);
}

// ---------------------------------------------------------------------------
// VARIÁVEIS
//
// O que a mensagem consegue dizer sobre o destinatário. Sem isto, cobrança vira
// texto genérico e o cliente não sabe do que se trata.
// ---------------------------------------------------------------------------
function variaveis(acc) {
  const plano = db.get().plans.find(p => p.id === acc.billing.planId);
  const fim = acc.billing.periodEnd || 0;
  const dias = fim ? Math.ceil((fim - Date.now()) / 86400000) : 0;
  const brl = c => (Number(c) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  return {
    nome: acc.name || '',
    email: acc.email || '',
    plano: plano ? plano.name : 'nenhum',
    valor: plano ? brl(plano.price) : brl(0),
    vencimento: require(`./datas`).data(fim, acc),
    dias: String(dias),
    saldo: brl(acc.wallet ? acc.wallet.balance : 0),
    link: ''   // preenchido no envio, com a origem da requisição
  };
}

function interpolar(texto, vars) {
  return String(texto || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

// ---------------------------------------------------------------------------
// TEMPLATES
// ---------------------------------------------------------------------------
const TIPOS = ['cobranca', 'aviso'];
const CANAIS = ['push', 'whatsapp', 'sms'];

function salvarTemplate(body) {
  const c = cfg();
  const id = String(body.id || '').trim();
  const t = {
    id: id || db.genId('mkt'),
    name: String(body.name || '').trim().slice(0, 80),
    kind: TIPOS.includes(body.kind) ? body.kind : 'aviso',
    channel: CANAIS.includes(body.channel) ? body.channel : 'push',
    title: String(body.title || '').trim().slice(0, 120),
    text: String(body.text || '').trim().slice(0, 1200),
    // WhatsApp fora da janela de 24h exige modelo aprovado pela Meta
    templateName: String(body.templateName || '').trim(),
    language: String(body.language || 'pt_BR').trim(),
    updatedAt: Date.now()
  };
  if (!t.name) throw erro('Dê um nome ao template');
  if (!t.text && !t.templateName) throw erro('Escreva a mensagem');

  const i = c.templates.findIndex(x => x.id === t.id);
  if (i >= 0) c.templates[i] = { ...c.templates[i], ...t };
  else { t.createdAt = Date.now(); c.templates.push(t); }
  db.save();
  return t;
}

function removerTemplate(id) {
  const c = cfg();
  const antes = c.templates.length;
  c.templates = c.templates.filter(t => t.id !== id);
  db.save();
  return antes !== c.templates.length;
}

// Prévia com o primeiro destinatário do público, para o admin ver o texto já
// preenchido antes de mandar para centenas de contas.
function previa(body) {
  const alvo = publicoDe(body.audience);
  const vars = alvo.length ? variaveis(alvo[0]) : {
    nome: 'Empresa Exemplo', email: 'cliente@exemplo.com', plano: 'Profissional',
    valor: 'R$ 197,00', vencimento: '31/12/2026', dias: '3', saldo: 'R$ 0,00', link: ''
  };
  return {
    total: alvo.length,
    exemplo: alvo.length ? alvo[0].name : 'Empresa Exemplo',
    title: interpolar(body.title, vars),
    text: interpolar(body.text, vars),
    amostra: alvo.slice(0, 5).map(a => ({ name: a.name, email: a.email, status: a.billing.status }))
  };
}

// ---------------------------------------------------------------------------
// DISPARO
//
// Sequencial de propósito: são dezenas ou centenas de contas, e o WhatsApp e o
// SMS têm limite de taxa. Nada aqui precisa ser rápido.
// ---------------------------------------------------------------------------
async function disparar(body, { origin, broadcast } = {}) {
  const canal = CANAIS.includes(body.channel) ? body.channel : 'push';
  const alvo = publicoDe(body.audience);
  if (!alvo.length) throw erro('Nenhuma conta no público escolhido');
  if (!String(body.text || '').trim() && !body.templateName) throw erro('Escreva a mensagem');

  const registro = {
    id: db.genId('mkc'),
    ts: Date.now(),
    channel: canal,
    audience: body.audience || 'todos',
    audienceLabel: (PUBLICOS[body.audience] || PUBLICOS.todos).label,
    title: body.title || '',
    text: body.text || '',
    total: alvo.length,
    ok: 0, falhas: 0,
    erros: []
  };

  for (const acc of alvo) {
    const vars = variaveis(acc);
    vars.link = (origin || '') + '/app/#/billing';
    const titulo = interpolar(body.title || 'Koonfy', vars);
    const texto = interpolar(body.text || '', vars);
    try {
      if (canal === 'push') await porPush(acc, titulo, texto);
      else if (canal === 'whatsapp') await porWhatsapp(acc, texto, body);
      else await porSms(acc, texto);
      registro.ok++;
    } catch (e) {
      registro.falhas++;
      if (registro.erros.length < 20) registro.erros.push({ conta: acc.name, erro: String(e.message || e).slice(0, 140) });
    }
  }

  const c = cfg();
  c.campaigns.unshift(registro);
  if (c.campaigns.length > 60) c.campaigns.length = 60;
  db.save();
  if (broadcast) broadcast('marketing', { id: registro.id });
  return registro;
}

async function porPush(acc, titulo, texto) {
  const push = require('./push');
  const pushNative = require('./pushnative');
  const inscritos = (acc.pushSubs || []).length + ((acc.devices || []).length);
  if (!inscritos) throw erro('sem aparelho inscrito em notificações');
  const payload = {
    title: titulo, body: texto, tag: 'mkt:' + Date.now(),
    data: { type: 'message', url: '/app/#/billing' }
  };
  await push.sendToAccount(acc, 'message', payload);
  try { await pushNative.sendToAccount(acc, 'message', payload); } catch {}
}

// O WhatsApp sai pela conexão da PLATAFORMA (conta do admin), não pela do
// cliente: quem está falando é o Koonfy.
async function porWhatsapp(acc, texto, body) {
  const wa = require('./whatsapp');
  const admin = db.findAdminAccount();
  const ch = (admin.channels || [])[0];
  if (!ch || !ch.wa || !ch.wa.connected) throw erro('a conexão de WhatsApp da plataforma não está ativa');
  // O cadastro já guarda em E.164, então aqui é só tirar o "+": a Meta quer
  // o número sem ele. Nada de adivinhar país a partir do tamanho.
  const numero = String(acc.profile && acc.profile.phone || '').replace(/\D/g, '');
  if (!numero) throw erro('a conta não informou WhatsApp no cadastro');
  const ctx = db.chanCtx(admin, ch);
  if (body.templateName) {
    await wa.sendTemplate(ctx, numero, body.templateName, body.language || 'pt_BR', []);
  } else {
    await wa.sendText(ctx, numero, texto);
  }
}

async function porSms(acc, texto) {
  const sms = require('./sms');
  const destino = String(acc.profile && acc.profile.phone || '').replace(/\D/g, '');
  if (!destino) throw erro('a conta não informou WhatsApp no cadastro');
  // O crédito é da PLATAFORMA: o disparo é dela, não do cliente.
  await sms.enviarPlataforma(destino, texto);
}

// Visão do painel.
function adminView() {
  const c = cfg();
  const contas = db.get().accounts.filter(a => !a.isAdmin);
  return {
    templates: c.templates,
    campaigns: c.campaigns.slice(0, 20),
    publicos: Object.entries(PUBLICOS).map(([key, p]) => ({
      key, label: p.label, total: contas.filter(p.filtro).length
    })),
    canais: {
      push: true,
      whatsapp: !!((db.findAdminAccount().channels || [])[0] || {}).wa?.connected,
      sms: require('./sms').configured()
    },
    variaveis: ['nome', 'email', 'plano', 'valor', 'vencimento', 'dias', 'saldo', 'link']
  };
}

module.exports = {
  cfg, PUBLICOS, publicoDe, variaveis, interpolar,
  salvarTemplate, removerTemplate, previa, disparar, adminView
};
