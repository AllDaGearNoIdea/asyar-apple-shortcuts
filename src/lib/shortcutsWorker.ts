import type { IShellService, ShellHandle } from 'asyar-sdk/contracts';

export interface Shortcut {
  id: string;
  name: string;
}

export function pullList(shell: IShellService): Promise<Shortcut[]> {
  return new Promise((resolve, reject) => {
    const handle: ShellHandle = shell.spawn({
      program: '/usr/bin/shortcuts',
      args: ['list'],
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

export function runShortcut(shell: IShellService, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const handle: ShellHandle = shell.spawn({
      program: '/usr/bin/shortcuts',
      args: ['run', name],
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

function parseList(lines: string[]): Shortcut[] {
  const out: Shortcut[] = [];
  for (const raw of lines) {
    const name = raw.trim();
    if (!name) continue;
    out.push({ id: name, name });
  }
  return out;
}
