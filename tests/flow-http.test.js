// ============================================================================
// A ETAPA "REQUISIÇÃO HTTP" DO FLOW BUILDER
//
// É por ela que os dados do cliente saem do Koonfy para o sistema de fora — o
// ERP, a planilha, o webhook de quem quiser. Dois problemas moravam aqui:
//
//   · O VALOR ERA COLADO CRU DENTRO DE UM JSON. Num texto de WhatsApp isso
//     está certo. Num corpo JSON, um cliente chamado  João "Jão" Silva  vira
//     {"nome":"João "Jão" Silva"} — JSON inválido. Quem recebe devolve 400, o
//     fluxo segue como se nada fosse, e o defeito só aparece com os clientes
//     que têm aspas, quebra de linha ou barra no endereço. Funciona no teste e
//     falha na vida real, que é a pior combinação.
//   · PARA MANDAR OS DADOS DO CLIENTE ERA PRECISO DIGITAR O JSON INTEIRO,
//     campo por campo — e voltar aqui toda vez que uma variável nova
//     aparecesse. Ninguém volta.
// ============================================================================
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');

const path = require('path');
const R = path.join(__dirname, '..');
const flows = require(path.join(R, 'src', 'flows'));

// O contexto como a Nuvemshop entrega, com um nome que quebra JSON de propósito.
const ctx = {
  contactName: 'João "Jão" Silva',
  to: '5511988887777',
  text: '',
  vars: {
    cliente_id: '7',
    cliente_nome: 'João "Jão" Silva',
    cliente_primeiro_nome: 'João',
    cliente_email: 'joao@cliente.com',
    cliente_documento: '52998224725',
    cliente_cidade: 'São Paulo',
    pedido_numero: '1234',
    pedido_total: 'R$ 199,90',
    pedido_itens: '2x Camiseta "Edição Limitada"',
    evento_nuvemshop: 'order/paid'
  }
};

(async () => {
  console.log('=== 1. O corpo JSON não quebra com o nome do cliente ===');
  const corpo = '{"nome":"{{cliente_nome}}","itens":"{{pedido_itens}}","doc":"{{cliente_documento}}"}';
  const cru = flows.interpolate(corpo, ctx);
  const seguro = flows.interpolateJson(corpo, ctx);
  // O comportamento ANTIGO, para o teste mostrar o que se ganhou.
  let quebrou = false;
  try { JSON.parse(cru); } catch { quebrou = true; }
  ok(quebrou, 'colando o valor cru, o JSON QUEBRA (era o defeito)');
  let obj = null, erro = '';
  try { obj = JSON.parse(seguro); } catch (e) { erro = e.message; }
  ok(!!obj, 'escapado, o JSON é válido', erro || 'parse ok');
  ok(obj && obj.nome === 'João "Jão" Silva', 'e o nome chega inteiro, com as aspas', obj && obj.nome);
  ok(obj && obj.itens === '2x Camiseta "Edição Limitada"', 'o mesmo para os itens do pedido');
  ok(obj && obj.doc === '52998224725', 'e o documento');

  console.log('\n=== 2. Quebra de linha e barra também passam ===');
  // Endereço com quebra de linha é comum, e \n cru dentro de JSON é inválido.
  const ctx2 = { contactName: '', to: '', text: '', vars: { obs: 'Rua A, 10\nFundos \\ Bloco B' } };
  let o2 = null;
  try { o2 = JSON.parse(flows.interpolateJson('{"obs":"{{obs}}"}', ctx2)); } catch {}
  ok(!!o2 && o2.obs === 'Rua A, 10\nFundos \\ Bloco B', 'quebra de linha e barra invertida sobrevivem');

  console.log('\n=== 3. Variável que não existe fica como está ===');
  // Some-la silenciosamente esconderia o erro de digitação de quem montou o
  // fluxo; deixar o {{...}} visível no destino mostra onde está o engano.
  const o3 = flows.interpolateJson('{"x":"{{nao_existe}}"}', ctx);
  ok(o3.includes('{{nao_existe}}'), 'o marcador continua visível, para o engano aparecer');

  console.log('\n=== 4. "Enviar todos os dados" manda tudo sem digitar nada ===');
  const tudo = flows.dadosDoFluxo(ctx);
  ok(tudo.cliente_nome === 'João "Jão" Silva' && tudo.pedido_numero === '1234',
     'o objeto carrega as variáveis do evento');
  ok(tudo.nome === 'João "Jão" Silva' && tudo.telefone === '5511988887777',
     'mais o nome e o telefone do contato');
  let o4 = null;
  try { o4 = JSON.parse(JSON.stringify(tudo)); } catch {}
  ok(!!o4 && o4.cliente_documento === '52998224725',
     'e vira JSON válido direto, sem ninguém escrever o corpo');
  ok(Object.keys(tudo).length >= 12, 'com tudo o que o fluxo sabe', Object.keys(tudo).length + ' campos');

  console.log('\n=== 5. O texto do WhatsApp continua sem escape ===');
  // Aqui escapar seria o erro oposto: a mensagem sairia com barras invertidas.
  const msg = flows.interpolate('Olá {{cliente_primeiro_nome}}, seu pedido {{pedido_numero}} saiu!', ctx);
  ok(msg === 'Olá João, seu pedido 1234 saiu!', 'a mensagem sai limpa', msg);

  await encerrar(null, falhas);
})();
