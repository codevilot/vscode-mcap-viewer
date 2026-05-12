// Probes every chunkIndex: reads at its chunkStartOffset and prints the
// actual opcode + first-record type, so we can see exactly which chunk indexes
// claim to point to a Chunk but actually point elsewhere.

const { open } = require("node:fs/promises");
const { FileHandleReadable } = require("@mcap/nodejs");
const { McapIndexedReader } = require("@mcap/core");
const { loadDecompressHandlers } = require("@mcap/support");

const OPCODE_NAME = {
  0x01: "Header",
  0x02: "Footer",
  0x03: "Schema",
  0x04: "Channel",
  0x05: "Message",
  0x06: "Chunk",
  0x07: "MessageIndex",
  0x08: "ChunkIndex",
  0x09: "Attachment",
  0x0a: "AttachmentIndex",
  0x0b: "Statistics",
  0x0c: "Metadata",
  0x0d: "MetadataIndex",
  0x0e: "SummaryOffset",
  0x0f: "DataEnd",
};

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/probe-chunks.js <path>");
    process.exit(1);
  }
  const file = await open(target, "r");
  try {
    const reader = await McapIndexedReader.Initialize({
      readable: new FileHandleReadable(file),
      decompressHandlers: await loadDecompressHandlers(),
    });
    console.log(`Total chunkIndexes: ${reader.chunkIndexes.length}`);
    let bad = 0;
    for (let i = 0; i < reader.chunkIndexes.length; i += 1) {
      const idx = reader.chunkIndexes[i];
      const head = Buffer.alloc(9);
      await file.read(head, 0, 9, Number(idx.chunkStartOffset));
      const opcode = head[0];
      const length = head.readBigUInt64LE(1);
      const name = OPCODE_NAME[opcode] ?? `0x${opcode.toString(16)}`;
      const expected = name === "Chunk";
      if (!expected) {
        bad += 1;
        console.log(`[BAD ] #${i} offset=${idx.chunkStartOffset} declaredLength=${idx.chunkLength} foundOpcode=0x${opcode.toString(16)}(${name}) recordLen=${length}`);
      } else if (i < 3 || i === reader.chunkIndexes.length - 1) {
        console.log(`[ ok ] #${i} offset=${idx.chunkStartOffset} length=${idx.chunkLength} opcode=Chunk recordLen=${length} msgRange=${idx.messageStartTime}..${idx.messageEndTime}`);
      }
    }
    console.log(`Bad chunks: ${bad} / ${reader.chunkIndexes.length}`);
  } finally {
    await file.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
