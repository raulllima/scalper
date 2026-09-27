# Scalper Bot

Automacao de compra para lojas configuradas, iniciando pela Gamer Hut. O fluxo prioriza as requisicoes usadas pela pagina quando forem identificaveis e usa navegador automatizado nas etapas restantes.

## Preparacao

1. Instale Node.js 22 ou superior.
2. Execute `npm install` e depois `npx playwright install chromium`.
3. Copie `config.example.ini` para `config.ini` e preencha os campos, inclusive as senhas.
4. Execute `npm start`.

Cada compra concluida gera `orders/<site>-<numero-do-pedido>.txt`, contendo o PIX copia-e-cola. Quando configurado, o PIX tambem e enviado por SMTP. O QR Code e salvo como captura de tela em `output/` quando a pagina final o exibe.

## Regras

- O bot observa o estoque do produto encontrado e recarrega a pagina em loop ate o botao de compra aparecer.
- `availability.poll_interval_seconds` define o intervalo entre as verificacoes; `timeout_minutes = 0` observa indefinidamente.
- A verificacao de estoque, a limpeza do carrinho, a adicao e o ajuste de quantidade usam requisicoes HTTP reaproveitando a sessao; o navegador fica para login e checkout.
- O bot zera o carrinho assim que o produto fica disponivel e depois adiciona apenas o produto encontrado.
- `product.quantity` define a quantidade exata aplicada no carrinho; a quantidade e confirmada antes de seguir.
- Se uma tentativa de compra falhar, o fluxo reinicia e observa novamente, repetindo ate concluir ou atingir o limite.
- `product.name` aceita o nome desejado; o bot compara os resultados normalizados por similaridade e exige o minimo em `similarity_threshold`.
- `shipping.preference` aceita `mais_barato` ou `mais_rapido`.
- `checkout.auto_finalize = true` confirma a compra. Use `false` para validar o fluxo sem a confirmacao final.
- Se houver CAPTCHA, o navegador permanece aberto no checkout para conclusao manual; o processo registra o bloqueio e nao tenta resolver ou contornar CAPTCHA.

## Limite do conector

Checkout e um fluxo especifico de cada loja e pode mudar sem aviso. O conector detecta seletrores comuns e salva diagnosticos em `output/` caso a Gamer Hut mude a interface; ajuste os seletrores em `src/connectors/gamerhut.ts` a partir desse diagnostico.
