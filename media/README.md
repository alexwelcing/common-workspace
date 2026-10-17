# Optional local MP4 export

Common's browser recording and original-file downloads work independently of this extension. The optional worker turns a finished WebM/MP4 recording or a sequence of annotated canvas PNG snapshots into an H.264 MP4. It uses local FFmpeg; no Cloudflare account, media hosting, or remote processing service is involved.

Run the worker on the same computer as your browser, with Bun and FFmpeg/FFprobe installed:

```sh
bun run media:export --origin http://localhost:5173
```

Use your app's exact origin, including its port. Add another `--origin` for another explicitly trusted app origin. For a deployed site, use its HTTPS origin. The worker prints its loopback URL and a random session token. Enter both in Common's **Canvas options → Recording exports**. The app keeps that token in memory; closing the worker revokes it. A browser may also require local-network permission, and some managed browsers block HTTPS-to-loopback access. Running Common locally is the fallback.

The worker binds only `127.0.0.1`. Authentication, exact Origin and Host checks, bounded uploads, one concurrent job, processing deadlines, fixed tool arguments, and local-file-only input protocols are enforced before or during processing. It accepts embedded PNGs and browser recordings, never URLs, arbitrary file paths, shell commands, or FFmpeg filter expressions. Temporary media files are deleted after completion, failure, or cancellation. Downloaded MP4s stay wherever you save them. Native mode uses the installed toolchain; Docker mode adds a process and network boundary. Keep your local media tools updated.

## Operation and limits

- Recording input: WebM or MP4, up to 100 MiB, one video track and at most one audio track; supported browser video codecs are VP8, VP9, AV1 and H.264.
- Walkthrough: 1–50 PNGs, up to 5 MiB per frame and 48 MiB decoded images total; JSON upload capped at 64 MiB. Each slide lasts 0.5–30 seconds; total duration is at most five minutes.
- Input images/video: at most 4096 pixels per dimension and 8 megapixels. Walkthrough output uses even dimensions from 320 × 180 through 1920 × 1080. Recording exports fit within 1920 × 1080 without changing their aspect ratio.
- Output: H.264/yuv420p, 24 fps, MP4 with optional AAC audio, at most 100 MiB. Known recordings over five minutes are rejected; browser files with missing duration metadata are capped at five minutes during encoding.
- Optional slide titles and text are burned into a cream caption strip, wrapped and limited to four lines. Annotations already painted into each PNG remain part of its image. PNGs are normalized before composition so different image dimensions retain the requested timing.
- Each tool invocation has a deadline; the complete HTTP job has a 225-second deadline. Cancellation stops processing and removes temporary files. Large exports may need smaller frames or a shorter duration on slower machines. Several hundred MiB of temporary local disk space can be needed for a large composition.

The worker console reports `uploading`, `processing`, `finished`, `failed`, or `canceled`, with output dimensions/duration/size or an actionable error. Authenticated `GET /health` and `GET /v1/capabilities` return the current or last job, engine, limits, and busy state. Tool failures include diagnostic details in the local console; the browser receives a bounded message without internal paths or tool stacks. Media contents and credentials are not written to application logs.

## Optional Docker engine

Build the supplied batch image once, then start the same local worker:

```sh
docker build -t common-media-ffmpeg:local media
bun run media:export --origin http://localhost:5173 --engine docker
```

The worker uses your configured Docker daemon/context; select a **local** daemon. A running job gets only its private temporary folder, runs as the caller's numeric user/group, and has no container network, capabilities, or writable root filesystem. Its limits are 2 CPUs, 512 MiB RAM, 128 processes, and a 16 MiB temporary filesystem. The worker itself stays on loopback. Docker must support bind mounts, numeric users, and these resource/security options; Docker Desktop may need file-sharing permission for the system temporary directory. Native mode remains available when Docker is unsuitable. No registry login is required for the public Debian-based build.

## Client and HTTP interface

```js
import { LocalMediaExport } from './src/media-export.js';
const exporter = new LocalMediaExport({ endpoint: 'http://127.0.0.1:8788', token });
await exporter.capabilities();
const mp4 = await exporter.exportRecording(capture.getRecordingBlob(recordingId), { signal });
// Or export the PNGs produced by capture.snapshot(), in presentation order:
const slides = await exporter.exportWalkthrough({
  width: 1280, height: 720,
  frames: [{ dataUrl: snapshot.dataUrl, durationMs: 3000, title: 'A useful detail', text: 'Look at the highlighted area.' }],
}, { signal });
exporter.download(slides);
exporter.destroy();
```

Results contain `{blob, filename, mimeType, width, height, durationMs, engine}`. `destroy()` cancels requests and clears the token. `capture.getRecordingBlob(id)` returns the immutable saved Blob, leaving the capture service's storage private. It rejects unfinished, discarded, missing, or closed recordings. No agent command automatically configures or launches the local worker.

Every request requires the allowed `Origin` plus `Authorization: Bearer SESSION_TOKEN`. Routes are `GET /health`, `GET /v1/capabilities`, `POST /v1/recording` (raw `video/webm` or `video/mp4`), and `POST /v1/walkthrough` (JSON shown above). Preflights allow only GET/POST, Authorization and Content-Type, and explicitly support private-network access for allowed origins. The MP4 response exposes its filename and media metadata through CORS headers. A worker is an optional processor on the browser's computer, not a shared unauthenticated server endpoint.

## Streamline research and interoperability

Source inspected on 2026-10-17:

- [Streamline README, commit 0b101163](https://github.com/cloudflare/streamline/blob/0b101163d0febf6af405b99de6eae680601b5e7e/README.md): Apache-2.0 Go/FFmpeg media engine; deployed Worker/Container use belongs to an application.
- [Session API contract](https://github.com/cloudflare/streamline/blob/0b101163d0febf6af405b99de6eae680601b5e7e/docs/SESSION_API_CONTRACT.md): webcam chunks, HLS or RTMP input; PNG annotation replacement; fMP4 WebSocket preview or RTMP output. It does not define a batch MP4-download or timed-PNG-slideshow export endpoint.
- [Container routes](https://github.com/cloudflare/streamline/blob/0b101163d0febf6af405b99de6eae680601b5e7e/container/main.go) and [output handling](https://github.com/cloudflare/streamline/blob/0b101163d0febf6af405b99de6eae680601b5e7e/container/http_output.go): direct `/start`, `/ingest`, `/api/annotation`, `/output`, `/stop` paths can support a local live-stream adapter, but require session/output lifecycle handling and application-owned authentication.
- [Demo local startup, commit bc059dc6](https://github.com/cloudflare/streamline-demo/blob/bc059dc6c872cbf15b4c2111aee47c2f30a4c356/scripts/start-local.mjs) and [local proxy](https://github.com/cloudflare/streamline-demo/blob/bc059dc6c872cbf15b4c2111aee47c2f30a4c356/src/lib/local-container-proxy.ts): the Docker/Astro local path can run without Cloudflare deployment. Its development wiring is distinct from the hosted reference deployment and should not be exposed as a public media processor.

The implemented batch worker uses FFmpeg directly because it supplies the actual downloadable recording and slideshow output this application needs, with a smaller local lifecycle and no cloud relay dependency. This is an explicit implementation choice; the shipped worker does **not** claim to run Streamline.

[streamline-preview-plan.json](streamline-preview-plan.json) is a concrete upstream-format live-preview configuration for a future adapter: webcam ingress, full-canvas annotation overlay, H.264 encode, fMP4 preview. The existing `capture.snapshot()` PNG fits the upstream annotation format; an adapter would publish sequential MediaRecorder chunks (at most 1 MiB each) and PNG replacements (at most 5 MiB), fence each session, collect/consume preview frames, and stop cleanly. That configuration is an interoperability example, not a shipped or verified live Streamline connector. No Streamline code is vendored here.

## Actual export artifacts

Run the accountless HTTP export path with synthetic annotated PNGs:

```sh
bun scripts/media-smoke.mjs
bun scripts/media-smoke.mjs --engine docker --output media/artifacts/walkthrough-docker-smoke.mp4
```

The script writes the MP4 plus a provenance JSON containing dimensions, duration, engine and SHA-256. Both native FFmpeg and the optional Docker image produced three-second, 640 × 360 H.264 walkthrough artifacts in this workspace. These are synthetic composition examples, not recordings of a real team session. The browser recording-to-MP4 HTTP path was also exercised with a real locally encoded WebM. The artifacts can be opened directly; no cloud service or account is needed.
