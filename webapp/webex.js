/* Minimal Webex REST client (GET + pagination + 429 retry). */

const BASE = "https://webexapis.com/v1";

export class WebexError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(accessToken, url, attempt = 1) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 429 && attempt < 3) {
    const wait = Math.max(1, Number(response.headers.get("Retry-After")) || 1);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return request(accessToken, url, attempt + 1);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      message = (await response.json())?.message || message;
    } catch {
      /* non-JSON error body */
    }
    throw new WebexError(message, response.status);
  }
  return response;
}

async function paginate(accessToken, path, params) {
  let url = `${BASE}${path}?${new URLSearchParams(params)}`;
  const items = [];
  for (let page = 0; url && page < 10; page += 1) {
    const response = await request(accessToken, url);
    items.push(...((await response.json()).items ?? []));
    url =
      response.headers
        .get("Link")
        ?.match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1] ?? null;
  }
  return items;
}

export const getMe = async (accessToken) =>
  (await request(accessToken, `${BASE}/people/me`)).json();

/**
 * Meetings starting within the next `hoursAhead` hours plus any in progress.
 * Meetings synced from Exchange/Microsoft 365/Google via Hybrid Calendar are
 * expected to appear here when the user has a Webex-enabled invite; the
 * parser also scans location/agenda text for Zoom, Teams and Meet links.
 */
export async function listMeetings(accessToken, { hoursAhead = 24 } = {}) {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const [upcoming, live] = await Promise.all([
    paginate(accessToken, "/meetings", {
      meetingType: "scheduledMeeting",
      from: iso(now - 15 * 60 * 1000),
      to: iso(now + hoursAhead * 3600 * 1000),
      max: "100",
    }),
    paginate(accessToken, "/meetings", {
      meetingType: "meeting",
      state: "inProgress",
      max: "100",
    }).catch(() => []),
  ]);
  return [...live, ...upcoming];
}

/** The signed-in user's Personal Meeting Room (needs meeting:preferences_read). */
export async function getPersonalRoom(accessToken) {
  return (
    await request(accessToken, `${BASE}/meetingPreferences/personalMeetingRoom`)
  ).json();
}
