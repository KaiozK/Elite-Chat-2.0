// PERSONALIZAÇÃO — as cores da marca saem do Admin e valem no ato.
//
// O caminho é o mesmo da logo: o admin salva no painel, o valor vive no banco
// e /tema.css redefine as variáveis que o CSS já usa. Duas coisas precisam
// valer sempre:
//   · campo VAZIO não é escrito — o padrão do style.css continua valendo, e é
//     assim que se desfaz um ajuste ruim sem lembrar o valor original;
//   · nada além de HEX entra, porque este valor vira folha de estilo e texto
//     livre ali seria deixar o campo do painel escrever CSS arbitrário.
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

const porta = 3991;
const url = (r) => 'http://127.0.0.1:' + porta + r;

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));

  // A rota /tema.css mora no server.js; aqui ela é montada igual, sobre o
  // MESMO banco, para o teste cobrir a folha de estilo de verdade.
  const crypto = require('crypto');
  app.get('/tema.css', (req, res) => {
    const t = (db.get().platform && db.get().platform.tema) || {};
    const cor = (v) => { const s = String(v || '').trim(); return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : ''; };
    const linhas = [];
    const por = (nome, valor) => { const c = cor(valor); if (c) linhas.push(`  ${nome}: ${c};`); };
    por('--verde-esc', t.verde); por('--btn-verde', t.botao); por('--btn-verde-hover', t.botaoHover);
    por('--btn-tinta', t.tintaBotao); por('--verde-deep', t.verdeDeep);
    por('--menu-ativo', t.menu); por('--menu-tinta', t.menuTinta);
    const menu = cor(t.menu);
    if (menu) {
      const rgb = menu.length === 4
        ? menu.slice(1).split('').map(h => parseInt(h + h, 16))
        : [menu.slice(1, 3), menu.slice(3, 5), menu.slice(5, 7)].map(h => parseInt(h, 16));
      linhas.push(`  --menu-brilho: rgba(${rgb.join(', ')}, .35);`);
    }
    const funil = Array.isArray(t.funil) ? t.funil.map(cor).filter(Boolean) : [];
    funil.forEach((c, i) => linhas.push(`  --funil-${i + 1}: ${c};`));
    if (funil.length) linhas.push(`  --funil-n: ${funil.length};`);
    const css = linhas.length ? `:root{\n${linhas.join('\n')}\n}\n` : '/* tema padrão */\n';
    const etag = '"tema-' + crypto.createHash('sha1').update(css).digest('hex').slice(0, 16) + '"';
    res.set('ETag', etag); res.set('Content-Type', 'text/css; charset=utf-8');
    if (req.get('if-none-match') === etag) return res.status(304).end();
    res.send(css);
  });

  const srv = app.listen(porta);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(url('/api/adm/login'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  ok(!!tok, 'admin entrou');
  const salvar = (corpo) => fetch(url('/api/admin/tema'), {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify(corpo)
  }).then(async r => ({ http: r.status, ...(await r.json()) }));
  const css = () => fetch(url('/tema.css')).then(async r => ({ http: r.status, etag: r.headers.get('etag'), texto: await r.text() }));

  console.log('=== 1. Sem personalização, o padrão do CSS manda ===');
  let c = await css();
  ok(!c.texto.includes(':root'), 'a folha não redefine nada: ' + c.texto.trim());

  console.log('\n=== 2. O que o admin salva vira variável ===');
  let r = await salvar({ botao: '#123456', tintaBotao: '#ffffff' });
  ok(r.http === 200, 'salvou: ' + r.http);
  c = await css();
  ok(c.texto.includes('--btn-verde: #123456'), 'a cor do botão entrou');
  ok(c.texto.includes('--btn-tinta: #ffffff'), 'a tinta do botão também');
  ok(!c.texto.includes('--verde-deep'), 'o campo que ficou vazio NÃO é escrito, o padrão vale');

  console.log('\n=== 2b. A COR DA MARCA não é mais escolhida ===');
  // A palavra "Koonfy" virou desenho: não há mais o "fy" para pintar, e o
  // campo saiu do Admin. Mandar a cor pela rota não pode voltar a valer.
  await salvar({ verde: '#ff0066' });
  c = await css();
  ok(!c.texto.includes('#ff0066'), 'a cor mandada é ignorada');
  ok(!c.texto.includes('--verde-esc'), 'e o token da marca fica com o padrão do CSS');

  console.log('\n=== 3. Campo vazio DESFAZ a personalização ===');
  await salvar({ botao: '' });
  c = await css();
  ok(!c.texto.includes('--btn-verde'), 'o botão voltou ao padrão');
  await salvar({ botao: '#123456' });
  c = await css();
  ok(c.texto.includes('--btn-verde: #123456'), 'e volta a valer quando é preenchido de novo');

  console.log('\n=== 4. Só HEX entra ===');
  // Este valor vira CSS. Sem a trava, o campo do painel escreveria regra.
  for (const ruim of ['red', 'javascript:1', '#12345', 'rgb(0,0,0)', '#fff;} body{display:none', 'expression(alert(1))']) {
    const rr = await salvar({ botao: ruim });
    ok(rr.http === 400, `recusado: ${JSON.stringify(ruim).slice(0, 34)} → ${rr.http}`);
  }
  c = await css();
  ok(c.texto.includes('--btn-verde: #123456'), 'e nada disso encostou no valor salvo');
  ok(!/display:none|expression|javascript/i.test(c.texto), 'a folha continua limpa');

  console.log('\n=== 4b. MENU LATERAL ===');
  // O verde do item ativo tem token próprio: antes vinha de --verde, que também
  // pinta chips e selos pelo app inteiro, e mudar o menu mexia no resto.
  r = await salvar({ menu: '#7c3aed', menuTinta: '#ffffff' });
  ok(r.http === 200, 'salvou a cor do menu: ' + r.http);
  c = await css();
  ok(c.texto.includes('--menu-ativo: #7c3aed'), 'o item ativo do menu recebe a cor');
  ok(c.texto.includes('--menu-tinta: #ffffff'), 'e a tinta de dentro dele');
  // O brilho embaixo do item ativo acompanha: com a cor nova e a sombra antiga,
  // sobrava um halo verde por baixo de um menu roxo.
  ok(c.texto.includes('--menu-brilho: rgba(124, 58, 237, .35)'),
    'o brilho é derivado da mesma cor: ' + (c.texto.match(/--menu-brilho:[^;]*/) || [''])[0].trim());
  ok(!c.texto.includes('--verde-esc'), 'e mudar o menu NÃO mexeu na cor da marca');

  console.log('\n=== 5. Cores do funil ===');
  r = await salvar({ funil: ['#ec4899', '#64748b', '#f59e0b'] });
  c = await css();
  ok(c.texto.includes('--funil-1: #ec4899'), 'a 1ª cor entrou');
  ok(c.texto.includes('--funil-3: #f59e0b'), 'a 3ª também');
  ok(c.texto.includes('--funil-n: 3'), 'com a quantidade, que o gráfico usa para repetir a paleta');
  const ruimFunil = await salvar({ funil: ['#ec4899', 'roxo'] });
  ok(ruimFunil.http === 400, `uma cor inválida recusa a lista inteira: ${ruimFunil.http}`);

  console.log('\n=== 6. O navegador percebe a troca ===');
  // Sem o ETag mudar, o admin trocaria a cor e continuaria vendo a antiga.
  const antes = (await css()).etag;
  await salvar({ botao: '#00aa55' });
  const depois = await css();
  ok(antes !== depois.etag, 'o ETag muda quando a cor muda');
  const revalida = await fetch(url('/tema.css'), { headers: { 'If-None-Match': depois.etag } });
  ok(revalida.status === 304, 'e continua valendo 304 quando nada mudou');

  console.log(String.fromCharCode(10) + '=== 7. O BOTAO BRILHANTE sai do Admin e chega montado na vitrine ===');
  // A vitrine não lê mais /tema.css: o que ela recebe é o gradiente pronto,
  // junto dos planos, em /api/public/landing.
  const vitrine = () => fetch(url('/api/public/landing')).then(r => r.json());

  let b = await salvar({ brilho: { ligado: true, angulo: 90, cores: ['#0e5c33', '#2ed378', '#7bebae'] } });
  ok(b.http !== 400, 'três cores e um ângulo são aceitos');
  let v = await vitrine();
  ok(v.brilho.base === '#0e5c33', 'a primeira cor é o fundo: ' + v.brilho.base);
  ok(v.brilho.gradiente.startsWith('linear-gradient(90deg'), 'o ângulo entra: ' + v.brilho.gradiente.slice(0, 26));
  // O desenho da faixa: a primeira cor se repete nas PONTAS, e é isso que faz
  // as do meio atravessarem em vez de virarem um degradê de canto a canto.
  // Sem regex: corta o que está entre os parênteses e joga fora o ângulo, que
  // é a primeira parada. O que sobra são as cores, na ordem em que serão pintadas.
  const dentro = v.brilho.gradiente.slice(v.brilho.gradiente.indexOf('(') + 1, v.brilho.gradiente.lastIndexOf(')'));
  const paradas = dentro.split(',').map(x => x.trim()).slice(1);
  ok(paradas.length === 6, 'seis paradas para três cores (2 do fundo + 2 da faixa + 2 do fundo): ' + paradas.length);
  ok(paradas[0] === '#0e5c33' && paradas[1] === '#0e5c33', 'começa com o fundo repetido');
  ok(paradas[4] === '#0e5c33' && paradas[5] === '#0e5c33', 'e termina com ele também');
  ok(paradas[2] === '#2ed378' && paradas[3] === '#7bebae', 'as demais formam a faixa, na ordem');

  const uma = await salvar({ brilho: { cores: ['#2ed378'] } });
  ok(uma.http === 400, 'uma cor só é recusada: não há gradiente com uma cor (' + uma.http + ')');
  const ruim = await salvar({ brilho: { cores: ['#2ed378', 'verde'] } });
  ok(ruim.http === 400, 'cor inválida recusa a lista inteira: ' + ruim.http);
  const torto = await salvar({ brilho: { angulo: 900 } });
  ok(torto.http === 400, 'ângulo fora de 0 a 360 é recusado: ' + torto.http);

  await salvar({ brilho: { ligado: false } });
  v = await vitrine();
  ok(v.brilho.ligado === false, 'desligado, a vitrine recebe o aviso e usa o botão chapado');

  await salvar({ brilho: { ligado: true, angulo: 45, cores: [] } });
  v = await vitrine();
  ok(v.brilho.gradiente.includes('#1c834a') && v.brilho.gradiente.includes('#2ed378'),
     'sem cores salvas, volta o padrão de fábrica: ' + v.brilho.gradiente);

  await salvar({ verde: '', botao: '', botaoHover: '', tintaBotao: '', verdeDeep: '', funil: [] });
  await encerrar(srv, falhas);
})().catch(e => { console.error(e); process.exit(1); });
