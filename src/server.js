import http from 'node:http';
import { Readable } from 'node:stream';
import { createConfig } from './config.js';
import { RecallClient } from './recall-client.js';
import { JsonStore } from './store.js';
import { createApp } from './app.js';
import { mockFixture, MockRecallClient } from './mock-data.js';
import { GroqClient } from './groq-client.js';
import { ProjectContextStore } from './context-db.js';

const smoke = process.argv.includes('--smoke');
const config = createConfig(process.env);
const contextStore = new ProjectContextStore(smoke ? ':memory:' : config.databasePath);
contextStore.migrate();
const store = new JsonStore();
if (config.mockMode) store.seedMock(mockFixture);
const recall = config.mockMode ? new MockRecallClient() : new RecallClient(config);
const analysis = new GroqClient({
  apiKey: config.groqApiKey,
  model: config.groqModel,
  maximumConcurrency: config.groqMaximumConcurrency,
  maximumInputCharacters: config.groqMaximumInputCharacters,
});
const app = createApp({ config, recall, store, analysis, contextStore });
if (smoke) {
  const req = Object.assign(Readable.from([]), { method: 'GET', url: '/', headers: {} });
  const res = { statusCode: 0, writeHead(status) { this.statusCode = status; }, end() {} };
  await app(req, res);
  if (res.statusCode !== 200) throw new Error(`Smoke request failed with ${res.statusCode}`);
  contextStore.close();
  console.log('Production app constructed and its GET / handler returned 200.');
  process.exit(0);
}
const host = process.env.HOST || '127.0.0.1';
http.createServer(app).listen(process.env.PORT || 3000, host, () => console.log(`Recall Meeting Bot listening on http://${host}:${process.env.PORT || 3000}`));
