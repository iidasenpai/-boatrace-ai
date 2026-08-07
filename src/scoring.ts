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

export type AdaptiveWeights = {
  player?: number;
  gear?: number;
  course?: number;
  exhibition?: number;
  start?: number;
  class?: number;
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
  A2: 66,
  B1: 33,
  B2: 10,
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
  // 初期版そのまま: レース内の最小値=0、最大値=100の単純min-max正規化。
  const v = finiteNumber(value);
  const clean = values.map(finiteNumber).filter((x): x is number => x != null);
  if (v == null || clean.length === 0) return 50;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  if (max === min) return 50;
  const score = ((v - min) / (max - min)) * 100;
  return invert ? 100 - score : score;
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
  _adaptiveWeights?: AdaptiveWeights | null,
): ScoredBoat[] {
  // 初期版ロジック復元モード。
  // 会場別学習・自動ウェイト補正は「集計表示のみ」とし、予想本体には使わない。
  // 旧呼び出し computeScores(boats, weather) / computeScores(boats, venue, weather) の両方に対応。
  const weather = typeof venueOrWeather === 'string'
    ? maybeWeather
    : (venueOrWeather as WeatherInfo | null | undefined);
  if (!Array.isArray(boats) || boats.length === 0) return [];

  const nat2Arr = boats.map(b => finiteNumber(b.nat2));
  const loc2Arr = boats.map(b => finiteNumber(b.loc2));
  const motor2Arr = boats.map(b => finiteNumber(b.motor2));
  const boat2Arr = boats.map(b => finiteNumber(b.boat2));
  const exTimeArr = boats.map(b => finiteNumber(b.exTime));
  const exSTArr = boats.map(b => finiteNumber(b.exST));

  const exhibitFCount = boats.filter(b => b.exhibitF).length;
  const isChaosRace = exhibitFCount >= 4;
  const a1Boats = boats.filter(b => b.classG === 'A1');

  const windVal = finiteNumber(weather?.wind) ?? 0;
  const waveVal = finiteNumber(weather?.wave) ?? 0;
  const isRoughWater = windVal >= 5 || waveVal >= 3;
  const roughIndex = calculateRoughIndex(weather);

  // 初期版の固定ウェイトをそのまま復元。
  const courseW = isRoughWater ? 0.18 : 0.30;
  const playerW = isRoughWater ? 0.28 : 0.22;
  const gearW = isRoughWater ? 0.24 : 0.20;
  const exW = 0.15;
  const classW = 0.15;

  const rows = boats.map(boat => {
    const entryCourse = clamp(Math.round(finiteNumber(boat.entryCourse) ?? boat.lane), 1, 6) as 1|2|3|4|5|6;
    const playerScore = norm(boat.nat2, nat2Arr) * 0.5 + norm(boat.loc2, loc2Arr) * 0.5;
    const gearScore = norm(boat.motor2, motor2Arr) * 0.6 + norm(boat.boat2, boat2Arr) * 0.4;
    const exScore = norm(boat.exTime, exTimeArr, true);
    // 初期版では展示STは得点に入れない。UI表示・危険度表示のためだけに保持。
    const stScore = norm(boat.exST, exSTArr, true);
    const courseScore = (DEFAULT_COURSE_RATES[entryCourse] || 0.03) * 100;
    const classScore = CLASS_BASE[boat.classG || ''] ?? 30;

    let fPenalty = 0;
    if (boat.exhibitF) {
      fPenalty = entryCourse === 1 ? 5 : 15;
      if (gearScore >= 65) fPenalty *= 0.5;
      fPenalty *= Math.max(0.4, 1 - exhibitFCount / 10);
    }

    const cleanStartBonus = isChaosRace && !boat.exhibitF ? 12 : 0;
    const isOuterAce = boat.classG === 'A1' && entryCourse >= 4 && a1Boats.length === 1;
    const outerAceBonus = isOuterAce ? 8 : 0;

    let tiltBonus = 0;
    const tilt = finiteNumber(boat.tilt);
    if (tilt != null) {
      if (entryCourse === 1 && tilt < 0) tiltBonus = 6;
      else if (entryCourse >= 4 && tilt > 0) tiltBonus = 6;
    }
    const partsPenalty = boat.partsExchanged ? 2 : 0;

    const rawTotal =
      playerScore * playerW +
      gearScore * gearW +
      courseScore * courseW +
      exScore * exW +
      classScore * classW -
      fPenalty + cleanStartBonus + outerAceBonus + tiltBonus - partsPenalty;

    const danger = calculateDanger(boat, {
      gearScore, exScore, stScore, courseScore, classScore, roughIndex,
    });
    const target = calculateTarget(boat, {
      gearScore, exScore, stScore, classScore,
      isOuterGearAce: false,
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
      weatherScore: 50,
      fPenalty: round1(fPenalty),
      startRiskPenalty: 0,
      cleanStartBonus: round1(cleanStartBonus),
      outerAceBonus: round1(outerAceBonus),
      outerGearBonus: 0,
      isOuterGearAce: false,
      tiltBonus: round1(tiltBonus),
      partsPenalty: round1(partsPenalty),
      konsetsuScore: null,
      konsetsuBonus: 0,
      konsetsuAvgFinish: getAverageFinish(boat),
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

  const rawValues = rows.map(b => b.rawTotal);
  const shares = softmax(rawValues, 12);
  const sorted = [...rawValues].sort((a,b)=>b-a);
  const topGap = (sorted[0] ?? 0) - (sorted[1] ?? 0);
  const spread = standardDeviation(rawValues);
  const missingFields = boats.reduce((sum,b)=>sum + [b.nat2,b.loc2,b.motor2,b.boat2,b.exTime].filter(v=>finiteNumber(v)==null).length,0);
  const completeness = 1 - missingFields / Math.max(1, boats.length * 5);
  const raceConfidence = clamp(round1(48 + clamp(topGap*3.4,0,24) + clamp(spread*1.1,0,12) + completeness*14 - roughIndex*0.12 - exhibitFCount*2.5), 20, 95);
  const chaosIndex = clamp(round1(roughIndex*0.5 + exhibitFCount*10 + clamp(10-topGap*1.8,0,10)),0,100);
  const chaosStars = clamp(Math.ceil(chaosIndex/20),1,5);

  const ranked = rows.map((boat,index)=>({
    ...boat,
    total: round1(boat.rawTotal + boat.courseScore*0.0008 + boat.exScore*0.0004 + (7-Number(boat.lane||7))*0.0001),
    winShare: round1(shares[index]*100),
    confidence: clamp(round1(raceConfidence + (shares[index]*100-16.7)*0.7 - boat.dangerScore*0.15),10,98),
    raceConfidence,
    raceConfidenceLabel: raceConfidenceLabel(raceConfidence),
    chaosIndex,
    chaosStars,
  })).sort((a,b)=>b.total-a.total || b.courseScore-a.courseScore || b.exScore-a.exScore || a.lane-b.lane);

  const marks=['◎','○','▲','△','△','△'];
  return ranked.map((boat,index)=>({...boat, mark:marks[index], rank:index+1})) as ScoredBoat[];
}

