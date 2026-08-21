// ============================================================================
// QUEM ATENDE CADA ENDEREÇO
//
// O Koonfy responde por quatro hosts, todos no MESMO servidor. O que muda é o
// papel de cada um:
//
//   koonfy.com         vitrine (landing)
//   app.koonfy.com     painel do cliente
//   admin.koonfy.com   painel da plataforma (o /adm/)
//   api.koonfy.com     só a API
//   pay.koonfy.com     checkout público das cobranças
//
// Isso não separa backend de frontend — é organização de endereço. A vantagem
// real é poder mandar o cliente para `pay.` sem expor o domínio do painel, e
// ter um `api.` estável caso um dia o front saia daqui.
//
// Cada papel aceita um host fixo por variável de ambiente; sem ela, vale a
// convenção do prefixo, que funciona em qualquer domínio sem configurar nada.
//
// ---------------------------------------------------------------------------
// QUAL ENDEREÇO PODE SER ESCRITO NUM LINK
//
// Com vários hosts, surge uma pergunta que antes não existia: quando o sistema
// escreve a própria URL — cobrança que vai para o cliente, link rastreável,
// URL de webhook —, qual host usar?
//
// Nunca o da requisição. O admin abre o painel em app.koonfy.com e, sem
// cuidado, toda cobrança gerada passa a apontar para o subdomínio
// administrativo. O mesmo vale para o api.: ninguém deve receber um link de
// pagamento apontando para lá.
// ============================================================================

const env = (k) => String(process.env[k] || '').trim().toLowerCase();
const semBarra = (u) => String(u || '').trim().replace(/\/+$/, '');

const PANEL_HOST = env('PANEL_HOST');
const API_HOST = env('API_HOST');
const PAY_HOST = env('PAY_HOST');
const ADMIN_HOST = env('ADMIN_HOST');
const PUBLIC_URL = semBarra(process.env.PUBLIC_URL);
const PAY_URL = semBarra(process.env.PAY_URL);

function hostDe(req) {
  return String((req && req.get && req.get('host')) || '').toLowerCase().split(':')[0];
}

// Um papel casa pelo host configurado ou, na falta dele, pelo prefixo.
function ehPapel(req, fixo, prefixo) {
  const host = hostDe(req);
  if (!host) return false;
  if (fixo) return host === fixo;
  return host.startsWith(prefixo);
}

const ehHostDoPainel = (req) => ehPapel(req, PANEL_HOST, 'app.');
const ehHostDaApi = (req) => ehPapel(req, API_HOST, 'api.');
const ehHostDoPay = (req) => ehPapel(req, PAY_HOST, 'pay.');
// O painel da plataforma. Fica fora de `origensDoProduto` de propósito: o
// admin não precisa que a API o reconheça como origem confiável de
// navegador — ele fala com o mesmo host de onde foi servido.
const ehHostDoAdmin = (req) => ehPapel(req, ADMIN_HOST, 'admin.');

// Origem que pode ir num link enviado para fora.
// Devolve '' quando a requisição chegou por um host interno (painel ou API) e
// não há PUBLIC_URL: quem chama deve manter o valor que já tinha, em vez de
// gravar o subdomínio errado.
function origemPublica(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (!req) return '';
  if (ehHostDoPainel(req) || ehHostDaApi(req) || ehHostDoAdmin(req)) return '';
  return `${req.protocol}://${req.get('host')}`;
}

// Base dos links de pagamento. Com PAY_URL (ou PAY_HOST) as cobranças saem
// pelo domínio de checkout, no formato curto `pay.koonfy.com/<id>`. Sem isso,
// continuam em `<publico>/pay/<id>` — que é o que as cobranças antigas já
// gravaram, e segue funcionando.
function basePagamento(publico) {
  if (PAY_URL) return { base: PAY_URL, curto: true };
  if (PAY_HOST) return { base: 'https://' + PAY_HOST, curto: true };
  return { base: semBarra(publico), curto: false };
}

// Origens do navegador que podem falar com a API quando ela está num host
// próprio: a vitrine, o painel e o checkout. Sem isso o painel em
// app.koonfy.com seria barrado ao chamar api.koonfy.com.
function origensDoProduto(req) {
  const lista = new Set();
  const add = (u) => { const v = semBarra(u); if (v) lista.add(v); };
  if (PUBLIC_URL) {
    add(PUBLIC_URL);
    try {
      const raiz = new URL(PUBLIC_URL).host;
      for (const p of ['app.', 'pay.']) add('https://' + p + raiz);
    } catch { /* PUBLIC_URL malformada: sobra o que der */ }
  }
  for (const [fixo, prefixo] of [[PANEL_HOST, 'app.'], [PAY_HOST, 'pay.']]) {
    if (fixo) add('https://' + fixo);
    else if (req) {
      const h = hostDe(req);
      const raiz = h.replace(/^(api|app|pay)\./, '');
      if (raiz) add('https://' + prefixo + raiz);
    }
  }
  if (req) {
    const raiz = hostDe(req).replace(/^(api|app|pay)\./, '');
    if (raiz) add('https://' + raiz);
  }
  return lista;
}

module.exports = {
  PANEL_HOST, API_HOST, PAY_HOST, ADMIN_HOST, PUBLIC_URL, PAY_URL,
  hostDe, ehHostDoPainel, ehHostDaApi, ehHostDoPay, ehHostDoAdmin,
  origemPublica, basePagamento, origensDoProduto
};
