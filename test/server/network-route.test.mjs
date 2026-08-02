import test from "node:test";
import assert from "node:assert/strict";

import { detectNetworkRoute, parseMacSystemProxy } from "../../src/server/network-route.mjs";

const configuredProxy = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7892
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
}</dictionary>`;

test("macOS proxy parser prefers the HTTPS route", () => {
  assert.deepEqual(parseMacSystemProxy(configuredProxy), {
    kind: "https",
    host: "127.0.0.1",
    port: 7890,
  });
});

test("route diagnostics distinguish a ready proxy from a dead local port", async () => {
  const base = { platform: "darwin", readSystemProxy: async () => configuredProxy };
  const ready = await detectNetworkRoute({ ...base, probe: async () => true });
  const down = await detectNetworkRoute({ ...base, probe: async () => false });

  assert.equal(ready.mode, "system-proxy");
  assert.equal(ready.status, "ready");
  assert.equal(down.status, "unreachable");
  assert.match(down.detail, /没有响应/);
});

test("route diagnostics report direct mode when no system proxy is enabled", async () => {
  const result = await detectNetworkRoute({
    platform: "darwin",
    readSystemProxy: async () => "<dictionary> { HTTPEnable : 0 }",
  });

  assert.equal(result.mode, "direct");
  assert.equal(result.proxy, null);
});
