# Code Quality, Documentation, and Maintenance Rules

You are responsible for keeping the implementation, comments, README, and tests accurate throughout the entire task—not only at the end.

## 1. Understand Before Changing

Before modifying code:

* Inspect the existing project structure and relevant files.
* Identify the current architecture, data flow, scripts, and test commands.
* Reuse existing patterns and utilities where possible.
* Do not introduce a new framework, dependency, abstraction, or service unless it is necessary and justified.
* Preserve existing working behavior unless the task explicitly requires changing it.

Before making Recall-related changes:

* Verify the relevant API endpoint, request shape, response shape, webhook event, and required environment variables from the available Recall documentation.
* Do not guess API fields or silently invent behavior.
* Keep Recall-specific logic isolated behind a clear service or client module.

## 2. Code Quality

Write code that is:

* Clear and readable without requiring extensive explanation.
* Organized around sensible responsibilities.
* Small enough to test and reason about.
* Consistent with the existing language and project conventions.
* Explicit about error cases and unavailable data.
* Typed where the project supports types.
* Free of unused imports, dead code, unexplained magic values, and unnecessary duplication.

Use descriptive names. Avoid vague names such as `data`, `result`, `thing`, `process`, or `handleStuff` when a more precise name is available.

Prefer simple control flow. If a function becomes difficult to understand, split it into smaller functions with clear responsibilities.

Do not hide important behavior in overly clever abstractions.

## 3. API and Backend Boundaries

Keep external API calls separate from application logic.

The Recall integration should have a clear boundary for:

* Creating and scheduling bots.
* Retrieving bot status.
* Processing webhook events.
* Retrieving transcripts and recordings.
* Calendar callbacks.
* Translating Recall responses into the application’s internal data model.

Do not pass raw Recall API responses throughout the entire application. Normalize them at the integration boundary.

Validate incoming webhook payloads before using them.

Handle:

* Duplicate webhook events.
* Out-of-order events.
* Missing fields.
* Failed bot states.
* Network failures.
* API errors.
* Expired or unavailable media.
* Invalid meeting URLs.

Never expose API keys or secrets to the frontend, logs, README, screenshots, or committed files.

## 4. Comments

Comments should explain intent, constraints, or non-obvious decisions—not restate what the code already says.

Good comments explain:

* Why a workaround exists.
* Why a particular Recall event is handled in a certain way.
* Why webhook processing is idempotent.
* Why a field is normalized or transformed.
* What assumption the application makes about speaker roles.
* What is intentionally out of scope.

Avoid comments such as:

```text
// Set status to complete
status = "complete";
```

Do not leave stale comments. Whenever behavior changes, update or remove comments that no longer describe the implementation.

Use TODO comments only when they describe a specific, actionable follow-up. Do not leave vague TODOs.

## 5. AI-Generated Results

Treat LLM output as untrusted application data.

* Validate the returned structure before rendering or storing it.
* Use a defined schema for ADRs, action items, risks, and tickets.
* Handle malformed, incomplete, or empty responses.
* Preserve source evidence such as speaker, timestamp, and transcript text.
* Do not present unsupported inferences as confirmed facts.
* Clearly distinguish transcript evidence from generated interpretation.
* Allow users to review, edit, approve, or reject generated artifacts.

Every generated artifact should be traceable to the source transcript whenever possible.

## 6. Tests and Verification

Add or update tests for meaningful behavior changes.

At minimum, test:

* Successful Recall API requests.
* API failures.
* Invalid input.
* Webhook validation.
* Duplicate webhook delivery.
* Out-of-order webhook events.
* Bot failure states.
* Transcript parsing.
* Speaker and timestamp mapping.
* LLM output validation.
* Empty and malformed data.

Prefer deterministic tests with mocked Recall responses. Do not make the test suite depend on a live Recall account or live LLM unless the test is explicitly labeled as an integration test.

Before declaring the task complete:

* Run the project's existing automated test suite headlessly for every completed task, including documentation, configuration, and other non-code changes. Do not require a browser window, GUI, interactive prompt, live Recall account, or live LLM. If no headless test command is available or it cannot run, report the reason explicitly rather than silently skipping it.
* Run the project’s existing test suite.
* Run linting, formatting, and type checks if available.
* Test the main user flow manually.
* Verify that the README setup instructions work from a clean environment.
* Check that no secrets, debug logs, temporary files, or unrelated changes were introduced.

Report the exact verification commands and their results.

## 7. README Requirements

Keep the README updated as implementation changes.

The README must accurately describe:

* What the application does.
* The target customer and use case.
* The main user flow.
* The architecture and data flow.
* Which Recall features and endpoints are used.
* Required environment variables.
* How to install dependencies.
* How to start the backend and frontend.
* How to expose the local webhook endpoint.
* How to configure Recall webhooks and callbacks.
* How to run tests.
* How to use mock/demo mode, if available.
* Known limitations.
* Future improvements.

Include a concise architecture diagram or flow such as:

```text
User
  → Application backend
  → Recall Bot API
  → Meeting platform
  → Recall webhooks
  → Transcript processing
  → Reviewable engineering artifacts
```

Do not claim that features work if they have not been verified.

Do not describe planned functionality as completed functionality.

If a command, endpoint, environment variable, or setup step changes, update the README in the same change.

## 8. Change Management

Keep changes focused on the requested feature.

Do not:

* Rewrite unrelated files.
* Reformat the entire repository unnecessarily.
* Add dependencies without explaining why.
* Remove working behavior without justification.
* Commit generated secrets or local credentials.
* Leave broken intermediate states when moving between implementation steps.

After each meaningful milestone, re-check:

* The code still starts.
* The tests still pass.
* The README still matches the project.
* The user-facing flow still works.

## 9. Final Completion Checklist

Before finishing, confirm:

* [ ] The main requested workflow works end to end.
* [ ] Recall API calls are isolated and error-handled.
* [ ] Webhooks are validated and idempotent.
* [ ] External data is normalized before entering application logic.
* [ ] LLM output is schema-validated.
* [ ] Generated insights retain transcript evidence.
* [ ] Tests cover the important success and failure paths.
* [ ] Formatting, linting, and type checks pass where available.
* [ ] README instructions match the current implementation.
* [ ] Environment variables are documented without exposing secrets.
* [ ] Known limitations are clearly documented.
* [ ] No unrelated files or temporary artifacts were added.

When reporting completion, summarize:

1. What changed.
2. Which files changed.
3. What was verified.
4. Any remaining limitations or decisions.
