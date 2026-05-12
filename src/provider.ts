import * as vscode from "vscode";
import { renderWebviewHtml } from "./html";
import { McapSession } from "./parser";
import { HostToWebview, WebviewToHost } from "./protocol";

export class McapViewerProvider implements vscode.CustomReadonlyEditorProvider<McapDocument> {
  static readonly viewType = "mcapViewer.viewer";

  constructor(private readonly extensionUri: vscode.Uri) {}

  async openCustomDocument(uri: vscode.Uri): Promise<McapDocument> {
    const session = await McapSession.open(uri);
    return new McapDocument(session);
  }

  resolveCustomEditor(document: McapDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    panel.webview.html = renderWebviewHtml(panel.webview, this.extensionUri);
    panel.webview.onDidReceiveMessage(async (message: WebviewToHost) => {
      switch (message.type) {
        case "ready":
          panel.webview.postMessage(this.buildInit(document));
          if (document.session.summary.timeline.length > 0) {
            panel.webview.postMessage(await this.buildStep(document, 0));
          }
          return;
        case "requestStep":
          panel.webview.postMessage(await this.buildStep(document, message.stepIndex));
          return;
      }
    });
  }

  private buildInit(document: McapDocument): HostToWebview {
    const { summary } = document.session;
    return {
      type: "init",
      fileName: summary.fileName,
      fileSize: summary.fileSize,
      totalSteps: summary.timeline.length,
      stateTopic: summary.stateTopic,
      actionTopics: summary.actionTopics,
      stateNames: summary.stateNames,
      actionNames: summary.actionNames,
      stateSeries: summary.stateSeries,
      actionSeries: summary.actionSeries,
      timelineSource: summary.timelineSource,
      startedAtNs: summary.startedAtNs?.toString(),
      endedAtNs: summary.endedAtNs?.toString(),
      durationNs: summary.durationNs?.toString(),
      timestampsNs: summary.timeline.map((step) => step.timestampNs.toString()),
      cameras: summary.cameras.map((camera) => ({
        topic: camera.topic,
        frameCount: camera.frameCount,
        startedAtNs: camera.startedAtNs?.toString(),
        endedAtNs: camera.endedAtNs?.toString(),
      })),
      notes: summary.notes,
    };
  }

  private async buildStep(document: McapDocument, index: number): Promise<HostToWebview> {
    const payload = await document.session.getStepPayload(index);
    return {
      type: "step",
      stepIndex: payload.stepIndex,
      timestampNs: payload.timestampNs,
      state: payload.state,
      action: payload.action,
      cameras: payload.cameras,
    };
  }
}

class McapDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;

  constructor(readonly session: McapSession) {
    this.uri = session.uri;
  }

  dispose(): void {
    this.session.dispose();
  }
}
