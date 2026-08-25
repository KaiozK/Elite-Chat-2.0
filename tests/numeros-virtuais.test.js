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

  srv.close();
  global.fetch = fetchReal;
  await encerrar(srv, falhas);
})();
