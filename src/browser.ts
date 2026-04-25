import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";

// ── Configuration (read once at module load) ────────────────────────────
//
// Environment variables (all optional):
//   CDP_URL              Full URL to an existing Chrome DevTools endpoint.
//                        Wins over CHROME_PORT if set. Default derived from
//                        CHROME_PORT.
//   CHROME_PORT          Port for the CDP endpoint when constructing
//                        CDP_URL automatically. Default 9222.
//   CHROME_BIN           Chrome/Chromium binary to launch. Auto-detected
//                        from common paths if unset.
//   CHROME_PROFILE_DIR   --user-data-dir value. Required when CHROME_AUTOLAUNCH
//                        is true. The directory is created if missing.
//   CHROME_AUTOLAUNCH    "true"/"1" enables: when the CDP endpoint is dead
//                        on connect, browser-mcp spawns Chrome itself with
//                        the configured port + profile, detached, surviving
//                        browser-mcp lifecycle. Default false.
//   CHROME_EXTRA_ARGS    Space-separated extra flags appended to the launch.
//                        Useful for headless, kiosk, etc.
//
const CHROME_PORT = parseInt(process.env.CHROME_PORT ?? "9222", 10);
const CDP_URL = process.env.CDP_URL ?? `http://localhost:${CHROME_PORT}`;
const CHROME_AUTOLAUNCH =
  process.env.CHROME_AUTOLAUNCH === "true" || process.env.CHROME_AUTOLAUNCH === "1";
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR;
const CHROME_BIN = process.env.CHROME_BIN ?? findChromeBinary();
const CHROME_EXTRA_ARGS = (process.env.CHROME_EXTRA_ARGS ?? "")
  .split(/\s+/)
  .filter(Boolean);

function findChromeBinary(): string {
  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return "google-chrome"; // hope it's on PATH
}

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

async function isCdpReachable(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    const resp = await fetch(`${CDP_URL}/json/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn Chrome with the configured profile + port, detached so it outlives
 * browser-mcp. We don't track the child PID — Chrome owns its own lifecycle
 * once spawned. Subsequent browser-mcp restarts simply reattach to the
 * already-running browser via CDP.
 */
async function autolaunchChrome(): Promise<void> {
  if (!CHROME_PROFILE_DIR) {
    throw new Error(
      "CHROME_AUTOLAUNCH is set but CHROME_PROFILE_DIR is not. " +
        "Set CHROME_PROFILE_DIR to a writable directory.",
    );
  }
  if (!existsSync(CHROME_PROFILE_DIR)) {
    mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
  }
  const args = [
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${CHROME_PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI",
    ...CHROME_EXTRA_ARGS,
  ];

  console.error(
    `[browser-mcp] autolaunching Chrome on :${CHROME_PORT} with profile ${CHROME_PROFILE_DIR}`,
  );

  // setsid (Linux) / nohup-equivalent: detach from parent so Chrome
  // survives browser-mcp restarts. On macOS, `setsid` exists via brew or
  // the binary itself can be detached with stdio: 'ignore' + unref.
  const child = spawn(CHROME_BIN, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Poll until the CDP endpoint is reachable, max ~10s.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await isCdpReachable()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Chrome was launched but its CDP endpoint at ${CDP_URL} did not come up within 10s`,
  );
}

export async function connect(): Promise<Browser> {
  if (browser?.isConnected()) return browser;

  if (connecting) return connecting;

  connecting = (async () => {
    // Optional autolaunch: if Chrome isn't reachable and we're configured
    // to manage it, spawn it before we try to connect.
    if (CHROME_AUTOLAUNCH && !(await isCdpReachable())) {
      try {
        await autolaunchChrome();
      } catch (err) {
        console.error("[browser-mcp] autolaunch failed:", err);
        // Fall through — connect attempt below will produce the user-facing
        // error if we still can't reach CDP.
      }
    }

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
