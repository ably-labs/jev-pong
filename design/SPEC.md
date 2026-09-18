# Jev Pong — implementation spec (from the Design artifact)

> **Launch scope note (2026-09-17 evening):** the "Live now" lobby strip and any viewer count that can read zero are NOT shipped at launch (team feedback: presence-driven UI is a liability at low traffic). Share-to-watch stays. A "What counts as one decision" block sits under the lanes on the home page. The artboards and the rules below otherwise stand.

Source of truth: https://claude.ai/artifact/MySfdUXbuCvPGnDjWm13Un (boards copied to `design/artboards/`, tokens in `design/tokens.css`). Everything below is lifted from the Tokens and Motion boards; the artboard HTML is the layout reference.

## Type scale (Geist / Geist Mono)
- display: Geist 64/1.05 700 −0.03em (h1 desktop); 40 on phone
- headline: Geist 60/1.05 700 −0.03em (end card only)
- title: Geist 24 700 −0.02em (clip/square header; 22 mid frame; 16/15 site header)
- lane name: Geist 20/1.1 600 (clip); 22 square; 18 desktop; 16 phone; 15 watch
- body-l: Geist 22/1.4 400 --fg-muted (tagline); 17/1.45 phone
- label: Geist 14 600 (section labels, watcher count)
- caption: Geist 13/1.4 400 --fg-muted (small lines, credits); 12 phone
- tag: Geist 12 400 +0.04em caps --fg-muted (provider tags; 11.5 desktop, 11 phone); never below --fg-muted
- latency: Geist Mono 56 500 −0.02em tabular (clip); 52 square; 48 desktop and play; 34 phone. Unit 18/16/13 --fg-muted
- latency in flight: same size, weight 400, --fg-inflight on number and unit
- timer: Geist Mono 18–20 500 (elapsed on clip); 14/13 site
- mono small: Geist Mono 13 (ids, feed lines, link); score 16 in court, 20 on live cards

## Spacing and shape
- Base 4. Scale 4·6·8·10·12·14·16·20·24·28·32·36·40·48·64·80.
- Gutters: 80 desktop, 16 phone, 48 clip, 44 square, 64 end card.
- Lane gap: 10 clip and desktop, 14 phone, 16 square.
- Lane columns: 196 | 1fr | 220 on the clip; 176 | 1fr | 200 on the site. Phone and square stack the name row over a full-width court.
- Radii: court 6 (8 on play), card 10, button/input 8, bar 4, badge 4.
- Controls: buttons 48 high (40 inline), hit targets >= 44, hairlines 1px.
- Ably clearspace: lowercase-l height on all sides; 16px at a 22px logo.

## Court sizes (surface: court, ball r, paddle, Jev trail at 430ms)
- Clip 1200×675: 640×100, r7, 5×40, 260px / 7 discs
- Square 1080×1080: 992×130, r8, 6×52, 320px / 7 discs
- Home desktop: 704×80, r4.5, 4×28, 145px / 5 discs
- Home phone: 358×64, r4, 3×24, 110px / 5 discs
- Play desktop: 704×300, r7, 6×56, 100px / 5 discs
- Watch phone: 358×200, r5, 4×36, 55px / 5 discs
- Centre line 1px dashed 3/7 (3/6 phone) in --court-line, inset 10px. Paddles inset 12–16px. Court is one pure function of the snapshot plus a theme; trail and pulse are layered by the renderer.

## Lane accents
- Jev: --jev on ball, trail, latency number, end-card bar. Nothing else orange; name stays --fg.
- Others: no accent. Ball and trail --ball, number --fg, bar --bar-muted.
- Paddles: --paddle in every lane including Jev's.
- In flight: number switches to --fg-inflight weight 400 while counting; back on landing.
- Never: provider brand colours or logos inside a lane; orange on buttons, links, or the live dot.
- Lane order: Jev, Gemini, Haiku, GPT (measured latency, fixed at record time, never re-sorted).

## Motion (ms)
01 Ball in the clip: at t=0 the scripted serve tweens the ball one step out of centre over 300 ease-out, all lanes at once. Every later step is a LINEAR tween whose duration is exactly that decision's recorded latency, arriving as the decision lands. No easing inside a step.
02 Ball on the site: replay behaves as 01. Live: tween to the new position over min(latency, 1200) linear; paddles ease-out 120; score never interpolates.
03 Trail: trail_px = clamp(260 × 430 / latency, 24, 260) on the clip court, scaled by court width elsewhere. Seven discs (five on site): radius r → 0.35r, opacity 0.5 → 0.07, spacing +12% per disc, ball colour. No blur/glow. Samples the real path (bends at bounces).
04 Latency number: shows max(lastLatency, elapsedInFlight). First decision counts up from 0 in the in-flight style. On landing: snap, weight 500, lane colour, pulse scale 1→1.06→1 over 180 (60 out, 120 in), colour flashes to pure white/black for 120. Unit does not pulse. Update per frame.
05 Counters/badges: decisions · returns line increments with a 120 opacity dip. Badges fade 150 in/out, never slide, never push layout.
06 Presence: live dot breathes opacity 1→0.4→1 over 2000 ease-in-out. Feed line fades in 200, bold 3000, then muted. Watcher count/dots cross-fade 150; dots capped at six plus a count.
07 End card: at 12.0s freeze courts 400, cross-fade 300 to end card, bars grow 0→length over 600 ease-out staggered 80, numbers count up in sync, hold 2500. Clip = 15.2s. Loop = hard cut. Static/OG = held frame.
08 Opening/reduced motion: no intro. prefers-reduced-motion: no trail/pulse/breathing, ball jumps per snapshot, numbers still count.

## Must not get wrong
a Ball speed is data; ease nothing inside a step. b Lanes never re-sort. c Orange is Jev's ball/trail/number/bar only. d The number is the largest thing in the row at every width; drop the name to a second line before shrinking the number. e Tabular figures on every mono number. f Powered by Ably on every surface with clearspace; real SVG at the same height. g No horizontal scroll at 390; live games are a list on phone, cards on desktop. h Anti-hype copy; the measurement line is one string in one place.

## Copy
- Tagline: "Pong where the ball moves one step per model decision. Slow model, slow ball."
- Clip header: "Jev Pong" + "One step per model decision" + elapsed timer.
- End card: "Decisions in 12 seconds" + "Same serve, same rules. The ball moves one step per model decision." + "Play against Jev at [URL]".
- Credits: "Powered by" + Ably logo · "Vercel AI Gateway · AI SDK evaluate · Jev by TypeSafe AI"; clip adds the measurement line ("Measured on Vercel (iad1) via Vercel AI Gateway" once recorded there).
- Ids: anon-XXXX from the last 4 chars of the Ably clientId; channel label "game:XXXX".
