// BI AO VIVO DO DISPARO: resposta do contato e link público de acompanhamento.
//
// Existe por duas coisas que dão errado calado:
//
// A RESPOSTA precisa de âncora no tempo. Contar "mensagem de entrada daquele
// contato" como resposta à campanha faz qualquer conversa antiga virar
// resultado do disparo — e a taxa de resposta, que é a métrica que uma agência
// mostra para renovar contrato, viraria ficção. Aqui a regra é: depois do
// envio, dentro de sete dias.
//
// O LINK é um portador: quem tem o endereço vê. Então ele precisa mascarar o
// telefone por padrão, mostrar só a campanha dele, e morrer quando revogado.
// Um link que continua abrindo depois de revogado é pior que não ter revogação.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// Banco de mentira: este teste zera mensagens e campanhas para montar o
// cenário, e fazer isso no banco de desenvolvimento apagaria dados reais.
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
const BASE = 'http://127.0.0.1:3993';
const j = async (r) => ({ status: r.status, corpo: await r.json().catch(() => ({})) });

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3993);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  const aut = { Authorization: 'Bearer ' + tok };
  ok(!!tok, 'admin entrou');

  const acc = db.get().accounts[0];
  acc.messages = [];
  acc.campaigns = [];
  acc.contacts = [
    { waId: '5511988880001', name: 'Quem respondeu', vars: {} },
    { waId: '5521988880002', name: 'Quem só leu', vars: {} },
    { waId: '5531988880003', name: 'Quem respondeu antes', vars: {} },
    { waId: '5541988880004', name: 'Quem respondeu tarde', vars: {} }
  ];

  const envio = Date.now() - 3600000;               // o disparo saiu há uma hora
  const camp = {
    id: 'camp_bi', name: 'Disparo com BI', templateName: 'promo', language: 'pt_BR',
    chId: '', chLabel: 'Principal', vars: [], audience: { type: 'all' },
    createdAt: envio - 60000, status: 'done', finishedAt: envio,
    recipients: acc.contacts.map((c, i) => {
      const msgId = 'wamid.' + i;
      acc.messages.push({ id: msgId, waId: c.waId, direction: 'out', status: 'read', timestamp: envio });
      return { waId: c.waId, status: 'sent', msgId, sentAt: envio };
    })
  };
  acc.campaigns.push(camp);

  // Uma resposta de verdade, dez minutos DEPOIS do disparo.
  acc.messages.push({ id: 'in.1', waId: '5511988880001', direction: 'in', type: 'text',
    text: 'Quero sim, me manda o link', timestamp: envio + 600000, status: 'received' });
  // Uma conversa ANTIGA do mesmo tipo, um dia ANTES do disparo.
  acc.messages.push({ id: 'in.2', waId: '5531988880003', direction: 'in', type: 'text',
    text: 'Oi, tudo bem?', timestamp: envio - 86400000, status: 'received' });
  // E uma oito dias DEPOIS: fora da janela.
  acc.messages.push({ id: 'in.3', waId: '5541988880004', direction: 'in', type: 'text',
    text: 'Vi agora', timestamp: envio + 8 * 86400000, status: 'received' });
  db.save();

  console.log('\n=== 1. Resposta só conta se veio DEPOIS do disparo e dentro da janela ===');
  const rel = (await j(await fetch(BASE + '/api/campaigns/camp_bi/report', { headers: aut }))).corpo;
  ok(rel.geral.respostas === 1, `uma resposta, e não três: ${rel.geral.respostas}`);
  const p1 = rel.pessoas.find(p => p.waId === '5511988880001');
  const p3 = rel.pessoas.find(p => p.waId === '5531988880003');
  const p4 = rel.pessoas.find(p => p.waId === '5541988880004');
  ok(p1 && p1.resposta && /Quero sim/.test(p1.resposta.texto), 'e o relatório traz o texto do que a pessoa escreveu');
  ok(p3 && !p3.resposta, 'conversa de ontem não vira resposta ao disparo de hoje');
  ok(p4 && !p4.resposta, 'mensagem de oito dias depois fica fora da janela');
  ok(rel.geral.taxaResposta === 25, `taxa de resposta sobre quem recebeu: ${rel.geral.taxaResposta}%`);

  console.log('\n=== 2. Quem respondeu vem na frente ===');
  // Um relatório em ordem de disparo esconde as respostas no meio da lista.
  ok(rel.pessoas[0].waId === '5511988880001', 'a primeira linha é a de quem respondeu');
  ok(rel.pessoas.length === 4, `e todo mundo continua na lista: ${rel.pessoas.length}`);

  console.log('\n=== 3. O link de acompanhamento nasce mascarado ===');
  const criado = (await j(await fetch(BASE + '/api/campaigns/camp_bi/share', {
    method: 'POST', headers: { ...aut, 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefones: false })
  }))).corpo;
  const token = criado.share && criado.share.token;
  ok(!!token && token.length >= 32, 'o token tem tamanho de segredo, não de id');
  ok(/\/campanha\//.test(criado.url || ''), `e volta com o endereço pronto: ${criado.url}`);

  const pub = (await j(await fetch(BASE + '/api/public/campanha/' + token))).corpo;
  ok(pub.geral.respostas === 1, 'o link mostra os mesmos números do painel');
  ok(pub.conta === acc.name, 'e diz de quem é a campanha');
  const pubP1 = pub.pessoas.find(p => /Quem respondeu$/.test(p.nome));
  ok(pubP1 && pubP1.waId.includes('•'), `telefone mascarado por padrão: ${pubP1 && pubP1.waId}`);
  ok(pubP1 && pubP1.waId.endsWith('0001'), 'com o final visível, que é o que identifica sem expor');
  ok(pubP1 && /Quero sim/.test(pubP1.resposta.texto), 'a resposta continua legível, que é o motivo do link');

  console.log('\n=== 3b. O convite leva o link de AFILIADO de quem compartilhou ===');
  // Quem manda o link está fazendo marketing da Koonfy de graça: se alguém
  // assinar por causa disso, a comissão é dele. Sem o código, o convite seria a
  // plataforma usando a base do cliente para vender sozinha — e o cliente
  // descobriria, e pararia de compartilhar.
  ok(!!pub.convite && !!pub.convite.link, 'o convite vem junto no relatório público');
  ok(pub.convite && pub.convite.link.includes('ref=' + acc.affiliate.code),
     `com o código do afiliado dono da campanha: ${pub.convite && pub.convite.link}`);
  ok(pub.convite && pub.convite.por === acc.name, 'e o nome de quem compartilhou');

  console.log('\n=== 4. Quem quiser mostrar o telefone inteiro, mostra de propósito ===');
  const aberto = (await j(await fetch(BASE + '/api/campaigns/camp_bi/share', {
    method: 'POST', headers: { ...aut, 'Content-Type': 'application/json' },
    body: JSON.stringify({ telefones: true })
  }))).corpo;
  ok(aberto.share.token !== token, 'gerar de novo TROCA o token — é assim que se derruba um link vazado');
  const antigo = await fetch(BASE + '/api/public/campanha/' + token);
  ok(antigo.status === 404, `e o endereço anterior morre: ${antigo.status}`);
  const pub2 = (await j(await fetch(BASE + '/api/public/campanha/' + aberto.share.token))).corpo;
  const cheio = pub2.pessoas.find(p => p.waId === '5511988880001');
  ok(!!cheio, 'com a opção ligada o número sai inteiro');

  console.log('\n=== 5. Revogar fecha a porta ===');
  const del = await fetch(BASE + '/api/campaigns/camp_bi/share', { method: 'DELETE', headers: aut });
  ok(del.status === 200, 'o dono revoga');
  const depois = await fetch(BASE + '/api/public/campanha/' + aberto.share.token);
  ok(depois.status === 404, `e o link revogado não abre mais: ${depois.status}`);

  console.log('\n=== 6. O link não é uma chave da conta ===');
  // Um token que abrisse outras campanhas seria uma sessão disfarçada.
  const outra = { ...camp, id: 'camp_outra', name: 'Outra', share: null, recipients: [] };
  acc.campaigns.push(outra);
  db.save();
  const novo = (await j(await fetch(BASE + '/api/campaigns/camp_bi/share', {
    method: 'POST', headers: { ...aut, 'Content-Type': 'application/json' }, body: '{}'
  }))).corpo;
  const so = (await j(await fetch(BASE + '/api/public/campanha/' + novo.share.token))).corpo;
  ok(so.id === 'camp_bi', 'o token abre a campanha dele');
  const inventado = await fetch(BASE + '/api/public/campanha/' + 'f'.repeat(32));
  ok(inventado.status === 404, 'e um token inventado não abre nada');
  const semAuth = await fetch(BASE + '/api/campaigns/camp_bi/report');
  ok(semAuth.status === 401, 'a rota do painel continua exigindo sessão');

  srv.close();
  await encerrar(srv, falhas);
})();
