import React, { useState, useEffect, useCallback } from 'react';
import { computeScores } from './scoring';

const VENUES = [
  '桐生','戸田','江戸川','平和島','多摩川','浜名湖','蒲郡','常滑',
  '津','三国','びわこ','住之江','尼崎','鳴門','丸亀','児島',
  '宮島','徳山','下関','若松','芦屋','福岡','唐津','大村'
];

const LANE_COLORS = {
  1: { bg: '#f8f8f6', text: '#111111', accent: '#111111' },
  2: { bg: '#1a1a1a', text: '#ffffff', accent: '#1a1a1a' },
  3: { bg: '#c62828', text: '#ffffff', accent: '#c62828' },
  4: { bg: '#1857b0', text: '#ffffff', accent: '#1857b0' },
  5: { bg: '#e8b800', text: '#111111', accent: '#e8b800' },
  6: { bg: '#1f8a4c', text: '#ffffff', accent: '#1f8a4c' },
};

const COURSE_BASE = { 1: 0.55, 2: 0.14, 3: 0.12, 4: 0.10, 5: 0.06, 6: 0.03 };

// ---------- Parsers ----------

function parseKonsetsuFromBlock(tokens) {
  // 今節成績は「レース番号・進入コース・ST」の3点セットの繰り返し。
  // 着順はサイト側でリンク要素になっておりテキストコピーでは取得できないため対象外。
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const raceMatch = tokens[i].match(/^(\d+)Ｒ$/);
    if (raceMatch) {
      const courseTok = tokens[i + 1];
      const stTok = tokens[i + 2];
      const course = courseTok && /^[1-6]$/.test(courseTok) ? parseInt(courseTok) : null;
      const st = stTok && /^\.\d+$/.test(stTok) ? parseFloat('0' + stTok) : null;
      if (course != null && st != null) {
        entries.push({ raceNo: parseInt(raceMatch[1]), course, st });
        i += 2;
      }
    }
  }
  return entries;
}

function parseRacelist(text) {
  if (!text || !text.trim()) return null;
  const tokens = text.split(/[\t\n]/).map(t => t.trim());
  const anchorRe = /^\d{4}\/[AB][12]$/;
  const anchors = [];
  tokens.forEach((t, i) => { if (anchorRe.test(t)) anchors.push(i); });
  const boats = [];
  for (let b = 0; b < anchors.length && b < 6; b++) {
    const start = anchors[b];
    const end = b + 1 < anchors.length ? anchors[b + 1] : tokens.length;
    const block = tokens.slice(start, end).filter(t => t !== '');
    const [regnum, classG] = (block[0] || '').split('/');
    const branchOrigin = block[1] || '';
    const ageWeight = block[2] || '';
    const ageMatch = ageWeight.match(/(\d+)歳/);
    const weightMatch = ageWeight.match(/([\d.]+)kg/);
    const fnum = block[3] || '';
    const lnum = block[4] || '';
    const avgST = block[5] || '';
    const num = (s) => { const v = parseFloat(s); return isNaN(v) ? 0 : v; };
    const konsetsu = parseKonsetsuFromBlock(block.slice(18));
    const konsetsuAvgST = konsetsu.length ? konsetsu.reduce((a, c) => a + c.st, 0) / konsetsu.length : null;
    boats.push({
      lane: b + 1,
      regnum: regnum || '', classG: classG || '',
      branchOrigin,
      age: ageMatch ? parseInt(ageMatch[1]) : null,
      regWeight: weightMatch ? parseFloat(weightMatch[1]) : null,
      fCount: parseInt((fnum.match(/F(\d+)/) || [])[1] || 0),
      lCount: parseInt((lnum.match(/L(\d+)/) || [])[1] || 0),
      avgST: parseFloat(avgST) || null,
      natWin: num(block[6]), nat2: num(block[7]), nat3: num(block[8]),
      locWin: num(block[9]), loc2: num(block[10]), loc3: num(block[11]),
      motorNo: block[12] || '', motor2: num(block[13]), motor3: num(block[14]),
      boatNo: block[15] || '', boat2: num(block[16]), boat3: num(block[17]),
      konsetsu, konsetsuAvgST,
    });
  }
  return boats.length ? boats : null;
}

function parseBeforeInfo(text) {
  if (!text || !text.trim()) return null;
  const tokens = text.split(/[\t\n]/).map(t => t.trim());
  const weightRe = /^\d{2}(\.\d)?kg$/;
  const anchors = [];
  tokens.forEach((t, i) => { if (weightRe.test(t)) anchors.push(i); });
  const boats = [];
  for (let b = 0; b < anchors.length && b < 6; b++) {
    const start = anchors[b];
    const end = b + 1 < anchors.length ? anchors[b + 1] : tokens.length;
    const block = tokens.slice(start, end).filter(t => t !== '');
    const exWeight = parseFloat(block[0]);
    const rest = block.slice(1);
    const exTimeTok = rest.find(t => /^[5-7]\.\d{1,2}$/.test(t));
    const exTime = exTimeTok ? parseFloat(exTimeTok) : null;
    const tiltTok = rest.find(t => t !== exTimeTok && /^-?\d(\.\d)?$/.test(t) && Math.abs(parseFloat(t)) <= 1.0);
    const tilt = tiltTok ? parseFloat(tiltTok) : null;
    const partsKeywordRe = /プロペラ|ペラ|ギアケース|リング|シャフト|艤装|クラッチ|スターン|キャブレター/;
    const partsExchanged = rest.some(t => t !== exTimeTok && t !== tiltTok && partsKeywordRe.test(t));
    boats.push({
      lane: b + 1,
      exWeight: isNaN(exWeight) ? null : exWeight,
      exTime,
      tilt,
      partsExchanged,
    });
  }
  return boats.length ? boats : null;
}

function parseStartDisp(text) {
  if (!text || !text.trim()) return null;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const courses = [];
  const re = /^(\d)(F)?\.(\d+)$/;
  // 行頭の数字は艇番(lane)。進入コースは「何行目に書かれているか」で決まる(並び順=進入順)。
  // 艇番とコース番号を同一視すると、進入差し替え(隊形変更)が一切反映されなくなるため分離する。
  let courseIdx = 0;
  lines.forEach(line => {
    const m = line.match(re);
    if (m) {
      courseIdx += 1;
      courses.push({ lane: parseInt(m[1]), course: courseIdx, isF: !!m[2], exST: parseFloat('0.' + m[3]) });
    }
  });
  const weatherMatch = text.match(/気温\s*([\d.]+)℃.*?風速\s*([\d.]+)m.*?水温\s*([\d.]+)℃.*?波高\s*([\d.]+)cm/s);
  const weather = weatherMatch
    ? { temp: weatherMatch[1], wind: weatherMatch[2], waterTemp: weatherMatch[3], wave: weatherMatch[4] }
    : null;
  return { courses, weather, valid: courses.length > 0 };
}

function mergeBoats(racelist, beforeInfo, startDisp) {
  const lanes = [1, 2, 3, 4, 5, 6];
  return lanes.map(lane => {
    const r = racelist ? racelist.find(x => x.lane === lane) : null;
    const b = beforeInfo ? beforeInfo.find(x => x.lane === lane) : null;
    const s = startDisp ? startDisp.courses.find(x => x.lane === lane) : null;
    return {
      lane,
      ...(r || {}),
      exTime: b ? b.exTime : null,
      tilt: b ? b.tilt : null,
      exWeight: b ? b.exWeight : null,
      partsExchanged: b ? b.partsExchanged : false,
      entryCourse: s ? s.course : lane,
      exST: s ? s.exST : null,
      exhibitF: s ? s.isF : false,
      hasData: !!(r || b),
    };
  });
}

// ---------- Bet recommendation (Plackett-Luce) ----------

function permutations3(indices) {
  const out = [];
  for (const i of indices) for (const j of indices) for (const k of indices) {
    if (i !== j && j !== k && i !== k) out.push([i, j, k]);
  }
  return out;
}

function generateBets(boats, betType, budgetYen) {
  const isChaosRace = boats.some(b => b.isChaosRace);
  const poolSize = isChaosRace ? 6 : 5;
  const candidates = boats.slice(0, Math.min(poolSize, boats.length));
  const weights = candidates.map(b => Math.exp(b.total / 12));
  const sumAll = weights.reduce((a, c) => a + c, 0);
  const idx = candidates.map((_, i) => i);
  const perms = permutations3(idx);

  const scored = perms.map(([i, j, k]) => {
    const p1 = weights[i] / sumAll;
    const p2 = weights[j] / (sumAll - weights[i]);
    const p3 = weights[k] / (sumAll - weights[i] - weights[j]);
    const prob = p1 * p2 * p3;
    return { lanes: [candidates[i].lane, candidates[j].lane, candidates[k].lane], prob };
  });

  let combos;
  if (betType === '3連複') {
    const map = new Map();
    scored.forEach(s => {
      const key = [...s.lanes].sort((a, b) => a - b).join('-');
      map.set(key, (map.get(key) || 0) + s.prob);
    });
    combos = Array.from(map.entries()).map(([key, prob]) => ({ combo: key, prob }));
  } else {
    combos = scored.map(s => ({ combo: s.lanes.join('-'), prob: s.prob }));
  }

  combos.sort((a, b) => b.prob - a.prob);
  const picked = combos.slice(0, 6);
  const totalProb = picked.reduce((a, c) => a + c.prob, 0);

  const units = Math.max(2, Math.round(budgetYen / 100));
  let raw = picked.map(c => (c.prob / totalProb) * units);
  let alloc = raw.map(r => Math.max(1, Math.round(r)));
  let sumUnits = alloc.reduce((a, c) => a + c, 0);
  while (sumUnits > units && alloc.some(a => a > 1)) {
    const maxIdx = alloc.indexOf(Math.max(...alloc));
    alloc[maxIdx] -= 1; sumUnits -= 1;
  }
  while (sumUnits < units) {
    alloc[0] += 1; sumUnits += 1;
  }

  let result = picked.map((c, i) => ({
    combo: c.combo,
    prob: Math.round(c.prob * 1000) / 10,
    yen: alloc[i] * 100,
    insurance: false,
  }));

  // 保険目: 軸(◎)が1コースの場合、1号艇が飛んだ(2着3着以下に沈んだ)場合に備えて
  // ○が頭の目を機械的に1点追加する
  if (betType === '3連単' && candidates[0].entryCourse === 1) {
    const already = result.some(r => r.combo.startsWith(candidates[1].lane + '-'));
    if (!already && candidates.length >= 3) {
      const insuranceCombo = `${candidates[1].lane}-${candidates[0].lane}-${candidates[2].lane}`;
      result.push({ combo: insuranceCombo, prob: null, yen: 100, insurance: true });
    }
  }

  return result;
}

function normalizeOddsValue(value) {
  if (value === null || value === undefined || value === '') return null;

  const cleaned = String(value)
    .replace(/倍/g, '')
    .replace(/,/g, '')
    .trim();

  const number = Number(cleaned);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function collectOddsMap(boats) {
  const oddsMap = {};

  boats.forEach((boat) => {
    const source = boat?.odds;

    if (!source || typeof source !== 'object') return;

    Object.entries(source).forEach(([combo, value]) => {
      const odds = normalizeOddsValue(value);

      if (odds !== null) {
        oddsMap[String(combo).replace(/\s/g, '')] = odds;
      }
    });
  });

  return oddsMap;
}

function addExpectedValueToBets(bets, boats) {
  if (!Array.isArray(bets)) return [];

  const oddsMap = collectOddsMap(boats);

  return bets.map((bet) => {
    const odds = oddsMap[bet.combo] ?? null;
    const probability =
      typeof bet.prob === 'number' ? bet.prob / 100 : null;

    const expectedValue =
      odds !== null && probability !== null
        ? probability * odds * 100
        : null;

    const expectedProfit =
      expectedValue !== null
        ? Math.round(bet.yen * (expectedValue / 100 - 1))
        : null;

    let evLabel = 'オッズ未取得';

    if (expectedValue !== null) {
      if (expectedValue >= 130) evLabel = '強く買い候補';
      else if (expectedValue >= 110) evLabel = '買い候補';
      else if (expectedValue >= 100) evLabel = '検討候補';
      else evLabel = '見送り候補';
    }

    return {
      ...bet,
      odds,
      expectedValue:
        expectedValue !== null
          ? Math.round(expectedValue)
          : null,
      expectedProfit,
      evLabel,
    };
  });
}

function findAnaCandidate(boats) {
  const outer = boats.filter(b => b.rank >= 4);
  if (outer.length === 0) return null;
  return outer.reduce((best, b) => {
    const val = b.gearScore + b.exScore * 0.5;
    const bestVal = best ? best.gearScore + best.exScore * 0.5 : -1;
    return val > bestVal ? b : best;
  }, null);
}

function generateAnaBets(boats, betType, budgetYen) {
  const anaBoat = findAnaCandidate(boats);
  if (!anaBoat) return { anaBoat: null, bets: [] };

  const weights = boats.map(b => Math.exp(b.total / 12));
  const sumAll = weights.reduce((a, c) => a + c, 0);
  const idx = boats.map((_, i) => i);
  const perms = permutations3(idx).filter(([i, j, k]) =>
    boats[i].lane === anaBoat.lane || boats[j].lane === anaBoat.lane
  );

  const scored = perms.map(([i, j, k]) => {
    const p1 = weights[i] / sumAll;
    const p2 = weights[j] / (sumAll - weights[i]);
    const p3 = weights[k] / (sumAll - weights[i] - weights[j]);
    const prob = p1 * p2 * p3;
    return { lanes: [boats[i].lane, boats[j].lane, boats[k].lane], prob };
  });

  let combos;
  if (betType === '3連複') {
    const map = new Map();
    scored.forEach(s => {
      const key = [...s.lanes].sort((a, b) => a - b).join('-');
      map.set(key, (map.get(key) || 0) + s.prob);
    });
    combos = Array.from(map.entries()).map(([key, prob]) => ({ combo: key, prob }));
  } else {
    combos = scored.map(s => ({ combo: s.lanes.join('-'), prob: s.prob }));
  }

  combos.sort((a, b) => b.prob - a.prob);
  const picked = combos.slice(0, 2);
  const totalProb = picked.reduce((a, c) => a + c.prob, 0) || 1;
  const units = Math.max(2, Math.round(budgetYen / 100));
  let raw = picked.map(c => (c.prob / totalProb) * units);
  let alloc = raw.map(r => Math.max(1, Math.round(r)));
  let sumUnits = alloc.reduce((a, c) => a + c, 0);
  while (sumUnits > units && alloc.some(a => a > 1)) {
    const maxIdx = alloc.indexOf(Math.max(...alloc));
    alloc[maxIdx] -= 1; sumUnits -= 1;
  }
  while (sumUnits < units) { alloc[0] += 1; sumUnits += 1; }

  return {
    anaBoat,
    bets: picked.map((c, i) => ({ combo: c.combo, prob: Math.round(c.prob * 1000) / 10, yen: alloc[i] * 100 })),
  };
}

// ---------- Race development forecast (展開予想) ----------

function generateForecast(boats) {
  const byLane = lane => boats.find(b => b.lane === lane) || boats.find(b => b.entryCourse === lane);
  const inCourse = c => boats.find(b => b.entryCourse === c);
  const lines = [];

  // 逃げ(1コース)の信頼度
  const c1 = inCourse(1);
  if (c1) {
    const stArr = boats.map(b => b.exST).filter(v => v != null);
    const isSlowestST = c1.exST != null && stArr.length > 1 && c1.exST === Math.max(...stArr);
    if (c1.exhibitF) {
      lines.push(`1コースはF持ちで信頼度が下がります。逃げ切れないと展開が大きく動く可能性があります。`);
    } else if (c1.rank <= 2 && isSlowestST) {
      lines.push(`1コース(${c1.lane}号艇)は総合評価は上位ですが、展示STが全艇中最も遅く、スタートの精度には注意が必要です。`);
    } else if (c1.rank <= 2) {
      lines.push(`1コース(${c1.lane}号艇)は実力・機力も上位で、逃げ本線と見て良さそうです。`);
    } else {
      lines.push(`1コース(${c1.lane}号艇)は評価がやや低めで、逃げ切れるかは不透明です。`);
    }
  }

  // 差し候補(2-3コース)
  const sashiCandidates = [2, 3].map(c => inCourse(c)).filter(Boolean).sort((a, b) => b.total - a.total);
  if (sashiCandidates.length) {
    const top = sashiCandidates[0];
    if (top.rank <= 3) {
      lines.push(`差しは${top.entryCourse}コース(${top.lane}号艇)が有力候補。展示${top.exTime ?? '-'}秒・機力スコア${Math.round(top.gearScore)}で先行艇を捉える力があります。`);
    }
  }

  // まくり警戒(外枠4-6コース)
  // 従来はチルト・A1級・総合順位のみで判定していたが、機力(モーター/ボート)が
  // 全艇中で突出している外枠艇を見落とすケースが実戦で複数確認されたため、
  // isOuterGearAce(outerGearBonus>0)も警戒対象に追加
  const outer = [4, 5, 6].map(c => inCourse(c)).filter(Boolean);
  const makuriThreat = outer.filter(b => b.tiltBonus > 0 || b.isOuterAce || b.isOuterGearAce || b.rank <= 2)
    .sort((a, b) => b.total - a.total)[0];
  if (makuriThreat) {
    const reasons = [];
    if (makuriThreat.isOuterAce) reasons.push('級別上位');
    if (makuriThreat.isOuterGearAce) reasons.push('機力(モーター/ボート)が全艇トップ');
    if (makuriThreat.tiltBonus > 0) reasons.push('チルトが伸び型');
    if (makuriThreat.rank <= 2) reasons.push('総合評価も上位');
    lines.push(`まくり/まくり差しは${makuriThreat.entryCourse}コース(${makuriThreat.lane}号艇)を警戒(${reasons.join('・') || '機力・展示が良好'})。`);
  } else {
    lines.push(`外枠から目立った攻め手はなく、比較的縦(枠なり)決着になりやすい構図です。`);
  }

  // 特殊フラグの統合
  if (boats.some(b => b.isChaosRace)) lines.push(`展示Fが複数艇におよぶ大荒れ想定。隊形が乱れやすく、クリーンスタート艇の押し上げに注意。`);
  if (boats.some(b => b.isRoughWater)) lines.push(`荒天のため水面コンディションが不安定。コース優位が普段より効きにくい可能性があります。`);

  return lines;
}


// 通常ブラウザ用ストレージ互換レイヤー
const browserStorage = {
  async get(key) {
    const value = window.localStorage.getItem(key);
    return value == null ? null : { value };
  },
  async set(key, value) {
    window.localStorage.setItem(key, value);
    return { ok: true };
  },
  async list(prefix = '') {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    return { keys };
  },
};

// ---------- Storage helpers ----------

async function loadJSON(key, fallback) {
  try {
    const res = await browserStorage.get(key, false);
    return res ? JSON.parse(res.value) : fallback;
  } catch (e) {
    return fallback;
  }
}
async function saveJSON(key, value) {
  const attempt = async () => {
    const result = await browserStorage.set(key, JSON.stringify(value), false);
    if (!result) throw new Error('storage.set returned empty result');
    return result;
  };
  try {
    await attempt();
    return { ok: true, error: null };
  } catch (firstErr) {
    // ストレージAPI側の一時的な不具合対策として1回だけ再試行
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      await attempt();
      return { ok: true, error: null };
    } catch (secondErr) {
      return { ok: false, error: (secondErr && secondErr.message) ? secondErr.message : String(secondErr) };
    }
  }
}

// ---------- Stats (戦績分析) ----------

async function loadAllRaces() {
  try {
    const listRes = await browserStorage.list('boatrace:races:', false);
    if (!listRes || !Array.isArray(listRes.keys)) return [];
    const all = [];
    for (const key of listRes.keys) {
      try {
        const res = await browserStorage.get(key, false);
        if (res && res.value) {
          const races = JSON.parse(res.value);
          if (Array.isArray(races)) {
            const venue = key.replace('boatrace:races:', '');
            races.forEach(r => all.push({ ...r, venue }));
          }
        }
      } catch (e) { /* この会場のデータはスキップ */ }
    }
    return all;
  } catch (e) {
    return [];
  }
}

function parseResultLanes(resultStr) {
  if (!resultStr) return null;
  const parts = resultStr.split(/[-\s、,]+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n) && n >= 1 && n <= 6);
  return parts.length ? parts : null;
}

function computeMarkStats(races) {
  const marks = ['◎', '○', '▲', '△'];
  const stats = {};
  marks.forEach(m => { stats[m] = { n: 0, win: 0, top2: 0, top3: 0 }; });
  let usedRaces = 0;
  let skippedRaces = 0;

  races.forEach(r => {
    const lanes = parseResultLanes(r.result);
    if (!lanes || !Array.isArray(r.boats) || r.boats.length === 0) { skippedRaces++; return; }
    usedRaces++;
    r.boats.forEach(b => {
      if (!stats[b.mark]) return;
      const idx = lanes.indexOf(b.lane); // 0-indexed。-1なら3着以内に入っていない
      stats[b.mark].n++;
      if (idx === 0) stats[b.mark].win++;
      if (idx >= 0 && idx <= 1) stats[b.mark].top2++;
      if (idx >= 0 && idx <= 2) stats[b.mark].top3++;
    });
  });

  const summary = marks.map(m => {
    const s = stats[m];
    return {
      mark: m,
      n: s.n,
      winRate: s.n ? Math.round((s.win / s.n) * 1000) / 10 : null,
      top2Rate: s.n ? Math.round((s.top2 / s.n) * 1000) / 10 : null,
      top3Rate: s.n ? Math.round((s.top3 / s.n) * 1000) / 10 : null,
    };
  });

  return { summary, usedRaces, skippedRaces, totalRaces: races.length };
}

// 3連単でしか買わない場合、単勝/連対/複勝より「◎○▲がそのまま1-2-3着で当たったか」
// (ストレート的中)と「順不同で3着以内に来たか」(ボックス的中=3連複相当)の方が実態に即した指標になる。
// 保存時に実際のおすすめ買い目(bets)も記録している場合は、その買い目が的中したかも合わせて集計する。
function computeTrifectaStats(races) {
  let usedRaces = 0;
  let straightHit = 0;
  let boxHit = 0;
  let betsRaces = 0;
  let betsHit = 0;

  races.forEach(r => {
    const lanes = parseResultLanes(r.result);
    if (!lanes || lanes.length < 3 || !Array.isArray(r.boats) || r.boats.length === 0) return;
    const top3Actual = lanes.slice(0, 3);
    const honmei = ['◎', '○', '▲'].map(m => {
      const found = r.boats.find(b => b.mark === m);
      return found ? found.lane : null;
    });
    if (honmei.every(l => l != null)) {
      usedRaces++;
      if (honmei[0] === top3Actual[0] && honmei[1] === top3Actual[1] && honmei[2] === top3Actual[2]) straightHit++;
      const honmeiSet = new Set(honmei);
      const actualSet = new Set(top3Actual);
      if (honmeiSet.size === 3 && [...honmeiSet].every(l => actualSet.has(l))) boxHit++;
    }
    if (Array.isArray(r.bets) && r.bets.length) {
      betsRaces++;
      const actualCombo = top3Actual.join('-');
      if (r.bets.some(b => b.combo === actualCombo)) betsHit++;
    }
  });

  return {
    usedRaces,
    straightRate: usedRaces ? Math.round((straightHit / usedRaces) * 1000) / 10 : null,
    boxRate: usedRaces ? Math.round((boxHit / usedRaces) * 1000) / 10 : null,
    betsRaces,
    betsHitRate: betsRaces ? Math.round((betsHit / betsRaces) * 1000) / 10 : null,
  };
}

// 会場によってイン(1コース)の強さが違うという仮説を検証するため、
// (1) 会場ごとの3連単的中率と、(2) 会場ごとの実測コース別1着率、の両方を出す。
// (2)は印の良し悪しとは無関係に「その水面で実際何コースが強いか」を直接見られるので、
// COURSE_BASE(全国平均想定の固定値)が会場に合っているかどうかの一番直接的な検証になる。
function computeVenueStats(races) {
  const byVenue = {};
  races.forEach(r => {
    const v = r.venue || '不明';
    if (!byVenue[v]) byVenue[v] = [];
    byVenue[v].push(r);
  });

  return Object.keys(byVenue).sort().map(venue => {
    const venueRaces = byVenue[venue];
    const trifecta = computeTrifectaStats(venueRaces);

    // 実測コース別1着率(印は使わず、entryCourseと結果だけから算出)
    const courseWinCount = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const courseRaceCount = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    let courseRaces = 0;
    venueRaces.forEach(r => {
      const lanes = parseResultLanes(r.result);
      if (!lanes || lanes.length < 1 || !Array.isArray(r.boats)) return;
      const winnerLane = lanes[0];
      const winnerBoat = r.boats.find(b => b.lane === winnerLane);
      if (!winnerBoat || winnerBoat.entryCourse == null) return;
      courseRaces++;
      r.boats.forEach(b => {
        if (b.entryCourse != null && courseRaceCount[b.entryCourse] != null) courseRaceCount[b.entryCourse]++;
      });
      if (courseWinCount[winnerBoat.entryCourse] != null) courseWinCount[winnerBoat.entryCourse]++;
    });
    const courseWinRate = [1, 2, 3, 4, 5, 6].map(c => ({
      course: c,
      winRate: courseRaces ? Math.round((courseWinCount[c] / courseRaces) * 1000) / 10 : null,
    }));

    return { venue, raceCount: venueRaces.length, trifecta, courseRaces, courseWinRate };
  });
}


// ---------- Vision (image) intake ----------

function fileToBase64(file) {
  // スマホのスクリーンショットは1枚で数MBになることがあり、そのままbase64化すると
  // リクエストが肥大化してモバイル回線で失敗しやすい。長辺1200px・JPEG圧縮に落として送る。
  const MAX_DIM = 1200;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        const base64 = dataUrl.split(',')[1];
        resolve({ base64, mediaType: 'image/jpeg', byteSize: Math.round(base64.length * 0.75) });
      };
      img.onerror = () => reject(new Error('画像のデコードに失敗しました'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });
}

const VISION_PROMPT = `あなたは競艇(ボートレース)の出走表・直前情報・展示情報・今節成績のスクリーンショットを読み取るアシスタントです。
渡された画像すべてを読み、6艇分のデータを1つのJSONオブジェクトにまとめて出力してください。

出力は必ず以下の形式のJSONのみとし、説明文・前置き・Markdownのコードフェンス(\`\`\`)は一切付けないでください。値が画像から読み取れない場合はnullにしてください。数値は文字列ではなく数値型で出力してください。

{
  "boats": [
    {
      "lane": 1,
      "regnum": "登録番号(文字列)",
      "classG": "A1/A2/B1/B2のいずれか",
      "branchOrigin": "支部/出身地",
      "age": 年齢(数値),
      "regWeight": 体重(数値),
      "avgST": 平均ST(数値),
      "natWin": 全国勝率, "nat2": 全国2連率, "nat3": 全国3連率,
      "locWin": 当地勝率, "loc2": 当地2連率, "loc3": 当地3連率,
      "motorNo": "モーター番号", "motor2": モーター2連率, "motor3": モーター3連率,
      "boatNo": "ボート番号", "boat2": ボート2連率, "boat3": ボート3連率,
      "exTime": 展示タイム(数値), "tilt": チルト(数値), "exWeight": 展示体重(数値),
      "partsExchanged": 部品交換の有無(true/false),
      "entryCourse": 進入コース番号(1-6。展示情報の並び順から判定すること。艇番と同じとは限らない),
      "exST": 展示ST(数値), "exhibitF": 展示フライングの有無(true/false),
      "konsetsu": [
        { "raceNo": レース番号(数値), "course": その回の進入コース(数値), "st": ST(数値), "finish": 着順(数値。読み取れなければnull) }
      ]
    }
  ],
  "weather": { "temp": "気温", "wind": "風速", "waterTemp": "水温", "wave": "波高" }
}

boatsは必ずlane 1〜6の6艇分を含めてください。今節成績の着順は色付きの丸数字や下線付き数字として表示されていることが多いので、見えている範囲はできるだけ拾ってください。`;

async function callVisionAPI(images) {
  const response = await fetch(
    'https://geminiapikey.uimaru02.workers.dev',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        images: images.map(image => ({
          mimeType: image.mediaType,
          data: image.base64,
        })),
      }),
    }
  );

  const result = await response.json();

  if (!response.ok || !result.success) {
    throw new Error(
      result.details ||
      result.error ||
      '画像解析APIでエラーが発生しました'
    );
  }

  return result.data;
}

function normalizeAIBoats(
  boats,
  raceOdds = {},
  positionReturns = {}
) {
  const lanes = [1, 2, 3, 4, 5, 6];

  return lanes.map((lane) => {
    const b = boats.find((x) => x.lane === lane) || {};

    const konsetsu = Array.isArray(b.currentSeriesResults)
      ? b.currentSeriesResults
      : Array.isArray(b.konsetsu)
        ? b.konsetsu
        : [];

    const stValues = konsetsu
      .map((e) => Number(e.st))
      .filter((v) => !Number.isNaN(v));

    const konsetsuAvgST = stValues.length
      ? stValues.reduce((a, c) => a + c, 0) / stValues.length
      : null;

    return {
      lane,

      regnum: b.registrationNumber ?? b.regnum ?? "",
      classG: b.class ?? b.classG ?? "",
      branchOrigin: b.branchOrigin ?? "",
      age: b.age ?? null,
      regWeight: b.weight ?? b.regWeight ?? null,

      avgST: b.averageST ?? b.avgST ?? null,

      natWin: b.nationalWinRate ?? b.natWin ?? 0,
      nat2: b.national2Rate ?? b.nat2 ?? 0,

      locWin: b.localWinRate ?? b.locWin ?? 0,
      loc2: b.local2Rate ?? b.loc2 ?? 0,

      motorNo: b.motorNumber ?? b.motorNo ?? "",
      motor2: b.motorRate ?? b.motor2 ?? 0,

      boatNo: b.boatNumber ?? b.boatNo ?? "",
      boat2: b.boatRate ?? b.boat2 ?? 0,

      exTime: b.exhibitionTime ?? b.exTime ?? null,
      tilt: b.tilt ?? null,

      partsExchanged:
        !!b.partsExchanged ||
        (Array.isArray(b.partsReplacement) &&
          b.partsReplacement.length > 0),

      entryCourse: b.entryCourse ?? lane,

      exST: b.exhibitionST ?? b.exST ?? null,

      exhibitF: !!b.exhibitionF || !!b.exhibitF,

      konsetsu,
      konsetsuAvgST,

      odds:
  raceOdds &&
  typeof raceOdds === 'object' &&
  !Array.isArray(raceOdds)
    ? raceOdds
    : b.odds &&
        typeof b.odds === 'object' &&
        !Array.isArray(b.odds)
      ? b.odds
      : {},

      positionReturns:
  positionReturns &&
  typeof positionReturns === 'object' &&
  !Array.isArray(positionReturns)
    ? positionReturns
    : {},

      hasData: !!(
        b.registrationNumber ||
        b.regnum ||
        b.motorNumber ||
        b.motorNo
      ),
    };
  });
}

    

function scoreStars(score) {
  const n = Math.max(1, Math.min(5, Math.round((score || 0) / 20)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function scoreColor(score) {
  if (score >= 90) return '#52d273';
  if (score >= 80) return '#5fa8ff';
  if (score >= 70) return '#e8b800';
  if (score >= 60) return '#ff9b6b';
  return '#ff6b6b';
}

function getRaceSummary(boats) {
  if (!boats || boats.length === 0) return null;
  const top = boats[0];
  const c1 = boats.find(b => b.entryCourse === 1);
  const confidence = top.raceConfidence ?? top.confidence ?? 50;
  const chaosIndex = top.chaosIndex ?? 50;
  const escapeRate = c1
    ? Math.max(5, Math.min(95, Math.round(
        35 +
        (c1.courseScore || 0) * 0.45 +
        (c1.stScore || 50) * 0.18 +
        (c1.gearScore || 50) * 0.12 -
        (c1.dangerScore || 0) * 0.28
      )))
    : null;

  return {
    confidence,
    confidenceLabel: top.raceConfidenceLabel || (confidence >= 70 ? '高い' : confidence >= 55 ? '標準' : '低め'),
    chaosIndex,
    chaosStars: top.chaosStars || Math.max(1, Math.ceil(chaosIndex / 20)),
    escapeRate,
    bestBoat: top,
    dangerBoat: [...boats].sort((a, b) => (b.dangerScore || 0) - (a.dangerScore || 0))[0],
    targetBoat: [...boats].sort((a, b) => (b.targetScore || 0) - (a.targetScore || 0))[0],
  };
}

// ---------- UI ----------

export default function BoatRaceTool() {
  const [venue, setVenue] = useState('若松');
  const [raceNo, setRaceNo] = useState('');
  const [raceDate, setRaceDate] = useState('');
  const [racelistText, setRacelistText] = useState('');
  const [beforeInfoText, setBeforeInfoText] = useState('');
  const [startDispText, setStartDispText] = useState('');
  const [boats, setBoats] = useState(null);
  const [weather, setWeather] = useState(null);
  const [memo, setMemo] = useState('');
  const [races, setRaces] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const [betType, setBetType] = useState('3連単');
  const [budgetYen, setBudgetYen] = useState(500);
  const [bets, setBets] = useState(null);
  const [anaBudget, setAnaBudget] = useState(200);
  const [anaResult, setAnaResult] = useState(null);
  const [forecast, setForecast] = useState(null);
  const [images, setImages] = useState([]);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [statsResult, setStatsResult] = useState(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const loadVenueData = useCallback(async (v) => {
    setLoading(true);
    const m = await loadJSON(`boatrace:memo:${v}`, '');
    const r = await loadJSON(`boatrace:races:${v}`, []);
    setMemo(m || '');
    setRaces(r || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadVenueData(venue); }, [venue, loadVenueData]);

  const handleParse = () => {
    const rl = parseRacelist(racelistText);
    const bi = parseBeforeInfo(beforeInfoText);
    const sd = parseStartDisp(startDispText);

    if (!rl && !bi) {
      setStatus('出走表または直前情報のテキストを貼ってください。');
      setForecast(null);
      return;
    }
    const merged = mergeBoats(rl, bi, sd);
    const scored = computeScores(merged, venue, sd ? sd.weather : null);
    setBoats(scored);
    setWeather(sd ? sd.weather : null);
    setBets(null);
    setAnaResult(null);
    setForecast(generateForecast(scored));
    const missing = [];
    if (!rl) missing.push('出走表');
    if (!bi) missing.push('直前情報');
    if (!sd || !sd.valid) missing.push('スタート展示');
    setStatus(missing.length ? `注意: ${missing.join('・')}が未入力です(枠なり/標準値で計算)` : '解析完了');
  };

  const handleGenerateBets = () => {
  if (!boats) return;

  const generatedBets = generateBets(
    boats,
    betType,
    budgetYen
  );

  setBets(
    addExpectedValueToBets(
      generatedBets,
      boats
    )
  );
};

  const handleImagesSelected = async (fileList) => {
    setImageError('');
    const files = Array.from(fileList || []);
    if (!files.length) return;
    try {
      const newImages = await Promise.all(files.map(async (file) => {
        const { base64, mediaType, byteSize } = await fileToBase64(file);
        return { name: file.name, mediaType, base64, byteSize, previewUrl: `data:${mediaType};base64,${base64}` };
      }));
      setImages(prev => [...prev, ...newImages]);
    } catch (e) {
      setImageError((e && e.message) ? e.message : '画像の読み込みに失敗しました');
    }
  };

  const handleRemoveImage = (idx) => {
    setImages(prev => prev.filter((_, i) => i !== idx));
  };

  const handleAnalyzeImages = async () => {
    if (!images.length) { setImageError('画像を追加してください'); return; }
    setImageLoading(true);
    setImageError('');
    try {
      const result = await callVisionAPI(images);
      const normalized = normalizeAIBoats(
  result.boats,
  result.odds
);
      const scored = computeScores(normalized, venue, result.weather || null);
      setBoats(scored);
setWeather(result.weather || null);

const autoBets = addExpectedValueToBets(
  generateBets(
    scored,
    betType,
    budgetYen
  ),
  scored
);

const autoAnaResult = generateAnaBets(
  scored,
  betType,
  anaBudget
);

setBets(autoBets);
setAnaResult(autoAnaResult);
setForecast(generateForecast(scored));
      const missingCount = normalized.filter(b => !b.hasData).length;
      setStatus(missingCount ? `画像解析完了(${6 - missingCount}/6艇分を検出、${missingCount}艇はデータ不足)` : '画像解析完了(6艇分を検出)');
    } catch (e) {
      setImageError((e && e.message) ? e.message : '画像の解析に失敗しました');
    } finally {
      setImageLoading(false);
    }
  };

  const handleGenerateAna = () => {
    if (!boats) return;
    setAnaResult(generateAnaBets(boats, betType, anaBudget));
  };

  const handleSaveMemo = async () => {
    const { ok, error } = await saveJSON(`boatrace:memo:${venue}`, memo);
    setStatus(ok ? 'メモを保存しました' : `メモの保存に失敗しました: ${error}`);
  };

  const handleSaveRace = async () => {
    if (!boats) { setStatus('先に解析してください'); return; }
    const entry = {
      id: Date.now(),
      date: raceDate || '',
      raceNo: raceNo || '',
      savedAt: new Date().toISOString(),
      note: saveNote,
      result: '',
      boats: boats.map(b => ({
        lane: b.lane, mark: b.mark, entryCourse: b.entryCourse,
        total: Math.round(b.total * 10) / 10,
        regnum: b.regnum, classG: b.classG, exhibitF: b.exhibitF,
        // 軸ごとの検証用に内訳も保存(戦績分析で「どの軸が実際に効いているか」を追えるようにする)
        playerScore: Math.round(b.playerScore * 10) / 10,
        gearScore: Math.round(b.gearScore * 10) / 10,
        courseScore: Math.round(b.courseScore * 10) / 10,
        exScore: Math.round(b.exScore * 10) / 10,
        stScore: b.stScore != null ? Math.round(b.stScore * 10) / 10 : null,
        classScore: b.classScore,
        konsetsuBonus: b.konsetsuBonus != null ? Math.round(b.konsetsuBonus * 10) / 10 : 0,
        outerGearBonus: b.outerGearBonus || 0,
        outerAceBonus: b.outerAceBonus || 0,
        tiltBonus: b.tiltBonus || 0,
      })),
      weather,
      // 実際に表示していたおすすめ買い目も記録(生成済みの場合のみ)。
      // これがあれば「◎○▲の並び」だけでなく「実際に提示した買い目が当たったか」も後から検証できる。
      bets: bets || null,
      betType: bets ? betType : null,
    };
    const updated = [entry, ...races];
    const { ok, error } = await saveJSON(`boatrace:races:${venue}`, updated);
    if (ok) { setRaces(updated); setStatus('レースを保存しました'); setSaveNote(''); }
    else setStatus(`保存に失敗しました: ${error}`);
  };

  const handleResultChange = async (id, value) => {
    const updated = races.map(r => r.id === id ? { ...r, result: value } : r);
    setRaces(updated);
    await saveJSON(`boatrace:races:${venue}`, updated);
  };

  const handleDeleteRace = async (id) => {
    const updated = races.filter(r => r.id !== id);
    setRaces(updated);
    await saveJSON(`boatrace:races:${venue}`, updated);
    setStatus('削除しました');
  };

  const handleComputeStats = async () => {
    setStatsLoading(true);
    const all = await loadAllRaces();
    setStatsResult({ mark: computeMarkStats(all), trifecta: computeTrifectaStats(all), byVenue: computeVenueStats(all) });
    setStatsLoading(false);
  };

  const raceSummary = getRaceSummary(boats);

  return (
    <div style={{ minHeight: '100vh', background: '#0b1420', color: '#e8edf2', fontFamily: 'system-ui, -apple-system, "Hiragino Sans", sans-serif' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '20px 16px 60px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 18, borderBottom: '2px solid #1c2b3d', paddingBottom: 12 }}>
          <div style={{ display: 'flex', gap: 3 }}>
            {[1,2,3,4,5,6].map(l => (
              <div key={l} style={{ width: 14, height: 14, borderRadius: 3, background: LANE_COLORS[l].bg, border: '1px solid #2a3d52' }} />
            ))}
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.5, margin: 0 }}>競艇予想ツール</h1>
        </div>

        {/* Venue / race selector */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <select value={venue} onChange={e => setVenue(e.target.value)}
            style={{ background: '#131f2e', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '8px 10px', fontSize: 14 }}>
            {VENUES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <input placeholder="日付 (7/23)" value={raceDate} onChange={e => setRaceDate(e.target.value)}
            style={{ width: 100, background: '#131f2e', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '8px 10px', fontSize: 14 }} />
          <input placeholder="R" value={raceNo} onChange={e => setRaceNo(e.target.value)}
            style={{ width: 60, background: '#131f2e', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '8px 10px', fontSize: 14 }} />
        </div>

        {/* Three inputs */}
        {[
          { label: '① 出走表', value: racelistText, set: setRacelistText, ph: '出走表のテキストを貼り付け' },
          { label: '② 直前情報', value: beforeInfoText, set: setBeforeInfoText, ph: '直前情報のテキストを貼り付け' },
          { label: '③ スタート展示', value: startDispText, set: setStartDispText, ph: '進入・展示STのテキストを貼り付け' },
        ].map((f, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: '#8ba3bd', marginBottom: 4, display: 'block' }}>{f.label}</label>
            <textarea value={f.value} onChange={e => f.set(e.target.value)} placeholder={f.ph}
              style={{ width: '100%', minHeight: 70, background: '#0f1a28', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: 8, fontSize: 12, fontFamily: 'monospace', boxSizing: 'border-box', resize: 'vertical' }} />
          </div>
        ))}

        <button onClick={handleParse}
          style={{ width: '100%', background: '#e8b800', color: '#111', border: 'none', borderRadius: 6, padding: '10px 0', fontWeight: 700, fontSize: 14, cursor: 'pointer', marginBottom: 8 }}>
          解析する
        </button>

        {/* Image upload (vision) */}
        <div style={{ marginTop: 10, marginBottom: 16, borderTop: '1px solid #1c2b3d', paddingTop: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>④ 画像から読み込む(β)</div>
          <div style={{ fontSize: 11, color: '#8ba3bd', marginBottom: 8 }}>
            出走表・直前情報・展示情報・今節成績のスクショをまとめて渡すと、着順も含めてAIが読み取ります。テキスト貼り付けと併用可(画像解析すると①〜③の内容は上書きされます)。
          </div>
          <label style={{
            display: 'inline-block', background: '#131f2e', color: '#e8edf2', border: '1px dashed #2a3d52',
            borderRadius: 6, padding: '8px 14px', fontSize: 13, cursor: 'pointer', marginBottom: 8,
          }}>
            画像を選択
            <input type="file" accept="image/*" multiple style={{ display: 'none' }}
              onChange={e => { handleImagesSelected(e.target.files); e.target.value = ''; }} />
          </label>

          {images.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {images.map((img, i) => (
                <div key={i} style={{ position: 'relative', width: 56, height: 56 }}>
                  <img src={img.previewUrl} alt={img.name}
                    style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 6, border: '1px solid #2a3d52' }} />
                  <button onClick={() => handleRemoveImage(i)}
                    style={{
                      position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9,
                      background: '#ff6b6b', color: '#fff', border: 'none', fontSize: 11, lineHeight: '18px', cursor: 'pointer', padding: 0,
                    }}>×</button>
                </div>
              ))}
            </div>
          )}
          {images.length > 0 && (
            <div style={{ fontSize: 11, color: '#8ba3bd', marginBottom: 8 }}>
              合計サイズ目安: {(images.reduce((a, c) => a + (c.byteSize || 0), 0) / 1024 / 1024).toFixed(1)}MB(枚数が多いと通信に時間がかかります)
            </div>
          )}

          <button onClick={handleAnalyzeImages} disabled={imageLoading || images.length === 0}
            style={{
              width: '100%', background: imageLoading || images.length === 0 ? '#2a3d52' : '#1857b0', color: '#fff', border: 'none',
              borderRadius: 6, padding: '10px 0', fontWeight: 700, fontSize: 14, cursor: imageLoading || images.length === 0 ? 'default' : 'pointer',
            }}>
            {imageLoading ? '解析中...' : '画像を解析する'}
          </button>
          {imageError && <div style={{ fontSize: 12, color: '#ff6b6b', marginTop: 6 }}>{imageError}</div>}
        </div>

        {status && <div style={{ fontSize: 12, color: '#8ba3bd', marginBottom: 14 }}>{status}</div>}

        {weather && (
          <div style={{ fontSize: 12, color: '#8ba3bd', marginBottom: 14 }}>
            気温{weather.temp}℃ / 風速{weather.wind}m / 水温{weather.waterTemp}℃ / 波高{weather.wave}cm
          </div>
        )}

        {boats && boats.some(b => b.isRoughWater) && (
          <div style={{ fontSize: 12, color: '#7aa6e8', marginBottom: 10, fontWeight: 700 }}>
            🌊 荒天注意(風速/波高が高め) — コース優位の重みを下げて選手力・機力を重視
          </div>
        )}

        {boats && boats.some(b => b.isChaosRace) && (
          <div style={{ fontSize: 12, color: '#ff6b6b', marginBottom: 10, fontWeight: 700 }}>
            ⚠ 大荒れ想定(展示F 4艇以上) — クリーンスタート艇を加点、買い目の対象を5艇に拡大
          </div>
        )}

        {boats && boats.some(b => b.isOuterAce) && (
          <div style={{ fontSize: 12, color: '#e8b800', marginBottom: 10, fontWeight: 700 }}>
            ★ 外枠エース警戒 — 他艇より級別が高いA1級が外枠から狙える構図です
          </div>
        )}

        {boats && boats.some(b => b.isOuterGearAce) && (
          <div style={{ fontSize: 12, color: '#7aff9b', marginBottom: 10, fontWeight: 700 }}>
            ⚡ 外枠機力エース警戒 — 4-6コースにモーター・ボートが全艇トップの艇がいます(まくり注意)
          </div>
        )}

        {forecast && forecast.length > 0 && (
          <div style={{ background: '#131f2e', border: '1px solid #2a3d52', borderRadius: 8, padding: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: '#e8b800' }}>展開予想</div>
            {forecast.map((line, i) => (
              <div key={i} style={{ fontSize: 12, color: '#c5d3e0', marginBottom: 4, lineHeight: 1.5 }}>・{line}</div>
            ))}
          </div>
        )}


        {/* AI result summary */}
        {boats && raceSummary && (
          <div style={{ marginBottom: 18 }}>
            <div style={{
              background: 'linear-gradient(180deg, #162438 0%, #111d2b 100%)',
              border: '1px solid #35516f',
              borderRadius: 12,
              padding: 14,
              marginBottom: 12,
              boxShadow: '0 8px 22px rgba(0,0,0,0.18)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: '#8ba3bd', marginBottom: 2 }}>🤖 AI解析結果</div>
                  <div style={{ fontSize: 17, fontWeight: 800 }}>
                    信頼度 {Math.round(raceSummary.confidence)}%
                    <span style={{ fontSize: 12, color: '#8ba3bd', marginLeft: 6 }}>({raceSummary.confidenceLabel})</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: '#8ba3bd' }}>荒れ指数</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: '#ff9b6b' }}>
                    {'★'.repeat(raceSummary.chaosStars)}{'☆'.repeat(5 - raceSummary.chaosStars)}
                  </div>
                </div>
              </div>

              <div style={{ height: 8, background: '#0b1420', borderRadius: 999, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{
                  width: `${Math.max(0, Math.min(100, raceSummary.confidence))}%`,
                  height: '100%',
                  background: '#e8b800',
                  borderRadius: 999,
                }} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                <div style={{ background: '#0f1a28', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 10, color: '#8ba3bd' }}>本命</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#e8b800' }}>
                    {raceSummary.bestBoat.lane}号艇
                  </div>
                  <div style={{ fontSize: 10, color: '#c5d3e0' }}>{raceSummary.bestBoat.mark} 総合{Math.round(raceSummary.bestBoat.total)}点</div>
                </div>
                <div style={{ background: '#0f1a28', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 10, color: '#8ba3bd' }}>1コース逃げ</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#7aa6e8' }}>
                    {raceSummary.escapeRate != null ? `${raceSummary.escapeRate}%` : '-'}
                  </div>
                  <div style={{ fontSize: 10, color: '#c5d3e0' }}>展開目安</div>
                </div>
                <div style={{ background: '#0f1a28', borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 10, color: '#8ba3bd' }}>買い判断</div>
                  <div style={{
                    fontSize: 14,
                    fontWeight: 800,
                    color: raceSummary.confidence >= 70 ? '#52d273' : raceSummary.confidence >= 55 ? '#e8b800' : '#ff6b6b'
                  }}>
                    {raceSummary.confidence >= 70 ? '買い候補' : raceSummary.confidence >= 55 ? '絞って購入' : '見送り候補'}
                  </div>
                  <div style={{ fontSize: 10, color: '#c5d3e0' }}>無理買い防止</div>
                </div>
              </div>

              {(raceSummary.targetBoat?.targetScore > 0 || raceSummary.dangerBoat?.dangerScore > 0) && (
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div style={{ background: '#10251d', border: '1px solid #1f8a4c', borderRadius: 8, padding: 9 }}>
                    <div style={{ fontSize: 11, color: '#7aff9b', fontWeight: 800 }}>★ 狙い艇</div>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>{raceSummary.targetBoat.lane}号艇</div>
                    <div style={{ fontSize: 10, color: '#b9d9c8', lineHeight: 1.4 }}>
                      {(raceSummary.targetBoat.targetReasons || []).slice(0, 2).join('・') || '総合バランス良好'}
                    </div>
                  </div>
                  <div style={{ background: '#2a171a', border: '1px solid #8d3f47', borderRadius: 8, padding: 9 }}>
                    <div style={{ fontSize: 11, color: '#ff8b95', fontWeight: 800 }}>⚠ 危険艇</div>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>{raceSummary.dangerBoat.lane}号艇</div>
                    <div style={{ fontSize: 10, color: '#e4b8bc', lineHeight: 1.4 }}>
                      {(raceSummary.dangerBoat.dangerReasons || []).slice(0, 2).join('・') || '目立つ危険材料なし'}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ fontSize: 12, fontWeight: 800, marginBottom: 7 }}>AI総合スコア</div>
            {boats.map(b => (
              <div key={`score-${b.lane}`} style={{
                display: 'grid',
                gridTemplateColumns: '34px 30px 1fr auto',
                alignItems: 'center',
                gap: 8,
                background: '#131f2e',
                border: '1px solid #2a3d52',
                borderRadius: 8,
                padding: '9px 10px',
                marginBottom: 6,
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 6,
                  background: LANE_COLORS[b.lane].bg,
                  color: LANE_COLORS[b.lane].text,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 800,
                }}>{b.lane}</div>
                <div style={{ fontWeight: 800, color: '#e8b800' }}>{b.mark}</div>
                <div>
                  <div style={{ fontSize: 12, color: scoreColor(b.total), fontWeight: 800 }}>
                    {scoreStars(b.total)}
                  </div>
                  <div style={{ fontSize: 10, color: '#8ba3bd' }}>
                    実力{Math.round(b.playerScore)} / 機力{Math.round(b.gearScore)} / 展示{Math.round(b.exScore)} / ST{Math.round(b.stScore)}
                  </div>
                </div>
                <div style={{ fontSize: 18, fontWeight: 900, color: scoreColor(b.total) }}>
                  {Math.round(b.total)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Results table */}
        {boats && (
          <div style={{ marginBottom: 20 }}>
            {boats.map(b => (
              <div key={b.lane} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 6,
                background: '#131f2e', border: '1px solid #2a3d52', borderRadius: 8,
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 6, background: LANE_COLORS[b.lane].bg, color: LANE_COLORS[b.lane].text,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, flexShrink: 0,
                }}>{b.lane}</div>
                <div style={{ width: 28, fontWeight: 800, fontSize: 16, color: '#e8b800', flexShrink: 0 }}>{b.mark}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13 }}>
                    {b.classG || '-'} {b.isOuterAce && <span style={{ color: '#e8b800', fontWeight: 700 }}>★エース</span>} {b.isOuterGearAce && <span style={{ color: '#7aff9b', fontWeight: 700 }}>⚡機力エース</span>} {b.exhibitF && <span style={{ color: '#ff6b6b', fontWeight: 700 }}>F</span>} {b.isChaosRace && !b.exhibitF && <span style={{ color: '#1f8a4c', fontWeight: 700 }}>クリーン</span>} {b.tiltBonus > 0 && <span style={{ color: '#7aa6e8', fontWeight: 700 }}>チルト◎</span>} {b.partsExchanged && <span style={{ color: '#ff9b6b', fontWeight: 700 }}>部品交換</span>} 進入{b.entryCourse}コース
                  </div>
                  <div style={{ fontSize: 11, color: '#8ba3bd' }}>
                    全国2連{b.nat2?.toFixed?.(1) ?? '-'} / モーター2連{b.motor2?.toFixed?.(1) ?? '-'} / 展示{b.exTime ?? '-'} / 展示ST{b.exST != null ? b.exST.toFixed(2) : '-'} / 今節平均ST{b.konsetsuAvgST != null ? b.konsetsuAvgST.toFixed(2) : '-'}
                  </div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, flexShrink: 0 }}>{Math.round(b.total * 10) / 10}</div>
              </div>
            ))}

            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <input placeholder="保存メモ(任意)" value={saveNote} onChange={e => setSaveNote(e.target.value)}
                style={{ flex: 1, background: '#131f2e', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '8px 10px', fontSize: 13 }} />
              <button onClick={handleSaveRace}
                style={{ background: '#1f8a4c', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                このレースを保存
              </button>
            </div>

            {/* Bet recommendation */}
            <div style={{ marginTop: 20, borderTop: '1px solid #1c2b3d', paddingTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>おすすめ買い目</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <select value={betType} onChange={e => setBetType(e.target.value)}
                  style={{ background: '#131f2e', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '8px 10px', fontSize: 13 }}>
                  <option value="3連単">3連単</option>
                  <option value="3連複">3連複</option>
                </select>
                <input type="number" step="100" value={budgetYen} onChange={e => setBudgetYen(parseInt(e.target.value) || 0)}
                  style={{ width: 100, background: '#131f2e', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '8px 10px', fontSize: 13 }} />
                <button onClick={handleGenerateBets}
                  style={{ background: '#e8b800', color: '#111', border: 'none', borderRadius: 6, padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  買い目を作る
                </button>
              </div>

              {bets && (
                <div>
                  {bets.map((b, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      background: '#131f2e', border: b.insurance ? '1px dashed #8ba3bd' : '1px solid #2a3d52', borderRadius: 6, padding: '8px 12px', marginBottom: 5,
                    }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>
                        {b.combo} {b.insurance && <span style={{ fontSize: 10, color: '#8ba3bd', fontWeight: 400 }}>(保険)</span>}
                      </div>
                      <div
  style={{
    flex: 1,
    marginLeft: 10,
    fontSize: 11,
    color: '#8ba3bd',
  }}
>
  {b.insurance ? (
    '1号艇飛び目'
  ) : (
    <>
      <div>目安確率 {b.prob}%</div>

      {b.odds !== null &&
      b.odds !== undefined ? (
        <>
          <div>
            オッズ {b.odds}倍 ／
            期待値 {b.expectedValue}%
          </div>

          <div
            style={{
              marginTop: 2,
              fontWeight: 700,
              color:
                b.expectedValue >= 110
                  ? '#7aff9b'
                  : b.expectedValue >= 100
                    ? '#e8b800'
                    : '#ff8080',
            }}
          >
            {b.evLabel}
            {b.expectedProfit !== null &&
              ` ／ 期待収支 ${
                b.expectedProfit >= 0 ? '+' : ''
              }${b.expectedProfit}円`}
          </div>
        </>
      ) : (
        <div>オッズ未取得・期待値計算なし</div>
      )}
    </>
  )}
</div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#e8b800' }}>{b.yen}円</div>
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: '#8ba3bd', marginTop: 6, textAlign: 'right' }}>
                    合計 {bets.reduce((a, c) => a + c.yen, 0)}円
                  </div>
                </div>
              )}
            </div>

            {/* Ana (longshot) bets */}
            <div style={{ marginTop: 20, borderTop: '1px solid #1c2b3d', paddingTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>穴狙い</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                <input type="number" step="100" value={anaBudget} onChange={e => setAnaBudget(parseInt(e.target.value) || 0)}
                  style={{ width: 100, background: '#131f2e', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '8px 10px', fontSize: 13 }} />
                <button onClick={handleGenerateAna}
                  style={{ background: '#1857b0', color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                  穴目を作る
                </button>
              </div>

              {anaResult && !anaResult.anaBoat && (
                <div style={{ fontSize: 12, color: '#8ba3bd' }}>今回は狙い目になる穴艇が見つかりませんでした</div>
              )}

              {anaResult && anaResult.anaBoat && (
                <div>
                  <div style={{ fontSize: 12, color: '#8ba3bd', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>穴候補:</span>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, borderRadius: 4,
                      background: LANE_COLORS[anaResult.anaBoat.lane].bg, color: LANE_COLORS[anaResult.anaBoat.lane].text, fontWeight: 700, fontSize: 12,
                    }}>{anaResult.anaBoat.lane}</span>
                    <span>号艇(印{anaResult.anaBoat.mark} / 順位{anaResult.anaBoat.rank}位 だが機力スコア{Math.round(anaResult.anaBoat.gearScore)})</span>
                  </div>
                  {anaResult.bets.map((b, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      background: '#131f2e', border: '1px solid #1857b0', borderRadius: 6, padding: '8px 12px', marginBottom: 5,
                    }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{b.combo}</div>
                      <div style={{ fontSize: 11, color: '#8ba3bd' }}>目安確率 {b.prob}%</div>
                      <div style={{ fontWeight: 700, fontSize: 14, color: '#7aa6e8' }}>{b.yen}円</div>
                    </div>
                  ))}
                  {anaResult.bets.length > 0 && (
                    <div style={{ fontSize: 11, color: '#8ba3bd', marginTop: 6, textAlign: 'right' }}>
                      合計 {anaResult.bets.reduce((a, c) => a + c.yen, 0)}円
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Venue memo */}
        <div style={{ marginTop: 24, borderTop: '1px solid #1c2b3d', paddingTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{venue} 会場メモ(傾向・気づき)</div>
          <textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="例: イン逃げ強め、向かい風でまくり決まりやすい、など"
            style={{ width: '100%', minHeight: 60, background: '#0f1a28', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: 8, fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
          <button onClick={handleSaveMemo}
            style={{ marginTop: 6, background: '#1857b0', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            メモを保存
          </button>
        </div>

        {/* Stats (戦績分析) */}
        <div style={{ marginTop: 24, borderTop: '1px solid #1c2b3d', paddingTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>戦績分析(全会場)</div>
          <div style={{ fontSize: 11, color: '#8ba3bd', marginBottom: 8 }}>
            3連単の実際の的中率を全会場横断で集計します。物語ではなく数字でルールの良し悪しを判断するための機能です。
          </div>
          <button onClick={handleComputeStats} disabled={statsLoading}
            style={{
              width: '100%', background: statsLoading ? '#2a3d52' : '#e8b800', color: '#111', border: 'none',
              borderRadius: 6, padding: '10px 0', fontWeight: 700, fontSize: 14, cursor: statsLoading ? 'default' : 'pointer', marginBottom: 10,
            }}>
            {statsLoading ? '集計中...' : '集計する'}
          </button>

          {statsResult && (
            <div>
              {statsResult.trifecta.usedRaces === 0 ? (
                <div style={{ fontSize: 12, color: '#8ba3bd', marginBottom: 12 }}>結果が入力されたレースがまだありません。レース保存後、結果欄に着順を「1-2-3」のように3着まで入力してください。</div>
              ) : (
                <div style={{ background: '#131f2e', border: '1px solid #e8b800', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: '#8ba3bd', marginBottom: 8 }}>
                    3着まで結果入力済みの{statsResult.trifecta.usedRaces}件で集計
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ fontSize: 13 }}>◎○▲ストレート的中率(3連単)</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: '#e8b800' }}>{statsResult.trifecta.straightRate}%</div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: statsResult.trifecta.betsRaces > 0 ? 6 : 0 }}>
                    <div style={{ fontSize: 13 }}>◎○▲ボックス的中率(3連複相当)</div>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{statsResult.trifecta.boxRate}%</div>
                  </div>
                  {statsResult.trifecta.betsRaces > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <div style={{ fontSize: 13 }}>実際のおすすめ買い目の的中率({statsResult.trifecta.betsRaces}件)</div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#7aff9b' }}>{statsResult.trifecta.betsHitRate}%</div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ fontSize: 11, color: '#8ba3bd', marginBottom: 6 }}>
                参考: 印別の単勝/連対/複勝(3連単の的中率とは別指標。全{statsResult.mark.totalRaces}件中{statsResult.mark.usedRaces}件を集計)
              </div>
              <div style={{ background: '#131f2e', border: '1px solid #2a3d52', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ display: 'flex', padding: '8px 12px', background: '#0f1a28', fontSize: 11, color: '#8ba3bd', fontWeight: 700 }}>
                  <div style={{ width: 40 }}>印</div>
                  <div style={{ width: 50 }}>件数</div>
                  <div style={{ flex: 1 }}>単勝率</div>
                  <div style={{ flex: 1 }}>連対率</div>
                  <div style={{ flex: 1 }}>複勝率</div>
                </div>
                {statsResult.mark.summary.map(s => (
                  <div key={s.mark} style={{ display: 'flex', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid #1c2b3d', fontSize: 13 }}>
                    <div style={{ width: 40, fontWeight: 700, color: '#e8b800' }}>{s.mark}</div>
                    <div style={{ width: 50, color: '#8ba3bd', fontSize: 12 }}>{s.n}</div>
                    <div style={{ flex: 1 }}>{s.winRate != null ? `${s.winRate}%` : '-'}</div>
                    <div style={{ flex: 1 }}>{s.top2Rate != null ? `${s.top2Rate}%` : '-'}</div>
                    <div style={{ flex: 1 }}>{s.top3Rate != null ? `${s.top3Rate}%` : '-'}</div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11, color: '#8ba3bd', margin: '14px 0 6px' }}>
                会場別の内訳(コース優位が会場ごとに違う可能性を検証。実測1着率は印を使わず進入コースと結果だけから算出)
              </div>
              {statsResult.byVenue.map(v => (
                <div key={v.venue} style={{ background: '#131f2e', border: '1px solid #2a3d52', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{v.venue}({v.raceCount}件)</div>
                    <div style={{ fontSize: 12, color: '#8ba3bd' }}>
                      3連単: {v.trifecta.straightRate != null ? `${v.trifecta.straightRate}%` : '-'} / ボックス: {v.trifecta.boxRate != null ? `${v.trifecta.boxRate}%` : '-'}
                    </div>
                  </div>
                  {v.courseRaces > 0 ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {v.courseWinRate.map(c => (
                        <div key={c.course} style={{ fontSize: 11, color: '#c5d3e0', background: '#0f1a28', borderRadius: 4, padding: '3px 8px' }}>
                          {c.course}コース {c.winRate != null ? `${c.winRate}%` : '-'}
                        </div>
                      ))}
                      <div style={{ fontSize: 10, color: '#8ba3bd', width: '100%', marginTop: 2 }}>
                        (全国平均イメージ: 1コース約55%・2コース約14%・3コース約12%が現在のCOURSE_BASE設定値)
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: '#8ba3bd' }}>進入コース情報付きの結果がまだありません</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Race history */}
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{venue} 保存済みレース ({races.length}件)</div>
          {loading && <div style={{ fontSize: 12, color: '#8ba3bd' }}>読み込み中...</div>}
          {!loading && races.length === 0 && <div style={{ fontSize: 12, color: '#8ba3bd' }}>まだ保存されたレースはありません</div>}
          {races.map(r => (
            <div key={r.id} style={{ background: '#131f2e', border: '1px solid #2a3d52', borderRadius: 8, padding: 10, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <div style={{ fontSize: 12, color: '#8ba3bd' }}>{r.date} {r.raceNo && `${r.raceNo}R`}</div>
                <button onClick={() => handleDeleteRace(r.id)} style={{ background: 'none', border: 'none', color: '#ff6b6b', fontSize: 11, cursor: 'pointer' }}>削除</button>
              </div>
              <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                {r.boats.map(b => (
                  <div key={b.lane} style={{
                    display: 'flex', alignItems: 'center', gap: 3, background: LANE_COLORS[b.lane].bg, color: LANE_COLORS[b.lane].text,
                    borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 700,
                  }}>{b.lane}{b.mark}</div>
                ))}
              </div>
              {r.note && <div style={{ fontSize: 12, color: '#8ba3bd', marginBottom: 6 }}>メモ: {r.note}</div>}
              <input placeholder="結果(例: 1-3-2)" value={r.result} onChange={e => handleResultChange(r.id, e.target.value)}
                style={{ width: '100%', background: '#0f1a28', color: '#e8edf2', border: '1px solid #2a3d52', borderRadius: 6, padding: '6px 8px', fontSize: 12, boxSizing: 'border-box' }} />
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}

