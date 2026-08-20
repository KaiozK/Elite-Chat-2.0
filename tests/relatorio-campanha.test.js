// RELATÓRIO DA CAMPANHA: leitura, clique em botão e recorte por estado.
//
// Existe porque as duas métricas que dizem se um disparo funcionou — quem LEU e
// quem CLICOU — não existiam. A leitura estava no status da mensagem mas não era
// exposta por estado, e o clique num botão de template chegava como uma mensagem
// qualquer, sem nada ligando de volta à campanha que o provocou.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// Banco de mentira, igual aos outros testes: este teste NÃO pode escrever no
// banco de desenvolvimento — ele zera mensagens e campanhas para montar o
// cenário, e fazer isso no arquivo real apagaria dados de quem está usando.
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
const geo = require(R + 'src/geo');

// Números de estados diferentes, pelo DDD: SP(11), RJ(21), MG(31), BA(71).
const GENTE = [
  { waId: '5511988880001', uf: 'SP' }, { waId: '5511988880002', uf: 'SP' },
  { waId: '5511988880003', uf: 'SP' }, { waId: '5521988880004', uf: 'RJ' },
  { waId: '5521988880005', uf: 'RJ' }, { waId: '5531988880006', uf: 'MG' },
  { waId: '5571988880007', uf: 'BA' }
];

(async () => {
  console.log('=== 0. O DDD vira estado ===');
  for (const p of GENTE.slice(0, 4)) ok(geo.ufOf(p.waId) === p.uf, `${p.waId} → ${geo.ufOf(p.waId)}`);

  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(3995);
  await new Promise(r => setTimeout(r, 150));
  const login = await (await fetch('http://127.0.0.1:3995/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  ok(!!tok, 'admin entrou');

  const acc = db.get().accounts[0];
  acc.messages = [];
  acc.campaigns = [];

  // Uma campanha já disparada: cada pessoa com a sua mensagem e o seu status.
  // read=leu, delivered=recebeu e não abriu, failed=não chegou.
  const estados = ['read', 'read', 'delivered', 'read', 'delivered', 'read', 'failed'];
  const camp = {
    id: 'camp_teste', name: 'Promoção de Julho', templateName: 'promo_julho',
    chId: '', chLabel: 'Principal', language: 'pt_BR', vars: [], audience: { type: 'all' },
    createdAt: Date.now() - 3600000, status: 'done', finishedAt: Date.now(),
    recipients: GENTE.map((p, i) => {
      const msgId = 'wamid.' + i;
      acc.messages.push({ id: msgId, waId: p.waId, direction: 'out', status: estados[i], timestamp: Date.now() });
      return { waId: p.waId, status: estados[i] === 'failed' ? 'failed' : 'sent', msgId, sentAt: Date.now() - 1800000 };
    })
  };
  acc.campaigns.push(camp);

  console.log('\n=== 1. Clique em botão é casado com a campanha ===');
  const webhook = require(R + 'src/webhook');
  ok(typeof webhook.registrarCliqueCampanha === 'function', 'a função de atribuição está exportada');

  // Três pessoas tocam em botões (duas em "Quero!", uma em "Depois").
  webhook.registrarCliqueCampanha(acc, '5511988880001', 'Quero!', 'btn_1');
  webhook.registrarCliqueCampanha(acc, '5511988880002', 'Quero!', 'btn_1');
  webhook.registrarCliqueCampanha(acc, '5521988880004', 'Depois', 'btn_2');
  const cliques = camp.recipients.filter(r => r.clickedAt).length;
  ok(cliques === 3, `três cliques registrados: ${cliques}`);

  // Quem clica duas vezes continua sendo UMA pessoa.
  webhook.registrarCliqueCampanha(acc, '5511988880001', 'Quero!', 'btn_1');
  ok(camp.recipients.filter(r => r.clickedAt).length === 3, 'o segundo toque da mesma pessoa não conta de novo');

  console.log('\n=== 2. Clique fora da janela não é atribuído ===');
  // Depois de 7 dias, dizer que a resposta veio daquele disparo é chute — e
  // chute em relatório é pior que dado faltando.
  const velha = camp.recipients.find(r => r.waId === '5531988880006');
  velha.sentAt = Date.now() - 8 * 24 * 3600 * 1000;
  webhook.registrarCliqueCampanha(acc, '5531988880006', 'Quero!', 'btn_1');
  ok(!velha.clickedAt, 'disparo de 8 dias atrás não recebe o clique');

  console.log('\n=== 3. O relatório monta o funil ===');
  const rel = await (await fetch('http://127.0.0.1:3995/api/campaigns/camp_teste/report',
    { headers: { Authorization: 'Bearer ' + tok } })).json();

  ok(rel.geral.enviadas === 6, `enviadas (7 menos a que falhou): ${rel.geral.enviadas}`);
  ok(rel.geral.falhas === 1, `falhas: ${rel.geral.falhas}`);
  ok(rel.geral.lidas === 4, `lidas: ${rel.geral.lidas}`);
  // quem leu também recebeu: entregues inclui as lidas
  ok(rel.geral.entregues === 6, `entregues inclui as lidas: ${rel.geral.entregues}`);
  ok(rel.geral.cliques === 3, `cliques: ${rel.geral.cliques}`);
  ok(rel.geral.taxaLeitura === 66.7, `% que leu: ${rel.geral.taxaLeitura}%`);
  ok(rel.geral.ctrSobreLidas === 75, `CTR sobre quem leu: ${rel.geral.ctrSobreLidas}%`);

  console.log('\n=== 4. Por BOTÃO ===');
  const quero = rel.botoes.find(b => b.rotulo === 'Quero!');
  const depois = rel.botoes.find(b => b.rotulo === 'Depois');
  ok(quero && quero.cliques === 2, `"Quero!" com 2 cliques: ${quero && quero.cliques}`);
  ok(depois && depois.cliques === 1, `"Depois" com 1 clique: ${depois && depois.cliques}`);
  ok(quero && quero.ufs.SP === 2, 'e o relatório sabe que os dois foram de SP');
  ok(rel.botoes[0].rotulo === 'Quero!', 'os botões vêm do mais clicado para o menos');

  console.log('\n=== 5. Por ESTADO — é isto que pinta o mapa ===');
  const sp = rel.estados.find(e => e.uf === 'SP');
  const rj = rel.estados.find(e => e.uf === 'RJ');
  const ba = rel.estados.find(e => e.uf === 'BA');
  ok(sp && sp.total === 3, `SP com 3 leads: ${sp && sp.total}`);
  ok(sp && sp.lidas === 2, `SP com 2 leituras: ${sp && sp.lidas}`);
  ok(sp && sp.cliques === 2, `SP com 2 cliques: ${sp && sp.cliques}`);
  ok(rj && rj.cliques === 1, `RJ com 1 clique: ${rj && rj.cliques}`);
  ok(ba && ba.falhas === 1 && ba.enviadas === 0, 'BA só teve falha, não entra como enviada');
  ok(rel.estados[0].total >= rel.estados[rel.estados.length - 1].total, 'estados ordenados por volume');
  ok(sp && sp.nome === 'São Paulo', 'com o nome por extenso para a tabela');

  console.log('\n=== 6. Mapa consolidado de várias campanhas ===');
  const mapa = await (await fetch('http://127.0.0.1:3995/api/campaigns/mapa?dias=90',
    { headers: { Authorization: 'Bearer ' + tok } })).json();
  const spm = mapa.estados.find(e => e.uf === 'SP');
  ok(mapa.campanhas === 1, `somou 1 campanha do período: ${mapa.campanhas}`);
  ok(spm && spm.cliques === 2, `SP consolidado com 2 cliques: ${spm && spm.cliques}`);
  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
