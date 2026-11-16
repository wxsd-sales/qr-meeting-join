/*
 * Demo data for screenshots and previews only. app.js loads this file when the
 * page is opened with ?demo=meetings, so it never runs in normal use.
 */

const at = (hours, minutes = 0) => {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
};

const base = (id, title, kind, start, minutes, destination, extra = {}) => ({
  id,
  title,
  start: at(...start),
  end: at(...start) + minutes * 60000,
  inProgress: false,
  hostEmail: "",
  hostPin: "",
  guestPin: "",
  kind,
  destination,
  details: null,
  ...extra,
});

export const demo = {
  user: "Alex Morgan",
  pmr: base(
    "personal-meeting-room",
    "Alex Morgan's Personal Room",
    "webex",
    [0, 0],
    0,
    "alex.morgan@springwise.webex.com",
    {
      start: null,
      end: null,
      personal: true,
      hostPin: "5484",
      details: {
        link: "https://springwise.webex.com/meet/alex.morgan",
        videoAddress: "alex.morgan@springwise.webex.com",
        hostPin: "5484",
        phones: [],
      },
    },
  ),
  meetings: [
    base(
      "daily-sync",
      "Daily Sync",
      "webex",
      [10, 0],
      90,
      "10028677895@springwise.webex.com",
      { inProgress: true },
    ),
    base(
      "customer-review",
      "Customer review",
      "zoom",
      [13, 0],
      60,
      "12345678901@zoomcrc.com",
    ),
    base(
      "design-workshop",
      "Design workshop",
      "teams",
      [14, 30],
      60,
      "https://teams.microsoft.com/l/meetup-join/demo",
    ),
    base(
      "planning",
      "Quarterly planning",
      "google",
      [16, 0],
      45,
      "https://meet.google.com/abc-defg-hij",
    ),
  ],
};
