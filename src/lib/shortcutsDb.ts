import type { IShellService, ShellHandle } from 'asyar-sdk/contracts';
import { parseList, type Shortcut } from './shortcutsWorker';

const DB_MARKER = '__ASYAR_SHORTCUTS_DB__';
const CLI_MARKER = '__ASYAR_SHORTCUTS_CLI__';

/**
 * Read the shortcut library straight from Shortcuts.app's own database.
 * This is the only source for icon colour/glyph and the "uses Shortcut
 * Input" flag; the `shortcuts` CLI exposes none of them. Read-only, and
 * `shortcuts list` is the fallback when this fails (e.g. Shortcuts.app
 * changes its schema, or the app denies access to ~/Library/Shortcuts).
 */
const QUERY = [
  'SELECT s.ZNAME AS name, s.ZWORKFLOWID AS id,',
  'i.ZBACKGROUNDCOLORVALUE AS colorValue, i.ZGLYPHNUMBER AS glyph,',
  's.ZASSOCIATEDAPPBUNDLEIDENTIFIER AS appBundleId,',
  's.ZHASSHORTCUTINPUTVARIABLES AS takesInput',
  'FROM ZSHORTCUT s LEFT JOIN ZSHORTCUTICON i ON i.ZWORKFLOW = s.Z_PK',
  'WHERE (s.ZTOMBSTONED = 0 OR s.ZTOMBSTONED IS NULL)',
  // A conflict copy is the losing side of an iCloud sync clash. Shortcuts
  // keeps the row but hides it from the library, so listing it shows the
  // user a duplicate of a shortcut they only have one of.
  'AND s.ZCONFLICTOF IS NULL',
  'AND s.ZWORKFLOWID IS NOT NULL ORDER BY s.ZNAME',
].join(' ');

interface DbRow {
  name?: unknown;
  id?: unknown;
  colorValue?: unknown;
  glyph?: unknown;
  appBundleId?: unknown;
  takesInput?: unknown;
}

export interface ShortcutListResult {
  shortcuts: Shortcut[];
  source: 'database' | 'cli';
}

/**
 * The db lives at a $HOME-relative path and the worker has no way to
 * resolve $HOME itself, so the read goes through `sh -c` and lets the
 * shell expand it. SQLite and `shortcuts list` are deliberately one shell
 * transaction: the tracked process succeeds when either source works and
 * fails only when the extension cannot refresh at all. The SQL contains
 * no quotes and no user input.
 *
 * This refresh is internal plumbing, so the launcher owns its routine
 * subprocess presentation while the caller reports refresh failures in the
 * UI.
 */
export function pullShortcutList(shell: IShellService): Promise<ShortcutListResult> {
  return new Promise((resolve, reject) => {
    const handle: ShellHandle = shell.spawn({
      program: '/bin/sh',
      args: [
        '-c',
        [
          `if db_output=$(/usr/bin/sqlite3 -readonly -json "$HOME/Library/Shortcuts/Shortcuts.sqlite" '${QUERY}'); then`,
          `  printf '%s\\n%s\\n' '${DB_MARKER}' "$db_output"`,
          'else',
          `  printf '%s\\n' '${CLI_MARKER}'`,
          '  exec /usr/bin/shortcuts list --show-identifiers',
          'fi',
        ].join('\n'),
      ],
    });
    const lines: string[] = [];
    handle.onChunk(({ stream, data }) => {
      if (stream === 'stdout') lines.push(data);
    });
    handle.onDone((code) => {
      if (code !== 0 && code !== undefined) {
        reject(new Error(`shortcut refresh exited with code ${code}`));
        return;
      }
      try {
        const [marker, ...payload] = lines;
        if (marker === DB_MARKER) {
          resolve({ shortcuts: parseRows(payload.join('\n')), source: 'database' });
        } else if (marker === CLI_MARKER) {
          resolve({ shortcuts: parseList(payload), source: 'cli' });
        } else {
          reject(new Error('unexpected shortcut refresh output'));
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    handle.onError((err) => reject(new Error(err.message)));
  });
}

function parseRows(json: string): Shortcut[] {
  const trimmed = json.trim();
  if (!trimmed) return [];
  const rows = JSON.parse(trimmed) as DbRow[];
  if (!Array.isArray(rows)) throw new Error('unexpected sqlite3 output');
  const out: Shortcut[] = [];
  for (const row of rows) {
    if (typeof row?.id !== 'string' || typeof row?.name !== 'string') continue;
    const s: Shortcut = { id: row.id, name: row.name };
    if (typeof row.colorValue === 'number') s.colorValue = row.colorValue;
    if (typeof row.glyph === 'number') s.glyph = row.glyph;
    if (typeof row.appBundleId === 'string' && row.appBundleId) {
      s.appBundleId = row.appBundleId;
    }
    if (row.takesInput === 1) s.takesInput = true;
    out.push(s);
  }
  return out;
}
