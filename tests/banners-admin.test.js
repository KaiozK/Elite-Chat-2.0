// A COPY DOS BANNERS SAI DO CÓDIGO E VAI PARA O ADMIN.
//
// Enquanto a frase morava no app.js, trocar a copy de uma campanha custava um
// deploy — e o que custa um deploy ninguém troca. Este teste cobre o que a
// mudança tem de arriscado, que não é o formulário: é o que chega no painel do
// CLIENTE.
//
//   · o desligado não pode vazar. Banner desativado é campanha que acabou ou
//     ainda não começou, e mandar isso para o navegador é entregar plano de
//     marketing por DevTools;
//   · o link tem que ser interno. Um `href` livre no Admin seria um jeito de
//     mandar todo cliente do produto para fora dele;
//   · a arte tem que existir. Um nome errado viraria um 404 e um cartão preto
//     no topo da tela de quem está trabalhando.
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

const db = require(R + 'src/db');
const BASE = 'http://127.0.0.1:3982';

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3982);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  // Uma conta de cliente, para conferir o que ELA recebe.
  const cliente = db.newAccount({ name: 'Loja da Bia', email: 'bia@loja.com', pass: 'segredo123' });
  cliente.billing.status = 'active';
  cliente.billing.periodEnd = Date.now() + 30 * 86400000;
  db.get().accounts.push(cliente);
  db.save();
  const entrar = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'bia@loja.com', pass: 'segredo123' })
  })).json();
  const autCliente = { Authorization: 'Bearer ' + entrar.token };

  console.log('=== 1. Os banners nascem prontos, e não vazios ===');
  // Instalação nova com a faixa em branco seria um buraco no topo da dashboard
  // até alguém descobrir a tela do Admin.
  const inicial = await (await fetch(BASE + '/api/admin/banners', { headers: aut })).json();
  ok(inicial.banners.length === 5, `cinco banners de fábrica: ${inicial.banners.length}`);
  ok(inicial.artes.length >= 5, `com o catálogo de artes: ${inicial.artes.length}`);
  ok(inicial.banners.every(b => b.titulo && b.arte), 'todos com título e arte');

  console.log('\n=== 2. A copy digitada no Admin chega no cliente ===');
  const lista = inicial.banners.map(b => ({ ...b }));
  lista[0].titulo = 'Frase nova sem deploy';
  lista[0].texto = 'Trocada no Admin, no ar na hora.';
  lista[1].ativo = false;                       // desligado, não apagado
  const salvo = await (await fetch(BASE + '/api/admin/banners', {
    method: 'PUT', headers: aut, body: JSON.stringify({ banners: lista })
  })).json();
  ok(salvo.ok === true, 'o Admin salva');

  const doCliente = await (await fetch(BASE + '/api/banners', { headers: autCliente })).json();
  ok(doCliente.banners[0].titulo === 'Frase nova sem deploy',
     `o cliente vê a frase nova: "${doCliente.banners[0].titulo}"`);

  console.log('\n=== 3. O desligado NÃO vai para o navegador do cliente ===');
  ok(doCliente.banners.length === 4, `quatro no ar, e não cinco: ${doCliente.banners.length}`);
  ok(!doCliente.banners.some(b => /Ligue de dentro/.test(b.titulo)),
     'o desligado não aparece nem escondido na resposta');
  // e continua guardado, para poder voltar
  const noAdmin = await (await fetch(BASE + '/api/admin/banners', { headers: aut })).json();
  ok(noAdmin.banners.length === 5, 'mas continua no Admin, para a campanha poder voltar');

  console.log('\n=== 4. A arte vem junto, com as medidas do arquivo ===');
  // Sem `pw`/`ph` a peça nasce sem largura e pula quando a imagem carrega.
  const primeiro = doCliente.banners[0];
  ok(!!primeiro.fundo && !!primeiro.peca, `os dois arquivos: ${primeiro.fundo} / ${primeiro.peca}`);
  ok(primeiro.pw > 0 && primeiro.ph > 0, `com as medidas reais: ${primeiro.pw}x${primeiro.ph}`);

  console.log('\n=== 5. O que o Admin não pode escrever ===');
  const ruim = await (await fetch(BASE + '/api/admin/banners', {
    method: 'PUT', headers: aut, body: JSON.stringify({ banners: [
      { titulo: 'Link para fora', arte: 'vender', href: 'https://outro-site.com', acao: 'Ir', tag: '', texto: 'x' },
      { titulo: 'Arte inventada', arte: 'nao-existe', href: '#/inbox', acao: 'Ir', tag: '', texto: 'x' },
      { titulo: '', arte: 'vender', href: '#/inbox', acao: 'Ir', tag: '', texto: 'sem título' }
    ] })
  })).json();
  ok(ruim.banners.length === 2, `o sem título é descartado: ${ruim.banners.length} de 3`);
  ok(ruim.banners[0].href === '#/dashboard', `endereço externo vira interno: ${ruim.banners[0].href}`);
  ok(ruim.banners[1].arte !== 'nao-existe', `arte inexistente cai numa que existe: ${ruim.banners[1].arte}`);

  console.log('\n=== 6. Quem pode mexer ===');
  const semAdmin = await fetch(BASE + '/api/admin/banners', { headers: autCliente });
  ok(semAdmin.status === 403, `o cliente não abre a tela do Admin: ${semAdmin.status}`);
  const semSessao = await fetch(BASE + '/api/banners');
  ok(semSessao.status === 401, `e a lista do painel exige sessão: ${semSessao.status}`);

  srv.close();
  await encerrar(srv, falhas);
})();
