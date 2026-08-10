import { describe, expect, it } from 'vitest';
import {
  hasChangedNicknameThisMonth,
  makeSocketMessage,
  normalizeRoomSettings,
  parseSocketMessage,
  validateAccountName
} from '../src/shared.js';

describe('shared utilities', () => {
  it('validates usernames and nicknames with existing rules', () => {
    expect(validateAccountName('张三_123', '用户名')).toBeNull();
    expect(validateAccountName('a', '用户名')).toContain('2-20');
    expect(validateAccountName('bad-name!', '昵称')).toContain('只能包含');
    expect(validateAccountName('admin', '用户名', 'admin')).toContain('保留账号');
  });

  it('normalizes room scoring settings', () => {
    expect(normalizeRoomSettings({ baseScore: '20', doubleEnabled: 1, openCards: true })).toEqual({
      baseScore: 20,
      doubleEnabled: true,
      allowOpenCards: true
    });
    expect(normalizeRoomSettings({ baseScore: 0 })).toMatchObject({ baseScore: 1 });
    expect(normalizeRoomSettings({ baseScore: 999999 })).toMatchObject({ baseScore: 100000 });
  });

  it('round-trips socket messages', () => {
    const raw = makeSocketMessage('joinRoom', { roomId: 'abc' }, 'ack-1');
    expect(parseSocketMessage(raw)).toEqual({
      event: 'joinRoom',
      data: { roomId: 'abc' },
      ackId: 'ack-1'
    });
    expect(parseSocketMessage('{bad json')).toBeNull();
  });

  it('detects nickname monthly change using UTC month', () => {
    const now = new Date('2026-06-14T00:00:00Z');
    expect(hasChangedNicknameThisMonth('2026-06-01T12:00:00.000Z', now)).toBe(true);
    expect(hasChangedNicknameThisMonth('2026-05-31T23:59:59.000Z', now)).toBe(false);
  });
});
