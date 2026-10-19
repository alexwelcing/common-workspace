# Working on Common

Bring a rough edge, a useful example, or a change that makes working together
easier. Small, well-explained contributions are welcome.

## Get the app running

Use Bun **1.4.3**, the version pinned in `package.json`. Clone the repository with
an account that has read access, then run:

```sh
bun install --frozen-lockfile
bun run dev
```

Open the URL printed in the terminal. For a built app and team hosting, start
with the [hosting guide](docs/hosting.md). For package integration, use the
[Bun embedding guide](docs/embedding.md).

## Find your starting point

| You want to… | Start here |
| --- | --- |
| Understand how the pieces fit | [Architecture](docs/architecture.md) |
| Find the code for a feature | [Maintainer code map](docs/maintaining.md#start-at-the-boundary-you-are-changing) |
| Improve a menu, tool, or interaction | [UI primitives](docs/workspace-ui.md) and [tool review](docs/tool-design-review.md) |
| Investigate slow behavior | [Performance guide](docs/performance.md) |
| Work with canvas automation | [Agent API](AGENT_API.md) and [recipes](public/agent-examples.md) |
| Change room admission or transport | [Room protocol](API.md) |
| Find another guide | [Documentation map](docs/README.md) |

Read the [state and lifecycle rules](docs/maintaining.md#preserve-these-invariants)
before changing collaboration, storage, capture, or teardown. Those boundaries
protect the work people already have on their canvases.

## Make the change easy to review

Start with the experience you want to improve: what someone does, what happens
today, and what should happen afterward. Keep the change focused on that outcome.
Use the existing UI and lifecycle helpers where they fit, and explain a new
abstraction when the change needs one.

For a bug report, include the visible error and a short way to reproduce it.
Name the browser, hosting mode, and affected experience if you know them. A
sanitized connection or performance report can help; review attachments and
leave out credentials and private canvas content.

For an idea, describe a real situation where it would help. A sketch, example
prompt, or before/after description often says more than a feature name.

## Check the behavior you changed

For application changes, the default check runs lint, builds once, and walks
through five desktop/phone journeys in a temporary local app:

```sh
bun run check
```

Read the first failing checkpoint and its report before rerunning. Use focused
existing checks when investigating a particular boundary; the
[validation guide](docs/validation.md) explains which ones help and how to check
actual browser permissions on your devices. Adapter changes also need the
documented disposable-database flow.

For prose-only changes, check links, section references, and the accuracy of
commands and examples. When an example changes executable behavior, try that
example. There is no need to rerun an unchanged application just to edit wording.

## Open a pull request

Tell the reviewer what someone can now do, why the change helps, and how you
checked it. Include a screenshot or short clip when it makes an interaction
clearer. Call out compatibility changes, migrations, and anything still unresolved.

Keep generated changes deliberate. Builds regenerate `public/agent-tools.json`;
include it when the command schema changes. Distributed modules need their own
version and a fresh-install check. The [release guide](docs/maintaining.md#prepare-and-verify-a-release)
covers packaging, deploy verification, and immutable release assets.
