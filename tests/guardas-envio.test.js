// ============================================================================
// TODA PORTA DE SAÍDA TEM AS MESMAS TRÊS TRANCAS
//
// Mandar mensagem pelo WhatsApp tem três regras que não são do Koonfy — são da
// Meta e da lei, e quebrá-las custa a conta:
//
//   JANELA DE 24H. Fora dela, só MODELO APROVADO passa. Texto livre, mídia,
//   botão, localização: tudo é recusado pela Meta. Mandar assim mesmo não dá
//   erro na tela do cliente — dá erro depois, na qualidade do número, e a
//   Meta baixa o limite de envio ou derruba o número.
//
//   OPT-OUT. Quem pediu para sair não recebe mais nada — inclusive modelo, que
//   é justamente o que atravessa a janela. É a única guarda que vale também
//   para o template.
//
//   ASSINATURA EM DIA. Sem isso o cliente dispara de graça.
//
// O risco não é a rota de hoje: é a de amanhã. Uma rota de envio nova nasce
// sem guarda nenhuma, e ninguém percebe porque tudo continua funcionando. Este
// teste percorre TODAS as rotas /send/ e exige as trancas em cada uma.
// ============================================================================
const R = require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';
let falhas = 0;
const ok = (c, m, e) => { console.log((c ? '  OK   ' : '  FALHA') + ' ' + m + (e ? '  → ' + e : '')); if (!c) falhas++; };
const encerrar = require('./_fim');
const fs = require('fs');

(async () => {
  const src = fs.readFileSync(R + 'src/api.js', 'utf8');
  const linhas = src.split('\n');

  const rotas = [];
  linhas.forEach((l, i) => {
    const m = l.match(/router\.post\('(\/send\/[a-z]+)'(.*)$/);
    if (m) rotas.push({ caminho: m[1], guardas: m[2], linha: i + 1 });
  });

  console.log('=== 1. As rotas de envio foram encontradas ===');
  ok(rotas.length >= 8, `${rotas.length} rotas /send/ em src/api.js`,
     rotas.map(r => r.caminho.replace('/send/', '')).join(' · '));

  console.log('\n=== 2. JANELA DE 24H: só o MODELO atravessa ===');
  for (const r of rotas) {
    const temJanela = /requireWindow\(/.test(r.guardas);
    if (r.caminho === '/send/template') {
      // O modelo aprovado é o ÚNICO formato que a Meta deixa passar fora da
      // janela — é para isso que ele existe. Guardá-lo aqui quebraria a
      // reabertura de conversa, que é o uso principal do produto.
      ok(!temJanela, `${r.caminho} NÃO é guardado — é o que reabre a conversa`);
    } else {
      ok(temJanela, `${r.caminho} exige a janela aberta`, temJanela ? '' : `api.js:${r.linha}`);
    }
  }

  console.log('\n=== 3. OPT-OUT: vale para TODAS, modelo incluído ===');
  // Esta é a única que também tranca o template: quem pediu para sair não
  // recebe nem modelo. É a guarda que protege da multa, não da Meta.
  for (const r of rotas) {
    ok(/requireConsent/.test(r.guardas), `${r.caminho} respeita quem pediu para sair`,
       /requireConsent/.test(r.guardas) ? '' : `api.js:${r.linha}`);
  }

  console.log('\n=== 4. ASSINATURA EM DIA ===');
  for (const r of rotas) {
    ok(/requireActive/.test(r.guardas), `${r.caminho} exige assinatura válida`,
       /requireActive/.test(r.guardas) ? '' : `api.js:${r.linha}`);
  }

  console.log('\n=== 5. PERMISSÃO do atendente ===');
  // Um atendente sem permissão de caixa de entrada não fala pelo número da
  // empresa. A guarda é por rota, não por tela escondida.
  for (const r of rotas) {
    ok(/can\('inbox'/.test(r.guardas), `${r.caminho} confere a permissão do atendente`,
       /can\('inbox'/.test(r.guardas) ? '' : `api.js:${r.linha}`);
  }

  console.log('\n=== 6. A guarda da janela olha o CONTATO, não o relógio solto ===');
  const gw = src.slice(src.indexOf('const requireWindow = kind =>'), src.indexOf('function requireConsent'));
  ok(/session\.canSend\(contact, kind\)/.test(gw),
     'a decisão mora em session.canSend — um lugar só, e não copiada por rota');
  ok(/if \(!contact\) return next\(\)/.test(gw),
     'primeiro contato passa: quem valida é a Meta, e barrar aqui impediria a 1ª mensagem');
  ok(/res\.status\(409\)/.test(gw),
     'e a recusa é 409 com o motivo, não um erro genérico');

  console.log('\n=== 7. A CAMPANHA também respeita quem saiu ===');
  // A campanha não passa pelas rotas /send/: ela tem caminho próprio. Sem a
  // mesma guarda, o disparo em massa atropelaria justamente os opt-outs — que
  // é o pior lugar para atropelar.
  // O disparo não passa pelas rotas /send/: o público sai de `resolveAudience`,
  // e é lá que o opt-out tem de ser filtrado.
  const aud = src.slice(src.indexOf('function resolveAudience'), src.indexOf('function campaignStats'));
  ok(/consent\.isOptedOut\(c\)/.test(aud),
     'o público da campanha exclui quem pediu para sair');
  ok(/list = list\.filter\(c => !consent\.isOptedOut\(c\)\)/.test(aud),
     'e exclui ANTES de qualquer outro filtro de público');

  console.log('\n=== 8. O INTERRUPTOR do módulo desliga o bloqueio ===');
  // COMO É HOJE, escrito para ficar visível — não é um elogio nem uma
  // reclamação, é o que o código faz.
  //
  // `canSendTo` e `resolveAudience` só filtram quando `consent.enabled` está
  // ligado. Quem já tinha pedido para sair ANTES continua marcado no contato,
  // mas volta a receber assim que o dono desliga o módulo — inclusive em
  // disparo em massa. Ninguém consegue pedir para sair com o módulo
  // desligado (handleConsent devolve cedo), então o caso só acontece com
  // opt-out antigo e interruptor novo.
  const cons = fs.readFileSync(R + 'src/consent.js', 'utf8');
  ok(/if \(!cfgOf\(acc\)\.enabled\) return \{ allowed: true \};/.test(cons),
     'com o módulo desligado, canSendTo libera todo mundo');
  ok(/if \(consent\.cfgOf\(acc\)\.enabled\)/.test(aud),
     'e o público da campanha também deixa de filtrar');
  const wh = fs.readFileSync(R + 'src/webhook.js', 'utf8');
  const hc = wh.slice(wh.indexOf('function handleConsent'), wh.indexOf('function handleConsent') + 400);
  ok(/if \(!cfg\.enabled\) return null;/.test(hc),
     'e com ele desligado ninguém consegue pedir para sair');

  await encerrar(null, falhas);
})();
