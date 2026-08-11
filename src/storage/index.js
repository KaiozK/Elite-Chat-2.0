// ============================================================================
// ARMAZENAMENTO
//
// O Koonfy mantém o banco inteiro em memória e chama `db.save()` depois de cada
// mutação — são 262 chamadas espalhadas por 24 módulos. Reescrever todas elas
// para falar SQL seria reescrever o produto junto com a migração, e aí não se
// saberia qual das duas coisas quebrou.
//
// Então o que muda é só ONDE a memória é gravada. A interface é a mesma para os
// dois motores:
//
//   carregar()        -> objeto do banco (ou null, se ainda não existe)
//   gravar(db)        -> persiste o estado atual
//   fechar()          -> encerra conexões
//
// O motor é escolhido por variável de ambiente:
//
//   DB_DRIVER=file    (padrão)  data/db.json, com escrita atômica
//   DB_DRIVER=mysql             DATABASE_URL=mysql://user:senha@host:3306/koonfy
//
// O padrão continua sendo o arquivo: quem não configurar nada não percebe
// diferença nenhuma.
// ============================================================================

const driver = String(process.env.DB_DRIVER || 'file').toLowerCase();

let motor;
if (driver === 'mysql') motor = require('./mysql');
else motor = require('./file');

motor.nome = driver === 'mysql' ? 'mysql' : 'file';

// Nenhum host anuncia "meu disco é descartável", mas todos se identificam por
// variáveis de ambiente próprias. Com o motor `file` nesses hosts, o banco
// volta ao estado da imagem a cada deploy/restart — inclusive a senha do
// admin. Erra para o lado do alarme falso: um aviso a mais é barato, perder o
// banco não é.
motor.ehContainerEfemero = function () {
  return !!(process.env.DIGITALOCEAN_APP_ID || process.env.APP_DOMAIN        // DO App Platform
    || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER                 // Railway / Render
    || process.env.DYNO || process.env.VERCEL || process.env.K_SERVICE);     // Heroku / Vercel / Cloud Run
};
motor.efemero = function () { return motor.nome === 'file' && motor.ehContainerEfemero(); };

module.exports = motor;
