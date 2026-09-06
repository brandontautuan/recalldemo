const timestamp = (value) => {
  if (!value || typeof value !== 'object') return null;
  const relative = typeof value.relative === 'number' && Number.isFinite(value.relative) ? value.relative : null;
  const absolute = typeof value.absolute === 'string' ? value.absolute : null;
  return relative === null && absolute === null ? null : { relative, absolute };
};

const transcriptParts = (payload) => {
  const parts = Array.isArray(payload) ? payload : payload?.transcript_parts;
  if (!Array.isArray(parts)) throw new Error('Recall transcript download did not contain transcript_parts.');
  return parts;
};

const validWords = (words) => {
  if (!Array.isArray(words)) return [];
  return words
    .filter((word) => word && typeof word.text === 'string' && word.text.trim())
    .map((word) => ({ text: word.text.trim(), start: timestamp(word.start_timestamp), end: timestamp(word.end_timestamp) }));
};

const duration = (start, end) => {
  if (start?.relative !== null && start?.relative !== undefined && end?.relative !== null && end?.relative !== undefined) return end.relative - start.relative;
  if (start?.absolute && end?.absolute) {
    const milliseconds = Date.parse(end.absolute) - Date.parse(start.absolute);
    return Number.isFinite(milliseconds) ? milliseconds / 1000 : null;
  }
  return null;
};

/** Converts Recall's downloaded machine transcript into safe, speaker-grouped application data. */
export function normalizeTranscript(payload) {
  const turns = [];
  for (const part of transcriptParts(payload)) {
    const words = validWords(part?.words);
    if (!words.length) continue;
    const participant = part?.participant && typeof part.participant === 'object' ? part.participant : {};
    const speakerName = typeof participant.name === 'string' && participant.name.trim() ? participant.name.trim() : 'Unknown speaker';
    const speakerId = participant.id === undefined || participant.id === null ? null : String(participant.id);
    const key = speakerId ?? speakerName;
    const previous = turns.at(-1);
    if (previous && previous.key === key) previous.words.push(...words);
    else turns.push({ key, speakerId, speakerName, languageCode: typeof part.language_code === 'string' ? part.language_code : null, words });
  }
  return turns.map(({ speakerId, speakerName, languageCode, words }, index) => {
    const start = words.find((word) => word.start)?.start ?? null;
    const end = [...words].reverse().find((word) => word.end)?.end ?? null;
    return {
      id: `utterance-${index + 1}`,
      speakerId,
      speakerName,
      speaker: speakerName,
      languageCode,
      text: words.map((word) => word.text).join(' '),
      startTimestamp: start,
      endTimestamp: end,
      durationSeconds: duration(start, end),
    };
  });
}

const rounded = (value) => Math.round(value * 100) / 100;

/** Calculates descriptive talk-time metrics only from normalized transcript timestamps. */
export function calculateMeetingAnalytics(utterances) {
  if (!Array.isArray(utterances)) throw new TypeError('Normalized utterances must be an array.');
  const speakers = new Map();
  let earliestStart = null;
  let latestEnd = null;

  for (const utterance of utterances) {
    const start = utterance?.startTimestamp?.relative;
    const end = utterance?.endTimestamp?.relative;
    const durationSeconds = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
    if (Number.isFinite(start)) earliestStart = earliestStart === null ? start : Math.min(earliestStart, start);
    if (Number.isFinite(end)) latestEnd = latestEnd === null ? end : Math.max(latestEnd, end);
    const speakerId = utterance?.speakerId ?? null;
    const speakerName = utterance?.speakerName ?? utterance?.speaker ?? 'Unknown speaker';
    const key = speakerId ?? speakerName;
    const metric = speakers.get(key) ?? { speakerId, speakerName, speakingTimeSeconds: 0, utteranceCount: 0 };
    metric.speakingTimeSeconds += durationSeconds;
    metric.utteranceCount += 1;
    speakers.set(key, metric);
  }

  const totalSpeakingSeconds = [...speakers.values()].reduce((sum, metric) => sum + metric.speakingTimeSeconds, 0);
  const participants = [...speakers.values()].map((metric) => ({
    ...metric,
    speakingTimeSeconds: rounded(metric.speakingTimeSeconds),
    speakingPercentage: totalSpeakingSeconds ? rounded((metric.speakingTimeSeconds / totalSpeakingSeconds) * 100) : 0,
    averageUtteranceSeconds: metric.utteranceCount ? rounded(metric.speakingTimeSeconds / metric.utteranceCount) : 0,
  }));

  return {
    source: 'deterministic_transcript_timestamps',
    meetingDurationSeconds: earliestStart !== null && latestEnd !== null ? rounded(Math.max(0, latestEnd - earliestStart)) : 0,
    totalSpeakingSeconds: rounded(totalSpeakingSeconds),
    utteranceCount: utterances.length,
    participantCount: participants.length,
    participants,
  };
}
