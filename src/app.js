import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyRecallRequest } from './verify.js';

const publicDir = path.resolve('public');
const titleOf = (event) => event.raw?.summary ?? event.raw?.title ?? event.title ?? '';
export const eligibleCalendarEvent = (event, now = new Date()) =>
  !event.is_deleted && Boolean(event.meeting_url) && new Date(event.start_time) > now && titleOf(event).includes('[recall]');

const readBody = async (req) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

export function createApp({ config, recall, store, logger = console }) {
  const processWebhook = async (event) => {
    const type = event.event ?? event.type;
    const data = event.data ?? {};
    if (type === 'recording.done') {
      const recordingId = data.recording?.id;
      if (recordingId && store.claim(`transcript:${recordingId}`)) await recall.createTranscript(recordingId);
    } else if (type === 'transcript.done') {
      const transcriptId = data.transcript?.id;
      if (transcriptId && store.claim(`transcript-result:${transcriptId}`)) {
        const transcript = await recall.getTranscript(transcriptId);
        store.saveTranscript(transcriptId, { id: transcriptId, status: 'done', transcript, receivedAt: new Date().toISOString() });
      }
    } else if (type === 'transcript.failed') {
      const id = data.transcript?.id ?? crypto.randomUUID();
      store.saveTranscript(id, { id, status: 'failed', failureCode: data.status?.sub_code ?? 'unknown', receivedAt: new Date().toISOString() });
    } else if (type === 'calendar.sync_events') {
      const calendarId = data.calendar_id;
      if (!calendarId) return;
      const response = await recall.listCalendarEvents(calendarId, data.last_updated_ts);
      const events = response.results ?? response.data ?? [];
      for (const calendarEvent of events) {
        if (!eligibleCalendarEvent(calendarEvent)) { store.rememberEvent(calendarEvent.id, { status: 'skipped', reason: 'not-tagged-future-meeting' }); continue; }
        const key = `calendar-schedule:${calendarEvent.id}:${calendarEvent.updated_at}`;
        if (!store.claim(key)) continue;
        const scheduled = await recall.scheduleCalendarEvent(calendarEvent.id, `calendar-event:${calendarEvent.ical_uid ?? calendarEvent.id}`);
        store.rememberEvent(calendarEvent.id, { status: 'scheduled', botIds: scheduled.bots?.map((bot) => bot.id) ?? [], updatedAt: calendarEvent.updated_at });
      }
    } else if (type === 'calendar.update') {
      store.rememberEvent(`calendar:${data.calendar_id}`, { status: 'calendar-updated', updatedAt: new Date().toISOString() });
    }
  };

  return async function app(req, res) {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(fs.readFileSync(path.join(publicDir, 'index.html'))); }
    if (req.method === 'GET' && url.pathname === '/api/dashboard') return json(res, 200, store.dashboard());
    if (req.method === 'POST' && url.pathname === '/api/bots') {
      const body = JSON.parse(await readBody(req));
      if (!/^https:\/\//.test(body.meetingUrl ?? '')) return json(res, 400, { error: 'A supported HTTPS meeting URL is required.' });
      const intent = store.addIntent({ id: crypto.randomUUID(), meetingUrl: body.meetingUrl, joinAt: body.joinAt || new Date().toISOString(), status: 'creating', createdAt: new Date().toISOString() });
      try { const bot = await recall.createBot({ meetingUrl: intent.meetingUrl, joinAt: intent.joinAt, intentId: intent.id }); return json(res, 201, store.updateIntent(intent.id, { botId: bot.id, status: 'scheduled' })); }
      catch (error) { logger.error('bot-create-failed', { intentId: intent.id }); return json(res, 502, store.updateIntent(intent.id, { status: 'failed', error: 'Recall could not schedule this bot.' })); }
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/recall') {
      const rawBody = await readBody(req);
      if (!verifyRecallRequest(config.webhookSecret, req.headers, rawBody)) return json(res, 401, { error: 'Invalid Recall signature.' });
      const event = JSON.parse(rawBody);
      const eventId = req.headers['webhook-id'] ?? req.headers['svix-id'];
      if (store.claim(`webhook:${eventId}`)) setImmediate(() => processWebhook(event).catch(() => logger.error('recall-webhook-processing-failed', { eventType: event.event ?? event.type, eventId })));
      return json(res, 202, { accepted: true });
    }
    if (req.method === 'GET' && url.pathname === '/callbacks/calendar') {
      if (!config.calendarRegionalCallbackUri) return json(res, 503, { error: 'Calendar setup has not returned a Recall callback URI yet.' });
      const allowed = ['state', 'code', 'error', 'recall_calendar_setup_probe'];
      const params = new URLSearchParams([...url.searchParams].filter(([key]) => allowed.includes(key)));
      if (![...params.keys()].some((key) => key === 'code' || key === 'error' || key === 'recall_calendar_setup_probe')) return json(res, 400, { error: 'Missing calendar callback result.' });
      const target = new URL(config.calendarRegionalCallbackUri); target.search = params.toString();
      const forward = await fetch(target, { redirect: 'manual' });
      res.writeHead(forward.status); return res.end(await forward.text());
    }
    json(res, 404, { error: 'Not found' });
  };
}
