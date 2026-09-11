// ============================================================================
// A MENSAGEM QUE CHEGA — e o Phone Number ID que a Meta troca sozinha
//
// O `phone_number_id` NÃO é estável. Ele muda quando o número é removido e
// reconectado, quando migra de WABA, quando sai do número de teste para o de
// produção. O número de telefone continua o mesmo — e é o que a pessoa
// reconhece.
//
// Quando o ID muda, a mensagem chega e SOME: o Koonfy guarda o ID antigo, a
// Meta manda o novo, nenhuma conta reconhece, e o cliente vê o WhatsApp
// "parar de funcionar" sem nenhum erro na tela. Aconteceu de verdade neste
// projeto — o log registrou `unrouted` com dois IDs diferentes para o mesmo
// número, e o dono teve de comparar duas sequências de 15 dígitos a olho.
//
// Agora o telefone entregue é comparado com o telefone de cada conexão. Se
// bater, o ID é corrigido sozinho e a mensagem segue. É seguro porque o corpo
// já passou pela assinatura HMAC da Meta na entrada do webhook: um terceiro
// não consegue forjar um evento para apontar uma conexão para outro lugar.
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
const express = require(path.join(R, 'node_modules', 'express'));

db.load();
const data = db.get();
data.accounts.length = 0;
const acc = db.newAccount({ name: 'Administrador', email: 'adm@teste.local', pass: '123456' });
acc.channels = [{
  id: 'ch1', label: 'WhatsApp principal',
  wa: { connected: true, phoneNumberId: 'ID-ANTIGO', displayPhoneNumber: '5511918010600', wabaId: 'W1', token: 'x' }
}];
acc.wa = acc.channels[0].wa;
data.accounts.push(acc);
data.platform.appSecret = '';        // sem assinatura no teste local
db.save();

const eventos = [];
const app = express();
app.use(express.json({ verify: (q, s, b) => { q.rawBody = b; } }));
app.use('/', require(path.join(R, 'src', 'webhook'))((t, p) => eventos.push({ t, ...p })));
const srv = app.listen(3996);

const corpo = (pnid, fone, texto) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'W1', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: fone, phone_number_id: pnid },
    contacts: [{ profile: { name: 'Kaio' }, wa_id: '5511988887777' }],
    messages: [{ from: '5511988887777', id: 'wamid.' + Math.random(), timestamp: String(Date.now() / 1000 | 0),
                 type: 'text', text: { body: texto } }]
  } }] }]
});
async function entregar(c) {
  const r = await fetch('http://127.0.0.1:3996/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c)
  });
  await new Promise(x => setTimeout(x, 400));
  return r.status;
}

(async () => {
  await new Promise(r => setTimeout(r, 200));

  console.log('=== 1. O caminho normal ===');
  const st = await entregar(corpo('ID-ANTIGO', '5511918010600', 'oi'));
  ok(st === 200, 'a Meta recebe 200 na hora', 'HTTP ' + st);
  ok(acc.messages.length === 1, 'a mensagem é guardada', acc.messages.length + ' mensagem(ns)');
  ok(acc.contacts.length === 1 && acc.contacts[0].name === 'Kaio', 'o contato é criado com o nome do perfil');
  ok(eventos.some(e => e.t === 'message'), 'e a tela é avisada na hora, sem recarregar');

  console.log('\n=== 2. O MESMO número, com o ID trocado pela Meta ===');
  eventos.length = 0;
  await entregar(corpo('ID-NOVO', '5511918010600', 'oi de novo'));
  ok(acc.messages.length === 2, 'a mensagem entra do mesmo jeito', acc.messages.length + ' mensagem(ns)');
  ok(acc.channels[0].wa.phoneNumberId === 'ID-NOVO',
     'e o cadastro se corrige sozinho', acc.channels[0].wa.phoneNumberId);
  const corrigido = db.get().webhookLog.find(x => x.type === 'phone_id_atualizado');
  ok(!!corrigido, 'com registro do que mudou — correção silenciosa vira mistério depois');
  ok(corrigido && corrigido.idAnterior === 'ID-ANTIGO', 'dizendo qual era o ID antigo', corrigido && corrigido.idAnterior);

  console.log('\n=== 3. Um número que NÃO é desta plataforma ===');
  // Aqui não há o que corrigir: adivinhar um dono seria entregar a conversa de
  // alguém para a conta errada, que é muito pior do que não entregar.
  eventos.length = 0;
  const antes = acc.messages.length;
  await entregar(corpo('ID-DESCONHECIDO', '5511777770000', 'de outro número'));
  ok(acc.messages.length === antes, 'a mensagem NÃO é atribuída a ninguém');
  ok(!eventos.some(e => e.t === 'message'), 'e nenhuma tela é avisada');
  const perdida = db.get().webhookLog.find(x => x.type === 'unrouted');
  ok(!!perdida, 'fica registrada como "sem dono"');
  // Comparar dois números de 15 dígitos a olho não diz nada a ninguém.
  ok(perdida && perdida.telefoneEntregue === '5511777770000',
     'com o TELEFONE que a Meta entregou', perdida && perdida.telefoneEntregue);
  ok(perdida && (perdida.cadastrados[0] || {}).telefone === '5511918010600',
     'ao lado do telefone que está cadastrado aqui — é a comparação que resolve',
     perdida && (perdida.cadastrados[0] || {}).telefone);

  console.log('\n=== 4. O contato carimbado num canal que não existe mais ===');
  // O id do canal muda mais do que parece: reconectar o WhatsApp, trocar de
  // número, recriar a conexão. Quando muda, TODA a conversa anterior fica
  // apontando para um canal fora da lista e some da tela — o dado continua no
  // banco, invisível. É o pior tipo de sumiço: nada quebra, nada avisa, e a
  // pessoa conclui que perdeu os clientes.
  // O conserto deixou de ser um remendo no filtro e passou a ser a regra: a
  // conta tem UMA conexão, então não existe canal para esconder conversa. Quem
  // prova o comportamento de ponta a ponta é tests/uma-conexao-por-conta.
  const api = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
  const filtro = api.slice(api.indexOf('function chanConversa'), api.indexOf('function listScope'));
  ok(/tudo: true/.test(filtro) && /f: \(\) => true/.test(filtro),
     'a caixa de entrada não filtra por canal — nada fica invisível');
  ok(!/f: o => \(o\.chId \|\| dflt\) === id/.test(filtro),
     'o filtro antigo, que escondia o órfão para sempre, não está mais lá');
  const dbSrc = fs.readFileSync(path.join(R, 'src', 'db.js'), 'utf8');
  ok(/function colapsarCanais/.test(dbSrc) && /for \(const c of acc\.contacts \|\| \[\]\) if \(c\.chId !== id\)/.test(dbSrc),
     'e o que já ficou carimbado errado é reetiquetado em toda carga do banco');

  console.log('\n=== 5. Dá para SABER se há mais de um servidor no ar ===');
  // Com o banco em ARQUIVO, cada instância tem o seu próprio db.json: o que se
  // grava numa não existe na outra. O sintoma parece defeito aleatório — o
  // contato é criado (a notificação sai), a lista vem vazia, o link rastreável
  // some depois de salvo. Nada disso é bug de tela; são dois bancos.
  //
  // Nenhum log responde "quantos servidores estão atendendo?". Um id sorteado
  // por processo responde: recarregue e veja se ele muda.
  const apiSrc = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
  ok(/const INSTANCIA = require\('crypto'\)\.randomBytes\(3\)\.toString\('hex'\)/.test(apiSrc),
     'cada processo sorteia um id na partida');
  ok(/instancia: INSTANCIA, host: require\('os'\)\.hostname\(\)/.test(apiSrc),
     'e ele vai junto com o motor do banco para o painel');
  const front = fs.readFileSync(path.join(R, 'public', 'app', 'app.js'), 'utf8');
  ok(/se este código mudar/.test(front),
     'com a instrução do que fazer com ele, na própria tela');
  ok(/Banco de dados:/.test(front) && /MySQL \(externo\)/.test(front),
     'ao lado do banco em uso — as duas respostas na mesma linha');

  console.log('\n=== 6. O MESMO número conectado em DUAS contas ===');
  // O defeito mais confuso do produto, porque nada dá erro:
  //   · a mensagem RECEBIDA entra só na primeira conta da lista;
  //   · a mensagem ENVIADA é gravada na conta de quem clicou em enviar;
  //   · quem está na segunda conta vê as próprias mensagens saírem, não vê
  //     resposta nenhuma chegar, e a janela de 24h NUNCA abre — porque, para
  //     aquela conta, o cliente de fato nunca falou.
  // Do lado de fora parece banco de dados perdendo mensagem. É roteamento.
  const gemea = db.newAccount({ name: 'Vídeo', email: 'video@teste.local', pass: '123456' });
  gemea.channels = [{ id: 'ch_v', label: 'WhatsApp principal',
    wa: { connected: true, phoneNumberId: acc.channels[0].wa.phoneNumberId,
          displayPhoneNumber: '5511918010600', token: 'x' } }];
  gemea.wa = gemea.channels[0].wa;
  data.accounts.push(gemea);

  const donos = db.accountsByPhoneId(acc.channels[0].wa.phoneNumberId);
  ok(donos.length === 2, 'o sistema enxerga as DUAS contas com o mesmo número', donos.map(a => a.name).join(', '));

  const antesGemea = gemea.messages.length;
  await entregar(corpo(acc.channels[0].wa.phoneNumberId, '5511918010600', 'Tudo bem?'));
  ok(gemea.messages.length === antesGemea,
     'a mensagem entra numa conta só — a segunda continua sem receber nada');
  const aviso = db.get().webhookLog.find(x => x.type === 'numero_duplicado');
  ok(!!aviso, 'MAS agora o sistema DIZ que isso está acontecendo');
  ok(aviso && /Administrador, Vídeo/.test(aviso.explicacao),
     'nomeando as duas contas, para saber qual desconectar');
  ok(aviso && /janela de 24h não abre/.test(aviso.explicacao),
     'e explicando o sintoma, que é o que ninguém liga à causa');

  // E a porta de entrada RESOLVE, em vez de recusar. Recusar deixava o dono
  // trancado do lado de fora quando a outra conta era um cadastro antigo:
  // "desconecte-o lá antes" supõe que ele alcança a outra conta. Agora conectar
  // aqui desconecta lá, como o WhatsApp faz quando o número é registrado num
  // aparelho novo — a autorização na Meta é a prova de posse.
  const apiSrc2 = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
  ok(/const jaTem = db\.accountsByPhoneId\(phone\.id\)\.filter\(a => a\.id !== acc\.id\)/.test(apiSrc2),
     'a conexão confere se o número já está em outra conta');
  ok(/ch\.wa\.connected = false;/.test(apiSrc2) && /ch\.wa\.phoneNumberId = '';/.test(apiSrc2),
     'e desconecta de lá, em vez de deixar as duas quebradas');
  ok(/type: 'numero_movido'/.test(apiSrc2),
     'registrando o motivo na conta que perdeu — senão ela só para de receber');

  console.log('\n=== 7. Canal DESCONECTADO não rouba a mensagem ===');
  // O caso que faz a pessoa desistir: ela descobre a duplicidade, desconecta o
  // número da conta errada — e nada muda, porque o canal desconectado ainda
  // guarda o `phoneNumberId` e continua roteando para lá. Ela conclui que o
  // sistema perde mensagem.
  //
  // Mensagem que chega é conversa viva: pertence a quem está CONECTADO.
  acc.channels[0].wa.connected = false;              // a primeira vira resíduo
  gemea.channels[0].wa.connected = true;             // a segunda é a de verdade
  const antesGemea2 = gemea.messages.filter(m => m.direction === 'in').length;
  const antesAcc = acc.messages.filter(m => m.direction === 'in').length;
  await entregar(corpo(acc.channels[0].wa.phoneNumberId, '5511918010600', 'e agora?'));
  ok(acc.messages.filter(m => m.direction === 'in').length === antesAcc,
     'a conta desconectada NÃO recebe mais');
  ok(gemea.messages.filter(m => m.direction === 'in').length === antesGemea2 + 1,
     'a mensagem vai para a conta conectada, mesmo ela vindo depois na lista');
  const cg = gemea.contacts.find(c => c.waId === '5511988887777');
  ok(!!cg && !!cg.lastInboundAt, 'e a janela de 24h abre nela — que era o sintoma na tela');

  console.log('\n=== 8. O diagnóstico responde sozinho ===');
  // O diagnóstico estava sendo feito por eliminação: um palpite por teste, e
  // cada palpite custando um deploy. As causas possíveis são poucas e todas
  // verificáveis pelo servidor — então ele verifica todas de uma vez e escreve
  // a conclusão, em vez de devolver JSON para alguém interpretar.
  const apiSrc3 = fs.readFileSync(path.join(R, 'src', 'api.js'), 'utf8');
  const rota = apiSrc3.slice(apiSrc3.indexOf("router.get('/adm/por-que-nao-aparece'"),
                             apiSrc3.indexOf("router.get('/webhook-log'"));
  ok(rota.length > 500, 'a rota de diagnóstico existe');
  ok(/const achados = \[\]/.test(rota), 'e devolve uma CONCLUSÃO escrita, não só dados');
  for (const [o, q] of [
    ['O MESMO número está em', 'o mesmo número em duas contas'],
    ['Nenhuma conta reconhece o Phone Number ID', 'número que ninguém reconhece'],
    ['que não existe mais — some da lista de Conversas', 'contato órfão num canal apagado'],
    ['banco está em ARQUIVO num host que recria o disco', 'banco que se apaga no deploy'],
    ['compare o campo "servidor" entre duas recargas', 'mais de um servidor']
  ]) {
    ok(rota.includes(o), 'ela detecta: ' + q);
  }
  ok(/instancia: INSTANCIA/.test(rota), 'e diz qual servidor respondeu, para comparar entre recargas');
  const front2 = fs.readFileSync(path.join(R, 'public', 'app', 'app.js'), 'utf8');
  ok(/Por que não aparece\?/.test(front2), 'com um botão na tela de Logs, sem precisar montar URL');
  ok(/Copiar diagnóstico/.test(front2), 'e um botão para copiar tudo de uma vez');

  const antesT = JSON.parse(original || '{}');
  for (const k of ['accounts', 'revenue', 'plans']) {
    if (Array.isArray(data[k])) data[k].length = 0;
    if (Array.isArray(antesT[k])) data[k].push(...antesT[k]);
  }
  db.save();
  devolver();
  await encerrar(srv, falhas);
})();
