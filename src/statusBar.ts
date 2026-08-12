import * as vscode from 'vscode';
import {
  UsageService,
  countRequests,
  formatCycleRangeLabel,
  projectExhaustionDate,
  quotaPercentUsed,
  parseStatusBarPeriodConfig,
  statusBarText,
  statusBarWindow,
  sumBilledCostDollars,
  sumTokenCostDollars,
  type StatusBarFillStyle,
  type StatusBarPeriodMode,
  type StatusBarQuotaFormat,
} from './service';

type CostMode = 'value' | 'billed';

function statusBarTooltipFooter(tooltip: vscode.MarkdownString): void {
  tooltip.appendMarkdown(`\n_Click to open the dashboard_`);
}

export class UsageStatusBar {
  private item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly service: UsageService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'cursorUsage.openDashboard';
    this.item.text = '$(graph) Cursor Usage';
    const loadingTooltip = new vscode.MarkdownString(undefined, true);
    loadingTooltip.appendMarkdown('Cursor Usage: loading…');
    statusBarTooltipFooter(loadingTooltip);
    this.item.tooltip = loadingTooltip;

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cursorUsage')) this.applyConfig();
      }),
    );
    this.applyConfig();
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration('cursorUsage');
    const costMode = cfg.get<string>('statusBar.costMode', 'value');
    const periodModeRaw = cfg.get<string>('statusBar.periodMode', 'cycle');
    const { mode: periodMode, periodDays } = parseStatusBarPeriodConfig(
      periodModeRaw,
      cfg.get<number>('statusBar.periodDays', 30),
    );
    const quotaFormatRaw = cfg.get<string>('statusBar.quotaFormat', 'usedLimit');
    const fillStyleRaw = cfg.get<string>('statusBar.fillStyle', 'dots');
    const fillStyles = new Set(['dots', 'blocks', 'squares', 'stars', 'bars', 'none']);
    return {
      enabled: cfg.get<boolean>('statusBar.enabled', true),
      intervalMinutes: Math.max(5, cfg.get<number>('refreshIntervalMinutes', 15)),
      periodMode: periodMode as StatusBarPeriodMode,
      periodDays,
      costMode: (costMode === 'billed' ? 'billed' : 'value') as CostMode,
      warnAtPercent: Math.min(99, Math.max(1, cfg.get<number>('statusBar.warnAtPercent', 80))),
      criticalAtPercent: Math.min(200, Math.max(1, cfg.get<number>('statusBar.criticalAtPercent', 95))),
      quotaFormat: (quotaFormatRaw === 'remaining' ? 'remaining' : 'usedLimit') as StatusBarQuotaFormat,
      fillStyle: (fillStyles.has(fillStyleRaw) ? fillStyleRaw : 'dots') as StatusBarFillStyle,
    };
  }

  private applyConfig(): void {
    const { enabled, intervalMinutes } = this.config();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    if (!enabled) {
      this.item.hide();
      return;
    }
    this.item.show();
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMinutes * 60 * 1000);
  }

  async refresh(): Promise<void> {
    const { enabled, periodMode, periodDays, costMode, warnAtPercent, criticalAtPercent, quotaFormat, fillStyle } =
      this.config();
    if (!enabled) return;

    try {
      const result = await this.service.getStatusBarUsage({ mode: periodMode, periodDays });

      if (result.authMode === 'none') {
        this.item.text = '$(graph) Cursor Usage';
        const authTooltip = new vscode.MarkdownString(undefined, true);
        authTooltip.appendMarkdown(
          'Cursor Usage: sign into Cursor (or set a session token) to load data.',
        );
        statusBarTooltipFooter(authTooltip);
        this.item.tooltip = authTooltip;
        this.item.backgroundColor = undefined;
        return;
      }

      const freePlan = result.plan?.membershipType?.startsWith('free') ?? false;
      const billed = sumBilledCostDollars(result.events, result.plan);
      const cost = costMode === 'billed' ? billed : sumTokenCostDollars(result.events);
      const showWhatIfPrefix = costMode === 'value' && freePlan;

      const quota = result.quota;
      const { start: windowStart, end: windowEnd } = statusBarWindow(periodMode, periodDays, quota);
      const periodLabel =
        periodMode === 'days'
          ? `last ${periodDays} days`
          : `${formatCycleRangeLabel(windowStart, windowEnd)} (current cycle)`;
      const periodScope = periodMode === 'days' ? `last ${periodDays} days` : 'this cycle';

      const quotaPct = quotaPercentUsed(quota);
      const hasQuotaLimit = quotaPct != null;

      // Budget-metered plans have no request allowance, so the quota gauge,
      // its format/fill settings and the warn/critical thresholds would all sit
      // idle. Drive them from the budget instead — same settings, same
      // behaviour, denominated in money.
      const budgetStatus = hasQuotaLimit ? null : await this.service.getBudgetStatus(
        vscode.workspace.getConfiguration('cursorUsage').get<number>('budget.monthlyDollars', 0),
      ).catch(() => null);
      const budget = budgetStatus?.budgetDollars
        ? {
            spentDollars: budgetStatus.spentDollars,
            budgetDollars: budgetStatus.budgetDollars,
            resetIso: quota?.resetIso,
          }
        : null;

      // Whichever allowance this plan has: requests used, or budget spent.
      // A runway only exists when a budget does, so this is null for plans
      // with neither, and the thresholds simply don't apply.
      const usedPct = quotaPct ?? (budget ? budgetStatus?.runway?.percentUsed ?? null : null);
      let severity: 'normal' | 'warning' | 'critical' = 'normal';
      if (usedPct != null) {
        if (usedPct >= criticalAtPercent) severity = 'critical';
        else if (usedPct >= warnAtPercent) severity = 'warning';
      }
      this.item.backgroundColor =
        severity === 'critical'
          ? new vscode.ThemeColor('statusBarItem.errorBackground')
          : severity === 'warning'
            ? new vscode.ThemeColor('statusBarItem.warningBackground')
            : undefined;

      const icon = severity === 'critical' ? '$(warning)' : severity === 'warning' ? '$(alert)' : '$(graph)';
      this.item.text = `${icon} ${statusBarText({
        quota,
        costDollars: cost,
        onDemandDollars: billed,
        showWhatIfPrefix,
        quotaFormat,
        fillStyle,
        budget,
      })}`;

      const tooltip = new vscode.MarkdownString(undefined, true);
      tooltip.appendMarkdown(`**Cursor Usage** — ${periodLabel}\n\n`);
      const costLabel = costMode === 'billed'
        ? 'Billed cost'
        : `Token ${freePlan ? 'value (what-if, not billed)' : 'cost'}`;
      tooltip.appendMarkdown(`- ${costLabel} (${periodScope}): **$${cost.toFixed(2)}**\n`);
      if (!hasQuotaLimit) {
        tooltip.appendMarkdown(`- Requests (${periodScope}): **${countRequests(result.events).toLocaleString('en-US')}**\n`);
      }
      const runway = budgetStatus?.runway;
      if (budget && runway) {
        tooltip.appendMarkdown(
          `- Budget: **$${budget.spentDollars.toFixed(2)} / $${budget.budgetDollars.toFixed(2)}** (${runway.percentUsed.toFixed(0)}%)\n`,
        );
        if (runway.overBudget) {
          tooltip.appendMarkdown(`- **$${(-runway.remainingDollars).toFixed(2)} over budget** this cycle\n`);
        } else if (runway.dailySpend != null && runway.daysToExhaustion != null) {
          // "cycle average" so the rate can be reconciled with the spend above
          // rather than read as today's burn.
          tooltip.appendMarkdown(
            `- At $${runway.dailySpend.toFixed(2)}/day (cycle average): ~${Math.round(runway.daysToExhaustion)} days of budget left\n`,
          );
          if (runway.safeDailySpend != null) {
            tooltip.appendMarkdown(`- Stays in budget at up to **$${runway.safeDailySpend.toFixed(2)}/day**\n`);
          }
        }
      }
      if (result.plan?.membershipType) tooltip.appendMarkdown(`- Plan: ${result.plan.membershipType}\n`);
      if (quota && hasQuotaLimit) {
        const overLimit = quota.used > quota.limit!;
        tooltip.appendMarkdown(
          overLimit
            ? `- Plan usage: **${quota.used.toLocaleString('en-US')} / ${quota.limit!.toLocaleString('en-US')} · limit reached** (${quotaPct!.toFixed(0)}%)\n`
            : `- Plan usage: **${quota.used.toLocaleString('en-US')} / ${quota.limit!.toLocaleString('en-US')}** (${quotaPct!.toFixed(0)}%)\n`,
        );
        if (quota.used >= quota.limit!) {
          tooltip.appendMarkdown(`- On-demand usage (${periodScope}): **$${billed.toFixed(2)}**\n`);
        }
        if (quota.resetIso) {
          const resetDate = new Date(quota.resetIso);
          if (!Number.isNaN(resetDate.getTime())) {
            tooltip.appendMarkdown(`- Resets: ${resetDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}\n`);
          }
        }
        if (quota.startOfCycleIso) {
          const sinceMs = new Date(quota.startOfCycleIso).getTime();
          if (!Number.isNaN(sinceMs)) {
            const exhaustion = projectExhaustionDate(quota.used, quota.limit, sinceMs);
            if (exhaustion) {
              const days = Math.max(0, Math.round((exhaustion.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
              tooltip.appendMarkdown(
                days <= 0
                  ? `- ⚠️ At this pace, you've already used your plan's included requests for this cycle\n`
                  : `- At this pace: **~${days} day${days === 1 ? '' : 's'}** until included requests run out\n`,
              );
            }
          }
        }
      } else if (quota && quota.used > 0) {
        tooltip.appendMarkdown(`- Plan usage: **${quota.used.toLocaleString('en-US')}** requests this cycle (no fixed limit found)\n`);
      } else if (quota) {
        tooltip.appendMarkdown(
          `- No fixed request quota found for this plan — usage like Auto is metered by token cost above, not a request count\n`,
        );
      }
      if (result.hardLimit) {
        tooltip.appendMarkdown(`- Spend cap: **$${result.hardLimit.toFixed(2)}**/mo (see dashboard for cycle-to-date billed total)\n`);
      }
      if (result.email) tooltip.appendMarkdown(`- Account: ${result.email}\n`);
      statusBarTooltipFooter(tooltip);
      this.item.tooltip = tooltip;
    } catch (e: any) {
      this.item.text = '$(graph) Cursor Usage';
      const errorTooltip = new vscode.MarkdownString(undefined, true);
      errorTooltip.appendMarkdown(`Cursor Usage: ${e?.message || 'failed to load'}.`);
      statusBarTooltipFooter(errorTooltip);
      this.item.tooltip = errorTooltip;
      this.item.backgroundColor = undefined;
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
