// ============================================================================
// ENVIO DE E-MAIL (SMTP)
//
// O EliteChat não usa biblioteca de e-mail: o resto do projeto também fala os
// protocolos direto (o Web Push em src/push.js assina VAPID na mão), e uma
// dependência a mais para mandar três tipos de mensagem não se paga.
//
// São só os verbos necessários:
//   EHLO → [STARTTLS → EHLO] → AUTH → MAIL FROM → RCPT TO → DATA → QUIT
//
// Duas formas de chegar cifrado, e o servidor decide qual:
//   • porta 465  → TLS desde o primeiro byte (implícito)
//   • porta 587  → começa em texto puro e sobe para TLS com STARTTLS
// Sem cifra não há AUTH: a senha iria em base64 legível na rede.
// ============================================================================

const net = require('net');
const tls = require('tls');
const db = require('./db');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function cfg() {
  const p = db.get().platform;
  if (!p.mail || typeof p.mail !== 'object') p.mail = emptyConfig();
  for (const [k, v] of Object.entries(emptyConfig())) if (p.mail[k] === undefined) p.mail[k] = v;
  return p.mail;
}

function emptyConfig() {
  return {
    enabled: false,
    host: '', port: 587, secure: false,   // secure = TLS implícito (porta 465)
    user: '', pass: '',
    from: '', fromName: 'EliteChat',
    lastError: '', lastOkAt: 0
  };
}

// Configurado o bastante para tentar um envio.
function configured() {
  const c = cfg();
  return !!(c.enabled && c.host && c.from);
}

// ---------------------------------------------------------------------------
// Diálogo SMTP.
//
// O servidor responde em linhas "250-continua" / "250 fim". Só a linha SEM o
// hífen encerra a resposta, então é por ela que esperamos antes de mandar o
// próximo comando.
// ---------------------------------------------------------------------------
function conversa(socket, timeoutMs) {
  let buffer = '';
  let aguardando = null;

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (!aguardando) return;
    // resposta completa = última linha no formato "NNN <espaço>"
    const linhas = buffer.split(/\r?\n/).filter(Boolean);
    const ultima = linhas[linhas.length - 1] || '';
    if (/^\d{3} /.test(ultima)) {
      const texto = buffer;
      buffer = '';
      const r = aguardando; aguardando = null;
      r.resolve({ code: Number(ultima.slice(0, 3)), texto });
    }
  });

  const esperar = () => new Promise((resolve, reject) => {
    aguardando = { resolve, reject };
    const t = setTimeout(() => {
      if (aguardando) { aguardando = null; reject(erro('O servidor de e-mail não respondeu a tempo', 504)); }
    }, timeoutMs);
    const orig = resolve;
    aguardando.resolve = (v) => { clearTimeout(t); orig(v); };
  });

  return {
    esperar,
    async mandar(linha, okEsperado) {
      socket.write(linha + '\r\n');
      const r = await esperar();
      if (okEsperado && !okEsperado.includes(Math.floor(r.code / 100))) {
        // a linha do comando pode conter a senha; nunca vai para o erro
        throw erro(`SMTP recusou (${r.code}): ${String(r.texto).split(/\r?\n/)[0]}`, 502);
      }
      return r;
    }
  };
}

function conectar(host, port, secure, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect({ host, port, servername: host }, () => resolve(s))
      : net.connect({ host, port }, () => resolve(s));
    s.setTimeout(timeoutMs, () => { s.destroy(); reject(erro('Tempo esgotado ao conectar no servidor de e-mail', 504)); });
    s.on('error', (e) => reject(erro('Não foi possível falar com o servidor de e-mail: ' + e.message, 502)));
  });
}

// Cabeçalho com acento precisa ir codificado, senão o cliente mostra lixo.
function mime(txt) {
  const s = String(txt || '');
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=';
}

// Uma linha começando com "." encerraria o DATA no meio da mensagem.
function escaparPontos(corpo) {
  return String(corpo).split(/\r?\n/).map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
}

async function enviar({ to, subject, html, text }) {
  const c = cfg();
  if (!configured()) throw erro('O envio de e-mail não está configurado', 503);
  const destino = String(to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destino)) throw erro('E-mail inválido');

  const timeoutMs = 15000;
  let socket = await conectar(c.host, Number(c.port) || 587, !!c.secure, timeoutMs);
  let smtp = conversa(socket, timeoutMs);

  try {
    await smtp.esperar();                                   // saudação 220
    let r = await smtp.mandar('EHLO elitechat', [2]);

    // Porta 587: sobe para TLS antes de qualquer credencial.
    if (!c.secure && /STARTTLS/i.test(r.texto)) {
      await smtp.mandar('STARTTLS', [2]);
      socket = tls.connect({ socket, servername: c.host });
      await new Promise((res, rej) => { socket.once('secureConnect', res); socket.once('error', rej); });
      smtp = conversa(socket, timeoutMs);
      r = await smtp.mandar('EHLO elitechat', [2]);
    }

    if (c.user) {
      if (!c.secure && !/STARTTLS/i.test(r.texto) && !socket.encrypted) {
        throw erro('O servidor de e-mail não oferece TLS. Sem cifra a senha viajaria legível, então o envio foi cancelado.', 502);
      }
      if (/AUTH[^\n]*PLAIN/i.test(r.texto)) {
        const cred = Buffer.from('\0' + c.user + '\0' + c.pass, 'utf8').toString('base64');
        await smtp.mandar('AUTH PLAIN ' + cred, [2]);
      } else {
        await smtp.mandar('AUTH LOGIN', [3]);
        await smtp.mandar(Buffer.from(c.user, 'utf8').toString('base64'), [3]);
        await smtp.mandar(Buffer.from(c.pass, 'utf8').toString('base64'), [2]);
      }
    }

    await smtp.mandar(`MAIL FROM:<${c.from}>`, [2]);
    await smtp.mandar(`RCPT TO:<${destino}>`, [2]);
    await smtp.mandar('DATA', [3]);

    const limite = 'ec_' + Date.now().toString(36);
    const corpo = [
      `From: ${mime(c.fromName || 'EliteChat')} <${c.from}>`,
      `To: <${destino}>`,
      `Subject: ${mime(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${limite}"`,
      '',
      `--${limite}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(text || '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      `--${limite}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html || text || '', 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
      `--${limite}--`,
      ''
    ].join('\r\n');

    await smtp.mandar(escaparPontos(corpo) + '\r\n.', [2]);
    try { await smtp.mandar('QUIT', [2]); } catch {}
    socket.end();

    c.lastError = ''; c.lastOkAt = Date.now(); db.save();
    return { ok: true };
  } catch (e) {
    try { socket.destroy(); } catch {}
    c.lastError = String(e.message || e).slice(0, 200); db.save();
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Mensagens do produto. Ficam aqui para o texto não se espalhar pelas rotas.
// ---------------------------------------------------------------------------
const CAIXA = (titulo, linhas, codigo) => `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f7f2;padding:28px">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:28px">
    <h1 style="margin:0 0 14px;font-size:19px;color:#0f1f15">${titulo}</h1>
    ${linhas.map(l => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#41524a">${l}</p>`).join('')}
    ${codigo ? `<div style="margin:20px 0;text-align:center;font-size:30px;font-weight:800;letter-spacing:8px;color:#0b815a">${codigo}</div>` : ''}
    <p style="margin:18px 0 0;font-size:12px;color:#7b8a79">Se não foi você que pediu, ignore este e-mail.</p>
  </div>
</div>`;

function enviarCodigoVerificacao(email, codigo) {
  return enviar({
    to: email,
    subject: 'Confirme seu e-mail no EliteChat',
    text: `Seu código de confirmação é ${codigo}. Ele vale por 15 minutos.`,
    html: CAIXA('Confirme seu e-mail', ['Use o código abaixo para confirmar este endereço. Ele vale por 15 minutos.'], codigo)
  });
}

function enviarCodigoLogin(email, codigo) {
  return enviar({
    to: email,
    subject: 'Seu código de acesso ao EliteChat',
    text: `Seu código de acesso é ${codigo}. Ele vale por 10 minutos.`,
    html: CAIXA('Código de acesso', ['Alguém está entrando na sua conta. Use o código abaixo para concluir o acesso.'], codigo)
  });
}

// Para o admin: diz se está configurado, nunca a senha.
function adminView() {
  const c = cfg();
  return {
    enabled: !!c.enabled, host: c.host, port: c.port, secure: !!c.secure,
    user: c.user, hasPass: !!c.pass, from: c.from, fromName: c.fromName,
    configured: configured(), lastError: c.lastError || '', lastOkAt: c.lastOkAt || 0
  };
}

module.exports = {
  cfg, emptyConfig, configured, enviar, adminView,
  enviarCodigoVerificacao, enviarCodigoLogin
};
