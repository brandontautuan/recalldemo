import { ProjectContextStore } from '../context-db.js';
import { loadSeedManifest } from '../context-seed.js';

const argumentsList = process.argv.slice(2);
if (argumentsList.some((argument) => argument !== '--dry-run')) throw new Error('Only --dry-run is supported.');
const dryRun = argumentsList.includes('--dry-run');
const databasePath = process.env.DATABASE_PATH || 'data/project-context.sqlite';
const seedPath = process.env.PROJECT_CONTEXT_SEED_PATH || 'seeds/project-context.example.json';
const { manifest, contentSha256 } = loadSeedManifest(seedPath);
const contextStore = new ProjectContextStore(databasePath);
try {
  contextStore.migrate();
  const summary = contextStore.ingestSeed(manifest, { dryRun });
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'committed', schemaVersion: manifest.schemaVersion, manifestSha256: contentSha256, summary }, null, 2));
} finally {
  contextStore.close();
}
