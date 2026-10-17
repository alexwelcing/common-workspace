import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MiB = 1024 * 1024;
export const MEDIA_LIMITS = Object.freeze({ recordingBytes: 100 * MiB, walkthroughBytes: 64 * MiB, frameBytes: 5 * MiB, frames: 50, durationMs: 300000, width: 1920, height: 1080, outputBytes: 100 * MiB, jobTimeoutMs: 180000 });
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export class MediaError extends Error {
  constructor(message, status = 400, code = 'INVALID_MEDIA') { super(message); this.name = 'MediaError'; this.status = status; this.code = code; }
}
function aborted(signal) { return signal?.reason instanceof MediaError ? signal.reason : new MediaError('Media export was canceled.', 499, 'CANCELED'); }
function videoKind(bytes, mimeType) {
  const type = String(mimeType).split(';', 1)[0].trim().toLowerCase();
  if (type === 'video/webm' && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { extension: 'webm', demuxer: 'matroska' };
  if (type === 'video/mp4' && bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') return { extension: 'mp4', demuxer: 'mov' };
  throw new MediaError('Upload a browser WebM or MP4 recording with a matching content type.', 415, 'UNSUPPORTED_MEDIA');
}
function imageBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MEDIA_LIMITS.frameBytes * 4 / 3) + 100 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new MediaError('Walkthrough frames must be embedded PNG images under 5 MB.');
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (bytes.length > MEDIA_LIMITS.frameBytes || bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG) || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') throw new MediaError('A walkthrough frame is not a valid PNG.');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8388608) throw new MediaError('A walkthrough frame exceeds the 8-megapixel input limit.');
  return bytes;
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || height < 180 || width > MEDIA_LIMITS.width || height > MEDIA_LIMITS.height || width % 2 || height % 2) throw new MediaError('Choose even output dimensions between 320 × 180 and 1920 × 1080.');
  return { width, height };
}
function captionText(frame, width, height) {
  const title = frame.title || '', text = frame.text || '';
  const size = Math.max(14, Math.min(24, Math.round(height / 32)));
  const columns = Math.max(12, Math.floor((width - 48) / (size * .6)));
  const words = [title, text].filter(Boolean).join('\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').split(/\s+/u).flatMap(word => { const pieces = []; for (let offset = 0; offset < word.length; offset += columns) pieces.push(word.slice(offset, offset + columns)); return pieces; });
  const lines = []; let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > columns) { lines.push(line); line = word; } else line += `${line ? ' ' : ''}${word}`;
  }
  if (line) lines.push(line);
  if (lines.length > 4) { lines.length = 4; lines[3] = `${lines[3].slice(0, Math.max(1, columns - 1))}…`; }
  return { text: lines.join('\n'), size, height: Math.min(height, lines.length * (size + 6) + 28) };
}
export function validateWalkthrough(input) {
  if (!object(input) || Object.keys(input).some(key => !['frames', 'width', 'height'].includes(key))) throw new MediaError('Send walkthrough frames and optional output dimensions only.');
  if (!Array.isArray(input.frames) || input.frames.length < 1 || input.frames.length > MEDIA_LIMITS.frames) throw new MediaError('A walkthrough export needs between 1 and 50 frames.');
  const output = dimensions(input.width ?? 1280, input.height ?? 720); let durationMs = 0, total = 0;
  const frames = input.frames.map(frame => {
    if (!object(frame) || Object.keys(frame).some(key => !['dataUrl', 'durationMs', 'title', 'text'].includes(key))) throw new MediaError('A walkthrough frame contains unsupported fields.');
    const duration = frame.durationMs ?? 3000;
    if (!Number.isInteger(duration) || duration < 500 || duration > 30000) throw new MediaError('Each frame must last between 0.5 and 30 seconds.');
    for (const [key, max] of [['title', 200], ['text', 5000]]) if (frame[key] !== undefined && (typeof frame[key] !== 'string' || frame[key].length > max)) throw new MediaError(`Walkthrough ${key} is too long.`);
    const bytes = imageBytes(frame.dataUrl); durationMs += duration; total += bytes.length;
    return { bytes, durationMs: duration, title: frame.title || '', text: frame.text || '' };
  });
  if (durationMs > MEDIA_LIMITS.durationMs || total > 48 * MiB) throw new MediaError('Keep walkthrough exports under five minutes and 48 MB of PNG images.', 413, 'MEDIA_LIMIT');
  return { ...output, durationMs, frames };
}

/** Fixed FFmpeg operations only. No URLs, user paths, commands or filter syntax. */
export class LocalMediaEngine {
  constructor({ engine = 'native', ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', dockerImage = 'common-media-ffmpeg:local', timeoutMs = MEDIA_LIMITS.jobTimeoutMs } = {}) {
    if (!['native', 'docker'].includes(engine)) throw new Error('Choose the native or docker media engine.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,180}$/.test(dockerImage)) throw new Error('Invalid local Docker image name.');
    this.engine = engine; this.ffmpeg = ffmpeg; this.ffprobe = ffprobe; this.dockerImage = dockerImage; this.timeoutMs = Math.max(100, Math.min(MEDIA_LIMITS.jobTimeoutMs, timeoutMs));
  }
  async check() { return this.withDirectory(async directory => { await this.run('ffmpeg', ['-version'], { directory }); await this.run('ffprobe', ['-version'], { directory }); }); }
  async run(program, args, { directory = tmpdir(), signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) throw aborted(signal);
    let command = program === 'ffmpeg' ? this.ffmpeg : this.ffprobe, commandArgs = args;
    const container = `common-media-${randomUUID()}`;
    if (this.engine === 'docker') {
      command = 'docker';
      commandArgs = ['run', '--rm', '--name', container, '--network', 'none', '--cpus', '2', '--memory', '512m', '--pids-limit', '128', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, '--mount', `type=bind,source=${directory},target=/work`, '--workdir', '/work', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16777216', this.dockerImage, program, ...args];
    }
    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(command, commandArgs, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...(this.engine === 'docker' ? Object.fromEntries(['DOCKER_CONFIG', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) : {}) }, windowsHide: true });
        const chunks = []; let outputBytes = 0, errorBytes = 0, diagnostic = '', settled = false, termination = null, killTimer;
        const stop = error => { if (!termination) termination = error; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 200); };
        const onAbort = () => stop(aborted(signal));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const timer = setTimeout(() => stop(new MediaError('Local media export exceeded its processing deadline.', 408, 'MEDIA_TIMEOUT')), timeoutMs);
        child.stdout.on('data', bytes => { outputBytes += bytes.length; if (outputBytes > 256 * 1024) stop(new MediaError('The media tool returned too much data.', 422)); else chunks.push(bytes); });
        // Drain diagnostic output without retaining media paths or frame text.
        child.stderr.on('data', bytes => { errorBytes += bytes.length; diagnostic = (diagnostic + bytes.toString()).slice(-4096); if (errorBytes > 2 * MiB) stop(new MediaError('The media tool exceeded its diagnostic limit.', 422)); });
        const finish = (error, code) => {
          if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort);
          if (termination) reject(termination);
          else if (error) reject(new MediaError(`${program} is unavailable. Install FFmpeg or choose the optional Docker engine.`, 503, 'ENGINE_UNAVAILABLE'));
          else if (code !== 0) { const error = new MediaError('The local media tool could not decode or export this content. Try a fresh browser recording or PNG, and check the worker console.', 422, 'MEDIA_FAILED'); error.diagnostic = diagnostic; reject(error); }
          else resolve(Buffer.concat(chunks));
        };
        child.once('error', error => finish(error)); child.once('close', code => finish(null, code));
      });
    } finally {
      if (this.engine === 'docker') await new Promise(resolve => {
        const cleanup = spawn('docker', ['rm', '-f', container], { stdio: 'ignore', windowsHide: true });
        const timer = setTimeout(() => { cleanup.kill('SIGKILL'); resolve(); }, 2000);
        cleanup.once('error', () => { clearTimeout(timer); resolve(); }); cleanup.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
  async probe(file, directory, signal, demuxer) {
    const bytes = await this.run('ffprobe', ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', ...(demuxer ? ['-f', demuxer] : []), '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { directory, signal, timeoutMs: 15000 });
    let info; try { info = JSON.parse(bytes.toString()); } catch { throw new MediaError('The recording metadata could not be read.'); }
    const videos = info.streams?.filter(stream => stream.codec_type === 'video') || [];
    if (videos.length !== 1 || info.streams.length > 2 || info.streams.some(stream => !['video', 'audio'].includes(stream.codec_type))) throw new MediaError('Use a recording with one video track and at most one audio track.');
    const video = videos[0]; const duration = Number(info.format?.duration);
    if (!['vp8', 'vp9', 'av1', 'h264'].includes(video.codec_name) || !Number.isInteger(video.width) || !Number.isInteger(video.height) || video.width < 1 || video.height < 1 || video.width > 4096 || video.height > 4096 || video.width * video.height > 8388608) throw new MediaError('This recording exceeds the supported input dimensions or codecs.');
    if (Number.isFinite(duration) && duration > 301) throw new MediaError('Recordings must be five minutes or shorter.', 413, 'MEDIA_LIMIT');
    return { width: video.width, height: video.height, durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null };
  }
  async result(directory, signal) {
    const size = (await stat(join(directory, 'output.mp4'))).size;
    if (!size || size > MEDIA_LIMITS.outputBytes) throw new MediaError('The exported video exceeds its local size limit.', 413, 'MEDIA_LIMIT');
    const metadata = await this.probe('output.mp4', directory, signal, 'mov');
    return { bytes: await readFile(join(directory, 'output.mp4')), mimeType: 'video/mp4', ...metadata, engine: `ffmpeg-${this.engine}` };
  }
  async withDirectory(work) { const directory = await mkdtemp(join(tmpdir(), 'common-media-')); try { return await work(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
  encodeArgs() { return ['-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '23', '-maxrate', '2000k', '-bufsize', '4000k', '-pix_fmt', 'yuv420p', '-r', '24', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-fs', String(MEDIA_LIMITS.outputBytes), 'output.mp4']; }
  async exportRecording(bytes, { mimeType, signal } = {}) {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (!bytes.length || bytes.length > MEDIA_LIMITS.recordingBytes) throw new MediaError('Choose a recording under 100 MB.', 413, 'MEDIA_LIMIT');
    const kind = videoKind(bytes, mimeType);
    return this.withDirectory(async directory => {
      const file = `recording.${kind.extension}`; await writeFile(join(directory, file), bytes, { mode: 0o600 });
      await this.probe(file, directory, signal, kind.demuxer);
      await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864', '-threads', '2', '-filter_threads', '2', '-protocol_whitelist', 'file,pipe', '-f', kind.demuxer, '-i', file, '-t', '300', '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-vf', 'scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2', ...this.encodeArgs()], { directory, signal });
      return this.result(directory, signal);
    });
  }
  async exportWalkthrough(input, { signal } = {}) {
    const spec = validateWalkthrough(input);
    return this.withDirectory(async directory => {
      const lines = ['ffconcat version 1.0']; const captions = []; let elapsed = 0;
      for (const [index, frame] of spec.frames.entries()) {
        const name = `frame-${String(index).padStart(3, '0')}.png`, source = `source-${index}.png`;
        await writeFile(join(directory, source), frame.bytes, { mode: 0o600 });
        // A concat stream whose PNG dimensions change resets FFmpeg's fps
        // filter and shortens the video. Normalize each slide first, then keep
        // one stable frame format throughout the timed composition.
        await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864', '-threads', '2', '-filter_threads', '2', '-protocol_whitelist', 'file,pipe', '-i', source, '-frames:v', '1', '-vf', `scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2:color=0xfbf8f0`, '-c:v', 'png', '-threads', '2', '-pix_fmt', 'rgb24', '-update', '1', name], { directory, signal });
        lines.push(`file '${name}'`, `duration ${(frame.durationMs / 1000).toFixed(3)}`);
        if (frame.title || frame.text) {
          const caption = captionText(frame, spec.width, spec.height); const file = `caption-${index}.txt`;
          await writeFile(join(directory, file), caption.text, { mode: 0o600 });
          const enable = `gte(t,${(elapsed / 1000).toFixed(3)})*lt(t,${((elapsed + frame.durationMs) / 1000).toFixed(3)})`;
          captions.push(`drawbox=x=0:y=ih-${caption.height}:w=iw:h=${caption.height}:color=0xfbf8f0@0.96:t=fill:enable='${enable}'`, `drawtext=textfile=${file}:expansion=none:x=24:y=h-${caption.height - 14}:fontcolor=0x34483b:fontsize=${caption.size}:line_spacing=6:enable='${enable}'`);
        }
        elapsed += frame.durationMs;
      }
      lines.push(`file 'frame-${String(spec.frames.length - 1).padStart(3, '0')}.png'`);
      await writeFile(join(directory, 'frames.ffconcat'), lines.join('\n'), { mode: 0o600 });
      const filters = ['fps=24', ...captions];
      await this.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-max_alloc', '67108864', '-threads', '2', '-filter_threads', '2', '-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', 'frames.ffconcat', '-t', (spec.durationMs / 1000).toFixed(3), '-map', '0:v:0', '-an', '-map_metadata', '-1', '-vf', filters.join(','), ...this.encodeArgs()], { directory, signal });
      return this.result(directory, signal);
    });
  }
}
