import type { ShortcutRpcReply } from './shortcutsRpc';

export interface ShortcutRunReporting {
  onSuccess(): void;
  onRunFailure(message: string): void;
  isHandoffFailure(error: unknown): boolean;
  notifyHandoffFailure(message: string): Promise<unknown>;
  onNotificationFailure(error: unknown): void;
}

function describeRunError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Complete and report a worker-owned shortcut run. A failed process handoff
 * is returned to the open view immediately; its system-notification fallback
 * deliberately runs on a detached promise so notification latency or denial
 * cannot turn the view RPC into a timeout or false success.
 */
export async function runShortcutWithReporting(
  execute: () => Promise<void>,
  reporting: ShortcutRunReporting,
): Promise<ShortcutRpcReply> {
  try {
    await execute();
    reporting.onSuccess();
    return { ok: true };
  } catch (error) {
    const message = describeRunError(error);
    reporting.onRunFailure(message);

    if (reporting.isHandoffFailure(error)) {
      void Promise.resolve()
        .then(() => reporting.notifyHandoffFailure(message))
        .catch((notificationError: unknown) => {
          try {
            reporting.onNotificationFailure(notificationError);
          } catch {
            // Reporting a notification failure must not create an unhandled
            // rejection in the worker.
          }
        });
    }

    return { ok: false, message };
  }
}
