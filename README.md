# MCAP Viewer

Custom editor for exploring ROS 2 oriented `.mcap` logs inside VS Code.

This extension is aimed at robot data inspection workflows where camera streams and joint signals need to be reviewed together step-by-step.

## Features

- Open `.mcap` directly from Explorer
- Render `sensor_msgs/msg/CompressedImage` topics as synchronized camera panels
- Use `sensor_msgs/msg/JointState` as the main timeline when available
- Merge `trajectory_msgs/msg/JointTrajectory` topics into an action view
- Show step-by-step state/action signals beside the camera frames
- Show nearest-frame lag and persist per-camera visibility/focus state
- Package as a VS Code custom editor for direct file opening

## Development

```bash
npm install
npm run compile
npm test
npm run smoke -- ../mcap-example/20260416_150442_961284/20260416_150442_961284_0.mcap
npm run package:vsix
```

Then open this folder in VS Code and press `F5` to launch an Extension Development Host.

## Supported topics

- `sensor_msgs/msg/CompressedImage`
- `sensor_msgs/msg/JointState`
- `trajectory_msgs/msg/JointTrajectory`

The webview currently picks the nearest camera frame for each timeline step.

## Controls

- `Space`: play/pause
- `Left Arrow`: previous step
- `Right Arrow`: next step
- Camera chips: hide, restore, focus a single stream

## Packaging Notes

- Optimized for ROS 2 MCAP logs with `cdr` message encoding.
- Currently focused on `CompressedImage`, `JointState`, and `JointTrajectory`.
- Validated against the sample log in `../mcap-example/20260416_150442_961284/`.
- Treat `0.1.x` as a pre-release line unless it has been tested against your specific MCAP variants.
