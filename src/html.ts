import * as crypto from "node:crypto";
import * as vscode from "vscode";

export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MCAP Viewer</title>
  <style>${styles}</style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

const styles = `
* { box-sizing: border-box; }
html, body, #app { margin: 0; height: 100%; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
body, #app { overflow: hidden; }
button, input { font: inherit; }
.app-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.shell { display: grid; flex: 1 1 auto; min-height: 0; }
.divider { background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); transition: background 0.15s; user-select: none; }
.divider:hover, .divider.dragging { background: var(--vscode-focusBorder, color-mix(in srgb, var(--vscode-foreground) 25%, transparent)); }
.divider.vertical { cursor: col-resize; }
.divider.horizontal { cursor: row-resize; }
body.dragging-divider { cursor: col-resize; user-select: none; }
body.dragging-divider.horizontal { cursor: row-resize; }
.pane { min-height: 0; height: 100%; overflow: hidden; }
.left { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
.header { flex: 0 0 auto; padding: 18px 20px 10px; display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.title { font-size: 18px; font-weight: 700; letter-spacing: -0.02em; }
.meta { display: flex; gap: 8px; flex-wrap: wrap; }
.badge { padding: 5px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent); }
.hidden-strip { flex: 0 0 auto; display: flex; gap: 8px; flex-wrap: wrap; padding: 0 20px 8px; }
.camera-grid { flex: 1 1 0; min-height: 0; overflow-y: auto; overflow-x: hidden; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; padding: 8px 20px 18px; align-content: start; }
.camera-card { border: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent); border-radius: 18px; overflow: hidden; background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent); min-height: 220px; display: flex; flex-direction: column; }
.camera-bar { display: flex; justify-content: space-between; gap: 8px; padding: 10px 12px; font-size: 11px; }
.camera-topic { font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.9; }
.chip-btn { border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent); background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); color: inherit; border-radius: 999px; padding: 3px 8px; cursor: pointer; font-size: 11px; }
.chip-btn:hover { background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent); }
.camera-frame { aspect-ratio: 16 / 10; background: #000; display: flex; align-items: center; justify-content: center; }
.camera-frame img { max-width: 100%; max-height: 100%; display: block; }
.camera-empty { padding: 20px; font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; }
.controls { flex: 0 0 auto; border-top: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent); padding: 10px 20px 12px; display: grid; gap: 8px; background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent); }
.transport { display: flex; align-items: center; gap: 12px; }
.play { width: 42px; height: 42px; border-radius: 999px; border: none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
.speed-group { display: flex; gap: 4px; }
.speed-btn { font-variant-numeric: tabular-nums; min-width: 36px; text-align: center; }
.speed-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
.slider { flex: 1; }
.readout { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
.right { display: flex; flex-direction: column; min-width: 0; background: color-mix(in srgb, var(--vscode-foreground) 2%, transparent); overflow-y: auto; overflow-x: hidden; }
.section { flex: 0 0 auto; padding: 16px 16px 0; }
.section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.notes { display: grid; gap: 6px; }
.note { font-size: 12px; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--vscode-textLink-foreground) 9%, transparent); word-break: break-all; }
.joint-list { flex: 0 0 auto; padding: 8px 16px 20px; }
.signal-header { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 8px; padding: 0 2px; }
.signal-head-card { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); padding: 0 10px; }
.signal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.joint-row { border: 1px solid color-mix(in srgb, var(--vscode-foreground) 10%, transparent); border-radius: 14px; padding: 10px 12px; background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent); min-height: 82px; }
.joint-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; margin-bottom: 6px; }
.joint-name { font-family: var(--vscode-editor-font-family); color: #7dc4ff; }
.joint-name.action { color: #f5a85a; }
.joint-value { font-variant-numeric: tabular-nums; }
.spark { width: 100%; height: 42px; display: block; }
.cursor { stroke: #f5a85a; stroke-width: 2; }
.line { fill: none; stroke: #5fbcff; stroke-width: 1.6; }
.line.action { stroke: #f5a85a; }
.empty { padding: 24px; color: var(--vscode-descriptionForeground); }
.shell.stacked .left { border-right: none; }
`;
