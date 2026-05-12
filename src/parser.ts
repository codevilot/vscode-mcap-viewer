import { CdrReader } from "@foxglove/cdr";
import { McapIndexedReader } from "@mcap/core";
import { FileHandleReadable } from "@mcap/nodejs";
import { loadDecompressHandlers } from "@mcap/support";
import { open, FileHandle } from "node:fs/promises";
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

export class McapSession implements vscode.Disposable {
  private constructor(
    readonly uri: vscode.Uri,
    readonly fileHandle: FileHandle,
    readonly reader: McapIndexedReader,
    readonly summary: McapSummary,
  ) {}

  // McapIndexedReader shares a single FileHandle for all reads, so concurrent
  // readMessages() iterations corrupt each other's chunk-view cache and produce
  // partial / interleaved results. Serialize every call through this queue.
  private readQueue: Promise<unknown> = Promise.resolve();
  serializeRead<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.readQueue.then(fn, fn);
    this.readQueue = next.catch(() => undefined);
    return next;
  }

  static async open(uri: vscode.Uri): Promise<McapSession> {
    console.log(`[mcap-viewer] opening ${uri.fsPath}`);
    const fileHandle = await open(uri.fsPath, "r");
    try {
      const reader = await McapIndexedReader.Initialize({
        readable: new FileHandleReadable(fileHandle),
        decompressHandlers: await loadDecompressHandlers(),
      });
      const stat = await fileHandle.stat();
      const summary = await analyze(uri, stat.size, reader);
      console.log(`[mcap-viewer] opened ${summary.fileName}: ${summary.cameras.length} cameras, ${summary.timeline.length} timeline steps`);
      return new McapSession(uri, fileHandle, reader, summary);
    } catch (error) {
      await fileHandle.close();
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[mcap-viewer] failed to open: ${message}`);
      throw new Error(`[mcap-viewer] ${message}`);
    }
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
    const safeIndex = Math.max(0, Math.min(stepIndex, this.summary.timeline.length - 1));
    const step = this.summary.timeline[safeIndex];
    const cameras: CameraFramePayload[] = [];
    for (const camera of this.summary.cameras) {
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
    void this.fileHandle.close();
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
        dataUrl: payload ? `data:image/jpeg;base64,${Buffer.from(payload.jpeg).toString("base64")}` : undefined,
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
    const neighborIndexes = [stepIndex - 1, stepIndex + 1].filter(
      (index) => index >= 0 && index < this.summary.timeline.length,
    );
    for (const index of neighborIndexes) {
      const step = this.summary.timeline[index];
      for (const camera of this.summary.cameras) {
        void this.loadCameraFrame(camera, step.timestampNs);
      }
    }
  }
}

async function analyze(uri: vscode.Uri, fileSize: number, reader: McapIndexedReader): Promise<McapSummary> {
  const channels = [...reader.channelsById.values()];
  const cameraChannels = channels.filter((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "sensor_msgs/msg/CompressedImage" && channel.messageEncoding === "cdr";
  });
  const jointChannel = channels.find((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "sensor_msgs/msg/JointState" && channel.messageEncoding === "cdr";
  });
  const trajectoryChannel = channels.find((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "trajectory_msgs/msg/JointTrajectory" && channel.messageEncoding === "cdr";
  });
  const trajectoryChannels = channels.filter((channel) => {
    const schema = reader.schemasById.get(channel.schemaId);
    return schema?.name === "trajectory_msgs/msg/JointTrajectory" && channel.messageEncoding === "cdr";
  });

  const notes: string[] = [];
  const cameras: CameraStreamInfo[] = [];
  for (const channel of cameraChannels) {
    cameras.push(await collectCameraStream(reader, channel.topic));
  }
  if (cameras.length === 0) {
    notes.push("No sensor_msgs/msg/CompressedImage topics found.");
  }

  const stateSeries = jointChannel ? await collectJointSeries(reader, jointChannel.topic) : undefined;
  const actionSeries = trajectoryChannels.length > 0
    ? await collectMergedTrajectorySeries(
        reader,
        trajectoryChannels.map((channel) => channel.topic),
        stateSeries?.names,
      )
    : trajectoryChannel
      ? await collectTrajectorySeries(reader, trajectoryChannel.topic)
      : undefined;

  if (!stateSeries && !actionSeries) {
    notes.push("No JointState or JointTrajectory timeline found. Timeline will follow the first camera stream.");
  }

  const timeline = buildTimeline(stateSeries, actionSeries, cameras);
  const timelineSource = stateSeries ? "state" : actionSeries ? "action" : cameras[0] ? "camera" : "none";
  const startedAtNs = timeline[0]?.timestampNs;
  const endedAtNs = timeline[timeline.length - 1]?.timestampNs;
  if (timeline.length === 0) {
    notes.push("This MCAP file contains no readable timeline entries.");
  }
  if (stateSeries && actionSeries && stateSeries.names.length !== actionSeries.names.length) {
    notes.push("Action topics were merged by joint name; state/action dimensions may differ.");
  }

  return {
    fileName: basename(uri.path),
    fileSize,
    cameras,
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

async function collectCameraStream(reader: McapIndexedReader, topic: string): Promise<CameraStreamInfo> {
  const timestampsNs: bigint[] = [];
  for await (const msg of reader.readMessages({ topics: [topic] })) {
    timestampsNs.push(msg.logTime);
  }
  return {
    topic,
    frameCount: timestampsNs.length,
    timestampsNs,
    startedAtNs: timestampsNs[0],
    endedAtNs: timestampsNs[timestampsNs.length - 1],
  };
}

async function collectJointSeries(reader: McapIndexedReader, topic: string): Promise<JointSeriesInfo | undefined> {
  const timestampsNs: bigint[] = [];
  const positions: number[][] = [];
  let names: string[] | undefined;
  for await (const msg of reader.readMessages({ topics: [topic] })) {
    const sample = parseJointState(msg.data);
    if (!names && sample.names.length > 0) {
      names = sample.names;
    }
    if (!names) {
      continue;
    }
    timestampsNs.push(msg.logTime);
    positions.push(remapPositions(names, sample.names, sample.positions));
  }
  if (!names || timestampsNs.length === 0) {
    return undefined;
  }
  return { topic, names, timestampsNs, positions };
}

async function collectTrajectorySeries(reader: McapIndexedReader, topic: string): Promise<JointSeriesInfo | undefined> {
  const timestampsNs: bigint[] = [];
  const positions: number[][] = [];
  let names: string[] | undefined;
  for await (const msg of reader.readMessages({ topics: [topic] })) {
    const sample = parseJointTrajectory(msg.data);
    if (!sample) {
      continue;
    }
    if (!names && sample.names.length > 0) {
      names = sample.names;
    }
    if (!names) {
      continue;
    }
    timestampsNs.push(msg.logTime);
    positions.push(remapPositions(names, sample.names, sample.positions));
  }
  if (!names || timestampsNs.length === 0) {
    return undefined;
  }
  return { topic, names, timestampsNs, positions };
}

async function collectMergedTrajectorySeries(
  reader: McapIndexedReader,
  topics: string[],
  preferredNames?: string[],
): Promise<JointSeriesInfo | undefined> {
  const seriesAll: (JointSeriesInfo | undefined)[] = [];
  for (const topic of topics) {
    seriesAll.push(await collectTrajectorySeries(reader, topic));
  }
  const series = seriesAll.filter((entry): entry is JointSeriesInfo => entry != undefined);
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
    topic: topics.join(", "),
    names: mergedNames,
    timestampsNs,
    positions,
  };
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
