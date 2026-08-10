import { afterEach, describe, expect, it, vi } from 'vitest';
import { AIPlayer } from '../../game/ai.js';

describe('AIPlayer LLM configuration', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses configured OpenAI-compatible endpoint only when LLM is enabled for hard mode', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"play","cards":["3"]}' } }]
    }), {
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const ai = new AIPlayer({
      difficulty: 'hard',
      llmEnabled: true,
      llmApiUrl: 'http://sub.stzo.cn:11666/v1',
      llmApiKey: 'test-key',
      llmModel: 'K2.6-Inst'
    });

    const decision = await ai.decide({
      aiDifficulty: 'hard',
      myHand: ['3'],
      mustPlay: true,
      hints: [['3']],
      players: [],
      myName: 'AI_1',
      myTeam: 'farmer'
    });

    expect(decision).toEqual({ action: 'play', cards: ['3'] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://sub.stzo.cn:11666/v1/chat/completions');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ model: 'K2.6-Inst' });
  });

  it('keeps LLM prompts compact and maps hintIndex to exact card uids', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"play","hintIndex":1}' } }]
    }), {
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const ai = new AIPlayer({
      difficulty: 'hard',
      llmEnabled: true,
      llmApiUrl: 'https://tllm.stzo.cn/v1',
      llmApiKey: 'test-key',
      llmModel: 'test'
    });

    const decision = await ai.decide({
      aiDifficulty: 'hard',
      myName: 'AI_2',
      myTeam: 'farmer',
      myHand: [
        { uid: 'u1', id: '♠3' },
        { uid: 'u2', id: '♥4' },
        { uid: 'u3', id: '♣4' },
        { uid: 'u4', id: '♦9' }
      ],
      mustPlay: true,
      hints: [['u1'], ['u2', 'u3']],
      players: [
        { name: 'p1', cardCount: 12, team: 'landlord', isLandlord: true },
        { name: 'AI_2', cardCount: 4, team: 'farmer' }
      ]
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userPrompt = body.messages.find(message => message.role === 'user').content;

    expect(decision).toEqual({ action: 'play', cards: ['u2', 'u3'] });
    expect(userPrompt.length).toBeLessThan(2200);
    expect(userPrompt).toContain('"candidates"');
    expect(userPrompt).toContain('"hintIndex":1');
    expect(body.max_tokens).toBeLessThanOrEqual(80);
  });

  it('aborts slow LLM calls using the configured timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const ai = new AIPlayer({
      difficulty: 'hard',
      llmEnabled: true,
      llmApiKey: 'test-key',
      llmTimeoutMs: 25
    });

    const decisionPromise = ai.decide({
      aiDifficulty: 'hard',
      myHand: [{ uid: 'u1', id: '♠3' }],
      mustPlay: true,
      hints: [['u1']],
      players: [],
      myName: 'AI_1',
      myTeam: 'farmer'
    });

    await vi.advanceTimersByTimeAsync(25);

    await expect(decisionPromise).resolves.toEqual({ action: 'play', cards: ['♠3'] });
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });
});
