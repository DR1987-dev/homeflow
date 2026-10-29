import { describe, expect, it } from "vitest";
import { dateKey, localDate, sunset } from "../src/astro/sun.js";

const minutesApart = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

describe("sunset", () => {
  it("matches known sunsets in Berlin within two minutes", () => {
    const summer = sunset({ year: 2024, month: 6, day: 21 }, 52.52, 13.405);
    const winter = sunset({ year: 2024, month: 12, day: 21 }, 52.52, 13.405);
    expect(minutesApart(summer!, new Date("2024-06-21T19:33:00Z"))).toBeLessThan(2);
    expect(minutesApart(winter!, new Date("2024-12-21T14:53:00Z"))).toBeLessThan(2);
  });

  it("returns undefined during polar day", () => {
    expect(sunset({ year: 2024, month: 6, day: 21 }, 78.2, 15.6)).toBeUndefined();
  });
});

describe("localDate", () => {
  it("uses the calendar day of the given time zone", () => {
    const instant = new Date("2026-06-20T22:30:00Z");
    expect(dateKey(localDate(instant, "Europe/Berlin"))).toBe("2026-06-21");
    expect(dateKey(localDate(instant, "UTC"))).toBe("2026-06-20");
  });
});
