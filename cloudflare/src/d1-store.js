import {
  DEFAULT_LLM_API_URL,
  DEFAULT_LLM_MODEL,
  hasChangedNicknameThisMonth,
  normalizeAiSettings
} from './shared.js';

export class D1Store {
  constructor(db) {
    this.db = db;
  }

  async findUser(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  }

  async findUserByName(name) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? OR nickname = ?').bind(name, name).first();
  }

  async isNameTaken(name, currentUsername = '') {
    const row = await this.db
      .prepare('SELECT username FROM users WHERE (username = ? OR nickname = ?) AND username <> ?')
      .bind(name, name, currentUsername || '')
      .first();
    return Boolean(row);
  }

  async createUser(id, username, passwordHash, nickname) {
    await this.db
      .prepare('INSERT INTO users (id, username, nickname, password_hash) VALUES (?, ?, ?, ?)')
      .bind(id, username, nickname || username, passwordHash)
      .run();
    return this.findUser(username);
  }

  async updateLastLogin(username) {
    await this.db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE username = ?').bind(username).run();
  }

  async updateNickname(username, nickname, timestamp) {
    await this.db
      .prepare('UPDATE users SET nickname = ?, nickname_updated_at = ? WHERE username = ?')
      .bind(nickname, timestamp, username)
      .run();
    return this.findUser(username);
  }

  async updateAvatar(username, avatarData) {
    await this.db.prepare('UPDATE users SET avatar_data = ? WHERE username = ?').bind(avatarData || null, username).run();
    return this.findUser(username);
  }

  async getUserProfiles(usernames) {
    const names = [...new Set((usernames || []).filter(Boolean))];
    if (names.length === 0) return {};
    const placeholders = names.map(() => '?').join(',');
    const { results } = await this.db
      .prepare(`SELECT username, nickname, avatar_data FROM users WHERE username IN (${placeholders})`)
      .bind(...names)
      .all();
    return Object.fromEntries((results || []).map(row => [row.username, {
      username: row.username,
      nickname: row.nickname || row.username,
      displayName: row.nickname || row.username,
      avatarData: row.avatar_data || null
    }]));
  }

  async updateStats(username, wins, losses, score) {
    await this.db
      .prepare('UPDATE users SET wins = wins + ?, losses = losses + ?, games_played = games_played + 1, score = score + ? WHERE username = ?')
      .bind(wins, losses, score, username)
      .run();
  }

  async getLeaderboard(limit = 20) {
    const { results } = await this.db
      .prepare('SELECT username, nickname, wins, losses, games_played, score FROM users ORDER BY score DESC LIMIT ?')
      .bind(limit)
      .all();
    return results || [];
  }

  async getUserStats(username) {
    return this.db
      .prepare('SELECT username, nickname, wins, losses, games_played, score FROM users WHERE username = ?')
      .bind(username)
      .first();
  }

  async getAdminUserDetail(username) {
    return this.db
      .prepare(`SELECT id, username, nickname, nickname_updated_at, wins, losses, games_played, score, created_at, last_login
        FROM users WHERE username = ?`)
      .bind(username)
      .first();
  }

  async updateUserFields(username, updates) {
    const fields = [];
    const params = [];
    const allowedFields = ['wins', 'losses', 'games_played', 'score', 'password_hash', 'nickname', 'nickname_updated_at'];
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        fields.push(`${field} = ?`);
        params.push(updates[field]);
      }
    }
    if (fields.length === 0) return this.getAdminUserDetail(username);
    await this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE username = ?`).bind(...params, username).run();
    return this.getAdminUserDetail(username);
  }

  async adjustUserScore(username, amount) {
    const user = await this.getAdminUserDetail(username);
    if (!user) return null;
    return this.updateUserFields(username, { score: Number(user.score || 0) + amount });
  }

  async resetUserStats(username) {
    await this.db.prepare('UPDATE users SET wins = 0, losses = 0, games_played = 0, score = 0 WHERE username = ?').bind(username).run();
    return this.getAdminUserDetail(username);
  }

  async resetAllUserStats() {
    await this.db.prepare('UPDATE users SET wins = 0, losses = 0, games_played = 0, score = 0').run();
  }

  async deleteUser(username) {
    await this.db.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
  }

  async listUsers(keyword = '', limit = 200) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    if (keyword && String(keyword).trim()) {
      const term = `%${String(keyword).trim()}%`;
      const { results } = await this.db
        .prepare(`SELECT id, username, nickname, nickname_updated_at, wins, losses, games_played, score, created_at, last_login
          FROM users WHERE username LIKE ? OR nickname LIKE ? ORDER BY score DESC, username ASC LIMIT ?`)
        .bind(term, term, safeLimit)
        .all();
      return results || [];
    }

    const { results } = await this.db
      .prepare(`SELECT id, username, nickname, nickname_updated_at, wins, losses, games_played, score, created_at, last_login
        FROM users ORDER BY score DESC, username ASC LIMIT ?`)
      .bind(safeLimit)
      .all();
    return results || [];
  }

  async getAdminSummary() {
    return this.db
      .prepare(`SELECT COUNT(*) AS user_count,
        COALESCE(SUM(score), 0) AS total_score,
        COALESCE(SUM(games_played), 0) AS total_games_played,
        (SELECT COUNT(*) FROM game_history) AS history_count
        FROM users`)
      .first();
  }

  async getAiSettings() {
    const entries = await Promise.all([
      this.getRuntimeConfigValue('aiDifficulty'),
      this.getRuntimeConfigValue('aiLlmEnabled'),
      this.getRuntimeConfigValue('aiLlmApiUrl'),
      this.getRuntimeConfigValue('aiLlmModel')
    ]);
    return normalizeAiSettings({
      difficulty: entries[0],
      llmEnabled: entries[1],
      llmApiUrl: entries[2] || DEFAULT_LLM_API_URL,
      llmModel: entries[3] || DEFAULT_LLM_MODEL
    });
  }

  async updateAiSettings(settings) {
    const current = await this.getAiSettings();
    const next = normalizeAiSettings(typeof settings === 'string'
      ? { ...current, difficulty: settings }
      : { ...current, ...(settings || {}) });

    await Promise.all([
      this.setRuntimeConfigValue('aiDifficulty', next.difficulty),
      this.setRuntimeConfigValue('aiLlmEnabled', next.llmEnabled ? '1' : '0'),
      this.setRuntimeConfigValue('aiLlmApiUrl', next.llmApiUrl),
      this.setRuntimeConfigValue('aiLlmModel', next.llmModel)
    ]);
    return this.getAiSettings();
  }

  async getRuntimeConfigValue(key) {
    const row = await this.db.prepare('SELECT value FROM runtime_config WHERE key = ?').bind(key).first();
    return row?.value;
  }

  async setRuntimeConfigValue(key, value) {
    await this.db
      .prepare(`INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
      .bind(key, value)
      .run();
  }

  async saveGameHistory(payload) {
    await this.db
      .prepare(`INSERT INTO game_history (id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, turn_history, marked_card, initial_hands)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        payload.id,
        payload.roomName,
        JSON.stringify(payload.players || []),
        payload.landlord || '',
        payload.hiddenLandlord || '',
        payload.winner || '',
        payload.winnerTeam || '',
        JSON.stringify(payload.scores || {}),
        JSON.stringify(payload.turnHistory || []),
        payload.markedCard || '',
        JSON.stringify(payload.initialHands || null)
      )
      .run();
  }

  async getGameHistoryList(limit = 50) {
    const { results } = await this.db
      .prepare('SELECT id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, marked_card, created_at FROM game_history ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all();
    return (results || []).map(parseHistoryRow);
  }

  async listGameHistoryAdmin(keyword = '', limit = 200) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    if (keyword && String(keyword).trim()) {
      const term = `%${String(keyword).trim()}%`;
      const { results } = await this.db
        .prepare(`SELECT id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, marked_card, created_at
          FROM game_history
          WHERE room_name LIKE ? OR players LIKE ? OR landlord LIKE ? OR winner LIKE ?
          ORDER BY created_at DESC
          LIMIT ?`)
        .bind(term, term, term, term, safeLimit)
        .all();
      return (results || []).map(parseHistoryRow);
    }
    return this.getGameHistoryList(safeLimit);
  }

  async getGameHistoryDetail(id) {
    return parseHistoryDetail(await this.db.prepare('SELECT * FROM game_history WHERE id = ?').bind(id).first());
  }

  async updateGameHistory(id, updates) {
    const fields = [];
    const params = [];
    const simpleFields = ['room_name', 'landlord', 'hidden_landlord', 'winner', 'winner_team', 'marked_card'];
    const jsonFields = ['players', 'scores', 'turn_history', 'initial_hands'];

    for (const field of simpleFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        fields.push(`${field} = ?`);
        params.push(updates[field] || '');
      }
    }
    for (const field of jsonFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        fields.push(`${field} = ?`);
        params.push(JSON.stringify(updates[field] ?? null));
      }
    }
    if (fields.length === 0) return this.getGameHistoryDetail(id);
    await this.db.prepare(`UPDATE game_history SET ${fields.join(', ')} WHERE id = ?`).bind(...params, id).run();
    return this.getGameHistoryDetail(id);
  }

  async deleteGameHistory(id) {
    await this.db.prepare('DELETE FROM game_history WHERE id = ?').bind(id).run();
  }

  async clearGameHistory() {
    await this.db.prepare('DELETE FROM game_history').run();
  }
}

export function buildProfileResponse(user) {
  return {
    username: user.username,
    nickname: user.nickname || user.username,
    displayName: user.nickname || user.username,
    id: user.id,
    avatarData: user.avatar_data || null,
    nicknameUpdatedAt: user.nickname_updated_at || null,
    canChangeNicknameThisMonth: !hasChangedNicknameThisMonth(user.nickname_updated_at)
  };
}

function parseHistoryRow(row) {
  return {
    ...row,
    players: row.players ? JSON.parse(row.players) : [],
    scores: row.scores ? JSON.parse(row.scores) : {}
  };
}

function parseHistoryDetail(row) {
  if (!row) return null;
  const parsed = parseHistoryRow(row);
  parsed.turn_history = row.turn_history ? JSON.parse(row.turn_history) : [];
  parsed.initial_hands = row.initial_hands ? JSON.parse(row.initial_hands) : null;
  return parsed;
}
