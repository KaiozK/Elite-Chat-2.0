// ============================================================================
// PAGAR PRIMEIRO, CADASTRAR DEPOIS
//
// Até aqui a conta nascia no cadastro e a cobrança vinha atrás: quem desistia
// no pagamento deixava uma conta vazia no banco, e os dados que o adquirente
// exige (CPF/CNPJ, telefone) chegavam num segundo formulário — quando chegavam.
//
// Agora o caminho é o do comércio: a pessoa preenche o checkout com o que a
// cobrança precisa (nome, WhatsApp, e-mail e documento), paga, e SÓ ENTÃO a
// conta existe. O que ela digitou no checkout volta preenchido e travado no
// cadastro — é o mesmo dado que abre a conta de Pagamentos, e deixá-lo
// editável ali seria convidar a divergência entre quem pagou e quem recebe.
//
// A pré-assinatura é o registro dessa espera: nasce pendente, vira conta
// quando o webhook confirma, e morre quando o cadastro termina.
// ============================================================================
const crypto = require('crypto');
const db = require('./db');
const store = require('./store');
const documento = require('./documento');
const paises = require('./paises');
const saaspix = require('./saaspix');
const pagamentos = require('./pagamentos');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function lista() {
  const d = db.get();
  if (!Array.isArray(d.preassinaturas)) d.preassinaturas = [];
  return d.preassinaturas;
}

// O comprador, no formato que o gateway espera. Ele ainda não é uma conta,
// mas para o adquirente é o pagador de sempre.
function comoConta(pre) {
  return {
    id: pre.id,
    name: pre.empresa || pre.nome,
    email: pre.email,
    profile: { phone: pre.telefone, document: pre.documento, country: 'BR' }
  };
}

// ---------------------------------------------------------------------------
// VALIDAÇÃO — todos os campos são obrigatórios, e é de propósito: são
// exatamente os que a conta de Pagamentos precisa para nascer junto.
// ---------------------------------------------------------------------------
function validar(b) {
  const nome = String(b.nome || '').trim();
  const email = String(b.email || '').toLowerCase().trim();
  const doc = String(b.documento || '').replace(/\D/g, '');
  if (nome.length < 3) throw erro('Informe o seu nome completo');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw erro('Informe um e-mail válido');
  const tel = paises.paraE164(String(b.pais || 'BR').toUpperCase(), b.telefone);
  if (!tel.ok) throw erro(tel.erro || 'Informe um WhatsApp válido');
  const eDoc = documento.erroDoc(doc);
  if (eDoc) throw erro(eDoc);
  if (db.findAccountByEmail(email)) throw erro('Já existe uma conta com este e-mail. Entre por ela.', 409);
  return { nome, email, telefone: tel.e164, documento: doc };
}

// ---------------------------------------------------------------------------
// CRIA a pré-assinatura e a cobrança do plano.
// ---------------------------------------------------------------------------
async function criar(b) {
  const plano = db.get().plans.find(p => p.id === b.planId && !p.archived);
  if (!plano) throw erro('Plano não encontrado');
  const dados = validar(b);

  const pre = {
    id: db.genId('pre'),
    token: crypto.randomBytes(18).toString('hex'),
    planId: plano.id,
    ...dados,
    refBy: String(b.ref || '').trim().slice(0, 24),
    // O IP de QUEM PEDIU, guardado aqui porque a conta só nasce depois — na
    // hora do pagamento, num webhook que não tem requisição de navegador
    // nenhuma para consultar. Sem guardar agora, o sinal se perde.
    ip: String(b.ip || '').slice(0, 45),
    status: 'pending',
    valor: plano.price,
    correlationID: '',
    accountId: '',
    criadoEm: Date.now(),
    pagoEm: 0
  };
  pre.correlationID = 'nov-' + pre.id + '-' + crypto.randomBytes(4).toString('hex');

  const cobranca = await saaspix.criarCobranca(comoConta(pre), {
    correlationID: pre.correlationID,
    valueCents: plano.price,
    comment: 'Koonfy · ' + plano.name
  });
  pre.brCode = cobranca.brCode || '';
  pre.qrCodeImage = cobranca.qrCodeImage || '';

  lista().push(pre);
  // guarda no máximo as 500 últimas: o resto é lixo de gente que desistiu
  if (lista().length > 500) lista().splice(0, lista().length - 500);
  db.save();
  store.logEvent({ type: 'preassinatura_criada', preId: pre.id, planId: plano.id, valor: plano.price });
  // A tela precisa saber, já na criação, se o botão "Já fiz o pagamento" tem
  // a quem perguntar — senão ela o desenharia e só descobriria no clique.
  return { token: pre.token, cobranca, podeReconsultar: podeReconsultar(),
           plano: { id: plano.id, nome: plano.name, preco: plano.price } };
}

function ehPreAssinatura(cid) { return String(cid || '').startsWith('nov-'); }

function porToken(token) {
  return lista().find(p => p.token === String(token || '')) || null;
}

// ---------------------------------------------------------------------------
// PAGOU: aqui a conta passa a existir.
//
// O plano já entra ativo — o dinheiro entrou. A senha ainda não existe: quem
// paga termina o cadastro na tela seguinte, e é lá que ela é definida.
// ---------------------------------------------------------------------------
function confirmar(cid, valorPago, broadcast) {
  const pre = lista().find(p => p.correlationID === cid);
  if (!pre) { store.logEvent({ type: 'preassinatura_sem_dono', correlationID: cid }); return { ok: false, reason: 'unmatched' }; }
  if (pre.status === 'paid' || pre.accountId) return { ok: true, duplicate: true, accountId: pre.accountId };

  const data = db.get();
  const plano = data.plans.find(p => p.id === pre.planId);
  // A SENHA PROVISÓRIA É O DOCUMENTO que a pessoa digitou no checkout.
  //
  // Ela nascia com bytes aleatórios que ninguém conhecia. Na teoria era mais
  // seguro; na prática, quem não terminasse o formulário — fechou a aba, caiu
  // a internet, o filho puxou o cabo — ficava TRANCADO FORA de uma conta que
  // acabou de pagar, e a única saída era o suporte. Perder o cliente na porta,
  // depois de ele ter pago, é o pior resultado possível.
  //
  // Agora ele entra com o e-mail e o CPF/CNPJ do checkout, e cai direto na
  // etapa que faltava.
  //
  // O QUE ISSO CUSTA, dito sem rodeio: CPF no Brasil não é segredo. Quem
  // souber o e-mail E o documento da pessoa consegue entrar. Por isso a conta
  // continua marcada como pendente: quem entra assim vai para o formulário e
  // define uma senha de verdade — e é isso que fecha a janela. Ver o ramo de
  // `pendenteCadastro` em /login.
  const acc = db.newAccount({ name: pre.nome, email: pre.email, pass: pre.documento });
  acc.profile.phone = pre.telefone;
  acc.profile.document = pre.documento;
  acc.pendenteCadastro = true;

  const dias = (plano && plano.periodDays ? plano.periodDays : 30) * 86400000;
  acc.billing.status = 'active';
  acc.billing.planId = pre.planId;
  acc.billing.periodEnd = Date.now() + dias;
  acc.billing.startedAt = Date.now();

  const aff = pre.refBy ? db.findAccountByRefCode(pre.refBy) : null;
  if (aff) acc.affiliate.refBy = aff.affiliate.code;

  // ANTIABUSO neste caminho também.
  //
  // Este é o cadastro que a landing usa — o principal, não o secundário. A
  // camada tinha entrado só em /api/register, e uma verificação que cobre a
  // porta menos usada e deixa a principal aberta não verifica nada.
  //
  // Aqui não há trial a negar (a conta já nasce paga, o plano foi comprado),
  // então o que importa é a COMISSÃO: se quem indicou e quem foi indicado
  // dividem documento, telefone ou IP, o dinheiro fica retido para alguém
  // olhar. O IP vem de quando a pré-assinatura foi criada.
  try {
    require('./antiabuso').aoCadastrar(acc, { headers: { 'x-forwarded-for': pre.ip || '' }, socket: {} }, {
      documento: pre.documento, telefone: pre.telefone, email: pre.email
    }, aff);
  } catch (e) { /* uma verificação que falha não pode derrubar uma conta paga */ }

  data.accounts.push(acc);
  data.revenue.push({ ts: Date.now(), accountId: acc.id, planId: pre.planId, amount: valorPago, kind: 'first', chargeId: cid,
    metodo: saaspix.metodoDeCid(cid, acc) });

  pre.status = 'paid';
  pre.pagoEm = Date.now();
  // O link sai JÁ, sem esperar ninguém pedir: é o momento em que a pessoa mais
  // pode fechar a aba (o Pix confirmou, ela acha que acabou).
  mandarLink(pre).catch(() => {});
  pre.accountId = acc.id;
  db.save();

  // A conta de Pagamentos nasce do mesmo dado que pagou. Não trava nada se o
  // adquirente estiver fora do ar.
  try { pagamentos.garantirPagamentos(acc).catch(() => {}); } catch {}

  // A COMISSÃO DO AFILIADO — era exatamente isto que faltava aqui.
  //
  // Este caminho cria a conta por conta própria e devolve o controle antes de
  // `applyPayment` chegar ao trecho que paga a comissão. O resultado era um
  // defeito parcial, do pior tipo: a conta nascia certa, o `refBy` era gravado
  // e a receita entrava no relatório — só o dinheiro de quem indicou não saía.
  //
  // A chamada é da MESMA função que a renovação usa. Copiar a regra para cá
  // resolveria hoje e criaria duas versões para divergirem amanhã.
  //
  // Depois de `db.save()` e fora dele de propósito: a função grava o que
  // precisa, e uma falha na comissão não pode desfazer uma conta já paga.
  try { require('./woovi').pagarComissao(acc, valorPago, 'first', broadcast); }
  catch (e) { store.logEvent({ type: 'comissao_erro', accountId: acc.id, error: e.message }); }

  store.logEvent({ type: 'preassinatura_paga', preId: pre.id, accountId: acc.id, valor: valorPago });
  if (broadcast) broadcast('billing', { accountId: acc.id });
  return { ok: true, kind: 'first', accountId: acc.id };
}

// ---------------------------------------------------------------------------
// TERMINA O CADASTRO: empresa, senha e o perfil. Os dados do checkout NÃO
// voltam aqui — eles já estão na conta e são os mesmos do recebimento.
// ---------------------------------------------------------------------------
// MANDA O LINK DE CONCLUSÃO por e-mail.
//
// Duas horas em que isto é chamado, e as duas importam:
//
//   • quando o PAGAMENTO CONFIRMA, para a pessoa ter o link mesmo que feche a
//     aba no segundo seguinte;
//   • quando ela tenta ENTRAR e a conta ainda está pendente — é o que ela faz
//     naturalmente ao voltar, porque do ponto de vista dela a conta já existe.
//
// Falha de e-mail não pode derrubar nada: o pagamento já entrou, e o cadastro
// ainda pode ser concluído pelo link que está na aba dela ou guardado no
// navegador. Por isso todo chamador ignora o erro.
// O CAMINHO, sem o domínio. Serve a quem já está no site — o navegador
// completa o resto. É o que o login usa: exigir `baseUrl` configurado ali
// deixaria a pessoa parada numa mensagem sem link, numa instalação onde o
// endereço público ainda não foi preenchido.
function caminhoDeConclusao(pre) {
  return '/assinar?plano=' + encodeURIComponent(pre.planId) + '&token=' + encodeURIComponent(pre.token);
}

// O ENDEREÇO INTEIRO, para o e-mail: um link relativo numa caixa de entrada
// não leva a lugar nenhum.
function linkDeConclusao(pre) {
  const base = (db.get().platform.baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  return base + caminhoDeConclusao(pre);
}

async function mandarLink(pre) {
  const url = linkDeConclusao(pre);
  if (!url) return { ok: false, motivo: 'sem endereço público configurado' };
  const mailer = require('./mailer');
  if (!mailer.configured()) return { ok: false, motivo: 'e-mail não configurado' };
  const plano = (db.get().plans.find(p => p.id === pre.planId) || {}).name || '';
  try {
    await mailer.enviarLinkCadastro(pre.email, url, plano);
    store.logEvent({ type: 'preassinatura_link_enviado', preId: pre.id });
    return { ok: true };
  } catch (e) {
    store.logEvent({ type: 'preassinatura_link_falhou', preId: pre.id, error: e.message });
    return { ok: false, motivo: e.message };
  }
}

// Acha a pré-assinatura PAGA e ainda não concluída de uma conta. É o que liga
// "esta pessoa tentou entrar" a "este é o cadastro que falta terminar".
function pendenteDaConta(accountId) {
  return lista().find(p => p.accountId === accountId && p.status === 'paid') || null;
}

// PERGUNTAR À WOOVI EM VEZ DE ESPERAR O WEBHOOK
//
// A tela do Pix consulta o servidor a cada 4 segundos, mas essa consulta só lê
// o que já está gravado aqui: quem vira a chave é o WEBHOOK da Woovi. Enquanto
// ele não chega, a página fica dizendo "aguardando" mesmo que o dinheiro já
// tenha entrado.
//
// E há o caso pior, que não é lentidão e sim uma parede: se o webhook NÃO
// CHEGAR — URL mal configurada, instabilidade, uma máquina sem endereço
// público — a pessoa pagou e fica presa naquela tela para sempre. É a mesma
// razão pela qual /billing/pending existe para quem já tem conta.
//
// Aqui a pergunta vai à Woovi, e a resposta dela decide.
//
// NEM TODO ADQUIRENTE RESPONDE ESTA PERGUNTA, e é preciso dizer isso em vez de
// fingir. A Woovi tem consulta de cobrança; a Simplify, na integração que
// temos, NÃO — a documentação dela não expõe consulta de transação, e o driver
// devolve `null` de propósito (ver DRIVERS.simplify.getCharge em pagamentos.js).
//
// Com a Simplify ativa, a confirmação vem só pelo webhook. Um botão de
// "verificar agora" ali não teria a quem perguntar: responderia sempre "não
// consegui", o que é pior do que não existir. Por isso `podeReconsultar` sai na
// visão pública e a tela só desenha o botão quando há resposta possível.
function podeReconsultar() {
  try { return typeof pagamentos.gateway().getCharge === 'function' && pagamentos.gateway().id === 'woovi'; }
  catch { return false; }
}

// COM FREIO. Esta rota é PÚBLICA (o token é o que identifica), e cada chamada é
// uma ida à API do adquirente. Sem limite, uma aba esquecida com um laço, ou
// alguém batendo de propósito, viraria conta de API — e o adquirente passando a
// recusar por excesso derrubaria o caminho de todo mundo, não só o dele.
const ESPERA_RECONSULTA_MS = 6000;

async function reconsultar(token) {
  const pre = porToken(token);
  if (!pre) throw erro('Cadastro não encontrado', 404);
  // Já resolvido: responde com o estado, sem gastar chamada.
  if (pre.status !== 'pending') return { pago: true, status: pre.status };

  // Sem consulta possível, a resposta é honesta e nenhuma chamada é gasta.
  if (!podeReconsultar()) return { pago: false, semConsulta: true };

  const agora = Date.now();
  if (pre.ultimaConsulta && agora - pre.ultimaConsulta < ESPERA_RECONSULTA_MS) {
    // Não é erro: é "pergunte daqui a pouco". A tela trata como ainda-pendente.
    return { pago: false, aguarde: true };
  }
  pre.ultimaConsulta = agora;
  db.save();

  let charge = null;
  // O gateway ATIVO, e não a Woovi na mão: quem processa o Pix é quem o admin
  // escolheu, e perguntar ao outro devolveria "cobrança não encontrada" — ou
  // "não configurado", que é o que acontecia com a Simplify ligada.
  try { charge = await pagamentos.gateway().getCharge(pre.correlationID); }
  catch (e) {
    store.logEvent({ type: 'preassinatura_reconsulta_erro', preId: pre.id, error: e.message });
    return { pago: false, erro: true };
  }

  if (charge && /COMPLETED|CONFIRMED|PAID/i.test(charge.status || '')) {
    // O MESMO caminho do webhook, e não um atalho: é ele que cria a conta, paga
    // a comissão e manda o link. Um segundo caminho aqui significaria duas
    // versões da coisa mais delicada do produto.
    //
    // `applyPayment` mora em woovi.js por história, mas o que ele faz não tem
    // nada de Woovi: é a regra de faturamento, e é por ela que a Simplify
    // também passa (ver saaspix.confirmar).
    require('./woovi').applyPayment(
      { correlationID: pre.correlationID, value: charge.value || pre.valor }, null);
    return { pago: true, status: 'paid' };
  }
  return { pago: false, status: (charge && charge.status) || 'pending' };
}

function concluir(token, b, broadcast) {
  const pre = porToken(token);
  if (!pre) throw erro('Cadastro não encontrado', 404);
  if (pre.status === 'pending') throw erro('O pagamento ainda não foi confirmado', 409);
  const acc = db.findAccount(pre.accountId);
  if (!acc) throw erro('Conta não encontrada', 404);
  if (pre.status === 'done') throw erro('Este cadastro já foi concluído. Entre com o seu e-mail e senha.', 409);

  const empresa = String(b.empresa || '').trim();
  const senha = String(b.senha || '');
  if (empresa.length < 2) throw erro('Informe o nome da empresa');
  if (senha.length < 6) throw erro('A senha deve ter pelo menos 6 caracteres');

  acc.name = empresa.slice(0, 120);
  acc.passHash = db.hashPassword(senha);
  acc.pendenteCadastro = false;
  for (const k of ['size', 'goal']) {
    if (b[k] !== undefined) acc.profile[k] = String(b[k] || '').trim().slice(0, 60);
  }
  // A CHAVE PIX que a conta usa para receber. Vem desta etapa e é OPCIONAL:
  // sem ela a conta nasce igual e o Koonpay é concluído depois, no painel.
  // Exigi-la aqui faria perder um cadastro JÁ PAGO por causa de um dado que a
  // pessoa pode nem ter em mãos na hora — e o dinheiro já entrou.
  //
  // Os mesmos campos e o mesmo corte de /api/register: dois formatos para o
  // mesmo dado viram duas telas mostrando coisas diferentes sobre a mesma conta.
  if (b.pixKey) {
    acc.profile.pixKey = String(b.pixKey).trim().slice(0, 120);
    acc.profile.pixKeyType = String(b.pixKeyType || '').slice(0, 20);
  }
  // O par segmento+site é validado junto: iGaming sem site não conclui o
  // cadastro. Erro aqui vira 400 na tela, no campo, e não uma conta criada com
  // metade do dado.
  const seg = require('./segmentos').aplicar(acc.profile, { segment: b.segment, site: b.site });
  if (!seg.ok) throw erro(seg.erro);
  pre.status = 'done';
  db.save();
  store.logEvent({ type: 'preassinatura_concluida', preId: pre.id, accountId: acc.id });
  // Mesmo aviso do cadastro direto: quem entra por aqui já pagou, então um
  // iGaming que chega por esta porta é ainda mais urgente de conferir.
  if (broadcast) {
    try { broadcast('cadastro', { accountId: acc.id, conta: acc.name, email: acc.email, segmento: acc.profile.segment || '', site: acc.profile.site || '' }); } catch {}
  }
  return acc;
}

// O que a tela de cadastro mostra: o que veio do checkout (travado) e o estado
// do pagamento.
function publico(token) {
  const pre = porToken(token);
  if (!pre) return null;
  const plano = db.get().plans.find(p => p.id === pre.planId);
  return {
    status: pre.status,
    plano: plano ? { nome: plano.name, preco: plano.price, dias: plano.periodDays || 30 } : null,
    // travados no formulário: são os dados que abriram a conta de Pagamentos
    dados: { nome: pre.nome, email: pre.email, telefone: pre.telefone, documento: pre.documento },
    cobranca: pre.status === 'pending' ? { brCode: pre.brCode, qrCodeImage: pre.qrCodeImage } : null,
    // A tela só desenha o "Já fiz o pagamento" quando existe a quem perguntar.
    // Com a Simplify ativa isso é falso, e o botão nem aparece — em vez de
    // aparecer e responder sempre que não conseguiu.
    podeReconsultar: podeReconsultar()
  };
}

module.exports = {
  linkDeConclusao, caminhoDeConclusao, mandarLink, pendenteDaConta, reconsultar,
  criar, confirmar, concluir, publico, porToken, ehPreAssinatura };
