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
      "--virtual-time-budget=8000",
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

// The widget and web app are captured through preview pages that wrap them the
// way they appear in real use: the widget on a RoomOS on-screen display, and
// the web app inside phone frames (see preview/). Mock values and relative
// expiries live in preview/preview.js so nothing looks expired.
//
// Each theme is forced via "#theme=" so captures are deterministic and do not
// depend on the CI runner's OS colour-scheme preference. The device preview is
// always dark (RoomOS web widgets are always rendered dark).
const targets = [
  {
    path: "/wizard/",
    name: "wizard",
    hash: "",
    themes: ["light", "dark"],
    size: { width: WIDTH, height: HEIGHT },
  },
];
if (existsSync(join(ROOT, "preview", "osd.html"))) {
  targets.push({
    path: "/preview/osd.html",
    name: "osd",
    hash: "",
    themes: ["dark"],
    size: { width: 1600, height: 900 },
  });
}
if (existsSync(join(ROOT, "preview", "phones.html"))) {
  targets.push({
    path: "/preview/phones.html",
    name: "phones",
    hash: "",
    themes: ["light", "dark"],
    size: { width: 1600, height: 1000 },
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
