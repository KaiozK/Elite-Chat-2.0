// ============================================================================
// A COMISSÃO DA PRIMEIRA VENDA — o caminho que a landing usa
//
// O afiliado manda o link, o convidado paga, e a comissão tem de cair. Era isso
// que não acontecia: nada de saldo, nada no painel, nenhum aviso.
//
// ONDE O DINHEIRO SE PERDIA. O pagamento de um cadastro novo chega com
// correlationID `nov-`, e `woovi.applyPayment` desvia esse prefixo para
// `preassinatura.confirmar` na PRIMEIRA linha — retornando ali mesmo. Só que o
// bloco que paga a comissão mora lá embaixo, no fim de `applyPayment`, no ramo
// que ativa a assinatura. O caminho `nov-` nunca chegava nele.
//
// O efeito é cruel porque é PARCIAL: a conta nasce certa, o `refBy` é gravado,
// a receita entra no relatório — tudo parece funcionar. Só a comissão da
// PRIMEIRA venda (a maior, 30%) some. As renovações seguintes pagam normal,
// porque elas passam por `applyPayment` inteiro.
//
// Este arquivo cobre o percurso de ponta a ponta: link → cadastro → pagamento →
// saldo, aviso e extrato do afiliado.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const Module = require('module');
const tabela = new Map();
function executar(sql, params) {
  if (/^CREATE TABLE/i.test(sql)) return [[], []];
  if (/^SELECT chunk, data/i.test(sql)) return [[...tabela].map(([chunk, v]) => ({ chunk, data: v })), []];
  if (/^SELECT chunk, LENGTH/i.test(sql)) return [[...tabela].map(([chunk, v]) => ({ chunk, bytes: v.length })), []];
  if (/^INSERT INTO/i.test(sql)) { for (const [c, d] of params[0]) tabela.set(c, d); return [{}, []]; }
  if (/WHERE chunk IN/i.test(sql)) { for (const c of params[0]) tabela.delete(c); return [{}, []]; }
  if (/^DELETE FROM/i.test(sql)) { tabela.clear(); return [{}, []]; }
  return [[], []];
}
const cx = { query: async (a, b) => executar(a, b), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { query: async (a, b) => executar(a, b), getConnection: async () => cx, end: async () => {} };
const origLoad = Module._load;
Module._load = function (m) { if (m === 'mysql2/promise') return { createPool: () => pool }; return origLoad.apply(this, arguments); };
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

// Woovi de mentira: gera o Pix sem rede.  é o que a consulta da
// cobrança devolve — é como o teste simula "ainda não caiu" e "caiu".
const fetchReal = global.fetch;
let wooviStatus = 'ACTIVE';
global.fetch = async (u, o = {}) => {
  if (!/woovi/.test(String(u))) return fetchReal(u, o);
  return { ok: true, status: 200, text: async () => JSON.stringify({
    charge: { brCode: '00020126BR...', qrCodeImage: '', identifier: 'x',
              status: wooviStatus, value: 19700 }
  }) };
};

const fs = require('fs');
const db = require(R + 'src/db');
const preassinatura = require(R + 'src/preassinatura');
const woovi = require(R + 'src/woovi');

// Os avisos que sairiam para o celular do afiliado.
const avisos = [];
const avisosMod = require(R + 'src/avisos');
avisosMod.avisarComissao = (aff, dados) => { avisos.push({ accId: aff.id, ...dados }); };

// E os eventos que a tela recebe ao vivo.
const eventos = [];
const broadcast = (tipo, dados) => eventos.push({ tipo, ...dados });

const BASE = 'http://127.0.0.1:3987';

(async () => {
  await db.loadAsync();

  const express = require('express');
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(broadcast, new Set()));
  const srv = app.listen(3987);
  await new Promise(r => setTimeout(r, 150));

  const P = db.get().platform;
  P.woovi.appId = 'APPID';
  P.baseUrl = 'https://koonfy.test';
  P.affiliate = { percentFirst: 30, percentRenewal: 15, withdraw: { min: 2000, max: 0 } };
  db.get().plans.push({
    id: 'pro', name: 'Profissional', price: 19700, periodDays: 30, limits: {}, modules: {}
  });
  db.save();

  // ---- O AFILIADO ----
  await fetch(BASE + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.7' },
    body: JSON.stringify({
      name: 'Quem Indica', email: 'afiliado@ex.com', pass: 'segredo123',
      profile: { phone: '11988887777', country: 'BR' },
      recebimento: { document: '39053344705' }
    })
  });
  const aff = db.findAccountByEmail('afiliado@ex.com');
  const codigo = aff.affiliate.code;
  ok(!!codigo, 'o afiliado tem código: ' + codigo);

  console.log('=== 1. O convidado se cadastra pelo link e paga ===');
  const criada = await (await fetch(BASE + '/api/public/assinatura', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.90' },
    body: JSON.stringify({
      planId: 'pro', nome: 'Convidado Novo', email: 'convidado@ex.com',
      telefone: '(21) 99999-8888', documento: '11144477735', pais: 'BR',
      ref: codigo
    })
  })).json();
  ok(!!criada.token, 'a pré-assinatura nasceu');

  const pre = db.get().preassinaturas.find(p => p.token === criada.token);
  ok(pre.refBy === codigo, `com quem indicou registrado: ${pre.refBy}`);

  const saldoAntes = aff.wallet.balance;
  const ganhoAntes = aff.affiliate.earned;
  avisos.length = 0;
  eventos.length = 0;

  // O Pix confirma. É o momento exato em que a comissão deveria cair.
  woovi.applyPayment({ correlationID: pre.correlationID, value: 19700 }, broadcast);

  console.log('\n=== 2. A conta do convidado nasce ligada ao afiliado ===');
  const conv = db.findAccountByEmail('convidado@ex.com');
  ok(!!conv, 'a conta do convidado existe');
  ok(conv.affiliate.refBy === codigo, `com o refBy gravado: ${conv.affiliate.refBy}`);
  ok(conv.billing.status === 'active', 'e o plano ativo — o dinheiro entrou');

  console.log('\n=== 3. E A COMISSÃO CAI — era isto que não acontecia ===');
  const esperado = Math.floor(19700 * 30 / 100);
  ok(aff.wallet.balance === saldoAntes + esperado,
     `saldo do afiliado: ${saldoAntes} → ${aff.wallet.balance} (esperado +${esperado})`);
  ok(aff.affiliate.earned === ganhoAntes + esperado,
     `total ganho: ${aff.affiliate.earned}`);

  const tx = aff.wallet.transactions.slice(-1)[0];
  ok(tx && tx.type === 'commission', 'com lançamento no extrato');
  ok(tx && /nova assinatura/.test(tx.label), 'marcado como primeira assinatura: ' + (tx && tx.label));
  ok(tx && tx.amount === esperado, 'pelo valor certo');

  console.log('\n=== 4. E o afiliado FICA SABENDO ===');
  // Sem isto a comissão cai em silêncio, e quem indicou só descobre se abrir a
  // carteira por acaso.
  ok(avisos.length === 1, `sai o aviso para o celular: ${avisos.length}`);
  ok(avisos[0] && avisos[0].accId === aff.id, 'para o afiliado certo');
  ok(avisos[0] && avisos[0].amount === esperado, `com o valor: ${avisos[0] && avisos[0].amount}`);
  ok(avisos[0] && avisos[0].kind === 'first', 'e marcado como primeira venda');
  ok(avisos[0] && avisos[0].indicado === 'Convidado Novo', 'dizendo quem foi: ' + (avisos[0] || {}).indicado);

  const evCom = eventos.find(e => e.tipo === 'commission');
  ok(!!evCom, 'e o evento ao vivo, para quem está com o painel aberto');
  ok(evCom && evCom.accountId === aff.id, 'no canal do afiliado');
  const evWallet = eventos.find(e => e.tipo === 'wallet' && e.accountId === aff.id);
  ok(!!evWallet, 'com a carteira mandada atualizar junto');

  console.log('\n=== 5. E aparece no painel de Afiliação ===');
  const l = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'afiliado@ex.com', pass: 'segredo123' })
  })).json();
  // A tela de Afiliação lê de /billing — é de lá que saem o código, o ganho e
  // a lista de indicados.
  const painel = await (await fetch(BASE + '/api/billing', {
    headers: { Authorization: 'Bearer ' + l.token }
  })).json();
  ok(painel.affiliate.earned === esperado, `o painel mostra o ganho: ${painel.affiliate.earned}`);
  ok((painel.affiliate.referrals || []).some(r => r.name === 'Convidado Novo'),
     'e o indicado na lista');
  ok(painel.wallet.balance === esperado, `com o saldo na carteira: ${painel.wallet.balance}`);
  ok((painel.wallet.transactions || []).some(t => t.type === 'commission'),
     'e a comissão no extrato que a tela mostra');

  console.log('\n=== 6. Pagar duas vezes não paga duas comissões ===');
  // O webhook repete quando não recebe 200 a tempo. Sem a trava, um reenvio
  // pagaria a comissão de novo — e a segunda ninguém estorna.
  const saldoDepois = aff.wallet.balance;
  woovi.applyPayment({ correlationID: pre.correlationID, value: 19700 }, broadcast);
  ok(aff.wallet.balance === saldoDepois,
     `o reenvio não paga de novo: ${aff.wallet.balance}`);

  console.log('\n=== 7. A renovação paga o percentual DELA ===');
  // Este caminho já funcionava; entra aqui para a correção não quebrá-lo.
  avisos.length = 0;
  woovi.applyPayment({ correlationID: `wallet-ren-${conv.id}-pro-m2`, value: 19700 }, broadcast);
  const esperadoRen = Math.floor(19700 * 15 / 100);
  ok(aff.wallet.balance === saldoDepois + esperadoRen,
     `renovação paga 15%: +${aff.wallet.balance - saldoDepois}`);
  ok(avisos.length === 1 && avisos[0].kind === 'renewal', 'com o aviso marcado como renovação');

  console.log('\n=== 8. Sem indicação, ninguém recebe nada ===');
  const semRef = await (await fetch(BASE + '/api/public/assinatura', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.91' },
    body: JSON.stringify({
      planId: 'pro', nome: 'Sozinho', email: 'sozinho@ex.com',
      telefone: '(31) 98888-7777', documento: '52998224725', pais: 'BR'
    })
  })).json();
  const preS = db.get().preassinaturas.find(p => p.token === semRef.token);
  const saldoAntesS = aff.wallet.balance;
  avisos.length = 0;
  woovi.applyPayment({ correlationID: preS.correlationID, value: 19700 }, broadcast);
  ok(aff.wallet.balance === saldoAntesS, 'o saldo do afiliado não se mexe');
  ok(avisos.length === 0, 'e nenhum aviso sai');

  console.log('\n=== 9. A regra da comissão mora num lugar só ===');
  // A causa do defeito foi ter a regra escrita DENTRO de um dos caminhos. Com
  // ela numa função própria, o próximo caminho de pagamento que aparecer
  // chama a mesma coisa em vez de esquecer de copiar.
  const src = fs.readFileSync(R + 'src/woovi.js', 'utf8');
  ok(/function pagarComissao/.test(src), 'existe uma função de comissão');
  const pre_src = fs.readFileSync(R + 'src/preassinatura.js', 'utf8');
  ok(/pagarComissao/.test(pre_src), 'e o caminho da pré-assinatura a chama');
  ok((src.match(/aff\.wallet\.balance \+= cut/g) || []).length === 1,
     'com um único lugar creditando o afiliado — não duas cópias para divergir');

  console.log('\n=== 10. "Já fiz o pagamento" pergunta à WOOVI, não a nós mesmos ===');
  // A consulta automática da tela lê só o que já está gravado aqui: quem vira
  // a chave é o webhook. Um botão que refizesse essa mesma consulta seria
  // placebo — e placebo em tela de pagamento gasta confiança.
  //
  // O caso que justifica o botão não é lentidão, é PAREDE: se o webhook não
  // chegar (URL mal configurada, instabilidade), a pessoa pagou e fica presa
  // naquela tela para sempre. Aqui o webhook NUNCA é chamado de propósito.
  const nova = await (await fetch(BASE + '/api/public/assinatura', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.99' },
    body: JSON.stringify({
      planId: 'pro', nome: 'Pagou e Esperou', email: 'esperou@ex.com',
      telefone: '(41) 98888-1111', documento: '15350946056', pais: 'BR', ref: codigo
    })
  })).json();
  const preN = db.get().preassinaturas.find(p => p.token === nova.token);

  // A Woovi ainda não recebeu: a resposta é honesta e a conta não nasce.
  wooviStatus = 'ACTIVE';
  const r1 = await (await fetch(BASE + '/api/public/assinatura/' + nova.token + '/reconsultar',
    { method: 'POST' })).json();
  ok(r1.pago === false, 'sem pagamento, responde que não caiu');
  ok(!db.findAccountByEmail('esperou@ex.com'), 'e nenhuma conta é criada');

  // O FREIO: a rota é pública e cada chamada vai à API da Woovi. Uma aba
  // esquecida em laço, ou alguém batendo de propósito, viraria conta de API —
  // e a Woovi recusando por excesso derrubaria o caminho de todo mundo.
  const r2 = await (await fetch(BASE + '/api/public/assinatura/' + nova.token + '/reconsultar',
    { method: 'POST' })).json();
  ok(r2.aguarde === true, 'a segunda chamada seguida é freada, não repassada à Woovi');

  // Agora o Pix caiu na Woovi — e o webhook continua sem chegar.
  wooviStatus = 'COMPLETED';
  preN.ultimaConsulta = 0;   // passa o freio, como passaria com o tempo
  db.save();
  const saldoAntesJ = aff.wallet.balance;
  const r3 = await (await fetch(BASE + '/api/public/assinatura/' + nova.token + '/reconsultar',
    { method: 'POST' })).json();
  ok(r3.pago === true, 'com o Pix pago na Woovi, a rota resolve sem o webhook');

  const contaN = db.findAccountByEmail('esperou@ex.com');
  ok(!!contaN, 'a conta nasce por este caminho também');
  ok(contaN.billing.status === 'active', 'com o plano ativo');

  // E PASSA PELO MESMO CAMINHO do webhook: a comissão sai igual. Um atalho
  // aqui significaria duas versões da coisa mais delicada do produto.
  ok(aff.wallet.balance === saldoAntesJ + Math.floor(19700 * 30 / 100),
     `a comissão do afiliado cai igual: +${aff.wallet.balance - saldoAntesJ}`);

  // Perguntar de novo depois de resolvido não gasta chamada nem repete nada.
  const r4 = await (await fetch(BASE + '/api/public/assinatura/' + nova.token + '/reconsultar',
    { method: 'POST' })).json();
  ok(r4.pago === true, 'já resolvido responde direto');
  ok(aff.wallet.balance === saldoAntesJ + Math.floor(19700 * 30 / 100),
     'e não paga a comissão de novo');

  console.log('\n=== 11. O botão está na tela, e é secundário ===');
  const tela = fs.readFileSync(R + 'public/assinar.html', 'utf8');
  ok(/id="btn-japaguei"/.test(tela), 'o botão existe');
  ok(tela.indexOf('id="btn-japaguei"') > tela.indexOf('id="btn-copiar"'),
     'abaixo do Copiar código Pix');
  ok(/class="btn-secundario" id="btn-japaguei"/.test(tela),
     'com peso visual menor — o caminho normal é a tela avançar sozinha, e um botão');
  ok(/reconsultar/.test(tela), 'e chama a rota que pergunta à Woovi');
  ok(!/btn-japaguei[\s\S]{0,400}\/api\/public\/assinatura\/' \+ token'/.test(tela),
     'não a consulta local, que seria placebo');

  srv.close();
  global.fetch = fetchReal;
  await encerrar(srv, falhas);
})();
