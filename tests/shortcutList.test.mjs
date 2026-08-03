import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EDIT_SHORTCUT_ACTION,
  RUN_SHORTCUT_ACTION,
  shortcutIconOrFallback,
  shortcutListItem,
} from '../src/lib/shortcutList.ts';
import {
  refreshFailureMessage,
  shortcutRunRequest,
} from '../src/lib/shortcutsRpc.ts';

const FALLBACK_ICON = 'data:image/svg+xml;utf8,fallback';

test('maps an input-capable shortcut to the complete host row contract', () => {
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
  assert.deepEqual(item.trailing, [{ kind: 'badge', text: '↪ Input' }]);
  assert.deepEqual(item.arguments, [
    { name: 'input', type: 'text', placeholder: 'Input...' },
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
