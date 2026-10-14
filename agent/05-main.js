//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 05 Wiring
//
// Key bindings for the AI player (registered on window directly — src/input.js
// is not modified; these keys are unused by the game):
//
//   j — toggle the AI player on/off
//   k — cycle provider (ollama → vllm → cloudflare → typesafe → custom)
//   u — cycle the state form (prose, screenshot, the doom cuts, brief)
//   h — cycle the poll rate (1 → 2 → 5 → 10 → 20 Hz)
//   m — toggle the decision mode (realtime ↔ fixed rate)
//   b — cycle the output mode (direct → intersection → goto → goal)

(function () {
  var HZ_STEPS = [1, 2, 5, 10, 20];
  var cycleProvider = function () {
    var order = pacmanAgent.providerOrder;
    var i = order.indexOf(pacmanAgent.settings.provider);
    pacmanAgent.settings.provider = order[(i + 1) % order.length];
    pacmanAgent.save();
    pacmanAgent.log("provider → " + pacmanAgent.describe());
  };

  var cycleStateMode = function () {
    var m = pacmanAgent.stateModeIds;
    var i = m.indexOf(pacmanAgent.settings.stateMode);
    pacmanAgent.settings.stateMode = m[(i + 1) % m.length];
    pacmanAgent.save();
    pacmanAgent.log("state input → " + pacmanAgent.settings.stateMode);
  };

  var cycleHz = function () {
    var i = HZ_STEPS.indexOf(pacmanAgent.settings.hz);
    pacmanAgent.setHz(HZ_STEPS[(i + 1) % HZ_STEPS.length]);
  };

  var toggleMode = function () {
    pacmanAgent.setMode(
      pacmanAgent.settings.mode == "fixed" ? "realtime" : "fixed",
    );
  };

  var cycleOutputMode = function () {
    var m = pacmanAgent.outputModeIds;
    var i = m.indexOf(pacmanAgent.settings.outputMode);
    pacmanAgent.settings.outputMode = m[(i + 1) % m.length];
    pacmanAgent.save();
    pacmanAgent.log("output → " + pacmanAgent.settings.outputMode);
  };

  window.addEventListener("keydown", function (e) {
    var target = e.target || e.srcElement;
    var tag = target && target.tagName;
    // Typing in the instructions box (or any field) must not steer the agent.
    if (tag == "TEXTAREA" || tag == "INPUT" || tag == "SELECT") return;
    var key = (e || window.event).keyCode;
    if (key == 74) {
      // J
      pacmanAgent.toggle();
    } else if (key == 75) {
      // K
      cycleProvider();
    } else if (key == 85) {
      // U
      cycleStateMode();
    } else if (key == 72) {
      // H
      cycleHz();
    } else if (key == 77) {
      // M
      toggleMode();
    } else if (key == 66) {
      // B
      cycleOutputMode();
    }
  });

  window.addEventListener("load", function () {
    pacmanAgent.log(
      "AI player loaded — press j to start/stop it. " +
        "keys: j on/off, k provider, u state form, b output, h poll rate, m realtime/fixed. " +
        pacmanAgent.describe(),
    );
  });
})();
