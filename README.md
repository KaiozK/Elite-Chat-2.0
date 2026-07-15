# WA CRM — CRM de WhatsApp com API Oficial da Meta (Cloud API)

CRM completo de atendimento via WhatsApp integrado à **WhatsApp Business Cloud API** (API oficial da Meta): inbox em tempo real, contatos, funil kanban, templates, mídia, respostas rápidas, logs de webhook e painel admin para configurar todas as credenciais.

## Como rodar

```bash
cd whatsapp-crm
npm install
npm start        # http://localhost:3900
```

Login inicial: **admin / admin** (troque em Configurações → Segurança).
Os dados ficam em `data/db.json` (criado automaticamente).

Para mudar a porta: `set PORT=8080 && npm start` (Windows) ou `PORT=8080 npm start`.

## Expor o webhook publicamente (desenvolvimento)

A Meta exige uma **URL pública com HTTPS**. Em desenvolvimento use um túnel:

```bash
# Cloudflare Tunnel (grátis, sem conta)
cloudflared tunnel --url http://localhost:3900

# ou ngrok
ngrok http 3900
```

O túnel gera algo como `https://xxxx.trycloudflare.com` → sua Callback URL será `https://xxxx.trycloudflare.com/webhook`.

Em produção, hospede em um servidor com HTTPS (VPS + Nginx/Caddy, Railway, Render etc.).

## Configuração na Meta — passo a passo

### 1. Criar o app
1. Acesse [developers.facebook.com](https://developers.facebook.com) → **Meus apps → Criar app**.
2. Tipo **Empresa/Business**, vincule ao seu **Portfólio empresarial** (Business Manager).
3. No painel do app, adicione o produto **WhatsApp**.

### 2. Pegar os IDs e o token
Em **WhatsApp → Configuração da API** você encontra:
- **Phone Number ID** (do número de teste ou do seu número)
- **WhatsApp Business Account ID (WABA ID)**
- **Token de acesso temporário** (expira em 24h — bom para testar)

Em **Configurações do app → Básico**:
- **App ID** e **App Secret** (o secret valida a assinatura do webhook)

### 3. Token permanente (produção)
1. [business.facebook.com](https://business.facebook.com) → **Configurações do negócio → Usuários → Usuários do sistema** → criar usuário do sistema (função Admin).
2. Em **Adicionar ativos**, atribua o **app** e a **conta do WhatsApp (WABA)** ao usuário do sistema.
3. **Gerar token** selecionando o app e as permissões:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
4. Cole esse token no painel do CRM (Configurações → Access Token).

### 4. Configurar o webhook
1. No CRM, abra **Configurações → Webhook** e copie a **Callback URL** e o **Verify Token**.
2. No app da Meta: **WhatsApp → Configuração → Webhook → Editar**, cole os dois e salve — a Meta fará um `GET /webhook` de verificação (aparece em Webhook/Logs no CRM).
3. Em **Campos do webhook**, assine **`messages`** (obrigatório; os demais são opcionais).
4. No CRM, clique em **“Assinar app na WABA”** (chama `POST /{waba_id}/subscribed_apps` — sem isso os eventos não chegam).

### 5. Testar
- Com o **número de teste** da Meta você pode conversar com até 5 números cadastrados na aba "Configuração da API".
- Envie um WhatsApp para o número → a conversa aparece no CRM em tempo real.
- **Janela de 24h**: você só responde livremente até 24h após a última mensagem do cliente; fora disso, apenas **templates aprovados**.
- Para produção com seu número real: verifique o número (Configurações → Registro do número), verifique a empresa no Business Manager e mude o app para o modo **Ativo/Live**.

## O que o painel faz

| Área | Recursos |
|---|---|
| **Dashboard** | Métricas, checklist da integração, distribuição do funil |
| **Conversas** | Inbox em tempo real (SSE), envio de texto/mídia/templates/botões, recibos ✓✓, respostas rápidas, confirmação de leitura |
| **Contatos** | CRUD, tags, anotações, etapa do funil, busca |
| **Funil** | Kanban drag-and-drop com etapas personalizáveis |
| **Modelos** | Sincronizar/criar/excluir templates na Meta, status de aprovação |
| **Webhook/Logs** | Todos os eventos brutos recebidos da Meta, tentativas de verificação, erros de assinatura |
| **Configurações** | Credenciais, webhook, diagnóstico (testar conexão/token/WABA), perfil comercial, registro do número, senha |

## Chamadas da Graph API implementadas

| Recurso | Endpoint Meta |
|---|---|
| Enviar texto, mídia, template, interativo (botões/lista), localização, reação, contatos | `POST /{phone_number_id}/messages` |
| Confirmação de leitura + indicador de digitação | `POST /{phone_number_id}/messages` (`status: read`) |
| Upload de mídia | `POST /{phone_number_id}/media` |
| URL/да download de mídia | `GET /{media_id}` + download autenticado |
| Listar/criar/excluir templates | `GET/POST/DELETE /{waba_id}/message_templates` |
| Dados do número | `GET /{phone_number_id}` |
| Verificação do número | `POST /{phone_number_id}/request_code` e `/verify_code` |
| Registro na Cloud API | `POST /{phone_number_id}/register` e `/deregister` |
| Dados da WABA + números | `GET /{waba_id}` e `/{waba_id}/phone_numbers` |
| Assinatura de webhooks na WABA | `GET/POST/DELETE /{waba_id}/subscribed_apps` |
| Perfil comercial | `GET/POST /{phone_number_id}/whatsapp_business_profile` |
| Validação de token | `GET /debug_token` |
| Verificação do webhook | `GET /webhook` (hub.challenge) |
| Recebimento de eventos (com validação `X-Hub-Signature-256`) | `POST /webhook` |

## API interna (REST)

Tudo sob `/api`, autenticado por `Authorization: Bearer <token>` (obtido em `POST /api/login`). Principais rotas: `/send/text`, `/send/template`, `/send/media`, `/send/buttons`, `/send/interactive`, `/send/location`, `/send/reaction`, `/media/upload`, `/templates`, `/contacts`, `/conversations`, `/messages/:waId`, `/quick-replies`, `/webhook-log`, `/settings`, `/dashboard`, `/events` (SSE). Útil para integrar com outros sistemas seus.

## Segurança

- Assinatura `X-Hub-Signature-256` validada em todo POST do webhook quando o **App Secret** está configurado (recomendado).
- Verify Token aleatório gerado na instalação (pode regenerar no painel).
- Senha admin com hash SHA-256; troque a senha padrão no primeiro acesso.
- O Access Token fica apenas no servidor (`data/db.json`) — não exponha essa pasta.
