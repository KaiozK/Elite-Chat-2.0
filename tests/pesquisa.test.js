// A PESQUISA DE SATISFAÇÃO NO HISTÓRICO DO CHAT.
//
// O cliente recebe botões de verdade no WhatsApp, mas o que ficava guardado na
// conversa era um resumo em texto: a pergunta e as notas como "• Bom". Quem
// abria o chat via uma lista de marcadores onde havia botões — o mesmo
// descompasso já corrigido nos outros envios interativos.
//
// O que este teste segura:
//   · o corpo guardado é só a PERGUNTA, sem os marcadores;
//   · até três notas viram três botões, com o id que a resposta usa de volta;
//   · acima disso a Cloud API entrega como LISTA, e o cliente vê UM botão — o
//     do menu. É esse que fica no histórico, e não as dez opções escondidas.
const survey = require('C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/src/survey');
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };

const cfg = (notas, extra) => Object.assign({
  enabled: true,
  message: 'Obrigado pelo contato! 🙏\n\nComo você avalia o nosso atendimento?',
  notes: notas
}, extra || {});

const TRES = [
  { id: 'ruim', label: '⭐ Ruim' },
  { id: 'bom', label: '😊 Bom' },
  { id: 'otimo', label: '🤩 Excelente' }
];

console.log('=== 1. O corpo guardado é a pergunta, e só ela ===');
const c3 = cfg(TRES);
const texto = survey.summaryText(c3);
ok(texto === c3.message.trim(), 'a pergunta ficou inteira');
ok(!texto.includes('•'), 'sem marcador nenhum no texto: ' + JSON.stringify(texto.slice(-20)));
ok(!texto.includes('Ruim'), 'e sem as notas coladas no fim');

console.log('\n=== 2. Três notas viram três botões ===');
const b3 = survey.summaryButtons(c3);
ok(b3.length === 3, 'três botões: ' + b3.length);
ok(b3.map(b => b.title).join(' | ') === '⭐ Ruim | 😊 Bom | 🤩 Excelente', 'com os rótulos do painel');
ok(b3[0].id === survey.REPLY_PREFIX + 'ruim', 'e o id que a resposta do cliente usa de volta: ' + b3[0].id);
// O que fica no histórico tem que bater com o que foi enviado.
const env = survey.buildInteractive(c3);
ok(env.type === 'button', 'o envio é de botões: ' + env.type);
ok(env.action.buttons.map(x => x.reply.title).join() === b3.map(x => x.title).join(),
   'o histórico mostra exatamente os botões enviados');

console.log('\n=== 3. Acima de três, o cliente vê UM botão: o do menu ===');
const muitas = [1, 2, 3, 4, 5].map(n => ({ id: 'n' + n, label: 'Nota ' + n }));
const c5 = cfg(muitas, { listButton: 'Dar minha nota' });
const b5 = survey.summaryButtons(c5);
ok(survey.formatOf(c5) === 'list', 'cinco notas saem como lista');
ok(b5.length === 1, 'e o balão guarda um botão só: ' + b5.length);
ok(b5[0].title === 'Dar minha nota', 'o rótulo do menu, que é o que ele lê na tela: ' + b5[0].title);
ok(survey.buildInteractive(c5).action.button === 'Dar minha nota', 'igual ao enviado');

console.log('\n=== 4. Limites da Cloud API ===');
const longo = cfg([{ id: 'x', label: 'Um rótulo bem maior do que a Meta aceita num botão' }]);
ok(survey.summaryButtons(longo)[0].title.length <= survey.BTN_TITLE_MAX,
   'o título é cortado no mesmo limite do envio: ' + survey.summaryButtons(longo)[0].title);
ok(survey.summaryButtons(cfg([])).length === 0, 'sem notas configuradas, nenhum botão');

console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
process.exit(falhas ? 1 : 0);
