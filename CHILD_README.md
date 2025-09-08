# child-origin-tracer

> **Who spawned or removed that DOM node?**  
> A zero-setup DevTools snippet that traces **who added/removed children** and where it happened.  
> Paste → Run → See origin.

![demo](docs/demo-child.gif)

---

## Why
Modals, lists, carousels, templates—DOM nodes pop in/out, but the responsible line is unclear. This snippet hooks DOM & jQuery manipulation and prints:

- a readable CSS path of the **parent**,
- what changed (counts + short previews),
- the **best-guess origin** (skips jQuery *core*, prefers app/plugin code, understands DevTools VM filenames),
- (debug mode) the **origin stack**.

No build. No npm. Just a snippet.

---

## Quick start (DevTools Snippet)
1. Open **Chrome DevTools → Sources → Snippets → New Snippet**  
2. Name it `child-origin-tracer.js` and paste the contents of [`src/child-origin-tracer.js`](src/child-origin-tracer.js).  
3. Click **Run (▶)**.  
4. Optional: run `__CHILDTRACEv1.debug()` in the Console to also print the origin stack.

---

## Commands
```js
__CHILDTRACEv1.min();
__CHILDTRACEv1.debug();
__CHILDTRACEv1.set({ windowMs: 2000 });
__CHILDTRACEv1.stop();
__CHILDTRACEv1.dump(el);
```

## What it hooks

- DOM: appendChild/insertBefore/removeChild/replaceChild, Element.append/prepend/before/after, ChildNode.remove, innerHTML / outerHTML

- jQuery: append/prepend/before/after/html(set)/remove/detach/empty

## How origins are picked

- Parses Error().stack, skips jQuery core and tracer/self frames.

- Never blindly picks <eval/anonymous> if a better frame exists.

- Understands DevTools VM lines like VM123 file.js:line:col and prefers the app/plugin file (e.g., common.modal.js).

## Browser support & limits

- Best on Chromium (Chrome/Edge). Firefox/Safari are experimental; stack formatting differs and origins may be null/less precise.

- Current document only (not across iframes/other windows).

- If no matching frame is found, the log explains common reasons (initial render / iframe / eval / other window).


## Contributing
PRs welcome! Please:

- keep the file single-source (src/child-origin-tracer.js), no build/min file,

- run Prettier before committing,

- add a short Console screenshot for repros when filing issues.

## LICENSE

[MIT LICENSE](LICENSE)
