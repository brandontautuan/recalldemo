import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { JsonStore } from '../src/store.js';

const webhookSecret = `whsec_${Buffer.from('golden-path-signing-key').toString('base64')}`;

const invoke = async (app, method, url, body = '', headers = {}) => {
  const request = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url, headers });
  const response = { statusCode: null, headers: {}, body: '', writeHead(statusCode, responseHeaders = {}) { this.statusCode = statusCode; this.headers = responseHeaders; }, end(value = '') { this.body += value; } };
  await app(request, response);
  return response;
};

const deliverWebhook = async (app, event, id) => {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64');
  const response = await invoke(app, 'POST', '/webhooks/recall', body, {
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}`,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return response;
};

test('golden path captures, normalizes, explicitly analyzes, approves, and exports one meeting', async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-golden-path-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new JsonStore(path.join(directory, 'store.json'));
  const counters = { bot: 0, transcriptRequest: 0, transcriptGet: 0, transcriptDownload: 0, analysis: 0 };
  const recall = {
    async createBot() { counters.bot += 1; return { id: 'golden-bot-1' }; },
    async createTranscript(recordingId) { counters.transcriptRequest += 1; assert.equal(recordingId, 'golden-recording-1'); return { id: 'golden-transcript-1' }; },
    async getTranscript(transcriptId) { counters.transcriptGet += 1; assert.equal(transcriptId, 'golden-transcript-1'); return { data: { download_url: 'https://us-west-2.recall.ai/download/golden-transcript' } }; },
    async downloadTranscript() {
      counters.transcriptDownload += 1;
      return { transcript_parts: [
        { participant: { id: 1, name: 'Ada' }, words: [
          { text: 'I will document', start_timestamp: { relative: 1 }, end_timestamp: { relative: 2 } },
          { text: 'the migration plan.', start_timestamp: { relative: 2.1 }, end_timestamp: { relative: 4 } },
        ] },
        { participant: { id: 2, name: 'Lin' }, words: [
          { text: 'Please include rollback checks.', start_timestamp: { relative: 5 }, end_timestamp: { relative: 7 } },
        ] },
      ] };
    },
  };
  const analysis = { async analyze({ transcript }) {
    counters.analysis += 1;
    assert.equal(transcript.utterances[0].text, 'I will document the migration plan.');
    return { model: 'openai/gpt-oss-20b', usage: { total_tokens: 42 }, rateLimit: { remainingRequests: 9 }, output: { artifacts: [{
      type: 'action_item', title: 'Document the migration plan', status: 'proposed', description: 'Document the migration plan and include its rollback checks.', context: null, decision: null,
      alternativesRejected: [], consequences: [], assignee: 'Ada', dueDate: null, acceptanceCriteria: ['The migration and rollback checks are documented.'], priority: 'medium',
      stepsToReproduce: [], expectedBehavior: null, actualBehavior: null, severity: null, impact: null, mitigation: null, owner: null, question: null, suggestedOwner: null,
      summary: 'Document the migration and rollback checks.', problem: 'The migration plan is not recorded.', whyItMatters: 'The team needs a reviewable rollout path.', proposedImplementationAreas: ['Migration documentation'], dependencies: [], risks: [], openQuestions: [],
      repositoryReferences: [],
      evidenceUtteranceIds: ['utterance-1', 'utterance-2'], contextSourceIds: [], confidence: 'high',
    }] } };
  } };
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'test', RECALL_WEBHOOK_VERIFICATION_SECRET: webhookSecret, PUBLIC_API_BASE_URL: 'https://example.test' });
  const app = createApp({ config, recall, analysis, store, logger: { error() {} } });

  const created = await invoke(app, 'POST', '/api/meetings', JSON.stringify({ meetingUrl: 'https://meet.google.com/abc-defg-hij', title: 'Golden migration review', meetingType: 'architecture_review' }));
  assert.equal(created.statusCode, 201);
  const meetingId = JSON.parse(created.body).id;
  assert.equal(counters.analysis, 0, 'meeting creation must not invoke Groq');

  for (const [eventType, id] of [['bot.joining_call', 'life-1'], ['bot.in_call_recording', 'life-2'], ['bot.call_ended', 'life-3']]) {
    assert.equal((await deliverWebhook(app, { event: eventType, data: { bot: { id: 'golden-bot-1' }, data: {} } }, id)).statusCode, 202);
  }
  assert.equal((await deliverWebhook(app, { event: 'recording.done', data: { bot: { id: 'golden-bot-1' }, recording: { id: 'golden-recording-1' } } }, 'recording-1')).statusCode, 202);
  assert.equal(counters.analysis, 0, 'lifecycle and transcript requests must not invoke Groq');
  assert.equal((await deliverWebhook(app, { event: 'transcript.done', data: { bot: { id: 'golden-bot-1' }, recording: { id: 'golden-recording-1' }, transcript: { id: 'golden-transcript-1' } } }, 'transcript-1')).statusCode, 202);

  const transcript = store.getTranscript('golden-transcript-1');
  assert.equal(store.getMeeting(meetingId).status, 'completed');
  assert.equal(transcript.analytics.utteranceCount, 2);
  assert.equal(transcript.analytics.participantCount, 2);
  assert.equal(counters.analysis, 0, 'transcript completion must not invoke Groq');

  const analyzed = await invoke(app, 'POST', `/api/meetings/${meetingId}/analyze`, JSON.stringify({ projectContext: 'Use the existing rollback template.' }));
  assert.equal(analyzed.statusCode, 200);
  assert.equal(counters.analysis, 1, 'explicit analysis invokes Groq exactly once');
  const artifact = JSON.parse(analyzed.body).artifacts[0];
  assert.equal(artifact.evidence[0].text, transcript.utterances[0].text);

  const approved = await invoke(app, 'POST', `/api/artifacts/${artifact.id}/approve`, JSON.stringify({ expectedVersion: 1 }));
  assert.equal(approved.statusCode, 200);
  const approvedArtifact = JSON.parse(approved.body).artifact;
  assert.equal(approvedArtifact.status, 'approved');

  const exported = await invoke(app, 'POST', `/api/meetings/${meetingId}/export`, JSON.stringify({ format: 'canonical', selections: [{ artifactId: artifact.id, version: approvedArtifact.version }] }));
  assert.equal(exported.statusCode, 200);
  const exportBody = JSON.parse(exported.body);
  assert.equal(exportBody.export.schemaVersion, 'recall-engineering-export/v1');
  assert.equal(exportBody.export.artifacts[0].status, 'approved');
  assert.equal(exportBody.export.artifacts[0].evidence[0].text, transcript.utterances[0].text);
  assert.deepEqual(counters, { bot: 1, transcriptRequest: 1, transcriptGet: 1, transcriptDownload: 1, analysis: 1 });
});
