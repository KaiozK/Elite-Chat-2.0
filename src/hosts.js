// ============================================================================
// QUAL ENDEREÇO É O PÚBLICO
//
// Com o painel num subdomínio próprio (app.koonfy.com), o servidor passa a
// atender por DOIS hosts. Isso cria uma pergunta que antes não existia: quando
// o sistema precisa escrever a própria URL — link de pagamento enviado ao
// cliente, link rastreável de campanha, URL de webhook —, qual host usar?
//
// A resposta nunca é "o host da requisição". O admin abre o painel em
// app.koonfy.com, e a partir daí toda cobrança gerada apontaria para o
// subdomínio do painel. Funciona (é o mesmo servidor), mas é o endereço
// errado: o que vai para o cliente tem que ser o público.
//
// Ordem de decisão:
//   1. PUBLIC_URL, se definida — controle explícito, vale sempre;
//   2. o host da requisição, se NÃO for o do painel;
//   3. o que já estava guardado.
// ============================================================================

const PANEL_HOST = String(process.env.PANEL_HOST || '').trim().toLowerCase();
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

function hostDe(req) {
  return String((req && req.get && req.get('host')) || '').toLowerCase().split(':')[0];
}

// O painel tem endereço próprio quando PANEL_HOST é definida; sem ela, vale a
// convenção "app.<dominio>", que funciona em qualquer domínio sem configurar.
function ehHostDoPainel(req) {
  const host = hostDe(req);
  if (!host) return false;
  if (PANEL_HOST) return host === PANEL_HOST;
  return host.startsWith('app.');
}

// Origem que pode ser escrita em link mandado para fora.
// Devolve '' quando a requisição chegou pelo painel e não há PUBLIC_URL: quem
// chama deve manter o valor que já tinha, em vez de gravar o subdomínio.
function origemPublica(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (!req) return '';
  if (ehHostDoPainel(req)) return '';
  return `${req.protocol}://${req.get('host')}`;
}

module.exports = { PANEL_HOST, PUBLIC_URL, ehHostDoPainel, origemPublica, hostDe };
