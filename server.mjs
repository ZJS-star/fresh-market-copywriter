import express from "express";
import multer from "multer";
import OpenAI from "openai";
import { toFile } from "openai/uploads";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

dotenv.config({ override: true });

const app = express();
const port = Number(process.env.PORT || 5173);
const baseURL = getOpenAIBaseURL(process.env.OPENAI_BASE_URL);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      ...(baseURL ? { baseURL } : {})
    })
  : null;
const dataDir = path.join(process.cwd(), "data");
const usageLogPath = path.join(dataDir, "usage-log.jsonl");

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

function getOpenAIBaseURL(rawValue) {
  if (!rawValue) return undefined;

  const trimmed = rawValue.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/, "");
    if (!pathname || pathname === "") {
      url.pathname = "/v1";
      return url.toString().replace(/\/+$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

function requireOpenAI(res) {
  if (openai) return true;

  res.status(400).json({
    error: "还没有配置 OPENAI_API_KEY。请复制 .env.example 为 .env，并填入你的 OpenAI API Key。"
  });
  return false;
}

function getApiError(error) {
  if (error?.status === 413 || error?.code === "LIMIT_FILE_SIZE") {
    return "文件超过限制。请压缩视频，或只截取今天介绍水果的片段。";
  }

  return error?.message || "请求失败，请稍后再试。";
}

function normalizeFrames(frames) {
  if (!Array.isArray(frames)) return [];

  return frames
    .filter((frame) => typeof frame === "string" && /^data:image\/(jpeg|jpg|png|webp);base64,/.test(frame))
    .slice(0, 8);
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function getTextPricing(model) {
  const fallback = {
    input: readNumber(process.env.OPENAI_TEXT_INPUT_USD_PER_1M, 0.75),
    cachedInput: readNumber(process.env.OPENAI_TEXT_CACHED_INPUT_USD_PER_1M, 0.075),
    output: readNumber(process.env.OPENAI_TEXT_OUTPUT_USD_PER_1M, 4.5)
  };
  const prices = [
    { prefix: "gpt-5.5-pro", input: 30, cachedInput: 0, output: 180 },
    { prefix: "gpt-5.5", input: 5, cachedInput: 0.5, output: 30 },
    { prefix: "gpt-5.4-pro", input: 30, cachedInput: 0, output: 180 },
    { prefix: "gpt-5.4-mini", input: 0.75, cachedInput: 0.075, output: 4.5 },
    { prefix: "gpt-5.4-nano", input: 0.2, cachedInput: 0.02, output: 1.25 },
    { prefix: "gpt-5.4", input: 2.5, cachedInput: 0.25, output: 15 },
    { prefix: "gpt-5.1", input: 1.25, cachedInput: 0.125, output: 10 },
    { prefix: "gpt-5.2", input: 1.75, cachedInput: 0.175, output: 14 },
    { prefix: "gpt-5-mini", input: 0.25, cachedInput: 0.025, output: 2 },
    { prefix: "gpt-5-nano", input: 0.05, cachedInput: 0.005, output: 0.4 },
    { prefix: "gpt-5", input: 1.25, cachedInput: 0.125, output: 10 },
    { prefix: "gpt-4.1-mini", input: 0.4, cachedInput: 0.1, output: 1.6 },
    { prefix: "gpt-4.1-nano", input: 0.1, cachedInput: 0.025, output: 0.4 },
    { prefix: "gpt-4.1", input: 2, cachedInput: 0.5, output: 8 },
    { prefix: "gpt-4o-mini", input: 0.15, cachedInput: 0.075, output: 0.6 },
    { prefix: "gpt-4o", input: 2.5, cachedInput: 1.25, output: 10 }
  ];
  const normalized = String(model || "").toLowerCase();
  return prices.find((price) => normalized.startsWith(price.prefix)) || fallback;
}

function getTranscribeUsdPerMinute(model) {
  const configured = process.env.OPENAI_TRANSCRIBE_USD_PER_MIN;
  if (configured) return readNumber(configured, 0.003);

  const normalized = String(model || "").toLowerCase();
  if (normalized.startsWith("gpt-4o-mini-transcribe")) return 0.003;
  if (normalized.startsWith("gpt-4o-transcribe")) return 0.006;
  if (normalized.startsWith("whisper")) return 0.006;
  return 0.003;
}

function getUsageNumbers(usage = {}) {
  const inputTokens = readNumber(usage.input_tokens ?? usage.prompt_tokens, 0);
  const outputTokens = readNumber(usage.output_tokens ?? usage.completion_tokens, 0);
  const totalTokens = readNumber(usage.total_tokens, inputTokens + outputTokens);
  const cachedInputTokens = readNumber(
    usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
    0
  );

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens
  };
}

function estimateTextCost({ model, usage }) {
  const pricing = getTextPricing(model);
  const tokens = getUsageNumbers(usage);
  const billableInput = Math.max(tokens.inputTokens - tokens.cachedInputTokens, 0);
  const multiplier = readNumber(process.env.OPENAI_COST_MULTIPLIER, 1);
  const usd =
    ((billableInput * pricing.input +
      tokens.cachedInputTokens * pricing.cachedInput +
      tokens.outputTokens * pricing.output) /
      1_000_000) *
    multiplier;

  return {
    estimatedUsd: roundMoney(usd),
    pricing,
    tokens,
    multiplier
  };
}

function estimateTranscribeCost({ model, audioSeconds }) {
  const seconds = Math.max(readNumber(audioSeconds, 0), 0);
  const usdPerMinute = getTranscribeUsdPerMinute(model);
  const multiplier = readNumber(process.env.OPENAI_COST_MULTIPLIER, 1);

  return {
    estimatedUsd: roundMoney((seconds / 60) * usdPerMinute * multiplier),
    pricing: { usdPerMinute },
    audioSeconds: seconds,
    multiplier
  };
}

function appendUsageRecord(record) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(usageLogPath, `${JSON.stringify(record)}\n`, "utf8");
}

// Observation logs contain labels and packaging used for recognition, not advertising.
function copyVisualMaterial(raw) {
  const irrelevant = /DOA|捆扎|胶带|标签|刺型|刺形|尖刺|外壳|分拣|品控|包装规范/;
  try {
    const data = JSON.parse(raw);
    return JSON.stringify({
      products: (data.detectedProducts || []).map((p) => String(p.name || "").replace(/[（(].*?[）)]/g, "")),
      sellingAngles: (data.sellingAngles || []).filter((s) => !irrelevant.test(s))
    });
  } catch {
    return String(raw || "").split(/\r?\n/).filter((line) => !irrelevant.test(line)).join("\n");
  }
}

async function createStructuredChat({ model, system, content, schemaName, schema }) {
  const response = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: schemaName, strict: true, schema }
    },
    temperature: 0.35
  });
  const text = response.choices?.[0]?.message?.content || "{}";
  return { output_text: text, usage: response.usage || {} };
}

function readUsageRecords(videoId) {
  if (!videoId || !fs.existsSync(usageLogPath)) return [];

  return fs
    .readFileSync(usageLogPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record?.videoId === videoId);
}

function summarizeRecords(videoId) {
  const records = readUsageRecords(videoId);
  const usdToCny = readNumber(process.env.USD_TO_CNY_RATE, 7.25);
  const byKind = {};
  let totalUsd = 0;

  records.forEach((record) => {
    totalUsd += readNumber(record.estimatedUsd, 0);
    byKind[record.kind] = roundMoney((byKind[record.kind] || 0) + readNumber(record.estimatedUsd, 0));
  });

  return {
    videoId,
    calls: records.length,
    totalUsd: roundMoney(totalUsd),
    totalCny: roundMoney(totalUsd * usdToCny),
    usdToCny,
    byKind,
    records: records.slice(-10)
  };
}

function recordTextUsage({ videoId, kind, model, usage, startedAt, extra = {} }) {
  const estimate = estimateTextCost({ model, usage });
  const record = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    videoId: videoId || "manual",
    kind,
    model,
    baseURL: baseURL || "https://api.openai.com/v1",
    latencyMs: Date.now() - startedAt,
    estimatedUsd: estimate.estimatedUsd,
    tokens: estimate.tokens,
    pricing: estimate.pricing,
    multiplier: estimate.multiplier,
    ...extra
  };
  appendUsageRecord(record);

  return {
    record,
    summary: summarizeRecords(record.videoId)
  };
}

function recordTranscribeUsage({ videoId, model, audioSeconds, startedAt, extra = {} }) {
  const estimate = estimateTranscribeCost({ model, audioSeconds });
  const record = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    videoId: videoId || "manual",
    kind: "transcribe",
    model,
    baseURL: baseURL || "https://api.openai.com/v1",
    latencyMs: Date.now() - startedAt,
    estimatedUsd: estimate.estimatedUsd,
    audioSeconds: estimate.audioSeconds,
    pricing: estimate.pricing,
    multiplier: estimate.multiplier,
    ...extra
  };
  appendUsageRecord(record);

  return {
    record,
    summary: summarizeRecords(record.videoId)
  };
}

const visualSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    visualSummary: { type: "string" },
    detectedProducts: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          visibleEvidence: { type: "string" },
          confidence: { type: "string" },
          copyAngle: { type: "string" }
        },
        required: ["name", "visibleEvidence", "confidence", "copyAngle"]
      }
    },
    sellingAngles: {
      type: "array",
      minItems: 0,
      maxItems: 6,
      items: { type: "string" }
    },
    cautionNotes: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: { type: "string" }
    },
    filmingTips: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: { type: "string" }
    }
  },
  required: ["visualSummary", "detectedProducts", "sellingAngles", "cautionNotes", "filmingTips"]
};

const copySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    variants: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          audience: { type: "string" },
          text: { type: "string" }
        },
        required: ["name", "audience", "text"]
      }
    },
    sellerNotes: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string" }
    }
  },
  required: ["variants", "sellerNotes"]
};

app.post("/api/analyze-visual", async (req, res) => {
  try {
    if (!requireOpenAI(res)) return;

    const startedAt = Date.now();
    const frames = normalizeFrames(req.body?.frames);
    const notes = req.body?.notes || "";
    const transcript = req.body?.transcript || "";
    const videoId = req.body?.videoId || "manual";
    const model = process.env.OPENAI_TEXT_MODEL || "qwen3-vl-plus";

    if (!frames.length) {
      res.status(400).json({ error: "请先上传视频并抽取画面。" });
      return;
    }

    const content = [
      {
        type: "input_text",
        text: [
          "请像一个有经验的生鲜店长，分析这些到货视频关键画面，给后续微信群文案提供可核验素材。先判断画面里最值得主推的 1-3 个商品，再提炼真实卖点，不要写镜头流水账。",
          "商品名必须以画面文字、包装或外形能确认的为准；无法确认就写‘疑似’或不要列出。每个 visibleEvidence 只写看得见的证据。",
          "sellingAngles 只能来自顾客真正关心的商品品质证据：果肉/切面状态、果面完整度、明显新鲜度、颗粒或个头状态。包装、标签、胶带、捆扎、摆放、拍摄角度都不是卖点；外壳刺、颜色等外观细节也不要单独当卖点。",
          "甜度、脆度、香糯、产地、价格、库存、功效都不能凭画面猜。只有语音或补充信息明确写出时，才可在 sellingAngles/copyAngle 使用，并标注来源。",
          "如果画面信息不足，sellingAngles 可以为空或写‘暂无足够证据’，宁可少写，不要为了满足数量凑包装细节。cautionNotes 写出会导致误写的缺口。",
          "",
          `补充价格/活动信息：${notes || "无"}`,
          `语音转写辅助信息：${transcript || "无"}`
        ].join("\n")
      },
      ...frames.map((frame) => ({
        type: "input_image",
        image_url: frame,
        detail: process.env.OPENAI_VISION_DETAIL || "low"
      }))
    ];

    const response = await createStructuredChat({
      model,
      system:
        "你是严谨的社区生鲜超市视觉分析助手。把画面证据和用户文字分开处理：看见什么写什么，没看见就明确说不确定；绝不为了凑卖点而猜商品、价格、产地、口感或功效。",
      content: content.map((item) =>
        item.type === "input_text"
          ? { type: "text", text: item.text }
          : { type: "image_url", image_url: { url: item.image_url, detail: item.detail } }
      ),
      schemaName: "fresh_market_visual_analysis",
      schema: visualSchema
    });

    res.json({
      ...JSON.parse(response.output_text),
      cost: recordTextUsage({
        videoId,
        kind: "visual_analysis",
        model,
        usage: response.usage,
        startedAt,
        extra: { frameCount: frames.length }
      })
    });
  } catch (error) {
    res.status(error?.status || 500).json({ error: getApiError(error) });
  }
});

app.post("/api/transcribe", upload.single("video"), async (req, res) => {
  try {
    if (!requireOpenAI(res)) return;
    const startedAt = Date.now();
    if (!req.file) {
      res.status(400).json({ error: "请先选择一个带语音的视频或音频文件。" });
      return;
    }
    const videoId = req.body?.videoId || "manual";
    const audioSeconds = readNumber(req.body?.durationSeconds, 0);
    const model = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

    const mediaFile = await toFile(req.file.buffer, req.file.originalname, {
      type: req.file.mimetype
    });

    const transcript = await openai.audio.transcriptions.create({
      file: mediaFile,
      model,
      language: "zh",
      response_format: "json",
      prompt:
        "这是一家社区生鲜超市每天拍摄新到水果、蔬菜、肉奶、零食的视频。请准确转写商品名、产地、口感、价格、规格、配送信息和老板口语。"
    });

    res.json({
      text: transcript.text || "",
      cost: recordTranscribeUsage({
        videoId,
        model,
        audioSeconds,
        startedAt,
        extra: {
          fileName: req.file.originalname,
          fileSize: req.file.size
        }
      })
    });
  } catch (error) {
    res.status(error?.status || 500).json({ error: getApiError(error) });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    if (!requireOpenAI(res)) return;

    const startedAt = Date.now();
    const {
      videoId = "manual",
      frames: rawFrames = [],
      visualAnalysis = "",
      transcript = "",
      notes = "",
      tone = "亲切、真实、有烟火气",
      groupType = "社区居民微信群",
      delivery = "",
      taboo = ""
    } = req.body || {};
    const frames = normalizeFrames(rawFrames);
    const model = process.env.OPENAI_TEXT_MODEL || "qwen3-vl-plus";

    if (!frames.length && !visualAnalysis.trim() && !transcript.trim() && !notes.trim()) {
      res.status(400).json({ error: "请先分析视频画面，或手动填写今天到货和价格。" });
      return;
    }

    const textPrompt = [
      "写成老板平时发在熟客微信群里的鲜活促销文案，不要像检测报告、客服通知或免责声明。参考用户范文的节奏：商品名+✨标题、短句分行、口感/品质亮点+🌹、最后热情招呼。开头直接抓人，语气热络、有烟火气，emoji自然使用✨🌹❤️😋，要让人读完想吃、想问。",
      "用户给的范文只用于学习语气、节奏和排版，不代表这次商品也有范文里的特价、自然开口、浓郁果香、软糯、红心、爆汁、鲜采等属性。绝不能把范文事实移植过来。",
      "证据优先级：今日补充 > 语音 > 清晰可见的画面。价格、产地、品种、口感、开口状态、当季/鲜采、促销力度必须有明确来源；否则不提。",
      "画面分析里的标签、包装、捆扎、刺形、外壳颜色属于观察记录，不是销售卖点。只在画面真的能看到切面、果肉、开口或大小时，才把相应事实写进正文；不要推断甜度和香气。",
      "三版都要像能直接发群的成稿：日常版有亲切招呼；精品版精致、有品质感；短促版利落有行动感。不要只写‘实拍视频/可以看看/感兴趣来问’，也不要像机器人打招呼。即使缺少价格和口感，也要围绕商品本身写积极、有食欲的氛围，使用‘今天这批看着很精神、榴莲控看过来、喜欢这一口的别错过、给家里安排点好吃的’等自然表达；可以做温和的主观推荐，不要编造明确产地、数字、开口、果肉状态或促销规则。",
      `群体：${groupType}；风格：${tone}`,
      `已确认服务（无就不写）：${delivery || "无"}`,
      `额外限制：${taboo || "无"}`,
      `画面素材：${copyVisualMaterial(visualAnalysis) || "见附图"}`,
      `语音：${transcript || "无"}`,
      `今日补充：${notes || "无"}`,
      "sellerNotes只写能让下一次文案更好卖的缺失信息，例如售价、规格、试吃口感、开果状态。正文不要解释素材缺了什么。不要写预约、试吃服务、优先安排、扣1、手慢无、到货等未提供的服务和活动。只输出约定JSON。"
    ].join("\n");

    const content = [
      { type: "input_text", text: textPrompt },
      ...frames.map((frame) => ({
        type: "input_image",
        image_url: frame,
        detail: process.env.OPENAI_VISION_DETAIL || "low"
      }))
    ];

    const response = await createStructuredChat({
      model,
      system:
        "你是懂社区熟客的生鲜店老板，文案要热情、有食欲、有促销节奏，像真实老板发群，不像AI写的视觉报告。学习这种表达方式：‘泰国特价榴莲✨ 自然开口，浓郁榴莲香直接拉满🌹 喜欢软糯口感的别错过！’ 但只能复用语气结构，不能复用没有证据的商品事实。禁写标签编号、包装捆扎、颜色刺形等无关视觉记录，也禁写‘不吹口感/自己判断/看起来状态正常’这类败兴说明。素材少时也要写有促销氛围的完整短文案，可用积极的主观推荐，不要仅打招呼。有明确证据时把口感、价格或品质写得鲜明。variants名称固定为日常群发版、精品水果版、短促下单版。",
      content: content.map((item) =>
        item.type === "input_text"
          ? { type: "text", text: item.text }
          : { type: "image_url", image_url: { url: item.image_url, detail: item.detail } }
      ),
      schemaName: "fresh_market_group_copy",
      schema: copySchema
    });

    const reviewStartedAt = Date.now();
    const reviewed = await createStructuredChat({
      model,
      system: "你是中文生鲜促销文案总编。保留销售力度，把文案润色为商品标题、短句分行、emoji和热情收尾；不能改成通知、实拍提示或免责声明。可以使用看着精神、值得尝鲜、爱吃的别错过、给家里安排上等主观推荐。删掉没有支持的具体产地、价格、克重、开口、果肉、库存数量、特价规则和服务，以及标签、捆扎、刺形等无关细节。至少两行，要有食欲和吸引力，不凭空声称试吃或摇果测试。",
      content: [{type: "text", text: JSON.stringify({
        confirmedVisual: copyVisualMaterial(visualAnalysis),
        confirmedNotes: notes,
        confirmedTranscript: transcript,
        confirmedService: delivery,
        restrictions: taboo,
        draft: JSON.parse(response.output_text)
      })}],
      schemaName: "fresh_market_verified_copy",
      schema: copySchema
    });
    recordTextUsage({ videoId, kind: "copy_review", model, usage: reviewed.usage, startedAt: reviewStartedAt });

    res.json({
      ...JSON.parse(reviewed.output_text),
      cost: recordTextUsage({
        videoId,
        kind: "copy_generation",
        model,
        usage: response.usage,
        startedAt,
        extra: { frameCount: frames.length }
      })
    });
  } catch (error) {
    res.status(error?.status || 500).json({ error: getApiError(error) });
  }
});

app.get("/api/usage/:videoId", (req, res) => {
  res.json(summarizeRecords(req.params.videoId));
});

app.use((error, req, res, next) => {
  if (error?.code === "LIMIT_FILE_SIZE") {
    res.status(413).json({ error: getApiError(error) });
    return;
  }
  next(error);
});

app.listen(port, () => {
  console.log(`Fresh market copywriter running at http://localhost:${port}`);
});
