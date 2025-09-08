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
    showStacks: "none",      // 'none' | 'origin' (debug prints origin stack)
    ctxLines: 2,
  };

  const now = () => performance.now();

  // ── per-element operation buffer
  const OPS = new WeakMap();

  // map DOMTokenList -> owning Element
  const CL2EL = new WeakMap();

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

  // ── callsite picker (VM/eval first, same/virtual/code-looking second)
	function pickCallsite(stack) {
	  if (!stack) return null;

	  const L = stack.split("\n").map(s => s.trim());
	  const host = location.host;

	  // ( …url…:LINE:COL )
	  const RE_PAREN = /\(([^)\s]+):(\d+):(\d+)\)\s*$/;
	  // …url…:LINE:COL  (괄호 없음; webpack/bare format)
	  const RE_BARE  = /(?:^|\s)([^()\s]+):(\d+):(\d+)\s*$/;

	  // DevTools VM format
	  // 1) "VM123 file.js:LINE:COL"
	  const RE_VM_WITH_FILE = /VM\d+\s+([^\s)]+):(\d+):(\d+)\)?$/;
	  // 2) "VM123:LINE:COL" (no filename)
	  const RE_VM_SIMPLE    = /(VM\d+):(\d+):(\d+)\)?$/;

	  // virtual/bundle schemes
	  const VIRTUAL = /^(webpack|webpack-internal|rollup|vite|parcel|ng|blob|file|node):/i;

	  // skip self/noise
	  const SELF_FILES = [
		"class-origin-tracer.js",
		"child-origin-tracer.js",
	  ];
	  const ESC = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

	  // jQuery core / migrate (플러그인은 허용)
	  // (경계에 슬래시가 없어도 매치되도록 [\/\s]? 사용)
	  const RE_JQ_CORE = new RegExp(
		String.raw`[\/\s]?jquery(?:-\d+\.\d+\.\d+)?(?:\.slim)?|jquery(?:\.slim)?|jquery(?:[.-]migrate)(?:-\d+\.\d+\.\d+)?`,
		"i"
	  );
	  const RE_JQ_CORE_FILE = /\.js(?:[?#].*)?$/i;

	  const RE_SKIP_LINE = new RegExp(
		[
		  "chrome-extension:",
		  "extensions::",   // DevTools-internal
		  "snippet:\\/\\/",
		  "__TRACEv1[0-9]", // tracer globals
		  ...SELF_FILES.map(ESC),
		].join("|"),
		"i"
	  );

	  const frames = [];

	  // 0: Error, 1: 내부 — 보통 2부터 유의미
	  for (let i = 2; i < L.length; i++) {
		const ln = L[i];
		if (RE_SKIP_LINE.test(ln)) continue;

		let isEvalAnon = false;
		if (/^at (eval|<anonymous>)/.test(ln)) isEvalAnon = true;

		// VMNN file.js:LINE:COL
		let m = ln.match(RE_VM_WITH_FILE);
		if (m) {
		  const url  = m[1];
		  const line = +m[2];
		  const col  = +m[3];

		  // jQuery core 파일 스킵
		  if (RE_JQ_CORE.test(url) && RE_JQ_CORE_FILE.test(url)) continue;
		  // 자기 자신 파일 스킵
		  if (SELF_FILES.some(f => url.toLowerCase().includes(f.toLowerCase()))) continue;

		  const isVirtual  = true;                    // VM 컨텍스트는 virtual 성격
		  const isRelative = !/^[a-z]+:/i.test(url);  // ./src/…
		  const sameHost   = url.includes(host);
		  const looksCode  = /\.(m?js|cjs|jsx|ts|tsx|jsp)(?:\?|#|$)/i.test(url);

		  frames.push({
			url, line, col, raw: ln,
			vm: true,
			evalAnon: isEvalAnon,
			same: sameHost || isVirtual || isRelative,
			code: looksCode || isVirtual
		  });
		  continue;
		}

		// 순수 VMNN:LINE:COL — 파일명 정보 없음 (약한 힌트)
		m = ln.match(RE_VM_SIMPLE);
		if (m) {
		  const url  = m[1];
		  const line = +m[2];
		  const col  = +m[3];
		  frames.push({
			url, line, col, raw: ln,
			vm: true,
			evalAnon: isEvalAnon,
			same: true,
			code: true,
			weak: true,
		  });
		  continue;
		}

		// 일반 ( …url…:line:col ) 또는 bare 포맷
		m = ln.match(RE_PAREN) || ln.match(RE_BARE);
		if (!m) continue;

		const url  = m[1];
		const line = +m[2];
		const col  = +m[3];

		// jQuery core 파일 스킵
		if ((RE_JQ_CORE.test(url) && RE_JQ_CORE_FILE.test(url))) continue;
		// 자기 자신 파일 스킵
		if (SELF_FILES.some(f => url.toLowerCase().includes(f.toLowerCase()))) continue;

		const isVirtual  = VIRTUAL.test(url);        // webpack-internal://…, blob:, file:, …
		const isRelative = !/^[a-z]+:/i.test(url);   // ./src/…
		const sameHost   = url.includes(host);       // http(s) only
		const looksCode  = /\.(m?js|cjs|jsx|ts|tsx|jsp)(?:\?|#|$)/i.test(url);

		frames.push({
		  url, line, col, raw: ln,
		  vm: false,
		  evalAnon: isEvalAnon,
		  same: sameHost || isVirtual || isRelative,
		  code: looksCode || isVirtual
		});
	  }

	  if (!frames.length) return null;

	  // 점수화: same(4) + code(2) + (!weak) + (!evalAnon)
	  function weight(f) {
		let w = 0;
		if (f.same) w += 4;
		if (f.code) w += 2;
		if (!f.weak) w += 1;
		if (f.evalAnon) w -= 6;    // eval/<anonymous>는 강한 패널티
		return w;
	  }

	  // (중요) 더 이상 "vm을 무조건 우선 반환"하지 않는다.
	  frames.sort((a, b) => {
		const dw = weight(b) - weight(a);
		if (dw) return dw;
		return 0; // 동점이면 상대적 순위 유지(상위 프레임 우선)
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
    // classList getter를 래핑하여 CL2EL 맵 유지
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

    const DL = DOMTokenList.prototype;
    const add0 = DL.add, rem0 = DL.remove, tog0 = DL.toggle;

    DL.add = function () {
      try {
        const raw = new Error().stack;
        const el = this.ownerElement || CL2EL.get(this);
        pushOp(el, {
          t: now(),
          kind: "classList.add",
          sign: "+",
          classes: [...arguments],
          site: pickCallsite(raw),
          stackRaw: raw,
        });
      } catch {}
      return add0.apply(this, arguments);
    };

    DL.remove = function () {
      try {
        const raw = new Error().stack;
        const el = this.ownerElement || CL2EL.get(this);
        pushOp(el, {
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
        const el = this.ownerElement || CL2EL.get(this);
        pushOp(el, {
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
    if (Element.prototype !== HTMLElement.prototype) wrapClassName(Element.prototype);
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
    const at = o.site
      ? `@ ${o.site.url}:${o.site.line}${o.site.col != null ? ":" + o.site.col : ""}${vmTag}`
      : "(site?)";
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
        ? `${r.site.url}:${r.site.line}${r.site.col != null ? ":" + r.site.col : ""}${r.site.vm ? " [vm]" : ""}`
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
            ? `${x.site.url}:${x.site.line}${x.site.col != null ? ":" + x.site.col : ""}${x.site.vm ? " [vm]" : ""}`
            : "(none)",
        })),
      );
    },
  };

  console.log("[class-origin-tracer] running — minimal UX. Use __TRACEv17.debug() for stacks.");
})();
