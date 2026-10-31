// Calendar days, not 24-hour steps: the day the clocks change has 23 or 25 hours, and
// "today + 2 × 24 h" lands on the wrong date.

/** Local midnight of the day `n` days after the one containing `day`. */
export function addDays(day: number, n: number): number {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
