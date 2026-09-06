import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canAdvanceMeetingState,
  canonicalMeetingStates,
  normalizeLifecycleEvent,
  recoveryActionsForMeeting,
  terminalMeetingStates,
} from '../src/lifecycle.js';
import { JsonStore } from '../src/store.js';

const temporaryStore = (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-lifecycle-test-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new JsonStore(path.join(directory, 'store.json'));
};

test('canonical lifecycle has the documented states, terminal states, and forward-only transitions', () => {
  assert.deepEqual(canonicalMeetingStates, ['created', 'bot_scheduled', 'joining', 'in_call', 'recording', 'transcript_processing', 'completed', 'failed']);
  assert.deepEqual([...terminalMeetingStates], ['completed', 'failed']);
  assert.equal(canAdvanceMeetingState('created', 'recording'), true, 'authoritative later events may skip states');
  assert.equal(canAdvanceMeetingState('recording', 'joining'), false, 'late older states cannot regress the display state');
  assert.equal(canAdvanceMeetingState('recording', 'failed'), true);
  assert.equal(canAdvanceMeetingState('failed', 'transcript_processing'), false);
  assert.equal(canAdvanceMeetingState('failed', 'transcript_processing', { newAttempt: true }), true);
  assert.equal(canAdvanceMeetingState('completed', 'failed'), false);
});

test('Recall lifecycle normalization maps user-facing states and retains unknown provider status', () => {
  const waiting = normalizeLifecycleEvent({ event: 'bot.in_waiting_room', data: { bot: { id: 'bot-1' }, data: { code: 'in_waiting_room', sub_code: 'host_not_joined', updated_at: '2026-01-01T00:01:00.000Z' } } });
  assert.equal(waiting.status, 'joining');
  assert.equal(waiting.providerStatus, 'in_waiting_room');
  assert.equal(waiting.subCode, 'host_not_joined');
  const unknown = normalizeLifecycleEvent({ event: 'bot.future_state', data: { bot: { id: 'bot-1' }, data: { code: 'future_state', updated_at: '2026-01-01T00:02:00.000Z' } } });
  assert.equal(unknown.status, null);
  assert.equal(unknown.providerStatus, 'future_state');
  const expectedStates = new Map([
    ['bot.joining_call', 'joining'],
    ['bot.in_call_not_recording', 'in_call'],
    ['bot.in_call_recording', 'recording'],
    ['bot.call_ended', 'transcript_processing'],
    ['bot.done', 'transcript_processing'],
    ['bot.fatal', 'failed'],
  ]);
  for (const [event, expected] of expectedStates) {
    assert.equal(normalizeLifecycleEvent({ event, data: { bot: { id: 'bot-1' }, data: { code: event.slice(4) } } }).status, expected);
  }
});

test('store preserves raw event history while canonical state skips forward and never regresses', (context) => {
  const store = temporaryStore(context);
  const meeting = store.addMeeting({ id: 'meeting-1', botId: 'bot-1', status: 'created', statusHistory: [], transcriptStatus: 'not_started', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  store.recordLifecycle(normalizeLifecycleEvent({ event: 'bot.in_call_recording', data: { bot: { id: 'bot-1' }, data: { code: 'in_call_recording', updated_at: '2026-01-01T00:02:00.000Z' } } }));
  store.recordLifecycle(normalizeLifecycleEvent({ event: 'bot.in_waiting_room', data: { bot: { id: 'bot-1' }, data: { code: 'in_waiting_room', updated_at: '2026-01-01T00:01:00.000Z' } } }));
  store.recordLifecycle(normalizeLifecycleEvent({ event: 'bot.future_state', data: { bot: { id: 'bot-1' }, data: { code: 'future_state', updated_at: '2026-01-01T00:03:00.000Z' } } }));
  assert.equal(meeting.status, 'recording');
  assert.deepEqual(meeting.statusHistory.map(({ status, providerStatus }) => [status, providerStatus]), [
    ['joining', 'in_waiting_room'],
    ['recording', 'in_call_recording'],
    [null, 'future_state'],
  ]);
});

test('fatal state is terminal per attempt and explicit transcript recovery starts a new attempt', (context) => {
  const store = temporaryStore(context);
  const meeting = store.addMeeting({ id: 'meeting-1', botId: 'bot-1', status: 'recording', statusHistory: [], transcriptStatus: 'not_started', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z' });
  store.setMeetingState(meeting.id, 'failed', { eventType: 'app.transcript_failed', code: 'transcript_download_or_parse_failed', occurredAt: '2026-01-01T00:02:00.000Z' });
  assert.deepEqual(recoveryActionsForMeeting(meeting), ['reconcile_status', 'retry_processing']);
  store.recordLifecycle(normalizeLifecycleEvent({ event: 'bot.done', data: { bot: { id: 'bot-1' }, data: { code: 'done', updated_at: '2026-01-01T00:03:00.000Z' } } }));
  assert.equal(meeting.status, 'failed');
  store.setMeetingState(meeting.id, 'transcript_processing', { eventType: 'app.transcript_retry_started', code: 'transcript_retry_started', occurredAt: '2026-01-01T00:04:00.000Z', allowRecovery: true });
  assert.equal(meeting.lifecycleAttempt, 2);
  assert.equal(meeting.status, 'transcript_processing');
  store.setMeetingState(meeting.id, 'completed', { eventType: 'app.transcript_ready', code: 'transcript_ready', occurredAt: '2026-01-01T00:05:00.000Z' });
  assert.equal(meeting.status, 'completed');
  assert.deepEqual(meeting.statusHistory.slice(-2).map(({ status, attempt }) => [status, attempt]), [['transcript_processing', 2], ['completed', 2]]);
});
