import type { ISearchService } from 'asyar-sdk/contracts';

import type { Shortcut } from './shortcutsWorker';

/** Delegate filtering and ordering to the launcher's Rust-backed ranker. */
export async function rankShortcuts(
  search: ISearchService,
  query: string,
  shortcuts: Shortcut[],
): Promise<Shortcut[]> {
  const orderedIds = await search.rank(
    query,
    shortcuts.map((shortcut) => ({
      id: shortcut.id,
      title: shortcut.name,
    })),
  );
  const byId = new Map(shortcuts.map((shortcut) => [shortcut.id, shortcut]));

  return orderedIds.flatMap((id) => {
    const shortcut = byId.get(id);
    return shortcut ? [shortcut] : [];
  });
}
