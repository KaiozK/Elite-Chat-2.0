// ============================================================================
// CPF e CNPJ — validação de verdade
//
// Até aqui só se conferia o TAMANHO (11 ou 14 dígitos) e se não eram todos
// iguais. Ou seja: "123.456.789-01" passava. Isso vira problema real de duas
// formas — a Simplify recusa a cobrança na hora de gerar o Pix (e o cliente vê
// um erro do gateway em vez de um aviso claro no formulário), e um documento
// errado que passe fica gravado no contato e na conciliação para sempre.
//
// DUAS CAMADAS, e é importante saber o que cada uma garante:
//
//   1. DÍGITOS VERIFICADORES (aqui, offline, instantâneo)
//      CPF e CNPJ têm dois dígitos calculados a partir dos anteriores. Um
//      número inventado quase nunca fecha a conta: a chance de acertar os dois
//      dígitos no chute é de 1 em 100. Isto derruba o grosso.
//
//   2. EXISTÊNCIA (só CNPJ, consultando a Receita)
//      Passar nos dígitos não quer dizer que o documento EXISTE. Para CNPJ dá
//      para conferir de graça na BrasilAPI, que lê o cadastro da Receita
//      Federal. Para CPF NÃO existe consulta pública gratuita — a da Receita
//      exige captcha, e os serviços que fazem isso são pagos. Então, para CPF,
//      a verificação de existência é a do próprio adquirente no momento de
//      gerar a cobrança, e a mensagem dele já é repassada ao cliente.
//
// Nada aqui bloqueia por indisponibilidade: se a consulta falhar ou demorar, o
// documento passa com os dígitos conferidos. Derrubar uma venda porque uma API
// de terceiro caiu seria pior que o problema que ela resolve.
// ============================================================================

function so(n) { return String(n || '').replace(/\D/g, ''); }

// ---------------------------------------------------------------------------
// CPF: 9 dígitos + 2 verificadores.
// Cada verificador é a soma dos anteriores com pesos decrescentes, módulo 11.
// ---------------------------------------------------------------------------
function cpfValido(valor) {
  const d = so(valor);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;      // 111.111.111-11 fecha a conta, mas não vale
  for (let rodada = 0; rodada < 2; rodada++) {
    const ate = 9 + rodada;
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (ate + 1 - i);
    const resto = (soma * 10) % 11;
    if ((resto === 10 ? 0 : resto) !== Number(d[ate])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// CNPJ: 12 dígitos + 2 verificadores, com pesos que voltam a 9 e recomeçam.
// ---------------------------------------------------------------------------
function cnpjValido(valor) {
  const d = so(valor);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  const conferir = (ate) => {
    let soma = 0, peso = ate - 7;
    for (let i = 0; i < ate; i++) {
      soma += Number(d[i]) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return (resto < 2 ? 0 : 11 - resto) === Number(d[ate]);
  };
  return conferir(12) && conferir(13);
}

// CPF ou CNPJ, decidido pelo tamanho.
function docValido(valor) {
  const d = so(valor);
  if (d.length === 11) return cpfValido(d);
  if (d.length === 14) return cnpjValido(d);
  return false;
}

// Mensagem pronta para o formulário, ou null quando está tudo certo. A
// mensagem diz o que está errado — "CPF inválido" e não "documento inválido" —
// porque quem digitou precisa saber onde olhar.
function erroDoc(valor, { obrigatorio = true } = {}) {
  const d = so(valor);
  if (!d) return obrigatorio ? 'Informe o CPF ou CNPJ' : null;
  if (d.length !== 11 && d.length !== 14) {
    return 'CPF ou CNPJ inválido: ' + (d.length < 11 ? 'faltam dígitos' : 'dígitos a mais');
  }
  if (docValido(d)) return null;
  return d.length === 11
    ? 'CPF inválido. Confira os números digitados'
    : 'CNPJ inválido. Confira os números digitados';
}

function formatarDoc(valor) {
  const d = so(valor);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d;
}

// ---------------------------------------------------------------------------
// EXISTÊNCIA DO CNPJ (BrasilAPI → Receita Federal)
//
// Devolve { existe, razaoSocial, situacao, erro }. `existe: null` significa
// "não deu para saber" (rede, limite de uso, timeout) — e isso NÃO reprova o
// documento, só deixa de confirmar.
// ---------------------------------------------------------------------------
const CNPJ_API = 'https://brasilapi.com.br/api/cnpj/v1/';
const cacheCnpj = new Map();     // consulta repetida do mesmo CNPJ não sai de novo

async function consultarCnpj(valor, { timeoutMs = 3500 } = {}) {
  const d = so(valor);
  if (d.length !== 14 || !cnpjValido(d)) return { existe: false, erro: 'CNPJ inválido' };
  if (cacheCnpj.has(d)) return cacheCnpj.get(d);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let out;
  try {
    // O User-Agent NÃO é enfeite: sem ele a BrasilAPI responde 403 e toda
    // consulta virava "indisponível".
    const r = await fetch(CNPJ_API + d, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'Koonfy/1.0 (+https://koonfy.com)' }
    });
    if (r.status === 404) out = { existe: false, erro: 'CNPJ não encontrado na Receita Federal' };
    else if (!r.ok) out = { existe: null, erro: 'consulta indisponível (HTTP ' + r.status + ')' };
    else {
      const j = await r.json();
      out = {
        existe: true,
        razaoSocial: j.razao_social || j.nome_fantasia || '',
        situacao: j.descricao_situacao_cadastral || ''
      };
    }
  } catch (e) {
    out = { existe: null, erro: e.name === 'AbortError' ? 'consulta demorou demais' : e.message };
  } finally {
    clearTimeout(t);
  }
  // Só vale a pena guardar respostas conclusivas: uma falha de rede não pode
  // ficar em cache respondendo por um CNPJ que talvez exista.
  if (out.existe !== null) {
    cacheCnpj.set(d, out);
    if (cacheCnpj.size > 500) cacheCnpj.delete(cacheCnpj.keys().next().value);
  }
  return out;
}

// Validação completa: dígitos sempre; existência do CNPJ quando `online`.
// Devolve a mensagem de erro, ou null.
async function erroDocCompleto(valor, { obrigatorio = true, online = true } = {}) {
  const basico = erroDoc(valor, { obrigatorio });
  if (basico) return basico;
  const d = so(valor);
  if (!online || d.length !== 14) return null;
  const r = await consultarCnpj(d);
  if (r.existe === false) return 'CNPJ não encontrado na Receita Federal';
  return null;                    // existe, ou não deu para conferir
}

module.exports = {
  so, cpfValido, cnpjValido, docValido, erroDoc, erroDocCompleto,
  formatarDoc, consultarCnpj
};
