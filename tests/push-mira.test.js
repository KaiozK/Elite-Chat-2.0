// O TESTE DE NOTIFICAÇÃO ACERTA UM APARELHO SÓ.
//
// Antes ele saía para todos os inscritos da conta: quem tem o painel aberto no
// computador, no celular e no tablet recebia três vendas falsas por toque, e
// num time o atendente recebia no meio do expediente uma venda que não
// existiu. Teste que incomoda os outros deixa de ser usado — e a cadeia de push
// volta a ser testada só quando quebra, que é tarde.
//
// E o teste de venda passa a mandar o texto REAL dos dois avisos que uma venda
// dispara (o do lojista e o da plataforma), em vez de um terceiro texto que não
// é nenhum dos dois.
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

// O SERVIÇO DE PUSH é substituído por um espião: o que interessa aqui não é se
// o Google entregou, é PARA QUANTOS endereços o servidor tentou entregar.
const enviados = [];
const httpsReal = require('https');
Module._load = function (p) {
  if (p === 'mysql2/promise') return { createPool: () => pool };
  return origLoad.apply(this, arguments);
};
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

const db = require(R + 'src/db');
const push = require(R + 'src/push');

// Troca o CARTEIRO, e só ele: as chamadas ao serviço de push (push.exemplo)
// viram uma linha na lista; qualquer outra — inclusive as que este teste faz
// contra o próprio servidor — segue para o fetch de verdade.
const antesFetch = global.fetch;
global.fetch = async (url, opts) => {
  const u = String(url && url.url ? url.url : url);
  if (u.startsWith('https://push.exemplo/')) {
    enviados.push(u);
    return { status: 201, ok: true, text: async () => '' };
  }
  return antesFetch(url, opts);
};

const BASE = 'http://127.0.0.1:3989';
(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3989);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
  ok(!!login.token, 'admin entrou');

  // Três aparelhos inscritos na mesma conta: computador, celular e tablet.
  const acc = db.get().accounts.find(a => a.isAdmin) || db.get().accounts[0];
  // A CHAVE PRECISA SER UMA CHAVE. Com um texto qualquer no p256dh a
  // criptografia falha antes de qualquer envio, e o teste mediria zero sem
  // medir nada. Esta é um par P-256 de verdade, gerado na hora.
  const crypto = require('crypto');
  const ec = crypto.createECDH('prime256v1'); ec.generateKeys();
  const chave = { p256dh: ec.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  acc.pushSubs = [
    { endpoint: 'https://push.exemplo/computador', keys: chave, prefs: {} },
    { endpoint: 'https://push.exemplo/celular', keys: chave, prefs: {} },
    { endpoint: 'https://push.exemplo/tablet', keys: chave, prefs: {} }
  ];
  // Sem taxa configurada a comissão do aviso da plataforma é zero — e um teste
  // que confere "R$ 0,00" não confere nada.
  const ep = require(R + 'src/elitepay');
  ep.platformCfg().feeInPercent = 5;
  db.save();

  console.log('\n=== 1. Sem mira, o aviso vai para todos (comportamento antigo) ===');
  enviados.length = 0;
  await fetch(BASE + '/api/push/test-sale', {
    method: 'POST', headers: aut, body: JSON.stringify({ amount: 10000 })
  });
  ok(enviados.length === 3, `três aparelhos, três envios: ${enviados.length}`);

  console.log('\n=== 2. Com o endereço do aparelho, só ele toca ===');
  enviados.length = 0;
  const r = await (await fetch(BASE + '/api/push/test-sale', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ amount: 10000, endpoint: 'https://push.exemplo/celular' })
  })).json();
  ok(enviados.length === 1, `um envio, e não três: ${enviados.length}`);
  ok(/celular/.test(enviados[0] || ''), `e foi para o celular: ${enviados[0]}`);
  ok(r.sent === 1, `a resposta confirma um aparelho: ${r.sent}`);

  console.log('\n=== 3. O texto é o REAL de cada aviso ===');
  // Uma venda dispara dois avisos diferentes. Testar um texto inventado provaria
  // que o push chega, e não que o aviso está certo.
  const doLojista = await (await fetch(BASE + '/api/push/test-sale', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ amount: 100000, kind: 'venda', endpoint: 'https://push.exemplo/celular' })
  })).json();
  ok(doLojista.titulo === 'Venda Aprovada', `título do lojista: "${doLojista.titulo}"`);
  //  usa espaço NÃO separável depois do R$; comparar com um
  // espaço comum falharia sem nada estar errado.
  const semNbsp = t => String(t || '').replace(/ /g, ' ');
  ok(semNbsp(doLojista.corpo) === 'Valor: R$ 1.000,00', `corpo do lojista: "${doLojista.corpo}"`);

  const daPlataforma = await (await fetch(BASE + '/api/push/test-sale', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ amount: 100000, kind: 'comissao', endpoint: 'https://push.exemplo/celular' })
  })).json();
  ok(daPlataforma.titulo === 'Venda aprovada', `título da plataforma: "${daPlataforma.titulo}"`);
  // 5% de R$ 1.000,00 — a taxa configurada acima. O valor sai da mesma conta
  // que a venda de verdade usa, e não de um número escrito à mão aqui.
  ok(semNbsp(daPlataforma.corpo) === 'Sua comissão: R$ 50,00', `corpo da plataforma: "${daPlataforma.corpo}"`);

  console.log('\n=== 4. Endereço que não é desta conta não acorda ninguém ===');
  // Um endpoint de outra conta (ou inventado) não pode virar um envio para
  // todos por falta de correspondência.
  enviados.length = 0;
  const zero = await (await fetch(BASE + '/api/push/test-sale', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ amount: 10000, endpoint: 'https://push.exemplo/de-outra-pessoa' })
  })).json();
  ok(enviados.length === 0, `nenhum envio: ${enviados.length}`);
  ok(zero.sent === 0, 'e a tela recebe zero, para poder avisar que este aparelho não está inscrito');

  srv.close();
  global.fetch = antesFetch;
  await encerrar(srv, falhas);
})();
