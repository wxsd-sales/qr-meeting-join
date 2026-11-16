import { buildSnippet, injectConfig } from "./snippet.js";
import { BUNDLES, buildWebappConfigJs, makeZip } from "./bundle.js";

const config = window.APP_CONFIG ?? {};

// The macro source is published alongside the wizard on GitHub Pages so the
// "Download macro" action can fetch it and inject the configured values.
const MACRO_SOURCE_URL = "../macros/main.js";

/* Header: product name and source-code link derived from APP_CONFIG. */
(function initHeader() {
  const product = document.getElementById("app-product");
  const sourceLink = document.getElementById("source-link");

  if (product && config.title) {
    product.textContent = `${config.title} - Configuration Wizard`;
  }
  if (config.title) {
    document.title = `${config.title} - Wizard`;
  }
  if (sourceLink && config.repoUrl) {
    sourceLink.href = config.repoUrl;
  }
})();

/* Settings form -> live macro config snippet, macro download, bundles. */
(function initSettings() {
  const $ = (id) => document.getElementById(id);
  const output = $("output");
  const exportStatus = $("export-status");
  if (!output) return;

  const fields = {
    joinEndpoint: $("join-endpoint"),
    widgetTitle: $("widget-title"),
    widgetSubtitle: $("widget-subtitle"),
    tokenRefreshSeconds: $("refresh-seconds"),
    tokenGraceSeconds: $("grace-seconds"),
    widgetUrl: $("widget-url"),
    webappUrl: $("webapp-url"),
    debug: $("debug"),
  };

  fields.widgetTitle.value = config.widgetTitle ?? "";
  fields.widgetSubtitle.value = config.widgetSubtitle ?? "";
  fields.tokenRefreshSeconds.value = config.tokenRefreshSeconds ?? 120;
  fields.tokenGraceSeconds.value = config.tokenGraceSeconds ?? 120;
  fields.widgetUrl.value = config.widgetUrl ?? "";
  fields.webappUrl.value = config.webappUrl ?? "";
  fields.debug.checked = config.debug === true;

  const getValues = () => ({
    name: config.name ?? "",
    joinEndpoint: fields.joinEndpoint.value.trim(),
    widgetTitle: fields.widgetTitle.value,
    widgetSubtitle: fields.widgetSubtitle.value,
    tokenRefreshSeconds: fields.tokenRefreshSeconds.value,
    tokenGraceSeconds: fields.tokenGraceSeconds.value,
    widgetUrl: fields.widgetUrl.value.trim(),
    webappUrl: fields.webappUrl.value.trim(),
    debug: fields.debug.checked,
  });

  const setExportStatus = (message, kind = "") => {
    if (!exportStatus) return;
    exportStatus.textContent = message;
    if (kind) exportStatus.dataset.kind = kind;
    else delete exportStatus.dataset.kind;
  };

  const save = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const endpointProblem = () => {
    const value = fields.joinEndpoint.value.trim();
    if (!value) return "Set a join endpoint or scans will not be able to join.";
    try {
      const url = new URL(value);
      const local = ["localhost", "127.0.0.1"].includes(url.hostname);
      if (url.protocol === "https:" || (local && url.protocol === "http:")) {
        return "";
      }
    } catch {
      /* fall through */
    }
    return "The join endpoint must be a valid https:// URL.";
  };

  const updatePreview = () => {
    const problem = endpointProblem();
    setExportStatus(problem, problem ? "error" : "");
    // textContent (never innerHTML) so user input is treated as text.
    output.textContent = buildSnippet(getValues());
  };

  Object.values(fields).forEach((el) =>
    el.addEventListener("input", updatePreview),
  );
  updatePreview();

  $("payload-toggle")?.addEventListener("click", () => {
    const toggle = $("payload-toggle");
    const panel = $("payload-example");
    const show = panel.hidden;
    panel.hidden = !show;
    toggle.setAttribute("aria-expanded", String(show));
    toggle.textContent = show ? "Hide payload" : "Show expected join payload";
  });

  $("copy-button")?.addEventListener("click", async () => {
    const button = $("copy-button");
    try {
      await navigator.clipboard.writeText(output.textContent);
    } catch {
      setExportStatus("Clipboard access was blocked by the browser.", "error");
      return;
    }
    const label = button.querySelector(".icon-button__label");
    const icon = button.querySelector(".icon");
    const previous = label.textContent;
    label.textContent = "Copied";
    icon.classList.replace("icon-copy-bold", "icon-check-circle-bold");
    window.setTimeout(() => {
      label.textContent = previous;
      icon.classList.replace("icon-check-circle-bold", "icon-copy-bold");
    }, 1600);
  });

  $("download-button")?.addEventListener("click", async () => {
    setExportStatus("");
    let macro;
    try {
      const response = await fetch(MACRO_SOURCE_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      macro = injectConfig(await response.text(), getValues());
    } catch {
      setExportStatus(
        "Could not build the macro. Use Copy config instead.",
        "error",
      );
      return;
    }
    const base =
      (config.name || "macro")
        .replace(/[^a-zA-Z0-9-_]+/g, "-")
        .replace(/^-+|-+$/g, "") || "macro";
    save(new Blob([macro], { type: "text/javascript" }), `${base}.js`);
    setExportStatus(`Downloaded ${base}.js.`, "success");
  });

  async function downloadBundle(kind) {
    setExportStatus("");
    const spec = BUNDLES[kind];
    try {
      const files = await Promise.all(
        spec.files.map(async (name) => {
          if (kind === "webapp" && name === "config.js") {
            return {
              name,
              data: new TextEncoder().encode(
                buildWebappConfigJs({
                  clientId: $("client-id").value.trim(),
                }),
              ),
            };
          }
          const response = await fetch(`../${spec.dir}/${name}`, {
            cache: "no-store",
          });
          if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
          return { name, data: new Uint8Array(await response.arrayBuffer()) };
        }),
      );
      save(new Blob([makeZip(files)], { type: "application/zip" }), spec.zip);
      setExportStatus(`Downloaded ${spec.zip}.`, "success");
    } catch (error) {
      setExportStatus(`Could not build the bundle: ${error.message}`, "error");
    }
  }
  $("download-widget")?.addEventListener("click", () =>
    downloadBundle("widget"),
  );
  $("download-webapp")?.addEventListener("click", () =>
    downloadBundle("webapp"),
  );
})();

/*
 * Theme selector: toggles the menu and applies System / Light / Dark themes.
 * Light/Dark persist via the URL hash (read by the inline boot script), while
 * System clears the hash and follows the OS preference.
 */
(function initThemeSelect() {
  const root = document.documentElement;
  const select = document.getElementById("theme-select");
  const button = document.getElementById("theme-select-button");
  const menu = document.getElementById("theme-select-menu");
  const label = document.getElementById("theme-select-label");
  const currentIcon = document.getElementById("theme-select-current-icon");

  if (!select || !button || !menu || !label || !currentIcon) {
    return;
  }

  const options = Array.from(menu.querySelectorAll(".theme-select-option"));

  const META = {
    system: { label: "System", icon: "icon-laptop-regular" },
    light: { label: "Light", icon: "icon-brightness-high-filled" },
    dark: { label: "Dark", icon: "icon-quiet-hours-presence-filled" },
  };
  const ICON_CLASSES = Object.values(META).map((meta) => meta.icon);

  const readChoice = () => {
    const raw = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const theme = raw ? new URLSearchParams(raw).get("theme") : null;
    return theme === "light" || theme === "dark" ? theme : "system";
  };

  const applyTheme = (choice) => {
    const dark =
      choice === "dark" ||
      (choice === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    root.classList.remove(
      "mds-theme-stable-lightWebex",
      "mds-theme-stable-darkWebex",
    );
    root.classList.add(
      dark ? "mds-theme-stable-darkWebex" : "mds-theme-stable-lightWebex",
    );
    root.style.colorScheme = dark ? "dark" : "light";
  };

  const syncButton = (choice) => {
    const meta = META[choice] || META.system;
    label.textContent = meta.label;
    currentIcon.classList.remove(...ICON_CLASSES);
    currentIcon.classList.add(meta.icon);
    options.forEach((option) => {
      option.setAttribute(
        "aria-selected",
        String(option.dataset.themeChoice === choice),
      );
    });
  };

  const setChoice = (choice) => {
    if (choice === "system") {
      history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    } else {
      window.location.hash = "theme=" + choice;
    }
    applyTheme(choice);
    syncButton(choice);
  };

  const openMenu = () => {
    menu.hidden = false;
    select.dataset.open = "true";
    button.setAttribute("aria-expanded", "true");
  };

  const closeMenu = () => {
    menu.hidden = true;
    select.dataset.open = "false";
    button.setAttribute("aria-expanded", "false");
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) {
      openMenu();
    } else {
      closeMenu();
    }
  });

  options.forEach((option) => {
    option.addEventListener("click", () => {
      setChoice(option.dataset.themeChoice);
      closeMenu();
      button.focus();
    });
  });

  document.addEventListener("click", (event) => {
    if (!select.contains(event.target)) {
      closeMenu();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      closeMenu();
      button.focus();
    }
  });

  syncButton(readChoice());
})();

/* Tab list: toggles which panel is visible. */
(function initTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  if (!tabs.length) {
    return;
  }

  const activate = (tab) => {
    tabs.forEach((current) => {
      const selected = current === tab;
      current.setAttribute("aria-selected", String(selected));
      current.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(current.dataset.tabTarget);
      if (panel) {
        panel.hidden = !selected;
      }
    });
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
        return;
      }
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      next.focus();
      activate(next);
    });
  });
})();
