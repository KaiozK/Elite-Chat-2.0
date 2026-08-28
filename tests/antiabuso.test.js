// ============================================================================
// ANTIABUSO — o segundo teste grátis e a comissão para si mesmo
//
// São as duas coisas que o produto dá de graça, e por isso as duas que alguém
// tenta pegar duas vezes: cadastrar de novo com outro e-mail para ganhar outro
// período grátis, e se indicar com o próprio link para receber comissão por
// ter trazido a si mesmo.
//
// O QUE ESTE TESTE PROTEGE, e a ordem importa:
//
// 1. NÃO BLOQUEAR QUEM É LEGÍTIMO. É a metade que se esquece. Recusar um
//    cadastro de verdade custa um cliente inteiro para economizar sete dias de
//    teste — um preço péssimo. Metade das asserções aqui existe para garantir
//    que o inocente PASSA.
//
// 2. O TRIAL SÓ SAI UMA VEZ POR PESSOA, e "pessoa" é CPF/CNPJ ou WhatsApp.
//    Nunca IP sozinho: escritório, coworking e operadora de celular põem muita
//    gente legítima atrás do mesmo endereço, e negar por IP é negar ao colega
//    de mesa de quem já é cliente.
//
// 3. A COMISSÃO SUSPEITA É RETIDA, não negada. Reter e conferir custa uma
//    espera; pagar e descobrir depois custa pedir dinheiro de volta, que quase
//    nunca volta. E aqui o IP CONTA sozinho, porque o custo do engano é o
//    contrário: segurar um pagamento não tira nada de ninguém.
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
const cx = { query: async (s, p) => executar(s, p), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { query: async (s, p) => executar(s, p), getConnection: async () => cx, end: async () => {} };
const origLoad = Module._load;
Module._load = function (p) { if (p === 'mysql2/promise') return { createPool: () => pool }; return origLoad.apply(this, arguments); };
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

const fs = require('fs');
const db = require(R + 'src/db');
const anti = require(R + 'src/antiabuso');
const BASE = 'http://127.0.0.1:3984';

(async () => {
  await db.loadAsync();

  const express = require('express');
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3984);
  await new Promise(r => setTimeout(r, 150));

  db.get().platform.billing.trialDays = 7;
  db.save();

  // Cadastrar dizendo de qual IP se vem — é o que `trust proxy` lê.
  const cadastrar = (dados, ip) => fetch(BASE + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || '203.0.113.10' },
    body: JSON.stringify(dados)
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const diasDeTrial = acc => Math.round((acc.billing.periodEnd - Date.now()) / 86400000);

  console.log('=== 1. O primeiro cadastro passa inteiro ===');
  const um = await cadastrar({
    name: 'Loja Um', email: 'um@ex.com', pass: 'segredo123',
    profile: { phone: '11988887777', country: 'BR' },
    recebimento: { document: '39053344705' }
  }, '198.51.100.1');
  ok(um.status === 200, `cadastro criado: ${um.status}`);
  const accUm = db.findAccountByEmail('um@ex.com');
  ok(diasDeTrial(accUm) === 7, `com os 7 dias de teste: ${diasDeTrial(accUm)}`);
  ok(!accUm.origem.marcas.length, 'e sem marca nenhuma');
  ok(accUm.origem.ip === '198.51.100.1', `o IP fica guardado para as comparações: ${accUm.origem.ip}`);

  console.log('\n=== 2. Outro e-mail, MESMO CPF: entra, mas sem teste de novo ===');
  // É o caso central. E-mail é grátis e infinito; CPF não.
  const dois = await cadastrar({
    name: 'Loja Dois', email: 'dois@ex.com', pass: 'segredo123',
    profile: { phone: '11955554444', country: 'BR' },
    recebimento: { document: '39053344705' }
  }, '198.51.100.99');
  ok(dois.status === 200, 'A CONTA NASCE — não bloqueamos cadastro');
  const accDois = db.findAccountByEmail('dois@ex.com');
  ok(diasDeTrial(accDois) === 0, `mas sem o segundo teste grátis: ${diasDeTrial(accDois)} dia(s)`);
  ok(accDois.origem.trialNegado === true, 'e isso fica registrado');
  ok(accDois.origem.marcas.some(m => m.chave === 'documento'),
     'com o motivo: ' + (accDois.origem.marcas[0] || {}).texto);
  ok(accDois.origem.marcas[0].contas.includes(accUm.id), 'apontando qual conta é a parente');

  console.log('\n=== 3. Mesmo WhatsApp: idem ===');
  const tres = await cadastrar({
    name: 'Loja Tres', email: 'tres@ex.com', pass: 'segredo123',
    profile: { phone: '11988887777', country: 'BR' }   // o telefone da Loja Um
  }, '198.51.100.50');
  ok(tres.status === 200, 'entra');
  const accTres = db.findAccountByEmail('tres@ex.com');
  ok(diasDeTrial(accTres) === 0, 'sem teste grátis');
  ok(accTres.origem.marcas.some(m => m.chave === 'telefone'), 'pelo WhatsApp repetido');

  console.log('\n=== 4. O COLEGA DE ESCRITÓRIO não pode ser punido ===');
  // A metade que se esquece. Mesmo IP, pessoa diferente: documento diferente,
  // telefone diferente. Este cadastro é legítimo e precisa sair inteiro.
  const colega = await cadastrar({
    name: 'Colega', email: 'colega@ex.com', pass: 'segredo123',
    profile: { phone: '11911112222', country: 'BR' },
    recebimento: { document: '11144477735' }
  }, '198.51.100.1');   // o MESMO IP da Loja Um
  ok(colega.status === 200, 'entra');
  const accColega = db.findAccountByEmail('colega@ex.com');
  ok(diasDeTrial(accColega) === 7,
     `E GANHA OS 7 DIAS: ${diasDeTrial(accColega)} — IP sozinho não nega teste a ninguém`);
  ok(!accColega.origem.trialNegado, 'sem marca de trial negado');

  console.log('\n=== 5. IP só fala quando há MUITA gente atrás dele ===');
  // Duas contas no mesmo IP é o sócio, o marido, a mesa ao lado. A partir da
  // terceira vale um olhar — e ainda assim é só um aviso, não uma punição.
  ok(anti.CONTAS_POR_IP === 3, `o limite é ${anti.CONTAS_POR_IP} contas por IP`);
  const terceiro = await cadastrar({
    name: 'Terceiro', email: 'ter@ex.com', pass: 'segredo123',
    profile: { phone: '11933332222', country: 'BR' },
    recebimento: { document: '52998224725' }
  }, '198.51.100.1');
  ok(terceiro.status === 200, 'entra');
  const accTer = db.findAccountByEmail('ter@ex.com');
  ok(accTer.origem.marcas.some(m => m.chave === 'ip'),
     'a terceira conta no mesmo IP vira sinal para o admin');
  ok(diasDeTrial(accTer) === 7,
     `mas o teste grátis SAI do mesmo jeito: ${diasDeTrial(accTer)} dias — IP não decide isso`);

  console.log('\n=== 6. Autoindicação: a comissão fica RETIDA ===');
  // Aqui o IP conta sozinho, e a razão é o custo do engano ao contrário:
  // segurar um pagamento para conferir não tira nada de ninguém; pagar e
  // descobrir depois é pedir dinheiro de volta.
  const codigo = accUm.affiliate.code;
  const indicado = await cadastrar({
    name: 'Eu Mesmo', email: 'eu@ex.com', pass: 'segredo123',
    profile: { phone: '11977776666', country: 'BR' },
    recebimento: { document: '87748248800' },
    refCode: codigo
  }, '198.51.100.1');   // o mesmo IP de quem indicou
  ok(indicado.status === 200, 'a conta indicada nasce');
  const accEu = db.findAccountByEmail('eu@ex.com');
  ok(accEu.affiliate.refBy === codigo, 'com a indicação registrada');
  ok(!!accEu.affiliate.comissaoRetida, 'e a comissão RETIDA');
  ok(/mesmo IP do afiliado/.test((accEu.affiliate.comissaoRetida.motivos || []).join(', ')),
     'pelo IP compartilhado: ' + accEu.affiliate.comissaoRetida.motivos.join(', '));
  ok(anti.comissaoLiberada(accEu) === false, 'e o pagamento não sai enquanto isso');

  console.log('\n=== 7. Indicação HONESTA paga normalmente ===');
  // A outra metade. Se toda indicação virasse suspeita, o programa de afiliados
  // morria — ninguém indica sabendo que a comissão fica presa.
  const honesta = await cadastrar({
    name: 'Amigo de Verdade', email: 'amigo@ex.com', pass: 'segredo123',
    profile: { phone: '21999998888', country: 'BR' },
    recebimento: { document: '15350946056' },
    refCode: codigo
  }, '203.0.113.77');   // outro IP, outro documento, outro telefone
  ok(honesta.status === 200, 'entra');
  const accAmigo = db.findAccountByEmail('amigo@ex.com');
  ok(accAmigo.affiliate.refBy === codigo, 'com a indicação registrada');
  ok(!accAmigo.affiliate.comissaoRetida, 'e SEM retenção nenhuma');
  ok(anti.comissaoLiberada(accAmigo) === true, 'a comissão dela pode ser paga');
  ok(Math.round((accAmigo.billing.periodEnd - Date.now()) / 86400000) === 7,
     'e ela ganha o teste grátis, como qualquer cliente novo');

  console.log('\n=== 8. A comissão retida NÃO entra na carteira do afiliado ===');
  const saldoAntes = accUm.wallet.balance;
  const ganhoAntes = accUm.affiliate.earned;
  const plano = { id: 'plano_x', name: 'Pro', price: 10000, periodDays: 30 };
  db.get().plans.push(plano);
  db.get().platform.affiliate = { percentFirst: 30, percentRenewal: 10 };
  db.save();

  // A conta suspeita assina. O dinheiro do afiliado não pode se mexer.
  require(R + 'src/woovi').applyPayment(
    { correlationID: `sub-${accEu.id}-${plano.id}-x`, value: 10000 }, null);
  ok(accUm.wallet.balance === saldoAntes,
     `a carteira do afiliado não mexeu: ${accUm.wallet.balance}`);
  ok(accUm.affiliate.earned === ganhoAntes, 'nem o total ganho');
  ok(accEu.billing.status === 'active', 'e a assinatura do indicado foi ativada normalmente');

  // A honesta assina, e aí sim a comissão cai.
  require(R + 'src/woovi').applyPayment(
    { correlationID: `sub-${accAmigo.id}-${plano.id}-y`, value: 10000 }, null);
  ok(accUm.wallet.balance === saldoAntes + 3000,
     `a indicação honesta paga os 30%: ${accUm.wallet.balance - saldoAntes}`);

  console.log('\n=== 9. Liberar é ato de gente, e fica registrado ===');
  const admLogin = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const admAut = { Authorization: 'Bearer ' + admLogin.token, 'Content-Type': 'application/json' };

  const filaAdm = await (await fetch(BASE + '/api/adm/antiabuso', { headers: admAut })).json();
  ok(filaAdm.total >= 3, `o admin vê as contas marcadas: ${filaAdm.total}`);
  ok(filaAdm.comissoesRetidas >= 1, `com as comissões retidas: ${filaAdm.comissoesRetidas}`);
  ok(filaAdm.trialsNegados >= 2, `e os trials negados: ${filaAdm.trialsNegados}`);
  ok(filaAdm.contas[0].risco >= filaAdm.contas[filaAdm.contas.length - 1].risco,
     'ordenadas pelo risco, para o pior aparecer primeiro');
  const linha = filaAdm.contas.find(c => c.accountId === accEu.id);
  ok(linha && linha.motivosComissao.length >= 1, 'com o motivo da retenção por extenso');

  await fetch(BASE + '/api/adm/antiabuso/' + accEu.id + '/liberar', { method: 'POST', headers: admAut, body: '{}' });
  ok(anti.comissaoLiberada(accEu) === true, 'liberada, a comissão volta a poder ser paga');
  ok(!!accEu.origem.revisadoPor, 'e fica registrado quem liberou: ' + accEu.origem.revisadoPor);

  console.log('\n=== 10. Um cliente não mexe nisso ===');
  const l = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'amigo@ex.com', pass: 'segredo123' })
  })).json();
  const cliAut = { Authorization: 'Bearer ' + l.token, 'Content-Type': 'application/json' };
  const espiar = await fetch(BASE + '/api/adm/antiabuso', { headers: cliAut });
  ok(espiar.status === 403, `cliente não lê a fila: ${espiar.status}`);
  const liberar = await fetch(BASE + '/api/adm/antiabuso/' + accEu.id + '/liberar',
    { method: 'POST', headers: cliAut, body: '{}' });
  ok(liberar.status === 403, `nem libera a própria comissão: ${liberar.status}`);

  console.log('\n=== 11. O IPv4 embrulhado em IPv6 é o MESMO endereço ===');
  // `::ffff:1.2.3.4` é como o Node entrega um IPv4 num socket IPv6. Sem
  // normalizar, a mesma máquina apareceria como dois IPs e nenhum sinal casaria
  // — o antiabuso ficaria de olhos abertos e sem enxergar nada.
  const a = anti.ipDaRequisicao({ headers: {}, socket: { remoteAddress: '::ffff:198.51.100.1' } });
  ok(a === '198.51.100.1', `normalizado: ${a}`);
  const b = anti.ipDaRequisicao({ headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }, socket: {} });
  ok(b === '198.51.100.1', 'e do X-Forwarded-For sai o primeiro, que é o cliente');

  srv.close();
  await encerrar(srv, falhas);
})();
