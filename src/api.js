// API interna do EliteChat (consumida pelo painel em /public/app)
// Multi-conta: cada cliente (account) tem seu próprio WhatsApp conectado via Embedded Signup.
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
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

module.exports = function (broadcast, clients) {
  const router = express.Router();

  const h = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    const code = e.status >= 400 && e.status < 600 ? e.status : 500;
    res.status(code).json({ error: e.message || 'Erro interno', meta: e.meta });
  });

  function auth(req, res, next) {
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
        return res.status(401).json({ error: 'Atendente desativado — fale com o administrador' });
      }
      agent.lastSeenAt = Date.now();      // heartbeat de presença a cada requisição
      if (agent.status === 'offline') agent.status = 'online';
    }
    req.token = token;
    req.session = sess;
    req.acc = acc;
    req.agent = agent;
    req.who = { agentId: agent ? agent.id : null, name: agent ? agent.name : (sess.user || acc.name) };
    next();
  }

  const adminOnly = (req, res, next) =>
    req.session.kind === 'admin' ? next() : res.status(403).json({ error: 'Apenas o administrador da plataforma' });

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
  function storeOutbound(acc, to, content, apiResp, stamp) {
    const waId = store.normalizeWaId(to);
    const contact = store.upsertContact(acc, waId);
    const id = (apiResp && apiResp.messages && apiResp.messages[0] && apiResp.messages[0].id) || db.genId('local');
    const msg = {
      id, waId, direction: 'out', timestamp: Date.now(), status: 'accepted',
      ...(stamp ? { agentId: stamp.agentId || null, agentName: stamp.agentName || null } : {}),
      ...content
    };
    store.addMessage(acc, msg);
    contact.lastMessageAt = msg.timestamp;
    db.save();
    broadcast('message', { accountId: acc.id, waId });
    return msg;
  }

  // ============ AUTENTICAÇÃO (admin da plataforma + contas de cliente) ============

  router.post('/register', h(async (req, res) => {
    const { name, email, pass, refCode } = req.body || {};
    const mail = String(email || '').toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return res.status(400).json({ error: 'Informe um e-mail válido' });
    if (!pass || pass.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    if (db.findAccountByEmail(mail)) return res.status(409).json({ error: 'Já existe uma conta com este e-mail' });
    const acc = db.newAccount({ name: String(name || '').trim() || mail, email: mail, pass });
    acc.billing.periodEnd = Date.now() + (db.get().platform.billing.trialDays || 7) * 86400000;
    // afiliação: registra quem indicou (comissão na assinatura e nas renovações)
    const aff = db.findAccountByRefCode(refCode);
    if (aff) acc.affiliate.refBy = aff.affiliate.code;
    db.get().accounts.push(acc);
    db.save();
    const token = newSession('account', acc);
    res.json({ token, user: acc.name, kind: 'account', accountId: acc.id, wa: waPublic(acc) });
  }));

  router.post('/login', h(async (req, res) => {
    const { user, pass } = req.body || {};
    const p = db.get().platform;
    // admin da plataforma
    if (user === p.adminUser && db.hash(pass || '') === p.adminPassHash) {
      const acc = db.findAdminAccount();
      const token = newSession('admin', acc);
      return res.json({ token, user, kind: 'admin', accountId: acc.id, mustChangePassword: p.adminPassHash === db.hash('admin'), wa: waPublic(acc) });
    }
    // conta de cliente (dono — login por e-mail)
    const acc = db.findAccountByEmail(user);
    if (acc && db.hash(pass || '') === acc.passHash) {
      const token = newSession('account', acc);
      agents.log(acc, { agentId: null, name: acc.name }, 'login', 'Entrou como dono da conta');
      return res.json({ token, user: acc.name, kind: 'account', accountId: acc.id, wa: waPublic(acc), permissions: null });
    }

    // ATENDENTE (login por e-mail próprio)
    const found = agents.findAgentByEmail(user);
    if (found && found.agent.passHash && db.hash(pass || '') === found.agent.passHash) {
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
        wa: waPublic(a)
      });
    }

    res.status(401).json({ error: 'Usuário ou senha inválidos' });
  }));

  // Config pública da landing (sem auth) — copy do botão conforme dias de teste
  router.get('/public/landing', (req, res) => {
    const p = db.get().platform;
    const trialDays = p.billing.trialDays || 0;
    const ctaText = (p.landing && p.landing.ctaText || '').trim();
    res.json({
      trialDays,
      ctaText: ctaText || (trialDays > 0 ? `Testar por ${trialDays} dias` : 'Começar agora')
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
      mustChangePassword: ag ? !!ag.mustChangePassword
        : (req.session.kind === 'admin' && p.adminPassHash === db.hash('admin')),
      wa: waPublic(req.acc)
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

  router.post('/agents', auth, can('agents', 'create'), (req, res) => {
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
    a.passHash = db.hash(pass);
    a.mustChangePassword = true;
    db.save();
    agents.log(req.acc, req.who, 'agent_updated', `Redefiniu a senha de ${a.name}`);
    res.json({ ok: true });
  });

  // O próprio atendente troca a senha
  router.post('/agents/me/password', auth, (req, res) => {
    if (!req.agent) return res.status(400).json({ error: 'Apenas atendentes usam esta rota' });
    const { current, pass } = req.body || {};
    if (db.hash(current || '') !== req.agent.passHash) return res.status(401).json({ error: 'Senha atual incorreta' });
    if (String(pass || '').length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
    req.agent.passHash = db.hash(pass);
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
      graphVersion: p.graphVersion || 'v25.0',
      redirectPath: '/auth/meta/callback',
      ready: !!(p.appId && p.appSecret)
    });
  });

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
      w.graphVersion = db.get().platform.graphVersion || 'v25.0';
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
    if (req.query.health === '1' && req.acc.wa.connected) {
      try {
        health = await wa.getPhoneInfo(req.acc);
        req.acc.wa.lastHealth = { at: Date.now(), ...health };
        db.save();
      } catch (e) {
        health = { error: e.message };
      }
    }
    res.json({ wa: waPublic(req.acc), health });
  }));

  router.post('/wa/disconnect', auth, h(async (req, res) => {
    const w = req.acc.wa;
    try {
      if (w.wabaId && w.accessToken) await meta.unsubscribeApp(w.accessToken, w.wabaId);
    } catch {}
    Object.assign(w, db.emptyWa(), { updatedAt: Date.now() });
    db.save();
    broadcast('wa_status', { accountId: req.acc.id, connected: false });
    res.json({ ok: true, wa: waPublic(req.acc) });
  }));

  // ============ CONFIGURAÇÕES ============

  router.get('/settings', auth, (req, res) => {
    const out = {
      settings: { stages: req.acc.stages, graphVersion: db.get().platform.graphVersion },
      wa: waPublic(req.acc),
      pixels: req.acc.pixels,
      linkDomain: req.acc.linkDomain,
      kind: req.session.kind,
      webhookPath: '/webhook'
    };
    if (req.session.kind === 'admin') {
      const { adminPassHash, ...platform } = db.get().platform;
      out.platform = platform;
      // credenciais manuais (avançado) da conta admin
      out.manual = { accessToken: req.acc.wa.accessToken, wabaId: req.acc.wa.wabaId, phoneNumberId: req.acc.wa.phoneNumberId };
    }
    res.json(out);
  });

  router.put('/settings', auth, (req, res) => {
    // etapas do funil (qualquer conta)
    if (Array.isArray(req.body.stages)) {
      const stages = req.body.stages.map(x => String(x).trim()).filter(Boolean);
      if (stages.length) req.acc.stages = stages;
    }
    // domínio personalizado dos links rastreáveis (qualquer conta)
    if (typeof req.body.linkDomain === 'string') {
      req.acc.linkDomain = req.body.linkDomain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    }
    // plataforma (só admin)
    if (req.session.kind === 'admin') {
      const p = db.get().platform;
      for (const k of ['graphVersion', 'appId', 'appSecret', 'configId', 'systemToken', 'verifyToken']) {
        if (typeof req.body[k] === 'string') p[k] = req.body[k].trim();
      }
      // credenciais manuais (avançado) — conecta a conta do admin sem Embedded Signup
      const w = req.acc.wa;
      let manualTouched = false;
      for (const [bodyKey, waKey] of [['accessToken', 'accessToken'], ['wabaId', 'wabaId'], ['phoneNumberId', 'phoneNumberId']]) {
        if (typeof req.body[bodyKey] === 'string') { w[waKey] = req.body[bodyKey].trim(); manualTouched = true; }
      }
      if (manualTouched) {
        w.connected = !!(wa.tokenOf(req.acc) && w.phoneNumberId);
        w.updatedAt = Date.now();
      }
    }
    db.save();
    res.json({ ok: true });
  });

  router.post('/settings/verify-token/regenerate', auth, adminOnly, (req, res) => {
    const p = db.get().platform;
    p.verifyToken = crypto.randomBytes(12).toString('hex');
    db.save();
    res.json({ verifyToken: p.verifyToken });
  });

  router.post('/settings/password', auth, (req, res) => {
    const { current, next } = req.body || {};
    if (!next || next.length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
    if (req.session.kind === 'admin') {
      const p = db.get().platform;
      if (db.hash(current || '') !== p.adminPassHash) return res.status(400).json({ error: 'Senha atual incorreta' });
      p.adminPassHash = db.hash(next);
      req.acc.passHash = p.adminPassHash;
    } else {
      if (db.hash(current || '') !== req.acc.passHash) return res.status(400).json({ error: 'Senha atual incorreta' });
      req.acc.passHash = db.hash(next);
    }
    db.save();
    res.json({ ok: true });
  });

  // ============ DIAGNÓSTICO / META ============

  router.get('/settings/test', auth, h(async (req, res) => res.json(await wa.getPhoneInfo(req.acc))));
  router.get('/debug-token', auth, h(async (req, res) => res.json(await wa.debugToken(req.acc))));
  router.get('/waba', auth, h(async (req, res) => {
    const [waba, phones] = await Promise.all([wa.getWaba(req.acc), wa.getWabaPhones(req.acc)]);
    res.json({ waba, phones: phones.data || [] });
  }));
  router.post('/waba/subscribe', auth, h(async (req, res) => res.json(await wa.subscribeApp(req.acc))));
  router.get('/waba/subscriptions', auth, h(async (req, res) => res.json(await wa.getSubscriptions(req.acc))));
  router.delete('/waba/subscribe', auth, h(async (req, res) => res.json(await wa.unsubscribeApp(req.acc))));

  // ============ PERFIL COMERCIAL ============

  router.get('/profile', auth, h(async (req, res) => {
    const r = await wa.getProfile(req.acc);
    const p = (r.data && r.data[0]) || {};
    // guarda a foto do perfil conectado p/ exibir no painel (topo + preview)
    req.acc.wa.profilePictureUrl = p.profile_picture_url || '';
    db.save();
    res.json(p);
  }));

  router.put('/profile', auth, h(async (req, res) => {
    const allowed = ['about', 'address', 'description', 'email', 'vertical', 'websites'];
    const fields = {};
    for (const k of allowed) if (req.body[k] !== undefined) fields[k] = req.body[k];
    res.json(await wa.updateProfile(req.acc, fields));
  }));

  // Troca a foto do perfil conectado: sobe o binário pela Resumable Upload API
  // e envia o handle em profile_picture_handle (fluxo oficial da Meta).
  router.post('/profile/photo', auth, h(async (req, res) => {
    const { filename, mime, data } = req.body || {};
    if (!data || !/^image\/(jpeg|png)$/.test(mime || '')) return res.status(400).json({ error: 'Envie uma imagem JPG ou PNG' });
    const buffer = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'Imagem muito grande (máx. 5 MB)' });
    const handle = await wa.uploadTemplateExample(req.acc, filename || 'perfil.jpg', mime, buffer);
    await wa.updateProfile(req.acc, { profile_picture_handle: handle });
    const r = await wa.getProfile(req.acc); // recarrega a URL nova
    const p = (r.data && r.data[0]) || {};
    req.acc.wa.profilePictureUrl = p.profile_picture_url || '';
    db.save();
    res.json({ ok: true, url: req.acc.wa.profilePictureUrl });
  }));

  // ============ CHAMADAS (WhatsApp Business Calling API) ============

  router.get('/settings/calling', auth, h(async (req, res) => {
    const r = await wa.getCallingSettings(req.acc);
    res.json({ calling: r.calling || null });
  }));

  router.put('/settings/calling', auth, h(async (req, res) => {
    const r = await wa.setCallingSettings(req.acc, !!(req.body || {}).enabled);
    res.json({ ok: true, result: r });
  }));

  // ============ REGISTRO / VERIFICAÇÃO DO NÚMERO ============

  router.post('/phone/request-code', auth, h(async (req, res) =>
    res.json(await wa.requestCode(req.acc, req.body.method || 'SMS', req.body.language || 'pt_BR'))));
  router.post('/phone/verify-code', auth, h(async (req, res) => res.json(await wa.verifyCode(req.acc, req.body.code))));
  router.post('/phone/register', auth, h(async (req, res) => res.json(await wa.registerPhone(req.acc, req.body.pin))));
  router.post('/phone/deregister', auth, h(async (req, res) => res.json(await wa.deregisterPhone(req.acc))));

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
    res.json({
      contacts: acc.contacts.length,
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

  router.get('/conversations', auth, can('inbox', 'view'), (req, res) => {
    const acc = req.acc;
    const lastBy = {};
    for (const m of acc.messages) lastBy[m.waId] = m;
    const list = acc.contacts.map(c => ({
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
      const ct = store.findContact(req.acc, c.waId);
      const { sdpOffer, ...pub } = c;
      return { ...pub, name: ct ? ct.name : c.waId };
    });
    res.json({ calls: list });
  });

  // Atender: o navegador gera o SDP answer (WebRTC) e a Meta conecta o áudio
  router.post('/calls/:id/accept', auth, can('inbox', 'edit'), h(async (req, res) => {
    const sdp = String((req.body || {}).sdp || '');
    if (!sdp) return res.status(400).json({ error: 'SDP answer ausente (WebRTC)' });
    const r = await wa.callAction(req.acc, { call_id: req.params.id, action: 'accept', session: { sdp_type: 'answer', sdp } });
    const call = (req.acc.calls || []).find(c => c.id === req.params.id);
    if (call) { call.status = 'active'; call.answeredAt = Date.now(); db.save(); }
    agents.log(req.acc, req.who, 'call_answered', 'Atendeu a ligação');
    res.json({ ok: true, result: r });
  }));

  // Pré-aceitar (opcional na API — acelera o estabelecimento da mídia)
  router.post('/calls/:id/pre-accept', auth, can('inbox', 'edit'), h(async (req, res) => {
    const sdp = String((req.body || {}).sdp || '');
    const r = await wa.callAction(req.acc, { call_id: req.params.id, action: 'pre_accept', session: { sdp_type: 'answer', sdp } });
    res.json({ ok: true, result: r });
  }));

  router.post('/calls/:id/reject', auth, can('inbox', 'edit'), h(async (req, res) => {
    const r = await wa.callAction(req.acc, { call_id: req.params.id, action: 'reject' });
    const call = (req.acc.calls || []).find(c => c.id === req.params.id);
    if (call) { call.status = 'rejected'; call.endedAt = Date.now(); db.save(); }
    agents.log(req.acc, req.who, 'call_rejected', 'Recusou a ligação');
    res.json({ ok: true, result: r });
  }));

  router.post('/calls/:id/terminate', auth, can('inbox', 'edit'), h(async (req, res) => {
    const r = await wa.callAction(req.acc, { call_id: req.params.id, action: 'terminate' });
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
    const r = await wa.callAction(req.acc, { to, action: 'connect', session: { sdp_type: 'offer', sdp } });
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
    const r = await wa.sendCallPermission(req.acc, to, (req.body || {}).text);
    storeOutbound(req.acc, to, { type: 'interactive', text: '📞 Pedido de permissão para ligar' }, r);
    res.json({ ok: true });
  }));

  // ============ ATRIBUIÇÃO E TRANSFERÊNCIA DE CONVERSAS ============

  // Assumir a conversa (o próprio atendente) ou atribuir a alguém
  router.post('/conversations/:waId/assign', auth, can('inbox', 'edit'), (req, res) => {
    const c = store.findContact(req.acc, req.params.waId);
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
    const c = store.findContact(req.acc, req.params.waId);
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
      `Transferiu a conversa de ${c.name}: ${from ? from.name : '—'} → ${to.name}${reason ? ' (' + reason + ')' : ''}`, { waId: c.waId });
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

  router.post('/schedules', auth, can('schedule', 'create'), (req, res) => {
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
    const c = store.findContact(req.acc, req.params.waId);
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
    const c = store.findContact(req.acc, req.params.waId);
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
          error: `"${tooLong.label}" excede ${max} caracteres — limite da Meta para ${clean.length <= survey.MAX_BUTTONS ? 'botões' : 'itens de lista'}.`
        });
      }
      s.notes = clean;
    }
    db.save();
    res.json(surveyPublic(req.acc));
  });

  router.get('/contacts', auth, can('contacts','view'), (req, res) => {
    const q = (req.query.search || '').toLowerCase();
    let list = req.acc.contacts;
    if (q) list = list.filter(c => (c.name || '').toLowerCase().includes(q) || c.waId.includes(q) || (c.tags || []).join(',').toLowerCase().includes(q));
    res.json({ contacts: [...list].sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0)) });
  });

  router.post('/contacts', auth, can('contacts','create'), (req, res) => {
    const waId = store.normalizeWaId(req.body.phone);
    if (waId.length < 10) return res.status(400).json({ error: 'Telefone inválido. Use o formato internacional, ex.: 5511999998888' });
    const c = store.upsertContact(req.acc, waId, req.body.name);
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
    res.set('Content-Disposition', 'attachment; filename="contatos-elitechat-e164.csv"');
    res.send('﻿' + lines.join('\r\n')); // BOM p/ Excel abrir acentos corretamente
  });

  router.put('/contacts/:waId', auth, can('contacts','edit'), (req, res) => {
    const c = store.findContact(req.acc, req.params.waId);
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
    const list = req.acc.messages
      .filter(m => m.waId === req.params.waId)
      .sort((a, b) => a.timestamp - b.timestamp);
    const contact = store.findContact(req.acc, req.params.waId) || null;
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
    const c = store.findContact(acc, req.params.waId);
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
    if (!p.enforce || req.session.kind === 'admin') return next();
    const b = req.acc.billing || {};
    const ok = (b.status === 'trial' || b.status === 'active' || b.status === 'canceled') && b.periodEnd > Date.now();
    if (ok) return next();
    res.status(402).json({ error: 'Assinatura expirada — renove em Assinatura & Carteira para continuar enviando' });
  }

  // Guard da JANELA DE 24H (validação obrigatória no backend — o front pode até
  // tentar, mas mensagens de sessão são bloqueadas aqui fora da janela ou com o
  // atendimento finalizado). Templates passam: são o único caminho para reabrir.
  const requireWindow = kind => (req, res, next) => {
    const to = store.normalizeWaId((req.body || {}).to);
    const contact = store.findContact(req.acc, to);
    if (!contact) return next(); // 1º contato: a Meta valida do lado dela
    const check = session.canSend(contact, kind);
    if (check.allowed) return next();
    res.status(409).json({ error: check.error, code: check.code, session: session.sessionState(contact) });
  };

  // Guard de OPT-OUT — vale para TODOS os envios (inclusive templates e campanhas).
  // Quem pediu para sair não recebe mais nada até ser reativado.
  function requireConsent(req, res, next) {
    const to = store.normalizeWaId((req.body || {}).to);
    const contact = store.findContact(req.acc, to);
    const check = consent.canSendTo(req.acc, contact);
    if (check.allowed) return next();
    res.status(409).json({ error: check.error, code: check.code });
  }

  // Registra quem foi o último atendente a falar com o contato (coluna da lista de opt-out)
  function markAgent(req, res, next) {
    const to = store.normalizeWaId((req.body || {}).to);
    const c = store.findContact(req.acc, to);
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

  router.post('/send/text', auth, requireActive, requireConsent, requireWindow('text'), markAgent, h(async (req, res) => {
    const { to, text, previewUrl } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'Informe "to" e "text"' });
    const r = await wa.sendText(req.acc, store.normalizeWaId(to), text, previewUrl);
    res.json({ ok: true, message: storeOutbound(req.acc, to, { type: 'text', text }, r, req._agentStamp) });
  }));

  router.post('/send/template', auth, requireActive, requireConsent, markAgent, h(async (req, res) => {
    const { to, name, language, components } = req.body;
    if (!to || !name) return res.status(400).json({ error: 'Informe "to" e "name"' });
    const r = await wa.sendTemplate(req.acc, store.normalizeWaId(to), name, language, components);
    res.json({ ok: true, message: storeOutbound(req.acc, to, { type: 'template', text: `📋 Template: ${name}` }, r, req._agentStamp) });
  }));

  router.post('/send/media', auth, requireActive, requireConsent, requireWindow('media'), markAgent, h(async (req, res) => {
    const { to, kind, mediaId, link, caption, filename } = req.body;
    if (!to || !kind) return res.status(400).json({ error: 'Informe "to" e "kind" (image|video|audio|document|sticker)' });
    const media = {};
    if (mediaId) media.id = mediaId;
    else if (link) media.link = link;
    else return res.status(400).json({ error: 'Informe "mediaId" ou "link"' });
    if (caption && kind !== 'audio' && kind !== 'sticker') media.caption = caption;
    if (kind === 'document' && filename) media.filename = filename;
    const r = await wa.sendMedia(req.acc, store.normalizeWaId(to), kind, media);
    res.json({
      ok: true,
      message: storeOutbound(req.acc, to, {
        type: kind,
        text: caption || (filename ? `📎 ${filename}` : ''),
        media: { id: mediaId || null, link: link || null, filename: filename || '', caption: caption || '' }
      }, r)
    });
  }));

  router.post('/send/buttons', auth, requireActive, requireConsent, requireWindow('buttons'), markAgent, h(async (req, res) => {
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
    const r = await wa.sendInteractive(req.acc, store.normalizeWaId(to), interactive);
    const resumo = buttons.map(b => `[${b.title || b}]`).join(' ');
    res.json({ ok: true, message: storeOutbound(req.acc, to, { type: 'interactive', text: `${body}\n${resumo}` }, r) });
  }));

  // Payload interactive completo (listas, CTA URL etc.) — passa direto para a Graph API
  router.post('/send/interactive', auth, requireActive, requireConsent, requireWindow('interactive'), markAgent, h(async (req, res) => {
    const { to, interactive } = req.body;
    if (!to || !interactive) return res.status(400).json({ error: 'Informe "to" e "interactive"' });
    const r = await wa.sendInteractive(req.acc, store.normalizeWaId(to), interactive);
    res.json({ ok: true, message: storeOutbound(req.acc, to, { type: 'interactive', text: '[mensagem interativa]' }, r) });
  }));

  router.post('/send/location', auth, requireActive, requireConsent, requireWindow('location'), h(async (req, res) => {
    const { to, latitude, longitude, name, address } = req.body;
    if (!to || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Informe "to", "latitude" e "longitude"' });
    }
    const r = await wa.sendLocation(req.acc, store.normalizeWaId(to), { latitude, longitude, name, address });
    res.json({ ok: true, message: storeOutbound(req.acc, to, { type: 'location', text: `📍 ${name || ''} ${address || ''}`.trim() || '📍 Localização' }, r) });
  }));

  router.post('/send/contacts', auth, requireActive, requireConsent, requireWindow('contacts'), h(async (req, res) => {
    const { to, contacts } = req.body;
    if (!to || !Array.isArray(contacts) || !contacts.length) return res.status(400).json({ error: 'Informe "to" e "contacts"' });
    const r = await wa.sendContactCard(req.acc, store.normalizeWaId(to), contacts);
    const names = contacts.map(c => c.name && c.name.formatted_name).filter(Boolean).join(', ');
    res.json({ ok: true, message: storeOutbound(req.acc, to, { type: 'contacts', text: '👤 ' + (names || 'Contato') }, r) });
  }));

  router.post('/send/reaction', auth, requireActive, requireConsent, requireWindow('reaction'), h(async (req, res) => {
    const { to, messageId, emoji } = req.body;
    if (!to || !messageId) return res.status(400).json({ error: 'Informe "to" e "messageId"' });
    const r = await wa.sendReaction(req.acc, store.normalizeWaId(to), messageId, emoji || '👍');
    res.json({ ok: true, id: (r.messages && r.messages[0] && r.messages[0].id) || null });
  }));

  // ============ MÍDIA ============

  router.post('/media/upload', auth, h(async (req, res) => {
    const { filename, mime, data } = req.body;
    if (!data) return res.status(400).json({ error: 'Envie "data" (base64), "filename" e "mime"' });
    const buffer = Buffer.from(data, 'base64');
    const r = await wa.uploadMedia(req.acc, filename, mime || 'application/octet-stream', buffer);
    res.json({ id: r.id });
  }));

  router.get('/media/:id', auth, h(async (req, res) => {
    const { res: mediaRes, info } = await wa.downloadMedia(req.acc, req.params.id);
    res.set('Content-Type', info.mime_type || 'application/octet-stream');
    if (req.query.dl) res.set('Content-Disposition', `attachment; filename="${String(req.query.dl).replace(/"/g, '')}"`);
    res.send(Buffer.from(await mediaRes.arrayBuffer()));
  }));

  // ============ TEMPLATES ============

  router.get('/templates', auth, can('templates','view'), h(async (req, res) => {
    const acc = req.acc;
    const cache = acc.templatesCache;
    const stale = !cache.fetchedAt || (Date.now() - cache.fetchedAt) > 10 * 60 * 1000;
    if (req.query.sync === '1' || (stale && acc.wa.wabaId && wa.tokenOf(acc))) {
      const r = await wa.listTemplates(acc);
      cache.list = r.data || [];
      cache.fetchedAt = Date.now();
      db.save();
    }
    res.json({ templates: cache.list, fetchedAt: cache.fetchedAt });
  }));

  // Upload do arquivo de exemplo do cabeçalho de mídia (IMAGE/VIDEO/DOCUMENT).
  // Recebe base64, sobe via Resumable Upload API e devolve o handle da Meta.
  router.post('/templates/example-upload', auth, h(async (req, res) => {
    const { filename, mime, data } = req.body || {};
    if (!data || !mime) return res.status(400).json({ error: 'Envie o arquivo (data base64) e o mime' });
    const buffer = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'Arquivo vazio' });
    if (buffer.length > 16 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo de exemplo muito grande (máx. 16 MB)' });
    const handle = await wa.uploadTemplateExample(req.acc, filename, mime, buffer);
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
        if (hv.count > 1) return res.status(400).json({ error: 'O cabeçalho aceita no máximo 1 variável ({{1}}) — regra da Meta' });
        if (hv.count === 1 && !/\{\{1\}\}/.test(headerText)) return res.status(400).json({ error: 'A variável do cabeçalho deve ser {{1}}' });
        const comp = { type: 'HEADER', format: 'TEXT', text: headerText };
        if (hv.count === 1) {
          const ex = String(headerExample || '').trim();
          if (!ex) return res.status(400).json({ error: 'Informe um valor de exemplo para a variável {{1}} do cabeçalho — a Meta exige na aprovação' });
          comp.example = { header_text: [ex] };
        }
        components.push(comp);
      } else if (ht) {
        if (!headerHandle) return res.status(400).json({ error: 'Envie o arquivo de exemplo do cabeçalho — a Meta exige uma amostra da mídia para aprovar o modelo' });
        components.push({ type: 'HEADER', format: ht, example: { header_handle: [headerHandle] } });
      }

      // ---- BODY: variáveis sequenciais + example.body_text obrigatório ----
      const bv = tplVars(bodyText);
      if (!bv.sequential) return res.status(400).json({ error: 'As variáveis do corpo devem ser sequenciais, começando em {{1}} sem pular números ({{1}}, {{2}}, {{3}}…)' });
      const bComp = { type: 'BODY', text: bodyText };
      if (bv.count > 0) {
        const exs = (Array.isArray(bodyExamples) ? bodyExamples : []).map(s => String(s || '').trim()).slice(0, bv.count);
        if (exs.length < bv.count || exs.some(s => !s)) {
          return res.status(400).json({ error: `Informe um valor de exemplo para cada variável do corpo ({{1}} a {{${bv.count}}}) — a Meta exige na aprovação` });
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
    const r = await wa.createTemplate(req.acc, payload);
    req.acc.templatesCache.fetchedAt = 0; // força re-sync
    db.save();
    res.json(r);
  }));

  router.delete('/templates/:name', auth, h(async (req, res) => {
    const r = await wa.deleteTemplate(req.acc, req.params.name);
    const cache = req.acc.templatesCache;
    cache.list = cache.list.filter(t => t.name !== req.params.name);
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
    if (unreadTotal >= 5) sug('warn', 'bell', `${unreadTotal} mensagens sem resposta`, 'Clientes esperando retorno esfriam rápido — responda para não perder vendas.', 'Abrir conversas', '#/inbox');
    if (avgResponseMin > 30 && respN >= 3) sug('warn', 'clock', 'Tempo de resposta alto', `Sua primeira resposta demora em média ${avgResponseMin} min. Use respostas rápidas e automações de boas-vindas.`, 'Criar automação', '#/flows');
    if (totalC >= 5 && firstStageCount / totalC > 0.6) sug('info', 'columns', 'Funil parado na entrada', `${Math.round(firstStageCount / totalC * 100)}% dos contatos ainda estão em "${acc.stages[0]}". Qualifique e mova os leads pelo funil.`, 'Abrir funil', '#/funnel');
    if (outMsgs.length >= 10 && (delivered / outMsgs.length) < 0.8) sug('warn', 'alert', 'Taxa de entrega baixa', 'Menos de 80% das mensagens entregues. Verifique a qualidade do número e evite disparos para contatos inativos.', 'Ver métricas', '#/dashboard');
    if (!(acc.flows || []).some(f => f.enabled)) sug('info', 'flow', 'Nenhuma automação ativa', 'Crie um fluxo de boas-vindas por palavra-chave para responder na hora, 24/7.', 'Abrir Flow Builder', '#/flows');
    if (totalC >= 5 && !acc.contacts.some(c => (c.tags || []).length)) sug('info', 'tag', 'Contatos sem tags', 'Use tags para segmentar campanhas e disparar automações certeiras.', 'Ver contatos', '#/contacts');
    if (!(acc.links || []).length) sug('info', 'link', 'Rastreie seus cliques', 'Crie links curtos rastreáveis para bio, anúncios e campanhas — com pixel da Meta e do Google.', 'Criar link', '#/links');
    else if (!(acc.pixels || []).length) sug('info', 'target', 'Pixels não configurados', 'Cadastre seu Meta Pixel, Google tag ou TikTok Pixel para alimentar seus anúncios com os cliques dos links.', 'Configurar pixels', '#/settings');
    if (wonStage && totalC >= 10 && leadsWon / totalC < 0.1) sug('info', 'megaphone', 'Poucos leads fechados', `Apenas ${Math.round(leadsWon / totalC * 100)}% chegaram em "${wonStage}". Reengaje com uma campanha de template para leads parados.`, 'Criar campanha', '#/campaigns');
    if (!suggestions.length) sug('ok', 'check-circle', 'Tudo em dia!', 'Seu atendimento está saudável — continue acompanhando as métricas.', null, null);

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

  router.post('/pixels', auth, can('pixels','create'), (req, res) => {
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
    const ver = db.get().platform.graphVersion || 'v25.0';
    const payload = {
      data: [{
        event_name: px.defaultEvent || 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: `${req.protocol}://${req.get('host')}/l/teste`,
        user_data: { client_user_agent: 'EliteChat-Test/1.0' }
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

  router.post('/links', auth, can('links','create'), (req, res) => {
    const { title, dest, slug, utm, event, value, currency } = req.body || {};
    let url = String(dest || '').trim();
    if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { return res.status(400).json({ error: 'Informe uma URL de destino válida (https://…)' }); }
    let s = String(slug || '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!s) s = crypto.randomBytes(4).toString('hex').slice(0, 7);
    if (db.findLinkBySlug(s)) return res.status(409).json({ error: `O apelido "/l/${s}" já está em uso — escolha outro` });
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

  router.post('/flows', auth, can('flows','create'), (req, res) => {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'Dê um nome à automação' });
    const trigger = b.trigger || { type: 'keyword', keyword: '', match: 'contains' };
    if (trigger.type === 'webhook' && !trigger.hookToken) trigger.hookToken = crypto.randomBytes(9).toString('hex');
    const flow = {
      id: db.genId('flow'),
      name: String(b.name).trim(),
      enabled: b.enabled !== false,
      trigger,
      waPhone: (req.acc.wa.displayPhoneNumber || '').replace(/\D/g, ''),
      nodes: Array.isArray(b.nodes) ? b.nodes : [],
      graph: b.graph && Array.isArray(b.graph.nodes) ? b.graph : { nodes: [], edges: [] },
      runs: 0, lastRun: null, lastResult: null,
      createdAt: Date.now(), updatedAt: Date.now()
    };
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
    f.waPhone = (req.acc.wa.displayPhoneNumber || '').replace(/\D/g, '');
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
      to: (req.body || {}).to || req.acc.wa.displayPhoneNumber || '',
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
    const c = store.findContact(req.acc, req.params.waId);
    if (!c) return res.status(404).json({ error: 'Contato não encontrado' });
    const by = req.session.user || req.acc.name;
    consent.optOut(req.acc, c, { source: 'manual', reason: String((req.body || {}).reason || '').trim() || 'Opt-out manual', by });
    broadcast('consent', { accountId: req.acc.id, waId: c.waId, status: 'opted_out' });
    res.json({ contact: consentRow(req.acc, c), metrics: consent.metrics(req.acc) });
  });

  // Reativação manual
  router.post('/consent/:waId/reactivate', auth, (req, res) => {
    const c = store.findContact(req.acc, req.params.waId);
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
    const dt = t => t ? new Date(t).toLocaleString('pt-BR') : '';
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
    res.set('Content-Disposition', `attachment; filename="contatos-${status}-elitechat.csv"`);
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

  router.post('/webhooks', auth, can('webhooks','create'), (req, res) => {
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
      data: { member: { name: 'Filipe', phone: '5571984791558', email: 'filipe@email.com' }, product: { name: 'Plano Pro' } }
    };
    const r = whmod.ingest(req.acc, wh, sample, broadcast);
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ webhook: webhookPublic(wh, origin), matched: !!r.contact });
  });

  // ============ CAMPANHAS (disparos em massa) ============

  // Público da campanha: todas, várias etapas do funil e/ou várias tags.
  // aud.values (array) é o formato atual; aud.value (string) é compat legado.
  function resolveAudience(acc, aud) {
    let list = acc.contacts;
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
    for (const r of camp.recipients) {
      if (r.status !== 'pending') continue;
      try {
        const contact = acc.contacts.find(c => c.waId === r.waId) || null;
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
        const resp = await wa.sendTemplate(acc, r.waId, camp.templateName, camp.language, components);
        if (contact) { contact.lastCampaignId = camp.id; contact.lastCampaignName = camp.name; contact.lastCampaignAt = Date.now(); }
        r.msgId = (resp && resp.messages && resp.messages[0] && resp.messages[0].id) || null;
        r.status = 'sent';
        storeOutbound(acc, r.waId, { type: 'template', text: `📋 Template: ${camp.templateName}` }, resp);
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

  router.post('/campaigns', auth, requireActive, h(async (req, res) => {
    const { name, templateName, language, vars, audience } = req.body || {};
    if (!name || !templateName) return res.status(400).json({ error: 'Informe "name" e "templateName"' });
    const waIds = resolveAudience(req.acc, audience);
    if (!waIds.length) return res.status(400).json({ error: 'Nenhum contato no público selecionado' });
    const camp = {
      id: db.genId('camp'),
      name, templateName,
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

  router.get('/billing', auth, (req, res) => {
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
      wooviReady: woovi.configured()
    });
  });

  // Assinar um plano: cria assinatura recorrente (Pix Automático) quando habilitado
  // e a cobrança Pix do 1º pagamento — QR exibido inline na página (sem pop-up).
  router.post('/billing/subscribe', auth, h(async (req, res) => {
    const plan = db.get().plans.find(p => p.id === (req.body || {}).planId && !p.archived);
    if (!plan) return res.status(400).json({ error: 'Plano não encontrado' });
    const acc = req.acc;
    const customer = { name: acc.name, email: acc.email };
    const cid = `sub-${acc.id}-${plan.id}-${Date.now().toString(36)}`;

    // Pix Automático (assinatura recorrente na Woovi) — a 1ª cobrança vem junto
    if (db.get().platform.woovi.pixAutomatic) {
      try {
        const sub = await woovi.createSubscription({
          correlationID: cid, value: plan.price, customer,
          comment: `EliteChat — ${plan.name} (mensal)`
        });
        acc.billing.wooviSubId = sub.globalID || sub.id || '';
        acc.billing.subCorrelationID = cid;
      } catch (e) {
        store.logEvent({ type: 'woovi_sub_fallback', accountId: acc.id, error: e.message });
        // segue com cobrança avulsa (renovação manual)
      }
    }

    const charge = await woovi.createCharge({
      correlationID: cid, value: plan.price, customer,
      comment: `EliteChat — assinatura ${plan.name}`
    });
    acc.billing.pendingCharge = {
      correlationID: cid, kind: 'sub', planId: plan.id, amount: plan.price,
      brCode: charge.brCode || '', qrCodeImage: charge.qrCodeImage || '',
      paymentLinkUrl: charge.paymentLinkUrl || '', ts: Date.now()
    };
    db.save();
    res.json({ charge: acc.billing.pendingCharge, pixAutomatic: !!acc.billing.wooviSubId });
  }));

  // Recarga de saldo na carteira via Pix
  router.post('/billing/topup', auth, h(async (req, res) => {
    const amount = Math.round(Number(String((req.body || {}).amount || '0').replace(',', '.')) * 100);
    if (!amount || amount < 100) return res.status(400).json({ error: 'Valor mínimo de recarga: R$ 1,00' });
    const cid = `topup-${req.acc.id}-${Date.now().toString(36)}`;
    const charge = await woovi.createCharge({
      correlationID: cid, value: amount,
      customer: { name: req.acc.name, email: req.acc.email },
      comment: 'EliteChat — recarga de saldo'
    });
    req.acc.billing.pendingCharge = {
      correlationID: cid, kind: 'topup', planId: '', amount,
      brCode: charge.brCode || '', qrCodeImage: charge.qrCodeImage || '',
      paymentLinkUrl: charge.paymentLinkUrl || '', ts: Date.now()
    };
    db.save();
    res.json({ charge: req.acc.billing.pendingCharge });
  }));

  // Polling do pagamento pendente (o webhook é a via principal; isto cobre localhost)
  router.get('/billing/pending', auth, h(async (req, res) => {
    const pc = req.acc.billing.pendingCharge;
    if (!pc) return res.json({ paid: false, none: true });
    const charge = await woovi.getCharge(pc.correlationID);
    if (charge && /COMPLETED|CONFIRMED|PAID/i.test(charge.status || '')) {
      woovi.applyPayment(charge, broadcast);
      return res.json({ paid: true });
    }
    res.json({ paid: false, status: charge && charge.status });
  }));

  router.post('/billing/pending/cancel', auth, h(async (req, res) => {
    const pc = req.acc.billing.pendingCharge;
    if (pc) { await woovi.deleteCharge(pc.correlationID); req.acc.billing.pendingCharge = null; db.save(); }
    res.json({ ok: true });
  }));

  // Cancelar assinatura (mantém acesso até o fim do período pago)
  router.post('/billing/cancel', auth, h(async (req, res) => {
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
  router.post('/wallet/withdraw', auth, (req, res) => {
    const amount = Math.round(Number(String((req.body || {}).amount || '0').replace(',', '.')) * 100);
    const pixKey = String((req.body || {}).pixKey || '').trim();
    if (!pixKey) return res.status(400).json({ error: 'Informe sua chave Pix' });
    if (!amount || amount < 2000) return res.status(400).json({ error: 'Saque mínimo: R$ 20,00' });
    if (amount > req.acc.wallet.balance) return res.status(400).json({ error: 'Saldo insuficiente' });
    req.acc.wallet.balance -= amount;
    req.acc.wallet.transactions.push({ id: db.genId('tx'), ts: Date.now(), amount: -amount, type: 'withdraw', label: 'Saque solicitado — ' + pixKey });
    db.get().withdrawals.push({ id: db.genId('wd'), accountId: req.acc.id, accountName: req.acc.name, amount, pixKey, status: 'pending', ts: Date.now() });
    db.save();
    res.json({ ok: true, balance: req.acc.wallet.balance });
  });

  // ============ ADMIN SaaS (métricas, contas, planos, afiliados, saques) ============

  router.get('/admin/saas', auth, adminOnly, (req, res) => {
    const data = db.get();
    const now = Date.now();
    const accs = data.accounts.filter(a => !a.isAdmin);
    const active = accs.filter(a => a.billing.status === 'active' && a.billing.periodEnd > now);
    const mrr = active.reduce((s, a) => { const p = data.plans.find(x => x.id === a.billing.planId); return s + (p ? p.price : 0); }, 0);
    const rev30 = data.revenue.filter(r => r.ts >= now - 30 * 86400000 && r.kind !== 'topup').reduce((s, r) => s + r.amount, 0);
    res.json({
      metrics: {
        accounts: accs.length,
        activeSubs: active.length,
        trials: accs.filter(a => a.billing.status === 'trial' && a.billing.periodEnd > now).length,
        mrr, revenue30d: rev30,
        totalRevenue: data.revenue.filter(r => r.kind !== 'topup').reduce((s, r) => s + r.amount, 0),
        pendingWithdrawals: data.withdrawals.filter(w => w.status === 'pending').length
      },
      accounts: accs.map(a => ({
        id: a.id, name: a.name, email: a.email, createdAt: a.createdAt,
        waConnected: !!(a.wa && a.wa.connected),
        billing: billingPublic(a), walletBalance: a.wallet.balance,
        refCode: a.affiliate.code, refBy: a.affiliate.refBy || '',
        referrals: data.accounts.filter(x => x.affiliate && x.affiliate.refBy === a.affiliate.code).length,
        affEarned: a.affiliate.earned
      })).sort((a, b) => b.createdAt - a.createdAt),
      plans: data.plans,
      withdrawals: data.withdrawals.slice(-50).reverse(),
      revenue: data.revenue.slice(-100).reverse(),
      config: { woovi: { appId: data.platform.woovi.appId ? '••••' + data.platform.woovi.appId.slice(-6) : '', configured: woovi.configured(), pixAutomatic: data.platform.woovi.pixAutomatic }, billing: data.platform.billing, affiliate: data.platform.affiliate, landing: data.platform.landing },
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
    if (b.trialDays !== undefined) p.billing.trialDays = Math.max(0, Number(b.trialDays) || 0);
    if (b.enforce !== undefined) p.billing.enforce = !!b.enforce;
    if (b.ctaText !== undefined) p.landing.ctaText = String(b.ctaText).slice(0, 40);
    if (b.percentFirst !== undefined) p.affiliate.percentFirst = Math.min(90, Math.max(0, Number(b.percentFirst) || 0));
    if (b.percentRenewal !== undefined) p.affiliate.percentRenewal = Math.min(90, Math.max(0, Number(b.percentRenewal) || 0));
    db.save();
    res.json({ ok: true });
  });

  // Testa a conexão com a Woovi (lista 1 cobrança qualquer)
  router.get('/admin/woovi/test', auth, adminOnly, h(async (req, res) => {
    const r = await woovi.call('GET', '/api/v1/charge?limit=1');
    res.json({ ok: true, charges: (r.charges || []).length, pageInfo: r.pageInfo || null });
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
        acc.wallet.transactions.push({ id: db.genId('tx'), ts: Date.now(), amount: wd.amount, type: 'refund', label: 'Saque recusado — valor devolvido' });
      }
    }
    db.save();
    res.json({ withdrawal: wd });
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

  // ---- Web Push (PWA) ----
  router.get('/push/vapid', auth, (req, res) => {
    try { res.json({ publicKey: push.publicKey() }); }
    catch (e) { res.status(500).json({ error: 'Push indisponível' }); }
  });
  router.post('/push/subscribe', auth, (req, res) => {
    const ok = push.subscribe(req.acc, req.body.subscription, req.body.prefs);
    res.json({ ok });
  });
  router.post('/push/unsubscribe', auth, (req, res) => {
    if (req.body && req.body.endpoint) push.unsubscribe(req.acc, req.body.endpoint);
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
