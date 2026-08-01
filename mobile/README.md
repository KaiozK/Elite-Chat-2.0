# EliteChat — apps para App Store e Play Store

Os aplicativos iOS e Android são o **mesmo painel** de `public/app/`, empacotado
com [Capacitor](https://capacitorjs.com). Não existe uma segunda base de código:
o que você corrigir no painel web aparece no app no próximo `npm run sync`.

A diferença é onde o código roda. No navegador o Express serve o HTML e a API no
mesmo endereço, então `/api/...` resolve sozinho. No app, o HTML vem de dentro do
pacote instalado e a API mora em outro host — por isso todo o tráfego passa por
uma base configurável (`public/app/config.js`) e o backend libera CORS para as
origens nativas.

---

## Pré-requisitos

| Para | Você precisa de |
|---|---|
| Android | JDK 21, [Android Studio](https://developer.android.com/studio), SDK 35+ |
| iOS | **macOS**, Xcode 16+, CocoaPods, conta Apple Developer (US$ 99/ano) |
| Ambos | Node 20+ e o backend publicado em HTTPS |

> iOS só compila em macOS — é uma restrição da Apple, não do projeto.
> O Android compila em Linux, macOS ou Windows.

---

## 1. Publique o backend primeiro

O app não funciona apontando para `localhost`: o aparelho do usuário precisa
alcançar a API pela internet, em **HTTPS** (as duas lojas recusam texto puro).

Publique o servidor (veja `DEPLOY.md` na raiz) e anote a URL — por exemplo
`https://app.seudominio.com`. É ela que vai no passo seguinte.

---

## 2. Instale e gere o conteúdo web

```bash
cd mobile
npm install

# A URL do backend é obrigatória — é o que liga o app à sua API.
ELITECHAT_API_URL=https://app.seudominio.com npm run sync
```

`npm run sync` faz duas coisas: monta `mobile/www/` a partir de `public/` e copia
o resultado para dentro dos projetos nativos.

Para não repetir a variável a cada comando, exporte-a no seu shell:

```bash
export ELITECHAT_API_URL=https://app.seudominio.com
```

---

## 3. Ícone e splash screen

Coloque em `mobile/assets/`:

- `icon.png` — 1024×1024, sem cantos arredondados e **sem transparência**
  (a Apple rejeita ícone com canal alfa)
- `splash.png` — 2732×2732, com o logo centralizado numa área segura de ~1200 px

Depois:

```bash
npx capacitor-assets generate
```

Isso gera todos os tamanhos exigidos pelas duas lojas. O logo atual
(`public/assets/elitechat-logo.png`, 1418×1418) serve como base para o ícone.

---

## 4. Notificações push

O painel no navegador usa Web Push. Nos apps, cada plataforma tem seu canal, e o
backend (`src/pushnative.js`) fala com os dois.

### Android — Firebase Cloud Messaging

1. Crie um projeto no [Firebase Console](https://console.firebase.google.com).
2. Adicione um app Android com o pacote `com.elitechat.app`.
3. Baixe `google-services.json` e salve em `mobile/android/app/`.
4. No projeto Firebase, gere uma **service account**
   (Configurações → Contas de serviço → Gerar nova chave privada).
5. No servidor, configure:

```bash
FCM_SERVICE_ACCOUNT='<conteúdo do JSON da service account>'
# ou
FCM_SERVICE_ACCOUNT_FILE=/caminho/service-account.json
```

### iOS — APNs

Não precisa de Firebase. O backend fala direto com a Apple.

1. No [Apple Developer](https://developer.apple.com/account/resources/authkeys/list),
   crie uma **APNs Auth Key** (`.p8`). Guarde bem: só dá para baixar uma vez.
2. No Xcode, em *Signing & Capabilities*, adicione **Push Notifications**.
3. No servidor:

```bash
APNS_KEY_FILE=/caminho/AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=XXXXXXXXXX          # 10 caracteres, do nome do arquivo
APNS_TEAM_ID=YYYYYYYYYY         # canto superior direito do portal Apple
APNS_BUNDLE_ID=com.elitechat.app
APNS_ENV=production             # use "sandbox" para builds de desenvolvimento
```

Cada plataforma é independente: se só uma estiver configurada, a outra
simplesmente não recebe push e nada mais quebra.

---

## 5. Android — gerar o AAB para a Play Store

Crie a chave de assinatura **uma vez** e guarde-a com cuidado: perder essa chave
significa não conseguir mais atualizar o app publicado.

```bash
keytool -genkey -v -keystore elitechat.keystore \
  -alias elitechat -keyalg RSA -keysize 2048 -validity 10000
```

Crie `mobile/android/key.properties` (já está no `.gitignore`):

```properties
storeFile=/caminho/absoluto/elitechat.keystore
storePassword=SUA_SENHA
keyAlias=elitechat
keyPassword=SUA_SENHA
```

Gere o bundle:

```bash
cd mobile/android
./gradlew bundleRelease
# saída: app/build/outputs/bundle/release/app-release.aab
```

Suba o `.aab` no [Play Console](https://play.google.com/console).

---

## 6. iOS — gerar o build para a App Store

```bash
cd mobile
npx cap open ios
```

No Xcode:

1. Selecione o target **App** → *Signing & Capabilities*.
2. Marque *Automatically manage signing* e escolha seu Team.
3. Confirme o Bundle Identifier `com.elitechat.app`.
4. Adicione a capability **Push Notifications**.
5. Ajuste a versão em *General → Version / Build*.
6. Menu *Product → Archive* → *Distribute App* → *App Store Connect*.

---

## 7. Checklist antes de submeter

Itens que costumam causar rejeição:

- [ ] `ELITECHAT_API_URL` aponta para HTTPS de produção, não localhost
- [ ] Política de privacidade acessível em `https://SEU_DOMINIO/privacidade`
      com os campos entre colchetes preenchidos (razão social, CNPJ, e-mail do DPO)
- [ ] Termos de uso em `https://SEU_DOMINIO/termos`, idem
- [ ] **Exclusão de conta funcionando** dentro do app
      (Configurações → Segurança → Excluir minha conta) — a Apple testa isso na
      revisão e rejeita se faltar (diretriz 5.1.1(v))
- [ ] Conta de teste com dados de exemplo criada para o revisor, informada em
      *App Review Information* (a Apple rejeita se não conseguir entrar)
- [ ] Ícone sem transparência e sem cantos arredondados
- [ ] Capturas de tela em todos os tamanhos exigidos
- [ ] Faixa etária e questionário de conteúdo preenchidos nas duas lojas
- [ ] Play Console: *Data safety* declarando os dados coletados
- [ ] App Store Connect: *App Privacy* declarando o mesmo

### Sobre venda de assinaturas dentro do app

Este é o ponto mais delicado da submissão. A Apple exige compra dentro do app
(In-App Purchase, com 15–30% de comissão) para vender acesso a **usuários
consumidores** — mas abre exceção para apps de negócio usados por empresas.

O EliteChat cobra assinatura por meios próprios (Pix/cartão). Dois caminhos:

1. **Ocultar a cobrança no app** — a tela de Assinatura não mostra preço nem
   botão de pagar; o usuário assina pelo site. É o caminho mais seguro contra
   rejeição, e é como a maioria das ferramentas B2B faz.
2. **Implementar In-App Purchase** no iOS, mantendo o pagamento próprio na web.

A tela de Assinatura hoje mostra os planos e cobra. **Avalie o caminho 1 antes de
submeter para a Apple** — a Play Store é mais tolerante com serviços B2B.

---

## Dia a dia

```bash
# Mudou algo no painel? Leve para os apps:
npm run sync

# Rodar num aparelho/emulador conectado:
npm run run:android
npm run run:ios
```

## Formato das notificações

O mesmo texto vale para o PWA no navegador, para o app das lojas e para o toast
dentro do painel — o corpo é montado num lugar só (`notifyPreview`, em
`src/webhook.js`) e viaja no evento SSE que alimenta os três.

**Mensagem recebida** — o título é sempre o nome do lead:

| Tipo | Descrição |
|---|---|
| Texto | `💬 {mensagem}` |
| Mensagem de voz | `🎤 Mensagem de voz` |
| Áudio (arquivo) | `🎤 Enviou um áudio` |
| Imagem | `📸 Enviou uma imagem` |
| Vídeo | `🎥 Enviou um vídeo` |
| Documento | `📄 Enviou um documento` |
| Figurinha | `💚 Enviou uma figurinha` |
| Localização | `📍 Enviou uma localização` |

> **Duração do áudio.** A Cloud API da Meta envia apenas
> `{ id, mime_type, sha256, voice }` no objeto `audio` — **não existe duração no
> webhook**. Obtê-la exigiria baixar o arquivo e ler o container OGG/Opus,
> atrasando justamente a notificação que precisa ser instantânea. O código já
> usa `durationSec` se o campo aparecer um dia; enquanto não aparece, o tempo é
> omitido em vez de exibirmos um valor inventado.

**Venda aprovada** — quando um indicado paga (assinatura nova ou renovação), o
afiliado recebe:

```
Venda Aprovada✅
Sua comissão: R$ 89,10
```

O toque abre a tela de Assinatura. Cada tipo tem som próprio e pode ser
desligado em **Configurações → Preferências**.

## Menu enxuto no celular

O app não repete o menu inteiro do painel. Num aparelho, 22 itens viram uma
lista onde ninguém acha nada — então o celular mostra só o que se usa fora do
escritório:

| No celular | Só no computador |
|---|---|
| Dashboard | Opt-in & Opt-out |
| Conversas | Flow Builder |
| Chat interno | Integrações |
| Agendamentos | Campanhas |
| Contatos | Modelos de mensagem |
| Funil de vendas | Elite Pay · Checkout Builder |
| Respostas rápidas | Links · Tracking · Pixels |
| Assinatura | Atendentes |
| Configurações (inclui Conexão & API) | Webhook & Logs · Admin SaaS |

Montar campanha, desenhar automação e criar checkout são trabalhos de tela
grande — não cabem bem no celular e ninguém os faz de pé no corredor.

**O corte vale para os apps das lojas e para o navegador em tela estreita**
(≤ 820px, o mesmo ponto em que a sidebar já vira gaveta). No app ele vale
sempre, mesmo num tablet em tela larga, porque ali o critério é ser aplicativo.
Girar o aparelho ou redimensionar a janela reajusta o menu na hora.

As telas ocultas **continuam existindo e funcionando**: somem da navegação, não
do produto. Um link direto, um `#/flows` guardado nos favoritos ou o toque numa
notificação continuam abrindo normalmente.

Para mudar a lista, edite `MOBILE_VIEWS` em `public/app/app.js` — é a única
fonte da regra, e o filtro se compõe com as permissões de atendente (quem não
pode ver um módulo continua sem vê-lo no celular).

### Barra de navegação no rodapé

No celular a gaveta lateral dá lugar a uma barra fixa embaixo, ao alcance do
polegar. Cabem quatro destinos — **Início, Conversas, Contatos, Agenda** — e um
botão **Mais** que abre o restante numa folha. Os ícones são clonados da própria
sidebar, então barra e menu nunca divergem e não há um segundo conjunto de
ícones para manter.

A barra respeita a `safe-area` do iPhone e o conteúdo ganha espaço embaixo para
não terminar atrás dela. O botão físico de voltar do Android fecha a folha antes
de navegar. Para trocar os quatro destinos, edite `TABBAR_VIEWS`.

### Saldo e depósito no cabeçalho

No celular a tela de Assinatura fica a dois toques, então o saldo da carteira
sobe para o cabeçalho, com um **+** em gradiente da marca que abre o pop-up de
depósito. O Pix aparece dentro da própria janela: fechar e procurar outra tela
no meio do pagamento é o caminho mais curto para o cliente desistir.

O saldo se atualiza sozinho pelo evento `wallet` do SSE — venda liberada,
comissão de afiliado, recarga confirmada ou saque. Atendente não vê o saldo: a
carteira é da empresa, não dele.

A faixa aceita no depósito e no saque é definida em **Admin SaaS**:

| Onde | O quê |
|---|---|
| Pagamentos → Depósito na carteira | mínimo e máximo por recarga |
| Afiliados → Limites de saque | mínimo e máximo por saque da comissão |

Máximo `0` (ou campo vazio) significa sem teto. O painel valida antes de enviar
só para dar resposta imediata — quem decide de verdade é o servidor.

## Como o app conversa com o backend

| Assunto | Onde está |
|---|---|
| Base da API e origem web | `public/app/config.js` |
| Deep links, push, botão voltar, teclado | `public/app/native.js` |
| CORS das origens nativas | `server.js` |
| Envio de push FCM/APNs | `src/pushnative.js` |
| Montagem do `www/` | `mobile/scripts/build-www.mjs` |

### OAuth dentro do app

Meta, Meta Ads e Nuvemshop autorizam por popup no navegador. Dentro do app não
existe popup com `opener`, então a autorização abre no navegador do sistema e o
callback do servidor redireciona para `elitechat://auth/...`. O `native.js`
recebe esse deep link e reemite o mesmo `postMessage` que o painel já escutava —
os fluxos existentes seguem valendo sem alteração.

Ao cadastrar as URLs de redirecionamento no painel da Meta e da Nuvemshop, use o
endereço **web** (`https://seudominio.com/auth/meta/callback`), não o scheme.
