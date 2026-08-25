// MODO BET — o Tracking pela régua do iGaming.
//
// Uma operação de apostas tem DUAS conversões, e a distância entre elas é o
// negócio: o CADASTRO custa dinheiro e ainda não trouxe nada; o FTD (primeiro
// depósito) é onde o tráfego pago vira receita. Um criativo com cadastro barato
// e zero FTD parece ótimo no gerenciador de anúncios e não paga a conta.
//
// O que este teste protege, em ordem de "quanto dói se quebrar":
//
// 1. O RECORTE É DE VERDADE, e não um botão escondido. O segmento é escolha do
//    cliente no cadastro; se a rota não recusar, qualquer conta lê o relatório
//    de qualquer outra só chamando a URL na mão.
//
// 2. FTD É O PRIMEIRO DEPÓSITO, decidido por TIMESTAMP e não por ordem de
//    chegada. Os eventos chegam fora de ordem o tempo todo (retry do pixel,
//    fila do provedor). Contar o primeiro que chegou infla o FTD e esvazia o
//    redepósito — e o CPA por FTD, que é o número que decide o orçamento, sai
//    barato demais.
//
// 3. O CRÉDITO DO FTD É DA CAMPANHA DO CADASTRO. Se o depósito levasse a
//    campanha de onde o jogador estava na hora de depositar, toda operação
//    pareceria que o remarketing traz FTD e a aquisição não traz nada.
//
// 4. iGAMING SEM SITE NÃO ENTRA. O site é o que o admin abre para conferir com
//    quem está lidando — sem ele, o aviso que chega no celular não serve.
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
const segmentos = require(R + 'src/segmentos');
const bet = require(R + 'src/bet');
const BASE = 'http://127.0.0.1:3979';

(async () => {
  await db.loadAsync();

  console.log('=== 1. O site da plataforma é validado como ENDEREÇO ===');
  // Vem de formulário público e vai virar link na tela do admin.
  ok(segmentos.normalizarSite('minhabet.com').site === 'https://minhabet.com',
     'sem esquema assume https — é o que a pessoa quis dizer');
  ok(!segmentos.normalizarSite('javascript:alert(1)').ok,
     'javascript: é recusado — seria XSS servido de bandeja na tela do admin');
  ok(!segmentos.normalizarSite('ftp://x.com').ok, 'só http e https');
  ok(!segmentos.normalizarSite('meusite').ok, 'sem domínio completo não é endereço nenhum');
  ok(!segmentos.normalizarSite('').ok, 'e vazio não passa');
  ok(segmentos.pedeSite('igaming') && !segmentos.pedeSite('ecommerce'),
     'só o iGaming exige o site');

  console.log('\n=== 2. O segmento antigo, em texto livre, não vira iGaming por acidente ===');
  // Quem se cadastrou antes tem texto livre no campo. Uma comparação frouxa
  // ligaria o Modo Bet para quem escreveu "cassino" descrevendo o negócio.
  ok(!segmentos.ehIGaming({ profile: { segment: 'apostas e cassino online' } }),
     'texto livre parecido NÃO liga o Modo Bet');
  ok(segmentos.ehIGaming({ profile: { segment: 'igaming' } }), 'só a chave exata liga');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3979);
  await new Promise(r => setTimeout(r, 150));

  console.log('\n=== 3. iGaming sem site não cria conta ===');
  const semSite = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bet A', email: 'a@bet.com', pass: 'segredo123',
      profile: { segment: 'igaming' } })
  });
  ok(semSite.status === 400, `recusado: ${semSite.status}`);
  ok(!db.findAccountByEmail('a@bet.com'), 'e a conta não ficou pela metade no banco');

  const comSite = await (await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bet B', email: 'b@bet.com', pass: 'segredo123',
      profile: { segment: 'igaming', site: 'betb.com' } })
  })).json();
  ok(!!comSite.token, 'com site, entra');
  const accBet = db.findAccountByEmail('b@bet.com');
  ok(accBet.profile.site === 'https://betb.com', `e o site fica normalizado: ${accBet.profile.site}`);

  // SEGMENTO DESCONHECIDO NÃO É ERRO: o campo foi texto livre por toda a vida
  // do produto e /api/register é público. Recusar quebraria todo cliente que
  // já manda o texto escrito à mão — e o valor estranho simplesmente não liga
  // recurso nenhum.
  const livre = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X', email: 'x@x.com', pass: 'segredo123',
      profile: { segment: 'consultoria de marketing' } })
  });
  ok(livre.status === 200, 'texto livre continua entrando: ' + livre.status);
  ok(!segmentos.ehIGaming(db.findAccountByEmail('x@x.com')), 'e não liga o Modo Bet');

  console.log('\n=== 4. FTD é o PRIMEIRO depósito, por timestamp ===');
  const tracking = require(R + 'src/tracking');
  const t = tracking.ensure(accBet);
  const agora = Date.now(), h = 3600000;
  const sessao = (sid, camp) => t.sessions.unshift({ sid, ts: agora - 72 * h, last: agora, utm: { campaign: camp }, events: 0, fbclid: '', gclid: '', ttclid: '', waId: '', email: '', doc: '' });
  const ev = (nome, sid, ts, valor) => t.events.unshift({ id: db.genId('tev'), ts, status: 'ok', name: nome, source: 'site', sid, pixel: '', payload: { value: valor || 0, utm: {} } });

  sessao('j1', 'aquisicao');
  ev('CompleteRegistration', 'j1', agora - 50 * h);
  // De propósito FORA DE ORDEM: o depósito MAIOR e mais RECENTE é registrado
  // primeiro. Quem contar por ordem de chegada vai chamar este de FTD.
  ev('Purchase', 'j1', agora - 10 * h, 500);
  ev('Purchase', 'j1', agora - 40 * h, 100);

  let r = bet.relatorio(accBet, { dias: 90 });
  ok(r.geral.ftds === 1, `um jogador, um FTD: ${r.geral.ftds}`);
  ok(r.geral.redepositos === 1, `e um redepósito: ${r.geral.redepositos}`);
  ok(r.geral.ticketFtdCents === 10000,
     `o FTD é o de R$ 100 (o mais antigo), e não o de R$ 500: ${(r.geral.ticketFtdCents / 100).toFixed(2)}`);
  ok(r.geral.depositoTotalCents === 60000, 'o total soma os dois depósitos');

  console.log('\n=== 5. O crédito do FTD é da campanha do CADASTRO ===');
  // O jogador se cadastrou por "aquisicao" e depositou numa sessão de
  // "remarketing". O FTD é de quem o trouxe.
  sessao('j2', 'remarketing');
  ev('CompleteRegistration', 'j2', agora - 48 * h);
  const antiga = t.sessions.find(s => s.sid === 'j2');
  antiga.utm = { campaign: 'aquisicao' };            // o cadastro veio da aquisição
  ev('Deposit', 'j2', agora - 20 * h, 300);
  // e o depósito chega sem sessão de origem própria
  r = bet.relatorio(accBet, { dias: 90 });
  const aq = r.campanhas.find(c => c.campanha === 'aquisicao');
  ok(aq && aq.ftds === 2, `os dois FTD ficaram com a campanha de aquisição: ${aq && aq.ftds}`);

  console.log('\n=== 6. Cadastro repetido do mesmo jogador conta UMA vez ===');
  ev('CompleteRegistration', 'j1', agora - 45 * h);   // recarregou a página
  ev('SignUp', 'j1', agora - 30 * h);                 // voltou no dia seguinte
  r = bet.relatorio(accBet, { dias: 90 });
  ok(r.geral.cadastros === 2, `dois jogadores, dois cadastros: ${r.geral.cadastros}`);

  console.log('\n=== 7. Os dois CPAs somam Meta + investimento manual ===');
  t.meta.campaigns = [{ spend: 40000, clicks: 100, impressions: 1000 }];   // R$ 400
  bet.salvarCfg(accBet, { investimentoCents: 20000 });                      // + R$ 200
  r = bet.relatorio(accBet, { dias: 90 });
  ok(r.geral.investimentoCents === 60000, `R$ 600 no total: ${r.geral.investimentoCents}`);
  ok(r.geral.cpaCadastroCents === 30000, `CPA cadastro = 600/2 = R$ 300: ${r.geral.cpaCadastroCents}`);
  ok(r.geral.cpaFtdCents === 30000, `CPA FTD = 600/2 = R$ 300: ${r.geral.cpaFtdCents}`);
  // Sem o campo manual todo CPA sairia otimista — e CPA otimista é pior que
  // CPA nenhum, porque parece certo.
  ok(r.geral.investimentoManualCents === 20000, 'o gasto fora do Meta entra na conta');

  console.log('\n=== 8. Campanha que cadastra e não deposita é denunciada ===');
  for (let i = 1; i <= 6; i++) { sessao('r' + i, 'trafego-ruim'); ev('SignUp', 'r' + i, agora - 24 * h); }
  r = bet.relatorio(accBet, { dias: 90 });
  const ruim = r.alertas.find(a => a.campanha === 'trafego-ruim');
  ok(!!ruim && ruim.nivel === 'alto', 'seis cadastros e zero FTD viram alerta alto');

  console.log('\n=== 9. O recorte é da ROTA, e não do botão escondido ===');
  const login = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'b@bet.com', pass: 'segredo123' })
  })).json();
  const autBet = { Authorization: 'Bearer ' + login.token };

  const comum = await (await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Loja', email: 'loja@x.com', pass: 'segredo123',
      profile: { segment: 'ecommerce' } })
  })).json();
  const autComum = { Authorization: 'Bearer ' + comum.token };

  // As duas contas precisam de assinatura ativa: sem ela a guarda de plano
  // responde 402 antes de o recorte por segmento ser sequer consultado, e o
  // teste mediria a coisa errada.
  for (const mail of ['b@bet.com', 'loja@x.com']) {
    const a = db.findAccountByEmail(mail);
    a.billing.status = 'active';
    a.billing.periodEnd = Date.now() + 30 * 86400000;
  }
  db.save();

  ok((await fetch(BASE + '/api/tracking/bet', { headers: autBet })).status === 200,
     'a conta de iGaming lê o relatório');
  const negado = await fetch(BASE + '/api/tracking/bet', { headers: autComum });
  ok(negado.status === 404,
     `a conta comum recebe 404, e não 403: ${negado.status} — dizer "proibido" contaria que existe`);
  const negadoPut = await fetch(BASE + '/api/tracking/bet', {
    method: 'PUT', headers: { ...autComum, 'Content-Type': 'application/json' },
    body: JSON.stringify({ investimentoCents: 999 })
  });
  ok(negadoPut.status === 404, 'e não consegue gravar configuração tampouco');

  const ovComum = await (await fetch(BASE + '/api/tracking', { headers: autComum })).json();
  ok(ovComum.bet && ovComum.bet.disponivel === false, 'a tela dela nem desenha a aba');

  console.log('\n=== 10. O cadastro de iGaming avisa o ADMIN, e só ele ===');
  const avisos = require(R + 'src/avisospush');
  const aviso = avisos.avisoDoEvento('cadastro', {
    accountId: 'acc_1', conta: 'Bet do Zé', segmento: 'igaming', site: 'https://betdoze.com'
  });
  ok(!!aviso && aviso.paraAdmin === true,
     'o aviso é marcado para o ADMIN — mandá-lo para a conta nova avisaria o cliente de si mesmo');
  ok(/iGaming/.test(aviso.payload.title), 'o título diz do que se trata');
  ok(aviso.payload.body.includes('betdoze.com'), 'e o corpo traz o site, que é o que o admin vai conferir');
  ok(aviso.payload.requireInteraction === true,
     'fica na tela até o admin tocar: é aviso para AGIR, não para ver de passagem');
  ok(avisos.avisoDoEvento('cadastro', { accountId: 'a', segmento: 'ecommerce' }) === null,
     'cadastro de outro segmento não vira push nenhum');

  srv.close();
  await encerrar(srv, falhas);
})();
