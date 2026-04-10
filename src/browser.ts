import { chromium, type Browser, type Page } from "playwright-core";

const CDP_URL = "http://localhost:9222";

export type RefInfo = { role: string; name?: string; nth?: number };
export type RefMap = Record<string, RefInfo>;

interface TabState {
  refs: RefMap;
}

// Global state
let browser: Browser | null = null;
let connecting: Promise<Browser> | null = null;
const tabStates = new Map<string, TabState>();

// ── Connection ──────────────────────────────────────────────────────────

async function getWebSocketUrl(): Promise<string> {
  const resp = await fetch(`${CDP_URL}/json/version`);
  const info = (await resp.json()) as { webSocketDebuggerUrl: string };
  return info.webSocketDebuggerUrl;
}

export async function connect(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  if (connecting) return connecting;

  connecting = (async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const timeout = 5000 + attempt * 2000;
        let endpoint: string;
        try {
          endpoint = await getWebSocketUrl();
        } catch {
          endpoint = CDP_URL;
        }
        const b = await chromium.connectOverCDP(endpoint, { timeout });
        b.on("disconnected", () => {
          if (browser === b) browser = null;
        });
        browser = b;
        return b;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 250 + attempt * 250));
      }
    }
    throw lastErr;
  })().finally(() => {
    connecting = null;
  });

  return connecting;
}

// ── Page / Tab helpers ──────────────────────────────────────────────────

async function getAllPages(b: Browser): Promise<Page[]> {
  const pages: Page[] = [];
  for (const ctx of b.contexts()) {
    pages.push(...ctx.pages());
  }
  return pages;
}

export async function getTargetId(page: Page): Promise<string> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const info = await session.send("Target.getTargetInfo");
      return (info as any).targetInfo?.targetId ?? "";
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    return "";
  }
}

export async function getActivePage(targetId?: string): Promise<Page> {
  const b = await connect();
  const pages = await getAllPages(b);
  if (!pages.length) throw new Error("No pages available in the connected browser.");

  if (!targetId) return pages[0]!;

  for (const page of pages) {
    const tid = await getTargetId(page);
    if (tid === targetId) return page;
  }

  throw new Error(`Tab not found: ${targetId}. Use list_tabs to see available tabs.`);
}

export async function listAllTabs(): Promise<
  { targetId: string; url: string; title: string }[]
> {
  const b = await connect();
  const pages = await getAllPages(b);
  const tabs: { targetId: string; url: string; title: string }[] = [];

  for (const page of pages) {
    const targetId = await getTargetId(page);
    tabs.push({ targetId, url: page.url(), title: await page.title() });
  }
  return tabs;
}

export async function newTab(url: string): Promise<Page> {
  const b = await connect();
  const ctx = b.contexts()[0];
  if (!ctx) throw new Error("No browser context available.");
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return page;
}

// ── Ref state ───────────────────────────────────────────────────────────

export function storeRefs(targetId: string, refs: RefMap): void {
  tabStates.set(targetId, { refs });
}

export function getRefs(targetId: string): RefMap | undefined {
  return tabStates.get(targetId)?.refs;
}

export function clearRefs(targetId: string): void {
  tabStates.delete(targetId);
}

// ── Ref → Locator resolution ────────────────────────────────────────────

export function resolveRef(page: Page, ref: string, targetId: string) {
  const normalized = ref.replace(/^(ref=|@)/, "");
  const refs = getRefs(targetId);
  if (!refs?.[normalized]) {
    throw new Error(
      `Unknown ref "${normalized}". Run snapshot first to get element refs.`
    );
  }
  const info = refs[normalized]!;
  let locator = info.name
    ? page.getByRole(info.role as any, { name: info.name, exact: true })
    : page.getByRole(info.role as any);
  if (info.nth !== undefined) locator = locator.nth(info.nth);
  return locator;
}

export function resolveElement(
  page: Page,
  targetId: string,
  opts: { ref?: string; text?: string }
) {
  if (opts.ref) return resolveRef(page, opts.ref, targetId);
  if (opts.text) {
    return page
      .getByRole("button", { name: opts.text })
      .or(page.getByRole("link", { name: opts.text }))
      .or(page.getByRole("textbox", { name: opts.text }))
      .or(page.getByLabel(opts.text))
      .or(page.getByPlaceholder(opts.text))
      .or(page.getByText(opts.text, { exact: true }));
  }
  throw new Error("Either ref or text must be provided.");
}

// ── Error helpers ───────────────────────────────────────────────────────

export function friendlyError(err: unknown, label: string): Error {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("strict mode violation")) {
    const m = msg.match(/resolved to (\d+) elements/);
    return new Error(
      `"${label}" matched ${m?.[1] ?? "multiple"} elements. Run snapshot for updated refs.`
    );
  }
  if (msg.includes("Timeout") || msg.includes("waiting for")) {
    return new Error(
      `Element "${label}" not found or not visible. Run snapshot to see current elements.`
    );
  }
  if (msg.includes("intercepts pointer") || msg.includes("not visible")) {
    return new Error(
      `Element "${label}" not interactable. Try scrolling or closing overlays.`
    );
  }
  return err instanceof Error ? err : new Error(msg);
}
