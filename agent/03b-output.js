//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 03b Output modes
//
// What the model is asked, and how an answer becomes a direction. The game
// only accepts a direction (pacman.setInputDir). These modes differ in the
// questions and in the behavior step that turns the answers into that
// direction. Selectable with `b`, the left-panel output menu, or ?output=.
//
//   direct        One choice: up, down, left, or right. The behavior is that
//                 direction. Straight and reverse apply at once; a side turn
//                 is held for the next intersection (see 04-controller.js).
//   intersection  One choice: which open exit to take at the next intersection,
//                 plus reverse if that u-turn is not already an exit. Still
//                 just a direction. A side turn is held for the intersection;
//                 reverse is applied at once.
//   goto          One choice: a place (pellet, energizer, fruit, an edible
//                 ghost) or "run away". Until the next answer, the behavior
//                 follows the shortest maze path to that place and presses each
//                 next step, including turns; "run away" instead heads for the
//                 tiles Pac-Man can reach before any hunting ghost (stepFlee).
//   goal          Three choices, as in the Doom demo: the goal to maintain,
//                 a dodge, and a movement. Until the next answer the behavior
//                 re-reads the maze and combines them. A dodge is locked to
//                 the compass direction it meant when the answer arrived, and
//                 wins whenever that next tile is open. Otherwise an explicit
//                 "walk to" is a path. Otherwise close in / back off / hold
//                 ground aim at the goal's subject. Fleeing treats "close in"
//                 as moving away. A hunting ghost within 4 tiles overrides
//                 closing in or backing off on pellets or an energizer.

(function () {
  var DIR_NAMES = pacmanAgent.DIR_NAMES;

  pacmanAgent.outputModes = [
    { id: "direct", label: "direct" },
    { id: "intersection", label: "intersection" },
    { id: "goto", label: "goto" },
    { id: "goal", label: "goal" },
  ];
  pacmanAgent.outputModeIds = [];
  for (var oi = 0; oi < pacmanAgent.outputModes.length; oi++) {
    pacmanAgent.outputModeIds.push(pacmanAgent.outputModes[oi].id);
  }

  // Kept across decisions. The goal questions name it; an answer may replace it.
  pacmanAgent.goal = null;

  var outputMode = function () {
    var id = pacmanAgent.settings.outputMode;
    if (pacmanAgent.outputModeIds.indexOf(id) < 0) return "direct";
    return id;
  };

  var headingEnum = function () {
    if (typeof pacman == "undefined") return DIR_LEFT;
    if (pacman.dirEnum != undefined) return pacman.dirEnum;
    if (pacman.nextDirEnum != undefined) return pacman.nextDirEnum;
    return DIR_LEFT;
  };

  var latencyClause = function () {
    var lat = Math.round(pacmanAgent.latencyEwmaMs || 0);
    if (lat)
      return (
        "Your answers have been arriving about " +
        lat +
        " ms after you see the state, and Pac-Man keeps moving the whole time. "
      );
    return "Your answers arrive after a delay and Pac-Man keeps moving meanwhile. ";
  };

  var choiceOf = function (answers, id) {
    var a = answers && answers[id];
    if (!a || a.choice == undefined || a.choice === "") return null;
    return a;
  };

  var dirFromName = function (name) {
    var D = pacmanAgent.dirEnumByName[name];
    if (D == undefined) return null;
    return {
      dirEnum: D,
      dirName: name,
      summary: null,
      probability: null,
      confidence: null,
    };
  };

  var withStats = function (resolved, ans) {
    if (!resolved || !ans) return resolved;
    resolved.probability =
      ans.probabilities && ans.probabilities[ans.choice] != undefined
        ? ans.probabilities[ans.choice]
        : null;
    resolved.confidence = ans.confidence != undefined ? ans.confidence : null;
    return resolved;
  };

  // ---- maze geometry -------------------------------------------------------

  var normX = function (x) {
    var n = map.numCols;
    x = x % n;
    if (x < 0) x += n;
    return x;
  };

  var stepTo = function (x, y, dirEnum) {
    var d = {};
    setDirFromEnum(d, dirEnum);
    var nx = x + d.x;
    var ny = y + d.y;
    if (nx < 0) nx += map.numCols;
    else if (nx >= map.numCols) nx -= map.numCols;
    if (ny < 0 || ny >= map.numRows) return null;
    if (!map.isFloorTile(nx, ny)) return null;
    return { x: nx, y: ny };
  };

  var keyOf = function (x, y) {
    return x + "," + y;
  };

  // Shortest-path distance in tiles from (tx, ty), wrapping through tunnels.
  var distFrom = function (tx, ty) {
    tx = normX(tx);
    var dist = {};
    var q = [{ x: tx, y: ty }];
    dist[keyOf(tx, ty)] = 0;
    var head = 0;
    while (head < q.length) {
      var n = q[head++];
      var base = dist[keyOf(n.x, n.y)];
      for (var e = 0; e < 4; e++) {
        var s = stepTo(n.x, n.y, e);
        if (!s) continue;
        var k = keyOf(s.x, s.y);
        if (dist[k] != undefined) continue;
        dist[k] = base + 1;
        q.push(s);
      }
    }
    return dist;
  };

  // First step of the shortest path from Pac-Man to the tile. Heading if he
  // is already there or no path exists.
  var stepToward = function (tx, ty) {
    tx = normX(tx);
    var sx = pacman.tile.x;
    var sy = pacman.tile.y;
    if (sx == tx && sy == ty) return headingEnum();
    var q = [{ x: sx, y: sy, first: null }];
    var seen = {};
    seen[keyOf(sx, sy)] = true;
    var head = 0;
    while (head < q.length) {
      var n = q[head++];
      for (var e = 0; e < 4; e++) {
        var s = stepTo(n.x, n.y, e);
        if (!s) continue;
        var k = keyOf(s.x, s.y);
        if (seen[k]) continue;
        seen[k] = true;
        var first = n.first == null ? e : n.first;
        if (s.x == tx && s.y == ty) return first;
        q.push({ x: s.x, y: s.y, first: first });
      }
    }
    return headingEnum();
  };

  // The open neighbor that is farthest, along the maze, from the tile.
  var stepAway = function (tx, ty) {
    var dist = distFrom(tx, ty);
    var sx = pacman.tile.x;
    var sy = pacman.tile.y;
    var h = headingEnum();
    var best = null;
    var bestD = -1;
    for (var e = 0; e < 4; e++) {
      var s = stepTo(sx, sy, e);
      if (!s) continue;
      var d = dist[keyOf(s.x, s.y)];
      if (d == undefined) d = 0;
      if (d > bestD || (d == bestD && e == h)) {
        bestD = d;
        best = e;
      }
    }
    return best == null ? h : best;
  };

  // ---- fleeing ---------------------------------------------------------------
  //
  // A tile is SAFE for Pac-Man if he can be on it before any hunting ghost can
  // (his path there is shorter than every hunter's). All distances are along
  // the maze, not straight lines. Fleeing goes to the open neighbour from
  // which the most safe tiles can still be reached: the way with the most room
  // to run, which keeps him out of dead ends. If nowhere is safe, it takes the
  // neighbour farthest from the nearest hunter. Only ghosts that are hunting
  // count; edible, eaten and waiting ghosts are not a danger.
  var huntingGhosts = function () {
    var out = [];
    var i;
    for (i = 0; i < ghosts.length; i++) {
      if (!ghosts[i].scared && ghosts[i].mode == GHOST_OUTSIDE)
        out.push(ghosts[i]);
    }
    return out;
  };

  var stepFlee = function () {
    var hunters = huntingGhosts();
    var h = headingEnum();
    if (!hunters.length) return h;
    var sx = pacman.tile.x;
    var sy = pacman.tile.y;

    // each tile's distance from the nearest hunter
    var ghostDist = {};
    var i, k;
    for (i = 0; i < hunters.length; i++) {
      var d = distFrom(hunters[i].tile.x, hunters[i].tile.y);
      for (k in d) {
        if (ghostDist[k] == undefined || d[k] < ghostDist[k]) ghostDist[k] = d[k];
      }
    }
    var gd = function (key) {
      var v = ghostDist[key];
      return v == undefined ? Infinity : v;
    };

    var bestDir = null;
    var bestRoom = -1;
    var bestLead = -Infinity;
    var e;
    for (e = 0; e < 4; e++) {
      var n = stepTo(sx, sy, e);
      if (!n) continue;
      var nk = keyOf(n.x, n.y);
      var lead = gd(nk) - 1; // steps by which Pac-Man beats the ghosts there
      // safe tiles reachable by committing to this first step (never going
      // back through the tile he stands on), each reached before any ghost
      var room = 0;
      if (lead > 0) {
        var seen = {};
        seen[keyOf(sx, sy)] = true;
        seen[nk] = true;
        var q = [{ x: n.x, y: n.y, t: 1 }];
        room = 1;
        var head = 0;
        while (head < q.length) {
          var cur = q[head++];
          var e2;
          for (e2 = 0; e2 < 4; e2++) {
            var s = stepTo(cur.x, cur.y, e2);
            if (!s) continue;
            var sk = keyOf(s.x, s.y);
            if (seen[sk]) continue;
            seen[sk] = true;
            if (cur.t + 1 < gd(sk)) {
              room++;
              q.push({ x: s.x, y: s.y, t: cur.t + 1 });
            }
          }
        }
      }
      if (
        room > bestRoom ||
        (room == bestRoom && lead > bestLead) ||
        (room == bestRoom && lead == bestLead && e == h)
      ) {
        bestRoom = room;
        bestLead = lead;
        bestDir = e;
      }
    }
    return bestDir == null ? h : bestDir;
  };

  // How near a hunter has to be, by the maze, for fleeing to make sense. Offer
  // the option only inside fleeOffer steps; once chosen, flee until every
  // hunter is fleeRelease steps or more away, then go back to eating. The gap
  // between the two keeps it from flipping at the edge. (Pac-Man covers about
  // 7.5 tiles a second, so 8 steps is about a second.) Defaults 8 and 12: in a
  // simulated run, offering at 12 had Pac-Man fleeing 46% of the time against
  // 34% at 8, with no better survival.
  // Tune with ?flee= and ?fleeend= (01-config.js).
  var fleeOffer = function () {
    var n = pacmanAgent.settings.fleeOffer;
    return n > 0 ? n : 8;
  };
  var fleeRelease = function () {
    var n = pacmanAgent.settings.fleeRelease;
    if (!(n > 0)) n = 12;
    return Math.max(n, fleeOffer() + 1);
  };

  // The nearest hunting ghost by the maze: { ghost, steps }, or null when none
  // is hunting or none can reach Pac-Man.
  var nearestHunter = function () {
    var hunters = huntingGhosts();
    if (!hunters.length) return null;
    var dist = distFrom(pacman.tile.x, pacman.tile.y);
    var best = null;
    var i;
    for (i = 0; i < hunters.length; i++) {
      var d = dist[keyOf(normX(hunters[i].tile.x), hunters[i].tile.y)];
      if (d != undefined && (!best || d < best.steps))
        best = { ghost: hunters[i], steps: d };
    }
    return best;
  };

  var holdGround = function () {
    var h = headingEnum();
    var x = pacman.tile.x;
    var y = pacman.tile.y;
    if (stepTo(x, y, h)) return h;
    if (stepTo(x, y, rotateLeft(h))) return rotateLeft(h);
    if (stepTo(x, y, rotateRight(h))) return rotateRight(h);
    return rotateAboutFace(h);
  };

  var tileDist = function (tx, ty) {
    var dx = normX(tx) - pacman.tile.x;
    var cols = map.numCols;
    if (dx > cols / 2) dx -= cols;
    if (dx < -cols / 2) dx += cols;
    var dy = ty - pacman.tile.y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  // ---- places the goto and goal questions can name ------------------------

  var ghostStatus = function (g) {
    if (g.scared) return "frightened and edible";
    if (g.mode == GHOST_GOING_HOME || g.mode == GHOST_ENTERING_HOME)
      return "eaten, heading home, harmless";
    if (g.mode == GHOST_OUTSIDE) return "hunting, deadly on touch";
    return "in the ghost house, harmless for now";
  };

  var pushPlace = function (list, id, kind, x, y, detail) {
    list.push({
      id: id,
      kind: kind,
      x: normX(x),
      y: y,
      dist: tileDist(x, y),
      // distance, range and bearing from the heading, as the Doom states give
      // them (03-gamestate.js placeOf)
      where: pacmanAgent.placeOf(x, y),
      detail: detail,
    });
  };

  // An energizer is named by the corner of the maze it sits in, not by its
  // x,y: the Doom and brief states carry no coordinates, so a name with
  // coordinates would mean nothing to the model. Two in one corner get a
  // number. The name is fixed for as long as the energizer exists, so a late
  // answer still finds it.
  var energizerName = function (x, y, taken) {
    var base =
      (y < map.numRows / 2 ? "upper" : "lower") +
      " " +
      (x < map.numCols / 2 ? "left" : "right") +
      " energizer";
    var name = base;
    var n = 1;
    while (taken[name]) name = base + " " + ++n;
    taken[name] = true;
    return name;
  };

  // Every place that exists right now. Question menus show a short prefix
  // of this, ranked so a frightened ghost, the nearest pellet, and the
  // nearest energizer are offered before a ghost still in the house.
  var listPlaces = function () {
    var list = [];
    var best = null;
    var bestD = Infinity;
    var taken = {};
    var y, x, tile, d;
    for (y = 0; y < map.numRows; y++) {
      for (x = 0; x < map.numCols; x++) {
        tile = map.getTile(x, y);
        if (tile == "o") {
          pushPlace(
            list,
            energizerName(x, y, taken),
            "energizer",
            x,
            y,
            "frightens every hunting ghost",
          );
        } else if (tile == ".") {
          d = tileDist(x, y);
          if (d < bestD) {
            bestD = d;
            best = { x: x, y: y, dist: d };
          }
        }
      }
    }
    if (best)
      pushPlace(
        list,
        "nearest pellet",
        "pellet",
        best.x,
        best.y,
        map.dotsLeft() + " pellets left",
      );
    if (typeof fruit != "undefined" && fruit && fruit.isPresent && fruit.isPresent()) {
      var info = fruit.getCurrentFruit ? fruit.getCurrentFruit() : null;
      pushPlace(
        list,
        info && info.name ? info.name : "fruit",
        "fruit",
        Math.floor(fruit.pixel.x / tileSize),
        Math.floor(fruit.pixel.y / tileSize),
        info && info.points ? info.points + " points" : "bonus",
      );
    }
    var i;
    for (i = 0; i < ghosts.length; i++) {
      var g = ghosts[i];
      pushPlace(list, g.name, "ghost", g.tile.x, g.tile.y, ghostStatus(g));
    }
    return list;
  };

  var rankPlace = function (p) {
    if (p.kind == "ghost" && p.detail.indexOf("edible") >= 0) return 0;
    if (p.kind == "pellet") return 1;
    if (p.kind == "energizer") return 2;
    if (p.kind == "fruit") return 3;
    if (p.kind == "ghost" && p.detail.indexOf("hunting") >= 0) return 4;
    return 5;
  };

  // Up to six, nearest first inside each rank. Six matches the Doom demo's
  // "walk to" slots.
  var topPlaces = function (edibleGhostsOnly) {
    var all = listPlaces();
    // a ghost worth travelling to is one you can eat; going to a hunting
    // ghost (or one in the house) is never the point
    if (edibleGhostsOnly) {
      all = all.filter(function (p) {
        return p.kind != "ghost" || p.detail.indexOf("edible") >= 0;
      });
    }
    all.sort(function (a, b) {
      var r = rankPlace(a) - rankPlace(b);
      if (r) return r;
      return a.dist - b.dist;
    });
    return all.slice(0, 6);
  };

  var findPlace = function (id) {
    var all = listPlaces();
    var i;
    for (i = 0; i < all.length; i++) if (all[i].id == id) return all[i];
    return null;
  };

  // "frightened and edible: 7 tiles (close), bearing 0 degrees (dead ahead)" —
  // the same shape as a doom-prose item line
  var placeBlurb = function (p) {
    return p.detail + ": " + pacmanAgent.sentencePlace(p.where);
  };

  var nearestWhere = function (places, pred) {
    var best = null;
    var i;
    for (i = 0; i < places.length; i++) {
      if (!pred(places[i])) continue;
      if (!best || places[i].dist < best.dist) best = places[i];
    }
    return best;
  };

  var subjectFor = function (goal, places) {
    if (goal == "grab energizer")
      return (
        nearestWhere(places, function (p) {
          return p.kind == "energizer";
        }) ||
        nearestWhere(places, function (p) {
          return p.kind == "pellet";
        })
      );
    if (goal == "chase ghost")
      return (
        nearestWhere(places, function (p) {
          return p.kind == "ghost" && p.detail.indexOf("edible") >= 0;
        }) ||
        nearestWhere(places, function (p) {
          return p.kind == "ghost" && p.detail.indexOf("hunting") >= 0;
        })
      );
    if (goal == "flee")
      return nearestWhere(places, function (p) {
        return p.kind == "ghost" && p.detail.indexOf("hunting") >= 0;
      });
    return nearestWhere(places, function (p) {
      return p.kind == "pellet";
    });
  };

  var resolvedDir = function (dirEnum, summary, ans) {
    return withStats(
      {
        dirEnum: dirEnum,
        dirName: DIR_NAMES[dirEnum],
        summary: summary,
        probability: null,
        confidence: null,
      },
      ans,
    );
  };

  // ---- questions -----------------------------------------------------------

  var buildDirectQuestions = pacmanAgent.buildQuestions;

  var buildIntersectionQuestions = function (inter) {
    var heading = headingEnum();
    var criteria = {};
    var i;
    for (i = 0; i < inter.options.length; i++) {
      var e = inter.options[i];
      var name = DIR_NAMES[e];
      if (e == heading)
        criteria[name] =
          "leave the intersection straight ahead (your current heading)";
      else if (e == rotateAboutFace(heading))
        criteria[name] =
          "u-turn: leave back the way you came — applied immediately";
      else
        criteria[name] =
          "turn " + name + " at the intersection — held until you reach it";
    }
    // The exits above are whatever is open at the next intersection, rebuilt
    // every request. Reverse is the about-face. It is often already one of
    // those exits (the corridor you came along). When it is not, offer it
    // anyway: the player can turn around at any moment, not only at the
    // intersection. The controller applies an about-face at once.
    var back = rotateAboutFace(heading);
    var backName = DIR_NAMES[back];
    if (!criteria[backName])
      criteria[backName] =
        "u-turn now: reverse direction before the intersection — applied immediately";
    return {
      turn: {
        type: "choice",
        instructions:
          "You are Pac-Man. " +
          latencyClause() +
          "Choose one listed compass direction. It is pressed like an arrow key. Straight ahead and a u-turn happen at once. Any other direction is held and taken at the next intersection, then dropped even if that intersection has no such opening, or replaced if a newer answer arrives first. Reverse is always listed so you can turn around now.",
        criteria: criteria,
      },
    };
  };

  // How a place is measured, in the Doom states' own words. A state that
  // already carries the legend (every doom form, and brief) is not told twice.
  var measurementSentence = function () {
    var s =
      "Each place is described the way the state describes things: its distance in tiles (a straight line, so the maze path may be longer), a range, and a bearing from your current heading. ";
    var mode = pacmanAgent.settings.stateMode;
    if (pacmanAgent.stateModesWithLegend.indexOf(mode) < 0) {
      // the prose state already gives the scale and the speed; a screenshot
      // state gives neither, so it gets the whole legend here
      s +=
        (mode == "text"
          ? pacmanAgent.bracketSentence()
          : pacmanAgent.legendSentence()) +
        " " +
        pacmanAgent.valuesSentence +
        " ";
    }
    return s;
  };

  // The way out of danger, offered beside the places while a ghost is hunting.
  var FLEE_ID = "run away";

  var buildGotoQuestions = function () {
    var criteria = {};
    var places = topPlaces(true);
    var i;
    // what choosing a place does is said once, in the instructions
    for (i = 0; i < places.length; i++) {
      criteria[places[i].id] = placeBlurb(places[i]);
    }

    // only while a hunter is close by the maze: offered all the time, the
    // option has Pac-Man running from a ghost on the far side of the board
    var near = nearestHunter();
    var hunter = null;
    if (near && near.steps <= fleeOffer()) {
      hunter = findPlace(near.ghost.name);
      if (hunter) {
        criteria[FLEE_ID] =
          "get away from the hunting ghosts. Nearest is " +
          hunter.id +
          ", " +
          near.steps +
          " steps away by the maze, " +
          pacmanAgent.sentencePlace(hunter.where);
      }
    }

    return {
      goto: {
        type: "choice",
        instructions:
          "You are Pac-Man. " +
          latencyClause() +
          "You only choose a place. Until your next answer the game follows the shortest maze path to it and presses each next step, including the turns. You do not choose the turns. " +
          (hunter
            ? "Or choose run away: until your next answer the game heads for the open tiles you can reach before any hunting ghost can, keeping the most room to run. "
            : "") +
          measurementSentence() +
          "Where should Pac-Man go?",
        criteria: criteria,
      },
    };
  };

  var goalSentence = function () {
    if (pacmanAgent.goal)
      return "The goal you are maintaining is " + pacmanAgent.goal + ". ";
    return "You are not maintaining a goal yet. ";
  };

  var buildGoalQuestions = function () {
    var walk = {};
    var places = topPlaces();
    var i;
    for (i = 0; i < places.length; i++) {
      walk["walk to " + places[i].id] =
        "follow the shortest maze path there until your next answer. " +
        placeBlurb(places[i]);
    }
    var movement = {
      "hold ground": "keep your heading while the way ahead is open",
      "close in":
        "move toward the goal's subject (away from it when the goal is flee)",
      "back off": "move away from the goal's subject",
    };
    for (var k in walk) movement[k] = walk[k];
    return {
      goal: {
        type: "choice",
        instructions:
          "You are Pac-Man. " +
          goalSentence() +
          latencyClause() +
          "Name the goal to keep until you change it. Until your next answer the game re-reads the maze and combines this goal with your dodge and your movement. " +
          "A dodge is locked to the compass direction it meant when the answer arrived, and Pac-Man takes it whenever that next tile is open; a dodge beats the movement. " +
          "Otherwise a walk-to follows the shortest maze path to that place, including later turns. " +
          "Otherwise close in walks toward the goal's subject, back off walks away from it, and hold ground keeps the current heading while the way ahead is open. " +
          "The subject is the nearest pellet for eat pellets and clear the level, the nearest energizer or else a pellet for grab energizer, an edible ghost or else the nearest hunter for chase ghost, and the nearest hunter for flee. " +
          "When the goal is flee, close in means move away. " +
          "A hunting ghost within 4 tiles makes Pac-Man move away from that ghost instead of closing in or backing off on pellets or an energizer. Hold ground and a walk-to are not overridden. " +
          "What is the highest priority goal right now?",
        criteria: {
          "eat pellets": "work down the pellets",
          "grab energizer": "get an energizer so the ghosts become edible",
          "chase ghost": "go after a ghost you can eat, or the nearest hunter",
          flee: "get away from the hunting ghosts",
          "clear the level": "finish the maze",
        },
      },
      dodge: {
        type: "choice",
        instructions:
          goalSentence() +
          "A dodge is relative to your heading right now. When the answer arrives it becomes a fixed compass direction and is pressed whenever that next tile is open, until your next answer. It beats the movement. If that tile is not open, the movement is used instead.",
        criteria: {
          "carry on": "no dodge",
          "dodge left": "step to your left",
          "dodge right": "step to your right",
          "dodge back": "reverse",
        },
      },
      movement: {
        type: "choice",
        instructions:
          goalSentence() +
          "Used when you are not dodging into an open tile, and kept until your next answer. close in, back off, and hold ground aim at the goal's subject. A walk-to follows the shortest maze path, including later turns. When the goal is flee, close in moves away. A hunting ghost within 4 tiles overrides close in and back off while the goal is eat pellets, clear the level, or grab energizer.",
        criteria: movement,
      },
    };
  };

  pacmanAgent.buildQuestions = function (inter) {
    var mode = outputMode();
    if (mode == "intersection") return buildIntersectionQuestions(inter);
    if (mode == "goto") return buildGotoQuestions();
    if (mode == "goal") return buildGoalQuestions();
    return buildDirectQuestions(inter);
  };

  // ---- behavior ------------------------------------------------------------

  var dodgeDir = function (dodge) {
    var h = headingEnum();
    if (dodge == "dodge left") return rotateLeft(h);
    if (dodge == "dodge right") return rotateRight(h);
    if (dodge == "dodge back") return rotateAboutFace(h);
    return null;
  };

  // One direction from a stored goal behavior, read against the maze now.
  // dodgeAbs is the compass direction the dodge meant when the answer
  // arrived (null when the dodge was "carry on"); it does not rotate as
  // the heading changes.
  var combineGoal = function (goal, dodgeAbs, movement) {
    var places = listPlaces();
    var dirEnum = null;

    if (dodgeAbs != null && stepTo(pacman.tile.x, pacman.tile.y, dodgeAbs))
      dirEnum = dodgeAbs;

    var walked = null;
    if (dirEnum == null && movement.indexOf("walk to ") == 0) {
      walked = findPlace(movement.substring("walk to ".length));
      if (walked) dirEnum = stepToward(walked.x, walked.y);
    }

    var subject = subjectFor(goal, places);
    var hunter = nearestWhere(places, function (p) {
      return p.kind == "ghost" && p.detail.indexOf("hunting") >= 0;
    });
    var hunterClose = hunter && hunter.dist <= 4;
    var gathering =
      goal == "eat pellets" || goal == "clear the level" || goal == "grab energizer";

    if (
      dirEnum == null &&
      hunterClose &&
      gathering &&
      movement != "hold ground" &&
      movement.indexOf("walk to ") != 0
    )
      dirEnum = stepAway(hunter.x, hunter.y);

    if (dirEnum == null) {
      if (movement == "hold ground") dirEnum = holdGround();
      else if (movement == "back off" || (goal == "flee" && movement == "close in"))
        dirEnum = subject ? stepAway(subject.x, subject.y) : holdGround();
      else if (movement == "close in" || movement.indexOf("walk to ") == 0)
        dirEnum = subject ? stepToward(subject.x, subject.y) : holdGround();
      else dirEnum = subject ? stepToward(subject.x, subject.y) : holdGround();
    }
    return { dirEnum: dirEnum, walked: walked };
  };

  // Goal plus this moment's dodge and movement. The dodge is frozen as a
  // compass direction; the path is recomputed every frame (see stepLive)
  // until the next answer replaces this behavior.
  var resolveGoal = function (answers) {
    var goalAns = choiceOf(answers, "goal");
    var dodgeAns = choiceOf(answers, "dodge");
    var moveAns = choiceOf(answers, "movement");
    if (goalAns) pacmanAgent.goal = goalAns.choice;
    var goal = pacmanAgent.goal || "eat pellets";
    var dodge = dodgeAns ? dodgeAns.choice : "carry on";
    var movement = moveAns ? moveAns.choice : "close in";
    var dodgeAbs = dodgeDir(dodge);
    var combined = combineGoal(goal, dodgeAbs, movement);
    var said = "goal " + goal + "; " + dodge + "; " + movement;
    var statsFrom =
      dodgeAbs != null && combined.dirEnum == dodgeAbs
        ? dodgeAns
        : combined.walked
          ? moveAns
          : moveAns || dodgeAns || goalAns;
    var resolved = resolvedDir(combined.dirEnum, said, statsFrom);
    resolved.live = {
      kind: "goal",
      goal: goal,
      dodgeAbs: dodgeAbs,
      movement: movement,
    };
    return resolved;
  };

  // Re-steer a goto or goal until the next answer. Called every game frame
  // from the controller while pacmanAgent.liveSteer is set.
  pacmanAgent.liveSteer = null;
  pacmanAgent.stepLive = function () {
    var live = pacmanAgent.liveSteer;
    if (!live || typeof map == "undefined" || !map) return null;
    if (typeof pacman == "undefined" || !pacman.tile) return null;
    if (live.kind == "flee") {
      // the danger has passed: stop running and go back to eating
      var near = nearestHunter();
      if (!near || near.steps >= fleeRelease()) {
        pacmanAgent.log(
          "flee over (" +
            (near ? "nearest hunter " + near.steps + " steps away" : "no hunter") +
            ") — heading for the nearest pellet",
        );
        pacmanAgent.liveSteer = { kind: "goto", placeId: "nearest pellet" };
        var back = findPlace("nearest pellet");
        return back ? stepToward(back.x, back.y) : headingEnum();
      }
      return stepFlee();
    }
    if (live.kind == "goto") {
      var place = findPlace(live.placeId);
      if (!place) return headingEnum();
      return stepToward(place.x, place.y);
    }
    if (live.kind == "goal")
      return combineGoal(live.goal, live.dodgeAbs, live.movement).dirEnum;
    return null;
  };

  // Turn whatever the model returned into one direction. Matches the question
  // ids in the answer, so a late reply still applies after the mode changes.
  pacmanAgent.resolveOutput = function (answers) {
    if (!answers) return null;
    var ans = choiceOf(answers, "direction");
    if (ans) {
      var direct = dirFromName(ans.choice);
      return direct ? withStats(direct, ans) : null;
    }
    ans = choiceOf(answers, "turn");
    if (ans) {
      var turn = dirFromName(ans.choice);
      return turn ? withStats(turn, ans) : null;
    }
    ans = choiceOf(answers, "goto");
    if (ans) {
      if (ans.choice == FLEE_ID) {
        var fled = resolvedDir(
          stepFlee(),
          "run away from the hunting ghosts",
          ans,
        );
        fled.live = { kind: "flee" };
        return fled;
      }
      var place = findPlace(ans.choice);
      if (!place) return null;
      var toward = resolvedDir(
        stepToward(place.x, place.y),
        "walk to " + place.id,
        ans,
      );
      toward.live = { kind: "goto", placeId: place.id };
      return toward;
    }
    if (answers.goal || answers.dodge || answers.movement)
      return resolveGoal(answers);
    return null;
  };
})();
