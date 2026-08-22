/* ===========================================================================
   RELATÓRIO AO VIVO DE UM DISPARO — o miolo, compartilhado
   ===========================================================================
   Duas telas mostram o MESMO disparo para pessoas diferentes: o relatório da
   campanha, dentro do painel, e a página pública do link de acompanhamento,
   para quem contratou o disparo e não tem conta.

   Este arquivo é o miolo das duas. Não é um desenho novo: ele monta os MESMOS
   componentes do resto do app — `.rc-funil`, `.card`, `.kpi-strip`, `table` —
   com as mesmas classes e os mesmos ícones. A página pública carrega
   `/app/style.css` e por isso sai idêntica ao painel, sem uma segunda folha de
   estilo para manter em dia.

   O que NÃO está aqui é o que só o painel tem: o mapa 3D do Brasil e a tabela
   de estados com filtro e ordenação. Eles dependem do app inteiro, e o link
   público não vai carregar o app inteiro para desenhar um mapa.

   POR QUE ANIMAR. O relatório já existia parado. O que faltava era perceber a
   mudança: número que troca sozinho não avisa que trocou, e quem acompanha um
   disparo está esperando ver algo se mexer.

   POR QUE REPINTAR SÓ O QUE MUDOU. Um disparo de 2 mil contatos emite um
   evento por destinatário. Remontar o HTML a cada um faria a tabela piscar e a
   rolagem voltar ao topo — quem estivesse lendo uma resposta perderia a linha.
   =========================================================================== */
(function (global) {
  'use strict';

  // Os mesmos traços do ícone do app: copiados de ICONS em app.js para que o
  // link público não desenhe um conjunto parecido, e sim o mesmo.
  var ICO = {
    send: '<path d="m22 2-11 11"/><path d="M22 2 15 21l-4-8-8-4 19-7z"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 5-5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    zap: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
    message: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 20l1.1-4.3A8.5 8.5 0 1 1 21 11.5z"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    buttons: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="12" height="6" rx="2"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.3M12 17h.01"/>'
  };
  function ico(nome, tam) {
    tam = tam || 16;
    return '<svg class="ic" viewBox="0 0 24 24" width="' + tam + '" height="' + tam +
           '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
           (ICO[nome] || '') + '</svg>';
  }

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

  // CONTAGEM ATÉ O NÚMERO, e não do zero a cada atualização: recomeçar faria o
  // painel piscar para trás toda vez que um destinatário a mais entrasse.
  function contarAte(el, alvo) {
    var de = Number(el.dataset.v || 0);
    if (de === alvo) return;
    el.dataset.v = String(alvo);
    var t0 = null, dur = Math.min(900, 220 + Math.abs(alvo - de) * 8);
    function passo(t) {
      if (t0 === null) t0 = t;
      var k = Math.min(1, (t - t0) / dur);
      k = 1 - Math.pow(1 - k, 3);
      el.textContent = N(Math.round(de + (alvo - de) * k));
      if (k < 1) requestAnimationFrame(passo);
    }
    requestAnimationFrame(passo);
  }

  // As etapas do funil, na ordem em que acontecem. RESPONDERAM é a única que
  // mede conversa e não entrega: clique é intenção, resposta é gente do outro
  // lado — e é o número que uma agência mostra para renovar contrato.
  var ETAPAS = [
    { k: 'enviadas',  rot: 'Enviadas',    ic: 'send' },
    { k: 'entregues', rot: 'Entregues',   ic: 'check-circle', pct: 'taxaEntrega' },
    { k: 'lidas',     rot: 'Lidas',       ic: 'eye',          pct: 'taxaLeitura' },
    { k: 'cliques',   rot: 'Clicaram',    ic: 'zap',          pct: 'taxaClique' },
    { k: 'respostas', rot: 'Responderam', ic: 'message',      pct: 'taxaResposta' },
    { k: 'falhas',    rot: 'Falhas',      ic: 'alert',        alerta: true }
  ];

  var SIT = { lida: 'read', entregue: 'delivered', enviada: 'sent', falha: 'failed', pendente: 'pending' };
  var SIT_ROT = { lida: 'Lida', entregue: 'Entregue', enviada: 'Enviada', falha: 'Falha', pendente: 'Na fila' };

  function esqueleto() {
    var funil = ETAPAS.map(function (e) {
      return '<div class="rc-et" data-etapa="' + e.k + '">' +
               '<span class="rc-et-ic">' + ico(e.ic, 15) + '</span>' +
               '<b data-n="' + e.k + '">0</b>' +
               '<span class="rc-et-lb">' + e.rot + '</span>' +
               (e.pct ? '<span class="rc-et-pc" data-p="' + e.k + '"></span>' : '') +
             '</div>';
    }).join('');

    return '' +
      '<div class="rc-funil">' + funil + '</div>' +

      '<div class="card" data-c="avisoLeitura" style="border-color:var(--amber-border);background:var(--amber-bg);display:none">' +
        '<b>' + ico('help', 14) + ' Nenhuma leitura confirmada</b>' +
        '<p class="muted" style="margin:5px 0 0;font-size:13px">As mensagens foram entregues, mas ninguém apareceu como "lida". ' +
        'A Meta só informa a leitura quando o cliente mantém a <b>confirmação de leitura ligada</b> no WhatsApp dele. ' +
        'Quem desliga conta apenas como entregue. O número aqui é o piso real, não o total de quem leu.</p>' +
      '</div>' +

      '<div class="kpi-strip">' +
        '<div class="kpi-mini"><span>Entrega</span><b data-p="entregues">0%</b><em>sobre enviadas</em></div>' +
        '<div class="kpi-mini"><span>Leitura</span><b data-p="lidas">0%</b><em>sobre enviadas</em></div>' +
        '<div class="kpi-mini"><span>CTR</span><b data-c="ctr">0%</b><em>sobre quem leu</em></div>' +
        '<div class="kpi-mini"><span>Resposta</span><b data-p="respostas">0%</b><em>sobre entregues</em></div>' +
        '<div class="kpi-mini"><span>Na fila</span><b data-n="pendentes">0</b><em>ainda não saíram</em></div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>' + ico('message') + ' Respostas</h2>' +
        '<p class="muted" style="margin:0 0 12px;font-size:12.5px">Quem escreveu de volta depois de receber o disparo. ' +
        'Conta a primeira mensagem enviada <b>depois</b> do envio, dentro de sete dias — conversa anterior não é resposta à campanha.</p>' +
        '<div data-c="respostas"></div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>' + ico('buttons') + ' Botões</h2>' +
        '<div data-c="botoes"></div>' +
      '</div>' +

      '<div class="card" data-c="caixaEstados" style="display:none">' +
        '<h2>' + ico('list') + ' Por estado</h2>' +
        '<div data-c="estados"></div>' +
      '</div>' +

      '<div class="card">' +
        '<h2>' + ico('list') + ' Destinatários <small class="muted" style="font-weight:500" data-c="pessoasSub"></small></h2>' +
        '<div style="overflow-x:auto"><table class="tab-mob"><thead><tr>' +
          '<th>Contato</th><th>Situação</th><th>Clique</th><th>Resposta</th>' +
        '</tr></thead><tbody data-c="pessoas"></tbody></table></div>' +
      '</div>';
  }

  function linhaPessoa(p) {
    return '<tr>' +
      '<td data-r="Contato"><b>' + esc(p.nome || 'Sem nome') + '</b>' +
        '<div class="muted" style="font-size:11.5px">' + esc(p.waId) + (p.uf ? ' · ' + esc(p.uf) : '') + '</div></td>' +
      '<td data-r="Situação"><span class="pill ' + (SIT[p.situacao] || '') + '">' + esc(SIT_ROT[p.situacao] || p.situacao) + '</span></td>' +
      '<td data-r="Clique">' + (p.clicou ? '<b>' + esc(p.botao || 'Clicou') + '</b>' : '<span class="muted">—</span>') + '</td>' +
      '<td data-r="Resposta">' + (p.resposta
        ? '<span class="bi-resp">' + (p.resposta.texto ? esc(p.resposta.texto) : '<i>' + esc(p.resposta.tipo) + '</i>') +
          '<time>' + quando(p.resposta.quando) + '</time></span>'
        : '<span class="muted">—</span>') + '</td>' +
    '</tr>';
  }

  function tabelaRespostas(rel) {
    var quem = (rel.pessoas || []).filter(function (p) { return p.resposta; });
    if (!quem.length) {
      return '<p class="muted" style="margin:0;font-size:13px">Ninguém respondeu ainda. ' +
             'Assim que alguém escrever de volta, a mensagem aparece aqui com o horário.</p>';
    }
    return '<div style="overflow-x:auto"><table class="tab-mob"><thead><tr>' +
           '<th>Contato</th><th>Respondeu</th><th>Quando</th></tr></thead><tbody>' +
           quem.map(function (p) {
             return '<tr>' +
               '<td data-r="Contato"><b>' + esc(p.nome || 'Sem nome') + '</b>' +
                 '<div class="muted" style="font-size:11.5px">' + esc(p.waId) + (p.uf ? ' · ' + esc(p.uf) : '') + '</div></td>' +
               '<td data-r="Respondeu"><span class="bi-resp">' +
                 (p.resposta.texto ? esc(p.resposta.texto) : '<i>' + esc(p.resposta.tipo) + '</i>') + '</span></td>' +
               '<td data-r="Quando" class="muted">' + quando(p.resposta.quando) + '</td>' +
             '</tr>';
           }).join('') + '</tbody></table></div>';
  }

  function tabelaBotoes(rel) {
    var g = rel.geral || {};
    if (!(rel.botoes || []).length) {
      return '<p class="muted" style="margin:0;font-size:13px">Este modelo não tem botões, ou ninguém tocou ainda. ' +
             'Botões de <b>resposta rápida</b> são contados aqui; botões de <b>link</b> saem do WhatsApp e a Meta não avisa o toque.</p>';
    }
    return '<p class="muted" style="margin:0 0 10px;font-size:12.5px">Quantas pessoas tocaram em cada botão. ' +
           'Conta uma vez por pessoa: quem clica duas vezes continua sendo um lead.</p>' +
           '<div style="overflow-x:auto"><table class="tab-mob"><thead><tr><th>Botão</th>' +
           '<th style="text-align:right">Cliques</th><th style="text-align:right">Sobre enviadas</th>' +
           '<th style="text-align:right">Sobre quem leu</th><th>Onde mais clicaram</th></tr></thead><tbody>' +
           rel.botoes.map(function (b) {
             var topo = Object.keys(b.ufs || {}).map(function (uf) { return [uf, b.ufs[uf]]; })
               .sort(function (x, y) { return y[1] - x[1]; }).slice(0, 3);
             return '<tr>' +
               '<td data-r="Botão"><b>' + esc(b.rotulo) + '</b></td>' +
               '<td data-r="Cliques" style="text-align:right"><b>' + N(b.cliques) + '</b></td>' +
               '<td data-r="Sobre enviadas" style="text-align:right">' + PCT(g.enviadas ? b.cliques / g.enviadas * 100 : 0) + '</td>' +
               '<td data-r="Sobre quem leu" style="text-align:right">' + PCT(g.lidas ? b.cliques / g.lidas * 100 : 0) + '</td>' +
               '<td data-r="Onde" class="muted">' + (topo.length ? topo.map(function (t) { return t[0] + ' (' + t[1] + ')'; }).join(', ') : '—') + '</td>' +
             '</tr>';
           }).join('') + '</tbody></table></div>';
  }

  function tabelaEstados(rel) {
    var lista = (rel.estados || []).slice(0, 12);
    if (!lista.length) return '<p class="muted" style="margin:0;font-size:13px">Nenhum estado identificado pelo DDD.</p>';
    return '<div style="overflow-x:auto"><table class="tab-mob"><thead><tr><th>Estado</th>' +
           '<th style="text-align:right">Leads</th><th style="text-align:right">Entregues</th>' +
           '<th style="text-align:right">Lidas</th><th style="text-align:right">Clicaram</th>' +
           '<th style="text-align:right">% leu</th></tr></thead><tbody>' +
           lista.map(function (e) {
             return '<tr>' +
               '<td data-r="Estado"><b>' + esc(e.uf) + '</b> <span class="muted">' + esc(e.nome) + '</span></td>' +
               '<td data-r="Leads" style="text-align:right">' + N(e.total) + '</td>' +
               '<td data-r="Entregues" style="text-align:right">' + N(e.entregues) + '</td>' +
               '<td data-r="Lidas" style="text-align:right">' + N(e.lidas) + '</td>' +
               '<td data-r="Clicaram" style="text-align:right"><b>' + N(e.cliques) + '</b></td>' +
               '<td data-r="% leu" style="text-align:right">' + PCT(e.taxaLeitura) + '</td>' +
             '</tr>';
           }).join('') + '</tbody></table></div>';
  }

  // Chave do que já está desenhado: se não mudou, não redesenha.
  function assinatura(rel) {
    var g = rel.geral || {};
    return [g.total, g.enviadas, g.entregues, g.lidas, g.cliques, g.respostas, g.falhas, g.pendentes,
            (rel.pessoas || []).length, (rel.botoes || []).length, rel.status].join('|');
  }

  /**
   * @param raiz  elemento onde o miolo é desenhado
   * @param rel   relatório vindo de /campaigns/:id/report ou /public/campanha/:token
   * @param opts  { estados: true } acrescenta a tabela por estado (o painel tem
   *              a própria, com mapa, filtro e ordenação)
   */
  function pintar(raiz, rel, opts) {
    if (!raiz || !rel) return;
    opts = opts || {};
    if (raiz.dataset.montado !== '1') { raiz.innerHTML = esqueleto(); raiz.dataset.montado = '1'; }

    var g = rel.geral || {};
    var q = function (sel) { return raiz.querySelector(sel); };
    var texto = function (nome, valor) { var el = q('[data-c="' + nome + '"]'); if (el) el.textContent = valor; };

    ['total', 'enviadas', 'entregues', 'lidas', 'cliques', 'respostas', 'falhas', 'pendentes'].forEach(function (k) {
      Array.prototype.forEach.call(raiz.querySelectorAll('[data-n="' + k + '"]'), function (el) {
        contarAte(el, Number(g[k]) || 0);
      });
    });

    ETAPAS.forEach(function (e) {
      if (!e.pct) return;
      Array.prototype.forEach.call(raiz.querySelectorAll('[data-p="' + e.k + '"]'), function (el) {
        el.textContent = PCT(g[e.pct]);
      });
    });
    texto('ctr', PCT(g.ctrSobreLidas));

    var falha = q('[data-etapa="falhas"]');
    if (falha) falha.classList.toggle('bad', (Number(g.falhas) || 0) > 0);

    var aviso = q('[data-c="avisoLeitura"]');
    if (aviso) aviso.style.display = rel.leituraParcial ? '' : 'none';

    var chave = assinatura(rel);
    if (raiz.dataset.chave !== chave) {
      raiz.dataset.chave = chave;
      var corpo = q('[data-c="pessoas"]');
      var pessoas = rel.pessoas || [];
      if (corpo) {
        corpo.innerHTML = pessoas.length
          ? pessoas.slice(0, 400).map(linhaPessoa).join('')
          : '<tr><td colspan="4"><p class="muted" style="margin:0">Nenhum destinatário ainda.</p></td></tr>';
      }
      texto('pessoasSub', pessoas.length > 400
        ? '· as 400 primeiras de ' + N(pessoas.length) + ', quem respondeu na frente'
        : '· quem respondeu e quem clicou na frente');
      q('[data-c="respostas"]').innerHTML = tabelaRespostas(rel);
      q('[data-c="botoes"]').innerHTML = tabelaBotoes(rel);
      var cxE = q('[data-c="caixaEstados"]');
      if (cxE) {
        cxE.style.display = opts.estados ? '' : 'none';
        if (opts.estados) q('[data-c="estados"]').innerHTML = tabelaEstados(rel);
      }
    }
  }

  global.KoonfyBI = { pintar: pintar, esc: esc, quando: quando, ico: ico };
})(window);
