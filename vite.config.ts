import { defineExtensionConfig } from 'asyar-sdk/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

export default defineExtensionConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  config: { plugins: [svelte()] },
});
