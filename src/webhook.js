// Webhook da Meta: verificação (GET) e recebimento de eventos (POST)
// Multi-conta: cada evento chega com metadata.phone_number_id e é roteado
// para a conta (tenant) que conectou aquele número via Embedded Signup.
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const store = require('./store');
const flows = require('./flows');
const session = require('./session');
const survey = require('./survey');
const consent = require('./consent');
const wa = require('./whatsapp');
const ia = require('./ia');

// Persiste + transmite (SSE) uma mensagem enviada por automação.
function makeDeliver(broadcast) {
  return (acc, to, content, apiResp) => {
    const msg = store.storeOutbound(acc, to, content, apiResp);
    broadcast('message', { accountId: acc.id, waId: msg.waId });
    return msg;
  };
}

// Duração em m:ss para a notificação de áudio.
function fmtDuracao(seg) {
  const s = Math.max(0, Math.round(Number(seg) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

// Descrição da notificação. O título é o nome do lead; aqui vai o que ele
// mandou, com um emoji que identifica o tipo antes de a pessoa abrir o app.
//
// Sobre a duração do áudio: a Cloud API da Meta manda apenas
// { id, mime_type, sha256, voice } no objeto `audio` — não existe duração no
// webhook. Ela só sairia baixando o arquivo e lendo o container OGG/Opus, o
// que atrasaria justamente a notificação que precisa ser instantânea. Por isso
// o tempo aparece quando `durationSec` existir e é omitido quando não existir,
// em vez de mostrarmos um valor inventado.
function notifyPreview(parsed) {
  if (!parsed) return 'Nova mensagem';

  switch (parsed.type) {
    case 'text':
      return '💬 ' + String(parsed.text || '').slice(0, 140);

    case 'audio':
      // voice = gravado no microfone do WhatsApp; sem a flag é arquivo de áudio.
      if (parsed.voice) {
        return '🎤 Mensagem de voz' + (parsed.durationSec ? ' ' + fmtDuracao(parsed.durationSec) : '');
      }
      return '🎤 Enviou um áudio';

    case 'image':   return '📸 Enviou uma imagem';
    case 'video':   return '🎥 Enviou um vídeo';
    case 'document': return '📄 Enviou um documento';
    case 'sticker': return '💚 Enviou uma figurinha';
    case 'location': return '📍 Enviou uma localização';
    case 'contacts': return '👤 Compartilhou um contato';
    case 'order':   return '🛒 Enviou um pedido';
    default:
      // interactive, button, reaction e afins já vêm com um texto pronto.
      return parsed.text ? '💬 ' + String(parsed.text).slice(0, 140) : 'Nova mensagem';
  }
}

module.exports = function (broadcast) {
  const router = express.Router();

  // Verificação do webhook (Meta chama ao salvar a Callback URL)
  router.get('/webhook', (req, res) => {
    const platform = db.get().platform;
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const ok = mode === 'subscribe' && token === platform.verifyToken;
    store.logEvent({ type: 'verify_attempt', ok, mode: mode || null });
    if (ok) return res.status(200).send(challenge);
    res.sendStatus(403);
  });

  // Recebimento de eventos (mensagens, status, templates, qualidade etc.)
  router.post('/webhook', (req, res) => {
    const platform = db.get().platform;

    // Valida assinatura X-Hub-Signature-256 com o App Secret da plataforma
    if (platform.appSecret) {
      const sig = req.get('x-hub-signature-256') || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', platform.appSecret)
        .update(req.rawBody || Buffer.alloc(0)).digest('hex');
      const valid = sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!valid) {
        store.logEvent({ type: 'signature_invalid', received: sig.slice(0, 24) + '...' });
        return res.sendStatus(401);
      }
    }

    res.sendStatus(200); // responde rápido; Meta reenvia se demorar
    try {
      processEvent(req.body, broadcast);
    } catch (e) {
      store.logEvent({ type: 'process_error', error: e.message });
    }
  });

  return router;
};

function processEvent(body, broadcast) {
  if (!body || body.object !== 'whatsapp_business_account') {
    store.logEvent({ type: 'webhook', object: body && body.object, body });
    return;
  }

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const phoneNumberId = (v.metadata && v.metadata.phone_number_id) || null;
      const conta = phoneNumberId ? db.findAccountByPhoneId(phoneNumberId) : null;
      // O phoneNumberId identifica em QUAL conexão (canal) a mensagem entrou.
      // Trabalhamos no contexto desse canal para que a conversa seja gravada
      // no canal certo e não se misture com a de outro número.
      const canal = conta ? db.channelByPhoneId(conta, phoneNumberId) : null;
      const acc = conta ? db.chanCtx(conta, canal) : null;

      store.logEvent({
        type: 'webhook',
        object: body.object,
        field: change.field,
        accountId: acc ? acc.id : null,
        phoneNumberId,
        body: { entry: [{ id: entry.id, changes: [change] }] }
      });

      // LIGAÇÕES (Calling API): eventos de chamada chegam no campo "calls"
      if (change.field === 'calls' && acc) { handleCalls(acc, v, broadcast); continue; }

      // Campos assinados além de messages (template status, qualidade do número,
      // account_update etc.) ficam registrados no log acima.
      if (change.field !== 'messages') continue;

      if (!acc) {
        // "unrouted" sozinho não diz nada: a mensagem chegou, mas nenhuma conta
        // reconhece o número. O que resolve é ver LADO A LADO o que a Meta
        // mandou e o que está cadastrado aqui — quase sempre o número foi
        // conectado noutra conta, ou o cadastro se perdeu e ninguém percebeu.
        const registrados = [];
        for (const a of db.get().accounts) {
          for (const ch of (a.channels || [])) {
            const w = ch.wa || {};
            if (w.phoneNumberId) {
              registrados.push({ conta: a.name, canal: ch.label, phoneNumberId: w.phoneNumberId });
            }
          }
        }
        store.logEvent({
          type: 'unrouted', phoneNumberId, field: change.field,
          explicacao: registrados.length
            ? 'A Meta entregou uma mensagem do número ' + phoneNumberId + ', mas nenhuma conexão ' +
              'cadastrada usa esse Phone Number ID. Confira em Configurações → Conexão & API.'
            : 'A Meta entregou uma mensagem do número ' + phoneNumberId + ', mas NÃO HÁ nenhum ' +
              'WhatsApp conectado neste servidor. Conecte o número em Configurações.',
          cadastrados: registrados
        });
        continue;
      }

      const names = {};
      for (const c of v.contacts || []) names[c.wa_id] = c.profile && c.profile.name;

      // Mensagens recebidas
      for (const m of v.messages || []) {
        const contact = store.upsertContact(acc, m.from, names[m.from]);
        // Atribuição de anúncio Click-to-WhatsApp (referral) — só na 1ª vez
        if (m.referral && !contact.source) {
          const rf = m.referral;
          contact.source = {
            type: rf.source_type || 'ad',      // ad | post
            id: rf.source_id || '',
            headline: rf.headline || '',
            body: rf.body || '',
            sourceUrl: rf.source_url || '',
            ctwaClid: rf.ctwa_clid || '',
            media: rf.media_type || '',
            ts: Date.now()
          };
          db.save();
        }
        const parsed = parseMessage(m);
        const rec = store.addMessage(acc, {
          id: m.id,
          waId: contact.waId,
          direction: 'in',
          timestamp: (Number(m.timestamp) * 1000) || Date.now(),
          status: 'received',
          ...parsed
        });
        if (rec) {
          contact.unread = (contact.unread || 0) + 1;
          contact.lastMessageAt = rec.timestamp;
          // Renova a janela de 24h; se o atendimento estava finalizado, o cliente
          // voltar a falar abre um NOVO atendimento (histórico é preservado).
          const t = session.touchInbound(acc, contact, rec.timestamp);
          db.save();
          broadcast('message', {
            accountId: acc.id, waId: contact.waId, chId: rec.chId,
            // dados p/ a notificação nativa do WebApp (nome = título, mensagem = descrição)
            notify: {
              direction: 'in', name: contact.name || ('+' + contact.waId),
              text: notifyPreview(parsed), type: parsed.type || 'text',
              channel: canal ? canal.label : ''   // de qual número veio
            }
          });
          if (t && t.reopened) broadcast('attendance', { accountId: acc.id, waId: contact.waId, status: 'open', reason: 'inbound', name: contact.name || ('+' + contact.waId) });

          // Resposta da Pesquisa de Satisfação (botão ou item de lista)
          if (parsed.type === 'interactive' && parsed.replyId) {
            const ans = survey.handleReply(acc, contact, parsed.replyId, parsed.text);
            if (ans) broadcast('survey', { accountId: acc.id, waId: contact.waId, score: ans.score, label: ans.label });
          }

          // ---- OPT-IN / OPT-OUT ----
          // Palavra-chave do cliente tem prioridade sobre qualquer automação.
          const consentAction = handleConsent(acc, contact, parsed, broadcast);
          if (consentAction === 'opt_out') continue; // não roda flows para quem pediu para sair

          // dispara automações do Flow Builder (palavra-chave/link/botão/lista)
          // `button` entra junto: é o toque num botão de TEMPLATE, e sem ele
          // um fluxo que manda template com botões nunca via a resposta.
          if ((parsed.type === 'text' || parsed.type === 'interactive' || parsed.type === 'button') && parsed.text) {
            const kind = parsed.type === 'text' ? 'text' : 'interactive';
            // replyId identifica QUAL botão/item foi tocado — é o que permite
            // retomar um fluxo em espera pelo caminho certo.
            const entregar = makeDeliver(broadcast);
            flows.onInbound(acc, contact, parsed.text, kind, entregar, parsed.replyId || '')
              .then(fluxo => {
                // A IA só entra DEPOIS de o fluxo decidir: se a automação
                // respondeu, quem manda é ela. `fluxo` vem preenchido quando
                // algum fluxo tratou a mensagem.
                if (parsed.type !== 'text') return;
                return ia.responder(acc, contact, entregar, { flowRespondeu: !!fluxo })
                  .then(r => { if (r && r.enviou) broadcast('message', { accountId: acc.id, waId: contact.waId }); });
              })
              .catch(e => store.logEvent({ type: 'flow_error', accountId: acc.id, error: e.message }));
          }
        }
      }

      // Atualizações de status de mensagens enviadas
      for (const st of v.statuses || []) {
        const msg = acc.messages.find(mm => mm.id === st.id);
        if (!msg) continue;
        const order = ['accepted', 'sent', 'delivered', 'read', 'failed'];
        if (st.status === 'failed' || order.indexOf(st.status) >= order.indexOf(msg.status)) {
          msg.status = st.status;
        }
        if (st.errors && st.errors.length) {
          msg.error = st.errors
            .map(e => `${e.code}: ${e.title}${e.error_data && e.error_data.details ? '-' + e.error_data.details : ''}`)
            .join('; ');
        }
        db.save();
        broadcast('status', { accountId: acc.id, waId: msg.waId, id: msg.id, status: msg.status });
      }
    }
  }
}

// ---- LIGAÇÕES (Calling API) ----
// Eventos do campo "calls": connect (chamada tocando, traz o SDP offer do
// WebRTC), terminate (encerrada, traz duração/status) e updates intermediários.
// O front recebe tudo por SSE e mostra a tela de chamada estilo WhatsApp.
function handleCalls(acc, v, broadcast) {
  const names = {};
  for (const c of v.contacts || []) names[c.wa_id] = c.profile && c.profile.name;
  // NB: `acc` pode ser um contexto de canal (herda da conta por protótipo), por
  // isso a lista é criada na CONTA e não no contexto — senão o push se perderia.
  const dono = db.findAccount(acc.id) || acc;
  if (!Array.isArray(dono.calls)) dono.calls = [];

  for (const ev of v.calls || []) {
    const userSide = ev.direction === 'BUSINESS_INITIATED' ? ev.to : ev.from;
    const waId = store.normalizeWaId(userSide);
    let rec = acc.calls.find(c => c.id === ev.id);
    if (!rec) {
      rec = {
        id: ev.id, waId,
        direction: ev.direction || 'USER_INITIATED',
        status: 'ringing',
        startedAt: (Number(ev.timestamp) * 1000) || Date.now(),
        endedAt: null, duration: null
      };
      acc.calls.push(rec);
      if (acc.calls.length > 200) acc.calls.shift();
    }

    // O SDP do outro lado vem em `session`, e o que ele significa depende de
    // quem ligou: se foi o cliente, é a OFERTA que o navegador vai responder;
    // se fomos nós, é a RESPOSTA dele à nossa oferta. Antes só a oferta era
    // repassada, então em ligação nossa o navegador nunca recebia a resposta e
    // a chamada ficava sem mídia dos dois lados.
    const sess = ev.session || {};
    const sdp = sess.sdp || null;
    const sdpType = String(sess.sdp_type || sess.sdpType || '').toLowerCase()
      || (rec.direction === 'USER_INITIATED' ? 'offer' : 'answer');

    if (ev.event === 'connect') {
      rec.status = 'ringing';
      rec.sdpOffer = sdp;
      const contact = store.upsertContact(acc, waId, names[waId]);
      broadcast('call', {
        accountId: acc.id,
        kind: rec.direction === 'USER_INITIATED' ? 'incoming' : 'update',
        call: { id: rec.id, waId, name: contact.name, direction: rec.direction, status: rec.status },
        sdpOffer: rec.sdpOffer, sdp, sdpType
      });
      store.logEvent({ type: 'call_connect', accountId: acc.id, waId, direction: rec.direction });
    } else if (ev.event === 'terminate') {
      rec.status = String(ev.status || 'ended').toLowerCase();
      rec.endedAt = Date.now();
      rec.duration = Number(ev.duration) || null;
      // registra a ligação no histórico da conversa
      const contact = store.findContact(acc, waId);
      const durTxt = rec.duration ? ` · ${Math.floor(rec.duration / 60)}min ${rec.duration % 60}s` : '';
      store.addMessage(acc, {
        id: 'call_' + rec.id,
        waId,
        direction: rec.direction === 'USER_INITIATED' ? 'in' : 'out',
        timestamp: Date.now(),
        status: 'received',
        type: 'call',
        text: `📞 ${rec.direction === 'USER_INITIATED' ? 'Ligação recebida' : 'Ligação realizada'}${durTxt}`
      });
      if (contact) { contact.lastMessageAt = Date.now(); }
      broadcast('call', { accountId: acc.id, kind: 'terminate', call: { id: rec.id, waId, status: rec.status, duration: rec.duration } });
      broadcast('message', { accountId: acc.id, waId });
    } else {
      // eventos intermediários (ringing/accept/etc.). O `accept` de uma ligação
      // NOSSA traz a resposta SDP do cliente — sem ela não há áudio.
      const st = String(ev.event || ev.status || '').toLowerCase();
      if (sdp) rec.sdpAnswer = sdp;
      broadcast('call', {
        accountId: acc.id, kind: 'update',
        call: { id: rec.id, waId, status: st === 'accept' ? 'accepted' : st },
        sdp, sdpType
      });
    }
    db.save();
  }
}

// ---- OPT-IN / OPT-OUT no inbound ----
// 1) palavra-chave de opt-out  → registra o opt-out e confirma para o cliente
// 2) palavra-chave de opt-in    → reativa quem estava em opt-out
// 3) qualquer outra mensagem    → opt-in implícito (o cliente falou conosco)
// Retorna 'opt_out' | 'opt_in' | null.
function handleConsent(acc, contact, parsed, broadcast) {
  const cfg = consent.cfgOf(acc);
  if (!cfg.enabled) return null;
  const text = parsed.text || '';

  // 1) opt-out por palavra-chave
  const outKw = text && consent.matchOptOutKeyword(acc, text);
  if (outKw) {
    if (!consent.isOptedOut(contact)) {
      consent.optOut(acc, contact, { source: 'keyword', reason: `Palavra-chave: "${outKw}"` });
      store.logEvent({ type: 'opt_out', accountId: acc.id, waId: contact.waId, source: 'keyword', reason: outKw });
      if (cfg.sendOptOutMessage && cfg.optOutMessage) {
        // Confirmação enviada DIRETO pela API (fora do guard — é o próprio opt-out).
        const body = consent.renderMessage(acc, contact, cfg.optOutMessage);
        wa.sendText(acc, contact.waId, body)
          .then(r => {
            store.storeOutbound(acc, contact.waId, { type: 'text', text: body }, r);
            if (broadcast) broadcast('message', { accountId: acc.id, waId: contact.waId });
          })
          .catch(e => store.logEvent({ type: 'opt_out_msg_error', accountId: acc.id, waId: contact.waId, error: e.message }));
      }
      if (broadcast) broadcast('consent', { accountId: acc.id, waId: contact.waId, status: 'opted_out' });
    }
    return 'opt_out';
  }

  // 2) opt-in por palavra-chave (reativação pelo próprio cliente)
  const inKw = text && consent.matchOptInKeyword(acc, text);
  if (inKw && consent.isOptedOut(contact)) {
    consent.optIn(acc, contact, { source: 'keyword', reason: `Palavra-chave: "${inKw}"` });
    store.logEvent({ type: 'opt_in', accountId: acc.id, waId: contact.waId, source: 'keyword', reason: inKw });
    if (cfg.optInMessage) {
      const body = consent.renderMessage(acc, contact, cfg.optInMessage);
      wa.sendText(acc, contact.waId, body)
        .then(r => {
          store.storeOutbound(acc, contact.waId, { type: 'text', text: body }, r);
          if (broadcast) broadcast('message', { accountId: acc.id, waId: contact.waId });
        })
        .catch(() => {});
    }
    if (broadcast) broadcast('consent', { accountId: acc.id, waId: contact.waId, status: 'opted_in' });
    return 'opt_in';
  }

  // 3) opt-in implícito: quem manda mensagem consente em ser respondido.
  //    Nunca reverte um opt-out — só sai dele por palavra-chave, Flow ou ação manual.
  if (cfg.autoOptIn && consent.statusOf(contact) === 'pending') {
    consent.optIn(acc, contact, { source: 'inbound', reason: 'Mensagem recebida do cliente' });
    store.logEvent({ type: 'opt_in', accountId: acc.id, waId: contact.waId, source: 'inbound' });
    const first = (contact.consent.history || []).length === 1;
    if (cfg.sendOptInMessage && first && cfg.optInMessage) {
      const body = consent.renderMessage(acc, contact, cfg.optInMessage);
      wa.sendText(acc, contact.waId, body)
        .then(r => {
          store.storeOutbound(acc, contact.waId, { type: 'text', text: body }, r);
          if (broadcast) broadcast('message', { accountId: acc.id, waId: contact.waId });
        })
        .catch(() => {});
    }
    if (broadcast) broadcast('consent', { accountId: acc.id, waId: contact.waId, status: 'opted_in' });
    return 'opt_in';
  }
  return null;
}

function parseMessage(m) {
  const t = m.type;
  const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'];

  if (t === 'text') return { type: 'text', text: (m.text && m.text.body) || '' };

  if (mediaTypes.includes(t)) {
    const md = m[t] || {};
    return {
      type: t,
      text: md.caption || '',
      // `voice: true` distingue o áudio gravado no microfone de um arquivo de
      // música anexado — a notificação fala "mensagem de voz" só no primeiro.
      voice: !!md.voice,
      // A Meta não envia duração hoje; se um dia enviar, a notificação já usa.
      durationSec: Number(md.duration || md.seconds || 0) || 0,
      media: { id: md.id, mime: md.mime_type, filename: md.filename || '', caption: md.caption || '' }
    };
  }

  if (t === 'location') {
    const l = m.location || {};
    return { type: 'location', text: `📍 ${l.name || ''} ${l.address || ''}`.trim() || '📍 Localização', location: l };
  }

  if (t === 'contacts') {
    const names = (m.contacts || []).map(c => c.name && c.name.formatted_name).filter(Boolean).join(', ');
    return { type: 'contacts', text: '👤 ' + (names || 'Contato compartilhado') };
  }

  // Botão de TEMPLATE (quick reply). Chega como `button`, e não como
  // `interactive`: o payload é o que o template definiu, e o text é o rótulo.
  // Levar os dois adiante é o que permite um fluxo reagir a esse toque.
  if (t === 'button') {
    return {
      type: 'button',
      text: (m.button && m.button.text) || '[botão]',
      replyId: (m.button && m.button.payload) || ''
    };
  }

  if (t === 'interactive') {
    const r = (m.interactive && (m.interactive.button_reply || m.interactive.list_reply)) || null;
    // replyId é usado para casar a resposta com a Pesquisa de Satisfação
    return { type: 'interactive', text: r ? r.title : '[resposta interativa]', replyId: (r && r.id) || '' };
  }

  if (t === 'reaction') {
    return { type: 'reaction', text: `${(m.reaction && m.reaction.emoji) || ''} (reação)`, reactedTo: m.reaction && m.reaction.message_id };
  }

  if (t === 'order') return { type: 'order', text: '🛒 Pedido recebido' };

  return { type: t || 'unknown', text: `[${t || 'desconhecido'}] tipo de mensagem não suportado` };
}
