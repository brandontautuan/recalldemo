import fs from 'node:fs';
import path from 'node:path';

export class JsonStore {
  constructor(file = path.resolve('data/recall-store.json')) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { intents: {}, events: {}, processed: {}, transcripts: {} };
  }
  persist() { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  addIntent(intent) { this.data.intents[intent.id] = intent; this.persist(); return intent; }
  updateIntent(id, patch) { Object.assign(this.data.intents[id] ?? {}, patch); this.persist(); return this.data.intents[id]; }
  claim(key) { if (this.data.processed[key]) return false; this.data.processed[key] = new Date().toISOString(); this.persist(); return true; }
  rememberEvent(id, patch) { this.data.events[id] = { ...(this.data.events[id] ?? {}), ...patch }; this.persist(); }
  saveTranscript(id, transcript) { this.data.transcripts[id] = transcript; this.persist(); }
  dashboard() { return { intents: Object.values(this.data.intents).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), transcripts: Object.values(this.data.transcripts) }; }
}
