// ===========================================================================
// QUEM RECEBE CADA EVENTO AO VIVO
//
// Regra de um sistema multi-conta: um evento que tem dono vai para o dono.
// Estava escrita dentro do `broadcast` do server.js, numa linha só, com uma
// exceção que parecia inofensiva — `!c.isAdmin`, "o admin vê tudo".
//
// O app NÃO FILTRA nada do que chega pelo SSE: ele age. Então "ver tudo"
// significava, na prática:
//
//   • uma ligação recebida no WhatsApp de QUALQUER cliente fazia o aparelho do
//     administrador tocar, com tela de chamada e tudo — por uma ligação que
//     não era dele, num número onde a chamada nem está habilitada;
//   • cada mensagem que entrava em qualquer conta virava notificação no
//     aparelho dele COM O NOME DO CONTATO E O TEXTO da mensagem;
//   • "Venda aprovada" e comissão de outra conta tocavam como se fossem dele.
//
// A única tela do admin que se alimenta de evento de outra conta é o painel de
// Pagamentos da plataforma. Então é só esse que atravessa.
//
// Mora aqui fora, e não no server.js, pelo mesmo motivo de `avisospush.js`:
// dentro do servidor não havia como testar sem subir o processo inteiro, e foi
// exatamente por isso que a exceção ficou anos sem ninguém notar.
// ===========================================================================

// Eventos que um admin recebe mesmo sendo de outra conta.
const EVENTOS_DO_ADMIN = ['pagamentos'];

// `c` é o cliente SSE: { accountId, isAdmin, campanha }.
function entrega(c, event, data) {
  if (!c) return false;

  // ESPECTADOR DE LINK PÚBLICO: ouve só os eventos da campanha que o link dele
  // abre. Sem esta regra ele cairia no filtro de conta abaixo e receberia tudo
  // o que acontece na conta — mensagens, pagamentos, presença de atendente —,
  // que não é o que o link concede.
  if (c.campanha) return event === 'campaign' && !!data && data.id === c.campanha;

  // Evento sem dono (aviso de plataforma) vai para todo mundo, como sempre foi.
  if (!data || !data.accountId) return true;

  if (c.accountId === data.accountId) return true;
  return !!c.isAdmin && EVENTOS_DO_ADMIN.includes(event);
}

module.exports = { EVENTOS_DO_ADMIN, entrega };
