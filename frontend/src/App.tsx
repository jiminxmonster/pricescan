import { useEffect, useState } from "react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${basePath}/api`;
const TOKEN_KEY = "pricescan_admin_token";
const SETTINGS_KEY = "pricescan_admin_settings";
const SETTINGS_VERSION_KEY = "pricescan_admin_settings_version";
const SETTINGS_VERSION = "publish-slot-v1";

type FeatureKey = "publish" | "pricing" | "invoice" | "tenant";
type Tab = "search" | "api" | "settings" | FeatureKey;

type AdminSettings = {
  showSidebar: boolean;
  features: Record<FeatureKey, boolean>;
};

const defaultSettings: AdminSettings = {
  showSidebar: false,
  features: {
    publish: true,
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
      { key: "smartstore", label: "네이버 스마트스토어", description: "내 스토어 등록상품 조회", enabled: true, badge: "상품정보" },
      { key: "danawa", label: "다나와", description: "검색 페이지 크롤러", enabled: true, badge: "사용 가능" },
      { key: "enuri", label: "에누리", description: "서버 요청 오류로 임시 비활성", enabled: false, badge: "점검 중" },
      { key: "elevenst", label: "11번가", description: "수집기 미구현", enabled: false, badge: "준비 중" },
      { key: "gmarket", label: "G마켓", description: "수집기 미구현", enabled: false, badge: "준비 중" },
      { key: "auction", label: "옥션", description: "수집기 미구현", enabled: false, badge: "준비 중" },
    ],
  },
];

const readySourceKeys = new Set(searchSourceGroups.flatMap((group) => group.options.filter((option) => option.enabled).map((option) => option.key)));
const priceReadySourceKeys = new Set(["naver", "danawa"]);
const apiPlatformOrder = ["naver", "smartstore", "danawa", "enuri", "elevenst", "gmarket", "auction", "google_search", "naver_search", "coupang"];
const serviceUrl = "https://pricescan.d2blue.com/";
const productInfoNoticeTypes = ["기타 재화", "전자제품", "가전제품", "의류", "신발", "가방", "식품", "화장품"];
const deliveryMethods = ["택배/소포/등기", "직접배송", "방문수령", "퀵서비스"];

type NaverApiGuide = {
  title: string;
  summary: string;
  steps: string[];
  checklist: string[];
  links: Array<{ label: string; url: string }>;
};

const naverApiGuides: Record<string, NaverApiGuide> = {
  naver: {
    title: "네이버 쇼핑검색 API 발급 안내",
    summary: "가격비교/상품검색 결과를 가져오는 API입니다. 상품 등록은 할 수 없고 검색 결과 수집에만 사용합니다.",
    steps: [
      "네이버 Developers에서 애플리케이션을 등록합니다.",
      "사용 API에서 검색을 선택하고 쇼핑 검색 사용을 설정합니다.",
      "발급된 Client ID와 Client Secret을 PriceScan 검색설정에 입력합니다.",
      "저장 후 연동 테스트를 눌러 쇼핑 검색 호출 성공 여부를 확인합니다.",
    ],
    checklist: [
      "애플리케이션 이름은 PriceScan처럼 알아보기 쉽게 입력",
      "검색 API 권한 선택",
      "Client ID / Client Secret 복사",
    ],
    links: [
      { label: "네이버 Developers 애플리케이션", url: "https://developers.naver.com/apps/#/register" },
      { label: "쇼핑 검색 API 문서", url: "https://developers.naver.com/docs/serviceapi/search/shopping/shopping.md" },
    ],
  },
  smartstore: {
    title: "네이버 스마트스토어 커머스API 발급 안내",
    summary: "스마트스토어 상품등록/수정/조회에 필요한 판매자 API입니다. 실제 상품 자동등록은 이 키가 있어야 진행됩니다.",
    steps: [
      "네이버 커머스API센터에 접속해 커머스API 사용 권한을 준비합니다.",
      "내 스토어 애플리케이션을 등록하고 사용 API에서 상품 관련 권한을 선택합니다.",
      `WEB 서비스 URL에는 ${serviceUrl} 를 입력합니다.`,
      "애플리케이션 ID와 Secret을 복사해 PriceScan의 네이버 스마트스토어 커머스API 칸에 입력합니다.",
      "저장 후 연결 테스트를 눌러 OAuth 토큰 발급과 상품 조회가 되는지 확인합니다.",
    ],
    checklist: [
      "스마트스토어 주매니저 이상 권한",
      "커머스API센터 가입 및 애플리케이션 등록",
      "상품 API 권한",
      "WEB 서비스 URL 등록",
      "Client ID / Secret 보관",
    ],
    links: [
      { label: "커머스API센터", url: "https://apicenter.commerce.naver.com/" },
      { label: "커머스API 소개", url: "https://apicenter.commerce.naver.com/docs/introduction" },
      { label: "인증 문서", url: "https://apicenter.commerce.naver.com/docs/auth" },
      { label: "상품 등록 API", url: "https://apicenter.commerce.naver.com/docs/commerce-api/current/create-product-product" },
    ],
  },
};

function readSettings(): AdminSettings {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (!saved) return defaultSettings;
    const migrated = localStorage.getItem(SETTINGS_VERSION_KEY) === SETTINGS_VERSION;
    const parsed = JSON.parse(saved) as Partial<AdminSettings>;
    const features = { ...defaultSettings.features, ...(parsed.features || {}) };
    if (!migrated) {
      features.publish = true;
      localStorage.setItem(SETTINGS_VERSION_KEY, SETTINGS_VERSION);
    }
    return {
      showSidebar: Boolean(parsed.showSidebar),
      features,
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

type SmartstoreProduct = {
  id: string;
  origin_product_no: string;
  channel_product_no: string;
  name: string;
  seller_management_code: string;
  status: string;
  sale_price: number;
  discounted_price: number;
  stock_quantity: number;
  delivery_fee: number;
  category_id: string;
  channel_service_type: string;
  url: string;
};

type SmartstorePayload = {
  items: SmartstoreProduct[];
  count: number;
  page: number;
  size: number;
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

type DraftValidation = {
  ready?: boolean;
  missing?: { field: string; label: string }[];
  warnings?: string[];
  checked_at?: string;
};

type DraftImages = {
  representative_url: string;
  optional_urls: string[];
  detail_urls: string[];
};

type ListingDraft = {
  id: string;
  source_item_id: string;
  source: string;
  mall: string;
  source_url: string;
  target_platforms: string[];
  title: string;
  sale_price: number;
  display_price: number;
  shipping_fee: number;
  category_id: string;
  stock_quantity: number;
  image_url: string;
  images: DraftImages;
  option_name: string;
  description: string;
  detail_content_html: string;
  brand_name: string;
  manufacturer_name: string;
  model_name: string;
  origin_area_code: string;
  origin_area_name: string;
  product_info_notice_type: string;
  product_info_notice_content: string;
  delivery_method: string;
  delivery_company_code: string;
  return_delivery_fee: number;
  exchange_delivery_fee: number;
  as_telephone: string;
  as_guide_content: string;
  status: string;
  platform_status: Record<string, string>;
  validation: DraftValidation;
  publish_request: Record<string, unknown>;
  publish_mode: string;
  external_product_no: string;
  external_channel_product_no: string;
  external_url: string;
  last_publish_attempt_at?: string;
  publish_error: string;
  created_at: string;
  updated_at: string;
};

type DraftSourceItem = {
  sourceItemId: string;
  source: string;
  mall: string;
  name: string;
  salePrice: number;
  displayPrice: number;
  shippingFee: number;
  url: string;
};

type DraftForm = {
  targetPlatforms: string[];
  title: string;
  salePrice: number;
  displayPrice: number;
  shippingFee: number;
  categoryId: string;
  stockQuantity: number;
  imageUrl: string;
  optionName: string;
  description: string;
  brandName: string;
  manufacturerName: string;
  modelName: string;
  originAreaCode: string;
  originAreaName: string;
  productInfoNoticeType: string;
  productInfoNoticeContent: string;
  deliveryMethod: string;
  deliveryCompanyCode: string;
  returnDeliveryFee: number;
  exchangeDeliveryFee: number;
  asTelephone: string;
  asGuideContent: string;
};

type ImageUploadResult = {
  id: string;
  filename: string;
  original_filename: string;
  content_type: string;
  size: number;
  url: string;
};

type ImageAsset = ImageUploadResult & {
  source: string;
  purpose: string;
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

function apiAssetUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${window.location.origin}${API_BASE}${normalizedPath}`;
}

function money(value: number): string {
  return `${value.toLocaleString("ko-KR")}원`;
}

function percent(value: number): string {
  if (!Number.isFinite(value)) return "0.0%";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
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
    draft: "초안",
    ready_to_publish: "등록대기",
    validated: "검증완료",
    validation_failed: "필수값 부족",
    publish_ready: "등록준비",
    protected_ready: "보호모드 준비",
    published: "등록완료",
  };
  return labels[status] || status;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    naver: "네이버 쇼핑검색",
    smartstore: "네이버 스마트스토어",
    danawa: "다나와",
    enuri: "에누리",
    elevenst: "11번가",
    gmarket: "G마켓",
    auction: "옥션",
    google_search: "구글 검색",
    naver_search: "네이버 일반검색",
  };
  return labels[source] || source;
}

function apiStatusLabel(status: string): string {
  if (status === "ready") return "설정 필요 없음";
  return statusLabel(status);
}

function apiStatusDetail(item: ApiKey): string {
  if (item.status === "ready") return "크롤러 사용 가능";
  return item.last_tested_at || "테스트 전";
}

function smartstoreStatus(apiKeys: ApiKey[]): string {
  return apiKeys.find((item) => item.platform === "smartstore")?.status || "not_configured";
}

function isSmartstoreActive(apiKeys: ApiKey[]): boolean {
  return ["connected", "configured"].includes(smartstoreStatus(apiKeys));
}

function pillClass(status: string): string {
  if (["baseline", "ready", "connected", "printed", "validated", "publish_ready", "published", "protected_ready"].includes(status)) return "pill green";
  if (["abnormal", "warning", "address_check"].includes(status)) return "pill orange";
  if (["excluded", "not_configured", "validation_failed"].includes(status)) return "pill red";
  return "pill blue";
}

function draftMissingLabels(draft: ListingDraft): string {
  const missing = draft.validation?.missing || [];
  return missing.map((item) => item.label).join(", ");
}

function draftFormValidation(form: DraftForm): DraftValidation {
  const missing: { field: string; label: string }[] = [];
  if (!form.title.trim()) missing.push({ field: "title", label: "상품명" });
  if ((Number(form.salePrice) || 0) <= 0) missing.push({ field: "sale_price", label: "판매가" });
  if ((Number(form.stockQuantity) || 0) <= 0) missing.push({ field: "stock_quantity", label: "재고" });
  if (!form.description.trim()) missing.push({ field: "description", label: "상세설명" });
  if (!form.productInfoNoticeType.trim()) missing.push({ field: "product_info_notice_type", label: "상품정보제공고시 유형" });
  if (!form.productInfoNoticeContent.trim()) missing.push({ field: "product_info_notice_content", label: "상품정보제공고시 내용" });
  if (!form.deliveryMethod.trim()) missing.push({ field: "delivery_method", label: "배송방법" });
  if (!form.asGuideContent.trim()) missing.push({ field: "as_guide_content", label: "A/S 안내" });
  const warnings: string[] = [];
  if (!form.categoryId.trim()) warnings.push("실등록 전 네이버 카테고리 ID 필요");
  if (!form.imageUrl.trim()) warnings.push("실등록 전 대표 이미지 필요");
  if (!form.originAreaName.trim()) warnings.push("실등록 전 원산지 필요");
  if (!form.asTelephone.trim()) warnings.push("실등록 전 A/S 전화번호 필요");
  return { ready: missing.length === 0, missing, warnings };
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
  const [listingDrafts, setListingDrafts] = useState<ListingDraft[]>([]);
  const [imageAssets, setImageAssets] = useState<ImageAsset[]>([]);
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
  const [selectedSources, setSelectedSources] = useState<string[]>(["smartstore", "naver", "danawa"]);
  const [smartstorePayload, setSmartstorePayload] = useState<SmartstorePayload>({ items: [], count: 0, page: 1, size: 50 });
  const [smartstoreLoading, setSmartstoreLoading] = useState(false);
  const [smartstoreError, setSmartstoreError] = useState("");
  const [showSourcePanel, setShowSourcePanel] = useState(false);
  const [draftSourceItem, setDraftSourceItem] = useState<DraftSourceItem | null>(null);
  const [draftImageUploading, setDraftImageUploading] = useState<Record<string, boolean>>({});
  const [draftForm, setDraftForm] = useState<DraftForm>({
    targetPlatforms: ["smartstore"],
    title: "",
    salePrice: 0,
    displayPrice: 0,
    shippingFee: 0,
    categoryId: "",
    stockQuantity: 100,
    imageUrl: "",
    optionName: "",
    description: "",
    brandName: "",
    manufacturerName: "",
    modelName: "",
    originAreaCode: "",
    originAreaName: "상세페이지 참조",
    productInfoNoticeType: "기타 재화",
    productInfoNoticeContent: "상세페이지 참조",
    deliveryMethod: "택배/소포/등기",
    deliveryCompanyCode: "",
    returnDeliveryFee: 3000,
    exchangeDeliveryFee: 6000,
    asTelephone: "판매자 고객센터",
    asGuideContent: "구매처 고객센터로 문의해 주세요.",
  });

  useEffect(() => {
    if (!draftSourceItem) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDraftSourceItem(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [draftSourceItem]);

  const loadAll = async () => {
    if (!token) return;
    const [dashboardData, latestSearch, keyData, orderData, channelData, logData, draftData, imageData] = await Promise.all([
      request<Dashboard>("/dashboard", token),
      request<SearchPayload>("/price-search/latest", token),
      request<ApiKey[]>("/api-keys", token),
      request<Order[]>("/orders", token),
      request<Channel[]>("/channels", token),
      request<LogItem[]>("/logs", token),
      request<ListingDraft[]>("/listing-drafts", token),
      request<ImageAsset[]>("/image-assets", token),
    ]);
    setDashboard(dashboardData);
    setSearchPayload(latestSearch);
    setApiKeys(keyData);
    setOrders(orderData);
    setChannels(channelData);
    setLogs(logData);
    setListingDrafts(draftData);
    setImageAssets(imageData);
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

  const refreshPublishData = async () => {
    const [keyData, channelData, draftData, dashboardData, imageData] = await Promise.all([
      request<ApiKey[]>("/api-keys", token),
      request<Channel[]>("/channels", token),
      request<ListingDraft[]>("/listing-drafts", token),
      request<Dashboard>("/dashboard", token),
      request<ImageAsset[]>("/image-assets", token),
    ]);
    setApiKeys(keyData);
    setChannels(channelData);
    setListingDrafts(draftData);
    setDashboard(dashboardData);
    setImageAssets(imageData);
  };

  const refreshImageAssets = async () => {
    setImageAssets(await request<ImageAsset[]>("/image-assets", token));
  };

  const loadSmartstoreProducts = async (searchKeyword = keyword.trim()) => {
    setSmartstoreLoading(true);
    setSmartstoreError("");
    try {
      const params = new URLSearchParams({
        q: searchKeyword,
        size: "50",
      });
      const data = await request<SmartstorePayload>(`/smartstore/products?${params.toString()}`, token);
      setSmartstorePayload(data);
      return { data, error: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "스마트스토어 상품정보 조회 실패";
      setSmartstoreError(message);
      return { data: null, error: message };
    } finally {
      setSmartstoreLoading(false);
    }
  };

  const runSearch = async (mode: "simple" | "detail" = "simple") => {
    const keywordValue = keyword.trim();
    if (!keywordValue) {
      setNotice("검색어를 입력하세요.");
      return;
    }
    const sources = selectedSources.filter((source) => readySourceKeys.has(source));
    const priceSources = sources.filter((source) => priceReadySourceKeys.has(source));
    const includeSmartstore = sources.includes("smartstore");
    if (priceSources.length === 0 && !includeSmartstore) {
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
    setNotice(mode === "detail" ? "상세조건으로 상품 정보 수집 중..." : "상품 정보 수집 중...");
    try {
      let priceCount = 0;
      let storeCount = 0;
      let storeError = "";
      if (priceSources.length > 0) {
        const data = await request<SearchPayload>("/price-search", token, {
          method: "POST",
          body: JSON.stringify({ query, sort_mode: sortMode, filters: Object.keys(detailSelection), sources: priceSources }),
        });
        priceCount = data.items.length;
        setSearchPayload(data);
      } else {
        setSearchPayload({ run: null, items: [], summary: { collected_count: 0, lowest_count: 0, excluded_count: 0 } });
      }
      if (includeSmartstore) {
        const storeResult = await loadSmartstoreProducts(keywordValue);
        storeCount = storeResult.data?.items.length || 0;
        storeError = storeResult.error;
      }
      if (mode === "detail") setSelectedDetailFilters(detailSelection);
      setDashboard(await request<Dashboard>("/dashboard", token));
      await refreshLogs();
      const parts = [];
      if (priceSources.length > 0) parts.push(`가격비교 ${priceCount}건`);
      if (includeSmartstore) parts.push(`스마트스토어 ${storeCount}건`);
      setNotice(storeError ? `${parts.join(" · ")} · 스마트스토어 오류 확인 필요` : `${mode === "detail" ? "상세스캔" : "스캔"} 완료 · ${parts.join(" · ")}`);
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

  const saveSmartstorePublishKey = async (clientId: string, clientSecret: string) => {
    await request("/api-keys/smartstore", token, {
      method: "PUT",
      body: JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret.trim() }),
    });
    await refreshPublishData();
    setNotice("네이버 스마트스토어 API 저장완료");
    await refreshLogs();
  };

  const testSmartstorePublishKey = async (clientId: string, clientSecret: string) => {
    if (clientId.trim() || clientSecret.trim()) {
      await request("/api-keys/smartstore", token, {
        method: "PUT",
        body: JSON.stringify({ client_id: clientId.trim(), client_secret: clientSecret.trim() }),
      });
    }
    const result = await request<{ status: string; message: string }>("/api-keys/smartstore/test", token, { method: "POST" });
    await refreshPublishData();
    setNotice(result.message);
    await refreshLogs();
  };

  const openPublishDraft = (item: DraftSourceItem) => {
    if (!isSmartstoreActive(apiKeys)) {
      setTab("publish");
      setNotice("네이버 스마트스토어 API 슬롯을 먼저 저장/연결하세요.");
      return;
    }
    setDraftSourceItem(item);
    setDraftForm({
      targetPlatforms: ["smartstore"],
      title: item.name,
      salePrice: item.salePrice,
      displayPrice: item.displayPrice,
      shippingFee: item.shippingFee,
      categoryId: "",
      stockQuantity: 100,
      imageUrl: "",
      optionName: "",
      brandName: "",
      manufacturerName: "",
      modelName: "",
      originAreaCode: "",
      originAreaName: "상세페이지 참조",
      productInfoNoticeType: "기타 재화",
      productInfoNoticeContent: "상세페이지 참조",
      deliveryMethod: "택배/소포/등기",
      deliveryCompanyCode: "",
      returnDeliveryFee: 3000,
      exchangeDeliveryFee: 6000,
      asTelephone: "판매자 고객센터",
      asGuideContent: "구매처 고객센터로 문의해 주세요.",
      description: `${item.name}\n\n원본 소스: ${item.mall}\n기준 판매가: ${money(item.salePrice)}\n노출가: ${money(item.displayPrice)}\n\n상세설명과 이미지는 권리 확인 후 교체하세요.`,
    });
    setNotice("상품등록 초안을 확인하고 초안 승인을 진행하세요.");
  };

  const toggleDraftPlatform = (platform: string) => {
    setDraftForm((current) => {
      const exists = current.targetPlatforms.includes(platform);
      const next = exists ? current.targetPlatforms.filter((item) => item !== platform) : [...current.targetPlatforms, platform];
      return { ...current, targetPlatforms: next.length ? next : current.targetPlatforms };
    });
  };

  const approveDraft = async () => {
    if (!draftSourceItem) {
      setNotice("등록할 상품을 먼저 선택하세요.");
      return;
    }
    const created = await request<ListingDraft>("/listing-drafts", token, {
      method: "POST",
      body: JSON.stringify({
        source_item_id: draftSourceItem.sourceItemId,
        source: draftSourceItem.source,
        mall: draftSourceItem.mall,
        source_url: draftSourceItem.url,
        target_platforms: draftForm.targetPlatforms,
        title: draftForm.title.trim(),
        sale_price: Number(draftForm.salePrice) || 0,
        display_price: Number(draftForm.displayPrice) || 0,
        shipping_fee: Number(draftForm.shippingFee) || 0,
        category_id: draftForm.categoryId.trim(),
        stock_quantity: Number(draftForm.stockQuantity) || 0,
        image_url: draftForm.imageUrl.trim(),
        option_name: draftForm.optionName.trim(),
        description: draftForm.description.trim(),
        brand_name: draftForm.brandName.trim(),
        manufacturer_name: draftForm.manufacturerName.trim(),
        model_name: draftForm.modelName.trim(),
        origin_area_code: draftForm.originAreaCode.trim(),
        origin_area_name: draftForm.originAreaName.trim(),
        product_info_notice_type: draftForm.productInfoNoticeType.trim(),
        product_info_notice_content: draftForm.productInfoNoticeContent.trim(),
        delivery_method: draftForm.deliveryMethod.trim(),
        delivery_company_code: draftForm.deliveryCompanyCode.trim(),
        return_delivery_fee: Number(draftForm.returnDeliveryFee) || 0,
        exchange_delivery_fee: Number(draftForm.exchangeDeliveryFee) || 0,
        as_telephone: draftForm.asTelephone.trim(),
        as_guide_content: draftForm.asGuideContent.trim(),
      }),
    });
    const approved = await request<ListingDraft>(`/listing-drafts/${created.id}/approve`, token, {
      method: "POST",
      body: JSON.stringify({ target_platforms: draftForm.targetPlatforms }),
    });
    setListingDrafts((current) => [approved, ...current.filter((item) => item.id !== approved.id)]);
    setDraftSourceItem(null);
    setNotice("상품등록 초안 승인 완료 · 등록 대시보드에서 검사 후 등록실행을 진행하세요.");
    await refreshPublishData();
    await refreshLogs();
  };

  const updateDraftState = (draft: ListingDraft) => {
    setListingDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)]);
  };

  const validateDraft = async (draftId: string) => {
    const draft = await request<ListingDraft>(`/listing-drafts/${draftId}/validate`, token, { method: "POST" });
    updateDraftState(draft);
    const missing = draftMissingLabels(draft);
    setNotice(draft.validation?.ready ? "등록 필수값 검사 완료" : `필수값 부족: ${missing || "확인 필요"}`);
    await refreshPublishData();
    await refreshLogs();
  };

  const preparePublish = async (draftId: string) => {
    const draft = await request<ListingDraft>(`/listing-drafts/${draftId}/publish`, token, { method: "POST" });
    updateDraftState(draft);
    const missing = draftMissingLabels(draft);
    if (draft.status === "publish_ready") {
      setNotice("등록실행 준비 완료 · 보호모드로 요청값을 저장했습니다.");
    } else {
      setNotice(`등록실행 전 필수값 보완 필요: ${missing || "확인 필요"}`);
    }
    await refreshPublishData();
    await refreshLogs();
  };

  const deleteDraft = async (draftId: string) => {
    if (!window.confirm("이 상품등록 초안을 삭제할까요?")) return;
    await request(`/listing-drafts/${draftId}`, token, { method: "DELETE" });
    setListingDrafts((current) => current.filter((item) => item.id !== draftId));
    setNotice("상품등록 초안 삭제 완료");
    await refreshPublishData();
    await refreshLogs();
  };

  const uploadDraftImage = async (file: File): Promise<string> => {
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch(`${API_BASE}/uploads/product-image`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || "이미지 업로드 실패");
    }
    const result = (await response.json()) as ImageUploadResult;
    const imageUrl = apiAssetUrl(result.url);
    setNotice("대표 이미지 업로드 완료");
    return imageUrl;
  };

  const uploadApprovedDraftImage = async (draftId: string, file: File) => {
    setDraftImageUploading((current) => ({ ...current, [draftId]: true }));
    try {
      const imageUrl = await uploadDraftImage(file);
      const draft = await request<ListingDraft>(`/listing-drafts/${draftId}/image`, token, {
        method: "PUT",
        body: JSON.stringify({ image_url: imageUrl }),
      });
      updateDraftState(draft);
      setNotice("등록 초안 대표 이미지 저장 완료");
      await refreshImageAssets();
      await refreshPublishData();
      await refreshLogs();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "이미지 업로드 실패");
    } finally {
      setDraftImageUploading((current) => ({ ...current, [draftId]: false }));
    }
  };

  const uploadPoolImage = async (file: File) => {
    try {
      await uploadDraftImage(file);
      await refreshImageAssets();
      setNotice("이미지 풀에 이미지 추가 완료");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "이미지 업로드 실패");
    }
  };

  const saveDraftImages = async (draftId: string, images: DraftImages, detailContentHtml = "") => {
    const draft = await request<ListingDraft>(`/listing-drafts/${draftId}/images`, token, {
      method: "PUT",
      body: JSON.stringify({
        representative_url: images.representative_url,
        optional_urls: images.optional_urls,
        detail_urls: images.detail_urls,
        detail_content_html: detailContentHtml,
      }),
    });
    updateDraftState(draft);
    setNotice("네이버 이미지 구조와 상세페이지 초안 저장 완료");
    await refreshPublishData();
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
            {tab === "search" && (
              <div className="source-popover-wrap">
                <button className={`btn small icon-btn ${showSourcePanel ? "active" : ""}`} onClick={() => setShowSourcePanel((current) => !current)}>
                  소스
                </button>
                {showSourcePanel && (
                  <div className="source-popover">
                    <SourceSelector groups={searchSourceGroups} selected={selectedSources} onToggle={toggleSearchSource} />
                  </div>
                )}
              </div>
            )}
            <span className="pill blue">FastAPI 연결됨</span>
            <button className="btn small" onClick={logout}>로그아웃</button>
          </div>
        </header>

        {settings.features.publish && <PublishStatusBar apiKeys={apiKeys} />}

        {notice && <div className="notice">{notice}</div>}

        <section className="grid stats focused-stats compact-stats">
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
            <SearchResultList
              payload={filteredSearchPayload}
              keyword={filterKeyword}
              smartstorePayload={smartstorePayload}
              includeSmartstore={selectedSources.includes("smartstore")}
              smartstoreLoading={smartstoreLoading}
              smartstoreError={smartstoreError}
              onBaseline={selectBaseline}
              onExclude={toggleExclude}
              onOpenPublish={openPublishDraft}
            />
            {draftSourceItem && (
              <div
                className="modal-backdrop"
                role="presentation"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget) setDraftSourceItem(null);
                }}
              >
                <div className="publish-modal" role="dialog" aria-modal="true" aria-label="상품등록 초안">
                  <PublishDraftPanel
                    sourceItem={draftSourceItem}
                    form={draftForm}
                    smartstoreActive={isSmartstoreActive(apiKeys)}
                    onChange={setDraftForm}
                    onTogglePlatform={toggleDraftPlatform}
                    onApprove={approveDraft}
                    onUploadImage={uploadDraftImage}
                    onCancel={() => setDraftSourceItem(null)}
                  />
                </div>
              </div>
            )}
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
                  <span className={pillClass(item.status)}>{apiStatusLabel(item.status)}</span>
                  <p>{apiStatusDetail(item)}</p>
                </button>
              ))}
            </div>
            {naverApiGuides[apiPlatform] && <NaverApiGuideCard guide={naverApiGuides[apiPlatform]} compact={false} />}
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
                <p>API 기반 상품등록 슬롯입니다. 우선 네이버 스마트스토어부터 연결하고, 나머지는 쇼핑몰별로 슬롯을 추가합니다.</p>
              </div>
              <span className={isSmartstoreActive(apiKeys) ? "pill green" : "pill red"}>{isSmartstoreActive(apiKeys) ? "네이버 활성화" : "API 연결 필요"}</span>
            </div>
            <PublishSetup
              apiKeys={apiKeys}
              channels={channels}
              drafts={listingDrafts}
              imageAssets={imageAssets}
              onSaveSmartstore={saveSmartstorePublishKey}
              onTestSmartstore={testSmartstorePublishKey}
              onValidateDraft={validateDraft}
              onPreparePublish={preparePublish}
              onDeleteDraft={deleteDraft}
              onUploadDraftImage={uploadApprovedDraftImage}
              onUploadPoolImage={uploadPoolImage}
              onSaveDraftImages={saveDraftImages}
              draftImageUploading={draftImageUploading}
            />
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
            <SearchResultList
              payload={filteredSearchPayload}
              keyword={filterKeyword}
              smartstorePayload={{ items: [], count: 0, page: 1, size: 0 }}
              includeSmartstore={false}
              smartstoreLoading={false}
              smartstoreError=""
              onBaseline={selectBaseline}
              onExclude={toggleExclude}
              onOpenPublish={openPublishDraft}
            />
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

function PublishStatusBar({ apiKeys }: { apiKeys: ApiKey[] }) {
  const active = isSmartstoreActive(apiKeys);
  return (
    <div className="publish-status-bar" aria-label="쇼핑몰 자동등록 연결 상태">
      <span className={`status-dot ${active ? "on" : ""}`} />
      <strong>네이버스마트({active ? "o" : "-"})</strong>
      <em>{active ? "활성화" : "미연결"}</em>
      <span className="status-empty">+ 쇼핑몰 추가 대기</span>
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

function NaverApiGuideCard({ guide, compact = false }: { guide: NaverApiGuide; compact?: boolean }) {
  return (
    <div className={`naver-guide ${compact ? "compact" : ""}`}>
      <div className="naver-guide-head">
        <div>
          <span className="eyebrow">NAVER API GUIDE</span>
          <strong>{guide.title}</strong>
          <p>{guide.summary}</p>
        </div>
      </div>
      <div className="naver-guide-body">
        <div className="guide-steps">
          {guide.steps.map((step, index) => (
            <div className="guide-step" key={step}>
              <span>{index + 1}</span>
              <p>{step}</p>
            </div>
          ))}
        </div>
        <div className="guide-checklist">
          <strong>확인 항목</strong>
          {guide.checklist.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
      <div className="guide-links">
        {guide.links.map((link) => (
          <a className="btn small" href={link.url} target="_blank" rel="noreferrer" key={link.url}>
            {link.label}
          </a>
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
    return null;
  }

  if (filters.length === 0) {
    return null;
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

function PublishSetup({
  apiKeys,
  channels,
  drafts,
  imageAssets,
  onSaveSmartstore,
  onTestSmartstore,
  onValidateDraft,
  onPreparePublish,
  onDeleteDraft,
  onUploadDraftImage,
  onUploadPoolImage,
  onSaveDraftImages,
  draftImageUploading,
}: {
  apiKeys: ApiKey[];
  channels: Channel[];
  drafts: ListingDraft[];
  imageAssets: ImageAsset[];
  onSaveSmartstore: (clientId: string, clientSecret: string) => void;
  onTestSmartstore: (clientId: string, clientSecret: string) => void;
  onValidateDraft: (draftId: string) => void;
  onPreparePublish: (draftId: string) => void;
  onDeleteDraft: (draftId: string) => void;
  onUploadDraftImage: (draftId: string, file: File) => void;
  onUploadPoolImage: (file: File) => void;
  onSaveDraftImages: (draftId: string, images: DraftImages, detailContentHtml?: string) => void;
  draftImageUploading: Record<string, boolean>;
}) {
  const smartstore = apiKeys.find((item) => item.platform === "smartstore");
  const emptyChannels = channels.length > 1 ? channels.slice(1, 4) : [
    { name: "쇼핑몰 추가 슬롯", status: "pending", description: "다음 쇼핑몰 연결 대기" },
    { name: "쇼핑몰 추가 슬롯", status: "pending", description: "다음 쇼핑몰 연결 대기" },
    { name: "쇼핑몰 추가 슬롯", status: "pending", description: "다음 쇼핑몰 연결 대기" },
  ];
  const [clientId, setClientId] = useState(smartstore?.client_id || "");
  const [clientSecret, setClientSecret] = useState(smartstore?.client_secret || "");
  const [imageManagerDraftId, setImageManagerDraftId] = useState("");

  useEffect(() => {
    setClientId(smartstore?.client_id || "");
    setClientSecret(smartstore?.client_secret || "");
  }, [smartstore?.client_id, smartstore?.client_secret]);

  const draftImages = (draft: ListingDraft): DraftImages => ({
    representative_url: draft.images?.representative_url || draft.image_url || "",
    optional_urls: draft.images?.optional_urls || [],
    detail_urls: draft.images?.detail_urls || [],
  });
  const addUniqueUrl = (urls: string[], url: string, limit: number) => (urls.includes(url) ? urls : [...urls, url].slice(0, limit));
  const removeUrl = (urls: string[], url: string) => urls.filter((item) => item !== url);
  const saveRepresentative = (draft: ListingDraft, url: string) => {
    const current = draftImages(draft);
    onSaveDraftImages(draft.id, { ...current, representative_url: url });
  };
  const addOptionalImage = (draft: ListingDraft, url: string) => {
    const current = draftImages(draft);
    onSaveDraftImages(draft.id, { ...current, optional_urls: addUniqueUrl(current.optional_urls, url, 9) });
  };
  const addDetailImage = (draft: ListingDraft, url: string) => {
    const current = draftImages(draft);
    onSaveDraftImages(draft.id, { ...current, detail_urls: addUniqueUrl(current.detail_urls, url, 30) });
  };
  const removeDraftImage = (draft: ListingDraft, role: "representative" | "optional" | "detail", url: string) => {
    const current = draftImages(draft);
    if (role === "representative") onSaveDraftImages(draft.id, { ...current, representative_url: "" });
    if (role === "optional") onSaveDraftImages(draft.id, { ...current, optional_urls: removeUrl(current.optional_urls, url) });
    if (role === "detail") onSaveDraftImages(draft.id, { ...current, detail_urls: removeUrl(current.detail_urls, url) });
  };

  return (
    <div className="publish-setup">
      <div className="publish-slot primary-slot">
        <div className="publish-slot-head">
          <div>
            <span className="eyebrow">1번 슬롯</span>
            <strong>네이버 스마트스토어</strong>
            <p>커머스API 키를 저장하면 스캔 상품을 네이버 등록 초안으로 보낼 수 있습니다.</p>
          </div>
          <span className={pillClass(smartstore?.status || "not_configured")}>{apiStatusLabel(smartstore?.status || "not_configured")}</span>
        </div>
        <div className="form-grid">
          <input className="input" placeholder="Commerce API Client ID" value={clientId} onChange={(event) => setClientId(event.target.value)} />
          <input className="input" placeholder="Commerce API Client Secret" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} />
          <button className="btn primary" onClick={() => onSaveSmartstore(clientId, clientSecret)}>저장</button>
          <button className="btn orange" onClick={() => onTestSmartstore(clientId, clientSecret)}>저장 후 연결 테스트</button>
        </div>
        <NaverApiGuideCard guide={naverApiGuides.smartstore} compact />
      </div>

      <div className="grid empty-slots">
        {emptyChannels.map((channel, index) => (
          <div className="publish-slot empty-slot" key={`${channel.name}-${index}`}>
            <span className="eyebrow">{index + 2}번 슬롯</span>
            <strong>쇼핑몰 추가</strong>
            <p>{channel.description}</p>
            <button className="btn small" disabled>추가 대기</button>
          </div>
        ))}
      </div>

      <div className="box publish-dashboard">
        <div className="section-head">
          <div>
            <h2>등록 대시보드</h2>
            <p>승인된 상품 초안과 쇼핑몰별 등록 상태를 한눈에 확인합니다.</p>
          </div>
          <span className="pill blue">{drafts.length}건</span>
        </div>
        <div className="draft-list">
          {drafts.map((draft) => {
            const isUploading = Boolean(draftImageUploading[draft.id]);
            const images = draftImages(draft);
            const imageLabel = images.representative_url
              ? `대표 1 · 추가 ${images.optional_urls.length} · 상세 ${images.detail_urls.length}`
              : "대표 이미지 미선택";
            return (
              <div className="draft-group" key={draft.id}>
                <div className="draft-row">
                  <div className="draft-main">
                    <div className="draft-title-line">
                      {images.representative_url ? <img className="draft-thumb" src={images.representative_url} alt="" /> : <span className="draft-thumb empty">IMG</span>}
                      <div>
                        <strong>{draft.title}</strong>
                        <small>{draftMissingLabels(draft) ? `누락: ${draftMissingLabels(draft)}` : imageLabel}</small>
                      </div>
                    </div>
                  </div>
                  <span>{draft.target_platforms.includes("smartstore") ? "네이버 스마트스토어" : draft.target_platforms.join(", ")}</span>
                  <span>{money(draft.display_price || draft.sale_price)}</span>
                  <span className={pillClass(draft.status)}>{statusLabel(draft.status)}</span>
                  <div className="draft-row-actions">
                    <label className={`btn small upload-button ${isUploading ? "disabled" : ""}`}>
                      {isUploading ? "업로드 중" : images.representative_url ? "대표 교체" : "대표 선택"}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        disabled={isUploading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) onUploadDraftImage(draft.id, file);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                    <button
                      className="btn small orange"
                      onClick={() => setImageManagerDraftId(imageManagerDraftId === draft.id ? "" : draft.id)}
                    >
                      이미지 관리
                    </button>
                    <button className="btn small" onClick={() => onValidateDraft(draft.id)}>검사</button>
                    <button className="btn small primary" onClick={() => onPreparePublish(draft.id)} disabled={draft.status === "published"}>
                      등록실행
                    </button>
                    <button className="btn small danger" onClick={() => onDeleteDraft(draft.id)}>삭제</button>
                  </div>
                </div>
                {imageManagerDraftId === draft.id && (
                  <div className="image-manager-panel">
                    <div className="image-manager-head">
                      <div>
                        <strong>네이버 이미지 구조</strong>
                        <span>대표 1장, 추가 최대 9장, 상세페이지 이미지 최대 30장까지 준비합니다.</span>
                      </div>
                      <label className="btn small upload-button">
                        이미지 풀 추가
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) onUploadPoolImage(file);
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                    </div>
                    <div className="image-role-grid">
                      <div className="image-role-card">
                        <strong>대표 이미지</strong>
                        {images.representative_url ? (
                          <div className="selected-image-chip">
                            <img src={images.representative_url} alt="" />
                            <button className="btn small danger" onClick={() => removeDraftImage(draft, "representative", images.representative_url)}>삭제</button>
                          </div>
                        ) : <span className="muted-text">미선택</span>}
                      </div>
                      <div className="image-role-card">
                        <strong>추가 이미지</strong>
                        <div className="selected-image-list">
                          {images.optional_urls.map((url) => (
                            <div className="selected-image-chip" key={url}>
                              <img src={url} alt="" />
                              <button className="btn small danger" onClick={() => removeDraftImage(draft, "optional", url)}>삭제</button>
                            </div>
                          ))}
                          {images.optional_urls.length === 0 && <span className="muted-text">미선택</span>}
                        </div>
                      </div>
                      <div className="image-role-card">
                        <strong>상세페이지 이미지</strong>
                        <div className="selected-image-list">
                          {images.detail_urls.map((url) => (
                            <div className="selected-image-chip" key={url}>
                              <img src={url} alt="" />
                              <button className="btn small danger" onClick={() => removeDraftImage(draft, "detail", url)}>삭제</button>
                            </div>
                          ))}
                          {images.detail_urls.length === 0 && <span className="muted-text">미선택</span>}
                        </div>
                      </div>
                    </div>
                    <div className="image-pool-grid">
                      {imageAssets.map((asset) => {
                        const url = apiAssetUrl(asset.url);
                        return (
                          <div className="image-pool-item" key={asset.id}>
                            <img src={url} alt={asset.original_filename} />
                            <small>{asset.original_filename || asset.filename}</small>
                            <div>
                              <button className="btn small" onClick={() => saveRepresentative(draft, url)}>대표</button>
                              <button className="btn small" onClick={() => addOptionalImage(draft, url)}>추가</button>
                              <button className="btn small" onClick={() => addDetailImage(draft, url)}>상세</button>
                            </div>
                          </div>
                        );
                      })}
                      {imageAssets.length === 0 && <div className="muted-row">아직 이미지 풀이 없습니다. 먼저 이미지를 업로드하세요.</div>}
                    </div>
                    <div className="draft-actions compact">
                      <button className="btn primary" onClick={() => onSaveDraftImages(draft.id, images, "")}>상세페이지 자동생성 저장</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {drafts.length === 0 && <div className="draft-row muted-row">아직 등록 초안이 없습니다.</div>}
        </div>
      </div>
    </div>
  );
}

function PublishDraftPanel({
  sourceItem,
  form,
  smartstoreActive,
  onChange,
  onTogglePlatform,
  onApprove,
  onUploadImage,
  onCancel,
}: {
  sourceItem: DraftSourceItem;
  form: DraftForm;
  smartstoreActive: boolean;
  onChange: (form: DraftForm) => void;
  onTogglePlatform: (platform: string) => void;
  onApprove: () => void;
  onUploadImage: (file: File) => Promise<string>;
  onCancel: () => void;
}) {
  const [imageUploading, setImageUploading] = useState(false);
  const [imageUploadError, setImageUploadError] = useState("");
  const update = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => {
    onChange({ ...form, [key]: value });
  };
  const validation = draftFormValidation(form);
  const missingLabels = validation.missing?.map((item) => item.label) || [];
  const handleImageUpload = async (file: File | undefined) => {
    if (!file) return;
    setImageUploading(true);
    setImageUploadError("");
    try {
      const uploadedUrl = await onUploadImage(file);
      update("imageUrl", uploadedUrl);
    } catch (error) {
      setImageUploadError(error instanceof Error ? error.message : "이미지 업로드 실패");
    } finally {
      setImageUploading(false);
    }
  };

  return (
    <div className="publish-draft-panel">
      <div className="section-head">
        <div>
          <span className="eyebrow">네이버 스마트스토어 등록폼</span>
          <h2>상품등록 초안</h2>
          <p>스캔된 상품 정보를 등록폼에 자동 채움했습니다. 이미지/상세설명 권리 확인 후 승인하세요.</p>
        </div>
        <button className="btn small" onClick={onCancel}>닫기</button>
      </div>

      <div className="source-summary">
        <strong>원본 상품</strong>
        <span>{sourceItem.mall}</span>
        <a href={sourceItem.url} target="_blank" rel="noreferrer">원본 링크</a>
      </div>

      <div className={`preflight-box ${validation.ready ? "ready" : "warning"}`}>
        <strong>{validation.ready ? "등록 필수값 입력 완료" : "실등록 전 보완 필요"}</strong>
        <span>
          {validation.ready
            ? "대시보드에서 등록실행을 누르면 보호모드로 등록 요청값이 생성됩니다."
            : `누락 항목: ${missingLabels.join(", ")}`}
        </span>
      </div>

      <div className="publish-form-grid">
        <label>
          <span>등록 쇼핑몰</span>
          <div className="platform-checks">
            <label className={smartstoreActive ? "" : "disabled"}>
              <input
                type="checkbox"
                checked={form.targetPlatforms.includes("smartstore")}
                disabled={!smartstoreActive}
                onChange={() => onTogglePlatform("smartstore")}
              />
              네이버 스마트스토어
            </label>
          </div>
        </label>
        <label>
          <span>상품명</span>
          <input className="input" value={form.title} onChange={(event) => update("title", event.target.value)} />
        </label>
        <label>
          <span>판매가</span>
          <input className="input" type="number" value={form.salePrice} onChange={(event) => update("salePrice", Number(event.target.value))} />
        </label>
        <label>
          <span>노출가</span>
          <input className="input" type="number" value={form.displayPrice} onChange={(event) => update("displayPrice", Number(event.target.value))} />
        </label>
        <label>
          <span>배송비</span>
          <input className="input" type="number" value={form.shippingFee} onChange={(event) => update("shippingFee", Number(event.target.value))} />
        </label>
        <label>
          <span>재고</span>
          <input className="input" type="number" value={form.stockQuantity} onChange={(event) => update("stockQuantity", Number(event.target.value))} />
        </label>
        <label>
          <span>카테고리 ID</span>
          <input className="input" value={form.categoryId} onChange={(event) => update("categoryId", event.target.value)} placeholder="네이버 카테고리 ID" />
        </label>
        <label>
          <span>옵션명</span>
          <input className="input" value={form.optionName} onChange={(event) => update("optionName", event.target.value)} placeholder="예: 기본옵션" />
        </label>
        <div className="wide form-section-title">
          <strong>네이버 상품 속성</strong>
          <span>카테고리별 필수값은 달라질 수 있어, 우선 공통 등록 필드를 맞춥니다.</span>
        </div>
        <label>
          <span>브랜드</span>
          <input className="input" value={form.brandName} onChange={(event) => update("brandName", event.target.value)} placeholder="예: LG전자" />
        </label>
        <label>
          <span>제조사</span>
          <input className="input" value={form.manufacturerName} onChange={(event) => update("manufacturerName", event.target.value)} placeholder="예: LG전자" />
        </label>
        <label>
          <span>모델명</span>
          <input className="input" value={form.modelName} onChange={(event) => update("modelName", event.target.value)} placeholder="예: 15ZD90RU-GX56K" />
        </label>
        <label>
          <span>원산지</span>
          <input className="input" value={form.originAreaName} onChange={(event) => update("originAreaName", event.target.value)} placeholder="예: 대한민국, 중국" />
        </label>
        <label>
          <span>원산지 코드</span>
          <input className="input" value={form.originAreaCode} onChange={(event) => update("originAreaCode", event.target.value)} placeholder="네이버 원산지 코드 확인 후 입력" />
        </label>
        <label>
          <span>상품정보제공고시 유형</span>
          <select value={form.productInfoNoticeType} onChange={(event) => update("productInfoNoticeType", event.target.value)}>
            {productInfoNoticeTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        <label className="wide">
          <span>상품정보제공고시 내용</span>
          <textarea value={form.productInfoNoticeContent} onChange={(event) => update("productInfoNoticeContent", event.target.value)} placeholder="예: 품명 및 모델명, 인증/허가 사항, 제조국, 제조자, A/S 책임자 등을 입력" />
        </label>
        <div className="wide form-section-title">
          <strong>배송/반품/A/S</strong>
          <span>실등록 전 배송 템플릿 또는 배송정책 매핑이 필요합니다.</span>
        </div>
        <label>
          <span>배송방법</span>
          <select value={form.deliveryMethod} onChange={(event) => update("deliveryMethod", event.target.value)}>
            {deliveryMethods.map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
        </label>
        <label>
          <span>택배사 코드</span>
          <input className="input" value={form.deliveryCompanyCode} onChange={(event) => update("deliveryCompanyCode", event.target.value)} placeholder="예: CJGLS, HANJIN" />
        </label>
        <label>
          <span>반품배송비</span>
          <input className="input" type="number" value={form.returnDeliveryFee} onChange={(event) => update("returnDeliveryFee", Number(event.target.value))} />
        </label>
        <label>
          <span>교환배송비</span>
          <input className="input" type="number" value={form.exchangeDeliveryFee} onChange={(event) => update("exchangeDeliveryFee", Number(event.target.value))} />
        </label>
        <label>
          <span>A/S 전화번호</span>
          <input className="input" value={form.asTelephone} onChange={(event) => update("asTelephone", event.target.value)} placeholder="예: 010-0000-0000" />
        </label>
        <label>
          <span>A/S 안내</span>
          <input className="input" value={form.asGuideContent} onChange={(event) => update("asGuideContent", event.target.value)} placeholder="예: 구매처 고객센터로 문의" />
        </label>
        <div className="wide form-field">
          <span>대표 이미지 URL</span>
          <div className="image-input-row">
            <input className="input" value={form.imageUrl} onChange={(event) => update("imageUrl", event.target.value)} placeholder="권리 확보된 이미지 URL 또는 업로드 결과 URL" />
            <label className={`btn small upload-button ${imageUploading ? "disabled" : ""}`}>
              {imageUploading ? "업로드 중" : "PC 이미지 업로드"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                disabled={imageUploading}
                onChange={(event) => {
                  handleImageUpload(event.target.files?.[0]);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          {imageUploadError && <small className="error-text">{imageUploadError}</small>}
          {form.imageUrl && (
            <div className="image-preview">
              <img src={form.imageUrl} alt="대표 이미지 미리보기" />
              <span>업로드한 이미지는 등록 초안의 대표 이미지로 사용됩니다.</span>
            </div>
          )}
        </div>
        <label className="wide">
          <span>상세설명</span>
          <textarea value={form.description} onChange={(event) => update("description", event.target.value)} />
        </label>
      </div>

      <div className="draft-actions">
        <button className="btn" onClick={onCancel}>취소</button>
        <button className="btn primary" onClick={onApprove} disabled={!smartstoreActive || !form.title.trim()}>
          초안 승인
        </button>
      </div>
    </div>
  );
}

type SearchResultRow = {
  id: string;
  sourceItemId: string;
  collectionSource: string;
  name: string;
  mall: string;
  salePrice: number;
  displayPrice: number;
  shippingFee: number;
  url: string;
  source: "price" | "smartstore";
  status?: PriceItem["status"];
  isExcluded?: number;
};

function SearchResultList({
  payload,
  keyword,
  smartstorePayload,
  includeSmartstore,
  smartstoreLoading,
  smartstoreError,
  onBaseline,
  onExclude,
  onOpenPublish,
}: {
  payload: SearchPayload;
  keyword: string;
  smartstorePayload: SmartstorePayload;
  includeSmartstore: boolean;
  smartstoreLoading: boolean;
  smartstoreError: string;
  onBaseline: (id: string) => void;
  onExclude: (id: string) => void;
  onOpenPublish: (item: DraftSourceItem) => void;
}) {
  const priceRows: SearchResultRow[] = payload.items.map((item) => ({
    id: item.id,
    sourceItemId: item.id,
    collectionSource: item.source,
    name: item.name,
    mall: item.mall,
    salePrice: item.price,
    displayPrice: item.total,
    shippingFee: item.shipping,
    url: item.url,
    source: "price",
    status: item.status,
    isExcluded: item.is_excluded,
  }));
  const storeRows: SearchResultRow[] = includeSmartstore
    ? smartstorePayload.items.map((item) => {
        const exposedPrice = (item.discounted_price || item.sale_price) + item.delivery_fee;
        return {
          id: `smartstore-${item.channel_product_no || item.id}`,
          sourceItemId: item.channel_product_no || item.id,
          collectionSource: "smartstore",
          name: item.name,
          mall: "네이버 스마트스토어",
          salePrice: item.sale_price,
          displayPrice: exposedPrice,
          shippingFee: item.delivery_fee,
          url: item.url,
          source: "smartstore" as const,
        };
      })
    : [];
  const rows = [...priceRows, ...storeRows];
  const positivePrices = rows.map((row) => row.displayPrice).filter((value) => value > 0);
  const fallbackBaseline = positivePrices.length ? Math.min(...positivePrices) : 0;
  const baselineTotal = payload.summary.baseline_total || fallbackBaseline;

  return (
    <div className="result-list">
      <div className="result-list-head">
        <strong>({keyword || "검색 상품"} 모델명)</strong>
        <span>{rows.length}개 결과</span>
      </div>
      {smartstoreError && <div className="source-warning"><span>{smartstoreError}</span></div>}
      {smartstoreLoading && <div className="result-row muted-row">스마트스토어 상품정보 조회 중...</div>}
      {rows.map((row) => {
        const margin = row.displayPrice - baselineTotal;
        const compareRate = baselineTotal ? (margin / baselineTotal) * 100 : 0;
        const marginRate = row.displayPrice ? (margin / row.displayPrice) * 100 : 0;
        return (
          <div className={`result-row ${row.status === "baseline" ? "baseline-row" : ""}`} key={row.id}>
            <a className="result-model" href={row.url} target="_blank" rel="noreferrer">{row.name}</a>
            <span className="result-colon">:</span>
            <span className="source-chip">수집소스 {sourceLabel(row.collectionSource)}</span>
            <span>판매처 {row.mall}</span>
            <span>/ 판매가 {money(row.salePrice)}</span>
            <span>/ 노출가 {money(row.displayPrice)}</span>
            <span>/ 비교율 {percent(compareRate)}</span>
            <span>/ 마진율 {percent(marginRate)}</span>
            {row.source === "price" && row.status && <span className={pillClass(row.status)}>{statusLabel(row.status)}</span>}
            {row.source === "price" && (
              <span className="result-actions">
                <button className="btn small" onClick={() => onBaseline(row.id)}>기준</button>
                <button className="btn small danger" onClick={() => onExclude(row.id)}>{row.isExcluded ? "복구" : "제외"}</button>
                <button className="btn small orange" onClick={() => onOpenPublish({
                  sourceItemId: row.sourceItemId,
                  source: row.collectionSource,
                  mall: row.mall,
                  name: row.name,
                  salePrice: row.salePrice,
                  displayPrice: row.displayPrice,
                  shippingFee: row.shippingFee,
                  url: row.url,
                })}>상품등록</button>
              </span>
            )}
            {row.source === "smartstore" && (
              <span className="result-actions">
                <button className="btn small orange" onClick={() => onOpenPublish({
                  sourceItemId: row.sourceItemId,
                  source: row.collectionSource,
                  mall: row.mall,
                  name: row.name,
                  salePrice: row.salePrice,
                  displayPrice: row.displayPrice,
                  shippingFee: row.shippingFee,
                  url: row.url,
                })}>상품등록</button>
              </span>
            )}
          </div>
        );
      })}
      {rows.length === 0 && !smartstoreLoading && <div className="result-row muted-row">검색 결과가 없습니다.</div>}
    </div>
  );
}
