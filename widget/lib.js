/*
 * Pure helpers for the on-device widget (importable in Node for tests).
 *
 * The macro opens the widget with a URL hash such as
 *   #app=<webapp url>&d=<device id>&n=<name>&t=<token>&x=<accept-until>
 *    &s=<show-until>&e=<join endpoint>
 * and the widget renders a QR code that points at the phone web app with the
 * scan parameters (d, n, t, x, e, m) in *its* hash.
 */

export const SCAN_KEYS = ["d", "n", "t", "x", "e", "m"];

export function parseHash(hash = "") {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw);
}

/** Build the URL encoded into the QR code, or null when inputs are unusable. */
export function buildScanUrl(params) {
  const app = params.get("app");
  if (!app || !params.get("d") || !params.get("t")) return null;
  let url;
  try {
    url = new URL(app);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const scan = new URLSearchParams();
  for (const key of SCAN_KEYS) {
    const value = params.get(key);
    if (value) scan.set(key, value);
  }
  url.hash = scan.toString();
  return url.toString();
}

/** Seconds left until an epoch-seconds deadline (never negative). */
export function secondsLeft(epochSeconds, now = Date.now()) {
  const target = Number(epochSeconds);
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.ceil(target - now / 1000));
}

export function formatCountdown(total) {
  if (total === null) return "";
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** Widget theme: dark unless #theme=light is given (RoomOS is always dark UI). */
export function resolveTheme(params) {
  return params.get("theme") === "light" ? "light" : "dark";
}

/**
 * QR colours. On the dark theme the code is drawn light-on-dark (inverted) to
 * match the device UI; #qr=normal restores dark-on-light for scanners that do
 * not read inverted codes. The light theme is always dark-on-light.
 */
export function qrColors(theme, params) {
  const inverted = theme === "dark" && params.get("qr") !== "normal";
  if (inverted) return { dark: "#ffffff", light: "#121212" };
  return { dark: "#000000", light: "#ffffff" };
}
