/**
 * Shared bundle loader for agent dev scripts (headless Deno).
 *
 * Loads the built bundle (pacman.js) with minimal DOM/audio stubs and
 * returns a live accessor to the game's closure variables.
 *
 * `deno task build` first — this reads pacman.js.
 *
 * The game declares `var Map = function...` (src/Map.js), so the bundle must
 * NOT be eval'd at global scope (it would shadow Deno's built-in Map and
 * crash its internals). It is wrapped in a plain function instead, and a live
 * accessor `__game()` exposes what scripts need.
 */

function makeCtx(): any {
  return new Proxy({}, {
    get(t: any, prop: string) {
      if (prop === "measureText") return () => ({ width: 8 });
      if (prop === "createLinearGradient" || prop === "createRadialGradient") {
        return () => ({ addColorStop() {} });
      }
      if (prop === "getImageData") {
        return (_x: number, _y: number, w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
          width: w,
          height: h,
        });
      }
      if (typeof t[prop] !== "undefined") return t[prop];
      return () => undefined; // every canvas method is a no-op
    },
    set(t: any, prop: string, v: unknown) {
      t[prop] = v;
      return true;
    },
  });
}

function makeCanvas(): any {
  const node: any = {
    width: 0,
    height: 0,
    style: {},
    children: [],
    childNodes: [],
    firstChild: null,
    scrollTop: 0,
    scrollHeight: 0,
    textContent: "",
    getContext: () => makeCtx(),
    toDataURL: () => "data:image/png;base64,",
    addEventListener() {},
    removeEventListener() {},
    appendChild(c: unknown) {
      return c;
    },
    removeChild() {},
    insertBefore(c: unknown) {
      return c;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    removeAttribute() {},
    reset() {},
  };
  node.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  node.parentNode = null;
  return node;
}

/** Installs window/document/localStorage/Audio stubs on globalThis. */
export function installStubs(): void {
  const g: any = globalThis;
  g.window = g;
  g.addEventListener = () => {};
  g.location = { hash: "", search: "" };
  g.devicePixelRatio = 1;
  const defineGlobal = (name: string, value: unknown) =>
    Object.defineProperty(g, name, {
      value,
      configurable: true,
      writable: true,
    });
  defineGlobal("document", {
    readyState: "complete",
    getElementById: () => makeCanvas(),
    createElement: () => makeCanvas(),
    head: makeCanvas(),
    body: { style: {} },
    addEventListener() {},
  });
  defineGlobal("localStorage", {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  });
  defineGlobal("Audio", class {
    src = "";
    volume = 1;
    paused = true;
    currentTime = 0;
    constructor(src?: string) {
      this.src = src || "";
    }
    load() {}
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    addEventListener() {}
    removeEventListener() {}
  });
  defineGlobal("navigator", { userAgent: "deno" });
}

/** Loads pacman.js and returns a live accessor () => {game globals}. */
export async function loadGame(): Promise<() => any> {
  const pacmanJs = await Deno.readTextFile("pacman.js");
  const openTag = "(function(){";
  // The bundle wrapper build.ts writes is the FIRST '(function(){' (right
  // after the fixed header) and the LAST '})();' — inner IIFEs don't match it.
  const i = pacmanJs.indexOf(openTag);
  const closeTag = "})();";
  const j = pacmanJs.lastIndexOf(closeTag);
  if (i < 0 || j < 0 || j < i) {
    console.error(
      "FAIL: pacman.js does not look like the built bundle — run `deno task build` first",
    );
    Deno.exit(1);
  }
  const code = pacmanJs.slice(i + openTag.length, j);

  installStubs();

  const indirectEval = eval;
  indirectEval(
    `(function () {\n${code}\n; globalThis.__game = function () { return {
    pacman, ghosts, map, state, playState, newGameState, readyState,
    executive, inGameMenu, vcr, pacmanAgent, switchState, loadHighScores,
    initRenderer, atlas, getScore, level, extraLives,
  }; };\n})();`,
  );
  const game = () => (globalThis as any).__game();

  if (typeof game().pacmanAgent !== "object") {
    console.error(
      "FAIL: pacmanAgent is not defined after eval — were the agent files bundled?",
    );
    Deno.exit(1);
  }
  return game;
}
