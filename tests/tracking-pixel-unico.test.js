// ============================================================================
// UM PIXEL SÓ, VALENDO EM TODO LUGAR — E O PIXEL DA VITRINE
//
// O Koonfy tinha DOIS cadastros para a mesma coisa, e nenhum avisava que não
// cobria o outro:
//
//   · a tela PIXELS (`acc.pixels`) disparava só no LINK RASTREÁVEL;
//   · Tracking → Conexões (`acc.trk.connections`) disparava só no CHECKOUT.
//
// Quem cadastrava num lugar via o outro em silêncio, e a conclusão natural era
// "o tracking não funciona". Não era: era metade dele, no lugar errado.
//
// A união tem um perigo próprio, e é o que a metade de baixo destes testes
// guarda: a página do link já montava Meta, Google e TikTok por conta própria.
// Somando as duas leituras sem cuidado, o MESMO PageView passaria a ser
// contado duas vezes — e um relatório que conta dobrado é pior do que um que
// não conta nada, porque ninguém desconfia dele.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');
const path = require('path');

const ARQ = path.join(R, 'data', 'db.json');
const original = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
const devolver = () => { try { if (original) fs.writeFileSync(ARQ, original); } catch {} };
process.on('exit', devolver);
process.on('uncaughtException', e => { devolver(); console.error(e); process.exit(1); });

const db = require(R + 'src/db');
const tracking = require(R + 'src/tracking');

(async () => {
  db.load();
  const acc = db.newAccount({ name: 'Loja', email: 'trk@ex.com', pass: 'segredo123' });
  db.get().accounts.push(acc);
  db.save();

  console.log('=== 1. Cadastrado na tela PIXELS, vale no checkout ===');
  acc.pixels = [{ id: 'p1', type: 'meta', pixelId: '111', enabled: true, active: true }];
  tracking.ensure(acc).connections.meta_pixel = { enabled: false, id: '' };
  let tags = tracking.clientTags(acc, { event: 'InitiateCheckout' });
  ok(tags.includes("fbq('init',\"111\")"), 'o pixel da tela Pixels entra nas tags do checkout');
  ok(tags.includes('InitiateCheckout'), 'com o evento certo');

  console.log('\n=== 2. Cadastrado em CONEXÕES, continua valendo ===');
  acc.pixels = [];
  tracking.ensure(acc).connections.meta_pixel = { enabled: true, id: '222' };
  tags = tracking.clientTags(acc, { event: 'PageView' });
  ok(tags.includes("fbq('init',\"222\")"), 'o de Conexões entra igual');

  console.log('\n=== 3. Nos dois, CONEXÕES manda ===');
  // Precisa haver uma ordem, e a explícita ganha: Conexões é a tela onde o
  // token da CAPI mora junto, então é lá que a configuração completa vive.
  acc.pixels = [{ id: 'p1', type: 'meta', pixelId: '111', enabled: true, active: true }];
  tracking.ensure(acc).connections.meta_pixel = { enabled: true, id: '222' };
  tags = tracking.clientTags(acc, { event: 'PageView' });
  ok(tags.includes('"222"') && !tags.includes('"111"'),
     'um ID só sai — nunca os dois, que contariam a mesma visita duas vezes');

  console.log('\n=== 4. Pixel desligado não dispara ===');
  acc.pixels = [{ id: 'p1', type: 'meta', pixelId: '111', enabled: false, active: true }];
  tracking.ensure(acc).connections.meta_pixel = { enabled: false, id: '222' };
  ok(!tracking.clientTags(acc, {}).includes('fbq'), 'desligado dos dois lados, não sai nada');
  acc.pixels = [{ id: 'p1', type: 'meta', pixelId: '111', enabled: true, active: false }];
  ok(!tracking.clientTags(acc, {}).includes('fbq'), 'e `active:false` também vale como desligado');

  console.log('\n=== 5. `exceto` é o que impede a contagem dobrada ===');
  acc.pixels = [{ id: 'p1', type: 'meta', pixelId: '111', enabled: true, active: true }];
  tracking.ensure(acc).connections.meta_pixel = { enabled: false, id: '' };
  ok(tracking.clientTags(acc, { event: 'PageView' }).includes('fbq'), 'sem `exceto`, sai');
  ok(!tracking.clientTags(acc, { event: 'PageView', exceto: ['meta_pixel'] }).includes('fbq'),
     'com `exceto`, a rede é pulada — é assim que a página do link pede o resto sem repetir a Meta');

  const srv = fs.readFileSync(R + 'server.js', 'utf8');
  ok(/exceto: \['meta_pixel', 'google_ads', 'tiktok'\]/.test(srv),
     'e a página do link pede exatamente essas três de fora');
  ok(/const metas = idsDe\('meta', 'meta_pixel'\)/.test(srv),
     'montando-as ela mesma a partir das DUAS telas');
  ok(/\[\.\.\.new Set\(lista\.filter\(Boolean\)\)\]/.test(srv),
     'com `Set`, para o mesmo ID nos dois lugares disparar uma vez só');
  ok(/if \(!metas\.length && !gtags\.length && !ttks\.length && !tags\) return res\.redirect\(302, dest\);/.test(srv),
     'e sem pixel nenhum o link volta a redirecionar seco, sem página de espera');

  console.log('\n=== 6. ID com HTML não vira script na página pública ===');
  // O ID entra dentro de um `<script>` numa página aberta a qualquer um, e
  // `JSON.stringify` NÃO escapa `</script>`.
  acc.pixels = [{ id: 'p1', type: 'meta', pixelId: '111</script><script>alert(1)', enabled: true, active: true }];
  tracking.ensure(acc).connections.meta_pixel = { enabled: false, id: '' };
  const sujo = tracking.clientTags(acc, {});
  ok(!/<\/script><script>alert/.test(sujo), 'a tentativa de fechar a tag é filtrada');
  // O que sobra é o ID sem nada que possa fechar a tag: sinal, barra e
  // parêntese saem. Vira lixo (a Meta recusa), e lixo recusado é o resultado
  // certo — o errado seria script rodando na página do lojista.
  const soId = /fbq\('init',"([^"]*)"\)/.exec(sujo);
  ok(!!soId && !/[<>\/()]/.test(soId[1]),
     'e o que sobra não tem como sair do <script>', soId && soId[1]);

  console.log('\n=== 7. A VITRINE tem pixel próprio, da plataforma ===');
  // É o tráfego que traz CLIENTE para o Koonfy. Não existia: só dava para colar
  // script cru em `extraHead`, onde um erro de digitação derruba a página.
  ok(/const fb = idLimpo\(seo\.metaPixel\)/.test(srv), 'Meta Pixel da vitrine');
  ok(/const tt = idLimpo\(seo\.tiktokPixel\)/.test(srv), 'TikTok Pixel da vitrine');
  ok(/const gtm = idLimpo\(seo\.gtmId\)/.test(srv), 'e Google Tag Manager');
  ok(/const jsId = v => JSON\.stringify\(idLimpo\(v\)\)\.replace\(\/<\/g, '\\\\u003c'\)/.test(srv),
     'com o mesmo cuidado do ID, porque a vitrine também é página pública');

  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  ok(/metaPixel: str\('metaPixel', 40\)/.test(api) && /tiktokPixel: str\('tiktokPixel', 40\)/.test(api) && /gtmId: str\('gtmId', 40\)/.test(api),
     'o admin grava os três');
  const front = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(/id="seo-fb"/.test(front) && /id="seo-tt"/.test(front) && /id="seo-gtm"/.test(front),
     'e há campo para cada um na tela');
  ok(/metaPixel: \$\('#seo-fb'\)\.value/.test(front), 'que é enviado ao salvar');

  const i = db.get().accounts.findIndex(a => a.id === acc.id);
  if (i >= 0) db.get().accounts.splice(i, 1);
  db.save();
  devolver();
  await encerrar(null, falhas);
})();
