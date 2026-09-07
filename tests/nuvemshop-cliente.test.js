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
