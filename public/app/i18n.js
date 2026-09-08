// ============================================================================
// IDIOMA DO PAINEL — Português (BR), English, Español
//
// POR QUE ASSIM, E NÃO COM CHAVES
//
// O painel tem 19 mil linhas com o texto escrito direto no HTML gerado:
// `<b>Conversas</b>`, e não `<b>${t('inbox.title')}</b>`. Trocar tudo por
// chaves seria reescrever o arquivo inteiro de uma vez — e um erro de digitação
// numa chave não aparece como erro, aparece como texto sumido na tela do
// cliente.
//
// Então a tradução acontece por CORRESPONDÊNCIA EXATA da frase em português:
// o português é a própria chave. Isso tem três consequências boas e uma regra
// que precisa ser respeitada:
//
//   + funciona no que já existe, sem tocar no resto do código;
//   + o que ainda não foi traduzido continua aparecendo em português, legível,
//     em vez de sumir ou virar "inbox.title";
//   + escrever uma tela nova não exige lembrar de nada: se a frase estiver no
//     dicionário, ela traduz sozinha.
//
//   ! a regra: só traduz o texto que for IGUAL, inteiro, a uma entrada do
//     dicionário. Nunca pedaço de frase — senão um nome de cliente que por
//     acaso contenha uma palavra do dicionário seria alterado.
//
// O QUE NUNCA É TRADUZIDO
//
// Conteúdo do cliente. Mensagem de conversa, nome de contato, nome de etiqueta,
// texto de campanha: nada disso é interface, e traduzir seria adulterar o dado
// de quem usa. As áreas que carregam esse conteúdo são puladas por seletor
// (ver PULAR), e qualquer elemento pode se declarar fora com `data-sem-traducao`.
// ============================================================================

(function () {
  const IDIOMAS = {
    'pt-BR': { nome: 'Português (BR)', curto: 'PT', bandeira: '🇧🇷' },
    'en':    { nome: 'English',        curto: 'EN', bandeira: '🇺🇸' },
    'es':    { nome: 'Español',        curto: 'ES', bandeira: '🇪🇸' }
  };

  // As áreas que mostram dado do cliente. O que estiver dentro delas nunca é
  // tocado, mesmo que por acaso coincida com uma entrada do dicionário.
  const PULAR = [
    '[data-sem-traducao]', 'script', 'style', 'textarea', 'code', 'pre',
    '.chat-msgs', '.msg', '.bubble', '.conv-list', '.conv-item',
    '.contact-list', '.tag', '.chip-tag', '.team-msgs'
  ].join(',');

  const DIC = {
    en: {
      // ---- navegação e cabeçalho ----
      'Dashboard': 'Dashboard', 'Conversas': 'Conversations', 'Chat interno': 'Team chat',
      'Contatos': 'Contacts', 'Funil': 'Pipeline', 'Funil de Vendas': 'Sales pipeline',
      'Agendamentos': 'Schedule', 'Agenda': 'Schedule', 'Campanhas': 'Campaigns',
      'Modelos': 'Templates', 'Modelo': 'Template', 'Respostas Rápidas': 'Quick replies',
      'Respostas': 'Quick replies', 'Flow Builder': 'Flow Builder', 'Automação': 'Automation',
      'Automações': 'Automations', 'Integrações': 'Integrations', 'Webhooks': 'Webhooks',
      'Pixels': 'Pixels', 'Links rastreáveis': 'Trackable links', 'Links': 'Links',
      'Tracking': 'Tracking', 'Pagamentos': 'Payments', 'Cobrar': 'Charge',
      'Assinatura': 'Subscription', 'Afiliação': 'Referrals', 'Atendentes': 'Agents',
      'Equipe': 'Team', 'Configurações': 'Settings', 'Ajustes': 'Settings',
      'Atendimento': 'Service', 'Início': 'Home', 'Geral': 'General',
      'Opt-in & Opt-out': 'Opt-in & Opt-out', 'Opt-in &amp; Opt-out': 'Opt-in &amp; Opt-out',
      'Números virtuais': 'Virtual numbers', 'Meus números': 'My numbers',
      'Agente de IA': 'AI agent', 'SMS': 'SMS', 'Nuvemshop': 'Nuvemshop',
      'Minha conta': 'My account', 'Sair': 'Sign out', 'Entrar': 'Sign in',
      'Idioma': 'Language',
      // ---- ações ----
      'Salvar': 'Save', 'Cancelar': 'Cancel', 'Fechar': 'Close', 'Excluir': 'Delete',
      'EXCLUIR': 'DELETE', 'Editar': 'Edit', 'Criar': 'Create', 'Adicionar': 'Add',
      'Enviar': 'Send', 'Copiar': 'Copy', 'Abrir': 'Open', 'Abrir link': 'Open link',
      'Buscar': 'Search', 'Limpar': 'Clear', 'Voltar': 'Back', 'Continuar': 'Continue',
      'Confirmar': 'Confirm', 'Testar': 'Test', 'Atualizar': 'Refresh',
      'Baixar': 'Download', 'Exportar': 'Export', 'Importar': 'Import',
      'Conectar': 'Connect', 'Desconectar': 'Disconnect', 'Sim': 'Yes', 'Não': 'No',
      'Mais': 'More', 'Ver tudo': 'See all', 'Nova campanha': 'New campaign',
      'Criar modelo': 'Create template', 'Gerar Pix': 'Generate Pix',
      'Depositar na carteira': 'Add funds to wallet', 'Recarga automática': 'Auto top-up',
      // ---- campos ----
      'Nome': 'Name', 'Nome (opcional)': 'Name (optional)', 'E-mail': 'Email',
      'Telefone': 'Phone', 'Senha': 'Password', 'Valor': 'Amount', 'Valor (R$)': 'Amount (R$)',
      'Data': 'Date', 'Status': 'Status', 'Descrição': 'Description', 'Título': 'Title',
      'Texto': 'Text', 'Mensagem': 'Message', 'Etapa': 'Stage', 'Etiqueta': 'Tag',
      'Origem': 'Source', 'Método': 'Method', 'Motivo (opcional)': 'Reason (optional)',
      'Código': 'Code', 'Link': 'Link', 'Evento': 'Event', 'Eventos': 'Events',
      'Cargo': 'Role', 'Estado': 'State', 'Endereço': 'Address', 'Cidade': 'City',
      'Identificação': 'Identification', 'CPF ou CNPJ': 'Tax ID',
      'Nome da empresa': 'Company name', 'Nome do atendente': 'Agent name',
      'Nome da automação': 'Automation name', 'Nome da etapa': 'Stage name',
      'Notas internas': 'Internal notes', 'Quando': 'When', 'De': 'From', 'Até': 'To',
      'Número': 'Number', 'Conta': 'Account', 'Contas': 'Accounts', 'Contato': 'Contact',
      'Cliente': 'Customer', 'Total': 'Total', 'Hoje': 'Today', 'Mês': 'Month',
      'Pagamento': 'Payment', 'Boleto': 'Bank slip', 'Pix': 'Pix',
      'Cartão de crédito': 'Credit card', 'Carteira': 'Wallet', 'Saldo': 'Balance',
      'Saque': 'Withdrawal', 'Sacar': 'Withdraw', 'Comissão': 'Commission',
      // ---- estados e métricas ----
      'Entregues': 'Delivered', 'Lidas': 'Read', 'Falhas': 'Failures',
      'Enviadas': 'Sent', 'Pendente': 'Pending', 'Pago': 'Paid', 'Ativo': 'Active',
      'Ativa': 'Active', 'Inativo': 'Inactive', 'Conectado': 'Connected',
      'Desconectada': 'Disconnected', 'Conectada': 'Connected', 'Online': 'Online',
      'Offline': 'Offline', 'Ausente': 'Away', 'Em atendimento': 'Busy',
      'Finalizadas': 'Closed', 'Abandonadas': 'Abandoned', 'Execuções': 'Runs',
      'Conversão': 'Conversion', 'Lucro': 'Profit', 'Gasto': 'Spent',
      'Contatos ativos': 'Active contacts', 'Indicados': 'Referred',
      'Cadastro': 'Sign-up', 'Cadastros': 'Sign-ups', 'Criada': 'Created',
      'Nenhum resultado': 'No results', 'Carregando…': 'Loading…',
      // ---- frases da tela ----
      'Buscar contato...': 'Search contact...',
      'Buscar por nome, telefone ou tag...': 'Search by name, phone or tag...',
      'Escreva uma mensagem… (Enter envia)': 'Write a message… (Enter sends)',
      'Escreva a mensagem…': 'Write the message…',
      'Olá! Como posso ajudar?': 'Hi! How can I help?',
      'Falar com atendente': 'Talk to an agent',
      'Falar com o suporte': 'Contact support',
      'Acesse sua conta': 'Sign in to your account',
      'Ainda não é cliente?': 'Not a customer yet?',
      'CRM de WhatsApp com IA': 'WhatsApp CRM with AI',
      'Koonfy | CRM de WhatsApp Profissional': 'Koonfy | Professional WhatsApp CRM',
      'Avaliar atendimento': 'Rate this service',
      'O que o cliente recebe': 'What the customer gets',
      'O que você recebe': 'What you get',
      'Nenhuma loja conectada': 'No store connected',
      'Conectar loja Nuvemshop': 'Connect Nuvemshop store',
      'Importar meus clientes': 'Import my customers',
      'Escolha uma opção:': 'Choose an option:',
      // ---- o restante do shell do painel ----
      'Abrir menu': 'Open menu',
      'Alternar tema': 'Toggle theme',
      'Tema claro/escuro': 'Light/dark theme',
      'Menu': 'Menu',
      'Navegação principal': 'Main navigation',
      'Mais telas': 'More screens',
      'Painel de atendimento e vendas': 'Service and sales panel',
      'Notificações': 'Notifications',
      'Buscar contato…  ( / )': 'Search contact…  ( / )',
      'Sistema': 'System',
      'Respostas rápidas': 'Quick replies',
      'Checkout Builder': 'Checkout Builder',
      'Colaboradores': 'Team members',
      'Negócio': 'Business',
      'Vendas': 'Sales',
      'Segmento': 'Segment',
      'Recebimento': 'Payouts',
      'Chave Pix': 'Pix key',
      'Tipo da chave Pix': 'Pix key type',
      'a chave que recebe': 'the receiving key',
      'Depositar': 'Add funds',
      'Ver carteira': 'View wallet',
      'Ver os planos': 'See plans',
      'Verificando…': 'Checking…',
      'Sair': 'Sign out',
      'Senha': 'Password',
      'Insira seu WhatsApp': 'Enter your WhatsApp number',
      'Código de indicação (opcional)': 'Referral code (optional)',
      'Ao criar a conta você aceita os': 'By creating an account you accept the',
      'Termos de Uso': 'Terms of Use',
      'Política de Privacidade': 'Privacy Policy',
      'Pular e criar a conta': 'Skip and create the account',
      'O que você quer resolver primeiro': 'What do you want to solve first',
      'Com estes dados a sua conta de': 'With this information your',
      'Trocar a conta do WhatsApp': 'Switch WhatsApp account',
      'Koonfy v1.0 · API Oficial Meta': 'Koonfy v1.0 · Official Meta API',
      'Idioma / Language / Idioma': 'Idioma / Language / Idioma',
      'voce@empresa.com': 'you@company.com',
      'Minha Empresa': 'My Company',
      'WhatsApp': 'WhatsApp',
      'Koonpay': 'Koonpay',
      'Koonfy': 'Koonfy',
      'SMS': 'SMS',
      'Nuvemshop': 'Nuvemshop',
      'Pipeline': 'Pipeline'
    },
    es: {
      'Dashboard': 'Panel', 'Conversas': 'Conversaciones', 'Chat interno': 'Chat interno',
      'Contatos': 'Contactos', 'Funil': 'Embudo', 'Funil de Vendas': 'Embudo de ventas',
      'Agendamentos': 'Agenda', 'Agenda': 'Agenda', 'Campanhas': 'Campañas',
      'Modelos': 'Plantillas', 'Modelo': 'Plantilla', 'Respostas Rápidas': 'Respuestas rápidas',
      'Respostas': 'Respuestas', 'Flow Builder': 'Flow Builder', 'Automação': 'Automatización',
      'Automações': 'Automatizaciones', 'Integrações': 'Integraciones', 'Webhooks': 'Webhooks',
      'Pixels': 'Píxeles', 'Links rastreáveis': 'Enlaces rastreables', 'Links': 'Enlaces',
      'Tracking': 'Tracking', 'Pagamentos': 'Pagos', 'Cobrar': 'Cobrar',
      'Assinatura': 'Suscripción', 'Afiliação': 'Afiliados', 'Atendentes': 'Agentes',
      'Equipe': 'Equipo', 'Configurações': 'Configuración', 'Ajustes': 'Configuración',
      'Atendimento': 'Atención', 'Início': 'Inicio', 'Geral': 'General',
      'Opt-in & Opt-out': 'Opt-in y Opt-out', 'Opt-in &amp; Opt-out': 'Opt-in y Opt-out',
      'Números virtuais': 'Números virtuales', 'Meus números': 'Mis números',
      'Agente de IA': 'Agente de IA', 'SMS': 'SMS', 'Nuvemshop': 'Nuvemshop',
      'Minha conta': 'Mi cuenta', 'Sair': 'Salir', 'Entrar': 'Entrar',
      'Idioma': 'Idioma',
      'Salvar': 'Guardar', 'Cancelar': 'Cancelar', 'Fechar': 'Cerrar', 'Excluir': 'Eliminar',
      'EXCLUIR': 'ELIMINAR', 'Editar': 'Editar', 'Criar': 'Crear', 'Adicionar': 'Añadir',
      'Enviar': 'Enviar', 'Copiar': 'Copiar', 'Abrir': 'Abrir', 'Abrir link': 'Abrir enlace',
      'Buscar': 'Buscar', 'Limpar': 'Limpiar', 'Voltar': 'Volver', 'Continuar': 'Continuar',
      'Confirmar': 'Confirmar', 'Testar': 'Probar', 'Atualizar': 'Actualizar',
      'Baixar': 'Descargar', 'Exportar': 'Exportar', 'Importar': 'Importar',
      'Conectar': 'Conectar', 'Desconectar': 'Desconectar', 'Sim': 'Sí', 'Não': 'No',
      'Mais': 'Más', 'Ver tudo': 'Ver todo', 'Nova campanha': 'Nueva campaña',
      'Criar modelo': 'Crear plantilla', 'Gerar Pix': 'Generar Pix',
      'Depositar na carteira': 'Depositar en la billetera', 'Recarga automática': 'Recarga automática',
      'Nome': 'Nombre', 'Nome (opcional)': 'Nombre (opcional)', 'E-mail': 'Correo',
      'Telefone': 'Teléfono', 'Senha': 'Contraseña', 'Valor': 'Importe', 'Valor (R$)': 'Importe (R$)',
      'Data': 'Fecha', 'Status': 'Estado', 'Descrição': 'Descripción', 'Título': 'Título',
      'Texto': 'Texto', 'Mensagem': 'Mensaje', 'Etapa': 'Etapa', 'Etiqueta': 'Etiqueta',
      'Origem': 'Origen', 'Método': 'Método', 'Motivo (opcional)': 'Motivo (opcional)',
      'Código': 'Código', 'Link': 'Enlace', 'Evento': 'Evento', 'Eventos': 'Eventos',
      'Cargo': 'Cargo', 'Estado': 'Estado', 'Endereço': 'Dirección', 'Cidade': 'Ciudad',
      'Identificação': 'Identificación', 'CPF ou CNPJ': 'CPF o CNPJ',
      'Nome da empresa': 'Nombre de la empresa', 'Nome do atendente': 'Nombre del agente',
      'Nome da automação': 'Nombre de la automatización', 'Nome da etapa': 'Nombre de la etapa',
      'Notas internas': 'Notas internas', 'Quando': 'Cuándo', 'De': 'Desde', 'Até': 'Hasta',
      'Número': 'Número', 'Conta': 'Cuenta', 'Contas': 'Cuentas', 'Contato': 'Contacto',
      'Cliente': 'Cliente', 'Total': 'Total', 'Hoje': 'Hoy', 'Mês': 'Mes',
      'Pagamento': 'Pago', 'Boleto': 'Boleto', 'Pix': 'Pix',
      'Cartão de crédito': 'Tarjeta de crédito', 'Carteira': 'Billetera', 'Saldo': 'Saldo',
      'Saque': 'Retiro', 'Sacar': 'Retirar', 'Comissão': 'Comisión',
      'Entregues': 'Entregados', 'Lidas': 'Leídos', 'Falhas': 'Fallos',
      'Enviadas': 'Enviadas', 'Pendente': 'Pendiente', 'Pago': 'Pagado', 'Ativo': 'Activo',
      'Ativa': 'Activa', 'Inativo': 'Inactivo', 'Conectado': 'Conectado',
      'Desconectada': 'Desconectada', 'Conectada': 'Conectada', 'Online': 'En línea',
      'Offline': 'Desconectado', 'Ausente': 'Ausente', 'Em atendimento': 'Ocupado',
      'Finalizadas': 'Finalizadas', 'Abandonadas': 'Abandonados', 'Execuções': 'Ejecuciones',
      'Conversão': 'Conversión', 'Lucro': 'Beneficio', 'Gasto': 'Gastado',
      'Contatos ativos': 'Contactos activos', 'Indicados': 'Referidos',
      'Cadastro': 'Registro', 'Cadastros': 'Registros', 'Criada': 'Creada',
      'Nenhum resultado': 'Sin resultados', 'Carregando…': 'Cargando…',
      'Buscar contato...': 'Buscar contacto...',
      'Buscar por nome, telefone ou tag...': 'Buscar por nombre, teléfono o etiqueta...',
      'Escreva uma mensagem… (Enter envia)': 'Escribe un mensaje… (Enter envía)',
      'Escreva a mensagem…': 'Escribe el mensaje…',
      'Olá! Como posso ajudar?': '¡Hola! ¿Cómo puedo ayudar?',
      'Falar com atendente': 'Hablar con un agente',
      'Falar com o suporte': 'Contactar con soporte',
      'Acesse sua conta': 'Accede a tu cuenta',
      'Ainda não é cliente?': '¿Aún no eres cliente?',
      'CRM de WhatsApp com IA': 'CRM de WhatsApp con IA',
      'Koonfy | CRM de WhatsApp Profissional': 'Koonfy | CRM de WhatsApp Profesional',
      'Avaliar atendimento': 'Valorar la atención',
      'O que o cliente recebe': 'Lo que recibe el cliente',
      'O que você recebe': 'Lo que recibes',
      'Nenhuma loja conectada': 'Ninguna tienda conectada',
      'Conectar loja Nuvemshop': 'Conectar tienda Nuvemshop',
      'Importar meus clientes': 'Importar mis clientes',
      'Escolha uma opção:': 'Elige una opción:',
      // ---- o restante do shell do painel ----
      'Abrir menu': 'Abrir menú',
      'Alternar tema': 'Cambiar tema',
      'Tema claro/escuro': 'Tema claro/oscuro',
      'Menu': 'Menú',
      'Navegação principal': 'Navegación principal',
      'Mais telas': 'Más pantallas',
      'Painel de atendimento e vendas': 'Panel de atención y ventas',
      'Notificações': 'Notificaciones',
      'Buscar contato…  ( / )': 'Buscar contacto…  ( / )',
      'Sistema': 'Sistema',
      'Respostas rápidas': 'Respuestas rápidas',
      'Checkout Builder': 'Checkout Builder',
      'Colaboradores': 'Colaboradores',
      'Negócio': 'Negocio',
      'Vendas': 'Ventas',
      'Segmento': 'Segmento',
      'Recebimento': 'Cobros',
      'Chave Pix': 'Clave Pix',
      'Tipo da chave Pix': 'Tipo de clave Pix',
      'a chave que recebe': 'la clave que recibe',
      'Depositar': 'Depositar',
      'Ver carteira': 'Ver billetera',
      'Ver os planos': 'Ver los planes',
      'Verificando…': 'Verificando…',
      'Sair': 'Salir',
      'Senha': 'Contraseña',
      'Insira seu WhatsApp': 'Introduce tu WhatsApp',
      'Código de indicação (opcional)': 'Código de referido (opcional)',
      'Ao criar a conta você aceita os': 'Al crear la cuenta aceptas los',
      'Termos de Uso': 'Términos de Uso',
      'Política de Privacidade': 'Política de Privacidad',
      'Pular e criar a conta': 'Omitir y crear la cuenta',
      'O que você quer resolver primeiro': 'Qué quieres resolver primero',
      'Com estes dados a sua conta de': 'Con estos datos tu cuenta de',
      'Trocar a conta do WhatsApp': 'Cambiar la cuenta de WhatsApp',
      'Koonfy v1.0 · API Oficial Meta': 'Koonfy v1.0 · API Oficial de Meta',
      'Idioma / Language / Idioma': 'Idioma / Language / Idioma',
      'voce@empresa.com': 'tu@empresa.com',
      'Minha Empresa': 'Mi Empresa',
      'WhatsApp': 'WhatsApp',
      'Koonpay': 'Koonpay',
      'Koonfy': 'Koonfy',
      'SMS': 'SMS',
      'Nuvemshop': 'Nuvemshop',
      'Pipeline': 'Embudo'
    }
  };

  // O idioma escolhido sobrevive ao recarregar. `localStorage` pode lançar
  // (aba anônima, cookies bloqueados) e um painel não pode deixar de abrir por
  // causa de uma preferência de idioma.
  const CHAVE = 'koonfy_idioma';
  function lido() {
    try { const v = localStorage.getItem(CHAVE); if (IDIOMAS[v]) return v; } catch (e) {}
    // Sem escolha, segue o navegador — quem abre o painel em inglês já vê em
    // inglês, que é o caso de quem está revisando o aplicativo.
    const nav = (navigator.language || 'pt-BR').toLowerCase();
    if (nav.startsWith('es')) return 'es';
    if (nav.startsWith('en')) return 'en';
    return 'pt-BR';
  }
  let idioma = lido();

  function T(pt) {
    const d = DIC[idioma];
    if (!d) return pt;
    const t = String(pt == null ? '' : pt);
    return d[t] !== undefined ? d[t] : (d[t.trim()] !== undefined ? d[t.trim()] : pt);
  }

  // ---- a passada no DOM ----
  //
  // Percorre só nós de TEXTO e três atributos visíveis. Um nó só é trocado se o
  // conteúdo INTEIRO, sem os espaços das pontas, for uma entrada do dicionário:
  // é isso que impede um nome de cliente de ser alterado por conter uma palavra
  // conhecida.
  function traduzir(raiz) {
    if (idioma === 'pt-BR' || !raiz) return 0;
    const d = DIC[idioma];
    if (!d) return 0;
    let n = 0;

    const it = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
      acceptNode(no) {
        const t = no.nodeValue;
        if (!t || !t.trim()) return NodeFilter.FILTER_REJECT;
        if (d[t.trim()] === undefined) return NodeFilter.FILTER_REJECT;
        if (no.parentElement && no.parentElement.closest(PULAR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const achados = [];
    while (it.nextNode()) achados.push(it.currentNode);
    for (const no of achados) {
      // Preserva os espaços das pontas: eles às vezes separam do ícone ao lado.
      const bruto = no.nodeValue;
      const m = bruto.match(/^(\s*)([\s\S]*?)(\s*)$/);
      no.nodeValue = m[1] + d[m[2]] + m[3];
      n++;
    }

    for (const attr of ['placeholder', 'title', 'aria-label']) {
      raiz.querySelectorAll('[' + attr + ']').forEach(el => {
        if (el.closest(PULAR)) return;
        const v = (el.getAttribute(attr) || '').trim();
        if (d[v] !== undefined) { el.setAttribute(attr, d[v]); n++; }
      });
    }
    return n;
  }

  // A tela é redesenhada o tempo todo (SSE, troca de aba, modal). Em vez de
  // pedir para cada tela chamar a tradução — que alguém esqueceria —, um
  // observador traduz o que aparece. Agrupado por quadro para não rodar uma vez
  // por nó inserido.
  let pendente = false;
  function agendar() {
    if (pendente || idioma === 'pt-BR') return;
    pendente = true;
    requestAnimationFrame(() => { pendente = false; traduzir(document.body); });
  }

  function aplicar(novo, recarregar) {
    if (!IDIOMAS[novo]) return;
    idioma = novo;
    try { localStorage.setItem(CHAVE, novo); } catch (e) {}
    document.documentElement.setAttribute('lang', novo);
    // Voltar para o português exige redesenhar: o texto original foi
    // substituído no lugar, e não há de onde tirá-lo de volta. Trocar entre os
    // outros dois também, para não traduzir por cima do que já foi traduzido.
    if (recarregar !== false) location.reload();
  }

  window.KoonfyIdioma = {
    IDIOMAS, atual: () => idioma, T, traduzir, aplicar,
    lista: () => Object.entries(IDIOMAS).map(([v, x]) => ({ value: v, ...x }))
  };
  window.T = T;

  // O seletor do topo. Preenchido aqui e não no HTML para a lista de idiomas
  // existir num lugar só — acrescentar um idioma é acrescentar uma entrada em
  // IDIOMAS, e a tela acompanha.
  function montarSeletor() {
    const sel = document.getElementById('sel-idioma');
    if (!sel) return;
    sel.innerHTML = Object.entries(IDIOMAS)
      .map(([v, x]) => `<option value="${v}"${v === idioma ? ' selected' : ''}>${x.bandeira} ${x.curto}</option>`)
      .join('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.setAttribute('lang', idioma);
    montarSeletor();
    traduzir(document.body);
    new MutationObserver(agendar).observe(document.body, { childList: true, subtree: true });
  });
})();
