import { calculateMeetingAnalytics } from './transcript.js';

const utterances = [
  ['1', 'Maya Chen', 0, 9.5, 'We need one canonical event model before the ingestion service adds another source.'],
  ['2', 'Jon Bell', 10.2, 21.8, 'I agree. Let us normalize provider events at the boundary and keep the application model provider-neutral.'],
  ['1', 'Maya Chen', 23, 34.4, 'Decision: use the normalized event envelope. Jon will document the migration and acceptance checks by Friday.'],
  ['3', 'Priya Shah', 36.1, 47.6, 'The main risk is replaying older webhooks. We need idempotency keys and an out-of-order delivery test.'],
  ['2', 'Jon Bell', 49, 62.2, 'There is a duplicate-delivery bug: replaying the same webhook creates two records. Re-send one webhook ID; we expect one record but currently get two.'],
].map(([speakerId, speakerName, start, end, text], index) => ({
  id: `mock-utterance-${index + 1}`,
  speakerId,
  speakerName,
  speaker: speakerName,
  languageCode: 'en-US',
  text,
  startTimestamp: { relative: start, absolute: null },
  endTimestamp: { relative: end, absolute: null },
  durationSeconds: end - start,
}));

const analytics = calculateMeetingAnalytics(utterances);
const emptyArtifactContent = {
  description: null,
  context: null,
  decision: null,
  alternativesRejected: [],
  consequences: [],
  assignee: null,
  dueDate: null,
  acceptanceCriteria: [],
  priority: null,
  stepsToReproduce: [],
  expectedBehavior: null,
  actualBehavior: null,
  severity: null,
  impact: null,
  mitigation: null,
  owner: null,
  question: null,
  suggestedOwner: null,
};
const mockArtifact = ({ id, type, title, content, evidenceIndexes, confidence = 'high' }) => {
  const artifactContent = { ...emptyArtifactContent, ...content };
  const evidence = evidenceIndexes.map((index) => ({
    utteranceId: utterances[index].id,
    speaker: utterances[index].speakerName,
    startTime: utterances[index].startTimestamp.relative,
    endTime: utterances[index].endTimestamp.relative,
    text: utterances[index].text,
  }));
  return {
    id,
    meetingId: 'mock-architecture-review',
    type,
    status: 'proposed',
    title,
    content: artifactContent,
    confidence,
    evidence,
    evidenceState: 'supported',
    validationWarnings: [],
    source: 'groq_fixture',
    version: 1,
    userEdited: false,
    reviewedAt: null,
    rejectionNote: null,
    originalProposal: { title, content: structuredClone(artifactContent), confidence, evidence: structuredClone(evidence), evidenceState: 'supported', validationWarnings: [] },
    createdAt: '2026-01-15T17:31:13.000Z',
    updatedAt: '2026-01-15T17:31:13.000Z',
    isMock: true,
  };
};

const artifacts = [
  mockArtifact({ id: 'mock-artifact-adr', type: 'architecture_decision', title: 'Adopt a normalized event envelope', content: { context: 'Provider events need one canonical application model.', decision: 'Normalize provider events at the integration boundary.', consequences: ['Application logic remains provider-neutral.'] }, evidenceIndexes: [1, 2] }),
  mockArtifact({ id: 'mock-artifact-action', type: 'action_item', title: 'Document the event-model migration', content: { description: 'Document the migration and acceptance checks.', assignee: 'Jon Bell', dueDate: 'Friday', acceptanceCriteria: ['Migration steps are documented.', 'Acceptance checks are documented.'], priority: 'medium' }, evidenceIndexes: [2] }),
  mockArtifact({ id: 'mock-artifact-bug', type: 'bug_report', title: 'Duplicate webhook delivery creates duplicate records', content: { description: 'Replaying one webhook delivery creates two stored records.', stepsToReproduce: ['Send a webhook with one delivery ID.', 'Replay the same delivery.'], expectedBehavior: 'Only one record is created.', actualBehavior: 'Two records are created.', severity: 'high' }, evidenceIndexes: [4] }),
  mockArtifact({ id: 'mock-artifact-risk', type: 'risk', title: 'Historical webhook replay can duplicate processing', content: { description: 'Replaying older webhooks may repeat application processing.', impact: 'high', mitigation: 'Use idempotency keys and test out-of-order delivery.' }, evidenceIndexes: [3] }),
];

export const mockFixture = Object.freeze({
  meeting: {
    id: 'mock-architecture-review',
    recallBotId: 'mock-bot-001',
    botId: 'mock-bot-001',
    meetingUrl: 'https://meet.google.com/mock-demo',
    title: 'Event ingestion architecture review',
    meetingType: 'architecture_review',
    status: 'completed',
    statusHistory: [
      ['created', 'app.meeting_created', '2026-01-15T17:00:00.000Z'],
      ['joining', 'bot.joining_call', '2026-01-15T17:00:05.000Z'],
      ['joining', 'bot.in_waiting_room', '2026-01-15T17:00:12.000Z'],
      ['recording', 'bot.in_call_recording', '2026-01-15T17:00:30.000Z'],
      ['transcript_processing', 'bot.call_ended', '2026-01-15T17:31:00.000Z'],
      ['transcript_processing', 'bot.done', '2026-01-15T17:31:08.000Z'],
      ['completed', 'app.transcript_ready', '2026-01-15T17:31:12.000Z'],
    ].map(([status, eventType, occurredAt]) => ({ status, eventType, providerStatus: eventType.startsWith('bot.') ? eventType.slice(4) : status, code: eventType.startsWith('bot.') ? eventType.slice(4) : status, subCode: null, occurredAt })),
    participants: analytics.participants.map(({ speakerId, speakerName }) => ({ id: speakerId, name: speakerName })),
    startedAt: '2026-01-15T17:00:30.000Z',
    endedAt: '2026-01-15T17:31:00.000Z',
    durationMs: analytics.meetingDurationSeconds * 1000,
    transcriptStatus: 'done',
    processingStatus: 'complete',
    error: null,
    isMock: true,
    createdAt: '2026-01-15T16:59:55.000Z',
    updatedAt: '2026-01-15T17:31:12.000Z',
  },
  transcript: {
    id: 'mock-transcript-001',
    meetingId: 'mock-architecture-review',
    recordingId: 'mock-recording-001',
    status: 'done',
    utterances,
    paragraphs: utterances,
    analytics,
    isMock: true,
    receivedAt: '2026-01-15T17:31:12.000Z',
  },
  artifacts,
});

export class MockRecallClient {
  async createBot() { return { id: `mock-bot-${Date.now()}` }; }
  async createTranscript() { return { id: `mock-transcript-${Date.now()}` }; }
  async getTranscript() { throw new Error('Live transcript retrieval is disabled in mock mode.'); }
  async downloadTranscript() { throw new Error('Live transcript download is disabled in mock mode.'); }
  async listCalendarEvents() { return { results: [] }; }
  async scheduleCalendarEvent() { throw new Error('Calendar scheduling is disabled in mock mode.'); }
}
