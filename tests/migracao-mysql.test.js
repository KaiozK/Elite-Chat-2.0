// ============================================================================
// A MIGRAÇÃO data/db.json → MySQL
//
// É um comando que roda uma vez, com a base de clientes inteira dentro. Ele
// APAGA o destino antes de gravar — o que está certo numa migração, porque o
// MySQL ainda não tem nada.
//
// O PERIGO ESTÁ NA SEGUNDA VEZ. O script é rodado de novo com o tempo: ao
// trocar de servidor, ao repetir um passo do manual, por engano. E neste
// projeto há um agravante: em host de container o `data/db.json` é RECRIADO a
// cada deploy. Rodar a migração depois de um deploy é ler um arquivo vazio — e
// gravar esse vazio por cima do MySQL de produção. Um comando, e a base some.
//
// Este arquivo tranca isso: se o destino tem mais contas que a origem, o script
// para e exige `--sobrescrever`. Migração de verdade nunca REDUZ o número de
// contas; reduzir é o sintoma de estar lendo o arquivo errado.
// ============================================================================
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const R = path.join(__dirname, '..');

// Um MySQL de mentira, no mesmo formato que o driver real usa (chunks de JSON).
// Vive num arquivo para sobreviver entre as execuções do script.
const COFRE = path.join(require('os').tmpdir(), 'koonfy-migracao-teste.json');
const falso = path.join(require('os').tmpdir(), 'koonfy-mysql-falso.js');
fs.writeFileSync(falso, `
const fs = require('fs');
const COFRE = ${JSON.stringify(COFRE)};
function ler() { try { return JSON.parse(fs.readFileSync(COFRE, 'utf8')); } catch { return null; } }
const tabela = { rows: [] };
module.exports = {
  createPool: () => ({
    query: async (sql, params) => {
      if (/^CREATE TABLE/i.test(sql)) return [[], []];
      if (/^SELECT chunk, data/i.test(sql)) return [tabela.rows, []];
      if (/^SELECT chunk, LENGTH/i.test(sql)) return [tabela.rows.map(r => ({ chunk: r.chunk, bytes: r.data.length })), []];
      if (/^INSERT INTO/i.test(sql)) { for (const [c, d] of params[0]) tabela.rows.push({ chunk: c, data: d }); return [{}, []]; }
      if (/^DELETE FROM/i.test(sql)) { tabela.rows.length = 0; return [{}, []]; }
      return [[], []];
    },
    getConnection: async () => ({
      query: async (...a) => module.exports.createPool().query(...a),
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}
    }),
    end: async () => { fs.writeFileSync(COFRE, JSON.stringify(tabela.rows)); }
  })
};
// carrega o estado anterior, se houver
const antes = ler(); if (Array.isArray(antes)) tabela.rows.push(...antes);
`);

const ARQ = path.join(R, 'data', 'db.json');
const original = fs.existsSync(ARQ) ? fs.readFileSync(ARQ) : null;
const devolver = () => {
  try { if (original) fs.writeFileSync(ARQ, original); } catch {}
  try { fs.unlinkSync(COFRE); } catch {}
  try { fs.unlinkSync(falso); } catch {}
};
process.on('exit', devolver);
process.on('uncaughtException', e => { devolver(); console.error(e); process.exit(1); });

function rodar(args) {
  try {
    return { ok: true, saida: execFileSync(process.execPath,
      ['-r', falso.replace(/\\/g, '/'), path.join(R, 'scripts', 'migrar-mysql.js'), ...args],
      { cwd: R, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_PATH: process.env.NODE_PATH || '' } }) };
  } catch (e) {
    return { ok: false, saida: String(e.stdout || '') + String(e.stderr || '') };
  }
}

(async () => {
  console.log('=== 1. Sem endereço do banco, não faz nada ===');
  // Um script que apaga o destino não pode adivinhar para onde escrever.
  const semUrl = rodar([]);
  ok(!semUrl.ok && /Uso: node scripts\/migrar-mysql\.js/.test(semUrl.saida),
     'ele explica como se usa, em vez de tentar', semUrl.saida.trim().split('\n')[0]);

  console.log('\n=== 2. A trava contra apagar dado bom ===');
  // Este é o cenário que destrói uma empresa: o MySQL cheio, o db.json vazio
  // porque o container foi recriado no deploy, e alguém roda a migração.
  const script = fs.readFileSync(path.join(R, 'scripts', 'migrar-mysql.js'), 'utf8');
  ok(/const contasDestino = /.test(script), 'o script olha quantas contas já existem no destino');
  ok(/if \(contasDestino > contas && process\.argv\[3\] !== '--sobrescrever'\)/.test(script),
     'e PARA se gravar fosse reduzir o número de contas');
  ok(/process\.exit\(1\)/.test(script.slice(script.indexOf('PARADO, e de propósito'))),
     'saindo com erro, não com aviso — aviso em terminal ninguém lê');
  ok(/--sobrescrever/.test(script),
     'com uma saída explícita para quem realmente quer substituir');
  ok(script.indexOf('const contasDestino') < script.indexOf('await mysql.apagarTudo()'),
     'e a checagem vem ANTES de apagar qualquer coisa');

  console.log('\n=== 3. A migração confere o que gravou ===');
  // Sem conferir, a migração "termina com sucesso" e o erro só aparece dias
  // depois, com o cliente dentro.
  ok(/3\/4  Lendo de volta do MySQL/.test(script), 'ela relê do MySQL depois de gravar');
  ok(/4\/4  Conferindo campo a campo/.test(script), 'e compara campo a campo com a origem');
  ok(/MIGRAÇÃO FALHOU/.test(script) && /problemas\.length/.test(script),
     'qualquer diferença faz o script falhar e dizer onde');
  ok(/O data\/db\.json NÃO foi tocado/.test(script),
     'e o arquivo de origem nunca é apagado: até a virada estar confirmada, ele é o banco bom');

  console.log('\n=== 4. O aviso do disco efêmero existe nos dois lugares ===');
  // É o que teria evitado a perda: o log da partida e o topo do Admin.
  const srv = fs.readFileSync(path.join(R, 'server.js'), 'utf8');
  ok(/db\.storage\.efemero\(\)/.test(srv), 'o servidor avisa na partida');
  ok(/ATENÇÃO: disco efêmero \+ banco em arquivo/.test(srv), 'com todas as letras');
  const app = fs.readFileSync(path.join(R, 'public', 'app', 'app.js'), 'utf8');
  ok(/function armazenamentoAviso/.test(app), 'e o Admin mostra no topo da tela');
  ok(/Os dados se perdem a cada restart/.test(app),
     'porque ninguém lê o log do servidor', 'aviso visível no painel');

  await encerrar(null, falhas);
})();
