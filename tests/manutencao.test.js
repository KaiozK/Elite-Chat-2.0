// ============================================================================
// MODO MANUTENÇÃO
//
// Diferente do interruptor de módulos, que tira um recurso: aqui o painel do
// cliente inteiro para, e a tela diz por quê. Serve para atualização com
// migração de dados, troca de servidor, ou o dia em que algo quebrou de um
// jeito que mexer no ar seria pior.
//
// Três decisões que este arquivo prende:
//
//   · A VITRINE E O CHECKOUT NÃO PARAM. Parar de vender por causa de uma
//     manutenção do painel é perder cliente por um problema que ele nem tem.
//   · O ADMIN CONTINUA ENTRANDO. Uma manutenção que tranca o próprio
//     administrador do lado de fora é uma manutenção que não acaba.
//   · SEM NÚMERO DE SUPORTE, NÃO LIGA. A tela manda o cliente falar com o
//     suporte; sem número, ela pede uma coisa impossível no pior momento.
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

const BASE = 'http://127.0.0.1:3999';
const json = r => r.json();

(async () => {
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3999);
  await new Promise(r => setTimeout(r, 150));

  db.get().platform.billing.requirePlan = false;
  db.get().plans.push({ id: 'pro', name: 'Pro', price: 19700, periodDays: 30, limits: {}, modules: {} });
  db.save();

  await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Loja', email: 'loja@ex.com', pass: 'segredo123',
      profile: { phone: '11988887777', country: 'BR' }, recebimento: { document: '39053344705' }
    })
  });
  const adm = await json(await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  }));
  const cli = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'loja@ex.com', pass: 'segredo123' })
  }));
  const como = t => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

  console.log('=== 1. SEM SUPORTE CONFIGURADO, a manutenção não liga ===');
  // A tela diz "fale com o suporte". Sem número, ela manda o cliente para lugar
  // nenhum — exatamente quando ele não consegue usar o produto.
  const semSup = await fetch(BASE + '/api/admin/manutencao', {
    method: 'PUT', headers: como(adm.token), body: JSON.stringify({ ligada: true })
  });
  const cSem = await semSup.json();
  ok(semSup.status === 400, `recusado: ${semSup.status}`);
  ok(cSem.code === 'sem_suporte', 'com o motivo');
  ok(/impossível/i.test(cSem.error), 'dizendo por quê: ' + cSem.error);
  ok(db.get().platform.manutencao.ligada === false, 'e a plataforma continua no ar');

  console.log('\n=== 2. Com o número, liga ===');
  await fetch(BASE + '/api/admin/config', {
    method: 'PUT', headers: como(adm.token), body: JSON.stringify({ supportWhatsapp: '(11) 98888-1234' })
  });
  const lig = await fetch(BASE + '/api/admin/manutencao', {
    method: 'PUT', headers: como(adm.token),
    body: JSON.stringify({ ligada: true, mensagem: 'Migrando o servidor. Voltamos às 22h.' })
  });
  ok(lig.status === 200, `ligada: ${lig.status}`);
  ok(db.get().platform.manutencao.desde > 0, 'com a hora de início gravada');

  console.log('\n=== 3. O CLIENTE não entra, e sabe por quê ===');
  const rCli = await fetch(BASE + '/api/dashboard', { headers: como(cli.token) });
  const cCli = await rCli.json();
  ok(rCli.status === 503, `503, e não 402 nem 403 — é serviço fora do ar: ${rCli.status}`);
  ok(cCli.code === 'manutencao', 'com o código do motivo');
  ok(cCli.error === 'Migrando o servidor. Voltamos às 22h.', 'e a SUA mensagem: ' + cCli.error);
  ok(cCli.suporte && /wa\.me\/5511988881234/.test(cCli.suporte.link),
     'com o link do suporte pronto: ' + (cCli.suporte || {}).link);

  console.log('\n=== 4. A VITRINE E O CHECKOUT continuam no ar ===');
  // Parar de VENDER por causa de uma manutenção do painel é perder cliente por
  // um problema que ele nem tem.
  const land = await fetch(BASE + '/api/public/landing');
  ok(land.status === 200, `a vitrine responde: ${land.status}`);
  const seg = await fetch(BASE + '/api/public/segmentos');
  ok(seg.status === 200, 'e o checkout também');

  console.log('\n=== 5. O ADMIN continua entrando ===');
  // É dele que se religa. Uma manutenção que tranca o administrador do lado de
  // fora é uma manutenção que não acaba.
  const rAdm = await fetch(BASE + '/api/adm/overview', { headers: como(adm.token) });
  ok(rAdm.status === 200, `o painel da plataforma abre: ${rAdm.status}`);

  console.log('\n=== 6. A tela pergunta ANTES de tudo, e sem sessão ===');
  // Quem ainda não entrou também merece a explicação, em vez de um login que
  // recusa sem dizer por quê.
  const pub = await json(await fetch(BASE + '/api/manutencao'));
  ok(pub.ligada === true, 'a rota é pública e diz que está parado');
  ok(pub.mensagem === 'Migrando o servidor. Voltamos às 22h.', 'com a mensagem');
  ok(pub.suporte && pub.suporte.link, 'e o suporte');
  // O BOTÃO BRILHANTE vem junto: buscá-lo numa segunda rota deixaria o botão
  // chapado no primeiro instante e brilhante depois, piscando na cara de quem
  // já está esperando.
  ok(pub.brilho && typeof pub.brilho.ligado === 'boolean', 'e o brilho do botão, na mesma resposta');

  // E SAIR CONTINUA POSSÍVEL: a sessão precisa poder terminar.
  const sair = await fetch(BASE + '/api/logout', { method: 'POST', headers: como(cli.token), body: '{}' });
  ok(sair.status === 200, `dá para sair: ${sair.status}`);

  console.log('\n=== 7. Desligar devolve tudo ===');
  await fetch(BASE + '/api/admin/manutencao', {
    method: 'PUT', headers: como(adm.token), body: JSON.stringify({ ligada: false })
  });
  const cli2 = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'loja@ex.com', pass: 'segredo123' })
  }));
  const volta = await fetch(BASE + '/api/dashboard', { headers: como(cli2.token) });
  ok(volta.status === 200, `o cliente volta a entrar: ${volta.status}`);
  ok(db.get().platform.manutencao.desde === 0, 'e a hora de início é zerada');

  const log = db.get().webhookLog.find(e => e.type === 'manutencao');
  ok(!!log, 'as duas mudanças ficam no log do Admin');

  console.log('\n=== 8. A tela e o ícone ===');
  const appjs = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const idx = fs.readFileSync(R + 'public/app/index.html', 'utf8');
  ok(/function telaManutencao/.test(appjs), 'a tela de manutenção existe');
  ok(/if \(!ADM && await conferirManutencao\(\)\) return;/.test(appjs),
     'e é conferida na abertura, antes até da tela de entrar');
  ok(/man-btn/.test(appjs) && /btn primary man-btn/.test(appjs),
     'com o botão brilhante do suporte como único caminho');
  ok(/function admManLoad/.test(appjs), 'e a aba no Admin');
  ok(/Configure o WhatsApp do suporte antes/.test(fs.readFileSync(R + 'src/api.js', 'utf8')),
     'que recusa ligar sem número');

  // O FUNIL, no traço dos outros ícones: sem preenchimento, e com as mesmas
  // pontas arredondadas. O desenho enviado é cheio e de canto vivo, e copiado
  // assim ficaria gordo e quadrado num menu de linhas finas.
  const nav = idx.slice(idx.indexOf('data-view="flows"'), idx.indexOf('data-view="flows"') + 700);
  ok(/M2\.5 4\.5h19/.test(nav), 'o Flow Builder virou um funil');
  ok(/fill="none"/.test(nav) && /stroke-width="1\.8"/.test(nav),
     'no mesmo traço dos outros: sem preenchimento, 1.8');
  ok(/stroke-linecap="round"/.test(nav) && /stroke-linejoin="round"/.test(nav),
     'e com as mesmas pontas arredondadas');
  ok(/flow: '<path d="M2\.5 4\.5h19/.test(appjs), 'o ícone do app acompanha, para não haver dois desenhos');

  srv.close();
  await encerrar(null, falhas);
})();
