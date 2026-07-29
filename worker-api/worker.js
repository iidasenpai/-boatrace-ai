const ALLOWED_ORIGIN = "https://iidasenpai.github.io";

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
6. オッズ情報

次のJSON形式だけで返してください。Markdownや説明文は禁止です。
読めない値は空文字、null、空配列にし、推測で補完しないでください。

{
  "venue": "",
  "raceNumber": "",
  "date": "",
  "weather": {
    "condition": "",
    "windDirection": "",
    "windSpeed": null,
    "waveHeight": null
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
      "currentSeriesResults": [],
      "odds": {},
      "notes": []
    }
  ],
  "warnings": []
}

boatsは1号艇から6号艇の順に整理してください。
`;

      const geminiResponse = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY,
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }, ...imageParts],
              },
            ],
            generationConfig: {
              responseMimeType: "application/json",
            },
          }),
        }
      );

      const result = await geminiResponse.json();

      if (!geminiResponse.ok) {
        return json(
          {
            error: "Gemini APIでエラーが発生しました。",
            details: result?.error?.message || "詳細不明のエラーです。",
          },
          geminiResponse.status
        );
      }

      const text = result?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || "")
        .join("")
        .trim();

      if (!text) {
        return json({ error: "AIから解析結果が返りませんでした。" }, 502);
      }

      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json(
          {
            error: "AIの回答をJSONとして読み取れませんでした。",
            raw: text,
          },
          502
        );
      }

      return json({ success: true, data: parsed });
    } catch (error) {
      return json(
        {
          error: "Workerでエラーが発生しました。",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  },
};
