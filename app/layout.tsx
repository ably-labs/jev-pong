import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { TAGLINE } from '@/lib/config/site';
import { CLIP_TOKENS } from '@/lib/render/tokens';
import { headlineSentences } from '@/lib/ui/stats';
import './globals.css';

/**
 * Type: Geist and Geist Mono, and nothing else. Both come through next/font
 * (the `geist` package wraps next/font/local), so they are self-hosted, have
 * no layout shift and need no network at build time. The same TTFs are what
 * the headless clip renderer registers, so the clip and the site set type
 * identically.
 */

/**
 * Where this is served from. Without it the social card resolves against
 * localhost and the link posts without an image, which on the two places this
 * is aimed at — Hacker News and X — is most of the point. One env var
 * overrides it for a preview deployment.
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? `https://${CLIP_TOKENS.copy.url}`;

/** The card's words are the page's words: the same headline, from the same run. */
const HEADLINE = headlineSentences();
const DESCRIPTION = `${HEADLINE.jev} ${HEADLINE.jevMs}. ${HEADLINE.chat} ${TAGLINE}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Jev Pong',
  description: DESCRIPTION,
  applicationName: 'Jev Pong',
  openGraph: { title: 'Jev Pong', description: DESCRIPTION, type: 'website' },
  twitter: { card: 'summary_large_image', title: 'Jev Pong', description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F5F6F8' },
    { media: '(prefers-color-scheme: dark)', color: '#0A0B0F' },
  ],
  colorScheme: 'light dark',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
    >
      <body className="bg-bg text-fg flex min-h-full flex-col">
        {children}
        {/* Vercel Web Analytics: page views and the four events in lib/ui/analytics.ts. */}
        <Analytics />
      </body>
    </html>
  );
}
