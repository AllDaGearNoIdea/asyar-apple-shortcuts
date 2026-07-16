import type {
  FeedbackProgressHandle,
  IFeedbackService,
} from 'asyar-sdk/contracts';

import type { Shortcut } from './shortcutsWorker';

export type ShortcutRunner = (
  idOrName: string,
  input?: string,
) => Promise<void>;

export type ShortcutRunResult =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Runs one shortcut while reporting its lifecycle through the SDK's unified
 * feedback surface. Feedback failures are deliberately best-effort: a host
 * presentation problem must never prevent the shortcut itself from running.
 */
export async function runShortcutWithFeedback(
  feedback: IFeedbackService,
  run: ShortcutRunner,
  shortcut: Shortcut,
  input?: string,
): Promise<ShortcutRunResult> {
  let progress: FeedbackProgressHandle | undefined;
  try {
    progress = await feedback.showProgress({
      title: `Running ${shortcut.name}`,
    });
  } catch {
    // Feedback is supplementary; execution remains the source of truth.
  }

  try {
    await run(shortcut.id || shortcut.name, input);
    await bestEffort(() => progress?.succeed(`Ran ${shortcut.name}`));
    return { ok: true };
  } catch (error) {
    const message = describe(error);
    await bestEffort(() =>
      progress?.fail(`Could not run ${shortcut.name}`, message),
    );
    return { ok: false, message };
  }
}

async function bestEffort(
  operation: () => Promise<void> | undefined,
): Promise<void> {
  try {
    await operation();
  } catch {
    // The shortcut result must not be replaced by a feedback transport error.
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
