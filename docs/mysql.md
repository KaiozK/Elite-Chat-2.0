# Banco de dados: arquivo ou MySQL

O Koonfy roda com o banco inteiro em memória e grava a cada mudança. O que muda
entre os dois motores é **onde** essa memória é gravada.

O padrão continua sendo o arquivo. Quem não configurar nada não percebe
diferença nenhuma.

---

## Como ligar o MySQL

```bash
# 1. crie o banco (o Koonfy cria a tabela sozinho na primeira partida)
mysql -u root -p -e "CREATE DATABASE koonfy CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"

# 2. leve os dados que já existem
node scripts/migrar-mysql.js "mysql://usuario:senha@localhost:3306/koonfy"

# 3. suba apontando para lá
DB_DRIVER=mysql DATABASE_URL="mysql://usuario:senha@localhost:3306/koonfy" npm start
```

A partida imprime qual motor está em uso:

```
  Banco:               mysql
```

**O `data/db.json` não é apagado nem movido.** Guarde-o até a virada estar
confirmada: para voltar, basta subir sem as duas variáveis.

---

## O que o script de migração faz

1. Lê o `data/db.json` (ou o backup mais recente, se o principal estiver
   ilegível).
2. Apaga o que houver no MySQL e grava tudo.
3. **Lê de volta e compara campo a campo.**

O passo 3 é o que importa. Sem conferir, a migração "termina com sucesso" e o
erro aparece dias depois, com o cliente dentro. Havendo qualquer diferença, o
script sai com erro e diz em qual conta e em qual campo.

---

## Como os dados ficam guardados

Uma tabela, `koonfy_state`, com uma linha por **pedaço**:

| chunk | o que é |
|---|---|
| `platform` | configuração da plataforma |
| `plans`, `revenue`, `withdrawals` | listas do SaaS |
| `sessions`, `loginChallenges`, `webhookLog` | estado efêmero |
| `__accounts_order` | a ordem das contas |
| `account:<id>` | **uma linha por conta**, com tudo dela |

O fatiamento é o ponto central. Com o arquivo único, escrever uma mensagem
reescrevia o banco inteiro: custo proporcional ao TAMANHO. Aqui, escrever uma
mensagem grava **só a linha daquela conta** — as outras nem são tocadas. O custo
passa a ser proporcional ao QUE MUDOU.

A comparação é feita sobre o JSON serializado de cada pedaço. Serializar já
acontecia antes, para escrever o arquivo, então o custo de CPU é o mesmo; o que
desaparece é a escrita, que é a parte cara quando o banco está na rede.

Isto **não é normalização**. É o mesmo modelo de hoje, guardado onde dá para
replicar, fazer backup com ponto no tempo e, mais adiante, quebrar em tabelas de
verdade sem parar o produto. Normalizar agora seria reescrever o produto junto
com a migração, e aí não se saberia qual das duas coisas quebrou.

---

## O que também mudou no motor de arquivo

Independente do MySQL, e vale mesmo para quem não migrar:

- **Gravação atômica.** Antes o `flush()` escrevia direto no `data/db.json`. Uma
  queda no meio da escrita deixava o arquivo pela metade e o banco não abria
  mais. Agora escreve em `.tmp`, dá `fsync` e renomeia: ou fica o arquivo antigo
  inteiro, ou o novo inteiro.
- **Cinco cópias** (`db.json.1` … `db.json.5`), rodadas a cada 20 gravações.
- **Recuperação automática:** se o principal não parseia, a carga tenta as
  cópias, da mais recente para a mais antiga, e avisa no log.

---

## Desligar direito

O servidor passa a tratar `SIGINT` e `SIGTERM`: grava o que está pendente e
fecha a conexão antes de sair. Sem isso, um deploy no meio de uma escrita
deixaria a última mudança só na memória.

---

## Limite conhecido

O modelo continua sendo **um processo só**: a verdade está na memória, e duas
instâncias apontando para o mesmo MySQL sobrescreveriam uma à outra. Rodar em
cluster exige o passo seguinte — leitura sob demanda em vez de tudo em memória,
que é o que a camada `src/storage/` agora torna possível fazer sem mexer nos 262
pontos de escrita espalhados pelo código.

Enquanto for um processo, o MySQL entrega o que o arquivo não entregava: backup
com ponto no tempo, réplica, escrita proporcional à mudança e dados fora do
disco do container.
