// ============================================================================
// ALUGUEL DE NÚMEROS — a camada de revenda
//
// Aqui a plataforma compra na Integra X e revende ao cliente, debitando da
// carteira dele. Tudo neste arquivo é dinheiro, e por isso o teste é grande:
// cada regra que não estiver presa aqui é um jeito de a plataforma pagar a
// conta de alguém sem receber, ou de cobrar de um cliente sem entregar.
//
// O QUE ESTÁ SENDO PROTEGIDO, do mais caro para o mais barato:
//
// 1. A ORDEM DÉBITO→COMPRA E O ESTORNO. Se a compra falha depois do débito e
//    ninguém devolve, o cliente pagou por nada. Se a ordem se inverte e o
//    débito falha depois da compra, a plataforma pagou a Integra X de graça.
//
// 2. A RÉGUA DOS 5 DIAS. É o único mecanismo entre um cliente sem saldo e a
//    plataforma pagando o número dele para sempre.
//
// 3. O CANCELAMENTO PRIMEIRO NO PROVEDOR. Marcar "cancelado" aqui quando a
//    chamada lá falhou para de cobrar do cliente e NÃO para de pagar ao
//    provedor — o pior dos dois mundos, e silencioso.
//
// 4. O PREÇO CONGELADO. Subir a tabela não pode cobrar mais de quem já alugou.
//
// 5. O DONO DO NÚMERO. `rentalId` é o id na Integra X; sem conferir dono, uma
//    conta lê os SMS de outra passando o id na mão — códigos de verificação
//    inclusive.
//
// NUNCA se chama a Integra X de verdade aqui: comprar gasta dinheiro na hora.
// O provedor é sempre o de mentira abaixo.
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

// ---- provedor de mentira ----
const chamadas = [];
const fetchReal = global.fetch;
let fila = [];
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (!url.includes('integraflux.com')) return fetchReal(u, o);
  chamadas.push({ url, metodo: o.method, corpo: o.body ? JSON.parse(o.body) : null });
  const r = fila.shift() || { ok: true, status: 200, body: {} };
  return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body) };
};
const responder = (body, ok = true, status = 200) => { fila.push({ ok, status, body }); };

const db = require(R + 'src/db');
const numeros = require(R + 'src/numeros');
const al = require(R + 'src/numaluguel');
const DIA = 24 * 3600 * 1000;
const BASE = 'http://127.0.0.1:3981';

(async () => {
  await db.loadAsync();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3981);
  await new Promise(r => setTimeout(r, 150));

  // Uma conta de cliente com saldo, sem trava de assinatura no caminho.
  const criar = async (nome, email, saldoCents) => {
    await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nome, email, pass: 'segredo123' })
    });
    const acc = db.findAccountByEmail(email);
    acc.unlimited = true;
    acc.wallet.balance = saldoCents;
    db.save();
    const l = await (await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: email, pass: 'segredo123' })
    })).json();
    return { acc, aut: { Authorization: 'Bearer ' + l.token, 'Content-Type': 'application/json' } };
  };

  console.log('=== 1. Sem provedor OU sem preço, a revenda não existe ===');
  // As duas condições, separadas: token sem preço é o caso real de quem
  // configurou a integração e ainda não decidiu quanto cobrar. Se a tela
  // aparecesse aí, o cliente alugaria de graça e a plataforma pagaria a conta.
  numeros.cfg().enabled = true;
  numeros.cfg().token = 'TOKEN-DE-MENTIRA';
  al.cfg().precoCents = 0;
  ok(!al.revendaAtiva(), 'provedor pronto mas preço zero: revenda desligada');
  al.salvarPrecos({ precoCents: 2500, cicloDias: 30, prazoSaldoDias: 5, avisarDias: 10 });
  ok(al.revendaAtiva(), 'com preço, ligada');
  numeros.cfg().enabled = false;
  ok(!al.revendaAtiva(), 'e desligando o provedor, desliga de novo');
  numeros.cfg().enabled = true;

  const cliente = await criar('Loja A', 'a@loja.com', 10000);   // R$ 100
  const me1 = await (await fetch(BASE + '/api/me', { headers: cliente.aut })).json();
  ok(me1.numerosAluguel === true, '/me acende o item no menu quando a revenda está de pé');

  console.log('\n=== 2. Alugar debita a carteira e guarda o preço do dia ===');
  // 45 dias DE PROPÓSITO: o ciclo configurado é 30, então uma data de 30 dias
  // passaria neste teste mesmo se o vencimento do provedor fosse ignorado e o
  // ciclo usado como estimativa. Os 45 só existem se a resposta foi lida.
  responder({ rental_id: 'rent-1', phone: '11999990001', price_brl: 12.00,
              expires_at: new Date(Date.now() + 45 * DIA).toISOString() });
  const r1 = await (await fetch(BASE + '/api/numeros/comprar', {
    method: 'POST', headers: cliente.aut, body: JSON.stringify({ ddd: '11' })
  })).json();
  ok(r1.aluguel && r1.aluguel.numero === '11999990001', 'alugou: ' + (r1.aluguel || {}).numero);
  ok(cliente.acc.wallet.balance === 7500, `carteira foi de 10000 para ${cliente.acc.wallet.balance} (−2500)`);
  const guardado = al.meus(cliente.acc)[0];
  ok(guardado.precoCents === 2500, 'o preço do dia ficou gravado no aluguel');
  ok(guardado.custoCents === 1200, `e o CUSTO da plataforma também, separado: ${guardado.custoCents}`);
  ok(guardado.venceEm > Date.now() + 44 * DIA,
     'o vencimento veio do PROVEDOR (45d), e não do ciclo estimado (30d)');
  ok(!r1.aluguel.custoCents, 'o cliente NÃO recebe o custo da plataforma — é margem, não é da conta dele');

  console.log('\n=== 3. Compra que falha no provedor DEVOLVE o dinheiro ===');
  // É a decisão de ordem: debita, tenta comprar, e se a compra morrer, estorna.
  // Sem isto o cliente paga por um número que nunca existiu.
  const antes = cliente.acc.wallet.balance;
  responder({ message: 'sem numeros disponiveis' }, false, 502);
  const falhou = await fetch(BASE + '/api/numeros/comprar', {
    method: 'POST', headers: cliente.aut, body: JSON.stringify({ ddd: '11' })
  });
  ok(falhou.status >= 400, 'a compra falhou: ' + falhou.status);
  ok(cliente.acc.wallet.balance === antes,
     `e o saldo voltou ao que era: ${cliente.acc.wallet.balance} (era ${antes})`);
  ok(al.meus(cliente.acc).length === 1, 'nenhum aluguel fantasma ficou no banco');
  const estorno = cliente.acc.wallet.transactions.slice(-1)[0];
  ok(/Estorno/.test(estorno.label), 'e o estorno aparece no extrato, com nome: ' + estorno.label);

  console.log('\n=== 4. Sem saldo não se aluga — e nada é tocado ===');
  const pobre = await criar('Loja B', 'b@loja.com', 500);   // R$ 5, aluguel custa 25
  const chamadasAntes = chamadas.length;
  const semSaldo = await fetch(BASE + '/api/numeros/comprar', {
    method: 'POST', headers: pobre.aut, body: JSON.stringify({})
  });
  ok(semSaldo.status === 402, `recusado com 402: ${semSaldo.status}`);
  ok(pobre.acc.wallet.balance === 500, 'o saldo continua intacto');
  ok(chamadas.length === chamadasAntes,
     'e o provedor NEM FOI CHAMADO — a checagem vem antes, para não gastar compra');

  console.log('\n=== 5. Subir a tabela não mexe em quem já alugou ===');
  al.salvarPrecos({ precoCents: 4000 });
  ok(al.meus(cliente.acc)[0].precoCents === 2500,
     'o aluguel de ontem continua a 2500 — mudar contrato em curso é cobrar a mais sem avisar');
  const visao = await (await fetch(BASE + '/api/numeros', { headers: cliente.aut })).json();
  ok(visao.precoCents === 4000, 'mas o preço NOVO é o que a vitrine mostra: ' + visao.precoCents);
  al.salvarPrecos({ precoCents: 2500 });

  console.log('\n=== 6. A RÉGUA DOS 5 DIAS ===');
  // O cenário que a régua existe para resolver: vence em 3 dias, e a carteira
  // não cobre a renovação.
  const a1 = al.meus(cliente.acc)[0];
  a1.venceEm = Date.now() + 3 * DIA;
  cliente.acc.wallet.balance = 100;         // menos que os 2500 da renovação
  db.save();
  responder({ refunded: false });            // o cancelamento no provedor dá certo
  let resumo = await al.varrer(null);
  ok(a1.status === 'cancelado', `cancelado nos dois lados: ${a1.status}`);
  ok(resumo.cancelados === 1, 'a varredura contou o cancelamento');
  ok(/falta de saldo/i.test(a1.motivo), 'e o motivo fica escrito, para o cliente ler: ' + a1.motivo);
  const cancelou = chamadas.slice(-1)[0];
  ok(/cancel/.test(cancelou.url), 'a Integra X foi mesmo chamada para cancelar: ' + cancelou.url.split('/api')[1]);

  console.log('\n=== 7. Vence em 3 dias mas TEM saldo: não se toca ===');
  responder({ rental_id: 'rent-2', phone: '11999990002', price_brl: 12.00,
              expires_at: new Date(Date.now() + 30 * DIA).toISOString() });
  cliente.acc.wallet.balance = 10000;
  await al.comprar(cliente.acc, { ddd: '11' }, null);
  const a2 = al.meus(cliente.acc)[0];
  a2.venceEm = Date.now() + 3 * DIA;
  db.save();
  const nAntes = chamadas.length;
  resumo = await al.varrer(null);
  ok(a2.status === 'ativo', 'continua ativo — quem tem com que pagar não perde o número');
  ok(chamadas.length === nAntes, 'e nada foi cancelado no provedor');

  console.log('\n=== 8. O provedor recusar o cancelamento NÃO marca cancelado aqui ===');
  // A armadilha silenciosa: se marcássemos cancelado, pararíamos de cobrar do
  // cliente e continuaríamos pagando a Integra X.
  a2.venceEm = Date.now() + 2 * DIA;
  cliente.acc.wallet.balance = 0;
  db.save();
  responder({ message: 'provedor fora do ar' }, false, 502);
  resumo = await al.varrer(null);
  ok(a2.status === 'cancelando',
     `ficou pendente e não "cancelado": ${a2.status} — parar de cobrar sem parar de pagar é o pior caso`);
  ok(resumo.erros >= 1, 'e a varredura contou como erro, não como sucesso');

  console.log('\n=== 9. A varredura do dia seguinte insiste ===');
  responder({ refunded: false });
  resumo = await al.varrer(null);
  ok(a2.status === 'cancelado', `na segunda tentativa fechou: ${a2.status}`);
  ok(resumo.retentados === 1, 'contado como retentativa, e não como cancelamento novo');

  console.log('\n=== 10. Renovação: venceu com saldo, debita e empurra o vencimento ===');
  responder({ rental_id: 'rent-3', phone: '11999990003', price_brl: 12.00,
              expires_at: new Date(Date.now() + 30 * DIA).toISOString() });
  cliente.acc.wallet.balance = 10000;
  await al.comprar(cliente.acc, { ddd: '11' }, null);
  const a3 = al.meus(cliente.acc)[0];
  a3.venceEm = Date.now() - 1000;          // venceu agora
  const saldoPre = cliente.acc.wallet.balance;
  db.save();
  resumo = await al.varrer(null);
  ok(a3.status === 'ativo', 'segue ativo');
  ok(cliente.acc.wallet.balance === saldoPre - 2500,
     `e a renovação foi debitada: ${saldoPre} → ${cliente.acc.wallet.balance}`);
  ok(a3.venceEm > Date.now() + 29 * DIA, 'com o vencimento empurrado um ciclo');
  ok(resumo.renovados === 1, 'a varredura contou a renovação');

  console.log('\n=== 11. Um número é de UMA conta só ===');
  // Sem esta checagem, `rentalId` é um id do provedor que qualquer conta
  // adivinha ou copia — e do outro lado estão códigos de verificação.
  const outra = await criar('Loja C', 'c@loja.com', 10000);
  const alheio = await fetch(BASE + '/api/numeros/' + encodeURIComponent(a3.id) + '/sms', { headers: outra.aut });
  ok(alheio.status === 404, `a outra conta não lê os SMS deste número: ${alheio.status}`);
  const cancelAlheio = await fetch(BASE + '/api/numeros/' + encodeURIComponent(a3.id) + '/cancelar',
    { method: 'POST', headers: outra.aut });
  ok(cancelAlheio.status === 404, `nem cancela: ${cancelAlheio.status}`);
  ok(a3.status === 'ativo', 'e o número continua de pé');

  console.log('\n=== 12. Desligar a renovação é o cancelamento educado ===');
  // Cancelar agora joga fora dias já pagos; quem só não quer o próximo ciclo
  // desliga a renovação e usa até o fim.
  await fetch(BASE + '/api/numeros/' + encodeURIComponent(a3.id) + '/renovacao', {
    method: 'PUT', headers: cliente.aut, body: JSON.stringify({ ativa: false })
  });
  ok(a3.renovacaoAuto === false, 'renovação desligada');
  a3.venceEm = Date.now() - 1000;
  cliente.acc.wallet.balance = 10000;      // tem saldo de sobra
  db.save();
  responder({ refunded: false });
  await al.varrer(null);
  ok(a3.status === 'cancelado', 'venceu e NÃO renovou, mesmo com saldo — foi o que o cliente pediu');

  console.log('\n=== 13. O cliente vê o risco antes de perder o número ===');
  responder({ rental_id: 'rent-4', phone: '11999990004', price_brl: 12.00,
              expires_at: new Date(Date.now() + 30 * DIA).toISOString() });
  cliente.acc.wallet.balance = 10000;
  await al.comprar(cliente.acc, { ddd: '11' }, null);
  const a4 = al.meus(cliente.acc)[0];
  a4.venceEm = Date.now() + 4 * DIA;
  db.save();
  const vis = await (await fetch(BASE + '/api/numeros', { headers: cliente.aut })).json();
  const linha = vis.numeros.find(n => n.id === a4.id);
  // RISCO É VENCER LOGO **E** NÃO TER COM QUE PAGAR. Marcando só pela data,
  // todo número entrava em alarme vermelho nos últimos cinco dias do ciclo —
  // inclusive o de quem tem saldo de sobra e ia renovar sem perceber. Alarme
  // que dispara sempre é alarme que ninguém lê, e o dia em que faltar dinheiro
  // de verdade passa batido no meio dos falsos.
  ok(linha.emRisco === false,
     'vencendo em 4 dias mas COM saldo: não é risco — alarme falso treina a pessoa a ignorar');
  cliente.acc.wallet.balance = 100;   // agora não cobre a renovação
  db.save();
  const vis2 = await (await fetch(BASE + '/api/numeros', { headers: cliente.aut })).json();
  const linha2 = vis2.numeros.find(n => n.id === a4.id);
  ok(linha2.emRisco === true, 'zerando a carteira, aí sim vira risco');
  ok(linha.diasParaVencer <= 5 && linha.diasParaVencer > 0, `com a contagem dos dias: ${linha.diasParaVencer}`);
  ok(vis2.emRisco >= 1, 'e a tela recebe o total, para o aviso do topo');
  ok(vis2.saldo === cliente.acc.wallet.balance, 'junto com o saldo, que é o que resolve');

  console.log('\n=== 14. A visão do admin: margem e quem está para vencer ===');
  const admLogin = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const admAut = { Authorization: 'Bearer ' + admLogin.token, 'Content-Type': 'application/json' };
  const va = await (await fetch(BASE + '/api/admin/numeros/alugueis', { headers: admAut })).json();
  ok(va.alugueis.length >= 1, `o admin vê os aluguéis: ${va.alugueis.length}`);
  const ativo = va.alugueis.find(x => x.status === 'ativo');
  ok(ativo.margemCents === ativo.precoCents - ativo.custoCents,
     `com a margem calculada: ${ativo.precoCents} − ${ativo.custoCents} = ${ativo.margemCents}`);
  ok(ativo.conta === 'Loja A', 'e de que conta é: ' + ativo.conta);
  ok(typeof ativo.saldo === 'number', 'com o saldo da conta ao lado, que é o que decide se o número sobrevive');

  // O cruzamento que o admin precisa numa tela só: vence logo E não tem saldo.
  cliente.acc.wallet.balance = 0;
  db.save();
  const va2 = await (await fetch(BASE + '/api/admin/numeros/alugueis', { headers: admAut })).json();
  ok(va2.emRisco >= 1, `zerando a carteira, o número entra na lista de risco do admin: ${va2.emRisco}`);

  console.log('\n=== 15. O preço é do ADMIN, e só dele ===');
  const tentou = await fetch(BASE + '/api/admin/numeros/precos', {
    method: 'PUT', headers: cliente.aut, body: JSON.stringify({ precoCents: 1 })
  });
  ok(tentou.status === 403, `um cliente não muda a tabela de preço: ${tentou.status}`);
  ok(al.preco() === 2500, 'e o preço continua o que era: ' + al.preco());

  console.log('\n=== 16. O aviso do admin sai do MESMO evento da varredura ===');
  // Duas versões do texto (uma no SSE, outra no push) divergem na primeira
  // vez que alguém mexer só numa delas.
  const { avisoDoEvento } = require(R + 'src/avisospush');
  const aviso = avisoDoEvento('numeros_admin', { accountId: 'acc_x', cancelados: 2, perto: 3 });
  ok(aviso && aviso.paraAdmin === true, 'o aviso é para o ADMIN, e não para o dono da conta');
  ok(/2 cancelado/.test(aviso.payload.body) && /3 perto/.test(aviso.payload.body),
     'e diz os dois números: ' + aviso.payload.body);
  ok(!avisoDoEvento('numeros_admin', { accountId: 'acc_x', cancelados: 0, perto: 0 }),
     'sem nada acontecendo, nenhum aviso é mandado — push vazio treina a pessoa a ignorar');

  console.log('\n=== 17. As telas: configuração no admin, operação no app ===');
  const fs = require('fs');
  const tela = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const menuAdm = fs.readFileSync(R + 'public/adm/index.html', 'utf8');
  const menuApp = fs.readFileSync(R + 'public/app/index.html', 'utf8');

  // No admin, os números voltaram para DENTRO de Integrações: lá se configura o
  // provedor e o preço, e configuração não merece aba própria no menu.
  ok(!menuAdm.includes('data-view="adm/numeros"'), 'o menu do admin não tem mais item separado para números');
  ok(!/'adm\/numeros'/.test(tela), 'nem a rota separada');
  ok(!/data-pane="adm-num"/.test(tela), 'nem painel separado');
  const paneInt = tela.slice(tela.indexOf('data-pane="adm-int"'), tela.indexOf('data-pane="adm-int"') + 900);
  ok(/adm-num-box/.test(paneInt), 'a caixa está de volta dentro de Integrações');
  const intLoad = tela.slice(tela.indexOf('function admIntLoad'), tela.indexOf('function admIntLoad') + 160);
  ok(/admNumLoad/.test(intLoad), 'e Integrações volta a carregá-la');

  // No app, a tela é do CLIENTE — não a do painel reaproveitada.
  ok(menuApp.includes('data-view="numeros"'), 'o app tem o item no menu');
  ok(/function numCliPaint/.test(tela), 'e uma tela própria de cliente');
  ok(/Recarregar carteira/.test(tela), 'que leva para a recarga quando o saldo é o problema');
  ok(!/renderNumeros[\s\S]{0,400}admNumLoad\(\)/.test(tela),
     'a tela do cliente NÃO é mais a do painel: cliente não configura token');
  ok(/v === 'numeros' && !state\.numerosAluguel/.test(tela),
     'o item só aparece quando a plataforma revende de fato');

  srv.close();
  global.fetch = fetchReal;
  await encerrar(srv, falhas);
})();
