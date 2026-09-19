/**
 * Tests for model lookup on disk.
 *
 * The borrowing rule — read a model from an existing pi-listen install rather
 * than downloading a gigabyte again — is invisible when it works and
 * invisible when it does not. Both halves are pinned here, including that
 * "installed" needs *every* file, not just the first.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getModelDir,
  resolveModelDir,
  setModelsDir,
  setPiModelsDir,
} from "./download";

const files = {
  encoder: "https://example.test/repo/resolve/main/encoder.int8.onnx",
  tokens: "https://example.test/repo/resolve/main/tokens.txt",
};

let root: string;

function install(base: string, modelId: string, names: string[]): void {
  const directory = join(base, modelId);
  mkdirSync(directory, { recursive: true });
  for (const name of names) writeFileSync(join(directory, name), "x");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "listen-test-"));
  setModelsDir(join(root, "plugin"));
  // Point the borrow path at an empty directory, so these cases do not
  // depend on whether this machine happens to have pi-listen installed.
  setPiModelsDir(join(root, "pi"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveModelDir", () => {
  it("finds a model the plugin downloaded itself", () => {
    install(join(root, "plugin"), "parakeet-v3", ["encoder.int8.onnx", "tokens.txt"]);
    expect(resolveModelDir("parakeet-v3", files)).toBe(
      join(root, "plugin", "parakeet-v3"),
    );
  });

  it("reports nothing when the model is absent", () => {
    expect(resolveModelDir("parakeet-v3", files)).toBeNull();
  });

  it("reports nothing when only some of the files are there", () => {
    // A download interrupted after the first file must not read as ready:
    // sherpa would fail deep inside the native addon instead.
    install(join(root, "plugin"), "parakeet-v3", ["encoder.int8.onnx"]);
    expect(resolveModelDir("parakeet-v3", files)).toBeNull();
  });

  it("borrows a model from an existing pi-listen install", () => {
    install(join(root, "pi"), "parakeet-v3", ["encoder.int8.onnx", "tokens.txt"]);
    expect(resolveModelDir("parakeet-v3", files)).toBe(join(root, "pi", "parakeet-v3"));
  });

  it("prefers its own copy over the borrowed one", () => {
    install(join(root, "pi"), "parakeet-v3", ["encoder.int8.onnx", "tokens.txt"]);
    install(join(root, "plugin"), "parakeet-v3", ["encoder.int8.onnx", "tokens.txt"]);
    expect(resolveModelDir("parakeet-v3", files)).toBe(
      join(root, "plugin", "parakeet-v3"),
    );
  });

  it("does not borrow an incomplete pi-listen copy", () => {
    install(join(root, "pi"), "parakeet-v3", ["encoder.int8.onnx"]);
    expect(resolveModelDir("parakeet-v3", files)).toBeNull();
  });

  it("derives file names from the download URLs, not the role names", () => {
    install(join(root, "plugin"), "parakeet-v3", ["encoder", "tokens"]);
    expect(resolveModelDir("parakeet-v3", files)).toBeNull();
  });
});

describe("getModelDir", () => {
  it("always points at the plugin's own directory, never a borrowed one", () => {
    // Downloads must never write into someone else's install.
    expect(getModelDir("whisper-small")).toBe(join(root, "plugin", "whisper-small"));
  });
});
