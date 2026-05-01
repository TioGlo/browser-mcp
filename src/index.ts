import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  connect,
  getActivePage,
  getTargetId,
  listAllTabs,
  newTab,
  storeRefs,
  resolveRef,
  resolveElement,
  friendlyError,
} from "./browser.js";
import { buildSnapshot } from "./snapshot.js";

const SCREENSHOT_DIR = path.join(
  process.env.HOME ?? "~",
  ".assistant/workspace/screenshots"
);

// Snapshot-economy guidance loaded into context for every browser-mcp
// consumer. Instagram/Gmail/X snapshots routinely hit 5-20K tokens, so
// steering callers toward `evaluate` and `screenshot` when appropriate
// pays for this fixed overhead many times over.
const INSTRUCTIONS = `browser-mcp usage guidance:

Snapshot economy — these tools vary by ~100x in token cost. Pick wisely:

- Prefer \`evaluate\` (run JS to query a specific element) when you know what you're looking for. Returns ~50-500 tokens vs \`snapshot\`'s 5-20K+. Use for "click this button," "read this text," "is this visible?"

- Use \`screenshot\` for visual verification ("what does this page look like?"), not \`snapshot\`. Single multimodal payload, not paginated text.

- \`snapshot\` only on first arrival to a page; operate on returned refs across subsequent clicks rather than re-snapshotting after every action. The refs stay valid until navigation.

- Dense apps (Instagram, Gmail, X, LinkedIn) routinely produce 8K+ snapshots — that's the baseline, not the worst case. Profile pages, notification feeds, and DM threads are the worst offenders.

When unsure, ask: "do I already know what I'm looking for?" If yes, \`evaluate\` or click on a known ref. If no, \`snapshot\` once, then operate on refs.`;

const server = new McpServer({
  name: "browser-mcp",
  version: "1.0.0",
}, {
  instructions: INSTRUCTIONS,
});

// ── 1. navigate ─────────────────────────────────────────────────────────

server.tool(
  "navigate",
  "Navigate to a URL or go back/forward/reload",
  {
    url: z.string().optional().describe("URL to navigate to"),
    action: z
      .enum(["back", "forward", "reload"])
      .optional()
      .describe("Navigation action instead of URL"),
  },
  async ({ url, action }) => {
    const page = await getActivePage();

    if (action === "back") await page.goBack({ timeout: 30000 });
    else if (action === "forward") await page.goForward({ timeout: 30000 });
    else if (action === "reload")
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    else if (url)
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    else return { content: [{ type: "text" as const, text: "Provide url or action." }] };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            url: page.url(),
            title: await page.title(),
          }),
        },
      ],
    };
  }
);

// ── 2. snapshot ─────────────────────────────────────────────────────────

server.tool(
  "snapshot",
  "Get current page as compact accessibility tree with stable element refs (e1, e2, ...)",
  {
    selector: z
      .string()
      .optional()
      .describe("CSS selector to snapshot a subset of the page"),
  },
  async ({ selector }) => {
    const page = await getActivePage();
    const targetId = await getTargetId(page);

    const { content, refs } = await buildSnapshot(page, selector);
    storeRefs(targetId, refs);

    const header = `url: ${page.url()}\ntitle: ${await page.title()}\n\n`;
    return {
      content: [{ type: "text" as const, text: header + content }],
    };
  }
);

// ── 3. click ────────────────────────────────────────────────────────────

server.tool(
  "click",
  "Click an element by ref or text description",
  {
    ref: z.string().optional().describe("Element ref from snapshot (e.g. e1)"),
    text: z
      .string()
      .optional()
      .describe("Visible text to find element by (button text, link text, label)"),
    doubleClick: z.boolean().optional().describe("Double-click instead of single click"),
  },
  async ({ ref, text, doubleClick }) => {
    const page = await getActivePage();
    const targetId = await getTargetId(page);
    const label = ref ?? text ?? "?";

    try {
      const locator = resolveElement(page, targetId, { ref, text });
      if (doubleClick) {
        await locator.dblclick({ timeout: 5000 });
      } else {
        await locator.click({ timeout: 5000 });
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ success: true }) },
        ],
      };
    } catch (err) {
      throw friendlyError(err, label);
    }
  }
);

// ── 4. type ─────────────────────────────────────────────────────────────

server.tool(
  "type",
  "Type text into an element. Clicks to focus first.",
  {
    ref: z.string().optional().describe("Element ref from snapshot"),
    text: z.string().optional().describe("Visible text to find element by"),
    content: z.string().describe("Text to type"),
    submit: z.boolean().optional().describe("Press Enter after typing"),
    clear: z.boolean().optional().describe("Clear field before typing"),
  },
  async ({ ref, text, content: typedText, submit, clear }) => {
    const page = await getActivePage();
    const targetId = await getTargetId(page);
    const label = ref ?? text ?? "?";

    try {
      const locator = resolveElement(page, targetId, { ref, text });
      if (clear !== false) {
        await locator.fill(typedText, { timeout: 5000 });
      } else {
        await locator.click({ timeout: 5000 });
        await locator.pressSequentially(typedText);
      }
      if (submit) await locator.press("Enter", { timeout: 5000 });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ success: true }) },
        ],
      };
    } catch (err) {
      throw friendlyError(err, label);
    }
  }
);

// ── 5. fill_form ────────────────────────────────────────────────────────

server.tool(
  "fill_form",
  "Fill multiple form fields at once",
  {
    fields: z
      .array(z.object({ ref: z.string(), value: z.string() }))
      .describe("Array of {ref, value} pairs"),
  },
  async ({ fields }) => {
    const page = await getActivePage();
    const targetId = await getTargetId(page);
    let filled = 0;
    const errors: string[] = [];

    for (const field of fields) {
      try {
        const locator = resolveRef(page, field.ref, targetId);
        await locator.fill(field.value, { timeout: 5000 });
        filled++;
      } catch (err) {
        errors.push(
          `${field.ref}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ filled, errors }),
        },
      ],
    };
  }
);

// ── 6. screenshot ───────────────────────────────────────────────────────

server.tool(
  "screenshot",
  "Take a screenshot of the current page",
  {
    fullPage: z.boolean().optional().describe("Capture full scrollable page"),
    path: z.string().optional().describe("Custom save path"),
  },
  async ({ fullPage, path: customPath }) => {
    const page = await getActivePage();
    const savePath =
      customPath ??
      path.join(SCREENSHOT_DIR, `page-${Date.now()}.png`);

    fs.mkdirSync(path.dirname(savePath), { recursive: true });

    const buffer = await page.screenshot({
      fullPage: fullPage ?? false,
      timeout: 15000,
    });

    // Resize if too large (>2000px) — save as-is for now, Playwright handles scaling
    fs.writeFileSync(savePath, buffer);

    const viewport = page.viewportSize();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            path: savePath,
            width: viewport?.width ?? 0,
            height: viewport?.height ?? 0,
          }),
        },
      ],
    };
  }
);

// ── 7. upload_file ──────────────────────────────────────────────────────

server.tool(
  "upload_file",
  "Upload a file through a file input element",
  {
    ref: z.string().describe("Element ref of the file input"),
    filePath: z.string().describe("Absolute path to the file to upload"),
  },
  async ({ ref, filePath }) => {
    const page = await getActivePage();
    const targetId = await getTargetId(page);

    try {
      const locator = resolveRef(page, ref, targetId);
      await locator.setInputFiles(filePath, { timeout: 5000 });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ success: true }) },
        ],
      };
    } catch (err) {
      throw friendlyError(err, ref);
    }
  }
);

// ── 8. list_tabs ────────────────────────────────────────────────────────

server.tool("list_tabs", "List all open browser tabs", {}, async () => {
  const tabs = await listAllTabs();
  // Mark the first one as "active" (default target)
  const result = tabs.map((t, i) => ({ ...t, active: i === 0 }));
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ tabs: result }, null, 2) },
    ],
  };
});

// ── 9. new_tab ──────────────────────────────────────────────────────────

server.tool(
  "new_tab",
  "Open a new tab with a URL",
  { url: z.string().describe("URL to open") },
  async ({ url }) => {
    const page = await newTab(url);
    const targetId = await getTargetId(page);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            targetId,
            url: page.url(),
            title: await page.title(),
          }),
        },
      ],
    };
  }
);

// ── 10. select_tab ──────────────────────────────────────────────────────

server.tool(
  "select_tab",
  "Switch to a different tab by targetId",
  { targetId: z.string().describe("Target ID from list_tabs") },
  async ({ targetId }) => {
    const page = await getActivePage(targetId);
    await page.bringToFront();
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            url: page.url(),
            title: await page.title(),
          }),
        },
      ],
    };
  }
);

// ── 11. wait ────────────────────────────────────────────────────────────

server.tool(
  "wait",
  "Wait for a condition on the page",
  {
    text: z.string().optional().describe("Text to wait for"),
    selector: z.string().optional().describe("CSS selector to wait for"),
    timeout: z.number().optional().describe("Timeout in ms (default 10000)"),
    state: z
      .enum(["load", "networkidle"])
      .optional()
      .describe("Wait for page state"),
  },
  async ({ text, selector, timeout: timeoutMs, state }) => {
    const page = await getActivePage();
    const timeout = timeoutMs ?? 10000;
    const start = Date.now();

    try {
      if (text) {
        await page.getByText(text).waitFor({ state: "visible", timeout });
      } else if (selector) {
        await page.locator(selector).waitFor({ state: "visible", timeout });
      } else if (state === "load") {
        await page.waitForLoadState("load", { timeout });
      } else if (state === "networkidle") {
        await page.waitForLoadState("networkidle", { timeout });
      } else {
        return {
          content: [
            {
              type: "text" as const,
              text: "Provide text, selector, or state to wait for.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              elapsed: Date.now() - start,
            }),
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              elapsed: Date.now() - start,
            }),
          },
        ],
      };
    }
  }
);

// ── 12. evaluate ────────────────────────────────────────────────────────

server.tool(
  "evaluate",
  "Run JavaScript in the page context",
  {
    expression: z.string().describe("JavaScript expression to evaluate"),
  },
  async ({ expression }) => {
    const page = await getActivePage();

    try {
      const result = await page.evaluate(expression);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ result }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
      };
    }
  }
);

// ── 13. batch ───────────────────────────────────────────────────────────

type BatchAction = {
  tool: string;
  params: Record<string, unknown>;
};

server.tool(
  "batch",
  "Execute multiple actions in sequence server-side (avoids round-trips)",
  {
    actions: z
      .array(
        z.object({
          tool: z.string().describe("Tool name to call"),
          params: z.record(z.unknown()).describe("Tool parameters"),
        })
      )
      .describe("Actions to execute in order"),
    stopOnError: z
      .boolean()
      .optional()
      .describe("Stop on first error (default true)"),
  },
  async ({ actions, stopOnError }) => {
    const stop = stopOnError !== false;
    const results: { success: boolean; result?: string; error?: string }[] = [];

    for (const action of actions) {
      try {
        const result = await executeToolDirect(action.tool, action.params);
        results.push({ success: true, result });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        results.push({ success: false, error });
        if (stop) break;
      }
    }

    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ results }, null, 2) },
      ],
    };
  }
);

// ── Batch direct execution (bypass MCP, call tool logic directly) ───────

async function executeToolDirect(
  tool: string,
  params: Record<string, unknown>
): Promise<string> {
  switch (tool) {
    case "navigate": {
      const page = await getActivePage();
      const url = params.url as string | undefined;
      const action = params.action as string | undefined;
      if (action === "back") await page.goBack({ timeout: 30000 });
      else if (action === "forward") await page.goForward({ timeout: 30000 });
      else if (action === "reload") await page.reload({ timeout: 30000 });
      else if (url)
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return JSON.stringify({ url: page.url(), title: await page.title() });
    }

    case "snapshot": {
      const page = await getActivePage();
      const targetId = await getTargetId(page);
      const { content, refs } = await buildSnapshot(
        page,
        params.selector as string | undefined
      );
      storeRefs(targetId, refs);
      return `url: ${page.url()}\ntitle: ${await page.title()}\n\n${content}`;
    }

    case "click": {
      const page = await getActivePage();
      const targetId = await getTargetId(page);
      const ref = params.ref as string | undefined;
      const text = params.text as string | undefined;
      const locator = resolveElement(page, targetId, { ref, text });
      if (params.doubleClick) await locator.dblclick({ timeout: 5000 });
      else await locator.click({ timeout: 5000 });
      return JSON.stringify({ success: true });
    }

    case "type": {
      const page = await getActivePage();
      const targetId = await getTargetId(page);
      const ref = params.ref as string | undefined;
      const text = params.text as string | undefined;
      const locator = resolveElement(page, targetId, { ref, text });
      const content = params.content as string;
      if (params.clear !== false) {
        await locator.fill(content, { timeout: 5000 });
      } else {
        await locator.click({ timeout: 5000 });
        await locator.pressSequentially(content);
      }
      if (params.submit) await locator.press("Enter", { timeout: 5000 });
      return JSON.stringify({ success: true });
    }

    case "wait": {
      const page = await getActivePage();
      const timeout = (params.timeout as number) ?? 10000;
      if (params.text)
        await page
          .getByText(params.text as string)
          .waitFor({ state: "visible", timeout });
      else if (params.selector)
        await page
          .locator(params.selector as string)
          .waitFor({ state: "visible", timeout });
      else if (params.state === "networkidle")
        await page.waitForLoadState("networkidle", { timeout });
      else await page.waitForLoadState("load", { timeout });
      return JSON.stringify({ success: true });
    }

    case "evaluate": {
      const page = await getActivePage();
      const result = await page.evaluate(params.expression as string);
      return JSON.stringify({ result });
    }

    case "screenshot": {
      const page = await getActivePage();
      const savePath =
        (params.path as string) ??
        path.join(SCREENSHOT_DIR, `page-${Date.now()}.png`);
      fs.mkdirSync(path.dirname(savePath), { recursive: true });
      const buffer = await page.screenshot({
        fullPage: (params.fullPage as boolean) ?? false,
        timeout: 15000,
      });
      fs.writeFileSync(savePath, buffer);
      return JSON.stringify({ path: savePath });
    }

    default:
      throw new Error(`Unknown tool for batch: ${tool}`);
  }
}

// ── Start server ────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("browser-mcp server error:", err);
  process.exit(1);
});
