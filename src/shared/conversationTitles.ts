// Turning conversation ids into the names Cursor shows in its own chat list.
//
// Pure parsing, kept apart from the SQLite reading in `src/conversations.ts` so
// it can be tested without a Cursor install. Everything here runs against
// values already read from the local `state.vscdb`; nothing is fetched, and
// nothing derived from that database is ever sent anywhere.

/**
 * Titles come from the user's own prompts, so they are arbitrary text. A name
 * is a label — anything longer than this is not one, and letting an unbounded
 * string through would wreck the table layout and bloat the RPC payload.
 */
export const MAX_TITLE_LENGTH = 200;

/**
 * The `ItemTable` keys that hold an index of conversations. Both are small
 * summary records — ids, names and timestamps — rather than message content,
 * which is why they're preferred over reading each conversation's own row.
 *
 * Two of them because Cursor has moved the index as its chat UI evolved, and
 * which one is populated varies by version. Reading both and merging is
 * cheaper than trying to detect the version.
 */
export const TITLE_INDEX_KEYS = [
  'composer.composerData',
  'workbench.panel.aichat.view.aichat.chatdata',
];

/** The per-conversation row key, for ids the index above didn't cover. */
export function composerRowKey(id: string): string {
  return `composerData:${id}`;
}

function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Newlines and tabs would break both the table layout and any line-oriented
  // parse of the sqlite output they arrived through.
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}

function addFromComposerIndex(parsed: any, out: Map<string, string>): void {
  const composers = parsed?.allComposers;
  if (!Array.isArray(composers)) return;
  for (const c of composers) {
    const id = typeof c?.composerId === 'string' ? c.composerId : null;
    const title = cleanTitle(c?.name);
    if (id && title) out.set(id, title);
  }
}

function addFromChatIndex(parsed: any, out: Map<string, string>): void {
  const tabs = parsed?.tabs;
  if (!Array.isArray(tabs)) return;
  for (const tab of tabs) {
    const id = typeof tab?.tabId === 'string' ? tab.tabId : null;
    const title = cleanTitle(tab?.chatTitle ?? tab?.title);
    if (id && title) out.set(id, title);
  }
}

/**
 * Extracts id → title pairs from whatever the index keys held.
 *
 * Deliberately forgiving: these are undocumented, version-dependent shapes, so
 * a row that doesn't parse or doesn't have the fields expected is skipped
 * rather than treated as an error. The worst case is a session that keeps
 * showing its id, which is exactly what happens without this file at all.
 */
export function parseTitleIndex(rows: Map<string, string> | [string, string][]): Map<string, string> {
  const entries = rows instanceof Map ? [...rows] : rows;
  const out = new Map<string, string>();
  for (const [, value] of entries) {
    if (!value) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    addFromComposerIndex(parsed, out);
    addFromChatIndex(parsed, out);
  }
  return out;
}

/**
 * Extracts titles from per-conversation rows, keyed by `composerData:<id>`.
 *
 * The name is read from a `json_extract` in SQL rather than by parsing the row
 * here: those rows hold the whole conversation, and pulling megabytes of
 * message text into the extension host to read one string off the top would be
 * both slow and a needless handling of content this feature has no business
 * touching.
 */
export function parseComposerNames(rows: { key: string; name: unknown }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const key = typeof row?.key === 'string' ? row.key : '';
    if (!key.startsWith('composerData:')) continue;
    const id = key.slice('composerData:'.length);
    const title = cleanTitle(row.name);
    if (id && title) out.set(id, title);
  }
  return out;
}
