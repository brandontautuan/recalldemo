There are two mock paths now.

  The built-in demo fixture lives in src/mock-data.js. It is already
  normalized—not raw Recall JSON:

  {
    meeting: {
      id: 'mock-architecture-review',
      title: 'Event ingestion architecture review',
      status: 'completed',
      participants: [{ id: '1', name: 'Maya Chen' }],
      transcriptStatus: 'done',
      isMock: true
    },
    transcript: {
      id: 'mock-transcript-001',
      meetingId: 'mock-architecture-review',
      status: 'done',
      utterances: [
        {
          id: 'mock-utterance-1',
          speakerId: '1',
          speakerName: 'Maya Chen',
          text: 'We need one canonical event model...',
          startTimestamp: { relative: 0, absolute: null },
          endTimestamp: { relative: 9.5, absolute: null },
          durationSeconds: 9.5
        }
      ],
      analytics: { /* deterministic speaking-time metrics */ },
      isMock: true
    },
    artifacts: [/* fixture ADRs, actions, bugs, risks */]
  }

  The new manual transcript path accepts simpler pasted text and converts it
  to that same normalized utterances shape.

  Timestamped input:

  [00:00] Maya: We need one canonical event model.
  [00:12.500] Jon: I agree; normalize at the boundary.

  Speaker-only input:

  Maya: We need one canonical event model.
  Jon: I agree; normalize at the boundary.

  Or plain paragraphs with one default speaker. Manual transcripts are stored
  with source: 'manual', are not marked as the demo fixture, and do not create
  a Recall bot/webhook history.