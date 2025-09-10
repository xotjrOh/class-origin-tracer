/* Be sure to name the file child-origin-tracer.js.
Child-change origin tracer v3 — noise-suppressed, iframe-aware, origin-focused
(Uses arguments.callee; no 'use strict')
*/
(function () {
  const __SELF_FN__ = arguments.callee;

  if (window.__CHILDTRACEv1?.on) {
    console.log("[child-origin-tracer] already running");
    return;
  }

  // --------------------------- Config ---------------------------
  const CFG = {
    windowMs: 1200,
    perElMax: 24,
    verbose: false,              // show decision table/buffer
    showStacks: "none",          // 'none' | 'origin'
    ctxLines: 2,

    crossFrameInject: true,      // auto-inject into same-origin iframes
    bridgeToParent: false,       // postMessage to parent
    bridgeSuppressLocal: true,   // when bridging from child frames, suppress local logs

    skipJQCore: true,            // skip true jQuery core/migrate files in callsite

    // ---- Noise / repetition filters (same semantics as class tracer)
    filter: {
      interval: { ignore: true,  showFirst: 1 }, // setInterval-originated changes
      raf:      { ignore: false, showFirst: 1 }, // requestAnimationFrame-originated
      timeout:  { ignore: false, showFirst: 1 }, // recursive setTimeout polling
      throttleMs: 250,            // suppress same signature within this window
      maxRepeats: 8,              // show at most N times per signature; -1 = unlimited
      summaryEvery: 50,           // print a 1-line summary every K suppressions
      reportSuppressed: false     // print suppression summaries
    },
  };

  // deep-merge for CFG.set
  function isPlain(o){ return o && typeof o==='object' && o.constructor===Object; }
  function deepMerge(t, s){
    for(const k in s){
      if(isPlain(s[k])){ if(!isPlain(t[k])) t[k]={}; deepMerge(t[k], s[k]); }
      else t[k]=s[k];
    } return t;
  }

  const now = () => performance.now();

  // ── per-parent operation buffer (keyed by the *parent* whose children change)
  const OPS = new WeakMap();

  // scheduler & dedupe state
  const ST = {
    inInterval: false,
    inTimeout:  false,
    inRAF:      false,
    timersWrapped: false,
    firstShown: { interval:0, timeout:0, raf:0 },
    sigs: new Map(), // sig -> {count, lastTs, suppressed}
  };

  function pushOp(el, rec) {
    if (!el || typeof el !== "object") return;

    const s = rec.site;
    if (!s || !s.url) return;
    if (/snippet:\/\/|chrome-extension:|extensions::/i.test(s.url)) return;

    let arr = OPS.get(el);
    if (!arr) { arr = []; OPS.set(el, arr); }
    arr.push(rec);
    if (arr.length > CFG.perElMax) arr.shift();
  }

  // ── callsite picker (VM/eval 낮은 우선순위, same/virtual/code-looking 가중치)
  function pickCallsite(stack) {
    if (!stack) return null;

    const L = stack.split("\n").map(s => s.trim());
    const host = location.host;

    const RE_PAREN        = /\((.+?)(?=:\d+(?::\d+)*\)\s*$):(\d+)(?::(\d+))?(?::\d+)*\)\s*$/;
    const RE_BARE         = /(?:^|\s)([^\s()]+?)(?=:\d+(?::\d+)*\s*$):(\d+)(?::(\d+))?(?::\d+)*\s*$/;
    const RE_VM_WITH_FILE = /VM\d+\s+([^\s)]+?)(?=:\d+(?::\d+)*\)?\s*$):(\d+)(?::(\d+))?(?::\d+)*\)?$/;
    const RE_VM_SIMPLE    = /(VM\d+):(\d+)(?::(\d+))?(?::\d+)*\)?$/;
    const VIRTUAL         = /^(webpack|webpack-internal|rollup|vite|parcel|ng|blob|file|node):/i;

    const SELF_FILES = ["child-origin-tracer.js", "childObserver.js", "class-origin-tracer.js"];
    const ESC = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const RE_JQ_CORE_EXACT = /(?:^|[\/])jquery(?:\.slim)?(?:-\d+\.\d+\.\d+)?(?:\.min)?\.js(?:[?#].*)?$/i;
    const RE_JQ_MIG_EXACT  = /(?:^|[\/])jquery(?:[.-]migrate)(?:-\d+\.\d+\.\d+)?(?:\.min)?\.js(?:[?#].*)?$/i;
    const isJQCore = (url) => RE_JQ_CORE_EXACT.test(url) || RE_JQ_MIG_EXACT.test(url);

    const RE_SKIP_LINE = new RegExp(
      ["chrome-extension:", "extensions::", "snippet:\\/\\/", "__TRACEv1[0-9]", ...SELF_FILES.map(ESC)].join("|"), "i"
    );

    const frames = [];

    for (let i = 2; i < L.length; i++) {
      const ln = L[i];
      if (RE_SKIP_LINE.test(ln)) continue;

      const isEvalAnon = /^at (eval|<anonymous>)/.test(ln);

      let m = ln.match(RE_VM_WITH_FILE);
      if (m) {
        const url = m[1], line = +m[2], col = m[3] != null ? +m[3] : 0;
        if (CFG.skipJQCore && isJQCore(url)) continue;
        if (SELF_FILES.some(f => url.toLowerCase().includes(f.toLowerCase()))) continue;
        const isVirtual = true, isRelative = !/^[a-z]+:/i.test(url);
        const same = url.includes(host) || isVirtual || isRelative;
        const code = /\.(m?js|cjs|jsx|ts|tsx|jsp)(?:\?|#|$)/i.test(url) || isVirtual;
        frames.push({ url, line, col, raw: ln, vm: true, evalAnon: isEvalAnon, same, code });
        continue;
      }

      m = ln.match(RE_VM_SIMPLE);
      if (m) {
        const url = m[1], line = +m[2], col = m[3] != null ? +m[3] : 0;
        frames.push({ url, line, col, raw: ln, vm: true, evalAnon: isEvalAnon, same: true, code: true, weak: true });
        continue;
      }

      m = ln.match(RE_PAREN) || ln.match(RE_BARE);
      if (!m) continue;

      const url = m[1], line = +m[2], col = m[3] != null ? +m[3] : 0;
      if (CFG.skipJQCore && isJQCore(url)) continue;
      if (SELF_FILES.some(f => url.toLowerCase().includes(f.toLowerCase()))) continue;

      const isVirtual = VIRTUAL.test(url);
      const isRelative = !/^[a-z]+:/i.test(url);
      const same = url.includes(host) || isVirtual || isRelative;
      const code = /\.(m?js|cjs|jsx|ts|tsx|jsp)(?:\?|#|$)/i.test(url) || isVirtual;

      frames.push({ url, line, col, raw: ln, vm: false, evalAnon: isEvalAnon, same, code });
    }

    if (!frames.length) return null;

    function weight(f) {
      let w = 0;
      if (f.same) w += 4;
      if (f.code) w += 2;
      if (!f.weak) w += 1;
      if (f.evalAnon) w -= 6;
      return w;
    }

    frames.sort((a, b) => (weight(b) - weight(a)));
    const f = frames[0];
    return { url: f.url, line: f.line, col: f.col, raw: f.raw, vm: !!f.vm };
  }

  function cssPath(el) {
    try {
      if (!el || el.nodeType !== 1) return "";
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        let p = el.tagName.toLowerCase();
        if (el.id) { parts.unshift(p + "#" + el.id); break; }
        const cls = (el.className || "").toString().trim().split(/\s+/).filter(Boolean);
        if (cls.length) p += "." + cls.slice(0, 2).join(".");
        if (el.parentElement) {
          const sib = Array.from(el.parentElement.children).filter(n => n.tagName === el.tagName);
          if (sib.length > 1) {
            const idx = Array.prototype.indexOf.call(el.parentElement.children, el) + 1;
            p += `:nth-child(${idx})`;
          }
        }
        parts.unshift(p);
        el = el.parentElement;
      }
      return parts.join(" > ");
    } catch { return "(path)"; }
  }

  // ── helpers for node labels in logs
  function nodeLabel(n) {
    try {
      if (!n) return "(null)";
      switch (n.nodeType) {
        case 1: {
          const tag = n.tagName?.toLowerCase() || "el";
          const id = n.id ? "#" + n.id : "";
          const cl = (n.className || "").toString().trim().split(/\s+/).filter(Boolean);
          const cls = cl.length ? "." + cl.slice(0, 2).join(".") : "";
          return `${tag}${id}${cls}`;
        }
        case 3: return "#text(len=" + (n.nodeValue?.length || 0) + ")";
        case 8: return "<!--comment-->";
        case 11: return "#fragment";
        default: return "(nodeType " + n.nodeType + ")";
      }
    } catch { return "(node)"; }
  }

  // --------------------------- Scheduler wrappers ----------------
  ;(function wrapSchedulers(){
    if (ST.timersWrapped) return;
    ST.timersWrapped = true;

    // setInterval
    const SI0 = window.setInterval;
    if (typeof SI0 === "function" && !SI0.__childtrace_wrapped) {
      window.setInterval = function(fn, delay) {
        if (typeof fn !== "function") return SI0.apply(this, arguments);
        const wrap = function(){ ST.inInterval = true; try { return fn.apply(this, arguments); } finally { ST.inInterval = false; } };
        const id = SI0.call(this, wrap, delay);
        try { Object.defineProperty(window.setInterval, "__childtrace_wrapped", {value:true}); } catch {}
        return id;
      };
    }

    // setTimeout
    const ST0 = window.setTimeout;
    if (typeof ST0 === "function" && !ST0.__childtrace_wrapped) {
      window.setTimeout = function(fn, delay) {
        if (typeof fn !== "function") return ST0.apply(this, arguments);
        const wrap = function(){ ST.inTimeout = true; try { return fn.apply(this, arguments); } finally { ST.inTimeout = false; } };
        const id = ST0.call(this, wrap, delay);
        try { Object.defineProperty(window.setTimeout, "__childtrace_wrapped", {value:true}); } catch {}
        return id;
      };
    }

    // requestAnimationFrame
    const RAF0 = window.requestAnimationFrame;
    if (typeof RAF0 === "function" && !RAF0.__childtrace_wrapped) {
      window.requestAnimationFrame = function(fn) {
        if (typeof fn !== "function") return RAF0.apply(this, arguments);
        const wrap = function(ts){ ST.inRAF = true; try { return fn.call(this, ts); } finally { ST.inRAF = false; } };
        const id = RAF0.call(this, wrap);
        try { Object.defineProperty(window.requestAnimationFrame, "__childtrace_wrapped", {value:true}); } catch {}
        return id;
      };
    }
  })();

  // --------------------------- Matching / Logs -------------------
  const KIND_RANK = {
    // DOM
    "appendChild": 10, "insertBefore": 10, "removeChild": 10,
    "replaceChild(+)": 10, "replaceChild(-)": 10,
    "Element.append": 9, "Element.prepend": 9, "Element.before": 9, "Element.after": 9,
    "ChildNode.remove": 10, "innerHTML=": 6, "outerHTML=": 6,
    // jQuery
    "jQuery.append": 8, "jQuery.prepend": 8, "jQuery.before": 8, "jQuery.after": 8,
    "jQuery.html(set)": 6, "jQuery.remove": 8, "jQuery.detach": 8, "jQuery.empty": 8,
  };

  function score(rec, want) {
    let s = (KIND_RANK[rec.kind] || 1) * 10;
    if (want && rec.sign === want) s += 30;   // prefer matching +/-
    if (rec.sign === "?") s -= 25;            // '?' is lowest priority
    const age = now() - rec.t;
    s += Math.max(0, 5 - age / 300);          // slight recency bias
    return s;
  }

  function pickOriginForChildMutation(target, addedNodes, removedNodes) {
    const t = now();
    const added = Array.from(addedNodes || []);
    const removed = Array.from(removedNodes || []);

    const want =
      removed.length && !added.length ? "-" :
      added.length && !removed.length ? "+" : null;

    const arr = (OPS.get(target) || []).filter((r) => t - r.t <= CFG.windowMs);
    if (!arr.length) return null;

    // 1) prefer exact sign
    let pool = want ? arr.filter(r => r.sign === want) : [];
    // 2) otherwise non-'?' (i.e., + or - of any)
    if (!pool.length) pool = arr.filter(r => r.sign !== "?");
    // 3) finally include '?' as fallback
    if (!pool.length) pool = arr.slice();

    let best = null, bestS = -1, considered = [];
    for (let i = pool.length - 1; i >= 0; i--) {
      const r = pool[i];
      const sc = score(r, want);
      considered.push({ r, sc });
      if (sc > bestS) { bestS = sc; best = r; }
    }
    return { origin: best, considered, poolAll: arr };
  }

  function logStacks(prefix, rec) {
    if (CFG.showStacks === "none") return;
    console.groupCollapsed(`%c[STACKS]%c ${prefix}`, "color:#a6f", "color:inherit");
    if (rec.stackRaw) {
      console.groupCollapsed("origin stack");
      console.log(rec.stackRaw);
      console.groupEnd();
    }
    console.groupEnd();
  }

  // url:line[:col] — show col only when present to avoid ':0'
  function fmtAt(site) {
    if (!site || !site.url) return "(site?)";
    const line = Number.isFinite(site.line) ? site.line : 0;
    const col  = Number.isFinite(site.col)  ? site.col  : 0;
    const vmTag = site.vm ? " [vm]" : "";
    return `@ ${site.url}:${line}${col ? `:${col}` : ""}${vmTag}`;
  }

  function logOrigin(o) {
    console.groupCollapsed("%corigin %s", "color:#0af", o.kind);
    if (o.site) console.log(fmtAt(o.site));
    console.groupEnd();
    logStacks("origin", o);
  }

  function logDecision(considered) {
    if (!CFG.verbose) return;
    console.groupCollapsed("%c[MATCH] decision trace", "color:#0af");
    const rows = considered.map(({ r, sc }) => ({
      kind: r.kind,
      sign: r.sign,
      nAdd: r.nAdd || 0,
      nRem: r.nRem || 0,
      age_ms: Math.round(now() - r.t),
      at: fmtAt(r.site),
      score: Math.round(sc),
    }));
    console.table(rows);
    console.groupEnd();
  }

  // --------------------------- DOM hooks (child mutations) -------
  (function hookDOM() {
    function wrap(obj, key, fnName, sign) {
      const orig = obj && obj[key];
      if (typeof orig !== "function") return;
      if (orig.__childtrace_wrapped) return;
      const wrapped = function () {
        try {
          const raw = new Error().stack;
          let parent = null;
          let nAdd = 0, nRem = 0;

          switch (fnName) {
            case "appendChild":
            case "insertBefore":
              parent = this;
              nAdd = arguments[0] && arguments[0].nodeType === 11 ? arguments[0].childNodes.length : 1;
              break;
            case "removeChild":
              parent = this;
              nRem = 1;
              break;
            case "replaceChild": {
              parent = this;
              const newNode = arguments[0];
              pushOp(parent, { t: now(), kind: "replaceChild(-)", sign: "-", site: pickCallsite(raw), stackRaw: raw, nRem: 1 });
              pushOp(parent, { t: now(), kind: "replaceChild(+)", sign: "+", site: pickCallsite(raw), stackRaw: raw,
                               nAdd: (newNode && newNode.nodeType === 11) ? newNode.childNodes.length : 1 });
              break;
            }
            case "Element.append":
            case "Element.prepend":
            case "Element.before":
            case "Element.after": {
              parent = (/before|after/.test(fnName)) ? this.parentElement : this;
              let cnt = 0;
              for (let i = 0; i < arguments.length; i++) {
                const a = arguments[i];
                if (!a) continue;
                if (a.nodeType) cnt += (a.nodeType === 11) ? a.childNodes.length : 1;
                else cnt += 1; // string/number → text node
              }
              nAdd = cnt;
              break;
            }
            case "ChildNode.remove":
              parent = this.parentElement || this.parentNode || null;
              nRem = 1;
              break;
            case "innerHTML=":
            case "outerHTML=":
              parent = (fnName === "outerHTML=") ? (this.parentElement || this.parentNode) : this;
              break;
          }

          if (fnName !== "replaceChild") {
            if (parent) {
              pushOp(parent, { t: now(), kind: fnName, sign, site: pickCallsite(raw), stackRaw: raw, nAdd: nAdd || 0, nRem: nRem || 0 });
            }
          }
        } catch {}
        return orig.apply(this, arguments);
      };
      try { wrapped.__childtrace_wrapped = true; obj[key] = wrapped; } catch {}
    }

    // Core DOM methods
    wrap(Node.prototype, "appendChild", "appendChild", "+");
    wrap(Node.prototype, "insertBefore", "insertBefore", "+");
    wrap(Node.prototype, "removeChild", "removeChild", "-");
    wrap(Node.prototype, "replaceChild", "replaceChild", "?");

    // Element convenience methods
    if (Element && Element.prototype) {
      wrap(Element.prototype, "append",  "Element.append",  "+");
      wrap(Element.prototype, "prepend", "Element.prepend", "+");
      wrap(Element.prototype, "before",  "Element.before",  "+");
      wrap(Element.prototype, "after",   "Element.after",   "+");
    }

    // ChildNode.remove (fallback)
    if (window.ChildNode && ChildNode.prototype && ChildNode.prototype.remove) {
      wrap(ChildNode.prototype, "remove", "ChildNode.remove", "-");
    } else if (Element && Element.prototype && Element.prototype.remove) {
      wrap(Element.prototype, "remove", "ChildNode.remove", "-");
    }

    // innerHTML / outerHTML setters
    function wrapSetter(proto, prop, tag) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set || d.__childtrace_wrapped) return;
      const set0 = d.set, get0 = d.get;
      Object.defineProperty(proto, prop, {
        configurable: true,
        get: get0,
        set: function (v) {
          try {
            const raw = new Error().stack;
            const parent = (tag === "outerHTML=") ? (this.parentElement || this.parentNode) : this;
            if (parent) pushOp(parent, { t: now(), kind: tag, sign: "?", site: pickCallsite(raw), stackRaw: raw });
          } catch {}
          return set0.call(this, v);
        },
      });
      try {
        Object.defineProperty(proto, prop, { ...Object.getOwnPropertyDescriptor(proto, prop), __childtrace_wrapped: true });
      } catch {}
    }
    if (Element && Element.prototype) {
      wrapSetter(Element.prototype, "innerHTML", "innerHTML=");
      wrapSetter(Element.prototype, "outerHTML", "outerHTML=");
    }
  })();

  // --------------------------- jQuery hooks (manipulation) -------
  (function hookJQ(jq) {
    if (!jq || !jq.fn) return;
    const F = jq.fn;

    function pushEachParent($set, kind, sign, parentOfSelf = false) {
      const raw = new Error().stack;
      const st = pickCallsite(raw);
      for (let i = 0; i < $set.length; i++) {
        const el = $set[i];
        const parent = parentOfSelf ? (el.parentElement || el.parentNode) : el;
        if (parent) pushOp(parent, { t: now(), kind, sign, site: st, stackRaw: raw });
      }
    }

    if (F.append)  { const a0 = F.append;  F.append  = function(){ pushEachParent(this,"jQuery.append","+");  return a0.apply(this,arguments); }; }
    if (F.prepend) { const p0 = F.prepend; F.prepend = function(){ pushEachParent(this,"jQuery.prepend","+"); return p0.apply(this,arguments); }; }
    if (F.before)  { const b0 = F.before;  F.before  = function(){ pushEachParent(this,"jQuery.before","+",true); return b0.apply(this,arguments); }; }
    if (F.after)   { const a0 = F.after;   F.after   = function(){ pushEachParent(this,"jQuery.after","+",true);  return a0.apply(this,arguments); }; }
    if (F.html)    { const h0 = F.html;    F.html    = function(val){ if(arguments.length>0) pushEachParent(this,"jQuery.html(set)","?"); return h0.apply(this,arguments); }; }
    if (F.remove)  { const r0 = F.remove;  F.remove  = function(){ pushEachParent(this,"jQuery.remove","-",true); return r0.apply(this,arguments); }; }
    if (F.detach)  { const d0 = F.detach;  F.detach  = function(){ pushEachParent(this,"jQuery.detach","-",true); return d0.apply(this,arguments); }; }
    if (F.empty)   { const e0 = F.empty;   F.empty   = function(){ pushEachParent(this,"jQuery.empty","-");       return e0.apply(this,arguments); }; }

    try { if (jq.fn.jquery) console.log("[child-origin-tracer] jQuery hooked:", jq.fn.jquery); } catch {}
  })(window.jQuery || window.$);

  // --------------------------- Suppression helpers ---------------
  function signatureOf(target, added, removed, site){
    const siteKey = site ? (site.url + ":" + site.line + ":" + (site.col ?? "")) : "(no-site)";
    const tgt = (target && (target.id ? "#"+target.id : target.tagName?.toLowerCase() || "")) || "(parent)";
    const aCount = added.length, rCount = removed.length;
    // include first labels to distinguish different dynamic areas
    const aSig = added.slice(0,2).map(nodeLabel).join(",");
    const rSig = removed.slice(0,2).map(nodeLabel).join(",");
    return `${siteKey} :: ${tgt} :: +${aCount}[${aSig}] -${rCount}[${rSig}]`;
  }

  function allowFirst(schedKey) {
    const opt = CFG.filter?.[schedKey];
    if (!opt || !opt.ignore) return true;
    const n = +opt.showFirst || 0;
    if (ST.firstShown[schedKey] < n) { ST.firstShown[schedKey]++; return true; }
    return false;
  }

  function shouldSuppress(sig) {
    const t = now();

    // scheduler-based suppression
    if (CFG.filter.interval.ignore && ST.inInterval && !allowFirst("interval")) return {suppress:true, reason:"interval"};
    if (CFG.filter.raf.ignore      && ST.inRAF      && !allowFirst("raf"))      return {suppress:true, reason:"raf"};
    if (CFG.filter.timeout.ignore  && ST.inTimeout  && !allowFirst("timeout"))  return {suppress:true, reason:"timeout"};

    // signature-based throttling / cap
    let ent = ST.sigs.get(sig);
    if (!ent) { ent = {count:0, lastTs:0, suppressed:0}; ST.sigs.set(sig, ent); }

    if (CFG.filter.throttleMs && (t - ent.lastTs) < CFG.filter.throttleMs) {
      ent.suppressed++;
      return {suppress:true, reason:"throttle", ent};
    }

    if (CFG.filter.maxRepeats >= 0 && ent.count >= CFG.filter.maxRepeats) {
      ent.suppressed++;
      return {suppress:true, reason:"max", ent};
    }

    ent.count++;
    ent.lastTs = t;
    return {suppress:false, ent};
  }

  function suppressionSummary(ent, sig, reason) {
    if (!CFG.filter.reportSuppressed) return;
    if (!ent) return;
    const K = CFG.filter.summaryEvery || 0;
    if (K > 0 && ent.suppressed % K === 0) {
      const shortSig = sig.length > 160 ? sig.slice(0,160)+"…" : sig;
      console.info(`[child-origin-tracer] suppressed x${ent.suppressed} (${reason}) for ${shortSig}`);
    }
  }

  // --------------------------- Observer -------------------------
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type !== "childList") continue;

      const target = m.target;
      const added = Array.from(m.addedNodes || []).filter(n => n.nodeType !== 3 || (n.nodeValue || "").trim() !== "");
      const removed = Array.from(m.removedNodes || []).filter(n => n.nodeType !== 3 || (n.nodeValue || "").trim() !== "");
      if (added.length === 0 && removed.length === 0) continue;

      // pick origin first (needed for signature/site)
      const pick = pickOriginForChildMutation(target, m.addedNodes, m.removedNodes);
      const site = pick && pick.origin && pick.origin.site;

      // suppression guard
      const sig = signatureOf(target, added, removed, site);
      const sup = shouldSuppress(sig);
      if (sup.suppress) { suppressionSummary(sup.ent, sig, sup.reason); continue; }

      const addedPreview = added.slice(0, 3).map(nodeLabel).join(", ");
      const removedPreview = removed.slice(0, 3).map(nodeLabel).join(", ");

      const shouldBridgeOnly = CFG.bridgeToParent && window.top !== window && CFG.bridgeSuppressLocal !== false;

      // local output (skip in child when bridging-only)
      if (!shouldBridgeOnly) {
        console.groupCollapsed(
          "[CHILD]",
          cssPath(target),
          "\n→",
          added.length ? `+${added.length}${added.length ? ` [${addedPreview}${added.length>3?"…":""}]`:""}` : "",
          removed.length ? ` -${removed.length}${removed.length ? ` [${removedPreview}${removed.length>3?"…":""}]`:""}` : "",
        );
        console.log("parent node:", target);
        if (added.length)   console.log("%cadded   %s", "color:#0a0", added.map(nodeLabel).join(", "));
        if (removed.length) console.log("%cremoved %s", "color:#a00", removed.map(nodeLabel).join(", "));

        if (pick && pick.origin) {
          logDecision(pick.considered);
          logOrigin(pick.origin);
        } else {
          console.log("%corigin", "color:#888", "(no matching frame — likely initial render / iframe / eval / other window)");
        }
        console.groupEnd();
      }

      // parent forwarding
      if (CFG.bridgeToParent) {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              __CHILDTRACEv1: true,
              kind: "child-mutation",
              frame: (function(){ try { return window.frameElement?.id || window.frameElement?.name || "(iframe)"; } catch {} return "(iframe)"; })(),
              href: location.href,
              data: {
                target: cssPath(target),
                addedCount: added.length,
                removedCount: removed.length,
                addedPreview, removedPreview,
                origin: (pick && pick.origin)
                  ? { kind: pick.origin.kind, sign: pick.origin.sign, site: pick.origin.site }
                  : null
              }
            }, location.origin);
          }
        } catch {}
      }
    }
  });
  const ROOT = document.documentElement || document.body || document;
  obs.observe(ROOT, { subtree: true, childList: true });

  // --------------------------- Autoinject to same-origin iframes -
  (function __injectIntoSameOriginIframes__() {
    if (!CFG.crossFrameInject) return;

    function injectInto(iframe) {
      try {
        if (!iframe?.contentDocument) return;
        const w = iframe.contentWindow;
        const d = iframe.contentDocument;
        if (w.__CHILDTRACEv1?.on) return;                 // already running
        const s = d.createElement("script");
        s.textContent = `;(${__SELF_FN__.toString()})();`; // self-inject
        d.documentElement.appendChild(s);
      } catch {}
    }

    function scanAll() {
      document.querySelectorAll("iframe").forEach(ifr => {
        try { ifr.contentDocument; } catch { return; }     // cross-origin guard
        ifr.addEventListener("load", () => injectInto(ifr));
        if (ifr.contentDocument?.readyState === "complete") injectInto(ifr);
      });
    }

    const mo = new MutationObserver(muts => {
      muts.forEach(mu => mu.addedNodes && mu.addedNodes.forEach(n => {
        if (n.nodeName === "IFRAME") {
          try { n.contentDocument; } catch { return; }
          n.addEventListener("load", () => injectInto(n));
          if (n.contentDocument?.readyState === "complete") injectInto(n);
        }
      }));
    });

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scanAll, { once: true });
    } else {
      scanAll();
    }
    mo.observe(document.documentElement, { childList: true, subtree: true });
  })();

  // --------------------------- One-time HELP banner --------------
  function getTopSameOrigin() {
    try { void window.top.document; return window.top; } catch { return window; }
  }
  function printHelp() {
    console.groupCollapsed("%c[child-origin-tracer]%c Quick Start & Tips", "color:#0af;font-weight:bold", "color:inherit");
    console.log("• What you see:\n  - [CHILD] groups show parent path and # of added/removed nodes (+/-).\n  - 'origin ... @ file:line:col' is the best-guess callsite that mutated children.\n  - Open [STACKS] via __CHILDTRACEv1.debug() for origin stack.");
    console.log("• Basic controls:\n  - __CHILDTRACEv1.debug()  → verbose logs + origin stacks\n  - __CHILDTRACEv1.min()    → quiet mode (no stacks)\n  - __CHILDTRACEv1.stop()   → stop observing\n  - __CHILDTRACEv1.dump($0) → recent ops for the selected parent node");
    console.log("• Noise filters:\n  - __CHILDTRACEv1.set({filter:{interval:{ignore:true,showFirst:1}}})\n  - __CHILDTRACEv1.set({filter:{raf:{ignore:true}}})\n  - __CHILDTRACEv1.set({filter:{timeout:{ignore:true}}})\n  - __CHILDTRACEv1.set({filter:{throttleMs:300,maxRepeats:5}})\n  - __CHILDTRACEv1.resetDedupe() // clear repetition counters");
    console.log("• Centralize logs:\n  - __CHILDTRACEv1.set({bridgeToParent:true})  // forward child frame logs to TOP\n  - __CHILDTRACEv1.set({crossFrameInject:false}) // disable iframe auto-inject\n  - (default) bridgeSuppressLocal:true keeps child consoles quiet to avoid duplicates");
    console.groupEnd();
  }
  (function printHelpOnce() {
    const root = getTopSameOrigin();
    if (!root.__CHILDTRACE_HELP_SHOWN) {
      printHelp();
      try { root.__CHILDTRACE_HELP_SHOWN = true; } catch {}
    }
  })();

  // --------------------------- API -------------------------------
  window.__CHILDTRACEv1 = {
    on: true,
    CFG,
    set(opts = {}) { deepMerge(CFG, opts); console.log("[child-origin-tracer] cfg=", CFG); },
    min()   { this.set({ verbose: false, showStacks: "none" }); },
    debug() { this.set({ verbose: true,  showStacks: "origin" }); },
    stop()  { try { obs.disconnect(); } catch {} this.on = false; console.log("[child-origin-tracer] stopped"); },
    dump(el) {
      const arr = (OPS.get(el) || []).slice();
      console.table(arr.map((x) => ({
        kind: x.kind,
        sign: x.sign,
        nAdd: x.nAdd || 0,
        nRem: x.nRem || 0,
        at: fmtAt(x.site),
      })));
    },
    help() { printHelp(); },
    resetDedupe(){ ST.sigs.clear(); ST.firstShown={interval:0,timeout:0,raf:0}; console.log("[child-origin-tracer] repetition counters cleared"); },
    filterPreset(name){
      if(name==="aggressive"){
        this.set({filter:{interval:{ignore:true,showFirst:1},raf:{ignore:true,showFirst:1},timeout:{ignore:true,showFirst:0},throttleMs:300,maxRepeats:3}});
      } else if(name==="off"){
        this.set({filter:{interval:{ignore:false},raf:{ignore:false},timeout:{ignore:false},throttleMs:0,maxRepeats:-1}});
      }
    }
  };

  // Only a short banner in TOP (avoid spam in iframes)
  (function printRunningBannerOnce() {
    const root = getTopSameOrigin();
    if (!root.__CHILDTRACE_RUNNING_SHOWN) {
      console.log("[child-origin-tracer] running — try __CHILDTRACEv1.debug(), __CHILDTRACEv1.help(), or __CHILDTRACEv1.filterPreset('aggressive')");
      try { root.__CHILDTRACE_RUNNING_SHOWN = true; } catch {}
    }
  })();
})();

// Optional parent collector (top window only)
if (window.top === window) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    const m = e.data;
    if (!m || !m.__CHILDTRACEv1 || m.kind !== "child-mutation") return;
    const d = m.data || {};
    console.groupCollapsed(
      `%c[IFR:${m.frame}]%c ${d.target} → +${d.addedCount} -${d.removedCount}` +
      `${d.addedPreview ? ` [${d.addedPreview}${d.addedCount>3?"…":""}]` : ""}` +
      `${d.removedPreview ? ` [${d.removedPreview}${d.removedCount>3?"…":""}]` : ""}`,
      "color:#06f", "color:inherit"
    );
    console.log("href :", m.href);
    console.log("origin:", d.origin ? (`${d.origin.kind} ${d.origin.site ? '@ '+d.origin.site.url+':'+d.origin.site.line+(d.origin.site.col?':'+d.origin.site.col:'')+(d.origin.site.vm?' [vm]':'') : ''}`) : "(not matched)");
    console.groupEnd();
  });
}
