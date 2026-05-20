# Changelog

## 0.1.3

- Align OBSERVATION.STATE and ACTION sparklines on a shared wall-clock axis. State and action series were previously stretched independently to fill the sparkline width by array index, so columns with different sampling rates or start/end times rendered the same X at different real-world moments. Per-sample timestamps now flow through the protocol and each sample (and the cursor) is placed by `(sampleTs - axisStart) / axisSpan` against the union of state ∪ action ranges, so identical wall-clock instants line up across both columns.

## 0.1.2

- Fix packaged extension failing to activate: `.vscodeignore`'s `node_modules/**/src/**` rule was stripping files some bundled packages declare as their CJS main entry (`@foxglove/crc/dist/cjs/src/index.js`, `protobufjs/src/index.js`, ...). Activation threw before the custom editor could register, leaving the webview stuck on "Loading…". Removed the over-broad rule; `package:vsix` now also runs `scripts/verify-vsix.js` which requires the packaged extension main in a child node process so the same class of `.vscodeignore` mistake fails the build.
- Background joint timeline scan now uses a dedicated FileHandle/reader so it no longer shares chunk-view cache state with the active camera-frame reader, preventing concurrent `readMessages` iterations from corrupting each other.

## 0.1.1

- Two-phase loading: render the camera grid in ~1s on NAS-mounted files by deriving frame timestamps from the per-chunk MessageIndex with 128-way parallel reads
- Background-stage remote files to a local tmpdir cache before running the joint/trajectory single-pass scan
- Hot-swap the indexed reader and summary under the read-serialization queue so the playhead re-anchors by timestamp
- Bypass per-frame base64: ship JPEG bytes via structured-clone postMessage and render through Blob URLs (CSP updated to allow `blob:`)

## 0.1.0

- Initial pre-release of the MCAP Viewer custom editor
- Synchronized `CompressedImage` camera playback for `.mcap` files
- Joint timeline from `JointState` with merged `JointTrajectory` action view
- Step-based playback controls, per-camera focus/hide, and nearest-frame lag display
- Smoke test and packaging pipeline for local pre-release validation
