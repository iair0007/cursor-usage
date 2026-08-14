import * as vscode from 'vscode';
import { setApiLogger } from './api';
import { storeAdminApiKey, storeManualSessionToken, clearStoredCredentials } from './auth';
import { clearConversationTitleCache } from './conversations';
import { DashboardPanel } from './panel';
import { UsageService } from './service';
import { UsageStatusBar } from './statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Cursor Usage');
  context.subscriptions.push(output);
  const log = (msg: string) => output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  setApiLogger(log);
  log('Extension activated');

  const service = new UsageService(context, log);
  const statusBar = new UsageStatusBar(service);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorUsage.openDashboard', () => {
      DashboardPanel.show(context, service, statusBar, log);
    }),

    vscode.commands.registerCommand('cursorUsage.showLogs', () => {
      output.show(true);
    }),

    vscode.commands.registerCommand('cursorUsage.openSettings', () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'cursorUsage');
    }),

    vscode.commands.registerCommand('cursorUsage.refresh', () => {
      service.invalidateCaches();
      // Chat names change as you work, and the index behind them is cached for
      // five minutes to keep a multi-GB file off the scroll path. An explicit
      // Refresh is the one moment the wait isn't worth it.
      clearConversationTitleCache();
      DashboardPanel.refresh();
      void statusBar.refresh();
    }),

    vscode.commands.registerCommand('cursorUsage.setSessionToken', async () => {
      const input = await vscode.window.showInputBox({
        title: 'Cursor session token',
        prompt:
          'Paste the WorkosCursorSessionToken cookie value from cursor.com (DevTools → Application → Cookies). Stored securely in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!input) return;
      if (await storeManualSessionToken(context, input)) {
        service.invalidateCaches();
        void vscode.window.showInformationMessage('Cursor Usage: session token saved.');
        DashboardPanel.refresh();
        void statusBar.refresh();
      } else {
        void vscode.window.showErrorMessage(
          'Cursor Usage: could not parse that token. Paste the full cookie value (it contains "%3A%3A" or "::").',
        );
      }
    }),

    vscode.commands.registerCommand('cursorUsage.setAdminApiKey', async () => {
      const input = await vscode.window.showInputBox({
        title: 'Cursor Team Admin API key',
        prompt: 'Requires a Cursor Teams/Business plan. Stored securely in VS Code SecretStorage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!input?.trim()) return;
      await storeAdminApiKey(context, input);
      service.invalidateCaches();
      void vscode.window.showInformationMessage('Cursor Usage: Admin API key saved. Team usage will be used.');
      DashboardPanel.refresh();
      void statusBar.refresh();
    }),

    vscode.commands.registerCommand('cursorUsage.clearStoredCredentials', async () => {
      await clearStoredCredentials(context);
      service.invalidateCaches();
      void vscode.window.showInformationMessage('Cursor Usage: stored credentials cleared.');
      DashboardPanel.refresh();
      void statusBar.refresh();
    }),
  );
}

export function deactivate(): void {}
