// ============================================================================
// BARRAR NÃO PODE VIRAR TRANCAR DO LADO DE FORA
//
// O mesmo WhatsApp em duas contas não dá erro em lugar nenhum e quebra de um
// jeito que ninguém liga aos pontos: a mensagem recebida entra só numa delas,
// a outra envia e nunca recebe, e a janela de 24h não abre lá. Parece banco
// perdendo mensagem, e é roteamento. Por isso a conexão barra — e barrar está
// certo.
//
// O que estava errado era a saída. A recusa dizia "desconecte-o lá antes de
// conectar aqui", o que supõe que a pessoa ALCANÇA a outra conta. Quando a
// outra é um cadastro antigo, um teste esquecido ou uma conta a que ela não
// tem mais acesso, a frase tranca o dono do lado de fora do próprio número —
// depois de ele já ter passado por toda a autorização na Meta, com os quatro
// primeiros passos verdes na tela.
//
// Agora a recusa vem com a saída junto.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  const i = api.indexOf('const jaTem = db.accountsByPhoneId(phone.id)');
  const bloco = api.slice(i, i + 3600);

  console.log('=== 1. A guarda continua de pé ===');
  ok(i > 0, 'a conexão ainda confere se o número está em outra conta');
  ok(/status = 409/.test(bloco), 'e recusa com 409 quando está');
  ok(/!\(req\.body \|\| \{\}\)\.assumir/.test(bloco),
     'a recusa só vale quando a pessoa NÃO pediu para assumir');

  console.log('\n=== 2. A recusa carrega a saída ===');
  ok(/code: 'numero_em_outra_conta'/.test(bloco), 'diz qual é o caso, para a tela reconhecer');
  ok(/contas: jaTem\.map/.test(bloco), 'e QUAIS contas têm o número — a pessoa precisa saber de onde sai');
  ok(/podeAssumir: !req\.agent/.test(bloco), 'e se esta pessoa pode assumir');

  console.log('\n=== 3. Assumir é do TITULAR, não do atendente ===');
  // Trocar a conexão de conta mexe em quem recebe as mensagens da empresa
  // inteira. Não é decisão de quem atende.
  ok(/if \(req\.agent\)/.test(bloco) && /status = 403/.test(bloco),
     'atendente que tenta assumir leva 403');

  console.log('\n=== 4. Assumir desconecta de VERDADE do outro lado ===');
  // Sem limpar o phoneNumberId lá, as duas contas continuariam achando que têm
  // o número — que é exatamente o estado que a guarda existe para evitar.
  ok(/ch\.wa\.connected = false;/.test(bloco), 'a outra conta fica desconectada');
  ok(/ch\.wa\.phoneNumberId = '';/.test(bloco), 'e o id do número é limpo lá');

  console.log('\n=== 5. Quem PERDEU o número fica sabendo ===');
  // Sem isto a outra conta simplesmente para de receber, e ninguém liga uma
  // coisa à outra — é o mesmo sumiço silencioso que a guarda quer evitar.
  ok(/agents\.log\(outra/.test(bloco), 'entra no histórico da conta que perdeu');
  ok(/type: 'numero_assumido'/.test(bloco), 'e no log de eventos, com o motivo escrito');
  ok(/broadcast\('wa', \{ accountId: outra\.id \}\)/.test(bloco),
     'e a tela dela é avisada na hora');
  ok(/agents\.log\(acc, req\.who, 'wa_connect'/.test(bloco),
     'do lado de quem assumiu, também fica registrado quem fez');

  console.log('\n=== 6. A TELA oferece a saída, em vez do beco ===');
  const front = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(/m\.code === 'numero_em_outra_conta' && m\.podeAssumir/.test(front),
     'a tela reconhece o caso e oferece o botão');
  ok(/function esOferecerAssumir/.test(front), 'com o aviso do que vai acontecer');
  ok(/Desconectar de lá e conectar aqui/.test(front), 'e o botão diz o que faz');
  ok(/let esUltimo = null/.test(front),
     'guardando o código da Meta, para não refazer a autorização inteira');

  console.log('\n=== 7. E não abre um segundo modal por cima do primeiro ===');
  // `confirmModal` chama `openModal`, que substituiria o modal da conexão — e
  // os passos que já deram certo sumiriam justo quando são a única pista.
  const fn = front.slice(front.indexOf('async function esAssumirNumero'),
                         front.indexOf('async function esAssumirNumero') + 700);
  ok(!/confirmModal/.test(fn), 'o botão age direto: o aviso ao lado dele é a confirmação');
  ok(/b\.disabled = true/.test(fn), 'e trava contra clique duplo');

  await encerrar(null, falhas);
})();
