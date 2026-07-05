import { useEffect, useState } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${basePath}/api`;
const TOKEN_KEY = "pricescan_admin_token";

type Tab = "dashboard" | "search" | "api" | "publish" | "pricing" | "invoice" | "tenant" | "logs";

type Dashboard = {
  stats: {
    collected_products: number;
    lowest_candidates: number;
    pending_publish: number;
    pricing_targets: number;
    invoice_ready: number;
    connected_apis: number;
  };
  latest_search: SearchPayload | null;
};

type SearchPayload = {
  run: { id: string; query: string; status: string; created_at: string } | null;
  items: PriceItem[];
  summary: {
    collected_count: number;
    lowest_count: number;
    excluded_count: number;
    baseline_total?: number;
  };
};

type PriceItem = {
  id: string;
  source: string;
  mall: string;
  name: string;
  price: number;
  shipping: number;
  total: number;
  url: string;
  margin: number;
  status: "baseline" | "candidate" | "abnormal" | "excluded";
  is_excluded: number;
  collected_at: string;
};

type ApiKey = {
  platform: string;
  label: string;
  client_id: string;
  client_secret: string;
  status: string;
  last_tested_at: string | null;
};

type Order = {
  id: string;
  channel: string;
  product: string;
  recipient: string;
  courier: string;
  status: string;
};

type Channel = {
  name: string;
  status: string;
  description: string;
};

type LogItem = {
  id: string;
  message: string;
  level: string;
  created_at: string;
};

async function request<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function money(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    baseline: "최저가 기준",
    candidate: "비교대상",
    abnormal: "이상가 제외 권장",
    excluded: "제외됨",
    ready: "출력 가능",
    address_check: "주소 확인",
    printed: "출력 완료",
    connected: "connected",
    configured: "configured",
    warning: "warning",
    not_configured: "not configured",
    pending: "pending",
  };
  return labels[status] || status;
}

function pillClass(status: string): string {
  if (["baseline", "ready", "connected", "printed"].includes(status)) return "pill green";
  if (["abnormal", "warning", "address_check"].includes(status)) return "pill orange";
  if (["excluded", "not_configured"].includes(status)) return "pill red";
  return "pill blue";
}

function LoginScreen({ onLogin }: { onLogin: (token: string) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [error, setError] = useState("");

  const submit = async () => {
    setError("");
    try {
      const data = await request<{ token: string }>("/auth/login", "", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      onLogin(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    }
  };

  return (
    <main className="login-page">
      <section className="login-card">
        <span className="eyebrow">PriceScan Admin</span>
        <h1>셀러 가격수집 자동화</h1>
        <p>관리자 계정으로 로그인하면 실제 백엔드 API와 연결된 복구 버전을 사용할 수 있습니다.</p>
        <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="아이디" />
        <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="비밀번호" />
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" onClick={submit}>로그인</button>
        <p className="hint">기본 계정: admin / admin</p>
      </section>
    </main>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
  const [tab, setTab] = useState<Tab>("dashboard");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [searchPayload, setSearchPayload] = useState<SearchPayload>({ run: null, items: [], summary: { collected_count: 0, lowest_count: 0, excluded_count: 0 } });
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [keyword, setKeyword] = useState("노트북");
  const [sortMode, setSortMode] = useState("lowest");
  const [collecting, setCollecting] = useState(false);
  const [apiPlatform, setApiPlatform] = useState("naver");
  const [apiClientId, setApiClientId] = useState("");
  const [apiClientSecret, setApiClientSecret] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);

  const loadAll = async () => {
    if (!token) return;
    const [dashboardData, latestSearch, keyData, orderData, channelData, logData] = await Promise.all([
      request<Dashboard>("/dashboard", token),
      request<SearchPayload>("/price-search/latest", token),
      request<ApiKey[]>("/api-keys", token),
      request<Order[]>("/orders", token),
      request<Channel[]>("/channels", token),
      request<LogItem[]>("/logs", token),
    ]);
    setDashboard(dashboardData);
    setSearchPayload(latestSearch);
    setApiKeys(keyData);
    setOrders(orderData);
    setChannels(channelData);
    setLogs(logData);
    const selected = keyData.find((item) => item.platform === apiPlatform) || keyData[0];
    if (selected) {
      setApiPlatform(selected.platform);
      setApiClientId(selected.client_id || "");
      setApiClientSecret(selected.client_secret || "");
    }
  };

  useEffect(() => {
    loadAll().catch((error) => setNotice(error.message));
  }, [token]);

  const refreshLogs = async () => {
    setLogs(await request<LogItem[]>("/logs", token));
  };

  const runSearch = async () => {
    setCollecting(true);
    setNotice("상품 가격 수집 중...");
    try {
      const data = await request<SearchPayload>("/price-search", token, {
        method: "POST",
        body: JSON.stringify({ query: keyword, sort_mode: sortMode, filters: ["brand", "memory"] }),
      });
      setSearchPayload(data);
      setDashboard(await request<Dashboard>("/dashboard", token));
      await refreshLogs();
      setNotice("가격 수집 완료");
      setTab("search");
    } finally {
      setCollecting(false);
    }
  };

  const stopSearch = async () => {
    await request<{ status: string }>("/price-search/stop", token, { method: "POST" });
    setCollecting(false);
    setNotice("수집 중지 요청 완료");
    await refreshLogs();
  };

  const selectBaseline = async (id: string) => {
    setSearchPayload(await request<SearchPayload>(`/price-items/${id}/baseline`, token, { method: "POST" }));
    await refreshLogs();
  };

  const toggleExclude = async (id: string) => {
    setSearchPayload(await request<SearchPayload>(`/price-items/${id}/exclude`, token, { method: "POST" }));
    await refreshLogs();
  };

  const selectApiPlatform = (platform: string) => {
    const selected = apiKeys.find((item) => item.platform === platform);
    setApiPlatform(platform);
    setApiClientId(selected?.client_id || "");
    setApiClientSecret(selected?.client_secret || "");
  };

  const saveApiKey = async () => {
    await request(`/api-keys/${apiPlatform}`, token, {
      method: "PUT",
      body: JSON.stringify({ client_id: apiClientId, client_secret: apiClientSecret }),
    });
    setApiKeys(await request<ApiKey[]>("/api-keys", token));
    setNotice("API 키 저장 완료");
    await refreshLogs();
  };

  const testApiKey = async () => {
    const result = await request<{ status: string; message: string }>(`/api-keys/${apiPlatform}/test`, token, { method: "POST" });
    setApiKeys(await request<ApiKey[]>("/api-keys", token));
    setNotice(result.message);
    await refreshLogs();
  };

  const printInvoices = async () => {
    const ids = selectedOrders.length ? selectedOrders : orders.filter((order) => order.status === "ready").map((order) => order.id);
    await request("/invoices/print", token, { method: "POST", body: JSON.stringify({ order_ids: ids }) });
    setOrders(await request<Order[]>("/orders", token));
    setSelectedOrders([]);
    setNotice("송장 출력 처리 완료");
    await refreshLogs();
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
  };

  if (!token) return <LoginScreen onLogin={setToken} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <strong>PriceScan</strong>
          <span>Auto Seller recovery</span>
        </div>
        <nav className="nav" aria-label="주 메뉴">
          {[
            ["dashboard", "대시보드"],
            ["search", "상품검색/가격비교"],
            ["api", "API 등록 모드"],
            ["publish", "쇼핑몰 자동등록"],
            ["pricing", "통합가격 조정"],
            ["invoice", "송장 자동출력"],
            ["tenant", "회원/권한"],
            ["logs", "작업 로그"],
          ].map(([key, label]) => (
            <button key={key} className={`${tab === key ? "active" : ""} ${key === "api" ? "orange" : ""}`} onClick={() => setTab(key as Tab)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="login-note">
          로그인: <strong>admin</strong> / <strong>admin</strong>
          <button className="btn small" onClick={logout}>로그아웃</button>
        </div>
      </aside>

      <main className="main">
        <header className="top">
          <div>
            <div className="eyebrow">market price automation</div>
            <h1>셀러용 가격수집·상품등록 자동화</h1>
            <p className="lead">가격 수집, 최저가 기준 선택, 이상가 제외, 마진 계산, 송장 출력까지 실제 백엔드와 연결된 복구 버전입니다.</p>
          </div>
          <span className="pill blue">FastAPI 연결됨</span>
        </header>

        {notice && <div className="notice">{notice}</div>}

        <section className="grid stats">
          <StatCard label="누적 수집 상품" value={dashboard?.stats.collected_products ?? 0} />
          <StatCard label="최저가 후보" value={dashboard?.stats.lowest_candidates ?? 0} />
          <StatCard label="등록 대기" value={dashboard?.stats.pending_publish ?? 0} />
          <StatCard label="가격조정 대상" value={dashboard?.stats.pricing_targets ?? 0} />
          <StatCard label="송장 출력" value={dashboard?.stats.invoice_ready ?? 0} />
        </section>

        {tab === "dashboard" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>운영 현황</h2>
                <p>현재 백엔드 API, SQLite 저장소, 관리자 로그인, 작업 로그까지 연결되어 있습니다.</p>
              </div>
              <button className="btn primary" onClick={runSearch}>빠른 수집 실행</button>
            </div>
            <div className="split">
              <div className="box">
                <strong>최근 검색</strong>
                <p>{searchPayload.run ? `${searchPayload.run.query} · ${searchPayload.summary.collected_count}건 수집` : "아직 검색 기록이 없습니다."}</p>
              </div>
              <div className="box">
                <strong>복구 진행도</strong>
                <p>1단계: 실제 백엔드 연결 완료. 다음 단계는 네이버 쇼핑 API 실제 호출과 DB 가격 이력 고도화입니다.</p>
              </div>
            </div>
          </section>
        )}

        {tab === "search" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>상품검색/가격비교</h2>
                <p>검색 결과는 백엔드에 저장되고, 기준가 선택/제외 처리도 API로 반영됩니다.</p>
              </div>
              <span className={collecting ? "pill orange" : "pill green"}>{collecting ? "수집 중" : "대기/완료"}</span>
            </div>
            <div className="toolbar">
              <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} aria-label="상품 검색어" />
              <select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="정렬">
                <option value="lowest">최저가순</option>
                <option value="margin">마진높은순</option>
                <option value="recent">최근수집순</option>
              </select>
              <button className="btn primary" onClick={runSearch} disabled={collecting}>돋보기 검색</button>
              <button className="btn danger" onClick={stopSearch} disabled={!collecting}>수집 중지</button>
            </div>
            <div className="box compact">
              <strong>상세검색 필드</strong>
              <label><input type="checkbox" defaultChecked /> 브랜드</label>
              <label><input type="checkbox" defaultChecked /> 용량/메모리</label>
              <label><input type="checkbox" /> 색상</label>
              <label><input type="checkbox" /> 무료배송</label>
            </div>
            <PriceTable payload={searchPayload} onBaseline={selectBaseline} onExclude={toggleExclude} />
          </section>
        )}

        {tab === "api" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>API 등록 모드</h2>
                <p>플랫폼별 API 키를 저장하고 백엔드에서 연결 상태를 테스트합니다.</p>
              </div>
              <span className="pill blue">{dashboard?.stats.connected_apis ?? 0} connected</span>
            </div>
            <div className="grid api-grid">
              {apiKeys.map((item) => (
                <button key={item.platform} className={`api-card ${apiPlatform === item.platform ? "selected" : ""}`} onClick={() => selectApiPlatform(item.platform)}>
                  <strong>{item.label}</strong>
                  <span className={pillClass(item.status)}>{statusLabel(item.status)}</span>
                  <p>{item.last_tested_at || "테스트 전"}</p>
                </button>
              ))}
            </div>
            <div className="form-grid mt">
              <input className="input" placeholder="Client ID" value={apiClientId} onChange={(event) => setApiClientId(event.target.value)} />
              <input className="input" placeholder="Client Secret" value={apiClientSecret} onChange={(event) => setApiClientSecret(event.target.value)} />
              <button className="btn primary" onClick={saveApiKey}>저장</button>
              <button className="btn orange" onClick={testApiKey}>연동 테스트</button>
            </div>
          </section>
        )}

        {tab === "publish" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>쇼핑몰 자동등록</h2>
                <p>현재는 채널별 등록 상태를 백엔드에서 가져옵니다. 실제 등록 API는 다음 단계에서 연결합니다.</p>
              </div>
            </div>
            <div className="grid channels">
              {channels.map((channel) => (
                <div className="channel" key={channel.name}>
                  <strong>{channel.name}</strong>
                  <p>{channel.description}</p>
                  <span className={pillClass(channel.status)}>{statusLabel(channel.status)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "pricing" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>통합가격 조정</h2>
                <p>선택된 최저가 기준으로 각 상품의 예상 마진을 계산합니다.</p>
              </div>
            </div>
            <div className="split">
              <div className="box"><strong>현재 기준가</strong><p>{money(searchPayload.summary.baseline_total || 0)}</p></div>
              <div className="box"><strong>제외 항목</strong><p>{searchPayload.summary.excluded_count}건</p></div>
            </div>
            <PriceTable payload={searchPayload} onBaseline={selectBaseline} onExclude={toggleExclude} />
          </section>
        )}

        {tab === "invoice" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>송장 자동출력</h2>
                <p>선택 주문을 출력 완료 상태로 변경합니다.</p>
              </div>
              <button className="btn primary" onClick={printInvoices}>선택 송장 출력</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>선택</th><th>주문번호</th><th>채널</th><th>상품</th><th>수령인</th><th>택배사</th><th>상태</th></tr></thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td><input type="checkbox" checked={selectedOrders.includes(order.id)} onChange={(event) => setSelectedOrders((ids) => event.target.checked ? [...ids, order.id] : ids.filter((id) => id !== order.id))} /></td>
                      <td>{order.id}</td>
                      <td>{order.channel}</td>
                      <td>{order.product}</td>
                      <td>{order.recipient}</td>
                      <td>{order.courier}</td>
                      <td><span className={pillClass(order.status)}>{statusLabel(order.status)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "tenant" && (
          <section className="section active">
            <div className="section-head"><div><h2>회원/권한</h2><p>초기 30명 셀러 운영 기준으로 테넌트 분리를 준비합니다.</p></div></div>
            <div className="box">현재 복구 단계에서는 관리자 단일 계정입니다. 다음 단계에서 셀러별 워크스페이스, API 키 분리, 과금 상태를 DB 모델로 추가합니다.</div>
          </section>
        )}

        {tab === "logs" && (
          <section className="section active">
            <div className="section-head"><div><h2>작업 로그</h2><p>백엔드에 기록되는 실제 작업 로그입니다.</p></div></div>
            <div className="log">
              {logs.map((item) => (
                <div className="log-item" key={item.id}><span>{item.message}</span><span>{item.created_at}</span></div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PriceTable({ payload, onBaseline, onExclude }: { payload: SearchPayload; onBaseline: (id: string) => void; onExclude: (id: string) => void }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>수집시각</th><th>소스</th><th>판매처</th><th>상품명</th><th>가격</th><th>배송비</th><th>총액</th><th>예상마진</th><th>상태</th><th>액션</th><th>링크</th>
          </tr>
        </thead>
        <tbody>
          {payload.items.map((item) => (
            <tr key={item.id}>
              <td>{item.collected_at}</td>
              <td>{item.source}</td>
              <td>{item.mall}</td>
              <td><a className="product-link" href={item.url} target="_blank" rel="noreferrer">{item.name}</a></td>
              <td>{money(item.price)}</td>
              <td>{money(item.shipping)}</td>
              <td>{money(item.total)}</td>
              <td>{item.status === "baseline" ? "기준가" : money(item.margin)}</td>
              <td><span className={pillClass(item.status)}>{statusLabel(item.status)}</span></td>
              <td className="actions">
                <button className="btn small" onClick={() => onBaseline(item.id)}>기준</button>
                <button className="btn small danger" onClick={() => onExclude(item.id)}>{item.is_excluded ? "복구" : "제외"}</button>
              </td>
              <td><a className="btn small" href={item.url} target="_blank" rel="noreferrer">이동</a></td>
            </tr>
          ))}
          {payload.items.length === 0 && <tr><td colSpan={11}>검색 결과가 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
