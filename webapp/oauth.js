/*
 * Webex OAuth implicit grant (access token returned in the URL hash), plus
 * persistence of the last QR scan so it survives the sign-in redirect.
 */
import { parseHashParams, parseScan } from "./lib.js";

const PREFIX = "qr-meeting-join";
const key = (name) => `${PREFIX}_${name}`;
const AUTHORIZE_URL = "https://webexapis.com/v1/authorize";

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const store = {
  get: (name) => safe(() => localStorage.getItem(key(name))),
  set: (name, value) => safe(() => localStorage.setItem(key(name), value)),
  remove: (name) => safe(() => localStorage.removeItem(key(name))),
};

/* ---- pending scan ---- */

export function savePendingScan(scan) {
  store.set("pending_scan", JSON.stringify(scan));
}

export function loadPendingScan() {
  const raw = store.get("pending_scan");
  if (!raw) return null;
  try {
    const scan = JSON.parse(raw);
    return scan?.deviceId && scan?.token ? scan : null;
  } catch {
    return null;
  }
}

export function clearPendingScan() {
  store.remove("pending_scan");
}

/* ---- credentials ---- */

export function getCredentials() {
  const accessToken = store.get("access_token");
  if (!accessToken) return null;
  const expiresAt = Number(store.get("expires_at")) || 0;
  if (expiresAt && Date.now() > expiresAt) {
    clearCredentials();
    return null;
  }
  return { accessToken, expiresAt };
}

export function clearCredentials() {
  store.remove("access_token");
  store.remove("expires_at");
  store.remove("oauth_state");
}

function randomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function startLogin(config) {
  if (!config.clientId) {
    return "No Webex integration client ID is configured (see webapp/config.js).";
  }
  const state = randomState();
  store.set("oauth_state", state);
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "token",
    redirect_uri: `${location.origin}${location.pathname}`,
    scope: config.scopes.join(" "),
    state,
  });
  location.assign(`${AUTHORIZE_URL}?${params}`);
  return null;
}

/**
 * Inspect the current URL hash and classify it. Always removes sensitive
 * values (access token, scan token) from the address bar afterwards.
 *
 * @returns {{ type: "oauth"|"scan"|"none", error?: string, scan?: object }}
 */
export function consumeUrl() {
  const hash = location.hash;
  const params = parseHashParams(hash);
  const clean = () =>
    history.replaceState(null, "", location.pathname + location.search);

  if (params.has("access_token") || params.has("error")) {
    clean();
    if (params.has("error")) {
      return {
        type: "oauth",
        error: params.get("error_description") || params.get("error"),
      };
    }
    const expected = store.get("oauth_state");
    store.remove("oauth_state");
    if (!expected || expected !== params.get("state")) {
      return { type: "oauth", error: "Sign-in blocked: state mismatch." };
    }
    const expiresIn = Number(params.get("expires_in")) || 3600;
    store.set("access_token", params.get("access_token"));
    store.set("expires_at", String(Date.now() + expiresIn * 1000));
    return { type: "oauth" };
  }

  const scan = parseScan(hash);
  if (scan) {
    clean();
    savePendingScan(scan);
    return { type: "scan", scan };
  }
  return { type: "none" };
}
