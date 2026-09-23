import { describe, expect, it } from "vitest";
import { verifyInitData } from "../src/worker/auth/telegram";
import { TOKEN_SCRIPT } from "../src/worker/bot/format";
import { b64encode, decryptString, encryptString, hmacSha256, toHex } from "../src/worker/crypto";
import { flattenChosen, normalizeDays, seatsFor, weekStarts } from "../src/worker/itmo/schedule";
import { parseTokenInput, TokenInputError } from "../src/worker/itmo/tokens";
import { isQuiet, matchesFilter, nextScheduleRun, parseRange, sanitizeWatcher, ValidationError } from "../src/worker/rules";
import { addDays, inWindow, isoWeekday, mskMonday, mskToUnix, mskToday } from "../src/worker/time";
import { DEFAULT_SETTINGS, type Lesson } from "../src/shared/types";

const key = b64encode(crypto.getRandomValues(new Uint8Array(32)));

function jwt(claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(claims)}.${"s".repeat(20)}`;
}
const ISS = "https://id.itmo.ru/auth/realms/itmo";

describe("crypto", () => {
  it("round-trips and binds to AAD", async () => {
    const blob = await encryptString(key, "secret-token", "tg:1:access");
    expect(await decryptString(key, blob, "tg:1:access")).toBe("secret-token");
    await expect(decryptString(key, blob, "tg:2:access")).rejects.toThrow();
    await expect(decryptString(key, blob, "tg:1:refresh")).rejects.toThrow();
  });
  it("uses a fresh IV each time", async () => {
    expect(await encryptString(key, "x", "a")).not.toBe(await encryptString(key, "x", "a"));
  });
});

describe("telegram initData", () => {
  const botToken = "123456:TEST";
  async function sign(fields: Record<string, string>) {
    const dcs = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join("\n");
    const secret = await hmacSha256("WebAppData", botToken);
    const hash = toHex(await hmacSha256(secret, dcs));
    return new URLSearchParams({ ...fields, hash }).toString();
  }
  const now = 1_800_000_000;
  const user = JSON.stringify({ id: 42, first_name: "Иван" });

  it("accepts a valid signature", async () => {
    const init = await sign({ auth_date: String(now - 10), query_id: "AAA", user });
    expect((await verifyInitData(init, botToken, now))?.id).toBe(42);
  });
  it("rejects tampering, wrong bot and stale data", async () => {
    const init = await sign({ auth_date: String(now - 10), user });
    expect(await verifyInitData(init.replace("42", "43"), botToken, now)).toBeNull();
    expect(await verifyInitData(init, "999:OTHER", now)).toBeNull();
    const old = await sign({ auth_date: String(now - 3 * 86400), user });
    expect(await verifyInitData(old, botToken, now)).toBeNull();
    expect(await verifyInitData("user=x", botToken, now)).toBeNull();
  });
});

describe("token input", () => {
  const now = 1_800_000_000;
  const access = jwt({ iss: ISS, typ: "Bearer", exp: now + 1800 });
  const refresh = jwt({ iss: ISS, typ: "Refresh", exp: now + 36000 });

  it("parses our script JSON", () => {
    const p = parseTokenInput(JSON.stringify({ access: "Bearer%20" + access, refresh }), now);
    expect(p.access).toBe(access);
    expect(p.refresh).toBe(refresh);
    expect(p.refreshExp).toBe(now + 36000);
  });
  it("parses bare 'Bearer xxx' and pairs", () => {
    expect(parseTokenInput(`Bearer ${access}`, now).refresh).toBeNull();
    expect(parseTokenInput(`${access}\n${refresh}`, now).refresh).toBe(refresh);
  });
  it("rejects foreign/expired tokens", () => {
    expect(() => parseTokenInput(jwt({ iss: "https://evil", typ: "Bearer", exp: now + 10 }), now)).toThrow(TokenInputError);
    expect(() => parseTokenInput(jwt({ iss: ISS, typ: "Bearer", exp: now - 1 }), now)).toThrow(TokenInputError);
    expect(() => parseTokenInput("hello", now)).toThrow(TokenInputError);
  });
  it("empty/'false' refresh = no refresh; broken refresh = explicit error", () => {
    expect(parseTokenInput(JSON.stringify({ access, refresh: "false" }), now).refresh).toBeNull();
    expect(parseTokenInput(JSON.stringify({ access, refresh: "" }), now).refresh).toBeNull();
    expect(() => parseTokenInput(JSON.stringify({ access, refresh: "eyJbroken" }), now)).toThrow(/повреждён/);
  });
  it("offline refresh (exp=0) is fine", () => {
    const off = jwt({ iss: ISS, typ: "Offline", exp: 0 });
    expect(parseTokenInput(JSON.stringify({ access, refresh: off }), now).refreshExp).toBe(0);
  });
});

describe("console token script", () => {
  const run = (cookie: string, ls: Record<string, string>) => {
    let copied = "";
    const localStorage = { getItem: (k: string) => ls[k] ?? null };
    const fn = new Function("document", "localStorage", "copy", "console", "prompt", TOKEN_SCRIPT);
    fn({ cookie }, localStorage, (s: string) => (copied = s), { log() {} }, () => {});
    return JSON.parse(copied);
  };
  it("reads cookies", () => {
    expect(run("foo=1; auth._token.itmoId=Bearer%20AAA; auth._refresh_token.itmoId=BBB; x=2", {})).toEqual({ access: "Bearer AAA", refresh: "BBB" });
  });
  it("prefers localStorage, falls back to cookie, ignores 'false'", () => {
    expect(run("auth._token.itmoId=Bearer%20AAA; auth._refresh_token.itmoId=false", { "auth._refresh_token.itmoId": "LSR" })).toEqual({ access: "Bearer AAA", refresh: "LSR" });
    expect(run("auth._token.itmoId=Bearer%20AAA; auth._refresh_token.itmoId=false", { "auth._refresh_token.itmoId": "false" })).toEqual({ access: "Bearer AAA", refresh: "" });
  });
});

describe("time (MSK)", () => {
  it("handles day boundaries in UTC+3", () => {
    // 2026-09-23 22:30 UTC = 2026-09-24 01:30 МСК
    const ms = Date.UTC(2026, 8, 23, 22, 30);
    expect(mskToday(ms)).toBe("2026-09-24");
    expect(isoWeekday("2026-09-24")).toBe(4);
    expect(mskMonday(ms)).toBe("2026-09-21");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(mskToUnix("2026-09-24", "10:00")).toBe(Date.UTC(2026, 8, 24, 7, 0) / 1000);
  });
  it("quiet window over midnight", () => {
    expect(inWindow("23:30", "23:00", "08:00")).toBe(true);
    expect(inWindow("07:59", "23:00", "08:00")).toBe(true);
    expect(inWindow("12:00", "23:00", "08:00")).toBe(false);
    expect(isQuiet(DEFAULT_SETTINGS, Date.UTC(2026, 8, 23, 21, 0) / 1000)).toBe(true); // 00:00 МСК
  });
  it("next schedule run", () => {
    const now = mskToUnix("2026-09-24", "09:00"); // чт
    expect(nextScheduleRun({ days: [], time: "08:00" }, now)).toBe(mskToUnix("2026-09-25", "08:00"));
    expect(nextScheduleRun({ days: [], time: "10:00" }, now)).toBe(mskToUnix("2026-09-24", "10:00"));
    expect(nextScheduleRun({ days: [1], time: "08:00" }, now)).toBe(mskToUnix("2026-09-28", "08:00"));
  });
});

describe("schedule normalize", () => {
  const limits = { "10": { "1": { available: 3, limit: 20 } }, "11": { "6": { available: 7, limit: 30 } } };
  const days = [
    {
      date: "2026-09-24T00:00:00+03:00",
      lessons: [
        { id: 1, section_name: "Плавание ", lesson_level: 2, lesson_group_id: 10, time_slot_id: 3, can_sign_in: { can_sign_in: true }, date: "2026-09-24T10:00:00+03:00" },
        { id: 3, section_name: "Йога", lesson_group_id: 10, time_slot_id: 7, date: "2026-09-24T19:10:00+03:00", date_end: "2026-09-24T20:10:00+03:00" },
        { id: 2, section_name: "Свободное посещение", lesson_level: 1, lesson_group_id: 11, time_start: "12:00", time_end: "13:30", can_sign_in: { can_sign_in: false }, other_lessons: [{ id: 5 }, { id: 6 }] },
      ],
    },
  ];
  const ls = normalizeDays(days, 273, "Кронва", limits, [
    { id: 3, time_start: "10:00", time_end: "11:30" },
    { id: 7, time_start: "19:00", time_end: "21:00" },
  ]).filter((l) => l.id !== 3);
  const yoga = normalizeDays(days, 273, "Кронва", limits, [{ id: 7, time_start: "19:00", time_end: "21:00" }]).find((l) => l.id === 3)!;
  it("real time from date/date_end, key by slot", () => {
    expect(yoga).toMatchObject({ start: "19:10", end: "20:10", key: "2026-09-24|3|19:00|10" });
  });
  it("maps fields, slots and limits", () => {
    expect(ls[0]).toMatchObject({ id: 1, section: "Плавание", date: "2026-09-24", start: "10:00", end: "11:30", available: 3, limit: 20, canSign: true, freeVisit: false });
    expect(ls[1]).toMatchObject({ available: 7, limit: 30, canSign: false, freeVisit: true, start: "12:00" });
    expect(ls[0]!.key).toBe("2026-09-24|1|10:00|10");
  });
  it("seatsFor falls back to other_lessons", () => {
    expect(seatsFor(limits, { id: 99, lesson_group_id: 11, other_lessons: [{ id: 6 }] })).toEqual({ available: 7, limit: 30 });
    expect(seatsFor(limits, { id: 99 })).toEqual({ available: 0, limit: 0 });
  });
  it("filters", () => {
    const l = ls[0] as Lesson;
    expect(matchesFilter(l, { sections: ["Плавание"] }, "2026-09-20")).toBe(true);
    expect(matchesFilter(l, { days: [1] }, "2026-09-20")).toBe(false);
    expect(matchesFilter(l, { timeFrom: "10:30" }, "2026-09-20")).toBe(false);
    expect(matchesFilter(l, { query: "плав" }, "2026-09-20")).toBe(true);
    expect(matchesFilter(l, {}, "2026-09-25")).toBe(false); // прошедшее
  });
});

describe("chosen flatten", () => {
  it("walks sections → groups → lessons", () => {
    const raw = [{ section_name: "Йога", lesson_groups: [{ id: 5, has_future_lessons: true, lessons: [{ id: 77, date_start: "2026-09-25T15:20:00+03:00", date_end: "2026-09-25T16:50:00+03:00", room_name: "Зал" }] }] }];
    expect(flattenChosen(raw)).toEqual([{ id: 77, section: "Йога", date: "2026-09-25", start: "15:20", end: "16:50", room: "Зал", teacher: "", groupId: 5 }]);
  });
});

describe("watcher validation", () => {
  it("defaults and clamps", () => {
    const w = sanitizeWatcher({ filter: { sections: ["Йога", "Йога"], days: [1, 9], weeks: 99 }, intervalMin: 7 });
    expect(w).toMatchObject({ mode: "interval", intervalMin: 15, action: "notify", name: "Йога" });
    expect(w.filter).toEqual({ sections: ["Йога"], days: [1], weeks: 4 });
  });
  it("auto only with interval", () => {
    expect(() => sanitizeWatcher({ mode: "schedule", schedule: { time: "08:00" }, action: "auto" })).toThrow(ValidationError);
    expect(() => sanitizeWatcher({ mode: "schedule", schedule: { time: "8am" } })).toThrow(ValidationError);
  });
});

describe("date range", () => {
  it("parses and validates", () => {
    const t = "2026-09-24";
    expect(parseRange(undefined, undefined, t)).toEqual({ from: t, to: "2026-10-07" });
    expect(parseRange("2026-10-07", undefined, t)).toEqual({ from: "2026-10-07", to: "2026-10-07" });
    expect(parseRange("2026-10-25", "2026-10-20", t)).toEqual({ from: "2026-10-20", to: "2026-10-25" });
    expect(typeof parseRange("2026-09-01", "2026-09-30", t)).toBe("string");
    expect(typeof parseRange("2026-10-01", "2026-12-01", t)).toBe("string");
    expect(typeof parseRange("2027-06-01", "2027-06-02", t)).toBe("string");
    expect(typeof parseRange("2026-9-1", "x", t)).toBe("string");
  });
  it("splits into ITMO weeks", () => {
    expect(weekStarts("2026-10-07", "2026-10-07")).toEqual(["2026-10-05"]);
    expect(weekStarts("2026-09-24", "2026-10-07")).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
    expect(weekStarts("2026-10-05", "2026-10-11")).toEqual(["2026-10-05"]);
  });
});
