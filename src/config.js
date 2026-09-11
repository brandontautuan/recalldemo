/** Centralized environment validation; credentials stay server-side and are never defaulted. */
import path from 'node:path';

const liveRequired = ['RECALL_API_KEY', 'RECALL_WEBHOOK_VERIFICATION_SECRET', 'PUBLIC_API_BASE_URL'];
const strictGroqModels = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);

export function createConfig(env = process.env) {
  const mockMode = env.MOCK_MODE === 'true';
  const manualTranscriptEnabled = env.MANUAL_TRANSCRIPT_ENABLED === undefined ? mockMode : env.MANUAL_TRANSCRIPT_ENABLED === 'true';
  const missing = ['RECALL_REGION', ...(mockMode ? [] : liveRequired)].filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  if (env.RECALL_REGION !== 'us-west-2') throw new Error('This application is pinned to Recall us-west-2.');
  const publicUrl = env.PUBLIC_API_BASE_URL ? new URL(env.PUBLIC_API_BASE_URL) : null;
  if (!mockMode && (publicUrl.protocol !== 'https:' || publicUrl.hostname === 'your-reserved-domain.ngrok.app')) {
    throw new Error('PUBLIC_API_BASE_URL must be an actual public HTTPS URL, not the ngrok placeholder.');
  }
  if (!mockMode && !env.RECALL_WEBHOOK_VERIFICATION_SECRET.startsWith('whsec_')) {
    throw new Error('RECALL_WEBHOOK_VERIFICATION_SECRET must be a Recall whsec_ value.');
  }
  const groqModel = env.GROQ_MODEL || 'openai/gpt-oss-20b';
  if (!strictGroqModels.has(groqModel)) throw new Error('GROQ_MODEL must support Groq strict structured outputs.');
  // gpt-oss emits reasoning tokens that count against max_completion_tokens; measured at 2283 of a
  // 4096 budget on a two-utterance transcript at the provider default, versus 59 at 'low'.
  const groqReasoningEffort = env.GROQ_REASONING_EFFORT || 'low';
  if (!['low', 'medium', 'high'].includes(groqReasoningEffort)) throw new Error('GROQ_REASONING_EFFORT must be low, medium, or high.');
  const groqMaximumConcurrency = Number(env.GROQ_MAX_CONCURRENCY || 1);
  const groqMaximumInputCharacters = Number(env.GROQ_MAX_INPUT_CHARACTERS || 18_000);
  // Every artifact carries all 31 schema fields, so a handful of grounded proposals overruns a small
  // completion budget and Groq rejects the truncated JSON it produced.
  const groqMaximumOutputTokens = Number(env.GROQ_MAX_OUTPUT_TOKENS || 16_384);
  const projectContextMaximumCharacters = Number(env.PROJECT_CONTEXT_MAX_CHARACTERS || 12_000);
  const projectRepositoryRoots = (env.PROJECT_REPOSITORY_ROOTS || '').split(path.delimiter).map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root));
  const projectContextAdminToken = env.PROJECT_CONTEXT_ADMIN_TOKEN || null;
  const projectScanMaximumFiles = Number(env.PROJECT_SCAN_MAX_FILES || 20);
  const projectScanMaximumFileBytes = Number(env.PROJECT_SCAN_MAX_FILE_BYTES || 100_000);
  const projectScanMaximumFileCharacters = Number(env.PROJECT_SCAN_MAX_FILE_CHARACTERS || 6_000);
  if (!Number.isInteger(groqMaximumConcurrency) || groqMaximumConcurrency < 1 || groqMaximumConcurrency > 4) throw new Error('GROQ_MAX_CONCURRENCY must be an integer from 1 to 4.');
  if (!Number.isInteger(groqMaximumInputCharacters) || groqMaximumInputCharacters < 1_000) throw new Error('GROQ_MAX_INPUT_CHARACTERS must be an integer of at least 1000.');
  if (!Number.isInteger(groqMaximumOutputTokens) || groqMaximumOutputTokens < 2_048 || groqMaximumOutputTokens > 65_536) throw new Error('GROQ_MAX_OUTPUT_TOKENS must be an integer from 2048 to 65536.');
  if (!Number.isInteger(projectContextMaximumCharacters) || projectContextMaximumCharacters < 1_000 || projectContextMaximumCharacters > 100_000) {
    throw new Error('PROJECT_CONTEXT_MAX_CHARACTERS must be an integer from 1000 to 100000.');
  }
  if (projectContextMaximumCharacters >= groqMaximumInputCharacters) {
    throw new Error('PROJECT_CONTEXT_MAX_CHARACTERS must be smaller than GROQ_MAX_INPUT_CHARACTERS.');
  }
  if (!Number.isInteger(projectScanMaximumFiles) || projectScanMaximumFiles < 1 || projectScanMaximumFiles > 50) throw new Error('PROJECT_SCAN_MAX_FILES must be an integer from 1 to 50.');
  if (!Number.isInteger(projectScanMaximumFileBytes) || projectScanMaximumFileBytes < 1_000 || projectScanMaximumFileBytes > 1_000_000) throw new Error('PROJECT_SCAN_MAX_FILE_BYTES must be an integer from 1000 to 1000000.');
  if (!Number.isInteger(projectScanMaximumFileCharacters) || projectScanMaximumFileCharacters < 500 || projectScanMaximumFileCharacters > 20_000) throw new Error('PROJECT_SCAN_MAX_FILE_CHARACTERS must be an integer from 500 to 20000.');
  if (projectRepositoryRoots.length && (!projectContextAdminToken || projectContextAdminToken.length < 16)) throw new Error('PROJECT_CONTEXT_ADMIN_TOKEN must contain at least 16 characters when PROJECT_REPOSITORY_ROOTS is configured.');
  return Object.freeze({
    mockMode,
    manualTranscriptEnabled,
    region: env.RECALL_REGION,
    apiKey: env.RECALL_API_KEY || null,
    webhookSecret: env.RECALL_WEBHOOK_VERIFICATION_SECRET || null,
    publicApiBaseUrl: publicUrl?.origin ?? null,
    calendarRegionalCallbackUri: env.RECALL_CALENDAR_REGIONAL_CALLBACK_URI || null,
    groqApiKey: env.GROQ_API_KEY || null,
    groqModel,
    groqReasoningEffort,
    groqMaximumConcurrency,
    groqMaximumInputCharacters,
    groqMaximumOutputTokens,
    databasePath: env.DATABASE_PATH || 'data/project-context.sqlite',
    projectContextSeedPath: env.PROJECT_CONTEXT_SEED_PATH || 'seeds/project-context.example.json',
    projectContextMaximumCharacters,
    projectRepositoryRoots,
    projectContextAdminToken,
    projectScanMaximumFiles,
    projectScanMaximumFileBytes,
    projectScanMaximumFileCharacters,
  });
}
