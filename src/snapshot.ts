import type { Page, FrameLocator } from "playwright-core";
import type { RefMap, RefInfo } from "./browser.js";

// Roles that always get a ref (interactive elements)
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

// Roles that get a ref only when named
const CONTENT_ROLES = new Set([
  "heading",
  "img",
  "article",
  "cell",
  "columnheader",
  "row",
  "rowheader",
  "region",
  "main",
  "navigation",
  "banner",
  "contentinfo",
  "complementary",
  "figure",
  "listitem",
]);

interface ParsedLine {
  indent: number;
  role: string;
  name: string;
  rawLine: string;
}

/**
 * Build a compact accessibility snapshot with stable element refs.
 *
 * Uses Playwright's ariaSnapshot() to get the tree, then parses it to assign refs
 * to interactive and named content elements.
 */
export async function buildSnapshot(
  page: Page,
  selector?: string
): Promise<{ content: string; refs: RefMap }> {
  const scope = selector ? page.locator(selector) : page.locator("body");

  const ariaText = await scope.ariaSnapshot({ timeout: 10000 });

  return parseAriaSnapshot(ariaText);
}

/**
 * Parse Playwright's ariaSnapshot output into compact ref-annotated text.
 *
 * Input format (from Playwright):
 *   - button "Save"
 *   - region "Main"
 *     - heading "Title" [level=1]
 *     - textbox "Email" [value="foo@bar.com"]
 *
 * Output format:
 *   [e1] button "Save"
 *   region "Main"
 *     [e2] heading "Title"
 *     [e3] textbox "Email"  value="foo@bar.com"
 */
export function parseAriaSnapshot(ariaText: string): {
  content: string;
  refs: RefMap;
} {
  const refs: RefMap = {};
  const lines = ariaText.split("\n");
  const outputLines: string[] = [];

  // Track role+name occurrences for nth dedup
  const roleNameCount = new Map<string, number>();
  const refsByRoleName = new Map<string, string[]>();

  let counter = 0;
  const nextRef = () => `e${++counter}`;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;

    // Preserve indentation (convert from "  - " to just spaces)
    const leadingSpaces = line.length - line.trimStart().length;
    const indent = " ".repeat(Math.max(0, leadingSpaces));

    // Parse: "- role \"name\" [attrs]"
    const parsed = parseLine(trimmed);
    if (!parsed) {
      // Not a role line — pass through (e.g. text nodes)
      const clean = trimmed.replace(/^- /, "");
      if (clean.startsWith('"') || !clean.includes('"')) {
        // Bare text node
        outputLines.push(`${indent}${clean.replace(/^"(.*)"$/, "$1")}`);
      } else {
        outputLines.push(`${indent}${clean}`);
      }
      continue;
    }

    const { role, name } = parsed;
    const shouldRef =
      INTERACTIVE_ROLES.has(role) ||
      (CONTENT_ROLES.has(role) && name !== "");

    if (shouldRef) {
      const ref = nextRef();
      const key = `${role}::${name}`;
      roleNameCount.set(key, (roleNameCount.get(key) ?? 0) + 1);
      if (!refsByRoleName.has(key)) refsByRoleName.set(key, []);
      refsByRoleName.get(key)!.push(ref);

      refs[ref] = { role, name: name || undefined };

      // Build output line
      let display = `${indent}[${ref}] ${role}`;
      if (name) display += ` "${name}"`;

      // Extract value attr if present
      const valueMatch = trimmed.match(/\[value="([^"]*)"\]/);
      if (valueMatch) display += `  value="${valueMatch[1]}"`;

      // Extract checked/selected state
      if (trimmed.includes("[checked]") || trimmed.includes("[checked=true]"))
        display += "  [checked]";
      if (trimmed.includes("[selected]")) display += "  [selected]";
      if (trimmed.includes("[disabled]")) display += "  [disabled]";

      // Extract level for headings
      const levelMatch = trimmed.match(/\[level=(\d+)\]/);
      if (levelMatch) display += `  [level=${levelMatch[1]}]`;

      // Extract href for links
      const hrefMatch = trimmed.match(/\[url="([^"]*)"\]/);
      if (hrefMatch) {
        const href = hrefMatch[1]!;
        // Show path only for same-origin links
        const short =
          href.startsWith("/") ? href : href.replace(/^https?:\/\/[^/]+/, "");
        display += ` -> ${short}`;
      }

      outputLines.push(display);
    } else {
      // Non-ref line — just display role + name
      let display = `${indent}${role}`;
      if (name) display += ` "${name}"`;
      outputLines.push(display);
    }
  }

  // Add nth indices for duplicate role+name combos
  for (const [key, refIds] of refsByRoleName) {
    if ((roleNameCount.get(key) ?? 0) > 1) {
      refIds.forEach((refId, i) => {
        if (refs[refId]) refs[refId]!.nth = i;
      });
    }
  }

  return { content: outputLines.join("\n"), refs };
}

function parseLine(
  trimmed: string
): { role: string; name: string } | null {
  // Remove leading "- "
  const s = trimmed.replace(/^- /, "");

  // Match: role "name" or just role
  const m = s.match(/^(\w[\w-]*)\s*(?:"([^"]*)")?/);
  if (!m) return null;

  const role = m[1]!;
  const name = m[2] ?? "";

  // Skip if this looks like a bare text node rather than a role
  if (
    !INTERACTIVE_ROLES.has(role) &&
    !CONTENT_ROLES.has(role) &&
    !STRUCTURAL_ROLES.has(role)
  ) {
    return null;
  }

  return { role, name };
}

const STRUCTURAL_ROLES = new Set([
  "generic",
  "group",
  "list",
  "listbox",
  "menu",
  "menubar",
  "none",
  "presentation",
  "separator",
  "toolbar",
  "tree",
  "treegrid",
  "table",
  "grid",
  "rowgroup",
  "dialog",
  "alertdialog",
  "status",
  "log",
  "marquee",
  "timer",
  "alert",
  "progressbar",
  "tablist",
  "tabpanel",
  "application",
  "document",
  "feed",
  "form",
  "math",
  "note",
  "search",
  "definition",
  "term",
  "directory",
  "paragraph",
  "blockquote",
  "caption",
  "code",
  "deletion",
  "emphasis",
  "insertion",
  "strong",
  "subscript",
  "superscript",
  "time",
  "tooltip",
]);
