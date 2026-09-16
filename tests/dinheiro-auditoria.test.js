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

  console.log('\n=== 5. O SAQUE AUTOMÁTICO NÃO PODE LEVAR A PARTE DA CASA ===');
  // Este bloco MUDOU DE PERGUNTA, e vale dizer por quê. Antes ele provava que
  // nada no app transferia dinheiro sozinho — a regra era "o saque é um pedido,
  // quem paga é o admin". Agora o saque PODE ser automático, porque foi pedido
  // que fosse. Só que o perigo que a regra antiga evitava continua exatamente o
  // mesmo, e é este:
  //
  //   o saque da Woovi (`POST /subaccount/{chave}/withdraw`) vai com o corpo
  //   VAZIO. Ele não recebe valor: ESVAZIA A SUBCONTA INTEIRA. E quando não há
  //   `splitPixKey` configurada, a taxa da plataforma está DENTRO dessa
  //   subconta — é só um número no nosso livro. Esvaziar ali entregaria ao
  //   lojista a comissão da casa, em toda venda, sem ninguém perceber.
  //
  // Então o que se prova aqui não é mais "ninguém transfere": é que nenhuma das
  // situações em que transferir custaria dinheiro passa pela porta.
  const rota = fs.readFileSync(R + 'src/api.js', 'utf8');
  const bloco = rota.slice(rota.indexOf("router.post('/wallet/withdraw'"), rota.indexOf("router.get('/wallet/summary'"));
  ok(/withdrawals\.push\(/.test(bloco) && /status: 'pending'/.test(bloco),
     'o saque nasce como pedido pendente — o automático só o CONCLUI depois');
  ok(bloco.indexOf('debitWithdraw') < bloco.indexOf('pagarSaqueAuto'),
     'e o débito acontece ANTES da chamada ao gateway (dois cliques não sacam duas vezes)');

  // As condições, uma a uma, com a conta montada de verdade.
  const sub = pagamentos.ensure(loja);
  sub.subaccount = { pixKey: 'loja@ex.com', status: 'active' };
  const semCartao = { fromCard: 0, fee: 0 };
  p.gateway = 'woovi';

  p.feeInPercent = 5; p.splitPixKey = '';
  ok(pagamentos.podeSaqueAuto(loja, 10000, semCartao).motivo === 'split',
     'taxa de venda SEM chave de split: a parte da casa está na subconta, não sai sozinho');

  p.splitPixKey = 'financeiro@koonfy.com';
  ok(pagamentos.podeSaqueAuto(loja, 10000, semCartao).pode === true,
     'com o split configurado, a subconta só tem o dinheiro do lojista — pode');

  p.feeInPercent = 0; p.splitPixKey = '';
  ok(pagamentos.podeSaqueAuto(loja, 10000, semCartao).pode === true,
     'sem taxa de venda também pode: não há parte da casa retida ali');

  ok(pagamentos.podeSaqueAuto(loja, 10000, { fromCard: 5000, fee: 0 }).motivo === 'cartao',
     'dinheiro de CARTÃO não está na subconta Pix — esse saque não é automático');
  ok(pagamentos.podeSaqueAuto(loja, 10000, { fromCard: 0, fee: 300 }).motivo === 'taxa',
     'com taxa de saque retida, esvaziar a subconta entregaria a taxa junto');

  p.gateway = 'simplify';
  ok(pagamentos.podeSaqueAuto(loja, 10000, semCartao).motivo === 'gateway',
     'a Simplify não paga saque por API — sempre pedido');
  p.gateway = 'woovi';

  sub.subaccount = { pixKey: '', status: 'pending' };
  ok(pagamentos.podeSaqueAuto(loja, 10000, semCartao).motivo === 'subconta',
     'sem conta de recebimento ativa não há para onde mandar');
  sub.subaccount = { pixKey: 'loja@ex.com', status: 'active' };

  console.log('\n=== 5b. O VALOR PEDIDO TEM DE SER O SALDO QUE ESTÁ LÁ ===');
  // O endpoint esvazia tudo. Se o pedido for de R$ 50 e a subconta tiver
  // R$ 300, pagar automaticamente mandaria R$ 300 e debitaria R$ 50 — R$ 250
  // saindo da plataforma de graça. Trocamos o driver por um de mentira para
  // provar o comportamento, em vez de confiar na leitura do código.
  const mod = require(R + 'src/pagamentos');
  const drv = mod.drivers().woovi;
  const gwReal = { getSubBalance: drv.getSubBalance, withdraw: drv.withdraw };

  let sacou = 0;
  drv.getSubBalance = async () => 30000;
  drv.withdraw = async () => { sacou++; return { transactionID: 'tx-falso' }; };

  const pedidoParcial = { id: 'wdA', accountId: loja.id, amount: 5000, fee: 0, fromCard: 0, status: 'pending' };
  const rA = await mod.pagarSaqueAuto(loja, pedidoParcial);
  ok(rA.pago === false && rA.motivo === 'parcial', 'pedido menor que o saldo da subconta: NÃO paga sozinho', rA.motivo);
  ok(sacou === 0, 'e nem chegou a chamar o saque do gateway');
  ok(pedidoParcial.status === 'pending', 'o pedido fica para o admin');

  // O saque da Woovi vai para a chave da SUBCONTA, e não para a que a pessoa
  // digitou. Se as duas divergem, pagar sozinho mandaria o dinheiro para um
  // lugar diferente do que está escrito no recibo.
  const pedidoOutraChave = { id: 'wdX', accountId: loja.id, amount: 30000, fee: 0, fromCard: 0, status: 'pending', pixKey: 'outra@pessoa.com' };
  const rX = await mod.pagarSaqueAuto(loja, pedidoOutraChave);
  ok(rX.pago === false && rX.motivo === 'chave', 'chave digitada diferente da cadastrada: não paga sozinho', rX.motivo);
  ok(sacou === 0, 'e o gateway continua sem ser chamado');

  const pedidoExato = { id: 'wdB', accountId: loja.id, amount: 30000, fee: 0, fromCard: 0, status: 'pending', pixKey: 'LOJA@ex.com ' };
  const rB = await mod.pagarSaqueAuto(loja, pedidoExato);
  // A chave do pedido vai com espaço e maiúscula de propósito: e-mail não
  // diferencia caixa, e recusar por isso viraria um saque manual sem motivo.
  ok(rB.pago === true && sacou === 1, 'pedido igual ao saldo da subconta: paga na hora (chave confere sem ligar para caixa nem espaço)');
  ok(pedidoExato.status === 'paid' && pedidoExato.auto === true, 'e o pedido fica marcado como pago automaticamente');

  const rB2 = await mod.pagarSaqueAuto(loja, pedidoExato);
  ok(rB2.pago === false && sacou === 1, 'pagar o mesmo pedido de novo não transfere duas vezes');

  drv.getSubBalance = async () => null;
  const pedidoCego = { id: 'wdC', accountId: loja.id, amount: 30000, fee: 0, fromCard: 0, status: 'pending' };
  const rC = await mod.pagarSaqueAuto(loja, pedidoCego);
  ok(rC.pago === false && rC.motivo === 'saldo_desconhecido',
     'sem conseguir confirmar o saldo lá, não transfere no escuro');

  drv.getSubBalance = async () => 30000;
  drv.withdraw = async () => { throw new Error('gateway fora do ar'); };
  const saldoAntesFalha = loja.wallet.balance;
  const pedidoQuebra = { id: 'wdD', accountId: loja.id, amount: 30000, fee: 0, fromCard: 0, status: 'pending' };
  const rD = await mod.pagarSaqueAuto(loja, pedidoQuebra);
  ok(rD.pago === false && rD.motivo === 'falhou', 'gateway fora do ar: o pedido fica pendente');
  ok(loja.wallet.balance === saldoAntesFalha,
     'e o valor NÃO volta sozinho para a carteira — o POST pode ter passado do outro lado');

  drv.getSubBalance = gwReal.getSubBalance; drv.withdraw = gwReal.withdraw;

  console.log('\n=== 5c. SAQUE DE VALOR EXATO: sai o pedido, fica a taxa ===');
  // O esvaziamento da subconta não aceita valor, e era ele que obrigava o saque
  // automático a ser sempre "tudo". O caminho de valor exato são DUAS chamadas:
  // a subconta do lojista transfere o pedido para a subconta da plataforma, e a
  // plataforma manda o líquido por Pix Out para a chave dele. A diferença é a
  // taxa de saque, e ela tem de FICAR — é para isso que a ordem importa.
  const gw2 = {
    transferirEntreSubcontas: drv.transferirEntreSubcontas,
    verificarChavePix: drv.verificarChavePix,
    pixOut: drv.pixOut,
    getSubBalance: drv.getSubBalance
  };
  const passos = [];
  drv.getSubBalance = async () => 100000;                       // R$ 1.000 na subconta
  drv.transferirEntreSubcontas = async a => { passos.push(['transfer', a.valueCents, a.fromPixKey, a.toPixKey]); return { ok: true }; };
  drv.verificarChavePix = async k => { passos.push(['check', k]); return { endToEndId: 'E2E-FALSO' }; };
  drv.pixOut = async a => { passos.push(['pixout', a.valueCents, a.pixKey, a.pixKeyType]); return { status: 'APPROVED', endToEndId: 'E2E-PAGO' }; };

  p.gateway = 'woovi';
  p.splitPixKey = 'financeiro@koonfy.com';
  p.splitPixKeyType = '';
  p.feeOutPercent = 2;                       // 2% de taxa de saque
  p.pixOut = true;                           // o interruptor do admin

  const fx = pagamentos.computeWithdrawFee(loja, 30000);
  ok(fx.fee === 600, 'a taxa de 2% sobre R$ 300 é R$ 6,00', brl(fx.fee));
  ok(pagamentos.podeSaqueAuto(loja, 30000, fx).pode === true,
     'com o Pix Out ligado, um saque COM taxa passa a poder ser automático');
  ok(pagamentos.podeSaqueAuto(loja, 30000, fx).parcial === true, 'e pelo caminho de valor exato');

  const wdP = { id: 'wdP', accountId: loja.id, amount: 30000, fee: fx.fee, net: fx.net, fromCard: 0, status: 'pending', pixKey: 'loja@ex.com' };
  const rP = await mod.pagarSaqueAuto(loja, wdP);
  ok(rP.pago === true && rP.parcial === true, 'pagou sozinho, sem esvaziar nada');
  ok(passos.length === 3, 'em três chamadas: transferir, conferir a chave, pagar', passos.map(x => x[0]).join(' → '));
  ok(passos[0][0] === 'transfer' && passos[0][1] === 30000,
     'a transferência recolhe o VALOR PEDIDO, não o saldo', brl(passos[0][1]));
  ok(passos[0][2] === 'loja@ex.com' && passos[0][3] === 'financeiro@koonfy.com',
     'da subconta do lojista para a da plataforma');
  ok(passos[2][0] === 'pixout' && passos[2][1] === fx.net,
     'e o Pix Out manda o LÍQUIDO, não o bruto', brl(passos[2][1]));
  ok(passos[0][1] - passos[2][1] === fx.fee,
     'a diferença entre o que entrou e o que saiu é exatamente a taxa', brl(passos[0][1] - passos[2][1]));
  ok(passos[2][3] === 'EMAIL', 'o tipo da chave vai no vocabulário da Woovi', passos[2][3]);

  console.log('\n=== 5d. Falha no meio: o admin sabe onde parou ===');
  // Se o Pix Out falha DEPOIS da transferência, o dinheiro está na plataforma.
  // Marcar a etapa é o que evita o admin ter de abrir a Woovi para descobrir se
  // o valor saiu — e é o que impede a tentativa seguinte de transferir de novo.
  passos.length = 0;
  drv.pixOut = async () => { throw new Error('Pix Out não habilitado'); };
  const wdF = { id: 'wdF', accountId: loja.id, amount: 30000, fee: fx.fee, net: fx.net, fromCard: 0, status: 'pending', pixKey: 'loja@ex.com' };
  const rF = await mod.pagarSaqueAuto(loja, wdF);
  ok(rF.pago === false && rF.etapa === 'pagamento', 'o pedido fica pendente, dizendo em que etapa parou', rF.etapa);
  ok(!!wdF.transferido, 'e registra que o valor JÁ saiu da subconta do lojista');

  // A segunda tentativa não pode recolher de novo: seria cobrar duas vezes.
  passos.length = 0;
  drv.pixOut = async a => { passos.push(['pixout', a.valueCents]); return { status: 'APPROVED', endToEndId: 'E2E-2' }; };
  const rF2 = await mod.pagarSaqueAuto(loja, wdF);
  ok(rF2.pago === true, 'tentar de novo conclui o saque');
  ok(!passos.some(x => x[0] === 'transfer'), 'SEM transferir outra vez — o dinheiro já estava lá');

  console.log('\n=== 5e. O que ainda barra o valor exato ===');
  drv.getSubBalance = async () => 10000;     // só R$ 100 na Woovi
  const wdG = { id: 'wdG', accountId: loja.id, amount: 30000, fee: 0, net: 30000, fromCard: 0, status: 'pending', pixKey: 'loja@ex.com' };
  const rG = await mod.pagarSaqueAuto(loja, wdG);
  ok(rG.pago === false && rG.motivo === 'saldo_gateway',
     'pedido maior do que o que está na Woovi não sai', rG.motivo);
  drv.getSubBalance = async () => 100000;

  p.splitPixKey = '';
  ok(pagamentos.podeSaqueAuto(loja, 30000, fx).motivo === 'split',
     'sem a chave da plataforma não há para onde recolher antes de mandar');
  p.splitPixKey = 'financeiro@koonfy.com';

  ok(pagamentos.podeSaqueAuto(loja, 30000, { fromCard: 1000, fee: 0 }).motivo === 'cartao',
     'dinheiro de cartão continua de fora: ele não está na subconta Pix');

  p.pixOut = false;
  ok(pagamentos.podeSaqueAuto(loja, 30000, fx).motivo === 'taxa',
     'e com o interruptor desligado tudo volta a ser como era: taxa barra o automático');

  Object.assign(drv, gw2);
  p.feeOutPercent = 0; p.splitPixKey = ''; p.feeInPercent = 5;

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
