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

  await encerrar(null, falhas);
})();
