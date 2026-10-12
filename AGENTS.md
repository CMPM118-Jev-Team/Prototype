# AGENTS.md

Notes for AI coding agents working in this repository.

## Project

An accurate HTML5/JavaScript remake of the original Pac-Man arcade game. The game
source lives in `src/` as plain browser JS (ES5-era style): no imports or exports, no
module system — files share one scope inside the bundle's `(function(){ ... })()`
wrapper and depend on the concatenation order. Non-source directories (`sounds/`,
`sprites/`, `font/`, `mapgen/`, `fruit/`, `doc/`, ...) hold assets and research
notes; see `README.md` for navigation.

## Commands (Deno)

`deno.json` defines the tasks; Deno is the only tool required (no package dependencies).

- `deno task build` — concatenate `src/` into `pacman.js`, refresh the `last updated:`
  timestamp in `index.htm` (previous copy kept in `index.htm.bak`), and rebuild `debug.htm`.
- `deno task serve [port]` — serve the project at `http://localhost:8000/` (default port 8000) so the game can be played in a browser; `debug.htm` loads the individual
  `src/*.js` files instead of the bundle.
- `deno check build.ts serve.ts` — type-check the build tooling.

## Rules for build changes

- Concatenation order matters. A new source file must be added to `jsOrder` in
  `build.ts` (files use definitions from the files above them).
- Don't restructure the bundle layout when editing `build.ts`: the license header,
  `//@line` directives, and IIFE wrapper are part of the generated output.
- `pacman.js`, `index.htm`, `index.htm.bak`, and `debug.htm` are generated files that are
  checked in. After `deno task build` they may show as modified (bundle content plus the
  `index.htm` timestamp line) — that is expected. Never hand-edit them; edit `src/` and
  rebuild.

## Verification

There is no test suite. After making changes:

1. Run `deno task build`; it must complete without errors.
2. Run `deno task serve`, then load `http://localhost:8000/` and
   `http://localhost:8000/debug.htm` and confirm the game boots (arrows steer,
   End pauses, Escape opens the in-game menu).
3. For build changes, confirm the build is deterministic: run `deno task build` twice
   and verify `pacman.js` is identical and only the timestamp lines in `index.htm` and
   `debug.htm` change.
