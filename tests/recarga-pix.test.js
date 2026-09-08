// ============================================================================
// A RECARGA DA CARTEIRA É PIX, E SÓ
//
// Recarregar carteira no cartão é pagar taxa de adquirente para pôr dinheiro
// num saldo que depois paga a própria plataforma: o cliente paga duas vezes
// pelo mesmo dinheiro, e o Pix cai em segundos do mesmo jeito.
//
// O que muda conforme o adquirente ATIVO é só a recorrência:
//
//   · WOOVI    → além do Pix avulso, existe o PIX AUTOMÁTICO, autorizado uma
//                vez no banco. É ele que faz a "recarga automática" existir.
//   · SIMPLIFY → Pix avulso apenas. Não há recorrência, e a recarga automática
//                nem aparece na tela — antes ela aparecia e só falhava na hora
//                de salvar, o que faz a pessoa achar que errou alguma coisa.
// ============================================================================
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(R, 'public', 'app', 'app.js'), 'utf8');
const api = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
const topup = fs.readFileSync(path.join(R, 'src', 'topup.js'), 'utf8');

(async () => {
  console.log('=== 1. A tela de depósito oferece só Pix ===');
  const modal = app.slice(app.indexOf('function depositModal'), app.indexOf('function depSet'));
  ok(/ico\('pix', 17\)/.test(modal), 'com o ícone do Pix que o projeto já tinha');
  ok(!/name="depm"/.test(modal), 'sem seletor de meio — não há o que escolher');
  ok(!/value="card"/.test(modal), 'e sem a opção de cartão');
  ok(/ico\('pix', 14\)\} Gerar Pix/.test(modal), 'o botão diz exatamente o que vai acontecer');

  console.log('\n=== 2. Nenhum SVG novo foi criado ===');
  // O ícone do Pix já existia no conjunto de ícones do painel.
  ok(/^\s*pix: '<g fill="currentColor"/m.test(app), 'o ícone do Pix vem do conjunto que já existia');
  const usos = (app.match(/ico\('pix'/g) || []).length;
  ok(usos >= 10, `e é usado por referência, ${usos} vezes, sem desenhar de novo`);

  console.log('\n=== 3. O depósito não desvia mais para o cartão ===');
  const dep = app.slice(app.indexOf('async function doDeposit'), app.indexOf('async function doDeposit') + 1200);
  ok(!/openCardPay\('topup'/.test(dep), 'a função de depósito não abre o formulário de cartão');
  ok(/api\('\/billing\/topup'/.test(dep), 'ela gera o Pix e mostra o QR na própria janela');

  console.log('\n=== 4. Recarga automática só existe com o Pix Automático ===');
  ok(/pixAutomatico: require\('\.\/assinaturas'\)\.disponivel\(\)/.test(api),
     'o servidor diz à tela se a recorrência existe no adquirente ativo');
  const box = app.slice(app.indexOf('function autoBoxHtml'), app.indexOf('function autoToggle'));
  ok(/if \(!WALLET\.pixAutomatico\) return '';/.test(box),
     'e com a Simplify ativa a caixa nem é desenhada');
  ok(!/name="autom"/.test(box), 'dentro dela não há escolha de meio');
  ok(!/value="card"/.test(box), 'nem a opção de cartão');
  ok(/Pix Automático/.test(box), 'só o Pix Automático, dito pelo nome');

  console.log('\n=== 5. A porta do servidor também fecha ===');
  // A tela não oferecer não basta: um pedido montado à mão passaria.
  ok(/const metodo = 'pix';/.test(topup),
     'a configuração da recarga automática só aceita Pix');
  ok(!/cfg\.method === 'card' \? 'card' : 'pix'/.test(topup),
     'e não lê mais o meio que veio do cliente');
  ok(/method: 'pix',\s+\/\/ é o único meio de recarga que existe/.test(app),
     'a tela manda `pix` fixo, sem depender de um rádio que não existe mais');

  console.log('\n=== 6. Quem já tinha recarga no cartão não é derrubado ===');
  // Derrubar em silêncio uma cobrança que a pessoa autorizou é pior do que
  // mantê-la funcionando até ela trocar ou desligar.
  ok(/a\.method !== 'card'\) return false;/.test(topup),
     'a cobrança no cartão já configurada continua sendo honrada');

  await encerrar(null, falhas);
})();
