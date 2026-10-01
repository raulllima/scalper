import type { AppSettings } from "./types.js";

export const defaultSettings: AppSettings = {
  store: { baseUrl: "https://gamerhut.com.br", headless: false },
  account: { email: "" },
  product: { quantity: 1, similarityThreshold: 0.82 },
  addresses: [],
  activeAddressId: "",
  shipping: { preference: "mais_barato" },
  checkout: { autoFinalize: true },
  availability: { pollIntervalSeconds: 5, timeoutMinutes: 0 },
  notification: { channel: "local", smtpHost: "", smtpPort: 587, smtpSecure: false, smtpUsername: "", to: "" }
};
