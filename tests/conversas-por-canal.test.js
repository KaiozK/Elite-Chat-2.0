// ============================================================================
// CONVERSA DE UM NÚMERO NÃO ENTRA NA DE OUTRO
//
// Cada canal é uma conexão WhatsApp independente, com conversas e contatos
// próprios. A MESMA PESSOA falando com dois números da empresa tem duas
// conversas separadas — e é aí que tudo pode vazar, porque o identificador
// dela (o telefone) é o mesmo nos dois lados.
//
// Cada bloco aqui é um lugar onde o telefone era usado sozinho, sem o canal:
//
//   · a lista de conversas mostrava a última mensagem do OUTRO número;
//   · abrir a conversa trazia as duas embaralhadas;
//   · marcar como lida mandava o recibo pelo número errado;
//   · apagar o contato apagava a pessoa nos DOIS canais, com o histórico;
//   · desligar a IA desligava na conversa errada.
//
// O que amarra tudo: responder pelo número errado é um erro que o cliente vê,
// e não dá para desfazer depois de enviado.
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

const db = require(R + 'src/db');
const wa = require(R + 'src/whatsapp');

// Por qual NÚMERO o recibo de leitura saiu. É o que prova que a Koonfy falou
// pelo canal certo — e era o que estava errado.
let recibos = [];
wa.markRead = async (acc, msgId) => {
  recibos.push({ phoneNumberId: acc.wa.phoneNumberId, msgId });
  return { success: true };
};

const BASE = 'http://127.0.0.1:3995';
const json = r => r.json();

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3995);
  await new Promise(r => setTimeout(r, 150));

  db.get().platform.billing.requirePlan = false;
  db.save();

  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Loja', email: 'loja@ex.com', pass: 'segredo123',
      profile: { phone: '11988887777', country: 'BR' }, recebimento: { document: '39053344705' }
    })
  });
  const ent = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'loja@ex.com', pass: 'segredo123' })
  }));
  const cabecalho = (ch) => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + ent.token,
    ...(ch ? { 'x-channel': ch } : {})
  });

  // ---- DOIS NÚMEROS, e a MESMA pessoa falando com os dois ----
  const acc = db.findAccountByEmail('loja@ex.com');
  acc.channels = [
    { id: 'ch_vendas', label: 'Vendas', createdAt: Date.now(), archived: false, canceledAt: 0, cancelAt: 0,
      wa: { connected: true, accessToken: 'T1', wabaId: 'W1', phoneNumberId: 'PHONE_VENDAS',
            displayPhoneNumber: '+55 11 90000-0001' },
      templatesCache: { fetchedAt: 0, list: [] } },
    { id: 'ch_suporte', label: 'Suporte', createdAt: Date.now(), archived: false, canceledAt: 0, cancelAt: 0,
      wa: { connected: true, accessToken: 'T2', wabaId: 'W2', phoneNumberId: 'PHONE_SUPORTE',
            displayPhoneNumber: '+55 11 90000-0002' },
      templatesCache: { fetchedAt: 0, list: [] } }
  ];
  const CLIENTE = '5511955554444';
  acc.contacts = [
    { waId: CLIENTE, chId: 'ch_vendas', name: 'Maria (vendas)', phone: CLIENTE, tags: [], stage: 'Novo',
      unread: 2, createdAt: 1, lastMessageAt: 1000, attendance: { status: 'open' }, vars: {} },
    { waId: CLIENTE, chId: 'ch_suporte', name: 'Maria (suporte)', phone: CLIENTE, tags: [], stage: 'Novo',
      unread: 1, createdAt: 2, lastMessageAt: 2000, attendance: { status: 'open' }, vars: {} }
  ];
  acc.messages = [
    { id: 'wamid.V1', waId: CLIENTE, chId: 'ch_vendas', direction: 'in', timestamp: 1000, text: 'quero comprar' },
    { id: 'wamid.S1', waId: CLIENTE, chId: 'ch_suporte', direction: 'in', timestamp: 2000, text: 'meu pedido atrasou' },
    { id: 'wamid.S2', waId: CLIENTE, chId: 'ch_suporte', direction: 'in', timestamp: 3000, text: 'alguém aí?' }
  ];
  db.save();

  console.log('=== 1. A lista de conversas mostra a fala DAQUELE número ===');
  // A última mensagem era guardada por telefone, e não por (canal, telefone).
  // As duas conversas mostravam a fala de quem chegou por último — a conversa
  // de Vendas exibia o que foi dito ao Suporte.
  const lVendas = await json(await fetch(BASE + '/api/conversations', { headers: cabecalho('ch_vendas') }));
  ok(lVendas.conversations.length === 1, `Vendas mostra uma conversa: ${lVendas.conversations.length}`);
  ok(lVendas.conversations[0].name === 'Maria (vendas)', 'a de Vendas');
  ok(lVendas.conversations[0].lastMessage.text === 'quero comprar',
     'com a última fala DELA: ' + lVendas.conversations[0].lastMessage.text);

  const lSup = await json(await fetch(BASE + '/api/conversations', { headers: cabecalho('ch_suporte') }));
  ok(lSup.conversations.length === 1, 'Suporte mostra a dele');
  ok(lSup.conversations[0].lastMessage.text === 'alguém aí?',
     'com a última fala de lá: ' + lSup.conversations[0].lastMessage.text);

  console.log('\n=== 2. Sem cabeçalho, a caixa NÃO mistura ===');
  // `chanFilter` devolvia "sem filtro" quando o pedido chegava sem canal, e a
  // caixa de entrada virava uma pilha dos dois números. Responder ali é
  // responder pelo número errado — erro que o cliente vê e não desfaz.
  const semCab = await json(await fetch(BASE + '/api/conversations', { headers: cabecalho() }));
  ok(semCab.conversations.length === 1,
     `sem canal, vale o ativo — e não os dois: ${semCab.conversations.length}`);
  ok(semCab.chId === 'ch_vendas', 'a resposta diz qual canal está valendo: ' + semCab.chId);

  console.log('\n=== 3. A visão geral existe, mas é EXPLÍCITA ===');
  const tudo = await json(await fetch(BASE + '/api/conversations?ch=all', { headers: cabecalho() }));
  ok(tudo.conversations.length === 2, `com ch=all vêm as duas: ${tudo.conversations.length}`);
  // E mesmo ali cada linha mostra a SUA última mensagem — a chave passou a ser
  // (canal, telefone).
  const porNome = Object.fromEntries(tudo.conversations.map(c => [c.name, c.lastMessage.text]));
  ok(porNome['Maria (vendas)'] === 'quero comprar',
     'cada linha com a fala do seu número: ' + porNome['Maria (vendas)']);
  ok(porNome['Maria (suporte)'] === 'alguém aí?', 'inclusive na visão geral');

  console.log('\n=== 4. Abrir a conversa traz UMA conversa ===');
  const mV = await json(await fetch(BASE + '/api/messages/' + CLIENTE, { headers: cabecalho('ch_vendas') }));
  ok(mV.messages.length === 1, `Vendas: ${mV.messages.length} mensagem`);
  ok(mV.messages[0].text === 'quero comprar', 'a certa');
  const mS = await json(await fetch(BASE + '/api/messages/' + CLIENTE, { headers: cabecalho('ch_suporte') }));
  ok(mS.messages.length === 2, `Suporte: ${mS.messages.length} mensagens`);
  ok(mS.messages.every(m => m.chId === 'ch_suporte'), 'todas do canal certo');
  ok(mS.contact.name === 'Maria (suporte)', 'e o contato é o daquele canal: ' + mS.contact.name);

  console.log('\n=== 5. O recibo de leitura sai pelo número CERTO ===');
  // Duas coisas erradas moravam aqui: a última mensagem recebida era procurada
  // em todos os canais, e o recibo saía sempre pelo primeiro canal. A Meta
  // recusa (a mensagem não é daquele número) ou marca lida a conversa errada.
  recibos = [];
  await fetch(BASE + '/api/messages/' + CLIENTE + '/read', { method: 'POST', headers: cabecalho('ch_suporte') });
  ok(recibos.length === 1, 'um recibo');
  ok(recibos[0].phoneNumberId === 'PHONE_SUPORTE',
     'pelo número da conversa: ' + recibos[0].phoneNumberId);
  ok(recibos[0].msgId === 'wamid.S2', 'e sobre a última mensagem DELA: ' + recibos[0].msgId);

  const acc5 = db.findAccountByEmail('loja@ex.com');
  ok(acc5.contacts.find(c => c.chId === 'ch_suporte').unread === 0, 'zera o não-lido do canal');
  ok(acc5.contacts.find(c => c.chId === 'ch_vendas').unread === 2,
     'e não mexe no do outro: ' + acc5.contacts.find(c => c.chId === 'ch_vendas').unread);

  console.log('\n=== 6. Desligar a IA desliga na conversa CERTA ===');
  await fetch(BASE + '/api/ia/conversa/' + CLIENTE, {
    method: 'PUT', headers: cabecalho('ch_suporte'), body: JSON.stringify({ ligada: false })
  });
  const acc6 = db.findAccountByEmail('loja@ex.com');
  // `alternarNaConversa` grava `iaOff` no contato. A pergunta é EM QUAL
  // contato: antes, a busca era só pelo telefone, e a marca podia cair na
  // conversa da mesma pessoa no outro número — enquanto a de verdade seguia
  // respondendo sozinha.
  const vSup = acc6.contacts.find(c => c.chId === 'ch_suporte');
  const vVen = acc6.contacts.find(c => c.chId === 'ch_vendas');
  ok(vSup.iaOff === true, `iaOff no contato do Suporte: ${vSup.iaOff}`);
  ok(vVen.iaOff === undefined, `e nada no de Vendas: ${vVen.iaOff}`);

  console.log('\n=== 7. Apagar apaga UMA conversa, não a pessoa inteira ===');
  // Apagava a pessoa em todos os canais, com o histórico junto, sem aviso e sem
  // volta. Quem falou com dois números tem duas conversas — apagar uma não pode
  // levar a outra.
  const del = await json(await fetch(BASE + '/api/contacts/' + CLIENTE, {
    method: 'DELETE', headers: cabecalho('ch_vendas')
  }));
  ok(del.apagados === 1, `apagou um contato: ${del.apagados}`);
  const acc7 = db.findAccountByEmail('loja@ex.com');
  ok(!acc7.contacts.some(c => c.chId === 'ch_vendas'), 'a conversa de Vendas some');
  ok(acc7.contacts.some(c => c.chId === 'ch_suporte'), 'a de Suporte CONTINUA');
  ok(acc7.messages.filter(m => m.chId === 'ch_suporte').length === 2,
     `com as mensagens dela intactas: ${acc7.messages.filter(m => m.chId === 'ch_suporte').length}`);
  ok(acc7.messages.filter(m => m.chId === 'ch_vendas').length === 0,
     'e só as do canal apagado saíram');

  console.log('\n=== 8. O aviso diz DE QUAL número, e não some ===');
  const fs = require('fs');
  const appjs = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const bloco = appjs.slice(appjs.indexOf('function maybeNotifyMessage'),
                            appjs.indexOf('function maybeNotifyMessage') + 1800);

  // O webhook já mandava o rótulo do canal e ninguém usava. Com dois números,
  // "Maria" não diz se ela escreveu para Vendas ou para o Suporte — e a
  // resposta muda conforme a porta por onde ela entrou.
  ok(/CHANNELS\.length > 1 && d\.notify\.channel/.test(bloco),
     'o aviso mostra o canal quando há mais de um');
  ok(/canal = \(CHANNELS\.length > 1/.test(bloco),
     'e some quando só há um, onde dizer isso seria ruído');

  // Aviso com a mesma etiqueta SUBSTITUI o anterior no sistema: com a etiqueta
  // só do telefone, a mensagem para o Suporte apagava da tela a de Vendas.
  ok(/tag: 'msg:' \+ \(d\.chId \|\| ''\) \+ ':' \+ d\.waId/.test(bloco),
     'a etiqueta carrega o canal, para um aviso não apagar o outro');
  ok(!/tag: 'msg:' \+ d\.waId/.test(bloco), 'e não só o telefone');

  // "Conversa aberta" é (canal, pessoa). Com a conversa de Vendas na tela, a
  // mensagem que a mesma pessoa mandou para o Suporte era engolida em silêncio.
  ok(/mesmaConversa = d\.waId === state\.currentWaId && \(!d\.chId \|\| !CH_ID \|\| d\.chId === CH_ID\)/.test(bloco),
     'e o silêncio da conversa aberta vale só para a conversa aberta MESMO');

  // E o webhook precisa mandar o rótulo, senão não há o que mostrar.
  const wh = fs.readFileSync(R + 'src/webhook.js', 'utf8');
  ok(/channel: canal \? canal\.label : ''/.test(wh),
     'o servidor manda o rótulo do canal no aviso');

  srv.close();
  await encerrar(null, falhas);
})();
