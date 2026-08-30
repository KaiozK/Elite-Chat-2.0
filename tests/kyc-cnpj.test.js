// ============================================================================
// VERIFICAÇÃO DE CNPJ: O DOCUMENTO DA EMPRESA
//
// Pedia-se só o documento da PESSOA — RG/CNH e o rosto segurando ele. Para
// pessoa física isso basta. Para CNPJ, não: o dinheiro entra na conta de uma
// EMPRESA, e a CNH de alguém não prova que aquele CNPJ existe, que está ativo,
// nem que é ela quem responde por ele. Aprovava-se uma empresa olhando o
// documento de uma pessoa.
//
// Agora o CNPJ exige também o Cartão CNPJ (Comprovante de Inscrição e de
// Situação Cadastral) ou o CCMEI, no caso do MEI — os dois documentos que a
// Receita emite na hora, de graça, e que trazem CNPJ, razão social, situação
// cadastral e o responsável.
//
// A exigência é do SERVIDOR, e não da tela: exigência que mora na interface se
// contorna chamando a rota na mão.
// ============================================================================
const R = 'C:/Users/amand/Desktop/Elite Projects/whatsapp-crm/';
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m); if (!c) falhas++; };
const encerrar = require('./_fim');

const Module = require('module');
const tabela = new Map();
function executar(sql, params) {
  if (/^CREATE TABLE/i.test(sql)) return [[], []];
  if (/^SELECT chunk, data/i.test(sql)) return [[...tabela].map(([chunk, v]) => ({ chunk, data: v })), []];
  if (/^SELECT chunk, LENGTH/i.test(sql)) return [[...tabela].map(([chunk, v]) => ({ chunk, bytes: v.length })), []];
  if (/^INSERT INTO/i.test(sql)) { for (const [c, d] of params[0]) tabela.set(c, d); return [{}, []]; }
  if (/WHERE chunk IN/i.test(sql)) { for (const c of params[0]) tabela.delete(c); return [{}, []]; }
  if (/^DELETE FROM/i.test(sql)) { tabela.clear(); return [{}, []]; }
  return [[], []];
}
const cx = { query: async (a, b) => executar(a, b), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} };
const pool = { query: async (a, b) => executar(a, b), getConnection: async () => cx, end: async () => {} };
const origLoad = Module._load;
Module._load = function (m) { if (m === 'mysql2/promise') return { createPool: () => pool }; return origLoad.apply(this, arguments); };
process.env.DB_DRIVER = 'mysql';
process.env.DATABASE_URL = 'mysql://u:p@localhost/koonfy';

const fs = require('fs');
const db = require(R + 'src/db');
const kyc = require(R + 'src/kyc');

// Um "arquivo" mínimo e válido — o que importa aqui é qual peça é exigida.
const FOTO = { mime: 'image/jpeg', data: Buffer.from('x'.repeat(300)).toString('base64') };

(async () => {
  await db.loadAsync();

  console.log('=== 1. Pessoa física continua com duas fotos ===');
  const pf = kyc.pecasPara('11144477735').map(p => p.id);
  ok(pf.join(',') === 'documento,selfie', 'documento e rosto: ' + pf.join(', '));

  console.log('\n=== 2. CNPJ passa a exigir o documento DA EMPRESA ===');
  const pj = kyc.pecasPara('11222333000181').map(p => p.id);
  ok(pj.join(',') === 'documento,selfie,empresa', 'as três: ' + pj.join(', '));
  const emp = kyc.pecasPara('11222333000181')[2];
  ok(/Cartão CNPJ/i.test(emp.nome) && /CCMEI/i.test(emp.nome), 'o nome diz os dois: ' + emp.nome);
  // O MEI não tem Cartão CNPJ no mesmo formato: tem o CCMEI. Não citar os dois
  // faria metade dos clientes procurar um documento que não existe para eles.
  ok(/CCMEI/.test(emp.ajuda) && /Receita/i.test(emp.ajuda),
     'e a ajuda explica onde tirar, de graça');
  ok(/nome no documento precisa bater/i.test(emp.ajuda),
     'e o que precisa conferir: ' + emp.ajuda);

  // Documento com pontuação e MEI (CNPJ termina em 0001-XX) caem no mesmo lugar.
  ok(kyc.pecasPara('11.222.333/0001-81').length === 3, 'com pontuação, mesmo resultado');
  ok(kyc.pecasPara('').length === 2, 'sem documento, o mínimo — não trava quem ainda não preencheu');

  console.log('\n=== 3. A EXIGÊNCIA É DO SERVIDOR ===');
  // Mandar só as duas fotos, como a tela antiga mandava, tem de ser recusado.
  const contaPJ = db.newAccount({ name: 'Empresa Ltda', email: 'pj@ex.com', pass: 'segredo123' });
  contaPJ.profile.document = '11222333000181';
  contaPJ.profile.phone = '5511988887777';
  db.get().accounts.push(contaPJ);
  db.save();

  const dados = {
    nome: 'Fulano Responsável', documento: '11222333000181',
    email: 'pj@ex.com', telefone: '11988887777',
    cep: '01001000', endereco: 'Rua A', numero: '1', cidade: 'São Paulo', uf: 'SP'
  };

  let erro = '';
  try {
    kyc.enviar(contaPJ, { dados, fotos: { documento: FOTO, selfie: FOTO } });
  } catch (e) { erro = e.message; }
  ok(/Cartão CNPJ|CCMEI/i.test(erro), 'sem o cartão da empresa, recusa: ' + erro);
  ok(kyc.visaoCliente(contaPJ).status === 'nao_enviado', 'e nada entra em análise');

  console.log('\n=== 4. Com as três, o envio passa ===');
  kyc.enviar(contaPJ, { dados, fotos: { documento: FOTO, selfie: FOTO, empresa: FOTO } });
  ok(kyc.visaoCliente(contaPJ).status === 'em_analise', 'entra na fila');

  console.log('\n=== 5. E o ADMIN vê a foto da empresa ===');
  // Com a lista fixa de duas, o cartão da empresa era guardado e escondido
  // justamente de quem precisa conferi-lo.
  const ficha = kyc.fichaAdmin ? kyc.fichaAdmin(contaPJ) : null;
  if (ficha) {
    ok(!!ficha.fotos.empresa, 'a terceira foto aparece na ficha');
    ok(Object.keys(ficha.fotos).length === 3, `com as três: ${Object.keys(ficha.fotos).length}`);
  } else {
    const src = fs.readFileSync(R + 'src/kyc.js', 'utf8');
    ok(/pecasPara\(\(k\.dados \|\| preenchido\(acc\) \|\| \{\}\)\.documento\)/.test(src),
       'a ficha do admin monta as fotos pelo documento do envio');
  }

  console.log('\n=== 6. Pessoa física NÃO é obrigada a mandar cartão de empresa ===');
  const contaPF = db.newAccount({ name: 'Fulana', email: 'pf@ex.com', pass: 'segredo123' });
  contaPF.profile.document = '11144477735';
  contaPF.profile.phone = '5511977776666';
  db.get().accounts.push(contaPF);
  db.save();
  kyc.enviar(contaPF, {
    dados: { ...dados, documento: '11144477735', email: 'pf@ex.com', nascimento: '1990-05-10' },
    fotos: { documento: FOTO, selfie: FOTO }
  });
  ok(kyc.visaoCliente(contaPF).status === 'em_analise', 'as duas bastam para CPF');
  ok(kyc.visaoCliente(contaPF).pecas.length === 2, 'e a tela dela pede duas');

  console.log('\n=== 7. A TELA desenha o que o servidor manda ===');
  const app = fs.readFileSync(R + 'public/app/app.js', 'utf8');
  ok(/k\.pecas\.map\(p =>/.test(app), 'o formulário monta as caixas a partir de `pecas`');
  ok(/k\.pecas\.length > 2/.test(app), 'e o texto acompanha: três fotos, três explicações');
  ok(/Object\.keys\(f\.fotos\)\.map/.test(app),
     'a ficha do admin mostra as fotos que vieram, e não duas fixas');
  ok(/Cartão CNPJ ou CCMEI/.test(app), 'com o rótulo da terceira');

  console.log('\n=== 8. O SUPORTE está na barra e no rodapé da vitrine ===');
  const idx = fs.readFileSync(R + 'public/app/index.html', 'utf8');
  ok(/id="nav-suporte"/.test(idx), 'a barra lateral do app tem o link');
  ok(/class="nav-suporte hidden"/.test(idx),
     'que nasce escondido — link para quem não atende é pior do que não ter link');
  ok(/function pintarSuporte/.test(app) && /pintarSuporte\(st\.suporte\)/.test(app),
     'e só aparece com número configurado no Admin');

  const nova = fs.readFileSync(R + 'public/nova.html', 'utf8');
  ok(/id="rodape-suporte"/.test(nova), 'a vitrine tem o link no rodapé');
  ok(/class="oculto"/.test(nova.slice(nova.indexOf('rodape-suporte') - 120, nova.indexOf('rodape-suporte') + 60)),
     'também escondido por padrão');
  ok(/api\/public\/landing/.test(nova) && /rodape-suporte/.test(nova),
     'lendo da rota que a página já busca, sem um segundo pedido');

  const api = fs.readFileSync(R + 'src/api.js', 'utf8');
  ok(/suporte: \(\(\) => \{/.test(api), 'e o app recebe o número em /settings, que ele já chama ao abrir');

  await encerrar(null, falhas);
})();
