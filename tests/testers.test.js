// ============================================================================
// TESTERS — contas de teste, criadas e governadas pelo admin
//
// Um tester usa o produto de verdade, sem pagar. A tentação é implementá-lo
// como "superconta que eu chamo de outro nome", e é justamente o que ele NÃO
// pode ser: superconta é ilimitada, e um tester com envio ilimitado gasta
// WhatsApp e SMS de verdade — na conta da plataforma, por alguém que não está
// comprando nada. A fatura chega antes de qualquer relatório.
//
// O QUE ESTE TESTE PROTEGE:
//
// 1. TESTER TEM TETO, e o teto é o que o admin configurou — não o do plano mais
//    barato publicado. Herdar do plano faria o que o teste enxerga mudar
//    sozinho toda vez que alguém mexesse na tabela de preços.
//
// 2. O LIMITE DE QUANTOS é de verdade. Sem ele, "criar um tester" vira o
//    caminho fácil para dar acesso de graça.
//
// 3. TESTER NÃO É CLIENTE nos números. Ele não paga; somá-lo ao total faria a
//    plataforma parecer maior do que é — o tipo de número errado que se olha
//    por meses sem desconfiar.
//
// 4. E NÃO BATE NA TRAVA DE ASSINATURA. Sem isso a conta de teste abriria
//    direto na tela de Assinatura e não sairia dela, cobrando um plano de quem
//    foi convidado para experimentar de graça.
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
const testers = require(R + 'src/testers');
const limits = require(R + 'src/limits');
const BASE = 'http://127.0.0.1:3985';

(async () => {
  await db.loadAsync();

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3985);
  await new Promise(r => setTimeout(r, 150));

  const admLogin = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const aut = { Authorization: 'Bearer ' + admLogin.token, 'Content-Type': 'application/json' };

  // Um plano publicado caro, para provar que o tester NÃO herda dele.
  db.get().plans.push({
    id: 'plano_caro', name: 'Caro', price: 50000, periodDays: 30,
    limits: { sends: 99999, contacts: 99999, whatsapps: 9, links: 9, flows: 9, pixels: 9, campaigns: 9 },
    modules: { campaigns: true, flows: true, tracking: true, pagamentos: true }
  });
  db.get().platform.billing.requirePlan = true;
  db.save();

  console.log('=== 1. Só o admin cria tester ===');
  const semAuth = await fetch(BASE + '/api/adm/testers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  ok(semAuth.status === 401, `sem sessão: ${semAuth.status}`);

  const visao0 = await (await fetch(BASE + '/api/adm/testers', { headers: aut })).json();
  ok(visao0.limite === 5, `o limite nasce em ${visao0.limite}`);
  ok(visao0.usados === 0 && visao0.vagas === 5, 'sem nenhum criado ainda');
  ok(Object.keys(visao0.modulos).length >= 10,
     `com todos os módulos na lista: ${Object.keys(visao0.modulos).length}`);
  ok(Object.values(visao0.modulos).every(Boolean),
     'todos LIGADOS por padrão — um produto pela metade não se avalia');

  console.log('\n=== 2. Criar, e o tester nasce sem plano e sem cobrança ===');
  const r1 = await (await fetch(BASE + '/api/adm/testers', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Testador Um', email: 't1@ex.com', pass: 'segredo123' })
  })).json();
  ok(!!r1.id, 'criado');
  const t1 = db.findAccountByEmail('t1@ex.com');
  ok(t1.tester === true, 'marcado como tester');
  ok(t1.unlimited === false, 'e NÃO como superconta — a diferença é o teto');
  ok(!t1.billing.planId, 'sem plano');
  ok(r1.visao.usados === 1 && r1.visao.vagas === 4, 'a visão volta atualizada');

  console.log('\n=== 3. O teto é o do ADMIN, não o do plano mais caro ===');
  // É o ponto do arquivo. Sem a regra própria, um tester sem plano cai no plano
  // mais barato publicado — e o que ele enxerga muda sozinho a cada mexida na
  // tabela de preços.
  ok(limits.limitOf(t1, 'sends') === 200,
     `disparos: ${limits.limitOf(t1, 'sends')} (o padrão dos testers, e não os 99999 do plano)`);
  ok(limits.limitOf(t1, 'contacts') === 500, `contatos: ${limits.limitOf(t1, 'contacts')}`);
  ok(limits.limitOf(t1, 'whatsapps') === 1, `conexões: ${limits.limitOf(t1, 'whatsapps')}`);
  ok(limits.isUnlimited(t1) === false, 'e ele NÃO é ilimitado');

  console.log('\n=== 4. Os módulos também vêm de um lugar só ===');
  ok(limits.featureOn(t1, 'campaigns') === true, 'campanhas liberadas por padrão');
  await fetch(BASE + '/api/adm/testers', {
    method: 'PUT', headers: aut,
    body: JSON.stringify({ modulos: { campaigns: false } })
  });
  ok(limits.featureOn(t1, 'campaigns') === false,
     'fechando no painel, fecha para o tester');
  ok(limits.featureOn(t1, 'flows') === true, 'e só aquele — os outros seguem abertos');
  ok(/não faz parte/.test(limits.checkFeature(t1, 'campaigns') || ''),
     'com a mensagem de bloqueio de sempre');

  // E fechar para os testers NÃO mexe em cliente nenhum.
  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cliente', email: 'c@ex.com', pass: 'segredo123' })
  });
  const cli = db.findAccountByEmail('c@ex.com');
  cli.billing.planId = 'plano_caro';
  cli.billing.status = 'active';   // plano ativo é planId + periodEnd + STATUS
  cli.billing.periodEnd = Date.now() + 30 * 86400000;
  db.save();
  ok(limits.featureOn(cli, 'campaigns') === true,
     'o cliente com plano continua com campanhas — a regra dos testers é só deles');
  ok(limits.limitOf(cli, 'sends') === 99999,
     `e com o teto do plano dele: ${limits.limitOf(cli, 'sends')}`);

  console.log('\n=== 5. Os limites de uso são configuráveis ===');
  await fetch(BASE + '/api/adm/testers', {
    method: 'PUT', headers: aut,
    body: JSON.stringify({ limites: { sends: 50, contacts: -1 } })
  });
  ok(limits.limitOf(t1, 'sends') === 50, `disparos apertados para 50: ${limits.limitOf(t1, 'sends')}`);
  ok(limits.limitOf(t1, 'contacts') === -1,
     '-1 vale como ilimitado, que é escolha legítima do admin');

  // Valor sem sentido não vira teto negativo.
  await fetch(BASE + '/api/adm/testers', {
    method: 'PUT', headers: aut, body: JSON.stringify({ limites: { sends: -99 } })
  });
  ok(limits.limitOf(t1, 'sends') === -1,
     `abaixo de -1 é aparado para -1, e não vira teto negativo: ${limits.limitOf(t1, 'sends')}`);
  await fetch(BASE + '/api/adm/testers', {
    method: 'PUT', headers: aut, body: JSON.stringify({ limites: { sends: 200 } })
  });

  console.log('\n=== 6. O limite de QUANTOS é de verdade ===');
  await fetch(BASE + '/api/adm/testers', {
    method: 'PUT', headers: aut, body: JSON.stringify({ limite: 2 })
  });
  const r2 = await fetch(BASE + '/api/adm/testers', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Dois', email: 't2@ex.com', pass: 'segredo123' })
  });
  ok(r2.status === 200, 'o segundo entra');
  const r3 = await fetch(BASE + '/api/adm/testers', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Tres', email: 't3@ex.com', pass: 'segredo123' })
  });
  ok(r3.status === 409, `o terceiro é recusado: ${r3.status}`);
  const err = await r3.json();
  ok(/Limite de 2/.test(err.error), 'com o motivo e a saída: ' + err.error);
  ok(!db.findAccountByEmail('t3@ex.com'), 'e a conta não ficou pela metade no banco');

  // Zero fecha a porta sem apagar quem já entrou.
  await fetch(BASE + '/api/adm/testers', {
    method: 'PUT', headers: aut, body: JSON.stringify({ limite: 0 })
  });
  const r4 = await fetch(BASE + '/api/adm/testers', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ name: 'Quatro', email: 't4@ex.com', pass: 'segredo123' })
  });
  ok(r4.status === 409, 'com limite zero, ninguém novo entra');
  ok(testers.todos().length === 2, 'e os que já existiam continuam de pé');
  await fetch(BASE + '/api/adm/testers', {
    method: 'PUT', headers: aut, body: JSON.stringify({ limite: 5 })
  });

  console.log('\n=== 7. Tester entra no app sem bater na trava de assinatura ===');
  const l1 = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 't1@ex.com', pass: 'segredo123' })
  })).json();
  ok(!!l1.token, 'entra pelo painel do cliente');
  ok(l1.planRequired === false,
     'e NÃO cai na tela de Assinatura — foi convidado para testar de graça');
  const me = await (await fetch(BASE + '/api/me', { headers: { Authorization: 'Bearer ' + l1.token } })).json();
  ok(me.planRequired === false, 'nem no /me');

  // O cliente sem plano, esse sim, precisa assinar.
  // SEM PLANO é planId vazio E status fora de `active`. Só zerar o
  // `periodEnd` não basta: sem data de fim, `planoAtivo` lê como plano
  // perpétuo (é assim que conta sem prazo continua valendo).
  cli.billing.planId = '';
  cli.billing.status = 'canceled';
  cli.billing.periodEnd = 0;
  db.save();
  const l2 = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'c@ex.com', pass: 'segredo123' })
  })).json();
  ok(l2.planRequired === true, 'e um cliente sem plano continua tendo que assinar');

  console.log('\n=== 8. Tester não conta como cliente ===');
  const visaoGeral = await (await fetch(BASE + '/api/adm/vis', { headers: aut })).json()
    .catch(() => null);
  const overview = await (await fetch(BASE + '/api/adm/overview', { headers: aut })).json();
  ok(typeof overview.totais.testers === 'number',
     `os números do painel separam os testers: ${overview.totais.testers}`);
  ok(overview.totais.testers === 2, 'com a conta certa');
  ok(overview.totais.clientes === 1,
     `e o total de clientes conta só quem paga: ${overview.totais.clientes}`);

  console.log('\n=== 9. Promover: vira cliente com o histórico inteiro ===');
  // Recriar do zero perderia os contatos e as conversas do teste, que é
  // justamente o que faz a pessoa querer continuar.
  const store = require(R + 'src/store');
  store.upsertContact(t1, '5511999990001', 'Contato do teste');
  db.save();
  const antesContatos = (t1.contacts || []).length;
  ok(antesContatos >= 1, 'o tester tem um contato criado no teste');

  const prom = await (await fetch(BASE + '/api/adm/testers/' + t1.id + '/promover', {
    method: 'POST', headers: aut, body: '{}'
  })).json();
  ok(prom.ok, 'promovido');
  ok(t1.tester === false, 'deixou de ser tester');
  ok((t1.contacts || []).length === antesContatos, 'e os contatos ficaram todos');
  ok(limits.limitOf(t1, 'sends') !== 200,
     'os limites deixam de ser os de tester — agora ele segue a régua comercial');
  ok(prom.visao.usados === 1, 'e a vaga foi devolvida');

  console.log('\n=== 10. Remover apaga a conta inteira ===');
  const t2 = db.findAccountByEmail('t2@ex.com');
  const rem = await (await fetch(BASE + '/api/adm/testers/' + t2.id, {
    method: 'DELETE', headers: aut
  })).json();
  ok(rem.ok, 'removido');
  ok(!db.findAccountByEmail('t2@ex.com'), 'a conta sumiu do banco');
  ok(rem.visao.usados === 0, 'e a vaga voltou');

  // Remover pelo id de uma conta que NÃO é tester não pode funcionar: seria um
  // "apagar conta de cliente" escondido numa rota de testers.
  const naoTester = await fetch(BASE + '/api/adm/testers/' + cli.id, { method: 'DELETE', headers: aut });
  ok(naoTester.status === 404, `apagar um cliente por esta rota: ${naoTester.status}`);
  ok(!!db.findAccountByEmail('c@ex.com'), 'e o cliente continua lá');

  console.log('\n=== 11. Um cliente não mexe em nada disso ===');
  // O CLIENTE PRECISA TER PLANO ATIVO AQUI. Sem plano, a trava de assinatura
  // responde 402 ANTES do `adminOnly` — ele fica barrado do mesmo jeito, mas o
  // teste estaria medindo a trava errada, e continuaria dando OK mesmo se
  // alguém tirasse o `adminOnly` das rotas.
  cli.billing.planId = 'plano_caro';
  cli.billing.status = 'active';   // plano ativo é planId + periodEnd + STATUS
  cli.billing.periodEnd = Date.now() + 30 * 86400000;
  db.save();
  const l3 = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'c@ex.com', pass: 'segredo123' })
  })).json();
  const cliAut = { Authorization: 'Bearer ' + l3.token, 'Content-Type': 'application/json' };
  for (const [metodo, rota] of [['GET', '/api/adm/testers'], ['PUT', '/api/adm/testers'], ['POST', '/api/adm/testers']]) {
    const r = await fetch(BASE + rota, { method: metodo, headers: cliAut, body: metodo === 'GET' ? undefined : '{}' });
    ok(r.status === 403, `cliente em ${metodo} ${rota} -> ${r.status}`);
  }

  console.log('\n=== 12. A tela existe e está no menu ===');
  const tela = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const menu = fs.readFileSync(R + 'public/adm/index.html', 'utf8');
  ok(menu.includes('data-view="adm/testers"'), 'o menu do painel tem o item');
  ok(/'adm\/testers': renderAdmTesters/.test(tela), 'a rota existe');
  ok(/function admTstPaint/.test(tela), 'e a tela é pintada por função própria');
  ok(/Sem vagas/.test(tela), 'que avisa quando o limite acabou em vez de deixar clicar e falhar');
  ok(/A conta é apagada com tudo o que houver dentro dela/.test(tela),
     'e a remoção diz que é irreversível antes de apagar');

  srv.close();
  await encerrar(srv, falhas);
})();
