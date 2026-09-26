// The SDK's app module binds its hooks and host components at import time from
// `globalThis.__bbPluginRuntime`. A test file that imports a component
// statically therefore pins `undefined` before any `renderSlot` call can
// install the runtime — the failure reads "experimental_useProviders is not a
// function", which points at the component rather than at the import order.
//
// Installing it in a setup file runs before every test module, so a UI test may
// import its component the ordinary way.
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();

// React Flow measures its container and nodes through ResizeObserver and reads
// the viewport transform through DOMMatrixReadOnly — jsdom has neither, and
// the canvas would throw on mount. Stubs are enough: the nodes are given their
// size up front, so nothing in a test depends on a real measurement.
if (typeof window !== "undefined") {
  const scope = globalThis as Record<string, unknown>;
  if (!scope.ResizeObserver) {
    scope.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!scope.DOMMatrixReadOnly) {
    scope.DOMMatrixReadOnly = class {
      m22: number;
      constructor(transform?: string) {
        const scale = transform?.match(/scale\(([^)]+)\)/)?.[1];
        this.m22 = scale ? Number(scale) : 1;
      }
    };
  }
}
