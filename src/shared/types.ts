export type ConnectionStatus = "connected" | "disconnected" | "checking";
export type BuyMode = "monitor" | "buy";
export type JobStatus = "running" | "completed" | "failed" | "cancelled";
export type WatchStatus = "watching" | "available" | "purchasing" | "manual" | "completed" | "paused" | "configuration" | "failed" | "expired";

export interface ShippingAddress {
  id: string;
  label: string;
  recipientName: string;
  document: string;
  postalCode: string;
  street: string;
  number: string;
  complement: string;
  neighborhood: string;
  city: string;
  state: string;
}

export interface AppSettings {
  store: { baseUrl: string; headless: boolean };
  account: { email: string };
  product: { quantity: number; similarityThreshold: number };
  addresses: ShippingAddress[];
  activeAddressId: string;
  shipping: { preference: "mais_barato" | "mais_rapido" };
  checkout: { autoFinalize: boolean };
  availability: { pollIntervalSeconds: number; timeoutMinutes: number };
  notification: {
    channel: "local" | "email" | "both";
    smtpHost: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUsername: string;
    to: string;
  };
}

export interface ProductCandidate { title: string; url: string; imageUrl?: string; price?: string; }

export interface MonitorJob {
  id: string;
  productName: string;
  productUrl?: string;
  mode: BuyMode;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  message: string;
}

export interface AppLog {
  id: string;
  createdAt: string;
  level: "info" | "success" | "error";
  message: string;
  jobId?: string;
}

export interface WatchItem {
  id: string;
  productName: string;
  productUrl: string;
  imageUrl?: string;
  mode: BuyMode;
  intervalSeconds: number;
  durationMinutes: number;
  status: WatchStatus;
  available: boolean;
  quantity?: number;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string;
  nextCheckAt?: string;
  availableAt?: string;
  availabilitySource?: string;
  purchaseAttempts?: number;
  message: string;
  pix?: { code: string; orderNumber: string; orderUrl: string };
}

export interface DesktopApi {
  settings: {
    get: () => Promise<AppSettings>;
    save: (settings: AppSettings, password?: string, smtpPassword?: string) => Promise<void>;
    hasPassword: () => Promise<boolean>;
  };
  store: { testConnection: () => Promise<ConnectionStatus> };
  buys: {
    search: (query: string) => Promise<ProductCandidate[]>;
    start: (input: { productName: string; productUrl?: string; mode: BuyMode }) => Promise<MonitorJob>;
    cancel: (jobId: string) => Promise<void>;
    list: () => Promise<MonitorJob[]>;
  };
  watchlist: {
    list: () => Promise<WatchItem[]>;
    add: (input: { productName: string; productUrl: string; imageUrl?: string; mode: BuyMode; intervalSeconds: number; durationMinutes: number }) => Promise<WatchItem>;
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
  };
  logs: { list: () => Promise<AppLog[]> };
  events: {
    onLog: (listener: (log: AppLog) => void) => () => void;
    onJob: (listener: (job: MonitorJob) => void) => () => void;
    onConnection: (listener: (status: ConnectionStatus) => void) => () => void;
    onWatch: (listener: (item: WatchItem) => void) => () => void;
  };
}
