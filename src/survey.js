// Pesquisa de Satisfação — disparada ao FINALIZAR o atendimento.
//
// Pluga-se no gatilho já existente (session.onFinished): este módulo não altera
// nada da janela de 24h nem da finalização.
//
// Formato da mensagem (regra da Meta):
//   • até 3 notas  → mensagem interativa de BOTÕES (máx. 3 reply buttons, título ≤ 20 chars)
//   • acima de 3   → mensagem interativa de LISTA  (máx. 10 linhas, título ≤ 24 chars)
const wa = require('./whatsapp');
const db = require('./db');
const store = require('./store');
const session = require('./session');

const MAX_BUTTONS = 3;   // limite da Meta para reply buttons
const MAX_ROWS = 10;     // limite da Meta para linhas de lista
const BTN_TITLE_MAX = 20;
const ROW_TITLE_MAX = 24;

const REPLY_PREFIX = 'survey_';

function cfgOf(acc) {
  return (acc.service && acc.service.survey) || db.defaultSurvey();
}

// Notas válidas (rótulo preenchido), respeitando o teto de 10 da lista
function validNotes(cfg) {
  return (cfg.notes || []).filter(n => n && String(n.label || '').trim()).slice(0, MAX_ROWS);
}

// Decide o formato conforme a quantidade de notas
function formatOf(cfg) {
  return validNotes(cfg).length <= MAX_BUTTONS ? 'buttons' : 'list';
}

// Monta o payload `interactive` da Cloud API a partir da configuração
function buildInteractive(cfg) {
  const notes = validNotes(cfg);
  if (!notes.length) return null;
  const body = { text: String(cfg.message || '').trim() || 'Como você avalia nosso atendimento?' };
  const footer = String(cfg.footer || '').trim();

  if (notes.length <= MAX_BUTTONS) {
    return {
      type: 'button',
      body,
      ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
      action: {
        buttons: notes.map(n => ({
          type: 'reply',
          reply: { id: REPLY_PREFIX + n.id, title: String(n.label).trim().slice(0, BTN_TITLE_MAX) }
        }))
      }
    };
  }

  return {
    type: 'list',
    body,
    ...(footer ? { footer: { text: footer.slice(0, 60) } } : {}),
    action: {
      button: (String(cfg.listButton || 'Avaliar').trim() || 'Avaliar').slice(0, BTN_TITLE_MAX),
      sections: [{
        title: 'Sua avaliação',
        rows: notes.map(n => ({
          id: REPLY_PREFIX + n.id,
          title: String(n.label).trim().slice(0, ROW_TITLE_MAX)
        }))
      }]
    }
  };
}

// O QUE FICA NO HISTÓRICO
//
// O corpo é a pergunta, e as notas vão como BOTÕES: é assim que o chat
// desenha e é o que o cliente vê. Antes as notas viravam marcadores dentro
// do texto, e o balão mostrava uma lista onde havia botões.
function summaryText(cfg) {
  return String(cfg.message || '').trim();
}

// Em formato de LISTA o cliente vê um botão só, o que abre o menu: as notas
// aparecem depois que ele toca. Desenhar todas no balão contaria uma
// história que a tela dele não mostra.
function summaryButtons(cfg) {
  const notes = validNotes(cfg);
  if (!notes.length) return [];
  if (formatOf(cfg) === 'list') {
    const rotulo = String(cfg.listButton || 'Avaliar').trim() || 'Avaliar';
    return [{ id: 'survey_list', title: rotulo.slice(0, BTN_TITLE_MAX) }];
  }
  return notes.map(n => ({ id: REPLY_PREFIX + n.id, title: String(n.label).trim().slice(0, BTN_TITLE_MAX) }));
}

// ---------- Envio ao finalizar o atendimento ----------

// Handler registrado em session.onFinished(). Só envia se a pesquisa estiver
// ativa E a janela de 24h ainda estiver aberta (fora dela a Meta não aceita
// mensagem interativa — nesse caso apenas registramos o motivo).
function makeOnFinished(broadcast) {
  return async ({ acc, contact }) => {
    const cfg = cfgOf(acc);
    if (!cfg.enabled) return;

    const interactive = buildInteractive(cfg);
    if (!interactive) {
      store.logEvent({ type: 'survey_skipped', accountId: acc.id, waId: contact.waId, reason: 'sem notas configuradas' });
      return;
    }
    if (!session.windowState(contact).open) {
      store.logEvent({ type: 'survey_skipped', accountId: acc.id, waId: contact.waId, reason: 'janela de 24h fechada' });
      return;
    }
    // Já existe uma pesquisa esperando resposta: não manda outra. Mandar duas
    // seguidas é o cliente recebendo o mesmo pedido de nota duas vezes — e
    // qualquer caminho que finalize o atendimento de novo cairia aqui.
    if (contact.surveyPending) {
      store.logEvent({ type: 'survey_skipped', accountId: acc.id, waId: contact.waId, reason: 'já há uma pesquisa aguardando resposta' });
      return;
    }

    try {
      const resp = await wa.sendInteractive(acc, contact.waId, interactive);
      const msg = store.storeOutbound(acc, contact.waId, {
        type: 'interactive', text: summaryText(cfg), buttons: summaryButtons(cfg)
      }, resp);
      // marca que estamos aguardando a nota deste contato
      contact.surveyPending = { sentAt: Date.now(), format: formatOf(cfg) };
      db.save();
      store.logEvent({ type: 'survey_sent', accountId: acc.id, waId: contact.waId, format: formatOf(cfg) });
      if (broadcast) broadcast('message', { accountId: acc.id, waId: contact.waId });
      return msg;
    } catch (e) {
      store.logEvent({ type: 'survey_error', accountId: acc.id, waId: contact.waId, error: e.message });
    }
  };
}

// ---------- Captura da resposta ----------

// Chamado pelo webhook quando chega uma resposta interativa. Devolve a nota
// registrada, ou null se não for uma resposta de pesquisa.
function handleReply(acc, contact, replyId, title) {
  if (!replyId || !String(replyId).startsWith(REPLY_PREFIX)) return null;
  const noteId = String(replyId).slice(REPLY_PREFIX.length);
  const cfg = cfgOf(acc);
  const notes = validNotes(cfg);
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx === -1) return null;

  const entry = {
    ts: Date.now(),
    noteId,
    label: notes[idx].label,
    score: idx + 1,            // posição na escala (1 = primeira nota)
    scale: notes.length
  };
  contact.surveys = contact.surveys || [];
  contact.surveys.push(entry);
  if (contact.surveys.length > 50) contact.surveys.shift();
  contact.surveyPending = null;
  db.save();
  store.logEvent({ type: 'survey_answered', accountId: acc.id, waId: contact.waId, label: entry.label, score: entry.score, scale: entry.scale });
  return entry;
}

// ---------- Métricas ----------

function metrics(acc, now = Date.now()) {
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const today = +startOfDay;
  let answered = 0, answeredToday = 0, sum = 0, pending = 0;
  const dist = {};
  for (const c of acc.contacts || []) {
    if (c.surveyPending) pending++;
    for (const s of c.surveys || []) {
      answered++;
      sum += s.score / s.scale;                     // normaliza escalas diferentes
      dist[s.label] = (dist[s.label] || 0) + 1;
      if (s.ts >= today) answeredToday++;
    }
  }
  return {
    answered, answeredToday, pending,
    avgPercent: answered ? Math.round((sum / answered) * 100) : null,
    distribution: Object.entries(dist).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
  };
}

module.exports = {
  MAX_BUTTONS, MAX_ROWS, BTN_TITLE_MAX, ROW_TITLE_MAX, REPLY_PREFIX,
  cfgOf, validNotes, formatOf, buildInteractive, summaryText, summaryButtons,
  makeOnFinished, handleReply, metrics
};
