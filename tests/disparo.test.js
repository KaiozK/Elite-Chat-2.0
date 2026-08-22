// DISPARO É TEMPLATE ENVIADO — e nada mais.
//
// A cota de "disparos por ciclo" contava TODA mensagem de saída da conta: a
// resposta do atendente no chat, a mensagem que encerra o atendimento, o áudio,
// a confirmação de pagamento. Quem atendia bem gastava o plano atendendo, e o
// teto que existe para limitar campanha castigava justamente quem conversa.
//
// Este teste existe porque a regra é invisível: nada quebra quando ela volta a
// contar errado — a conta só chega ao fim do mês com a cota estourada sem ter
// disparado nada, e ninguém liga uma coisa à outra.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// Banco de mentira: o teste zera as mensagens da conta para montar o cenário.
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
const limits = require(R + 'src/limits');

(async () => {
  await db.loadAsync();
  const acc = db.newAccount({ name: 'Padaria do Zé', email: 'ze@padaria.com', pass: 'segredo123' });
  db.get().accounts.push(acc);
  const agora = Date.now();
  acc.billing.status = 'active';
  acc.billing.periodEnd = agora + 20 * 86400000;   // ciclo começou há 10 dias

  acc.messages = [
    // ---- ATENDIMENTO: nada disto é disparo
    { id: 'a1', waId: '5511900000001', direction: 'out', type: 'text', text: 'Boa tarde!', timestamp: agora - 3600000 },
    { id: 'a2', waId: '5511900000001', direction: 'out', type: 'text', text: 'Chega amanhã', timestamp: agora - 3500000 },
    { id: 'a3', waId: '5511900000002', direction: 'out', type: 'audio', timestamp: agora - 3400000 },
    { id: 'a4', waId: '5511900000002', direction: 'out', type: 'interactive', timestamp: agora - 3300000 },
    // A mensagem que encerra o atendimento sai como qualquer outra saída.
    { id: 'a5', waId: '5511900000002', direction: 'out', type: 'text', text: 'Atendimento finalizado', timestamp: agora - 3200000 },
    // ---- ENTRADA: nunca contou, e continua não contando
    { id: 'e1', waId: '5511900000001', direction: 'in', type: 'text', text: 'oi', timestamp: agora - 3000000 },
    // ---- DISPARO: template enviado
    { id: 't1', waId: '5511900000003', direction: 'out', type: 'template', text: '📋 Template: promo', timestamp: agora - 2000000 },
    { id: 't2', waId: '5511900000004', direction: 'out', type: 'template', text: '📋 Template: promo', timestamp: agora - 1900000 },
    // ---- e um template do ciclo PASSADO, que não conta neste
    { id: 't0', waId: '5511900000005', direction: 'out', type: 'template', text: '📋 Template: antigo', timestamp: agora - 40 * 86400000 }
  ];
  db.save();

  console.log('=== 1. A conta soma só os templates do ciclo ===');
  const rel = limits.report(acc);
  ok(rel.sends.used === 2, `dois disparos, e não nove: ${rel.sends.used}`);

  console.log('\n=== 2. Conversa não consome disparo ===');
  const antes = limits.report(acc).sends.used;
  acc.messages.push({ id: 'a6', waId: '5511900000001', direction: 'out', type: 'text', text: 'mais uma resposta', timestamp: agora });
  acc.messages.push({ id: 'a7', waId: '5511900000001', direction: 'out', type: 'image', timestamp: agora });
  db.save();
  ok(limits.report(acc).sends.used === antes, 'responder no chat e mandar imagem não mexem na cota');

  console.log('\n=== 3. Um template a mais consome um disparo ===');
  acc.messages.push({ id: 't3', waId: '5511900000006', direction: 'out', type: 'template', text: '📋 Template: promo', timestamp: agora });
  db.save();
  ok(limits.report(acc).sends.used === antes + 1, `o template conta: ${limits.report(acc).sends.used}`);

  console.log('\n=== 4. O ciclo anterior fica no ciclo anterior ===');
  // O template de 40 dias atrás está na lista desde o começo e nunca entrou na
  // conta: sem essa fronteira, a cota nunca zeraria e o cliente ficaria preso.
  const doCiclo = acc.messages.filter(m => m.type === 'template' && m.direction === 'out').length;
  ok(doCiclo === 4 && limits.report(acc).sends.used === 3,
     `quatro templates gravados, três no ciclo: ${limits.report(acc).sends.used}`);

  encerrar(falhas);
})();
