/*
 * Calendar events through the Webex JS SDK, loaded from a CDN only after the
 * user signs in. The REST /meetings API returns Webex meetings only; the SDK's
 * calendar service also returns events from the user's connected calendar,
 * including Zoom, Teams and Google Meet invites.
 *
 * The SDK needs the spark:kms scope (and typically spark:all) in addition to
 * the REST scopes - see webapp/config.js.
 */

const SDK_URL = "https://cdn.jsdelivr.net/npm/webex@3.12.0/umd/webex.min.js";
const READY_TIMEOUT_MS = 20000;

let sdkPromise = null;
let webexPromise = null;
let webexToken = "";

function loadSdk() {
  if (window.Webex) return Promise.resolve(window.Webex);
  sdkPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SDK_URL;
    script.crossOrigin = "anonymous";
    script.onload = () =>
      window.Webex
        ? resolve(window.Webex)
        : reject(new Error("Webex SDK failed to initialise"));
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("Could not load the Webex SDK"));
    };
    document.head.append(script);
  });
  return sdkPromise;
}

async function getWebex(accessToken) {
  if (webexPromise && webexToken === accessToken) return webexPromise;
  webexToken = accessToken;
  webexPromise = (async () => {
    const Webex = await loadSdk();
    const webex = Webex.init({ credentials: { access_token: accessToken } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The Webex SDK did not become ready")),
        READY_TIMEOUT_MS,
      );
      webex.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // The calendar service URL comes from the service catalog, which needs a
    // registered device.
    await webex.internal.device.register();
    await webex.internal.services.waitForCatalog("postauth", 20);
    return webex;
  })();
  webexPromise.catch(() => {
    webexPromise = null;
  });
  return webexPromise;
}

/** Raw (decrypted) calendar events from `from` to `to` (epoch ms). */
export async function listCalendarEvents(accessToken, { from, to }) {
  const webex = await getWebex(accessToken);
  const events = await webex.internal.calendar.list({
    fromDate: new Date(from).toISOString(),
    toDate: new Date(to).toISOString(),
  });
  return Array.isArray(events) ? events : [];
}

/**
 * Full details of a Webex meeting (password, video-system password, dial-in
 * numbers) - the same request the Webex web app makes. `request` comes from
 * meetingInfoRequest() in lib.js.
 */
export async function getMeetingInfo(accessToken, request) {
  const webex = await getWebex(accessToken);
  const response = await webex.request({
    method: "POST",
    uri: request.uri,
    body: request.body,
  });
  return response.body;
}

/**
 * The invitation body (agenda/notes) of a calendar event, as plain text or
 * HTML. The calendar service keeps it separate from the event list. The SDK
 * normally decrypts it; if it arrives encrypted we decrypt it here.
 */
export async function getEventNotes(accessToken, event) {
  const webex = await getWebex(accessToken);
  const response = await webex.internal.calendar.getNotes(event.id);
  const body = response?.body ?? response ?? {};
  const raw = body.encryptedNotes ?? body.notes ?? "";
  if (typeof raw !== "string" || !raw) return "";
  const keyUrl = body.encryptionKeyUrl ?? event.encryptionKeyUrl;
  if (keyUrl) {
    try {
      return await webex.internal.encryption.decryptText(keyUrl, raw);
    } catch {
      /* already plain text */
    }
  }
  return raw;
}
