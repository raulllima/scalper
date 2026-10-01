import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Store from "electron-store";
import ini from "ini";
import { GamerHutConnector } from "../connectors/gamerhut.js";
import { notify } from "../notifier.js";
import type { Config } from "../config.js";
import { defaultSettings } from "../shared/defaults.js";
import type { AppLog, AppSettings, ConnectionStatus, MonitorJob, ShippingAddress, WatchItem } from "../shared/types.js";

const settingsStore = new Store<AppSettings>({ name: "settings", defaults: defaultSettings });
const secretsStore = new Store<{ password?: string; smtpPassword?: string }>({ name: "secrets" });
const migrationStore = new Store<{ configIniMigrated?: boolean }>({ name: "migration" });
const watchStore = new Store<{ items: WatchItem[] }>({ name: "watchlist", defaults: { items: [] } });
const jobs = new Map<string, { job: MonitorJob; controller: AbortController }>();
const watchControllers = new Map<string, AbortController>();
let logs: AppLog[] = [];
let connectionStatus: ConnectionStatus = "disconnected";

function emptyAddress(): ShippingAddress {
  return { id: crypto.randomUUID(), label: "Endereco principal", recipientName: "", document: "", postalCode: "", street: "", number: "", complement: "", neighborhood: "", city: "", state: "SP" };
}

function getSettings(): AppSettings {
  const stored = settingsStore.store as AppSettings & { shipping?: AppSettings["shipping"] & Partial<ShippingAddress> };
  if (stored.addresses?.length || (!stored.shipping?.recipientName && !stored.shipping?.street)) return stored;
  const legacy = stored.shipping;
  const hasLegacyAddress = Boolean(legacy?.recipientName || legacy?.street);
  const address = { ...emptyAddress(), ...legacy };
  const migrated = { ...defaultSettings, ...stored, shipping: { preference: legacy?.preference ?? "mais_barato" }, addresses: hasLegacyAddress ? [address] : [], activeAddressId: hasLegacyAddress ? address.id : "" };
  settingsStore.store = migrated;
  return migrated;
}

function secret(key: "password" | "smtpPassword", label: string, required = true): string {
  const encrypted = secretsStore.get(key);
  if (!encrypted && !required) return "";
  if (!encrypted) throw new Error(`Informe ${label} em Settings.`);
  if (!safeStorage.isEncryptionAvailable()) throw new Error("O cofre seguro do sistema nao esta disponivel.");
  return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
}

function password(): string { return secret("password", "a senha da Gamer Hut"); }

function buildConfig(productName = "", authenticated = true): Config {
  const settings = getSettings();
  const address = settings.addresses.find((item) => item.id === settings.activeAddressId);
  const config: Config = {
    store: { baseUrl: settings.store.baseUrl.replace(/\/$/, ""), connector: "gamerhut", headless: settings.store.headless },
    account: { email: settings.account.email, password: authenticated ? password() : "" },
    product: { name: productName, quantity: settings.product.quantity, similarityThreshold: settings.product.similarityThreshold },
    shipping: { ...(address ?? emptyAddress()), preference: settings.shipping.preference },
    checkout: { paymentMethod: "pix", autoFinalize: settings.checkout.autoFinalize },
    availability: settings.availability,
    notification: { ...settings.notification, smtpPassword: authenticated ? secret("smtpPassword", "a senha SMTP", false) : "" }
  };
  return config;
}

function connector(productName = "", signal?: AbortSignal, onLog?: (message: string) => void, authenticated = true): GamerHutConnector {
  return new GamerHutConnector(buildConfig(productName, authenticated), { signal, onLog });
}

function send(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, value);
}

function addLog(message: string, level: AppLog["level"] = "info", jobId?: string): void {
  const log: AppLog = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), level, message, jobId };
  logs = [...logs.slice(-499), log];
  send("logs:entry", log);
}

function updateJob(job: MonitorJob): void {
  job.updatedAt = new Date().toISOString();
  send("buys:job", job);
}

function setConnectionStatus(status: ConnectionStatus): void {
  connectionStatus = status;
  send("store:connection", status);
}

function watchItems(): WatchItem[] { return watchStore.get("items", []); }

function findWatch(id: string): WatchItem | undefined { return watchItems().find((item) => item.id === id); }

function updateWatch(item: WatchItem): void {
  item.updatedAt = new Date().toISOString();
  watchStore.set("items", watchItems().map((current) => current.id === item.id ? item : current));
  send("watchlist:item", item);
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

function configurationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Configuracao incompleta.";
  return `Configuracao necessaria: ${message}`;
}

async function runWatch(id: string): Promise<void> {
  const item = findWatch(id);
  if (!item || item.status === "paused" || item.status === "completed") return;
  const controller = new AbortController();
  watchControllers.set(id, controller);
  try {
    for (;;) {
      if (controller.signal.aborted) return;
      const current = findWatch(id);
      if (!current || current.status === "paused") return;
      if (current.durationMinutes > 0 && Date.now() >= new Date(current.createdAt).getTime() + current.durationMinutes * 60_000) {
        current.status = "expired"; current.message = "Tempo de monitoramento encerrado."; current.nextCheckAt = undefined; updateWatch(current); return;
      }
      current.status = "watching";
      current.message = "Verificando disponibilidade.";
      current.nextCheckAt = undefined;
      updateWatch(current);
      const availability = await connector("", undefined, undefined, false).checkAvailability(current.productUrl);
      current.available = availability.available;
      current.quantity = availability.quantity;
      current.lastCheckedAt = new Date().toISOString();
      current.availabilitySource = availability.source;
      if (availability.available && current.mode === "buy") {
        try {
          validateCheckoutSettings(getSettings());
          const config = buildConfig(current.productName);
          current.status = "purchasing";
          current.availableAt = current.lastCheckedAt;
          current.purchaseAttempts = (current.purchaseAttempts ?? 0) + 1;
          current.message = `Disponivel detectado por ${availability.source}. Iniciando compra.`;
          updateWatch(current);
          const bot = new GamerHutConnector(config, { signal: controller.signal, onLog: (message) => {
            const live = findWatch(id);
            if (live) {
              live.status = /CAPTCHA detectado|reCAPTCHA concluido/i.test(message) ? "manual" : "purchasing";
              live.message = message;
              updateWatch(live);
            }
            addLog(message, "info", id);
          } });
          const pix = await bot.purchase(current.productUrl);
          current.status = "completed";
          current.message = `PIX gerado para o pedido ${pix.orderNumber}.`;
          current.pix = { code: pix.code, orderNumber: pix.orderNumber, orderUrl: pix.orderUrl };
          current.nextCheckAt = undefined;
          updateWatch(current);
          try { await notify(config, pix, app.getPath("userData")); }
          catch (error) { addLog(`Pedido concluido, mas a notificacao falhou: ${error instanceof Error ? error.message : error}`, "error", id); }
          return;
        } catch (error) {
          const latest = findWatch(id);
          if (!latest) return;
          latest.status = error instanceof Error && /endereco|senha|e-mail|configuracao/i.test(error.message) ? "configuration" : "failed";
          latest.message = latest.status === "configuration" ? configurationMessage(error) : error instanceof Error ? error.message : "Falha ao concluir a compra.";
          latest.nextCheckAt = undefined;
          updateWatch(latest);
          return;
        }
      }
      current.status = availability.available ? "available" : "watching";
      if (availability.available) current.availableAt = current.lastCheckedAt;
      current.message = availability.available ? `Disponivel (${availability.source}). Continuando monitoramento.` : `Indisponivel (${availability.source}).`;
      current.nextCheckAt = new Date(Date.now() + current.intervalSeconds * 1_000).toISOString();
      updateWatch(current);
      await wait(current.intervalSeconds * 1_000, controller.signal);
    }
  } catch (error) {
    const current = findWatch(id);
    if (current && !controller.signal.aborted) { current.status = "failed"; current.message = error instanceof Error ? error.message : "Falha no monitoramento."; current.nextCheckAt = undefined; updateWatch(current); }
  } finally {
    watchControllers.delete(id);
  }
}

function startWatch(id: string): void { if (!watchControllers.has(id)) void runWatch(id); }

function validateSettings(settings: AppSettings): void {
  if (!Number.isInteger(settings.product.quantity) || settings.product.quantity < 1) throw new Error("A quantidade deve ser um inteiro positivo.");
  if (settings.availability.pollIntervalSeconds < 1) throw new Error("O intervalo de verificacao deve ser de pelo menos 1 segundo.");
  if (settings.availability.timeoutMinutes < 0) throw new Error("O timeout nao pode ser negativo.");
  if (settings.addresses.some((address) => !address.label.trim())) throw new Error("Todo endereco precisa de um nome para identificacao.");
  if (settings.addresses.length && !settings.addresses.some((address) => address.id === settings.activeAddressId)) throw new Error("Selecione um endereco ativo.");
  if (settings.notification.channel !== "local" && (!settings.notification.smtpHost.trim() || !settings.notification.to.trim() || !settings.notification.smtpUsername.trim())) {
    throw new Error("Preencha servidor, usuario e destinatario SMTP para notificacoes por e-mail.");
  }
}

function encryptAndSave(key: "password" | "smtpPassword", value?: string): void {
  if (!value?.trim()) return;
  if (!safeStorage.isEncryptionAvailable()) throw new Error("O cofre seguro do sistema nao esta disponivel.");
  secretsStore.set(key, safeStorage.encryptString(value).toString("base64"));
}

function asString(section: Record<string, unknown> | undefined, key: string, fallback = ""): string {
  return String(section?.[key] ?? fallback).trim();
}

function asNumber(section: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = Number(asString(section, key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function asBoolean(section: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  const value = asString(section, key, String(fallback));
  return value === "true" ? true : value === "false" ? false : fallback;
}

function migrateConfigIni(): void {
  if (migrationStore.get("configIniMigrated")) return;
  const file = join(process.cwd(), "config.ini");
  if (!existsSync(file)) { migrationStore.set("configIniMigrated", true); return; }
  const raw = ini.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  const migrated: AppSettings = {
    store: { baseUrl: asString(raw.store, "base_url", defaultSettings.store.baseUrl), headless: asBoolean(raw.store, "headless", defaultSettings.store.headless) },
    account: { email: asString(raw.account, "email") },
    product: { quantity: asNumber(raw.product, "quantity", 1), similarityThreshold: asNumber(raw.product, "similarity_threshold", .82) },
    addresses: [{ id: crypto.randomUUID(), label: "Endereco principal", recipientName: asString(raw.shipping, "recipient_name"), document: asString(raw.shipping, "document"), postalCode: asString(raw.shipping, "postal_code"), street: asString(raw.shipping, "street"), number: asString(raw.shipping, "number"), complement: asString(raw.shipping, "complement"), neighborhood: asString(raw.shipping, "neighborhood"), city: asString(raw.shipping, "city"), state: asString(raw.shipping, "state", "SP") }],
    activeAddressId: "",
    shipping: { preference: asString(raw.shipping, "preference", "mais_barato") === "mais_rapido" ? "mais_rapido" : "mais_barato" },
    checkout: { autoFinalize: asBoolean(raw.checkout, "auto_finalize", true) },
    availability: { pollIntervalSeconds: asNumber(raw.availability, "poll_interval_seconds", 5), timeoutMinutes: asNumber(raw.availability, "timeout_minutes", 0) },
    notification: {
      channel: (["local", "email", "both"] as string[]).includes(asString(raw.notification, "channel")) ? asString(raw.notification, "channel") as AppSettings["notification"]["channel"] : "local",
      smtpHost: asString(raw.notification, "smtp_host"), smtpPort: asNumber(raw.notification, "smtp_port", 587), smtpSecure: asBoolean(raw.notification, "smtp_secure", false), smtpUsername: asString(raw.notification, "smtp_username"), to: asString(raw.notification, "to")
    }
  };
  migrated.activeAddressId = migrated.addresses[0].id;
  settingsStore.store = migrated;
  encryptAndSave("password", asString(raw.account, "password"));
  encryptAndSave("smtpPassword", asString(raw.notification, "smtp_password"));
  migrationStore.set("configIniMigrated", true);
}

function validateCheckoutSettings(settings: AppSettings): void {
  const address = settings.addresses.find((item) => item.id === settings.activeAddressId);
  if (!address) throw new Error("Cadastre e selecione um endereco ativo em Settings antes de comprar.");
  const fields: Array<[string, string]> = [
    ["nome completo", address.recipientName], ["CPF", address.document],
    ["CEP", address.postalCode], ["endereco", address.street],
    ["numero", address.number], ["bairro", address.neighborhood],
    ["cidade", address.city], ["estado", address.state]
  ];
  const missing = fields.find(([, value]) => !value.trim());
  if (missing) throw new Error(`Informe ${missing[0]} em Settings antes de comprar.`);
}

function registerIpc(): void {
  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:hasPassword", () => Boolean(secretsStore.get("password")));
  ipcMain.handle("settings:save", (_, settings: AppSettings, newPassword?: string, newSmtpPassword?: string) => {
    validateSettings(settings);
    settingsStore.store = settings;
    encryptAndSave("password", newPassword);
    encryptAndSave("smtpPassword", newSmtpPassword);
    for (const item of watchItems().filter((item) => item.status === "configuration")) startWatch(item.id);
  });
  ipcMain.handle("store:testConnection", async () => {
    setConnectionStatus("checking");
    try {
      await connector().testConnection();
      setConnectionStatus("connected");
      addLog("Gamer Hut conectada com sucesso.", "success");
    } catch (error) {
      setConnectionStatus("disconnected");
      addLog(error instanceof Error ? error.message : "Falha ao conectar na Gamer Hut.", "error");
    }
    return connectionStatus;
  });
  ipcMain.handle("buys:search", async (_, query: string) => {
    if (!query.trim()) return [];
    addLog(`Buscando por "${query.trim()}" na Gamer Hut.`);
    return connector("", undefined, undefined, false).searchProducts(query.trim());
  });
  ipcMain.handle("buys:list", () => [...jobs.values()].map(({ job }) => job));
  ipcMain.handle("logs:list", () => logs);
  ipcMain.handle("watchlist:list", () => watchItems());
  ipcMain.handle("watchlist:add", (_, input: { productName: string; productUrl: string; imageUrl?: string; mode: "monitor" | "buy"; intervalSeconds: number; durationMinutes: number }) => {
    if (!input.productName.trim() || !input.productUrl.trim()) throw new Error("Produto invalido para monitoramento.");
    if (!Number.isFinite(input.intervalSeconds) || input.intervalSeconds < 1) throw new Error("O intervalo deve ser de pelo menos 1 segundo.");
    if (!Number.isFinite(input.durationMinutes) || input.durationMinutes < 0) throw new Error("A duracao nao pode ser negativa.");
    const duplicate = watchItems().find((item) => item.productUrl === input.productUrl && item.mode === input.mode && ["watching", "available", "purchasing", "configuration"].includes(item.status));
    if (duplicate) return duplicate;
    const now = new Date().toISOString();
    const item: WatchItem = { id: crypto.randomUUID(), productName: input.productName.trim(), productUrl: input.productUrl, imageUrl: input.imageUrl, mode: input.mode, intervalSeconds: input.intervalSeconds, durationMinutes: input.durationMinutes, status: "watching", available: false, createdAt: now, updatedAt: now, message: "Iniciando monitoramento." };
    if (item.mode === "buy") {
      try { validateCheckoutSettings(getSettings()); buildConfig(item.productName); }
      catch (error) { item.status = "configuration"; item.message = configurationMessage(error); }
    }
    watchStore.set("items", [item, ...watchItems()]);
    send("watchlist:item", item);
    addLog(`${input.mode === "buy" ? "Compra" : "Monitoramento"} adicionado a Watchlist: ${item.productName}.`, "info", item.id);
    if (item.status !== "configuration") startWatch(item.id);
    return item;
  });
  ipcMain.handle("watchlist:pause", (_, id: string) => {
    watchControllers.get(id)?.abort();
    const item = findWatch(id);
    if (!item || item.status === "completed") return;
    item.status = "paused"; item.message = "Monitoramento pausado."; item.nextCheckAt = undefined; updateWatch(item);
  });
  ipcMain.handle("watchlist:resume", (_, id: string) => {
    const item = findWatch(id);
    if (!item || item.status === "completed") return;
    item.status = "watching"; item.message = "Retomando monitoramento."; updateWatch(item); startWatch(id);
  });
  ipcMain.handle("watchlist:remove", (_, id: string) => {
    watchControllers.get(id)?.abort();
    watchStore.set("items", watchItems().filter((item) => item.id !== id));
  });
  ipcMain.handle("buys:cancel", (_, id: string) => {
    const item = jobs.get(id);
    if (!item || item.job.status !== "running") return;
    item.controller.abort();
    item.job.status = "cancelled";
    item.job.message = "Cancelamento solicitado.";
    updateJob(item.job);
    addLog(`Monitoramento de "${item.job.productName}" cancelado.`, "info", id);
  });
  ipcMain.handle("buys:start", (_, input: { productName: string; productUrl?: string; mode: "monitor" | "buy" }) => {
    if (!input.productName.trim()) throw new Error("Selecione um produto para monitorar.");
    if (input.mode === "buy") validateCheckoutSettings(getSettings());
    const now = new Date().toISOString();
    const job: MonitorJob = {
      id: crypto.randomUUID(), productName: input.productName.trim(), productUrl: input.productUrl,
      mode: input.mode, status: "running", createdAt: now, updatedAt: now,
      message: input.mode === "buy" ? "Monitorando para comprar automaticamente." : "Monitorando disponibilidade."
    };
    const controller = new AbortController();
    jobs.set(job.id, { job, controller });
    updateJob(job);
    addLog(job.message, "info", job.id);
    void (async () => {
      try {
        const config = buildConfig(job.productName);
        const bot = new GamerHutConnector(config, { signal: controller.signal, onLog: (message) => addLog(message, "info", job.id) });
        if (job.mode === "buy") {
          const pix = await bot.purchase();
          await notify(config, pix, app.getPath("userData"));
          job.message = `Compra concluida. Pedido ${pix.orderNumber}.`;
        } else {
          const product = await bot.monitor();
          job.message = `Disponivel: ${product.title}`;
        }
        job.status = "completed";
        addLog(job.message, "success", job.id);
      } catch (error) {
        const cancelled = controller.signal.aborted;
        job.status = cancelled ? "cancelled" : "failed";
        job.message = cancelled ? "Monitoramento cancelado." : error instanceof Error ? error.message : "Falha inesperada no monitoramento.";
        addLog(job.message, cancelled ? "info" : "error", job.id);
      } finally {
        updateJob(job);
      }
    })();
    return job;
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#101412",
    webPreferences: { preload: join(__dirname, "../preload/index.js"), contextIsolation: true, nodeIntegration: false }
  });
  if (process.env.ELECTRON_RENDERER_URL) window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else window.loadFile(join(__dirname, "../renderer/index.html"));
}

app.whenReady().then(() => {
  migrateConfigIni();
  registerIpc();
  createWindow();
  for (const item of watchItems().filter((item) => ["watching", "available", "purchasing"].includes(item.status))) startWatch(item.id);
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
