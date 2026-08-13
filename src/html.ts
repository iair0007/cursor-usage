import * as vscode from 'vscode';

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/**
 * Dashboard markup — ported from the original web app's index.html. The body
 * structure and element ids are kept identical so the ported main.js works
 * unchanged; only the asset loading (CSP, webview URIs, bundled Chart.js)
 * differs.
 */
export function getDashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const styles = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
  <title>Cursor Usage Dashboard</title>
  <link rel="stylesheet" href="${styles}" />
</head>
<body>
  <div class="app">
    <header class="header">
      <div class="header-top">
        <div class="brand">
          <h1>Cursor Usage</h1>
          <p id="authLabel">Loading…</p>
          <p class="footer-links">
            <a href="https://cursor.com/dashboard/usage">Official usage dashboard ↗</a>
            <span>·</span>
            <a href="https://cursor.com/docs/models-and-pricing">Model pricing ↗</a>
          </p>
        </div>
        <nav class="app-nav" aria-label="Main">
          <button type="button" class="nav-item active" data-app="overview">Overview</button>
          <button type="button" class="nav-item" data-app="usage">Requests</button>
          <button type="button" class="nav-item" data-app="analyze">Analyze</button>
          <button type="button" class="nav-item" data-app="simulator">Simulator</button>
        </nav>
      </div>

      <div class="filter-bar">
        <div class="filter-main">
          <div class="date-presets" role="group" aria-label="Date range">
            <span class="presets-label">Period</span>
            <button type="button" class="preset-btn" data-preset="today">Today</button>
            <button type="button" class="preset-btn" data-preset="7d">7 days</button>
            <button type="button" class="preset-btn active" data-preset="30d">30 days</button>
            <button type="button" class="preset-btn" data-preset="mtd">Month to date</button>
            <button type="button" class="preset-btn hidden" data-preset="plan" id="planPresetBtn"
              title="Only requests priced the way your plan prices them today. Earlier requests used a different billing system, so their dollars aren't comparable.">Current plan</button>
            <button type="button" class="preset-btn" data-preset="custom">Custom</button>
          </div>
          <div class="filter-fields">
            <label>
              <span>From</span>
              <input type="date" id="startDate" />
            </label>
            <label>
              <span>To</span>
              <input type="date" id="endDate" />
            </label>
            <label>
              <span>Model</span>
              <select id="modelFilter"><option value="">All models</option></select>
            </label>
          </div>
        </div>
        <div class="filter-actions">
          <span id="filterSummary" class="filter-summary"></span>
          <div class="date-presets" role="group" aria-label="Cost mode" id="costModeToggle">
            <span class="presets-label">Costs <span class="tip" tabindex="0" data-tip="What-if: the API-equivalent value of your tokens (what they would cost if billed at published rates) — best for optimizing. Billed: what your plan actually charged.">ⓘ</span></span>
            <button type="button" class="preset-btn cost-mode-btn active" data-cost-mode="value">What-if</button>
            <button type="button" class="preset-btn cost-mode-btn" data-cost-mode="billed">Billed</button>
          </div>
          <button id="refreshBtn" class="btn primary">Refresh</button>
          <button id="exportBtn" class="btn">Export CSV</button>
        </div>
      </div>
    </header>

    <div id="alert" class="alert hidden"></div>
    <div id="billingNotice" class="alert info hidden"></div>
    <div id="loading" class="loading hidden">Loading usage…</div>

    <section id="overviewView">
      <section id="planCycleCard" class="plan-cycle hidden" aria-label="Plan and billing cycle">
        <div class="plan-cycle-top">
          <div class="plan-cycle-identity">
            <svg class="plan-cycle-ring hidden" id="planCycleRing" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
              <circle class="ring-track" cx="18" cy="18" r="15.5" />
              <circle class="ring-fill" id="planCycleRingFill" cx="18" cy="18" r="15.5" />
            </svg>
            <div>
              <span class="plan-cycle-eyebrow">Your plan</span>
              <h2 id="planCycleName">—</h2>
            </div>
          </div>
          <div class="plan-cycle-reset" id="planCycleReset"></div>
        </div>
        <div class="plan-cycle-bar-row hidden" id="planCycleBarRow">
          <div class="plan-cycle-bar-track"><div class="plan-cycle-bar-fill" id="planCycleBarFill"></div></div>
          <span class="plan-cycle-bar-label" id="planCycleBarLabel"></span>
        </div>
        <p class="plan-cycle-note" id="planCycleNote"></p>
        <p class="plan-cycle-note plan-cycle-scope hidden" id="planCycleScope"></p>
      </section>

      <!--
        No period/cost-mode row here: the filter bar above is shown on this view
        and already carries both, plus the date inputs, the model filter,
        Refresh and Export. A second copy of a subset of the same controls, two
        rows below the first, reads as a different filter than the one in force.
      -->

      <div class="ov-stats">
        <article class="ov-stat ov-stat-primary">
          <span class="ov-stat-label" id="ovCostLabel">Token cost</span>
          <span class="ov-stat-value" id="ovCost">—</span>
          <span class="ov-stat-sub" id="ovCostSub"></span>
        </article>
        <article class="ov-stat">
          <span class="ov-stat-label">Requests</span>
          <span class="ov-stat-value" id="ovRequests">—</span>
          <span class="ov-stat-sub" id="ovRequestsSub"></span>
        </article>
        <article class="ov-stat">
          <span class="ov-stat-label">Cache savings</span>
          <span class="ov-stat-value ov-stat-green" id="ovSavings">—</span>
          <span class="ov-stat-sub" id="ovSavingsSub"></span>
        </article>
      </div>

      <div class="ov-lower">
        <article class="panel ov-trend-panel">
          <div class="ov-trend-head">
            <h3>Daily spend</h3>
            <span class="panel-desc" id="ovTrendRange"></span>
          </div>
          <div class="chart-box ov-sparkline-box"><canvas id="ovSparkline"></canvas></div>
          <p class="ov-empty-note hidden" id="ovSparklineEmpty">No requests in this period yet.</p>
        </article>

        <article class="panel ov-insight-panel hidden" id="ovInsightPanel">
          <h3>Worth knowing</h3>
          <div class="finding-card ov-insight-card" id="ovInsightCard"></div>
          <button type="button" class="btn-link-inline" id="ovSeeAllInsights">See all insights →</button>
        </article>
      </div>

      <button type="button" class="btn ov-details-btn" id="ovViewRequests">View full request log &amp; charts →</button>
    </section>

    <main id="usageView" class="hidden">
      <section class="kpi-strip" aria-label="Summary">
        <article class="kpi">
          <span class="kpi-label">Requests <span class="tip" tabindex="0" data-tip="Number of API requests in the filtered period.">ⓘ</span></span>
          <span class="kpi-value" id="kpiRequests">—</span>
          <span class="kpi-sub" id="kpiRequestsSub"></span>
        </article>
        <article class="kpi kpi-primary">
          <span class="kpi-label"><span id="kpiCostLabelText">Token cost</span> <span class="tip" tabindex="0" data-tip="Sum of model/API token charges from Cursor (input + output + cache tokens). Does not include flat usage fees on some plans. Use the Costs toggle to switch between what-if value and actually billed amounts.">ⓘ</span></span>
          <span class="kpi-value" id="kpiTotalCost">—</span>
          <span class="kpi-sub" id="kpiCostSub"></span>
          <span class="kpi-sub kpi-fees hidden" id="kpiCostFees"></span>
        </article>
        <article class="kpi kpi-green">
          <span class="kpi-label">Cache savings <span class="tip" tabindex="0" data-tip="Estimated savings per request using that request's model pricing from Cursor docs. Auto requests use Auto rates; named models use their listed rates.">ⓘ</span></span>
          <span class="kpi-value" id="kpiSavings">—</span>
          <span class="kpi-sub" id="kpiSavingsSub"></span>
        </article>
        <article class="kpi">
          <span class="kpi-label">Avg token cost / request <span class="tip" tabindex="0" data-tip="Average token/API cost per request (with cache). Subtext shows average if cache-read tokens were billed as full input.">ⓘ</span></span>
          <span class="kpi-value" id="kpiAvg">—</span>
          <span class="kpi-sub" id="kpiAvgSub"></span>
        </article>
      </section>

      <div class="view-toggle" role="tablist" aria-label="Usage views">
        <button type="button" class="view-tab active" data-panel="requests" role="tab" aria-selected="true">Requests</button>
        <button type="button" class="view-tab" data-panel="analytics" role="tab" aria-selected="false">Analytics</button>
      </div>

      <section id="panelRequests" class="panel table-panel" role="tabpanel">
        <div class="table-head">
          <div>
            <h3>Request log</h3>
            <p class="table-desc" id="tableCostDesc">Token cost per request (not the flat usage fee). Hover ⓘ on column headers for help.</p>
          </div>
          <div class="table-controls">
            <label class="inline-label">
              Rows
              <select id="pageSize">
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </label>
          </div>
        </div>
        <div class="table-scroll">
          <table id="requestsTable">
            <thead>
              <tr>
                <th scope="col" tabindex="0" data-sort="timestampMs">Time</th>
                <th scope="col" tabindex="0" data-sort="model">Model <span class="tip" tabindex="0" data-tip="Auto = Cursor picks the model automatically. Cache savings use Auto pricing from Cursor docs. Named models use their own rates.">ⓘ</span></th>
                <th scope="col" tabindex="0" data-sort="cost"><span id="colCostLabelText">Token cost</span> <span class="tip" tabindex="0" data-tip="Model/API charge from token usage — the number that reflects how expensive the request actually was. Follows the Costs toggle: What-if shows the API-equivalent value of the tokens, Billed shows what your plan charged.">ⓘ</span></th>
                <th scope="col" tabindex="0" data-sort="requestCharge" id="colUsageFee" class="hidden">Usage fee <span class="tip" tabindex="0" data-tip="Extra flat per-request charge on usage-based plans (e.g. $0.04). Not part of token cost above.">ⓘ</span></th>
                <th scope="col" tabindex="0" data-sort="cacheSavings">Cache saved <span class="tip" tabindex="0" data-tip="Per request: cache-read tokens × (input rate − cache-read rate) using that request's model pricing. Hover a cell to see which rate was used.">ⓘ</span></th>
                <th scope="col" tabindex="0" data-sort="inputTokens">Input</th>
                <th scope="col" tabindex="0" data-sort="outputTokens">Output</th>
                <th scope="col" tabindex="0" data-sort="cacheReadTokens">Cache read</th>
                <th scope="col" tabindex="0" data-sort="cacheWriteTokens">Cache write</th>
                <th scope="col" tabindex="0" data-sort="totalTokens">Total</th>
                <th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody id="tableBody"></tbody>
            <tfoot id="tableFoot"></tfoot>
          </table>
        </div>
        <div class="pagination">
          <button id="prevPage" class="btn" disabled>Previous</button>
          <span id="pageInfo">—</span>
          <button id="nextPage" class="btn" disabled>Next</button>
        </div>
      </section>

      <section id="panelAnalytics" class="panel-analytics hidden" role="tabpanel">
        <p class="analytics-intro">Trends for your filtered period. For actionable recommendations and Cursor Chat briefs, open the <button type="button" class="btn-link-inline" id="goAnalyzeTab">Analyze</button> tab.</p>
        <p id="analyticsEmpty" class="panel analytics-empty hidden">No requests in this period, so there is nothing to chart yet. Widen the date range or clear the model filter.</p>
        <div class="analytics-stats" id="analyticsStats"></div>

        <article class="panel analytics-chart-main" id="analyticsChartMain">
          <h3 id="chartCostTitle">Daily token cost</h3>
          <p class="panel-desc" id="chartCostDesc">How spend changed day to day · excludes flat usage fees</p>
          <div class="chart-box chart-box-lg"><canvas id="chartCost"></canvas></div>
        </article>
        <div class="analytics-chart-row" id="analyticsChartRow">
          <article class="panel">
            <h3>Cost by model</h3>
            <p class="panel-desc" id="chartModelsDesc">Top models by token/API spend</p>
            <div class="chart-box"><canvas id="chartModels"></canvas></div>
          </article>
          <article class="panel">
            <h3>Token volume</h3>
            <p class="panel-desc">Input, output, and cache tokens · log scale when cache dominates</p>
            <div class="chart-box"><canvas id="chartTokens"></canvas></div>
          </article>
        </div>
      </section>
    </main>

    <section id="analyzeView" class="hidden">
      <div id="analyzeEmpty" class="analyze-empty panel hidden">
        <h2>No usage data yet</h2>
        <p>Load a date range from the filters above, then return here for insights and Cursor Chat briefs.</p>
      </div>

      <!--
        Same sub-tab pattern the request log uses for its charts. Both views
        here answer "why does my bill look like this" — findings answer it from
        one period, the comparison answers it from two — so they belong on the
        same tab without stacking into one very long scroll.
      -->
      <div class="view-toggle hidden" role="tablist" aria-label="Analyze views" id="analyzeTabs">
        <button type="button" class="view-tab active" data-analyze-panel="findings" role="tab" aria-selected="true">Findings</button>
        <button type="button" class="view-tab" data-analyze-panel="compare" role="tab" aria-selected="false">Compare periods</button>
      </div>

      <div id="analyzeCompare" class="hidden" role="tabpanel">
        <!--
          The baseline picker lives here rather than in the filter bar above.
          The filter bar is the one answer to "what period am I looking at" on
          every tab; a second range next to it reads as a competing filter
          rather than as this panel's comparison. Both windows are always
          spelled out in the column headers, so neither can be guessed at.
        -->
        <article class="panel compare-panel" id="comparePanel">
          <div class="compare-head">
            <div>
              <h3>Compare periods</h3>
              <p class="panel-desc">Your selected period against another, and which models moved.</p>
            </div>
            <div class="compare-controls">
              <div class="date-presets" role="group" aria-label="Compare against">
                <span class="presets-label">Against</span>
                <button type="button" class="preset-btn compare-mode-btn active" data-compare-mode="previous">Previous period</button>
                <button type="button" class="preset-btn compare-mode-btn" data-compare-mode="prevMonth">Same dates last month</button>
                <button type="button" class="preset-btn compare-mode-btn" data-compare-mode="custom">Custom</button>
              </div>
              <div class="compare-custom-fields hidden" id="compareCustomFields">
                <label><span>From</span><input type="date" id="compareStartDate" /></label>
                <label><span>To</span><input type="date" id="compareEndDate" /></label>
              </div>
            </div>
          </div>
          <p class="compare-status hidden" id="compareStatus"></p>
          <div id="compareBody"></div>
          <p class="compare-note hidden" id="compareNote"></p>
        </article>

      </div>

      <div id="analyzeContent" class="analyze-layout hidden">
        <div class="analyze-main">
          <header class="analyze-hero panel" id="analyzeHero"></header>
          <details class="panel analyze-thresholds">
            <summary>Finding thresholds <span class="tip" tabindex="0" data-tip="Tune when findings below trigger — e.g. raise 'cold start' if you regularly send large one-off prompts on purpose.">ⓘ</span></summary>
            <div class="threshold-grid" id="analyzeThresholds"></div>
            <button type="button" class="btn-text" id="analyzeThresholdsReset">Reset to defaults</button>
          </details>
          <div class="analyze-cards" id="analyzeFindings"></div>
          <div class="analyze-panels">
            <article class="panel" id="analyzeModelPanel"></article>
            <article class="panel" id="analyzeCachePanel"></article>
            <article class="panel" id="analyzeExpensivePanel"></article>
          </div>
        </div>
        <aside class="analyze-sidebar panel" id="analyzeCursorPanel">
          <h2>Ask Cursor Chat</h2>
          <p class="panel-desc">Pick a template and what data to include. Copy the brief and paste it into <strong>Cursor Chat</strong> — no raw event dump, only the slices you choose.</p>
          <div class="analyze-templates" id="analyzeTemplates" role="listbox" aria-label="Analysis templates"></div>
          <fieldset class="analyze-scopes">
            <legend>Data to include <span class="tip" tabindex="0" data-tip="Only checked sections are copied. Aggregated stats and top requests — never your full request log.">ⓘ</span></legend>
            <div class="scope-grid" id="analyzeScopes"></div>
          </fieldset>
          <label class="analyze-custom-q">
            <span>Your question <span class="optional">optional</span></span>
            <textarea id="analyzeCustomQ" rows="2" placeholder="e.g. Why is Auto more expensive than Haiku on my heavy cache requests?"></textarea>
          </label>
          <details class="analyze-preview">
            <summary>Preview brief</summary>
            <textarea id="analyzeBriefPreview" readonly rows="12"></textarea>
          </details>
          <div class="analyze-actions">
            <button type="button" id="copyCursorBrief" class="btn primary">Copy for Cursor Chat</button>
            <span id="copyBriefStatus" class="copy-status" aria-live="polite"></span>
          </div>
        </aside>
      </div>
    </section>

    <section id="simulatorView" class="hidden">
      <div class="simulator panel">
        <div class="sim-header">
          <div>
            <h2>Cost simulator</h2>
            <p class="panel-desc">Replay a real request's token profile against other model rates. Rates from <a href="https://cursor.com/docs/models-and-pricing">Cursor pricing</a>.</p>
          </div>
        </div>

        <div class="sim-mode-toggle" role="tablist">
          <button type="button" class="sim-mode active" data-sim-mode="request">From a request</button>
          <button type="button" class="sim-mode" data-sim-mode="custom">Custom tokens</button>
        </div>

        <div id="simRequestPanel">
          <div class="sim-disclaimer">
            Uses this request's <strong>actual token counts</strong> with each model's published rates.
            A different model would likely change output length and cache behavior — treat this as a directional estimate, not an exact quote.
            <span class="tip" tabindex="0" data-tip="Token replay: industry-standard what-if pricing. Same input/output/cache tokens, different model rates. Does not re-run the prompt.">ⓘ</span>
          </div>
          <label class="sim-full-width">
            <span>Select request <span class="tip" tabindex="0" data-tip="Pick a past request from your filtered usage data. Click Compare on any row in the request log to jump here with that request selected.">ⓘ</span></span>
            <select id="simRequest"></select>
          </label>
          <div id="simSourceSummary" class="sim-source hidden"></div>
          <label class="sim-full-width sim-compare-field">
            <span>Compare with <span class="tip" tabindex="0" data-tip="Pick one or more models to estimate cost with this request's token counts. Your selection is remembered for next time.">ⓘ</span></span>
            <div class="sim-model-picker" id="simComparePicker">
              <button type="button" class="sim-picker-btn" id="simComparePickerBtn" aria-expanded="false" aria-haspopup="listbox">
                <span id="simComparePickerLabel">Select models…</span>
                <span class="sim-picker-chevron" aria-hidden="true">▾</span>
              </button>
              <div class="sim-picker-menu hidden" id="simComparePickerMenu">
                <div class="sim-picker-search-wrap">
                  <input type="search" id="simCompareSearch" class="sim-picker-search" placeholder="Search models…" autocomplete="off" />
                </div>
                <div class="sim-picker-list" id="simCompareModelFilters"></div>
                <p id="simCompareSearchEmpty" class="sim-picker-empty hidden">No models match your search.</p>
                <div class="sim-picker-footer">
                  <button type="button" class="btn-text" id="simCompareSelectAll">Select all</button>
                  <span class="sim-picker-sep">·</span>
                  <button type="button" class="btn-text" id="simCompareClear">Clear</button>
                </div>
              </div>
            </div>
            <p id="simCompareFilterHint" class="sim-filter-hint hidden">Select at least one model.</p>
          </label>
          <div class="sim-compare-table-wrap">
            <table class="sim-compare-table" id="simCompareTable">
              <thead>
                <tr>
                  <th data-sort="label">Model <span class="tip" tabindex="0" data-tip="Auto = Cursor picks the model. The actual row is the model you used; others are estimates with the same tokens.">ⓘ</span></th>
                  <th data-sort="estCost">Est. token cost <span class="tip" tabindex="0" data-tip="Estimated token cost using this request's token counts and each model's published input, output, and cache rates.">ⓘ</span></th>
                  <th data-sort="diff">vs your actual <span class="tip" tabindex="0" data-tip="Difference from your actual token cost on this request. Negative (green) = would likely cost less; positive (amber) = would likely cost more.">ⓘ</span></th>
                  <th data-sort="savings">Cache savings <span class="tip" tabindex="0" data-tip="Per model: cache-read tokens × (input rate − cache-read rate). Assumes the same cache hits as your original request.">ⓘ</span></th>
                </tr>
              </thead>
              <tbody id="simCompareBody"></tbody>
            </table>
          </div>
        </div>

        <div id="simCustomPanel" class="hidden">
          <div class="sim-grid">
            <div class="sim-inputs">
              <label>
                <span>Model</span>
                <select id="simModel"></select>
              </label>
              <label>
                <span>Input tokens</span>
                <input type="number" id="simInput" min="0" value="5000" />
              </label>
              <label>
                <span>Output tokens</span>
                <input type="number" id="simOutput" min="0" value="1000" />
              </label>
              <label>
                <span>Cache read tokens</span>
                <input type="number" id="simCacheRead" min="0" value="50000" />
              </label>
              <label>
                <span>Cache write tokens</span>
                <input type="number" id="simCacheWrite" min="0" value="0" />
              </label>
            </div>
            <div class="sim-results">
              <div class="sim-result-card">
                <span class="sim-result-label">Estimated token cost</span>
                <span class="sim-result-value" id="simCost">—</span>
              </div>
              <div class="sim-result-card sim-green">
                <span class="sim-result-label">Cache savings</span>
                <span class="sim-result-value" id="simSavings">—</span>
              </div>
              <div class="sim-result-card">
                <span class="sim-result-label">Cost without cache</span>
                <span class="sim-result-value" id="simNoCache">—</span>
              </div>
              <p class="sim-rates" id="simRates"></p>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>
  <script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
