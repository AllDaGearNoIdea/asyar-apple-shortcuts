import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { existsSync } from 'fs';
import { fileURLToPath, URL } from 'url';
import { resolve } from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const sdkSrcDir = resolve(__dirname, '../asyar/asyar-sdk/src');
const sdkSubpaths = ['contracts', 'worker', 'view'] as const;
const useLocalSdk = sdkSubpaths.every((sub) =>
  existsSync(resolve(sdkSrcDir, `${sub}.ts`)),
);

const sdkAliases = useLocalSdk
  ? Object.fromEntries(
      sdkSubpaths.map((sub) => [
        `asyar-sdk/${sub}`,
        resolve(sdkSrcDir, `${sub}.ts`),
      ]),
    )
  : {};

const inputs: Record<string, string> = {};
if (existsSync(resolve(__dirname, 'view.html'))) {
  inputs.view = resolve(__dirname, 'view.html');
}
if (existsSync(resolve(__dirname, 'worker.html'))) {
  inputs.worker = resolve(__dirname, 'worker.html');
}

export default defineConfig(() => {
  console.log(
    `\x1b[36m[Vite] (Apple Shortcuts)\x1b[0m Asyar-SDK: \x1b[33m${
      useLocalSdk ? `Local Source (${sdkSrcDir})` : 'node_modules (NPM)'
    }\x1b[0m`,
  );

  return {
    plugins: [svelte()],
    base: './',
    resolve: {
      alias: sdkAliases,
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      assetsDir: 'assets',
      rollupOptions: {
        input: inputs,
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
