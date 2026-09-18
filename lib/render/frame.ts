/**
 * lib/render/frame.ts — one whole clip frame, laid out and drawn.
 *
 * Four stacked lanes: name on the left, the court in the middle, the last
 * decision in milliseconds on the right as the biggest thing in the row.
 * Wordmark and the one-line explanation top-left, the elapsed timer top-right,
 * and a strip along the bottom that always carries "Powered by Ably".
 *
 * Pure: it draws into any `ClipCtx` and reads every colour, size and font from
 * `ClipTokens`. It holds no canvas, loads no file and keeps no state. The Ably
 * logo is passed in already decoded (see `opts.logo`) so this module has no
 * I/O; when it is absent the wordmark is drawn as text instead.
 *
 * The end card (motion note 07) lives here too: at `playMs` the courts freeze,
 * then the scoreboard cross-fades in over them and the bars grow.
 */

import { LANES, type Replay } from '../game/types';
import { mixHex } from './color';
import { courtStyle, drawCourt, type CourtTheme } from './court';
import type { Box, ClipCtx } from './ctx';
import { drawText, ellipsize, fitSize } from './text';
import { createReplayTimeline, type LaneTimeline } from './timeline';
import {
  CLIP_TOKENS,
  ballColorFor,
  numberColorFor,
  providerFor,
  type ClipLayout,
  type ClipLayoutSizes,
  type ClipTokens,
} from './tokens';

/** Ascender as a fraction of the font size. Close enough for one line. */
const ASC = 0.78;

/** The end card freezes the courts and covers them with the scoreboard. */
export interface EndCardOptions {
  /** Replay time the play section ends and the courts freeze. */
  playMs: number;
  /**
   * Replay time the clip started at. The scoreboard counts decisions over
   * [fromMs, playMs] and the headline quotes that many seconds, so a clip cut
   * out of the middle of a recording still tells the truth.
   */
  fromMs: number;
}

export interface DrawFrameOptions {
  endCard?: EndCardOptions;
  /**
   * A decoded image of the Ably horizontal logo. `@napi-rs/canvas`'s
   * `loadImage` returns one. Omit it and the wordmark is drawn as text.
   */
  logo?: { width: number; height: number } | null;
  /** Overrides `tokens.copy.url`. The CLI feeds it from CLIP_URL. */
  url?: string;
  /** Prebuilt timelines. Pass them in to avoid rebuilding on every frame. */
  timelines?: LaneTimeline[];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LaneBoxes {
  row: Box;
  name: Box;
  court: Box;
  number: Box;
}

export interface FrameLayout {
  sizes: ClipLayoutSizes;
  content: Box;
  header: Box;
  lanes: LaneBoxes[];
  strip: Box;
}

function easeOutCubic(p: number): number {
  return 1 - Math.pow(1 - p, 3);
}

function clamp01(p: number): number {
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/**
 * Solve the frame geometry. Separated from drawing so it can be asserted in a
 * test and so a designer can see exactly what each size token moves.
 */
export function layoutFrame(
  tokens: ClipTokens,
  layout: ClipLayout,
  laneCount: number,
): FrameLayout {
  const s = tokens.sizes[layout];
  const content: Box = {
    x: s.padX,
    y: s.padTop,
    w: s.width - s.padX * 2,
    h: s.height - s.padTop - s.padBottom,
  };
  const header: Box = { x: content.x, y: content.y, w: content.w, h: s.headerH };
  const strip: Box = {
    x: content.x,
    y: content.y + content.h - s.stripH,
    w: content.w,
    h: s.stripH,
  };

  const lanesTop = header.y + header.h + s.blockGap;
  const lanesH = Math.max(0, strip.y - s.blockGap - lanesTop);
  const lanes: LaneBoxes[] = [];
  if (laneCount === 0) return { sizes: s, content, header, lanes, strip };

  if (s.laneMode === 'row') {
    const rowH = (lanesH - s.laneGap * (laneCount - 1)) / laneCount;
    const courtX = content.x + s.nameColW + s.colGap;
    const courtW = Math.min(
      s.courtW,
      content.w - s.nameColW - s.numberColW - s.colGap * 2,
    );
    const courtH = (courtW / s.courtW) * s.courtH;
    for (let i = 0; i < laneCount; i += 1) {
      const row: Box = { x: content.x, y: lanesTop + i * (rowH + s.laneGap), w: content.w, h: rowH };
      lanes.push({
        row,
        name: { x: row.x, y: row.y, w: s.nameColW, h: row.h },
        court: {
          x: courtX,
          y: Math.round(row.y + (row.h - courtH) / 2),
          w: Math.round(courtW),
          h: Math.round(courtH),
        },
        number: {
          x: content.x + content.w - s.numberColW,
          y: row.y,
          w: s.numberColW,
          h: row.h,
        },
      });
    }
    return { sizes: s, content, header, lanes, strip };
  }

  // Stacked: a name row over a full-width court, the phone arrangement.
  const nameRowH = s.numberSize + 4 + s.countsSize * 1.2;
  const courtW = Math.min(s.courtW, content.w);
  const courtH = (courtW / s.courtW) * s.courtH;
  const blockH = nameRowH + s.stackGap + courtH;
  const stackH = blockH * laneCount + s.laneGap * (laneCount - 1);
  const top = lanesTop + Math.max(0, (lanesH - stackH) / 2);

  for (let i = 0; i < laneCount; i += 1) {
    const y = top + i * (blockH + s.laneGap);
    const row: Box = { x: content.x, y, w: content.w, h: blockH };
    lanes.push({
      row,
      name: { x: row.x, y, w: content.w / 2, h: nameRowH },
      court: {
        x: Math.round(content.x + (content.w - courtW) / 2),
        y: Math.round(y + nameRowH + s.stackGap),
        w: Math.round(courtW),
        h: Math.round(courtH),
      },
      number: { x: row.x + content.w / 2, y, w: content.w / 2, h: nameRowH },
    });
  }

  return { sizes: s, content, header, lanes, strip };
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

function courtTheme(tokens: ClipTokens, model: string): CourtTheme {
  return {
    court: tokens.colors.court,
    hair: tokens.colors.hair,
    courtLine: tokens.colors.courtLine,
    paddle: tokens.colors.paddle,
    ball: ballColorFor(tokens, model),
    fgMuted: tokens.colors.fgMuted,
  };
}

/** "5 decisions · 0 returns", with the singular where it is due. */
export function countsLine(decisions: number, returns: number): string {
  const d = `${decisions} decision${decisions === 1 ? '' : 's'}`;
  const r = `${returns} return${returns === 1 ? '' : 's'}`;
  return `${d} · ${r}`;
}

function drawHeader(
  ctx: ClipCtx,
  tokens: ClipTokens,
  l: FrameLayout,
  elapsedMs: number,
  titleSize: number,
): void {
  const s = l.sizes;
  const baseline = l.header.y + titleSize * ASC;

  ctx.fillStyle = tokens.colors.fg;
  const titleW = drawText(ctx, tokens.fonts.title, titleSize, tokens.copy.title, l.header.x, baseline);

  if (s.taglineSize > 0 && titleSize >= s.titleSize) {
    ctx.fillStyle = tokens.colors.fgMuted;
    drawText(
      ctx,
      tokens.fonts.body,
      s.taglineSize,
      tokens.copy.tagline,
      l.header.x + titleW + 14,
      baseline,
    );
  }

  // elapsed, right-aligned on the same baseline.
  const right = l.header.x + l.header.w;
  ctx.fillStyle = tokens.colors.fg;
  const valueW = drawText(
    ctx,
    tokens.fonts.mono,
    s.elapsedSize,
    seconds(elapsedMs),
    right,
    baseline,
    'right',
  );
  ctx.fillStyle = tokens.colors.fgMuted;
  drawText(
    ctx,
    tokens.fonts.mono,
    s.elapsedLabelSize,
    tokens.copy.elapsedLabel,
    right - valueW - 8,
    baseline,
    'right',
  );
}

/**
 * The bottom strip: "Powered by" + the real Ably horizontal logo at 22px with
 * its clearspace, and the measurement line on the right.
 */
function drawStrip(
  ctx: ClipCtx,
  tokens: ClipTokens,
  l: FrameLayout,
  logo: DrawFrameOptions['logo'],
): void {
  const s = l.sizes;
  const centreY = l.strip.y + l.strip.h / 2;

  ctx.fillStyle = tokens.colors.fgMuted;
  const poweredW = drawText(
    ctx,
    tokens.fonts.body,
    s.poweredSize,
    tokens.copy.poweredBy,
    l.strip.x,
    centreY + s.poweredSize * 0.35,
  );

  const logoX = l.strip.x + poweredW + s.logoClearspace;
  if (logo && typeof ctx.drawImage === 'function' && logo.height > 0) {
    const logoW = (logo.width / logo.height) * s.logoH;
    ctx.drawImage(logo as never, logoX, Math.round(centreY - s.logoH / 2), logoW, s.logoH);
  } else {
    ctx.fillStyle = tokens.colors.fg;
    drawText(ctx, tokens.fonts.title, s.logoH, 'Ably', logoX, centreY + s.logoH * 0.35);
  }

  ctx.fillStyle = tokens.colors.fgMuted;
  drawText(
    ctx,
    tokens.fonts.body,
    s.creditsSize,
    tokens.copy.measurement,
    l.strip.x + l.strip.w,
    centreY + s.creditsSize * 0.35,
    'right',
  );
}

/** Name over provider tag, as a block centred on `centreY`. */
function drawName(
  ctx: ClipCtx,
  tokens: ClipTokens,
  x: number,
  centreY: number,
  maxW: number,
  label: string,
  gateway: string | null,
  nameSize: number,
  providerSize: number,
  gap: number,
): void {
  const blockH = nameSize * 1.1 + gap + providerSize * 1.2;
  const top = centreY - blockH / 2;

  const size = fitSize(ctx, tokens.fonts.name, nameSize, label, maxW, 12);
  ctx.fillStyle = tokens.colors.fg;
  drawText(
    ctx,
    tokens.fonts.name,
    size,
    ellipsize(ctx, tokens.fonts.name, size, label, maxW),
    x,
    top + nameSize * 0.86,
  );

  ctx.fillStyle = tokens.colors.fgMuted;
  drawText(
    ctx,
    tokens.fonts.tag,
    providerSize,
    providerFor(tokens, gateway),
    x,
    top + nameSize * 1.1 + gap + providerSize * 0.95,
  );
}

/**
 * The latency number and the counts under it, right-aligned at `right` and
 * centred on `centreY`. Motion note 04.
 */
function drawNumber(
  ctx: ClipCtx,
  tokens: ClipTokens,
  right: number,
  centreY: number,
  model: string,
  value: number | null,
  inFlight: boolean,
  pulse: number,
  flash: number,
  counts: string,
  numberSize: number,
  unitSize: number,
  countsSize: number,
  gap: number,
): void {
  const blockH = numberSize + gap + countsSize * 1.2;
  const top = centreY - blockH / 2;
  const baseline = top + numberSize * ASC;

  const role = inFlight ? tokens.fonts.numberInFlight : tokens.fonts.number;
  const landedColor = numberColorFor(tokens, model);
  const color = inFlight
    ? tokens.colors.fgInflight
    : flash > 0
      ? mixHex(landedColor, '#FFFFFF', flash)
      : landedColor;

  ctx.fillStyle = inFlight ? tokens.colors.fgInflight : tokens.colors.fgMuted;
  const unitW = drawText(ctx, tokens.fonts.body, unitSize, tokens.copy.msLabel, right, baseline, 'right');

  // The unit does not pulse; only the number grows.
  const size = Math.round(numberSize * (1 + pulse * (tokens.motion.pulseScale - 1)));
  ctx.fillStyle = color;
  drawText(
    ctx,
    role,
    size,
    value === null ? '—' : String(Math.max(0, Math.round(value))),
    right - unitW - unitSize * 0.35,
    baseline,
    'right',
  );

  ctx.fillStyle = tokens.colors.fgMuted;
  drawText(
    ctx,
    tokens.fonts.body,
    countsSize,
    counts,
    right,
    top + numberSize + gap + countsSize * 0.95,
    'right',
  );
}

// ---------------------------------------------------------------------------
// The end card
// ---------------------------------------------------------------------------

export interface EndCardRow {
  model: string;
  label: string;
  gateway: string | null;
  decisions: number;
  returns: number;
}

/**
 * One row per lane, in LANE ORDER. Lanes never re-sort (SPEC, must-not-get-
 * wrong b), so the scoreboard reads the same way the courts above it did.
 */
export function endCardRows(
  replay: Replay,
  timelines: LaneTimeline[],
  fromMs: number,
  toMs: number,
): EndCardRow[] {
  return replay.lanes.map((lane, i) => {
    const stats = timelines[i].statsIn(fromMs, toMs);
    const config = LANES.find((c) => c.id === lane.model);
    return {
      model: lane.model as string,
      label: lane.label,
      gateway: config?.gateway ?? null,
      decisions: stats.decisions,
      returns: stats.returns,
    };
  });
}

function drawEndCard(
  ctx: ClipCtx,
  tokens: ClipTokens,
  layout: ClipLayout,
  rows: EndCardRow[],
  playSeconds: number,
  elapsedMs: number,
  barProgress: (index: number) => number,
  url: string,
  logo: DrawFrameOptions['logo'],
): void {
  const s = tokens.sizes[layout];
  const content: Box = {
    x: s.endPadX,
    y: s.endPadTop,
    w: s.width - s.endPadX * 2,
    h: s.height - s.endPadTop - s.endPadBottom,
  };

  ctx.fillStyle = tokens.colors.bg;
  ctx.fillRect(0, 0, s.width, s.height);

  // --- block heights, then space-between ----------------------------------
  const headerH = s.endTitleSize;
  const headlineH = s.endHeadlineSize * 1.05 + 10 + s.endSubtitleSize * 1.2;
  const rowH = Math.max(s.endCountSize, s.endBarH + 6 + s.endReturnsSize * 1.2, s.endNameSize * 1.1 + 4 + 12 * 1.2);
  const rowsH = rows.length * rowH + Math.max(0, rows.length - 1) * s.endRowGap;
  const urlH = s.endUrlSize * 1.2;
  const stripH = s.stripH;
  const used = headerH + headlineH + rowsH + urlH + stripH;
  // Space-between, but never more air than `endMaxGap`: the headline, the
  // scoreboard and the ask stay one block, centred between the chrome.
  const gap = Math.min(s.endMaxGap, Math.max(16, (content.h - used) / 4));
  const between = content.h - headerH - stripH;
  const middle = headlineH + rowsH + urlH + gap * 2;

  // --- header --------------------------------------------------------------
  const layoutForChrome: FrameLayout = {
    sizes: s,
    content,
    header: { x: content.x, y: content.y, w: content.w, h: headerH },
    lanes: [],
    strip: { x: content.x, y: content.y + content.h - stripH, w: content.w, h: stripH },
  };
  drawHeader(ctx, tokens, layoutForChrome, elapsedMs, s.endTitleSize);

  // --- headline ------------------------------------------------------------
  let y = content.y + headerH + Math.max(gap, (between - middle) / 2);
  ctx.fillStyle = tokens.colors.fg;
  drawText(
    ctx,
    tokens.fonts.headline,
    s.endHeadlineSize,
    tokens.copy.endHeadline.replace('{n}', String(playSeconds)),
    content.x,
    y + s.endHeadlineSize * 0.82,
  );
  ctx.fillStyle = tokens.colors.fgMuted;
  drawText(
    ctx,
    tokens.fonts.body,
    s.endSubtitleSize,
    tokens.copy.endSubtitle,
    content.x,
    y + s.endHeadlineSize * 1.05 + 10 + s.endSubtitleSize * 0.95,
  );

  // --- rows ----------------------------------------------------------------
  y += headlineH + gap;
  const barX = content.x + s.endNameColW + s.endColGap;
  const barW = content.w - s.endNameColW - s.endCountColW - s.endColGap * 2;
  const countRight = content.x + content.w;
  const most = Math.max(1, ...rows.map((r) => r.decisions));

  rows.forEach((row, i) => {
    const centreY = y + i * (rowH + s.endRowGap) + rowH / 2;
    const p = barProgress(i);

    drawName(
      ctx,
      tokens,
      content.x,
      centreY,
      s.endNameColW,
      row.label,
      row.gateway,
      s.endNameSize,
      12,
      4,
    );

    // bar + "N returns" under it, as one block centred on the row
    const barBlockH = s.endBarH + 6 + s.endReturnsSize * 1.2;
    const barTop = centreY - barBlockH / 2;
    const width = Math.max(0, (row.decisions / most) * barW * p);
    ctx.save();
    ctx.fillStyle = row.model === 'jev' ? tokens.colors.jev : tokens.colors.barMuted;
    ctx.beginPath();
    if (width > 0 && typeof ctx.roundRect === 'function') {
      ctx.roundRect(barX, barTop, width, s.endBarH, Math.min(s.endBarRadius, width / 2));
      ctx.fill();
    } else if (width > 0) {
      ctx.fillRect(barX, barTop, width, s.endBarH);
    }
    ctx.restore();

    ctx.fillStyle = tokens.colors.fgMuted;
    drawText(
      ctx,
      tokens.fonts.body,
      s.endReturnsSize,
      `${row.returns} return${row.returns === 1 ? '' : 's'}`,
      barX,
      barTop + s.endBarH + 6 + s.endReturnsSize * 0.95,
      'left',
    );

    ctx.fillStyle = row.model === 'jev' ? tokens.colors.jev : tokens.colors.fg;
    drawText(
      ctx,
      tokens.fonts.number,
      s.endCountSize,
      String(Math.round(row.decisions * p)),
      countRight,
      // Cap height is close enough to 0.72em, so this centres the numerals.
      centreY + s.endCountSize * 0.36,
      'right',
    );
  });

  // --- the ask -------------------------------------------------------------
  y += rowsH + gap;
  const labelBaseline = y + s.endUrlSize * 0.8;
  ctx.fillStyle = tokens.colors.fgMuted;
  const labelW = drawText(
    ctx,
    tokens.fonts.body,
    s.endUrlLabelSize,
    tokens.copy.endUrlLabel,
    content.x,
    labelBaseline,
  );
  ctx.fillStyle = tokens.colors.fg;
  drawText(ctx, tokens.fonts.mono, s.endUrlSize, url, content.x + labelW + 12, labelBaseline);

  drawStrip(ctx, tokens, layoutForChrome, logo);
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/** Where a clip time falls in the end-card sequence (motion note 07). */
export interface ClipPhase {
  /** Replay time the courts are drawn at. */
  courtTimeMs: number;
  /** 0..1 opacity of the end card over the frozen frame. */
  endCardAlpha: number;
  /** Milliseconds since the bars started growing. Negative before they do. */
  barsSinceMs: number;
}

export function clipPhaseAt(
  tMs: number,
  end: EndCardOptions | undefined,
  tokens: ClipTokens = CLIP_TOKENS,
): ClipPhase {
  if (!end || tMs < end.playMs) {
    return { courtTimeMs: tMs, endCardAlpha: 0, barsSinceMs: -1 };
  }
  const m = tokens.motion;
  const since = tMs - end.playMs;
  const fadeStart = m.freezeMs;
  const fadeEnd = fadeStart + m.crossFadeMs;
  return {
    courtTimeMs: end.playMs,
    endCardAlpha: since <= fadeStart ? 0 : clamp01((since - fadeStart) / m.crossFadeMs),
    barsSinceMs: since - fadeEnd,
  };
}

/** Total length of a clip: the play section plus the end card. */
export function clipDurationMs(playMs: number, tokens: ClipTokens = CLIP_TOKENS): number {
  const m = tokens.motion;
  return playMs + m.freezeMs + m.crossFadeMs + m.holdMs;
}

/**
 * Paint the whole frame at `tMs` (milliseconds into the replay).
 *
 * When `opts.endCard` is given and `tMs` is past its `playMs`, the lanes are
 * drawn frozen and the scoreboard fades in over them.
 */
export function drawFrame(
  ctx: ClipCtx,
  replay: Replay,
  tMs: number,
  layout: ClipLayout,
  tokens: ClipTokens = CLIP_TOKENS,
  opts: DrawFrameOptions = {},
): void {
  const timelines = opts.timelines ?? createReplayTimeline(replay, tokens).lanes;
  const l = layoutFrame(tokens, layout, replay.lanes.length);
  const s = l.sizes;
  const end = opts.endCard;
  const phase = clipPhaseAt(tMs, end, tokens);
  const from = end?.fromMs ?? 0;
  const surface = layout === 'wide' ? 'clip-wide' : 'clip-square';

  // --- page ----------------------------------------------------------------
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = tokens.colors.bg;
  ctx.fillRect(0, 0, s.width, s.height);
  ctx.restore();

  drawHeader(ctx, tokens, l, phase.courtTimeMs - from, s.titleSize);

  // --- lanes ---------------------------------------------------------------
  for (let i = 0; i < replay.lanes.length; i += 1) {
    const lane = replay.lanes[i];
    const boxes = l.lanes[i];
    const timeline = timelines[i];
    const number = timeline.numberAt(phase.courtTimeMs);
    const style = courtStyle(
      surface,
      boxes.court.w,
      courtTheme(tokens, lane.model),
      number.value,
      tokens,
    );
    const view = timeline.viewAt(phase.courtTimeMs, style.trail.spans);
    const config = LANES.find((c) => c.id === lane.model);
    const gap = s.laneMode === 'row' ? 5 : 4;

    if (s.laneMode === 'row') {
      drawName(
        ctx,
        tokens,
        boxes.name.x,
        boxes.row.y + boxes.row.h / 2,
        boxes.name.w,
        lane.label,
        config?.gateway ?? null,
        s.nameSize,
        s.providerSize,
        gap,
      );
      drawNumber(
        ctx,
        tokens,
        boxes.number.x + boxes.number.w,
        boxes.row.y + boxes.row.h / 2,
        lane.model,
        number.value,
        number.inFlight,
        phase.endCardAlpha > 0 ? 0 : number.pulse,
        phase.endCardAlpha > 0 ? 0 : number.flash,
        countsLine(view.decisions, view.returns),
        s.numberSize,
        s.unitSize,
        s.countsSize,
        6,
      );
    } else {
      // Stacked: the name sits bottom-left of the row, the number bottom-right.
      const bottom = boxes.name.y + boxes.name.h;
      drawName(
        ctx,
        tokens,
        boxes.name.x,
        bottom - (s.nameSize * 1.1 + gap + s.providerSize * 1.2) / 2,
        boxes.name.w,
        lane.label,
        config?.gateway ?? null,
        s.nameSize,
        s.providerSize,
        gap,
      );
      drawNumber(
        ctx,
        tokens,
        boxes.court.x + boxes.court.w,
        bottom - (s.numberSize + gap + s.countsSize * 1.2) / 2,
        lane.model,
        number.value,
        number.inFlight,
        phase.endCardAlpha > 0 ? 0 : number.pulse,
        phase.endCardAlpha > 0 ? 0 : number.flash,
        countsLine(view.decisions, view.returns),
        s.numberSize,
        s.unitSize,
        s.countsSize,
        gap,
      );
    }

    drawCourt(ctx, view, boxes.court, style);
  }

  drawStrip(ctx, tokens, l, opts.logo);

  // --- end card ------------------------------------------------------------
  if (end && phase.endCardAlpha > 0) {
    const rows = endCardRows(replay, timelines, from, end.playMs);
    const m = tokens.motion;
    const playSeconds = Math.max(1, Math.round((end.playMs - from) / 1000));
    const progress = (i: number): number => {
      if (phase.barsSinceMs < 0) return 0;
      return easeOutCubic(clamp01((phase.barsSinceMs - i * m.barStaggerMs) / m.barGrowMs));
    };

    ctx.save();
    ctx.globalAlpha = phase.endCardAlpha;
    drawEndCard(
      ctx,
      tokens,
      layout,
      rows,
      playSeconds,
      end.playMs - from,
      progress,
      opts.url ?? tokens.copy.url,
      opts.logo,
    );
    ctx.restore();
  }
}
