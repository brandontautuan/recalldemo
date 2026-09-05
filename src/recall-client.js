const retryable = new Set([429, 503, 507]);

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
    if (retryable.has(response.status) && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : (250 * 2 ** attempt) + Math.random() * 150;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.request(path, { method, body }, attempt + 1);
    }
    if (!response.ok) throw new Error(`Recall request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  }

  createBot({ meetingUrl, joinAt = new Date().toISOString(), intentId }) {
    return this.request('/api/v1/bot/', { method: 'POST', body: {
      meeting_url: meetingUrl, join_at: joinAt, bot_name: 'Recall Notetaker',
      recording_config: { video_mixed_layout: 'speaker_view' },
      metadata: { source: 'meeting-url', scheduling_intent_id: intentId },
    }});
  }

  createTranscript(recordingId) {
    return this.request(`/api/v1/recording/${recordingId}/create_transcript/`, { method: 'POST', body: {
      provider: { recallai_async: { language_code: 'auto' } },
      diarization: { use_separate_streams_when_available: true },
    }});
  }

  getTranscript(id) { return this.request(`/api/v1/transcript/${id}/`); }
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
