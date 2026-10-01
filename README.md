# Scalper

Aplicativo desktop com Vue 3, Electron e componentes no padrao shadcn-vue para monitorar disponibilidade e comprar na Gamer Hut.

## Execucao

1. Instale Node.js 22 ou superior.
2. Execute `npm install` e `npx playwright install chromium`.
3. Execute `npm run dev`.
4. Na primeira abertura pelo projeto, o aplicativo importa automaticamente o `config.ini` existente. Depois disso, o arquivo nao e mais necessario.
5. Em **Settings**, revise os dados da conta, endereco e notificacoes. Senhas da loja e do SMTP sao cifradas pelo cofre do sistema operacional.
6. Em **Buys**, busque um jogo e escolha **Monitorar** ou **Monitorar e comprar**.

`npm run build` gera o instalador Windows. `npm run check` valida tipos e produz os bundles sem empacotar.

## Recursos

- Menu com Buys, Logs e Settings.
- Busca de produtos na Gamer Hut e monitoramento com intervalo configuravel em segundos.
- Status de conexao da loja: Conectado, Conectando ou Desconectado.
- Cancelamento de monitoramentos em execucao e logs em tempo real durante a sessao.
- Checkout PIX automatico para a acao **Monitorar e comprar**.
- Pedidos PIX concluidos sao salvos em `orders/` dentro da pasta de dados do aplicativo.
- Todas as secoes do antigo `config.ini`, incluindo SMTP, ficam disponiveis em **Settings**.

## Regras

- O bot observa o estoque do produto encontrado e recarrega a pagina em loop ate o botao de compra aparecer.
- O intervalo e definido em **Settings**; `timeout = 0` observa indefinidamente.
- A verificacao de estoque, a limpeza do carrinho, a adicao e o ajuste de quantidade usam requisicoes HTTP reaproveitando a sessao; o navegador fica para login e checkout.
- O bot zera o carrinho assim que o produto fica disponivel e depois adiciona apenas o produto encontrado.
- A quantidade define o total aplicado no carrinho; ela e confirmada antes de seguir.
- Se uma tentativa de compra falhar, o fluxo reinicia e observa novamente, repetindo ate concluir ou atingir o limite.
- `product.name` aceita o nome desejado; o bot compara os resultados normalizados por similaridade e exige o minimo em `similarity_threshold`.
- `shipping.preference` aceita `mais_barato` ou `mais_rapido`.
- `checkout.auto_finalize = true` confirma a compra. Use `false` para validar o fluxo sem a confirmacao final.
- Se houver CAPTCHA, o navegador permanece aberto no checkout para conclusao manual; o processo registra o bloqueio e nao tenta resolver ou contornar CAPTCHA.

## Limite do conector

Checkout e um fluxo especifico de cada loja e pode mudar sem aviso. O conector detecta seletrores comuns e salva diagnosticos em `output/` caso a Gamer Hut mude a interface; ajuste os seletrores em `src/connectors/gamerhut.ts` a partir desse diagnostico.
