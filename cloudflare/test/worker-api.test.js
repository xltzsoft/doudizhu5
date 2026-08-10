import { describe, expect, it } from 'vitest';
import worker from '../src/worker.js';
import { D1Store } from '../src/d1-store.js';
import { FakeD1Database } from './fakes.js';
import { hashPassword } from '../src/auth.js';

function makeEnv(db = new FakeD1Database()) {
  return {
    DB: db,
    JWT_SECRET: 'test-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'admin-pass',
    LLM_API_KEY: 'test-secret-key',
    GAME_HUB: {
      idFromName: name => name,
      get: () => ({
        fetch: async request => {
          const url = new URL(request.url);
          if (url.pathname === '/rooms') return Response.json({ rooms: [], onlineUsers: 0 });
          return Response.json({ error: 'missing' }, { status: 404 });
        }
      })
    },
    ASSETS: {
      fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } })
    }
  };
}

async function json(response) {
  return response.json();
}

describe('worker HTTP API', () => {
  it('registers, logs in, and returns profile', async () => {
    const env = makeEnv();
    const registerResponse = await worker.fetch(new Request('https://example.com/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', nickname: '爱丽丝', password: '1234' })
    }), env);
    expect(registerResponse.status).toBe(200);
    const registered = await json(registerResponse);
    expect(registered).toMatchObject({ username: 'alice', nickname: '爱丽丝' });
    expect(registered.token).toBeTruthy();

    const loginResponse = await worker.fetch(new Request('https://example.com/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: '1234' })
    }), env);
    expect(loginResponse.status).toBe(200);
    const loggedIn = await json(loginResponse);

    const profileResponse = await worker.fetch(new Request('https://example.com/api/profile', {
      headers: { authorization: `Bearer ${loggedIn.token}` }
    }), env);
    expect(await json(profileResponse)).toMatchObject({ username: 'alice', displayName: '爱丽丝' });
  });

  it('rejects duplicate nickname and invalid player token', async () => {
    const env = makeEnv();
    await worker.fetch(new Request('https://example.com/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', nickname: '同名', password: '1234' })
    }), env);
    const duplicateResponse = await worker.fetch(new Request('https://example.com/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', nickname: '同名', password: '1234' })
    }), env);
    expect(duplicateResponse.status).toBe(400);
    expect(await json(duplicateResponse)).toMatchObject({ error: '昵称已被使用' });

    const profileResponse = await worker.fetch(new Request('https://example.com/api/profile', {
      headers: { authorization: 'Bearer bad-token' }
    }), env);
    expect(profileResponse.status).toBe(401);
  });

  it('serves admin ai settings and room overview', async () => {
    const env = makeEnv();
    const loginResponse = await worker.fetch(new Request('https://example.com/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin-pass' })
    }), env);
    const { token } = await json(loginResponse);

    const aiResponse = await worker.fetch(new Request('https://example.com/api/admin/ai-settings', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        difficulty: 'hard',
        llmEnabled: true,
        llmApiUrl: 'http://sub.stzo.cn:11666/v1/',
        llmModel: 'K2.6-Inst'
      })
    }), env);
    const aiSettings = await json(aiResponse);
    expect(aiSettings).toMatchObject({
      difficulty: 'hard',
      llmEnabled: true,
      llmApiUrl: 'http://sub.stzo.cn:11666/v1',
      llmModel: 'K2.6-Inst',
      llmApiKeyConfigured: true
    });
    expect(JSON.stringify(aiSettings)).not.toContain('test-secret-key');

    const overviewResponse = await worker.fetch(new Request('https://example.com/api/admin/overview', {
      headers: { authorization: `Bearer ${token}` }
    }), env);
    expect(await json(overviewResponse)).toMatchObject({
      roomCount: 0,
      aiSettings: {
        difficulty: 'hard',
        llmEnabled: true,
        llmApiKeyConfigured: true
      }
    });
  });

  it('allows admins to set a negative user score but keeps count fields non-negative', async () => {
    const env = makeEnv();
    await worker.fetch(new Request('https://example.com/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'debtor', nickname: 'debtor', password: '1234' })
    }), env);

    const loginResponse = await worker.fetch(new Request('https://example.com/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin-pass' })
    }), env);
    const { token } = await json(loginResponse);

    const updateScoreResponse = await worker.fetch(new Request('https://example.com/api/admin/users/debtor', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ score: -25 })
    }), env);
    expect(updateScoreResponse.status).toBe(200);
    expect(await json(updateScoreResponse)).toMatchObject({ username: 'debtor', score: -25 });

    const updateWinsResponse = await worker.fetch(new Request('https://example.com/api/admin/users/debtor', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ wins: -1 })
    }), env);
    expect(updateWinsResponse.status).toBe(400);

    const overviewResponse = await worker.fetch(new Request('https://example.com/api/admin/overview', {
      headers: { authorization: `Bearer ${token}` }
    }), env);
    expect(await json(overviewResponse)).toMatchObject({ totalScore: -25 });
  });

  it('returns leaderboard and history from D1', async () => {
    const db = new FakeD1Database();
    const store = new D1Store(db);
    await store.createUser('u1', 'alice', await hashPassword('1234'), 'alice');
    await store.updateStats('alice', 1, 0, 50);
    await store.saveGameHistory({ id: 'g1', roomName: '房间', players: ['alice'], scores: { alice: 50 } });
    const env = makeEnv(db);

    const leaderboard = await worker.fetch(new Request('https://example.com/api/leaderboard'), env);
    expect((await json(leaderboard))[0]).toMatchObject({ username: 'alice', score: 50 });

    const history = await worker.fetch(new Request('https://example.com/api/history'), env);
    expect((await json(history))[0]).toMatchObject({ id: 'g1', room_name: '房间' });
  });

  it('notifies the game hub when avatar or nickname changes', async () => {
    const env = makeEnv();
    const hubCalls = [];
    env.GAME_HUB = {
      idFromName: name => name,
      get: () => ({
        fetch: async request => {
          const url = new URL(request.url);
          if (url.pathname === '/profile-changed') {
            hubCalls.push({ method: request.method, body: await request.json().catch(() => null) });
            return Response.json({ success: true });
          }
          if (url.pathname === '/rooms') return Response.json({ rooms: [], onlineUsers: 0 });
          return Response.json({ error: 'missing' }, { status: 404 });
        }
      })
    };

    const registerResponse = await worker.fetch(new Request('https://example.com/api/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', nickname: '爱丽丝', password: '1234' })
    }), env);
    const { token } = await json(registerResponse);

    const avatarResponse = await worker.fetch(new Request('https://example.com/api/profile/avatar', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ avatarData: 'data:image/webp;base64,QUJD' })
    }), env);
    expect(avatarResponse.status).toBe(200);

    const nicknameResponse = await worker.fetch(new Request('https://example.com/api/profile', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ nickname: '新昵称' })
    }), env);
    expect(nicknameResponse.status).toBe(200);

    expect(hubCalls).toEqual([
      { method: 'POST', body: { username: 'alice' } },
      { method: 'POST', body: { username: 'alice' } }
    ]);
  });
});
