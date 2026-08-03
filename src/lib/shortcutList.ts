import type { ListViewItem, ManifestAction } from 'asyar-sdk/contracts';

import type { Shortcut } from './shortcutsWorker';

export const RUN_SHORTCUT_ACTION = 'run-shortcut';
export const EDIT_SHORTCUT_ACTION = 'edit-shortcut';

const SHORTCUT_ACTIONS: ManifestAction[] = [
  {
    id: RUN_SHORTCUT_ACTION,
    title: 'Run Shortcut',
    description: 'Run the selected shortcut',
    icon: 'icon:layers',
    category: 'Primary',
  },
  {
    id: EDIT_SHORTCUT_ACTION,
    title: 'Edit Shortcut',
    description: 'Open the shortcut in Shortcuts.app',
    icon: 'icon:pencil',
    category: 'Primary',
  },
];

/** Empty cached icons are missing icons, just like `undefined`. */
export function shortcutIconOrFallback(
  icon: string | undefined,
  fallbackIcon: string,
): string {
  return icon || fallbackIcon;
}

/** Convert one cached shortcut into the host-owned full-list row contract. */
export function shortcutListItem(
  shortcut: Shortcut,
  fallbackIcon: string,
): ListViewItem {
  const takesInput = shortcut.takesInput === true;
  return {
    id: shortcut.id,
    title: shortcut.name,
    icon: shortcutIconOrFallback(shortcut.icon, fallbackIcon),
    accessory: 'Shortcut',
    trailing: takesInput ? [{ kind: 'badge', text: '↪ Input' }] : undefined,
    arguments: takesInput
      ? [{ name: 'input', type: 'text', placeholder: 'Input...' }]
      : undefined,
    actions: SHORTCUT_ACTIONS,
  };
}
