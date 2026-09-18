/**
 * lib/render/assets.ts — the only part of the renderer that touches the disk.
 *
 * Node-only. Keep it out of anything the browser bundles: tokens.ts, court.ts,
 * path.ts, timeline.ts, frame.ts and text.ts are all pure so the React court
 * can import them, and this module is deliberately not in that set.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GlobalFonts, loadImage, type Image } from '@napi-rs/canvas';
import { logoPath, type ClipTokens } from './tokens';

export interface FontReport {
  /** Families that got at least one real font file. */
  registered: string[];
  /** Families whose candidate files were all missing. */
  missing: string[];
  /** Human-readable lines for the CLI to print. */
  notes: string[];
}

/**
 * Register whatever font files `tokens.fonts.sources` points at.
 *
 * The clip sets type in Geist and Geist Mono, the same faces the site loads
 * through next/font. The `geist` npm package ships static TTFs for every
 * weight, which @napi-rs/canvas registers directly, so nothing is vendored —
 * `public/fonts/` is only the second candidate in each entry.
 *
 * Nothing here is fatal. A family with no file on disk simply falls through to
 * the next entry in the family stack, which ends in a system font — so the
 * clip always renders, and the caller prints what it actually got.
 */
export function registerClipFonts(
  tokens: ClipTokens,
  root: string = process.cwd(),
): FontReport {
  const registered = new Set<string>();
  const attempted = new Set<string>();
  const notes: string[] = [];

  for (const source of tokens.fonts.sources) {
    attempted.add(source.family);
    const found = source.paths.map((p) => resolve(root, p)).find((p) => existsSync(p));
    if (!found) continue;
    try {
      GlobalFonts.registerFromPath(found, source.family);
      registered.add(source.family);
    } catch (err) {
      notes.push(`could not register ${found}: ${(err as Error).message}`);
    }
  }

  const missing = [...attempted].filter((f) => !registered.has(f));
  for (const family of missing) {
    notes.push(`font "${family}" has no file on disk — falling back to a system font`);
  }

  return { registered: [...registered], missing, notes };
}

/**
 * Decode the Ably horizontal logo for the credit strip.
 *
 * @napi-rs/canvas rasterises SVG through resvg, so the brand file is used
 * as-is. Returns null when the file is missing or will not decode; the frame
 * renderer then draws the wordmark as text.
 */
export async function loadAblyLogo(
  tokens: ClipTokens,
  root: string = process.cwd(),
): Promise<Image | null> {
  const path = resolve(root, logoPath(tokens));
  if (!existsSync(path)) return null;
  try {
    return await loadImage(path);
  } catch {
    return null;
  }
}
