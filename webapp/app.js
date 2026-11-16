import {
  buildJoinPayload,
  isEndpointAllowed,
  isScanExpired,
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
  startLogin,
} from "./oauth.js";
import { listCalendarEvents } from "./sdk.js";
import { getMe, getPersonalRoom, listMeetings } from "./webex.js";

const appConfig = window.APP_CONFIG ?? {};
const config = window.WEBAPP_CONFIG ?? {};
const $ = (id) => document.getElementById(id);

const state = { scan: null, user: "", meetings: [], sending: false };

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
  for (const id of ["view-signin", "view-meetings", "view-done"]) {
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

function renderMeetings() {
  const expired = isScanExpired(state.scan);
  const list = $("meeting-list");
  list.replaceChildren();

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

  if (!state.meetings.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No joinable meetings found in the next 24 hours.";
    list.append(li);
    return;
  }

  for (const meeting of state.meetings) {
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

    li.append(info, button);
    list.append(li);
  }
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
  const [events, rest, room] = await Promise.allSettled([
    listCalendarEvents(accessToken, {
      from: now - 15 * 60 * 1000,
      to: now + 24 * 3600 * 1000,
    }),
    listMeetings(accessToken),
    getPersonalRoom(accessToken),
  ]);
  const results = [events, rest, room];
  const unauthorized = results.find((r) => r.reason?.status === 401);
  if (unauthorized) throw unauthorized.reason;
  if (results.every((r) => r.status === "rejected")) throw rest.reason;
  for (const r of results) {
    if (r.status === "rejected")
      console.warn("Meeting source failed:", r.reason);
  }

  if (debugEnabled()) {
    const raw = {
      calendarEvents: events.value ?? String(events.reason),
      restMeetings: rest.value ?? String(rest.reason),
      personalRoom: room.value ?? String(room.reason),
    };
    console.log("[qr-meeting-join] raw meeting data", raw);
    showDebug(raw);
  }

  const items = [
    ...(events.value ?? []).map(normalizeCalendarEvent).filter(Boolean),
    ...(rest.value ?? []),
  ];
  const meetings = toJoinableMeetings(items, now);
  const pmr = room.status === "fulfilled" && personalRoomToMeeting(room.value);
  return pmr ? [pmr, ...meetings] : meetings;
}

async function loadMeetings() {
  const credentials = getCredentials();
  if (!credentials) return signedOut();
  $("refresh").disabled = true;
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
    if (error?.status === 401) {
      clearCredentials();
      return signedOut("Your session expired. Please sign in again.");
    }
    state.meetings = [];
    banner(`Could not load meetings: ${error.message}`, "error");
  } finally {
    $("refresh").disabled = false;
  }
  show("view-meetings");
  renderMeetings();
}

function signedOut(message = "") {
  state.meetings = [];
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
    const response = await fetch(endpoint, {
      method: "POST",
      // Cross-origin application/json triggers a CORS preflight (OPTIONS), so
      // the join endpoint must answer it with the right CORS headers.
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        buildJoinPayload({ scan: state.scan, meeting, user: state.user }),
      ),
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
