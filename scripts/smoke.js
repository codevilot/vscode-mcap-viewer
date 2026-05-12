const { open } = require("node:fs/promises");
const { FileHandleReadable } = require("@mcap/nodejs");
const { McapIndexedReader } = require("@mcap/core");
const { loadDecompressHandlers } = require("@mcap/support");
const { CdrReader } = require("@foxglove/cdr");

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run smoke -- <path-to.mcap>");
    process.exit(1);
  }

  const file = await open(target, "r");
  try {
    const reader = await McapIndexedReader.Initialize({
      readable: new FileHandleReadable(file),
      decompressHandlers: await loadDecompressHandlers(),
    });
    const channels = [...reader.channelsById.values()].map((channel) => {
      const schema = reader.schemasById.get(channel.schemaId);
      return {
        topic: channel.topic,
        encoding: channel.messageEncoding,
        schema: schema?.name,
      };
    });

    const counts = {};
    for (const channel of channels) {
      counts[channel.topic] = 0;
    }

    let firstJointState;
    let firstCompressedImage;
    for await (const msg of reader.readMessages()) {
      const topic = reader.channelsById.get(msg.channelId)?.topic ?? `channel:${msg.channelId}`;
      counts[topic] = (counts[topic] ?? 0) + 1;
      if (!firstJointState && topic === "/joint_states") {
        const r = new CdrReader(msg.data);
        r.int32();
        r.uint32();
        r.string();
        firstJointState = {
          names: r.stringArray(),
          positions: Array.from(r.float64Array()).slice(0, 8),
        };
      }
      if (!firstCompressedImage && topic.includes("/compressed")) {
        const r = new CdrReader(msg.data);
        r.int32();
        r.uint32();
        firstCompressedImage = {
          topic,
          frameId: r.string(),
          format: r.string(),
          jpegBytes: r.uint8Array().length,
        };
      }
    }

    console.log(JSON.stringify({ channels, counts, firstJointState, firstCompressedImage }, null, 2));
  } finally {
    await file.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
