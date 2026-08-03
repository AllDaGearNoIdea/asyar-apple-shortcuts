import {
  ExtensionContext as WorkerExtensionContext,
  extensionBridge,
} from 'asyar-sdk/worker';
import type {
  CommandExecuteArgs,
  DynamicCommandRegistration,
  Extension,
  ExtensionStateProxy,
  IApplicationService,
  ICommandService,
  IFeedbackService,
  IFileSystemWatcherService,
  ILogService,
  IShellService,
  IStorageService,
  WatcherHandle,
} from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import {
  openShortcutInEditor,
  runShortcut,
  ShortcutHandoffError,
  type Shortcut,
} from './lib/shortcutsWorker';
import { pullShortcutList } from './lib/shortcutsDb';
import { ShortcutIconResolver } from './lib/shortcutIcons';
import { loadShortcutsCache, saveShortcutsCache } from './lib/store';

const STATE_KEY = 'shortcuts.list';
const REFRESH_WARNING_STATE_KEY = 'shortcuts.refreshWarning';
const BASIC_LIST_WARNING =
  'Shortcut details could not be read. Showing the basic list without icons or input support.';
const STALE_LIST_WARNING =
  'Shortcuts could not be refreshed. Showing the last known list.';
const EMPTY_LIST_WARNING = 'Shortcuts could not be loaded.';
const WATCH_FAILED_WARNING =
  'Shortcut changes are not being detected automatically. The list refreshes when this view opens.';
const BASIC_WATCH_FAILED_WARNING =
  'Shortcut details could not be read, and changes are not being detected automatically. Showing the basic list.';
const BASIC_LIST_DESCRIPTION = 'Basic list — details unavailable';
const STALE_LIST_DESCRIPTION = 'May be out of date — refresh failed';
const WATCH_FAILED_DESCRIPTION = 'Not auto-updating';
const BASIC_WATCH_FAILED_DESCRIPTION = 'Basic list — not auto-updating';
const WATCH_REFRESH_DELAY_MS = 500;
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
/** Stands in when a shortcut has no icon of its own (the CLI fallback list). */
const APP_ICON = manifest.icon;

/**
 * Worker entry for the Apple Shortcuts extension.
 *
 * Each user-installed shortcut is published to the launcher as a runtime
 * dynamic command via `commandsService.replaceDynamicCommands(...)`. The
 * launcher then surfaces every shortcut in root search; pressing Tab on
 * one promotes into argument-entry mode, where the user can type optional
 * input that is piped to `/usr/bin/shortcuts run … --input-path -`.
 *
 * The dedicated SearchView (manifest command id `open`) is kept as an
 * alternative entry point — some users prefer browsing the full list in
 * one place, especially when they don't remember the exact name.
 *
 * Refresh sources:
 *   - on activate (after restoring from cache)
 *   - on every fs-watch event for `~/Library/Shortcuts/`
 *   - after a failure: one self-scheduled retry per failure episode, then
 *     fs-event retries spaced by the cooldown, then user-driven retries
 *     (the SearchView retries once on open while a warning is showing,
 *     and has a Retry button)
 *
 * Every refresh also re-attempts the fs watch when it is down, so the
 * user-driven paths heal a dead watcher too.
 */
class ShortcutsWorker implements Extension {
  private logger: ILogService;
  private shell: IShellService;
  private fsWatcher: IFileSystemWatcherService;
  private storage: IStorageService;
  private state: ExtensionStateProxy;
  private commands: ICommandService;
  private feedback: IFeedbackService;

  private icons: ShortcutIconResolver;

  private shortcuts: Shortcut[] = [];
  private watcherHandle?: WatcherHandle;
  private watchRefreshTimer?: number;
  private refreshing = false;
  private refreshQueued = false;
  /** True from the first refresh failure until the next success. */
  private refreshFailed = false;
  /** Watcher-driven refreshes are deferred until this time after a failure. */
  private refreshPausedUntil = 0;
  private dynamicCommandWarning?: string;

  constructor(ctx: WorkerExtensionContext) {
    this.logger = ctx.getService<ILogService>('log');
    this.shell = ctx.getService<IShellService>('shell');
    this.fsWatcher = ctx.getService<IFileSystemWatcherService>('fsWatcher');
    this.storage = ctx.getService<IStorageService>('storage');
    this.state = ctx.getService<ExtensionStateProxy>('state');
    this.commands = ctx.getService<ICommandService>('commands');
    this.feedback = ctx.getService<IFeedbackService>('feedback');
    this.icons = new ShortcutIconResolver({
      shell: this.shell,
      storage: this.storage,
      application: ctx.getService<IApplicationService>('application'),
      logger: this.logger,
    });
  }

  async initialize(): Promise<void> {}

  async activate(): Promise<void> {
    // Drop the retired per-shortcut "accepts input" overrides; the
    // database flag is the only source now.
    void this.storage.delete('acceptsInputFlags').catch(() => {});

    // Hydrate from cached list first so root search has results before
    // the (slow-ish) `shortcuts list` subprocess returns.
    try {
      const cached = await loadShortcutsCache(this.storage);
      if (cached.length > 0) {
        this.shortcuts = cached;
        await this.state.set(STATE_KEY, cached);
        await this.publishDynamicCommands(cached);
      }
    } catch (err) {
      this.logger.warn(`Apple Shortcuts: cache load failed: ${describe(err)}`);
    }

    // refresh() establishes the fs watch before its first read, so no
    // change can slip between the initial list and the watcher coming up.
    void this.refresh();
  }

  async deactivate(): Promise<void> {
    if (this.watchRefreshTimer !== undefined) {
      window.clearTimeout(this.watchRefreshTimer);
      this.watchRefreshTimer = undefined;
    }
    try {
      await this.watcherHandle?.dispose();
    } catch {}
    this.watcherHandle = undefined;
    // The launcher's lifecycle hook also clears dynamic registrations on
    // disable, but doing it here gives the launcher a clean handoff and
    // matches the "every register has a corresponding unregister" pattern.
    try {
      await this.commands.replaceDynamicCommands([]);
    } catch (err) {
      this.logger.warn(
        `Apple Shortcuts: clearing dynamic commands on deactivate failed: ${describe(err)}`,
      );
    }
  }

  /**
   * Tier 2 dispatch entry point. The launcher routes each shortcut's
   * dynamic-command id (a UUID) here; we look it up in the in-memory
   * list and run it with the user's optional input.
   */
  async executeCommand(
    commandId: string,
    args?: CommandExecuteArgs,
  ): Promise<unknown> {
    const userArgs = (args?.arguments ?? {}) as Record<string, unknown>;
    const input =
      typeof userArgs.input === 'string' ? userArgs.input : undefined;

    const known = this.shortcuts.find((s) => s.id === commandId);
    if (!known) {
      // The list hasn't loaded, or the launcher still holds a registration
      // we no longer publish. `shortcuts run` takes a UUID or a name, so the
      // id runs either way, but there is no display name to go with it.
      this.logger.warn(
        `Apple Shortcuts: no in-memory entry for id '${commandId}'; running it as given`,
      );
    }

    return this.runShortcutAndReport(known ?? { id: commandId }, input);
  }

  onUnload = (): void => {};

  /**
   * Run a shortcut by name + optional input. Used by the SearchView via
   * the `runShortcut` RPC; the dynamic-command path goes through
   * `executeCommand` above.
   */
  async runByName(
    name: string,
    input?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.runShortcutAndReport({ id: name, name }, input);
  }

  /**
   * Hand a shortcut to Shortcuts.app for editing. Unlike running, this has
   * no silent-failure mode worth a notification: the app comes to the front
   * on success, and its absence is the error message the view shows.
   */
  async editByName(
    name: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await openShortcutInEditor(this.shell, name);
      this.logger.info(`Apple Shortcuts: opened "${name}" for editing`);
      return { ok: true };
    } catch (err) {
      const message = describe(err);
      this.logger.error(`Apple Shortcuts: edit "${name}" failed: ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * Both entry points land here. Only a failed hand-off is ours to report:
   * nothing ran, the launcher has usually hidden by then, and the
   * SearchView's inline error will not be read. Once `shortcuts` has the
   * job, its own failures are its own to announce, and duplicating them
   * would put two notifications on screen for one error.
   *
   * `name` is absent when the launcher dispatched an id we cannot resolve;
   * the notification then carries the error alone rather than a raw UUID.
   */
  private async runShortcutAndReport(
    target: { id: string; name?: string },
    input?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const label = target.name ?? target.id;
    try {
      await runShortcut(this.shell, target.id, input);
      this.logger.info(
        `Apple Shortcuts: ran "${label}"${input ? ' with input' : ''}`,
      );
      return { ok: true };
    } catch (err) {
      const message = describe(err);
      this.logger.error(`Apple Shortcuts: run "${label}" failed: ${message}`);
      if (err instanceof ShortcutHandoffError) {
        await this.notifyRunFailure(target.name, message);
      }
      return { ok: false, message };
    }
  }

  /**
   * `sendBackground` is the notification path for work with no Asyar window
   * attached. Gated by `notifications:send`.
   */
  private async notifyRunFailure(
    name: string | undefined,
    message: string,
  ): Promise<void> {
    try {
      await this.feedback.sendBackground({
        title: 'Shortcut failed',
        body: name ? `${name}: ${message}` : message,
      });
    } catch (err) {
      this.logger.warn(
        `Apple Shortcuts: failure notification failed: ${describe(err)}`,
      );
    }
  }

  /**
   * With no shortcuts left to publish, the extension contributes nothing to
   * root search, so the feedback bar is the only place the user will see the
   * failure. `error` severity has no TTL (`info`/`success` expire after 3s,
   * `warning` after 8s) and this is usually raised at startup with the
   * launcher hidden, so anything expiring would be missed.
   */
  private async reportRefreshFailure(
    message: string,
    detail: string,
  ): Promise<void> {
    try {
      await this.feedback.report({
        kind: 'manual',
        severity: 'error',
        retryable: false,
        context: { message },
        developerDetail: detail,
      });
    } catch (err) {
      this.logger.warn(
        `Apple Shortcuts: refresh failure report failed: ${describe(err)}`,
      );
    }
  }

  /**
   * User-driven retry: the SearchView calls this once on open while a
   * warning is showing, and from its Retry button. Goes through refresh()
   * so it also re-attempts a dead fs watch.
   */
  async retryRefresh(): Promise<boolean> {
    return this.refresh();
  }

  /**
   * Debounced refresh, used for fs-watch events and the post-failure
   * retry. After a failure the delay stretches to the cooldown, so a
   * burst of filesystem events cannot turn one persistent problem into a
   * retry loop; events landing during the cooldown coalesce into a single
   * attempt when it expires.
   */
  private scheduleRefresh(): void {
    const delay = Math.max(
      WATCH_REFRESH_DELAY_MS,
      this.refreshPausedUntil - Date.now(),
    );
    if (this.watchRefreshTimer !== undefined) {
      window.clearTimeout(this.watchRefreshTimer);
    }
    this.watchRefreshTimer = window.setTimeout(() => {
      this.watchRefreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  /**
   * (Re)establish the fs watch. A miss leaves the list unable to
   * auto-update, which refresh() surfaces on the rows; retrying here on
   * every refresh means any later refresh can heal the watch as well.
   */
  private async ensureWatcher(): Promise<void> {
    if (this.watcherHandle) return;
    try {
      this.watcherHandle = await this.fsWatcher.watch(['~/Library/Shortcuts/']);
      this.watcherHandle.onChange(() => {
        this.scheduleRefresh();
      });
    } catch (err) {
      this.logger.warn(`Apple Shortcuts: fs watch failed: ${describe(err)}`);
    }
  }

  private async refresh(): Promise<boolean> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return false;
    }
    this.refreshing = true;
    try {
      await this.ensureWatcher();
      // The database is the richer source (icon colour/glyph, subtitle,
      // input flag). The same tracked shell transaction falls back to
      // `shortcuts list`, so it fails only if neither source can refresh.
      const result = await pullShortcutList(this.shell);
      const fresh = result.shortcuts;
      if (result.source === 'database') {
        await this.icons.apply(fresh);
      } else {
        this.logger.warn(
          'Apple Shortcuts: database read failed; using the basic shortcuts list',
        );
      }
      const { warning, rowWarning } = this.describeDegradation(result.source);
      this.refreshFailed = false;
      this.refreshPausedUntil = 0;
      this.shortcuts = fresh;
      await this.state.set(STATE_KEY, fresh);
      await this.setRefreshWarning(warning);
      await this.publishDynamicCommands(fresh, rowWarning);
      try {
        await saveShortcutsCache(this.storage, fresh);
      } catch (err) {
        this.logger.warn(`Apple Shortcuts: cache save failed: ${describe(err)}`);
      }
      this.logger.info(`Apple Shortcuts: indexed ${fresh.length} shortcuts`);
      return true;
    } catch (err) {
      const detail = describe(err);
      this.logger.error(`Apple Shortcuts: list failed: ${detail}`);
      const firstFailure = !this.refreshFailed;
      this.refreshFailed = true;
      this.refreshPausedUntil = Date.now() + FAILURE_COOLDOWN_MS;
      if (firstFailure) {
        // One self-scheduled retry per episode heals a transient failure
        // without the user noticing. If it fails too, further attempts
        // wait for an fs event past the cooldown or for the user.
        this.scheduleRefresh();
      }
      const warning = this.shortcuts.length > 0 ? STALE_LIST_WARNING : EMPTY_LIST_WARNING;
      await this.setRefreshWarning(warning);
      if (this.shortcuts.length > 0) {
        // Rows survive, so they carry the warning themselves.
        if (this.dynamicCommandWarning !== STALE_LIST_DESCRIPTION) {
          await this.publishDynamicCommands(this.shortcuts, STALE_LIST_DESCRIPTION);
        }
      } else if (firstFailure) {
        await this.reportRefreshFailure(EMPTY_LIST_WARNING, detail);
      }
      return false;
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        // A request queued behind a failing refresh is dropped; the
        // cooldown decides when the next attempt runs.
        if (!this.refreshFailed) void this.refresh();
      }
    }
  }

  /**
   * Warnings for a refresh that succeeded but in a degraded state: the
   * CLI fallback (no icons or input flags) and/or no fs watch (the list
   * cannot update on its own). `warning` feeds the SearchView banner,
   * `rowWarning` the dynamic-command subtitles.
   */
  private describeDegradation(source: 'database' | 'cli'): {
    warning: string | null;
    rowWarning?: string;
  } {
    const watcherDown = !this.watcherHandle;
    if (source === 'cli' && watcherDown) {
      return {
        warning: BASIC_WATCH_FAILED_WARNING,
        rowWarning: BASIC_WATCH_FAILED_DESCRIPTION,
      };
    }
    if (source === 'cli') {
      return { warning: BASIC_LIST_WARNING, rowWarning: BASIC_LIST_DESCRIPTION };
    }
    if (watcherDown) {
      return { warning: WATCH_FAILED_WARNING, rowWarning: WATCH_FAILED_DESCRIPTION };
    }
    return { warning: null };
  }

  /**
   * Publish the current list as dynamic commands. The launcher diffs
   * against its registry internally and removes stale entries — we do
   * not need to track previous state on this side.
   *
   * Each shortcut declares the inline `input` text argument only when the
   * database flag says it consumes Shortcut Input. Shortcuts without
   * input ignore piped stdin, so a chip for them would mislead.
   */
  private async publishDynamicCommands(
    list: Shortcut[],
    warning?: string,
  ): Promise<void> {
    const regs: DynamicCommandRegistration[] = list.map((s) => {
      const accepts = s.takesInput === true;
      const reg: DynamicCommandRegistration = {
        id: s.id,
        name: s.name,
        description: warning,
        typeLabel: 'Apple Shortcut',
        icon: s.icon ?? APP_ICON,
      };
      if (accepts) {
        reg.arguments = [
          {
            name: 'input',
            type: 'text' as const,
            placeholder: 'Input...',
          },
        ];
      }
      return reg;
    });
    try {
      await this.commands.replaceDynamicCommands(regs);
      this.dynamicCommandWarning = warning;
    } catch (err) {
      this.logger.error(
        `Apple Shortcuts: replaceDynamicCommands failed: ${describe(err)}`,
      );
    }
  }

  private async setRefreshWarning(message: string | null): Promise<void> {
    try {
      await this.state.set(REFRESH_WARNING_STATE_KEY, message);
    } catch (err) {
      this.logger.warn(
        `Apple Shortcuts: refresh warning update failed: ${describe(err)}`,
      );
    }
  }

}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

const extensionId =
  window.location.hostname === 'localhost' ||
  window.location.hostname === 'asyar-extension.localhost'
    ? window.location.pathname.split('/').filter(Boolean)[0] || 'com.asyar.shortcuts'
    : window.location.hostname || 'com.asyar.shortcuts';

const workerContext = new WorkerExtensionContext();
workerContext.setExtensionId(extensionId);
const log = workerContext.getService<ILogService>('log');
log.info(`Apple Shortcuts: worker booted (id=${extensionId})`);

const impl = new ShortcutsWorker(workerContext);
extensionBridge.registerManifest(manifest as never);
extensionBridge.registerExtensionImplementation(extensionId, impl as never);

// Kept for the SearchView fallback: the view sends `runShortcut` with a
// shortcut name (and optional input) to ask the worker to invoke it.
workerContext.onRequest<
  { name: string; input?: string },
  { ok: true } | { ok: false; message: string }
>('runShortcut', ({ name, input }) => impl.runByName(name, input));

workerContext.onRequest<
  { name: string },
  { ok: true } | { ok: false; message: string }
>('editShortcut', ({ name }) => impl.editByName(name));

workerContext.onRequest<Record<string, never>, { ok: boolean }>(
  'refreshShortcuts',
  async () => ({ ok: await impl.retryRefresh() }),
);

void (async () => {
  try {
    log.info('Apple Shortcuts: activating worker');
    await impl.activate();
    log.info('Apple Shortcuts: worker activated');
  } catch (err) {
    log.error(`Apple Shortcuts: worker activate failed: ${describe(err)}`);
  }
})();

window.addEventListener('beforeunload', () => {
  void impl.deactivate().catch((err) => {
    log.warn(`Apple Shortcuts: deactivate failed: ${describe(err)}`);
  });
});
