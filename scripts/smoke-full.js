// Reproduces the extension's full parser flow against an mcap file:
//   1) Initialize indexed reader
//   2) Iterate every channel via readMessages (no time filter)
//   3) Probe per-frame queries via readMessages with narrow time ranges
//      (the path that exercises ChunkCursor's strict time checks)
// Prints structured progress so we can see where it fails.

const { open } = require("node:fs/promises");
const { FileHandleReadable } = require("@mcap/nodejs");
const { McapIndexedReader } = require("@mcap/core");
const { loadDecompressHandlers } = require("@mcap/support");

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/smoke-full.js <path-to.mcap>");
    process.exit(1);
  }

  const file = await open(target, "r");
  try {
    console.log("[1] Initializing indexed reader...");
    const reader = await McapIndexedReader.Initialize({
      readable: new FileHandleReadable(file),
      decompressHandlers: await loadDecompressHandlers(),
    });
    console.log("[1] OK");

    const channels = [...reader.channelsById.values()];
    const schemaName = (id) => reader.schemasById.get(id)?.name;

    console.log("[2] Iterating every topic via readMessages()...");
    for (const channel of channels) {
      let count = 0;
      let firstTs;
      let lastTs;
      for await (const msg of reader.readMessages({ topics: [channel.topic] })) {
        count += 1;
        if (firstTs === undefined) firstTs = msg.logTime;
        lastTs = msg.logTime;
      }
      console.log(`    ${channel.topic} [${schemaName(channel.schemaId)}] count=${count} range=${firstTs}..${lastTs}`);
    }
    console.log("[2] OK");

    console.log("[3] Sampling narrow time-window queries (extension's per-frame path)...");
    for (const channel of channels) {
      if (schemaName(channel.schemaId) !== "sensor_msgs/msg/CompressedImage") continue;
      const timestamps = [];
      for await (const msg of reader.readMessages({ topics: [channel.topic] })) {
        timestamps.push(msg.logTime);
        if (timestamps.length >= 5) break;
      }
      for (const ts of timestamps) {
        let hit = 0;
        for await (const _msg of reader.readMessages({ topics: [channel.topic], startTime: ts, endTime: ts + 1n })) {
          hit += 1;
        }
        console.log(`    narrow query ${channel.topic} @${ts} -> hit=${hit}`);
      }
    }
    console.log("[3] OK");

    console.log("ALL OK");
  } finally {
    await file.close();
  }
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
