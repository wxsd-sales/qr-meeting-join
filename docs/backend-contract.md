# Middleware contract

The phone web app cannot talk to the device directly (it is usually not on the
same network), so a cloud service relays the join request using a **Cloud xAPI**
command. This document is the contract between the web app, that middleware
(AWS Lambda or a Webex Connect flow) and the macro. The middleware itself is
built separately.

```text
phone web app ──POST──▶ middleware ──xCommand Message Send──▶ device macro ──▶ Dial
```

## 1. Web app → middleware

`POST <join endpoint>`. The URL is set in the wizard / macro (`JOIN_ENDPOINT`)
and delivered to the web app in the QR code (`e=`), so it can point at any
backend. It must be `https` (or `http://localhost` for development). For now
the request is **unauthenticated**; the web app never sends the user's Webex
access token.

The web app sends `Content-Type: application/json` with a JSON body. Because
the web app is served from a different origin, browsers send a CORS preflight
`OPTIONS` request first, so the endpoint must answer it (and the `POST`) with
`Access-Control-Allow-Origin` and `Access-Control-Allow-Headers: Content-Type`.

```json
{
  "type": "qr-join",
  "v": 1,
  "deviceId": "Y2lzY29zcGFyazovL…",
  "token": "3f9c…32 hex chars…",
  "destination": "123456789@zoomcrc.com",
  "meetingType": "zoom",
  "title": "Weekly sync",
  "user": "Alex Doe",
  "hostPin": "123456",
  "guestPin": "7890"
}
```

| Field         | Required | Notes                                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `type`        | yes      | From the QR code (`m=`). Relay unchanged: the macro ignores `Message Send` text without it.            |
| `v`           | yes      | From the QR code (`v=`, currently `1`). Relay unchanged: the macro rejects other versions.             |
| `deviceId`    | yes      | From the QR code (`d=`): the Webex device ID (`Status.Webex.DeveloperId`), also the Cloud xAPI target. |
| `token`       | yes      | From the QR code (`t=`). **Treat as opaque; the macro checks it.**                                     |
| `destination` | yes      | SIP URI, number or `https` meeting link to join.                                                       |
| `meetingType` | no       | `webex` (default), `zoom`, `teams` or `google`; selects the join command.                              |
| `title`       | no       | Meeting title, shown in the on-device confirmation.                                                    |
| `user`        | no       | Display name of the signed-in user (informational only, not trusted).                                  |
| `hostPin`     | no       | Sent as DTMF after dialling.                                                                           |
| `guestPin`    | no       | Sent as DTMF after dialling (host PIN wins if both are present).                                       |

The five required fields (`type`, `v`, `deviceId`, `token`, `destination`) are
exactly what the macro validates before acting, so the middleware must put all
of them in the `Message Send` text. The web app fills the first four from the
QR code, so the middleware never has to know the values.

A Webex Connect inbound webhook cannot return a custom response, so **the web
app cannot learn the outcome**. It shows "Request sent - watch the device
screen" after any 2xx, and the device reports success/failure itself.

## 2. Middleware → device

The middleware (an integration/bot/service app with `spark:xapi_commands`)
issues, against `deviceId`:

```text
POST https://webexapis.com/v1/xapi/command/Message.Send
{ "deviceId": "<deviceId>", "arguments": { "Text": "<JSON string below>" } }
```

`Text` is the JSON string below. The middleware should **forward the web app's
fields unchanged** and may add nothing the macro depends on.

```json
{
  "type": "qr-join",
  "v": 1,
  "deviceId": "…",
  "token": "…",
  "destination": "…",
  "meetingType": "…",
  "title": "…",
  "user": "…",
  "hostPin": "…",
  "guestPin": "…"
}
```

Middleware responsibilities: basic shape validation, rate limiting, restricting
the destination scheme if desired, and mapping `deviceId` to a credential with
rights over that device. It does **not** need to validate the token.

## 3. Macro behaviour

The macro (see `macros/main.js`) ignores any `Message Send` text whose `type` is
not `qr-join`, then:

1. rejects a `v` it does not support, or a `deviceId` that is not its own;
2. rejects an unknown, already-used or expired token - on-device alert
   _"QR code expired – scan the new code and try again"_;
3. rejects an invalid destination;
4. rejects the request if a call is already active (the token is **not**
   consumed, so the user can retry after the call ends);
5. consumes the token (single use), mints a fresh one, and joins - `Webex Join`
   for `webex` meeting links, `Dial` for everything else (Zoom SIP, Teams and
   Google Meet);
6. shows _"Joining meeting"_ and, if a PIN was sent, sends it as DTMF.

### Token lifetime

A token is **displayed** for `TOKEN_REFRESH_SECONDS` and **accepted** for
`TOKEN_REFRESH_SECONDS + TOKEN_GRACE_SECONDS`. The QR code carries `x`, the
epoch-seconds deadline after which the token is no longer accepted, so the web
app can tell a user to rescan without a round trip. The device clock is
authoritative.
