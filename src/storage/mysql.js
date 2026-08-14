// ============================================================================
// ARMAZENAMENTO EM MYSQL
//
// O banco continua inteiro em memória (é o que os 262 pontos de escrita
// esperam), mas deixa de ser um arquivo único regravado por completo a cada
// mudança. Aqui ele é fatiado em PEDAÇOS e só o pedaço que mudou vai para o
// banco:
//
//   platform, plans, revenue, withdrawals, sessions, webhookLog,
//   loginChallenges          → um pedaço cada
//   cada conta               → um pedaço próprio ("account:<id>")
//
// Por que fatiar assim: o custo de gravar passa a ser proporcional AO QUE
// MUDOU, e não ao tamanho do banco. Uma mensagem nova numa conta grava aquela
// conta; as outras nem são tocadas. Com o arquivo único, a mesma mensagem
// reescrevia tudo.
//
// A comparação é feita sobre o JSON serializado do pedaço. Serializar já
// acontecia antes (para escrever o arquivo), então o custo de CPU é o mesmo; o
// que desaparece é a escrita — que é a parte cara quando o banco está na rede.
//
// Uma linha por pedaço, com o conteúdo em JSON. Não é normalização: é o mesmo
// modelo de hoje, guardado onde dá para replicar, fazer backup com ponto no
// tempo e, mais adiante, consultar por campo.
// ============================================================================

const mysql = require('mysql2/promise');

const TABELA = 'koonfy_state';

let pool = null;
let ultimo = new Map();     // pedaço -> JSON já gravado (evita reescrever igual)
let pendente = Promise.resolve();

function url() {
  const u = process.env.DATABASE_URL || process.env.MYSQL_URL;
  if (!u) throw new Error('DB_DRIVER=mysql exige DATABASE_URL (mysql://usuario:senha@host:3306/banco)');
  return u;
}

// ---------------------------------------------------------------------------
// TLS
//
// Banco gerenciado (DigitalOcean, Aiven, PlanetScale) recusa conexão em texto
// claro: sem TLS a resposta é "Connections using insecure transport are
// prohibited", e nada mais funciona. A string que a DigitalOcean entrega vem
// com `?ssl-mode=REQUIRED`, que o mysql2 não interpreta sozinho — é preciso
// passar a opção `ssl` explicitamente.
//
// Com o certificado da autoridade (DATABASE_CA) a identidade do servidor é
// verificada de verdade. Sem ele o tráfego continua cifrado, mas ninguém
// confere com QUEM se está falando; por isso o aviso no log.
// ---------------------------------------------------------------------------
function opcoesTls(uri) {
  const caBruto = (process.env.DATABASE_CA || '').trim();
  const pedidoNaUri = /[?&](ssl-mode|sslmode|ssl_mode)=(required|verify_ca|verify_identity|true|1)/i.test(uri);
  const pedidoNoEnv = /^(1|true|required|yes)$/i.test(String(process.env.DB_SSL || '').trim());
  if (!caBruto && !pedidoNaUri && !pedidoNoEnv) return null;

  if (caBruto) {
    // Aceita o PEM inteiro na variável ou o caminho de um arquivo.
    let ca = caBruto;
    if (!caBruto.includes('BEGIN CERTIFICATE')) {
      try { ca = require('fs').readFileSync(caBruto, 'utf8'); }
      catch (e) { throw new Error('DATABASE_CA não é um certificado nem um arquivo legível: ' + e.message); }
    }
    return { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  }
  console.warn('[storage/mysql] TLS ligado SEM certificado da autoridade: o tráfego vai cifrado, ' +
    'mas o servidor não é verificado. Baixe o CA do painel do banco e informe em DATABASE_CA.');
  return { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
}

// O mysql2 lê a URI, mas engasga com parâmetros que não são dele (`ssl-mode` é
// da própria DigitalOcean). Some com eles depois de já terem sido lidos.
function limparUri(uri) {
  return uri.replace(/([?&])(ssl-mode|sslmode|ssl_mode)=[^&]*/gi, '$1')
    .replace(/[?&]$/, '')
    .replace(/\?&/, '?');
}

function conectar() {
  if (pool) return pool;
  const uri = url();
  const ssl = opcoesTls(uri);
  pool = mysql.createPool({
    uri: limparUri(uri),
    waitForConnections: true,
    connectionLimit: 6,
    charset: 'utf8mb4',          // emoji de WhatsApp não cabe no utf8 de 3 bytes
    timezone: 'Z',
    enableKeepAlive: true,
    ...(ssl ? { ssl } : {})
  });
  return pool;
}

async function criarTabela() {
  await conectar().query(
    'CREATE TABLE IF NOT EXISTS ' + TABELA + ' (' +
    '  chunk VARCHAR(80) NOT NULL PRIMARY KEY,' +
    '  data  LONGTEXT NOT NULL,' +          // JSON puro: o driver não reinterpreta
    '  updated_at BIGINT NOT NULL' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci'
  );
}

// ---------------------------------------------------------------------------
// Fatiamento
//
// `accounts` é o único array que vira vários pedaços: é ele que cresce sem
// limite e o que quase toda escrita toca. O resto é pequeno e muda pouco.
// ---------------------------------------------------------------------------
const TOPO = ['platform', 'plans', 'revenue', 'withdrawals', 'sessions', 'webhookLog', 'loginChallenges'];

function fatiar(db) {
  const pedacos = new Map();
  for (const k of TOPO) if (db[k] !== undefined) pedacos.set(k, db[k]);
  // guarda a ordem das contas: `accounts` é um array e a ordem importa em
  // algumas telas (a primeira conta é a do canal padrão em código antigo)
  pedacos.set('__accounts_order', (db.accounts || []).map(a => a.id));
  for (const acc of db.accounts || []) pedacos.set('account:' + acc.id, acc);
  return pedacos;
}

function juntar(linhas) {
  const mapa = new Map(linhas.map(r => [r.chunk, r.data]));
  if (!mapa.size) return null;

  const db = {};
  for (const k of TOPO) if (mapa.has(k)) db[k] = JSON.parse(mapa.get(k));

  const ordem = mapa.has('__accounts_order') ? JSON.parse(mapa.get('__accounts_order')) : [];
  const contas = [];
  const vistas = new Set();
  for (const id of ordem) {
    const raw = mapa.get('account:' + id);
    if (raw) { contas.push(JSON.parse(raw)); vistas.add('account:' + id); }
  }
  // conta gravada sem entrar na ordem (corrida na gravação) não pode sumir
  for (const [chave, raw] of mapa) {
    if (chave.startsWith('account:') && !vistas.has(chave)) contas.push(JSON.parse(raw));
  }
  db.accounts = contas;
  return db;
}

// ---------------------------------------------------------------------------
async function carregar() {
  await criarTabela();
  const [linhas] = await conectar().query('SELECT chunk, data FROM ' + TABELA);
  if (!linhas.length) return null;
  // guarda o que veio, para a primeira gravação não reescrever tudo
  ultimo = new Map(linhas.map(r => [r.chunk, r.data]));
  return juntar(linhas);
}

// A gravação é assíncrona, mas `db.save()` é síncrono para quem chama. Então as
// gravações são ENFILEIRADAS: duas mutações seguidas não disputam a conexão nem
// chegam fora de ordem.
function gravar(db) {
  pendente = pendente.then(() => gravarAgora(db)).catch(e => {
    console.error('[storage/mysql] falha ao gravar:', e.message);
  });
  return pendente;
}

async function gravarAgora(db) {
  await criarTabela();
  const pedacos = fatiar(db);
  const agora = Date.now();

  const mudados = [];
  for (const [chave, valor] of pedacos) {
    const json = JSON.stringify(valor);
    if (ultimo.get(chave) === json) continue;   // idêntico: não vai para o banco
    mudados.push([chave, json, agora]);
  }
  // conta apagada some da memória: some do banco também
  const sumiram = [...ultimo.keys()].filter(k => !pedacos.has(k));

  if (!mudados.length && !sumiram.length) return;

  const cx = await conectar().getConnection();
  try {
    await cx.beginTransaction();
    if (mudados.length) {
      await cx.query(
        'INSERT INTO ' + TABELA + ' (chunk, data, updated_at) VALUES ? ' +
        'ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)',
        [mudados]
      );
    }
    if (sumiram.length) {
      await cx.query('DELETE FROM ' + TABELA + ' WHERE chunk IN (?)', [sumiram]);
    }
    await cx.commit();
  } catch (e) {
    try { await cx.rollback(); } catch {}
    throw e;
  } finally {
    cx.release();
  }

  // só depois do commit o cache passa a valer: se a transação falhar, a próxima
  // gravação tenta de novo em vez de achar que já gravou
  for (const [chave, json] of mudados) ultimo.set(chave, json);
  for (const chave of sumiram) ultimo.delete(chave);
}

async function fechar() {
  try { await pendente; } catch {}
  if (pool) { await pool.end(); pool = null; }
}

// Usado pelo script de migração e pelo de conferência.
async function apagarTudo() {
  await criarTabela();
  await conectar().query('DELETE FROM ' + TABELA);
  ultimo = new Map();
}

async function estatisticas() {
  await criarTabela();
  const [linhas] = await conectar().query(
    'SELECT chunk, LENGTH(data) AS bytes, updated_at FROM ' + TABELA + ' ORDER BY bytes DESC'
  );
  return linhas;
}

module.exports = { carregar, gravar, fechar, apagarTudo, estatisticas, TABELA, fatiar, juntar };
