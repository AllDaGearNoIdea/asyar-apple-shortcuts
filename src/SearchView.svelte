<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { ExtensionContext } from 'asyar-sdk/view';
  import type { ExtensionStateProxy, IExtensionManager } from 'asyar-sdk/contracts';

  import type { Shortcut } from './lib/shortcutsWorker';

  interface Props {
    context: ExtensionContext;
  }
  let { context }: Props = $props();

  const stateProxy = context.getService<ExtensionStateProxy>('state');
  const extensions = context.getService<IExtensionManager>('extensions');

  let shortcuts = $state<Shortcut[]>([]);
  /**
   * Per-shortcut "accepts input" flags, mirrored from the worker's state
   * key `shortcuts.acceptsInputFlags`. A `true` entry means the launcher
   * should declare an `input` argument for that shortcut so root-search
   * Tab opens the inline chip. Missing entries default to false.
   */
  let acceptsInputFlags = $state<Record<string, boolean>>({});
  let loaded = $state(false);
  let searchQuery = $state('');
  let selectedIndex = $state(0);
  let runError = $state<string | null>(null);

  let unsubscribe: (() => Promise<void>) | null = null;
  let unsubscribeFlags: (() => Promise<void>) | null = null;

  void (async () => {
    try {
      const initial = (await stateProxy.get('shortcuts.list')) as Shortcut[] | null;
      if (initial && Array.isArray(initial)) shortcuts = initial;
    } catch {}
    try {
      const initialFlags = (await stateProxy.get('shortcuts.acceptsInputFlags')) as
        | Record<string, boolean>
        | null;
      if (initialFlags && typeof initialFlags === 'object') acceptsInputFlags = initialFlags;
    } catch {}
    loaded = true;
    try {
      unsubscribe = await stateProxy.subscribe('shortcuts.list', (v) => {
        shortcuts = (v as Shortcut[] | null) ?? [];
      });
    } catch {}
    try {
      unsubscribeFlags = await stateProxy.subscribe('shortcuts.acceptsInputFlags', (v) => {
        acceptsInputFlags = (v as Record<string, boolean> | null) ?? {};
      });
    } catch {}
  })();

  onMount(() => {
    extensions.setActiveViewActionLabel('Run');

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'asyar:view:search') {
        searchQuery = String(data.payload?.query ?? '');
      } else if (data.type === 'asyar:view:keydown') {
        const key = data.payload?.key;
        if (key === 'ArrowDown') {
          selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
          scrollToSelected();
        } else if (key === 'ArrowUp') {
          selectedIndex = Math.max(selectedIndex - 1, 0);
          scrollToSelected();
        } else if (key === 'Enter') {
          const selected = filtered[selectedIndex];
          if (selected) void handleRun(selected);
        }
      }
    };
    window.addEventListener('message', onMessage);

    return () => {
      window.removeEventListener('message', onMessage);
      extensions.setActiveViewActionLabel(null);
    };
  });

  onDestroy(() => {
    if (unsubscribe) void unsubscribe();
    if (unsubscribeFlags) void unsubscribeFlags();
  });

  let filtered = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return shortcuts;
    return shortcuts.filter((s) => s.name.toLowerCase().includes(q));
  });

  $effect(() => {
    filtered;
    selectedIndex = 0;
  });

  async function handleRun(shortcut: Shortcut) {
    runError = null;
    try {
      const reply = await context.request<
        { name: string },
        { ok: true } | { ok: false; message: string }
      >('runShortcut', { name: shortcut.name });
      if (!reply.ok) {
        runError = reply.message;
      }
    } catch (err: unknown) {
      runError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Flip the "accepts input" flag for one shortcut. The worker persists
   * the change and re-publishes the dynamic command list so the
   * launcher's root-search argument mode reflects the new state on the
   * next keystroke.
   */
  async function toggleAcceptsInput(shortcut: Shortcut, event: Event) {
    event.stopPropagation();
    const current = acceptsInputFlags[shortcut.id] === true;
    try {
      await context.request<{ uuid: string; accepts: boolean }, { ok: true }>(
        'setAcceptsInput',
        { uuid: shortcut.id, accepts: !current },
      );
    } catch (err: unknown) {
      runError = err instanceof Error ? err.message : String(err);
    }
  }

  function scrollToSelected() {
    const el = document.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }
</script>

<div class="container">
  {#if runError}
    <div class="error" role="alert">
      <strong>Error:</strong> {runError}
    </div>
  {/if}

  {#if !loaded && shortcuts.length === 0}
    <div class="empty">
      <p class="empty-text">Loading shortcuts...</p>
    </div>
  {:else if filtered.length === 0}
    <div class="empty">
      <p class="empty-title">No shortcuts found</p>
      <p class="empty-text">
        {shortcuts.length === 0 ? 'No shortcuts are available on this Mac.' : 'Try adjusting your search.'}
      </p>
    </div>
  {:else}
    <div class="list">
      {#each filtered as shortcut, i (shortcut.id ?? shortcut.name)}
        <div
          class="entry"
          class:selected={i === selectedIndex}
          data-index={i}
          onmouseenter={() => selectedIndex = i}
          onclick={() => handleRun(shortcut)}
          role="button"
          tabindex="-1"
        >
          <span class="entry-icon">
            <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
              <rect x="1" y="1" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.2"/>
              <path d="M5 8h6M8 5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="entry-title">{shortcut.name}</span>
          <button
            type="button"
            class="input-toggle"
            class:on={acceptsInputFlags[shortcut.id] === true}
            onclick={(e) => toggleAcceptsInput(shortcut, e)}
            title={acceptsInputFlags[shortcut.id] === true
              ? 'Accepts text input — Tab in root search opens the input chip'
              : 'No input — Enter in root search runs the shortcut directly'}
          >
            {acceptsInputFlags[shortcut.id] === true ? '↪ Input' : '+ Input'}
          </button>
          <span class="tag">Shortcut</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .container {
    background: var(--bg-primary);
    color: var(--text-primary);
    font-family: var(--font-ui);
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .error {
    padding: var(--space-2) var(--space-4);
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-color);
    font-size: 12px;
  }

  .list {
    flex: 1;
    overflow-y: auto;
  }

  .entry {
    display: flex;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--separator);
    gap: var(--space-3);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .entry:hover,
  .entry.selected {
    background: var(--bg-hover);
  }

  .entry-icon {
    display: flex;
    align-items: center;
    color: var(--accent-primary);
    flex-shrink: 0;
  }

  .entry-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tag {
    font-size: 11px;
    padding: 1px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .input-toggle {
    font-family: inherit;
    font-size: 11px;
    padding: 2px var(--space-2);
    border-radius: var(--radius-xs);
    background: var(--bg-tertiary);
    color: var(--text-tertiary);
    border: 1px solid var(--separator);
    cursor: pointer;
    flex-shrink: 0;
    transition: background var(--transition-fast), color var(--transition-fast);
  }

  .input-toggle:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }

  .input-toggle.on {
    background: var(--accent-primary);
    color: var(--bg-primary);
    border-color: var(--accent-primary);
  }

  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
  }

  .empty-title {
    font-size: 14px;
    font-weight: 500;
    margin: 0 0 var(--space-1) 0;
  }

  .empty-text {
    font-size: 13px;
    color: var(--text-secondary);
    margin: 0;
  }
</style>
