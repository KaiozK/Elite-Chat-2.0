// PERÍODO DOS RELATÓRIOS — filtrar por data, mês e ano.
//
// Antes só existia `days=7|14|30|90`: dava para ver "os últimos 30 dias", mas
// não "março", nem "2025", nem "de 12 a 19" — que é exatamente o que se pede na
// hora de fechar o mês. Três coisas precisam valer sempre:
//   · o intervalo inclui os DOIS extremos (quem pede 01 a 31 quer o dia 31);
//   · nada de FORA do intervalo entra na conta;
//   · `days` continua funcionando, senão telas e links antigos quebram.
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

const porta = 3990;
const dia = (ano, mes, d, hora = 12) => +new Date(ano, mes - 1, d, hora);

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch('http://127.0.0.1:' + porta + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  ok(!!tok, 'admin entrou');
  const rel = (q) => fetch('http://127.0.0.1:' + porta + '/api/reports?' + q, { headers: { Authorization: 'Bearer ' + tok } }).then(r => r.json());

  const acc = db.get().accounts[0];
  acc.contacts = [{ waId: '5511900000001', name: 'A', stage: 'Novo', tags: [], createdAt: dia(2026, 3, 10) }];
  // Uma mensagem em cada ponto que importa: dentro de março, nas bordas, e fora.
  const marcos = [
    ['2026-02-28', dia(2026, 2, 28)],   // dia anterior ao mês
    ['2026-03-01', dia(2026, 3, 1, 0)], // primeiro instante do mês
    ['2026-03-15', dia(2026, 3, 15)],
    ['2026-03-31', dia(2026, 3, 31, 23)], // último instante do mês
    ['2026-04-01', dia(2026, 4, 1, 0)]  // dia seguinte
  ];
  acc.messages = marcos.map(([, ts], i) => ({
    id: 'm' + i, waId: '5511900000001', direction: 'in', type: 'text', text: 'oi', timestamp: ts, status: 'read'
  }));

  console.log('\n=== 1. MÊS fechado pega os dois extremos e nada além ===');
  let r = await rel('de=2026-03-01&ate=2026-03-31');
  ok(r.totals.in === 3, `março tem 3 mensagens (01, 15 e 31): ${r.totals.in}`);
  ok(r.days.length === 31, `a série tem os 31 dias: ${r.days.length}`);
  ok(r.days[0].date === '2026-03-01', 'começa no dia 1: ' + r.days[0].date);
  ok(r.days[30].date === '2026-03-31', 'termina no dia 31: ' + r.days[30].date);
  ok(r.days[0].in === 1 && r.days[30].in === 1, 'as mensagens das bordas entram nos dias certos');

  console.log('\n=== 2. Fevereiro e abril NÃO entram em março ===');
  ok(r.days.every(d => d.date.startsWith('2026-03')), 'nenhum dia de outro mês na série');
  const fev = await rel('de=2026-02-01&ate=2026-02-28');
  ok(fev.totals.in === 1, `fevereiro tem só a sua: ${fev.totals.in}`);

  console.log('\n=== 3. ANO inteiro ===');
  r = await rel('de=2026-01-01&ate=2026-12-31');
  ok(r.totals.in === 5, `o ano soma as 5: ${r.totals.in}`);
  ok(r.days.length === 365, `365 dias na série: ${r.days.length}`);

  console.log('\n=== 4. INTERVALO livre, inclusive de um dia só ===');
  r = await rel('de=2026-03-15&ate=2026-03-15');
  ok(r.days.length === 1, `um dia pedido, um dia devolvido: ${r.days.length}`);
  ok(r.totals.in === 1, 'com a mensagem daquele dia');
  r = await rel('de=2026-03-14&ate=2026-03-16');
  ok(r.days.length === 3 && r.totals.in === 1, `de 14 a 16: ${r.days.length} dias, ${r.totals.in} mensagem`);

  console.log('\n=== 5. Datas ao contrário são corrigidas ===');
  // Quem digita errado merece o relatório certo, não uma tela vazia.
  const virado = await rel('de=2026-03-31&ate=2026-03-01');
  ok(virado.days.length === 31 && virado.totals.in === 3, `de/até trocados devolvem o mesmo mês: ${virado.days.length} dias`);

  console.log('\n=== 6. O `days` de antes continua funcionando ===');
  const d7 = await rel('days=7');
  ok(d7.days.length === 7, `days=7 devolve 7 dias: ${d7.days.length}`);
  const semNada = await rel('');
  ok(semNada.days.length === 14, `sem parâmetro, 14 dias como sempre: ${semNada.days.length}`);

  console.log('\n=== 7. Intervalo absurdo é limitado ===');
  // A série é diária: um intervalo aberto viraria milhares de colunas.
  const gigante = await rel('de=2000-01-01&ate=2030-12-31');
  ok(gigante.days.length === 731, `limitado a 731 dias: ${gigante.days.length}`);
  const lixo = await rel('de=abacaxi&ate=2026-03-31');
  ok(lixo.days.length === 14, `data inválida cai no padrão em vez de quebrar: ${lixo.days.length}`);
  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
