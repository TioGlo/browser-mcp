# browser-mcp

A Model Context Protocol (MCP) server for browser automation via Playwright, designed for use with Claude Code and other MCP-compatible AI agents.

Connects to a real Chrome browser via CDP (Chrome DevTools Protocol) and provides clean, high-level tools for navigation, interaction, screenshots, and form filling. Built as a replacement for the default chrome-devtools and playwright MCP servers, with a focus on stable element references and reduced round-trips.

## Why This Exists

The built-in Chrome DevTools and Playwright MCP servers for Claude Code have friction:
- Element UIDs change on every snapshot, requiring constant re-snapshotting
- 3+ round-trips per action (snapshot → find UID → act)
- No batch operations
- Form filling requires knowing exact field types

browser-mcp solves these with:
- **Stable element refs** (`e1`, `e2`, ...) cached per tab, persisting across tool calls
- **Text-based element targeting** — click by visible text, not just refs
- **Batch operations** — multiple actions in one call
- **Clean form filling** — just `type(ref: "e2", content: "hello")`
- **Auto-reconnect** to Chrome on disconnect

## Prerequisites

- **Node.js** 18+
- **Chrome / Chromium** installed (binary auto-detected, or set `CHROME_BIN`)

Chrome can be running already, or browser-mcp can launch it for you (see `CHROME_AUTOLAUNCH` below).

## Configuration (env vars)

All optional. Set them in the `env` block of your `.mcp.json` entry.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CDP_URL` | `http://localhost:$CHROME_PORT` | Full URL to an existing CDP endpoint. Wins over `CHROME_PORT` if set. |
| `CHROME_PORT` | `9222` | Port for the auto-derived CDP URL and for autolaunched Chrome. |
| `CHROME_BIN` | auto-detect | Path to the Chrome / Chromium binary. |
| `CHROME_PROFILE_DIR` | (none) | `--user-data-dir` value. Required when `CHROME_AUTOLAUNCH=true`. |
| `CHROME_AUTOLAUNCH` | `false` | If `true`, browser-mcp spawns Chrome on first connect attempt when the port is dead. Detached: Chrome survives browser-mcp restarts. |
| `CHROME_EXTRA_ARGS` | (none) | Space-separated extra flags appended to the launch command. |

**Per-agent isolation pattern.** Give each agent its own profile + port and set `CHROME_AUTOLAUNCH=true`. Cookies, logins, and DOM state stay separate.

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/path/to/browser-mcp/dist/index.js"],
      "env": {
        "CHROME_PORT": "9223",
        "CHROME_PROFILE_DIR": "/home/me/.assistant/prana/chrome-profile",
        "CHROME_AUTOLAUNCH": "true"
      }
    }
  }
}
```

**Sharing a profile** (opt-in): point two agents at the same `CHROME_PROFILE_DIR` and the same `CHROME_PORT`. They'll share state.

**Connecting to an existing Chrome you manage yourself** (legacy): set `CDP_URL` and leave `CHROME_AUTOLAUNCH` unset. Run Chrome separately:

```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.chrome-mcp-profile" \
  --no-first-run --no-default-browser-check
```

## Installation

```bash
git clone https://github.com/youruser/browser-mcp.git
cd browser-mcp
npm install
npm run build
```

## Usage with Claude Code

Register as an MCP server:

```bash
claude mcp add -s user browser-mcp -- node /path/to/browser-mcp/dist/index.js
```

Or add to a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/path/to/browser-mcp/dist/index.js"]
    }
  }
}
```

## Tools

### Navigation

| Tool | Description |
|------|-------------|
| `navigate` | Go to a URL, or `back`/`forward`/`reload` |
| `new_tab` | Open a new tab with a URL |
| `select_tab` | Switch to a tab by targetId |
| `list_tabs` | List all open tabs |

### Page Understanding

| Tool | Description |
|------|-------------|
| `snapshot` | Compact accessibility tree with stable element refs |
| `screenshot` | Capture the page as PNG |
| `wait` | Wait for text, selector, or page load state |

### Interaction

| Tool | Description |
|------|-------------|
| `click` | Click by ref (`e1`) or visible text (`"Log In"`) |
| `type` | Type into a field with optional submit/clear |
| `fill_form` | Fill multiple fields at once |
| `upload_file` | Upload a file through a file input |
| `evaluate` | Run JavaScript in the page context |

### Composition

| Tool | Description |
|------|-------------|
| `batch` | Execute multiple actions server-side in sequence |

## How Snapshots Work

The `snapshot` tool parses Playwright's accessibility tree and assigns stable refs to interactive and named content elements:

```
[e1] link "Instagram" -> /
[e2] textbox "Username"  value="pranathegogi"
[e3] textbox "Password"
[e4] button "Log In"  [disabled]
[e5] link "Forgot password?" -> /accounts/password/reset/
```

Refs persist across `snapshot` calls until the page navigates. Use them in `click`, `type`, `fill_form`, and `upload_file`.

### Text-Based Targeting

When you don't have a ref, `click` and `type` accept a `text` parameter that searches:
1. Button text
2. Link text
3. Textbox name/label
4. Label text
5. Placeholder text
6. Visible text (exact match)

```
click(text: "Log In")     → finds the login button
type(text: "Username", content: "myuser")  → finds by label
```

## Batch Operations

Avoid round-trips by composing actions server-side:

```json
{
  "actions": [
    {"tool": "navigate", "params": {"url": "https://example.com"}},
    {"tool": "snapshot", "params": {}},
    {"tool": "click", "params": {"text": "Sign In"}},
    {"tool": "type", "params": {"ref": "e2", "content": "user@email.com"}},
    {"tool": "type", "params": {"ref": "e3", "content": "password", "submit": true}}
  ],
  "stopOnError": true
}
```

## Persistent Sessions

browser-mcp connects to a real Chrome browser, not a headless instance. This means:
- Login sessions persist in Chrome's profile
- Cookies, localStorage, and auth tokens survive across MCP restarts
- You can log into sites manually once, and the agent automates from there
- No bot detection issues (it's a real browser)

Use `--user-data-dir` when launching Chrome to keep sessions across Chrome restarts.

## Architecture

```
Claude Code / AI Agent
      │
      ▼ (MCP stdio)
  browser-mcp
      │
      ▼ (Playwright connectOverCDP)
  Chrome (localhost:9222)
```

- **Connection**: Playwright's `chromium.connectOverCDP()` with auto-reconnect (3 retries)
- **Page state**: Console logs, network requests, and element refs tracked per tab
- **Ref resolution**: Maps `e1` → `getByRole("button", {name: "Submit"})` with nth-index deduplication
- **Error handling**: Timeouts and not-found errors converted to friendly messages suggesting re-snapshot

## Inspired By

The architecture is modeled after [OpenClaw's browser control system](https://docs.openclaw.ai/tools/browser), adapted for the MCP protocol.

## License

MIT
