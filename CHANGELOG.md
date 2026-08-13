# Changelog

All notable user-facing changes. Earlier releases predate this file; see the
[commit history](https://github.com/iair0007/cursor-usage/commits/main) for those.

## Unreleased

- **Far fewer calls to cursor.com.** The quota, plan and spend-cap lookups now
  sit behind a short cache with in-flight de-duplication. Opening the dashboard
  used to fire dozens of identical requests: the panel asks for usage and for
  the budget, the budget asks for cycle usage, that asks for the quota, and the
  status bar refreshes after each one. Usage responses were already cached;
  these three were not.
- **Both comparison columns are editable**, from their own headers. The custom
  option previously only moved the baseline, which made "this sprint vs last
  sprint" impossible to express. Pinning the left column detaches the
  comparison from the filter bar and says so.
- The comparison gained requests-per-day and cache hit rate, and its model
  table now carries request counts and per-request averages — cost alone can't
  separate "used it more" from "each call got dearer". Rows that didn't move
  are dimmed.
- A **Compare periods →** link sits beside the ▲/▼ trend badge on Overview,
  since the badge raises a question the comparison is what answers.

- **Fixed a plan change being reported on accounts that never had one.** A
  request that simply wasn't token-metered — an included request charged $0 —
  was read as "priced per request under your previous plan". On an account
  where every row is the same "included in business" kind, that invented a
  billing migration, added a Usage fee column of zeroes, and hijacked the date
  range on first open.
- The detected change date no longer moves with the date filter. It used to be
  "the first token-metered row in whatever range is loaded", so the same
  account reported a different change date for "Today" than for 30 days — the
  date filter was reporting on itself. A change now needs a one-way split (no
  per-request charges after it, since a migration never reverts) and a
  substantial block of requests either side.
- A boundary stored by an earlier session is dropped when a fresh look no
  longer finds it, instead of leaving a "Current plan" range built on a date
  the account shows no evidence for.
- Both plan-change notices are now warnings. The automatic one was a blue
  "info" sitting beside an amber warning about the same condition.

- **Compare periods**, a new sub-tab on Analyze. Your selected range next to
  another one — cost, requests, avg per request, avg per day and cache savings
  — plus a model-by-model breakdown of what actually moved, sorted by biggest
  change rather than biggest total.
- Analyze is now split into **Findings** and **Compare periods** sub-tabs, the
  same pattern the request log uses for its charts.
- A range that straddles a plan's billing change now says so every time it is
  loaded, not only on the one automatic switch. Previously "Month to date"
  quietly totalled two pricing systems together.
- The automatic switch to the "Current plan" range now describes the switch it
  made, instead of referring to a range it had already replaced.
- Dropped the defensive "this is expected, not a bug" from the no-request-quota
  note.
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
