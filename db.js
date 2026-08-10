/**
 * SQLite 数据库 - 用户数据持久化 (sql.js - pure JS)
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'doudizhu5.db');
let db = null;

function ensureColumn(table, definition) {
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (e) {
    if (!String(e.message || e).includes('duplicate column name')) {
      throw e;
    }
  }
}

async function init() {
  const SQL = await initSqlJs();
  
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      wins INTEGER DEFAULT 0,
      losses INTEGER DEFAULT 0,
      games_played INTEGER DEFAULT 0,
      score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT DEFAULT (datetime('now'))
    );
  `);
  ensureColumn('users', 'avatar_data TEXT');
  ensureColumn('users', 'nickname TEXT');
  ensureColumn('users', 'nickname_updated_at TEXT');
  db.run("UPDATE users SET nickname = username WHERE nickname IS NULL OR TRIM(nickname) = ''");
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)');

  db.run(`
    CREATE TABLE IF NOT EXISTS game_history (
      id TEXT PRIMARY KEY,
      room_name TEXT,
      players TEXT,
      landlord TEXT,
      hidden_landlord TEXT,
      winner TEXT,
      winner_team TEXT,
      scores TEXT,
      turn_history TEXT,
      marked_card TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  ensureColumn('game_history', 'initial_hands TEXT');
  save();
}

function save() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getSingleRow(query, params = []) {
  const stmt = db.prepare(query);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    row = stmt.getAsObject();
  }
  stmt.free();
  return row;
}

function parseHistoryRow(row, includeTurnHistory = false) {
  if (!row) return null;
  const parsed = { ...row };
  parsed.players = parsed.players ? JSON.parse(parsed.players) : [];
  parsed.scores = parsed.scores ? JSON.parse(parsed.scores) : {};
  if (includeTurnHistory) {
    parsed.turn_history = parsed.turn_history ? JSON.parse(parsed.turn_history) : [];
    parsed.initial_hands = parsed.initial_hands ? JSON.parse(parsed.initial_hands) : null;
  }
  return parsed;
}

module.exports = {
  init,

  findUser(username) {
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    stmt.bind([username]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  findUserByNickname(nickname) {
    return getSingleRow('SELECT * FROM users WHERE nickname = ?', [nickname]);
  },

  findUserByName(name) {
    return getSingleRow('SELECT * FROM users WHERE username = ? OR nickname = ?', [name, name]);
  },

  isNameTaken(name, currentUsername = null) {
    const row = getSingleRow(
      'SELECT username FROM users WHERE (username = ? OR nickname = ?) AND username <> ?',
      [name, name, currentUsername || '']
    );
    return Boolean(row);
  },

  createUser(id, username, passwordHash, nickname) {
    db.run('INSERT INTO users (id, username, nickname, password_hash) VALUES (?, ?, ?, ?)', [id, username, nickname || username, passwordHash]);
    save();
  },

  updateLastLogin(username) {
    db.run("UPDATE users SET last_login = datetime('now') WHERE username = ?", [username]);
    save();
  },

  updateAvatar(username, avatarData) {
    db.run('UPDATE users SET avatar_data = ? WHERE username = ?', [avatarData || null, username]);
    save();
    return this.findUser(username);
  },

  updateNickname(username, nickname, timestamp) {
    db.run('UPDATE users SET nickname = ?, nickname_updated_at = ? WHERE username = ?', [nickname, timestamp, username]);
    save();
    return this.findUser(username);
  },

  getUserProfiles(usernames) {
    const names = Array.isArray(usernames) ? [...new Set(usernames.filter(Boolean))] : [];
    const profiles = {};
    if (names.length === 0) return profiles;

    const placeholders = names.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT username, nickname, avatar_data FROM users WHERE username IN (${placeholders})`);
    stmt.bind(names);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      profiles[row.username] = {
        username: row.username,
        nickname: row.nickname || row.username,
        displayName: row.nickname || row.username,
        avatarData: row.avatar_data || null
      };
    }
    stmt.free();
    return profiles;
  },

  getUserAvatars(usernames) {
    const profiles = this.getUserProfiles(usernames);
    return Object.fromEntries(Object.entries(profiles).map(([username, profile]) => [username, profile.avatarData || null]));
  },

  updateStats(username, wins, losses, score) {
    db.run(`UPDATE users SET wins = wins + ?, losses = losses + ?, games_played = games_played + 1, score = score + ? WHERE username = ?`,
      [wins, losses, score, username]);
    save();
  },

  getLeaderboard() {
    const results = [];
    const stmt = db.prepare('SELECT username, nickname, wins, losses, games_played, score FROM users ORDER BY score DESC LIMIT 20');
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  },

  getUserStats(username) {
    const stmt = db.prepare('SELECT username, nickname, wins, losses, games_played, score FROM users WHERE username = ?');
    stmt.bind([username]);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  },

  getAdminSummary() {
    return getSingleRow(`SELECT
      (SELECT COUNT(*) FROM users) AS user_count,
      (SELECT COALESCE(SUM(score), 0) FROM users) AS total_score,
      (SELECT COALESCE(SUM(games_played), 0) FROM users) AS total_games_played,
      (SELECT COUNT(*) FROM game_history) AS history_count`);
  },

  listUsers(keyword = '', limit = 200) {
    const results = [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    const hasKeyword = typeof keyword === 'string' && keyword.trim();
    const stmt = hasKeyword
      ? db.prepare(`SELECT id, username, nickname, nickname_updated_at, wins, losses, games_played, score, created_at, last_login
          FROM users
          WHERE username LIKE ? OR nickname LIKE ?
          ORDER BY score DESC, username ASC
          LIMIT ?`)
      : db.prepare(`SELECT id, username, nickname, nickname_updated_at, wins, losses, games_played, score, created_at, last_login
          FROM users
          ORDER BY score DESC, username ASC
          LIMIT ?`);

    if (hasKeyword) {
      const term = `%${keyword.trim()}%`;
      stmt.bind([term, term, safeLimit]);
    } else {
      stmt.bind([safeLimit]);
    }

    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  },

  getAdminUserDetail(username) {
    return getSingleRow(`SELECT id, username, nickname, nickname_updated_at, wins, losses, games_played, score, created_at, last_login
      FROM users WHERE username = ?`, [username]);
  },

  updateUserFields(username, updates) {
    const fields = [];
    const params = [];
    const allowedFields = ['wins', 'losses', 'games_played', 'score', 'password_hash', 'nickname', 'nickname_updated_at'];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        fields.push(`${field} = ?`);
        params.push(updates[field]);
      }
    }

    if (fields.length === 0) {
      return this.getAdminUserDetail(username);
    }

    db.run(`UPDATE users SET ${fields.join(', ')} WHERE username = ?`, [...params, username]);
    save();
    return this.getAdminUserDetail(username);
  },

  adjustUserScore(username, amount) {
    db.run('UPDATE users SET score = score + ? WHERE username = ?', [amount, username]);
    save();
    return this.getAdminUserDetail(username);
  },

  resetUserStats(username) {
    db.run('UPDATE users SET wins = 0, losses = 0, games_played = 0, score = 0 WHERE username = ?', [username]);
    save();
    return this.getAdminUserDetail(username);
  },

  resetAllUserStats() {
    db.run('UPDATE users SET wins = 0, losses = 0, games_played = 0, score = 0');
    save();
  },

  deleteUser(username) {
    db.run('DELETE FROM users WHERE username = ?', [username]);
    save();
  },

  saveGameHistory(id, roomName, players, landlord, hiddenLandlord, winner, winnerTeam, scores, turnHistory, markedCard, initialHands) {
    db.run(`INSERT INTO game_history (id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, turn_history, marked_card, initial_hands)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, roomName, JSON.stringify(players), landlord, hiddenLandlord || '', winner, winnerTeam,
       JSON.stringify(scores), JSON.stringify(turnHistory), markedCard || '', JSON.stringify(initialHands || null)]);
    save();
  },

  getGameHistoryList(limit = 50) {
    const results = [];
    const stmt = db.prepare('SELECT id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, marked_card, created_at FROM game_history ORDER BY created_at DESC LIMIT ?');
    stmt.bind([limit]);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      row.players = JSON.parse(row.players);
      row.scores = JSON.parse(row.scores);
      results.push(row);
    }
    stmt.free();
    return results;
  },

  listGameHistoryAdmin(keyword = '', limit = 200) {
    const results = [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 500));
    const hasKeyword = typeof keyword === 'string' && keyword.trim();
    const stmt = hasKeyword
      ? db.prepare(`SELECT id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, marked_card, created_at
          FROM game_history
          WHERE room_name LIKE ? OR players LIKE ? OR landlord LIKE ? OR winner LIKE ?
          ORDER BY created_at DESC
          LIMIT ?`)
      : db.prepare(`SELECT id, room_name, players, landlord, hidden_landlord, winner, winner_team, scores, marked_card, created_at
          FROM game_history
          ORDER BY created_at DESC
          LIMIT ?`);

    if (hasKeyword) {
      const likeValue = `%${keyword.trim()}%`;
      stmt.bind([likeValue, likeValue, likeValue, likeValue, safeLimit]);
    } else {
      stmt.bind([safeLimit]);
    }

    while (stmt.step()) {
      results.push(parseHistoryRow(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  },

  getGameHistoryDetail(id) {
    return parseHistoryRow(getSingleRow('SELECT * FROM game_history WHERE id = ?', [id]), true);
  },

  updateGameHistory(id, updates) {
    const fields = [];
    const params = [];
    const simpleFields = ['room_name', 'landlord', 'hidden_landlord', 'winner', 'winner_team', 'marked_card'];
    const jsonFields = ['players', 'scores', 'turn_history', 'initial_hands'];

    for (const field of simpleFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        fields.push(`${field} = ?`);
        params.push(updates[field]);
      }
    }

    for (const field of jsonFields) {
      if (Object.prototype.hasOwnProperty.call(updates, field)) {
        fields.push(`${field} = ?`);
        params.push(JSON.stringify(updates[field] ?? null));
      }
    }

    if (fields.length === 0) {
      return this.getGameHistoryDetail(id);
    }

    db.run(`UPDATE game_history SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
    save();
    return this.getGameHistoryDetail(id);
  },

  deleteGameHistory(id) {
    db.run('DELETE FROM game_history WHERE id = ?', [id]);
    save();
  },

  clearGameHistory() {
    db.run('DELETE FROM game_history');
    save();
  },

  close() {
    if (db) { save(); db.close(); }
  }
};
