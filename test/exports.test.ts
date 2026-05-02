import { test, expect } from "bun:test"
import fs from "node:fs"
import * as mod from "../src/index.ts"

// Regression guard for the 1.0.0 bug + the Windows loading fix:
// opencode's plugin loader first tries readV1Plugin (detect mode) on the
// default export. If it finds { id?, server } it uses the v1 path and
// never touches getLegacyPlugins. The legacy path iterates every export and
// throws "Plugin export is not a function" on any non-callable value — a
// problem that surfaced on Windows where Bun standalone dynamic imports can
// produce module namespaces with extra non-function metadata.
//
// This test ensures the module exports exactly one default PluginModule
// object with a callable `server` and no named exports.
test("src/index.ts exports exactly one default PluginModule object", () => {
  const keys = Object.keys(mod)
  expect(keys).toEqual(["default"])
  const plugin = (mod as { default: unknown }).default
  expect(typeof plugin).toBe("object")
  expect(plugin).not.toBeNull()
  const obj = plugin as Record<string, unknown>
  expect(typeof obj.server).toBe("function")
  expect("id" in obj).toBe(true)
})

test("package exposes a separate TUI entrypoint", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    exports?: Record<string, string>
  }
  expect(pkg.exports?.["./tui"]).toBe("./src/tui.tsx")
  expect(fs.existsSync(new URL("../src/tui.tsx", import.meta.url))).toBe(true)
})
