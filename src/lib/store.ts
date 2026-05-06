import type { IStorageService } from 'asyar-sdk/contracts';
import type { Shortcut } from './shortcutsWorker';

const CACHE_KEY = 'shortcutsCache';

export async function saveShortcutsCache(
  storage: IStorageService,
  shortcuts: Shortcut[],
): Promise<void> {
  await storage.set(CACHE_KEY, JSON.stringify(shortcuts));
}

export async function loadShortcutsCache(
  storage: IStorageService,
): Promise<Shortcut[]> {
  const raw = await storage.get(CACHE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Shortcut[];
  } catch {
    return [];
  }
}
