import { CdrReader } from "@foxglove/cdr";
import { McapIndexedReader } from "@mcap/core";
import { FileHandleReadable } from "@mcap/nodejs";
import { loadDecompressHandlers } from "@mcap/support";
import { randomBytes } from "node:crypto";
import { copyFile, open, stat as fsStat, unlink, FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { absBigint, nearestTimestampIndex, remapPositions } from "./series";
import { CameraFramePayload, CameraStreamInfo, JointSeriesInfo, McapSummary, TimelineStep } from "./types";

interface ParsedImage {
  frameId?: string;
  format?: string;
  jpeg: Uint8Array;
}

interface ParsedJointSample {
  names: string[];
  positions: number[];
}

interface JointSeriesAccumulator {
  topic: string;
  names?: string[];
  timestampsNs: bigint[];
  positions: number[][];
}

const MCAP_OPCODE_MESSAGE_INDEX = 0x07;
const MESSAGE_INDEX_CACHE_BYTES = 16 * 1024 * 1024;

export class McapSession implements vscode.Disposable {
  private constructor(
    readonly uri: vscode.Uri,
    private fileHandle: FileHandle,
    private reader: McapIndexedReader,
    private currentSummary: McapSummary,
    private localCachePath: string | undefined,
  ) {}

  get summary(): McapSummary {
    return this.currentSummary;
  }

  // McapIndexedReader shares a single FileHandle for all reads, so concurrent
  // readMessages() iterations corrupt each other's chunk-view cache and produce
  // partial / interleaved results. Serialize every call through this queue.
  private readQueue: Promise<unknown> = Promise.resolve();
  serializeRead<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.readQueue.then(fn, fn);
    this.readQueue = next.catch(() => undefined);
    return next;
  }

  // Phase 1: open the file from its source path and analyze only what we can
  // get cheaply — channel list + camera timestamps via the chunk index. The
  // resulting summary has a camera-driven timeline so the UI has something to
  // render in well under a second even on NAS.
  static async openPreview(uri: vscode.Uri): Promise<McapSession> {
    console.log(`[mcap-viewer] opening (preview) ${uri.fsPath}`);
    const fileHandle = await open(uri.fsPath, "r");
    try {
      const reader = await McapIndexedReader.Initialize({
        readable: new FileHandleReadable(fileHandle),
        decompressHandlers: await loadDecompressHandlers(),
        messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
      });
      const stat = await fileHandle.stat();
      const summary = await analyzePreview(uri, stat.size, reader, fileHandle);
      console.log(
        `[mcap-viewer] preview ready: ${summary.fileName} — ${summary.cameras.length} cameras, ` +
          `${summary.timeline.length} preview steps`,
      );
      return new McapSession(uri, fileHandle, reader, summary, undefined);
    } catch (error) {
      await fileHandle.close();
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcap-viewer] failed to open preview: ${message}`);
      throw new Error(`[mcap-viewer] ${message}`);
    }
  }

  // Phase 2: run in the background after openPreview. Copies remote files to
  // local temp if needed, then does the joint single-pass scan, then atomically
  // swaps in the new reader / summary so subsequent step requests get joint
  // data. Returns the updated summary; the caller should re-emit init to the
  // webview when this resolves.
  private enrichPromise: Promise<McapSummary> | undefined;
  enrichTimeline(): Promise<McapSummary> {
    if (this.enrichPromise) return this.enrichPromise;
    this.enrichPromise = this.runEnrichment().catch((error) => {
      console.warn(`[mcap-viewer] enrichment failed; keeping preview summary: ${error}`);
      return this.currentSummary;
    });
    return this.enrichPromise;
  }

  private async runEnrichment(): Promise<McapSummary> {
    const sourcePath = this.uri.fsPath;
    const { effectivePath, localCachePath } = await stageForRead(sourcePath);
    const swapReader = localCachePath != undefined && effectivePath !== sourcePath;

    let newFileHandle: FileHandle | undefined;
    let activeReader: McapIndexedReader = this.reader;
    if (swapReader) {
      newFileHandle = await open(effectivePath, "r");
      try {
        activeReader = await McapIndexedReader.Initialize({
          readable: new FileHandleReadable(newFileHandle),
          decompressHandlers: await loadDecompressHandlers(),
          messageIndexCacheSizeBytes: MESSAGE_INDEX_CACHE_BYTES,
        });
      } catch (error) {
        await newFileHandle.close().catch(() => undefined);
        await unlink(localCachePath).catch(() => undefined);
        throw error;
      }
    }

    const enrichedSummary = await analyzeJointTimeline(activeReader, this.currentSummary);

    // Swap inside the serialized queue so no concurrent read sees a half-
    // updated session (reader/fileHandle/summary all move together).
    await this.serializeRead(async () => {
      const oldFileHandle = this.fileHandle;
      const oldLocalCache = this.localCachePath;
      if (swapReader && newFileHandle) {
        this.fileHandle = newFileHandle;
        this.reader = activeReader;
        this.localCachePath = localCachePath;
      }
      this.currentSummary = enrichedSummary;
      if (swapReader) {
        try {
          await oldFileHandle.close();
        } catch (error) {
          console.warn(`[mcap-viewer] failed to close preview fileHandle: ${error}`);
        }
        if (oldLocalCache) {
          await unlink(oldLocalCache).catch(() => undefined);
        }
      }
    });

    console.log(
      `[mcap-viewer] enrichment complete: ${enrichedSummary.timeline.length} timeline steps ` +
        `(source=${enrichedSummary.timelineSource})`,
    );
    return enrichedSummary;
  }

  private readonly frameCache = new Map<string, CameraFramePayload>();
  private readonly pendingCache = new Map<string, Promise<CameraFramePayload>>();

  async getStepPayload(stepIndex: number): Promise<{
    stepIndex: number;
    timestampNs: string;
    state?: number[];
    action?: number[];
    cameras: CameraFramePayload[];
  }> {
    const summary = this.currentSummary;
    const safeIndex = Math.max(0, Math.min(stepIndex, summary.timeline.length - 1));
    const step = summary.timeline[safeIndex];
    const cameras: CameraFramePayload[] = [];
    for (const camera of summary.cameras) {
      cameras.push(await this.loadCameraFrame(camera, step.timestampNs));
    }
    this.prefetchNeighbors(safeIndex);
    return {
      stepIndex: step.index,
      timestampNs: step.timestampNs.toString(),
      state: step.state,
      action: step.action,
      cameras,
    };
  }

  dispose(): void {
    const finalize = async () => {
      if (this.enrichPromise) {
        await this.enrichPromise.catch(() => undefined);
      }
      try {
        await this.fileHandle.close();
      } catch (error) {
        console.warn(`[mcap-viewer] error closing fileHandle on dispose: ${error}`);
      }
      if (this.localCachePath) {
        const path = this.localCachePath;
        await unlink(path)
          .then(() => console.log(`[mcap-viewer] removed local cache ${path}`))
          .catch((error) => console.warn(`[mcap-viewer] failed to remove local cache ${path}: ${error}`));
      }
    };
    void finalize();
  }

  private async loadCameraFrame(camera: CameraStreamInfo, targetTs: bigint): Promise<CameraFramePayload> {
    const frameIndex = nearestTimestampIndex(camera.timestampsNs, targetTs);
    const matchedTs = camera.timestampsNs[frameIndex];
    const cacheKey = `${camera.topic}@${matchedTs.toString()}`;
    const cached = this.frameCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.pendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }

    const task = this.serializeRead(async () => {
      const payload = await readCameraPayload(this.reader, camera.topic, matchedTs);
      const result: CameraFramePayload = {
        topic: camera.topic,
        matchedTimestampNs: matchedTs.toString(),
        frameIndex,
        deltaMs: Number(absBigint(matchedTs - targetTs)) / 1_000_000,
        // postMessage uses structured clone (VS Code >=1.57), so we can ship
        // the raw JPEG bytes and let the webview build a Blob URL — avoiding
        // base64 encode + 33% payload inflation on every frame change.
        jpeg: payload?.jpeg,
        format: payload?.format,
        frameId: payload?.frameId,
        error: payload ? undefined : "Frame could not be decoded",
      };
      this.frameCache.set(cacheKey, result);
      if (this.frameCache.size > 64) {
        const firstKey = this.frameCache.keys().next().value as string | undefined;
        if (firstKey) {
          this.frameCache.delete(firstKey);
        }
      }
      return result;
    });
    this.pendingCache.set(cacheKey, task);
    try {
      return await task;
    } finally {
      this.pendingCache.delete(cacheKey);
    }
  }

  private prefetchNeighbors(stepIndex: number): void {
    const summary = this.currentSummary;
    const neighborIndexes = [stepIndex - 1, stepIndex + 1].filter(
      (index) => index >= 0 && index < summary.timeline.length,
    );
    for (const index of neighborIndexes) {
      const step = summary.timeline[index];
      for (const camera of summary.cameras) {
        void this.loadCameraFrame(camera, step.timestampNs);
      }
    }
  }
}

async function analyzePreview(
  uri: vscode.Uri,
  fileSize: number,
  reader: McapIndexedReader,
  fileHandle: FileHandle,
): Promise<McapSummary> {
  const channels = [...reader.channelsById.values()];
  const cameraChannels = channels.filter((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "sensor_msgs/msg/CompressedImage" && channel.messageEncoding === "cdr";
  });
  const trajectoryChannels = channels.filter((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "trajectory_msgs/msg/JointTrajectory" && channel.messageEncoding === "cdr";
  });

  const cameraStartedAt = Date.now();
  const cameraTimestamps = await collectCameraTimestampsFromIndex(
    reader,
    fileHandle,
    cameraChannels.map((c) => c.id),
  );
  const cameras: CameraStreamInfo[] = cameraChannels.map((channel) => {
    const timestampsNs = cameraTimestamps.get(channel.id) ?? [];
    return {
      topic: channel.topic,
      frameCount: timestampsNs.length,
      timestampsNs,
      startedAtNs: timestampsNs[0],
      endedAtNs: timestampsNs[timestampsNs.length - 1],
    };
  });
  console.log(
    `[mcap-viewer] preview camera scan in ${Date.now() - cameraStartedAt}ms ` +
      `(${cameras.length} streams, ${cameras.reduce((sum, c) => sum + c.frameCount, 0)} frames)`,
  );

  const notes: string[] = [];
  if (cameras.length === 0) {
    notes.push("No sensor_msgs/msg/CompressedImage topics found.");
  }
  notes.push("Loading joint timeline in background…");

  const timeline = buildTimeline(undefined, undefined, cameras);
  const startedAtNs = timeline[0]?.timestampNs;
  const endedAtNs = timeline[timeline.length - 1]?.timestampNs;
  return {
    fileName: basename(uri.path),
    fileSize,
    cameras,
    timeline,
    stateTopic: undefined,
    actionTopics: trajectoryChannels.map((channel) => channel.topic),
    stateNames: [],
    actionNames: [],
    stateSeries: [],
    actionSeries: [],
    timelineSource: cameras[0] ? "camera" : "none",
    startedAtNs,
    endedAtNs,
    durationNs: startedAtNs != undefined && endedAtNs != undefined ? endedAtNs - startedAtNs : undefined,
    notes,
  };
}

async function analyzeJointTimeline(
  reader: McapIndexedReader,
  preview: McapSummary,
): Promise<McapSummary> {
  const channels = [...reader.channelsById.values()];
  const jointChannel = channels.find((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "sensor_msgs/msg/JointState" && channel.messageEncoding === "cdr";
  });
  const trajectoryChannels = channels.filter((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "trajectory_msgs/msg/JointTrajectory" && channel.messageEncoding === "cdr";
  });

  const stateChannelId = jointChannel?.id;
  let stateAccum: JointSeriesAccumulator | undefined = jointChannel
    ? { topic: jointChannel.topic, timestampsNs: [], positions: [] }
    : undefined;
  const trajectoryAccums = new Map<number, JointSeriesAccumulator>(
    trajectoryChannels.map((channel) => [channel.id, { topic: channel.topic, timestampsNs: [], positions: [] }]),
  );
  const trajectoryByChannelId = new Map(trajectoryChannels.map((channel) => [channel.id, channel.topic]));

  const jointTopics: string[] = [];
  if (jointChannel) jointTopics.push(jointChannel.topic);
  for (const channel of trajectoryChannels) jointTopics.push(channel.topic);

  if (jointTopics.length > 0) {
    const jointStartedAt = Date.now();
    let messageCount = 0;
    for await (const msg of reader.readMessages({ topics: jointTopics })) {
      messageCount += 1;
      if (stateChannelId != undefined && msg.channelId === stateChannelId && stateAccum) {
        const sample = parseJointState(msg.data);
        appendJointSample(stateAccum, msg.logTime, sample);
        continue;
      }
      if (trajectoryByChannelId.has(msg.channelId)) {
        const accum = trajectoryAccums.get(msg.channelId);
        if (!accum) continue;
        const sample = parseJointTrajectory(msg.data);
        if (!sample) continue;
        appendJointSample(accum, msg.logTime, sample);
      }
    }
    console.log(
      `[mcap-viewer] joint single-pass scan in ${Date.now() - jointStartedAt}ms ` +
        `(${messageCount} messages across ${jointTopics.length} topics)`,
    );
  }

  const stateSeries = stateAccum ? finalizeJointSeries(stateAccum) : undefined;
  const trajectorySeriesList = [...trajectoryAccums.values()]
    .map((accum) => finalizeJointSeries(accum))
    .filter((entry): entry is JointSeriesInfo => entry != undefined);

  const actionSeries = trajectorySeriesList.length > 1
    ? mergeTrajectorySeries(trajectorySeriesList, stateSeries?.names)
    : trajectorySeriesList[0];

  const notes: string[] = preview.notes.filter((note) => note !== "Loading joint timeline in background…");
  if (!stateSeries && !actionSeries) {
    notes.push("No JointState or JointTrajectory timeline found. Timeline will follow the first camera stream.");
  }
  if (stateSeries && actionSeries && stateSeries.names.length !== actionSeries.names.length) {
    notes.push("Action topics were merged by joint name; state/action dimensions may differ.");
  }

  const timeline = buildTimeline(stateSeries, actionSeries, preview.cameras);
  const timelineSource = stateSeries ? "state" : actionSeries ? "action" : preview.cameras[0] ? "camera" : "none";
  const startedAtNs = timeline[0]?.timestampNs;
  const endedAtNs = timeline[timeline.length - 1]?.timestampNs;

  return {
    ...preview,
    timeline,
    stateTopic: stateSeries?.topic,
    actionTopics: trajectoryChannels.map((channel) => channel.topic),
    stateNames: stateSeries?.names ?? [],
    actionNames: actionSeries?.names ?? [],
    stateSeries: stateSeries?.positions ?? [],
    actionSeries: actionSeries?.positions ?? [],
    timelineSource,
    startedAtNs,
    endedAtNs,
    durationNs: startedAtNs != undefined && endedAtNs != undefined ? endedAtNs - startedAtNs : undefined,
    notes,
  };
}

function appendJointSample(
  accum: JointSeriesAccumulator,
  logTime: bigint,
  sample: ParsedJointSample,
): void {
  if (!accum.names && sample.names.length > 0) {
    accum.names = sample.names;
  }
  if (!accum.names) {
    return;
  }
  accum.timestampsNs.push(logTime);
  accum.positions.push(remapPositions(accum.names, sample.names, sample.positions));
}

function finalizeJointSeries(accum: JointSeriesAccumulator): JointSeriesInfo | undefined {
  if (!accum.names || accum.timestampsNs.length === 0) {
    return undefined;
  }
  return {
    topic: accum.topic,
    names: accum.names,
    timestampsNs: accum.timestampsNs,
    positions: accum.positions,
  };
}

function mergeTrajectorySeries(
  series: JointSeriesInfo[],
  preferredNames?: string[],
): JointSeriesInfo | undefined {
  if (series.length === 0) {
    return undefined;
  }
  const mergedNames = [
    ...(preferredNames ?? []),
    ...series.flatMap((entry) => entry.names),
  ].filter((name, index, arr) => arr.indexOf(name) === index);
  const timestampsNs = [...new Set(series.flatMap((entry) => entry.timestampsNs.map((value) => value.toString())))]
    .map((value) => BigInt(value))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const positions = timestampsNs.map((timestampNs) => {
    const merged = new Array<number>(mergedNames.length).fill(Number.NaN);
    for (const entry of series) {
      const sampleIndex = nearestTimestampIndex(entry.timestampsNs, timestampNs);
      const sample = entry.positions[sampleIndex];
      const remapped = remapPositions(mergedNames, entry.names, sample);
      for (let index = 0; index < remapped.length; index++) {
        if (!Number.isNaN(remapped[index])) {
          merged[index] = remapped[index];
        }
      }
    }
    return merged;
  });

  return {
    topic: series.map((entry) => entry.topic).join(", "),
    names: mergedNames,
    timestampsNs,
    positions,
  };
}

// Issue chunk-index region reads with bounded parallelism. On a network mount
// each pread() has ~10-50ms round-trip latency; for large files (thousands of
// chunks) sequential awaits would dominate phase-1 time. The reads themselves
// are independent, so we run a worker pool against the FileHandle directly.
const CHUNK_INDEX_READ_CONCURRENCY = 128;

async function collectCameraTimestampsFromIndex(
  reader: McapIndexedReader,
  fileHandle: FileHandle,
  channelIds: number[],
): Promise<Map<number, bigint[]>> {
  const result = new Map<number, bigint[]>();
  for (const id of channelIds) {
    result.set(id, []);
  }
  if (channelIds.length === 0) {
    return result;
  }
  const wanted = new Set(channelIds);

  type RelevantChunk = {
    chunkIndex: McapIndexedReader["chunkIndexes"][number];
    regionStart: bigint;
    regionLength: number;
  };
  const relevant: RelevantChunk[] = [];
  for (const chunkIndex of reader.chunkIndexes) {
    let regionHasCamera = false;
    for (const channelId of chunkIndex.messageIndexOffsets.keys()) {
      if (wanted.has(channelId)) {
        regionHasCamera = true;
        break;
      }
    }
    if (!regionHasCamera) continue;
    const regionLength = Number(chunkIndex.messageIndexLength);
    if (regionLength <= 0) continue;
    relevant.push({
      chunkIndex,
      regionStart: chunkIndex.chunkStartOffset + chunkIndex.chunkLength,
      regionLength,
    });
  }

  // Per-channel result buckets: parallel workers append into local arrays so we
  // don't share a mutable bigint[] across concurrent tasks, then we merge once.
  const perChunkResults: Array<Map<number, bigint[]>> = new Array(relevant.length);
  let next = 0;
  const concurrency = Math.min(CHUNK_INDEX_READ_CONCURRENCY, relevant.length);
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next++;
      if (index >= relevant.length) return;
      const { chunkIndex, regionStart, regionLength } = relevant[index];
      const buffer = Buffer.alloc(regionLength);
      await fileHandle.read(buffer, 0, regionLength, Number(regionStart));
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const local = new Map<number, bigint[]>();
      for (const [channelId, absoluteOffset] of chunkIndex.messageIndexOffsets) {
        if (!wanted.has(channelId)) continue;
        const relOffset = Number(absoluteOffset - regionStart);
        if (relOffset < 0 || relOffset >= regionLength) {
          console.warn(
            `[mcap-viewer] MessageIndex offset ${absoluteOffset} for channel ${channelId} outside region ` +
              `[${regionStart}, ${regionStart + BigInt(regionLength)}); skipping`,
          );
          continue;
        }
        const bucket = local.get(channelId) ?? [];
        parseMessageIndexTimestamps(view, relOffset, channelId, bucket);
        if (!local.has(channelId)) local.set(channelId, bucket);
      }
      perChunkResults[index] = local;
    }
  });
  await Promise.all(workers);

  // Merge per-chunk buckets into the final per-channel arrays in chunk order
  // (so that timestamps remain monotone for well-formed files and the sort
  // below is effectively a no-op).
  for (const local of perChunkResults) {
    if (!local) continue;
    for (const [channelId, timestamps] of local) {
      const sink = result.get(channelId);
      if (!sink) continue;
      for (const ts of timestamps) sink.push(ts);
    }
  }
  for (const arr of result.values()) {
    arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return result;
}

function parseMessageIndexTimestamps(
  view: DataView,
  startOffset: number,
  expectedChannelId: number,
  out: bigint[],
): void {
  let off = startOffset;
  if (off + 1 + 8 + 2 + 4 > view.byteLength) {
    console.warn(`[mcap-viewer] MessageIndex header truncated at offset ${startOffset}`);
    return;
  }
  const opcode = view.getUint8(off); off += 1;
  if (opcode !== MCAP_OPCODE_MESSAGE_INDEX) {
    console.warn(`[mcap-viewer] expected MessageIndex opcode 0x07, got 0x${opcode.toString(16)} at offset ${startOffset}`);
    return;
  }
  const recordLength = view.getBigUint64(off, true); off += 8;
  const recordEnd = off + Number(recordLength);
  if (recordEnd > view.byteLength) {
    console.warn(`[mcap-viewer] MessageIndex extends past buffer (record length ${recordLength}) at offset ${startOffset}`);
    return;
  }
  const channelId = view.getUint16(off, true); off += 2;
  if (channelId !== expectedChannelId) {
    console.warn(`[mcap-viewer] MessageIndex channelId mismatch: expected ${expectedChannelId}, got ${channelId}`);
    return;
  }
  const recordsByteLength = view.getUint32(off, true); off += 4;
  const recordsEnd = off + recordsByteLength;
  if (recordsEnd > recordEnd) {
    console.warn(`[mcap-viewer] MessageIndex records run past record bound`);
    return;
  }
  while (off + 16 <= recordsEnd) {
    const logTime = view.getBigUint64(off, true);
    off += 16;
    out.push(logTime);
  }
}

function buildTimeline(
  stateSeries: JointSeriesInfo | undefined,
  actionSeries: JointSeriesInfo | undefined,
  cameras: CameraStreamInfo[],
): TimelineStep[] {
  if (stateSeries) {
    return stateSeries.timestampsNs.map((timestampNs, index) => ({
      index,
      timestampNs,
      state: stateSeries.positions[index],
      action: actionSeries ? actionSeries.positions[nearestTimestampIndex(actionSeries.timestampsNs, timestampNs)] : undefined,
    }));
  }
  if (actionSeries) {
    return actionSeries.timestampsNs.map((timestampNs, index) => ({
      index,
      timestampNs,
      action: actionSeries.positions[index],
    }));
  }
  const primaryCamera = cameras[0];
  if (!primaryCamera) {
    return [];
  }
  return primaryCamera.timestampsNs.map((timestampNs, index) => ({ index, timestampNs }));
}

async function readCameraPayload(reader: McapIndexedReader, topic: string, timestampNs: bigint): Promise<ParsedImage | undefined> {
  for await (const msg of reader.readMessages({
    topics: [topic],
    startTime: timestampNs,
    endTime: timestampNs + 1n,
  })) {
    if (msg.logTime === timestampNs) {
      return parseCompressedImage(msg.data);
    }
  }
  const slack = 1_000_000n;
  let best: { delta: bigint; payload?: ParsedImage } | undefined;
  for await (const msg of reader.readMessages({
    topics: [topic],
    startTime: timestampNs > slack ? timestampNs - slack : 0n,
    endTime: timestampNs + slack,
  })) {
    const delta = msg.logTime > timestampNs ? msg.logTime - timestampNs : timestampNs - msg.logTime;
    if (!best || delta < best.delta) {
      best = { delta, payload: parseCompressedImage(msg.data) };
    }
  }
  return best?.payload;
}

function parseCompressedImage(data: Uint8Array): ParsedImage {
  const reader = new CdrReader(data);
  reader.int32();
  reader.uint32();
  const frameId = reader.string();
  const format = reader.string();
  const jpeg = reader.uint8Array();
  return { frameId, format, jpeg };
}

function parseJointState(data: Uint8Array): ParsedJointSample {
  const reader = new CdrReader(data);
  reader.int32();
  reader.uint32();
  reader.string();
  const names = reader.stringArray();
  const positions = Array.from(reader.float64Array());
  return { names, positions };
}

function parseJointTrajectory(data: Uint8Array): ParsedJointSample | undefined {
  const reader = new CdrReader(data);
  reader.int32();
  reader.uint32();
  reader.string();
  const names = reader.stringArray();
  const points = reader.sequenceLength();
  if (points === 0) {
    return undefined;
  }
  const positions = Array.from(reader.float64Array());
  return { names, positions };
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

async function stageForRead(sourcePath: string): Promise<{ effectivePath: string; localCachePath?: string }> {
  if (!isLikelyRemotePath(sourcePath)) {
    return { effectivePath: sourcePath };
  }
  const sourceBase = basename(sourcePath);
  const target = join(tmpdir(), `mcap-viewer-${randomBytes(8).toString("hex")}-${sourceBase}`);
  const startedAt = Date.now();
  try {
    const sourceStat = await fsStat(sourcePath);
    console.log(`[mcap-viewer] copying ${formatBytes(sourceStat.size)} from ${sourcePath} to local cache ${target}`);
    await copyFile(sourcePath, target);
    console.log(`[mcap-viewer] local cache ready in ${Date.now() - startedAt}ms`);
    return { effectivePath: target, localCachePath: target };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[mcap-viewer] local cache copy failed (${message}); reading from network path directly`);
    await unlink(target).catch(() => undefined);
    return { effectivePath: sourcePath };
  }
}

function isLikelyRemotePath(path: string): boolean {
  if (path.startsWith("/Volumes/")) return true;
  if (path.startsWith("/mnt/") || path.startsWith("/media/")) return true;
  if (path.startsWith("\\\\")) return true;
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
