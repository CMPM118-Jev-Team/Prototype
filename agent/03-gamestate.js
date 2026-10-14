//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 03 Game state serialization
//
// Turns the live game into one SystemOne request:
//   - the model input ('state'), chosen by settings.stateMode (u / the left
//     panel / ?state=). Every mode describes the SAME live frame. The cuts
//     exist so a Jev-like model can be tried against different shapes:
//       text       prose facts + decision history (the baseline)
//       shot       annotated screenshot + that same prose
//       doom       Doom-demo JSON: measurement legend, player, heading-
//                  relative walls, velocity, every ghost, the nearby items,
//                  the next intersection, and recent decisions
//       doom-frame that live frame without the legend or the history
//       doom-local the same, but anything farther than 8 tiles or behind a
//                  wall is listed as out of view instead of in front of you
//       doom-prose the doom-frame facts as sentences
//       brief      heading, walls, the next intersection, one line per ghost
//     NO ASCII maze: probing showed clef-flash does not read it (see
//     'Model comprehension' in README / dev/model_probe.ts).
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

  // ---- swappable state forms ----------------------------------------------
  //
  // Doom-demo shapes of this same frame. Distance words are guidelines, not
  // measurements taken from one snapshot:
  //   contact  1 tile or closer   touch range
  //   close    2 to 4 tiles       a turn or two away
  //   medium   5 to 8 tiles       a meaningful run
  //   far      9 tiles or more    distant
  // Bearing is relative to the current heading: 0 straight ahead, positive
  // left, negative right. "In view" (doom-local) means within 8 tiles and a
  // clear straight line of floor; the position given is where it is now.

  var VIEW_TILES = 8;

  pacmanAgent.stateModes = [
    { id: "text", label: "prose" },
    { id: "shot", label: "screenshot" },
    { id: "doom", label: "doom full" },
    { id: "doom-frame", label: "doom frame" },
    { id: "doom-local", label: "doom in view" },
    { id: "doom-prose", label: "doom sentences" },
    { id: "brief", label: "brief" },
  ];
  pacmanAgent.stateModeIds = [];
  for (var mi = 0; mi < pacmanAgent.stateModes.length; mi++) {
    pacmanAgent.stateModeIds.push(pacmanAgent.stateModes[mi].id);
  }

  var round1 = function (n) {
    return Math.round(n * 10) / 10;
  };
  var round2 = function (n) {
    return Math.round(n * 100) / 100;
  };
  var round4 = function (n) {
    return Math.round(n * 10000) / 10000;
  };

  var rangeBracket = function (dist) {
    if (dist <= 1) return "contact";
    if (dist <= 4) return "close";
    if (dist <= 8) return "medium";
    return "far";
  };

  // 0 ahead, positive left, negative right, ±180 behind.
  var bearingLabel = function (deg) {
    var a = Math.abs(deg);
    if (a <= 20) return "dead ahead";
    if (a >= 160) return "behind";
    var side = deg > 0 ? "left" : "right";
    if (a >= 110) return "behind " + side;
    if (a >= 70) return side;
    return "ahead " + side;
  };

  var openingWord = function (dirEnum, tx, ty) {
    var d = {};
    setDirFromEnum(d, dirEnum);
    var x = tx + d.x;
    var y = ty + d.y;
    if (x < 0) x += map.numCols;
    else if (x >= map.numCols) x -= map.numCols;
    return map.isFloorTile(x, y) ? "open" : "wall";
  };

  // Floor all the way to the tile, not counting the tile itself. A wrapped
  // column is not a straight sightline, so the caller skips this when the
  // short horizontal distance goes through a tunnel.
  var clearLine = function (x0, y0, x1, y1) {
    if (x0 == x1 && y0 == y1) return true;
    var dx = Math.abs(x1 - x0);
    var dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1;
    var sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    var x = x0;
    var y = y0;
    var guard = dx + dy + 2;
    while (guard-- > 0) {
      var e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
      if (x == x1 && y == y1) return true;
      if (x < 0 || y < 0 || x >= map.numCols || y >= map.numRows) return false;
      if (!map.isFloorTile(x, y)) return false;
    }
    return false;
  };

  // Where a tile sits relative to Pac-Man. _dist and in_view are for the
  // splitter; they are not copied into the state.
  var placeOf = function (tx, ty) {
    var rawDx = tx - pacman.tile.x;
    var dx = wrapDx(tx);
    var dy = ty - pacman.tile.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var fwd = {};
    var left = {};
    var heading = headingEnum();
    setDirFromEnum(fwd, heading);
    setDirFromEnum(left, rotateLeft(heading));
    var ahead = dx * fwd.x + dy * fwd.y;
    var side = dx * left.x + dy * left.y;
    var deg =
      ahead == 0 && side == 0
        ? 0
        : Math.round((Math.atan2(side, ahead) * 180) / Math.PI);
    var wrapped = dx != rawDx;
    return {
      distance_tiles: round1(dist),
      range: rangeBracket(dist),
      bearing_degrees: deg,
      bearing_label: bearingLabel(deg),
      in_view:
        dist <= VIEW_TILES &&
        !wrapped &&
        clearLine(pacman.tile.x, pacman.tile.y, tx, ty),
      _dist: dist,
    };
  };

  var ghostCondition = function (g) {
    if (g.scared) return "frightened and edible";
    if (g.mode == GHOST_GOING_HOME || g.mode == GHOST_ENTERING_HOME)
      return "eaten, heading home, harmless";
    if (g.mode == GHOST_OUTSIDE) return "hunting, deadly on touch";
    return "in the ghost house, harmless for now";
  };

  // Sustained tiles/second from the 16-frame step pattern. The table is
  // read by briefly walking pacman.frames; it is put back before returning.
  var sustainedSpeed = function () {
    if (typeof turboMode != "undefined" && turboMode)
      return round2((2 * 60) / tileSize);
    var pattern = energizer.isActive() ? STEP_PACMAN_FRIGHT : STEP_PACMAN;
    var saved = pacman.frames;
    var sum = 0;
    var i;
    for (i = 0; i < 16; i++) {
      pacman.frames = i;
      var n = Number(pacman.getStepSizeFromTable(level, pattern));
      if (n > 0) sum += n;
    }
    pacman.frames = saved;
    return round2((sum / 16) * (60 / tileSize));
  };

  var currentSpeed = function () {
    if (pacman.stopped || pacman.eatPauseFramesLeft > 0) return 0;
    var n = Number(pacman.getNumSteps());
    if (!(n > 0)) return 0;
    return round2(n * (60 / tileSize));
  };

  var livesLeft = function () {
    if (extraLives == Infinity) return "unlimited";
    return extraLives + 1;
  };

  var energizedText = function () {
    if (!energizer.isActive()) return null;
    if (energizer.isFlash()) return "yes, flashing, about to end";
    return "yes, ghosts are edible";
  };

  var measurementBlock = function (local) {
    var hz = pacmanAgent.settings.hz || 10;
    var block = {
      map_unit: {
        name: "tile",
        pixels: tileSize,
        not: ["inches", "feet", "meters", "miles"],
        player_size_tiles: 1,
      },
      distance_brackets: [
        {
          name: "contact",
          span: "1 tile or closer",
          meaning: "touch range; a hunting ghost here kills you",
        },
        {
          name: "close",
          span: "2 to 4 tiles",
          meaning: "nearby; a turn or two away",
        },
        {
          name: "medium",
          span: "5 to 8 tiles",
          meaning: "a meaningful run",
        },
        {
          name: "far",
          span: "9 tiles or more",
          meaning: "distant",
        },
      ],
      relative_bearing_degrees: {
        "0": "straight ahead",
        positive: "left",
        negative: "right",
        "+90": "direct left",
        "-90": "direct right",
        "±180": "behind",
      },
      tick_seconds: round4(1 / 60),
      movement_speed_tiles_per_second: sustainedSpeed(),
      accel_time_from_still_seconds: 0,
      accel_note:
        "Pac-Man is at full speed on the next tick, or stopped. There is no acceleration ramp.",
      control_rate: {
        ticks: Math.round(60 / hz),
        seconds: round2(1 / hz),
        controls_persist_across_decisions: true,
        note: "The chosen direction stays in effect until the next decision.",
      },
      controls: {
        channel: "direction",
        simultaneous: false,
        note: "One direction per decision. Straight and reverse apply at once; a side turn waits for the next intersection.",
      },
    };
    if (local)
      block.view =
        "In view means within 8 tiles and not blocked by a wall. Everything else is listed under remembered, at where it is right now.";
    return block;
  };

  var playerBlock = function () {
    return {
      heading: DIR_NAMES[headingEnum()],
      lives_left: livesLeft(),
      level: level,
      score: getScore(),
      dots_left: map.dotsLeft(),
      energized: energizedText(),
      status: pacman.stopped ? "stopped, pressed against the wall ahead" : null,
    };
  };

  var wallsBlock = function () {
    var h = headingEnum();
    var tx = pacman.tile.x;
    var ty = pacman.tile.y;
    return {
      left: openingWord(rotateLeft(h), tx, ty),
      ahead: openingWord(h, tx, ty),
      right: openingWord(rotateRight(h), tx, ty),
      behind: openingWord(rotateAboutFace(h), tx, ty),
    };
  };

  var velocityBlock = function () {
    return {
      speed_tiles_per_second: currentSpeed(),
      direction_degrees: 0,
      direction_label: "dead ahead",
    };
  };

  var intersectionBlock = function (inter) {
    var tx = inter.tile.x;
    var ty = inter.tile.y;
    return {
      tiles_ahead: inter.steps,
      up: openingWord(DIR_UP, tx, ty),
      left: openingWord(DIR_LEFT, tx, ty),
      down: openingWord(DIR_DOWN, tx, ty),
      right: openingWord(DIR_RIGHT, tx, ty),
    };
  };

  var withoutPrivate = function (src) {
    var o = {};
    for (var k in src) if (k != "in_view" && k != "_dist") o[k] = src[k];
    return o;
  };

  var collectEnemies = function () {
    var list = [];
    var i;
    for (i = 0; i < ghosts.length; i++) {
      var g = ghosts[i];
      var p = placeOf(g.tile.x, g.tile.y);
      var hunting = !g.scared && g.mode == GHOST_OUTSIDE;
      var pathDist = hunting ? ghostPathDistance(g) : 0;
      var rec = {
        label: g.name,
        kind: "ghost",
        status: ghostCondition(g),
        distance_tiles: p.distance_tiles,
        range: p.range,
        bearing_degrees: p.bearing_degrees,
        bearing_label: p.bearing_label,
        heading: DIR_NAMES[g.dirEnum],
        in_view: p.in_view,
      };
      if (pathDist) rec.tiles_ahead_on_your_path = pathDist;
      list.push(rec);
    }
    return list;
  };

  var pelletAt = function (p, label) {
    return {
      label: label,
      kind: "pellet",
      detail: map.dotsLeft() + " pellets left",
      distance_tiles: p.distance_tiles,
      range: p.range,
      bearing_degrees: p.bearing_degrees,
      bearing_label: p.bearing_label,
      in_view: p.in_view,
    };
  };

  var collectItems = function () {
    var items = [];
    var best = null;
    var bestDist = Infinity;
    var bestSeen = null;
    var bestSeenDist = Infinity;
    var y, x, tile, p;
    for (y = 0; y < map.numRows; y++) {
      for (x = 0; x < map.numCols; x++) {
        tile = map.getTile(x, y);
        if (tile == "o") {
          p = placeOf(x, y);
          items.push({
            label: "energizer",
            kind: "energizer",
            detail: "frightens every hunting ghost",
            distance_tiles: p.distance_tiles,
            range: p.range,
            bearing_degrees: p.bearing_degrees,
            bearing_label: p.bearing_label,
            in_view: p.in_view,
          });
        } else if (tile == ".") {
          p = placeOf(x, y);
          if (p._dist < bestDist) {
            bestDist = p._dist;
            best = pelletAt(p, "nearest pellet");
          }
          if (p.in_view && p._dist < bestSeenDist) {
            bestSeenDist = p._dist;
            bestSeen = pelletAt(p, "nearest pellet in sight");
          }
        }
      }
    }
    if (best) items.push(best);
    // The closest pellet can sit behind a wall. Keep the closest one you
    // can actually see as well, so the in-view list still has a pellet.
    if (bestSeen && (!best || !best.in_view)) items.push(bestSeen);
    if (typeof fruit != "undefined" && fruit && fruit.isPresent && fruit.isPresent()) {
      var fx = Math.floor(fruit.pixel.x / tileSize);
      var fy = Math.floor(fruit.pixel.y / tileSize);
      var info = fruit.getCurrentFruit ? fruit.getCurrentFruit() : null;
      p = placeOf(fx, fy);
      items.push({
        label: info && info.name ? info.name : "fruit",
        kind: "fruit",
        detail: info && info.points ? info.points + " points" : "bonus",
        distance_tiles: p.distance_tiles,
        range: p.range,
        bearing_degrees: p.bearing_degrees,
        bearing_label: p.bearing_label,
        in_view: p.in_view,
      });
    }
    return items;
  };

  var splitView = function (list) {
    var here = [];
    var gone = [];
    var i;
    for (i = 0; i < list.length; i++) {
      var rec = withoutPrivate(list[i]);
      if (list[i].in_view) here.push(rec);
      else {
        rec.last_seen = "now";
        rec.view = "out of view";
        gone.push(rec);
      }
    }
    return { here: here, gone: gone };
  };

  var publishAll = function (list) {
    var out = [];
    var i;
    for (i = 0; i < list.length; i++) out.push(withoutPrivate(list[i]));
    return out;
  };

  var decisionEntries = function () {
    var h = pacmanAgent.history || [];
    var n = historyCount();
    var tail = h.length > n ? h.slice(h.length - n) : h;
    var out = [];
    var i;
    for (i = 0; i < tail.length; i++) {
      var e = tail[i];
      out.push({
        t_seconds: round1(e.t),
        direction: e.dir,
        result:
          e.kind == "turn"
            ? "turn for the next intersection, " +
              (pacmanAgent.describeDecisionOutcome
                ? pacmanAgent.describeDecisionOutcome(e.outcome)
                : String(e.outcome || ""))
            : e.kind + ", applied instantly",
      });
    }
    return out;
  };

  var frameObject = function (inter, enemies, items) {
    return {
      player: playerBlock(),
      walls_relative_to_heading: wallsBlock(),
      velocity: velocityBlock(),
      enemies: enemies,
      items: items,
      next_intersection: intersectionBlock(inter),
    };
  };

  var jsonState = function (obj) {
    return JSON.stringify(obj, null, 2);
  };

  var sentencePlace = function (rec) {
    var s =
      rec.distance_tiles +
      " tiles (" +
      rec.range +
      "), bearing " +
      (rec.bearing_degrees > 0 ? "+" : "") +
      rec.bearing_degrees +
      " degrees (" +
      rec.bearing_label +
      ")";
    if (rec.tiles_ahead_on_your_path)
      s +=
        ". Directly on your path, " +
        rec.tiles_ahead_on_your_path +
        " tile" +
        (rec.tiles_ahead_on_your_path == 1 ? "" : "s") +
        " ahead; continuing straight runs into " +
        rec.label;
    return s;
  };

  var bracketSentence =
    "Contact is 1 tile or closer (touch range), close is 2 to 4 tiles, medium is 5 to 8, far is 9 or more. Bearing 0 is straight ahead, positive is left, negative is right.";

  var proseFrame = function (inter, enemies, items, brief) {
    var lines = [];
    var player = playerBlock();
    var walls = wallsBlock();
    var vel = velocityBlock();
    var cross = intersectionBlock(inter);
    lines.push(bracketSentence);
    lines.push(
      "You are Pac-Man, heading " +
        player.heading +
        (player.status ? ". You are " + player.status : "") +
        ".",
    );
    lines.push(
      "Relative to that heading: left " +
        walls.left +
        ", ahead " +
        walls.ahead +
        ", right " +
        walls.right +
        ", behind " +
        walls.behind +
        ".",
    );
    lines.push(
      vel.speed_tiles_per_second == 0
        ? "You are not moving."
        : "You are moving at " +
            vel.speed_tiles_per_second +
            " tiles per second, dead ahead.",
    );
    lines.push(
      "Your next intersection is " +
        (cross.tiles_ahead == 0
          ? "your own tile"
          : cross.tiles_ahead +
            " tile" +
            (cross.tiles_ahead == 1 ? "" : "s") +
            " ahead") +
        ". Passages there: up " +
        cross.up +
        ", left " +
        cross.left +
        ", down " +
        cross.down +
        ", right " +
        cross.right +
        ".",
    );
    var i;
    for (i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      lines.push(
        e.label +
          " is " +
          e.status +
          ", " +
          sentencePlace(e) +
          (brief ? "." : ", heading " + e.heading + "."),
      );
    }
    if (!brief) {
      for (i = 0; i < items.length; i++) {
        var it = items[i];
        lines.push(
          it.label +
            " (" +
            it.detail +
            ") is " +
            sentencePlace(it) +
            ".",
        );
      }
    }
    lines.push(
      "Level " +
        player.level +
        ", score " +
        player.score +
        ", " +
        player.lives_left +
        " lives left, " +
        player.dots_left +
        " pellets left. " +
        (player.energized ? "Energized: " + player.energized + "." : "Ghosts are not frightened."),
    );
    return lines.join("\n");
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

  // The form named by settings.stateMode. Unknown names fall back to prose.
  pacmanAgent.buildFormState = function (inter, mode) {
    var enemies = collectEnemies();
    var items = collectItems();
    if (mode == "doom") {
      var full = frameObject(inter, publishAll(enemies), publishAll(items));
      full.recent_decisions = decisionEntries();
      return jsonState({
        form: "doom",
        measurement: measurementBlock(false),
        player: full.player,
        walls_relative_to_heading: full.walls_relative_to_heading,
        velocity: full.velocity,
        enemies: full.enemies,
        items: full.items,
        next_intersection: full.next_intersection,
        recent_decisions: full.recent_decisions,
      });
    }
    if (mode == "doom-frame") {
      var frame = frameObject(inter, publishAll(enemies), publishAll(items));
      return jsonState({
        form: "doom-frame",
        distance_and_bearing: bracketSentence,
        player: frame.player,
        walls_relative_to_heading: frame.walls_relative_to_heading,
        velocity: frame.velocity,
        enemies: frame.enemies,
        items: frame.items,
        next_intersection: frame.next_intersection,
      });
    }
    if (mode == "doom-local") {
      var ge = splitView(enemies);
      var gi = splitView(items);
      var local = frameObject(inter, ge.here, gi.here);
      return jsonState({
        form: "doom-local",
        measurement: measurementBlock(true),
        player: local.player,
        walls_relative_to_heading: local.walls_relative_to_heading,
        velocity: local.velocity,
        enemies: local.enemies,
        items: local.items,
        remembered: ge.gone.concat(gi.gone),
        next_intersection: local.next_intersection,
      });
    }
    if (mode == "doom-prose")
      return proseFrame(inter, publishAll(enemies), publishAll(items), false);
    if (mode == "brief") return proseFrame(inter, publishAll(enemies), [], true);
    return pacmanAgent.buildTextState(inter);
  };

  pacmanAgent.buildRequest = function () {
    if (!map) return null;
    var inter = pacmanAgent.findNextIntersection();
    if (!inter || inter.options.length == 0) return null;

    var mode = pacmanAgent.settings.stateMode;
    if (pacmanAgent.stateModeIds.indexOf(mode) < 0) mode = "text";

    var provider = pacmanAgent.getProvider();
    var wantShot = mode == "shot";
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
      mode = "text";
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
      mode = "text";
    }

    return {
      state:
        mode == "text"
          ? pacmanAgent.buildTextState(inter)
          : pacmanAgent.buildFormState(inter, mode),
      questions: questions,
      images: null,
    };
  };
})();
