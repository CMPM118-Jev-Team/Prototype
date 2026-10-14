//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 04 Controller
//
// Real-time decision loop — ONE prompt in flight at a time (a poll tick that
// fires while an answer is still pending is skipped; requests never pile up):
//
//   - a fixed-rate poller (default 10 Hz — pacmanAgent.settings.hz) sends the
//     CURRENT state and one 'direction' question;
//   - each answer is applied through the game's own input layer
//     (pacman.setInputDir), exactly like a key press:
//       • straight or u-turn → applied instantly;
//       • a perpendicular turn → HELD: the game turns Pac-Man at the next
//         intersection where that direction is open, and the decision is
//         consumed there (dropped if it had no such opening) — or replaced
//         by whichever newer decision lands first;
//   - the state sent to the model includes the recent decision history
//     (timestamped in seconds from the start of the game, and whether each
//     action went through), so the model can judge its own latency and plan.
//
// Two decision modes (pacmanAgent.settings.mode, key 'm', ?mode=…):
//
//   realtime — the poller ticks on the WALL clock and never touches the game;
//     answers land late (the model is told the measured latency and asked to
//     plan ahead). If the provider is slow or fails, Pac-Man just keeps
//     traveling on the last decision — nothing pauses or slows.
//
//   fixed — the poll boundary is counted in GAME frames (10 Hz = every 6
//     steer() calls, i.e. every 0.1s of play), and at each boundary the game is
//     FROZEN (executive.togglePause: state updates stop, drawing continues)
//     while the prompt is in flight, and thawed the moment the answer lands.
//     A decision therefore never arrives late in game time — the wall-clock
//     latency is paid as a visible freeze instead. Polling still skips while
//     the game is user-paused, in a menu, seeking (practice rewind), between
//     rounds, or dead.
//
// The freeze is released only while the agent still owns the pause: the
// pause flag can change hands mid-flight (the End key, the in-game menu, or
// switchState's auto-unpause all toggle it), and then it is theirs — the
// agent never toggles a pause it did not set (see pauseVersion/holdVersion).

(function () {
  var running = false;
  var inFlight = 0; // 0 or 1 — single-flight by design
  var flightStart = 0; // wall-clock ms the in-flight request started
  var intervalId = 0;
  var lastErrorAt = -Infinity; // so the first error is always logged
  var decisions = 0;
  var errors = 0;
  var requests = 0; // requests actually sent (skipped ticks don't count)
  var lastChoice = null; // { choice, kind, probability, confidence, ms, num }

  // ---- game clock (used for the history timestamps) ----------------------
  // The VCR only records in practice mode, so it can't be the clock. This
  // counts pac-man's own steer() calls instead — exactly one per frame of
  // active play (Actor.update), i.e. only while the game actually runs:
  // pauses, menus and cutscenes are excluded. Seconds from the start of the
  // agent's run ≈ seconds from the start of the game (start it at the ready
  // screen and it is the same thing).
  var playFrames = 0;
  pacmanAgent.gameSeconds = function () {
    return playFrames / 60;
  };

  // How often a decision actually lands, in game time. Starts at 0.1s (the
  // default poll) and becomes a running average of the gap between decisions:
  // new = 0.8 * previous + 0.2 * this gap. A long pause is not a sample.
  var DECISION_INTERVAL_START_MS = 100;
  var lastDecisionGameS = null;
  pacmanAgent.decisionIntervalMs = DECISION_INTERVAL_START_MS;
  var noteDecisionGap = function () {
    var nowS = pacmanAgent.gameSeconds();
    if (lastDecisionGameS != null) {
      var gapMs = (nowS - lastDecisionGameS) * 1000;
      if (gapMs > 0 && gapMs < 5000) {
        pacmanAgent.decisionIntervalMs =
          pacmanAgent.decisionIntervalMs * 0.8 + gapMs * 0.2;
      }
    }
    lastDecisionGameS = nowS;
  };

  // ---- decision history (03 sends the tail of this to the model) ---------

  var HISTORY_KEPT = 12; // kept locally; settings.history are SENT
  var history = [];
  pacmanAgent.history = history;

  // what happened to a held turn decision (wording sent to the model)
  var OUTCOMES = {
    held: "still held — no intersection reached yet",
    executed: "went through (turn made)",
    walled:
      "did NOT go through (no such opening at the intersection — consumed there)",
    replaced: "did NOT go through (a later decision replaced it first)",
    reset: "did NOT go through (game inputs were reset)",
  };
  pacmanAgent.describeDecisionOutcome = function (outcome) {
    return OUTCOMES[outcome] || String(outcome || "");
  };

  // ---- the held turn ------------------------------------------------------

  var pending = null; // { dirEnum, fromX, fromY, entry } while a turn is held

  var settle = function (p, outcome) {
    p.entry.outcome = outcome;
    if (pending === p) {
      pending = null;
      pacmanAgent.pendingDecision = null;
    }
  };

  // does this tile give pac-man (heading 'heading') a choice beyond going on?
  // (same test the intersection walk in 03 uses)
  var isDecisionTile = function (tx, ty, heading) {
    var openings = 0;
    for (var e = 0; e < 4; e++) {
      if (e == rotateAboutFace(heading)) continue;
      var d = {};
      setDirFromEnum(d, e);
      var ox = tx + d.x;
      var oy = ty + d.y;
      if (ox < 0) ox += map.numCols;
      else if (ox >= map.numCols) ox -= map.numCols;
      if (map.isFloorTile(ox, oy)) openings++;
    }
    return openings > 1;
  };

  // Consume the held turn. Runs once per game frame (see installHook): a
  // 10 Hz poller can skip tiles — pac-man covers ~1 tile per tick — so the
  // "reached the next intersection" test has to be per-frame, not per-poll.
  var consumePending = function () {
    if (!pending) return;
    var p = pending;
    // the game reset its inputs (new round): nothing to hold on to
    if (pacman.inputDirEnum == undefined) {
      settle(p, "reset");
      return;
    }
    // the turn went through: the game steered pac-man onto the decision's heading
    if (pacman.dirEnum == p.dirEnum) {
      settle(p, "executed");
      pacman.clearInputDir(p.dirEnum); // release the "held key"
      return;
    }
    // pac-man moved off the decision tile and is standing on an intersection
    // where the turn was NOT possible: the decision is consumed, per the rules
    if (
      (pacman.tile.x != p.fromX || pacman.tile.y != p.fromY) &&
      isDecisionTile(pacman.tile.x, pacman.tile.y, pacman.dirEnum)
    ) {
      settle(p, "walled");
      pacman.clearInputDir(p.dirEnum);
    }
  };

  // Wrap the player's own steer() (called once per frame from Actor.update)
  // so consumePending runs every frame. The wrapper only reads state and
  // releases the held input on consumption — it cannot affect the game
  // otherwise, and it is never uninstalled (it no-ops without a pending).
  // In fixed mode it also counts out the poll boundary in game frames and
  // fires the freeze-and-ask cycle there (see fixedPoll).
  var hookInstalled = false;
  var installHook = function () {
    if (hookInstalled || typeof pacman == "undefined") return;
    if (typeof pacman.steer != "function") return;
    hookInstalled = true;
    var orig = pacman.steer;
    pacman.steer = function () {
      playFrames++;
      var r = orig.apply(this, arguments);
      try {
        consumePending();
      } catch (e) {
        /* never let the agent break a frame */
      }
      try {
        fixedPoll(false);
      } catch (e) {
        /* never let the agent break a frame */
      }
      return r;
    };
  };

  // ---- fixed mode: freeze the game while a decision is in flight ----------

  var agentHold = false; // we froze the game for a fixed-rate poll
  var holdStart = 0; // wall-clock ms the freeze started
  var lastHoldMs = 0; // wall-clock ms the last freeze lasted
  var lastPollT = 0; // game seconds the last fixed-rate poll fired at

  // Every executive.togglePause() call is counted so the agent can tell
  // whether the pause flag changed hands while a freeze was out (the End
  // key, the in-game menu's new game, and switchState's auto-unpause all
  // toggle it). If it did, the game already resumed (or re-froze on the
  // user's behalf) and the agent must NOT toggle it again — otherwise a
  // stale release would un-pause a pause the user meant to keep.
  var pauseVersion = 0;
  var holdVersion = -1; // pauseVersion right after OUR togglePause
  var executivePatched = false;
  var patchExecutive = function () {
    if (executivePatched) return;
    if (
      typeof executive == "undefined" ||
      typeof executive.togglePause != "function"
    )
      return;
    executivePatched = true;
    var orig = executive.togglePause;
    executive.togglePause = function () {
      pauseVersion++;
      return orig.call(executive);
    };
  };

  var pauseForPoll = function () {
    if (agentHold) return;
    agentHold = true;
    holdStart = Date.now();
    executive.togglePause(); // freezes state updates; drawing continues
    holdVersion = pauseVersion;
  };

  // thaw after a fixed-rate poll — only if the pause is still ours
  var releaseHold = function () {
    if (!agentHold) return;
    agentHold = false;
    lastHoldMs = Date.now() - holdStart;
    if (pauseVersion == holdVersion && executive.isPaused()) {
      executive.togglePause();
    }
  };

  var isFixed = function () {
    return pacmanAgent.settings.mode == "fixed";
  };

  // The console is fed from here; 06-ui.js replaces these to also feed the
  // log panel (it captures the originals before replacing).
  var baseLog = pacmanAgent.log;
  pacmanAgent.logDecision = function (d) {
    if (!pacmanAgent.settings.verbose) return;
    baseLog(
      "decision: '%s' (%s, p=%s, confidence=%s) in %dms (ewma %dms) — #%d",
      d.choice,
      d.kind,
      d.probability == null ? "?" : d.probability.toFixed(2),
      d.confidence == null ? "?" : d.confidence.toFixed(2),
      d.ms,
      pacmanAgent.latencyEwmaMs || 0,
      d.num,
    );
  };
  pacmanAgent.logError = function (msg) {
    baseLog(msg);
  };

  var canPoll = function () {
    return (
      typeof state != "undefined" &&
      state == playState &&
      !executive.isPaused() &&
      !inGameMenu.isOpen() &&
      !vcr.isSeeking()
    );
  };

  // error logging, throttled to at most one line every 10 seconds
  var throttledLog = function (msg) {
    var now = Date.now();
    if (now - lastErrorAt > 10000) {
      lastErrorAt = now;
      pacmanAgent.logError(msg);
    }
  };

  // ---- apply an answer -----------------------------------------------------

  var applyAnswer = function (res) {
    if (!running) return; // an answer landing after stop() is not applied
    var resolved = pacmanAgent.resolveOutput
      ? pacmanAgent.resolveOutput(res.answers)
      : null;
    if (!resolved) {
      throttledLog(
        "response had no usable answer (" +
          (errors + 1) +
          " so far): " +
          JSON.stringify(res.raw).slice(0, 120),
      );
      return;
    }
    var D = resolved.dirEnum;
    decisions++;
    noteDecisionGap();

    var heading =
      pacman.dirEnum != undefined ? pacman.dirEnum : pacman.nextDirEnum;
    if (heading == undefined) heading = DIR_LEFT;
    var kind =
      D == heading
        ? "straight"
        : D == rotateAboutFace(heading)
          ? "uturn"
          : "turn";

    // a still-held turn that never reached an intersection: replaced now
    if (pending) settle(pending, "replaced");

    var entry = {
      t: pacmanAgent.gameSeconds(),
      dir: resolved.dirName,
      summary: resolved.summary,
      kind: kind,
      outcome: kind == "turn" ? "held" : "instant",
    };
    history.push(entry);
    if (history.length > HISTORY_KEPT) history.shift();

    lastChoice = {
      num: decisions,
      choice: resolved.summary
        ? resolved.summary + " → " + resolved.dirName
        : resolved.dirName,
      kind: kind,
      probability: resolved.probability,
      confidence: resolved.confidence,
      ms: res.ms,
    };

    if (kind == "turn") {
      pending = {
        dirEnum: D,
        fromX: pacman.tile.x,
        fromY: pacman.tile.y,
        entry: entry,
      };
      pacmanAgent.pendingDecision = { dir: resolved.dirName, sinceT: entry.t };
    } else {
      pacmanAgent.pendingDecision = null;
    }

    if (typeof state != "undefined" && state == playState) {
      // through the game's own steering, exactly like the arrow keys:
      // straight/u-turn take effect immediately; the game holds a turn until
      // it can be made (and consumePending consumes it at the next
      // intersection, even when it can't be made there)
      pacman.setInputDir(D);
    }
    pacmanAgent.logDecision(lastChoice);
  };

  // ---- the poll -------------------------------------------------------------

  // send one request; onDone runs when the answer (or the failure) landed —
  // fixed mode thaws the game there. Single-flight: poll/fixedPoll both
  // check inFlight first, so at most ONE prompt is ever out.
  var sendNow = function (onDone) {
    var req;
    try {
      req = pacmanAgent.buildRequest();
    } catch (e) {
      throttledLog("failed to build the request: " + ((e && e.message) || e));
      if (onDone) onDone();
      return;
    }
    if (!req) {
      if (onDone) onDone();
      return;
    }
    inFlight = 1;
    flightStart = Date.now();
    requests++;
    // let the UI panel show exactly what the model was asked
    if (pacmanAgent.onViewRequest) {
      pacmanAgent.onViewRequest(req.state, req.questions, req.images);
    }
    pacmanAgent
      .ask(req.state, req.questions, req.images)
      .then(function (res) {
        inFlight = 0;
        flightStart = 0;
        if (pacmanAgent.onViewAnswer) {
          pacmanAgent.onViewAnswer(res.raw);
        }
        applyAnswer(res);
        if (onDone) onDone();
      })
      .catch(function (err) {
        inFlight = 0;
        flightStart = 0;
        errors++;
        throttledLog(
          "request failed (" +
            errors +
            " total): " +
            ((err && err.message) || err),
        );
        if (onDone) onDone();
      });
  };

  // realtime tick — wall-clock timer; the answer is applied whenever it
  // lands, the game never stops
  var poll = function () {
    if (!running) return;
    if (inFlight > 0) return; // ONE prompt in flight — never more
    if (!canPoll()) return;
    sendNow(null);
  };

  // fixed-mode tick — called once per game frame from the steer hook. When
  // a full poll period of PLAY time has elapsed, freeze the game, ask, and
  // thaw on the answer: the decision always lands on time in game terms.
  // force=true skips the boundary check (start of a run).
  var fixedPoll = function (force) {
    if (!isFixed() || !running) return;
    if (inFlight > 0 || agentHold) return;
    if (!canPoll()) return;
    var t = playFrames / 60;
    if (!force && t - lastPollT + 1e-9 < 1 / pacmanAgent.settings.hz) return;
    lastPollT = t;
    pauseForPoll();
    sendNow(releaseHold);
  };

  var setIntervalRate = function () {
    if (intervalId) clearInterval(intervalId);
    intervalId = 0;
    if (!running || !isFixed()) return; // fixed mode has no wall-clock timer
    intervalId = setInterval(poll, Math.round(1000 / pacmanAgent.settings.hz));
  };

  // ---- start / stop ----------------------------------------------------------

  pacmanAgent.start = function () {
    if (running) return;
    running = true;
    installHook();
    patchExecutive();
    decisions = 0;
    errors = 0;
    requests = 0;
    lastChoice = null;
    pending = null;
    pacmanAgent.decisionIntervalMs = DECISION_INTERVAL_START_MS;
    lastDecisionGameS = null;
    pacmanAgent.pendingDecision = null;
    inFlight = 0;
    flightStart = 0;
    agentHold = false;
    lastHoldMs = 0;
    lastPollT = pacmanAgent.gameSeconds();
    pacmanAgent.log("AI player started — " + pacmanAgent.describe());
    if (isFixed())
      fixedPoll(true); // freeze → ask → thaw, right now
    else {
      setIntervalRate();
      poll(); // fire immediately
    }
  };

  pacmanAgent.stop = function () {
    if (!running) return;
    running = false;
    if (intervalId) clearInterval(intervalId);
    intervalId = 0;
    releaseHold(); // never leave the game frozen behind us
    if (pending) settle(pending, "reset");
    pending = null;
    pacmanAgent.pendingDecision = null;
    if (typeof pacman != "undefined") {
      pacman.clearInputDir(undefined); // release the "held key"
    }
    pacmanAgent.log("AI player stopped (" + decisions + " decisions applied)");
  };

  pacmanAgent.toggle = function () {
    if (running) pacmanAgent.stop();
    else pacmanAgent.start();
  };

  // change the poll rate (applies immediately, persists)
  pacmanAgent.setHz = function (hz) {
    if (!(hz > 0)) return;
    pacmanAgent.settings.hz = hz;
    pacmanAgent.save();
    if (running) setIntervalRate();
    pacmanAgent.log("poll rate set to %d Hz", hz);
  };

  // switch the decision mode (applies immediately, persists)
  pacmanAgent.setMode = function (mode) {
    if (mode != "realtime" && mode != "fixed") return;
    if (pacmanAgent.settings.mode == mode) return;
    pacmanAgent.settings.mode = mode;
    pacmanAgent.save();
    if (running) {
      if (mode == "realtime") {
        releaseHold(); // thaw if we were holding
        setIntervalRate();
        poll(); // fire immediately
      } else {
        if (intervalId) clearInterval(intervalId);
        intervalId = 0;
        releaseHold();
        lastPollT = pacmanAgent.gameSeconds(); // fresh boundary
        fixedPoll(true); // freeze → ask → thaw, right now
      }
    }
    pacmanAgent.log(
      "decision mode → " +
        (mode == "fixed"
          ? "fixed rate (game freezes per decision)"
          : "realtime (game never stops)"),
    );
  };

  pacmanAgent.isRunning = function () {
    return running;
  };

  pacmanAgent.status = function () {
    var lat = pacmanAgent.latencyEwmaMs || pacmanAgent.lastLatencyMs || null;
    var n = Math.max(
      1,
      Math.min(10, Math.round(pacmanAgent.settings.history || 4)),
    );
    return {
      running: running,
      busy: inFlight > 0,
      inFlight: inFlight,
      mode: pacmanAgent.settings.mode,
      // fixed-mode freeze state: while holding, the game is frozen and the
      // in-flight request's wall-clock age is the freeze cost so far
      holding: agentHold,
      holdMs: agentHold && holdStart ? Date.now() - holdStart : 0,
      lastHoldMs: lastHoldMs,
      decisions: decisions,
      errors: errors,
      requests: requests,
      lastChoice: lastChoice,
      latencyMs: pacmanAgent.lastLatencyMs,
      latencyEwmaMs: pacmanAgent.latencyEwmaMs,
      // latency-health inputs, consumed by 06-ui.js to warn when the model
      // cannot keep up with the poll rate:
      intervalMs: 1000 / pacmanAgent.settings.hz, // one poll period
      effLatencyMs: lat, // sustained latency (ewma, falling back to last)
      inFlightMs: inFlight > 0 && flightStart ? Date.now() - flightStart : 0, // live age of the in-flight request
      pending: pending
        ? {
            dir: pacmanAgent.DIR_NAMES[pending.dirEnum],
            sinceT: pending.entry.t,
          }
        : null,
      history:
        history.length > n
          ? history.slice(history.length - n)
          : history.slice(),
      settings: pacmanAgent.settings,
    };
  };
})();
