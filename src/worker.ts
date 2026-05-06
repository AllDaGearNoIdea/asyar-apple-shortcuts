import {
  ExtensionContext as WorkerExtensionContext,
  extensionBridge,
} from 'asyar-sdk/worker';
import type {
  Extension,
  ExtensionResult,
  ExtensionStateProxy,
  IFileSystemWatcherService,
  ILogService,
  IShellService,
  IStorageService,
  WatcherHandle,
} from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import { pullList, runShortcut, type Shortcut } from './lib/shortcutsWorker';
import { loadShortcutsCache, saveShortcutsCache } from './lib/store';

const STATE_KEY = 'shortcuts.list';

class ShortcutsWorker implements Extension {
  private logger: ILogService;
  private shell: IShellService;
  private fsWatcher: IFileSystemWatcherService;
  private storage: IStorageService;
  private state: ExtensionStateProxy;

  private shortcuts: Shortcut[] = [];
  private watcherHandle?: WatcherHandle;
  private refreshing = false;
  private refreshQueued = false;

  constructor(ctx: WorkerExtensionContext) {
    this.logger = ctx.getService<ILogService>('log');
    this.shell = ctx.getService<IShellService>('shell');
    this.fsWatcher = ctx.getService<IFileSystemWatcherService>('fsWatcher');
    this.storage = ctx.getService<IStorageService>('storage');
    this.state = ctx.getService<ExtensionStateProxy>('state');
  }

  async initialize(): Promise<void> {}

  async activate(): Promise<void> {
    try {
      const cached = await loadShortcutsCache(this.storage);
      if (cached.length > 0) {
        this.shortcuts = cached;
        await this.state.set(STATE_KEY, cached);
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
  }

  async search(query: string): Promise<ExtensionResult[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.shortcuts
      .filter((s) => s.name.toLowerCase().includes(q))
      .map((s) => ({
        score: 1,
        title: s.name,
        subtitle: 'Apple Shortcut',
        type: 'result' as const,
        icon: '🔗',
      })) as ExtensionResult[];
  }

  async executeCommand(): Promise<unknown> {
    return undefined;
  }

  onUnload = (): void => {};

  async runByName(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      await runShortcut(this.shell, name);
      this.logger.info(`Apple Shortcuts: ran "${name}"`);
      return { ok: true };
    } catch (err) {
      const message = describe(err);
      this.logger.error(`Apple Shortcuts: run "${name}" failed: ${message}`);
      return { ok: false, message };
    }
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

workerContext.onRequest<{ name: string }, { ok: true } | { ok: false; message: string }>(
  'runShortcut',
  ({ name }) => impl.runByName(name),
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
