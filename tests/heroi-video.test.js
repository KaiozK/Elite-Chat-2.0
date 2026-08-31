// ============================================================================
// O UNIVERSO EM VÍDEO, NO HERÓI DA VITRINE
//
// Um fundo em vídeo tem três formas conhecidas de dar errado, e todas aparecem
// só depois de publicado:
//
//   · A EMENDA DO LOOP. `loop` sozinho não esconde o corte: se o último quadro
//     não for o primeiro, o salto se vê a cada volta. Por isso o vídeo foi
//     gerado com o MESMO quadro como início e fim.
//   · O PESO. São 3 MB. Num celular no 4G é o preço da primeira visita gasto
//     num enfeite, antes de a pessoa saber o que a Koonfy faz.
//   · A LEGIBILIDADE. Um ponto brilhante passando atrás de uma letra branca
//     some com a letra por um segundo, e ninguém testa o quadro 137.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const html = fs.readFileSync(R + 'public/nova.html', 'utf8');

(async () => {
  console.log('=== 1. Os arquivos estão no lugar ===');
  const mp4 = R + 'public/assets/heroi-universo.mp4';
  const webp = R + 'public/assets/heroi-universo.webp';
  ok(fs.existsSync(mp4), 'o vídeo do universo existe');
  ok(fs.existsSync(webp), 'e o pôster também');
  const kbVideo = Math.round(fs.statSync(mp4).size / 1024);
  const kbPoster = Math.round(fs.statSync(webp).size / 1024);
  console.log('         vídeo ' + kbVideo + ' KB · pôster ' + kbPoster + ' KB');
  // O PÔSTER precisa ser leve de verdade: é ele que atende quem não recebe o
  // vídeo, e um pôster pesado transformaria a economia em nada.
  ok(kbPoster < 140, `o pôster é leve: ${kbPoster} KB`);

  console.log('\n=== 2. Toca sozinho, em silêncio, e não para ===');
  const tag = html.slice(html.indexOf('<video class="heroi-video"'), html.indexOf('<video class="heroi-video"') + 400);
  ok(/autoplay/.test(tag), 'autoplay: começa sozinho');
  // `muted` NÃO é estética: navegador nenhum toca vídeo com som sem interação,
  // e sem ele o fundo ficaria congelado no primeiro quadro.
  ok(/muted/.test(tag), 'muted: é o que PERMITE o autoplay');
  ok(/\bloop\b/.test(tag), 'loop: não para no fim');
  // Sem isto o iPhone abre o vídeo em tela cheia em vez de deixá-lo no fundo.
  ok(/playsinline/.test(tag), 'playsinline: no iPhone continua sendo fundo');
  ok(/poster="\/assets\/heroi-universo\.webp"/.test(tag),
     'com o pôster do MESMO quadro — enquanto carrega, já é o universo');
  ok(/aria-hidden="true"/.test(tag) && /tabindex="-1"/.test(tag),
     'e invisível para leitor de tela e para o Tab: é decoração, não conteúdo');

  console.log('\n=== 3. Baixa depois da página, e toca no celular também ===');
  // Com <source> no HTML o navegador começa a baixar DURANTE o carregamento,
  // competindo com o texto e a marca. Em data-src, ele só entra depois que a
  // página está de pé.
  ok(/preload="none"/.test(tag), 'preload="none": não baixa junto com a página');
  ok(/data-src="\/assets\/heroi-universo\.mp4"/.test(tag),
     'o endereço fica em data-src');
  ok(!/<source/.test(tag), 'e não há <source>, que baixaria de todo jeito');

  const script = html.slice(html.indexOf('O UNIVERSO EM VÍDEO'), html.indexOf('O UNIVERSO EM VÍDEO') + 1600);
  // O CELULAR RECEBE O VÍDEO. Cortei antes por peso e reverti: a vitrine
  // vende, e metade das visitas chega pelo celular — um herói parado ali é o
  // primeiro contato de metade das pessoas.
  ok(!/max-width: 760px/.test(script), 'a tela estreita TAMBÉM recebe o vídeo');
  // Só "menos movimento" barra: é preferência declarada do sistema, e
  // insistir seria ignorá-la.
  ok(/prefers-reduced-motion/.test(script) && /if \(quieto\) return;/.test(script),
     'e só "menos movimento" barra');
  ok(/v\.src = v\.dataset\.src/.test(script), 'aí o endereço vira src');
  ok(/p\.catch\(function \(\) \{\}\)/.test(script),
     'um play() recusado é engolido: o pôster continua, e a tela não perde nada');

  // O PESO importa mais agora que o celular baixa: um herói de 5 MB é a
  // primeira visita inteira gasta antes de a pessoa ler a primeira linha.
  ok(kbVideo < 2600, `e o vídeo cabe num celular: ${kbVideo} KB`);

  console.log('\n=== 4. O texto continua legível por cima ===');
  ok(/\.heroi-veu\{/.test(html), 'existe um véu entre o vídeo e o texto');
  // Mais forte no MIOLO, onde o título vive; quase nada nas bordas, onde a rede
  // é o assunto. Um véu uniforme apagaria a arte para resolver o texto.
  ok(/radial-gradient\(ellipse 110% 86% at 50% 45%/.test(html),
     'mais forte no miolo, onde o título vive');
  // A SOMBRA NO TEXTO, e não mais véu. Medido no pior quadro: só com o véu, o
  // título ficava em contraste 1,99 — um ícone brilhante passando atrás de uma
  // letra a apaga por um instante, e ninguém revisa o quadro 137.
  //
  // Escurecer mais o véu resolveria o texto e apagaria o globo junto, que é
  // trocar um problema por outro. A sombra age SÓ onde há letra.
  ok(/\.heroi \.display,\.heroi \.corpo\{text-shadow:/.test(html),
     'e o texto do herói carrega a própria sombra');
  ok(/\.heroi \.wrap\{position:relative;z-index:2\}/.test(html),
     'e o conteúdo sobe acima do vídeo');
  ok(/\.heroi-video\{[^}]*z-index:0/.test(html), 'que fica no fundo de tudo');
  ok(/\.joia\{z-index:3\}/.test(html),
     'a joia sobe junto: ela mora fora do herói e o vídeo passaria por cima dela');

  console.log('\n=== 5. Movimento reduzido: a arte fica, parada ===');
  const bloco = html.slice(html.indexOf('@media (prefers-reduced-motion:reduce){\n  .heroi-video'));
  ok(/\.heroi-video\{display:none\}/.test(bloco.slice(0, 200)), 'o vídeo some');
  ok(/heroi-universo\.webp/.test(bloco.slice(0, 400)),
     'e o pôster vira o fundo — esconder tudo deixaria o herói preto e sem assunto');

  await encerrar(null, falhas);
})();
