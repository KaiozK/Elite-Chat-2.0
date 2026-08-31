// ============================================================================
// OS ERROS DA META, EM PORTUGUÊS
//
// A Graph API responde em inglês, e a frase dela é escrita para quem programa:
// "Calling APIs cannot be enabled for this phone number", "Re-engagement
// message", "Invalid OAuth access token". Isso chegava CRU na tela do cliente —
// outro idioma, sobre um sistema que não é o nosso, e sem nada que ele pudesse
// fazer a respeito.
//
// A regra de cada texto daqui: dizer o que aconteceu E o que fazer. Uma
// tradução literal continuaria sendo um beco sem saída, só que em português.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const erros = require(R + 'src/metaerros');

(async () => {
  console.log('=== 1. Os erros que o cliente mais encontra ===');
  const casos = [
    [{ code: 190, message: 'Invalid OAuth access token' }, /Reconecte o seu WhatsApp/i, 'token expirado'],
    [{ code: 131047, message: 'Re-engagement message' }, /24 horas/, 'janela de 24h'],
    [{ code: 131026, message: 'Message undeliverable' }, /não pôde ser entregue/i, 'não entregue'],
    [{ code: 132001, message: 'Template name does not exist' }, /modelo não existe/i, 'modelo inexistente'],
    [{ code: 132000, message: 'Number of parameters does not match' }, /variáveis/i, 'variáveis do modelo'],
    [{ code: 2593145, message: 'Calling APIs cannot be enabled' }, /não liberou ligações/i, 'ligações'],
    [{ code: 133005, message: 'Two-step verification PIN mismatch' }, /PIN/, 'PIN errado'],
    [{ code: 4, message: 'Application request limit reached' }, /alguns minutos/i, 'limite de chamadas'],
    [{ code: 131031, message: 'Account has been locked' }, /bloqueada/i, 'conta bloqueada']
  ];
  for (const [erro, esperado, nome] of casos) {
    const t = erros.mensagem(erro);
    ok(esperado.test(t) && !/[a-z]{4,} [a-z]{4,} (token|message|template)/i.test(t), nome + ': ' + t);
  }

  console.log('\n=== 2. Cada texto diz O QUE FAZER, e não só o que houve ===');
  // Uma tradução literal continuaria sendo um beco sem saída, só que em
  // português. O texto do token manda reconectar; o da janela de 24h explica a
  // saída (usar um modelo); o de limite diz quanto esperar.
  ok(/Configurações/.test(erros.mensagem({ code: 190 })), 'o token diz onde reconectar');
  ok(/MODELO aprovado/.test(erros.mensagem({ code: 131047 })), 'a janela de 24h diz qual é a saída');
  ok(/Gerenciador de Negócios/.test(erros.mensagem({ code: 131031 })), 'a conta bloqueada diz onde resolver');

  console.log('\n=== 3. Sem tradução, o original passa ===');
  // Melhor uma frase em inglês do que nenhuma pista: um erro novo da Meta não
  // pode virar uma tela em branco.
  const desconhecido = erros.mensagem({ code: 987654, message: 'Some brand new Meta failure' });
  ok(desconhecido === 'Some brand new Meta failure', 'o desconhecido chega inteiro: ' + desconhecido);
  ok(erros.mensagem(null, 'Falha na chamada') === 'Falha na chamada', 'e o padrão vale quando não há erro');

  console.log('\n=== 4. Pelo TEXTO quando não vem código ===');
  // A frase da Meta muda de redação sem aviso, por isso o código vem primeiro —
  // mas nem toda resposta traz código.
  ok(/não liberou ligações/i.test(erros.mensagem({ message: 'Calling APIs cannot be enabled for this number' })),
     'reconhece a frase das ligações sem código');
  ok(/Reconecte/i.test(erros.mensagem({ message: 'Error validating access token: Session has expired' })),
     'e a do token');

  console.log('\n=== 5. A tradução mora num lugar só ===');
  // As mensagens da Meta aparecem no chat, nas campanhas, nas configurações e
  // no diagnóstico. Uma tradução por tela viraria quatro que divergem.
  const metaSrc = fs.readFileSync(R + 'src/meta.js', 'utf8');
  const waSrc = fs.readFileSync(R + 'src/whatsapp.js', 'utf8');
  ok(/require\('\.\/metaerros'\)\.mensagem/.test(metaSrc), 'meta.js traduz na criação do erro');
  ok(/require\('\.\/metaerros'\)\.mensagem/.test(waSrc), 'whatsapp.js também');
  ok(!/new Error\(\(data\.error && data\.error\.message\) \|\| `Graph API/.test(metaSrc + waSrc),
     'e nenhum dos dois cria mais o erro com a frase crua');

  console.log('\n=== 6. O ORIGINAL não se perde ===');
  // É o que alguém usa para procurar o código na documentação da Meta.
  ok(/err\.metaOriginal = cru/.test(metaSrc) && /err\.metaOriginal = cru/.test(waSrc),
     'o texto da Meta fica guardado no erro');
  // E a regra das ligações compara o ORIGINAL, não a tradução: amarrar a regra
  // à redação em português a quebraria quando alguém melhorasse o texto.
  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  ok(/const bruto = String\(e\.metaOriginal \|\| e\.message \|\| ''\);/.test(api),
     'e a regra das ligações compara o original');

  await encerrar(null, falhas);
})();
