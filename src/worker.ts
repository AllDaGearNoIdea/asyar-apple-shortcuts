import {
  ExtensionContext as WorkerExtensionContext,
  extensionBridge,
} from 'asyar-sdk/worker';
import type {
  CommandExecuteArgs,
  DynamicCommandRegistration,
  Extension,
  ExtensionStateProxy,
  ICommandService,
  IFeedbackService,
  IFileSystemWatcherService,
  ILogService,
  IShellService,
  IStorageService,
  WatcherHandle,
} from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import { runShortcutWithFeedback } from './lib/runShortcutFlow';
import { pullList, runShortcut, type Shortcut } from './lib/shortcutsWorker';
import { loadShortcutsCache, saveShortcutsCache } from './lib/store';

const STATE_KEY = 'shortcuts.list';
const STATE_KEY_FLAGS = 'shortcuts.acceptsInputFlags';
const STORAGE_KEY_FLAGS = 'acceptsInputFlags';

type AcceptsInputFlags = Record<string, boolean>;

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
 */
class ShortcutsWorker implements Extension {
  private logger: ILogService;
  private shell: IShellService;
  private fsWatcher: IFileSystemWatcherService;
  private storage: IStorageService;
  private state: ExtensionStateProxy;
  private commands: ICommandService;
  private feedback: IFeedbackService;

  private shortcuts: Shortcut[] = [];
  /**
   * Per-shortcut flag for "this shortcut consumes Shortcut Input via
   * `--input-path`". Default: missing/false → register WITHOUT arguments
   * so Enter runs the shortcut directly with no chip-row friction.
   *
   * Apple's CLI offers no introspection for which shortcuts use Shortcut
   * Input vs internal "Ask Each Time" actions, so the user marks the
   * input-using ones explicitly via the SearchView toggle. Most
   * shortcuts don't take Shortcut Input, so default-off is the honest
   * starting state — the launcher only shows the input chip when the
   * user knows it will actually reach the shortcut.
   */
  private acceptsInput: AcceptsInputFlags = {};
  private watcherHandle?: WatcherHandle;
  private refreshing = false;
  private refreshQueued = false;

  constructor(ctx: WorkerExtensionContext) {
    this.logger = ctx.getService<ILogService>('log');
    this.shell = ctx.getService<IShellService>('shell');
    this.fsWatcher = ctx.getService<IFileSystemWatcherService>('fsWatcher');
    this.storage = ctx.getService<IStorageService>('storage');
    this.state = ctx.getService<ExtensionStateProxy>('state');
    this.commands = ctx.getService<ICommandService>('commands');
    this.feedback = ctx.getService<IFeedbackService>('feedback');
  }

  async initialize(): Promise<void> {}

  async activate(): Promise<void> {
    // Restore the per-shortcut "accepts input" flags before publishing
    // anything — they decide whether each registration carries an
    // arguments schema, so they have to be in place before the first
    // publish, not loaded asynchronously after.
    await this.loadAcceptsInputFlags();

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

    void this.refresh();

    try {
      this.watcherHandle = await this.fsWatcher.watch(['~/Library/Shortcuts/']);
      this.watcherHandle.onChange(() => {
        void this.refresh();
      });
    } catch (err) {
      this.logger.warn(`Apple Shortcuts: fs watch failed: ${describe(err)}`);
    }
  }

  async deactivate(): Promise<void> {
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

    const shortcut = this.shortcuts.find((s) => s.id === commandId);
    if (!shortcut) {
      // `shortcuts run` accepts either a UUID or a name, so an uncached
      // dynamic command can still execute through the normal feedback flow.
      this.logger.warn(
        `Apple Shortcuts: no in-memory entry for id '${commandId}' — running as name`,
      );
      return this.runShortcutAndReport(
        { id: commandId, name: commandId },
        input,
      );
    }
    return this.runShortcutAndReport(shortcut, input);
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

  private async runShortcutAndReport(
    shortcut: Shortcut,
    input?: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const result = await runShortcutWithFeedback(
      this.feedback,
      (target, shortcutInput) =>
        runShortcut(this.shell, target, shortcutInput),
      shortcut,
      input,
    );

    if (result.ok) {
      this.logger.info(
        `Apple Shortcuts: ran "${shortcut.name}"${input ? ' with input' : ''}`,
      );
    } else {
      this.logger.error(
        `Apple Shortcuts: run "${shortcut.name}" failed: ${result.message}`,
      );
    }

    return result;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    try {
      const fresh = await pullList(this.shell);
      this.shortcuts = fresh;
      await this.state.set(STATE_KEY, fresh);
      await this.publishDynamicCommands(fresh);
      try {
        await saveShortcutsCache(this.storage, fresh);
      } catch (err) {
        this.logger.warn(`Apple Shortcuts: cache save failed: ${describe(err)}`);
      }
      this.logger.info(`Apple Shortcuts: indexed ${fresh.length} shortcuts`);
    } catch (err) {
      this.logger.error(`Apple Shortcuts: list failed: ${describe(err)}`);
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
  }

  /**
   * Publish the current list as dynamic commands. The launcher diffs
   * against its registry internally and removes stale entries — we do
   * not need to track previous state on this side.
   *
   * Each shortcut declares the inline `input` text argument *only* when
   * the user has marked it via the SearchView toggle as one that uses
   * Shortcut Input (`--input-path`). Default-off acknowledges that most
   * shortcuts don't consume Shortcut Input — they either take no input
   * or use internal "Ask Each Time" actions, both of which ignore our
   * piped input. Showing a chip in those cases would mislead the user.
   */
  private async publishDynamicCommands(list: Shortcut[]): Promise<void> {
    const regs: DynamicCommandRegistration[] = list.map((s) => {
      const accepts = this.acceptsInput[s.id] === true;
      const reg: DynamicCommandRegistration = {
        id: s.id,
        name: s.name,
        description: 'Apple Shortcut',
        icon: '🔗',
      };
      if (accepts) {
        reg.arguments = [
          {
            name: 'input',
            type: 'text' as const,
            placeholder: 'Input passed via stdin',
          },
        ];
      }
      return reg;
    });
    try {
      await this.commands.replaceDynamicCommands(regs);
    } catch (err) {
      this.logger.error(
        `Apple Shortcuts: replaceDynamicCommands failed: ${describe(err)}`,
      );
    }
  }

  /**
   * Toggle the "accepts input" flag for a single shortcut. Persists the
   * full map to extension storage and re-publishes the dynamic command
   * list so the launcher's argument-mode immediately reflects the new
   * state — flipping the toggle in the SearchView updates root-search
   * behavior on the next keystroke.
   */
  async setAcceptsInput(uuid: string, accepts: boolean): Promise<void> {
    const next: AcceptsInputFlags = { ...this.acceptsInput };
    if (accepts) {
      next[uuid] = true;
    } else {
      delete next[uuid];
    }
    this.acceptsInput = next;
    try {
      await this.storage.set(STORAGE_KEY_FLAGS, JSON.stringify(next));
    } catch (err) {
      this.logger.warn(
        `Apple Shortcuts: persisting acceptsInput flags failed: ${describe(err)}`,
      );
    }
    await this.state.set(STATE_KEY_FLAGS, next);
    await this.publishDynamicCommands(this.shortcuts);
  }

  private async loadAcceptsInputFlags(): Promise<void> {
    try {
      const raw = await this.storage.get(STORAGE_KEY_FLAGS);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
          // Defensive: only keep boolean true entries; reject anything else.
          const cleaned: AcceptsInputFlags = {};
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (v === true) cleaned[k] = true;
          }
          this.acceptsInput = cleaned;
        }
      }
    } catch (err) {
      this.logger.warn(
        `Apple Shortcuts: acceptsInput flags load failed: ${describe(err)}`,
      );
      this.acceptsInput = {};
    }
    await this.state.set(STATE_KEY_FLAGS, this.acceptsInput);
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

// SearchView toggles "this shortcut accepts input via stdin" per row.
// Worker persists the flag and re-publishes so the launcher's
// argument-mode reflects the new state immediately.
workerContext.onRequest<
  { uuid: string; accepts: boolean },
  { ok: true }
>('setAcceptsInput', async ({ uuid, accepts }) => {
  await impl.setAcceptsInput(uuid, accepts);
  return { ok: true };
});

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
