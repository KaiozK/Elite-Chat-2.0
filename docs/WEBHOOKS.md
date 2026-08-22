# Koonfy — Mapa de Webhooks (documentação interna)

Levantamento completo dos webhooks do sistema: **o que chega, o que é usado, o que
é armazenado e o que é compartilhado entre módulos.** Base para o Cadastro
Automático de contatos e para o módulo de Opt-in/Opt-out.

Identificador principal do contato em **todos** os fluxos: **telefone (`waId`)**,
normalizado para dígitos (`store.normalizeWaId`). Nunca há contato duplicado —
`store.upsertContact` sempre casa pelo `waId`.

---

## 1. Webhook da Meta — `POST /webhook` (`src/webhook.js`)

Origem: WhatsApp Cloud API. Assinado com `X-Hub-Signature-256` (HMAC do App Secret).
Roteado para a conta (tenant) pelo `metadata.phone_number_id`.

### 1.1 `value.contacts[]` — identidade do cliente

| Campo recebido | Usado | Armazenado em | Compartilhado com |
|---|---|---|---|
| `wa_id` | ✅ chave primária | `contact.waId` | **todos os módulos** |
| `profile.name` | ✅ preenche nome | `contact.name` (só se vazio/igual ao telefone) | Contatos, Funil, Campanhas, Flows |

### 1.2 `value.messages[]` — mensagem recebida

| Campo recebido | Usado | Armazenado em | Compartilhado com |
|---|---|---|---|
| `id` (`wamid...`) | ✅ dedupe | `message.id` | Inbox |
| `from` | ✅ | `message.waId` | todos |
| `timestamp` (s) | ✅ ×1000 | `message.timestamp`, `contact.lastMessageAt`, **`contact.lastInboundAt`** | **Janela 24h**, Inbox, Dashboard |
| `type` | ✅ | `message.type` | Inbox |
| `text.body` | ✅ | `message.text` | Inbox, **Flows (gatilho)**, **Opt-out (palavras-chave)** |
| `image/video/audio/document/sticker.{id,mime_type,filename,caption}` | ✅ | `message.media` | Inbox (mídia) |
| `location.{latitude,longitude,name,address}` | ✅ | `message.location` | Inbox |
| `contacts[]` | parcial | `message.text` (nomes) | Inbox |
| `button.text` | ✅ | `message.text` | Flows |
| `interactive.button_reply.{id,title}` | ✅ | `message.text` + **`message.replyId`** | **Pesquisa de Satisfação**, Flows |
| `interactive.list_reply.{id,title}` | ✅ | idem | idem |
| `reaction.{emoji,message_id}` | ✅ | `message.reactedTo` | Inbox |
| `referral.*` (Click-to-WhatsApp) | ✅ **só na 1ª vez** | `contact.source` | **Origem do lead**, Dashboard/Mapa, Opt-out (coluna Origem) |

`referral` detalhado → `contact.source`:
`source_type`→`type` · `source_id`→`id` · `headline` · `body` · `source_url`→`sourceUrl` ·
`ctwa_clid`→`ctwaClid` · `media_type`→`media` · `+ts`

### 1.3 `value.statuses[]` — status de saída

| Campo | Usado | Armazenado | Compartilhado |
|---|---|---|---|
| `id`, `status` (sent/delivered/read/failed) | ✅ (só avança) | `message.status` | Inbox (✓✓), Campanhas, Dashboard |
| `errors[]` | ✅ | `message.error` | Inbox, Campanhas |

### 1.4 Efeitos colaterais do inbound (ordem de execução)

1. `store.upsertContact` → **cadastro automático** (cria ou atualiza)
2. captura de `referral` (origem do lead)
3. `store.addMessage` (dedupe por `id`)
4. `session.touchInbound` → renova **janela de 24h**; reabre atendimento finalizado
5. **`consent`** → opt-in implícito + detecção de **palavra-chave de opt-out**
6. `survey.handleReply` → resposta da pesquisa de satisfação
7. `flows.onInbound` → gatilhos do Flow Builder

---

## 2. Webhook de entrada (aba Webhooks) — `POST /hook/:token` (`src/webhooks.js`)

Origem: sistemas externos (checkout, formulário, outro CRM). Payload **livre**.

- O JSON é **achatado** em caminhos com ponto (`data.member.phone`) — `flatten()`.
- O usuário define o **Mapeamento de Campos** (aba Webhooks):

| Campo do contato | Origem | Armazenado em | Obrigatório |
|---|---|---|---|
| Telefone | `mapping.phone` | `contact.waId` | ✅ **sem ele não gera contato** |
| Nome | `mapping.name` | `contact.name` | — |
| E-mail | `mapping.email` | `contact.email` | — |
| Personalizadas | `mapping.custom[{key,path}]` | `contact.vars[key]` | — |

Compartilhado com: Contatos, Funil, **Flows** (`{{nome}}`, `{{cpf}}`…), Campanhas
(variáveis do disparo), Opt-out (coluna Origem = webhook).

---

## 3. Gatilho de Flow — `POST /flow-hook/:token` (`server.js`)

Legado/automação direta. Guarda os valores recebidos em `flow.lastVars` (só escalares),
usados como `{webhook.<flowId>.<campo>}` nas campanhas e `{{var}}` nos flows.
**Não cria contato** (só dispara o flow para o `to` informado).

---

## 4. Woovi — `POST /woovi-webhook` (`src/woovi.js`)

Pagamentos (Pix/Pix Automático) do **SaaS**, não do cliente final.
O payload **nunca é confiado**: a cobrança é reconsultada na API antes de aplicar.
Casa por `correlationID` → ativa assinatura / credita carteira / paga comissão de afiliado.
Não toca em contatos.

---

## 5. Clique em link rastreável — `GET /l/:slug` (`server.js`)

Não é webhook de entrada, mas é fonte de dados: registra `{ts, ua, ref}` em `link.clicks`
e dispara pixels + CAPI. Alimenta Dashboard (origem de tráfego) e sugestões de funil.

---

## 6. Cadastro Automático — regras (`store.upsertContact`)

Aplicado a **qualquer** webhook que traga um telefone:

1. Normaliza o telefone (só dígitos) → `waId`.
2. **Existe?** → atualiza **apenas o que estiver vazio** ou for mais recente
   (nome só sobrescreve se estava vazio ou igual ao telefone; e-mail/cidade/vars
   preenchem lacunas). Nunca duplica.
3. **Não existe?** → cria com a **etapa padrão do funil** configurada em
   *Opt-in & Opt-out → Cadastro automático* (fallback: 1ª etapa).
4. Já está no funil → **não recria** nem reposiciona a etapa.

## 7. Campos do contato compartilhados entre módulos

| Campo | Escrito por | Lido por |
|---|---|---|
| `waId` | todos os webhooks | todos |
| `name`, `email`, `city`, `vars` | Meta, /hook (mapeamento), edição manual | Contatos, Campanhas, Flows, Opt-out |
| `stage` | upsert (padrão), Funil, Flow (`movestage`) | Funil, Campanhas (público), Opt-out |
| `tags` | Flow (`addtag`), edição, /hook | Campanhas (público), Opt-out |
| `source` | Meta (`referral`), /hook | Dashboard, Opt-out (Origem) |
| `lastInboundAt` / `windowExpiresAt` | Meta (inbound) | **Janela 24h**, guard de envio, Dashboard |
| `attendance` | Atendimento (finalizar/reabrir/auto) | Inbox, Dashboard, Opt-out (último atendente) |
| `surveys` | Pesquisa de Satisfação | Métricas |
| **`consent`** | **Opt-in/Opt-out** (inbound, palavra-chave, Flow, manual) | **guard de envio**, Campanhas, Dashboard |
| `lastAgent` | envio manual (usuário logado) | Opt-out (último atendente) |
| `lastCampaignId` | disparo de campanha | Opt-out (última campanha) |
