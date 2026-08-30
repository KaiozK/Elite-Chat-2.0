// ============================================================================
// O PASSO "LOCALIZAR BUSINESS" DO CADASTRO INCORPORADO
//
// O caso relatado: o WhatsApp conecta, o número aparece, os webhooks são
// assinados, o teste de conexão passa — e no meio da lista um passo pintado de
// VERMELHO. A conexão estava certa; o vermelho é que estava errado.
//
// POR QUE ACONTECIA. `/me/businesses` responde pelo USUÁRIO, e no Embedded
// Signup o token nasce com escopo da WABA que acabou de ser compartilhada, não
// da carteira de negócios da pessoa. A lista volta vazia mesmo quando o
// business existe. O fluxo então seguia pelo caminho oficial — o `waba_id` que
// o próprio popup devolve — e terminava conectado, deixando o vermelho para
// trás.
//
// UM ERRO QUE NÃO IMPEDE NADA É PIOR DO QUE NENHUM AVISO: ele ensina a pessoa
// a ignorar os vermelhos, inclusive os que importam. E, num produto que os
// CLIENTES vão usar para conectar o próprio WhatsApp, cada vermelho desses é
// um chamado no suporte.
// ============================================================================
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
const cx = { query: async (a, b) => executar(a, b), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { query: async (a, b) => executar(a, b), getConnection: async () => cx, end: async () => {} };
const origLoad = Module._load;
Module._load = function (m) { if (m === 'mysql2/promise') return { createPool: () => pool }; return origLoad.apply(this, arguments); };
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

const fs = require('fs');
const db = require(R + 'src/db');
const meta = require(R + 'src/meta');

// A META DE MENTIRA. `donoDaWaba` é o que o teste vira para simular as duas
// contas: a que expõe o business pela WABA e a que não expõe nada.
let donoDaWaba = { id: '77700099', name: 'Nunes Tronos' };
meta.exchangeCode = async () => ({ access_token: 'TOKEN', token_type: 'bearer' });
// VAZIA, como na conta real que gerou o relato. Não é erro da Meta nem da
// pessoa: é o escopo do token do Embedded Signup.
meta.getBusinesses = async () => ({ data: [] });
meta.getWabaOwner = async () => (donoDaWaba ? { id: 'WABA1', name: 'Koonfy', owner_business_info: donoDaWaba } : { id: 'WABA1' });
meta.getOwnedWabas = async () => ({ data: [] });
meta.getPhoneNumbers = async () => ({ data: [{ id: 'PHONE1', display_phone_number: '+55 11 91801-0600', verified_name: 'Nunes Tronos' }] });
meta.subscribeApp = async () => ({ success: true });
// O REGISTRO NA CLOUD API. `registro` é o que o teste vira para simular os três
// desfechos reais: registrou, já estava registrado, e PIN de outra pessoa.
let registro = 'ok';
meta.registerPhone = async () => {
  if (registro === 'ok') return { success: true };
  const e = new Error(registro === 'ja'
    ? 'Phone number has already been registered'
    : 'Two-step verification PIN mismatch');
  e.meta = { code: registro === 'ja' ? 133005 : 133006 };
  throw e;
};
let statusDoNumero = 'CONNECTED';
meta.phoneStatus = async () => ({ id: 'PHONE1', status: statusDoNumero });
meta.debugToken = async () => ({ data: { user_id: '1' } });
meta.phoneHealth = async () => ({ display_phone_number: '+55 11 91801-0600' });

const BASE = 'http://127.0.0.1:3993';

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3993);
  await new Promise(r => setTimeout(r, 150));

  const P = db.get().platform;
  P.appId = 'APP'; P.appSecret = 'SEGREDO';
  P.billing.requirePlan = false;   // conectar o WhatsApp não é o que se mede aqui
  db.save();

  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Dono', email: 'dono@ex.com', pass: 'segredo123',
      profile: { phone: '11988887777', country: 'BR' }, recebimento: { document: '39053344705' }
    })
  });
  const entrar = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'dono@ex.com', pass: 'segredo123' })
  })).json();
  const cab = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + entrar.token };

  // O popup do Embedded Signup entrega o waba_id. É o caminho OFICIAL, e é por
  // ele que a conexão funcionava mesmo com o passo vermelho.
  const conectar = async () => (await fetch(BASE + '/api/wa/connect', {
    method: 'POST', headers: cab,
    body: JSON.stringify({ code: 'CODE', sessionInfo: { waba_id: 'WABA1', phone_number_id: 'PHONE1' } })
  })).json();

  console.log('=== 1. Com /me/businesses vazia, a conexão termina inteira ===');
  const r1 = await conectar();
  ok(r1.connected === true, 'o WhatsApp conecta');
  ok(r1.wa.displayPhoneNumber === '+55 11 91801-0600',
     'com o número certo: ' + r1.wa.displayPhoneNumber);
  const passo = n => (r1.steps || []).find(s => s.name === n);
  ok(passo('waba') && passo('waba').ok === true, 'a WABA vem pelo waba_id do popup');
  ok(passo('phone') && passo('phone').ok === true, 'o número é encontrado');
  ok(passo('subscribed_apps') && passo('subscribed_apps').ok === true, 'o app é assinado na WABA');
  ok(passo('health') && passo('health').ok === true, 'e o teste de conexão passa');

  console.log('\n=== 2. E o business SAI DA WABA, em vez de dar vermelho ===');
  // `/me/businesses` volta vazia; quem sabe de quem é a WABA é a própria WABA.
  ok(passo('business') && passo('business').ok === true,
     'o passo fica verde: ' + JSON.stringify((passo('business') || {}).detail));
  ok(db.findAccountByEmail('dono@ex.com').wa.businessId === '77700099',
     'e o business é guardado na conta: ' + db.findAccountByEmail('dono@ex.com').wa.businessId);

  console.log('\n=== 3. Sem business em lugar nenhum, é CINZA — não vermelho ===');
  // Existe conta Meta que não expõe business por nenhum dos dois caminhos. A
  // conexão funciona igual: número, webhook e envio saem todos da WABA.
  donoDaWaba = null;
  const acc = db.findAccountByEmail('dono@ex.com');
  acc.wa = { connected: false };
  db.save();
  const r2 = await conectar();
  const b2 = (r2.steps || []).find(s => s.name === 'business');
  ok(r2.connected === true, 'a conexão termina do mesmo jeito');
  ok(b2 && b2.ok === 'skip', `o passo é "skip", e não falha: ${b2 && JSON.stringify(b2.ok)}`);
  ok(b2 && /não depende disto/i.test(b2.detail || ''),
     'dizendo que a conexão não depende dele: ' + (b2 || {}).detail);
  ok(r2.steps.every(s => s.ok !== false),
     'e NENHUM passo vermelho numa conexão que deu certo');

  console.log('\n=== 4. O NÚMERO É REGISTRADO NA CLOUD API ===');
  // Era o passo que faltava, e o sintoma aparecia só do lado da Meta: no
  // WhatsApp Manager o número ficava "Pendente", sem enviar nem receber.
  // Compartilhar o número com o app e registrá-lo na Cloud API são coisas
  // diferentes — e a segunda ninguém fazia.
  donoDaWaba = { id: '77700099', name: 'Nunes Tronos' };
  const zerar = () => { const a = db.findAccountByEmail('dono@ex.com'); a.wa = { connected: false }; db.save(); };

  zerar();
  const r3 = await conectar();
  const reg = (r3.steps || []).find(s => s.name === 'register');
  ok(reg && reg.ok === true, 'o registro acontece no fluxo: ' + JSON.stringify(reg));
  const contaReg = db.findAccountByEmail('dono@ex.com');
  ok(contaReg.wa.registered === true, 'e fica gravado na conta');
  ok(/^\d{6}$/.test(String(contaReg.wa.pin || '')),
     'com um PIN de seis dígitos guardado, para registrar de novo sem depender de memória');

  console.log('\n=== 5. Já registrado NÃO é erro ===');
  // Acontece ao reconectar um número que já estava de pé.
  registro = 'ja';
  zerar();
  const r4 = await conectar();
  const reg4 = (r4.steps || []).find(s => s.name === 'register');
  ok(reg4 && reg4.ok === true, 'é o estado que queríamos, não uma falha');
  ok(/já estava/i.test(reg4.detail || ''), 'e o texto diz isso: ' + reg4.detail);

  console.log('\n=== 6. PIN de outra pessoa: erro DE VERDADE, com o que fazer ===');
  // Aqui não há como adivinhar — o número tem verificação em duas etapas com um
  // PIN que não é o nosso. Quem resolve é o dono, e o texto precisa dizer como.
  registro = 'pin';
  zerar();
  const r5 = await conectar();
  const reg5 = (r5.steps || []).find(s => s.name === 'register');
  ok(reg5 && reg5.ok === false, 'este sim é vermelho');
  ok(/verificação em duas etapas/i.test(reg5.detail || ''), 'dizendo qual é o problema');
  ok(/WhatsApp Manager/i.test(reg5.detail || ''), 'e onde se resolve: ' + reg5.detail);
  registro = 'ok';

  console.log('\n=== 7. O teste de conexão olha o STATUS na Meta ===');
  // Era o buraco: a tela dizia tudo verde enquanto o WhatsApp Manager mostrava
  // "Pendente". Um teste de conexão que não olha o estado do número lá não
  // testa a conexão.
  statusDoNumero = 'PENDING';
  zerar();
  const r6 = await conectar();
  const h6 = (r6.steps || []).find(s => s.name === 'health');
  ok(h6 && h6.ok === false, 'número pendente reprova o teste de conexão');
  ok(/Pendente|PENDING/i.test(h6.detail || ''), 'dizendo o estado: ' + h6.detail);
  ok(/não envia nem recebe/i.test(h6.detail || ''), 'e o que isso significa na prática');
  statusDoNumero = 'CONNECTED';

  console.log('\n=== 8. E dá para registrar sem refazer o cadastro ===');
  // Quem conectou ANTES desta correção tem o número compartilhado e não
  // registrado. Refazer o cadastro incorporado inteiro seria pedir que a pessoa
  // desfaça o que já deu certo.
  zerar();
  await conectar();
  const conta8 = db.findAccountByEmail('dono@ex.com');
  conta8.wa.registered = false;
  db.save();
  const r8 = await (await fetch(BASE + '/api/wa/register', { method: 'POST', headers: cab, body: '{}' })).json();
  ok(r8.registered === true, 'o botão registra o número já conectado');
  ok(r8.status === 'CONNECTED', 'e confirma o estado na Meta: ' + r8.status);

  registro = 'pin';
  const rPin = await fetch(BASE + '/api/wa/register', { method: 'POST', headers: cab, body: '{}' });
  const cPin = await rPin.json();
  ok(rPin.status === 409, `PIN de outra pessoa não vira 200: ${rPin.status}`);
  ok(/duas etapas/i.test(cPin.error || ''), 'com a instrução de como resolver');
  registro = 'ok';

  console.log('\n=== 9. CONECTAR NUM CANAL NÃO DERRUBA O OUTRO ===');
  // O caso relatado, e o mais grave de todos: o cliente tinha "WhatsApp
  // principal" com um número funcionando. Conectou OUTRO número escolhendo o
  // canal "Whatsapp Video Meta" — e o número novo apareceu no PRINCIPAL, por
  // cima do que estava lá. O canal escolhido continuou "número não conectado".
  //
  // A causa: `acc.wa` é APELIDO de `channels[0].wa`. A rota gravava nele, então
  // toda conexão caía no primeiro canal, qualquer que fosse o escolhido.
  //
  // Não é só "conectou no lugar errado": DESCONECTOU uma conexão que estava
  // funcionando, sem avisar ninguém.
  const conta9 = db.findAccountByEmail('dono@ex.com');
  conta9.channels = [
    { id: 'ch_principal', label: 'WhatsApp principal', createdAt: Date.now(), archived: false,
      canceledAt: 0, cancelAt: 0,
      wa: { connected: true, accessToken: 'TOKEN_ANTIGO', wabaId: 'WABA_ANTIGA',
            phoneNumberId: 'PHONE_KAIO', displayPhoneNumber: '+55 11 93623-5758',
            verifiedName: 'Kaio Caglioni' },
      templatesCache: { fetchedAt: 0, list: [] }, contacts: [], conversations: [] },
    { id: 'ch_video', label: 'Whatsapp Video Meta', createdAt: Date.now(), archived: false,
      canceledAt: 0, cancelAt: 0,
      wa: { connected: false }, templatesCache: { fetchedAt: 0, list: [] },
      contacts: [], conversations: [] }
  ];
  db.save();

  // A conexão é feita COM O SEGUNDO CANAL selecionado — é o que o painel manda
  // no cabeçalho `x-channel`.
  const r9 = await (await fetch(BASE + '/api/wa/connect', {
    method: 'POST',
    headers: { ...cab, 'x-channel': 'ch_video' },
    body: JSON.stringify({ code: 'CODE', sessionInfo: { waba_id: 'WABA1', phone_number_id: 'PHONE1' } })
  })).json();
  ok(r9.connected === true, 'a conexão termina');

  const depois = db.findAccountByEmail('dono@ex.com');
  const principal = depois.channels.find(c => c.id === 'ch_principal');
  const video = depois.channels.find(c => c.id === 'ch_video');

  ok(video.wa.phoneNumberId === 'PHONE1',
     'o número novo vai para o canal ESCOLHIDO: ' + video.wa.displayPhoneNumber);
  ok(video.wa.connected === true, 'que passa a estar conectado');
  ok(principal.wa.phoneNumberId === 'PHONE_KAIO',
     'e o canal principal fica INTACTO: ' + principal.wa.displayPhoneNumber);
  ok(principal.wa.connected === true, 'ainda conectado — ninguém foi derrubado');
  ok(principal.wa.accessToken === 'TOKEN_ANTIGO', 'com o token dele preservado');
  ok(r9.chId === 'ch_video', 'e a resposta diz em qual canal foi: ' + r9.chId);

  console.log('\n=== 10. O MESMO número em dois canais é recusado ===');
  // Cada canal tem conversas e contatos próprios, e o webhook encontra o canal
  // pelo phoneNumberId. Com o número repetido, a mesma mensagem cairia num
  // canal decidido por ordem de lista — e a resposta sairia do outro.
  const r10 = await fetch(BASE + '/api/wa/connect', {
    method: 'POST',
    headers: { ...cab, 'x-channel': 'ch_principal' },
    body: JSON.stringify({ code: 'CODE', sessionInfo: { waba_id: 'WABA1', phone_number_id: 'PHONE1' } })
  });
  const c10 = await r10.json();
  ok(r10.status === 409, `recusado com 409: ${r10.status}`);
  ok(/já está conectado no canal/i.test(c10.error || ''), 'dizendo onde ele já está');
  ok(/Whatsapp Video Meta/.test(c10.error || ''), 'com o nome do canal: ' + c10.error);

  const aindaLa = db.findAccountByEmail('dono@ex.com').channels.find(c => c.id === 'ch_principal');
  ok(aindaLa.wa.phoneNumberId === 'PHONE_KAIO',
     'e a recusa acontece ANTES de gravar qualquer coisa — o principal segue intocado');

  console.log('\n=== 11. A tela sabe desenhar o terceiro estado ===');
  const app_js = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
  ok(/ok === 'skip' \? 'skip'/.test(app_js), 'esMark trata "skip" separado de falha');
  ok(/\.es-step\.skip \{/.test(css), 'e o CSS pinta o cinza');
  ok(/\.es-step\.skip \.dot \{ background: var\(--border2\); \}/.test(css),
     'com o ponto apagado, não vermelho');

  console.log('\n=== 12. A pergunta certa, ao lugar certo ===');
  const metaSrc = fs.readFileSync(R + 'src/meta.js', 'utf8');
  ok(/owner_business_info/.test(metaSrc),
     'a WABA é quem responde de quem ela é');
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  // A ordem importa: perguntar à WABA antes de saber qual é ela não funciona.
  ok(api.indexOf('getWabaOwner') > api.indexOf("step('waba', true, wabaId)"),
     'e só é perguntado depois de a WABA ser conhecida');

  srv.close();
  await encerrar(null, falhas);
})();
