import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

import * as vscode from "vscode";

async function eventually<T>(
  probe: () => T | PromiseLike<T>,
  accept: (value: T) => boolean,
  deadline = Date.now() + 20_000,
): Promise<T> {
  const value = await probe();
  if (accept(value)) return value;
  assert.ok(Date.now() < deadline, "Timed out waiting for the VSIX smoke condition");
  await new Promise((resolve) => setTimeout(resolve, 100));
  return eventually(probe, accept, deadline);
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "Smoke workspace was not opened");
  const extension = vscode.extensions.getExtension("tokenc.tokenc-vscode");
  assert.ok(extension, "Installed tokenc VSIX was not discovered");
  await extension.activate();
  assert.equal(extension.isActive, true);

  const tokenUri = vscode.Uri.joinPath(folder.uri, "tokens.json");
  const diskBefore = await readFile(tokenUri.fsPath, "utf8");
  const document = await vscode.workspace.openTextDocument(tokenUri);
  await vscode.window.showTextDocument(document);
  const referenceOffset = document.getText().lastIndexOf("base");
  assert.ok(referenceOffset >= 0, "Fixture alias was not found");
  const referencePosition = document.positionAt(referenceOffset + 1);
  const definitions = await eventually(
    () =>
      vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        tokenUri,
        referencePosition,
      ),
    (locations) => (locations?.length ?? 0) === 1,
  );
  assert.equal(definitions.length, 1, "Definition navigation did not reach the declaration");

  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, "Smoke editor was not active");
  const changed = await editor.edit((builder) => {
    builder.replace(
      new vscode.Range(
        document.positionAt(referenceOffset),
        document.positionAt(referenceOffset + 4),
      ),
      "missing",
    );
  });
  assert.equal(changed, true, "Could not apply the unsaved smoke edit");
  const diagnostics = await eventually(
    () => vscode.languages.getDiagnostics(tokenUri),
    (items) => items.some((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error),
  );
  assert.ok(diagnostics.length > 0, "The invalid alias did not produce a diagnostic");
  assert.equal(
    await readFile(tokenUri.fsPath, "utf8"),
    diskBefore,
    "The extension or server wrote the user's token file",
  );
}
