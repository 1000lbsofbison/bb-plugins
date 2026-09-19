// Relative ages, as they appear on the right edge of every row.
//
// Single-letter units, no "ago": the column is barely three characters wide, and
// a row that says "2 hours ago" pushes the title out of the card. The units are
// English — `d` is days, not the German `T` this module used to print.
export function relativeAge(from: number, now: number): string {
  // A clock that has run backwards (a thread updated on another host, a clock
  // correction) must not produce a negative age.
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}
