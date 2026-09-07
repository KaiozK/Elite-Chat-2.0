// ============================================================================
// PAGAMENTOS E CARTEIRA — auditoria do dinheiro
//
// Aqui o erro não dá tela vermelha: ele dá diferença de saldo, e aparece na
// conciliação semanas depois. Por isso o teste é sobre INVARIANTES, e não
// sobre telas: saldo não fica negativo por gasto, webhook repetido não paga
// duas vezes, estorno tira o que entrou, e desfazer é o inverso exato de fazer.
//
// DOIS FUROS REAIS encontrados nesta auditoria:
//
//   · O SAQUE RECUSADO DEVOLVIA SÓ METADE DA VERDADE. O admin recusa, o
//     `balance` volta — e o `cardAvailable` não. O dinheiro que veio de venda
//     no cartão passava a ser contado como dinheiro de Pix, e como cada origem
//     tem taxa de saque própria, o saque seguinte cobrava a taxa errada. Erro
//     silencioso: nunca aparece no dia, só na conciliação.
//   · A VENDA NO CARTÃO NÃO TINHA GUARDA DE IDEMPOTÊNCIA. O Pix tinha
//     (`walletCredited`), o cartão não. Hoje `finalizePaid` barra a repetição
//     antes de chegar lá — mas a proteção do dinheiro não pode depender de
//     quem chama, e a assimetria engana quem lê o código.
// ============================================================================
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

const ARQ = path.join(R, 'data', 'db.json');
const original = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
const devolver = () => { try { if (original) fs.writeFileSync(ARQ, original); } catch {} };
process.on('exit', devolver);
process.on('uncaughtException', e => { devolver(); console.error(e); process.exit(1); });

const db = require(path.join(R, 'src', 'db'));
const pag = require(path.join(R, 'src', 'pagamentos'));

db.load();
const data = db.get();
data.accounts.length = 0;
data.withdrawals.length = 0;

const brl = c => 'R$ ' + (c / 100).toFixed(2);
const conta = (nome, email) => { const a = db.newAccount({ name: nome, email, pass: '123456' }); data.accounts.push(a); return a; };

(async () => {
  const acc = conta('Loja', 'loja@teste.local');

  console.log('=== 1. O saldo nunca fica negativo por um GASTO ===');
  acc.wallet.balance = 1000;
  let erro = '';
  try { pag.spendWallet(acc, 1500, 'teste'); } catch (e) { erro = e.message; }
  ok(/insuficiente/i.test(erro), 'gastar mais do que tem é recusado', erro.slice(0, 45));
  ok(acc.wallet.balance === 1000, 'e o saldo não é tocado na recusa', brl(acc.wallet.balance));
  pag.spendWallet(acc, 1000, 'gasto exato');
  ok(acc.wallet.balance === 0, 'gastar o valor exato zera, e para aí', brl(acc.wallet.balance));
  const tx = acc.wallet.transactions.slice(-1)[0];
  ok(tx && tx.amount === -1000 && tx.type === 'spend', 'todo gasto deixa lançamento no extrato', tx && tx.label);

  console.log('\n=== 2. Saque: a taxa segue a ORIGEM do dinheiro ===');
  // O saldo mistura Pix e cartão, e cada um tem taxa própria. Sacar consome
  // primeiro o de cartão, que é o mais caro de deixar parado.
  acc.wallet.balance = 100000;
  acc.wallet.cardAvailable = 40000;
  const f = pag.computeWithdrawFee(acc, 50000);
  ok(f.fromCard === 40000 && f.fromPix === 10000,
     'a conta separa quanto veio de cada origem', 'cartão ' + brl(f.fromCard) + ' + Pix ' + brl(f.fromPix));
  ok(f.fee === f.cardFee + f.pixFee, 'e a taxa é a soma das duas partes', brl(f.fee));
  ok(f.net === 50000 - f.fee, 'o líquido é o pedido menos a taxa', brl(f.net));
  const d = pag.debitWithdraw(acc, 50000);
  ok(acc.wallet.balance === 50000, 'o saque debita o saldo', brl(acc.wallet.balance));
  ok(acc.wallet.cardAvailable === 0, 'consumindo primeiro a parte do cartão', brl(acc.wallet.cardAvailable));
  ok(d.fromCard === 40000, 'e devolve quanto saiu do cartão, para poder ser desfeito', brl(d.fromCard));

  console.log('\n=== 3. Saque RECUSADO é o inverso EXATO do saque ===');
  // Era aqui que a origem do dinheiro se perdia.
  const pedido = { id: 'wd1', accountId: acc.id, amount: 50000, fromCard: d.fromCard, status: 'pending' };
  pag.refundWithdraw(acc, pedido);
  ok(acc.wallet.balance === 100000, 'o saldo volta ao que era', brl(acc.wallet.balance));
  ok(acc.wallet.cardAvailable === 40000,
     'E a parte de cartão volta junto — senão a taxa do próximo saque sai errada',
     brl(acc.wallet.cardAvailable));
  const tr = acc.wallet.transactions.slice(-1)[0];
  ok(tr && tr.type === 'refund' && tr.amount === 50000, 'com a devolução no extrato', tr && tr.label);
  // E a rota do admin usa esta função, em vez de repetir a conta na mão.
  const api = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
  ok(/pagamentos\.refundWithdraw\(acc, wd\)/.test(api),
     'e a recusa do admin chama justamente esta função');
  ok(!/acc\.wallet\.balance \+= wd\.amount/.test(api),
     'sem uma segunda conta escrita na mão para divergir depois');

  console.log('\n=== 4. Webhook repetido não paga duas vezes ===');
  const ch = { id: 'ch1', value: 10000, platformCut: 1000, method: 'pix', status: 'pending' };
  pag.ensure(acc).charges.push(ch);
  const saldoAntes = acc.wallet.balance;
  pag.creditPixSale(acc, ch, null);
  ok(acc.wallet.balance === saldoAntes + 9000,
     'a venda no Pix entra líquida (valor menos a taxa da plataforma)', brl(acc.wallet.balance - saldoAntes));
  pag.creditPixSale(acc, ch, null);
  pag.creditPixSale(acc, ch, null);
  ok(acc.wallet.balance === saldoAntes + 9000, 'e repetir o webhook não credita de novo', brl(acc.wallet.balance));
  // A mesma guarda do lado do cartão: hoje `finalizePaid` já barra antes, e é
  // por isso mesmo que ela precisa existir aqui — a proteção do dinheiro não
  // pode depender de quem chama.
  const src = fs.readFileSync(path.join(R, 'src', 'pagamentos.js'), 'utf8');
  const cartao = src.slice(src.indexOf('function creditCardSale'), src.indexOf('function creditCardSale') + 1200);
  ok(/if \(ch\.walletCredited\) return null;/.test(cartao),
     'a venda no cartão tem a MESMA guarda do Pix');
  ok(/if \(ch\.status === 'paid'\) return \{ ok: true, duplicate: true \};/.test(src),
     'e `finalizePaid` barra a cobrança repetida antes de tudo');

  console.log('\n=== 5. Estorno tira da carteira o que a venda pôs ===');
  const antesEst = acc.wallet.balance;
  pag.reverterVenda(acc, ch, 'refund', null);
  ok(acc.wallet.balance === antesEst - 9000, 'o líquido sai da carteira', brl(acc.wallet.balance));
  const antes2 = acc.wallet.balance;
  pag.reverterVenda(acc, ch, 'refund', null);
  ok(acc.wallet.balance === antes2, 'e estornar duas vezes não tira duas vezes', brl(acc.wallet.balance));

  console.log('\n=== 6. A taxa da plataforma é aplicada e é a configurada ===');
  data.platform.pagamentos = Object.assign({}, data.platform.pagamentos, { feeInPercent: 10 });
  const sp = pag.computeSplit(10000);
  ok(sp.platformCut === 1000, '10% de R$ 100 são R$ 10', brl(sp.platformCut));
  ok(pag.computeSplit(1).platformCut === 0,
     'e o arredondamento é para BAIXO — a plataforma nunca cobra um centavo a mais');

  console.log('\n=== 7. A carteira é do TITULAR ===');
  // Um atendente com acesso à carteira pede saque para a chave Pix DELE.
  for (const rota of ["router.put('/wallet/auto-topup', auth, ownerOnly",
                      "router.post('/wallet/withdraw', auth, ownerOnly",
                      "router.get('/wallet/summary', auth, ownerOnly",
                      "router.get('/wallet/withdraw/quote', auth, ownerOnly",
                      "router.get('/pagamentos/saldo', auth, ownerOnly"]) {
    ok(api.includes(rota), rota.replace('router.', '').replace(', auth, ownerOnly', '') + ' exige ser o titular');
  }

  console.log('\n=== 8. O saque tem faixa, e ela é do admin ===');
  ok(/wd\.min/.test(api) && /wd\.max > 0 && amount > wd\.max/.test(api),
     'mínimo e máximo saem de Admin SaaS → Afiliados');
  ok(/amount > req\.acc\.wallet\.balance/.test(api), 'e não dá para sacar mais do que se tem');

  const antesT = JSON.parse(original || '{}');
  for (const k of ['accounts', 'revenue', 'plans', 'withdrawals']) {
    if (Array.isArray(data[k])) data[k].length = 0;
    if (Array.isArray(antesT[k])) data[k].push(...antesT[k]);
  }
  db.save();
  devolver();
  await encerrar(null, falhas);
})();
