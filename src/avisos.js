// ============================================================================
// AVISOS DE DINHEIRO — quem precisa saber, sabe na hora
//
// Três notificações, e cada uma existe por um motivo diferente:
//
//   · VENDA (dono da conta)  — já existia como teste em /push/test-sale, mas
//     a venda DE VERDADE não disparava nada. Quem vendeu só descobria abrindo
//     o painel.
//   · VENDA (admin da plataforma) — o admin não tem como acompanhar a operação
//     de cada cliente. Saber que houve venda é saber que a taxa entrou.
//   · COMISSÃO (afiliado) — o aviso existia, mas só por SSE: chegava apenas em
//     quem estivesse com o app ABERTO naquele segundo. Com o app fechado,
//     ninguém ficava sabendo.
//
// Tudo aqui é BEST-EFFORT: nenhum erro de push pode derrubar a confirmação de
// um pagamento. Por isso cada envio é embrulhado e o retorno é ignorado.
// ============================================================================
const db = require('./db');
const push = require('./push');
const pushNative = require('./pushnative');

function brl(cents) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents || 0) / 100);
}

// Envia pelos dois caminhos: WebPush (PWA/navegador) e push nativo (apps das
// lojas). Um aparelho aparece em um ou no outro, nunca nos dois.
async function enviar(acc, tipo, payload) {
  if (!acc) return;
  try { await push.sendToAccount(acc, tipo, payload); } catch (e) { console.warn('[avisos] web push:', e.message); }
  try { await pushNative.sendToAccount(acc, tipo, payload); } catch (e) { console.warn('[avisos] push nativo:', e.message); }
}

function contaAdmin() {
  return db.get().accounts.find(a => a.isAdmin) || null;
}

// ---------------------------------------------------------------------------
// VENDA CONFIRMADA
//
// `ch` é a cobrança já marcada como paga. O admin recebe um aviso DIFERENTE do
// que o cliente recebe: para ele o que importa é quem vendeu e quanto ficou de
// taxa, não a venda em si.
// ---------------------------------------------------------------------------
function avisarVenda(acc, ch) {
  if (!acc || !ch) return;
  const valor = brl(ch.value);

  // O aviso de quem VENDEU: o valor da venda, e só. Nome do pagador e meio
  // de pagamento estão a um toque de distância, na tela que o aviso abre.
  enviar(acc, 'sale', {
    title: 'Venda Aprovada',
    body: `Valor: ${valor}`,
    tag: 'venda:' + ch.id,
    data: { type: 'sale', url: '/app/#/elitepay' }
  });

  // A assinatura do próprio Koonfy paga pelo checkout não é venda do cliente:
  // avisar o admin dela aqui duplicaria o aviso de faturamento.
  if (ch.saas && ch.saas.accountId) return;

  const admin = contaAdmin();
  if (!admin || admin.id === acc.id) return;   // o admin também vende: não se avisa duas vezes
  // O aviso da PLATAFORMA: o número que interessa aqui não é o da venda, é o
  // que ficou para ela. Quem vendeu e quanto vendeu estão na tela do Admin.
  const taxa = ch.platformCut || 0;
  enviar(admin, 'sale', {
    title: 'Venda aprovada',
    body: `Sua comissão: ${brl(taxa)}`,
    tag: 'venda-cliente:' + ch.id,
    data: { type: 'sale', url: '/app/#/admin' }
  });
}

// ---------------------------------------------------------------------------
// COMISSÃO DE AFILIADO CREDITADA
// ---------------------------------------------------------------------------
function avisarComissao(aff, { amount, percent, kind, indicado }) {
  if (!aff || !amount) return;
  const origem = kind === 'first' ? 'nova assinatura' : 'renovação';
  enviar(aff, 'commission', {
    title: 'Comissão na conta! 🤝',
    body: `${brl(amount)} (${percent}%) de ${indicado || 'um indicado'} — ${origem}. Já está no seu saldo.`,
    tag: 'comissao:' + Date.now(),
    data: { type: 'commission', url: '/app/#/afiliacao' }
  });
}

module.exports = { avisarVenda, avisarComissao, brl };
