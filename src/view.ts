import 'asyar-sdk/tokens.css';
import { mount } from 'svelte';
import {
  ExtensionContext,
  extensionBridge,
  registerIconElement,
} from 'asyar-sdk/view';
import type {
  Extension,
  ExtensionStateProxy,
  IFeedbackService,
  IExtensionManager,
  ISearchService,
} from 'asyar-sdk/contracts';

import manifest from '../manifest.json';
import SearchView from './SearchView.svelte';

class ShortcutsView implements Extension {
  constructor(private readonly extensionManager: IExtensionManager) {}

  async initialize(): Promise<void> {}

  async activate(): Promise<void> {}
  async deactivate(): Promise<void> {}

  async executeCommand(commandId: string): Promise<unknown> {
    if (commandId === 'open') {
      this.extensionManager.navigateToView('com.asyar.shortcuts/SearchView');
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

const stateProxy = context.getService<ExtensionStateProxy>('state');
const extensions = context.getService<IExtensionManager>('extensions');
const feedback = context.getService<IFeedbackService>('feedback');
const search = context.getService<ISearchService>('search');

const impl = new ShortcutsView(extensions);
extensionBridge.registerManifest(manifest as never);
extensionBridge.registerExtensionImplementation(extensionId, impl);

const app = mount(SearchView, {
  target: document.getElementById('app')!,
  props: { context, stateProxy, extensions, feedback, search },
});

export default app;
