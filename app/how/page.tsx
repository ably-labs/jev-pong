import type { Metadata } from 'next';
import { How } from '@/components/lane/how';
import { TAGLINE } from '@/lib/config/site';

/**
 * `/how` — the mechanic, the measurement and the channel, for anyone who wants
 * to check the claim. It opens no Ably connection and runs no game; the sample
 * state on it is built by the engine at render time.
 */
export const metadata: Metadata = {
  title: 'How it works · Jev Pong',
  description: TAGLINE,
};

export default function Page() {
  return <How />;
}
