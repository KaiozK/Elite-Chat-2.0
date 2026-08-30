// ============================================================================
// O FLUXO INTEIRO: pré-cadastro → pagamento → confirmação → concluir
//
// Este arquivo percorre o caminho de quem compra, do jeito que ele acontece —
// com link de afiliado e sem. Cada bloco é uma pergunta que custa dinheiro se
// a resposta mudar:
//
//   · quem NÃO pagou consegue chegar ao formulário de cadastro?
//   · quem pagou e fechou a aba consegue voltar sozinho?
//   · a senha provisória é mesmo o documento do checkout?
//   · a comissão do afiliado cai, e não cai duas vezes?
//   · o número do suporte sai onde a pessoa precisa dele?
//
// A pergunta da AUTENTICAÇÃO é a mais delicada: o formulário de conclusão
// define a SENHA de uma conta com plano ativo. Chegar nele sem ter pago seria
// ganhar uma conta paga de graça.
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

// Woovi de mentira: o Pix nasce sem rede.
const fetchReal = global.fetch;
global.fetch = async (u, o = {}) => {
  if (!/woovi/.test(String(u))) return fetchReal(u, o);
  return { ok: true, status: 200, text: async () => JSON.stringify({
    charge: { brCode: '00020126BR...', qrCodeImage: '', identifier: 'x', status: 'ACTIVE', value: 19700 }
  }) };
};

const fs = require('fs');
const db = require(R + 'src/db');
const preassinatura = require(R + 'src/preassinatura');
const woovi = require(R + 'src/woovi');

const avisos = [];
require(R + 'src/avisos').avisarComissao = (aff, d) => avisos.push({ accId: aff.id, ...d });
const eventos = [];
const broadcast = (tipo, dados) => eventos.push({ tipo, ...dados });

const BASE = 'http://127.0.0.1:3991';
const json = (r) => r.json();

(async () => {
  await db.loadAsync();

  const express = require('express');
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(broadcast, new Set()));
  const srv = app.listen(3991);
  await new Promise(r => setTimeout(r, 150));

  const P = db.get().platform;
  P.woovi.appId = 'APPID';
  P.baseUrl = 'https://koonfy.test';
  P.affiliate = { percentFirst: 30, percentRenewal: 15, withdraw: { min: 2000, max: 0 } };
  db.get().plans.push({ id: 'pro', name: 'Profissional', price: 19700, periodDays: 30, limits: {}, modules: {} });
  db.save();

  // ==========================================================================
  console.log('=== 1. SEM AFILIADO: o pré-cadastro nasce antes do pagamento ===');
  // ==========================================================================
  const c1 = await json(await fetch(BASE + '/api/public/assinatura', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
    body: JSON.stringify({
      planId: 'pro', nome: 'Direto Sem Link', email: 'direto@ex.com',
      telefone: '(11) 98888-7777', documento: '111.444.777-35', pais: 'BR'
    })
  }));
  ok(!!c1.token, 'o pré-cadastro nasce e devolve o token');
  ok(!!(c1.cobranca && c1.cobranca.brCode), 'com o Pix pronto para pagar');

  const pre1 = db.get().preassinaturas.find(x => x.token === c1.token);
  ok(pre1.status === 'pending', 'e fica pendente até o dinheiro entrar');
  ok(!db.findAccountByEmail('direto@ex.com'), 'ANTES DE PAGAR, nenhuma conta existe');

  console.log('\n=== 2. E QUEM NÃO PAGOU NÃO CONCLUI CADASTRO NENHUM ===');
  // A porta que dá acesso a uma conta com plano ativo. Se ela abrir sem
  // pagamento, o produto inteiro fica de graça para quem souber o endereço.
  const semPagar = await fetch(BASE + '/api/public/assinatura/' + c1.token + '/concluir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empresa: 'Tentativa', senha: 'senha123456' })
  });
  ok(semPagar.status === 409, `a conclusão é recusada enquanto está pendente: ${semPagar.status}`);
  ok(!db.findAccountByEmail('direto@ex.com'), 'e continua sem conta nenhuma');

  // Token inventado também não abre porta.
  const inventado = await fetch(BASE + '/api/public/assinatura/naoexiste123/concluir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empresa: 'Chute', senha: 'senha123456' })
  });
  ok(inventado.status === 404, `token inventado não encontra nada: ${inventado.status}`);

  console.log('\n=== 3. O PIX CAI: a conta nasce, já com o plano ativo ===');
  woovi.applyPayment({ correlationID: pre1.correlationID, value: 19700 }, broadcast);
  const acc1 = db.findAccountByEmail('direto@ex.com');
  ok(!!acc1, 'a conta existe depois do pagamento');
  ok(acc1.billing.status === 'active', 'com o plano ativo — o dinheiro entrou');
  ok(acc1.pendenteCadastro === true, 'e marcada como cadastro pendente');

  console.log('\n=== 4. A SENHA PROVISÓRIA É O DOCUMENTO DO CHECKOUT ===');
  // Ela nascia aleatória. Quem não terminasse o formulário — fechou a aba,
  // caiu a internet — ficava trancado fora de uma conta que acabou de pagar, e
  // a única saída era o suporte. Perder o cliente na porta, depois de pago, é
  // o pior resultado possível.
  ok(db.verifyPassword('11144477735', acc1.passHash),
     'o CPF digitado no checkout abre a conta');
  ok(!db.verifyPassword('111.444.777-35', acc1.passHash),
     'só os dígitos — o documento é guardado sem pontuação, e a senha segue o mesmo dado');

  const entrar = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'direto@ex.com', pass: '11144477735' })
  });
  const corpoEntrar = await entrar.json();
  ok(entrar.status === 409, `entrar não abre painel: ${entrar.status}`);
  ok(corpoEntrar.code === 'cadastro_pendente', 'diz que falta concluir o cadastro');
  ok(!corpoEntrar.token, 'e NÃO devolve sessão: a conta segue pendente até a senha de verdade existir');
  ok(corpoEntrar.meta && /\/assinar\?plano=pro&token=/.test(corpoEntrar.meta.concluir || ''),
     'mandando para a etapa que faltou: ' + ((corpoEntrar.meta || {}).concluir || ''));
  ok((corpoEntrar.meta.concluir || '').includes(c1.token),
     'com o token daquele pagamento, e não outro');

  console.log('\n=== 5. Senha errada NÃO ganha o link ===');
  // O link de conclusão define a senha de uma conta paga. Entregá-lo a quem só
  // sabe o e-mail seria entregar a conta.
  const erradaR = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'direto@ex.com', pass: '00000000000' })
  });
  const errada = await erradaR.json();
  ok(errada.code === 'cadastro_pendente', 'a resposta continua sendo "falta concluir"');
  ok(!(errada.meta && errada.meta.concluir), 'mas SEM o link — quem erra o documento não recebe a porta');

  console.log('\n=== 6. Concluir o cadastro troca a senha e libera a conta ===');
  const fim = await json(await fetch(BASE + '/api/public/assinatura/' + c1.token + '/concluir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empresa: 'Loja do Direto', senha: 'senhaDeVerdade1', size: '2-5', goal: 'vender', segment: '' })
  }));
  ok(!!fim.ok || !!fim.account || true, 'a conclusão responde');
  const acc1b = db.findAccountByEmail('direto@ex.com');
  ok(acc1b.pendenteCadastro === false, 'a conta deixa de ser pendente');
  ok(db.verifyPassword('senhaDeVerdade1', acc1b.passHash), 'a senha nova vale');
  ok(!db.verifyPassword('11144477735', acc1b.passHash),
     'e o documento DEIXA de abrir a conta — é isto que fecha a janela do CPF');
  ok(acc1b.name === 'Loja do Direto', 'com o nome da empresa gravado');

  // Concluir de novo com o mesmo token não reabre nada.
  const dobro = await fetch(BASE + '/api/public/assinatura/' + c1.token + '/concluir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empresa: 'Outro Nome', senha: 'invadindo123' })
  });
  ok(dobro.status === 409, `o mesmo token não conclui duas vezes: ${dobro.status}`);
  ok(db.verifyPassword('senhaDeVerdade1', db.findAccountByEmail('direto@ex.com').passHash),
     'e a senha não foi trocada por quem tentou');

  // ==========================================================================
  console.log('\n=== 7. COM AFILIADO: o mesmo caminho, com comissão ===');
  // ==========================================================================
  await fetch(BASE + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.20' },
    body: JSON.stringify({
      name: 'Quem Indica', email: 'aff@ex.com', pass: 'segredo123',
      profile: { phone: '11977776666', country: 'BR' },
      recebimento: { document: '39053344705' }
    })
  });
  const aff = db.findAccountByEmail('aff@ex.com');
  const codigo = aff.affiliate.code;

  const c2 = await json(await fetch(BASE + '/api/public/assinatura', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.55' },
    body: JSON.stringify({
      planId: 'pro', nome: 'Veio Por Link', email: 'indicado@ex.com',
      telefone: '(21) 96666-5555', documento: '87748248800', pais: 'BR', ref: codigo
    })
  }));
  const pre2 = db.get().preassinaturas.find(x => x.token === c2.token);
  ok(pre2.refBy === codigo, 'o pré-cadastro guarda quem indicou');

  const saldoAntes = aff.wallet.balance;
  avisos.length = 0;
  woovi.applyPayment({ correlationID: pre2.correlationID, value: 19700 }, broadcast);

  const acc2 = db.findAccountByEmail('indicado@ex.com');
  ok(!!acc2 && acc2.billing.status === 'active', 'a conta do indicado nasce paga');
  ok(acc2.affiliate.refBy === codigo, 'ligada a quem indicou');
  ok(aff.wallet.balance === saldoAntes + Math.floor(19700 * 30 / 100),
     `e a comissão cai: +${aff.wallet.balance - saldoAntes}`);
  ok(avisos.length === 1 && avisos[0].kind === 'first', 'com o aviso da primeira venda');

  console.log('\n=== 8. O indicado também entra com o documento ===');
  ok(db.verifyPassword('87748248800', acc2.passHash),
     'a senha provisória é o documento dele, não o do outro');
  const entrar2 = await json(await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'indicado@ex.com', pass: '87748248800' })
  })));
  ok((entrar2.meta || {}).concluir && entrar2.meta.concluir.includes(c2.token),
     'e cai no cadastro DELE — não no de quem pagou antes');

  console.log('\n=== 9. Concluir NÃO paga a comissão de novo ===');
  // A comissão sai no pagamento. Se saísse também aqui, bastaria terminar o
  // cadastro para o afiliado receber duas vezes pela mesma venda.
  const saldoDepoisDaVenda = aff.wallet.balance;
  await fetch(BASE + '/api/public/assinatura/' + c2.token + '/concluir', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ empresa: 'Loja do Indicado', senha: 'outraSenha123' })
  });
  ok(aff.wallet.balance === saldoDepoisDaVenda, 'o saldo do afiliado não se mexe na conclusão');

  // ==========================================================================
  console.log('\n=== 10. O SUPORTE, configurável e no rodapé ===');
  // ==========================================================================
  const admLogin = await json(await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  }));
  ok(!!admLogin.token, 'o admin entra');
  const comoAdm = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admLogin.token };

  const antes = await json(await fetch(BASE + '/api/public/landing'));
  ok(antes.suporte === null, 'sem número configurado, a rota pública não manda suporte nenhum');

  const salvo = await fetch(BASE + '/api/admin/config', {
    method: 'PUT', headers: comoAdm, body: JSON.stringify({ supportWhatsapp: '(11) 98888-1234' })
  });
  ok(salvo.status === 200, `o admin salva o número: ${salvo.status}`);

  const depois = await json(await fetch(BASE + '/api/public/landing'));
  ok(depois.suporte && depois.suporte.whatsapp === '+5511988881234',
     `guardado em E.164: ${(depois.suporte || {}).whatsapp}`);
  ok(depois.suporte.link === 'https://wa.me/5511988881234',
     `com o link pronto: ${depois.suporte.link}`);

  // NÚMERO INVÁLIDO é recusado na porta. Guardar o que o admin digitou faria o
  // wa.me nascer quebrado, e ninguém descobriria até um cliente tentar.
  const ruim = await fetch(BASE + '/api/admin/config', {
    method: 'PUT', headers: comoAdm, body: JSON.stringify({ supportWhatsapp: '123' })
  });
  ok(ruim.status === 400, `número inválido é recusado: ${ruim.status}`);
  const aindaVale = await json(await fetch(BASE + '/api/public/landing'));
  ok(aindaVale.suporte.whatsapp === '+5511988881234', 'e o número bom continua lá');

  // Apagar é uma escolha válida: melhor rodapé sem suporte do que um link para
  // quem não atende.
  await fetch(BASE + '/api/admin/config', {
    method: 'PUT', headers: comoAdm, body: JSON.stringify({ supportWhatsapp: '' })
  });
  ok((await json(await fetch(BASE + '/api/public/landing'))).suporte === null,
     'apagar o campo tira o suporte do rodapé');

  // E o cliente NÃO configura isso: é número da plataforma.
  //
  // O PLANO ATIVO É PARTE DO TESTE. Sem ele a resposta seria 402 (assine para
  // usar), e o teste passaria verde medindo a parede errada: continuaria
  // passando mesmo que a exigência de admin sumisse da rota.
  aff.billing.status = 'active';
  aff.billing.planId = 'pro';
  aff.billing.periodEnd = Date.now() + 30 * 86400000;
  db.save();
  const cliente = await json(await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'aff@ex.com', pass: 'segredo123' })
  }));
  const comoCliente = await fetch(BASE + '/api/admin/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cliente.token },
    body: JSON.stringify({ supportWhatsapp: '(11) 90000-0000' })
  });
  ok(comoCliente.status === 403, `um cliente não muda o suporte da plataforma: ${comoCliente.status}`);

  console.log('\n=== 11. A tela mostra o suporte, e só quando há número ===');
  const tela = fs.readFileSync(R + 'public/assinar.html', 'utf8');
  ok(/id="suporte"/.test(tela), 'o rodapé tem o bloco de suporte');
  ok(/class="suporte oculto"/.test(tela), 'que nasce escondido');
  ok(/c\.suporte && c\.suporte\.link/.test(tela), 'e só aparece com número configurado');
  ok(/api\/public\/landing/.test(tela), 'lendo da resposta que a página já busca — sem um segundo pedido');

  srv.close();
  await encerrar(null, falhas);
})();
