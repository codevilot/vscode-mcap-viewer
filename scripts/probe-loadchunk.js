// Probes #loadChunkData equivalent for every chunkIndex, mimicking the exact
// code path that throws "does not point to chunk record (found X)".

const { open } = require("node:fs/promises");
const { FileHandleReadable } = require("@mcap/nodejs");
const { McapIndexedReader } = require("@mcap/core");
const { loadDecompressHandlers } = require("@mcap/support");
const path = require("node:path");
const { parseRecord } = require(path.resolve(__dirname, "..", "node_modules/@mcap/core/dist/cjs/parse.js"));
const Reader = require(path.resolve(__dirname, "..", "node_modules/@mcap/core/dist/cjs/Reader.js")).default;

async function main() {
  const target = process.argv[2];
  const file = await open(target, "r");
  try {
    const reader = await McapIndexedReader.Initialize({
      readable: new FileHandleReadable(file),
      decompressHandlers: await loadDecompressHandlers(),
    });
    const readable = new FileHandleReadable(file);

    console.log(`Total chunkIndexes: ${reader.chunkIndexes.length}`);
    let failures = 0;
    for (let i = 0; i < reader.chunkIndexes.length; i += 1) {
      const idx = reader.chunkIndexes[i];
      const chunkData = await readable.read(idx.chunkStartOffset, idx.chunkLength);
      const view = new DataView(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength);
      const r = new Reader(view);
      const rec = parseRecord(r, false);
      if (!rec || rec.type !== "Chunk") {
        failures += 1;
        console.log(`[FAIL] #${i} offset=${idx.chunkStartOffset} length=${idx.chunkLength} firstByte=0x${chunkData[0].toString(16)} parsed=${rec?.type ?? "undefined"}`);
      }
    }
    console.log(`Failures: ${failures}/${reader.chunkIndexes.length}`);
  } finally {
    await file.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
