// ============================================================================
// KYC DO KOONPAY — conferência manual, feita por gente
//
// Antes de uma conta receber dinheiro pelo Koonfy, alguém precisa olhar quem
// ela é. Este módulo é esse caminho, e ele é DELIBERADAMENTE manual: a análise
// é o admin abrindo a foto e comparando com o documento. Não há score, não há
// automação, e é assim que deve ser enquanto o volume permitir — um "aprovado
// automaticamente" mal calibrado custa chargeback e conta bloqueada.
//
// O caminho, do lado do cliente:
//
//   1. CONFERIR — os dados já estão preenchidos com o que ele digitou no
//      cadastro do Koonfy. Ele confirma ou corrige. Pedir de novo o que já foi
//      dado é o jeito mais rápido de fazer alguém desistir no meio.
//   2. ENVIAR — foto do documento e foto do rosto SEGURANDO o documento. As
//      duas, sempre: a segunda é a que liga o documento à pessoa, e sozinha a
//      primeira só prova que ele tem uma foto de um documento.
//   3. ESPERAR — a conta fica EM ANÁLISE e não recebe pagamento até alguém
//      aprovar.
//
// E do lado do admin: a aba KYC, com a ficha inteira da conta ao lado das
// fotos, e dois botões.
//
// ONDE AS FOTOS FICAM. Em `db.kycArquivos[accId]`, que é um pedaço PRÓPRIO no
// banco (ver src/storage/mysql.js). Dentro da conta elas seriam reescritas a
// cada mensagem recebida — centenas de KB de tráfego para regravar bytes
// idênticos. Fora dela, são gravadas uma vez e nunca mais.
// ============================================================================

const db = require('./db');
const store = require('./store');
const documento = require('./documento');

// Os estados possíveis. `nao_enviado` não é um valor guardado: é a ausência de
// KYC, e existe aqui só para a tela ter um nome para ele.
const ESTADOS = ['nao_enviado', 'em_analise', 'aprovado', 'reprovado'];

// 1,6 MB por foto, já em base64. A tela reduz a imagem antes de enviar (é foto
// de celular, chega com 4000px e 6 MB), então este teto é a rede de segurança
// contra quem chama a rota na mão — e não o tamanho esperado.
const MAX_BYTES = 1_600_000;
const MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// As duas fotos, e por que cada uma existe.
const PECAS = [
  { id: 'documento', nome: 'Documento',
    ajuda: 'RG, CNH ou outro documento oficial com foto. A frente, inteira e legível.' },
  { id: 'selfie', nome: 'Rosto com o documento',
    ajuda: 'Uma foto sua segurando o documento ao lado do rosto, com os dois visíveis.' }
];

function ensure(acc) {
  const ep = require('./pagamentos').ensure(acc);
  if (!ep.kycManual || typeof ep.kycManual !== 'object') ep.kycManual = vazio();
  for (const [k, v] of Object.entries(vazio())) if (ep.kycManual[k] === undefined) ep.kycManual[k] = v;
  return ep.kycManual;
}

function vazio() {
  return {
    status: 'nao_enviado',
    dados: null,          // o que o cliente confirmou
    enviadoEm: 0,
    revisadoEm: 0,
    revisadoPor: '',      // quem no admin decidiu
    motivo: '',           // por que reprovou — o cliente lê isto
    tentativas: 0
  };
}

// ---------------------------------------------------------------------------
// OS ARQUIVOS
// ---------------------------------------------------------------------------
function arquivos(accId) {
  const d = db.get();
  if (!d.kycArquivos || typeof d.kycArquivos !== 'object') d.kycArquivos = {};
  return d.kycArquivos[accId] || null;
}

function guardarArquivos(accId, pecas) {
  const d = db.get();
  if (!d.kycArquivos || typeof d.kycArquivos !== 'object') d.kycArquivos = {};
  d.kycArquivos[accId] = pecas;
}

function apagarArquivos(accId) {
  const d = db.get();
  if (d.kycArquivos) delete d.kycArquivos[accId];
}

// ---------------------------------------------------------------------------
// O QUE A TELA DO CLIENTE MOSTRA PRÉ-PREENCHIDO
//
// Tudo isto o Koonfy já tem, do cadastro e da conta de recebimento. O cliente
// confere e corrige; não digita de novo.
// ---------------------------------------------------------------------------
function preenchido(acc) {
  const ep = require('./pagamentos').ensure(acc);
  const sub = ep.subaccount || {};
  const pf = acc.profile || {};
  const k = ensure(acc);
  const d = k.dados || {};
  const doc = String(d.documento || sub.document || pf.document || '').replace(/\D/g, '');
  return {
    nome: d.nome || sub.name || acc.name || '',
    documento: doc,
    documentoTipo: doc.length === 14 ? 'CNPJ' : doc.length === 11 ? 'CPF' : '',
    email: d.email || sub.email || acc.email || '',
    telefone: d.telefone || sub.phone || pf.phone || '',
    nascimento: d.nascimento || '',
    // Endereço nunca foi pedido no cadastro; entra em branco e é do KYC.
    cep: d.cep || '', endereco: d.endereco || '', numero: d.numero || '',
    cidade: d.cidade || '', uf: d.uf || ''
  };
}

// ---------------------------------------------------------------------------
// ENVIO
// ---------------------------------------------------------------------------
function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function validarDados(d) {
  const errs = [];
  if (!String(d.nome || '').trim() || String(d.nome).trim().length < 3) errs.push('Informe o nome completo');
  const doc = String(d.documento || '').replace(/\D/g, '');
  if (doc.length === 11) { if (!documento.cpfValido(doc)) errs.push('CPF inválido'); }
  else if (doc.length === 14) { if (!documento.cnpjValido(doc)) errs.push('CNPJ inválido'); }
  else errs.push('Informe um CPF ou CNPJ');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(d.email || ''))) errs.push('E-mail inválido');
  if (String(d.telefone || '').replace(/\D/g, '').length < 10) errs.push('Telefone inválido');
  // Nascimento só é exigido de pessoa física — é o dado que casa com o RG.
  if (doc.length === 11 && !/^\d{4}-\d{2}-\d{2}$/.test(String(d.nascimento || ''))) {
    errs.push('Informe a data de nascimento');
  }
  return errs;
}

function validarFoto(peca, f) {
  const nome = (PECAS.find(p => p.id === peca) || {}).nome || peca;
  if (!f || typeof f !== 'object') return `Envie a foto: ${nome}`;
  const mime = String(f.mime || '').toLowerCase().split(';')[0].trim();
  if (!MIMES[mime]) return `${nome}: use JPG, PNG ou WEBP`;
  const dados = String(f.data || '');
  if (!dados) return `${nome}: arquivo vazio`;
  const bytes = Math.round(dados.length * 3 / 4);
  if (bytes > MAX_BYTES) return `${nome}: máximo 1,5 MB (este tem ${(bytes / 1048576).toFixed(1)} MB)`;
  return '';
}

// O cliente confirma os dados e manda as duas fotos. A partir daqui a conta
// fica EM ANÁLISE e não recebe até alguém aprovar.
function enviar(acc, body, broadcast) {
  const k = ensure(acc);
  if (k.status === 'em_analise') throw erro('O seu envio já está em análise');
  if (k.status === 'aprovado') throw erro('A sua conta já está aprovada');

  const d = body.dados || {};
  const errs = validarDados(d);
  for (const p of PECAS) {
    const e = validarFoto(p.id, (body.fotos || {})[p.id]);
    if (e) errs.push(e);
  }
  if (errs.length) throw erro(errs.join(' · '));

  const pecas = {};
  for (const p of PECAS) {
    const f = body.fotos[p.id];
    const mime = String(f.mime).toLowerCase().split(';')[0].trim();
    pecas[p.id] = {
      mime, data: String(f.data),
      bytes: Math.round(String(f.data).length * 3 / 4),
      enviadoEm: Date.now()
    };
  }
  guardarArquivos(acc.id, pecas);

  k.dados = {
    nome: String(d.nome).trim().slice(0, 140),
    documento: String(d.documento).replace(/\D/g, ''),
    email: String(d.email).trim().toLowerCase().slice(0, 140),
    telefone: String(d.telefone).replace(/\D/g, '').slice(0, 15),
    nascimento: String(d.nascimento || '').slice(0, 10),
    cep: String(d.cep || '').replace(/\D/g, '').slice(0, 8),
    endereco: String(d.endereco || '').trim().slice(0, 160),
    numero: String(d.numero || '').trim().slice(0, 20),
    cidade: String(d.cidade || '').trim().slice(0, 80),
    uf: String(d.uf || '').trim().toUpperCase().slice(0, 2)
  };
  k.status = 'em_analise';
  k.enviadoEm = Date.now();
  k.motivo = '';
  k.revisadoEm = 0;
  k.revisadoPor = '';
  k.tentativas = (k.tentativas || 0) + 1;
  db.save();

  store.logEvent({ type: 'kyc_enviado', accountId: acc.id, detail: k.dados.nome });
  // O admin precisa saber que há fila. É o mesmo caminho do aviso de cadastro
  // iGaming: vai para o painel da plataforma, não para o cliente.
  if (broadcast) {
    try { broadcast('kyc', { accountId: acc.id, conta: acc.name, status: 'em_analise', nome: k.dados.nome }); } catch {}
  }
  return visaoCliente(acc);
}

// ---------------------------------------------------------------------------
// REVISÃO — é aqui que a decisão do admin vira estado da conta
// ---------------------------------------------------------------------------
function revisar(acc, { aprovar, motivo, porQuem }, broadcast) {
  const k = ensure(acc);
  if (k.status !== 'em_analise') throw erro('Este KYC não está em análise');

  k.status = aprovar ? 'aprovado' : 'reprovado';
  k.revisadoEm = Date.now();
  k.revisadoPor = String(porQuem || 'admin').slice(0, 80);
  k.motivo = aprovar ? '' : String(motivo || '').trim().slice(0, 400);

  if (!aprovar && !k.motivo) {
    // Reprovar sem dizer por quê deixa a pessoa reenviando a mesma coisa.
    k.status = 'em_analise';
    throw erro('Diga o motivo da reprovação — é o que o cliente vai ler para corrigir');
  }

  const ep = require('./pagamentos').ensure(acc);
  if (aprovar) {
    // A subconta só passa a valer agora. Se ela ainda não existe, o fluxo
    // normal do Koonpay a cria — o KYC não inventa subconta.
    if (ep.subaccount) {
      ep.subaccount.status = 'active';
      ep.subaccount.approvedAt = Date.now();
    }
  } else if (ep.subaccount) {
    ep.subaccount.status = 'rejected';
  }

  // AS FOTOS SAEM ASSIM QUE A DECISÃO É TOMADA.
  //
  // Elas cumpriram o que tinham de cumprir. Guardar documento e rosto de todo
  // cliente para sempre é acumular um risco que não traz benefício nenhum: o
  // que precisa ficar é o REGISTRO de que houve análise, quem decidiu e quando
  // — e isso fica.
  apagarArquivos(acc.id);
  db.save();

  store.logEvent({
    type: aprovar ? 'kyc_aprovado' : 'kyc_reprovado',
    accountId: acc.id, detail: k.motivo || acc.name
  });
  if (broadcast) {
    try { broadcast('kyc', { accountId: acc.id, conta: acc.name, status: k.status, motivo: k.motivo }); } catch {}
  }
  return k;
}

// Reprovado pode tentar de novo: apaga o estado e volta ao começo.
function reabrir(acc) {
  const k = ensure(acc);
  if (k.status !== 'reprovado') throw erro('Só um KYC reprovado pode ser refeito');
  k.status = 'nao_enviado';
  k.enviadoEm = 0;
  db.save();
  return visaoCliente(acc);
}

// ---------------------------------------------------------------------------
// A PERGUNTA QUE O RESTO DO SISTEMA FAZ
// ---------------------------------------------------------------------------

// Esta conta pode receber pagamento? É a única pergunta que importa fora daqui.
//
// Enquanto o KYC não é exigido pela plataforma (interruptor do Admin), a
// resposta é sim para todo mundo — ligar a exigência não pode derrubar quem já
// estava vendendo.
function podeReceber(acc) {
  if (!exigido()) return true;
  return ensure(acc).status === 'aprovado';
}

function exigido() {
  const cfg = require('./pagamentos').platformCfg();
  return cfg.kycObrigatorio === true;
}

// ---------------------------------------------------------------------------
// VISÕES
// ---------------------------------------------------------------------------

// O que o cliente vê. Nunca devolve as fotos: ele já as tem, e reenviá-las ao
// navegador só aumenta a superfície por onde elas vazam.
function visaoCliente(acc) {
  const k = ensure(acc);
  return {
    status: k.status,
    exigido: exigido(),
    podeReceber: podeReceber(acc),
    enviadoEm: k.enviadoEm,
    revisadoEm: k.revisadoEm,
    motivo: k.motivo,
    tentativas: k.tentativas,
    pecas: PECAS,
    dados: preenchido(acc)
  };
}

// O que o admin vê na LISTA. Sem fotos: são pesadas, e a lista mostra dezenas.
function linhaAdmin(acc) {
  const k = ensure(acc);
  const a = arquivos(acc.id);
  return {
    accountId: acc.id,
    conta: acc.name,
    email: acc.email,
    status: k.status,
    enviadoEm: k.enviadoEm,
    revisadoEm: k.revisadoEm,
    revisadoPor: k.revisadoPor,
    motivo: k.motivo,
    tentativas: k.tentativas,
    nome: (k.dados && k.dados.nome) || '',
    temFotos: !!a
  };
}

// A FICHA COMPLETA, para decidir. Aqui vão as fotos — é a tela em que o admin
// compara o rosto com o documento, e sem elas não há análise nenhuma.
function fichaAdmin(acc) {
  const k = ensure(acc);
  const a = arquivos(acc.id) || {};
  const ep = require('./pagamentos').ensure(acc);
  const pf = acc.profile || {};
  const sub = ep.subaccount || {};
  return {
    ...linhaAdmin(acc),
    // O NOME EM CAMPO PRÓPRIO. `linhaAdmin` devolve `conta` como o nome da
    // conta, e logo abaixo esta ficha usa `conta` para o OBJETO de contexto —
    // o segundo sobrescreve o primeiro, e o título da tela virava
    // "Verificação · [object Object]".
    contaNome: acc.name,
    dados: k.dados || preenchido(acc),
    fotos: Object.fromEntries(PECAS.map(p => [p.id, a[p.id]
      ? { mime: a[p.id].mime, data: a[p.id].data, bytes: a[p.id].bytes, enviadoEm: a[p.id].enviadoEm }
      : null])),
    // O CONTEXTO DA CONTA, junto. Decidir olhando só a foto é decidir com
    // metade da informação: uma conta criada hoje, sem WhatsApp conectado e
    // sem venda nenhuma, pedindo para receber, é outra conversa.
    conta: {
      id: acc.id,
      criadaEm: acc.createdAt,
      ultimoAcesso: acc.lastLoginAt || 0,
      tipo: acc.isAdmin ? 'Administrador' : acc.unlimited ? 'Superconta' : 'Cliente',
      plano: (db.get().plans.find(x => x.id === acc.billing.planId) || {}).name || '',
      assinatura: acc.billing.status,
      segmento: pf.segment || '',
      site: pf.site || '',
      telefoneCadastro: pf.phone || '',
      documentoCadastro: String(pf.document || '').replace(/\D/g, ''),
      whatsappConectado: !!(acc.wa && acc.wa.connected),
      whatsappNumero: (acc.wa && acc.wa.displayPhoneNumber) || '',
      contatos: (acc.contacts || []).length,
      cobrancas: (ep.charges || []).length,
      recebido: (ep.charges || []).filter(c => c.status === 'paid').reduce((s, c) => s + (c.value || 0), 0),
      chavePix: sub.pixKey || '',
      subcontaStatus: sub.status || ''
    }
  };
}

// A FILA. Em análise primeiro, e dentro dela o mais antigo na frente — quem
// está esperando há mais tempo é quem mais precisa de resposta.
function fila(filtro) {
  const ordem = { em_analise: 0, reprovado: 1, aprovado: 2, nao_enviado: 3 };
  return db.get().accounts
    .filter(a => !a.isAdmin)
    .map(a => linhaAdmin(a))
    .filter(l => l.status !== 'nao_enviado')
    .filter(l => !filtro || filtro === 'todos' || l.status === filtro)
    .sort((x, y) => (ordem[x.status] - ordem[y.status]) || (x.enviadoEm - y.enviadoEm));
}

module.exports = {
  ESTADOS, PECAS, MAX_BYTES, MIMES,
  ensure, vazio, preenchido, enviar, revisar, reabrir,
  podeReceber, exigido, visaoCliente, linhaAdmin, fichaAdmin, fila,
  arquivos, apagarArquivos, validarDados, validarFoto
};
