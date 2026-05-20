export interface CameraStreamInfo {
  topic: string;
  frameCount: number;
  timestampsNs: bigint[];
  startedAtNs?: bigint;
  endedAtNs?: bigint;
}

export interface JointSeriesInfo {
  topic: string;
  names: string[];
  timestampsNs: bigint[];
  positions: number[][];
}

export interface TimelineStep {
  index: number;
  timestampNs: bigint;
  state?: number[];
  action?: number[];
}

export interface McapSummary {
  fileName: string;
  fileSize: number;
  cameras: CameraStreamInfo[];
  timeline: TimelineStep[];
  stateTopic?: string;
  actionTopics: string[];
  stateNames: string[];
  actionNames: string[];
  stateSeries: number[][];
  actionSeries: number[][];
  timelineSource: "state" | "action" | "camera" | "none";
  startedAtNs?: bigint;
  endedAtNs?: bigint;
  durationNs?: bigint;
  notes: string[];
}

export interface CameraFramePayload {
  topic: string;
  matchedTimestampNs: string;
  frameIndex: number;
  deltaMs: number;
  jpeg?: Uint8Array;
  format?: string;
  frameId?: string;
  error?: string;
}
