//////////////////////////////////////////////////////////////////////////////////////
// Pac-Man AI Agent — 02 Provider client
//
// Sends one SystemOne request ({ model, state, questions[, images] }) to the
// configured provider and resolves to { answers, raw, ms }.
//
// The wire format is shared, so the same client works for:
//   - Ollama clef-flash (local)             POST /v1/systemone
//   - clef-systemone / vLLM FP8 image (local) POST /v1/systemone
//   - Cloudflare Workers AI REST             (result envelope is unwrapped)
//   - TypeSafe Jev hosted API                POST /v1/systemone

(function () {
  var buildEndpoint = function () {
    var s = pacmanAgent.settings;
    var endpoint = s.endpoint || pacmanAgent.getProvider().endpoint;
    if (endpoint.indexOf("%ACCOUNT%") >= 0) {
      if (!s.account) {
        throw new Error(
          "the Cloudflare provider needs an account id " +
            "(?account=... or pacmanAgent.settings.account = '...')",
        );
      }
      endpoint = endpoint.replace("%ACCOUNT%", encodeURIComponent(s.account));
    }
    return endpoint;
  };

  var buildBody = function (state, questions, images) {
    var s = pacmanAgent.settings;
    return {
      model: s.model || pacmanAgent.getProvider().model,
      state: state,
      questions: questions,
      images: images && images.length ? images : undefined,
    };
  };

  var buildHeaders = function () {
    var headers = { "content-type": "application/json" };
    if (pacmanAgent.getProvider().auth == "bearer") {
      var token = pacmanAgent.settings.token;
      if (!token) {
        throw new Error(
          "the " +
            pacmanAgent.settings.provider +
            " provider needs an API token (?token=... or pacmanAgent.settings.token = '...')",
        );
      }
      headers["Authorization"] = "Bearer " + token;
    }
    return headers;
  };

  // Cloudflare's REST API wraps results in { success, result, ... };
  // the other providers return the payload directly.
  var unwrap = function (json) {
    if (json && json.success !== undefined && json.result !== undefined) {
      return json.result;
    }
    return json;
  };

  // latency bookkeeping (exponentially weighted moving average)
  var ewmaMs = 0;

  pacmanAgent.ask = function (state, questions, images) {
    var t0 = Date.now();
    var endpoint, headers, body;
    try {
      endpoint = buildEndpoint();
      headers = buildHeaders();
      body = buildBody(state, questions, images);
    } catch (e) {
      return Promise.reject(e);
    }

    var ctrl = new AbortController();
    // bound — an unbound `setTimeout(ctrl.abort, ...)` throws
    // `TypeError: Illegal invocation` when the timeout fires (it
    // detaches the method from its controller), so a timed-out
    // request would never actually be cancelled
    var timer = setTimeout(function () {
      ctrl.abort();
    }, pacmanAgent.settings.timeoutMs);

    return fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            throw new Error(
              "http " + r.status + " from provider: " + t.slice(0, 200),
            );
          });
        }
        return r.json();
      })
      .then(function (json) {
        clearTimeout(timer);
        var ms = Date.now() - t0;
        ewmaMs = ewmaMs ? ewmaMs * 0.8 + ms * 0.2 : ms;
        pacmanAgent.lastLatencyMs = ms;
        pacmanAgent.latencyEwmaMs = Math.round(ewmaMs);
        var payload = unwrap(json);
        if (!payload || !payload.answers) {
          throw new Error(
            "provider response has no answers: " +
              JSON.stringify(json).slice(0, 200),
          );
        }
        return { answers: payload.answers, raw: payload, ms: ms };
      })
      .catch(function (err) {
        clearTimeout(timer);
        if (err && err.name == "AbortError") {
          err.message =
            "request timed out after " + pacmanAgent.settings.timeoutMs + "ms";
        }
        throw err;
      });
  };
})();
