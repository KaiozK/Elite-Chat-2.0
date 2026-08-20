// O PLANO RECOMENDADO NA VITRINE.
//
// A página pública mostra "mais escolhido" em um cartão, e quem decide qual é
// o Admin. Duas coisas precisam valer sempre:
//   · a marca é EXCLUSIVA — ligar num plano desliga nos outros. Dois planos
//     "mais escolhidos" fariam a vitrine desempatar por ordem de cadastro, em
//     silêncio, e o admin veria a página recomendar um plano que ele não
//     escolheu;
//   · a marca CHEGA na landing, porque é lá que ela existe para o cliente.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

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

const porta = 3993;
const url = (r) => 'http://127.0.0.1:' + porta + r;

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(url('/api/adm/login'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  ok(!!tok, 'admin entrou');
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
  const criar = (nome, preco) => fetch(url('/api/admin/plans'), {
    method: 'POST', headers: H, body: JSON.stringify({ name: nome, price: preco, periodDays: 30 })
  }).then(r => r.json());
  const marcar = (id, v) => fetch(url('/api/admin/plans/' + id), {
    method: 'PUT', headers: H, body: JSON.stringify({ destaque: v })
  }).then(r => r.json());
  const vitrine = () => fetch(url('/api/public/landing')).then(r => r.json());

  console.log('=== 1. Plano novo nasce sem destaque ===');
  const a = (await criar('Starter', '97,00')).plan;
  const b = (await criar('Premium', '197,00')).plan;
  const c = (await criar('Business', '397,00')).plan;
  ok(a && b && c, 'três planos criados');
  ok(!a.destaque && !b.destaque && !c.destaque, 'nenhum vem marcado de fábrica');

  console.log('=== 2. Marcar um plano ===');
  await marcar(b.id, true);
  let planos = (await vitrine()).planos;
  const marcados = planos.filter(p => p.destaque).map(p => p.nome);
  ok(marcados.length === 1 && marcados[0] === 'Premium', 'só o Premium está marcado: ' + JSON.stringify(marcados));

  console.log('=== 3. Marcar OUTRO desmarca o primeiro ===');
  await marcar(c.id, true);
  planos = (await vitrine()).planos;
  const agora = planos.filter(p => p.destaque).map(p => p.nome);
  ok(agora.length === 1, 'continua sendo um só: ' + agora.length);
  ok(agora[0] === 'Business', 'e é o último marcado: ' + agora[0]);

  console.log('=== 4. Desmarcar deixa a vitrine sem recomendação ===');
  await marcar(c.id, false);
  planos = (await vitrine()).planos;
  ok(!planos.some(p => p.destaque), 'nenhum plano recomendado');

  console.log('=== 5. A vitrine entrega o que a página precisa para montar o cartão ===');
  const pl = planos.find(p => p.nome === 'Premium');
  ok(pl.preco === 19700, 'preço em centavos: ' + pl.preco);
  ok(pl.dias === 30, 'ciclo em dias: ' + pl.dias);
  ok(Array.isArray(pl.itens) && pl.itens.length > 0, 'itens do cartão: ' + (pl.itens || []).length);
  ok(typeof pl.destaque === 'boolean', 'destaque vem como booleano');

  srv.close();
  encerrar(falhas);
})();
