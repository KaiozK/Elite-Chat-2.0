// TODA MENSAGEM DO CHAT COM HORA.
//
// `addMessage` carimba a hora desde sempre, mas o histórico tem mensagens
// antigas de antes disso — e elas apareciam no chat sem horário nenhum, o que
// no meio de uma conversa parece defeito. A correção é do DADO: a migração
// preenche o que falta, deduzindo da vizinhança, e o valor fica gravado.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

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
const store = require(R + 'src/store');

(async () => {
  await db.loadAsync();
  const acc = db.findAdminAccount();
  const T = (h) => +new Date(2026, 2, 10, h, 0, 0);   // 10/03/2026, hora cheia
  // A migração roda por conta; chamar direto é o mesmo caminho da partida.
  const migrar = () => db.ensureAccountShape(acc);

  console.log('=== 1. Mensagem NOVA sempre nasce com hora ===');
  acc.messages = [];
  // O caso que já quebrou uma vez: quem monta a mensagem espalhando conteúdo
  // por cima podia mandar `timestamp: undefined` e apagar a hora.
  const nova = store.addMessage(acc, { id: 'n1', waId: '5511900000000', direction: 'out', type: 'text', text: 'oi', timestamp: undefined });
  ok(Number.isFinite(nova.timestamp) && nova.timestamp > 0, 'com timestamp undefined, o banco carimba: ' + !!nova.timestamp);
  const zero = store.addMessage(acc, { id: 'n2', waId: '5511900000000', direction: 'out', type: 'text', text: 'oi', timestamp: 0 });
  ok(zero.timestamp > 0, 'com timestamp 0 também');

  console.log('\n=== 2. Histórico antigo SEM hora é preenchido na migração ===');
  acc.messages = [
    { id: 'a', waId: '5511900000000', direction: 'in', type: 'text', text: '1', timestamp: T(9) },
    { id: 'b', waId: '5511900000000', direction: 'out', type: 'text', text: '2' },              // sem hora
    { id: 'c', waId: '5511900000000', direction: 'in', type: 'text', text: '3', timestamp: 0 }, // hora zerada
    { id: 'd', waId: '5511900000000', direction: 'out', type: 'text', text: '4', timestamp: T(11) }
  ];
  migrar();
  const m = Object.fromEntries(acc.messages.map(x => [x.id, x.timestamp]));
  ok(acc.messages.every(x => Number.isFinite(x.timestamp) && x.timestamp > 0), 'nenhuma mensagem ficou sem hora');
  // A anterior é o palpite certo: mantém a ordem e não inventa hora no futuro.
  ok(m.b === T(9), `a sem hora herdou a anterior (9h): ${new Date(m.b).getHours()}h`);
  ok(m.c === T(9), `a zerada também: ${new Date(m.c).getHours()}h`);
  ok(m.a === T(9) && m.d === T(11), 'e as que já tinham hora não foram tocadas');
  ok(m.a <= m.b && m.b <= m.c && m.c <= m.d, 'a ordem da conversa continua crescente');

  console.log('\n=== 3. Sem NENHUMA hora na conversa, usa a criação da conta ===');
  acc.createdAt = T(8);
  acc.messages = [
    { id: 'x', waId: '5511900000000', direction: 'in', type: 'text', text: 'a' },
    { id: 'y', waId: '5511900000000', direction: 'out', type: 'text', text: 'b' }
  ];
  migrar();
  ok(acc.messages.every(x => x.timestamp === T(8)), 'as duas caíram na criação da conta');

  console.log('\n=== 4. A PRIMEIRA sem hora herda a SEGUINTE ===');
  // Não há anterior para copiar; o vizinho de baixo é o único palpite honesto.
  acc.messages = [
    { id: 'p', waId: '5511900000000', direction: 'in', type: 'text', text: 'a' },
    { id: 'q', waId: '5511900000000', direction: 'out', type: 'text', text: 'b', timestamp: T(15) }
  ];
  migrar();
  ok(acc.messages[0].timestamp === T(15), `herdou a seguinte (15h): ${new Date(acc.messages[0].timestamp).getHours()}h`);

  console.log('\n=== 5. O conserto FICA GRAVADO ===');
  // É o ponto do pedido: "persista". Não adianta consertar só na hora de pintar.
  await db.save();
  const bruto = JSON.stringify(db.get().accounts.find(a => a.id === acc.id).messages);
  ok(!/"timestamp":(null|0|undefined)/.test(bruto), 'nada de timestamp nulo/zero no que foi salvo');

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exitCode = falhas ? 1 : 0;
  setTimeout(() => process.exit(falhas ? 1 : 0), 50).unref();
})().catch(e => { console.error(e); process.exit(1); });
