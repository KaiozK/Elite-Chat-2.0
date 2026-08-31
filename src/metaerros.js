// ============================================================================
// OS ERROS DA META, EM PORTUGUÊS
//
// A Graph API responde em inglês, e a frase dela é escrita para quem programa,
// não para quem usa: "Calling APIs cannot be enabled for this phone number",
// "Re-engagement message", "(#131047) Message failed to send". Isso chegava
// cru na tela do cliente — que lia uma frase em outro idioma, sobre um sistema
// que não é o nosso, e não tinha o que fazer com ela.
//
// Traduzir aqui, num lugar só, e não em cada tela: as mensagens da Meta
// aparecem no chat, nas campanhas, nas configurações e no diagnóstico, e uma
// tradução por tela vira quatro traduções que divergem.
//
// A REGRA DE CADA TEXTO: dizer o que aconteceu e o que fazer. Uma tradução
// literal do inglês continuaria sendo um beco sem saída, só que em português —
// por isso vários textos aqui são mais longos que o original.
//
// O ORIGINAL NUNCA SE PERDE: fica em `err.metaOriginal` e no log do Admin, que
// é onde alguém vai precisar dele para procurar na documentação.
// ============================================================================

// Pelo CÓDIGO, que é estável. A frase da Meta muda de redação sem aviso; o
// número não.
const POR_CODIGO = {
  // ---- sessão e permissão ----
  190: 'A conexão com a Meta expirou ou foi revogada. Reconecte o seu WhatsApp em Configurações.',
  102: 'A sessão com a Meta expirou. Reconecte o seu WhatsApp em Configurações.',
  10: 'O app não tem permissão para esta ação na Meta. Fale com o suporte.',
  200: 'O app não tem permissão para esta ação na Meta. Fale com o suporte.',
  803: 'O identificador enviado à Meta não existe ou não pertence a esta conta.',

  // ---- limites ----
  4: 'A Meta recebeu chamadas demais deste app agora há pouco. Espere alguns minutos e tente de novo.',
  80007: 'Você atingiu o limite de chamadas da API da Meta. Espere alguns minutos e tente de novo.',
  130429: 'Muitas mensagens em pouco tempo. A Meta pediu para desacelerar — o envio continua em instantes.',
  131056: 'Muitas mensagens seguidas para este mesmo contato. Espere um pouco antes de mandar outra.',
  131048: 'A Meta bloqueou o envio por qualidade: muitos clientes marcaram este número como spam. O limite volta ao normal conforme a qualidade melhora.',

  // ---- janela de 24h e entrega ----
  131047: 'Passaram-se mais de 24 horas desde a última mensagem do cliente. Fora dessa janela, só é possível enviar um MODELO aprovado.',
  131026: 'A mensagem não pôde ser entregue. O número pode não ter WhatsApp, ou o aparelho pode estar sem espaço.',
  131051: 'Este tipo de mensagem não é aceito pela Meta.',
  131052: 'A Meta não conseguiu baixar o arquivo. Confira se o link é público e abre direto no navegador.',
  131053: 'O arquivo não pôde ser enviado. Confira o formato e o tamanho.',

  // ---- modelos ----
  132000: 'O número de variáveis enviado não bate com o do modelo aprovado.',
  132001: 'Este modelo não existe nesta conta, ou o idioma escolhido não confere.',
  132005: 'O texto de uma variável passou do tamanho que o modelo aceita.',
  132007: 'O conteúdo enviado viola a política de modelos da Meta.',
  132012: 'O formato de uma variável não é o que o modelo espera.',
  132015: 'Este modelo está pausado pela Meta por baixa qualidade e não pode ser usado agora.',
  132016: 'Este modelo foi desabilitado pela Meta por qualidade e não pode mais ser usado.',
  132068: 'O fluxo (Flow) usado neste modelo está bloqueado.',
  132069: 'O fluxo (Flow) usado neste modelo foi despublicado.',

  // ---- registro do número ----
  133000: 'A remoção do número anterior não terminou. Espere alguns minutos e tente registrar de novo.',
  133004: 'O serviço da Meta está indisponível agora. Tente de novo em alguns minutos.',
  133005: 'O PIN de verificação em duas etapas não confere com o deste número.',
  133006: 'O número precisa ser verificado antes de registrar na Cloud API.',
  133008: 'Muitas tentativas de PIN erradas. A Meta bloqueou temporariamente — espere para tentar de novo.',
  133009: 'PIN pedido cedo demais. Espere um pouco antes de tentar de novo.',
  133010: 'Este número ainda não foi registrado na Cloud API.',
  133015: 'Este número está sendo apagado na Meta. Espere a operação terminar.',

  // ---- conta ----
  131031: 'A conta da Meta foi bloqueada. É preciso resolver diretamente com a Meta, no Gerenciador de Negócios.',
  368: 'A conta foi temporariamente bloqueada por violar as políticas da Meta.',
  131042: 'Há uma pendência de pagamento na conta da Meta. Regularize no Gerenciador de Negócios para voltar a enviar.',

  // ---- ligações ----
  2593145: 'A Meta não liberou ligações para este número. Isso não é uma limitação do Koonfy — a mesma recusa acontece no painel da própria Meta.',
  2593146: 'As ligações não estão habilitadas neste número.',
  2593147: 'Esta ligação não existe mais ou já foi encerrada.',
  2593148: 'A ligação expirou antes de ser atendida.'
};

// Rede de segurança para quando o código não vem, mas a frase é conhecida.
const POR_TEXTO = [
  [/calling apis cannot be enabled/i, POR_CODIGO[2593145]],
  [/re-?engagement message/i, POR_CODIGO[131047]],
  [/already.*been registered|already registered/i, 'Este número já está registrado na Cloud API.'],
  [/two.?step verification pin mismatch/i, POR_CODIGO[133005]],
  [/invalid oauth|session has expired|access token/i, POR_CODIGO[190]],
  [/rate limit|too many calls/i, POR_CODIGO[4]],
  [/unsupported post request|does not exist/i, 'O endereço chamado na Meta não existe ou não pertence a esta conta.'],
  [/permission/i, 'O app não tem permissão para esta ação na Meta. Fale com o suporte.']
];

// O QUE A META ESCREVEU PARA O USUÁRIO FINAL. Quando existe, `error_user_msg`
// costuma ser melhor que a mensagem técnica — mas vem em inglês, então só é
// usado quando não temos tradução própria.
function traduzir(erroMeta) {
  const e = erroMeta || {};
  const cod = Number(e.code || 0);
  const sub = Number(e.error_subcode || 0);
  const texto = String(e.message || '');

  if (POR_CODIGO[sub]) return POR_CODIGO[sub];
  if (POR_CODIGO[cod]) return POR_CODIGO[cod];
  for (const [re, pt] of POR_TEXTO) if (re.test(texto)) return pt;
  return '';
}

// A mensagem final que vai para a tela. Sem tradução, devolve o original — é
// melhor uma frase em inglês do que nenhuma pista.
function mensagem(erroMeta, padrao) {
  return traduzir(erroMeta) || String((erroMeta && erroMeta.message) || padrao || '').trim();
}

module.exports = { traduzir, mensagem, POR_CODIGO };
