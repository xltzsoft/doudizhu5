/**
 * AI Player - 使用LLM API进行决策，带本地fallback
 */

const DEFAULT_LLM_API_URL = 'http://sub.stzo.cn:11666/v1';
const DEFAULT_LLM_MODEL = 'K2.6-Inst';
const DEFAULT_LLM_TIMEOUT_MS = 25000;
const MAX_LLM_CANDIDATES = 12;

const { RANK_VALUES } = require('./engine');

const AI_DIFFICULTIES = new Set(['easy', 'normal', 'hard']);

function normalizeDifficulty(value) {
  return AI_DIFFICULTIES.has(value) ? value : 'normal';
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

function normalizeLlmApiUrl(value) {
  const input = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_LLM_API_URL;
  const withoutTrailingSlash = input.replace(/\/+$/g, '');
  const completionUrl = withoutTrailingSlash.endsWith('/chat/completions')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/chat/completions`;

  try {
    const url = new URL(completionUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return `${DEFAULT_LLM_API_URL}/chat/completions`;
    }
    return url.toString();
  } catch {
    return `${DEFAULT_LLM_API_URL}/chat/completions`;
  }
}

function normalizeLlmModel(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : DEFAULT_LLM_MODEL;
}

function normalizeLlmTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(60000, Math.max(1, Math.floor(numeric)));
}

class AIPlayer {
  constructor(options = {}) {
    this.difficulty = normalizeDifficulty(options.difficulty);
    this.llmEnabled = normalizeBoolean(options.llmEnabled);
    this.llmApiUrl = normalizeLlmApiUrl(options.llmApiUrl || process.env.LLM_API_URL || DEFAULT_LLM_API_URL);
    this.llmApiKey = options.llmApiKey || process.env.LLM_API_KEY || '';
    this.llmModel = normalizeLlmModel(options.llmModel || process.env.LLM_MODEL || DEFAULT_LLM_MODEL);
    this.llmTimeoutMs = normalizeLlmTimeoutMs(options.llmTimeoutMs || process.env.LLM_TIMEOUT_MS);
    this.disableLlm = normalizeBoolean(options.disableLlm || process.env.DISABLE_LLM_AI);
  }

  async decide(gameState) {
    const state = {
      ...gameState,
      aiDifficulty: normalizeDifficulty(gameState.aiDifficulty || this.difficulty)
    };

    if (!this.disableLlm && this.llmEnabled && state.aiDifficulty === 'hard' && this.llmApiKey) {
      try {
        return await this.llmDecide(state);
      } catch (e) {
        console.error('LLM decision failed, using local strategy:', e.message);
      }
    }

    return this.fallbackDecide(state);
  }

  async llmDecide(gameState) {
    if (!this.llmApiKey) throw new Error('LLM API key is not configured');

    const handCards = normalizeHandCards(gameState.myHand);
    const candidates = this.buildHintCandidates(gameState, handCards).slice(0, MAX_LLM_CANDIDATES);
    if (candidates.length === 0) {
      if (!gameState.mustPlay) return { action: 'pass' };
      throw new Error('No legal candidates for LLM decision');
    }

    const prompt = this.buildPrompt(gameState, candidates);

    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), this.llmTimeoutMs);

    try {
      const response = await fetch(this.llmApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.llmApiKey}`
        },
        body: JSON.stringify({
          model: this.llmModel,
          messages: [
            {
              role: 'system',
              content: '你是五人斗地主 AI，只能从用户给出的 candidates 中选择。高级模式优先队友配合：不无意义压队友，敌方低手牌时积极拦截，自己能出完则直接出完。只返回 JSON：{"action":"play","hintIndex":0} 或 {"action":"pass"}。'
            },
            { role: 'user', content: prompt }
          ],
          temperature: 0.3,
          max_tokens: 80
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();

      if (!content) throw new Error('Empty LLM response');

      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');

      const decision = JSON.parse(jsonMatch[0]);

      if (decision.action === 'pass') {
        if (gameState.mustPlay) {
          return this.fallbackDecide(gameState);
        }
        return { action: 'pass' };
      }

      if (decision.action === 'play' && Number.isInteger(decision.hintIndex)) {
        const candidate = candidates.find(item => item.index === decision.hintIndex) || candidates[decision.hintIndex];
        if (candidate) {
          console.info(`LLM decision succeeded in ${Date.now() - startedAt}ms with ${candidates.length} candidates`);
          return { action: 'play', cards: getPlayableCardsForCandidate(candidate, gameState.myHand) };
        }
      }

      if (decision.action === 'play' && Array.isArray(decision.cards) && decision.cards.length > 0) {
        const resolvedCards = resolvePlayableCards(decision.cards, gameState.myHand);
        if (resolvedCards) {
          console.info(`LLM decision succeeded in ${Date.now() - startedAt}ms with ${candidates.length} candidates`);
          return { action: 'play', cards: resolvedCards };
        }
      }

      throw new Error('Invalid LLM decision');
    } catch (e) {
      clearTimeout(timeout);
      if (e?.name === 'AbortError') {
        throw new Error(`LLM request timed out after ${this.llmTimeoutMs}ms`);
      }
      throw e;
    }
  }

  buildPrompt(state, candidates = this.buildHintCandidates(state, normalizeHandCards(state.myHand)).slice(0, MAX_LLM_CANDIDATES)) {
    const payload = {
      task: state.mustPlay ? 'must_play' : 'beat_or_pass',
      self: {
        name: state.myName,
        team: state.myTeam,
        cardCount: Array.isArray(state.myHand) ? state.myHand.length : 0
      },
      lastPlay: state.lastPlay ? {
        player: state.lastPlay.player,
        type: state.lastPlay.type,
        cards: state.lastPlay.cards
      } : null,
      markedCard: state.markedCard || null,
      players: (state.players || []).map(player => ({
        name: player.name,
        cardCount: Number(player.cardCount || 0),
        team: player.team || 'unknown',
        landlord: Boolean(player.isLandlord),
        hiddenLandlord: Boolean(player.isHiddenLandlord)
      })),
      candidates: candidates.map(candidate => ({
        hintIndex: candidate.index,
        cards: candidate.ids,
        count: candidate.length,
        high: candidate.maxValue,
        bomb: candidate.isBomb
      }))
    };

    return [
      '选择最佳出牌。只能返回 {"action":"play","hintIndex":候选编号} 或 {"action":"pass"}。',
      '如果 task 是 must_play，不允许 pass。candidates 已由服务端验证合法。',
      JSON.stringify(payload)
    ].join('\n');
  }

  fallbackDecide(gameState) {
    const handCards = normalizeHandCards(gameState.myHand);
    const hand = handCards.map(c => c.id);
    if (hand.length === 0) return { action: 'pass' };

    const hintCandidates = this.buildHintCandidates(gameState, handCards);
    if (hintCandidates.length > 0) {
      const context = buildDecisionContext(gameState, hand.length);
      const selected = this.chooseCandidate(hintCandidates, context);
      if (selected) {
        return { action: 'play', cards: selected.ids };
      }
      if (!gameState.mustPlay) return { action: 'pass' };
    }

    return this.legacyFallback(gameState, hand);
  }

  buildHintCandidates(gameState, handCards) {
    if (!Array.isArray(gameState.hints) || gameState.hints.length === 0) return [];

    const byUid = new Map(handCards.map(card => [card.uid, card]));
    const byId = new Map();
    for (const card of handCards) {
      if (!byId.has(card.id)) byId.set(card.id, []);
      byId.get(card.id).push(card);
    }

    return gameState.hints.map((hint, index) => {
      const used = new Set();
      const cards = [];
      for (const token of hint) {
        let card = byUid.get(token);
        if (!card) {
          const sameIdCards = byId.get(token) || [];
          card = sameIdCards.find(item => !used.has(item.uid));
        }
        if (!card || used.has(card.uid)) return null;
        used.add(card.uid);
        cards.push(card);
      }
      if (cards.length === 0) return null;
      return {
        ids: cards.map(card => card.id),
        uids: cards.map(card => card.uid),
        index,
        length: cards.length,
        maxValue: Math.max(...cards.map(card => getCardValue(card.id))),
        minValue: Math.min(...cards.map(card => getCardValue(card.id))),
        isBomb: isBombLike(cards.map(card => card.id)),
        score: 0
      };
    }).filter(Boolean);
  }

  chooseCandidate(candidates, context) {
    const scored = candidates
      .map(candidate => ({
        ...candidate,
        score: this.scoreCandidate(candidate, context)
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index);

    const winning = scored.find(candidate => candidate.length === context.handCount);
    if (winning) return winning;

    if (context.difficulty === 'hard' && context.lastPlayByKnownTeammate && !context.mustPlay) {
      return null;
    }

    if (context.difficulty === 'easy') {
      if (!context.mustPlay && context.hasLastPlay && !context.enemyCritical) {
        return null;
      }
      return scored[scored.length - 1] || null;
    }

    return scored[0] || null;
  }

  scoreCandidate(candidate, context) {
    const remaining = context.handCount - candidate.length;
    let score = 0;

    if (remaining === 0) return 100000;

    if (context.mustPlay || !context.hasLastPlay) {
      score += candidate.length * 45;
      score -= candidate.maxValue * 2;
      if (candidate.length >= 5) score += 120;
      if (candidate.isBomb && context.handCount > 6) score -= 450;
    } else {
      score += 900;
      score -= candidate.maxValue * 4;
      score -= candidate.length * 2;
      if (candidate.isBomb) score -= context.enemyCritical ? 80 : 520;
    }

    if (context.enemyCritical) {
      score += 240;
      if (candidate.isBomb) score += 180;
      if (candidate.maxValue >= 15) score += 70;
    }

    if (context.difficulty === 'hard') {
      if (context.lastPlayByKnownTeammate && !context.mustPlay) {
        score -= 2000;
      }
      if (context.partnerCritical && (context.mustPlay || !context.hasLastPlay)) {
        score += candidate.length >= 3 ? 90 : 20;
        if (candidate.isBomb) score -= 260;
      }
      if (!context.enemyCritical && candidate.isBomb && remaining > 2) {
        score -= 220;
      }
    }

    if (context.difficulty === 'easy') {
      score = -score;
    }

    return score;
  }

  legacyFallback(gameState, hand) {
    if (gameState.mustPlay) {
      // Try to play best opening: straight > triple > pair > single
      const straights = findStraights(hand);
      if (straights.length > 0) return { action: 'play', cards: straights[0] };
      const consec = findConsecutivePairs(hand);
      if (consec.length > 0) return { action: 'play', cards: consec[0] };
      const triples = findTriples(hand);
      if (triples.length > 0) return { action: 'play', cards: triples[0] };
      const pairs = findPairs(hand);
      if (pairs.length > 0) return { action: 'play', cards: pairs[0] };
      return { action: 'play', cards: [hand[0]] };
    }

    // Try to beat last play
    if (gameState.lastPlay) {
      const lastType = gameState.lastPlay.type;
      const lastCards = gameState.lastPlay.cards;

      if (lastType === 'single') {
        const lastValue = getCardValue(lastCards[0]);
        for (const card of hand) {
          if (getCardValue(card) > lastValue) {
            return { action: 'play', cards: [card] };
          }
        }
      }

      if (lastType === 'pair') {
        const lastValue = getCardValue(lastCards[0]);
        const pairs = findPairs(hand);
        for (const pair of pairs) {
          if (getCardValue(pair[0]) > lastValue) {
            return { action: 'play', cards: pair };
          }
        }
      }

      if (lastType === 'triple' || lastType === 'tripleWithPair') {
        const lastValue = getCardValue(lastCards[0]);
        const triples = findTriples(hand);
        for (const triple of triples) {
          if (getCardValue(triple[0]) > lastValue) {
            if (lastType === 'tripleWithPair') {
              const remaining = hand.filter(c => !triple.includes(c));
              const pairs = findPairs(remaining);
              if (pairs.length > 0) {
                return { action: 'play', cards: [...triple, ...pairs[0]] };
              }
            } else {
              return { action: 'play', cards: triple };
            }
          }
        }
      }

      if (lastType === 'straight') {
        const lastLen = lastCards.length;
        const lastHigh = Math.max(...lastCards.map(c => getCardValue(c)));
        const straights = findStraights(hand, lastLen);
        for (const s of straights) {
          const high = Math.max(...s.map(c => getCardValue(c)));
          if (high > lastHigh) {
            return { action: 'play', cards: s };
          }
        }
      }

      if (lastType === 'consecutivePairs') {
        const lastLen = lastCards.length;
        const lastHigh = Math.max(...lastCards.map(c => getCardValue(c)));
        const consecs = findConsecutivePairs(hand, lastLen / 2);
        for (const cp of consecs) {
          const high = Math.max(...cp.map(c => getCardValue(c)));
          if (high > lastHigh) {
            return { action: 'play', cards: cp };
          }
        }
      }

      if (lastType === 'fourWithSingles') {
        const lastQuadVal = getCardValue(lastCards[0]);
        const quads = findQuads(hand);
        for (const quad of quads) {
          const quadVal = getCardValue(quad[0]);
          if (quadVal > lastQuadVal) {
            const remaining = hand.filter(c => !quad.includes(c));
            if (remaining.length >= 2) {
              return { action: 'play', cards: [...quad, remaining[0], remaining[1]] };
            }
          }
        }
      }

      // Try any bomb that beats
      const bombs = findBombs(hand);
      const bombTypes = ['bomb', 'sanwang'];
      const lastIsBomb = bombTypes.includes(lastType);
      if (lastIsBomb || hand.length <= 10) {
        for (const b of bombs) {
          const bombCards = b.length;
          const lastCardsLen = lastCards.length;
          if (bombCards > lastCardsLen) {
            return { action: 'play', cards: b };
          }
          if (bombCards === lastCardsLen && lastIsBomb) {
            const bombVal = getCardValue(b[0]);
            const lastBombVal = getCardValue(lastCards[0]);
            if (bombVal > lastBombVal) {
              return { action: 'play', cards: b };
            }
          }
        }
      }
    }

    return { action: 'pass' };
  }
}

function normalizeHandCards(hand = []) {
  return hand.map((card, index) => {
    if (typeof card === 'string') {
      return { uid: `${card}#${index}`, id: card };
    }
    return {
      uid: card.uid || `${card.id}#${index}`,
      id: card.id
    };
  }).filter(card => card.id);
}

function shouldReturnUids(hand = []) {
  return hand.some(card => card && typeof card === 'object' && card.uid);
}

function getPlayableCardsForCandidate(candidate, hand = []) {
  return shouldReturnUids(hand) ? candidate.uids : candidate.ids;
}

function resolvePlayableCards(cardTokens, hand = []) {
  const handCards = normalizeHandCards(hand);
  const byUid = new Map(handCards.map(card => [card.uid, card]));
  const byId = new Map();
  for (const card of handCards) {
    if (!byId.has(card.id)) byId.set(card.id, []);
    byId.get(card.id).push(card);
  }

  const used = new Set();
  const resolved = [];
  for (const token of cardTokens) {
    let card = byUid.get(token);
    if (!card) {
      const sameIdCards = byId.get(token) || [];
      card = sameIdCards.find(item => !used.has(item.uid));
    }
    if (!card || used.has(card.uid)) return null;
    used.add(card.uid);
    resolved.push(card);
  }

  return shouldReturnUids(hand) ? resolved.map(card => card.uid) : resolved.map(card => card.id);
}

function buildDecisionContext(state, handCount) {
  const difficulty = normalizeDifficulty(state.aiDifficulty);
  const myName = state.myName;
  const myTeam = state.myTeam;
  const players = Array.isArray(state.players) ? state.players : [];
  const lastPlayer = state.lastPlay?.player || state.lastPlayPlayer || null;
  const lastPlayerInfo = players.find(player => player.name === lastPlayer);
  const lastPlayTeam = getVisibleTeam(lastPlayerInfo, lastPlayer, state);
  const lastPlayByKnownTeammate = Boolean(lastPlayer && lastPlayer !== myName && lastPlayTeam && lastPlayTeam === myTeam);

  let partnerCritical = false;
  let enemyCritical = false;
  for (const player of players) {
    if (!player || player.name === myName) continue;
    const team = getVisibleTeam(player, player.name, state);
    const isLow = Number(player.cardCount || 0) <= 3;
    if (!isLow) continue;
    if (team && team === myTeam) partnerCritical = true;
    if (team && team !== myTeam) enemyCritical = true;
  }

  return {
    difficulty,
    handCount,
    myName,
    myTeam,
    mustPlay: !!state.mustPlay,
    hasLastPlay: !!state.lastPlay,
    lastPlayByKnownTeammate,
    partnerCritical,
    enemyCritical
  };
}

function getVisibleTeam(player, playerName, state) {
  if (!playerName) return null;
  if (playerName === state.myName) return state.myTeam;
  if (player?.team && player.team !== 'unknown') return player.team;
  if (player?.isLandlord) return 'landlord';
  if (player?.isHiddenLandlord === true) return 'landlord';
  return null;
}

function isBombLike(cards) {
  if (cards.length < 2) return false;
  const ranks = cards.map(card => card.replace(/[♠♥♣♦]/g, ''));
  const jokerCount = ranks.filter(rank => rank === 'X' || rank === 'D').length;
  if (jokerCount === cards.length) {
    return cards.length === 3 && ranks.every(rank => rank === ranks[0]);
  }
  return cards.length >= 4 && ranks.every(rank => rank === ranks[0]);
}

function getCardValue(cardId) {
  const rank = cardId.replace(/[♠♥♣♦]/g, '');
  return RANK_VALUES[rank] || 0;
}

function findPairs(hand) {
  const groups = groupByRank(hand);
  const pairs = [];
  for (const [rank, cards] of Object.entries(groups)) {
    if (cards.length >= 2) {
      pairs.push([cards[0], cards[1]]);
    }
  }
  return pairs.sort((a, b) => getCardValue(a[0]) - getCardValue(b[0]));
}

function findTriples(hand) {
  const groups = groupByRank(hand);
  const triples = [];
  for (const [rank, cards] of Object.entries(groups)) {
    if (cards.length >= 3) {
      triples.push([cards[0], cards[1], cards[2]]);
    }
  }
  return triples.sort((a, b) => getCardValue(a[0]) - getCardValue(b[0]));
}

function findQuads(hand) {
  const groups = groupByRank(hand);
  const quads = [];
  for (const [rank, cards] of Object.entries(groups)) {
    if (cards.length >= 4) {
      quads.push([cards[0], cards[1], cards[2], cards[3]]);
    }
  }
  return quads.sort((a, b) => getCardValue(a[0]) - getCardValue(b[0]));
}

function findBombs(hand) {
  const groups = groupByRank(hand);
  const bombs = [];

  // Regular bombs (4+ same rank)
  for (const [rank, cards] of Object.entries(groups)) {
    for (let size = 4; size <= cards.length; size++) {
      bombs.push(cards.slice(0, size));
    }
  }

  // Joker bombs
  const smallJokers = hand.filter(c => c === 'X');
  const bigJokers = hand.filter(c => c === 'D');
  if (smallJokers.length >= 3) bombs.push(smallJokers.slice(0, 3));
  if (bigJokers.length >= 3) bombs.push(bigJokers.slice(0, 3));

  return bombs.sort((a, b) => a.length - b.length);
}

function groupByRank(hand) {
  const groups = {};
  for (const cardId of hand) {
    const rank = cardId.replace(/[♠♥♣♦]/g, '');
    if (!groups[rank]) groups[rank] = [];
    groups[rank].push(cardId);
  }
  return groups;
}

function findStraights(hand, exactLen) {
  const groups = groupByRank(hand);
  const rankOrder = ['3','4','5','6','7','8','9','10','J','Q','K','A'];
  const results = [];
  const minLen = exactLen || 5;
  const maxLen = exactLen || rankOrder.length;

  for (let start = 0; start < rankOrder.length; start++) {
    const run = [];
    for (let i = start; i < rankOrder.length; i++) {
      const r = rankOrder[i];
      if (groups[r] && groups[r].length >= 1) {
        run.push(groups[r][0]);
      } else {
        break;
      }
      if (run.length >= minLen && (!exactLen || run.length === exactLen)) {
        results.push([...run]);
      }
    }
  }
  return results.sort((a, b) => a.length - b.length || getCardValue(a[0]) - getCardValue(b[0]));
}

function findConsecutivePairs(hand, exactPairCount) {
  const groups = groupByRank(hand);
  const rankOrder = ['3','4','5','6','7','8','9','10','J','Q','K','A'];
  const results = [];
  const minPairs = exactPairCount || 3;
  const maxPairs = exactPairCount || rankOrder.length;

  for (let start = 0; start < rankOrder.length; start++) {
    const run = [];
    for (let i = start; i < rankOrder.length; i++) {
      const r = rankOrder[i];
      if (groups[r] && groups[r].length >= 2) {
        run.push(groups[r][0], groups[r][1]);
      } else {
        break;
      }
      const pairCount = run.length / 2;
      if (pairCount >= minPairs && (!exactPairCount || pairCount === exactPairCount)) {
        results.push([...run]);
      }
    }
  }
  return results.sort((a, b) => a.length - b.length || getCardValue(a[0]) - getCardValue(b[0]));
}

module.exports = { AIPlayer };
