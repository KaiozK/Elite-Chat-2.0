// ============================================================================
// NUVEMSHOP — o cliente que se cadastra na loja vira contato com os dados
//
// Dois defeitos reais, os dois com a MESMA aparência: a Nuvemshop chama, o
// Koonfy responde 200, e nada acontece. Um 200 é a resposta certa (o webhook
// foi recebido) — e por isso o defeito passa despercebido do lado de lá.
//
//   · O TELEFONE SÓ ERA LIDO DE `phone`. Na Nuvemshop quem se cadastra quase
//     nunca preenche esse campo: o número aparece é no ENDEREÇO. Sem número
//     não existe contato de WhatsApp para criar, e o evento morria ali.
//   · O EVENTO DE CLIENTE NOVO NÃO TINHA VARIÁVEIS. Só "total gasto" e
//     "pedidos" — que num cadastro novo nascem zerados. Nome, e-mail e
//     telefone eram lidos pelo código e jogados fora sem virar variável, então
//     a automação de boas-vindas não tinha nem como escrever "Olá, Fulano".
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
const nuvem = require(path.join(R, 'src', 'nuvemshop'));

db.load();
const data = db.get();
data.accounts.length = 0;

const acc = db.newAccount({ name: 'Lojista', email: 'lojista@teste.local', pass: '123456' });
data.accounts.push(acc);
const c = nuvem.cfg(acc);
c.storeId = '99'; c.accessToken = 'tok'; c.storeName = 'Loja do Kaio'; c.autoContact = true; c.tags = ['nuvemshop'];

// A API da Nuvemshop, de mentira: devolve o cliente como ela devolve de verdade.
let respostaDaApi = null;
// `apiFetch` lê o corpo com `text()` e faz o JSON.parse ele mesmo — o falso
// precisa responder do mesmo jeito, senão testa outra coisa.
global.fetch = async () => ({
  ok: true, status: 200,
  text: async () => JSON.stringify(respostaDaApi),
  json: async () => respostaDaApi
});

(async () => {
  console.log('=== 1. Cliente novo COM telefone só no endereço (o caso comum) ===');
  // É assim que a Nuvemshop entrega: `phone` vazio no cadastro, e o número
  // dentro de default_address.
  respostaDaApi = {
    id: 501, name: 'Isabela Ramos', email: 'isabela@cliente.com',
    phone: null, total_spent: '0.00', total_orders: 0, created_at: '2026-09-07T16:20:00-0300',
    identification: '11144477735',
    default_address: { phone: '11988887777', city: 'São Paulo', province: 'SP' }
  };
  const r = await nuvem.handleEvent(acc, 'customer/created', 501, null);
  ok(!!r.contact, 'o contato É criado', r.contact ? r.contact.name : 'não criou');
  ok(r.telefone === '11988887777', 'com o telefone pescado do endereço', r.telefone);
  ok(r.contact && r.contact.name === 'Isabela Ramos', 'e com o nome certo');
  ok(r.contact && r.contact.email === 'isabela@cliente.com', 'e o e-mail');
  const logOk = db.get().webhookLog[0] || {};
  ok(logOk.campos === undefined,
     'e quando o telefone VEM, o log não carrega o diagnóstico — seria ruído em toda linha');
  ok((r.contact.tags || []).includes('nuvemshop'), 'com a tag da integração');

  console.log('\n=== 2. E as variáveis chegam preenchidas na automação ===');
  const v = r.vars;
  ok(v.cliente_nome === 'Isabela Ramos', 'cliente_nome', v.cliente_nome);
  // A saudação quer o primeiro nome. Deixar isso para a automação faria cada
  // pessoa resolver o mesmo problema na mão.
  ok(v.cliente_primeiro_nome === 'Isabela', 'cliente_primeiro_nome (para a saudação)', v.cliente_primeiro_nome);
  ok(v.cliente_email === 'isabela@cliente.com', 'cliente_email', v.cliente_email);
  ok(v.cliente_telefone === '11988887777', 'cliente_telefone', v.cliente_telefone);
  ok(v.cliente_documento === '11144477735', 'cliente_documento', v.cliente_documento);
  ok(v.cliente_cidade === 'São Paulo' && v.cliente_estado === 'SP', 'cliente_cidade e cliente_estado',
     v.cliente_cidade + '/' + v.cliente_estado);
  ok(v.cliente_desde === '2026-09-07', 'cliente_desde', v.cliente_desde);
  ok(v.loja_nome === 'Loja do Kaio', 'loja_nome', v.loja_nome);
  ok(v.evento_nuvemshop === 'customer/created', 'evento_nuvemshop');
  // As duas antigas continuam, para não quebrar automação já montada.
  ok(v.cliente_total_gasto !== undefined && v.cliente_pedidos !== undefined,
     'e as duas variáveis antigas continuam existindo');

  console.log('\n=== 3. Cadastro sem telefone nenhum: diz POR QUE não criou ===');
  // Aqui não dá para criar contato: sem número não existe conversa de
  // WhatsApp. O que não pode é ficar mudo, que era o comportamento antigo.
  respostaDaApi = { id: 502, name: 'Sem Telefone', email: 'sem@cliente.com', phone: null, addresses: [] };
  const r2 = await nuvem.handleEvent(acc, 'customer/created', 502, null);
  ok(!r2.contact, 'não cria contato (sem número não há WhatsApp)');
  ok(r2.vars.cliente_nome === 'Sem Telefone' && r2.vars.cliente_email === 'sem@cliente.com',
     'mas as variáveis vêm preenchidas mesmo assim — a automação pode mandar e-mail');
  const log = db.get().webhookLog[0] || {};
  ok(log.motivo === 'o cadastro na loja veio sem telefone',
     'e o log diz o motivo, em vez de só "matched: false"', log.motivo);
  ok(log.cliente === 'Sem Telefone', 'com o nome de quem se cadastrou, para achar o caso');
  // Sem isto, "não veio o telefone" vira palpite: não dá para saber se a
  // Nuvemshop mandou o número num campo que não lemos, ou se não mandou nada.
  ok(Array.isArray(log.campos) && log.campos.length >= 8,
     'e a lista de ONDE foi procurado, campo por campo', (log.campos || []).length + ' campos');
  ok((log.campos || []).every(c => /=(preenchido|vazio)$/.test(c)),
     'dizendo só se estava preenchido — o número não vai para o log');
  ok((log.campos || []).includes('default_address.phone=vazio'),
     'incluindo o endereço, que é onde ele costuma estar');

  console.log('\n=== 4. No pedido, os dados do cliente vêm junto ===');
  // A mensagem do pedido quase sempre começa cumprimentando pelo nome.
  respostaDaApi = {
    id: 900, number: 1234, total: '199.90', currency: 'BRL', status: 'open',
    products: [{ quantity: 2, name: 'Camiseta' }],
    contact_name: 'João Silva', contact_email: 'joao@cliente.com',
    customer: { id: 7, name: 'João Silva', email: 'joao@cliente.com',
                default_address: { phone: '11955554444', city: 'Rio de Janeiro', province: 'RJ' } }
  };
  const r3 = await nuvem.handleEvent(acc, 'order/paid', 900, null);
  ok(r3.telefone === '11955554444', 'o telefone do pedido sai do endereço do cliente', r3.telefone);
  ok(r3.vars.pedido_numero === '1234', 'as variáveis do pedido continuam lá', r3.vars.pedido_numero);
  ok(r3.vars.cliente_primeiro_nome === 'João', 'e as do cliente entram junto', r3.vars.cliente_primeiro_nome);
  ok(!!r3.contact, 'e o contato é criado');

  console.log('\n=== 5. Pedido com o cliente pela metade: o Koonfy completa ===');
  // A Nuvemshop as vezes embute o cliente inteiro no pedido e as vezes manda
  // so um esqueleto. Sem completar, a automacao que usa cliente_documento
  // funcionaria num pedido e falharia no seguinte, sem explicacao.
  const chamadas = [];
  respostaDaApi = null;
  global.fetch = async (url) => {
    chamadas.push(String(url));
    const corpo = /\/customers\/7\b/.test(String(url))
      ? { id: 7, name: 'João Silva', email: 'joao@cliente.com', identification: '52998224725',
          default_address: { phone: '11955554444', city: 'Rio de Janeiro', province: 'RJ' } }
      : { id: 901, number: 1235, total: '99.00', currency: 'BRL', status: 'open', products: [],
          contact_name: 'João Silva',
          customer: { id: 7, name: 'João Silva' } };   // esqueleto de propósito
    return { ok: true, status: 200, text: async () => JSON.stringify(corpo), json: async () => corpo };
  };
  const r4 = await nuvem.handleEvent(acc, 'order/paid', 901, null);
  ok(chamadas.some(u => /\/customers\/7/.test(u)),
     'o cliente incompleto é buscado na API', chamadas.filter(u => /customers/.test(u)).length + ' chamada(s)');
  ok(r4.vars.cliente_documento === '52998224725', 'e o documento aparece', r4.vars.cliente_documento);
  ok(r4.vars.cliente_cidade === 'Rio de Janeiro', 'e a cidade', r4.vars.cliente_cidade);
  ok(r4.telefone === '11955554444', 'e o telefone, que o pedido não trazia', r4.telefone);
  ok(r4.vars.cliente_id === '7', 'com o id da Nuvemshop, que identifica a pessoa', r4.vars.cliente_id);
  ok(!!r4.contact && r4.contact.ns.clienteId === '7' && r4.contact.ns.documento === '52998224725',
     'e isso fica marcado no contato, para o atendente saber de quem é');

  console.log('\n=== 6. Cliente COMPLETO no pedido: não busca à toa ===');
  chamadas.length = 0;
  global.fetch = async (url) => {
    chamadas.push(String(url));
    const corpo = { id: 902, number: 1236, total: '50.00', currency: 'BRL', products: [],
      customer: { id: 8, name: 'Maria', email: 'maria@c.com', identification: '11144477735',
                  phone: '11977776666' } };
    return { ok: true, status: 200, text: async () => JSON.stringify(corpo), json: async () => corpo };
  };
  const r5 = await nuvem.handleEvent(acc, 'order/paid', 902, null);
  ok(!chamadas.some(u => /\/customers\//.test(u)),
     'nenhuma chamada extra quando o pedido já traz tudo', chamadas.length + ' chamada(s) no total');
  ok(r5.vars.cliente_documento === '11144477735', 'e os dados vêm do próprio pedido');

  console.log('\n=== 7. Carrinho abandonado agora diz DE QUEM é ===');
  const vc = Object.assign({},
    nuvem.customerVars({ id: 12, name: 'Ana Paula', email: 'ana@c.com',
                         default_address: { phone: '11933332222', city: 'Curitiba', province: 'PR' } },
                       'Loja do Kaio'),
    nuvem.cartVars({ id: 55, total: '120.00', currency: 'BRL', products: [{ quantity: 1, name: 'Tênis' }],
                     abandoned_checkout_url: 'https://loja/checkout/55' }));
  ok(vc.cliente_primeiro_nome === 'Ana' && vc.cliente_email === 'ana@c.com',
     'o carrinho carrega nome e e-mail do cliente', vc.cliente_primeiro_nome);
  ok(vc.carrinho_link === 'https://loja/checkout/55', 'sem perder o link de recuperação');
  ok(vc.cliente_cidade === 'Curitiba', 'e a cidade, para a mensagem falar como gente');

  console.log('\n=== 8. Importar a base que já existia na loja ===');
  // Os webhooks so contam o que acontece daqui para frente. Quem conecta hoje
  // tem anos de clientes la dentro e quer falar com eles agora.
  //
  // Um contato que JA existia no CRM, com nome dado pelo atendente e etapa do
  // funil: a importacao nao pode passar por cima disso.
  const jaExistia = require(path.join(R, 'src', 'store'))
    .upsertContact(acc, '11966665555', 'Zé do WhatsApp');
  jaExistia.stage = 'Negociando';
  jaExistia.tags = ['vip'];

  const pagina = [
    { id: 1, name: 'Cliente Um', email: 'um@c.com', identification: '11144477735',
      default_address: { phone: '11911112222', city: 'Santos' } },
    { id: 2, name: 'Cliente Dois', email: 'dois@c.com', phone: '11922223333' },
    { id: 3, name: 'Sem Numero', email: 'tres@c.com' },              // fica de fora
    { id: 4, name: 'Zé Silva', email: 'ze@c.com', phone: '11966665555' }  // já existe
  ];
  let servidas = 0;
  global.fetch = async () => {
    const corpo = servidas++ === 0 ? pagina : [];   // uma página só
    return { ok: true, status: 200, text: async () => JSON.stringify(corpo), json: async () => corpo };
  };
  const imp = await nuvem.importarClientes(acc);
  ok(imp.criados === 2, 'cria os que tinham telefone', imp.criados + ' criado(s)');
  ok(imp.atualizados === 1, 'e completa quem já existia', imp.atualizados + ' atualizado(s)');
  ok(imp.semTelefone === 1, 'contando à parte quem não tem número', imp.semTelefone + ' sem telefone');
  const doEndereco = require(path.join(R, 'src', 'store')).findContact(acc, '11911112222');
  ok(!!doEndereco, 'inclusive quem só tinha o telefone no endereço', doEndereco && doEndereco.name);
  ok(doEndereco && doEndereco.vars.cliente_documento === '11144477735',
     'com as variáveis do cliente guardadas para a automação usar depois');
  ok(doEndereco && doEndereco.ns.clienteId === '1', 'e o id da Nuvemshop no contato');
  // O QUE NÃO PODE ACONTECER: apagar trabalho feito.
  ok(jaExistia.name === 'Zé do WhatsApp', 'NÃO sobrescreve o nome que o atendente deu', jaExistia.name);
  ok(jaExistia.stage === 'Negociando', 'nem a etapa do funil', jaExistia.stage);
  ok(jaExistia.tags.includes('vip'), 'nem as tags que já estavam lá');
  ok(jaExistia.email === 'ze@c.com', 'mas completa o que estava vazio — aqui o e-mail', jaExistia.email);

  console.log('\n=== 9. O limite de contatos do plano é respeitado ===');
  // Sem isto, a importação era o buraco por onde o plano inteiro vazava: quem
  // tem direito a N contatos traria a loja inteira de uma vez, e a mesma trava
  // que existe no cadastro manual e na exportação não valeria aqui.
  const data2 = db.get();
  data2.accounts.length = 0;
  const lojista = db.newAccount({ name: 'Plano Pequeno', email: 'peq@teste.local', pass: '123456' });
  data2.accounts.push(lojista);
  data2.plans.length = 0;
  data2.plans.push({ id: 'basico', name: 'Básico', price: 9700, periodDays: 30,
                     limits: { contacts: 3 }, modules: {} });
  lojista.billing = Object.assign({}, lojista.billing, { planId: 'basico', status: 'active',
                                                          periodEnd: Date.now() + 86400000 });
  const c2 = nuvem.cfg(lojista);
  c2.storeId = '99'; c2.accessToken = 'tok'; c2.storeName = 'Loja Grande'; c2.autoContact = true;

  // A loja tem 5 clientes com telefone; o plano permite 3.
  const grande = [1, 2, 3, 4, 5].map(i => ({
    id: i, name: 'Cliente ' + i, email: 'c' + i + '@loja.com', phone: '1190000000' + i
  }));
  global.fetch = async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify(grande), json: async () => grande });
  const lim = await nuvem.importarClientes(lojista);
  ok(lim.criados === 3, 'importa até o teto do plano, e não mais', lim.criados + ' de 5');
  ok((lojista.contacts || []).length === 3, 'a conta fica exatamente no limite',
     lojista.contacts.length + ' contato(s)');
  ok(lim.naoCoube === 2, 'e conta quantos não couberam', lim.naoCoube + ' fora');
  ok(lim.limiteAtingido === true, 'marcando que foi o LIMITE que barrou, e não o fim da base');
  ok(lim.limite === 3, 'devolvendo o teto do plano, para a tela poder dizer o número', lim.limite);

  console.log('\n=== 9b. Quem já está no CRM continua sendo completado ===');
  // Ele não ocupa vaga nova. Deixá-lo desatualizado seria punir o cliente por
  // um limite que ele não estourou.
  const um = require(path.join(R, 'src', 'store')).findContact(lojista, '11900000001');
  ok(!!um && um.email === 'c1@loja.com', 'o contato importado tem os dados', um && um.email);
  const antesDeNovo = lojista.contacts.length;
  const lim2 = await nuvem.importarClientes(lojista);
  ok(lojista.contacts.length === antesDeNovo, 'importar de novo não cria duplicados',
     lojista.contacts.length + ' contato(s)');
  ok(lim2.atualizados === 3, 'e os que já existem são completados de novo', lim2.atualizados);

  console.log('\n=== 9c. Plano ilimitado não é barrado ===');
  data2.plans[0].limits.contacts = -1;
  const lojista2 = db.newAccount({ name: 'Ilimitado', email: 'ilim@teste.local', pass: '123456' });
  lojista2.billing = Object.assign({}, lojista2.billing, { planId: 'basico', status: 'active',
                                                            periodEnd: Date.now() + 86400000 });
  data2.accounts.push(lojista2);
  const c3 = nuvem.cfg(lojista2);
  c3.storeId = '99'; c3.accessToken = 'tok'; c3.autoContact = true;
  const ilim = await nuvem.importarClientes(lojista2);
  ok(ilim.criados === 5, 'traz todo mundo', ilim.criados + ' de 5');
  ok(ilim.limiteAtingido === false, 'e não oferece upgrade a quem já tem ilimitado');

  // devolve o banco: `db.save()` é adiado em 250ms e um save atrasado
  // desfaria a restauração do arquivo.
  const antes = JSON.parse(original || '{}');
  for (const k of ['accounts', 'revenue', 'plans']) {
    if (Array.isArray(data[k])) data[k].length = 0;
    if (Array.isArray(antes[k])) data[k].push(...antes[k]);
  }
  db.save();
  devolver();
  await encerrar(null, falhas);
})();
