/*
 * In-page QR scanner: the back camera via getUserMedia, decoded with jsQR
 * (loaded from a CDN only when scanning starts). The code is drawn on a
 * canvas each frame; jsQR also tries inverted codes because the device shows
 * a light-on-dark QR.
 */

const JSQR_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";

let loading = null;

function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JSQR_URL;
    script.crossOrigin = "anonymous";
    script.onload = () =>
      window.jsQR
        ? resolve(window.jsQR)
        : reject(new Error("QR decoder failed"));
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not load the QR decoder"));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * Start scanning into `video`. `onCode(text)` returns true once it accepts a
 * code (scanning then stops); other codes are ignored and scanning continues.
 * Resolves to a `stop()` function; rejects if the camera is unavailable.
 */
export async function startScanner(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot access the camera.");
  }
  const jsQR = await loadJsQr();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  let stopped = false;
  let frame = 0;

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const tick = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      // Downscale large frames: decoding cost grows with pixel count.
      const scale = Math.min(1, 640 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(image.data, image.width, image.height, {
        inversionAttempts: "attemptBoth",
      });
      if (result?.data && onCode(result.data)) return stop();
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return stop;
}
