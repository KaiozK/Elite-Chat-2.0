// ============================================================================
// ONDE O MENU DO SELETOR ABRE — E A ORDEM DO CHECKOUT NO CELULAR
//
// O SELETOR. `position: fixed` NÃO se mede pela janela quando existe um
// ancestral com `transform`, `filter`, `perspective`, `backdrop-filter`,
// `will-change` ou `contain`: esse ancestral vira o bloco de contenção, e as
// coordenadas passam a contar a partir dele. E no painel isso vale SEMPRE,
// porque `#view > .page` entra com `animation: fadeUp .3s both` — o `both`
// deixa o `transform` do último quadro grudado para sempre
// (`matrix(1,0,0,1,0,0)`, que não é `none`).
//
// Como a `.page` também rola, o menu nascia deslocado pelo tanto que a pessoa
// já tinha rolado: no começo da tela parecia certo, e ia piorando conforme ela
// descia — até abrir fora da tela. Da bancada, "o select não abre". Valia para
// TODO seletor do painel, não só para o de testers.
//
// Estes testes guardam as duas metades da correção, porque cada uma sozinha
// não resolve: traduzir pela posição do bloco E somar a rolagem dele.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
  const pay = fs.readFileSync(R + 'public/pay.html', 'utf8');

  console.log('=== 1. A armadilha existe mesmo: a página tem transform ===');
  ok(/#view > \.page, #view > \.inbox \{ animation: fadeUp [^;]*both; \}/.test(css),
     'a página entra com `both`, e o `both` é o que deixa o transform grudado');
  ok(/@keyframes fadeUp \{ from \{ opacity: 0; transform: translateY\(\d+px\); \} \}/.test(css),
     'e o quadro inicial move — logo, o computado final é uma matriz, e não `none`');
  ok(/\.page \{ [^}]*overflow-y: auto/.test(css),
     'a mesma página rola: por isso não basta traduzir a posição, tem de somar a rolagem');

  console.log('\n=== 2. O seletor sabe disso ===');
  ok(/function blocoDeContencao\(el\)/.test(js), 'existe quem ache o bloco de contenção');
  const bc = js.slice(js.indexOf('function blocoDeContencao'), js.indexOf('function ecSelSoltar'));
  for (const prop of ['transform', 'perspective', 'filter', 'backdropFilter', 'willChange']) {
    ok(bc.includes(prop), `olha ${prop}`);
  }
  ok(/paint\|layout\|strict\|content/.test(bc), 'e `contain`, que faz o mesmo');

  const sol = js.slice(js.indexOf('function ecSelSoltar'), js.indexOf('function ecSelPrender'));
  ok(/topo \+= cb\.scrollTop - rc\.top/.test(sol),
     'traduz pela posição do bloco E soma a rolagem dele');
  ok(/esq \+= cb\.scrollLeft - rc\.left/.test(sol), 'o mesmo na horizontal');

  console.log('\n=== 3. Sempre por `top`, nunca por `bottom` ===');
  // Com um bloco de contenção no caminho, `bottom` contaria a partir da borda
  // DELE — que não é a borda da janela. Medir só por `top` tira essa dúvida.
  ok(/menu\.style\.bottom = 'auto';/.test(sol) && !/menu\.style\.bottom = \(/.test(sol),
     'o menu nunca é ancorado pela base');
  ok(/topo = Math\.max\(8, Math\.min\(topo, window\.innerHeight - alturaMenu - 8\)\)/.test(sol),
     'e é preso dentro da janela, para não nascer meio fora');
  ok(/menu\.offsetHeight \|\| menu\.scrollHeight \+ 12/.test(sol),
     'a altura é medida, e não estimada — o palpite errava por 12px no menu que abre para cima');

  console.log('\n=== 4. Rolar com o menu aberto fecha ===');
  ok(/document\.addEventListener\('scroll'[\s\S]{0,260}\}, true\);/.test(js),
     'em CAPTURA: quem rola é a `.page`, e scroll de container não sobe por bolha');

  console.log('\n=== 5. O formulário de tester é uma grade de verdade ===');
  ok(/<div class="tst-form">/.test(js), 'as duas colunas são uma grade');
  ok(/\.tst-form \{ display: grid; grid-template-columns: 1fr 1fr;/.test(css),
     'com colunas iguais — os pesos por linha faziam cada linha quebrar num ponto');
  ok(/@media \(max-width: 760px\) \{ \.tst-form \{ grid-template-columns: 1fr; \} \}/.test(css),
     'e uma coluna só no celular');
  ok(!/<label style="flex:1\.2">Nome completo de quem vai testar/.test(js),
     'nenhum peso solto sobrou na linha do nome');

  console.log('\n=== 6. No celular, pagar vem ANTES dos componentes ===');
  // O cliente abriu o link para PAGAR. Descer por cronômetro, aviso, vantagens,
  // depoimento, garantia e FAQ antes de achar o botão é fazê-lo reler o que já
  // o convenceu.
  const mob = pay.slice(pay.indexOf('@media (max-width: 860px)'));
  ok(/\.stack \{ display: contents; \}/.test(mob),
     'a pilha deixa de ser uma caixa: seus cartões viram itens da mesma grade do resumo');
  ok(/\.summary \{ order: 2; \}/.test(mob) && /\.blk-opt \{ order: 3; \}/.test(mob),
     'o resumo com o botão sobe, e os componentes descem');
  ok((pay.match(/class="card blk-opt"/g) || []).length === 6,
     'os seis componentes estão marcados', (pay.match(/class="card blk-opt"/g) || []).length + '');
  ok(!/\.stack \{ display: contents; \}/.test(pay.slice(0, pay.indexOf('@media (max-width: 860px)'))),
     'e no computador nada muda: lá são duas colunas, tudo à vista ao mesmo tempo');

  await encerrar(null, falhas);
})();
