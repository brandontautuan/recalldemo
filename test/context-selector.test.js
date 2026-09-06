import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildContextSelection } from '../src/context-selector.js';

const fixture = () => ({
  project: { id: 'project-alpha', slug: 'alpha', name: 'Alpha', description: 'Event delivery platform.', terminology: { DLQ: 'Dead-letter queue' }, ticketFormat: { label: 'alpha' }, updatedAt: '2026-08-01T00:00:00.000Z' },
  repositories: [
    { id: 'repo-z', name: 'Z repository', remoteUrl: 'https://example.test/z', defaultBranch: 'main', metadata: {}, updatedAt: '2026-08-02T00:00:00.000Z' },
    { id: 'repo-a', name: 'A repository', remoteUrl: 'https://example.test/a', defaultBranch: 'main', metadata: {}, updatedAt: '2026-08-02T00:00:00.000Z' },
  ],
  documents: [
    { id: 'doc-low', kind: 'readme_excerpt', title: 'Lower priority', sourcePath: 'README.md', content: 'Lower priority context.', revision: 1, selectionPriority: 20, isActive: true },
    { id: 'doc-high', kind: 'readme_excerpt', title: 'Higher priority', sourcePath: 'README.md', content: 'Higher priority context.', revision: 2, selectionPriority: 10, isActive: true },
    { id: 'doc-inactive', kind: 'project_metadata', title: 'Inactive', sourcePath: 'old.md', content: 'Old context.', revision: 3, selectionPriority: 1, isActive: false },
  ],
  workItems: [
    { id: 'work-lower', externalKey: 'A-2', title: 'Event retry alerts', description: 'Alert on retry exhaustion.', status: 'open', priority: 'medium', selectionPriority: 20, labels: ['events'], sourceUrl: null, updatedAt: '2026-08-04T00:00:00.000Z' },
    { id: 'work-higher', externalKey: 'A-1', title: 'Event retry queue', description: 'Add event retry queue metrics.', status: 'open', priority: 'high', selectionPriority: 10, labels: ['events'], sourceUrl: null, updatedAt: '2026-08-03T00:00:00.000Z' },
    { id: 'work-unrelated', externalKey: 'A-3', title: 'Change profile colors', description: 'Refresh avatar colors.', status: 'open', priority: 'low', selectionPriority: 1, labels: ['frontend'], sourceUrl: null, updatedAt: '2026-08-05T00:00:00.000Z' },
    { id: 'work-closed', externalKey: 'A-4', title: 'Event retry prototype', description: 'Prototype retry queues.', status: 'done', priority: 'low', selectionPriority: 1, labels: ['events'], sourceUrl: null, updatedAt: '2026-08-05T00:00:00.000Z' },
  ],
  meeting: { title: 'Event retry review' },
  transcript: { utterances: [{ text: 'We need queue metrics and exhaustion alerts.' }] },
  projectContext: 'Focus on delivery reliability.',
  maximumCharacters: 20_000,
});

test('selects sources in fixed deterministic order and ranks only relevant open work items', () => {
  const first = buildContextSelection(fixture());
  const second = buildContextSelection(structuredClone(fixture()));
  assert.deepEqual(first, second);
  assert.deepEqual(first.selection.sources.map((source) => source.id), [
    'project:project-alpha', 'repository:repo-a', 'repository:repo-z',
    'document:doc-high', 'document:doc-low', 'work-item:work-higher', 'work-item:work-lower',
  ]);
  assert.deepEqual(first.selection.omissions, [
    { sourceId: 'document:doc-inactive', label: 'Inactive', reason: 'inactive' },
    { sourceId: 'work-item:work-closed', label: 'Event retry prototype', reason: 'not_open' },
    { sourceId: 'work-item:work-unrelated', label: 'Change profile colors', reason: 'no_lexical_overlap' },
  ]);
  assert.equal(first.selection.query.projectContextSha256, crypto.createHash('sha256').update('Focus on delivery reliability.').digest('hex'));
  assert.match(first.contentSha256, /^[a-f0-9]{64}$/);
});

test('stops at the context character budget and records every lower-priority omission', () => {
  const full = buildContextSelection(fixture());
  const projectCharacters = full.selection.sources[0].text.length;
  const bounded = buildContextSelection({ ...fixture(), maximumCharacters: projectCharacters });
  assert.deepEqual(bounded.selection.sources.map((source) => source.id), ['project:project-alpha']);
  assert.equal(bounded.selection.characterCount, projectCharacters);
  assert.ok(bounded.selection.omissions.filter((omission) => omission.reason === 'character_budget').length >= 6);
  assert.ok(bounded.selection.characterCount <= bounded.selection.maximumCharacters);
});

test('includes no work items when the meeting has no lexical overlap', () => {
  const input = fixture();
  input.meeting.title = 'Quarterly planning';
  input.transcript.utterances = [{ text: 'Discuss staffing and schedules.' }];
  input.projectContext = null;
  const selected = buildContextSelection(input);
  assert.equal(selected.selection.sources.some((source) => source.kind === 'work_item_snapshot'), false);
  assert.equal(selected.selection.omissions.filter((omission) => omission.reason === 'no_lexical_overlap').length, 3);
  assert.equal(selected.selection.query.projectContextSha256, null);
});
