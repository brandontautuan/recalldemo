const lifecycleStatuses = new Map([
  ['bot.joining_call', 'joining'],
  ['bot.in_waiting_room', 'in_waiting_room'],
  ['bot.in_call_not_recording', 'in_call_not_recording'],
  ['bot.recording_permission_allowed', 'recording_permission_allowed'],
  ['bot.recording_permission_denied', 'failed'],
  ['bot.in_call_recording', 'recording'],
  ['bot.call_ended', 'processing'],
  ['bot.done', 'complete'],
  ['bot.fatal', 'failed'],
  ['bot.breakout_room_entered', 'breakout_room_entered'],
  ['bot.breakout_room_left', 'breakout_room_left'],
  ['bot.breakout_room_opened', 'breakout_room_opened'],
  ['bot.breakout_room_closed', 'breakout_room_closed'],
]);

export const isBotLifecycleEvent = (eventType) =>
  typeof eventType === 'string' && eventType.startsWith('bot.');

/** Normalizes Recall's extensible lifecycle payload without discarding unknown codes. */
export function normalizeLifecycleEvent(event) {
  const eventType = event?.event ?? event?.type;
  if (!isBotLifecycleEvent(eventType)) return null;
  const payload = event?.data ?? {};
  const state = payload.data ?? {};
  const bot = payload.bot ?? {};
  if (typeof bot.id !== 'string' || !bot.id) return null;
  return {
    botId: bot.id,
    schedulingIntentId: typeof bot.metadata?.scheduling_intent_id === 'string'
      ? bot.metadata.scheduling_intent_id
      : null,
    eventType,
    status: lifecycleStatuses.get(eventType) ?? state.code ?? eventType.slice(4),
    code: typeof state.code === 'string' ? state.code : null,
    subCode: typeof state.sub_code === 'string' ? state.sub_code : null,
    message: typeof state.message === 'string' ? state.message : null,
    occurredAt: typeof state.updated_at === 'string' ? state.updated_at : new Date().toISOString(),
  };
}

/** Converts Retrieve Bot status history into the same application lifecycle shape as webhooks. */
export function normalizeRetrievedStatus(botId, statusChange) {
  if (typeof botId !== 'string' || !botId || !statusChange || typeof statusChange !== 'object') return null;
  const code = typeof statusChange.code === 'string' && statusChange.code ? statusChange.code : null;
  if (!code) return null;
  const eventType = code.startsWith('bot.') ? code : `bot.${code}`;
  return {
    botId,
    schedulingIntentId: null,
    eventType,
    status: lifecycleStatuses.get(eventType) ?? code,
    code,
    subCode: typeof statusChange.sub_code === 'string' ? statusChange.sub_code : null,
    message: typeof statusChange.message === 'string' ? statusChange.message : null,
    occurredAt: typeof statusChange.created_at === 'string' ? statusChange.created_at : new Date().toISOString(),
  };
}
