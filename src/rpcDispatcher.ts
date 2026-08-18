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
      case 'sendToCursorChat':
        return this.sendToCursorChat(String(params.text ?? ''));
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
   * Hands a brief to Cursor's own chat — in the input box, never sent.
   *
   * The clipboard is written first and unconditionally, so every path below can
   * fail and the user is still no worse off than the plain "copied, go paste it"
   * this used to do.
   *
   * Then the deeplink, which is the only mechanism that is *structurally* unable
   * to submit: Cursor answers it with a "Create chat with prompt" confirmation,
   * so a human sees the prompt before a request exists. On desktop this doesn't
   * even leave the process — VS Code's RelayURLService intercepts URIs matching
   * the app's own `urlProtocol` ahead of the external opener and dispatches them
   * to the handling extension in-process — which is why `uriScheme` and desktop
   * are the things worth checking rather than the app name.
   *
   * What is deliberately *not* here is `workbench.action.chat.open` with a query.
   * Upstream it only leaves the prompt unsent when passed `isPartialQuery: true`;
   * every other shape — including the bare-string form that most snippets on the
   * web use — calls `acceptInput()` and bills a request immediately. Whether
   * Cursor honours `isPartialQuery` is undocumented, and an option key it might
   * silently ignore is not something to gamble a paid request on. The command
   * still gets called with *no arguments* further down, where it can only open an
   * empty chat.
   */
  private async sendToCursorChat(text: string): Promise<{ pasted: boolean; opened: boolean; via: string }> {
    await vscode.env.clipboard.writeText(text);
    if (await this.prefillViaDeeplink(text)) return { pasted: true, opened: true, via: 'deeplink' };
    const via = await this.openChatPanel();
    return { pasted: false, opened: Boolean(via), via: via || 'none' };
  }

  /** Cursor's documented cap on a deeplink's payload, measured after encoding. */
  private static readonly DEEPLINK_MAX_CHARS = 8000;

  private async prefillViaDeeplink(text: string): Promise<boolean> {
    if (!text) return false;
    if (vscode.env.uriScheme !== 'cursor') {
      this.log(`sendToCursorChat: uriScheme is "${vscode.env.uriScheme}", not Cursor — skipping deeplink`);
      return false;
    }
    // The in-process interception is desktop-only; on web or over a remote the
    // URI would genuinely try to leave the editor, which helps nobody.
    if (vscode.env.remoteName !== undefined || vscode.env.uiKind !== vscode.UIKind.Desktop) {
      this.log('sendToCursorChat: remote or web session — skipping deeplink');
      return false;
    }
    // URLSearchParams both escapes "&" (which used to truncate the prompt) and
    // encodes a space as "+" rather than "%20", which matters when the payload
    // is measured against a cap.
    const query = new URLSearchParams({ text }).toString();
    if (query.length > RpcDispatcher.DEEPLINK_MAX_CHARS) {
      this.log(`sendToCursorChat: brief is ${query.length} encoded chars, over the `
        + `${RpcDispatcher.DEEPLINK_MAX_CHARS} deeplink cap — falling back to the clipboard`);
      return false;
    }
    try {
      const uri = vscode.Uri.parse(`cursor://anysphere.cursor-deeplink/prompt?${query}`);
      // Only `false` is informative here: the default external opener returns
      // true unconditionally, so a true tells us nothing was refused, not that
      // anything was handled.
      const refused = (await vscode.env.openExternal(uri)) === false;
      if (refused) {
        this.log('sendToCursorChat: no handler took the prompt deeplink');
        return false;
      }
      this.log('sendToCursorChat: handed the brief to Cursor via the prompt deeplink');
      return true;
    } catch (e: any) {
      this.log(`sendToCursorChat: deeplink failed (${e?.message || e})`);
      return false;
    }
  }

  /**
   * Opens or focuses whatever Cursor calls its chat on this version, so there is
   * somewhere to paste. Every id here is called with no arguments, which is what
   * makes the list safe to walk: with nothing to submit, none of them can send.
   * Checked against the command registry first rather than probed by throwing.
   */
  private async openChatPanel(): Promise<string | null> {
    const candidates = [
      'composer.startComposerPrompt',
      'composer.createNewComposerTab',
      'composer.newAgentChat',
      'aichat.newchataction',
      'glass.focusInput',
      'workbench.action.chat.open',
    ];
    let registered: string[] = [];
    try {
      registered = await vscode.commands.getCommands(true);
    } catch {
      registered = [];
    }
    for (const command of candidates) {
      if (registered.length && !registered.includes(command)) continue;
      try {
        await vscode.commands.executeCommand(command);
        this.log(`sendToCursorChat: opened chat via "${command}"`);
        return command;
      } catch (e: any) {
        this.log(`sendToCursorChat: "${command}" failed (${e?.message || e})`);
      }
    }
    this.log('sendToCursorChat: no chat command available on this build');
    return null;
  }

  private async saveCsv(csv: string, filename: string): Promise<{ ok: boolean; path?: string }> {
    const defaultUri = vscode.Uri.joinPath(
      vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir()),
      RpcDispatcher.safeFilename(filename),
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

  /**
   * A file name, and only a file name.
   *
   * The webview supplies this, and `joinPath` resolves `..` the way any path
   * join does — so a name carrying separators would point the save dialog at a
   * directory nobody chose. The dialog still asks before anything is written,
   * but the place it opens on should be the one this code picked.
   */
  private static safeFilename(name: string): string {
    const base = name.replace(/[\\/]/g, '_').replace(/^\.+/, '').trim();
    return base || 'cursor-usage.csv';
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
