import { existsSync, readFileSync } from "node:fs";
import ini from "ini";

export type ShippingPreference = "mais_barato" | "mais_rapido";

export interface Config {
  store: { baseUrl: string; connector: string; headless: boolean };
  account: { email: string; password: string };
  product: { name: string; quantity: number; similarityThreshold: number };
  shipping: {
    recipientName: string; document: string; postalCode: string; street: string;
    number: string; complement: string; neighborhood: string; city: string;
    state: string; preference: ShippingPreference;
  };
  checkout: { paymentMethod: "pix"; autoFinalize: boolean };
  availability: { pollIntervalSeconds: number; timeoutMinutes: number };
  notification: {
    channel: "local" | "email" | "both"; smtpHost: string; smtpPort: number;
    smtpSecure: boolean; smtpUsername: string; smtpPassword: string; to: string;
  };
}

function value(section: Record<string, unknown>, key: string, required = true): string {
  const result = String(section[key] ?? "").trim();
  if (required && !result) throw new Error(`Campo obrigatorio ausente: ${key}`);
  return result;
}

function bool(raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Booleano invalido: ${raw}`);
}

export function loadConfig(file = "config.ini"): Config {
  if (!existsSync(file)) throw new Error(`Arquivo ${file} nao encontrado. Copie config.example.ini.`);
  const raw = ini.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  for (const section of ["store", "account", "product", "shipping", "checkout", "availability", "notification"]) {
    if (!raw[section]) throw new Error(`Secao [${section}] ausente em ${file}`);
  }
  const password = value(raw.account, "password");
  const preference = value(raw.shipping, "preference") as ShippingPreference;
  if (!(["mais_barato", "mais_rapido"] as string[]).includes(preference)) throw new Error("shipping.preference deve ser mais_barato ou mais_rapido.");
  const channel = value(raw.notification, "channel") as Config["notification"]["channel"];
  if (!(["local", "email", "both"] as string[]).includes(channel)) throw new Error("notification.channel deve ser local, email ou both.");
  const threshold = Number(value(raw.product, "similarity_threshold"));
  const quantity = Number(value(raw.product, "quantity"));
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error("product.quantity deve ser inteiro positivo.");
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("product.similarity_threshold deve estar entre 0 e 1.");
  const pollIntervalSeconds = Number(value(raw.availability, "poll_interval_seconds"));
  const timeoutMinutes = Number(value(raw.availability, "timeout_minutes"));
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds < 1) throw new Error("availability.poll_interval_seconds deve ser no minimo 1.");
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 0) throw new Error("availability.timeout_minutes deve ser zero ou positivo.");
  const smtpPassword = value(raw.notification, "smtp_password", false);
  if (channel !== "local" && (!value(raw.notification, "smtp_host", false) || !value(raw.notification, "to", false) || !smtpPassword)) {
    throw new Error("Configuracao SMTP incompleta para notificacao por e-mail.");
  }
  return {
    store: { baseUrl: value(raw.store, "base_url").replace(/\/$/, ""), connector: value(raw.store, "connector"), headless: bool(value(raw.store, "headless")) },
    account: { email: value(raw.account, "email"), password },
    product: { name: value(raw.product, "name"), quantity, similarityThreshold: threshold },
    shipping: { recipientName: value(raw.shipping, "recipient_name"), document: value(raw.shipping, "document"), postalCode: value(raw.shipping, "postal_code"), street: value(raw.shipping, "street"), number: value(raw.shipping, "number"), complement: value(raw.shipping, "complement", false), neighborhood: value(raw.shipping, "neighborhood"), city: value(raw.shipping, "city"), state: value(raw.shipping, "state") .toUpperCase(), preference },
    checkout: { paymentMethod: "pix", autoFinalize: bool(value(raw.checkout, "auto_finalize")) },
    availability: { pollIntervalSeconds, timeoutMinutes },
    notification: { channel, smtpHost: value(raw.notification, "smtp_host", false), smtpPort: Number(value(raw.notification, "smtp_port", false) || 587), smtpSecure: bool(value(raw.notification, "smtp_secure", false) || "false"), smtpUsername: value(raw.notification, "smtp_username", false), smtpPassword, to: value(raw.notification, "to", false) }
  };
}
