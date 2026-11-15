import xapi from "xapi";

/*
 * Example Cisco RoomOS macro.
 *
 * Optionally adds a home-screen button that opens the project's web app in a
 * WebView so the macro can offer richer functionality than the on-device UI
 * extensions alone - not every macro needs one, so this is skipped entirely
 * when HAS_BUTTON is false. Paste this file into the device Macro Editor, or
 * deploy it with your preferred tooling.
 *
 * The values between the CONFIG markers are managed by `npm run apply-config`
 * (driven by project.config.json) - do not edit them by hand. MACRO_NAME is
 * the project's identity (used for the panel id and log lines); BUTTON_NAME
 * is the human-facing label shown on the device.
 */

// CONFIG:start
const MACRO_NAME = "my-macro";
const WEBAPP_URL = "https://wxsd-sales.github.io/my-macro/webapp/";
const HAS_BUTTON = true;
const BUTTON_NAME = "My Macro";
// CONFIG:end

const PANEL_ID = `${MACRO_NAME}-open`;

async function openWebApp({ Origin, PeripheralId }) {
  const args = {
    Url: WEBAPP_URL,
    Title: BUTTON_NAME,
    Mode: "Modal",
  };

  if (PeripheralId) {
    args.PeripheralId = PeripheralId;
  } else {
    args.Target = Origin ?? "OSD";
  }

  console.log(
    `${MACRO_NAME}: Opening web app on: `,
    args?.PeripheralId ?? args?.Target,
  );

  await xapi.Command.UserInterface.WebView.Display(args);
}

function onPanelClicked({ Origin, PanelId, PeripheralId }) {
  if (PanelId !== PANEL_ID) return;

  openWebApp({ Origin, PeripheralId }).catch((error) =>
    console.error(`${MACRO_NAME}: failed to open web app`, error),
  );
}

async function createButton() {
  const order = await panelOrder(PANEL_ID);

  const panel = `
    <Extensions>
      <Panel>
        ${order}
        <Location>HomeScreen</Location>
        <Name>${replaceSpecialCharacters(BUTTON_NAME)}</Name>
        <ActivityType>Custom</ActivityType>
      </Panel>
    </Extensions>`;

  try {
    return xapi.Command.UserInterface.Extensions.Panel.Save(
      { PanelId: PANEL_ID },
      panel,
    );
  } catch (error) {
    console.error(`${MACRO_NAME}: failed to save UI panel`, error);
  }
}

function replaceSpecialCharacters(text = "") {
  return String(text)
    .replaceAll(/&/g, "&amp;")
    .replaceAll(/</g, "&lt;")
    .replaceAll(/>/g, "&gt;");
  //.replaceAll(/"/g, "&quot;")
  //.replaceAll(/'/g, "&apos;");
}

/*********************************************************
 * Gets the current Panel Order if exiting Macro panel is present
 * to preserve the order in relation to other custom UI Extensions
 **********************************************************/
async function panelOrder(panelId) {
  const list = await xapi.Command.UserInterface.Extensions.List({
    ActivityType: "Custom",
  });
  const panel = list?.Extensions?.Panel;
  if (!panel) return "";
  const panels = Array.isArray(panel) ? panel : [panel];
  const existingPanel = panels.find((item) => item.PanelId == panelId);
  if (!existingPanel) return "";
  return `<Order>${existingPanel.Order}</Order>`;
}

async function init() {
  if (HAS_BUTTON) {
    createButton();
    xapi.Event.UserInterface.Extensions.Panel.Clicked.on(onPanelClicked);
  }

  console.log(`${MACRO_NAME}: started`);
}

init();

export { PANEL_ID, WEBAPP_URL, openWebApp, onPanelClicked };
