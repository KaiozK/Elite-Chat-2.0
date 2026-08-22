/* ===========================================================================
   BI AO VIVO DE UM DISPARO — desenho compartilhado
   ===========================================================================
   Uma função só, `KoonfyBI.pintar(elemento, relatorio)`, usada em dois
   lugares: a aba dentro do painel e a página pública do link de
   acompanhamento. As duas telas mostram o MESMO disparo para pessoas
   diferentes — quem disparou e quem contratou o disparo —, e uma tela
   que muda de forma dependendo de quem olha é uma tela em que ninguém
   confia.

   POR QUE ANIMAR. O relatório já existia parado. O que faltava era
   perceber a mudança: número que troca sozinho não avisa que trocou, e
   quem está acompanhando um disparo está justamente esperando ver algo
   se mexer. As barras crescem e os números sobem contando — não como
   enfeite, mas porque o movimento É o dado novo.

   POR QUE REPINTAR SÓ O QUE MUDOU. A primeira versão trocava o HTML
   inteiro a cada evento. Num disparo de 2 mil contatos isso é uma
   remontagem por destinatário: a tabela pisca, a rolagem volta ao topo e
   quem estava lendo uma resposta perde a linha. Aqui a estrutura é
   montada uma vez e os eventos seguintes só atualizam texto e largura.
   =========================================================================== */
(function (global) {
  'use strict';

  var N = function (v) { return (Number(v) || 0).toLocaleString('pt-BR'); };
  var PCT = function (v) { return (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'; };

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function quando(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
           d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  // CONTAGEM ATÉ O NÚMERO. Só faz sentido quando o número cresce: começar
  // do zero a cada atualização faria o painel piscar para trás toda vez
  // que um destinatário a mais entrasse na conta.
  function contarAte(el, alvo) {
    var de = Number(el.dataset.v || 0);
    if (de === alvo) return;
    el.dataset.v = String(alvo);
    var t0 = null, dur = Math.min(900, 220 + Math.abs(alvo - de) * 8);
    function passo(t) {
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / dur);
      k = 1 - Math.pow(1 - k, 3);                       // desacelera no fim
      el.textContent = N(Math.round(de + (alvo - de) * k));
      if (k < 1) requestAnimationFrame(passo);
    }
    requestAnimationFrame(passo);
  }

  var ETAPAS = [
    { k: 'enviadas',  rot: 'Enviadas' },
    { k: 'entregues', rot: 'Entregues' },
    { k: 'lidas',     rot: 'Lidas' },
    { k: 'cliques',   rot: 'Cliques' },
    { k: 'respostas', rot: 'Respostas' },
    { k: 'falhas',    rot: 'Falhas', falha: true }
  ];

  var SIT = {
    lida: 'Lida', entregue: 'Entregue', enviada: 'Enviada',
    falha: 'Falha', pendente: 'Na fila'
  };

  function esqueleto(rel) {
    var linhas = ETAPAS.map(function (e) {
      return '<div class="bi-linha' + (e.falha ? ' falha' : '') + '" data-etapa="' + e.k + '">' +
               '<span>' + e.rot + '</span>' +
               '<div class="bi-trilho"><i></i></div>' +
               '<b><span data-n="' + e.k + '">0</span><small data-p="' + e.k + '"></small></b>' +
             '</div>';
    }).join('');

    return '' +
      '<div class="bi-topo">' +
        '<div>' +
          '<h2 data-c="nome"></h2>' +
          '<p class="bi-sub" data-c="sub"></p>' +
        '</div>' +
        '<div class="bi-dir"><span class="bi-vivo" data-c="vivo"><i></i><em data-c="vivoTxt" style="font-style:normal">ao vivo</em></span></div>' +
      '</div>' +

      '<div class="bi-kpis">' +
        '<div class="bi-kpi destaque"><b data-n="total">0</b><span>Destinatários</span><em data-c="fila"></em></div>' +
        '<div class="bi-kpi"><b data-n="entregues">0</b><span>Entregues</span><em data-p="entregues"></em></div>' +
        '<div class="bi-kpi"><b data-n="lidas">0</b><span>Lidas</span><em data-p="lidas"></em></div>' +
        '<div class="bi-kpi"><b data-n="cliques">0</b><span>Cliques</span><em data-c="ctr"></em></div>' +
        '<div class="bi-kpi"><b data-n="respostas">0</b><span>Respostas</span><em data-c="tresp"></em></div>' +
      '</div>' +

      '<div class="bi-cartao">' +
        '<h3>Funil do disparo <small>cada etapa sobre o total de destinatários</small></h3>' +
        '<div class="bi-funil">' + linhas + '</div>' +
      '</div>' +

      '<div class="bi-cartao">' +
        '<h3>Taxas</h3>' +
        '<div class="bi-taxas">' +
          '<div class="bi-taxa"><b data-c="txEntrega"></b><span>Entrega, sobre enviadas</span></div>' +
          '<div class="bi-taxa"><b data-c="txLeitura"></b><span>Leitura, sobre enviadas</span></div>' +
          '<div class="bi-taxa"><b data-c="txCtr"></b><span>CTR, sobre quem leu</span></div>' +
          '<div class="bi-taxa"><b data-c="txResp"></b><span>Resposta, sobre entregues</span></div>' +
        '</div>' +
        '<p class="bi-vazio" data-c="avisoLeitura" style="margin-top:12px;display:none"></p>' +
      '</div>' +

      '<div class="bi-cartao" data-c="caixaBotoes" style="display:none">' +
        '<h3>Cliques por botão</h3>' +
        '<div class="bi-barras" data-c="botoes"></div>' +
      '</div>' +

      '<div class="bi-cartao" data-c="caixaUfs" style="display:none">' +
        '<h3>Onde estão <small>por estado, do DDD</small></h3>' +
        '<div class="bi-barras" data-c="ufs"></div>' +
      '</div>' +

      '<div class="bi-cartao">' +
        '<h3>Pessoas <small data-c="pessoasSub"></small></h3>' +
        '<div style="overflow-x:auto"><table class="bi-tab"><thead><tr>' +
          '<th>Contato</th><th>Situação</th><th>Clique</th><th>Resposta</th>' +
        '</tr></thead><tbody data-c="pessoas"></tbody></table></div>' +
      '</div>';
  }

  function linhaPessoa(p) {
    var sit = SIT[p.situacao] || p.situacao;
    return '<tr>' +
      '<td data-r="Contato"><b>' + esc(p.nome || 'Sem nome') + '</b>' +
        '<div class="bi-fone">' + esc(p.waId) + (p.uf ? ' · ' + esc(p.uf) : '') + '</div></td>' +
      '<td data-r="Situação"><span class="bi-selo ' + esc(p.situacao) + '">' + esc(sit) + '</span></td>' +
      '<td data-r="Clique">' + (p.clicou ? '<span class="bi-selo lida">' + esc(p.botao || 'Clicou') + '</span>' : '<span class="bi-fone">—</span>') + '</td>' +
      '<td data-r="Resposta">' + (p.resposta
        ? '<span class="bi-resp">' + (p.resposta.texto ? esc(p.resposta.texto) : '<i>' + esc(p.resposta.tipo) + '</i>') +
          '<time>' + quando(p.resposta.quando) + '</time></span>'
        : '<span class="bi-fone">—</span>') + '</td>' +
    '</tr>';
  }

  function barras(itens, max) {
    return itens.map(function (i) {
      var largura = max > 0 ? Math.max(2, Math.round(i.valor / max * 100)) : 0;
      return '<div class="bi-barra"><span>' + esc(i.rotulo) + '</span>' +
             '<div class="bi-trilho"><i style="width:' + largura + '%"></i></div>' +
             '<b>' + N(i.valor) + '</b></div>';
    }).join('');
  }

  // Chave do que já está desenhado: se não mudou, não redesenha. Sem isso a
  // tabela de pessoas seria remontada a cada evento — e um disparo grande
  // manda um evento por destinatário.
  function assinatura(rel) {
    var g = rel.geral || {};
    return [g.total, g.enviadas, g.entregues, g.lidas, g.cliques, g.respostas, g.falhas, g.pendentes,
            (rel.pessoas || []).length, rel.status].join('|');
  }

  function pintar(raiz, rel) {
    if (!raiz || !rel) return;
    var g = rel.geral || {};
    if (!raiz.classList.contains('bi')) raiz.classList.add('bi');
    if (raiz.dataset.montado !== '1') { raiz.innerHTML = esqueleto(rel); raiz.dataset.montado = '1'; }

    var q = function (sel) { return raiz.querySelector(sel); };
    var texto = function (nome, valor) { var el = q('[data-c="' + nome + '"]'); if (el) el.textContent = valor; };

    texto('nome', rel.nome || 'Campanha');
    texto('sub', [rel.conta, rel.template ? 'Template: ' + rel.template : '', rel.canal,
                  rel.criadaEm ? 'Criada em ' + quando(rel.criadaEm) : '']
                 .filter(Boolean).join(' · '));

    var rodando = rel.status !== 'done';
    var selo = q('[data-c="vivo"]');
    if (selo) selo.className = 'bi-vivo' + (rodando ? '' : ' fim');
    texto('vivoTxt', rodando ? 'ao vivo' : 'concluída');

    // números
    ['total', 'enviadas', 'entregues', 'lidas', 'cliques', 'respostas', 'falhas', 'pendentes'].forEach(function (k) {
      Array.prototype.forEach.call(raiz.querySelectorAll('[data-n="' + k + '"]'), function (el) {
        contarAte(el, Number(g[k]) || 0);
      });
    });

    // porcentagens sobre o total, que é a régua do funil
    var tot = Number(g.total) || 0;
    ['enviadas', 'entregues', 'lidas', 'cliques', 'respostas', 'falhas'].forEach(function (k) {
      var v = Number(g[k]) || 0;
      var pct = tot > 0 ? Math.round(v / tot * 1000) / 10 : 0;
      Array.prototype.forEach.call(raiz.querySelectorAll('[data-p="' + k + '"]'), function (el) { el.textContent = PCT(pct); });
      var linha = q('[data-etapa="' + k + '"] .bi-trilho i');
      if (linha) linha.style.width = Math.min(100, pct) + '%';
    });

    texto('fila', g.pendentes ? N(g.pendentes) + ' na fila' : (rodando ? 'saindo agora' : 'fila concluída'));
    texto('ctr', 'CTR ' + PCT(g.ctrSobreLidas) + ' sobre lidas');
    texto('tresp', PCT(g.taxaResposta) + ' de quem recebeu');
    texto('txEntrega', PCT(g.taxaEntrega));
    texto('txLeitura', PCT(g.taxaLeitura));
    texto('txCtr', PCT(g.ctrSobreLidas));
    texto('txResp', PCT(g.taxaResposta));

    var aviso = q('[data-c="avisoLeitura"]');
    if (aviso) {
      aviso.style.display = rel.leituraParcial ? '' : 'none';
      aviso.textContent = 'Nenhuma leitura confirmada. A Meta só informa "lida" de quem tem a confirmação de leitura ligada no WhatsApp — as entregas acima continuam valendo.';
    }

    var bts = (rel.botoes || []).map(function (b) { return { rotulo: b.rotulo, valor: b.cliques }; });
    var cxB = q('[data-c="caixaBotoes"]');
    if (cxB) cxB.style.display = bts.length ? '' : 'none';
    if (bts.length) q('[data-c="botoes"]').innerHTML = barras(bts, Math.max.apply(null, bts.map(function (b) { return b.valor; })));

    var ufs = (rel.estados || []).slice(0, 8).map(function (e) { return { rotulo: e.nome || e.uf, valor: e.total }; });
    var cxU = q('[data-c="caixaUfs"]');
    if (cxU) cxU.style.display = ufs.length ? '' : 'none';
    if (ufs.length) q('[data-c="ufs"]').innerHTML = barras(ufs, Math.max.apply(null, ufs.map(function (e) { return e.valor; })));

    var corpo = q('[data-c="pessoas"]');
    var chave = assinatura(rel);
    if (corpo && raiz.dataset.chave !== chave) {
      raiz.dataset.chave = chave;
      var pessoas = rel.pessoas || [];
      corpo.innerHTML = pessoas.length
        ? pessoas.slice(0, 400).map(linhaPessoa).join('')
        : '<tr><td colspan="4"><p class="bi-vazio">Nenhum destinatário ainda.</p></td></tr>';
      texto('pessoasSub', pessoas.length > 400
        ? 'as 400 primeiras de ' + N(pessoas.length) + ', quem respondeu na frente'
        : 'quem respondeu e quem clicou na frente');
    }
  }

  global.KoonfyBI = { pintar: pintar, esc: esc, quando: quando };
})(window);
