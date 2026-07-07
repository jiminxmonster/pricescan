import { useEffect, useState } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${basePath}/api`;
const TOKEN_KEY = "pricescan_admin_token";
const SETTINGS_KEY = "pricescan_admin_settings";

type FeatureKey = "publish" | "pricing" | "invoice" | "tenant";
type Tab = "search" | "api" | "settings" | FeatureKey;

type AdminSettings = {
  showSidebar: boolean;
  features: Record<FeatureKey, boolean>;
};

const defaultSettings: AdminSettings = {
  showSidebar: false,
  features: {
    publish: false,
    pricing: false,
    invoice: false,
    tenant: false,
  },
};

const primaryTabs: Array<{ key: Tab; label: string; description: string }> = [
  { key: "search", label: "상품검색", description: "API 등을 통해 해당상품 가격 검색" },
  { key: "api", label: "검색설정", description: "쇼핑몰/API 키 등록과 연동 테스트" },
  { key: "settings", label: "관리자설정", description: "메뉴와 기능 사용여부 설정" },
];

const optionalTabs: Array<{ key: FeatureKey; label: string; description: string }> = [
  { key: "publish", label: "쇼핑몰 자동등록", description: "상품등록 자동화 기능" },
  { key: "pricing", label: "통합가격 조정", description: "마진 기준 가격 일괄 조정" },
  { key: "invoice", label: "송장 출력", description: "주문 송장 자동 출력" },
  { key: "tenant", label: "회원권한", description: "셀러별 권한/워크스페이스" },
];

type SearchSourceOption = {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  badge: string;
};

type SearchSourceGroup = {
  title: string;
  options: SearchSourceOption[];
};

const searchSourceGroups: SearchSourceGroup[] = [
  {
    title: "검색엔진 / 검색 API",
    options: [
      { key: "naver", label: "네이버 쇼핑검색", description: "공식 쇼핑 검색 API", enabled: true, badge: "사용 가능" },
      { key: "google_search", label: "구글 검색 크롤링", description: "검색결과 파싱 미구현", enabled: false, badge: "준비 중" },
      { key: "naver_search", label: "네이버 일반검색 크롤링", description: "일반검색 파싱 미구현", enabled: false, badge: "준비 중" },
    ],
  },
  {
    title: "쇼핑몰 / 가격비교",
    options: [
      { key: "smartstore", label: "스마트스토어", description: "커머스API 키 입력 가능, 검색수집 미연동", enabled: false, badge: "API 설정 가능" },
      { key: "danawa", label: "다나와", description: "검색 페이지 크롤러", enabled: true, badge: "사용 가능" },
      { key: "enuri", label: "에누리", description: "서버 요청 오류로 임시 비활성", enabled: false, badge: "점검 중" },
      { key: "elevenst", label: "11번가", description: "수집기 미구현", enabled: false, badge: "준비 중" },
      { key: "gmarket", label: "G마켓", description: "수집기 미구현", enabled: false, badge: "준비 중" },
      { key: "auction", label: "옥션", description: "수집기 미구현", enabled: false, badge: "준비 중" },
    ],
  },
];

const readySourceKeys = new Set(searchSourceGroups.flatMap((group) => group.options.filter((option) => option.enabled).map((option) => option.key)));
const apiPlatformOrder = ["naver", "smartstore", "danawa", "enuri", "elevenst", "gmarket", "auction", "google_search", "naver_search", "coupang"];

function readSettings(): AdminSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return defaultSettings;
    const parsed = JSON.parse(saved) as Partial<AdminSettings>;
    return {
      showSidebar: Boolean(parsed.showSidebar),
      features: { ...defaultSettings.features, ...(parsed.features || {}) },
    };
  } catch {
    return defaultSettings;
  }
}

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
  warnings?: string[];
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

type DetailFilterOption = {
  value: string;
  label: string;
  count: number;
};

type DetailFilter = {
  key: string;
  label: string;
  options: DetailFilterOption[];
};

type SelectedDetailFilters = Record<string, string[]>;

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

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "");
}

function itemText(item: PriceItem): string {
  return `${item.name} ${item.mall}`.toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractBrand(item: PriceItem): string[] {
  const text = itemText(item);
  const brands = [
    [/삼성|samsung|갤럭시북|galaxybook/i, "삼성"],
    [/lg전자|(^|[^a-z])lg([^a-z]|$)|그램|울트라pc/i, "LG"],
    [/apple|맥북|macbook/i, "Apple"],
    [/asus|에이수스|비보북|vivobook|tuf/i, "ASUS"],
    [/(^|[^a-z])hp([^a-z]|$)/i, "HP"],
    [/msi|소드|스텔스|프레스티지/i, "MSI"],
    [/lenovo|레노버|thinkpad|씽크패드|ideapad/i, "Lenovo"],
    [/dell|델|xps|inspiron/i, "Dell"],
    [/acer|에이서|swift|aspire/i, "Acer"],
    [/한성|tfg/i, "한성"],
    [/gigabyte|기가바이트|aorus/i, "Gigabyte"],
    [/microsoft|서피스|surface/i, "Microsoft"],
  ] as Array<[RegExp, string]>;
  return brands.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

function extractScreen(item: PriceItem): string[] {
  const values: string[] = [];
  const text = item.name;
  for (const match of text.matchAll(/(\d{2}(?:\.\d)?)\s?(?:형|인치|inch|")/gi)) {
    values.push(`${match[1]}형`);
  }
  for (const match of text.matchAll(/(?:그램|gram|비보북|vivobook|갤럭시북|macbook|맥북)\s?(1[3-8])(?:\s|$|-)/gi)) {
    values.push(`${match[1]}형`);
  }
  return unique(values);
}

function extractCpu(item: PriceItem): string[] {
  const text = item.name;
  const values: string[] = [];
  for (const match of text.matchAll(/\b(i[3579]|ryzen\s?[3579]|라이젠\s?[3579]|m[1-5])\b/gi)) {
    values.push(match[1].replace(/\s+/g, " ").toUpperCase());
  }
  return unique(values);
}

function extractMemory(item: PriceItem): string[] {
  const values: string[] = [];
  for (const match of item.name.matchAll(/(\d{1,3})\s?GB/gi)) {
    const after = item.name.slice(match.index || 0, (match.index || 0) + 16).toLowerCase();
    if (/(ssd|nvme|hdd)/i.test(after)) continue;
    const amount = Number(match[1]);
    if (amount >= 4 && amount <= 128) values.push(`${amount}GB`);
  }
  return unique(values);
}

function extractStorage(item: PriceItem): string[] {
  const values: string[] = [];
  for (const match of item.name.matchAll(/(\d+(?:\.\d+)?)\s?(GB|TB)\s?(SSD|NVMe|HDD)/gi)) {
    values.push(`${match[1]}${match[2].toUpperCase()}`);
  }
  return unique(values);
}

function extractOs(item: PriceItem): string[] {
  const text = itemText(item);
  const values: string[] = [];
  if (/win\s?11|windows\s?11|윈도우\s?11/i.test(text)) values.push("Windows 11");
  if (/win\s?10|windows\s?10|윈도우\s?10/i.test(text)) values.push("Windows 10");
  if (/freedos|free dos|프리도스/i.test(text)) values.push("FreeDOS");
  if (/macos|맥os/i.test(text)) values.push("macOS");
  return values;
}

function extractConnector(item: PriceItem): string[] {
  const text = itemText(item);
  const values: string[] = [];
  if (/usb\s?c|c타입|type\s?c/i.test(text)) values.push("USB-C");
  if (/usb\s?a|a타입|type\s?a/i.test(text)) values.push("USB-A");
  if (/hdmi/i.test(text)) values.push("HDMI");
  if (/lightning|라이트닝/i.test(text)) values.push("Lightning");
  if (/dp|displayport|디스플레이포트/i.test(text)) values.push("DisplayPort");
  return values;
}

function extractLength(item: PriceItem): string[] {
  const values: string[] = [];
  for (const match of item.name.matchAll(/(\d+(?:\.\d+)?)\s?(m|cm)\b/gi)) {
    values.push(`${match[1]}${match[2].toLowerCase()}`);
  }
  return unique(values);
}

function extractWatt(item: PriceItem): string[] {
  const values: string[] = [];
  for (const match of item.name.matchAll(/(\d{2,3})\s?W\b/gi)) {
    values.push(`${match[1]}W`);
  }
  return unique(values);
}

function extractColor(item: PriceItem): string[] {
  const text = itemText(item);
  const colors = ["블랙", "화이트", "실버", "그레이", "그린", "블루", "레드", "핑크", "베이지"];
  return colors.filter((color) => text.includes(color.toLowerCase()));
}

function extractCapacity(item: PriceItem): string[] {
  const values: string[] = [];
  for (const match of item.name.matchAll(/(\d+(?:\.\d+)?)\s?(ml|l|리터|kg|g)\b/gi)) {
    values.push(`${match[1]}${match[2].toUpperCase()}`);
  }
  return unique(values);
}

function extractShipping(item: PriceItem): string[] {
  return [item.shipping === 0 ? "무료배송" : "유료배송"];
}

function extractPriceBand(item: PriceItem): string[] {
  if (item.total < 100000) return ["10만원 미만"];
  if (item.total < 500000) return ["10만-50만원"];
  if (item.total < 1000000) return ["50만-100만원"];
  if (item.total < 2000000) return ["100만-200만원"];
  return ["200만원 이상"];
}

const filterExtractors: Record<string, (item: PriceItem) => string[]> = {
  brand: extractBrand,
  screen: extractScreen,
  cpu: extractCpu,
  memory: extractMemory,
  storage: extractStorage,
  os: extractOs,
  connector: extractConnector,
  length: extractLength,
  watt: extractWatt,
  color: extractColor,
  capacity: extractCapacity,
  shipping: extractShipping,
  mall: (item) => [item.mall],
  source: (item) => [item.source],
  priceBand: extractPriceBand,
};

function filterDefinitions(keyword: string): Array<{ key: string; label: string }> {
  const text = normalize(keyword);
  if (/노트북|랩탑|laptop|맥북|그램|갤럭시북/.test(text)) {
    return [
      { key: "brand", label: "브랜드" },
      { key: "screen", label: "화면크기" },
      { key: "cpu", label: "CPU" },
      { key: "memory", label: "메모리" },
      { key: "storage", label: "저장장치" },
      { key: "os", label: "OS" },
      { key: "priceBand", label: "가격대" },
      { key: "shipping", label: "배송" },
    ];
  }
  if (/케이블|충전기|어댑터|usb|hdmi|c타입|typec/.test(text)) {
    return [
      { key: "brand", label: "브랜드" },
      { key: "connector", label: "단자" },
      { key: "length", label: "길이" },
      { key: "watt", label: "출력" },
      { key: "color", label: "색상" },
      { key: "priceBand", label: "가격대" },
      { key: "shipping", label: "배송" },
    ];
  }
  return [
    { key: "brand", label: "브랜드" },
    { key: "capacity", label: "용량/규격" },
    { key: "color", label: "색상" },
    { key: "priceBand", label: "가격대" },
    { key: "shipping", label: "배송" },
    { key: "mall", label: "판매처" },
  ];
}

function buildDetailFilters(keyword: string, items: PriceItem[]): DetailFilter[] {
  return filterDefinitions(keyword)
    .map((definition) => {
      const counts = new Map<string, number>();
      const extractor = filterExtractors[definition.key];
      items.forEach((item) => {
        unique(extractor(item)).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
      });
      const options = [...counts.entries()]
        .map(([value, count]) => ({ value, label: value, count }))
        .filter((option) => option.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "ko"));
      return { ...definition, options };
    })
    .filter((filter) => filter.options.length > 1)
    .slice(0, 7);
}

function templateOptions(values: string[]): DetailFilterOption[] {
  return values.map((value) => ({ value, label: value, count: 0 }));
}

function templateDetailFilters(keyword: string): DetailFilter[] {
  const text = normalize(keyword);
  if (!text) return [];
  if (/노트북|랩탑|laptop|맥북|그램|갤럭시북/.test(text)) {
    return [
      { key: "brand", label: "브랜드", options: templateOptions(["삼성", "LG", "Apple", "ASUS", "HP", "Lenovo", "Dell", "MSI"]) },
      { key: "screen", label: "화면크기", options: templateOptions(["13형", "14형", "15형", "16형", "17형"]) },
      { key: "cpu", label: "CPU", options: templateOptions(["I5", "I7", "I9", "RYZEN 5", "RYZEN 7", "M3", "M4"]) },
      { key: "memory", label: "메모리", options: templateOptions(["8GB", "16GB", "32GB", "64GB"]) },
      { key: "storage", label: "저장장치", options: templateOptions(["256GB", "512GB", "1TB", "2TB"]) },
      { key: "os", label: "OS", options: templateOptions(["Windows 11", "FreeDOS", "macOS"]) },
      { key: "shipping", label: "배송", options: templateOptions(["무료배송", "유료배송"]) },
    ];
  }
  if (/케이블|충전기|어댑터|usb|hdmi|c타입|typec/.test(text)) {
    return [
      { key: "connector", label: "단자", options: templateOptions(["USB-C", "USB-A", "HDMI", "Lightning", "DisplayPort"]) },
      { key: "length", label: "길이", options: templateOptions(["0.5m", "1m", "1.5m", "2m", "3m"]) },
      { key: "watt", label: "출력", options: templateOptions(["30W", "45W", "65W", "100W", "140W"]) },
      { key: "color", label: "색상", options: templateOptions(["블랙", "화이트", "실버", "그레이"]) },
      { key: "shipping", label: "배송", options: templateOptions(["무료배송", "유료배송"]) },
    ];
  }
  return [
    { key: "brand", label: "브랜드", options: templateOptions(["삼성", "LG", "Apple", "샤오미", "레노버"]) },
    { key: "capacity", label: "용량/규격", options: templateOptions(["128GB", "256GB", "512GB", "1TB", "1L", "2L", "1kg"]) },
    { key: "color", label: "색상", options: templateOptions(["블랙", "화이트", "실버", "그레이", "블루", "핑크"]) },
    { key: "shipping", label: "배송", options: templateOptions(["무료배송", "유료배송"]) },
  ];
}

function buildDetailSearchQuery(keyword: string, selected: SelectedDetailFilters): string {
  const queryParts = Object.entries(selected)
    .filter(([key]) => !["shipping", "priceBand"].includes(key))
    .flatMap(([, values]) => values)
    .filter(Boolean);
  return unique([keyword.trim(), ...queryParts]).join(" ").trim();
}

function sanitizeSelectedFilters(selected: SelectedDetailFilters, filters: DetailFilter[]): SelectedDetailFilters {
  const valid = new Map(filters.map((filter) => [filter.key, new Set(filter.options.map((option) => option.value))]));
  return Object.fromEntries(
    Object.entries(selected)
      .map(([key, values]) => [key, values.filter((value) => valid.get(key)?.has(value))])
      .filter(([, values]) => values.length > 0),
  );
}

function filterPriceItems(items: PriceItem[], selected: SelectedDetailFilters): PriceItem[] {
  const activeFilters = Object.entries(selected).filter(([, values]) => values.length > 0);
  if (activeFilters.length === 0) return items;
  return items.filter((item) =>
    activeFilters.every(([key, values]) => {
      const itemValues = filterExtractors[key]?.(item) || [];
      return values.some((value) => itemValues.includes(value));
    }),
  );
}

function sortedPriceItems(items: PriceItem[], sortMode: string): PriceItem[] {
  const sorted = [...items];
  if (sortMode === "margin") {
    return sorted.sort((a, b) => b.margin - a.margin || a.total - b.total);
  }
  if (sortMode === "recent") {
    return sorted.sort((a, b) => b.collected_at.localeCompare(a.collected_at) || b.id.localeCompare(a.id));
  }
  return sorted.sort((a, b) => a.total - b.total || a.price - b.price);
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
  const [tab, setTab] = useState<Tab>("search");
  const [settings, setSettings] = useState<AdminSettings>(readSettings);
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
  const [selectedDetailFilters, setSelectedDetailFilters] = useState<SelectedDetailFilters>({});
  const [showDetailScan, setShowDetailScan] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>(["naver", "danawa"]);

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
    const visibleKeyData = keyData.filter((item) => item.platform !== "naver_datalab");
    const selected = visibleKeyData.find((item) => item.platform === apiPlatform) || visibleKeyData.find((item) => item.platform === "naver") || visibleKeyData[0];
    if (selected) {
      setApiPlatform(selected.platform);
      setApiClientId(selected.client_id || "");
      setApiClientSecret(selected.client_secret || "");
    }
  };

  useEffect(() => {
    loadAll().catch((error) => setNotice(error.message));
  }, [token]);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    const enabledTabs = new Set<Tab>([
      ...primaryTabs.map((item) => item.key),
      ...optionalTabs.filter((item) => settings.features[item.key]).map((item) => item.key),
    ]);
    if (!enabledTabs.has(tab)) setTab("search");
  }, [settings, tab]);

  const refreshLogs = async () => {
    setLogs(await request<LogItem[]>("/logs", token));
  };

  const runSearch = async (mode: "simple" | "detail" = "simple") => {
    const keywordValue = keyword.trim();
    if (!keywordValue) {
      setNotice("검색어를 입력하세요.");
      return;
    }
    const sources = selectedSources.filter((source) => readySourceKeys.has(source));
    if (sources.length === 0) {
      setNotice("사용 가능한 검색 소스를 최소 1개 선택하세요.");
      return;
    }
    const templateFilters = templateDetailFilters(keywordValue);
    const detailSelection = mode === "detail" ? sanitizeSelectedFilters(selectedDetailFilters, templateFilters) : {};
    const query = mode === "detail" ? buildDetailSearchQuery(keywordValue, detailSelection) : keywordValue;
    setCollecting(true);
    if (mode === "simple") {
      setSelectedDetailFilters({});
      setShowDetailScan(false);
    }
    setNotice(mode === "detail" ? "상세조건으로 상품 가격 수집 중..." : "상품 가격 수집 중...");
    try {
      const data = await request<SearchPayload>("/price-search", token, {
        method: "POST",
        body: JSON.stringify({ query, sort_mode: sortMode, filters: Object.keys(detailSelection), sources }),
      });
      setSearchPayload(data);
      if (mode === "detail") setSelectedDetailFilters(detailSelection);
      setDashboard(await request<Dashboard>("/dashboard", token));
      await refreshLogs();
      setNotice(mode === "detail" ? "상세스캔 완료" : "가격 수집 완료");
      setTab("search");
    } finally {
      setCollecting(false);
    }
  };

  const openDetailScan = () => {
    if (!keyword.trim()) {
      setNotice("검색어를 먼저 입력하세요.");
      return;
    }
    setShowDetailScan(true);
    setNotice("상세조건을 선택한 뒤 조건 적용 스캔을 누르세요.");
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
    const clientId = apiClientId.trim();
    const clientSecret = apiClientSecret.trim();
    await request(`/api-keys/${apiPlatform}`, token, {
      method: "PUT",
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
    });
    setApiKeys(await request<ApiKey[]>("/api-keys", token));
    setApiClientId(clientId);
    setApiClientSecret(clientSecret);
    setNotice("API 키 저장 완료");
    await refreshLogs();
  };

  const testApiKey = async () => {
    const clientId = apiClientId.trim();
    const clientSecret = apiClientSecret.trim();
    if (clientId || clientSecret) {
      await request(`/api-keys/${apiPlatform}`, token, {
        method: "PUT",
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      });
      setApiClientId(clientId);
      setApiClientSecret(clientSecret);
    }
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

  const toggleFeature = (feature: FeatureKey) => {
    setSettings((current) => ({
      ...current,
      features: {
        ...current.features,
        [feature]: !current.features[feature],
      },
    }));
  };

  const toggleSidebar = () => {
    setSettings((current) => ({ ...current, showSidebar: !current.showSidebar }));
  };

  const toggleDetailFilter = (filterKey: string, value: string) => {
    setSelectedDetailFilters((current) => {
      const currentValues = current[filterKey] || [];
      const nextValues = currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues, value];
      const next = { ...current, [filterKey]: nextValues };
      if (nextValues.length === 0) delete next[filterKey];
      return next;
    });
  };

  const toggleSearchSource = (source: string) => {
    if (!readySourceKeys.has(source)) return;
    setSelectedSources((current) => {
      if (current.includes(source)) {
        const next = current.filter((item) => item !== source);
        if (next.length === 0) {
          setNotice("사용 가능한 검색 소스를 최소 1개는 선택해야 합니다.");
          return current;
        }
        return next;
      }
      return [...current, source];
    });
  };

  const changeSortMode = (value: string) => {
    setSortMode(value);
    if (searchPayload.items.length > 0) {
      const label = value === "margin" ? "마진높은순" : value === "recent" ? "최근검색순" : "최저가순";
      setNotice(`${label} 정렬 적용`);
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
  };

  if (!token) return <LoginScreen onLogin={setToken} />;

  const enabledOptionalTabs = optionalTabs.filter((item) => settings.features[item.key]);
  const visibleTabs = [...primaryTabs, ...enabledOptionalTabs];
  const visibleApiKeys = apiKeys
    .filter((item) => item.platform !== "naver_datalab")
    .sort((a, b) => {
      const aIndex = apiPlatformOrder.indexOf(a.platform);
      const bIndex = apiPlatformOrder.indexOf(b.platform);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex) || a.label.localeCompare(b.label, "ko");
    });
  const filterKeyword = searchPayload.run?.query || keyword;
  const detailFilters = buildDetailFilters(filterKeyword, searchPayload.items);
  const scanTemplateFilters = templateDetailFilters(keyword);
  const activeTemplateFilters = sanitizeSelectedFilters(selectedDetailFilters, scanTemplateFilters);
  const activeDetailFilters = sanitizeSelectedFilters(selectedDetailFilters, detailFilters);
  const filteredSearchPayload = {
    ...searchPayload,
    items: sortedPriceItems(filterPriceItems(searchPayload.items, activeDetailFilters), sortMode),
  };

  return (
    <div className={`app ${settings.showSidebar ? "with-sidebar" : ""}`}>
      {settings.showSidebar && (
        <aside className="sidebar">
          <div className="brand">
            <strong>PriceScan</strong>
            <span>관리자 설정에서 임시 표시 중</span>
          </div>
          <nav className="nav" aria-label="좌측 임시 메뉴">
            {visibleTabs.map((item) => (
              <button key={item.key} className={`${tab === item.key ? "active" : ""} ${item.key === "api" ? "orange" : ""}`} onClick={() => setTab(item.key)}>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="login-note">
            로그인: <strong>admin</strong> / <strong>admin</strong>
            <button className="btn small" onClick={logout}>로그아웃</button>
          </div>
        </aside>
      )}

      <main className="main">
        <header className="top-shell">
          <div className="top-brand">
            <strong>PriceScan</strong>
            <span>상품검색 · 검색설정 중심 운영</span>
          </div>
          <nav className="top-nav" aria-label="상단 메뉴">
            {visibleTabs.map((item) => (
              <button key={item.key} className={`${tab === item.key ? "active" : ""} ${item.key === "api" ? "orange" : ""}`} onClick={() => setTab(item.key)}>
                <strong>{item.label}</strong>
              </button>
            ))}
          </nav>
          <div className="top-actions">
            <span className="pill blue">FastAPI 연결됨</span>
            <button className="btn small" onClick={logout}>로그아웃</button>
          </div>
        </header>

        {notice && <div className="notice">{notice}</div>}

        <section className="grid stats focused-stats">
          <StatCard label="누적 수집 상품" value={dashboard?.stats.collected_products ?? 0} />
          <StatCard label="최저가 후보" value={dashboard?.stats.lowest_candidates ?? 0} />
          <StatCard label="연동 API" value={dashboard?.stats.connected_apis ?? 0} />
        </section>

        {tab === "search" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>상품검색</h2>
              </div>
              <span className={collecting ? "pill orange" : "pill green"}>{collecting ? "수집 중" : "대기/완료"}</span>
            </div>
            <div className="toolbar">
              <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} aria-label="상품 검색어" />
              <select value={sortMode} onChange={(event) => changeSortMode(event.target.value)} aria-label="정렬">
                <option value="lowest">최저가순</option>
                <option value="margin">마진높은순</option>
                <option value="recent">최근검색순</option>
              </select>
              <button className="btn orange" onClick={openDetailScan} disabled={collecting}>상세스캔</button>
              <button className="btn primary" onClick={() => runSearch("simple")} disabled={collecting}>스캔</button>
              <button className="btn danger" onClick={stopSearch} disabled={!collecting}>수집 중지</button>
            </div>
            <SourceSelector groups={searchSourceGroups} selected={selectedSources} onToggle={toggleSearchSource} />
            {showDetailScan && (
              <DetailScanBuilder
                filters={scanTemplateFilters}
                selected={activeTemplateFilters}
                onToggle={toggleDetailFilter}
                onClear={() => setSelectedDetailFilters({})}
                onClose={() => setShowDetailScan(false)}
                onScan={() => runSearch("detail")}
                disabled={collecting}
              />
            )}
            {Boolean(searchPayload.warnings?.length) && (
              <div className="source-warning">
                {searchPayload.warnings?.map((warning) => <span key={warning}>{warning}</span>)}
              </div>
            )}
            <DetailFilterPanel
              filters={detailFilters}
              selected={activeDetailFilters}
              totalCount={searchPayload.items.length}
              visibleCount={filteredSearchPayload.items.length}
              onToggle={toggleDetailFilter}
              onClear={() => setSelectedDetailFilters({})}
            />
            <PriceTable payload={filteredSearchPayload} onBaseline={selectBaseline} onExclude={toggleExclude} />
          </section>
        )}

        {tab === "api" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>검색설정</h2>
                <p>플랫폼별 API 키를 저장하고 백엔드에서 연결 상태를 테스트합니다.</p>
              </div>
              <span className="pill blue">{dashboard?.stats.connected_apis ?? 0} connected</span>
            </div>
            <div className="grid api-grid">
              {visibleApiKeys.map((item) => (
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
              <button className="btn orange" onClick={testApiKey}>저장 후 연동 테스트</button>
            </div>
          </section>
        )}

        {settings.features.publish && tab === "publish" && (
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

        {settings.features.pricing && tab === "pricing" && (
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
            <PriceTable payload={filteredSearchPayload} onBaseline={selectBaseline} onExclude={toggleExclude} />
          </section>
        )}

        {settings.features.invoice && tab === "invoice" && (
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

        {settings.features.tenant && tab === "tenant" && (
          <section className="section active">
            <div className="section-head"><div><h2>회원/권한</h2><p>초기 30명 셀러 운영 기준으로 테넌트 분리를 준비합니다.</p></div></div>
            <div className="box">현재 복구 단계에서는 관리자 단일 계정입니다. 다음 단계에서 셀러별 워크스페이스, API 키 분리, 과금 상태를 DB 모델로 추가합니다.</div>
          </section>
        )}

        {tab === "settings" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>관리자설정</h2>
                <p>좌측 메뉴와 확장 기능 노출 여부를 관리합니다. 기본값은 핵심 기능만 켜진 상태입니다.</p>
              </div>
              <button className="btn" onClick={refreshLogs}>로그 새로고침</button>
            </div>
            <div className="settings-grid">
              <div className="box settings-box">
                <strong>메뉴 표시</strong>
                <label className="toggle-row">
                  <input type="checkbox" checked={settings.showSidebar} onChange={toggleSidebar} />
                  <span>좌측 메뉴 임시 표시</span>
                  <em>{settings.showSidebar ? "켜짐" : "꺼짐"}</em>
                </label>
                <p>기본 메뉴는 상단 메뉴입니다. 좌측 메뉴는 필요할 때만 임시로 표시합니다.</p>
              </div>
              <div className="box settings-box">
                <strong>확장 기능 사용 여부</strong>
                {optionalTabs.map((item) => (
                  <label className="toggle-row" key={item.key}>
                    <input type="checkbox" checked={settings.features[item.key]} onChange={() => toggleFeature(item.key)} />
                    <span>{item.label}</span>
                    <em>{settings.features[item.key] ? "사용" : "숨김"}</em>
                  </label>
                ))}
                <p>꺼진 기능은 상단 메뉴와 좌측 메뉴에서 모두 숨깁니다.</p>
              </div>
            </div>
            <div className="box mt">
              <strong>현재 집중 기능</strong>
              <p>상품검색과 검색설정만 기본 노출합니다. 쇼핑몰 자동등록, 통합가격 조정, 송장 출력, 회원권한은 체크를 켜야 메뉴에 나타납니다.</p>
            </div>
            <div className="log compact-log">
              {logs.slice(0, 8).map((item) => (
                <div className="log-item" key={item.id}><span>{item.message}</span><span>{item.created_at}</span></div>
              ))}
              {logs.length === 0 && <div className="log-item"><span>작업 로그가 없습니다.</span><span>-</span></div>}
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

function SourceSelector({
  groups,
  selected,
  onToggle,
}: {
  groups: SearchSourceGroup[];
  selected: string[];
  onToggle: (source: string) => void;
}) {
  return (
    <div className="box source-selector">
      <div className="source-selector-head">
        <strong>검색 소스 선택</strong>
        <span>사용 가능한 소스만 체크할 수 있습니다.</span>
      </div>
      <div className="source-group-grid">
        {groups.map((group) => (
          <div className="source-group" key={group.title}>
            <strong>{group.title}</strong>
            <div className="source-options">
              {group.options.map((option) => (
                <label className={`source-option ${option.enabled ? "" : "disabled"}`} key={option.key}>
                  <input
                    type="checkbox"
                    checked={selected.includes(option.key)}
                    disabled={!option.enabled}
                    onChange={() => onToggle(option.key)}
                  />
                  <span>
                    <b>{option.label}</b>
                    <em>{option.description}</em>
                  </span>
                  <small>{option.badge}</small>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DetailScanBuilder({
  filters,
  selected,
  disabled,
  onToggle,
  onClear,
  onClose,
  onScan,
}: {
  filters: DetailFilter[];
  selected: SelectedDetailFilters;
  disabled: boolean;
  onToggle: (filterKey: string, value: string) => void;
  onClear: () => void;
  onClose: () => void;
  onScan: () => void;
}) {
  const activeCount = Object.values(selected).reduce((sum, values) => sum + values.length, 0);

  return (
    <div className="box detail-filter-panel detail-scan-builder">
      <div className="detail-filter-head detail-scan-head">
        <div>
          <strong>상세스캔 조건</strong>
          <span>조건을 선택하면 검색어에 반영해 더 좁은 범위로 수집합니다.</span>
        </div>
        <div className="detail-scan-actions">
          {activeCount > 0 && <button className="btn small" onClick={onClear} disabled={disabled}>조건 초기화</button>}
          <button className="btn small" onClick={onClose} disabled={disabled}>닫기</button>
          <button className="btn small primary" onClick={onScan} disabled={disabled}>조건 적용 스캔</button>
        </div>
      </div>
      {filters.length === 0 ? (
        <p className="hint">검색어를 입력하면 상품군별 상세조건이 표시됩니다.</p>
      ) : (
        <div className="detail-filter-grid">
          {filters.map((filter) => (
            <div className="detail-filter-group" key={filter.key}>
              <strong>{filter.label}</strong>
              <div className="detail-filter-options">
                {filter.options.map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={selected[filter.key]?.includes(option.value) || false}
                      onChange={() => onToggle(filter.key, option.value)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailFilterPanel({
  filters,
  selected,
  totalCount,
  visibleCount,
  onToggle,
  onClear,
}: {
  filters: DetailFilter[];
  selected: SelectedDetailFilters;
  totalCount: number;
  visibleCount: number;
  onToggle: (filterKey: string, value: string) => void;
  onClear: () => void;
}) {
  const activeCount = Object.values(selected).reduce((sum, values) => sum + values.length, 0);

  if (totalCount === 0) {
    return (
      <div className="box detail-filter-panel">
        <div className="detail-filter-head">
          <strong>상세검색 필드</strong>
          <span>검색 후 상품명/가격/배송 정보를 분석해 조건을 자동 생성합니다.</span>
        </div>
      </div>
    );
  }

  if (filters.length === 0) {
    return (
      <div className="box detail-filter-panel">
        <div className="detail-filter-head">
          <strong>상세검색 필드</strong>
          <span>현재 결과에서 공통 상세조건을 찾지 못했습니다.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="box detail-filter-panel">
      <div className="detail-filter-head">
        <strong>상세검색 필드</strong>
        <span>검색 결과 기반 · {visibleCount}/{totalCount}개 표시</span>
        {activeCount > 0 && <button className="btn small" onClick={onClear}>필터 초기화</button>}
      </div>
      <div className="detail-filter-grid">
        {filters.map((filter) => (
          <div className="detail-filter-group" key={filter.key}>
            <strong>{filter.label}</strong>
            <div className="detail-filter-options">
              {filter.options.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={selected[filter.key]?.includes(option.value) || false}
                    onChange={() => onToggle(filter.key, option.value)}
                  />
                  <span>{option.label}</span>
                  {option.count > 0 && <em>{option.count}</em>}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
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
