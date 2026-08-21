// PAINEL DA PLATAFORMA — porta própria, escopo próprio, visão da operação.
//
// Até aqui havia UMA porta: /api/login aceitava a credencial do admin e a de
// qualquer cliente, e a sessão que saía dali abria as duas coisas. Quem
// descobrisse o usuário do admin tentava a senha na mesma tela em que os
// clientes entram.
//
// O que este teste segura:
//   · a credencial do admin NÃO entra mais pela porta do cliente;
//   · a credencial de cliente NÃO entra pela porta do admin;
//   · ser admin não basta para as rotas de administração: a sessão precisa ter
//     nascido no painel da plataforma (escopo `adm`);
//   · a visão da operação soma TODAS as contas, e a Superconta aparece
//     separada dos clientes — contá-la como assinante inflaria as métricas;
//   · contatos e usuários de todas as contas são LIDOS onde estão, com o nome
//     do cliente ao lado, sem cópia para lugar nenhum.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// MySQL falso: o teste não pode encostar no banco de desenvolvimento.
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

const porta = 3997;
const url = (r) => 'http://127.0.0.1:' + porta + r;

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();

  // Duas contas de cliente com contatos e um atendente, para a visão geral ter
  // o que somar.
  const agora = Date.now();
  const cliente = db.newAccount({ name: 'Padaria do Zé', email: 'ze@padaria.com', pass: 'segredo123' });
  cliente.contacts = [
    { waId: '5511999990001', name: 'Maria', stage: 'Novo', lastMessageAt: agora - 1000, vars: { email: 'maria@ex.com' } },
    { waId: '5511999990002', name: 'João', stage: 'Ganho', lastMessageAt: agora - 5000, vars: {} }
  ];
  cliente.messages = [
    { id: 'm1', waId: '5511999990001', direction: 'in', timestamp: agora - 1000 },
    { id: 'm2', waId: '5511999990001', direction: 'out', timestamp: agora - 900 },
    { id: 'm3', waId: '5511999990002', direction: 'in', timestamp: agora - 40 * 86400000 }
  ];
  cliente.team = [{ id: 'ag1', name: 'Ana', email: 'ana@padaria.com', role: 'agent', sector: 'Vendas', lastLoginAt: agora - 60000 }];
  // Plano ativo de propósito: sem assinatura a conta para no 402 da
  // assinatura obrigatória e nunca chega na guarda do painel, que é o que
  // este teste quer medir.
  cliente.billing.status = 'active';
  cliente.billing.periodEnd = agora + 30 * 86400000;
  db.get().accounts.push(cliente);

  const outro = db.newAccount({ name: 'Loja da Bia', email: 'bia@loja.com', pass: 'segredo123' });
  outro.contacts = [{ waId: '5511888880001', name: 'Carlos', stage: '', lastMessageAt: agora - 200 }];
  db.get().accounts.push(outro);
  db.save();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const entrar = (rota, corpo) => fetch(url(rota), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo)
  }).then(async r => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));
  const pegar = (rota, tok) => fetch(url(rota), { headers: { Authorization: 'Bearer ' + tok } })
    .then(async r => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));

  console.log('=== 1. Duas portas, cada uma com a sua credencial ===');
  const admBom = await entrar('/api/adm/login', { user: 'admin', pass: 'admin' });
  ok(admBom.http === 200 && !!admBom.token, 'o admin entra pela porta dele: ' + admBom.http);
  ok(admBom.escopo === 'adm', 'e a sessão nasce com o escopo do painel: ' + admBom.escopo);

  // A credencial da plataforma TAMBÉM entra pela porta do cliente: o dono tem
  // uma conta operacional e precisa dela. O que não atravessa é o poder.
  const admNoApp = await entrar('/api/login', { user: 'admin', pass: 'admin' });
  ok(admNoApp.http === 200, 'a credencial da plataforma abre o painel do cliente: ' + admNoApp.http);
  ok(admNoApp.kind === 'account', 'mas como CONTA, não como admin: ' + admNoApp.kind);

  // A prova do que importa: essa sessão não administra nada.
  const semPoder = await pegar('/api/adm/overview', admNoApp.token);
  ok(semPoder.http === 403, 'e ela é recusada nas rotas de administração: ' + semPoder.http);
  const semPoder2 = await pegar('/api/admin/saas', admNoApp.token);
  ok(semPoder2.http === 403, 'em todas elas: ' + semPoder2.http);

  // Senha errada continua parando na porta, com a mensagem de sempre.
  const admRuim = await entrar('/api/login', { user: 'admin', pass: 'chute' });
  ok(admRuim.http === 401, 'senha errada não entra: ' + admRuim.http);
  ok(admRuim.error === 'Usuário ou senha inválidos',
     'com a mesma mensagem de sempre, sem confirmar que o usuário existe');

  const clienteNoAdm = await entrar('/api/adm/login', { user: 'ze@padaria.com', pass: 'segredo123' });
  ok(clienteNoAdm.http === 401, 'a credencial do cliente NÃO entra pela porta do admin: ' + clienteNoAdm.http);

  const clienteBom = await entrar('/api/login', { user: 'ze@padaria.com', pass: 'segredo123' });
  ok(clienteBom.http === 200 && !!clienteBom.token, 'o cliente entra pela dele: ' + clienteBom.http);

  console.log('\n=== 2. Sessão de cliente não alcança o painel ===');
  const barrado = await pegar('/api/adm/overview', clienteBom.token);
  ok(barrado.http === 403, 'a visão da operação recusa a sessão de cliente: ' + barrado.http);
  const barrado2 = await pegar('/api/admin/saas', clienteBom.token);
  ok(barrado2.http === 403, 'e as rotas de admin que já existiam também: ' + barrado2.http);

  console.log('\n=== 3. A visão soma a operação inteira ===');
  const vis = await pegar('/api/adm/overview', admBom.token);
  ok(vis.http === 200, 'o admin lê: ' + vis.http);
  ok(vis.totais.contatos === 3, `3 contatos somando as duas contas: ${vis.totais.contatos}`);
  ok(vis.totais.clientes === 2, `2 contas de cliente: ${vis.totais.clientes}`);
  // Dono + atendente na primeira, dono na segunda.
  ok(vis.totais.pessoas === 3, `3 pessoas com acesso: ${vis.totais.pessoas}`);
  // Só as mensagens das últimas 24h: a de 40 dias atrás não conta.
  ok(vis.totais.msg24h === 2, `2 mensagens nas últimas 24h: ${vis.totais.msg24h}`);
  ok(vis.totais.conversasAbertas === 1, `1 conversa em andamento: ${vis.totais.conversasAbertas}`);
  const topo = vis.ranking[0];
  ok(topo && topo.nome === 'Padaria do Zé', 'o ranking põe na frente quem mais movimenta: ' + (topo && topo.nome));

  console.log('\n=== 4. Todos os contatos, com o cliente ao lado ===');
  let ct = await pegar('/api/adm/contacts', admBom.token);
  ok(ct.total === 3, `os 3 contatos aparecem: ${ct.total}`);
  ok(ct.itens[0].conta === 'Loja da Bia', 'cada linha diz de qual conta é: ' + ct.itens[0].conta);
  ok(ct.itens[0].nome === 'Carlos', 'ordenado pela última mensagem, de todas as contas juntas: ' + ct.itens[0].nome);
  ok(ct.itens[1].nome === 'Maria' && ct.itens[2].nome === 'João', 'e a ordem segue conta a conta misturada, como uma lista só');

  ct = await pegar('/api/adm/contacts?q=carlos', admBom.token);
  ok(ct.total === 1 && ct.itens[0].conta === 'Loja da Bia', 'a busca atravessa as contas: ' + ct.total);
  ct = await pegar('/api/adm/contacts?q=5511888', admBom.token);
  ok(ct.total === 1, 'e acha por telefone também: ' + ct.total);
  ct = await pegar('/api/adm/contacts?accountId=' + cliente.id, admBom.token);
  ok(ct.total === 2, 'o filtro por conta isola uma só: ' + ct.total);

  console.log('\n=== 5. Toda a gente do sistema ===');
  const us = await pegar('/api/adm/users', admBom.token);
  ok(us.total === 3, `2 titulares e 1 atendente: ${us.total}`);
  const ana = us.itens.find(u => u.nome === 'Ana');
  ok(!!ana && ana.tipo === 'atendente', 'o atendente aparece com o papel dele: ' + (ana && ana.papel));
  ok(!!ana && ana.conta === 'Padaria do Zé', 'e com a conta a que pertence: ' + (ana && ana.conta));

  console.log('\n=== 6. Superconta: conta comum, fora das métricas de cliente ===');
  const nova = await fetch(url('/api/adm/supers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admBom.token },
    body: JSON.stringify({ name: 'Minha Outra Empresa', email: 'outra@minha.com', pass: 'segredo123' })
  }).then(async r => ({ http: r.status, ...(await r.json()) }));
  ok(nova.http === 200, 'criada: ' + nova.http);
  const criada = db.findAccount(nova.id);
  ok(!!criada && criada.unlimited === true, 'nasce sem teto de uso');

  const sup = await pegar('/api/adm/supers', admBom.token);
  ok(sup.itens.length === 1 && sup.itens[0].nome === 'Minha Outra Empresa', 'e aparece na lista de Supercontas');

  const vis2 = await pegar('/api/adm/overview', admBom.token);
  ok(vis2.totais.supercontas === 1, 'contada como Superconta: ' + vis2.totais.supercontas);
  ok(vis2.totais.clientes === 2, 'e NÃO como cliente, que continua 2: ' + vis2.totais.clientes);

  const saas = await pegar('/api/admin/saas', admBom.token);
  ok(saas.metrics.accounts === 2, 'as métricas do SaaS também ignoram: ' + saas.metrics.accounts);

  // Ela entra pelo painel do CLIENTE, com a senha definida na criação.
  const entradaSuper = await entrar('/api/login', { user: 'outra@minha.com', pass: 'segredo123' });
  ok(entradaSuper.http === 200, 'e o dono entra nela pelo painel do cliente: ' + entradaSuper.http);
  ok(entradaSuper.planRequired === false, 'sem exigir assinatura: ' + entradaSuper.planRequired);

  console.log('\n=== 7. E-mail repetido é recusado ===');
  const repetida = await fetch(url('/api/adm/supers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admBom.token },
    body: JSON.stringify({ name: 'Outra', email: 'ze@padaria.com', pass: 'segredo123' })
  }).then(r => r.status);
  ok(repetida === 409, 'não dá para roubar o e-mail de um cliente: ' + repetida);
  const senhaCurta = await fetch(url('/api/adm/supers'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admBom.token },
    body: JSON.stringify({ name: 'Outra', email: 'nova@minha.com', pass: '123' })
  }).then(r => r.status);
  ok(senhaCurta === 400, 'nem criar com senha fraca: ' + senhaCurta);

  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
