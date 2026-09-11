/** Deliberate CLI entry point for applying checked-in project-context SQLite migrations. */
import { ProjectContextStore } from '../context-db.js';

const contextStore = new ProjectContextStore(process.env.DATABASE_PATH || 'data/project-context.sqlite');
try {
  const appliedVersions = contextStore.migrate();
  const suffix = appliedVersions.length ? `applied ${appliedVersions.join(', ')}` : 'already current';
  console.log(`Project-context schema version ${contextStore.schemaVersion()} (${suffix}).`);
} finally {
  contextStore.close();
}
