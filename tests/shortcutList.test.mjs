import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EDIT_SHORTCUT_ACTION,
  RUN_SHORTCUT_ACTION,
  shortcutDynamicCommand,
  shortcutIconOrFallback,
  shortcutListItem,
} from '../src/lib/shortcutList.ts';
import {
  dismissLauncherForShortcutRun,
  acknowledgeStartedShortcutRun,
  refreshFailureMessage,
  registerShortcutRunRequest,
  SHORTCUT_RUN_ACK_GRACE_MS,
  shortcutRunRequest,
} from '../src/lib/shortcutsRpc.ts';
import { runShortcutWithReporting } from '../src/lib/shortcutRunCoordinator.ts';
import { ShortcutHandoffError } from '../src/lib/shortcutsWorker.ts';

const FALLBACK_ICON = 'data:image/svg+xml;utf8,fallback';

test('maps an input-capable shortcut without a cosmetic row affordance', () => {
  const item = shortcutListItem(
    {
      id: '82D35B42-626E-4939-B246-53CA49A59D30',
      name: 'Summarise Clipboard',
      icon: 'data:image/png;base64,shortcut',
      takesInput: true,
    },
    FALLBACK_ICON,
  );

  assert.equal(item.id, '82D35B42-626E-4939-B246-53CA49A59D30');
  assert.equal(item.title, 'Summarise Clipboard');
  assert.equal(item.icon, 'data:image/png;base64,shortcut');
  assert.equal(item.accessory, 'Shortcut');
  assert.equal(item.trailing, undefined);
  assert.deepEqual(item.arguments, [
    { name: 'input', type: 'text', placeholder: 'Input...', seed: 'none' },
  ]);
  assert.deepEqual(
    item.actions?.map(({ id }) => id),
    [RUN_SHORTCUT_ACTION, EDIT_SHORTCUT_ACTION],
  );
});

test('uses the manifest icon and omits input affordances for a basic shortcut', () => {
  const item = shortcutListItem(
    {
      id: 'BB7896E9-B886-45E4-A64A-10D92F7BFBA2',
      name: 'Start Focus',
      icon: '',
    },
    FALLBACK_ICON,
  );

  assert.equal(item.icon, FALLBACK_ICON);
  assert.equal(item.trailing, undefined);
  assert.equal(item.arguments, undefined);
  assert.equal(shortcutIconOrFallback(undefined, FALLBACK_ICON), FALLBACK_ICON);
});

test('dynamic shortcut input also starts empty without last-used persistence', () => {
  const command = shortcutDynamicCommand(
    {
      id: '82D35B42-626E-4939-B246-53CA49A59D30',
      name: 'Summarise Clipboard',
      takesInput: true,
    },
    FALLBACK_ICON,
    'May be out of date',
  );

  assert.equal(command.typeLabel, 'Apple Shortcut');
  assert.equal(command.description, 'May be out of date');
  assert.deepEqual(command.arguments, [
    { name: 'input', type: 'text', placeholder: 'Input...', seed: 'none' },
  ]);
});

test('shortcut dispatch dismisses before the handoff acknowledgement settles', async () => {
  const order = [];
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });

  const observed = dismissLauncherForShortcutRun(pending, () => {
    order.push('hidden');
  }).then((reply) => {
    order.push(reply.ok ? 'acknowledged' : 'failed');
    return reply;
  });

  assert.deepEqual(order, ['hidden']);
  settle({ ok: true });
  assert.deepEqual(await observed, { ok: true });
  assert.deepEqual(order, ['hidden', 'acknowledged']);
});

test('shortcut dispatch preserves a later failure reply for reporting', async () => {
  const failure = Promise.resolve({
    ok: false,
    message: 'Shortcut could not start',
  });
  let hidden = 0;

  const reply = await dismissLauncherForShortcutRun(failure, () => {
    hidden += 1;
  });

  assert.equal(hidden, 1);
  assert.deepEqual(reply, {
    ok: false,
    message: 'Shortcut could not start',
  });
});

test('builds the stable-id run RPC payload and omits only absent input', () => {
  const shortcut = {
    id: '82D35B42-626E-4939-B246-53CA49A59D30',
    name: 'Summarise Clipboard',
  };

  assert.deepEqual(shortcutRunRequest(shortcut), {
    id: shortcut.id,
    name: shortcut.name,
  });
  assert.deepEqual(shortcutRunRequest(shortcut, ''), {
    id: shortcut.id,
    name: shortcut.name,
    input: '',
  });
  assert.deepEqual(shortcutRunRequest(shortcut, 'hello'), {
    id: shortcut.id,
    name: shortcut.name,
    input: 'hello',
  });
});

test('distinguishes a queued refresh from a definite retry failure', () => {
  assert.equal(refreshFailureMessage({ status: 'refreshed' }), null);
  assert.equal(refreshFailureMessage({ status: 'queued' }), null);
  assert.equal(
    refreshFailureMessage({ status: 'failed', message: 'shortcuts list failed' }),
    'shortcuts list failed',
  );
});

test('returns a fast shortcut handoff failure during the grace period', async () => {
  const reply = await acknowledgeStartedShortcutRun(
    async () => ({ ok: false, message: 'spawn denied' }),
    20,
  );

  assert.deepEqual(reply, { ok: false, message: 'spawn denied' });
});

test('acknowledges a long-running shortcut job after the handoff grace', async () => {
  let started = false;
  const neverCompletes = new Promise(() => {});

  const reply = await acknowledgeStartedShortcutRun(() => {
    started = true;
    return neverCompletes;
  }, 1);

  assert.equal(started, true);
  assert.deepEqual(reply, { ok: true });
});

function captureRunRequest(run, graceMs) {
  let registration;
  const context = {
    onRequest(id, handler) {
      registration = { id, handler };
      return () => {};
    },
  };
  registerShortcutRunRequest(context, run, graceMs);
  assert.equal(registration?.id, 'runShortcut');
  return registration.handler;
}

test('worker entry point wires runShortcut through the grace-policy registrar', async () => {
  const workerSource = await readFile(
    new URL('../src/worker.ts', import.meta.url),
    'utf8',
  );

  assert.match(
    workerSource,
    /registerShortcutRunRequest\(workerContext,\s*\(id, name, input\) =>\s*impl\.runById\(id, name, input\)/,
  );
  assert.doesNotMatch(
    workerSource,
    /workerContext\.onRequest[^;]*['"]runShortcut['"]/s,
  );
});

test('worker runShortcut registration returns an immediate handoff failure without awaiting notification latency', async () => {
  let notificationStarted = false;
  let resolveNotification;
  const notification = new Promise((resolve) => {
    resolveNotification = resolve;
  });

  const handler = captureRunRequest((id, name, input) => {
    assert.deepEqual(
      { id, name, input },
      { id: 'shortcut-id', name: 'Example', input: 'payload' },
    );
    return runShortcutWithReporting(
      async () => {
        throw new ShortcutHandoffError('spawn denied');
      },
      {
        onSuccess: () => assert.fail('failed handoff cannot succeed'),
        onRunFailure: () => {},
        isHandoffFailure: (error) => error instanceof ShortcutHandoffError,
        notifyHandoffFailure: () => {
          notificationStarted = true;
          return notification;
        },
        onNotificationFailure: () => {},
      },
    );
  }, 20);

  const reply = await handler(
    { id: 'shortcut-id', name: 'Example', input: 'payload' },
    new AbortController().signal,
  );

  assert.deepEqual(reply, { ok: false, message: 'spawn denied' });
  assert.equal(notificationStarted, true);
  resolveNotification();
});

test('worker runShortcut registration acknowledges a long-running job through the grace wrapper', async () => {
  const neverCompletes = new Promise(() => {});
  const handler = captureRunRequest(() => neverCompletes, 1);

  const reply = await Promise.race([
    handler(
      { id: 'shortcut-id', name: 'Example' },
      new AbortController().signal,
    ),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('registered handler exceeded its grace')),
        100,
      ),
    ),
  ]);

  assert.deepEqual(reply, { ok: true });
  assert.equal(SHORTCUT_RUN_ACK_GRACE_MS, 250);
});

test('a handoff failure after acknowledgement still starts its detached notification', async () => {
  let rejectExecution;
  let notificationCount = 0;
  const execution = new Promise((_, reject) => {
    rejectExecution = reject;
  });
  const pendingNotification = new Promise(() => {});
  const handler = captureRunRequest(
    () =>
      runShortcutWithReporting(() => execution, {
        onSuccess: () => assert.fail('failed handoff cannot succeed'),
        onRunFailure: () => {},
        isHandoffFailure: (error) => error instanceof ShortcutHandoffError,
        notifyHandoffFailure: () => {
          notificationCount += 1;
          return pendingNotification;
        },
        onNotificationFailure: () => {},
      }),
    1,
  );

  const reply = await handler(
    { id: 'shortcut-id', name: 'Example' },
    new AbortController().signal,
  );
  assert.deepEqual(reply, { ok: true });

  rejectExecution(new ShortcutHandoffError('late spawn failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notificationCount, 1);
});

test('notification rejection is detached from the handoff reply and reported', async () => {
  const notificationFailures = [];
  const reply = await runShortcutWithReporting(
    async () => {
      throw new ShortcutHandoffError('permission denied');
    },
    {
      onSuccess: () => assert.fail('failed handoff cannot succeed'),
      onRunFailure: () => {},
      isHandoffFailure: (error) => error instanceof ShortcutHandoffError,
      notifyHandoffFailure: async () => {
        throw new Error('notifications unavailable');
      },
      onNotificationFailure: (error) => notificationFailures.push(error),
    },
  );

  assert.deepEqual(reply, { ok: false, message: 'permission denied' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notificationFailures.length, 1);
  assert.equal(notificationFailures[0].message, 'notifications unavailable');
});
