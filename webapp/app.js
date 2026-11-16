import {
  buildJoinPayload,
  isEndpointAllowed,
  applyMeetingInfo,
  isScanExpired,
  meetingInfoRequest,
  scanFromQrText,
  normalizeCalendarEvent,
  personalRoomToMeeting,
  toJoinableMeetings,
} from "./lib.js";
import {
  clearCredentials,
  clearPendingScan,
  consumeUrl,
  getCredentials,
  loadPendingScan,
  savePendingScan,
  startLogin,
} from "./oauth.js";
import { getMeetingInfo, listCalendarEvents } from "./sdk.js";
import { startScanner } from "./scanner.js";
import { getMe, getPersonalRoom, listMeetings } from "./webex.js";

const appConfig = window.APP_CONFIG ?? {};
const config = window.WEBAPP_CONFIG ?? {};
const $ = (id) => document.getElementById(id);

const state = {
  scan: null,
  user: "",
  meetings: [],
  pmr: null,
  loading: { pmr: false, meetings: false },
  sending: false,
};

// "#theme=light|dark" forces a theme (used for screenshots); otherwise the OS
// preference applies. Read before the URL hash is consumed and cleaned.
{
  const theme = new URLSearchParams(location.hash.slice(1)).get("theme");
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  }
}

if (appConfig.title) {
  $("app-product").textContent = appConfig.title;
  document.title = appConfig.title;
}

/* ------------------------------------------------------------------- UI */

function show(view) {
  for (const id of [
    "view-signin",
    "view-meetings",
    "view-done",
    "view-scanner",
  ]) {
    $(id).hidden = id !== view;
  }
  $("sign-out").hidden = view === "view-signin";
}

function banner(message, kind = "") {
  const el = $("banner");
  el.textContent = message;
  el.hidden = !message;
  if (kind) el.dataset.kind = kind;
  else delete el.dataset.kind;
}

function deviceLabel() {
  return state.scan?.deviceName || "this device";
}

function fmtTime(ms) {
  if (!ms) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** Collapsible "Meeting information", like the Webex app's info panel. */
function renderDetails(details) {
  const rows = [
    ["Meeting link", details.link],
    ["Meeting number", details.number],
    ["Meeting password", details.password],
    ["Join by video system", details.videoAddress],
    ["Meeting password for video system", details.videoPassword],
    ["Join by phone", details.phones.map((p) => `${p.label} ${p.number}`)],
    ["Access code", details.accessCode],
    ["Meeting password for audio", details.audioPassword],
    ["Host PIN", details.hostPin],
  ].filter(([, v]) => (Array.isArray(v) ? v.length : v));
  const box = document.createElement("details");
  box.className = "meeting__details";
  const summary = document.createElement("summary");
  summary.textContent = "Meeting information";
  const dl = document.createElement("dl");
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = Array.isArray(value) ? value.join("\n") : value;
    dl.append(dt, dd);
  }
  box.append(summary, dl);
  return box;
}

function renderMeetings() {
  const expired = isScanExpired(state.scan);
  // Offer a rescan whenever there is no usable QR code.
  $("scan-new").hidden = Boolean(state.scan) && !expired;
  const list = $("meeting-list");

  if (!state.scan) {
    $("meetings-heading").textContent = "Your meetings";
    $("meetings-hint").textContent =
      "To join on a room device, scan the QR code on its screen.";
  } else if (expired) {
    $("meetings-heading").textContent = "QR code expired";
    $("meetings-hint").textContent =
      "Scan the current QR code on the device screen to continue.";
  } else {
    $("meetings-heading").textContent = `Join on ${deviceLabel()}`;
    $("meetings-hint").textContent =
      `Want to join with your meeting on ${deviceLabel()}? Tap a meeting below to join.` +
      (state.scan.endpoint
        ? ` Your selection is sent to ${new URL(state.scan.endpoint).host}.`
        : "");
  }

  fillList(list, state.meetings, {
    loading: state.loading.meetings,
    skeletons: 2,
    empty: "No joinable meetings found in the next 24 hours.",
    expired,
  });
  fillList($("pmr-list"), state.pmr ? [state.pmr] : [], {
    loading: state.loading.pmr,
    skeletons: 1,
    empty: "No Personal Meeting Room found for your account.",
    expired,
  });
}

/** Fill a list with meeting rows, skeleton placeholders or an empty note. */
function fillList(list, meetings, { loading, skeletons, empty, expired }) {
  list.replaceChildren();
  list.setAttribute("aria-busy", String(loading));
  if (loading) {
    for (let i = 0; i < skeletons; i += 1) list.append(skeletonRow());
    return;
  }
  if (!meetings.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = empty;
    list.append(li);
    return;
  }
  for (const meeting of meetings) list.append(meetingRow(meeting, expired));
}

/** Animated placeholder shown while meetings are loading. */
function skeletonRow() {
  const li = document.createElement("li");
  li.className = "meeting skeleton";
  li.setAttribute("aria-hidden", "true");
  const info = document.createElement("div");
  for (const cls of [
    "skeleton__line skeleton__line--title",
    "skeleton__line",
  ]) {
    const line = document.createElement("span");
    line.className = cls;
    info.append(line);
  }
  const button = document.createElement("span");
  button.className = "skeleton__button";
  li.append(info, button);
  return li;
}

function meetingRow(meeting, expired) {
  const li = document.createElement("li");
  li.className = "meeting";

  const info = document.createElement("div");
  const title = document.createElement("span");
  title.className = "meeting__title";
  title.textContent = meeting.title;
  const meta = document.createElement("span");
  meta.className = "meeting__meta";
  meta.textContent = [
    meeting.inProgress ? "In progress" : fmtTime(meeting.start),
    meeting.kind,
  ]
    .filter(Boolean)
    .join(" · ");
  info.append(title, meta);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = "Join";
  button.disabled = !state.scan || expired || state.sending;
  button.addEventListener("click", () => join(meeting));

  if (meeting.details) info.append(renderDetails(meeting.details));
  li.append(info, button);
  return li;
}

/* ----------------------------------------------------------------- flow */

/** Debug: add ?debug to the page URL (or run localStorage.setItem("qr-meeting-join_debug","1")). */
function debugEnabled() {
  try {
    return (
      new URLSearchParams(location.search).has("debug") ||
      localStorage.getItem("qr-meeting-join_debug") === "1"
    );
  } catch {
    return false;
  }
}

const debugData = {};

/** Log a debug value to the console and the on-page panel. */
function debugRecord(key, value) {
  if (!debugEnabled()) return;
  debugData[key] = value;
  console.log(`[qr-meeting-join] ${key}`, value);
  showDebug(debugData);
}

/** Show the raw API data on the page too, since phones have no console. */
function showDebug(data) {
  let panel = $("debug-panel");
  if (!panel) {
    panel = document.createElement("details");
    panel.id = "debug-panel";
    panel.append(
      document.createElement("summary"),
      document.createElement("pre"),
    );
    panel.firstChild.textContent = "Debug: raw meeting data";
    $("view-meetings").append(panel);
  }
  panel.querySelector("pre").textContent = JSON.stringify(data, null, 2);
}

/**
 * Gather meetings from every source: the SDK calendar (Webex and non-Webex),
 * the REST meetings API, and the user's Personal Meeting Room. A source that
 * fails is skipped so one missing scope does not hide the others.
 */
async function fetchMeetings(accessToken) {
  const now = Date.now();
  const roomRequest = getPersonalRoom(accessToken);
  // The PMR is a single quick REST call: show it without waiting for the SDK.
  roomRequest
    .then((room) => {
      state.pmr = personalRoomToMeeting(room);
    })
    .catch(() => {
      state.pmr = null;
    })
    .finally(() => {
      state.loading.pmr = false;
      renderMeetings();
    });
  const [events, rest, room] = await Promise.allSettled([
    listCalendarEvents(accessToken, {
      from: now - 15 * 60 * 1000,
      to: now + 24 * 3600 * 1000,
    }),
    listMeetings(accessToken),
    roomRequest,
  ]);
  const results = [events, rest, room];
  const unauthorized = results.find((r) => r.reason?.status === 401);
  if (unauthorized) throw unauthorized.reason;
  if (results.every((r) => r.status === "rejected")) throw rest.reason;
  for (const r of results) {
    if (r.status === "rejected")
      console.warn("Meeting source failed:", r.reason);
  }

  debugRecord("calendarEvents", events.value ?? String(events.reason));
  debugRecord("restMeetings", rest.value ?? String(rest.reason));
  debugRecord("personalRoom", room.value ?? String(room.reason));

  // Webex meetings: fetch the full details (passwords, dial-in numbers).
  const calendar = events.value ?? [];
  const infos = await Promise.allSettled(
    calendar.map((event) => {
      const request = meetingInfoRequest(event);
      return request
        ? getMeetingInfo(accessToken, request)
        : Promise.resolve(null);
    }),
  );
  debugRecord(
    "meetingInfo",
    infos.map((r, i) => ({
      event: calendar[i]?.id,
      request: meetingInfoRequest(calendar[i]),
      result: r.status === "fulfilled" ? r.value : String(r.reason),
    })),
  );

  const items = [
    ...calendar.map((event, i) => {
      const item = normalizeCalendarEvent(event);
      const info = infos[i]?.status === "fulfilled" ? infos[i].value : null;
      return item && info ? applyMeetingInfo(item, info) : item;
    }),
    ...(rest.value ?? []),
  ].filter(Boolean);
  const meetings = toJoinableMeetings(items, now);
  return meetings;
}

async function loadMeetings() {
  const credentials = getCredentials();
  if (!credentials) return signedOut();
  $("refresh").disabled = true;
  state.meetings = [];
  state.pmr = null;
  state.loading = { pmr: true, meetings: true };
  show("view-meetings");
  renderMeetings();
  try {
    if (!state.user) {
      state.user = (await getMe(credentials.accessToken))?.displayName ?? "";
    }
    state.meetings = await fetchMeetings(credentials.accessToken);
    banner(
      isScanExpired(state.scan)
        ? "This QR code has expired. Scan the new one on the device screen."
        : "",
      "error",
    );
  } catch (error) {
    state.loading = { pmr: false, meetings: false };
    if (error?.status === 401) {
      clearCredentials();
      return signedOut("Your session expired. Please sign in again.");
    }
    state.meetings = [];
    banner(`Could not load meetings: ${error.message}`, "error");
  } finally {
    $("refresh").disabled = false;
  }
  state.loading = { pmr: false, meetings: false };
  renderMeetings();
}

/* ------------------------------------------------------- in-app scanning */

let stopScanner = null;

/** Leave the scanner (stopping the camera) and return to the meetings. */
function endScan() {
  stopScanner?.();
  stopScanner = null;
  show("view-meetings");
  renderMeetings();
}

async function beginScan() {
  banner("");
  show("view-scanner");
  try {
    stopScanner = await startScanner($("scanner-video"), (text) => {
      const scan = scanFromQrText(text, location.href);
      if (!scan) return false; // some other QR code: keep looking
      debugRecord("scannedQr", { ...scan, token: "…" });
      savePendingScan(scan);
      state.scan = scan;
      stopScanner = null;
      show("view-meetings");
      banner("");
      renderMeetings();
      return true;
    });
  } catch (error) {
    stopScanner = null;
    show("view-meetings");
    renderMeetings();
    banner(
      error?.name === "NotAllowedError"
        ? "Camera access was blocked. Allow the camera for this site to scan."
        : `Could not start the camera: ${error.message}`,
      "error",
    );
  }
}

function signedOut(message = "") {
  state.meetings = [];
  state.pmr = null;
  banner(message, message ? "error" : "");
  $("signin-heading").textContent = state.scan
    ? `Join on ${deviceLabel()}`
    : "Sign in to join";
  $("signin-text").textContent = state.scan
    ? `Want to join with your meeting on ${deviceLabel()}? Sign in with Webex, then tap your meeting to join.`
    : "Sign in with Webex to see your meetings, then scan a device QR code to join.";
  show("view-signin");
}

async function join(meeting) {
  if (state.sending) return;
  if (!state.scan || isScanExpired(state.scan)) {
    banner("This QR code has expired. Please rescan.", "error");
    return renderMeetings();
  }
  const endpoint = state.scan.endpoint;
  if (!endpoint) {
    return banner(
      "This QR code has no join endpoint. Ask the room owner to set one in the macro.",
      "error",
    );
  }
  if (!isEndpointAllowed(endpoint, config.allowedEndpointHosts)) {
    return banner(
      "This QR code points to a server that is not allowed.",
      "error",
    );
  }

  state.sending = true;
  renderMeetings();
  try {
    const headers = { "Content-Type": "application/json" };
    const body = JSON.stringify(
      buildJoinPayload({ scan: state.scan, meeting, user: state.user }),
    );
    debugRecord("joinRequest", {
      method: "POST",
      url: endpoint,
      headers,
      body: JSON.parse(body),
    });
    // Cross-origin application/json triggers a CORS preflight (OPTIONS), so
    // the join endpoint must answer it with the right CORS headers.
    const response = await fetch(endpoint, { method: "POST", headers, body });
    debugRecord("joinResponse", {
      status: response.status,
      ok: response.ok,
    });
    if (!response.ok) throw new Error(`Server responded ${response.status}`);
    // Tokens are single use: drop it so a refresh cannot replay it.
    clearPendingScan();
    $("done-text").textContent =
      `Sent "${meeting.title}" to ${deviceLabel()}. Watch the device screen.`;
    state.scan = null;
    banner("");
    show("view-done");
  } catch (error) {
    debugRecord("joinError", String(error));
    banner(`Could not send the request: ${error.message}`, "error");
  } finally {
    state.sending = false;
    if (!$("view-meetings").hidden) renderMeetings();
  }
}

/* ----------------------------------------------------------------- init */

$("sign-in").addEventListener("click", () => {
  const error = startLogin(config);
  if (error) banner(error, "error");
});
$("sign-out").addEventListener("click", () => {
  clearCredentials();
  signedOut();
});
$("refresh").addEventListener("click", loadMeetings);
$("scan-new").addEventListener("click", beginScan);
$("scanner-cancel").addEventListener("click", () => endScan());
$("done-back").addEventListener("click", loadMeetings);

(async function init() {
  const result = consumeUrl();
  state.scan = result.type === "scan" ? result.scan : loadPendingScan();

  if (state.scan && isScanExpired(state.scan)) {
    banner(
      "This QR code has expired. Scan the new one on the device screen.",
      "error",
    );
  }
  if (result.error) {
    banner(result.error, "error");
    return signedOut(result.error);
  }
  if (!getCredentials())
    return signedOut(document.getElementById("banner").textContent);
  await loadMeetings();
})();
