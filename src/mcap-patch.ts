// Runtime monkey-patch for @mcap/core to make record parsing tolerant of
// corrupted / truncated data. If parseRecord throws for any reason, we skip
// past the record using its declared length and continue.

let patched = false;

export function applyMcapCorePatches(): void {
  if (patched) {
    return;
  }
  patched = true;

  try {
    const parseMod = require("@mcap/core/dist/cjs/parse.js");
    const original = parseMod.parseRecord;
    if (typeof original !== "function") {
      console.warn("[mcap-viewer] parseRecord not found on @mcap/core; skipping runtime patch");
      return;
    }
    if ((original as { __mcapPatched?: boolean }).__mcapPatched) {
      console.log("[mcap-viewer] parseRecord already patched");
      return;
    }
    const wrapped = function parseRecord(this: unknown, reader: any, validateCrcs?: boolean) {
      const start = reader.offset;
      try {
        return original.call(this, reader, validateCrcs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reader.offset = start;
        if (reader.bytesRemaining() < 9) {
          console.warn(`[mcap-viewer] parseRecord aborted near offset ${start}: ${message}`);
          return undefined;
        }
        const opcode = reader.uint8();
        const recordLength = reader.uint64();
        if (recordLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          reader.offset = start;
          console.warn(`[mcap-viewer] parseRecord at ${start} has oversized length, stopping: ${message}`);
          return undefined;
        }
        const lenNum = Number(recordLength);
        if (reader.bytesRemaining() < lenNum) {
          reader.offset = start;
          console.warn(`[mcap-viewer] parseRecord at ${start} truncated, stopping: ${message}`);
          return undefined;
        }
        reader.offset = start + 9 + lenNum;
        console.warn(`[mcap-viewer] skipped record (opcode 0x${opcode.toString(16)}, length ${lenNum}) at offset ${start}: ${message}`);
        return { type: "Unknown", opcode, data: new Uint8Array(0) };
      }
    };
    (wrapped as { __mcapPatched?: boolean }).__mcapPatched = true;
    parseMod.parseRecord = wrapped;
    console.log("[mcap-viewer] runtime parseRecord patch installed (aggressive skip)");
  } catch (error) {
    console.warn("[mcap-viewer] failed to install parseRecord patch:", error);
  }
}
