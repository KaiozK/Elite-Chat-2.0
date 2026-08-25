// O BANNER NO CELULAR, E O QUE NÃO É PARA ESTAR LÁ.
//
// Três decisões que já foram tomadas ao contrário uma vez cada, e que somem
// calado se alguém mexer sem saber o porquê:
//
// 1. A PEÇA FLUTUA NO CELULAR TAMBÉM. Eu tinha parado a animação achando que,
//    sem borda para atravessar, ela viraria tremor. Não vira — o que dá vida ao
//    objeto é ele não estar preso ao cartão. E a armadilha técnica: a centragem
//    vertical é `transform: translateY(-50%)` e a animação usa `translate`, que
//    é OUTRA propriedade e se compõe com ela. Animar `transform` apagaria a
//    centragem e jogaria a peça para o rodapé do cartão.
//
// 2. SÓ O SLIDE QUE VAI APARECER BAIXA. São cinco banners, 282 KB de imagem, e
//    a dashboard mostra UM. `loading="lazy"` não resolve: os slides estão todos
//    dentro da faixa visível (o trilho é deslocado por transform, e isso não os
//    tira do campo que o navegador considera "perto"), então os dez arquivos
//    vinham juntos na primeira pintura.
//
// 3. O FUNIL NÃO EXISTE NO CELULAR. É um quadro que se opera ARRASTANDO o
//    cartão de uma etapa para a outra — e arrastar de lado num aparelho é o
//    gesto de rolar a tela.
//
// É um teste de ARQUIVO: lê o CSS e o JS. Não substitui olhar a tela; impede
// que estas três voltem atrás sem ninguém perceber.
const fs = require('fs');
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const css = fs.readFileSync(R + 'public/app/style.css', 'utf8');
const js = fs.readFileSync(R + 'public/app/app.js', 'utf8');

// O bloco `.bnr-3d` de dentro do @media do celular — é lá que as regras da
// peça no aparelho vivem, e é ele que precisa ser lido, não o do computador.
//
// A âncora é `--bnr-folga: 0px`, que só existe nesse bloco. Ancorar no
// `@media (max-width: 620px)` não serve: a folha tem vários, e o primeiro deles
// vem MUITO antes — a fatia caía no `.bnr-3d` do computador e o teste passava a
// medir a regra errada (foi o que aconteceu na primeira versão deste arquivo).
const celular = css.slice(css.indexOf('--bnr-folga: 0px'));
const peca = celular.slice(celular.indexOf('.bnr-3d {'), celular.indexOf('.bnr-3d.mini'));

console.log('=== 1. A peça flutua no celular, no lugar do celular ===');
ok(/animation:\s*bnrFlutua/.test(peca), 'a animação do computador vale aqui também');
ok(!/animation:\s*none/.test(peca), 'e não há um `animation: none` desfazendo isso');
// O LUGAR não muda: é o que separa "mesma animação" de "mesmo banner".
ok(/top:\s*50%/.test(peca) && /transform:\s*translateY\(-50%\)/.test(peca),
   'a peça continua centrada na vertical, ao lado do texto');
ok(/right:\s*10px/.test(peca), 'e continua encostada na direita, dentro do cartão');
// A prova de que as duas coisas convivem: a animação move `translate`, e a
// centragem mora em `transform`. Se a animação passasse a mexer em transform,
// a peça perderia o -50% e cairia meia altura.
const quadros = css.slice(css.indexOf('@keyframes bnrFlutua'), css.indexOf('@keyframes bnrFlutua') + 200);
ok(/translate:\s*0/.test(quadros) && !/transform:/.test(quadros),
   'a animação mexe em `translate`, e não em `transform` — é o que preserva a centragem');

console.log('\n=== 2. A dashboard não baixa cinco banners para mostrar um ===');
ok(/data-src="\/assets\/banner-bg-/.test(js), 'o fundo dos slides seguintes fica em data-src');
ok(/data-src="\/assets\/banner-\$\{b\.peca\}\.webp"/.test(js), 'a peça também');
ok(/\$\{i \? '' : `src="\/assets\/banner-bg-/.test(js),
   'e só o primeiro slide nasce com src de verdade');
ok(/function bnrCarregar\(/.test(js), 'existe quem troque data-src por src na hora de mostrar');
ok(/bnrCarregar\(bnrAtual \+ 1\)/.test(js),
   'e o PRÓXIMO carrega junto — a troca é automática, um slide vazio apareceria na frente da pessoa');

console.log('\n=== 3. Toda arte de banner é WebP ===');
// PNG num banner de dashboard é peso puro: são fotos de fundo e renders com
// transparência, os dois casos em que o WebP ganha de longe.
const artes = fs.readdirSync(R + 'public/assets').filter(f => /^banner-/.test(f));
ok(artes.length > 0, `há ${artes.length} arquivos de banner`);
const forasteiros = artes.filter(f => !/\.webp$/.test(f));
ok(forasteiros.length === 0, `nenhum fora do WebP${forasteiros.length ? ': ' + forasteiros.join(', ') : ''}`);
// E o código não pode pedir outra coisa: um src escrito à mão em .png passaria
// pela varredura de arquivos acima sem aparecer.
ok(!/\/assets\/banner-[\w-]*\.(png|jpg|jpeg)/.test(js), 'e nenhum src de banner aponta para PNG ou JPG');

console.log('\n=== 4. O funil não existe no celular ===');
const lista = js.slice(js.indexOf('const MOBILE_VIEWS'), js.indexOf('const MOBILE_MQ'));
ok(!/'funnel'/.test(lista), 'fora da lista de telas do celular — some do menu, da barra e dos atalhos');
ok(/isMobileLayout\(\) && pedida === 'funnel'/.test(js),
   'e nem por link direto: o endereço fica em favorito de quem já usou no computador');
// O contrário também precisa valer, senão a correção virou uma remoção.
ok(/'funnel'/.test(js.slice(js.indexOf('const views = {'), js.indexOf('const views = {') + 1200)) ||
   /funnel: renderFunnel/.test(js), 'no computador ele continua existindo');

console.log('\n=== 5. O contador de não lidas fica NA LINHA da conversa ===');
// Uma regra de menu vazou para a lista de conversas. Na sidebar encolhida
// (≤960px, que pega celular E tablet) o contador precisa subir para o canto do
// ícone, então a regra é `position: absolute; margin: 0`. Só que ela estava
// escrita como `.badge` SOLTO — e a lista de conversas usa a mesma classe.
//
// O estrago: o `absolute` procurava um ancestral posicionado, achava o
// `.inbox`, e as não lidas de TODAS as conversas iam para o mesmo ponto,
// empilhadas no topo à direita, em cima do botão "+ Nova". O `margin: 0` ainda
// matava o `margin-left: auto`, que é o que encosta o contador na direita.
//
// Medido antes: cinco contadores, todos em y=64, com as linhas em y=191, 256,
// 320… Nenhum estava na sua conversa.
const menu960 = css.slice(css.indexOf('@media (max-width: 960px)'));
const bloco = menu960.slice(0, menu960.indexOf('}', menu960.indexOf('.page {')));
ok(/\.nav-item \.badge \{[^}]*position: absolute/.test(bloco),
   'a regra do canto do ícone tem dono: vale para o item do MENU');
ok(!/^\s*\.badge \{/m.test(bloco),
   'e não existe mais um `.badge` solto ali para vazar na lista de conversas');
// O que faz o contador encostar na direita da linha, no computador e no celular.
ok(/\.conv-meta \.prev \.badge \{ margin-left: auto/.test(css),
   'na conversa quem posiciona é o `margin-left: auto`, e ele precisa sobreviver');

encerrar(null, falhas);
