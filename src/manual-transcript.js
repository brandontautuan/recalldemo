/** Parses explicitly supplied local transcripts without contacting Recall or an LLM. */
import crypto from 'node:crypto';
import { calculateMeetingAnalytics } from './transcript.js';

const formats = new Set(['timestamped_speaker_lines', 'speaker_lines', 'plain_paragraphs']);
const meetingTypes = new Set(['architecture_review', 'sprint_planning', 'incident_review', 'bug_triage', 'general_technical_sync']);
const limits = Object.freeze({ maximumCharacters: 100_000, maximumUtterances: 1_000, maximumSpeakers: 100, maximumUtteranceCharacters: 10_000, maximumSpeakerCharacters: 100 });

export class ManualTranscriptValidationError extends Error {
  constructor(issues) {
    super(`Manual transcript validation failed: ${issues.join('; ')}`);
    this.name = 'ManualTranscriptValidationError';
    this.issues = issues;
  }
}

const normaliseText = (value) => value.replace(/\r\n?/g, '\n').trim();
const hasUnsupportedControlCharacters = (value) => /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
const speakerKey = (name) => `manual-speaker-${crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)}`;

function parseTimestamp(value) {
  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d{1,3})?$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds = parts.length === 2
    ? numbers[0] * 60 + numbers[1]
    : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
  if (!Number.isFinite(seconds) || seconds < 0 || (parts.length > 1 && numbers.at(-1) >= 60) || (parts.length === 3 && numbers[1] >= 60)) return null;
  return seconds;
}

function validateRequest(input) {
  const issues = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ManualTranscriptValidationError(['Request body must be a JSON object.']);
  const allowed = new Set(['title', 'meetingType', 'meetingDate', 'format', 'defaultSpeaker', 'text']);
  if (Object.keys(input).some((field) => !allowed.has(field))) issues.push('Request body contains unsupported fields.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200) issues.push('title is required and must contain at most 200 characters.');
  if (input.meetingType !== undefined && (!meetingTypes.has(input.meetingType))) issues.push('meetingType must be a supported meeting type.');
  if (input.meetingDate !== undefined && (typeof input.meetingDate !== 'string' || !Number.isFinite(Date.parse(input.meetingDate)))) issues.push('meetingDate must be a valid ISO date or timestamp.');
  if (!formats.has(input.format)) issues.push('format must be timestamped_speaker_lines, speaker_lines, or plain_paragraphs.');
  if (typeof input.text !== 'string' || !input.text.trim()) issues.push('text is required.');
  if (typeof input.text === 'string' && (input.text.length > limits.maximumCharacters || hasUnsupportedControlCharacters(input.text))) issues.push(`text must not exceed ${limits.maximumCharacters} characters or contain unsupported control characters.`);
  if (input.defaultSpeaker !== undefined && (typeof input.defaultSpeaker !== 'string' || !input.defaultSpeaker.trim() || input.defaultSpeaker.trim().length > limits.maximumSpeakerCharacters)) {
    issues.push(`defaultSpeaker must be a non-empty string of at most ${limits.maximumSpeakerCharacters} characters.`);
  }
  if (input.format === 'plain_paragraphs' && (typeof input.defaultSpeaker !== 'string' || !input.defaultSpeaker.trim())) issues.push('defaultSpeaker is required for plain_paragraphs.');
  if (issues.length) throw new ManualTranscriptValidationError(issues);
}

function parseSpeakerLines(text, { timestamped }) {
  const utterances = [];
  const pattern = timestamped
    ? /^\[([^\]]+)]\s*([^:]+):\s*(.+)$/
    : /^([^:]+):\s*(.+)$/;
  for (const [index, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(pattern);
    if (!match) throw new ManualTranscriptValidationError([`Line ${index + 1} must include ${timestamped ? '[timestamp] Speaker: text' : 'Speaker: text'}.`]);
    const timestamp = timestamped ? parseTimestamp(match[1]) : null;
    const speakerName = (timestamped ? match[2] : match[1]).trim();
    const utteranceText = (timestamped ? match[3] : match[2]).trim();
    if (timestamped && timestamp === null) throw new ManualTranscriptValidationError([`Line ${index + 1} has an invalid timestamp.`]);
    if (!speakerName || speakerName.length > limits.maximumSpeakerCharacters) throw new ManualTranscriptValidationError([`Line ${index + 1} has an invalid speaker name.`]);
    if (!utteranceText || utteranceText.length > limits.maximumUtteranceCharacters) throw new ManualTranscriptValidationError([`Line ${index + 1} has text longer than ${limits.maximumUtteranceCharacters} characters.`]);
    utterances.push({ speakerName, text: utteranceText, start: timestamp });
  }
  return utterances;
}

function parseParagraphs(text, defaultSpeaker) {
  // Plain notes have no diarization; the supplied label is attribution chosen by the owner, not an inferred speaker role.
  return text.split(/\n\s*\n/).map((paragraph) => normaliseText(paragraph)).filter(Boolean).map((paragraph, index) => {
    if (paragraph.length > limits.maximumUtteranceCharacters) throw new ManualTranscriptValidationError([`Paragraph ${index + 1} has text longer than ${limits.maximumUtteranceCharacters} characters.`]);
    return { speakerName: defaultSpeaker.trim(), text: paragraph, start: null };
  });
}

/** Parses owner-supplied text without contacting Recall or an LLM. */
export function parseManualTranscript(input) {
  validateRequest(input);
  const text = normaliseText(input.text);
  const rawUtterances = input.format === 'plain_paragraphs'
    ? parseParagraphs(text, input.defaultSpeaker)
    : parseSpeakerLines(text, { timestamped: input.format === 'timestamped_speaker_lines' });
  if (!rawUtterances.length) throw new ManualTranscriptValidationError(['The transcript did not contain any utterances.']);
  if (rawUtterances.length > limits.maximumUtterances) throw new ManualTranscriptValidationError([`The transcript exceeds ${limits.maximumUtterances} utterances.`]);
  const speakerNames = [...new Set(rawUtterances.map((utterance) => utterance.speakerName))];
  if (speakerNames.length > limits.maximumSpeakers) throw new ManualTranscriptValidationError([`The transcript exceeds ${limits.maximumSpeakers} speakers.`]);
  for (let index = 1; index < rawUtterances.length; index += 1) {
    if (rawUtterances[index].start !== null && rawUtterances[index].start < rawUtterances[index - 1].start) throw new ManualTranscriptValidationError([`Line timestamps must be non-decreasing (line ${index + 1}).`]);
  }
  const timestampsAvailable = input.format === 'timestamped_speaker_lines';
  const utterances = rawUtterances.map((utterance, index) => {
    const next = rawUtterances[index + 1];
    const startTimestamp = timestampsAvailable ? { relative: utterance.start, absolute: null } : null;
    const end = timestampsAvailable && next ? next.start : null;
    const endTimestamp = end === null ? null : { relative: end, absolute: null };
    return {
      id: `manual-utterance-${index + 1}`,
      speakerId: speakerKey(utterance.speakerName),
      speakerName: utterance.speakerName,
      speaker: utterance.speakerName,
      languageCode: null,
      text: utterance.text,
      startTimestamp,
      endTimestamp,
      durationSeconds: end === null || utterance.start === null ? null : end - utterance.start,
    };
  });
  const participants = speakerNames.map((speakerName) => ({ id: speakerKey(speakerName), name: speakerName }));
  return {
    format: input.format,
    originalTextSha256: crypto.createHash('sha256').update(text).digest('hex'),
    utterances,
    participants,
    timestampsAvailable,
    analytics: timestampsAvailable ? calculateMeetingAnalytics(utterances) : null,
    warnings: timestampsAvailable ? ['The final utterance has no derived end time.'] : ['Timestamps were not supplied; talk-time analytics is unavailable.'],
  };
}
