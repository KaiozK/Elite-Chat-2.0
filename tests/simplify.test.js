// SIMPLIFY como adquirente Pix.
//
// O modelo dela é diferente do da Woovi e é aí que mora o risco: não há
// subconta, o depósito cai na conta da PLATAFORMA, o split é em PORCENTAGEM
// (não em centavos) com teto de 90%, e o webhook NÃO é assinado. Cada uma
// dessas diferenças é dinheiro de verdade se sair errado.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

// MySQL falso: o teste não pode encostar no banco de desenvolvimento.
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
const simplify = require(R + 'src/simplify');
const elitepay = require(R + 'src/elitepay');
const documento = require(R + 'src/documento');

// A API da Simplify é simulada: o que se testa é o CAMINHO do Koonfy até ela.
let ultimaChamada = null;
let respostaFalsa = { internal_id: 'TXN_TESTE123', external_id: '', status: 'pending', qrcode: '00020126580014BR.GOV.BCB.PIX...', amount: '0' };
let devolverErro = null;
const fetchReal = global.fetch;
global.fetch = async (u, o) => {
  const url = String(u);
  if (url.includes('simplifybr.com')) {
    ultimaChamada = { url, headers: (o && o.headers) || {}, corpo: o && o.body ? JSON.parse(o.body) : null };
    if (devolverErro) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ message: devolverErro }) };
    }
    return { ok: true, status: 201, text: async () => JSON.stringify(respostaFalsa) };
  }
  return fetchReal(u, o);
};

(async () => {
  await db.loadAsync();
  const p = db.get().platform;
  p.simplify = { clientId: 'CID_TESTE', clientSecret: 'SEG_TESTE', splitUsername: '', splitPercent: 0 };
  p.baseUrl = 'https://koonfy.com';
  elitepay.platformCfg().gateway = 'simplify';

  console.log('=== 1. O driver ativo é a Simplify ===');
  ok(elitepay.gateway().id === 'simplify', 'gateway selecionado: ' + elitepay.gateway().id);
  ok(elitepay.configured() === true, 'reconhece as credenciais como configuradas');

  console.log('\n=== 2. Sem CPF do pagador, NÃO cria a cobrança ===');
  // Inventar um CPF passaria na validação de formato e quebraria a conciliação
  // do cliente depois. É melhor recusar com um erro que diz o que fazer.
  let erro = null;
  try {
    await elitepay.gateway().createCharge({
      correlationID: 'ep-1', value: 9700, comment: 'Teste',
      customer: { name: 'Maria', phone: '5511988887777' }
    });
  } catch (e) { erro = e; }
  ok(!!erro, 'recusou');
  ok(erro && /CPF/i.test(erro.message), `com motivo claro: "${erro && erro.message.slice(0, 60)}…"`);
  ok(erro && erro.code === 'payer_required', 'marcado como falta de dado do pagador, não erro do gateway');

  console.log('\n=== 3. Com os dados completos, o corpo sai no formato da Simplify ===');
  const r = await elitepay.gateway().createCharge({
    correlationID: 'ep-abc123', value: 10050, comment: 'Consultoria',
    customer: { name: 'João Silva', phone: '5582981440676',
      payer: { name: 'João Silva', email: 'joao@exemplo.com', document: '847.489.140-09', phone: '5582981440676' } }
  });
  const c = ultimaChamada;
  ok(/\/pix\/deposit$/.test(c.url), 'chamou POST /pix/deposit');
  ok(c.headers['client-id'] === 'CID_TESTE' && c.headers['client-secret'] === 'SEG_TESTE', 'com os cabeçalhos de autenticação');
  // A Simplify quer REAIS, e o Koonfy trabalha em centavos: 10050 → 100.50
  ok(c.corpo.amount === 100.5, `valor convertido para reais: ${c.corpo.amount}`);
  ok(c.corpo.external_id === 'ep-abc123', 'external_id é o correlationID do Koonfy');
  ok(c.corpo.payer.document === '84748914009', 'CPF vai só com dígitos: ' + c.corpo.payer.document);
  ok(c.corpo.webhookURL === 'https://koonfy.com/simplify-webhook', 'webhook vai na própria cobrança: ' + c.corpo.webhookURL);
  // O TELEFONE vai NACIONAL, sem o 55. Mandando com o código do país, a
  // Simplify lê o "55" como DDD e mostra o telefone de outra pessoa no painel.
  ok(c.corpo.payer.phone === '82981440676', 'telefone sem o DDI: ' + c.corpo.payer.phone);
  ok(r.brCode === respostaFalsa.qrcode, 'o campo `qrcode` vira o Pix copia e cola');
  ok(r.gatewayId === 'TXN_TESTE123', 'guarda o internal_id da Simplify');

  console.log('\n=== 4. A TAXA DA PLATAFORMA NÃO sai como split ===');
  // Este é o ponto mais caro do arquivo. Na Simplify o depósito INTEIRO cai na
  // conta da plataforma e a carteira credita ao cliente o líquido (valor menos
  // a taxa) — a taxa já está retida. Mandá-la também como split faria o
  // dinheiro sair da conta da plataforma: ela perderia o que acabou de cobrar
  // e o cliente continuaria recebendo o líquido. Prejuízo dos dois lados.
  p.simplify.splitUsername = '';
  p.simplify.splitPercent = 0;
  await elitepay.gateway().createCharge({
    correlationID: 'ep-2', value: 10000, splits: [{ pixKey: 'x', value: 250 }],   // taxa de 2,5%
    customer: { payer: { name: 'A', email: 'a@a.com', document: '11144477735', phone: '11999999999' } }
  });
  ok(ultimaChamada.corpo.split === undefined,
    'a taxa de 2,5% NÃO virou split: ela já fica na conta da plataforma');

  console.log('\n=== 5. O split serve para mandar a OUTRO usuário da Simplify ===');
  // Um sócio, um parceiro. Configurado à mão no Admin, e nunca deduzido da taxa.
  p.simplify.splitUsername = 'socio';
  p.simplify.splitPercent = 2.5;
  await elitepay.gateway().createCharge({
    correlationID: 'ep-3', value: 10000, splits: [{ pixKey: 'x', value: 250 }],
    customer: { payer: { name: 'A', email: 'a@a.com', document: '11144477735', phone: '11999999999' } }
  });
  ok(ultimaChamada.corpo.split[0].username === 'socio', 'vai para o usuário configurado');
  ok(ultimaChamada.corpo.split[0].percentage === 2.5, `com a porcentagem do Admin: ${ultimaChamada.corpo.split[0].percentage}%`);

  // A Simplify recusa acima de 90% e a cobrança inteira falharia.
  p.simplify.splitPercent = 99;
  await elitepay.gateway().createCharge({
    correlationID: 'ep-4', value: 10000,
    customer: { payer: { name: 'A', email: 'a@a.com', document: '11144477735', phone: '11999999999' } }
  });
  ok(ultimaChamada.corpo.split[0].percentage === 90, `99% foi limitado a ${ultimaChamada.corpo.split[0].percentage}%`);

  p.simplify.splitUsername = '';
  p.simplify.splitPercent = 0;
  await elitepay.gateway().createCharge({
    correlationID: 'ep-5', value: 5000,
    customer: { payer: { name: 'A', email: 'a@a.com', document: '11144477735', phone: '11999999999' } }
  });
  ok(ultimaChamada.corpo.split === undefined, 'sem usuário configurado, o campo `split` fica de fora');

  console.log('\n=== 6. Erro da Simplify chega legível ===');
  devolverErro = 'CPF do pagador inválido';
  let e2 = null;
  try {
    await elitepay.gateway().createCharge({
      correlationID: 'ep-5', value: 5000,
      customer: { payer: { name: 'A', email: 'a@a.com', document: '11144477735', phone: '11999999999' } }
    });
  } catch (e) { e2 = e; }
  devolverErro = null;
  ok(e2 && /CPF do pagador inválido/.test(e2.message), `a mensagem do gateway é preservada: "${e2 && e2.message}"`);

  console.log('\n=== 7. WEBHOOK: sem assinatura, o valor é a prova ===');
  const acc = { id: 'acc_sp', name: 'Loja do Teste', email: 'sp@teste.com', contacts: [], channels: [],
    messages: [], campaigns: [], billing: { status: 'trial', planId: '', periodEnd: 0 } };
  db.get().accounts.push(acc);
  const ep = elitepay.ensure(acc);
  const cobranca = { id: 'epc_sp1', correlationID: 'epc_sp1', value: 10050, status: 'active',
    method: 'pix', platformCut: 250, contactName: 'João', waId: '5582981440676' };
  ep.charges.unshift(cobranca);

  const chamar = (corpo) => new Promise(res => {
    const h = simplify.webhookHandler(() => {});
    h({ body: corpo }, { sendStatus: () => {} });
    setTimeout(res, 60);
  });

  // valor DIFERENTE do registrado: não confirma
  await chamar({ event: 'deposit.paid', external_id: 'epc_sp1', status: 'approved', amount: '5.00' });
  ok(cobranca.status === 'active', 'valor divergente NÃO marca como paga');

  // valor certo: confirma
  await chamar({ event: 'deposit.paid', external_id: 'epc_sp1', status: 'approved', amount: '100.50' });
  ok(cobranca.status === 'paid', 'valor conferido marca como paga');

  console.log('\n=== 8. Evento que não é pagamento não faz nada ===');
  const outra = { id: 'epc_sp2', correlationID: 'epc_sp2', value: 1000, status: 'active', method: 'pix', platformCut: 25 };
  ep.charges.unshift(outra);
  await chamar({ event: 'deposit.pending', external_id: 'epc_sp2', status: 'pending', amount: '10.00' });
  ok(outra.status === 'active', 'cobrança pendente continua pendente');

  console.log('\n=== 9. PIX ADIADO: cobrança do chat nasce sem código ===');
  // Este era o buraco: a cobrança feita pelo chat só sabe o nome e o WhatsApp,
  // e a Simplify exige CPF e e-mail. Gerar na hora derrubaria TODA cobrança
  // saída do chat. Então ela nasce sem código e o Pix vem depois, quando o
  // cliente se identifica no checkout.
  const acc2 = db.get().accounts.find(a => a.id === 'acc_sp');
  // Com a Simplify a subconta é só o cadastro local (não há subconta lá).
  elitepay.ensure(acc2).subaccount = { status: 'active', pixKey: '82981440676', name: 'Loja do Teste' };
  ultimaChamada = null;
  const doChat = await elitepay.createCharge(acc2, {
    valueCents: 19700, comment: 'Consultoria', waId: '5582981440676',
    contactName: 'João Silva', origin: 'chat'
  });
  ok(doChat.brCode === '', 'a cobrança nasceu SEM o código Pix');
  ok(ultimaChamada === null, 'e a Simplify nem foi chamada ainda');
  ok(!!doChat.payUrl, 'mas já tem o link do checkout para mandar ao cliente: ' + !!doChat.payUrl);

  // A mensagem enviada no WhatsApp não pode ficar com "Pix copia e cola:" e nada embaixo.
  const msg = elitepay.chargeMessage(acc2, doChat);
  ok(!/copia e cola/i.test(msg), 'a mensagem NÃO oferece um Pix que ainda não existe');
  ok(msg.includes(doChat.payUrl), 'e manda o link, que é onde o cliente preenche');

  console.log('\n=== 10. O cliente se identifica e AÍ o Pix é gerado ===');
  respostaFalsa = { internal_id: 'TXN_DEPOIS', status: 'pending', qrcode: '00020126...PIX-GERADO-DEPOIS' };
  const idOk = await elitepay.identifyPayer(doChat.id, {
    name: 'João Silva', taxID: '847.489.140-09', email: 'joao@exemplo.com', phone: '82981440676'
  }, () => {});
  ok(!!idOk, 'identificação aceita');
  ok(doChat.brCode === '00020126...PIX-GERADO-DEPOIS', 'o Pix foi gerado agora: ' + doChat.brCode.slice(0, 20));
  ok(doChat.gatewayId === 'TXN_DEPOIS', 'com o id da Simplify guardado');
  ok(ultimaChamada && ultimaChamada.corpo.payer.document === '84748914009',
    'e o CPF do checkout foi para a Simplify: ' + (ultimaChamada && ultimaChamada.corpo.payer.document));

  console.log('\n=== 10b. Na PRÓXIMA compra, o checkout já vem preenchido ===');
  // A primeira compra criou o contato com nome, telefone, e-mail e CPF. Pedir
  // tudo de novo na compra seguinte é atrito puro — e atrito no checkout é
  // carrinho abandonado.
  const segunda = await elitepay.createCharge(acc2, {
    valueCents: 4900, comment: 'Segundo produto', waId: '5582981440676',
    contactName: 'João Silva', origin: 'chat'
  });
  const vista = elitepay.publicChargeView(segunda.id);
  ok(!!vista, 'a página da nova cobrança abre');
  ok(vista.needsId === true, 'ainda pede confirmação dos dados (não pula a etapa)');
  ok(vista.prefill.name === 'João Silva', 'nome preenchido: ' + vista.prefill.name);
  ok(vista.prefill.email === 'joao@exemplo.com', 'e-mail preenchido: ' + vista.prefill.email);
  ok(vista.prefill.taxID === '84748914009', 'CPF preenchido: ' + vista.prefill.taxID);
  ok(vista.prefill.phone === '5582981440676', 'telefone preenchido: ' + vista.prefill.phone);
  ok(vista.prefill.conhecido === true, 'e a tela sabe que é cliente conhecido, para dizer de onde vieram os dados');

  // Cliente NOVO não pode receber dado de ninguém.
  const deOutro = await elitepay.createCharge(acc2, {
    valueCents: 4900, comment: 'Outro cliente', waId: '5511900000000',
    contactName: 'Alguém Novo', origin: 'chat'
  });
  const v2 = elitepay.publicChargeView(deOutro.id);
  ok(!v2.prefill.email && !v2.prefill.taxID, 'quem nunca comprou chega com os campos vazios');
  ok(v2.prefill.conhecido === false, 'e sem a mensagem de "te ver de novo"');

  console.log('\n=== 10c. Comprar "por fora" NÃO cria um segundo contato ===');
  // Quem já conversou no WhatsApp e depois compra pelo checkout costuma digitar
  // o celular de outro jeito. Só pelo telefone nascia uma SEGUNDA ficha: a
  // compra ia para a nova e o histórico ficava na antiga.
  const antesDeTudo = acc2.contacts.length;
  const cobrancaAvulsa = await elitepay.createCharge(acc2, {
    valueCents: 3300, comment: 'Compra por fora', origin: 'manual'
  });
  // MESMA pessoa: mesmo CPF, e o telefone digitado sem o 9 e sem o DDI.
  await elitepay.identifyPayer(cobrancaAvulsa.id, {
    name: 'João S.', taxID: '84748914009', email: 'joao@exemplo.com', phone: '8281440676'
  }, () => {});
  ok(acc2.contacts.length === antesDeTudo, `nenhum contato novo: ${antesDeTudo} → ${acc2.contacts.length}`);
  const joao = acc2.contacts.find(c => (c.vars || {}).cpf_cnpj === '84748914009');
  ok(!!joao && joao.waId === '5582981440676', 'a compra entrou na ficha que já existia: ' + (joao && joao.waId));
  ok(joao.tags.includes('Checkout'), 'e a ficha recebeu a etiqueta do checkout');

  console.log('\n=== 10d. A ETAPA de destino é escolhida pelo cliente ===');
  acc2.stages = ['Novo', 'Conversando', 'Proposta', 'Comprou', 'Sumiu'];
  joao.stage = 'Novo';
  const ep2 = elitepay.ensure(acc2);
  // Sem configurar, o Koonfy procura a etapa que PARECE de fechamento.
  ep2.settings.paidStage = '';
  elitepay.markPaidFromGateway(acc2, cobrancaAvulsa, () => {});
  ok(joao.stage === 'Comprou', `sem configurar, achou a etapa de fechamento: ${joao.stage}`);

  // Configurada, manda ela — mesmo que não pareça de fechamento.
  const outraCobranca = await elitepay.createCharge(acc2, {
    valueCents: 3300, comment: 'Outra', waId: '5582981440676', contactName: 'João Silva', origin: 'chat',
    pagador: { name: 'João Silva', document: '84748914009', email: 'joao@exemplo.com', phone: '5582981440676' }
  });
  ep2.settings.paidStage = 'Proposta';
  ep2.settings.paidTag = 'VIP';
  joao.stage = 'Novo';
  elitepay.markPaidFromGateway(acc2, outraCobranca, () => {});
  ok(joao.stage === 'Proposta', `foi para a etapa configurada: ${joao.stage}`);
  ok(joao.tags.includes('VIP'), 'com a etiqueta configurada');

  // Funil sem nenhuma etapa de fechamento: não move e não inventa.
  acc2.stages = ['Um', 'Dois', 'Três'];
  ep2.settings.paidStage = '';
  joao.stage = 'Um';
  const terceira = await elitepay.createCharge(acc2, {
    valueCents: 3300, comment: '3ª', waId: '5582981440676', contactName: 'João Silva', origin: 'chat',
    pagador: { name: 'João Silva', document: '84748914009', email: 'joao@exemplo.com', phone: '5582981440676' }
  });
  elitepay.markPaidFromGateway(acc2, terceira, () => {});
  ok(joao.stage === 'Um', `sem etapa de fechamento no funil, o contato fica onde está: ${joao.stage}`);
  acc2.stages = ['Novo', 'Em atendimento', 'Qualificado', 'Negociação', 'Ganho', 'Perdido'];
  ep2.settings.paidStage = ''; ep2.settings.paidTag = 'Cliente';

  console.log('\n=== 11. CPF INVENTADO é barrado antes de virar cobrança ===');
  const outraCob = await elitepay.createCharge(acc2, {
    valueCents: 5000, comment: 'Teste', waId: '5582988887777', contactName: 'Maria', origin: 'chat'
  });
  let eCpf = null;
  try {
    await elitepay.identifyPayer(outraCob.id, {
      name: 'Maria Souza', taxID: '123.456.789-01', email: 'maria@exemplo.com', phone: '82988887777'
    }, () => {});
  } catch (e) { eCpf = e; }
  ok(!!eCpf, 'recusado');
  ok(eCpf && /CPF inválido/i.test(eCpf.message), `com a mensagem certa: "${eCpf && eCpf.message}"`);
  ok(outraCob.brCode === '', 'e nenhuma cobrança foi gerada com o documento falso');

  // Um CPF que fecha a conta dos dígitos passa por aqui — quem confirma a
  // existência é o adquirente, e a mensagem dele chega ao cliente (seção 6).
  ok(documento.cpfValido('52998224725') && !documento.cpfValido('12345678901'),
    'dígitos verificadores: aceita o válido, recusa o inventado');
  ok(documento.cnpjValido('11222333000181') && !documento.cnpjValido('11222333000199'),
    'o mesmo vale para CNPJ');

  console.log('\n=== 11a. Com o CPF na mão, o Pix sai NA HORA ===');
  // O caso da seção 9 (nascer sem código) é o de quem não tem os dados. Quando
  // quem cobra preenche CPF e e-mail — ou o contato já os tem de uma compra
  // anterior —, não há motivo para adiar: o código sai junto com a cobrança.
  respostaFalsa = { internal_id: 'TXN_NA_HORA', status: 'pending', qrcode: '00020126...PIX-NA-HORA' };
  ultimaChamada = null;
  const jaComDados = await elitepay.createCharge(acc2, {
    valueCents: 8800, comment: 'Mentoria', waId: '5582981440676', contactName: 'João Silva', origin: 'manual',
    pagador: { name: 'João Silva', document: '84748914009', email: 'joao@exemplo.com', phone: '5582981440676' }
  });
  ok(jaComDados.brCode === '00020126...PIX-NA-HORA', 'o Pix veio junto com a cobrança');
  ok(ultimaChamada && ultimaChamada.corpo.payer.document === '84748914009', 'com o CPF que foi digitado');

  // Documento que não fecha a conta NÃO pode ir para o gateway: melhor adiar o
  // Pix do que derrubar a criação da cobrança inteira.
  ultimaChamada = null;
  const docRuim = await elitepay.createCharge(acc2, {
    valueCents: 8800, comment: 'Mentoria', waId: '5582981440676', contactName: 'João', origin: 'manual',
    pagador: { name: 'João', document: '12345678901', email: 'joao@exemplo.com', phone: '5582981440676' }
  });
  ok(docRuim.brCode === '', 'com CPF inválido a cobrança nasce sem código, em vez de falhar');
  ok(ultimaChamada === null, 'e o documento falso não chegou a ser enviado à Simplify');

  console.log('\n=== 11b. O CAMINHO DO DINHEIRO: onde fica a taxa ===');
  // É daqui que sai o lucro da plataforma. Na Simplify o depósito inteiro cai
  // na conta dela; a carteira do cliente recebe o LÍQUIDO, e a diferença é a
  // taxa. Se esta conta estiver errada, o erro é em dinheiro de verdade.
  elitepay.platformCfg().feeInPercent = 2.5;
  acc2.wallet = { balance: 0, transactions: [] };
  const vendaTaxa = await elitepay.createCharge(acc2, {
    valueCents: 19700, comment: 'Venda', waId: '5582981440676', contactName: 'Cliente', origin: 'chat'
  });
  ok(vendaTaxa.feePercent === 2.5, `a cobrança guarda a taxa aplicada: ${vendaTaxa.feePercent}%`);
  ok(vendaTaxa.platformCut === 492, `2,5% de R$ 197,00 = R$ 4,92 (${vendaTaxa.platformCut} centavos)`);

  elitepay.markPaidFromGateway(acc2, vendaTaxa, () => {});
  ok(acc2.wallet.balance === 19208,
    `o cliente recebe o líquido na carteira: R$ ${(acc2.wallet.balance / 100).toFixed(2)}`);
  ok(19700 - acc2.wallet.balance === vendaTaxa.platformCut,
    'e a diferença é exatamente a taxa, que ficou na conta da plataforma');
  elitepay.platformCfg().feeInPercent = 0;

  console.log('\n=== 12. AVISO de venda no celular do dono e do admin ===');
  const enviados = [];
  const push = require(R + 'src/push');
  const pushOrig = push.sendToAccount;
  push.sendToAccount = async (conta, tipo, payload) => { enviados.push({ conta: conta.id, tipo, payload }); };

  const admin = db.findAdminAccount();
  admin.pushSubs = [{ endpoint: 'https://exemplo/1', prefs: {} }];
  acc2.pushSubs = [{ endpoint: 'https://exemplo/2', prefs: {} }];

  const venda = { id: 'epc_av1', correlationID: 'epc_av1', value: 19700, status: 'active',
    method: 'pix', platformCut: 490, contactName: 'João Silva' };
  elitepay.ensure(acc2).charges.unshift(venda);
  elitepay.markPaidFromGateway(acc2, venda, () => {});
  await new Promise(r => setTimeout(r, 60));

  const aoDono = enviados.find(e => e.conta === acc2.id && e.tipo === 'sale');
  const aoAdmin = enviados.find(e => e.conta === admin.id && e.tipo === 'sale');
  ok(!!aoDono, 'o DONO da conta foi avisado da venda');
  ok(aoDono && /R\$\s*197,00/.test(aoDono.payload.body), `com o valor: "${aoDono && aoDono.payload.body}"`);
  ok(!!aoAdmin, 'o ADMIN da plataforma também');
  ok(aoAdmin && aoAdmin.payload.title.includes(acc2.name), `dizendo quem vendeu: "${aoAdmin && aoAdmin.payload.title}"`);
  ok(aoAdmin && /4,90/.test(aoAdmin.payload.body), `e quanto ficou de taxa: "${aoAdmin && aoAdmin.payload.body}"`);

  console.log('\n=== 13. AVISO de comissão para o afiliado ===');
  enviados.length = 0;
  const afiliado = { id: 'acc_af', name: 'Quem Indicou', pushSubs: [{ endpoint: 'https://exemplo/3', prefs: {} }] };
  require(R + 'src/avisos').avisarComissao(afiliado, { amount: 2910, percent: 30, kind: 'first', indicado: 'Loja do Teste' });
  await new Promise(r => setTimeout(r, 60));
  const aoAfiliado = enviados.find(e => e.conta === 'acc_af' && e.tipo === 'commission');
  ok(!!aoAfiliado, 'o afiliado foi avisado');
  ok(aoAfiliado && /29,10/.test(aoAfiliado.payload.body), `com o valor da comissão: "${aoAfiliado && aoAfiliado.payload.body}"`);
  ok(aoAfiliado && /30%/.test(aoAfiliado.payload.body), 'o percentual');
  ok(aoAfiliado && /Loja do Teste/.test(aoAfiliado.payload.body), 'e de quem veio');
  push.sendToAccount = pushOrig;

  console.log('\n=== 14. A tela do Admin grava e devolve mascarado ===');
  // A conta de mentira das seções 7 e 8 sai daqui: ela só tem o necessário para
  // o webhook, e o painel do Admin lê muito mais campos de cada conta.
  db.get().accounts = db.get().accounts.filter(a => a.id !== 'acc_sp');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api', require(R + 'src/api')(() => {}));
  const srv = app.listen(3994);
  await new Promise(r => setTimeout(r, 150));
  const API = 'http://127.0.0.1:3994/api';
  const login = await (await fetch(API + '/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const tok = login.token;
  ok(!!tok, 'admin entrou');
  const post = (rota, corpo) => fetch(API + rota, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify(corpo)
  }).then(async r => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error('PUT ' + rota + ' → ' + r.status + ' ' + t.slice(0, 120)); } });
  const saas = () => fetch(API + '/admin/saas', { headers: { Authorization: 'Bearer ' + tok } })
    .then(async r => { const t = await r.text(); try { return JSON.parse(t); } catch { throw new Error('GET /admin/saas → ' + r.status + ' ' + t.slice(0, 120)); } });

  await post('/admin/config', {
    gateway: 'simplify', simplifyClientId: 'CID_DO_ADMIN',
    simplifyClientSecret: 'SEG_DO_ADMIN', simplifySplitUser: 'koonfy', simplifySplitPct: '3,5'
  });
  let d = await saas();
  ok(d.config.gateway === 'simplify', 'o adquirente ativo virou Simplify');
  ok(d.config.simplify.configured === true, 'a tela mostra como configurado');
  ok(d.config.simplify.splitUsername === 'koonfy', 'guardou o usuário do split');
  ok(d.config.simplify.splitPercent === 3.5, 'vírgula virou ponto no percentual: ' + d.config.simplify.splitPercent);
  // O segredo nunca pode voltar para o navegador.
  const txt = JSON.stringify(d);
  ok(!txt.includes('SEG_DO_ADMIN'), 'o Client Secret NÃO volta na resposta');
  ok(!txt.includes('CID_DO_ADMIN'), 'nem o Client ID inteiro');
  ok(/^••••/.test(d.config.simplify.clientId), 'o Client ID vem mascarado: ' + d.config.simplify.clientId);

  // Um percentual acima do teto da Simplify não pode ser gravado: a cobrança
  // inteira seria recusada lá na hora do pagamento.
  await post('/admin/config', { simplifySplitPct: '150' });
  d = await saas();
  ok(d.config.simplify.splitPercent === 90, `150% foi limitado a ${d.config.simplify.splitPercent}%`);

  // Salvar sem mexer nas credenciais não pode apagá-las.
  await post('/admin/config', { simplifySplitUser: 'outro' });
  ok(elitepay.gateway().id === 'simplify' && simplify.configured(), 'salvar só o split não derruba as credenciais');

  await post('/admin/config', { gateway: 'woovi' });
  ok((await saas()).config.gateway === 'woovi', 'dá para voltar para a Woovi');
  srv.close();

  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exitCode = falhas ? 1 : 0;
  setTimeout(() => process.exit(falhas ? 1 : 0), 50).unref();
})().catch(e => { console.error(e); process.exit(1); });
