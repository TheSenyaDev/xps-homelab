// Smooth pan/zoom PDF viewer built on a vendored, offline pdf.js.
//
// The feel-good trick (the "Excalidraw" part): during a gesture we only mutate a
// single CSS `transform: translate() scale()` on the page container, which the
// browser composites on the GPU — so pan/zoom is buttery regardless of page
// resolution. We *don't* re-rasterize mid-gesture. When the user stops, a
// debounced pass re-renders the visible pages at the new zoom (double-buffered
// to avoid a flash) so they're pixel-crisp again.
//
// Coordinates: "world units" = CSS px at zoom 1 (page fit to stage width). Pages
// are absolutely positioned in world units inside #pdf-wrap; only the wrap's
// transform changes for pan/zoom, so page gaps scale correctly and re-raster
// never needs to touch geometry.

import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.mjs";

const DPR = Math.min(window.devicePixelRatio || 1, 2); // cap for memory
const GAP = 16;          // world px between pages
const PAD = 24;          // world px breathing room at fit width
const MAX_CANVAS = 4096; // hard cap on a rasterized page's longest side
const SETTLE_MS = 140;

export class PdfView {
  constructor(stage, wrap, { onState } = {}) {
    this.stage = stage;
    this.wrap = wrap;
    this.onState = onState || (() => {});
    this.pages = [];
    this.pdf = null;
    this._task = null;     // active getDocument task (for supersede checks)
    this._raf = 0;
    this._settle = null;
    this.minScale = 0.2;
    this.maxScale = 8;
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.fitScale = 1;     // world px per PDF point
    this._lastW = 0;       // stage width at last layout (ignore no-op RO fires)
    this.pointers = new Map();
    this.lastPinch = null;
    this._bind();

    const ro = new ResizeObserver(() => {
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => this._relayout(), 150);
    });
    ro.observe(stage);
  }

  // ---------- loading ----------

  async load(url) {
    this._reset();
    const task = pdfjsLib.getDocument({ url });
    this._task = task;
    let pdf;
    try {
      pdf = await task.promise;
    } catch (e) {
      if (this._task === task) console.error("[boox] pdf load failed", e);
      return;
    }
    if (this._task !== task) { pdf.destroy?.(); return; } // a newer load won
    this.pdf = pdf;
    await this._build();
    this.fit();
    for (const p of this.pages) this._renderPage(p, 1); // first paint at fit
  }

  _reset() {
    this._task = null;
    for (const p of this.pages) { try { p.renderTask?.cancel(); } catch {} }
    if (this.pdf) { try { this.pdf.destroy(); } catch {} this.pdf = null; }
    this.pages = [];
    this.wrap.innerHTML = "";
    this.pointers.clear();
    this.lastPinch = null;
  }

  async _build() {
    const stageW = this.stage.clientWidth || 800;
    const dims = [];
    let maxW = 1;
    for (let i = 1; i <= this.pdf.numPages; i++) {
      const page = await this.pdf.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      dims.push({ page, ptW: vp.width, ptH: vp.height });
      maxW = Math.max(maxW, vp.width);
    }
    this.fitScale = (stageW - PAD * 2) / maxW;
    this._lastW = stageW;
    let y = GAP;
    for (const d of dims) {
      const w = d.ptW * this.fitScale, h = d.ptH * this.fitScale;
      const holder = document.createElement("div");
      holder.className = "pdf-page";
      const canvas = document.createElement("canvas");
      holder.appendChild(canvas);
      this.wrap.appendChild(holder);
      const p = { ...d, w, h, y0: y, holder, canvas, renderedZoom: 0, renderTask: null };
      this._place(p, stageW);
      this.pages.push(p);
      y += h + GAP;
    }
    this.wrap.style.width = stageW + "px";
    this.wrap.style.height = y + "px";
  }

  _place(p, stageW) {
    p.holder.style.width = p.w + "px";
    p.holder.style.height = p.h + "px";
    p.holder.style.left = (stageW - p.w) / 2 + "px";
    p.holder.style.top = p.y0 + "px";
    p.canvas.style.width = p.w + "px";
    p.canvas.style.height = p.h + "px";
  }

  _relayout() {
    if (!this.pages.length) return;
    const stageW = this.stage.clientWidth || 800;
    if (stageW === this._lastW) return; // RO fired but width didn't change → no-op
    this._lastW = stageW;
    let maxW = 1;
    for (const p of this.pages) maxW = Math.max(maxW, p.ptW);
    this.fitScale = (stageW - PAD * 2) / maxW;
    let y = GAP;
    for (const p of this.pages) {
      p.w = p.ptW * this.fitScale; p.h = p.ptH * this.fitScale; p.y0 = y;
      this._place(p, stageW);
      p.renderedZoom = 0; // fitScale changed → force a re-raster
      y += p.h + GAP;
    }
    this.wrap.style.width = stageW + "px";
    this.wrap.style.height = y + "px";
    this.fit();
  }

  // ---------- rendering ----------

  _visible(p) {
    const top = this.ty + this.scale * p.y0;
    const bot = this.ty + this.scale * (p.y0 + p.h);
    const margin = this.stage.clientHeight * 0.6;
    return bot > -margin && top < this.stage.clientHeight + margin;
  }

  async _renderPage(p, zoom) {
    zoom = Math.min(Math.max(zoom, this.minScale), this.maxScale);
    if (Math.abs(p.renderedZoom - zoom) < 0.01 && p.canvas.width > 0) return;
    let renderScale = this.fitScale * zoom * DPR;
    let vp = p.page.getViewport({ scale: renderScale });
    const longest = Math.max(vp.width, vp.height);
    if (longest > MAX_CANVAS) vp = p.page.getViewport({ scale: renderScale * (MAX_CANVAS / longest) });

    try { p.renderTask?.cancel(); } catch {}
    const off = document.createElement("canvas");
    off.width = Math.round(vp.width);
    off.height = Math.round(vp.height);
    off.style.width = p.w + "px";
    off.style.height = p.h + "px";
    const ctx = off.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, off.width, off.height);

    const task = p.page.render({ canvasContext: ctx, viewport: vp });
    p.renderTask = task;
    try {
      await task.promise;
      p.holder.replaceChild(off, p.canvas); // double-buffer swap, no flash
      p.canvas = off;
      p.renderedZoom = zoom;
    } catch { /* cancelled / superseded */ }
    finally { if (p.renderTask === task) p.renderTask = null; }
  }

  _scheduleSettle() {
    clearTimeout(this._settle);
    this._settle = setTimeout(() => {
      for (const p of this.pages) if (this._visible(p)) this._renderPage(p, this.scale);
    }, SETTLE_MS);
  }

  // ---------- transform ----------

  _apply() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.wrap.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
      this.onState(this.scale);
    });
  }

  _zoomAround(px, py, next) {
    next = Math.min(Math.max(next, this.minScale), this.maxScale);
    const k = next / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = next;
    this._apply();
    this._scheduleSettle();
  }

  fit() {
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this._apply();
    this._scheduleSettle();
  }

  zoomBy(f) {
    this._zoomAround(this.stage.clientWidth / 2, this.stage.clientHeight / 2, this.scale * f);
  }

  // ---------- input ----------

  _xy(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _bind() {
    const s = this.stage;
    s.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
    s.addEventListener("pointerdown", (e) => this._onDown(e));
    s.addEventListener("pointermove", (e) => this._onMove(e));
    const up = (e) => this._onUp(e);
    s.addEventListener("pointerup", up);
    s.addEventListener("pointercancel", up);
    s.addEventListener("dblclick", (e) => this._onDbl(e));
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) { // trackpad pinch + ctrl+wheel = zoom toward cursor
      const { x, y } = this._xy(e);
      this._zoomAround(x, y, this.scale * Math.exp(-e.deltaY * 0.0015));
    } else {
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
      this._apply();
      this._scheduleSettle();
    }
  }

  _onDown(e) {
    this.stage.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this._xy(e));
    this.stage.classList.add("panning");
  }

  _onMove(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const prev = this.pointers.get(e.pointerId);
    const cur = this._xy(e);
    this.pointers.set(e.pointerId, cur);
    const pts = [...this.pointers.values()];
    if (pts.length === 1) {
      this.tx += cur.x - prev.x;
      this.ty += cur.y - prev.y;
      this._apply();
      this._scheduleSettle();
    } else if (pts.length >= 2) {
      const [a, b] = pts;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (this.lastPinch) {
        this.tx += mx - this.lastPinch.mx;
        this.ty += my - this.lastPinch.my;
        this._zoomAround(mx, my, this.scale * (dist / this.lastPinch.dist));
      }
      this.lastPinch = { dist, mx, my };
    }
  }

  _onUp(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.lastPinch = null;
    if (this.pointers.size === 0) this.stage.classList.remove("panning");
  }

  _onDbl(e) {
    const { x, y } = this._xy(e);
    this._zoomAround(x, y, this.scale > 1.2 ? 1 : 2); // toggle fit <-> 2x at point
  }
}
