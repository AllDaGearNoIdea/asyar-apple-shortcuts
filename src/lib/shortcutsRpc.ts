export interface RunShortcutRequest {
  /** Stable UUID accepted by `shortcuts run`; survives shortcut renames. */
  id: string;
  /** Current display name, retained for user-facing logs and errors. */
  name: string;
  input?: string;
}

export type ShortcutRpcReply = { ok: true } | { ok: false; message: string };

export type RefreshShortcutsReply =
  | { status: 'refreshed' }
  | { status: 'queued' }
  | { status: 'failed'; message: string };

/** Only a completed, definite failure carries an error for a manual retry. */
export function refreshFailureMessage(reply: RefreshShortcutsReply): string | null {
  return reply.status === 'failed' ? reply.message : null;
}

/** Build the exact view-to-worker run payload, omitting only absent input. */
export function shortcutRunRequest(
  shortcut: Pick<RunShortcutRequest, 'id' | 'name'>,
  input?: string,
): RunShortcutRequest {
  return {
    id: shortcut.id,
    name: shortcut.name,
    ...(input === undefined ? {} : { input }),
  };
}
