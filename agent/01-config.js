//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 01 Configuration
//
// Provider registry and runtime settings for the AI player harness.
// All agent code lives in agent/ and is appended to the bundle after the game
// files (see build.ts). Nothing in src/ knows about or depends on it.
//
// Every provider speaks the SystemOne wire format shared by Jev and Clef:
//   POST {endpoint}  body:  { model, state, questions[, images] }
//   response:        { model, answers: { <question-id>: {...} }, usage }
//
// Settings sources (highest precedence first):
//   URL params (?agent=ollama&state=text&hz=10&endpoint=...&token=...)
//   localStorage  ('pacmanAgent.settings')
//   defaults below

var pacmanAgent = (function () {
  // ---- providers ---------------------------------------------------------

  // 'vision' marks whether the provider accepts the Clef `images` extension
  // (base64-encoded screenshots) in the request body.
  var providers = {
    ollama: {
      label: "Ollama clef-flash (local GPU)",
      endpoint: "http://localhost:11434/v1/systemone",
      model: "clef-flash",
      vision: true,
      auth: "none",
    },
    vllm: {
      label: "clef-systemone / vLLM (local GPU)",
      // FP8 image maps its docker port 8000 to host 8001 so it doesn't
      // collide with `deno task serve` on 8000.
      endpoint: "http://localhost:8001/v1/systemone",
      model: "clef-flash",
      vision: false,
      auth: "none",
    },
    cloudflare: {
      label: "Cloudflare Workers AI clef-flash (cloud)",
      endpoint:
        "https://api.cloudflare.com/client/v4/accounts/%ACCOUNT%/ai/run/@cf/cloudflare/clef-flash",
      model: "clef-flash",
      vision: true,
      auth: "bearer", // Workers AI REST API token
    },
    typesafe: {
      label: "TypeSafe Jev (cloud)",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      vision: false,
      auth: "bearer", // TypeSafe API key
    },
    custom: {
      label: "Custom endpoint",
      endpoint: "http://localhost:11434/v1/systemone",
      model: "clef-flash",
      vision: true,
      auth: "none",
    },
  };

  var providerOrder = ["ollama", "vllm", "cloudflare", "typesafe", "custom"];

  // ---- settings ----------------------------------------------------------

  var settings = {
    provider: "ollama", // which provider to ask
    stateMode: "text", // which state form to send; see pacmanAgent.stateModes
    // in 03-gamestate.js (text, shot, doom, doom-frame, doom-local,
    // doom-prose, brief)
    outputMode: "direct", // what the model answers; see pacmanAgent.outputModes
    // in 03b-output.js (direct, intersection, goto, goal)
    instructions: "", // extra text added to every state (the left-panel box)
    fleeOffer: 8, // goto: offer "run away" only when a hunting ghost is this
    // many steps away by the maze or fewer (?flee=)
    fleeRelease: 12, // goto: stop fleeing once every hunter is this many steps
    // away or more, and go back to the nearest pellet (?fleeend=)
    mode: "realtime", // 'realtime' (never disturb the game) or 'fixed' (the
    // game freezes for each decision — see 04-controller.js)
    hz: 10, // poll rate: how often the model is asked (ONE prompt in
    // flight at a time — a tick that fires while an answer is still
    // pending is skipped; see 04-controller.js)
    history: 4, // recent decisions sent in the state (1-10), each with
    // its timestamp and whether it went through — see 04-controller.js
    shotWidth: 320, // screenshot width in px (112-896): vision tokens
    // scale with pixels
    timeoutMs: 5000, // give up on a request after this long
    endpoint: "", // override the provider endpoint
    model: "", // override the provider model id
    token: "", // bearer token for cloud providers
    account: "", // Cloudflare account id (for %ACCOUNT%)
    verbose: true, // log every applied decision
  };

  var LS_KEY = "pacmanAgent.settings";

  var applyUrlParams = function () {
    var q = {};
    try {
      var s = window.location.search;
      if (s && s.length > 1) {
        var parts = s.substring(1).split("&");
        for (var i = 0; i < parts.length; i++) {
          var kv = parts[i].split("=");
          q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
        }
      }
    } catch (e) {
      /* ignore malformed urls */
    }
    if (q.agent && providers[q.agent]) settings.provider = q.agent;
    if (q.state && /^[a-z0-9-]+$/.test(q.state)) settings.stateMode = q.state;
    if (q.output && /^[a-z0-9-]+$/.test(q.output)) settings.outputMode = q.output;
    if (q.mode == "realtime" || q.mode == "fixed") settings.mode = q.mode;
    if (q.flee) {
      var fo = parseInt(q.flee, 10);
      if (fo > 0) settings.fleeOffer = fo;
    }
    if (q.fleeend) {
      var fr = parseInt(q.fleeend, 10);
      if (fr > 0) settings.fleeRelease = fr;
    }
    if (q.hz) {
      var hz = parseInt(q.hz, 10);
      if (hz > 0) settings.hz = hz;
    }
    if (q.history) {
      var h = parseInt(q.history, 10);
      if (h >= 1 && h <= 10) settings.history = h;
    }
    if (q.shotwidth) {
      var sw = parseInt(q.shotwidth, 10);
      if (sw >= 112 && sw <= 896) settings.shotWidth = sw;
    }
    if (q.endpoint) settings.endpoint = q.endpoint;
    if (q.model) settings.model = q.model;
    if (q.token) settings.token = q.token;
    if (q.account) settings.account = q.account;
    if (q.timeout) {
      var t = parseInt(q.timeout, 10);
      if (t > 0) settings.timeoutMs = t;
    }
    if (q.verbose == "0" || q.verbose == "false") settings.verbose = false;
  };

  var loadSettings = function () {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var k in saved) settings[k] = saved[k];
      }
    } catch (e) {
      /* private mode or stale junk — ignore */
    }
    applyUrlParams();
  };

  var saveSettings = function () {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings));
    } catch (e) {
      /* ignore */
    }
  };

  loadSettings();

  // ---- helpers ----------------------------------------------------------

  var log = function (msg) {
    var args = Array.prototype.slice.call(arguments);
    args[0] = "[agent] " + msg;
    console.log.apply(console, args);
  };

  return {
    providers: providers,
    providerOrder: providerOrder,
    settings: settings,
    log: log,
    save: saveSettings,

    getProvider: function () {
      return providers[settings.provider] || providers.ollama;
    },
    describe: function () {
      var p = this.getProvider();
      return (
        settings.provider +
        " (" +
        p.label +
        "), state=" +
        settings.stateMode +
        ", output=" +
        settings.outputMode +
        ", mode=" +
        settings.mode +
        ", hz=" +
        settings.hz +
        ", model=" +
        (settings.model || p.model)
      );
    },
  };
})();
