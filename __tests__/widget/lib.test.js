import { describe, expect, test } from "@jest/globals";
import {
  buildScanUrl,
  formatCountdown,
  parseHash,
  qrColors,
  resolveTheme,
  secondsLeft,
} from "../../widget/lib.js";

const hash =
  "#app=https%3A%2F%2Fex.github.io%2Fr%2Fwebapp%2F&d=dev%2B1&n=Room%201234&t=abc&x=999&e=https%3A%2F%2Fhooks.example.com%2Fjoin&m=qr-join&v=1&title=Hi";

describe("buildScanUrl", () => {
  test("carries the message type into the QR code", () => {
    const url = new URL(buildScanUrl(parseHash(hash)));
    expect(new URLSearchParams(url.hash.slice(1)).get("m")).toBe("qr-join");
  });

  test("carries device, name, token and expiry in the webapp hash", () => {
    const url = new URL(buildScanUrl(parseHash(hash)));
    expect(url.origin + url.pathname).toBe("https://ex.github.io/r/webapp/");
    const p = new URLSearchParams(url.hash.slice(1));
    expect(Object.fromEntries(p)).toEqual({
      d: "dev+1",
      n: "Room 1234",
      t: "abc",
      x: "999",
      e: "https://hooks.example.com/join",
      m: "qr-join",
      v: "1",
    });
  });

  test("does not leak widget-only params into the QR", () => {
    expect(buildScanUrl(parseHash(hash))).not.toContain("title");
  });

  test("returns null without device/token or with a bad app url", () => {
    expect(buildScanUrl(parseHash("#app=https://x/&d=1"))).toBeNull();
    expect(buildScanUrl(parseHash("#app=javascript:1&d=1&t=2"))).toBeNull();
    expect(buildScanUrl(parseHash(""))).toBeNull();
  });
});

describe("countdown", () => {
  test("secondsLeft never goes negative", () => {
    expect(secondsLeft(100, 99_000)).toBe(1);
    expect(secondsLeft(100, 200_000)).toBe(0);
    expect(secondsLeft("x")).toBeNull();
  });
  test("formatCountdown", () => {
    expect(formatCountdown(125)).toBe("2:05");
    expect(formatCountdown(null)).toBe("");
  });
});

describe("theme and QR colours", () => {
  test("is dark by default and only light on request", () => {
    expect(resolveTheme(parseHash(""))).toBe("dark");
    expect(resolveTheme(parseHash("#theme=light"))).toBe("light");
    expect(resolveTheme(parseHash("#theme=bogus"))).toBe("dark");
  });
  test("draws the QR light-on-dark on the dark theme", () => {
    expect(qrColors("dark", parseHash(""))).toEqual({
      dark: "#ffffff",
      light: "#121212",
    });
  });
  test("#qr=normal and the light theme use dark-on-light", () => {
    const normal = { dark: "#000000", light: "#ffffff" };
    expect(qrColors("dark", parseHash("#qr=normal"))).toEqual(normal);
    expect(qrColors("light", parseHash(""))).toEqual(normal);
  });
});
