# Engineering Decision Pipeline

## 1. Overview

Engineering Decision Pipeline is a customer-facing reference application built on top of Recall.ai. Recall owns the meeting infrastructure: visible bot execution, meeting capture, recording, transcription, participant data, and webhook events. This application owns the bounded autonomous engineering-analysis workflow that turns ready transcripts and supplied project context into reviewable engineering artifacts.

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

The analysis is autonomous within defined stages, structured schemas, and validation rules. It is not an open-ended multi-agent loop and must not claim to know information absent from the transcript or supplied project context.

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
Bounded autonomous engineering analysis runs
    ↓
Artifacts are evidence- and schema-validated
    ↓
User reviews queued artifacts with transcript evidence
    ↓
User approves, edits, rejects, or exports artifacts
```

### Autonomous Analysis Pipeline

After a verified Recall webhook confirms that a transcript is ready, the application runs this bounded pipeline:

```text
Recall webhook
    → Transcript ingestion
    → Meeting classification
    → Project-context enrichment
    → Engineering analysis
    → Artifact generation
    → Evidence and schema validation
    → Human review queue
    → Approved export
```

Each stage receives only the normalized transcript, the bounded output of prior stages, and supplied project context. A failed or invalid stage produces a reviewable failure state; it does not trigger unconstrained retries, autonomous external actions, or unsupported conclusions.

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
Meeting artifacts are generated after completion
```

Calendar recording must be opt-in. The application must not record every calendar event by default.

## 4.1 Responsibility Boundaries

### Recall infrastructure

Recall provides meeting capture, bot execution, recordings, transcription, participant data, and signed lifecycle/webhook events. Recall is the source of meeting artifacts; it does not make the application's engineering decisions.

### Application backend

The backend owns Recall credentials, verified webhook ingestion, local persistence, transcript normalization, project-context handling, and the APIs used by the review interface. It translates Recall resources into internal application models rather than passing raw Recall responses throughout the product.

### Autonomous analysis pipeline

The pipeline classifies a meeting, combines its normalized transcript with explicitly supplied project context, and proposes engineering artifacts. It may run automatically after transcript readiness, but is bounded by defined stages and structured input/output schemas.

### Deterministic validation

Deterministic code validates transcript structure, artifact schemas, evidence references, timestamps, allowed values, duplicate artifacts, and export format. It calculates descriptive transcript metrics such as talk time. It does not use an LLM to confirm unsupported facts.

### Human approval and export

Generated artifacts enter a human review queue. A user may edit, approve, reject, or request more information before export. Only approved artifacts may be exported as Linear/Jira-compatible drafts.

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

## 9.1 Project Context

Initial project context is explicitly supplied with or before analysis and may include:

* Meeting type
* Project name
* Project description
* Existing system information
* Required ticket format

The pipeline must distinguish this context from transcript evidence in every generated artifact. Repository retrieval, documentation retrieval, and existing-ticket retrieval are future extensions; none is required for the initial implementation.

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
POST /api/webhooks/recall
```

Receives Recall webhook events.

```text
GET /api/meetings/:id/transcript
```

Returns the normalized transcript.

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
GET /api/artifacts/:id/export
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
Classify meeting and enrich with supplied project context
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
* Extraction schema
* Instructions to avoid unsupported claims, unsupported assignments, and autonomous external actions

## 13. Analysis Output Rules

Generated analysis output must be parsed and validated against a schema.

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

Errors should be logged with enough context to debug them without exposing secrets.

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

## 18. Non-Goals

The MVP will not include:

* Full Linear integration
* Full Jira integration
* Slack notifications
* Multi-tenant authentication
* Billing
* Team permissions
* Automatic task execution
* Autonomous code changes
* Real-time meeting coaching
* Computer vision analysis of shared screens
* Production-grade compliance certifications
* Support for every calendar provider
* A full project-management replacement

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

### Phase 5: Bounded Autonomous Engineering Analysis

* Define structured schemas for ADRs, action items, bug reports, risks, open questions, proposed acceptance criteria, and ticket drafts.
* Ingest explicitly supplied project context.
* Implement bounded meeting classification, context enrichment, engineering analysis, and artifact generation after transcript readiness.
* Validate generated output, evidence references, timestamps, assignments, and unsupported claims deterministically.
* Persist valid proposals in a human review queue and persist invalid results as actionable processing failures.

### Phase 6: Evidence Review

* Build artifact cards.
* Build transcript navigation.
* Link artifacts to timestamps.
* Add approve, edit, and reject actions.
* Add confidence and evidence states.

### Phase 7: Export

* Generate Linear/Jira-compatible JSON.
* Add copy-to-clipboard and download functionality.
* Document how external systems could consume the payload.
* Export only user-approved artifacts; do not call external ticket APIs.

### Phase 8: Calendar Extension

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

## 20. Definition of Done

The project is complete when:

* A user can submit a meeting URL.
* The backend creates a Recall bot.
* The bot status is visible in the application.
* Webhook events update the stored meeting state.
* A completed transcript can be retrieved, normalized, and displayed.
* Speaker and timestamp information are preserved.
* Talk-time metrics are calculated deterministically.
* The bounded autonomous pipeline generates engineering artifact proposals using defined schemas and only transcript evidence plus supplied project context.
* Generated artifacts link to transcript evidence and distinguish any supplied project context.
* Users can review, edit, approve, or reject artifacts.
* Approved action items can be exported as JSON.
* No artifact automatically creates external tickets, modifies code or documents, assigns people without evidence, or executes external actions.
* Mock mode supports a reliable demo.
* Calendar scheduling works or is clearly documented as a deferred feature.
* Tests cover important success and failure paths.
* The README accurately explains the current implementation.
* No secrets or temporary files are committed.

## 21. Demo Narrative

The demo should communicate this story:

> Engineering teams already have important technical decisions and commitments inside their meetings. Recall handles the difficult infrastructure of joining, recording, diarizing, and transcribing those meetings. This application runs a bounded autonomous analysis pipeline on the resulting transcript and supplied project context to propose reviewable ADRs, ticket drafts, risks, and open questions while preserving a direct link back to the original conversation. Humans retain approval over every export and every external action.

The strongest demonstration should show:

1. Launching a bot from a meeting URL.
2. Receiving and displaying status updates.
3. Opening a completed meeting.
4. Viewing talk-time analytics.
5. Viewing the bounded analysis pipeline's proposed ADR or ticket draft and its evidence.
6. Jumping to the supporting transcript evidence.
7. Editing and approving the artifact.
8. Exporting the resulting ticket JSON.
