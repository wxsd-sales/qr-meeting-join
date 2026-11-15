/*
 * Pure helpers for the phone web app (importable in Node for tests).
 */

export const PAYLOAD_VERSION = 1;

/* ------------------------------------------------------------------- scan */

export function parseHashParams(hash = "") {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw);
}

/**
 * A join endpoint must be https (http only for localhost development) and
 * carry no credentials. Returns the normalised URL or "".
 */
export function normalizeEndpoint(value) {
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return "";
  }
  if (url.username || url.password) return "";
  return url.toString();
}

/** True when the host is allowed by the (optional) allowlist. */
export function isEndpointAllowed(endpoint, allowedHosts = []) {
  if (!endpoint) return false;
  if (!allowedHosts?.length) return true;
  try {
    return allowedHosts.includes(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/** Extract the QR scan details (device, name, token, expiry, endpoint). */
export function parseScan(hash) {
  const p = parseHashParams(hash);
  const deviceId = p.get("d")?.trim();
  const token = p.get("t")?.trim();
  if (!deviceId || !token) return null;
  const expires = Number(p.get("x"));
  return {
    deviceId,
    token,
    deviceName: p.get("n")?.trim() || "",
    endpoint: normalizeEndpoint(p.get("e")?.trim()),
    expiresAt: Number.isFinite(expires) && expires > 0 ? expires * 1000 : 0,
  };
}

export function isScanExpired(scan, now = Date.now()) {
  return Boolean(scan?.expiresAt) && now > scan.expiresAt;
}

/* --------------------------------------------------------------- meetings */

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Identify a joinable link and the best dial destination for it. */
export function classifyLink(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith("webex.com")) {
    return { kind: "webex", destination: url.toString() };
  }
  if (host.endsWith("zoom.us") || host.endsWith("zoomgov.com")) {
    const id = url.pathname.match(/\/j\/(\d{9,12})/)?.[1];
    if (!id) return null;
    return { kind: "zoom", destination: `${id}@zoomcrc.com` };
  }
  if (
    host === "teams.microsoft.com" ||
    host === "teams.live.com" ||
    host.endsWith(".teams.microsoft.com")
  ) {
    if (!/meetup-join|\/meet\//.test(url.pathname)) return null;
    return { kind: "teams", destination: url.toString() };
  }
  if (host === "meet.google.com") {
    if (!/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url.pathname)) return null;
    return { kind: "google", destination: url.toString() };
  }
  return null;
}

/** Find the first joinable target in a meeting record. */
export function extractJoinTarget(meeting) {
  // Webex's own SIP address is the most reliable thing to dial.
  if (meeting.sipAddress) {
    return { kind: "webex", destination: meeting.sipAddress };
  }
  const haystack = [
    meeting.webLink,
    meeting.location,
    meeting.agenda,
    meeting.body,
  ]
    .filter((v) => typeof v === "string")
    .join(" ");
  for (const link of haystack.match(URL_RE) ?? []) {
    const found = classifyLink(link.replace(/[.,;]+$/, ""));
    if (found) return found;
  }
  return null;
}

/** Normalise raw API items into joinable, de-duplicated, time-sorted entries. */
export function toJoinableMeetings(items, now = Date.now()) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    const target = extractJoinTarget(item);
    if (!target) continue;
    const start = Date.parse(item.start);
    const end = Date.parse(item.end);
    if (Number.isFinite(end) && end < now) continue;
    const key = item.id ?? `${item.title}|${item.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: key,
      title: item.title || "Meeting",
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      inProgress:
        item.state === "inProgress" ||
        (Number.isFinite(start) &&
          Number.isFinite(end) &&
          start <= now &&
          now <= end),
      hostEmail: item.hostEmail || "",
      hostPin: item.hostKey && /^\d+$/.test(item.hostKey) ? item.hostKey : "",
      kind: target.kind,
      destination: target.destination,
    });
  }
  return out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/* ------------------------------------------------------------------- join */

/** Request body POSTed to the middleware. See docs/backend-contract.md. */
export function buildJoinPayload({ scan, meeting, user, guestPin }) {
  const payload = {
    v: PAYLOAD_VERSION,
    deviceId: scan.deviceId,
    token: scan.token,
    destination: meeting.destination,
    meetingType: meeting.kind || "webex",
    title: meeting.title,
    user: user || "",
  };
  if (meeting.hostPin && meeting.hostEmail && user) {
    // Only offer the host PIN when the signed-in user is plausibly the host.
    payload.hostPin = meeting.hostPin;
  }
  if (guestPin) payload.guestPin = guestPin;
  return payload;
}
