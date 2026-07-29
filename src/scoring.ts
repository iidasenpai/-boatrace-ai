// src/scoring.ts
// 競艇AI予想エンジン Ver.2
// BoatRaceTool.tsx から computeScores を分離した互換版です。

export type WeatherInfo = {
  temp?: string | number | null;
  wind?: string | number | null;
  waterTemp?: string | number | null;
  wave?: string | number | null;
  windDirection?: string | null;
};

export type KonsetsuEntry = {
  raceNo?: number | null;
  course?: number | null;
  st?: number | null;
  finish?: number | null;
};

export type BoatInput = {
  lane: number;
  entryCourse?: number | null;
  classG?: string | null;

  natWin?: number | null;
  nat2?: number | null;
  nat3?: number | null;
  locWin?: number | null;
  loc2?: number | null;
  loc3?: number | null;

  motor2?: number | null;
  motor3?: number | null;
  boat2?: number | null;
  boat3?: number | null;

  avgST?: number | null;
  exTime?: number | null;
  exST?: number | null;
  tilt?: number | null;

  fCount?: number | null;
  lCount?: number | null;
  exhibitF?: boolean;
  partsExchanged?: boolean;

  konsetsu?: KonsetsuEntry[];
  konsetsuAvgST?: number | null;

  [key: string]: unknown;
};

export type ScoredBoat = BoatInput & {
  playerScore: number;
  gearScore: number;
  exScore: number;
  stScore: number;
  courseScore: number;
  classScore: number;
  weatherScore: number;

  fPenalty: number;
  startRiskPenalty: number;
  cleanStartBonus: number;
  outerAceBonus: number;
  outerGearBonus: number;
  isOuterGearAce: boolean;
  tiltBonus: number;
  partsPenalty: number;
  konsetsuScore: number | null;
  konsetsuBonus: number;
  konsetsuAvgFinish: number | null;

  total: number;
  rawTotal: number;
  winShare: number;
  confidence: number;
  dangerScore: number;
  dangerReasons: string[];
  targetScore: number;
  targetReasons: string[];

  isChaosRace: boolean;
  isOuterAce: boolean;
  isRoughWater: boolean;
  roughIndex: number;
  raceConfidence: number;
  raceConfidenceLabel: string;
  chaosIndex: number;
  chaosStars: number;

  mark: string;
  rank: number;
};

type CourseRates = Record<1 | 2 | 3 | 4 | 5 | 6, number>;

const DEFAULT_COURSE_RATES: CourseRates = {
  1: 0.55, 2: 0.14, 3: 0.12, 4: 0.10, 5: 0.06, 6: 0.03,
};

/**
 * 会場別の初期コース補正。
 * 厳密な公式統計ではなく、保存レースが少ない段階で使う事前分布です。
 * 学習機能を追加した際は、実測値とブレンドして更新してください。
 */
export const VENUE_COURSE_RATES: Record<string, CourseRates> = {
  桐生:   { 1: 0.50, 2: 0.16, 3: 0.13, 4: 0.10, 5: 0.07, 6: 0.04 },
  戸田:   { 1: 0.44, 2: 0.18, 3: 0.15, 4: 0.12, 5: 0.07, 6: 0.04 },
  江戸川: { 1: 0.46, 2: 0.17, 3: 0.14, 4: 0.11, 5: 0.08, 6: 0.04 },
  平和島: { 1: 0.49, 2: 0.17, 3: 0.13, 4: 0.11, 5: 0.07, 6: 0.03 },
  多摩川: { 1: 0.54, 2: 0.15, 3: 0.12, 4: 0.10, 5: 0.06, 6: 0.03 },
  浜名湖: { 1: 0.52, 2: 0.16, 3: 0.13, 4: 0.10, 5: 0.06, 6: 0.03 },
  蒲郡:   { 1: 0.56, 2: 0.14, 3: 0.12, 4: 0.09, 5: 0.06, 6: 0.03 },
  常滑:   { 1: 0.57, 2: 0.14, 3: 0.11, 4: 0.09, 5: 0.06, 6: 0.03 },
  津:     { 1: 0.58, 2: 0.14, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.03 },
  三国:   { 1: 0.55, 2: 0.15, 3: 0.12, 4: 0.10, 5: 0.05, 6: 0.03 },
  びわこ: { 1: 0.50, 2: 0.17, 3: 0.13, 4: 0.11, 5: 0.06, 6: 0.03 },
  住之江: { 1: 0.58, 2: 0.14, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.03 },
  尼崎:   { 1: 0.58, 2: 0.14, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.03 },
  鳴門:   { 1: 0.52, 2: 0.16, 3: 0.13, 4: 0.10, 5: 0.06, 6: 0.03 },
  丸亀:   { 1: 0.57, 2: 0.14, 3: 0.11, 4: 0.09, 5: 0.06, 6: 0.03 },
  児島:   { 1: 0.56, 2: 0.15, 3: 0.11, 4: 0.09, 5: 0.06, 6: 0.03 },
  宮島:   { 1: 0.56, 2: 0.15, 3: 0.11, 4: 0.09, 5: 0.06, 6: 0.03 },
  徳山:   { 1: 0.62, 2: 0.13, 3: 0.10, 4: 0.07, 5: 0.05, 6: 0.03 },
  下関:   { 1: 0.59, 2: 0.14, 3: 0.10, 4: 0.08, 5: 0.06, 6: 0.03 },
  若松:   { 1: 0.56, 2: 0.15, 3: 0.11, 4: 0.09, 5: 0.06, 6: 0.03 },
  芦屋:   { 1: 0.63, 2: 0.12, 3: 0.09, 4: 0.07, 5: 0.06, 6: 0.03 },
  福岡:   { 1: 0.50, 2: 0.17, 3: 0.14, 4: 0.10, 5: 0.06, 6: 0.03 },
  唐津:   { 1: 0.58, 2: 0.14, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.03 },
  大村:   { 1: 0.64, 2: 0.12, 3: 0.09, 4: 0.07, 5: 0.05, 6: 0.03 },
};

const CLASS_BASE: Record<string, number> = {
  A1: 100,
  A2: 68,
  B1: 36,
  B2: 12,
};

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function norm(
  value: number | null | undefined,
  values: Array<number | null | undefined>,
  invert = false,
): number {
  const v = finiteNumber(value);
  const clean = values
    .map(finiteNumber)
    .filter((x): x is number => x != null);

  if (v == null || clean.length < 2) return 50;

  const sorted = [...clean].sort((a, b) => a - b);
  const low = sorted[Math.floor((sorted.length - 1) * 0.1)];
  const high = sorted[Math.ceil((sorted.length - 1) * 0.9)];

  if (high === low) return 50;

  const percentile = clamp(((v - low) / (high - low)) * 100, 0, 100);
  const oriented = invert ? 100 - percentile : percentile;
  // 1レース6艇の相対比較で0/100が乱発しないよう、実用域へ平滑化する。
  return 12 + oriented * 0.76;
}

function weightedAverage(parts: Array<[number, number]>): number {
  let weighted = 0;
  let weightSum = 0;
  for (const [value, weight] of parts) {
    if (!Number.isFinite(value) || weight <= 0) continue;
    weighted += value * weight;
    weightSum += weight;
  }
  return weightSum ? weighted / weightSum : 50;
}

function average(values: Array<number | null | undefined>): number | null {
  const clean = values.map(finiteNumber).filter((v): v is number => v != null);
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : null;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function getCourseRates(venue?: string): CourseRates {
  return VENUE_COURSE_RATES[venue || ''] || DEFAULT_COURSE_RATES;
}

function getAverageFinish(boat: BoatInput): number | null {
  const finishes = (boat.konsetsu || [])
    .map(entry => finiteNumber(entry.finish))
    .filter((v): v is number => v != null && v >= 1 && v <= 6);
  return finishes.length ? finishes.reduce((a, b) => a + b, 0) / finishes.length : null;
}

function calculateRoughIndex(weather?: WeatherInfo | null): number {
  const wind = finiteNumber(weather?.wind) ?? 0;
  const wave = finiteNumber(weather?.wave) ?? 0;

  const windPart = clamp((wind - 2) * 8, 0, 50);
  const wavePart = clamp((wave - 1) * 12, 0, 40);
  return clamp(windPart + wavePart, 0, 100);
}

function raceConfidenceLabel(value: number): string {
  if (value >= 82) return 'かなり高い';
  if (value >= 70) return '高い';
  if (value >= 58) return '標準';
  if (value >= 45) return '低め';
  return '見送り候補';
}

function softmax(values: number[], temperature = 10): number[] {
  if (!values.length) return [];
  const max = Math.max(...values);
  const exps = values.map(v => Math.exp((v - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map(v => v / sum);
}

function calculateDanger(
  boat: BoatInput,
  context: {
    gearScore: number;
    exScore: number;
    stScore: number;
    courseScore: number;
    classScore: number;
    roughIndex: number;
  },
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const course = finiteNumber(boat.entryCourse) ?? boat.lane;

  if (boat.exhibitF) {
    score += course === 1 ? 16 : 24;
    reasons.push('展示F');
  }
  if ((finiteNumber(boat.fCount) ?? 0) > 0) {
    score += 7;
    reasons.push('F持ち');
  }
  if (context.stScore < 25) {
    score += 13;
    reasons.push('展示STが遅い');
  }
  if (context.exScore < 25) {
    score += 11;
    reasons.push('展示タイム下位');
  }
  if (context.gearScore < 25) {
    score += 10;
    reasons.push('機力下位');
  }
  if (boat.partsExchanged) {
    score += 5;
    reasons.push('部品交換後');
  }
  if (course === 1 && context.classScore < 40) {
    score += 8;
    reasons.push('インの級別不安');
  }
  if (course === 1 && context.roughIndex >= 55) {
    score += 8;
    reasons.push('荒水面のイン');
  }

  return { score: clamp(round1(score), 0, 100), reasons };
}

function calculateTarget(
  boat: BoatInput,
  context: {
    gearScore: number;
    exScore: number;
    stScore: number;
    classScore: number;
    isOuterGearAce: boolean;
    isOuterAce: boolean;
  },
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const course = finiteNumber(boat.entryCourse) ?? boat.lane;

  if (context.gearScore >= 75) {
    score += 25;
    reasons.push('機力上位');
  }
  if (context.exScore >= 75) {
    score += 20;
    reasons.push('展示タイム上位');
  }
  if (context.stScore >= 75) {
    score += 18;
    reasons.push('展示ST上位');
  }
  if (context.isOuterGearAce) {
    score += 18;
    reasons.push('外枠機力エース');
  }
  if (context.isOuterAce) {
    score += 15;
    reasons.push('外枠A1');
  }
  if (course >= 3 && context.gearScore >= 65 && context.stScore >= 60) {
    score += 12;
    reasons.push('攻め条件が揃う');
  }
  if ((finiteNumber(boat.tilt) ?? 0) > 0 && course >= 4) {
    score += 10;
    reasons.push('伸び型チルト');
  }

  return { score: clamp(round1(score), 0, 100), reasons };
}

export function computeScores(
  boats: BoatInput[],
  venueOrWeather?: string | WeatherInfo | null,
  maybeWeather?: WeatherInfo | null,
): ScoredBoat[] {
  // 旧呼び出し computeScores(boats, weather) と
  // 新呼び出し computeScores(boats, venue, weather) の両方に対応。
  const venue = typeof venueOrWeather === 'string' ? venueOrWeather : '';
  const weather =
    typeof venueOrWeather === 'string'
      ? maybeWeather
      : (venueOrWeather as WeatherInfo | null | undefined);

  if (!Array.isArray(boats) || boats.length === 0) return [];

  const courseRates = getCourseRates(venue);

  const natWinArr = boats.map(b => finiteNumber(b.natWin));
  const nat2Arr = boats.map(b => finiteNumber(b.nat2));
  const locWinArr = boats.map(b => finiteNumber(b.locWin));
  const loc2Arr = boats.map(b => finiteNumber(b.loc2));
  const motor2Arr = boats.map(b => finiteNumber(b.motor2));
  const motor3Arr = boats.map(b => finiteNumber(b.motor3));
  const boat2Arr = boats.map(b => finiteNumber(b.boat2));
  const boat3Arr = boats.map(b => finiteNumber(b.boat3));
  const exTimeArr = boats.map(b => finiteNumber(b.exTime));
  const exSTArr = boats.map(b => finiteNumber(b.exST));
  const avgSTArr = boats.map(b => finiteNumber(b.avgST));
  const konsetsuSTArr = boats.map(b => finiteNumber(b.konsetsuAvgST));
  const finishArr = boats.map(getAverageFinish);

  const roughIndex = calculateRoughIndex(weather);
  const isRoughWater = roughIndex >= 45;

  const exhibitFCount = boats.filter(b => b.exhibitF).length;
  const fHoldCount = boats.filter(b => (finiteNumber(b.fCount) ?? 0) > 0).length;
  const isChaosRace = exhibitFCount >= 3 || roughIndex >= 70;

  const a1Boats = boats.filter(b => b.classG === 'A1');

  const baseGearScores = boats.map(b =>
    weightedAverage([
      [norm(b.motor2, motor2Arr), 0.45],
      [norm(b.motor3, motor3Arr), 0.20],
      [norm(b.boat2, boat2Arr), 0.25],
      [norm(b.boat3, boat3Arr), 0.10],
    ]),
  );

  const gearSorted = [...baseGearScores].sort((a, b) => b - a);
  const topGear = gearSorted[0] ?? 50;
  const secondGear = gearSorted[1] ?? 50;

  const baseRows = boats.map((boat, index) => {
    const entryCourse = clamp(
      Math.round(finiteNumber(boat.entryCourse) ?? boat.lane),
      1,
      6,
    ) as 1 | 2 | 3 | 4 | 5 | 6;

    const playerScore = weightedAverage([
      [norm(boat.natWin, natWinArr), 0.25],
      [norm(boat.nat2, nat2Arr), 0.30],
      [norm(boat.locWin, locWinArr), 0.20],
      [norm(boat.loc2, loc2Arr), 0.25],
    ]);

    let gearScore = baseGearScores[index];
    if (boat.partsExchanged) gearScore -= 3;
    gearScore = clamp(gearScore, 0, 100);

    const exScore = norm(boat.exTime, exTimeArr, true);

    const actualSTScore = norm(boat.exST, exSTArr, true);
    const normalSTScore = norm(boat.avgST, avgSTArr, true);
    const currentSTScore = norm(boat.konsetsuAvgST, konsetsuSTArr, true);
    const stScore = weightedAverage([
      [actualSTScore, 0.55],
      [normalSTScore, 0.25],
      [currentSTScore, 0.20],
    ]);

    const courseScore = courseRates[entryCourse] * 100;
    const classScore = CLASS_BASE[boat.classG || ''] ?? 30;

    const avgFinish = finishArr[index];
    let konsetsuScore: number | null = null;
    let konsetsuBonus = 0;
    if (avgFinish != null) {
      konsetsuScore = norm(avgFinish, finishArr, true);
      konsetsuBonus = (konsetsuScore - 50) * 0.14;
    } else if (finiteNumber(boat.konsetsuAvgST) != null) {
      konsetsuScore = currentSTScore;
      konsetsuBonus = (currentSTScore - 50) * 0.05;
    }

    const isOuterAce =
      boat.classG === 'A1' &&
      entryCourse >= 4 &&
      a1Boats.length === 1;

    const isOuterGearAce =
      entryCourse >= 4 &&
      Math.abs(gearScore - topGear) < 0.0001 &&
      gearScore >= 62 &&
      topGear - secondGear >= 7;

    let fPenalty = 0;
    if (boat.exhibitF) {
      fPenalty = entryCourse === 1 ? 7 : 16;
      if (gearScore >= 70) fPenalty *= 0.7;
      fPenalty *= Math.max(0.5, 1 - exhibitFCount * 0.09);
    }

    let startRiskPenalty = 0;
    const fCount = finiteNumber(boat.fCount) ?? 0;
    if (fCount > 0) startRiskPenalty += Math.min(8, fCount * 4);
    if (stScore < 20) startRiskPenalty += 4;

    const cleanStartBonus =
      isChaosRace && !boat.exhibitF && stScore >= 55 ? 7 : 0;

    const outerAceBonus = isOuterAce ? 7 : 0;
    const outerGearBonus = isOuterGearAce ? 8 : 0;

    let tiltBonus = 0;
    const tilt = finiteNumber(boat.tilt);
    if (tilt != null) {
      if (entryCourse === 1 && tilt < 0) tiltBonus = 4;
      if (entryCourse >= 4 && tilt > 0) tiltBonus = 5;
      if (entryCourse >= 5 && tilt >= 0.5) tiltBonus += 2;
    }

    const partsPenalty = boat.partsExchanged ? 2 : 0;

    let weatherScore = 50;
    if (isRoughWater) {
      weatherScore = weightedAverage([
        [playerScore, 0.40],
        [gearScore, 0.40],
        [stScore, 0.20],
      ]);
    }

    const courseWeight = isRoughWater ? 0.15 : 0.24;
    const playerWeight = isRoughWater ? 0.27 : 0.23;
    const gearWeight = isRoughWater ? 0.25 : 0.22;
    const exWeight = 0.11;
    const stWeight = isRoughWater ? 0.12 : 0.10;
    const classWeight = 0.10;
    const weatherWeight = isRoughWater ? 0.05 : 0;

    const rawTotal =
      playerScore * playerWeight +
      gearScore * gearWeight +
      courseScore * courseWeight +
      exScore * exWeight +
      stScore * stWeight +
      classScore * classWeight +
      weatherScore * weatherWeight +
      konsetsuBonus +
      cleanStartBonus +
      outerAceBonus +
      outerGearBonus +
      tiltBonus -
      fPenalty -
      startRiskPenalty -
      partsPenalty;

    const danger = calculateDanger(boat, {
      gearScore,
      exScore,
      stScore,
      courseScore,
      classScore,
      roughIndex,
    });

    const target = calculateTarget(boat, {
      gearScore,
      exScore,
      stScore,
      classScore,
      isOuterGearAce,
      isOuterAce,
    });

    return {
      ...boat,
      entryCourse,
      playerScore: round1(playerScore),
      gearScore: round1(gearScore),
      exScore: round1(exScore),
      stScore: round1(stScore),
      courseScore: round1(courseScore),
      classScore: round1(classScore),
      weatherScore: round1(weatherScore),
      fPenalty: round1(fPenalty),
      startRiskPenalty: round1(startRiskPenalty),
      cleanStartBonus: round1(cleanStartBonus),
      outerAceBonus: round1(outerAceBonus),
      outerGearBonus: round1(outerGearBonus),
      isOuterGearAce,
      tiltBonus: round1(tiltBonus),
      partsPenalty: round1(partsPenalty),
      konsetsuScore: konsetsuScore == null ? null : round1(konsetsuScore),
      konsetsuBonus: round1(konsetsuBonus),
      konsetsuAvgFinish: avgFinish,
      rawTotal,
      dangerScore: danger.score,
      dangerReasons: danger.reasons,
      targetScore: target.score,
      targetReasons: target.reasons,
      isChaosRace,
      isOuterAce,
      isRoughWater,
      roughIndex: round1(roughIndex),
    };
  });

  const rawValues = baseRows.map(b => b.rawTotal);
  const shares = softmax(rawValues, isChaosRace ? 13 : 10);
  const sortedRaw = [...rawValues].sort((a, b) => b - a);
  const topGap = (sortedRaw[0] ?? 0) - (sortedRaw[1] ?? 0);
  const scoreSpread = standardDeviation(rawValues);

  const missingFields = boats.reduce((sum, b) => {
    const values = [b.nat2, b.loc2, b.motor2, b.boat2, b.exTime, b.exST];
    return sum + values.filter(v => finiteNumber(v) == null).length;
  }, 0);
  const completeness = 1 - missingFields / Math.max(1, boats.length * 6);

  let raceConfidence =
    46 +
    clamp(topGap * 3.2, 0, 24) +
    clamp(scoreSpread * 1.3, 0, 14) +
    completeness * 15 -
    roughIndex * 0.13 -
    exhibitFCount * 3.5 -
    fHoldCount * 1.2;

  raceConfidence = clamp(round1(raceConfidence), 20, 95);

  let chaosIndex =
    roughIndex * 0.45 +
    exhibitFCount * 12 +
    fHoldCount * 4 +
    clamp(12 - topGap * 2, 0, 12) +
    clamp(8 - scoreSpread, 0, 8);

  chaosIndex = clamp(round1(chaosIndex), 0, 100);
  const chaosStars = clamp(Math.ceil(chaosIndex / 20), 1, 5);

  const ranked = baseRows
    .map((boat, index) => ({
      ...boat,
      // rawTotalを保持しつつ微小な決定的タイブレークを加える。
      // 同点時はコース適性→展示→艇番の順で順位を確定する。
      total: round1(
        boat.rawTotal +
        boat.courseScore * 0.0008 +
        boat.exScore * 0.0004 +
        (7 - Number(boat.lane || 7)) * 0.0001
      ),
      winShare: round1(shares[index] * 100),
      confidence: clamp(
        round1(
          raceConfidence +
          (shares[index] * 100 - 16.7) * 0.8 -
          boat.dangerScore * 0.18,
        ),
        10,
        98,
      ),
      raceConfidence,
      raceConfidenceLabel: raceConfidenceLabel(raceConfidence),
      chaosIndex,
      chaosStars,
    }))
    .sort((a, b) =>
      b.total - a.total ||
      b.courseScore - a.courseScore ||
      b.exScore - a.exScore ||
      a.lane - b.lane
    );

  const marks = ['◎', '○', '▲', '△', '△', '△'];

  return ranked.map((boat, index) => ({
    ...boat,
    mark: marks[index],
    rank: index + 1,
  })) as ScoredBoat[];
}
