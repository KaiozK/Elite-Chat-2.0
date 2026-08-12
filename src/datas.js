// ============================================================================
// DATAS COM FUSO EXPLÍCITO
//
// `new Date(t).toLocaleTimeString('pt-BR')` no servidor usa o fuso do
// PROCESSO. Em desenvolvimento isso passa despercebido, porque a máquina está
// em São Paulo; no contêiner de produção o relógio é UTC, e um agendamento das
// 9h saía como "12h" na notificação. O horário do disparo estava certo — ele
// vem do timestamp, que é absoluto —, errado era só o texto.
//
// Aqui o fuso é sempre passado de propósito. A conta manda, a plataforma é o
// padrão, e São Paulo é o último recurso.
// ============================================================================
const db = require('./db');

const PADRAO = 'America/Sao_Paulo';

function fuso(acc) {
  const daConta = acc && acc.timezone;
  if (daConta) return daConta;
  try { return db.get().platform.timezone || PADRAO; } catch { return PADRAO; }
}

// Um fuso inválido derruba o Intl. Como ele vem de campo editável, cada
// formatação tenta e cai no padrão em vez de estourar no meio de um envio.
function formatar(ts, opcoes, acc) {
  if (!ts) return '';
  const d = new Date(ts);
  const tz = fuso(acc);
  try {
    return d.toLocaleString('pt-BR', { ...opcoes, timeZone: tz });
  } catch {
    return d.toLocaleString('pt-BR', { ...opcoes, timeZone: PADRAO });
  }
}

const hora = (ts, acc) => formatar(ts, { hour: '2-digit', minute: '2-digit' }, acc);
const data = (ts, acc) => formatar(ts, { day: '2-digit', month: '2-digit', year: 'numeric' }, acc);
const dataHora = (ts, acc) => formatar(ts, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }, acc);
const mesCurto = (ts, acc) => formatar(ts, { month: 'short' }, acc).replace('.', '');

// Lista para o seletor do painel. Curta de propósito: são os fusos do Brasil
// mais os de fora onde é plausível haver cliente, e não as 400 zonas do IANA.
const FUSOS = [
  ['America/Sao_Paulo', 'Brasília (GMT-3)'],
  ['America/Manaus', 'Manaus (GMT-4)'],
  ['America/Cuiaba', 'Cuiabá (GMT-4)'],
  ['America/Belem', 'Belém (GMT-3)'],
  ['America/Fortaleza', 'Fortaleza (GMT-3)'],
  ['America/Recife', 'Recife (GMT-3)'],
  ['America/Bahia', 'Salvador (GMT-3)'],
  ['America/Rio_Branco', 'Rio Branco (GMT-5)'],
  ['America/Noronha', 'Fernando de Noronha (GMT-2)'],
  ['America/Buenos_Aires', 'Buenos Aires (GMT-3)'],
  ['America/Montevideo', 'Montevidéu (GMT-3)'],
  ['America/Asuncion', 'Assunção (GMT-3)'],
  ['America/Santiago', 'Santiago (GMT-4)'],
  ['America/Bogota', 'Bogotá (GMT-5)'],
  ['America/Lima', 'Lima (GMT-5)'],
  ['America/Mexico_City', 'Cidade do México (GMT-6)'],
  ['America/New_York', 'Nova York (GMT-5)'],
  ['America/Los_Angeles', 'Los Angeles (GMT-8)'],
  ['Europe/Lisbon', 'Lisboa (GMT+0)'],
  ['Europe/London', 'Londres (GMT+0)'],
  ['Europe/Madrid', 'Madri (GMT+1)'],
  ['UTC', 'UTC (GMT+0)']
];

function valido(tz) {
  if (!tz) return false;
  try { new Date().toLocaleString('pt-BR', { timeZone: tz }); return true; } catch { return false; }
}

module.exports = { PADRAO, FUSOS, fuso, formatar, hora, data, dataHora, mesCurto, valido };
