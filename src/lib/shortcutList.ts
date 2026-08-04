import type {
  CommandArgument,
  DynamicCommandRegistration,
  ListViewItem,
  ManifestAction,
} from 'asyar-sdk/contracts';

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

/** One-off Shortcut Input must start empty and never enter last-used storage. */
export function shortcutArguments(
  shortcut: Pick<Shortcut, 'takesInput'>,
): CommandArgument[] | undefined {
  return shortcut.takesInput === true
    ? [{ name: 'input', type: 'text', placeholder: 'Input...', seed: 'none' }]
    : undefined;
}

/** Convert one cached shortcut into its root-search dynamic command. */
export function shortcutDynamicCommand(
  shortcut: Shortcut,
  fallbackIcon: string,
  warning?: string,
): DynamicCommandRegistration {
  return {
    id: shortcut.id,
    name: shortcut.name,
    description: warning,
    typeLabel: 'Apple Shortcut',
    icon: shortcutIconOrFallback(shortcut.icon, fallbackIcon),
    arguments: shortcutArguments(shortcut),
  };
}

/** Convert one cached shortcut into the host-owned full-list row contract. */
export function shortcutListItem(
  shortcut: Shortcut,
  fallbackIcon: string,
): ListViewItem {
  return {
    id: shortcut.id,
    title: shortcut.name,
    icon: shortcutIconOrFallback(shortcut.icon, fallbackIcon),
    accessory: 'Shortcut',
    arguments: shortcutArguments(shortcut),
    actions: SHORTCUT_ACTIONS,
  };
}
