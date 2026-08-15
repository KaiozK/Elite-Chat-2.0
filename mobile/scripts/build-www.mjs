#!/usr/bin/env node
/**
 * Monta mobile/www — o conteúdo web que vai dentro dos apps das lojas.
 *
 * A pasta é um espelho do layout que o Express serve (/app/… e /assets/…).
 * Isso é de propósito: o painel usa caminhos absolutos em centenas de lugares
 * (`/assets/koonfy-192.png`, `/app/style.css`), e manter a mesma árvore faz
 * todos continuarem válidos dentro do WebView, sem reescrever nada.
 *
 *   www/
 *     index.html        → redireciona para /app/ (o WebView abre a raiz)
 *     app/…             → cópia de public/app (sem o service worker)
 *     assets/…          → cópia de public/assets
 *
 * A URL do backend vem de ELITECHAT_API_URL e é gravada em
 * www/app/native-config.js, lido pelo config.js do painel.
 *
 * Uso:  ELITECHAT_API_URL=https://app.seudominio.com npm run build
 */
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(HERE, '..');
const REPO = resolve(MOBILE, '..');
const PUBLIC = join(REPO, 'public');
const WWW = join(MOBILE, 'www');

const API_URL = (process.env.ELITECHAT_API_URL || '').trim().replace(/\/+$/, '');

if (!API_URL) {
  console.error('\n  ERRO: defina ELITECHAT_API_URL com a URL pública do backend.');
  console.error('  Ex.: ELITECHAT_API_URL=https://app.seudominio.com npm run build\n');
  console.error('  O app das lojas não é servido pelo Express: o HTML vem do próprio');
  console.error('  pacote e as chamadas de API precisam de um endereço absoluto.\n');
  process.exit(1);
}
if (!/^https:\/\//i.test(API_URL) && !/^http:\/\/(localhost|127\.|10\.|192\.168\.)/i.test(API_URL)) {
  console.error(`\n  ERRO: ELITECHAT_API_URL precisa ser https:// (recebi "${API_URL}").`);
  console.error('  App Store e Play Store recusam tráfego em texto puro.\n');
  process.exit(1);
}

// Arquivos que não fazem sentido dentro do app: o Service Worker cacheia
// caminhos do servidor e o manifest é coisa de PWA no navegador.
const EXCLUIR = new Set(['sw.js', 'manifest.webmanifest']);

await rm(WWW, { recursive: true, force: true });
await mkdir(WWW, { recursive: true });

await cp(join(PUBLIC, 'app'), join(WWW, 'app'), {
  recursive: true,
  filter: (src) => !EXCLUIR.has(src.split(/[\\/]/).pop())
});
// Só os assets que o painel realmente referencia. public/assets guarda também
// o material da landing (vídeos, logos de parceiros) — 6 MB que não têm por que
// pesar no download da loja.
// Esta lista tem que ser EXATAMENTE o que public/app referencia. Depois da
// troca da marca ela ficou apontando para o logotipo antigo: o app das lojas
// sairia com a coroa e sem nenhuma das imagens novas — ícone quebrado no lugar
// da logo. Para conferir:  grep -rho "/assets/[^\"']*" public/app | sort -u
const ASSETS_DO_APP = [
  'koonfy-32.png', 'koonfy-128.png', 'koonfy-180.png', 'koonfy-192.png', 'koonfy-512.png',
  // Os avisos sonoros são buscados por caminho; sem eles o app cai no tom
  // sintetizado, que funciona mas não é o som de venda que se reconhece.
  'sons/mensagem.mp3', 'sons/venda.mp3'
];
await mkdir(join(WWW, 'assets', 'sons'), { recursive: true });
for (const nome of ASSETS_DO_APP) {
  await cp(join(PUBLIC, 'assets', nome), join(WWW, 'assets', nome));
}

// A MARCA no app das lojas.
//
// No navegador a logo vem de /marca/logo, uma rota do Express que serve o que o
// admin enviou. Dentro do WebView não há Express: o HTML sai do próprio pacote,
// e esse caminho resolveria para um arquivo inexistente — imagem quebrada em
// todas as telas. Aqui ele vira o arquivo local.
//
// O custo é conhecido: trocar a logo pelo painel NÃO muda o app já publicado,
// só a próxima versão enviada para as lojas. Melhor isso do que um app que
// depende da rede para desenhar a própria marca.
{
  const { readdir } = await import('node:fs/promises');
  const alvos = [];
  const varrer = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await varrer(p);
      else if (/\.(html|js|css)$/i.test(e.name)) alvos.push(p);
    }
  };
  await varrer(join(WWW, 'app'));
  let trocados = 0;
  for (const p of alvos) {
    const antes = await readFile(p, 'utf8');
    if (!antes.includes('/marca/logo')) continue;
    await writeFile(p, antes.split('/marca/logo').join('/assets/koonfy-192.png'));
    trocados++;
  }
  if (trocados) console.log(`  marca: /marca/logo → /assets/koonfy-192.png em ${trocados} arquivo(s)`);
}

// Configuração injetada: lida pelo public/app/config.js já no primeiro script.
await writeFile(join(WWW, 'app', 'native-config.js'),
  `/* Gerado por mobile/scripts/build-www.mjs — não editar à mão. */\n` +
  `window.__ELITECHAT_NATIVE__ = ${JSON.stringify({ apiUrl: API_URL, builtAt: new Date().toISOString() }, null, 2)};\n`
);

// O native-config.js precisa vir ANTES do config.js, que o consome.
const indexPath = join(WWW, 'app', 'index.html');
let html = await readFile(indexPath, 'utf8');
if (!html.includes('native-config.js')) {
  html = html.replace(
    /<script src="\/app\/config\.js[^"]*"><\/script>/,
    '<script src="/app/native-config.js"></script>\n<script src="/app/config.js"></script>'
  );
}
// Sem service worker no app: os arquivos já estão no pacote.
html = html.replace(/<link rel="manifest"[^>]*>\s*/g, '');
await writeFile(indexPath, html);

// O WebView abre a raiz; o painel mora em /app/.
await writeFile(join(WWW, 'index.html'),
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">` +
  `<title>EliteChat</title><meta http-equiv="refresh" content="0;url=/app/"></head>` +
  `<body><script>location.replace('/app/');</script></body></html>\n`
);

if (!existsSync(join(WWW, 'app', 'app.js'))) {
  console.error('  ERRO: www/app/app.js não foi copiado — verifique public/app.');
  process.exit(1);
}

console.log(`  www/ pronto — backend: ${API_URL}`);
