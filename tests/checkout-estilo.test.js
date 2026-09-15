// ============================================================================
// O CHECKOUT NO VOCABULÁRIO VISUAL DA STRIPE
//
// Não é cópia de cor nem de logo: é a gramática que a Stripe usa e que ficou
// sendo o que as pessoas reconhecem como "página de pagamento séria". Quatro
// decisões, e cada uma resolve um problema concreto:
//
//   RÓTULO EM FRASE, não em CAIXA ALTA espaçada. Caixa alta chama atenção para
//   o rótulo — a parte que ninguém precisa ler com cuidado — e cansa mais,
//   porque a palavra perde o desenho da mancha. O destaque tem de ir para o
//   CAMPO, que é onde a pessoa age.
//
//   ANEL DE FOCO. A borda trocando de cor é o único sinal de foco que existia,
//   e passa despercebido em quem preenche cartão olhando o teclado. O anel de
//   3px é visto pelo canto do olho. Ele usa o ACENTO DO LOJISTA, não azul
//   fixo: a marca dele continua sendo a marca dele.
//
//   RAIO DE 6px NO QUE SE CLICA, 8px NO CONTAINER. 4px num campo de 46px de
//   altura lê como quina viva.
//
//   TÍTULO COM PESO 600. Peso 400 em 22px não lê como título, lê como
//   parágrafo grande, e o olho não acha onde a seção começa.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const html = fs.readFileSync(R + 'public/pay.html', 'utf8');
  // só o <style>: o corpo da página tem textos que não são CSS
  const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));

  console.log('=== 1. Nenhuma CAIXA ALTA no checkout ===');
  ok(!/text-transform:\s*uppercase/.test(css),
     'nenhuma regra põe texto em caixa alta');
  ok(!/letter-spacing:\s*\.032em/.test(css),
     'nem o espaçamento entre letras que vinha com ela');
  // O CSS sumiu, mas o texto escrito em caixa alta no HTML continuaria
  // gritando — e aí o grito fica sem nem a desculpa do estilo.
  const corpo = html.slice(html.indexOf('</style>'));
  const gritos = [...corpo.matchAll(/>([A-ZÀ-Ú][A-ZÀ-Ú ]{4,})</g)].map(m => m[1].trim());
  ok(gritos.length === 0, 'e nenhum texto está escrito em caixa alta no HTML', gritos.join(' · '));

  console.log('\n=== 2. O anel de foco existe, e é do lojista ===');
  ok(/--anel:\s*color-mix\(in srgb, var\(--ac\) 25%, transparent\)/.test(css),
     'o anel é o acento do lojista a 25%, não um azul fixo');
  ok(/\.fld input:focus \{[^}]*box-shadow: 0 0 0 3px var\(--anel\)/.test(css),
     'o campo em foco ganha 3px de halo');
  ok(/\.fld select:focus \{[^}]*box-shadow: 0 0 0 3px var\(--anel\)/.test(css),
     'e o seletor também — um vocabulário só');
  ok(/\.fld input\.bad:focus \{[^}]*rgba\(255, 128, 128/.test(css),
     'campo com erro em foco mantém o vermelho: o anel não pode apagar o aviso');

  console.log('\n=== 3. Raios e tipografia ===');
  ok(/--r: 6px;/.test(css), 'raio de 6px no que se clica');
  ok(/--rc: 8px;/.test(css), 'e 8px no container');
  ok(/h2\.sect \{ font-size: 20px; font-weight: 600; line-height: 1\.3; letter-spacing: -\.02em/.test(css),
     'título com peso 600 e tracking negativo');
  ok(/\.fld label \{[^}]*font-size: 13px; font-weight: 500; letter-spacing: 0; color: var\(--ink\)/.test(css),
     'rótulo 13px, peso 500, em frase e na cor do texto — não no cinza apagado');
  ok(/\.btn \{[^}]*font-weight: 600/.test(css), 'botão com peso 600');

  console.log('\n=== 4. Campos com a profundidade certa ===');
  // A sombra de 1px é o que separa o campo do cartão sem precisar de borda
  // mais escura. Sem ela o campo "afunda" no fundo do container.
  ok(/--sombra-campo: 0 1px 1px rgba\(16, 24, 32, \.04\)/.test(css),
     'a sombra fina existe como token, não copiada em cada regra');
  ok(/\.fld input \{[^}]*box-shadow: var\(--sombra-campo\)/.test(css), 'e o campo a usa');
  ok(/\.fld input \{[^}]*background: var\(--painel\)/.test(css),
     'o campo é branco como o cartão, e não um cinza que o faz parecer desabilitado');
  ok(/font-size: 16px/.test(css.slice(css.indexOf('.fld input {'), css.indexOf('.fld input {') + 260)),
     '16px no campo — abaixo disso o iPhone dá zoom sozinho ao tocar');

  console.log('\n=== 5. O mesmo estado visual em todos os widgets ===');
  // "Isto está selecionado" tem de ser UM desenho na página inteira. Duas
  // linguagens para a mesma ideia fazem a pessoa reaprender a cada bloco.
  for (const [sel, oque] of [['\\.paytabs button\\.on', 'o meio de pagamento escolhido'],
                             ['\\.kind\\.on', 'crédito ou débito escolhido']]) {
    ok(new RegExp(sel + ' \\{[^}]*box-shadow: 0 0 0 3px var\\(--anel\\)').test(css),
       oque + ' usa o mesmo anel do campo em foco');
  }
  ok(!/\.paytabs button \{[^}]*text-transform/.test(css), 'e as abas não gritam');

  await encerrar(null, falhas);
})();
