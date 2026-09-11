/** Validates cited answers over a server-rebuilt, user-reviewed local-context preview. */
import crypto from 'node:crypto';
import { canonicalJson } from './context-seed.js';

export class LocalRecapValidationError extends Error {
  constructor(issues) {
    super(`Local recap failed validation: ${issues.join('; ')}`);
    this.issues = issues;
  }
}

export const localRecapSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'citations'],
  properties: {
    answer: { type: 'string' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceId', 'claim'],
        properties: { sourceId: { type: 'string' }, claim: { type: 'string' } },
      },
    },
  },
};

export const recapQuestionHash = (question) => crypto.createHash('sha256').update(question.trim()).digest('hex');
export const recapPreviewHash = (preview) => crypto.createHash('sha256').update(canonicalJson(preview)).digest('hex');

/** Validates provider output against the exact, user-reviewed context preview. */
export function validateLocalRecap(output, preview) {
  const issues = [];
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new LocalRecapValidationError(['response must be an object']);
  if (Object.keys(output).some((field) => !['answer', 'citations'].includes(field))) issues.push('response contains unsupported fields');
  if (typeof output.answer !== 'string' || !output.answer.trim() || output.answer.length > 12_000) issues.push('answer must be a non-empty string of at most 12000 characters');
  if (!Array.isArray(output.citations) || output.citations.length > 40) issues.push('citations must contain at most 40 entries');
  const sources = new Map((preview.sources ?? []).map((source) => [source.id, source]));
  for (const [index, citation] of (output.citations ?? []).entries()) {
    const label = `citations[${index}]`;
    if (!citation || typeof citation !== 'object' || Array.isArray(citation)) { issues.push(`${label} must be an object`); continue; }
    if (Object.keys(citation).some((field) => !['sourceId', 'claim'].includes(field))) issues.push(`${label} contains unsupported fields`);
    if (typeof citation.sourceId !== 'string' || !sources.has(citation.sourceId)) issues.push(`${label}.sourceId must reference a displayed source`);
    if (typeof citation.claim !== 'string' || !citation.claim.trim() || citation.claim.length > 1_000) issues.push(`${label}.claim must be a non-empty string of at most 1000 characters`);
  }
  if (!issues.length && !output.citations.length) issues.push('at least one source citation is required');
  if (issues.length) throw new LocalRecapValidationError(issues);
  return {
    answer: output.answer.trim(),
    citations: output.citations.map((citation) => {
      const source = sources.get(citation.sourceId);
      return {
        sourceId: source.id,
        claim: citation.claim.trim(),
        label: source.label,
        kind: source.kind,
        revision: source.revision,
        sourcePath: source.sourcePath ?? null,
        lineStart: source.lineStart ?? null,
        lineEnd: source.lineEnd ?? null,
      };
    }),
  };
}
