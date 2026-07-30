const ALLOWED_ORIGIN = "https://iidasenpai.github.io";

// 1回の画面操作につき、WorkerからGeminiへ送るのは最大2回だけ。
// 長い3連続試行はブラウザ側タイムアウトとレート制限を誘発するため廃止。
const GEMINI_ATTEMPT_PLAN = [
  { model: "gemini-2.5-flash", waitBeforeMs: 0 },
  { model: "gemini-2.5-flash-lite", waitBeforeMs: 3000 },
];
const GEMINI_TIMEOUT_MS = 45000;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 1200);
}

function isDemandError(status, message = "") {
  const text = String(message).toLowerCase();
  return status === 429 || status === 503 ||
    text.includes("high demand") ||
    text.includes("overloaded") ||
    text.includes("resource exhausted") ||
    text.includes("temporarily unavailable") ||
    text.includes("unavailable");
}

function extractJsonText(text) {
  const raw = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  if (!raw) return "";
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  return first >= 0 && last > first ? raw.slice(first, last + 1) : raw;
}

async function callGeminiWithRetry(env, payload) {
  let lastStatus = 502;
  let lastMessage = "AIサーバーから応答を受け取れませんでした。";
  const history = [];

  for (let index = 0; index < GEMINI_ATTEMPT_PLAN.length; index += 1) {
    const { model, waitBeforeMs } = GEMINI_ATTEMPT_PLAN[index];
    if (waitBeforeMs > 0) await sleep(jitter(waitBeforeMs));

    const attempt = index + 1;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        }
      );

      let result = {};
      try { result = await response.json(); } catch { result = {}; }
      if (response.ok) {
        return { response, result, attempts: attempt, model, history };
      }

      lastStatus = response.status;
      lastMessage = result?.error?.message || `Gemini APIエラー (${response.status})`;
      history.push({
        model,
        attempt,
        status: response.status,
        message: String(lastMessage).slice(0, 240),
      });

      // 404はモデル名・API仕様の問題なので連打しない。
      const retryable = RETRYABLE_STATUS.has(response.status) ||
        isDemandError(response.status, lastMessage);
      if (!retryable) break;
    } catch (error) {
      lastStatus = error?.name === "AbortError" ? 504 : 502;
      lastMessage = error?.name === "AbortError"
        ? "AIサーバーの応答がタイムアウトしました。"
        : (error instanceof Error ? error.message : String(error));
      history.push({
        model,
        attempt,
        status: lastStatus,
        message: String(lastMessage).slice(0, 240),
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const demand = isDemandError(lastStatus, lastMessage);
  const err = new Error(lastMessage);
  err.status = demand ? 503 : lastStatus;
  err.retryable = demand || RETRYABLE_STATUS.has(lastStatus);
  err.errorCode = demand
    ? "GEMINI_BUSY"
    : lastStatus === 401 || lastStatus === 403
      ? "GEMINI_AUTH"
      : lastStatus === 404
        ? "GEMINI_MODEL"
        : lastStatus === 504
          ? "GEMINI_TIMEOUT"
          : "GEMINI_REQUEST";
  err.userMessage = demand
    ? "Gemini APIが混雑または利用上限に達しています。画像は保持されています。"
    : lastStatus === 401 || lastStatus === 403
      ? "Gemini APIの認証に失敗しました。CloudflareのGEMINI_API_KEY設定を確認してください。"
      : lastStatus === 404
        ? "指定したGeminiモデルを利用できません。Workerのモデル設定を確認してください。"
        : lastStatus === 504
          ? "Gemini APIの応答がタイムアウトしました。画像は保持されています。"
          : "Gemini APIへの画像解析リクエストに失敗しました。画像は保持されています。";
  err.history = history;
  throw err;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "POSTリクエストのみ対応しています。" }, 405);
    }

    if (!env.GEMINI_API_KEY) {
      return json({ error: "GEMINI_API_KEYが設定されていません。" }, 500);
    }

    try {
      const body = await request.json();
      const images = body?.images;

      if (!Array.isArray(images) || images.length === 0) {
        return json({ error: "画像が送信されていません。" }, 400);
      }

      if (images.length > 6) {
        return json({ error: "画像は最大6枚です。" }, 400);
      }

      const imageParts = images.map((image, index) => {
        if (
          typeof image?.data !== "string" ||
          typeof image?.mimeType !== "string"
        ) {
          throw new Error(`${index + 1}枚目の画像形式が正しくありません。`);
        }

        return {
          inline_data: {
            mime_type: image.mimeType,
            data: image.data,
          },
        };
      });

      const prompt = `
あなたは競艇データ画像の読み取りアシスタントです。
添付された最大6枚のスクリーンショットから、画像に書かれた情報だけを正確に抽出してください。

想定画像:
1. 出走表・選手基本情報
2. 全国勝率・当地勝率・モーター・ボート
3. 今節成績
4. 直前情報・体重・チルト・部品交換
5. 展示情報・進入・展示ST・展示タイム・風
6. オッズ情報・レース結果・払戻金

次のJSON形式だけで返してください。Markdownや説明文は禁止です。
読めない値は空文字、null、空配列にし、推測で補完しないでください。

{
  "venue": "",
  "raceNumber": "",
  "date": "",
  "weather": {
  "condition": "天候",
  "temp": null,
  "windDirection": "風向",
  "windSpeed": null,
  "waterTemp": null,
  "waveHeight": null
},
"odds": {},
"raceResult": {
  "detected": false,
  "venue": "",
  "raceNumber": "",
  "date": "",
  "trifecta": "",
  "payoutYen": null
},
"positionReturns": {
  "first": {},
  "second": {},
  "third": {}
},
"boats": [
    {
      "lane": 1,
      "name": "",
      "registrationNumber": "",
      "class": "",
      "age": null,
      "weight": null,
      "nationalWinRate": null,
      "localWinRate": null,
      "motorRate": null,
      "boatRate": null,
      "exhibitionTime": null,
      "exhibitionST": null,
      "entryCourse": null,
      "tilt": null,
      "partsReplacement": "",
      "currentSeriesResults": [
        { "raceNo": null, "course": null, "st": null, "finish": null }
      ],
      "currentSeriesAverageST": null,
      "odds": {},
      "notes": []
    }
  ],
  "warnings": []
}

天気・気象情報が画像内にある場合は、トップレベルのweatherへ必ず格納してください。
気温はtemp、風向はwindDirection、風速はwindSpeed、水温はwaterTemp、波高はwaveHeightです。
単位記号（℃、m、cm）は付けず数値型で返してください。読めない項目だけnullにしてください。
「展示情報」や「直前情報」画面の上部・下部に小さく表示される場合も見落とさないでください。

オッズ画像に3連単オッズがある場合は、トップレベルのoddsへ格納してください。
キーは必ず「1-2-3」のような半角数字とハイフンにしてください。
値は倍率の数値だけにしてください。
例:
"odds": {
  "1-2-3": 12.4,
  "1-3-2": 18.6,
  "2-1-3": 35.2
}
読み取れない組み合わせは追加しないでください。
回収率分析の画像がある場合は、各艇の着順固定回収率を
トップレベルのpositionReturnsへ格納してください。

firstは1着固定、secondは2着固定、thirdは3着固定です。
キーは艇番を文字列で指定し、値は%を除いた数値にしてください。

例:
"positionReturns": {
  "first": {
    "1": 58.5,
    "2": 0,
    "3": 137.3,
    "4": 168.9,
    "5": 85.7,
    "6": 0
  },
  "second": {
    "1": 105.1,
    "2": 53.6,
    "3": 82.3,
    "4": 222.4,
    "5": 15.6,
    "6": 215.8
  },
  "third": {
    "1": 3.1,
    "2": 119.7,
    "3": 61.8,
    "4": 24.9,
    "5": 30.3,
    "6": 17.4
  }
}

画像に回収率分析がない場合は、
"positionReturns": {
  "first": {},
  "second": {},
  "third": {}
}
としてください。

回収率の数字を勝率やオッズとして扱わないでください。


レース結果画面が含まれる場合は、トップレベルのraceResultへ格納してください。
3連単の確定着順はtrifectaへ「1-3-5」の形式で、3連単払戻金はpayoutYenへ円単位の数値で返してください。
会場・レース番号・日付も読める範囲で格納してください。結果画面がない場合はdetectedをfalseにしてください。
結果画像では「人気」「オッズ」「払戻」を着順と混同しないでください。

boatsは1号艇から6号艇の順に整理してください。

今節成績はcurrentSeriesResultsへ、各走ごとにraceNo・course・st・finishを数値で格納してください。
着順が画像で読めない場合だけfinishをnullにしてください。STは「.12」を0.12として返してください。
今節のSTが1走以上読めた場合は、その平均をcurrentSeriesAverageSTにも数値で返してください。
展示タイムと展示STを混同しないでください。展示タイムは通常6.xx、展示STは通常0.xxです。
同タイムや最下位の艇も値を省略せず、画像にある実数をそのまま返してください。
`;

      const { result, attempts, model, history } = await callGeminiWithRetry(env, {
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }, ...imageParts],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      });

      const text = result?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .trim();

      if (!text) {
        return json({ error: "AIから解析結果が返りませんでした。" }, 502);
      }

      let parsed;
      const jsonText = extractJsonText(text);
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        return json({
          error: "AIの回答をJSONとして読み取れませんでした。",
          details: "回答形式を復旧できませんでした。画像は保持されています。",
          retryable: true,
        }, 502);
      }

      return json({ success: true, data: parsed, attempts, model, fallbackHistory: history });
    } catch (error) {
      const status = Number(error?.status) || 500;
      return json(
        {
          error: error?.userMessage || "Workerでエラーが発生しました。",
          details: error instanceof Error ? error.message : String(error),
          retryable: Boolean(error?.retryable),
          errorCode: error?.errorCode || "WORKER_ERROR",
          upstreamStatus: Number(error?.status) || status,
          fallbackHistory: error?.history || [],
        },
        status
      );
    }
  },
};

