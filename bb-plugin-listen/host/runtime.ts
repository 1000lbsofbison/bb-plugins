/**
 * Finding, installing and loading the sherpa-onnx native runtime.
 *
 * This is the one piece pi-listen did not need. There, npm installs
 * `sherpa-onnx-node` alongside the extension and a plain `import()` finds it.
 * A BB host entry is a *bundled* artifact: pure JavaScript dependencies are
 * inlined, and a `.node` addon cannot be. Worse, managed Git installs run
 * `npm install --omit=optional`, which is exactly where the per-platform
 * prebuilds live.
 *
 * So the runtime is installed at first use into the host's persistent
 * `dataDir` and loaded from there through `createRequire` with a path the
 * bundler never sees. A user who already runs pi-listen has the same runtime
 * on disk; we borrow it instead of downloading 33 MB again.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Package and floor version. sherpa-onnx picks its own platform prebuild. */
const RUNTIME_PACKAGE = "sherpa-onnx-node";
const RUNTIME_RANGE = "^1.13.0";

/** Where an existing pi-listen install keeps the same runtime. */
const PI_RUNTIME = join(homedir(), ".pi", "agent", "npm", "node_modules");

export type RuntimeSource = "plugin" | "pi" | "none";

export interface RuntimeStatus {
  /** Whether a usable runtime was found on disk. */
  installed: boolean;
  /** Where it came from — surfaced in the setup UI so the choice is visible. */
  source: RuntimeSource;
  /** Directory holding `node_modules/sherpa-onnx-node`, or null. */
  root: string | null;
  /** Why the platform cannot run sherpa at all, if that is the case. */
  unsupported: string | null;
}

/** The plugin-owned install root inside the host's persistent data directory. */
export function runtimeRoot(dataDir: string): string {
  return join(dataDir, "runtime");
}

/**
 * Platforms sherpa-onnx has no prebuild for. Checked before any install
 * attempt so the user reads one clear sentence instead of an npm error.
 */
export function platformSupport(): string | null {
  if (process.arch === "arm") {
    return "32-bit ARM has no sherpa-onnx build. A 64-bit OS is required.";
  }
  if (process.platform === "linux" && isMuslLinux()) {
    return "Alpine Linux (musl libc) has no sherpa-onnx build. A glibc-based distribution is required.";
  }
  return null;
}

function isMuslLinux(): boolean {
  // `ldd` is a shell script on glibc systems and mentions musl on Alpine.
  // Unreadable means "not Alpine" — the file is absent on most images.
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return report?.header?.glibcVersionRuntime === undefined;
  } catch {
    return false;
  }
}

/** Look for a usable runtime without loading or installing anything. */
export function probeRuntime(dataDir: string): RuntimeStatus {
  const unsupported = platformSupport();
  const own = runtimeRoot(dataDir);
  if (hasRuntime(own)) {
    return { installed: true, source: "plugin", root: own, unsupported };
  }
  if (hasRuntime(join(PI_RUNTIME, ".."))) {
    return {
      installed: true,
      source: "pi",
      root: join(PI_RUNTIME, ".."),
      unsupported,
    };
  }
  return { installed: false, source: "none", root: null, unsupported };
}

function hasRuntime(root: string): boolean {
  return existsSync(join(root, "node_modules", RUNTIME_PACKAGE, "package.json"));
}

/**
 * Install the runtime into the plugin's data directory with npm.
 *
 * npm is the only practical way to resolve the right prebuild for this
 * platform and ABI. There is no privileged installer in BB, so this runs as
 * the user, in a directory the plugin owns, and touches nothing else.
 */
export async function installRuntime(
  dataDir: string,
  options: { signal?: AbortSignal; onLog?: (line: string) => void } = {},
): Promise<RuntimeStatus> {
  const unsupported = platformSupport();
  if (unsupported !== null) throw new Error(unsupported);

  const root = runtimeRoot(dataDir);
  await mkdir(root, { recursive: true });
  // Without a package.json npm walks up and installs into a parent directory.
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "bb-plugin-listen-runtime", private: true, version: "1.0.0" }, null, 2)}\n`,
  );

  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      "npm",
      [
        "install",
        `${RUNTIME_PACKAGE}@${RUNTIME_RANGE}`,
        "--no-audit",
        "--no-fund",
        "--loglevel",
        "info",
      ],
      { cwd: root, signal: options.signal, maxBuffer: 8 * 1024 * 1024 },
      (error) => (error === null ? resolve() : reject(error)),
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      options.onLog?.(chunk.toString().trimEnd());
    });
  });

  if (!hasRuntime(root)) {
    throw new Error(
      "npm reported success but sherpa-onnx-node is not in the install directory.",
    );
  }
  return { installed: true, source: "plugin", root, unsupported: null };
}

// ─── Loading ────────────────────────────────────────────────────────────────

let loaded: unknown = null;
let loadError: string | null = null;
let loading: Promise<boolean> | null = null;

/**
 * The data directory, remembered once.
 *
 * The host learns it per call, but the engines below — ported from a codebase
 * where the runtime was a plain import — load sherpa from deep inside a
 * synthesis or recognition path. Threading a directory through all of that
 * would be noise; one setter at the entry point is the honest shape.
 */
let runtimeDataDir: string | null = null;

export function setRuntimeDataDir(directory: string): void {
  runtimeDataDir = directory;
}

function requireDataDir(): string {
  if (runtimeDataDir === null) {
    throw new Error("The speech runtime was used before the host set its data directory.");
  }
  return runtimeDataDir;
}

/**
 * Load the native module once per worker process.
 *
 * Single-flight: the `??=` claims the slot in the same tick as the check, so
 * two callers arriving together — a transcription and a synthesis, say —
 * share one load rather than racing two `require` calls through the addon.
 */
export async function loadSherpa(dataDir?: string): Promise<boolean> {
  if (dataDir !== undefined) setRuntimeDataDir(dataDir);
  if (loaded !== null || loadError !== null) return loadError === null;
  loading ??= doLoad(requireDataDir());
  return loading;
}

async function doLoad(dataDir: string): Promise<boolean> {
  try {
    const unsupported = platformSupport();
    if (unsupported !== null) throw new Error(unsupported);

    const status = probeRuntime(dataDir);
    if (status.root === null) {
      throw new Error(
        "The speech runtime is not installed. Install it from the plugin's settings page.",
      );
    }

    // Resolve from the install root's own package context. The `.node` binary
    // finds its sibling libraries through @loader_path/$ORIGIN, so no library
    // path variables are needed.
    const require = createRequire(join(status.root, "package.json"));
    const module_ = require(RUNTIME_PACKAGE) as Record<string, unknown>;

    // The package is CommonJS; under some loaders the real exports sit on
    // `.default` while the namespace holds stubs. Sniff for a method we
    // actually call rather than trusting the shape.
    const candidate = module_ as { default?: Record<string, unknown> };
    const hasApi = (value: unknown): boolean =>
      typeof (value as { OfflineRecognizer?: unknown })?.OfflineRecognizer ===
      "function";
    loaded = hasApi(module_)
      ? module_
      : hasApi(candidate.default)
        ? candidate.default
        : module_;
    return true;
  } catch (cause) {
    loadError = cause instanceof Error ? cause.message : String(cause);
    return false;
  } finally {
    loading = null;
  }
}

/** The loaded module. Throws unless `loadSherpa` resolved true first. */
export function sherpa(): any {
  if (loaded === null) {
    throw new Error(loadError ?? "The speech runtime is not loaded.");
  }
  return loaded;
}

export function sherpaError(): string | null {
  return loadError;
}

/** Forget a failed load so a fresh install can be picked up without a reload. */
export function resetRuntime(): void {
  loaded = null;
  loadError = null;
  loading = null;
}
