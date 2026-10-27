const DAY_MS = 86_400_000;
/** Years 0000 to 9999, which `toISOString` writes with four digits. */
const FIRST = -62_167_219_200_000;
const LAST = 253_402_300_799_999;

/**
 * `new Date(text).toISOString()`, with less CPU: a Date parses quickly but writes the ISO text
 * slowly, so this writes it by hand. Throws the same RangeError for an invalid time.
 */
export function isoInstant(text: string): string {
  return isoFromTime(Date.parse(text));
}

/** `new Date(time).toISOString()` for a time value in milliseconds. */
export function isoFromTime(time: number): string {
  if (!(time >= FIRST && time <= LAST) || !Number.isInteger(time)) {
    return new Date(time).toISOString();
  }
  const days = Math.floor(time / DAY_MS);
  const ofDay = time - days * DAY_MS;
  // Civil date from days since 1970-01-01, after Howard Hinnant's `civil_from_days`.
  const shifted = days + 719_468;
  const era = Math.floor(shifted / 146_097);
  const dayOfEra = shifted - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthIndex = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthIndex + 2) / 5) + 1;
  const month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  const hours = Math.floor(ofDay / 3_600_000);
  const minutes = Math.floor(ofDay / 60_000) % 60;
  const seconds = Math.floor(ofDay / 1000) % 60;
  const millis = ofDay % 1000;
  return (
    `${TWO_DIGITS[Math.floor(year / 100)]}${TWO_DIGITS[year % 100]}-${TWO_DIGITS[month]}-` +
    `${TWO_DIGITS[day]}T${TWO_DIGITS[hours]}:${TWO_DIGITS[minutes]}:${TWO_DIGITS[seconds]}.` +
    `${THREE_DIGITS[millis]}Z`
  );
}

const TWO_DIGITS = Array.from({ length: 100 }, (_, value) => String(value).padStart(2, "0"));
const THREE_DIGITS = Array.from({ length: 1000 }, (_, value) => String(value).padStart(3, "0"));
