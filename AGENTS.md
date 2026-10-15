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
- `deno task agent-test [endpoint]` — headless logic test of the game + AI player
  (canned provider by default; pass a `/v1/systemone` URL, e.g.
  `http://127.0.0.1:11434/v1/systemone`, to play against a real model).
- `deno task latency-probe`, `deno task pipe-test`, `deno task model-probe` —
  measure and probe a provider (see `agent/README.md`).

## AI player (`agent/`)

`agent/` holds a self-contained harness that lets a Jev-like decision model play
the game — by default Clef-Flash served by Ollama on the local GPU. It is bundled
AFTER the game files (`agentOrder` in `build.ts`); `src/` never knows about it.
`agent/README.md` is the full documentation; `agent/jev-doom-demo.json` records
the Doom-demo state shapes the JSON forms imitate.

- `pacmanAgent` (defined in `01-config.js`) is the shared global. The agent files
  run in order and use definitions from the files above them: `01-config`
  providers + settings, `02-provider` the HTTP client, `03-gamestate` the state
  forms, `03b-output` the questions + answer→direction resolution, `04-controller`
  the decision loop, `05-main` key bindings, `06-ui` the side panels. A NEW agent
  file must be added to `agentOrder` in `build.ts`.
- Wire format ("SystemOne", shared by Jev and Clef): `POST {endpoint}` with
  `{ model, state, questions[, images] }`, answered with `{ answers: {
  <question-id>: { choice, probabilities, confidence } }, usage }`. One client
  covers every provider; Cloudflare's REST envelope is unwrapped automatically.
- Decision loop (`04-controller.js`): ONE prompt in flight at a time (a poll tick
  while an answer is pending is skipped), default 10 Hz. Every answer is pressed
  through the game's own input layer (`pacman.setInputDir`), like an arrow key:
  straight/u-turn apply instantly; a perpendicular turn is HELD and consumed at
  the next intersection (or replaced by a newer answer). The state always
  describes the CURRENT frame — never extrapolated — plus recent decision
  history (timestamps + whether each action went through).
- Decision modes (`settings.mode`, key `m`): `realtime` — wall-clock polling, the
  game never stops, answers land late (the model is told the measured latency and
  asked to plan ahead); `fixed` — the poll boundary is counted in game frames and
  the game FREEZES while each prompt is in flight (`executive.togglePause`),
  thawing when the answer lands (zero in-game decision latency). The agent only
  releases a pause it still owns — a mid-flight End key, the in-game menu, or
  `switchState`'s auto-unpause takes the flag back (pauseVersion/holdVersion).
- State forms (`settings.stateMode`, key `u`): `text` (prose, the baseline),
  `shot` (annotated screenshot + prose), `doom`, `doom-frame`, `doom-local`,
  `doom-prose` (Doom-demo JSON cuts), `brief` — all describe the same live frame;
  one sample each in `agent/sample-states/`. No ASCII maze: probing showed
  clef-flash does not read it.
- Output modes (`settings.outputMode`, key `b`): what the model answers —
  `direct` (a direction), `intersection` (an open exit at the next intersection),
  `goto` (a place; the harness follows the shortest maze path until the next
  answer), `goal` (goal + dodge + movement, recombined against the maze every
  frame via `pacmanAgent.liveSteer`).
- `settings.instructions` (the left-panel box) is appended to every state.
- Settings precedence: URL params (`?agent=&state=&output=&mode=&hz=…`) >
  `localStorage` (`pacmanAgent.settings`) > defaults in `01-config.js`.
- `06-ui.js` builds the side panels (left: everything sent to the model; right:
  status, latency health, held turn, decision history). There is NO log pane —
  the console logger (`pacmanAgent.log`) is the log.

## Swapping models

Any server speaking the SystemOne wire format can drive the player, so swapping
is a settings change, not a code change.

- At runtime: `k` cycles the registered providers, the right-panel `provider`
  selector, `?agent=<id>`, or `pacmanAgent.settings.provider = "…"` in the
  console. `?model=` / `settings.model` overrides the model id; `?endpoint=` /
  `settings.endpoint` overrides the URL. Changes persist in `localStorage`.
- Registered providers (`agent/01-config.js`): `ollama` (local GPU, default —
  Ollama clef-flash at `http://localhost:11434/v1/systemone`), `vllm` (local FP8
  image at `http://localhost:8001/v1/systemone`), `cloudflare` (Workers AI REST —
  needs `settings.account` + an API token), `typesafe` (TypeSafe Jev hosted API —
  needs an API key), `custom` (any `/v1/systemone` URL via `?endpoint=`).
- To add one: add an entry to `providers` and `providerOrder` in
  `agent/01-config.js` — `endpoint`, `model`, `vision` (accepts `images`?), `auth`
  (`none` or `bearer`). Nothing else changes; all providers share `02-provider`.
- Local: `ollama pull clef-flash` then run Ollama (see `agent/README.md` →
  "Running Clef-Flash locally" for the systemd overrides that keep the model
  resident); the FP8 vLLM image maps to host port 8001 so it does not collide
  with `deno task serve` on 8000.
- Cloud: tokens go in `settings.token` (`?token=`), sent as `Authorization:
  Bearer …`; Cloudflare also needs `settings.account` to fill the `%ACCOUNT%`
  placeholder in its endpoint. Never commit tokens.

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
4. For agent changes: `deno task build` (agent files are bundled too), then
   `deno task agent-test` — must end "all checks passed" (the fixed-rate segment is
   timing-sensitive; run it more than once).
