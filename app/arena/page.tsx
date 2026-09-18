import { headers } from 'next/headers';
import { Arena } from '@/components/lane/arena';
import { ADMIN_TOKEN_HEADER, ADMIN_TOKEN_PARAM, isAdminRequest } from '@/lib/config/admin';

/**
 * `/arena` — the live comparison. Four demo games at once, one per model,
 * started server-side and watched over Ably.
 *
 * Gated, because each press of "Start arena" starts four workers that call four
 * models for up to thirteen minutes. On a laptop it is open; in production it
 * needs `ADMIN_TOKEN`, as the `x-admin-token` header or `?token=`.
 *
 *   ?clean=1  hide everything except the lanes (for screen recording)
 *   ?token=…  the admin token, which the page then remembers
 *
 * `/` stays the recorded replay for everyone else. Same renderer, no credits.
 */
export const dynamic = 'force-dynamic';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function flag(value: string | string[] | undefined): boolean {
  const single = first(value);
  return single === '1' || single === 'true' || single === '';
}

export default async function Page({ searchParams }: PageProps<'/arena'>) {
  const params = await searchParams;
  const token = first(params[ADMIN_TOKEN_PARAM]);

  // A page never sees the Request, so build the part of one the gate reads.
  // Same function as the route handler uses, so the two cannot drift apart.
  const incoming = await headers();
  const forwarded = new Headers();
  const header = incoming.get(ADMIN_TOKEN_HEADER);
  if (header !== null) forwarded.set(ADMIN_TOKEN_HEADER, header);

  const url = new URL('https://jev-pong.invalid/arena');
  if (token !== undefined) url.searchParams.set(ADMIN_TOKEN_PARAM, token);

  const allowed = isAdminRequest(new Request(url, { headers: forwarded }));

  return <Arena allowed={allowed} clean={flag(params.clean)} token={allowed ? (token ?? null) : null} />;
}
