// O LIMITE DIÁRIO DE CONVERSAS, EM CONEXÃO & API.
//
// `messaging_limit_tier` é o teto de conversas NOVAS por 24h que a Meta impõe à
// conta. É o número que se confere ANTES de um disparo — e o único daquela tela
// que muda sozinho, quando a Meta promove a conta de faixa.
//
// Ele estava quebrado em dois pontos ao mesmo tempo, e por isso não adiantava
// clicar em "Atualizar dados":
//
//   1. A ROTA DO BOTÃO NÃO GRAVAVA. /wa/status?health=1 pedia o campo à Meta
//      (getPhoneInfo já o inclui), recebia, e usava só número, nome e
//      qualidade. O teto era descartado. Quem gravava era apenas o caminho de
//      sincronização, que tem cache de 6 horas — então o valor da tela era o de
//      horas atrás, e o botão dizia "Dados atualizados" mesmo assim.
//
//   2. E NÃO SAÍA DO SERVIDOR. Nem waPublic nem channelPublic devolviam o
//      campo, então a tela lia `w.messagingTier` de um objeto que nunca o teve.
//      Sozinho, este segundo defeito já bastava: o "Limite diário" mostrava
//      para sempre "clique em Atualizar dados", por mais que se clicasse.
//
// Um teste que só checasse a gravação passaria com a tela ainda quebrada. Por
// isso aqui se verifica o CAMINHO INTEIRO: a Meta responde, o servidor grava, e
// o valor chega em quem desenha.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

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
const wa = require(R + 'src/whatsapp');
const BASE = 'http://127.0.0.1:3977';

(async () => {
  await db.loadAsync();

  const acc = db.newAccount({ name: 'Loja', email: 'lim@teste.com', pass: 'segredo123' });
  acc.billing.status = 'active';
  acc.billing.periodEnd = Date.now() + 30 * 86400000;
  acc.wa.connected = true;
  acc.wa.phoneNumberId = '111';
  acc.wa.accessToken = 'TOKEN';
  acc.wa.displayPhoneNumber = '+55 11 90000-0000';
  acc.wa.messagingTier = 'TIER_1K';        // o que estava gravado antes
  db.get().accounts.push(acc);
  db.save();

  // A Meta é simulada: o que se testa é o caminho do Koonfy até a tela. A conta
  // acabou de ser PROMOVIDA — é exatamente o caso em que a tela precisa mudar.
  wa.getPhoneInfo = async () => ({
    display_phone_number: '+55 11 90000-0000',
    verified_name: 'Loja',
    quality_rating: 'GREEN',
    messaging_limit_tier: 'TIER_10K',
    throughput: { level: 'HIGH' }
  });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3977);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'lim@teste.com', pass: 'segredo123' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token };

  console.log('=== 1. O campo SAI do servidor ===');
  // Sem isto, nada mais importa: a tela lê `w.messagingTier`, e um objeto sem o
  // campo faz o "Limite diário" dizer "clique em Atualizar dados" para sempre.
  const antes = await (await fetch(BASE + '/api/wa/status', { headers: aut })).json();
  ok('messagingTier' in antes.wa, 'waPublic devolve messagingTier');
  ok(antes.wa.messagingTier === 'TIER_1K', `com o valor gravado: ${antes.wa.messagingTier}`);
  ok('throughput' in antes.wa, 'e o throughput junto');

  console.log('\n=== 2. O botão "Atualizar dados" GRAVA o que a Meta respondeu ===');
  const depois = await (await fetch(BASE + '/api/wa/status?health=1', { headers: aut })).json();
  ok(depois.wa.messagingTier === 'TIER_10K',
     `a promoção aparece na mesma resposta: ${depois.wa.messagingTier}`);
  ok(db.findAccount(acc.id).wa.messagingTier === 'TIER_10K',
     'e fica gravada, não só nesta resposta');
  ok(db.findAccount(acc.id).wa.throughput === 'HIGH', 'o throughput também');
  ok(depois.wa.qualityRating === 'GREEN', 'sem estragar o que já funcionava');

  console.log('\n=== 3. Uma resposta sem o campo não apaga o que havia ===');
  // A Graph omite campo quando não tem valor. Sobrescrever com vazio faria a
  // tela piscar de "10.000 conversas" para "clique em Atualizar dados".
  wa.getPhoneInfo = async () => ({ display_phone_number: '+55 11 90000-0000', verified_name: 'Loja' });
  const semCampo = await (await fetch(BASE + '/api/wa/status?health=1', { headers: aut })).json();
  ok(semCampo.wa.messagingTier === 'TIER_10K', `o valor anterior continua: ${semCampo.wa.messagingTier}`);

  console.log('\n=== 4. O canal também carrega o teto ===');
  // A tela de Contas lista um canal por vez, e lê do channelPublic.
  const canais = await (await fetch(BASE + '/api/channels', { headers: aut })).json();
  const lista = canais.channels || canais.itens || [];
  ok(lista.length > 0, `${lista.length} canal(is)`);
  ok(lista.every(c => 'messagingTier' in c), 'channelPublic devolve messagingTier em todos');

  console.log('\n=== 5. A tela sabe traduzir a faixa ===');
  // O rótulo é da Meta (TIER_10K) e não serve para ninguém: quem lê precisa ver
  // "10.000 conversas". Se a tradução sumir, a tela mostra a sigla crua.
  const telaJs = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const fn = telaJs.slice(telaJs.indexOf('function limiteDiarioHtml'), telaJs.indexOf('function limiteDiarioHtml') + 900);
  for (const faixa of ['TIER_50', 'TIER_250', 'TIER_1K', 'TIER_10K', 'TIER_100K', 'TIER_UNLIMITED']) {
    ok(fn.includes(faixa), `traduz ${faixa}`);
  }
  ok(/w\.messagingTier/.test(fn), 'e lê o campo que agora existe na resposta');

  srv.close();
  await encerrar(srv, falhas);
})();
