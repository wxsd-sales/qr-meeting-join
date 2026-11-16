import xapi from "xapi";

/*
 * QR Meeting Join - Cisco RoomOS macro.
 *
 * Runs entirely in the background with no on-device user input. It saves a web
 * widget (UserInterface.Extensions.WebWidget.Save) and re-saves it with the same
 * PanelId and a new URL hash each time the token refreshes; the widget page
 * renders a QR code that opens the phone web app with a URL hash:
 *   d = the device's Webex device ID (Status.Webex.DeveloperId)
 *   n = the device's friendly name (shown to the user, never on the widget)
 *   t = a short-lived, single-use token minted by this macro
 *   x = epoch seconds after which the token is no longer accepted
 *   e = the join endpoint (webhook / Lambda URL) the web app should POST to
 *   m = the message type ("qr-join") the web app echoes back as `type`, so the
 *       middleware can relay it in the Message Send text this macro filters on
 *   v = the message version (MESSAGE_VERSION), echoed back as `v` the same way
 *
 * Every field handleJoinMessage() validates (type, v, deviceId, token,
 * destination) is carried from here through the QR code and web app into the
 * join request, so the middleware only has to relay the body unchanged.
 *
 * The user signs in to Webex on their phone, picks a meeting, and the web app
 * POSTs { deviceId, token, destination, ... } to that endpoint (unauthenticated
 * for now). The middleware issues a Cloud xAPI `Message Send` to this device;
 * this macro validates the token and joins. The middleware cannot return the
 * result to the phone, so every outcome is shown on the device itself.
 *
 * The values between the CONFIG markers are managed by the wizard (Copy
 * config / Download macro) - regenerate them there rather than editing by hand.
 */

// CONFIG:start
const MACRO_NAME = "qr-meeting-join";
const WIDGET_URL = "https://wxsd-sales.github.io/qr-meeting-join/widget/";
const WEBAPP_URL = "https://wxsd-sales.github.io/qr-meeting-join/webapp/";
const JOIN_ENDPOINT = "";
const TOKEN_REFRESH_SECONDS = 120;
const TOKEN_GRACE_SECONDS = 120;
const WIDGET_TITLE = "Join your meeting";
const WIDGET_SUBTITLE = "Scan with your phone camera";
const DEBUG = false;
// CONFIG:end

const WIDGET_NAME = "QR Meeting Join";
const MESSAGE_TYPE = "qr-join";
const MESSAGE_VERSION = 1;
const MAX_DESTINATION_LENGTH = 512;
const PIN_DIGITS = /^[0-9*#]{1,32}$/;
const DTMF_DELAY_MS = 6000;
const MEETING_TYPES = ["webex", "zoom", "teams", "google"];

/** token -> { issuedAt, displayUntil, validUntil } (epoch ms) */
const tokens = new Map();
let currentToken = null;
let rotateTimer = null;
let identity = { deviceId: "", deviceName: "" };

/* ----------------------------------------------------------------- tokens */

function randomHex(bytes = 16) {
  const out = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < bytes; i += 1) out[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

function pruneTokens(now = Date.now()) {
  for (const [token, entry] of tokens) {
    if (now > entry.validUntil) tokens.delete(token);
  }
}

/**
 * Mint a token. It is *displayed* for TOKEN_REFRESH_SECONDS but *accepted* for
 * an extra TOKEN_GRACE_SECONDS, so someone who scans just before a refresh
 * still has time to sign in and choose a meeting.
 */
function mintToken(now = Date.now()) {
  pruneTokens(now);
  const token = randomHex(16);
  tokens.set(token, {
    issuedAt: now,
    displayUntil: now + TOKEN_REFRESH_SECONDS * 1000,
    validUntil: now + (TOKEN_REFRESH_SECONDS + TOKEN_GRACE_SECONDS) * 1000,
  });
  currentToken = token;
  return token;
}

/** Returns "ok" | "unknown" | "expired". Does not consume the token. */
function checkToken(token, now = Date.now()) {
  const entry = typeof token === "string" ? tokens.get(token) : undefined;
  if (!entry) return "unknown";
  if (now > entry.validUntil) {
    tokens.delete(token);
    return "expired";
  }
  return "ok";
}

/* ------------------------------------------------------------------- URLs */

function toQueryString(params) {
  if (!params || typeof params !== "object") {
    return "";
  }

  return Object.keys(params)
    .reduce((acc, key) => {
      const value = params[key];

      // Skip undefined values (matches standard query builder behavior)
      if (value === undefined) {
        return acc;
      }

      // Helper to encode keys and values, converting %20 to + to match URLSearchParams.toString()
      const encode = (str) => encodeURIComponent(str).replace(/%20/g, "+");
      const encodedKey = encode(key);

      // Handle arrays (e.g., { tag: ['js', 'web'] } -> "tag=js&tag=web")
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item !== undefined) {
            acc.push(`${encodedKey}=${encode(item === null ? "" : item)}`);
          }
        });
      } else {
        // Handle null as empty string, or convert primitives to string
        const formattedValue = value === null ? "" : value;
        acc.push(`${encodedKey}=${encode(formattedValue)}`);
      }

      return acc;
    }, [])
    .join("&");
}

function buildWidgetUrl() {
  const entry = tokens.get(currentToken);
  const paramsString = toQueryString({
    app: WEBAPP_URL,
    e: JOIN_ENDPOINT,
    m: MESSAGE_TYPE,
    v: String(MESSAGE_VERSION),
    d: identity.deviceId,
    n: identity.deviceName,
    t: currentToken,
    x: String(Math.floor(entry.validUntil / 1000)),
    s: String(Math.floor(entry.displayUntil / 1000)),
    title: WIDGET_TITLE,
    sub: WIDGET_SUBTITLE,
  });
  return `${WIDGET_URL}#${paramsString}`;
}

/**
 * The URL the widget encodes in its QR code (same keys and order as
 * widget/lib.js buildScanUrl). Only used for debug logging.
 */
function buildScanUrl() {
  const entry = tokens.get(currentToken);
  const values = {
    d: identity.deviceId,
    n: identity.deviceName,
    t: currentToken,
    x: String(Math.floor(entry.validUntil / 1000)),
    e: JOIN_ENDPOINT,
    m: MESSAGE_TYPE,
    v: String(MESSAGE_VERSION),
  };
  // Like the widget, omit empty values.
  for (const key of Object.keys(values)) {
    if (!values[key]) delete values[key];
  }
  return `${WEBAPP_URL}#${toQueryString(values)}`;
}

function debugLog(...args) {
  if (DEBUG) console.log(`${MACRO_NAME} [debug]:`, ...args);
}

/* ------------------------------------------------------------ web widget */

/**
 * Save the QR web widget. Saving again with the same PanelId replaces it in
 * place, so each token refresh simply re-saves it with a new URL hash. The
 * page is never "opened" - the device renders the widget itself.
 */
async function saveWidget() {
  const entry = tokens.get(currentToken);
  if (!entry || Date.now() > entry.displayUntil) mintToken();
  const widgetUrl = buildWidgetUrl();
  if (DEBUG) {
    debugLog(`QR scan URL: ${buildScanUrl()}`);
    debugLog(`widget URL: ${widgetUrl}`);
  }
  try {
    await xapi.Command.UserInterface.Extensions.WebWidget.Save({
      Name: WIDGET_NAME,
      PanelId: MACRO_NAME,
      URL: widgetUrl,
    });
  } catch (error) {
    console.error(`${MACRO_NAME}: failed to save web widget`, error);
  }
}

function scheduleRotation() {
  clearTimeout(rotateTimer);
  rotateTimer = setTimeout(rotate, TOKEN_REFRESH_SECONDS * 1000);
  // Let a test runner exit; a no-op on the device.
  rotateTimer?.unref?.();
}

async function rotate() {
  mintToken();
  scheduleRotation();
  await saveWidget();
}

/* ---------------------------------------------------------------- alerts */

async function alertUser(Title, Text, Duration = 10) {
  try {
    await xapi.Command.UserInterface.Message.Alert.Display({
      Title,
      Text,
      Duration,
    });
  } catch (error) {
    console.error(`${MACRO_NAME}: failed to show alert`, error);
  }
}

/* ------------------------------------------------------------ join logic */

function parseMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  if (msg.type !== MESSAGE_TYPE) return null; // not for us - ignore silently
  return msg;
}

/** A destination is a SIP URI, E.164-ish number or https meeting link. */
function isValidDestination(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v.length > MAX_DESTINATION_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(v)) return false;
  return /^(https:\/\/|sip:|webex:|[A-Za-z0-9._+-]+@|\+?[0-9*#]{3,})/i.test(v);
}

async function activeCalls() {
  try {
    return Number(await xapi.Status.SystemUnit.State.NumberOfActiveCalls.get());
  } catch {
    return 0;
  }
}

/**
 * Validate and act on a `Message Send` payload. Resolves with a result code so
 * tests (and logs) can see what happened; the user always gets an on-device
 * alert for failures and a confirmation for success.
 */
async function handleJoinMessage(raw) {
  const msg = parseMessage(raw);
  if (!msg) return "ignored";

  if (msg.v !== MESSAGE_VERSION) {
    await alertUser("Join failed", "Unsupported request. Please scan again.");
    return "bad-version";
  }
  if (msg.deviceId && msg.deviceId !== identity.deviceId) {
    console.warn(`${MACRO_NAME}: message for a different device`);
    return "wrong-device";
  }

  const status = checkToken(msg.token);
  if (status !== "ok") {
    await alertUser(
      "QR code expired",
      "That QR code is no longer valid. Please scan the new code on the screen and try again.",
    );
    return `token-${status}`;
  }

  if (!isValidDestination(msg.destination)) {
    await alertUser("Join failed", "The meeting details were not valid.");
    return "bad-destination";
  }

  if ((await activeCalls()) > 0) {
    await alertUser(
      "Device is in a call",
      "Another call is already in progress. Please try again once it ends.",
    );
    return "busy";
  }

  // Single use: consume before joining so a replay cannot place a 2nd call.
  tokens.delete(msg.token);
  mintToken();
  saveWidget().catch(() => {});

  const who = typeof msg.user === "string" ? msg.user.slice(0, 64) : "";
  const { command, args } = joinCommand(msg);
  try {
    await command(args);
  } catch (error) {
    console.error(`${MACRO_NAME}: join failed`, error);
    await alertUser("Join failed", "The device could not join that meeting.");
    return "join-failed";
  }

  await alertUser(
    "Joining meeting",
    msg.title ? `${msg.title}${who ? ` - ${who}` : ""}` : who || "Connecting…",
    5,
  );
  sendPins(msg);
  return "joined";
}

/**
 * Pick the xAPI command for a meeting type. Webex meeting links use
 * `Webex Join`; everything else (SIP/H.323 addresses such as Zoom's
 * `<id>@zoomcrc.com`, Teams and Google Meet links) goes through `Dial`.
 */
function joinCommand(msg) {
  const destination = msg.destination.trim();
  const type = MEETING_TYPES.includes(msg.meetingType)
    ? msg.meetingType
    : "webex";
  if (type === "webex" && /^https:\/\//i.test(destination)) {
    return {
      command: (args) => xapi.Command.Webex.Join(args),
      args: { Number: destination },
    };
  }
  return {
    command: (args) => xapi.Command.Dial(args),
    args: { Number: destination },
  };
}

/** Host/guest PINs are sent as DTMF once the far end has had time to answer. */
function sendPins(msg) {
  const pin = [msg.hostPin, msg.guestPin].find(
    (p) => typeof p === "string" && PIN_DIGITS.test(p),
  );
  if (!pin) return;
  const digits = /[#]$/.test(pin) ? pin : `${pin}#`;
  setTimeout(() => {
    xapi.Command.Call.DTMFSend({ DTMFString: digits }).catch((error) =>
      console.error(`${MACRO_NAME}: DTMF failed`, error),
    );
  }, DTMF_DELAY_MS);
}

/* ------------------------------------------------------------------ init */

async function readIdentity() {
  const read = async (path) => {
    try {
      return String((await path.get()) ?? "");
    } catch {
      return "";
    }
  };
  identity = {
    // Only present when the device is Webex registered.
    deviceId: await read(xapi.Status.Webex.DeveloperId),
    deviceName: await read(xapi.Status.UserInterface.ContactInfo.Name),
  };
  if (!identity.deviceId) {
    console.warn(
      `${MACRO_NAME}: Status.Webex.DeveloperId is empty - is this device Webex registered?`,
    );
  }
}

async function init() {
  await readIdentity();
  if (!JOIN_ENDPOINT) {
    console.warn(`${MACRO_NAME}: JOIN_ENDPOINT is empty - scans cannot join`);
  }
  // Subscribe at Message.Send (not .Text) - the event object carries { Text }.
  xapi.Event.Message.Send.on((event) =>
    handleJoinMessage(event?.Text ?? "").then((result) =>
      console.log(`${MACRO_NAME}: message result: ${result}`),
    ),
  );

  mintToken();
  scheduleRotation();
  await saveWidget();
  console.log(`${MACRO_NAME}: started (device ${identity.deviceName || "?"})`);
}

init();

export {
  JOIN_ENDPOINT,
  WIDGET_URL,
  WEBAPP_URL,
  saveWidget,
  rotate,
  joinCommand,
  handleJoinMessage,
  mintToken,
  checkToken,
  buildWidgetUrl,
  isValidDestination,
};
