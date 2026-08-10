import { describe, expect, it } from 'vitest';
import { D1Store, buildProfileResponse } from '../src/d1-store.js';
import { FakeD1Database } from './fakes.js';

describe('D1Store', () => {
  it('creates users and enforces name lookup across username and nickname', async () => {
    const store = new D1Store(new FakeD1Database());
    const user = await store.createUser('u1', 'alice', 'hash', '爱丽丝');

    expect(user.username).toBe('alice');
    expect(await store.findUserByName('alice')).toMatchObject({ username: 'alice' });
    expect(await store.findUserByName('爱丽丝')).toMatchObject({ username: 'alice' });
    expect(await store.isNameTaken('爱丽丝', 'bob')).toBe(true);
    expect(await store.isNameTaken('爱丽丝', 'alice')).toBe(false);
  });

  it('updates profile and exposes nickname monthly change flag', async () => {
    const store = new D1Store(new FakeD1Database());
    await store.createUser('u1', 'alice', 'hash', 'alice');
    const updated = await store.updateNickname('alice', '新昵称', new Date().toISOString());
    await store.updateAvatar('alice', 'data:image/png;base64,AAAA');

    expect(buildProfileResponse(updated)).toMatchObject({
      username: 'alice',
      nickname: '新昵称',
      displayName: '新昵称',
      canChangeNicknameThisMonth: false
    });
  });

  it('filters admin game history by keyword', async () => {
    const store = new D1Store(new FakeD1Database());
    await store.saveGameHistory({ id: 'g1', roomName: '西瓜房', players: ['a', 'b'], scores: { a: 10 } });
    await store.saveGameHistory({ id: 'g2', roomName: '苹果房', players: ['c'], scores: { c: 5 } });

    const byRoomName = await store.listGameHistoryAdmin('西瓜');
    expect(byRoomName.map(row => row.id)).toEqual(['g1']);

    const byPlayer = await store.listGameHistoryAdmin('"c"');
    expect(byPlayer.map(row => row.id)).toEqual(['g2']);

    const all = await store.listGameHistoryAdmin('');
    expect(all).toHaveLength(2);
  });

  it('stores ai settings and game history', async () => {
    const store = new D1Store(new FakeD1Database());
    expect(await store.getAiSettings()).toMatchObject({
      difficulty: 'normal',
      llmEnabled: false,
      llmApiUrl: 'http://sub.stzo.cn:11666/v1',
      llmModel: 'K2.6-Inst'
    });
    expect(await store.updateAiSettings({
      difficulty: 'hard',
      llmEnabled: true,
      llmApiUrl: 'http://sub.stzo.cn:11666/v1/',
      llmModel: 'K2.6-Inst'
    })).toMatchObject({
      difficulty: 'hard',
      llmEnabled: true,
      llmApiUrl: 'http://sub.stzo.cn:11666/v1',
      llmModel: 'K2.6-Inst'
    });

    await store.saveGameHistory({
      id: 'g1',
      roomName: '测试房',
      players: ['a', 'b'],
      scores: { a: 10 },
      turnHistory: [{ action: 'play' }]
    });
    const history = await store.getGameHistoryList();
    expect(history[0]).toMatchObject({ id: 'g1', room_name: '测试房', players: ['a', 'b'], scores: { a: 10 } });
  });
});
