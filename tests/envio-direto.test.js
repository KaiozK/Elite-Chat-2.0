// ============================================================================
// ENVIO DIRETO (Direct Send) — mensagem da empresa SEM modelo aprovado
//
// A parte mais cara do WhatsApp oficial nunca foi mandar a mensagem: foi ter
// de criar um MODELO, escrever o texto com as variáveis, mandar para a Meta e
// esperar a aprovação — para só então poder falar com quem está fora da janela
// de 24h. Cada texto novo é um modelo novo, e cada modelo é uma espera.
//
// O envio direto tira isso do caminho para duas categorias: `utility` (aviso
// de pedido, entrega, agendamento) e `authentication` (código de acesso, ainda
// em Beta na Meta). O cliente escreve o texto e manda; a Meta gera o modelo
// correspondente por baixo, sozinha.
//
// A mudança técnica é minúscula e é justamente por isso que precisa de teste:
// é a MESMA rota da Meta, `/{phone_number_id}/messages`, com UM campo a mais
// no corpo — `category`. Um campo que não vai, ou vai com o nome errado, faz a
// mensagem sair como texto livre comum: recusada fora da janela, e ninguém
// entende por quê.
//
// Ref.: developers.facebook.com/documentation/business-messaging/whatsapp/direct-send
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

// Intercepta a chamada à Meta ANTES de o módulo ser carregado, para ver o
// corpo exato que sairia — sem falar com a Meta de verdade.
const enviados = [];
const origFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  if (String(url).includes('graph.facebook.com')) {
    enviados.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
    return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.TESTE' }] }), text: async () => '' };
  }
  return origFetch(url, opts);
};

const wa = require(R + 'src/whatsapp');
const metaerros = require(R + 'src/metaerros');

const conta = { id: 'acc_x', name: 'Loja', wa: { phoneNumberId: 'PHONE_1', accessToken: 'TOKEN' } };

(async () => {
  console.log('=== 1. O corpo que sai é o da documentação ===');
  enviados.length = 0;
  await wa.sendDirectText(conta, '5511999998888', 'Seu pedido #123 saiu para entrega.');
  const env = enviados[0];
  ok(!!env, 'a chamada saiu');
  ok(env && /\/PHONE_1\/messages$/.test(env.url.split('?')[0]),
     'para a MESMA rota de sempre, /{phone_number_id}/messages',
     env && env.url.split('/').slice(-2).join('/'));
  const b = (env || {}).body || {};
  ok(b.messaging_product === 'whatsapp', 'messaging_product: whatsapp');
  ok(b.recipient_type === 'individual', 'recipient_type: individual');
  ok(b.to === '5511999998888', 'to: o telefone do cliente', b.to);
  ok(b.type === 'text', 'type: text');
  ok(b.text && b.text.body === 'Seu pedido #123 saiu para entrega.', 'text.body: o texto escrito');
  ok(b.category === 'utility', 'category: utility — é ESTE campo que liga o envio direto', b.category);
  ok(!b.template, 'e NENHUM modelo vai junto: é esse o ponto do recurso');

  console.log('\n=== 2. Autenticação é a outra categoria ===');
  enviados.length = 0;
  await wa.sendDirectText(conta, '5511999998888', 'Seu código é 123456', 'authentication');
  ok(enviados[0] && enviados[0].body.category === 'authentication',
     'category: authentication (Beta na Meta)', enviados[0] && enviados[0].body.category);

  console.log('\n=== 3. Categoria inventada é recusada AQUI, não na Meta ===');
  // Mandar uma categoria que não existe gastaria uma ida à Meta para receber
  // um erro genérico. Barrar antes é mais rápido e explica melhor.
  let erro = null;
  try { await wa.sendDirect(conta, '5511999998888', 'marketing', { type: 'text', text: { body: 'oi' } }); }
  catch (e) { erro = e; }
  ok(erro && erro.status === 400, 'recusa antes de chamar a Meta', erro && ('HTTP ' + erro.status));
  ok(erro && /utility.*authentication/i.test(erro.message), 'dizendo quais valem', erro && erro.message);
  ok(wa.CATEGORIAS_DIRETAS.length === 2, 'e a lista tem só as duas que a Meta aceita',
     wa.CATEGORIAS_DIRETAS.join(', '));

  console.log('\n=== 4. Conta NÃO qualificada: o cliente entende o que houve ===');
  // A Meta responde "(#100) Invalid parameter" e esconde o motivo em
  // `error_data.details`. Sem tradução, o cliente lia "parâmetro inválido" e
  // não tinha como saber que o problema é a conta não estar liberada — nem que
  // existe saída pelo modelo aprovado de sempre.
  const recusa = {
    message: '(#100) Invalid parameter', type: 'OAuthException', code: 100,
    error_data: {
      messaging_product: 'whatsapp',
      details: "Parameter Invalid: The 'category' value requires Direct Send, which isn't enabled for this account. Use an approved message template instead."
    },
    fbtrace_id: 'ABC'
  };
  const pt = metaerros.mensagem(recusa);
  ok(pt !== recusa.message, 'a frase da Meta não chega crua na tela');
  ok(/envio direto/i.test(pt), 'a tradução nomeia o recurso', pt.slice(0, 48) + '…');
  ok(/Gerenciador do WhatsApp/i.test(pt), 'diz ONDE conferir se a conta se qualifica');
  ok(/MODELO APROVADO/i.test(pt), 'e dá a saída de hoje, em vez de deixar sem caminho');

  console.log('\n=== 5. O motivo mora em error_data.details, e agora é lido ===');
  // Era o furo: `traduzir` só olhava `message`. Com um `message` genérico, o
  // caso escapava da tradução inteira.
  const fonte = fs.readFileSync(R + 'src/metaerros.js', 'utf8');
  ok(/e\.error_data && e\.error_data\.details/.test(fonte),
     'traduzir lê error_data.details além de message');
  ok(/if \(cod === 100\)/.test(fonte),
     'e no código 100, genérico demais, o TRECHO decide antes do código');

  console.log('\n=== 6. A rota do painel existe e mantém as trancas ===');
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  const i = api.indexOf("router.post('/send/direct'");
  ok(i > 0, 'POST /send/direct existe');
  const linha = api.slice(i, api.indexOf('\n', i));
  ok(!/requireWindow/.test(linha),
     'sem a janela — mensagem iniciada pela empresa, como o modelo');
  for (const [g, oque] of [['requireConsent', 'opt-out'], ['requireActive', 'assinatura em dia'],
                           ["can('inbox'", 'permissão do atendente']]) {
    ok(linha.includes(g), `com ${oque}`);
  }
  const corpo = api.slice(i, i + 1200);
  ok(/CATEGORIAS_DIRETAS\.includes\(cat\)/.test(corpo), 'e a rota valida a categoria antes de enviar');
  ok(/category \|\| 'utility'/.test(corpo), 'com utility como padrão, que é o caso comum');

  global.fetch = origFetch;
  await encerrar(null, falhas);
})();
