# Engineering Decision Pipeline

Engineering Decision Pipeline is a Recall.ai reference application for engineering managers, technical program managers, product managers, and engineers who need reliable follow-up from technical meetings. It captures a Zoom, Google Meet, or Microsoft Teams call, tracks the Recall bot lifecycle, retrieves and normalizes the completed transcript, calculates deterministic talk-time analytics, lets a user explicitly ask Groq to propose evidence-linked engineering artifacts, and exports approved artifacts as local JSON drafts.

Groq analysis is manual only. No Recall webhook, transcript completion event, application startup, timer, or background task invokes an LLM. Generated artifacts remain `proposed` until a user edits, approves, rejects, or restores them. Export never submits data to Linear, Jira, Recall, Groq, or another external service.

## User flow

1. Enter a supported HTTPS meeting URL, title, and meeting type.
2. The backend persists the meeting before asking Recall to create the bot.
3. Signed Recall webhooks update lifecycle and processing state.
4. After `recording.done`, the backend requests asynchronous transcription.
5. After `transcript.done`, the backend downloads and normalizes the transcript.
6. The dashboard displays lifecycle history, transcript utterances, and deterministic analytics.
7. Optionally enter project context and click **Analyze transcript with Groq**, then confirm the disclosure.
8. The backend validates Groq's structured result and displays proposed artifacts with transcript evidence.
9. Review each artifact, jump to its supporting utterances, and edit, approve, reject, or restore it.
10. Select exact approved artifact versions, preview canonical/Linear/Jira JSON, then copy or download it locally.

```text
User
  → Application backend
  → Recall Bot API
  → Meeting platform
  → Signed Recall webhooks
  → Transcript normalization
  → Deterministic talk-time analytics
  → Explicit user click
  → Groq structured analysis
  → Schema and evidence validation
  → Versioned artifact review queue
  → Human edit, approval, rejection, or restore
  → Local approved-artifact JSON export
```

## Architecture

- `src/recall-client.js` owns Recall HTTP requests, retries, transcript artifact retrieval, and transcript download.
- `src/lifecycle.js` normalizes Recall bot lifecycle events into application states while preserving Recall codes.
- `src/transcript.js` normalizes speakers, utterances, and relative timestamps and calculates deterministic metrics.
- `src/groq-client.js` is the sole LLM boundary and owns strict structured-output requests, timeouts, bounded retries, concurrency, and provider rate-limit state.
- `src/artifacts.js` validates generated artifact schemas and replaces evidence IDs with authoritative stored transcript excerpts.
- `src/export.js` validates approved artifact selections and maps them into canonical, Linear, or Jira Cloud v3 JSON drafts without external calls.
- `src/store.js` persists meetings, webhook receipts, transcripts, analysis jobs, artifacts, versioned review state, append-only review events, and deduplication claims to local JSON.
- `src/app.js` validates HTTP input, accepts signed webhooks, coordinates processing, and serves application APIs.
- `src/mock-data.js` contains clearly labeled fixture meeting, lifecycle, transcript, and analytics data.
- `public/index.html` renders the meeting launcher and dashboard without exposing Recall credentials.

The local JSON store is for demonstration only; it is not a production database or queue.

## Recall features and endpoints

This application is pinned to the `Sandbox` workspace in Recall's `us-west-2` region and uses:

- `POST /api/v1/bot/` to create meeting bots.
- `POST /api/v1/recording/{id}/create_transcript/` to start `recallai_async` transcription.
- `GET /api/v1/transcript/{id}/` to retrieve the transcript artifact and its download URL.
- Bot lifecycle events including joining, waiting-room, recording, call-ended, done, and fatal states.
- `recording.done`, `recording.failed`, `transcript.done`, and `transcript.failed` processing events.
- Calendar V2 list and schedule endpoints for the existing explicit `[recall]` opt-in path.

Webhook requests are verified against their exact raw body and deduplicated by delivery ID. Bot status codes are treated as extensible. A later `bot.done` event does not erase an earlier fatal state.

The active workspace webhook is configured for `bot.joining_call`, `bot.in_waiting_room`, `bot.in_call_not_recording`, `bot.recording_permission_allowed`, `bot.recording_permission_denied`, `bot.in_call_recording`, `bot.call_ended`, `bot.done`, `bot.fatal`, the four breakout-room lifecycle events, `recording.done`, `recording.failed`, `transcript.done`, and `transcript.failed`.

## Configuration

Copy the safe template and add real values only to the ignored `.env` file:

```sh
cp .env.example .env
```

Required in live mode:

```dotenv
RECALL_REGION=us-west-2
MOCK_MODE=false
RECALL_API_KEY=your-server-only-key
RECALL_WEBHOOK_VERIFICATION_SECRET=whsec_your-secret
PUBLIC_API_BASE_URL=https://your-stable-public-domain.example
RECALL_CALENDAR_REGIONAL_CALLBACK_URI=
PORT=3000
```

Required only for manual analysis:

```dotenv
GROQ_API_KEY=your-server-only-groq-key
GROQ_MODEL=openai/gpt-oss-20b
GROQ_MAX_CONCURRENCY=1
GROQ_MAX_INPUT_CHARACTERS=18000
```

`GROQ_MODEL` is restricted to Groq models used here with strict structured outputs: `openai/gpt-oss-20b` or `openai/gpt-oss-120b`. The app does not support another provider or silently fall back to one. It limits concurrent requests locally, respects Groq's returned rate-limit headers and `Retry-After`, retries at most twice when the requested wait is 30 seconds or less, and otherwise returns a retryable `429`. `GROQ_MAX_INPUT_CHARACTERS` bounds the combined normalized transcript and supplied context before a request is sent.

Never expose the API key, webhook secret, OAuth client JSON, authorization codes, signed transcript URLs, or raw transcript payloads in browser code, logs, screenshots, or committed files.

## Run live mode

The project requires a Node.js version that supports `--env-file`.

```sh
npm install
npm test
npm start
```

Open `http://localhost:3000`. Recall must send webhooks to a stable public route:

```text
https://<public-domain>/webhooks/recall
```

The optional calendar callback route is:

```text
https://<public-domain>/callbacks/calendar
```

Set the Recall dashboard webhook subscriptions for the bot lifecycle, recording, and transcript events listed above. Localhost cannot receive Recall webhooks directly; use a stable HTTPS tunnel or deployed backend.

## Run mock/demo mode

Set `MOCK_MODE=true` and keep `RECALL_REGION=us-west-2`. Recall credentials and a public callback URL are not required in this mode.

```sh
npm start
```

The dashboard displays a visible `MOCK MODE` badge and a fixture architecture review with lifecycle history, three participants, normalized transcript timestamps, deterministic analytics, and clearly labeled fixture ADR, action-item, bug, and risk proposals. This supports the complete review and export flow without a live meeting or Groq request. Approve one or more fixtures to reveal the export panel. Mock mode makes no live Recall transcript or calendar calls. It also does not run Groq on startup; clicking the analysis button is still required and requires `GROQ_API_KEY`.

## Manual Groq analysis

Once a meeting has a completed transcript, its card displays an optional project-context field and an **Analyze transcript with Groq** button. The browser asks for confirmation before sending the normalized transcript, participant names, meeting metadata, and the context you entered to Groq. Recording media, Recall credentials, webhook secrets, and unrelated meetings are not included.

The structured response may contain architecture decisions, action items, bug reports, risks, and open questions. The backend rejects unknown fields, invalid types, unsupported participant assignments, unknown evidence IDs, duplicate artifacts, vague required content, and more than 30 artifacts. Evidence text, speakers, and timestamps are hydrated from the locally stored normalized transcript rather than trusted from model output. Artifacts without evidence are visibly flagged.

Implementation behavior follows Groq's official [Chat Completions API](https://console.groq.com/docs/api-reference), [strict structured outputs](https://console.groq.com/docs/structured-outputs), and [rate-limit headers](https://console.groq.com/docs/rate-limits).

## Artifact review

Artifact cards show their review state, provenance, structured content, confidence, and evidence state. Evidence buttons scroll to and temporarily highlight the authoritative transcript utterance. Type-specific edit forms validate changes through the same deterministic rules used for Groq output. An edit moves an artifact to `needs_changes`; users can then approve or reject it. Restore replaces user edits with the immutable original proposal and resets the artifact to `proposed`.

Every review mutation requires the artifact version that the browser loaded. Stale writes receive `409 Conflict` with the current artifact instead of overwriting a newer review. Review events are append-only and record the transition, version, time, and optional rejection note. Reanalysis replaces only unreviewed `proposed` artifacts; `needs_changes`, `approved`, and `rejected` artifacts are preserved.

## Approved-artifact export

The export panel appears after at least one artifact is approved. Nothing is selected by default. The user selects exact artifact versions and one of three deterministic formats:

- Canonical JSON preserves meeting metadata, reviewed artifact content, provenance, approval time, and transcript evidence.
- Linear drafts contain `issueCreate` title and Markdown description fields plus explicit mapping hints for the required team ID, assignee, priority, labels, and due date.
- Jira Cloud v3 drafts contain summary, Atlassian Document Format description, and labels plus explicit mapping hints for project, work type, assignee, priority, and due date.

The backend rejects empty or duplicate selections, artifacts outside the meeting, non-approved artifacts, stale versions, unsupported formats, and Jira summaries/descriptions beyond documented limits. It never invents Linear team/user IDs or Jira project/work-type/account IDs. Those workspace-specific values must be resolved by a future importer before submission. The current implementation follows Linear's official [GraphQL issue creation guide](https://linear.app/developers/graphql) and Atlassian's official [Jira Cloud v3 issue API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).

## Application API

- `POST /api/meetings` creates and persists a meeting, then creates a Recall bot.
- `GET /api/meetings` lists locally stored meetings.
- `GET /api/meetings/:id` returns one meeting and its lifecycle state.
- `GET /api/meetings/:id/transcript` returns its normalized transcript and analytics.
- `POST /api/meetings/:id/analyze` is the only path that invokes Groq; it accepts optional `{ "projectContext": "..." }` JSON after transcript completion.
- `GET /api/meetings/:id/artifacts` returns all meeting artifacts, review events, and the latest manual analysis job.
- `GET /api/artifacts/:id` returns one artifact and its review history.
- `PATCH /api/artifacts/:id` validates and saves a user edit using `expectedVersion`.
- `POST /api/artifacts/:id/approve` approves an artifact using `expectedVersion`.
- `POST /api/artifacts/:id/reject` rejects an artifact and accepts an optional review note.
- `POST /api/artifacts/:id/restore` restores the immutable original proposal.
- `POST /api/meetings/:id/export` validates `{ "format", "selections": [{ "artifactId", "version" }] }` and returns a safe filename plus local JSON export.
- `POST /api/meetings/:id/reconcile` retrieves the current Recall bot snapshot and merges missed lifecycle history without polling.
- `POST /api/meetings/:id/process` retries recoverable transcript processing from Recall's existing recording/transcript artifacts.
- `GET /api/dashboard` returns the combined dashboard model.
- `POST /webhooks/recall` accepts verified Recall webhook deliveries.
- `POST /api/bots` remains as a compatibility alias for meeting creation.

## Calendar policy

Calendar is a secondary path. Only future, non-deleted events with a meeting URL and an exact `[recall]` title tag are eligible. Stable calendar identifiers are used for scheduling deduplication. Google OAuth setup is not connected in this repository; completing it remains a later Calendar V2 step after the direct URL workflow is stable.

## Verification

```sh
npm test
npm run smoke
```

`npm test` uses deterministic mocked Recall and Groq responses and does not require a live account. It covers artifact validation, review actions, audit events, reanalysis preservation, canonical/Linear/Jira mappings, export eligibility, stale versions, safe filenames, and asserts that transcript webhooks, review actions, and exports never make external calls. `npm run smoke` loads `.env`, constructs the production entrypoint, and exercises `GET /` without binding a network socket. Neither command sends a live Groq request.

The Recall workspace, region, purpose-named API key metadata, webhook destination, and subscriptions have been verified. With the configured ngrok route active, a signed Recall `bot.joining_call` test delivery reached the application and was durably recorded with processing status `complete`. The verification tunnel was stopped afterward; restart the app and tunnel when receiving live webhooks locally.

## Known limitations and future work

- Persistence and webhook work scheduling are local-file/in-process implementations for demo use.
- A local ngrok tunnel exposes meeting APIs and locally stored demo data while it is running. Start it only for active testing and stop it afterward.
- Status reconciliation is user-triggered and intended for recovery; webhooks remain the primary lifecycle mechanism.
- Existing records created before the meeting model are migrated from the old `intents` collection, but older transcript records are not automatically associated with meetings.
- Transcript duration is the span from the earliest to latest normalized relative timestamp; speaking percentages use total measured speaking time and are descriptive only.
- Overlapping speakers can make summed speaking time differ from wall-clock meeting duration.
- Calendar OAuth is not connected.
- Long transcripts are rejected at the configured character bound; transcript chunking and cross-chunk deduplication are not implemented yet.
- Rate-limit and concurrency state is process-local, so a multi-instance deployment needs a shared limiter.
- Project context is explicitly supplied as text for each manual request; repository connectors are not implemented.
- Review events identify the actor only as `local_user` because authentication and multi-user identity are outside this demo's scope.
- Linear and Jira drafts require a separate importer to resolve workspace-specific IDs and validate configured create-screen fields before submission.
- Direct Jira/Linear API submission is intentionally excluded; no external ticket API calls are made.
