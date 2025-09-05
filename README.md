# class-origin-tracer

> **Who flipped your `.active`?**  
> A zero-setup DevTools snippet that traces **who changed your DOM classes** and where it happened.  
> Paste → Run → See origin.

![demo](docs/demo.gif)

---

## Why

UI states “mysteriously” flicker: sliders, widgets, third-party scripts… You see `.active` toggling, but **not** the line of code that did it. This snippet hooks class mutations and prints:

- a readable CSS path of the target node,
- what changed (`+added` / `-removed`),
- the **best-guess origin** (VM/eval first, then same-origin `.js`),
- (debug mode) the **origin stack**.

No build. No npm. No bookmarklet. Just a snippet.

---

## Quick start (DevTools Snippet)

1. Open **Chrome DevTools → Sources → (left panel) Snippets → New Snippet**  
2. Name it `class-origin-tracer.js` and paste the contents of [`src/class-origin-tracer.js`](src/class-origin-tracer.js).  
3. Click **Run (▶)**.  
4. Optional: run `__TRACEv17.debug()` in the Console to also print the origin stack.

That’s it. Interact with the page; the Console will show class changes and the origin.

---

## Commands

```js
__TRACEv17.min();                 // minimal logging (no stacks)
__TRACEv17.debug();               // verbose + origin stack
__TRACEv17.set({ windowMs: 2000 });// widen matching window (ms)
__TRACEv17.stop();                // detach observer
__TRACEv17.dump(el);              // dump per-element buffer for a node
```

## How it works (short)

- Hooks: DOMTokenList.add/remove/toggle, Element.setAttribute('class', ...),
the className setter, and jQuery’s addClass/removeClass/toggleClass/attr/prop.

- Keeps a per-element ring buffer of recent operations.

- A MutationObserver watches real class mutations, then matches them to
the most plausible recent operation (scored by API kind, sign, class names, and recency).

- A callsite picker extracts a candidate frame from Error().stack
(prefers VM/eval, then same-origin .js; skips DevTools/extension/jQuery core/self).

> Privacy: nothing leaves your browser. It only logs to the Console.

## Configuration

```js
// inside class-origin-tracer.js
const CFG = {
  windowMs: 1200,     // time window to match op ↔ mutation
  perElMax: 24,       // max ops buffered per element
  verbose: false,     // print decision table
  showStacks: "none", // 'none' | 'origin' (debug prints origin stack)
};
```

## Browser support & limits
- Best on Chromium browsers (Chrome/Edge). Safari/Firefox may format stacks differently; origins still work but with lower resolution.

- Works in the current document only (not across iframes/other windows).

- Skips jQuery core frames by design; jQuery plugins are not skipped (so bxSlider-like origins are visible).

- If a mutation has no matching frame, the log explains common reasons (initial render / iframe / eval / other window).


## Contributing
PRs welcome! Please:

- keep the file single-source (src/class-origin-tracer.js), no build/min file,

- run Prettier before committing,

- add a short Console screenshot for repros when filing issues.

## LICENSE

[MIT LICENSE](LICENSE)
