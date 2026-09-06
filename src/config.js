const liveRequired = ['RECALL_API_KEY', 'RECALL_WEBHOOK_VERIFICATION_SECRET', 'PUBLIC_API_BASE_URL'];
const strictGroqModels = new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);

export function createConfig(env = process.env) {
  const mockMode = env.MOCK_MODE === 'true';
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
  const groqMaximumConcurrency = Number(env.GROQ_MAX_CONCURRENCY || 1);
  const groqMaximumInputCharacters = Number(env.GROQ_MAX_INPUT_CHARACTERS || 18_000);
  if (!Number.isInteger(groqMaximumConcurrency) || groqMaximumConcurrency < 1 || groqMaximumConcurrency > 4) throw new Error('GROQ_MAX_CONCURRENCY must be an integer from 1 to 4.');
  if (!Number.isInteger(groqMaximumInputCharacters) || groqMaximumInputCharacters < 1_000) throw new Error('GROQ_MAX_INPUT_CHARACTERS must be an integer of at least 1000.');
  return Object.freeze({
    mockMode,
    region: env.RECALL_REGION,
    apiKey: env.RECALL_API_KEY || null,
    webhookSecret: env.RECALL_WEBHOOK_VERIFICATION_SECRET || null,
    publicApiBaseUrl: publicUrl?.origin ?? null,
    calendarRegionalCallbackUri: env.RECALL_CALENDAR_REGIONAL_CALLBACK_URI || null,
    groqApiKey: env.GROQ_API_KEY || null,
    groqModel,
    groqMaximumConcurrency,
    groqMaximumInputCharacters,
  });
}
