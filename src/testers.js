// ============================================================================
// TESTERS — contas de teste, criadas e governadas pelo admin
//
// Um tester usa o produto de verdade, com dados de verdade, sem pagar. É a
// conta que se dá para alguém experimentar antes de comprar, para um parceiro
// avaliar, ou para a própria equipe usar sem misturar com a operação.
//
// ---------------------------------------------------------------------------
// NÃO É SUPERCONTA, e a diferença é o ponto do arquivo
// ---------------------------------------------------------------------------
// Superconta é ilimitada: `isUnlimited` responde sim e todo teto e toda trava
// somem. Isso é certo para quem opera a plataforma e é errado para quem está
// testando — um tester com envio ilimitado gasta WhatsApp e SMS de VERDADE, na
// conta da plataforma, e ninguém percebe até a fatura.
//
// Então o tester tem teto. Quem define é o admin, num lugar só, e vale para
// todos: quantos módulos ficam abertos, quanto cada um pode usar, e QUANTOS
// testers podem existir ao mesmo tempo.
//
// ---------------------------------------------------------------------------
// AS TRÊS COISAS QUE O ADMIN GOVERNA
// ---------------------------------------------------------------------------
//
//   1. QUANTOS — um teto de contas. Sem ele, "criar um tester" vira o caminho
//      fácil para dar acesso de graça, e em seis meses há trinta contas que
//      ninguém lembra por que existem.
//
//   2. O QUÊ — quais módulos ficam abertos. É a lista de sempre (campanhas,
//      fluxos, Koonpay…), só que decidida aqui em vez de vir de um plano.
//
//   3. QUANTO — os tetos de uso. Não foi pedido junto, mas anda com o item
//      anterior: liberar o disparo sem dizer quantos é liberar a fatura da
//      Meta. O padrão nasce curto de propósito.
//
// ---------------------------------------------------------------------------
// TESTER NÃO É CLIENTE, e a contabilidade precisa saber
// ---------------------------------------------------------------------------
// Ele não paga, não tem plano, não entra na receita e não conta como cliente
// nos números do painel. Somá-lo ao total de clientes faria a plataforma
// parecer maior do que é — e é o tipo de número errado que se olha por meses
// sem desconfiar.
// ============================================================================

const db = require('./db');
const store = require('./store');

function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO DA PLATAFORMA
// ---------------------------------------------------------------------------
function cfg() {
  const p = db.get().platform;
  if (!p.testers || typeof p.testers !== 'object') p.testers = {};
  const t = p.testers;
  for (const [k, v] of Object.entries(padroes())) {
    if (t[k] === undefined) t[k] = (v && typeof v === 'object') ? { ...v } : v;
  }
  // Os módulos e os limites nascem completos: uma chave nova acrescentada ao
  // produto depois disso apareceria como `undefined` e seria lida como
  // desligada — um módulo que some sozinho de todas as contas de teste.
  for (const k of db.FEATURE_KEYS) if (t.modulos[k] === undefined) t.modulos[k] = modulosPadrao()[k];
  for (const [k, v] of Object.entries(limitesPadrao())) if (t.limites[k] === undefined) t.limites[k] = v;
  return t;
}

function modulosPadrao() {
  const o = {};
  // Tudo LIGADO por padrão: um tester existe para experimentar o produto, e um
  // produto pela metade não se avalia. Fechar é decisão do admin, caso a caso.
  for (const k of db.FEATURE_KEYS) o[k] = true;
  return o;
}

function limitesPadrao() {
  // CURTO DE PROPÓSITO. Cada disparo é uma mensagem paga na Meta, e cada SMS é
  // crédito real na Integra X — um teto generoso aqui vira dinheiro gasto por
  // alguém que não está comprando nada. O admin sobe quando precisar.
  return {
    sends: 200, campaigns: 5, contacts: 500,
    flows: 5, pixels: 2, links: 3, whatsapps: 1
  };
}

function padroes() {
  return {
    // Quantos podem existir ao mesmo tempo. Zero = nenhum, e é assim que se
    // fecha a porta sem apagar quem já existe.
    limite: 5,
    modulos: modulosPadrao(),
    limites: limitesPadrao()
  };
}

// ---------------------------------------------------------------------------
// QUEM É TESTER
// ---------------------------------------------------------------------------
function ehTester(acc) { return !!(acc && acc.tester && !acc.isAdmin); }

function todos() { return db.get().accounts.filter(ehTester); }

// ---------------------------------------------------------------------------
// O QUE UM TESTER PODE
//
// Chamadas por `limits.js`, que é quem o resto do produto pergunta. Ter as
// respostas aqui e não lá é o que impede a regra de um plano e a regra de um
// tester de se misturarem no mesmo `if`.
// ---------------------------------------------------------------------------
function modulosDe(acc) {
  if (!ehTester(acc)) return null;
  return db.normFeatures(cfg().modulos, cfg().modulos);
}

function limiteDe(acc, chave) {
  if (!ehTester(acc)) return undefined;
  const v = cfg().limites[chave];
  return v === undefined ? undefined : Number(v);
}

// ---------------------------------------------------------------------------
// CRIAÇÃO — só pelo admin, e só até o teto
// ---------------------------------------------------------------------------
function criar({ name, email, pass }) {
  const t = cfg();
  const mail = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw erro('Informe um e-mail válido');
  if (!pass || String(pass).length < 6) throw erro('A senha deve ter pelo menos 6 caracteres');
  if (db.findAccountByEmail(mail)) throw erro('Já existe uma conta com este e-mail', 409);

  const usados = todos().length;
  const limite = Math.max(0, Math.round(Number(t.limite) || 0));
  if (usados >= limite) {
    throw erro(limite === 0
      ? 'O limite de testers está em zero. Aumente em Testers antes de criar.'
      : `Limite de ${limite} tester(s) atingido. Aumente o limite ou remova um existente.`, 409);
  }

  const acc = db.newAccount({ name: String(name || '').trim() || mail, email: mail, pass: String(pass) });
  acc.tester = true;
  // SEM PRAZO E SEM PLANO. Não há trial no que não é cobrado, e um
  // `periodEnd` no passado faria a conta nascer bloqueada por falta de
  // assinatura — de uma assinatura que ela nunca vai ter.
  acc.billing.status = 'active';
  acc.billing.planId = '';
  acc.billing.periodEnd = 0;
  db.get().accounts.push(acc);
  db.save();
  store.logEvent({ type: 'tester_criado', accountId: acc.id, detail: acc.name });
  return acc;
}

// Remover é apagar a conta inteira, e por isso passa por aqui e não por um
// `delete` solto: é a única operação deste arquivo que destrói dado.
function remover(id) {
  const data = db.get();
  const i = data.accounts.findIndex(a => a.id === id && ehTester(a));
  if (i < 0) throw erro('Tester não encontrado', 404);
  const nome = data.accounts[i].name;
  data.accounts.splice(i, 1);
  db.save();
  store.logEvent({ type: 'tester_removido', accountId: id, detail: nome });
  return true;
}

// PROMOVER A CLIENTE. O caminho natural quando o teste deu certo: a conta deixa
// de ser tester e passa a assinar como qualquer outra, com o histórico inteiro
// preservado. Recriar do zero perderia os contatos e as conversas do teste, que
// é justamente o que faz a pessoa querer continuar.
function promover(id) {
  const acc = db.findAccount(id);
  if (!acc || !ehTester(acc)) throw erro('Tester não encontrado', 404);
  acc.tester = false;
  // Volta para a régua comercial: sem plano ativo, a próxima tela que ela vê é
  // a de Assinatura. É o estado certo — ela ainda não assinou.
  acc.billing.periodEnd = 0;
  db.save();
  store.logEvent({ type: 'tester_promovido', accountId: acc.id, detail: acc.name });
  return acc;
}

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO PELO ADMIN
// ---------------------------------------------------------------------------
function salvar(patch) {
  const t = cfg();
  if (patch.limite !== undefined) t.limite = Math.max(0, Math.min(500, Math.round(Number(patch.limite) || 0)));
  if (patch.modulos && typeof patch.modulos === 'object') {
    for (const k of db.FEATURE_KEYS) {
      if (patch.modulos[k] !== undefined) t.modulos[k] = !!patch.modulos[k];
    }
  }
  if (patch.limites && typeof patch.limites === 'object') {
    for (const k of Object.keys(limitesPadrao())) {
      if (patch.limites[k] === undefined) continue;
      const v = Math.round(Number(patch.limites[k]));
      // -1 é ilimitado e é uma escolha legítima do admin; abaixo disso não
      // significa nada e viraria teto negativo.
      t.limites[k] = Number.isFinite(v) ? Math.max(-1, v) : t.limites[k];
    }
  }
  db.save();
  return visao();
}

// ---------------------------------------------------------------------------
// O QUE O ADMIN VÊ
// ---------------------------------------------------------------------------
function visao() {
  const t = cfg();
  const lista = todos().map(a => ({
    id: a.id, nome: a.name, email: a.email,
    criadoEm: a.createdAt || 0,
    contatos: (a.contacts || []).length,
    conectado: !!(a.wa && a.wa.connected),
    // O que ele JÁ gastou do teto — é o número que diz se o teto está no
    // lugar certo. Sem isto, o admin decide os limites no escuro.
    //
    // `usage` é CALCULADO na hora (varre as mensagens do ciclo), e não um
    // contador guardado na conta: ler `acc.usage` daria undefined em todas.
    usoEnvios: (() => {
      try { return require('./limits').usage(a).sends || 0; } catch { return 0; }
    })()
  })).sort((x, y) => y.criadoEm - x.criadoEm);

  return {
    limite: t.limite,
    usados: lista.length,
    vagas: Math.max(0, t.limite - lista.length),
    modulos: { ...t.modulos },
    limites: { ...t.limites },
    testers: lista
  };
}

module.exports = {
  cfg, padroes, modulosPadrao, limitesPadrao,
  ehTester, todos, modulosDe, limiteDe,
  criar, remover, promover, salvar, visao
};
