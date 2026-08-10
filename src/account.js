// ============================================================================
// CONTA DO CLIENTE: e-mail verificado e verificação em duas etapas
//
// O e-mail é o que identifica a conta no login e o único caminho de volta se a
// senha se perder. Confirmá-lo é o que permite confiar nele para isso e para o
// segundo fator.
//
// A verificação em duas etapas depende de TRÊS coisas ao mesmo tempo:
//   1. a plataforma ter ligado o recurso (Admin SaaS);
//   2. o envio de e-mail estar configurado (sem ele o código não sai);
//   3. o cliente ter confirmado o próprio e-mail.
// Se qualquer uma cair, o login volta a pedir só a senha em vez de trancar
// alguém para fora da própria conta.
// ============================================================================

const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

const CODIGO_MIN = 15 * 60 * 1000;   // confirmação de e-mail: 15 minutos
const LOGIN_MIN = 10 * 60 * 1000;   // código de login: 10 minutos
const MAX_TENTATIVAS = 5;
const ESPERA_REENVIO = 60 * 1000;

function seguranca() {
  const p = db.get().platform;
  if (!p.security || typeof p.security !== 'object') p.security = { twoFactor: false };
  if (typeof p.security.twoFactor !== 'boolean') p.security.twoFactor = false;
  return p.security;
}

// Seis dígitos por sorteio criptográfico: Math.random é previsível o bastante
// para não guardar um segundo fator.
function gerarCodigo() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Comparação em tempo constante: comparar com === vaza, pelo tempo de resposta,
// quantos dígitos iniciais estavam certos.
function iguais(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function estado(acc) {
  if (!acc.security || typeof acc.security !== 'object') {
    acc.security = { emailVerified: false, emailVerifiedAt: 0, twoFactor: false, codigo: null };
  }
  for (const [k, v] of Object.entries({ emailVerified: false, emailVerifiedAt: 0, twoFactor: false, codigo: null })) {
    if (acc.security[k] === undefined) acc.security[k] = v;
  }
  return acc.security;
}

// O que a tela de "Minha conta" precisa saber.
function view(acc) {
  const s = estado(acc);
  const podePlataforma = !!seguranca().twoFactor;
  const podeEmail = mailer.configured();
  return {
    email: acc.email || '',
    name: acc.name || '',
    emailVerified: !!s.emailVerified,
    emailVerifiedAt: s.emailVerifiedAt || 0,
    // a verificação de e-mail só aparece quando há como enviar o código
    canVerifyEmail: podeEmail,
    twoFactor: !!s.twoFactor,
    // e o segundo fator só quando a plataforma liberou E o e-mail está confirmado
    twoFactorAvailable: podePlataforma && podeEmail && !!s.emailVerified,
    twoFactorBlockedBy: !podePlataforma ? 'plataforma' : !podeEmail ? 'email' : !s.emailVerified ? 'naoVerificado' : '',
    codeSentAt: (s.codigo && s.codigo.ts) || 0
  };
}

// ---------------------------------------------------------------------------
// CONFIRMAÇÃO DO E-MAIL
// ---------------------------------------------------------------------------
async function enviarCodigoEmail(acc) {
  const s = estado(acc);
  if (!mailer.configured()) throw erro('O envio de e-mail ainda não foi configurado pela plataforma', 503);
  if (!acc.email) throw erro('A conta não tem e-mail cadastrado');
  if (s.codigo && Date.now() - s.codigo.ts < ESPERA_REENVIO) {
    throw erro('Aguarde um minuto para pedir um novo código', 429);
  }
  const codigo = gerarCodigo();
  s.codigo = { hash: db.hash(codigo), exp: Date.now() + CODIGO_MIN, tentativas: 0, ts: Date.now(), para: acc.email };
  db.save();
  await mailer.enviarCodigoVerificacao(acc.email, codigo);
  return { ok: true, enviadoPara: acc.email };
}

function confirmarEmail(acc, codigo) {
  const s = estado(acc);
  const c = s.codigo;
  if (!c) throw erro('Peça um código antes de confirmar');
  if (Date.now() > c.exp) { s.codigo = null; db.save(); throw erro('O código expirou. Peça outro.'); }
  if (c.tentativas >= MAX_TENTATIVAS) { s.codigo = null; db.save(); throw erro('Tentativas demais. Peça um código novo.', 429); }
  // o e-mail pode ter mudado depois que o código saiu
  if (c.para !== acc.email) { s.codigo = null; db.save(); throw erro('O e-mail mudou depois do envio. Peça um código novo.'); }

  c.tentativas++;
  if (!iguais(db.hash(String(codigo || '')), c.hash)) {
    db.save();
    throw erro(`Código incorreto. Restam ${Math.max(0, MAX_TENTATIVAS - c.tentativas)} tentativa(s).`);
  }
  s.emailVerified = true;
  s.emailVerifiedAt = Date.now();
  s.codigo = null;
  db.save();
  return { ok: true };
}

// Trocar o e-mail derruba a verificação: o endereço novo ainda não foi provado.
function trocarEmail(acc, novo) {
  const email = String(novo || '').toLowerCase().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw erro('Informe um e-mail válido');
  const jaExiste = db.get().accounts.some(a => a.id !== acc.id && String(a.email || '').toLowerCase() === email);
  if (jaExiste) throw erro('Já existe uma conta com esse e-mail');

  if (email !== String(acc.email || '').toLowerCase()) {
    const s = estado(acc);
    acc.email = email;
    s.emailVerified = false;
    s.emailVerifiedAt = 0;
    s.codigo = null;
    // sem e-mail confirmado não há como mandar o código do segundo fator
    if (s.twoFactor) s.twoFactor = false;
    db.save();
  }
  return view(acc);
}

// ---------------------------------------------------------------------------
// SEGUNDO FATOR
// ---------------------------------------------------------------------------
function definirDoisFatores(acc, ligar) {
  const s = estado(acc);
  if (!ligar) { s.twoFactor = false; db.save(); return view(acc); }
  if (!seguranca().twoFactor) throw erro('A verificação em duas etapas não está habilitada pela plataforma', 403);
  if (!mailer.configured()) throw erro('O envio de e-mail ainda não foi configurado pela plataforma', 503);
  if (!s.emailVerified) throw erro('Confirme seu e-mail antes de ligar a verificação em duas etapas');
  s.twoFactor = true;
  db.save();
  return view(acc);
}

// O login exige o segundo fator? Precisa das três condições de pé.
function exigeDoisFatores(acc) {
  const s = estado(acc);
  return !!(s.twoFactor && s.emailVerified && seguranca().twoFactor && mailer.configured());
}

// ---------------------------------------------------------------------------
// DESAFIO DE LOGIN
//
// A senha já foi conferida quando isto roda. O ticket é o que liga o segundo
// passo ao primeiro sem manter uma sessão pela metade: enquanto ele não for
// resolvido, não existe token de acesso nenhum.
// ---------------------------------------------------------------------------
async function abrirDesafio(acc) {
  const codigo = gerarCodigo();
  const ticket = crypto.randomBytes(24).toString('hex');
  const d = db.get();
  if (!d.loginChallenges || typeof d.loginChallenges !== 'object') d.loginChallenges = {};

  // uma conta não acumula desafios abertos
  for (const [k, v] of Object.entries(d.loginChallenges)) {
    if (v.accountId === acc.id || Date.now() > v.exp) delete d.loginChallenges[k];
  }
  d.loginChallenges[ticket] = {
    accountId: acc.id, hash: db.hash(codigo),
    exp: Date.now() + LOGIN_MIN, tentativas: 0, ts: Date.now()
  };
  db.save();
  await mailer.enviarCodigoLogin(acc.email, codigo);
  return { ticket, email: mascararEmail(acc.email) };
}

function resolverDesafio(ticket, codigo) {
  const d = db.get();
  const ch = (d.loginChallenges || {})[String(ticket || '')];
  if (!ch) throw erro('Sessão de verificação inválida. Entre de novo.', 401);
  if (Date.now() > ch.exp) { delete d.loginChallenges[ticket]; db.save(); throw erro('O código expirou. Entre de novo.', 401); }
  if (ch.tentativas >= MAX_TENTATIVAS) { delete d.loginChallenges[ticket]; db.save(); throw erro('Tentativas demais. Entre de novo.', 429); }

  ch.tentativas++;
  if (!iguais(db.hash(String(codigo || '')), ch.hash)) {
    db.save();
    throw erro(`Código incorreto. Restam ${Math.max(0, MAX_TENTATIVAS - ch.tentativas)} tentativa(s).`);
  }
  const acc = db.findAccount(ch.accountId);
  delete d.loginChallenges[ticket];
  db.save();
  if (!acc) throw erro('Conta não encontrada', 401);
  return acc;
}

// "kaio@empresa.com" → "ka***@empresa.com". Confirma o endereço a quem já o
// conhece sem revelá-lo a quem só roubou a senha.
function mascararEmail(email) {
  const [nome, dominio] = String(email || '').split('@');
  if (!dominio) return '';
  const visivel = nome.slice(0, Math.min(2, nome.length));
  return visivel + '***@' + dominio;
}

module.exports = {
  seguranca, estado, view, enviarCodigoEmail, confirmarEmail, trocarEmail,
  definirDoisFatores, exigeDoisFatores, abrirDesafio, resolverDesafio, mascararEmail
};
