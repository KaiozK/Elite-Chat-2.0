# Deploy do Koonfy

## Subdomínios por papel

Um servidor só atende os quatro endereços. O que muda é o papel de cada um:

| endereço | entrega |
|---|---|
| `koonfy.com` | a landing |
| `app.koonfy.com` | redireciona para `/app/`, o painel |
| `api.koonfy.com` | só a API (`/` responde 404) |
| `pay.koonfy.com` | checkout: `pay.koonfy.com/<id-da-cobrança>` |

Isto **não separa** backend de frontend — é organização de endereço. A vantagem
real é mandar o cliente para `pay.` sem expor o domínio do painel, e ter um
`api.` estável caso um dia o front saia daqui.

### Na DigitalOcean

*Apps → Settings → Domains → Add Domain*, um por vez: `app.`, `api.` e `pay.`,
todos apontando para o **mesmo app**. Se o DNS estiver no Cloudflare, crie um
CNAME de cada subdomínio para o mesmo destino do domínio raiz.

### Variáveis

Nenhuma é obrigatória: sem configurar nada, o código reconhece os prefixos
`app.`, `api.` e `pay.`. Use quando quiser controle explícito:

| variável | para quê |
|---|---|
| `PUBLIC_URL` | o endereço público (`https://koonfy.com`). Usado para escrever links que vão para fora. **Recomendada.** |
| `PAY_URL` ou `PAY_HOST` | liga o domínio de checkout. Com ele, as cobranças passam a sair como `pay.koonfy.com/<id>`. |
| `PANEL_HOST` | fixa o host do painel, se `app.` não servir. |
| `API_HOST` | fixa o host da API. |

### Detalhes que valem saber

**O link de pagamento nunca sai por um host interno.** O sistema aprende o
endereço público com as requisições, mas ignora as que chegam por `app.` e
`api.` — senão bastava abrir o painel para toda cobrança passar a apontar para
o subdomínio administrativo. Com `PUBLIC_URL` definida, não depende de
heurística.

**O caminho `/pay/<id>` continua valendo em todos os hosts.** As cobranças já
emitidas gravaram o link nesse formato e precisam continuar abrindo.

**O painel redireciona em vez de ser servido na raiz** porque o Service Worker
do PWA tem escopo `/app/`: fora dele, o app instalado perderia o offline.

**CORS.** Com a API em host próprio, o painel passa a fazer chamada
cross-origin. A liberação é automática e fechada nos endereços do próprio
produto (vitrine, painel e checkout); qualquer outra origem é recusada.


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
