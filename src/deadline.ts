// Deadlines written in free text ("before September 25", "antes del 3 de noviembre").
// Items have no due column; the date lives in the title the model wrote, so we read it back.

const DAY = 86_400_000;

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, ene: 0, enero: 0,
  feb: 1, february: 1, febrero: 1,
  mar: 2, march: 2, marzo: 2,
  apr: 3, april: 3, abr: 3, abril: 3,
  may: 4, mayo: 4,
  jun: 5, june: 5, junio: 5,
  jul: 6, july: 6, julio: 6,
  aug: 7, august: 7, ago: 7, agosto: 7,
  sep: 8, sept: 8, september: 8, septiembre: 8, setiembre: 8,
  oct: 9, october: 9, octubre: 9,
  nov: 10, november: 10, noviembre: 10,
  dec: 11, december: 11, dic: 11, diciembre: 11,
};
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const YEAR = String.raw`(?:,?\s+(?:de\s+|del\s+)?(\d{4}))?`;

// "September 25", "Sept 25th, 2026"
const MONTH_DAY = new RegExp(String.raw`\b(${MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b${YEAR}`, "i");
// "25 September", "25 de septiembre de 2026"
const DAY_MONTH = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:de\s+|of\s+)?(${MONTH})\b\.?${YEAR}`, "i");
// "25/09" or "25-09-2026" only after a deadline word: bare numbers are too often something else.
const NUMERIC = /\b(?:before|by|until|due|deadline|antes(?:\s+del?)?|hasta(?:\s+el)?|para\s+el|plazo|vence)\s+(?:el\s+|the\s+)?(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/i;

/** End of the day the text names as a date, or null. Without a year, the first such day from about when it was written. */
export function parseDue(text: string | null | undefined, writtenAt: number): number | null {
  if (!text) return null;
  let day: number, month: number, year: number | undefined;
  let m = MONTH_DAY.exec(text);
  if (m) {
    month = MONTHS[m[1].toLowerCase()];
    day = Number(m[2]);
    year = m[3] ? Number(m[3]) : undefined;
  } else if ((m = DAY_MONTH.exec(text))) {
    day = Number(m[1]);
    month = MONTHS[m[2].toLowerCase()];
    year = m[3] ? Number(m[3]) : undefined;
  } else if ((m = NUMERIC.exec(text))) {
    day = Number(m[1]);
    month = Number(m[2]) - 1;
    year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined;
  } else {
    return null;
  }
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const end = (y: number) => new Date(y, month, day, 23, 59, 59, 999).getTime();
  if (year) return end(year);
  const y = new Date(writtenAt).getFullYear();
  // "before March 3" written in November means next March; a month of slack covers late notes about recent dates.
  return end(y) < writtenAt - 30 * DAY ? end(y + 1) : end(y);
}

export function isExpired(due: number | null, now = Date.now()): boolean {
  return due != null && due < now;
}

/** "25/09" — short, and unambiguous for a Spanish reader. */
export function dueLabel(due: number): string {
  const d = new Date(due);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}
