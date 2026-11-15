/*
 * Deployment settings for the phone web app. Edit these when self-hosting.
 *
 *  clientId      Client ID of your Webex Integration (implicit grant). Its
 *                Redirect URI must exactly match the URL this page is served
 *                from (including trailing slash).
 *  scopes        Scopes requested at sign-in.
 *  allowedEndpointHosts
 *                Optional hostname allowlist for the join endpoint. The
 *                endpoint itself arrives in the QR code (set in the wizard /
 *                macro), so leave this empty to accept any https endpoint, or
 *                list your hosts (e.g. ["hooks.example.com"]) to refuse QR
 *                codes that point anywhere else.
 */
window.WEBAPP_CONFIG = {
  clientId: "",
  scopes: ["spark:people_read", "meeting:schedules_read"],
  allowedEndpointHosts: [],
};
