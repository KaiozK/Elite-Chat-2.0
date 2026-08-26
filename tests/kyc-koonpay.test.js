// KYC DO KOONPAY — a conferência manual, feita por gente.
//
// Antes de uma conta receber dinheiro pelo Koonfy, alguém olha quem ela é. O
// caminho é: o cliente CONFERE os dados que já deu no cadastro, MANDA a foto do
// documento e a do rosto segurando o documento, e a conta fica EM ANÁLISE até
// um humano no Admin decidir.
//
// O que este teste protege, e por quê:
//
// 1. O PORTÃO É DE VERDADE. Se `activeSubaccount` não recusar, a conta cobra
//    sem análise nenhuma — e o KYC vira enfeite. É a asserção mais importante
//    do arquivo.
//
// 2. LIGAR A EXIGÊNCIA NÃO PODE DERRUBAR QUEM JÁ VENDE. O interruptor nasce
//    desligado e, desligado, todo mundo recebe como antes.
//
// 3. AS FOTOS SAEM QUANDO A DECISÃO SAI. Documento e rosto de todo cliente
//    guardados para sempre é risco acumulado sem benefício: o que precisa
//    sobreviver é o registro de que houve análise, quem decidiu e quando.
//
// 4. AS FOTOS NÃO MORAM NA CONTA. Dentro do pedaço da conta elas seriam
//    reescritas no banco a cada mensagem recebida — centenas de KB para
//    regravar bytes idênticos.
//
// 5. REPROVAR EXIGE MOTIVO. Sem ele o cliente reenvia a mesma coisa.
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

const db = require(R + 'src/db');
const kyc = require(R + 'src/kyc');
const pagamentos = require(R + 'src/pagamentos');
const BASE = 'http://127.0.0.1:3975';

// 1x1 JPEG de mentira: o que se testa é o caminho, não a imagem.
const FOTO = 'data:image/jpeg;base64,'.length ? '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=' : '';
const foto = () => ({ mime: 'image/jpeg', data: FOTO });

(async () => {
  await db.loadAsync();

  const acc = db.newAccount({ name: 'Loja do Zé', email: 'ze@loja.com', pass: 'segredo123' });
  acc.billing.status = 'active';
  acc.billing.periodEnd = Date.now() + 30 * 86400000;
  acc.profile.document = '11144477735';
  acc.profile.phone = '5511988887777';
  db.get().accounts.push(acc);
  const ep = pagamentos.ensure(acc);
  ep.subaccount = { status: 'active', name: 'Loja do Zé', document: '11144477735',
    email: 'ze@loja.com', phone: '5511988887777', pixKey: '11144477735', pixKeyType: 'cpf' };
  db.save();

  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3975);
  await new Promise(r => setTimeout(r, 150));

  const login = await (await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'ze@loja.com', pass: 'segredo123' })
  })).json();
  const aut = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };

  const admLogin = await (await fetch(BASE + '/api/adm/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', pass: 'admin' })
  })).json();
  const autAdm = { Authorization: 'Bearer ' + admLogin.token, 'Content-Type': 'application/json' };

  console.log('=== 1. Desligado, o KYC não atrapalha ninguém ===');
  // Ligar a exigência não pode derrubar quem já estava vendendo: por isso ela
  // nasce desligada, e desligada todo mundo recebe como antes.
  ok(kyc.exigido() === false, 'a exigência nasce desligada');
  ok(kyc.podeReceber(acc) === true, 'e uma conta sem KYC nenhum recebe normalmente');
  ok(!!pagamentos.ensure(acc).subaccount, 'a subconta continua de pé');

  console.log('\n=== 2. Os dados já vêm preenchidos do cadastro ===');
  // Pedir de novo o que a pessoa já deu é o jeito mais rápido de fazer alguém
  // desistir no meio.
  const visao = await (await fetch(BASE + '/api/kyc', { headers: aut })).json();
  ok(visao.dados.nome === 'Loja do Zé', `nome: ${visao.dados.nome}`);
  ok(visao.dados.documento === '11144477735', 'CPF do cadastro');
  ok(visao.dados.email === 'ze@loja.com', 'e-mail da conta');
  ok(visao.dados.telefone === '5511988887777', 'telefone do perfil');
  ok(visao.dados.documentoTipo === 'CPF', 'e sabe que é CPF pelo tamanho');
  ok(visao.status === 'nao_enviado', 'ainda não enviou nada');
  ok(visao.pecas.length === 2, 'e são DUAS fotos pedidas, sempre');

  console.log('\n=== 3. Agora a plataforma passa a exigir ===');
  // O adquirente é a SIMPLIFY nesta parte do arquivo, e é isso que torna a
  // conferência MANUAL a que vale: com a Woovi quem verifica é ela, e nada
  // deste caminho acontece (ver seção 13).
  pagamentos.platformCfg().gateway = 'simplify';
  db.save();
  await fetch(BASE + '/api/adm/kyc/exigir', { method: 'PUT', headers: autAdm, body: JSON.stringify({ exigido: true }) });
  ok(kyc.exigido() === true, 'o admin ligou a exigência');
  ok(kyc.podeReceber(acc) === false, 'e a conta sem análise deixa de poder receber');

  console.log('\n=== 4. O PORTÃO: sem aprovação não se cobra ===');
  // A asserção mais importante do arquivo. Sem ela o KYC é enfeite.
  let barrou = '';
  try { pagamentos.activeSubaccount(acc); }
  catch (e) { barrou = e.message; }
  ok(/verificação de identidade/i.test(barrou), `recusado antes de cobrar: "${barrou}"`);

  console.log('\n=== 5. Envio incompleto não entra ===');
  const soUmaFoto = await fetch(BASE + '/api/kyc', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ dados: { ...visao.dados, nascimento: '1990-05-10' }, fotos: { documento: foto() } })
  });
  ok(soUmaFoto.status === 400, 'faltando a foto do rosto: 400');
  const erroFoto = (await soUmaFoto.json()).error;
  ok(/rosto/i.test(erroFoto), `e a mensagem diz qual falta: "${erroFoto}"`);

  const docRuim = await fetch(BASE + '/api/kyc', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ dados: { ...visao.dados, documento: '11111111111', nascimento: '1990-05-10' },
      fotos: { documento: foto(), selfie: foto() } })
  });
  ok(docRuim.status === 400, 'CPF inválido é recusado, e não guardado para o admin descobrir depois');

  console.log('\n=== 6. Envio completo põe a conta em análise ===');
  const envio = await (await fetch(BASE + '/api/kyc', {
    method: 'POST', headers: aut,
    body: JSON.stringify({
      dados: { ...visao.dados, nascimento: '1990-05-10', cep: '01310100', endereco: 'Av. Paulista', numero: '1000', cidade: 'São Paulo', uf: 'SP' },
      fotos: { documento: foto(), selfie: foto() }
    })
  })).json();
  ok(envio.status === 'em_analise', `status: ${envio.status}`);
  ok(envio.podeReceber === false, 'e continua sem poder receber enquanto espera');
  ok(!JSON.stringify(envio).includes(FOTO.slice(0, 40)),
     'a resposta ao CLIENTE não devolve as fotos — ele já as tem, e reenviá-las só amplia por onde vazam');

  console.log('\n=== 7. As fotos ficam FORA do pedaço da conta ===');
  // Dentro dele seriam reescritas no banco a cada mensagem recebida.
  const contaSerializada = JSON.stringify(db.findAccount(acc.id));
  ok(!contaSerializada.includes(FOTO.slice(0, 40)), 'a conta serializada não carrega as imagens');
  ok(!!db.get().kycArquivos[acc.id], 'elas moram em kycArquivos, que é pedaço próprio no banco');

  console.log('\n=== 8. O admin vê a fila e a ficha inteira ===');
  const fila = await (await fetch(BASE + '/api/adm/kyc', { headers: autAdm })).json();
  ok(fila.itens.length === 1, `um na fila: ${fila.itens.length}`);
  ok(fila.itens[0].status === 'em_analise', 'em análise');
  ok(!JSON.stringify(fila).includes(FOTO.slice(0, 40)), 'a LISTA não carrega as fotos — são dezenas de linhas');

  const ficha = await (await fetch(BASE + `/api/adm/kyc/${acc.id}`, { headers: autAdm })).json();
  ok(!!ficha.fotos.documento && !!ficha.fotos.selfie, 'a FICHA traz as duas fotos, que é o que se analisa');
  ok(ficha.dados.nascimento === '1990-05-10', 'com os dados confirmados');
  ok(ficha.dados.cidade === 'São Paulo', 'e o endereço informado no KYC');
  // Decidir olhando só a foto é decidir com metade da informação.
  ok(ficha.conta.id === acc.id && ficha.conta.tipo === 'Cliente', 'o contexto da conta vem junto');
  ok(typeof ficha.conta.contatos === 'number' && typeof ficha.conta.cobrancas === 'number',
     'com quanto ela já usou o produto');
  ok('whatsappConectado' in ficha.conta, 'e se o WhatsApp está conectado');

  console.log('\n=== 9. Reprovar exige motivo ===');
  const semMotivo = await fetch(BASE + `/api/adm/kyc/${acc.id}/revisar`, {
    method: 'POST', headers: autAdm, body: JSON.stringify({ aprovar: false })
  });
  ok(semMotivo.status === 400, 'reprovar sem dizer por quê é recusado');
  ok(kyc.ensure(acc).status === 'em_analise', 'e o estado não muda pela metade');

  const reprovou = await (await fetch(BASE + `/api/adm/kyc/${acc.id}/revisar`, {
    method: 'POST', headers: autAdm,
    body: JSON.stringify({ aprovar: false, motivo: 'A foto do documento está ilegível' })
  })).json();
  ok(reprovou.status === 'reprovado', 'com motivo, reprova');
  ok(!db.get().kycArquivos[acc.id], 'e as fotos são APAGADAS assim que a decisão sai');

  const visaoReprovada = await (await fetch(BASE + '/api/kyc', { headers: aut })).json();
  ok(/ilegível/.test(visaoReprovada.motivo), `o cliente lê o motivo: "${visaoReprovada.motivo}"`);

  console.log('\n=== 10. Reprovado pode corrigir e mandar de novo ===');
  await fetch(BASE + '/api/kyc/refazer', { method: 'POST', headers: aut });
  ok(kyc.ensure(acc).status === 'nao_enviado', 'volta ao começo');
  const reenvio = await (await fetch(BASE + '/api/kyc', {
    method: 'POST', headers: aut,
    body: JSON.stringify({ dados: { ...visao.dados, nascimento: '1990-05-10' }, fotos: { documento: foto(), selfie: foto() } })
  })).json();
  ok(reenvio.status === 'em_analise', 'e entra na fila outra vez');
  ok(kyc.ensure(acc).tentativas === 2, `contando a tentativa: ${kyc.ensure(acc).tentativas}`);

  console.log('\n=== 11. Aprovado, a conta volta a cobrar ===');
  const aprovou = await (await fetch(BASE + `/api/adm/kyc/${acc.id}/revisar`, {
    method: 'POST', headers: autAdm, body: JSON.stringify({ aprovar: true })
  })).json();
  ok(aprovou.status === 'aprovado', 'aprovado');
  ok(!db.get().kycArquivos[acc.id], 'fotos apagadas também na aprovação');
  ok(kyc.podeReceber(acc) === true, 'a conta passa a poder receber');
  let cobrou = true;
  try { pagamentos.activeSubaccount(acc); } catch { cobrou = false; }
  ok(cobrou, 'e o portão da cobrança abre');

  // O registro de que houve análise é o que precisa sobreviver às fotos.
  const k = kyc.ensure(acc);
  ok(k.revisadoEm > 0 && k.revisadoPor, `fica quem decidiu e quando: ${k.revisadoPor}`);

  console.log('\n=== 12. As rotas do admin são só do admin ===');
  ok((await fetch(BASE + '/api/adm/kyc', { headers: aut })).status === 403,
     'o cliente não vê a fila');
  ok((await fetch(BASE + `/api/adm/kyc/${acc.id}`, { headers: aut })).status === 403,
     'nem a ficha com as fotos de ninguém');
  const tentouAprovar = await fetch(BASE + `/api/adm/kyc/${acc.id}/revisar`, {
    method: 'POST', headers: aut, body: JSON.stringify({ aprovar: true })
  });
  ok(tentouAprovar.status === 403, 'e não aprova a si mesmo');


  console.log('\n=== 13. QUEM confere depende do adquirente ===');
  // São duas realidades diferentes, e um interruptor só:
  //
  //   WOOVI    tem KYC próprio na API (POST /api/v1/kyc/onboarding). Ela abre a
  //            página, o cliente faz tudo lá, e a aprovação chega por webhook.
  //            O documento NUNCA passa pelo Koonfy — dado que não se guarda é
  //            dado que não vaza.
  //   SIMPLIFY não tem esse fluxo. Aqui a conferência é a manual: foto do
  //            documento, foto do rosto, e alguém olhando.
  //
  // Dois interruptores independentes deixariam ligar o manual com a Woovi ativa
  // e cobrar do cliente uma foto que ninguém precisa ver.
  const cfgPg = pagamentos.platformCfg();
  const antesGw = cfgPg.gateway;

  cfgPg.gateway = 'woovi'; cfgPg.kycObrigatorio = true;
  ok(kyc.modo() === 'woovi', `Woovi + exigência = KYC da Woovi: ${kyc.modo()}`);
  ok(kyc.exigido() === false, 'e a conferência MANUAL sai do jogo — quem verifica é ela');

  cfgPg.gateway = 'simplify';
  ok(kyc.modo() === 'manual', `Simplify + exigência = conferência manual: ${kyc.modo()}`);
  ok(kyc.exigido() === true, 'e o portão manual volta a valer');

  cfgPg.kycObrigatorio = false;
  ok(kyc.modo() === 'nenhum', 'sem exigência, nenhum dos dois');
  ok(kyc.exigido() === false, 'e ninguém é barrado');

  // O painel precisa CONTAR qual está valendo: sem isso o admin liga a
  // exigência com a Woovi, vê a fila sempre vazia e conclui que quebrou.
  cfgPg.gateway = 'woovi'; cfgPg.kycObrigatorio = true;
  const painel = await (await fetch(BASE + '/api/adm/kyc', { headers: autAdm })).json();
  ok(painel.modo === 'woovi', `a aba do Admin sabe o modo: ${painel.modo}`);
  ok(painel.gateway === 'woovi', 'e qual adquirente decidiu isso');
  cfgPg.gateway = antesGw;
  db.save();

  console.log('\n=== 14. Com a Woovi, o cadastro abre o KYC DELA ===');
  // `registerSubaccount` não pode depender de o admin marcar `onboardingMode`
  // também: um interruptor que precisa de outro para funcionar é um
  // interruptor que um dia fica pela metade.
  const fonte = fs.readFileSync(R + 'src/pagamentos.js', 'utf8');
  ok(/require\('\.\/kyc'\)\.modo\(\) === 'woovi'/.test(fonte),
     'o modo do KYC entra na decisão do cadastro, junto do onboardingMode');
  // E o driver da Woovi tem mesmo a chamada — não é promessa, é rota.
  ok(/\/api\/v1\/kyc\/onboarding/.test(fonte), 'o driver chama POST /api/v1/kyc/onboarding');
  ok(/ACCOUNT_REGISTER_APPROVED/.test(fs.readFileSync(R + 'src/woovi.js', 'utf8')),
     'e o webhook de aprovação da Woovi está tratado');
  // A Simplify não tem esse caminho, e diz isso em vez de fingir que tem.
  ok(/A Simplify não usa KYC pelo Koonfy/.test(fonte),
     'a Simplify recusa o KYC de gateway explicitamente');

  console.log('\n=== 15. O envio para análise avisa o ADMIN no celular ===');
  // Uma fila de KYC parada trava dinheiro do outro lado: enquanto ninguém olha,
  // aquela conta não recebe.
  const avisos = require(R + 'src/avisospush');
  const aviso = avisos.avisoDoEvento('kyc', {
    accountId: 'acc_9', conta: 'Loja do Zé', nome: 'José da Silva', status: 'em_analise'
  });
  ok(!!aviso && aviso.paraAdmin === true, 'o aviso é para o ADMIN, e não para quem enviou');
  ok(/KYC/.test(aviso.payload.title), 'o título diz do que se trata');
  ok(aviso.payload.body.includes('José da Silva'), 'e o corpo diz de quem');
  ok(aviso.payload.data.url === '/adm/#/adm/kyc', 'tocar leva direto para a aba onde se decide');
  ok(aviso.payload.requireInteraction === true, 'e fica na tela: é aviso para AGIR');
  // Aprovação e reprovação não viram push para o admin — foi ELE quem decidiu.
  ok(avisos.avisoDoEvento('kyc', { accountId: 'acc_9', status: 'aprovado' }) === null,
     'a própria decisão dele não vira aviso de volta');

  srv.close();
  await encerrar(srv, falhas);
})();
