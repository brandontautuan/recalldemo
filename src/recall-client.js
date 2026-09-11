/** Isolated Recall API client; it owns transport retries but never application lifecycle decisions. */
const transientReadFailures = new Set([503, 507]);

export class RecallClient {
  constructor(config, fetchImpl = fetch) {
    this.baseUrl = `https://${config.region}.recall.ai`;
    this.apiKey = config.apiKey;
    this.fetch = fetchImpl;
  }

  async request(path, { method = 'GET', body } = {}, attempt = 0) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.apiKey, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    // Only explicit rate limits and safe read failures retry; other write failures remain ambiguous to the caller.
    const mayRetry = response.status === 429 || (method === 'GET' && transientReadFailures.has(response.status));
    if (mayRetry && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : (250 * 2 ** attempt) + Math.random() * 150;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.request(path, { method, body }, attempt + 1);
    }
    if (!response.ok) throw new Error(`Recall request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  }

  createBot({ meetingUrl, joinAt = new Date().toISOString(), intentId, schedulingKey }) {
    return this.request('/api/v1/bot/', { method: 'POST', body: {
      meeting_url: meetingUrl, join_at: joinAt, bot_name: 'Recall Notetaker',
      recording_config: { video_mixed_layout: 'speaker_view' },
      metadata: { source: 'meeting-url', scheduling_intent_id: intentId, scheduling_key: schedulingKey },
    }});
  }

  createTranscript(recordingId) {
    return this.request(`/api/v1/recording/${recordingId}/create_transcript/`, { method: 'POST', body: {
      provider: { recallai_async: { language_code: 'auto' } },
      diarization: { use_separate_streams_when_available: true },
    }});
  }

  getBot(id) { return this.request(`/api/v1/bot/${encodeURIComponent(id)}/`); }
  getTranscript(id) { return this.request(`/api/v1/transcript/${id}/`); }
  async downloadTranscript(downloadUrl) {
    const url = new URL(downloadUrl);
    // Treat the provider URL as untrusted input so a webhook cannot turn this server into an arbitrary fetch proxy.
    if (url.protocol !== 'https:' || url.hostname !== `${this.baseUrl.slice('https://'.length)}`) {
      throw new Error('Recall returned an invalid transcript download URL.');
    }
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`Recall transcript download failed (${response.status})`);
    return response.json();
  }
  listCalendarEvents(calendarId, updatedSince) {
    return this.request(`/api/v2/calendar-events/?calendar_id=${encodeURIComponent(calendarId)}&updated_at__gte=${encodeURIComponent(updatedSince)}`);
  }
  scheduleCalendarEvent(eventId, deduplicationKey) {
    return this.request(`/api/v2/calendar-events/${eventId}/bot/`, { method: 'POST', body: {
      deduplication_key: deduplicationKey,
      bot_config: { bot_name: 'Recall Notetaker', recording_config: { video_mixed_layout: 'speaker_view' }, metadata: { source: 'calendar', opt_in: '[recall]' } },
    }});
  }
}
