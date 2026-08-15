# Ícone e splash dos apps

Coloque aqui os dois arquivos-fonte e rode `npx capacitor-assets generate`
na pasta `mobile/` — ele produz todos os tamanhos que App Store e Play Store
exigem, para as duas plataformas.

| Arquivo | Tamanho | Cuidados |
|---|---|---|
| `icon.png` | 1024×1024 | Sem transparência e sem cantos arredondados — a Apple rejeita ícone com canal alfa. O iOS arredonda sozinho. |
| `splash.png` | 2732×2732 | Logo centralizado numa área segura de ~1200 px: as bordas são cortadas em telas de proporções diferentes. |

Opcionalmente, `icon-foreground.png` e `icon-background.png` (1024×1024) geram
o ícone adaptativo do Android, que se deforma conforme a máscara do launcher.

O logo em `public/assets/koonfy-logo.png` (1254×1254) serve de base para o
`icon.png` — basta achatar a transparência sobre um fundo sólido.
