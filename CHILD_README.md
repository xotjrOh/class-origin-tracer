# child-origin-tracer

> **Who spawned or removed that DOM node?**  
> A zero-setup DevTools snippet that traces **who added/removed children** and where it happened.  
> Paste → Run → See origin.

![demo](docs/demo-child.gif)

---

## Why
Modals, lists, carousels, templates—DOM nodes pop in/out, but the responsible line is unclear. This snippet hooks DOM & jQuery manipulation and prints:

- a readable CSS path of the parent,

- what changed (counts with short previews),

- a best-guess origin (callsite) that plays nicely with bundlers/VM stacks,

- and (in debug) the origin stack and matching decision table.

No build. No npm. Just a snippet.

---

## Quick start (DevTools Snippet)
1. Open **Chrome DevTools → Sources → Snippets → New Snippet**  
2. Name it `child-origin-tracer.js` and paste the contents of [`src/child-origin-tracer.js`](src/child-origin-tracer.js).  
3. Click **Run (▶)**.  
4. Interact with the page; the Console shows child mutations and their origins

**Cheat sheet**
```js
__CHILDTRACEv1.help();               // one-time Quick Start banner
__CHILDTRACEv1.debug();              // origin stacks + decision tables
__CHILDTRACEv1.min();                // quiet mode
__CHILDTRACEv1.filterPreset('aggressive'); // kill interval/rAF churn fast
__CHILDTRACEv1.set({ bridgeToParent: true }); // aggregate iframe logs in TOP window
```
---
## What it hooks
- DOM: `appendChild` / `insertBefore` / `removeChild` / `replaceChild`,
`Element.append` / `prepend` / `before` / `after`,
`ChildNode.remove`, `innerHTML` / `outerHTML` setters

- jQuery: `append` / `prepend` / `before` / `after` / `html(set)` / `remove` / `detach` / `empty`

> jQuery core/migrate frames are hidden by default (`skipJQCore: true`). Your app/plugins still show up.

---

## Noise & Dedupe (made for real UIs)

Auto-rotating sliders, timers, and animations can flood the console. Built-in filters keep the useful first hits and summaries, suppressing repetitive churn.

```js
// Quick, sensible defaults:
__CHILDTRACEv1.filterPreset('aggressive');

// Or tune manually:
__CHILDTRACEv1.set({
  filter: {
    interval: { ignore: true,  showFirst: 1 }, // setInterval loops: show first N, then suppress
    raf:      { ignore: true,  showFirst: 1 }, // rAF-driven updates
    timeout:  { ignore: false, showFirst: 1 }, // recursive setTimeout polling (toggle if needed)
    throttleMs: 300,                            // same signature within 300ms → muted
    maxRepeats: 5,                              // show at most 5 times per signature, then summarize
    summaryEvery: 50                            // print 1-line summary every 50 suppressed
  }
});

__CHILDTRACEv1.resetDedupe(); // clear throttling/repeat counters
```
A signature is roughly: callsite (`url:line:col`) + parent element + a short preview of added/removed nodes.
It keeps repeated noise from the same place out of your way.

---

## Iframes (same-origin)

- Auto-inject into same-origin iframes is ON by default.

- For iframe-heavy pages, aggregate logs to the top window:
```js
__CHILDTRACEv1.set({ bridgeToParent: true }); // forward logs to TOP; child consoles stay quiet
```

> Cross-origin iframes cannot be inspected due to browser security.

---

## Matching policy (how origins are picked)

- Score = API kind weight + sign match (+/−) + recency

- If no clear +/− candidate exists, '?' (unknown) is considered only as the final fallback

- Callsite extraction prefers bundle/VM/relative frames (webpack-internal://, blob:, file:, relative paths),
skips extensions/devtools internal, jQuery core/migrate, and the snippet itself

---

## Commands

```js
__CHILDTRACEv1.help();                 // show Quick Start
__CHILDTRACEv1.min();                  // minimal logs
__CHILDTRACEv1.debug();                // detailed logs + origin stacks
__CHILDTRACEv1.stop();                 // detach the observer
__CHILDTRACEv1.dump($0);               // show recent ops buffer for the selected parent
__CHILDTRACEv1.set({ windowMs: 2000 }); // widen op↔mutation matching window (ms)
__CHILDTRACEv1.resetDedupe();          // reset noise counters
__CHILDTRACEv1.filterPreset('off');    // disable all filters
```

---

## Configuration (summary)

```js
// defaults inside child-origin-tracer.js
const CFG = {
  windowMs: 1200,
  perElMax: 24,
  verbose: false,           // show decision table
  showStacks: "none",       // 'none' | 'origin'

  crossFrameInject: true,   // auto-inject into same-origin iframes
  bridgeToParent: false,    // postMessage events to top window
  bridgeSuppressLocal: true,// keep child consoles quiet when bridging
  skipJQCore: true,         // hide jQuery core/migrate frames

  filter: {
    interval: { ignore: true,  showFirst: 1 },
    raf:      { ignore: false, showFirst: 1 },
    timeout:  { ignore: false, showFirst: 1 },
    throttleMs: 250,
    maxRepeats: 8,
    summaryEvery: 50,
    reportSuppressed: true
  }
};
```

---

## Browser support & limits

- Best on **Chromium** browsers (Chrome/Edge). Firefox/Safari stack formats may reduce callsite precision.

- Only **same-origin** documents/iframes can be traced.

- With hot reload/sourcemaps, `line:col` may move often, making signatures look different; use `throttleMs/maxRepeats` to tame it.

> Privacy: logs stay in your **local Console**. Nothing is sent anywhere.

## Contributing

- Single source file: `src/child-origin-tracer.js` (no build/min)

- Run Prettier before committing

- Please include a short console screenshot and repro steps when filing issues

## LICENSE

[MIT LICENSE](LICENSE)
