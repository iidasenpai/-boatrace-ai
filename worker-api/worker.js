const ALLOWED_ORIGIN = "https://iidasenpai.github.io";

// Geminiのモデル名は廃止・更新されるため固定しない。
// models.list で、このAPIキーから現在利用できて generateContent に対応する
// 画像対応のFlash系モデルを確認してから最大2回だけ呼び出す。
const GEMINI_TIMEOUT_MS = 60000;
const MODEL_LIST_TIMEOUT_MS = 12000;
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

let modelCache = { expiresAt: 0, models: [] };

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
    text.includes("quota") ||
    text.includes("rate limit") ||
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

function normalizeModelName(name) {
  return String(name || "").replace(/^models\//, "");
}

function rankModel(model) {
  const id = normalizeModelName(model?.name || model);
  let score = 0;
  if (/gemini-3\.6-flash$/i.test(id)) score += 1000;
  if (/gemini-3.*flash/i.test(id)) score += 800;
  if (/gemini-2\.5.*flash/i.test(id)) score += 600;
  if (/flash/i.test(id)) score += 300;
  if (/lite/i.test(id)) score -= 20;
  if (/preview/i.test(id)) score -= 10;
  if (/exp|experimental/i.test(id)) score -= 80;
  if (/deprecated|embedding|image-generation|tts|audio|live/i.test(id)) score -= 1000;
  return score;
}

async function listAvailableModels(env, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && modelCache.models.length && modelCache.expiresAt > now) {
    return { models: modelCache.models, source: "cache" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = result?.error?.message || `models.list error (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const models = (Array.isArray(result?.models) ? result.models : [])
      .filter((model) => {
        const methods = Array.isArray(model?.supportedGenerationMethods)
          ? model.supportedGenerationMethods
          : [];
        const id = normalizeModelName(model?.name);
        return methods.includes("generateContent") &&
          /gemini/i.test(id) &&
          /flash/i.test(id) &&
          !/embedding|image-generation|tts|audio|live/i.test(id);
      })
      .sort((a, b) => rankModel(b) - rankModel(a))
      .map((model) => normalizeModelName(model.name));

    if (!models.length) {
      const error = new Error("generateContent対応のFlashモデルが一覧にありません。");
      error.status = 404;
      throw error;
    }

    modelCache = { models, expiresAt: now + MODEL_CACHE_TTL_MS };
    return { models, source: "models.list" };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchGemini(env, model, payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    return { response, result };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGeminiWithRetry(env, payload) {
  let discovered;
  try {
    discovered = await listAvailableModels(env);
  } catch (error) {
    const status = Number(error?.status) || 502;
    const err = new Error(error instanceof Error ? error.message : String(error));
    err.status = status;
    err.retryable = RETRYABLE_STATUS.has(status) || isDemandError(status, err.message);
    err.errorCode = status === 401 || status === 403 ? "GEMINI_AUTH" : "GEMINI_MODEL_LIST";
    err.userMessage = status === 401 || status === 403
      ? "Gemini APIの認証に失敗しました。CloudflareのGEMINI_API_KEY設定を確認してください。"
      : "このAPIキーで利用可能なGeminiモデルを確認できませんでした。少し待って再試行してください。";
    err.history = [{ model: "models.list", attempt: 1, status, message: err.message.slice(0, 240) }];
    throw err;
  }

  // 1操作につき最大2モデル。過剰な再送を防ぐ。
  const attemptModels = discovered.models.slice(0, 2);
  let lastStatus = 502;
  let lastMessage = "AIサーバーから応答を受け取れませんでした。";
  const history = [];

  for (let index = 0; index < attemptModels.length; index += 1) {
    const model = attemptModels[index];
    if (index > 0) await sleep(jitter(5000));

    try {
      const { response, result } = await fetchGemini(env, model, payload);
      if (response.ok) {
        return {
          response,
          result,
          attempts: index + 1,
          model,
          history,
          availableModels: discovered.models,
          modelSource: discovered.source,
        };
      }

      lastStatus = response.status;
      lastMessage = result?.error?.message || `Gemini APIエラー (${response.status})`;
      history.push({
        model,
        attempt: index + 1,
        status: response.status,
        message: String(lastMessage).slice(0, 240),
      });

      // 一覧に載っていたモデルが404ならキャッシュを捨てる。
      if (response.status === 404) modelCache = { expiresAt: 0, models: [] };

      const retryable = RETRYABLE_STATUS.has(response.status) ||
        isDemandError(response.status, lastMessage) ||
        response.status === 404;
      if (!retryable) break;
    } catch (error) {
      lastStatus = error?.name === "AbortError" ? 504 : 502;
      lastMessage = error?.name === "AbortError"
        ? "AIサーバーの応答がタイムアウトしました。"
        : (error instanceof Error ? error.message : String(error));
      history.push({
        model,
        attempt: index + 1,
        status: lastStatus,
        message: String(lastMessage).slice(0, 240),
      });
    }
  }

  const demand = history.some((item) => isDemandError(item.status, item.message));
  const all404 = history.length > 0 && history.every((item) => item.status === 404);
  const err = new Error(lastMessage);
  err.status = demand ? 503 : lastStatus;
  err.retryable = demand || RETRYABLE_STATUS.has(lastStatus);
  err.errorCode = demand
    ? "GEMINI_BUSY"
    : lastStatus === 401 || lastStatus === 403
      ? "GEMINI_AUTH"
      : all404
        ? "GEMINI_MODEL"
        : lastStatus === 504
          ? "GEMINI_TIMEOUT"
          : "GEMINI_REQUEST";
  err.userMessage = demand
    ? "Gemini APIが混雑または利用上限に達しています。画像は保持されています。"
    : lastStatus === 401 || lastStatus === 403
      ? "Gemini APIの認証に失敗しました。CloudflareのGEMINI_API_KEY設定を確認してください。"
      : all404
        ? "利用可能モデル一覧は取得できましたが、画像解析モデルの呼び出しに失敗しました。"
        : lastStatus === 504
          ? "Gemini APIの応答がタイムアウトしました。画像は保持されています。"
          : "Gemini APIへの画像解析リクエストに失敗しました。画像は保持されています。";
  err.history = history;
  err.availableModels = discovered.models;
  err.modelSource = discovered.source;
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
          availableModels: error?.availableModels || [],
          modelSource: error?.modelSource || "",
        },
        status
      );
    }
  },
};

