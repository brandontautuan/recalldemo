import http from 'node:http';
import { Readable } from 'node:stream';
import { createConfig } from './config.js';
import { RecallClient } from './recall-client.js';
import { JsonStore } from './store.js';
import { createApp } from './app.js';

const smoke = process.argv.includes('--smoke');
const config = createConfig(process.env);
const app = createApp({ config, recall: new RecallClient(config), store: new JsonStore() });
if (smoke) {
  const req = Object.assign(Readable.from([]), { method: 'GET', url: '/', headers: {} });
  const res = { statusCode: 0, writeHead(status) { this.statusCode = status; }, end() {} };
  await app(req, res);
  if (res.statusCode !== 200) throw new Error(`Smoke request failed with ${res.statusCode}`);
  console.log('Production app constructed and its GET / handler returned 200.');
  process.exit(0);
}
http.createServer(app).listen(process.env.PORT || 3000, () => console.log(`Recall Meeting Bot listening on ${process.env.PORT || 3000}`));
