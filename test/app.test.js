import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createConfig } from '../src/config.js';
import { eligibleCalendarEvent } from '../src/app.js';
import { verifyRecallRequest } from '../src/verify.js';

const secret = `whsec_${Buffer.from('test-signing-key').toString('base64')}`;
test('configuration is injected and pins the US West Recall region', () => {
  const config = createConfig({ RECALL_REGION: 'us-west-2', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' });
  assert.equal(config.region, 'us-west-2');
  assert.throws(() => createConfig({ RECALL_REGION: 'us-east-1', RECALL_API_KEY: 'token', RECALL_WEBHOOK_VERIFICATION_SECRET: secret, PUBLIC_API_BASE_URL: 'https://recall-demo.ngrok.app' }));
});
test('only future tagged calendar events with a meeting URL are eligible', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(eligibleCalendarEvent({ id:'1', raw:{summary:'Planning [recall]'}, meeting_url:'https://meet.google.com/a', start_time:future }), true);
  assert.equal(eligibleCalendarEvent({ id:'2', raw:{summary:'Planning'}, meeting_url:'https://meet.google.com/a', start_time:future }), false);
  assert.equal(eligibleCalendarEvent({ id:'3', raw:{summary:'Planning [recall]'}, meeting_url:null, start_time:future }), false);
  assert.equal(eligibleCalendarEvent({ id:'4', raw:{summary:'Planning [recall]'}, meeting_url:'https://meet.google.com/a', start_time:'2020-01-01T00:00:00Z' }), false);
});
test('Recall webhook verification requires a valid raw-body signature', () => {
  const raw = '{"event":"recording.done"}', id = 'msg_1', timestamp = '1731705121';
  const signature = crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64');
  assert.equal(verifyRecallRequest(secret, {'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}, raw), true);
  assert.equal(verifyRecallRequest(secret, {'webhook-id':id,'webhook-timestamp':timestamp,'webhook-signature':`v1,${signature}`}, '{}'), false);
});
