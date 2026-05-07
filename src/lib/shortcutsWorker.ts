import type { IShellService, ShellHandle } from 'asyar-sdk/contracts';

export interface Shortcut {
  /** Stable UUID from `shortcuts list --show-identifiers`. Survives renames. */
  id: string;
  /** Current display name. May change if the user renames the shortcut. */
  name: string;
}

/**
 * Enumerate the user's Apple Shortcuts. Uses `--show-identifiers` so each
 * shortcut comes back with its stable UUID — safe to persist as the
 * argument-default key, immune to user renames.
 */
export function pullList(shell: IShellService): Promise<Shortcut[]> {
  return new Promise((resolve, reject) => {
    const handle: ShellHandle = shell.spawn({
      program: '/usr/bin/shortcuts',
      args: ['list', '--show-identifiers'],
    });
    const lines: string[] = [];
    handle.onChunk(({ stream, data }) => {
      if (stream === 'stdout') lines.push(data);
    });
    handle.onDone((code) => {
      if (code === 0 || code === undefined) {
        resolve(parseList(lines));
      } else {
        reject(new Error(`shortcuts list exited with code ${code}`));
      }
    });
    handle.onError((err) => reject(new Error(err.message)));
  });
}

/**
 * Run a shortcut by id or name, optionally piping `input` to it via stdin.
 *
 * macOS' `shortcuts run` only accepts input from a file path
 * (`--input-path`); `-` means stdin. The shell SDK does not expose stdin
 * write on a child process, so we use
 * `/bin/sh -c 'printf … | shortcuts run … --input-path -'` when an input
 * value is supplied. With no input, we run `shortcuts run` directly to
 * avoid the extra trust prompt for `/bin/sh`.
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
    handle.onError((err) => reject(new Error(err.message)));
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
function parseList(lines: string[]): Shortcut[] {
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
