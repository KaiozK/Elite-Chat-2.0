// ============================================================================
// O SERVIDOR SOBE
//
// A suíte inteira monta `src/api` direto num express de teste. É rápido e
// isola bem — e tem um ponto cego do tamanho de um deploy: o `server.js`
// NUNCA É CARREGADO. Tudo que mora só nele (os webhooks de gateway, os
// arquivos estáticos, os redirecionamentos) fica fora do alcance dos testes.
//
// Foi assim que o SMS quase derrubou a produção: o módulo saiu, os 77 arquivos
// de teste passaram, e o `server.js` continuava com
// `require('./src/sms')` numa linha que ninguém executava aqui. No deploy
// seguinte o processo morreria no boot com MODULE_NOT_FOUND — não uma tela
// quebrada, o app inteiro fora do ar.
//
// Este teste faz a coisa mais óbvia que faltava: sobe o servidor de verdade,
// numa porta livre, e confere que ele responde. É o teste mais barato da suíte
// e o que cobre a falha mais cara.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const { spawn } = require('child_process');

const PORTA = 3897;

(async () => {
  console.log('=== 1. `node server.js` sobe sem morrer no boot ===');
  const filho = spawn(process.execPath, [R + 'server.js'], {
    cwd: R, env: { ...process.env, PORT: String(PORTA) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let saida = '', erro = '';
  filho.stdout.on('data', d => { saida += d; });
  filho.stderr.on('data', d => { erro += d; });

  // espera o banner ou a morte, o que vier primeiro
  const subiu = await new Promise(resolve => {
    const prazo = setTimeout(() => resolve(false), 25000);
    filho.on('exit', () => { clearTimeout(prazo); resolve(false); });
    const olhar = setInterval(() => {
      if (/Koonfy rodando/.test(saida)) { clearTimeout(prazo); clearInterval(olhar); resolve(true); }
    }, 200);
  });

  const primeiraLinhaDoErro = (erro.split('\n').find(l => /Error|Cannot find/.test(l)) || '').trim();
  ok(subiu, 'o processo chega a escutar a porta', subiu ? '' : (primeiraLinhaDoErro || 'morreu no boot'));

  if (subiu) {
    console.log('\n=== 2. E responde nas três portas de entrada ===');
    for (const [rota, oque] of [['/', 'o site'], ['/app/', 'o painel'], ['/adm/', 'o Admin SaaS']]) {
      let st = 0;
      try { st = (await fetch('http://127.0.0.1:' + PORTA + rota)).status; } catch (e) { st = 0; }
      ok(st === 200, `${oque} responde`, 'HTTP ' + st);
    }

    console.log('\n=== 3. O webhook da Meta continua de pé ===');
    // É a porta por onde entra toda mensagem recebida: se ela some num
    // refactor, o produto para de receber e nada na tela avisa.
    let vw = 0;
    try { vw = (await fetch('http://127.0.0.1:' + PORTA + '/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1')).status; }
    catch { vw = 0; }
    ok(vw === 200 || vw === 403, 'GET /webhook responde (200 ou 403, nunca 404)', 'HTTP ' + vw);

    console.log('\n=== 4. E o do SMS não existe mais ===');
    let sw = 0;
    try { sw = (await fetch('http://127.0.0.1:' + PORTA + '/sms-webhook', { method: 'POST' })).status; }
    catch { sw = 0; }
    ok(sw === 404, 'POST /sms-webhook devolve 404: o módulo saiu inteiro', 'HTTP ' + sw);
  }

  try { filho.kill('SIGKILL'); } catch {}
  await new Promise(r => setTimeout(r, 300));
  await encerrar(null, falhas);
})();
