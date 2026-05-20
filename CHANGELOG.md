# Changelog

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
