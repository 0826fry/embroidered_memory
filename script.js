(() => {
  "use strict";

  const STORAGE_KEY = "embroidered-memory-v1";
  const MAX_IMAGE_EDGE = 1800;
  const MIN_FONT = 26;
  const MAX_FONT = 92;

  const landing = document.getElementById("landing");
  const workspace = document.getElementById("workspace");
  const actions = document.getElementById("actions");
  const fileInput = document.getElementById("fileInput");
  const artCanvas = document.getElementById("artCanvas");
  const baseCanvas = document.getElementById("baseCanvas");
  const maskCanvas = document.getElementById("maskCanvas");
  const canvasWrap = document.getElementById("canvasWrap");
  const ghostText = document.getElementById("ghostText");
  const positionMarker = document.getElementById("positionMarker");
  const imeInput = document.getElementById("imeInput");
  const clearBtn = document.getElementById("clearBtn");
  const newBtn = document.getElementById("newBtn");
  const exportBtn = document.getElementById("exportBtn");
  const brand = document.getElementById("brand");
  const stitchStatus = document.getElementById("stitchStatus");
  const statusText = document.getElementById("statusText");

  const ctx = artCanvas.getContext("2d", { alpha: false });
  const baseCtx = baseCanvas.getContext("2d", { willReadFrequently: true });
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });

  const state = {
    imageDataUrl: "",
    objects: [],
    active: false,
    anchorX: 0,
    anchorY: 0,
    lineStartX: 0,
    fontSize: 48,
    buffer: "",
    isComposing: false,
    pendingCommit: null,
    isAnimating: false,
    seedCounter: 1,
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    return function random() {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function fontSpec(size) {
    return `650 ${size}px ui-sans-serif, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Segoe UI", sans-serif`;
  }

  function showWorkspace() {
    landing.hidden = true;
    workspace.hidden = false;
    actions.hidden = false;
  }

  function showLanding() {
    landing.hidden = false;
    workspace.hidden = true;
    actions.hidden = true;
  }

  function setStatus(text, stitching = false) {
    statusText.textContent = text;
    stitchStatus.classList.toggle("is-stitching", stitching);
  }

  function defaultFontSize() {
    return clamp(Math.round(baseCanvas.width * 0.047), MIN_FONT, MAX_FONT);
  }

  function resetActivePosition() {
    state.active = false;
    state.buffer = "";
    state.isComposing = false;
    state.pendingCommit = null;
    imeInput.value = "";
    hideGhost();
    positionMarker.classList.remove("visible");
  }

  function clearEverything() {
    localStorage.removeItem(STORAGE_KEY);
    state.imageDataUrl = "";
    state.objects = [];
    state.seedCounter = 1;
    resetActivePosition();
    artCanvas.width = 0;
    artCanvas.height = 0;
    baseCanvas.width = 0;
    baseCanvas.height = 0;
    fileInput.value = "";
    showLanding();
  }

  async function readImageFile(file) {
    const rawUrl = await fileToDataUrl(file);
    const img = await loadImage(rawUrl);

    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    baseCanvas.width = width;
    baseCanvas.height = height;
    baseCtx.clearRect(0, 0, width, height);
    baseCtx.drawImage(img, 0, 0, width, height);

    // JPEG is much smaller in localStorage. PNG is kept when transparency exists.
    let storedUrl;
    try {
      storedUrl = baseCanvas.toDataURL("image/jpeg", 0.9);
    } catch {
      storedUrl = rawUrl;
    }

    state.imageDataUrl = storedUrl;
    state.objects = [];
    state.seedCounter = 1;
    state.fontSize = defaultFontSize();

    artCanvas.width = width;
    artCanvas.height = height;
    renderScene();
    resetActivePosition();
    showWorkspace();
    setStatus("Click the photo, then type");
    persistState();
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function restoreState() {
    let saved;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      saved = null;
    }

    if (!saved?.imageDataUrl) {
      showLanding();
      return;
    }

    try {
      const img = await loadImage(saved.imageDataUrl);
      baseCanvas.width = img.naturalWidth;
      baseCanvas.height = img.naturalHeight;
      baseCtx.drawImage(img, 0, 0);

      artCanvas.width = img.naturalWidth;
      artCanvas.height = img.naturalHeight;

      state.imageDataUrl = saved.imageDataUrl;
      state.objects = Array.isArray(saved.objects) ? saved.objects : [];
      state.seedCounter = Number(saved.seedCounter) || state.objects.length + 1;
      state.fontSize = defaultFontSize();

      renderScene();
      showWorkspace();
      setStatus("Click the photo, then type");
    } catch (error) {
      console.warn("Could not restore saved image.", error);
      localStorage.removeItem(STORAGE_KEY);
      showLanding();
    }
  }

  function persistState() {
    if (!state.imageDataUrl) return;

    const payload = {
      imageDataUrl: state.imageDataUrl,
      objects: state.objects,
      seedCounter: state.seedCounter,
    };

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (error) {
      // Large photographs can exceed the browser's localStorage quota.
      // Keep the editor fully functional even when persistence is unavailable.
      console.warn("Local save skipped (storage quota may be full).", error);
    }
  }

  function canvasPointFromEvent(event) {
    const rect = artCanvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) * (artCanvas.width / rect.width), 0, artCanvas.width),
      y: clamp((event.clientY - rect.top) * (artCanvas.height / rect.height), 0, artCanvas.height),
    };
  }

  function activateAt(point) {
    if (state.isAnimating || !state.imageDataUrl) return;

    state.active = true;
    state.anchorX = point.x;
    state.anchorY = point.y;
    state.lineStartX = point.x;
    state.fontSize = defaultFontSize();
    state.buffer = "";
    imeInput.value = "";

    updateGhost();
    updatePositionMarker();
    positionMarker.classList.add("visible");

    imeInput.disabled = false;
    imeInput.focus({ preventScroll: true });
    setStatus("Type · Space or Enter to stitch");
  }

  function updatePositionMarker() {
    if (!state.active || !artCanvas.width) return;
    const rect = artCanvas.getBoundingClientRect();
    const left = artCanvas.offsetLeft + (state.anchorX / artCanvas.width) * rect.width;
    const top = artCanvas.offsetTop + (state.anchorY / artCanvas.height) * rect.height;

    positionMarker.style.left = `${left}px`;
    positionMarker.style.top = `${top}px`;
  }

  function updateGhost() {
    state.buffer = imeInput.value;

    if (!state.active || !state.buffer) {
      hideGhost();
      return;
    }

    const rect = artCanvas.getBoundingClientRect();
    const scale = rect.width / artCanvas.width;
    const left = artCanvas.offsetLeft + (state.anchorX / artCanvas.width) * rect.width;
    const baselineTop =
      artCanvas.offsetTop +
      (state.anchorY / artCanvas.height) * rect.height -
      state.fontSize * scale;

    ghostText.textContent = state.buffer;
    ghostText.style.left = `${left}px`;
    ghostText.style.top = `${baselineTop}px`;
    ghostText.style.fontSize = `${state.fontSize * scale}px`;
    ghostText.classList.add("visible");
  }

  function hideGhost() {
    ghostText.textContent = "";
    ghostText.classList.remove("visible");
  }

  function measureTextObject(text, fontSize) {
    maskCtx.font = fontSpec(fontSize);
    maskCtx.textBaseline = "alphabetic";
    const metrics = maskCtx.measureText(text);
    const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.82;
    const descent = metrics.actualBoundingBoxDescent || fontSize * 0.2;
    return {
      width: Math.ceil(metrics.width),
      ascent,
      descent,
      height: Math.ceil(ascent + descent),
    };
  }

  function sampleBackgroundColor(x, y, width, fontSize) {
    if (!baseCanvas.width || !baseCanvas.height) {
      return { r: 180, g: 180, b: 180 };
    }

    const left = clamp(Math.floor(x - fontSize * 0.08), 0, baseCanvas.width - 1);
    const top = clamp(Math.floor(y - fontSize * 1.05), 0, baseCanvas.height - 1);
    const right = clamp(Math.ceil(x + width + fontSize * 0.08), left + 1, baseCanvas.width);
    const bottom = clamp(Math.ceil(y + fontSize * 0.22), top + 1, baseCanvas.height);

    const sw = Math.max(1, right - left);
    const sh = Math.max(1, bottom - top);

    let data;
    try {
      data = baseCtx.getImageData(left, top, sw, sh).data;
    } catch {
      return { r: 180, g: 180, b: 180 };
    }

    // Sample on a grid and average in linear-light RGB so mixed regions do not
    // become unnaturally dark.
    const stride = Math.max(1, Math.floor(Math.sqrt((sw * sh) / 1800)));
    let rr = 0;
    let gg = 0;
    let bb = 0;
    let count = 0;

    for (let py = 0; py < sh; py += stride) {
      for (let px = 0; px < sw; px += stride) {
        const idx = (py * sw + px) * 4;
        const alpha = data[idx + 3] / 255;
        if (alpha < 0.2) continue;

        rr += srgbToLinear(data[idx] / 255);
        gg += srgbToLinear(data[idx + 1] / 255);
        bb += srgbToLinear(data[idx + 2] / 255);
        count += 1;
      }
    }

    if (!count) return { r: 180, g: 180, b: 180 };

    return {
      r: Math.round(linearToSrgb(rr / count) * 255),
      g: Math.round(linearToSrgb(gg / count) * 255),
      b: Math.round(linearToSrgb(bb / count) * 255),
    };
  }

  function srgbToLinear(v) {
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }

  function linearToSrgb(v) {
    return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  }

  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        default:
          h = (r - g) / d + 4;
      }
      h /= 6;
    }

    return { h, s, l };
  }

  function hslToRgb(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return { r: v, g: v, b: v };
    }

    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;

    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
  }

  function embroideryColorFromBackground(bg) {
    const hsl = rgbToHsl(bg.r, bg.g, bg.b);

    // Stay close to the photo, but shift lightness enough for the thread's
    // raised surface to remain legible. Saturation is only gently adjusted.
    const direction = hsl.l > 0.56 ? -1 : 1;
    const lightnessShift = 0.075 + Math.min(0.025, Math.abs(hsl.l - 0.5) * 0.04);

    return hslToRgb(
      hsl.h,
      clamp(hsl.s * 0.94 + 0.015, 0, 1),
      clamp(hsl.l + direction * lightnessShift, 0.06, 0.94)
    );
  }

  function rgba(color, alpha = 1) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`;
  }

  function shade(color, amount) {
    return {
      r: clamp(Math.round(color.r + amount), 0, 255),
      g: clamp(Math.round(color.g + amount), 0, 255),
      b: clamp(Math.round(color.b + amount), 0, 255),
    };
  }

  function createEmbroideryObject(text) {
    const metrics = measureTextObject(text, state.fontSize);
    const background = sampleBackgroundColor(state.anchorX, state.anchorY, metrics.width, state.fontSize);
    const color = embroideryColorFromBackground(background);
    const seed =
      (hashString(text) ^ Math.floor(state.anchorX * 17) ^ Math.floor(state.anchorY * 31) ^ state.seedCounter) >>>
      0;

    state.seedCounter += 1;

    return {
      id: `${Date.now().toString(36)}-${state.seedCounter}`,
      text,
      x: state.anchorX,
      y: state.anchorY,
      fontSize: state.fontSize,
      width: metrics.width,
      color,
      seed,
      createdAt: Date.now(),
    };
  }

  function buildStitches(object) {
    const { text, fontSize, x, y, seed } = object;
    const metrics = measureTextObject(text, fontSize);
    const pad = Math.ceil(fontSize * 0.18);
    const maskWidth = Math.max(1, Math.ceil(metrics.width + pad * 2));
    const maskHeight = Math.max(1, Math.ceil(fontSize * 1.5 + pad * 2));
    const baseline = pad + fontSize * 1.04;

    maskCanvas.width = maskWidth;
    maskCanvas.height = maskHeight;
    maskCtx.clearRect(0, 0, maskWidth, maskHeight);
    maskCtx.fillStyle = "#fff";
    maskCtx.font = fontSpec(fontSize);
    maskCtx.textBaseline = "alphabetic";
    maskCtx.fillText(text, pad, baseline);

    const pixels = maskCtx.getImageData(0, 0, maskWidth, maskHeight).data;
    const random = mulberry32(seed || 1);
    const stitches = [];

    const rowGap = clamp(fontSize * 0.055, 2.2, 4.2);
    const stitchGap = clamp(fontSize * 0.09, 3.5, 7);
    const stitchHalf = clamp(fontSize * 0.047, 1.9, 4.3);
    const tilt = clamp(fontSize * 0.034, 1.4, 3.4);

    const alphaAt = (px, py) => {
      if (px < 0 || py < 0 || px >= maskWidth || py >= maskHeight) return 0;
      return pixels[(Math.floor(py) * maskWidth + Math.floor(px)) * 4 + 3];
    };

    let rowIndex = 0;
    for (let py = pad * 0.35; py < maskHeight - pad * 0.2; py += rowGap) {
      let runStart = -1;
      const runs = [];

      for (let px = 0; px <= maskWidth; px += 1) {
        const inside = px < maskWidth && alphaAt(px, py) > 56;

        if (inside && runStart < 0) runStart = px;
        if ((!inside || px === maskWidth) && runStart >= 0) {
          const end = px - 1;
          if (end - runStart >= 1) runs.push([runStart, end]);
          runStart = -1;
        }
      }

      if (rowIndex % 2 === 1) runs.reverse();

      for (const [start, end] of runs) {
        const span = end - start;
        const direction = rowIndex % 2 === 0 ? 1 : -1;
        const first = direction > 0 ? start : end;
        const last = direction > 0 ? end : start;

        for (
          let px = first;
          direction > 0 ? px <= last : px >= last;
          px += direction * stitchGap
        ) {
          const jitterX = (random() - 0.5) * 1.5;
          const jitterY = (random() - 0.5) * 1.0;
          const localTilt = tilt * (0.82 + random() * 0.35) * (rowIndex % 3 === 0 ? -1 : 1);
          const localHalf = Math.min(stitchHalf * (0.8 + random() * 0.35), Math.max(1.1, span * 0.35));

          const x1 = px - localHalf + jitterX;
          const y1 = py - localTilt + jitterY;
          const x2 = px + localHalf + jitterX;
          const y2 = py + localTilt + jitterY;

          // Keep the stitch center inside the glyph mask.
          if (alphaAt(px, py) > 56) {
            stitches.push({
              x1: x + x1 - pad,
              y1: y + y1 - baseline,
              x2: x + x2 - pad,
              y2: y + y2 - baseline,
              hole: random() < 0.11,
            });
          }
        }
      }

      rowIndex += 1;
    }

    return stitches;
  }

  function drawOneStitch(targetCtx, stitch, color, scale = 1) {
    const shadow = shade(color, -38);
    const highlight = shade(color, 44);

    targetCtx.save();
    targetCtx.lineCap = "round";

    // Soft thread shadow gives the stitch a lifted, sewn-on volume.
    targetCtx.strokeStyle = rgba(shadow, 0.32);
    targetCtx.lineWidth = Math.max(1, 2.45 * scale);
    targetCtx.beginPath();
    targetCtx.moveTo(stitch.x1 + 0.7 * scale, stitch.y1 + 0.85 * scale);
    targetCtx.lineTo(stitch.x2 + 0.7 * scale, stitch.y2 + 0.85 * scale);
    targetCtx.stroke();

    // Core fiber.
    targetCtx.strokeStyle = rgba(color, 0.95);
    targetCtx.lineWidth = Math.max(0.9, 1.75 * scale);
    targetCtx.beginPath();
    targetCtx.moveTo(stitch.x1, stitch.y1);
    targetCtx.lineTo(stitch.x2, stitch.y2);
    targetCtx.stroke();

    // Fine highlight strand.
    targetCtx.strokeStyle = rgba(highlight, 0.48);
    targetCtx.lineWidth = Math.max(0.38, 0.48 * scale);
    targetCtx.beginPath();
    targetCtx.moveTo(stitch.x1 - 0.35 * scale, stitch.y1 - 0.35 * scale);
    targetCtx.lineTo(stitch.x2 - 0.35 * scale, stitch.y2 - 0.35 * scale);
    targetCtx.stroke();

    if (stitch.hole) {
      targetCtx.fillStyle = rgba(shadow, 0.24);
      targetCtx.beginPath();
      targetCtx.arc(stitch.x1, stitch.y1, Math.max(0.6, 0.72 * scale), 0, Math.PI * 2);
      targetCtx.fill();
    }

    targetCtx.restore();
  }

  function drawObjectStatic(targetCtx, object) {
    const stitches = buildStitches(object);

    // A very subtle compressed-fabric imprint sits under the actual thread.
    // It is intentionally weak; the visible character is still made from stitches.
    targetCtx.save();
    targetCtx.font = fontSpec(object.fontSize);
    targetCtx.textBaseline = "alphabetic";
    targetCtx.fillStyle = rgba(shade(object.color, -30), 0.09);
    targetCtx.fillText(object.text, object.x + 0.7, object.y + 1.15);
    targetCtx.restore();

    for (const stitch of stitches) {
      drawOneStitch(targetCtx, stitch, object.color, object.fontSize / 48);
    }
  }

  function renderScene() {
    if (!artCanvas.width || !baseCanvas.width) return;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, artCanvas.width, artCanvas.height);
    ctx.drawImage(baseCanvas, 0, 0);

    for (const object of state.objects) {
      drawObjectStatic(ctx, object);
    }
    ctx.restore();
  }

  async function commitBuffer(trigger) {
    if (
      !state.active ||
      state.isAnimating ||
      state.isComposing ||
      !imeInput.value.trim()
    ) {
      return;
    }

    const raw = imeInput.value;
    const text = raw.replace(/\r?\n/g, "").trimEnd();
    if (!text) return;

    const object = createEmbroideryObject(text);
    const stitches = buildStitches(object);

    state.buffer = "";
    imeInput.value = "";
    hideGhost();
    positionMarker.classList.remove("visible");

    state.isAnimating = true;
    imeInput.disabled = true;
    setStatus("Stitching…", true);

    await animateStitches(object, stitches);

    state.objects.push(object);
    renderScene();
    persistState();

    // Continue naturally after a committed word. Enter starts a new baseline,
    // while Space leaves a word-sized gap and keeps the same line.
    if (trigger === "enter") {
      state.anchorX = state.lineStartX;
      state.anchorY = clamp(
        object.y + object.fontSize * 1.34,
        object.fontSize * 1.1,
        artCanvas.height - object.fontSize * 0.2
      );
    } else {
      state.anchorX = clamp(
        object.x + object.width + object.fontSize * 0.34,
        0,
        artCanvas.width - object.fontSize * 0.5
      );
      state.anchorY = object.y;
    }

    state.isAnimating = false;
    imeInput.disabled = false;
    updatePositionMarker();
    positionMarker.classList.add("visible");
    updateGhost();
    imeInput.focus({ preventScroll: true });
    setStatus("Type · Space or Enter to stitch");
  }

  function animateStitches(object, stitches) {
    return new Promise((resolve) => {
      if (!stitches.length) {
        resolve();
        return;
      }

      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const duration = prefersReduced
        ? 40
        : clamp(520 + stitches.length * 1.55, 720, 2600);

      let lastDrawn = 0;
      const start = performance.now();

      function frame(now) {
        const elapsed = now - start;
        const t = clamp(elapsed / duration, 0, 1);
        const eased = 1 - (1 - t) ** 2.1;
        const target = Math.floor(eased * stitches.length);

        for (let i = lastDrawn; i < target; i += 1) {
          drawOneStitch(ctx, stitches[i], object.color, object.fontSize / 48);
        }

        lastDrawn = target;

        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          resolve();
        }
      }

      requestAnimationFrame(frame);
    });
  }

  function exportPng() {
    if (!artCanvas.width) return;

    // Ensure export always contains a clean, fully rendered final frame.
    renderScene();

    const link = document.createElement("a");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    link.download = `embroidered-memory-${timestamp}.png`;
    link.href = artCanvas.toDataURL("image/png");
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function clearStitches() {
    if (state.isAnimating) return;
    state.objects = [];
    resetActivePosition();
    renderScene();
    persistState();
    setStatus("Click the photo, then type");
  }

  fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await readImageFile(file);
    } catch (error) {
      console.error(error);
      setStatus("Could not open this image");
    }
  });

  canvasWrap.addEventListener("pointerdown", (event) => {
    if (state.isAnimating || !artCanvas.width) return;
    if (event.target !== artCanvas && event.target !== canvasWrap) return;

    const point = canvasPointFromEvent(event);
    activateAt(point);
  });

  imeInput.addEventListener("compositionstart", () => {
    if (state.isAnimating) return;
    state.isComposing = true;
    updateGhost();
  });

  imeInput.addEventListener("compositionupdate", () => {
    if (state.isAnimating) return;
    requestAnimationFrame(updateGhost);
  });

  imeInput.addEventListener("compositionend", () => {
    state.isComposing = false;

    // Normally, composition completion alone does NOT embroider anything.
    // However, on some Korean IMEs the Space/Enter that the user intends as
    // the commit trigger is also the key that ends composition. In that event
    // order, remember the delimiter from keydown and commit immediately after
    // the browser has delivered its final composition/input update.
    const pending = state.pendingCommit;
    state.pendingCommit = null;

    requestAnimationFrame(() => {
      updateGhost();
      if (pending && !state.isAnimating) {
        void commitBuffer(pending);
      }
    });
  });

  imeInput.addEventListener("input", () => {
    if (state.isAnimating) {
      imeInput.value = "";
      state.buffer = "";
      return;
    }
    updateGhost();
  });

  imeInput.addEventListener("keydown", (event) => {
    if (state.isAnimating) {
      event.preventDefault();
      return;
    }

    // Some Korean IMEs use the same Space/Enter keypress both to end the
    // current composition and to signal the user's intended delimiter. Do not
    // prevent the browser's composition event; remember the trigger and commit
    // after compositionend instead.
    if (event.isComposing || state.isComposing || event.keyCode === 229) {
      if (event.key === " " || event.code === "Space") {
        state.pendingCommit = "space";
      } else if (event.key === "Enter") {
        state.pendingCommit = "enter";
      }
      return;
    }

    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      void commitBuffer("space");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void commitBuffer("enter");
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      imeInput.value = "";
      state.buffer = "";
      hideGhost();
      setStatus("Preview cleared · keep typing or click a new position");
    }
  });

  window.addEventListener("resize", () => {
    updateGhost();
    updatePositionMarker();
  });

  clearBtn.addEventListener("click", clearStitches);
  newBtn.addEventListener("click", clearEverything);
  exportBtn.addEventListener("click", exportPng);

  brand.addEventListener("click", (event) => {
    event.preventDefault();
    if (workspace.hidden) {
      fileInput.click();
    } else if (!state.isAnimating) {
      imeInput.focus({ preventScroll: true });
    }
  });

  // Keep keyboard focus available after toolbar clicks.
  document.addEventListener("pointerup", (event) => {
    if (
      !workspace.hidden &&
      state.active &&
      !state.isAnimating &&
      !event.target.closest("button") &&
      event.target !== fileInput
    ) {
      imeInput.focus({ preventScroll: true });
    }
  });

  restoreState();
})();
