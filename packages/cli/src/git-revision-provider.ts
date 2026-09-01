import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { dirname, join, normalize } from "node:path/posix";

import type { DocumentLoader, DocumentRequest, LoadedDocument } from "@tokenc/core";
import micromatch from "micromatch";

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

export type GitRevisionErrorCode =
  | "GIT_REPOSITORY_NOT_FOUND"
  | "GIT_REVISION_NOT_FOUND"
  | "GIT_DOCUMENT_NOT_FOUND"
  | "GIT_PATH_OUTSIDE_REPOSITORY";

export class GitRevisionError extends Error {
  readonly code: GitRevisionErrorCode;

  constructor(code: GitRevisionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitRevisionError";
    this.code = code;
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((fulfill, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(stderr.trim() || error.message, {
              cause: error,
            }),
          );
        } else fulfill(stdout);
      },
    );
  });
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function safeRepositoryPath(path: string): string {
  const normalized = normalize(path).replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../"))
    throw new GitRevisionError(
      "GIT_PATH_OUTSIDE_REPOSITORY",
      `Path is outside the Git repository: ${path}`,
    );
  return normalized;
}

export interface GitSourceView extends DocumentLoader {
  readonly kind: "revision" | "worktree";
  readonly label: string;
  readonly revision: string;
  read(path: string): Promise<LoadedDocument>;
  readOptional(path: string): Promise<LoadedDocument | undefined>;
  sources(patterns: readonly string[]): Promise<readonly LoadedDocument[]>;
}

/** Scope loader requests without an explicit `from` document to one repository directory. */
export function scopedGitDocumentLoader(view: GitSourceView, directory: string): DocumentLoader {
  const base = directory === "" ? "" : safeRepositoryPath(directory);
  return Object.freeze({
    load: (request: DocumentRequest, signal?: AbortSignal) =>
      view.load(
        request.from || base === ""
          ? request
          : { ...request, specifier: join(base, posixPath(request.specifier)) },
        signal,
      ),
  });
}

export class GitRevisionProvider {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
    Object.freeze(this);
  }

  static async open(cwd: string): Promise<GitRevisionProvider> {
    try {
      const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
      return new GitRevisionProvider(resolve(root));
    } catch (error) {
      throw new GitRevisionError(
        "GIT_REPOSITORY_NOT_FOUND",
        `No Git repository found from ${cwd}`,
        { cause: error },
      );
    }
  }

  repositoryPath(path: string): string {
    const absolute = realpathSync.native(resolve(path));
    const repositoryRelative = posixPath(relative(this.root, absolute));
    return safeRepositoryPath(repositoryRelative);
  }

  repositoryDirectory(path: string): string {
    const repositoryRelative = posixPath(relative(this.root, realpathSync.native(resolve(path))));
    return repositoryRelative === "" ? "" : safeRepositoryPath(repositoryRelative);
  }

  patterns(cwd: string, patterns: readonly string[]): readonly string[] {
    const directory = this.repositoryDirectory(cwd);
    return Object.freeze(
      patterns.map((pattern) => {
        const excluded = pattern.startsWith("!");
        const value = excluded ? pattern.slice(1) : pattern;
        const normalized = safeRepositoryPath(join(directory, posixPath(value)));
        return excluded ? `!${normalized}` : normalized;
      }),
    );
  }

  async revision(ref: string): Promise<GitSourceView> {
    let commit: string;
    try {
      commit = (
        await runGit(this.root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
      ).trim();
    } catch (error) {
      throw new GitRevisionError("GIT_REVISION_NOT_FOUND", `Git revision not found: ${ref}`, {
        cause: error,
      });
    }
    return new InternalGitSourceView(this.root, "revision", ref, commit);
  }

  worktree(): GitSourceView {
    return new InternalGitSourceView(this.root, "worktree", "worktree", "worktree");
  }
}

class InternalGitSourceView implements GitSourceView {
  readonly kind: "revision" | "worktree";
  readonly label: string;
  readonly revision: string;
  readonly #root: string;

  constructor(root: string, kind: "revision" | "worktree", label: string, revision: string) {
    this.#root = root;
    this.kind = kind;
    this.label = label;
    this.revision = revision;
    Object.freeze(this);
  }

  async load(request: DocumentRequest, signal?: AbortSignal): Promise<LoadedDocument> {
    signal?.throwIfAborted();
    const path = request.from
      ? safeRepositoryPath(join(dirname(request.from), posixPath(request.specifier)))
      : safeRepositoryPath(posixPath(request.specifier));
    const document = await this.read(path);
    signal?.throwIfAborted();
    return document;
  }

  async read(path: string): Promise<LoadedDocument> {
    const identity = safeRepositoryPath(path);
    try {
      const content =
        this.kind === "worktree"
          ? await readFile(resolve(this.#root, identity), "utf8")
          : await runGit(this.#root, ["cat-file", "blob", `${this.revision}:${identity}`]);
      return Object.freeze({ identity, content });
    } catch (error) {
      throw new GitRevisionError(
        "GIT_DOCUMENT_NOT_FOUND",
        `Document not found in ${this.label}: ${identity}`,
        { cause: error },
      );
    }
  }

  async readOptional(path: string): Promise<LoadedDocument | undefined> {
    try {
      return await this.read(path);
    } catch (error) {
      if (error instanceof GitRevisionError && error.code === "GIT_DOCUMENT_NOT_FOUND")
        return undefined;
      throw error;
    }
  }

  async sources(patterns: readonly string[]): Promise<readonly LoadedDocument[]> {
    const files = await this.#files();
    const matched = micromatch(files, [...patterns], { dot: true }).toSorted();
    return Promise.all(matched.map((path) => this.read(path)));
  }

  async #files(): Promise<readonly string[]> {
    if (this.kind === "revision") {
      const output = await runGit(this.#root, [
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        this.revision,
      ]);
      return output.split("\0").filter(Boolean);
    }
    const output = await runGit(this.#root, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    const files = output.split("\0").filter(Boolean);
    const availability = await Promise.all(
      files.map(async (path) => {
        try {
          await access(resolve(this.#root, path));
          return path;
        } catch {
          return undefined;
        }
      }),
    );
    return availability.filter((path): path is string => path !== undefined);
  }
}
