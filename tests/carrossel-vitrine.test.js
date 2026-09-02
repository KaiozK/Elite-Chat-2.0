// ============================================================================
// O CARROSSEL DE RECURSOS DA VITRINE
//
// Ele é o único lugar da página que diz, uma a uma, o que a Koonfy faz. Três
// defeitos já apareceram nele, todos só no CELULAR e todos invisíveis no
// computador:
//
//   · NÃO GIRAVA. O rodízio estava atrás de um "menos movimento", e "Reduzir
//     movimento" (iOS) e a economia de bateria (Android) vêm ligados em muito
//     aparelho. Quem tinha isso ligado só via a primeira aba e nunca descobria
//     que existiam outras treze.
//   · CONGELAVA NO PRIMEIRO TOQUE. A roda parava com o ponteiro em cima. No
//     celular o dedo dispara `pointerenter` e o `pointerleave` nem sempre vem
//     depois, porque o elemento sai andando por baixo do dedo — a roda parava
//     para sempre.
//   · GIRAVA SEM DIZER DO QUE FALAVA. As 14 abas cabem na largura de um
//     computador; num celular a fileira tem ~340px de vista para ~1680px de
//     conteúdo. A tela trocava, mas a aba ativa ficava fora do campo de visão
//     e o NOME do recurso nunca aparecia — que é justamente o que o carrossel
//     existe para mostrar.
//
// Este arquivo lê a página em si (sem navegador): o que dá para verificar aqui
// é o contrato — as 14 funcionalidades alinhadas, nada barrando o giro, e o
// código que traz a aba ativa para a vista.
// ============================================================================
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const path = require('path');
// Caminho relativo ao próprio arquivo: o teste roda em qualquer máquina.
const R = path.join(__dirname, '..') + path.sep;
const html = fs.readFileSync(path.join(R, 'public', 'nova.html'), 'utf8');

const car = html.slice(html.indexOf('id="recursos-car"'), html.indexOf('</section>', html.indexOf('id="recursos-car"')));
const script = html.slice(html.indexOf('CARROSSEL DOS RECURSOS'), html.indexOf('CARROSSEL DOS RECURSOS') + 9500);
// Os comentários deste trecho EXPLICAM os defeitos antigos e por isso citam
// `pointerenter`, `parado` e `scrollIntoView` por escrito. Procurar essas
// palavras no texto cru acusaria a explicação como se fosse o defeito — o que
// só ensinaria a apagar o comentário. As checagens abaixo leem o CÓDIGO.
const codigo = script.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const pega = re => [...car.matchAll(re)].map(m => m[1]);

(async () => {
  console.log('=== 1. As 14 funcionalidades, alinhadas ===');
  // A ordem é a narrativa: atende → organiza a equipe → move no funil →
  // automatiza → delega para a IA → dispara → cobra → mede.
  const esperado = ['atendimento', 'equipe', 'funil', 'automacao', 'ia', 'campanhas',
    'sms', 'pagamentos', 'rastreamento', 'agenda', 'numeros', 'integracoes',
    'metricas', 'instalacao'];
  const abas = pega(/class="car-aba[^"]*" data-aba="([^"]+)"/g);
  const slides = pega(/class="car-slide[^"]*" data-slide="([^"]+)"/g);
  const pontos = pega(/class="car-passo[^"]*" data-ir="([^"]+)"/g);
  ok(JSON.stringify(abas) === JSON.stringify(esperado),
     `as ${esperado.length} funcionalidades têm aba, na ordem da narrativa`);
  // Uma aba sem slide abre o palco vazio; um slide sem aba nunca é alcançado.
  ok(JSON.stringify(slides) === JSON.stringify(esperado), 'cada aba tem o seu slide');
  ok(JSON.stringify(pontos) === JSON.stringify(esperado), 'e a sua bolinha');

  console.log('\n=== 2. Gira sozinho, em qualquer aparelho ===');
  ok(/function agendarProximo/.test(script) && /setTimeout\(function \(\)/.test(script),
     'existe o rodízio automático');
  // Eram estas duas linhas que deixavam o celular parado.
  ok(!/menosMovimento/.test(script), 'nada de "menos movimento" barra o giro');
  ok(!/pointerenter|pointerleave|mouseenter/.test(codigo),
     'e a roda não para por ponteiro — era o que congelava no primeiro toque');
  // Fora da tela ele para de propósito: ninguém está vendo, e a animação
  // seguiria gastando bateria.
  ok(/IntersectionObserver/.test(script), 'fora da vista ele descansa, e volta ao aparecer');

  console.log('\n=== 3. Clicar numa aba não mata o giro ===');
  ok(/clearTimeout\(relogio\);\s*\n\s*abrir\(b\.dataset\.aba \|\| b\.dataset\.ir\)/.test(script),
     'o clique leva para a aba e o rodízio continua dali');
  ok(!/parado/.test(codigo), 'e não há mais um estado "parado" de onde não se volta');

  console.log('\n=== 4. A fileira de abas acompanha (o buraco do celular) ===');
  ok(/var tiras = car\.querySelector\('\.car-abas'\)/.test(script),
     'a fileira de abas é conhecida pelo script');
  ok(/tiras\.scrollWidth > tiras\.clientWidth/.test(script),
     'e só é rolada quando de fato não cabe — no computador nada se mexe');
  ok(/tiras\.scrollTo\(\{ left: alvoX/.test(script),
     'a aba ativa é trazida para o centro da fileira a cada troca');
  // `scrollIntoView` arrastaria a PÁGINA junto, no meio da leitura da pessoa.
  ok(!/scrollIntoView/.test(codigo),
     'rolando só a fileira, nunca a página — senão a leitura é arrastada junto');

  console.log('\n=== 5. A fileira de credenciais anda quando não cabe ===');
  // São as seis credenciais que dizem que a Koonfy é oficial. No computador
  // cabem centralizadas e nada se mexe. No celular a fileira transbordava e
  // ficava PARADA no começo: "…usiness Partner" cortado na borda, e as outras
  // cinco só para quem pensasse em arrastar com o dedo.
  const faixa = html.slice(html.indexOf('FILEIRA DE LOGOS'), html.indexOf('FILEIRA DE LOGOS') + 1800);
  const nomes = [...faixa.matchAll(/<span>([^<]+)<\/span>/g)].map(m => m[1]);
  ok(nomes.length === 12, `a lista é escrita duas vezes (${nomes.length} nomes): é o que faz a volta sem emenda`);
  ok(JSON.stringify(nomes.slice(0, 6)) === JSON.stringify(nomes.slice(6)),
     'e as duas cópias são idênticas — se diferissem, a volta daria um salto');
  ok(/<div class="logos-grupo" aria-hidden="true">/.test(faixa),
     'a segunda cópia é muda para leitor de tela');
  const esteira = html.slice(html.indexOf('A FILEIRA DE CREDENCIAIS ANDA SOZINHA'),
                             html.indexOf('A FILEIRA DE CREDENCIAIS ANDA SOZINHA') + 2200);
  ok(/largura > fila\.clientWidth/.test(esteira),
     'a esteira liga por MEDIDA (não cabe), não por largura de tela chutada num @media');
  ok(/fila\.classList\.remove\('esteira'\)/.test(esteira),
     'e desliga se voltar a caber — virar o telefone de lado muda tudo');
  ok(/Math\.round\(largura \/ 40\)/.test(esteira),
     'velocidade constante em px/s: com tempo fixo ela ficaria lenta numa tela e correndo na outra');
  ok(/document\.fonts\.ready/.test(esteira),
     'a medida espera as fontes: elas mudam a largura do texto depois do primeiro desenho');
  // O espaçamento tem de existir MEDINDO e andando: sem isso os seis nomes
  // ficam colados, medem menos, e a conta diz "cabe" onde não cabe.
  ok(/\.logos-grupo\{[^}]*gap:clamp/.test(html),
     'o espaçamento vale sempre, não só com a esteira ligada — senão a medida mente');
  ok(/@keyframes logosAnda\{from\{transform:translate3d\(0,0,0\)\}to\{transform:translate3d\(-50%/.test(html),
     'e o trilho desliza exatamente metade, que é onde o quadro repete');

  await encerrar(null, falhas);
})();
