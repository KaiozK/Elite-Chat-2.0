// ============================================================================
// O DINHEIRO: DE ONDE VEM, ONDE FICA, POR ONDE SAI
//
// Auditoria do caminho inteiro de um real dentro do Koonfy. Os testes de
// pagamento que já existem cobrem cada peça (carteira, saque, comissão,
// estorno). Este cobre o que nenhum deles olha: se o dinheiro FECHA.
//
// Três perguntas, e todas têm resposta em número:
//
//   1. CONSERVAÇÃO. O que o cliente pagou é igual ao que o lojista recebeu
//      mais a taxa da plataforma? Um centavo a mais ou a menos aqui é dinheiro
//      inventado ou perdido, e ninguém percebe olhando a tela.
//
//   2. O EXTRATO BATE COM O SALDO? O saldo é um número somado a cada evento; o
//      extrato é a lista desses eventos. Se os dois divergem, um dos dois está
//      mentindo — e o cliente confere pelo extrato, mas saca pelo saldo.
//
//   3. NINGUÉM TRANSFERE SOZINHO. A taxa da plataforma fica retida por
//      REGISTRO: o dinheiro está na conta do gateway e a carteira diz de quem
//      é cada parte. Nada no app pode mandar dinheiro para fora sem alguém
//      pedir — nem o saque, que é um pedido para o admin pagar.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');
const path = require('path');

const ARQ = path.join(R, 'data', 'db.json');
const original = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
const devolver = () => { try { if (original) fs.writeFileSync(ARQ, original); } catch {} };
process.on('exit', devolver);
process.on('uncaughtException', e => { devolver(); console.error(e); process.exit(1); });

const db = require(R + 'src/db');
const pagamentos = require(R + 'src/pagamentos');

const brl = c => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');

(async () => {
  db.load();
  const d = db.get();
  d.accounts.length = 0;
  d.withdrawals = [];
  const p = pagamentos.platformCfg();
  p.feeInPercent = 5;            // 5% de taxa da plataforma na entrada
  p.feeOutPercent = 0;
  p.splitPixKey = '';            // SEM chave de split: nada sai por transferência

  const loja = db.newAccount({ name: 'Loja', email: 'loja@ex.com', pass: 'segredo123' });
  loja.billing.status = 'active';
  loja.billing.periodEnd = Date.now() + 30 * 864e5;
  db.save();

  console.log('=== 1. CONSERVAÇÃO: o que entra é igual ao que se reparte ===');
  // Uma venda de R$ 200,00 com 5% de taxa. O lojista tem de receber R$ 190,00
  // e a plataforma R$ 10,00 — e a soma tem de dar exatamente os R$ 200,00.
  const VENDA = 20000;
  const { platformCut, feePercent } = pagamentos.computeSplit(VENDA);
  ok(feePercent === 5, 'a taxa aplicada é a configurada pelo admin', feePercent + '%');
  ok(platformCut === 1000, 'a parte da plataforma', brl(platformCut));

  const ch = {
    id: db.genId('ch'), value: VENDA, platformCut, method: 'pix',
    status: 'paid', contactName: 'Cliente', saas: false
  };
  const antes = loja.wallet.balance;
  const liquido = pagamentos.creditPixSale(loja, ch, null);
  ok(liquido === 19000, 'o lojista recebe o líquido', brl(liquido));
  ok(liquido + platformCut === VENDA,
     'líquido + taxa = valor pago — nenhum centavo aparece nem some',
     `${brl(liquido)} + ${brl(platformCut)} = ${brl(VENDA)}`);
  ok(loja.wallet.balance === antes + liquido, 'e o saldo subiu exatamente isso', brl(loja.wallet.balance));

  console.log('\n=== 2. Webhook repetido não paga duas vezes ===');
  // A Meta e os gateways reenviam quando demoram a receber o 200. Sem guarda,
  // cada reenvio pagaria a venda de novo.
  const saldoUm = loja.wallet.balance;
  pagamentos.creditPixSale(loja, ch, null);
  pagamentos.creditPixSale(loja, ch, null);
  ok(loja.wallet.balance === saldoUm, 'três webhooks, um crédito só', brl(loja.wallet.balance));

  console.log('\n=== 3. O EXTRATO BATE COM O SALDO ===');
  // O saldo é somado evento a evento; o extrato é a lista dos eventos. O
  // cliente confere pelo extrato e saca pelo saldo: se divergirem, um dos dois
  // está mentindo e a conta só aparece quando o dinheiro falta.
  const soma = ts => ts.reduce((s, t) => s + (Number(t.amount) || 0), 0);
  ok(soma(loja.wallet.transactions) === loja.wallet.balance,
     'a soma do extrato é o saldo',
     `extrato ${brl(soma(loja.wallet.transactions))} · saldo ${brl(loja.wallet.balance)}`);

  console.log('\n=== 4. Estorno tira o que a venda pôs, e o extrato acompanha ===');
  const r = pagamentos.reverterVenda(loja, ch, 'refund', null);
  ok(r && r.liquido === liquido, 'sai o mesmo líquido que entrou', brl(r ? r.liquido : 0));
  ok(loja.wallet.balance === antes, 'o saldo volta ao que era', brl(loja.wallet.balance));
  ok(soma(loja.wallet.transactions) === loja.wallet.balance, 'e o extrato continua batendo');
  const saldoEstornado = loja.wallet.balance;
  pagamentos.reverterVenda(loja, ch, 'refund', null);
  ok(loja.wallet.balance === saldoEstornado, 'estornar duas vezes não cobra duas vezes');

  console.log('\n=== 5. NINGUÉM TRANSFERE SOZINHO ===');
  // A taxa fica retida por REGISTRO: o dinheiro está no gateway e a carteira
  // diz de quem é cada parte. O saque é um PEDIDO — quem paga é o admin.
  const fonte = fs.readFileSync(R + 'src/pagamentos.js', 'utf8');
  const outros = ['api', 'saasbilling', 'woovi', 'assinaturas', 'topup', 'saaspix']
    .map(f => fs.readFileSync(R + 'src/' + f + '.js', 'utf8')).join('\n');
  // `withdraw(pixKey)` na Woovi saca a subconta INTEIRA — inclusive a parte da
  // plataforma que está retida ali. Se algum dia for ligado, a taxa vaza junto.
  ok(!/\bdrv\.withdraw\(|\bdriver\([^)]*\)\.withdraw\(|DRIVERS\[[^\]]*\]\.withdraw\(/.test(fonte + outros),
     'nada no app chama o saque do gateway — a subconta não é esvaziada por código');
  const rota = fs.readFileSync(R + 'src/api.js', 'utf8');
  const bloco = rota.slice(rota.indexOf("router.post('/wallet/withdraw'"), rota.indexOf("router.get('/wallet/summary'"));
  ok(/withdrawals\.push\(/.test(bloco) && /status: 'pending'/.test(bloco),
     'o saque entra como PEDIDO pendente, para o admin pagar na mão');
  ok(!/pagamentos\.(withdraw|transferir|payout)/.test(bloco),
     'e não chama transferência nenhuma no caminho');

  console.log('\n=== 6. O saque respeita o saldo, e o recusado devolve ===');
  loja.wallet.balance = 50000;
  loja.wallet.cardAvailable = 0;
  loja.wallet.transactions = [{ id: 'tx0', ts: Date.now(), amount: 50000, type: 'pix_sale', label: 'saldo inicial' }];
  db.save();
  const f = pagamentos.computeWithdrawFee(loja, 30000);
  pagamentos.debitWithdraw(loja, 30000);
  ok(loja.wallet.balance === 20000, 'o saque sai do saldo', brl(loja.wallet.balance));
  const pedido = { id: 'wd1', accountId: loja.id, amount: 30000, fee: f.fee, fromCard: f.fromCard };
  pagamentos.refundWithdraw(loja, pedido);
  ok(loja.wallet.balance === 50000, 'recusado, o dinheiro volta inteiro', brl(loja.wallet.balance));
  pagamentos.refundWithdraw(loja, pedido);
  ok(loja.wallet.balance === 50000, 'e devolver duas vezes não cria dinheiro');

  console.log('\n=== 7. A ASSINATURA DO KOONFY não é venda do cliente ===');
  // O dinheiro da mensalidade é da plataforma. Se entrasse na carteira do
  // cliente, ele sacaria o que acabou de pagar.
  const saldoAntes = loja.wallet.balance;
  const mens = { id: db.genId('ch'), value: 9900, platformCut: 0, method: 'pix', status: 'paid', saas: true };
  pagamentos.creditPixSale(loja, mens, null);
  ok(loja.wallet.balance === saldoAntes, 'a mensalidade não entra na carteira do cliente', brl(loja.wallet.balance));

  console.log('\n=== 8. Taxa zerada: nada é retido, e a conta continua fechando ===');
  p.feeInPercent = 0;
  const s0 = pagamentos.computeSplit(20000);
  ok(s0.platformCut === 0, 'sem taxa configurada, a plataforma não retém nada');
  const ch0 = { id: db.genId('ch'), value: 20000, platformCut: 0, method: 'pix', status: 'paid', saas: false };
  const b0 = loja.wallet.balance;
  pagamentos.creditPixSale(loja, ch0, null);
  ok(loja.wallet.balance === b0 + 20000, 'o lojista recebe o valor cheio', brl(loja.wallet.balance - b0));

  console.log('\n=== 9. Centavos: a taxa arredonda para BAIXO, a favor do lojista ===');
  // 5% de R$ 10,01 dá 50,05 centavos. Arredondar para cima cobraria do lojista
  // um centavo que a plataforma não tem direito, em toda venda quebrada.
  p.feeInPercent = 5;
  const q = pagamentos.computeSplit(1001);
  ok(q.platformCut === 50, 'de R$ 10,01 a taxa é R$ 0,50, não R$ 0,51', brl(q.platformCut));
  ok(1001 - q.platformCut === 951, 'e o lojista fica com o centavo da dúvida', brl(1001 - q.platformCut));

  d.accounts.length = 0;
  db.save();
  devolver();
  await encerrar(null, falhas);
})();
