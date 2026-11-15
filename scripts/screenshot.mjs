import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";
import { startStaticServer } from "./server.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "assets");
const WIDTH = Number(process.env.SCREENSHOT_WIDTH) || 1280;
const HEIGHT = Number(process.env.SCREENSHOT_HEIGHT) || 800;

function isExecutable(candidate) {
  if (candidate.includes("/") || candidate.includes("\\")) {
    return existsSync(candidate);
  }
  const probe = spawnSync(platform() === "win32" ? "where" : "which", [
    candidate,
  ]);
  return probe.status === 0;
}

function resolveChrome() {
  if (process.env.CHROME_BIN) {
    if (isExecutable(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
    throw new Error(
      `CHROME_BIN is set but not executable: ${process.env.CHROME_BIN}`,
    );
  }

  const candidatesByPlatform = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    linux: [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "chrome",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  };

  const candidates = candidatesByPlatform[platform()] ?? [];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    "Could not find a headless Chrome/Chromium binary. Install Google Chrome or set CHROME_BIN to its path.",
  );
}

// Chrome writes a lot of harmless native-side noise to stderr in headless
// mode (e.g. macOS display-link warnings when there's no real display, or
// allocator-shim notices) even on a fully successful capture. These patterns
// are filtered out of successful runs so real problems aren't buried; a
// failed run still prints stderr in full, unfiltered.
const BENIGN_STDERR_PATTERNS = [
  /CVDisplayLinkCreateWithCGDisplay failed/,
  /Trying to load the allocator multiple times/,
  /task_policy_set TASK_(CATEGORY|SUPPRESSION)_POLICY/,
];

function capture(chromeBin, url, outPath, { width, height }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      `--window-size=${width},${height}`,
      "--virtual-time-budget=2500",
      `--screenshot=${outPath}`,
      url,
    ];
    const child = spawn(chromeBin, args, {
      stdio: ["ignore", "inherit", "pipe"],
    });
    let stderr = "";
    // Never let a stuck Chrome hang the script (or CI).
    const killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out capturing ${url}`));
    }, 60_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        const relevant = stderr
          .split("\n")
          .filter(
            (line) =>
              line.trim() &&
              !BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line)),
          );
        if (relevant.length) console.error(relevant.join("\n"));
        resolvePromise();
        return;
      }
      if (stderr.trim()) console.error(stderr);
      reject(
        new Error(`Chrome exited with code ${code} while capturing ${url}`),
      );
    });
  });
}

const chromeBin = resolveChrome();
mkdirSync(OUT_DIR, { recursive: true });

// Mock values so the captures show what a real scan would look like. The QR
// code encodes these, pointing at the web app.
// Expiries are relative to now so the widget's countdown looks realistic
// (about 1:40 left until refresh) and the web app does not show "expired".
const nowSeconds = Math.floor(Date.now() / 1000);
const demoScan = {
  d: "Y2lzY29zcGFyazovL3VzL0RFVklDRS9kZW1v",
  n: "Meeting Room 1234",
  t: "3f9c0d7a5b8e4c1a9d2f6e8b7a4c1d05",
  x: String(nowSeconds + 220),
  e: "https://hooks.example.com/join",
};
const encode = (values) => `${new URLSearchParams(values)}&`;

// Force each theme via the "#theme=" hash so captures are deterministic and do
// not depend on the CI runner's OS colour-scheme preference. The widget is
// always dark (RoomOS always renders web widgets with a dark UI) and 600x600,
// the size the device renders web widgets at.
const targets = [
  {
    path: "/wizard/",
    name: "wizard",
    hash: "",
    themes: ["light", "dark"],
    size: { width: WIDTH, height: HEIGHT },
  },
];
if (existsSync(join(ROOT, "widget", "index.html"))) {
  targets.push({
    path: "/widget/",
    name: "widget",
    hash: encode({
      app: "https://wxsd-sales.github.io/qr-meeting-join/webapp/",
      ...demoScan,
      s: String(nowSeconds + 100),
      title: "Join your meeting",
      sub: "Scan with your phone camera",
    }),
    themes: ["dark"],
    size: { width: 600, height: 600 },
  });
}
if (existsSync(join(ROOT, "webapp", "index.html"))) {
  targets.push({
    path: "/webapp/",
    name: "webapp",
    hash: encode(demoScan),
    themes: ["light", "dark"],
    // Phone-shaped (headless Chrome will not go narrower than ~500px).
    size: { width: 500, height: 800 },
  });
}

const { url, close } = await startStaticServer({ root: ROOT, port: 0 });
try {
  for (const target of targets) {
    for (const theme of target.themes) {
      const outName = `${target.name}-${theme}.png`;
      const outPath = join(OUT_DIR, outName);
      await capture(
        chromeBin,
        `${url}${target.path}#${target.hash}theme=${theme}`,
        outPath,
        target.size,
      );
      console.log(`Captured ${outName}`);
    }
  }
} finally {
  await close();
}
