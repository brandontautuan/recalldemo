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
7. Optionally create a local project configuration whose repository path is inside `PROJECT_REPOSITORY_ROOTS`, then scan and approve only its listed documentation files. No LLM runs during ingestion.
8. Select a project, enter ad hoc notes, and click **Preview selected context**. Review and explicitly approve the included source text, revisions, paths, line ranges, omissions, and character budget.
9. Click **Analyze transcript with Groq** and confirm the disclosure. The browser sends the approved immutable preview ID and matching notes only after this explicit action. The notes-only path remains available without a selected project.
10. The backend validates Groq's structured result and displays proposed artifacts with retrieved-context provenance separately from transcript evidence.
11. Review each artifact, jump to its supporting utterances, and edit, approve, reject, or restore it.
12. Select exact approved artifact versions, preview canonical/Linear/Jira JSON, then copy or download it locally.

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
- `src/groq-client.js` is the sole LLM boundary and owns strict structured-output requests, labeled transcript/notes/retrieved-context inputs, total input bounds, timeouts, bounded retries, concurrency, and provider rate-limit state.
- `src/artifacts.js` validates generated artifact schemas, replaces evidence IDs with authoritative stored transcript excerpts, and resolves context-source IDs only against the immutable snapshot used by that analysis.
- `src/export.js` validates approved artifact selections and maps them into canonical, Linear, or Jira Cloud v3 JSON drafts without external calls.
- `src/store.js` persists meetings, webhook receipts, transcripts, analysis jobs, artifacts, versioned review state, append-only review events, and deduplication claims to local JSON.
- `src/context-db.js` owns the separate local SQLite project-context schema, checksummed migrations, and transactional seed upserts.
- `src/context-seed.js` strictly validates, normalizes, and hashes the reviewed local project-context manifest without network access.
- `src/context-selector.js` builds persisted, immutable context previews using fixed source ordering, deterministic lexical overlap, and an independent character ceiling.
- `src/repository-context.js` validates server-approved local roots, reads only explicitly listed documentation, records bounded line ranges and Git metadata, and never exposes filesystem access to Groq.
- `src/app.js` validates HTTP input, accepts signed webhooks, coordinates processing, and serves application APIs.
- `src/mock-data.js` contains clearly labeled fixture meeting, lifecycle, transcript, and analytics data.
- `public/index.html` renders the meeting launcher and dashboard without exposing Recall credentials.

The local JSON store is for demonstration only; it is not a production database or queue. SQLite is used only for the bounded project-context corpus and immutable selections described in the design; it does not replace the current meeting/transcript store.

## Recall features and endpoints

This application is pinned to the `Sandbox` workspace in Recall's `us-west-2` region and uses:

- `POST /api/v1/bot/` to create meeting bots.
- `POST /api/v1/recording/{id}/create_transcript/` to start `recallai_async` transcription.
- `GET /api/v1/transcript/{id}/` to retrieve the transcript artifact and its download URL.
- Bot lifecycle events including joining, waiting-room, recording, call-ended, done, and fatal states.
- `recording.done`, `recording.failed`, `transcript.done`, and `transcript.failed` processing events.
- Calendar V2 list and schedule endpoints for the existing explicit `[recall]` opt-in path.

Webhook requests are verified against their exact raw body and deduplicated by delivery ID. Bot status codes are treated as extensible. A later `bot.done` event does not erase an earlier fatal state.

The dashboard uses eight canonical meeting states: `created`, `bot_scheduled`, `joining`, `in_call`, `recording`, `transcript_processing`, `completed`, and `failed`. Waiting-room events map to `joining`; permission and non-recording call events map to `in_call`; call-ended and `bot.done` events map to `transcript_processing`. A meeting becomes `completed` only after a normalized transcript is stored. Raw Recall event types, codes, sub-codes, messages, and timestamps remain in lifecycle history. Later authoritative states may skip missing intermediate states, but delayed older events cannot move the displayed state backward. `completed` and `failed` are terminal per lifecycle attempt.

The backend derives the valid recovery controls returned to the dashboard. Active or failed bot states may be reconciled explicitly. Only transcript-processing failures expose **Retry processing**, which starts a numbered recovery attempt and reuses existing Recall artifacts. Ambiguous bot-creation failures are not retried automatically or in place; the UI tells the user to create a new meeting request. Analysis failures remain separate from meeting completion and every Groq retry requires another explicit click and confirmation.

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

Local project-context foundation:

```dotenv
DATABASE_PATH=data/project-context.sqlite
PROJECT_CONTEXT_SEED_PATH=seeds/project-context.example.json
PROJECT_CONTEXT_MAX_CHARACTERS=12000
PROJECT_REPOSITORY_ROOTS=/Users/you/code
PROJECT_CONTEXT_ADMIN_TOKEN=replace-with-a-long-local-admin-token
PROJECT_SCAN_MAX_FILES=20
PROJECT_SCAN_MAX_FILE_BYTES=100000
PROJECT_SCAN_MAX_FILE_CHARACTERS=6000
```

`GROQ_MODEL` is restricted to Groq models used here with strict structured outputs: `openai/gpt-oss-20b` or `openai/gpt-oss-120b`. The app does not support another provider or silently fall back to one. It limits concurrent requests locally, respects Groq's returned rate-limit headers and `Retry-After`, retries at most twice when the requested wait is 30 seconds or less, and otherwise returns a retryable `429`. `GROQ_MAX_INPUT_CHARACTERS` bounds the combined normalized transcript and supplied context before a request is sent.

`DATABASE_PATH` is the generated local SQLite file and must point to persistent writable storage in a deployed demo. `PROJECT_CONTEXT_MAX_CHARACTERS` is reserved for the deterministic selected-context ceiling and must be smaller than `GROQ_MAX_INPUT_CHARACTERS`. `PROJECT_CONTEXT_SEED_PATH` identifies the reviewed manifest consumed only by the deliberate seed command; application startup does not read or seed it.

`PROJECT_REPOSITORY_ROOTS` is a server-side, path-delimiter-separated allowlist (`:` on macOS/Linux) of parent directories that may contain configured repositories. Enabling it also requires a server-side `PROJECT_CONTEXT_ADMIN_TOKEN` of at least 16 characters; enter that token in the local dashboard to authorize configuration, scan, ingestion-detail, and ingestion-approval requests. It is never returned by the server or stored by the browser. A dashboard-supplied path outside the configured real paths is rejected. Scans accept 1–20 explicitly listed `.md`, `.mdx`, `.rst`, or `.txt` files by default; traversal, symbolic files, secret-like filenames, ignored build/dependency directories, oversized files, and files outside the repository are rejected. The scanner records at most the configured excerpt and tracked-path bounds. It does not recurse through file contents, send code to Groq, or perform network access.

This project uses Node's built-in SQLite API and therefore requires Node.js 22.13 or newer, when SQLite became available without an opt-in flag. The currently tested Node release may emit an experimental-feature warning when loading SQLite; no third-party database package or native build step is required.

Never expose the API key, webhook secret, OAuth client JSON, authorization codes, signed transcript URLs, or raw transcript payloads in browser code, logs, screenshots, or committed files.

## Run live mode

The project requires a Node.js version that supports `--env-file`.

```sh
npm install
npm test
npm start
```

Server startup transactionally applies pending checked-in SQLite migrations before listening. To apply or inspect this step deliberately without starting the application, run:

```sh
npm run migrate-context
```

The command creates only the schema and migration ledger. It does not seed project content, contact Recall or Groq, fetch repositories or tickets, or start background work. Applied migration files are protected by stored SHA-256 checksums and must not be edited in place; add a later migration instead.

Seed the fictional, reviewed local project corpus deliberately after migration:

```sh
npm run seed-context -- --dry-run
npm run seed-context
```

The versioned `project-context-seed/v1` manifest supplies project metadata, repository metadata, bounded context documents, and existing work-item snapshots. The command rejects unknown fields, unsupported kinds, invalid references, embedded URL credentials, oversized input, public-directory or symbolic-link seed files, stale timestamps, and document changes without a higher revision. It normalizes identifiers, whitespace, line endings, labels, URLs, timestamps, and JSON key order before hashing and transactionally upserting by stable ID. A dry run rolls back all corpus changes after reporting the same safe counts; neither mode prints document or ticket content.

Records absent from a later manifest are retained. Documents must use an explicit higher `revision` for any change, including deactivation; projects, repositories, and work items require a newer `updatedAt` when their stored fields change. Running an unchanged manifest again reports every record as unchanged.

After seeding, the backend can list active projects and create an immutable context preview for a completed meeting. Selection is deterministic: project metadata comes first, then repositories by stable ID, active documents by `selectionPriority` and ID, and relevant open work items by lexical-overlap score, selection priority, newest update, and stable ID. Token matching lowercases and removes accents, punctuation, one-character tokens, and a fixed set of common words; it does not use embeddings, classification, or an LLM. Once the character ceiling is reached, all lower-ranked sources are recorded as omitted. Inactive documents, closed work items, and work items with zero overlap receive explicit omission reasons.

The project inventory endpoint returns source labels and revisions without document or ticket contents. The context-preview endpoint returns and persists only the bounded sources selected for that meeting, their revisions, the exact content hash, the ad hoc context hash used for ranking, and all omissions. Creating a preview never starts analysis.

An explicit analysis request may provide the preview ID and the same optional ad hoc notes that were used to rank it. Before Groq is called, the backend verifies the snapshot hash, meeting ownership, project availability, notes hash, and single-use state. It then links the snapshot to the manual analysis job and sends the normalized transcript, user notes, and retrieved context as separately labeled fields under the existing total Groq input limit. The client cannot submit context documents or source IDs directly. The browser provides project selection, an exact source preview with omissions and character usage, preview invalidation when project or notes change, and a separate confirmation before analysis.

### Ingest an approved local repository

1. Put the repository under one of the server-side `PROJECT_REPOSITORY_ROOTS`.
2. In **Approved local project context**, enter a project slug, name, description, absolute repository path, and explicit relative documentation paths such as `README.md` and `docs/architecture.md`.
3. Create the project configuration, select it, and click **Scan project context**.
4. Review every collected excerpt, path, line range, Git commit (when available), tracked-file metadata, and fingerprint.
5. Click **Approve collected context**. Pending scans are never selected for analysis.
6. For a completed meeting, create and then approve its bounded context snapshot before the separate Groq confirmation.

If an approved file, tracked-file list, or Git commit changes, context preview and analysis are blocked until a new scan is reviewed and approved. Prior ingestions and immutable meeting snapshots remain stored for traceability. Local absolute paths are used only by the backend scanner and are never included in the Groq input.

Open `http://localhost:3000`. Recall must send webhooks to a stable public route:

```text
https://<public-domain>/webhooks/recall
```

The optional calendar callback route is:

```text
https://<public-domain>/callbacks/calendar
```

Set the Recall dashboard webhook subscriptions for the bot lifecycle, recording, and transcript events listed above. Localhost cannot receive Recall webhooks directly; use a stable HTTPS tunnel or deployed backend.

The server binds to `127.0.0.1` by default. Set `HOST=0.0.0.0` only in a deployment with an authenticated/restricted ingress; a local ngrok tunnel can forward the default localhost listener.

## Run mock/demo mode

Set `MOCK_MODE=true` and keep `RECALL_REGION=us-west-2`. Recall credentials and a public callback URL are not required in this mode.

```sh
npm start
```

The dashboard displays a visible `MOCK MODE` badge and a fixture architecture review with lifecycle history, three participants, normalized transcript timestamps, deterministic analytics, and clearly labeled fixture ADR, action-item, bug, and risk proposals. This supports the complete review and export flow without a live meeting or Groq request. Approve one or more fixtures to reveal the export panel. Use **Reset demo** and confirm the prompt to restore only this named fixture, including its initial proposals, while preserving live records and seeded project context. Repeating reset produces the same fixture and makes no external calls. Mock mode makes no live Recall transcript or calendar calls. It also does not run Groq on startup; clicking the analysis button is still required and requires `GROQ_API_KEY`.

## Manual Groq analysis

Once a meeting has a completed transcript, its card displays an optional seeded-or-locally-ingested project selector, project-notes field, and analysis controls. With a project selected, the user must create, review, and approve a deterministic context preview. Changing either the project or notes invalidates that approval. The browser then asks for a separate confirmation before sending the normalized transcript, participant names, meeting metadata, notes, and approved immutable context snapshot to Groq. With no project selected, the existing notes-only path remains available. Local repository paths, recording media, Recall credentials, webhook secrets, omitted sources, and unrelated meetings are not included.

The structured response may contain architecture decisions, detailed ticket-like action items, bug reports, risks, and open questions. Ticket proposals support summary, problem, rationale, proposed implementation areas, acceptance criteria, dependencies, risks, open questions, priority, evidence IDs, and validated repository references. The backend rejects unknown fields, invalid types, unsupported participant assignments, unknown evidence IDs, unknown or duplicated context-source IDs, invented repository paths or line ranges, unsupported claims with no evidence/context reference, duplicate artifacts, vague required content, and more than 30 artifacts. Evidence text, speakers, and timestamps are hydrated from the locally stored normalized transcript rather than trusted from model output. Context provenance contains only approved selected sources, file paths, line ranges, ingestion IDs, revisions, and the immutable selection hash; it remains separate from transcript evidence.

Implementation behavior follows Groq's official [Chat Completions API](https://console.groq.com/docs/api-reference), [strict structured outputs](https://console.groq.com/docs/structured-outputs), and [rate-limit headers](https://console.groq.com/docs/rate-limits).

## Artifact review

Artifact cards show their review state, provenance, structured content, confidence, and evidence state. Evidence buttons scroll to and temporarily highlight the authoritative transcript utterance. Type-specific edit forms validate changes through the same deterministic rules used for Groq output. An edit moves an artifact to `needs_changes`; users can then approve or reject it. Restore replaces user edits with the immutable original proposal and resets the artifact to `proposed`.

Every review mutation requires the artifact version that the browser loaded. Stale writes receive `409 Conflict` with the current artifact instead of overwriting a newer review. Review events are append-only and record the transition, version, time, and optional rejection note. Reanalysis replaces only unreviewed `proposed` artifacts; `needs_changes`, `approved`, and `rejected` artifacts are preserved.

## Approved-artifact export

The export panel appears after at least one artifact is approved. Nothing is selected by default. The user selects exact artifact versions and one of three deterministic formats:

- Canonical JSON preserves meeting metadata, reviewed artifact content, context provenance, approval time, and transcript evidence.
- Linear drafts contain `issueCreate` title and Markdown description fields with separate retrieved-context and transcript-evidence sections, plus explicit mapping hints for the required team ID, assignee, priority, labels, and due date.
- Jira Cloud v3 drafts contain summary, Atlassian Document Format description with separate provenance sections, and labels plus explicit mapping hints for project, work type, assignee, priority, and due date.

The backend rejects empty or duplicate selections, artifacts outside the meeting, non-approved artifacts, stale versions, unsupported formats, and Jira summaries/descriptions beyond documented limits. It never invents Linear team/user IDs or Jira project/work-type/account IDs. Those workspace-specific values must be resolved by a future importer before submission. The current implementation follows Linear's official [GraphQL issue creation guide](https://linear.app/developers/graphql) and Atlassian's official [Jira Cloud v3 issue API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).

## Application API

- `POST /api/demo/reset` is available only in mock mode, accepts no fields, and deterministically restores only the labeled fixture without external calls.
- `POST /api/projects/local` creates a project whose repository path is constrained by `PROJECT_REPOSITORY_ROOTS`.
- `POST /api/projects/:id/repositories/:repositoryId/scan` stages bounded approved-file excerpts and repository metadata for review.
- `GET /api/projects/:id/ingestions/:ingestionId` returns one staged or historical ingestion with its exact excerpts.
- `POST /api/projects/:id/ingestions/:ingestionId/approve` activates one pending ingestion and supersedes the prior approved ingestion without deleting it.
- `POST /api/meetings/:id/context-preview/:selectionId/approve` approves the exact immutable context snapshot required for selected-project analysis.
- `POST /api/meetings` creates and persists a meeting, then creates a Recall bot.
- `GET /api/meetings` lists locally stored meetings.
- `GET /api/meetings/:id` returns one meeting and its lifecycle state.
- `GET /api/meetings/:id/transcript` returns its normalized transcript and analytics.
- `GET /api/projects` lists active seeded and locally configured projects without contacting an external system.
- `GET /api/projects/:id/context` returns source labels, kinds, revisions, and active state without exposing document contents.
- `POST /api/meetings/:id/context-preview` accepts `{ "projectId": "...", "projectContext": "..." }`, requires a completed transcript, and persists a deterministic bounded preview without invoking Groq.
- `POST /api/meetings/:id/analyze` is the only path that invokes Groq; after transcript completion it accepts optional `{ "contextSelectionId": "...", "projectContext": "..." }`. A supplied selection must belong to this meeting, pass its integrity check, remain unused, reference an active project, and match the notes hash created during preview.
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
npm run test:golden
npm run smoke
```

`npm test` uses deterministic mocked Recall and Groq responses and does not require a live account. It covers the canonical state table, forward-only and skipped transitions, unknown Recall states, terminal failures, explicit recovery attempts, migrations, seed validation, idempotent ingestion, deterministic source ordering, lexical relevance, character-budget omissions, preview integrity, single-use analysis binding, context-source validation, browser preview state and invalidation, separate artifact and export provenance, project APIs, fixture-only demo reset, artifact validation, review actions, audit events, reanalysis preservation, canonical/Linear/Jira mappings, export eligibility, stale versions, and safe filenames. It also asserts that context previews, transcript webhooks, review actions, exports, and demo reset never make external calls. `npm run test:golden` runs the single mocked integration path from meeting creation through signed lifecycle/transcript webhooks, normalization, explicit analysis, approval, and canonical export; it proves Groq is called exactly once and only by the manual analysis request. `npm run smoke` loads `.env`, constructs the production entrypoint, and exercises `GET /` without binding a network socket. None of these commands sends a live Recall or Groq request.

The Recall workspace, region, purpose-named API key metadata, webhook destination, and subscriptions have been verified. With the configured ngrok route active, a signed Recall `bot.joining_call` test delivery reached the application and was durably recorded with processing status `complete`. The verification tunnel was stopped afterward; restart the app and tunnel when receiving live webhooks locally.

## Known limitations and future work

- Persistence and webhook work scheduling are local-file/in-process implementations for demo use.
- The SQLite project-context schema, migration and seed workflows, project APIs, deterministic selection, immutable previews, browser disclosure flow, Groq binding, artifact provenance, and provenance-aware exports are present.
- Generated SQLite files require a persistent writable volume outside ephemeral/serverless filesystems. The checked-in migrations remain source files; generated databases, journals, WAL files, and private `seeds/*.local.json` overrides are ignored.
- A local ngrok tunnel exposes meeting APIs and locally stored demo data while it is running. Start it only for active testing and stop it afterward.
- Status reconciliation is user-triggered and intended for recovery; webhooks remain the primary lifecycle mechanism.
- Existing records created before the meeting model are migrated from the old `intents` collection, but older transcript records are not automatically associated with meetings.
- Transcript duration is the span from the earliest to latest normalized relative timestamp; speaking percentages use total measured speaking time and are descriptive only.
- Overlapping speakers can make summed speaking time differ from wall-clock meeting duration.
- Calendar OAuth is not connected.
- Long transcripts are rejected at the configured character bound; transcript chunking and cross-chunk deduplication are not implemented yet.
- Rate-limit and concurrency state is process-local, so a multi-instance deployment needs a shared limiter.
- Live repository, documentation, and ticket connectors remain intentionally out of scope; project context comes only from the deliberately seeded corpus or explicitly scanned and approved local documentation.
- Review events identify the actor only as `local_user` because authentication and multi-user identity are outside this demo's scope.
- Linear and Jira drafts require a separate importer to resolve workspace-specific IDs and validate configured create-screen fields before submission.
- Direct Jira/Linear API submission is intentionally excluded; no external ticket API calls are made.
