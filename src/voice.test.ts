import assert from 'node:assert/strict';
import { synthesizeSpeech } from './voice.js';

{
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.MISTRAL_API_KEY;
  let speechCalls = 0;
  let voiceCalls = 0;

  process.env.MISTRAL_API_KEY = 'test-key';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/audio/voices')) {
      voiceCalls += 1;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
    if (url.includes('/audio/speech')) {
      speechCalls += 1;
      return new Response(JSON.stringify({
        object: 'error',
        message: 'Request blocked by guardrail policy',
        type: 'guardrail_violation',
        code: '1920',
        raw_status_code: 403,
      }), { status: 403 });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => synthesizeSpeech('Guardrail blocked sample dialogue.', 'voice-a'),
      /guardrail_violation/,
    );
    await assert.rejects(
      () => synthesizeSpeech('  Guardrail   blocked sample dialogue. ', 'voice-a'),
      /guardrail_violation/,
    );
    assert.equal(speechCalls, 1);
    assert.equal(voiceCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = originalKey;
  }
}
