// ============================================================================
// OS LIMITES DO PLANO — auditoria de todos os furos, num arquivo só
//
// O teto de um plano não vale onde ele é CONFERIDO; vale onde o recurso é
// CRIADO. E quase nada é criado por uma rota: contato nasce de webhook, de
// evento de loja, de importação; mensagem sai de campanha rodando em segundo
// plano e de fluxo disparado por mensagem recebida. Enquanto a conferência
// morava só nas rotas, o plano limitava quem usava o produto na mão e não
// limitava nada de quem usava automação — que é justamente quem consome.
//
// Os furos que este arquivo tranca:
//
//   · CONTATO por integração e por evento de loja, sem olhar o teto;
//   · DISPARO conferido ao CRIAR a campanha e não a cada envio — um plano de
//     mil disparos entregava cinquenta mil numa campanha só, e cada um é
//     mensagem paga na Meta;
//   · ATENDENTES e WEBHOOKS sem teto nenhum em qualquer plano;
//   · ASSINATURA VENCIDA que não impedia automação: fluxo, SMS e campanha
//     seguiam rodando para quem parou de pagar, no custo da plataforma.
//
// E as duas exceções, que são de propósito e estão testadas para ninguém
// "corrigir" sem querer: conversa recebida nunca é barrada, e quem já está na
// base continua sendo atualizado mesmo com o teto cheio.
// ============================================================================
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

const ARQ = path.join(R, 'data', 'db.json');
const original = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
const devolver = () => { try { if (original) fs.writeFileSync(ARQ, original); } catch {} };
process.on('exit', devolver);
process.on('uncaughtException', e => { devolver(); console.error(e); process.exit(1); });

const db = require(path.join(R, 'src', 'db'));
const limits = require(path.join(R, 'src', 'limits'));
const store = require(path.join(R, 'src', 'store'));
const nuvem = require(path.join(R, 'src', 'nuvemshop'));
const webhooks = require(path.join(R, 'src', 'webhooks'));
const flows = require(path.join(R, 'src', 'flows'));

db.load();
const data = db.get();
data.accounts.length = 0;
data.plans.length = 0;
data.plans.push({
  id: 'basico', name: 'Básico', price: 9700, periodDays: 30,
  limits: { contacts: 2, sends: 2, campaigns: 1, flows: 1, pixels: 1, links: 1,
            whatsapps: 1, agents: 1, webhooks: 1 },
  modules: {}
});
data.platform.billing = Object.assign({}, data.platform.billing, { enforce: true });

function conta(email) {
  const a = db.newAccount({ name: 'Cliente', email, pass: '123456' });
  a.billing = Object.assign({}, a.billing, {
    planId: 'basico', status: 'active', periodEnd: Date.now() + 15 * 86400000
  });
  data.accounts.push(a);
  return a;
}

(async () => {
  console.log('=== 1. Todo recurso limitável tem rótulo e contagem ===');
  const acc = conta('a@teste.local');
  const u = limits.usage(acc);
  for (const k of db.LIMIT_KEYS) {
    ok(u[k] !== undefined, `${k}: o uso é contado`);
  }
  const rel = limits.report(acc);
  ok(db.LIMIT_KEYS.every(k => rel[k] && rel[k].label), 'e todos aparecem no relatório da tela');
  // Estes dois entraram depois: cresciam sem teto em qualquer plano.
  ok(db.LIMIT_KEYS.includes('agents') && db.LIMIT_KEYS.includes('webhooks'),
     'inclusive atendentes e webhooks, que não tinham teto nenhum');

  console.log('\n=== 2. Contato: o teto vale para QUEM CRIA, não só para a rota ===');
  store.upsertContact(acc, '11900000001', 'Um');
  store.upsertContact(acc, '11900000002', 'Dois');
  ok(acc.contacts.length === 2, 'a conta está no teto (2 de 2)');
  ok(limits.podeCriarContato(acc) === false, 'e não cabe mais ninguém');
  // Quem já está na base NÃO ocupa vaga nova: atualizá-lo nunca é barrado.
  ok(limits.podeTocarContato(acc, '11900000001') === true,
     'mas quem já existe continua podendo ser atualizado');
  ok(limits.podeTocarContato(acc, '11900000009') === false, 'e um número novo, não');

  console.log('\n=== 2b. Evento da loja respeita o teto ===');
  const c = nuvem.cfg(acc);
  c.storeId = '9'; c.accessToken = 't'; c.autoContact = true;
  const cli = { id: 1, name: 'Cliente da Loja', email: 'loja@c.com', phone: '11955554444' };
  global.fetch = async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify(cli), json: async () => cli });
  const ev = await nuvem.handleEvent(acc, 'customer/created', 1, null);
  ok(!ev.contact, 'o evento NÃO cria contato acima do teto');
  ok(acc.contacts.length === 2, 'a conta continua em 2', String(acc.contacts.length));
  const log = db.get().webhookLog[0] || {};
  ok(log.motivo === 'o limite de contatos do plano foi atingido',
     'e o log diz que foi o limite, não um defeito', log.motivo);

  console.log('\n=== 2c. Webhook de entrada respeita o teto ===');
  const wh = { id: 'wh1', name: 'Meu webhook', mapping: { phone: 'tel', name: 'nome', custom: [] }, hits: 0 };
  acc.webhooks = [wh];
  const r = webhooks.ingest(acc, wh, { tel: '11933332222', nome: 'Novo' }, null);
  ok(!r.contact, 'o webhook NÃO cria contato acima do teto');
  ok(acc.contacts.length === 2, 'a conta continua em 2');
  ok(wh.ultimoBloqueio && /limite/.test(wh.ultimoBloqueio.motivo),
     'e o webhook registra por que não criou', wh.ultimoBloqueio && wh.ultimoBloqueio.motivo);

  console.log('\n=== 2d. A EXCEÇÃO: conversa recebida nunca é barrada ===');
  // Recusar seria perder a mensagem de um cliente real para proteger uma cota,
  // e o prejuízo cai sobre quem não tem culpa: quem mandou a mensagem.
  const entrada = store.upsertContact(acc, '11911110000', 'Quem chamou no zap');
  ok(!!entrada && acc.contacts.length === 3,
     'a mensagem recebida cria o contato mesmo acima do teto', acc.contacts.length + ' contatos');
  ok(limits.report(acc).contacts.exceeded === true,
     'e o painel mostra que o plano estourou, em vez de esconder');

  console.log('\n=== 3. Assinatura vencida para as automações ===');
  const venc = conta('venc@teste.local');
  venc.billing.periodEnd = Date.now() - 86400000;      // venceu ontem
  ok(limits.assinaturaVale(venc) === false, 'a assinatura não vale mais');
  const rodou = await flows.runFlow(venc, { id: 'f1', graph: { nodes: [] } }, { to: '5511999999999' }, null);
  ok(rodou && rodou.blocked === 'assinatura', 'o fluxo NÃO roda', rodou && rodou.blocked);
  const logF = db.get().webhookLog[0] || {};
  ok(logF.type === 'flow_bloqueado', 'e fica registrado por quê', logF.type);
  // Quem cancelou pagou o mês: usa até o último dia.
  venc.billing.status = 'canceled';
  venc.billing.periodEnd = Date.now() + 5 * 86400000;
  ok(limits.assinaturaVale(venc) === true,
     'quem cancelou continua até o fim do período que pagou');
  // E a plataforma que não cobra não bloqueia ninguém.
  venc.billing.status = 'active'; venc.billing.periodEnd = Date.now() - 86400000;
  data.platform.billing.enforce = false;
  ok(limits.assinaturaVale(venc) === true, 'com a cobrança desligada, nada é bloqueado');
  data.platform.billing.enforce = true;

  console.log('\n=== 4. A conta do dono não é barrada por nada ===');
  const dono = conta('dono@teste.local');
  dono.unlimited = true;
  dono.billing.periodEnd = Date.now() - 999 * 86400000;
  ok(limits.assinaturaVale(dono) === true, 'assinatura sempre vale');
  ok(limits.podeCriarContato(dono) === true, 'e não tem teto de contatos');
  ok(limits.limitOf(dono, 'agents') === -1, 'nem de equipe');

  console.log('\n=== 5. A regra mora num lugar só ===');
  // Duas cópias da mesma regra foi exatamente o que deixou fluxo e campanha
  // rodando para quem não paga: o api.js barrava e o resto não sabia.
  const api = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
  ok(/limits\.assinaturaVale\(req\.acc\)/.test(api),
     'requireActive usa a mesma função das automações');
  ok(!/status === 'trial' \|\| b\.status === 'active'/.test(api),
     'e não guarda uma segunda cópia da regra');
  // Âncora específica: existe um `for (const r of camp.recipients)` antes, no
  // ramo do canal desconectado, e ele não é o laço de envio.
  const iEnvio = api.indexOf("if (r.status !== 'pending') continue;");
  const camp = api.slice(iEnvio, iEnvio + 1600);
  ok(/limits\.check\(acc, 'sends'\)/.test(camp), 'a campanha confere a cota A CADA ENVIO');
  ok(/limits\.assinaturaVale\(acc\)/.test(camp), 'e a assinatura também, envio a envio');
  ok(/camp\.status = 'paused'/.test(camp),
     'e PAUSA em vez de falhar — os enviados ficam enviados e o resto espera');

  const antes = JSON.parse(original || '{}');
  for (const k of ['accounts', 'revenue', 'plans']) {
    if (Array.isArray(data[k])) data[k].length = 0;
    if (Array.isArray(antes[k])) data[k].push(...antes[k]);
  }
  db.save();
  devolver();
  await encerrar(null, falhas);
})();
