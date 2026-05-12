// Patches @mcap/core to gracefully stop parsing when it encounters a record
// length that exceeds Number.MAX_SAFE_INTEGER, instead of throwing.
// Some recorders write summary sections with trailing/garbage bytes that
// the strict check rejects even though the indexed data before it is fine.
//
// Idempotent. Runs as `postinstall` so it survives reinstalls.

const fs = require("node:fs");
const path = require("node:path");

const PATCH_MARK = "patched: lenient record parsing";

const patches = [
  // 1. Don't throw on oversized record length — treat as end-of-stream.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/parse.js",
      "node_modules/@mcap/core/dist/esm/parse.js",
    ],
    old: `if (recordLength > Number.MAX_SAFE_INTEGER) {
        throw new Error(\`Record content length \${recordLength} is too large\`);
    }`,
    new: `if (recordLength > Number.MAX_SAFE_INTEGER) {
        // ${PATCH_MARK}: treat oversized record length as end-of-stream
        reader.offset = start;
        return undefined;
    }`,
  },
  // 1b. Wrap the entire parseRecord dispatch in try/catch so any deeper
  //     parser failure (e.g. DataView RangeError when chunk data is garbage)
  //     becomes a skipped record instead of an unrecoverable throw.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/parse.js",
      "node_modules/@mcap/core/dist/esm/parse.js",
    ],
    old: `let result;
    switch (opcode) {`,
    new: `let result;
    try { // ${PATCH_MARK}: try-catch wrapping dispatch
    switch (opcode) {`,
  },
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/parse.js",
      "node_modules/@mcap/core/dist/esm/parse.js",
    ],
    old: `    // NOTE: a bit redundant, but ensures we've advanced by the full record length
    // TODO: simplify this when we explore monomorphic paths
    reader.offset = start + RECORD_HEADER_SIZE + recordLengthNum;
    return result;`,
    new: `    } catch (e) {
        console.warn(\`[mcap-viewer] parseRecord opcode=0x\${opcode.toString(16)} len=\${recordLengthNum} failed: \${e?.message ?? e} — skipping\`);
        reader.offset = start + RECORD_HEADER_SIZE + recordLengthNum;
        return { type: "Unknown", opcode, data: new Uint8Array(0) };
    }
    // NOTE: a bit redundant, but ensures we've advanced by the full record length
    // TODO: simplify this when we explore monomorphic paths
    reader.offset = start + RECORD_HEADER_SIZE + recordLengthNum;
    return result;`,
  },
  // 2. Don't throw when there are trailing bytes in the summary/index section
  //    after a graceful stop — just ignore them.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (indexReader.bytesRemaining() !== 0) {
            throw errorWithLibrary(\`\${indexReader.bytesRemaining()} bytes remaining in index section\`);
        }`,
    new: `if (indexReader.bytesRemaining() !== 0) {
            // ${PATCH_MARK}: trailing bytes in index section are tolerated
            console.warn(\`[mcap-viewer] \${indexReader.bytesRemaining()} bytes remaining in index section (tolerated)\`);
        }`,
  },
  // 3. Tolerate trailing bytes in message index sections (per-chunk indexes).
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/ChunkCursor.js",
      "node_modules/@mcap/core/dist/esm/ChunkCursor.js",
    ],
    old: `if (reader.bytesRemaining() !== 0) {
            throw new Error(\`\${reader.bytesRemaining()} bytes remaining in message index section\`);
        }`,
    new: `if (reader.bytesRemaining() !== 0) {
            // ${PATCH_MARK}: trailing bytes in message index section are tolerated
            console.warn(\`[mcap-viewer] \${reader.bytesRemaining()} bytes remaining in message index section (tolerated)\`);
        }`,
  },
  // 4. Tolerate trailing bytes inside a chunk's record stream.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapStreamReader.js",
      "node_modules/@mcap/core/dist/esm/McapStreamReader.js",
    ],
    old: `if (chunkReader.bytesRemaining() !== 0) {
                        throw errorWithLibrary(\`\${chunkReader.bytesRemaining()} bytes remaining in chunk\`);
                    }`,
    new: `if (chunkReader.bytesRemaining() !== 0) {
                        // ${PATCH_MARK}: trailing bytes in chunk are tolerated
                        console.warn(\`[mcap-viewer] \${chunkReader.bytesRemaining()} bytes remaining in chunk (tolerated)\`);
                    }`,
  },
  // 5. Tolerate trailing bytes after parsing the header record.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (headerReader.bytesRemaining() !== 0) {
                throw new Error(\`\${headerReader.bytesRemaining()} bytes remaining after parsing header\`);
            }`,
    new: `if (headerReader.bytesRemaining() !== 0) {
                // ${PATCH_MARK}: trailing bytes after header are tolerated
                console.warn(\`[mcap-viewer] \${headerReader.bytesRemaining()} bytes remaining after parsing header (tolerated)\`);
            }`,
  },
  // 6. Tolerate trailing bytes after parsing the footer record.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (footerReader.bytesRemaining() !== constants_ts_1.MCAP_MAGIC.length) {
                throw errorWithLibrary(\`\${footerReader.bytesRemaining() - constants_ts_1.MCAP_MAGIC.length} bytes remaining after parsing footer\`);
            }`,
    new: `if (footerReader.bytesRemaining() !== constants_ts_1.MCAP_MAGIC.length) {
                // ${PATCH_MARK}: trailing bytes after footer are tolerated
                console.warn(\`[mcap-viewer] \${footerReader.bytesRemaining() - constants_ts_1.MCAP_MAGIC.length} bytes remaining after parsing footer (tolerated)\`);
            }`,
  },
  // 6b. Same patch for ESM build (uses `constants_ts_1` differently or import binding).
  {
    files: [
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (footerReader.bytesRemaining() !== MCAP_MAGIC.length) {
                throw errorWithLibrary(\`\${footerReader.bytesRemaining() - MCAP_MAGIC.length} bytes remaining after parsing footer\`);
            }`,
    new: `if (footerReader.bytesRemaining() !== MCAP_MAGIC.length) {
                // ${PATCH_MARK}: trailing bytes after footer are tolerated
                console.warn(\`[mcap-viewer] \${footerReader.bytesRemaining() - MCAP_MAGIC.length} bytes remaining after parsing footer (tolerated)\`);
            }`,
  },
  // 7a. Tolerate chunk index logTime mismatch (earlier than chunk messageStartTime).
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/ChunkCursor.js",
      "node_modules/@mcap/core/dist/esm/ChunkCursor.js",
    ],
    old: `if (logTimeFirstMessage < this.chunkIndex.messageStartTime) {
            throw new Error(\`Chunk at offset \${this.chunkIndex.chunkStartOffset} contains a message with logTime (\${logTimeFirstMessage}) earlier than chunk messageStartTime (\${this.chunkIndex.messageStartTime})\`);
        }`,
    new: `if (logTimeFirstMessage < this.chunkIndex.messageStartTime) {
            // ${PATCH_MARK}: chunk index logTime mismatch tolerated
            console.warn(\`[mcap-viewer] Chunk at offset \${this.chunkIndex.chunkStartOffset} contains a message with logTime (\${logTimeFirstMessage}) earlier than chunk messageStartTime (\${this.chunkIndex.messageStartTime}) (tolerated)\`);
        }`,
  },
  // 7b. Tolerate chunk index logTime mismatch (later than chunk messageEndTime).
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/ChunkCursor.js",
      "node_modules/@mcap/core/dist/esm/ChunkCursor.js",
    ],
    old: `if (logTimeLastMessage > this.chunkIndex.messageEndTime) {
            throw new Error(\`Chunk at offset \${this.chunkIndex.chunkStartOffset} contains a message with logTime (\${logTimeLastMessage}) later than chunk messageEndTime (\${this.chunkIndex.messageEndTime})\`);
        }`,
    new: `if (logTimeLastMessage > this.chunkIndex.messageEndTime) {
            // ${PATCH_MARK}: chunk index logTime mismatch tolerated
            console.warn(\`[mcap-viewer] Chunk at offset \${this.chunkIndex.chunkStartOffset} contains a message with logTime (\${logTimeLastMessage}) later than chunk messageEndTime (\${this.chunkIndex.messageEndTime}) (tolerated)\`);
        }`,
  },
  // 7c. Tolerate chunkStartOffset pointing to a non-Chunk record — log and skip.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (chunkRecord?.type !== "Chunk") {
            throw this.#errorWithLibrary(\`Chunk start offset \${chunkIndex.chunkStartOffset} does not point to chunk record (found \${String(chunkRecord?.type)})\`);
        }`,
    new: `if (chunkRecord?.type !== "Chunk") {
            // ${PATCH_MARK}: chunkStartOffset mismatch — return empty view so cursor skips this chunk
            console.warn(\`[mcap-viewer] Chunk start offset \${chunkIndex.chunkStartOffset} does not point to chunk record (found \${String(chunkRecord?.type)}) — skipping\`);
            return new DataView(new ArrayBuffer(0));
        }`,
  },
  // 7d. Tolerate "Unable to parse record at offset" — typically caused by 7c.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (offset >= BigInt(chunkView.byteLength)) {
                throw this.#errorWithLibrary(\`Message offset beyond chunk bounds (log time \${logTime}, offset \${offset}, chunk data length \${chunkView.byteLength}) in chunk at offset \${cursor.chunkIndex.chunkStartOffset}\`);
            }`,
    new: `if (offset >= BigInt(chunkView.byteLength)) {
                // ${PATCH_MARK}: message offset beyond chunk bounds — skip message
                console.warn(\`[mcap-viewer] Message offset beyond chunk bounds (log time \${logTime}, offset \${offset}, chunk data length \${chunkView.byteLength}) in chunk at offset \${cursor.chunkIndex.chunkStartOffset} — skipping\`);
                if (cursor.hasMoreMessages()) { if (!chunksOrdered) { chunkCursors.replace(cursor); } } else { chunkCursors.pop(); chunkViewCache.delete(cursor.chunkIndex.chunkStartOffset); }
                continue;
            }`,
  },
  // 7e. Tolerate "Unable to parse record at offset" in chunk.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (!record) {
                throw this.#errorWithLibrary(\`Unable to parse record at offset \${offset} in chunk at offset \${cursor.chunkIndex.chunkStartOffset}\`);
            }`,
    new: `if (!record) {
                // ${PATCH_MARK}: unparseable record — skip
                console.warn(\`[mcap-viewer] Unable to parse record at offset \${offset} in chunk at offset \${cursor.chunkIndex.chunkStartOffset} — skipping\`);
                if (cursor.hasMoreMessages()) { if (!chunksOrdered) { chunkCursors.replace(cursor); } } else { chunkCursors.pop(); chunkViewCache.delete(cursor.chunkIndex.chunkStartOffset); }
                continue;
            }`,
  },
  // 7f. Tolerate unexpected record type inside chunk.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (record.type !== "Message") {
                throw this.#errorWithLibrary(\`Unexpected record type \${record.type} in message index (time \${logTime}, offset \${offset} in chunk at offset \${cursor.chunkIndex.chunkStartOffset})\`);
            }`,
    new: `if (record.type !== "Message") {
                // ${PATCH_MARK}: unexpected record type — skip
                console.warn(\`[mcap-viewer] Unexpected record type \${record.type} (time \${logTime}, offset \${offset} in chunk \${cursor.chunkIndex.chunkStartOffset}) — skipping\`);
                if (cursor.hasMoreMessages()) { if (!chunksOrdered) { chunkCursors.replace(cursor); } } else { chunkCursors.pop(); chunkViewCache.delete(cursor.chunkIndex.chunkStartOffset); }
                continue;
            }`,
  },
  // 7g. Tolerate logTime mismatch between message and message index entry.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapIndexedReader.js",
      "node_modules/@mcap/core/dist/esm/McapIndexedReader.js",
    ],
    old: `if (record.logTime !== logTime) {
                throw this.#errorWithLibrary(\`Message log time \${record.logTime} did not match message index entry (\${logTime} at offset \${offset} in chunk at offset \${cursor.chunkIndex.chunkStartOffset})\`);
            }`,
    new: `if (record.logTime !== logTime) {
                // ${PATCH_MARK}: logTime mismatch — log and continue with actual time
                console.warn(\`[mcap-viewer] Message log time \${record.logTime} did not match message index entry (\${logTime} at offset \${offset} in chunk \${cursor.chunkIndex.chunkStartOffset})\`);
            }`,
  },
  // (Reader.string / keyValuePairs / map patches removed —
  //  letting them throw lets parseRecord's try/catch wrapper skip the entire
  //  malformed record cleanly, which is much safer than silently substituting
  //  empty values mid-record.)
  // 8. Tolerate trailing bytes after MCAP footer + magic at end of stream.
  {
    files: [
      "node_modules/@mcap/core/dist/cjs/McapStreamReader.js",
      "node_modules/@mcap/core/dist/esm/McapStreamReader.js",
    ],
    old: `throw errorWithLibrary(\`\${this.#reader.bytesRemaining()} bytes remaining after MCAP footer and trailing magic\`);`,
    new: `// ${PATCH_MARK}: trailing bytes after MCAP footer/magic are tolerated\n                        console.warn(\`[mcap-viewer] \${this.#reader.bytesRemaining()} bytes remaining after MCAP footer and trailing magic (tolerated)\`);`,
  },
];

let patchedCount = 0;
let skippedCount = 0;

for (const patch of patches) {
  for (const rel of patch.files) {
    const file = path.resolve(__dirname, "..", rel);
    if (!fs.existsSync(file)) {
      console.warn(`[patch-mcap-core] skipped (missing): ${rel}`);
      continue;
    }
    const src = fs.readFileSync(file, "utf8");
    if (!src.includes(patch.old)) {
      if (src.includes(PATCH_MARK) || src.includes("patched:")) {
        skippedCount += 1;
      } else {
        console.warn(`[patch-mcap-core] pattern not found in ${rel} — library version may have changed`);
      }
      continue;
    }
    fs.writeFileSync(file, src.replace(patch.old, patch.new));
    patchedCount += 1;
    console.log(`[patch-mcap-core] patched ${rel}`);
  }
}

if (patchedCount === 0 && skippedCount > 0) {
  console.log(`[patch-mcap-core] already patched (${skippedCount} location${skippedCount === 1 ? "" : "s"})`);
}
