// ============================================================================
// UMA CONTA NÃO ENXERGA A OUTRA
//
// É o pior defeito possível num SaaS multi-inquilino: o cliente A vendo a
// carteira, os contatos ou as conversas do cliente B. Não quebra nada, não dá
// erro, e quando alguém percebe já é tarde.
//
// O padrão do Koonfy é sólido — `req.acc` vem da sessão, e quase toda rota
// procura o recurso DENTRO dele. Este teste existe para o dia em que alguém
// escrever `db.findAccount(req.params.id)` numa rota nova sem `adminOnly`, ou
// procurar uma cobrança pelo id em TODAS as contas em vez de na própria.
//
// Aqui a conta B tenta, com o token dela, alcançar tudo que é da conta A: os
// contatos, as conversas, as cobranças, a carteira, os fluxos, os links. Cada
// tentativa tem de dar 403, 404 ou vir vazia — nunca o dado.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs'), path = require('path');

const ARQ = path.join(R, 'data', 'db.json');
const original = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
const devolver = () => { try { if (original) fs.writeFileSync(ARQ, original); } catch {} };
process.on('exit', devolver);
process.on('uncaughtException', e => { devolver(); console.error(e); process.exit(1); });

const db = require(R + 'src/db');
const express = require(R + 'node_modules/express');
const BASE = 'http://127.0.0.1:3993';

(async () => {
  db.load();
  const d = db.get();
  d.accounts.length = 0;
  d.platform.billing.requirePlan = false;
  db.save();

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3993);
  await new Promise(r => setTimeout(r, 200));

  const criar = async (nome, email) => {
    await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nome, email, pass: 'segredo123',
        profile: { phone: '11988887777', country: 'BR' }, recebimento: { document: '39053344705' } }) });
    const l = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: email, pass: 'segredo123' }) })).json();
    const acc = db.findAccountByEmail(email);
    acc.billing.status = 'active'; acc.billing.periodEnd = Date.now() + 30 * 864e5;
    return { token: l.token, acc };
  };

  const A = await criar('Loja A', 'a@ex.com');
  const B = await criar('Loja B', 'b@ex.com');

  // ---- A tem dados: contato, conversa, cobrança, carteira, link ----
  const store = require(R + 'src/store');
  const SEGREDO = '5511900001111';
  store.upsertContact(A.acc, SEGREDO, 'Cliente Secreto de A');
  store.addMessage(A.acc, { waId: SEGREDO, direction: 'in', text: 'segredo comercial de A', timestamp: Date.now() });
  A.acc.wallet.balance = 777700;
  A.acc.pagamentos = A.acc.pagamentos || {};
  A.acc.pagamentos.charges = [{ id: 'ch_segredo_de_A', value: 50000, status: 'paid', platformCut: 2500, comment: 'venda de A' }];
  A.acc.flows = [{ id: 'fl_de_A', name: 'Fluxo secreto de A', nodes: [], enabled: true }];
  A.acc.links = [{ id: 'lk_de_A', slug: 'so-de-a', url: 'https://a.com', clicks: 42 }];
  db.save();

  const comoB = (p, opts = {}) => fetch(BASE + '/api' + p, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + B.token },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const vazou = (txt) => /Cliente Secreto de A|segredo comercial de A|venda de A|Fluxo secreto de A|so-de-a|777700/.test(txt);

  console.log('=== 1. B pede as CONVERSAS e os CONTATOS ===');
  for (const rota of ['/conversations', '/contacts', '/messages/' + SEGREDO]) {
    const r = await comoB(rota);
    const t = await r.text();
    ok(!vazou(t), `${rota} não devolve nada de A`, `HTTP ${r.status}`);
  }

  console.log('\n=== 2. B pede a COBRANÇA de A pelo id ===');
  for (const rota of ['/pagamentos/charges/ch_segredo_de_A', '/pagamentos/charge/ch_segredo_de_A']) {
    const r = await comoB(rota);
    const t = await r.text();
    ok(!vazou(t), `${rota} não devolve a venda de A`, `HTTP ${r.status}`);
  }

  console.log('\n=== 3. B pede a CARTEIRA e vê a dele, não a de A ===');
  const w = await (await comoB('/wallet/summary')).json();
  ok(w.balance === 0, 'o saldo que B vê é o de B', 'R$ ' + ((w.balance || 0) / 100).toFixed(2));
  const bill = await (await comoB('/billing')).text();
  ok(!vazou(bill), 'e a tela de assinatura não vaza o saldo de A');

  console.log('\n=== 4. B tenta ALTERAR o que é de A ===');
  for (const [rota, corpo] of [
    ['/flows/fl_de_A', { name: 'sequestrado' }],
    ['/links/lk_de_A', { url: 'https://roubado.com' }]
  ]) {
    const r = await comoB(rota, { method: 'PUT', body: corpo });
    ok(r.status === 404 || r.status === 403, `PUT ${rota} é recusado`, 'HTTP ' + r.status);
  }
  const flA = A.acc.flows.find(f => f.id === 'fl_de_A');
  ok(flA && flA.name === 'Fluxo secreto de A', 'e o fluxo de A continua intacto', flA && flA.name);
  const lkA = A.acc.links.find(l => l.id === 'lk_de_A');
  ok(lkA && lkA.url === 'https://a.com', 'e o link de A também', lkA && lkA.url);

  console.log('\n=== 5. B tenta APAGAR o que é de A ===');
  // Apagar o que não é seu é NO-OP, e o 200 aqui não é falha: a rota filtra
  // `req.acc.flows`, então B apaga da lista DELE — que está vazia. O 200 não
  // conta nada ao invasor (dá 200 exista ou não), e o que importa é o depois:
  // o dado de A tem de continuar de pé.
  for (const rota of ['/flows/fl_de_A', '/links/lk_de_A', '/contacts/' + SEGREDO]) {
    const r = await comoB(rota, { method: 'DELETE' });
    ok(r.status < 500, `DELETE ${rota} não explode`, 'HTTP ' + r.status);
  }
  ok(A.acc.flows.length === 1 && A.acc.links.length === 1, 'e NADA de A foi apagado');
  ok(A.acc.contacts.some(c => c.waId === SEGREDO), 'o contato de A continua lá');
  ok(A.acc.messages.some(m => m.waId === SEGREDO), 'e as mensagens dele também');

  console.log('\n=== 6. B tenta entrar pela porta do ADMIN ===');
  // Os nomes são os que existem de verdade — pedir uma rota inexistente daria
  // 404 e passaria por engano, provando nada.
  for (const rota of ['/admin/saas', '/adm/users', '/adm/overview', '/adm/financeiro',
                      '/adm/kyc', '/adm/contacts', '/admin/pagamentos', '/admin/modulos']) {
    const r = await comoB(rota);
    ok(r.status === 401 || r.status === 403, `${rota} recusa quem não é admin`, 'HTTP ' + r.status);
  }

  console.log('\n=== 7. B tenta virar admin sozinho ===');
  // O corpo do pedido não pode conceder poder: a sessão é que decide.
  const esc = await comoB('/account', { method: 'PUT', body: { isAdmin: true, unlimited: true, role: 'admin' } });
  await esc.text();
  const bDepois = db.findAccountByEmail('b@ex.com');
  ok(!bDepois.isAdmin, 'mandar isAdmin no corpo não torna ninguém admin');
  ok(!bDepois.unlimited, 'nem unlimited');
  const r2 = await comoB('/admin/saas');
  ok(r2.status === 401 || r2.status === 403, 'e a porta do admin continua fechada', 'HTTP ' + r2.status);

  d.accounts.length = 0;
  db.save();
  devolver();
  await encerrar(srv, falhas);
})();
