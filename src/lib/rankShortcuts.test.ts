import { describe, expect, it, vi } from 'vitest';
import type { ISearchService } from 'asyar-sdk/contracts';

import { rankShortcuts } from './rankShortcuts';

describe('rankShortcuts', () => {
  it('delegates matching and ordering to the SDK Rust search service', async () => {
    const search = {
      rank: vi.fn(async () => ['second', 'first']),
    } as unknown as ISearchService;
    const shortcuts = [
      { id: 'first', name: 'Morning routine' },
      { id: 'second', name: 'Start meeting' },
    ];

    await expect(rankShortcuts(search, 'meeting', shortcuts)).resolves.toEqual([
      shortcuts[1],
      shortcuts[0],
    ]);
    expect(search.rank).toHaveBeenCalledWith('meeting', [
      { id: 'first', title: 'Morning routine' },
      { id: 'second', title: 'Start meeting' },
    ]);
  });
});
