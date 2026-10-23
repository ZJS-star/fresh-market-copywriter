const els = {
  status: document.querySelector("#statusText"),
  videoInput: document.querySelector("#videoInput"),
  dropZone: document.querySelector("#dropZone"),
  videoPreview: document.querySelector("#videoPreview"),
  audioPreview: document.querySelector("#audioPreview"),
  analyzeButton: document.querySelector("#analyzeButton"),
  transcribeButton: document.querySelector("#transcribeButton"),
  localDraftButton: document.querySelector("#localDraftButton"),
  clearButton: document.querySelector("#clearButton"),
  frameStrip: document.querySelector("#frameStrip"),
  visual: document.querySelector("#visualInput"),
  transcript: document.querySelector("#transcriptInput"),
  notes: document.querySelector("#notesInput"),
  groupType: document.querySelector("#groupTypeInput"),
  tone: document.querySelector("#toneInput"),
  delivery: document.querySelector("#deliveryInput"),
  taboo: document.querySelector("#tabooInput"),
  costTotal: document.querySelector("#costTotal"),
  costDetail: document.querySelector("#costDetail"),
  generateButton: document.querySelector("#generateButton"),
  outputList: document.querySelector("#outputList"),
  variantTemplate: document.querySelector("#variantTemplate"),
  listTemplate: document.querySelector("#listTemplate")
};

let selectedFile = null;
let selectedFrames = [];
let currentVideoId = makeVideoId();

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function setStatus(text, type = "") {
  els.status.textContent = text;
  els.status.className = `status ${type}`.trim();
}

function setBusy(isBusy) {
  els.analyzeButton.disabled = isBusy || !isVideoFile(selectedFile);
  els.transcribeButton.disabled = isBusy;
  els.generateButton.disabled = isBusy;
  els.localDraftButton.disabled = isBusy;
}

function showError(message) {
  setStatus(message, "error");
}

function makeVideoId() {
  return `video-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isVideoFile(file) {
  return file?.type?.startsWith("video/");
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload;
}

function handleFile(file) {
  if (!file) return;

  selectedFile = file;
  selectedFrames = [];
  currentVideoId = makeVideoId();
  renderFrameStrip([]);
  renderCostSummary(null);

  const objectUrl = URL.createObjectURL(file);
  const isVideo = isVideoFile(file);

  els.videoPreview.hidden = !isVideo;
  els.audioPreview.hidden = isVideo;
  els.videoPreview.src = isVideo ? objectUrl : "";
  els.audioPreview.src = isVideo ? "" : objectUrl;
  els.analyzeButton.disabled = !isVideo;
  setStatus(`已选择：${file.name}`, "ready");
}

els.videoInput.addEventListener("change", (event) => {
  handleFile(event.target.files?.[0]);
});

["dragenter", "dragover"].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((name) => {
  els.dropZone.addEventListener(name, (event) => {
    event.preventDefault();
    els.dropZone.classList.remove("dragging");
  });
});

els.dropZone.addEventListener("drop", (event) => {
  handleFile(event.dataTransfer.files?.[0]);
});

els.clearButton.addEventListener("click", () => {
  selectedFile = null;
  selectedFrames = [];
  currentVideoId = makeVideoId();
  els.videoInput.value = "";
  els.videoPreview.hidden = true;
  els.audioPreview.hidden = true;
  els.videoPreview.src = "";
  els.audioPreview.src = "";
  els.visual.value = "";
  els.transcript.value = "";
  els.notes.value = "";
  renderFrameStrip([]);
  renderEmptyState();
  renderCostSummary(null);
  setBusy(false);
  setStatus("待上传视频");
});

els.analyzeButton.addEventListener("click", async () => {
  if (!selectedFile || !isVideoFile(selectedFile)) {
    showError("请先选择视频文件");
    return;
  }

  try {
    setBusy(true);
    setStatus("正在抽取视频画面", "busy");
    selectedFrames = await extractVideoFrames(selectedFile, 6);
    renderFrameStrip(selectedFrames);

    setStatus("正在分析画面", "busy");
    const result = await requestJson("/api/analyze-visual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: currentVideoId,
        frames: selectedFrames,
        notes: els.notes.value,
        transcript: els.transcript.value
      })
    });

    els.visual.value = formatVisualAnalysis(result);
    updateCost(result.cost);
    setStatus("画面分析完成", "ready");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
});

els.transcribeButton.addEventListener("click", async () => {
  if (!selectedFile) {
    showError("请先选择视频或音频");
    return;
  }

  try {
    setBusy(true);
    setStatus("正在转写语音", "busy");
    const formData = new FormData();
    formData.append("video", selectedFile);
    formData.append("videoId", currentVideoId);
    formData.append("durationSeconds", String(await getMediaDuration(selectedFile).catch(() => 0)));

    const result = await requestJson("/api/transcribe", {
      method: "POST",
      body: formData
    });

    els.transcript.value = result.text || "";
    updateCost(result.cost);
    setStatus("语音转写完成", "ready");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
});

els.generateButton.addEventListener("click", async () => {
  try {
    setBusy(true);

    if (selectedFile && isVideoFile(selectedFile) && !selectedFrames.length) {
      setStatus("正在抽取视频画面", "busy");
      selectedFrames = await extractVideoFrames(selectedFile, 6);
      renderFrameStrip(selectedFrames);
    }

    setStatus("正在生成文案", "busy");
    const framesForGeneration = els.visual.value.trim() ? [] : selectedFrames;
    const result = await requestJson("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoId: currentVideoId,
        frames: framesForGeneration,
        visualAnalysis: els.visual.value,
        transcript: els.transcript.value,
        notes: els.notes.value,
        groupType: els.groupType.value,
        tone: els.tone.value,
        delivery: els.delivery.value,
        taboo: els.taboo.value
      })
    });

    renderOutput(result);
    updateCost(result.cost);
    setStatus("文案已生成", "ready");
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
});

els.localDraftButton.addEventListener("click", () => {
  const source = [els.visual.value, els.notes.value, els.transcript.value].filter(Boolean).join("\n");
  if (!source.trim()) {
    showError("先填一点今日到货内容，或先分析画面");
    return;
  }

  renderOutput(buildLocalDraft(source));
  setStatus("本地草稿已生成", "ready");
});

function renderOutput(data) {
  els.outputList.innerHTML = "";

  data.variants.forEach((variant) => {
    const node = els.variantTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = variant.name;
    node.querySelector("span").textContent = variant.audience;
    node.querySelector("p").textContent = variant.text;
    node.querySelector(".copy-button").addEventListener("click", () => copyText(variant.text));
    els.outputList.appendChild(node);
  });

  appendList("优化建议", data.sellerNotes);
  refreshIcons();
}

function updateCost(cost) {
  if (cost?.summary) {
    renderCostSummary(cost.summary);
  }
}

function renderCostSummary(summary) {
  if (!summary) {
    els.costTotal.textContent = "￥0.0000 / $0.0000";
    els.costDetail.textContent = "还没有调用 AI。成本会按抽帧图片、文字 token 和转写分钟数累计。";
    return;
  }

  els.costTotal.textContent = `￥${formatMoney(summary.totalCny)} / $${formatMoney(summary.totalUsd)}`;
  const details = Object.entries(summary.byKind)
    .map(([kind, usd]) => `${getKindLabel(kind)} $${formatMoney(usd)}`)
    .join("，");
  els.costDetail.textContent = `${summary.calls} 次调用；${details || "暂无明细"}；按汇率 ${summary.usdToCny} 估算。`;
}

function getKindLabel(kind) {
  const labels = {
    visual_analysis: "画面分析",
    copy_generation: "文案生成",
    transcribe: "语音转写"
  };
  return labels[kind] || kind;
}

function formatMoney(value) {
  return Number(value || 0).toFixed(4);
}

function appendList(title, items) {
  const node = els.listTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector("h3").textContent = title;
  const list = node.querySelector("ul");
  items.forEach((item) => {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  });
  node.querySelector(".copy-button").addEventListener("click", () => copyText(items.join("\n")));
  els.outputList.appendChild(node);
}

function renderEmptyState() {
  els.outputList.innerHTML = `
    <div class="empty-state">
      <i data-lucide="message-square-text"></i>
      <p>生成后会显示 3 版可直接群发的促销文案。</p>
    </div>
  `;
  refreshIcons();
}

function renderFrameStrip(frames) {
  els.frameStrip.innerHTML = "";

  if (!frames.length) {
    const empty = document.createElement("span");
    empty.textContent = "还没有抽取画面";
    els.frameStrip.appendChild(empty);
    return;
  }

  frames.forEach((frame, index) => {
    const img = document.createElement("img");
    img.src = frame;
    img.alt = `关键帧 ${index + 1}`;
    els.frameStrip.appendChild(img);
  });
}

function formatVisualAnalysis(data) {
  const products = data.detectedProducts.length
    ? data.detectedProducts
        .map((item) => `- ${item.name}：${item.visibleEvidence}；把握：${item.confidence}；可写角度：${item.copyAngle}`)
        .join("\n")
    : "- 未能从画面里稳定确认具体商品";
  const angles = data.sellingAngles.map((item) => `- ${item}`).join("\n");
  const cautions = data.cautionNotes.map((item) => `- ${item}`).join("\n");
  const tips = data.filmingTips.map((item) => `- ${item}`).join("\n");

  return [
    `画面概述：${data.visualSummary}`,
    "",
    "识别到的商品/画面线索：",
    products,
    "",
    "可写卖点：",
    angles,
    "",
    "不要乱写：",
    cautions,
    "",
    "下次拍摄提醒：",
    tips
  ].join("\n");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  setStatus("已复制", "ready");
}

async function extractVideoFrames(file, count) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForEvent(video, "loadedmetadata");
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const frameCount = Math.min(count, Math.max(1, Math.round(duration)));
    const times = Array.from({ length: frameCount }, (_, index) => {
      const time = (duration * (index + 1)) / (frameCount + 1);
      return Math.min(Math.max(time, 0.1), Math.max(duration - 0.1, 0.1));
    });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const maxSide = 900;
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

    const frames = [];
    for (const time of times) {
      video.currentTime = time;
      await waitForEvent(video, "seeked");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.76));
    }

    return frames;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(eventName, handleEvent);
      target.removeEventListener("error", handleError);
    };
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("视频读取失败，请换一个常见格式的视频。"));
    };
    target.addEventListener(eventName, handleEvent, { once: true });
    target.addEventListener("error", handleError, { once: true });
  });
}

async function getMediaDuration(file) {
  const url = URL.createObjectURL(file);
  const media = document.createElement(isVideoFile(file) ? "video" : "audio");
  media.preload = "metadata";
  media.src = url;

  try {
    await waitForEvent(media, "loadedmetadata");
    return Number.isFinite(media.duration) ? media.duration : 0;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function buildLocalDraft(source) {
  const cleaned = source.replace(/\s+/g, " ").trim();
  const short = cleaned.length > 110 ? `${cleaned.slice(0, 110)}...` : cleaned;

  return {
    variants: [
      {
        name: "日常群发版",
        audience: els.groupType.value,
        text: `今天主推这批水果，品质看着很精神：${short}\n价格合适，想吃新鲜水果的可以冲一波。`
      },
      {
        name: "精品水果版",
        audience: "适合送人、探望、家庭加餐",
        text: `今天这批适合自吃，也适合给家里人带点好的。${short}\n重点看品质和口感，挑得好，吃着更放心。`
      },
      {
        name: "短促下单版",
        audience: "适合快速刷群",
        text: `今日主推：${short}\n品质不错，价格也有吸引力，想吃的先到先选。`
      }
    ],
    sellerNotes: [
      "补充信息里尽量写口感词，比如香糯甜、脆甜、水灵、甜香。",
      "主推商品再补一段近景，拍清果肉、切面、包装或整箱状态。",
      "群文案尽量只推 1-3 个重点水果，不要把所有到货都堆进去。"
    ]
  };
}

renderFrameStrip([]);
renderCostSummary(null);
setBusy(false);
refreshIcons();
