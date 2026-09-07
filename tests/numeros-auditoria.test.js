// ============================================================================
// NÚMEROS VIRTUAIS — auditoria do dinheiro e do acesso
//
// Aqui trafegam duas coisas caras: o SALDO DA CARTEIRA (cada aluguel e cada
// renovação são debitados dela) e os CÓDIGOS DE VERIFICAÇÃO que chegam por SMS
// no número alugado. O segundo é o mais sensível do produto inteiro: um código
// de verificação é credencial — quem lê entra no lugar de alguém.
//
// DOIS FUROS REAIS, encontrados nesta auditoria:
//
//   · AS ROTAS NÃO TINHAM PERMISSÃO NENHUMA além de estar logado. Um atendente
//     comum comprava número gastando a carteira do dono, cancelava número em
//     uso e lia os códigos recebidos. Medido: `GET /numeros` devolvia 200 para
//     ele, e a compra chegava até a chamada ao provedor.
//   · O REEMBOLSO DO PROVEDOR NÃO CHEGAVA AO CLIENTE. A Integra X devolve o
//     valor quando o número não recebeu nenhum código — e devolvia para a
//     plataforma. Quem pagou foi o cliente, do saldo dele, e não via nada de
//     volta: alugava, cancelava sem ter usado, e o dinheiro sumia no meio.
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
const numeros = require(path.join(R, 'src', 'numeros'));
const numaluguel = require(path.join(R, 'src', 'numaluguel'));

db.load();
const data = db.get();
data.accounts.length = 0;

const nc = numeros.cfg();
nc.enabled = true; nc.token = 'TESTE'; nc.base = 'https://api.exemplo';
data.platform.numeros = Object.assign({}, data.platform.numeros, { precoCents: 2500, cicloDias: 30 });

function conta(nome, email, saldo) {
  const a = db.newAccount({ name: nome, email, pass: '123456' });
  a.wallet.balance = saldo;
  data.accounts.push(a);
  return a;
}

// O provedor, de mentira. `respostas` diz o que cada rota devolve.
let respostas = {};
global.fetch = async (url) => {
  const u = String(url);
  const achou = Object.keys(respostas).find(k => u.includes(k));
  const corpo = achou ? respostas[achou] : {};
  return { ok: true, status: 200, text: async () => JSON.stringify(corpo), json: async () => corpo };
};

(async () => {
  console.log('=== 1. A compra debita a carteira do cliente ===');
  const dono = conta('Dono', 'dono@teste.local', 10000);
  respostas = { '/buy': { rental_id: 'r1', number: '5511999990001', expires_at: null, price_brl: 15 } };
  const al = await numaluguel.comprar(dono, { ddd: '11' }, null);
  ok(dono.wallet.balance === 7500, 'o saldo cai pelo preço da plataforma', 'R$ ' + (dono.wallet.balance / 100).toFixed(2));
  ok(al.precoCents === 2500, 'e o preço fica CONGELADO no aluguel', al.precoCents);
  // Se o admin subir a tabela amanhã, quem já alugou não é cobrado a mais.
  data.platform.numeros.precoCents = 9900;
  ok(numaluguel.achar(dono, al.id).precoCents === 2500,
     'mesmo depois de o admin subir o preço', numaluguel.achar(dono, al.id).precoCents);
  data.platform.numeros.precoCents = 2500;

  console.log('\n=== 2. Sem saldo, não compra — e não chama o provedor ===');
  const pobre = conta('Sem saldo', 'pobre@teste.local', 100);
  let chamou = false;
  const fetchAnterior = global.fetch;
  global.fetch = async (...a) => { chamou = true; return fetchAnterior(...a); };
  let erroSaldo = '';
  try { await numaluguel.comprar(pobre, { ddd: '11' }, null); } catch (e) { erroSaldo = e.message; }
  ok(/[Ss]aldo insuficiente/.test(erroSaldo), 'o erro diz que falta saldo', erroSaldo.slice(0, 60));
  ok(!chamou, 'e o provedor não é chamado à toa');
  ok(pobre.wallet.balance === 100, 'o saldo não é tocado');
  global.fetch = fetchAnterior;

  console.log('\n=== 3. Compra que falha no provedor devolve o dinheiro ===');
  // Debitar antes é de propósito (ver decisão 2 no módulo): devolver saldo para
  // a nossa carteira sempre funciona; cancelar na Integra X pode não reembolsar.
  const antes = dono.wallet.balance;
  const fetchOk = global.fetch;
  global.fetch = async () => { throw new Error('rede caiu'); };
  try { await numaluguel.comprar(dono, { ddd: '11' }, null); } catch {}
  ok(dono.wallet.balance === antes, 'o saldo volta ao que era', 'R$ ' + (dono.wallet.balance / 100).toFixed(2));
  const est = dono.wallet.transactions.slice(-1)[0];
  ok(est && /Estorno/.test(est.label), 'com o estorno no extrato', est && est.label);
  global.fetch = fetchOk;

  console.log('\n=== 4. Uma conta NÃO lê os SMS de outra ===');
  // `rentalId` é o id na Integra X: sem conferir o dono, bastaria passar o id
  // na mão para ler o código de verificação de qualquer cliente.
  const outra = conta('Outra empresa', 'outra@teste.local', 10000);
  let erroDono = '';
  try { await numaluguel.mensagens(outra, al.id); } catch (e) { erroDono = e.message; }
  ok(/não encontrado/i.test(erroDono), 'a leitura por id de outra conta é recusada', erroDono);
  let erroCancel = '';
  try { await numaluguel.cancelar(outra, al.id, 'tentativa', null); } catch (e) { erroCancel = e.message; }
  ok(/não encontrado/i.test(erroCancel), 'e o cancelamento também');

  console.log('\n=== 5. Cancelou sem ter usado: o dinheiro VOLTA ===');
  const saldoAntes = dono.wallet.balance;
  respostas = { '/cancel': { refunded: true, refunded_brl: 15, otp_sms_count: 0 } };
  const canc = await numaluguel.cancelar(dono, al.id, 'Cancelado pelo cliente', null);
  ok(canc.estornado === 2500, 'o estorno é o que o CLIENTE pagou, não o custo do provedor',
     'R$ ' + (canc.estornado / 100).toFixed(2));
  ok(dono.wallet.balance === saldoAntes + 2500, 'e cai na carteira dele',
     'R$ ' + (dono.wallet.balance / 100).toFixed(2));
  ok(canc.status === 'cancelado', 'o número fica cancelado');

  console.log('\n=== 6. Já recebeu código: cancela, mas NÃO estorna ===');
  // O serviço foi prestado. Estornar aqui seria dar o produto de graça.
  respostas = { '/buy': { rental_id: 'r2', number: '5511999990002', price_brl: 15 } };
  const al2 = await numaluguel.comprar(dono, { ddd: '11' }, null);
  const saldo2 = dono.wallet.balance;
  respostas = { '/cancel': { refunded: false, refunded_brl: 0, otp_sms_count: 3 } };
  const canc2 = await numaluguel.cancelar(dono, al2.id, 'Cancelado pelo cliente', null);
  ok(canc2.estornado === 0, 'nada é estornado');
  ok(dono.wallet.balance === saldo2, 'o saldo não muda', 'R$ ' + (dono.wallet.balance / 100).toFixed(2));

  console.log('\n=== 7. As rotas são do TITULAR, não do atendente ===');
  // Um código de verificação é credencial, não dado de atendimento.
  const api = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
  for (const rota of ["router.get('/numeros', auth, ownerOnly",
                      "router.get('/numeros/disponiveis', auth, ownerOnly",
                      "router.post('/numeros/comprar', auth, ownerOnly",
                      "router.get('/numeros/:id/sms', auth, ownerOnly",
                      "router.post('/numeros/:id/cancelar', auth, ownerOnly",
                      "router.put('/numeros/:id/renovacao', auth, ownerOnly"]) {
    ok(api.includes(rota), rota.replace("router.", '').replace(", auth, ownerOnly", '') + ' exige ser o titular');
  }
  const front = fs.readFileSync(path.join(R, 'public', 'app', 'app.js'), 'utf8');
  ok(/ownerOnly = new Set\(\['billing', 'numeros'\]\)/.test(front),
     'e o menu esconde a tela do atendente, em vez de deixá-lo bater na porta');

  console.log('\n=== 8. A varredura diária existe e está ligada ===');
  // É a única coisa entre um cliente sem saldo e a plataforma pagando a conta
  // dele para sempre na Integra X.
  const srv = fs.readFileSync(path.join(R, 'server.js'), 'utf8');
  ok(/require\('\.\/src\/numaluguel'\)\.startJob\(broadcast\)/.test(srv),
     'o servidor liga a varredura na partida');
  const nal = fs.readFileSync(path.join(R, 'src', 'numaluguel.js'), 'utf8');
  ok(/setInterval\(tick, DIA\)/.test(nal), 'e ela roda todo dia');
  ok(/acc\.wallet\.balance >= a\.precoCents/.test(nal),
     'a renovação só cobra quem tem saldo');
  ok(/encerrarPorSaldo/.test(nal),
     'e quem não tem é encerrado nos dois lados, para a plataforma parar de pagar');

  const antesT = JSON.parse(original || '{}');
  for (const k of ['accounts', 'revenue', 'plans']) {
    if (Array.isArray(data[k])) data[k].length = 0;
    if (Array.isArray(antesT[k])) data[k].push(...antesT[k]);
  }
  db.save();
  devolver();
  await encerrar(null, falhas);
})();
