<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { ExtensionContext } from 'asyar-sdk/view';
  import {
    ActionContext,
    type ExtensionStateProxy,
    type IExtensionManager,
  } from 'asyar-sdk/contracts';

  import type { Shortcut } from './lib/shortcutsWorker';
  import ListRow from './lib/launcherList/ListRow.svelte';
  import EmptyState from './lib/launcherList/EmptyState.svelte';

  interface Props {
    context: ExtensionContext;
    /** Resolved by the view entry point; actions register under it. */
    extensionId: string;
  }
  let { context, extensionId }: Props = $props();

  const stateProxy = context.getService<ExtensionStateProxy>('state');
  const extensions = context.getService<IExtensionManager>('extensions');

  let shortcuts = $state<Shortcut[]>([]);
  let refreshWarning = $state<string | null>(null);
  let loaded = $state(false);
  let searchQuery = $state('');
  let selectedIndex = $state(0);
  let runError = $state<string | null>(null);
  let retryingRefresh = $state(false);

  let unsubscribe: (() => Promise<void>) | null = null;
  let unsubscribeRefreshWarning: (() => Promise<void>) | null = null;

  void (async () => {
    try {
      const initial = (await stateProxy.get('shortcuts.list')) as Shortcut[] | null;
      if (initial && Array.isArray(initial)) shortcuts = initial;
    } catch {}
    try {
      const initial = await stateProxy.get('shortcuts.refreshWarning');
      refreshWarning = typeof initial === 'string' ? initial : null;
    } catch {}
    loaded = true;
    // Opening the view is the natural recovery point for a paused refresh
    // or a dead fs watch, so retry once without waiting for the button.
    // Only the initial value triggers this: retrying on subscribed updates
    // would loop when the failure is persistent.
    if (refreshWarning) void retryRefresh();
    try {
      unsubscribe = await stateProxy.subscribe('shortcuts.list', (v) => {
        shortcuts = (v as Shortcut[] | null) ?? [];
      });
    } catch {}
    try {
      unsubscribeRefreshWarning = await stateProxy.subscribe(
        'shortcuts.refreshWarning',
        (v) => {
          refreshWarning = typeof v === 'string' ? v : null;
        },
      );
    } catch {}
  })();

  const RUN_ACTION = 'run-shortcut';
  const EDIT_ACTION = 'edit-shortcut';

  /**
   * Action-panel entries for the highlighted row. Both read the selection
   * when they fire rather than closing over a shortcut, so the panel does
   * not have to be re-registered every time the highlight moves.
   */
  function registerActions() {
    context.registerAction({
      id: RUN_ACTION,
      title: 'Run Shortcut',
      description: 'Run the selected shortcut',
      icon: 'icon:layers',
      category: 'Primary',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: async () => {
        const selected = filtered[selectedIndex];
        if (selected) await handleRun(selected);
      },
    });
    context.registerAction({
      id: EDIT_ACTION,
      title: 'Edit Shortcut',
      description: 'Open the shortcut in Shortcuts.app',
      icon: 'icon:pencil',
      category: 'Primary',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: async () => {
        const selected = filtered[selectedIndex];
        if (selected) await handleEdit(selected);
      },
    });
  }

  onMount(() => {
    extensions.setActiveViewActionLabel('Run');
    registerActions();

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
      context.unregisterAction(RUN_ACTION);
      context.unregisterAction(EDIT_ACTION);
    };
  });

  onDestroy(() => {
    if (unsubscribe) void unsubscribe();
    if (unsubscribeRefreshWarning) void unsubscribeRefreshWarning();
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

  async function handleEdit(shortcut: Shortcut) {
    runError = null;
    try {
      const reply = await context.request<
        { name: string },
        { ok: true } | { ok: false; message: string }
      >('editShortcut', { name: shortcut.name });
      if (!reply.ok) {
        runError = reply.message;
      }
    } catch (err: unknown) {
      runError = err instanceof Error ? err.message : String(err);
    }
  }

  async function retryRefresh() {
    retryingRefresh = true;
    try {
      await context.request<Record<string, never>, { ok: boolean }>(
        'refreshShortcuts',
        {},
      );
    } catch (err: unknown) {
      runError = err instanceof Error ? err.message : String(err);
    } finally {
      retryingRefresh = false;
    }
  }

  function scrollToSelected() {
    const el = document.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }
</script>

<div class="container">
  {#if refreshWarning}
    <div class="warning" role="status">
      <span><strong>Refresh warning:</strong> {refreshWarning}</span>
      <button
        type="button"
        class="retry-button"
        disabled={retryingRefresh}
        onclick={retryRefresh}
      >
        {retryingRefresh ? 'Retrying…' : 'Retry'}
      </button>
    </div>
  {/if}

  {#if runError}
    <div class="error" role="alert">
      <strong>Error:</strong> {runError}
    </div>
  {/if}

  {#if !loaded && shortcuts.length === 0}
    <div class="empty-wrap">
      <EmptyState message="Loading shortcuts..." />
    </div>
  {:else if filtered.length === 0}
    <div class="empty-wrap">
      <EmptyState
        message="No shortcuts found"
        description={shortcuts.length === 0 && refreshWarning
          ? 'No cached shortcuts are available.'
          : shortcuts.length === 0
            ? 'No shortcuts are available on this Mac.'
            : 'Try adjusting your search.'}
      />
    </div>
  {:else}
    <div class="list">
      {#each filtered as shortcut, i (shortcut.id ?? shortcut.name)}
        <ListRow
          data-index={i}
          selected={i === selectedIndex}
          onmouseenter={() => selectedIndex = i}
          onclick={() => handleRun(shortcut)}
          icon={shortcut.icon}
          title={shortcut.name}
          chip={shortcut.takesInput ? '↪ Input' : undefined}
          chipTitle="Accepts text input — Tab in root search opens the input chip"
          typeLabel="Shortcut"
        >
          {#snippet iconFallback()}
            <svg viewBox="0 0 16 16" fill="none" width="16" height="16">
              <rect x="1" y="1" width="14" height="14" rx="3" stroke="currentColor" stroke-width="1.2"/>
              <path d="M5 8h6M8 5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          {/snippet}
        </ListRow>
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

  .warning {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    border-bottom: 1px solid var(--border-color);
    font-size: 12px;
  }

  .retry-button {
    font: inherit;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    border: 1px solid var(--separator);
    border-radius: var(--radius-xs);
    padding: 2px var(--space-2);
    cursor: pointer;
    flex-shrink: 0;
  }

  .retry-button:disabled {
    cursor: default;
    opacity: 0.6;
  }

  /* Matches the p-2 wrapper the launcher's ResultsList puts around its rows. */
  .list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-3);
  }

  .empty-wrap {
    flex: 1;
    display: flex;
    min-height: 0;
  }
</style>
