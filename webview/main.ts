import type { HostToWebview, InitMessage, StepMessage, WebviewToHost } from "../src/protocol";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  setState(state: unknown): void;
  getState<T>(): T | undefined;
};

const vscode = acquireVsCodeApi();
const persisted = vscode.getState<{ hiddenTopics?: string[]; focusedTopic?: string; playbackSpeed?: number; asideWidth?: number; asideHeight?: number }>() ?? {};

const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4];
const ASIDE_MIN = 280;
const ASIDE_MAX = 1100;
const ASIDE_DEFAULT_W = 460;
const ASIDE_DEFAULT_H = 320;
const STACK_THRESHOLD_PX = 880;

const state = {
  init: undefined as InitMessage | undefined,
  step: undefined as StepMessage | undefined,
  playing: false,
  playTimer: undefined as number | undefined,
  rafHandle: undefined as number | undefined,
  hiddenTopics: new Set(persisted.hiddenTopics ?? []),
  focusedTopic: persisted.focusedTopic as string | undefined,
  playbackSpeed: PLAYBACK_SPEEDS.includes(persisted.playbackSpeed ?? 1) ? (persisted.playbackSpeed ?? 1) : 1,
  // Wall-clock anchor for drift-free playback. We pick a target mcap timestamp
  // each animation frame based on elapsed wall time × speed, then jump to the
  // matching timeline step.
  anchorWallMs: 0,
  anchorTsNs: 0n,
  lastRequestedStep: -1,
  asideWidth: clamp(persisted.asideWidth ?? ASIDE_DEFAULT_W, ASIDE_MIN, ASIDE_MAX),
  asideHeight: clamp(persisted.asideHeight ?? ASIDE_DEFAULT_H, ASIDE_MIN, ASIDE_MAX),
  stacked: false,
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

const app = document.querySelector("#app");
if (!app) {
  throw new Error("App root not found");
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  if (msg.type === "init") {
    // Two-phase loading: the first init is a "preview" with cameras-only
    // timeline so the UI can render fast even on NAS. The second init replaces
    // it with the joint-based timeline once the host finishes the background
    // scan. Re-anchor the current step by timestamp so the playhead doesn't
    // jump when the timeline lengths differ.
    const prevTs = state.step?.timestampNs;
    const wasPlaying = state.playing;
    state.init = msg;
    if (msg.phase === "full" && prevTs && msg.timestampsNs.length > 0) {
      const targetIdx = findStepAt(safeBigInt(prevTs));
      state.lastRequestedStep = targetIdx;
      requestStep(targetIdx);
      if (wasPlaying) {
        state.anchorWallMs = performance.now();
        state.anchorTsNs = safeBigInt(msg.timestampsNs[targetIdx] ?? "0");
      }
    }
    requestRender();
  } else if (msg.type === "step") {
    if (!state.playing && msg.stepIndex !== state.lastRequestedStep) {
      return;
    }
    state.step = msg;
    requestStepUpdate();
  }
});

function safeBigInt(value: string): bigint {
  try { return BigInt(value); } catch { return 0n; }
}

// Each camera topic keeps a single live Blob URL; when a new frame arrives we
// allocate the next URL and revoke the previous one so the browser can release
// the JPEG bytes immediately instead of leaking memory across hours of playback.
const frameUrls = new Map<string, string>();
function urlForFrame(topic: string, jpeg: Uint8Array | undefined): string | undefined {
  const prev = frameUrls.get(topic);
  if (!jpeg) {
    if (prev) {
      URL.revokeObjectURL(prev);
      frameUrls.delete(topic);
    }
    return undefined;
  }
  const blob = new Blob([jpeg as BlobPart], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  frameUrls.set(topic, url);
  if (prev) URL.revokeObjectURL(prev);
  return url;
}

let renderPending = false;
let fullRenderNeeded = false;
function requestRender(): void {
  // Mark "full render" — the structure (cameras visible, speed buttons,
  // play/pause icon, layout state, etc.) might have changed.
  fullRenderNeeded = true;
  schedule();
}
function requestStepUpdate(): void {
  // Only step-dependent values changed (img src, joint value, cursor x,
  // readout text, slider position). The structure stays the same so we can
  // mutate in place without rebuilding the DOM, which preserves scroll state.
  schedule();
}
function schedule(): void {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (fullRenderNeeded || !state.init || !document.querySelector(".shell")) {
      fullRenderNeeded = false;
      render();
    } else {
      updateStep();
    }
  });
}

function updateStep(): void {
  const init = state.init;
  const step = state.step;
  if (!init) return;
  const currentStep = step?.stepIndex ?? 0;
  const currentTs = step?.timestampNs ?? init.timestampsNs[0] ?? "0";

  // Readout
  const readoutStep = document.getElementById("readout-step");
  if (readoutStep) readoutStep.textContent = `step ${currentStep + 1} / ${Math.max(1, init.totalSteps)}`;
  const readoutTime = document.getElementById("readout-time");
  if (readoutTime) readoutTime.textContent = formatTimestamp(currentTs);

  // Slider — avoid stomping user drag.
  const slider = document.getElementById("step-slider") as HTMLInputElement | null;
  if (slider && document.activeElement !== slider) slider.value = String(currentStep);

  // Camera frames + counters + deltas. Look up by escaped topic via CSS.escape
  // so topics with slashes / underscores match correctly regardless of name.
  if (step) {
    for (const payload of step.cameras) {
      const sel = (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(payload.topic) : payload.topic.replace(/"/g, '\\"');
      const frame = document.querySelector(`[data-frame-topic="${sel}"]`) as HTMLElement | null;
      const counter = document.querySelector(`[data-counter-topic="${sel}"]`) as HTMLElement | null;
      const delta = document.querySelector(`[data-delta-topic="${sel}"]`) as HTMLElement | null;
      if (counter) {
        const total = Number(counter.dataset.frameCount ?? 0);
        counter.textContent = `${payload.frameIndex + 1}/${total}`;
      }
      if (delta) delta.textContent = `${payload.deltaMs.toFixed(1)} ms`;
      if (frame) {
        const url = urlForFrame(payload.topic, payload.jpeg);
        if (url) {
          let img = frame.querySelector("img.camera-img") as HTMLImageElement | null;
          if (!img) {
            frame.innerHTML = `<img class="camera-img" data-topic="${escapeHtmlAttr(payload.topic)}" alt="${escapeHtml(payload.topic)}" />`;
            img = frame.querySelector("img.camera-img") as HTMLImageElement | null;
          }
          if (img) img.src = url;
        } else {
          const msg = payload.error ?? "Frame loading…";
          let empty = frame.querySelector(".camera-empty") as HTMLElement | null;
          if (!empty) {
            frame.innerHTML = `<div class="camera-empty" data-topic="${escapeHtmlAttr(payload.topic)}">${escapeHtml(msg)}</div>`;
          } else if (empty.textContent !== msg) {
            empty.textContent = msg;
          }
        }
      }
    }
  }

  // Joint values + sparkline cursor lines
  const cursorTsNs = safeBigInt(currentTs);
  updateJoints("state", step?.state, cursorTsNs);
  updateJoints("action", step?.action, cursorTsNs);
}

function updateJoints(kind: "state" | "action", values: number[] | undefined, cursorTsNs: bigint): void {
  const valueEls = document.querySelectorAll<HTMLElement>(`[data-value-kind="${kind}"]`);
  valueEls.forEach((el) => {
    const idx = Number(el.dataset.valueIndex);
    const v = values?.[idx];
    el.textContent = formatNumber(v);
  });
  // Sparkline cursor: each joint-row's <line class="cursor"> moves to the
  // current step's wall-clock timestamp, normalized against the shared
  // (state ∪ action) range encoded in the SVG's data-axis-* attributes.
  const rows = document.querySelectorAll<HTMLElement>(`[data-joint-kind="${kind}"]`);
  const W = 320;
  rows.forEach((row) => {
    const spark = row.querySelector<SVGElement>("svg.spark");
    if (!spark) return;
    const startAttr = spark.getAttribute("data-axis-start");
    const endAttr = spark.getAttribute("data-axis-end");
    if (!startAttr || !endAttr) return;
    const axisStart = safeBigInt(startAttr);
    const axisEnd = safeBigInt(endAttr);
    const x = cursorXForTimestamp(cursorTsNs, axisStart, axisEnd, W);
    const cursor = spark.querySelector<SVGLineElement>("line.cursor");
    if (cursor) {
      cursor.setAttribute("x1", x.toFixed(2));
      cursor.setAttribute("x2", x.toFixed(2));
    }
  });
}

function cursorXForTimestamp(ts: bigint, axisStart: bigint, axisEnd: bigint, width: number): number {
  const span = axisEnd - axisStart;
  if (span <= 0n) return 0;
  if (ts <= axisStart) return 0;
  if (ts >= axisEnd) return width;
  // Use floating-point math for the ratio; nanosecond ranges fit comfortably
  // in a double (up to ~9e15 ≈ 104 days at ns precision).
  return (Number(ts - axisStart) / Number(span)) * width;
}

// Event delegation: we listen on "mousedown" instead of "click" because during
// fast playback the render loop rebuilds the button DOM between mousedown and
// mouseup, which prevents the browser from emitting a "click" at all. Acting
// on mousedown sidesteps that and gives instant feedback.
function handleActivate(target: HTMLElement | null): void {
  if (!target) return;
  if (target.closest("#play-toggle")) {
    togglePlay();
    return;
  }
  const speedBtn = target.closest<HTMLElement>(".speed-btn");
  if (speedBtn?.dataset.speed) {
    setPlaybackSpeed(Number(speedBtn.dataset.speed));
    return;
  }
  const actionEl = target.closest<HTMLElement>("[data-action]");
  if (actionEl) {
    const action = actionEl.dataset.action;
    const topic = actionEl.dataset.topic;
    if (action === "hide-camera" && topic) {
      state.hiddenTopics.add(topic);
      if (state.focusedTopic === topic) state.focusedTopic = undefined;
    } else if (action === "show-camera" && topic) {
      state.hiddenTopics.delete(topic);
    } else if (action === "show-all") {
      state.hiddenTopics.clear();
    } else if (action === "focus-camera" && topic) {
      state.focusedTopic = state.focusedTopic === topic ? undefined : topic;
    }
    persistUiState();
    requestRender();
  }
}
app.addEventListener("mousedown", (rawEvent) => {
  const event = rawEvent as MouseEvent;
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  // Don't preempt slider interaction.
  if (target?.closest("#step-slider") || target?.id === "pane-divider") return;
  if (target?.closest("#play-toggle, .speed-btn, [data-action]")) {
    event.preventDefault();
    handleActivate(target);
  }
});

app.addEventListener("input", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.id === "step-slider") {
    const value = Number((target as HTMLInputElement).value);
    requestStep(value);
    if (state.playing && state.init) {
      state.anchorWallMs = performance.now();
      try { state.anchorTsNs = BigInt(state.init.timestampsNs[value] ?? "0"); } catch { state.anchorTsNs = 0n; }
      state.lastRequestedStep = value;
    }
  }
});

window.addEventListener("keydown", (event) => {
  if (!state.init) {
    return;
  }
  if (event.target instanceof HTMLInputElement) {
    return;
  }
  if (event.key === " ") {
    event.preventDefault();
    togglePlay();
    return;
  }
  const current = state.step?.stepIndex ?? 0;
  if (event.key === "ArrowRight") {
    event.preventDefault();
    requestStep(Math.min(state.init.totalSteps - 1, current + 1));
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    requestStep(Math.max(0, current - 1));
  }
});

vscode.postMessage({ type: "ready" });

// Switch to vertical (stacked) layout when the webview gets narrow, so the
// joints/timeline pane gets its own row instead of squeezing the camera grid.
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const next = e.contentRect.width < STACK_THRESHOLD_PX;
    if (next !== state.stacked) {
      state.stacked = next;
      requestRender();
    }
  }
});
ro.observe(document.body);
state.stacked = document.body.clientWidth < STACK_THRESHOLD_PX;

// Divider drag — resize the right pane horizontally (or its height when stacked).
let dragMode: "v" | "h" | null = null;
let dragStart = { x: 0, y: 0, w: 0, h: 0 };
app.addEventListener("mousedown", (rawEvent) => {
  const event = rawEvent as MouseEvent;
  const target = event.target as HTMLElement | null;
  if (target?.id !== "pane-divider") return;
  event.preventDefault();
  dragMode = state.stacked ? "h" : "v";
  dragStart = { x: event.clientX, y: event.clientY, w: state.asideWidth, h: state.asideHeight };
  document.body.classList.add("dragging-divider");
  if (dragMode === "h") document.body.classList.add("horizontal");
  target.classList.add("dragging");
});
window.addEventListener("mousemove", (event) => {
  if (!dragMode) return;
  const shell = document.querySelector(".shell") as HTMLElement | null;
  if (!shell) return;
  if (dragMode === "v") {
    const dx = dragStart.x - event.clientX;
    state.asideWidth = clamp(dragStart.w + dx, ASIDE_MIN, ASIDE_MAX);
    shell.style.gridTemplateColumns = `minmax(0, 1fr) 6px ${state.asideWidth}px`;
  } else {
    const dy = dragStart.y - event.clientY;
    state.asideHeight = clamp(dragStart.h + dy, ASIDE_MIN, ASIDE_MAX);
    shell.style.gridTemplateRows = `minmax(0, 1fr) 6px ${state.asideHeight}px`;
  }
});
window.addEventListener("mouseup", () => {
  if (!dragMode) return;
  dragMode = null;
  document.body.classList.remove("dragging-divider", "horizontal");
  document.querySelector("#pane-divider")?.classList.remove("dragging");
  persistUiState();
});

// innerHTML rebuilds reset scrollTop on every scrollable container, which makes
// the page jump to the top each playback tick. Snapshot scroll offsets before
// rerender and restore them after, keyed by stable selectors that survive the
// rebuild.
const SCROLLABLE_SELECTORS = [".pane.right", ".camera-grid"];

function captureScrolls(): Map<string, number> {
  const map = new Map<string, number>();
  for (const sel of SCROLLABLE_SELECTORS) {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) map.set(sel, el.scrollTop);
  }
  map.set("__window", window.scrollY);
  return map;
}

function restoreScrolls(map: Map<string, number>): void {
  for (const [sel, top] of map) {
    if (sel === "__window") {
      window.scrollTo(0, top);
      continue;
    }
    const el = document.querySelector(sel) as HTMLElement | null;
    if (el) el.scrollTop = top;
  }
}

function render(): void {
  if (!state.init) {
    app!.innerHTML = `<div class="empty">Loading MCAP summary…</div>`;
    return;
  }
  const scrolls = captureScrolls();
  const init = state.init;
  const step = state.step;
  const currentStep = step?.stepIndex ?? 0;
  const currentTs = step?.timestampNs ?? init.timestampsNs[0] ?? "0";
  const cursorTsNs = safeBigInt(currentTs);
  const axis = computeSparklineAxis(init);
  const dims = Math.max(init.stateNames.length, init.actionNames.length);
  const jointRows = dims === 0
    ? `<div class="empty">No joint timeline found.</div>`
    : `
      <div class="signal-header">
        <div class="signal-head-card">OBSERVATION.STATE</div>
        <div class="signal-head-card">ACTION</div>
      </div>
      <div class="signal-grid">
        ${Array.from({ length: dims }).map((_, index) => {
          const stateName = init.stateNames[index];
          const actionName = init.actionNames[index];
          const stateSeries = init.stateSeries.map((sample) => sample[index] ?? Number.NaN);
          const actionSeries = init.actionSeries.map((sample) => sample[index] ?? Number.NaN);
          return `
            ${renderSignalCard(stateName, stateSeries, init.stateTimestampsNs, step?.state?.[index], cursorTsNs, axis, false, index)}
            ${renderSignalCard(actionName, actionSeries, init.actionTimestampsNs, step?.action?.[index], cursorTsNs, axis, true, index)}
          `;
        }).join("")}
      </div>
    `;

  const visibleCameras = init.cameras
    .filter((camera) => !state.hiddenTopics.has(camera.topic))
    .filter((camera) => !state.focusedTopic || camera.topic === state.focusedTopic);
  const hiddenCameras = init.cameras.filter((camera) => state.hiddenTopics.has(camera.topic));
  const cameraCards = visibleCameras.map((camera) => {
    const payload = step?.cameras.find((entry) => entry.topic === camera.topic);
    const url = urlForFrame(camera.topic, payload?.jpeg);
    const body = url
      ? `<img class="camera-img" data-topic="${escapeHtmlAttr(camera.topic)}" src="${url}" alt="${escapeHtml(camera.topic)}" />`
      : `<div class="camera-empty" data-topic="${escapeHtmlAttr(camera.topic)}">${escapeHtml(payload?.error ?? "Frame loading…")}</div>`;
    return `
      <article class="camera-card" data-topic="${escapeHtmlAttr(camera.topic)}">
        <div class="camera-bar">
          <div class="camera-topic" title="${escapeHtml(camera.topic)}">${escapeHtml(camera.topic)}</div>
          <div class="camera-counter" data-counter-topic="${escapeHtmlAttr(camera.topic)}" data-frame-count="${camera.frameCount}">${payload ? `${payload.frameIndex + 1}/${camera.frameCount}` : `0/${camera.frameCount}`}</div>
        </div>
        <div class="camera-bar">
          <div class="camera-delta" data-delta-topic="${escapeHtmlAttr(camera.topic)}">${payload ? `${payload.deltaMs.toFixed(1)} ms` : "pending"}</div>
          <div>
            <button class="chip-btn" data-action="hide-camera" data-topic="${escapeHtmlAttr(camera.topic)}">hide</button>
            <button class="chip-btn" data-action="focus-camera" data-topic="${escapeHtmlAttr(camera.topic)}">${state.focusedTopic === camera.topic ? "grid" : "focus"}</button>
          </div>
        </div>
        <div class="camera-frame" data-frame-topic="${escapeHtmlAttr(camera.topic)}">${body}</div>
      </article>
    `;
  }).join("");

  const shellStyle = state.stacked
    ? `grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) 6px ${state.asideHeight}px;`
    : `grid-template-columns: minmax(0, 1fr) 6px ${state.asideWidth}px; grid-template-rows: 1fr;`;
  app!.innerHTML = `
    <div class="app-root">
    <div class="shell${state.stacked ? " stacked" : ""}" style="${shellStyle}">
      <section class="pane left">
        <div class="header">
          <div>
            <div class="title">${escapeHtml(init.fileName)}</div>
          </div>
          <div class="meta">
            <span class="badge">${init.totalSteps} steps</span>
            <span class="badge">${init.cameras.length} cameras</span>
            <span class="badge">${Math.max(init.stateNames.length, init.actionNames.length)} joints</span>
            <span class="badge">${formatBytes(init.fileSize)}</span>
          </div>
        </div>
        ${hiddenCameras.length > 0 ? `
          <div class="hidden-strip">
            ${hiddenCameras.map((camera) => `<button class="chip-btn" data-action="show-camera" data-topic="${escapeHtmlAttr(camera.topic)}">${escapeHtml(shortTopic(camera.topic))}</button>`).join("")}
            <button class="chip-btn" data-action="show-all">show all</button>
          </div>
        ` : ""}
        <div class="camera-grid">${cameraCards || `<div class="empty">No camera topics found.</div>`}</div>
      </section>
      <div class="divider${state.stacked ? " horizontal" : " vertical"}" id="pane-divider" title="Drag to resize"></div>
      <aside class="pane right">
        <div class="section">
          <div class="section-title">TIMELINE</div>
          <div class="notes">
            <div class="note">${escapeHtml(renderTimelineSource(init))}</div>
            ${init.actionTopics.length > 0 ? `<div class="note">${escapeHtml(init.actionTopics.join(" | "))}</div>` : ""}
            ${init.startedAtNs && init.endedAtNs ? `<div class="note">${escapeHtml(formatTimestamp(init.startedAtNs))} → ${escapeHtml(formatTimestamp(init.endedAtNs))}</div>` : ""}
            ${init.durationNs ? `<div class="note">duration ${escapeHtml(formatDurationNs(init.durationNs))}</div>` : ""}
            ${init.notes.map((note) => `<div class="note">${escapeHtml(note)}</div>`).join("")}
          </div>
        </div>
        <div class="section">
          <div class="section-title">JOINTS</div>
        </div>
        <div class="joint-list">${jointRows}</div>
      </aside>
    </div>
    <div class="controls">
      <div class="readout">
        <span id="readout-step">step ${currentStep + 1} / ${Math.max(1, init.totalSteps)}</span>
        <span id="readout-time">${formatTimestamp(currentTs)}</span>
      </div>
      <div class="transport">
        <button class="play" id="play-toggle">${state.playing ? "❚❚" : "▶"}</button>
        <div class="speed-group">
          ${PLAYBACK_SPEEDS.map((sp) => `<button class="chip-btn speed-btn${sp === state.playbackSpeed ? " active" : ""}" data-speed="${sp}">${sp}×</button>`).join("")}
        </div>
        <input class="slider" id="step-slider" type="range" min="0" max="${Math.max(0, init.totalSteps - 1)}" value="${currentStep}" />
      </div>
    </div>
    </div>
  `;

  // Per-element listeners are no longer needed — see the delegated click/input
  // handlers attached once on the app root near the top of this file.

  restoreScrolls(scrolls);
}

function togglePlay(): void {
  state.playing = !state.playing;
  stopTimer();
  if (state.playing) {
    startTimer();
  } else {
    // Re-request the currently visible step so future stale responses get
    // filtered out and the slider locks where the user pressed stop.
    const here = state.step?.stepIndex ?? 0;
    state.lastRequestedStep = here;
    requestStep(here);
  }
  requestRender();
}

function stopTimer(): void {
  if (state.playTimer != undefined) {
    window.clearTimeout(state.playTimer);
    state.playTimer = undefined;
  }
  if (state.rafHandle != undefined) {
    cancelAnimationFrame(state.rafHandle);
    state.rafHandle = undefined;
  }
}

function requestStep(stepIndex: number): void {
  vscode.postMessage({ type: "requestStep", stepIndex });
}

function persistUiState(): void {
  vscode.setState({
    hiddenTopics: [...state.hiddenTopics],
    focusedTopic: state.focusedTopic,
    playbackSpeed: state.playbackSpeed,
    asideWidth: state.asideWidth,
    asideHeight: state.asideHeight,
  });
}

function setPlaybackSpeed(speed: number): void {
  if (!PLAYBACK_SPEEDS.includes(speed) || speed === state.playbackSpeed) return;
  state.playbackSpeed = speed;
  persistUiState();
  if (state.playing) {
    // Re-anchor wall clock so the new speed takes effect from the current
    // position instead of replaying past elapsed time at the new rate.
    stopTimer();
    startTimer();
  }
  requestRender();
}

function startTimer(): void {
  if (!state.init) return;
  const total = state.init.totalSteps;
  if (total === 0) return;
  const currentIndex = state.step?.stepIndex ?? 0;
  state.anchorWallMs = performance.now();
  try {
    state.anchorTsNs = BigInt(state.init.timestampsNs[currentIndex] ?? "0");
  } catch {
    state.anchorTsNs = 0n;
  }
  state.lastRequestedStep = currentIndex;
  state.rafHandle = requestAnimationFrame(playbackTick);
}

function playbackTick(): void {
  if (!state.playing || !state.init) {
    state.rafHandle = undefined;
    return;
  }
  const total = state.init.totalSteps;
  if (total === 0) {
    state.rafHandle = undefined;
    return;
  }

  const elapsedMs = performance.now() - state.anchorWallMs;
  const elapsedScaledNs = BigInt(Math.round(elapsedMs * 1_000_000)) * BigInt(Math.round(state.playbackSpeed * 1000)) / 1000n;
  let targetNs = state.anchorTsNs + elapsedScaledNs;

  const lastTs = (() => { try { return BigInt(state.init.timestampsNs[total - 1] ?? "0"); } catch { return 0n; } })();
  const firstTs = (() => { try { return BigInt(state.init.timestampsNs[0] ?? "0"); } catch { return 0n; } })();

  // Loop at end.
  if (targetNs > lastTs) {
    state.anchorWallMs = performance.now();
    state.anchorTsNs = firstTs;
    state.lastRequestedStep = -1;
    targetNs = firstTs;
  }

  const targetIndex = findStepAt(targetNs);
  if (targetIndex !== state.lastRequestedStep) {
    state.lastRequestedStep = targetIndex;
    requestStep(targetIndex);
  }
  state.rafHandle = requestAnimationFrame(playbackTick);
}

function findStepAt(targetNs: bigint): number {
  if (!state.init) return 0;
  const ts = state.init.timestampsNs;
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    let midTs: bigint;
    try { midTs = BigInt(ts[mid]); } catch { midTs = 0n; }
    if (midTs <= targetNs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

interface SparklineAxis {
  startNs: bigint;
  endNs: bigint;
}

function computeSparklineAxis(init: InitMessage): SparklineAxis {
  // Prefer the host-computed union range (state ∪ action). Fall back to the
  // first/last timestamps we actually have so degenerate or single-series
  // recordings still render.
  const candidates: bigint[] = [];
  if (init.seriesStartNs) candidates.push(safeBigInt(init.seriesStartNs));
  if (init.seriesEndNs) candidates.push(safeBigInt(init.seriesEndNs));
  for (const ts of init.stateTimestampsNs) candidates.push(safeBigInt(ts));
  for (const ts of init.actionTimestampsNs) candidates.push(safeBigInt(ts));
  if (candidates.length === 0) {
    return { startNs: 0n, endNs: 1n };
  }
  let startNs = candidates[0];
  let endNs = candidates[0];
  for (const ts of candidates) {
    if (ts < startNs) startNs = ts;
    if (ts > endNs) endNs = ts;
  }
  if (endNs <= startNs) endNs = startNs + 1n;
  return { startNs, endNs };
}

function renderSignalCard(
  name: string | undefined,
  series: number[],
  timestampsNs: string[],
  value: number | undefined,
  cursorTsNs: bigint,
  axis: SparklineAxis,
  isAction: boolean,
  jointIndex: number,
): string {
  if (!name) {
    return `<div class="joint-row"></div>`;
  }
  const kind = isAction ? "action" : "state";
  return `
    <div class="joint-row" data-joint-kind="${kind}" data-joint-index="${jointIndex}">
      <div class="joint-head">
        <span class="joint-name ${isAction ? "action" : ""}">${escapeHtml(name)}</span>
        <span class="joint-value" data-value-kind="${kind}" data-value-index="${jointIndex}">${formatNumber(value)}</span>
      </div>
      ${renderSparkline(series, timestampsNs, cursorTsNs, axis, isAction)}
    </div>
  `;
}

function renderSparkline(
  series: number[],
  timestampsNs: string[],
  cursorTsNs: bigint,
  axis: SparklineAxis,
  isAction: boolean,
): string {
  const width = 320;
  const height = 42;
  const filtered = series.filter((value) => Number.isFinite(value));
  if (filtered.length === 0 || timestampsNs.length === 0) {
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" data-axis-start="${axis.startNs.toString()}" data-axis-end="${axis.endNs.toString()}"></svg>`;
  }
  const min = Math.min(...filtered);
  const max = Math.max(...filtered);
  const span = max - min || 1;
  const sampled = downsamplePairs(series, timestampsNs, 180);
  const axisSpan = Number(axis.endNs - axis.startNs) || 1;
  const points = sampled.map(([value, tsNs]) => {
    const x = (Number(tsNs - axis.startNs) / axisSpan) * width;
    const safe = Number.isFinite(value) ? value : min;
    const y = height - ((safe - min) / span) * (height - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const cursorX = cursorXForTimestamp(cursorTsNs, axis.startNs, axis.endNs, width);
  return `
    <svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" data-axis-start="${axis.startNs.toString()}" data-axis-end="${axis.endNs.toString()}">
      <polyline class="line ${isAction ? "action" : ""}" points="${points}" />
      <line class="cursor" x1="${cursorX.toFixed(2)}" y1="0" x2="${cursorX.toFixed(2)}" y2="${height}" />
    </svg>
  `;
}

function downsamplePairs(values: number[], timestampsNs: string[], maxPoints: number): Array<[number, bigint]> {
  const n = Math.min(values.length, timestampsNs.length);
  if (n === 0) return [];
  if (n <= maxPoints) {
    const out: Array<[number, bigint]> = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [values[i] ?? Number.NaN, safeBigInt(timestampsNs[i])];
    return out;
  }
  const out: Array<[number, bigint]> = new Array(maxPoints);
  for (let index = 0; index < maxPoints; index++) {
    const at = Math.round((index / (maxPoints - 1)) * (n - 1));
    out[index] = [values[at] ?? Number.NaN, safeBigInt(timestampsNs[at])];
  }
  return out;
}

function formatTimestamp(timestampNs: string): string {
  const ms = Number(BigInt(timestampNs) / 1_000_000n);
  if (!Number.isFinite(ms)) {
    return timestampNs;
  }
  return new Date(ms).toLocaleString();
}

function formatNumber(value: number | undefined): string {
  return value == undefined || Number.isNaN(value) ? "—" : value.toFixed(4);
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`;
}

function formatDurationNs(durationNs: string): string {
  const ms = Number(BigInt(durationNs) / 1_000_000n);
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(2)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem.toFixed(1)}s`;
}

function renderTimelineSource(init: InitMessage): string {
  if (init.timelineSource === "state") {
    return `timeline: ${init.stateTopic ?? "state"}`;
  }
  if (init.timelineSource === "action") {
    return `timeline: action`;
  }
  if (init.timelineSource === "camera") {
    return "timeline: first camera stream";
  }
  return "timeline: unavailable";
}

function shortTopic(topic: string): string {
  const parts = topic.split("/");
  return parts[parts.length - 2] || parts[parts.length - 1] || topic;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttr(value: string): string {
  return escapeHtml(value);
}
