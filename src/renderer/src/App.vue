<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { BellRing, CircleStop, Clock3, Copy, ExternalLink, History, LoaderCircle, MapPin, Pause, Pencil, Play, Plus, Search, Settings2, ShoppingBag, Trash2, UserRound, X } from "lucide-vue-next";
import Button from "./components/ui/button/Button.vue";
import type { AppLog, AppSettings, BuyMode, ConnectionStatus, MonitorJob, ProductCandidate, ShippingAddress, WatchItem } from "../../shared/types";

type Page = "buys" | "watchlist" | "logs" | "settings";
type SettingsTab = "account" | "addresses" | "automation" | "notifications";
const desktop = window.desktop;
const page = ref<Page>("buys");
const settingsTab = ref<SettingsTab>("account");
const connection = ref<ConnectionStatus>("disconnected");
const settings = reactive<AppSettings>({
  store: { baseUrl: "https://gamerhut.com.br", headless: false }, account: { email: "" }, product: { quantity: 1, similarityThreshold: .82 },
  addresses: [], activeAddressId: "", shipping: { preference: "mais_barato" }, checkout: { autoFinalize: true }, availability: { pollIntervalSeconds: 5, timeoutMinutes: 0 },
  notification: { channel: "local", smtpHost: "", smtpPort: 587, smtpSecure: false, smtpUsername: "", to: "" }
});
const password = ref("");
const smtpPassword = ref("");
const hasPassword = ref(false);
const query = ref("");
const searching = ref(false);
const results = ref<ProductCandidate[]>([]);
const jobs = ref<MonitorJob[]>([]);
const watchItems = ref<WatchItem[]>([]);
const queuedProduct = ref<ProductCandidate | null>(null);
const queuedMode = ref<BuyMode>("monitor");
const queuedInterval = ref(5);
const queuedDuration = ref(0);
const logs = ref<AppLog[]>([]);
const feedback = ref("");
const saving = ref(false);
const editingAddress = ref<ShippingAddress | null>(null);
let dispose: Array<() => void> = [];

const apiReady = computed(() => Boolean(desktop?.buys && desktop?.watchlist && desktop?.settings));
const activeAddress = computed(() => settings.addresses.find((address) => address.id === settings.activeAddressId));
const runningJobs = computed(() => jobs.value.filter((job) => job.status === "running"));
const statusText = computed(() => connection.value === "connected" ? "Conectado" : connection.value === "checking" ? "Conectando" : "Desconectado");
const statusClass = computed(() => connection.value === "connected" ? "bg-emerald-400" : connection.value === "checking" ? "bg-amber-400 animate-pulse" : "bg-zinc-600");

function blankAddress(): ShippingAddress { return { id: crypto.randomUUID(), label: "Novo endereco", recipientName: "", document: "", postalCode: "", street: "", number: "", complement: "", neighborhood: "", city: "", state: "SP" }; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function mergeSettings(next: AppSettings): void { Object.assign(settings.store, next.store); Object.assign(settings.account, next.account); Object.assign(settings.product, next.product); settings.addresses = next.addresses ?? []; settings.activeAddressId = next.activeAddressId ?? ""; Object.assign(settings.shipping, next.shipping); Object.assign(settings.checkout, next.checkout); Object.assign(settings.availability, next.availability); Object.assign(settings.notification, next.notification); }
function time(value: string): string { return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)); }
function upsertJob(job: MonitorJob): void { const index = jobs.value.findIndex((item) => item.id === job.id); if (index < 0) jobs.value = [job, ...jobs.value]; else jobs.value[index] = job; }
function upsertWatch(item: WatchItem): void { const index = watchItems.value.findIndex((current) => current.id === item.id); if (index < 0) watchItems.value = [item, ...watchItems.value]; else watchItems.value[index] = item; }
function showSettings(tab: SettingsTab): void { page.value = "settings"; settingsTab.value = tab; }

async function search(): Promise<void> {
  if (!desktop || !query.value.trim()) return;
  searching.value = true; feedback.value = "";
  try { results.value = await desktop.buys.search(query.value); if (!results.value.length) feedback.value = "Nenhum jogo encontrado."; }
  catch (error) { feedback.value = error instanceof Error ? error.message : "Falha ao buscar jogos."; }
  finally { searching.value = false; }
}
function queue(product: ProductCandidate, mode: BuyMode): void {
  queuedProduct.value = product; queuedMode.value = mode; queuedInterval.value = settings.availability.pollIntervalSeconds; queuedDuration.value = settings.availability.timeoutMinutes;
}
async function confirmQueue(): Promise<void> {
  if (!desktop || !queuedProduct.value) return;
  try { const item = await desktop.watchlist.add({ productName: queuedProduct.value.title, productUrl: queuedProduct.value.url, imageUrl: queuedProduct.value.imageUrl, mode: queuedMode.value, intervalSeconds: queuedInterval.value, durationMinutes: queuedDuration.value }); upsertWatch(item); queuedProduct.value = null; page.value = "watchlist"; }
  catch (error) { feedback.value = error instanceof Error ? error.message : "Nao foi possivel adicionar a Watchlist."; }
}
async function pauseWatch(item: WatchItem): Promise<void> { await desktop?.watchlist.pause(item.id); }
async function resumeWatch(item: WatchItem): Promise<void> { await desktop?.watchlist.resume(item.id); }
async function removeWatch(item: WatchItem): Promise<void> { await desktop?.watchlist.remove(item.id); watchItems.value = watchItems.value.filter((current) => current.id !== item.id); }
async function copyPix(item: WatchItem): Promise<void> { if (item.pix) await navigator.clipboard.writeText(item.pix.code); }
async function saveSettings(): Promise<void> {
  if (!desktop) return;
  saving.value = true; feedback.value = "";
  try { await desktop.settings.save(clone(settings), password.value || undefined, smtpPassword.value || undefined); if (password.value) { hasPassword.value = true; password.value = ""; } smtpPassword.value = ""; feedback.value = "Configuracoes salvas."; }
  catch (error) { feedback.value = error instanceof Error ? error.message : "Falha ao salvar as configuracoes."; }
  finally { saving.value = false; }
}
async function testConnection(): Promise<void> { if (desktop) { connection.value = "checking"; await desktop.store.testConnection(); } }
function editAddress(address?: ShippingAddress): void { editingAddress.value = clone(address ?? blankAddress()); }
function saveAddress(): void {
  if (!editingAddress.value) return;
  const address = clone(editingAddress.value);
  const index = settings.addresses.findIndex((item) => item.id === address.id);
  if (index < 0) settings.addresses.push(address); else settings.addresses[index] = address;
  if (!settings.activeAddressId) settings.activeAddressId = address.id;
  editingAddress.value = null;
}
function removeAddress(id: string): void { settings.addresses = settings.addresses.filter((address) => address.id !== id); if (settings.activeAddressId === id) settings.activeAddressId = settings.addresses[0]?.id ?? ""; }

onMounted(async () => {
  if (!desktop) { feedback.value = "A ponte segura do Electron nao foi carregada. Feche o app e execute npm run dev novamente."; return; }
  const [stored, storedJobs, storedLogs, savedPassword, storedWatchItems] = await Promise.all([desktop.settings.get(), desktop.buys.list(), desktop.logs.list(), desktop.settings.hasPassword(), desktop.watchlist.list()]);
  mergeSettings(stored); jobs.value = storedJobs; logs.value = storedLogs; hasPassword.value = savedPassword; watchItems.value = storedWatchItems;
  dispose = [desktop.events.onLog((log) => { logs.value = [...logs.value.slice(-499), log]; }), desktop.events.onJob(upsertJob), desktop.events.onConnection((status) => { connection.value = status; }), desktop.events.onWatch(upsertWatch)];
});
onUnmounted(() => dispose.forEach((off) => off()));
</script>

<template>
  <main class="min-h-screen bg-[#111411] text-zinc-100">
    <div class="mx-auto flex min-h-screen max-w-[1440px]">
      <aside class="flex w-[68px] shrink-0 flex-col border-r border-zinc-800 bg-[#0d100e] p-3 md:w-52">
        <div class="mb-8 flex items-center gap-2 px-1"><img src="https://thumbs.dreamstime.com/b/detective-icon-flat-vector-symbolizing-mystery-investigation-crime-analytical-thinking-381148429.jpg" alt="Scalper" class="size-8 rounded-lg object-cover" /><span class="hidden text-xs font-bold tracking-[.2em] text-lime-300 md:block">SCALPER</span></div>
        <nav class="space-y-1"><button v-for="item in [{ id: 'buys', label: 'Buys', icon: ShoppingBag }, { id: 'watchlist', label: 'Watchlist', icon: BellRing }, { id: 'logs', label: 'Logs', icon: History }, { id: 'settings', label: 'Settings', icon: Settings2 }]" :key="item.id" class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition" :class="page === item.id ? 'bg-lime-400 text-zinc-950' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'" @click="page = item.id as Page"><component :is="item.icon" class="size-4" /><span class="hidden md:inline">{{ item.label }}</span></button></nav>
      </aside>

      <section class="min-w-0 flex-1 overflow-y-auto">
        <header class="flex h-16 items-center justify-between border-b border-zinc-800 px-5 md:px-8"><div><p class="text-[10px] font-medium uppercase tracking-[.18em] text-lime-300">Gamer Hut</p><h1 class="text-base font-semibold">{{ page === 'buys' ? 'Comprar e monitorar' : page === 'watchlist' ? 'Watchlist' : page === 'logs' ? 'Logs' : 'Settings' }}</h1></div><span v-if="page === 'buys' && activeAddress" class="hidden items-center gap-1.5 text-xs text-zinc-400 sm:flex"><MapPin class="size-3.5 text-lime-300" />{{ activeAddress.label }}</span></header>
        <div v-if="feedback" class="mx-5 mt-4 rounded-md border border-lime-400/30 bg-lime-400/10 px-3 py-2 text-sm text-lime-100 md:mx-8">{{ feedback }}</div>
        <div v-if="!apiReady" class="p-5 md:p-8"><div class="max-w-lg rounded-lg border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">A API do Electron nao esta disponivel. Reinicie o modo de desenvolvimento para recarregar o preload.</div></div>

        <div v-else-if="page === 'buys'" class="space-y-5 p-5 md:p-8">
          <section class="rounded-lg border border-zinc-800 bg-[#151a16] p-4"><div class="mb-3"><h2 class="text-sm font-semibold">Buscar jogos</h2><p class="mt-0.5 text-xs text-zinc-500">A busca e publica e nao exige login.</p></div><form class="flex gap-2" @submit.prevent="search"><input v-model="query" placeholder="Pokemon, PS5, Switch..." class="control min-w-0 flex-1" /><Button size="sm" :disabled="searching"><LoaderCircle v-if="searching" class="size-3.5 animate-spin" /><Search v-else class="size-3.5" />Buscar</Button></form></section>
          <section v-if="results.length"><div class="mb-3 flex items-center justify-between"><h2 class="text-sm font-semibold">Resultados</h2><span class="text-xs text-zinc-500">{{ results.length }} jogos</span></div><div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"><article v-for="product in results" :key="product.url" class="group overflow-hidden rounded-lg border border-zinc-800 bg-[#151a16] transition hover:border-lime-400/50"><a :href="product.url" target="_blank" class="block aspect-[4/3] overflow-hidden bg-zinc-900"><img v-if="product.imageUrl" :src="product.imageUrl" :alt="product.title" class="size-full object-contain p-3 transition duration-300 group-hover:scale-105" /><div v-else class="grid size-full place-items-center text-xs font-medium text-zinc-600">Sem imagem</div></a><div class="p-3"><a :href="product.url" target="_blank" class="block min-h-10 text-sm font-semibold leading-5 hover:text-lime-300">{{ product.title }}</a><p class="mt-1 text-base font-bold text-lime-300">{{ product.price ?? 'Preco indisponivel' }}</p><div class="mt-3 flex gap-2"><Button variant="outline" size="sm" class="flex-1" @click="queue(product, 'monitor')"><BellRing class="size-3.5" />Monitorar</Button><Button size="sm" class="flex-1" @click="queue(product, 'buy')"><ShoppingBag class="size-3.5" />Comprar</Button></div></div></article></div></section>
        </div>

        <div v-else-if="page === 'watchlist'" class="p-5 md:p-8"><div v-if="!watchItems.length" class="rounded-lg border border-dashed border-zinc-700 p-10 text-center"><BellRing class="mx-auto size-6 text-zinc-600" /><p class="mt-3 text-sm font-medium">Sua Watchlist esta vazia.</p><p class="mt-1 text-xs text-zinc-500">Busque um jogo em Buys para acompanhar estoque ou comprar automaticamente.</p></div><div v-else class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><article v-for="item in watchItems" :key="item.id" class="flex h-[202px] flex-col overflow-hidden rounded-lg border bg-[#151a16] transition" :class="item.available ? 'border-lime-400 shadow-[0_0_18px_rgba(190,242,100,.2)] animate-[pulse_2s_ease-in-out_infinite]' : 'border-zinc-800'"><div class="flex h-[124px] gap-3 p-3"><div class="grid h-[96px] w-[72px] shrink-0 place-items-center overflow-hidden rounded-md bg-zinc-950"><img v-if="item.imageUrl" :src="item.imageUrl" :alt="item.productName" class="size-full object-contain p-1" /><ShoppingBag v-else class="size-5 text-zinc-600" /></div><div class="flex h-[96px] min-w-0 flex-1 flex-col"><div class="flex items-start justify-between gap-2"><p class="line-clamp-2 text-sm font-semibold leading-5">{{ item.productName }}</p><span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase" :class="item.available ? 'bg-lime-400 text-zinc-950' : item.status === 'completed' ? 'bg-emerald-400 text-zinc-950' : item.status === 'manual' ? 'bg-amber-400/20 text-amber-300' : item.status === 'failed' || item.status === 'configuration' ? 'bg-rose-400/20 text-rose-300' : 'bg-zinc-800 text-zinc-400'">{{ item.status === 'available' ? 'Disponivel' : item.status === 'watching' ? 'Monitorando' : item.status === 'purchasing' ? 'Comprando' : item.status === 'manual' ? 'Acao manual' : item.status }}</span></div><p class="mt-1 line-clamp-2 min-h-8 text-xs text-zinc-500">{{ item.message }}</p><div class="mt-auto flex items-center gap-3 text-[11px] text-zinc-500"><span class="flex items-center gap-1"><Clock3 class="size-3" />{{ item.intervalSeconds }}s</span><span v-if="item.quantity !== undefined">{{ item.quantity }} unidades</span><span v-else>{{ item.available ? 'Disponivel' : 'Sem estoque' }}</span></div></div></div><div class="mt-auto h-[78px] border-t border-zinc-800 px-3 py-2"><p v-if="item.status === 'manual'" class="mb-2 line-clamp-2 rounded bg-amber-400/10 px-2 py-1 text-[11px] text-amber-200">Conclua o reCAPTCHA e clique em Finalizar compra no navegador aberto.</p><p v-else class="h-4 truncate text-[11px] text-zinc-500">{{ item.nextCheckAt ? `Proxima consulta: ${time(item.nextCheckAt)}${item.durationMinutes ? ` · limite ${item.durationMinutes} min` : ''}` : 'Sem proxima consulta' }}<span v-if="item.purchaseAttempts"> · {{ item.purchaseAttempts }} tentativa(s)</span></p><div v-if="item.pix" class="mt-2 flex items-center justify-between gap-2"><span class="truncate text-xs text-emerald-300">PIX do pedido {{ item.pix.orderNumber }}</span><div class="flex gap-1"><Button size="sm" variant="outline" @click="copyPix(item)"><Copy class="size-3.5" />Copiar PIX</Button><a :href="item.pix.orderUrl" target="_blank"><Button size="sm" variant="ghost"><ExternalLink class="size-3.5" /></Button></a></div></div><div v-else class="mt-2 flex justify-end gap-1"><Button v-if="['watching', 'available', 'purchasing', 'manual'].includes(item.status)" size="sm" variant="outline" @click="pauseWatch(item)"><Pause class="size-3.5" />Pausar</Button><Button v-else-if="item.status !== 'completed'" size="sm" variant="outline" @click="resumeWatch(item)"><Play class="size-3.5" />Retomar</Button><Button size="sm" variant="ghost" @click="removeWatch(item)"><Trash2 class="size-3.5" /></Button></div></div></article></div></div>

        <div v-else-if="page === 'logs'" class="p-5 md:p-8"><section class="overflow-hidden rounded-lg border border-zinc-800"><div v-if="!logs.length" class="p-10 text-center text-sm text-zinc-500">Nenhum evento nesta sessao.</div><div v-for="log in [...logs].reverse()" :key="log.id" class="grid grid-cols-[62px_8px_1fr] gap-3 border-b border-zinc-800 px-4 py-3 text-sm last:border-0"><span class="font-mono text-[11px] text-zinc-500">{{ time(log.createdAt) }}</span><span class="mt-1 size-2 rounded-full" :class="log.level === 'success' ? 'bg-emerald-400' : log.level === 'error' ? 'bg-rose-400' : 'bg-lime-300'" /><span class="text-zinc-300">{{ log.message }}</span></div></section></div>

        <form v-else class="max-w-4xl p-5 md:p-8" @submit.prevent="saveSettings">
          <TabsRoot v-model="settingsTab" class="space-y-5"><TabsList class="flex w-full overflow-x-auto rounded-md border border-zinc-800 bg-[#151a16] p-1"><TabsTrigger v-for="tab in [{ id: 'account', label: 'Conta' }, { id: 'addresses', label: 'Enderecos' }, { id: 'automation', label: 'Automacao' }, { id: 'notifications', label: 'Notificacoes' }]" :key="tab.id" :value="tab.id" class="shadcn-tab">{{ tab.label }}</TabsTrigger></TabsList>
            <TabsContent value="account" class="panel"><div class="mb-4 flex items-start justify-between"><div><h2 class="text-sm font-semibold">Conta Gamer Hut</h2><p class="mt-0.5 text-xs text-zinc-500">A conexao e usada apenas para monitorar e comprar.</p></div><span class="flex items-center gap-1.5 text-xs text-zinc-400"><span class="size-2 rounded-full" :class="statusClass" />{{ statusText }}</span></div><div class="grid gap-3 sm:grid-cols-2"><label class="field">E-mail<input v-model="settings.account.email" class="control" type="email" /></label><label class="field">Senha <span class="normal-case text-zinc-500">{{ hasPassword ? '(salva no cofre)' : '' }}</span><input v-model="password" class="control" type="password" :placeholder="hasPassword ? 'Deixe em branco para manter' : 'Senha da loja'" /></label><label class="field">URL da loja<input v-model="settings.store.baseUrl" class="control" type="url" /></label><label class="flex items-center gap-2 pt-5 text-sm text-zinc-300"><input v-model="settings.store.headless" type="checkbox" class="size-4 accent-lime-400" />Executar navegador em segundo plano</label></div><Button type="button" size="sm" variant="outline" class="mt-4" @click="testConnection"><LoaderCircle v-if="connection === 'checking'" class="size-3.5 animate-spin" /><UserRound v-else class="size-3.5" />Testar conexao</Button></TabsContent>
            <TabsContent value="addresses" class="panel"><div class="mb-4 flex items-center justify-between"><div><h2 class="text-sm font-semibold">Enderecos</h2><p class="mt-0.5 text-xs text-zinc-500">O endereco ativo sera usado no checkout.</p></div><Button type="button" size="sm" @click="editAddress()"><Plus class="size-3.5" />Adicionar</Button></div><div v-if="!settings.addresses.length" class="rounded-md border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">Nenhum endereco cadastrado.</div><div v-for="address in settings.addresses" :key="address.id" class="flex items-center justify-between gap-3 border-t border-zinc-800 py-3 first:border-0"><button type="button" class="min-w-0 text-left" @click="settings.activeAddressId = address.id"><p class="flex items-center gap-2 text-sm font-medium"><span class="size-2 rounded-full" :class="address.id === settings.activeAddressId ? 'bg-lime-300' : 'bg-zinc-600'" />{{ address.label }}</p><p class="mt-0.5 truncate text-xs text-zinc-500">{{ address.street }}, {{ address.number }} - {{ address.city }}/{{ address.state }}</p></button><div class="flex gap-1"><Button type="button" size="sm" variant="ghost" @click="editAddress(address)"><Pencil class="size-3.5" /></Button><Button type="button" size="sm" variant="ghost" @click="removeAddress(address.id)"><Trash2 class="size-3.5" /></Button></div></div><div v-if="editingAddress" class="mt-5 rounded-md border border-lime-400/30 bg-lime-400/5 p-4"><div class="mb-3 flex items-center justify-between"><h3 class="text-sm font-semibold">{{ settings.addresses.some((item) => item.id === editingAddress?.id) ? 'Editar endereco' : 'Novo endereco' }}</h3><Button type="button" size="sm" variant="ghost" @click="editingAddress = null">Cancelar</Button></div><div class="grid gap-3 sm:grid-cols-2"><label class="field">Nome<input v-model="editingAddress.label" class="control" placeholder="Casa, trabalho..." /></label><label class="field">Nome completo<input v-model="editingAddress.recipientName" class="control" /></label><label class="field">CPF<input v-model="editingAddress.document" class="control" /></label><label class="field">CEP<input v-model="editingAddress.postalCode" class="control" /></label><label class="field sm:col-span-2">Endereco<input v-model="editingAddress.street" class="control" /></label><label class="field">Numero<input v-model="editingAddress.number" class="control" /></label><label class="field">Complemento<input v-model="editingAddress.complement" class="control" /></label><label class="field">Bairro<input v-model="editingAddress.neighborhood" class="control" /></label><label class="field">Cidade<input v-model="editingAddress.city" class="control" /></label><label class="field">Estado<input v-model="editingAddress.state" class="control" maxlength="2" /></label></div><Button type="button" size="sm" class="mt-4" @click="saveAddress">Salvar endereco</Button></div></TabsContent>
            <TabsContent value="automation" class="panel"><h2 class="mb-4 text-sm font-semibold">Automacao</h2><div class="grid gap-3 sm:grid-cols-2"><label class="field">Intervalo em segundos<input v-model.number="settings.availability.pollIntervalSeconds" class="control" type="number" min="1" /></label><label class="field">Timeout em minutos<input v-model.number="settings.availability.timeoutMinutes" class="control" type="number" min="0" /><span class="normal-case text-zinc-500">Zero monitora sem prazo.</span></label><label class="field">Quantidade<input v-model.number="settings.product.quantity" class="control" type="number" min="1" /></label><label class="field">Similaridade minima<input v-model.number="settings.product.similarityThreshold" class="control" type="number" min="0" max="1" step=".01" /></label><label class="field">Frete<select v-model="settings.shipping.preference" class="control"><option value="mais_barato">Mais barato</option><option value="mais_rapido">Mais rapido</option></select></label><label class="flex items-center gap-2 pt-5 text-sm text-zinc-300"><input v-model="settings.checkout.autoFinalize" type="checkbox" class="size-4 accent-lime-400" />Finalizar PIX automaticamente</label></div></TabsContent>
            <TabsContent value="notifications" class="panel"><h2 class="mb-1 text-sm font-semibold">Notificacoes</h2><p class="mb-4 text-xs text-zinc-500">Pedidos tambem ficam salvos localmente.</p><div class="grid gap-3 sm:grid-cols-2"><label class="field">Canal<select v-model="settings.notification.channel" class="control"><option value="local">Somente local</option><option value="email">E-mail</option><option value="both">Local e e-mail</option></select></label><label class="field">Servidor SMTP<input v-model="settings.notification.smtpHost" class="control" :disabled="settings.notification.channel === 'local'" /></label><label class="field">Porta<input v-model.number="settings.notification.smtpPort" class="control" :disabled="settings.notification.channel === 'local'" type="number" min="1" /></label><label class="field">Usuario SMTP<input v-model="settings.notification.smtpUsername" class="control" :disabled="settings.notification.channel === 'local'" /></label><label class="field">Senha SMTP<input v-model="smtpPassword" class="control" :disabled="settings.notification.channel === 'local'" type="password" placeholder="Deixe em branco para manter" /></label><label class="field">Destinatario<input v-model="settings.notification.to" class="control" :disabled="settings.notification.channel === 'local'" type="email" /></label><label class="flex items-center gap-2 text-sm text-zinc-300"><input v-model="settings.notification.smtpSecure" :disabled="settings.notification.channel === 'local'" type="checkbox" class="size-4 accent-lime-400" />SMTP seguro (SSL/TLS)</label></div></TabsContent>
          </TabsRoot><div class="mt-5 flex justify-end"><Button :disabled="saving"><LoaderCircle v-if="saving" class="size-3.5 animate-spin" />Salvar configuracoes</Button></div>
        </form>
      </section>
    </div>
  </main>
  <div v-if="queuedProduct" class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" @click.self="queuedProduct = null"><section class="w-full max-w-md rounded-lg border border-zinc-700 bg-[#151a16] p-5 shadow-2xl"><div class="flex items-start justify-between gap-4"><div><p class="text-[10px] font-bold uppercase tracking-[.16em] text-lime-300">{{ queuedMode === 'buy' ? 'Compra automatica' : 'Monitoramento' }}</p><h2 class="mt-1 text-sm font-semibold">{{ queuedProduct.title }}</h2></div><Button size="sm" variant="ghost" @click="queuedProduct = null"><X class="size-4" /></Button></div><p class="mt-3 text-xs text-zinc-500">{{ queuedMode === 'buy' ? 'Quando houver estoque, o checkout sera preenchido, finalizado e o PIX sera mostrado na Watchlist.' : 'A Watchlist continuara verificando mesmo depois de encontrar estoque.' }}</p><div class="mt-4 grid gap-3 sm:grid-cols-2"><label class="field">Verificar a cada (segundos)<input v-model.number="queuedInterval" class="control" type="number" min="1" /></label><label class="field">Monitorar por (minutos)<input v-model.number="queuedDuration" class="control" type="number" min="0" /><span class="normal-case text-zinc-500">Zero = sem limite</span></label></div><div class="mt-5 flex justify-end gap-2"><Button variant="outline" @click="queuedProduct = null">Cancelar</Button><Button @click="confirmQueue"><BellRing class="size-3.5" />Adicionar a Watchlist</Button></div></section></div>
</template>

<style scoped>
.control { height: 2.25rem; width: 100%; border: 1px solid #3f3f46; border-radius: .375rem; background: #181b19; padding: 0 .65rem; color: #f4f4f5; font-size: .875rem; outline: none; }
.control:focus { border-color: #bef264; box-shadow: 0 0 0 1px #bef264; }
.control:disabled { cursor: not-allowed; opacity: .45; }
.field { display: flex; flex-direction: column; gap: .4rem; color: #a1a1aa; font-size: .68rem; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.panel { border: 1px solid #27272a; border-radius: .5rem; background: #151a16; padding: 1rem; }
.shadcn-tab { flex: 1; white-space: nowrap; border-radius: .25rem; padding: .45rem .7rem; color: #a1a1aa; font-size: .75rem; font-weight: 500; outline: none; }
.shadcn-tab[data-state="active"] { background: #bef264; color: #18181b; }
</style>
