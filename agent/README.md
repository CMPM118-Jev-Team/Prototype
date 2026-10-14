# Pac-Man AI Agent

A harness that lets a **Jev-like decision model play Pac-Man in real time** —
by default [Clef-Flash](https://huggingface.co/Cloudflare/clef-flash) running
locally in Ollama on your GPU.

All agent code lives in `agent/`. The game in `src/` is untouched — the
harness is appended to the bundle by `build.ts` and drives the player through
the game's own input layer.

## Decision flow

The game's timing, speed and physics are **never** modified. The harness has
two **decision modes** (toggle with `m`, the right-panel `mode` segment, or
`?mode=`) that differ only in _when_ the model is asked and how the request
latency is paid:

- **realtime** (default) — a wall-clock poller ticks at the poll rate and the
  game **never stops**. Answers land late; the model is told the measured
  latency and asked to plan ahead. If the provider is slow, unreachable or
  times out, Pac-Man just keeps traveling on the last decision — nothing
  pauses or slows.
- **fixed rate** — the poll boundary is counted in **game frames** (10 Hz =
  every 6 `steer()` calls, i.e. every 0.1 s of _play_), and at each boundary
  the game **freezes** (`executive.togglePause`: state updates stop, drawing
  continues) while the prompt is in flight, and **thaws the moment the answer
  lands**. A decision therefore never arrives late in game time — the wall-clock
  latency is paid as a visible freeze instead. Freezes only happen while the
  agent still owns the pause: if the flag changes hands mid-flight (the End
  key, the in-game menu, or a state switch auto-unpausing), the agent never
  toggles it back — no stale freeze is left behind.

Both modes share the rest of the flow:

- a poller asks the model at the poll rate (default **10 Hz**), sending the
  **current state** — never extrapolated or synthetic data — and one typed
  question: _which direction should Pac-Man travel?_ **One prompt is in
  flight at a time**: a poll tick that fires while an answer is still pending
  is skipped, so requests never pile up and answers always apply in order.
- each answer is applied through the game's own input layer
  (`pacman.setInputDir`), exactly like a key press:
  - **straight or u-turn** (matching or opposite the current heading) —
    applied **instantly**;
  - **a perpendicular turn** — **held**: the game turns Pac-Man at the next
    intersection he reaches where that direction is open, and the decision is
    **consumed there** (dropped if that intersection has no such opening)
    — or replaced by whichever newer decision lands first.
- the state is one of several **forms of the same live frame** (cycle with
  `u`, the left-panel **state** menu, or `?state=`). The default is **prose
  facts + history** — passages from the current tile, a stopped flag, each
  ghost in plain words (with a consequence clause when it is on pac-man's
  lane), passages from the next intersection — and the **recent decision
  history**. **No ASCII maze**: probing showed clef-flash doesn't read it
  (see "Model comprehension" below), so it isn't paid for. The other forms
  are cuts of a Doom-style scene, for testing which shape the model plays
  from. See "State forms" below.
- the question tells the model its **answers land late** (with the measured
  latency) and that it must **plan several intersections ahead**; accounting
  for request latency is the model's job, like a human player's. (In fixed
  rate mode answers land on time in game terms, but the question is kept
  identical — the model is never told which mode it is in.)

Polling (of either kind) skips while the game is user-paused, in a menu,
seeking (practice rewind), between rounds, or dead.

## Files

| file                   | purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `01-config.js`         | provider registry + settings (URL params > localStorage > defaults)   |
| `02-provider.js`       | one SystemOne client for every provider                               |
| `03-gamestate.js`      | prose-facts / screenshot state + history + the direction question     |
| `04-controller.js`     | the single-flight poll loop, both decision modes, held-turn semantics |
| `05-main.js`           | key bindings (does not touch `src/input.js`)                          |
| `06-ui.js`             | the debug panels (left: model input, right: agent status)             |
| `selftest.html`        | standalone page: fire one canned request at your provider             |
| `dev/load_bundle.ts`   | shared headless bundle loader for the dev scripts                     |
| `dev/agent_test.ts`    | headless logic test: game + agent, canned or real provider            |
| `dev/latency_probe.ts` | measures state size, tokens, build time and ask latency (p50/p95)     |
| `dev/pipe_test.ts`     | provider throughput benchmark at 10 Hz ticks, per concurrency         |
| `dev/model_probe.ts`   | model comprehension probe: what the model actually reads              |

## Running Clef-Flash locally (Ollama)

You already have this set up — for reference:

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama pull clef-flash            # ~11 GB, q8_0, includes the vision encoder

# recommended systemd override (sudo systemctl edit ollama):
#   [Service]
#   Environment="OLLAMA_CONTEXT_LENGTH=16384"
#   Environment="OLLAMA_KEEP_ALIVE=-1"
```

- `OLLAMA_KEEP_ALIVE=-1` keeps the weights resident. **This is the one that
  matters**: without it (check `curl localhost:11434/api/ps` → `expires_at`)
  Ollama unloads after ~5 idle minutes and the **first request pays a ~17 s
  cold load** — longer than the agent's 5 s timeout, so every start after a
  break looks like "the latency is very high" until it reloads.
- `OLLAMA_NUM_PARALLEL=1` — the agent is single-flight, so extra slots only
  split the KV cache.
- `OLLAMA_KV_CACHE_TYPE=q8_0` — halves KV memory bandwidth during prefill
  (a modest prefill speedup).
- CORS works out of the box for `http://localhost:8000` (Ollama echoes the
  Origin). Serving the game from another host/port? set `OLLAMA_ORIGINS`.
- Measured on an RTX 4080 (q8_0, context 16384): **~30 ms fixed overhead +
  ~0.31 ms per input token**; ~17 s cold load. See "Reducing latency" below.

Alternate local route (faster, no vision): the community FP8 quant plus the
`clef-systemone` server, <https://huggingface.co/kurcontko/clef-flash-FP8-Dynamic>:

```sh
hf download kurcontko/clef-flash-FP8-Dynamic --local-dir clef-flash-FP8
docker run --gpus all --ipc=host -p 8001:8000 \
  -v "$PWD/clef-flash-FP8:/model:ro" \
  --entrypoint bash vllm/vllm-openai:v0.28.0 -c \
  "cp -r /model/vllm_plugin /tmp/p && pip install -q /tmp/p && clef-systemone --model /model --dp 1"
# then use the 'vllm' provider (defaults to http://localhost:8001/v1/systemone)
```

## Playing

```sh
deno task build     # bundle the game + agent (agent/*.js changes need a rebuild)
deno task serve     # http://localhost:8000/
```

Open <http://localhost:8000/> (bundle) or
<http://localhost:8000/debug.htm> (individual files). Start a game from the
menu, then:

### UI panels

The agent adds two debug panels around the game canvas (built by
`agent/06-ui.js`, no game file touched). The page is laid out with flexbox —
`[ AI MODEL INPUT ] [ game canvas ] [ AI PLAYER ]` — with the canvas **centered
on the screen** and both panels **exactly the window height**. (The game
centers its canvas by writing `body.style.marginLeft`, which assumed the
canvas was alone on the page; the agent's stylesheet resets that margin with
`!important` and centers with flexbox instead, so the two schemes don't fight.)
The panels have definite viewport heights with `min-height:0` down the flex
chain — so nothing can ever push the page past the window. Every
text box is **fixed-size**: the questions/answers/history boxes get fixed
heights with internal scrolling (scrollbars hidden), and the strips (latency
health, last choice, holding) are fixed-height single-line — long text
**ellipsizes** instead of wrapping — so nothing on either panel ever resizes
or jumps while the text changes during play. There is **no log pane** — the
console is the log (see below).

- **left — “AI MODEL INPUT”**: the **state form** menu, and —
  all at once, no tabs — the exact `state` string sent, the typed `questions`
  (formatted, not raw JSON), the annotated screenshot (screenshot mode) and
  the latest `answers` (choice, probabilities, confidence, token usage), all
  updated live as requests go out and come back.
- **right — “AI PLAYER”**: status dot + text (stopped / running / asking… /
  **frozen — asking…** in fixed rate mode) with start/stop, the **editable
  poll rate** box, the **decision mode** toggle (realtime / fixed rate), the
  provider selector, a **latency-health strip** — green when answers land
  comfortably inside the poll interval, amber when they use most of it, and a
  pulsing red `latency X ms ≫ budget Y ms` with the effective answer rate when
  the model cannot keep up — which in fixed rate mode instead shows the
  **freeze cost** (`answer in flight X ms — game time stands still`), warning
  when a freeze eats more wall time than the play it buys — a counters grid
  (latency, latency ewma, requests, decisions, errors, age of last answer),
  the highlighted last choice, a **holding strip** (the turn currently held
  for the next intersection, and since when), and a **decision-history box**
  that fills the rest of the panel (exactly the tail sent to the model:
  timestamp, direction, and whether it went through).

On a narrow window the flex row wraps (panels drop below the canvas).

### keys

| key | action                                                         |
| --- | -------------------------------------------------------------- |
| `j` | toggle the AI player on/off                                    |
| `k` | cycle provider: ollama → vllm → cloudflare → typesafe → custom |
| `u` | cycle state form: prose → screenshot → the doom cuts → brief   |
| `h` | cycle poll rate: 1 → 2 → 5 → 10 → 20 Hz                        |
| `m` | toggle decision mode: **realtime ↔ fixed rate**                |

The console **is** the log (the panels have no log pane) — every decision is
logged there, e.g.

```
[agent] decision: 'up' (straight, p=0.51, confidence=0.24) in 342ms (ewma 330ms) — #18
```

Settings also persist in `localStorage` and can be changed live from the
console, e.g. `pacmanAgent.settings.verbose = false` or
`pacmanAgent.setHz(20)`; `pacmanAgent.status()` summarizes the run.

### URL params (override everything)

```
http://localhost:8000/?agent=ollama&state=text&hz=10
```

`agent` provider id · `state` form id (see below) · `mode` `realtime`\|`fixed` ·
`hz` poll rate · `history` recent decisions sent in the state (1–10) ·
`shotwidth` screenshot width in px (112–896) ·
`timeout` request timeout ms · `endpoint` override URL · `model` model id ·
`token` API key (cloud providers) · `account` Cloudflare account id ·
`verbose` `0` quiet.

### Providers

| provider     | where                                                 | vision (screenshot)     | needs                  |
| ------------ | ----------------------------------------------------- | ----------------------- | ---------------------- |
| `ollama`     | `http://localhost:11434/v1/systemone`                 | ✅                      | —                      |
| `vllm`       | `http://localhost:8001/v1/systemone`                  | ❌ (falls back to text) | —                      |
| `cloudflare` | Workers AI REST (`@cf/cloudflare/clef-flash`)         | ✅                      | account id + API token |
| `typesafe`   | `https://api.typesafe.ai/v1/systemone` (`jev-latest`) | ❌ (falls back to text) | API key                |
| `custom`     | any `/v1/systemone` URL                               | ✅                      | `?endpoint=`           |

The request body (`{ model, state, questions[, images] }`) and response
(`answers.<id>` with `choice`/`probabilities`/`confidence`) are identical
across providers — that's the point of the SystemOne format — so switching is
just a `k` press or `?agent=` param. Cloudflare's REST result envelope is
unwrapped automatically.

Screenshot mode (`u`) sends a `shotWidth` px-wide (default 320) annotated PNG
of the canvas (column/row labels + a red square on the intersection) via the
Clef `images` extension; on providers without vision it logs a notice and
falls back to text. Vision tokens scale with pixels — screenshot mode is
inherently slower than text (see below).

## State forms

Every form is the current frame only. The direction question does not change,
so a swap is a test of the scene, not of the action. `u` cycles them.

| id           | what the model reads                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| `text`       | Prose facts and recent decisions. The baseline.                                      |
| `shot`       | That prose, plus an annotated screenshot.                                            |
| `doom`       | Doom-demo JSON: tile as the map unit, distance brackets, bearing, tick, speed, how often a decision is made, the player, walls relative to heading, velocity, every ghost, energizers, the nearest pellet, the next intersection, recent decisions. |
| `doom-frame` | That live frame as JSON, without the physics legend or the decision history.        |
| `doom-local` | Same JSON, but a ghost or item farther than 8 tiles or behind a wall is `remembered` (out of view) instead of listed in front of you. Its position is where it is now. |
| `doom-prose` | The frame as sentences: heading-relative walls, range, bearing.                      |
| `brief`      | Heading, walls, the next intersection, and one line per ghost.                       |

Distance words are guidelines: **contact** is 1 tile or closer, **close** is 2 to 4, **medium** is 5 to 8, **far** is 9 or more. Bearing is relative to the heading: 0 is straight ahead, positive is left, negative is right.

## Reducing latency

The state size is what it is — **prose facts + history**, deliberately — and
measured on this machine (RTX 4080, Ollama q8_0, context 16384) with
`deno task latency-probe`:

| text state                              | chars | tokens | ask p50     |
| --------------------------------------- | ----- | -----: | ----------- |
| v3 windowed maze + terse stats (old)    | ~650  |   ~380 | ~135 ms     |
| v4 full level + prose facts + history   | 2579  |   1170 | ~430 ms     |
| v5 prose facts + history (maze removed) | 1071  |    616 | **~220 ms** |

What still holds:

- **There is no prompt caching across requests on this runner** — the same
  prompt 8× costs the same each time. **State size is the latency.**
- Prefill costs ~0.31 ms/token with ~30 ms fixed overhead; the runner's own
  template floor is ~155 tokens (~80 ms) before any content.
- Request **build time is negligible** (~0.02 ms).

Levers, in order:

1. **`OLLAMA_KEEP_ALIVE=-1`** — kills the ~17 s cold-load spikes after idle
   breaks (verify: `curl localhost:11434/api/ps`, `expires_at` should be
   empty). Also worth setting: `OLLAMA_FLASH_ATTENTION=1`,
   `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, then restart ollama.
   `deno task pipe-test` measures raw provider throughput per concurrency.
2. **Faster serving stack** — the FP8 vLLM route (`vllm` provider, commands
   above) is the real fix; see the next section. Don't run two clients
   against one GPU — concurrent requests share it.
3. Cloud Jev (`typesafe`) is 70–500 ms over the network — slower than local
   for this workload.

Re-measure any change yourself:

```sh
deno task build
deno task latency-probe                                    # single-request latency + tokens
deno task pipe-test           # [concurrency] — raw provider arrival rate at 10 Hz ticks
deno task model-probe http://127.0.0.1:11434/v1/systemone  # what the model actually reads
```

## Effective decision rate — the measured reality

The poll rate (default 10 Hz) caps how often the model is _asked_; with **one
prompt in flight** the _answers_ land once per request latency. Measured on
this machine (Ollama q8_0, 616-token state): **p50 ~220 ms → ~4.5 answers/s**.
The red strip is honest at 10 Hz — it just means answers land ~2 polls stale,
and the model is told so and asked to plan ahead. Held-turn decisions are
consumed at intersections either way.

If you want answers to land every poll (a green strip), the recipe is the
serving stack, not the harness:

1. **The guaranteed fix: switch to the FP8 vLLM route** (`vllm` provider,
   commands in the Ollama section). Benchmarked at ~10,000 tokens/s prefill on
   a same-class 16 GB card (~3× this stack) → the 616-token request answers
   in ~50–70 ms → **single-flight 10 Hz green** with headroom.
   (Untested here — no vLLM install on this box.)
2. **Ollama env knobs** (`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`)
   may lift prefill ~10–20% — worth measuring with `deno task pipe-test`.
3. Or accept it: the model demonstrably plays fine off ~4.5 decisions/s with
   held turns — it plans intersections ahead, it does not need reflexes.

## Verifying your setup

1. `agent/selftest.html` — <http://localhost:8000/agent/selftest.html> —
   fires one canned request (text or a tiny image) through the same client
   the game uses and prints the raw response + latency. Also a good warm-up.
2. `deno task agent-test` — headless: loads the bundle in Deno with stubbed
   DOM/audio, plays 20 s against a canned provider, prints the exact state +
   questions sent, and asserts movement + decisions. No browser/GPU needed.
3. `deno task agent-test http://127.0.0.1:11434/v1/systemone` — same, but
   the real local model answers (warms it first, ~20 s cold).
4. `deno task model-probe http://127.0.0.1:11434/v1/systemone [N]` — the
   comprehension probe below.

`deno task build` twice produces identical `pacman.js` (only the
`last updated:` timestamp lines change).

## Model comprehension — why the state is prose-first

`agent/dev/model_probe.ts` runs controlled setups against the real model
(pac-man teleported, state/questions from the real serializer, N samples per
setup). Findings on clef-flash q8_0 (every result 6/6 identical — the choice
is argmax over near-uniform logits, so wording shifts flip it):

| setup                                                       | answer    | verdict                           |
| ----------------------------------------------------------- | --------- | --------------------------------- |
| stopped at a wall, wall only drawn in the map               | `up` ×6   | **cannot read the ASCII maze**    |
| same, maze rows stripped from the state                     | `up` ×6   | same answer without the maze      |
| same, maze rows replaced by garbage letters                 | `right`×6 | the bytes matter, not legibly     |
| same, maze with clean rows (no labels/ruler)                | `up` ×6   | formatting is not the problem     |
| same, one prose sentence about the wall                     | `left`×6  | **reacts to plain sentences**     |
| ghost 2 tiles ahead, telegraphic stats line                 | `left`×6  | ignores telegraphic offsets       |
| ghost 2 ahead, plain-sentence position + consequence clause | `right`×6 | **reacts (confidence 0.08→0.36)** |

Conclusions baked into `03-gamestate.js`: clef-flash grounds on **plain
declarative sentences about the immediate situation** — not on the ASCII map
(**removed from the state entirely**: it answered identically with the maze
present, deleted, or garbled, and it was ~half the request latency), not on
telegraphic coordinates. The state therefore states the passages from the
current tile, a stopped flag, each ghost in words — with an explicit
consequence clause ("continuing straight ahead leads straight into him")
when a hunting ghost is on pac-man's lane — and the passages from the next
intersection. All of it current state; the model still does the planning.

## Notes

- Latency budget: Pac-Man covers ~1 tile per ~130 ms (60 Hz, 8 px tiles), so
  ~220 ms answers are ≈2 tiles stale — which is why the question tells the
  model its latency and asks it to plan ahead. Cloud Jev (70–500 ms) is in
  the same regime. Cost on cloud: at ~4.5 answers/s with ~620-token states,
  Jev is roughly $0.45/hour of play ($0.042/M input) — local Ollama is free.
- The game's own attract mode (`p` in practice mode, `pacman.ai`) is
  separate and unaffected.
- Everything here is vendor-measured or measured on this machine; treat
  numbers as directional.
