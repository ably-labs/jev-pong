'use client';

/**
 * The channel line: the one place a page says out loud that everybody here —
 * the player, the agent, every spectator — is a member of the same Ably
 * channel.
 *
 * It is one line, closed by default. The game is the thing on these pages; the
 * plumbing is worth a sentence and a disclosure triangle, not a panel. Open it
 * and the join feed is underneath, which is the Ably part made visible for
 * anyone who goes looking.
 */

import type { FeedLine } from '@/lib/ably/feed';
import { LiveDot } from './chrome';

/** Motion note 06: dots are capped at six, and the rest becomes a count. */
export const DOT_CAP = 6;

export function MemberDots({ count, size = 8 }: { count: number; size?: number }) {
  const shown = Math.min(count, DOT_CAP);
  const extra = count - shown;
  return (
    <span className="flex items-center gap-[5px]">
      {Array.from({ length: shown }, (_, i) => (
        <LiveDot key={i} size={size} />
      ))}
      {extra > 0 && <span className="text-fg-muted mono pl-1 text-[12px]">+{extra}</span>}
    </span>
  );
}

export function FeedList({ lines, compact = false }: { lines: FeedLine[]; compact?: boolean }) {
  if (lines.length === 0) {
    return (
      <p className={`mono text-fg-muted ${compact ? 'text-[12px]' : 'text-[13px]'}`}>
        listening on the channel…
      </p>
    );
  }
  return (
    <ul className={`mono flex flex-col ${compact ? 'gap-[5px] text-[12px]' : 'gap-1.5 text-[13px]'}`}>
      {lines.map((line) => (
        <li
          key={line.id}
          className={`feed-in flex gap-[10px] lg:gap-3 ${
            line.fresh ? 'text-fg font-semibold' : 'text-fg-muted'
          }`}
        >
          <span className="text-fg-muted font-normal">{line.time}</span>
          <span className="truncate">{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

export interface ChannelCardProps {
  /** "game:4c2f" */
  label: string;
  lines: FeedLine[];
  /** "Jev and Matt on the channel · 1 watching" */
  summary: string;
}

export function ChannelCard({ label, lines, summary }: ChannelCardProps) {
  return (
    <details className="channel-line border-hair bg-surface rounded-card border px-3.5 py-2.5">
      <summary className="flex cursor-pointer items-center gap-2.5 text-[12px] lg:text-[13px]">
        <LiveDot />
        <span className="mono shrink-0">{label}</span>
        <span className="text-fg-muted min-w-0 flex-1 truncate">· {summary}</span>
        <Chevron />
      </summary>
      <div className="pt-2.5">
        <FeedList lines={lines} compact />
      </div>
    </details>
  );
}

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden
      className="channel-chevron text-fg-muted block shrink-0"
    >
      <path
        d="M3 4.5 L6 8 L9 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default ChannelCard;
