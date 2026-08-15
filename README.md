# Cursor Usage Dashboard

**See exactly where your Cursor requests and tokens go — right inside Cursor.**

[![Open VSX](https://img.shields.io/open-vsx/v/iair0007/cursor-usage-dashboard?label=Open%20VSX)](https://open-vsx.org/extension/iair0007/cursor-usage-dashboard)
[![Downloads](https://img.shields.io/open-vsx/dt/iair0007/cursor-usage-dashboard)](https://open-vsx.org/extension/iair0007/cursor-usage-dashboard)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/iair0007/cursor-usage/blob/main/LICENSE)

**Website:** [iair0007.github.io/cursor-usage](https://iair0007.github.io/cursor-usage/)

Costs, cache savings, model breakdowns, per-session comparisons, budget burn-rate, rule-based insights, and a cost simulator — with zero setup. No proxy server, no login: it reuses the session Cursor created when you signed in.

## 60-second tour

<!-- Served from GitHub Pages, not raw.githubusercontent.com: raw returns .mp4
     as application/octet-stream with X-Content-Type-Options: nosniff, so
     browsers refuse to play it in a <video>. Pages sends a real video/mp4. -->
<video controls preload="none" playsinline poster="https://iair0007.github.io/cursor-usage/demo-poster.jpg" width="900">
  <source src="https://iair0007.github.io/cursor-usage/demo-short.mp4" type="video/mp4">
</video>

*Video not playing? Watch the [60-second tour](https://iair0007.github.io/cursor-usage/demo-short.mp4) or the [full 2½-minute walkthrough](https://iair0007.github.io/cursor-usage/) instead.*

![Overview tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-overview.png)

## Install

1. Open the Extensions view in Cursor (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **"Cursor Usage Dashboard"** and click **Install**.
3. Run **`Cursor Usage: Open Dashboard`** from the command palette — that's it.

The extension is published on the [Open VSX Registry](https://open-vsx.org/extension/iair0007/cursor-usage-dashboard), which is what Cursor's Extensions view searches.

## Always-on status bar

A live usage figure sits in your status bar and updates automatically. Click it to open the dashboard.

![Status bar states](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-statusbar.png)

- **On plans with included requests** (e.g. 500/month) it shows **requests used vs. your limit** — `110/500` — because that's the number you actually watch on those plans, plus a fill gauge and the cycle reset date.
- **On plans metered in dollars** (no request quota) the same gauge tracks your **monthly budget** — `$25.35/$40.00` — once you've told the extension what that budget is (see [`cursorUsage.budget.monthlyDollars`](#budget-metered-plans) below).
- Either way it turns **yellow at 80%** and **red at 95%** (both thresholds configurable), and the tooltip projects when you'll run out at your current pace.
- **Once a request quota is exhausted** it pins at `500/500` and appends your **on-demand spend** — so you see immediately that you're now paying per use, and how much.
- With neither a quota nor a budget, it falls back to your token cost for the current billing cycle (or a rolling window — configurable).

## Budget-metered plans

The extension asks cursor.com for your monthly spend budget, but there's no documented endpoint that reliably reports it — so if the plan card shows no projection, **set it yourself** in Settings: `cursorUsage.budget.monthlyDollars`, using the figure cursor.com shows as `$X / $Y` on its usage page. Your setting always wins over anything looked up. With a budget known, you get:

![Budget burn-rate on the Overview tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-budget.png)

- a **burn-rate projection**: spend so far, your average daily pace this cycle, when the budget runs out, and the daily spend that still fits before the reset;
- the **status bar gauge, fill style and warning thresholds** driven by the budget instead of a request count;
- figures that always re-derive from the current setting, so **raising or cutting the budget mid-cycle** is picked up on the next refresh.

At the default `0` the extension uses whatever it can find — a budget reported by cursor.com, otherwise your usage-based spend cap — and hides the projection if neither turns up.

Spend is measured the way cursor.com's usage page measures it — **token-metered requests only**. Requests priced under the older per-request system never counted against a dollar budget, so they're reported separately rather than folded into the same total.

## What's inside

The dashboard has four tabs, from simple to detailed:

### Overview

Your plan and billing-cycle status with a progress bar and burn-rate projection, three key numbers (cost, requests, cache savings), a daily-spend sparkline, and the single most important insight right now. The **What-if / Billed** toggle in the filter bar switches every figure between the API-equivalent value of your tokens and what you were actually charged.

The plan card always covers the **current billing cycle**, not the period picked in the filter bar — and says so, so a "Today" filter above a cycle-to-date gauge can't be misread.

### Requests

![Requests tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-requests.png)

The full request log: custom date ranges, model filter, per-request token cost and cache savings, expensive-request highlighting, sortable columns, CSV export. On usage-based plans a separate **Usage fee** column shows the flat per-request charge, kept apart from token cost so neither number absorbs the other. The **Analytics** sub-tab adds daily token cost, cost by model, and token volume charts with a week-over-week trend badge.

Date presets are **Today / 7 days / 30 days / Month to date / Custom**. If your account moved from per-request to token pricing, a **Current plan** preset appears and the dashboard switches to it once, so you aren't comparing dollars from two different billing systems in one total.

![Analytics charts](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-analytics.png)

### Analyze

Three sub-tabs, all answering "why does my bill look like this" — **Findings** from one period, **Compare periods** from two, **Sessions** from your individual conversations.

![Analyze tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-analyze.png)

**Findings** are rule-based with configurable thresholds: which model dominates your spend, whether your cache is working, cold starts, heavy-output requests, spike requests, a measured promotion and what it's worth switching to it for — each with a concrete "what to do about it". The **Ask Cursor Chat** panel builds a compact brief from the data slices you pick, copies it, and focuses Cursor's chat so you just paste and send.

#### Compare periods

Puts your selected period next to another one and shows **which models account for the difference** — sorted by biggest mover, not biggest spender, because a model that went from $2 to $14 is the answer to "why did my bill move".

![Comparing two periods](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-compare.png)

**Click either period's dates to change it** — the ranges under "This period" and "Compared with" are both editable, so "this sprint vs the last one" is two clicks rather than a filter change. Pinning the left column detaches the comparison from the filter bar, and the panel says so, with a one-click way back — the pin itself doesn't outlive the session. The **Previous period** and **Same dates last month** shortcuts move the baseline for the common cases.

Alongside cost it shows requests, avg per request, per-day rates and cache hit rate, and the model table carries request counts and per-request averages — enough to tell "I used it more" apart from "each call got dearer". The panel also warns when the two windows aren't the same length, or when your period includes today, which isn't over yet.

#### Sessions

Groups the requests in your selected period by the Cursor conversation they came from, so "one chat" reads as one row instead of scattered log lines. Each session shows its cost, span, requests, and the models it reached for; names come from Cursor's own local chat index when it has one, otherwise the conversation id.

![Sessions list](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-sessions.png)

Tick up to four sessions and a selection tray pins to the bottom of the view with a **Compare** button — picking rows at the bottom of a long list gives you feedback right there instead of a table you have to scroll up to find. With two sessions the comparison shows a plain difference column; with three or four it highlights the best and worst figure in each row against a base you can re-pick, plus a model-by-model cost breakdown for the same sessions.

![Comparing sessions](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-sessions-compare.png)

Sessions carry no code or prompt content — Cursor's local database is only ever asked for a conversation's title, and that title never leaves your machine over the network. Requests with no conversation id (some plans and API versions don't send one) are called out rather than silently dropped from the total.

### Simulator

![Simulator tab](https://raw.githubusercontent.com/iair0007/cursor-usage/main/docs/screenshot-simulator.png)

Replay any real request's token profile against other models' published rates — *"what would this request have cost on Haiku?"* — or price a custom token profile from scratch.

**Promotions.** Cursor runs limited-time discounts ("Grok is half price this week") that it announces in prose and never publishes as a machine-readable rate — but it does report two figures for every token-billed request: what those tokens are worth at list, and what it actually charged. On a promotion those diverge, and the gap between two of Cursor's own numbers *is* the discount — measured, not estimated from a scraped rate table. Auto is included: Cursor Router's Balance and Intelligence modes bill at the routed model's own rate and name that model in the request, so a promotion on the model Auto picked is caught the same way. Where you haven't run a model, there's nothing to measure, so the Simulator offers to let you record the promotion yourself and remembers it for future sessions.

Discounted requests are badged **"Discounted"** wherever they appear — the request log, Analyze, the comparison tables — with the measured percentage one hover away rather than printed on the badge, since it's a saving against list, not a guarantee of matching whatever headline rate a sale advertised. A measured discount is always shown as distinct from one you entered by hand. When a promotion is found, Analyze's **Findings** point it out directly: what it saved you, and — if a meaningful share of the period ran on other models while it was active — that it's worth pricing a real request against it in the Simulator before moving routine work over.

## Commands

| Command | Description |
| --- | --- |
| `Cursor Usage: Open Dashboard` | Open the dashboard panel |
| `Cursor Usage: Refresh` | Reload usage data (dashboard + status bar) |
| `Cursor Usage: Set Session Token Manually` | Fallback auth via pasted cookie |
| `Cursor Usage: Set Team Admin API Key` | Team usage via the Admin API |
| `Cursor Usage: Clear Stored Credentials` | Delete stored secrets |
| `Cursor Usage: Show Logs` | Open the extension's output channel |
| `Cursor Usage: Open Settings` | Jump to this extension's settings |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `cursorUsage.budget.monthlyDollars` | `0` | Your monthly spend budget, for the burn-rate projection on budget-metered plans. `0` uses whatever the extension can detect instead |
| `cursorUsage.statusBar.enabled` | `true` | Show usage in the status bar |
| `cursorUsage.refreshIntervalMinutes` | `15` | Status bar refresh cadence |
| `cursorUsage.statusBar.periodMode` | `cycle` | Whether status bar totals cover the current billing cycle or a rolling window |
| `cursorUsage.statusBar.periodDays` | `30` | Length of that rolling window — only used when `periodMode` is `days` |
| `cursorUsage.statusBar.costMode` | `value` | What-if token value vs. actually billed cost |
| `cursorUsage.statusBar.quotaFormat` | `usedLimit` | Show the allowance as used/limit or as remaining |
| `cursorUsage.statusBar.fillStyle` | `dots` | Visual fill indicator next to the figure (dots, blocks, bar, or none) |
| `cursorUsage.statusBar.warnAtPercent` | `80` | % of the allowance at which the status bar turns yellow |
| `cursorUsage.statusBar.criticalAtPercent` | `95` | % of the allowance at which the status bar turns red |

"Allowance" means included requests on plans that have them, and your monthly budget on plans metered in dollars — the quota settings cover both.

## Authentication & privacy

Everything runs locally — the only network calls are to cursor.com. Auth is resolved in this order:

1. **Cursor IDE session (default, zero setup)** — Cursor stores your session token in its local `state.vscdb` database when you sign in. The extension reads it *read-only*, preferring the native `sqlite3` CLI (streams from disk, so it works even on multi-GB databases) with a bundled WebAssembly SQLite fallback for small files.
2. **Team Admin API key** — run *"Cursor Usage: Set Team Admin API Key"* (Teams/Business plans) for team-wide usage via the official Admin API.
3. **Manual session token** — run *"Cursor Usage: Set Session Token Manually"* and paste the `WorkosCursorSessionToken` cookie from cursor.com (DevTools → Application → Cookies).

Secrets are stored in VS Code SecretStorage (your OS keychain), never in settings files. *"Cursor Usage: Clear Stored Credentials"* removes them.

## Troubleshooting

- **"Not signed in" but you are** — make sure you're logged into Cursor itself (Settings → Account). As a last resort, set a session token manually (see above).
- **Huge `state.vscdb`** — the extension reads it with the `sqlite3` CLI, which handles multi-GB files. `sqlite3` ships preinstalled on macOS and virtually every Linux distro; on Windows it's usually present too (`winget install SQLite.SQLite` otherwise). If the logs show `Skipping WASM SQLite fallback ... too large for sql.js`, install the CLI and reload the window.
- **Something looks off** — run `Cursor Usage: Show Logs` and check the output channel.

## Good to know

- The personal-usage endpoints (`cursor.com/api/dashboard/*`) are **unofficial** — Cursor can change them at any time. Each data source degrades gracefully; the Admin API path uses the documented official API.
- On a team with **Cursor Router** enabled, a request routed by Auto's Balance or Intelligence mode is shown as `Auto Balance → Grok 4.5` rather than a flat `Auto` — it's billed at the routed model's own rate, so knowing which model matters. This only appears when your team leaves "Underlying model" on display in Router settings; Auto's Cost mode and bare Auto (no model named) still read as `Auto`, since they're billed at Auto's own bundled rate regardless of what ran.
- Cache savings are **estimates**: cache-read tokens × (input rate − cache-read rate) at published per-model pricing. Simulator numbers are directional (same tokens, different rates), not quotes.
- If cursor.com's pricing page can't be reached, the dashboard falls back to a small bundled rate table (clearly flagged) instead of breaking cost estimates.
- Detected promotions are **measured against your own bill**, from Cursor's own list-vs-charged figures where it reports both — not scraped or guessed at. Where that comparison isn't available (a per-request-priced plan, sub-cent requests), it falls back to comparing your bill against the published rate table instead, which is why it's more cautious there: it wants several requests in a day priced consistently below list before it will call it a discount, and can still miss small or short ones. Either way it never adjusts what you were actually charged; it only affects the estimates for other models.

## Contributing

Issues and PRs are welcome at [iair0007/cursor-usage](https://github.com/iair0007/cursor-usage).

```bash
npm install
npm run compile   # type-check + bundle
npm test          # unit tests
npm run watch     # rebuild on change
npm run package   # build a local .vsix (Extensions: Install from VSIX…)
```

Layout: `src/extension.ts` (activation), `src/auth.ts` + `src/authCore.ts` (session resolution), `src/api.ts` (cursor.com client), `src/service.ts` (shared data layer), `src/panel.ts` + `src/html.ts` (webview + RPC bridge), `src/statusBar.ts`, `src/webview/` (dashboard UI).

Releases are automated: bumping `version` in `package.json` on `main` triggers the [publish workflow](https://github.com/iair0007/cursor-usage/blob/main/.github/workflows/publish.yml), which builds the `.vsix` and publishes it to Open VSX.

## License

[MIT](https://github.com/iair0007/cursor-usage/blob/main/LICENSE)
