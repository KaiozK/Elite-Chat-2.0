// DE ONDE A COBRANÇA VEIO DECIDE COMO ELA SAI.
//
// São duas coisas diferentes, e o WhatsApp trata as duas de forma diferente:
//
//   KOONPAY (origin `manual`) — é um AVISO. Sai pelo Modelo de Cobrança, que é
//     um template aprovado pela Meta, e por isso vale a qualquer hora,
//     inclusive com a janela de 24h fechada.
//
//   CHAT (origin `chat`) — é CONVERSA. O atendente está falando com a pessoa e
//     escreveu aquela mensagem ali, na hora. Texto livre não atravessa a
//     janela: dentro dela vai, fora dela não vai.
//
// Antes o template vencia sempre, e isso quebrava os DOIS lados:
//
//   · a mensagem que o atendente digitou no chat era DESCARTADA e saía o
//     template no lugar — outro texto, sem ele saber;
//   · e uma cobrança de conversa escapava da janela por uma porta que não era
//     dela.
//
// Este teste é o que impede a volta de qualquer um dos dois.
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
const wa = require(R + 'src/whatsapp');
const pagamentos = require(R + 'src/pagamentos');
const BASE = 'http://127.0.0.1:3973';

// O ADQUIRENTE É SIMULADO. O que este arquivo testa é POR ONDE a mensagem sai
// no WhatsApp, e para chegar lá a cobrança precisa nascer — sem gateway
// configurado ela morre antes, com 400, e o teste mediria outra coisa.
const woovi = require(R + 'src/woovi');
woovi.configured = () => true;
woovi.call = async (metodo, rota, corpo) => {
  if (String(rota).includes('/charge')) {
    return { charge: { correlationID: (corpo && corpo.correlationID) || 'x',
      brCode: '00020126580014BR.GOV.BCB.PIX0136teste', paymentLinkUrl: 'https://pay/x', status: 'ACTIVE' } };
  }
  return {};
};

// O que saiu de verdade pela Graph, para o teste olhar o CAMINHO e não a
// promessa. A Meta é simulada; o Koonfy até ela, não.
let enviados = [];
wa.sendTemplate = async (acc, to, name, lang, comps) => { enviados.push({ via: 'template', to, name, comps }); return { messages: [{ id: 'wamid.tpl' }] }; };
wa.sendInteractive = async (acc, to, inter) => { enviados.push({ via: 'interactive', to, inter }); return { messages: [{ id: 'wamid.btn' }] }; };
wa.sendText = async (acc, to, text) => { enviados.push({ via: 'text', to, text }); return { messages: [{ id: 'wamid.txt' }] }; };

(async () => {
  await db.loadAsync();

  const acc = db.newAccount({ name: 'Loja', email: 'loja@teste.com', pass: 'segredo123' });
  acc.billing.status = 'active';
  acc.billing.periodEnd = Date.now() + 30 * 86400000;
  acc.wa.connected = true; acc.wa.phoneNumberId = '111'; acc.wa.accessToken = 'T';
  db.get().accounts.push(acc);

  const ep = pagamentos.ensure(acc);
  ep.subaccount = { status: 'active', name: 'Loja', document: '11144477735',
    email: 'loja@teste.com', phone: '5511988887777', pixKey: '11144477735', pixKeyType: 'cpf' };
  // Um Modelo de Cobrança aprovado, marcado no papel de cobrança.
  // Os modelos vivem no CANAL. `acc.templatesCache` é só um apelido de leitura
  // para o cache do primeiro canal (ver attachTplAlias em src/db.js) — atribuir
  // nele não guarda nada, e o teste ficava sem modelo nenhum sem dizer por quê.
  acc.channels[0].templatesCache = { fetchedAt: Date.now(), list: [{
    name: 'cobranca_padrao', language: 'pt_BR', status: 'APPROVED',
    components: [{ type: 'BODY', text: 'Olá {{1}}, sua cobrança de {{2}}: {{3}}' }] }] };
  ep.templateRoles = { cobranca_padrao: 'cobranca' };
  ep.chargeTemplateName = 'cobranca_padrao';
  ep.chargeTemplateLang = 'pt_BR';

  // O contato: janela ABERTA (mensagem recebida agora).
  const agora = Date.now();
  acc.contacts = [{ waId: '5511900000001', name: 'Maria', vars: {}, lastInboundAt: agora }];
  acc.messages = [{ id: 'in1', waId: '5511900000001', direction: 'in', type: 'text', text: 'oi', timestamp: agora, status: 'received' }];
  db.save();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3973);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'loja@teste.com', pass: 'segredo123' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  const cobrar = async (origin, message, send = true) => {
    enviados = [];
    const r = await fetch(BASE + '/api/pagamentos/charges', {
      method: 'POST', headers: aut,
      body: JSON.stringify({ valueCents: 14990, comment: 'Plano', waId: '5511900000001',
        origin, message: message || '', send })
    });
    return { http: r.status, corpo: await r.json().catch(() => ({})) };
  };

  const abrirJanela = () => {
    const c = acc.contacts[0];
    c.lastInboundAt = Date.now();
    acc.messages[0].timestamp = Date.now();
    if (c.session) { c.session.status = 'open'; c.session.expiresAt = Date.now() + 86400000; }
    db.save();
  };
  const fecharJanela = () => {
    const velho = Date.now() - 30 * 3600 * 1000;    // 30h atrás
    const c = acc.contacts[0];
    c.lastInboundAt = velho;
    acc.messages[0].timestamp = velho;
    if (c.session) { c.session.status = 'expired'; c.session.expiresAt = velho; }
    db.save();
  };

  console.log('=== 1. Koonpay, janela ABERTA: sai pelo Modelo ===');
  abrirJanela();
  let r = await cobrar('manual');
  ok(r.corpo.sent === true, 'enviada');
  ok(enviados[0] && enviados[0].via === 'template', `pelo template: ${enviados[0] && enviados[0].via}`);
  ok(enviados[0] && enviados[0].name === 'cobranca_padrao', 'e é o modelo marcado: ' + (enviados[0] && enviados[0].name));

  console.log('\n=== 2. Koonpay, janela FECHADA: sai do mesmo jeito ===');
  // É o ponto do template: ele é aprovado pela Meta e não depende da janela.
  fecharJanela();
  r = await cobrar('manual');
  ok(r.corpo.sent === true, 'enviada com a janela fechada');
  ok(enviados[0] && enviados[0].via === 'template', 'pelo template, como deve ser');
  ok(!r.corpo.sendError, `e sem erro: ${r.corpo.sendError || '—'}`);

  console.log('\n=== 3. Chat, janela ABERTA: sai a mensagem DO ATENDENTE ===');
  // O texto que ele escreveu ali é o que a pessoa precisa ler. Antes o template
  // vencia e esse texto era descartado — outro conteúdo, sem ele saber.
  abrirJanela();
  r = await cobrar('chat', 'Maria, segue o link do seu plano como combinamos!');
  ok(r.corpo.sent === true, 'enviada');
  ok(enviados[0] && enviados[0].via !== 'template',
     `NÃO foi pelo template: ${enviados[0] && enviados[0].via}`);
  const saiu = JSON.stringify(enviados[0]);
  ok(/como combinamos/.test(saiu), 'e o texto do atendente foi junto');

  console.log('\n=== 4. Chat, janela FECHADA: não sai ===');
  // Texto livre não atravessa a janela. E antes atravessava, porque o template
  // entrava no lugar — uma porta que não era dela.
  fecharJanela();
  r = await cobrar('chat', 'Maria, segue o link!');
  ok(r.corpo.sent === false, 'não enviada');
  ok(enviados.length === 0, 'nada foi para a Meta');
  ok(/janela/i.test(r.corpo.sendError || ''), `e o motivo é a janela: "${r.corpo.sendError}"`);
  // A saída existe, e a mensagem precisa apontá-la.
  ok(/Koonpay/i.test(r.corpo.sendError || ''),
     'a mensagem diz o caminho que funciona: gerar pelo Koonpay');
  // A cobrança em si continua criada: perder o registro por causa do envio
  // seria trocar um problema por outro maior.
  ok(!!r.corpo.charge && r.corpo.charge.id, 'a cobrança existe, só não foi entregue');

  console.log('\n=== 5. Sem Modelo aprovado, o Koonpay também respeita a janela ===');
  // Sem template não há como furar a janela: aí a cobrança do Koonpay vira
  // texto/botão como qualquer outra, e a regra da Meta vale igual.
  ep.chargeTemplateName = '';
  ep.templateRoles = {};
  db.save();
  fecharJanela();
  r = await cobrar('manual');
  ok(r.corpo.sent === false, 'sem modelo e fora da janela, não sai');
  ok(/janela|24h/i.test(r.corpo.sendError || ''), `pelo motivo certo: "${r.corpo.sendError}"`);

  abrirJanela();
  r = await cobrar('manual');
  ok(r.corpo.sent === true, 'e dentro da janela sai normalmente');
  ok(enviados[0] && enviados[0].via !== 'template', 'como texto/botão, já que não há modelo');

  srv.close();
  await encerrar(srv, falhas);
})();
