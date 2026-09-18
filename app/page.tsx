import { Home } from '@/components/lane/home';
import { ogRows } from '@/lib/render/og';
import { resultRows } from '@/lib/ui/stats';

/**
 * `/` is the demo. It replays a recorded run from public/replay.json, so it
 * costs nothing and looks the same on every machine.
 *
 *   ?clean=1  hide everything except the lanes (for screen recording)
 *
 * Live games live elsewhere: /play, /watch/<id>, and the gated /arena.
 *
 * The results strip is assembled here rather than inside the client component
 * for one reason: its "decisions in the first 12 seconds" column is counted off
 * public/replay.json by the clip's own counter (lib/render/og.ts), and that
 * recording is 57 KB. Counting it on the server keeps it out of the browser
 * bundle, and makes the strip, the clip's end card and the social card quote
 * one set of figures.
 */
const ROWS = resultRows(Object.fromEntries(ogRows().map((row) => [row.model, row.decisions])));

export default async function Page({ searchParams }: PageProps<'/'>) {
  const params = await searchParams;
  const value = params.clean;
  const first = Array.isArray(value) ? value[0] : value;

  return <Home clean={first === '1' || first === 'true' || first === ''} rows={ROWS} />;
}
