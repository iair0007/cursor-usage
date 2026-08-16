import * as os from 'os';
import * as vscode from 'vscode';
import { UsageService } from './service';
import { UsageStatusBar } from './statusBar';
import { readConversationTitles } from './conversations';

/** globalState key holding the webview's persisted UI preferences. */
const PREFS_KEY = 'cursorUsage.webviewPrefs';

export interface RpcOutcome {
  result?: any;
  error?: string;
  authError?: boolean;
}

/**
 * Every RPC method the dashboard UI calls, factored out of the webview panel
 * so the local browser server (browserServer.ts) can serve the exact same
 * methods over HTTP. Both transports terminate in the extension host, so the
 * same VS Code APIs (clipboard, save dialog, globalState, commands) apply
 * regardless of which one carried the call.
 */
export class RpcDispatcher {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly service: UsageService,
    private readonly statusBar: UsageStatusBar | undefined,
    private readonly log: (msg: string) => void,
    private readonly onOpenInBrowser: () => void | Promise<void>,
  ) {}

  async handle(method: string, params: any): Promise<RpcOutcome> {
    try {
      const result = await this.dispatch(method, params || {});
      return { result };
    } catch (e: any) {
      const error = e?.message || String(e);
      const authError = this.service.isAuthError(e);
      if (authError) this.offerTokenFix();
      return { error, authError };
    }
  }

  private async dispatch(method: string, params: any): Promise<any> {
    switch (method) {
      case 'status':
        return this.service.getStatus();
      case 'usage': {
        const start = Number(params.startDate);
        const end = Number(params.endDate);
        if (!start || !end) throw new Error('startDate and endDate required (epoch ms)');
        const result = await this.service.getUsage(start, end);
        // Sync the status bar to whatever the user just saw, instead of
        // waiting for its own timer (avoids the two showing different counts).
        void this.statusBar?.refresh();
        return result;
      }
      case 'budget': {
        // Read fresh on every call so a budget changed mid-cycle takes effect
        // on the next refresh instead of at the next window reload.
        const configured = vscode.workspace
          .getConfiguration('cursorUsage')
          .get<number>('budget.monthlyDollars', 0);
        return (await this.service.getBudgetStatus(configured))
          ?? { budgetDollars: null, source: 'none' };
      }
      case 'pricing':
        return { markdown: await this.service.getPricingMarkdown() };
      // Names for the conversations behind the usage rows. Read from Cursor's
      // own local database and joined to the API's ids here, in the extension
      // host — nothing from that database goes back out over the network.
      case 'sessionTitles': {
        const ids = Array.isArray(params.ids) ? params.ids.map((id: any) => String(id)) : [];
        const titles = await readConversationTitles(this.context, ids, this.log);
        return { titles: Object.fromEntries(titles) };
      }
      // The webview's own vscode.setState survives being hidden but dies with
      // the panel, so anything stored only there silently reset every time the
      // dashboard was closed and reopened. globalState is the durable home.
      case 'prefsGet':
        return this.context.globalState.get<Record<string, string>>(PREFS_KEY) ?? {};
      case 'prefsSet': {
        const key = String(params.key ?? '');
        if (!key) throw new Error('prefsSet requires a key');
        const prefs = { ...(this.context.globalState.get<Record<string, string>>(PREFS_KEY) ?? {}) };
        if (params.value == null) delete prefs[key];
        else prefs[key] = String(params.value);
        await this.context.globalState.update(PREFS_KEY, prefs);
        return { ok: true };
      }
      // The webview holds the pricing table and every derived figure, so the
      // reasoning worth reading in a bug report only exists there. Capped
      // rather than trusted: this writes into the channel people paste from.
      case 'log': {
        const text = String(params.text ?? '').slice(0, 4000);
        if (text) for (const line of text.split('\n')) this.log(line);
        return { ok: true };
      }
      case 'copyText':
        await vscode.env.clipboard.writeText(String(params.text ?? ''));
        return { ok: true };
      case 'focusCursorChat':
        return { opened: await this.focusCursorChat() };
      case 'exportCsv':
        return this.saveCsv(String(params.csv ?? ''), String(params.filename || 'cursor-usage.csv'));
      case 'openInBrowser':
        await this.onOpenInBrowser();
        return { ok: true };
      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  /**
   * Best-effort attempt to bring Cursor's own chat/composer panel into focus
   * so the user only has to paste, instead of also hunting for the panel.
   * There is no documented, stable API for this — Cursor doesn't support
   * VS Code's own `workbench.action.chat.open`, and no third-party extension
   * has a confirmed way to pass prompt text into Cursor's chat. So this only
   * tries to *open/focus* the panel (never to populate or submit a prompt,
   * which could otherwise send a request on the user's behalf without them
   * reviewing it first) and silently no-ops if none of the candidate
   * commands exist on this Cursor version.
   */
  private async focusCursorChat(): Promise<boolean> {
    const candidates = ['composer.createNewComposerTab', 'aichat.newchataction', 'workbench.action.chat.open'];
    for (const command of candidates) {
      try {
        await vscode.commands.executeCommand(command);
        this.log(`focusCursorChat: opened chat via "${command}"`);
        return true;
      } catch (e: any) {
        this.log(`focusCursorChat: "${command}" unavailable (${e?.message || e})`);
      }
    }
    return false;
  }

  private async saveCsv(csv: string, filename: string): Promise<{ ok: boolean; path?: string }> {
    const defaultUri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir()),
      filename,
    );
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { CSV: ['csv'] },
    });
    if (!uri) return { ok: false };
    await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf8'));
    void vscode.window.showInformationMessage(`Exported usage CSV to ${uri.fsPath}`);
    return { ok: true, path: uri.fsPath };
  }

  private offerTokenFix(): void {
    void vscode.window
      .showWarningMessage(
        'Cursor Usage: authentication failed. Your Cursor session may have expired.',
        'Set Token Manually',
      )
      .then((pick) => {
        if (pick === 'Set Token Manually') {
          void vscode.commands.executeCommand('cursorUsage.setSessionToken');
        }
      });
  }
}
