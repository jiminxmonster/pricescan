import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { checkCollectorConnection, collectorConnectionCopy, launchCollectorBrowser } from "../src/collector-connection.ts";

const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../../extensions/pricescan-collector/pricescan-page.js", import.meta.url), "utf8");

test("desktop readiness is confirmed by native IPC without requesting an extension", async () => {
  const host = { PriceScanDesktop: { version: "test", list: async () => [] } } as unknown as Window;
  assert.deepEqual(await checkCollectorConnection(host), { installed: true, version: "desktop-test" });
});

test("a broken desktop bridge is not reported as connected", async () => {
  const host = { PriceScanDesktop: { version: "test", list: async () => { throw new Error("disconnected"); } } } as unknown as Window;
  assert.deepEqual(await checkCollectorConnection(host), { installed: false, version: "" });
});

test("the normal app never offers developer installation or a blocking collector setup modal", () => {
  for (const legacyUi of ["개발자용 수동 설치 옵션", "압축해제된 확장 프로그램 로드", "extension-requirement-modal", "가격수집기 준비</h2>"]) {
    assert.equal(appSource.includes(legacyUi), false, legacyUi);
  }
  assert.equal(appSource.includes("가격수집기가 준비된 PriceScan 전용 Chrome입니다"), false, "a launch URL is not proof of a working collector");
});

function contentBridge(runtimeId: string | undefined) {
  let receive: (event: unknown) => void = () => {};
  const posted: Array<{type: string; nonce: string}> = [];
  const window = {
    location: { origin: "http://127.0.0.1:8300" },
    addEventListener: (_: string, listener: typeof receive) => { receive = listener; },
    postMessage: (message: typeof posted[number]) => posted.push(message),
  };
  const chrome = { runtime: { id: runtimeId, onMessage: { addListener() {} } } };
  vm.runInNewContext(bridgeSource, { window, chrome });
  return { window, chrome, posted, ping() { receive({source: window, origin: window.location.origin, data: {type: "PRICESCAN_COLLECTOR_PING", nonce: "test-nonce"}}); } };
}

test("an invalidated collector must not announce that it is connected", () => {
  const bridge = contentBridge("live-extension");
  bridge.ping();
  assert.equal(bridge.posted.length, 1);
  bridge.chrome.runtime.id = undefined;
  bridge.ping();
  assert.equal(bridge.posted.length, 1, "old content scripts must stay silent after extension reload");
});

test("a working built-in collector answers the page handshake", () => {
  const bridge = contentBridge("live-extension");
  bridge.ping();
  assert.equal(bridge.posted[0].type, "PRICESCAN_COLLECTOR_PONG");
  assert.equal(bridge.posted[0].nonce, "test-nonce");
});

class FakePage {
  location = { origin: "http://127.0.0.1:8300" };
  listeners = new Set<(event: unknown) => void>();
  posted: Array<{type: string; nonce: string}> = [];
  timers = new Map<number, {call: () => void; at: number; repeat: number}>();
  now = 0;
  sequence = 0;
  host = this as unknown as Window;
  addEventListener(_: string, listener: (event: unknown) => void) { this.listeners.add(listener); }
  removeEventListener(_: string, listener: (event: unknown) => void) { this.listeners.delete(listener); }
  postMessage(message: typeof this.posted[number]) { this.posted.push(message); }
  setTimeout(call: () => void, delay: number) { const id = ++this.sequence; this.timers.set(id, {call, at: this.now + delay, repeat: 0}); return id; }
  setInterval(call: () => void, delay: number) { const id = this.setTimeout(call, delay); this.timers.get(id)!.repeat = delay; return id; }
  clearTimeout(id: number) { this.timers.delete(id); }
  clearInterval(id: number) { this.timers.delete(id); }
  advance(duration: number) {
    const until = this.now + duration;
    while (true) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.repeat) timer.at += timer.repeat; else this.timers.delete(id);
      timer.call();
    }
    this.now = until;
  }
  pong(overrides = {}) {
    const data = { type: "PRICESCAN_COLLECTOR_PONG", nonce: this.posted[0].nonce, version: "0.1.8" };
    for (const listener of this.listeners) listener({ source: this, origin: this.location.origin, data, ...overrides });
  }
}

test("startup and a simultaneous search share one handshake and clean up timers", async () => {
  const page = new FakePage();
  const first = checkCollectorConnection(page.host, 8000);
  const second = checkCollectorConnection(page.host, 8000);
  assert.equal(first, second);
  assert.equal(page.listeners.size, 1);
  page.advance(6500); // A delayed built-in content script is not treated as missing at 3s.
  page.pong();
  assert.deepEqual(await first, { installed: true, version: "0.1.8" });
  assert.equal(page.listeners.size, 0);
  assert.equal(page.timers.size, 0);

  const fresh = checkCollectorConnection(page.host, 8000);
  assert.notEqual(first, fresh, "connection checks must not cache stale success");
  page.advance(8000);
  assert.equal((await fresh).installed, false);
});

test("a failed handshake ignores unrelated messages and releases every resource", async () => {
  const page = new FakePage();
  const check = checkCollectorConnection(page.host, 3000);
  page.pong({ source: {} });
  page.pong({ origin: "https://other.example" });
  page.pong({ data: { type: "PRICESCAN_COLLECTOR_PONG", nonce: "different" } });
  assert.equal(page.listeners.size, 1);
  page.advance(3000);
  assert.deepEqual(await check, { installed: false, version: "" });
  assert.equal(page.listeners.size, 0);
  assert.equal(page.timers.size, 0);
});

test("dedicated-browser recovery never offers installation or opens duplicate windows", () => {
  assert.equal(collectorConnectionCopy("checking", true, "idle").kind, "waiting");
  assert.equal(collectorConnectionCopy("missing", true, "idle").kind, "reload");
  assert.equal(collectorConnectionCopy("installed", true, "idle").title, "수집기 연결됨");
  assert.equal(collectorConnectionCopy("missing", false, "idle").kind, "open");
  assert.equal(collectorConnectionCopy("missing", false, "opening").kind, "waiting");
  assert.equal(collectorConnectionCopy("missing", false, "opened").title, "전용 브라우저를 열었습니다");
  assert.equal(collectorConnectionCopy("missing", false, "failed").title, "전용 브라우저를 열지 못했습니다");
});

test("browser launch requires an acknowledged response from the local bridge", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(url, "http://127.0.0.1:8401/actions/open-collector-browser");
    assert.equal(options?.method, "POST");
    return new Response(JSON.stringify({status: "launched"}));
  };
  await launchCollectorBrowser("http://127.0.0.1:8401", "localhost", fetcher);
  await assert.rejects(launchCollectorBrowser("http://127.0.0.1:8401", "other.example", fetcher));
  assert.equal(requests, 1);
  await assert.rejects(launchCollectorBrowser("http://127.0.0.1:8401", "localhost", async () => new Response("{}", {status: 503})));
  await assert.rejects(launchCollectorBrowser("http://127.0.0.1:8401", "localhost", async () => new Response(JSON.stringify({status: "ok"}))));
});

test("a stalled local bridge request times out instead of leaving the opening button stuck", async () => {
  const stalledFetch: typeof fetch = async (_, options) => new Promise((_, reject) => {
    options!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
  });
  await assert.rejects(launchCollectorBrowser("http://127.0.0.1:8401", "localhost", stalledFetch, 10), /aborted/);
});
