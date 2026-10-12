//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 06 UI panel
//
// Layout (the game itself is untouched; this file builds all of its own DOM):
//
//     [ AI MODEL INPUT ]   [ game canvas ]   [ AI PLAYER ]
//
// The game centers its canvas by writing body.style.marginLeft (renderers.js
// center()) — a scheme that assumes the canvas is the only thing on the page.
// This sheet centers with flexbox on <body> instead, and resets that margin
// with !important (which beats the game's inline style, so no timing games):
// the canvas sits centered on the screen with a panel on each side, and the
// panels stretch to the full window height.
//
// left  — everything the model is asked, all at once (no tabs): the state
//          input toggle, the exact 'state' string, the typed 'questions', the
//          annotated screenshot ('images', screenshot mode) and the latest
//          answers.
// right — the agent: status, editable poll rate, decision mode, provider,
//          counters, the strips and the decision history. There is no log
//          pane — the console (01-config's logger) is the log.

(function () {
  // ---------- tiny dom helper ----------

  var el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (k == "text") node.textContent = v;
        else if (typeof v == "function" && k.slice(0, 2) == "on") {
          node.addEventListener(k.slice(2), v);
        } else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        var c = children[i];
        node.appendChild(typeof c == "string" ? document.createTextNode(c) : c);
      }
    }
    return node;
  };

  // ---------- styles ----------

  document.head.appendChild(
    el("style", {
      text: [
        // center the [panel | canvas | panel] row on the screen. The !important
        // margin reset neutralizes the game's canvas-only body.style.marginLeft
        // (renderers.js center()) — inline styles lose to !important rules.
        "html,body{height:100%}",
        "body{display:flex;flex-wrap:wrap;justify-content:center;align-items:stretch;background:#000}",
        "body{margin:0 !important}",
        // stray font-preload spacer div in index.htm; would sit in the flex row
        "body>div[style*='ArcadeR']{display:none}",
        // keep the canvas at its own size (don't flex-shrink or stretch it)
        "#canvas{flex:none;align-self:flex-start}",
        // The panels: exactly the viewport height (height:100% of body). This
        // is the load-bearing rule — flex items have an automatic content-based
        // minimum (min-height:auto), so without a definite height a growing log
        // would push the panel past the window and make the page scroll.
        // min-height:0 lets the panel shrink; box-sizing keeps padding/border
        // inside the 100% so nothing overflows by a few pixels.
        ".ag-side{flex:none;width:304px;margin:0 6px;height:100%;min-height:0;box-sizing:border-box;" +
          "display:flex;flex-direction:column;text-align:left;color:#c3cad6;font:11px/1.5 monospace}",
        ".ag-side *{box-sizing:border-box}",
        ".ag-sec{flex:1;display:flex;flex-direction:column;min-height:0;" +
          "border:1px solid #262b33;border-radius:6px;background:#0b0d11;overflow:hidden}",
        ".ag-head{flex:none;padding:6px 10px;font-size:11px;letter-spacing:.14em;color:#8cf;" +
          "border-bottom:1px solid #262b33;background:#141821}",
        ".ag-body{flex:1;display:flex;flex-direction:column;min-height:0;padding:8px;gap:7px;overflow:hidden}",
        ".ag-lab{flex:none;color:#5a6270;font-size:10px;letter-spacing:.06em}",
        ".ag-row{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
        ".ag-row label{color:#8b93a3}",
        ".ag-row b{color:#fff;font-weight:normal}",
        ".ag-grow{flex:1}",
        // segmented toggle (text / screenshot, realtime / fixed)
        ".ag-seg{display:flex;border:1px solid #333a46;border-radius:4px;overflow:hidden}",
        ".ag-seg div{flex:1;text-align:center;padding:3px 0;cursor:pointer;color:#67717f}",
        ".ag-seg div.sel{background:#1d2f3f;color:#9df}",
        ".ag-row>.ag-seg{flex:1}",
        // controls
        ".ag-btn{cursor:pointer;background:#1b2026;color:#cdd;border:1px solid #33404e;" +
          "border-radius:4px;padding:3px 10px;font:inherit}",
        ".ag-btn:hover{background:#252b33;color:#fff}",
        ".ag-btn.primary{background:#20323a;border-color:#37525e;color:#adf}",
        ".ag-sel{flex:1;background:#0b0d10;color:#cdd;border:1px solid #33404e;border-radius:4px;" +
          "padding:3px 6px;font:inherit}",
        ".ag-inp{width:4.5em;background:#0b0d10;color:#cdd;border:1px solid #33404e;border-radius:4px;" +
          "padding:3px 6px;font:inherit;text-align:right;-moz-appearance:textfield}",
        ".ag-inp::-webkit-outer-spin-button,.ag-inp::-webkit-inner-spin-button{display:none}",
        // status dot
        ".ag-dot{flex:none;width:9px;height:9px;border-radius:50%;background:#444;margin-right:6px}",
        ".ag-dot.on{background:#39c239;box-shadow:0 0 6px #39c239}",
        ".ag-dot.busy{background:#d8b53f;box-shadow:0 0 6px #d8b53f}",
        ".ag-dot.frozen{background:#5cb3ff;box-shadow:0 0 6px #5cb3ff}",
        ".ag-dot.err{background:#d34848;box-shadow:0 0 6px #d34848}",
        // counters grid
        ".ag-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px 12px}",
        ".ag-cell{display:flex;justify-content:space-between}",
        ".ag-cell .k{color:#68717f}",
        ".ag-cell .v{color:#fff}",
        // last-choice strip — fixed height, one line: long text ellipsizes,
        // the box never resizes with its content
        ".ag-last{display:flex;justify-content:space-between;align-items:baseline;" +
          "border:1px solid #1c2a1c;background:#0c1710;border-radius:4px;padding:4px 8px;" +
          "height:27px;white-space:nowrap;overflow:hidden}",
        ".ag-last b{color:#8f8;flex:none}",
        ".ag-last .dim{color:#586858;min-width:0;overflow:hidden;text-overflow:ellipsis}",
        // latency health strip — warns when the model cannot keep up with the
        // poll rate. Fixed height: exactly two lines (main + sub), each
        // nowrap+ellipsis — text changes never resize the strip
        ".ag-lat{flex:none;display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;border-radius:4px;" +
          "padding:4px 8px;background:#0a0e13;border:1px solid #131a22;color:#68717f;height:42px;overflow:hidden}",
        ".ag-lat .led{flex:none;width:8px;height:8px;border-radius:50%;background:#2c3440;align-self:center}",
        ".ag-lat b{color:#dfe6f0;font-weight:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}",
        ".ag-lat .sub{flex-basis:100%;color:#58626f;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        ".ag-lat.ok{background:#0c1710;border-color:#1c2a1c;color:#7f997f}",
        ".ag-lat.ok .led{background:#39c239;box-shadow:0 0 5px #39c239}",
        ".ag-lat.ok .sub{color:#4d6b4d}",
        ".ag-lat.warn{background:#151208;border-color:#2b2410;color:#c7b58a}",
        ".ag-lat.warn .led{background:#d8b53f;box-shadow:0 0 5px #d8b53f}",
        ".ag-lat.warn .sub{color:#8a7a4d}",
        ".ag-lat.over{background:#170c0c;border-color:#3a1a1a;color:#f0a0a0;" +
          "animation:agpulse 1.4s ease-in-out infinite}",
        ".ag-lat.over b{color:#ffb3b3}",
        ".ag-lat.over .led{background:#d34848;box-shadow:0 0 6px #d34848}",
        ".ag-lat.over .sub{color:#c98080}",
        "@keyframes agpulse{0%,100%{box-shadow:0 0 0 0 rgba(211,72,72,0)}" +
          "50%{box-shadow:0 0 0 3px rgba(211,72,72,.35)}",
        // held-turn strip ("holding left since t=12.8s …") — same shape as the
        // last-choice strip, different tint
        ".ag-hold{background:#0c1218;border-color:#1c2730}",
        ".ag-hold b{color:#adf}",
        ".ag-hold .dim{color:#586858}",
        // decision-history box: fills the panel's leftover vertical space
        // (never resizing with its text), scrolls silently if long — the
        // tail it shows is exactly what gets sent to the model
        ".ag-hist{flex:1 1 88px;min-height:88px;scrollbar-width:thin}",
        ".ag-hist::-webkit-scrollbar{width:8px}",
        ".ag-hist::-webkit-scrollbar-thumb{background:#22272f;border-radius:4px}",
        // content boxes: everything shown at once; scroll silently if unavoidable
        ".ag-pre{background:#06070a;border:1px solid #191d24;border-radius:4px;padding:6px;margin:0;" +
          "white-space:pre-wrap;word-break:break-word;overflow:auto;font-size:10px;line-height:1.4;" +
          "color:#9fb0c0;scrollbar-width:none}",
        ".ag-pre::-webkit-scrollbar{display:none}",
        ".ag-state{flex:1 1 auto;min-height:120px}",
        // fixed heights: content scrolls inside (scrollbars stay hidden) —
        // the questions/answers boxes never resize with their text, so the
        // left-panel layout cannot jump while playing
        ".ag-q{flex:none;height:150px}",
        ".ag-a{flex:none;height:72px}",
        ".ag-shot{display:flex;justify-content:center;background:#06070a;border:1px solid #191d24;" +
          "border-radius:4px;overflow:hidden;padding:4px}",
        ".ag-shot img{max-width:100%;max-height:190px;image-rendering:pixelated}",
      ].join(""),
    }),
  );

  // ---------- panel skeleton ----------

  var mkPanel = function (title) {
    var body = el("div", { class: "ag-body" });
    var root = el("div", { class: "ag-side" }, [
      el("div", { class: "ag-sec" }, [
        el("div", { class: "ag-head", text: title }),
        body,
      ]),
    ]);
    return { root: root, body: body };
  };

  var lab = function (t) {
    return el("div", { class: "ag-lab", text: t });
  };

  // ---------- left panel: everything sent to the model ----------

  var left = mkPanel("AI MODEL INPUT");

  var segText = el("div", {
    text: "text maze",
    onclick: function () {
      setStateMode("text");
    },
  });
  var segShot = el("div", {
    text: "screenshot",
    onclick: function () {
      setStateMode("shot");
    },
  });
  var setStateMode = function (mode) {
    pacmanAgent.settings.stateMode = mode;
    pacmanAgent.save();
    pacmanAgent.log(
      "state input → " + (mode == "text" ? "text maze" : "screenshot"),
    );
    refreshSeg();
  };

  var statePre = el("pre", { class: "ag-pre ag-state" });
  var questPre = el("pre", { class: "ag-pre ag-q" });
  var shotImg = el("img");
  var shotBox = el("div", { class: "ag-shot" }, [shotImg]);
  var shotLab = lab("annotated screenshot sent to the model ('images')");
  var ansPre = el("pre", { class: "ag-pre ag-a" });

  left.body.appendChild(lab("state input"));
  left.body.appendChild(el("div", { class: "ag-seg" }, [segText, segShot]));
  left.body.appendChild(lab("state sent to the model ('state')"));
  left.body.appendChild(statePre);
  left.body.appendChild(lab("typed questions ('questions')"));
  left.body.appendChild(questPre);
  left.body.appendChild(shotLab);
  left.body.appendChild(shotBox);
  left.body.appendChild(lab("latest answers"));
  left.body.appendChild(ansPre);

  // ---- formatters (compact, readable — not raw JSON) ----

  var pct = function (v) {
    return v == null ? "?" : (v * 100).toFixed(1) + "%";
  };
  var pad = function (s, n) {
    s = String(s);
    while (s.length < n) s += " ";
    return s;
  };

  var fmtQuestions = function (q) {
    if (!q) return "(nothing yet — start the agent)";
    var out = [];
    for (var id in q) {
      var que = q[id];
      out.push("▸ " + id + " — " + que.type);
      if (que.instructions)
        out.push("  " + que.instructions.replace(/\s+/g, " "));
      if (que.criteria) {
        if (que.criteria instanceof Array) {
          for (var i = 0; i < que.criteria.length; i++) {
            out.push("  " + i + ". " + que.criteria[i]);
          }
        } else {
          var keys = [];
          var w = 0;
          for (var k in que.criteria) {
            keys.push(k);
            if (k.length > w) w = k.length;
          }
          for (var j = 0; j < keys.length; j++) {
            out.push("  " + pad(keys[j], w) + " — " + que.criteria[keys[j]]);
          }
        }
      }
    }
    return out.join("\n");
  };

  var fmtAnswers = function (a) {
    if (!a) return "(nothing yet)";
    var out = [];
    for (var id in a) {
      if (id == "usage") continue;
      var an = a[id];
      if (an.choice != undefined) {
        out.push(
          "▸ " +
            id +
            " → " +
            an.choice +
            "   (p " +
            pct(an.probabilities && an.probabilities[an.choice]) +
            ", confidence " +
            pct(an.confidence) +
            ")",
        );
        if (an.probabilities) {
          var parts = [];
          for (var k in an.probabilities)
            parts.push(k + " " + pct(an.probabilities[k]));
          out.push("    " + parts.join("   "));
        }
      } else if (an.noul != undefined) {
        out.push("▸ " + id + " → true " + pct(an.noul));
      } else if (an.score != undefined) {
        out.push(
          "▸ " +
            id +
            " → score " +
            Number(an.score).toFixed(2) +
            "   (confidence " +
            pct(an.confidence) +
            ")",
        );
        if (an.legend) {
          var l = [];
          for (var i in an.legend) l.push(i + "=" + an.legend[i]);
          out.push("    " + l.join("   "));
        }
        if (an.probabilities) {
          var parts2 = [];
          for (var k2 in an.probabilities)
            parts2.push(k2 + " " + pct(an.probabilities[k2]));
          out.push("    " + parts2.join("   "));
        }
      }
    }
    if (a.usage) {
      out.push(
        "tokens: " +
          (a.usage.input_tokens != null ? a.usage.input_tokens : "?") +
          " in / " +
          (a.usage.output_tokens != null ? a.usage.output_tokens : 0) +
          " out",
      );
    }
    return out.join("\n");
  };

  // ---------- right panel: the agent ----------

  var right = mkPanel("AI PLAYER");

  var dot = el("span", { class: "ag-dot" });
  var stTxt = el("b", { text: "stopped" });
  var toggleBtn = el("button", {
    class: "ag-btn primary",
    text: "start (j)",
    onclick: function () {
      pacmanAgent.toggle();
      refresh();
    },
  });

  var hzInput = el("input", {
    class: "ag-inp",
    type: "number",
    min: "1",
    max: "60",
    step: "1",
    value: String(pacmanAgent.settings.hz),
  });
  hzInput.addEventListener("change", function () {
    var v = parseFloat(hzInput.value);
    if (v > 0 && v <= 60) pacmanAgent.setHz(v);
    else hzInput.value = String(pacmanAgent.settings.hz);
    refresh();
  });

  var provSel = el("select", { class: "ag-sel" });
  pacmanAgent.providerOrder.forEach(function (name) {
    provSel.appendChild(
      el("option", {
        value: name,
        text: name + " — " + pacmanAgent.providers[name].label,
      }),
    );
  });
  provSel.value = pacmanAgent.settings.provider;
  provSel.addEventListener("change", function () {
    pacmanAgent.settings.provider = provSel.value;
    pacmanAgent.save();
    pacmanAgent.log("provider → " + pacmanAgent.describe());
  });

  // decision mode: realtime (never stop the game) vs fixed rate (the game
  // freezes for each decision — no in-game latency, wall latency paid as a
  // visible freeze). Mirrors pacmanAgent.setMode / the 'm' key.
  var segRt = el("div", {
    text: "realtime",
    onclick: function () {
      pacmanAgent.setMode("realtime");
      refresh();
    },
  });
  var segFx = el("div", {
    text: "fixed rate",
    onclick: function () {
      pacmanAgent.setMode("fixed");
      refresh();
    },
  });

  // latency health strip — see refresh() for the state machine. Two lines
  // (main + sub), both fixed by the CSS; long text ellipsizes, never wraps
  var latLed = el("span", { class: "led" });
  var latB = el("b", { text: "latency —" });
  var latSub = el("span", {
    class: "sub",
    text: "start the agent to measure latency…",
  });
  var latStrip = el("div", { class: "ag-lat" }, [latLed, latB, latSub]);

  var cell = function (k) {
    var v = el("span", { class: "v", text: "—" });
    return {
      v: v,
      node: el("div", { class: "ag-cell" }, [
        el("span", { class: "k", text: k }),
        v,
      ]),
    };
  };
  var cLat = cell("latency");
  var cEwma = cell("latency ewma");
  var cTok = cell("tokens/req");
  var cReq = cell("requests");
  var cDec = cell("decisions");
  var cErr = cell("errors");
  var cAns = cell("last answer");

  var lastChoiceB = el("b", { text: "→ (none yet)" });
  var lastChoiceDim = el("span", { class: "dim" });
  var lastStrip = el("div", { class: "ag-last" }, [lastChoiceB, lastChoiceDim]);

  // the turn currently held for the next intersection (or "none")
  var heldB = el("b", { text: "holding —" });
  var heldDim = el("span", { class: "dim", text: "none" });
  var heldStrip = el("div", { class: "ag-last ag-hold" }, [heldB, heldDim]);

  // decision history — the tail of this is sent to the model in the state
  var histPre = el("pre", { class: "ag-pre ag-hist" });

  right.body.appendChild(
    el("div", { class: "ag-row" }, [
      dot,
      stTxt,
      el("span", { class: "ag-grow" }),
      toggleBtn,
    ]),
  );
  right.body.appendChild(
    el("div", { class: "ag-row" }, [
      el("label", { text: "poll rate" }),
      hzInput,
      el("label", { text: "Hz" }),
    ]),
  );
  right.body.appendChild(
    el("div", { class: "ag-row" }, [
      el("label", { text: "mode" }),
      el("div", { class: "ag-seg" }, [segRt, segFx]),
    ]),
  );
  right.body.appendChild(latStrip);
  right.body.appendChild(
    el("div", { class: "ag-row" }, [
      el("label", { text: "provider" }),
      provSel,
    ]),
  );
  right.body.appendChild(
    el("div", { class: "ag-grid" }, [
      cLat.node,
      cEwma.node,
      cTok.node,
      cReq.node,
      cDec.node,
      cErr.node,
      cAns.node,
    ]),
  );
  right.body.appendChild(lastStrip);
  right.body.appendChild(heldStrip);
  right.body.appendChild(lab("decision history (tail is sent to the model)"));
  right.body.appendChild(histPre);

  // ---------- assembly ----------

  var assemble = function () {
    var canvas = document.getElementById("canvas");
    if (!canvas || !canvas.parentNode) return;
    canvas.parentNode.insertBefore(left.root, canvas);
    canvas.parentNode.insertBefore(right.root, canvas.nextSibling);
    refresh();
    refreshSeg();
    renderAll();
  };
  if (document.readyState == "loading") {
    document.addEventListener("DOMContentLoaded", assemble);
  } else {
    assemble();
  }

  // ---------- live views ----------

  var lastState, lastQuestions, lastImages, lastAnswers;
  var lastAnswerAt = 0;

  var renderAll = function () {
    statePre.textContent = lastState || "(nothing yet — start the agent)";
    questPre.textContent = fmtQuestions(lastQuestions);
    ansPre.textContent = fmtAnswers(lastAnswers);
    if (lastImages && lastImages[0]) {
      shotImg.src = "data:image/png;base64," + lastImages[0];
    }
  };

  var refreshSeg = function () {
    var shot = pacmanAgent.settings.stateMode == "shot";
    segText.classList[shot ? "remove" : "add"]("sel");
    segShot.classList[shot ? "add" : "remove"]("sel");
    shotLab.style.display = shot ? "" : "none";
    shotBox.style.display = shot ? "" : "none";
  };

  pacmanAgent.onViewRequest = function (state, questions, images) {
    lastState = state;
    lastQuestions = questions;
    lastImages = images;
    renderAll();
  };
  pacmanAgent.onViewAnswer = function (raw) {
    lastAnswers = raw;
    lastAnswerAt = Date.now();
    var tok = raw && raw.usage && raw.usage.input_tokens;
    cTok.v.textContent = tok != null ? String(tok) : "—";
    renderAll();
  };

  // ---------- status ----------

  var errFlashUntil = 0;

  var refresh = function () {
    var st = pacmanAgent.status();
    dot.className =
      "ag-dot" +
      (Date.now() < errFlashUntil
        ? " err"
        : st.running
          ? st.holding
            ? " frozen"
            : st.busy
              ? " busy"
              : " on"
          : "");
    stTxt.textContent = !st.running
      ? "stopped"
      : st.holding
        ? "frozen — asking…"
        : st.busy
          ? "asking…"
          : "running";
    toggleBtn.textContent = st.running ? "stop (j)" : "start (j)";
    if (document.activeElement != hzInput) {
      hzInput.value = String(pacmanAgent.settings.hz);
    }
    provSel.value = pacmanAgent.settings.provider;
    var fx = st.mode == "fixed";
    segRt.classList[fx ? "remove" : "add"]("sel");
    segFx.classList[fx ? "add" : "remove"]("sel");
    cLat.v.textContent = st.latencyMs != null ? st.latencyMs + " ms" : "—";
    cEwma.v.textContent =
      st.latencyEwmaMs != null ? st.latencyEwmaMs + " ms" : "—";

    // ---- latency health ----
    // realtime: can the model keep up with the poll rate? ONE request is in
    // flight at a time, so a fresh answer can land every poll period only
    // while sustained latency fits inside one poll period — that is the
    // sustain condition. over: it doesn't (answers arrive slower than the
    // poll rate). warn: it barely does (most of the period spent waiting).
    // ok: comfortable headroom.
    //
    // fixed rate: every decision lands on time in the game — wall latency
    // cannot make answers stale, so there is no staleness budget at all.
    // The strip instead shows the wall-clock cost of the freeze, and warns
    // when a freeze eats more wall time than the play it buys.
    var hz = pacmanAgent.settings.hz;
    var iv = st.intervalMs,
      lat = st.effLatencyMs,
      infl = st.inFlightMs;
    var budget = iv; // realtime: latency budget that sustains hz (1 in flight)
    var cls = "",
      mainT = "latency —",
      subT;
    // one-line sub texts — the strip is fixed-height, so long sub text
    // ellipsizes rather than wrapping (keep them short enough to fit)
    if (st.mode == "fixed") {
      mainT = "fixed rate —";
      if (!st.running) {
        subT = "agent stopped";
      } else if (st.holding) {
        cls = st.holdMs > budget ? "warn" : "ok";
        mainT = "fixed rate: frozen";
        subT =
          "answer in flight " +
          Math.round(st.holdMs) +
          " ms — game time stands still";
      } else {
        cls = st.lastHoldMs > budget ? "warn" : "ok";
        subT =
          "froze " +
          Math.round(st.lastHoldMs) +
          " ms per " +
          Math.round(iv) +
          " ms of play · no in-game latency";
      }
    } else if (!st.running && !lat) {
      subT = "agent stopped";
    } else if (lat == null) {
      subT = infl
        ? "first request in flight…"
        : "waiting for the first answer…";
    } else if (lat > budget || infl > budget) {
      cls = "over";
      var eff = Math.min(hz, 1000 / lat); // answer arrival rate
      mainT =
        "latency " +
        Math.round(lat) +
        " ms ≫ budget " +
        Math.round(budget) +
        " ms";
      subT =
        "answers ~" +
        eff.toFixed(1) +
        " Hz · ~" +
        (lat / iv).toFixed(1) +
        " polls stale — lower hz" +
        (infl > budget ? " · in flight " + Math.round(infl) + " ms" : "");
    } else if (lat > budget * 0.7) {
      cls = "warn";
      subT =
        "answers ~" +
        (lat / iv).toFixed(1) +
        " polls stale · inside the period";
    } else {
      cls = "ok";
      subT =
        "answers inside the poll period (" +
        Math.round(iv) +
        " ms @ " +
        hz +
        " Hz)";
    }
    latStrip.className = "ag-lat" + (cls ? " " + cls : "");
    latB.textContent = mainT;
    latSub.textContent = subT;
    curHealth = cls;
    var col = cls == "over" ? "#f88" : cls == "warn" ? "#fc6" : "";
    cLat.v.style.color = col;
    cEwma.v.style.color = col;
    cReq.v.textContent = String(st.requests);
    cDec.v.textContent = String(st.decisions);
    cErr.v.textContent = String(st.errors);
    cAns.v.textContent = lastAnswerAt
      ? ((Date.now() - lastAnswerAt) / 1000).toFixed(1) + " s ago"
      : "—";
    var c = st.lastChoice;
    if (c) {
      lastChoiceB.textContent =
        "→ " + c.choice + (c.kind ? " (" + c.kind + ")" : "");
      lastChoiceDim.textContent =
        "p=" +
        (c.probability == null ? "?" : c.probability.toFixed(2)) +
        " conf=" +
        (c.confidence == null ? "?" : c.confidence.toFixed(2)) +
        " · " +
        c.ms +
        " ms";
    }

    // the held turn, and the history tail sent to the model
    var pd = st.pending;
    if (pd) {
      heldB.textContent = "holding " + pd.dir;
      heldDim.textContent =
        "since t=" + pd.sinceT.toFixed(1) + "s → next intersection";
    } else {
      heldB.textContent = "holding —";
      heldDim.textContent = "none (no turn held)";
    }
    var hh = st.history || [];
    if (hh.length) {
      var rows = [];
      for (var i = 0; i < hh.length; i++) {
        var e = hh[i];
        rows.push(
          "t=" +
            e.t.toFixed(1) +
            "s " +
            pad(e.dir, 6) +
            e.kind +
            (e.kind == "turn"
              ? " — " + pacmanAgent.describeDecisionOutcome(e.outcome)
              : " — applied instantly"),
        );
      }
      histPre.textContent = rows.join("\n");
    } else {
      histPre.textContent = "(no decisions yet)";
    }
  };

  // ---------- errors flash the status dot ----------

  // There is no log pane — the console (01-config's logger, which every
  // emitter already writes to) is the log. Errors additionally flash the
  // status dot red for a moment (refresh() reads errFlashUntil).
  var baseLogError = pacmanAgent.logError; // 04 controller console emitter
  pacmanAgent.logError = function (msg) {
    errFlashUntil = Date.now() + 2000;
    baseLogError(msg);
  };

  // ---------- housekeeping loop ----------

  var lastMode = null;
  var lastProv = null;
  var curHealth = ""; // latency health class set by refresh()
  var lastHealth = "";
  var lastHealthLogAt = 0;
  setInterval(function () {
    if (pacmanAgent.settings.stateMode != lastMode) {
      lastMode = pacmanAgent.settings.stateMode;
      refreshSeg();
    }
    if (pacmanAgent.settings.provider != lastProv) {
      lastProv = pacmanAgent.settings.provider;
      provSel.value = lastProv;
    }
    refresh();
    // announce health transitions in the log (throttled — the effective
    // rate bounces around the threshold when it is borderline). The alarm
    // differs per decision mode: realtime fails when answers cannot sustain
    // the poll rate ("over"); fixed rate always lands answers on time in the
    // game and instead warns when a freeze costs more wall time than the
    // play it buys ("warn").
    var alarm = pacmanAgent.settings.mode == "fixed" ? "warn" : "over";
    if ((curHealth == alarm) != (lastHealth == alarm)) {
      var now = Date.now();
      if (now - lastHealthLogAt > 5000) {
        if (curHealth == alarm) {
          if (pacmanAgent.settings.mode == "fixed") {
            var st2 = pacmanAgent.status();
            pacmanAgent.log(
              "fixed rate: last freeze %dms exceeds the %dms of play it buys (@%d Hz) — more wall time frozen than played",
              Math.round(st2.lastHoldMs),
              Math.round(st2.intervalMs),
              pacmanAgent.settings.hz,
            );
          } else {
            var st3 = pacmanAgent.status();
            var eff = Math.min(
              pacmanAgent.settings.hz,
              1000 / (st3.effLatencyMs || 1),
            );
            pacmanAgent.log(
              "latency %dms exceeds the budget %dms (poll %dms @%d Hz, one request in flight) — arrivals ~%s Hz",
              Math.round(st3.effLatencyMs || 0),
              Math.round(st3.intervalMs),
              Math.round(st3.intervalMs),
              pacmanAgent.settings.hz,
              eff.toFixed(1),
            );
          }
        } else {
          pacmanAgent.log(
            pacmanAgent.settings.mode == "fixed"
              ? "fixed rate: freeze back under the play period"
              : "latency back within the budget — arrivals sustain the poll rate",
          );
        }
        lastHealthLogAt = now;
      }
      lastHealth = curHealth;
    }
  }, 250);
})();
