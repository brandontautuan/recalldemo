import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactValidationError, validateAndHydrateArtifacts, validateAndHydrateSupportedArtifacts } from '../src/artifacts.js';
import { GroqBusyError, GroqClient, GroqRateLimitError, GroqTruncatedOutputError } from '../src/groq-client.js';

export const validArtifact = (patch = {}) => ({
  type: 'action_item',
  title: 'Document the migration plan',
  status: 'proposed',
  description: 'Write the event-model migration and its acceptance checks.',
  context: null,
  decision: null,
  alternativesRejected: [],
  consequences: [],
  assignee: 'Ada',
  dueDate: null,
  acceptanceCriteria: ['The migration and rollback steps are documented.'],
  priority: 'medium',
  stepsToReproduce: [],
  expectedBehavior: null,
  actualBehavior: null,
  severity: null,
  impact: null,
  mitigation: null,
  owner: null,
  question: null,
  suggestedOwner: null,
  summary: 'Document the migration plan and its validation expectations.',
  problem: 'The migration behavior is not documented.',
  whyItMatters: 'Operators need a safe migration and rollback path.',
  proposedImplementationAreas: ['Migration documentation'],
  dependencies: [],
  risks: [],
  openQuestions: [],
  repositoryReferences: [],
  evidenceUtteranceIds: ['utterance-1'],
  contextSourceIds: [],
  confidence: 'high',
  ...patch,
});

const context = {
  meetingId: 'meeting-1',
  participants: [{ id: '1', name: 'Ada' }],
  utterances: [{ id: 'utterance-1', speakerId: '1', speakerName: 'Ada', text: 'I will document the migration plan.', startTimestamp: { relative: 3 }, endTimestamp: { relative: 6 } }],
};

test('validates artifacts and hydrates evidence only from stored utterances', () => {
  const [artifact] = validateAndHydrateArtifacts({ artifacts: [validArtifact()] }, context);
  assert.equal(artifact.status, 'proposed');
  assert.equal(artifact.source, 'groq');
  assert.deepEqual(artifact.evidence[0], { utteranceId: 'utterance-1', speaker: 'Ada', startTime: 3, endTime: 6, text: 'I will document the migration plan.' });
});

test('validates context provenance against only the immutable selected sources', () => {
  const contextSelection = {
    id: 'selection-1', projectId: 'project-1', contentSha256: 'a'.repeat(64),
    sources: [{ id: 'document:architecture', kind: 'readme_excerpt', label: 'Architecture', revision: 2, sourcePath: 'README.md', lineStart: 10, lineEnd: 20, ingestionId: 'ingestion-1', text: 'Background only.' }],
  };
  const [artifact] = validateAndHydrateArtifacts({ artifacts: [validArtifact({ contextSourceIds: ['document:architecture'] })] }, { ...context, contextSelection });
  assert.deepEqual(artifact.contextProvenance, {
    selectionId: 'selection-1', projectId: 'project-1', contentSha256: 'a'.repeat(64),
    sources: [{ sourceId: 'document:architecture', kind: 'readme_excerpt', label: 'Architecture', revision: 2, sourcePath: 'README.md', lineStart: 10, lineEnd: 20, ingestionId: 'ingestion-1', truncated: false, trackedFiles: [] }],
  });
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ contextSourceIds: ['document:missing'] })] }, { ...context, contextSelection }), /unknown context source/);
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ contextSourceIds: ['document:architecture', 'document:architecture'] })] }, { ...context, contextSelection }), /duplicates context source/);
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ contextSourceIds: ['document:architecture'] })] }, context), /unknown context source/);
});

test('accepts only repository references present in approved context', () => {
  const contextSelection = {
    id: 'selection-1', projectId: 'project-1', contentSha256: 'a'.repeat(64),
    sources: [
      { id: 'document:readme', kind: 'readme_excerpt', label: 'README', revision: 1, sourcePath: 'README.md', lineStart: 1, lineEnd: 20, ingestionId: 'ingestion-1', text: 'Approved excerpt.' },
      { id: 'repository:repo', kind: 'repository_metadata', label: 'Repo', revision: 'abc', trackedFiles: ['src/service.js'], text: 'Approved paths.' },
    ],
  };
  const references = [
    { sourceId: 'document:readme', path: 'README.md', lineStart: 1, lineEnd: 20 },
    { sourceId: 'repository:repo', path: 'src/service.js', lineStart: null, lineEnd: null },
  ];
  const [artifact] = validateAndHydrateArtifacts({ artifacts: [validArtifact({ contextSourceIds: ['document:readme', 'repository:repo'], repositoryReferences: references })] }, { ...context, contextSelection });
  assert.deepEqual(artifact.content.repositoryReferences, references);
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ contextSourceIds: ['repository:repo'], repositoryReferences: [{ sourceId: 'repository:repo', path: 'src/invented.js', lineStart: null, lineEnd: null }] })] }, { ...context, contextSelection }), /not present/);
});

test('rejects unknown evidence, unsupported assignees, and duplicate artifacts', () => {
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ assignee: 'Grace', evidenceUtteranceIds: ['missing'] }), validArtifact()] }, context), ArtifactValidationError);
});

test('rejects unknown fields and missing type-specific content', () => {
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ inventedField: 'not allowed' })] }, context), /not allowed/);
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ type: 'risk', impact: null })] }, context), /risk must include/);
});

test('Groq client sends strict structured output and records rate-limit headers', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ model: 'openai/gpt-oss-20b', choices: [{ message: { content: JSON.stringify({ artifacts: [] }) } }], usage: { total_tokens: 42 } }), {
      status: 200,
      headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '999', 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '7000' },
    });
  };
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  const response = await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.model, 'openai/gpt-oss-20b');
  assert.ok(body.response_format.json_schema.schema.properties.artifacts.items.required.includes('contextSourceIds'));
  assert.equal(response.rateLimit.remainingTokens, 7000);
});

test('an action item grounded in the ticket fields the prompt asks for is not rejected as vague', () => {
  // The analysis prompt directs ticket-like action items into summary/problem, never description.
  const [artifact] = validateAndHydrateArtifacts({ artifacts: [validArtifact({ description: null })] }, context);
  assert.equal(artifact.content.description, null);
  assert.equal(artifact.content.summary, 'Document the migration plan and its validation expectations.');
  assert.throws(() => validateAndHydrateArtifacts({ artifacts: [validArtifact({ description: null, summary: null, problem: null })] }, context), /overly vague/);
});

test('analysis keeps the artifacts that validate and reports the ones it dropped', () => {
  const payload = { artifacts: [
    validArtifact(),
    validArtifact({ title: 'Restore the rollback rehearsal', evidenceUtteranceIds: ['utterance-missing'] }),
    validArtifact({ title: 'Publish the migration runbook' }),
  ] };
  const { artifacts, rejected } = validateAndHydrateSupportedArtifacts(payload, context);
  assert.deepEqual(artifacts.map((artifact) => artifact.title), ['Document the migration plan', 'Publish the migration runbook']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].index, 1);
  assert.equal(rejected[0].title, 'Restore the rollback rehearsal');
  assert.deepEqual(rejected[0].issues, ['artifacts[1] references unknown evidence utterance-missing']);
});

test('partial validation still rejects root-level problems and batches in which nothing survived', () => {
  assert.throws(() => validateAndHydrateSupportedArtifacts({ status: 'ok', artifacts: [validArtifact()] }, context), /root.status is not allowed/);
  assert.throws(() => validateAndHydrateSupportedArtifacts({ artifacts: [validArtifact({ evidenceUtteranceIds: ['missing'] })] }, context), ArtifactValidationError);
  // An empty proposal set is a valid answer, not a failure.
  assert.deepEqual(validateAndHydrateSupportedArtifacts({ artifacts: [] }, context), { artifacts: [], rejected: [] });
});

test('a dropped artifact does not claim its duplicate key from a later valid proposal', () => {
  const payload = { artifacts: [validArtifact({ evidenceUtteranceIds: ['missing'] }), validArtifact()] };
  const { artifacts, rejected } = validateAndHydrateSupportedArtifacts(payload, context);
  assert.equal(artifacts.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(!rejected[0].issues.some((issue) => issue.includes('duplicates')));
});

test('Groq client names a completion cut off at the token limit instead of a generic failure', async () => {
  const truncated = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"artifacts":[{"type":"action_item"' } }] }), { status: 200 });
  const client = new GroqClient({ apiKey: 'secret', fetchImpl: truncated });
  await assert.rejects(
    () => client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } }),
    (error) => error instanceof GroqTruncatedOutputError && error.structuredOutputMode === 'strict',
  );
  // JSON object mode constrains nothing, so its only validation failure is an unfinished document.
  let calls = 0;
  const failingFallback = async () => { calls += 1; return new Response(JSON.stringify({ error: { code: 'json_validate_failed' } }), { status: 400 }); };
  const fallbackClient = new GroqClient({ apiKey: 'secret', fetchImpl: failingFallback });
  await assert.rejects(
    () => fallbackClient.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } }),
    (error) => error instanceof GroqTruncatedOutputError && error.structuredOutputMode === 'json_object_fallback',
  );
  assert.equal(calls, 2);
});

test('Groq client sizes the completion budget for a full all-required artifact batch', async () => {
  const requestBodies = [];
  const fetchImpl = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), { status: 200 });
  };
  const meeting = { title: 'Review', meetingType: 'architecture_review', participants: [] };
  await new GroqClient({ apiKey: 'secret', fetchImpl }).analyze({ meeting, transcript: { utterances: context.utterances } });
  assert.equal(requestBodies[0].max_completion_tokens, 16_384);
  await new GroqClient({ apiKey: 'secret', fetchImpl, maximumOutputTokens: 32_768 }).analyze({ meeting, transcript: { utterances: context.utterances } });
  assert.equal(requestBodies[1].max_completion_tokens, 32_768);
});

test('Groq client retries Groq strict-schema generation failures once in JSON object mode', async () => {
  const requestBodies = [];
  const fetchImpl = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({ error: { code: 'json_validate_failed' } }), { status: 400 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), { status: 200 });
  };
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  const response = await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].response_format.json_schema.strict, true);
  assert.deepEqual(requestBodies[1].response_format, { type: 'json_object' });
  assert.deepEqual(requestBodies[1].messages.map((message) => message.role), ['user']);
  assert.match(requestBodies[1].messages[0].content, /Use type exactly one of architecture_decision/);
  assert.equal(response.structuredOutputMode, 'json_object_fallback');
});

test('Groq client bounds reasoning tokens so they cannot consume the completion budget', async () => {
  const requestBodies = [];
  const fetchImpl = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), { status: 200 });
  };
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  assert.equal(requestBodies[0].reasoning_effort, 'low');
  const explicit = new GroqClient({ apiKey: 'secret', reasoningEffort: 'high', fetchImpl });
  await explicit.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  assert.equal(requestBodies[1].reasoning_effort, 'high');
});

test('Groq client expands fallback payloads that wrap the array or use the full schema shape', async () => {
  const fallbackFor = (payload) => {
    const fetchImpl = async (_url, options) => (JSON.parse(options.body).response_format.type === 'json_schema'
      ? new Response(JSON.stringify({ error: { code: 'json_validate_failed' } }), { status: 400 })
      : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 }));
    const client = new GroqClient({ apiKey: 'secret', fetchImpl });
    return client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: context.participants }, transcript: { utterances: context.utterances } });
  };
  const artifact = {
    type: 'action_item', title: 'Document the migration plan', description: 'Write the event-model migration and its acceptance checks.',
    acceptanceCriteria: ['The migration and rollback steps are documented.'], evidenceUtteranceIds: ['utterance-1'], contextSourceIds: [], confidence: 'high', priority: 'medium',
  };
  // A stray root key used to abandon expansion entirely, reporting every field as missing.
  const wrapped = await fallbackFor({ status: 'ok', artifacts: [artifact] });
  assert.equal(wrapped.output.artifacts[0].status, 'proposed');
  assert.deepEqual(wrapped.output.artifacts[0].acceptanceCriteria, ['The migration and rollback steps are documented.']);
  assert.deepEqual(validateAndHydrateArtifacts(wrapped.output, context)[0].content.acceptanceCriteria, ['The migration and rollback steps are documented.']);
  // The full schema shape carries fields outside the flat contract; they are kept, not discarded.
  const full = await fallbackFor({ artifacts: [{ ...artifact, summary: 'Document the migration plan.', problem: 'Migration steps are undocumented.', repositoryReferences: [{ file: 'invented.js' }] }] });
  assert.equal(full.output.artifacts[0].summary, 'Document the migration plan.');
  assert.equal(full.output.artifacts[0].problem, 'Migration steps are undocumented.');
  // Repository references are never trusted from the fallback path, only from approved context.
  assert.deepEqual(full.output.artifacts[0].repositoryReferences, []);
  assert.equal(validateAndHydrateArtifacts(full.output, context).length, 1);
});

test('Groq client normalizes JSON object fallback shapes the schema decoder would have constrained', async () => {
  const modelOutput = { artifacts: [{
    type: 'action_item',
    title: 'Document the migration plan',
    description: 'Write the event-model migration and its acceptance checks.',
    decision: null,
    question: null,
    impact: null,
    assignee: 'Ada',
    acceptanceCriteria: [
      'The migration and rollback steps are documented.',
      { criterion: 'The rollback is rehearsed.' },
      { alternative: 'ambiguous', reason: 'two string values' },
    ],
    priority: 'medium',
    stepsToReproduce: 'A single unwrapped step.',
    expectedBehavior: null,
    actualBehavior: null,
    mitigation: null,
    evidenceUtteranceIds: ['utterance-1'],
    contextSourceIds: [],
    confidence: 'high',
  }] };
  const fetchImpl = async (_url, options) => (JSON.parse(options.body).response_format.type === 'json_schema'
    ? new Response(JSON.stringify({ error: { code: 'json_validate_failed' } }), { status: 400 })
    : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelOutput) } }] }), { status: 200 }));
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  const response = await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: context.participants }, transcript: { utterances: context.utterances } });
  const [expanded] = response.output.artifacts;
  // An unwrapped string becomes a single entry, a lone string property is copied, and an ambiguous object is dropped.
  assert.deepEqual(expanded.acceptanceCriteria, ['The migration and rollback steps are documented.', 'The rollback is rehearsed.']);
  assert.deepEqual(expanded.stepsToReproduce, ['A single unwrapped step.']);
  const [artifact] = validateAndHydrateArtifacts(response.output, context);
  assert.equal(artifact.content.acceptanceCriteria.length, 2);
});

test('Groq client does not retry unrelated provider failures in JSON object mode', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { code: 'invalid_api_key' } }), { status: 401 });
  };
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  await assert.rejects(() => client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } }), /Groq analysis failed \(401\)/);
  assert.equal(calls, 1);
});

test('Groq client labels retrieved context separately and includes it in the total input bound', async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), { status: 200 });
  };
  const contextSelection = {
    id: 'selection-1', contentSha256: 'a'.repeat(64), project: { id: 'project-1', name: 'Project One' },
    sources: [{ id: 'document:readme', kind: 'readme_excerpt', label: 'README', revision: 1, text: 'Background architecture context.' }],
  };
  const client = new GroqClient({ apiKey: 'secret', fetchImpl, maximumInputCharacters: 5_000 });
  await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances }, projectContext: 'User notes.', contextSelection });
  const input = JSON.parse(requestBody.messages[1].content);
  assert.equal(input.userProjectNotes, 'User notes.');
  assert.equal(input.retrievedProjectContext.selectionId, 'selection-1');
  assert.equal(input.retrievedProjectContext.sources[0].text, 'Background architecture context.');
  assert.notEqual(input.utterances[0].id, input.retrievedProjectContext.sources[0].id);
  const bounded = new GroqClient({ apiKey: 'secret', fetchImpl, maximumInputCharacters: 1_000 });
  await assert.rejects(() => bounded.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances }, contextSelection: { ...contextSelection, sources: [{ ...contextSelection.sources[0], text: 'x'.repeat(1_000) }] } }), /exceeds 1000/);
});

test('Groq client does not interpret absent rate-limit headers as exhausted quota', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), { status: 200 });
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  const response = await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  assert.equal(response.rateLimit.remainingTokens, null);
  assert.equal(response.rateLimit.remainingRequests, null);
});

test('Groq client honors 429 retry-after within the same manual request', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), { status: 200 });
  };
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  assert.equal(calls, 2);
});

test('Groq client blocks another manual request while provider tokens are exhausted', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), {
    status: 200,
    headers: { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '1s' },
  });
  const client = new GroqClient({ apiKey: 'secret', fetchImpl });
  await client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  await assert.rejects(() => client.analyze({ meeting: { title: 'Review', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } }), GroqRateLimitError);
});

test('Groq client enforces its application-wide concurrency limit', async () => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => { await waiting; return new Response(JSON.stringify({ choices: [{ message: { content: '{"artifacts":[]}' } }] }), { status: 200 }); };
  const client = new GroqClient({ apiKey: 'secret', fetchImpl, maximumConcurrency: 1 });
  const first = client.analyze({ meeting: { title: 'One', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } });
  await assert.rejects(() => client.analyze({ meeting: { title: 'Two', meetingType: 'architecture_review', participants: [] }, transcript: { utterances: context.utterances } }), GroqBusyError);
  release();
  await first;
});
