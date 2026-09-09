// ============================================================================
// O AVISO TEM DE FAZER BARULHO
//
// O som da notificação sumiu, e o motivo não estava no som: estava na trava de
// autoplay do navegador.
//
// O aviso chega pelo SSE — o servidor empurra, a pessoa não clicou em nada. E
// um <audio> que NUNCA tocou dentro de um gesto da pessoa fica bloqueado para
// sempre no iPhone e no PWA instalado. O play() era recusado toda vez, e a
// mensagem chegava muda.
//
// Existia um destrave, mas ele só chamava `ac()`, que religa o AudioContext —
// o caminho do tom SINTETIZADO, que é o plano B. Os MP3, que são o caminho
// principal, não eram destravados por nada. E o toque da ligação era o pior
// caso: ficava fora do pré-carregamento, então nem elemento havia para
// destravar quando o cliente ligasse.
//
// Pior ainda: o destrave era de uma vez só (removia o próprio ouvinte no
// primeiro clique). O iOS SUSPENDE o áudio quando o app vai para segundo
// plano; ao voltar não havia mais nada para religar, e o painel que passou a
// noite aberto acordava mudo até alguém recarregar a página.
//
// Este teste roda o arquivo de verdade num DOM de mentira e mede o que ele faz
// com cada elemento de áudio.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');
const vm = require('vm');

// ---- um navegador de mentira, só com o que o arquivo usa ----
function montarJanela() {
  const ouvintes = {};
  const audios = [];
  const guardado = {};
  class FakeAudio {
    constructor(src) {
      this.src = src; this.muted = false; this.volume = 1; this.loop = false;
      this.currentTime = 0; this.preload = ''; this.paused = true;
      this.tentativas = [];      // cada play(): { mudo, permitido }
      audios.push(this);
    }
    play() {
      // A REGRA DO IPHONE: só toca se já foi liberado, ou se está mudo (que é
      // exatamente como se libera). Fora disso, recusa.
      const permitido = this._liberado || this.muted;
      this.tentativas.push({ mudo: this.muted, permitido });
      if (!permitido) return Promise.reject(Object.assign(new Error('bloqueado'), { name: 'NotAllowedError' }));
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }
  const ctx = {
    state: 'suspended',
    currentTime: 0,
    resume() { this.state = 'running'; return Promise.resolve(); },
    createOscillator: () => ({ type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
    destination: {}
  };
  const doc = {
    hidden: false,
    addEventListener: (t, f) => { (ouvintes['doc:' + t] = ouvintes['doc:' + t] || []).push(f); },
    removeEventListener: (t, f) => { const l = ouvintes['doc:' + t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
    querySelector: () => null, createElement: () => ({ style: {} }), body: { appendChild() {} }
  };
  const win = {
    Audio: FakeAudio, AudioContext: function () { return ctx; },
    document: doc, navigator: { vibrate: () => true },   // sem serviceWorker: supported() = false, pula o SW
    localStorage: { getItem: k => guardado[k] || null, setItem: (k, v) => { guardado[k] = v; }, removeItem: k => { delete guardado[k]; } },
    addEventListener: (t, f) => { (ouvintes[t] = ouvintes[t] || []).push(f); },
    removeEventListener: (t, f) => { const l = ouvintes[t] || []; const i = l.indexOf(f); if (i >= 0) l.splice(i, 1); },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    location: { pathname: '/app/', origin: 'http://x' },
    Notification: undefined,
    setTimeout, clearTimeout, setInterval, clearInterval, console
  };
  win.window = win;
  const disparar = (t) => (ouvintes[t] || []).slice().forEach(f => f());
  const dispararDoc = (t) => (ouvintes['doc:' + t] || []).slice().forEach(f => f());
  return { win, doc, ctx, audios, ouvintes, disparar, dispararDoc, FakeAudio };
}

(async () => {
  const fonte = fs.readFileSync(R + 'public/app/notifications.js', 'utf8');
  const j = montarJanela();
  vm.createContext(j.win);
  vm.runInContext(fonte, j.win);
  const EC = j.win.ECNotify;

  console.log('=== 1. O arquivo carrega e expõe a engine ===');
  ok(!!EC, 'ECNotify existe');
  ok(typeof EC.playSound === 'function', 'com playSound');
  EC.init({});

  console.log('\n=== 2. ANTES de qualquer gesto, o aviso é recusado ===');
  // É o caso real: o celular está na mesa e a mensagem chega pelo SSE.
  EC.playSound('message');
  await new Promise(r => setTimeout(r, 20));
  const som = j.audios.find(a => /mensagem/.test(a.src));
  ok(!!som, 'o elemento do som de mensagem foi criado no carregamento');
  ok(som && som.tentativas.length === 1 && !som.tentativas[0].permitido,
     'e o navegador recusou o play, como faz o iPhone');

  console.log('\n=== 3. O PRIMEIRO gesto destrava TODOS os arquivos ===');
  j.disparar('pointerdown');
  await new Promise(r => setTimeout(r, 20));
  const porArquivo = {};
  for (const a of j.audios) porArquivo[a.src.split('/').pop()] = a;
  for (const nome of ['mensagem.mp3', 'venda.mp3', 'confirmado.mp3', 'chamada.mp3']) {
    ok(porArquivo[nome] && porArquivo[nome]._liberado === true, `${nome} liberado`);
  }
  ok(porArquivo['chamada.mp3'] && porArquivo['chamada.mp3'].tentativas.some(t => t.mudo),
     'o toque da LIGAÇÃO entra no destrave — é o que mais precisa, porque chega sem gesto nenhum');
  ok(j.ctx.state === 'running', 'e o AudioContext do tom sintetizado religou junto');
  ok(porArquivo['mensagem.mp3'].muted === false && porArquivo['mensagem.mp3'].volume === 0.7,
     'o destrave devolve o volume: liberar não pode deixar o som mudo depois');

  console.log('\n=== 4. Agora o aviso toca ===');
  const antes = som.tentativas.length;
  EC.playSound('message');
  await new Promise(r => setTimeout(r, 20));
  ok(som.tentativas.length === antes + 1 && som.tentativas[antes].permitido,
     'o play foi aceito');
  ok(som.paused === false, 'e o som está rodando');

  console.log('\n=== 5. A ligação toca ===');
  const toque = porArquivo['chamada.mp3'];
  const antesT = toque.tentativas.length;
  EC.startRing();
  await new Promise(r => setTimeout(r, 20));
  ok(toque.tentativas.length === antesT + 1 && toque.tentativas[antesT].permitido,
     'o toque da chamada foi aceito');
  ok(toque.loop === true, 'e repete sozinho até alguém atender');
  EC.stopRing();
  ok(toque.paused === true && toque.currentTime === 0, 'parar volta o toque ao começo');

  console.log('\n=== 6. Voltando do segundo plano, o som não morre ===');
  // O destrave antigo removia o próprio ouvinte no primeiro clique. O iOS
  // suspende o áudio ao mandar o app para trás; sem rearmar, o painel que
  // passou a noite aberto acordava mudo até recarregar a página.
  j.ctx.state = 'suspended';                 // é o que o iOS faz
  j.doc.hidden = true;  j.dispararDoc('visibilitychange');
  j.doc.hidden = false; j.dispararDoc('visibilitychange');
  await new Promise(r => setTimeout(r, 20));
  ok(j.ctx.state === 'running', 'ao voltar para a frente, o áudio religa sozinho');
  const antes2 = som.tentativas.length;
  EC.playSound('message');
  await new Promise(r => setTimeout(r, 20));
  ok(som.tentativas.length === antes2 + 1 && som.tentativas[antes2].permitido,
     'e o aviso seguinte continua tocando');

  console.log('\n=== 7. O destrave velho, que só cuidava do tom, não voltou ===');
  const f = fonte;
  ok(!/var resume = function \(\) \{ ac\(\); window\.removeEventListener\('pointerdown', resume\); \};/.test(f),
     'o destrave de uma vez só saiu do código');
  ok(/function destravarUm/.test(f) && /a\.muted = true/.test(f),
     'e o novo libera cada <audio> tocando mudo, que é o único jeito no iPhone');

  await encerrar(null, falhas);
})();
