import { describe, expect, it, vi } from 'vitest';
import type { IFeedbackService } from 'asyar-sdk/contracts';

import { runShortcutWithFeedback } from './runShortcutFlow';

function makeFeedback() {
  const progress = {
    update: vi.fn(async () => undefined),
    succeed: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
  };
  const feedback = {
    showProgress: vi.fn(async () => progress),
  } as unknown as IFeedbackService;

  return { feedback, progress };
}

describe('runShortcutWithFeedback', () => {
  it('finishes unified progress feedback after running a shortcut', async () => {
    const { feedback, progress } = makeFeedback();
    const run = vi.fn(async () => undefined);

    await expect(
      runShortcutWithFeedback(
        feedback,
        run,
        { id: 'shortcut-id', name: 'Morning routine' },
        'hello',
      ),
    ).resolves.toEqual({ ok: true });

    expect(feedback.showProgress).toHaveBeenCalledWith({
      title: 'Running Morning routine',
    });
    expect(run).toHaveBeenCalledWith('shortcut-id', 'hello');
    expect(progress.succeed).toHaveBeenCalledWith('Ran Morning routine');
  });

  it('finishes unified progress feedback with the execution error', async () => {
    const { feedback, progress } = makeFeedback();
    const run = vi.fn(async () => {
      throw new Error('shortcuts run exited with code 1');
    });

    await expect(
      runShortcutWithFeedback(feedback, run, {
        id: 'shortcut-id',
        name: 'Broken shortcut',
      }),
    ).resolves.toEqual({
      ok: false,
      message: 'shortcuts run exited with code 1',
    });

    expect(progress.fail).toHaveBeenCalledWith(
      'Could not run Broken shortcut',
      'shortcuts run exited with code 1',
    );
  });

  it('does not block shortcut execution when feedback cannot be presented', async () => {
    const feedback = {
      showProgress: vi.fn(async () => {
        throw new Error('feedback unavailable');
      }),
    } as unknown as IFeedbackService;
    const run = vi.fn(async () => undefined);

    await expect(
      runShortcutWithFeedback(feedback, run, {
        id: 'shortcut-id',
        name: 'Still runs',
      }),
    ).resolves.toEqual({ ok: true });

    expect(run).toHaveBeenCalledWith('shortcut-id', undefined);
  });
});
