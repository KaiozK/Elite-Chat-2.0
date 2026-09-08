#!/usr/bin/env node
// ============================================================================
// MIGRAÇÃO: data/db.json  →  MySQL
//
//   node scripts/migrar-mysql.js "mysql://usuario:senha@host:3306/koonfy"
//
// O que ele faz, nesta ordem:
//   1. lê o db.json (ou o backup, se o principal estiver ilegível)
//   2. apaga o que houver no MySQL e grava tudo
//   3. LÊ DE VOLTA e compara pedaço por pedaço com a origem
//
// O passo 3 é o que importa. Sem conferir, a migração "termina com sucesso" e o
// erro só aparece dias depois, com o cliente dentro. Se sobrar qualquer
// diferença, o script sai com erro e diz onde.
//
// Não apaga nem move o db.json: até a virada estar confirmada, ele continua
// sendo o banco bom.
// ============================================================================

const path = require('path');

const url = process.argv[2] || process.env.DATABASE_URL;
if (!url) {
  console.error('Uso: node scripts/migrar-mysql.js "mysql://usuario:senha@host:3306/banco"');
  process.exit(1);
}
process.env.DATABASE_URL = url;

const arquivo = require(path.join(__dirname, '..', 'src', 'storage', 'file'));
const mysql = require(path.join(__dirname, '..', 'src', 'storage', 'mysql'));

// Comparação estável: a ordem das chaves de um objeto não deve contar como
// diferença, então serializa com as chaves ordenadas.
function estavel(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(estavel).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + estavel(v[k])).join(',') + '}';
}

(async () => {
  console.log('1/4  Lendo data/db.json…');
  const origem = arquivo.carregar();
  if (!origem) { console.error('     Nenhum banco encontrado em data/. Nada a migrar.'); process.exit(1); }
  const contas = (origem.accounts || []).length;
  console.log('     ' + contas + ' conta(s), ' + (origem.plans || []).length + ' plano(s), ' +
    (origem.revenue || []).length + ' pagamento(s)');

  // ------------------------------------------------------------------------
  // A TRAVA QUE FALTAVA: NUNCA APAGAR DADO BOM COM UM ARQUIVO VAZIO.
  //
  // O passo seguinte apaga o destino inteiro antes de gravar. Isso está certo
  // numa migração — o MySQL ainda não tem nada. Mas o script é rodado de novo
  // com o tempo: depois de trocar de servidor, ao repetir um passo do manual,
  // ou por engano.
  //
  // E aqui está o perigo real deste projeto: em host de container o
  // `data/db.json` é RECRIADO a cada deploy. Rodar a migração depois de um
  // deploy significa ler um arquivo praticamente vazio — e, sem esta trava,
  // apagar o MySQL de produção e gravar o vazio por cima. Um comando, e a base
  // de clientes some.
  //
  // Então: se o destino tem MAIS contas do que a origem, o script PARA e pede
  // confirmação explícita. Migração de verdade nunca reduz o número de contas;
  // reduzir é o sintoma de estar lendo o arquivo errado.
  // ------------------------------------------------------------------------
  let jaLa = null;
  try { jaLa = await mysql.carregar(); } catch (e) { jaLa = null; }
  const contasDestino = (jaLa && (jaLa.accounts || []).length) || 0;
  if (contasDestino > contas && process.argv[3] !== '--sobrescrever') {
    console.error('');
    console.error('  PARADO, e de propósito.');
    console.error('  O MySQL já tem ' + contasDestino + ' conta(s) e o data/db.json tem ' + contas + '.');
    console.error('  Gravar agora APAGARIA as ' + contasDestino + ' e deixaria ' + contas + ' no lugar.');
    console.error('');
    console.error('  Em host de container o db.json é recriado a cada deploy — se a migração');
    console.error('  já foi feita, o MySQL é o banco bom e este arquivo é o vazio.');
    console.error('');
    console.error('  Se você tem certeza de que quer substituir, repita com --sobrescrever.');
    process.exit(1);
  }

  console.log('2/4  Limpando o destino e gravando…');
  if (contasDestino) console.log('     (o destino tinha ' + contasDestino + ' conta(s) e será substituído)');
  await mysql.apagarTudo();
  await mysql.gravar(origem);
  await new Promise(r => setTimeout(r, 200));   // a gravação é enfileirada

  console.log('3/4  Lendo de volta do MySQL…');
  // zera o cache para a leitura não vir da memória do processo
  const destino = await mysql.carregar();
  if (!destino) { console.error('     O MySQL voltou vazio. Migração FALHOU.'); process.exit(1); }

  console.log('4/4  Conferindo campo a campo…');
  const problemas = [];

  const chaves = new Set([...Object.keys(origem), ...Object.keys(destino)]);
  for (const k of chaves) {
    if (k === 'accounts') continue;             // conferido uma a uma abaixo
    if (estavel(origem[k]) !== estavel(destino[k])) problemas.push('bloco "' + k + '" diferente');
  }

  const porId = new Map((destino.accounts || []).map(a => [a.id, a]));
  if ((destino.accounts || []).length !== contas) {
    problemas.push('contas: ' + contas + ' na origem, ' + (destino.accounts || []).length + ' no destino');
  }
  for (const a of origem.accounts || []) {
    const b = porId.get(a.id);
    if (!b) { problemas.push('conta ausente no destino: ' + a.email); continue; }
    if (estavel(a) !== estavel(b)) {
      // aponta QUAL campo, não só "a conta está diferente"
      const difs = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter(k => estavel(a[k]) !== estavel(b[k]));
      problemas.push('conta ' + a.email + ': ' + difs.join(', '));
    }
  }

  const stats = await mysql.estatisticas();
  const total = stats.reduce((n, r) => n + Number(r.bytes || 0), 0);

  await mysql.fechar();

  console.log('');
  if (problemas.length) {
    console.error('MIGRAÇÃO FALHOU. ' + problemas.length + ' diferença(s):');
    problemas.slice(0, 20).forEach(p => console.error('  - ' + p));
    console.error('\nO data/db.json NÃO foi tocado. Corrija e rode de novo.');
    process.exit(1);
  }

  console.log('MIGRAÇÃO CONFERIDA. Nenhuma diferença.');
  console.log('  ' + stats.length + ' pedaço(s), ' + (total / 1024).toFixed(1) + ' KB no MySQL');
  console.log('  maiores: ' + stats.slice(0, 3).map(r => r.chunk + ' (' + (r.bytes / 1024).toFixed(1) + ' KB)').join(', '));
  console.log('');
  console.log('Para o servidor passar a usar o MySQL:');
  console.log('  DB_DRIVER=mysql  DATABASE_URL="' + url.replace(/:\/\/[^@]*@/, '://***@') + '"  npm start');
  console.log('');
  console.log('O data/db.json continua onde estava. Guarde-o até a virada estar confirmada.');
})().catch(e => {
  console.error('\nERRO:', e.message);
  process.exit(1);
});
