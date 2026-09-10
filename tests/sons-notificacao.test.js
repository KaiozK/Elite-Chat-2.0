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
    osc: 0,
    createOscillator() { ctx.osc++; return { type: '', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; },
    createGain: () => ({ gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }),
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
    Notification: { permission: 'denied', requestPermission: () => Promise.resolve('denied') },
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

  console.log('\n=== 6. A chamada toca UMA vez, não duas ===');
  // `startRing()` e `notify({type:'call'})` são chamados um atrás do outro
  // quando o cliente liga — e os DOIS mexem no mesmo <audio>. Sem `silent`, o
  // notify dava um segundo play() no elemento que tinha acabado de começar: o
  // toque reiniciava do zero e engasgava logo na primeira nota.
  const toque2 = porArquivo['chamada.mp3'];
  const antesD = toque2.tentativas.length;
  EC.startRing();
  EC.notify({ type: 'call', silent: true, title: 'Chamada de voz', body: 'alguém está te ligando' });
  await new Promise(r => setTimeout(r, 20));
  ok(toque2.tentativas.length === antesD + 1,
     'um play só, mesmo com o aviso saindo junto', 'plays: ' + (toque2.tentativas.length - antesD));
  EC.stopRing();
  const app = require('fs').readFileSync(R + 'public/app/app.js', 'utf8');
  const bloco = app.slice(app.indexOf('function onCallEvent'), app.indexOf('function onCallEvent') + 1400);
  ok(/type: 'call', silent: true/.test(bloco),
     'e a chamada de entrada marca o aviso como silencioso, porque o toque é do startRing');

  console.log('\n=== 7. TODO som do produto: arquivo, tom próprio e interruptor ===');
  // Sete sons, cada um disparado num lugar do produto. Duas armadilhas moram
  // aqui: um tipo SEM tom próprio cai no tom de MENSAGEM quando o MP3 falha —
  // e a pessoa olha o celular achando que um cliente escreveu; e um tipo fora
  // das preferências é um som que o cliente não consegue desligar.
  const SONS = ['message', 'call', 'attendance', 'reminder', 'sale', 'commission', 'confirm'];
  const blocoSons = fonte.slice(fonte.indexOf('var SOUNDS = {'), fonte.indexOf('/* ---------------- Sons em arquivo'));
  const telaApp = require('fs').readFileSync(R + 'public/app/app.js', 'utf8');
  const prefs = EC.getPrefs();
  for (const t of SONS) {
    ok(new RegExp('\\n\\s*' + t + ':\\s*function').test(blocoSons),
       `${t}: tem tom próprio — sem ele, o MP3 falhando vira som de mensagem`);
    ok(Object.prototype.hasOwnProperty.call(prefs.types, t) && new RegExp("types\\." + t + "'").test(telaApp),
       `${t}: o cliente consegue desligar, na tela de preferências`);
  }

  // Cada TIPO tem o SEU <audio>, mesmo quando dois tipos usam o mesmo arquivo.
  // venda.mp3 serve venda E comissão: desligar uma não pode calar a outra.
  const doTipo = {};
  for (const t of SONS) {
    const n0 = j.audios.map(a => a.tentativas.length);
    EC.playSound(t);
    const i = j.audios.findIndex((a, k) => a.tentativas.length > n0[k]);
    if (i >= 0) doTipo[t] = j.audios[i];
  }
  await new Promise(r => setTimeout(r, 20));
  ok(doTipo.sale && doTipo.commission && doTipo.sale !== doTipo.commission,
     'venda e comissão usam o mesmo arquivo, mas elementos separados');
  EC.setPref('types.sale', false);
  const vs = doTipo.sale.tentativas.length, vc = doTipo.commission.tentativas.length;
  EC.notify({ type: 'sale', title: 'venda' });
  EC.notify({ type: 'commission', title: 'comissão' });
  await new Promise(r => setTimeout(r, 20));
  ok(doTipo.sale.tentativas.length === vs, 'desligar "venda" cala a venda');
  ok(doTipo.commission.tentativas.length > vc, 'e a comissão continua tocando');
  EC.setPref('types.sale', true);

  // O interruptor geral cala TUDO, inclusive o toque da ligação.
  EC.setPref('sounds', false);
  const g0 = doTipo.message.tentativas.length, gr = doTipo.call.tentativas.length;
  EC.playSound('message'); EC.startRing();
  await new Promise(r => setTimeout(r, 20));
  ok(doTipo.message.tentativas.length === g0 && doTipo.call.tentativas.length === gr,
     'e o interruptor geral cala tudo, inclusive o toque da chamada');
  EC.stopRing(); EC.setPref('sounds', true);

  console.log('\n=== 8. O IPHONE TEIMOSO: <audio> bloqueado, som mesmo assim ===');
  // Até 25/08 o aviso era só tom sintetizado, pelo AudioContext — e funcionava
  // em TODO aparelho, porque um contexto religado toca o que for, a qualquer
  // hora. Aí os MP3 entraram e viraram o caminho principal; <audio> é mídia, e
  // no iPhone cada elemento precisa ter tocado dentro de um gesto ou fica
  // bloqueado. Agora os mesmos MP3 saem PELO CONTEXTO: um destrave cobre tudo.
  {
    const k = montarJanela();
    // Web Audio completo...
    k.ctx.decodeAudioData = (d, ok) => { const b = { fake: true }; if (ok) ok(b); return Promise.resolve(b); };
    k.ctx.fontes = 0; k.ctx.emLaco = 0;
    k.ctx.createBufferSource = () => { k.ctx.fontes++; const o = { buffer: null, loop: false,
      connect() {}, start() { if (o.loop) k.ctx.emLaco++; }, stop() { if (o.loop) k.ctx.emLaco--; } }; return o; };
    k.win.fetch = () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    // ...e <audio> recusado SEMPRE, como no iPhone
    k.FakeAudio.prototype.play = function () {
      this.tentativas.push({ mudo: this.muted, permitido: false });
      return Promise.reject(Object.assign(new Error('bloqueado'), { name: 'NotAllowedError' }));
    };
    vm.createContext(k.win);
    vm.runInContext(fonte, k.win);
    const E2 = k.win.ECNotify; E2.init({});
    k.disparar('pointerdown');
    await new Promise(r => setTimeout(r, 80));
    for (const t of ['message', 'sale', 'commission', 'confirm', 'call']) {
      k.ctx.fontes = 0;
      E2.playSound(t);
      await new Promise(r => setTimeout(r, 30));
      ok(k.ctx.fontes > 0, `${t}: sai pelo AudioContext, com o <audio> bloqueado`);
    }
    k.ctx.fontes = 0; k.ctx.emLaco = 0;
    E2.startRing();
    await new Promise(r => setTimeout(r, 30));
    ok(k.ctx.emLaco === 1, 'e o TOQUE da ligação também, em laço');
    E2.stopRing();
    ok(k.ctx.emLaco === 0, 'parando quando alguém atende');
  }

  console.log('\n=== 9. A ligação não começa MUDA ===');
  // `bater()` roda logo depois do play(). A recusa do <audio> chega só na
  // microtarefa seguinte, então `toque.audio` ainda estava preenchido e o
  // sintetizado esperava o ciclo: 2,2 SEGUNDOS de silêncio no começo de uma
  // chamada — onde o som mais importa.
  {
    const k = montarJanela();
    k.FakeAudio.prototype.play = function () {
      this.tentativas.push({ mudo: this.muted, permitido: false });
      return Promise.reject(Object.assign(new Error('bloqueado'), { name: 'NotAllowedError' }));
    };
    vm.createContext(k.win);
    vm.runInContext(fonte, k.win);
    const E3 = k.win.ECNotify; E3.init({});
    k.disparar('pointerdown');
    await new Promise(r => setTimeout(r, 60));
    k.ctx.osc = 0;
    E3.startRing();
    await new Promise(r => setTimeout(r, 150));   // o "primeiro instante"
    ok(k.ctx.osc > 0, 'sem arquivo e sem Web Audio, o tom entra NA HORA', k.ctx.osc + ' notas em 150 ms');
    E3.stopRing();
  }

  console.log('\n=== 10. Voltando do segundo plano, o som não morre ===');
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

  console.log('\n=== 11. O destrave velho, que só cuidava do tom, não voltou ===');
  const f = fonte;
  ok(!/var resume = function \(\) \{ ac\(\); window\.removeEventListener\('pointerdown', resume\); \};/.test(f),
     'o destrave de uma vez só saiu do código');
  ok(/function destravarUm/.test(f) && /a\.muted = true/.test(f),
     'e o novo libera cada <audio> tocando mudo, que é o único jeito no iPhone');

  await encerrar(null, falhas);
})();
