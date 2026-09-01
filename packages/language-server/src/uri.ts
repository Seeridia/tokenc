import { resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function normalizeWindowsDrive(path: string): string {
  return process.platform === "win32"
    ? path.replace(/^[A-Z]:/u, (drive) => drive.toLowerCase())
    : path;
}

/** Decode a file URI exactly once and return the canonical Core document identity. */
export function fileUriToDocumentIdentity(uri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "file:") return undefined;
  return normalizeWindowsDrive(resolve(fileURLToPath(parsed)));
}

export function documentIdentityToFileUri(identity: string): string {
  return pathToFileURL(normalizeWindowsDrive(resolve(identity))).href;
}

export function isDocumentInsideWorkspace(identity: string, root: string): boolean {
  const normalizedRoot = normalizeWindowsDrive(resolve(root));
  const normalizedIdentity = normalizeWindowsDrive(resolve(identity));
  return (
    normalizedIdentity === normalizedRoot ||
    normalizedIdentity.startsWith(`${normalizedRoot}${sep}`)
  );
}
