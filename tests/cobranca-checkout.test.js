// COBRAR PELO WHATSAPP É MANDAR UM BOTÃO, NÃO UM CÓDIGO.
//
// O código Pix no meio da conversa só existe quando o adquirente já emitiu —
// e o que exige CPF/CNPJ do pagador (Simplify, e o mercado vai para lá) só
// emite depois que o comprador se identifica. A cobrança ia embora com um
// "Ou use o Pix copia e cola:" apontando para o nada.
//
// Agora vai um botão que abre o CHECKOUT: lá o comprador informa o documento,
// escolhe Pix, cartão ou boleto, e recebe o código pronto. E, do outro lado,
// o Koonfy para de perguntar o que já sabe: contato guarda e-mail e CPF/CNPJ,
// a conta guarda os seus, e a conta de Pagamentos nasce do próprio cadastro.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// BANCO DE MENTIRA: teste não escreve no banco de ninguém.
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

const porta = 3991;

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const elitepay = require(R + 'src/elitepay');
  const saaspix = require(R + 'src/saaspix');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const acc = db.get().accounts[0] || db.findAdminAccount();
  acc.name = 'Loja do Teste';
  acc.email = 'loja@teste.com';
  acc.contacts = [];
  db.get().platform.baseUrl = 'https://koonfy.com';

  const login = await (await fetch('http://127.0.0.1:' + porta + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const chamar = (metodo, rota, corpo) => fetch('http://127.0.0.1:' + porta + '/api' + rota,
    { method: metodo, headers: H, body: JSON.stringify(corpo) }).then(async r => ({ st: r.status, b: await r.json() }));
  const post = (rota, corpo) => chamar('POST', rota, corpo);
  const put = (rota, corpo) => chamar('PUT', rota, corpo);
  const contato = waId => db.get().accounts[0].contacts.find(x => x.waId === waId);

  console.log('=== 1. A cobrança sai como BOTÃO para o Checkout, sem código Pix ===');
  const ch = { id: 'epc_1', value: 12900, contactName: 'Maria', comment: 'Consultoria', brCode: '', payUrl: '' };
  const btn = elitepay.chargeButton(acc, ch);
  ok(/^https?:/.test(btn.url), 'o botão aponta para uma URL: ' + btn.url.slice(0, 40));
  ok(btn.url.includes('/pay/'), 'que é a página pública de pagamento');
  ok(btn.interactive.type === 'cta_url', 'no formato que a Meta aceita: ' + btn.interactive.type);
  ok(btn.displayText.length <= 20, `texto do botão dentro do limite (${btn.displayText.length}): "${btn.displayText}"`);
  ok(btn.body.length <= 1024, `corpo dentro do limite: ${btn.body.length}`);
  ok(!btn.body.includes(btn.url), 'o link não aparece duplicado no texto');
  ok(!/copia e cola/i.test(btn.body), 'e some a chamada do copia-e-cola');
  ok(btn.body.includes('Maria'), 'o texto continua dizendo com quem fala');
  ok(/129/.test(btn.body), 'e quanto é: ' + btn.body.replace(/\n/g, ' | ').slice(0, 70));

  console.log('\n=== 2. Com o código já emitido, o texto continua servindo de reserva ===');
  const ch2 = { ...ch, brCode: '00020126-CODIGO' };
  const txt = elitepay.chargeMessage(acc, ch2);
  ok(txt.includes('00020126-CODIGO'), 'com código, o copia-e-cola vai no texto');
  const semCod = elitepay.chargeMessage(acc, ch2, { semCodigo: true });
  ok(!semCod.includes('00020126-CODIGO'), 'pedindo sem código, ele sai');
  ok(!/copia e cola/i.test(semCod), 'junto com a linha que o apresentava');
  ok(semCod.includes('/pay/'), 'e o link fica, que é para onde a pessoa vai');

  console.log('\n=== 3. Contato novo já guarda e-mail e CPF/CNPJ ===');
  let r = await post('/contacts', { phone: '5511988887777', name: 'Maria', email: 'maria@ex.com', document: '84748914009' });
  ok(r.st === 200, 'contato criado: ' + r.st);
  ok(contato('5511988887777').email === 'maria@ex.com', 'o e-mail ficou gravado');
  ok(contato('5511988887777').vars.cpf_cnpj === '84748914009', 'e o documento também: ' + contato('5511988887777').vars.cpf_cnpj);

  console.log('\n=== 4. Documento inventado é recusado ===');
  r = await post('/contacts', { phone: '5511988886666', name: 'Fake', document: '11111111111' });
  ok(r.st === 400, 'recusou o CPF de dígitos repetidos: ' + r.st);
  ok(/CPF/i.test(r.b.error || ''), 'dizendo o motivo: ' + r.b.error);

  console.log('\n=== 5. Editar o contato atualiza o documento ===');
  r = await put('/contacts/5511988887777', { document: '11144477735' });
  ok(r.st === 200, 'salvou: ' + r.st);
  ok(contato('5511988887777').vars.cpf_cnpj === '11144477735', 'documento novo no contato');
  r = await put('/contacts/5511988887777', { document: '12345678900' });
  ok(r.st === 400, 'e um inválido não passa por cima do que estava certo: ' + r.st);
  ok(contato('5511988887777').vars.cpf_cnpj === '11144477735', 'o valor bom continua lá');

  console.log('\n=== 6. O depósito NÃO pergunta o que a conta já tem ===');
  // O documento pode ter entrado pelo formulário do Pagamentos, e não pelo
  // cadastro. Procurar antes de reclamar é o que deixa a recarga ser só
  // "valor e pagar".
  acc.profile = { phone: '', document: '', country: 'BR' };
  elitepay.ensure(acc).subaccount = { document: '84748914009', phone: '5582981440676', status: 'active' };
  const pag = saaspix.pagadorDaConta(acc);
  ok(pag.document === '84748914009', 'achou o CPF/CNPJ guardado: ' + pag.document);
  ok(pag.phone === '5582981440676', 'e o telefone: ' + pag.phone);
  saaspix.fixarNoCadastro(acc);
  ok(acc.profile.document === '84748914009', 'que fica gravado no cadastro para a próxima');

  console.log('\n=== 7. A conta de Pagamentos nasce dos dados do cadastro ===');
  const acc2 = db.newAccount({ name: 'Loja Nova', email: 'nova@teste.com', pass: 'segredo123' });
  acc2.profile.document = '84748914009';
  acc2.profile.phone = '5582981440676';
  acc2.profile.pixKey = 'nova@teste.com';
  acc2.profile.pixKeyType = 'email';
  db.get().accounts.push(acc2);
  const sub = await elitepay.garantirPagamentos(acc2);
  ok(!!sub, 'criada sem formulário nenhum');
  ok(sub && sub.document === '84748914009', 'com o documento do cadastro: ' + (sub && sub.document));
  const denovo = await elitepay.garantirPagamentos(acc2);
  ok(denovo && denovo.createdAt === sub.createdAt, 'chamar de novo não cria uma segunda');

  console.log('\n=== 8. Cadastro sem chave Pix não inventa uma ===');
  // A chave é do banco do cliente. Sem ela, fica o formulário do Pagamentos —
  // melhor do que uma subconta que não recebe.
  const acc3 = db.newAccount({ name: 'Loja Sem Chave', email: 'semchave@teste.com', pass: 'segredo123' });
  acc3.profile.document = '84748914009';
  acc3.profile.phone = '5582981440676';
  db.get().accounts.push(acc3);
  ok((await elitepay.garantirPagamentos(acc3)) === null, 'devolve null em vez de criar torto');
  ok(!(acc3.elitepay && acc3.elitepay.subaccount), 'e nada de subconta pela metade');

  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
