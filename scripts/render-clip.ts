/**
 * scripts/render-clip.ts — the social clip, rendered headless.
 *
 * Draws the recorded replay with the SAME code the site's lanes use
 * (lib/render/court.ts via lib/render/frame.ts), on an @napi-rs/canvas
 * surface, and pipes raw frames straight into ffmpeg. Nothing is buffered:
 * one canvas is reused for every frame, so memory is flat whatever the length.
 *
 * Usage:
 *   pnpm render:clip --seconds 12 --layout both --gif
 *   pnpm render:clip --replay public/replay.json --out out/clip \
 *                    --seconds 12 --fps 30 --layout wide --gif --start 0
 *
 * Outputs, per layout:
 *   out/clip-<layout>.mp4           H.264, yuv420p, faststart
 *   out/clip-<layout>.gif           with --gif; 15 fps, 800 px wide, < 15 MB
 *   out/clip-mid-<layout>.png       the frame at t = 2 s
 *   out/clip-endcard-<layout>.png   the end card, with its bars grown
 *
 * `--seconds` is the PLAY time. The end card is added on top of it: 400 ms
 * freeze, 300 ms cross-fade, 2.5 s hold (motion note 07), so the default
 * `--seconds 12` produces a 15.2 s clip. The URL on the end card comes from
 * CLIP_URL, defaulting to tokens.copy.url.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import { CLIP_SECONDS } from '../lib/config/site';
import type { Replay } from '../lib/game/types';
import { loadAblyLogo, registerClipFonts } from '../lib/render/assets';
import { clipDurationMs, drawFrame } from '../lib/render/frame';
import { createReplayTimeline } from '../lib/render/timeline';
import { CLIP_TOKENS, type ClipLayout } from '../lib/render/tokens';

/** The still we export as the "mid" frame, measured from the clip start. */
const MID_FRAME_MS = 2000;
/**
 * Far enough past the freeze that the end card has faded in and the bars have
 * finished growing (300 cross-fade + 600 grow + 3 x 80 stagger).
 */
const END_STILL_OFFSET_MS = 1400;
const GIF_BUDGET_BYTES = 15 * 1024 * 1024;

/** Progressively cheaper GIF settings, tried until one fits the budget. */
const GIF_LADDER = [
  { width: 800, colors: 128 },
  { width: 720, colors: 96 },
  { width: 640, colors: 64 },
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Options {
  replay: string;
  out: string;
  seconds: number;
  fps: number;
  layouts: ClipLayout[];
  gif: boolean;
  startMs: number;
}

function parseArgs(argv: string[]): Options {
  const flags = new Map<string, string>();
  let gif = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'gif') {
      gif = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`--${key} needs a value`);
    }
    flags.set(key, next);
    i += 1;
  }

  const layoutFlag = flags.get('layout') ?? 'wide';
  const layouts: ClipLayout[] =
    layoutFlag === 'both'
      ? ['wide', 'square']
      : layoutFlag === 'square'
        ? ['square']
        : layoutFlag === 'wide'
          ? ['wide']
          : (() => {
              throw new Error(`--layout must be wide, square or both (got "${layoutFlag}")`);
            })();

  const num = (key: string, fallback: number): number => {
    const raw = flags.get(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--${key} must be a number (got "${raw}")`);
    return n;
  };

  return {
    replay: flags.get('replay') ?? 'public/replay.json',
    out: flags.get('out') ?? 'out/clip',
    seconds: num('seconds', CLIP_SECONDS),
    fps: num('fps', 30),
    layouts,
    gif,
    startMs: num('start', 0) * 1000,
  };
}

function ffmpegBin(): string {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const brew = '/opt/homebrew/bin/ffmpeg';
  return existsSync(brew) ? brew : 'ffmpeg';
}

/** Run ffmpeg to completion, failing loudly with its own stderr. */
async function runFfmpeg(args: string[]): Promise<void> {
  const child = spawn(ffmpegBin(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = (await once(child, 'close')) as [number];
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}\n${stderr.split('\n').slice(-25).join('\n')}`);
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface RenderResult {
  layout: ClipLayout;
  mp4: string;
  gif: string | null;
  mid: string;
  endcard: string;
  frames: number;
  renderMs: number;
  totalMs: number;
}

async function renderLayout(
  opts: Options,
  layout: ClipLayout,
  replay: Replay,
  logo: Awaited<ReturnType<typeof loadAblyLogo>>,
  url: string,
): Promise<RenderResult> {
  const startedAt = Date.now();
  const size = CLIP_TOKENS.sizes[layout];
  const canvas: Canvas = createCanvas(size.width, size.height);
  const ctx: SKRSContext2D = canvas.getContext('2d');

  // Built once, sampled thousands of times.
  const timelines = createReplayTimeline(replay, CLIP_TOKENS).lanes;
  const playMs = opts.startMs + opts.seconds * 1000;
  const endCard = { playMs, fromMs: opts.startMs };
  const drawOpts = { endCard, logo, url, timelines };

  const stem = `${dirname(opts.out)}/${basename(opts.out)}`;
  const mp4Path = `${stem}-${layout}.mp4`;
  const midPath = `${stem}-mid-${layout}.png`;
  const endPath = `${stem}-endcard-${layout}.png`;

  // yuv420p needs even dimensions; 1200x675 is not. Pad rather than scale, so
  // the PNG stills stay at the exact sizes the brief asks for.
  const evenW = size.width + (size.width % 2);
  const evenH = size.height + (size.height % 2);
  const pad =
    evenW !== size.width || evenH !== size.height
      ? [
          '-vf',
          `pad=${evenW}:${evenH}:0:0:color=0x${CLIP_TOKENS.colors.bg.replace('#', '')}`,
        ]
      : [];

  const ffmpeg = spawn(
    ffmpegBin(),
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'rawvideo',
      '-pixel_format', 'rgba',
      '-video_size', `${size.width}x${size.height}`,
      '-framerate', String(opts.fps),
      '-i', 'pipe:0',
      ...pad,
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      mp4Path,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  let ffmpegErr = '';
  ffmpeg.stderr.on('data', (c: Buffer) => {
    ffmpegErr += c.toString();
  });

  const totalMs = clipDurationMs(opts.seconds * 1000, CLIP_TOKENS);
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * opts.fps));
  const renderStart = Date.now();

  for (let f = 0; f < totalFrames; f += 1) {
    const tMs = opts.startMs + (f / opts.fps) * 1000;
    drawFrame(ctx, replay, tMs, layout, CLIP_TOKENS, drawOpts);
    // canvas.data() is the raw RGBA pixmap — no encode, no copy of the frame
    // list. One buffer per frame, handed straight to ffmpeg.
    if (!ffmpeg.stdin.write(canvas.data())) {
      await once(ffmpeg.stdin, 'drain');
    }
  }

  ffmpeg.stdin.end();
  const [code] = (await once(ffmpeg, 'close')) as [number];
  if (code !== 0) {
    throw new Error(`ffmpeg exited ${code}\n${ffmpegErr.split('\n').slice(-25).join('\n')}`);
  }
  const renderMs = Date.now() - renderStart;

  // --- stills --------------------------------------------------------------
  drawFrame(ctx, replay, opts.startMs + MID_FRAME_MS, layout, CLIP_TOKENS, drawOpts);
  await writeFile(midPath, canvas.toBuffer('image/png'));

  drawFrame(
    ctx,
    replay,
    endCard.playMs + CLIP_TOKENS.motion.freezeMs + END_STILL_OFFSET_MS,
    layout,
    CLIP_TOKENS,
    drawOpts,
  );
  await writeFile(endPath, canvas.toBuffer('image/png'));

  // --- gif -----------------------------------------------------------------
  let gifPath: string | null = null;
  if (opts.gif) {
    gifPath = `${stem}-${layout}.gif`;
    for (const rung of GIF_LADDER) {
      await runFfmpeg([
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', mp4Path,
        '-filter_complex',
        `fps=15,scale=${rung.width}:-1:flags=lanczos,split[a][b];` +
          `[a]palettegen=max_colors=${rung.colors}[p];` +
          `[b][p]paletteuse=dither=bayer:bayer_scale=3`,
        '-loop', '0',
        gifPath,
      ]);
      const bytes = await sizeOf(gifPath);
      if (bytes <= GIF_BUDGET_BYTES) break;
      console.log(
        `  gif ${rung.width}px/${rung.colors} colours = ${fmtBytes(bytes)}, over budget — retrying`,
      );
    }
  }

  return {
    layout,
    mp4: mp4Path,
    gif: gifPath,
    mid: midPath,
    endcard: endPath,
    frames: totalFrames,
    renderMs,
    totalMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.chdir(root);

  const fonts = registerClipFonts(CLIP_TOKENS, root);
  for (const note of fonts.notes) console.log(`font: ${note}`);
  console.log(`fonts registered: ${fonts.registered.join(', ') || '(none — system fonts)'}`);

  const logo = await loadAblyLogo(CLIP_TOKENS, root);
  if (!logo) {
    console.log('logo: brand SVG did not load — drawing the wordmark as text');
  }

  const raw = await readFile(resolve(root, opts.replay), 'utf8');
  const replay = JSON.parse(raw) as Replay;
  const url = process.env.CLIP_URL ?? CLIP_TOKENS.copy.url;

  await mkdir(dirname(opts.out), { recursive: true });

  const totalSeconds = clipDurationMs(opts.seconds * 1000, CLIP_TOKENS) / 1000;
  console.log(
    `replay ${opts.replay}: ${replay.lanes.length} lanes · ` +
      `${opts.seconds}s play + end card = ${totalSeconds.toFixed(1)}s @ ${opts.fps}fps ` +
      `from ${opts.startMs / 1000}s · url ${url}`,
  );

  const results: RenderResult[] = [];
  for (const layout of opts.layouts) {
    console.log(`\n${layout}: rendering…`);
    results.push(await renderLayout(opts, layout, replay, logo, url));
  }

  console.log('\nDone.');
  for (const r of results) {
    const parts = [
      `${r.mp4} ${fmtBytes(await sizeOf(r.mp4))}`,
      r.gif ? `${r.gif} ${fmtBytes(await sizeOf(r.gif))}` : null,
      `${r.mid} ${fmtBytes(await sizeOf(r.mid))}`,
      `${r.endcard} ${fmtBytes(await sizeOf(r.endcard))}`,
    ].filter((p): p is string => p !== null);
    console.log(
      `${r.layout.padEnd(6)} ${r.frames} frames · render+encode ${(r.renderMs / 1000).toFixed(1)}s · ` +
        `total ${(r.totalMs / 1000).toFixed(1)}s`,
    );
    for (const p of parts) console.log(`  ${p}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
