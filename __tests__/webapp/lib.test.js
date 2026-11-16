import { describe, expect, test } from "@jest/globals";
import {
  applyMeetingInfo,
  buildJoinPayload,
  MEETING_LOGOS,
  meetingInfoRequest,
  normalizeCalendarEvent,
  personalRoomToMeeting,
  classifyLink,
  extractJoinTarget,
  isEndpointAllowed,
  isScanExpired,
  normalizeEndpoint,
  parseScan,
  scanFromQrText,
  toJoinableMeetings,
} from "../../webapp/lib.js";

describe("parseScan", () => {
  test("reads device, name, token and expiry", () => {
    const scan = parseScan(
      "#d=dev1&n=Room%201&t=tok&x=2000&e=https%3A%2F%2Fhooks.example.com%2Fj",
    );
    expect(scan).toEqual({
      deviceId: "dev1",
      deviceName: "Room 1",
      token: "tok",
      expiresAt: 2_000_000,
      endpoint: "https://hooks.example.com/j",
      messageType: "qr-join",
      version: 1,
    });
    expect(isScanExpired(scan, 1_999_000)).toBe(false);
    expect(isScanExpired(scan, 2_000_001)).toBe(true);
  });
  test("needs both device and token", () => {
    expect(parseScan("#d=dev1")).toBeNull();
    expect(parseScan("")).toBeNull();
  });
});

describe("join endpoint", () => {
  test("accepts https and localhost http only", () => {
    expect(normalizeEndpoint("https://a.example/x")).toBe(
      "https://a.example/x",
    );
    expect(normalizeEndpoint("http://localhost:3000/j")).toBe(
      "http://localhost:3000/j",
    );
    expect(normalizeEndpoint("http://a.example/x")).toBe("");
    expect(normalizeEndpoint("javascript:alert(1)")).toBe("");
    expect(normalizeEndpoint("https://u:p@a.example/")).toBe("");
    expect(normalizeEndpoint("")).toBe("");
  });
  test("allowlist is optional", () => {
    expect(isEndpointAllowed("https://a.example/x", [])).toBe(true);
    expect(isEndpointAllowed("https://a.example/x", ["a.example"])).toBe(true);
    expect(isEndpointAllowed("https://evil.example/x", ["a.example"])).toBe(
      false,
    );
    expect(isEndpointAllowed("", [])).toBe(false);
  });
});

describe("classifyLink", () => {
  test.each([
    [
      "https://acme.webex.com/meet/alex",
      "webex",
      "https://acme.webex.com/meet/alex",
    ],
    [
      "https://us02web.zoom.us/j/12345678901?pwd=x",
      "zoom",
      "12345678901@zoomcrc.com",
    ],
    [
      "https://teams.microsoft.com/l/meetup-join/19%3a",
      "teams",
      "https://teams.microsoft.com/l/meetup-join/19%3a",
    ],
    [
      "https://meet.google.com/abc-defg-hij",
      "google",
      "https://meet.google.com/abc-defg-hij",
    ],
  ])("%s", (link, kind, destination) => {
    expect(classifyLink(link)).toEqual({ kind, destination });
  });
  test("rejects unrelated links", () => {
    expect(classifyLink("https://example.com/")).toBeNull();
    expect(classifyLink("https://zoom.us/profile")).toBeNull();
    expect(classifyLink("nonsense")).toBeNull();
  });
});

describe("toJoinableMeetings", () => {
  const now = Date.parse("2026-01-01T10:00:00Z");
  const items = [
    {
      id: "b",
      title: "Later",
      start: "2026-01-01T12:00:00Z",
      end: "2026-01-01T13:00:00Z",
      sipAddress: "b@x.webex.com",
    },
    {
      id: "a",
      title: "Now",
      start: "2026-01-01T09:30:00Z",
      end: "2026-01-01T10:30:00Z",
      webLink: "https://x.webex.com/meet/a",
    },
    {
      id: "a",
      title: "Dup",
      start: "2026-01-01T09:30:00Z",
      end: "2026-01-01T10:30:00Z",
      sipAddress: "a@x",
    },
    {
      id: "old",
      title: "Over",
      start: "2026-01-01T07:00:00Z",
      end: "2026-01-01T08:00:00Z",
      sipAddress: "o@x",
    },
    {
      id: "z",
      title: "Zoom",
      start: "2026-01-01T11:00:00Z",
      end: "2026-01-01T11:30:00Z",
      location: "Join https://zoom.us/j/98765432109.",
    },
    {
      id: "n",
      title: "No link",
      start: "2026-01-01T11:00:00Z",
      end: "2026-01-01T11:30:00Z",
    },
  ];
  test("filters, de-duplicates and sorts", () => {
    const out = toJoinableMeetings(items, now);
    expect(out.map((m) => m.id)).toEqual(["a", "z", "b"]);
    expect(out[0].inProgress).toBe(true);
    expect(out[1]).toMatchObject({
      kind: "zoom",
      destination: "98765432109@zoomcrc.com",
    });
  });
  test("prefers the Webex SIP address", () => {
    expect(
      extractJoinTarget({
        sipAddress: "s@x",
        webLink: "https://x.webex.com/m/1",
      }).destination,
    ).toBe("s@x");
  });
});

describe("buildJoinPayload", () => {
  const scan = { deviceId: "d", token: "t" };
  const meeting = {
    destination: "s@x",
    kind: "zoom",
    title: "T",
    hostEmail: "h@x",
    hostPin: "1234",
  };
  test("includes the contract fields", () => {
    expect(buildJoinPayload({ scan, meeting, user: "Alex" })).toEqual({
      type: "qr-join",
      v: 1,
      deviceId: "d",
      token: "t",
      destination: "s@x",
      meetingType: "zoom",
      title: "T",
      user: "Alex",
      hostPin: "1234",
    });
  });
  test("omits pins that do not apply", () => {
    const p = buildJoinPayload({
      scan,
      meeting: { ...meeting, hostPin: "" },
      user: "",
    });
    expect(p).not.toHaveProperty("hostPin");
    expect(p).not.toHaveProperty("guestPin");
  });
});

describe("SDK calendar events", () => {
  test("normalises an SDK event and finds a Zoom link in the location", () => {
    const item = normalizeCalendarEvent({
      id: "evt1",
      subject: "Design review",
      start: "2099-01-01T10:00:00.000Z",
      durationMinutes: 30,
      location: "https://acme.zoom.us/j/123456789?pwd=abc",
      organizer: { emailAddress: "boss@example.com" },
    });
    expect(item.end).toBe("2099-01-01T10:30:00.000Z");
    const [meeting] = toJoinableMeetings([item], 0);
    expect(meeting).toMatchObject({
      title: "Design review",
      kind: "zoom",
      destination: "123456789@zoomcrc.com",
      hostEmail: "boss@example.com",
    });
  });

  test("uses the webex SIP address and drops a duplicate REST copy", () => {
    const sdk = normalizeCalendarEvent({
      id: "a",
      subject: "Standup",
      start: "2099-01-01T10:00:00.000Z",
      end: "2099-01-01T10:15:00.000Z",
      webexURI: "sip:123@acme.webex.com",
    });
    const rest = {
      id: "b",
      title: "Standup",
      start: "2099-01-01T10:00:00.000Z",
      end: "2099-01-01T10:15:00.000Z",
      sipAddress: "123@acme.webex.com",
    };
    expect(toJoinableMeetings([sdk, rest], 0)).toHaveLength(1);
  });

  test("ignores events with no joinable link", () => {
    const item = normalizeCalendarEvent({ id: "x", subject: "Lunch" });
    expect(toJoinableMeetings([item])).toEqual([]);
  });
});

describe("SDK in-place decrypted fields", () => {
  test("reads the title and organizer from encrypted* properties", () => {
    const item = normalizeCalendarEvent({
      id: "e",
      encryptedSubject: "Quarterly planning",
      encryptedLocation: "https://meet.google.com/abc-defg-hij",
      encryptedOrganizer: { encryptedEmailAddress: "pm@example.com" },
      start: "2099-01-01T10:00:00.000Z",
      end: "2099-01-01T11:00:00.000Z",
    });
    expect(item.title).toBe("Quarterly planning");
    expect(item.hostEmail).toBe("pm@example.com");
    expect(toJoinableMeetings([item], 0)[0]).toMatchObject({
      title: "Quarterly planning",
      kind: "google",
    });
  });
});

describe("personal meeting room", () => {
  const room = {
    topic: "Alex's room",
    sipAddress: "alex@acme.webex.com",
    hostPin: "123456",
  };

  test("becomes a meeting entry with the host PIN", () => {
    expect(personalRoomToMeeting(room)).toMatchObject({
      title: "Alex's room",
      destination: "alex@acme.webex.com",
      hostPin: "123456",
      personal: true,
    });
    expect(personalRoomToMeeting({})).toBeNull();
  });

  test("always sends its host PIN to the join endpoint", () => {
    const payload = buildJoinPayload({
      scan: { deviceId: "d", token: "t" },
      meeting: personalRoomToMeeting(room),
      user: "",
    });
    expect(payload.hostPin).toBe("123456");
  });
});

describe("Webex meeting info", () => {
  const event = {
    id: "e",
    encryptedSubject: "Testing QR Join",
    start: "2099-01-01T14:30:00.000Z",
    durationMinutes: 30,
    webexURI: "10028677895@webex.com",
    webexURL: "https://alpha.webex.com/alpha/j.php?MTID=abc",
    meetingJoinInfo: {
      meetingJoinType: "WEBEX",
      meetingJoinURI: "10028677895@webex.com",
      webexMeetingInfo: { siteName: "alpha.webex.com" },
    },
  };
  const info = {
    meetingJoinUrl: "https://alpha.webex.com/alpha/j.php?MTID=abc",
    meetingNumber: "10028677895",
    password: "pw",
    sipUrl: "10028677895@alpha.webex.com",
    video: {
      videoAddress: "10028677895@webex.com",
      videoPassword: "88988737",
    },
    audio: {
      accessCode: "10028677895",
      audioPassword: "88988737",
      callInNumbers: [{ label: "US Toll", number: "+1-650-276-7305" }],
    },
  };

  test("builds the meetingInfo request for the event's site", () => {
    expect(meetingInfoRequest(event)).toEqual({
      uri: "https://alpha.webex.com/wbxappapi/v1/meetingInfo",
      body: {
        supportHostKey: true,
        supportCountryList: true,
        sipUrl: "10028677895@webex.com",
        disableWebRedirect: true,
      },
    });
  });

  test("never sends the token to a non-webex host", () => {
    const bad = structuredClone(event);
    bad.meetingJoinInfo.webexMeetingInfo.siteName = "evil.example.com";
    expect(meetingInfoRequest(bad)).toBeNull();
    expect(meetingInfoRequest({ id: "z" })).toBeNull();
  });

  test("details, dial address and video password come from the info", () => {
    const [meeting] = toJoinableMeetings(
      [applyMeetingInfo(normalizeCalendarEvent(event), info)],
      0,
    );
    expect(meeting.destination).toBe("10028677895@alpha.webex.com");
    expect(meeting.guestPin).toBe("88988737");
    expect(meeting.details).toMatchObject({
      number: "1002 867 7895",
      password: "pw",
      videoPassword: "88988737",
      phones: [{ label: "US Toll", number: "+1-650-276-7305" }],
    });
    const payload = buildJoinPayload({
      scan: { deviceId: "d", token: "t" },
      meeting,
      user: "",
    });
    expect(payload.guestPin).toBe("88988737");
  });
});

describe("message type", () => {
  test("is read from the QR code and echoed in the join payload", () => {
    const scan = parseScan("#d=dev&t=tok&m=custom-join");
    expect(scan.messageType).toBe("custom-join");
    const payload = buildJoinPayload({
      scan,
      meeting: { destination: "a@b.com", title: "T" },
      user: "",
    });
    expect(payload.type).toBe("custom-join");
    expect(
      buildJoinPayload({
        scan: parseScan("#d=x&t=y&v=2"),
        meeting: { destination: "a@b.c" },
      }).v,
    ).toBe(2);
  });
});

describe("scanFromQrText", () => {
  const page = "https://wxsd-sales.github.io/qr-meeting-join/webapp/";

  test("accepts a QR code that opens this web app", () => {
    const scan = scanFromQrText(`${page}#d=dev&t=tok&x=99&v=1`, page);
    expect(scan).toMatchObject({ deviceId: "dev", token: "tok" });
  });

  test("tolerates index.html and a missing trailing slash", () => {
    const code =
      "https://wxsd-sales.github.io/qr-meeting-join/webapp/index.html#d=a&t=b";
    expect(scanFromQrText(code, page)).not.toBeNull();
  });

  test("rejects other sites, other paths and non-URLs", () => {
    expect(
      scanFromQrText("https://evil.example/webapp/#d=a&t=b", page),
    ).toBeNull();
    expect(
      scanFromQrText("https://wxsd-sales.github.io/other/#d=a&t=b", page),
    ).toBeNull();
    expect(scanFromQrText("hello", page)).toBeNull();
    expect(scanFromQrText(`${page}#nothing=here`, page)).toBeNull();
  });
});

describe("meeting logos", () => {
  test("every meeting kind has a Momentum brand visual from the CDN", () => {
    for (const kind of ["webex", "zoom", "teams", "google"]) {
      expect(MEETING_LOGOS[kind].src).toMatch(
        /^https:\/\/cdn\.jsdelivr\.net\/npm\/@momentum-design\/brand-visuals@[\d.]+\/dist\/svg\/.+\.svg$/,
      );
      expect(MEETING_LOGOS[kind].label).toBeTruthy();
    }
  });
});
