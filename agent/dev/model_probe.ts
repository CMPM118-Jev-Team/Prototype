/**
 * Model comprehension probe: what does the decision model actually read?
 *
 * Fires the real serializer's state+questions at the real provider under a
 * battery of controlled setups and tallies the answers, so poor play can be
 * attributed: does the model react to walls ahead? to ghosts? to which
 * phrasings?
 *
 *   deno run --allow-read --allow-net=127.0.0.1 agent/dev/model_probe.ts [endpoint] [N]
 *
 * Setups (all use the real buildTextState/buildQuestions, teleported):
 *   wall     — stopped against a wall ahead (the exact spot the agent got
 *              stuck in an early headless run: (15,23) heading up). A good
 *              model must NOT answer 'up'
 *   corridor — open corridor, heading left, no ghost nearby
 *   ghost+2  — blinky 2 tiles AHEAD on pac-man's lane (deadly on touch)
 *   ghost+8  — blinky 8 tiles ahead on the lane
 *   ghostbeh — blinky 4 tiles BEHIND on the lane
 *   ghostside— blinky off the lane, 2 up 2 right
 *
 * History: this probe is how the state got its shape. The text state used to
 * carry a full 28×36 ASCII maze; the maze-dependent setups of the day
 * (maze present / deleted / garbage / clean-rows) all answered identically,
 * so the maze was removed from the state — see README 'Model comprehension'.
 */

import { loadGame } from "./load_bundle.ts";

const endpoint = Deno.args[0] || "http://127.0.0.1:11434/v1/systemone";
const N = Math.max(1, Number(Deno.args[1] ?? 6));

const game = await loadGame();
const agent = () => game().pacmanAgent;
const A = agent();
A.settings.provider = "custom";
A.settings.endpoint = endpoint;
A.settings.stateMode = "text";
A.settings.verbose = false;
A._noticedNoVision = true;

game().loadHighScores();
game().initRenderer();
game().atlas.create();
game().switchState(game().newGameState);
let f = 0;
while (game().state !== game().playState && f++ < 60 * 30) {
  game().state.update();
}

const P = game().pacman;
const put = (x: number, y: number, dir: number) => {
  P.tile.x = x;
  P.tile.y = y;
  P.setDir(dir);
  P.setNextDir(dir);
};
const ghostAt = (i: number, x: number, y: number) => {
  game().ghosts[i].tile.x = x;
  game().ghosts[i].tile.y = y;
};
const norm = game().ghosts.map((g: any) => ({ x: g.tile.x, y: g.tile.y }));

type Setup = {
  name: string;
  place: () => void;
};

const setups: Setup[] = [
  { name: "wall      (15,23 up)", place: () => put(15, 23, 0) },
  {
    name: "corridor  (10,26 left)",
    place: () => {
      put(10, 26, 1);
      ghostAt(0, 0, 12); // blinky parked far away upstairs
    },
  },
  {
    name: "ghost+2   (8,26)",
    place: () => {
      put(10, 26, 1);
      ghostAt(0, 8, 26);
    },
  },
  {
    name: "ghost+8   (2,26)",
    place: () => {
      put(10, 26, 1);
      ghostAt(0, 2, 26);
    },
  },
  {
    name: "ghostbeh  (14,26)",
    place: () => {
      put(10, 26, 1);
      ghostAt(0, 14, 26);
    },
  },
  {
    name: "ghostside (8,24)",
    place: () => {
      put(10, 26, 1);
      ghostAt(0, 8, 24);
    },
  },
];

// sanity: report the actual maze at the stuck spot
console.log(
  `wall ahead of (15,23) heading up: getTile(15,22)='${game().map.getTile(15, 22)}' (isFloor=${game().map.isFloorTile(15, 22)})`,
);
console.log(`endpoint ${endpoint}, ${N} samples per setup\n`);

// warm the model so the first setup isn't inflated by a cold load
console.log("warming…");
await A.ask("warm up", {
  direction: {
    type: "choice",
    instructions: "pick one",
    criteria: { up: "up", left: "left", down: "down", right: "right" },
  },
});

// print one full state for eyeballing (corridor setup)
setups[1].place();
const i0 = A.findNextIntersection();
const r0 = A.buildRequest();
console.log("---- full text state (corridor setup) ----");
console.log(r0.state);
console.log("------------------------------------------\n");

for (const s of setups) {
  s.place();
  const inter = A.findNextIntersection();
  const req = A.buildRequest();
  const tally: Record<string, number> = {};
  let pSum = 0,
    confSum = 0;
  for (let i = 0; i < N; i++) {
    const res: any = await A.ask(req.state, req.questions, null);
    const ans = res.answers.direction;
    tally[ans.choice] = (tally[ans.choice] || 0) + 1;
    pSum += ans.probabilities?.[ans.choice] ?? 0;
    confSum += ans.confidence ?? 0;
  }
  const fmt = Object.keys(tally)
    .sort((a, b) => (tally[b] || 0) - (tally[a] || 0))
    .map((k) => `${k}×${tally[k]}`)
    .join(" ");
  console.log(
    `${s.name.padEnd(22)} inter=(${inter.tile.x},${inter.tile.y},${inter.steps}st) ` +
      `→ ${fmt.padEnd(24)} mean-p=${(pSum / N).toFixed(2)} conf=${(confSum / N).toFixed(3)}`,
  );
}

// restore ghost positions so nothing leaks (paranoia — nothing runs after)
game().ghosts.forEach((g: any, i: number) => {
  g.tile.x = norm[i].x;
  g.tile.y = norm[i].y;
});
Deno.exit(0);
