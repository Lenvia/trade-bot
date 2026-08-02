import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseMacSystemProxy(output) {
  const values = new Map();
  for (const line of String(output).split("\n")) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }
  for (const kind of ["HTTPS", "HTTP", "SOCKS"]) {
    if (values.get(`${kind}Enable`) !== "1") continue;
    const host = values.get(`${kind}Proxy`);
    const port = Number(values.get(`${kind}Port`));
    if (host && Number.isInteger(port) && port > 0 && port <= 65_535) {
      return { kind: kind.toLowerCase(), host, port };
    }
  }
  return null;
}

export async function detectNetworkRoute({
  platform = process.platform,
  readSystemProxy = readMacSystemProxy,
  probe = probeTcp,
} = {}) {
  const checkedAt = new Date().toISOString();
  if (platform !== "darwin") {
    return routeResult("unknown", "unknown", null, checkedAt, "当前运行环境无法读取系统代理设置。");
  }
  try {
    const proxy = parseMacSystemProxy(await readSystemProxy());
    if (!proxy) {
      return routeResult("direct", "ready", null, checkedAt, "macOS 没有启用 HTTP、HTTPS 或 SOCKS 系统代理。");
    }
    const reachable = await probe(proxy.host, proxy.port);
    return reachable
      ? routeResult("system-proxy", "ready", proxy, checkedAt, "系统代理已配置，本地代理端口可以连接。")
      : routeResult("system-proxy", "unreachable", proxy, checkedAt, "系统代理已配置，但本地代理端口没有响应。");
  } catch (error) {
    return routeResult(
      "unknown",
      "unknown",
      null,
      checkedAt,
      `读取系统代理失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readMacSystemProxy() {
  const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 1_500,
    maxBuffer: 128 * 1024,
  });
  return stdout;
}

function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function routeResult(mode, status, proxy, checkedAt, detail) {
  return {
    mode,
    status,
    proxy,
    checkedAt,
    detail,
    disclaimer: "这是系统代理配置与端口可用性诊断；浏览器扩展或独立代理设置仍可能覆盖实际请求路由。",
  };
}
