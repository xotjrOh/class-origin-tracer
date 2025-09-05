/* Be sure to name the file class-origin-tracer.js.
Class-change origin tracer v17-min — minimal UX (origin only), toggleable details
*/
(function () {
  if (window.__TRACEv17?.on) {
    console.log("[class-origin-tracer] already running");
    return;
  }

  const CFG = {
    windowMs: 1200,
    perElMax: 24,
    verbose: false,          // show match table/buffer in console
    showStacks: "none",      // 'none' | 'origin' (in debug mode, print origin stack only)
    ctxLines: 2,
  };

  const now = () => performance.now();

  // ── per-element operation buffer
  const OPS = new WeakMap();
  function pushOp(el, rec) {
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

  // ── callsite picker (prefer VM/eval; otherwise prefer same-origin .js)
  function pickCallsite(stack) {
    if (!stack) return null;
    const L = stack.split("\n").map((s) => s.trim());
    const host = location.host;
    const reUrl = /(https?:\/\/[^\s)]+):(\d+):\d+\)?$/;
    const reParen = /\((https?:\/\/[^\s)]+):(\d+):\d+\)\s*$/;

    // Skip this file to avoid falsely picking self as the callsite
    const SELF_NAME = "class-origin-tracer.js";
    const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	const SKIP = new RegExp(
	  [
		"chrome-extension:",
		"extensions::",
		"snippet:\\/\\/",
		"__TRACEv1[0-9]",
		// jQuery core only:
		// - jquery(.min).js
		// - jquery-<ver>(.slim)?(.min).js
		// - jquery.slim(.min).js
		// - jquery-migrate(.min).js
		// - jquery-migrate-<ver>(.min).js
		"(?:^|\\/)(?:" +
		  "jquery(?:-\\d+\\.\\d+\\.\\d+)?(?:\\.slim)?|" +     // jquery, versioned, slim
		  "jquery(?:\\.slim)?|" +                              // jquery.slim
		  "jquery(?:[.-]migrate)(?:-\\d+\\.\\d+\\.\\d+)?" +    // jquery.migrate / jquery-migrate with optional version
		")(?:\\.min)?\\.js(?:[?#].*)?$",
		ESC(SELF_NAME),
	  ].join("|"),
	  "i"
	);

    const frames = [];
    for (let i = 2; i < L.length; i++) {
      const ln = L[i];

      // Prefer VM/eval frames first
      if (/^at (eval|<anonymous>)/.test(ln)) {
        frames.push({ url: "<eval/anonymous>", line: 0, raw: ln, vm: true });
        continue;
      }
      if (/ VM\d+:/.test(ln)) {
        const m = ln.match(/(VM\d+):(\d+):\d+\)?$/);
        if (m) frames.push({ url: m[1], line: +m[2], raw: ln, vm: true });
        continue;
      }

      // Skip noisy frames
      if (SKIP.test(ln)) continue;

      // Extract URL + line number
      const m = ln.match(reParen) || ln.match(reUrl);
      if (!m) continue;
      const url = m[1], line = +m[2];

      frames.push({
        url,
        line,
        same: url.includes(host),
        js: /\.js(\?|#|$)/i.test(url),
        raw: ln,
      });
    }
    if (!frames.length) return null;

    // Prefer VM/eval frames first
    const vm = frames.find((f) => f.vm);
    if (vm) return { url: vm.url, line: vm.line, raw: vm.raw, vm: true };

    // Rank: prefer same-origin .js
    frames.sort(
      (a, b) =>
        (b.same ? 2 : 0) + (b.js ? 1 : 0) - ((a.same ? 2 : 0) + (a.js ? 1 : 0)),
    );
    const f = frames[0];
    return { url: f.url, line: f.line, raw: f.raw, vm: false };
  }

  function cssPath(el) {
    try {
      if (!el || el.nodeType !== 1) return "";
      const parts = [];
      while (el && el.nodeType === 1 && el !== document.documentElement) {
        let p = el.tagName.toLowerCase();
        if (el.id) {
          parts.unshift(p + "#" + el.id);
          break;
        }
        const cls = (el.className || "")
          .toString()
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (cls.length) p += "." + cls.slice(0, 2).join(".");
        if (el.parentElement) {
          const sib = Array.from(el.parentElement.children).filter(
            (n) => n.tagName === el.tagName,
          );
          if (sib.length > 1) {
            const idx =
              Array.prototype.indexOf.call(el.parentElement.children, el) + 1;
            p += `:nth-child(${idx})`;
          }
        }
        parts.unshift(p);
        el = el.parentElement;
      }
      return parts.join(" > ");
    } catch {
      return "(path)";
    }
  }

  // ── DOM/jQuery hooks
  (function hookDOM() {
    const DL = DOMTokenList.prototype;
    const add0 = DL.add, rem0 = DL.remove, tog0 = DL.toggle;

    DL.add = function () {
      try {
        const raw = new Error().stack;
        pushOp(this.ownerElement, {
          t: now(),
          kind: "classList.add",
          sign: "+",
          classes: [...arguments],
          site: pickCallsite(raw),
          stackRaw: raw, // In debug mode, emit origin stack only
        });
      } catch {}
      return add0.apply(this, arguments);
    };

    DL.remove = function () {
      try {
        const raw = new Error().stack;
        pushOp(this.ownerElement, {
          t: now(),
          kind: "classList.remove",
          sign: "-",
          classes: [...arguments],
          site: pickCallsite(raw),
          stackRaw: raw,
        });
      } catch {}
      return rem0.apply(this, arguments);
    };

    DL.toggle = function () {
      try {
        const raw = new Error().stack;
        pushOp(this.ownerElement, {
          t: now(),
          kind: "classList.toggle",
          sign: "?",
          classes: [arguments[0]],
          site: pickCallsite(raw),
          stackRaw: raw,
        });
      } catch {}
      return tog0.apply(this, arguments);
    };

    const setAttr0 = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, val) {
      if (name === "class") {
        try {
          const before = (this.getAttribute("class") || "")
            .trim()
            .split(/\s+/)
            .filter(Boolean);
          const after = ("" + (val || "")).trim().split(/\s+/).filter(Boolean);
          const b = new Set(before), a = new Set(after);
          const changed = [
            ...after.filter((c) => !b.has(c)),
            ...before.filter((c) => !a.has(c)),
          ];
          const raw = new Error().stack;
          pushOp(this, {
            t: now(),
            kind: "setAttribute(class)",
            sign: "?",
            classes: changed,
            site: pickCallsite(raw),
            stackRaw: raw,
          });
        } catch {}
      }
      return setAttr0.apply(this, arguments);
    };

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
            const before =
              (this.getAttribute && (this.getAttribute("class") || "")) || "";
            const after = "" + v;
            const b = new Set(before.trim().split(/\s+/).filter(Boolean));
            const a = new Set(after.trim().split(/\s+/).filter(Boolean));
            const changed = [
              ...[...a].filter((c) => !b.has(c)),
              ...[...b].filter((c) => !a.has(c)),
            ];
            const raw = new Error().stack;
            pushOp(this, {
              t: now(),
              kind: "className=",
              sign: "?",
              classes: changed,
              site: pickCallsite(raw),
              stackRaw: raw,
            });
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
    if (Element.prototype !== HTMLElement.prototype)
      wrapClassName(Element.prototype);
  })();

  (function hookJQ(jq) {
    if (!jq || !jq.fn || !jq.fn.addClass) return;
    const F = jq.fn;
    const add0 = F.addClass, rem0 = F.removeClass, tog0 = F.toggleClass, attr0 = F.attr, prop0 = F.prop;

    function pushEach($set, kind, sign, classes, raw) {
      const t0 = now(), st = pickCallsite(raw);
      for (let i = 0; i < $set.length; i++)
        pushOp($set[i], {
          t: t0,
          kind,
          sign,
          classes: classes || [],
          site: st,
          stackRaw: raw,
        });
    }

    F.addClass = function (cls) {
      const c = typeof cls === "string" ? cls.split(/\s+/).filter(Boolean) : [];
      const raw = new Error().stack;
      pushEach(this, "jQuery.addClass", "+", c, raw);
      return add0.apply(this, arguments);
    };
    F.removeClass = function (cls) {
      const raw = new Error().stack;
      let c = [];
      if (typeof cls === "string") c = cls.split(/\s+/).filter(Boolean);
      else if (cls == null) {
        this.each(function () {
          const cur = (this.getAttribute && this.getAttribute("class")) || "";
          const arr = cur.trim().split(/\s+/).filter(Boolean);
          pushOp(this, {
            t: now(),
            kind: "jQuery.removeClass(all)",
            sign: "-",
            classes: arr,
            site: pickCallsite(raw),
            stackRaw: raw,
          });
        });
      }
      pushEach(this, "jQuery.removeClass", "-", c, raw);
      return rem0.apply(this, arguments);
    };
    F.toggleClass = function (cls) {
      const c = typeof cls === "string" ? cls.split(/\s+/).filter(Boolean) : [];
      const raw = new Error().stack;
      pushEach(this, "jQuery.toggleClass", "?", c, raw);
      return tog0.apply(this, arguments);
    };
    F.attr = function (name, val) {
      const raw = new Error().stack;
      if (name === "class" && val != null)
        pushEach(
          this,
          "jQuery.attr(class)",
          "?",
          ("" + val).split(/\s+/).filter(Boolean),
          raw,
        );
      return attr0.apply(this, arguments);
    };
    F.prop = function (name, val) {
      const raw = new Error().stack;
      if (/^className$/i.test(name) && val != null)
        pushEach(
          this,
          "jQuery.prop(className)",
          "?",
          ("" + val).split(/\s+/).filter(Boolean),
          raw,
        );
      return prop0.apply(this, arguments);
    };
    console.log("[class-origin-tracer] jQuery hooked:", jq.fn.jquery);
  })(window.jQuery || window.$);

  // ── matching/logging
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
    "setAttribute(class)": 5,
    "className=": 5,
  };

  function score(rec, want, changes) {
    let s = (KIND_RANK[rec.kind] || 1) * 10;
    if (want && rec.sign === want) s += 30;
    if (rec.classes?.length) {
      if (rec.classes.some((c) => changes.includes(c))) s += 100;
    }
    const age = now() - rec.t;
    s += Math.max(0, 5 - age / 300);
    return s;
  }

  function pickOriginForMutation(target, added, removed) {
    const t = now();
    const want =
      removed.length && !added.length ? "-" :
      added.length && !removed.length ? "+" : null;

    const arr = (OPS.get(target) || []).filter((r) => t - r.t <= CFG.windowMs);
    const pool = want ? arr.filter((r) => r.sign === want) : arr.slice();
    if (!pool.length) return null;

    const changes =
      want === "-" ? removed :
      want === "+" ? added : [...added, ...removed];

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
    const at = o.site ? `@ ${o.site.url}:${o.site.line}${vmTag}` : "(site?)";
    console.groupCollapsed(
      `%corigin %s %s`,
      "color:#0af",
      o.kind,
      o.classes?.length ? `(${o.classes.join(" ")})` : "",
    );
    if (o.site) console.log(at);
    console.groupEnd();
    logStacks("origin", o);
  }

  function logDecision(considered) {
    if (!CFG.verbose) return;
    console.groupCollapsed("%c[MATCH] decision trace", "color:#0af");
    const rows = considered.map(({ r, sc }) => ({
      kind: r.kind,
      sign: r.sign,
      classes: (r.classes || []).join(" "),
      age_ms: Math.round(now() - r.t),
      at: r.site
        ? `${r.site.url}:${r.site.line}${r.site.vm ? " [vm]" : ""}`
        : "(none)",
      score: Math.round(sc),
    }));
    console.table(rows);
    console.groupEnd();
  }

  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type !== "attributes" || m.attributeName !== "class") continue;
      const before = (m.oldValue || "").trim().split(/\s+/).filter(Boolean);
      const after = (m.target.getAttribute("class") || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const b = new Set(before), a = new Set(after);
      const added = after.filter((c) => !b.has(c));
      const removed = before.filter((c) => !a.has(c));
      if (!added.length && !removed.length) continue;

      console.groupCollapsed(
        "[CLASS]",
        cssPath(m.target),
        "\n→",
        added.length ? `+${added.join(",")}` : "",
        removed.length ? ` -${removed.join(",")}` : "",
      );
      console.log("node:", m.target);
      console.log("before:", before.join(" ") || "(none)");
      console.log("after :", after.join(" ") || "(none)");
      if (added.length)  console.log("%cadded   %s", "color:#0a0", added.join(" "));
      if (removed.length)console.log("%cremoved %s", "color:#a00", removed.join(" "));

      const pick = pickOriginForMutation(m.target, added, removed);
      if (pick && pick.origin) {
        logDecision(pick.considered);
        logOrigin(pick.origin);
      } else {
        console.log(
          "%corigin",
          "color:#888",
          "(no matching frame — likely initial render / iframe / eval / other window)",
        );
      }
      console.groupEnd();
    }
  });
  obs.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
    attributeOldValue: true,
  });

  window.__TRACEv17 = {
    on: true,
    CFG,
    set(opts = {}) {
      Object.assign(CFG, opts);
      console.log("[class-origin-tracer] cfg=", CFG);
    },
    min() {
      this.set({ verbose: false, showStacks: "none" });
    },
    debug() {
      this.set({ verbose: true, showStacks: "origin" });
    },
    stop() {
      try { obs.disconnect(); } catch {}
      this.on = false;
      console.log("[class-origin-tracer] stopped");
    },
    dump(el) {
      const arr = (OPS.get(el) || []).slice();
      console.table(
        arr.map((x) => ({
          kind: x.kind,
          sign: x.sign,
          classes: (x.classes || []).join(" "),
          at: x.site
            ? `${x.site.url}:${x.site.line}${x.site.vm ? " [vm]" : ""}`
            : "(none)",
        })),
      );
    },
  };

  console.log("[class-origin-tracer] running — minimal UX. Use __TRACEv17.debug() for stacks.");
})();
