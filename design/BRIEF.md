# Jev Pong — design brief

Output of this brief lives in `design/` and `public/brand/` only. Do not edit `app/`, `components/`, `lib/` or `scripts/`; other agents are building there in parallel. Hand back files, not code changes.

## What this is

Jev Pong is Pong where the ball moves one step per model decision. Four lanes, one per model (Jev, Claude Haiku 4.5, GPT-5.6 Sol, Gemini 3.8 Flash), same serve, same rules. Slow model, slow ball. Jev's ball flies across in a few hundred milliseconds per step; the others crawl.

Measured today from London through Vercel AI Gateway: Jev ~430 ms per decision, Gemini ~1.4 s, Haiku ~1.7 s, GPT ~3.8 s. Use these numbers in mocks. Never vendor claims.

The clip is the product. The site is where the clip lives and where people play. The social post is the clip plus a link. It must read in three seconds on a phone without sound.

## Surfaces to design

1. **Clip frame, 1200×675** (X, LinkedIn) and **1080×1080** (square). Show the moment two seconds after the simultaneous serve: Jev's ball has crossed and been returned, Gemini and Haiku are mid-court, GPT has barely moved. Design the **opening frame** (four balls leaving centre together), the **mid frame**, and the **end card** (2.5 s freeze: "Returns in 12 seconds — Jev 18 · Gemini 7 · Haiku 6 · GPT 3", plus the URL). The end card doubles as the static image and the OG image (1200×630).
2. **Home page `/`**, desktop and phone. Title, one line ("Pong where the ball moves one step per model decision. Slow model, slow ball."), the four lanes replaying the recorded run, a "Live now" strip of games with viewer counts, two calls to action (Play against Jev, source), credits last.
3. **Play page `/play`**: one lane, you on the left, Jev on the right; a small line that shows Jev joining the channel ("Jev joined") and the live viewer count; a watch link to copy. The viewer count and the join line are the Ably moment: design them so a viewer understands other people are on this channel.
4. **Watch page `/watch/[id]`**: the same lane as a spectator, viewer count, status (connecting, live, ended with the reason).

## The lane (the unit of the design)

Left: model name, small provider tag. Centre: the court, wide. Right: the big number, the last decision in milliseconds, monospace, the largest thing in the row; under it a small returns counter. A status badge appears only when needed (serving, point, game over, out of credits). Jev accent is currently `#FF5416`; the others are muted. Propose better if you have better, but keep one loud lane.

The court is drawn on a `<canvas>` by one pure function that takes a snapshot (ball x/y, two paddle y's, score). Paddles are bars, the ball is a dot, a faint centre line. You can specify a motion trail on the ball whose length follows speed, and a pulse on the latency number at each decision. Ball motion in the clip is continuous at exactly one segment per latency; on the site the ball tweens to each new snapshot over `min(latency, 1200 ms)`.

## Principles

- The stacked courts are the signature. Racing-graph vernacular ("this is how fast X is" videos). Quiet chrome around them.
- Big numbers. The ms figure is the hero of each row.
- Not a generic dark-plus-neon AI landing page. Not a retro Atari pastiche either. Modern, calm, precise.
- Lead with the paddles. Logos last, small.
- **Powered by Ably is required on every surface**: a "Powered by Ably" lockup with the Ably logo in the site footer, in the clip's bottom strip, and on the end card. Subtle in size, never absent. Follow Ably's clear-space and colour rules (logo files will be in `public/brand/`). Vercel AI Gateway, AI SDK `evaluate`, and Jev by TypeSafe AI are credited as text beside it.
- Phone width first: lanes stack full width and stay legible; no horizontal scroll.
- Anti-hype copy. Jev is a typed-decision model, not an LLM. Never "can't hallucinate".

## Constraints

- Next.js 16, Tailwind 4, React 19. Fonts available through `next/font`: Geist Sans and Geist Mono (already in the scaffold). Another Google font is fine if it earns its place.
- Light and dark tokens both required for the site (system preference). The clip picks one and says which.
- No component libraries. Canvas for the court, Tailwind for the rest.
- Ably brand rules apply wherever Ably's mark appears (use the `ably-skills:brand` skill for logo files and clear-space rules). This is an ably-labs demo, not an Ably product page.

## Deliverables (files)

- `design/tokens.json` — colours (light/dark), type scale, spacing, lane accents, court colours.
- `design/hero.html` — static mock of `/`, desktop and phone, using the tokens. Self-contained.
- `design/clip-frame.html` — the 1200×675 mid frame, the opening frame, and the end card, as separate sections. Also the 1080×1080 variant of the mid frame.
- `design/play.html` and `design/watch.html` — static mocks, can be rough.
- `design/MOTION.md` — trail, pulse, easing, durations, end-card timing, in words and numbers.
- `public/brand/` — monochrome SVGs: Ably, Vercel, TypeSafe AI (if a mark exists; else wordmark text).
- `design/NOTES.md` — the rationale in ten lines and anything the implementer must not get wrong.

## References

- Vercel's Jev changelog for the visual language of the ecosystem: https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway
- Racing-graph animations ("how fast is X" bar-race videos) for the read-in-three-seconds rhythm.
- The current implementation, for reference only: `components/lane/*.tsx` (do not edit).
