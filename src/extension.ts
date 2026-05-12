import * as vscode from "vscode";
import { McapViewerProvider } from "./provider";
import { applyMcapCorePatches } from "./mcap-patch";

export function activate(context: vscode.ExtensionContext): void {
  applyMcapCorePatches();
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      McapViewerProvider.viewType,
      new McapViewerProvider(context.extensionUri),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );
}

export function deactivate(): void {}
