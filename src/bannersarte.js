// ===========================================================================
// AS ARTES DOS BANNERS
//
// Cada arte é um PAR: o fundo do cartão e a peça 3D que atravessa a borda.
// Elas não são um campo de texto livre no Admin de propósito — todas foram
// desenhadas com o mesmo princípio (escuro à esquerda, onde o texto vive; a
// luz à direita, onde a peça flutua). Um fundo qualquer colocado ali vira
// texto branco sobre área clara em algum ponto, e é sempre no ponto que
// ninguém testou.
//
// `pw`/`ph` são a proporção REAL do arquivo da peça, e servem para o
// navegador reservar o espaço antes de a imagem chegar — sem isso a peça
// nasce sem largura e pula quando carrega. Ficam aqui, e não no formulário,
// porque é um número que quem escreve a copy não tem como saber.
// ===========================================================================
const ARTES = [
  { id: 'integracoes', nome: 'Integrações (balão de conversa)', peca: 'balao', pw: 640, ph: 644 },
  { id: 'ligacao', nome: 'Ligação (telefone)', peca: 'ic-ligacao', pw: 560, ph: 677 },
  { id: 'indique', nome: 'Indique e ganhe (aperto de mão)', peca: 'ic-indique', pw: 560, ph: 594 },
  { id: 'vender', nome: 'Vender (joia da Koonfy)', peca: 'ic-vender', pw: 460, ph: 457 },
  { id: 'tracking', nome: 'Tracking (alvo)', peca: 'ic-tracking', pw: 560, ph: 588 }
];

function arte(id) { return ARTES.find(a => a.id === id) || ARTES[0]; }

// O banner como o painel do cliente precisa vê-lo: a copy escolhida no Admin
// mais os arquivos e as medidas da arte.
function paraOPainel(b) {
  const a = arte(b.arte);
  return {
    id: b.id, tag: b.tag, titulo: b.titulo, texto: b.texto,
    acao: b.acao, href: b.href,
    fundo: a.id, peca: a.peca, pw: a.pw, ph: a.ph
  };
}

module.exports = { ARTES, arte, paraOPainel };
