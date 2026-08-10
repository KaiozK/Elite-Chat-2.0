// ============================================================================
// ARMAZENAMENTO EM ARQUIVO (padrão)
//
// O que mudou em relação ao original: a gravação é ATÔMICA.
//
// Antes, `flush()` fazia `writeFileSync` direto em data/db.json. Uma queda de
// energia ou um kill no meio da escrita deixava o arquivo pela metade, e o
// banco não abria mais — perda total, e sem depender de escala nenhuma.
//
// Agora escreve em .tmp, dá fsync e renomeia. Rename no mesmo volume é atômico:
// ou fica o arquivo antigo inteiro, ou o novo inteiro, nunca um pedaço. E as
// últimas cinco versões ficam guardadas, para o caso de o arquivo bom já ter
// sido substituído por um ruim.
// ============================================================================

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = DB_FILE + '.tmp';
const BACKUPS = 5;

function garantirPasta() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Lê o banco. Se o arquivo principal não parseia, tenta as cópias, da mais
// recente para a mais antiga: um banco de ontem é infinitamente melhor que
// nenhum banco.
function carregar() {
  garantirPasta();
  const candidatos = [DB_FILE];
  for (let i = 1; i <= BACKUPS; i++) candidatos.push(DB_FILE + '.' + i);

  for (const arquivo of candidatos) {
    if (!fs.existsSync(arquivo)) continue;
    try {
      const txt = fs.readFileSync(arquivo, 'utf8');
      if (!txt.trim()) continue;
      const dados = JSON.parse(txt);
      if (arquivo !== DB_FILE) {
        console.warn('[storage] db.json ilegível; recuperado de ' + path.basename(arquivo));
      }
      return dados;
    } catch (e) {
      console.error('[storage] ' + path.basename(arquivo) + ' não parseia: ' + e.message);
    }
  }
  return null;
}

function rodarBackups() {
  // db.json.4 → db.json.5, db.json.3 → db.json.4 …
  for (let i = BACKUPS - 1; i >= 1; i--) {
    const de = DB_FILE + '.' + i;
    const para = DB_FILE + '.' + (i + 1);
    if (fs.existsSync(de)) { try { fs.renameSync(de, para); } catch {} }
  }
  if (fs.existsSync(DB_FILE)) { try { fs.copyFileSync(DB_FILE, DB_FILE + '.1'); } catch {} }
}

let escritas = 0;

function gravar(db) {
  garantirPasta();
  // Uma cópia a cada 20 gravações: fazer a cada flush dobraria o custo de I/O
  // sem ganho real, já que o rename já protege contra arquivo truncado.
  if (escritas++ % 20 === 0) rodarBackups();

  const conteudo = JSON.stringify(db, null, 2);
  const fd = fs.openSync(TMP_FILE, 'w');
  try {
    fs.writeFileSync(fd, conteudo);
    fs.fsyncSync(fd);        // garante que os bytes saíram do cache do sistema
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(TMP_FILE, DB_FILE);
}

function fechar() { /* nada a fechar */ }

module.exports = { carregar, gravar, fechar, DB_FILE, DATA_DIR };
