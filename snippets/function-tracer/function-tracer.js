/* DevTools Snippet: Function Call Tracer (auto-start)
 * - Traces same-origin, non-library functions
 * - Logs call order, +Δms, callee path, and caller file:line:col
 *
 * Usage
 *  1) DevTools → Sources → Snippets → paste and Run.
 *  2) Auto-starts by default.
 *     - To disable auto-start: set `window.__FNTRACE_AUTOSTART = false` before running.
 *  3) Override config before running:
 *     `window.__FNTRACE_CFG = { excludeLibRe: /yourLib/i, maxWrap: 500 }`
 *
 * API
 *  - __FNTRACE.start()  : (re)start tracing
 *  - __FNTRACE.stop()   : restore originals and stop tracing
 *  - __FNTRACE.dump()   : print a summary table of captured calls
 *  - __FNTRACE.clear()  : clear in-memory logs
 *  - __FNTRACE.cfg      : the active config object
 */
(() => {
  if (window.__FNTRACE?.on) {
    console.log("[fn-tracer] already running");
    return;
  }

  const DEFAULT_CFG = {
    maxWrap: 800,
    maxDepth: 3,
    includeSameOriginOnly: true,
    // Exclude common library paths/names by regex (tweak per project)
    excludeLibRe: /\b(jquery|bootstrap|highcharts|slick|react|preact|vue|angular|lodash|underscore|moment|dayjs|gtag|ga|hotjar|amplitude|kakao|naver|daum|d3|three|chart|tabulator)\b/i,
    // Exclude minified/legacy files by default
    excludeSrcRe: /\.(min|legacy)\.js($|\?)/i,
    // Heuristics to prioritize traversal (global namespaces you expect)
    namespaceHints: ["App", "APP", "app", "NS", "Project"],
    // Logging options
    showArgs: true,
    maxArgLen: 120,
  };

  // Allow overriding via `window.__FNTRACE_CFG` before snippet execution
  const CFG = Object.assign({}, DEFAULT_CFG, (window.__FNTRACE_CFG || {}));

  const state = {
    on: false,
    seq: 0,
    t0: performance.now(),
    logs: [],
    wrappers: new WeakMap(),
    originals: new WeakMap(),
    owners: new WeakMap(),
    allowedScripts: new Map(),
    wrappedPaths: new Map(),
    replacedProps: [],
  };

  const norm = (s) =>
    (s || "")
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*\n/g, "\n")
      .replace(/\s+/g, "");
  const short = (s, n = CFG.maxArgLen) =>
    (s && s.length > n ? s.slice(0, n) + "…" : s);
  const isFunc = (v) => typeof v === "function";
  const isObj = (v) => v && typeof v === "object";

  function parseStack(err) {
    const lines = String(err.stack || "").split("\n").slice(1);
    const frames = [];
    for (const L of lines) {
      const m = L.match(/\s*at\s+(?:[^\(]+\s+\()?(.*?):(\d+):(\d+)\)?/);
      if (m) frames.push({ url: m[1], line: +m[2], col: +m[3] });
    }
    return frames;
  }

  function isAllowedScriptUrl(url) {
    try {
      const u = new URL(url, location.href);
      if (CFG.includeSameOriginOnly && u.origin !== location.origin) return false;
      const path = u.pathname || "";
      if (CFG.excludeLibRe.test(path)) return false;
      if (CFG.excludeSrcRe.test(path)) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function loadAllowedScripts() {
    const scripts = Array.from(document.scripts).filter(
      (s) => s.src && isAllowedScriptUrl(s.src)
    );
    const targets = Array.from(new Set(scripts.map((s) => s.src)));
    if (!targets.length) {
      console.log(
        "[fn-tracer] no same-origin non-lib scripts found; callbacks will still be traced."
      );
      return;
    }
    for (const src of targets) {
      try {
        const res = await fetch(src, { credentials: "same-origin" });
        const txt = await res.text();
        state.allowedScripts.set(src, norm(txt));
      } catch (e) {
        console.warn("[fn-tracer] failed to fetch", src, e);
      }
    }
  }

  function guessOwner(func) {
    if (!isFunc(func)) return null;
    if (state.owners.has(func)) return state.owners.get(func) || null;

    let src;
    try {
      src = norm(Function.prototype.toString.call(func));
    } catch {
      src = "";
    }

    let owner = null;
    if (src && src !== "function(){}" && !/\[native code\]/.test(src)) {
      for (const [url, body] of state.allowedScripts) {
        if (body.includes(src)) {
          owner = url;
          break;
        }
      }
    }
    state.owners.set(func, owner);
    return owner;
  }

  function wrapFunction(path, obj, key, fn) {
    if (!isFunc(fn)) return fn;
    if (state.wrappers.has(fn)) return state.wrappers.get(fn); // already wrapped original

    const owner = guessOwner(fn);
    if (!owner) return fn; // skip if not found in allowed same-origin sources

    const wrapper = function (...args) {
      const t = performance.now();
      const frames = parseStack(new Error());
      const caller =
        frames.find((f) => isAllowedScriptUrl(f.url)) ||
        frames[0] ||
        { url: "?", line: 0, col: 0 };
      const seq = ++state.seq;
      const dt = (t - state.t0).toFixed(1);

      let argSketch = "";
      if (CFG.showArgs) {
        try {
          argSketch = short(
            JSON.stringify(args, (k, v) =>
              typeof v === "function"
                ? `ƒ(${v.name || "anonymous"})`
                : v instanceof Element
                ? `<${v.tagName.toLowerCase()}…>`
                : v
            )
          );
        } catch {
          argSketch = "[args]";
        }
      }

      state.logs.push({ seq, dt: +dt, path, owner, caller });
      console.log(
        `[fn-trace #${seq} +${dt}ms] ${path} → (${caller.url}:${caller.line}:${caller.col}) args=${argSketch}`
      );

      return fn.apply(this, args);
    };

    try {
      state.wrappers.set(fn, wrapper);
      state.originals.set(wrapper, fn);
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc && desc.writable !== false && desc.configurable !== false) {
        state.replacedProps.push({ obj, key, value: fn });
        obj[key] = wrapper;
        state.wrappedPaths.set(wrapper, path);
      }
    } catch {
      // non-writable/non-configurable: skip
    }
    return wrapper;
  }

  function visitGlobals() {
    const seen = new WeakSet();
    const queue = [{ obj: window, path: "window", depth: 0 }];

    const shouldVisitKey = (k) =>
      typeof k === "string" &&
      // Heuristics: visit likely namespaces and global functions
      (k.startsWith("_") ||
        k.toUpperCase() === k ||
        CFG.namespaceHints.includes(k) ||
        true);

    let wrapped = 0;

    while (queue.length) {
      const { obj, path, depth } = queue.shift();
      if (!isObj(obj) && !isFunc(obj)) continue;
      if (seen.has(obj)) continue;
      seen.add(obj);

      const names = Object.getOwnPropertyNames(obj);
      for (const key of names) {
        if (!shouldVisitKey(key)) continue;

        let val;
        try {
          val = obj[key];
        } catch {
          continue;
        }

        const childPath = `${path}.${key}`;

        if (isFunc(val)) {
          if (wrapped >= CFG.maxWrap) return wrapped;
          const w = wrapFunction(childPath, obj, key, val);
          if (w !== val) wrapped++;
        } else if (isObj(val) && depth < CFG.maxDepth) {
          // Avoid descending into obvious library namespaces
          if (CFG.excludeLibRe.test(String(key))) continue;
          queue.push({ obj: val, path: childPath, depth: depth + 1 });
        }
      }
      if (wrapped >= CFG.maxWrap) break;
    }
    return wrapped;
  }

  // Callback entrypoint hooks (wrap newly registered callbacks only)
  function wrapCallback(cb, label) {
    if (!isFunc(cb)) return cb;
    if (state.wrappers.has(cb)) return state.wrappers.get(cb);

    const owner = guessOwner(cb);
    if (!owner) return cb;

    const wrapped = function (...args) {
      const t = performance.now();
      const frames = parseStack(new Error());
      const caller =
        frames.find((f) => isAllowedScriptUrl(f.url)) ||
        frames[0] ||
        { url: "?", line: 0, col: 0 };
      const seq = ++state.seq;
      const dt = (t - state.t0).toFixed(1);
      const name = cb.name || "anonymous";

      state.logs.push({
        seq,
        dt: +dt,
        path: `${label}<${name}>`,
        owner,
        caller,
      });
      console.log(
        `[fn-trace #${seq} +${dt}ms] ${label}<${name}> → (${caller.url}:${caller.line}:${caller.col})`
      );
      return cb.apply(this, args);
    };

    state.wrappers.set(cb, wrapped);
    state.originals.set(wrapped, cb);
    return wrapped;
  }

  function installCallbackHooks() {
    // addEventListener
    const _add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      return _add.call(this, type, wrapCallback(listener, `event:${type}`), opts);
    };

    // timers
    const _setT = window.setTimeout,
      _setI = window.setInterval;
    window.setTimeout = (cb, ms, ...rest) =>
      _setT(wrapCallback(cb, "setTimeout"), ms, ...rest);
    window.setInterval = (cb, ms, ...rest) =>
      _setI(wrapCallback(cb, "setInterval"), ms, ...rest);

    // rAF
    const _raf = window.requestAnimationFrame;
    if (_raf) {
      window.requestAnimationFrame = (cb) =>
        _raf(wrapCallback(cb, "rAF"));
    }

    // For restoration
    state.replacedProps.push({
      obj: EventTarget.prototype,
      key: "addEventListener",
      value: _add,
    });
    state.replacedProps.push({ obj: window, key: "setTimeout", value: _setT });
    state.replacedProps.push({ obj: window, key: "setInterval", value: _setI });
    if (_raf)
      state.replacedProps.push({
        obj: window,
        key: "requestAnimationFrame",
        value: _raf,
      });
  }

  function uninstallAll() {
    // Restore replaced properties in reverse order
    for (const rec of state.replacedProps.reverse()) {
      try {
        rec.obj[rec.key] = rec.value;
      } catch {}
    }
    state.replacedProps.length = 0;
    state.wrappers = new WeakMap();
    state.originals = new WeakMap();
  }

  async function start() {
    if (state.on) {
      console.log("[fn-tracer] already on");
      return;
    }
    state.on = true;
    state.seq = 0;
    state.t0 = performance.now();
    state.logs.length = 0;

    await loadAllowedScripts();   // collect same-origin script texts
    installCallbackHooks();       // hook entrypoints for new callbacks
    const n = visitGlobals();     // wrap global/namespace functions

    console.log(
      `[fn-tracer] ready. wrapped functions: ${n}, hooks installed. Use __FNTRACE.dump().`
    );
  }

  function stop() {
    uninstallAll();
    state.on = false;
    console.log("[fn-tracer] stopped and restored.");
  }

  function dump() {
    if (!state.logs.length) {
      console.log("[fn-trace] <no calls>");
      return;
    }
    const rows = state.logs.map(({ seq, dt, path, owner, caller }) => ({
      "#": seq,
      "+ms": dt,
      callee: path,
      owner: (() => {
        try {
          return new URL(owner, location.href).pathname;
        } catch {
          return "?";
        }
      })(),
      caller: `${caller.url}:${caller.line}:${caller.col}`,
    }));
    console.table(rows);
    console.log(
      "[fn-tracer] Tip: Click a row, then ⌘/Ctrl+O and paste the caller URL to jump."
    );
  }

  function clear() {
    state.logs.length = 0;
    console.log("[fn-tracer] log cleared.");
  }

  window.__FNTRACE = { start, stop, dump, clear, cfg: CFG, on: true };

  // --- Auto-start ---
  const AUTOSTART =
    typeof window.__FNTRACE_AUTOSTART === "boolean"
      ? window.__FNTRACE_AUTOSTART
      : true;

  if (AUTOSTART) {
    // Defer to next microtask to allow last-moment CFG overrides
    Promise.resolve().then(start);
    console.log(
      "%c[fn-tracer] auto-start scheduled. (__FNTRACE.start/stop/dump available)",
      "color:#09f"
    );
  } else {
    console.log(
      "%c[fn-tracer] loaded. Auto-start disabled; run __FNTRACE.start() manually.",
      "color:#09f"
    );
  }
})();
