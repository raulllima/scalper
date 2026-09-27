import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import type { Config } from "../config.js";
import { findBestProduct, type ProductCandidate } from "../matcher.js";
import type { CompletedOrder } from "../notifier.js";

const CAPTCHA = /captcha|recaptcha|hcaptcha|verify you are human|nao sou um robo/i;
const EMAIL = 'input[type="email"], input[name*="email" i], input[id*="email" i]';
const PASSWORD = 'input[type="password"]';

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
  const input = await firstVisible(page, selector);
  if (!input) return false;
  await input.fill(text);
  return true;
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
  constructor(private readonly config: Config) {}

  async purchase(): Promise<CompletedOrder> {
    const browser = await chromium.launch({ headless: this.config.store.headless });
    const page = await browser.newPage();
    let keepBrowserOpen = false;
    page.setDefaultTimeout(12_000);
    const intervalMs = this.config.availability.pollIntervalSeconds * 1_000;
    const minutes = this.config.availability.timeoutMinutes;
    const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : Number.POSITIVE_INFINITY;
    try {
      await page.goto(this.config.store.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await assertNoCaptcha(page, "acesso inicial");
      await this.login(page);
      const product = await this.findProduct(page);
      console.log(`Produto selecionado: ${product.title}`);
      let productId = await this.waitForAvailability(page, product.url, deadline, intervalMs);
      for (;;) {
        try {
          await this.resetCart(page);
          await this.addToCart(page, productId);
          await this.ensureQuantity(page, productId);
          await this.goToCheckout(page);
          await this.checkout(page);
          return await this.extractPix(page);
        } catch (error) {
          if (error instanceof CaptchaError) throw error;
          if (Date.now() >= deadline) throw error;
          console.log(`Falha ao concluir: ${error instanceof Error ? error.message : error}. Reiniciando o fluxo.`);
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
      const { status, text: html } = await fetchText(page, productUrl);
      if (CAPTCHA.test(html)) throw new CaptchaError(`CAPTCHA detectado ao verificar estoque (HTTP ${status}). O processo foi interrompido sem tentativa de contorno.`);
      if (status >= 400) throw new Error(`Falha ao verificar o estoque do produto (HTTP ${status}).`);
      const productId = html.match(/produto\/(\d+)\//)?.[1];
      const availability = (html.match(/name="twitter:data2" content="([^"]*)"/i)?.[1] ?? "").trim();
      if (productId && /^dispon/i.test(availability) && html.includes(`/carrinho/produto/${productId}/adicionar`)) {
        console.log(`Produto disponivel (id ${productId}).`);
        return productId;
      }
      console.log(`Produto indisponivel (tentativa ${attempt}). Nova verificacao em ${intervalMs / 1_000}s.`);
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
    console.log(items.length ? `Carrinho zerado (${items.length} item(ns) removido(s)).` : "Carrinho ja estava vazio.");
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
      console.log(`Quantidade confirmada: ${current}.`);
      return;
    }
    await fetchText(page, `${this.config.store.baseUrl}/carrinho/produto/${productId}/atualizar`, {
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({ quantidade: String(expected), quantidade_atual: String(current) }).toString()
    });
    const updated = await readQuantity();
    if (updated !== expected) throw new Error(`Quantidade nao aplicada; esperado ${expected}, atual ${updated ?? 0}.`);
    console.log(`Quantidade ajustada para ${updated}.`);
  }

  private async goToCheckout(page: Page): Promise<void> {
    await page.goto(`${this.config.store.baseUrl}/checkout`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!/\/checkout/i.test(page.url())) throw new Error("Nao foi possivel abrir a tela de checkout.");
  }

  private async checkout(page: Page): Promise<void> {
    await assertNoCaptcha(page, "checkout");
    await this.fillAddress(page);
    await this.selectShipping(page);
    await this.selectPix(page);
    if (!this.config.checkout.autoFinalize) {
      await saveDiagnostic(page, "ready-to-finalize");
      throw new Error("Checkout preparado; auto_finalize esta desativado.");
    }
    await clickText(page, [/finalizar.*compra/i, /confirmar.*pedido/i, /pagar.*pix/i]);
    await page.waitForLoadState("domcontentloaded");
    await assertNoCaptcha(page, "finalizacao do pedido");
  }

  private async fillAddress(page: Page): Promise<void> {
    // Campos ja preenchidos indicam que o endereco salvo foi reconhecido pelo checkout.
    await fillIfPresent(page, 'input[name*="cep" i], input[name*="postal" i]', this.config.shipping.postalCode);
    await fillIfPresent(page, 'input[name*="address" i], input[name*="endereco" i], input[name*="street" i]', this.config.shipping.street);
    await fillIfPresent(page, 'input[name*="number" i], input[name*="numero" i]', this.config.shipping.number);
    await fillIfPresent(page, 'input[name*="complement" i]', this.config.shipping.complement);
    await fillIfPresent(page, 'input[name*="neighborhood" i], input[name*="bairro" i]', this.config.shipping.neighborhood);
    await fillIfPresent(page, 'input[name*="city" i], input[name*="cidade" i]', this.config.shipping.city);
    await fillIfPresent(page, 'input[name*="state" i], select[name*="estado" i]', this.config.shipping.state);
    await fillIfPresent(page, 'input[name*="document" i], input[name*="cpf" i]', this.config.shipping.document);
    await fillIfPresent(page, 'input[name*="name" i], input[name*="nome" i]', this.config.shipping.recipientName);
    await page.waitForTimeout(1_000);
  }

  private async selectShipping(page: Page): Promise<void> {
    const options = page.locator('input[type="radio"][name*="shipping" i], input[type="radio"][name*="frete" i]');
    const count = await options.count();
    if (!count) throw new Error("Opcoes de frete nao encontradas.");
    const ranked: Array<{ index: number; cost: number; days: number }> = [];
    for (let index = 0; index < count; index += 1) {
      const input = options.nth(index);
      const labelText = await input.locator("xpath=ancestor::label[1]").innerText().catch(() => "");
      const money = labelText.match(/R\$\s*([\d.]+,\d{2})/i)?.[1]?.replace(".", "").replace(",", ".");
      const days = labelText.match(/(\d+)\s*(?:dia|day)/i)?.[1];
      ranked.push({ index, cost: Number(money ?? Number.MAX_VALUE), days: Number(days ?? Number.MAX_VALUE) });
    }
    ranked.sort((a, b) => this.config.shipping.preference === "mais_barato" ? a.cost - b.cost : a.days - b.days);
    await options.nth(ranked[0].index).check();
  }

  private async selectPix(page: Page): Promise<void> {
    const pix = page.getByText(/pix/i).first();
    if (!await pix.isVisible().catch(() => false)) throw new Error("Metodo PIX nao encontrado.");
    await pix.click();
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
