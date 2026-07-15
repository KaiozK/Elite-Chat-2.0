// Configuração padrão de Opt-in/Opt-out.
// Módulo sem dependências: usado por db.js (schema) e por consent.js (motor),
// evitando dependência circular entre eles.

const DEFAULT_KEYWORDS = ['PARAR', 'SAIR', 'CANCELAR', 'STOP', 'REMOVER', 'DESATIVAR'];

function defaultConsent() {
  return {
    enabled: true,
    optInMessage: 'Olá {{nome}}! ✅\n\nVocê agora receberá nossas novidades e atualizações por aqui.\n\nSe quiser parar a qualquer momento, é só responder *SAIR*.',
    optOutMessage: 'Tudo bem, {{nome}}. 👋\n\nVocê *não receberá mais* mensagens promocionais nossas.\n\nSe mudar de ideia, responda *VOLTAR* que reativamos seu cadastro.',
    keywords: [...DEFAULT_KEYWORDS],
    optInKeywords: ['VOLTAR', 'ACEITO'],   // reativação pelo próprio cliente
    sendOptInMessage: false,               // enviar msg de opt-in no 1º contato
    sendOptOutMessage: true,               // confirmar o opt-out para o cliente
    autoOptIn: true,                       // quem fala com a gente entra como opt-in
    defaultStage: '',                      // etapa do funil p/ contatos criados automaticamente
    history: []                            // histórico de ALTERAÇÕES da configuração
  };
}

function emptyContactConsent() {
  return {
    status: 'pending',                     // pending | opted_in | opted_out
    optInAt: null, optInSource: null,
    optOutAt: null, optOutSource: null, optOutReason: null,
    reactivatedAt: null,
    history: []                            // [{ ts, action, source, reason, by }]
  };
}

module.exports = defaultConsent;
module.exports.defaultConsent = defaultConsent;
module.exports.emptyContactConsent = emptyContactConsent;
module.exports.DEFAULT_KEYWORDS = DEFAULT_KEYWORDS;
