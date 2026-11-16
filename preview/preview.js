/* Shared helpers for the preview pages (screenshots only). */

/** Scale the fixed-size .stage to fit the window width. */
export function fitStage() {
  const stage = document.querySelector(".stage");
  const fit = () => {
    const scale = window.innerWidth / stage.offsetWidth;
    stage.style.transform = `scale(${scale})`;
  };
  fit();
  window.addEventListener("resize", fit);
}

/** "#theme=light|dark" as used by the other pages. */
export function theme() {
  const value = new URLSearchParams(location.hash.slice(1)).get("theme");
  const chosen = value === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = chosen;
  return chosen;
}

const PAGES = "https://wxsd-sales.github.io/qr-meeting-join";

/** Mock scan values; expiries are relative to now so nothing looks expired. */
export function scanParams(extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new URLSearchParams({
    d: "Y2lzY29zcGFyazovL3VzL0RFVklDRS9kZW1v",
    n: "Springwise",
    t: "3f9c0d7a5b8e4c1a9d2f6e8b7a4c1d05",
    x: String(now + 220),
    e: "https://hooks.example.com/join",
    m: "qr-join",
    v: "1",
    ...extra,
  });
}

/** URL of the widget page, as the macro would save it on the device. */
export function widgetUrl() {
  const params = scanParams({
    app: `${PAGES}/webapp/`,
    s: String(Math.floor(Date.now() / 1000) + 100),
    title: "Join your meeting",
    sub: "Scan with your phone camera",
  });
  return `../widget/#${params}`;
}

/** URL of the phone web app with a scan, optionally in demo mode. */
export function webappUrl({ demo = false, themeName = "dark" } = {}) {
  const hash = `${scanParams()}&theme=${themeName}`;
  return `../webapp/${demo ? "?demo=meetings" : ""}#${hash}`;
}
