/*
 * Pure helpers shared by the wizard UI and the unit tests. Keeping these free of DOM access means they can be imported directly
 * in Node and in the browser as an ES module.
 */

export const CONFIG_START = "// CONFIG:start";
export const CONFIG_END = "// CONFIG:end";

export const DEFAULTS = {
  tokenRefreshSeconds: 120,
  tokenGraceSeconds: 120,
  widgetTitle: "Join your meeting",
  widgetSubtitle: "Scan with your phone camera",
  debug: false,
};

function seconds(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 10 ? Math.min(n, 3600) : fallback;
}

/**
 * Build the CONFIG block (markers included) for the given values.
 */
export function buildSnippet({
  name = "",
  widgetUrl = "",
  webappUrl = "",
  joinEndpoint = "",
  tokenRefreshSeconds = DEFAULTS.tokenRefreshSeconds,
  tokenGraceSeconds = DEFAULTS.tokenGraceSeconds,
  widgetTitle = DEFAULTS.widgetTitle,
  widgetSubtitle = DEFAULTS.widgetSubtitle,
  debug = DEFAULTS.debug,
} = {}) {
  return [
    CONFIG_START,
    `const MACRO_NAME = ${JSON.stringify(name)};`,
    `const WIDGET_URL = ${JSON.stringify(widgetUrl)};`,
    `const WEBAPP_URL = ${JSON.stringify(webappUrl)};`,
    `const JOIN_ENDPOINT = ${JSON.stringify(joinEndpoint)};`,
    `const TOKEN_REFRESH_SECONDS = ${seconds(tokenRefreshSeconds, DEFAULTS.tokenRefreshSeconds)};`,
    `const TOKEN_GRACE_SECONDS = ${seconds(tokenGraceSeconds, DEFAULTS.tokenGraceSeconds)};`,
    `const WIDGET_TITLE = ${JSON.stringify(widgetTitle)};`,
    `const WIDGET_SUBTITLE = ${JSON.stringify(widgetSubtitle)};`,
    `const DEBUG = ${debug === true || debug === "true"};`,
    CONFIG_END,
  ].join("\n");
}

/**
 * Replace the CONFIG block inside an existing macro source with fresh values,
 * preserving everything around the markers. Idempotent.
 */
export function injectConfig(source, values) {
  const startIdx = source.indexOf(CONFIG_START);
  const endIdx = source.indexOf(CONFIG_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error(
      "Could not find the CONFIG:start / CONFIG:end markers in the macro source.",
    );
  }
  const before = source.slice(0, startIdx);
  const after = source.slice(endIdx + CONFIG_END.length);
  return `${before}${buildSnippet(values)}${after}`;
}
