export function Wordmark({ name, compact }: { name: string; compact?: boolean }) {
  return (
    <span className="flex items-center gap-2" aria-label={name}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
        <rect x="1" y="1" width="20" height="20" rx="3" fill="none" stroke="#d4f55c" strokeWidth="1.5" />
        <line x1="11" y1="1" x2="11" y2="21" stroke="#d4f55c" strokeWidth="1.5" />
        <circle cx="11" cy="11" r="3.6" fill="none" stroke="#d4f55c" strokeWidth="1.5" />
      </svg>
      <span className={compact ? "scoreboard text-[22px] tracking-wide text-chalk" : "scoreboard text-[26px] tracking-wide text-chalk"}>{name}</span>
    </span>
  );
}
