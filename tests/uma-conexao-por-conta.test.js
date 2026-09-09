// ============================================================================
// UMA CONTA, UMA CONEXÃO DE WHATSAPP
//
// O painel já teve vários números por conta. A ideia parecia boa e cobrou o
// preço mais caro que existe num CRM: a conversa sumindo da tela.
//
// Cada contato e cada mensagem carregava um `chId` — o canal de origem — e a
// caixa de entrada só mostrava o que batia com o canal ativo. Só que esse id
// muda mais do que parece: reconectar o WhatsApp, trocar de número, recriar a
// conexão, e o id anterior morre. Tudo que estava carimbado com ele continuava
// no banco e desaparecia da tela. Sem erro, sem aviso: "Nenhuma conversa".
//
// Havia ainda um segundo caminho para o mesmo sumiço, este do lado do
// navegador: o canal escolhido ficava salvo em localStorage e ia no header
// `x-channel` de TODA chamada. Depois de reconectar o número, o navegador
// seguia pedindo as conversas de um canal que não existia mais.
//
// Agora a conta tem UM canal, `colapsarCanais` conserta o que ficou torto, e
// nada mais filtra conversa por canal. Cada bloco abaixo tranca um desses
// caminhos — porque o sintoma é sempre o mesmo e é sempre invisível.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
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
const store = require(R + 'src/store');
const wa = require(R + 'src/whatsapp');
wa.markRead = async () => ({ success: true });

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

  const acc = db.findAccountByEmail('loja@ex.com');
  const canal = (id, label, phoneId, conectado) => ({
    id, label, createdAt: Date.now(), archived: false, canceledAt: 0, cancelAt: 0,
    wa: { connected: conectado, accessToken: 'T', wabaId: 'W', phoneNumberId: phoneId,
          displayPhoneNumber: '+55 11 90000-0001' },
    templatesCache: { fetchedAt: 0, list: [] }
  });

  console.log('=== 1. Duas conexões na conta viram uma — e a que vale é a conectada ===');
  // A conta do relato tinha dois canais: um resíduo desconectado na frente e o
  // número de verdade atrás. `channels[0]` era o resíduo, então o padrão do
  // painel apontava para um número que não recebia nada.
  acc.channels = [canal('ch_velho', 'Antigo', 'PHONE_VELHO', false),
                  canal('ch_novo', 'Atual', 'PHONE_NOVO', true)];
  db.ensureAccountShape(acc);
  ok(acc.channels.length === 1, `sobra uma conexão: ${acc.channels.length}`);
  ok(acc.channels[0].id === 'ch_novo', 'e é a CONECTADA, não a que estava na frente da lista');
  ok((acc.channelsRemovidos || []).some(c => c.id === 'ch_velho'),
     'a outra é guardada, não jogada fora — o token dela continua lá se for preciso');

  console.log('\n=== 2. O contato carimbado num canal MORTO volta a aparecer ===');
  // Este era o sintoma exato: a conversa estava no banco, com mensagem e tudo,
  // e a tela dizia "Nenhuma conversa". O contato apontava para um canal que
  // não existe mais, e o filtro o descartava em silêncio.
  const CLIENTE = '5511955554444';
  acc.contacts = [{ waId: CLIENTE, chId: 'ch_MORTO', name: 'Maria', phone: CLIENTE, tags: [],
                    stage: 'Novo', unread: 2, createdAt: 1, lastMessageAt: 3000,
                    attendance: { status: 'open' }, vars: {} }];
  acc.messages = [
    { id: 'wamid.1', waId: CLIENTE, chId: 'ch_MORTO', direction: 'in', timestamp: 1000, text: 'oi' },
    { id: 'wamid.2', waId: CLIENTE, chId: 'ch_MORTO', direction: 'in', timestamp: 3000, text: 'alguém aí?' }
  ];
  db.ensureAccountShape(acc);
  ok(acc.contacts[0].chId === 'ch_novo', 'o contato é reetiquetado para a conexão que existe');
  ok(acc.messages.every(m => m.chId === 'ch_novo'), 'e as mensagens dele junto');
  db.save();

  const lista = await json(await fetch(BASE + '/api/conversations', { headers: cabecalho() }));
  ok(lista.conversations.length === 1, `a conversa aparece: ${lista.conversations.length}`);
  ok(lista.conversations[0].lastMessage.text === 'alguém aí?',
     'com a última fala certa: ' + lista.conversations[0].lastMessage.text);
  const aberta = await json(await fetch(BASE + '/api/messages/' + CLIENTE, { headers: cabecalho() }));
  ok((aberta.messages || []).length === 2, `e abre com as duas mensagens: ${(aberta.messages || []).length}`);

  console.log('\n=== 3. Um x-channel VELHO no navegador não esconde mais nada ===');
  // O id ficava salvo em localStorage por tempo indefinido. Mesmo depois do
  // conserto no banco, o navegador continuava pedindo um canal que morreu.
  const comVelho = await json(await fetch(BASE + '/api/conversations', { headers: cabecalho('ch_MORTO') }));
  ok(comVelho.conversations.length === 1,
     `pedindo por um canal que não existe, a conversa continua vindo: ${comVelho.conversations.length}`);
  const front = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(!/'x-channel'/.test(front), 'e o painel não manda mais esse cabeçalho');
  ok(/localStorage.removeItem\('ec_channel'\)/.test(front),
     'apagando também o que já estava salvo em quem tem a versão antiga aberta');

  console.log('\n=== 4. O telefone é a identidade — não (canal, telefone) ===');
  // Buscar por (canal, telefone) fazia o webhook não achar o contato existente
  // quando o id mudava, e criar OUTRO com o mesmo número. A conversa antiga
  // ficava órfã e a nova começava do zero.
  const achado = store.findContact(acc, CLIENTE);
  ok(!!achado && achado.name === 'Maria', 'acha o contato só pelo telefone');
  const antes = acc.contacts.length;
  store.upsertContact(acc, CLIENTE, 'Maria');
  ok(acc.contacts.length === antes, `e não cria um segundo com o mesmo número: ${acc.contacts.length}`);

  console.log('\n=== 5. O painel não oferece mais "adicionar número" ===');
  const criar = await fetch(BASE + '/api/channels', { method: 'POST', headers: cabecalho(), body: '{}' });
  ok(criar.status === 409, `criar uma segunda conexão é recusado: ${criar.status}`);
  ok(/Cada conta tem uma conexão de WhatsApp/.test((await criar.json()).error || ''),
     'com o motivo escrito, e o caminho: outra conta para outro número');
  ok(acc.channels.length === 1, 'e a conta continua com uma conexão');
  ok(!/onclick="createChannel\(\)"/.test(front) && !/function createChannel/.test(front),
     'o botão de criar sumiu da tela');
  ok(!/function switchChannel/.test(front), 'e o seletor de troca também — não há para onde trocar');

  console.log('\n=== 6. A IA não fica presa a um canal que morreu ===');
  // A IA podia ser restrita a alguns números. Com a lista apontando para um id
  // morto, ela simplesmente nunca respondia — e nada na tela dizia por quê.
  acc.ia = { enabled: true, apiKey: '', model: 'gpt-4.1-mini', prompt: '',
             channels: ['ch_MORTO'], historico: 12, maxSaida: 600, assinatura: '', logs: [] };
  db.ensureAccountShape(acc);
  ok(acc.ia.channels.length === 0, 'a restrição por canal é limpa: vale para a conexão da conta');

  await encerrar(srv, falhas);
})();
