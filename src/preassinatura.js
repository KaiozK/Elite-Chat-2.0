// ============================================================================
// PAGAR PRIMEIRO, CADASTRAR DEPOIS
//
// Até aqui a conta nascia no cadastro e a cobrança vinha atrás: quem desistia
// no pagamento deixava uma conta vazia no banco, e os dados que o adquirente
// exige (CPF/CNPJ, telefone) chegavam num segundo formulário — quando chegavam.
//
// Agora o caminho é o do comércio: a pessoa preenche o checkout com o que a
// cobrança precisa (nome, WhatsApp, e-mail e documento), paga, e SÓ ENTÃO a
// conta existe. O que ela digitou no checkout volta preenchido e travado no
// cadastro — é o mesmo dado que abre a conta de Pagamentos, e deixá-lo
// editável ali seria convidar a divergência entre quem pagou e quem recebe.
//
// A pré-assinatura é o registro dessa espera: nasce pendente, vira conta
// quando o webhook confirma, e morre quando o cadastro termina.
// ============================================================================
const crypto = require('crypto');
const db = require('./db');
const store = require('./store');
const documento = require('./documento');
const paises = require('./paises');
const saaspix = require('./saaspix');
const pagamentos = require('./pagamentos');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function lista() {
  const d = db.get();
  if (!Array.isArray(d.preassinaturas)) d.preassinaturas = [];
  return d.preassinaturas;
}

// O comprador, no formato que o gateway espera. Ele ainda não é uma conta,
// mas para o adquirente é o pagador de sempre.
function comoConta(pre) {
  return {
    id: pre.id,
    name: pre.empresa || pre.nome,
    email: pre.email,
    profile: { phone: pre.telefone, document: pre.documento, country: 'BR' }
  };
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO — todos os campos são obrigatórios, e é de propósito: são
// exatamente os que a conta de Pagamentos precisa para nascer junto.
// ---------------------------------------------------------------------------
function validar(b) {
  const nome = String(b.nome || '').trim();
  const email = String(b.email || '').toLowerCase().trim();
  const doc = String(b.documento || '').replace(/\D/g, '');
  if (nome.length < 3) throw erro('Informe o seu nome completo');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw erro('Informe um e-mail válido');
  const tel = paises.paraE164(String(b.pais || 'BR').toUpperCase(), b.telefone);
  if (!tel.ok) throw erro(tel.erro || 'Informe um WhatsApp válido');
  const eDoc = documento.erroDoc(doc);
  if (eDoc) throw erro(eDoc);
  if (db.findAccountByEmail(email)) throw erro('Já existe uma conta com este e-mail. Entre por ela.', 409);
  return { nome, email, telefone: tel.e164, documento: doc };
}

// ---------------------------------------------------------------------------
// CRIA a pré-assinatura e a cobrança do plano.
// ---------------------------------------------------------------------------
async function criar(b) {
  const plano = db.get().plans.find(p => p.id === b.planId && !p.archived);
  if (!plano) throw erro('Plano não encontrado');
  const dados = validar(b);

  const pre = {
    id: db.genId('pre'),
    token: crypto.randomBytes(18).toString('hex'),
    planId: plano.id,
    ...dados,
    refBy: String(b.ref || '').trim().slice(0, 24),
    status: 'pending',
    valor: plano.price,
    correlationID: '',
    accountId: '',
    criadoEm: Date.now(),
    pagoEm: 0
  };
  pre.correlationID = 'nov-' + pre.id + '-' + crypto.randomBytes(4).toString('hex');

  const cobranca = await saaspix.criarCobranca(comoConta(pre), {
    correlationID: pre.correlationID,
    valueCents: plano.price,
    comment: 'Koonfy · ' + plano.name
  });
  pre.brCode = cobranca.brCode || '';
  pre.qrCodeImage = cobranca.qrCodeImage || '';

  lista().push(pre);
  // guarda no máximo as 500 últimas: o resto é lixo de gente que desistiu
  if (lista().length > 500) lista().splice(0, lista().length - 500);
  db.save();
  store.logEvent({ type: 'preassinatura_criada', preId: pre.id, planId: plano.id, valor: plano.price });
  return { token: pre.token, cobranca, plano: { id: plano.id, nome: plano.name, preco: plano.price } };
}

function ehPreAssinatura(cid) { return String(cid || '').startsWith('nov-'); }

function porToken(token) {
  return lista().find(p => p.token === String(token || '')) || null;
}

// ---------------------------------------------------------------------------
// PAGOU: aqui a conta passa a existir.
//
// O plano já entra ativo — o dinheiro entrou. A senha ainda não existe: quem
// paga termina o cadastro na tela seguinte, e é lá que ela é definida.
// ---------------------------------------------------------------------------
function confirmar(cid, valorPago, broadcast) {
  const pre = lista().find(p => p.correlationID === cid);
  if (!pre) { store.logEvent({ type: 'preassinatura_sem_dono', correlationID: cid }); return { ok: false, reason: 'unmatched' }; }
  if (pre.status === 'paid' || pre.accountId) return { ok: true, duplicate: true, accountId: pre.accountId };

  const data = db.get();
  const plano = data.plans.find(p => p.id === pre.planId);
  const acc = db.newAccount({ name: pre.nome, email: pre.email, pass: crypto.randomBytes(24).toString('hex') });
  acc.profile.phone = pre.telefone;
  acc.profile.document = pre.documento;
  // Nasce SEM senha utilizável: a de verdade é definida no cadastro, e até lá
  // ninguém entra com um palpite.
  acc.pendenteCadastro = true;

  const dias = (plano && plano.periodDays ? plano.periodDays : 30) * 86400000;
  acc.billing.status = 'active';
  acc.billing.planId = pre.planId;
  acc.billing.periodEnd = Date.now() + dias;
  acc.billing.startedAt = Date.now();

  const aff = pre.refBy ? db.findAccountByRefCode(pre.refBy) : null;
  if (aff) acc.affiliate.refBy = aff.affiliate.code;

  data.accounts.push(acc);
  data.revenue.push({ ts: Date.now(), accountId: acc.id, planId: pre.planId, amount: valorPago, kind: 'first', chargeId: cid });

  pre.status = 'paid';
  pre.pagoEm = Date.now();
  pre.accountId = acc.id;
  db.save();

  // A conta de Pagamentos nasce do mesmo dado que pagou. Não trava nada se o
  // adquirente estiver fora do ar.
  try { pagamentos.garantirPagamentos(acc).catch(() => {}); } catch {}

  store.logEvent({ type: 'preassinatura_paga', preId: pre.id, accountId: acc.id, valor: valorPago });
  if (broadcast) broadcast('billing', { accountId: acc.id });
  return { ok: true, kind: 'first', accountId: acc.id };
}

// ---------------------------------------------------------------------------
// TERMINA O CADASTRO: empresa, senha e o perfil. Os dados do checkout NÃO
// voltam aqui — eles já estão na conta e são os mesmos do recebimento.
// ---------------------------------------------------------------------------
function concluir(token, b) {
  const pre = porToken(token);
  if (!pre) throw erro('Cadastro não encontrado', 404);
  if (pre.status === 'pending') throw erro('O pagamento ainda não foi confirmado', 409);
  const acc = db.findAccount(pre.accountId);
  if (!acc) throw erro('Conta não encontrada', 404);
  if (pre.status === 'done') throw erro('Este cadastro já foi concluído. Entre com o seu e-mail e senha.', 409);

  const empresa = String(b.empresa || '').trim();
  const senha = String(b.senha || '');
  if (empresa.length < 2) throw erro('Informe o nome da empresa');
  if (senha.length < 6) throw erro('A senha deve ter pelo menos 6 caracteres');

  acc.name = empresa.slice(0, 120);
  acc.passHash = db.hashPassword(senha);
  acc.pendenteCadastro = false;
  for (const k of ['segment', 'size', 'goal']) {
    if (b[k] !== undefined) acc.profile[k] = String(b[k] || '').trim().slice(0, 60);
  }
  pre.status = 'done';
  db.save();
  store.logEvent({ type: 'preassinatura_concluida', preId: pre.id, accountId: acc.id });
  return acc;
}

// O que a tela de cadastro mostra: o que veio do checkout (travado) e o estado
// do pagamento.
function publico(token) {
  const pre = porToken(token);
  if (!pre) return null;
  const plano = db.get().plans.find(p => p.id === pre.planId);
  return {
    status: pre.status,
    plano: plano ? { nome: plano.name, preco: plano.price, dias: plano.periodDays || 30 } : null,
    // travados no formulário: são os dados que abriram a conta de Pagamentos
    dados: { nome: pre.nome, email: pre.email, telefone: pre.telefone, documento: pre.documento },
    cobranca: pre.status === 'pending' ? { brCode: pre.brCode, qrCodeImage: pre.qrCodeImage } : null
  };
}

module.exports = { criar, confirmar, concluir, publico, porToken, ehPreAssinatura };
