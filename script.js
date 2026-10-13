(() => {
  "use strict";

  // Embroidered Memory v2. All stitch geometry is stored in photograph-space,
  // never in viewport pixels. The original renderer's canvas-mask / satin-stitch
  // approach, HSL thread shading, native IME input and requestAnimationFrame
  // animation are retained and extended into separate character objects.
  const STORAGE_KEY = "embroidered-memory-v2";
  const LEGACY_KEY = "embroidered-memory-v1";
  const DB_NAME = "embroidered-memory-assets";
  const WORK_EDGE = 2000;
  const FONT_FAMILY = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", "Segoe UI", sans-serif';
  const $ = (id) => document.getElementById(id);
  const landing = $("landing");
  const workspace = $("workspace");
  const uploadTarget = $("uploadTarget");
  const fileInput = $("fileInput");
  const artCanvas = $("artCanvas");
  const baseCanvas = $("baseCanvas");
  const maskCanvas = $("maskCanvas");
  const ghost = $("ghostText");
  const caret = $("caret");
  const selectionBox = $("selectionBox");
  const imeInput = $("imeInput");
  const announcement = $("announcement");
  const controls = $("controls");
  const menuToggle = $("menuToggle");
  const closePanel = $("closePanel");
  const editContext = $("editContext");
  const sizeRange = $("sizeRange");
  const densityRange = $("densityRange");
  const matchRange = $("matchRange");
  const variationRange = $("variationRange");
  const fitSelect = $("fitSelect");
  const connectionToggle = $("connectionToggle");
  const undoBtn = $("undoBtn");
  const deleteBtn = $("deleteBtn");
  const clearBtn = $("clearBtn");
  const newBtn = $("newBtn");
  const exportBtn = $("exportBtn");

  const ctx = artCanvas.getContext("2d", { alpha: false });
  const baseCtx = baseCanvas.getContext("2d", { willReadFrequently: true });
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  const staticCanvas = document.createElement("canvas");
  const staticCtx = staticCanvas.getContext("2d", { alpha: false });
  const state = {
    sourceImage: null, photoId: "", fallbackUrl: "", width: 0, height: 0,
    pixels: null, characters: [], connections: [], holes: [],
    defaults: { size: 64, density: 55, match: 88, variation: 92 },
    viewMode: "cover", showConnections: true,
    isAnimating: false, active: false, selectedId: null, composing: false,
    pendingDelimiter: null, lastDelimiterAt: -Infinity, lastDelimiterKey: "",
    imeDraft: "", cursorX: 0, cursorY: 0, lineStartX: 0,
    runId: 0, lineId: 0, nextOrder: 1, lastCharacterId: null,
    animation: null, panelOpen: false, originalWidth: 0, originalHeight: 0,
  };
  let saveTimer = null;
  let panelHideTimer = null;
  let currentPhotoGeneration = 0;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const round2 = (x) => Math.round(x * 100) / 100;
  const rgbString = (c, alpha = 1) => `rgba(${c.r},${c.g},${c.b},${alpha})`;
  const hashString = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  function mulberry32(seed) {
    return () => {
      let t = (seed += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function graphemes(text) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), p => p.segment);
    }
    return Array.from(text);
  }
  const isHangulSyllable = (c) => /^[\uac00-\ud7a3]$/u.test(c);
  const isKoreanJamo = (c) => /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]+$/u.test(c);
  const fontSpec = (size) => `650 ${size}px ${FONT_FAMILY}`;
  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sleepFrame = (fn) => requestAnimationFrame(fn);

  function notify(message) { announcement.textContent = message; }
  function setBusy(busy) {
    state.isAnimating = busy;
    artCanvas.classList.toggle("is-busy", busy);
    imeInput.disabled = busy;
    for (const el of [sizeRange, densityRange, matchRange, variationRange, fitSelect, connectionToggle, undoBtn, deleteBtn, clearBtn, newBtn, exportBtn]) {
      el.disabled = busy || (el === deleteBtn && !state.selectedId);
    }
    updateOverlays();
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("IndexedDB not available")); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("assets")) req.result.createObjectStore("assets");
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }
  async function idbWrite(key, value) {
    const db = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("assets", "readwrite");
        tx.objectStore("assets").put(value, key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  async function idbRead(key) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("assets", "readonly");
        const req = tx.objectStore("assets").get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  }
  async function idbRemove(key) {
    try {
      const db = await openDatabase();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction("assets", "readwrite");
          tx.objectStore("assets").delete(key);
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } finally { db.close(); }
    } catch { /* Old copies may remain if storage is unavailable. */ }
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = src;
    });
  }
  async function decodeBlob(blob) {
    const url = URL.createObjectURL(blob);
    try { return await loadImage(url); }
    finally { URL.revokeObjectURL(url); }
  }
  function makeFallbackImage() {
    // The full-resolution Blob is retained in IndexedDB. This small JPEG is a
    // deliberately bounded localStorage fallback for browsers rejecting IDB.
    const edge = 1060;
    const scale = Math.min(1, edge / Math.max(state.width, state.height));
    const c = document.createElement("canvas");
    c.width = Math.round(state.width * scale);
    c.height = Math.round(state.height * scale);
    c.getContext("2d").drawImage(baseCanvas, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", .72);
  }
  function initializePhoto(img, { photoId = "", fallbackUrl = "", workWidth = null, workHeight = null } = {}) {
    state.sourceImage = img;
    state.originalWidth = img.naturalWidth;
    state.originalHeight = img.naturalHeight;
    const s = Math.min(1, WORK_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    state.width = workWidth || Math.max(1, Math.round(img.naturalWidth * s));
    state.height = workHeight || Math.max(1, Math.round(img.naturalHeight * s));
    state.photoId = photoId || `p-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    baseCanvas.width = state.width;
    baseCanvas.height = state.height;
    baseCtx.drawImage(img, 0, 0, state.width, state.height);
    state.pixels = baseCtx.getImageData(0, 0, state.width, state.height).data;
    state.fallbackUrl = fallbackUrl || makeFallbackImage();
    landing.hidden = true;
    workspace.hidden = false;
    resizeViewport();
  }
  function resetEditing() {
    state.active = false;
    state.selectedId = null;
    state.composing = false;
    state.pendingDelimiter = null;
    state.imeDraft = "";
    imeInput.value = "";
    state.lastCharacterId = null;
    hideGhost();
    updateOverlays();
    syncControls();
  }
  async function receiveFile(file) {
    if (!file || state.isAnimating || !file.type.startsWith("image/")) return;
    const generation = ++currentPhotoGeneration;
    try {
      const img = await decodeBlob(file);
      if (generation !== currentPhotoGeneration) return;
      const oldId = state.photoId;
      state.characters = [];
      state.connections = [];
      state.holes = [];
      state.nextOrder = 1;
      state.runId = 0;
      state.viewMode = "cover";
      state.showConnections = true;
      initializePhoto(img);
      resetEditing();
      state.defaults.size = clamp(Math.round(state.width * .049), 28, 122);
      state.defaults.density = 55;
      state.defaults.match = 88;
      state.defaults.variation = 92;
      fitSelect.value = state.viewMode;
      connectionToggle.checked = true;
      syncControls();
      refreshScene();
      persistNow();
      try { await idbWrite(state.photoId, file); }
      catch (error) { console.warn("Original image cannot be stored in IndexedDB.", error); }
      if (oldId) void idbRemove(oldId);
      fileInput.value = "";
      notify("Photograph ready. Click to place a stitch.");
    } catch (error) {
      console.error(error);
      notify("This image could not be opened.");
    }
  }

  function serializableChar(char) {
    const { stitches, ...meta } = char;
    return meta;
  }
  function projectSnapshot() {
    return {
      version: 2, photoId: state.photoId, fallbackUrl: state.fallbackUrl,
      workWidth: state.width, workHeight: state.height,
      defaults: { ...state.defaults }, viewMode: state.viewMode,
      showConnections: state.showConnections, nextOrder: state.nextOrder,
      characters: state.characters.map(serializableChar),
      connections: state.connections, holes: state.holes,
    };
  }
  function persistNow() {
    if (!state.sourceImage) return;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const snapshot = projectSnapshot();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (error) {
      console.warn("Local storage quota reached; trying compact backup.", error);
      // Keep edits working; image may still be recoverable from IndexedDB.
      try {
        snapshot.fallbackUrl = "";
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      } catch (secondError) {
        console.warn("Local backup unavailable; edits remain in memory.", secondError);
        notify("Local save is full. Export your work to preserve it.");
      }
    }
  }
  function queuePersist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 180);
  }

  function measureChar(text, size) {
    maskCtx.font = fontSpec(size);
    maskCtx.textBaseline = "alphabetic";
    const m = maskCtx.measureText(text);
    return {
      advance: m.width,
      ascent: m.actualBoundingBoxAscent || size * .81,
      descent: m.actualBoundingBoxDescent || size * .17,
    };
  }
  function srgbLinear(v) { return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }
  function linearSrgb(v) { return v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055; }
  function rgbToHsl(color) {
    const r = color.r / 255, g = color.g / 255, b = color.b / 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    const d = max - min;
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (d) {
      s = l > .5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h /= 6;
    }
    return {h,s,l};
  }
  function hslToRgb(h,s,l) {
    if (s < .00001) { const v = Math.round(l * 255); return {r:v,g:v,b:v}; }
    const hue = (p,q,t) => {
      t = (t + 1) % 1;
      if (t < 1/6) return p+(q-p)*6*t;
      if (t < 1/2) return q;
      if (t < 2/3) return p+(q-p)*(2/3-t)*6;
      return p;
    };
    const q = l < .5 ? l*(1+s) : l+s-l*s;
    const p = 2*l-q;
    return {r:Math.round(hue(p,q,h+1/3)*255),g:Math.round(hue(p,q,h)*255),b:Math.round(hue(p,q,h-1/3)*255)};
  }
  function shade(color, amount) {
    return {r:clamp(color.r+amount,0,255),g:clamp(color.g+amount,0,255),b:clamp(color.b+amount,0,255)};
  }
  function mixRgb(a,b,t) {
    return {r:Math.round(lerp(a.r,b.r,t)),g:Math.round(lerp(a.g,b.g,t)),b:Math.round(lerp(a.b,b.b,t))};
  }
  function pixelAt(x,y) {
    const px = clamp(Math.round(x),0,state.width-1);
    const py = clamp(Math.round(y),0,state.height-1);
    const i = (py*state.width+px)*4;
    return {r:state.pixels[i],g:state.pixels[i+1],b:state.pixels[i+2]};
  }
  function sampleLocal(x,y,radius=2.4) {
    // Edge-aware, small-area weighted color smoothing. Nearby pixels with a
    // different color have less influence, preserving red/yellow boundaries.
    const center = pixelAt(x,y);
    let r=0,g=0,b=0,total=0;
    for (let dy=-2;dy<=2;dy++) {
      for (let dx=-2;dx<=2;dx++) {
        const color = pixelAt(x+dx*radius/2,y+dy*radius/2);
        const dist2 = dx*dx+dy*dy;
        const diff = (color.r-center.r)**2+(color.g-center.g)**2+(color.b-center.b)**2;
        const weight = Math.exp(-dist2/4.5)*Math.exp(-diff/(105*105));
        // weighted linear-light RGB retains sensible luminance in transitions
        r += srgbLinear(color.r/255)*weight;
        g += srgbLinear(color.g/255)*weight;
        b += srgbLinear(color.b/255)*weight;
        total += weight;
      }
    }
    return {r:Math.round(linearSrgb(r/total)*255),g:Math.round(linearSrgb(g/total)*255),b:Math.round(linearSrgb(b/total)*255)};
  }
  function sampleCharAverage(char, metrics) {
    let r=0,g=0,b=0,n=0;
    for (let iy=0;iy<5;iy++) {
      for (let ix=0;ix<6;ix++) {
        const color = sampleLocal(char.x+(ix+.5)*metrics.advance/6,char.y-metrics.ascent+(iy+.5)*(metrics.ascent+metrics.descent)/5,3);
        r += srgbLinear(color.r/255);
        g += srgbLinear(color.g/255);
        b += srgbLinear(color.b/255);
        n++;
      }
    }
    return {r:Math.round(linearSrgb(r/n)*255),g:Math.round(linearSrgb(g/n)*255),b:Math.round(linearSrgb(b/n)*255)};
  }
  function colorForStitch(background,match,seedJitter=0) {
    const hsl = rgbToHsl(background);
    const delta = lerp(.19,.022, match/100);
    const direction = hsl.l > .54 ? -1 : 1;
    return hslToRgb(hsl.h, clamp(hsl.s*.96+.008,0,1),clamp(hsl.l+direction*delta+seedJitter, .025,.985));
  }

  function buildStitches(char) {
    const size=char.size;
    const metrics=measureChar(char.text,size);
    char.advance = round2(metrics.advance);
    char.ascent = round2(metrics.ascent);
    char.descent = round2(metrics.descent);
    const pad = Math.ceil(size*.22+4);
    const maskW = Math.max(2,Math.ceil(metrics.advance+pad*2));
    const maskH = Math.max(2,Math.ceil(size*1.46+pad*2));
    const baseline = pad+size*1.08;
    maskCanvas.width = maskW;
    maskCanvas.height = maskH;
    maskCtx.clearRect(0,0,maskW,maskH);
    maskCtx.fillStyle="#fff";
    maskCtx.font=fontSpec(size);
    maskCtx.textBaseline="alphabetic";
    maskCtx.fillText(char.text,pad,baseline);
    const pixels=maskCtx.getImageData(0,0,maskW,maskH).data;
    const alphaAt=(x,y) => {
      if (x<0||x>=maskW||y<0||y>=maskH) return 0;
      return pixels[(Math.floor(y)*maskW+Math.floor(x))*4+3];
    };
    const rnd=mulberry32(char.seed || 1);
    const density=char.density/100;
    const rowGap=clamp(size*(.065-.035*density),1.6,6.8);
    const columnGap=clamp(size*(.11-.065*density),2,10.5);
    const halfLength=clamp(columnGap*.64,1.7,7.0);
    const tilt=clamp(size*.029,1.1,4.3);
    const fiberWidth=round2(clamp(size*(.014+.003*density),.75,2.8));
    const average=char.legacyColor || sampleCharAverage(char,metrics);
    const stitches=[];
    let row=0;
    for (let py=0;py<maskH;py+=rowGap) {
      const runs=[];
      let begin=-1;
      for (let px=0;px<=maskW;px++) {
        const inside=px<maskW&&alphaAt(px,py)>64;
        if (inside&&begin<0) begin=px;
        if (!inside&&begin>=0) {
          if (px-begin>=1) runs.push([begin,px-1]);
          begin=-1;
        }
      }
      if (row%2) runs.reverse();
      for (const [lo,hi] of runs) {
        const sign=row%2 ? -1:1;
        const first=sign>0?lo:hi;
        const last=sign>0?hi:lo;
        const span=hi-lo;
        for (let px=first;sign>0?px<=last:px>=last;px+=sign*columnGap) {
          if (alphaAt(px,py)<64) continue;
          const dx=(rnd()-.5)*Math.min(1.1,columnGap*.3);
          const dy=(rnd()-.5)*.8;
          const h=Math.min(halfLength*(.8+rnd()*.37),Math.max(1,span*.4));
          const slant=tilt*(.78+rnd()*.3)*(row%3===0?-1:1);
          const midX=char.x+px-pad;
          const midY=char.y+py-baseline;
          const background=char.legacyColor || mixRgb(average,sampleLocal(midX,midY,clamp(size*.035,1.6,4.5)),char.variation/100);
          const thread=char.legacyColor || colorForStitch(background,char.match,(rnd()-.5)*.007);
          stitches.push({
            x1:round2(midX-h+dx),y1:round2(midY-slant+dy),
            x2:round2(midX+h+dx),y2:round2(midY+slant+dy),
            color:thread,width:fiberWidth,order:stitches.length,
          });
          if (stitches.length>=3800) break;
        }
        if (stitches.length>=3800) break;
      }
      if (stitches.length>=3800) break;
      row++;
    }
    // Guide the beginning and end to the horizontal midline. The stitch is
    // still real and uses the same sampled local color; thread connectors are
    // anchored to its exact endpoints, not to a fabricated glyph bounding box.
    if (stitches.length>2) {
      const preferredY=char.y-size*.46;
      let first=0,firstScore=Infinity;
      for (let i=0;i<stitches.length;i++) {
        const s=stitches[i];
        const score=(s.x1-(char.x+size*.15))**2+((s.y1-preferredY)*1.1)**2;
        if (score<firstScore) {first=i;firstScore=score;}
      }
      const [start]=stitches.splice(first,1);
      stitches.unshift(start);
      let last=1,lastScore=Infinity;
      for (let i=1;i<stitches.length;i++) {
        const s=stitches[i];
        const score=(s.x2-(char.x+metrics.advance-size*.14))**2+((s.y2-preferredY)*1.1)**2;
        if (score<lastScore) {last=i;lastScore=score;}
      }
      const [finish]=stitches.splice(last,1);
      stitches.push(finish);
    }
    stitches.forEach((stitch,index) => {stitch.order=index;});
    char.stitches=stitches;
    return stitches;
  }

  function drawStitch(target,s) {
    const c=s.color;
    const shadow=shade(c,-39);
    const highlight=shade(c,46);
    target.lineCap="round";
    target.strokeStyle=rgbString(shadow,.32);
    target.lineWidth=s.width*1.58;
    target.beginPath();
    target.moveTo(s.x1+.58,s.y1+.63);
    target.lineTo(s.x2+.58,s.y2+.63);
    target.stroke();
    target.strokeStyle=rgbString(c,.96);
    target.lineWidth=s.width;
    target.beginPath(); target.moveTo(s.x1,s.y1); target.lineTo(s.x2,s.y2); target.stroke();
    target.strokeStyle=rgbString(highlight,.48);
    target.lineWidth=Math.max(.36,s.width*.26);
    target.beginPath(); target.moveTo(s.x1-.24,s.y1-.29); target.lineTo(s.x2-.24,s.y2-.29); target.stroke();
  }
  function drawCharacter(target,char,count=char.stitches.length) {
    for (let i=0;i<count;i++) drawStitch(target,char.stitches[i]);
  }
  function makeHolesFor(char) {
    const holes=[];
    const skip=Math.max(1,Math.ceil(char.stitches.length/165));
    const radius=clamp(char.size*.009,.38,1.3);
    for (let i=0;i<char.stitches.length;i+=skip) {
      const s=char.stitches[i];
      const jitter=((hashString(`${char.id}-${i}`)%100)/100);
      const strength=.10+jitter*.06;
      holes.push({x:s.x1,y:s.y1,r:round2(radius),strength,fromId:char.id,afterIndex:i,permanent:true});
      holes.push({x:s.x2,y:s.y2,r:round2(radius*.85),strength,fromId:char.id,afterIndex:i,permanent:true});
    }
    return holes;
  }
  function drawHole(target,hole) {
    const r=hole.r;
    target.fillStyle=`rgba(10,9,8,${hole.strength})`;
    target.beginPath(); target.ellipse(hole.x,hole.y,r,r*.74,0,0,Math.PI*2); target.fill();
    target.strokeStyle=`rgba(255,255,255,${hole.strength*.68})`;
    target.lineWidth=Math.max(.26,r*.28);
    target.beginPath();
    target.arc(hole.x+.15*r,hole.y+.12*r,r*.93,Math.PI*.05,Math.PI*1.04);
    target.stroke();
  }
  function drawHoles(target,holes) {for (const h of holes) drawHole(target,h);}
  function findChar(id) {return state.characters.find(c=>c.id===id) || null;}
  function connectionBetween(a,b) {
    if (!a?.stitches?.length || !b?.stitches?.length) return null;
    const last=a.stitches[a.stitches.length-1];
    const first=b.stitches[0];
    const x0=last.x2,y0=last.y2,x1=first.x1,y1=first.y1;
    const dx=x1-x0,dy=y1-y0;
    // A very slight droop, tuned to remain close to the photograph surface.
    const droop=clamp(Math.abs(dx)*.08+Math.abs(dy)*.025,1.2,9.0);
    return {
      id:`${a.id}__${b.id}`, fromId:a.id,toId:b.id,
      path:{x0:round2(x0),y0:round2(y0),cx:round2((x0+x1)/2),cy:round2((y0+y1)/2+droop),x1:round2(x1),y1:round2(y1)},
      color:{...last.color}, width:round2(Math.min(last.width,1.3)), active:true,
    };
  }
  function refreshConnections() {
    state.connections=state.connections.map(link => connectionBetween(findChar(link.fromId),findChar(link.toId))).filter(Boolean);
  }
  function bezierPoint(p,t) {
    const s=1-t;
    return {x:s*s*p.x0+2*s*t*p.cx+t*t*p.x1,y:s*s*p.y0+2*s*t*p.cy+t*t*p.y1};
  }
  function drawConnection(target,link,from=0,to=1) {
    if (!link || to<=from) return;
    const steps=Math.max(3,Math.ceil((to-from)*26));
    const shadow=shade(link.color,-35);
    const highlight=shade(link.color,45);
    const makeStroke=(color,width,shiftX=0,shiftY=0) => {
      target.strokeStyle=color; target.lineWidth=width; target.lineCap="round";
      target.beginPath();
      for (let i=0;i<=steps;i++) {
        const p=bezierPoint(link.path,lerp(from,to,i/steps));
        if (!i) target.moveTo(p.x+shiftX,p.y+shiftY);
        else target.lineTo(p.x+shiftX,p.y+shiftY);
      }
      target.stroke();
    };
    makeStroke(rgbString(shadow,.24),link.width*1.64,.33,.42);
    makeStroke(rgbString(link.color,.92),link.width);
    makeStroke(rgbString(highlight,.36),Math.max(.28,link.width*.28),-.16,-.2);
  }

  function viewportTransform(pixelWidth=artCanvas.width,pixelHeight=artCanvas.height) {
    if (!state.width || !state.height) return {scale:1,ox:0,oy:0};
    const ratioX=pixelWidth/state.width,ratioY=pixelHeight/state.height;
    const scale=state.viewMode==="cover"?Math.max(ratioX,ratioY):Math.min(ratioX,ratioY);
    return {scale,ox:(pixelWidth-state.width*scale)/2,oy:(pixelHeight-state.height*scale)/2};
  }
  function paintBase(target,omittedId=null) {
    const w=target.canvas.width,h=target.canvas.height;
    target.setTransform(1,0,0,1,0,0);
    target.fillStyle="#171716";
    target.fillRect(0,0,w,h);
    if (!state.sourceImage) return;
    const tr=viewportTransform(w,h);
    target.save();
    target.beginPath(); target.rect(0,0,w,h); target.clip();
    target.setTransform(tr.scale,0,0,tr.scale,tr.ox,tr.oy);
    target.drawImage(state.sourceImage,0,0,state.width,state.height);
    drawHoles(target,state.holes);
    if (state.showConnections) for (const link of state.connections) {
      if (link.fromId===omittedId || link.toId===omittedId) continue;
      drawConnection(target,link);
    }
    for (const char of state.characters) if (char.id!==omittedId) drawCharacter(target,char);
    target.restore();
  }
  function cacheScene(omittedId=null) {
    if (!state.sourceImage) return;
    if (staticCanvas.width!==artCanvas.width || staticCanvas.height!==artCanvas.height) {
      staticCanvas.width=artCanvas.width; staticCanvas.height=artCanvas.height;
    }
    paintBase(staticCtx,omittedId);
  }
  function redraw() {
    if (!state.sourceImage) return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(staticCanvas,0,0);
    if (state.animation) drawAnimationFrame(state.animation);
  }
  function refreshScene() {
    if (!state.sourceImage) return;
    cacheScene(state.animation?.type==="unstitch"?state.animation.char.id:null);
    redraw();
    updateOverlays();
  }
  function resizeViewport() {
    if (workspace.hidden || !state.sourceImage) return;
    const rect=artCanvas.getBoundingClientRect();
    if (!rect.width||!rect.height) return;
    const dpr=Math.min(window.devicePixelRatio||1,2);
    const w=Math.max(1,Math.round(rect.width*dpr));
    const h=Math.max(1,Math.round(rect.height*dpr));
    if (artCanvas.width!==w||artCanvas.height!==h) {
      artCanvas.width=w;artCanvas.height=h;
    }
    refreshScene();
  }
  function canvasToPhoto(event) {
    const rect=artCanvas.getBoundingClientRect();
    const px=(event.clientX-rect.left)*artCanvas.width/rect.width;
    const py=(event.clientY-rect.top)*artCanvas.height/rect.height;
    const tr=viewportTransform();
    const x=(px-tr.ox)/tr.scale,y=(py-tr.oy)/tr.scale;
    if (x<0||y<0||x>=state.width||y>=state.height) return null;
    return {x,y};
  }
  function photoToScreen(x,y) {
    const tr=viewportTransform();
    const rect=artCanvas.getBoundingClientRect();
    return {x:(tr.ox+x*tr.scale)*rect.width/artCanvas.width,y:(tr.oy+y*tr.scale)*rect.height/artCanvas.height,scale:tr.scale*rect.width/artCanvas.width};
  }
  function hitTest(point) {
    for (let i=state.characters.length-1;i>=0;i--) {
      const c=state.characters[i];
      const pad=clamp(c.size*.07,3,8);
      if (point.x>=c.x-pad && point.x<=c.x+c.advance+pad && point.y>=c.y-c.ascent-pad && point.y<=c.y+c.descent+pad) {
        // Thin letters are still selectable via their text bounding box.
        return c;
      }
    }
    return null;
  }
  function updateOverlays() {
    if (!state.sourceImage) return;
    const selected=findChar(state.selectedId);
    selectionBox.classList.toggle("visible",!!selected && !state.isAnimating);
    if (selected && !state.isAnimating) {
      const a=photoToScreen(selected.x,selected.y-selected.ascent);
      const b=photoToScreen(selected.x+selected.advance,selected.y+selected.descent);
      selectionBox.style.left=`${a.x-3}px`;
      selectionBox.style.top=`${a.y-3}px`;
      selectionBox.style.width=`${Math.max(5,b.x-a.x+6)}px`;
      selectionBox.style.height=`${Math.max(5,b.y-a.y+6)}px`;
    }
    const active=state.active && !selected && !state.isAnimating;
    const position=photoToScreen(state.cursorX,state.cursorY);
    caret.style.left=`${position.x}px`;
    caret.style.top=`${position.y-state.defaults.size*position.scale*.83}px`;
    caret.style.height=`${state.defaults.size*position.scale}px`;
    caret.classList.toggle("visible",active && !state.imeDraft);
    ghost.classList.toggle("visible",active && !!state.imeDraft);
    if (active && state.imeDraft) {
      ghost.textContent=state.imeDraft;
      ghost.style.left=`${position.x}px`;
      ghost.style.top=`${position.y}px`;
      ghost.style.fontSize=`${state.defaults.size*position.scale}px`;
    } else ghost.textContent="";
    deleteBtn.disabled=state.isAnimating || !selected;
  }
  function hideGhost() { ghost.textContent="";ghost.classList.remove("visible"); }
  function startAt(x,y) {
    if (state.isAnimating) return;
    resetEditing();
    state.active=true;
    state.cursorX=x;
    state.cursorY=clamp(y,state.defaults.size*.9,state.height-2);
    state.lineStartX=x;
    state.runId+=1;
    state.lineId=0;
    state.lastCharacterId=null;
    state.imeDraft="";
    imeInput.disabled=false;
    updateOverlays();
    focusTyping();
    notify("Start typing. Korean: press Space to sew one syllable.");
  }
  function selectCharacter(char) {
    resetEditing();
    state.selectedId=char.id;
    state.active=false;
    syncControls();
    artCanvas.focus({preventScroll:true});
    updateOverlays();
    notify(`${char.text} selected. Adjust settings or press Delete.`);
  }
  function focusTyping() {
    if (!state.active || state.isAnimating) return;
    try {imeInput.focus({preventScroll:true});} catch {imeInput.focus();}
  }
  function lineBreak() {
    state.cursorX=state.lineStartX;
    state.cursorY=clamp(state.cursorY+state.defaults.size*1.35,state.defaults.size,state.height-1);
    state.lineId++;
    state.lastCharacterId=null;
    updateOverlays();
  }
  function insertSpace() {
    state.cursorX+=state.defaults.size*.36;
    // Spaces keep the thread continuous until a line break or a new placement.
    updateOverlays();
  }

  function createChar(text) {
    const size=state.defaults.size;
    let metrics=measureChar(text,size);
    if (state.cursorX+metrics.advance>state.width-4 && state.cursorX>state.lineStartX+size*.15) {
      lineBreak();
      metrics=measureChar(text,size);
    }
    const order=state.nextOrder++;
    const char={
      id:`c${Date.now().toString(36)}-${order}`,text,x:round2(state.cursorX),y:round2(state.cursorY),
      size,density:state.defaults.density,match:state.defaults.match,variation:state.defaults.variation,
      seed:(hashString(text)^hashString(`${order}:${state.runId}`)^Math.floor(state.cursorX*23)^Math.floor(state.cursorY*13))>>>0,
      order,runId:state.runId,lineId:state.lineId,legacyColor:null,stitches:[],
      advance:round2(metrics.advance),ascent:metrics.ascent,descent:metrics.descent,
    };
    buildStitches(char);
    return char;
  }
  function easeOut(t) {return 1-(1-t)**2.3;}
  function drawAnimationFrame(animation) {
    const tr=viewportTransform();
    ctx.save();
    ctx.setTransform(tr.scale,0,0,tr.scale,tr.ox,tr.oy);
    if (animation.type==="stitch") {
      const t=animation.progress;
      if (state.showConnections && animation.link) drawConnection(ctx,animation.link,0,clamp(t/.23,0,1));
      const progress=clamp((t-.16)/.84,0,1);
      const count=Math.floor(easeOut(progress)*animation.char.stitches.length);
      drawCharacter(ctx,animation.char,count);
      if (count>0 && count<animation.char.stitches.length && !reducedMotion()) {
        const tip=animation.char.stitches[count-1];
        const pulse=1+.65*Math.sin(performance.now()*.03);
        ctx.fillStyle=rgbString(shade(tip.color,58),.57);
        ctx.beginPath();ctx.arc(tip.x2,tip.y2,clamp(pulse*.65,.55,1.25),0,Math.PI*2);ctx.fill();
      }
    } else if (animation.type==="unstitch") {
      const t=animation.progress;
      const total=animation.char.stitches.length;
      const keep=Math.floor((1-easeOut(t))*total);
      drawHoles(ctx,animation.newHoles.filter(h=>h.afterIndex>=keep));
      drawCharacter(ctx,animation.char,keep);
      if (state.showConnections) {
        for (const link of animation.links) drawConnection(ctx,link,0,clamp(1-t*1.8,0,1));
      }
      // One loose lifted fiber tracks the reversing end of the removed stitch.
      if (keep>0 && keep<total && !reducedMotion()) {
        const s=animation.char.stitches[keep-1];
        const lift=5+5*Math.sin(t*Math.PI);
        ctx.strokeStyle=rgbString(s.color,.72);
        ctx.lineWidth=Math.max(.5,s.width*.65);
        ctx.beginPath();ctx.moveTo(s.x2,s.y2);
        ctx.quadraticCurveTo(s.x2+lift*.42,s.y2-lift,s.x2+lift,s.y2-lift*.65);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function runAnimation(animation,duration) {
    state.animation=animation;
    const ms=reducedMotion()?1:duration;
    return new Promise(resolve=>{
      const started=performance.now();
      const frame=(now)=>{
        // No buffered keyboard events are re-injected on completion.
        animation.progress=clamp((now-started)/ms,0,1);
        redraw();
        if (animation.progress<1) sleepFrame(frame);
        else resolve();
      };
      sleepFrame(frame);
    });
  }
  async function sewCharacter(text,enterAfter=false,remainder="") {
    if (!state.active || state.isAnimating) return;
    const char=createChar(text);
    const last=findChar(state.lastCharacterId);
    const link=last && last.runId===char.runId && last.lineId===char.lineId ? connectionBetween(last,char) : null;
    // Consume and clear all native input before locking, including any delimiter
    // that the IME may have inserted as part of compositionend.
    state.imeDraft="";
    imeInput.value="";
    state.pendingDelimiter=null;
    setBusy(true);
    cacheScene();
    const duration=clamp(240+char.stitches.length*(isHangulSyllable(text)?1.1:.85),340,isHangulSyllable(text)?1100:850);
    await runAnimation({type:"stitch",char,link,progress:0},duration+(link?150:0));
    state.characters.push(char);
    if (link) state.connections.push(link);
    state.lastCharacterId=char.id;
    state.cursorX=char.x+char.advance+Math.max(1,char.size*.025);
    state.cursorY=char.y;
    if (enterAfter) lineBreak();
    state.animation=null;
    state.imeDraft=remainder;
    imeInput.value=remainder;
    setBusy(false);
    refreshScene();
    persistNow();
    focusTyping();
    notify(`${text} stitched`);
  }
  async function unstitchCharacter(char) {
    if (!char || state.isAnimating) return;
    const related=state.connections.filter(c=>c.fromId===char.id || c.toId===char.id);
    const newHoles=makeHolesFor(char);
    const wasLast=state.characters[state.characters.length-1]?.id===char.id;
    const returnCursor=wasLast && state.active && state.runId===char.runId && state.lineId===char.lineId;
    setBusy(true);
    state.selectedId=null;
    const anim={type:"unstitch",char,links:related,newHoles,progress:0};
    state.animation=anim;
    cacheScene(char.id);
    await runAnimation(anim,clamp(330+char.stitches.length*.9,430,1150));
    state.characters=state.characters.filter(c=>c.id!==char.id);
    state.connections=state.connections.filter(c=>c.fromId!==char.id && c.toId!==char.id);
    state.holes.push(...newHoles);
    if (returnCursor) {
      state.cursorX=char.x;
      state.cursorY=char.y;
      const previous=state.characters.filter(c=>c.runId===char.runId && c.lineId===char.lineId && c.order<char.order).at(-1);
      state.lastCharacterId=previous?.id||null;
    }
    if (state.lastCharacterId===char.id) state.lastCharacterId=null;
    state.animation=null;
    setBusy(false);
    refreshScene();
    persistNow();
    if (state.active) focusTyping();
    notify("Thread removed. Needle marks remain.");
  }
  function undoLast() {if (!state.isAnimating) void unstitchCharacter(state.characters.at(-1));}
  function deleteSelected() {if (!state.isAnimating) void unstitchCharacter(findChar(state.selectedId));}
  function clearAll() {
    if (state.isAnimating) return;
    state.characters=[];state.connections=[];state.holes=[];state.nextOrder=1;
    resetEditing();
    refreshScene();
    persistNow();
    notify("All stitches and needle marks cleared.");
  }
  function startOver() {
    if (state.isAnimating) return;
    const oldId=state.photoId;
    currentPhotoGeneration++;
    resetEditing();
    state.sourceImage=null;state.photoId="";state.fallbackUrl="";state.characters=[];state.connections=[];state.holes=[];
    state.width=0;state.height=0;state.pixels=null;
    state.animation=null;
    state.panelOpen=false;
    controls.setAttribute("aria-hidden","true");
    workspace.classList.remove("panel-open","panel-peeking");
    workspace.hidden=true;
    landing.hidden=false;
    fileInput.value="";
    localStorage.removeItem(STORAGE_KEY);
    // Remove the legacy snapshot too, otherwise the next reload would restore it.
    localStorage.removeItem(LEGACY_KEY);
    if (oldId) void idbRemove(oldId);
    notify("Ready for a new image.");
  }

  function synchronizeCharacterChange(char,key,value) {
    if (!char || state.isAnimating) return;
    const previousWidth=char.advance;
    char[key]=value;
    if (key==="match"||key==="variation") char.legacyColor=null;
    buildStitches(char);
    if (key==="size") {
      const shift=char.advance-previousWidth;
      if (Math.abs(shift)>.01) {
        const later=state.characters.filter(c=>c.runId===char.runId && c.lineId===char.lineId && c.order>char.order);
        for (const other of later) {other.x=round2(other.x+shift);buildStitches(other);}
        if (state.active && state.runId===char.runId && state.lineId===char.lineId && state.cursorX>char.x) {
          state.cursorX+=shift;
        }
      }
    }
    refreshConnections();
    refreshScene();
    queuePersist();
  }
  function syncControls() {
    const char=findChar(state.selectedId);
    const values=char || state.defaults;
    sizeRange.value=values.size;
    densityRange.value=values.density;
    matchRange.value=values.match;
    variationRange.value=values.variation;
    $("sizeValue").textContent=String(values.size);
    $("densityValue").textContent=String(values.density);
    $("matchValue").textContent=String(values.match);
    $("variationValue").textContent=String(values.variation);
    editContext.textContent=char ? `EDITING “${char.text}”` : "NEXT STITCH";
    deleteBtn.disabled=state.isAnimating || !char;
  }
  function applySetting(key,value) {
    if (state.isAnimating) return;
    const char=findChar(state.selectedId);
    if (char) synchronizeCharacterChange(char,key,value);
    else {state.defaults[key]=value;updateOverlays();queuePersist();}
    syncControls();
  }

  function exportPng() {
    if (!state.sourceImage || state.isAnimating) return;
    // Export from the complete photograph (not the cropped cover preview),
    // preferably at its native resolution. Include only saved artwork.
    const createExportCanvas=(nativeResolution)=>{
      const canvas=document.createElement("canvas");
      canvas.width=nativeResolution?state.originalWidth:state.width;
      canvas.height=nativeResolution?state.originalHeight:state.height;
      const target=canvas.getContext("2d");
      if (!target) throw new Error("Could not allocate export canvas");
      target.drawImage(nativeResolution?state.sourceImage:baseCanvas,0,0,canvas.width,canvas.height);
      target.save();
      target.scale(canvas.width/state.width,canvas.height/state.height);
      drawHoles(target,state.holes);
      if (state.showConnections) for (const link of state.connections) drawConnection(target,link);
      for (const char of state.characters) drawCharacter(target,char);
      target.restore();
      return canvas;
    };
    const download=(blob)=>{
      if (!blob) {notify("PNG export failed on this browser.");return;}
      const url=URL.createObjectURL(blob);
      const anchor=document.createElement("a");
      anchor.href=url;
      anchor.download=`embroidered-memory-${new Date().toISOString().replace(/[:.]/g,"-")}.png`;
      document.body.appendChild(anchor);anchor.click();anchor.remove();
      setTimeout(()=>URL.revokeObjectURL(url),6000);
    };
    const tryExport=(nativeResolution)=>{
      try {
        const canvas=createExportCanvas(nativeResolution);
        canvas.toBlob((blob)=>{
          if (blob) download(blob);
          else if (nativeResolution) tryExport(false);
          else notify("PNG export could not be completed.");
        },"image/png");
      } catch (error) {
        console.warn("PNG export canvas could not be created.",error);
        if (nativeResolution) tryExport(false);
        else notify("PNG export could not be completed.");
      }
    };
    tryExport(true);
  }

  function normalizeBuffer(s) {return s.replace(/[\r\n\u0000]+/g,"").replace(/[ \t]+$/g,"");}
  function safeDraftFromInput() {
    if (state.isAnimating) return;
    state.imeDraft=normalizeBuffer(imeInput.value);
    updateOverlays();
  }
  function delimiter(kind) {
    if (state.isAnimating || !state.active) return;
    // Some IMEs dispatch a second synthetic keydown for the same physical
    // delimiter after compositionend. This guard prevents a spurious space or
    // newline; it does not block a genuine second press after the animation.
    const now=performance.now();
    if (kind===state.lastDelimiterKey && now-state.lastDelimiterAt<85) return;
    state.lastDelimiterKey=kind;
    state.lastDelimiterAt=now;
    const text=normalizeBuffer(imeInput.value || state.imeDraft);
    const units=graphemes(text);
    if (!units.length) {
      imeInput.value="";state.imeDraft="";
      if (kind==="space") insertSpace(); else lineBreak();
      return;
    }
    const first=units[0];
    // Never stitch incomplete Hangul jamo, even if an IME sent compositionend.
    if (isKoreanJamo(first) || (/\p{Script=Hangul}/u.test(first) && !isHangulSyllable(first))) {
      state.imeDraft=text;
      imeInput.value=text;
      updateOverlays();
      return;
    }
    const remainder=units.slice(1).join("");
    void sewCharacter(first,kind==="enter",remainder);
  }
  function consumePendingDelimiter() {
    const kind=state.pendingDelimiter;
    if (!kind || state.composing || state.isAnimating) return;
    state.pendingDelimiter=null;
    // compositionend can precede the final input event; setTimeout(0) runs
    // after that event's value update in mainstream Safari/Chrome IMEs.
    setTimeout(()=>{
      if (state.isAnimating || !state.active) return;
      safeDraftFromInput();
      delimiter(kind);
    },0);
  }
  function onInput(event) {
    if (state.isAnimating) {imeInput.value="";return;}
    if (!state.active) {imeInput.value="";return;}
    safeDraftFromInput();
    if (state.composing || state.pendingDelimiter) return;
    // Some mobile/Safari IMEs insert a delimiter using input/beforeinput
    // without a conventional Space/Enter keydown.
    const trailingSpace = /[ \t]$/.test(imeInput.value);
    if ((event?.data===" " || trailingSpace) && graphemes(state.imeDraft).length) {
      delimiter("space");
      return;
    }
    const units=graphemes(state.imeDraft);
    if (!units.length) return;
    const first=units[0];
    // Korean is always ghost-only until a Space/Enter delimiter. English
    // (including punctuation and emoji) is stitched immediately, one grapheme.
    if (isHangulSyllable(first) || isKoreanJamo(first) || /\p{Script=Hangul}/u.test(first)) return;
    void sewCharacter(first,false,units.slice(1).join(""));
  }
  function onKeyDown(event) {
    if (!state.active && !state.selectedId) return;
    if (state.isAnimating) {event.preventDefault();return;}
    if ((event.metaKey||event.ctrlKey) && event.key.toLowerCase()==="z") {
      event.preventDefault();undoLast();return;
    }
    if (event.key==="Escape") {
      if (state.composing) return; // Native IME cancel must win.
      event.preventDefault();
      imeInput.value="";state.imeDraft="";state.pendingDelimiter=null;
      if (state.selectedId) resetEditing();
      updateOverlays();return;
    }
    if (state.selectedId && (event.key==="Delete" || event.key==="Backspace")) {
      event.preventDefault();deleteSelected();return;
    }
    if (!state.active) return;
    const space=event.key===" "||event.code==="Space";
    const enter=event.key==="Enter";
    const composing=state.composing||event.isComposing||event.keyCode===229;
    if (composing) {
      if (space||enter) state.pendingDelimiter=space?"space":"enter";
      // Do NOT preventDefault: it can prevent Korean compositionend on Safari.
      return;
    }
    if (space||enter) {
      event.preventDefault();
      if (state.pendingDelimiter) {consumePendingDelimiter();return;}
      delimiter(space?"space":"enter");
      return;
    }
    if (event.key==="Backspace" && !imeInput.value) {
      event.preventDefault();undoLast();
    }
  }

  let dragDepth=0;
  function onDragOver(e) {
    if (!Array.from(e.dataTransfer?.types || []).includes("Files")) return;
    e.preventDefault();e.dataTransfer.dropEffect="copy";
    landing.classList.add("is-dragging");
  }
  function handleDrop(e) {
    e.preventDefault();
    dragDepth=0;landing.classList.remove("is-dragging");
    if (state.isAnimating) return;
    const file=[...(e.dataTransfer.files || [])].find(f=>f.type.startsWith("image/"));
    if (file) void receiveFile(file);
  }

  function setPanelOpen(open) {
    state.panelOpen=open;
    workspace.classList.toggle("panel-open",open);
    controls.setAttribute("aria-hidden",open?"false":"true");
    menuToggle.setAttribute("aria-expanded",String(open));
    if (open) { clearTimeout(panelHideTimer);workspace.classList.add("panel-peeking"); }
    else {
      workspace.classList.remove("panel-peeking");
      // A closed settings panel must not retain focus on an invisible button.
      // Resume the existing insertion point after a user closes the panel.
      if (state.active && !state.isAnimating &&
          (controls.contains(document.activeElement) || document.activeElement === menuToggle)) {
        focusTyping();
      }
    }
  }
  function hidePanelLater() {
    clearTimeout(panelHideTimer);
    panelHideTimer=setTimeout(()=>{
      if (controls.contains(document.activeElement) || document.activeElement===menuToggle) return;
      setPanelOpen(false);
    },690);
  }
  function pointerForPanel(e) {
    if (e.pointerType==="touch") return;
    if (e.clientY<=72) {clearTimeout(panelHideTimer);setPanelOpen(true);return;}
    if (state.panelOpen) {
      const r=controls.getBoundingClientRect();
      if (e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom) clearTimeout(panelHideTimer);
      else hidePanelLater();
    }
  }
  function migrateV1(old) {
    const characters=[];
    const connections=[];
    let order=1;
    // The old format stores one entire text string in each object.
    // Preserve its image, baseline, font size and (when present) original color.
    for (const [groupIndex,obj] of (old.objects||[]).entries()) {
      let x=Number(obj.x)||0;
      const text=String(obj.text||"");
      let prev=null;
      for (const [index,unit] of graphemes(text).entries()) {
        if (/^\s+$/u.test(unit)) {x+=(Number(obj.fontSize)||48)*.36;continue;}
        const char={
          id:`legacy-${groupIndex}-${index}`,text:unit,x,y:Number(obj.y)||0,
          size:Number(obj.fontSize)||48,density:55,match:88,variation:0,
          seed:((Number(obj.seed)||hashString(text))^index*7919)>>>0,
          order:order++,runId:groupIndex+1,lineId:0,
          legacyColor:obj.color||null,stitches:[],
        };
        buildStitches(char);
        characters.push(char);
        if (prev) {const link=connectionBetween(prev,char);if (link) connections.push(link);}
        prev=char;x+=char.advance;
      }
    }
    return {characters,connections,nextOrder:order};
  }
  async function restoreProject() {
    let saved=null,legacy=false;
    try {saved=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");} catch { /* corrupted state */ }
    if (!saved) {
      try {saved=JSON.parse(localStorage.getItem(LEGACY_KEY)||"null");legacy=!!saved?.imageDataUrl;} catch {saved=null;}
    }
    if (!saved) return;
    try {
      let image=null;
      if (!legacy && saved.photoId) {
        try {
          const blob=await idbRead(saved.photoId);
          if (blob) image=await decodeBlob(blob);
        } catch (error) {console.warn("Image could not be read from IndexedDB.",error);}
      }
      if (!image && (saved.fallbackUrl||saved.imageDataUrl)) image=await loadImage(saved.fallbackUrl||saved.imageDataUrl);
      if (!image) return;
      initializePhoto(image,{photoId:legacy?`migrated-${Date.now()}`:saved.photoId,
        fallbackUrl:saved.fallbackUrl||saved.imageDataUrl,
        workWidth:legacy?null:(Number(saved.workWidth)||null),
        workHeight:legacy?null:(Number(saved.workHeight)||null)});
      state.characters=[];state.connections=[];state.holes=[];
      if (legacy) {
        const migrated=migrateV1(saved);
        state.characters=migrated.characters;
        state.connections=migrated.connections;
        state.nextOrder=migrated.nextOrder;
        state.defaults.size=clamp(Math.round(state.width*.049),28,122);
      } else {
        state.defaults={...state.defaults,...saved.defaults};
        state.viewMode=saved.viewMode==="contain"?"contain":"cover";
        state.showConnections=saved.showConnections!==false;
        state.characters=(Array.isArray(saved.characters)?saved.characters:[]).map(meta=>{
          const char={...meta,stitches:[]};
          char.seed=(Number(char.seed)||1)>>>0;
          char.density=Number.isFinite(char.density)?char.density:55;
          char.match=Number.isFinite(char.match)?char.match:88;
          char.variation=Number.isFinite(char.variation)?char.variation:92;
          buildStitches(char);
          return char;
        });
        state.connections=Array.isArray(saved.connections)?saved.connections:[];
        state.holes=Array.isArray(saved.holes)?saved.holes:[];
        state.nextOrder=Number(saved.nextOrder)||state.characters.length+1;
        refreshConnections();
      }
      state.runId=Math.max(0,...state.characters.map(c=>c.runId||0));
      state.active=false;
      fitSelect.value=state.viewMode;
      connectionToggle.checked=state.showConnections;
      syncControls();
      resizeViewport();
      refreshScene();
      if (legacy) {
        // Keep v1 intact for rollback; only create an additional v2 snapshot.
        persistNow();
        try {const blob=await (await fetch(saved.imageDataUrl)).blob();await idbWrite(state.photoId,blob);} catch { /* localStorage fallback still works */ }
      }
      notify("Previous stitches restored.");
    } catch (error) {
      console.error("Restore failed. Legacy data has not been deleted.",error);
      landing.hidden=false;workspace.hidden=true;
    }
  }

  // ----- DOM events -----
  fileInput.addEventListener("change", e=>{
    const file=e.target.files?.[0];if (file) void receiveFile(file);
  });
  uploadTarget.addEventListener("keydown",e=>{
    if (e.key==="Enter"||e.key===" ") {e.preventDefault();fileInput.click();}
  });
  window.addEventListener("dragenter", e=>{if (Array.from(e.dataTransfer?.types || []).includes("Files")) {dragDepth++;landing.classList.add("is-dragging");}});
  window.addEventListener("dragover",onDragOver);
  window.addEventListener("dragleave",()=>{dragDepth=Math.max(0,dragDepth-1);if (!dragDepth) landing.classList.remove("is-dragging");});
  window.addEventListener("drop",handleDrop);
  artCanvas.addEventListener("pointerdown",e=>{
    if (e.button!==0 || state.isAnimating) return;
    // Prevent the pointerdown default from re-focusing the canvas after the
    // hidden IME textarea has been focused. Otherwise English typing is lost.
    e.preventDefault();
    const point=canvasToPhoto(e);
    if (!point) return;
    const char=hitTest(point);
    if (char) selectCharacter(char);
    else startAt(point.x,point.y);
  });
  imeInput.addEventListener("compositionstart",()=>{
    if (state.isAnimating) return;
    state.composing=true;
    state.pendingDelimiter=null;
    safeDraftFromInput();
  });
  imeInput.addEventListener("compositionupdate",()=>{
    if (!state.isAnimating) requestAnimationFrame(safeDraftFromInput);
  });
  imeInput.addEventListener("compositionend",()=>{
    state.composing=false;
    setTimeout(()=>{
      if (state.isAnimating) return;
      safeDraftFromInput();
      consumePendingDelimiter();
    },0);
  });
  imeInput.addEventListener("beforeinput",e=>{
    if (state.isAnimating || !state.active) return;
    if (e.inputType==="insertLineBreak" || e.inputType==="insertParagraph") {
      if (state.composing) state.pendingDelimiter="enter";
      else {e.preventDefault();delimiter("enter");}
    }
  });
  imeInput.addEventListener("input",onInput);
  imeInput.addEventListener("keydown",onKeyDown);
  artCanvas.addEventListener("keydown",onKeyDown);
  window.addEventListener("keydown",e=>{
    // On a disabled textarea focus can move to body while animating. Silently
    // reject all subsequent typing instead of buffering it anywhere.
    if (state.isAnimating && !e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault();
  },true);
  window.addEventListener("resize",resizeViewport);
  document.addEventListener("visibilitychange",()=>{if (document.hidden) persistNow();});
  window.addEventListener("pagehide",persistNow);
  window.addEventListener("pointermove",pointerForPanel);
  menuToggle.addEventListener("click",()=>setPanelOpen(!state.panelOpen));
  closePanel.addEventListener("click",()=>setPanelOpen(false));
  controls.addEventListener("pointerenter",()=>clearTimeout(panelHideTimer));
  controls.addEventListener("pointerleave",hidePanelLater);
  controls.addEventListener("focusin",()=>setPanelOpen(true));
  controls.addEventListener("focusout",()=>setTimeout(()=>{if (!controls.contains(document.activeElement)) hidePanelLater();},0));
  menuToggle.addEventListener("focus",()=>setPanelOpen(true));
  sizeRange.addEventListener("input",e=>applySetting("size",Number(e.target.value)));
  densityRange.addEventListener("input",e=>applySetting("density",Number(e.target.value)));
  matchRange.addEventListener("input",e=>applySetting("match",Number(e.target.value)));
  variationRange.addEventListener("input",e=>applySetting("variation",Number(e.target.value)));
  fitSelect.addEventListener("change",e=>{state.viewMode=e.target.value;refreshScene();queuePersist();});
  connectionToggle.addEventListener("change",e=>{state.showConnections=e.target.checked;refreshScene();queuePersist();});
  undoBtn.addEventListener("click",undoLast);
  deleteBtn.addEventListener("click",deleteSelected);
  clearBtn.addEventListener("click",clearAll);
  newBtn.addEventListener("click",startOver);
  exportBtn.addEventListener("click",exportPng);
  syncControls();
  void restoreProject();
})();
