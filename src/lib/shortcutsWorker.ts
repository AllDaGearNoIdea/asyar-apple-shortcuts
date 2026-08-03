import type { IShellService, ShellHandle } from 'asyar-sdk/contracts';

export interface Shortcut {
  /** Stable UUID from `shortcuts list --show-identifiers`. Survives renames. */
  id: string;
  /** Current display name. May change if the user renames the shortcut. */
  name: string;
  /** Icon background colour as Shortcuts stores it (signed RGBA int). */
  colorValue?: number;
  /** Icon glyph number as Shortcuts stores it. */
  glyph?: number;
  /**
   * App the shortcut is associated with. Shortcuts shows that app's icon
   * instead of the glyph whenever this is set, so it wins here too.
   */
  appBundleId?: string;
  /** True when the shortcut declares Shortcut Input variables. */
  takesInput?: boolean;
  /** Resolved row icon: an app icon URL or a rendered tile data URI. */
  icon?: string;
}

/**
 * The hand-off to `shortcuts` never happened: the process could not be
 * spawned at all, so nothing ran and nothing else will report it. A
 * non-zero exit is the opposite case, the shortcut ran and failed on its
 * own terms, and Shortcuts.app raises its own notification for that.
 */
export class ShortcutHandoffError extends Error {}

/**
 * Run a shortcut by id or name, optionally piping `input` to it via stdin.
 *
 * macOS' `shortcuts run` only accepts input from a file path
 * (`--input-path`); `-` means stdin. The shell SDK does not expose stdin
 * write on a child process, so we use
 * `/bin/sh -c 'printf … | shortcuts run … --input-path -'` when an input
 * value is supplied. With no input, we run `shortcuts run` directly to
 * avoid the extra trust prompt for `/bin/sh`.
 *
 * The launcher owns routine subprocess presentation. The callbacks below
 * still distinguish a failed hand-off from a non-zero shortcut exit so the
 * caller can preserve its existing error handling.
 */
export function runShortcut(
  shell: IShellService,
  idOrName: string,
  input?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle: ShellHandle =
      input !== undefined && input !== ''
        ? shell.spawn({
            program: '/bin/sh',
            args: [
              '-c',
              `printf %s ${shQuote(input)} | /usr/bin/shortcuts run ${shQuote(idOrName)} --input-path -`,
            ],
          })
        : shell.spawn({
            program: '/usr/bin/shortcuts',
            args: ['run', idOrName],
          });

    handle.onDone((code) => {
      if (code === 0 || code === undefined) {
        resolve();
      } else {
        reject(new Error(`shortcuts run exited with code ${code}`));
      }
    });
    handle.onError((err) => reject(new ShortcutHandoffError(err.message)));
  });
}

/**
 * Open a shortcut in Shortcuts.app's editor, launching the app if it isn't
 * already running. `shortcuts://open-shortcut` takes a name, not an id, so
 * this is the one path that cannot be made rename-safe.
 *
 * Routed through `/bin/sh` rather than spawning `open` directly so the
 * extension does not have to ask for a second program's trust; the shell is
 * already granted for the input-piping path.
 */
export function openShortcutInEditor(
  shell: IShellService,
  name: string,
): Promise<void> {
  const url = `shortcuts://open-shortcut?name=${encodeURIComponent(name)}`;
  return new Promise((resolve, reject) => {
    const handle = shell.spawn({
      program: '/bin/sh',
      args: ['-c', `/usr/bin/open ${shQuote(url)}`],
    });
    handle.onDone((code) => {
      if (code === 0 || code === undefined) resolve();
      else reject(new Error(`open exited with code ${code}`));
    });
    handle.onError((err) => reject(new ShortcutHandoffError(err.message)));
  });
}

/**
 * POSIX single-quote escape: wrap the string in single quotes and replace
 * any embedded single quote with `'\''` (close-quote, escaped quote,
 * reopen-quote). Safe for `/bin/sh -c '…'` even with arbitrary user input.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse `shortcuts list --show-identifiers` output. Each line is
 * `Name (UUID)`; the UUID is the load-bearing identifier.
 *
 * The Asyar shell SDK delivers one line per `onChunk` callback (the
 * trailing newline is stripped before the chunk arrives), so we iterate
 * the raw chunks directly — joining and re-splitting on `\n` collapses
 * everything into a single giant line and produces one bogus entry.
 *
 * Falls back to using the line itself as both id and name when the UUID
 * suffix is missing, so an older `shortcuts` binary that doesn't emit
 * identifiers still produces a usable list (without rename-safety).
 */
export function parseList(lines: string[]): Shortcut[] {
  const out: Shortcut[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.+?)\s+\(([0-9A-Fa-f-]{8,})\)$/);
    if (m) {
      out.push({ id: m[2], name: m[1] });
    } else {
      out.push({ id: line, name: line });
    }
  }
  return out;
}
