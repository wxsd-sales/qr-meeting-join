import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function load() {
  jest.resetModules();
  const { default: xapi } = await import("xapi");
  xapi.reset();
  xapi.Status.Webex.DeveloperId.set("device-123");
  xapi.Status.UserInterface.ContactInfo.Name.set("Meeting Room 1234");
  xapi.Status.SystemUnit.State.NumberOfActiveCalls.set(0);
  const macro = await import("../../macros/main.js");
  await tick();
  await tick();
  return { xapi, macro };
}

const msg = (token, extra = {}) =>
  JSON.stringify({
    type: "qr-join",
    v: 1,
    deviceId: "device-123",
    token,
    destination: "meet@example.webex.com",
    meetingType: "webex",
    title: "Standup",
    user: "Alex",
    ...extra,
  });

const lastWidgetHash = (xapi) => {
  const calls = xapi.Command.UserInterface.Extensions.WebWidget.Save.mock.calls;
  const args = calls[calls.length - 1][0];
  return {
    args,
    hash: new URLSearchParams(new URL(args.URL).hash.slice(1)),
  };
};

describe("macros/main.js", () => {
  let xapi;
  let macro;
  beforeEach(async () => {
    ({ xapi, macro } = await load());
  });

  it("never opens a page and has no UI panel / button", () => {
    expect(xapi.Command.UserInterface.WebView.Display).not.toHaveBeenCalled();
    expect(
      xapi.Command.UserInterface.Extensions.Panel.Save,
    ).not.toHaveBeenCalled();
  });

  it("saves a web widget at startup with scan parameters", () => {
    const { args, hash } = lastWidgetHash(xapi);
    expect(args.PanelId).toBe("qr-meeting-join");
    expect(args.Name).toBe("QR Meeting Join");
    expect(args.URL).toContain("/widget/#");
    expect(hash.get("d")).toBe("device-123");
    expect(hash.get("n")).toBe("Meeting Room 1234");
    expect(hash.get("t")).toMatch(/^[0-9a-f]{32}$/);
    expect(hash.get("m")).toBe("qr-join");
    expect(hash.get("v")).toBe("1");
    expect(hash.get("e")).toBe(macro.JOIN_ENDPOINT ?? "");
    expect(Number(hash.get("x"))).toBeGreaterThan(Number(hash.get("s")));
    expect(hash.get("app")).toBe(macro.WEBAPP_URL);
  });

  it("re-saves the same widget with a fresh token on rotation", async () => {
    const first = lastWidgetHash(xapi).hash.get("t");
    await macro.rotate();
    const { args, hash } = lastWidgetHash(xapi);
    const second = hash.get("t");
    expect(args.PanelId).toBe("qr-meeting-join");
    expect(second).not.toBe(first);
    // The previous token is still accepted during the grace period.
    expect(macro.checkToken(first)).toBe("ok");
  });

  it("ignores messages that are not qr-join requests", async () => {
    expect(await macro.handleJoinMessage("hello")).toBe("ignored");
    expect(await macro.handleJoinMessage('{"type":"other"}')).toBe("ignored");
  });

  it("uses Webex Join for Webex links and Dial otherwise", async () => {
    let token = macro.mintToken();
    expect(
      await macro.handleJoinMessage(
        msg(token, { destination: "https://acme.webex.com/meet/alex" }),
      ),
    ).toBe("joined");
    expect(xapi.Command.Webex.Join).toHaveBeenCalledWith({
      Number: "https://acme.webex.com/meet/alex",
    });

    token = macro.mintToken();
    await macro.handleJoinMessage(
      msg(token, {
        meetingType: "zoom",
        destination: "12345678901@zoomcrc.com",
      }),
    );
    expect(xapi.Command.Dial).toHaveBeenCalledWith({
      Number: "12345678901@zoomcrc.com",
    });
  });

  it("joins once for a valid token and rejects replays", async () => {
    const token = macro.mintToken();
    expect(await macro.handleJoinMessage(msg(token))).toBe("joined");
    expect(xapi.Command.Dial).toHaveBeenCalledWith({
      Number: "meet@example.webex.com",
    });
    expect(await macro.handleJoinMessage(msg(token))).toBe("token-unknown");
    expect(xapi.Command.Dial).toHaveBeenCalledTimes(1);
    expect(xapi.Command.UserInterface.Message.Alert.Display).toHaveBeenCalled();
  });

  it("handles Message Send events end to end", async () => {
    const token = macro.mintToken();
    xapi.Event.Message.Send.emit({ Text: msg(token) });
    await tick();
    await tick();
    expect(xapi.Command.Dial).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown tokens with an on-device alert", async () => {
    expect(await macro.handleJoinMessage(msg("nope"))).toBe("token-unknown");
    expect(xapi.Command.Dial).not.toHaveBeenCalled();
    expect(
      xapi.Command.UserInterface.Message.Alert.Display,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ Title: "QR code expired" }),
    );
  });

  it("accepts a token during the grace period but not after it", () => {
    const issued = 1_000_000;
    const token = macro.mintToken(issued);
    const refresh = 120_000;
    expect(macro.checkToken(token, issued + refresh + 60_000)).toBe("ok");
    expect(macro.checkToken(token, issued + refresh + 121_000)).toBe("expired");
  });

  it("refuses to join while another call is active", async () => {
    const token = macro.mintToken();
    xapi.Status.SystemUnit.State.NumberOfActiveCalls.set(1);
    expect(await macro.handleJoinMessage(msg(token))).toBe("busy");
    expect(xapi.Command.Dial).not.toHaveBeenCalled();
    // The token is not burned, so the user may retry after the call ends.
    expect(macro.checkToken(token)).toBe("ok");
  });

  it("rejects requests for another device and unsafe destinations", async () => {
    const token = macro.mintToken();
    expect(
      await macro.handleJoinMessage(msg(token, { deviceId: "other" })),
    ).toBe("wrong-device");
    expect(
      await macro.handleJoinMessage(msg(token, { destination: "a b\nc" })),
    ).toBe("bad-destination");
    expect(xapi.Command.Dial).not.toHaveBeenCalled();
  });

  it("validates destinations", () => {
    expect(macro.isValidDestination("https://x.webex.com/meet/a")).toBe(true);
    expect(macro.isValidDestination("123456789@zoomcrc.com")).toBe(true);
    expect(macro.isValidDestination("")).toBe(false);
    expect(macro.isValidDestination("javascript:alert(1)")).toBe(false);
  });
});
