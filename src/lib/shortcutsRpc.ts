export interface RunShortcutRequest {
  /** Stable UUID accepted by `shortcuts run`; survives shortcut renames. */
  id: string;
  /** Current display name, retained for user-facing logs and errors. */
  name: string;
  input?: string;
}

export type ShortcutRpcReply = { ok: true } | { ok: false; message: string };

/** Keep view-to-worker RPC comfortably inside the host's five-second timeout. */
export const SHORTCUT_RUN_ACK_GRACE_MS = 250;

export interface ShortcutRunRequestRegistrar {
  onRequest<TPayload, TResult>(
    id: string,
    handler: (payload: TPayload, signal: AbortSignal) => Promise<TResult>,
  ): () => void;
}

export type ShortcutRunHandler = (
  id: string,
  name: string,
  input?: string,
) => Promise<ShortcutRpcReply>;

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

/** A successful run request is a completed launcher action: hand focus back
 * to the user's previous app. Failures deliberately keep the list visible so
 * its feedback remains readable and the action can be retried. */
export function dismissLauncherAfterShortcutHandoff(
  reply: ShortcutRpcReply,
  hideLauncher: () => void,
): void {
  if (reply.ok) hideLauncher();
}

/**
 * Start a worker-owned shortcut job and give its handoff a short chance to
 * fail before acknowledging the view transport. Spawn errors normally arrive
 * immediately and should stay visible in the open view; a shortcut that keeps
 * running past the grace period owns its later completion logging/background
 * notification in the worker and must not consume the five-second RPC budget.
 */
export async function acknowledgeStartedShortcutRun(
  start: () => Promise<ShortcutRpcReply>,
  graceMs = SHORTCUT_RUN_ACK_GRACE_MS,
): Promise<ShortcutRpcReply> {
  const stillRunning = Symbol('shortcut-still-running');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceElapsed = new Promise<typeof stillRunning>((resolve) => {
    timer = setTimeout(() => resolve(stillRunning), Math.max(0, graceMs));
  });

  try {
    const reply = await Promise.race([start(), graceElapsed]);
    return reply === stillRunning ? { ok: true } : reply;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Register the worker RPC at the same seam used by the real entry point.
 * Keeping the grace policy here prevents a future registration from
 * accidentally wiring the completion promise directly back to the view.
 */
export function registerShortcutRunRequest(
  context: ShortcutRunRequestRegistrar,
  run: ShortcutRunHandler,
  graceMs = SHORTCUT_RUN_ACK_GRACE_MS,
): () => void {
  return context.onRequest<RunShortcutRequest, ShortcutRpcReply>(
    'runShortcut',
    async ({ id, name, input }) =>
      acknowledgeStartedShortcutRun(() => run(id, name, input), graceMs),
  );
}
