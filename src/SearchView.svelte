<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { listView, type ExtensionContext } from 'asyar-sdk/view';
  import {
    ActionContext,
    type ExtensionStateProxy,
    type IExtensionManager,
    type IFeedbackService,
  } from 'asyar-sdk/contracts';

  import manifest from '../manifest.json';
  import {
    EDIT_SHORTCUT_ACTION,
    RUN_SHORTCUT_ACTION,
    shortcutListItem,
  } from './lib/shortcutList';
  import {
    refreshFailureMessage,
    shortcutRunRequest,
    type RefreshShortcutsReply,
    type ShortcutRpcReply,
  } from './lib/shortcutsRpc';
  import type { Shortcut } from './lib/shortcutsWorker';

  interface Props {
    context: ExtensionContext;
    /** Resolved by the view entry point; actions register under it. */
    extensionId: string;
  }

  let { context, extensionId }: Props = $props();

  // The entry point mounts this controller once with an immutable context.
  // svelte-ignore state_referenced_locally
  const stateProxy = context.getService<ExtensionStateProxy>('state');
  // svelte-ignore state_referenced_locally
  const extensions = context.getService<IExtensionManager>('extensions');
  // svelte-ignore state_referenced_locally
  const feedback = context.getService<IFeedbackService>('feedback');

  const RETRY_REFRESH_ACTION = 'retry-shortcut-refresh';

  let shortcuts: Shortcut[] = [];
  let shortcutsById = new Map<string, Shortcut>();
  let refreshWarning: string | null = null;
  let lastReportedWarning: string | null = null;
  let loaded = false;
  let retryingRefresh = false;
  let retryRefreshInFlight: Promise<void> | null = null;
  let surfaceInFlightRefreshFailure = false;
  let destroyed = false;
  let listSyncTail = Promise.resolve();
  // A push delivered while a post-subscription get is in flight always wins.
  // The per-key counters keep the two independent streams from suppressing
  // one another's reconciliation.
  let shortcutsStateRevision = 0;
  let refreshWarningStateRevision = 0;

  let unsubscribeList: (() => Promise<void>) | null = null;
  let unsubscribeRefreshWarning: (() => Promise<void>) | null = null;

  function replaceShortcuts(next: Shortcut[], sync = true): void {
    if (destroyed) return;
    shortcuts = next;
    const byId = new Map<string, Shortcut>();
    for (const shortcut of next) {
      // The host keeps the first row for a duplicate id; mirror that here so
      // an activation can never resolve to a different later record.
      if (!byId.has(shortcut.id)) byId.set(shortcut.id, shortcut);
    }
    shortcutsById = byId;
    if (sync) queueListSync();
  }

  function replaceRefreshWarning(next: string | null, sync = true): void {
    if (destroyed) return;
    refreshWarning = next;
    if (sync) queueListSync();

    if (!next) {
      lastReportedWarning = null;
      return;
    }
    if (next === lastReportedWarning) return;
    lastReportedWarning = next;
    void feedback
      .report({
        kind: 'shortcuts/refresh-warning',
        severity: 'warning',
        retryable: false,
        context: { message: next },
      })
      .catch(() => {});
  }

  function queueListSync(): void {
    if (destroyed) return;
    listSyncTail = listSyncTail.then(syncList).catch((err: unknown) => {
      reportError('shortcuts/list-sync-failed', err);
    });
  }

  async function syncList(): Promise<void> {
    if (destroyed) return;
    // Keep a usable cached list visible while a refresh retries. The host
    // loading state replaces every row, so reserve it for the no-data case.
    const loading = (!loaded || retryingRefresh) && shortcuts.length === 0;
    const emptyMessage = !loaded
      ? 'Loading shortcuts...'
      : refreshWarning
        ? `No cached shortcuts are available. ${refreshWarning}`
        : 'No shortcuts are available on this Mac.';

    if (loading) await listView.setLoading(true);
    await listView.setEmptyMessage(emptyMessage);
    await listView.setItems(
      shortcuts.map((shortcut) => shortcutListItem(shortcut, manifest.icon)),
    );
    await listView.setLoading(loading);
  }

  function findShortcut(itemId: string): Shortcut | null {
    return shortcutsById.get(itemId) ?? null;
  }

  async function runShortcut(shortcut: Shortcut, input?: string): Promise<void> {
    try {
      const reply = await context.request<ShortcutRpcReply>(
        'runShortcut',
        shortcutRunRequest(shortcut, input),
      );
      if (!reply.ok) reportError('shortcuts/run-failed', reply.message);
    } catch (err: unknown) {
      reportError('shortcuts/run-failed', err);
    }
  }

  async function editShortcut(shortcut: Shortcut): Promise<void> {
    try {
      const reply = await context.request<ShortcutRpcReply>('editShortcut', {
        name: shortcut.name,
      });
      if (!reply.ok) reportError('shortcuts/edit-failed', reply.message);
    } catch (err: unknown) {
      reportError('shortcuts/edit-failed', err);
    }
  }

  function retryRefresh(surfaceFailure: boolean): Promise<void> {
    // A manual action arriving during the automatic open-time retry shares the
    // request but upgrades its failure to user-visible feedback.
    if (surfaceFailure) surfaceInFlightRefreshFailure = true;
    if (retryRefreshInFlight) return retryRefreshInFlight;

    surfaceInFlightRefreshFailure = surfaceFailure;
    retryingRefresh = true;
    queueListSync();

    // Starting from a microtask guarantees the shared promise is installed
    // before success, failure, or even a synchronous transport exception can
    // run its cleanup.
    const pending = Promise.resolve().then(async () => {
      try {
        let reply: RefreshShortcutsReply;
        try {
          reply = await context.request<RefreshShortcutsReply>(
            'refreshShortcuts',
            {},
          );
        } catch (err: unknown) {
          if (!surfaceInFlightRefreshFailure) return;
          const failure = err instanceof Error ? err : new Error(String(err));
          reportError('shortcuts/refresh-failed', failure);
          throw failure;
        }

        // A queued retry is accepted work, not a failed refresh. A definite
        // failure is surfaced only for the user's explicit action: opening the
        // view already reports the persisted warning and must not add a second
        // error for its automatic recovery attempt.
        const failureMessage = refreshFailureMessage(reply);
        if (failureMessage && surfaceInFlightRefreshFailure) {
          const failure = new Error(failureMessage);
          reportError('shortcuts/refresh-failed', failure);
          throw failure;
        }
      } finally {
        retryRefreshInFlight = null;
        surfaceInFlightRefreshFailure = false;
        retryingRefresh = false;
        queueListSync();
      }
    });
    retryRefreshInFlight = pending;
    return pending;
  }

  function reportError(kind: string, error: unknown): void {
    if (destroyed) return;
    const message = error instanceof Error ? error.message : String(error);
    void feedback
      .report({
        kind,
        severity: 'error',
        retryable: false,
        context: { message },
      })
      .catch(() => {});
  }

  function registerControllerActions(): void {
    context.registerAction({
      id: RETRY_REFRESH_ACTION,
      title: 'Retry Shortcut Refresh',
      description: 'Reload shortcuts and restart change monitoring',
      icon: 'icon:refresh',
      category: 'System',
      extensionId,
      context: ActionContext.EXTENSION_VIEW,
      execute: () => retryRefresh(true),
    });
  }

  async function initialiseState(): Promise<void> {
    // Subscribe before reading. ExtensionStateProxy subscriptions only deliver
    // future pushes; the post-subscription gets close the registration window.
    try {
      const unsubscribe = await stateProxy.subscribe('shortcuts.list', (value) => {
        shortcutsStateRevision += 1;
        replaceShortcuts(Array.isArray(value) ? (value as Shortcut[]) : []);
      });
      if (destroyed) void unsubscribe();
      else unsubscribeList = unsubscribe;
    } catch {}
    if (destroyed) return;
    try {
      const unsubscribe = await stateProxy.subscribe(
        'shortcuts.refreshWarning',
        (value) => {
          refreshWarningStateRevision += 1;
          replaceRefreshWarning(typeof value === 'string' ? value : null);
        },
      );
      if (destroyed) void unsubscribe();
      else unsubscribeRefreshWarning = unsubscribe;
    } catch {}
    if (destroyed) return;

    const listReadRevision = shortcutsStateRevision;
    try {
      const initial = (await stateProxy.get('shortcuts.list')) as Shortcut[] | null;
      if (
        !destroyed &&
        shortcutsStateRevision === listReadRevision &&
        Array.isArray(initial)
      ) {
        replaceShortcuts(initial, false);
      }
    } catch {}
    if (destroyed) return;

    const warningReadRevision = refreshWarningStateRevision;
    try {
      const initial = await stateProxy.get('shortcuts.refreshWarning');
      if (!destroyed && refreshWarningStateRevision === warningReadRevision) {
        replaceRefreshWarning(typeof initial === 'string' ? initial : null, false);
      }
    } catch {}
    if (destroyed) return;

    loaded = true;
    queueListSync();

    // Opening the view is the natural recovery point for a paused refresh
    // or a dead fs watch. Only the initial value triggers this so a persistent
    // failure cannot create a subscription-driven retry loop.
    if (refreshWarning) void retryRefresh(false);
  }

  onMount(() => {
    // Install every host-list listener this controller uses before the first
    // setItems call, so no host push can race the initial item snapshot.
    const unsubscribeActivate = listView.onItemActivate((itemId) => {
      const shortcut = findShortcut(itemId);
      if (shortcut) void runShortcut(shortcut);
    });
    const unsubscribeSubmit = listView.onItemSubmit(({ itemId, arguments: args }) => {
      const shortcut = findShortcut(itemId);
      if (!shortcut) return;
      const input = typeof args.input === 'string' ? args.input : '';
      void runShortcut(shortcut, input);
    });
    const unsubscribeItemAction = listView.onItemAction(({ itemId, actionId }) => {
      const shortcut = findShortcut(itemId);
      if (!shortcut) return;
      if (actionId === RUN_SHORTCUT_ACTION) void runShortcut(shortcut);
      else if (actionId === EDIT_SHORTCUT_ACTION) void editShortcut(shortcut);
    });

    extensions.setActiveViewActionLabel('Run');
    registerControllerActions();
    void listView.setLoading(true).catch((err: unknown) => {
      reportError('shortcuts/list-sync-failed', err);
    });
    void initialiseState();

    return () => {
      unsubscribeActivate();
      unsubscribeSubmit();
      unsubscribeItemAction();
      extensions.setActiveViewActionLabel(null);
      context.unregisterAction(RETRY_REFRESH_ACTION);
    };
  });

  onDestroy(() => {
    destroyed = true;
    if (unsubscribeList) void unsubscribeList();
    if (unsubscribeRefreshWarning) void unsubscribeRefreshWarning();
  });
</script>
