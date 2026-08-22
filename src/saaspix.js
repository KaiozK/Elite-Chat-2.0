// ============================================================================
// PIX DO PRÓPRIO KOONFY (assinatura, recarga da carteira, conexões e links)
//
// Estas cobranças são do SaaS para o CLIENTE — dinheiro que entra para a
// plataforma. Elas nasciam chamando `woovi.createCharge` direto, de três
// lugares diferentes. O efeito: trocar o adquirente para a Simplify em Admin →
// Gateways mudava só as vendas dos clientes; recarga de saldo, conexão extra e
// link rastreável continuavam batendo na Woovi — e, sem Woovi configurada,
// simplesmente não dava para pagar.
//
// Aqui existe UM caminho, que respeita o adquirente escolhido. Quem chama não
// precisa saber qual é.
//
// SOBRE O PAGADOR: a Simplify exige nome, CPF/CNPJ, e-mail e telefone. Nestas
// cobranças o pagador é a PRÓPRIA CONTA do cliente Koonfy, e esses dados já
// foram preenchidos no cadastro — não há nada a inventar nem a pedir de novo.
// Faltando algum, o erro diz onde completar.
// ============================================================================
const db = require('./db');
const pagamentos = require('./pagamentos');
const documento = require('./documento');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// Os dados da conta, no formato que o driver do gateway espera.
// O documento e o telefone NAO sao pedidos de novo na hora de depositar: eles
// ja foram informados em algum momento — no cadastro, no formulario do
// Pagamentos ou na conexao do WhatsApp — e ficam gravados. Procurar nos tres
// lugares aqui e o que permite a tela de recarga ser so "valor e pagar".
function pagadorDaConta(acc) {
  const p = acc.profile || {};
  const sub = (acc.pagamentos && acc.pagamentos.subaccount) || {};
  const so = v => String(v || '').replace(/D/g, '');
  const doc = so(p.document) || so(sub.document);
  const canal = (acc.channels || []).map(c => so(c.phoneNumber || c.displayPhoneNumber)).find(Boolean) || '';
  const fone = so(p.phone) || so(sub.phone) || canal;
  return {
    name: String(acc.name || sub.name || '').trim(),
    email: String(acc.email || sub.email || '').trim(),
    document: doc,
    phone: fone
  };
}

// Guarda na conta o que foi descoberto, para nao redescobrir a cada cobranca.
function fixarNoCadastro(acc) {
  const p = pagadorDaConta(acc);
  acc.profile = acc.profile || {};
  if (!acc.profile.document && p.document) acc.profile.document = p.document;
  if (!acc.profile.phone && p.phone) acc.profile.phone = p.phone;
}

// O que falta para o adquirente aceitar. Lista vazia = pode cobrar.
function faltando(acc) {
  const g = pagamentos.gateway();
  fixarNoCadastro(acc);
  if (!g.requiresPayer) return [];
  const p = pagadorDaConta(acc);
  const f = [];
  if (!p.name) f.push('nome da empresa');
  if (!p.email) f.push('e-mail');
  if (!documento.docValido(p.document)) f.push('CPF/CNPJ');
  if (p.phone.length < 10) f.push('telefone');
  return f;
}

// ---------------------------------------------------------------------------
// GERA A COBRANÇA no adquirente ativo.
//
// Devolve sempre o mesmo formato, venha de onde vier:
//   { brCode, qrCodeImage, paymentLinkUrl, gatewayId, expiresAt }
// ---------------------------------------------------------------------------
async function criarCobranca(acc, { correlationID, valueCents, comment }) {
  if (!pagamentos.configured()) throw erro('Pix indisponível no momento');

  const g = pagamentos.gateway();
  const pendencias = faltando(acc);
  if (pendencias.length) {
    throw erro(
      `Para pagar no Pix falta ${pendencias.join(', ')} no cadastro da sua conta. ` +
      'Complete em Configurações → Conta e tente de novo.'
    );
  }

  const r = await g.createCharge({
    correlationID,
    value: valueCents,
    comment: comment || 'Koonfy',
    customer: {
      name: acc.name, email: acc.email,
      phone: (acc.profile && acc.profile.phone) || '',
      payer: pagadorDaConta(acc)
    },
    expiresIn: 86400,
    // Sem subconta e sem split: este dinheiro é da plataforma, inteiro.
    subPixKey: '', splits: null
  });

  if (!r || !r.brCode) throw erro('Não foi possível gerar o código Pix agora. Tente novamente.', 502);
  return r;
}

// ---------------------------------------------------------------------------
// CONFIRMAÇÃO
//
// As cobranças do SaaS são reconhecidas pelo PREFIXO do correlationID
// (topup-, xtr-, sub-, ren-…) e liquidadas por `woovi.applyPayment`, que ativa
// plano, credita carteira e libera as unidades extras. Essa função é do módulo
// da Woovi por história, mas o que ela faz não tem nada de Woovi: é a regra de
// negócio do faturamento. Qualquer gateway entra por aqui.
// ---------------------------------------------------------------------------
const PREFIXOS = ['topup-', 'xtr-', 'sub-', 'ren-', 'card-', 'wallet-', 'bol-', 'nov-'];

function ehCobrancaSaaS(correlationID) {
  const cid = String(correlationID || '');
  return PREFIXOS.some(p => cid.startsWith(p));
}

function confirmar(correlationID, valueCents, broadcast) {
  return require('./woovi').applyPayment(
    { correlationID: String(correlationID || ''), value: Number(valueCents) || 0 },
    broadcast
  );
}

module.exports = { criarCobranca, ehCobrancaSaaS, confirmar, faltando, pagadorDaConta, fixarNoCadastro };
