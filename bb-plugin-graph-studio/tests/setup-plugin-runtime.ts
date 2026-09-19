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
