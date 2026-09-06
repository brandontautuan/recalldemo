# Engineering Decision Pipeline

## 1. Overview

Engineering Decision Pipeline is a customer-facing reference application built on top of Recall.ai. Recall owns the meeting infrastructure: visible bot execution, meeting capture, recording, transcription, participant data, and webhook events. This application owns the bounded, manually initiated engineering-analysis workflow that turns ready transcripts and supplied project context into reviewable engineering artifacts.

The application demonstrates how a developer can use Recall’s meeting infrastructure to turn architecture reviews, sprint planning meetings, incident reviews, and technical discussions into structured engineering artifacts.

The application is not intended to be a complete project-management platform. It is a focused proof of concept showing how Recall meeting data can power:

* Architecture Decision Records
* Engineering action items
* Structured bug reports
* Risks and open questions
* Evidence-linked transcript review
* Proposed acceptance criteria and Linear/Jira-compatible ticket drafts

The central product principle is:

> Generated engineering artifacts must remain traceable to the conversation that produced them.

After an explicit user request, the analysis runs within defined stages, structured schemas, and validation rules. It is not an open-ended multi-agent loop and must not claim to know information absent from the transcript or supplied project context.

The final product positioning is:

> A human-in-the-loop engineering meeting assistant that uses Recall to capture meetings, normalizes transcripts into reliable evidence, proposes structured engineering artifacts through an explicitly triggered analysis step, and lets users review, approve, and locally export the results without taking external action.

Groq is described throughout the product as a human-triggered analysis step or bounded artifact-extraction service, not as an agent. The product is an evidence-review workflow, not an autonomous project-management agent.

## 2. Target User

The primary user is an engineering manager, technical project manager, product manager, or software engineer who needs to convert technical meetings into reliable follow-up work.

Example meetings include:

* Architecture reviews
* Sprint planning
* Incident reviews
* Technical design discussions
* Product-engineering syncs
* Bug triage meetings
* Project kickoff meetings

## 3. Problem

Important technical decisions and commitments are often buried in meeting recordings or notes.

After a meeting, teams commonly need to reconstruct:

* What was decided?
* Why was it decided?
* Which alternatives were rejected?
* Who owns each task?
* What are the acceptance criteria?
* What risks remain?
* Which issues need to be escalated?

Manually converting a meeting into ADRs, tickets, and follow-up notes is time-consuming and inconsistent.

Recall provides the meeting recording, transcript, participant data, and timestamps. This application demonstrates the product layer built on top of that infrastructure.

## 4. Product Flow

### Primary URL-Based Flow

```text
User enters meeting URL
    ↓
Application creates Recall bot
    ↓
Recall bot joins meeting
    ↓
Recall records and transcribes meeting
    ↓
Recall sends webhook events
    ↓
Application updates meeting status
    ↓
Application retrieves completed transcript
    ↓
Transcript is normalized and ingested
    ↓
Optional deterministic project-context retrieval
    ↓
User explicitly requests bounded Groq engineering analysis
    ↓
Artifacts are evidence- and schema-validated
    ↓
User reviews queued artifacts with transcript evidence
    ↓
User approves, edits, rejects, or exports artifacts
```

### Manual Analysis Pipeline

After a verified Recall webhook confirms that a transcript is ready, the application waits. Only an explicit user action runs this bounded pipeline:

```text
Recall webhook → Transcript ingestion → Ready state
    → User selects optional project/context preview (no LLM)
    → Deterministic project-context retrieval
    → Explicit user confirmation to send the displayed snapshot to Groq
    → Engineering analysis
    → Artifact generation
    → Evidence and schema validation
    → Human review queue
    → Approved export
```

Each stage receives only the normalized transcript, the bounded output of prior stages, and supplied or retrieved project context. A failed or invalid stage produces a reviewable failure state; it does not trigger unconstrained retries, autonomous external actions, or unsupported conclusions.

### Calendar-Based Flow

Calendar scheduling is a secondary flow.

```text
User connects Google Calendar
    ↓
Application receives calendar events
    ↓
Only events containing [recall] are eligible
    ↓
Application schedules a Recall bot
    ↓
Recall sends webhook status updates
    ↓
User may manually request meeting artifacts after completion
```

Calendar recording must be opt-in. The application must not record every calendar event by default.

## 4.1 Responsibility Boundaries

### Recall infrastructure

Recall provides meeting capture, bot execution, recordings, transcription, participant data, and signed lifecycle/webhook events. Recall is the source of meeting artifacts; it does not make the application's engineering decisions.

### Application backend

The backend owns Recall credentials, verified webhook ingestion, local persistence, transcript normalization, project-context handling, and the APIs used by the review interface. It translates Recall resources into internal application models rather than passing raw Recall responses throughout the product.

### Manual analysis pipeline

After an explicit user request, the pipeline combines its normalized transcript with explicitly supplied context and, when the user has selected a project, a deterministic bounded project-context snapshot. It proposes engineering artifacts through Groq. It never runs automatically after transcript readiness and is bounded by defined stages and structured input/output schemas.

### Deterministic validation

Deterministic code validates transcript structure, artifact schemas, evidence references, timestamps, allowed values, duplicate artifacts, and export format. It calculates descriptive transcript metrics such as talk time. It does not use an LLM to confirm unsupported facts.

### Human approval and export

Generated artifacts enter a human review queue. A user may edit, approve, reject, or request more information before export. Only approved artifacts may be exported as Linear/Jira-compatible drafts.

## 4.2 Canonical Meeting State Machine

The application should present a small canonical lifecycle while retaining Recall's original event type, status code, sub-code, message, and event time in history for diagnosis. Granular Recall states such as waiting-room and recording-permission events map into the canonical states rather than expanding the user-facing state machine.

The allowed canonical meeting states are:

```text
created
bot_scheduled
joining
in_call
recording
transcript_processing
completed
failed
```

Their meanings are:

| State | Meaning |
| --- | --- |
| `created` | The application has validated and persisted the meeting request. |
| `bot_scheduled` | Recall accepted a future bot join time; immediate joins may skip this state. |
| `joining` | The bot is attempting to enter the call, including the waiting-room state. |
| `in_call` | The bot entered the call but is not yet confirmed to be recording. |
| `recording` | Recall confirmed active recording. |
| `transcript_processing` | The call or recording ended and transcript creation, retrieval, or normalization is in progress. |
| `completed` | A normalized transcript is stored and ready for optional manual analysis. |
| `failed` | The current capture attempt reached a fatal or unrecoverable state. |

Allowed forward transitions are:

```text
created → bot_scheduled | joining | in_call | recording | transcript_processing | completed | failed
bot_scheduled → joining | in_call | recording | transcript_processing | completed | failed
joining → in_call | recording | transcript_processing | completed | failed
in_call → recording | transcript_processing | completed | failed
recording → transcript_processing | completed | failed
transcript_processing → completed | failed
completed → terminal
failed → terminal for that capture attempt
```

The current state may repeat when distinct provider events map to the same canonical state. Some intermediate states may be skipped when Recall delivers a later authoritative event first. Skipping is allowed; regression is not. For example, `recording` may arrive before `joining`, but a later-delivered older `joining` event must be inserted into history without moving the current state backward. A fatal event is sticky for its capture attempt and cannot be hidden by a later `bot.done` delivery.

`completed` and `failed` are terminal meeting-capture states. Manual transcript recovery or a new bot attempt creates a separately recorded retry attempt rather than erasing the terminal history. Artifact analysis has its own state machine:

```text
not_started → running → completed | failed
failed → running only through a new explicit user-triggered analysis job
```

Analysis failure never changes a successfully captured meeting from `completed` to `failed`. The implementation preserves raw event-time history, makes fatal bot events sticky per lifecycle attempt, normalizes the canonical display state, and enforces forward-only transitions.

## 5. MVP Scope

The minimum viable product must include:

1. Meeting URL input.
2. Recall bot creation.
3. Bot status tracking.
4. Recall webhook handling.
5. Transcript retrieval.
6. Transcript display.
7. Speaker and timestamp preservation.
8. Engineering artifact extraction.
9. Evidence-linked artifact review.
10. Export of approved tickets as JSON.
11. Mock/demo mode for reliable presentation.
12. Clear README documentation.

Calendar integration should be implemented only after the URL-based flow is stable.

The MVP must not automatically create external Jira or Linear tickets, modify source code, change architecture documents, assign people without transcript evidence, treat assumptions as confirmed decisions, or execute external actions without human approval.

## 6. Main Application Screens

### 6.1 Meeting Launcher

The user can:

* Paste a Zoom, Google Meet, or Microsoft Teams meeting URL.
* Enter an optional meeting title.
* Select the meeting type:

  * Architecture review
  * Sprint planning
  * Incident review
  * Bug triage
  * General technical sync
* Launch the Recall bot.
* View any validation or API errors.

The interface should clearly communicate that the bot is being sent to the meeting.

### 6.2 Meeting Status Page

Display the lifecycle of the Recall bot:

* Created
* Joining
* In waiting room
* Recording
* Processing
* Complete
* Fatal/failed

The page should show:

* Meeting URL
* Bot ID
* Meeting title
* Current status
* Status history
* Created time
* Last update time
* Error information, if available

The frontend should receive status from the application backend rather than directly calling Recall.

### 6.3 Meeting Intelligence Dashboard

After processing completes, display:

* Meeting title and date
* Participants
* Meeting duration
* Talk-time distribution
* Extracted decisions
* Action items
* Risks
* Open questions
* Bug reports
* Processing status

The dashboard should distinguish between:

* Transcript evidence
* Deterministic calculations
* LLM-generated interpretation

It should also show supplied project context separately from transcript evidence and generated interpretation.

### 6.4 Evidence Workspace

The evidence workspace contains:

* A list of generated artifacts on the left.
* The transcript on the right.
* Speaker labels.
* Timestamps.
* Highlighted supporting transcript segments.

When the user selects an artifact, the transcript should:

1. Scroll to the supporting timestamp.
2. Highlight the relevant utterance or segment.
3. Display the speaker who said it.
4. Show the evidence text used to generate the artifact.

If an artifact has weak or missing evidence, the UI should say so instead of fabricating a citation.

### 6.5 Review and Export

Users can:

* Approve an artifact.
* Edit an artifact.
* Reject an artifact.
* Mark an artifact as requiring more information.
* Export approved action items as JSON.

The application should not automatically create Linear or Jira tickets in the MVP. It should produce a compatible payload that could later be sent to those systems.

## 7. Generated Artifacts

### 7.1 Architecture Decision Record

An ADR should contain:

```json
{
  "type": "architecture_decision",
  "title": "Use PostgreSQL for the event store",
  "status": "proposed",
  "context": "The team needs transactional writes and relational queries.",
  "decision": "Use PostgreSQL as the primary event store.",
  "alternativesRejected": [
    {
      "alternative": "DynamoDB",
      "reason": "The team expects complex relational queries."
    }
  ],
  "consequences": [
    "The team must manage relational schema migrations.",
    "The application gains stronger transactional guarantees."
  ],
  "evidence": [
    {
      "speaker": "Alex",
      "startTime": 1122.4,
      "endTime": 1168.2,
      "text": "..."
    }
  ],
  "confidence": "high"
}
```

### 7.2 Engineering Action Item

```json
{
  "type": "action_item",
  "title": "Fix responsive clipping in the infrastructure dashboard",
  "description": "The dashboard clips chart labels at smaller screen widths.",
  "assignee": "Alex",
  "dueDate": null,
  "acceptanceCriteria": [
    "Chart labels remain visible at 1280px width.",
    "A responsive layout regression test is added."
  ],
  "priority": "medium",
  "status": "proposed",
  "evidence": [
    {
      "speaker": "Alex",
      "startTime": 1894.1,
      "endTime": 1925.8,
      "text": "..."
    }
  ],
  "confidence": "medium"
}
```

### 7.3 Bug Report

Bug reports should only include reproduction steps when the meeting explicitly contains them.

```json
{
  "type": "bug_report",
  "title": "Infrastructure dashboard clips chart labels",
  "description": "Chart labels are partially hidden on smaller screens.",
  "stepsToReproduce": [
    "Open the infrastructure dashboard.",
    "Resize the browser to 1280px width.",
    "Open the latency chart."
  ],
  "expectedBehavior": "All chart labels remain visible.",
  "actualBehavior": "Some chart labels are clipped.",
  "severity": "medium",
  "evidence": [
    {
      "speaker": "Jordan",
      "startTime": 2012.3,
      "endTime": 2050.7,
      "text": "..."
    }
  ],
  "confidence": "medium"
}
```

The application must not claim to understand visual screen-share content unless that content is explicitly processed. Transcript-derived bug reports should be labeled accordingly.

### 7.4 Risk

```json
{
  "type": "risk",
  "title": "Migration may cause downtime",
  "description": "The proposed database migration could affect availability during deployment.",
  "impact": "high",
  "mitigation": "Test the migration against a production-sized dataset and prepare a rollback plan.",
  "owner": null,
  "evidence": [],
  "confidence": "medium"
}
```

### 7.5 Open Question

```json
{
  "type": "open_question",
  "question": "Should the event store support multi-region writes?",
  "context": "The team discussed regional availability but did not reach a conclusion.",
  "suggestedOwner": null,
  "evidence": [],
  "confidence": "high"
}
```

### 7.6 Proposed Acceptance Criteria

The pipeline may propose acceptance criteria for a decision, action item, or ticket draft when they are supported by transcript evidence or supplied project context. Each criterion must be marked proposed until human approval and must retain evidence references or a clear note that it came from supplied context.

### 7.7 Linear/Jira-Compatible Ticket Draft

A ticket draft is an internal, reviewable artifact containing title, description, priority, proposed acceptance criteria, and evidence. It is exportable only after approval; the pipeline must never create or update an external ticket directly.

## 8. Talk-Time Analytics

Talk-time analytics should be calculated from the structured transcript rather than guessed by the LLM.

Metrics may include:

* Total meeting duration
* Total speaking time per participant
* Speaking percentage per participant
* Number of utterances per participant
* Average utterance duration
* Number of participants

The user should be able to identify the engineering lead or meeting host manually if role assignment is ambiguous.

Do not assume the meeting host is always the engineering lead.

Talk-time analytics are descriptive only. The application should not automatically label a participant as effective or ineffective based solely on speaking time.

## 9. Recall Integration

Recall-specific code must be isolated behind a dedicated integration layer.

Suggested modules:

```text
server/
├── recall/
│   ├── recall-client.ts
│   ├── recall-types.ts
│   ├── recall-webhooks.ts
│   └── recall-transcripts.ts
```

The Recall integration should support:

* Create bot
* Retrieve bot
* Process bot status
* Receive webhook events
* Retrieve transcript
* Retrieve recording metadata
* Retrieve participant data
* Handle Recall API errors

The rest of the application should use internal application types instead of raw Recall response objects.

## 9.1 Project Context Retrieval (Required for the bounded-context take-home)

The original inline `projectContext` field is sufficient for ad hoc notes, but it cannot provide the requested repeatable project-context flow. To support seeded project metadata, README excerpts, repository metadata, and existing tickets, the take-home uses a small local project-context store. SQLite is the appropriate persistence layer: it is transactional, portable, supports a checked-in migration/seed workflow, and avoids introducing a managed service for a demo. The existing JSON store remains adequate only for the transcript/artifact demo and must not be described as supporting retrieved project context.

This is deliberately a local, deterministic corpus—not a live project-management or repository integration. Seed files are reviewed application inputs. The application does not fetch GitHub, Linear, Jira, or documentation systems during analysis.

### Required models

```text
projects
  id, slug, name, description, terminology_json, ticket_format_json,
  created_at, updated_at

repositories
  id, project_id, name, remote_url, default_branch, metadata_json, local_path nullable,
  approved_files_json,
  created_at, updated_at

context_documents
  id, project_id, repository_id nullable, kind, title, source_path,
  content, content_sha256, revision, is_active, ingestion_id nullable,
  line_start nullable, line_end nullable, approved_at nullable, created_at, updated_at

context_ingestions
  id, project_id, repository_id, status, commit_version nullable,
  source_fingerprint, tracked_files_json, created_at, approved_at nullable

work_items
  id, project_id, external_key nullable, title, description, status,
  priority nullable, labels_json, source_url nullable, updated_at

meeting_project_context
  meeting_id, project_id, selected_at

context_selections
  id, meeting_id, analysis_id nullable, project_id, selection_json, content_sha256,
  character_count, created_at, approved_at nullable

analysis_runs
  id, meeting_id, project_id nullable, context_selection_id nullable,
  status, provider, model nullable, error_code nullable, created_at, completed_at nullable
```

`kind` is a closed set for this scope: `project_metadata`, `readme_excerpt`, `repository_metadata`, and `work_item_snapshot`. `content_sha256` and the persisted selection snapshot make it possible to show exactly which non-transcript context informed a proposal after a seed changes. A preview selection is created without an `analysis_id` and linked to the resulting analysis only after the user confirms it. Context is supporting background, never transcript evidence; artifact evidence links must still resolve only to normalized transcript utterances.

### Deterministic ingestion and retrieval

A versioned local seed manifest supplies project metadata, repository records, bounded README/document excerpts, and existing-ticket snapshots. A one-shot backend/CLI ingestion command validates the manifest, normalizes whitespace and identifiers, upserts by stable IDs, records content hashes and revisions, and rejects unsupported document kinds or oversized entries. It performs no LLM call, network fetch, or background work.

A local repository configuration is a backend ingestion source, never an LLM tool or prompt value. The browser may configure a path only when its resolved location is inside a server-configured `PROJECT_REPOSITORY_ROOTS` allowlist. Enabling those roots requires a separate server-side project-context admin token, supplied explicitly for configuration and ingestion operations and never returned to browser code. A scan reads only explicit relative approved-document paths, rejects traversal, symlinks, secret-like names, denied dependency/build directories, unsupported extensions, and size-limit violations, and stages bounded excerpts as inactive documents. Git commit and bounded tracked-file paths are metadata only. The user must review and approve the staged ingestion before its documents become selectable. A changed commit, working-tree state, tracked-file set, or approved excerpt changes the deterministic fingerprint and blocks preview/analysis until a new ingestion is approved. Older ingestions and immutable selections are retained.

The user explicitly selects a project when launching a meeting or before analysis. The backend persists that association and, on an explicit context-preview request that makes no LLM call, constructs a context snapshot in this fixed order:

1. Selected project metadata and ticket-format constraints.
2. Metadata for repositories belonging to that project.
3. Active README/document excerpts, ordered by explicit manifest priority and stable ID.
4. Open work items, ordered by deterministic lexical overlap with normalized meeting title, optional user context, and transcript terms; then by manifest priority, `updated_at`, and stable ID. If there is no overlap, include no work items rather than guessing relevance.

The selector uses only deterministic token normalization and ordering; it is not a classifier, embedding search, agent, or LLM. It returns source IDs, labels, revisions, and text under a separate context character budget. If the resulting context does not fit, lower-priority items are omitted and the response records the omission. The analysis request accepts the immutable preview selection ID plus the user's optional ad hoc context, while the existing total Groq input limit remains the final bound. The UI must disclose the selected project/context sources before the existing confirmation dialog and display them separately from transcript evidence.

Detailed ticket proposals may include summary, problem/requested change, rationale, proposed implementation areas, acceptance criteria, dependencies, risks, open questions, suggested priority, and a suggested owner only when supported by a participant statement. Repository references are structured as an approved context source ID plus an exact tracked or approved-document path and, for excerpts, the stored line range. Validation rejects paths, ranges, owners, or source IDs absent from the approved snapshot. Unsupported fields remain `null` or empty rather than being inferred.

### MCP decision

MCP is not necessary for this take-home. The only required external calls remain the existing Recall and user-triggered Groq calls. Introducing live MCP calls to repositories, issue trackers, or document stores would add credentials, availability, prompt-injection, freshness, and audit concerns without being needed for seeded, deterministic context. A production connector may use MCP or a direct provider client later, but it must ingest into the same validated local snapshot before analysis; it must never give the model live tool access.

## 10. Backend Endpoints

Suggested application endpoints:

```text
POST /api/meetings
```

Creates a Recall bot for a submitted meeting URL.

```text
GET /api/meetings
```

Lists locally stored meetings.

```text
GET /api/meetings/:id
```

Returns meeting metadata, status, and processing state.

```text
POST /webhooks/recall
```

Receives Recall webhook events.

```text
GET /api/meetings/:id/transcript
```

Returns the normalized transcript.

```text
GET /api/projects
GET /api/projects/:id/context
```

Lists selectable seeded projects and returns the bounded, reviewable context sources for one project. These routes do not contact external systems.

```text
POST /api/meetings/:id/context-preview
```

Accepts `{ "projectId": "...", "projectContext": "..." }`, validates the completed meeting and selected project, and creates the deterministic persisted context snapshot described in section 9.1. It does not invoke Groq. The client displays this snapshot and its omissions before requesting analysis.

```text
POST /api/meetings/:id/analyze
```

The only Groq-invoking route. It accepts optional `{ "contextSelectionId": "...", "projectContext": "..." }` after transcript completion and user confirmation. The server verifies that the saved selection belongs to the meeting and has not been altered, links it to the analysis job, and includes the persisted bounded snapshot. A client may not submit arbitrary retrieved-document text or source identifiers.

```text
GET /api/meetings/:id/artifacts
```

Returns generated engineering artifacts.

```text
POST /api/meetings/:id/process
```

Starts or retries transcript processing.

```text
PATCH /api/artifacts/:id
```

Updates an artifact during review.

```text
POST /api/artifacts/:id/approve
```

Approves an artifact.

```text
POST /api/artifacts/:id/reject
```

Rejects an artifact.

```text
POST /api/meetings/:id/export
```

Returns a Linear/Jira-compatible JSON representation.

Calendar endpoints, if implemented:

```text
GET /api/calendar/connect
GET /api/calendar/callback
POST /api/calendar/webhooks
GET /api/calendar/events
```

## 11. Data Model

The application should persist enough data to support retries, review, and evidence navigation.

### Meeting

```text
id
recallBotId
meetingUrl
title
meetingType
status
statusHistory
participants
startedAt
endedAt
durationMs
transcriptStatus
processingStatus
createdAt
updatedAt
```

### Transcript Utterance

```text
id
meetingId
speakerId
speakerName
text
startTime
endTime
confidence
```

### Artifact

```text
id
meetingId
type
status
title
content
confidence
evidence
createdAt
updatedAt
```

### Webhook Event

```text
id
eventId
eventType
recallBotId
payload
receivedAt
processedAt
processingStatus
```

Webhook events should be persisted or otherwise deduplicated so repeated delivery does not create duplicate meetings, artifacts, or status transitions.

### Project Context

The SQLite schema in section 9.1 is required when the seeded-context feature is enabled. `meeting_project_context` is optional for meetings without a selected project. `context_selections` stores a preview snapshot before confirmation and links it to an analysis only after Groq is invoked; it never stores an unbounded corpus dump.

For the take-home, project context is single-tenant and seeded by a trusted local manifest. No user/organization tables, external-account tokens, sync cursors, vector indexes, or background queues are required.

## 12. Processing Pipeline

The processing pipeline should be explicit:

```text
Recall webhook received
    ↓
Validate webhook
    ↓
Deduplicate event
    ↓
Update meeting status
    ↓
Determine whether processing can begin
    ↓
Retrieve transcript
    ↓
Normalize transcript
    ↓
Calculate deterministic analytics
    ↓
Wait for explicit analysis request
    ↓
Validate optional selected project and retrieve a deterministic bounded context snapshot
    ↓
Run bounded engineering analysis and generate structured artifact proposals
    ↓
Validate schemas, evidence references, timestamps, and unsupported claims
    ↓
Persist proposed artifacts in the human review queue
    ↓
Approve, reject, edit, or export approved artifacts
```

The analysis model must not receive raw application secrets, unrelated meetings, or unnecessary recording data.

The analysis stage should receive only:

* Meeting type
* Participant list
* Normalized transcript
* Available timestamps
* Optional user-entered project notes
* Optional persisted project-context snapshot, with source IDs and revisions
* Extraction schema
* Instructions to avoid unsupported claims, unsupported assignments, and autonomous external actions

Retrieved project context may clarify terminology or existing work, but it must not be converted into transcript evidence. The model is instructed to use it as background only; generated claims remain proposed and require transcript evidence where the artifact schema requires evidence.

## 13. Analysis Output Rules

Generated analysis output must be parsed and validated against a schema.

For Phase 5, Groq is the sole LLM provider. Analysis is initiated only by an explicit user action on a completed normalized transcript. Transcript completion, Recall webhooks, application startup, mock-mode startup, and background processing must never invoke Groq automatically. There is no automatic fallback provider and no feature flag that silently changes providers.

The backend must enforce a small configurable concurrency limit, honor Groq rate-limit response headers and `Retry-After`, bound retry delays within the same manual request, and expose a retryable error when capacity is unavailable. It must not invent local request-per-minute or token-per-minute quotas that can drift from the Groq project's actual limits.

The application must handle:

* Invalid JSON
* Missing fields
* Unknown artifact types
* Empty arrays
* Unsupported assignees
* Invalid timestamps
* Claims without evidence
* Duplicate artifacts
* Overly vague action items

The analysis stage may propose artifacts, but the user must approve them before export.

The application must clearly label generated content as proposed until reviewed. It must reject or flag artifacts with invalid schemas, missing or invalid evidence, unsupported assignees, invalid timestamps, or claims that cannot be traced to the transcript or supplied project context.

Project context must be sent as a labeled, bounded snapshot rather than merged into transcript utterances. The artifact renderer must identify context-informed interpretation separately; only authoritative stored transcript excerpts may populate an artifact's evidence list.

## 14. Calendar Scheduling

Calendar integration is secondary to the URL-based flow.

Initial calendar behavior:

* Connect one Google Calendar account.
* Only process events whose title contains `[recall]`.
* Ignore all other events.
* Do not automatically record past events.
* Do not create duplicate bots for the same event.
* Store the calendar event ID and associated Recall bot ID.
* Show scheduled events and their recording status.

Example eligible event:

```text
Architecture Review: Event Store [recall]
```

Example ignored event:

```text
Weekly Team Lunch
```

Calendar functionality may be deferred if it threatens the stability of the primary bot workflow.

## 15. Error Handling

The application should display clear user-facing errors for:

* Invalid meeting URL
* Unsupported platform
* Recall API authentication failure
* Bot unable to join
* Bot stuck in a waiting room
* Meeting ended without a recording
* Transcript unavailable
* Webhook delivery failure
* Transcript processing failure
* Analysis extraction failure
* Calendar authentication failure
* Duplicate calendar event
* Missing public callback URL
* Unknown, inactive, or unavailable selected project
* Invalid project-context seed manifest
* Context snapshot exceeding its configured bound

If context ingestion or retrieval fails, the manual analysis request fails clearly and does not fall back to live retrieval, an LLM-generated summary, or arbitrary client-provided context documents. A user may retry without selecting a project and use the existing bounded ad hoc context field.

Errors should be logged with enough context to debug them without exposing secrets.

### 15.1 Retry and failure behavior

All retryable failures must have a short user-safe message, a stable internal failure code, and an explicit retry action. Retrying must not silently repeat external work or erase the original attempt.

| Failure | Persisted behavior | User-visible recovery |
| --- | --- | --- |
| Recall bot creation fails | Keep the meeting request and record a failed bot-attempt code without guessing whether an ambiguous request succeeded. | Explain that the user must create a new meeting request. Do not expose one-click retry for an ambiguous create operation. |
| Webhook is duplicated | Deduplicate by verified Recall delivery ID, acknowledge it, and perform no lifecycle or transcript work twice. | No user action; history remains unchanged. |
| Webhooks arrive out of order | Store valid events in event-time order, preserve raw Recall details, and never regress the canonical current state. Fatal history remains sticky. | Offer `Reconcile status` when the displayed state appears stale. |
| Transcript creation, download, or normalization fails | Persist a specific transcript failure code, release only the safe processing claim needed for retry, and retain meeting and recording/transcript identifiers. | Show `Retry processing`; reuse Recall's existing artifacts instead of creating a new bot. |
| Groq times out, is rate-limited, or is unavailable | Mark that manual analysis job failed and keep the completed transcript and previously reviewed artifacts. Respect provider retry timing. | Show a retryable error; another attempt requires a fresh click and confirmation. |
| Groq returns malformed or schema-invalid output | Persist `invalid_output` with validation issues and do not save or replace proposals from that response. | Explain that extraction failed validation and allow a new explicit attempt. |
| User retries selected-context analysis | A snapshot linked to an attempted analysis remains single-use, even when the provider fails. Reviewed artifacts remain untouched; only a later valid response may replace unreviewed proposals. | Require a new context preview, show the disclosure again, and require confirmation. |

The UI does not claim that bot creation can be retried in place. Relaunching a failed meeting as a new request is the safe fallback because an ambiguous create request may have succeeded remotely without returning an ID. Transcript processing recovery starts a numbered lifecycle attempt, while status reconciliation and manual analysis use their existing explicit jobs.

## 16. Mock and Demo Mode

The application must include a mock mode so the end-to-end product can be demonstrated without relying entirely on a live meeting.

Mock mode should provide:

* Sample meeting
* Sample participants
* Sample transcript
* Sample timestamps
* Sample ADR
* Sample action items
* Sample bug report
* Sample risks
* Sample webhook status progression

The UI should clearly indicate when mock data is being used.

Live mode must remain the primary documented integration path.

### 16.1 Deterministic demo reset

Mock mode should expose a **Reset demo** action so an evaluator can repeat the golden path without deleting files manually. The reset contract is:

* It is available only when `MOCK_MODE=true`; live mode returns `404` or `403` and shows no reset control.
* The UI requires confirmation and explains that only labeled fixture state will be replaced.
* `POST /api/demo/reset` accepts no arbitrary record IDs and resets only the known mock meeting, transcript, analytics, analysis jobs, artifact proposals, and review events.
* It does not delete live meetings, the project-context corpus, migrations, API keys, or environment files.
* It reloads the same deterministic fixture IDs and content on every run, making the action idempotent.
* It performs no Recall, Groq, calendar, Linear, Jira, MCP, or other network call.
* The response returns the refreshed dashboard model or a success result that the browser follows with `GET /api/dashboard`.

A separate **Load fixture** action is unnecessary if reset safely restores the fixture. The reset endpoint, store behavior, and browser control require deterministic tests.

## 17. Security and Privacy

* Store Recall API keys only on the backend.
* Never expose secrets to browser JavaScript.
* Do not commit `.env` files.
* Include `.env.example` with placeholder values.
* Validate webhook authenticity according to Recall’s documented mechanism.
* Avoid logging full transcripts by default.
* Avoid recording all calendar events.
* Explain the recording behavior to the user.
* Keep the application suitable for demo data rather than claiming enterprise compliance.
* Treat seeded context documents and ticket snapshots as untrusted data: they are never instructions, are size-limited, and are not exposed to the browser unless selected for a user-confirmed analysis.
* Keep project-context database files and seed inputs out of public static directories and do not log their full contents.

### 17.1 Demo privacy and retention policy

This reference application uses a simple, explicit demo-data policy:

* Normalized transcripts, lifecycle history, analysis jobs, artifact proposals, and review events are stored locally in the application's JSON data store until the developer deletes the data. The scoped mock reset replaces only labeled fixture state. There is no automatic retention timer in the take-home.
* Seeded project context and immutable context selections are stored locally in SQLite. Private `*.local.json` seed overrides and generated database files remain ignored by Git.
* The application stores recording and transcript identifiers needed for processing but does not download or persist the meeting recording media itself.
* A normalized transcript is sent to Groq only after the user clicks the analysis action and confirms the disclosure. Transcript completion, webhooks, startup, timers, preview generation, and demo reset never invoke Groq.
* Recall and Groq API keys and Recall webhook secrets remain server-side environment values and are never returned to browser code.
* Mock meetings, transcripts, analytics, and artifact proposals are visibly labeled as fixture data.
* Export is generated locally and never automatically submits to Linear, Jira, Recall, Groq, or another external system.
* The take-home makes no enterprise retention, encryption, compliance, or deletion-guarantee claim. A production system requires organization-level retention rules, access control, encryption, and auditable deletion.

## 17.2 Take-Home Context Operations

The bounded project-context feature requires the following local operational additions:

* A SQLite migration applied before serving requests, creating the tables in section 9.1 and a schema-version record. The migration is additive; do not mutate existing meeting/transcript/artifact records in place.
* A deterministic seed command run deliberately by the developer (for example, `npm run seed-context`), after migrations. It is not an application startup task or recurring job.
* `DATABASE_PATH` for the SQLite file and `PROJECT_CONTEXT_SEED_PATH` for the local versioned manifest. `PROJECT_CONTEXT_MAX_CHARACTERS` provides a separate selected-context ceiling. Existing `GROQ_MAX_INPUT_CHARACTERS` remains an upper bound on the combined transcript, ad hoc context, and selected snapshot.
* A persistent writable volume for the SQLite database in any deployed demo. Ephemeral/serverless filesystems are unsuitable unless they mount persistent storage. No new hosted database, queue, worker, cron job, OAuth credential, MCP server, or inbound webhook is required.

The application retains its JSON demonstration store for meetings and artifacts and implements the retrieved seeded-context flow through SQLite migrations, deliberate seeding, deterministic preview routes, and browser disclosure. The inline notes-only flow remains available when a project is not selected.

### Future production extensions (not required)

Multi-tenant authorization, encrypted managed storage, document lifecycle/retention policies, repository/Linear/Jira connectors, incremental sync jobs, audit access controls, semantic retrieval, and provider-specific MCP connectors are production extensions. If added, they must write validated, versioned context records before manual analysis and retain the same bounded-snapshot, no-live-tool-access guarantee.

## 18. Non-Goals

The MVP will not include:

* Full Linear integration
* Full Jira integration
* Slack notifications
* Multi-tenant authentication
* Billing
* Team permissions
* Live MCP calls during analysis
* Live repository, documentation, Linear, or Jira retrieval during analysis
* Automatic task execution
* Autonomous code changes
* Real-time meeting coaching
* Computer vision analysis of shared screens
* Production-grade compliance certifications
* Support for every calendar provider
* A full project-management replacement

### 18.1 Take-home prioritization and deliberate deferrals

The polished direct-URL demo, canonical export, deterministic project-context snapshot, and golden-path reliability test take priority over feature breadth. The following work must not delay that path:

* Full Google Calendar OAuth and scheduling UI.
* Additional live repository, documentation, Jira, Linear, MCP, embedding, or autonomous-agent retrieval.
* Production queue, worker, scheduler, or distributed rate-limiter infrastructure.
* Multi-user authentication, conflict resolution, permissions, and actor identity.
* Additional lifecycle analytics beyond the canonical state and existing descriptive talk-time metrics.
* Further complexity in proposal replacement and version semantics beyond preserving reviewed artifacts.
* Additional export formats or direct external submission.

Canonical JSON is the primary take-home export and should receive the end-to-end acceptance test. The already implemented Linear and Jira-compatible drafts may remain as documented extensions, but they should not expand or block the main demo.

The project-context feature remains local, bounded, deterministic, and deliberately seeded. It must not become live GitHub, Jira, Linear, MCP, embedding, or autonomous retrieval for this scope.

## 19. Implementation Order

### Phase 1: Inspect and Configure

* Read the Recall onboarding documentation.
* Verify the target workspace and region.
* Configure the API key.
* Configure the webhook endpoint.
* Confirm the backend can communicate with Recall.
* Use the API Explorer to inspect real request and response payloads.

### Phase 2: Basic Bot Flow

* Build meeting creation endpoint.
* Validate meeting URLs.
* Call Recall’s bot creation API.
* Persist the application meeting and Recall bot ID.
* Display the bot status.

### Phase 3: Webhooks

* Implement webhook endpoint.
* Validate incoming events.
* Persist event IDs.
* Make webhook processing idempotent.
* Update meeting status from webhook events.
* Add error handling for failed states.

### Phase 4: Transcript Processing

* Retrieve the completed transcript.
* Normalize speaker and timestamp data.
* Display transcript content.
* Calculate talk-time metrics.
* Add mock transcript support.

### Phase 5: Bounded Manual Engineering Analysis

* Define structured schemas for ADRs, action items, bug reports, risks, open questions, proposed acceptance criteria, and ticket drafts.
* Preserve the existing bounded ad hoc project-context field.
* Add the SQLite project-context schema, migration, deterministic seed command, and selected-context snapshot audit record described in section 9.1.
* Add project selection/context-preview APIs and bind a selected project to the meeting or manual analysis request.
* Implement deterministic, character-bounded retrieval from seeded metadata, README/document excerpts, repository metadata, and existing work-item snapshots; do not add MCP, embeddings, live provider calls, or a background sync.
* Implement bounded context retrieval, engineering analysis, and artifact generation through an explicit manual action after transcript readiness.
* Use Groq as the sole LLM provider and do not invoke it from webhooks, transcript completion, startup, or background work.
* Enforce backend concurrency, input-size, timeout, retry, and provider-reported rate-limit bounds.
* Validate generated output, evidence references, timestamps, assignments, and unsupported claims deterministically.
* Persist valid proposals in a human review queue and persist invalid results as actionable processing failures.

### Phase 6: Evidence Review

* Build artifact cards.
* Build transcript navigation.
* Link artifacts to timestamps.
* Add approve, edit, and reject actions.
* Add confidence and evidence states.
* Preserve immutable original proposals, version user edits, and record append-only review events.
* Prevent reanalysis from replacing artifacts that have entered a reviewed state.

### Phase 7: Export

* Generate canonical approved-artifact JSON as the primary take-home export.
* Add copy-to-clipboard and download functionality.
* Document how external systems could consume the payload.
* Export only user-approved artifacts; do not call external ticket APIs.
* Require explicit artifact IDs and current versions so stale or cross-meeting selections cannot be exported.
* Preserve meeting metadata, approval state, provenance, and transcript evidence in the canonical export.
* Keep the existing Linear and Jira-compatible drafts as secondary extensions and emit mapping hints instead of inventing workspace-specific identifiers.

### Phase 8: Calendar Extension

Deferred until after the complete direct-URL golden path and demo reset are verified.

* Connect Google Calendar.
* Implement `[recall]` opt-in filtering.
* Schedule bots for eligible events.
* Display scheduled meeting status.
* Prevent duplicate scheduling.

### Phase 9: Documentation and Verification

* Update README.
* Add architecture diagram.
* Add setup instructions.
* Add API and webhook documentation.
* Add mock mode instructions.
* Run tests, type checks, formatting, and linting.
* Perform a complete manual demo.

### Phase 10: Canonical Lifecycle and Recovery Contract — Implemented

* Add a single canonical meeting-state mapper implementing section 4.2 while preserving raw Recall events.
* Enforce allowed forward transitions and skipped-state behavior without regressing on out-of-order delivery.
* Keep `completed` and `failed` terminal per capture attempt and represent manual retries as separate attempts or jobs.
* Render stable failure codes, user-safe messages, and only the recovery actions valid for the current failure.
* Add transition-table tests, including duplicate, out-of-order, skipped-state, fatal-then-done, and reconciliation cases.

### Phase 11: Deterministic Demo Reset — Implemented

* Add the mock-only `POST /api/demo/reset` endpoint and narrowly scoped store reset operation.
* Add the confirmed **Reset demo** control and restore the known fixture to its initial reviewable state.
* Prove idempotency, fixture-only deletion, live-mode denial, and zero external calls.
* Update mock-mode documentation with the repeatable evaluator flow.

### Phase 12: Golden-Path Integration Test — Implemented

Add one headless integration test or documented test script using mocked Recall and Groq boundaries:

```text
create meeting
  → receive signed lifecycle webhook
  → receive signed transcript webhook
  → retrieve and normalize transcript
  → explicitly request analysis
  → validate and persist artifacts
  → approve one artifact
  → export canonical JSON
```

The test must assert that Groq is not called by meeting creation or either webhook, is called exactly once by the explicit analysis request, and that the exported evidence resolves to the authoritative normalized transcript.

### Phase 13: Final Demo Polish and Acceptance — Engineering Complete; Live Acceptance Pending

* Make canonical JSON the default and documented primary export without removing already working secondary formats.
* Run the complete mock golden path repeatedly using **Reset demo**.
* Run one live Recall direct-URL meeting from bot creation through normalized transcript readiness.
* Run one explicitly confirmed Groq extraction and locally export one approved artifact.
* Verify retryable errors, disclosure wording, privacy wording, fixture labels, and absence of automatic external actions.
* Keep Calendar OAuth and production-scale infrastructure deferred.

### Phase 14: Controlled Local Repository Context — Implemented

* Extend SQLite with repository paths, approved file lists, context ingestions, line ranges, snapshot approvals, and durable analysis-run records.
* Add server-side repository-root allowlisting and deterministic scanning of only explicit approved documentation files.
* Stage scans for human review, activate them only after approval, fingerprint repository state, retain superseded ingestions, and block stale context.
* Add dashboard project creation, scan review, ingestion approval, project selection, context-preview approval, and separate Groq confirmation.
* Extend ticket proposals with supported summaries, problems, rationale, implementation areas, dependencies, risks, questions, and repository-context references.
* Test traversal, symlink escape, secret-like names, bounds, Git-ignored paths, reproducibility, activation, staleness, snapshot approval, and analysis provenance.

Phases 10–12, Phase 13 engineering polish, and Phase 14 controlled local repository context are implemented. Phase 13 still stops at the live-verification boundary: a user must join and consent in a disposable meeting, explicitly confirm the one live Groq request, and judge the rendered browser flow. Phase 8 remains deferred.

| Remaining phase | Depends on | Direct user attention |
| --- | --- | --- |
| Phase 10: Lifecycle and recovery — implemented | Existing Recall normalization and persisted history | Confirm wording during the final demo. |
| Phase 11: Demo reset — implemented | Existing fixture IDs and local store | None. |
| Phase 12: Golden-path test — implemented | Phases 10–11 and mocked Recall/Groq boundaries | None; run `npm run test:golden`. |
| Phase 13: Engineering polish implemented; live acceptance pending | Phases 10–12 | Required for one disposable live meeting, visible recording consent, explicit Groq confirmation, and final UI judgment. |
| Phase 14: Controlled local repository context — implemented | Existing SQLite selection pipeline | Configure at least one allowed repository root and review the first scan. |

## 20. Definition of Done

The project is complete when:

* A user can submit a meeting URL.
* The backend creates a Recall bot.
* The bot status is visible in the application.
* Webhook events update the stored meeting state.
* A completed transcript can be retrieved, normalized, and displayed.
* Speaker and timestamp information are preserved.
* Talk-time metrics are calculated deterministically.
* The user can explicitly start the bounded Groq pipeline, which generates engineering artifact proposals using defined schemas and only transcript evidence plus supplied project context.
* Where enabled, selected seeded or explicitly scanned local project context is ingested deterministically, retrieved as an approved persisted bounded snapshot, disclosed before the Groq request, and distinguishable from transcript evidence.
* Generated artifacts link to transcript evidence and distinguish any supplied or retrieved project context.
* Users can review, edit, approve, or reject artifacts.
* Approved action items can be exported as JSON.
* No artifact automatically creates external tickets, modifies code or documents, assigns people without evidence, or executes external actions.
* Mock mode supports a reliable demo.
* Mock mode can be reset safely and deterministically without affecting live records or making external calls.
* The application exposes the canonical lifecycle and allowed recovery action without regressing on out-of-order webhooks.
* The privacy and retention behavior is documented accurately, including local transcript storage and non-storage of recording media.
* A headless golden-path test covers creation, webhook processing, transcript normalization, explicit analysis, approval, and canonical export.
* Calendar scheduling works or is clearly documented as a deferred feature.
* Tests cover important success and failure paths.
* The README accurately explains the current implementation.
* No secrets or temporary files are committed.

## 21. Demo Narrative

The demo should communicate this story:

> Engineering teams already have important technical decisions and commitments inside their meetings. Recall handles the difficult infrastructure of joining, recording, diarizing, and transcribing those meetings. When a user explicitly requests it, this application runs a bounded Groq analysis pipeline on the resulting transcript and supplied project context to propose reviewable ADRs, ticket drafts, risks, and open questions while preserving a direct link back to the original conversation. Humans retain approval over analysis, every export, and every external action.

The strongest demonstration should show:

1. Launching a bot from a meeting URL.
2. Receiving and displaying status updates.
3. Opening a completed meeting.
4. Viewing talk-time analytics.
5. Viewing the bounded analysis pipeline's proposed ADR or ticket draft and its evidence.
6. Jumping to the supporting transcript evidence.
7. Editing and approving the artifact.
8. Exporting the resulting ticket JSON.
