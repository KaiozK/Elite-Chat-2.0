// ============================================================================
// SEGMENTOS DE MERCADO
//
// O que a conta vende. Era um campo de texto livre ("consultoria, loja de
// roupas, curso") e servia só para o admin ler. Agora é uma LISTA FECHADA,
// porque uma escolha passou a mudar o produto: quem marca iGaming ganha o Modo
// Bet no Tracking.
//
// A lista mora aqui, e não no formulário, porque três lugares precisam dela e
// não podem discordar: a tela de cadastro (que mostra), a API (que valida) e o
// Tracking (que decide se liga o Modo Bet). Uma lista copiada em três arquivos
// vira três listas diferentes na primeira vez que alguém acrescenta um item.
//
// Texto livre antigo continua valendo: quem se cadastrou antes tem lá o que
// escreveu, e `ehIGaming` só olha a chave exata — ninguém vira apostas por
// acidente por ter escrito "casino" na descrição do negócio.
// ============================================================================

const LISTA = [
  { id: 'infoproduto', nome: 'Infoprodutos e cursos' },
  { id: 'ecommerce',   nome: 'E-commerce / loja' },
  { id: 'servicos',    nome: 'Serviços e consultoria' },
  { id: 'saude',       nome: 'Saúde, estética e bem-estar' },
  { id: 'educacao',    nome: 'Educação' },
  { id: 'imobiliario', nome: 'Imobiliário' },
  { id: 'financeiro',  nome: 'Financeiro e crédito' },
  { id: 'agencia',     nome: 'Agência e marketing' },
  { id: 'igaming',     nome: 'iGaming / apostas', pedeSite: true },
  { id: 'outro',       nome: 'Outro' }
];

const POR_ID = new Map(LISTA.map(s => [s.id, s]));

function valido(id) { return POR_ID.has(String(id || '')); }
function nome(id) { const s = POR_ID.get(String(id || '')); return s ? s.nome : String(id || ''); }

// Este segmento precisa informar o site da plataforma?
function pedeSite(id) { return !!(POR_ID.get(String(id || '')) || {}).pedeSite; }

// O SEGMENTO É iGAMING? Comparação EXATA de propósito: ver o comentário do topo
// sobre o texto livre antigo. Esta é a pergunta do CADASTRO — é ela que decide
// se o admin recebe o push para conferir o site.
function ehIGaming(acc) {
  return !!(acc && acc.profile && acc.profile.segment === 'igaming');
}

// ESTA CONTA TEM O MODO BET? É outra pergunta, e por isso outra função.
//
// O segmento vem do formulário de cadastro — e há contas que nunca passam por
// ele: a do próprio administrador e as SUPERCONTAS, que nascem prontas dentro
// do Admin SaaS. Sem uma chave manual, essas contas jamais alcançariam o Modo
// Bet, por mais que fosse exatamente para elas que ele precisasse existir.
//
// Por isso `betMode` é uma decisão do ADMIN, e não do cadastro: ele liga no
// painel e pronto. Quando ligado, vence o segmento; desligado, vale o segmento.
function temModoBet(acc) {
  if (!acc || !acc.profile) return false;
  if (acc.profile.betMode === true) return true;
  return ehIGaming(acc);
}

// ---------------------------------------------------------------------------
// O SITE DA PLATAFORMA
//
// Vem de formulário PÚBLICO e vai ser exibido para o admin conferir, então é
// validado como endereço e não como texto. Duas coisas importam:
//
//   · só http e https. `javascript:` num campo que a tela do admin mostra como
//     link é XSS servido de bandeja;
//   · precisa de um ponto no host. "meusite" não é endereço nenhum, e deixar
//     passar transforma a conferência do admin em adivinhação.
//
// Sem esquema, assume https — é o que a pessoa quer dizer ao digitar
// "minhabet.com", e recusar por isso seria implicância.
// ---------------------------------------------------------------------------
function normalizarSite(valor) {
  const cru = String(valor || '').trim();
  if (!cru) return { ok: false, erro: 'Informe o site da plataforma' };
  if (cru.length > 300) return { ok: false, erro: 'Endereço longo demais' };
  if (/\s/.test(cru)) return { ok: false, erro: 'O endereço não pode ter espaços' };

  const comEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(cru) ? cru : 'https://' + cru;
  let u;
  try { u = new URL(comEsquema); } catch { return { ok: false, erro: 'Endereço inválido' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, erro: 'Use um endereço http ou https' };
  }
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) {
    return { ok: false, erro: 'Informe o domínio completo, como minhaplataforma.com' };
  }
  return { ok: true, site: u.origin + (u.pathname === '/' ? '' : u.pathname) };
}

// Aplica segmento e site num perfil, validando os dois juntos — é sempre o par
// que precisa fazer sentido, e separar as duas validações deixaria passar um
// iGaming sem site.
function aplicar(profile, { segment, site }) {
  const seg = String(segment || '').trim();

  // VALOR DESCONHECIDO NÃO É ERRO, é o campo antigo.
  //
  // Este campo foi texto livre por toda a vida do produto, e `/api/register` é
  // uma rota PÚBLICA: recusar o que não está na lista quebraria todo cliente
  // que já manda "consultoria" ou "iGaming" escrito à mão — inclusive o que eu
  // não sei que existe. Então o desconhecido é guardado como sempre foi, e só
  // não liga nada.
  //
  // O efeito colateral é proposital: "iGaming" digitado à mão NÃO liga o Modo
  // Bet. Ligar um recurso a partir de texto livre é o tipo de esperteza que um
  // dia liga para quem escreveu "cassino" no nome do negócio.
  if (seg) profile.segment = valido(seg) ? seg : seg.slice(0, 60);

  if (pedeSite(seg)) {
    const s = normalizarSite(site);
    if (!s.ok) return { ok: false, erro: s.erro };
    profile.site = s.site;
  } else if (site !== undefined) {
    // Trocou para um segmento que não pede site: o antigo não fica pendurado.
    const s = String(site || '').trim();
    profile.site = s ? (normalizarSite(s).site || '') : '';
  }
  return { ok: true };
}

module.exports = { LISTA, valido, nome, pedeSite, ehIGaming, temModoBet, normalizarSite, aplicar };
