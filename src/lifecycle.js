export const canonicalMeetingStates = Object.freeze([
  'created',
  'bot_scheduled',
  'joining',
  'in_call',
  'recording',
  'transcript_processing',
  'completed',
  'failed',
]);

export const terminalMeetingStates = new Set(['completed', 'failed']);

const stateRank = new Map(canonicalMeetingStates.map((state, index) => [state, index]));
const lifecycleStates = new Map([
  ['bot.joining_call', 'joining'],
  ['bot.in_waiting_room', 'joining'],
  ['bot.in_call_not_recording', 'in_call'],
  ['bot.recording_permission_allowed', 'in_call'],
  ['bot.recording_permission_denied', 'failed'],
  ['bot.in_call_recording', 'recording'],
  ['bot.call_ended', 'transcript_processing'],
  ['bot.done', 'transcript_processing'],
  ['bot.fatal', 'failed'],
  ['bot.breakout_room_entered', 'in_call'],
  ['bot.breakout_room_left', 'in_call'],
  ['bot.breakout_room_opened', 'in_call'],
  ['bot.breakout_room_closed', 'in_call'],
]);

const legacyStates = new Map([
  ['complete', 'completed'],
  ['processing', 'transcript_processing'],
  ['in_waiting_room', 'joining'],
  ['in_call_not_recording', 'in_call'],
  ['recording_permission_allowed', 'in_call'],
  ['breakout_room_entered', 'in_call'],
  ['breakout_room_left', 'in_call'],
  ['breakout_room_opened', 'in_call'],
  ['breakout_room_closed', 'in_call'],
]);

export const isBotLifecycleEvent = (eventType) =>
  typeof eventType === 'string' && eventType.startsWith('bot.');

export const canonicalStateForEvent = (eventType) => lifecycleStates.get(eventType) ?? null;

export function canonicalizeMeetingState(state, transcriptStatus = null) {
  if (transcriptStatus === 'done' && state !== 'failed') return 'completed';
  if (['failed', 'unavailable'].includes(transcriptStatus)) return 'failed';
  if (state === 'complete') return 'transcript_processing';
  if (stateRank.has(state)) return state;
  return legacyStates.get(state) ?? 'created';
}

export function canAdvanceMeetingState(currentState, nextState, { newAttempt = false } = {}) {
  if (!stateRank.has(currentState) || !stateRank.has(nextState)) return false;
  if (newAttempt) return currentState === 'failed' && nextState === 'transcript_processing';
  if (terminalMeetingStates.has(currentState)) return false;
  if (nextState === 'failed') return true;
  return stateRank.get(nextState) >= stateRank.get(currentState);
}

export function recoveryActionsForMeeting(meeting) {
  if (!meeting?.botId || meeting.isMock) return [];
  const actions = [];
  if (!terminalMeetingStates.has(meeting.status) || meeting.status === 'failed') actions.push('reconcile_status');
  if (meeting.status === 'failed' && ['transcript_create_failed', 'transcript_download_or_parse_failed', 'transcript_failed', 'transcript_retry_failed'].includes(meeting.error?.code)) {
    actions.push('retry_processing');
  }
  return actions;
}

const normalize = ({ eventType, botId, schedulingIntentId, providerState, occurredAt }) => ({
  botId,
  schedulingIntentId,
  eventType,
  status: canonicalStateForEvent(eventType),
  providerStatus: typeof providerState.code === 'string' && providerState.code ? providerState.code : eventType.slice(4),
  code: typeof providerState.code === 'string' ? providerState.code : null,
  subCode: typeof providerState.sub_code === 'string' ? providerState.sub_code : null,
  message: typeof providerState.message === 'string' ? providerState.message : null,
  occurredAt,
});

/** Normalizes Recall's extensible lifecycle payload without discarding unknown codes. */
export function normalizeLifecycleEvent(event) {
  const eventType = event?.event ?? event?.type;
  if (!isBotLifecycleEvent(eventType)) return null;
  const payload = event?.data ?? {};
  const providerState = payload.data ?? {};
  const bot = payload.bot ?? {};
  if (typeof bot.id !== 'string' || !bot.id) return null;
  return normalize({
    eventType,
    botId: bot.id,
    schedulingIntentId: typeof bot.metadata?.scheduling_intent_id === 'string' ? bot.metadata.scheduling_intent_id : null,
    providerState,
    occurredAt: typeof providerState.updated_at === 'string' ? providerState.updated_at : new Date().toISOString(),
  });
}

/** Converts Retrieve Bot status history into the same application lifecycle shape as webhooks. */
export function normalizeRetrievedStatus(botId, statusChange) {
  if (typeof botId !== 'string' || !botId || !statusChange || typeof statusChange !== 'object') return null;
  const code = typeof statusChange.code === 'string' && statusChange.code ? statusChange.code : null;
  if (!code) return null;
  const eventType = code.startsWith('bot.') ? code : `bot.${code}`;
  return normalize({
    eventType,
    botId,
    schedulingIntentId: null,
    providerState: { ...statusChange, code },
    occurredAt: typeof statusChange.created_at === 'string' ? statusChange.created_at : new Date().toISOString(),
  });
}
