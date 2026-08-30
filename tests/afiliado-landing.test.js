// ============================================================================
// LINK DE AFILIADO → LANDING, e o toque da ligação
//
// O link de indicação abria a TELA DE ENTRADA do app. Quem recebe uma indicação
// quase nunca conhece o produto: a primeira coisa que via era um formulário de
// login de uma coisa que ele não sabe o que é. A landing é a página que
// EXPLICA, e é ela que faz a indicação virar assinatura — que é de onde sai a
// comissão de quem indicou.
//
// O RISCO DA MUDANÇA, e é o que este arquivo existe para prender: a landing é o
// MEIO do caminho, não o destino. O código de indicação precisa chegar ao
// CADASTRO. Trocar o destino do link sem construir essa ponte teria custado a
// comissão de todo mundo — o clique chegaria à landing, o código morreria ali,
// e o cadastro aconteceria sem dono. Silenciosamente.
//
// São duas pontes de propósito:
//   1. o COOKIE (ec_ref, 7 dias, path=/), que é o que o app já lia;
//   2. o `ref` grudado nos botões, que funciona mesmo com cookie bloqueado —
//      o caso de quem navega em aba anônima, que é justamente quem clica em
//      link de indicação.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
const fs = require('fs');
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

// QUAL LANDING? Esta linha vale mais do que parece. O teste antes lia
// `public/index.html` — e a vitrine no ar é `public/nova.html` desde a troca
// (ver LANDING_FILE em server.js). O teste passava verde enquanto o link do
// afiliado morria na primeira tela: a captura do `?ref=` estava toda na página
// que ninguém mais vê.
//
// Agora o arquivo sai do PRÓPRIO servidor. Trocar a vitrine outra vez sem levar
// a indicação junto quebra este arquivo, que é exatamente o aviso que faltou.
const servidor = fs.readFileSync(R + 'server.js', 'utf8');
const mLanding = servidor.match(/const LANDING_FILE = path\.join\(__dirname, 'public', '([^']+)'\)/);
const ARQ_LANDING = mLanding ? mLanding[1] : 'index.html';
const landing = fs.readFileSync(R + 'public/' + ARQ_LANDING, 'utf8');
const landingAntiga = fs.readFileSync(R + 'public/index.html', 'utf8');
const app = fs.readFileSync(R + 'public/app/app.js', 'utf8');
const api = fs.readFileSync(R + 'src/api.js', 'utf8');
const notif = fs.readFileSync(R + 'public/app/notifications.js', 'utf8');

(async () => {
  console.log('=== 0. O teste olha a vitrine QUE ESTÁ NO AR ===');
  ok(!!mLanding, 'o servidor diz qual arquivo é a vitrine: ' + ARQ_LANDING);
  ok(/id="planos"|href="\/assinar/.test(landing), 'e ela é uma página de venda de verdade');

  console.log('\n=== 1. O link do afiliado aponta para a landing ===');
  ok(/const refLink = `\$\{API\.webOrigin\}\/\?ref=\$\{a\.code\}`;/.test(app),
     'a tela de Afiliação monta o link para a raiz do site');
  ok(!/webOrigin\}\/app\/\?ref=/.test(app), 'e não mais para a tela de entrada do app');

  // O convite que vai no relatório compartilhado é o mesmo link, e por isso
  // precisa ter mudado junto — dois destinos diferentes para o mesmo programa
  // de afiliados seria a metade dos cliques caindo no lugar errado.
  ok(api.includes("base + '/?ref=' + encodeURIComponent(codigo)"),
     'o convite do relatório compartilhado também');
  ok(!api.includes("base + '/app/?ref=' + encodeURIComponent(codigo)"),
     'e o destino antigo saiu de lá');

  console.log('\n=== 2. A landing CARREGA o código adiante ===');
  // Sem isto, a mudança acima seria uma regressão cara e silenciosa.
  ok(/new URLSearchParams\(location\.search\)\.get\('ref'\)/.test(landing),
     'a landing lê o ?ref= da URL');
  ok(/document\.cookie = 'ec_ref='/.test(landing),
     'e grava o cookie que o app já lia');
  ok(/path=\/; SameSite=Lax/.test(landing),
     'com path=/ — sem isso o cookie da raiz não seria visto em /app');
  // A JANELA precisa ser a MESMA nos três arquivos. O cookie é escrito na
  // vitrine e relido no app: se o app expirar antes, ele apaga uma marca que a
  // vitrine ainda considera válida, e a comissão some no meio do caminho.
  // Por isso o teste compara os números em vez de repetir um valor — assim ele
  // pega a divergência, que é o defeito de verdade, e não a troca do prazo.
  const appJs = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const diasDa = txt => { const m = txt.match(/REF_DIAS = (\d+);/); return m && Number(m[1]); };
  const dias = diasDa(landing);
  ok(dias >= 30, `a janela da indicação é longa o bastante: ${dias} dias`);
  ok(diasDa(appJs) === dias, `e o app usa a MESMA: ${diasDa(appJs)}`);
  ok(diasDa(landingAntiga) === dias, `a landing antiga também, para não marcar por prazos diferentes: ${diasDa(landingAntiga)}`);
  ok(/localStorage\.setItem\('ec_ref'/.test(landing) && /localStorage\.setItem\('ec_ref_ts'/.test(landing),
     'guardando também no localStorage, com as mesmas chaves');

  console.log('\n=== 3. E gruda o código nos botões ===');
  // A segunda ponte. Cookie bloqueado é o caso de aba anônima — e quem clica em
  // link de indicação está muito frequentemente numa.
  ok(/function comRef\(url\)/.test(landing), 'existe quem monte a URL com o código');

  // A COLAGEM ACONTECE NO CLIQUE, em captura. A grade de planos é montada
  // depois, por fetch: um laço no carregamento deixaria justamente o botão
  // "Assinar" de cada cartão — o que leva ao checkout — sem o código.
  ok(/addEventListener\('click'[\s\S]{0,400}comRef\(/.test(landing),
     'e ela é aplicada no clique, alcançando também o que foi montado depois');
  ok(/\}, true\);/.test(landing), 'em captura, antes de qualquer handler da página');
  ok(/\^\\\/\(app\|assinar\)/.test(landing),
     'só nos destinos que levam ao cadastro — âncora e link externo ficam limpos');
  ok(/\[\?&\]ref=/.test(landing), 'e sem grudar o código duas vezes');

  ok(/return comRef\('\/app'\);/.test(landingAntiga) && /return comRef\('\/app\?novo=1'\);/.test(landingAntiga),
     'e os DOIS destinos passam por ela — entrar e criar conta');
  ok(!/return '\/app';/.test(landingAntiga) && !/return '\/app\?novo=1';/.test(landingAntiga),
     'nenhum botão escapou com o destino cru');
  ok(/url\.indexOf\('\?'\) >= 0 \? '&' : '\?'/.test(landing),
     'juntando com & quando a URL já tem query — /app?novo=1 é exatamente esse caso');

  console.log('\n=== 4. Quem volta depois ainda é do afiliado ===');
  // A pessoa pode ter chegado pela indicação ontem e voltado hoje digitando o
  // endereço. O cookie vale 7 dias; ignorá-lo aqui perderia essa comissão.
  ok(/ec_ref=\(\[\^;\]\+\)/.test(landing),
     'sem ?ref= na URL, a landing lê o cookie de uma visita anterior');

  console.log('\n=== 5. O toque da ligação é o arquivo, em laço ===');
  ok(fs.existsSync(R + 'public/assets/sons/chamada.mp3'), 'o arquivo está no lugar');
  ok(/call: '\/assets\/sons\/chamada\.mp3'/.test(notif), 'e registrado como som da chamada');
  ok(/a\.loop = true;/.test(notif),
     'toca em LAÇO — um toque tem começo e fim pensados para emendar, e cortá-lo pelo relógio produz silêncios que não existem no som');
  ok(/var NAO_PRECARREGAR = \{ call: true \};/.test(notif),
     'fica fora do pré-carregamento: é o maior arquivo e a maioria das sessões nunca recebe chamada');
  ok(/for \(var k in ARQUIVOS\) if \(!NAO_PRECARREGAR\[k\]\)/.test(notif),
     'e o pré-carregamento respeita isso');

  console.log('\n=== 6. O sintetizado é rede de segurança, não segunda voz ===');
  const ring = notif.slice(notif.indexOf('function startRing'), notif.indexOf('function stopRing'));
  ok(/if \(pr && pr\.catch\)/.test(ring),
     'play() recusado (sem interação ainda) cai no tom sintetizado');
  ok(/state\.prefs\.sounds && !toque\.audio/.test(ring),
     'e o sintetizado SÓ toca quando o arquivo não está tocando — os dois juntos viram barulho');

  const stop = notif.slice(notif.indexOf('function stopRing'), notif.indexOf('function stopRing') + 500);
  ok(/pause\(\)/.test(stop) && /currentTime = 0/.test(stop),
     'parar é pausar E voltar ao zero, senão o próximo toque começa no meio do som');
  ok(/MAX_CICLOS/.test(ring),
     'e o teto de ciclos continua, para uma falha em parar não virar alarme eterno');

  console.log('\n=== 7. A CADEIA INTEIRA, do clique ao cadastro ===');
  // Aqui estava o buraco de verdade, e ele é anterior a esta mudança: o link
  // do afiliado nunca chegou ao cadastro. A cadeia real tem QUATRO saltos, e
  // o código se perdia em três deles:
  //
  //   landing  →  /app?novo=1  →  /assinar  →  POST /api/public/assinatura
  //
  // 1. a landing não lia o ref (corrigido acima);
  // 2. o /app redirecionava para /assinar com `location.replace` puro,
  //    descartando a query inteira;
  // 3. o assinar.html nunca leu o ref;
  // 4. a rota até ACEITA um `ref` — e nunca recebia nenhum.
  //
  // Resultado: todo cadastro vindo de indicação nascia sem dono. Sem erro,
  // sem log, sem nada. Só a comissão que não existia.
  const assinar = fs.readFileSync(R + 'public/assinar.html', 'utf8');
  const pre = fs.readFileSync(R + 'src/preassinatura.js', 'utf8');

  // salto 2
  ok(/location\.replace\('\/assinar' \+ \(ref \? '\?ref='/.test(app),
     'o redirecionamento do /app leva o código junto, em vez de descartar a query');
  ok(/p\.get\('ref'\) \|\| refAtivo\(\)/.test(app),
     'lendo da URL e caindo no cookie — aba anônima não tem cookie, e é onde muita gente abre link recebido');

  // salto 3
  ok(/function refDeIndicacao\(\)/.test(assinar),
     'a página de assinatura descobre quem indicou');
  ok(/ref: refDeIndicacao\(\)/.test(assinar),
     'e MANDA o código no cadastro — era o elo que faltava');
  ok(/ec_ref=\(\[\^;\]\+\)/.test(assinar),
     'com o cookie como segunda fonte');

  // salto 4: a rota já aceitava, e continua aceitando
  ok(/refBy: String\(b\.ref \|\| ''\)/.test(pre),
     'a criação da pré-assinatura lê o ref que agora chega');

  console.log('\n=== 8. O antiabuso cobre o cadastro PRINCIPAL ===');
  // A camada tinha entrado só em /api/register. Mas o cadastro que a landing
  // usa é o da pré-assinatura — verificar a porta menos usada e deixar a
  // principal aberta não verifica nada.
  ok(/require\('\.\/antiabuso'\)\.aoCadastrar/.test(pre),
     'a pré-assinatura passa pelo antiabuso');
  ok(/ip: String\(b\.ip \|\| ''\)/.test(pre),
     'guardando o IP de quem pediu — a conta só nasce depois, num webhook sem requisição para consultar');
  ok(/ip: require\('\.\/antiabuso'\)\.ipDaRequisicao\(req\)/.test(api),
     'e o IP entra pela ROTA, não pelo corpo: sinal que a própria pessoa escreve não é sinal');

  // E o corpo não pode sobrescrever o IP verdadeiro.
  const rota = api.slice(api.indexOf("router.post('/public/assinatura'"), api.indexOf("router.post('/public/assinatura'") + 500);
  ok(rota.indexOf('...(req.body || {})') < rota.indexOf('ip: require'),
     'o IP verdadeiro é aplicado DEPOIS do corpo, senão bastaria mandar um ip: no JSON para escapar');

  await encerrar(null, falhas);
})();
