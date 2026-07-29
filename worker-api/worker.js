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
  "condition": "天候",
  "temp": null,
  "windDirection": "風向",
  "windSpeed": null,
  "waterTemp": null,
  "waveHeight": null
},
"odds": {},
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
      "currentSeriesResults": [],
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

