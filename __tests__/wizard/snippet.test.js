import { describe, expect, test } from "@jest/globals";
import { buildSnippet, injectConfig } from "../../wizard/snippet.js";

describe("buildSnippet", () => {
  test("emits CONFIG markers with JSON-encoded values", () => {
    const snippet = buildSnippet({
      name: "qr-meeting-join",
      widgetUrl: "https://example.github.io/qr-meeting-join/widget/",
      webappUrl: "https://example.github.io/qr-meeting-join/webapp/",
      joinEndpoint: "https://hooks.example.com/join",
      tokenRefreshSeconds: 90,
      tokenGraceSeconds: 45,
      widgetTitle: "Hi",
      widgetSubtitle: "Scan",
    });
    expect(snippet).toBe(
      [
        "// CONFIG:start",
        'const MACRO_NAME = "qr-meeting-join";',
        'const WIDGET_URL = "https://example.github.io/qr-meeting-join/widget/";',
        'const WEBAPP_URL = "https://example.github.io/qr-meeting-join/webapp/";',
        'const JOIN_ENDPOINT = "https://hooks.example.com/join";',
        "const TOKEN_REFRESH_SECONDS = 90;",
        "const TOKEN_GRACE_SECONDS = 45;",
        'const WIDGET_TITLE = "Hi";',
        'const WIDGET_SUBTITLE = "Scan";',
        "// CONFIG:end",
      ].join("\n"),
    );
  });

  test("safely encodes quotes in values", () => {
    const snippet = buildSnippet({ name: 'a"b', webappUrl: "" });
    expect(snippet).toContain('const MACRO_NAME = "a\\"b";');
  });

  test("defaults missing values to empty strings", () => {
    const snippet = buildSnippet();
    expect(snippet).toContain('const MACRO_NAME = "";');
    expect(snippet).toContain("const TOKEN_REFRESH_SECONDS = 120;");
  });

  test("clamps nonsense token timings back to defaults", () => {
    const snippet = buildSnippet({
      tokenRefreshSeconds: "abc",
      tokenGraceSeconds: 1,
    });
    expect(snippet).toContain("const TOKEN_REFRESH_SECONDS = 120;");
    expect(snippet).toContain("const TOKEN_GRACE_SECONDS = 120;");
  });

  test("has no home-screen button settings", () => {
    const snippet = buildSnippet();
    expect(snippet).not.toContain("BUTTON");
    expect(snippet).toContain('const JOIN_ENDPOINT = "";');
  });
});

describe("injectConfig", () => {
  const macro = [
    'import xapi from "xapi";',
    "// CONFIG:start",
    'const MACRO_NAME = "old";',
    'const WEBAPP_URL = "old";',
    'const JOIN_ENDPOINT = "old";',
    "// CONFIG:end",
    "init();",
    "",
  ].join("\n");

  test("replaces the block and preserves surrounding code", () => {
    const next = injectConfig(macro, {
      name: "new",
      webappUrl: "https://new/",
      joinEndpoint: "https://new/hook",
    });
    expect(next).toContain('const MACRO_NAME = "new";');
    expect(next).toContain('const JOIN_ENDPOINT = "https://new/hook";');
    expect(next.startsWith('import xapi from "xapi";')).toBe(true);
    expect(next.trimEnd().endsWith("init();")).toBe(true);
  });

  test("is idempotent", () => {
    const values = { name: "new", webappUrl: "https://new/" };
    const once = injectConfig(macro, values);
    const twice = injectConfig(once, values);
    expect(twice).toBe(once);
  });

  test("throws when the markers are missing", () => {
    expect(() => injectConfig("no markers here", { name: "x" })).toThrow();
  });
});
