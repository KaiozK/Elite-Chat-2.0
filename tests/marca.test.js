// A MARCA: A IMAGEM E A PALAVRA SÃO COISAS SEPARADAS.
//
// Enviar uma logo apagava o nome do app. A rota gravava `platform.marca`
// inteiro a cada upload, e o campo `nome` recebia o nome do ARQUIVO — dois
// significados no mesmo apelido. Quem enviava "ChatGPT Image 3 de set.png" via
// o app passar a se chamar assim na aba do navegador e no atalho do celular, e
// a descrição, que nem vinha no corpo do pedido, sumia junto.
//
// O que este teste segura:
//   · upload mexe só na IMAGEM, e a marca escrita fica onde estava;
//   · /marca/logo devolve os bytes enviados, e não a arte do repositório;
//   · o manifesto do app acompanha o nome salvo — é ele que o celular mostra
//     na hora de instalar;
//   · voltar à logo padrão também não leva a palavra junto.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// Banco de mentira: o teste NÃO pode escrever no banco de desenvolvimento.
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

const porta = 3993;
const url = (r) => 'http://127.0.0.1:' + porta + r;

(async () => {
  const db = require(R + 'src/db');
  // db.save() e adiado em 250ms: recarregar antes disso leria o estado
  // anterior, e o teste mediria a gravacao errada.
  const assentar = () => new Promise(r => setTimeout(r, 320));
  await assentar();
  await db.loadAsync();
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}));

  // As duas rotas moram no server.js; aqui elas são montadas iguais, sobre o
  // MESMO banco, para o teste cobrir o que o navegador realmente baixa.
  app.get('/marca/logo', (req, res) => {
    const m = (db.get().platform && db.get().platform.marca) || {};
    if (!m.logo) return res.sendFile(path.join(R, 'public', 'assets', 'koonfy-192.png'));
    const buf = Buffer.from(m.logo, 'base64');
    res.set('Content-Type', m.mime || 'image/png');
    res.send(buf);
  });
  app.get('/app/manifest.webmanifest', (req, res) => {
    const mk = (db.get().platform && db.get().platform.marca) || {};
    const nome = String(mk.nome || '').trim() || 'Koonfy';
    const descr = String(mk.descricao || '').trim();
    res.json({ name: descr ? nome + ' | ' + descr : nome, short_name: nome.slice(0, 12) });
  });

  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(url('/api/adm/login'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  ok(!!tok, 'admin entrou');
  const cab = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };

  const escrever = (corpo) => fetch(url('/api/admin/brand/nome'), { method: 'PUT', headers: cab, body: JSON.stringify(corpo) })
    .then(async r => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));
  const enviar = (corpo) => fetch(url('/api/admin/brand'), { method: 'POST', headers: cab, body: JSON.stringify(corpo) })
    .then(async r => ({ http: r.status, ...(await r.json().catch(() => ({}))) }));
  const ler = () => fetch(url('/api/admin/brand'), { headers: cab }).then(r => r.json());
  const manifesto = () => fetch(url('/app/manifest.webmanifest')).then(r => r.json());
  const imagem = () => fetch(url('/marca/logo')).then(async r => ({
    tipo: r.headers.get('content-type'), bytes: Buffer.from(await r.arrayBuffer()) }));

  console.log('=== 1. A marca escrita é o que o app se chama ===');
  let r = await escrever({ nome: 'Koonfy', descricao: 'CRM de WhatsApp com IA' });
  ok(r.http === 200, 'nome e descrição salvos: ' + r.http);
  let mf = await manifesto();
  ok(mf.name === 'Koonfy | CRM de WhatsApp com IA', 'o instalador mostra: ' + mf.name);

  console.log('\n=== 2. Enviar uma logo NÃO renomeia o app ===');
  // O bug: `nome` recebia o nome do arquivo e a descrição sumia. Este é o
  // arquivo real que causou o problema.
  const png = fs.readFileSync(path.join(R, 'public', 'assets', 'koonfy-maskable-192.png'));
  const up = await enviar({ data: png.toString('base64'), mime: 'image/png', nome: 'ChatGPT Image 3 de set. de 2025.png' });
  ok(up.http === 200, 'logo enviada: ' + up.http);
  mf = await manifesto();
  ok(mf.name === 'Koonfy | CRM de WhatsApp com IA', 'o app continua se chamando Koonfy: ' + mf.name);
  ok(!/ChatGPT/i.test(mf.name), 'o nome do arquivo não vazou para a marca');
  let info = await ler();
  ok(info.nome === 'Koonfy', 'e o painel lê o nome certo: ' + JSON.stringify(info.nome));
  ok(info.arquivo === 'ChatGPT Image 3 de set. de 2025.png', 'o nome do arquivo vira etiqueta: ' + info.arquivo);

  console.log('\n=== 3. E a imagem servida é a que foi enviada ===');
  let img = await imagem();
  ok(img.bytes.equals(png), 'os bytes batem com o arquivo (' + img.bytes.length + ' bytes)');
  const padrao = fs.readFileSync(path.join(R, 'public', 'assets', 'koonfy-192.png'));
  ok(!img.bytes.equals(padrao), 'não é a arte do repositório');

  console.log('\n=== 4. Voltar ao padrão apaga a IMAGEM, não a palavra ===');
  const del = await fetch(url('/api/admin/brand'), { method: 'DELETE', headers: cab });
  ok(del.status === 200, 'logo removida: ' + del.status);
  img = await imagem();
  ok(img.bytes.equals(padrao), 'a arte do repositório voltou');
  mf = await manifesto();
  ok(mf.name === 'Koonfy | CRM de WhatsApp com IA', 'e o nome ficou de pé: ' + mf.name);

  console.log('\n=== 4b. O nome de arquivo JA GRAVADO e limpo na subida ===');
  // Corrigir a rota nao desfaz o que ela gravou ontem: quem enviou a logo
  // antes da correcao continua com o app se chamando "ChatGPT Image.png".
  // A limpeza roda no carregamento do banco.
  await escrever({ nome: 'ChatGPT Image 3 de set. de 2025.png', descricao: '' });
  mf = await manifesto();
  ok(mf.short_name === 'ChatGPT Imag', 'antes, o iPhone mostrava: ' + mf.short_name);
  await assentar();
  await db.loadAsync();
  mf = await manifesto();
  ok(mf.name === 'Koonfy', 'depois de subir, volta ao padrao: ' + mf.name);
  ok(String(db.get().platform.marca.arquivo || '').includes('ChatGPT'),
     'e o valor vira etiqueta do arquivo, nao some: ' + db.get().platform.marca.arquivo);

  // Um nome escolhido a mao NAO pode ser tocado.
  await escrever({ nome: 'Koonfy', descricao: 'CRM de WhatsApp com IA' });
  await assentar();
  await db.loadAsync();
  ok(db.get().platform.marca.nome === 'Koonfy', 'um nome de verdade sobrevive a subida');

  console.log('\n=== 5. Sem nome salvo, vale o padrão de fábrica ===');
  await escrever({ nome: '', descricao: '' });
  mf = await manifesto();
  ok(mf.name === 'Koonfy', 'instalação nova funciona sem ninguém preencher nada: ' + mf.name);

  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
