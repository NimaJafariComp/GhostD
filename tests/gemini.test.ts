import { describe, expect, it } from 'vitest';

import { GeminiApiError, GeminiTargetAdapter } from '../src/adapters/gemini/target.js';

describe('GeminiTargetAdapter', () => {
  it('defaults to the model available to new Gemini API projects', () => {
    const target = new GeminiTargetAdapter({ apiKey: 'test-key' });

    expect(target.model).toBe('gemini-3.6-flash');
  });

  it('uses the stateless generateContent boundary without tools or workspace access', async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const target = new GeminiTargetAdapter({
      apiKey: 'test-key',
      model: 'gemini-test',
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), body: String(init?.body) });
        return new Response(JSON.stringify({
          responseId: 'gemini-response-1',
          modelVersion: 'gemini-test-version',
          candidates: [{ content: { parts: [{ text: 'Read-only answer.' }] } }],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5 },
        }));
      },
    });

    const result = await target.ask({ system: 'Read only.', prompt: 'Explain.', responseFormat: 'json' });
    const body = JSON.parse(requests[0]?.body ?? '') as Record<string, unknown>;

    expect(target.capabilities).toMatchObject({
      provider: 'gemini',
      supportsNativeFork: false,
      supportsSessionResume: false,
      workspaceAccess: 'none',
      toolAccess: 'none',
      writeAccess: false,
    });
    expect(requests[0]?.url).toContain('/gemini-test:generateContent');
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: 'Read only.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Explain.' }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    });
    expect(body).not.toHaveProperty('tools');
    expect(result).toEqual({
      providerHandle: 'gemini-response-1',
      model: 'gemini-test-version',
      text: 'Read-only answer.',
      inputTokens: 11,
      outputTokens: 5,
    });
  });

  it('does not expose Gemini response bodies on provider errors', async () => {
    const target = new GeminiTargetAdapter({
      apiKey: 'test-key',
      fetchImpl: async () => new Response('contains private provider detail', { status: 500 }),
    });

    await expect(target.ask({ system: 'Read only.', prompt: 'Hello.' })).rejects.toEqual(new GeminiApiError(500));
  });
});
