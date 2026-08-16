// ============================================================================
// MISSÕES — a trilha de quem acabou de entrar
//
// O Koonfy tem muita coisa, e a tela inicial de uma conta nova é um painel
// vazio: não há nada indicando por onde começar nem o que existe. Quem entra
// conecta o WhatsApp, manda duas mensagens e nunca descobre campanha, funil,
// automação ou cobrança — e cancela achando que o produto é um chat.
//
// Cada missão é VERIFICADA no estado real da conta, não marcada à mão. Isso é
// o que separa uma trilha útil de uma lista de tarefas: ela não mente. Se o
// cliente conectou o WhatsApp por outro caminho, a missão já aparece feita; se
// ele apagou tudo, ela volta a aparecer.
//
// A ordem é a da dependência real (não dá para disparar campanha sem contato)
// e, dentro disso, do retorno mais rápido primeiro.
// ============================================================================
const limits = require('./limits');

// Uma missão: id, grupo, título, porquê, para onde vai, e como saber se está
// feita. `feita(acc)` é a única fonte da verdade.
function catalogo() {
  return [
    // ---- PRIMEIROS PASSOS ----
    {
      id: 'whatsapp', grupo: 'Primeiros passos', titulo: 'Conecte seu WhatsApp',
      porque: 'Sem um número conectado, nada mais funciona: é por ele que as mensagens entram e saem.',
      acao: 'Conectar número', rota: '#/settings',
      feita: (acc) => (acc.channels || []).some(c => c.wa && c.wa.connected)
    },
    {
      id: 'perfil', grupo: 'Primeiros passos', titulo: 'Complete os dados da empresa',
      porque: 'Nome e segmento aparecem para o cliente e ajustam os textos que o Koonfy sugere.',
      acao: 'Abrir ajustes', rota: '#/settings',
      feita: (acc) => !!(acc.name && acc.profile && acc.profile.segment)
    },
    {
      id: 'primeira-conversa', grupo: 'Primeiros passos', titulo: 'Responda a primeira conversa',
      porque: 'É o teste real de que a conexão está de pé nos dois sentidos.',
      acao: 'Abrir conversas', rota: '#/inbox',
      feita: (acc) => (acc.messages || []).some(m => m.direction === 'out')
    },

    // ---- ORGANIZAR ----
    {
      id: 'contatos', grupo: 'Organize sua base', titulo: 'Tenha seus contatos no Koonfy',
      porque: 'Contato no Koonfy é o que permite segmentar, disparar e acompanhar no funil.',
      acao: 'Ver contatos', rota: '#/contacts',
      feita: (acc) => (acc.contacts || []).length >= 5
    },
    {
      id: 'funil', grupo: 'Organize sua base', titulo: 'Ajuste as etapas do seu funil',
      porque: 'As etapas padrão servem para começar, mas o funil que vende é o que tem a cara da sua operação.',
      acao: 'Abrir funil', rota: '#/funnel',
      feita: (acc) => {
        const p = ['Novo', 'Em atendimento', 'Qualificado', 'Negociação', 'Ganho', 'Perdido'];
        const s = acc.stages || [];
        return s.length !== p.length || s.some((x, i) => x !== p[i]);
      }
    },
    {
      id: 'consentimento', grupo: 'Organize sua base', titulo: 'Revise o Opt-in e Opt-out',
      porque: 'É o que mantém a sua operação dentro da LGPD e o seu número longe do bloqueio.',
      acao: 'Abrir Opt-in', rota: '#/consent',
      feita: (acc) => !!(acc.consent && (acc.consent.history || []).length)
    },

    // ---- ATENDER MELHOR ----
    {
      id: 'respostas', grupo: 'Atenda mais rápido', titulo: 'Crie 3 respostas rápidas',
      porque: 'As perguntas se repetem. Respostas prontas cortam o tempo de atendimento sem robotizar.',
      acao: 'Criar respostas', rota: '#/quick',
      feita: (acc) => (acc.quickReplies || []).length >= 3
    },
    {
      id: 'equipe', grupo: 'Atenda mais rápido', titulo: 'Convide um atendente',
      porque: 'Cada atendente entra com o próprio login e permissões — ninguém precisa dividir senha.',
      acao: 'Abrir equipe', rota: '#/agents',
      feita: (acc) => (acc.team || []).length > 0,
      opcional: true
    },
    {
      id: 'ia', grupo: 'Atenda mais rápido', titulo: 'Ligue o Agente de IA',
      porque: 'Ele responde quando não há ninguém disponível — e você desliga por conversa quando quiser assumir.',
      acao: 'Configurar IA', rota: '#/ia',
      feita: (acc) => !!(acc.ia && acc.ia.enabled && acc.ia.apiKey && String(acc.ia.prompt || '').trim()),
      opcional: true
    },

    // ---- AUTOMATIZAR ----
    {
      id: 'fluxo', grupo: 'Automatize', titulo: 'Publique uma automação',
      porque: 'Boas-vindas, qualificação e follow-up rodando sozinhos, 24h por dia.',
      acao: 'Abrir Flow Builder', rota: '#/flows',
      feita: (acc) => (acc.flows || []).some(f => f.enabled)
    },
    {
      id: 'modelo', grupo: 'Automatize', titulo: 'Aprove um modelo na Meta',
      porque: 'É o que permite falar com quem não escreve há mais de 24 horas — sem modelo, a mensagem não sai.',
      acao: 'Abrir modelos', rota: '#/templates',
      // Os modelos vivem no cache POR CANAL (acc.templatesCache é apelido do
      // primeiro); a missão olha todos, porque aprovar num canal já conta.
      feita: (acc) => (acc.channels || []).some(ch =>
        (((ch.templatesCache || {}).list) || []).some(t => String(t.status || '').toUpperCase() === 'APPROVED'))
    },
    {
      id: 'campanha', grupo: 'Automatize', titulo: 'Dispare a primeira campanha',
      porque: 'É o caminho mais curto entre a sua base parada e a primeira venda da semana.',
      acao: 'Criar campanha', rota: '#/campaigns',
      feita: (acc) => (acc.campaigns || []).some(c => c.status === 'done' || c.status === 'running')
    },

    // ---- VENDER E MEDIR ----
    {
      id: 'pagamentos', grupo: 'Venda e meça', titulo: 'Abra sua conta de recebimento',
      porque: 'Com ela você cobra por Pix dentro da conversa e recebe sem tirar o cliente do WhatsApp.',
      acao: 'Abrir Pagamentos', rota: '#/elitepay',
      feita: (acc) => !!(acc.elitepay && acc.elitepay.subaccount && acc.elitepay.subaccount.status === 'active')
    },
    {
      id: 'produto', grupo: 'Venda e meça', titulo: 'Cadastre um produto',
      porque: 'Produto cadastrado preenche valor, descrição e checkout sozinho a cada cobrança.',
      acao: 'Cadastrar produto', rota: '#/elitepay',
      feita: (acc) => ((acc.elitepay || {}).products || []).length > 0
    },
    {
      id: 'cobranca', grupo: 'Venda e meça', titulo: 'Gere sua primeira cobrança',
      porque: 'Fecha o ciclo: da conversa ao pagamento confirmado, com o contato andando no funil sozinho.',
      acao: 'Cobrar agora', rota: '#/elitepay',
      feita: (acc) => ((acc.elitepay || {}).charges || []).length > 0
    },
    {
      id: 'link', grupo: 'Venda e meça', titulo: 'Crie um link rastreável',
      porque: 'É o que mostra qual anúncio virou venda de verdade, em vez de só clique.',
      acao: 'Criar link', rota: '#/links',
      feita: (acc) => (acc.links || []).length > 0,
      opcional: true
    },
    {
      id: 'notificacoes', grupo: 'Venda e meça', titulo: 'Ative as notificações no celular',
      porque: 'Mensagem nova e venda aprovada chegam no seu telefone, mesmo com o app fechado.',
      acao: 'Abrir ajustes', rota: '#/settings',
      feita: (acc) => (acc.pushSubs || []).length > 0 || (acc.pushDevices || []).length > 0
    }
  ];
}

// ---------------------------------------------------------------------------
// O QUE O CLIENTE VÊ
//
// Missão de módulo que o plano dele não inclui não aparece: seria vender por
// dentro do produto uma coisa que ele não pode usar.
// ---------------------------------------------------------------------------
const MODULO = {
  fluxo: 'flows', campanha: 'campaigns', equipe: 'agents',
  pagamentos: 'elitepay', produto: 'elitepay', cobranca: 'elitepay', link: 'links'
};

function relatorio(acc) {
  const itens = catalogo()
    .filter(m => !MODULO[m.id] || limits.featureOn(acc, MODULO[m.id]))
    .map(m => {
      let feita = false;
      // Uma missão que quebra não pode derrubar a tela inteira: conta como não
      // feita e segue.
      try { feita = !!m.feita(acc); } catch { feita = false; }
      return {
        id: m.id, grupo: m.grupo, titulo: m.titulo, porque: m.porque,
        acao: m.acao, rota: m.rota, opcional: !!m.opcional, feita
      };
    });

  // O progresso conta só o que é essencial. Missão opcional aparece na lista,
  // mas não deixa a barra em 80% para sempre em quem não precisa dela.
  const essenciais = itens.filter(m => !m.opcional);
  const prontas = essenciais.filter(m => m.feita).length;
  const proxima = itens.find(m => !m.feita && !m.opcional) || itens.find(m => !m.feita) || null;

  const grupos = [];
  for (const m of itens) {
    let g = grupos.find(x => x.nome === m.grupo);
    if (!g) { g = { nome: m.grupo, itens: [] }; grupos.push(g); }
    g.itens.push(m);
  }

  return {
    total: essenciais.length,
    feitas: prontas,
    percent: essenciais.length ? Math.round(prontas / essenciais.length * 100) : 100,
    completo: prontas === essenciais.length,
    proxima,
    grupos
  };
}

module.exports = { catalogo, relatorio };
