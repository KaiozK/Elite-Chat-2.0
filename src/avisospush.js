// ===========================================================================
// EVENTO → NOTIFICAÇÃO
//
// Traduz o que acontece no produto (mensagem, ligação, venda, lembrete) no
// aviso que chega no celular. É uma função PURA: recebe o evento e devolve o
// que mostrar — sem rede, sem porta, sem estado.
//
// Ela morava dentro do server.js, e por isso não dava para testar sem subir o
// servidor inteiro. O teste da chamada no celular acabou REESCREVENDO esta
// lógica para conseguir verificar — e um teste que reimplementa o que deveria
// conferir passa mesmo quando o código de verdade quebra. Isso é confiança
// falsa, que é pior do que não ter teste.
// ===========================================================================
const db = require('./db');

function avisoDoEvento(event, data) {
  if (!data || !data.accountId) return null;

  if (!data || !data.accountId) return;
  let type = null, payload = null;
  const url = '/app/#/inbox';
  if (event === 'message' && data.notify && data.notify.direction === 'in') {
    type = 'message';
    payload = { title: data.notify.name || 'Nova mensagem', body: data.notify.text || '', tag: 'msg:' + data.waId, data: { type, waId: data.waId, url } };
  } else if (event === 'call' && data.kind === 'incoming') {
    const c = data.call || {};
    type = 'call';
    // O `callId` VAI JUNTO. Sem ele o Service Worker e o app não reconhecem o
    // aviso como uma chamada — as duas condições checam `data.callId` — e o
    // toque caía no caminho genérico, abrindo a lista de conversas. A pessoa
    // tocava em "fulano está te ligando" e o app abria sem chamada nenhuma.
    payload = { title: 'Chamada de voz', body: ((c.name || c.contactName || ('+' + (c.waId || ''))) + ' está te ligando…'), tag: 'call:' + (c.id || ''), requireInteraction: true, data: { type, waId: c.waId, callId: c.id || '', url: '/app/#/inbox' } };
  } else if (event === 'call' && (data.kind === 'claimed' || data.kind === 'terminate')) {
    // FECHAMENTO. A chamada foi atendida em outro aparelho, recusada ou
    // encerrada — e o aviso é `requireInteraction`, então fica na tela até
    // alguém tocar. Este push não mostra nada: manda apagar o que está lá.
    // É o único jeito de resolver com o app fechado, que é justamente quando
    // o problema acontece.
    const c = data.call || {};
    type = 'call';
    payload = { close: true, tag: 'call:' + (c.id || ''), data: { type: 'call_end', callId: c.id || '', tag: 'call:' + (c.id || '') } };
  } else if (event === 'attendance' && data.status === 'open' && data.reason === 'inbound') {
    type = 'attendance';
    payload = { title: 'Novo atendimento', body: (data.name || 'Cliente') + ' iniciou uma conversa', tag: 'att:' + data.waId, data: { type, waId: data.waId, url } };
  } else if (event === 'pagamentos' && data.status === 'paid') {
    // VENDA APROVADA no Pagamentos. O dinheiro entrou: é a notificação que o
    // lojista mais espera, e era a única do fluxo de venda que não existia.
    const fmt = require('./pagamentos').fmtBRL;
    type = 'sale';
    payload = {
      title: 'Venda aprovada ✅',
      body: fmt(data.amount || 0) + (data.contactName ? ' · ' + data.contactName : ''),
      tag: 'sale:' + (data.chargeId || Date.now()),
      data: { type, waId: data.waId || null, url: '/app/#/pagamentos' }
    };
  } else if (event === 'commission') {
    // Venda do indicado aprovada — o afiliado recebe o valor da comissão.
    type = 'commission';
    payload = {
      title: 'Venda Aprovada✅',
      body: 'Sua comissão: ' + require('./pagamentos').fmtBRL(data.amount || 0),
      tag: 'com:' + (data.accountId || '') + ':' + Date.now(),
      data: { type, url: '/app/#/billing' }
    };
  } else if (event === 'reminder') {
    const ev = data.event || {};
    // O fuso vem da CONTA: sem ele o texto saía no fuso do processo (UTC em
    // produção) e um compromisso das 9h era anunciado como 12h.
    const when = require('./datas').hora(ev.start, db.findAccount(data.accountId));
    type = 'reminder';
    payload = { title: 'Lembrete ' + (data.label || 'Agendamento'), body: `${ev.title || ''}${when ? ' · ' + when : ''}`, tag: 'ev:' + (ev.id || ''), requireInteraction: true, data: { type, waId: ev.contact ? ev.contact.waId : null, url: ev.contact ? url : '/app/#/schedule' } };
  }
  if (!type) return null;
  return { type, payload };
}

module.exports = { avisoDoEvento };
