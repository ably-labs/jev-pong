import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { ABLY_CREDIT, CLIP_SECONDS } from '@/lib/config/site';
import { ogRows } from '@/lib/render/og';
import { CLIP_TOKENS } from '@/lib/render/tokens';
import { headlineSentences, resultRows } from '@/lib/ui/stats';

/**
 * The social card is the home page above the fold, held still: the same
 * headline, then the same results strip, then the same Ably lockup. Somebody
 * who sees the card in a timeline and then opens the link should recognise it
 * as one thing rather than two.
 *
 * It renders at build time, so it must not depend on a model being up, and it
 * cannot replay anything. Every figure on it therefore comes from where the
 * page's figures come from: public/replay-stats.json through lib/ui/stats.ts,
 * and — for the "decisions in 12 seconds" column — the recording itself,
 * counted by `ogRows()`, which is the clip's own end-card counter. Nothing here
 * is a copied number.
 *
 * Satori (what next/og draws with) does flexbox and nothing else — no grid, no
 * external CSS, and every element with more than one child needs an explicit
 * `display: flex`. Keep it plain.
 */

export const alt = 'Jev Pong: what a decision costs in a game that will not wait';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const C = CLIP_TOKENS.colors;
const HEADLINE = headlineSentences();

const ROWS = resultRows(Object.fromEntries(ogRows().map((row) => [row.model, row.decisions])));

/** The strip's columns, as the home page sets them. */
const COLUMNS: Array<{ label: string; of: (row: (typeof ROWS)[number]) => string }> = [
  { label: 'decisions/s', of: (row) => row.decisionsPerSec.toFixed(2) },
  { label: 'avg ms', of: (row) => String(Math.round(row.avgMs)) },
  { label: 'p95 ms', of: (row) => String(Math.round(row.p95Ms)) },
  { label: `in ${CLIP_SECONDS} s`, of: (row) => String(row.inWindow) },
];

/** Fixed columns, in px. They must add up to less than 1200 minus the padding. */
const NAME_PX = 250;
const COL_PX = 186;
const GAP_PX = 12;

/** The link on the card, as on the clip's end card. */
const URL = process.env.CLIP_URL ?? CLIP_TOKENS.copy.url;

/**
 * The same Geist files the clip renderer registers, read from the `geist`
 * package. The card is generated at build time, so this runs where
 * node_modules is; if a file is ever missing the card still renders in
 * next/og's own default face.
 *
 * The directory is a literal so the bundler can scope what it traces to the
 * font folder rather than the whole project.
 */
const FONT_DIR = 'node_modules/geist/dist/fonts';

function geist(file: string): Buffer | null {
  try {
    return readFileSync(join(process.cwd(), FONT_DIR, file));
  } catch {
    return null;
  }
}

type Face = { name: string; data: Buffer; weight: 400 | 500 | 600 | 700; style: 'normal' };

/**
 * The real Ably marks, read from public/brand/ at build time the way the fonts
 * are, and handed to Satori as data URIs — `<img>` elements with no network.
 * The card's ground is always the dark one, so the wordmark is always the
 * dark-bg file. If either is missing the card falls back to text.
 */
const LOGO_H = 22;
/** The file is 204 x 64, so 22px tall is 70px wide. */
const LOGO_W = 70;
/** The lowercase-l clearspace at this size (design/SPEC.md f). */
const LOGO_CLEARSPACE = 16;

/**
 * Literals, like FONT_DIR and for the same reason: the bundler traces what it
 * can see, and a path it cannot read statically makes it trace the whole
 * project. The first is `CLIP_TOKENS.logo.darkBg`, which lib/render/og.test.ts
 * pins.
 */
const LOGO_FILE = 'public/brand/ably-logo-horizontal-dark-bg.svg';
const SYMBOL_FILE = 'public/brand/ably-symbol.svg';

function uri(svg: Buffer): string {
  return `data:image/svg+xml;base64,${svg.toString('base64')}`;
}

/**
 * Each of these joins its own literal. A shared `read(file: string)` helper
 * would make the path unresolvable to the bundler, which then traces the whole
 * project into the function bundle — the build says so out loud.
 */
function logo(): string | null {
  try {
    return uri(readFileSync(join(process.cwd(), LOGO_FILE)));
  } catch {
    return null;
  }
}

function symbolMark(): string | null {
  try {
    return uri(readFileSync(join(process.cwd(), SYMBOL_FILE)));
  } catch {
    return null;
  }
}

function faces(): Face[] {
  const wanted: Array<[string, string, Face['weight']]> = [
    ['Geist', 'geist-sans/Geist-Regular.ttf', 400],
    ['Geist', 'geist-sans/Geist-SemiBold.ttf', 600],
    ['Geist', 'geist-sans/Geist-Bold.ttf', 700],
    ['Geist Mono', 'geist-mono/GeistMono-Medium.ttf', 500],
  ];
  const out: Face[] = [];
  for (const [name, file, weight] of wanted) {
    const data = geist(file);
    if (data) out.push({ name, data, weight, style: 'normal' });
  }
  return out;
}

export default function Image() {
  const fonts = faces();
  const mark = logo();
  const symbol = symbolMark();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: C.bg,
          color: C.fg,
          padding: '40px 64px 30px',
          fontFamily: 'Geist',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em' }}>Jev Pong</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {symbol !== null && <img src={symbol} width={17} height={14} alt="" />}
            <span style={{ fontSize: 14, fontWeight: 600, color: C.fgMuted }}>Ably Labs</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 50,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
            }}
          >
            {/* Satori collapses trailing whitespace between flex children, so
                every gap here is a margin. The value is mono and the unit is
                not: Geist Mono's word space is wide enough to read as a break
                between two numbers. */}
            <span>{HEADLINE.jev}</span>
            <span
              style={{
                color: C.jev,
                fontFamily: 'Geist Mono',
                fontWeight: 500,
                marginLeft: 16,
              }}
            >
              {HEADLINE.jevMs.split(' ')[0]}
            </span>
            <span style={{ color: C.jev, marginLeft: 10 }}>{HEADLINE.jevMs.split(' ')[1]}</span>
            <span>.</span>
          </div>
          <div
            style={{
              fontSize: 50,
              fontWeight: 700,
              letterSpacing: '-0.03em',
              lineHeight: 1.1,
              color: C.fgMuted,
              marginTop: 4,
            }}
          >
            {HEADLINE.chat}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', gap: GAP_PX, marginBottom: 8 }}>
            <div style={{ display: 'flex', width: NAME_PX, flexShrink: 0 }} />
            {COLUMNS.map((column) => (
              <div
                key={column.label}
                style={{
                  display: 'flex',
                  width: COL_PX,
                  flexShrink: 0,
                  justifyContent: 'flex-end',
                  fontSize: 13,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: C.fgMuted,
                }}
              >
                {column.label}
              </div>
            ))}
          </div>

          {ROWS.map((row) => (
            <div
              key={row.model}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: GAP_PX,
                borderTop: `1px solid ${C.barMuted}`,
                paddingTop: 10,
                paddingBottom: 10,
              }}
            >
              <div
                style={{ display: 'flex', flexDirection: 'column', width: NAME_PX, flexShrink: 0 }}
              >
                <div style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.1 }}>{row.label}</div>
                <div
                  style={{
                    fontSize: 12,
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                    color: C.fgMuted,
                    marginTop: 4,
                  }}
                >
                  {row.provider}
                </div>
              </div>

              {COLUMNS.map((column) => (
                <div
                  key={column.label}
                  style={{
                    display: 'flex',
                    width: COL_PX,
                    flexShrink: 0,
                    justifyContent: 'flex-end',
                    fontFamily: 'Geist Mono',
                    fontSize: 30,
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    color: row.model === 'jev' ? C.jev : C.fg,
                  }}
                >
                  {column.of(row)}
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: C.fgMuted }}>{ABLY_CREDIT}</span>
            <span style={{ display: 'flex', padding: `0 ${LOGO_CLEARSPACE}px` }}>
              {mark === null ? (
                <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em' }}>Ably</span>
              ) : (
                <img src={mark} width={LOGO_W} height={LOGO_H} alt="Ably" />
              )}
            </span>
          </div>
          <div style={{ fontSize: 17, fontWeight: 500, fontFamily: 'Geist Mono' }}>{URL}</div>
        </div>
      </div>
    ),
    fonts.length > 0 ? { ...size, fonts } : size,
  );
}
