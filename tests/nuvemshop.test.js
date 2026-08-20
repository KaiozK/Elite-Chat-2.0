// NUVEMSHOP — automação por evento, carrinho abandonado e base segmentada.
//
// A integração assinava quatro eventos e disparava TODAS as automações ligadas
// à loja em qualquer um deles: quem quisesse avisar do envio mandava a mesma
// mensagem no pedido criado, no pago e no cancelado. Sem filtro por evento não
// se escreve automação útil, e mensagem errada na hora errada custa cliente.
//
// O que este teste segura:
//   · cada automação roda SÓ no evento que escolheu;
//   · o formato antigo (gatilho webhook, sem evento) continua recebendo tudo —
//     são fluxos que alguém montou antes de existir escolha;
//   · as variáveis do pedido chegam formatadas (R$ 1.234,50, não 1234.5) e
//     trazem o rastreio, que é o "cadê meu pedido";
//   · o carrinho abandonado sai por VARREDURA, respeita o tempo de espera e
//     avisa cada carrinho UMA vez;
//   · o disparo segmentado alcança quem veio da loja, inclusive o contato que
//     já existia antes de comprar.
const Module = require('module');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

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

// A LOJA É DE MENTIRA. Nenhuma chamada sai para a internet: `fetch` responde
// com o que este teste manda, e guarda o que foi pedido.
const chamadas = [];
let respostas = {};
const fetchReal = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  chamadas.push({ url: u, metodo: opts.method || 'GET' });
  for (const [rota, corpo] of Object.entries(respostas)) {
    if (u.includes(rota)) {
      return { ok: true, status: 200, text: async () => JSON.stringify(corpo), json: async () => corpo };
    }
  }
  return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
};

(async () => {
  const db = require(R + 'src/db');
  await db.loadAsync();
  const nuvem = require(R + 'src/nuvemshop');
  const store = require(R + 'src/store');

  const acc = db.newAccount({ name: 'Loja de Teste', email: 'loja@teste.com', pass: 'segredo123' });
  db.get().accounts.push(acc);
  const c = nuvem.cfg(acc);
  c.accessToken = 'TOKEN_FALSO';
  c.storeId = '999';
  c.storeName = 'Minha Loja';
  db.save();

  // As mensagens que sairiam pelo WhatsApp são capturadas aqui.
  const enviadas = [];
  const deliver = (conta, to, msg) => { enviadas.push({ to, msg }); };

  const fluxo = (id, trigger) => ({
    id, name: id, enabled: true, trigger,
    nodes: [{ id: 'n1', type: 'text', text: 'Olá {{primeiro_nome}}, pedido {{pedido_numero}} — {{pedido_total}}' }],
    edges: []
  });

  console.log('=== 1. Cada automação roda SÓ no seu evento ===');
  acc.flows = [
    fluxo('pago', { type: 'nuvemshop', nsEvent: 'order/paid' }),
    fluxo('enviado', { type: 'nuvemshop', nsEvent: 'order/fulfilled' }),
    fluxo('carrinho', { type: 'nuvemshop', nsEvent: 'cart/abandoned' })
  ];
  const doPago = nuvem.fluxosDoEvento(acc, 'order/paid').map(f => f.id);
  const doEnviado = nuvem.fluxosDoEvento(acc, 'order/fulfilled').map(f => f.id);
  ok(doPago.length === 1 && doPago[0] === 'pago', 'compra aprovada aciona só o fluxo dela: ' + doPago.join());
  ok(doEnviado.length === 1 && doEnviado[0] === 'enviado', 'pedido enviado idem: ' + doEnviado.join());
  ok(nuvem.fluxosDoEvento(acc, 'order/cancelled').length === 0, 'e um evento sem automação não aciona nada');

  console.log('\n=== 2. O formato ANTIGO continua recebendo tudo ===');
  // Fluxos montados antes de existir escolha de evento. Desligá-los por causa
  // da mudança seria quebrar o que está no ar.
  acc.flows.push(fluxo('legado', { type: 'webhook', source: 'nuvemshop' }));
  ok(nuvem.fluxosDoEvento(acc, 'order/paid').some(f => f.id === 'legado'), 'o legado entra no pedido pago');
  ok(nuvem.fluxosDoEvento(acc, 'order/cancelled').some(f => f.id === 'legado'), 'e também no cancelado');

  console.log('\n=== 3. As variáveis chegam prontas para a mensagem ===');
  const v = nuvem.orderVars({
    number: 1042, total: '1234.50', currency: 'BRL', subtotal: '1200.00',
    shipping_cost_customer: '34.50', payment_status: 'paid', shipping_status: 'fulfilled',
    products: [{ name: 'Tênis', quantity: 2 }, { name: 'Meia', quantity: 3 }],
    shipping_tracking_number: 'BR123456789BR',
    shipping_tracking_url: 'https://rastreio.exemplo/BR123456789BR',
    coupon: [{ code: 'VOLTA10' }]
  });
  ok(v.pedido_total === 'R$ 1.234,50', 'dinheiro em português: ' + v.pedido_total);
  ok(v.pedido_frete === 'R$ 34,50', 'o frete também: ' + v.pedido_frete);
  ok(v.pedido_numero === '1042', 'o número do pedido: ' + v.pedido_numero);
  ok(v.pedido_qtd === '5', 'a quantidade soma os itens: ' + v.pedido_qtd);
  ok(v.pedido_rastreio === 'BR123456789BR', 'o rastreio, que é o "cadê meu pedido": ' + v.pedido_rastreio);
  ok(v.pedido_cupom === 'VOLTA10', 'e o cupom usado: ' + v.pedido_cupom);
  ok(nuvem.primeiroNome('Maria Aparecida da Silva') === 'Maria', 'a saudação usa o primeiro nome');

  console.log('\n=== 4. CARRINHO ABANDONADO: só depois do tempo de espera ===');
  // A Nuvemshop não tem webhook de carrinho: a varredura é o único caminho.
  const agora = Date.now();
  const carrinho = (id, minutosAtras, tel) => ({
    id, contact_name: 'Ana Souza', contact_phone: tel === undefined ? '11988887777' : tel,
    contact_email: 'ana@ex.com', total: '250.00', currency: 'BRL',
    products: [{ name: 'Camiseta', quantity: 1 }],
    abandoned_checkout_url: 'https://loja.com/checkout/' + id,
    created_at: new Date(agora - minutosAtras * 60000).toISOString(),
    updated_at: new Date(agora - minutosAtras * 60000).toISOString()
  });

  c.carrinho = { ligado: true, minutos: 60 };
  c.carrinhosVistos = [];
  respostas = { '/checkouts': [carrinho(1, 10), carrinho(2, 90)] };

  let r = await nuvem.varrerCarrinhos(acc, deliver, null);
  ok(r.avisados === 1, `só o carrinho parado há 90 min entrou: ${r.avisados}`);
  // O envio em si depende de um WhatsApp conectado, que este teste não tem —
  // o que se mede aqui é o ROTEAMENTO: rodou o fluxo do carrinho, e só ele.
  const doCarrinho = acc.flows.find(f => f.id === 'carrinho');
  const doPagoFlow = acc.flows.find(f => f.id === 'pago');
  ok(doCarrinho.runs === 1, 'o fluxo do carrinho rodou: ' + (doCarrinho.runs || 0));
  ok(!doPagoFlow.runs, 'e o de compra aprovada não: ' + (doPagoFlow.runs || 0));
  ok((c.carrinhosVistos || []).map(x => x.id).join() === '2', 'o de 10 minutos NÃO foi avisado: quem está pagando ainda não abandonou');

  console.log('\n=== 5. O mesmo carrinho não é avisado duas vezes ===');
  enviadas.length = 0;
  r = await nuvem.varrerCarrinhos(acc, deliver, null);
  ok(r.avisados === 0 && enviadas.length === 0, 'segunda varredura não repete o aviso');

  console.log('\n=== 6. Desligado, não varre ===');
  c.carrinho.ligado = false;
  c.carrinhosVistos = [];
  r = await nuvem.varrerCarrinhos(acc, deliver, null);
  ok(r.avisados === 0, 'com a recuperação desligada nada sai');

  console.log('\n=== 7. Carrinho sem telefone é pulado, não quebra ===');
  c.carrinho.ligado = true;
  c.carrinhosVistos = [];
  enviadas.length = 0;
  respostas = { '/checkouts': [carrinho(3, 90, '')] };
  r = await nuvem.varrerCarrinhos(acc, deliver, null);
  ok(r.avisados === 0 && enviadas.length === 0, 'sem telefone não há para quem mandar');
  ok(!(c.carrinhosVistos || []).some(x => x.id === '3'),
     'e ele NÃO é marcado como visto: se a pessoa voltar e preencher, entra na próxima');

  console.log('\n=== 8. Carrinho velho demais não é recuperação ===');
  c.carrinhosVistos = [];
  respostas = { '/checkouts': [carrinho(4, 5 * 24 * 60)] };
  r = await nuvem.varrerCarrinhos(acc, deliver, null);
  ok(r.avisados === 0, 'cinco dias depois já comprou em outro lugar ou desistiu');

  console.log('\n=== 8b. SEM automação de carrinho, a varredura nem começa ===');
  // O estrago apareceria um dia depois: o lojista liga a recuperação, monta o
  // fluxo na manhã seguinte, e os carrinhos varridos no meio-tempo já estão
  // marcados como avisados — nunca mais entram, e ninguém entende por quê.
  const guardados = acc.flows;
  acc.flows = guardados.filter(f => !(f.trigger.nsEvent === 'cart/abandoned' || f.trigger.source === 'nuvemshop'));
  c.carrinhosVistos = [];
  respostas = { '/checkouts': [carrinho(9, 90)] };
  r = await nuvem.varrerCarrinhos(acc, deliver, null);
  ok(r.motivo === 'sem_automacao', 'a varredura diz por que não fez nada: ' + r.motivo);
  ok((c.carrinhosVistos || []).length === 0, 'e NENHUM carrinho foi marcado como avisado');
  // Com o fluxo de volta, o mesmo carrinho entra normalmente.
  acc.flows = guardados;
  r = await nuvem.varrerCarrinhos(acc, deliver, null);
  ok(r.avisados === 1, 'montada a automação, o carrinho de ontem ainda é recuperável: ' + r.avisados);

  console.log('\n=== 9. O evento da loja marca o contato ===');
  respostas = {
    '/orders/77': {
      id: 77, number: 1042, total: '199.90', currency: 'BRL', payment_status: 'paid',
      contact_name: 'Carlos Lima', contact_phone: '11977776666', contact_email: 'carlos@ex.com',
      products: [{ name: 'Boné', quantity: 1 }]
    }
  };
  const res = await nuvem.handleEvent(acc, 'order/paid', 77, null);
  const contato = acc.contacts.find(x => x.waId === res.telefone);
  ok(!!contato, 'o contato foi criado a partir do pedido');
  ok(contato.ns && contato.ns.storeId === '999', 'com a marca da loja: ' + (contato.ns && contato.ns.storeId));
  ok(contato.ns.pedidos === 1, 'e a contagem de compras: ' + contato.ns.pedidos);

  console.log('\n=== 10. Quem já existia ANTES de comprar também é marcado ===');
  // É o caso que mais importa no disparo segmentado: o cliente que veio pelo
  // WhatsApp meses atrás e só agora comprou. Sem a marca, ele fica de fora.
  const antigo = store.upsertContact(acc, '11955554444', 'Beatriz Antiga');
  ok(!antigo.ns, 'o contato antigo não tinha marca de loja');
  respostas = {
    '/orders/88': {
      id: 88, number: 1043, total: '89.90', currency: 'BRL', payment_status: 'paid',
      contact_name: 'Beatriz Antiga', contact_phone: '11955554444', contact_email: 'bia@ex.com',
      products: [{ name: 'Caneca', quantity: 1 }]
    }
  };
  await nuvem.handleEvent(acc, 'order/paid', 88, null);
  const bia = acc.contacts.find(x => x.waId === '5511955554444' || x.waId === '11955554444');
  ok(!!bia && !!bia.ns && bia.ns.storeId === '999', 'agora ele carrega a marca da loja');
  ok(bia.ns.pedidos === 1, 'e entra nos compradores: ' + bia.ns.pedidos);

  console.log('\n=== 11. Os gatilhos oferecidos incluem o que faltava ===');
  const nomes = nuvem.GATILHOS.map(g => g.event);
  for (const esperado of ['order/paid', 'order/fulfilled', 'cart/abandoned', 'order/pending', 'order/cancelled']) {
    ok(nomes.includes(esperado), 'existe gatilho para ' + esperado);
  }
  ok(!nuvem.EVENTS.some(e => e.event === 'cart/abandoned'),
     'e o carrinho NÃO entra nos webhooks assinados: a Nuvemshop não publica esse evento');

  global.fetch = fetchReal;
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exitCode = falhas ? 1 : 0;
  setTimeout(() => process.exit(falhas ? 1 : 0), 300).unref();
})().catch(e => { console.error(e); process.exit(1); });
