import { test, expect } from "bun:test"
import * as mod from "../src/index.ts"

// Regression guard for the 1.0.0 bug:
// opencode's plugin loader (packages/opencode/src/plugin/index.ts →
// getLegacyPlugins) iterates every export of the plugin module and throws
// "Plugin export is not a function" if any export is not callable. The
// published v1.0.0 re-exported PROVIDER_ID (a string), which broke loading
// silently — `opencode auth login` just did not list the provider.
//
// Keep this file cheap and dependency-free; do not import anything that
// makes network calls.
test("src/index.ts exports exactly one default export which is a function", () => {
  const keys = Object.keys(mod)
  expect(keys).toEqual(["default"])
  expect(typeof (mod as { default: unknown }).default).toBe("function")
})
