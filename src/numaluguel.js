// ============================================================================
// ALUGUEL DE NÚMEROS — a camada de REVENDA
//
// `numeros.js` fala com a Integra X e para por aí: ele sabe comprar, listar e
// cancelar na conta da PLATAFORMA. Este arquivo é a outra metade, e é onde o
// negócio mora: a plataforma compra por um preço e aluga para o cliente por
// outro, debitando da carteira dele.
//
// São duas contabilidades diferentes e é importante não confundi-las:
//
//   • O CUSTO é da plataforma, cobrado pela Integra X, em dinheiro de verdade.
//   • O PREÇO é do cliente, cobrado da carteira dele, e quem define é o admin.
//
// A diferença é a margem, e ela só é visível se os dois valores forem
// guardados. Guardar só o preço faz o relatório do admin virar chute.
//
// ---------------------------------------------------------------------------
// TRÊS DECISÕES QUE PARECEM DETALHE E NÃO SÃO
// ---------------------------------------------------------------------------
//
// 1. O PREÇO CONGELA NA COMPRA. O aluguel guarda o `precoCents` que valia no
//    dia. Se o admin subir a tabela amanhã, quem já alugou continua no preço
//    combinado até o fim do ciclo — mudar o valor de um aluguel em curso é
//    cobrar a mais sem avisar, e é assim que se perde um cliente calado.
//
// 2. DEBITA ANTES DE COMPRAR. A ordem inversa é tentadora (compra, depois
//    cobra) e é a errada: se o débito falhar depois da compra, a plataforma
//    pagou a Integra X e não recebeu. Debitando antes, a falha da compra se
//    desfaz devolvendo o saldo — e devolver saldo para a nossa própria
//    carteira sempre funciona, enquanto cancelar na Integra X pode não
//    reembolsar.
//
// 3. CANCELAR É PRIMEIRO LÁ, DEPOIS AQUI. Se marcarmos "cancelado" na Koonfy
//    e a chamada à Integra X falhar, paramos de cobrar do cliente e
//    continuamos pagando ao provedor — o pior dos dois mundos, e silencioso.
//    Quando o provedor não responde, o aluguel fica em `cancelando` e a
//    varredura do dia seguinte tenta de novo.
//
// ---------------------------------------------------------------------------
// A REGRA DOS 5 DIAS
// ---------------------------------------------------------------------------
// Faltando 5 dias para o vencimento, o saldo do cliente é conferido. Sem saldo
// para o próximo ciclo, o número é cancelado nos DOIS lados — na Integra X,
// para a plataforma parar de pagar, e na Koonfy.
//
// Cinco dias e não zero de propósito: cancelar no dia do vencimento não dá
// tempo de recarregar, e um número perdido não volta — quem o alugar depois
// recebe os SMS de quem estava usando. O cliente é avisado antes, com o valor
// que falta.
// ============================================================================

const db = require('./db');
const store = require('./store');
const numeros = require('./numeros');

const DIA = 24 * 3600 * 1000;

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO DA REVENDA (Admin SaaS → Integrações)
// ---------------------------------------------------------------------------
function cfg() {
  const c = numeros.cfg();
  for (const [k, v] of Object.entries(padroes())) if (c[k] === undefined) c[k] = v;
  return c;
}

function padroes() {
  return {
    // Quanto o CLIENTE paga por ciclo. Zero = a plataforma não revende, e a
    // tela some do app: melhor não existir do que existir cobrando nada e
    // gastando o dinheiro da plataforma a cada clique.
    precoCents: 0,
    // O ciclo do aluguel, em dias. É o que a Integra X pratica na assinatura;
    // fica configurável porque o provedor pode mudar e a conta tem de bater.
    cicloDias: 30,
    // Quantos dias antes do vencimento o saldo é conferido — e o número
    // cancelado se não houver. O pedido foi 5.
    prazoSaldoDias: 5,
    // A partir de quantos dias o admin vê o número na lista de "perto de
    // vencer". Maior que o prazo de saldo de propósito: dá para agir antes de
    // a régua automática entrar.
    avisarDias: 10
  };
}

const preco = () => Math.max(0, Math.round(Number(cfg().precoCents) || 0));
const ciclo = () => Math.max(1, Math.round(Number(cfg().cicloDias) || 30));
const prazoSaldo = () => Math.max(0, Math.round(Number(cfg().prazoSaldoDias) || 5));

// A revenda está de pé? Precisa do provedor configurado E de um preço.
function revendaAtiva() { return numeros.configured() && preco() > 0; }

// ---------------------------------------------------------------------------
// OS ALUGUÉIS DE UMA CONTA
// ---------------------------------------------------------------------------
function ensure(acc) {
  if (!acc.numeros || typeof acc.numeros !== 'object') acc.numeros = {};
  if (!Array.isArray(acc.numeros.alugueis)) acc.numeros.alugueis = [];
  return acc.numeros;
}

function meus(acc) { return ensure(acc).alugueis; }
function ativos(acc) { return meus(acc).filter(a => a.status === 'ativo' || a.status === 'cancelando'); }
function achar(acc, id) { return meus(acc).find(a => a.id === id || a.rentalId === id) || null; }

// ---------------------------------------------------------------------------
// COMPRA
// ---------------------------------------------------------------------------
async function comprar(acc, { numeroId = '', ddd = '' } = {}, broadcast) {
  if (!revendaAtiva()) throw erro('O aluguel de números não está disponível na plataforma', 503);

  const pagamentos = require('./pagamentos');
  const valor = preco();

  // Confere o saldo ANTES de qualquer coisa, para a mensagem de saldo curto
  // chegar sem ter mexido em nada — e para não gastar chamada no provedor.
  if (acc.wallet.balance < valor) {
    throw erro(`Saldo insuficiente: o aluguel custa ${pagamentos.fmtBRL(valor)} e você tem ` +
      `${pagamentos.fmtBRL(acc.wallet.balance)}. Recarregue a carteira para alugar um número.`, 402);
  }

  const rotulo = 'Aluguel de número virtual';
  pagamentos.spendWallet(acc, valor, rotulo, broadcast);

  let compra;
  try {
    compra = await numeros.comprar({ modo: 'subscription', ddd, numeroId });
  } catch (e) {
    // A COMPRA FALHOU DEPOIS DO DÉBITO — devolve o dinheiro. Ver decisão 2 no
    // cabeçalho: é justamente por isso que a ordem é esta.
    require('./topup').creditar(acc, valor, 'Estorno: ' + rotulo, '', broadcast);
    store.logEvent({ type: 'num_compra_falhou', accountId: acc.id, error: e.message, estornado: valor });
    throw e;
  }

  const agora = Date.now();
  const aluguel = {
    id: db.genId('nal'),
    rentalId: compra.rentalId,
    numero: compra.numero,
    ddd: String(ddd || '').replace(/\D/g, ''),
    compradoEm: agora,
    // O provedor manda o vencimento dele; sem isso, o ciclo configurado. Nunca
    // um vencimento em branco: é ele que a régua dos 5 dias lê.
    venceEm: compra.expiraEm || (agora + ciclo() * DIA),
    precoCents: valor,          // CONGELADO — ver decisão 1 no cabeçalho
    custoCents: compra.precoCents || 0,
    status: 'ativo',
    renovacaoAuto: true,
    avisado: 0,                 // último aviso de vencimento mandado ao cliente
    canceladoEm: 0,
    motivo: ''
  };
  meus(acc).unshift(aluguel);
  db.save();
  if (broadcast) broadcast('numeros', { accountId: acc.id });
  store.logEvent({
    type: 'num_alugado', accountId: acc.id, numero: aluguel.numero,
    precoCents: valor, custoCents: aluguel.custoCents
  });
  return publicoUm(aluguel);
}

// ---------------------------------------------------------------------------
// CANCELAMENTO
//
// `motivo` entra no registro e é o que o cliente lê depois. Um número que
// sumiu sem explicação vira chamado de suporte.
// ---------------------------------------------------------------------------
async function cancelar(acc, id, motivo, broadcast) {
  const a = achar(acc, id);
  if (!a) throw erro('Número não encontrado', 404);
  if (a.status === 'cancelado' || a.status === 'expirado') throw erro('Este número já foi encerrado');

  // PRIMEIRO LÁ, DEPOIS AQUI — ver decisão 3 no cabeçalho.
  let resultado = null;
  try {
    resultado = await numeros.cancelar(a.rentalId);
  } catch (e) {
    a.status = 'cancelando';
    a.motivo = motivo || a.motivo;
    db.save();
    store.logEvent({ type: 'num_cancel_falhou', accountId: acc.id, numero: a.numero, error: e.message });
    throw erro('Não foi possível cancelar no provedor agora. O número ficou marcado ' +
      'para cancelamento e o sistema tenta de novo automaticamente.', 502);
  }

  a.status = 'cancelado';
  a.canceladoEm = Date.now();
  a.motivo = motivo || 'Cancelado pelo cliente';
  db.save();
  if (broadcast) broadcast('numeros', { accountId: acc.id });
  store.logEvent({ type: 'num_cancelado', accountId: acc.id, numero: a.numero, motivo: a.motivo });
  return { ...publicoUm(a), resultado };
}

// ---------------------------------------------------------------------------
// SMS RECEBIDOS NUM NÚMERO DA CONTA
//
// A checagem de dono não é formalidade: `rentalId` é o id na Integra X, e sem
// conferir, qualquer conta leria os SMS de qualquer outra passando o id na
// mão — inclusive códigos de verificação.
// ---------------------------------------------------------------------------
async function mensagens(acc, id) {
  const a = achar(acc, id);
  if (!a) throw erro('Número não encontrado', 404);
  return numeros.mensagens(a.rentalId);
}

// ---------------------------------------------------------------------------
// O QUE A TELA DO CLIENTE VÊ
//
// Nunca o custo da plataforma: é informação de margem, e não é da conta dele.
// ---------------------------------------------------------------------------
// `acc` é opcional só para quem já tem o aluguel na mão e não se importa com
// o risco; a tela SEMPRE passa, porque risco sem saldo não é risco.
function publicoUm(a, acc) {
  const dias = a.venceEm ? Math.ceil((a.venceEm - Date.now()) / DIA) : null;
  // RISCO É VENCER LOGO **E** NÃO TER COM QUE PAGAR — as duas coisas.
  // Marcando só pela data, todo número entrava em alarme vermelho nos últimos
  // cinco dias do ciclo, inclusive o de quem tem saldo de sobra e vai renovar
  // sem perceber. Alarme que dispara sempre é alarme que ninguém lê, e aí o
  // dia em que faltar dinheiro de verdade passa batido.
  const semSaldo = acc && acc.wallet ? acc.wallet.balance < (a.precoCents || 0) : false;
  return {
    id: a.id, numero: a.numero, ddd: a.ddd,
    compradoEm: a.compradoEm, venceEm: a.venceEm,
    diasParaVencer: dias,
    precoCents: a.precoCents,
    status: a.status,
    renovacaoAuto: !!a.renovacaoAuto,
    motivo: a.motivo || '',
    // O cliente precisa saber ANTES que a renovação não vai passar, e quanto
    // falta. É a diferença entre recarregar e perder o número.
    emRisco: a.status === 'ativo' && dias !== null && dias <= prazoSaldo() && semSaldo
  };
}

function visaoCliente(acc) {
  const pagamentos = require('./pagamentos');
  const lista = meus(acc).map(a => publicoUm(a, acc));
  const emRisco = lista.filter(n => n.emRisco);
  return {
    disponivel: revendaAtiva(),
    precoCents: preco(),
    cicloDias: ciclo(),
    prazoSaldoDias: prazoSaldo(),
    saldo: acc.wallet.balance,
    saldoFormatado: pagamentos.fmtBRL(acc.wallet.balance),
    podeAlugar: revendaAtiva() && acc.wallet.balance >= preco(),
    numeros: lista,
    ativos: lista.filter(n => n.status === 'ativo' || n.status === 'cancelando').length,
    emRisco: emRisco.length
  };
}

// ---------------------------------------------------------------------------
// VARREDURA DIÁRIA
//
// Três coisas, nesta ordem:
//
//   1. RETENTA os cancelamentos que o provedor recusou. Vem primeiro porque é
//      dinheiro saindo da plataforma a cada dia que passa.
//   2. APLICA A RÉGUA DOS 5 DIAS: sem saldo para o próximo ciclo, cancela dos
//      dois lados.
//   3. RENOVA o que venceu e tem saldo: debita e empurra o vencimento.
//
// Devolve o resumo — é o que o admin recebe no aviso e o que o teste lê.
// ---------------------------------------------------------------------------
async function varrer(broadcast) {
  const pagamentos = require('./pagamentos');
  const resumo = { retentados: 0, cancelados: 0, renovados: 0, semSaldo: 0, perto: [], erros: 0 };
  if (!numeros.configured()) return resumo;

  const agora = Date.now();
  const limiteRisco = prazoSaldo() * DIA;
  const limiteAviso = Math.max(0, Math.round(Number(cfg().avisarDias) || 10)) * DIA;

  for (const acc of db.get().accounts) {
    for (const a of ativos(acc)) {
      try {
        // 1. cancelamento pendente do dia anterior
        if (a.status === 'cancelando') {
          try {
            await numeros.cancelar(a.rentalId);
            a.status = 'cancelado'; a.canceladoEm = agora;
            resumo.retentados++;
            db.save();
          } catch { resumo.erros++; }
          continue;
        }

        const falta = a.venceEm - agora;

        // 3. venceu: renova se houver saldo (a régua abaixo já teria cancelado
        //    quem não tem, então chegar aqui sem saldo é caso de borda)
        if (falta <= 0) {
          if (a.renovacaoAuto && acc.wallet.balance >= a.precoCents) {
            pagamentos.spendWallet(acc, a.precoCents, 'Renovação de número virtual ' + a.numero, broadcast);
            a.venceEm = agora + ciclo() * DIA;
            a.avisado = 0;
            resumo.renovados++;
            db.save();
          } else {
            await encerrarPorSaldo(acc, a, resumo, broadcast);
          }
          continue;
        }

        // 2. a régua dos 5 dias
        if (falta <= limiteRisco && acc.wallet.balance < a.precoCents) {
          await encerrarPorSaldo(acc, a, resumo, broadcast);
          continue;
        }

        // o que o admin precisa ver antes de a régua entrar
        if (falta <= limiteAviso) {
          resumo.perto.push({
            accountId: acc.id, conta: acc.name, numero: a.numero,
            venceEm: a.venceEm, dias: Math.ceil(falta / DIA),
            temSaldo: acc.wallet.balance >= a.precoCents
          });
        }
      } catch { resumo.erros++; }
    }
  }

  resumo.perto.sort((x, y) => x.venceEm - y.venceEm);
  return resumo;
}

// Cancela nos dois lados por falta de saldo, e avisa o dono da conta — que
// ainda pode recarregar e alugar outro.
async function encerrarPorSaldo(acc, a, resumo, broadcast) {
  const pagamentos = require('./pagamentos');
  const motivo = `Cancelado por falta de saldo: a renovação custa ${pagamentos.fmtBRL(a.precoCents)}.`;
  try {
    await numeros.cancelar(a.rentalId);
    a.status = 'cancelado';
  } catch {
    // O provedor não respondeu. Fica pendente e a varredura de amanhã insiste:
    // marcar como cancelado aqui pararia a cobrança e não o gasto.
    a.status = 'cancelando';
    resumo.erros++;
  }
  a.canceladoEm = Date.now();
  a.motivo = motivo;
  resumo.semSaldo++;
  if (a.status === 'cancelado') resumo.cancelados++;
  db.save();
  store.logEvent({ type: 'num_cancelado_sem_saldo', accountId: acc.id, numero: a.numero });
  if (broadcast) broadcast('numeros', { accountId: acc.id, motivo, numero: a.numero });
}

// ---------------------------------------------------------------------------
// A VISÃO DO ADMIN — quem alugou o quê, e o que está para vencer
// ---------------------------------------------------------------------------
function visaoAdmin() {
  const pagamentos = require('./pagamentos');
  const agora = Date.now();
  const avisar = Math.max(0, Math.round(Number(cfg().avisarDias) || 10)) * DIA;
  const linhas = [];
  let receita = 0, custo = 0;

  for (const acc of db.get().accounts) {
    for (const a of meus(acc)) {
      const vivo = a.status === 'ativo' || a.status === 'cancelando';
      if (vivo) { receita += a.precoCents || 0; custo += a.custoCents || 0; }
      linhas.push({
        accountId: acc.id, conta: acc.name, email: acc.email,
        numero: a.numero, status: a.status,
        compradoEm: a.compradoEm, venceEm: a.venceEm,
        dias: a.venceEm ? Math.ceil((a.venceEm - agora) / DIA) : null,
        precoCents: a.precoCents || 0,
        custoCents: a.custoCents || 0,
        margemCents: (a.precoCents || 0) - (a.custoCents || 0),
        saldo: acc.wallet ? acc.wallet.balance : 0,
        // O cruzamento que importa numa tela só: vence logo E não tem com que
        // pagar. É esta lista que vira cancelamento se ninguém fizer nada.
        risco: vivo && a.venceEm - agora <= avisar &&
               (acc.wallet ? acc.wallet.balance : 0) < (a.precoCents || 0)
      });
    }
  }
  linhas.sort((x, y) => (x.venceEm || 0) - (y.venceEm || 0));

  return {
    preco: preco(), cicloDias: ciclo(), prazoSaldoDias: prazoSaldo(),
    avisarDias: Math.round(Number(cfg().avisarDias) || 10),
    revendaAtiva: revendaAtiva(),
    alugueis: linhas,
    ativos: linhas.filter(l => l.status === 'ativo' || l.status === 'cancelando').length,
    emRisco: linhas.filter(l => l.risco).length,
    receitaCents: receita, custoCents: custo, margemCents: receita - custo,
    receitaFmt: pagamentos.fmtBRL(receita), margemFmt: pagamentos.fmtBRL(receita - custo)
  };
}

// Salva a tabela de preços. Recusa preço abaixo do custo? Não: pode ser
// promoção deliberada. Mas o admin vê a margem negativa na própria tela.
function salvarPrecos(patch) {
  const c = cfg();
  if (patch.precoCents !== undefined) c.precoCents = Math.max(0, Math.round(Number(patch.precoCents) || 0));
  if (patch.cicloDias !== undefined) c.cicloDias = Math.max(1, Math.round(Number(patch.cicloDias) || 30));
  if (patch.prazoSaldoDias !== undefined) c.prazoSaldoDias = Math.max(0, Math.round(Number(patch.prazoSaldoDias) || 5));
  if (patch.avisarDias !== undefined) c.avisarDias = Math.max(0, Math.round(Number(patch.avisarDias) || 10));
  db.save();
  return visaoAdmin();
}

// Tick diário, com uma primeira passada 2min depois de subir — tarde o
// bastante para o banco estar carregado, cedo o bastante para um reinício
// diário não pular a varredura para sempre.
function startJob(broadcast) {
  const tick = async () => {
    try {
      const r = await varrer(broadcast);
      if (r.cancelados || r.semSaldo || r.perto.length) {
        store.logEvent({ type: 'num_varredura', ...r, perto: r.perto.length });
        avisarAdmin(r, broadcast);
      }
    } catch (e) { store.logEvent({ type: 'num_varredura_erro', error: e.message }); }
  };
  setTimeout(tick, 120000);
  setInterval(tick, DIA);
}

// O aviso do admin sai por SSE; o push é montado em avisospush.js a partir
// deste mesmo evento, para não haver duas versões do texto.
function avisarAdmin(resumo, broadcast) {
  if (!broadcast) return;
  broadcast('numeros_admin', {
    accountId: (db.findAdminAccount() || {}).id || '',
    cancelados: resumo.cancelados,
    semSaldo: resumo.semSaldo,
    perto: resumo.perto.length,
    primeiro: resumo.perto[0] || null
  });
}

module.exports = {
  cfg, padroes, preco, ciclo, prazoSaldo, revendaAtiva,
  ensure, meus, ativos, achar,
  comprar, cancelar, mensagens,
  publicoUm, visaoCliente, visaoAdmin, salvarPrecos,
  varrer, startJob, avisarAdmin
};
