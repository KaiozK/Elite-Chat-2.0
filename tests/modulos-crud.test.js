// ============================================================================
// OS MÓDULOS QUE NÃO TINHAM TESTE NENHUM
//
// Links, pixels, agenda, fluxos e atendentes: cinco telas inteiras do produto
// sem uma linha de verificação. Este arquivo percorre cada uma no caminho que
// o cliente faz — criar, listar, editar, apagar — e nos três lugares onde
// esse caminho costuma vazar:
//
//   · O LIMITE DO PLANO é conferido no servidor? (o menu esconder não basta:
//     a rota é chamável na mão, e um plano de 1 link que aceita 50 é receita
//     que a plataforma deixou de cobrar)
//   · A ENTRADA INVÁLIDA é recusada, ou vira registro quebrado no banco?
//   · O DADO É DA CONTA? Editar pelo id sem conferir de quem ele é deixa uma
//     conta mexer na outra — e esse é o defeito que não se descobre até
//     acontecer com um cliente.
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

const db = require(R + 'src/db');

const BASE = 'http://127.0.0.1:4002';
const json = r => r.json();

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(4002);
  await new Promise(r => setTimeout(r, 150));

  // Um plano com TETO BAIXO de propósito: é assim que o limite aparece.
  db.get().plans.push({
    id: 'pro', name: 'Pro', price: 19700, periodDays: 30,
    limits: { links: 2, pixels: 1, flows: 1, sends: -1, campaigns: -1, contacts: -1, whatsapps: 1 },
    modules: {}
  });
  db.get().platform.billing.requirePlan = false;
  db.save();

  const criarConta = async (nome, email) => {
    await fetch(BASE + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: nome, email, pass: 'segredo123',
        profile: { phone: '1198888' + Math.floor(1000 + Math.random() * 8999), country: 'BR' },
        recebimento: { document: email === 'a@ex.com' ? '39053344705' : '11144477735' }
      })
    });
    const a = db.findAccountByEmail(email);
    a.billing.status = 'active'; a.billing.planId = 'pro';
    a.billing.periodEnd = Date.now() + 30 * 86400000;
    db.save();
    const e = await json(await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: email, pass: 'segredo123' })
    }));
    return { acc: a, cab: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + e.token } };
  };

  const A = await criarConta('Loja A', 'a@ex.com');
  const B = await criarConta('Loja B', 'b@ex.com');
  const post = (cab, rota, corpo) => fetch(BASE + '/api' + rota, { method: 'POST', headers: cab, body: JSON.stringify(corpo) });
  const put = (cab, rota, corpo) => fetch(BASE + '/api' + rota, { method: 'PUT', headers: cab, body: JSON.stringify(corpo) });
  const del = (cab, rota) => fetch(BASE + '/api' + rota, { method: 'DELETE', headers: cab });

  // ==========================================================================
  console.log('=== 1. LINKS RASTREÁVEIS ===');
  // ==========================================================================
  const ruim = await post(A.cab, '/links', { title: 'X', dest: 'isso não é url' });
  ok(ruim.status === 400, `destino inválido é recusado: ${ruim.status}`);

  const l1 = await json(await post(A.cab, '/links', { title: 'Promo', dest: 'loja.com/promo', slug: 'promo' }));
  ok(!!l1.link && l1.link.slug === 'promo', 'o link nasce com o apelido pedido');
  // SEM https:// na entrada, o servidor completa: um link salvo sem esquema
  // vira 404 no clique, e o cliente só descobre pelo anúncio que não converte.
  ok(/^https:\/\//.test(A.acc.links[0].dest), 'e a URL ganha o https: ' + A.acc.links[0].dest);

  const repetido = await post(A.cab, '/links', { title: 'Outro', dest: 'loja.com/x', slug: 'promo' });
  ok(repetido.status === 409, `apelido repetido é recusado: ${repetido.status}`);

  // O TETO DO PLANO é 2. O terceiro tem de bater na parede — no SERVIDOR.
  await post(A.cab, '/links', { title: 'Dois', dest: 'loja.com/dois' });
  const terceiro = await post(A.cab, '/links', { title: 'Três', dest: 'loja.com/tres' });
  ok(terceiro.status === 402, `o teto do plano é conferido no servidor: ${terceiro.status}`);
  ok((await terceiro.json()).code === 'limit', 'com o código do motivo');

  const lista = await json(await fetch(BASE + '/api/links', { headers: A.cab }));
  ok(lista.links.length === 2, `a lista traz os dois: ${lista.links.length}`);

  // DE OUTRA CONTA, NÃO. É o defeito que só se descobre acontecendo com um
  // cliente: apagar pelo id sem conferir o dono.
  const alheio = await del(B.cab, '/links/' + A.acc.links[0].id);
  ok(alheio.status >= 400, `apagar link de outra conta é recusado: ${alheio.status}`);
  ok(A.acc.links.length === 2, 'e o link continua lá');

  const editado = await put(A.cab, '/links/' + A.acc.links[0].id, { title: 'Promo nova' });
  ok(editado.status === 200, 'editar o próprio funciona');
  ok(A.acc.links[0].title === 'Promo nova', 'e grava: ' + A.acc.links[0].title);

  ok((await del(A.cab, '/links/' + A.acc.links[1].id)).status === 200, 'apagar o próprio funciona');
  ok(A.acc.links.length === 1, 'e some da conta');

  // ==========================================================================
  console.log('\n=== 2. PIXELS ===');
  // ==========================================================================
  const tipoRuim = await post(A.cab, '/pixels', { type: 'orkut', pixelId: '123' });
  ok(tipoRuim.status === 400, `tipo desconhecido é recusado: ${tipoRuim.status}`);
  const semId = await post(A.cab, '/pixels', { type: 'meta' });
  ok(semId.status === 400, 'e sem o ID do pixel também');

  const px = await json(await post(A.cab, '/pixels', { type: 'meta', pixelId: '999', name: 'Meta principal' }));
  ok(!!px.pixel && px.pixel.type === 'meta', 'o pixel nasce');
  const px2 = await post(A.cab, '/pixels', { type: 'gtag', pixelId: 'G-1' });
  ok(px2.status === 402, `e o teto de 1 do plano segura o segundo: ${px2.status}`);

  ok((await del(A.cab, '/pixels/' + px.pixel.id)).status === 200, 'apagar funciona');
  ok(A.acc.pixels.length === 0, 'e o pixel some');

  // ==========================================================================
  console.log('\n=== 3. AGENDA ===');
  // ==========================================================================
  const ag = await json(await post(A.cab, '/schedules', {
    title: 'Reunião', start: Date.now() + 86400000, durationMin: 30
  }));
  const idAg = (ag.event || ag.schedule || ag).id;
  ok(!!idAg, 'o agendamento nasce');
  ok((A.acc.schedules || []).length === 1, 'e entra na conta');

  const dupAg = await post(A.cab, '/schedules/' + idAg + '/duplicate', {});
  ok(dupAg.status === 200, 'duplicar funciona');
  ok((A.acc.schedules || []).length === 2, `e vira dois: ${(A.acc.schedules || []).length}`);

  const agAlheio = await del(B.cab, '/schedules/' + idAg);
  ok(agAlheio.status >= 400, `apagar agendamento de outra conta é recusado: ${agAlheio.status}`);
  ok((A.acc.schedules || []).length === 2, 'e ele continua lá');

  ok((await del(A.cab, '/schedules/' + idAg)).status === 200, 'apagar o próprio funciona');

  // ==========================================================================
  console.log('\n=== 4. FLUXOS (Flow Builder) ===');
  // ==========================================================================
  const f1 = await json(await post(A.cab, '/flows', { name: 'Boas-vindas', nodes: [], edges: [] }));
  const idF = (f1.flow || f1).id;
  ok(!!idF, 'o fluxo nasce');
  const f2 = await post(A.cab, '/flows', { name: 'Segundo', nodes: [], edges: [] });
  ok(f2.status === 402, `o teto de 1 fluxo do plano segura o segundo: ${f2.status}`);

  const fAlheio = await put(B.cab, '/flows/' + idF, { name: 'Invadido' });
  ok(fAlheio.status >= 400, `editar fluxo de outra conta é recusado: ${fAlheio.status}`);
  ok((A.acc.flows[0] || {}).name === 'Boas-vindas', 'e o nome não muda: ' + (A.acc.flows[0] || {}).name);

  ok((await del(A.cab, '/flows/' + idF)).status === 200, 'apagar o próprio funciona');

  // ==========================================================================
  console.log('\n=== 5. ATENDENTES ===');
  // ==========================================================================
  const semNome = await post(A.cab, '/agents', { email: 'x@ex.com' });
  ok(semNome.status === 400, `atendente sem nome é recusado: ${semNome.status}`);

  const senhaCurta = await post(A.cab, '/agents', { name: 'Ana', email: 'ana@ex.com', pass: '123' });
  ok(senhaCurta.status === 400, 'senha curta é recusada');

  const ag1 = await json(await post(A.cab, '/agents', { name: 'Ana', email: 'ana@ex.com', pass: 'segredo123' }));
  ok(!!(ag1.agent || ag1).id, 'o atendente nasce');
  ok((A.acc.team || []).length === 1, 'e entra na equipe');

  // E-MAIL DE CONTA NÃO VIRA ATENDENTE: seriam dois logins com o mesmo e-mail
  // e poderes diferentes, e a porta decidiria qual vale.
  const emailDeConta = await post(A.cab, '/agents', { name: 'Dono', email: 'b@ex.com', pass: 'segredo123' });
  ok(emailDeConta.status === 409, `e-mail que já é conta é recusado: ${emailDeConta.status}`);

  const repetidoAg = await post(A.cab, '/agents', { name: 'Ana 2', email: 'ana@ex.com', pass: 'segredo123' });
  ok(repetidoAg.status === 409, 'e-mail repetido de atendente é recusado');

  // ==========================================================================
  console.log('\n=== 6. O que uma conta vê é SÓ o dela ===');
  // ==========================================================================
  // A pergunta que amarra tudo: com duas contas no mesmo servidor, uma lista
  // que não filtra por dono entrega dado de cliente para cliente.
  const linksB = await json(await fetch(BASE + '/api/links', { headers: B.cab }));
  ok(linksB.links.length === 0, `a conta B não vê os links da A: ${linksB.links.length}`);
  const agB = await json(await fetch(BASE + '/api/schedules', { headers: B.cab }));
  ok(((agB.events || agB.schedules || [])).length === 0, 'nem a agenda');
  const teamB = await json(await fetch(BASE + '/api/agents', { headers: B.cab }));
  ok(((teamB.agents || [])).length === 0, 'nem os atendentes');

  // ==========================================================================
  console.log('\n=== 7. QUEM SÓ PODE VER não edita nem apaga ===');
  // ==========================================================================
  // Links e pixels estavam sem guarda de permissão nas rotas de editar e
  // apagar — só exigiam sessão. Todo módulo vizinho tem a guarda: a agenda
  // exige can('schedule','delete'), o fluxo exige can('flows','edit'). Aqui um
  // atendente com acesso de LEITURA editava e apagava, e o menu escondendo o
  // botão não protege nada: a rota é chamável na mão.
  const soVer = await json(await post(A.cab, '/agents', {
    name: 'Só Leitura', email: 'leitura@ex.com', pass: 'segredo123',
    permissions: { links: { view: true, create: false, edit: false, delete: false },
                   pixels: { view: true, create: false, edit: false, delete: false } }
  }));
  ok(!!(soVer.agent || soVer).id, 'o atendente de leitura nasce');

  const entL = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'leitura@ex.com', pass: 'segredo123' })
  }));
  ok(!!entL.token, 'e consegue entrar');
  const cabL = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + entL.token };

  const linkDaConta = A.acc.links[0];
  ok(!!linkDaConta, 'há um link para tentar mexer');

  const verOk = await fetch(BASE + '/api/links', { headers: cabL });
  ok(verOk.status === 200, `ver a lista continua permitido: ${verOk.status}`);

  const editarNao = await put(cabL, '/links/' + linkDaConta.id, { title: 'Mexido' });
  ok(editarNao.status === 403, `editar é recusado: ${editarNao.status}`);
  ok(A.acc.links[0].title !== 'Mexido', 'e o título não muda: ' + A.acc.links[0].title);

  const apagarNao = await del(cabL, '/links/' + linkDaConta.id);
  ok(apagarNao.status === 403, `apagar é recusado: ${apagarNao.status}`);
  ok(A.acc.links.length === 1, 'e o link continua lá');

  const pxDaConta = await json(await post(A.cab, '/pixels', { type: 'meta', pixelId: '777' }));
  const pxEditar = await put(cabL, '/pixels/' + pxDaConta.pixel.id, { name: 'Mexido' });
  ok(pxEditar.status === 403, `no pixel também: ${pxEditar.status}`);
  const pxApagar = await del(cabL, '/pixels/' + pxDaConta.pixel.id);
  ok(pxApagar.status === 403, 'apagar pixel idem');
  ok(A.acc.pixels.length === 1, 'e o pixel continua lá');

  srv.close();
  await encerrar(null, falhas);
})();
