# Build Roadmap and Manual Transcript Ingestion

## Status

Phase 0 (manual transcript sandbox) and Phase 1 (approved local repository documentation context) are implemented. This document records their product constraints and the remaining future phases; it is not a specification for already-shipped routes to be rebuilt.

## Product decision

The implemented local, browser-driven manual transcript workflow lets the owner paste a transcript, validate it, review the parsed evidence, and run the existing project-context and artifact-review workflow without scheduling a Recall bot, delivering a webhook, or calling any external meeting API.

This is more useful as the immediate next step than repository retrieval because it gives us a fast, repeatable way to test the complete analysis experience against realistic inputs before adding another context source.

The manual path is a first-class **source type**, not a fake Recall event. It is visibly labelled `Manual transcript` in the dashboard and persisted source metadata. Current canonical and ticket-draft exports retain meeting identity and evidence but do not yet carry a dedicated manual-source field; adding that field is a follow-up before exports can claim source-type labeling.

## Phase 0 implementation record

Phase 0 was implemented with provider-neutral data handling:

1. Create `src/manual-transcript.js` as a pure parser and validator for timestamped speaker lines, speaker lines, and plain paragraphs. Enforce input bounds, preserve normalized source evidence plus a source-text hash, reject malformed structure, and never invent timestamps.
2. Add a local-only feature configuration and tests. It defaults on in mock mode, has no Recall dependency, and can be explicitly enabled for controlled local development.
3. Add `POST /api/manual-transcripts/preview` for validation-only parsing and `POST /api/manual-meetings` for atomic persistence of a completed manual meeting and transcript. Neither endpoint calls Recall or Groq.
4. Surface a dashboard form with **Load sample**, **Preview parsed transcript**, and **Create manual meeting**. Creation remains disabled until the displayed preview matches current form fields.
5. Render manual-source badges and timestamp-unavailable states accurately in the existing meeting card, then verify the existing context, analysis, review, and export paths work unchanged.
6. Add deterministic unit, route, and UI tests; update the README with activation, supported formats, privacy behavior, and no-external-call guarantee.

The implemented scope stops here. File uploads, CSV/SRT/VTT parsers, multi-user authorization, transcript versioning, retention controls, and source-type export labeling remain later work.

## Build phases

### Phase 0 — Manual transcript sandbox (implemented)

**Outcome:** A user can paste or load a local sample transcript, review its normalized utterances, create a completed local meeting, and run the existing explicit review flow entirely without Recall.

Deliverables:

* A dashboard action: **Create manual transcript**.
* A transcript editor with title, optional meeting type, optional date, and pasted text.
* A built-in **Load sample transcript** button that loads a clearly labelled fixture into the editor, rather than requiring HTTP tooling or external APIs.
* Parse preview and validation errors before anything is persisted.
* Create a completed meeting and normalized transcript with `source: manual`.
* Existing context preview, context approval, manual analysis, artifact evidence, review, and export flows work unchanged against it.
* A delete/reset action for unreviewed manual test meetings, protected by a confirmation.

Definition of done:

```text
Paste text → preview parsed utterances → create local completed meeting
  → optionally attach approved project context → explicitly analyze
  → review source-linked artifacts → export
```

No Recall client method, Recall webhook, calendar flow, recording, or repository scan is called in this phase.

### Phase 1 — Approved local repository Docs context (implemented)

**Outcome:** The owner configures an allowlisted local repository and can approve documentation context pinned to its current Git commit when available.

Deliverables:

* Server-side parent-directory allowlist and local repository-path validation.
* Explicit repository configuration, including Git HEAD capture when available.
* Docs-only retrieval with server-side path, extension, size, and secret policy.
* Reviewable ingestion, approval, supersession, fingerprinting, and commit/path/line provenance.
* Manual transcripts from Phase 0 can be the primary test input for this phase.

Exit criterion: a manually pasted architecture discussion can cite approved private-repository documentation at a specific commit without exposing credentials or unapproved content.

### Phase 2 — Focused private-code context

**Outcome:** A meeting can be scoped to selected source directories/files, with a small and explainable amount of neighboring code.

Deliverables:

* Explicit path selection and include/exclude filters.
* Safe source-file eligibility policy and line-addressable chunking.
* Bounded import/same-directory neighbors with an inclusion reason for each.
* Artifact validation for exact local-code references: repository, commit SHA when available, path, and line range.
* UI preview that differentiates directly selected files from automatically included neighbors.

Exit criterion: a pasted bug-triage transcript can generate a proposal whose source references only the user-approved code chunks.

### Phase 3 — Deep codebase context

**Outcome:** The user can ask for a broad architectural analysis while the system retrieves only a budgeted set of relevant source chunks from one private repository commit.

Deliverables:

* Repository tree/map and language-aware chunk index per approved commit.
* Deterministic ranking using approved meeting transcript, project notes, paths, symbols, and import relationships.
* Hard caps for files, bytes, chunks, retrieval rounds, and final model input.
* Context-preview explanations for ranking and omission reasons.
* Measurements for retrieval quality, latency, cost, and the rate of invalid/unhelpful citations.

Do not add embeddings until deterministic retrieval has been tested with representative manual transcripts. If later needed, embeddings are an implementation detail of the retrieval service and must preserve the same approval and provenance model.

### Phase 4 — Hardened connected workflows

**Outcome:** The manual and Recall-produced transcript paths share the same durable, observable product workflow.

Deliverables:

* Local Git working-tree and commit fingerprint checks to mark changed repository configurations stale; approved snapshots remain immutable.
* Transcript editing/versioning and controlled re-analysis.
* Production authentication and per-user/project authorization around manual imports and local repository access.
* Retention/deletion controls for manual transcript content and private repository excerpts.
* Operational metrics, rate-limit handling, audit review, and deployment documentation.

Remote repository connections, pull requests, issues, ticket creation, multi-repo retrieval, and write permissions remain separate future proposals.

## Manual transcript user experience

The dashboard should offer two clearly different entry points:

```text
Capture with Recall                 Create manual transcript
External meeting capture            Local test / pasted meeting notes
Requires Recall configuration       Requires no Recall configuration
Source: Recall                      Source: Manual
```

The manual form fields are:

| Field | Required | Behavior |
| --- | --- | --- |
| Meeting title | Yes | Max 200 characters; displayed throughout the review flow. |
| Meeting type | No | Reuse current permitted meeting types; default `general_technical_sync`. |
| Meeting date | No | ISO timestamp or date; not inferred from transcript text. |
| Transcript format | Yes | `Speaker lines` or `Timestamped speaker lines`. |
| Transcript text | Yes | Bounded multiline text input. |
| Default speaker | Conditional | Required only for plain paragraphs without speaker labels. |

Buttons are **Load sample**, **Preview parsed transcript**, and **Create manual meeting**. The final action stays disabled until preview validation succeeds. The user sees utterance count, participant list, timestamp availability, and all parse warnings before creating anything.

The UI can call the application's own local backend endpoint, but it must make no Recall or other external API request. The user should never need curl, Postman, or a handcrafted webhook payload for normal testing.

## Supported input formats

Start with deliberately narrow, easy-to-explain formats:

### Timestamped speaker lines

```text
[00:00] Maya: We need one canonical event model.
[00:12.500] Jon: I agree; normalize at the integration boundary.
[00:28] Maya: Decision: adopt the normalized event envelope.
```

Accepted timestamp formats are `MM:SS`, `MM:SS.mmm`, `HH:MM:SS`, and `HH:MM:SS.mmm`. Timestamps must be non-negative and non-decreasing. The parser creates an utterance for every non-empty line and derives an end time from the next start time when available. The final utterance has no artificial end time unless the user supplies one in a later format revision.

### Speaker lines without timestamps

```text
Maya: We need one canonical event model.
Jon: I agree; normalize at the integration boundary.
Maya: Decision: adopt the normalized event envelope.
```

Every non-empty line becomes an ordered utterance. Timestamp fields remain `null`; they must never be invented. The analysis can cite text and speaker/order, but UI talk-time analytics is displayed as unavailable.

### Plain paragraphs

```text
We need one canonical event model before the ingestion service adds another source.

The boundary should normalize provider events.
```

Each non-empty paragraph becomes an ordered utterance attributed to the required default speaker, such as `Unknown speaker` or a user-entered label. This format is appropriate for notes, not a claimed verbatim multi-party transcript.

CSV, SRT, VTT, Recall JSON, and arbitrary LLM-generated formats are explicitly out of scope for the first manual-import release. They can be added later as separate parsers with their own validation and tests.

## Data and lifecycle model

Add explicit provenance fields instead of overloading Recall identifiers:

```text
meeting.source = 'recall' | 'manual'
meeting.sourceMetadata = {
  inputFormat: 'timestamped_speaker_lines' | 'speaker_lines' | 'plain_paragraphs',
  createdBy: 'local_user',
  createdAt: ISO-8601 timestamp
}

transcript.source = 'recall' | 'manual'
transcript.sourceMetadata = {
  inputFormat: ...,
  timestampsAvailable: boolean,
  originalTextSha256: SHA-256,
  parserVersion: 'manual-transcript/v1'
}
```

Manual meetings begin directly as `completed`, with a status-history entry such as `app.manual_transcript_created`. They have no bot ID, recording ID, Recall lifecycle attempt, or fabricated provider event. Existing analysis prerequisites continue to require a completed, normalized transcript and therefore work for both sources.

Raw pasted text is sensitive source material. Store it only if the product needs exact re-parse/audit support; otherwise persist normalized utterances plus the content hash. If retained, keep it out of logs, exports, and public/static directories, apply the same deletion/retention policy as stored transcripts, and label it manual.

## Backend boundary

Create `src/manual-transcript.js` with pure functions:

* `validateManualTranscriptRequest(input)` — strict request schema, bounds, and supported format validation.
* `parseManualTranscript(input)` — deterministic parsing to normalized internal utterances and non-fatal warnings.
* `createManualTranscriptRecord(parsed, metadata)` — meeting/transcript DTOs; no HTTP or persistence work.

Add one thin route:

```text
POST /api/manual-meetings
```

It accepts only the title, meeting type, optional date, format, default speaker when needed, and transcript text. It validates and normalizes using the new module, creates a local completed meeting plus transcript atomically, calculates analytics only where timestamps permit it, and returns the saved DTOs. It must reject unknown fields, blank content, malformed timestamps, out-of-order times, excessive speakers/utterances, and oversized input.

The route is application-local—not a Recall API proxy. It is disabled by default outside mock mode and can be explicitly enabled for controlled local development. It currently has no application authentication or rate limit, so production rollout requires both before enabling it.

## Validation, limits, and safety

Initial server-side defaults should be configurable with conservative hard maxima:

* maximum raw text size;
* maximum utterance count;
* maximum characters per utterance;
* maximum distinct speakers;
* timestamp duration ceiling;
* maximum title and default-speaker lengths.

Reject control characters other than normal whitespace, normalize line endings to LF, trim whitespace, and generate ordered manual utterance IDs. Persist normalized utterances and an original-text hash rather than raw pasted text; do not ask an LLM to repair, merge, infer speakers, or fabricate timestamps.

Malformed input produces exact line-number errors in the preview. Warnings can indicate repeated timestamps, missing timestamps, a one-speaker import, or unusually long utterances, but warnings must not silently change evidence.

## Test plan

Add deterministic tests without external services:

* all supported formats, whitespace normalization, participants, ordering, IDs, and timestamp mapping;
* malformed or decreasing timestamps, missing speaker labels, empty input, unknown fields, size/utterance/speaker bounds, and control characters;
* no fabricated times; analytics unavailable when timestamps are absent;
* manual meeting has source metadata, no Recall bot/recording IDs, and one completed local lifecycle event;
* context preview, analysis validation, artifact evidence hydration, review, and export work with a manual transcript;
* manual-import endpoint makes no Recall or Groq call until the existing explicit analysis action;
* UI preview/error states, load-sample behavior, and mock-mode reset isolation;
* deletion/reset authorization and prevention of deleting a reviewed/audited meeting without an explicit retention policy.

## Documentation changes when implemented

Update the README to distinguish Recall capture, mock fixture reset, and manual transcript import; document any feature flag and local-only constraints; add the manual flow to the architecture diagram; and state that manual source text is user-supplied and not verified by Recall.
