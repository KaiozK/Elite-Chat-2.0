// ENCERRAMENTO DOS TESTES QUE SOBEM UM SERVIDOR
//
// Os testes passavam e mesmo assim o Node morria com 127:
//
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
//
// A causa é o teardown, não o teste. Com duas ou mais requisições, o agente do
// `fetch` (undici) deixa a conexão viva em keep-alive. Chamar `process.exit()`
// com o socket ainda FECHANDO dispara essa asserção no Windows — e como o
// `npm test` encadeia com `&&`, um teardown ruim parava a suíte inteira nos
// arquivos seguintes, escondendo tudo o que vinha depois.
//
// Aqui o encerramento é um só, para todos: fecha o agente HTTP, fecha o
// servidor e DEIXA O LAÇO DRENAR — em vez de matar o processo no meio.
// O `process.exit` fica como rede de segurança, com folga, e sem `ref` para
// não segurar nada por conta própria.
module.exports = async function encerrar(srv, falhas) {
  console.log(falhas ? `\n${falhas} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');

  // Derruba as conexões em keep-alive antes de qualquer coisa. Sem isto, elas
  // continuam abertas e o socket fica fechando durante a saída.
  try {
    const d = globalThis[Symbol.for('undici.globalDispatcher.1')];
    if (d && typeof d.destroy === 'function') await d.destroy();
  } catch { /* sem undici (Node antigo): nada a fazer */ }

  if (srv && typeof srv.close === 'function') {
    await new Promise(res => { try { srv.close(res); } catch { res(); } });
  }

  process.exitCode = falhas ? 1 : 0;

  // A REDE DE SEGURANÇA PRECISA SER `ref`. Ela era `unref()`, para não segurar
  // o processo por 400ms à toa — e com isso deixava de ser rede: quando alguma
  // coisa mantinha um handle vivo (um socket que não drenou, um timer solto), o
  // laço nunca esvaziava, o timer nunca disparava porque estava desreferenciado,
  // e o arquivo ficava PENDURADO. Como o `npm test` encadeia com `&&`, a suíte
  // inteira parava ali — depois de imprimir "TODOS OS TESTES PASSARAM", que é a
  // pior forma de travar, porque parece sucesso.
  //
  // Custo de referenciar: 400ms por arquivo. Um teste que trava custa a suíte.
  setTimeout(() => process.exit(falhas ? 1 : 0), 400);
};
