// ============================================================================
// AFILIAÇÃO — o caminho do dinheiro, do link ao saldo
//
// Este é o sistema de que a operação mais depende comercialmente, e ele falha
// de um jeito específico: SILENCIOSAMENTE. A conta indicada nasce, aparece no
// painel, a receita entra no relatório — e só o repasse não sai. Ninguém vê um
// erro; alguém só percebe quando o afiliado reclama, semanas depois.
//
// Três defeitos assim já aconteceram, e é por isso que este arquivo existe:
//
//   · O CÓDIGO MORRIA NA PRIMEIRA TELA. A vitrine no ar não lia o `?ref=`, e
//     todo cadastro vindo de indicação nascia sem dono.
//   · A COMISSÃO DA PRIMEIRA VENDA NUNCA SAÍA. O cadastro pago desviava antes
//     do trecho que paga, e só as renovações caíam. Justo a maior, 30%.
//   · LIBERAR NÃO PAGAVA. O antiabuso retém a comissão quando indicador e
//     indicado dividem IP, CPF ou telefone. O admin liberava, a trava subia —
//     e o dinheiro que ficou parado não era pago nunca, porque o `return` já
//     tinha acontecido. Só as renovações seguintes entravam.
//
// O teste roda no MÓDULO de verdade, com um banco isolado: mexer no banco de
// desenvolvimento apagaria dado de quem está testando o produto ao lado.
// ============================================================================
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

// BANCO ISOLADO: guarda o que existe, roda em cima de um banco vazio e devolve
// o original no fim — inclusive se o teste quebrar no meio.
const ARQ = path.join(R, 'data', 'db.json');
const original = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
const devolver = () => { try { if (original) fs.writeFileSync(ARQ, original); } catch {} };
process.on('exit', devolver);
process.on('uncaughtException', e => { devolver(); console.error(e); process.exit(1); });

const db = require(path.join(R, 'src', 'db'));
const pre = require(path.join(R, 'src', 'preassinatura'));
const anti = require(path.join(R, 'src', 'antiabuso'));
const woovi = require(path.join(R, 'src', 'woovi'));

db.load();
const data = db.get();
data.accounts.length = 0;
data.revenue.length = 0;
if (data.preassinaturas) data.preassinaturas.length = 0;

const cfg = data.platform.affiliate;
let plano = data.plans.find(p => !p.archived);
if (!plano) { plano = { id: db.genId('plan'), name: 'Pro', price: 19700, periodDays: 30, archived: false, features: {} }; data.plans.push(plano); }

const conta = (nome, email, ip) => {
  const a = db.newAccount({ name: nome, email, pass: '123456' });
  a.origem = { ip, marcas: [] };
  data.accounts.push(a);
  return a;
};
// Uma venda de verdade: pré-assinatura paga, que é o caminho que a landing usa.
const vender = (aff, nome, email, ip, doc) => {
  const cid = 'nov-' + Math.random().toString(16).slice(2);
  (data.preassinaturas || (data.preassinaturas = [])).push({
    id: db.genId('pre'), token: 't', planId: plano.id, nome, email,
    telefone: '+55119' + Math.floor(10000000 + Math.random() * 89999999),
    documento: doc || '11144477735', refBy: aff ? aff.affiliate.code : '',
    ip, status: 'pending', valor: plano.price, correlationID: cid,
    accountId: '', criadoEm: Date.now(), pagoEm: 0
  });
  pre.confirmar(cid, plano.price, null);
  return data.accounts.find(a => a.email === email);
};
const reais = c => 'R$ ' + (c / 100).toFixed(2);

(async () => {
  console.log('=== 1. O código de indicação ===');
  const isa = conta('Isabela', 'isabela@teste.local', '200.1.2.3');
  ok(/^[0-9A-F]{8}$/.test(isa.affiliate.code), 'toda conta nasce com um código', isa.affiliate.code);
  ok((db.findAccountByRefCode(isa.affiliate.code) || {}).id === isa.id, 'o código encontra a conta');
  // Um link digitado à mão, ou colado de um lugar que baixou a caixa, não pode
  // perder a comissão por causa de maiúscula.
  ok((db.findAccountByRefCode(isa.affiliate.code.toLowerCase()) || {}).id === isa.id,
     'em minúsculas também — link digitado à mão não perde a venda');
  ok((db.findAccountByRefCode(' ' + isa.affiliate.code + ' ') || {}).id === isa.id, 'e com espaço em volta');

  console.log('\n=== 2. A venda limpa: cliente de outra rede ===');
  const c1 = vender(isa, 'Cliente A', 'a@teste.local', '189.9.9.9', '52998224725');
  const primeira = Math.floor(plano.price * cfg.percentFirst / 100);
  ok(c1.billing.status === 'active', 'a conta indicada nasce com a assinatura ativa');
  ok(c1.affiliate.refBy === isa.affiliate.code, 'e carimbada com quem indicou');
  ok(isa.wallet.balance === primeira, `a comissão da 1ª venda cai na hora (${cfg.percentFirst}%)`, reais(isa.wallet.balance));
  ok(isa.affiliate.earned === primeira, 'e entra no total ganho');
  ok((isa.wallet.transactions.slice(-1)[0] || {}).type === 'commission', 'com lançamento no extrato');
  ok(data.revenue.some(x => x.accountId === c1.id && x.kind === 'first'), 'e a receita entra no relatório da plataforma');
  const renov = Math.floor(plano.price * cfg.percentRenewal / 100);
  woovi.pagarComissao(c1, plano.price, 'renewal', null);
  ok(isa.wallet.balance === primeira + renov, `a renovação paga o percentual de renovação (${cfg.percentRenewal}%)`, reais(renov));

  console.log('\n=== 3. A venda suspeita: mesma rede da afiliada ===');
  // É o caso de quem testa o próprio sistema — e o caso de quem tenta se
  // indicar com outro e-mail. Os dois param aqui, de propósito.
  const antes = isa.wallet.balance;
  const c2 = vender(isa, 'Cliente B', 'b@teste.local', '200.1.2.3', '11144477735');
  ok(!!c2.affiliate.comissaoRetida, 'a comissão fica retida', (c2.affiliate.comissaoRetida || {}).motivos.join(', '));
  ok(isa.wallet.balance === antes, 'e a carteira não se mexe');
  const parado = (c2.affiliate.comissaoRetida.pendentes || []).reduce((s, x) => s + x.valor, 0);
  ok(parado === primeira, 'MAS o valor fica guardado — retenção é espera, não confisco', reais(parado));
  woovi.pagarComissao(c2, plano.price, 'renewal', null);
  ok((c2.affiliate.comissaoRetida.pendentes || []).length === 2,
     'a renovação durante a retenção também é guardada');
  const fila = anti.fila();
  ok(fila.valorRetidoTotal === primeira + renov,
     'e o admin vê QUANTO está parado, para decidir com o número na frente', reais(fila.valorRetidoTotal));

  console.log('\n=== 4. Liberar paga o que ficou parado ===');
  anti.liberar(c2.id, 'kaio');
  ok(isa.wallet.balance === antes + primeira + renov,
     'ao liberar, tudo o que estava esperando é pago', reais(isa.wallet.balance - antes));
  ok((isa.wallet.transactions.slice(-1)[0] || {}).label.includes('liberada na revisão'),
     'e o extrato diz que veio da revisão');
  const depois = isa.wallet.balance;
  anti.liberar(c2.id, 'kaio');
  ok(isa.wallet.balance === depois, 'liberar duas vezes NÃO paga duas vezes');

  console.log('\n=== 5. O que nunca pode pagar ===');
  const esp = conta('Espertinho', 'esp@teste.local', '10.0.0.1');
  esp.affiliate.refBy = esp.affiliate.code;
  ok(!woovi.pagarComissao(esp, plano.price, 'first', null).ok, 'indicar a si mesmo');
  const sem = conta('Sem indicação', 'sem@teste.local', '10.0.0.2');
  ok(!woovi.pagarComissao(sem, plano.price, 'first', null).ok, 'conta sem indicação');
  const fk = conta('Código falso', 'fk@teste.local', '10.0.0.3');
  fk.affiliate.refBy = 'NAOEXISTE';
  ok(!woovi.pagarComissao(fk, plano.price, 'first', null).ok, 'código que não existe');
  const dupAntes = isa.wallet.balance;
  const cid = (data.preassinaturas.find(p => p.email === 'a@teste.local') || {}).correlationID;
  pre.confirmar(cid, plano.price, null);
  ok(isa.wallet.balance === dupAntes, 'o mesmo pagamento confirmado duas vezes (retry do webhook)');

  console.log('\n=== 6. O que a Isabela vê no painel ===');
  const meus = data.accounts.filter(a => a.affiliate && a.affiliate.refBy === isa.affiliate.code);
  ok(meus.length === 2, 'os indicados aparecem', meus.map(a => a.name).join(', '));
  ok(isa.affiliate.earned === isa.wallet.balance, 'o total ganho bate com o saldo', reais(isa.wallet.balance));
  ok(isa.wallet.transactions.every(x => x.label && x.amount > 0), 'todo lançamento tem descrição e valor');
  ok(isa.wallet.balance >= cfg.withdraw.min, `e o saldo passa do mínimo de saque (${reais(cfg.withdraw.min)})`);

  console.log('\n=== 7. A vitrine leva o código até o checkout ===');
  const html = fs.readFileSync(path.join(R, 'public', 'nova.html'), 'utf8');
  ok(/ec_ref=' \+ encodeURIComponent\(refCode\)/.test(html), 'a landing grava o cookie ec_ref');
  ok(/REF_DIAS = 30/.test(html), 'com 30 dias: indicação raramente vira venda no mesmo dia');
  // O clique cobre o clique. Não cobre "abrir em nova aba" pelo botão direito,
  // nem "copiar endereço do link" — nenhum dos dois dispara `click`.
  ok(/function grudarNosLinks/.test(html) && /MutationObserver\(grudarNosLinks\)/.test(html),
     'e o código entra no próprio href, para sobreviver a "abrir em nova aba"');
  ok(/document\.addEventListener\('click'[\s\S]{0,400}comRef\(href\)/.test(html),
     'com o clique ainda como rede de segurança, para o que nasce depois');
  const chk = fs.readFileSync(path.join(R, 'public', 'assinar.html'), 'utf8');
  ok(/function refDeIndicacao/.test(chk), 'o checkout lê o código');
  ok(/get\('ref'\)/.test(chk) && /ec_ref=\(\[\^;\]\+\)/.test(chk), 'da URL e do cookie, nessa ordem');
  ok(/ref: refDeIndicacao\(\)/.test(chk), 'e o envia junto com a assinatura');

  // DEVOLVER O BANCO, e não só o arquivo. `db.save()` é adiado em 250ms: um
  // save agendado durante o teste escreve DEPOIS de o arquivo ter sido
  // restaurado, e desfaz a restauração. Devolvendo também o banco EM MEMÓRIA,
  // qualquer gravação atrasada grava o conteúdo original.
  const antesDoTeste = JSON.parse(original || '{}');
  for (const k of ['accounts', 'revenue', 'plans', 'preassinaturas']) {
    if (Array.isArray(data[k])) data[k].length = 0;
    if (Array.isArray(antesDoTeste[k])) data[k].push(...antesDoTeste[k]);
  }
  db.save();
  devolver();

  await encerrar(null, falhas);
})();
