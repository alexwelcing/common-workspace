# Give a walkthrough its page context

A page companion lets an agent understand the product beside Common. Your app supplies a short description and named controls; Common exposes them through the same browser agent API and optional WebMCP adapter as its canvas tools.

This first integration connects a host page to its same-origin Common iframe. It works with Classic and Space & Time, requires no additional backend, and does not connect independent windows or inspect arbitrary websites. Screen sharing remains a separate browser action.

## Describe only what the app intends to share

Create the companion in your browser entry point after the product elements exist. Keep the Common mount outside the product root. The following markup gives the example a simple checkout state without exposing a real address:

```html
<section id="checkout">
  <h1>Checkout</h1>
  <label><input id="address-complete" type="checkbox"> Delivery address complete</label>
  <button id="pay-now" disabled>Pay now</button>
</section>
<div id="collaboration-panel" style="min-height: 620px"></div>
```

```js
import { createPageCompanion, mountCommon } from 'common-workspace/client';

const root = document.querySelector('#checkout');
const addressComplete = document.querySelector('#address-complete');
const pay = document.querySelector('#pay-now');

const page = createPageCompanion({
  root,
  describe: () => ({
    title: 'Checkout',
    summary: addressComplete.checked
      ? 'The delivery address is complete. Payment is ready.'
      : 'Pay now is disabled because the delivery address is incomplete.',
    route: location.pathname,
  }),
  targets: () => [
    { id: 'pay-now', label: 'Pay now', role: 'button', element: pay },
  ],
  // Optional; enables matching this page to an approved browser-tab share.
  captureHandle: true,
});

const canvas = mountCommon({
  target: document.querySelector('#collaboration-panel'),
  basePath: '/__common/',
  mode: 'inline',
  pageContext: page,
});

addressComplete.addEventListener('change', () => {
  pay.disabled = !addressComplete.checked;
  page.update();
});

await canvas.ready();
```

`root`, `describe`, and `targets` are required. The callbacks are synchronous and return the context your application deliberately chooses to provide. Register targets with stable IDs and explicit labels. Target elements must belong to the product root; hidden, offscreen, password, and private targets are omitted. The companion does not collect the document's HTML or form values automatically. Mark a target or its ancestor with `data-common-private` to exclude it; hidden, inert, `aria-hidden`, and password/hidden-input targets are also excluded.

`captureHandle` defaults to `false`. When enabled in a supported top-level secure context, the companion exposes an opaque capture handle to its own origin. It helps Common identify an approved share of this browser tab; it does not grant capture, page access, or control. Feature detection preserves page inspection when capture-handle support is absent. A full browser-window or desktop share is not treated as a verified tab.

## Grant page access in Common

Open **Agent tools** in the embedded canvas. When a companion is attached, **Read linked page** appears as a separate permission. It starts unchecked. Choose it, review the duration, and select **Allow selected access** or **Update access**.

Canvas inspection does not include page inspection. Sharing the tab does not grant it either. To create canvas notes or show a target highlight, also allow **Edit and present**. These tools do not click, fill, or navigate the product.

The grant applies to the current Common mount and canvas session. A host can reuse one companion across multiple mounts, but each mount requires its own grant.

## Explain a control, then point to it

Use the host controller's asynchronous `agent` proxy, or the same commands inside Common's iframe. Check every response:

```js
async function run(command) {
  const response = await canvas.agent.execute(command);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

const context = await run({ action: 'source.inspect' });
const matches = await run({ action: 'source.search', query: 'Pay now' });
if (!matches.items.length) throw new Error('The payment control is not visible.');

const target = await run({ action: 'source.locate', id: matches.items[0].id });
if (target.binding.status === 'verified') {
  await run({
    action: 'source.highlight',
    id: target.target.id,
    revision: target.revision,
    durationMs: 8000,
  });
  await run({
    action: 'canvas.add',
    entity: {
      type: 'sticky', x: 80, y: 80,
      text: context.summary,
    },
  });
}
```

Before this verified-video step, the person must approve sharing the host's **browser tab** through Common's native picker. An attached companion asks the browser to include its current tab among the choices. Common matches the live capture handle and origin to the companion and to the local screen object. Matching titles or URLs alone is insufficient.

The linked page can still be inspected without a share. Read the returned `binding.status`:

| Status | Meaning |
| --- | --- |
| `not-sharing` | There is no local shared video to associate with this page. Page inspection can still work. |
| `unverified` | A share exists, but Common cannot establish that it is this page. Page context describes the linked host, not necessarily the video. |
| `verified` | The live browser-tab capture matches the companion and local screen object. A target highlight can be shown. |

Source target IDs identify app controls; canvas IDs identify Common objects. Use `source.locate` for a control and `view.focus` for a canvas object. Do not pass one kind of ID to the other API.

## Commands and results

| Command | Input | Result |
| --- | --- | --- |
| `source.inspect` | None | Approved page description, source/document IDs, revision, route, viewport, target count, and capture binding. |
| `source.search` | Optional `query`, `offset`, `limit` | A bounded page of visible target summaries and `nextOffset`. Query words match target IDs, labels, and roles literally, ignoring case. |
| `source.locate` | `id` | One visible target's viewport bounds, normalized bounds, current revision, and capture binding. |
| `source.highlight` | `id`, `revision`, optional `durationMs` | A temporary local highlight over the verified shared video. Requires page inspection and canvas editing. |

Search accepts up to 200 query characters and 1–12 items per page, default 6. Offsets are integers from 0 to 100000. Follow the returned `nextOffset` until it is `null`; the response budget can reduce a page. Source responses keep the complete success envelope below 6000 serialized characters. Companion results use a 5000-character budget, leaving room for Common's envelope and binding. A shortened description marks `truncated: true`.

Use the revision returned by `source.locate` when highlighting. If the page has changed, `SOURCE_STALE` asks you to locate the target again. A highlight lasts eight seconds by default; `durationMs` accepts 1000–30000. It follows the source target and the displayed video's scale and letterboxing while they remain valid. It changes no shared objects or room history, and Common does not add it to its canvas capture/export rendering. Captures still include source-video pixels: if the shared tab visibly contains Common, its overlay can appear there.

The optional WebMCP names are `common_source_inspect`, `common_source_search`, `common_source_locate`, and `common_source_highlight`. They register only while the companion is available and the required grant is active. The normal controller proxy and JSON runner work without native WebMCP.

## Keep context current and local

The companion observes its product root and viewport. Call `page.update()` after application state changes that do not produce an observed DOM change. It checks pathname changes without replacing the host's History API. Navigation changes the document identity; responses carry a revision so callers can avoid stale targets.

Sharing changes, source navigation, removed or hidden targets, revoked permissions, and teardown clear invalid highlights. Replacing, disconnecting, or destroying the companion ends the prior source consent; ordinary content updates do not ask for another grant. Room or board changes retain Common's existing permission boundaries.

Companion descriptions and targets stay in the presenting browser. Common does not copy them into Yjs/Loro documents, chat, device history, or connection diagnostics. Other room participants do not automatically receive the page's semantic context or tools. A note an agent deliberately adds to the shared canvas becomes normal shared canvas content.

Call `await canvas.destroy()` when removing a mount. That detaches this mount's connection, while the host-owned companion remains usable elsewhere. Call `page.destroy()` when the product view itself is removed to release its observers, listeners, and owned capture handle.

For command fields and errors, see the [browser API reference](../public/agent-api.md#linked-page-context). For server composition and host authentication, see the [embedding guide](embedding.md).
