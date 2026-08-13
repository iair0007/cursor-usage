# Changelog

All notable user-facing changes. Earlier releases predate this file; see the
[commit history](https://github.com/iair0007/cursor-usage/commits/main) for those.

## Unreleased

- **Compare periods** on the Analytics tab. Your selected range next to another
  one — cost, requests, avg per request, avg per day and cache savings — plus a
  model-by-model breakdown of what actually moved, sorted by biggest change
  rather than biggest total.
- Choose the baseline: the previous equal-length period, the same dates last
  month, or a custom window. The choice is remembered between sessions.
- The panel names both windows in its column headers, and says so when the two
  aren't the same length or when the selected period includes today — the two
  things that most often make the ▲/▼ badge read wrong.

## 0.6.1 — 2026-08-12

- The plan card and the budget projection now name the window they cover
  ("since Aug 1", "the current billing cycle — not the period selected above"),
  so a cycle-to-date gauge can't be misread as following the filter bar.

## 0.6.0 — 2026-08-12

- Budgets are detected for any account, not just team seats.
- The status bar's quota format, fill style and warn/critical thresholds now
  apply to the monthly budget on plans metered in dollars, instead of sitting
  idle there.
- New **Current plan** date preset for accounts that moved from per-request to
  token pricing, so dollars from two billing systems aren't summed into one
  total. The dashboard switches to it once and says why.

## 0.5.2 — 2026-08-12

- Removed the duplicate period and cost-mode chips from Overview — the filter
  bar above already carries both, and a second copy read as a different filter.

## 0.5.0 — 2026-08-12

- **Burn-rate projection for budget-metered plans.** Plans with no
  included-request quota now get the same gauge, denominated in money: spend so
  far against your monthly budget, your average daily pace this cycle, when the
  budget runs out, and the daily spend that still fits before the reset.
- New `cursorUsage.budget.monthlyDollars` setting, for when cursor.com doesn't
  report the budget anywhere this extension can read it. Your setting wins over
  anything detected, and the projection re-derives from the current value on
  every refresh — so changing the budget mid-cycle just works.

## 0.4.9 — 2026-08-12

- Fixed a request picker that went stale after a reload, and a false "no data"
  state. Notes moved next to the figures they explain; CSV columns match the
  table.

## 0.4.8 — 2026-08-12

- Metered spend is reported separately from pre-plan-change requests, matching
  what cursor.com's usage page counts as "Total usage".

## 0.4.7 — 2026-08-12

- Fixed a filter-bar regression, guarded against double-counted pages, and
  reconciled totals against cursor.com.

## 0.4.6 — 2026-08-12

- The requested window is enforced on API results, so events outside the
  selected range no longer leak into totals.

## 0.4.5 — 2026-08-12

- Every figure on the dashboard now follows the filter bar — totals, charts,
  and the request log stay in sync with the selected range and model.

## 0.4.4 — 2026-07-14

- Half-fill segments in the status bar quota gauge.

## 0.4.3 — 2026-07-08

- "Month to date" period preset.
- The event-derived request count is hidden when a plan quota is available.
