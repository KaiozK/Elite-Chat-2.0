// ============================================================================
// PAÍSES E TELEFONE EM E.164
//
// O cadastro guardava o telefone como a pessoa digitasse: "(11) 98765-4321",
// "11987654321", "+55 11 98765-4321". Para DISPARAR cobrança por WhatsApp ou
// SMS isso não serve — os dois provedores querem E.164, e adivinhar o país a
// partir de um número solto erra.
//
// Então o país passa a ser escolhido (bandeira + código) e o que vai para o
// banco é sempre "+<código><nacional>", só dígitos depois do "+".
//
// A lista é curta de propósito: Brasil primeiro, e os países de onde
// realisticamente vem cliente. Acrescentar um é uma linha.
// ============================================================================

// A bandeira é o par de "letras regionais" Unicode do código ISO: BR → 🇧🇷.
// Sai daqui em vez de virem 60 emojis no fonte, e funciona para qualquer país
// que seja acrescentado depois.
function bandeira(iso) {
  return String(iso).toUpperCase().replace(/./g, c =>
    String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65));
}

// `nsn` é o tamanho do número NACIONAL (sem o código do país), usado só para
// avisar quem digitou errado. Onde varia, guardamos a faixa.
const PAISES = [
  { iso: 'BR', dial: '55', nome: 'Brasil', nsn: [10, 11] },
  { iso: 'PT', dial: '351', nome: 'Portugal', nsn: [9, 9] },
  { iso: 'US', dial: '1', nome: 'Estados Unidos', nsn: [10, 10] },
  { iso: 'AR', dial: '54', nome: 'Argentina', nsn: [10, 11] },
  { iso: 'CL', dial: '56', nome: 'Chile', nsn: [9, 9] },
  { iso: 'CO', dial: '57', nome: 'Colômbia', nsn: [10, 10] },
  { iso: 'MX', dial: '52', nome: 'México', nsn: [10, 10] },
  { iso: 'PY', dial: '595', nome: 'Paraguai', nsn: [9, 9] },
  { iso: 'UY', dial: '598', nome: 'Uruguai', nsn: [8, 9] },
  { iso: 'PE', dial: '51', nome: 'Peru', nsn: [9, 9] },
  { iso: 'BO', dial: '591', nome: 'Bolívia', nsn: [8, 8] },
  { iso: 'ES', dial: '34', nome: 'Espanha', nsn: [9, 9] },
  { iso: 'IT', dial: '39', nome: 'Itália', nsn: [9, 11] },
  { iso: 'FR', dial: '33', nome: 'França', nsn: [9, 9] },
  { iso: 'GB', dial: '44', nome: 'Reino Unido', nsn: [10, 10] },
  { iso: 'DE', dial: '49', nome: 'Alemanha', nsn: [10, 11] },
  { iso: 'AO', dial: '244', nome: 'Angola', nsn: [9, 9] },
  { iso: 'MZ', dial: '258', nome: 'Moçambique', nsn: [9, 9] },
  { iso: 'CA', dial: '1', nome: 'Canadá', nsn: [10, 10] },
  { iso: 'PA', dial: '507', nome: 'Panamá', nsn: [8, 8] }
].map(p => ({ ...p, flag: bandeira(p.iso) }));

const porIso = iso => PAISES.find(p => p.iso === String(iso || '').toUpperCase());

// Lista pronta para o seletor: "🇧🇷 Brasil +55".
function opcoes() {
  return PAISES.map(p => ({ value: p.iso, label: `${p.flag} ${p.nome} +${p.dial}`, dial: p.dial, flag: p.flag }));
}

// ---------------------------------------------------------------------------
// Monta o E.164 a partir do país escolhido e do número nacional.
//
// Aceita que a pessoa digite o código do país junto (colando de outro lugar) e
// não duplica: "+55 11 98765-4321" com Brasil escolhido continua +5511987654321.
// ---------------------------------------------------------------------------
function paraE164(iso, numero) {
  const p = porIso(iso) || porIso('BR');
  let n = String(numero || '').replace(/\D/g, '');
  if (!n) return { ok: false, erro: 'Informe o WhatsApp' };

  // veio com o código do país na frente? tira, para não virar +5555119...
  if (n.length > p.nsn[1] && n.startsWith(p.dial)) n = n.slice(p.dial.length);
  // zero de tronco ("0 11 9...") não entra no E.164
  n = n.replace(/^0+/, '');

  const [min, max] = p.nsn;
  if (n.length < min || n.length > max) {
    return {
      ok: false,
      erro: `Número de ${p.nome} tem ${min === max ? min : min + ' a ' + max} dígitos com o DDD. Você digitou ${n.length}.`
    };
  }
  return { ok: true, e164: '+' + p.dial + n, iso: p.iso, dial: p.dial, national: n };
}

// Caminho inverso, para preencher o formulário a partir do que está no banco.
function deE164(e164) {
  const n = String(e164 || '').replace(/\D/g, '');
  if (!n) return null;
  // do código mais longo para o mais curto: +1 casaria antes de +55
  const p = [...PAISES].sort((a, b) => b.dial.length - a.dial.length).find(x => n.startsWith(x.dial));
  if (!p) return null;
  return { iso: p.iso, dial: p.dial, flag: p.flag, national: n.slice(p.dial.length) };
}

// Como mostrar na tela: "🇧🇷 +55 11 98765-4321".
function formatar(e164) {
  const d = deE164(e164);
  if (!d) return String(e164 || '');
  const n = d.national;
  if (d.iso === 'BR' && (n.length === 10 || n.length === 11)) {
    const ddd = n.slice(0, 2), resto = n.slice(2);
    const meio = resto.length === 9 ? resto.slice(0, 5) : resto.slice(0, 4);
    return `${d.flag} +${d.dial} (${ddd}) ${meio}-${resto.slice(meio.length)}`;
  }
  return `${d.flag} +${d.dial} ${n}`;
}

module.exports = { PAISES, opcoes, porIso, paraE164, deE164, formatar, bandeira };
