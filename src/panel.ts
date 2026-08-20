import * as vscode from 'vscode';
import { UsageService } from './service';
import { UsageStatusBar } from './statusBar';
import { getDashboardHtml } from './html';
import { RpcDispatcher } from './rpcDispatcher';
import { BrowserServer } from './browserServer';

interface RpcMessage {
  type: 'rpc';
  id: number;
  method: string;
  params?: any;
}

export class DashboardPanel {
  public static current: DashboardPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private readonly dispatcher: RpcDispatcher;

  static show(
    context: vscode.ExtensionContext,
    service: UsageService,
    statusBar?: UsageStatusBar,
    log: (msg: string) => void = () => {},
  ): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'cursorUsageDashboard',
      'Cursor Usage',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    DashboardPanel.current = new DashboardPanel(panel, context, service, statusBar, log);
  }

  static refresh(): void {
    DashboardPanel.current?.panel.webview.postMessage({ type: 'refresh' });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    service: UsageService,
    statusBar: UsageStatusBar | undefined,
    log: (msg: string) => void = () => {},
  ) {
    this.dispatcher = new RpcDispatcher(context, service, statusBar, log, () =>
      BrowserServer.show(context, service, statusBar, log),
    );
    panel.webview.html = getDashboardHtml(panel.webview, context.extensionUri);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(
      (msg) => {
        if (msg?.type === 'rpc') void this.handleRpc(msg as RpcMessage);
      },
      null,
      this.disposables,
    );
  }

  private async handleRpc(msg: RpcMessage): Promise<void> {
    const outcome = await this.dispatcher.handle(msg.method, msg.params);
    void this.panel.webview.postMessage({ type: 'rpc-result', id: msg.id, ...outcome });
  }

  private dispose(): void {
    DashboardPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
