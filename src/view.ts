import 'asyar-sdk/tokens.css';
import { mount } from 'svelte';
import {
  ExtensionContext,
  extensionBridge,
  registerIconElement,
} from 'asyar-sdk/view';
import type {
  Extension,
  IExtensionManager,
} from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import SearchView from './SearchView.svelte';

class ShortcutsView implements Extension {
  private extensionManager?: IExtensionManager;

  async initialize(ctx: ExtensionContext): Promise<void> {
    this.extensionManager = ctx.getService<IExtensionManager>('extensions');
  }

  async activate(): Promise<void> {}
  async deactivate(): Promise<void> {}

  async executeCommand(commandId: string): Promise<unknown> {
    if (commandId === 'open') {
      this.extensionManager?.navigateToView('com.asyar.shortcuts/SearchView');
      return { type: 'view', viewPath: 'com.asyar.shortcuts/SearchView' };
    }
    return undefined;
  }

  onUnload = (): void => {};
}

const extensionId =
  window.location.hostname === 'localhost' ||
  window.location.hostname === 'asyar-extension.localhost'
    ? window.location.pathname.split('/').filter(Boolean)[0] || 'com.asyar.shortcuts'
    : window.location.hostname || 'com.asyar.shortcuts';

const context = new ExtensionContext();
context.setExtensionId(extensionId);
registerIconElement();

const impl = new ShortcutsView();
extensionBridge.registerManifest(manifest as never);
extensionBridge.registerExtensionImplementation(extensionId, impl);

const app = mount(SearchView, {
  target: document.getElementById('app')!,
  props: { context },
});

export default app;
