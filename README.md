# Apple Shortcuts for Asyar

Search and run Apple Shortcuts from [Asyar](https://github.com/Xoshbin/asyar),
with optional text input passed to the shortcut.

macOS only.

## Commands

- **Apple Shortcuts**: type in the launcher to filter your shortcuts. Enter runs
  the highlighted shortcut; the launcher dismisses as soon as the run is
  dispatched, and a notification reports the result.

## How it works

The worker reads the shortcuts library through the `shortcuts` CLI and the local
SQLite database, watches `~/Library/Shortcuts` for changes, and runs a selection
through `shortcuts run`. Shortcuts that accept input are registered as dynamic
commands so a value can be supplied from the launcher.

## Development

```sh
pnpm install
pnpm exec asyar dev   # validate + build + link into Asyar + watch
```

`node --test tests/*.test.mjs` runs the shortcut list tests.
`pnpm exec asyar build` produces `dist/`.

## Contributors

Commit `200ee82` ("feat: register shortcuts as dynamic commands with optional
input") was authored by [Xoshbin](https://github.com/Xoshbin).

## License

MIT, Copyright (c) 2026 AllDaGearNoIdea. See [LICENSE](./LICENSE).
