/**
 * Latency probe for the Pac-Man AI agent harness (headless Deno).
 *
 * Measures, against a real provider (default: local Ollama clef-flash):
 *   - request build time (state serialization harness cost)
 *   - state size in chars and tokens (from the provider's usage report)
 *   - end-to-end ask latency at the configured cadence (p50/p95/min/max)
 *
 * Run:
 *   deno task build                        (the probe reads pacman.js)
 *   deno task latency-probe [endpoint] [hz]
 *
 * Use it before/after changing the state serializer (03-gamestate.js) to
 * prove a latency claim: the provider's input_tokens and p50 are printed.
 */

import { loadGame } from "./load_bundle.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (a: number[]) =>
  a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))];

const game = await loadGame();
const agent = () => game().pacmanAgent;

// provider settings (default: local ollama clef-flash)
const endpoint = Deno.args[0] || "http://127.0.0.1:11434/v1/systemone";
const hz = Number(Deno.args[1] ?? 10);
agent().settings.provider = "custom";
agent().settings.endpoint = endpoint;
agent().settings.stateMode = Deno.args[2] ?? "text";
agent().settings.hz = hz;
agent().settings.verbose = false;
agent()._noticedNoVision = true;

// drive the game to playState
game().loadHighScores();
game().initRenderer();
game().atlas.create();
game().switchState(game().newGameState);
let frames = 0;
while (game().state !== game().playState && frames < 60 * 30) {
  game().state.update();
  frames++;
}
if (game().state !== game().playState) {
  console.error("FAIL: game never reached playState");
  Deno.exit(1);
}

// ---- request build cost (harness side) ------------------------------------

const N_BUILD = 50;
const buildMs: number[] = [];
let req: any;
for (let i = 0; i < N_BUILD; i++) {
  const t0 = performance.now();
  req = agent().buildRequest();
  buildMs.push(performance.now() - t0);
  // advance the game a few frames so successive states differ
  for (let f = 0; f < 12; f++) game().state.update();
}
buildMs.sort((a, b) => a - b);

// ---- provider latency at cadence ------------------------------------------

// warm the model first (cold load can take ~20s and would skew p50)
agent().settings.timeoutMs = 60000;
console.log(`warming ${endpoint} ... (first load can take ~20s)`);
const warm = await agent().ask("warm up", {
  ok: { type: "noul", instructions: "ok?" },
});
console.log(`warm: answered in ${warm.ms}ms`);

const N = 30;
const lat: number[] = [];
let tokens = 0;
let chars = 0;
agent().settings.timeoutMs = 5000;
for (let i = 0; i < N; i++) {
  const r = agent().buildRequest();
  chars = r.state.length;
  const res = await agent().ask(r.state, r.questions, r.images);
  tokens = res.raw?.usage?.input_tokens ?? tokens;
  lat.push(res.ms);
  await sleep(Math.max(0, 1000 / hz - res.ms)); // cadence like the controller
}
lat.sort((a, b) => a - b);

const fmt = (a: number[]) =>
  `min ${a[0].toFixed(0)}ms  p50 ${a[Math.floor(a.length / 2)].toFixed(0)}ms  p95 ${pct(a).toFixed(0)}ms  max ${a[a.length - 1].toFixed(0)}ms`;

console.log("\n==== latency probe ====");
console.log(`provider      : ${endpoint} @ ${hz} Hz cadence`);
console.log(`state mode    : ${agent().settings.stateMode}`);
console.log(`build request : ${fmt(buildMs)} (median ${buildMs[Math.floor(buildMs.length / 2)].toFixed(2)}ms, N=${N_BUILD})`);
console.log(`state size    : ${chars} chars, ${tokens} input tokens`);
console.log(`ask latency   : ${fmt(lat)} (N=${N})`);
console.log(
  `effective rate : ${(1000 / lat[Math.floor(lat.length / 2)]).toFixed(1)} req/s at p50 (single flight)`,
);

Deno.exit(0); // Deno.serve etc. would keep the process alive
