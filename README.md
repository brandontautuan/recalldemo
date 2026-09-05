# Recall Meeting Bot

This app is a server-owned Recall.ai Meeting Bot integration for the Sandbox workspace in `us-west-2`. Users can schedule a bot from an HTTPS meeting URL. Google Calendar V2 webhooks independently schedule only future, non-deleted events whose title contains the exact `[recall]` tag and have a meeting URL.

The production path is: browser → `POST /api/bots` → Recall Create Bot; Recall dashboard and Calendar V2 → signed `POST /webhooks/recall` → durable local intent/event state → Recall post-meeting transcript creation and Calendar Event Bot scheduling. Transcript status is displayed on the dashboard. The direct-URL form is an explicitly user-driven/admin surface; Calendar V2 is the recurring scheduling path.

## Run

Copy `.env.example` to `.env` through your secret manager and set the real API key and workspace verification secret server-side. `PUBLIC_API_BASE_URL` must be the actual reserved ngrok domain, never the supplied placeholder. Run `npm test`, then `npm start` and browse to `http://localhost:3000`.

The app needs the public routes `https://<actual-domain>/webhooks/recall` and `https://<actual-domain>/callbacks/calendar`. The callback forwards only `state`, `code`, `error`, or a Calendar V2 probe to the Recall regional callback URI returned during setup; set that returned URI as `RECALL_CALENDAR_REGIONAL_CALLBACK_URI` before the probe.

## Calendar policy

The fixed opt-in policy is title contains `[recall]`. Events that are past, deleted, lack a meeting link, or lack the tag are persisted as skipped and never scheduled. Matching events use their stable `ical_uid` (or event ID) as the Recall scheduling deduplication key. A changed matching event is rescheduled through Recall; deleted events are already unscheduled by Recall.

## Remaining provider setup

Google setup must use a customer-owned Google Cloud project and a dedicated Web OAuth client. Enable Calendar API; configure branding as `Recall.ai Calendar Setup`; select Internal only for a wholly owned Workspace organization, otherwise External; use only `calendar.events.readonly` and `userinfo.email`; add the exact redirect URI returned by Recall; then import the downloaded client JSON only through Recall’s setup flow. For External testing, Google refresh tokens normally expire after seven days; publish before the first durable authorization.

No API key, workspace secret, OAuth JSON, authorization code, or transcript payload is committed. `npm run smoke` constructs the production entrypoint without binding a socket.
