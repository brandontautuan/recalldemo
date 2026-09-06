import test from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactValidationError, validateAndHydrateArtifacts } from '../src/artifacts.js';
import { GroqBusyError, GroqClient, GroqRateLimitError } from '../src/groq-client.js';

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
  evidenceUtteranceIds: ['utterance-1'],
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
  assert.equal(response.rateLimit.remainingTokens, 7000);
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
