export type CollectorStatus = "unknown" | "checking" | "installed" | "missing";
export type BrowserLaunchStatus = "idle" | "opening" | "opened" | "failed";
type Connection = { installed: boolean; version: string };

const pendingChecks = new WeakMap<Window, Promise<Connection>>();

/** Wait for the built-in collector, including content scripts that start after React. */
export function checkCollectorConnection(host: Window, timeoutMs = 5000, intervalMs = 300): Promise<Connection> {
  if (host.PriceScanDesktop) {
    return host.PriceScanDesktop.list().then(() => ({ installed: true, version: `desktop-${host.PriceScanDesktop!.version}` }), () => ({ installed: false, version: "" }));
  }
  const pending = pendingChecks.get(host);
  if (pending) return pending;
  const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const promise = new Promise<Connection>((resolve) => {
    let settled = false;
    const finish = (installed: boolean, version = "") => {
      if (settled) return;
      settled = true;
      host.clearTimeout(timer);
      host.clearInterval(interval);
      host.removeEventListener("message", receive);
      resolve({ installed, version });
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== host || event.origin !== host.location.origin) return;
      const data = event.data;
      if (data?.type === "PRICESCAN_COLLECTOR_PONG" && data.nonce === nonce) {
        finish(true, typeof data.version === "string" ? data.version : "");
      }
    };
    const ping = () => host.postMessage({ type: "PRICESCAN_COLLECTOR_PING", nonce }, host.location.origin);
    const timer = host.setTimeout(() => finish(false), timeoutMs);
    const interval = host.setInterval(ping, intervalMs);
    host.addEventListener("message", receive);
    ping();
  });
  pendingChecks.set(host, promise);
  void promise.then(() => pendingChecks.delete(host), () => pendingChecks.delete(host));
  return promise;
}

export async function launchCollectorBrowser(baseUrl: string, hostname: string, fetcher: typeof fetch = fetch, timeoutMs = 8000): Promise<void> {
  if (!["127.0.0.1", "localhost"].includes(hostname)) throw new Error("local browser required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${baseUrl}/actions/open-collector-browser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok || (await response.json()).status !== "launched") throw new Error("browser launch failed");
  } finally {
    clearTimeout(timer);
  }
}

export function collectorConnectionCopy(status: CollectorStatus, dedicated: boolean, launch: BrowserLaunchStatus) {
  if (status === "checking" || status === "unknown") return {
    title: "수집기 연결 중", detail: "이 창의 수집기를 확인하고 있습니다.", action: "잠시만요", kind: "waiting" as const,
  };
  if (status === "installed") return {
    title: "수집기 연결됨", detail: "별도 설정 없이 이 창에서 바로 검색하세요.", action: "확인", kind: "close" as const,
  };
  if (dedicated) return {
    title: "수집기 연결이 끊겼습니다", detail: "페이지를 새로고침하면 내장 수집기에 다시 연결합니다.", action: "새로고침", kind: "reload" as const,
  };
  if (launch === "opening") return {
    title: "전용 브라우저 여는 중", detail: "수집기가 포함된 PriceScan Browser를 엽니다.", action: "여는 중…", kind: "waiting" as const,
  };
  if (launch === "opened") return {
    title: "전용 브라우저를 열었습니다", detail: "새로 열린 PriceScan Browser에서 검색해 주세요.", action: "확인", kind: "close" as const,
  };
  if (launch === "failed") return {
    title: "전용 브라우저를 열지 못했습니다", detail: "PriceScan Browser 앱을 직접 실행하거나 다시 시도해 주세요.", action: "다시 열기", kind: "open" as const,
  };
  return {
    title: "전용 브라우저에서 검색하세요", detail: "PriceScan Browser에는 수집기가 기본으로 포함되어 있습니다.", action: "전용 브라우저 열기", kind: "open" as const,
  };
}
