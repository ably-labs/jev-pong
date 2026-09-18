# Brand assets

Ably logo files from the Ably brand kit (`ably-skills:brand`). Rules that apply here:

- Use `ably-logo-horizontal-*.svg` first (symbol + wordmark). `ably-symbol.svg` only where space is tiny (favicon, badge).
- Pick the variant by background: `-light-bg` (black wordmark) on light, `-dark-bg` (white wordmark) on dark. The symbol keeps its orange gradient in both.
- Clearspace: the height of the lowercase "l" in the wordmark, on all sides. Nothing inside that zone.
- Never recolour the symbol, never separate wordmark from symbol, never stretch.
- "Powered by Ably" lockup: the words "Powered by" in the UI font, then the horizontal logo at the same cap height, on every surface (site footer, clip bottom strip, end card).
- Ably Orange is `#FF5416`; use it sparingly. The Jev lane accent is the same orange on purpose.

Where each one is used here: the site footer carries both and swaps them on `prefers-color-scheme` (black wordmark on the light page, white on the dark one); the clip, the square cut, the end card and the OG image are always dark, so they use `-dark-bg` only. Every surface draws the logo at 22px tall with 16px of clearspace, which is the lowercase-"l" height at that size.

Vercel and TypeSafe AI are credited as text ("Vercel AI Gateway · AI SDK evaluate · Jev by TypeSafe AI"); add their marks here only if their brand guidelines allow it.
