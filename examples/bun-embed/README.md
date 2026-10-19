# Common inside an existing Bun app

This is a complete native Bun application with two independently mounted Common workspaces. It imports the installed `common-workspace/bun` and `common-workspace/client` package exports. It needs no Vite, frontend framework, CDN, or additional Common listener.

The host retains its own `/api/health`, `/api/counter`, and `/echo` WebSocket. One Common instance lives under `/common-inline/`; a floating instance lives under `/common-floating/`. The host's buttons open/hide each mount, and a destroy/remount action demonstrates cleanup without resetting the host counter or its WebSocket. Separate base paths also isolate the two workspaces' browser storage.

## Install and run

If Common is already installed in your Bun project, this example is included: run `bun node_modules/common-workspace/example/server.mjs` and open `http://127.0.0.1:3100`. You can also copy that `example/` folder into your own project.

Obtain `common-workspace-0.6.1.tgz` and its SHA-256 checksum from the [v1.6.1 release assets](https://github.com/alexwelcing/common-workspace/releases/tag/v1.6.1), or ask its owner for both files. Release access requires read access to the private repository; installing an administrator-provided archive needs no cloud account or registry login. If you have the Common source checkout, build that tarball there first:

```sh
bun install --frozen-lockfile
bun run pack:module
```

The resulting artifact is `artifacts/common-workspace-0.6.1.tgz`. Copy this example into your own directory, then install that tarball by its actual path:

```sh
cp -R /path/to/common/examples/bun-embed ./my-common-host
cd my-common-host
bun add /absolute/path/to/common-workspace-0.6.1.tgz
bun run start
```

Open `http://127.0.0.1:3100`. The inline canvas loads in the page. The floating canvas loads when you open its launcher. Use **Add one**, **Check host health**, and **Send** before and after opening or hiding either canvas: the original host routes remain active. A second browser tab can join a room using a Common-generated invitation link under the corresponding namespace.

`PORT` changes the listen port; `HOST` changes the host bind address. The default bind is loopback. Screen sharing requires a secure browser context: localhost is permitted; non-local deployments need HTTPS. The package defaults to private networking, with no external discovery or diagram services. Browser peers connect directly by default, with no required relay service. Supply instance-specific `env` settings to `createCommon` only when choosing a different network profile, organization discovery/relay service, diagram renderer, or diagnostics.

## The integration

`server.mjs` creates two Common adapters and composes their handlers into the application's one `Bun.serve` call:

```js
const inline = await createCommon({ basePath: '/common-inline/', dataFile: null, authorize });
const floating = await createCommon({ basePath: '/common-floating/', dataFile: null, authorize });
Bun.serve({
  fetch: inline.wrapFetch(floating.wrapFetch(hostFetch)),
  websocket: inline.wrapWebSocket(floating.wrapWebSocket(hostWebSocket)),
});
```

Unmatched HTTP routes and non-Common sockets pass to the original host handlers. The example serves the installed, self-contained browser SDK with `Bun.file(new URL(import.meta.resolve('common-workspace/client')))` at `/vendor/common-client.js`. The browser imports that URL and calls `mountCommon` for each target element. Each browser `basePath` must match its server adapter. A bare relative source checkout is not used by the example.

Common shares the application's origin and cookie context. `authorize(request, {kind})` gates both Common HTTP requests and WebSocket admission. The host can return its own denial or redirect `Response`. Agent actions still require the user's explicit in-canvas grants; embedding does not turn them on or bypass browser screen-sharing approval.

## Optional existing-app authentication demonstration

```sh
DEMO_AUTH=1 bun run start
```

Enable **Signed in to the demo host** on the page. That intentionally public toggle sets a simple HTTP-only demonstration cookie. Both Common adapters reuse the cookie check; the host's counter and echo remain independent. Turning it off destroys both browser mounts before clearing the cookie. The client mounts wait until the demonstration cookie is present, so a signed-out page does not fill itself with authentication errors.

**This cookie toggle is not production authentication.** Replace `signedIn`/`authorize` with your existing application's validated session lookup and account policy. The sample demonstrates admission checks; production logout/session revocation must also close or expire previously admitted sockets according to your host policy.

## Lifecycle and failure messages

The page displays SDK readiness and error codes beside the affected mount. If a mount path is wrong, authorization rejects it, or an asset is absent, the host routes still work and the error remains visible. Check the Bun console when startup fails. Missing-package errors mean the tarball has not been installed; missing Common assets mean it was not built/packed with the frontend app.

`controller.close()` hides a workspace while preserving its session; active sharing/recording remains indicated by the SDK launcher. `await controller.destroy()` releases that mount's media/session and removes its DOM. The example destroys controllers on page exit and before remounting. Its SIGINT/SIGTERM handlers close both server adapters and stop the host listener. `dataFile: null` keeps server room/session state in memory; restarting this sample removes that server state. A personal browser canvas remains browser-local under its own mount namespace.

## Choose Space & Time

The example's mounts default to classic. Open `http://127.0.0.1:3100/common-inline/?experience=space` for Space & Time under the inline service's namespace, or pass `experience: 'space'` to that mount's `mountCommon` options. Start a shared room there and use its room ID in `mountCommon({ target, basePath: '/common-inline/', roomId })` to open it inside your host page; room metadata takes precedence over the optional experience preference. Repeat under `/common-floating/` for that independent service. Existing rooms keep their experience, and earlier `?beta=space` links remain supported.

Space & Time provides multiple boards, templates, a spatial overview, automatic history, and agent access to the active board. Chat, guided participant checklists, and featured-screen rotation are available in classic instead. Boards and their history save as small edit records in this browser's IndexedDB. Hiding or destroying the mount leaves those device copies, while server access still ends when this in-memory example stops. Download **Export room** before removing browser data; **Import room** reopens a binary `.common` replay locally with its history and still accepts earlier JSON archives. See the [Space & Time guide](https://github.com/alexwelcing/common-workspace/blob/main/docs/space-time.md) for controls, storage behavior, and limits.
