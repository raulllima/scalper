import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import type { Config } from "../config.js";
import { findBestProduct, type ProductCandidate } from "../matcher.js";
import type { CompletedOrder } from "../notifier.js";

const CAPTCHA = /captcha|recaptcha|hcaptcha|verify you are human|nao sou um robo/i;
const EMAIL = 'input[type="email"], input[name*="email" i], input[id*="email" i]';
const PASSWORD = 'input[type="password"]';
const SHIPPING_FIELDSET = "xpath=/html/body/div[2]/div[1]/div/div[1]/div/div[2]/form/div/div[2]/div/fieldset/div/div[4]";
const PIX_FIELDSET = "xpath=/html/body/div[2]/div[1]/div/div[1]/div/div[2]/form/div/div[3]/div/fieldset/div[1]/div[3]";

export interface AvailabilityResult {
  available: boolean;
  productId?: string;
  quantity?: number;
  source: string;
}

function detectAvailability(html: string): AvailabilityResult {
  const productId = html.match(/carrinho\/produto\/(\d+)\/adicionar/i)?.[1] ?? html.match(/produto\/(\d+)\//)?.[1];
  const metaAvailability = (html.match(/name="twitter:data2" content="([^"]*)"/i)?.[1] ?? "").trim();
  const hasCartRoute = Boolean(productId && new RegExp(`/carrinho/produto/${productId}/adicionar`, "i").test(html));
  const unavailable = /produto\s+(?:indisponivel|esgotado)|avise[-\s]?me\s+quando\s+chegar|fora\s+de\s+estoque/i.test(html);
  const purchaseControl = /(?:adicionar\s+ao\s+carrinho|comprar\s+agora|botao[-_ ]comprar)/i.test(html);
  if (hasCartRoute) return { available: true, productId, source: "link do carrinho" };
  if (/^dispon/i.test(metaAvailability)) return { available: true, productId, source: "metadado de disponibilidade" };
  if (!unavailable && purchaseControl) return { available: true, productId, source: "botao de compra" };
  return { available: false, productId, source: unavailable ? "marcado como indisponivel" : "nenhum sinal de compra ativo" };
}

class CaptchaError extends Error {}

async function captchaPresent(page: Page): Promise<boolean> {
  return CAPTCHA.test(await page.locator("body").innerText().catch(() => "")) || await page.locator('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], [class*="captcha" i]').count() > 0;
}

async function assertNoCaptcha(page: Page, stage: string): Promise<void> {
  if (await captchaPresent(page)) throw new CaptchaError(`CAPTCHA detectado durante ${stage}. O processo foi interrompido sem tentativa de contorno.`);
}

async function firstVisible(page: Page, selector: string): Promise<Locator | undefined> {
  for (const item of selector.split(",")) {
    const locator = page.locator(item.trim()).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return undefined;
}

async function clickText(page: Page, patterns: RegExp[]): Promise<void> {
  for (const pattern of patterns) {
    const target = page.getByRole("button", { name: pattern }).first();
    if (await target.isVisible().catch(() => false)) { await target.click(); return; }
    const link = page.getByRole("link", { name: pattern }).first();
    if (await link.isVisible().catch(() => false)) { await link.click(); return; }
  }
  throw new Error(`Acao nao encontrada: ${patterns.map(String).join(", ")}`);
}

async function fillIfPresent(page: Page, selector: string, text: string): Promise<boolean> {
  if (!text) return false;
  const candidates = page.locator(selector);
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const input = candidates.nth(index);
    if (!await input.isVisible().catch(() => false)) continue;
    const tag = await input.evaluate((element) => element.tagName.toLowerCase()).catch(() => "");
    if (tag === "select") {
      await input.selectOption({ label: text }).catch(async () => input.selectOption(text));
      return true;
    }
    const type = (await input.getAttribute("type") ?? "").toLowerCase();
    if (["radio", "checkbox", "hidden", "button", "submit", "reset"].includes(type)) continue;
    if (!await input.isEditable().catch(() => false)) continue;
    try {
      await input.fill(text, { timeout: 2_000 });
      await input.dispatchEvent("change").catch(() => undefined);
      await input.dispatchEvent("blur").catch(() => undefined);
      return true;
    } catch {
      // O checkout pode ocultar o campo enquanto recalcula o endereco; tenta o proximo campo visivel.
    }
  }
  return false;
}

async function fetchText(page: Page, url: string, init?: { method?: string; body?: string; contentType?: string }): Promise<{ status: number; text: string }> {
  return page.evaluate(async ({ url, init }) => {
    const headers: Record<string, string> = {};
    if (init?.contentType) headers["Content-Type"] = init.contentType;
    const response = await fetch(url, { method: init?.method ?? "GET", body: init?.body, headers, credentials: "same-origin" });
    return { status: response.status, text: await response.text() };
  }, { url, init });
}

async function saveDiagnostic(page: Page, label: string): Promise<void> {
  mkdirSync("output", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await page.screenshot({ path: join("output", `diagnostic-${label}-${stamp}.png`), fullPage: true }).catch(() => undefined);
}

export class GamerHutConnector {
  constructor(
    private readonly config: Config,
    private readonly options: { onLog?: (message: string) => void; signal?: AbortSignal } = {}
  ) {}

  async testConnection(): Promise<void> {
    const browser = await chromium.launch({ headless: this.config.store.headless });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(12_000);
      await page.goto(this.config.store.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertNoCaptcha(page, "acesso inicial");
      await this.login(page);
      this.log("Login na Gamer Hut confirmado.");
    } finally {
      await browser.close();
    }
  }

  async searchProducts(query: string): Promise<ProductCandidate[]> {
    // Busca publica nao exige intervencao do usuario, portanto nao abre uma janela.
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(12_000);
      await page.goto(`${this.config.store.baseUrl}/buscar?q=${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertNoCaptcha(page, "busca do produto");
      return await page.locator(".listagem-item-wrap a.produto-sobrepor, .listagem-item-wrap a.nome-produto").evaluateAll((links) => {
        const products = links.map((link) => {
          const item = link.closest(".listagem-item-wrap");
          const image = item?.querySelector("img");
          const price = item?.querySelector(".preco-promocional, .preco-venda, .preco-produto, [class*='preco']")?.textContent?.replace(/\s+/g, " ").trim();
          const source = image?.getAttribute("data-src") || (image as HTMLImageElement | null)?.currentSrc || (image as HTMLImageElement | null)?.src;
          return {
            title: (link.getAttribute("title") || link.textContent || "").trim(),
            url: (link as HTMLAnchorElement).href,
            imageUrl: source ? new URL(source, document.baseURI).href : undefined,
            price: price?.match(/R\$\s*[\d.]+,\d{2}/)?.[0]
          };
        }).filter((item) => item.title && item.url);
        // Cada produto possui um link de sobreposicao e outro de titulo na Gamer Hut.
        return products.filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index);
      });
    } finally {
      await browser.close();
    }
  }

  async checkAvailability(productUrl: string): Promise<AvailabilityResult> {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(20_000);
      const response = await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      const html = await page.content();
      if (CAPTCHA.test(html)) throw new CaptchaError("CAPTCHA detectado ao verificar estoque. O monitoramento foi interrompido sem tentativa de contorno.");
      if (!response || response.status() >= 400) throw new Error(`Falha ao verificar o estoque do produto (HTTP ${response?.status() ?? 0}).`);
      return detectAvailability(html);
    } finally {
      await browser.close();
    }
  }

  async monitor(): Promise<ProductCandidate> {
    const browser = await chromium.launch({ headless: this.config.store.headless });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(12_000);
      const intervalMs = this.config.availability.pollIntervalSeconds * 1_000;
      const minutes = this.config.availability.timeoutMinutes;
      const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : Number.POSITIVE_INFINITY;
      await page.goto(this.config.store.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertNoCaptcha(page, "acesso inicial");
      await this.login(page);
      const product = await this.findProduct(page);
      await this.waitForAvailability(page, product.url, deadline, intervalMs);
      this.log(`Produto disponivel: ${product.title}`);
      return product;
    } finally {
      await browser.close();
    }
  }

  private log(message: string): void {
    console.log(message);
    this.options.onLog?.(message);
  }

  private assertNotAborted(): void {
    if (this.options.signal?.aborted) throw new Error("Monitoramento cancelado.");
  }

  async purchase(productUrl?: string): Promise<CompletedOrder> {
    const browser = await chromium.launch({ headless: this.config.store.headless });
    const page = await browser.newPage();
    let keepBrowserOpen = false;
    page.setDefaultTimeout(12_000);
    const intervalMs = this.config.availability.pollIntervalSeconds * 1_000;
    const minutes = this.config.availability.timeoutMinutes;
    const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : Number.POSITIVE_INFINITY;
    try {
      this.assertNotAborted();
      this.log("Conectando a Gamer Hut.");
      await page.goto(this.config.store.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertNoCaptcha(page, "acesso inicial");
      await this.login(page);
      const product = productUrl ? { title: this.config.product.name, url: productUrl } : await this.findProduct(page);
      this.log(`Produto selecionado: ${product.title}`);
      let productId = await this.waitForAvailability(page, product.url, deadline, intervalMs);
      for (;;) {
        try {
          this.log("Limpando carrinho.");
          await this.resetCart(page);
          this.log("Adicionando produto ao carrinho.");
          await this.addToCart(page, productId);
          this.log("Aplicando quantidade.");
          await this.ensureQuantity(page, productId);
          this.log("Abrindo checkout.");
          await this.goToCheckout(page);
          this.log("Preenchendo endereco, frete e pagamento PIX.");
          await this.checkout(page);
          this.log("Pedido finalizado. Obtendo PIX.");
          return await this.extractPix(page);
        } catch (error) {
          if (error instanceof CaptchaError) throw error;
          if (Date.now() >= deadline) throw error;
          this.log(`Falha ao concluir: ${error instanceof Error ? error.message : error}. Reiniciando o fluxo.`);
          await page.waitForTimeout(intervalMs);
          productId = await this.waitForAvailability(page, product.url, deadline, intervalMs);
        }
      }
    } catch (error) {
      await saveDiagnostic(page, "failure");
      if (error instanceof CaptchaError) {
        keepBrowserOpen = true;
        console.error(`${error.message} O navegador permanecera aberto para conclusao manual do pedido.`);
        return await new Promise<CompletedOrder>(() => undefined);
      }
      throw error;
    } finally {
      if (!keepBrowserOpen) await browser.close();
    }
  }

  private async login(page: Page): Promise<void> {
    const login = await firstVisible(page, 'a[href*="login" i], a[href*="conta" i], button:has-text("Entrar")');
    if (!login) throw new Error("Link de login nao encontrado.");
    await login.click();
    await assertNoCaptcha(page, "login");
    const email = await firstVisible(page, EMAIL);
    if (!email) throw new Error("Campo de e-mail nao encontrado.");
    await email.fill(this.config.account.email);
    const password = await firstVisible(page, PASSWORD);
    if (!password) throw new Error("Campo de senha nao encontrado.");
    await password.fill(this.config.account.password);
    await clickText(page, [/prosseguir/i]);
    await page.waitForLoadState("domcontentloaded");
    await assertNoCaptcha(page, "envio do login");
    const loginError = await page.getByText(/e-mail.*invalido|senha.*incorreta|dados.*incorretos|falha.*login/i).first().isVisible().catch(() => false);
    if (loginError || await email.isVisible().catch(() => false)) throw new Error("Nao foi possivel confirmar o login na Gamer Hut.");
  }

  private async findProduct(page: Page): Promise<ProductCandidate> {
    const query = encodeURIComponent(this.config.product.name);
    await page.goto(`${this.config.store.baseUrl}/buscar?q=${query}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertNoCaptcha(page, "busca do produto");
    const candidates = await page.locator(".listagem-item-wrap a.produto-sobrepor, .listagem-item-wrap a.nome-produto").evaluateAll((links) => links.map((link) => ({
      title: (link.getAttribute("title") || link.textContent || "").trim(),
      url: (link as HTMLAnchorElement).href
    })).filter((item) => item.title && item.url));
    return findBestProduct(this.config.product.name, candidates, this.config.product.similarityThreshold);
  }

  private async waitForAvailability(page: Page, productUrl: string, deadline: number, intervalMs: number): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      this.assertNotAborted();
      const { status, text: html } = await fetchText(page, productUrl);
      if (CAPTCHA.test(html)) throw new CaptchaError(`CAPTCHA detectado ao verificar estoque (HTTP ${status}). O processo foi interrompido sem tentativa de contorno.`);
      if (status >= 400) throw new Error(`Falha ao verificar o estoque do produto (HTTP ${status}).`);
      const availability = detectAvailability(html);
      if (availability.available && availability.productId) {
        this.log(`Produto disponivel (id ${availability.productId}; ${availability.source}).`);
        return availability.productId;
      }
      this.log(`Produto indisponivel (${availability.source}, tentativa ${attempt}). Nova verificacao em ${intervalMs / 1_000}s.`);
      if (Date.now() >= deadline) throw new Error("Tempo limite aguardando a disponibilidade do produto.");
      await page.waitForTimeout(intervalMs);
    }
  }

  private async cartProductIds(page: Page): Promise<string[]> {
    const { status, text: html } = await fetchText(page, `${this.config.store.baseUrl}/carrinho/index`);
    if (status >= 400) throw new Error(`Falha ao consultar o carrinho (HTTP ${status}).`);
    return [...new Set([...html.matchAll(/<tr[^>]*data-produto-id="(\d+)"/g)].map((match) => match[1]))];
  }

  private async resetCart(page: Page): Promise<void> {
    const items = await this.cartProductIds(page);
    for (const id of items) {
      const { status } = await fetchText(page, `${this.config.store.baseUrl}/carrinho/produto/${id}/remover`);
      if (status >= 400) throw new Error(`Falha ao remover o item ${id} do carrinho (HTTP ${status}).`);
    }
    const remaining = await this.cartProductIds(page);
    if (remaining.length) throw new Error(`Carrinho nao foi zerado; restam ${remaining.length} item(ns).`);
    this.log(items.length ? `Carrinho zerado (${items.length} item(ns) removido(s)).` : "Carrinho ja estava vazio.");
  }

  private async addToCart(page: Page, productId: string): Promise<void> {
    const { status } = await fetchText(page, `${this.config.store.baseUrl}/carrinho/produto/${productId}/adicionar`);
    if (status >= 400) throw new Error(`Falha ao adicionar o produto ao carrinho (HTTP ${status}).`);
    const ids = await this.cartProductIds(page);
    if (!ids.includes(productId)) throw new Error("Produto nao apareceu no carrinho apos a adicao.");
  }

  private async ensureQuantity(page: Page, productId: string): Promise<void> {
    const expected = this.config.product.quantity;
    const readQuantity = async (): Promise<number | undefined> => {
      const { text: html } = await fetchText(page, `${this.config.store.baseUrl}/carrinho/index`);
      const row = html.match(new RegExp(`<tr[^>]*data-produto-id="${productId}"[^>]*>`))?.[0];
      const quantity = row?.match(/data-produto-quantidade="(\d+)"/)?.[1];
      return quantity ? Number(quantity) : undefined;
    };
    const current = await readQuantity();
    if (current === undefined) throw new Error("Produto nao encontrado no carrinho para confirmar a quantidade.");
    if (current === expected) {
      this.log(`Quantidade confirmada: ${current}.`);
      return;
    }
    await fetchText(page, `${this.config.store.baseUrl}/carrinho/produto/${productId}/atualizar`, {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ quantidade: String(expected), quantidade_atual: String(current) }).toString()
    });
    const updated = await readQuantity();
    if (updated !== expected) throw new Error(`Quantidade nao aplicada; esperado ${expected}, atual ${updated ?? 0}.`);
    this.log(`Quantidade ajustada para ${updated}.`);
  }

  private async goToCheckout(page: Page): Promise<void> {
    await page.goto(`${this.config.store.baseUrl}/checkout`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!/\/checkout/i.test(page.url())) throw new Error("Nao foi possivel abrir a tela de checkout.");
  }

  private async checkout(page: Page): Promise<void> {
    this.log("Preenchendo endereco de entrega.");
    await this.fillAddress(page);
    this.log("Selecionando frete.");
    await this.selectShipping(page);
    this.log("Selecionando pagamento PIX.");
    await this.selectPix(page);
    if (await captchaPresent(page)) {
      await this.waitForManualCheckout(page);
      return;
    }
    if (!this.config.checkout.autoFinalize) {
      await saveDiagnostic(page, "ready-to-finalize");
      throw new Error("Checkout preparado; auto_finalize esta desativado.");
    }
    await clickText(page, [/finalizar.*compra/i, /confirmar.*pedido/i, /pagar.*pix/i]);
    await page.waitForLoadState("domcontentloaded");
    if (await captchaPresent(page)) await this.waitForManualCheckout(page);
  }

  private async waitForManualCheckout(page: Page): Promise<void> {
    this.log("CAPTCHA detectado. Endereco, frete e PIX foram preparados. Conclua o reCAPTCHA e clique em Finalizar compra manualmente no navegador aberto.");
    for (;;) {
      this.assertNotAborted();
      const body = await page.locator("body").innerText().catch(() => "");
      if (/000201/.test(body)) return;
      await page.waitForTimeout(1_000);
    }
  }

  private async fillAddress(page: Page): Promise<void> {
    const savedAddress = page.locator('input[type="radio"][name*="endereco" i]:checked, input[type="radio"][name*="address" i]:checked');
    if (await savedAddress.count()) {
      this.log("Endereco salvo selecionado no checkout.");
      await page.waitForTimeout(1_000);
      return;
    }
    this.log("Preenchendo formulario de novo endereco.");
    await fillIfPresent(page, 'input[name*="cep" i], input[name*="postal" i]', this.config.shipping.postalCode);
    await fillIfPresent(page, 'input[type="text"][name*="address" i], input[type="text"][name*="endereco" i], input[type="text"][name*="street" i]', this.config.shipping.street);
    await fillIfPresent(page, 'input[name*="number" i], input[name*="numero" i]', this.config.shipping.number);
    await fillIfPresent(page, 'input[name*="complement" i]', this.config.shipping.complement);
    await fillIfPresent(page, 'input[name*="neighborhood" i], input[name*="bairro" i]', this.config.shipping.neighborhood);
    await fillIfPresent(page, 'input[name*="city" i], input[name*="cidade" i]', this.config.shipping.city);
    await fillIfPresent(page, 'input[name*="state" i], select[name*="estado" i]', this.config.shipping.state);
    await fillIfPresent(page, 'input[name*="document" i], input[name*="cpf" i]', this.config.shipping.document);
    await fillIfPresent(page, 'input[name*="name" i], input[name*="nome" i]', this.config.shipping.recipientName);
    await page.waitForTimeout(1_000);
  }

  private async shippingOptions(page: Page): Promise<Array<{ input: Locator; labelText: string }>> {
    const shippingFieldset = page.locator(SHIPPING_FIELDSET);
    const scopedRadios = shippingFieldset.locator('input[type="radio"], input[type="checkbox"]');
    const usingScopedRadios = await scopedRadios.count().catch(() => 0) > 0;
    const radios = usingScopedRadios ? scopedRadios : page.locator('input[type="radio"], input[type="checkbox"]');
    const details = await radios.evaluateAll((elements, scoped) => elements.map((input, index) => {
      const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : undefined;
      const text = (label?.textContent || input.closest("label")?.textContent || input.parentElement?.textContent || "").replace(/\s+/g, " ").trim();
      return { index, name: `${input.getAttribute("name") || ""} ${input.id || ""}`, text };
    }).filter((item) => scoped || /shipping|frete|entrega|envio|forma_envio/i.test(item.name) || /frete|entrega|envio|sedex|pac|correios/i.test(item.text)), usingScopedRadios);
    return details.map((item) => ({ input: radios.nth(item.index), labelText: item.text }));
  }

  private async selectShipping(page: Page): Promise<void> {
    this.log("Aguardando calculo do frete.");
    const deadline = Date.now() + 45_000;
    let options: Array<{ input: Locator; labelText: string }> = [];
    while (Date.now() < deadline) {
      this.assertNotAborted();
      options = await this.shippingOptions(page);
      if (options.length) break;
      await page.waitForTimeout(100);
    }
    if (!options.length) {
      await saveDiagnostic(page, "shipping-not-loaded");
      throw new Error("Opcoes de frete nao carregaram em 45 segundos.");
    }
    const ranked: Array<{ index: number; cost: number; days: number }> = [];
    for (let index = 0; index < options.length; index += 1) {
      const { labelText } = options[index];
      const money = labelText.match(/R\$\s*([\d.]+,\d{2})/i)?.[1]?.replace(".", "").replace(",", ".");
      const days = labelText.match(/(\d+)\s*(?:dia|day)/i)?.[1];
      ranked.push({ index, cost: Number(money ?? Number.MAX_VALUE), days: Number(days ?? Number.MAX_VALUE) });
    }
    ranked.sort((a, b) => this.config.shipping.preference === "mais_barato" ? a.cost - b.cost : a.days - b.days);
    const selected = options[ranked[0].index].input;
    await selected.check({ force: true });
    if (!await selected.isChecked()) throw new Error("A opcao de frete nao permaneceu selecionada.");
    this.log(`Frete selecionado: ${this.config.shipping.preference === "mais_barato" ? "mais barato" : "mais rapido"}.`);
  }

  private async selectPix(page: Page): Promise<void> {
    this.log("Aguardando metodo PIX.");
    const pixFieldset = page.locator(PIX_FIELDSET);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const radios = pixFieldset.locator('input[type="radio"], input[type="checkbox"]');
      const details = await radios.evaluateAll((elements) => elements.map((input, index) => {
        const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : undefined;
        const text = (label?.textContent || input.closest("label")?.textContent || input.parentElement?.textContent || "").replace(/\s+/g, " ").trim();
        return { index, checked: (input as HTMLInputElement).checked, description: `${input.getAttribute("name") || ""} ${input.id || ""} ${input.getAttribute("value") || ""} ${text}` };
      })).catch(() => [] as Array<{ index: number; checked: boolean; description: string }>);
      const selectedPix = details.find((item) => item.checked && (/pix/i.test(item.description) || details.length === 1));
      if (selectedPix) {
        this.log("PIX ja estava selecionado.");
        return;
      }
      const pix = details.find((item) => /pix/i.test(item.description));
      if (pix) {
        const option = radios.nth(pix.index);
        await option.check({ force: true });
        if (await option.isChecked()) {
          this.log("PIX selecionado.");
          return;
        }
      }
      // Algumas versoes do checkout usam o proprio bloco como opcao clicavel, sem radio acessivel.
      const pixText = pixFieldset.getByText(/pix/i).first();
      if (await pixText.isVisible().catch(() => false)) {
        await pixText.click();
        await page.waitForTimeout(100);
      } else {
        await page.waitForTimeout(100);
      }
    }
    await saveDiagnostic(page, "pix-not-found");
    throw new Error("Metodo PIX nao carregou em 15 segundos.");
  }

  private async extractPix(page: Page): Promise<CompletedOrder> {
    await page.waitForTimeout(1_000);
    const text = await page.locator("body").innerText();
    const code = text.match(/000201(?:[\s\S]*?)(?=\s{2,}|\n\n|$)/)?.[0]?.replace(/\s/g, "");
    if (!code) throw new Error("Codigo PIX copia e cola nao encontrado na pagina final.");
    const orderNumber = text.match(/(?:pedido|order)\s*(?:n[ºo.]?\s*)?[#:]*\s*([A-Z0-9-]{3,})/i)?.[1];
    if (!orderNumber) throw new Error("Numero do pedido nao encontrado na pagina final; o PIX nao sera registrado como concluido.");
    return { code, orderUrl: page.url(), orderNumber, storeName: "gamerhut", screenshot: await page.screenshot({ fullPage: true }) };
  }
}
