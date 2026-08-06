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
- O opt-in/opt-out do EliteChat é do **WhatsApp** e não vale para SMS: as
  palavras-chave de cancelamento chegam por mensagem recebida, que é um caminho
  que o SMS não tem. Quem dispara responde pela lista que usa.
- O consumo é contado por **segmento**: acima do limite de caracteres a operadora
  cobra mais de um SMS, e o EliteChat conta do mesmo jeito.

## O contrato da API

Baseado na documentação oficial da Integra X (painel → `/dashboard/external`).
Está todo num único bloco no topo de `src/sms.js`:

| | |
|---|---|
| Host | `https://sms.aresfun.com` |
| Envio | `POST /v1/integration/{TOKEN}/send-sms` |
| Saldo | `GET /v1/integration/{TOKEN}/consult/credits` |
| Corpo do envio | `{ "to": ["5511999999999"], "from": "29094", "message": "..." }` |
| Sucesso | `error: 0` / `success` |
| Erro | HTTP 4xx com `message` |

Três detalhes da API que moldaram a implementação:

**1. O token viaja no caminho, não em header.** A URL inteira é secreta. Por
isso ela nunca aparece em log, em mensagem de erro nem na resposta do admin —
`mascarar()` troca o token por `***`, e a tela mostra o caminho com `{TOKEN}`.
Efeito colateral: um token errado responde **404** ("rota não existe"), não 401.
O teste de conexão sabe disso e aponta `AUTH` nesse caso.

**2. `to` é uma lista.** O disparo em massa aproveita isso e vai em **lotes de
100 números por chamada**, em vez de uma requisição por destinatário. Cada
número continua com a própria linha no histórico.

**3. Não existe consulta de status por mensagem no SMS.** Só a chamada de voz
tem campo `dlr`. Então o histórico marca *enviado* quando o provedor aceita, e
só vira *entregue* se um webhook chegar em `/sms-webhook`. Quando o corpo do
webhook traz o número, o status vai para aquele destinatário; sem número, vale
para o lote inteiro daquela conta.

Se algo mudar do lado da Integra X, o ajuste é no bloco `CONTRATO` e em mais
lugar nenhum. O botão **Testar conexão** aponta onde:

| Etapa | O que corrigir |
|---|---|
| `BASE` | o host não respondeu — confira a *URL da API* |
| `AUTH` | token recusado (404 ou 401) — confira se copiou o valor inteiro |
| `ROTAS` | o endereço existe mas a conta não tem acesso — confira o plano na Integra X |
| `CAMPOS` | conectou, mas a resposta veio em outro formato — confira `lerSaldo`/`lerEnvio` |

## O que a API oferece e ainda não usamos

A mesma integração expõe, com o mesmo token: **OTP** (`send-otp` / `verify-otp`),
**RCS** (texto, card e carrossel), **chamada de voz** (TTS ou MP3), **consulta de
CPF e de telefone** e **números virtuais**. Nada disso está implementado — só o
SMS. É só pedir.

## Onde fica cada coisa

| Arquivo | Papel |
|---|---|
| `src/sms.js` | contrato da API, envio, limites, histórico, webhook |
| `src/api.js` | rotas `/sms*` do cliente e `/admin/sms*` do administrador |
| `src/flows.js` | etapa `sms` do Flow Builder |
| `server.js` | `POST /sms-webhook` (status de entrega) |
| `public/app/app.js` | tela do cliente, aba do admin e o nó no editor |
