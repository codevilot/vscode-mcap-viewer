// Mirrors src/parser.ts end-to-end. Use this to reproduce extension errors
// without running VS Code: McapSession.open + getStepPayload across timeline.

const { open } = require("node:fs/promises");
const { FileHandleReadable } = require("@mcap/nodejs");
const { McapIndexedReader } = require("@mcap/core");
const { loadDecompressHandlers } = require("@mcap/support");
const { CdrReader } = require("@foxglove/cdr");

function parseJointState(data) {
  const reader = new CdrReader(data);
  reader.int32();
  reader.uint32();
  reader.string();
  const names = reader.stringArray();
  const positions = Array.from(reader.float64Array());
  return { names, positions };
}

function parseJointTrajectory(data) {
  const reader = new CdrReader(data);
  reader.int32();
  reader.uint32();
  reader.string();
  const names = reader.stringArray();
  const points = reader.sequenceLength();
  if (points === 0) return undefined;
  const positions = Array.from(reader.float64Array());
  return { names, positions };
}

function parseCompressedImage(data) {
  const reader = new CdrReader(data);
  reader.int32();
  reader.uint32();
  const frameId = reader.string();
  const format = reader.string();
  const jpeg = reader.uint8Array();
  return { frameId, format, jpegBytes: jpeg.length };
}

async function collectCameraStream(reader, topic) {
  const ts = [];
  for await (const m of reader.readMessages({ topics: [topic] })) ts.push(m.logTime);
  return { topic, frameCount: ts.length, timestampsNs: ts };
}

async function collectJointSeries(reader, topic) {
  const ts = [];
  const positions = [];
  let names;
  for await (const m of reader.readMessages({ topics: [topic] })) {
    try {
      const s = parseJointState(m.data);
      if (!names && s.names.length > 0) names = s.names;
      if (!names) continue;
      ts.push(m.logTime);
      positions.push(s.positions);
    } catch (e) {
      console.warn(`[joint] parse error at ${m.logTime}: ${e.message}`);
    }
  }
  return names && ts.length > 0 ? { topic, names, count: ts.length } : undefined;
}

async function collectTrajectory(reader, topic) {
  let count = 0;
  let names;
  for await (const m of reader.readMessages({ topics: [topic] })) {
    try {
      const s = parseJointTrajectory(m.data);
      if (!s) continue;
      if (!names && s.names.length > 0) names = s.names;
      if (!names) continue;
      count += 1;
    } catch (e) {
      console.warn(`[traj] parse error at ${m.logTime}: ${e.message}`);
    }
  }
  return names && count > 0 ? { topic, names, count } : undefined;
}

async function readCameraPayload(reader, topic, ts) {
  for await (const m of reader.readMessages({ topics: [topic], startTime: ts, endTime: ts + 1n })) {
    if (m.logTime === ts) {
      try { return parseCompressedImage(m.data); } catch (e) { console.warn(`[img] parse error: ${e.message}`); }
    }
  }
  const slack = 1_000_000n;
  let best;
  for await (const m of reader.readMessages({ topics: [topic], startTime: ts > slack ? ts - slack : 0n, endTime: ts + slack })) {
    const delta = m.logTime > ts ? m.logTime - ts : ts - m.logTime;
    if (!best || delta < best.delta) {
      try { best = { delta, payload: parseCompressedImage(m.data) }; } catch (e) { console.warn(`[img slack] parse error: ${e.message}`); }
    }
  }
  return best?.payload;
}

async function main() {
  const target = process.argv[2];
  if (!target) { console.error("Usage: node scripts/smoke-extension.js <path>"); process.exit(1); }
  const file = await open(target, "r");
  try {
    console.log("[1] Initialize");
    const reader = await McapIndexedReader.Initialize({
      readable: new FileHandleReadable(file),
      decompressHandlers: await loadDecompressHandlers(),
    });

    const channels = [...reader.channelsById.values()];
    const cameraChs = channels.filter((c) => reader.schemasById.get(c.schemaId)?.name === "sensor_msgs/msg/CompressedImage" && c.messageEncoding === "cdr");
    const jointCh = channels.find((c) => reader.schemasById.get(c.schemaId)?.name === "sensor_msgs/msg/JointState" && c.messageEncoding === "cdr");
    const trajChs = channels.filter((c) => reader.schemasById.get(c.schemaId)?.name === "trajectory_msgs/msg/JointTrajectory" && c.messageEncoding === "cdr");

    console.log(`[2] analyze: ${cameraChs.length} cameras, joint=${!!jointCh}, traj=${trajChs.length}`);
    const cameras = [];
    for (const c of cameraChs) cameras.push(await collectCameraStream(reader, c.topic));
    for (const c of cameras) console.log(`    camera ${c.topic} frames=${c.frameCount}`);
    const joint = jointCh ? await collectJointSeries(reader, jointCh.topic) : undefined;
    console.log(`    joint=${joint ? `${joint.names.length} names, ${joint.count} samples` : "none"}`);
    for (const t of trajChs) {
      const tr = await collectTrajectory(reader, t.topic);
      console.log(`    traj ${t.topic}=${tr ? `${tr.count} pts` : "none"}`);
    }

    console.log("[3] step payload across timeline (camera frames)");
    const primary = cameras[0];
    if (primary) {
      const samples = [0, Math.floor(primary.frameCount / 4), Math.floor(primary.frameCount / 2), Math.floor(primary.frameCount * 0.75), primary.frameCount - 1];
      for (const idx of samples) {
        const ts = primary.timestampsNs[idx];
        const payloads = [];
        for (const c of cameras) payloads.push(await readCameraPayload(reader, c.topic, ts));
        console.log(`    step ${idx}@${ts}: ${payloads.map((p) => p ? `${p.jpegBytes}B` : "none").join(", ")}`);
      }
    }

    console.log("ALL OK");
  } finally {
    await file.close();
  }
}

main().catch((e) => { console.error("FAILED:", e.message); console.error(e.stack); process.exit(1); });
