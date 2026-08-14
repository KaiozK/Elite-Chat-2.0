// API interna do Koonfy (consumida pelo painel em /public/app)
// Multi-conta: cada cliente (account) tem seu próprio WhatsApp conectado via Embedded Signup.
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const datas = require('./datas');
const hosts = require('./hosts');
const ia = require('./ia');
const wa = require('./whatsapp');
const meta = require('./meta');
const store = require('./store');
const session = require('./session');
const survey = require('./survey');
const consent = require('./consent');
const geo = require('./geo');
const agents = require('./agents');
const schedule = require('./schedule');
const push = require('./push');
const pushNative = require('./pushnative');
const sms = require('./sms');
const topup = require('./topup');
const marketing = require('./marketing');
const paises = require('./paises');
const mailer = require('./mailer');
const account = require('./account');

module.exports = function (broadcast, clients) {
  const router = express.Router();

  const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    const code = e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(code).json({ error: e.message || 'Erro interno', meta: e.meta });
  });

  function auth(req, res, next) {
    // Registra a URL pública da instalação (usada no link do checkout /pay/:id)
    // Vazio quando a requisicao chegou pelo host do PAINEL: gravar o
    // subdominio aqui faria todo link de pagamento sair apontando para ele.
    try { const o = hosts.origemPublica(req); if (o) require('./elitepay').noteBaseUrl(o); } catch {}
    const token = ((req.get('authorization') || '').replace(/^Bearer\s+/i, '')) || req.query.token;
    const sess = token && db.get().sessions[token];
    if (!sess) return res.status(401).json({ error: 'Não autenticado' });
    const acc = db.findAccount(sess.accountId);
    if (!acc) {
      delete db.get().sessions[token];
      db.save();
      return res.status(401).json({ error: 'Sessão inválida' });
    }
    // ATENDENTE: a sessão carrega agentId. Sem agentId = dono da conta / admin
    // da plataforma (acesso total, nunca barrado por permissão).
    let agent = null;
    if (sess.agentId) {
      agent = agents.findAgent(acc, sess.agentId);
      if (!agent || !agent.active) {
        delete db.get().sessions[token];
        db.save();
        return res.status(401).json({ error: 'Atendente desativado. Fale com o administrador' });
      }
      agent.lastSeenAt = Date.now();      // heartbeat de presença a cada requisição
      if (agent.status === 'offline') agent.status = 'online';
    }
    req.token = token;
    req.session = sess;
    req.acc = acc;
    req.agent = agent;

    // Bloqueio por falta de assinatura. Vem aqui, e não em cada rota, para
    // que uma rota nova nasça fechada em vez de aberta.
    if (precisaAssinar(req)) {
      const caminho = req.path || '';
      const liberado = LIVRE_SEM_PLANO.some(p => caminho === p || caminho.startsWith(p + '/'));
      if (!liberado) {
        return res.status(402).json({
          error: 'Escolha um plano para começar a usar o Koonfy.',
          code: 'plan_required'
        });
      }
    }
    req.who = { agentId: agent ? agent.id : null, name: agent ? agent.name : (sess.user || acc.name) };
    // ---- CANAL ativo desta requisição ----
    // Cada conexão WhatsApp é um canal com conversas e contatos próprios. O
    // painel manda o canal escolhido no header `x-channel` (ou ?ch=).
    // `req.wctx` é a conta vista por esse canal — é o que vai para src/whatsapp.js.
    req.ch = db.findChannel(acc, req.get('x-channel') || req.query.ch || '');
    req.chId = req.ch ? req.ch.id : '';
    req.wctx = db.chanCtx(acc, req.ch);
    next();
  }

  const adminOnly = (req, res, next) =>
    req.session.kind === 'admin' ? next() : res.status(403).json({ error: 'Apenas o administrador da plataforma' });

  // GUARD DE DONO — dinheiro da conta (assinatura, carteira, saque) é do titular.
  // O menu já esconde essas telas do atendente, mas esconder não é proteger: sem
  // esta guarda um atendente autenticado chamava as rotas na mão e conseguia
  // cancelar a assinatura, ver o saldo e pedir saque para a própria chave Pix.
  // ---------------------------------------------------------------------------
  // ASSINATURA OBRIGATÓRIA
  //
  // Sem plano ativo, a conta só alcança o que precisa para ASSINAR (planos,
  // pagamento, carteira), para SAIR ou para cuidar da própria conta (senha,
  // e-mail). Todo o resto responde 402 e a tela leva para Assinatura.
  //
  // A lista é de PREFIXOS liberados: o que não estiver aqui fica fechado. É o
  // oposto de marcar rota a rota, onde a rota esquecida vira o furo.
  // ---------------------------------------------------------------------------
  const LIVRE_SEM_PLANO = [
    '/me', '/logout', '/settings', '/account',
    '/billing', '/wallet', '/plans',
    '/push',            // notificação de cobrança precisa chegar
    '/events'           // o SSE avisa a tela quando o pagamento cai
  ];

  function planoAtivo(acc) {
    const b = acc.billing || {};
    return b.status === 'active' && (!b.periodEnd || b.periodEnd > Date.now());
  }

  // Precisa assinar para usar? Admin e conta interna nunca; atendente segue a
  // conta em que trabalha.
  function precisaAssinar(req) {
    if (!db.get().platform.billing.requirePlan) return false;
    if (req.session.kind === 'admin') return false;
    if (limits.isUnlimited(req.acc)) return false;
    return !planoAtivo(req.acc);
  }

  const ownerOnly = (req, res, next) =>
    req.agent
      ? res.status(403).json({ error: 'Assinatura e carteira são do titular da conta.', code: 'owner_only' })
      : next();

  // GUARD DE FUNCIONALIDADE DO PLANO — módulo desligado no plano responde 402.
  // O admin da plataforma nunca é barrado (precisa operar qualquer conta).
  const feat = key => (req, res, next) => {
    if (req.session.kind === 'admin') return next();
    const msg = limits.checkFeature(req.acc, key);
    if (!msg) return next();
    res.status(402).json({ error: msg, code: 'feature', feature: key });
  };

  // GUARD DE PERMISSÃO — valida no backend (o front só esconde o menu).
  // O dono da conta e o admin da plataforma passam sempre.
  const can = (moduleKey, action = 'view') => (req, res, next) => {
    if (agents.can(req.agent, moduleKey, action)) return next();
    const mod = agents.MODULES.find(m => m.key === moduleKey);
    res.status(403).json({
      error: `Você não tem permissão para ${{ view: 'visualizar', create: 'criar', edit: 'editar', delete: 'excluir' }[action]} em ${mod ? mod.label : moduleKey}.`,
      code: 'forbidden', module: moduleKey, action
    });
  };

  function newSession(kind, acc, agent) {
    const token = crypto.randomBytes(24).toString('hex');
    const sessions = db.get().sessions;
    sessions[token] = {
      kind, accountId: acc.id,
      agentId: agent ? agent.id : null,
      user: agent ? agent.name : (kind === 'admin' ? db.get().platform.adminUser : acc.email),
      createdAt: Date.now()
    };
    const keys = Object.keys(sessions);
    while (keys.length > 100) delete sessions[keys.shift()];
    db.save();
    return token;
  }

  // Dados públicos da conexão WhatsApp (nunca expõe tokens/código)
  function waPublic(acc) {
    const w = acc.wa;
    return {
      connected: w.connected,
      businessId: w.businessId,
      businessName: w.businessName || '',
      qualityRating: w.qualityRating || '',
      wabaId: w.wabaId,
      phoneNumberId: w.phoneNumberId,
      displayPhoneNumber: w.displayPhoneNumber,
      verifiedName: w.verifiedName,
      appSubscribed: w.appSubscribed,
      graphVersion: w.graphVersion || db.get().platform.graphVersion,
      connectedAt: w.connectedAt,
      updatedAt: w.updatedAt,
      lastHealth: w.lastHealth,
      hasToken: !!w.accessToken,
      profilePictureUrl: w.profilePictureUrl || ''
    };
  }

  // `stamp` = { agentId, agentName } — carimba quem enviou (métricas por atendente)
  function storeOutbound(acc, to, content, apiResp, stamp, chId) {
    const waId = store.normalizeWaId(to);
    const ch = chId || store.defChId(acc);
    const contact = store.upsertContact(acc, waId, undefined, undefined, ch);
    const id = (apiResp && apiResp.messages && apiResp.messages[0] && apiResp.messages[0].id) || db.genId('local');
    const msg = {
      id, waId, chId: ch, direction: 'out', timestamp: Date.now(), status: 'accepted',
      ...(stamp ? { agentId: stamp.agentId || null, agentName: stamp.agentName || null } : {}),
      ...content
    };
    store.addMessage(acc, msg);
    contact.lastMessageAt = msg.timestamp;
    db.save();
    broadcast('message', { accountId: acc.id, waId, chId: ch });
    return msg;
  }

  // ============ AUTENTICAÇÃO (admin da plataforma + contas de cliente) ============

  // Países do seletor de WhatsApp. Pública porque o cadastro acontece antes
  // de existir sessão.
  router.get('/public/countries', (req, res) => res.json({ countries: paises.opcoes() }));

  router.post('/register', h(async (req, res) => {
    const { name, email, pass, refCode } = req.body || {};
    const mail = String(email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Informe um e-mail válido' });
    if (!pass || pass.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    if (db.findAccountByEmail(mail)) return res.status(409).json({ error: 'Já existe uma conta com este e-mail' });
    const acc = db.newAccount({ name: String(name || '').trim() || mail, email: mail, pass });
    // Perfil da empresa: campos livres de escolha, saneados aqui porque vêm de
    // um formulário PÚBLICO. Nada disso muda permissão ou cobrança.
    const perfil = req.body.profile || {};
    for (const k of ['segment', 'size', 'goal']) {
      acc.profile[k] = String(perfil[k] || '').trim().slice(0, 60);
    }
    // WhatsApp em E.164: é o formato que a Meta e a Integra X exigem, e sem
    // ele a cobrança e a recuperação de venda não têm para onde ir.
    acc.profile.country = String(perfil.country || 'BR').toUpperCase().slice(0, 2);
    if (String(perfil.phone || '').trim()) {
      const tel = paises.paraE164(acc.profile.country, perfil.phone);
      if (!tel.ok) return res.status(400).json({ error: tel.erro });
      acc.profile.phone = tel.e164;
    } else {
      acc.profile.phone = '';
    }
    acc.billing.periodEnd = Date.now() + (db.get().platform.billing.trialDays || 7) * 86400000;
    // afiliação: registra quem indicou (comissão na assinatura e nas renovações)
    const aff = db.findAccountByRefCode(refCode);
    if (aff) acc.affiliate.refBy = aff.affiliate.code;
    db.get().accounts.push(acc);
    db.save();

    // CONTA DE PAGAMENTOS JUNTO COM O CADASTRO
    //
    // Vem da última etapa do formulário e é opcional: sem os dados, ou com o
    // gateway fora do ar, a conta do Koonfy é criada do mesmo jeito e o cliente
    // termina isto depois pelo painel. Perder um cadastro porque um serviço de
    // terceiro piscou seria caro para o problema que resolve.
    const receb = req.body.recebimento || {};
    let pagamentos = null;
    // require inline: o `elitepay` do escopo só é vinculado mais abaixo, e
    // tocá-lo aqui cairia na zona morta do const.
    const pag = require('./elitepay');
    if (receb.document && receb.pixKey && pag.configured()) {
      try {
        const sub = await pag.registerSubaccount(acc, {
          name: acc.name, document: receb.document, email: acc.email,
          phone: acc.profile.phone || '', pixKey: receb.pixKey, pixKeyType: receb.pixKeyType,
          repName: '', repDocument: ''
        });
        db.save();
        // `registerSubaccount` grava a subconta aqui e ADIA a sincronização com
        // o gateway se ela falhar. Dizer só "ok" esconderia isso: o que volta é
        // o estado de verdade, para a tela não prometer o que não aconteceu.
        pagamentos = { criada: true, status: sub.status, sincronizada: !!sub.synced };
      } catch (e) {
        store.logEvent({ type: 'register_pagamentos_falhou', accountId: acc.id, error: e.message });
        pagamentos = { criada: false, erro: e.message };
      }
    }

    const token = newSession('account', acc);
    // já nasce trancado quando a assinatura é obrigatória: a tela leva direto
    // para a escolha do plano em vez de mostrar um app que não abre
    res.json({ token, user: acc.name, kind: 'account', accountId: acc.id, wa: waPublic(acc), pagamentos, planRequired: precisaAssinar({ session: { kind: 'account' }, acc }) });
  }));

  // Segundo passo do login: troca o ticket + código pelo token de acesso.
  router.post('/login/2fa', h(async (req, res) => {
    const b = req.body || {};
    const acc = account.resolverDesafio(b.ticket, b.code);
    const token = newSession('account', acc);
    agents.log(acc, { agentId: null, name: acc.name }, 'login', 'Entrou como dono da conta (2 etapas)');
    res.json({ token, user: acc.name, kind: 'account', accountId: acc.id, wa: waPublic(acc), permissions: null, planRequired: precisaAssinar({ session: { kind: 'account' }, acc }) });
  }));

  router.post('/login', h(async (req, res) => {
    const { user, pass } = req.body || {};
    const p = db.get().platform;
    // admin da plataforma
    // MIGRAÇÃO DE FORMATO: verifyPassword aceita o hash antigo (SHA-256) e o
    // novo (scrypt). Conferida a senha, o hash velho é regravado no formato
    // novo aqui mesmo, com a senha que acabou de ser digitada. Ninguém
    // precisa trocar de senha por causa disso.
    if (user === p.adminUser && db.verifyPassword(pass || '', p.adminPassHash)) {
      if (db.needsRehash(p.adminPassHash)) {
        const antigo = p.adminPassHash;
        p.adminPassHash = db.hashPassword(pass || '');
        for (const x of db.get().accounts) if (x.passHash === antigo) x.passHash = p.adminPassHash;
        db.save();
      }
      const acc = db.findAdminAccount();
      const token = newSession('admin', acc);
      return res.json({ token, user, kind: 'admin', accountId: acc.id, mustChangePassword: db.verifyPassword('admin', p.adminPassHash), wa: waPublic(acc) });
    }
    // conta de cliente (dono — login por e-mail)
    const acc = db.findAccountByEmail(user);
    if (acc && db.verifyPassword(pass || '', acc.passHash)) {
      if (db.needsRehash(acc.passHash)) { acc.passHash = db.hashPassword(pass || ''); db.save(); }
      // VERIFICAÇÃO EM DUAS ETAPAS: a senha conferiu, mas ainda não há sessão.
      // O ticket liga o segundo passo a este, sem deixar um token pela metade
      // circulando enquanto o código não chega.
      if (account.exigeDoisFatores(acc)) {
        const d = await account.abrirDesafio(acc);
        return res.json({ twoFactor: true, ticket: d.ticket, email: d.email });
      }
      const token = newSession('account', acc);
      agents.log(acc, { agentId: null, name: acc.name }, 'login', 'Entrou como dono da conta');
      return res.json({ token, user: acc.name, kind: 'account', accountId: acc.id, wa: waPublic(acc), permissions: null, planRequired: precisaAssinar({ session: { kind: 'account' }, acc }) });
    }

    // ATENDENTE (login por e-mail próprio)
    const found = agents.findAgentByEmail(user);
    if (found && found.agent.passHash && db.verifyPassword(pass || '', found.agent.passHash)) {
      if (db.needsRehash(found.agent.passHash)) { found.agent.passHash = db.hashPassword(pass || ''); db.save(); }
      const { acc: a, agent } = found;
      const token = newSession('agent', a, agent);
      agent.lastLoginAt = Date.now();
      agent.lastSeenAt = Date.now();
      agent.status = 'online';
      db.save();
      agents.log(a, { agentId: agent.id, name: agent.name }, 'login', `${agent.name} entrou no sistema`);
      broadcast('presence', { accountId: a.id, agentId: agent.id, status: 'online' });
      return res.json({
        token, user: agent.name, kind: 'agent', accountId: a.id,
        agent: agentPublic(agent),
        permissions: agent.permissions,
        allowedViews: agents.allowedViews(agent),
        mustChangePassword: !!agent.mustChangePassword,
        planRequired: precisaAssinar({ session: { kind: 'agent' }, acc: a }),
        wa: waPublic(a)
      });
    }

    res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }));

  // EXCLUSÃO DA CONTA (App Store, diretriz 5.1.1(v): quem cria conta no app
  // tem que conseguir apagá-la no app, não só por e-mail ou suporte).
  //
  // Apaga a conta inteira e tudo que pende dela — conversas, contatos, mensagens,
  // automações, agendamentos, atendentes — e derruba todas as sessões abertas,
  // inclusive as dos atendentes. É irreversível de propósito.
  //
  // Só o dono da conta pode: atendente não apaga a empresa em que trabalha e o
  // admin da plataforma não se autoexclui (deixaria o SaaS sem administrador).
  router.post('/account/delete', auth, (req, res) => {
    if (req.session.kind === 'admin') {
      return res.status(403).json({ error: 'A conta de administrador da plataforma não pode ser excluída por aqui' });
    }
    if (req.agent) {
      return res.status(403).json({ error: 'Somente o dono da conta pode excluí-la' });
    }
    const { pass, confirm } = req.body || {};
    if (!db.verifyPassword(String(pass || ''), req.acc.passHash)) {
      return res.status(401).json({ error: 'Senha incorreta' });
    }
    // Confirmação digitada — evita exclusão por toque acidental.
    if (String(confirm || '').trim().toUpperCase() !== 'EXCLUIR') {
      return res.status(400).json({ error: 'Digite EXCLUIR para confirmar' });
    }

    const d = db.get();
    const accId = req.acc.id;

    // Derruba toda sessão ligada a esta conta (dono e atendentes).
    for (const [tk, s] of Object.entries(d.sessions)) {
      if (s.accountId === accId) delete d.sessions[tk];
    }
    // O registro da conta guarda conversas, contatos, mensagens, flows,
    // agendamentos, atendentes e assinaturas de push — some tudo junto.
    d.accounts = d.accounts.filter(a => a.id !== accId);

    // Log operacional: guarda payloads de webhook com dados dos contatos do
    // cliente, então sai junto com a conta.
    d.webhookLog = d.webhookLog.filter(e => e.accountId !== accId);

    // `revenue` e `withdrawals` ficam: são registros financeiros da plataforma
    // (obrigação fiscal). Não têm dado pessoal além do accountId, que a partir
    // daqui não aponta mais para ninguém.
    db.save();

    res.json({ ok: true });
  });

  // Config pública da landing (sem auth) — copy do botão conforme dias de teste
  // Traduz os limites do plano em frases. -1 é ilimitado; 0 quer dizer que o
  // recurso não entra no plano, então nem vira linha.
  function limitesEmTexto(pl) {
    const L = pl.limits || {};
    // O terceiro item é a frase do ilimitado, escrita por extenso: concordar
    // gênero programaticamente daria "Campanhas ilimitados".
    const rotulos = [
      ['whatsapps', 'número de WhatsApp', 'números de WhatsApp', 'Números de WhatsApp ilimitados'],
      ['contacts', 'contato', 'contatos', 'Contatos ilimitados'],
      ['sends', 'envio por mês', 'envios por mês', 'Envios ilimitados'],
      ['campaigns', 'campanha', 'campanhas', 'Campanhas ilimitadas'],
      ['flows', 'automação', 'automações', 'Automações ilimitadas'],
      ['links', 'link rastreável', 'links rastreáveis', 'Links rastreáveis ilimitados'],
      ['pixels', 'pixel', 'pixels', 'Pixels ilimitados']
    ];
    const nm = n => n.toLocaleString('pt-BR');
    const linhas = [];
    for (const [chave, sing, plur, ilimitado] of rotulos) {
      const v = L[chave];
      if (v === undefined || v === 0) continue;
      linhas.push(v === -1 ? ilimitado : nm(v) + ' ' + (v === 1 ? sing : plur));
    }
    return linhas;
  }

  router.get('/public/landing', (req, res) => {
    const p = db.get().platform;
    const trialDays = p.billing.trialDays || 0;
    const ctaText = (p.landing && p.landing.ctaText || '').trim();
    // Os planos da landing eram escritos à mão no HTML e viviam desencontrados
    // dos que o cliente encontra ao assinar. Aqui saem os MESMOS que o painel
    // usa, sem os arquivados, para a página se montar a partir deles.
    const planos = db.get().plans
      .filter(pl => !pl.archived)
      .map(pl => ({
        id: pl.id, nome: pl.name, preco: pl.price, dias: pl.periodDays || 30,
        // Quando o plano não tem descrição escrita, os limites configurados
        // dizem o suficiente — e são dado de verdade, não texto de vitrine.
        itens: (pl.features && pl.features.length) ? pl.features : limitesEmTexto(pl)
      }));
    res.json({
      trialDays,
      ctaText: ctaText || (trialDays > 0 ? `Testar por ${trialDays} dias` : 'Começar agora'),
      planos
    });
  });

  router.post('/logout', auth, (req, res) => {
    if (req.agent) {
      req.agent.status = 'offline';
      req.agent.lastSeenAt = null;
      agents.log(req.acc, req.who, 'logout', `${req.agent.name} saiu do sistema`);
      broadcast('presence', { accountId: req.acc.id, agentId: req.agent.id, status: 'offline' });
    }
    delete db.get().sessions[req.token];
    db.save();
    res.json({ ok: true });
  });

  router.get('/me', auth, (req, res) => {
    const p = db.get().platform;
    const ag = req.agent;
    res.json({
      user: ag ? ag.name : (req.session.kind === 'admin' ? p.adminUser : req.acc.name),
      kind: req.session.kind,
      accountId: req.acc.id,
      email: ag ? ag.email : req.acc.email,
      agent: ag ? agentPublic(ag) : null,
      permissions: ag ? ag.permissions : null,          // null = acesso total (dono/admin)
      allowedViews: agents.allowedViews(ag),
      // O botão da IA no chat só existe se o agente estiver ligado na conta.
      iaLigada: ia.configurada(req.acc),
      mustChangePassword: ag ? !!ag.mustChangePassword
        : (req.session.kind === 'admin' && db.verifyPassword('admin', p.adminPassHash)),
      planRequired: precisaAssinar(req),   // trava a navegação até assinar
      wa: waPublic(req.wctx),
      // toggles do plano: o menu esconde o que o plano nao inclui (o backend
      // tambem recusa com 402, o front e so conforto)
      planFeatures: req.session.kind === 'admin' ? null : limits.featuresOf(req.acc)
    });
  });

  // ============ ATENDENTES, PERMISSÕES, PRESENÇA E LOGS ============

  // Nunca expõe o hash da senha
  function agentPublic(a, now = Date.now()) {
    const { passHash, ...rest } = a;
    return { ...rest, presence: agents.presenceOf(a, now), hasLogin: !!(a.email && a.passHash) };
  }

  router.get('/agents', auth, can('agents', 'view'), (req, res) => {
    const now = Date.now();
    res.json({
      agents: (req.acc.team || []).map(a => agentPublic(a, now)),
      modules: agents.MODULES,
      actions: agents.ACTIONS,
      statuses: agents.STATUSES,
      presets: Object.keys(agents.PRESETS),
      sectors: req.acc.sectors || []
    });
  });

  router.post('/agents', auth, feat('agents'), can('agents', 'create'), (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const email = String(b.email || '').toLowerCase().trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome do atendente' });
    if (email) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido' });
      if (db.findAccountByEmail(email)) return res.status(409).json({ error: 'Este e-mail já pertence a uma conta' });
      if (agents.findAgentByEmail(email)) return res.status(409).json({ error: 'Já existe um atendente com este e-mail' });
    }
    if (b.pass && String(b.pass).length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });

    const agent = agents.newAgent({
      name, email, pass: b.pass, role: b.role, phone: b.phone, photo: b.photo,
      preset: b.preset || 'atendente'
    });
    if (b.permissions) agent.permissions = sanitizePerms(b.permissions);
    if (b.sectorId) agent.sectorId = b.sectorId;
    req.acc.team.push(agent);
    db.save();
    agents.log(req.acc, req.who, 'agent_created', `Criou o atendente ${agent.name}`);
    res.json({ agent: agentPublic(agent) });
  });

  function sanitizePerms(p) {
    const out = agents.emptyPerms(false);
    for (const k of agents.MODULE_KEYS) {
      for (const a of agents.ACTIONS) {
        out[k][a] = !!(p && p[k] && p[k][a]);
      }
    }
    return out;
  }

  router.put('/agents/:id', auth, can('agents', 'edit'), (req, res) => {
    const a = agents.findAgent(req.acc, req.params.id);
    if (!a) return res.status(404).json({ error: 'Atendente não encontrado' });
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim();
    if (typeof b.role === 'string') a.role = b.role.trim() || 'Atendente';
    if (typeof b.phone === 'string') a.phone = b.phone.trim();
    if (typeof b.photo === 'string') a.photo = b.photo.slice(0, 400000); // dataURL
    if (typeof b.sectorId === 'string') a.sectorId = b.sectorId || null;
    if (typeof b.email === 'string') {
      const mail = b.email.toLowerCase().trim();
      if (mail && mail !== a.email) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'E-mail inválido' });
        const other = agents.findAgentByEmail(mail);
        if (other && other.agent.id !== a.id) return res.status(409).json({ error: 'Já existe um atendente com este e-mail' });
        if (db.findAccountByEmail(mail)) return res.status(409).json({ error: 'Este e-mail já pertence a uma conta' });
      }
      a.email = mail;
    }
    if (b.active !== undefined) {
      a.active = !!b.active;
      if (!a.active) {
        a.status = 'offline'; a.lastSeenAt = null;
        // derruba as sessões do atendente desativado
        const sess = db.get().sessions;
        for (const [tk, s] of Object.entries(sess)) if (s.agentId === a.id) delete sess[tk];
      }
    }
    if (b.permissions) a.permissions = sanitizePerms(b.permissions);
    if (b.preset && agents.PRESETS[b.preset]) a.permissions = agents.PRESETS[b.preset]();
    db.save();
    agents.log(req.acc, req.who, 'agent_updated', `Alterou o atendente ${a.name}`);
    res.json({ agent: agentPublic(a) });
  });

  // Redefinir senha
  router.post('/agents/:id/password', auth, can('agents', 'edit'), (req, res) => {
    const a = agents.findAgent(req.acc, req.params.id);
    if (!a) return res.status(404).json({ error: 'Atendente não encontrado' });
    const pass = String((req.body || {}).pass || '');
    if (pass.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    if (!a.email) return res.status(400).json({ error: 'Defina um e-mail para o atendente antes de criar a senha' });
    a.passHash = db.hashPassword(pass);
    a.mustChangePassword = true;
    db.save();
    agents.log(req.acc, req.who, 'agent_updated', `Redefiniu a senha de ${a.name}`);
    res.json({ ok: true });
  });

  // O próprio atendente troca a senha
  router.post('/agents/me/password', auth, (req, res) => {
    if (!req.agent) return res.status(400).json({ error: 'Apenas atendentes usam esta rota' });
    const { current, pass } = req.body || {};
    if (!db.verifyPassword(current || '', req.agent.passHash)) return res.status(401).json({ error: 'Senha atual incorreta' });
    if (String(pass || '').length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
    req.agent.passHash = db.hashPassword(pass);
    req.agent.mustChangePassword = false;
    db.save();
    res.json({ ok: true });
  });

  router.delete('/agents/:id', auth, can('agents', 'delete'), (req, res) => {
    const a = agents.findAgent(req.acc, req.params.id);
    if (!a) return res.status(404).json({ error: 'Atendente não encontrado' });
    req.acc.team = req.acc.team.filter(x => x.id !== a.id);
    delete req.acc.chatThreads['dm:' + a.id];
    // libera as conversas que estavam com ele
    for (const c of req.acc.contacts) if (c.assignedTo === a.id) { c.assignedTo = null; c.assignedAt = null; }
    const sess = db.get().sessions;
    for (const [tk, s] of Object.entries(sess)) if (s.agentId === a.id) delete sess[tk];
    db.save();
    agents.log(req.acc, req.who, 'agent_deleted', `Excluiu o atendente ${a.name}`);
    res.json({ ok: true });
  });

  // Presença (heartbeat + status manual)
  router.put('/agents/me/status', auth, (req, res) => {
    if (!req.agent) return res.json({ ok: true }); // dono não tem presença
    const st = String((req.body || {}).status || '');
    agents.touchPresence(req.acc, req.agent, st);
    broadcast('presence', { accountId: req.acc.id, agentId: req.agent.id, status: agents.presenceOf(req.agent) });
    res.json({ status: agents.presenceOf(req.agent) });
  });

  // Desempenho (página de métricas + ranking do dashboard)
  router.get('/agents/performance', auth, can('agents', 'view'), (req, res) => {
    const now = Date.now();
    const rank = agents.ranking(req.acc, now);
    const online = (req.acc.team || []).filter(a => agents.presenceOf(a, now) !== 'offline').length;
    res.json({
      ranking: rank,
      online,
      offline: (req.acc.team || []).filter(a => a.active).length - online,
      overall: agents.metricsOf(req.acc, null, now)
    });
  });

  // Logs de ações — filtros por atendente, período e tipo
  router.get('/agents/logs', auth, can('agents', 'view'), (req, res) => {
    const { agentId, action, from, to } = req.query;
    let list = req.acc.logs || [];
    if (agentId) list = list.filter(l => (l.agentId || '') === agentId);
    if (action) list = list.filter(l => l.action === action);
    if (from) list = list.filter(l => l.ts >= Number(from));
    if (to) list = list.filter(l => l.ts <= Number(to));
    res.json({
      logs: list.slice(0, 300),
      total: list.length,
      actions: agents.LOG_ACTIONS,
      agents: (req.acc.team || []).map(a => ({ id: a.id, name: a.name }))
    });
  });

  // ============ EMBEDDED SIGNUP (Conectar WhatsApp) ============

  // Config pública para o front montar o popup/SDK
  router.get('/wa/config', auth, (req, res) => {
    const p = db.get().platform;
    res.json({
      appId: p.appId,
      configId: p.configId,
      graphVersion: p.graphVersion || 'v26.0',
      redirectPath: '/auth/meta/callback',
      ready: !!(p.appId && p.appSecret)
    });
  });

  // ---------------------------------------------------------------------------
  // DIAGNÓSTICO DO APP DA META
  //
  // "Falha ao acessar sua conta através deste aplicativo" é a mesma mensagem
  // para causas bem diferentes: app em modo de desenvolvimento, App Secret que
  // não casa com o App ID, Config ID de outro app, domínio não liberado. A
  // Meta não diz qual é, e o admin fica adivinhando.
  //
  // Este teste pergunta à Graph API o que ela sabe do app, usando o token de
  // aplicativo (app_id|app_secret), e devolve cada achado em português.
  // ---------------------------------------------------------------------------
  router.get('/admin/meta/diag', auth, adminOnly, h(async (req, res) => {
    const p = db.get().platform;
    const v = p.graphVersion || 'v26.0';
    const achados = [];
    const add = (nivel, texto) => achados.push({ nivel, texto });

    if (!p.appId) add('erro', 'App ID em branco. Copie do painel do app da Meta, em Configurações → Básico.');
    if (!p.appSecret) add('erro', 'App Secret em branco. Fica ao lado do App ID, em Configurações → Básico.');
    if (!p.appId || !p.appSecret) return res.json({ ok: false, achados });

    // O token de aplicativo só funciona se os DOIS baterem: é o jeito mais
    // direto de saber se o segredo é mesmo daquele App ID.
    const appToken = p.appId + '|' + p.appSecret;
    let app = null;
    try {
      const r = await fetch('https://graph.facebook.com/' + v + '/' + p.appId +
        '?fields=id,name,link,app_type&access_token=' + encodeURIComponent(appToken));
      app = await r.json();
      if (app.error) {
        add('erro', 'A Meta recusou App ID + App Secret: ' + (app.error.message || '') +
          '. Confira se os dois são do MESMO app e se o segredo foi copiado inteiro.');
        return res.json({ ok: false, achados });
      }
    } catch (e) {
      add('erro', 'Não foi possível falar com a Graph API: ' + e.message);
      return res.json({ ok: false, achados });
    }
    add('ok', 'App reconhecido pela Meta: ' + (app.name || p.appId) + '.');
    // Usada nas checagens de webhook e nas orientações do fim.
    const origem = req.protocol + '://' + req.get('host');

    if (!p.configId) {
      add('erro', 'Config ID em branco. Sem ele o Embedded Signup não abre: crie a configuração em Login do Facebook para Empresas → Configurações e cole o ID aqui.');
    } else if (!/^\d{10,}$/.test(String(p.configId).trim())) {
      add('erro', 'O Config ID deveria ser só números (15 a 17 dígitos). Copie o valor de ' +
        'Login do Facebook para Empresas → Configurações, sem espaços.');
    } else {
      // NÃO dá para validar o Config ID pela Graph API: ele não é um objeto
      // legível. Um GET nele responde "does not exist" mesmo quando o ID está
      // certo — foi o que esta tela chegou a acusar como erro, apontando para o
      // lugar errado. O ID só é exercitado pelo FB.login, no navegador.
      add('info', 'Config ID preenchido. A Meta não permite conferi-lo por aqui: ' +
        'ele só é validado quando o Embedded Signup abre no navegador.');
    }

    // ---- O que REALMENTE derruba o recebimento de mensagens ----
    // Duas pontas precisam estar ligadas, e elas são independentes:
    //   1. o APP precisa ter o webhook cadastrado e ativo;
    //   2. cada WABA precisa estar ASSINADA por esse app.
    // A segunda é a que passa despercebida: com o app perfeitamente
    // configurado e a WABA sem assinar, a Meta simplesmente não manda nada.
    try {
      const r = await fetch('https://graph.facebook.com/' + v + '/' + p.appId +
        '/subscriptions?access_token=' + encodeURIComponent(appToken));
      const subs = await r.json();
      const wa = (subs.data || []).find(s => s.object === 'whatsapp_business_account');
      if (!wa) {
        add('erro', 'O app não tem webhook de WhatsApp cadastrado. Em Webhooks, assine o objeto ' +
          'whatsapp_business_account com a URL ' + origem + '/webhook e o Verify Token do painel.');
      } else if (!wa.active) {
        add('erro', 'O webhook do app está cadastrado mas INATIVO. Reative em Webhooks.');
      } else {
        const campos = (wa.fields || []).map(f => f.name);
        add('ok', 'Webhook do app ativo em ' + wa.callback_url + '.');
        if (!campos.includes('messages')) {
          add('erro', 'O webhook não assina o campo "messages" — é ele que entrega as mensagens ' +
            'recebidas. Marque em Webhooks → whatsapp_business_account.');
        }
        if (wa.callback_url && wa.callback_url.replace(/\/+$/, '') !== (origem + '/webhook')) {
          add('aviso', 'O webhook aponta para ' + wa.callback_url + ', e este servidor responde em ' +
            origem + '/webhook. Se não forem o mesmo endereço, as mensagens chegam em outro lugar.');
        }
      }
    } catch (e) {
      add('aviso', 'Não deu para ler os webhooks do app: ' + e.message);
    }

    // Cada WABA conectada: está assinada por este app?
    const wabas = [];
    for (const acc of db.get().accounts) {
      for (const ch of (acc.channels || [])) {
        const w = ch.wa || {};
        const tk = w.accessToken || p.systemToken;
        if (w.wabaId && tk) wabas.push({ conta: acc.name, canal: ch.label, wabaId: w.wabaId, token: tk });
      }
    }
    for (const x of wabas) {
      try {
        const r = await fetch('https://graph.facebook.com/' + v + '/' + x.wabaId +
          '/subscribed_apps?access_token=' + encodeURIComponent(x.token));
        const j = await r.json();
        if (j.error) { add('aviso', 'WABA ' + x.wabaId + ': ' + j.error.message); continue; }
        if (!(j.data || []).length) {
          add('erro', 'A WABA ' + x.wabaId + ' (' + x.conta + ' · ' + x.canal + ') NÃO está assinada por ' +
            'nenhum app. É por isso que não chega webhook: a Meta só entrega evento de WABA assinada. ' +
            'Resolva com o botão "Assinar app na WABA", em Configurações → Conexão & API.');
        } else {
          add('ok', 'WABA ' + x.wabaId + ' assinada pelo app (' + x.conta + ' · ' + x.canal + ').');
        }
      } catch (e) {
        add('aviso', 'Não deu para conferir a WABA ' + x.wabaId + ': ' + e.message);
      }
    }

    // O que a Meta NÃO conta pela API, e que responde pela maioria dos casos.
    add('info', 'Se o app estiver em MODO DE DESENVOLVIMENTO, só quem está em Funções do app (administrador, desenvolvedor ou testador) consegue conectar. É a causa mais comum desta falha.');
    add('info', 'Em Login do Facebook → Configurações, o campo URIs de redirecionamento OAuth válidos precisa conter: ' + origem + '/auth/meta/callback');
    add('info', 'Em Configurações → Básico, o Domínio do app precisa conter: ' + req.get('host'));

    res.json({ ok: !achados.some(x => x.nivel === 'erro'), app: { name: app.name, id: app.id }, achados });
  }));

  // Fluxo completo pós-popup: code -> token -> business -> WABA -> número -> subscribe -> teste
  router.post('/wa/connect', auth, h(async (req, res) => {
    const acc = req.acc;
    const { code, redirectUri, sessionInfo } = req.body || {};
    if (!code) return res.status(400).json({ error: 'authorization_code ausente' });

    const steps = [];
    const step = (name, ok, detail) => steps.push({ name, ok, detail: detail || null });
    const w = acc.wa;
    w.authorizationCode = code;
    w.callbackUrl = redirectUri || '';
    w.updatedAt = Date.now();
    db.save();

    try {
      // 3. troca do authorization_code pelo access token
      const tok = await meta.exchangeCode(code, redirectUri);
      w.accessToken = tok.access_token;
      w.tokenType = tok.token_type || 'bearer';
      db.save();
      step('access_token', true);

      // 4. businesses
      let businessId = '';
      try {
        const biz = await meta.getBusinesses(w.accessToken);
        businessId = (biz.data && biz.data[0] && biz.data[0].id) || '';
        step('business', !!businessId, businessId || 'nenhum business retornado');
      } catch (e) {
        step('business', false, e.message);
      }
      w.businessId = businessId;
      db.save();

      // 5. WABA — descoberta oficial; sessionInfo do popup serve de desempate
      let wabaId = '';
      if (businessId) {
        try {
          const wabas = await meta.getOwnedWabas(w.accessToken, businessId);
          const list = wabas.data || [];
          const hint = sessionInfo && sessionInfo.waba_id;
          wabaId = (hint && list.some(x => x.id === String(hint))) ? String(hint) : ((list[0] && list[0].id) || '');
        } catch (e) {
          step('waba_lookup', false, e.message);
        }
      }
      if (!wabaId && sessionInfo && sessionInfo.waba_id) wabaId = String(sessionInfo.waba_id);
      if (!wabaId) {
        const e = new Error('Nenhuma WhatsApp Business Account encontrada para esta conta Meta');
        e.status = 422;
        throw e;
      }
      w.wabaId = wabaId;
      db.save();
      step('waba', true, wabaId);

      // 6. phone numbers
      const phones = await meta.getPhoneNumbers(w.accessToken, wabaId);
      const plist = phones.data || [];
      const phint = sessionInfo && sessionInfo.phone_number_id;
      const phone = (phint && plist.find(x => x.id === String(phint))) || plist[0];
      if (!phone) {
        const e = new Error('Nenhum número de telefone encontrado na WABA');
        e.status = 422;
        throw e;
      }
      w.phoneNumberId = phone.id;
      w.displayPhoneNumber = phone.display_phone_number || '';
      w.verifiedName = phone.verified_name || '';
      db.save();
      step('phone', true, `${w.displayPhoneNumber} (${w.verifiedName})`.trim());

      // 7. assina o app na WABA (webhooks passam a chegar para este cliente)
      try {
        const sub = await meta.subscribeApp(w.accessToken, wabaId);
        w.appSubscribed = !!sub.success;
        step('subscribed_apps', w.appSubscribed);
      } catch (e) {
        w.appSubscribed = false;
        step('subscribed_apps', false, e.message);
      }

      // validação do token (system user id do cliente)
      try {
        const dbg = await meta.debugToken(w.accessToken);
        w.systemUserId = String((dbg.data && (dbg.data.user_id || dbg.data.profile_id)) || '');
      } catch {}

      // 11. teste de conexão (health check no número)
      try {
        const health = await meta.phoneHealth(w.accessToken, w.phoneNumberId);
        w.lastHealth = { at: Date.now(), ...health };
        step('health', true, health.display_phone_number);
      } catch (e) {
        step('health', false, e.message);
      }

      // 10/12. persiste tudo e marca como conectado
      w.graphVersion = db.get().platform.graphVersion || 'v26.0';
      w.connected = true;
      w.connectedAt = w.connectedAt || Date.now();
      w.updatedAt = Date.now();
      db.save();
      store.logEvent({ type: 'embedded_signup', ok: true, accountId: acc.id, wabaId: w.wabaId, phoneNumberId: w.phoneNumberId });
      broadcast('wa_status', { accountId: acc.id, connected: true });
      res.json({ ok: true, connected: true, steps, wa: waPublic(acc) });
    } catch (e) {
      w.connected = false;
      w.updatedAt = Date.now();
      db.save();
      store.logEvent({ type: 'embedded_signup', ok: false, accountId: acc.id, error: e.message });
      e.meta = { ...(e.meta || {}), steps };
      throw e;
    }
  }));

  router.get('/wa/status', auth, h(async (req, res) => {
    let health = null;
    if (req.query.health === '1' && req.wctx.wa.connected) {
      const w = req.wctx.wa;
      try {
        health = await wa.getPhoneInfo(req.wctx);
        w.lastHealth = { at: Date.now(), ...health };
        // aproveita a resposta para manter número e nome em dia
        if (health.display_phone_number) w.displayPhoneNumber = health.display_phone_number;
        if (health.verified_name) w.verifiedName = health.verified_name;
        if (health.quality_rating) w.qualityRating = health.quality_rating;
        w.identityAt = Date.now();
        db.save();
      } catch (e) {
        health = { error: e.message };
      }

      // A tela mostrava "-" em Business ID e "Não" em Webhook assinado mesmo
      // com o número funcionando: esses dois campos só eram preenchidos pelo
      // Embedded Signup, e ficavam parados para sempre em quem conectou por
      // outro caminho. Agora esta consulta reconcilia os dois com a Meta —
      // é a fonte da verdade, e não o que ficou gravado aqui.
      if (w.wabaId) {
        try {
          const info = await wa.getWaba(req.wctx);
          const dono = info && info.owner_business_info;
          if (dono && dono.id) { w.businessId = String(dono.id); w.businessName = String(dono.name || ''); }
          db.save();
        } catch (e) { /* não impede o resto do health */ }
        try {
          const subs = await wa.getSubscriptions(req.wctx);
          w.appSubscribed = !!((subs && subs.data) || []).length;
          db.save();
        } catch (e) { /* idem */ }
      }
      // Quem conectou antes de este campo existir ficava com "Conectado em: -"
      // para sempre. A primeira consulta bem-sucedida serve de data.
      if (!w.connectedAt && w.connected) { w.connectedAt = Date.now(); db.save(); }
    }
    res.json({ wa: waPublic(req.wctx), health });
  }));

  router.post('/wa/disconnect', auth, h(async (req, res) => {
    const w = req.wctx.wa;
    try {
      if (w.wabaId && w.accessToken) await meta.unsubscribeApp(w.accessToken, w.wabaId);
    } catch {}
    Object.assign(w, db.emptyWa(), { updatedAt: Date.now() });
    db.save();
    broadcast('wa_status', { accountId: req.acc.id, connected: false });
    res.json({ ok: true, wa: waPublic(req.wctx) });
  }));

  // ============ CANAIS (conexões WhatsApp) ============
  // Cada canal é um número conectado, com conversas e contatos próprios.
  // O plano define quantos vêm inclusos; acima disso o cliente compra extras.
  const limits = require('./limits');

  function channelPublic(acc, ch) {
    const w = ch.wa || {};
    const dflt = (acc.channels[0] || {}).id;
    return {
      id: ch.id, label: ch.label, isDefault: ch.id === dflt, createdAt: ch.createdAt,
      connected: !!w.connected,
      phoneNumberId: w.phoneNumberId || '',
      displayPhoneNumber: w.displayPhoneNumber || '',
      verifiedName: w.verifiedName || '',
      profilePictureUrl: w.profilePictureUrl || '',
      qualityRating: w.qualityRating || '',
      identityError: w.identityError || '',
      unread: acc.contacts.filter(c => (c.chId || dflt) === ch.id).reduce((s, c) => s + (c.unread || 0), 0),
      contacts: acc.contacts.filter(c => (c.chId || dflt) === ch.id).length,
      // cancelamento agendado: a conexão segue ativa até `cancelAt`
      canceledAt: ch.canceledAt || 0,
      cancelAt: ch.cancelAt || 0
    };
  }

  // SINCRONIA DA IDENTIDADE DO NÚMERO
  // O Embedded Signup grava display_phone_number/verified_name, mas quem conecta
  // por credenciais manuais (token + phoneNumberId) fica sem esses campos, e a
  // tela dizia "não conectado" para um número que estava funcionando.
  // Aqui buscamos na Graph e gravamos, com cache de 6h para não pesar.
  async function syncPhoneIdentity(acc, ch, { force } = {}) {
    const w = ch.wa;
    if (!w || !w.phoneNumberId || !wa.tokenOf(db.chanCtx(acc, ch))) return false;
    const fresco = w.identityAt && (Date.now() - w.identityAt) < 6 * 3600 * 1000;
    if (!force && w.displayPhoneNumber && fresco) return false;
    try {
      const info = await wa.getPhoneInfo(db.chanCtx(acc, ch));
      if (info && (info.display_phone_number || info.verified_name)) {
        w.displayPhoneNumber = info.display_phone_number || w.displayPhoneNumber || '';
        w.verifiedName = info.verified_name || w.verifiedName || '';
        w.qualityRating = info.quality_rating || w.qualityRating || '';
        w.connected = true;                 // a Graph respondeu: o número existe e o token vale
        w.identityAt = Date.now();
        db.save();
        return true;
      }
    } catch (e) {
      // token revogado/numero removido: registra e marca como desconectado
      w.identityError = String(e.message || e).slice(0, 160);
      w.identityAt = Date.now();
      if (/OAuth|token|permission|(#10)|190/i.test(w.identityError)) w.connected = false;
      db.save();
    }
    return false;
  }

  router.get('/channels', auth, h(async (req, res) => {
    const acc = req.acc;
    // completa a identidade dos números conectados que ainda não têm o telefone
    // (conexão manual). Falha aqui nunca derruba a listagem.
    await Promise.all(acc.channels.filter(c => !c.archived && c.wa.connected && !c.wa.displayPhoneNumber)
      .map(c => syncPhoneIdentity(acc, c).catch(() => false)));
    const rep = limits.report(acc);
    res.json({
      channels: acc.channels.filter(c => !c.archived).map(c => channelPublic(acc, c)),
      current: req.chId,
      limit: rep.whatsapps
    });
  }));

  // Força a re-sincronização da identidade (botão "Sincronizar" na aba Contas)
  router.post('/channels/:id/sync', auth, h(async (req, res) => {
    const ch = (req.acc.channels || []).find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'Canal não encontrado' });
    await syncPhoneIdentity(req.acc, ch, { force: true });
    res.json({ channel: channelPublic(req.acc, ch), error: ch.wa.identityError || '' });
  }));

  router.post('/channels', auth, h(async (req, res) => {
    const acc = req.acc;
    limits.enforce(acc, 'whatsapps', 1);      // 402 quando estoura o plano + extras
    const label = String((req.body || {}).label || '').trim() || `WhatsApp ${acc.channels.length + 1}`;
    const ch = db.emptyChannel(label.slice(0, 40));
    acc.channels.push(ch);
    db.save();
    agents.log(acc, req.who, 'channel_create', `Criou o canal ${ch.label}`);
    res.json({ channel: channelPublic(acc, ch) });
  }));

  router.put('/channels/:id', auth, (req, res) => {
    const ch = (req.acc.channels || []).find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'Canal não encontrado' });
    const label = String((req.body || {}).label || '').trim();
    if (label) ch.label = label.slice(0, 40);
    db.save();
    res.json({ channel: channelPublic(req.acc, ch) });
  });

  router.delete('/channels/:id', auth, h(async (req, res) => {
    const acc = req.acc;
    const idx = acc.channels.findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Canal não encontrado' });
    if (idx === 0) return res.status(400).json({ error: 'O canal principal não pode ser removido' });
    const ch = acc.channels[idx];
    // desconecta o número na Meta antes de sumir com o canal
    try {
      const w = ch.wa || {};
      if (w.wabaId && w.accessToken) await meta.unsubscribeApp(w.accessToken, w.wabaId);
    } catch {}
    // as conversas do canal ficam preservadas no histórico, apenas arquivadas
    acc.channels.splice(idx, 1);
    db.save();
    agents.log(acc, req.who, 'channel_delete', `Removeu o canal ${ch.label}`);
    res.json({ ok: true });
  }));

  // ---- Cancelar uma conexão EXTRA ----
  // Não desliga na hora: o ciclo já foi pago, então a conexão segue ativa até o
  // vencimento. Na virada, o canal é APAGADO com tudo que é dele (conversas,
  // contatos, funil, agendamentos) e a unidade sai da cobrança. Sem volta.
  router.post('/channels/:id/cancel', auth, ownerOnly, (req, res) => {
    const acc = req.acc;
    const idx = (acc.channels || []).findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Conexão não encontrada' });
    if (idx === 0) return res.status(400).json({ error: 'A conexão principal do plano não pode ser cancelada' });
    const ch = acc.channels[idx];
    if (ch.cancelAt) return res.json({ channel: channelPublic(acc, ch) });
    saas.agendarCancelamento(acc, ch);
    agents.log(acc, req.who, 'channel_cancel', `Cancelou a conexão ${ch.label}`);
    res.json({ channel: channelPublic(acc, ch) });
  });

  // Voltar atrás enquanto a data não chegou.
  router.post('/channels/:id/cancel/undo', auth, ownerOnly, (req, res) => {
    const ch = (req.acc.channels || []).find(c => c.id === req.params.id);
    if (!ch) return res.status(404).json({ error: 'Conexão não encontrada' });
    saas.desfazerCancelamento(req.acc, ch);
    agents.log(req.acc, req.who, 'channel_cancel_undo', `Reativou a conexão ${ch.label}`);
    res.json({ channel: channelPublic(req.acc, ch) });
  });

  // O que some junto com a conexão — a tela mostra isso ANTES de confirmar.
  router.get('/channels/:id/cancel/preview', auth, ownerOnly, (req, res) => {
    const acc = req.acc;
    const idx = (acc.channels || []).findIndex(c => c.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Conexão não encontrada' });
    if (idx === 0) return res.status(400).json({ error: 'A conexão principal do plano não pode ser cancelada' });
    const padrao = store.defChId(acc);
    const doCanal = o => (o.chId || padrao) === req.params.id;
    const contatos = (acc.contacts || []).filter(doCanal);
    const waIds = new Set(contatos.map(c => c.waId));
    res.json({
      label: acc.channels[idx].label,
      until: Math.max(Date.now(), Number(acc.billing.periodEnd) || 0),
      apaga: {
        contacts: contatos.length,
        messages: (acc.messages || []).filter(doCanal).length,
        campaigns: (acc.campaigns || []).filter(doCanal).length,
        schedules: (acc.schedules || []).filter(e => e.contactWaId && waIds.has(e.contactWaId)).length
      }
    });
  });

  // ============ SMS (Integra X) ============
  // A funcionalidade só existe quando o admin liga na plataforma E o plano do
  // cliente inclui o módulo. `feat('sms')` cuida da segunda parte.
  // ============ AGENTE DE IA ============
  // A chave da OpenAI é do cliente e nunca volta inteira para a tela: o painel
  // recebe só se existe e os últimos caracteres, como já é feito com os
  // segredos da Meta e do gateway.
  router.get('/ia', auth, can('agents'), (req, res) => {
    const c = ia.ensure(req.acc);
    res.json({
      config: {
        enabled: c.enabled, model: c.model, prompt: c.prompt, channels: c.channels,
        historico: c.historico, maxSaida: c.maxSaida, assinatura: c.assinatura,
        temChave: !!c.apiKey, chaveFim: c.apiKey ? c.apiKey.slice(-4) : ''
      },
      modelos: ia.MODELOS,
      canais: (req.acc.channels || []).filter(ch => !ch.archived)
        .map(ch => ({ id: ch.id, label: ch.label, numero: (ch.wa && ch.wa.displayPhoneNumber) || '' })),
      logs: c.logs.slice(0, 30)
    });
  });

  router.put('/ia', auth, can('agents', 'edit'), (req, res) => {
    const c = ia.ensure(req.acc);
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
    // Chave em branco não apaga a que está salva — senão bastaria abrir a tela
    // e salvar outro campo para derrubar a integração.
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKey = b.apiKey.trim().slice(0, 200);
    if (b.apiKey === null) c.apiKey = '';
    if (typeof b.model === 'string' && ia.MODELOS.some(([v]) => v === b.model)) c.model = b.model;
    if (typeof b.prompt === 'string') c.prompt = b.prompt.slice(0, 8000);
    if (Array.isArray(b.channels)) {
      const validos = new Set((req.acc.channels || []).map(ch => ch.id));
      c.channels = b.channels.filter(x => validos.has(x));
    }
    if (b.historico !== undefined) c.historico = Math.max(2, Math.min(40, Number(b.historico) || 12));
    if (b.maxSaida !== undefined) c.maxSaida = Math.max(120, Math.min(2000, Number(b.maxSaida) || 600));
    if (typeof b.assinatura === 'string') c.assinatura = b.assinatura.slice(0, 200);
    db.save();
    res.json({ ok: true });
  });

  // Teste do painel: responde ao dono sem tocar no WhatsApp de ninguém.
  router.post('/ia/testar', auth, can('agents', 'edit'), h(async (req, res) => {
    const texto = await ia.testar(req.acc, (req.body || {}).pergunta);
    res.json({ texto });
  }));

  // Botão do chat: liga/desliga a IA nesta conversa.
  router.put('/ia/conversa/:waId', auth, can('inbox', 'edit'), (req, res) => {
    const contact = req.acc.contacts.find(c => c.waId === req.params.waId);
    if (!contact) return res.status(404).json({ error: 'Contato não encontrado' });
    const ligada = ia.alternarNaConversa(req.acc, contact, !!(req.body || {}).ligada);
    broadcast('message', { accountId: req.acc.id, waId: contact.waId });
    res.json({ ligada });
  });

  router.get('/sms', auth, can('sms'), (req, res) => {
    res.json({
      ...sms.publicView(req.acc),
      log: sms.historico(req.acc).slice(0, 200)
    });
  });

  router.post('/sms/send', auth, feat('sms'), can('sms', 'create'), h(async (req, res) => {
    const b = req.body || {};
    const r = await sms.enviar(req.acc, {
      to: b.to, text: b.text, origem: 'manual', por: req.who && req.who.name
    });
    agents.log(req.acc, req.who, 'sms_send', `SMS para ${r.to}`);
    broadcast('sms', { accountId: req.acc.id, id: r.id, status: r.status });
    res.json({ sms: r, balance: req.acc.wallet.balance });
  }));

  // Disparo em massa: aceita a lista de números ou o mesmo filtro da tela de
  // contatos, para o cliente não precisar copiar e colar telefone.
  router.post('/sms/bulk', auth, feat('sms'), can('sms', 'create'), h(async (req, res) => {
    const b = req.body || {};
    let numeros = Array.isArray(b.numbers) ? b.numbers : [];
    if (!numeros.length) {
      const padrao = store.defChId(req.acc);
      const doCanal = c => !b.channelOnly || (c.chId || padrao) === req.chId;
      const comTag = c => !b.tag || (c.tags || []).includes(b.tag);
      const noEstagio = c => !b.stage || c.stage === b.stage;
      numeros = (req.acc.contacts || []).filter(c => doCanal(c) && comTag(c) && noEstagio(c)).map(c => c.waId);
    }
    const r = await sms.enviarMassa(req.acc, { numeros, text: b.text, por: req.who && req.who.name });
    agents.log(req.acc, req.who, 'sms_bulk', `Disparo de SMS: ${r.enviados} enviado(s)`);
    broadcast('sms', { accountId: req.acc.id });
    res.json({ ...r, balance: req.acc.wallet.balance });
  }));

  // Prévia do disparo em massa antes de gastar crédito.
  router.post('/sms/bulk/preview', auth, feat('sms'), can('sms'), (req, res) => {
    const b = req.body || {};
    const padrao = store.defChId(req.acc);
    const doCanal = c => !b.channelOnly || (c.chId || padrao) === req.chId;
    const comTag = c => !b.tag || (c.tags || []).includes(b.tag);
    const noEstagio = c => !b.stage || c.stage === b.stage;
    const alvo = (req.acc.contacts || []).filter(c => doCanal(c) && comTag(c) && noEstagio(c));
    const validos = alvo.filter(c => sms.valido(c.waId));
    const seg = sms.segmentos(b.text || '');
    res.json({
      total: alvo.length, invalidos: alvo.length - validos.length,
      enviaveis: validos.length, segmentos: seg, creditos: seg * validos.length,
      // custo real do disparo: é isso que sai da carteira ao confirmar
      custo: sms.precoDe(seg * validos.length), saldo: req.acc.wallet.balance,
      amostra: validos.slice(0, 5).map(c => ({ name: c.name, waId: c.waId }))
    });
  });

  // ============ USO x LIMITES DO PLANO ============
  router.get('/limits', auth, (req, res) => {
    res.json({ limits: limits.report(req.acc), extraPrices: limits.extraPrices() });
  });

  // ============ CONFIGURAÇÕES ============

  router.get('/settings', auth, (req, res) => {
    const out = {
      settings: { stages: req.acc.stages, graphVersion: db.get().platform.graphVersion },
      wa: waPublic(req.wctx),
      pixels: req.acc.pixels,
      linkDomain: req.acc.linkDomain,
      timezone: req.acc.timezone || db.get().platform.timezone || datas.PADRAO,
      fusos: datas.FUSOS,
      kind: req.session.kind,
      webhookPath: '/webhook'
    };
    // A configuração da plataforma (app da Meta, webhook, Meta Ads) e a conexão
    // manual NÃO saem por aqui: elas vivem só em GET /admin/saas, que é adminOnly.
    // Esta rota é a tela de Configurações do cliente.
    res.json(out);
  });

  // async + h(): a conexão manual agora conversa com a Meta (Business ID e
  // assinatura da WABA), e um erro dessas chamadas precisa virar resposta HTTP
  // em vez de promessa rejeitada sem dono.
  router.put('/settings', auth, h(async (req, res) => {
    // ETAPAS DO PIPELINE (qualquer conta)
    //
    // Renomear ou apagar uma etapa não pode deixar contato apontando para uma
    // etapa que não existe mais — ele sumiria do quadro. O front manda
    // `stageMap` ({nomeAntigo: nomeNovo}) descrevendo o que mudou; quem foi
    // apagado vem com destino vazio e cai na primeira etapa da lista nova.
    if (Array.isArray(req.body.stages)) {
      const stages = [];
      for (const x of req.body.stages) {
        const s = String(x).trim();
        if (s && !stages.includes(s)) stages.push(s);   // sem vazios nem repetidos
      }
      if (stages.length) {
        const map = (req.body.stageMap && typeof req.body.stageMap === 'object') ? req.body.stageMap : {};
        req.acc.stages = stages;

        for (const c of req.acc.contacts || []) {
          if (stages.includes(c.stage)) continue;              // continua válida
          const alvo = String(map[c.stage] || '').trim();
          c.stage = stages.includes(alvo) ? alvo : stages[0];  // renomeada ou realocada
        }
        // a etapa padrão do cadastro automático segue a mesma regra
        const cfg = req.acc.consent || {};
        if (cfg.defaultStage && !stages.includes(cfg.defaultStage)) {
          const alvo = String(map[cfg.defaultStage] || '').trim();
          cfg.defaultStage = stages.includes(alvo) ? alvo : stages[0];
        }
        // automações que movem para uma etapa apagada apontariam para o vazio
        for (const f of req.acc.flows || []) {
          for (const n of ((f.graph && f.graph.nodes) || [])) {
            if (n.type === 'movestage' && n.stage && !stages.includes(n.stage)) {
              const alvo = String(map[n.stage] || '').trim();
              if (stages.includes(alvo)) n.stage = alvo;
            }
          }
        }
      }
    }
    // domínio personalizado dos links rastreáveis (qualquer conta)
    // O fuso decide como o horário é ESCRITO nos avisos. Um valor inválido
    // derrubaria o Intl no meio de um envio, então só entra se o Intl aceitar.
    if (typeof req.body.timezone === 'string') {
      const tz = req.body.timezone.trim();
      if (!tz) delete req.acc.timezone;
      else if (datas.valido(tz)) req.acc.timezone = tz;
      else return res.status(400).json({ error: 'Fuso horário inválido: ' + tz });
    }
    if (typeof req.body.linkDomain === 'string') {
      req.acc.linkDomain = req.body.linkDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    }
    // plataforma (só admin)
    if (req.session.kind === 'admin') {
      const p = db.get().platform;
      for (const k of ['graphVersion', 'appId', 'configId', 'verifyToken']) {
        if (typeof req.body[k] === 'string') p[k] = req.body[k].trim();
      }
      // Segredos: a tela nunca recebe o valor de volta, então mandar vazio
      // significa "não mexi nesse campo" e não "apague o que está lá".
      for (const k of ['appSecret', 'systemToken']) {
        if (typeof req.body[k] === 'string' && req.body[k].trim()) p[k] = req.body[k].trim();
      }
      // App SEPARADO de Meta Ads (opcional). Vazio = reaproveita o do WhatsApp.
      if (req.body.metaAds && typeof req.body.metaAds === 'object') {
        if (typeof req.body.metaAds.appId === 'string') p.metaAds.appId = req.body.metaAds.appId.trim();
        if (typeof req.body.metaAds.appSecret === 'string' && req.body.metaAds.appSecret.trim()) p.metaAds.appSecret = req.body.metaAds.appSecret.trim();
      }
      // credenciais manuais (avançado) — conecta a conta do admin sem Embedded Signup
      const w = req.wctx.wa;
      let manualTouched = false;
      for (const [bodyKey, waKey] of [['accessToken', 'accessToken'], ['wabaId', 'wabaId'], ['phoneNumberId', 'phoneNumberId']]) {
        if (typeof req.body[bodyKey] === 'string') { w[waKey] = req.body[bodyKey].trim(); manualTouched = true; }
      }
      if (manualTouched) {
        w.connected = !!(wa.tokenOf(req.wctx) && w.phoneNumberId);
        w.updatedAt = Date.now();
        // O Embedded Signup descobre o Business ID sozinho; a conexão manual
        // ficava sem ele. Não é campo para digitar: a própria WABA diz de quem
        // ela é, em `owner_business_info`. Falhar aqui não impede de conectar.
        if (w.wabaId && wa.tokenOf(req.wctx) && !w.businessId) {
          try {
            const info = await wa.getWaba(req.wctx);
            const dono = info && info.owner_business_info;
            if (dono && dono.id) { w.businessId = String(dono.id); w.businessName = String(dono.name || ''); }
          } catch (e) {
            store.logEvent({ type: 'business_id_falhou', accountId: req.acc.id, error: e.message });
          }
        }
        // Assinar o app na WABA é o passo que faz a Meta ENTREGAR webhook. Sem
        // ele o número conecta, envia, e nunca recebe nada — foi o que
        // aconteceu aqui. Fazer junto evita depender de lembrar do botão.
        if (w.wabaId && wa.tokenOf(req.wctx)) {
          try {
            await wa.subscribeApp(req.wctx);
            w.appSubscribed = true;
          } catch (e) {
            w.appSubscribed = false;
            store.logEvent({ type: 'subscribe_waba_falhou', accountId: req.acc.id, error: e.message });
          }
        }
      }
    }
    db.save();
    res.json({ ok: true });
  }));

  router.post('/settings/verify-token/regenerate', auth, adminOnly, (req, res) => {
    const p = db.get().platform;
    p.verifyToken = crypto.randomBytes(12).toString('hex');
    db.save();
    res.json({ verifyToken: p.verifyToken });
  });

  // ============ MINHA CONTA ============
  // Nome, e-mail, confirmação do e-mail e verificação em duas etapas. Tudo
  // aqui é do DONO: um atendente tem a própria senha em /agents/me/password.
  router.get('/account', auth, ownerOnly, (req, res) => res.json({ account: account.view(req.acc) }));

  router.put('/account', auth, ownerOnly, h(async (req, res) => {
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) { req.acc.name = b.name.trim().slice(0, 80); db.save(); }
    if (typeof b.email === 'string' && b.email.trim()) return res.json({ account: account.trocarEmail(req.acc, b.email) });
    res.json({ account: account.view(req.acc) });
  }));

  router.post('/account/email/send-code', auth, ownerOnly, h(async (req, res) => {
    await account.enviarCodigoEmail(req.acc);
    res.json({ ok: true, account: account.view(req.acc) });
  }));

  router.post('/account/email/verify', auth, ownerOnly, (req, res) => {
    account.confirmarEmail(req.acc, (req.body || {}).code);
    res.json({ ok: true, account: account.view(req.acc) });
  });

  router.put('/account/2fa', auth, ownerOnly, (req, res) => {
    res.json({ account: account.definirDoisFatores(req.acc, !!(req.body || {}).enabled) });
  });

  router.post('/settings/password', auth, (req, res) => {
    const { current, next } = req.body || {};
    if (!next || next.length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
    if (req.session.kind === 'admin') {
      const p = db.get().platform;
      if (!db.verifyPassword(current || '', p.adminPassHash)) return res.status(400).json({ error: 'Senha atual incorreta' });
      p.adminPassHash = db.hashPassword(next);
      req.acc.passHash = p.adminPassHash;
    } else {
      if (!db.verifyPassword(current || '', req.acc.passHash)) return res.status(400).json({ error: 'Senha atual incorreta' });
      req.acc.passHash = db.hashPassword(next);
    }
    db.save();
    res.json({ ok: true });
  });

  // ============ DIAGNÓSTICO / META ============

  router.get('/settings/test', auth, h(async (req, res) => res.json(await wa.getPhoneInfo(req.wctx))));
  router.get('/debug-token', auth, h(async (req, res) => res.json(await wa.debugToken(req.wctx))));
  router.get('/waba', auth, h(async (req, res) => {
    const [waba, phones] = await Promise.all([wa.getWaba(req.wctx), wa.getWabaPhones(req.wctx)]);
    res.json({ waba, phones: phones.data || [] });
  }));
  router.post('/waba/subscribe', auth, h(async (req, res) => res.json(await wa.subscribeApp(req.wctx))));
  router.get('/waba/subscriptions', auth, h(async (req, res) => res.json(await wa.getSubscriptions(req.wctx))));
  router.delete('/waba/subscribe', auth, h(async (req, res) => res.json(await wa.unsubscribeApp(req.wctx))));

  // ============ PERFIL COMERCIAL ============

  router.get('/profile', auth, h(async (req, res) => {
    const r = await wa.getProfile(req.wctx);
    const p = (r.data && r.data[0]) || {};
    // guarda a foto do perfil conectado p/ exibir no painel (topo + preview)
    req.wctx.wa.profilePictureUrl = p.profile_picture_url || '';
    db.save();
    res.json(p);
  }));

  router.put('/profile', auth, h(async (req, res) => {
    const allowed = ['about', 'address', 'description', 'email', 'vertical', 'websites'];
    const fields = {};
    for (const k of allowed) if (req.body[k] !== undefined) fields[k] = req.body[k];
    res.json(await wa.updateProfile(req.wctx, fields));
  }));

  // Troca a foto do perfil conectado: sobe o binário pela Resumable Upload API
  // e envia o handle em profile_picture_handle (fluxo oficial da Meta).
  router.post('/profile/photo', auth, h(async (req, res) => {
    const { filename, mime, data } = req.body || {};
    if (!data || !/^image\/(jpeg|png)$/.test(mime || '')) return res.status(400).json({ error: 'Envie uma imagem JPG ou PNG' });
    const buffer = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Imagem muito grande (máx. 5 MB)' });
    const handle = await wa.uploadTemplateExample(req.wctx, filename || 'perfil.jpg', mime, buffer);
    await wa.updateProfile(req.wctx, { profile_picture_handle: handle });
    const r = await wa.getProfile(req.wctx); // recarrega a URL nova
    const p = (r.data && r.data[0]) || {};
    req.wctx.wa.profilePictureUrl = p.profile_picture_url || '';
    db.save();
    res.json({ ok: true, url: req.wctx.wa.profilePictureUrl });
  }));

  // ============ CHAMADAS (WhatsApp Business Calling API) ============

  router.get('/settings/calling', auth, h(async (req, res) => {
    const r = await wa.getCallingSettings(req.wctx);
    res.json({ calling: r.calling || null });
  }));

  router.put('/settings/calling', auth, h(async (req, res) => {
    const r = await wa.setCallingSettings(req.wctx, !!(req.body || {}).enabled);
    res.json({ ok: true, result: r });
  }));

  // ============ REGISTRO / VERIFICAÇÃO DO NÚMERO ============

  router.post('/phone/request-code', auth, h(async (req, res) =>
    res.json(await wa.requestCode(req.wctx, req.body.method || 'SMS', req.body.language || 'pt_BR'))));
  router.post('/phone/verify-code', auth, h(async (req, res) => res.json(await wa.verifyCode(req.wctx, req.body.code))));
  router.post('/phone/register', auth, h(async (req, res) => res.json(await wa.registerPhone(req.wctx, req.body.pin))));
  router.post('/phone/deregister', auth, h(async (req, res) => res.json(await wa.deregisterPhone(req.wctx))));

  // ============ DASHBOARD ============

  router.get('/dashboard', auth, can('dashboard', 'view'), (req, res) => {
    const acc = req.acc;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const t0 = +today;
    const now = Date.now();
    // Bloco de atendentes só aparece quando há atendentes cadastrados
    const activeAgents = (acc.team || []).filter(a => a.active);
    const agentsBlock = activeAgents.length ? (() => {
      const rank = agents.ranking(acc, now);
      const online = activeAgents.filter(a => agents.presenceOf(a, now) !== 'offline').length;
      const fr = rank.map(r => r.avgFirstResponseMs).filter(Boolean);
      const ht = rank.map(r => r.avgHandleTimeMs).filter(Boolean);
      const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
      return {
        total: activeAgents.length, online, offline: activeAgents.length - online,
        ranking: rank.slice(0, 6),
        avgFirstResponseMs: avg(fr), avgHandleTimeMs: avg(ht)
      };
    })() : null;
    // Elite Pay no dashboard: vendas de hoje + acumulado (Pix e cartão juntos).
    const pagas = ((acc.elitepay && acc.elitepay.charges) || []).filter(c => c.status === 'paid');
    const hoje = pagas.filter(c => (c.paidAt || 0) >= t0);
    const sales = {
      enabled: !!(acc.elitepay && acc.elitepay.subaccount),
      todayCount: hoje.length,
      todayValue: hoje.reduce((s, c) => s + (c.value || 0), 0),
      totalCount: pagas.length,
      totalValue: pagas.reduce((s, c) => s + (c.value || 0), 0)
    };
    res.json({
      contacts: acc.contacts.length,
      sales,
      unread: acc.contacts.reduce((a, c) => a + (c.unread || 0), 0),
      totalMessages: acc.messages.length,
      todayIn: acc.messages.filter(m => m.direction === 'in' && m.timestamp >= t0).length,
      todayOut: acc.messages.filter(m => m.direction === 'out' && m.timestamp >= t0).length,
      failed: acc.messages.filter(m => m.status === 'failed').length,
      configured: {
        connected: acc.wa.connected,
        accessToken: !!wa.tokenOf(acc),
        wabaId: !!acc.wa.wabaId,
        phoneNumberId: !!acc.wa.phoneNumberId,
        appSubscribed: acc.wa.appSubscribed,
        appId: !!db.get().platform.appId,
        appSecret: !!db.get().platform.appSecret
      },
      wa: waPublic(acc),
      lastWebhookAt: (db.get().webhookLog.find(e => e.type === 'webhook' && (!e.accountId || e.accountId === acc.id)) || {}).ts || null,
      stages: acc.stages,
      stageCounts: acc.stages.map(st => ({ stage: st, count: acc.contacts.filter(c => c.stage === st).length })),
      service: session.metrics(acc), // janela de 24h + finalizações (indicadores)
      consent: consent.metrics(acc), // opt-in / opt-out (indicadores)
      schedule: schedule.summary(acc, now), // agendamentos de hoje / próximos / atrasados
      agents: agentsBlock            // null quando não há atendentes cadastrados
    });
  });

  // ============ CONTATOS / CONVERSAS ============

  // Um contato pertence a um canal (conexão WhatsApp). Quando o painel pede um
  // canal específico, as conversas de outros números não aparecem — é o que
  // impede o atendimento de dois números de se misturar.
  // `?ch=all` (ou header x-channel: all) mostra tudo, para quem quiser a visão geral.
  function chanFilter(req, alvo) {
    const raw = alvo !== undefined ? alvo : (req.get('x-channel') || req.query.ch || '');
    if (raw === 'all' || raw === '') return null;         // sem filtro: mostra tudo
    const dflt = ((req.acc.channels || [])[0] || {}).id || '';
    const id = (raw && (req.acc.channels || []).some(c => c.id === raw)) ? raw : (req.chId || dflt);
    return o => (o.chId || dflt) === id;
  }
  function chanList(req, arr, alvo) {
    const f = chanFilter(req, alvo);
    return f ? arr.filter(f) : arr;
  }
  // Telas de LISTA (contatos, funil) usam o parâmetro `?ch=` explícito da tela.
  // Sem parâmetro, mostram TUDO: é o comportamento pedido, "se não há filtro,
  // mostre todos os contatos". Já a caixa de entrada segue presa ao canal ativo,
  // porque responder exige saber por qual número a conversa acontece.
  function listScope(req) {
    const q = req.query.ch;
    return q === undefined ? 'all' : String(q);
  }
  // Rótulo do canal de cada registro, para a UI marcar de onde veio o contato.
  function chanLabels(acc) {
    const m = {};
    for (const c of acc.channels || []) m[c.id] = c.label;
    return m;
  }

  router.get('/conversations', auth, can('inbox', 'view'), (req, res) => {
    const acc = req.acc;
    const msgs = chanList(req, acc.messages);
    const lastBy = {};
    for (const m of msgs) lastBy[m.waId] = m;
    const list = chanList(req, acc.contacts).map(c => ({
      ...c,
      lastMessage: lastBy[c.waId]
        ? { text: lastBy[c.waId].text, type: lastBy[c.waId].type, direction: lastBy[c.waId].direction, timestamp: lastBy[c.waId].timestamp, status: lastBy[c.waId].status }
        : null,
      session: session.sessionState(c) // janela de 24h + status do atendimento
    })).sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    res.json({ conversations: list });
  });

  // ============ LIGAÇÕES (Calling API — atender, recusar, encerrar, ligar) ============

  router.get('/calls', auth, can('inbox', 'view'), (req, res) => {
    const list = (req.acc.calls || []).slice(-50).reverse().map(c => {
      const ct = store.findContact(req.wctx, c.waId);
      const { sdpOffer, ...pub } = c;
      return { ...pub, name: ct ? ct.name : c.waId };
    });
    res.json({ calls: list });
  });

  // Atender: o navegador gera o SDP answer (WebRTC) e a Meta conecta o áudio
  router.post('/calls/:id/accept', auth, can('inbox', 'edit'), h(async (req, res) => {
    const sdp = String((req.body || {}).sdp || '');
    if (!sdp) return res.status(400).json({ error: 'SDP answer ausente (WebRTC)' });
    const r = await wa.callAction(req.wctx, { call_id: req.params.id, action: 'accept', session: { sdp_type: 'answer', sdp } });
    const call = (req.acc.calls || []).find(c => c.id === req.params.id);
    if (call) { call.status = 'active'; call.answeredAt = Date.now(); db.save(); }
    agents.log(req.acc, req.who, 'call_answered', 'Atendeu a ligação');
    res.json({ ok: true, result: r });
  }));

  // Pré-aceitar (opcional na API — acelera o estabelecimento da mídia)
  router.post('/calls/:id/pre-accept', auth, can('inbox', 'edit'), h(async (req, res) => {
    const sdp = String((req.body || {}).sdp || '');
    const r = await wa.callAction(req.wctx, { call_id: req.params.id, action: 'pre_accept', session: { sdp_type: 'answer', sdp } });
    res.json({ ok: true, result: r });
  }));

  router.post('/calls/:id/reject', auth, can('inbox', 'edit'), h(async (req, res) => {
    const r = await wa.callAction(req.wctx, { call_id: req.params.id, action: 'reject' });
    const call = (req.acc.calls || []).find(c => c.id === req.params.id);
    if (call) { call.status = 'rejected'; call.endedAt = Date.now(); db.save(); }
    agents.log(req.acc, req.who, 'call_rejected', 'Recusou a ligação');
    res.json({ ok: true, result: r });
  }));

  router.post('/calls/:id/terminate', auth, can('inbox', 'edit'), h(async (req, res) => {
    const r = await wa.callAction(req.wctx, { call_id: req.params.id, action: 'terminate' });
    const call = (req.acc.calls || []).find(c => c.id === req.params.id);
    if (call) { call.status = 'ended'; call.endedAt = Date.now(); db.save(); }
    agents.log(req.acc, req.who, 'call_ended', 'Encerrou a ligação');
    res.json({ ok: true, result: r });
  }));

  // Ligar para o cliente (business-initiated) — exige permissão prévia dele
  router.post('/calls/start', auth, can('inbox', 'edit'), requireConsent, h(async (req, res) => {
    const to = store.normalizeWaId((req.body || {}).to);
    const sdp = String((req.body || {}).sdp || '');
    if (!to || !sdp) return res.status(400).json({ error: 'Informe "to" e o SDP offer (WebRTC)' });
    const r = await wa.callAction(req.wctx, { to, action: 'connect', session: { sdp_type: 'offer', sdp } });
    const callId = (r.calls && r.calls[0] && r.calls[0].id) || null;
    if (callId) {
      req.acc.calls = req.acc.calls || [];
      req.acc.calls.push({ id: callId, waId: to, direction: 'BUSINESS_INITIATED', status: 'calling', startedAt: Date.now(), endedAt: null, duration: null });
      if (req.acc.calls.length > 200) req.acc.calls.shift();
      db.save();
    }
    agents.log(req.acc, req.who, 'call_started', 'Ligou para o cliente');
    res.json({ ok: true, callId, result: r });
  }));

  // Envia o pedido de permissão de ligação (interativa oficial da Meta)
  router.post('/calls/permission', auth, can('inbox', 'edit'), requireConsent, h(async (req, res) => {
    const to = store.normalizeWaId((req.body || {}).to);
    if (!to) return res.status(400).json({ error: 'Informe "to"' });
    const r = await wa.sendCallPermission(req.wctx, to, (req.body || {}).text);
    storeOutbound(req.wctx, to, { type: 'interactive', text: '📞 Pedido de permissão para ligar' }, r);
    res.json({ ok: true });
  }));

  // ============ ATRIBUIÇÃO E TRANSFERÊNCIA DE CONVERSAS ============

  // Assumir a conversa (o próprio atendente) ou atribuir a alguém
  router.post('/conversations/:waId/assign', auth, can('inbox', 'edit'), (req, res) => {
    const c = store.findContact(req.wctx, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Conversa não encontrada' });
    const toId = String((req.body || {}).agentId || (req.agent ? req.agent.id : '')) || null;
    const to = toId ? agents.findAgent(req.acc, toId) : null;
    if (toId && !to) return res.status(404).json({ error: 'Atendente não encontrado' });
    c.assignedTo = toId;
    c.assignedAt = Date.now();
    db.save();
    agents.log(req.acc, req.who, 'conversation_assigned', `Conversa de ${c.name} atribuída a ${to ? to.name : 'ninguém'}`, { waId: c.waId });
    broadcast('assign', { accountId: req.acc.id, waId: c.waId, agentId: toId });
    res.json({ contact: assignPublic(req.acc, c) });
  });

  // Transferir para outro atendente — guarda o histórico completo
  router.post('/conversations/:waId/transfer', auth, can('inbox', 'edit'), (req, res) => {
    const c = store.findContact(req.wctx, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Conversa não encontrada' });
    const toId = String((req.body || {}).agentId || '');
    const to = agents.findAgent(req.acc, toId);
    if (!to) return res.status(404).json({ error: 'Atendente de destino não encontrado' });
    if (!to.active) return res.status(400).json({ error: 'Este atendente está desativado' });
    const from = c.assignedTo ? agents.findAgent(req.acc, c.assignedTo) : null;
    const reason = String((req.body || {}).reason || '').trim();

    c.transfers = c.transfers || [];
    c.transfers.push({
      ts: Date.now(),
      fromId: from ? from.id : null, fromName: from ? from.name : 'Não atribuída',
      toId: to.id, toName: to.name,
      by: req.who.name, reason: reason || null
    });
    if (c.transfers.length > 100) c.transfers.shift();
    c.assignedTo = to.id;
    c.assignedAt = Date.now();
    db.save();

    agents.log(req.acc, req.who, 'conversation_transferred',
      `Transferiu a conversa de ${c.name}: ${from ? from.name : '-'} → ${to.name}${reason ? ' (' + reason + ')' : ''}`, { waId: c.waId });
    broadcast('assign', { accountId: req.acc.id, waId: c.waId, agentId: to.id, transferred: true });
    res.json({ contact: assignPublic(req.acc, c) });
  });

  function assignPublic(acc, c) {
    const a = c.assignedTo ? agents.findAgent(acc, c.assignedTo) : null;
    return {
      waId: c.waId,
      assignedTo: c.assignedTo,
      assignedAgent: a ? { id: a.id, name: a.name, photo: a.photo, presence: agents.presenceOf(a) } : null,
      transfers: (c.transfers || []).slice(-20).reverse()
    };
  }

  // ============ AGENDAMENTOS ============

  router.get('/schedules', auth, can('schedule', 'view'), (req, res) => {
    const { from, to, agentId, stage } = req.query;
    res.json({
      events: schedule.list(req.acc, {
        from: from ? Number(from) : null, to: to ? Number(to) : null,
        agentId: agentId || null, stage: stage || null
      }),
      colors: schedule.COLORS,
      reminderOptions: schedule.REMINDER_OPTIONS,
      reminderLabels: schedule.REMINDER_LABEL,
      agents: (req.acc.team || []).filter(a => a.active).map(a => ({ id: a.id, name: a.name, photo: a.photo })),
      stages: req.acc.stages,
      summary: schedule.summary(req.acc)
    });
  });

  router.post('/schedules', auth, feat('schedule'), can('schedule', 'create'), (req, res) => {
    const e = schedule.create(req.acc, req.body, req.who.name);
    agents.log(req.acc, req.who, 'schedule_created', `Criou o agendamento "${e.title}"`);
    broadcast('schedule', { accountId: req.acc.id, id: e.id });
    res.json({ event: schedule.publicOf(req.acc, e) });
  });

  router.put('/schedules/:id', auth, can('schedule', 'edit'), (req, res) => {
    const e = schedule.update(req.acc, req.params.id, req.body);
    if (!e) return res.status(404).json({ error: 'Agendamento não encontrado' });
    agents.log(req.acc, req.who, 'schedule_updated', `Alterou o agendamento "${e.title}"`);
    broadcast('schedule', { accountId: req.acc.id, id: e.id });
    res.json({ event: schedule.publicOf(req.acc, e) });
  });

  router.post('/schedules/:id/duplicate', auth, can('schedule', 'create'), (req, res) => {
    const e = schedule.duplicate(req.acc, req.params.id, req.who.name);
    if (!e) return res.status(404).json({ error: 'Agendamento não encontrado' });
    agents.log(req.acc, req.who, 'schedule_created', `Duplicou o agendamento "${e.title}"`);
    res.json({ event: schedule.publicOf(req.acc, e) });
  });

  router.delete('/schedules/:id', auth, can('schedule', 'delete'), (req, res) => {
    const e = (req.acc.schedules || []).find(x => x.id === req.params.id);
    if (!schedule.remove(req.acc, req.params.id)) return res.status(404).json({ error: 'Agendamento não encontrado' });
    agents.log(req.acc, req.who, 'schedule_deleted', `Excluiu o agendamento "${e ? e.title : ''}"`);
    broadcast('schedule', { accountId: req.acc.id, id: req.params.id, deleted: true });
    res.json({ ok: true });
  });

  // ============ ATENDIMENTO (janela de 24h + finalização) ============

  // Finalizar atendimento (manual) — registra data, tipo e atendente responsável
  router.post('/conversations/:waId/finish', auth, (req, res) => {
    const c = store.findContact(req.wctx, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Conversa não encontrada' });
    const by = req.who.name;
    const att = session.finish(req.acc, c, { by, byId: req.who.agentId, type: 'manual' });
    if (att) att.closedById = req.who.agentId; // liga a finalização ao atendente (métricas)
    store.logEvent({ type: 'attendance_finished', accountId: req.acc.id, waId: c.waId, by, closeType: 'manual' });
    agents.log(req.acc, req.who, 'conversation_finished', `Finalizou a conversa de ${c.name}`, { waId: c.waId });
    broadcast('attendance', { accountId: req.acc.id, waId: c.waId, status: 'finished', closeType: 'manual' });
    res.json({ attendance: att, session: session.sessionState(c) });
  });

  // Reabrir atendimento
  router.post('/conversations/:waId/reopen', auth, (req, res) => {
    const c = store.findContact(req.wctx, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Conversa não encontrada' });
    const by = req.session.user || req.acc.name || 'Atendente';
    const att = session.reopen(req.acc, c, by);
    store.logEvent({ type: 'attendance_reopened', accountId: req.acc.id, waId: c.waId, by });
    broadcast('attendance', { accountId: req.acc.id, waId: c.waId, status: 'open', reason: 'manual' });
    res.json({ attendance: att, session: session.sessionState(c) });
  });

  // Configurações → Atendimento (finalização automática por inatividade)
  router.get('/settings/service', auth, (req, res) => {
    res.json({ service: req.acc.service, options: session.AUTO_CLOSE_OPTIONS });
  });

  router.put('/settings/service', auth, (req, res) => {
    const b = (req.body && req.body.autoClose) || {};
    const ac = req.acc.service.autoClose;
    if (b.enabled !== undefined) ac.enabled = !!b.enabled;
    if (b.minutes !== undefined) {
      const m = Number(b.minutes);
      if (session.AUTO_CLOSE_OPTIONS.includes(m)) ac.minutes = m;
    }
    db.save();
    res.json({ service: req.acc.service });
  });

  // Configurações → Finalização (Pesquisa de Satisfação)
  function surveyPublic(acc) {
    const cfg = survey.cfgOf(acc);
    return {
      survey: cfg,
      format: survey.formatOf(cfg),          // 'buttons' (≤3 notas) | 'list' (>3)
      limits: {
        maxButtons: survey.MAX_BUTTONS, maxRows: survey.MAX_ROWS,
        btnTitleMax: survey.BTN_TITLE_MAX, rowTitleMax: survey.ROW_TITLE_MAX
      },
      metrics: survey.metrics(acc)
    };
  }

  router.get('/settings/survey', auth, (req, res) => res.json(surveyPublic(req.acc)));

  router.put('/settings/survey', auth, (req, res) => {
    const b = req.body || {};
    const s = req.acc.service.survey;
    if (b.enabled !== undefined) s.enabled = !!b.enabled;
    if (typeof b.message === 'string') s.message = b.message.slice(0, 1024);
    if (typeof b.footer === 'string') s.footer = b.footer.slice(0, 60);
    if (typeof b.listButton === 'string') s.listButton = b.listButton.slice(0, survey.BTN_TITLE_MAX);
    if (Array.isArray(b.notes)) {
      const clean = b.notes
        .map(n => ({ id: String(n.id || db.genId('n')).replace(/[^\w-]/g, ''), label: String(n.label || '').trim() }))
        .filter(n => n.label)
        .slice(0, survey.MAX_ROWS);
      if (!clean.length) return res.status(400).json({ error: 'Cadastre pelo menos uma nota' });
      // limite de caracteres depende do formato resultante
      const max = clean.length <= survey.MAX_BUTTONS ? survey.BTN_TITLE_MAX : survey.ROW_TITLE_MAX;
      const tooLong = clean.find(n => n.label.length > max);
      if (tooLong) {
        return res.status(400).json({
          error: `"${tooLong.label}" excede ${max} caracteres, limite da Meta para ${clean.length <= survey.MAX_BUTTONS ? 'botões' : 'itens de lista'}.`
        });
      }
      s.notes = clean;
    }
    db.save();
    res.json(surveyPublic(req.acc));
  });

  router.get('/contacts', auth, can('contacts','view'), (req, res) => {
    const q = (req.query.search || '').toLowerCase();
    const escopo = listScope(req);
    let list = chanList(req, req.acc.contacts, escopo);
    if (q) list = list.filter(c => (c.name || '').toLowerCase().includes(q) || c.waId.includes(q) || (c.tags || []).join(',').toLowerCase().includes(q));
    const dflt = ((req.acc.channels || [])[0] || {}).id || '';
    const rotulos = chanLabels(req.acc);
    res.json({
      contacts: [...list].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
        .map(c => ({ ...c, chId: c.chId || dflt, chLabel: rotulos[c.chId || dflt] || '' })),
      scope: escopo,
      // contagem por canal para o seletor mostrar quantos leads há em cada número
      channels: (req.acc.channels || []).map(ch => ({
        id: ch.id, label: ch.label, connected: !!ch.wa.connected,
        count: req.acc.contacts.filter(c => (c.chId || dflt) === ch.id).length
      })),
      total: req.acc.contacts.length
    });
  });

  router.post('/contacts', auth, can('contacts','create'), (req, res) => {
    const lim = limits.check(req.acc, "contacts");
    if (lim) return res.status(402).json({ error: lim, code: "limit", resource: "contacts" });
    const waId = store.normalizeWaId(req.body.phone);
    if (waId.length < 10) return res.status(400).json({ error: 'Telefone inválido. Use o formato internacional, ex.: 5511999998888' });
    const c = store.upsertContact(req.wctx, waId, req.body.name);
    if (req.body.name) { c.name = req.body.name; db.save(); }
    res.json({ contact: c });
  });

  // Exporta os contatos em CSV com telefone normalizado em E.164 (+DDDDDDDDDDD)
  router.get('/contacts/export', auth, (req, res) => {
    const cell = v => { v = String(v == null ? '' : v); return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = ['nome;telefone_e164;etapa;tags;criado_em;ultima_atividade'];
    for (const c of req.acc.contacts) {
      const digits = String(c.waId || '').replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) continue; // fora do padrão E.164
      lines.push([
        cell(c.name),
        '+' + digits,
        cell(c.stage || ''),
        cell((c.tags || []).join('|')),
        c.createdAt ? new Date(c.createdAt).toISOString() : '',
        c.lastMessageAt ? new Date(c.lastMessageAt).toISOString() : ''
      ].join(';'));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="contatos-koonfy-e164.csv"');
    res.send('﻿' + lines.join('\r\n')); // BOM p/ Excel abrir acentos corretamente
  });

  router.put('/contacts/:waId', auth, can('contacts','edit'), (req, res) => {
    const c = store.findContact(req.wctx, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Contato não encontrado' });
    if (typeof req.body.name === 'string') c.name = req.body.name.trim() || c.waId;
    if (typeof req.body.notes === 'string') c.notes = req.body.notes;
    if (typeof req.body.stage === 'string') c.stage = req.body.stage;
    if (typeof req.body.email === 'string') c.email = req.body.email.trim();
    if (Array.isArray(req.body.tags)) c.tags = req.body.tags.map(t => String(t).trim()).filter(Boolean);
    db.save();
    res.json({ contact: c });
  });

  router.delete('/contacts/:waId', auth, can('contacts','delete'), (req, res) => {
    const acc = req.acc;
    acc.contacts = acc.contacts.filter(c => c.waId !== req.params.waId);
    acc.messages = acc.messages.filter(m => m.waId !== req.params.waId);
    db.save();
    res.json({ ok: true });
  });

  // ============ MENSAGENS ============

  router.get('/messages/:waId', auth, (req, res) => {
    const list = chanList(req, req.acc.messages)
      .filter(m => m.waId === req.params.waId)
      .sort((a, b) => a.timestamp - b.timestamp);
    const contact = store.findContact(req.wctx, req.params.waId) || null;
    res.json({
      messages: list,
      contact,
      session: contact ? session.sessionState(contact) : null, // janela + atendimento
      consent: contact                                         // opt-in / opt-out
        ? {
            status: consent.statusOf(contact), blocked: !consent.canSendTo(req.acc, contact).allowed, state: consent.stateOf(contact),
            assignedAgent: contact.assignedTo ? (() => { const a = agents.findAgent(req.acc, contact.assignedTo); return a ? { id: a.id, name: a.name, photo: a.photo, presence: agents.presenceOf(a) } : null; })() : null,
            agents: (req.acc.team || []).filter(a => a.active).map(a => ({ id: a.id, name: a.name, photo: a.photo, presence: agents.presenceOf(a) }))
          }
        : null
    });
  });

  router.post('/messages/:waId/read', auth, h(async (req, res) => {
    const acc = req.acc;
    const c = store.findContact(req.wctx, req.params.waId);
    if (c) { c.unread = 0; db.save(); }
    const lastIn = [...acc.messages].reverse().find(m =>
      m.waId === req.params.waId && m.direction === 'in' && String(m.id).startsWith('wamid'));
    let waReadReceipt = false;
    if (lastIn) {
      try { await wa.markRead(acc, lastIn.id); waReadReceipt = true; } catch {}
    }
    res.json({ ok: true, waReadReceipt });
  }));

  // ============ ENVIO ============

  // Gate SaaS: quando "enforce" está ligado, contas com assinatura vencida não enviam.
  // Admin da plataforma nunca é bloqueado.
  function requireActive(req, res, next) {
    const p = db.get().platform.billing;
    if (req.session.kind === 'admin') return next();
    // Conta interna do dono: não tem plano para expirar nem cota para estourar.
    if (limits.isUnlimited(req.acc)) return next();
    // Cota de DISPAROS do plano — vale sempre (conta as saídas do ciclo vigente).
    const lim = limits.check(req.acc, 'sends');
    if (lim) return res.status(402).json({ error: lim, code: 'limit', resource: 'sends' });
    if (!p.enforce) return next();
    const b = req.acc.billing || {};
    const ok = (b.status === 'trial' || b.status === 'active' || b.status === 'canceled') && b.periodEnd > Date.now();
    if (ok) return next();
    res.status(402).json({ error: 'Assinatura expirada. Renove em Assinatura & Carteira para continuar enviando' });
  }

  // Guard da JANELA DE 24H (validação obrigatória no backend — o front pode até
  // tentar, mas mensagens de sessão são bloqueadas aqui fora da janela ou com o
  // atendimento finalizado). Templates passam: são o único caminho para reabrir.
  const requireWindow = kind => (req, res, next) => {
    const to = store.normalizeWaId((req.body || {}).to);
    const contact = store.findContact(req.wctx, to);
    if (!contact) return next(); // 1º contato: a Meta valida do lado dela
    const check = session.canSend(contact, kind);
    if (check.allowed) return next();
    res.status(409).json({ error: check.error, code: check.code, session: session.sessionState(contact) });
  };

  // Guard de OPT-OUT — vale para TODOS os envios (inclusive templates e campanhas).
  // Quem pediu para sair não recebe mais nada até ser reativado.
  function requireConsent(req, res, next) {
    const to = store.normalizeWaId((req.body || {}).to);
    const contact = store.findContact(req.wctx, to);
    const check = consent.canSendTo(req.acc, contact);
    if (check.allowed) return next();
    res.status(409).json({ error: check.error, code: check.code });
  }

  // Registra quem foi o último atendente a falar com o contato (coluna da lista de opt-out)
  function markAgent(req, res, next) {
    const to = store.normalizeWaId((req.body || {}).to);
    const c = store.findContact(req.wctx, to);
    if (c) {
      c.lastAgent = req.who.name;
      c.lastAgentId = req.who.agentId;
      c.lastAgentAt = Date.now();
      // quem responde primeiro assume a conversa (se estiver livre)
      if (!c.assignedTo && req.who.agentId) {
        c.assignedTo = req.who.agentId;
        c.assignedAt = Date.now();
      }
    }
    // usado pelo storeOutbound para carimbar o autor na mensagem (métricas)
    req._agentStamp = { agentId: req.who.agentId, agentName: req.who.name };
    next();
  }

  router.post('/send/text', auth, can('inbox', 'create'), requireActive, requireConsent, requireWindow('text'), markAgent, h(async (req, res) => {
    const { to, text, previewUrl } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Informe "to" e "text"' });
    const r = await wa.sendText(req.wctx, store.normalizeWaId(to), text, previewUrl);
    res.json({ ok: true, message: storeOutbound(req.wctx, to, { type: 'text', text }, r, req._agentStamp) });
  }));

  router.post('/send/template', auth, can('inbox', 'create'), requireActive, requireConsent, markAgent, h(async (req, res) => {
    const { to, name, language, components } = req.body;
    if (!to || !name) return res.status(400).json({ error: 'Informe "to" e "name"' });
    const r = await wa.sendTemplate(req.wctx, store.normalizeWaId(to), name, language, components);
    res.json({ ok: true, message: storeOutbound(req.wctx, to, { type: 'template', text: `📋 Template: ${name}` }, r, req._agentStamp) });
  }));

  router.post('/send/media', auth, can('inbox', 'create'), requireActive, requireConsent, requireWindow('media'), markAgent, h(async (req, res) => {
    const { to, kind, mediaId, link, caption, filename } = req.body;
    if (!to || !kind) return res.status(400).json({ error: 'Informe "to" e "kind" (image|video|audio|document|sticker)' });
    const media = {};
    if (mediaId) media.id = mediaId;
    else if (link) media.link = link;
    else return res.status(400).json({ error: 'Informe "mediaId" ou "link"' });
    if (caption && kind !== 'audio' && kind !== 'sticker') media.caption = caption;
    if (kind === 'document' && filename) media.filename = filename;
    const r = await wa.sendMedia(req.wctx, store.normalizeWaId(to), kind, media);
    res.json({
      ok: true,
      message: storeOutbound(req.wctx, to, {
        type: kind,
        text: caption || (filename ? `📎 ${filename}` : ''),
        media: { id: mediaId || null, link: link || null, filename: filename || '', caption: caption || '' }
      }, r)
    });
  }));

  router.post('/send/buttons', auth, can('inbox', 'create'), requireActive, requireConsent, requireWindow('buttons'), markAgent, h(async (req, res) => {
    const { to, body, buttons } = req.body;
    if (!to || !body || !Array.isArray(buttons) || !buttons.length) {
      return res.status(400).json({ error: 'Informe "to", "body" e "buttons" (até 3)' });
    }
    const interactive = {
      type: 'button',
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b, i) => ({
          type: 'reply',
          reply: { id: b.id || `btn_${i + 1}`, title: String(b.title || b).slice(0, 20) }
        }))
      }
    };
    const r = await wa.sendInteractive(req.wctx, store.normalizeWaId(to), interactive);
    const resumo = buttons.map(b => `[${b.title || b}]`).join(' ');
    res.json({ ok: true, message: storeOutbound(req.wctx, to, { type: 'interactive', text: `${body}\n${resumo}` }, r) });
  }));

  // Payload interactive completo (listas, CTA URL etc.) — passa direto para a Graph API
  router.post('/send/interactive', auth, can('inbox', 'create'), requireActive, requireConsent, requireWindow('interactive'), markAgent, h(async (req, res) => {
    const { to, interactive } = req.body;
    if (!to || !interactive) return res.status(400).json({ error: 'Informe "to" e "interactive"' });
    const r = await wa.sendInteractive(req.wctx, store.normalizeWaId(to), interactive);
    res.json({ ok: true, message: storeOutbound(req.wctx, to, { type: 'interactive', text: '[mensagem interativa]' }, r) });
  }));

  router.post('/send/location', auth, can('inbox', 'create'), requireActive, requireConsent, requireWindow('location'), h(async (req, res) => {
    const { to, latitude, longitude, name, address } = req.body;
    if (!to || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Informe "to", "latitude" e "longitude"' });
    }
    const r = await wa.sendLocation(req.wctx, store.normalizeWaId(to), { latitude, longitude, name, address });
    res.json({ ok: true, message: storeOutbound(req.wctx, to, { type: 'location', text: `📍 ${name || ''} ${address || ''}`.trim() || '📍 Localização' }, r) });
  }));

  router.post('/send/contacts', auth, can('inbox', 'create'), requireActive, requireConsent, requireWindow('contacts'), h(async (req, res) => {
    const { to, contacts } = req.body;
    if (!to || !Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'Informe "to" e "contacts"' });
    const r = await wa.sendContactCard(req.wctx, store.normalizeWaId(to), contacts);
    const names = contacts.map(c => c.name && c.name.formatted_name).filter(Boolean).join(', ');
    res.json({ ok: true, message: storeOutbound(req.wctx, to, { type: 'contacts', text: '👤 ' + (names || 'Contato') }, r) });
  }));

  router.post('/send/reaction', auth, can('inbox', 'create'), requireActive, requireConsent, requireWindow('reaction'), h(async (req, res) => {
    const { to, messageId, emoji } = req.body;
    if (!to || !messageId) return res.status(400).json({ error: 'Informe "to" e "messageId"' });
    const r = await wa.sendReaction(req.wctx, store.normalizeWaId(to), messageId, emoji || '👍');
    res.json({ ok: true, id: (r.messages && r.messages[0] && r.messages[0].id) || null });
  }));

  // ============ MÍDIA ============

  router.post('/media/upload', auth, h(async (req, res) => {
    const { filename, mime, data } = req.body;
    if (!data) return res.status(400).json({ error: 'Envie "data" (base64), "filename" e "mime"' });
    const buffer = Buffer.from(data, 'base64');
    const r = await wa.uploadMedia(req.wctx, filename, mime || 'application/octet-stream', buffer);
    res.json({ id: r.id });
  }));

  router.get('/media/:id', auth, h(async (req, res) => {
    const { res: mediaRes, info } = await wa.downloadMedia(req.wctx, req.params.id);
    res.set('Content-Type', info.mime_type || 'application/octet-stream');
    if (req.query.dl) res.set('Content-Disposition', `attachment; filename="${String(req.query.dl).replace(/"/g, '')}"`);
    res.send(Buffer.from(await mediaRes.arrayBuffer()));
  }));

  // ============ TEMPLATES ============

  router.get('/templates', auth, can('templates','view'), h(async (req, res) => {
    const acc = req.acc;
    // cache do CANAL ativo: cada número tem a sua WABA e os seus modelos
    const cache = req.wctx.templatesCache;
    const stale = !cache.fetchedAt || (Date.now() - cache.fetchedAt) > 10 * 60 * 1000;
    if (req.query.sync === '1' || (stale && req.wctx.wa.wabaId && wa.tokenOf(req.wctx))) {
      const r = await wa.listTemplates(req.wctx);
      cache.list = r.data || [];
      cache.fetchedAt = Date.now();
      db.save();
    }
    const ep = elitepay.ensure(acc);
    res.json({
      templates: cache.list.map(t => ({ ...t, purpose: (ep.templateRoles || {})[t.name] || '' })),
      fetchedAt: cache.fetchedAt,
      // variáveis disponíveis por papel — a tela de criação monta os botões com isso
      roleVars: elitepay.TPL_VARS,
      selected: { cobranca: ep.chargeTemplateName || '', confirmacao: ep.confirmTemplateName || '' }
    });
  }));

  // Marca/desmarca o papel de um modelo já existente (cobrança x confirmação).
  // Os dois papéis são exclusivos: gravar um substitui o outro.
  router.put('/templates/:name/role', auth, can('templates', 'edit'), (req, res) => {
    const nome = req.params.name;
    const existe = (req.wctx.templatesCache.list || []).some(t => t.name === nome);
    if (!existe) return res.status(404).json({ error: 'Modelo não encontrado' });
    const role = String((req.body || {}).purpose || '');
    if (role && !elitepay.TPL_ROLES.includes(role)) return res.status(400).json({ error: 'Papel inválido' });
    const tpl = (req.wctx.templatesCache.list || []).find(t => t.name === nome);
    elitepay.setTemplateRole(req.acc, nome, role, tpl.language || 'pt_BR');
    res.json({ ok: true, name: nome, purpose: role });
  });

  // Upload do arquivo de exemplo do cabeçalho de mídia (IMAGE/VIDEO/DOCUMENT).
  // Recebe base64, sobe via Resumable Upload API e devolve o handle da Meta.
  router.post('/templates/example-upload', auth, h(async (req, res) => {
    const { filename, mime, data } = req.body || {};
    if (!data || !mime) return res.status(400).json({ error: 'Envie o arquivo (data base64) e o mime' });
    const buffer = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Arquivo vazio' });
    if (buffer.length > 16 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo de exemplo muito grande (máx. 16 MB)' });
    const handle = await wa.uploadTemplateExample(req.wctx, filename, mime, buffer);
    res.json({ handle });
  }));

  // Variáveis {{1}}..{{n}} de um texto (índice máximo + validação de sequência)
  function tplVars(text) {
    const found = [...new Set((String(text || '').match(/\{\{(\d+)\}\}/g) || []).map(v => +v.replace(/\D/g, '')))].sort((a, b) => a - b);
    const max = found.length ? found[found.length - 1] : 0;
    const sequential = found.every((v, i) => v === i + 1);
    return { count: max, sequential };
  }

  router.post('/templates', auth, can('templates','create'), h(async (req, res) => {
    const { name, category, language, headerType, headerText, headerHandle, headerExample, bodyText, footerText, bodyExamples, buttons, raw } = req.body;
    let payload = raw;
    if (!payload) {
      if (!name || !bodyText) return res.status(400).json({ error: 'Informe "name" e "bodyText"' });
      const components = [];

      // ---- HEADER: TEXT (até 1 variável {{1}} + example.header_text)
      //      ou mídia IMAGE/VIDEO/DOCUMENT (example.header_handle) — regras oficiais ----
      const ht = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerType) ? headerType : (headerText ? 'TEXT' : '');
      if (ht === 'TEXT') {
        const hv = tplVars(headerText);
        if (hv.count > 1) return res.status(400).json({ error: 'O cabeçalho aceita no máximo 1 variável ({{1}}), regra da Meta' });
        if (hv.count === 1 && !/\{\{1\}\}/.test(headerText)) return res.status(400).json({ error: 'A variável do cabeçalho deve ser {{1}}' });
        const comp = { type: 'HEADER', format: 'TEXT', text: headerText };
        if (hv.count === 1) {
          const ex = String(headerExample || '').trim();
          if (!ex) return res.status(400).json({ error: 'Informe um valor de exemplo para a variável {{1}} do cabeçalho, a Meta exige na aprovação' });
          comp.example = { header_text: [ex] };
        }
        components.push(comp);
      } else if (ht) {
        if (!headerHandle) return res.status(400).json({ error: 'Envie o arquivo de exemplo do cabeçalho, a Meta exige uma amostra da mídia para aprovar o modelo' });
        components.push({ type: 'HEADER', format: ht, example: { header_handle: [headerHandle] } });
      }

      // ---- BODY: variáveis sequenciais + example.body_text obrigatório ----
      const bv = tplVars(bodyText);
      if (!bv.sequential) return res.status(400).json({ error: 'As variáveis do corpo devem ser sequenciais, começando em {{1}} sem pular números ({{1}}, {{2}}, {{3}}…)' });
      const bComp = { type: 'BODY', text: bodyText };
      if (bv.count > 0) {
        const exs = (Array.isArray(bodyExamples) ? bodyExamples : []).map(s => String(s || '').trim()).slice(0, bv.count);
        if (exs.length < bv.count || exs.some(s => !s)) {
          return res.status(400).json({ error: `Informe um valor de exemplo para cada variável do corpo ({{1}} a {{${bv.count}}}), a Meta exige na aprovação` });
        }
        bComp.example = { body_text: [exs] };
      }
      components.push(bComp);
      if (footerText) components.push({ type: 'FOOTER', text: footerText });

      // Botões — regras da Meta: até 10 no total, no máx. 2 de URL e 1 de telefone;
      // respostas rápidas vêm sempre antes dos botões de ação.
      if (Array.isArray(buttons) && buttons.length) {
        const order = { QUICK_REPLY: 0, URL: 1, PHONE_NUMBER: 2 };
        const clean = buttons
          .filter(b => b && ['QUICK_REPLY', 'URL', 'PHONE_NUMBER'].includes(b.type) && String(b.text || '').trim())
          .map(b => {
            const o = { type: b.type, text: String(b.text).trim().slice(0, 25) };
            if (b.type === 'URL') o.url = String(b.url || '').trim();
            if (b.type === 'PHONE_NUMBER') o.phone_number = String(b.phone_number || '').trim();
            return o;
          })
          .filter(b => b.type === 'QUICK_REPLY' || (b.type === 'URL' && b.url) || (b.type === 'PHONE_NUMBER' && b.phone_number))
          .sort((a, b) => order[a.type] - order[b.type]);
        if (clean.length > 10) return res.status(400).json({ error: 'Máximo de 10 botões por modelo' });
        if (clean.filter(b => b.type === 'URL').length > 2) return res.status(400).json({ error: 'Máximo de 2 botões de link (URL)' });
        if (clean.filter(b => b.type === 'PHONE_NUMBER').length > 1) return res.status(400).json({ error: 'Máximo de 1 botão de telefone' });
        if (clean.length) components.push({ type: 'BUTTONS', buttons: clean });
      }

      payload = {
        name: String(name).trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'),
        category: category || 'MARKETING',
        language: language || 'pt_BR',
        components
      };
    }
    const r = await wa.createTemplate(req.wctx, payload);
    req.wctx.templatesCache.fetchedAt = 0; // força re-sync do canal ativo
    // PAPEL do modelo no Elite Pay: cobrança OU confirmação de pagamento
    // (nunca os dois) — vazio significa modelo comum, só para campanhas.
    // `chargeTemplate: true` é o formato antigo do painel; segue aceito.
    const purpose = req.body.chargeTemplate ? 'cobranca' : String(req.body.purpose || '');
    if (purpose) require('./elitepay').setTemplateRole(req.acc, payload.name, purpose, payload.language || 'pt_BR');
    db.save();
    res.json({ ...r, purpose: purpose || '' });
  }));

  router.delete('/templates/:name', auth, h(async (req, res) => {
    const r = await wa.deleteTemplate(req.wctx, req.params.name);
    const cache = req.wctx.templatesCache;
    cache.list = cache.list.filter(t => t.name !== req.params.name);
    // some também do Elite Pay — se era o modelo selecionado, a seleção é limpa
    elitepay.setTemplateRole(req.acc, req.params.name, '');
    db.save();
    res.json(r);
  }));

  // ============ RESPOSTAS RÁPIDAS ============

  router.get('/quick-replies', auth, can('quick', 'view'), (req, res) => res.json({ quickReplies: req.acc.quickReplies }));

  router.post('/quick-replies', auth, can('quick', 'create'), (req, res) => {
    const { title, text } = req.body;
    if (!title || !text) return res.status(400).json({ error: 'Informe "title" e "text"' });
    const qr = { id: db.genId('qr'), title, text };
    req.acc.quickReplies.push(qr);
    db.save();
    res.json({ quickReply: qr });
  });

  router.delete('/quick-replies/:id', auth, (req, res) => {
    req.acc.quickReplies = req.acc.quickReplies.filter(q => q.id !== req.params.id);
    db.save();
    res.json({ ok: true });
  });

  // ============ RELATÓRIOS ============

  router.get('/reports', auth, (req, res) => {
    const acc = req.acc;
    const daysN = Math.min(90, Math.max(7, parseInt(req.query.days, 10) || 14));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const days = [];
    for (let i = daysN - 1; i >= 0; i--) {
      const t0 = +today - i * 86400000, t1 = t0 + 86400000;
      const slice = acc.messages.filter(m => m.timestamp >= t0 && m.timestamp < t1);
      days.push({
        date: new Date(t0).toISOString().slice(0, 10),
        in: slice.filter(m => m.direction === 'in').length,
        out: slice.filter(m => m.direction === 'out').length,
        failed: slice.filter(m => m.status === 'failed').length
      });
    }
    const t0p = +today - (daysN - 1) * 86400000;
    const period = acc.messages.filter(m => m.timestamp >= t0p);
    const outMsgs = period.filter(m => m.direction === 'out');
    const delivered = outMsgs.filter(m => ['delivered', 'read'].includes(m.status)).length;
    const read = outMsgs.filter(m => m.status === 'read').length;
    const failed = outMsgs.filter(m => m.status === 'failed').length;
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const m of period) if (m.direction === 'in') byHour[new Date(m.timestamp).getHours()]++;
    const perContact = {};
    for (const m of period) perContact[m.waId] = (perContact[m.waId] || 0) + 1;
    const topContacts = Object.entries(perContact).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([waId, count]) => ({ waId, count, name: (store.findContact(acc, waId) || {}).name || waId }));
    const tpl = {};
    for (const m of outMsgs) if (m.type === 'template') {
      const n = (m.text || '').replace('📋 Template: ', '') || 'template';
      tpl[n] = (tpl[n] || 0) + 1;
    }

    // ---- métricas avançadas ----
    // tempo médio de 1ª resposta: por contato, do 1º inbound até o 1º outbound seguinte
    const byContact = {};
    for (const m of period) (byContact[m.waId] = byContact[m.waId] || []).push(m);
    let respSum = 0, respN = 0;
    for (const waId in byContact) {
      const msgs = byContact[waId].sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].direction === 'in') {
          const reply = msgs.slice(i + 1).find(x => x.direction === 'out');
          if (reply) { respSum += (reply.timestamp - msgs[i].timestamp); respN++; }
          break;
        }
      }
    }
    const avgResponseMin = respN ? Math.round(respSum / respN / 60000) : 0;
    const activeContacts = Object.keys(byContact).length;
    const newContacts = acc.contacts.filter(c => (c.createdAt || 0) >= t0p).length;
    const sentByTypeMap = {};
    for (const m of outMsgs) sentByTypeMap[m.type || 'text'] = (sentByTypeMap[m.type || 'text'] || 0) + 1;
    const sentByType = Object.entries(sentByTypeMap).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
    const automationRuns = db.get().webhookLog.filter(e => e.type === 'flow_run' && e.accountId === acc.id && e.ts >= t0p).length;
    const wonStage = acc.stages.find(s => /ganho|fechad|conclu/i.test(s));
    const leadsWon = wonStage ? acc.contacts.filter(c => c.stage === wonStage).length : 0;
    const linkClicks = (acc.links || []).reduce((a, l) => a + l.clicks.filter(c => c.ts >= t0p).length, 0);

    // ---- sugestões de melhoria (calculadas dos dados reais) ----
    const suggestions = [];
    const sug = (level, icon, title, text, actionLabel, actionHash) =>
      suggestions.push({ level, icon, title, text, action: actionLabel ? { label: actionLabel, hash: actionHash } : null });
    const unreadTotal = acc.contacts.reduce((a, c) => a + (c.unread || 0), 0);
    const firstStageCount = (acc.stages[0] && acc.contacts.filter(c => c.stage === acc.stages[0]).length) || 0;
    const totalC = acc.contacts.length;
    if (!acc.wa.connected) sug('warn', 'zap', 'WhatsApp desconectado', 'Conecte seu número para enviar e receber mensagens.', 'Conectar agora', '#/settings');
    if (unreadTotal >= 5) sug('warn', 'bell', `${unreadTotal} mensagens sem resposta`, 'Clientes esperando retorno esfriam rápido, responda para não perder vendas.', 'Abrir conversas', '#/inbox');
    if (avgResponseMin > 30 && respN >= 3) sug('warn', 'clock', 'Tempo de resposta alto', `Sua primeira resposta demora em média ${avgResponseMin} min. Use respostas rápidas e automações de boas-vindas.`, 'Criar automação', '#/flows');
    if (totalC >= 5 && firstStageCount / totalC > 0.6) sug('info', 'columns', 'Funil parado na entrada', `${Math.round(firstStageCount / totalC * 100)}% dos contatos ainda estão em "${acc.stages[0]}". Qualifique e mova os leads pelo funil.`, 'Abrir funil', '#/funnel');
    if (outMsgs.length >= 10 && (delivered / outMsgs.length) < 0.8) sug('warn', 'alert', 'Taxa de entrega baixa', 'Menos de 80% das mensagens entregues. Verifique a qualidade do número e evite disparos para contatos inativos.', 'Ver métricas', '#/dashboard');
    if (!(acc.flows || []).some(f => f.enabled)) sug('info', 'flow', 'Nenhuma automação ativa', 'Crie um fluxo de boas-vindas por palavra-chave para responder na hora, 24/7.', 'Abrir Flow Builder', '#/flows');
    if (totalC >= 5 && !acc.contacts.some(c => (c.tags || []).length)) sug('info', 'tag', 'Contatos sem tags', 'Use tags para segmentar campanhas e disparar automações certeiras.', 'Ver contatos', '#/contacts');
    if (!(acc.links || []).length) sug('info', 'link', 'Rastreie seus cliques', 'Crie links curtos rastreáveis para bio, anúncios e campanhas, com pixel da Meta e do Google.', 'Criar link', '#/links');
    else if (!(acc.pixels || []).length) sug('info', 'target', 'Pixels não configurados', 'Cadastre seu Meta Pixel, Google tag ou TikTok Pixel para alimentar seus anúncios com os cliques dos links.', 'Configurar pixels', '#/settings');
    if (wonStage && totalC >= 10 && leadsWon / totalC < 0.1) sug('info', 'megaphone', 'Poucos leads fechados', `Apenas ${Math.round(leadsWon / totalC * 100)}% chegaram em "${wonStage}". Reengaje com uma campanha de template para leads parados.`, 'Criar campanha', '#/campaigns');
    if (!suggestions.length) sug('ok', 'check-circle', 'Tudo em dia!', 'Seu atendimento está saudável, continue acompanhando as métricas.', null, null);

    // ---- séries para os gráficos do dashboard ----
    const dayIdx = {};
    days.forEach((d, i) => { dayIdx[d.date] = i; });
    const linksByDay = days.map(d => ({ date: d.date, count: 0 }));
    for (const l of acc.links || []) for (const c of l.clicks) {
      const k = new Date(c.ts).toISOString().slice(0, 10);
      if (dayIdx[k] !== undefined) linksByDay[dayIdx[k]].count++;
    }
    const webhookByDay = days.map(d => ({ date: d.date, count: 0 }));
    for (const ev of db.get().webhookLog) {
      if (ev.type !== 'webhook' || ev.accountId !== acc.id) continue;
      const k = new Date(ev.ts).toISOString().slice(0, 10);
      if (dayIdx[k] !== undefined) webhookByDay[dayIdx[k]].count++;
    }
    const topLinks = (acc.links || [])
      .map(l => ({ id: l.id, title: l.title, slug: l.slug, clicks: l.clicks.length, clicks7d: l.clicks.filter(c => c.ts >= Date.now() - 7 * 86400000).length }))
      .sort((a, b) => b.clicks - a.clicks).slice(0, 5);
    const flowRunsLog = db.get().webhookLog.filter(e => e.type === 'flow_run' && e.accountId === acc.id);
    const topFlows = (acc.flows || [])
      .map(f => {
        const hist = flowRunsLog.filter(hh => hh.flowId === f.id);
        const okN = hist.filter(hh => (hh.log || []).every(l => l.ok)).length;
        return { id: f.id, name: f.name, runs: f.runs || 0, enabled: f.enabled, okRate: hist.length ? Math.round(okN / hist.length * 100) : null };
      })
      .sort((a, b) => b.runs - a.runs).slice(0, 5);

    res.json({
      days,
      totals: {
        in: period.length - outMsgs.length,
        out: outMsgs.length,
        delivered, read, failed,
        deliveryRate: outMsgs.length ? Math.round(delivered / outMsgs.length * 100) : 0,
        readRate: outMsgs.length ? Math.round(read / outMsgs.length * 100) : 0
      },
      advanced: { avgResponseMin, activeContacts, newContacts, automationRuns, leadsWon, linkClicks, totalContacts: acc.contacts.length },
      suggestions,
      linksByDay, webhookByDay, topLinks, topFlows,
      sentByType,
      byHour,
      topContacts,
      templatesUsed: Object.entries(tpl).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 6),
      stages: acc.stages.map(st => ({ stage: st, count: acc.contacts.filter(c => c.stage === st).length }))
    });
  });

  // ============ CHAT INTERNO (equipe: canais + setores + DMs) ============

  function meName(req) { return req.session.kind === 'admin' ? db.get().platform.adminUser : req.acc.name; }

  // Valida e nomeia um thread. Retorna {id, kind, name} ou null.
  function resolveThread(acc, id) {
    if (id === 'group') return { id: 'group', kind: 'group', name: 'Equipe' };
    if (id.startsWith('sector:')) {
      const s = acc.sectors.find(x => x.id === id.slice(7));
      return s ? { id, kind: 'sector', name: s.name, sectorId: s.id } : null;
    }
    if (id.startsWith('dm:')) {
      const m = acc.team.find(x => x.id === id.slice(3));
      return m ? { id, kind: 'dm', name: m.name, memberId: m.id, role: m.role } : null;
    }
    return null;
  }

  function threadList(acc) {
    const list = [{ id: 'group', kind: 'group', name: 'Equipe', desc: 'Todos os atendentes' }];
    for (const s of acc.sectors) list.push({ id: 'sector:' + s.id, kind: 'sector', name: s.name, sectorId: s.id });
    for (const m of acc.team) list.push({ id: 'dm:' + m.id, kind: 'dm', name: m.name, memberId: m.id, role: m.role, presence: agents.presenceOf(m), active: m.active });
    return list.map(t => {
      const msgs = acc.chatThreads[t.id] || [];
      const last = msgs[msgs.length - 1] || null;
      const readAt = acc.chatReads[t.id] || 0;
      const unread = msgs.filter(mm => mm.ts > readAt && mm.fromId !== acc.id).length;
      return { ...t, last: last ? { text: last.text, ts: last.ts, from: last.from } : null, unread };
    });
  }

  router.get('/team', auth, can('team','view'), (req, res) => {
    res.json({ team: req.acc.team, sectors: req.acc.sectors, threads: threadList(req.acc) });
  });

  router.get('/team/thread/:id', auth, (req, res) => {
    const acc = req.acc;
    const t = resolveThread(acc, req.params.id);
    if (!t) return res.status(404).json({ error: 'Conversa não encontrada' });
    acc.chatReads[t.id] = Date.now(); // marca como lida
    db.save();
    res.json({ thread: t, messages: (acc.chatThreads[t.id] || []).slice(-300) });
  });

  router.post('/team/thread/:id', auth, (req, res) => {
    const acc = req.acc;
    const t = resolveThread(acc, req.params.id);
    if (!t) return res.status(404).json({ error: 'Conversa não encontrada' });
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Mensagem vazia' });
    const msg = { id: db.genId('tc'), threadId: t.id, from: meName(req), fromId: acc.id, text, ts: Date.now() };
    const arr = acc.chatThreads[t.id] = acc.chatThreads[t.id] || [];
    arr.push(msg);
    if (arr.length > 500) arr.splice(0, arr.length - 500);
    acc.chatReads[t.id] = msg.ts;
    db.save();
    broadcast('team', { accountId: acc.id, threadId: t.id, msg });
    res.json({ message: msg });
  });

  router.post('/team/members', auth, (req, res) => {
    const { name, role, sectorId } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Informe o nome do membro' });
    const member = { id: db.genId('mb'), name: String(name).trim(), role: String(role || 'Atendente').trim(), sectorId: sectorId || null, createdAt: Date.now() };
    req.acc.team.push(member);
    db.save();
    res.json({ member });
  });

  router.delete('/team/members/:id', auth, (req, res) => {
    req.acc.team = req.acc.team.filter(m => m.id !== req.params.id);
    delete req.acc.chatThreads['dm:' + req.params.id];
    db.save();
    res.json({ ok: true });
  });

  router.post('/team/sectors', auth, (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Informe o nome do setor' });
    const sector = { id: db.genId('sec'), name, createdAt: Date.now() };
    req.acc.sectors.push(sector);
    db.save();
    res.json({ sector });
  });

  router.delete('/team/sectors/:id', auth, (req, res) => {
    req.acc.sectors = req.acc.sectors.filter(s => s.id !== req.params.id);
    delete req.acc.chatThreads['sector:' + req.params.id];
    db.save();
    res.json({ ok: true });
  });

  // ============ PIXELS DE RASTREAMENTO (CRUD) ============

  const PIXEL_TYPES = { meta: 'Meta Pixel', gtag: 'Google tag', tiktok: 'TikTok Pixel' };

  router.get('/pixels', auth, can('pixels','view'), (req, res) => res.json({ pixels: req.acc.pixels }));

  // ============ INTEGRAÇÃO NUVEMSHOP (aba Integrações) ============
  const nuvem = require('./nuvemshop');
  const origemDe = req => `${req.protocol}://${req.get('host')}`;

  router.get('/integrations/nuvemshop', auth, (req, res) => {
    res.json({ nuvemshop: nuvem.publicCfg(req.acc, origemDe(req)) });
  });

  // Preferências (tags aplicadas, criar contato automaticamente).
  router.put('/integrations/nuvemshop/settings', auth, (req, res) => {
    const c = nuvem.cfg(req.acc);
    const { tags, autoContact } = req.body || {};
    if (Array.isArray(tags)) c.tags = tags.map(t => String(t).trim()).filter(Boolean).slice(0, 10);
    if (typeof autoContact === 'boolean') c.autoContact = autoContact;
    db.save();
    res.json({ nuvemshop: nuvem.publicCfg(req.acc, origemDe(req)) });
  });

  // Troca o code do OAuth por token e assina os webhooks na loja.
  router.post('/integrations/nuvemshop/connect', auth, async (req, res) => {
    if (!nuvem.isAvailable()) return res.status(403).json({ error: 'A integração com a Nuvemshop está indisponível no momento' });
    const code = String((req.body || {}).code || '').trim();
    if (!code) return res.status(400).json({ error: 'Autorização não recebida da Nuvemshop' });
    try {
      await nuvem.exchangeCode(req.acc, code);
      await nuvem.fetchStore(req.acc);
      let aviso = '';
      try { await nuvem.registerWebhooks(req.acc, origemDe(req)); }
      catch (e) { aviso = e.message; }   // loja conectada, mas sem eventos automáticos
      res.json({ nuvemshop: nuvem.publicCfg(req.acc, origemDe(req)), aviso });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Reassina os webhooks (útil se a URL do servidor mudou).
  router.post('/integrations/nuvemshop/rehook', auth, async (req, res) => {
    try {
      await nuvem.registerWebhooks(req.acc, origemDe(req));
      res.json({ nuvemshop: nuvem.publicCfg(req.acc, origemDe(req)) });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Testa o token buscando os dados da loja.
  router.get('/integrations/nuvemshop/test', auth, async (req, res) => {
    try {
      const loja = await nuvem.apiFetch(req.acc, '/store');
      await nuvem.fetchStore(req.acc);
      res.json({ ok: true, store: { id: loja.id, name: nuvem.cfg(req.acc).storeName } });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  router.delete('/integrations/nuvemshop', auth, async (req, res) => {
    try { await nuvem.disconnect(req.acc); } catch (e) { /* desconecta local mesmo se falhar lá */ }
    res.json({ nuvemshop: nuvem.publicCfg(req.acc, origemDe(req)) });
  });

  router.post('/pixels', auth, feat('pixels'), can('pixels','create'), (req, res) => {
    const lim = limits.check(req.acc, "pixels");
    if (lim) return res.status(402).json({ error: lim, code: "limit", resource: "pixels" });
    const { type, pixelId, name, capiToken, testCode, defaultEvent } = req.body || {};
    if (!PIXEL_TYPES[type]) return res.status(400).json({ error: 'Tipo inválido (meta, gtag ou tiktok)' });
    const idv = String(pixelId || '').trim();
    if (!idv) return res.status(400).json({ error: 'Informe o ID do pixel' });
    const px = {
      id: db.genId('px'), type, pixelId: idv,
      name: String(name || '').trim() || PIXEL_TYPES[type],
      capiToken: type === 'meta' ? String(capiToken || '').trim() : '',   // Conversions API (server-side)
      testCode: type === 'meta' ? String(testCode || '').trim() : '',
      defaultEvent: String(defaultEvent || '').trim(),
      createdAt: Date.now(), lastEventAt: null
    };
    req.acc.pixels.push(px);
    db.save();
    res.json({ pixel: px });
  });

  router.put('/pixels/:id', auth, (req, res) => {
    const px = req.acc.pixels.find(p => p.id === req.params.id);
    if (!px) return res.status(404).json({ error: 'Pixel não encontrado' });
    const b = req.body || {};
    if (b.type && PIXEL_TYPES[b.type]) px.type = b.type;
    if (typeof b.pixelId === 'string' && b.pixelId.trim()) px.pixelId = b.pixelId.trim();
    if (typeof b.name === 'string') px.name = b.name.trim() || PIXEL_TYPES[px.type];
    if (typeof b.capiToken === 'string') px.capiToken = px.type === 'meta' ? b.capiToken.trim() : '';
    if (typeof b.testCode === 'string') px.testCode = px.type === 'meta' ? b.testCode.trim() : '';
    if (typeof b.defaultEvent === 'string') px.defaultEvent = b.defaultEvent.trim();
    db.save();
    res.json({ pixel: px });
  });

  router.delete('/pixels/:id', auth, (req, res) => {
    req.acc.pixels = req.acc.pixels.filter(p => p.id !== req.params.id);
    db.save();
    res.json({ ok: true });
  });

  // Envia um evento de teste via Conversions API (Meta) para validar o pixel + token
  router.post('/pixels/:id/test', auth, h(async (req, res) => {
    const px = req.acc.pixels.find(p => p.id === req.params.id);
    if (!px) return res.status(404).json({ error: 'Pixel não encontrado' });
    if (px.type !== 'meta' || !px.capiToken) return res.status(400).json({ error: 'Teste disponível apenas para Meta Pixel com token da Conversions API' });
    const ver = db.get().platform.graphVersion || 'v26.0';
    const payload = {
      data: [{
        event_name: px.defaultEvent || 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: `${req.protocol}://${req.get('host')}/l/teste`,
        user_data: { client_user_agent: 'Koonfy-Test/1.0' }
      }],
      ...(px.testCode ? { test_event_code: px.testCode } : {})
    };
    const r = await fetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(px.pixelId)}/events?access_token=${encodeURIComponent(px.capiToken)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: (data.error && data.error.message) || 'Falha ao enviar evento', meta: data.error });
    px.lastEventAt = Date.now(); db.save();
    res.json({ ok: true, received: data.events_received || 1, fbtrace: data.fbtrace_id || null });
  }));

  // ============ LINKS RASTREÁVEIS (encurtador com pixel) ============

  function isMobileUA(ua) { return /android|iphone|ipad|mobile/i.test(ua || ''); }

  function linkSummary(acc, link, origin) {
    const t0 = Date.now() - 7 * 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const base = acc.linkDomain ? `https://${acc.linkDomain}` : origin;
    return {
      id: link.id, slug: link.slug, title: link.title, dest: link.dest, createdAt: link.createdAt,
      utm: link.utm || {}, event: link.event || 'PageView', value: link.value || '', currency: link.currency || 'BRL',
      shortUrl: `${base}/l/${link.slug}`,
      clicks: link.clicks.length,
      clicks7d: link.clicks.filter(c => c.ts >= t0).length,
      clicksToday: link.clicks.filter(c => c.ts >= +today).length,
      lastClick: link.clicks.length ? link.clicks[link.clicks.length - 1].ts : null
    };
  }

  const LINK_EVENTS = ['PageView', 'ViewContent', 'Lead', 'Contact', 'Purchase', 'CompleteRegistration', 'InitiateCheckout', 'Subscribe'];
  function cleanUtm(u) {
    u = u || {};
    const out = {};
    for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
      const v = String(u[k] || '').trim();
      if (v) out[k] = v;
    }
    return out;
  }

  router.get('/links', auth, can('links','view'), (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ links: req.acc.links.map(l => linkSummary(req.acc, l, origin)).sort((a, b) => b.createdAt - a.createdAt) });
  });

  router.post('/links', auth, feat('links'), can('links','create'), (req, res) => {
    const lim = limits.check(req.acc, "links");
    if (lim) return res.status(402).json({ error: lim, code: "limit", resource: "links" });
    const { title, dest, slug, utm, event, value, currency } = req.body || {};
    let url = String(dest || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { return res.status(400).json({ error: 'Informe uma URL de destino válida (https://…)' }); }
    let s = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!s) s = crypto.randomBytes(4).toString('hex').slice(0, 7);
    if (db.findLinkBySlug(s)) return res.status(409).json({ error: `O apelido "/l/${s}" já está em uso, escolha outro` });
    const link = {
      id: db.genId('lnk'), slug: s, title: String(title || '').trim() || url.slice(0, 40), dest: url,
      utm: cleanUtm(utm), event: LINK_EVENTS.includes(event) ? event : 'PageView',
      value: String(value || '').replace(',', '.').replace(/[^0-9.]/g, ''), currency: String(currency || 'BRL').toUpperCase().slice(0, 3),
      clicks: [], createdAt: Date.now()
    };
    req.acc.links.push(link);
    db.save();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ link: linkSummary(req.acc, link, origin) });
  });

  router.put('/links/:id', auth, (req, res) => {
    const link = req.acc.links.find(l => l.id === req.params.id);
    if (!link) return res.status(404).json({ error: 'Link não encontrado' });
    const b = req.body || {};
    if (typeof b.title === 'string') link.title = b.title.trim();
    if (typeof b.dest === 'string') {
      let url = b.dest.trim();
      if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
      try { new URL(url); link.dest = url; } catch { return res.status(400).json({ error: 'URL de destino inválida' }); }
    }
    if (b.utm) link.utm = cleanUtm(b.utm);
    if (typeof b.event === 'string' && LINK_EVENTS.includes(b.event)) link.event = b.event;
    if (typeof b.value === 'string') link.value = b.value.replace(',', '.').replace(/[^0-9.]/g, '');
    if (typeof b.currency === 'string') link.currency = b.currency.toUpperCase().slice(0, 3);
    db.save();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ link: linkSummary(req.acc, link, origin) });
  });

  router.delete('/links/:id', auth, (req, res) => {
    req.acc.links = req.acc.links.filter(l => l.id !== req.params.id);
    db.save();
    res.json({ ok: true });
  });

  router.get('/links/:id/stats', auth, (req, res) => {
    const link = req.acc.links.find(l => l.id === req.params.id);
    if (!link) return res.status(404).json({ error: 'Link não encontrado' });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const byDay = [];
    for (let i = 29; i >= 0; i--) {
      const d0 = +today - i * 86400000, d1 = d0 + 86400000;
      byDay.push({ date: new Date(d0).toISOString().slice(0, 10), count: link.clicks.filter(c => c.ts >= d0 && c.ts < d1).length });
    }
    const mobile = link.clicks.filter(c => isMobileUA(c.ua)).length;
    const refMap = {};
    for (const c of link.clicks) {
      let r = 'Direto';
      try { if (c.ref) r = new URL(c.ref).hostname; } catch {}
      refMap[r] = (refMap[r] || 0) + 1;
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      link: linkSummary(req.acc, link, origin),
      byDay,
      devices: { mobile, desktop: link.clicks.length - mobile },
      referrers: Object.entries(refMap).map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count).slice(0, 6),
      recent: link.clicks.slice(-12).reverse().map(c => ({ ts: c.ts, mobile: isMobileUA(c.ua), ref: c.ref || '' }))
    });
  });

  // ============ FLOW BUILDER (automações) ============

  function flowPublic(f, origin) {
    const link = f.trigger.type === 'link' && f.waPhone
      ? `https://wa.me/${f.waPhone}?text=${encodeURIComponent(f.trigger.phrase || '')}`
      : null;
    const hookUrl = f.trigger.type === 'webhook' ? `${origin}/flow-hook/${f.trigger.hookToken}` : null;
    return { ...f, waLink: link, hookUrl };
  }

  router.get('/flows', auth, can('flows','view'), (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ flows: req.acc.flows.map(f => flowPublic(f, origin)) });
  });

  // Desempenho dos botões de um fluxo: quantos receberam, quantos clicaram e o
  // CTR de cada opção. É a única medida possível do botão de LINK, que tira a
  // pessoa do WhatsApp e não devolve resposta nenhuma.
  router.get('/flows/:id/ctr', auth, can('flows', 'view'), (req, res) => {
    const f = (req.acc.flows || []).find(x => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'Automação não encontrada' });
    res.json({ nos: flows.relatorioCtr(f) });
  });

  router.post('/flows', auth, feat('flows'), can('flows','create'), (req, res) => {
    const lim = limits.check(req.acc, "flows");
    if (lim) return res.status(402).json({ error: lim, code: "limit", resource: "flows" });
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Dê um nome à automação' });
    const trigger = b.trigger || { type: 'keyword', keyword: '', match: 'contains' };
    if (trigger.type === 'webhook' && !trigger.hookToken) trigger.hookToken = crypto.randomBytes(9).toString('hex');
    const flow = {
      id: db.genId('flow'),
      name: String(b.name).trim(),
      enabled: b.enabled !== false,
      trigger,
      waPhone: (req.wctx.wa.displayPhoneNumber || '').replace(/\D/g, ''),
      nodes: Array.isArray(b.nodes) ? b.nodes : [],
      graph: b.graph && Array.isArray(b.graph.nodes) ? b.graph : { nodes: [], edges: [] },
      runs: 0, lastRun: null, lastResult: null,
      createdAt: Date.now(), updatedAt: Date.now()
    };
    // Nasce pausada se ainda estiver incompleta (rascunho do Flow Builder).
    if (flow.enabled && require('./flows').validateGraph(flow)) flow.enabled = false;
    req.acc.flows.push(flow);
    db.save();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ flow: flowPublic(flow, origin) });
  });

  router.put('/flows/:id', auth, can('flows','edit'), (req, res) => {
    const f = req.acc.flows.find(x => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'Automação não encontrada' });
    const b = req.body || {};
    if (typeof b.name === 'string') f.name = b.name.trim();
    if (typeof b.enabled === 'boolean') f.enabled = b.enabled;
    if (b.trigger) {
      f.trigger = b.trigger;
      if (f.trigger.type === 'webhook' && !f.trigger.hookToken) f.trigger.hookToken = crypto.randomBytes(9).toString('hex');
    }
    if (Array.isArray(b.nodes)) f.nodes = b.nodes;
    if (b.graph && Array.isArray(b.graph.nodes)) f.graph = b.graph;
    // Automação incompleta pode ficar salva como rascunho, mas não entra no ar.
    if (f.enabled) {
      const problema = require('./flows').validateGraph(f);
      if (problema) return res.status(400).json({ error: problema });
    }
    f.waPhone = (req.wctx.wa.displayPhoneNumber || '').replace(/\D/g, '');
    f.updatedAt = Date.now();
    db.save();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ flow: flowPublic(f, origin) });
  });

  router.delete('/flows/:id', auth, can('flows','delete'), (req, res) => {
    req.acc.flows = req.acc.flows.filter(f => f.id !== req.params.id);
    db.save();
    res.json({ ok: true });
  });

  // Métricas de execução de uma automação (histórico vem do webhookLog)
  router.get('/flows/:id/stats', auth, (req, res) => {
    const f = req.acc.flows.find(x => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'Automação não encontrada' });
    const history = db.get().webhookLog
      .filter(e => e.type === 'flow_run' && e.accountId === req.acc.id && e.flowId === f.id)
      .slice(0, 20);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    res.json({
      name: f.name, runs: f.runs || 0, lastRun: f.lastRun, lastResult: f.lastResult,
      runsToday: history.filter(hh => hh.ts >= +today).length,
      history: history.map(hh => ({ ts: hh.ts, log: hh.log }))
    });
  });

  // Testa a automação executando os nós agora (para um destino informado)
  router.post('/flows/:id/test', auth, h(async (req, res) => {
    const f = req.acc.flows.find(x => x.id === req.params.id);
    if (!f) return res.status(404).json({ error: 'Automação não encontrada' });
    const flows = require('./flows');
    const log = await flows.runFlow(req.acc, f, {
      to: (req.body || {}).to || req.wctx.wa.displayPhoneNumber || '',
      contactName: 'Teste',
      text: (req.body || {}).text || '',
      vars: (req.body || {}).vars || {}
    }, (acc, to, content, resp) => {
      const msg = storeOutbound(acc, to, content, resp);
      broadcast('message', { accountId: acc.id, waId: msg.waId });
      return msg;
    });
    res.json({ ok: true, steps: log });
  }));

  // ============ OPT-IN / OPT-OUT ============

  // Ficha completa de um contato para a lista de Opt-out
  function consentRow(acc, c) {
    const st = consent.stateOf(c);
    const lastAtt = c.attendance || {};
    const agent = c.lastAgent || lastAtt.closedBy || lastAtt.reopenedBy || null;
    return {
      waId: c.waId, name: c.name,
      uf: geo.ufOf(c.waId), ufName: geo.UF_NAME[geo.ufOf(c.waId)] || '',
      city: c.city || '',
      source: c.source || null,
      stage: c.stage || '',
      tags: c.tags || [],
      lastCampaign: c.lastCampaignName || null,
      lastCampaignAt: c.lastCampaignAt || null,
      lastAgent: agent,
      status: st.status,
      optOutAt: st.optOutAt, optOutSource: st.optOutSource, optOutReason: st.optOutReason,
      optInAt: st.optInAt, optInSource: st.optInSource,
      history: st.history || []
    };
  }

  router.get('/consent', auth, can('consent','view'), (req, res) => {
    const cfg = consent.cfgOf(req.acc);
    res.json({
      config: cfg,
      vars: consent.VARS,
      sources: consent.SOURCES,
      stages: req.acc.stages,
      metrics: consent.metrics(req.acc)
    });
  });

  router.put('/consent', auth, (req, res) => {
    const b = req.body || {};
    const cfg = req.acc.consent;
    const changes = [];
    const set = (k, v, label) => { if (v !== undefined && JSON.stringify(cfg[k]) !== JSON.stringify(v)) { cfg[k] = v; changes.push(label); } };

    if (b.enabled !== undefined) set('enabled', !!b.enabled, b.enabled ? 'Módulo ativado' : 'Módulo desativado');
    if (typeof b.optInMessage === 'string') set('optInMessage', b.optInMessage.slice(0, 1024), 'Mensagem de opt-in');
    if (typeof b.optOutMessage === 'string') set('optOutMessage', b.optOutMessage.slice(0, 1024), 'Mensagem de opt-out');
    if (b.autoOptIn !== undefined) set('autoOptIn', !!b.autoOptIn, 'Opt-in automático');
    if (b.sendOptInMessage !== undefined) set('sendOptInMessage', !!b.sendOptInMessage, 'Envio da mensagem de opt-in');
    if (b.sendOptOutMessage !== undefined) set('sendOptOutMessage', !!b.sendOptOutMessage, 'Envio da mensagem de opt-out');
    if (typeof b.defaultStage === 'string') set('defaultStage', b.defaultStage, 'Etapa padrão do funil');
    // Sanitiza a palavra-chave: tira pontuação/markdown das bordas (#SAIR, *SAIR*,
    // "SAIR!" → SAIR). Sem isso, uma palavra colada de uma mensagem nunca casaria.
    const cleanKw = arr => [...new Set((arr || [])
      .map(k => String(k).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toUpperCase())
      .filter(Boolean))].slice(0, 40);
    if (Array.isArray(b.keywords)) {
      const kw = cleanKw(b.keywords);
      if (!kw.length) return res.status(400).json({ error: 'Cadastre pelo menos uma palavra-chave de opt-out' });
      set('keywords', kw, 'Palavras-chave de opt-out');
    }
    if (Array.isArray(b.optInKeywords)) set('optInKeywords', cleanKw(b.optInKeywords), 'Palavras-chave de reativação');

    if (changes.length) consent.logConfigChange(req.acc, req.session.user || req.acc.name, changes);
    db.save();
    res.json({ config: cfg, metrics: consent.metrics(req.acc) });
  });

  // Lista de contatos por status (padrão: opted_out) — com busca e filtros
  router.get('/consent/contacts', auth, (req, res) => {
    const q = String(req.query.search || '').toLowerCase().trim();
    const status = String(req.query.status || 'opted_out');
    const uf = String(req.query.uf || '');
    const source = String(req.query.source || '');
    const stage = String(req.query.stage || '');

    let list = req.acc.contacts.map(c => consentRow(req.acc, c));
    if (status !== 'all') list = list.filter(r => r.status === status);
    if (uf) list = list.filter(r => r.uf === uf);
    if (stage) list = list.filter(r => r.stage === stage);
    if (source) list = list.filter(r => (r.optOutSource || r.optInSource) === source);
    if (q) list = list.filter(r =>
      (r.name || '').toLowerCase().includes(q) || r.waId.includes(q) ||
      (r.city || '').toLowerCase().includes(q) || (r.lastAgent || '').toLowerCase().includes(q));

    list.sort((a, b) => (b.optOutAt || b.optInAt || 0) - (a.optOutAt || a.optInAt || 0));
    // UFs presentes (para o filtro)
    const ufs = [...new Set(req.acc.contacts.map(c => geo.ufOf(c.waId)).filter(Boolean))].sort();
    res.json({ contacts: list, ufs, stages: req.acc.stages, metrics: consent.metrics(req.acc) });
  });

  // Ações manuais
  router.post('/consent/:waId/optout', auth, (req, res) => {
    const c = store.findContact(req.wctx, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Contato não encontrado' });
    const by = req.session.user || req.acc.name;
    consent.optOut(req.acc, c, { source: 'manual', reason: String((req.body || {}).reason || '').trim() || 'Opt-out manual', by });
    broadcast('consent', { accountId: req.acc.id, waId: c.waId, status: 'opted_out' });
    res.json({ contact: consentRow(req.acc, c), metrics: consent.metrics(req.acc) });
  });

  // Reativação manual
  router.post('/consent/:waId/reactivate', auth, (req, res) => {
    const c = store.findContact(req.wctx, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Contato não encontrado' });
    const by = req.session.user || req.acc.name;
    consent.reactivate(req.acc, c, { by, reason: String((req.body || {}).reason || '').trim() || null });
    store.logEvent({ type: 'opt_in', accountId: req.acc.id, waId: c.waId, source: 'manual', by });
    broadcast('consent', { accountId: req.acc.id, waId: c.waId, status: 'opted_in' });
    res.json({ contact: consentRow(req.acc, c), metrics: consent.metrics(req.acc) });
  });

  // Exportação CSV da lista
  router.get('/consent/export', auth, (req, res) => {
    const status = String(req.query.status || 'opted_out');
    const cell = v => { v = String(v == null ? '' : v); return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const dt = t => datas.dataHora(t, req.acc);
    const rows = req.acc.contacts.map(c => consentRow(req.acc, c)).filter(r => status === 'all' || r.status === status);
    const lines = ['nome;telefone_e164;estado;cidade;origem;ultima_campanha;ultimo_atendente;etapa_funil;data_opt_out;motivo'];
    for (const r of rows) {
      lines.push([
        cell(r.name), '+' + r.waId, cell(r.ufName || r.uf), cell(r.city),
        cell(r.source ? (r.source.type === 'ad' ? 'Anúncio: ' + (r.source.headline || '') : r.source.type === 'webhook' ? 'Webhook: ' + (r.source.headline || '') : r.source.type) : 'Orgânico'),
        cell(r.lastCampaign), cell(r.lastAgent), cell(r.stage),
        cell(dt(r.optOutAt)), cell(r.optOutReason)
      ].join(';'));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="contatos-${status}-koonfy.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });

  // ============ WEBHOOKS DE ENTRADA (aba Webhooks + Mapeamento de Campos) ============
  const whmod = require('./webhooks');

  function webhookPublic(w, origin) {
    return {
      id: w.id, name: w.name,
      url: `${origin}/hook/${w.token}`, token: w.token,
      mapping: w.mapping || whmod.emptyMapping(),
      tags: w.tags || [],
      fields: w.lastPayload || {},      // { caminho: valorExemplo } p/ montar os seletores
      hits: w.hits || 0,
      lastPayloadAt: w.lastPayloadAt || null,
      createdAt: w.createdAt
    };
  }

  router.get('/webhooks', auth, can('webhooks','view'), (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ webhooks: (req.acc.webhooks || []).map(w => webhookPublic(w, origin)) });
  });

  router.post('/webhooks', auth, feat('integrations'), can('webhooks','create'), (req, res) => {
    const name = String((req.body || {}).name || '').trim() || 'Novo webhook';
    const wh = {
      id: db.genId('wh'), name, token: crypto.randomBytes(10).toString('hex'),
      mapping: whmod.emptyMapping(), tags: [], lastPayload: null, lastPayloadAt: null, hits: 0,
      createdAt: Date.now()
    };
    req.acc.webhooks.push(wh);
    db.save();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ webhook: webhookPublic(wh, origin) });
  });

  router.put('/webhooks/:id', auth, (req, res) => {
    const wh = (req.acc.webhooks || []).find(w => w.id === req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook não encontrado' });
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) wh.name = b.name.trim();
    if (b.mapping && typeof b.mapping === 'object') {
      const m = whmod.emptyMapping();
      m.name = String(b.mapping.name || '');
      m.phone = String(b.mapping.phone || '');
      m.email = String(b.mapping.email || '');
      m.custom = Array.isArray(b.mapping.custom)
        ? b.mapping.custom.filter(c => c && c.key && c.path).map(c => ({ key: String(c.key).trim(), path: String(c.path) })).slice(0, 30)
        : [];
      wh.mapping = m;
    }
    if (Array.isArray(b.tags)) wh.tags = b.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 10);
    db.save();
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ webhook: webhookPublic(wh, origin) });
  });

  router.delete('/webhooks/:id', auth, (req, res) => {
    req.acc.webhooks = (req.acc.webhooks || []).filter(w => w.id !== req.params.id);
    // desvincula flows que usavam este webhook
    for (const f of req.acc.flows || []) {
      if (f.trigger && f.trigger.type === 'webhook' && f.trigger.webhookId === req.params.id) f.trigger.webhookId = '';
    }
    db.save();
    res.json({ ok: true });
  });

  // Simula um evento (para o usuário testar o mapeamento sem um sistema externo)
  router.post('/webhooks/:id/simulate', auth, (req, res) => {
    const wh = (req.acc.webhooks || []).find(w => w.id === req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook não encontrado' });
    const sample = (req.body && req.body.payload) || {
      event: 'purchase.approved',
      data: { member: { name: 'Cliente Exemplo', phone: '5511999998888', email: 'cliente@email.com' }, product: { name: 'Plano Pro' } }
    };
    const r = whmod.ingest(req.acc, wh, sample, broadcast);
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ webhook: webhookPublic(wh, origin), matched: !!r.contact });
  });

  // ============ CAMPANHAS (disparos em massa) ============

  // Público da campanha: todas, várias etapas do funil e/ou várias tags.
  // aud.values (array) é o formato atual; aud.value (string) é compat legado.
  // `chId` é obrigatório na prática: a campanha sai por UM número, e mandar
  // template para um contato de outro canal criaria uma conversa duplicada
  // (e a janela de 24h daquele contato não vale para este número).
  function resolveAudience(acc, aud, chId) {
    const dflt = ((acc.channels || [])[0] || {}).id || '';
    let list = chId ? acc.contacts.filter(c => (c.chId || dflt) === chId) : acc.contacts;
    // OPT-OUT: quem pediu para sair nunca entra em disparo (regra do módulo de consentimento)
    if (consent.cfgOf(acc).enabled) list = list.filter(c => !consent.isOptedOut(c));
    if (!aud || aud.type === 'all') return list.map(c => c.waId);
    const values = (Array.isArray(aud.values) && aud.values.length ? aud.values : [aud.value]).filter(Boolean);
    if (!values.length) return list.map(c => c.waId);
    if (aud.type === 'stage') list = list.filter(c => values.includes(c.stage));
    if (aud.type === 'tag') list = list.filter(c => (c.tags || []).some(t => values.includes(t)));
    return list.map(c => c.waId);
  }

  function campaignStats(acc, camp) {
    const stats = { total: camp.recipients.length, pending: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
    for (const r of camp.recipients) {
      if (r.status === 'pending') { stats.pending++; continue; }
      if (r.status === 'failed') { stats.failed++; continue; }
      const msg = r.msgId ? acc.messages.find(m => m.id === r.msgId) : null;
      const st = msg ? msg.status : 'sent';
      if (st === 'read') stats.read++;
      else if (st === 'delivered') stats.delivered++;
      else if (st === 'failed') stats.failed++;
      else stats.sent++;
    }
    return stats;
  }

  // Variáveis dinâmicas nos valores das campanhas — resolvidas POR DESTINATÁRIO:
  //   {contato.nome} {contato.email} {contato.telefone}  → dados do sistema
  //   {webhook.<flowId>.<campo>}                          → último payload do gatilho webhook
  function resolveVarTokens(acc, value, contact) {
    return String(value == null ? '' : value)
      .replace(/\{contato\.(nome|email|telefone)\}/gi, (m, k) => {
        if (!contact) return '';
        if (k.toLowerCase() === 'nome') return contact.name || '';
        if (k.toLowerCase() === 'email') return contact.email || '';
        return '+' + contact.waId;
      })
      .replace(/\{webhook\.([\w-]+)\.([\w.-]+)\}/gi, (m, flowId, key) => {
        const f = (acc.flows || []).find(x => x.id === flowId);
        const v = f && f.lastVars ? f.lastVars[key] : undefined;
        return v === undefined || v === null ? '' : String(v);
      });
  }

  async function runCampaign(accId, campId) {
    const acc = db.findAccount(accId);
    if (!acc) return;
    const camp = acc.campaigns.find(c => c.id === campId);
    if (!camp) return;
    // A campanha sai pelo CANAL em que foi criada. Sem isso, ela usaria sempre
    // o número padrão e os contatos de outro número receberiam pelo número errado.
    const canal = db.findChannel(acc, camp.chId);
    const ctx = db.chanCtx(acc, canal);
    const chId = canal ? canal.id : '';
    if (!canal || !canal.wa.connected) {
      camp.status = 'done';
      camp.finishedAt = Date.now();
      for (const r of camp.recipients) if (r.status === 'pending') { r.status = 'failed'; r.error = 'Canal desconectado'; }
      db.save();
      broadcast('campaign', { accountId: acc.id, id: camp.id });
      return;
    }
    for (const r of camp.recipients) {
      if (r.status !== 'pending') continue;
      try {
        const contact = store.findContact(ctx, r.waId) || null;
        // OPT-OUT durante o disparo (o cliente pode pedir para sair no meio da fila)
        if (contact && !consent.canSendTo(acc, contact).allowed) {
          r.status = 'skipped';
          r.error = 'Contato em opt-out';
          db.save();
          continue;
        }
        const components = camp.vars && camp.vars.length
          ? [{ type: 'body', parameters: camp.vars.map(v => ({ type: 'text', text: resolveVarTokens(acc, v, contact) || '-' })) }]
          : undefined;
        const resp = await wa.sendTemplate(ctx, r.waId, camp.templateName, camp.language, components);
        if (contact) { contact.lastCampaignId = camp.id; contact.lastCampaignName = camp.name; contact.lastCampaignAt = Date.now(); }
        r.msgId = (resp && resp.messages && resp.messages[0] && resp.messages[0].id) || null;
        r.status = 'sent';
        storeOutbound(acc, r.waId, { type: 'template', text: `📋 Template: ${camp.templateName}` }, resp, null, chId);
      } catch (e) {
        r.status = 'failed';
        r.error = e.message;
      }
      db.save();
      broadcast('campaign', { accountId: acc.id, id: camp.id });
      await new Promise(rz => setTimeout(rz, 350)); // respeita rate limit
    }
    camp.status = 'done';
    camp.finishedAt = Date.now();
    db.save();
    broadcast('campaign', { accountId: acc.id, id: camp.id });
  }

  router.get('/campaigns', auth, can('campaigns','view'), (req, res) => {
    const list = req.acc.campaigns
      .map(c => ({ ...c, recipients: undefined, stats: campaignStats(req.acc, c) }))
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ campaigns: list });
  });

  router.get('/campaigns/:id', auth, (req, res) => {
    const acc = req.acc;
    const c = acc.campaigns.find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Campanha não encontrada' });
    const recipients = c.recipients.map(r => {
      const msg = r.msgId ? acc.messages.find(m => m.id === r.msgId) : null;
      const contact = store.findContact(acc, r.waId);
      return {
        waId: r.waId,
        name: contact ? contact.name : r.waId,
        status: r.status === 'failed' ? 'failed' : (msg ? msg.status : r.status),
        error: r.error || (msg && msg.error) || null
      };
    });
    res.json({ campaign: { ...c, recipients: undefined }, stats: campaignStats(acc, c), recipients });
  });

  router.post('/campaigns', auth, feat('campaigns'), requireActive, h(async (req, res) => {
    const { name, templateName, language, vars, audience } = req.body || {};
    if (!name || !templateName) return res.status(400).json({ error: 'Informe "name" e "templateName"' });
    // Teto de CAMPANHAS do plano. Diferente de `sends`, que conta mensagens:
    // aqui o que se limita é quantas campanhas cabem no ciclo.
    limits.enforce(req.acc, 'campaigns', 1);
    if (!req.ch || !req.ch.wa.connected) {
      return res.status(400).json({ error: 'Conecte o número deste canal antes de disparar' });
    }
    // o público é sempre do canal ativo: é ele que vai enviar
    const waIds = resolveAudience(req.acc, audience, req.chId);
    if (!waIds.length) return res.status(400).json({ error: 'Nenhum contato deste canal no público selecionado' });
    // o modelo precisa existir e estar aprovado NA WABA deste canal
    const aprovado = (req.ch.templatesCache.list || [])
      .some(t => t.name === templateName && /APPROVED/i.test(t.status || ''));
    if (!aprovado && (req.ch.templatesCache.list || []).length) {
      return res.status(400).json({ error: `O modelo "${templateName}" não está aprovado no número ${req.ch.label}` });
    }
    const camp = {
      id: db.genId('camp'),
      name, templateName,
      chId: req.chId, chLabel: req.ch.label,   // canal que dispara
      language: language || 'pt_BR',
      vars: Array.isArray(vars) ? vars.map(v => String(v)) : [],
      audience: audience || { type: 'all' },
      createdAt: Date.now(), status: 'running', finishedAt: null,
      recipients: waIds.map(w => ({ waId: w, status: 'pending', msgId: null }))
    };
    req.acc.campaigns.push(camp);
    db.save();
    runCampaign(req.acc.id, camp.id); // roda em segundo plano
    res.json({ campaign: { ...camp, recipients: undefined }, total: waIds.length });
  }));

  // Webhooks (gatilhos do Flow Builder) disponíveis como fonte de variáveis:
  // lista cada automação com gatilho webhook e os campos já recebidos nela.
  router.get('/hook-vars', auth, (req, res) => {
    const hooks = (req.acc.flows || [])
      .filter(f => f.trigger && f.trigger.type === 'webhook')
      .map(f => ({
        flowId: f.id,
        name: f.name,
        enabled: !!f.enabled,
        vars: Object.keys(f.lastVars || {}),
        lastVars: f.lastVars || {},
        lastVarsAt: f.lastVarsAt || null
      }));
    res.json({ hooks });
  });

  // ============ LOG DO WEBHOOK ============

  router.get('/webhook-log', auth, (req, res) => {
    let events = db.get().webhookLog;
    if (req.session.kind !== 'admin') {
      events = events.filter(e => e.accountId === req.acc.id);
    }
    res.json({ events: events.slice(0, 100) });
  });

  // ============ ASSINATURA & CARTEIRA (SaaS via Woovi — Pix / Pix Automático) ============
  const woovi = require('./woovi');
  const saas = require('./saasbilling');   // planos do Koonfy no cartão

  function billingPublic(acc) {
    const b = acc.billing;
    const plan = db.get().plans.find(p => p.id === b.planId) || null;
    const now = Date.now();
    let status = b.status;
    if ((status === 'trial' || status === 'active') && b.periodEnd && b.periodEnd < now) status = 'past_due';
    return {
      status, planId: b.planId, plan,
      periodEnd: b.periodEnd, startedAt: b.startedAt, canceledAt: b.canceledAt,
      pixAutomatic: !!b.wooviSubId,
      pendingCharge: b.pendingCharge,
      trialDays: db.get().platform.billing.trialDays
    };
  }

  router.get('/billing', auth, ownerOnly, (req, res) => {
    const cfg = db.get().platform.affiliate || {};
    const myRefs = db.get().accounts.filter(a => a.affiliate && a.affiliate.refBy === req.acc.affiliate.code);
    res.json({
      billing: billingPublic(req.acc),
      plans: db.get().plans.filter(p => !p.archived),
      wallet: { balance: req.acc.wallet.balance, transactions: req.acc.wallet.transactions.slice(-30).reverse() },
      affiliate: {
        code: req.acc.affiliate.code, earned: req.acc.affiliate.earned,
        percentFirst: cfg.percentFirst, percentRenewal: cfg.percentRenewal,
        referrals: myRefs.map(a => ({ name: a.name, createdAt: a.createdAt, status: billingPublic(a).status }))
      },
      withdrawals: db.get().withdrawals.filter(w => w.accountId === req.acc.id).slice(-10).reverse(),
      wooviReady: woovi.configured(),
      // Faixas definidas no Admin SaaS. O painel usa para orientar o usuário
      // ANTES de enviar (mostra o mínimo, trava o campo) — a validação de
      // verdade continua no servidor, aqui é só conveniência.
      limitesCarteira: {
        deposito: { ...db.get().platform.billing.deposit },
        saque: { ...db.get().platform.affiliate.withdraw }
      },
      // carteira detalhada: disponível, a liberar e a próxima liberação
      walletDetail: (() => {
        const w = req.acc.wallet;
        const prox = (w.receivables || []).filter(r => !r.released).sort((a, b) => a.availableAt - b.availableAt)[0] || null;
        return {
          balance: w.balance, pending: w.pending, cardAvailable: w.cardAvailable,
          nextRelease: prox ? { amount: prox.amount, at: prox.availableAt } : null,
          receivables: (w.receivables || []).filter(r => !r.released)
            .sort((a, b) => a.availableAt - b.availableAt).slice(0, 12)
            .map(r => ({ amount: r.amount, at: r.availableAt, kind: r.kind, installment: r.installment, installments: r.installments }))
        };
      })(),
      cardAccount: elitepay.cardCapability(req.acc),   // modo (carteira/split) + prazos
      // meios de pagamento do PRÓPRIO Koonfy (Pix + cartão), uso x limites e
      // preço das unidades extras — tudo que a tela de Assinatura precisa.
      card: saas.methods(),
      usage: limits.report(req.acc),
      extraPrices: limits.extraPrices(),
      extras: req.acc.billing.extras,
      extrasCost: limits.extrasCost(req.acc),
      // O cartão que a conta já usou na fatura. Sai daqui o suficiente para a
      // tela preencher sozinha e oferecer "pagar no cartão salvo" — nunca o
      // número nem o token, que ficam no servidor.
      savedCard: {
        last4: req.acc.billing.card.last4 || '',
        brand: req.acc.billing.card.brand || '',
        holderName: req.acc.billing.card.holderName || '',
        taxId: req.acc.billing.taxId || '',
        reusable: !!req.acc.billing.card.token,
        method: req.acc.billing.method || 'pix'
      }
    });
  });

  // ---- ASSINAR PELO CHECKOUT DO DONO ----
  // Cria a cobrança na conta do ADMIN, com o checkout que o plano aponta, e
  // devolve o link. É o caminho que o cliente trancado usa para assinar.
  router.post('/billing/checkout', auth, ownerOnly, h(async (req, res) => {
    const plan = db.get().plans.find(p => p.id === (req.body || {}).planId && !p.archived);
    if (!plan) return res.status(400).json({ error: 'Plano não encontrado' });
    const admin = db.findAdminAccount();
    const ch = await elitepay.createCharge(admin, {
      valueCents: plan.price,
      comment: 'Koonfy: ' + plan.name,
      contactName: req.acc.name,
      waId: String((req.acc.profile || {}).phone || '').replace(/\D/g, '') || null,
      origin: 'saas',
      checkoutId: plan.checkoutId || '',
      saas: { accountId: req.acc.id, planId: plan.id }
    });
    res.json({ payUrl: ch.payUrl, chargeId: ch.id, amount: ch.value });
  }));

  // ---- Assinar o plano no CARTÃO DE CRÉDITO ----
  // Diferente do Pix, o cartão é síncrono: aprovou, a assinatura já ativa.
  router.post('/billing/subscribe-card', auth, ownerOnly, h(async (req, res) => {
    const b = req.body || {};
    const plan = db.get().plans.find(p => p.id === b.planId && !p.archived);
    if (!plan) return res.status(400).json({ error: 'Plano não encontrado' });
    res.json(await saas.subscribe(req.acc, plan, b, broadcast));
  }));

  // ---- Assinar o plano no BOLETO (compensa em 1 a 2 dias úteis) ----
  router.post('/billing/subscribe-boleto', auth, ownerOnly, h(async (req, res) => {
    const b = req.body || {};
    const plan = db.get().plans.find(p => p.id === b.planId && !p.archived);
    if (!plan) return res.status(400).json({ error: 'Plano não encontrado' });
    res.json(await saas.subscribeBoleto(req.acc, plan, b, broadcast));
  }));

  // ---- Assinar usando o SALDO da carteira (vendas no cartão viram plano) ----
  router.post('/billing/subscribe-wallet', auth, ownerOnly, h(async (req, res) => {
    const plan = db.get().plans.find(p => p.id === (req.body || {}).planId && !p.archived);
    if (!plan) return res.status(400).json({ error: 'Plano não encontrado' });
    res.json(saas.subscribeWallet(req.acc, plan, broadcast));
  }));

  // ---- Comprar unidades EXTRAS (WhatsApp / links rastreáveis adicionais) ----
  router.post('/billing/extras', auth, ownerOnly, h(async (req, res) => {
    const b = req.body || {};
    res.json(await saas.buyExtra(req.acc, String(b.key || ''), b.qty, b, broadcast));
  }));

  // Assinar um plano: cria assinatura recorrente (Pix Automático) quando habilitado
  // e a cobrança Pix do 1º pagamento — QR exibido inline na página (sem pop-up).
  router.post('/billing/subscribe', auth, ownerOnly, h(async (req, res) => {
    const plan = db.get().plans.find(p => p.id === (req.body || {}).planId && !p.archived);
    if (!plan) return res.status(400).json({ error: 'Plano não encontrado' });
    const acc = req.acc;

    const customer = { name: acc.name, email: acc.email };
    const cid = `sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;
    // Plano + unidades extras já contratadas. Cobrar só `plan.price` faria a
    // recorrência nascer menor que a conta real e os extras nunca mais seriam
    // cobrados — o cartão sempre usou este mesmo total.
    const total = limits.chargeTotal(acc, plan);

    // Pix Automático (assinatura recorrente na Woovi) — a 1ª cobrança vem junto
    if (db.get().platform.woovi.pixAutomatic) {
      try {
        const sub = await woovi.createSubscription({
          correlationID: cid, value: total, customer,
          comment: `Koonfy: ${plan.name} (mensal)`
        });
        acc.billing.wooviSubId = sub.globalID || sub.id || '';
        acc.billing.subCorrelationID = cid;
        acc.billing.subValue = total;
      } catch (e) {
        store.logEvent({ type: 'woovi_sub_fallback', accountId: acc.id, error: e.message });
        // segue com cobrança avulsa (renovação manual)
      }
    }

    const charge = await woovi.createCharge({
      correlationID: cid, value: total, customer,
      comment: `Koonfy: assinatura ${plan.name}`
    });
    acc.billing.pendingCharge = {
      correlationID: cid, kind: 'sub', planId: plan.id, amount: total,
      brCode: charge.brCode || '', qrCodeImage: charge.qrCodeImage || '',
      paymentLinkUrl: charge.paymentLinkUrl || '', ts: Date.now()
    };
    db.save();
    res.json({ charge: acc.billing.pendingCharge, pixAutomatic: !!acc.billing.wooviSubId });
  }));

  // Recarga de saldo na carteira via Pix
  router.post('/billing/topup', auth, ownerOnly, h(async (req, res) => {
    // Cartão é síncrono: aprovou, o saldo entra na hora. O Pix segue abaixo,
    // gerando o QR e esperando o webhook confirmar.
    if ((req.body || {}).method === 'card') {
      const cents = Math.round(Number(String((req.body || {}).amount || '0').replace(',', '.')) * 100);
      return res.json(await topup.recargaCartao(req.acc, cents, req.body, broadcast));
    }
    const amount = Math.round(Number(String((req.body || {}).amount || '0').replace(',', '.')) * 100);
    // Faixa definida pelo admin em Admin SaaS → Pagamentos.
    const dep = db.get().platform.billing.deposit;
    if (!amount || amount < dep.min) {
      return res.status(400).json({ error: `Depósito mínimo: ${elitepay.fmtBRL(dep.min)}` });
    }
    if (dep.max > 0 && amount > dep.max) {
      return res.status(400).json({ error: `Depósito máximo: ${elitepay.fmtBRL(dep.max)}` });
    }
    const cid = `topup-${req.acc.id}-${Date.now().toString(36)}`;
    const charge = await woovi.createCharge({
      correlationID: cid, value: amount,
      customer: { name: req.acc.name, email: req.acc.email },
      comment: 'Koonfy: recarga de saldo'
    });
    req.acc.billing.pendingCharge = {
      correlationID: cid, kind: 'topup', planId: '', amount,
      brCode: charge.brCode || '', qrCodeImage: charge.qrCodeImage || '',
      paymentLinkUrl: charge.paymentLinkUrl || '', ts: Date.now()
    };
    db.save();
    res.json({ charge: req.acc.billing.pendingCharge });
  }));

  // ---- RECARGA AUTOMÁTICA da carteira ----
  // No Pix devolve a assinatura da Woovi, que o cliente autoriza uma vez no
  // banco dele; no cartão basta guardar a regra, porque o cartão salvo já
  // está autorizado. Desligar cancela a recorrência na Woovi.
  router.put('/wallet/auto-topup', auth, ownerOnly, h(async (req, res) => {
    res.json(await topup.configurarAuto(req.acc, req.body || {}, broadcast));
  }));

  // Polling do pagamento pendente (o webhook é a via principal; isto cobre localhost).
  // Cada meio consulta onde a cobrança realmente foi criada: Pix na Woovi,
  // boleto no adquirente.
  router.get('/billing/pending', auth, ownerOnly, h(async (req, res) => {
    const pc = req.acc.billing.pendingCharge;
    if (!pc) return res.json({ paid: false, none: true });
    if (pc.via === 'boleto') return res.json(await saas.checkBoleto(req.acc, broadcast));
    const charge = await woovi.getCharge(pc.correlationID);
    if (charge && /COMPLETED|CONFIRMED|PAID/i.test(charge.status || '')) {
      woovi.applyPayment(charge, broadcast);
      return res.json({ paid: true });
    }
    res.json({ paid: false, status: charge && charge.status });
  }));

  router.post('/billing/pending/cancel', auth, ownerOnly, h(async (req, res) => {
    const pc = req.acc.billing.pendingCharge;
    // O boleto não é apagado no adquirente: se o cliente pagar depois, o webhook
    // ainda casa a cobrança. Aqui só sai da tela.
    if (pc && pc.via !== 'boleto') await woovi.deleteCharge(pc.correlationID);
    if (pc) { req.acc.billing.pendingCharge = null; db.save(); }
    res.json({ ok: true });
  }));

  // Cancelar assinatura (mantém acesso até o fim do período pago)
  router.post('/billing/cancel', auth, ownerOnly, h(async (req, res) => {
    const b = req.acc.billing;
    if (b.wooviSubId) { await woovi.cancelSubscription(b.wooviSubId); b.wooviSubId = ''; }
    b.subCorrelationID = '';
    b.status = 'canceled';
    b.canceledAt = Date.now();
    db.save();
    store.logEvent({ type: 'billing_canceled', accountId: req.acc.id });
    res.json({ billing: billingPublic(req.acc) });
  }));

  // Saque do saldo da carteira (comissões de afiliado) — admin aprova e paga
  router.post('/wallet/withdraw', auth, ownerOnly, (req, res) => {
    const amount = Math.round(Number(String((req.body || {}).amount || '0').replace(',', '.')) * 100);
    const pixKey = String((req.body || {}).pixKey || '').trim();
    if (!pixKey) return res.status(400).json({ error: 'Informe sua chave Pix' });
    // Faixa definida pelo admin em Admin SaaS → Afiliados.
    const wd = db.get().platform.affiliate.withdraw;
    if (!amount || amount < wd.min) {
      return res.status(400).json({ error: `Saque mínimo: ${elitepay.fmtBRL(wd.min)}` });
    }
    if (wd.max > 0 && amount > wd.max) {
      return res.status(400).json({ error: `Saque máximo por vez: ${elitepay.fmtBRL(wd.max)}` });
    }
    if (amount > req.acc.wallet.balance) return res.status(400).json({ error: 'Saldo insuficiente' });
    // A taxa depende da ORIGEM do dinheiro: venda no cartão tem taxa própria,
    // o resto (Pix, comissões) usa a taxa de PIX Out.
    const f = elitepay.computeWithdrawFee(req.acc, amount);
    elitepay.debitWithdraw(req.acc, amount);
    const detalhe = f.fee
      ? ` · taxa ${elitepay.fmtBRL(f.fee)}${f.fromCard ? ` (cartão ${elitepay.fmtBRL(f.cardFee)}` + (f.pixFee ? ` + Pix ${elitepay.fmtBRL(f.pixFee)})` : ')') : ''}`
      : '';
    req.acc.wallet.transactions.push({
      id: db.genId('tx'), ts: Date.now(), amount: -amount, type: 'withdraw',
      label: `Saque para ${pixKey}${detalhe}`
    });
    db.get().withdrawals.push({
      id: db.genId('wd'), accountId: req.acc.id, accountName: req.acc.name,
      amount, fee: f.fee, net: f.net, fromCard: f.fromCard, fromPix: f.fromPix,
      pixKey, status: 'pending', ts: Date.now()
    });
    db.save();
    res.json({ ok: true, balance: req.acc.wallet.balance, fee: f.fee, net: f.net });
  });

  // Resumo da carteira para o cabeçalho: saldo e a faixa de depósito.
  // É de propósito muito mais leve que GET /billing — o topo recarrega isto a
  // cada evento `wallet` do SSE, e puxar a tela de assinatura inteira só para
  // atualizar um número seria desperdício.
  router.get('/wallet/summary', auth, ownerOnly, (req, res) => {
    res.json({
      balance: req.acc.wallet.balance,
      pending: req.acc.wallet.pending,
      deposito: { ...db.get().platform.billing.deposit },
      autoTopup: topup.publico(req.acc),
      // a tela precisa saber se dá para oferecer cartão e se há um salvo
      methods: require('./saasbilling').methods(),
      savedCard: {
        brand: req.acc.billing.card.brand || '',
        last4: req.acc.billing.card.last4 || '',
        reusable: !!req.acc.billing.card.token
      }
    });
  });

  // Prévia da taxa antes de confirmar o saque (a UI mostra o líquido ao digitar).
  router.get('/wallet/withdraw/quote', auth, ownerOnly, (req, res) => {
    const amount = Math.round(Number(String(req.query.amount || '0').replace(',', '.')) * 100);
    if (!amount || amount < 0) return res.json({ amount: 0, fee: 0, net: 0 });
    res.json({ amount, ...elitepay.computeWithdrawFee(req.acc, amount) });
  });

  // ============ ADMIN SaaS (métricas, contas, planos, afiliados, saques) ============

  router.get('/admin/saas', auth, adminOnly, (req, res) => {
    const data = db.get();
    const now = Date.now();
    // As contas INTERNAS ficam fora das métricas: elas não pagam, e contá-las
    // como assinantes inflaria MRR, total de contas e conversão.
    const accs = data.accounts.filter(a => !a.isAdmin && !a.unlimited);
    const internas = data.accounts.filter(a => !a.isAdmin && a.unlimited);
    const active = accs.filter(a => a.billing.status === 'active' && a.billing.periodEnd > now);
    const mrr = active.reduce((s, a) => { const p = data.plans.find(x => x.id === a.billing.planId); return s + (p ? p.price : 0); }, 0);
    // Receita inclui TUDO que entrou: assinaturas, renovações E recargas (depósitos na carteira).
    const rev30 = data.revenue.filter(r => r.ts >= now - 30 * 86400000).reduce((s, r) => s + r.amount, 0);

    // ---- Série mensal (12 meses): receita por tipo + novas contas ----
    const base = new Date(); base.setHours(0, 0, 0, 0);
    const series = [];
    for (let i = 11; i >= 0; i--) {
      const s = new Date(base.getFullYear(), base.getMonth() - i, 1);
      const e = new Date(base.getFullYear(), base.getMonth() - i + 1, 1);
      const rows = data.revenue.filter(r => r.ts >= s.getTime() && r.ts < e.getTime());
      const kSum = k => rows.filter(r => r.kind === k).reduce((a, r) => a + r.amount, 0);
      series.push({
        label: datas.mesCurto(s.getTime()),
        ym: s.toISOString().slice(0, 7),
        total: rows.reduce((a, r) => a + r.amount, 0),
        first: kSum('first'), renewal: kSum('renewal'), topup: kSum('topup'),
        newAccounts: accs.filter(a => a.createdAt >= s.getTime() && a.createdAt < e.getTime()).length
      });
    }
    // ---- Receita recorrente por plano ----
    const byPlan = data.plans.filter(p => !p.archived).map(p => {
      const subs = active.filter(a => a.billing.planId === p.id);
      return { id: p.id, name: p.name, price: p.price, subscribers: subs.length, mrr: subs.length * p.price };
    }).sort((a, b) => b.mrr - a.mrr);
    // ---- Métricas avançadas ----
    const paidRev = data.revenue.filter(r => r.kind !== 'topup');
    const first30 = data.revenue.filter(r => r.ts >= now - 30 * 86400000 && r.kind === 'first').length;
    const renew30 = data.revenue.filter(r => r.ts >= now - 30 * 86400000 && r.kind === 'renewal').length;
    const curM = series[11].total, prevM = series[10] ? series[10].total : 0;
    const trialsCount = accs.filter(a => a.billing.status === 'trial' && a.billing.periodEnd > now).length;
    const advanced = {
      arpu: active.length ? Math.round(mrr / active.length) : 0,                 // receita média por assinante ativo
      avgTicket: paidRev.length ? Math.round(paidRev.reduce((a, r) => a + r.amount, 0) / paidRev.length) : 0,
      conversion: accs.length ? Math.round(active.length / accs.length * 100) : 0, // % de contas que viraram assinantes
      newSubs30d: first30, renewals30d: renew30,
      momGrowth: prevM ? Math.round((curM - prevM) / prevM * 100) : (curM ? 100 : 0),
      ltv: active.length && mrr ? Math.round((paidRev.reduce((a, r) => a + r.amount, 0) / Math.max(1, active.length))) : 0,
      walletFloat: accs.reduce((a, x) => a + (x.wallet ? x.wallet.balance : 0), 0)
    };

    res.json({
      metrics: {
        accounts: accs.length,
        activeSubs: active.length,
        trials: trialsCount,
        mrr, revenue30d: rev30,
        totalRevenue: data.revenue.reduce((s, r) => s + r.amount, 0),   // inclui recargas da carteira
        deposits: data.revenue.filter(r => r.kind === 'topup').reduce((s, r) => s + r.amount, 0),
        pendingWithdrawals: data.withdrawals.filter(w => w.status === 'pending').length
      },
      series, byPlan, advanced,
      // O admin precisa saber ONDE o banco está gravando. Em host de container
      // o disco volta ao estado da imagem a cada restart, e o painel é o único
      // lugar onde ele vai ver isso antes de perder os dados.
      armazenamento: { motor: db.storage.nome, efemero: db.storage.efemero() },
      accounts: accs.map(a => ({
        id: a.id, name: a.name, email: a.email, createdAt: a.createdAt,
        waConnected: !!(a.wa && a.wa.connected),
        billing: billingPublic(a), walletBalance: a.wallet.balance,
        refCode: a.affiliate.code, refBy: a.affiliate.refBy || '',
        referrals: data.accounts.filter(x => x.affiliate && x.affiliate.refBy === a.affiliate.code).length,
        affEarned: a.affiliate.earned,
        profile: a.profile || {}, unlimited: !!a.unlimited
      })).concat(internas.map(a => ({
        id: a.id, name: a.name, email: a.email, createdAt: a.createdAt,
        waConnected: !!(a.wa && a.wa.connected),
        billing: billingPublic(a), walletBalance: a.wallet.balance,
        refCode: a.affiliate.code, refBy: a.affiliate.refBy || '',
        referrals: 0, affEarned: a.affiliate.earned,
        profile: a.profile || {}, unlimited: true
      }))).sort((a, b) => b.createdAt - a.createdAt),
      plans: data.plans,
      withdrawals: data.withdrawals.slice(-50).reverse(),
      revenue: data.revenue.slice(-100).reverse(),
      config: { woovi: { appId: data.platform.woovi.appId ? '••••' + data.platform.woovi.appId.slice(-6) : '', configured: woovi.configured(), pixAutomatic: data.platform.woovi.pixAutomatic, sandbox: !!data.platform.woovi.sandbox, base: woovi.base() }, billing: data.platform.billing, affiliate: data.platform.affiliate, landing: data.platform.landing },
      // Credenciais do app da Meta (Tech Provider). Rota já é adminOnly, então
      // o cliente nunca recebe isto: a configuração vive só no Admin SaaS.
      platform: {
        appId: data.platform.appId || '',
        configId: data.platform.configId || '',
        verifyToken: data.platform.verifyToken || '',
        graphVersion: data.platform.graphVersion || 'v26.0',
        // segredos NUNCA voltam: a tela só precisa saber que existem
        hasAppSecret: !!data.platform.appSecret,
        hasSystemToken: !!data.platform.systemToken,
        metaAds: { appId: (data.platform.metaAds || {}).appId || '', hasAppSecret: !!(data.platform.metaAds || {}).appSecret }
      },
      // conexão manual do PRÓPRIO admin (testes/desenvolvimento)
      manual: { accessToken: req.wctx.wa.accessToken || '', wabaId: req.wctx.wa.wabaId || '', phoneNumberId: req.wctx.wa.phoneNumberId || '' },
      // adquirente de cartão — configurável aqui na aba Pagamentos
      card: {
        ...require('./cardgateways').adminCard(elitepay.cardConfig()),
        webhookUrl: `${req.protocol}://${req.get('host')}/card-webhook`,
        webhookToken: elitepay.cardWebhookToken()
      },
      seo: data.platform.seo || {}
    });
  });

  // SEO da página de marketing (injetado no <head> em tempo de requisição).
  router.put('/admin/seo', auth, adminOnly, (req, res) => {
    const p = db.get().platform;
    const cur = p.seo || {};
    const str = (k, max = 600) => typeof req.body[k] === 'string' ? String(req.body[k]).slice(0, max) : cur[k];
    p.seo = {
      title: str('title', 180),
      description: str('description', 400),
      keywords: str('keywords', 400),
      ogTitle: str('ogTitle', 180),
      ogDescription: str('ogDescription', 400),
      ogImage: str('ogImage', 600),
      themeColor: str('themeColor', 20),
      canonical: str('canonical', 400),
      author: str('author', 120),
      robots: str('robots', 60),
      gaId: str('gaId', 40),
      extraHead: str('extraHead', 4000)
    };
    db.save();
    res.json({ ok: true, seo: p.seo });
  });

  router.post('/admin/plans', auth, adminOnly, (req, res) => {
    const { name, price, periodDays, features } = req.body || {};
    const cents = Math.round(Number(String(price || '0').replace(',', '.')) * 100);
    if (!name || !cents || cents < 100) return res.status(400).json({ error: 'Informe nome e preço válidos (mín. R$ 1,00)' });
    const plan = {
      id: db.genId('pl'), name: String(name).trim(), price: cents,
      periodDays: Number(periodDays) || 30,
      features: String(features || '').split('\n').map(s => s.trim()).filter(Boolean),
      // tetos do plano: disparos, contatos, fluxos, pixels, links e WhatsApps
      limits: db.normLimits((req.body || {}).limits),
      modules: db.normFeatures((req.body || {}).modules),
      checkoutId: String((req.body || {}).checkoutId || '').trim(),
      createdAt: Date.now(), archived: false
    };
    db.get().plans.push(plan);
    db.save();
    res.json({ plan });
  });

  router.put('/admin/plans/:id', auth, adminOnly, (req, res) => {
    const plan = db.get().plans.find(p => p.id === req.params.id);
    if (!plan) return res.status(404).json({ error: 'Plano não encontrado' });
    const b = req.body || {};
    if (typeof b.name === 'string' && b.name.trim()) plan.name = b.name.trim();
    if (b.price !== undefined) {
      const cents = Math.round(Number(String(b.price).replace(',', '.')) * 100);
      if (cents >= 100) plan.price = cents;
    }
    if (b.periodDays) plan.periodDays = Number(b.periodDays) || plan.periodDays;
    if (b.features !== undefined) plan.features = String(b.features).split('\n').map(s => s.trim()).filter(Boolean);
    if (b.limits !== undefined) plan.limits = db.normLimits(b.limits, plan.limits);
    if (b.modules !== undefined) plan.modules = db.normFeatures(b.modules, plan.modules);
    if (b.checkoutId !== undefined) plan.checkoutId = String(b.checkoutId || '').trim();
    if (b.archived !== undefined) plan.archived = !!b.archived;
    db.save();
    res.json({ plan });
  });

  router.delete('/admin/plans/:id', auth, adminOnly, (req, res) => {
    const plan = db.get().plans.find(p => p.id === req.params.id);
    if (plan) { plan.archived = true; db.save(); } // arquiva (assinantes ativos continuam)
    res.json({ ok: true });
  });

  router.put('/admin/config', auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const p = db.get().platform;
    if (b.wooviAppId !== undefined) p.woovi.appId = String(b.wooviAppId).trim();
    if (b.pixAutomatic !== undefined) p.woovi.pixAutomatic = !!b.pixAutomatic;
    if (b.wooviSandbox !== undefined) p.woovi.sandbox = !!b.wooviSandbox;
    if (b.trialDays !== undefined) p.billing.trialDays = Math.max(0, Number(b.trialDays) || 0);
    if (b.enforce !== undefined) p.billing.enforce = !!b.enforce;
    if (b.requirePlan !== undefined) p.billing.requirePlan = !!b.requirePlan;
    // preço mensal de cada unidade EXCEDENTE ao que o plano já inclui
    const cents = v => Math.max(0, Math.round(Number(String(v).replace(',', '.')) * 100) || 0);
    if (b.whatsappPrice !== undefined) p.billing.extras.whatsappPrice = cents(b.whatsappPrice);
    if (b.linkPrice !== undefined) p.billing.extras.linkPrice = cents(b.linkPrice);
    if (b.ctaText !== undefined) p.landing.ctaText = String(b.ctaText).slice(0, 40);
    if (b.percentFirst !== undefined) p.affiliate.percentFirst = Math.min(90, Math.max(0, Number(b.percentFirst) || 0));
    if (b.percentRenewal !== undefined) p.affiliate.percentRenewal = Math.min(90, Math.max(0, Number(b.percentRenewal) || 0));

    // Faixas de depósito (carteira) e de saque (comissão do afiliado).
    // Máximo 0 = sem teto. O mínimo nunca passa do máximo, senão a faixa
    // ficaria vazia e ninguém conseguiria transacionar.
    if (b.depositMin !== undefined) p.billing.deposit.min = Math.max(0, cents(b.depositMin));
    if (b.depositMax !== undefined) p.billing.deposit.max = Math.max(0, cents(b.depositMax));
    if (p.billing.deposit.max > 0 && p.billing.deposit.min > p.billing.deposit.max) {
      p.billing.deposit.min = p.billing.deposit.max;
    }
    if (b.withdrawMin !== undefined) p.affiliate.withdraw.min = Math.max(0, cents(b.withdrawMin));
    if (b.withdrawMax !== undefined) p.affiliate.withdraw.max = Math.max(0, cents(b.withdrawMax));
    if (p.affiliate.withdraw.max > 0 && p.affiliate.withdraw.min > p.affiliate.withdraw.max) {
      p.affiliate.withdraw.min = p.affiliate.withdraw.max;
    }

    db.save();
    res.json({ ok: true });
  });

  // ---- SMS (Integra X): liga/desliga e credenciais da plataforma ----
  // ---- MARKETING da plataforma: templates e disparos para os CLIENTES ----
  router.get('/admin/marketing', auth, adminOnly, (req, res) => res.json(marketing.adminView()));

  router.post('/admin/marketing/templates', auth, adminOnly, (req, res) => {
    res.json({ template: marketing.salvarTemplate(req.body || {}), view: marketing.adminView() });
  });

  router.delete('/admin/marketing/templates/:id', auth, adminOnly, (req, res) => {
    marketing.removerTemplate(req.params.id);
    res.json({ view: marketing.adminView() });
  });

  // Prévia com um destinatário real: o admin vê o texto já preenchido antes de
  // mandar para dezenas de contas.
  router.post('/admin/marketing/preview', auth, adminOnly, (req, res) => {
    res.json({ preview: marketing.previa(req.body || {}) });
  });

  router.post('/admin/marketing/send', auth, adminOnly, h(async (req, res) => {
    const origin = req.protocol + '://' + req.get('host');
    const r = await marketing.disparar(req.body || {}, { origin, broadcast });
    res.json({ campaign: r, view: marketing.adminView() });
  }));

  // ---- E-mail (SMTP) e segurança da plataforma ----
  router.get('/admin/mail', auth, adminOnly, (req, res) => {
    res.json({ mail: mailer.adminView(), security: account.seguranca() });
  });

  router.put('/admin/mail', auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const c = mailer.cfg();
    if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
    for (const k of ['host', 'user', 'from', 'fromName']) {
      if (typeof b[k] === 'string') c[k] = b[k].trim();
    }
    if (b.port !== undefined) c.port = Math.max(1, Math.min(65535, Number(b.port) || 587));
    if (typeof b.secure === 'boolean') c.secure = b.secure;
    // senha em branco NÃO apaga a que está guardada: a tela nunca a recebe de
    // volta, então mandar vazio significa "não mexi nesse campo".
    if (typeof b.pass === 'string' && b.pass) c.pass = b.pass;
    db.save();
    res.json({ mail: mailer.adminView() });
  });

  router.post('/admin/mail/test', auth, adminOnly, h(async (req, res) => {
    const para = String((req.body || {}).to || db.get().platform.adminUser || '').trim();
    try {
      await mailer.enviar({
        to: para,
        subject: 'Teste de envio do Koonfy',
        text: 'Se você recebeu este e-mail, o envio está funcionando.',
        html: '<p>Se você recebeu este e-mail, o envio está funcionando.</p>'
      });
      res.json({ ok: true });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  }));

  router.put('/admin/security', auth, adminOnly, (req, res) => {
    const sec = account.seguranca();
    if (typeof (req.body || {}).twoFactor === 'boolean') sec.twoFactor = req.body.twoFactor;
    db.save();
    res.json({ security: sec });
  });

  router.get('/admin/sms', auth, adminOnly, (req, res) => {
    res.json({ sms: sms.adminView() });
  });

  router.put('/admin/sms', auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const c = sms.cfg();
    if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
    // token vazio = manter o que já está salvo (o painel nunca recebe o valor)
    if (typeof b.token === 'string' && b.token.trim()) c.token = b.token.trim();
    if (b.token === null) c.token = '';                    // limpar de propósito
    if (typeof b.from === 'string') c.from = b.from.trim().slice(0, 20);
    if (typeof b.base === 'string') c.base = b.base.trim();
    if (typeof b.callbackUrl === 'string') c.callbackUrl = b.callbackUrl.trim();
    if (b.maxLen !== undefined) c.maxLen = Math.max(70, Math.min(1600, Number(b.maxLen) || 160));
    if (b.priceCents !== undefined) {
      c.priceCents = Math.max(0, Math.round(Number(String(b.priceCents).replace(',', '.')) * 100) || 0);
    }
    db.save();
    res.json({ sms: sms.adminView() });
  });

  // Testa a conexão e já traz o saldo de créditos.
  router.post('/admin/sms/test', auth, adminOnly, h(async (req, res) => {
    res.json(await sms.testar());
  }));

  // ---- Integração Nuvemshop (app único da plataforma) ----
  router.get('/admin/nuvemshop', auth, adminOnly, (req, res) => {
    res.json({ nuvemshop: nuvem.adminCfg(`${req.protocol}://${req.get('host')}`) });
  });

  router.put('/admin/nuvemshop', auth, adminOnly, (req, res) => {
    const p = nuvem.platformCfg();
    const b = req.body || {};
    if (typeof b.appId === 'string') p.appId = b.appId.trim();
    // secret vazio = manter o que já está salvo (o painel nunca recebe o valor)
    if (typeof b.appSecret === 'string' && b.appSecret.trim()) p.appSecret = b.appSecret.trim();
    if (typeof b.enabled === 'boolean') p.enabled = b.enabled;
    db.save();
    res.json({ nuvemshop: nuvem.adminCfg(`${req.protocol}://${req.get('host')}`) });
  });

  // Testa a conexão com a Woovi (lista 1 cobrança qualquer)
  router.get('/admin/woovi/test', auth, adminOnly, h(async (req, res) => {
    const r = await woovi.call('GET', '/api/v1/charge?limit=1');
    // Saber que conectou não basta: o AppID de testes conecta igual ao de
    // produção, e o admin precisa ver em QUAL dos dois a cobrança vai cair.
    res.json({ ok: true, charges: (r.charges || []).length, pageInfo: r.pageInfo || null,
      ambiente: woovi.ambiente(), base: woovi.base() });
  }));

  router.put('/admin/withdrawals/:id', auth, adminOnly, (req, res) => {
    const wd = db.get().withdrawals.find(w => w.id === req.params.id);
    if (!wd) return res.status(404).json({ error: 'Saque não encontrado' });
    const action = (req.body || {}).action;
    if (action === 'paid' && wd.status === 'pending') { wd.status = 'paid'; wd.paidAt = Date.now(); }
    if (action === 'reject' && wd.status === 'pending') {
      wd.status = 'rejected';
      const acc = db.findAccount(wd.accountId);
      if (acc) { // devolve o valor à carteira
        acc.wallet.balance += wd.amount;
        acc.wallet.transactions.push({ id: db.genId('tx'), ts: Date.now(), amount: wd.amount, type: 'refund', label: 'Saque recusado, valor devolvido' });
      }
    }
    db.save();
    res.json({ withdrawal: wd });
  });

  // ---- CONTAS CRIADAS PELO ADMIN ----
  // Para o dono abrir contas dos próprios negócios sem passar pelo cadastro
  // público, já marcando-as como internas.
  router.post('/admin/accounts', auth, adminOnly, (req, res) => {
    const b = req.body || {};
    const mail = String(b.email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Informe um e-mail válido' });
    if (!b.pass || String(b.pass).length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    if (db.findAccountByEmail(mail)) return res.status(409).json({ error: 'Já existe uma conta com este e-mail' });

    const acc = db.newAccount({ name: String(b.name || '').trim() || mail, email: mail, pass: String(b.pass) });
    acc.unlimited = !!b.unlimited;
    const perfil = b.profile || {};
    for (const k of ['segment', 'size', 'phone', 'goal']) acc.profile[k] = String(perfil[k] || '').trim().slice(0, 60);
    // Conta interna não tem período de teste para vencer; a comum ganha o
    // mesmo trial do cadastro público.
    if (!acc.unlimited) {
      acc.billing.periodEnd = Date.now() + (db.get().platform.billing.trialDays || 7) * 86400000;
    }
    db.get().accounts.push(acc);
    db.save();
    res.json({ ok: true, id: acc.id, unlimited: acc.unlimited });
  });

  // Liga/desliga o ilimitado de uma conta que já existe.
  router.put('/admin/accounts/:id/unlimited', auth, adminOnly, (req, res) => {
    const acc = db.findAccount(req.params.id);
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
    if (acc.isAdmin) return res.status(400).json({ error: 'A conta do administrador não entra nessa regra' });
    acc.unlimited = !!(req.body || {}).unlimited;
    db.save();
    res.json({ ok: true, unlimited: acc.unlimited });
  });

  // Admin ajusta manualmente a assinatura de uma conta (suporte)
  router.put('/admin/accounts/:id/billing', auth, adminOnly, (req, res) => {
    const acc = db.findAccount(req.params.id);
    if (!acc || acc.isAdmin) return res.status(404).json({ error: 'Conta não encontrada' });
    const b = req.body || {};
    if (b.planId !== undefined) acc.billing.planId = b.planId;
    if (b.status && ['trial', 'active', 'past_due', 'canceled'].includes(b.status)) acc.billing.status = b.status;
    if (b.extendDays) acc.billing.periodEnd = Math.max(Date.now(), acc.billing.periodEnd || 0) + Number(b.extendDays) * 86400000;
    db.save();
    res.json({ billing: billingPublic(acc) });
  });

  // ============ GEO (mapa de leads — Brasil) ============
  // Estado inferido pelo DDD do WhatsApp (+55 DD XXXXXXXXX)
  router.get('/geo', auth, (req, res) => {
    const states = {};
    let brTotal = 0, foreign = 0;
    for (const c of req.acc.contacts) {
      const uf = geo.ufOf(c.waId);   // tabela DDD→UF compartilhada (src/geo.js)
      if (uf) { states[uf] = (states[uf] || 0) + 1; brTotal++; continue; }
      foreign++;
    }
    // fontes de tráfego: anúncios CTWA + referrers dos links + orgânico
    const src = { ad: 0, organic: 0 };
    for (const c of req.acc.contacts) {
      if (c.source && c.source.type) src.ad++;
      else src.organic++;
    }
    const refMap = {};
    for (const l of req.acc.links || []) {
      for (const k of l.clicks) {
        let host = 'Direto';
        try { if (k.ref) host = new URL(k.ref).hostname.replace(/^www\./, ''); } catch {}
        refMap[host] = (refMap[host] || 0) + 1;
      }
    }
    res.json({
      states, brTotal, foreign,
      totalContacts: req.acc.contacts.length,
      sources: [
        { label: 'Anúncios (Click-to-WhatsApp)', count: src.ad },
        { label: 'Orgânico / direto', count: src.organic }
      ],
      referrers: Object.entries(refMap).map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count).slice(0, 6)
    });
  });

  // ============ SSE (atualizações em tempo real no painel) ============

  // ==================== ELITE PAY — pagamentos Pix do cliente ====================
  const elitepay = require('./elitepay');

  // Captura a URL pública (usada para montar o link do checkout /pay/:id,
  // inclusive em cobranças criadas por Flows, onde não há request).
  router.use((req, res, next) => {
    try { elitepay.noteBaseUrl(`${req.protocol}://${req.get('host')}`); } catch {}
    next();
  });

  // ---- CHECKOUT PÚBLICO (sem autenticação): dados da cobrança p/ a página /pay/:id ----
  router.get('/public/pay/:id', (req, res) => {
    const view = elitepay.publicChargeView(req.params.id);
    if (!view) return res.status(404).json({ error: 'Cobrança não encontrada' });
    // tags de navegador do lojista, para o checkout marcar InitiateCheckout
    const dono = elitepay.findChargeAnywhere ? elitepay.findChargeAnywhere(req.params.id) : null;
    if (dono && dono.acc) {
      try { view.tags = require('./tracking').clientTags(dono.acc, { event: 'InitiateCheckout' }); } catch {}
    }
    res.json(view);
  });

  // Etapa 1 do checkout: pagador preenche os dados → cria o cliente na Woovi,
  // cadastra o contato no Koonfy e registra os eventos na pipeline.
  router.post('/public/pay/:id/identify', h(async (req, res) => {
    const b = req.body || {};
    await elitepay.identifyPayer(req.params.id, {
      name: b.name, taxID: b.taxID, email: b.email, phone: b.phone, trk: b.trk
    }, broadcast);
    res.json({ ok: true, view: elitepay.publicChargeView(req.params.id) });
  }));

  // Pagamento com CARTÃO DE CRÉDITO da cobrança, quando o admin habilitou.
  // Os dados do cartão só transitam: nada de número completo ou CVV é gravado.
  router.post('/public/pay/:id/card', h(async (req, res) => {
    const r = await elitepay.payWithCard(req.params.id, req.body || {}, broadcast);
    res.json(r);
  }));

  // Emissão de BOLETO da cobrança. Assíncrono: a confirmação chega pelo webhook
  // do adquirente quando o banco compensa.
  router.post('/public/pay/:id/boleto', h(async (req, res) => {
    const r = await elitepay.payWithBoleto(req.params.id, req.body || {}, broadcast);
    res.json(r);
  }));

  // Reconsulta o adquirente quando o pagamento ficou em análise.
  router.get('/public/pay/:id/card-status', h(async (req, res) => {
    const status = await elitepay.refreshCardStatus(req.params.id, broadcast);
    res.json({ status, view: elitepay.publicChargeView(req.params.id) });
  }));

  // ==================== TRACKING — atribuição + métricas de marketing ====================
  const tracking = require('./tracking');

  // captura pública de eventos (checkout /pay e snippet /t.js) — sem autenticação
  router.post('/public/track/:accId', (req, res) => {
    const acc = db.findAccount(req.params.accId);
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
    const b = req.body || {};
    tracking.trackEvent(acc, {
      name: b.name, source: b.source, sid: b.sid, url: b.url, pixel: b.pixel,
      fbclid: b.fbclid, gclid: b.gclid, ttclid: b.ttclid, utm: b.utm, value: b.value
    });
    res.json({ ok: true });
  });

  router.get('/tracking', auth, can('tracking'), (req, res) => res.json(tracking.overview(req.acc)));
  router.get('/tracking/campaigns', auth, can('tracking'), (req, res) => res.json({ campaigns: tracking.campaignReport(req.acc) }));
  router.get('/tracking/funnel', auth, can('tracking'), (req, res) => res.json({ funnel: tracking.funnel(req.acc) }));
  router.get('/tracking/compare', auth, can('tracking'), (req, res) => res.json({ compare: tracking.compare(req.acc) }));
  router.get('/tracking/events', auth, can('tracking'), (req, res) => {
    const t = tracking.ensure(req.acc);
    res.json({ events: t.events.slice(0, 150) });
  });
  router.get('/tracking/customer/:waId', auth, can('tracking'), (req, res) => {
    res.json(tracking.customerTimeline(req.acc, store.normalizeWaId(req.params.waId)));
  });

  // conexões (Meta Pixel, CAPI, GA4, TikTok, GTM…)
  router.put('/tracking/connections/:key', auth, feat('tracking'), can('tracking', 'edit'), (req, res) => {
    const t = tracking.ensure(req.acc);
    const c = t.connections[req.params.key];
    if (!c) return res.status(404).json({ error: 'Conexão desconhecida' });
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
    if (typeof b.id === 'string') c.id = b.id.trim().slice(0, 120);
    if (typeof b.token === 'string' && b.token && b.token !== '••••') c.token = b.token.trim().slice(0, 400);
    db.save();
    res.json({ ok: true });
  });

  // Meta Ads (gasto automático das campanhas)
  router.put('/tracking/meta', auth, can('tracking', 'edit'), (req, res) => {
    const t = tracking.ensure(req.acc);
    const b = req.body || {};
    if (typeof b.adAccountId === 'string') t.meta.adAccountId = b.adAccountId.trim().slice(0, 60);
    if (typeof b.token === 'string' && b.token) t.meta.token = b.token.trim().slice(0, 500);
    db.save();
    res.json({ ok: true });
  });
  router.post('/tracking/meta/sync', auth, can('tracking', 'edit'), h(async (req, res) => {
    const m = await tracking.syncMetaAds(req.acc);
    broadcast('tracking', { accountId: req.acc.id, kind: 'meta_sync' });
    res.json({ ok: true, campaigns: m.campaigns.length, lastSync: m.lastSync });
  }));

  // ---- Conectar Meta Ads por OAuth (permissão ads_read) ----
  // Reusa o app da plataforma já configurado para o WhatsApp. O cliente
  // autoriza no popup e nunca precisa gerar token à mão.
  router.get('/tracking/meta/auth-url', auth, can('tracking', 'edit'), (req, res) => {
    if (!meta.adsConfigured()) {
      return res.status(400).json({ error: 'O Meta Ads ainda não foi habilitado pelo administrador. Fale com o suporte.' });
    }
    const estado = crypto.randomBytes(16).toString('hex');
    const t = tracking.ensure(req.acc);
    t.meta.oauthState = estado;
    t.meta.oauthAt = Date.now();
    db.save();
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/meta-ads/callback`;
    res.json({ url: meta.adsAuthUrl(redirectUri, estado), redirectUri });
  });

  router.post('/tracking/meta/connect', auth, can('tracking', 'edit'), h(async (req, res) => {
    const b = req.body || {};
    const t = tracking.ensure(req.acc);
    // o state precisa bater e ser recente: barra troca de token por CSRF
    if (!b.code || !b.state || b.state !== t.meta.oauthState || Date.now() - (t.meta.oauthAt || 0) > 10 * 60 * 1000) {
      return res.status(400).json({ error: 'Autorização inválida ou expirada. Tente conectar de novo.' });
    }
    t.meta.oauthState = '';
    const redirectUri = `${req.protocol}://${req.get('host')}/auth/meta-ads/callback`;
    const curto = await meta.exchangeAdsCode(b.code, redirectUri);
    // troca por token de 60 dias, senão a sincronização pararia em ~1 hora
    let token = curto.access_token, expira = 0;
    try {
      const longo = await meta.longLivedToken(curto.access_token);
      if (longo && longo.access_token) {
        token = longo.access_token;
        expira = Date.now() + (Number(longo.expires_in) || 60 * 86400) * 1000;
      }
    } catch { expira = Date.now() + 3600 * 1000; }

    t.meta.token = token;
    t.meta.expiresAt = expira;
    t.meta.expired = false;
    t.meta.error = '';
    db.save();

    // já devolve as contas de anúncio para o cliente escolher numa lista
    let contas = [];
    try {
      const r = await meta.getAdAccounts(token);
      contas = (r.data || []).map(a => ({
        id: 'act_' + a.account_id, name: a.name, currency: a.currency, status: a.account_status
      }));
    } catch (e) { t.meta.error = e.message; db.save(); }
    t.meta.adAccounts = contas;
    if (contas.length === 1 && !t.meta.adAccountId) t.meta.adAccountId = contas[0].id;
    db.save();
    res.json({ ok: true, adAccounts: contas, expiresAt: expira, adAccountId: t.meta.adAccountId });
  }));

  router.get('/tracking/meta/ad-accounts', auth, can('tracking', 'edit'), h(async (req, res) => {
    const t = tracking.ensure(req.acc);
    if (!t.meta.token) return res.status(400).json({ error: 'Conecte sua conta Meta Ads primeiro' });
    const r = await meta.getAdAccounts(t.meta.token);
    t.meta.adAccounts = (r.data || []).map(a => ({ id: 'act_' + a.account_id, name: a.name, currency: a.currency, status: a.account_status }));
    db.save();
    res.json({ adAccounts: (r.data || []).map(a => ({ id: 'act_' + a.account_id, name: a.name, currency: a.currency, status: a.account_status })) });
  }));

  router.delete('/tracking/meta', auth, can('tracking', 'edit'), (req, res) => {
    const t = tracking.ensure(req.acc);
    t.meta.token = ''; t.meta.adAccountId = ''; t.meta.campaigns = [];
    t.meta.expiresAt = 0; t.meta.expired = false; t.meta.error = '';
    db.save();
    res.json({ ok: true });
  });

  router.put('/tracking/alerts', auth, can('tracking', 'edit'), (req, res) => {
    const t = tracking.ensure(req.acc);
    const b = req.body || {};
    if (b.roasMin !== undefined) t.alerts.cfg.roasMin = Math.max(0, parseFloat(String(b.roasMin).replace(',', '.')) || 0);
    if (b.cpaMax !== undefined) t.alerts.cfg.cpaMax = Math.max(0, parseFloat(String(b.cpaMax).replace(',', '.')) || 0);
    db.save();
    res.json({ ok: true, cfg: t.alerts.cfg });
  });

  // Envia a cobrança na conversa do WhatsApp e registra no histórico do chat.
  // A cobrança vai como MENSAGEM DE TEXTO → precisa respeitar a janela de 24h da Meta.
  // Fora dela (ou atendimento finalizado), o envio é bloqueado e o motivo é informado.
  async function sendChargeMessage(acc, ch, waId, stamp) {
    const to = store.normalizeWaId(waId);
    const ep = acc.elitepay || {};

    // 1) Modelo de COBRANÇA selecionado e APROVADO → envia como template Meta
    //    (funciona inclusive fora da janela de 24h).
    //    Variáveis: {{1}} nome · {{2}} valor · {{3}} link · {{4}} Pix copia e cola
    //               {{5}} descrição · {{6}} vencimento
    const tpl = elitepay.pickTemplate(acc, 'cobranca');
    if (tpl) {
      const nVars = tpl.vars.length;
      const vals = elitepay.tplValues(acc, ch, 'cobranca');
      const components = nVars ? [{ type: 'body', parameters: vals.slice(0, nVars).map(t => ({ type: 'text', text: String(t || '-') })) }] : [];
      const r = await wa.sendTemplate(acc, to, tpl.name, tpl.language || ep.chargeTemplateLang || 'pt_BR', components);
      storeOutbound(acc, to, { type: 'template', text: `📋 Cobrança (${tpl.name}) · ${elitepay.fmtBRL(ch.value)}` }, r, stamp);
      elitepay.log(acc, { type: 'charge_sent', chargeId: ch.id, amount: ch.value, detail: `Cobrança enviada via template "${tpl.name}"` });
      db.save();
      return;
    }

    // 2) Fallback: mensagem de texto padrão → precisa respeitar a janela de 24h da Meta.
    const contact = store.findContact(acc, to);
    const check = contact ? session.canSend(contact, 'text') : { allowed: true };
    if (!check.allowed) {
      const e = new Error(check.error || 'A janela de 24h expirou, marque um Template de Cobrança em Modelos para enviar a qualquer momento.');
      e.status = 409; e.code = check.code || 'window_closed';
      elitepay.log(acc, { type: 'send_blocked', chargeId: ch.id, amount: ch.value, detail: '24h: ' + e.message });
      db.save();
      throw e;
    }
    const text = elitepay.chargeMessage(acc, ch);
    const r = await wa.sendText(acc, to, text);
    storeOutbound(acc, to, { type: 'text', text }, r, stamp);
    elitepay.log(acc, { type: 'charge_sent', chargeId: ch.id, amount: ch.value, detail: 'Cobrança enviada no WhatsApp para +' + to });
    db.save();
  }

  // Status geral do módulo (gate de onboarding do front)
  router.get('/elitepay', auth, can('elitepay'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const cfg = elitepay.platformCfg();
    res.json({
      configured: elitepay.configured(),
      subaccount: ep.subaccount,
      settings: ep.settings,
      checkout: ep.checkouts.find(c => c.isDefault) || ep.checkouts[0],   // layout padrão
      checkouts: ep.checkouts.map(c => ({ id: c.id, name: c.name, isDefault: c.isDefault })),
      products: ep.products.filter(p => p.active).map(p => ({ id: p.id, name: p.name, price: p.price, checkoutId: p.checkoutId })),
      // ---- MODELOS de mensagem do Elite Pay ----
      // Quando existe mais de um modelo do mesmo papel, o usuário escolhe qual
      // é enviado; com um só, ele já é o padrão.
      chargeTemplateName: ep.chargeTemplateName || '',
      confirmTemplateName: ep.confirmTemplateName || '',
      chargeTemplates: elitepay.templatesByRole(req.acc, 'cobranca'),
      confirmTemplates: elitepay.templatesByRole(req.acc, 'confirmacao'),
      roleVars: elitepay.TPL_VARS,
      feeInPercent: cfg.feeInPercent,       // taxa PIX In (por venda)
      feeOutPercent: cfg.feeOutPercent,     // taxa PIX Out (por saque)
      onboardingMode: cfg.onboardingMode,   // 'subaccount' | 'kyc'
      gateway: elitepay.gateway().label,
      card: elitepay.cardCapability(req.acc)   // {ready, credit, debit} p/ o Checkout Builder
    });
  });

  // Onboarding — cria a subconta do cliente (via API do gateway, sem sair do Koonfy)
  router.post('/elitepay/subaccount', auth, can('elitepay', 'create'), h(async (req, res) => {
    // redirectUrl: para onde a Woovi devolve o cliente após concluir o KYC hospedado
    const redirectUrl = `${req.protocol}://${req.get('host')}/app/#/elitepay`;
    const sub = await elitepay.registerSubaccount(req.acc, { ...(req.body || {}), redirectUrl });
    broadcast('elitepay', { accountId: req.acc.id, kind: 'subaccount', status: sub.status });
    res.json({ ok: true, subaccount: sub, onboardingUrl: sub.kyc ? sub.kyc.onboardingUrl : '' });
  }));

  // Dashboard financeiro do cliente
  router.get('/elitepay/dashboard', auth, can('elitepay'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    res.json({ metrics: elitepay.metrics(req.acc), recent: ep.charges.slice(0, 8), logs: ep.logs.slice(0, 20) });
  });

  // Histórico de cobranças com pesquisa e filtros
  router.get('/elitepay/charges', auth, can('elitepay'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const q = String(req.query.q || '').toLowerCase();
    const status = String(req.query.status || '');
    let list = ep.charges;
    if (status) list = list.filter(c => c.status === status);
    if (q) list = list.filter(c =>
      (c.contactName || '').toLowerCase().includes(q) ||
      (c.comment || '').toLowerCase().includes(q) ||
      (c.waId || '').includes(q.replace(/\D/g, '') || '§') ||
      c.id.includes(q));
    res.json({ charges: list.slice(0, 200), total: list.length });
  });

  // Nova cobrança (Pix + link + QR + copia e cola) — opcionalmente já envia no chat
  router.post('/elitepay/charges', auth, feat('elitepay'), can('elitepay', 'create'), h(async (req, res) => {
    const b = req.body || {};
    const contact = b.waId ? store.findContact(req.wctx, store.normalizeWaId(b.waId)) : null;
    const ch = await elitepay.createCharge(req.acc, {
      valueCents: b.valueCents, comment: b.comment,
      waId: contact ? contact.waId : (b.waId || null),
      contactName: contact ? contact.name : (b.contactName || null),
      origin: b.origin || 'manual', byName: req.who.name, expiresMin: b.expiresMin,
      productId: b.productId, checkoutId: b.checkoutId     // produto + layout escolhidos
    });
    let sent = false, sendError = null;
    if (b.send && ch.waId) {
      try { await sendChargeMessage(req.wctx, ch, ch.waId, { agentId: req.who.agentId, agentName: req.who.name }); sent = true; }
      catch (e) { sendError = e.message; if (e.code !== 'window_closed' && e.code !== 'attendance_finished') { elitepay.log(req.acc, { type: 'send_error', chargeId: ch.id, detail: e.message }); db.save(); } }
    }
    broadcast('elitepay', { accountId: req.acc.id, kind: 'charge', chargeId: ch.id, status: ch.status });
    res.json({ ok: true, charge: ch, sent, sendError });
  }));

  router.post('/elitepay/charges/:id/cancel', auth, can('elitepay', 'edit'), h(async (req, res) => {
    const ch = await elitepay.cancelCharge(req.acc, req.params.id);
    broadcast('elitepay', { accountId: req.acc.id, kind: 'charge', chargeId: ch.id, status: 'cancelled' });
    res.json({ ok: true, charge: ch });
  }));

  router.post('/elitepay/charges/:id/resend', auth, can('elitepay'), h(async (req, res) => {
    const ch = elitepay.findCharge(req.acc, req.params.id);
    if (!ch) return res.status(404).json({ error: 'Cobrança não encontrada' });
    const waId = req.body.waId || ch.waId;
    if (!waId) return res.status(400).json({ error: 'Cobrança sem contato vinculado, informe o destinatário' });
    await sendChargeMessage(req.wctx, ch, waId, { agentId: req.who.agentId, agentName: req.who.name });
    res.json({ ok: true });
  }));

  router.post('/elitepay/charges/:id/duplicate', auth, can('elitepay', 'create'), h(async (req, res) => {
    const old = elitepay.findCharge(req.acc, req.params.id);
    if (!old) return res.status(404).json({ error: 'Cobrança não encontrada' });
    const ch = await elitepay.createCharge(req.acc, {
      valueCents: old.value, comment: old.comment, waId: old.waId, contactName: old.contactName,
      origin: 'manual', byName: req.who.name
    });
    broadcast('elitepay', { accountId: req.acc.id, kind: 'charge', chargeId: ch.id, status: ch.status });
    res.json({ ok: true, charge: ch });
  }));

  router.put('/elitepay/settings', auth, can('elitepay', 'edit'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const b = req.body || {};
    if (typeof b.autoMessage === 'string') ep.settings.autoMessage = b.autoMessage.slice(0, 1200);
    if (b.expiresMin !== undefined) ep.settings.expiresMin = Math.max(5, Math.min(43200, Number(b.expiresMin) || 1440));
    if (typeof b.notifyPaid === 'boolean') ep.settings.notifyPaid = b.notifyPaid;
    if (typeof b.chargeTemplateEnabled === 'boolean') ep.settings.chargeTemplateEnabled = b.chargeTemplateEnabled;
    // Escolha do modelo enviado em cada papel (só aceita modelo com aquele papel).
    for (const [campo, role] of [['chargeTemplateName', 'cobranca'], ['confirmTemplateName', 'confirmacao']]) {
      if (typeof b[campo] !== 'string') continue;
      const nome = b[campo].trim();
      if (!nome) { ep[campo] = ''; continue; }
      const t = elitepay.templatesByRole(req.acc, role).find(x => x.name === nome);
      if (!t) return res.status(400).json({ error: `"${nome}" não é um modelo de ${role === 'cobranca' ? 'cobrança' : 'confirmação de pagamento'}` });
      ep[campo] = nome;
      ep[role === 'cobranca' ? 'chargeTemplateLang' : 'confirmTemplateLang'] = t.language || 'pt_BR';
    }
    db.save();
    res.json({
      ok: true, settings: ep.settings,
      chargeTemplateName: ep.chargeTemplateName, confirmTemplateName: ep.confirmTemplateName
    });
  });

  // ---- Checkout Builder: personalização da página pública de pagamento ----
  router.put('/elitepay/checkout', auth, can('elitepay', 'edit'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const b = req.body || {};
    // salva no template escolhido (ou no padrão, quando não vier id)
    const ck = (b.id && ep.checkouts.find(c => c.id === b.id)) || ep.checkouts.find(c => c.isDefault) || ep.checkouts[0];
    if (!ck) return res.status(404).json({ error: 'Checkout não encontrado' });
    if (typeof b.name === 'string' && b.name.trim()) ck.name = b.name.trim().slice(0, 60);
    if (b.isDefault === true) { ep.checkouts.forEach(c => c.isDefault = false); ck.isDefault = true; }
    const dataUrl = v => (typeof v === 'string' && (/^data:image\/(png|jpe?g|webp);base64,/.test(v) || v === '')) ? v : null;
    // imagens (desktop + celular): data URL até ~800KB cada
    const LBL = { banner: 'Capa (desktop)', bannerMobile: 'Capa (celular)', logo: 'Logo (desktop)', logoMobile: 'Logo (celular)' };
    for (const k of ['banner', 'bannerMobile', 'logo', 'logoMobile']) {
      if (dataUrl(b[k]) === null) continue;
      if (b[k].length > 800 * 1024) return res.status(400).json({ error: `${LBL[k]}: imagem muito grande (máx. ~800KB), use uma menor` });
      ck[k] = b[k];
    }
    // ordem dos blocos (arrastar e soltar) — só chaves conhecidas, sem duplicar
    if (Array.isArray(b.blocks)) {
      const valid = ['banner', 'timer', 'product', 'notice', 'benefits', 'testimonial', 'guarantee', 'faq'];
      const ordered = b.blocks.filter(x => valid.includes(x)).filter((x, i, a) => a.indexOf(x) === i);
      if (ordered.length) ck.blocks = valid.filter(v => !ordered.includes(v)).length ? ordered.concat(valid.filter(v => !ordered.includes(v))) : ordered;
    }
    // blocos opcionais
    const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : undefined;
    if (b.timer && typeof b.timer === 'object') {
      ck.timer = { on: !!b.timer.on, minutes: Math.max(1, Math.min(1440, +b.timer.minutes || 15)), text: str(b.timer.text, 120) || ck.timer.text || '' };
    }
    if (b.benefits && typeof b.benefits === 'object') {
      ck.benefits = { on: !!b.benefits.on, title: str(b.benefits.title, 80) || '', items: (Array.isArray(b.benefits.items) ? b.benefits.items : []).slice(0, 10).map(x => String(x).slice(0, 120)) };
    }
    if (b.testimonial && typeof b.testimonial === 'object') {
      ck.testimonial = { on: !!b.testimonial.on, name: str(b.testimonial.name, 60) || '', role: str(b.testimonial.role, 60) || '', text: str(b.testimonial.text, 400) || '' };
    }
    if (b.guarantee && typeof b.guarantee === 'object') {
      ck.guarantee = { on: !!b.guarantee.on, days: Math.max(1, Math.min(365, +b.guarantee.days || 7)), text: str(b.guarantee.text, 240) || '' };
    }
    if (b.faq && typeof b.faq === 'object') {
      ck.faq = { on: !!b.faq.on, items: (Array.isArray(b.faq.items) ? b.faq.items : []).slice(0, 8).map(i => ({ q: String(i.q || '').slice(0, 140), a: String(i.a || '').slice(0, 500) })) };
    }
    if (b.notice && typeof b.notice === 'object') ck.notice = { on: !!b.notice.on, text: str(b.notice.text, 200) || '' };
    if (b.badges && typeof b.badges === 'object') ck.badges = { on: !!b.badges.on };
    // formas de pagamento aceitas neste checkout. Garante ao menos uma ativa:
    // se o lojista desligar tudo, o Pix permanece (não dá para vender sem meio).
    if (b.methods && typeof b.methods === 'object') {
      const m = { pix: !!b.methods.pix, credit: !!b.methods.credit, debit: !!b.methods.debit };
      if (!m.pix && !m.credit && !m.debit) m.pix = true;
      ck.methods = m;
    }
    if (typeof b.title === 'string') ck.title = b.title.slice(0, 80);
    if (typeof b.description === 'string') ck.description = b.description.slice(0, 600);
    if (typeof b.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(b.color)) ck.color = b.color;
    if (typeof b.successMsg === 'string') ck.successMsg = b.successMsg.slice(0, 300);
    if (typeof b.supportText === 'string') ck.supportText = b.supportText.slice(0, 200);
    db.save();
    elitepay.log(req.acc, { type: 'checkout_updated', detail: 'Checkout personalizado atualizado' });
    res.json({ ok: true, checkout: ck });
  });

  // ---- PRODUTOS (o que é vendido; entra como variável no checkout) ----
  router.get('/elitepay/products', auth, can('elitepay'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    res.json({ products: ep.products, checkouts: ep.checkouts.map(c => ({ id: c.id, name: c.name, isDefault: c.isDefault })) });
  });
  router.post('/elitepay/products', auth, can('elitepay', 'create'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const b = req.body || {};
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Informe o nome do produto' });
    const p = { ...elitepay.defaultProduct(), id: db.genId('prd'), createdAt: Date.now() };
    applyProduct(p, b, res); if (res.headersSent) return;
    ep.products.unshift(p);
    db.save();
    res.json({ ok: true, product: p });
  });
  router.put('/elitepay/products/:id', auth, can('elitepay', 'edit'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const p = ep.products.find(x => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    applyProduct(p, req.body || {}, res); if (res.headersSent) return;
    db.save();
    res.json({ ok: true, product: p });
  });
  router.delete('/elitepay/products/:id', auth, can('elitepay', 'edit'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const i = ep.products.findIndex(x => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Produto não encontrado' });
    ep.products.splice(i, 1);
    db.save();
    res.json({ ok: true });
  });
  function applyProduct(p, b, res) {
    const img = v => (typeof v === 'string' && (/^data:image\/(png|jpe?g|webp);base64,/.test(v) || v === '')) ? v : null;
    if (typeof b.name === 'string') p.name = b.name.slice(0, 80);
    if (typeof b.description === 'string') p.description = b.description.slice(0, 600);
    if (b.price !== undefined) p.price = Math.max(0, Math.round(Number(b.price) || 0));
    if (typeof b.checkoutId === 'string') p.checkoutId = b.checkoutId.slice(0, 40);
    if (typeof b.active === 'boolean') p.active = b.active;
    for (const k of ['banner', 'bannerMobile', 'logo', 'logoMobile']) {
      if (img(b[k]) === null) continue;
      if (b[k].length > 800 * 1024) { res.status(400).json({ error: 'Imagem muito grande (máx. ~800KB)' }); return; }
      p[k] = b[k];
    }
  }

  // ---- CHECKOUTS (templates de layout) ----
  router.get('/elitepay/checkouts', auth, can('elitepay'), (req, res) => {
    res.json({ checkouts: elitepay.ensure(req.acc).checkouts });
  });
  router.post('/elitepay/checkouts', auth, can('elitepay', 'create'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    const base = ep.checkouts.find(c => c.isDefault) || ep.checkouts[0] || elitepay.defaultCheckout();
    const c = JSON.parse(JSON.stringify(base));        // duplica o layout atual
    c.id = db.genId('ckt');
    c.name = String((req.body || {}).name || 'Novo checkout').slice(0, 60);
    c.isDefault = false;
    ep.checkouts.push(c);
    db.save();
    res.json({ ok: true, checkout: c });
  });
  router.delete('/elitepay/checkouts/:id', auth, can('elitepay', 'edit'), (req, res) => {
    const ep = elitepay.ensure(req.acc);
    if (ep.checkouts.length <= 1) return res.status(400).json({ error: 'É preciso manter ao menos um checkout' });
    const i = ep.checkouts.findIndex(c => c.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Checkout não encontrado' });
    const era = ep.checkouts[i].isDefault;
    ep.checkouts.splice(i, 1);
    if (era) ep.checkouts[0].isDefault = true;
    db.save();
    res.json({ ok: true });
  });

  router.get('/elitepay/logs', auth, can('elitepay'), (req, res) => {
    res.json({ logs: elitepay.ensure(req.acc).logs.slice(0, 200) });
  });

  // ---- Admin SaaS: gestão financeira da plataforma ----
  router.get('/admin/elitepay', auth, adminOnly, (req, res) => {
    // `card` vem junto porque as taxas de Pix e de CARTÃO moram no mesmo painel
    res.json({ ...elitepay.adminOverview(), card: require('./cardgateways').adminCard(elitepay.cardConfig()) });
  });
  router.put('/admin/elitepay/config', auth, adminOnly, (req, res) => {
    const cfg = elitepay.platformCfg();
    const b = req.body || {};
    const pct = v => Math.max(0, Math.min(50, Number(String(v).replace(',', '.')) || 0));
    if (b.feeInPercent !== undefined) cfg.feeInPercent = pct(b.feeInPercent);
    if (b.feeOutPercent !== undefined) cfg.feeOutPercent = pct(b.feeOutPercent);
    if (typeof b.splitPixKey === 'string') cfg.splitPixKey = b.splitPixKey.trim().slice(0, 140);
    if (typeof b.requireApproval === 'boolean') cfg.requireApproval = b.requireApproval;
    if (b.onboardingMode === 'kyc' || b.onboardingMode === 'subaccount') cfg.onboardingMode = b.onboardingMode;
    db.save();
    elitepay.plog({ type: 'config_updated', detail: `Modo ${cfg.onboardingMode} · PIX In ${cfg.feeInPercent}% · PIX Out ${cfg.feeOutPercent}% · aprovação ${cfg.requireApproval ? 'manual' : 'automática'}` });
    res.json({ ok: true, config: cfg });
  });

  // ---- Conta de recebimento no cartão (recebedor/subconta do CLIENTE) ----
  router.get('/elitepay/card-account', auth, h(async (req, res) => {
    // reconsulta o adquirente quando ainda está em análise
    if (elitepay.cardAccount(req.acc).status === 'pending') await elitepay.syncCardAccount(req.acc);
    res.json({ account: elitepay.cardAccountView(req.acc) });
  }));

  router.post('/elitepay/card-account', auth, h(async (req, res) => {
    await elitepay.registerCardAccount(req.acc, req.body || {});
    res.json({ account: elitepay.cardAccountView(req.acc) });
  }));

  // ---- Adquirente de cartão (Pagar.me / Asaas) ----
  const cards = require('./cardgateways');

  router.get('/admin/elitepay/card', auth, adminOnly, (req, res) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({
      card: {
        ...cards.adminCard(elitepay.cardConfig()),
        webhookUrl: `${origin}/card-webhook`,
        webhookToken: elitepay.cardWebhookToken()   // o admin precisa colar no painel do adquirente
      }
    });
  });

  router.put('/admin/elitepay/card', auth, adminOnly, (req, res) => {
    const card = elitepay.cardConfig();
    const b = req.body || {};
    const pct = v => Math.max(0, Math.min(50, Number(String(v).replace(',', '.')) || 0));

    if (typeof b.enabled === 'boolean') card.enabled = b.enabled;
    if (b.provider === 'pagarme' || b.provider === 'asaas') card.provider = b.provider;
    if (typeof b.credit === 'boolean') card.credit = b.credit;
    if (typeof b.boleto === 'boolean') card.boleto = b.boleto;
    if (b.boletoDueDays !== undefined) card.boletoDueDays = Math.max(1, Math.min(30, Number(b.boletoDueDays) || 3));
    if (b.maxInstallments !== undefined) card.maxInstallments = Math.max(1, Math.min(12, Number(b.maxInstallments) || 1));
    if (b.feeCardPercent !== undefined) card.feeCardPercent = pct(b.feeCardPercent);
    if (b.feeCardFixed !== undefined) card.feeCardFixed = Math.max(0, Math.round(Number(b.feeCardFixed) || 0));
    if (typeof b.softDescriptor === 'string') card.softDescriptor = b.softDescriptor.trim().slice(0, 13);
    if (typeof b.platformRecipientId === 'string') card.platformRecipientId = b.platformRecipientId.trim();
    if (typeof b.requireApproval === 'boolean') card.requireApproval = b.requireApproval;
    // ---- taxa de SAQUE das vendas no cartão + prazo de liberação ----
    if (b.feeOutCardPercent !== undefined) card.feeOutCardPercent = pct(b.feeOutCardPercent);
    if (b.feeOutCardFixed !== undefined) card.feeOutCardFixed = Math.max(0, Math.round(Number(b.feeOutCardFixed) || 0));
    if (b.settleMode === 'wallet' || b.settleMode === 'split') card.settleMode = b.settleMode;
    // Os PRAZOS de liquidação não são editáveis: valem os da adquirente
    // (cards.SETTLE_RULES). Trocar de adquirente já troca o prazo junto.
    delete card.settleCredit;
    delete card.settleDebit;
    delete card.settleBoleto;
    delete card.debit;            // débito saiu: à vista o Pix cobre melhor
    // chaves: vazio = manter a que já está salva (o painel nunca recebe o valor)
    if (b.pagarme) {
      if (typeof b.pagarme.secretKey === 'string' && b.pagarme.secretKey.trim()) card.pagarme.secretKey = b.pagarme.secretKey.trim();
      if (typeof b.pagarme.publicKey === 'string') card.pagarme.publicKey = b.pagarme.publicKey.trim();
    }
    if (b.asaas) {
      if (typeof b.asaas.apiKey === 'string' && b.asaas.apiKey.trim()) card.asaas.apiKey = b.asaas.apiKey.trim();
      if (typeof b.asaas.sandbox === 'boolean') card.asaas.sandbox = b.asaas.sandbox;
      // carteira da PLATAFORMA no Asaas — recebe a taxa no split
      if (typeof b.asaas.walletId === 'string') card.asaas.walletId = b.asaas.walletId.trim();
    }
    // O Asaas não processa débito — evita config impossível.
    if (card.provider === 'asaas') card.debit = false;
    db.save();
    elitepay.plog({ type: 'card_config', detail: `Cartão ${card.enabled ? 'ON' : 'OFF'} · ${card.provider} · taxa ${card.feeCardPercent}% + ${elitepay.fmtBRL(card.feeCardFixed)}` });
    res.json({ card: cards.adminCard(card) });
  });

  // Testa as credenciais do adquirente ativo com uma chamada real de leitura.
  router.get('/admin/elitepay/card/test', auth, adminOnly, h(async (req, res) => {
    const card = elitepay.cardConfig();
    if (!cards.isConfigured(card)) return res.status(400).json({ error: 'Informe a chave do adquirente antes de testar' });
    const cfg = cards.creds(card);
    if (card.provider === 'pagarme') {
      await cards.DRIVERS.pagarme.call(cfg, 'GET', '/charges?size=1');
      return res.json({ ok: true, provider: 'pagarme', ambiente: String(cfg.secretKey).startsWith('sk_test') ? 'teste' : 'produção' });
    }
    await cards.DRIVERS.asaas.call(cfg, 'GET', '/customers?limit=1');
    res.json({ ok: true, provider: 'asaas', ambiente: cfg.sandbox ? 'sandbox' : 'produção' });
  }));
  router.put('/admin/elitepay/subaccounts/:accId', auth, adminOnly, h(async (req, res) => {
    const acc = db.findAccount(req.params.accId);
    if (!acc) return res.status(404).json({ error: 'Conta não encontrada' });
    const status = ['active', 'suspended', 'pending', 'rejected'].includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Status inválido' });
    const sub = await elitepay.setSubaccountStatus(acc, status);
    broadcast('elitepay', { accountId: acc.id, kind: 'subaccount', status: sub.status });
    res.json({ ok: true, subaccount: sub });
  }));

  // ---- Web Push (PWA) ----
  router.get('/push/vapid', auth, (req, res) => {
    try { res.json({ publicKey: push.publicKey() }); }
    catch (e) { res.status(500).json({ error: 'Push indisponível' }); }
  });
  // Teste de ponta a ponta: manda um push REAL para os aparelhos inscritos.
  // É a única forma de provar que a cadeia funciona com o app fechado.
  router.post('/push/test', auth, h(async (req, res) => {
    const inscritos = (req.acc.pushSubs || []).length;
    await push.sendToAccount(req.acc, 'message', {
      title: 'Koonfy',
      body: 'Notificação de teste. Se você está vendo isto, está tudo funcionando.',
      tag: 'teste', data: { type: 'message', url: '/app/#/settings' }
    });
    res.json({ sent: inscritos });
  }));

  router.post('/push/subscribe', auth, (req, res) => {
    const ok = push.subscribe(req.acc, req.body.subscription, req.body.prefs);
    res.json({ ok });
  });
  router.post('/push/unsubscribe', auth, (req, res) => {
    if (req.body && req.body.endpoint) push.unsubscribe(req.acc, req.body.endpoint);
    res.json({ ok: true });
  });

  // Aparelho do app das lojas (iOS/Android). O token vem do FCM/APNs e é o
  // endereço para entregar notificação com o app fechado.
  router.post('/push/device', auth, (req, res) => {
    const ok = pushNative.registerDevice(req.acc, req.body.token, req.body.platform, req.body.prefs);
    res.json({ ok, enabled: pushNative.enabled() });
  });
  router.post('/push/device/unregister', auth, (req, res) => {
    if (req.body && req.body.token) pushNative.unregisterDevice(req.acc, req.body.token);
    res.json({ ok: true });
  });

  router.get('/events', auth, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('event: hello\ndata: {}\n\n');
    const client = { res, accountId: req.acc.id, isAdmin: req.session.kind === 'admin' };
    clients.add(client);
    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(hb); clients.delete(client); });
  });

  return router;
};
