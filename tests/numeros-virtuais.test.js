// NÚMEROS VIRTUAIS DA INTEGRA X.
//
// É a MESMA Integra X do disparo de SMS e o MESMO token — e é outra API. As
// duas diferenças que este teste existe para travar:
//
//   1. O TOKEN VAI NO HEADER (`Authorization: Bearer`), enquanto no disparo de
//      SMS o mesmo token viaja DENTRO da URL. Quem copiar o call() do sms.js
//      para cá manda o segredo no lugar errado e leva 401 sem entender por quê.
//   2. O HOST É OUTRO: api.integraflux.com, não sms.aresfun.com.
//
// E duas regras de DINHEIRO, que são o motivo de o resto ter cuidado:
//
//   · COMPRAR gasta de verdade, na hora, sem simulação do outro lado.
//   · CANCELAR só devolve o dinheiro se o número ainda NÃO recebeu código. Se
//     já recebeu, o cancelamento acontece igual, mas sem reembolso. Quem decide
//     é o provedor; o nosso trabalho é repetir a resposta sem inventar.
//
// O provedor é simulado: o que se testa é o caminho do Koonfy até ele, e a
// leitura do que ele devolve. Nenhuma chamada real sai daqui — uma compra de
// verdade custaria dinheiro a cada `npm test`.
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

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

// ---- provedor de mentira: guarda o que recebeu, para o teste conferir ----
const chamadas = [];
const fetchReal = global.fetch;
let proximaResposta = null;
global.fetch = async (u, o = {}) => {
  const url = String(u);
  if (!url.includes('integraflux.com')) return fetchReal(u, o);
  chamadas.push({
    url, metodo: o.method, auth: (o.headers || {}).Authorization,
    corpo: o.body ? JSON.parse(o.body) : null
  });
  const r = proximaResposta || { ok: true, status: 200, body: {} };
  proximaResposta = null;
  return { ok: r.ok, status: r.status, text: async () => JSON.stringify(r.body) };
};
const responder = (body, ok = true, status = 200) => { proximaResposta = { ok, status, body }; };

const db = require(R + 'src/db');
const numeros = require(R + 'src/numeros');
const sms = require(R + 'src/sms');
const BASE = 'http://127.0.0.1:3979';

(async () => {
  await db.loadAsync();

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3979);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  console.log('=== 1. O token é UM SÓ, e vem do SMS quando não há um próprio ===');
  // A doc da Integra X diz "toda rota usa o TOKEN da integração". Quem já
  // configurou o disparo não deve ter de digitar o mesmo segredo de novo.
  sms.cfg().token = 'TOKEN-DA-INTEGRACAO';
  numeros.cfg().enabled = true;
  numeros.cfg().token = '';
  db.save();
  ok(numeros.token() === 'TOKEN-DA-INTEGRACAO', 'sem token próprio, herda o do SMS');
  ok(numeros.adminView().herdaDoSms === true, 'e o painel diz de onde veio');
  ok(numeros.configured() === true, 'com token e ligado, está configurado');

  numeros.cfg().token = 'TOKEN-SO-DOS-NUMEROS';
  ok(numeros.token() === 'TOKEN-SO-DOS-NUMEROS', 'um token próprio vence o do SMS');
  ok(numeros.adminView().herdaDoSms === false, 'e o painel para de dizer que herdou');
  numeros.cfg().token = '';
  db.save();

  console.log('\n=== 2. O token vai no HEADER, e o host é o outro ===');
  chamadas.length = 0;
  responder({ total: 342, count: 2, data: [
    { id: 'ph_1', phone: '5511977770001', ddd: '11', price_brl: '7.90' },
    { id: 'ph_2', phone: '5511977770002', ddd: '11', price_brl: 7.9 }
  ] });
  const disp = await numeros.disponiveis({ ddd: '11', limite: 2 });
  const c1 = chamadas[0];
  ok(c1.auth === 'Bearer TOKEN-DA-INTEGRACAO', `Authorization: Bearer — e não no caminho: ${c1.auth}`);
  ok(!c1.url.includes('TOKEN-DA-INTEGRACAO'), 'o segredo NÃO aparece na URL, ao contrário do disparo de SMS');
  ok(c1.url.startsWith('https://api.integraflux.com/phone-numbers/api/available'),
     `host e caminho da API de números: ${c1.url.split('?')[0]}`);
  ok(/ddd=11/.test(c1.url) && /limit=2/.test(c1.url), 'com os filtros na query');
  ok(disp.total === 342 && disp.count === 2, `total e count vêm do provedor: ${disp.total}/${disp.count}`);
  ok(disp.numeros[0].precoCents === 790 && disp.numeros[1].precoCents === 790,
     'preço vira CENTAVOS inteiros, venha "7.90" como texto ou 7.9 como número');

  console.log('\n=== 3. Comprar: os três jeitos, e o que vai no corpo ===');
  // Os três campos são opcionais e formam três compras diferentes. Mandar null
  // explicitamente é o que a doc pede quando não se escolhe.
  chamadas.length = 0;
  responder({ data: { rental_id: 'rent_1', phone: '5511977770001' } });
  await numeros.comprar({});
  ok(chamadas[0].corpo.mode === 'subscription', 'o modo padrão é subscription, o único que aceita reembolso');
  ok(chamadas[0].corpo.ddd === null && chamadas[0].corpo.phone_id === null,
     'sem escolha, os dois vão como null — qualquer número serve');

  chamadas.length = 0;
  responder({ data: { rental_id: 'rent_2', phone: '5521977770002' } });
  await numeros.comprar({ ddd: '21' });
  ok(chamadas[0].corpo.ddd === '21' && chamadas[0].corpo.phone_id === null, 'com DDD, escolhe pelo DDD');

  chamadas.length = 0;
  responder({ data: { rental_id: 'rent_3', phone: '5511977770009' } });
  const compra = await numeros.comprar({ numeroId: 'ph_9', modo: 'temporary' });
  ok(chamadas[0].corpo.phone_id === 'ph_9', 'com o id, compra aquele número');
  ok(chamadas[0].corpo.mode === 'temporary', 'e respeita o modo pedido');
  ok(compra.rentalId === 'rent_3', `devolve o rental_id, que é a chave das outras rotas: ${compra.rentalId}`);
  // A compra gasta dinheiro: precisa deixar rastro sem ninguém pedir.
  ok(numeros.cfg().logs.some(l => l.tipo === 'compra' && l.rentalId === 'rent_3'),
     'e fica registrada no log — é dinheiro saindo');

  console.log('\n=== 4. Meus números: o filtro de status é validado aqui ===');
  chamadas.length = 0;
  responder({ data: [
    { rental_id: 'rent_1', phone: '5511977770001', status: 'active', created_at: 1787000000 },
    { rental_id: 'rent_2', phone: '5521977770002', status: 'cancelled', created_at: '2026-08-01T10:00:00Z' }
  ] });
  const meus = await numeros.meus({ status: 'active,cancelled' });
  ok(/status=active%2Ccancelled/.test(chamadas[0].url), `os dois status vão na query: ${chamadas[0].url.split('?')[1]}`);
  ok(meus.length === 2, 'e voltam os dois números');
  // Epoch em SEGUNDOS lido como milissegundos daria 1970 e a tela mostraria uma
  // data absurda sem erro nenhum.
  ok(meus[0].criadoEm > 1e12, `epoch em segundos vira milissegundos: ${new Date(meus[0].criadoEm).getFullYear()}`);
  ok(new Date(meus[1].criadoEm).getUTCFullYear() === 2026, 'e uma data ISO também é entendida');

  let recusou = '';
  try { await numeros.meus({ status: 'ativo' }); } catch (e) { recusou = e.message; }
  ok(/status inválido/.test(recusou), 'um status que o provedor não conhece para AQUI, e não vira lista errada');

  console.log('\n=== 5. Os SMS recebidos, que são a razão do número existir ===');
  chamadas.length = 0;
  responder({ data: [
    { from: 'WhatsApp', body: 'Seu codigo e 123-456', otp: '123456', received_at: '2026-08-25T12:00:00Z' },
    { from: 'Banco', body: 'Codigo 999', code: '999', received_at: '2026-08-25T14:00:00Z' }
  ] });
  const msgs = await numeros.mensagens('rent_1');
  ok(chamadas[0].url.endsWith('/phone-numbers/api/rentals/rent_1/sms'), 'a rota leva o rental_id');
  ok(msgs[0].recebidoEm > msgs[1].recebidoEm, 'a mais recente vem primeiro — é a que a pessoa está esperando');
  ok(msgs[1].codigo === '123456' && msgs[0].codigo === '999', 'o código extraído vem de `otp` ou de `code`');

  let semId = '';
  try { await numeros.mensagens(''); } catch (e) { semId = e.message; }
  ok(/informe o número/.test(semId), 'sem rental_id não sai chamada nenhuma');

  console.log('\n=== 6. Cancelar: o reembolso é do provedor, não nosso ===');
  // ESTA é a parte que não pode ser "melhorada" por ninguém. O provedor decide
  // se devolve o dinheiro, e a regra é: só se o número ainda não recebeu código.
  chamadas.length = 0;
  responder({ data: { refunded: true, refunded_brl: '7.90', otp_sms_count: 0 } });
  const limpo = await numeros.cancelar('rent_1');
  ok(chamadas[0].metodo === 'POST', 'o cancelamento é POST');
  ok(chamadas[0].url.endsWith('/rentals/rent_1/cancel-refund'), 'na rota do provedor');
  ok(limpo.reembolsado === true && limpo.reembolsoCents === 790,
     `número sem código recebido volta o valor: R$ ${(limpo.reembolsoCents / 100).toFixed(2)}`);

  responder({ data: { refunded: false, refunded_brl: 0, otp_sms_count: 3 } });
  const usado = await numeros.cancelar('rent_2');
  ok(usado.reembolsado === false && usado.reembolsoCents === 0,
     'número que JÁ recebeu código cancela sem reembolso');
  ok(usado.smsComCodigo === 3, `e o painel sabe dizer por quê: ${usado.smsComCodigo} SMS com código`);
  ok(numeros.cfg().logs.filter(l => l.tipo === 'cancelamento').length === 2,
     'os dois cancelamentos ficam no log, com o desfecho de cada um');

  console.log('\n=== 7. O erro do provedor não vaza o segredo ===');
  responder({ message: 'token TOKEN-DA-INTEGRACAO invalido' }, false, 401);
  let vazou = '';
  try { await numeros.disponiveis({}); } catch (e) { vazou = e.message; }
  ok(!vazou.includes('TOKEN-DA-INTEGRACAO'), `o token sai mascarado da mensagem: ${vazou}`);
  ok(/\*\*\*/.test(vazou), 'trocado por asteriscos, e não apagado — dá para ver que havia um token ali');

  console.log('\n=== 8. As rotas são só do admin ===');
  // Comprar gasta dinheiro da conta da PLATAFORMA. Enquanto isso não for um
  // produto revendido, com preço e cota, quem gasta é quem paga.
  for (const [metodo, rota] of [['GET', '/api/admin/numeros'], ['GET', '/api/admin/numeros/meus'],
    ['POST', '/api/admin/numeros/comprar'], ['POST', '/api/admin/numeros/rent_1/cancelar']]) {
    const r = await fetch(BASE + rota, { method: metodo });
    ok(r.status === 401, `${metodo} ${rota} sem sessão: ${r.status}`);
  }

  responder({ total: 0, count: 0, data: [] });
  const comSessao = await fetch(BASE + '/api/admin/numeros/disponiveis?ddd=11', { headers: aut });
  ok(comSessao.status === 200, `e com sessão de admin abre: ${comSessao.status}`);

  console.log('\n=== 9. O token nunca volta para o navegador ===');
  const painel = await (await fetch(BASE + '/api/admin/numeros', { headers: aut })).json();
  ok(painel.numeros.temToken === true, 'o painel sabe que existe um token');
  ok(!JSON.stringify(painel).includes('TOKEN-DA-INTEGRACAO'), 'mas o valor não sai do servidor');


console.log('\n=== 10. O interruptor é BOTÃO com classe, e não checkbox ===');
// A folha desenha o interruptor a partir da CLASSE:
//   .toggle.on      { background: verde }
//   .toggle.on span { transform: translateX(...) }   ← o botão desliza
//
// Um <input type="checkbox"> marcado não diz nada a essas regras. Escrito como
// label+input, o interruptor dos Números virtuais ficava CINZA E À ESQUERDA
// mesmo com o recurso ligado: medido no navegador, o servidor respondia
// `enabled: true` e o elemento vinha sem a classe `on`, com o fundo #cdd8ce.
//
// Do lado de quem usa isso é pior do que parece: o admin liga, a chamada grava,
// e a tela continua dizendo que está desligado. Ele liga de novo — e desliga.
const telaJs = fs.readFileSync(R + 'public/app/app.js', 'utf8');

const interruptores = [...telaJs.matchAll(/class="toggle[^"]*"/g)].map(m => m[0]);
ok(interruptores.length >= 4, `${interruptores.length} interruptores na folha`);

// Nenhum deles pode ser um checkbox embrulhado: é isso que quebra o desenho.
ok(!/<label class="toggle[^"]*">\s*<input/.test(telaJs),
   'nenhum interruptor é um <label> com <input> dentro');

// E todos precisam levar a classe que a folha lê.
const semClasse = interruptores.filter(t => !/\$\{[^}]*'on'[^}]*\}/.test(t) && !/\bon\b/.test(t));
ok(semClasse.length === 0,
   `todo interruptor decide a classe 'on' pelo estado${semClasse.length ? ': ' + semClasse.join(' | ') : ''}`);

// O dos Números virtuais em particular, que era o quebrado.
const num = telaJs.slice(telaJs.indexOf('function admNumPaint'), telaJs.indexOf('function admNumLogTexto'));
ok(/<button class="toggle \$\{c\.enabled \? 'on' : ''\}"/.test(num),
   'o dos Números virtuais é <button> e reflete c.enabled');
ok(!/type="checkbox"/.test(num), 'e não há checkbox nenhum no cartão dele');

// A folha precisa continuar desenhando pela classe — se alguém trocar para
// :checked, o teste acima deixa de significar qualquer coisa.
const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
ok(/\.toggle\.on\s*\{[^}]*background/.test(css), 'a folha pinta o fundo por .toggle.on');
ok(/\.toggle\.on span\s*\{[^}]*transform/.test(css), 'e desliza o botão por .toggle.on span');

// E O INTERRUPTOR PRECISA TER TAMANHO. Dentro de uma .row, a regra
// ".row > * { flex: 1; min-width: 140px }" alcança TODO filho direto — e os
// dois interruptores novos (KYC e Números) moram dentro de uma. Sem dizer o
// contrário por escrito, o interruptor virava uma barra verde de ponta a
// ponta com a bolinha parada na esquerda: parecia um medidor, não uma chave.
// "flex-shrink: 0" sozinho NÃO resolve — o que estica é o flex-grow.
const regraTg = css.slice(css.indexOf('.toggle {'), css.indexOf('.toggle {') + 400);
ok(/flex:\s*none/.test(regraTg), 'o interruptor declara flex: none — não cresce nem encolhe na linha');
ok(/min-width:\s*0/.test(regraTg), 'e zera o min-width de 140px que herdaria da .row');
ok(/width:\s*40px/.test(regraTg), 'com a largura de sempre: 40px');

// Os dois cartões que motivaram tudo isso: ambos põem o interruptor DENTRO
// de uma linha, que é exatamente a situação que quebrava.
const telaJs2 = fs.readFileSync(R + 'public/app/app.js', 'utf8');
const kyc = telaJs2.slice(telaJs2.indexOf('function admKycPaint'), telaJs2.indexOf('function admKycPaint') + 3000);
ok(/class="toggle \$\{st\.exigido \? 'on' : ''\}"/.test(kyc),
   'o do KYC também decide a classe pelo estado');

console.log('\n=== 11. Comprar número tem lugar PRÓPRIO no menu ===');
// Antes era o terceiro cartão dentro de Integrações, e não é isso que ele é:
// comprar número, ler o SMS que chegou e cancelar é OPERAÇÃO, de todo dia, com
// dinheiro saindo a cada compra. Coisa que se FAZ merece entrada no menu;
// coisa que se CONFIGURA uma vez, não.
const menuAdm = fs.readFileSync(R + 'public/adm/index.html', 'utf8');
ok(menuAdm.includes('data-view="adm/numeros"'), 'o menu do painel tem o item');
ok(menuAdm.includes('<span>Números virtuais</span>'), 'com o nome por extenso');

const tela = fs.readFileSync(R + 'public/app/app.js', 'utf8');
ok(/adm\/numeros[^}]*aba: 'adm-num'/.test(tela), 'a rota existe e aponta para a aba própria');
ok(tela.includes('data-pane="adm-num"'), 'a aba tem painel próprio');
ok(tela.includes("if (activeTab === 'adm-num') admNumLoad();"),
   'e carrega ao entrar direto pela rota, sem depender de clique');

// E saiu de Integrações: dois lugares para a mesma tela é o começo de duas
// telas diferentes.
const intLoad = tela.slice(tela.indexOf('function admIntLoad'), tela.indexOf('function admIntLoad') + 160);
ok(!/admNumLoad/.test(intLoad), 'Integrações não carrega mais os números junto');
const paneInt = tela.slice(tela.indexOf('data-pane="adm-int"'), tela.indexOf('data-pane="adm-int"') + 320);
ok(!/adm-num-box/.test(paneInt), 'e a caixa não vive mais dentro do painel de Integrações');


console.log('\n=== 12. A tela também existe no /app, e SÓ para a conta do admin ===');
// O painel da plataforma é outra porta e outra sessão. Precisar trocar de
// painel para comprar um número é atrito puro — então a mesma tela aparece no
// app do cliente. Só que comprar número gasta o saldo da PLATAFORMA, e as
// rotas /admin/* exigem uma sessão nascida em /adm/, que uma sessão do /app
// nunca tem (nem quando é o admin que entrou — de propósito).
//
// Daí a guarda ser OUTRA: estas rotas não olham o escopo, olham a CONTA. É uma
// exceção estreita, e este bloco é o que a mantém estreita.

// O admin entrando pela porta do CLIENTE.
const loginApp = await (await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'admin', pass: 'admin' })
})).json();
const autApp = { Authorization: 'Bearer ' + loginApp.token, 'Content-Type': 'application/json' };
ok(loginApp.kind === 'account', 'entrando pelo /app, o admin é uma conta comum: ' + loginApp.kind);

const meAdm = await (await fetch(BASE + '/api/me', { headers: autApp })).json();
ok(meAdm.contaDoAdmin === true, '/me marca a conta do admin — é o que acende o item no menu');
ok((await fetch(BASE + '/api/numeros', { headers: autApp })).status === 200,
   'e ele alcança /numeros de dentro do app');

// O ESCOPO CONTINUA VALENDO: a mesma sessão não administra nada.
ok((await fetch(BASE + '/api/admin/numeros', { headers: autApp })).status === 403,
   'a MESMA sessão continua recusada em /admin/numeros — a separação dos painéis não afrouxou');

// Uma conta de cliente qualquer, com plano de sobra para o 402 não responder
// antes e esconder o que está sendo testado aqui.
const limits = require(R + 'src/limits');
await fetch(BASE + '/api/register', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Cliente Qualquer', email: 'qualquer@cli.com', pass: 'segredo123' })
});
const cli = db.findAccountByEmail('qualquer@cli.com');
cli.unlimited = true;               // sem trava de assinatura no caminho
db.save();
const loginCli = await (await fetch(BASE + '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user: 'qualquer@cli.com', pass: 'segredo123' })
})).json();
const autCli = { Authorization: 'Bearer ' + loginCli.token, 'Content-Type': 'application/json' };

const meCli = await (await fetch(BASE + '/api/me', { headers: autCli })).json();
ok(meCli.contaDoAdmin === false, 'para o cliente, /me diz que não — o item não entra no menu dele');

// TODAS as rotas, e não só a primeira: é a que alguém esquece de proteger que
// vira a porta aberta, e comprar é a que gasta dinheiro.
for (const [metodo, rota] of [
  ['GET', '/api/numeros'], ['GET', '/api/numeros/meus'], ['GET', '/api/numeros/disponiveis'],
  ['GET', '/api/numeros/abc/sms'], ['POST', '/api/numeros/comprar'],
  ['POST', '/api/numeros/abc/cancelar'], ['PUT', '/api/numeros']
]) {
  const r = await fetch(BASE + rota, { method: metodo, headers: autCli, body: metodo === 'GET' ? undefined : '{}' });
  ok(r.status === 404, `cliente em ${metodo} ${rota} -> ${r.status} (404, e não 403: nem confirma que existe)`);
}

// E o menu do app só mostra o item quando o servidor disse que sim.
const menuApp = fs.readFileSync(R + 'public/app/index.html', 'utf8');
ok(menuApp.includes('data-view="numeros"'), 'o menu do app tem o item');
ok(/state\.contaDoAdmin = !!me\.contaDoAdmin/.test(tela), 'a tela guarda o sinal do /me');
ok(/v === 'numeros' && !state\.contaDoAdmin/.test(tela),
   'e esconde o item de quem não é a conta do admin');
ok(/numeros: renderNumeros/.test(tela), 'a rota #/numeros existe no app');
// A tela é UMA só: se alguém duplicar o desenho, os dois painéis começam a
// divergir na primeira correção feita em um deles.
ok(/const NUM_API = ADM \? '\/admin\/numeros' : '\/numeros'/.test(tela),
   'e é a mesma tela dos dois lados, com o caminho decidido por uma constante');
ok(!/'\/admin\/numeros'/.test(tela.replace(/const NUM_API[^\n]*\n/, '')),
   'nenhuma chamada ficou presa no caminho antigo');

  srv.close();
  global.fetch = fetchReal;
  await encerrar(srv, falhas);
})();
