# SMS pela Integra X

O EliteChat revende disparo de SMS: a **plataforma** contrata a Integra X, liga a
funcionalidade no Admin SaaS e escolhe em quais planos ela aparece. O crédito é
consumido da conta da plataforma; o cliente é limitado pelo teto de SMS do plano
que assinou.

## Como ligar

1. **Admin SaaS → Integrações → Disparos de SMS**
   - ligue *Oferecer SMS aos clientes*
   - cole o **token da API** da Integra X e informe o **remetente** (sender id)
   - clique em **Testar conexão** — ele consulta o saldo e confirma que está tudo certo
2. **Admin SaaS → Planos**: marque *Disparos de SMS* nos planos que devem incluir
   o módulo e defina o teto em *SMS por ciclo*.
3. **Status de entrega**: informe `https://SEU_DOMINIO/sms-webhook` no painel da
   Integra X e no campo *URL de callback*.

Sem o passo 1 nenhum cliente vê a tela. Sem o passo 2, só os planos marcados veem.

## O que o cliente ganha

- **Tela SMS** no menu: envio avulso, disparo em massa filtrado por etapa do
  funil / etiqueta / conexão, e histórico com status de entrega.
- **Etapa "Enviar SMS"** no Flow Builder, com as mesmas variáveis (`{{nome}}` etc.).
- Contatos em **opt-out são bloqueados** no backend, igual ao WhatsApp.
- O consumo é contado por **segmento**: acima do limite de caracteres a operadora
  cobra mais de um SMS, e o EliteChat conta do mesmo jeito.

## Ajustar o contrato da API

A documentação da Integra X fica atrás do login do painel
(`https://www.integrax.app/dashboard/external/docs`), então **todo o contrato HTTP
está isolado num único bloco** no topo de `src/sms.js`:

```js
const CONTRATO = {
  base:  'https://api.integrax.app',
  auth:  (cfg, headers) => { headers['Authorization'] = `Bearer ${cfg.token}`; ... },
  rotas: { enviar: '/v1/sms/send', saldo: '/v1/account/balance', status: id => ... },
  corpoEnvio: ({ to, text, from, referencia, callbackUrl }) => ({ ... }),
  lerEnvio:   d => ({ id, status, erro }),
  lerSaldo:   d => ({ creditos, moeda }),
  lerStatus:  d => '...',
  lerWebhook: b => ({ id, status })
};
```

Nada fora desse bloco conhece a Integra X. Para adaptar ao que a documentação
disser, mexa só nele.

O botão **Testar conexão** aponta qual das quatro partes está errada:

| Etapa reportada | O que corrigir |
|---|---|
| `BASE` | o host não respondeu — confira `base` (ou o campo *URL da API*) |
| `AUTH` | o token foi recusado — confira o valor e o formato em `auth` |
| `ROTAS` | o caminho não existe nessa conta — confira `rotas` |
| `CAMPOS` | conectou, mas a resposta veio em outro formato — confira `lerSaldo`/`lerEnvio` |

Os leitores (`lerEnvio`, `lerSaldo`, `lerStatus`, `lerWebhook`) já aceitam as
grafias mais comuns (`id` / `messageId` / `message_id`, `balance` / `credits`,
com ou sem envelope `data`), e `normalizarStatus()` traduz o vocabulário do
provedor para `queued | sent | delivered | undelivered | failed`. Na prática, é
provável que só `base` e `rotas` precisem de ajuste.

## Onde fica cada coisa

| Arquivo | Papel |
|---|---|
| `src/sms.js` | contrato da API, envio, opt-out, limites, histórico, webhook |
| `src/api.js` | rotas `/sms*` do cliente e `/admin/sms*` do administrador |
| `src/flows.js` | etapa `sms` do Flow Builder |
| `server.js` | `POST /sms-webhook` (status de entrega) |
| `public/app/app.js` | tela do cliente, aba do admin e o nó no editor |
