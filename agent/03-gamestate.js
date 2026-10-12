//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 03 Game state serialization
//
// Turns the live game into one SystemOne request:
//   - the model input ('state'):
//       'text' mode: plain-sentence facts — position and passages from the
//                    current tile, each ghost in words (with a consequence
//                    clause when it is on pac-man's lane), passages from the
//                    next intersection — plus the recent decision history.
//                    NO ASCII maze: probing showed clef-flash does not read
//                    it (see 'Model comprehension' in README /
//                    dev/model_probe.ts), so it is not paid for.
//       'shot' mode: a downscaled annotated screenshot (base64 PNG) sent in
//                    the Clef 'images' extension, plus the same facts/history.
//   - the question: a real-time 'direction' choice (see buildQuestions):
//       current heading → continue straight (applies immediately)
//       opposite         → u-turn (applies immediately)
//       side direction   → turn, held until the next intersection, consumed
//                          there (replaced by any newer decision)
//
// Only real, current game state is sent — never extrapolated or synthetic
// data. The question tells the model that its answers land late and that it
// must plan ahead; accounting for request latency is the model's job.

(function () {
  // direction names indexed by the DIR_* enums from direction.js
  // (DIR_UP=0, DIR_LEFT=1, DIR_DOWN=2, DIR_RIGHT=3)
  var DIR_NAMES = ["up", "left", "down", "right"];
  var DIR_ENUMS = {
    up: DIR_UP,
    left: DIR_LEFT,
    down: DIR_DOWN,
    right: DIR_RIGHT,
  };
  pacmanAgent.DIR_NAMES = DIR_NAMES;
  pacmanAgent.dirEnumByName = DIR_ENUMS;

  // the direction pac-man is committed to
  var headingEnum = function () {
    if (typeof pacman == "undefined") return DIR_LEFT;
    if (pacman.dirEnum != undefined) return pacman.dirEnum;
    if (pacman.nextDirEnum != undefined) return pacman.nextDirEnum;
    return DIR_LEFT;
  };

  // ---- the walk: the next intersection ahead of Pac-Man ------------------
  //
  // Steps forward one tile at a time along the current heading until
  // reaching a tile where Pac-Man can do something other than continue
  // straight (or a wall). That tile is the next decision point. Tunnels
  // wrap. (Marked 'X' in the maze and described in the stats.)
  pacmanAgent.findNextIntersection = function () {
    var dirEnum = headingEnum();

    var dir = {};
    setDirFromEnum(dir, dirEnum);

    var cap = map.numCols + map.numRows; // a walk can never exceed this

    var tx = pacman.tile.x;
    var ty = pacman.tile.y;
    var steps = 0;

    while (steps < cap) {
      var nx = tx + dir.x;
      var ny = ty + dir.y;
      if (nx < 0)
        nx += map.numCols; // tunnel wrap
      else if (nx >= map.numCols) nx -= map.numCols;
      if (!map.isFloorTile(nx, ny)) break; // wall ahead: decide here
      tx = nx;
      ty = ny;
      steps++;

      // any open passage other than straight ahead means a choice here
      var openings = 0;
      for (var e = 0; e < 4; e++) {
        if (e == rotateAboutFace(dirEnum)) continue;
        var d = {};
        setDirFromEnum(d, e);
        var ox = tx + d.x;
        var oy = ty + d.y;
        if (ox < 0) ox += map.numCols;
        else if (ox >= map.numCols) ox -= map.numCols;
        if (map.isFloorTile(ox, oy)) openings++;
      }
      if (openings > 1) break; // intersection reached
    }

    // the directions open at the decision tile
    var options = [];
    for (var e = 0; e < 4; e++) {
      var d = {};
      setDirFromEnum(d, e);
      var ox = tx + d.x;
      var oy = ty + d.y;
      if (ox < 0) ox += map.numCols;
      else if (ox >= map.numCols) ox -= map.numCols;
      if (map.isFloorTile(ox, oy)) options.push(e);
    }

    return {
      tile: { x: tx, y: ty },
      steps: steps,
      dirEnum: dirEnum,
      options: options,
    };
  };

  // shortest wrapped horizontal distance from pacman's column to x
  var wrapDx = function (x) {
    var d = (x - pacman.tile.x) % map.numCols;
    if (d > map.numCols / 2) d -= map.numCols;
    if (d < -map.numCols / 2) d += map.numCols;
    return d;
  };

  // ---- stats (shared by the text and screenshot states) ------------------
  //
  // These are PROSE, deliberately. Probing clef-flash (agent/dev/model_probe.ts)
  // showed it does not read the ASCII maze (it will answer 'straight' into a
  // wall for as long as the wall is only drawn), and ignores telegraphic
  // coordinates — but it does react to plain declarative sentences about its
  // immediate situation. Everything below is still current state only.

  // "up open, left blocked (wall), down open, right open"
  var passagesAt = function (tx, ty) {
    var parts = [];
    for (var e = 0; e < 4; e++) {
      var d = {};
      setDirFromEnum(d, e);
      var ox = tx + d.x;
      var oy = ty + d.y;
      if (ox < 0) ox += map.numCols;
      else if (ox >= map.numCols) ox -= map.numCols;
      parts.push(
        DIR_NAMES[e] + (map.isFloorTile(ox, oy) ? " open" : " blocked (wall)"),
      );
    }
    return parts.join(", ");
  };

  // "2 tiles to your left" / "3 tiles above you and 1 tile to your right"
  var offsetWords = function (dx, dy) {
    if (dx == 0 && dy == 0) return "on your tile";
    var parts = [];
    if (dy != 0)
      parts.push(
        Math.abs(dy) +
          " tile" +
          (Math.abs(dy) == 1 ? "" : "s") +
          (dy < 0 ? " above you" : " below you"),
      );
    if (dx != 0)
      parts.push(
        Math.abs(dx) +
          " tile" +
          (Math.abs(dx) == 1 ? "" : "s") +
          (dx > 0 ? " to your right" : " to your left"),
      );
    return parts.join(" and ");
  };

  // Is the ghost on pacman's path — same lane, ahead, no wall/corner in
  // between (walking the heading lane up to 8 tiles)? Returns the distance in
  // tiles, or 0. (Used to phrase the ghost fact with its consequence — see
  // statsLines: the model_probe experiments showed clef-flash acts on
  // explicitly-stated consequences, not on bare offsets.)
  var ghostPathDistance = function (g) {
    var hd = {};
    setDirFromEnum(hd, headingEnum());
    var tx = pacman.tile.x;
    var ty = pacman.tile.y;
    for (var s = 1; s <= 8; s++) {
      var nx = tx + hd.x * s;
      var ny = ty + hd.y * s;
      if (nx < 0) nx += map.numCols;
      else if (nx >= map.numCols) nx -= map.numCols;
      if (!map.isFloorTile(nx, ny)) break; // lane ends (wall/corner) before the ghost
      if (nx == g.tile.x && ny == g.tile.y) return s;
    }
    return 0;
  };

  var statsLines = function (inter) {
    var lines = [];
    lines.push(
      "You are '@' at x=" +
        pacman.tile.x +
        ", y=" +
        pacman.tile.y +
        ", heading " +
        DIR_NAMES[headingEnum()] +
        "." +
        (pacman.stopped
          ? " You are STOPPED: you are pressed against the wall ahead and will not move until you turn."
          : ""),
    );
    lines.push(
      "Passages from your tile: " +
        passagesAt(pacman.tile.x, pacman.tile.y) +
        ".",
    );
    lines.push(
      "Level " +
        level +
        ", score " +
        getScore() +
        ", " +
        map.dotsLeft() +
        " dots left. Ghosts kill you on touch unless frightened.",
    );
    lines.push(
      "Ghost mode: " +
        (ghostCommander.getCommand() == GHOST_CMD_CHASE
          ? "chase — the hunting ghosts are coming for you"
          : "scatter — the hunting ghosts head to their corners") +
        ".",
    );
    for (var i = 0; i < 4; i++) {
      var g = ghosts[i];
      var dx = wrapDx(g.tile.x);
      var dy = g.tile.y - pacman.tile.y;
      var stateDesc = g.scared
        ? "frightened and edible (you can eat it)"
        : g.mode == GHOST_GOING_HOME || g.mode == GHOST_ENTERING_HOME
          ? "eaten, heading home (harmless)"
          : g.mode == GHOST_OUTSIDE
            ? "hunting you (deadly on touch)"
            : "inside the ghost house (harmless for now)";
      var hunting = !g.scared && g.mode == GHOST_OUTSIDE;
      var pathDist = hunting ? ghostPathDistance(g) : 0;
      if (pathDist) {
        var side =
          dy == 0
            ? dx < 0
              ? "to your left"
              : dx > 0
                ? "to your right"
                : "ahead of you"
            : dx == 0
              ? dy < 0
                ? "above you"
                : "below you"
              : offsetWords(dx, dy);
        lines.push(
          g.name +
            " is hunting you and is directly in your path, " +
            pathDist +
            " tile" +
            (pathDist == 1 ? "" : "s") +
            " ahead of you (" +
            side +
            "); continuing straight ahead leads straight into " +
            (g.name == "blinky" ? "him" : "her") +
            ".",
        );
      } else {
        lines.push(
          g.name +
            " is " +
            stateDesc +
            " and is " +
            offsetWords(dx, dy) +
            ", heading " +
            DIR_NAMES[g.dirEnum] +
            ".",
        );
      }
    }
    lines.push(
      "Your next intersection X is at x=" +
        inter.tile.x +
        ", y=" +
        inter.tile.y +
        " — " +
        (inter.steps == 0
          ? "your own tile"
          : inter.steps +
            " tile" +
            (inter.steps == 1 ? "" : "s") +
            " ahead along your heading") +
        ". Passages from X: " +
        passagesAt(inter.tile.x, inter.tile.y) +
        ".",
    );
    if (energizer.isActive()) {
      lines.push(
        "An energizer is active: the hunting ghosts are frightened and edible until it expires.",
      );
    }
    return lines;
  };

  // ---- decision history (kept by 04-controller) ----------------------------
  //
  // Sent with every request: the last settings.history decisions, each with
  // its timestamp (seconds from the start of the game) and whether the
  // action went through — so the model can judge its own latency and plan.

  var historyCount = function () {
    var n = pacmanAgent.settings.history;
    if (!(n > 0)) n = 4;
    return Math.max(1, Math.min(10, Math.round(n)));
  };

  var historyLines = function () {
    var h = pacmanAgent.history || [];
    var n = historyCount();
    var tail = h.length > n ? h.slice(h.length - n) : h;
    var lines = [
      "Your recent decisions (t = seconds from the start of the game; newest last;",
      "'went through' = the action actually happened):",
    ];
    if (!tail.length) {
      lines.push("- none yet");
      return lines;
    }
    for (var i = 0; i < tail.length; i++) {
      var e = tail[i];
      lines.push(
        "- t=" +
          e.t.toFixed(1) +
          "s: " +
          e.dir +
          " — " +
          (e.kind == "turn"
            ? "turn for the next intersection, " +
              pacmanAgent.describeDecisionOutcome(e.outcome)
            : e.kind + ", applied instantly (went through)"),
      );
    }
    return lines;
  };

  // ---- text mode: prose facts + history (NO maze) ------------------------
  //
  // The maze was removed deliberately: the model_probe experiments showed
  // clef-flash answers identically with the maze present, deleted, or turned
  // into garbage — it grounds on the sentences, and the maze bytes were pure
  // latency (state size is the latency; see README 'Reducing latency').

  pacmanAgent.buildTextState = function (inter) {
    var lines = [];
    lines.push("PAC-MAN. Facts about the game follow as plain sentences.");
    var stats = statsLines(inter);
    for (var s = 0; s < stats.length; s++) lines.push(stats[s]);

    lines.push("");
    var hist = historyLines();
    for (var e = 0; e < hist.length; e++) lines.push(hist[e]);

    return lines.join("\n");
  };

  // ---- shot mode: annotated screenshot ------------------------------------
  //
  // Copies the game canvas to a small offscreen canvas, labels the grid
  // coordinates, and marks the intersection, so the image can be read like
  // the text map. Map pixel mx lands at canvas pixel
  // (mapMargin + mapPad + mx) * renderScale (see renderers.js).
  // settings.shotWidth bounds the image size — vision tokens scale with
  // pixels, so this bounds the request latency too.

  pacmanAgent.captureScreenshot = function (inter) {
    var canvas = document.getElementById("canvas");
    if (!canvas || !canvas.width || !canvas.height) return null;
    var off = document.createElement("canvas");
    var w = Math.max(112, Math.min(896, pacmanAgent.settings.shotWidth || 320));
    off.width = w;
    off.height = Math.max(1, Math.round((canvas.height * w) / canvas.width));
    var octx = off.getContext("2d");
    octx.drawImage(canvas, 0, 0, off.width, off.height);

    var s = renderScale || 1;
    var f = off.width / canvas.width; // canvas px -> annotation px
    var toX = function (mx) {
      return (mapMargin + mapPad + mx) * s * f;
    };
    var toY = function (my) {
      return (mapMargin + mapPad + my) * s * f;
    };

    var fontPx = Math.max(8, Math.round(3 * s * f * 2));
    octx.font = fontPx + "px monospace";
    octx.fillStyle = "#fff";
    octx.textAlign = "center";
    octx.textBaseline = "bottom";

    // column labels above the maze
    for (var x = 0; x < map.numCols; x += 4) {
      octx.fillText(String(x), toX(x * tileSize + midTile.x), toY(-tileSize));
    }
    // row labels left of the maze
    octx.textAlign = "right";
    for (var y = 0; y < map.numRows; y += 4) {
      octx.fillText(String(y), toX(-tileSize), toY(y * tileSize + midTile.y));
    }

    // mark the intersection with a red square
    if (inter) {
      var cx = toX(inter.tile.x * tileSize + midTile.x);
      var cy = toY(inter.tile.y * tileSize + midTile.y);
      var half = Math.max(2, Math.round((tileSize * s * f) / 2));
      octx.strokeStyle = "#FF0000";
      octx.lineWidth = Math.max(1, Math.round(s * f));
      octx.strokeRect(cx - half, cy - half, half * 2, half * 2);
    }

    return {
      image: off.toDataURL("image/png").replace(/^data:image\/png;base64,/, ""),
      width: off.width,
      height: off.height,
    };
  };

  // ---- the question ------------------------------------------------------

  pacmanAgent.buildQuestions = function (inter) {
    var heading = headingEnum();
    var lat = Math.round(pacmanAgent.latencyEwmaMs || 0);
    var criteria = {};
    for (var i = 0; i < 4; i++) {
      var name = DIR_NAMES[i];
      if (i == heading)
        criteria[name] =
          "keep going straight ahead (your current heading) — applied immediately";
      else if (i == rotateAboutFace(heading))
        criteria[name] =
          "u-turn: reverse and travel " + name + " — applied immediately";
      else
        criteria[name] =
          "turn " +
          name +
          " — held and applied at the next intersection you reach (consumed there even if it has no " +
          name +
          " opening; replaced by any newer decision)";
    }
    var latencySentence = lat
      ? "Your answers have been arriving about " +
        lat +
        " ms after you see the state, and Pac-Man keeps moving the whole time — decide for the intersections he is APPROACHING, planning several turns ahead, not for the exact state shown. "
      : "Your answers arrive after a delay and Pac-Man keeps moving meanwhile — decide for the intersections he is APPROACHING, planning several turns ahead, not for the exact state shown. ";
    return {
      direction: {
        type: "choice",
        instructions:
          "You are Pac-Man in a live game. " +
          latencySentence +
          "Eat pellets to clear the level, avoid ghosts (they kill on touch unless frightened), and don't corner yourself. Which direction should Pac-Man travel?",
        criteria: criteria,
      },
    };
  };

  // ---- the request -------------------------------------------------------

  pacmanAgent.buildRequest = function () {
    if (!map) return null;
    var inter = pacmanAgent.findNextIntersection();
    if (!inter || inter.options.length == 0) return null;

    var provider = pacmanAgent.getProvider();
    var wantShot = pacmanAgent.settings.stateMode == "shot";
    if (wantShot && !provider.vision) {
      if (!pacmanAgent._noticedNoVision) {
        pacmanAgent._noticedNoVision = true;
        pacmanAgent.log(
          "the " +
            pacmanAgent.settings.provider +
            " provider does not accept images — using the text state instead",
        );
      }
      wantShot = false;
    }

    var questions = pacmanAgent.buildQuestions(inter);

    if (wantShot) {
      var shot = pacmanAgent.captureScreenshot(inter);
      if (shot) {
        var s = [
          "PAC-MAN, seen from above in the attached screenshot. The red square marks your next intersection (X).",
          "Facts about the game follow as plain sentences.",
        ];
        s = s.concat(statsLines(inter));
        s.push("");
        s = s.concat(historyLines());
        return {
          state: s.join("\n"),
          questions: questions,
          images: [shot.image],
        };
      }
      // else fall through to text
    }

    return {
      state: pacmanAgent.buildTextState(inter),
      questions: questions,
      images: null,
    };
  };
})();
