import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { UsageService } from './service';
import { UsageStatusBar } from './statusBar';
import { RpcDispatcher } from './rpcDispatcher';
import { getBrowserDashboardHtml } from './html';

const TOKEN_HEADER = 'x-cursor-usage-token';
// Generous headroom over anything the dashboard actually sends (the largest
// payload is an exported CSV of the request log) without leaving the server
// open to an unbounded read into memory.
const MAX_RPC_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Serves the same dashboard the webview shows, over plain HTTP on
 * 127.0.0.1, so it can be opened in a real browser tab instead of the VS
 * Code webview. Bound to loopback only, with a random per-launch token
 * required on every call that returns usage data, since anything reachable at
 * a localhost port is reachable by any other local process or web page — see
 * the request handling below for what that token actually defends against.
 * The static shell (page, script, stylesheet) is served ungated: it carries no
 * data, and gating it would break the browser's own reload.
 */
export class BrowserServer {
  // A promise rather than the instance: two invocations of the command in
  // quick succession would both find `current` unset while the first was still
  // awaiting listen(), start a second server, and leak the first — bound to a
  // port nothing can close.
  private static starting: Promise<BrowserServer> | undefined;

  private readonly server: http.Server;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private readonly dispatcher: RpcDispatcher;
  private port = 0;
  private script = '';
  private styles = '';
  private icon: Buffer | undefined;

  static async show(
    context: vscode.ExtensionContext,
    service: UsageService,
    statusBar: UsageStatusBar | undefined,
    log: (msg: string) => void,
  ): Promise<void> {
    if (!BrowserServer.starting) {
      const instance = new BrowserServer(context, service, statusBar, log);
      BrowserServer.starting = instance.start().then(() => instance);
      // A failed start must not poison every later attempt with a rejected
      // promise nobody can retry past.
      BrowserServer.starting.catch(() => { BrowserServer.starting = undefined; });
    }
    await (await BrowserServer.starting).open();
  }

  /** Closes the loopback server, if one is running. Called on extension deactivate. */
  static stop(): void {
    const starting = BrowserServer.starting;
    BrowserServer.starting = undefined;
    if (!starting) return;
    void starting.then((instance) => {
      // close() alone only stops new connections: a browser tab still holding a
      // keep-alive socket would keep the port bound for as long as it is open.
      instance.server.closeAllConnections?.();
      instance.server.close();
    }, () => {});
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    service: UsageService,
    statusBar: UsageStatusBar | undefined,
    private readonly log: (msg: string) => void,
  ) {
    this.dispatcher = new RpcDispatcher(context, service, statusBar, log, () => this.open());
    this.server = http.createServer((req, res) => this.route(req, res));
  }

  private async start(): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    this.script = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'main.js'))).toString('utf8');
    this.styles = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(media, 'styles.css'))).toString('utf8');
    // The extension's own icon, so the tab is identifiable in a row of tabs
    // rather than carrying the browser's blank-document glyph.
    try {
      this.icon = Buffer.from(await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'icon.png'),
      ));
    } catch {
      this.icon = undefined;
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      // Port 0 picks a free ephemeral port from the OS, so this never
      // collides with anything else running locally.
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    this.log(`Browser dashboard listening on http://127.0.0.1:${this.port}`);
  }

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async open(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(`${this.baseUrl}/?token=${this.token}`));
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', this.baseUrl);

    // Served without the token on purpose. The shell holds no usage data —
    // every figure on it arrives over /api/rpc, which is gated — and gating the
    // page too would mean a plain reload (the token is stripped from the URL as
    // soon as the tab has it) rendering "Forbidden" instead of the dashboard.
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(getBrowserDashboardHtml());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/main.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' }).end(this.script);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/styles.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }).end(this.styles);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.png') {
      if (!this.icon) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(this.icon);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/rpc') {
      this.handleRpc(req, res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }

  /**
   * The real guard is this handler requiring a custom header rather than a
   * same-shape body field: browsers only send custom headers cross-origin
   * after a CORS preflight, and since this server never answers one with
   * Access-Control-Allow-Origin, no other page's script can complete a call
   * here even if it somehow learned the token. The token itself then stops
   * any other *same-origin-capable* local caller (another app on this
   * machine hitting the port directly) from reading usage data blind.
   */
  private handleRpc(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.tokenMatches(req.headers[TOKEN_HEADER])) {
      res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    this.readRpcBody(req, res);
  }

  /** Constant-time token check, so a wrong guess reveals nothing by how fast it failed. */
  private tokenMatches(sent: string | string[] | undefined): boolean {
    if (typeof sent !== 'string') return false;
    const a = Buffer.from(sent, 'utf8');
    const b = Buffer.from(this.token, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private readRpcBody(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    // Guards against the 'data' handler responding more than once — without
    // it, a chunk arriving right after the size limit trips would try to
    // write a second response and throw synchronously inside a stream
    // callback, which Node has nothing to catch.
    let settled = false;
    req.on('error', () => { settled = true; });
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_RPC_BODY_BYTES) {
        settled = true;
        res.writeHead(413, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Request too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      void (async () => {
        let method = '';
        let params: any = {};
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          method = String(body.method || '');
          params = body.params;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid request body' }));
          return;
        }
        const outcome = await this.dispatcher.handle(method, params);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(outcome));
      })();
    });
  }
}
