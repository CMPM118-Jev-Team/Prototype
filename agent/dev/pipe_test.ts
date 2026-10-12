/**
 * Pipeline test: measures real answer ARRIVAL RATE when the controller keeps
 * `concurrency` requests in flight at a 10 Hz tick, against the real provider.
 *
 *   deno run --allow-read --allow-net=127.0.0.1 agent/dev/pipe_test.ts [concurrency]
 *
 * (The latency probe measures single-request latency; this measures what the
 * agent actually achieves per second when polls overlap.)
 */

import { loadGame } from "./load_bundle.ts";

const conc = Number(Deno.args[0] ?? 2);
const seconds = 20;

const game = await loadGame();
const agent = () => game().pacmanAgent;
agent().settings.provider = "custom";
agent().settings.endpoint = "http://127.0.0.1:11434/v1/systemone";
agent().settings.stateMode = "text";
if (Deno.args[1]) agent().settings.window = Number(Deno.args[1]); // optional window override

game().loadHighScores();
game().initRenderer();
game().atlas.create();
game().switchState(game().newGameState);
let f = 0;
while (game().state !== game().playState && f++ < 60 * 30) {
  game().state.update();
}

let inFlight = 0,
  done = 0,
  latSum = 0,
  latMax = 0;
const start = Date.now();
const timer = setInterval(() => {
  if (Date.now() - start > seconds * 1000) return;
  if (inFlight >= conc) return;
  const r = agent().buildRequest();
  if (!r) return;
  inFlight++;
  const t0 = Date.now();
  agent()
    .ask(r.state, r.questions, null)
    .then((res: any) => {
      inFlight--;
      done++;
      const ms = Date.now() - t0;
      latSum += ms;
      if (ms > latMax) latMax = ms;
    })
    .catch(() => {
      inFlight--;
    });
}, 100); // 10 Hz tick, like the controller

await new Promise((r) => setTimeout(r, (seconds + 3) * 1000));
clearInterval(timer);
console.log(
  `concurrency=${conc}: ${done} completions in ${seconds}s = ${(done / seconds).toFixed(1)}/s` +
    `, avg lat ${(latSum / Math.max(1, done)).toFixed(0)}ms, max ${latMax}ms`,
);
Deno.exit(0);
