// ============================================================================
// CONECTAR AQUI DESCONECTA LÁ — como o WhatsApp funciona
//
// O mesmo WhatsApp servindo duas contas não dá erro em lugar nenhum e quebra
// de um jeito que ninguém liga aos pontos: a mensagem recebida entra só na
// primeira da lista, a segunda envia e nunca recebe, e a janela de 24h não
// abre nela. Parece banco perdendo mensagem, e é roteamento. Duas contas com o
// mesmo número é um estado que não pode existir.
//
// A primeira tentativa de impedir isso foi RECUSAR a conexão: "desconecte-o lá
// antes de conectar aqui". Errado, e o erro só aparece em uso real — a frase
// supõe que a pessoa ALCANÇA a outra conta. Quando a outra é um cadastro
// antigo ou um teste esquecido, o dono fica sem o próprio número depois de já
// ter passado por toda a autorização na Meta, com os quatro primeiros passos
// verdes na tela.
//
// Agora funciona como o WhatsApp: registrar o número aqui derruba o registro
// anterior, sozinho. A AUTORIZAÇÃO NA META É A PROVA DE POSSE — não se conclui
// o Embedded Signup de um número que não se controla, do mesmo jeito que não
// se recebe o SMS de verificação de um chip que não se tem.
//
// O que não pode é ser silencioso: a conta que perde o número precisa saber
// por que parou de receber, senão volta o mesmo sumiço sem explicação que a
// regra existe para evitar.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  // SEM OS COMENTÁRIOS. O comentário que EXPLICA a frase antiga cita a frase
  // antiga — e um teste que procura texto acharia a explicação achando que
  // achou o código.
  const codigo = api.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const i = api.indexOf('const jaTem = db.accountsByPhoneId(phone.id)');
  const bloco = api.slice(i, i + 3200);

  console.log('=== 1. Não recusa mais — conecta e resolve ===');
  ok(i > 0, 'a conexão continua conferindo se o número está em outra conta');
  ok(!/status = 409/.test(bloco), 'e NÃO recusa mais com 409');
  ok(!/Desconecte-o lá antes/.test(codigo), 'a frase que trancava o dono saiu do código');

  console.log('\n=== 2. Desconecta de VERDADE do outro lado ===');
  // Sem limpar o phoneNumberId lá, as duas contas continuariam achando que têm
  // o número — que é exatamente o estado que a regra existe para evitar.
  ok(/ch\.wa\.connected = false;/.test(bloco), 'a outra conta fica desconectada');
  ok(/ch\.wa\.phoneNumberId = '';/.test(bloco), 'e o id do número é limpo lá');
  ok(/for \(const outra of jaTem\)/.test(bloco),
     'em TODAS as outras, não só na primeira — o estado ruim pode estar em várias');

  console.log('\n=== 3. Quem PERDEU o número fica sabendo ===');
  ok(/agents\.log\(outra/.test(bloco), 'entra no histórico da conta que perdeu');
  ok(/type: 'numero_movido'/.test(bloco), 'e no log de eventos');
  ok(/As conversas antigas continuam guardadas aqui/.test(bloco),
     'dizendo também o que NÃO se perdeu — senão a pessoa teme ter perdido tudo');
  ok(/broadcast\('wa', \{ accountId: outra\.id \}\)/.test(bloco),
     'e a tela dela é avisada na hora, sem esperar recarregar');

  console.log('\n=== 4. Quem conectou também vê o que aconteceu ===');
  // Mudar o que OUTRA conta faz e não mostrar seria a mesma surpresa de antes,
  // só que do outro lado.
  ok(/agents\.log\(acc, req\.who, 'wa_connect'/.test(bloco), 'fica no histórico de quem conectou');
  ok(/step\('liberado', true/.test(bloco), 'e aparece como um passo na tela de conexão');

  console.log('\n=== 5. O passo só aparece quando existe conta anterior ===');
  // Listar um passo que não vai acontecer faz a pessoa esperar por algo que
  // nunca vem.
  const front = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(/\['liberado', 'Liberar o número da conta anterior'\]/.test(front),
     'o passo existe na lista da tela');
  ok(/k === 'liberado' \? ' hidden' : ''/.test(front), 'e nasce escondido');
  ok(/if \(name === 'liberado'\) el\.classList\.remove\('hidden'\)/.test(front),
     'aparecendo só quando o servidor diz que aconteceu');

  console.log('\n=== 6. O beco sem saída não voltou ===');
  ok(!/numero_em_outra_conta/.test(codigo), 'não há mais código de recusa por número ocupado');
  ok(!/esOferecerAssumir/.test(front), 'nem botão de "assumir" na tela: não há o que decidir');
  ok(!/podeAssumir/.test(api + front), 'nem pergunta ao usuário sobre isso');

  console.log('\n=== 7. UMA aba só para o WhatsApp ===');
  // Eram três — "Conexão do WhatsApp", "Conexão & API" e "Número & Perfil" —
  // para um assunto só. Três abas obrigam a pessoa a adivinhar em qual está o
  // que ela procura, e a resposta ainda mudava conforme o número estivesse
  // conectado ou não.
  ok(/data-tab="whatsapp"[^>]*>\$\{ico\('smartphone', 14\)\} WhatsApp</.test(front),
     'a aba se chama só "WhatsApp"');
  for (const velha of ['data-tab="contas"', 'data-tab="conexao"', 'data-tab="numero"']) {
    ok(!front.includes(velha), 'a aba antiga ' + velha.split('"')[1] + ' não existe mais');
  }
  for (const pane of ['data-pane="contas"', 'data-pane="conexao"', 'data-pane="numero"']) {
    ok(!front.includes(pane), 'nem o painel ' + pane.split('"')[1]);
  }
  // O conteúdo dos três tem de estar DENTRO do painel novo, e não solto na
  // página — foi o que aconteceu na primeira tentativa, com um </div> a mais.
  const pi = front.indexOf('data-pane="whatsapp"');
  const pf = front.indexOf('data-pane="conta"', pi);
  const dentro = front.slice(pi, pf);
  for (const [marca, oque] of [['${channelsCard()}', 'a conexão'], ['${connCard}', 'conectar/API'],
                               ['Perfil comercial do WhatsApp', 'o perfil comercial'],
                               ['Ligações no WhatsApp', 'as ligações'],
                               ['Registro / verificação do número', 'o registro na Cloud API']]) {
    ok(dentro.includes(marca), oque + ' está dentro da aba');
  }
  // E ninguém pode ficar apontando para aba que não existe.
  ok(!/showSettingsTab\('(contas|conexao|numero)'\)/.test(front),
     'nenhum link leva a uma aba que sumiu');
  ok(!/PENDING_TAB = '(contas|conexao|numero)'/.test(front),
     'nem o atalho do menu do topo');

  await encerrar(null, falhas);
})();
