import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import type { Config } from "./config.js";

export interface PixResult { code: string; orderUrl: string; screenshot?: Buffer; }

export interface CompletedOrder extends PixResult { orderNumber: string; storeName: string; }

function safeFilePart(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "desconhecido";
}

export async function notify(config: Config, pix: CompletedOrder): Promise<void> {
  mkdirSync("output", { recursive: true });
  mkdirSync("orders", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const text = `PIX copia e cola\n\n${pix.code}\n\nPedido: ${pix.orderUrl}\n`;
  const orderPath = join("orders", `${safeFilePart(pix.storeName)}-${safeFilePart(pix.orderNumber)}.txt`);
  writeFileSync(orderPath, text, { encoding: "utf8", mode: 0o600 });
  const textPath = join("output", `pix-${stamp}.txt`);
  writeFileSync(textPath, text, { encoding: "utf8", mode: 0o600 });
  if (pix.screenshot) writeFileSync(join("output", `pix-${stamp}.png`), pix.screenshot, { mode: 0o600 });
  console.log(`PIX salvo em ${orderPath}`);
  if (config.notification.channel === "local") return;
  const transport = nodemailer.createTransport({
    host: config.notification.smtpHost,
    port: config.notification.smtpPort,
    secure: config.notification.smtpSecure,
    auth: { user: config.notification.smtpUsername, pass: config.notification.smtpPassword }
  });
  await transport.sendMail({
    from: config.notification.smtpUsername,
    to: config.notification.to,
    subject: "PIX gerado pelo Scalper Bot",
    text,
    attachments: pix.screenshot ? [{ filename: "pix-qrcode.png", content: pix.screenshot }] : []
  });
  console.log("PIX enviado por e-mail.");
}
