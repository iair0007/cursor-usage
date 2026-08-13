import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { candidateStateDbPaths, readItemTableValues } from './auth';
import {
  composerRowKey,
  parseComposerNames,
  parseTitleIndex,
  TITLE_INDEX_KEYS,
} from './shared/conversationTitles';

type Logger = (msg: string) => void;

/**
 * Conversation names change as you work — Cursor renames a chat once it has a
 * subject — so the index is re-read periodically rather than pinned for the
 * session. Long enough that scrolling the list doesn't re-read a multi-GB file.
 */
const INDEX_TTL_MS = 5 * 60 * 1000;

/**
 * Per-conversation rows hold the entire chat, so asking SQLite to open many of
 * them at once is the slow path. The index covers the common case; this cap
 * keeps the fallback from turning into a scan when it doesn't.
 */
const MAX_ROW_LOOKUPS = 60;

let indexCache: { at: number; titles: Map<string, string> } | null = null;

function escapeSqlLiteral(v: string): string {
  return v.replace(/'/g, "''");
}

/**
 * Reads just the `name` off specific conversation rows.
 *
 * `json_extract` runs inside SQLite so only the names cross the process
 * boundary — never the message bodies in the same row. JSON output because a
 * name is free text from a prompt and could contain anything a line-oriented
 * parse would trip over.
 */
function readComposerNames(dbPath: string, ids: string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const inList = ids.map((id) => `'${escapeSqlLiteral(composerRowKey(id))}'`).join(',');
    const query = `SELECT key AS key, json_extract(value, '$.name') AS name FROM cursorDiskKV WHERE key IN (${inList});`;
    execFile(
      'sqlite3',
      ['-readonly', '-bail', '-json', dbPath, query],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`sqlite3 name lookup failed: ${err.message}${stderr ? ` | ${stderr}` : ''}`));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          resolve(new Map());
          return;
        }
        try {
          resolve(parseComposerNames(JSON.parse(text)));
        } catch (e: any) {
          reject(new Error(`could not parse sqlite3 JSON output: ${e?.message || e}`));
        }
      },
    );
  });
}

async function loadIndex(context: vscode.ExtensionContext, log: Logger): Promise<Map<string, string>> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.titles;

  // Same reader the auth token uses, so the WASM fallback covers machines
  // without the sqlite3 CLI here too.
  const wasmDir = path.join(context.extensionUri.fsPath, 'media');
  const titles = new Map<string, string>();
  for (const dbPath of candidateStateDbPaths(context)) {
    try {
      const rows = await readItemTableValues(dbPath, wasmDir, TITLE_INDEX_KEYS, log);
      for (const [id, title] of parseTitleIndex(rows ?? new Map())) titles.set(id, title);
    } catch (e: any) {
      log(`Conversation title index unavailable: ${e?.message || e}`);
    }
  }
  indexCache = { at: Date.now(), titles };
  log(`Conversation title index: ${titles.size} named conversations found locally.`);
  return titles;
}

/**
 * Names for the given conversation ids, read from Cursor's local database.
 *
 * Entirely local and entirely best-effort: the ids come from cursor.com's usage
 * API and the names from `state.vscdb` on this machine, and the two are joined
 * here and nowhere else. Nothing read from that database is sent anywhere, and
 * only names are read from it — never prompts, messages or code context.
 *
 * Every failure path returns fewer names rather than throwing, because the
 * caller's fallback (showing the id) is a perfectly usable answer.
 */
export async function readConversationTitles(
  context: vscode.ExtensionContext,
  ids: string[],
  log: Logger = () => {},
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  if (!wanted.length) return new Map();

  const index = await loadIndex(context, log);
  const found = new Map<string, string>();
  const missing: string[] = [];
  for (const id of wanted) {
    const title = index.get(id);
    if (title) found.set(id, title);
    else missing.push(id);
  }

  // Whatever the index didn't name, ask for row by row — but only up to the
  // cap, and only when there's a database to ask.
  if (missing.length) {
    for (const dbPath of candidateStateDbPaths(context)) {
      const batch = missing.slice(0, MAX_ROW_LOOKUPS);
      try {
        for (const [id, title] of await readComposerNames(dbPath, batch)) found.set(id, title);
      } catch (e: any) {
        log(`Conversation name lookup failed: ${e?.message || e}`);
      }
      if (found.size === wanted.length) break;
    }
  }

  return found;
}

/** Drops the cached index, so the next lookup re-reads the database. */
export function clearConversationTitleCache(): void {
  indexCache = null;
}
