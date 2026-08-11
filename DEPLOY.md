# Deploy do Koonfy

## Se o app "esquece" tudo a cada restart

Sintoma: você cadastra, reinicia (ou faz um deploy) e volta tudo do zero —
inclusive a senha do admin, que retorna ao padrão.

Causa: o banco está gravando em `data/db.json`, dentro do contêiner, e o host
recria esse disco a cada deploy e a cada reinício. Vale para **DigitalOcean App
Platform** (onde koonfy.com está hoje), Railway, Render, Heroku e Cloud Run: em
nenhum deles existe disco que sobreviva ao restart, a não ser volume dedicado.
Enquanto o contêiner está de pé tudo funciona, o que faz o problema parecer
intermitente.

Solução: guardar o estado fora do disco. O app já fala MySQL — basta ligar:

```
DB_DRIVER=mysql
DATABASE_URL=mysql://usuario:senha@host:3306/koonfy
```

Na DigitalOcean, crie um **Managed Database → MySQL** e cole a connection
string em Settings → App-Level Environment Variables. Para levar o que existe
hoje, rode uma vez, com as duas variáveis definidas:

```
node scripts/migrar-mysql.js
```

Ele migra, relê do MySQL e compara campo a campo, saindo com erro se algo
divergir. Detalhes em `docs/mysql.md` e `docs/migracao-mysql.md`.

Com o motor `file` num host desses, o app avisa no log ao subir e mostra um
alerta no topo do painel Admin SaaS.

## Aviso importante sobre a Vercel

O Elite Chat é um servidor Node **com estado**: grava tudo em `data/db.json`
(191 pontos de gravação), mantém conexões SSE abertas para o tempo real do
painel e roda 5 jobs em segundo plano (renovação de assinaturas no cartão,
liberação de recebíveis, lembretes, atendimento e limpeza).

A Vercel executa funções **serverless**: o disco é descartado a cada
requisição, conexões longas são cortadas e nenhum job em segundo plano roda.
Na prática, hospedar este app na Vercel significa:

- **Todos os dados se perdem** entre uma requisição e outra (contas, contatos,
  pagamentos, conversas) — o app "reseta" o tempo todo.
- O chat em tempo real (SSE) não funciona.
- Renovações de cartão e liberação de carteira nunca acontecem.
- Webhooks da Woovi/Pagar.me/Meta gravam num disco que é jogado fora.

O `vercel.json` deste repositório existe para a importação funcionar, mas a
Vercel **não serve para rodar este app em produção** no estado atual.

## Onde hospedar (recomendado)

Qualquer host de Node persistente. O app sobe com um comando, sem build:

| Host | Como |
|---|---|
| Railway | Importar o repo do GitHub → deploy automático (`npm start`) |
| Render | New Web Service → repo → `npm start` |
| Fly.io | `fly launch` (com volume para `data/`) |
| VPS | `git clone` + `npm install` + `npm start` (porta 3900) |

Requisitos: Node >= 18, HTTPS público (obrigatório para os webhooks da Meta,
Woovi e adquirentes, e para o OAuth do Meta Ads).

## Checklist pós-deploy (painel Admin SaaS → Plataforma)

1. Webhook do WhatsApp: `https://SEU-DOMINIO/webhook` + Verify Token
2. OAuth do Meta Ads: `https://SEU-DOMINIO/auth/meta-ads/callback` nas URIs
   de redirecionamento do app da Meta
3. Webhook da Woovi: `https://SEU-DOMINIO/woovi-webhook`
4. Webhook do cartão: `https://SEU-DOMINIO/card-webhook`
5. Faça backup periódico de `data/db.json` (é o banco inteiro)

## Se quiser Vercel de verdade

Exigiria migrar `data/db.json` para um banco gerenciado (Postgres/Turso),
trocar SSE por polling ou serviço de realtime e mover os jobs para Vercel
Cron. É um projeto de migração, não uma configuração.
