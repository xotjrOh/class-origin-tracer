/* Be sure to name the file child-origin-tracer.js.
Child-change origin tracer v1 — minimal UX (origin only), toggleable details
*/
(function () {
  if (window.__CHILDTRACEv1?.on) {
    console.log("[child-origin-tracer] already running");
    return;
  }

  const CFG = {
    windowMs: 1200,
    perElMax: 24,
    verbose: false,          // show match table/buffer in console
    showStacks: "none",      // 'none' | 'origin' (debug prints origin stack)
    ctxLines: 2,
  };

  const now = () => performance.now();

  // ── per-element operation buffer (keyed by the *parent* whose children change)
  const OPS = new WeakMap();

  function pushOp(el, rec) {
    if (!el || typeof el !== "object") return;

    const s = rec.site;
    if (!s || !s.url) return;
    if (/snippet:\/\/|chrome-extension:|extensions::/i.test(s.url)) return;

    let arr = OPS.get(el);
    if (!arr) {
      arr = [];
      OPS.set(el, arr);
    }
    arr.push(rec);
    if (arr.length > CFG.perElMax) arr.shift();
  }

  // ── callsite picker (VM/eval 낮은 우선순위, same/virtual/code-looking 가중치)
  function pickCallsite(stack) {
    if (!stack) return null;

    const L = stack.split("\n").map(s => s.trim());
    const host = location.host;

    // 오른쪽에서 line/col을 식별: url 캡처는 마지막 숫자 꼬리 앞에서 멈춤
    // ( …url…:LINE[:COL][:EXTRA…] )
    const RE_PAREN = /\((.+?)(?=:\d+(?::\d+)*\)\s*$):(\d+)(?::(\d+))?(?::\d+)*\)\s*$/;
    // …url…:LINE[:COL][:EXTRA…]
    const RE_BARE  = /(?:^|\s)([^\s()]+?)(?=:\d+(?::\d+)*\s*$):(\d+)(?::(\d+))?(?::\d+)*\s*$/;

    // VMNN file.js:LINE[:COL][:EXTRA…]
    const RE_VM_WITH_FILE = /VM\d+\s+([^\s)]+?)(?=:\d+(?::\d+)*\)?\s*$):(\d+)(?::(\d+))?(?::\d+)*\)?$/;
    // VMNN:LINE[:COL][:EXTRA…]
    const RE_VM_SIMPLE    = /(VM\d+):(\d+)(?::(\d+))?(?::\d+)*\)?$/;

    // virtual/bundle schemes
    const VIRTUAL = /^(webpack|webpack-internal|rollup|vite|parcel|ng|blob|file|node):/i;

    // 자기 자신/노이즈 스킵 (jQuery 코어는 스킵, 플러그인은 허용)
    const SELF_FILES = ["child-origin-tracer.js", "childObserver.js", "class-origin-tracer.js"];
    const ESC = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const RE_JQ_CORE = new RegExp(
      "(?:^|\\/)(?:jquery(?:-\\d+\\.\\d+\\.\\d+)?(?:\\.slim)?|jquery(?:\\.slim)?|jquery(?:[.-]migrate)(?:-\\d+\\.\\d+\\.\\d+)?)" +
      "(?:\\.min)?\\.js(?:[?#].*)?$", "i"
    );
    const RE_SKIP_LINE = new RegExp(
      ["chrome-extension:", "extensions::", "snippet:\\/\\/", "__TRACEv1[0-9]", ...SELF_FILES.map(ESC)].join("|"), "i"
    );

    const frames = [];

    for (let i = 2; i < L.length; i++) {
      const ln = L[i];
      if (RE_SKIP_LINE.test(ln)) continue;

      let isEvalAnon = false;
      if (/^at (eval|<anonymous>)/.test(ln)) isEvalAnon = true;

      let m = ln.match(RE_VM_WITH_FILE);
      if (m) {
        const url  = m[1];
        const line = +m[2];
        const col  = m[3] != null ? +m[3] : 0;
        if (RE_JQ_CORE.test(url)) continue;
        if (SELF_FILES.some(f => url.toLowerCase().includes(f.toLowerCase()))) continue;

        const isVirtual  = true;
        const isRelative = !/^[a-z]+:/i.test(url);
        const sameHost   = url.includes(host);
        const looksCode  = /\.(m?js|cjs|jsx|ts|tsx|jsp)(?:\?|#|$)/i.test(url);

        frames.push({ url, line, col, raw: ln, vm: true, evalAnon: isEvalAnon,
          same: sameHost || isVirtual || isRelative, code: looksCode || isVirtual });
        continue;
      }

      m = ln.match(RE_VM_SIMPLE);
      if (m) {
        const url  = m[1];
        const line = +m[2];
        const col  = m[3] != null ? +m[3] : 0;
        frames.push({ url, line, col, raw: ln, vm: true, evalAnon: isEvalAnon,
          same: true, code: true, weak: true });
        continue;
      }

      m = ln.match(RE_PAREN) || ln.match(RE_BARE);
      if (!m) continue;

      const url  = m[1];
      const line = +m[2];
      const col  = m[3] != null ? +m[3] : 0;
      if (RE_JQ_CORE.test(url)) continue;
      if (SELF_FILES.some(f => url.toLowerCase().includes(f.toLowerCase()))) continue;

      const isVirtual  = VIRTUAL.test(url);
      const isRelative = !/^[a-z]+:/i.test(url);
      const sameHost   = url.includes(host);
      const looksCode  = /\.(m?js|cjs|jsx|ts|tsx|jsp)(?:\?|#|$)/i.test(url);

      frames.push({ url, line, col, raw: ln, vm: false, evalAnon: isEvalAnon,
        same: sameHost || isVirtual || isRelative, code: looksCode || isVirtual });
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

    frames.sort((a, b) => {
      const dw = weight(b) - weight(a);
      if (dw) return dw;
      return 0;
    });

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

  // ── DOM hooks (child mutations)
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
      wrapped.__childtrace_wrapped = true;
      try { obj[key] = wrapped; } catch {}
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
      Object.defineProperty(proto, prop, {
        ...Object.getOwnPropertyDescriptor(proto, prop),
        __childtrace_wrapped: true,
      });
    }
    if (Element && Element.prototype) {
      wrapSetter(Element.prototype, "innerHTML", "innerHTML=");
      wrapSetter(Element.prototype, "outerHTML", "outerHTML=");
    }
  })();

  // ── jQuery hooks (manipulation)
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

  // ── matching/logging
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
    if (want && rec.sign === want) s += 30;
    const age = now() - rec.t;
    s += Math.max(0, 5 - age / 300);
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
    const pool = want ? arr.filter((r) => r.sign === want) : arr.slice();
    if (!pool.length) return null;

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

  // url:line[:col] — col이 있을 때만 출력해서 ':0' 방지
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

  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type !== "childList") continue;

      const target = m.target;
      const added = Array.from(m.addedNodes || []).filter(n => n.nodeType !== 3 || (n.nodeValue || "").trim() !== "");
      const removed = Array.from(m.removedNodes || []).filter(n => n.nodeType !== 3 || (n.nodeValue || "").trim() !== "");
      if (added.length === 0 && removed.length === 0) continue;

      const addedPreview = added.slice(0, 3).map(nodeLabel).join(", ");
      const removedPreview = removed.slice(0, 3).map(nodeLabel).join(", ");

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

      const pick = pickOriginForChildMutation(target, m.addedNodes, m.removedNodes);
      if (pick && pick.origin) {
        logDecision(pick.considered);
        logOrigin(pick.origin);
      } else {
        console.log("%corigin", "color:#888", "(no matching frame — likely initial render / iframe / eval / other window)");
      }
      console.groupEnd();
    }
  });
  obs.observe(document.body, { subtree: true, childList: true });

  window.__CHILDTRACEv1 = {
    on: true,
    CFG,
    set(opts = {}) {
      Object.assign(CFG, opts);
      console.log("[child-origin-tracer] cfg=", CFG);
    },
    min() { this.set({ verbose: false, showStacks: "none" }); },
    debug() { this.set({ verbose: true, showStacks: "origin" }); },
    stop() { try { obs.disconnect(); } catch {} this.on = false; console.log("[child-origin-tracer] stopped"); },
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
  };

  console.log("[child-origin-tracer] running — minimal UX. Use __CHILDTRACEv1.debug() for stacks.");
})();
