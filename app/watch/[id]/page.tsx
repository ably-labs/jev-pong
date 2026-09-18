import type { Metadata } from 'next';
import { Watch } from '@/components/lane/watch';

export const metadata: Metadata = {
  title: 'Watching · Jev Pong',
  description:
    'Pong where the ball moves one step per model decision. Slow model, slow ball.',
};

export default async function Page({ params }: PageProps<'/watch/[id]'>) {
  const { id } = await params;
  return <Watch gameId={id} />;
}
