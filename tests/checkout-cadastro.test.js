// ============================================================================
// O CADASTRO DENTRO DO CHECKOUT — a etapa depois do pagamento
//
// O cadastro do Koonfy mudou de lugar: era um formulário no /app e virou a
// última etapa do /assinar, depois do Pix confirmado. Numa mudança dessas, o
// jeito de perder um campo é não perceber que ele existia.
//
// E perder um campo aqui não é cosmético. O SEGMENTO decide se o Modo Bet
// aparece no Tracking; o DOCUMENTO é o que o Koonpay usa para abrir a conta de
// recebimento; o TELEFONE é para onde vão os avisos. Um cadastro pela metade
// produz uma conta que não consegue usar metade do que pagou.
//
// Este arquivo compara as duas listas, campo a campo, e é a rede que impede a
// próxima mexida no checkout de derrubar um deles em silêncio.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
const fs = require('fs');
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const assinar = fs.readFileSync(R + 'public/assinar.html', 'utf8');
const antigo = fs.readFileSync(R + 'public/app/index.html', 'utf8');
const pre = fs.readFileSync(R + 'src/preassinatura.js', 'utf8');

// ---- banco e servidor de mentira, para o bloco 10 ----
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

// O e-mail nunca sai de verdade — o que importa é PARA QUEM e COM QUAL link.
const enviados = [];
const mailer = require(R + 'src/mailer');
mailer.configured = () => true;
mailer.enviarLinkCadastro = async (email, url, plano) => { enviados.push({ email, url, plano }); };

const db = require(R + 'src/db');
const preassinatura = require(R + 'src/preassinatura');
const BASE = 'http://127.0.0.1:3986';

(async () => {
  console.log('=== 1. Os campos do formulário ANTIGO estão todos no checkout ===');
  // A lista da esquerda é o que o formulário antigo pedia (public/app/index.html,
  // ids `reg-*`). A da direita é onde cada um foi parar no checkout.
  const equivalencias = [
    ['reg-name',    'empresa',   'Nome da empresa'],
    ['reg-segment', 'segment',   'Segmento'],
    ['reg-size',    'size',      'Quantas pessoas na equipe'],
    ['reg-goal',    'goal',      'O que quer resolver primeiro'],
    ['reg-phone',   'telefone',  'WhatsApp'],
    ['reg-doc',     'documento', 'CPF/CNPJ'],
    ['reg-pixtipo', 'pixtipo',   'Tipo da chave Pix'],
    ['reg-pixkey',  'pixkey',    'Chave Pix']
  ];
  for (const [velho, novo, nome] of equivalencias) {
    ok(antigo.includes('id="' + velho + '"'), `o formulário antigo pedia: ${nome}`);
    ok(assinar.includes('id="' + novo + '"'), `  e o checkout pede também (id="${novo}")`);
  }
  // O site não estava no antigo — nasceu com o iGaming — mas precisa existir.
  ok(assinar.includes('id="site"'), 'e o site da plataforma, que o iGaming exige');

  console.log('\n=== 2. E todos são ENVIADOS ===');
  // Um campo na tela que não entra no corpo da requisição é pior do que campo
  // nenhum: a pessoa preenche, confia, e o dado morre no navegador.
  const envio = assinar.slice(assinar.indexOf("'/concluir'"), assinar.indexOf("'/concluir'") + 700);
  for (const campo of ['empresa', 'senha', 'size', 'goal', 'segment', 'site', 'pixKeyType', 'pixKey']) {
    ok(new RegExp(campo + ':').test(envio), `${campo} vai no envio`);
  }

  console.log('\n=== 3. E o servidor GUARDA todos ===');
  const conc = pre.slice(pre.indexOf('function concluir'), pre.indexOf('function concluir') + 2200);
  ok(/'size', 'goal'/.test(conc), 'size e goal são gravados no perfil');
  ok(/segmentos'\)\.aplicar/.test(conc) || /require\('\.\/segmentos'\)/.test(conc),
     'segmento e site passam pela validação de sempre');
  ok(/acc\.profile\.pixKey = /.test(conc), 'a chave Pix é gravada');
  ok(/acc\.profile\.pixKeyType = /.test(conc), 'com o tipo dela');

  console.log('\n=== 4. A chave Pix é OPCIONAL ===');
  // A conta já foi PAGA quando chega nesta etapa. Exigir um dado que a pessoa
  // pode não ter em mãos faria perder um cadastro com o dinheiro já dentro.
  ok(/if \(b\.pixKey\)/.test(conc),
     'só grava se veio — sem a chave, a conta nasce igual e o Koonpay é concluído depois');
  const campoPix = assinar.slice(assinar.indexOf('id="pixtipo"') - 400, assinar.indexOf('id="pixtipo"') + 200);
  ok(/opcional/i.test(campoPix), 'e a tela diz que é opcional, em vez de deixar a pessoa adivinhar');
  ok(!/id="pixkey"[^>]*required/.test(assinar), 'sem `required` no campo');

  console.log('\n=== 5. O campo do site fica ESCONDIDO até ser preciso ===');
  // O DEFEITO QUE ISTO PRENDE: o campo nascia com o atributo `hidden` e
  // aparecia assim mesmo. A folha declara `label{display:grid}`, que é mais
  // específica que a regra `[hidden]{display:none}` do navegador — então o
  // atributo não fazia nada.
  //
  // Resultado: 93px pedindo "Site da plataforma" para quem vende sapato, em
  // todo cadastro. Só dá para ver abrindo a tela; nenhum teste de lógica pega.
  ok(/label\[hidden\]\{display:none\}/.test(assinar),
     'a folha devolve ao atributo `hidden` o poder que a regra do `label` tirou dele');
  ok(assinar.indexOf('label[hidden]{display:none}') > assinar.indexOf('label{display:grid'),
     'e vem DEPOIS da regra do label — em CSS de mesma especificidade, quem vem por último vence');
  ok(/id="campo-site" hidden/.test(assinar), 'o campo nasce escondido');
  ok(/\$\('campo-site'\)\.hidden = !pede;/.test(assinar),
     'e só aparece para o segmento que exige o endereço');

  console.log('\n=== 6. A etapa 3 NÃO repete a etapa 1 ===');
  // Nome, WhatsApp, e-mail e documento são digitados ANTES do pagamento e não
  // mudam depois. Apareciam de novo aqui como quatro campos somente-leitura —
  // meia tela de repetição num formulário que precisa ser curto, mostrada a
  // quem acabou de pagar e só quer entrar.
  for (const campo of ['c-nome', 'c-email', 'c-telefone', 'c-documento']) {
    ok(!assinar.includes('id="' + campo + '"'), `${campo} não é repetido na etapa 3`);
  }
  // E o script não pode ter ficado apontando para elementos que não existem
  // mais: uma atribuição a `$('c-nome').value` com o campo removido é
  // TypeError na etapa que mais importa — a que cria a conta de quem já pagou.
  ok(!/\$\('c-(nome|email|telefone|documento)'\)/.test(assinar),
     'e o script não procura mais por eles');

  // O que a etapa 3 pede é só o que ainda não foi perguntado.
  for (const campo of ['empresa', 'senha', 'size', 'goal', 'segment', 'pixtipo', 'pixkey']) {
    ok(assinar.includes('id="' + campo + '"'), `a etapa 3 pede ${campo}, que é novo`);
  }

  console.log('\n=== 7. Quem fecha a aba consegue voltar ===');
  // O token identifica um cadastro JÁ PAGO, e vivia só na barra de endereços.
  // Isso cobre o F5 — a URL continua ali — e mais nada.
  //
  // Fechar a aba e voltar ao site era o fim da linha: a conta existe no banco,
  // com o pagamento dentro, mas nasce com senha aleatória e `pendenteCadastro`.
  // A pessoa não consegue entrar (nunca definiu senha) nem continuar (não tem
  // o token). Só o suporte resolvia — por um dado que o próprio navegador
  // podia ter guardado.
  ok(/localStorage\.getItem\(GUARDA\)/.test(assinar), 'o token é lido do armazenamento');
  ok(/localStorage\.setItem\(GUARDA, t\)/.test(assinar), 'e guardado quando a cobrança nasce');
  ok(/var token = qs\.get\('token'\) \|\| tokenGuardado\(\)/.test(assinar),
     'a URL vem primeiro — quem chega por um link vê AQUELE cadastro, não o guardado');

  console.log('\n=== 8. E o token guardado não sequestra a próxima visita ===');
  // É a metade que faltaria se eu só tivesse guardado: um token concluído (ou
  // que não existe mais) sobrevivendo faria toda visita a /assinar tentar
  // retomar um cadastro morto, e a pessoa nunca mais veria o formulário do
  // começo.
  const boot = assinar.slice(assinar.indexOf("if (token) {"), assinar.length);
  ok(/if \(!d \|\| !d\.status\) \{ esquecerToken\(\); return; \}/.test(boot),
     'token que o servidor não reconhece é apagado');
  ok(/d\.status === 'done'.*esquecerToken\(\)/.test(boot),
     'e o concluído também, antes de mandar para o app');
  const fim = assinar.slice(assinar.indexOf("/concluir"), assinar.indexOf("/concluir") + 1400);
  ok(/esquecerToken\(\)/.test(fim), 'e ao terminar o cadastro, o token é esquecido');

  console.log('\n=== 9. Nada ficou apontando para o que foi removido ===');
  // `preencher()` alimentava os quatro campos repetidos. Com eles fora, ela
  // virou uma casca vazia — função que não faz nada é armadilha para quem ler
  // depois e achar que faz.
  ok(!/preencher/.test(assinar), 'a função que preenchia os campos removidos saiu junto');

  console.log('\n=== 10. Quem volta clica em ENTRAR, e isso precisa resolver ===');
  // É o que a pessoa faz naturalmente: do ponto de vista dela a conta já existe,
  // porque ela pagou. O que ela não sabe é que ainda não tem senha — a senha se
  // define na etapa que ela não terminou.
  //
  // A tela de entrada já respondia "abra o link que você recebeu", e NADA nunca
  // mandou link nenhum. Era uma instrução impossível de seguir, no meio do
  // caminho de quem acabou de pagar.
  await db.loadAsync();
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api', require(R + 'src/api')(() => {}, new Set()));
  const srv = app.listen(3986);
  await new Promise(r => setTimeout(r, 150));

  db.get().platform.baseUrl = 'https://koonfy.test';
  db.get().plans.push({ id: 'pl1', name: 'Profissional', price: 19700, periodDays: 30, limits: {}, modules: {} });
  db.save();

  // Uma conta paga e ainda sem cadastro — o estado exato de quem fechou a aba.
  const acc = db.newAccount({ name: 'Fulano', email: 'volta@ex.com', pass: 'aleatoria-nao-usavel' });
  acc.pendenteCadastro = true;
  db.get().accounts.push(acc);
  // `lista()` do módulo é quem cria o array na primeira leitura; aqui a
  // pré-assinatura é montada à mão, então a inicialização vem junto.
  if (!Array.isArray(db.get().preassinaturas)) db.get().preassinaturas = [];
  db.get().preassinaturas.push({
    id: 'pre1', token: 'tok-de-teste', planId: 'pl1', accountId: acc.id,
    email: acc.email, nome: 'Fulano', status: 'paid', criadoEm: Date.now(), pagoEm: Date.now()
  });
  db.save();

  enviados.length = 0;
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'volta@ex.com', pass: 'qualquer-coisa' })
  });
  const j = await r.json();
  ok(r.status === 409, `o Entrar responde 409, e não "senha inválida": ${r.status}`);
  ok(j.code === 'cadastro_pendente', 'com um código que a tela pode tratar');
  ok(enviados.length === 1, 'e o link SAI por e-mail — a promessa da mensagem virou verdade');
  ok(enviados[0].email === 'volta@ex.com', 'para o e-mail da conta');
  ok(/\/assinar\?plano=pl1&token=tok-de-teste/.test(enviados[0].url),
     'com o link que retoma exatamente aquele cadastro: ' + enviados[0].url);
  ok(/Mandamos o link/.test(j.error), 'e a mensagem diz o que acabou de acontecer');

  // O LINK NÃO APARECE NA RESPOSTA, e isso é o ponto de segurança do bloco:
  // concluir o cadastro é DEFINIR A SENHA. Entregar o token a quem digitar o
  // e-mail seria entregar uma conta JÁ PAGA a um estranho.
  const corpo = JSON.stringify(j);
  ok(!/tok-de-teste/.test(corpo), 'o token NÃO volta na resposta');
  ok(!/\/assinar\?/.test(corpo), 'nem o link');

  console.log('\n=== 11. Sem e-mail configurado, a mensagem não promete ===');
  // Prometer um e-mail que não vai chegar é pior do que dizer a verdade: a
  // pessoa fica esperando na caixa de entrada em vez de chamar o suporte.
  mailer.configured = () => false;
  const r2 = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'volta@ex.com', pass: 'x' })
  });
  const j2 = await r2.json();
  ok(/suporte/i.test(j2.error), 'manda falar com o suporte: ' + j2.error);
  ok(!/Mandamos/.test(j2.error), 'e não diz que mandou nada');
  mailer.configured = () => true;

  console.log('\n=== 12. O link também sai quando o pagamento confirma ===');
  // É o momento em que a pessoa mais pode fechar a aba: o Pix confirmou e ela
  // acha que acabou. Esperar ela tentar entrar para só então mandar seria
  // mandar tarde.
  ok(/mandarLink\(pre\)/.test(pre), 'a confirmação do pagamento dispara o envio');
  ok(/catch\(\(\) => \{\}\)/.test(pre.slice(pre.indexOf('mandarLink(pre)'), pre.indexOf('mandarLink(pre)') + 80)),
     'sem poder derrubar nada: o pagamento já entrou, e falha de e-mail não desfaz pagamento');

  srv.close();
  await encerrar(null, falhas);
})();
