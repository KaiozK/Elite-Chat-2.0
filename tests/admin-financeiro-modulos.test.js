// ============================================================================
// ADMIN: O FINANCEIRO COM MÉTODO, E O INTERRUPTOR DOS MÓDULOS
//
// FINANCEIRO. O painel mostrava totais e uma linha por conta. Faltava a
// pergunta mais simples de quem toca um SaaS: "o que entrou, quando, de quem, e
// por qual meio?" — e sem ela não dá para conferir um repasse, achar uma
// cobrança reclamada, nem saber quanto do faturamento passa por cartão, que
// custa taxa diferente do Pix.
//
// São DOIS DINHEIROS, e somá-los inventaria um faturamento que não existe: o
// que os clientes pagam à Koonfy, e o que os clientes DELES pagam a eles — de
// onde sai a taxa da plataforma.
//
// MÓDULOS. Interruptor geral, para o dia em que uma integração começa a falhar
// e a escolha é entre desligar o recurso ou deixar cada cliente descobrir o
// defeito sozinho.
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

const fs = require('fs');
const db = require(R + 'src/db');
const saaspix = require(R + 'src/saaspix');
const limits = require(R + 'src/limits');

const BASE = 'http://127.0.0.1:3998';
const json = r => r.json();
const agora = Date.now();

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3998);
  await new Promise(r => setTimeout(r, 150));

  db.get().plans.push({ id: 'pro', name: 'Pro', price: 19700, periodDays: 30, limits: {}, modules: {} });
  db.save();

  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Loja A', email: 'a@ex.com', pass: 'segredo123',
      profile: { phone: '11988887777', country: 'BR' }, recebimento: { document: '39053344705' }
    })
  });
  const acc = db.findAccountByEmail('a@ex.com');
  acc.billing.status = 'active'; acc.billing.planId = 'pro';
  acc.billing.periodEnd = agora + 30 * 86400000;

  // Receita da KOONFY, uma de cada método.
  db.get().revenue = [
    { ts: agora - 3600e3, accountId: acc.id, planId: 'pro', amount: 19700, kind: 'first', chargeId: 'nov-abc', metodo: 'pix' },
    { ts: agora - 7200e3, accountId: acc.id, planId: 'pro', amount: 19700, kind: 'renewal', chargeId: 'card-ren-x' },
    { ts: agora - 10800e3, accountId: acc.id, planId: 'pro', amount: 5000, kind: 'topup', chargeId: 'topup-y' },
    { ts: agora - 14400e3, accountId: acc.id, planId: 'pro', amount: 19700, kind: 'renewal', chargeId: 'bol-ren-z' },
    // Fora do período de 7 dias, para provar que o filtro corta.
    { ts: agora - 40 * 86400000, accountId: acc.id, planId: 'pro', amount: 99900, kind: 'renewal', chargeId: 'card-ren-velho' }
  ];
  // Vendas DO CLIENTE, com a taxa que fica com a plataforma.
  acc.pagamentos = { charges: [
    { id: 'c1', value: 10000, platformCut: 500, status: 'paid', method: 'pix', paidAt: agora - 1800e3, waId: '5511999998888' },
    { id: 'c2', value: 20000, platformCut: 1000, status: 'paid', method: 'card', paidAt: agora - 3600e3, waId: '5511999997777' },
    { id: 'c3', value: 30000, platformCut: 0, status: 'active', method: 'pix', createdAt: agora - 600e3 }
  ], logs: [] };
  db.save();

  const adm = await json(await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  }));
  const cli = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'a@ex.com', pass: 'segredo123' })
  }));
  const como = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  console.log('=== 1. O MÉTODO sai do identificador da cobrança ===');
  // O prefixo já dizia isso desde sempre; a informação é que morria ali.
  ok(saaspix.metodoDeCid('card-sub-1') === 'card', 'card- → cartão');
  ok(saaspix.metodoDeCid('bol-sub-1') === 'bol', 'bol- → boleto');
  ok(saaspix.metodoDeCid('wallet-ren-1') === 'wallet', 'wallet- → saldo');
  ok(saaspix.metodoDeCid('nov-1') === 'pix', 'nov- → Pix (checkout de cadastro)');
  ok(saaspix.metodoDeCid('ren-1', { billing: { wooviSubId: 's' } }) === 'pixauto',
     'e ren- com assinatura ativa é Pix Automático — o banco pagou sozinho');
  ok(saaspix.metodoDeCid('ren-1', { billing: {} }) === 'pix', 'sem assinatura, Pix comum');

  console.log('\n=== 2. Só o ADMIN vê o financeiro ===');
  const rCli = await fetch(BASE + '/api/adm/financeiro', { headers: como(cli.token) });
  ok(rCli.status === 403, `o cliente recebe 403: ${rCli.status}`);

  console.log('\n=== 3. As transações vêm com método e dono ===');
  const d = await json(await fetch(BASE + '/api/adm/financeiro?dias=7', { headers: como(adm.token) }));
  ok(d.transacoes.length === 7, `quatro da Koonfy + três cobranças do cliente (a em aberto aparece na lista, mas não nos totais): ${d.transacoes.length}`);
  const metodos = d.transacoes.filter(t => t.origem === 'koonfy').map(t => t.metodo).sort().join(',');
  ok(metodos === 'bol,card,pix,pix', 'com o método de cada uma: ' + metodos);
  ok(d.transacoes.every(t => t.metodoLabel), 'e o nome em português para a tela');
  ok(d.transacoes[0].ts >= d.transacoes[1].ts, 'mais recentes primeiro');
  // O registro antigo, sem `metodo` gravado, é deduzido pelo prefixo.
  const daRenovacao = d.transacoes.find(t => t.ref === 'card-ren-x');
  ok(daRenovacao && daRenovacao.metodo === 'card',
     'registro antigo sem método gravado é deduzido pelo prefixo');

  console.log('\n=== 4. OS DOIS DINHEIROS NÃO SE SOMAM ===');
  // O valor da venda é do cliente; o que é seu ali é a taxa. Somar os dois
  // inventaria um faturamento que não existe.
  ok(d.totais.koonfy === 19700 + 19700 + 5000 + 19700,
     `recebido pela Koonfy: ${d.totais.koonfy}`);
  ok(d.totais.cliente === 30000, `vendas dos clientes (só as pagas): ${d.totais.cliente}`);
  ok(d.totais.taxas === 1500, `e a sua taxa sobre elas: ${d.totais.taxas}`);
  ok(d.totais.transacoes === 6, 'a cobrança em aberto não conta como paga');

  const cartao = d.porMetodo.find(m => m.metodo === 'card');
  ok(cartao && cartao.koonfy === 19700 && cartao.cliente === 20000,
     'o resumo por método separa os dois: ' + JSON.stringify(cartao));

  console.log('\n=== 5. O período CORTA de verdade ===');
  const d30 = await json(await fetch(BASE + '/api/adm/financeiro?dias=90', { headers: como(adm.token) }));
  ok(d30.totais.koonfy > d.totais.koonfy,
     `em 90 dias entra a renovação antiga: ${d30.totais.koonfy} > ${d.totais.koonfy}`);

  console.log('\n=== 6. Filtro por método e por origem ===');
  const soCard = await json(await fetch(BASE + '/api/adm/financeiro?dias=7&metodo=card', { headers: como(adm.token) }));
  ok(soCard.transacoes.every(t => t.metodo === 'card'), 'só cartão');
  ok(soCard.totais.koonfy === 19700, `e os totais acompanham o filtro: ${soCard.totais.koonfy}`);
  const soKoonfy = await json(await fetch(BASE + '/api/adm/financeiro?dias=7&origem=koonfy', { headers: como(adm.token) }));
  ok(soKoonfy.transacoes.every(t => t.origem === 'koonfy'), 'só o que é seu');
  ok(soKoonfy.totais.cliente === 0, 'e nada de venda de cliente na soma');

  console.log('\n=== 7. MÓDULOS: o interruptor geral ===');
  const m0 = await json(await fetch(BASE + '/api/admin/modulos', { headers: como(adm.token) }));
  ok(m0.modulos.length === db.FEATURE_KEYS.length, `todos os módulos: ${m0.modulos.length}`);
  ok(m0.modulos.every(m => m.ligado), 'todos ligados por padrão — vazio quer dizer ligado');
  ok(m0.modulos.every(m => typeof m.contas === 'number'),
     'com quantas contas perdem acesso se desligar — desligar às cegas vira surpresa');

  await fetch(BASE + '/api/admin/modulos', {
    method: 'PUT', headers: como(adm.token), body: JSON.stringify({ campaigns: false })
  });
  const m1 = await json(await fetch(BASE + '/api/admin/modulos', { headers: como(adm.token) }));
  ok(m1.modulos.find(m => m.key === 'campaigns').ligado === false, 'campanhas desligadas');

  console.log('\n=== 8. E desligado vale para TODO MUNDO ===');
  ok(limits.featureOn(acc, 'campaigns') === false, 'a conta com o módulo no plano perde o acesso');
  // Inclusive superconta: se o recurso está quebrado, está quebrado para todos,
  // e deixar o dono entrar é o caminho de descobrir o problema pelo cliente.
  acc.unlimited = true;
  ok(limits.featureOn(acc, 'campaigns') === false, 'e a superconta também');
  acc.unlimited = false;

  // A mensagem não pode ser "faça upgrade": mandaria o cliente pagar por algo
  // que não vai funcionar, e ele volta pedindo reembolso.
  const msg = limits.checkFeature(acc, 'campaigns');
  ok(/temporariamente indisponível/i.test(msg), 'a recusa diz indisponível: ' + msg);
  ok(!/upgrade/i.test(msg), 'e NÃO manda fazer upgrade');
  ok(/nada do que você já configurou foi perdido/i.test(msg), 'tranquilizando sobre o que já estava configurado');

  const rota = await fetch(BASE + '/api/campaigns', { headers: como(cli.token) });
  ok(rota.status === 503, `e a rota inteira recusa com 503 — fora do ar, e não falta de plano: ${rota.status}`);

  console.log('\n=== 9. O menu do cliente esconde o que foi desligado ===');
  const me = await json(await fetch(BASE + '/api/me', { headers: como(cli.token) }));
  ok(me.planFeatures.campaigns === false,
     'o painel recebe o módulo como desligado, e não desenha a aba');

  console.log('\n=== 10. Religar não deixa rastro no banco ===');
  await fetch(BASE + '/api/admin/modulos', {
    method: 'PUT', headers: como(adm.token), body: JSON.stringify({ campaigns: true })
  });
  ok(db.get().platform.modulos.campaigns === undefined,
     'ligado é AUSENTE — assim um módulo novo nunca nasce desligado por um registro velho');
  ok(limits.featureOn(acc, 'campaigns') === true, 'e o acesso volta');

  // Fica registrado: um módulo desligado e esquecido vira "o sistema não
  // funciona" semanas depois, sem ninguém lembrar do porquê.
  const log = db.get().webhookLog.find(e => e.type === 'modulos_plataforma');
  ok(!!log, 'a mudança entra no log do Admin: ' + (log && log.detail));

  console.log('\n=== 11. As telas existem no Admin ===');
  const appjs = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const admHtml = fs.readFileSync(R + 'public/adm/index.html', 'utf8');
  ok(/function admFinLoad/.test(appjs) && /function admModLoad/.test(appjs), 'as duas telas');
  ok(/data-view="adm\/financeiro"/.test(admHtml) && /data-view="adm\/modulos"/.test(admHtml),
     'com entrada no menu do Admin');
  ok(/não se somam/.test(appjs), 'e a tela avisa que os dois dinheiros não se somam');

  srv.close();
  await encerrar(null, falhas);
})();
