/*
 * Pure helpers for the phone web app (importable in Node for tests).
 */

export const PAYLOAD_VERSION = 1;
export const DEFAULT_MESSAGE_TYPE = "qr-join";

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
    messageType: p.get("m")?.trim() || DEFAULT_MESSAGE_TYPE,
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

/**
 * Map an event from the Webex SDK calendar service (webex.internal.calendar,
 * after the SDK has decrypted it) onto the record shape used above. Unlike
 * the REST /meetings API this includes events that are not Webex meetings -
 * Zoom, Teams and Google Meet links live in the location or notes.
 */
export function normalizeCalendarEvent(event) {
  if (!event || typeof event !== "object") return null;
  const when = (v) =>
    typeof v === "string" ? v : (v?.dateTime ?? v?.date ?? "");
  const start = when(event.start ?? event.startTime);
  let end = when(event.end ?? event.endTime);
  if (!end && start && Number(event.durationMinutes) > 0) {
    end = new Date(
      Date.parse(start) + Number(event.durationMinutes) * 60000,
    ).toISOString();
  }
  // The SDK decrypts calendar fields in place, so the readable text is still
  // under its encrypted* name (encryptedSubject, encryptedLocation, ...).
  const text = (...values) => values.find((v) => typeof v === "string" && v);
  const organizer = event.encryptedOrganizer ?? event.organizer ?? {};
  const joinInfo = event.meetingJoinInfo ?? {};
  return {
    id: event.id,
    title:
      text(event.subject, event.encryptedSubject, event.summary, event.title) ??
      "",
    start,
    end,
    sipAddress: /@/.test(event.webexURI ?? "")
      ? event.webexURI.replace(/^sip:/i, "")
      : "",
    webLink:
      text(event.webexURL, joinInfo.meetingJoinURL, event.spaceMeetURL) ?? "",
    location: text(event.location, event.encryptedLocation) ?? "",
    agenda: text(event.notes, event.encryptedNotes) ?? "",
    hostEmail:
      text(
        organizer.encryptedEmailAddress,
        organizer.emailAddress,
        organizer.email,
      ) ?? "",
  };
}

/**
 * Where to ask for a Webex meeting's full details (password, video-system
 * password, dial-in numbers). Only webex.com hosts are accepted so the access
 * token is never sent anywhere else.
 */
export function meetingInfoRequest(event) {
  const info = event?.meetingJoinInfo;
  const site = info?.webexMeetingInfo?.siteName;
  const sipUrl = event?.webexURI || info?.meetingJoinURI;
  if (
    info?.meetingJoinType !== "WEBEX" ||
    typeof site !== "string" ||
    !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.webex\.com$/i.test(site) ||
    !sipUrl
  ) {
    return null;
  }
  return {
    uri: `https://${site}/wbxappapi/v1/meetingInfo`,
    body: {
      supportHostKey: true,
      supportCountryList: true,
      sipUrl: String(sipUrl).replace(/^sip:/i, ""),
      disableWebRedirect: true,
    },
  };
}

/** Readable details of a meeting, as shown in the Webex app's info panel. */
export function meetingInfoToDetails(info) {
  if (!info || typeof info !== "object") return null;
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  const spaced = (n) => str(n).replace(/^(\d{4})(\d{3})(\d+)$/, "$1 $2 $3");
  const details = {
    link: str(info.meetingJoinUrl || info.meetingLink),
    number: spaced(info.meetingNumber),
    password: str(info.password),
    videoAddress: str(info.video?.videoAddress || info.sipUrl),
    videoPassword: str(info.video?.videoPassword),
    phones: (info.audio?.callInNumbers ?? [])
      .filter((p) => p?.number)
      .map((p) => ({ label: str(p.label), number: str(p.number) })),
    accessCode: str(info.audio?.accessCode),
    audioPassword: str(info.audio?.audioPassword),
    hostPin: str(info.hostKey),
  };
  return details;
}

/**
 * Merge a /meetingInfo response into a normalised calendar item: dial the
 * video-system address and send the video-system password as DTMF.
 */
export function applyMeetingInfo(item, info) {
  const details = meetingInfoToDetails(info);
  if (!details) return item;
  const pin = details.videoPassword;
  return {
    ...item,
    details,
    sipAddress:
      info.sipUrl || info.video?.videoAddress || item.sipAddress || "",
    guestPin: /^[0-9*#]{1,32}$/.test(pin) ? pin : "",
    hostPin: /^\d+$/.test(details.hostPin) ? details.hostPin : "",
  };
}

/**
 * Turn the /meetingPreferences/personalMeetingRoom response into a meeting
 * entry so users with nothing scheduled can still join their PMR (with the
 * host PIN, which belongs to them).
 */
export function personalRoomToMeeting(room) {
  const destination = room?.sipAddress || room?.personalMeetingRoomLink || "";
  if (!destination) return null;
  const pin = String(room.hostPin ?? "");
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  return {
    id: "personal-meeting-room",
    title: room.topic || "Personal Meeting Room",
    start: null,
    end: null,
    inProgress: false,
    hostEmail: "",
    hostPin: /^\d+$/.test(pin) ? pin : "",
    kind: "webex",
    destination,
    personal: true,
    details: {
      link: str(room.personalMeetingRoomLink),
      number: "",
      password: "",
      videoAddress: str(room.sipAddress),
      videoPassword: "",
      phones: (room.telephony?.callInNumbers ?? [])
        .filter((p) => p?.callInNumber)
        .map((p) => ({ label: str(p.label), number: str(p.callInNumber) })),
      accessCode: str(room.telephony?.accessCode),
      audioPassword: "",
      hostPin: pin,
    },
  };
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
    // The same meeting can arrive from the SDK and REST with different ids.
    const same = `${target.destination}|${Number.isFinite(start) ? start : ""}`;
    if (seen.has(key) || seen.has(same)) continue;
    seen.add(key);
    seen.add(same);
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
      hostPin:
        item.hostPin ||
        (item.hostKey && /^\d+$/.test(item.hostKey) ? item.hostKey : ""),
      guestPin: item.guestPin || "",
      details: item.details || null,
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
    type: scan.messageType || DEFAULT_MESSAGE_TYPE,
    v: PAYLOAD_VERSION,
    deviceId: scan.deviceId,
    token: scan.token,
    destination: meeting.destination,
    meetingType: meeting.kind || "webex",
    title: meeting.title,
    user: user || "",
  };
  if (meeting.hostPin && (meeting.personal || (meeting.hostEmail && user))) {
    // The PIN of the user's own PMR, or a meeting they plausibly host.
    payload.hostPin = meeting.hostPin;
  }
  const guest = guestPin || meeting.guestPin;
  if (guest) payload.guestPin = guest;
  return payload;
}
