export interface CameraSummary {
  topic: string;
  frameCount: number;
  startedAtNs?: string;
  endedAtNs?: string;
}

export interface InitMessage {
  type: "init";
  phase: "preview" | "full";
  fileName: string;
  fileSize: number;
  totalSteps: number;
  stateTopic?: string;
  actionTopics: string[];
  stateNames: string[];
  actionNames: string[];
  stateSeries: number[][];
  actionSeries: number[][];
  stateTimestampsNs: string[];
  actionTimestampsNs: string[];
  timelineSource: "state" | "action" | "camera" | "none";
  startedAtNs?: string;
  endedAtNs?: string;
  durationNs?: string;
  seriesStartNs?: string;
  seriesEndNs?: string;
  timestampsNs: string[];
  cameras: CameraSummary[];
  notes: string[];
}

export interface StepMessage {
  type: "step";
  stepIndex: number;
  timestampNs: string;
  state?: number[];
  action?: number[];
  cameras: Array<{
    topic: string;
    matchedTimestampNs: string;
    frameIndex: number;
    deltaMs: number;
    jpeg?: Uint8Array;
    format?: string;
    frameId?: string;
    error?: string;
  }>;
}

export type HostToWebview = InitMessage | StepMessage;

export type WebviewToHost =
  | { type: "ready" }
  | { type: "requestStep"; stepIndex: number };
