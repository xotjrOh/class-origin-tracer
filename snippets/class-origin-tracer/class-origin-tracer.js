/* Class-change origin tracer v20 — noise-suppressed (interval/RAF-aware), generic origin matching
   Notes:
   - Name the file class-origin-tracer.js.
   - Uses arguments.callee (no 'use strict')
*/
(function () {
  const __SELF_FN__ = arguments.callee;

  if (window.__TRACEv17?.on) {
    console.log("[class-origin-tracer] already running");
    return;
  }

  // --------------------------- Config ---------------------------
  const CFG = {
    windowMs: 1200,
    perElMax: 24,
    verbose: false,
    showStacks: "none",           // 'none' | 'origin'
    ctxLines: 2,

    crossFrameInject: true,       // auto-inject into same-origin iframes
    bridgeToParent: false,        // postMessage to parent
    bridgeSuppressLocal: true,    // when bridging from child frames, suppress local logs

    skipJQCore: true,             // skip true jQuery core/migrate files

    // ---- Noise / repetition filters
    filter: {
      interval: { ignore: true,  showFirst: 1 }, // ignore interval callbacks after first N
      raf:      { ignore: false, showFirst: 1 }, // requestAnimationFrame
      timeout:  { ignore: false, showFirst: 1 }, // setTimeout (recursive polling 등)
      throttleMs: 250,           // same-signature logs within this window are suppressed
      maxRepeats: 8,             // show at most N times per signature, then suppress
      summaryEvery: 50,          // every K suppressed, print 1-line summary
      reportSuppressed: true     // print suppression summaries
    },

    // ---- New: control where the "origin" group appears
    nestOriginUnderClass: false,  // false => print origin as a separate top-level group
  };

  // deep-merge helper for CFG.set
  function isPlain(o){ return o && typeof o==='object' && o.constructor===Object; }
  function deepMerge(t, s){
    for(const k in s){
      if(isPlain(s[k])){ if(!isPlain(t[k])) t[k]={}; deepMerge(t[k], s[k]); }
      else t[k]=s[k];
    } return t;
  }

  const now = () => performance.now();

  // --------------------------- State ----------------------------
  const OPS = new WeakMap();     // element -> [{t, kind, sign, classes[], site, stackRaw}]
  const CL2EL = new WeakMap();   // DOMTokenList -> owner Element
  const AS2EL = new WeakMap();   // SVGAnimatedString -> owner SVGElement

  // scheduler flags + signature cache
  const ST = {
    inInterval: false,
    inTimeout:  false,
    inRAF:      false,
    timersWrapped: false,
    firstShown: { interval:0, timeout:0, raf:0 },
    sigs: new Map(), // sig -> {count, lastTs, suppressed}
  };

  // --------------------------- Utils ----------------------------
  function splitClasses(s) { return ("" + (s || "")).trim().split(/\s+/).filter(Boolean); }
  function cssPath(el) {
    try {
      if (!el || el.nodeType !== 1) return "";
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        let p = el.tagName.toLowerCase();
        if (el.id) { parts.unshift(p + "#" + el.id); break; }
        const cls = splitClasses(el.className && el.className.baseVal != null ? el.className.baseVal : el.className || "");
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

  function pushOp(el, rec) {
    if (!el || typeof el !== "object") return;
    const s = rec.site || null;
    if (s && s.url && /snippet:\/\/|chrome-extension:|extensions::/i.test(s.url)) return;
    let arr = OPS.get(el);
    if (!arr) { arr = []; OPS.set(el, arr); }
    arr.push(rec);
    if (arr.length > CFG.perElMax) arr.shift();
  }

  function pickCallsite(stack) {
    if (!stack) return null;

    const L = stack.split("\n").map(s => s.trim());
    const host = location.host;

    const RE_PAREN        = /\(([^)\s]+):(\d+):(\d+)\)\s*$/;
    const RE_BARE         = /(?:^|\s)([^()\s]+):(\d+):(\d+)\s*$/;
    const RE_EVAL_PAREN   = /at eval .*?\(([^)\s]+):(\d+):(\d+)\)\s*$/;
    const RE_ANY_PAREN    = /at [^(]*\(([^)\s]+):(\d+):(\d+)\)\s*$/;
    const RE_VM_WITH_FILE = /VM\d+\s+([^\s)]+):(\d+):(\d+)\)?$/;
    const RE_VM_SIMPLE    = /(VM\d+):(\d+):(\d+)\)?$/;
    const VIRTUAL         = /^(webpack|webpack-internal|rollup|vite|parcel|ng|blob|file|node):/i;

    const SELF_FILES = ["class-origin-tracer.js", "child-origin-tracer.js"];
    const ESC = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const RE_SKIP_LINE = new RegExp(
      ["chrome-extension:", "extensions::", "snippet:\\/\\/", "__TRACEv1[0-9]", ...SELF_FILES.map(ESC)].join("|"),
      "i"
    );

    const RE_JQ_CORE_EXACT = /(?:^|[\/])jquery(?:\.slim)?(?:-\d+\.\d+\.\d+)?(?:\.min)?\.js(?:[?#].*)?$/i;
    const RE_JQ_MIG_EXACT  = /(?:^|[\/])jquery(?:[.-]migrate)(?:-\d+\.\d+\.\d+)?(?:\.min)?\.js(?:[?#].*)?$/i;
    const isJQCore = (url) => RE_JQ_CORE_EXACT.test(url) || RE_JQ_MIG_EXACT.test(url);

    const frames = [];
    for (let i = 2; i < L.length; i++) {
      const ln = L[i];
      if (RE_SKIP_LINE.test(ln)) continue;

      const isEvalAnon = /^at (eval|<anonymous>)/.test(ln);

      let m = ln.match(RE_VM_WITH_FILE);
      if (m) {
        const url = m[1], line = +m[2], col = +m[3];
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
        const url = m[1], line = +m[2], col = +m[3];
        frames.push({ url, line, col, raw: ln, vm: true, evalAnon: isEvalAnon, same: true, code: true, weak: true });
        continue;
      }

      m = ln.match(RE_PAREN) || ln.match(RE_EVAL_PAREN) || ln.match(RE_ANY_PAREN) || ln.match(RE_BARE);
      if (!m) continue;

      const url = m[1], line = +m[2], col = +m[3];
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

  // --------------------------- Hooks: DOM ------------------------
  (function hookDOM() {
    function hookClassListGetter(proto) {
      if (!proto) return;
      const d = Object.getOwnPropertyDescriptor(proto, "classList");
      if (!d || !d.get || d.__wrapped) return;
      const get0 = d.get;
      Object.defineProperty(proto, "classList", {
        configurable: true,
        get: function () {
          const list = get0.call(this);
          try { CL2EL.set(list, this); } catch {}
          return list;
        },
      });
    Object.defineProperty(proto, "classList", {
        ...Object.getOwnPropertyDescriptor(proto, "classList"),
        __wrapped: true,
      });
    }
    hookClassListGetter(HTMLElement.prototype);
    if (Element.prototype !== HTMLElement.prototype) hookClassListGetter(Element.prototype);
    if (window.SVGElement && SVGElement.prototype) hookClassListGetter(SVGElement.prototype);

    // Map SVGAnimatedString -> owner element via SVGElement.className getter
    try {
      if (window.SVGElement && SVGElement.prototype) {
        const d = Object.getOwnPropertyDescriptor(SVGElement.prototype, "className");
        if (d && d.get && !d.__wrapped) {
          const get0 = d.get;
          Object.defineProperty(SVGElement.prototype, "className", {
            configurable: true,
            get: function () {
              const v = get0.call(this);
              try { AS2EL.set(v, this); } catch {}
              return v;
            },
          });
          Object.defineProperty(SVGElement.prototype, "className", {
            ...Object.getOwnPropertyDescriptor(SVGElement.prototype, "className"),
            __wrapped: true,
          });
        }
      }
    } catch {}

    // DOMTokenList
    const DL = DOMTokenList.prototype;
    const add0 = DL.add, rem0 = DL.remove, tog0 = DL.toggle;

    DL.add = function () {
      try {
        const raw = new Error().stack;
        const el = this.ownerElement || CL2EL.get(this);
        pushOp(el, { t: now(), kind: "classList.add", sign: "+", classes: [...arguments], site: pickCallsite(raw), stackRaw: raw });
      } catch {}
      return add0.apply(this, arguments);
    };
    DL.remove = function () {
      try {
        const raw = new Error().stack;
        const el = this.ownerElement || CL2EL.get(this);
        pushOp(el, { t: now(), kind: "classList.remove", sign: "-", classes: [...arguments], site: pickCallsite(raw), stackRaw: raw });
      } catch {}
      return rem0.apply(this, arguments);
    };
    DL.toggle = function () {
      try {
        const raw = new Error().stack;
        const el = this.ownerElement || CL2EL.get(this);
        pushOp(el, { t: now(), kind: "classList.toggle", sign: "?", classes: [arguments[0]], site: pickCallsite(raw), stackRaw: raw });
      } catch {}
      return tog0.apply(this, arguments);
    };

    // setAttribute('class', ...)
    const setAttr0 = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, val) {
      if (name === "class") {
        try {
          const beforeStr =
            (this.className && this.className.baseVal != null) ? this.className.baseVal :
            (this.getAttribute && this.getAttribute("class")) || "";
          const afterStr = "" + (val || "");
          const before = new Set(splitClasses(beforeStr));
          const after  = new Set(splitClasses(afterStr));
          const added   = [...after].filter(c => !before.has(c));
          const removed = [...before].filter(c => !after.has(c));
          const raw = new Error().stack;
          const sign = added.length && !removed.length ? "+" :
                       removed.length && !added.length ? "-" : "?";
          const classes = [...added, ...removed];
          pushOp(this, { t: now(), kind: "setAttribute(class)", sign, classes, site: pickCallsite(raw), stackRaw: raw });
        } catch {}
      }
      return setAttr0.apply(this, arguments);
    };

    // setAttributeNS for class
    if (Element.prototype.setAttributeNS) {
      const setAttrNS0 = Element.prototype.setAttributeNS;
      Element.prototype.setAttributeNS = function (ns, name, val) {
        if ((!ns || ns === null) && name === "class") {
          try {
            const beforeStr =
              (this.className && this.className.baseVal != null) ? this.className.baseVal :
              (this.getAttribute && this.getAttribute("class")) || "";
            const afterStr = "" + (val || "");
            const before = new Set(splitClasses(beforeStr));
            const after  = new Set(splitClasses(afterStr));
            const added   = [...after].filter(c => !before.has(c));
            const removed = [...before].filter(c => !after.has(c));
            const raw = new Error().stack;
            const sign = added.length && !removed.length ? "+" :
                         removed.length && !added.length ? "-" : "?";
            const classes = [...added, ...removed];
            pushOp(this, { t: now(), kind: "setAttributeNS(class)", sign, classes, site: pickCallsite(raw), stackRaw: raw });
          } catch {}
        }
        return setAttrNS0.apply(this, arguments);
      };
    }

    // HTML-only className setter (SVG uses SVGAnimatedString)
    function wrapClassName(proto) {
      if (!proto) return;
      const d = Object.getOwnPropertyDescriptor(proto, "className");
      if (!d || !d.set || d.__wrapped) return;
      const set0 = d.set, get0 = d.get;
      Object.defineProperty(proto, "className", {
        configurable: true,
        get: get0,
        set: function (v) {
          try {
            const beforeStr = (this.getAttribute && (this.getAttribute("class") || "")) || "";
            const afterStr  = "" + v;
            const before = new Set(splitClasses(beforeStr));
            const after  = new Set(splitClasses(afterStr));
            const added   = [...after].filter(c => !before.has(c));
            const removed = [...before].filter(c => !after.has(c));
            const raw = new Error().stack;
            const sign = added.length && !removed.length ? "+" :
                         removed.length && !added.length ? "-" : "?";
            const classes = [...added, ...removed];
            pushOp(this, { t: now(), kind: "className=", sign, classes, site: pickCallsite(raw), stackRaw: raw });
          } catch {}
          return set0.call(this, v);
        },
      });
      Object.defineProperty(proto, "className", {
        ...Object.getOwnPropertyDescriptor(proto, "className"),
        __wrapped: true,
      });
    }
    wrapClassName(HTMLElement.prototype);
    if (Element.prototype !== HTMLElement.prototype) wrapClassName(Element.prototype);

    // SVGAnimatedString.baseVal = '...'
    try {
      if (window.SVGAnimatedString && SVGAnimatedString.prototype) {
        const dd = Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype, "baseVal");
        if (dd && dd.set && !dd.__wrapped) {
          const set0 = dd.set, get0 = dd.get;
          Object.defineProperty(SVGAnimatedString.prototype, "baseVal", {
            configurable: true,
            get: get0,
            set: function (v) {
              try {
                const owner = AS2EL.get(this) || this.ownerElement || null;
                const beforeStr = owner ? (owner.getAttribute("class") || "") :
                                  (typeof get0 === "function" ? ("" + (get0.call(this) || "")) : "");
                const raw = new Error().stack;
                const ret = set0.call(this, v);
                if (owner) {
                  const afterStr = owner.getAttribute("class") || "";
                  const before = new Set(splitClasses(beforeStr));
                  const after  = new Set(splitClasses(afterStr));
                  const added   = [...after].filter(c => !before.has(c));
                  const removed = [...before].filter(c => !after.has(c));
                  const sign = added.length && !removed.length ? "+" :
                               removed.length && !added.length ? "-" : "?";
                  const classes = [...added, ...removed];
                  if (classes.length) pushOp(owner, { t: now(), kind: "SVG.baseVal=", sign, classes, site: pickCallsite(raw), stackRaw: raw });
                }
                return ret;
              } catch { return set0.call(this, v); }
            }
          });
          Object.defineProperty(SVGAnimatedString.prototype, "baseVal", {
            ...Object.getOwnPropertyDescriptor(SVGAnimatedString.prototype, "baseVal"),
            __wrapped: true,
          });
        }
      }
    } catch {}
  })();

  // --------------------------- Hooks: jQuery ---------------------
  (function hookJQ(jq) {
    if (!jq || !jq.fn || !jq.fn.addClass) return;
    const F = jq.fn;
    const add0 = F.addClass, rem0 = F.removeClass, tog0 = F.toggleClass, attr0 = F.attr, prop0 = F.prop;

    function pushEach($set, kind, sign, classes, raw) {
      const t0 = now(), st = pickCallsite(raw);
      for (let i = 0; i < $set.length; i++)
        pushOp($set[i], { t: t0, kind, sign, classes: classes || [], site: st, stackRaw: raw });
    }

    F.addClass = function (cls) {
      const c = typeof cls === "string" ? splitClasses(cls) : [];
      const raw = new Error().stack;
      pushEach(this, "jQuery.addClass", "+", c, raw);
      return add0.apply(this, arguments);
    };
    F.removeClass = function (cls) {
      const raw = new Error().stack;
      let c = [];
      if (typeof cls === "string") c = splitClasses(cls);
      else if (cls == null) {
        this.each(function () {
          const cur = (this.getAttribute && this.getAttribute("class")) || "";
          const arr = splitClasses(cur);
          pushOp(this, { t: now(), kind: "jQuery.removeClass(all)", sign: "-", classes: arr, site: pickCallsite(raw), stackRaw: raw });
        });
      }
      pushEach(this, "jQuery.removeClass", "-", c, raw);
      return rem0.apply(this, arguments);
    };
    F.toggleClass = function (cls) {
      const c = typeof cls === "string" ? splitClasses(cls) : [];
      const raw = new Error().stack;
      pushEach(this, "jQuery.toggleClass", "?", c, raw);
      return tog0.apply(this, arguments);
    };
    F.attr = function (name, val) {
      const raw = new Error().stack;
      if (name === "class" && val != null)
        pushEach(this, "jQuery.attr(class)", "?", splitClasses("" + val), raw);
      return attr0.apply(this, arguments);
    };
    F.prop = function (name, val) {
      const raw = new Error().stack;
      if (/^className$/i.test(name) && val != null)
        pushEach(this, "jQuery.prop(className)", "?", splitClasses("" + val), raw);
      return prop0.apply(this, arguments);
    };
    console.log("[class-origin-tracer] jQuery hooked:", jq.fn.jquery);
  })(window.jQuery || window.$);

  // --------------------------- Matching / Logs -------------------
  const KIND_RANK = {
    "jQuery.addClass": 9,
    "jQuery.removeClass": 9,
    "jQuery.removeClass(all)": 9,
    "jQuery.toggleClass": 8,
    "classList.add": 9,
    "classList.remove": 9,
    "classList.toggle": 8,
    "jQuery.attr(class)": 6,
    "jQuery.prop(className)": 6,
    "setAttribute(class)": 6,
    "setAttributeNS(class)": 6,
    "className=": 6,
    "SVG.baseVal=": 7,
  };

  function score(rec, want, changes) {
    let s = (KIND_RANK[rec.kind] || 1) * 10;
    if (want && rec.sign === want) s += 30;
    if (rec.classes?.length && rec.classes.some(c => changes.includes(c))) s += 100;
    const age = now() - rec.t;
    s += Math.max(0, 5 - age / 300);
    return s;
  }

  function pickOriginForMutation(target, added, removed) {
    const t = now();
    const want = removed.length && !added.length ? "-" : added.length && !removed.length ? "+" : null;
    const arr = (OPS.get(target) || []).filter(r => t - r.t <= CFG.windowMs);
    const pool = arr.slice();
    if (!pool.length) return null;
    const changes = want === "-" ? removed : want === "+" ? added : [...added, ...removed];

    let best = null, bestS = -1, considered = [];
    for (let i = pool.length - 1; i >= 0; i--) {
      const r = pool[i];
      const sc = score(r, want, changes);
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

  function logOrigin(o) {
    const vmTag = o.site?.vm ? " [vm]" : "";
    const at = o.site ? `@ ${o.site.url}:${o.site.line}${o.site.col != null ? ":" + o.site.col : ""}${vmTag}` : "(site?)";
    console.groupCollapsed("%corigin %s %s", "color:#0af", o.kind, o.classes?.length ? `(${o.classes.join(" ")})` : "");
    if (o.site) console.log(at);
    console.groupEnd();
    logStacks("origin", o);
  }

  // --------------------------- Scheduler wrappers ----------------
  (function wrapSchedulers(){
    if (ST.timersWrapped) return;
    ST.timersWrapped = true;

    // setInterval
    const SI0 = window.setInterval;
    if (!SI0.__wrapped) {
      window.setInterval = function(fn, delay) {
        if (typeof fn !== "function") return SI0.apply(this, arguments);
        const wrap = function(){ ST.inInterval = true; try { return fn.apply(this, arguments); } finally { ST.inInterval = false; } };
        const id = SI0.call(this, wrap, delay);
        try { Object.defineProperty(window.setInterval, "__wrapped", {value:true}); } catch {}
        return id;
      };
    }

    // setTimeout
    const ST0 = window.setTimeout;
    if (!ST0.__wrapped) {
      window.setTimeout = function(fn, delay) {
        if (typeof fn !== "function") return ST0.apply(this, arguments);
        const wrap = function(){ ST.inTimeout = true; try { return fn.apply(this, arguments); } finally { ST.inTimeout = false; } };
        const id = ST0.call(this, wrap, delay);
        try { Object.defineProperty(window.setTimeout, "__wrapped", {value:true}); } catch {}
        return id;
      };
    }

    // requestAnimationFrame
    const RAF0 = window.requestAnimationFrame;
    if (typeof RAF0 === "function" && !RAF0.__wrapped) {
      window.requestAnimationFrame = function(fn) {
        if (typeof fn !== "function") return RAF0.apply(this, arguments);
        const wrap = function(ts){ ST.inRAF = true; try { return fn.call(this, ts); } finally { ST.inRAF = false; } };
        const id = RAF0.call(this, wrap);
        try { Object.defineProperty(window.requestAnimationFrame, "__wrapped", {value:true}); } catch {}
        return id;
      };
    }
  })();

  // --------------------------- Suppression / Signature -----------
  function signatureOf(target, added, removed, site){
    const siteKey = site ? (site.url + ":" + site.line + ":" + (site.col ?? "")) : "(no-site)";
    const tgt = (target && (target.id ? "#"+target.id : target.tagName?.toLowerCase() || "")) || "(node)";
    const a = added.slice().sort().join("|");
    const r = removed.slice().sort().join("|");
    return `${siteKey} :: ${tgt} :: +${a} -${r}`;
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
      console.info(`[class-origin-tracer] suppressed x${ent.suppressed} (${reason}) for ${shortSig}`);
    }
  }

  // --------------------------- Observer -------------------------
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type !== "attributes" || m.attributeName !== "class") continue;

      const before = splitClasses(m.oldValue || "");
      const after  = splitClasses((m.target.getAttribute && m.target.getAttribute("class")) ||
                                  (m.target.className && m.target.className.baseVal != null ? m.target.className.baseVal : ""));

      const b = new Set(before), a = new Set(after);
      const added   = after.filter(c => !b.has(c));
      const removed = before.filter(c => !a.has(c));
      if (!added.length && !removed.length) continue;

      // pick origin first (needed for signature)
      const pick = pickOriginForMutation(m.target, added, removed);
      const site = pick && pick.origin && pick.origin.site;

      // suppression guard
      const sig = signatureOf(m.target, added, removed, site);
      const sup = shouldSuppress(sig);
      if (sup.suppress) { suppressionSummary(sup.ent, sig, sup.reason); continue; }

      const shouldBridgeOnly = CFG.bridgeToParent && window.top !== window && CFG.bridgeSuppressLocal !== false;

      // local console output (skip in child when bridging-only)
      if (!shouldBridgeOnly) {
        let __originAfter = null; // collect to print after the [CLASS] group closes (top-level)

        console.groupCollapsed(
          "[CLASS]", cssPath(m.target), "\n→",
          added.length ? `+${added.join(",")}` : "",
          removed.length ? ` -${removed.join(",")}` : ""
        );
        console.log("node:", m.target);
        console.log("before:", before.join(" ") || "(none)");
        console.log("after :", after.join(" ") || "(none)");
        if (added.length)   console.log("%cadded   %s", "color:#0a0", added.join(" "));
        if (removed.length) console.log("%cremoved %s", "color:#a00", removed.join(" "));

        if (pick && pick.origin) {
          if (CFG.verbose) {
            console.groupCollapsed("%c[MATCH] decision trace", "color:#0af");
            console.table(pick.considered.map(({ r, sc }) => ({
              kind: r.kind, sign: r.sign, classes: (r.classes || []).join(" "),
              age_ms: Math.round(now() - r.t),
              at: r.site ? `${r.site.url}:${r.site.line}${r.site.col != null ? ":" + r.site.col : ""}${r.site.vm ? " [vm]" : ""}` : "(none)",
              score: Math.round(sc),
            })));
            console.groupEnd();
          }
          if (CFG.nestOriginUnderClass) {
            // legacy behavior: keep origin inside [CLASS]
            logOrigin(pick.origin);
          } else {
            // NEW: print after closing the [CLASS] group (top-level)
            __originAfter = pick.origin;
          }
        } else {
          console.log("%corigin", "color:#888", "(no matching frame — likely initial render / other window / eval)");
        }

        console.groupEnd();                // close [CLASS]
        if (__originAfter) logOrigin(__originAfter); // top-level origin group
      }

      // parent forwarding
      if (CFG.bridgeToParent) {
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({
              __TRACEv17: true,
              kind: "class-mutation",
              frame: (function(){ try { return window.frameElement?.id || window.frameElement?.name || "(iframe)"; } catch {} return "(iframe)"; })(),
              href: location.href,
              data: {
                target: cssPath(m.target),
                added, removed, before, after,
                origin: (pick && pick.origin)
                  ? { kind: pick.origin.kind, sign: pick.origin.sign, classes: pick.origin.classes, site: pick.origin.site }
                  : null
              }
            }, location.origin);
          }
        } catch {}
      }
    }
  });
  const ROOT = document.documentElement || document.body || document;
  obs.observe(ROOT, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });

  // --------------------------- Autoinject to iframes ------------
  (function __injectIntoSameOriginIframes__() {
    if (!CFG.crossFrameInject) return;

    function injectInto(iframe) {
      try {
        if (!iframe?.contentDocument) return;
        const w = iframe.contentWindow;
        const d = iframe.contentDocument;
        if (w.__TRACEv17?.on) return;
        const s = d.createElement("script");
        s.textContent = `;(${__SELF_FN__.toString()})();`;
        d.documentElement.appendChild(s);
      } catch {}
    }

    function scanAll() {
      document.querySelectorAll("iframe").forEach(ifr => {
        try { ifr.contentDocument; } catch { return; }
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
    console.groupCollapsed("%c[class-origin-tracer]%c Quick Start & Tips", "color:#0af;font-weight:bold", "color:inherit");
    console.log("• What you see:\n  - [CLASS] groups show element path and added/removed classes.\n  - 'origin ... @ file:line:col' is the best-guess callsite for that change.\n  - Open [STACKS] (enable by __TRACEv17.debug()) to view origin stack.");
    console.log("• Basic controls:\n  - __TRACEv17.debug()  → verbose logs + origin stacks\n  - __TRACEv17.min()    → quiet mode (no stacks)\n  - __TRACEv17.stop()   → stop observing\n  - __TRACEv17.dump($0) → table of recent ops for the currently-selected element");
    console.log("• Tuning:\n  - __TRACEv17.set({windowMs:2500})\n  - __TRACEv17.set({skipJQCore:false})\n  - __TRACEv17.set({showStacks:'origin'})\n  - __TRACEv17.set({crossFrameInject:false})\n  - __TRACEv17.set({bridgeToParent:true})  // collect child iframe logs at TOP");
    console.log("• Noise filters:\n  - __TRACEv17.set({filter:{interval:{ignore:true,showFirst:1}}})\n  - __TRACEv17.set({filter:{raf:{ignore:true}}})\n  - __TRACEv17.set({filter:{timeout:{ignore:true}}})\n  - __TRACEv17.set({filter:{throttleMs:300,maxRepeats:5}})\n  - __TRACEv17.resetDedupe() // clear repetition counters");
    console.log("• Note: When bridgeToParent:true and bridgeSuppressLocal:true, child frames do not print local logs.");
    console.groupEnd();
  }
  (function printHelpOnce() {
    const root = getTopSameOrigin();
    if (!root.__TRACEv17_HELP_SHOWN) {
      printHelp();
      try { root.__TRACEv17_HELP_SHOWN = true; } catch {}
    }
  })();

  // --------------------------- API -------------------------------
  window.__TRACEv17 = {
    on: true,
    CFG,
    set(opts = {}) {
      deepMerge(CFG, opts);
      console.log("[class-origin-tracer] cfg=", CFG);
    },
    min()   { this.set({ verbose: false, showStacks: "none" }); },
    debug() { this.set({ verbose: true,  showStacks: "origin" }); },
    stop()  { try { obs.disconnect(); } catch {} this.on = false; console.log("[class-origin-tracer] stopped"); },
    dump(el) {
      const target = el || window.$0 || el;
      const arr = (OPS.get(target) || []).slice();
      console.table(arr.map(x => ({
        kind: x.kind,
        sign: x.sign,
        classes: (x.classes || []).join(" "),
        at: x.site ? `${x.site.url}:${x.site.line}${x.site.col != null ? ":" + x.site.col : ""}${x.site.vm ? " [vm]" : ""}` : "(none)",
      })));
    },
    help() { printHelp(); },
    resetDedupe(){ ST.sigs.clear(); ST.firstShown={interval:0,timeout:0,raf:0}; console.log("[class-origin-tracer] repetition counters cleared"); },
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
    if (!root.__TRACEv17_RUNNING_SHOWN) {
      console.log("[class-origin-tracer] running — try __TRACEv17.debug(), __TRACEv17.help(), or __TRACEv17.filterPreset('aggressive')");
      try { root.__TRACEv17_RUNNING_SHOWN = true; } catch {}
    }
  })();
})();

// Optional parent collector (top window only)
if (window.top === window) {
  window.addEventListener("message", (e) => {
    if (e.origin !== location.origin) return;
    const m = e.data;
    if (!m || !m.__TRACEv17 || m.kind !== "class-mutation") return;
    const d = m.data || {};
    console.groupCollapsed(
      `%c[IFR:${m.frame}]%c ${d.target} → ${d.added?.length ? ("+ " + d.added.join(" ")) : ""} ${d.removed?.length ? (" - " + d.removed.join(" ")) : ""}`,
      "color:#06f", "color:inherit"
    );
    console.log("href :", m.href);
    console.log("before:", d.before?.join(" ") || "(none)");
    console.log("after :", d.after?.join(" ") || "(none)");
    console.log("origin:", d.origin || "(not matched)");
    console.groupEnd();
  });
}
