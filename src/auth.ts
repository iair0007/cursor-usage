import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import {
  CursorSession,
  buildCookieValue,
  decodeJwtPayload,
  normalizeManualToken,
  userIdFromSub,
} from './authCore';

export { CursorSession } from './authCore';

export type AuthMode = 'admin' | 'session' | 'none';

const SECRET_SESSION_TOKEN = 'cursorUsage.sessionToken';
const SECRET_ADMIN_API_KEY = 'cursorUsage.adminApiKey';

/**
 * Above this size we don't even attempt sql.js: it loads the whole DB into
 * a WebAssembly buffer, which has a hard 4 GB address-space limit and — in
 * practice, given V8's default heap in the extension host — starts failing
 * long before that. `state.vscdb` can grow to many GB for heavy users, so
 * we route those through the native `sqlite3` CLI instead.
 */
const SQL_JS_MAX_BYTES = 200 * 1024 * 1024;

type Logger = (msg: string) => void;
const noop: Logger = () => {};

/**
 * Candidate locations of Cursor's global state DB. The extension usually runs
 * inside Cursor itself, so globalStorageUri points at
 * .../Cursor/User/globalStorage/<publisher.name> — its grandparent holds
 * state.vscdb regardless of platform or portable installs.
 */
export function candidateStateDbPaths(context: vscode.ExtensionContext): string[] {
  const candidates: string[] = [];

  const fromGlobalStorage = path.join(
    path.dirname(context.globalStorageUri.fsPath),
    'state.vscdb',
  );
  candidates.push(fromGlobalStorage);

  const home = os.homedir();
  if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  } else {
    candidates.push(path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
  }

  return [...new Set(candidates)].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function escapeSqlLiteral(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Read a set of keys from an sqlite DB via the system `sqlite3` CLI. This
 * streams the file from disk (no full-file read) so it works on multi-GB
 * databases where sql.js can't even allocate the buffer.
 *
 * Rows come back tab-separated, one per line. `cursorAuth/accessToken` is a
 * base64 JWT and `cursorAuth/cachedEmail` is an email — neither can contain
 * tabs or newlines, so this parse is unambiguous for our use case.
 */
export function readValuesViaSqliteCli(dbPath: string, keys: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const inList = keys.map((k) => `'${escapeSqlLiteral(k)}'`).join(',');
    const query = `SELECT key, value FROM ItemTable WHERE key IN (${inList});`;
    const args = [
      '-readonly',
      '-bail',
      '-cmd', '.headers off',
      '-cmd', '.mode list',
      '-cmd', '.separator "\\t" "\\n"',
      dbPath,
      query,
    ];
    execFile('sqlite3', args, { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const wrapped = new Error(`sqlite3 CLI failed: ${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}${stderr ? ` | ${stderr}` : ''}`);
        reject(wrapped);
        return;
      }
      const out = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        out.set(line.slice(0, tab), line.slice(tab + 1));
      }
      resolve(out);
    });
  });
}

function readValuesViaSqlJs(dbFile: Buffer, wasmDir: string, keys: string[]): Promise<Map<string, string>> {
  return initSqlJs({ locateFile: (f: string) => path.join(wasmDir, f) }).then((SQL) => {
    const db = new SQL.Database(dbFile);
    const out = new Map<string, string>();
    try {
      const placeholders = keys.map(() => '?').join(',');
      const res = db.exec(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`, keys);
      for (const row of res[0]?.values ?? []) {
        out.set(String(row[0]), String(row[1]));
      }
    } finally {
      db.close();
    }
    return out;
  });
}

/**
 * Read keys from `ItemTable`, trying the sqlite3 CLI first (fast, streams,
 * unbounded file size) and falling back to sql.js only when we couldn't shell
 * out AND the DB is small enough that loading it into WebAssembly is safe.
 * Returns null if neither works.
 *
 * Shared with the conversation-name lookup, so a machine without the sqlite3
 * CLI keeps both the stored auth token and the session names.
 */
export async function readItemTableValues(
  dbPath: string,
  wasmDir: string,
  keys: string[],
  log: Logger,
): Promise<Map<string, string> | null> {
  try {
    const values = await readValuesViaSqliteCli(dbPath, keys);
    log(`Read state.vscdb via sqlite3 CLI (${path.basename(dbPath)})`);
    return values;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`sqlite3 CLI unavailable or failed for ${path.basename(dbPath)}: ${msg}`);
  }

  let size = 0;
  try {
    size = fs.statSync(dbPath).size;
  } catch {
    return null;
  }
  if (size > SQL_JS_MAX_BYTES) {
    log(
      `Skipping WASM SQLite fallback for ${path.basename(dbPath)}: file is ${(size / 1e9).toFixed(1)} GB, too large for sql.js. ` +
      `Install the sqlite3 CLI (macOS/Linux ship it; on Windows: winget install SQLite.SQLite) so the extension can read Cursor's auth token.`,
    );
    return null;
  }

  try {
    const buf = fs.readFileSync(dbPath);
    const values = await readValuesViaSqlJs(buf, wasmDir, keys);
    log(`Read state.vscdb via WASM SQLite fallback (${path.basename(dbPath)})`);
    return values;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`WASM SQLite fallback failed for ${path.basename(dbPath)}: ${msg}`);
    return null;
  }
}

/**
 * Resolve the user's Cursor session, preferring the token Cursor itself
 * stored at login (zero-setup "SSO"), falling back to a manually stored one.
 */
export async function resolveSession(
  context: vscode.ExtensionContext,
  log: Logger = noop,
): Promise<CursorSession | null> {
  const wasmDir = path.join(context.extensionUri.fsPath, 'media');

  for (const dbPath of candidateStateDbPaths(context)) {
    const values = await readItemTableValues(
      dbPath,
      wasmDir,
      ['cursorAuth/accessToken', 'cursorAuth/cachedEmail'],
      log,
    );
    if (!values) continue;
    const token = values.get('cursorAuth/accessToken');
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    if (!payload?.sub) continue;
    if (payload.exp && payload.exp * 1000 < Date.now()) {
      log(`Cursor access token in ${path.basename(dbPath)} is expired; ignoring.`);
      continue;
    }
    const userId = userIdFromSub(payload.sub);
    return {
      cookieValue: buildCookieValue(userId, token),
      userId,
      email: values.get('cursorAuth/cachedEmail'),
      source: 'ide',
    };
  }

  const manual = await context.secrets.get(SECRET_SESSION_TOKEN);
  if (manual) {
    const userId = manual.split('%3A%3A')[0] || 'unknown';
    return { cookieValue: manual, userId, source: 'manual' };
  }

  return null;
}

export async function storeManualSessionToken(context: vscode.ExtensionContext, input: string): Promise<boolean> {
  const normalized = normalizeManualToken(input);
  if (!normalized) return false;
  await context.secrets.store(SECRET_SESSION_TOKEN, normalized);
  return true;
}

export async function getAdminApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(SECRET_ADMIN_API_KEY);
}

export async function storeAdminApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_ADMIN_API_KEY, key.trim());
}

export async function clearStoredCredentials(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(SECRET_SESSION_TOKEN);
  await context.secrets.delete(SECRET_ADMIN_API_KEY);
}
