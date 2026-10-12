/**
 * Headless logic test for the Pac-Man AI agent harness.
 *
 * Loads the built bundle (pacman.js) into Deno with minimal DOM stubs, drives
 * the game loop frame by frame, and lets the agent play against either
 *
 *   - a canned SystemOne server started here in-process (default), or
 *   - a real provider (pass its /v1/systemone URL as the first argument,
 *     e.g. `deno task agent-test http://127.0.0.1:11434/v1/systemone`).
 *
 * Two decision modes are driven in sequence: a realtime segment (wall-clock
 * poller, game never stops), then a fixed-rate segment (the game freezes for
 * each decision — the test verifies the executive really is paused while a
 * freeze is out, and that only ONE request is ever in flight).
 *
 * Run:
 *   deno task build          (the test reads pacman.js, so build first)
 *   deno task agent-test [endpoint]
 *
 * No browser or GPU is needed for the canned run; the game's renderer and
 * audio are stubbed out, only the game logic runs. See load_bundle.ts.
 */

import { loadGame } from "./load_bundle.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- canned SystemOne server (default provider) -----------------------------

const cycle = ["left", "up", "down", "right"];
let cannedRequests = 0;

// ---- load the bundle -------------------------------------------------------

const game = await loadGame();
const agent = () => game().pacmanAgent;

// ---- optional real endpoint / else canned server ---------------------------

const realEndpoint = Deno.args[0];
if (!realEndpoint) {
  Deno.serve({ port: 8765, hostname: "127.0.0.1" }, () => {
    cannedRequests++;
    const choice = cycle[cannedRequests % cycle.length];
    return new Response(
      JSON.stringify({
        model: "clef-flash",
        answers: {
          direction: {
            type: "choice",
            choice,
            probabilities: { [choice]: 0.7 },
            confidence: 0.5,
          },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
}

agent().settings.provider = "custom";
agent().settings.endpoint =
  realEndpoint || "http://127.0.0.1:8765/v1/systemone";
agent().settings.stateMode = "text";
agent().settings.hz = 10;
agent().settings.verbose = !!realEndpoint; // log every decision against a real model
agent()._noticedNoVision = true; // keep the test log quiet

// ---- drive the game to playState -------------------------------------------

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
console.log("reached playState after", frames, "updates");

// ---- eyeball the serializer -------------------------------------------------

const inter = agent().findNextIntersection();
console.log(
  "next intersection:",
  JSON.stringify({ ...inter, dirEnum: agent().DIR_NAMES[inter.dirEnum] }),
);
const req = agent().buildRequest();
if (!req) {
  console.error("FAIL: buildRequest returned nothing in playState");
  Deno.exit(1);
}
console.log(`state size: ${req.state.length} chars`);
console.log("---- text state sent to the model ----");
console.log(req.state);
console.log("---- questions ----");
console.log(JSON.stringify(req.questions, null, 2));
console.log("--------------------------------------");

// ---- let the agent play ------------------------------------------------------

const seenTiles = new Set<string>();
let crashed: unknown = null;

agent().start();

for (let sec = 0; sec < 20 && !crashed; sec++) {
  for (let f = 0; f < 60; f++) {
    try {
      game().state.update();
    } catch (e) {
      crashed = e;
      break;
    }
  }
  // ~1s of wall time per iteration so the 10 Hz wall-clock poller gets a
  // realistic number of chances (the game loop itself is much faster here)
  await sleep(1000);
  const p = game().pacman;
  seenTiles.add(`${p.tile.x},${p.tile.y}`);
  console.log(
    `t=${sec}s pacman=(${p.tile.x},${p.tile.y})` +
      ` dir=${agent().DIR_NAMES[p.dirEnum]}` +
      ` input=${agent().DIR_NAMES[p.inputDirEnum] ?? "?"}` +
      ` state=${game().state === game().playState ? "play" : "other"}`,
  );
}

// ---- fixed-rate segment: freeze → ask → thaw -------------------------------

const decBefore = agent().status().decisions as number;
console.log("---- switching to fixed-rate mode ----");
agent().setMode("fixed");

let heldSeen = 0;
let unpauseBroken = 0; // freezes where the executive was NOT actually paused
let multiFlight = 0; // ticks observing more than ONE request in flight
for (let f = 0; f < 60 * 12 && !crashed; f++) {
  // Wait out every fixed-rate freeze: while the agent holds the pause, the
  // executive must actually be paused (that is the whole contract — the
  // decision lands with zero latency in game time).
  let guard = 0;
  while (agent().status().holding || agent().status().inFlight) {
    const s = agent().status();
    if (s.inFlight > 1) multiFlight++;
    if (s.holding) {
      heldSeen++;
      if (!game().executive.isPaused()) unpauseBroken++;
    }
    await sleep(5);
    if (++guard > 4000) break; // 20s safety valve
  }
  try {
    game().state.update();
  } catch (e) {
    crashed = e;
    break;
  }
  const p = game().pacman;
  seenTiles.add(`${p.tile.x},${p.tile.y}`);
}

agent().stop();

// ---- assertions ---------------------------------------------------------------

let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log((ok ? "PASS" : "FAIL") + ": " + label);
  if (!ok) failures++;
};

if (crashed) {
  console.error("FAIL: game loop threw:", (crashed as Error)?.stack ?? crashed);
  Deno.exit(1);
}
check(
  seenTiles.size > 1,
  `pac-man moved through >1 tile (${seenTiles.size} seen)`,
);
check(
  seenTiles.size >= 3,
  `pac-man moved through >=3 tiles (${seenTiles.size} seen)`,
);
const st = agent().status();
check(st.decisions >= 1, `agent applied decisions (${st.decisions})`);
check(
  Math.round(st.intervalMs) == 100,
  `status exposes the poll interval for the latency health UI (${Math.round(
    st.intervalMs,
  )} ms @ 10 Hz)`,
);
check(st.mode == "fixed", `status exposes the decision mode (${st.mode})`);
check(
  (st.decisions as number) > decBefore,
  `fixed-rate mode kept deciding (${st.decisions} > ${decBefore})`,
);
check(heldSeen > 0, "fixed-rate freezes were observed while waiting");
check(
  unpauseBroken == 0,
  `the executive stayed paused during every freeze (${unpauseBroken} broken)`,
);
check(
  multiFlight == 0,
  `only ONE request was ever in flight (${multiFlight} violations)`,
);
check(
  !game().executive.isPaused(),
  "stop() left the game thawed (no freeze left behind)",
);
if (!realEndpoint) {
  check(
    cannedRequests > 0,
    `canned provider answered requests (${cannedRequests})`,
  );
}

console.log("---- agent status ----");
console.log(
  JSON.stringify({ ...st, settings: "(see pacmanAgent.settings)" }, null, 2),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  Deno.exit(1);
}
console.log("\nall checks passed");
Deno.exit(0); // Deno.serve keeps the process alive without this
