# Migração para MySQL

Plano para trocar o arquivo JSON por MySQL sem parar a operação e sem reescrever
o produto inteiro de uma vez.

---

## 1. Como o backend funciona hoje

Levantado lendo o código, não de memória:

| | |
|---|---|
| Persistência | um arquivo, `data/db.json` (185 KB hoje) |
| Escrita | `flush()` faz `fs.writeFileSync` do banco **inteiro**, com `JSON.stringify(db, null, 2)` |
| Agendamento | `save()` só marca um `setTimeout(flush, 250)` — várias mutações viram uma escrita |
| Leitura | o banco fica **todo em memória**; `get()` devolve o objeto vivo |
| Chamadas de escrita | **262 `db.save()`** espalhados por 24 módulos (119 só em `src/api.js`) |
| Modelo de dados | tudo aninhado na conta: `acc.contacts`, `acc.messages`, `acc.flows`… |
| Consultas | `Array.filter` em JavaScript; não existe índice |

O padrão de escrita, em toda parte, é este:

```js
acc.contacts.push(c);   // muta o objeto em memória
db.save();              // agenda a regravação do arquivo todo
```

Não há camada de repositório, nem transação, nem fronteira de entidade. **É isso
que define o custo da migração**: não existe um ponto único para trocar.

### O que já dá problema, e o que ainda não

Honestamente: para o tamanho atual, **o modelo funciona**. Os limites reais são:

1. **Um processo só.** A verdade está na memória, então não dá para rodar duas
   instâncias nem escalar horizontalmente. Reiniciar é a única forma de aplicar
   mudança de código.
2. **Escrita O(tamanho-do-banco).** Regravar tudo a cada mudança custa nada com
   185 KB e é inviável com 100 MB. Com o teto de 20.000 mensagens por conta
   (`store.js:88`), ~50 contas ativas já colocam o arquivo na casa das dezenas de
   megabytes, e aí cada `db.save()` passa a bloquear o event loop.
3. **Janela de perda de 250 ms.** `writeFileSync` sem `fsync` e com debounce: uma
   queda entre a mutação e o flush perde o que estava na janela.
4. **Escrita não atômica.** `writeFileSync` direto no arquivo final. Uma queda no
   meio da escrita deixa um JSON truncado, e o banco não abre.

O ponto 4 é o mais sério e **não depende de escala**: pode acontecer hoje.

---

## 2. Princípio do plano

> Trocar o motor sem reescrever os 262 pontos de escrita, e com como voltar atrás
> em qualquer etapa.

Isso é possível porque o código nunca lê o disco: ele lê o objeto em memória. Se
o objeto em memória continuar existindo e for **materializado do MySQL** na
partida e **espelhado no MySQL** a cada mudança, o resto do produto não percebe a
troca.

Cada etapa abaixo é reversível sozinha, e cada uma entrega valor mesmo que a
seguinte demore.

---

## Etapa 0 — Fechar o buraco que já existe (1 dia)

Independente de MySQL, e vale ser feito **antes de tudo**.

- `flush()` passa a escrever em `db.json.tmp` e depois `fs.renameSync` para o
  lugar. Rename é atômico no mesmo volume: ou o arquivo antigo, ou o novo
  inteiro, nunca um pela metade.
- Guardar as últimas N cópias (`db.json.1` … `db.json.5`) a cada flush.
- Na carga, se o JSON não parseia, cair para a cópia mais recente que parseia e
  registrar no log.

**Risco:** nenhum. **Reversível:** trivialmente.

---

## Etapa 1 — Camada de repositório (3 a 5 dias)

Criar `src/store/` com uma interface estreita, e **nenhuma** mudança de
comportamento:

```js
repo.accounts.get(id)          repo.accounts.save(acc)
repo.contacts.byAccount(accId)  repo.contacts.upsert(accId, contato)
repo.messages.page(accId, {…})  repo.messages.append(accId, msg)
```

Implementação inicial: **a de hoje**, mexendo no mesmo objeto em memória. Ou
seja, esta etapa não muda nada em produção — ela só cria o lugar onde a troca vai
acontecer.

O trabalho real aqui é **classificar as 262 chamadas de `db.save()`** por
entidade tocada. É trabalhoso, mas mecânico e verificável: no fim, `db.save()`
não é mais chamado direto fora de `src/store/`.

**Risco:** baixo, e detectável pelos testes que já existem (10 suítes).
**Reversível:** é refatoração; `git revert` resolve.

---

## Etapa 2 — Esquema e carga inicial (2 a 3 dias)

Modelagem que espelha o que já existe, sem inventar normalização a mais:

```sql
CREATE TABLE accounts (
  id            VARCHAR(40) PRIMARY KEY,
  email         VARCHAR(190) NOT NULL UNIQUE,
  name          VARCHAR(120) NOT NULL,
  pass_hash     VARCHAR(255) NOT NULL,
  is_admin      TINYINT(1) NOT NULL DEFAULT 0,
  unlimited     TINYINT(1) NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,
  -- o que é configuração e nunca é consultado por campo continua JSON:
  billing       JSON NOT NULL,
  wallet        JSON NOT NULL,
  profile       JSON NOT NULL,
  security      JSON NOT NULL,
  consent       JSON NOT NULL,
  service       JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE contacts (
  account_id    VARCHAR(40) NOT NULL,
  wa_id         VARCHAR(20) NOT NULL,
  channel_id    VARCHAR(40) NOT NULL,
  name          VARCHAR(120),
  stage         VARCHAR(60),
  last_message_at BIGINT,
  data          JSON NOT NULL,          -- tags, vars, consent, attendance…
  PRIMARY KEY (account_id, wa_id, channel_id),
  KEY idx_stage (account_id, stage),
  KEY idx_recentes (account_id, last_message_at DESC),
  CONSTRAINT fk_contacts_acc FOREIGN KEY (account_id)
    REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE messages (
  id            VARCHAR(80) NOT NULL,
  account_id    VARCHAR(40) NOT NULL,
  wa_id         VARCHAR(20) NOT NULL,
  channel_id    VARCHAR(40) NOT NULL,
  direction     ENUM('in','out') NOT NULL,
  timestamp     BIGINT NOT NULL,
  status        VARCHAR(20),
  data          JSON NOT NULL,          -- corpo, mídia, template, botões
  PRIMARY KEY (account_id, id),
  KEY idx_conversa (account_id, wa_id, timestamp DESC)
) ENGINE=InnoDB;
```

Três decisões que valem explicação:

- **`utf8mb4` obrigatório.** Mensagem de WhatsApp tem emoji. `utf8` do MySQL é de
  3 bytes e trunca emoji com erro.
- **Colunas para o que é consultado, JSON para o resto.** Só vira coluna o que
  aparece em `WHERE`, `ORDER BY` ou índice. O resto fica em `JSON` e o código
  continua lendo do mesmo jeito. Normalizar tudo agora seria reescrever o produto.
- **Chave composta com `account_id` na frente.** Isola o inquilino no índice e
  torna difícil escrever uma consulta que atravesse contas por acidente.

A carga inicial é um script que lê o `db.json` e escreve tudo, dentro de uma
transação. Rodável quantas vezes for preciso contra um banco vazio.

**Verificação obrigatória antes de seguir:** um script que compara, campo a
campo, o JSON de origem com o que voltou do MySQL. Contagem por coleção e
`JSON.stringify` ordenado de cada entidade. Diferença nenhuma, ou não avança.

---

## Etapa 3 — Escrita dupla, leitura ainda do JSON (1 semana em produção)

O repositório passa a escrever **nos dois**: memória/JSON como hoje, e MySQL logo
em seguida. As leituras continuam vindo da memória.

- Se o MySQL falhar, **registra e segue**. Nesta etapa ele ainda não é a verdade,
  e derrubar a operação por causa dele seria trocar um risco por outro.
- Um job por hora compara os dois e loga divergência.

É aqui que aparecem os erros de mapeamento que nenhuma revisão de código pega:
campo que alguém muta em dois lugares, coleção que cresce sem passar pelo repo.
**Uma semana rodando sem divergência** é o critério para avançar — não é
paciência, é o tempo de passar por um ciclo de cobrança, uma renovação e um fim
de semana.

**Reversível:** desligar a escrita no MySQL é uma variável de ambiente.

---

## Etapa 4 — Virar a leitura (1 dia, com janela de manutenção)

Inverter: MySQL vira a fonte da verdade, o JSON passa a ser o espelho.

Na partida, o servidor materializa em memória o que é pequeno e quente
(contas, planos, canais, configuração) e passa a buscar sob demanda o que é
grande (mensagens, contatos, logs). É a mudança que exige mais cuidado, porque
código que hoje faz `acc.messages.filter(...)` precisa passar a chamar
`repo.messages.page(...)` — e isso já está isolado desde a Etapa 1.

**Reversão:** manter a escrita dupla ligada por mais uma semana. Voltar é apontar
a leitura de novo para o JSON.

---

## Etapa 5 — Colher o que a troca permite (depois, sem pressa)

Só depois de estável:

- Mais de um processo (`cluster`), com o SSE resolvido por Redis pub/sub ou por
  sticky session.
- Paginação de verdade na caixa de entrada, em vez do teto de 20.000 mensagens.
- Backup e restauração por `mysqldump`, com ponto no tempo.
- Índice de busca por texto nas conversas.

---

## O que NÃO fazer

- **Não migrar direto para leitura no MySQL.** Sem a etapa de escrita dupla, o
  primeiro erro de mapeamento aparece com o cliente na linha.
- **Não normalizar tudo de uma vez.** `wallet`, `billing` e `consent` são lidos
  como objeto inteiro em dezenas de lugares. Quebrá-los em tabelas agora é
  reescrever o produto junto com a migração, e aí não se sabe qual das duas
  coisas quebrou.
- **Não usar ORM.** O código já fala em objetos simples. Um ORM adiciona uma
  segunda tradução e esconde a consulta que se quer enxergar.
- **Não migrar `sessions` e `loginChallenges` na primeira leva.** São efêmeros:
  vão para Redis ou continuam em memória. Colocá-los no MySQL cria escrita a cada
  requisição sem ganho nenhum.

---

## Custo e ordem sugerida

| Etapa | Esforço | Risco | Entrega sozinha? |
|---|---|---|---|
| 0. Escrita atômica + backups | 1 dia | nenhum | **sim** |
| 1. Camada de repositório | 3 a 5 dias | baixo | não |
| 2. Esquema + carga + conferência | 2 a 3 dias | baixo | não |
| 3. Escrita dupla | 1 semana rodando | médio | não |
| 4. Virar a leitura | 1 dia + observação | **alto** | **sim** |
| 5. Cluster, paginação, backup | conforme | médio | sim |

**A Etapa 0 vale ser feita esta semana**, independentemente de a migração
acontecer: ela fecha um risco de corrupção que já existe hoje.

---

## Dependência nova

`mysql2` (driver oficial, com suporte a `promise` e prepared statements). É a
primeira dependência de produção além do `express` — vale ter isso em conta, já
que o resto do projeto fala os protocolos direto (Web Push e SMTP escritos à mão).
Aqui a dependência se paga: implementar o protocolo do MySQL à mão não é a mesma
categoria de trabalho.
