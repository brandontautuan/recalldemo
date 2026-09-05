const required = [
  'RECALL_REGION',
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_VERIFICATION_SECRET',
  'PUBLIC_API_BASE_URL',
];

export function createConfig(env = process.env) {
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  if (env.RECALL_REGION !== 'us-west-2') throw new Error('This application is pinned to Recall us-west-2.');
  const publicUrl = new URL(env.PUBLIC_API_BASE_URL);
  if (publicUrl.protocol !== 'https:' || publicUrl.hostname === 'YOUR-RESERVED-NGROK-DOMAIN.ngrok.app') {
    throw new Error('PUBLIC_API_BASE_URL must be an actual public HTTPS URL, not the ngrok placeholder.');
  }
  if (!env.RECALL_WEBHOOK_VERIFICATION_SECRET.startsWith('whsec_')) {
    throw new Error('RECALL_WEBHOOK_VERIFICATION_SECRET must be a Recall whsec_ value.');
  }
  return Object.freeze({
    region: env.RECALL_REGION,
    apiKey: env.RECALL_API_KEY,
    webhookSecret: env.RECALL_WEBHOOK_VERIFICATION_SECRET,
    publicApiBaseUrl: publicUrl.origin,
    calendarRegionalCallbackUri: env.RECALL_CALENDAR_REGIONAL_CALLBACK_URI || null,
  });
}
