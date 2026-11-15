import {
  buildScanUrl,
  formatCountdown,
  parseHash,
  qrColors,
  resolveTheme,
  secondsLeft,
} from "./lib.js";

// qrcode@1.5.4's "lib/browser.min.js" is unbundled CommonJS (it require()s its
// own modules) and cannot run in a page; jsDelivr's "+esm" build of the same
// version is the browser-ready bundle.
const QRCODE_URL = "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";
let qrcodeModule = null;
async function loadQrCode() {
  qrcodeModule ??= import(QRCODE_URL);
  try {
    return await qrcodeModule;
  } catch (error) {
    qrcodeModule = null; // allow a retry on the next refresh
    throw error;
  }
}

const $ = (id) => document.getElementById(id);
let timer = null;

function showError(message) {
  const el = $("error");
  el.textContent = message;
  el.hidden = !message;
  $("qr-frame").hidden = Boolean(message);
}

function tick(showUntil) {
  const left = secondsLeft(showUntil);
  $("countdown").textContent =
    left === null ? "" : `Refreshes in ${formatCountdown(left)}`;
}

async function render() {
  const params = parseHash(window.location.hash);
  const theme = resolveTheme(params);
  document.documentElement.dataset.theme = theme;
  $("title").textContent = params.get("title") || "Join your meeting";
  $("subtitle").textContent = params.get("sub") || "";

  clearInterval(timer);
  const url = buildScanUrl(params);
  if (!url) {
    showError("Waiting for the macro to provide a device ID and token.");
    return;
  }
  let QRCode;
  try {
    QRCode = await loadQrCode();
  } catch {
    showError("The QR code library failed to load (check network access).");
    return;
  }
  try {
    await QRCode.toCanvas($("qr"), url, {
      width: 600,
      margin: 2,
      color: qrColors(theme, params),
      errorCorrectionLevel: "M",
    });
    showError("");
  } catch (error) {
    showError(`Could not generate QR code: ${error?.message ?? error}`);
    return;
  }

  const showUntil = params.get("s");
  tick(showUntil);
  timer = setInterval(() => tick(showUntil), 1000);
}

// The macro refreshes the token by re-saving the web widget with a new URL
// hash, so re-render on either a fresh load or a hash change.
window.addEventListener("hashchange", render);
render();
