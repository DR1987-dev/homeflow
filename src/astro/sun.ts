const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** Calendar date of an instant in the given IANA time zone. */
export function localDate(instant: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

export function dateKey({ year, month, day }: CalendarDate): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Sunset (upper limb, standard refraction) using the NOAA solar equations; accurate to about a minute.
 * Returns undefined when the sun does not set on that day (polar day/night).
 */
export function sunset(date: CalendarDate, latitude: number, longitude: number): Date | undefined {
  const midnightUtc = Date.UTC(date.year, date.month - 1, date.day);
  const julianDay = midnightUtc / 86_400_000 + 2440587.5 + 0.5;
  const t = (julianDay - 2451545) / 36525;

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = rad(meanAnomaly);
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const apparentLong = meanLong + center - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * t));
  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(rad(125.04 - 1934.136 * t));
  const declination = Math.asin(Math.sin(rad(obliquity)) * Math.sin(rad(apparentLong)));

  const y = Math.tan(rad(obliquity) / 2) ** 2;
  const l0 = rad(meanLong);
  const equationOfTime =
    4 *
    deg(
      y * Math.sin(2 * l0) -
        2 * eccentricity * Math.sin(m) +
        4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
        0.5 * y * y * Math.sin(4 * l0) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * m),
    );

  const lat = rad(latitude);
  const cosHourAngle =
    Math.cos(rad(90.833)) / (Math.cos(lat) * Math.cos(declination)) -
    Math.tan(lat) * Math.tan(declination);
  if (cosHourAngle < -1 || cosHourAngle > 1) {
    return undefined;
  }

  const solarNoonMinutes = 720 - 4 * longitude - equationOfTime;
  const sunsetMinutes = solarNoonMinutes + 4 * deg(Math.acos(cosHourAngle));
  return new Date(midnightUtc + sunsetMinutes * 60_000);
}
