// O CARROSSEL NÃO PODE ALARGAR A PÁGINA.
//
// Este teste existe porque o mesmo defeito chegou ao cliente duas vezes, e as
// duas por um motivo que não aparece em nenhum outro teste: o trilho do
// carrossel tem CINCO slides de 100% de largura lado a lado. Se a janela não
// CONTIVER esse trilho, a página inteira fica cinco vezes mais larga — dá para
// arrastar a tela para o lado e o que aparece é o fundo, branco, porque a arte
// dos vizinhos está escondida.
//
// A armadilha é que existem duas formas de "esconder o vizinho" e elas parecem
// equivalentes:
//
//   overflow: hidden  → contém o LAYOUT. A página não cresce.
//   clip-path         → recorta só a PINTURA. A página cresce igual.
//
// Foi exatamente essa troca que causou o defeito: para deixar a peça 3D
// atravessar a borda do cartão, o `overflow` virou `clip-path` — e o desenho
// ficou certo enquanto a página passava a arrastar de lado.
//
// A solução que precisa continuar de pé: `overflow: hidden` com PADDING
// vertical (é dentro do padding que o recorte acontece, então a peça continua
// aparecendo fora do cartão) e MARGEM NEGATIVA do mesmo tamanho, que devolve o
// espaço para o carrossel não ficar mais alto do que precisa.
//
// É um teste de FOLHA DE ESTILO, e não de comportamento: ele lê o CSS. Não
// substitui olhar a tela — só impede que esta troca específica volte calada.
const fs = require('fs');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');

// A declaração de um seletor, sem depender de quebra de linha nem de ordem.
function blocoDe(seletor) {
  const i = css.indexOf(seletor + ' {');
  if (i < 0) return null;
  const fim = css.indexOf('}', i);
  return fim < 0 ? null : css.slice(i, fim + 1);
}

(async () => {
  console.log('=== 1. A janela do carrossel CONTÉM o trilho ===');
  const janela = blocoDe('.bnr-janela');
  ok(!!janela, 'a regra .bnr-janela existe');
  ok(janela && /overflow:\s*hidden/.test(janela),
     '`overflow: hidden` — sem ele o trilho de cinco slides alarga a página inteira');
  ok(janela && !/clip-path/.test(janela),
     'e NÃO por `clip-path`: ele recorta a pintura e deixa o layout crescer igual');

  console.log('\n=== 2. E a peça 3D continua atravessando a borda do cartão ===');
  // O recorte do `overflow` acontece no PADDING BOX. Sem o padding, a peça
  // volta a ser decepada — que foi o defeito que motivou o `clip-path`.
  const pad = janela && janela.match(/padding:\s*(\d+)px\s+0/);
  const mar = janela && janela.match(/margin:\s*-(\d+)px\s+0/);
  ok(!!pad, `padding vertical, que é a folga por onde a peça sai: ${pad ? pad[1] + 'px' : 'ausente'}`);
  ok(!!mar, `margem negativa, que devolve o espaço: ${mar ? '-' + mar[1] + 'px' : 'ausente'}`);
  ok(pad && mar && pad[1] === mar[1],
     `padding e margem do mesmo tamanho (${pad && pad[1]} = ${mar && mar[1]}), senão o carrossel muda de altura`);

  console.log('\n=== 3. A rede de segurança do celular ===');
  // Num app de tela cheia a página nunca deve rolar de lado. `.page` precisa
  // estar na regra além da raiz: ele rola na vertical, e um elemento com
  // `overflow-y: auto` ganha `overflow-x: auto` automaticamente — foi por isso
  // que o guarda só na raiz não pegou este arrasto.
  ok(/html,\s*body\s*\{\s*overflow-x:\s*clip/.test(css), 'a raiz não rola para o lado');
  ok(/\.page\s*\{\s*overflow-x:\s*clip/.test(css),
     '`.page` também — é ele que rola, e quem rolava de lado no defeito');

  await encerrar(null, falhas);
})();
