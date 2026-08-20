# Changelog

All notable user-facing changes. Earlier releases predate this file; see the
[commit history](https://github.com/iair0007/cursor-usage/commits/main) for those.

## Unreleased

A full review pass over the browser-dashboard branch. Everything below rendered
or read wrongly without ever throwing, which is why nothing in the suite caught
any of it; each fix carries a regression test.

- **The banner explaining how your plan bills now appears when you open the
  request log.** It was drawn only as a tail of the KPI render, and switching to
  the Requests tab does not re-run that — so the one paragraph that says whether
  the Cost column is a flat fee or a token charge, and how to reconcile it with
  cursor.com, stayed hidden until an unrelated redraw (a sort, a page change)
  happened to bring it back.
- **And it now reads as a sentence.** Alerts are a flex row so a dismiss button
  can sit beside the message; this banner's rich text went in bare, which turned
  every bold phrase, code span and link in it into a column of its own. It is
  wrapped the way every other alert already was.
- **"Save" in the discount editor and "Add a discount" in the Simulator intro
  are styled again.** Both carried a class the stylesheet has never defined, so
  they rendered as raw native buttons — grey, square, 2px outset — beside the
  styled buttons they sit next to.
- **Editing a finding threshold now updates every surface, not just the Analyze
  panel.** The same thresholds drive the per-request findings that badge rows in
  the request log, the session list and the Overview card; changing one moved
  Analyze's own counts and left everywhere else reading findings computed at the
  old value.
- The Overview's "N more findings in Analyze" counts the cards Analyze will
  actually show. It counted the raw list, which repeats a rule that fired on
  many requests, so it could promise more findings than the tab had to give.
- The heavy-output finding quotes the threshold that fired it instead of a
  hardcoded "2k", so it stops contradicting the box you just typed a number into.
- A model name in the session timeline's tooltip was escaped twice, printing
  "&amp;" for any name carrying an ampersand.
- The session comparison drops the "Cold starts" row when every session has
  none, the way it already drops "Errored or aborted" — a row of zeroes is a
  line of table for a fact nobody needed told.
- Typing in Analyze's "Your question" box no longer re-sorts every event in the
  range and rebuilds every finding on each keystroke; the derivation the
  Overview, the Analyze tab and the brief all share is computed once per load.
  The request log likewise reuses the summary rather than re-deriving it every
  time a row is expanded.
- Screen readers get told what each dialog is. All three modals announced as a
  bare "dialog" — a `<dialog>` opened with `showModal()` takes its name from
  `aria-labelledby` and nothing else — and the heading ids they now point at
  were already in the markup, one of them referenced by nothing at all. The two
  readonly brief previews are named too, instead of reading as an anonymous
  multi-line text field.

## 0.8.0 — 2026-08-17

- Three fixes to the session comparison's model table. A long model name plus a
  discount badge overflowed the fixed-width label column and ran over the figure
  in the next column — badges now wrap below the name when it has taken the
  width, the name clips rather than breaking mid-identifier, and the column is
  wide enough for the longest name Cursor actually bills under, so the reasoning
  effort is no longer the part that falls off the end. A model only one session
  used showed "$0.00 · 0 req" against the session that never ran it, which reads
  as "used it and it came to nothing"; it now shows a dash, as the three-session
  matrix always has, and drops the "−100%" that said nothing the "only in B" tag
  did not. And the last column is named "Difference / A against B" instead of
  "Change" — two sessions have no inherent order, so an unqualified "Change"
  left the sign meaning whichever direction the reader assumed. Period
  comparisons, which do have a direction, are unchanged.
- Analyze's most-expensive-requests table names the session each request came
  from, and the name opens it. A dollar figure against a model and a timestamp
  says what a request cost but nothing about what it was for; the conversation
  behind it is the context that makes the number worth acting on. Same cell and
  same label as the request log — one helper builds both — so a name that
  resolves late resolves in both at once.
- **Auto is no longer badged "Discounted" for being Auto.** Cursor reports two
  figures per request, and for bare Auto they describe different rate cards: the
  token value is what those tokens are worth on whatever model Auto routed to,
  while the charge follows Auto's own flat rate, "regardless of which model is
  used". Reading the gap as a promotion put a permanent discount badge on Auto
  at a different size every day (44%, 46%, 48%, and one day too scattered to
  call) — it was tracking the routing, not a sale. Auto is now measured against
  Auto's own published rate, which is a comparison of like with like: on a
  sample of 13 real Auto requests it comes out at 0% off, matching the charge to
  the published rate exactly. A genuine promotion on Auto is still detected.
- The Auto rate is found on the pricing page in more shapes — including a row
  named for what it prices ("All models") under an Auto heading — and when it
  still isn't found, the log now lists the tables the page did have, with their
  headers. A built-in Auto rate is indistinguishable from a scraped one on
  screen, so the only way to tell whether the row moved, was renamed, or stopped
  being a table was to look at the page.
- **A token count Cursor never sent now reads "unknown", not 0.** An omitted
  bucket and a measured zero arrive identically, and the dashboard was printing
  `0` and `$0.0000` for both — claiming a measurement nobody made. Presence is
  now tracked separately from value, for all four buckets rather than the one
  that prompted it: the request log shows a dash, the cost breakdown gives the
  row no dollar figure and names which count is missing, the CSV leaves the cell
  empty rather than writing a zero, and the brief handed to Cursor Chat says
  "not reported by Cursor (unknown, not zero)" so the model cannot reason from
  it. A bucket is only marked unknown when every request in view omitted it —
  one reporting request keeps the total real, if partial — and nothing in the
  interface names a date or a cause, so a count that starts arriving again
  simply stops being flagged. (What prompted this: Cursor stopped sending
  `cacheWriteTokens` around 13 August 2026, while cache *reads* kept coming.)
- **Promotions are measured against what your account actually pays.** Cursor
  reports a standing enterprise reduction on each event while the list value
  stays gross, so every model on such an account looked permanently discounted
  by that amount — a 7% agreement sat a hair under the 8% promotion floor, and
  pushed every real sale that much deeper: a 33% sale was reported as 37.7%, a
  50% one as 53.5%. Detection now subtracts the agreement first, so the figure
  matches what Cursor's own usage page shows. Accounts without an agreement are
  measured exactly as before.
- Removed the tokens-per-request row from the session timeline. Cost is very
  nearly a linear function of tokens sent (r = 0.99 on real usage), so it drew
  the same shape as the plot above it, and the stacked cost bar already shows
  which bucket the tokens landed in. It also could not do the job it was added
  for: Cursor publishes no context-window figure, and a per-request token sum is
  context size × turns taken, not the size of the conversation.
- **You can now ask Cursor Chat about one session, or one request.** The
  per-session breakdown has an **Ask Cursor Chat** button that builds a brief
  about that conversation and hands it over. Pick *find where starting a fresh
  chat would have saved money*, *identify avoidable spend, ranked by dollar
  impact*, *create a cheaper plan for doing the same work*, or write your own
  question. Switch the scope to a single request and it briefs that one instead.
- **It opens Cursor Chat with the brief already in the box — and stops there.**
  Nothing is sent until you read it and press Enter. This goes through Cursor's
  own prompt deeplink, which answers with a confirmation before a chat exists, so
  there is no path here that can spend money on a prompt you haven't seen. Where
  that isn't available — an older build, a remote session, a brief past the
  deeplink's size cap — it falls back to copying and opening chat for you to
  paste, and the button says which of those actually happened rather than
  claiming the best case.
- **The brief is built to be small, because the analysis costs tokens too.** It
  never lists your requests one per line. Instead it reports the session's
  spending as six equal slices — so a 300-request session costs the same to
  describe as a 12-request one, while the growth curve, the step down at a
  compaction and the spike all survive. Anything a finding already explains
  isn't said a second time, which also stops the same dollars being counted
  twice. A 47-request session comes out around 900 tokens.
- **It tells you what it will cost before you send it.** The dialog shows the
  brief's size in tokens and roughly what that's worth as input on the model you
  actually used.
- **The brief teaches the model Cursor's cache economics up front**, which is
  what gets a useful answer in one round trip instead of three. Without it a
  model reads "68% of your spend was cache reads" as good news. It's also told
  not to ask what you were working on, since the extension never reads that and
  nobody can tell it.
- A request brief looks one request back and three forward. The state a request
  starts in is already covered by the idle gap and the session's median; what
  nothing else can tell you is whether a huge re-cache was earned back over the
  turns that followed or thrown away when the thread was abandoned.
- **The session timeline now shows each request's cost on hover**, and marks the
  turns Cursor generated to summarise the conversation with a striped bar and a
  legend. The bars carried this detail before, but only in the browser's own
  tooltip, which waits about a second and can't be reached from the keyboard.
- **The request that did the summarising is now findable.** It carries a
  `summary` chip in the request log, and the "summarising worked, then the
  context grew back" finding gained a second link straight to it — the finding is
  anchored to the request that spent the money, which is not the summary, so
  until now nothing in the product pointed at it.
- **New findings for things that changed partway through a session**, all derived
  from token counts and timestamps as ever:
  - *Switching model* — prices the requests after the switch against the rate card
    of the model you left. Both figures cover identical token counts, so a session
    whose context grew across the switch doesn't blame the new model for growth it
    had nothing to do with. Reported the other way round too when a switch saved
    money.
  - *Raising the reasoning effort* — Cursor bills every effort level of a model on
    one published row, so this can't be a price comparison: re-pricing the same
    tokens would return zero by construction. It's measured in what actually
    changes, which is how much the model writes.
  - *A price that moved under you* — the same model billed differently against the
    same published rate, which is usually a promotion starting or ending. Measured
    from what was charged rather than from the discount table, whose entries are
    per-day and so would only ever catch a session that ran across midnight.
- **Fixed: findings in an expanded request row ran off the right of the screen.**
  The request log needs `white-space: nowrap` for its twelve columns of timestamps
  and token counts, and that inherits — so in the one cell that holds sentences it
  turned each finding into a single unbreakable line. Worse, that line's width fed
  back into the table's own minimum width, so the detail row wasn't merely sitting
  in a wide table, it was what made the table wide.
- **The session timeline now prices every bar.** It used to print only a "peak"
  caption, centred under the middle of the plot — so on a three-request session
  it sat above the *smallest* bar and read as that bar's label. Each bar now
  carries its own cost, and on longer sessions, where bars are too narrow for
  that, the caption names the request the peak belongs to.
- **Fixed: Auto could lose its pricing entirely and report itself as an unknown
  model.** Auto is priced from a single field, and the fallback that covers a
  failed scrape only fired when *nothing* on the pricing page parsed. So a page
  that still listed every named model but had moved or renamed the Auto row left
  Auto with no rates — no cost breakdown, no cache-savings figure, and "this
  model isn't in the pricing table" against the most-used model in the product.
  Auto now falls back on its own, and says when the rate on screen is the
  built-in one rather than a published one.
- Briefs carry token counts, timings, costs and the conversation's name. Nothing
  you wrote is in them, because none of it is ever read.
- Fixed a red CI run. Two test blocks imported `src/webview/insights.js`
  directly; it reaches `src/shared/usageLogic.ts` through `logic.js`, and only
  Node 22 strips those types on the way in — CI runs Node 20, which throws
  `ERR_UNKNOWN_FILE_EXTENSION`. They go through the suite's bundling helper now,
  like every other module, and a test fails the suite if a raw import comes
  back.
- The test runner waits for async tests before printing the summary. One
  `test(...)` call with an async body was not awaited, so it settled after the
  exit code had been decided — a failure inside it would have left CI green.
  Async tests are tracked and awaited whether or not the call site remembers.
- The session sub-plot is labelled for what it measures. It was captioned as the
  size of the conversation, which the data cannot support: an agent request
  re-sends the whole prefix on every internal turn, so the figure is context
  size × turns taken — which is why it routinely ran to eight digits, several
  times past any model's context window. A short request then plotted low on an
  unchanged thread and read as the context having shrunk with no summary in
  sight. It is now "Tokens sent per request", and the caption says a short bar is
  a short request while only a striped bar is the thread itself getting smaller.
  Cursor publishes no context-window figure, so nothing here can show one.
- Findings are one card per kind, and a surface shows three of them. A rule that
  fired on a dozen requests used to render a dozen cards carrying the same
  explanation and the same closing tip, which buried the findings that were
  actually different somewhere below the fold. The costliest instance is the one
  on show — it is the one worth opening — and it carries a count of the others
  and their combined dollars, so nothing is hidden and no total shrinks. The rest
  are behind one "show more" button, and the brief handed to Cursor Chat says
  each finding once for the same reason.
- Discount detection no longer skips an Auto-routed request that names the model
  it was routed to. Balance and Intelligence bill at the routed model's own rate
  — which is exactly why Cursor spells it out as "Cursor Grok 4.5 (Auto
  Balanced)" — and the pricing lookup already resolves those rows to the right
  model. Detection was still discarding them on the word "auto", alongside bare
  Auto, whose model genuinely cannot be named. On an account where Cursor omits
  the per-request list value, that left every routed request permanently
  unmeasurable: a promotion could be running on the model and no estimate would
  ever reflect it.

## 0.7.4 — 2026-08-16

- **Findings now point at the request they're about, and follow you around.**
  Each one carries what the pattern cost and a link through to the request or
  the session, and the same finding shows up wherever you're looking — on the
  Overview, on the session it belongs to, and as a marker on the row itself.
- **Every request can now show what its cost was made of.** Click a row in the
  request log to split it into cache read, cache write, output and input. On a
  long agent turn this is usually the whole story: the answer is a few cents and
  the rest is re-reading context. The parts always add up to the cost shown
  beside them, discounts included.
- **The request log names the conversation each request came from**, and links
  to it — so an expensive row no longer means going hunting for which chat it
  belonged to. Conversations Cursor has no name for are shortened the same way
  the session list shortens them, rather than printing a raw id in full.
- **New per-session view.** Opens from the session list, a request row, or a
  finding. Shows where that session's money went by token bucket, the findings
  anchored to it, and a bar per request in the order you asked them, with the
  context share shaded — so a session that got expensive as it went looks
  expensive.
- **New detectors**, all derived from token counts and timestamps only:
  - *Stale resume* — coming back to a thread after hours means the prompt cache
    has expired, and the whole accumulated context is re-written at full price
    before any work happens. Reports what that re-caching cost.
  - *Context blowup* — a request whose cache reads are far above the rest of its
    session, and which is almost entirely re-read context.
  - *Summarising worked* / *the context grew back* — Cursor compacting a
    conversation is now recognised, and judged on what happened next: cache
    reads that stayed down, or a thread that re-inflated anyway.
  - *Spend concentration* — when a handful of requests are most of the period.
  - *What every new chat costs before you type* — measured from your cold
    starts. That baseline is your system prompt, rules files and the tool
    definitions of every connected MCP server.
- **Fixed: conversation compactions were being counted as cold starts.** They
  read no cache, so the old test caught them — which inflated the cold-start
  count and produced backwards advice, since summarising a thread is the
  opposite of starting one. They're told apart on cache writes now.
- **Cache findings no longer argue against themselves.** "Keep long agent
  threads open" is good advice until the threads are what ran the bill up; on a
  period whose dearest requests are mostly re-read context, that tip now says so
  instead.
- **Fixed: a finding's dollar figure could land beside the wrong sentence.** It
  was floated into the finding's heading, and a float leaves the heading's line
  box — so as soon as a title wrapped to two lines the figure dropped down next
  to the body paragraph and read as an annotation on that instead.
- **Fixed: finding titles rendered as small-caps captions inside the request-row
  detail and the session breakdown.** Both panels label their own sections that
  way, and the rule was reaching the finding cards' titles too — which are full
  sentences, and close to unreadable in uppercase.
- **A request row with nothing flagged now gives its whole width to the cost
  breakdown**, instead of holding an empty column open beside it.
- **Fixed: the brief's cost estimate quoted the wrong rate card.** It priced
  against the session's *first* request; a session that opened on one model and
  ran on another named a model the user barely used. It uses the session's
  most-used model now.
- **Fixed: a session opened straight from a request row kept showing its raw id**
  when its name arrived from Cursor's database a moment after the panel opened.
- **Fixed: the timeline tooltip stayed put when the panel behind it scrolled.**
- **Fixed: the dashboard could fail on a very large period.** Both the session
  timeline and the new-chat-overhead baseline sized themselves by spreading the
  whole request list into `Math.max`/`Math.min`, which throws once the list is
  long enough — so it only ever broke for the heaviest users.
- **Fixed: an error on the local browser server after it started listening could
  take the extension host down with it.** It's logged now.
- **The four token buckets are now four genuinely different colours.** Cache read
  and cache write were two steps of the same orange — as adjacent bands of one
  bar, close enough that neither the chart nor its legend could be read — and
  input was a grey so desaturated it looked like missing data. The replacement
  set was picked by running candidates through a colour-blindness and contrast
  validator rather than by eye, and it's held to the strictest gate: every pair
  distinguishable, not just the ones that touch in the bar, since the legend
  stacks all four. Segments are separated by a hairline gap as well, so two
  fills meeting never blend into one band. Dark themes get their own steps —
  until now a dark IDE was drawing the light palette.
- **The session view has a second chart: the context behind each request.** One
  bar per request under the cost plot, same columns in the same order, showing
  everything that went *up* — your prompt plus the conversation re-read from
  cache. It's what makes a compaction legible: the summary shows as a tall
  striped column, then the context steps down and stays down until the thread
  grows back. Deliberately a second chart rather than a second line on the cost
  one; dollars and tokens share no scale, and overlaying them would suggest a
  relationship the numbers don't contain. Cursor publishes no context-size
  figure, so this is measured from the token counts and says so.
- **Fixed: the session summary claimed work that never happened, and counted
  your prompts as answers.** It read "X% was context handling — re-reading and
  re-caching the conversation — and Y% was the answers themselves". Two things
  wrong with that. It named re-caching on sessions that never wrote a byte to
  cache, right beside a Cache write row reading $0. And the leftover Y% is
  output *plus* input — input being the prompt you sent, not an answer — so on a
  session that was 15% output and 12% input it reported the answers as 27%,
  nearly double. Each half is now named for what it is, and only the cache
  activity that actually happened is mentioned. The same wording was going into
  the brief handed to Cursor Chat, where it was teaching the model a false
  premise about the one split the whole analysis argues from.
- **Cache write reads 0 on every request for some accounts.** Whether that is
  Cursor reporting a real zero or this extension reading a key that isn't there
  could not be told apart from the outside, so two things changed: token counts
  are now read under several spellings (by presence, so a genuine 0 is never
  overridden), and the shape of the usage payload's `tokenUsage` is written to
  the log on each load — `Cursor Usage: Show Logs` — so it can be settled from
  real data rather than guessed at.
- A bucket that cost exactly nothing now shows `$0` rather than `$0.0000`.
- **The sessions table no longer scrolls sideways.** A single long Models cell
  was setting the whole table's minimum width. Model names now wrap between
  each other while staying intact individually, and each column header sits
  over its own data instead of over the right edge every column shared.

## 0.7.3 — 2026-08-16

- **Added "Open in Browser."** A new "Open in browser ↗" link in the dashboard
  header (and a matching `Cursor Usage: Open in Browser` command) opens the
  same dashboard in your default browser instead of the IDE panel. It's
  served by a small local HTTP server on `127.0.0.1` — same local data
  access as the webview, same extension host underneath, just reachable from
  a real browser tab. Every call that returns usage data is gated by a random
  per-session token, and the server is bound to loopback only, so nothing else
  on the machine (or network) can reach it. The tab keeps working across a
  reload, and **follows your OS light/dark preference** — there's no editor
  theme to inherit out there. **Export CSV** downloads through the browser
  rather than opening a save dialog back in the IDE, where you wouldn't see it.

## 0.7.2 — 2026-08-15

- **Added a narrated walkthrough video** to the README and the website: a
  60-second tour in the README, and the full two-and-a-half-minute version on
  [the site](https://iair0007.github.io/cursor-usage/). Both are generated by a
  reproducible pipeline (`demo/`) that drives the real webview bundle against
  synthetic usage data, so the video can be re-cut whenever the UI changes
  rather than being a one-off screen recording.
- **Fixed the website's icon never loading.** GitHub Pages serves `docs/` as
  the site root, so the hero image and favicon pointed at `../resources/`,
  outside the published tree, and 404'd on every visit.
- **Stopped packaging the demo harness into the `.vsix`.** `demo/` had no
  `.vscodeignore` entry, so the harness — and any rendered video sitting in
  `demo/out/` at package time — would have shipped to everyone who installed
  the extension.

## 0.7.1 — 2026-08-15

- **Fixed the date pickers looking unusable in a dark theme.** The calendar
  icon on the From/To fields — and the popup it opens — is drawn by the
  browser itself rather than by this extension's CSS, and without being told
  which palette to use it defaulted to a light-mode icon rendered dark-on-dark
  against the dark input: invisible, and impossible to click to change the
  date. Now keyed off the `vscode-dark`/`vscode-light`/`vscode-high-contrast`
  classes VS Code itself stamps on `<body>` to match the active theme, so the
  native chrome follows suit. Scoped to those classes specifically — a host
  that doesn't set one (unlikely, but the failure mode this branch used to be
  in) leaves rendering exactly as it was before, rather than guessing.

## 0.7.0 — 2026-08-14

- **Fixed discounts never being detected on the models Cursor discounts most.**
  Grok and Composer are Cursor's own hosted models, priced in a table that
  publishes no cache-write rate — and a request carrying cache-write tokens
  used to be discarded rather than priced against a substituted rate. Since
  agent requests essentially always carry them, every sample was thrown away
  and the count never reached the threshold, so a promotion on those models was
  undetectable at any volume. The unknown is now bounded instead of avoided:
  the true rate can't be below zero or above the input rate it stands in for,
  so the day is priced both ways and a discount has to hold at the stingy end
  too. Cache writes that are really free, read against a substitution, are the
  false positive the old behaviour guarded against — the floor still rejects
  those, and a day it can't settle stays offered for manual entry rather than
  being recorded as "no promotion". Models with a published cache-write rate
  are unaffected.
- **Fixed the "Current plan" chip only appearing when the selected date range
  happened to contain the evidence.** An account that switched plans on the 3rd
  stayed invisible on "Today" or "7 days" for the rest of the month, even though
  those are exactly when someone would reach for it. This calendar month's own
  events are now checked as well as the selected range — once per month, cached
  for the session, not on every load. The two windows answer different
  questions and both still count: the month keeps the chip independent of what
  is on screen, while the loaded range is the only thing that can still see a
  change from an earlier month. A boundary already known is only forgotten by a
  range that straddles it and finds nothing, since a range sitting wholly on one
  side never held the proof to begin with — which also keeps the warning about
  a range spanning two pricing systems on screen where it belongs.
- **Fixed the session comparison's two tables drifting out of alignment.**
  The model breakdown reused the period comparison's table markup, which
  auto-sizes its own columns; put a few rows below a table with different
  content, that produced two different column widths for the same sessions.
  Both tables now share a fixed layout and a matching row-label column.
- **The session comparison's header now stays in view while scrolling.** A
  four-session table runs well past one screen, and a figure with no header
  above it doesn't say which session it's for. Fixed a nested scroll
  container that silently absorbed the sticky positioning meant for the outer
  one — a spec quirk, not a typo: setting `overflow-x` on an element quietly
  promotes its own `overflow-y` from `visible` to `auto` even when written
  explicitly, which is what created the extra scroller in the first place.
- **Fixed a failed lookup being cached.** The quota, plan and spend-cap cache
  stored the fallback that a failed request resolved to, so one dropped
  connection meant up to ten minutes with no plan name or spend cap even though
  the next request would have succeeded. Only successes are cached now.
- **Fixed a pinned comparison quietly taking over the dashboard.** Pinning
  Compare periods' left column to fixed dates was stored and restored, so
  opening the dashboard days later gave a comparison that ignored every date in
  the toolbar — and, because the Overview's trend badge has no honest delta
  while a pin is in force, that card silently lost its badge and its link to
  the comparison too. The only control that undid it was the column header's
  date button, which the panel doesn't draw when the baseline comes back empty:
  pin a single day, and there was no way back at all. The pin now lasts only as
  long as the dashboard is open, announces itself wherever it applies, carries
  its own "Follow the filter bar" button in every state, and the Overview says
  the trend is unavailable because of it rather than showing nothing.
- **Discounts are now measured from Cursor's own figures instead of inferred
  from the rate table.** Cursor reports two numbers for a request: what the
  tokens are worth at list, and what it actually charged. On a promotion those
  diverge, and the gap between them is the discount — exactly, with no
  published rates involved. Detection had been comparing the *list* figure
  against the *list* rate table, which by construction reads as no discount, so
  a live promotion was invisible no matter how much you used the model.
  Measuring the two against each other also removes every weakness of the old
  route at once: a stale or restructured pricing page, a model too new to be in
  it, an unpublished cache-write rate, and Auto — which the rate table can never
  price, because Cursor doesn't say which model it routed to.
- **A measured discount is reported as measured, not rounded to a sale.** The
  figure used to snap to the nearest 5%, which is right when recovering the
  round number a promotion probably was from a noisy estimate, and wrong once
  the number is measured: 53.5% became "55% off", asserting a rate nobody
  announced, and further from the 50% headline than the measurement it
  replaced. Badges now read "−53% vs list" rather than "−53% off", because what
  is known is the saving against Cursor's published price — an announced sale
  can land a few points either side of that once its own terms and cent
  rounding are through with it. A figure still inferred from the rate table is
  still snapped, since there the round number is the whole point.
- **Promotions now surface as tips, on Overview and in Analyze.** A promotion
  is only useful while it is running, and Cursor announces them nowhere this
  dashboard can read — so once one is measured it is worth saying so. Two
  findings: what the discounts actually took off the bill, measured the same way
  they were found, and — when a meaningful share of the period ran on other
  models on the same days — that a discounted model was available while it did.
  The second carries a deadline, so it takes the Overview card ahead of an
  equally urgent finding about a spending pattern, which will still be there
  next week. Both stay quiet below a floor in dollars and in share, so a small
  range and an account already using the discounted model say nothing.
- **Auto now shows which model the router picked.** Balance and Intelligence
  bill at the routed model's own rate, and Cursor names that model in the row
  when the team leaves the underlying model on display — so a request that cost
  Grok 4.5's rate and one that cost Auto's bundled rate no longer both read as a
  flat "Auto". Rows read "Auto Balance → Grok 4.5" throughout: the request log,
  the session lists, the comparison tables, the model filter and the export.
  Bare Auto, where Cursor names nothing, is unchanged.
- **Discount badges no longer print a percentage.** What is measured is the gap
  between Cursor's list value and what it charged, and that lands a few points
  off whatever sale was announced — 53% against a 50% promotion. On a badge that
  read as a precise claim about the promotion's terms when it is only ever
  precise about your bill. Badges say "Discounted"; the measured figure is one
  hover away, and the discount editor still lists every entry you added with
  its exact percentage, since that is where the number is acted on.
- **Updated the Model column's tooltip** to explain the two things "Auto" can
  now mean since routed rows started naming their model: plain "Auto" is Cursor
  picking a model and not saying which (billed and priced at Auto's bundled
  rate), while "Auto Balance → Grok 4.5" is Balance/Intelligence mode, billed
  and priced at that model's own rate. The actual charge shown is always
  Cursor's real number either way — only the estimates depend on which rate
  applies.
- **Fixed Auto losing its rates entirely.** cursor.com now publishes Auto's
  bundled price as an ordinary row in a pricing table ("Auto Cost", under Auto
  modes) rather than as the label-and-value list the old "Auto pricing" heading
  carried. The parser only understood the old shape, so Auto came back with no
  rates at all — no cache-savings figure on an Auto request, and nothing to
  price a plain "auto"/"default" row against, on the mode most requests run in.
  Both shapes are read now.
- **Fixed two models being priced against the wrong row.** A request billed at
  a Fast rate matched the standard row — "cursor-grok-4.6-high-fast" doesn't
  contain "grok-4-6-fast" as a substring, since "high" sits in the middle — so
  its estimates were about half what it really cost. And a row Cursor names for
  the model Auto settled on, like "Cursor Grok 4.5 (Auto Balanced)", was priced
  at Auto's rate purely because the word "auto" appeared in it. Auto is billed
  two different ways and the row was naming which: Cost mode keeps Auto's
  bundled flat rate whatever it routes to, while Balance and Intelligence bill
  at the routed model's own rate — which is precisely why Cursor names the
  model in those rows. Routed requests were priced at roughly half what they
  cost. Rows are matched word-wise now, most specific first; the bundled rate
  is kept for bare Auto and for Cost mode, and a named Balance/Intelligence row
  prices against the model beside it.
- **Fixed a discount being missing from the estimates for the model it was
  found on.** Detection keys on the name Cursor bills under
  ("cursor-grok-4.6-high"), while the Simulator asks by catalog row ("Grok
  4.6") — the same model at a different reasoning effort, on one published
  rate. The promotion showed in the chips and on its own request's row, and
  every "what would this have cost on Grok 4.6" estimate below it was still
  priced at full price, with the asterisk saying so. Detected discounts now
  carry the published row they belong to and resolve through it. A variant on a
  genuinely different row — Fast, at its own rate — still doesn't borrow it.
- **A measured discount no longer needs three requests to confirm it.** The
  three-request rule guarded against a noisy *estimate*; where both figures come
  from Cursor there is no estimate, only the half-cent each was rounded to. One
  request is now enough whenever it is large enough that rounding can't move the
  result by more than a point — which is most of them. Requests small enough for
  cent-rounding to swamp the gap still need the corroboration, and anything
  falling back to the rate table keeps the old rule.
- **The Simulator now distinguishes "checked and found nothing" from "couldn't
  measure".** Both used to read "None found in this date range", and only one of
  them means the estimates below can be trusted.
- **Fixed the fifth session appearing to be selected.** Ticking past the
  four-session limit left the box ticked for a row that was never added: it got
  no slot letter and was missing from the comparison, and the alert explaining
  why is at the top of the page, out of sight from the bottom of a long list.
- **The model breakdown tells "didn't use it" from "used it for nothing".** A
  model was listed by cost, so a session that used one on included or unpriced
  requests — Auto, on a plan that bundles them — showed a dash meaning it had
  never touched it, or dropped out of the table entirely. Rows are built from
  the requests themselves now, and each figure carries its request count.
- **The log now explains why a discount was or wasn't found.** Every load writes
  which billing fields the API actually returned, per model, and what discount
  detection concluded for each model-day — measured, too few requests to tell,
  scattered, or a real gap. "No discount found" had several very different
  causes and none of them were visible from outside, which is what let a live
  promotion pass for a range that had been checked. Counts and model names only:
  no conversation ids, no email, nothing derived from a prompt, since this is
  the channel people paste into bug reports.
- **Refresh now picks up renamed chats.** Cursor names a conversation once it
  has a subject, and the index those names come from is cached for five minutes
  to keep a multi-gigabyte file off the scroll path. Refresh drops it, rather
  than showing the old name until the cache expires on its own. A name lookup
  that fails outright is also no longer remembered as "this conversation has no
  name", which left raw ids on screen until the dashboard was reopened.
- **Fixed the Overview trend badge comparing two unrelated periods.** Once the
  comparison's left column is pinned, its baseline belongs to that pinned
  window, not to the range the Overview card is showing. The badge is now
  hidden while a pin is in force; Compare periods keeps its own paired figures.
- **Sessions**, a new sub-tab on Analyze. The requests in your selected period,
  grouped by the conversation they came from: how many sessions, what each
  cost, its share of the period, how long it ran and which models it reached
  for. Pick any two to line them up side by side — cost, requests, priciest
  request, tokens in/out/cached, cache hit rate and savings, cold starts,
  errored requests, and a model-by-model breakdown. Pick the dates in the
  toolbar first and the list follows — there is no second date control to keep
  in sync. The model filter scopes it too, and the note under the list says so
  when one is set, since a session that reached for several models is then
  counted for one model's requests alone. Search matches names as well as ids
  and models, across the whole period rather than the page you are looking at.
- **The session comparison moved into its own dialog, opened from a selection
  tray.** Ticking rows used to draw a table at the top of the panel, so picking
  two sessions from the bottom of a long list looked like nothing had happened.
  Selected sessions now appear as removable chips in a bar pinned to the bottom
  of the view, with a Compare button that opens the comparison over the list
  instead of under the scroll position. Escape or the backdrop closes it.
- **Up to four sessions can be compared at once.** With two, the Difference
  column stays and reads A against B. With three or four it gives way to the
  best and worst figure in each row being highlighted, and every column saying
  how it differs from the base — any session can be made the base.
- **"Only rows that differ"** hides the figures the selected sessions agree on,
  judged at the precision on screen.
- The session list is paged — 20 at a time, or 50 or 100 — instead of showing
  25 with a "show all". Sorting and filtering apply across the whole list, not
  just the visible page.
- The session list sorts by any of its columns — name, start, how long it ran,
  requests or cost — from the column headers, the same way the request log
  does. Sorting happens before the list is capped, so ordering by duration
  reaches past the first 25 rather than reshuffling them. The choice is
  remembered between sessions.
- **Sessions are named, not numbered.** The conversation names Cursor shows in
  its own chat list are read from its local database on your machine and joined
  to the usage rows there — nothing from that database is sent anywhere, and
  only names are read from it, never prompts, messages or code. The filter box
  searches names too. Conversations that can't be named keep their id, which is
  also what happens if the lookup isn't possible at all.
- Differences between two sessions are coloured only where a direction exists:
  cheaper, better-cached and fewer cold starts are wins whichever session they
  belong to, while requests, tokens and pace stay neutral. Two conversations
  aren't a before and an after, so a longer one having more requests isn't a
  regression to paint amber.
- Requests now carry the conversation id the API reports. It was being read and
  then dropped before it reached the dashboard, so nothing could be grouped by
  conversation. Where an account's requests carry no id — Cursor only reports
  one on some plans and API versions — the tab says so plainly instead of
  showing an empty list.

## 0.6.3 — 2026-08-13

- **The Simulator now offers models cursor.com's pricing page doesn't name.**
  Cursor bills some requests under variant strings that encode a reasoning
  level — `cursor-grok-4.6-high`, for instance — which the published pricing
  table never lists under that name, so those models were unselectable in
  either Simulator picker even with requests using them sitting right there in
  your log. The model list is now the union of the pricing table and the
  models in your own usage data. A model with no published rate stays listed
  rather than disappearing, flagged "no published rate" instead of priced.
- The Simulator's default comparison models are no longer a fixed list of
  names that went stale every time Cursor shipped a new model — they're now
  whichever models you actually run, most-used first.
- **Your Simulator comparison selection survives closing the dashboard.** It
  was kept only in the webview's own state, which is discarded when the panel
  closes; reopening reset it to the defaults every time. Preferences (compare
  selection, date range, cost mode, Analyze prefs) now live in the extension's
  persistent storage instead.
- Fixed the comparison selection changing on its own: unchecking a model while
  comparing a request that used a different model no longer silently dropped
  that request's model from your saved selection, an emptied selection is no
  longer mistaken for "never chosen" and reset to the defaults, and a saved
  selection with nothing in common with the current request is honored rather
  than replaced.

- **Grok and Composer are priced from the right table.** cursor.com prices
  Cursor's own hosted models in a separate "Cursor Models" table from the
  third-party ones, and the scraper only ever read the latter — so Grok 4.6
  came back with no rate at all, and the simulator listed the billed variant
  string (`cursor-grok-4.6-high`) as its own unpriced pseudo-model. Reasoning
  effort is part of that string, but it changes how many tokens a request uses,
  not the price per token: there is one published rate per model. The parser now
  reads every pricing table on the page, a `-fast` variant prices off its own
  Fast row rather than the base model's, and a variant string that resolves to a
  published rate is no longer offered as a separate row to compare against.
- **Limited-time promotions are accounted for.** Cursor periodically discounts
  a model for a week and announces it in prose, so the published rate table
  keeps showing list price. Requests you actually made were never affected —
  they carry Cursor's own billed figure — but the simulator's "what would this
  have cost on model X" column was quietly pricing at list. Where you have run
  a model, the discount is now **measured** from your own billing (billed token
  value against the published rates, needing several requests in a day that
  agree before it will say so); where you have not, the Simulator offers to let
  you **record** the promotion by hand, and remembers it. Discounted models are
  badged wherever they appear, with detected and hand-entered discounts kept
  visibly distinct.
- The Simulator explains that caveat **once, on first visit**, in a dismissable
  dialog rather than in fine print nobody reads — the tab shows an estimate that
  can be quietly too high, and a user has no way to guess that from the numbers.
  It is reachable afterwards from "What's this?", for the day someone notices a
  figure looks wrong. Estimates priced at full price because nothing could be
  checked carry an asterisk and a footnote saying so, which stays put even after
  the offer to add a discount is dismissed: dismissing an offer is not the same
  as asking to stop being told which numbers are uncertain.
- **Far fewer calls to cursor.com.** The quota, plan and spend-cap lookups now
  sit behind a short cache with in-flight de-duplication. Opening the dashboard
  used to fire dozens of identical requests: the panel asks for usage and for
  the budget, the budget asks for cycle usage, that asks for the quota, and the
  status bar refreshes after each one. Usage responses were already cached;
  these three were not.
- **Both comparison columns are editable**, from their own headers. The custom
  option previously only moved the baseline, which made "this sprint vs last
  sprint" impossible to express. Pinning the left column detaches the
  comparison from the filter bar and says so. The "Custom" chip is gone with
  it — it did the same job from a place that could only reach one of the two
  periods — leaving the presets as baseline shortcuts and the headers as the
  way to set anything else.
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
