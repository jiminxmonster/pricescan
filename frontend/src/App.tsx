import { useEffect, useRef, useState, type ReactNode } from "react";
import SellerWorkspace from "./SellerWorkspace";
import { checkCollectorConnection, collectorConnectionCopy, launchCollectorBrowser, type BrowserLaunchStatus, type CollectorStatus } from "./collector-connection";
import {
  canReuseCompanionSearch,
  isMonitoringRefreshDue,
  isSourceItemMonitored,
  nextMonitoringRefreshAt,
  shouldApplyInitialSearchPayload,
  shouldRestoreSimpleSearch,
  visibleResultsBySource,
} from "./search-state";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const API_BASE = `${basePath}/api`;
const TOKEN_KEY = "pricescan_admin_token";
const SETTINGS_KEY = "pricescan_admin_settings";
const SETTINGS_VERSION_KEY = "pricescan_admin_settings_version";
const SETTINGS_VERSION = "publish-slot-v1";
const NAVER_SCAN_INTERVAL_KEY = "pricescan_naver_scan_interval_seconds";
const DEFAULT_NAVER_SCAN_INTERVAL_SECONDS = 600;
const MONITORING_REFRESH_HOURS_KEY = "pricescan_monitoring_refresh_hours";
const MONITORING_AUTO_REFRESH_KEY = "pricescan_monitoring_auto_refresh";
const MONITORING_LAST_RUN_AT_KEY = "pricescan_monitoring_last_run_at";
const monitoringRefreshHourOptions = [1, 3, 6, 12, 24];
const LOCAL_ADMIN_TOKEN = "pricescan-admin-token";
const isLocalCollectorChrome = typeof window !== "undefined"
  && ["127.0.0.1", "localhost"].includes(window.location.hostname)
  && (new URLSearchParams(window.location.search).get("collector") === "dev"
    || (new URLSearchParams(window.location.search).get("collector") === "desktop" && Boolean(window.PriceScanDesktop)));

type FeatureKey = "publish" | "pricing" | "invoice" | "tenant";
type Tab = "search" | "monitoring" | "api" | "settings" | FeatureKey;
type MinimalView = "search" | "monitoring";

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
  { key: "search", label: "상품검색", description: "검색/크롤링으로 해당상품 가격 검색" },
  { key: "monitoring", label: "모니터링", description: "예비상품과 판매상품 관리" },
  { key: "api", label: "검색설정", description: "판매자 API와 검색 크롤러 상태 관리" },
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
    title: "검색엔진 크롤링",
    options: [
      { key: "google_search", label: "구글 검색 크롤링", description: "검색결과 파싱 미구현", enabled: false, badge: "준비 중" },
      { key: "naver_search", label: "네이버 일반검색 크롤링", description: "일반검색 파싱 미구현", enabled: false, badge: "준비 중" },
    ],
  },
  {
    title: "쇼핑몰 / 가격비교",
    options: [
      { key: "smartstore", label: "네이버 스마트스토어", description: "판매상품은 모니터링에서 조회", enabled: false, badge: "모니터링" },
      { key: "naver", label: "네이버 쇼핑", description: "Chrome 확장 프로그램 현재 화면 가져오기", enabled: true, badge: "사용자 확인" },
      { key: "danawa", label: "다나와", description: "검색 페이지 크롤러", enabled: true, badge: "사용 가능" },
      { key: "enuri", label: "에누리", description: "검색 페이지 크롤러", enabled: true, badge: "사용 가능" },
      { key: "coupang", label: "쿠팡", description: "사용자 승인형 브라우저 수집", enabled: true, badge: "브라우저" },
      { key: "elevenst", label: "11번가", description: "수집기 미구현", enabled: false, badge: "준비 중" },
      { key: "gmarket", label: "G마켓", description: "수집기 미구현", enabled: false, badge: "준비 중" },
      { key: "auction", label: "옥션", description: "수집기 미구현", enabled: false, badge: "준비 중" },
    ],
  },
];

const readySourceKeys = new Set(searchSourceGroups.flatMap((group) => group.options.filter((option) => option.enabled).map((option) => option.key)));
const priceReadySourceKeys = new Set(["naver", "danawa", "enuri", "coupang"]);
const minimalPriceSources = ["naver", "danawa", "enuri", "coupang"];
const apiPlatformOrder = ["smartstore", "danawa", "enuri", "coupang", "naver", "elevenst", "gmarket", "auction", "google_search", "naver_search"];
const serviceUrl = "https://pricescan.d2blue.com/";
const localHelperBase = import.meta.env.VITE_PRICESCAN_LOCAL_HELPER_URL || "http://127.0.0.1:8401";
const PRICESCAN_CURRENT_PAGE_CAPTURED = "PRICESCAN_CURRENT_PAGE_CAPTURED";
const PRICESCAN_CURRENT_PAGE_CAPTURE_ACK = "PRICESCAN_CURRENT_PAGE_CAPTURE_ACK";
const naverScanIntervalOptions = [
  { value: 600, label: "네이버 간격 10분 (권장)" },
  { value: 1200, label: "네이버 간격 20분" },
  { value: 1800, label: "네이버 간격 30분" },
  { value: 3600, label: "네이버 간격 60분" },
];
const productInfoNoticeTypes = ["기타 재화", "전자제품", "가전제품", "의류", "신발", "가방", "식품", "화장품"];
const deliveryMethods = ["택배/소포/등기", "직접배송", "방문수령", "퀵서비스"];

function naverShoppingSearchUrl(query: string, sortMode: string) {
  const params = new URLSearchParams({ query });
  if (sortMode === "lowest") params.set("sort", "price_asc");
  return `https://search.shopping.naver.com/ns/search?${params.toString()}`;
}

type NaverApiGuide = {
  title: string;
  summary: string;
  steps: string[];
  checklist: string[];
  links: Array<{ label: string; url: string }>;
};

const naverApiGuides: Record<string, NaverApiGuide> = {
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
  run: { id: string; query: string; status: string; created_at: string; sources?: string[] } | null;
  items: PriceItem[];
  warnings?: string[];
  summary: {
    collected_count: number;
    lowest_count: number;
    excluded_count: number;
    baseline_total?: number;
  };
};

type CoupangBrowserCollectorState = {
  open: boolean;
  rawText: string;
  approvalScope: "once" | "session";
  pageUrl: string;
  submitting: boolean;
};

type PriceItem = {
  id: string;
  source: string;
  mall: string;
  name: string;
  price: number;
  registered_price?: number;
  shipping: number;
  total: number;
  url: string;
  margin: number;
  status: "baseline" | "candidate" | "abnormal" | "excluded";
  is_excluded: number;
  exclusion_reason?: string;
  extraction_methods?: string[];
  benefit_status?: "not_checked" | "confirmed" | "conditional" | "none" | "failed";
  coupon_price?: number;
  event_price?: number;
  card_price?: number;
  benefit_price?: number;
  benefit_shipping?: number;
  benefit_summary?: string;
  benefit_condition?: string;
  detail_methods?: string[];
  benefit_checked_at?: string;
  collected_at: string;
};

type SearchExceptions = {
  terms: string[];
  text: string;
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

type SmartstoreCategoryCandidate = {
  id: string;
  name: string;
  path: string;
  is_leaf: boolean;
  score: number;
};

type ComparisonPlatform = "naver" | "danawa" | "enuri" | "coupang";

type ComparisonTarget = {
  id: string;
  prepared_product_id: string;
  platform: ComparisonPlatform;
  platform_label: string;
  comparison_url: string;
  enabled: boolean;
  status: string;
  last_scanned_at?: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
};

type CompetitorSnapshot = {
  id: string;
  target_id: string;
  prepared_product_id: string;
  platform: ComparisonPlatform;
  platform_label: string;
  rank: number;
  mall: string;
  title: string;
  sale_price: number;
  shipping_fee: number;
  total_price: number;
  detail_url: string;
  is_excluded: boolean;
  exclusion_reason: string;
  collected_at: string;
};

type ComparisonHistory = Record<ComparisonPlatform, CompetitorSnapshot[]>;

type PreparedProduct = {
  id: string;
  source_item_id: string;
  source: string;
  mall: string;
  source_url: string;
  title: string;
  sale_price: number;
  display_price: number;
  shipping_fee: number;
  image_url: string;
  product_type: string;
  model_name: string;
  fee_rate: number;
  seller_sale_price: number;
  seller_display_price: number;
  monitoring_enabled: number;
  auto_discount_enabled: number;
  auto_discount_type: "amount" | "percent";
  auto_discount_value: number;
  status: string;
  listing_draft_id: string;
  comparison_targets?: ComparisonTarget[];
  competitors?: CompetitorSnapshot[];
  lowest_competitor_total?: number;
  recommended_display_price?: number;
  recommended_reason?: string;
  break_even_display_price?: number;
  last_competitor_scanned_at?: string | null;
  scan_warnings?: string[];
  scanned_target_count?: number;
  created_at: string;
  updated_at: string;
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

type CollectionQuota = {
  source: string;
  label: string;
  daily_limit: number;
  enabled: boolean;
  used: number;
  remaining: number;
  usage_date: string;
  last_status: string;
  last_requested_at: string | null;
};

type Order = {
  id: string;
  channel: string;
  product: string;
  recipient: string;
  courier: string;
  status: string;
  source_mall: string;
  source_url: string;
  source_price: number;
  source_shipping: number;
  sale_amount: number;
  procurement_status: string;
  source_order_no: string;
  tracking_no: string;
  created_at: string;
  updated_at: string;
};

type MonitoringView = "monitoring_sales" | "procurement" | "shipping" | "settlement";

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
    const body = await response.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { detail?: string };
      detail = parsed.detail || body;
    } catch {
      // Keep non-JSON error responses as-is.
    }
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
    publishing: "네이버 등록 중",
    publish_failed: "등록 실패",
    published: "등록완료",
    prepared: "예비상품",
    drafting: "등록폼 작성중",
    source_unlinked: "원소스 미연결",
    source_check: "가격·재고 확인",
    approval_required: "구매승인 필요",
    purchase_approved: "구매 승인됨",
    ordered: "원소스 구매완료",
    tracking_pending: "송장 대기",
    shipped: "배송중",
    purchase_failed: "구매 실패",
    cancelled: "취소",
    purchase_complete: "구매완료",
    exception: "예외 확인",
    browser_required: "브라우저 수집 필요",
    browser_success: "브라우저 수집 완료",
  };
  return labels[status] || status;
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    naver: "네이버 쇼핑",
    smartstore: "네이버 스마트스토어",
    danawa: "다나와",
    enuri: "에누리",
    coupang: "쿠팡",
    elevenst: "11번가",
    gmarket: "G마켓",
    auction: "옥션",
    google_search: "구글 검색",
    naver_search: "네이버 일반검색",
  };
  return labels[source] || source;
}

function coupangBrowserSearchUrl(query: string, sortMode: string): string {
  const params = new URLSearchParams({
    component: "",
    q: query,
    channel: "user",
    listSize: "40",
    sorter: sortMode === "lowest" ? "salePriceAsc" : "scoreDesc",
  });
  return `https://www.coupang.com/np/search?${params.toString()}`;
}

const comparisonPlatformOptions: { key: ComparisonPlatform; label: string; placeholder: string }[] = [
  { key: "naver", label: "네이버", placeholder: "네이버 가격비교 URL" },
  { key: "danawa", label: "다나와", placeholder: "다나와 가격비교 URL" },
  { key: "enuri", label: "에누리", placeholder: "에누리 가격비교 URL" },
  { key: "coupang", label: "쿠팡", placeholder: "쿠팡 검색/상품 URL" },
];

const comparisonPlatformColors: Record<ComparisonPlatform, string> = {
  naver: "#03c75a",
  danawa: "rgb(62, 193, 190)",
  enuri: "#2563eb",
  coupang: "#ef4444",
};

const comparisonPlatformLabelText = comparisonPlatformOptions.map((platform) => platform.label).join(" · ");

const CHART_POINT_OVERLAP_X_TOLERANCE = 1.5;
const CHART_POINT_OVERLAP_Y_TOLERANCE = 9;
const CHART_POINT_SCALE_GAPS = [0, 8, 14];

function apiStatusLabel(status: string): string {
  if (status === "ready") return "설정 필요 없음";
  return statusLabel(status);
}

function apiStatusDetail(item: ApiKey): string {
  if (item.platform === "coupang") return "사용자 승인형 브라우저 수집";
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
  if (["baseline", "ready", "connected", "printed", "validated", "publish_ready", "published", "protected_ready", "ordered", "shipped", "purchase_complete"].includes(status)) return "pill green";
  if (["abnormal", "warning", "address_check", "source_check", "approval_required", "tracking_pending"].includes(status)) return "pill orange";
  if (["excluded", "not_configured", "validation_failed", "publish_failed", "purchase_failed", "exception", "cancelled"].includes(status)) return "pill red";
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

function sourceItemFromDraft(draft: ListingDraft): DraftSourceItem {
  return {
    sourceItemId: draft.source_item_id,
    source: draft.source,
    mall: draft.mall,
    name: draft.title,
    salePrice: draft.sale_price,
    displayPrice: draft.display_price,
    shippingFee: draft.shipping_fee,
    url: draft.source_url,
  };
}

type InferredProductIdentity = {
  brandName: string;
  manufacturerName: string;
  modelName: string;
};

function inferProductIdentity(title: string): InferredProductIdentity {
  const brandRules: Array<[RegExp, string, string]> = [
    [/삼성전자|삼성|samsung|갤럭시북|galaxy\s*book/i, "삼성전자", "삼성전자"],
    [/lg전자|(^|[^a-z])lg([^a-z]|$)|그램|ultra\s*pc/i, "LG전자", "LG전자"],
    [/apple|애플|맥북|macbook/i, "Apple", "Apple"],
    [/lenovo|레노버|thinkpad|씽크패드|ideapad/i, "Lenovo", "Lenovo"],
    [/asus|에이수스|비보북|vivobook|rog|(^|[^a-z])tuf([^a-z]|$)/i, "ASUS", "ASUS"],
    [/(^|[^a-z])hp([^a-z]|$)|휴렛팩커드/i, "HP", "HP"],
    [/microsoft|마이크로소프트|surface|서피스/i, "Microsoft", "Microsoft"],
    [/dell|델|xps|inspiron/i, "Dell", "Dell"],
    [/acer|에이서|swift|aspire/i, "Acer", "Acer"],
    [/msi|엠에스아이|스텔스|프레스티지/i, "MSI", "MSI"],
    [/한성컴퓨터|한성|tfg/i, "한성컴퓨터", "한성컴퓨터"],
    [/gigabyte|기가바이트|aorus/i, "GIGABYTE", "GIGABYTE"],
  ];
  const brand = brandRules.find(([pattern]) => pattern.test(title));
  const modelCandidates = title.toUpperCase().match(/\b(?=[A-Z0-9-]{5,}\b)(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/g) || [];
  const modelName = modelCandidates.sort((a, b) => b.length - a.length)[0] || "";
  return {
    brandName: brand?.[1] || "",
    manufacturerName: brand?.[2] || "",
    modelName,
  };
}

function inferProductType(title: string): string {
  const rules: Array<[RegExp, string]> = [
    [/노트북|랩탑|맥북|갤럭시북|그램/i, "노트북"],
    [/모니터|디스플레이/i, "모니터"],
    [/스마트\s*tv|텔레비전|\btv\b/i, "TV"],
    [/태블릿|아이패드|갤럭시탭/i, "태블릿"],
    [/스마트폰|휴대폰|아이폰|갤럭시\s*s\d/i, "스마트폰"],
    [/냉장고/i, "냉장고"],
    [/세탁기|건조기/i, "생활가전"],
  ];
  return rules.find(([pattern]) => pattern.test(title))?.[1] || "기타";
}

function productOnlyDescription(title: string, identity: InferredProductIdentity): string {
  const details = [
    identity.brandName ? `브랜드: ${identity.brandName}` : "",
    identity.manufacturerName ? `제조사: ${identity.manufacturerName}` : "",
    identity.modelName ? `모델명: ${identity.modelName}` : "",
  ].filter(Boolean);
  return [title.trim(), ...details].filter(Boolean).join("\n\n");
}

function sanitizeDraftDescription(description: string, title: string, identity: InferredProductIdentity): string {
  const legacyPattern = /^(원본 소스|기준 판매가|노출가):|^상세설명과 이미지는 권리 확인 후 교체하세요\.$/;
  const containedLegacyText = description.split("\n").some((line) => legacyPattern.test(line.trim()));
  const cleaned = description
    .split("\n")
    .filter((line) => !legacyPattern.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned || containedLegacyText) return productOnlyDescription(title, identity);
  return cleaned;
}

function formFromDraft(draft: ListingDraft): DraftForm {
  const identity = inferProductIdentity(draft.title);
  return {
    targetPlatforms: draft.target_platforms.length ? draft.target_platforms : ["smartstore"],
    title: draft.title,
    salePrice: draft.sale_price,
    displayPrice: draft.display_price,
    shippingFee: draft.shipping_fee,
    categoryId: draft.category_id,
    stockQuantity: draft.stock_quantity,
    imageUrl: draft.images?.representative_url || draft.image_url || "",
    optionName: draft.option_name,
    description: sanitizeDraftDescription(draft.description, draft.title, identity),
    brandName: draft.brand_name || identity.brandName,
    manufacturerName: draft.manufacturer_name || identity.manufacturerName,
    modelName: draft.model_name || identity.modelName,
    originAreaCode: draft.origin_area_code,
    originAreaName: draft.origin_area_name,
    productInfoNoticeType: draft.product_info_notice_type || "기타 재화",
    productInfoNoticeContent: draft.product_info_notice_content || "상세페이지 참조",
    deliveryMethod: draft.delivery_method || "택배/소포/등기",
    deliveryCompanyCode: draft.delivery_company_code,
    returnDeliveryFee: draft.return_delivery_fee,
    exchangeDeliveryFee: draft.exchange_delivery_fee,
    asTelephone: draft.as_telephone,
    asGuideContent: draft.as_guide_content,
  };
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
    <main className="login-page minimal-login-page">
      <header className="minimal-login-topbar">
        <button type="button" disabled>전용브라우저</button>
        <button type="button" aria-current="page">로그인</button>
        <button type="button" disabled>관리자설정</button>
      </header>
      <form className="login-card" onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}>
        <input className="input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="아이디" />
        <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="비밀번호" />
        {error && <p className="error-text">{error}</p>}
        <button className="btn primary" type="submit">로그인</button>
      </form>
    </main>
  );
}

export default function App() {
  const [token, setToken] = useState(() => {
    const savedToken = localStorage.getItem(TOKEN_KEY) || "";
    if (savedToken) return savedToken;
    if (isLocalCollectorChrome) {
      localStorage.setItem(TOKEN_KEY, LOCAL_ADMIN_TOKEN);
      return LOCAL_ADMIN_TOKEN;
    }
    return "";
  });
  const [tab, setTab] = useState<Tab>("search");
  const [settings, setSettings] = useState<AdminSettings>(readSettings);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [searchPayload, setSearchPayload] = useState<SearchPayload>({ run: null, items: [], summary: { collected_count: 0, lowest_count: 0, excluded_count: 0 } });
  const importingCaptureIds = useRef(new Set<string>());
  const currentPageImportRevision = useRef(0);
  const companionSearchInFlight = useRef<{ query: string; promise: Promise<SearchPayload> } | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [collectionQuotas, setCollectionQuotas] = useState<CollectionQuota[]>([]);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, { dailyLimit: number; enabled: boolean }>>({});
  const [orders, setOrders] = useState<Order[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [listingDrafts, setListingDrafts] = useState<ListingDraft[]>([]);
  const [imageAssets, setImageAssets] = useState<ImageAsset[]>([]);
  const [preparedProducts, setPreparedProducts] = useState<PreparedProduct[]>([]);
  const [comparisonScanningId, setComparisonScanningId] = useState("");
  const [monitoringRefreshing, setMonitoringRefreshing] = useState(false);
  const [monitoringClock, setMonitoringClock] = useState(() => Date.now());
  const [monitoringRefreshHours, setMonitoringRefreshHours] = useState(() => {
    const saved = Number(localStorage.getItem(MONITORING_REFRESH_HOURS_KEY));
    return monitoringRefreshHourOptions.includes(saved) ? saved : 6;
  });
  const [monitoringAutoRefresh, setMonitoringAutoRefresh] = useState(
    () => localStorage.getItem(MONITORING_AUTO_REFRESH_KEY) === "true",
  );
  const [monitoringLastRunAt, setMonitoringLastRunAt] = useState(() => {
    const saved = Number(localStorage.getItem(MONITORING_LAST_RUN_AT_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 0;
  });
  const [minimalView, setMinimalView] = useState<MinimalView>("search");
  const [minimalMonitoringSavingId, setMinimalMonitoringSavingId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [sortMode, setSortMode] = useState("lowest");
  const [naverScanIntervalSeconds, setNaverScanIntervalSeconds] = useState(() => {
    const saved = Number(localStorage.getItem(NAVER_SCAN_INTERVAL_KEY));
    return naverScanIntervalOptions.some((option) => option.value === saved)
      ? saved
      : DEFAULT_NAVER_SCAN_INTERVAL_SECONDS;
  });
  const [collecting, setCollecting] = useState(false);
  const [simpleSearchAttempted, setSimpleSearchAttempted] = useState(false);
  const [simpleSearchComplete, setSimpleSearchComplete] = useState(false);
  const [benefitScanning, setBenefitScanning] = useState(false);
  const [selectedBenefitIds, setSelectedBenefitIds] = useState<string[]>([]);
  const [apiPlatform, setApiPlatform] = useState("smartstore");
  const [apiClientId, setApiClientId] = useState("");
  const [apiClientSecret, setApiClientSecret] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
  const [selectedDetailFilters, setSelectedDetailFilters] = useState<SelectedDetailFilters>({});
  const [showDetailScan, setShowDetailScan] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>(minimalPriceSources);
  const [coupangCollector, setCoupangCollector] = useState<CoupangBrowserCollectorState>({
    open: false,
    rawText: "",
    approvalScope: "once",
    pageUrl: "",
    submitting: false,
  });
  const [smartstorePayload, setSmartstorePayload] = useState<SmartstorePayload>({ items: [], count: 0, page: 1, size: 50 });
  const [smartstoreLoading, setSmartstoreLoading] = useState(false);
  const [smartstoreError, setSmartstoreError] = useState("");
  const [comparisonHistories, setComparisonHistories] = useState<Record<string, ComparisonHistory>>({});
  const [showSourcePanel, setShowSourcePanel] = useState(false);
  const [searchResultView, setSearchResultView] = useState<"line" | "active" | "excluded">("line");
  const [showSearchExceptions, setShowSearchExceptions] = useState(false);
  const [extensionStatus, setExtensionStatus] = useState<CollectorStatus>("unknown");
  const [showCollectorConnection, setShowCollectorConnection] = useState(false);
  const [browserLaunchStatus, setBrowserLaunchStatus] = useState<BrowserLaunchStatus>("idle");
  const [searchExceptionTerms, setSearchExceptionTerms] = useState<string[]>([]);
  const [searchExceptionDraft, setSearchExceptionDraft] = useState("");
  const [draftSourceItem, setDraftSourceItem] = useState<DraftSourceItem | null>(null);
  const [sellCandidate, setSellCandidate] = useState<PreparedProduct | null>(null);
  const [editingDraft, setEditingDraft] = useState<ListingDraft | null>(null);
  const [editingDraftForm, setEditingDraftForm] = useState<DraftForm | null>(null);
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

  const checkPriceScanExtension = async (): Promise<boolean> => {
    setExtensionStatus("checking");
    try {
      const result = await checkCollectorConnection(window, isLocalCollectorChrome ? 8000 : 3000);
      setExtensionStatus(result.installed ? "installed" : "missing");
      return result.installed;
    } catch {
      setExtensionStatus("missing");
      return false;
    }
  };

  const showBrowserConnection = () => {
    setBrowserLaunchStatus("idle");
    setShowCollectorConnection(true);
    void checkPriceScanExtension();
  };

  const openDedicatedBrowser = async () => {
    if (browserLaunchStatus === "opening") return;
    setBrowserLaunchStatus("opening");
    try {
      await launchCollectorBrowser(localHelperBase, window.location.hostname);
      setBrowserLaunchStatus("opened");
    } catch {
      setBrowserLaunchStatus("failed");
    }
  };

  useEffect(() => {
    let disposed = false;
    const startupNotice = "내장 수집기에 자동 연결 중입니다…";
    if (isLocalCollectorChrome) setNotice(startupNotice);
    const check = () => {
      void checkPriceScanExtension().then((installed) => {
        if (disposed || !isLocalCollectorChrome) return;
        setNotice((current) => current === startupNotice ? "" : current);
        setShowCollectorConnection(!installed);
      });
    };
    check();
    // Returning from a shopping tab can also follow a collector update/reconnect.
    const onFocus = () => { if (isLocalCollectorChrome) check(); };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    const receiveCurrentPageCapture = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const message = event.data as {
        type?: string;
        capture?: {
          id?: string;
          query?: string;
          sortMode?: string;
          pageUrl?: string;
          warnings?: string[];
          items?: Array<Record<string, unknown>>;
        };
      } | null;
      if (message?.type !== PRICESCAN_CURRENT_PAGE_CAPTURED || !message.capture?.id) return;
      const capture = message.capture;
      if (importingCaptureIds.current.has(capture.id)) return;
      importingCaptureIds.current.add(capture.id);
      const captureQuery = String(capture.query || keyword || "네이버 쇼핑").trim();
      setCollecting(true);
      const importCurrentPage = async () => {
        let comparisonBase = searchPayload;
        let companionSearchError = "";
        const inFlight = companionSearchInFlight.current;
        if (inFlight && inFlight.query.trim() === captureQuery.trim()) {
          setNotice(`네이버 ${capture.items?.length || 0}건을 보관했습니다. 다나와 · 에누리 · 쿠팡 자동 수집과 합치는 중...`);
          try {
            comparisonBase = await inFlight.promise;
          } catch (error) {
            companionSearchError = error instanceof Error ? error.message : "다른 쇼핑몰 자동 수집 실패";
          }
        }
        if (!canReuseCompanionSearch(comparisonBase, captureQuery) && !companionSearchError) {
          const latest = await request<SearchPayload>("/price-search/latest", token).catch(() => null);
          if (latest && canReuseCompanionSearch(latest, captureQuery)) comparisonBase = latest;
        }
        if (!canReuseCompanionSearch(comparisonBase, captureQuery) && !companionSearchError) {
          setNotice(`네이버 ${capture.items?.length || 0}건을 보관했습니다. 다나와 · 에누리 · 쿠팡을 이어서 조사 중...`);
          comparisonBase = await request<SearchPayload>("/price-search", token, {
            method: "POST",
            body: JSON.stringify({
              query: captureQuery,
              sort_mode: capture.sortMode || "lowest",
              filters: [],
              sources: ["danawa", "enuri", "coupang"],
            }),
          });
          setSearchPayload(comparisonBase);
        }
        setNotice(`다른 쇼핑몰 조사 결과에 네이버 현재 화면 ${capture.items?.length || 0}건을 합치는 중...`);
        const data = await request<SearchPayload>("/price-search/extension-results", token, {
          method: "POST",
          body: JSON.stringify({
            query: captureQuery,
            sort_mode: capture.sortMode || "lowest",
            approval_scope: "user_current_page",
            merge_run_id: comparisonBase.run?.id || "",
            page_urls: { naver: capture.pageUrl || "" },
            warnings: [...(comparisonBase.warnings || []), ...(capture.warnings || []), ...(companionSearchError ? [`자동 수집: ${companionSearchError}`] : [])],
            items: capture.items || [],
          }),
        });
        currentPageImportRevision.current += 1;
        setKeyword(captureQuery);
        setSearchPayload(data);
        setSimpleSearchAttempted(true);
        setSimpleSearchComplete(true);
        setSearchResultView("line");
        setTab("search");
        const sourceCounts = ["naver", "danawa", "enuri", "coupang"]
          .map((source) => `${sourceLabel(source)} ${data.items.filter((item) => item.source === source).length}건`)
          .join(" · ");
        setNotice(`통합 가격조사 완료 · ${sourceCounts}`);
        window.dispatchEvent(new CustomEvent("pricescan:current-page-imported", { detail: { runId: data.run?.id || "" } }));
        window.postMessage({ type: PRICESCAN_CURRENT_PAGE_CAPTURE_ACK, captureId: capture.id }, window.location.origin);
        await request<Dashboard>("/dashboard", token).then(setDashboard).catch(() => undefined);
        await refreshLogs().catch(() => undefined);
      };
      void importCurrentPage().catch((error) => {
        importingCaptureIds.current.delete(capture.id!);
        setNotice(error instanceof Error ? error.message : "네이버 현재 화면 반영 실패");
      }).finally(() => setCollecting(false));
    };
    window.addEventListener("message", receiveCurrentPageCapture);
    return () => window.removeEventListener("message", receiveCurrentPageCapture);
  }, [token, keyword, searchPayload]);

  useEffect(() => {
    if (!draftSourceItem && !editingDraft && !sellCandidate && !coupangCollector.open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDraftSourceItem(null);
        setSellCandidate(null);
        setEditingDraft(null);
        setEditingDraftForm(null);
        setCoupangCollector((current) => ({ ...current, open: false, submitting: false }));
      }
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [draftSourceItem, editingDraft, sellCandidate, coupangCollector.open]);

  const loadAll = async () => {
    if (!token) return;
    const importRevisionAtStart = currentPageImportRevision.current;
    const [dashboardData, latestSearch, keyData, quotaData, orderData, channelData, logData, draftData, imageData, preparedData, exceptionData] = await Promise.all([
      request<Dashboard>("/dashboard", token),
      request<SearchPayload>("/price-search/latest", token),
      request<ApiKey[]>("/api-keys", token),
      request<CollectionQuota[]>("/collection-quotas", token),
      request<Order[]>("/orders", token),
      request<Channel[]>("/channels", token),
      request<LogItem[]>("/logs", token),
      request<ListingDraft[]>("/listing-drafts", token),
      request<ImageAsset[]>("/image-assets", token),
      request<PreparedProduct[]>("/prepared-products", token),
      request<SearchExceptions>("/search-exceptions", token),
    ]);
    const restoreSimpleSearch = shouldRestoreSimpleSearch(latestSearch);
    setDashboard(dashboardData);
    if (shouldApplyInitialSearchPayload(importRevisionAtStart, currentPageImportRevision.current)) {
      setSearchPayload(latestSearch);
      setSimpleSearchAttempted(restoreSimpleSearch);
      setSimpleSearchComplete(restoreSimpleSearch);
    }
    setApiKeys(keyData);
    setCollectionQuotas(quotaData);
    setQuotaDrafts(Object.fromEntries(quotaData.map((quota) => [quota.source, { dailyLimit: quota.daily_limit, enabled: quota.enabled }])));
    setOrders(orderData);
    setChannels(channelData);
    setLogs(logData);
    setListingDrafts(draftData);
    setImageAssets(imageData);
    setPreparedProducts(preparedData);
    setSearchExceptionTerms(exceptionData.terms);
    setSearchExceptionDraft(exceptionData.text);
    const visibleKeyData = keyData.filter((item) => !["naver", "naver_datalab"].includes(item.platform));
    const selected = visibleKeyData.find((item) => item.platform === apiPlatform) || visibleKeyData.find((item) => item.platform === "smartstore") || visibleKeyData[0];
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

  const refreshCollectionQuotas = async () => {
    const data = await request<CollectionQuota[]>("/collection-quotas", token);
    setCollectionQuotas(data);
    setQuotaDrafts(Object.fromEntries(data.map((quota) => [quota.source, { dailyLimit: quota.daily_limit, enabled: quota.enabled }])));
  };

  const saveCollectionQuota = async (source: string) => {
    const draft = quotaDrafts[source];
    if (!draft || !Number.isFinite(draft.dailyLimit) || draft.dailyLimit < 1) {
      setNotice("일일 요청 한도는 1건 이상이어야 합니다.");
      return;
    }
    await request<CollectionQuota>(`/collection-quotas/${source}`, token, {
      method: "PUT",
      body: JSON.stringify({ daily_limit: Math.floor(draft.dailyLimit), enabled: draft.enabled }),
    });
    await refreshCollectionQuotas();
    setNotice("일일 수집 한도를 저장했습니다.");
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

  const comparisonHistoryPlatforms = comparisonPlatformOptions.map((platform) => platform.key).join(",");
  const refreshComparisonHistories = async (preparedItems: PreparedProduct[]) => {
    const activePrepared = preparedItems.filter((item) => item.monitoring_enabled);
    const histories = activePrepared.map(async (item): Promise<[string, ComparisonHistory]> => {
      try {
        const history = await request<ComparisonHistory>(
          `/prepared-products/${item.id}/comparison-history?platforms=${encodeURIComponent(comparisonHistoryPlatforms)}&limit=24`,
          token,
        );
        return [item.id, history];
      } catch {
        return [item.id, { naver: [], danawa: [], enuri: [], coupang: [] }];
      }
    });
    const result = Object.fromEntries(await Promise.all(histories));
    setComparisonHistories(result);
  };

  const refreshComparisonHistory = async (preparedId: string) => {
    try {
      const history = await request<ComparisonHistory>(
        `/prepared-products/${preparedId}/comparison-history?platforms=${encodeURIComponent(comparisonHistoryPlatforms)}&limit=24`,
        token,
      );
      setComparisonHistories((current) => ({ ...current, [preparedId]: history }));
    } catch {
      setComparisonHistories((current) => ({ ...current, [preparedId]: { naver: [], danawa: [], enuri: [], coupang: [] } }));
    }
  };

  const refreshMonitoring = async () => {
    const preparedData = await request<PreparedProduct[]>("/prepared-products", token);
    setPreparedProducts(preparedData);
    await refreshComparisonHistories(preparedData);
    if (isSmartstoreActive(apiKeys)) await loadSmartstoreProducts("");
  };

  useEffect(() => {
    if (!token || tab !== "monitoring") return;
    refreshMonitoring().catch((error) => setNotice(error instanceof Error ? error.message : "모니터링 조회 실패"));
  }, [tab, token]);

  const runSearch = async (mode: "simple" | "detail" = "simple") => {
    const keywordValue = keyword.trim();
    if (!keywordValue) {
      setNotice("검색어를 입력하세요.");
      return;
    }
    const sources = selectedSources.filter((source) => readySourceKeys.has(source));
    const priceSources = sources.filter((source) => priceReadySourceKeys.has(source));
    if (priceSources.length === 0) {
      setNotice("사용 가능한 검색 소스를 최소 1개 선택하세요.");
      return;
    }
    const templateFilters = templateDetailFilters(keywordValue);
    const detailSelection = mode === "detail" ? sanitizeSelectedFilters(selectedDetailFilters, templateFilters) : {};
    const query = mode === "detail" ? buildDetailSearchQuery(keywordValue, detailSelection) : keywordValue;
    setCollecting(true);
    setSelectedBenefitIds([]);
    if (mode === "simple") {
      setSelectedDetailFilters({});
      setShowDetailScan(false);
    }
    setNotice(mode === "detail" ? "상세조건으로 상품 정보 수집 중..." : "상품 정보 수집 중...");
    try {
      let priceCount = 0;
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
      if (mode === "detail") setSelectedDetailFilters(detailSelection);
      setDashboard(await request<Dashboard>("/dashboard", token));
      await refreshLogs();
      const parts = [];
      if (priceSources.length > 0) parts.push(`가격비교 ${priceCount}건`);
      setNotice(`${mode === "detail" ? "상세스캔" : "스캔"} 완료 · ${parts.join(" · ")}`);
      setTab("search");
    } finally {
      setCollecting(false);
      await refreshCollectionQuotas().catch(() => undefined);
    }
  };

  const startProductScan = async (mode: "simple" | "detail" = "simple", requestedQuery?: string) => {
    const keywordValue = (requestedQuery ?? keyword).trim();
    if (!keywordValue) {
      setNotice("검색어를 입력하세요.");
      return;
    }
    const sources = selectedSources.filter((source) => readySourceKeys.has(source));
    const priceSources = sources.filter((source) => priceReadySourceKeys.has(source));
    if (!priceSources.length) {
      setNotice("사용 가능한 검색 소스를 최소 1개 선택하세요.");
      return;
    }

    const templateFilters = templateDetailFilters(keywordValue);
    const detailSelection = mode === "detail" ? sanitizeSelectedFilters(selectedDetailFilters, templateFilters) : {};
    const query = mode === "detail" ? buildDetailSearchQuery(keywordValue, detailSelection) : keywordValue;
    const serverSources = priceSources.filter((source) => source !== "naver");
    const includesNaver = priceSources.includes("naver");

    setKeyword(keywordValue);
    setCollecting(true);
    setSimpleSearchAttempted(true);
    setSimpleSearchComplete(false);
    setSelectedBenefitIds([]);
    if (mode === "simple") {
      setSelectedDetailFilters({});
      setShowDetailScan(false);
    }

    let pendingCompanionSearch: { query: string; promise: Promise<SearchPayload> } | null = null;
    if (serverSources.length) {
      pendingCompanionSearch = {
        query,
        promise: request<SearchPayload>("/price-search", token, {
          method: "POST",
          body: JSON.stringify({ query, sort_mode: sortMode, filters: Object.keys(detailSelection), sources: serverSources }),
        }),
      };
      companionSearchInFlight.current = pendingCompanionSearch;
    }
    if (includesNaver) window.open(naverShoppingSearchUrl(query, sortMode), "_blank", "noopener,noreferrer");
    setNotice(serverSources.length
      ? `${serverSources.map(sourceLabel).join(" · ")} 수집 중...${includesNaver ? " 네이버는 열린 화면에서 확장 프로그램을 눌러 주세요." : ""}`
      : "네이버 검색 화면을 열었습니다. 결과를 확인한 뒤 PriceScan 확장 프로그램을 눌러 주세요.");

    try {
      let data: SearchPayload = { run: null, items: [], summary: { collected_count: 0, lowest_count: 0, excluded_count: 0 } };
      if (pendingCompanionSearch) {
        data = await pendingCompanionSearch.promise;
        setSearchPayload(data);
      } else {
        setSearchPayload(data);
      }
      setSimpleSearchComplete(true);
      setSearchResultView("line");
      if (mode === "detail") setSelectedDetailFilters(detailSelection);
      await request<Dashboard>("/dashboard", token).then(setDashboard).catch(() => undefined);
      await refreshLogs().catch(() => undefined);
      await refreshCollectionQuotas().catch(() => undefined);
      const serverMessage = serverSources.length ? `${data.items.length}건 수집 완료` : "";
      const naverMessage = includesNaver ? "네이버는 결과 화면에서 확장 프로그램의 ‘현재 화면 가져오기’를 누르면 이 결과에 합쳐집니다." : "";
      setNotice([serverMessage, naverMessage].filter(Boolean).join(" · "));
      setTab("search");
      return data;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "가격수집 실패");
    } finally {
      if (pendingCompanionSearch && companionSearchInFlight.current === pendingCompanionSearch) {
        companionSearchInFlight.current = null;
      }
      setCollecting(false);
    }
  };

  const openCoupangBrowserCollector = () => {
    const keywordValue = keyword.trim();
    if (!keywordValue) {
      setNotice("쿠팡 브라우저 수집을 실행할 모델명을 먼저 입력하세요.");
      return;
    }
    const pageUrl = coupangBrowserSearchUrl(keywordValue, sortMode);
    window.open(pageUrl, "_blank", "noopener,noreferrer");
    setCoupangCollector({
      open: true,
      rawText: "",
      approvalScope: "once",
      pageUrl,
      submitting: false,
    });
    setNotice("쿠팡 검색 페이지를 열었습니다. 화면에서 확인한 TOP 10 결과를 붙여넣고 저장하세요.");
  };

  const runCoupangAutoCollection = async () => {
    const keywordValue = keyword.trim();
    if (!keywordValue) {
      setNotice("쿠팡 자동수집을 실행할 모델명을 먼저 입력하세요.");
      return;
    }
    setCollecting(true);
    setNotice("쿠팡 자동수집 브라우저를 여는 중입니다. 보안확인이 뜨면 열린 브라우저에서 한 번만 승인하세요.");
    try {
      const data = await request<SearchPayload>("/price-search/coupang-auto", token, {
        method: "POST",
        body: JSON.stringify({
          query: keywordValue,
          sort_mode: sortMode,
          detail_limit: 10,
          approval_scope: "session",
          approval_wait_seconds: 45,
        }),
      });
      setSearchPayload(data);
      setSearchResultView("line");
      setSelectedBenefitIds([]);
      setTab("search");
      setDashboard(await request<Dashboard>("/dashboard", token));
      await refreshLogs();
      await refreshCollectionQuotas().catch(() => undefined);
      const warningText = data.warnings?.length ? ` · 확인 필요 ${data.warnings.length}건` : "";
      setNotice(`쿠팡 자동수집 완료 · ${data.items.length}건${warningText}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "쿠팡 자동수집 실패");
    } finally {
      setCollecting(false);
    }
  };

  const submitCoupangBrowserResults = async () => {
    const rawText = coupangCollector.rawText.trim();
    if (!rawText) {
      setNotice("쿠팡 상품명/가격 결과를 먼저 붙여넣으세요.");
      return;
    }
    setCoupangCollector((current) => ({ ...current, submitting: true }));
    try {
      const data = await request<SearchPayload>("/price-search/browser-results", token, {
        method: "POST",
        body: JSON.stringify({
          platform: "coupang",
          query: keyword.trim(),
          sort_mode: sortMode,
          page_url: coupangCollector.pageUrl,
          raw_text: rawText,
          approval_scope: coupangCollector.approvalScope,
        }),
      });
      setSearchPayload(data);
      setSearchResultView("line");
      setSelectedBenefitIds([]);
      setDashboard(await request<Dashboard>("/dashboard", token));
      await refreshLogs();
      await refreshCollectionQuotas().catch(() => undefined);
      setCoupangCollector((current) => ({ ...current, open: false, rawText: "", submitting: false }));
      setNotice(`쿠팡 브라우저 수집 저장 완료 · ${data.items.length}건`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "쿠팡 브라우저 수집 저장 실패");
      setCoupangCollector((current) => ({ ...current, submitting: false }));
    }
  };

  const scanBenefits = async (itemIds: string[]) => {
    const uniqueIds = [...new Set(itemIds)].slice(0, 10);
    if (uniqueIds.length === 0) {
      setNotice("혜택을 상세조사할 상품을 선택하세요.");
      return;
    }
    setBenefitScanning(true);
    setNotice(`${uniqueIds.length}개 상품의 쿠폰·행사·카드 정보를 상세조사해 등록가를 보정 중...`);
    try {
      const data = await request<SearchPayload>("/price-search/benefits", token, {
        method: "POST",
        body: JSON.stringify({ item_ids: uniqueIds }),
      });
      setSearchPayload(data);
      setSelectedBenefitIds([]);
      const failedCount = data.items.filter((item) => uniqueIds.includes(item.id) && item.benefit_status === "failed").length;
      setNotice(`혜택 상세조사 완료 · ${uniqueIds.length - failedCount}건 확인 · ${failedCount}건 확인 실패`);
      return data;
    } finally {
      setBenefitScanning(false);
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

  const toggleExclude = async (id: string) => {
    setSearchPayload(await request<SearchPayload>(`/price-items/${id}/exclude`, token, { method: "POST" }));
    await refreshLogs();
  };

  const saveSearchExceptions = async () => {
    const terms = searchExceptionDraft.split(",").map((term) => term.trim()).filter(Boolean);
    const saved = await request<SearchExceptions>("/search-exceptions", token, {
      method: "PUT",
      body: JSON.stringify({ terms }),
    });
    setSearchExceptionTerms(saved.terms);
    setSearchExceptionDraft(saved.text);
    setShowSearchExceptions(false);
    setNotice(`검색 예외어 ${saved.terms.length}개를 저장했습니다. 다음 스캔부터 적용됩니다.`);
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

  const preparedPayload = (item: DraftSourceItem) => ({
    source_item_id: item.sourceItemId,
    source: item.source,
    mall: item.mall,
    source_url: item.url,
    title: item.name,
    sale_price: item.salePrice,
    display_price: item.displayPrice,
    shipping_fee: item.shippingFee,
    image_url: "",
    product_type: inferProductType(item.name),
    model_name: inferProductIdentity(item.name).modelName,
  });

  const prepareProduct = async (item: DraftSourceItem) => {
    const prepared = await request<PreparedProduct>("/prepared-products", token, {
      method: "POST",
      body: JSON.stringify(preparedPayload(item)),
    });
    setPreparedProducts((current) => [prepared, ...current.filter((entry) => entry.id !== prepared.id)]);
    setNotice("모니터링판매에 등록했습니다.");
    await refreshLogs();
    return prepared;
  };

  const deletePreparedProduct = async (preparedId: string) => {
    if (!window.confirm("이 예비상품을 목록에서 삭제할까요?")) return;
    await request(`/prepared-products/${preparedId}`, token, { method: "DELETE" });
    setPreparedProducts((current) => current.filter((item) => item.id !== preparedId));
    setNotice("예비상품 삭제 완료");
    await refreshLogs();
  };

  const updatePreparedMonitoring = async (item: PreparedProduct, updates: Partial<PreparedProduct>) => {
    const payload = {
      monitoring_enabled: Boolean(updates.monitoring_enabled ?? item.monitoring_enabled),
      fee_rate: updates.fee_rate ?? item.fee_rate ?? 0,
      seller_sale_price: updates.seller_sale_price ?? item.seller_sale_price ?? item.sale_price,
      seller_display_price: updates.seller_display_price ?? item.seller_display_price ?? item.display_price,
      auto_discount_enabled: Boolean(updates.auto_discount_enabled ?? item.auto_discount_enabled),
      auto_discount_type: updates.auto_discount_type ?? item.auto_discount_type ?? "amount",
      auto_discount_value: updates.auto_discount_value ?? item.auto_discount_value ?? 0,
      product_type: updates.product_type ?? item.product_type ?? inferProductType(item.title),
      model_name: updates.model_name ?? item.model_name ?? inferProductIdentity(item.title).modelName,
    };
    const saved = await request<PreparedProduct>(`/prepared-products/${item.id}/monitoring`, token, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    setPreparedProducts((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)]);
    setNotice(payload.monitoring_enabled ? "모니터링을 시작했습니다." : "모니터링판매 대기 상태로 변경했습니다.");
  };

  const toggleMinimalMonitoring = async (item: PriceItem) => {
    setMinimalMonitoringSavingId(item.id);
    try {
      const existing = preparedProducts.find((product) => product.source_item_id === item.id);
      const prepared = existing || await prepareProduct({
        sourceItemId: item.id,
        source: item.source,
        mall: item.mall,
        name: item.name,
        salePrice: item.registered_price || item.price,
        displayPrice: item.price,
        shippingFee: item.shipping,
        url: item.url,
      });
      await updatePreparedMonitoring(prepared, {
        monitoring_enabled: prepared.monitoring_enabled ? 0 : 1,
        seller_sale_price: prepared.seller_sale_price || item.registered_price || item.price,
        seller_display_price: prepared.seller_display_price || item.price,
      });
    } finally {
      setMinimalMonitoringSavingId("");
    }
  };

  const saveComparisonTargets = async (item: PreparedProduct, targets: { platform: ComparisonPlatform; comparison_url: string; enabled: boolean }[]) => {
    const saved = await request<PreparedProduct>(`/prepared-products/${item.id}/comparison-targets`, token, {
      method: "PUT",
      body: JSON.stringify({ targets }),
    });
    setPreparedProducts((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
    setNotice("가격비교 URL을 저장했습니다.");
    return saved;
  };

  const scanComparisonTargets = async (item: PreparedProduct) => {
    setComparisonScanningId(item.id);
    try {
      const saved = await request<PreparedProduct>(`/prepared-products/${item.id}/comparison-scan`, token, {
        method: "POST",
        body: JSON.stringify({ platforms: [] }),
      });
      setPreparedProducts((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
      await refreshComparisonHistory(item.id);
      const warnings = saved.scan_warnings || [];
      setNotice(warnings.length ? `경쟁가 스캔 완료 · 확인 필요 ${warnings.length}건` : "경쟁가 스캔 완료");
      await refreshLogs();
      return saved;
    } finally {
      setComparisonScanningId("");
    }
  };

  const refreshMonitoredProducts = async (automatic = false) => {
    if (monitoringRefreshing) return;
    const monitored = preparedProducts.filter((item) => Boolean(item.monitoring_enabled));
    const scannable = monitored.filter((item) => (item.comparison_targets || []).some(
      (target) => target.enabled && Boolean(target.comparison_url),
    ));
    if (scannable.length === 0) {
      setNotice(monitored.length === 0
        ? "모니터링 ON 상품이 없습니다."
        : "재검색할 가격비교 URL이 없습니다. 상품별 비교 URL을 먼저 연결하세요.");
      return;
    }

    const startedAt = Date.now();
    setMonitoringRefreshing(true);
    setMonitoringLastRunAt(startedAt);
    localStorage.setItem(MONITORING_LAST_RUN_AT_KEY, String(startedAt));
    setNotice(`${automatic ? "자동 " : ""}모니터링 상품 재검색 중 · 0/${scannable.length}`);
    let completed = 0;
    let failed = 0;
    try {
      for (const item of scannable) {
        setComparisonScanningId(item.id);
        try {
          const saved = await request<PreparedProduct>(`/prepared-products/${item.id}/comparison-scan`, token, {
            method: "POST",
            body: JSON.stringify({ platforms: [] }),
          });
          setPreparedProducts((current) => current.map((entry) => entry.id === saved.id ? saved : entry));
          await refreshComparisonHistory(item.id);
          completed += 1;
        } catch {
          failed += 1;
        }
        setNotice(`${automatic ? "자동 " : ""}모니터링 상품 재검색 중 · ${completed + failed}/${scannable.length}`);
      }
      setMonitoringClock(Date.now());
      setNotice(`모니터링 상품 갱신 완료 · 성공 ${completed}건${failed ? ` · 실패 ${failed}건` : ""}`);
      await refreshLogs();
    } finally {
      setComparisonScanningId("");
      setMonitoringRefreshing(false);
    }
  };

  const changeMonitoringRefreshHours = (hours: number) => {
    setMonitoringRefreshHours(hours);
    localStorage.setItem(MONITORING_REFRESH_HOURS_KEY, String(hours));
    setMonitoringClock(Date.now());
  };

  const changeMonitoringAutoRefresh = (enabled: boolean) => {
    setMonitoringAutoRefresh(enabled);
    localStorage.setItem(MONITORING_AUTO_REFRESH_KEY, String(enabled));
    setMonitoringClock(Date.now());
    setNotice(enabled ? `${monitoringRefreshHours}시간 자동 갱신을 시작했습니다.` : "자동 갱신을 껐습니다.");
  };

  useEffect(() => {
    if (minimalView !== "monitoring") return;
    const timer = window.setInterval(() => setMonitoringClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [minimalView]);

  const monitoredScanSignature = preparedProducts
    .filter((item) => Boolean(item.monitoring_enabled))
    .map((item) => `${item.id}:${item.last_competitor_scanned_at || ""}:${(item.comparison_targets || []).filter((target) => target.enabled && target.comparison_url).length}`)
    .join("|");

  useEffect(() => {
    if (!monitoringAutoRefresh || minimalView !== "monitoring" || monitoringRefreshing) return;
    const monitored = preparedProducts.filter((item) => Boolean(item.monitoring_enabled));
    const scannable = monitored.filter((item) => (item.comparison_targets || []).some(
      (target) => target.enabled && Boolean(target.comparison_url),
    ));
    if (scannable.length === 0) return;
    const latestProductScan = Math.max(
      0,
      ...scannable.map((item) => Date.parse(item.last_competitor_scanned_at || "") || 0),
    );
    const scheduleAnchor = Math.max(monitoringLastRunAt, latestProductScan);
    if (isMonitoringRefreshDue(monitoringClock, scheduleAnchor, monitoringRefreshHours)) {
      refreshMonitoredProducts(true).catch((error) => setNotice(error instanceof Error ? error.message : "자동 갱신 실패"));
    }
  }, [monitoringAutoRefresh, monitoringClock, monitoringRefreshHours, monitoringLastRunAt, monitoringRefreshing, minimalView, monitoredScanSignature]);

  const preparedToDraftSource = (item: PreparedProduct): DraftSourceItem => ({
    sourceItemId: item.source_item_id,
    source: item.source,
    mall: item.mall,
    name: item.title,
    salePrice: item.sale_price,
    displayPrice: item.display_price,
    shippingFee: item.shipping_fee,
    url: item.source_url,
  });

  const copySmartstoreToPrepared = async (item: SmartstoreProduct) => {
    await prepareProduct({
      sourceItemId: item.channel_product_no || item.id,
      source: "smartstore",
      mall: "네이버 스마트스토어",
      name: item.name,
      salePrice: item.sale_price,
      displayPrice: item.discounted_price || item.sale_price,
      shippingFee: item.delivery_fee,
      url: item.url,
    });
    setNotice("판매상태는 변경하지 않고 예비상품 목록에 복사했습니다.");
  };

  const openPublishDraft = (item: DraftSourceItem) => {
    if (!isSmartstoreActive(apiKeys)) {
      setTab("publish");
      setNotice("네이버 스마트스토어 API 슬롯을 먼저 저장/연결하세요.");
      return;
    }
    const identity = inferProductIdentity(item.name);
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
      brandName: identity.brandName,
      manufacturerName: identity.manufacturerName,
      modelName: identity.modelName,
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
      description: productOnlyDescription(item.name, identity),
    });
    setNotice("상품등록 초안을 확인하고 초안 승인을 진행하세요.");
  };

  const openSellChannelSelector = (item: PreparedProduct) => {
    setSellCandidate(item);
    setNotice("판매할 쇼핑몰을 선택하세요.");
  };

  const continueSmartstoreSale = () => {
    if (!sellCandidate) return;
    if (!isSmartstoreActive(apiKeys)) {
      setSellCandidate(null);
      selectApiPlatform("smartstore");
      setTab("api");
      setNotice("네이버 스마트스토어 셀러 API를 먼저 연결하세요.");
      return;
    }
    const existingDraft = listingDrafts.find((draft) =>
      draft.id === sellCandidate.listing_draft_id
      || (draft.source === sellCandidate.source && draft.source_item_id === sellCandidate.source_item_id)
    );
    setSellCandidate(null);
    if (existingDraft) {
      openDraftEditor(existingDraft);
      setNotice("기존 스마트스토어 등록폼을 열었습니다.");
      return;
    }
    openPublishDraft(preparedToDraftSource(sellCandidate));
  };

  const toggleDraftPlatform = (platform: string) => {
    setDraftForm((current) => {
      const exists = current.targetPlatforms.includes(platform);
      const next = exists ? current.targetPlatforms.filter((item) => item !== platform) : [...current.targetPlatforms, platform];
      return { ...current, targetPlatforms: next.length ? next : current.targetPlatforms };
    });
  };

  const toggleEditingDraftPlatform = (platform: string) => {
    setEditingDraftForm((current) => {
      if (!current) return current;
      const exists = current.targetPlatforms.includes(platform);
      const next = exists ? current.targetPlatforms.filter((item) => item !== platform) : [...current.targetPlatforms, platform];
      return { ...current, targetPlatforms: next.length ? next : current.targetPlatforms };
    });
  };

  const draftPayloadFromForm = (sourceItem: DraftSourceItem, form: DraftForm) => ({
    source_item_id: sourceItem.sourceItemId,
    source: sourceItem.source,
    mall: sourceItem.mall,
    source_url: sourceItem.url,
    target_platforms: form.targetPlatforms,
    title: form.title.trim(),
    sale_price: Number(form.salePrice) || 0,
    display_price: Number(form.displayPrice) || 0,
    shipping_fee: Number(form.shippingFee) || 0,
    category_id: form.categoryId.trim(),
    stock_quantity: Number(form.stockQuantity) || 0,
    image_url: form.imageUrl.trim(),
    option_name: form.optionName.trim(),
    description: form.description.trim(),
    brand_name: form.brandName.trim(),
    manufacturer_name: form.manufacturerName.trim(),
    model_name: form.modelName.trim(),
    origin_area_code: form.originAreaCode.trim(),
    origin_area_name: form.originAreaName.trim(),
    product_info_notice_type: form.productInfoNoticeType.trim(),
    product_info_notice_content: form.productInfoNoticeContent.trim(),
    delivery_method: form.deliveryMethod.trim(),
    delivery_company_code: form.deliveryCompanyCode.trim(),
    return_delivery_fee: Number(form.returnDeliveryFee) || 0,
    exchange_delivery_fee: Number(form.exchangeDeliveryFee) || 0,
    as_telephone: form.asTelephone.trim(),
    as_guide_content: form.asGuideContent.trim(),
  });

  const approveDraft = async () => {
    if (!draftSourceItem) {
      setNotice("등록할 상품을 먼저 선택하세요.");
      return;
    }
    const created = await request<ListingDraft>("/listing-drafts", token, {
      method: "POST",
      body: JSON.stringify(draftPayloadFromForm(draftSourceItem, draftForm)),
    });
    const approved = await request<ListingDraft>(`/listing-drafts/${created.id}/approve`, token, {
      method: "POST",
      body: JSON.stringify({ target_platforms: draftForm.targetPlatforms }),
    });
    setListingDrafts((current) => [approved, ...current.filter((item) => item.id !== approved.id)]);
    setDraftSourceItem(null);
    setNotice("상품등록 초안 승인 완료 · 등록 대시보드에서 검사 후 등록실행을 진행하세요.");
    await refreshPublishData();
    await refreshMonitoring();
    await refreshLogs();
  };

  const updateDraftState = (draft: ListingDraft) => {
    setListingDrafts((current) => [draft, ...current.filter((item) => item.id !== draft.id)]);
  };

  const openDraftEditor = (draft: ListingDraft) => {
    setEditingDraft(draft);
    setEditingDraftForm(formFromDraft(draft));
    setNotice("네이버 상품등록 화면 기준으로 초안을 보완하세요.");
  };

  const closeDraftEditor = () => {
    setEditingDraft(null);
    setEditingDraftForm(null);
  };

  const saveEditingDraft = async (): Promise<ListingDraft | null> => {
    if (!editingDraft || !editingDraftForm) {
      setNotice("수정할 등록 초안이 없습니다.");
      return null;
    }
    const updated = await request<ListingDraft>(`/listing-drafts/${editingDraft.id}`, token, {
      method: "PUT",
      body: JSON.stringify(draftPayloadFromForm(sourceItemFromDraft(editingDraft), editingDraftForm)),
    });
    updateDraftState(updated);
    setEditingDraft(updated);
    setEditingDraftForm(formFromDraft(updated));
    setNotice("상품등록 폼 저장 완료");
    await refreshPublishData();
    await refreshLogs();
    return updated;
  };

  const saveAndValidateEditingDraft = async () => {
    const saved = await saveEditingDraft();
    if (saved) await validateDraft(saved.id);
  };

  const saveAndPrepareEditingDraft = async () => {
    const saved = await saveEditingDraft();
    if (saved) await preparePublish(saved.id);
  };

  const saveAndPublishLiveEditingDraft = async () => {
    const saved = await saveEditingDraft();
    if (saved) await publishLive(saved.id);
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

  const publishLive = async (draftId: string) => {
    const confirmed = window.confirm(
      "네이버 스마트스토어에 판매중·전시중 상태로 실제 상품을 등록합니다. 등록 후에는 스마트스토어센터에서 수정 또는 판매중지해야 합니다. 계속할까요?",
    );
    if (!confirmed) return;
    setNotice("네이버 이미지 업로드 및 실제 상품등록을 진행 중입니다.");
    try {
      const draft = await request<ListingDraft>(`/listing-drafts/${draftId}/publish-live`, token, {
        method: "POST",
        body: JSON.stringify({ confirmation: "NAVER_LIVE_PUBLISH" }),
      });
      updateDraftState(draft);
      setEditingDraft(draft);
      setEditingDraftForm(formFromDraft(draft));
      const productNo = draft.external_channel_product_no || draft.external_product_no;
      setNotice(`네이버 실제 상품등록 완료${productNo ? ` · 상품번호 ${productNo}` : ""}`);
    } catch (error) {
      setNotice(error instanceof Error ? `네이버 실제등록 실패: ${error.message}` : "네이버 실제등록에 실패했습니다.");
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

  const updateProcurement = async (order: Order, procurementStatus: string, source?: PreparedProduct, updates?: Partial<Order>) => {
    const currentOrder = { ...order, ...updates };
    const sourceUrl = source?.source_url || currentOrder.source_url;
    const requiresSource = ["source_check", "approval_required", "purchase_approved", "ordered"].includes(procurementStatus);
    if (requiresSource && !sourceUrl) {
      setNotice("원소스 링크가 연결되지 않았습니다. 주문을 구매승인하기 전에 원소스 상품을 연결하세요.");
      return;
    }
    if (procurementStatus === "purchase_approved" && !window.confirm("현재 원소스 가격과 재고를 확인했고 구매를 승인할까요? 결제는 아직 자동 실행되지 않습니다.")) return;
    const updated = await request<Order>(`/orders/${order.id}/procurement`, token, {
      method: "PUT",
      body: JSON.stringify({
        procurement_status: procurementStatus,
        source_mall: source?.mall || currentOrder.source_mall,
        source_url: sourceUrl,
        source_price: source?.display_price || currentOrder.source_price,
        source_shipping: source?.shipping_fee || currentOrder.source_shipping,
        source_order_no: currentOrder.source_order_no,
        courier: currentOrder.courier,
        tracking_no: currentOrder.tracking_no,
      }),
    });
    setOrders((current) => current.map((item) => item.id === updated.id ? updated : item));
    setNotice(`주문 ${currentOrder.id}: ${statusLabel(procurementStatus)}`);
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
    .filter((item) => !["naver", "naver_datalab"].includes(item.platform))
    .sort((a, b) => {
      const aIndex = apiPlatformOrder.indexOf(a.platform);
      const bIndex = apiPlatformOrder.indexOf(b.platform);
      return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex) || a.label.localeCompare(b.label, "ko");
    });
  const selectedApiKey = visibleApiKeys.find((item) => item.platform === apiPlatform);
  const selectedCrawlerSource = selectedApiKey ? priceReadySourceKeys.has(selectedApiKey.platform) : false;
  const filterKeyword = searchPayload.run?.query || keyword;
  const activeDetailFilters: SelectedDetailFilters = {};
  const filteredSearchPayload = {
    ...searchPayload,
    items: sortedPriceItems(filterPriceItems(searchPayload.items, activeDetailFilters), sortMode),
  };
  const minimalPriceItems = visibleResultsBySource(searchPayload.items, minimalPriceSources, 10);
  const minimalMonitoredProducts = preparedProducts.filter((item) => Boolean(item.monitoring_enabled));
  const collectorCopy = collectorConnectionCopy(extensionStatus, isLocalCollectorChrome, browserLaunchStatus);

  return (
    <div className="app minimal-mode">
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
        <div className="minimal-pricescan-shell seller-workspace-shell">
          <SellerWorkspace
            token={token}
            busy={collecting}
            progress={notice}
            selectedSources={selectedSources}
            onToggleSource={toggleSearchSource}
            onSearch={(query) => startProductScan("simple", query)}
            onDetailScan={scanBenefits}
            onBrowser={showBrowserConnection}
            onSettings={() => setTab((current) => current === "settings" ? "search" : "settings")}
            onLogout={logout}
          />

          {tab === "settings" && (
            <div className="minimal-settings-backdrop" role="presentation" onMouseDown={(event) => {
              if (event.target === event.currentTarget) setTab("search");
            }}>
              <section className="minimal-settings-panel" role="dialog" aria-modal="true" aria-label="관리자설정">
                <div className="minimal-settings-head">
                  <strong>관리자설정</strong>
                  <button type="button" onClick={() => setTab("search")} aria-label="닫기">×</button>
                </div>
                {isLocalCollectorChrome && <label>
                  <span>네이버 사용자 세션 최소 간격</span>
                  <select
                    value={naverScanIntervalSeconds}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setNaverScanIntervalSeconds(nextValue);
                      localStorage.setItem(NAVER_SCAN_INTERVAL_KEY, String(nextValue));
                    }}
                  >
                    {naverScanIntervalOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>}
              </section>
            </div>
          )}
        </div>

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
            <button
              className={`btn small chrome-extension-button ${extensionStatus === "installed" ? "connected" : ""} ${extensionStatus === "missing" ? "missing" : ""}`}
              onClick={showBrowserConnection}
              aria-label="수집기 연결 상태"
              title="PriceScan 내장 수집기"
            >
              <span className="chrome-extension-icon" aria-hidden="true">🧩</span>
              <span className="chrome-extension-label">{extensionStatus === "installed" ? "수집기 연결됨" : "가격수집기"}</span>
            </button>
            {tab === "search" && (
              <div className="source-popover-wrap">
                <button className={`btn small icon-btn ${showSourcePanel ? "active" : ""}`} onClick={() => setShowSourcePanel((current) => !current)}>
                  소스
                </button>
                {showSourcePanel && (
                  <div className="source-popover">
                    <SourceSelector groups={searchSourceGroups} selected={selectedSources} quotas={collectionQuotas} onToggle={toggleSearchSource} />
                  </div>
                )}
              </div>
            )}
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
              <div className="search-input-actions">
                <input className="input" value={keyword} onChange={(event) => setKeyword(event.target.value)} aria-label="상품 검색어" />
                <button className="btn" onClick={() => setShowSearchExceptions(true)}>검색예외</button>
              </div>
              <select value={sortMode} onChange={(event) => changeSortMode(event.target.value)} aria-label="정렬">
                <option value="lowest">최저가순</option>
                <option value="margin">마진높은순</option>
                <option value="recent">최근검색순</option>
              </select>
              {isLocalCollectorChrome && selectedSources.includes("naver") && (
                <select
                  className="naver-speed-select"
                  value={naverScanIntervalSeconds}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    setNaverScanIntervalSeconds(nextValue);
                    localStorage.setItem(NAVER_SCAN_INTERVAL_KEY, String(nextValue));
                  }}
                  aria-label="네이버 검색 간격"
                  title="로그인된 전용 브라우저에서 연속 네이버 주시형 검색 사이의 최소 대기시간"
                  disabled={collecting}
                >
                  {naverScanIntervalOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              )}
              <button className="btn primary" onClick={() => startProductScan("simple")} disabled={collecting}>가격수집 시작</button>
              <button className="btn danger" onClick={stopSearch} disabled={!collecting}>수집 중지</button>
            </div>
            {Boolean(searchPayload.warnings?.length) && (
              <div className="source-warning">
                {searchPayload.warnings?.map((warning) => <span key={warning}>{warning}</span>)}
              </div>
            )}
            <PriceLineOverview
              items={filteredSearchPayload.items}
              onPointClick={(source, itemId) => {
                setSearchResultView("line");
                window.setTimeout(() => {
                  const target = document.getElementById(`line-row-${source}-${itemId}`);
                  target?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
                  target?.classList.add("line-row-highlight");
                  window.setTimeout(() => target?.classList.remove("line-row-highlight"), 1800);
                }, 80);
              }}
            />
            <div className="result-view-tabs" aria-label="상품검색 결과 메뉴">
              <button className={searchResultView === "line" ? "active" : ""} onClick={() => setSearchResultView("line")}>
                최저가 라인모드
              </button>
              <button className={searchResultView === "active" ? "active" : ""} onClick={() => setSearchResultView("active")}>
                검색결과 {searchPayload.items.filter((item) => !item.is_excluded && item.status !== "abnormal").length}
              </button>
              <button className={searchResultView === "excluded" ? "active" : ""} onClick={() => setSearchResultView("excluded")}>
                제외된 항목 {searchPayload.summary.excluded_count}
              </button>
            </div>
            <SearchResultList
              payload={filteredSearchPayload}
              keyword={filterKeyword}
              sortMode={sortMode}
              view={searchResultView}
              preparedProducts={preparedProducts}
              onExclude={toggleExclude}
              onPrepare={prepareProduct}
              selectedBenefitIds={selectedBenefitIds}
              benefitScanning={benefitScanning}
              onBenefitSelectionChange={setSelectedBenefitIds}
              onBenefitScan={scanBenefits}
            />
          </section>
        )}

        {tab === "monitoring" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>상품 모니터링</h2>
                <p>예비상품부터 판매, 주문, 원소스 구매, 배송까지 순서대로 관리합니다.</p>
              </div>
              <button className="btn" onClick={() => refreshMonitoring().catch((error) => setNotice(error.message))} disabled={smartstoreLoading}>
                {smartstoreLoading ? "불러오는 중" : "새로고침"}
              </button>
            </div>
            <MonitoringBoard
              preparedProducts={preparedProducts}
              drafts={listingDrafts}
              orders={orders}
              smartstorePayload={smartstorePayload}
              smartstoreActive={isSmartstoreActive(apiKeys)}
              smartstoreLoading={smartstoreLoading}
              smartstoreError={smartstoreError}
              onOpenDraft={(item) => openPublishDraft(preparedToDraftSource(item))}
              onSell={openSellChannelSelector}
              onEditDraft={openDraftEditor}
              onValidateDraft={validateDraft}
              onDeletePrepared={deletePreparedProduct}
              onUpdateMonitoring={updatePreparedMonitoring}
              onSaveComparisonTargets={saveComparisonTargets}
              onScanComparisonTargets={scanComparisonTargets}
              comparisonScanningId={comparisonScanningId}
              comparisonHistories={comparisonHistories}
              onCopySmartstore={copySmartstoreToPrepared}
              onUpdateProcurement={updateProcurement}
              onOpenApi={() => {
                selectApiPlatform("smartstore");
                setTab("api");
              }}
            />
          </section>
        )}

        {tab === "api" && (
          <section className="section active">
            <div className="section-head">
              <div>
                <h2>검색설정</h2>
                <p>네이버는 전용 브라우저에서 사용자가 확인한 현재 화면만 수집합니다. 다나와·에누리·쿠팡은 쇼핑몰별 파서로 이어서 처리합니다.</p>
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
            {selectedCrawlerSource ? (
              <div className="crawler-source-note mt">
                <div>
                  <strong>{selectedApiKey?.label}은 API 키가 필요 없습니다.</strong>
                  <p>검색 페이지를 직접 수집해 최저가 라인에 반영합니다. 수집 테스트만 실행하면 됩니다.</p>
                </div>
                <button className="btn orange" onClick={testApiKey}>수집 테스트</button>
              </div>
            ) : (
              <div className="form-grid mt">
                <input className="input" placeholder="Client ID" value={apiClientId} onChange={(event) => setApiClientId(event.target.value)} />
                <input className="input" placeholder="Client Secret" value={apiClientSecret} onChange={(event) => setApiClientSecret(event.target.value)} />
                <button className="btn primary" onClick={saveApiKey}>저장</button>
                <button className="btn orange" onClick={testApiKey}>저장 후 연동 테스트</button>
              </div>
            )}
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
              onPublishLive={publishLive}
              onDeleteDraft={deleteDraft}
              onEditDraft={openDraftEditor}
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
              sortMode={sortMode}
              view="active"
              preparedProducts={preparedProducts}
              onExclude={toggleExclude}
              onPrepare={prepareProduct}
              selectedBenefitIds={selectedBenefitIds}
              benefitScanning={benefitScanning}
              onBenefitSelectionChange={setSelectedBenefitIds}
              onBenefitScan={scanBenefits}
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
              <div className="box settings-box quota-settings-box">
                <strong>소스별 일일 요청 한도</strong>
                <p>한국시간 자정에 사용량이 초기화됩니다. 한도를 초과한 소스만 건너뛰고 나머지 소스는 계속 수집합니다.</p>
                <div className="quota-list">
                  {collectionQuotas.map((quota) => {
                    const draft = quotaDrafts[quota.source] || { dailyLimit: quota.daily_limit, enabled: quota.enabled };
                    const usagePercent = Math.min((quota.used / Math.max(quota.daily_limit, 1)) * 100, 100);
                    return (
                      <div className="quota-row" key={quota.source}>
                        <div className="quota-summary">
                          <strong>{quota.label}</strong>
                          <span>오늘 {quota.used.toLocaleString()} / {quota.daily_limit.toLocaleString()}건</span>
                        </div>
                        <div className="quota-meter" aria-label={`${quota.label} 일일 요청 사용량`}>
                          <span style={{ width: `${usagePercent}%` }} />
                        </div>
                        <label>
                          <span>일일 한도</span>
                          <input
                            className="input"
                            type="number"
                            min="1"
                            max="10000"
                            step="10"
                            value={draft.dailyLimit}
                            onChange={(event) => setQuotaDrafts((current) => ({
                              ...current,
                              [quota.source]: { ...draft, dailyLimit: Number(event.target.value) },
                            }))}
                          />
                        </label>
                        <label className="quota-enabled">
                          <input
                            type="checkbox"
                            checked={draft.enabled}
                            onChange={(event) => setQuotaDrafts((current) => ({
                              ...current,
                              [quota.source]: { ...draft, enabled: event.target.checked },
                            }))}
                          />
                          <span>수집 사용</span>
                        </label>
                        <button className="btn small" onClick={() => saveCollectionQuota(quota.source)}>저장</button>
                      </div>
                    );
                  })}
                </div>
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

        {showCollectorConnection && (
          <aside className={`collector-connection ${extensionStatus}`} aria-label="수집기 연결 상태"
            onKeyDown={(event) => { if (event.key === "Escape") setShowCollectorConnection(false); }}>
            <span className="collector-connection-dot" aria-hidden="true" />
            <div className="collector-connection-copy" role="status">
              <strong>{collectorCopy.title}</strong>
              <p>{collectorCopy.detail}</p>
            </div>
            <button className="collector-connection-close" type="button" aria-label="연결 안내 닫기" onClick={() => setShowCollectorConnection(false)}>×</button>
            <button className="collector-connection-action" type="button" disabled={collectorCopy.kind === "waiting"} onClick={() => {
              if (collectorCopy.kind === "open") void openDedicatedBrowser();
              else if (collectorCopy.kind === "reload") window.location.reload();
              else if (collectorCopy.kind === "close") setShowCollectorConnection(false);
            }}>{collectorCopy.action}</button>
          </aside>
        )}

        {coupangCollector.open && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCoupangCollector((current) => ({ ...current, open: false, submitting: false }));
          }}>
            <div className="browser-collector-modal" role="dialog" aria-modal="true" aria-label="쿠팡 브라우저 수집">
              <div className="section-head">
                <div>
                  <span className="eyebrow">사용자 승인형 수집</span>
                  <h2>쿠팡 브라우저 수집</h2>
                  <p>현재 브라우저에 보이는 쿠팡 검색 결과 DOM/HTML에서 가격 비교용 정보만 PriceScan에 저장합니다.</p>
                </div>
                <button
                  className="btn modal-close-button"
                  onClick={() => setCoupangCollector((current) => ({ ...current, open: false, submitting: false }))}
                  aria-label="닫기"
                >
                  ×
                </button>
              </div>
              <div className="browser-collector-guide">
                <section>
                  <strong>1. 쿠팡 검색 페이지</strong>
                  <p>모델명으로 생성된 검색 URL입니다. 로그인/캡차가 나오면 사용자가 직접 처리합니다.</p>
                  <a href={coupangCollector.pageUrl} target="_blank" rel="noreferrer">{coupangCollector.pageUrl}</a>
                </section>
                <section>
                  <strong>2. 승인 범위</strong>
                  <label>
                    <input
                      type="radio"
                      checked={coupangCollector.approvalScope === "once"}
                      onChange={() => setCoupangCollector((current) => ({ ...current, approvalScope: "once" }))}
                    />
                    이번 1회만 허용
                  </label>
                  <label>
                    <input
                      type="radio"
                      checked={coupangCollector.approvalScope === "session"}
                      onChange={() => setCoupangCollector((current) => ({ ...current, approvalScope: "session" }))}
                    />
                    이번 세션 허용
                  </label>
                </section>
              </div>
              <div className="browser-collector-consent">
                <strong>저장 범위</strong>
                <span>상품명, 등록가, 노출가, 배송비, 상세링크, 수집시간만 저장합니다. 쿠팡 아이디/비밀번호/쿠키/결제정보는 저장하지 않습니다.</span>
              </div>
              <label className="browser-collector-input">
                <span>쿠팡 DOM/HTML 또는 TOP 10 결과 붙여넣기</span>
                <textarea
                  className="input"
                  value={coupangCollector.rawText}
                  onChange={(event) => setCoupangCollector((current) => ({ ...current, rawText: event.target.value }))}
                  placeholder={`지원 형식\n1) 쿠팡 검색결과 HTML/DOM\n<li class="search-product">...<del>3,152,670원</del><strong>2,742,830원</strong>...</li>\n\n2) 텍스트\n삼성전자 갤럭시북6 프로 NT940XJG-K51A\n등록가 3,152,670원 노출가 2,742,830원 무료배송\nhttps://www.coupang.com/vp/products/...\n\n3) JSON\n[{"name":"상품명","registeredPrice":3152670,"price":2742830,"shipping":0,"detailUrl":"https://..."}]`}
                />
              </label>
              <p className="hint">DOM/HTML을 넣으면 상품카드 파서가 상품명·가격·배송비·상세링크를 자동 추출합니다. 다음 단계에서 확장 프로그램/로컬 브라우저 컨트롤러가 이 DOM을 자동 제출하게 연결합니다.</p>
              <div className="modal-actions">
                <button
                  className="btn"
                  onClick={() => window.open(coupangCollector.pageUrl, "_blank", "noopener,noreferrer")}
                >
                  쿠팡 다시 열기
                </button>
                <button
                  className="btn"
                  onClick={() => setCoupangCollector((current) => ({ ...current, open: false, submitting: false }))}
                  disabled={coupangCollector.submitting}
                >
                  취소
                </button>
                <button className="btn primary" onClick={submitCoupangBrowserResults} disabled={coupangCollector.submitting}>
                  {coupangCollector.submitting ? "저장 중" : "PriceScan에 반영"}
                </button>
              </div>
            </div>
          </div>
        )}

        {showSearchExceptions && (
          <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowSearchExceptions(false);
          }}>
            <div className="search-exception-modal" role="dialog" aria-modal="true" aria-label="검색 예외어 설정">
              <div className="section-head">
                <div>
                  <h2>검색 예외어</h2>
                  <p>상품명에 포함되면 자동으로 제외할 단어를 쉼표로 구분해 입력하세요.</p>
                </div>
                <button className="btn modal-close-button" onClick={() => setShowSearchExceptions(false)} aria-label="닫기">×</button>
              </div>
              <textarea
                className="input exception-textarea"
                value={searchExceptionDraft}
                onChange={(event) => setSearchExceptionDraft(event.target.value)}
                placeholder="파우치, 보호필름, 케이스, 키스킨"
              />
              <p className="hint">현재 저장: {searchExceptionTerms.length}개 · 저장 후 다음 스캔부터 적용됩니다.</p>
              <div className="modal-actions">
                <button className="btn" onClick={() => setShowSearchExceptions(false)}>취소</button>
                <button className="btn primary" onClick={saveSearchExceptions}>저장</button>
              </div>
            </div>
          </div>
        )}

        {sellCandidate && (
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setSellCandidate(null);
            }}
          >
            <div className="sell-channel-modal" role="dialog" aria-modal="true" aria-label="판매 쇼핑몰 선택">
              <div className="sell-channel-head">
                <div>
                  <span className="eyebrow">판매 채널 선택</span>
                  <h3>{sellCandidate.model_name || inferProductIdentity(sellCandidate.title).modelName || sellCandidate.title}</h3>
                  <p>등록할 쇼핑몰을 선택하면 해당 쇼핑몰 등록폼으로 이동합니다.</p>
                </div>
                <button className="btn modal-close-button" aria-label="닫기" onClick={() => setSellCandidate(null)}>×</button>
              </div>
              <div className="sell-channel-list">
                <button
                  className={`sell-channel-card ${isSmartstoreActive(apiKeys) ? "connected" : ""}`}
                  onClick={continueSmartstoreSale}
                >
                  <span className="channel-light" />
                  <strong>네이버 스마트스토어</strong>
                  <small>{isSmartstoreActive(apiKeys) ? "API 연결됨 · 등록 가능" : "셀러 API 연결 필요"}</small>
                  <b>{sellCandidate.listing_draft_id ? "기존 등록폼 열기" : "등록폼 작성"}</b>
                </button>
                {["쿠팡", "11번가", "G마켓", "옥션"].map((mall) => (
                  <button className="sell-channel-card disabled" key={mall} disabled>
                    <span className="channel-light" />
                    <strong>{mall}</strong>
                    <small>판매자 API 연동 준비 중</small>
                    <b>선택 불가</b>
                  </button>
                ))}
              </div>
              <div className="modal-actions">
                <button className="btn" onClick={() => setSellCandidate(null)}>취소</button>
              </div>
            </div>
          </div>
        )}

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
                onLoadCategoryCandidates={async (keyword) => {
                  const data = await request<{ items: SmartstoreCategoryCandidate[] }>(`/smartstore/category-suggestions?q=${encodeURIComponent(keyword)}`, token);
                  return data.items;
                }}
                onCancel={() => setDraftSourceItem(null)}
              />
            </div>
          </div>
        )}

        {editingDraft && editingDraftForm && (
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeDraftEditor();
            }}
          >
            <div className="publish-modal smartstore-window" role="dialog" aria-modal="true" aria-label="네이버 상품등록 폼">
              <PublishDraftPanel
                sourceItem={sourceItemFromDraft(editingDraft)}
                form={editingDraftForm}
                smartstoreActive={isSmartstoreActive(apiKeys)}
                onChange={setEditingDraftForm}
                onTogglePlatform={toggleEditingDraftPlatform}
                onApprove={saveEditingDraft}
                onUploadImage={uploadDraftImage}
                onLoadCategoryCandidates={async (keyword) => {
                  const data = await request<{ items: SmartstoreCategoryCandidate[] }>(`/smartstore/category-suggestions?q=${encodeURIComponent(keyword)}`, token);
                  return data.items;
                }}
                onCancel={closeDraftEditor}
                title="네이버 상품등록 폼"
                description="스마트스토어 상품등록 화면 흐름에 맞춰 초안 필드를 보완합니다."
                submitLabel="수정 저장"
                readyMessage="수정값을 저장한 뒤 검사 또는 등록실행을 진행할 수 있습니다."
                extraActions={(
                  <>
                    <button className="btn" onClick={saveAndValidateEditingDraft}>저장 후 검사</button>
                    <button className="btn" onClick={saveAndPrepareEditingDraft}>저장 후 등록 요청 검사</button>
                    <button className="btn orange" onClick={saveAndPublishLiveEditingDraft} disabled={editingDraft.status === "published" || editingDraft.status === "publishing"}>
                      저장 후 네이버 실제등록
                    </button>
                  </>
                )}
              />
            </div>
          </div>
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

function monitoringMetrics(item: PreparedProduct, feeRate: number, sellerDisplayPrice: number) {
  const sourceCost = Math.max(item.display_price, 0) + Math.max(item.shipping_fee, 0);
  const fee = Math.round(Math.max(sellerDisplayPrice, 0) * Math.max(feeRate, 0) / 100);
  const settlement = Math.max(sellerDisplayPrice, 0) - fee;
  const margin = settlement - sourceCost;
  const compareRate = sourceCost > 0 ? ((Math.max(sellerDisplayPrice, 0) - sourceCost) / sourceCost) * 100 : 0;
  const marginRate = sellerDisplayPrice > 0 ? (margin / sellerDisplayPrice) * 100 : 0;
  return { sourceCost, fee, settlement, margin, compareRate, marginRate };
}

function settlementMetrics(displayPrice: number, cost: number, feeRate: number) {
  const fee = Math.round(Math.max(displayPrice, 0) * Math.max(feeRate, 0) / 100);
  const settlement = Math.max(displayPrice, 0) - fee;
  const margin = settlement - Math.max(cost, 0);
  const marginRate = displayPrice > 0 ? (margin / displayPrice) * 100 : 0;
  return { fee, settlement, margin, marginRate };
}

function MonitoringPriceStack({ registeredPrice, exposurePrice, shippingFee = 0 }: { registeredPrice: number; exposurePrice: number; shippingFee?: number }) {
  return (
    <span className="monitoring-price-stack">
      <s>등록가 {money(registeredPrice)}</s>
      <b>노출가 {money(exposurePrice)}</b>
      {shippingFee > 0 && <small>배송비 {money(shippingFee)}</small>}
    </span>
  );
}

function MonitoringPriceHistoryChart({
  comparisonHistory,
  limit = 10,
}: {
  comparisonHistory: ComparisonHistory;
  limit?: number;
}) {
  const platformSeries = comparisonPlatformOptions.map((platform) => {
    const rows = (comparisonHistory[platform.key] || []).slice(-limit).filter((item) => item.total_price > 0 && Boolean(item.collected_at));
    const sortedRows = [...rows].sort((a, b) => new Date(a.collected_at).getTime() - new Date(b.collected_at).getTime());
    return { ...platform, rows: sortedRows };
  })
    .filter((platform) => platform.rows.length > 0);

  const buckets = Array.from(
    new Set(
      platformSeries.flatMap((platform) =>
        platform.rows.map((item) => `${new Date(item.collected_at).getTime()}`),
      ),
    ),
  )
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
    .filter((value, index, allValues) => allValues.indexOf(value) === index);

  if (platformSeries.length === 0) {
    return (
      <section className="monitoring-comparison-history">
        <div className="comparison-monitor-head"><strong>가격 추이</strong><span>점검한 경쟁가 히스토리가 없습니다.</span></div>
      </section>
    );
  }

  const limitedBuckets = buckets.slice(-Math.max(2, Math.min(limit, buckets.length)));
  const bucketIndex = new Map<number, number>(limitedBuckets.map((bucket, index) => [bucket, index]));

  const allPrices = platformSeries.flatMap((platform) => platform.rows.map((item) => item.total_price));
  const minPrice = allPrices.length ? Math.min(...allPrices) : 0;
  const maxPrice = allPrices.length ? Math.max(...allPrices) : 0;
  const plotPoints = platformSeries.map((platform) => {
    const points = platform.rows
      .filter((item) => item.total_price > 0 && limitedBuckets.includes(new Date(item.collected_at).getTime()))
      .map((item, index) => {
        const xIndex = bucketIndex.get(new Date(item.collected_at).getTime()) ?? index;
        const x = limitedBuckets.length <= 1 ? 50 : (xIndex / (Math.max(1, limitedBuckets.length - 1))) * 100;
        const y = maxPrice === minPrice ? 50 : 88 - ((item.total_price - minPrice) / (maxPrice - minPrice)) * 76;
        return {
          platform: platform.key,
          row: item,
          x: Math.min(Math.max(x, 0), 100),
          y: Math.min(Math.max(y, 12), 88),
        };
      });
    return {
      ...platform,
      points,
      linePoints: points.map((point) => `${point.x},${point.y}`).join(" "),
    };
  });

  return (
    <section className="monitoring-comparison-history">
      <div className="comparison-monitor-head">
        <div>
          <strong>가격 추이</strong>
          <span>최근 10회 경쟁가(최저가) 추적 내역</span>
        </div>
        <div className="comparison-monitor-kpis">
          <span>축 최저 {money(minPrice)}</span>
          <span>축 최고 {money(maxPrice)}</span>
        </div>
      </div>
      <div className="monitoring-price-history-plot" role="group" aria-label="모니터링 중인 경쟁가 가격 추이">
        <svg className="monitoring-price-history-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line className="price-source-grid-line" x1="0" y1="12" x2="100" y2="12" />
          <line className="price-source-grid-line" x1="0" y1="50" x2="100" y2="50" />
          <line className="price-source-grid-line" x1="0" y1="88" x2="100" y2="88" />
          {plotPoints.map((series) => (
            <polyline
              className="monitoring-price-history-line"
              key={`history-line-${series.key}`}
              points={series.linePoints}
              stroke={comparisonPlatformColors[series.key]}
            />
          ))}
        </svg>
        {plotPoints.flatMap((series) => series.points).map((point, index) => (
          <button
            className="monitoring-price-history-point"
            style={{ left: `${point.x}%`, top: `${point.y}%`, backgroundColor: comparisonPlatformColors[point.platform] }}
            key={`history-point-${point.platform}-${point.row.id}-${index}`}
            title={`${point.row.mall} ${money(point.row.total_price)} · ${new Date(point.row.collected_at).toLocaleString("ko-KR")}`}
            type="button"
          >
            {point.row.rank}
          </button>
        ))}
      </div>
      <div className="monitoring-price-history-legend">
        {platformSeries.map((platform) => (
          <span key={`history-legend-${platform.key}`}>
            <i style={{ backgroundColor: comparisonPlatformColors[platform.key] }} />
            {platform.label} {platform.rows.length}개
          </span>
        ))}
      </div>
    </section>
  );
}

function MonitoringEditablePriceInputs({
  salePrice,
  displayPrice,
  onSalePrice,
  onDisplayPrice,
}: {
  salePrice: number;
  displayPrice: number;
  onSalePrice: (value: number) => void;
  onDisplayPrice: (value: number) => void;
}) {
  return (
    <span className="price-inputs monitoring-price-inputs">
      <label><span>등록가</span><input type="number" step="1000" min="0" value={salePrice} onChange={(event) => onSalePrice(Number(event.target.value))} /></label>
      <label><span>노출가</span><input type="number" step="1000" min="0" value={displayPrice} onChange={(event) => onDisplayPrice(Number(event.target.value))} /></label>
    </span>
  );
}

function monitoringIdentity(item: PreparedProduct) {
  const identity = inferProductIdentity(item.title);
  return {
    productType: item.product_type || inferProductType(item.title),
    modelName: item.model_name || identity.modelName || item.title,
  };
}

function MonitoringProductHead({ item, active }: { item: PreparedProduct; active: boolean }) {
  const identity = monitoringIdentity(item);
  return (
    <div className="monitoring-product-head">
      <div><span>상품종류</span><strong>{identity.productType}</strong></div>
      <div>
        <span>모델명</span>
        {item.source_url ? <a href={item.source_url} target="_blank" rel="noreferrer">{identity.modelName}</a> : <strong>{identity.modelName}</strong>}
      </div>
      <em className={active ? "pill green" : "pill"}>{active ? "모니터링 ON" : "대기"}</em>
    </div>
  );
}

function lowestCompetitorByPlatform(competitors: CompetitorSnapshot[], platform: ComparisonPlatform) {
  return [...competitors]
    .filter((competitor) => competitor.platform === platform && !competitor.is_excluded && competitor.total_price > 0)
    .sort((a, b) => a.total_price - b.total_price || a.rank - b.rank || a.mall.localeCompare(b.mall, "ko"))[0];
}

function MonitoringWaitingRow({ item, onUpdate, onDelete }: {
  item: PreparedProduct;
  onUpdate: (item: PreparedProduct, updates: Partial<PreparedProduct>) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [feeRate, setFeeRate] = useState(item.fee_rate || 0);
  const sellerDisplayPrice = item.seller_display_price || item.display_price;
  const metrics = monitoringMetrics(item, feeRate, sellerDisplayPrice);
  const identity = monitoringIdentity(item);
  const enableMonitoring = () => onUpdate(item, {
    monitoring_enabled: 1,
    fee_rate: feeRate,
    seller_sale_price: item.seller_sale_price || item.sale_price,
    seller_display_price: sellerDisplayPrice,
    product_type: identity.productType,
    model_name: identity.modelName,
  });
  return (
    <article className="monitoring-product-card">
      <MonitoringProductHead item={item} active={false} />
      <div className="monitoring-table-wrap">
        <table className="monitoring-data-table monitoring-card-table">
          <thead><tr><th>쇼핑몰</th><th>소싱가</th><th>수수료</th><th>예상정산</th><th>예상마진</th><th>상태</th><th>관리</th></tr></thead>
          <tbody>
            <tr>
              <td>{item.mall || sourceLabel(item.source)}</td>
              <td><MonitoringPriceStack registeredPrice={item.sale_price} exposurePrice={item.display_price} shippingFee={item.shipping_fee} /></td>
              <td><label className="inline-number"><input type="number" min="0" max="100" step="0.1" value={feeRate} onChange={(event) => setFeeRate(Number(event.target.value))} /><span>%</span></label><small>{money(metrics.fee)}</small></td>
              <td>{money(metrics.settlement)}</td>
              <td><span className={metrics.margin >= 0 ? "positive-value" : "negative-value"}>{money(metrics.margin)}</span><small>{metrics.marginRate.toFixed(1)}%</small></td>
              <td><button className="monitoring-toggle" aria-pressed="false" onClick={enableMonitoring}><span />OFF</button></td>
              <td><button className="btn small danger" onClick={() => onDelete(item.id)}>삭제</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </article>
  );
}

function MonitoringActiveRow({ item, onUpdate, onSell, onSaveComparisonTargets, onScanComparisonTargets, comparisonScanning, comparisonHistory }: {
  item: PreparedProduct;
  onUpdate: (item: PreparedProduct, updates: Partial<PreparedProduct>) => Promise<void>;
  onSell: (item: PreparedProduct) => void;
  onSaveComparisonTargets: (item: PreparedProduct, targets: { platform: ComparisonPlatform; comparison_url: string; enabled: boolean }[]) => Promise<PreparedProduct>;
  onScanComparisonTargets: (item: PreparedProduct) => Promise<PreparedProduct | undefined>;
  comparisonScanning: boolean;
  comparisonHistory: ComparisonHistory;
}) {
  const [feeRate, setFeeRate] = useState(item.fee_rate || 0);
  const [sellerSalePrice, setSellerSalePrice] = useState(item.seller_sale_price || item.sale_price);
  const [sellerDisplayPrice, setSellerDisplayPrice] = useState(item.seller_display_price || item.display_price);
  const [discountType, setDiscountType] = useState<"amount" | "percent">(item.auto_discount_type || "amount");
  const [discountValue, setDiscountValue] = useState(item.auto_discount_value || 0);
  const [autoDiscount, setAutoDiscount] = useState(Boolean(item.auto_discount_enabled));
  const [targetUrls, setTargetUrls] = useState<Record<ComparisonPlatform, string>>(() => comparisonPlatformOptions.reduce((acc, platform) => {
    acc[platform.key] = item.comparison_targets?.find((target) => target.platform === platform.key)?.comparison_url || "";
    return acc;
  }, {} as Record<ComparisonPlatform, string>));
  const metrics = monitoringMetrics(item, feeRate, sellerDisplayPrice);
  const identity = monitoringIdentity(item);
  const competitors = item.competitors || [];
  const lowestByPlatform = comparisonPlatformOptions.map((platform) => ({
    ...platform,
    competitor: lowestCompetitorByPlatform(competitors, platform.key),
  }));
  const marginScenarios = lowestByPlatform.flatMap((source) => (
    lowestByPlatform
      .filter((target) => target.key !== source.key && source.competitor && target.competitor)
      .map((target) => {
        const targetTotal = target.competitor?.total_price || 0;
        const sourceCost = source.competitor?.total_price || 0;
        const scenario = settlementMetrics(targetTotal, sourceCost, feeRate);
        return { source, target, targetTotal, sourceCost, ...scenario };
      })
  ));
  const hasComparisonUrl = comparisonPlatformOptions.some((platform) => targetUrls[platform.key]?.trim());
  useEffect(() => {
    setTargetUrls(comparisonPlatformOptions.reduce((acc, platform) => {
      acc[platform.key] = item.comparison_targets?.find((target) => target.platform === platform.key)?.comparison_url || "";
      return acc;
    }, {} as Record<ComparisonPlatform, string>));
  }, [item.id, item.comparison_targets]);
  const save = (enabled = true) => onUpdate(item, {
    monitoring_enabled: enabled ? 1 : 0,
    fee_rate: feeRate,
    seller_sale_price: sellerSalePrice,
    seller_display_price: sellerDisplayPrice,
    auto_discount_enabled: autoDiscount ? 1 : 0,
    auto_discount_type: discountType,
    auto_discount_value: discountValue,
    product_type: identity.productType,
    model_name: identity.modelName,
  });
  const saveTargets = () => onSaveComparisonTargets(item, comparisonPlatformOptions.map((platform) => ({
    platform: platform.key,
    comparison_url: targetUrls[platform.key] || "",
    enabled: Boolean(targetUrls[platform.key]?.trim()),
  })));
  return (
    <article className="monitoring-product-card active">
      <MonitoringProductHead item={item} active />
      <div className="monitoring-table-wrap">
        <table className="monitoring-data-table monitoring-card-table active-card-table">
          <thead><tr><th>소싱몰</th><th>소싱가</th><th>셀러 대응가</th><th>수수료</th><th>예상정산</th><th>예상마진</th><th>자동인하</th><th>관리</th></tr></thead>
          <tbody>
            <tr>
              <td>{item.mall || sourceLabel(item.source)}</td>
              <td><MonitoringPriceStack registeredPrice={item.sale_price} exposurePrice={item.display_price} shippingFee={item.shipping_fee} /></td>
              <td><MonitoringEditablePriceInputs salePrice={sellerSalePrice} displayPrice={sellerDisplayPrice} onSalePrice={setSellerSalePrice} onDisplayPrice={setSellerDisplayPrice} /></td>
              <td><label className="inline-number"><input type="number" min="0" max="100" step="0.1" value={feeRate} onChange={(event) => setFeeRate(Number(event.target.value))} /><span>%</span></label><small>{money(metrics.fee)}</small></td>
              <td>{money(metrics.settlement)}</td>
              <td><span className={metrics.margin >= 0 ? "positive-value" : "negative-value"}>{money(metrics.margin)}</span><small>{metrics.marginRate.toFixed(1)}%</small></td>
              <td><div className="auto-discount-control"><label><input type="checkbox" checked={autoDiscount} onChange={(event) => setAutoDiscount(event.target.checked)} /> 자동인하</label><span>최저가 대비</span><input type="number" min="0" step={discountType === "amount" ? 1000 : 0.1} value={discountValue} onChange={(event) => setDiscountValue(Number(event.target.value))} /><select value={discountType} onChange={(event) => setDiscountType(event.target.value as "amount" | "percent")}><option value="amount">원</option><option value="percent">%</option></select></div></td>
              <td><div className="monitoring-row-actions"><button className="btn small orange" onClick={() => onSell(item)}>{item.listing_draft_id ? "등록폼" : "판매"}</button><button className="btn small primary" onClick={() => save(true)}>저장</button><button className="monitoring-toggle on" aria-pressed="true" onClick={() => save(false)}><span />ON</button></div></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="comparison-monitor-box">
              <div className="comparison-monitor-head">
                <div>
                  <strong>가격비교 URL 추적</strong>
                  <span>{comparisonPlatformLabelText} 가격비교 상세 URL 기준으로 경쟁 판매처 TOP 3을 저장합니다.</span>
                </div>
              <div className="comparison-monitor-kpis">
                <span>최저 경쟁가 {money(item.lowest_competitor_total || 0)}</span>
                <span>추천 노출가 {money(item.recommended_display_price || sellerDisplayPrice)}</span>
                {item.last_competitor_scanned_at && <span>최근 {new Date(item.last_competitor_scanned_at).toLocaleString("ko-KR")}</span>}
              </div>
            </div>
            <div className="comparison-target-inputs">
              {comparisonPlatformOptions.map((platform) => {
                const target = item.comparison_targets?.find((entry) => entry.platform === platform.key);
                return (
                  <label key={platform.key}>
                    <span>{platform.label}</span>
                    <input
                      value={targetUrls[platform.key] || ""}
                      onChange={(event) => setTargetUrls((current) => ({ ...current, [platform.key]: event.target.value }))}
                      placeholder={platform.placeholder}
                    />
                    <small className={target?.status === "error" ? "negative-value" : ""}>{target?.last_error || statusLabel(target?.status || "pending")}</small>
                  </label>
                );
              })}
              <div className="comparison-target-actions">
                <button className="btn small" onClick={saveTargets}>URL 저장</button>
                <button className="btn small primary" disabled={!hasComparisonUrl || comparisonScanning} onClick={() => onScanComparisonTargets(item)}>
                  {comparisonScanning ? "스캔 중" : "경쟁가 스캔"}
                </button>
              </div>
            </div>
            <div className="comparison-snapshot-grid">
              {comparisonPlatformOptions.map((platform) => {
                const rows = competitors.filter((competitor) => competitor.platform === platform.key).sort((a, b) => a.rank - b.rank).slice(0, 3);
                return (
                  <section key={platform.key}>
                <strong>{platform.label} TOP 3</strong>
                {rows.length === 0 && <p>아직 스캔 결과 없음</p>}
                {rows.map((competitor) => (
                      <div className={`comparison-snapshot-item ${competitor.is_excluded ? "excluded" : ""}`} key={competitor.id}>
                        <span>{competitor.rank}위</span>
                        <b>{competitor.mall}</b>
                        <em>{money(competitor.total_price)}</em>
                        {competitor.detail_url && <a href={competitor.detail_url} target="_blank" rel="noreferrer">link</a>}
                        {competitor.exclusion_reason && <small>{competitor.exclusion_reason}</small>}
                      </div>
                    ))}
                  </section>
                );
              })}
            </div>
            <MonitoringPriceHistoryChart comparisonHistory={comparisonHistory} />
            <div className="comparison-margin-simulator">
              <div className="comparison-monitor-head compact">
                <div>
                  <strong>채널 이동 마진 시뮬레이션</strong>
                  <span>각 소스 최저가를 다른 채널 최저가 기준으로 판매할 때 수수료 차감 후 예상정산과 마진율을 계산합니다.</span>
                </div>
              </div>
              {marginScenarios.length > 0 ? (
                <div className="monitoring-table-wrap">
                  <table className="monitoring-data-table simulator-table">
                    <thead><tr><th>소싱 최저가</th><th>판매 기준가</th><th>등록/노출 기준</th><th>수수료</th><th>예상정산</th><th>예상마진</th></tr></thead>
                    <tbody>
                      {marginScenarios.map((scenario) => (
                        <tr key={`${scenario.source.key}-${scenario.target.key}`}>
                          <td><strong>{scenario.source.label}</strong><small>{scenario.source.competitor?.mall} · {money(scenario.sourceCost)}</small></td>
                          <td><strong>{scenario.target.label}</strong><small>{scenario.target.competitor?.mall} · {money(scenario.targetTotal)}</small></td>
                          <td><MonitoringPriceStack registeredPrice={scenario.target.competitor?.sale_price || scenario.targetTotal} exposurePrice={scenario.targetTotal} /></td>
                          <td>{money(scenario.fee)}<small>{feeRate.toFixed(1)}%</small></td>
                          <td>{money(scenario.settlement)}</td>
                          <td><span className={scenario.margin >= 0 ? "positive-value" : "negative-value"}>{money(scenario.margin)}</span><small>{scenario.marginRate.toFixed(1)}%</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="simulator-empty">{comparisonPlatformLabelText} 경쟁가 스캔 후 채널 이동 마진을 계산합니다.</p>
              )}
            </div>
          </div>
    </article>
  );
}

function MonitoringBoard({
  preparedProducts,
  drafts,
  orders,
  smartstorePayload,
  smartstoreActive,
  smartstoreLoading,
  smartstoreError,
  onOpenDraft,
  onSell,
  onEditDraft,
  onValidateDraft,
  onDeletePrepared,
  onUpdateMonitoring,
  onSaveComparisonTargets,
  onScanComparisonTargets,
  comparisonScanningId,
  comparisonHistories,
  onCopySmartstore,
  onUpdateProcurement,
  onOpenApi,
}: {
  preparedProducts: PreparedProduct[];
  drafts: ListingDraft[];
  orders: Order[];
  smartstorePayload: SmartstorePayload;
  smartstoreActive: boolean;
  smartstoreLoading: boolean;
  smartstoreError: string;
  onOpenDraft: (item: PreparedProduct) => void;
  onSell: (item: PreparedProduct) => void;
  onEditDraft: (draft: ListingDraft) => void;
  onValidateDraft: (draftId: string) => void;
  onDeletePrepared: (id: string) => void;
  onUpdateMonitoring: (item: PreparedProduct, updates: Partial<PreparedProduct>) => Promise<void>;
  onSaveComparisonTargets: (item: PreparedProduct, targets: { platform: ComparisonPlatform; comparison_url: string; enabled: boolean }[]) => Promise<PreparedProduct>;
  onScanComparisonTargets: (item: PreparedProduct) => Promise<PreparedProduct | undefined>;
  comparisonScanningId: string;
  comparisonHistories: Record<string, ComparisonHistory>;
  onCopySmartstore: (item: SmartstoreProduct) => void;
  onUpdateProcurement: (order: Order, status: string, source?: PreparedProduct, updates?: Partial<Order>) => void;
  onOpenApi: () => void;
}) {
  const [view, setView] = useState<MonitoringView>("monitoring_sales");
  const procurementOrders = orders.filter((order) => !["shipped", "cancelled"].includes(order.procurement_status));
  const shippingOrders = orders.filter((order) => ["ordered", "tracking_pending", "shipped"].includes(order.procurement_status));
  const workflow = [
    { key: "monitoring_sales" as MonitoringView, step: "2", label: "모니터링판매", count: preparedProducts.length + smartstorePayload.count },
    { key: "procurement" as MonitoringView, step: "5", label: "주문·발주", count: procurementOrders.length },
    { key: "shipping" as MonitoringView, step: "6", label: "배송·클레임", count: shippingOrders.length },
    { key: "settlement" as MonitoringView, step: "7", label: "정산", count: 0 },
  ];

  const findSmartstoreMonitoringMatch = (item: SmartstoreProduct) => {
    const smartText = normalize(`${item.name} ${item.seller_management_code}`);
    return preparedProducts.find((candidate) => {
      const identity = monitoringIdentity(candidate);
      const modelText = normalize(identity.modelName);
      const titleText = normalize(candidate.title);
      return Boolean(modelText && smartText.includes(modelText)) || Boolean(titleText && smartText.includes(titleText));
    });
  };

  const sellingPanel = (
    <section className="monitoring-panel">
      <div className="monitoring-panel-head">
        <div><strong>판매중 상품</strong><span>등록가와 노출가를 함께 보고, 모니터링 상품 기준 예상정산/마진을 확인합니다.</span></div>
        <b>{smartstorePayload.count}</b>
      </div>
      {!smartstoreActive && (
        <div className="monitoring-empty">
          <p>네이버 셀러 API 연결이 필요합니다.</p>
          <button className="btn small primary" onClick={onOpenApi}>검색설정으로 이동</button>
        </div>
      )}
      {smartstoreActive && smartstoreError && <div className="source-warning"><span>{smartstoreError}</span></div>}
      {smartstoreActive && smartstoreLoading && <div className="monitoring-empty">판매상품 조회 중...</div>}
      {smartstoreActive && !smartstoreLoading && (
        <div className="monitoring-table-wrap">
          <table className="monitoring-data-table selling-table">
            <thead><tr><th>상품명</th><th>상태/재고</th><th>등록가/노출가</th><th>배송비</th><th>모니터링 비교</th><th>예상정산/마진</th><th>관리</th></tr></thead>
            <tbody>
              {smartstorePayload.items.map((item) => {
                const match = findSmartstoreMonitoringMatch(item);
                const exposurePrice = item.discounted_price || item.sale_price;
                const sourceCost = match ? (match.lowest_competitor_total || match.display_price + match.shipping_fee) : 0;
                const metrics = match ? settlementMetrics(exposurePrice, sourceCost, match.fee_rate || 0) : null;
                return (
                  <tr key={item.channel_product_no || item.id}>
                    <td className="monitoring-model">{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.name}</a> : item.name}<small>채널상품번호 {item.channel_product_no || "-"}</small></td>
                    <td><span className="pill green">{item.status || "판매중"}</span><small>재고 {item.stock_quantity.toLocaleString("ko-KR")}</small></td>
                    <td><MonitoringPriceStack registeredPrice={item.sale_price} exposurePrice={exposurePrice} /></td>
                    <td>{money(item.delivery_fee)}</td>
                    <td>{match ? <span className="monitoring-match"><b>{monitoringIdentity(match).modelName}</b><small>비교원가 {money(sourceCost)}</small></span> : <span className="source-health-row warning"><span>모니터링 상품 매핑 대기</span></span>}</td>
                    <td>{metrics ? <span className="monitoring-settlement"><b>{money(metrics.settlement)}</b><small className={metrics.margin >= 0 ? "positive-value" : "negative-value"}>{money(metrics.margin)} · {metrics.marginRate.toFixed(1)}%</small></span> : "계산 대기"}</td>
                    <td><div className="monitoring-row-actions"><button className="btn small" onClick={() => onCopySmartstore(item)}>모니터링 상품으로 복사</button>{item.url && <a className="btn small" href={item.url} target="_blank" rel="noreferrer">상품 보기</a>}</div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {smartstorePayload.items.length === 0 && !smartstoreError && <div className="monitoring-empty">조회된 스마트스토어 판매상품이 없습니다.</div>}
        </div>
      )}
    </section>
  );

  const monitoringProductsPanel = (
    <section className="monitoring-panel">
      <div className="monitoring-panel-head">
        <div><strong>모니터링 상품</strong><span>상품검색에서 모니터링 등록한 상품입니다. 대기와 ON 상태를 한 곳에서 관리합니다.</span></div>
        <b>{preparedProducts.length}</b>
      </div>
      <div className="monitoring-product-list">
        {preparedProducts.map((item) => (
          Boolean(item.monitoring_enabled) ? (
            <MonitoringActiveRow
              key={item.id}
              item={item}
              onUpdate={onUpdateMonitoring}
              onSell={onSell}
              onSaveComparisonTargets={onSaveComparisonTargets}
              onScanComparisonTargets={onScanComparisonTargets}
              comparisonScanning={comparisonScanningId === item.id}
              comparisonHistory={comparisonHistories[item.id] || ({} as ComparisonHistory)}
            />
          ) : (
            <MonitoringWaitingRow key={item.id} item={item} onUpdate={onUpdateMonitoring} onDelete={onDeletePrepared} />
          )
        ))}
        {preparedProducts.length === 0 && <div className="monitoring-empty">상품검색에서 `모니터링 등록`을 눌러 추가하세요.</div>}
      </div>
    </section>
  );

  const monitoringSalesPanel = (
    <div className="monitoring-sales-layout">
      {sellingPanel}
      {monitoringProductsPanel}
    </div>
  );

  const orderPanel = (shippingOnly = false) => {
    const visibleOrders = shippingOnly ? shippingOrders : procurementOrders;
    return (
      <section className="monitoring-panel operation-panel">
        <div className="monitoring-panel-head">
          <div><strong>{shippingOnly ? "배송·클레임" : "주문·원소스 발주"}</strong><span>{shippingOnly ? "송장 반영과 배송 예외를 확인합니다." : "결제 전 원소스 가격·재고를 반드시 다시 확인합니다."}</span></div>
          <b>{visibleOrders.length}</b>
        </div>
        <div className="monitoring-list">
          {visibleOrders.map((order) => {
            const sourceTotal = order.source_price + order.source_shipping;
            const expectedMargin = order.sale_amount > 0 && sourceTotal > 0 ? order.sale_amount - sourceTotal : 0;
            return (
              <article className="monitoring-item procurement-item" key={order.id}>
                <div className="monitoring-item-title">
                  <strong>{order.product}</strong>
                  <span className={pillClass(order.procurement_status)}>{statusLabel(order.procurement_status)}</span>
                </div>
                <p>{order.channel} · 주문 {order.id} · 수령인 {order.recipient}</p>
                <div className="procurement-grid">
                  <div><span>원소스</span><strong>{order.source_mall || "미연결"}</strong></div>
                  <div><span>원가+배송</span><strong>{sourceTotal ? money(sourceTotal) : "확인 필요"}</strong></div>
                  <div><span>예상마진</span><strong>{expectedMargin ? money(expectedMargin) : "계산 대기"}</strong></div>
                  <div><span>송장</span><strong>{order.tracking_no || "대기"}</strong></div>
                </div>
                {!order.source_url && !shippingOnly && (
                  <label className="source-link-select">
                    <span>원소스 상품 연결</span>
                    <select defaultValue="" onChange={(event) => {
                      const source = preparedProducts.find((item) => item.id === event.target.value);
                      if (source) onUpdateProcurement(order, "source_check", source);
                    }}>
                      <option value="">예비상품에서 선택</option>
                      {preparedProducts.filter((item) => item.source_url).map((item) => <option key={item.id} value={item.id}>{item.mall} · {item.title}</option>)}
                    </select>
                  </label>
                )}
                <div className="monitoring-actions">
                  {order.source_url && <a className="btn small" href={order.source_url} target="_blank" rel="noreferrer">원소스 열기</a>}
                  {!shippingOnly && order.source_url && order.procurement_status === "source_check" && <button className="btn small" onClick={() => onUpdateProcurement(order, "approval_required")}>재고·가격 확인완료</button>}
                  {!shippingOnly && order.procurement_status === "approval_required" && <button className="btn small primary" onClick={() => onUpdateProcurement(order, "purchase_approved")}>구매 승인</button>}
                  {!shippingOnly && order.procurement_status === "purchase_approved" && <button className="btn small primary" onClick={() => {
                    const sourceOrderNo = window.prompt("원소스 쇼핑몰 주문번호를 입력하세요.", order.source_order_no);
                    if (sourceOrderNo) onUpdateProcurement(order, "ordered", undefined, { source_order_no: sourceOrderNo });
                  }}>구매완료 기록</button>}
                  {order.procurement_status === "ordered" && <button className="btn small" onClick={() => {
                    const trackingNo = window.prompt("원소스에서 발급된 송장번호를 입력하세요.", order.tracking_no);
                    if (trackingNo) onUpdateProcurement(order, "tracking_pending", undefined, { tracking_no: trackingNo });
                  }}>송장번호 등록</button>}
                  {order.procurement_status === "tracking_pending" && order.tracking_no && <button className="btn small primary" onClick={() => onUpdateProcurement(order, "shipped")}>배송 시작</button>}
                </div>
              </article>
            );
          })}
          {visibleOrders.length === 0 && <div className="monitoring-empty">현재 이 단계에서 처리할 주문이 없습니다.</div>}
        </div>
      </section>
    );
  };

  return (
    <div className="monitoring-workspace">
      <nav className="workflow-rail" aria-label="상품 운영 순서">
        {workflow.map((item) => (
          <button key={item.key} className={view === item.key ? "active" : ""} onClick={() => setView(item.key)}>
            <span>{item.step}</span><strong>{item.label}</strong><b>{item.count}</b>
          </button>
        ))}
      </nav>
      <div className="workflow-rule">
        <strong>운영 순서</strong>
        <span>1. 상품검색·모니터링 등록</span>
        <span>2. 모니터링판매에서 가격·마진 시뮬레이션</span>
        <span>3. 주문·발주 처리</span>
      </div>
      {view === "monitoring_sales" && monitoringSalesPanel}
      {view === "procurement" && orderPanel(false)}
      {view === "shipping" && orderPanel(true)}
      {view === "settlement" && <div className="monitoring-empty settlement-empty">정산 연동은 판매채널 주문·발주 흐름이 안정화된 다음 단계에서 연결합니다.</div>}
    </div>
  );
}

function PublishStatusBar({ apiKeys }: { apiKeys: ApiKey[] }) {
  const connected = new Set(apiKeys.filter((item) => item.status === "connected" || item.status === "configured").map((item) => item.platform));
  const platforms = [
    { key: "smartstore", label: "네이버스마트", active: isSmartstoreActive(apiKeys), status: "자동등록" },
    { key: "coupang", label: "쿠팡", active: connected.has("coupang"), status: "대기" },
    { key: "elevenst", label: "11번가", active: connected.has("elevenst"), status: "대기" },
    { key: "gmarket", label: "G마켓", active: connected.has("gmarket"), status: "대기" },
    { key: "auction", label: "옥션", active: connected.has("auction"), status: "대기" },
    { key: "danawa", label: "다나와", active: connected.has("danawa"), status: "대기" },
    { key: "enuri", label: "에누리", active: connected.has("enuri"), status: "대기" },
  ];
  return (
    <div className="publish-status-bar" aria-label="쇼핑몰 자동등록 연결 상태">
      <div className="publish-status-track">
        {platforms.map((platform) => (
          <span className={`publish-status-item ${platform.active ? "active" : ""}`} key={platform.key}>
            <span className={`status-dot ${platform.active ? "on" : ""}`} />
            <strong>{platform.label}</strong>
            <em>{platform.active ? "활성화" : platform.status}</em>
          </span>
        ))}
      </div>
    </div>
  );
}

function SourceSelector({
  groups,
  selected,
  quotas,
  onToggle,
}: {
  groups: SearchSourceGroup[];
  selected: string[];
  quotas: CollectionQuota[];
  onToggle: (source: string) => void;
}) {
  const quotaBySource = new Map(quotas.map((quota) => [quota.source, quota]));
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
                <label className={`source-option ${option.enabled && quotaBySource.get(option.key)?.enabled !== false ? "" : "disabled"}`} key={option.key}>
                  <input
                    type="checkbox"
                    checked={selected.includes(option.key)}
                    disabled={!option.enabled || quotaBySource.get(option.key)?.enabled === false}
                    onChange={() => onToggle(option.key)}
                  />
                  <span>
                    <b>{option.label}</b>
                    <em>{option.description}</em>
                  </span>
                  <small>
                    {quotaBySource.has(option.key)
                      ? `오늘 ${quotaBySource.get(option.key)?.used}/${quotaBySource.get(option.key)?.daily_limit}`
                      : option.badge}
                  </small>
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
  onPublishLive,
  onDeleteDraft,
  onEditDraft,
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
  onPublishLive: (draftId: string) => void;
  onDeleteDraft: (draftId: string) => void;
  onEditDraft: (draft: ListingDraft) => void;
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
                        {draft.publish_error && <small className="danger-text">{draft.publish_error}</small>}
                        {(draft.external_channel_product_no || draft.external_product_no) && (
                          <small>
                            네이버 상품번호 {draft.external_channel_product_no || draft.external_product_no}
                            {draft.external_url && <a href={draft.external_url} target="_blank" rel="noreferrer"> · 스마트스토어센터 열기</a>}
                          </small>
                        )}
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
                    <button className="btn small" onClick={() => onEditDraft(draft)}>등록폼 열기</button>
                    <button className="btn small" onClick={() => onValidateDraft(draft.id)}>검사</button>
                    <button className="btn small" onClick={() => onPreparePublish(draft.id)} disabled={draft.status === "published" || draft.status === "publishing"}>
                      등록 요청 검사
                    </button>
                    <button className="btn small orange" onClick={() => onPublishLive(draft.id)} disabled={draft.status === "published" || draft.status === "publishing"}>
                      {draft.status === "publishing" ? "등록 중" : "네이버 실제등록"}
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
  onLoadCategoryCandidates,
  onCancel,
  title = "상품등록 초안",
  description = "스캔된 상품 정보를 등록폼에 자동 채움했습니다. 이미지/상세설명 권리 확인 후 승인하세요.",
  submitLabel = "초안 승인",
  readyMessage = "대시보드에서 등록실행을 누르면 보호모드로 등록 요청값이 생성됩니다.",
  extraActions,
}: {
  sourceItem: DraftSourceItem;
  form: DraftForm;
  smartstoreActive: boolean;
  onChange: (form: DraftForm) => void;
  onTogglePlatform: (platform: string) => void;
  onApprove: () => void;
  onUploadImage: (file: File) => Promise<string>;
  onLoadCategoryCandidates: (keyword: string) => Promise<SmartstoreCategoryCandidate[]>;
  onCancel: () => void;
  title?: string;
  description?: string;
  submitLabel?: string;
  readyMessage?: string;
  extraActions?: ReactNode;
}) {
  const [imageUploading, setImageUploading] = useState(false);
  const [imageUploadError, setImageUploadError] = useState("");
  const [categoryCandidates, setCategoryCandidates] = useState<SmartstoreCategoryCandidate[]>([]);
  const [categoryLoading, setCategoryLoading] = useState(false);
  const [categoryError, setCategoryError] = useState("");
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
  const loadCategoryCandidates = async () => {
    if (!form.title.trim()) return;
    setCategoryLoading(true);
    setCategoryError("");
    try {
      const items = await onLoadCategoryCandidates(form.title);
      setCategoryCandidates(items);
      if (items.length === 0) setCategoryError("상품명과 일치하는 최종 카테고리를 찾지 못했습니다.");
    } catch (error) {
      setCategoryError(error instanceof Error ? error.message : "카테고리 조회 실패");
    } finally {
      setCategoryLoading(false);
    }
  };

  return (
    <div className="publish-draft-panel">
      <div className="section-head">
        <div>
          <span className="eyebrow">네이버 스마트스토어 등록폼</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <button className="btn small modal-close-button" onClick={onCancel} aria-label="닫기" title="닫기">×</button>
      </div>

      <div className="smartstore-form-layout">
        <div className="smartstore-form-body">
          <div className="source-summary">
            <strong>원본 상품</strong>
            <span>{sourceItem.mall || "소스 미지정"}</span>
            {sourceItem.url && <a href={sourceItem.url} target="_blank" rel="noreferrer">원본 링크</a>}
          </div>

          <div className={`preflight-box ${validation.ready ? "ready" : "warning"}`} id="section-check">
            <strong>{validation.ready ? "등록 필수값 입력 완료" : "실등록 전 보완 필요"}</strong>
            <span>
              {validation.ready
                ? readyMessage
                : `누락 항목: ${missingLabels.join(", ")}`}
            </span>
            {Boolean(validation.warnings?.length) && (
              <ul>
                {validation.warnings?.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}
          </div>

          <div className="publish-form-grid">
            <div className="wide form-section-title" id="section-basic">
              <strong>기본정보</strong>
              <span>스마트스토어 상품등록 첫 영역과 맞춘 공통 필드입니다.</span>
            </div>
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
            <label className="category-field">
              <span>카테고리 ID</span>
              <div className="category-input-row">
                <input className="input" value={form.categoryId} onChange={(event) => update("categoryId", event.target.value)} placeholder="네이버 리프 카테고리 ID" />
                <button className="btn" type="button" onClick={loadCategoryCandidates} disabled={categoryLoading || !form.title.trim()}>
                  {categoryLoading ? "조회 중" : "카테고리 추천"}
                </button>
              </div>
              {categoryCandidates.length > 0 && (
                <select
                  className="category-candidate-select"
                  value={categoryCandidates.some((item) => item.id === form.categoryId) ? form.categoryId : ""}
                  onChange={(event) => update("categoryId", event.target.value)}
                >
                  <option value="">최종 카테고리를 선택하세요</option>
                  {categoryCandidates.map((item) => <option key={item.id} value={item.id}>{item.path} ({item.id})</option>)}
                </select>
              )}
              {categoryError && <small className="field-error">{categoryError}</small>}
            </label>
            <label className="wide">
              <span>상품명</span>
              <input className="input" value={form.title} onChange={(event) => update("title", event.target.value)} />
            </label>
            <label>
              <span>판매가</span>
              <input className="input" type="number" min="0" step="1000" value={form.salePrice} onChange={(event) => update("salePrice", Number(event.target.value))} />
            </label>
            <label>
              <span>노출가</span>
              <input className="input" type="number" value={form.displayPrice} onChange={(event) => update("displayPrice", Number(event.target.value))} />
            </label>
            <label>
              <span>재고</span>
              <input className="input" type="number" value={form.stockQuantity} onChange={(event) => update("stockQuantity", Number(event.target.value))} />
            </label>
            <label>
              <span>옵션명</span>
              <input className="input" value={form.optionName} onChange={(event) => update("optionName", event.target.value)} placeholder="예: 기본옵션" />
            </label>
            <div className="wide form-section-title" id="section-attributes">
              <strong>상품속성</strong>
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
              <input
                className="input"
                value={form.originAreaName}
                onChange={(event) => update("originAreaName", event.target.value)}
                placeholder={form.originAreaCode === "04" ? "원산지를 직접 입력" : "선택한 코드의 참고 설명"}
              />
            </label>
            <label>
              <span>원산지 코드</span>
              <select value={form.originAreaCode} onChange={(event) => update("originAreaCode", event.target.value)}>
                <option value="">선택</option>
                <option value="00">00 · 국산</option>
                <option value="01">01 · 원양산</option>
                <option value="02">02 · 수입산</option>
                <option value="03">03 · 기타(상세설명 표시)</option>
                <option value="04">04 · 기타(직접 입력)</option>
                <option value="05">05 · 원산지 표기 의무 대상 아님</option>
              </select>
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
            <div className="wide form-section-title" id="section-delivery">
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
              <span>배송비</span>
              <input className="input" type="number" value={form.shippingFee} onChange={(event) => update("shippingFee", Number(event.target.value))} />
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
            <label className="wide">
              <span>A/S 안내</span>
              <input className="input" value={form.asGuideContent} onChange={(event) => update("asGuideContent", event.target.value)} placeholder="예: 구매처 고객센터로 문의" />
            </label>
            <div className="wide form-section-title" id="section-images">
              <strong>이미지</strong>
              <span>대표 이미지는 1장입니다. 추가/상세 이미지는 등록 대시보드의 이미지 관리에서 구성합니다.</span>
            </div>
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
            <div className="wide form-section-title" id="section-detail">
              <strong>상세페이지</strong>
              <span>상품 설명과 상세 이미지 묶음으로 네이버 detailContent를 생성합니다.</span>
            </div>
            <label className="wide">
              <span>상세설명</span>
              <textarea value={form.description} onChange={(event) => update("description", event.target.value)} />
            </label>
          </div>
        </div>
      </div>

      <div className="draft-actions">
        <button className="btn" onClick={onCancel}>취소</button>
        {extraActions}
        <button className="btn primary" onClick={onApprove} disabled={!smartstoreActive || !form.title.trim()}>
          {submitLabel}
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
  registeredPrice: number;
  salePrice: number;
  displayPrice: number;
  shippingFee: number;
  url: string;
  collectedAt: string;
  source: "price" | "smartstore";
  status?: PriceItem["status"];
  isExcluded?: number;
  exclusionReason?: string;
  extractionMethods: string[];
  benefitStatus: NonNullable<PriceItem["benefit_status"]>;
  couponPrice: number;
  eventPrice: number;
  cardPrice: number;
  benefitPrice: number;
  benefitShipping: number;
  benefitSummary: string;
  benefitCondition: string;
  detailMethods: string[];
};

const EXTRACTION_METHOD_META: Record<string, { icon: string; label: string }> = {
  crawl: { icon: "(c)", label: "크롤링" },
  playwright: { icon: "(p)", label: "Playwright" },
  scrapling: { icon: "(s)", label: "Scrapling" },
  browser: { icon: "(b)", label: "사용자 브라우저" },
};

function extractionMethods(item: PriceItem): string[] {
  if (item.extraction_methods?.length) return item.extraction_methods;
  if (item.source === "naver") return ["crawl"];
  if (item.source === "danawa" || item.source === "enuri" || item.source === "coupang") return ["crawl"];
  return [];
}

function ExtractionMethodBadges({ methods }: { methods: string[] }) {
  return (
    <span className="extraction-methods" aria-label={`추출방식 ${methods.map((method) => EXTRACTION_METHOD_META[method]?.label || method).join(", ")}`}>
      {methods.map((method) => {
        const meta = EXTRACTION_METHOD_META[method] || { icon: `(${method.slice(0, 1)})`, label: method };
        return <span className={`extraction-method-badge method-${method}`} title={meta.label} key={method}>{meta.icon}</span>;
      })}
    </span>
  );
}

function PriceLineOverview({ items, onPointClick }: { items: PriceItem[]; onPointClick: (source: string, itemId: string) => void }) {
  type PointPickerOption = {
    groupKey: ComparisonPlatform;
    groupLabel: string;
    color: string;
    itemId: string;
    mall: string;
    total: number;
    rank: number;
    x: number;
    y: number;
  };
  const [expanded, setExpanded] = useState(false);
  const [yScaleLevel, setYScaleLevel] = useState(0);
  const [pointPicker, setPointPicker] = useState<{ x: number; y: number; options: PointPickerOption[] } | null>(null);
  const yScaleActive = yScaleLevel > 0;
  const yScaleGap = CHART_POINT_SCALE_GAPS[yScaleLevel] || 0;
  const sourceGroups = comparisonPlatformOptions.map((source) => {
    const rows = items
      .filter((item) => item.source === source.key && !item.is_excluded && item.status !== "abnormal" && item.total > 0)
      .sort((a, b) => a.total - b.total || a.price - b.price || a.name.localeCompare(b.name, "ko"))
      .slice(0, 10);
    const prices = rows.map((item) => item.total);
    const minPrice = prices.length ? Math.min(...prices) : 0;
    const maxPrice = prices.length ? Math.max(...prices) : 0;
    return { ...source, rows, color: comparisonPlatformColors[source.key], minPrice, maxPrice };
  });
  const axisPrices = sourceGroups.flatMap((group) => group.rows.map((item) => item.total));
  const axisMinPrice = axisPrices.length ? Math.min(...axisPrices) : 0;
  const axisMaxPrice = axisPrices.length ? Math.max(...axisPrices) : 0;
  const groups = sourceGroups.map((group) => {
    const points = group.rows.map((item, index) => {
      const x = group.rows.length === 1 ? 50 : (index / (group.rows.length - 1)) * 100;
      const y = axisMaxPrice === axisMinPrice ? 50 : 88 - ((item.total - axisMinPrice) / (axisMaxPrice - axisMinPrice)) * 76;
      return {
        item,
        index,
        x: Math.min(Math.max(x, 0), 100),
        y: Math.min(Math.max(y, 12), 88),
      };
    });
    const linePoints = points.map((point) => `${point.x},${point.y}`).join(" ");
    return { ...group, points, linePoints, axisMinPrice, axisMaxPrice };
  });
  const combinedPointOptions: PointPickerOption[] = groups.flatMap((group) => (
    group.points.map((point) => ({
      groupKey: group.key,
      groupLabel: group.label,
      color: group.color,
      itemId: point.item.id,
      mall: point.item.mall,
      total: point.item.total,
      rank: point.index + 1,
      x: point.x,
      y: point.y,
    }))
  ));
  const combinedPointClusters = combinedPointOptions.reduce<PointPickerOption[][]>((clusters, option) => {
    const cluster = clusters.find((candidate) => (
      candidate.some((existing) => (
        Math.abs(existing.x - option.x) <= CHART_POINT_OVERLAP_X_TOLERANCE
        && Math.abs(existing.y - option.y) <= CHART_POINT_OVERLAP_Y_TOLERANCE
      ))
    ));
    if (cluster) {
      cluster.push(option);
    } else {
      clusters.push([option]);
    }
    return clusters;
  }, []).map((options) => options.sort((a, b) => a.rank - b.rank || a.groupLabel.localeCompare(b.groupLabel, "ko") || a.mall.localeCompare(b.mall, "ko")));
  const scaledCombinedPointOptions = combinedPointClusters.flatMap((cluster) => {
    if (cluster.length <= 1) return cluster;
    const sortedCluster = [...cluster].sort((a, b) => b.total - a.total || a.rank - b.rank || a.groupLabel.localeCompare(b.groupLabel, "ko"));
    const centerIndex = (sortedCluster.length - 1) / 2;
    const clusterCenterY = sortedCluster.reduce((sum, option) => sum + option.y, 0) / sortedCluster.length;
    const safeCenterY = Math.min(Math.max(clusterCenterY, 12 + centerIndex * yScaleGap), 88 - centerIndex * yScaleGap);
    return sortedCluster.map((option, index) => ({
      ...option,
      y: safeCenterY + (index - centerIndex) * yScaleGap,
    }));
  });
  const scaledOptionById = new Map(scaledCombinedPointOptions.map((option) => [`${option.groupKey}-${option.itemId}`, option]));
  const scaledOverlayLineGroups = groups.map((group) => {
    const linePoints = group.points.map((point) => {
      const scaledOption = scaledOptionById.get(`${group.key}-${point.item.id}`);
      return `${point.x},${scaledOption?.y ?? point.y}`;
    }).join(" ");
    return { ...group, linePoints };
  });
  const hasRows = groups.some((group) => group.rows.length > 0);
  if (!hasRows) {
    return (
      <div className="price-line-overview empty">
        <span>검색 후 {comparisonPlatformLabelText} 가격대 그래프가 표시됩니다.</span>
      </div>
    );
  }
  const renderGraphLines = (targetGroups: typeof groups) => (
    <svg className="price-source-line-graph" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line className="price-source-grid-line" x1="0" y1="12" x2="100" y2="12" />
      <line className="price-source-grid-line" x1="0" y1="50" x2="100" y2="50" />
      <line className="price-source-grid-line" x1="0" y1="88" x2="100" y2="88" />
      {targetGroups.map((group) => (
        group.points.length > 1 && (
          <polyline
            className="price-source-polyline"
            key={group.key}
            points={group.linePoints}
            style={{ stroke: group.color }}
          />
        )
      ))}
    </svg>
  );
  const segmentedPointBackground = (options: PointPickerOption[]) => {
    if (options.length <= 1) return options[0]?.color || "var(--brand)";
    const segmentSize = 100 / options.length;
    return `conic-gradient(${options.map((option, index) => `${option.color} ${index * segmentSize}% ${(index + 1) * segmentSize}%`).join(", ")})`;
  };
  const renderGraphPoint = (group: (typeof groups)[number], point: (typeof groups)[number]["points"][number]) => (
    <button
      className={`price-source-point source-${group.key} ${point.index === 0 ? "lowest" : ""}`}
      key={`${group.key}-${point.item.id}`}
      style={{ left: `${point.x}%`, top: `${point.y}%`, backgroundColor: group.color }}
      onClick={() => {
        setPointPicker(null);
        onPointClick(group.key, point.item.id);
      }}
      data-hover-label={money(point.item.total)}
      title={`${group.label} ${point.index + 1}위 ${point.item.mall} ${money(point.item.total)}`}
      aria-label={`${group.label} ${point.index + 1}위 ${point.item.mall} ${money(point.item.total)} 행으로 이동`}
    >
      <span>{point.index + 1}</span>
    </button>
  );
  const renderCombinedPointCluster = (options: PointPickerOption[]) => {
    const representative = options[0];
    const hasOverlap = options.length > 1;
    const rankText = new Set(options.map((option) => option.rank)).size === 1 ? String(representative.rank) : String(options.length);
    return (
      <button
        className={`price-source-point combined-point ${hasOverlap ? "has-overlap" : `source-${representative.groupKey}`}`}
        key={options.map((option) => `${option.groupKey}-${option.itemId}`).join("-")}
        style={{ left: `${representative.x}%`, top: `${representative.y}%`, background: segmentedPointBackground(options) }}
        onMouseEnter={() => {
          if (hasOverlap) setPointPicker({ x: representative.x, y: representative.y, options });
        }}
        onFocus={() => {
          if (hasOverlap) setPointPicker({ x: representative.x, y: representative.y, options });
        }}
        onClick={() => {
          if (hasOverlap) {
            setPointPicker({ x: representative.x, y: representative.y, options });
            return;
          }
          setPointPicker(null);
          onPointClick(representative.groupKey, representative.itemId);
        }}
        data-hover-label={hasOverlap ? `${options.length}개 겹침` : money(representative.total)}
        title={hasOverlap ? options.map((option) => `${option.groupLabel} ${option.rank}위 ${option.mall} ${money(option.total)}`).join(" / ") : `${representative.groupLabel} ${representative.rank}위 ${representative.mall} ${money(representative.total)}`}
        aria-label={hasOverlap ? `겹친 항목 ${options.length}개 선택` : `${representative.groupLabel} ${representative.rank}위 ${representative.mall} ${money(representative.total)} 행으로 이동`}
      >
        <span>{rankText}</span>
      </button>
    );
  };
  const renderScaledCombinedPoint = (option: PointPickerOption) => (
    <button
      className={`price-source-point combined-point source-${option.groupKey}`}
      key={`${option.groupKey}-${option.itemId}`}
      style={{ left: `${option.x}%`, top: `${option.y}%`, backgroundColor: option.color }}
      onClick={() => {
        setPointPicker(null);
        onPointClick(option.groupKey, option.itemId);
      }}
      data-hover-label={money(option.total)}
      title={`${option.groupLabel} ${option.rank}위 ${option.mall} ${money(option.total)}`}
      aria-label={`${option.groupLabel} ${option.rank}위 ${option.mall} ${money(option.total)} 행으로 이동`}
    >
      <span>{option.rank}</span>
    </button>
  );
  const renderSourceChart = (group: (typeof groups)[number]) => (
    <section className="price-source-chart" key={group.key}>
      <div className="price-source-chart-head">
        <strong>{group.label}</strong>
        <span>{group.rows.length}개</span>
      </div>
      {group.rows.length > 0 ? (
        <>
          <div className="price-source-range">
            <span>축 최저 {money(group.axisMinPrice)}</span>
            <span>축 최고 {money(group.axisMaxPrice)}</span>
          </div>
          <div className="price-source-plot" role="group" aria-label={`${group.label} 순위별 가격 꺾은선 그래프`}>
            {renderGraphLines([group])}
            {group.points.map((point) => renderGraphPoint(group, point))}
          </div>
          <button className="price-source-lowest" onClick={() => onPointClick(group.key, group.rows[0].id)}>
            최저 {group.rows[0].mall} · {money(group.rows[0].total)}
          </button>
        </>
      ) : (
        <div className="price-source-empty">정상 후보 없음</div>
      )}
    </section>
  );
  return (
    <div className={`price-line-overview ${expanded ? "expanded" : "overlay"} ${!expanded ? `y-scale-level-${yScaleLevel}` : ""}`} aria-label="소스별 최저가 가격대 그래프">
      <div className="price-line-overview-head">
        <div>
          <strong>{expanded ? "소스별 가격대 그래프" : "전체 가격대 겹쳐보기"}</strong>
          <span>{comparisonPlatformLabelText} TOP 10 / 공통 Y축{!expanded && yScaleActive ? ` / Y축 ${yScaleLevel + 1}단계` : ""}</span>
        </div>
        <div className="price-line-overview-actions">
          <button className="price-line-overview-toggle" onClick={() => {
            setPointPicker(null);
            setExpanded((value) => !value);
          }}>
            {expanded ? "겹쳐보기" : "펼쳐보기 모드"}
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="price-line-overview-grid">
          {groups.map((group) => renderSourceChart(group))}
        </div>
      ) : (
        <section className="price-source-chart price-source-chart-combined">
          <div className="price-source-range">
            <span>축 최저 {money(axisMinPrice)}</span>
            <span>축 최고 {money(axisMaxPrice)}</span>
          </div>
          <div className="price-source-plot price-source-plot-combined" role="group" aria-label={`${comparisonPlatformLabelText} 통합 가격 꺾은선 그래프`}>
            {renderGraphLines(yScaleActive ? scaledOverlayLineGroups : groups)}
            {yScaleActive
              ? scaledCombinedPointOptions.map((option) => renderScaledCombinedPoint(option))
              : combinedPointClusters.map((cluster) => renderCombinedPointCluster(cluster))}
            {pointPicker && (
              <div className="price-point-picker" style={{ left: `${pointPicker.x}%`, top: `${pointPicker.y}%` }}>
                <div className="price-point-picker-head">
                  <strong>{pointPicker.options.length > 1 ? `겹친 항목 ${pointPicker.options.length}개` : money(pointPicker.options[0]?.total || 0)}</strong>
                  <button onClick={() => setPointPicker(null)} aria-label="겹친 항목 선택 닫기">×</button>
                </div>
                <div className="price-point-picker-list">
                  {pointPicker.options.map((option) => (
                    <button
                      key={`${option.groupKey}-${option.itemId}`}
                      onClick={() => {
                        setPointPicker(null);
                        onPointClick(option.groupKey, option.itemId);
                      }}
                    >
                      <i style={{ backgroundColor: option.color }} />
                      <span>{option.groupLabel} {option.rank}위</span>
                      <em>{option.mall}</em>
                      <b>{money(option.total)}</b>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="price-y-scale-control" aria-label="Y축 스케일 3단계 조절">
              <button
                onClick={() => {
                  setPointPicker(null);
                  setYScaleLevel((level) => Math.max(0, level - 1));
                }}
                disabled={yScaleLevel === 0}
                aria-label="Y축 스케일 축소"
              >
                −
              </button>
              <span>{yScaleLevel + 1}/3</span>
              <button
                onClick={() => {
                  setPointPicker(null);
                  setYScaleLevel((level) => Math.min(2, level + 1));
                }}
                disabled={yScaleLevel === 2}
                aria-label="Y축 스케일 확대"
              >
                +
              </button>
            </div>
          </div>
          <div className="price-source-legend">
            {groups.map((group) => (
              <span key={group.key}>
                <i style={{ backgroundColor: group.color }} />
                {group.label} {group.rows.length}개
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function compactLineProductName(rows: SearchResultRow[], keyword: string): string {
  const keywordText = normalize(keyword);
  const candidates = unique(rows.map((row) => row.name.trim()))
    .filter((name) => name && normalize(name) !== keywordText);
  const relevant = candidates.filter((name) => !keywordText || normalize(name).includes(keywordText));
  const selected = [...(relevant.length ? relevant : candidates)].sort((a, b) => {
    const aPenalty = /쿠팡|coupang|광고|보호필름|파우치|케이스/i.test(a) ? 60 : 0;
    const bPenalty = /쿠팡|coupang|광고|보호필름|파우치|케이스/i.test(b) ? 60 : 0;
    return a.length + aPenalty - (b.length + bPenalty);
  })[0] || "";
  return selected.length > 72 ? `${selected.slice(0, 72)}…` : selected;
}

function MinimalMonitorIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
      <path d="M7 12l3-3 2 2 4-4 2 2" />
    </svg>
  );
}

function MinimalSearchPriceGraph({ items }: { items: PriceItem[] }) {
  const groups = comparisonPlatformOptions.map((platform) => {
    const rows = items
      .filter((item) => item.source === platform.key && item.total > 0 && !item.is_excluded && item.status !== "abnormal")
      .sort((left, right) => left.total - right.total || left.price - right.price)
      .slice(0, 10);
    return { ...platform, rows };
  }).filter((group) => group.rows.length > 0);
  const allPrices = groups.flatMap((group) => group.rows.map((item) => item.total));
  if (allPrices.length === 0) return null;
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const chartGroups = groups.map((group) => {
    const points = group.rows.map((item, index) => ({
      item,
      x: group.rows.length === 1 ? 50 : (index / (group.rows.length - 1)) * 100,
      y: maxPrice === minPrice ? 50 : 84 - ((item.total - minPrice) / (maxPrice - minPrice)) * 68,
    }));
    return { ...group, points, linePoints: points.map((point) => `${point.x},${point.y}`).join(" ") };
  });

  return (
    <section className="minimal-search-price-graph" aria-label="검색 결과 쇼핑몰별 가격 분포 그래프">
      <div className="minimal-chart-head">
        <div><span>PRICE RANGE</span><strong>쇼핑몰별 가격 흐름</strong></div>
        <p><b>{money(minPrice)}</b><span>—</span><b>{money(maxPrice)}</b></p>
      </div>
      <div className="minimal-search-chart-plot" role="img" aria-label={`최저 ${money(minPrice)}, 최고 ${money(maxPrice)} 순위별 가격 분포`}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="16" x2="100" y2="16" />
          <line x1="0" y1="50" x2="100" y2="50" />
          <line x1="0" y1="84" x2="100" y2="84" />
          {chartGroups.map((group) => group.points.length > 1 && (
            <polyline key={group.key} points={group.linePoints} style={{ stroke: comparisonPlatformColors[group.key] }} />
          ))}
        </svg>
        {chartGroups.flatMap((group) => group.points.map((point, index) => (
          <span
            className="minimal-chart-point"
            key={`${group.key}-${point.item.id}`}
            style={{ left: `${point.x}%`, top: `${point.y}%`, backgroundColor: comparisonPlatformColors[group.key] }}
            title={`${group.label} ${index + 1}위 · ${point.item.mall} · ${money(point.item.total)}`}
          />
        )))}
        <div className="minimal-search-chart-axis"><span>1위</span><span>가격 순위</span><span>10위</span></div>
      </div>
      <div className="minimal-chart-legend">
        {chartGroups.map((group) => (
          <span key={group.key}><i style={{ backgroundColor: comparisonPlatformColors[group.key] }} />{group.label}<b>{group.rows.length}</b></span>
        ))}
      </div>
    </section>
  );
}

function MinimalPriceResults({ items, selectedSources, preparedProducts, savingId, onToggleMonitoring, onOpenMonitoring }: {
  items: PriceItem[];
  selectedSources: string[];
  preparedProducts: PreparedProduct[];
  savingId: string;
  onToggleMonitoring: (item: PriceItem) => Promise<void>;
  onOpenMonitoring: () => void;
}) {
  const monitoredCount = preparedProducts.filter((item) => Boolean(item.monitoring_enabled)).length;
  const resultSources = minimalPriceSources.filter((source) => selectedSources.includes(source));
  const [activeSource, setActiveSource] = useState(resultSources[0] || "naver");

  useEffect(() => {
    if (!resultSources.includes(activeSource)) setActiveSource(resultSources[0] || "naver");
  }, [activeSource, resultSources.join("|")]);

  const activeItems = items.filter((item) => item.source === activeSource).slice(0, 10);
  return (
    <section className="minimal-naver-results" aria-label="쇼핑몰별 가격 조사 결과">
      <MinimalSearchPriceGraph items={items} />
      <div className="minimal-results-head">
        <strong>가격 조사 결과</strong>
        <div className="minimal-results-actions">
          <span>쇼핑몰별 최대 10개 · 총 {items.length}개</span>
          <button className="minimal-monitor-nav" type="button" onClick={onOpenMonitoring} aria-label={`모니터링 페이지 열기, ${monitoredCount}개 활성`}>
            <MinimalMonitorIcon />
            <b>{monitoredCount}</b>
          </button>
        </div>
      </div>
      <div className="minimal-result-source-tabs" role="tablist" aria-label="쇼핑몰별 결과">
        {resultSources.map((source) => {
          const count = items.filter((item) => item.source === source).length;
          return (
            <button
              type="button"
              role="tab"
              key={source}
              aria-selected={activeSource === source}
              className={activeSource === source ? "is-active" : ""}
              onClick={() => setActiveSource(source)}
            >
              {sourceLabel(source)} <b>{count}</b>
            </button>
          );
        })}
      </div>
      {activeItems.length === 0 ? (
        <p className="minimal-results-empty">검색 결과 없음</p>
      ) : (
        <div className="minimal-results-table-wrap">
          <table>
            <thead>
              <tr><th>순위</th><th>상품</th><th>쇼핑몰</th><th>등록가</th><th>노출가</th><th>모니터링</th></tr>
            </thead>
            <tbody>
              {activeItems.map((item, index) => {
                const monitored = isSourceItemMonitored(item.id, preparedProducts);
                return (
                <tr className={monitored ? "is-monitored" : ""} key={item.id}>
                  <td>{index + 1}</td>
                  <td><a className="minimal-product-name" href={item.url} target="_blank" rel="noreferrer">{item.name}</a></td>
                  <td>{item.mall}</td>
                  <td className="minimal-registered-price">{money(item.registered_price || item.price)}</td>
                  <td className="minimal-exposure-price">{money(item.price)}</td>
                  <td>
                    <button
                      className={`minimal-monitor-toggle ${monitored ? "on" : ""}`}
                      type="button"
                      disabled={savingId === item.id}
                      aria-pressed={monitored}
                      onClick={() => onToggleMonitoring(item)}
                    >
                      <span />{savingId === item.id ? "저장중" : monitored ? "ON" : "OFF"}
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function MinimalProductPriceTrend({ history }: { history: ComparisonHistory }) {
  const series = comparisonPlatformOptions.map((platform) => {
    const rows = [...(history[platform.key] || [])]
      .filter((item) => item.total_price > 0 && Boolean(item.collected_at))
      .sort((left, right) => Date.parse(left.collected_at) - Date.parse(right.collected_at))
      .slice(-24);
    return { ...platform, rows };
  }).filter((group) => group.rows.length > 0);
  const allRows = series.flatMap((group) => group.rows);

  if (allRows.length === 0) {
    return (
      <section className="minimal-product-trend is-empty" aria-label="상품 가격 시간대별 추이">
        <div className="minimal-product-trend-head"><strong>시간대별 가격 추이</strong><span>갱신 기록이 쌓이면 표시됩니다.</span></div>
        <div className="minimal-product-trend-empty"><i /><span>아직 비교 가격 기록이 없습니다.</span></div>
      </section>
    );
  }

  const times = allRows.map((item) => Date.parse(item.collected_at)).filter(Number.isFinite);
  const prices = allRows.map((item) => item.total_price);
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const plottedSeries = series.map((group) => {
    const points = group.rows.map((item) => {
      const timestamp = Date.parse(item.collected_at);
      return {
        item,
        x: maxTime === minTime ? 50 : ((timestamp - minTime) / (maxTime - minTime)) * 100,
        y: maxPrice === minPrice ? 50 : 84 - ((item.total_price - minPrice) / (maxPrice - minPrice)) * 68,
      };
    });
    return { ...group, points, linePoints: points.map((point) => `${point.x},${point.y}`).join(" ") };
  });

  return (
    <section className="minimal-product-trend" aria-label="상품 가격 시간대별 추이">
      <div className="minimal-product-trend-head">
        <div><strong>시간대별 가격 추이</strong><span>최근 24회 최저가 기록</span></div>
        <p><b>{money(minPrice)}</b><span>—</span><b>{money(maxPrice)}</b></p>
      </div>
      <div className="minimal-product-trend-plot" role="img" aria-label={`시간대별 최저 ${money(minPrice)}, 최고 ${money(maxPrice)}`}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="16" x2="100" y2="16" />
          <line x1="0" y1="50" x2="100" y2="50" />
          <line x1="0" y1="84" x2="100" y2="84" />
          {plottedSeries.map((group) => group.points.length > 1 && (
            <polyline key={group.key} points={group.linePoints} style={{ stroke: comparisonPlatformColors[group.key] }} />
          ))}
        </svg>
        {plottedSeries.flatMap((group) => group.points.map((point) => (
          <span
            className="minimal-product-trend-point"
            key={`${group.key}-${point.item.id}-${point.item.collected_at}`}
            style={{ left: `${point.x}%`, top: `${point.y}%`, backgroundColor: comparisonPlatformColors[group.key] }}
            title={`${group.label} · ${money(point.item.total_price)} · ${new Date(point.item.collected_at).toLocaleString("ko-KR")}`}
          />
        )))}
        <div className="minimal-product-trend-axis"><time>{minimalMonitoringTime(minTime)}</time><time>{minimalMonitoringTime(maxTime)}</time></div>
      </div>
      <div className="minimal-product-trend-legend">
        {plottedSeries.map((group) => {
          const latest = group.rows[group.rows.length - 1];
          return <span key={group.key}><i style={{ backgroundColor: comparisonPlatformColors[group.key] }} />{group.label}<b>{money(latest.total_price)}</b></span>;
        })}
      </div>
    </section>
  );
}

function MinimalSellerPriceRow({ item, comparisonHistory, onUpdate }: {
  item: PreparedProduct;
  comparisonHistory: ComparisonHistory;
  onUpdate: (item: PreparedProduct, updates: Partial<PreparedProduct>) => Promise<void>;
}) {
  const [salePrice, setSalePrice] = useState(item.seller_sale_price || item.sale_price);
  const [displayPrice, setDisplayPrice] = useState(item.seller_display_price || item.display_price);
  const [feeRate, setFeeRate] = useState(item.fee_rate || 0);
  const [saving, setSaving] = useState(false);
  const metrics = monitoringMetrics(item, feeRate, displayPrice);

  useEffect(() => {
    setSalePrice(item.seller_sale_price || item.sale_price);
    setDisplayPrice(item.seller_display_price || item.display_price);
    setFeeRate(item.fee_rate || 0);
  }, [item.id, item.seller_sale_price, item.seller_display_price, item.fee_rate, item.sale_price, item.display_price]);

  const save = async () => {
    setSaving(true);
    try {
      await onUpdate(item, {
        monitoring_enabled: 1,
        seller_sale_price: salePrice,
        seller_display_price: displayPrice,
        fee_rate: feeRate,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="minimal-owned-product">
      <div className="minimal-owned-title">
        <span>{item.mall || sourceLabel(item.source)}</span>
        {item.source_url ? <a href={item.source_url} target="_blank" rel="noreferrer">{item.title}</a> : <strong>{item.title}</strong>}
      </div>
      <label><span>등록가</span><input type="number" min="0" step="1000" value={salePrice} onChange={(event) => setSalePrice(Number(event.target.value))} /></label>
      <label><span>판매가</span><input type="number" min="0" step="1000" value={displayPrice} onChange={(event) => setDisplayPrice(Number(event.target.value))} /></label>
      <label><span>수수료</span><div className="minimal-suffix-input"><input type="number" min="0" max="100" step="0.1" value={feeRate} onChange={(event) => setFeeRate(Number(event.target.value))} /><i>%</i></div></label>
      <div className="minimal-live-margin">
        <span>예상 마진율</span>
        <strong className={metrics.margin >= 0 ? "positive" : "negative"}>{metrics.marginRate.toFixed(1)}%</strong>
        <small>{money(metrics.margin)}</small>
      </div>
      <button className="minimal-save-price" type="button" onClick={save} disabled={saving}>{saving ? "저장중" : "저장"}</button>
      <MinimalProductPriceTrend history={comparisonHistory} />
    </article>
  );
}

type MinimalHourlyRefreshRecord = {
  key: string;
  startedAt: number;
  productCount: number;
  platforms: ComparisonPlatform[];
};

function buildMinimalHourlyRefreshRecords(
  histories: Record<string, ComparisonHistory>,
  limit = 8,
): MinimalHourlyRefreshRecord[] {
  const grouped = new Map<string, { startedAt: number; productIds: Set<string>; platforms: Set<ComparisonPlatform> }>();
  for (const [productId, history] of Object.entries(histories)) {
    for (const [platform, snapshots] of Object.entries(history) as [ComparisonPlatform, CompetitorSnapshot[]][]) {
      for (const snapshot of snapshots || []) {
        const startedAt = Date.parse(snapshot.collected_at || "");
        if (!Number.isFinite(startedAt)) continue;
        const date = new Date(startedAt);
        const key = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, "0"),
          String(date.getDate()).padStart(2, "0"),
          String(date.getHours()).padStart(2, "0"),
        ].join("-");
        const record = grouped.get(key) || { startedAt, productIds: new Set<string>(), platforms: new Set<ComparisonPlatform>() };
        record.startedAt = Math.max(record.startedAt, startedAt);
        record.productIds.add(productId);
        record.platforms.add(platform);
        grouped.set(key, record);
      }
    }
  }
  return Array.from(grouped.entries())
    .map(([key, record]) => ({
      key,
      startedAt: record.startedAt,
      productCount: record.productIds.size,
      platforms: Array.from(record.platforms),
    }))
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, limit);
}

function minimalMonitoringTime(value: string | number | null | undefined): string {
  const timestamp = typeof value === "number" ? value : Date.parse(value || "");
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "기록 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function minimalRemainingTime(now: number, target: number): string {
  if (!target || target <= now) return "지금 갱신 예정";
  const remainingMinutes = Math.max(1, Math.ceil((target - now) / 60_000));
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (hours === 0) return `${minutes}분 후`;
  if (minutes === 0) return `${hours}시간 후`;
  return `${hours}시간 ${minutes}분 후`;
}

function MinimalMonitoringView({
  products,
  comparisonHistories,
  refreshHours,
  autoRefresh,
  lastRunAt,
  now,
  refreshing,
  onBack,
  onUpdate,
  onRefresh,
  onRefreshHoursChange,
  onAutoRefreshChange,
}: {
  products: PreparedProduct[];
  comparisonHistories: Record<string, ComparisonHistory>;
  refreshHours: number;
  autoRefresh: boolean;
  lastRunAt: number;
  now: number;
  refreshing: boolean;
  onBack: () => void;
  onUpdate: (item: PreparedProduct, updates: Partial<PreparedProduct>) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRefreshHoursChange: (hours: number) => void;
  onAutoRefreshChange: (enabled: boolean) => void;
}) {
  const latestProductScanAt = Math.max(
    0,
    ...products.map((item) => Date.parse(item.last_competitor_scanned_at || "") || 0),
  );
  const scheduleAnchor = Math.max(lastRunAt, latestProductScanAt);
  const nextRefreshAt = nextMonitoringRefreshAt(scheduleAnchor, refreshHours);
  const hourlyRecords = buildMinimalHourlyRefreshRecords(comparisonHistories);
  const nextRefreshLabel = autoRefresh
    ? minimalRemainingTime(now, nextRefreshAt)
    : "자동 갱신 꺼짐";

  return (
    <div className="minimal-monitoring-page">
      <header className="minimal-monitoring-header">
        <button type="button" onClick={onBack} aria-label="검색 결과로 돌아가기">←</button>
        <div className="minimal-monitoring-title"><span>PriceScan</span><strong>모니터링</strong></div>
        <div className="minimal-monitoring-header-status">
          <div className="minimal-next-refresh"><span>다음 갱신</span><strong>{nextRefreshLabel}</strong></div>
          <em>{products.length} ON</em>
        </div>
      </header>

      <div className="minimal-monitoring-content">
        <section className="minimal-refresh-panel" aria-labelledby="minimal-refresh-title">
          <div className="minimal-refresh-controls">
            <div className="minimal-refresh-copy">
              <strong id="minimal-refresh-title">모니터링 상품만 재검색</strong>
              <span>ON 상품만 다시 확인합니다. 자동 갱신은 이 화면이 열려 있을 때 동작합니다.</span>
            </div>
            <label>
              <span>갱신 주기</span>
              <select value={refreshHours} onChange={(event) => onRefreshHoursChange(Number(event.target.value))} disabled={refreshing}>
                {monitoringRefreshHourOptions.map((hours) => <option key={hours} value={hours}>{hours}시간마다{hours === 6 ? " (권장)" : ""}</option>)}
              </select>
            </label>
            <button
              className={`minimal-auto-refresh ${autoRefresh ? "is-on" : ""}`}
              type="button"
              aria-pressed={autoRefresh}
              disabled={refreshing}
              onClick={() => onAutoRefreshChange(!autoRefresh)}
            >
              <span />자동 {autoRefresh ? "ON" : "OFF"}
            </button>
            <button className="minimal-refresh-now" type="button" disabled={refreshing || products.length === 0} onClick={onRefresh}>
              {refreshing ? <><span className="minimal-search-button-spinner" />갱신 중</> : "지금 갱신"}
            </button>
          </div>

          <div className="minimal-hourly-records">
            <div className="minimal-hourly-records-head">
              <strong>시간별 갱신 기록</strong>
              <span>최근 갱신 {minimalMonitoringTime(Math.max(lastRunAt, latestProductScanAt))}</span>
            </div>
            <div className="minimal-hourly-record-list">
              {hourlyRecords.map((record) => (
                <article key={record.key}>
                  <time dateTime={new Date(record.startedAt).toISOString()}>{minimalMonitoringTime(record.startedAt)}</time>
                  <span>{record.productCount}개 상품</span>
                  <small>{record.platforms.map(sourceLabel).join(" · ")}</small>
                </article>
              ))}
              {hourlyRecords.length === 0 && <p>첫 갱신 후 시간대별 기록이 표시됩니다.</p>}
            </div>
          </div>
        </section>

        <section className="minimal-owned-section" aria-labelledby="minimal-owned-title">
          <div className="minimal-monitoring-section-head">
            <div><strong id="minimal-owned-title">내가 팔고 있는 상품</strong><span>가격을 바꾸면 마진율이 바로 계산됩니다.</span></div>
          </div>
          <div className="minimal-owned-list">
            {products.map((item) => (
              <MinimalSellerPriceRow
                key={item.id}
                item={item}
                comparisonHistory={comparisonHistories[item.id] || ({} as ComparisonHistory)}
                onUpdate={onUpdate}
              />
            ))}
            {products.length === 0 && <p className="minimal-monitoring-empty">검색 결과에서 모니터링을 ON 해주세요.</p>}
          </div>
        </section>

        <section className="minimal-watched-section" aria-labelledby="minimal-watched-title">
          <div className="minimal-monitoring-section-head">
            <div><strong id="minimal-watched-title">모니터링 상품</strong><span>각 쇼핑몰의 조사 가격을 한 줄씩 비교합니다.</span></div>
            <b>{products.length}</b>
          </div>
          <div className="minimal-watched-table-wrap">
            <table>
              <thead><tr><th>상품</th><th>쇼핑몰</th><th>등록가</th><th>노출가</th><th>배송비</th><th>최근 갱신</th><th>상태</th></tr></thead>
              <tbody>
                {products.map((item) => (
                  <tr key={item.id}>
                    <td>{item.source_url ? <a href={item.source_url} target="_blank" rel="noreferrer">{item.title}</a> : item.title}</td>
                    <td>{item.mall || sourceLabel(item.source)}</td>
                    <td>{money(item.sale_price)}</td>
                    <td><strong>{money(item.display_price)}</strong></td>
                    <td>{item.shipping_fee ? money(item.shipping_fee) : "무료"}</td>
                    <td>{minimalMonitoringTime(item.last_competitor_scanned_at)}</td>
                    <td><button className="minimal-monitor-toggle on" type="button" aria-pressed="true" onClick={() => onUpdate(item, { monitoring_enabled: 0 })}><span />ON</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {products.length === 0 && <p className="minimal-monitoring-empty">모니터링 중인 상품이 없습니다.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}

function sortResultRows(rows: SearchResultRow[], sortMode: string, lowestTotal: number): SearchResultRow[] {
  const sorted = [...rows];
  const exclusionWeight = (row: SearchResultRow) => (row.isExcluded || row.status === "abnormal" ? 1 : 0);
  if (sortMode === "margin") {
    return sorted.sort((a, b) => {
      const aPrice = effectivePurchasePrice(a);
      const bPrice = effectivePurchasePrice(b);
      const aMargin = lowestTotal ? aPrice - lowestTotal : 0;
      const bMargin = lowestTotal ? bPrice - lowestTotal : 0;
      return exclusionWeight(a) - exclusionWeight(b) || bMargin - aMargin || aPrice - bPrice || a.name.localeCompare(b.name, "ko");
    });
  }
  if (sortMode === "recent") {
    return sorted.sort((a, b) => exclusionWeight(a) - exclusionWeight(b) || b.collectedAt.localeCompare(a.collectedAt) || effectivePurchasePrice(a) - effectivePurchasePrice(b) || a.name.localeCompare(b.name, "ko"));
  }
  return sorted.sort((a, b) => exclusionWeight(a) - exclusionWeight(b) || effectivePurchasePrice(a) - effectivePurchasePrice(b) || a.salePrice - b.salePrice || a.name.localeCompare(b.name, "ko"));
}

function effectivePurchasePrice(row: SearchResultRow): number {
  if (row.benefitPrice > 0) {
    return row.registeredPrice || row.benefitPrice;
  }
  return row.salePrice;
}

function benefitStatusLabel(status: SearchResultRow["benefitStatus"]): string {
  return {
    not_checked: "미조사",
    confirmed: "확인",
    conditional: "조건부",
    none: "혜택 없음",
    failed: "확인 실패",
  }[status];
}

function SearchResultList({
  payload,
  keyword,
  sortMode,
  view,
  preparedProducts,
  onExclude,
  onPrepare,
  selectedBenefitIds,
  benefitScanning,
  onBenefitSelectionChange,
  onBenefitScan,
}: {
  payload: SearchPayload;
  keyword: string;
  sortMode: string;
  view: "line" | "active" | "excluded";
  preparedProducts: PreparedProduct[];
  onExclude: (id: string) => void;
  onPrepare: (item: DraftSourceItem) => void;
  selectedBenefitIds: string[];
  benefitScanning: boolean;
  onBenefitSelectionChange: (ids: string[]) => void;
  onBenefitScan: (ids: string[]) => void;
}) {
  const priceRows: SearchResultRow[] = payload.items.map((item) => ({
    id: item.id,
    sourceItemId: item.id,
    collectionSource: item.source,
    name: item.name,
    mall: item.mall,
    registeredPrice: item.registered_price || item.price,
    salePrice: item.price,
    displayPrice: item.total,
    shippingFee: item.shipping,
    url: item.url,
    collectedAt: item.collected_at,
    source: "price",
    status: item.status,
    isExcluded: item.is_excluded,
    exclusionReason: item.exclusion_reason,
    extractionMethods: extractionMethods(item),
    benefitStatus: item.benefit_status || "not_checked",
    couponPrice: item.coupon_price || 0,
    eventPrice: item.event_price || 0,
    cardPrice: item.card_price || 0,
    benefitPrice: item.benefit_price || 0,
    benefitShipping: item.benefit_shipping ?? item.shipping,
    benefitSummary: item.benefit_summary || "",
    benefitCondition: item.benefit_condition || "",
    detailMethods: item.detail_methods || [],
  }));
  const activeRows = priceRows.filter((row) => !row.isExcluded && row.status !== "abnormal");
  const excludedRows = priceRows.filter((row) => Boolean(row.isExcluded) || row.status === "abnormal");
  const positivePrices = activeRows.map(effectivePurchasePrice).filter((value) => value > 0);
  const lowestTotal = positivePrices.length ? Math.min(...positivePrices) : 0;
  const rows = sortResultRows(view === "excluded" ? excludedRows : activeRows, sortMode, lowestTotal);
  const lineGroups = comparisonPlatformOptions.map((source) => ({
    ...source,
    rows: sortResultRows(priceRows.filter((row) => row.collectionSource === source.key), "lowest", lowestTotal).slice(0, 10),
  }));
  const lineProductName = compactLineProductName(activeRows, keyword);
  const lowestRows = lowestTotal ? sortResultRows(rows.filter((row) => effectivePurchasePrice(row) === lowestTotal), "lowest", lowestTotal) : [];
  const comparisonRows = lowestTotal ? sortResultRows(rows.filter((row) => effectivePurchasePrice(row) !== lowestTotal), sortMode, lowestTotal) : rows;
  const preparedSourceIds = new Set(preparedProducts.map((item) => item.source_item_id).filter(Boolean));
  const lineSelectableIds = lineGroups.flatMap((group) => group.rows.map((row) => row.id)).slice(0, 10);
  const tableSelectableIds = rows.slice(0, 10).map((row) => row.id);
  const selectableIds = view === "line" ? lineSelectableIds : tableSelectableIds;
  const selectedSet = new Set(selectedBenefitIds);
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedSet.has(id));

  const toggleBenefitSelection = (id: string) => {
    if (!selectedSet.has(id) && selectedBenefitIds.length >= 10) return;
    onBenefitSelectionChange(selectedSet.has(id)
      ? selectedBenefitIds.filter((selectedId) => selectedId !== id)
      : [...selectedBenefitIds, id]);
  };

  const renderResultRow = (row: SearchResultRow, isLowest: boolean) => {
    const finalPurchasePrice = effectivePurchasePrice(row);
    const margin = lowestTotal ? finalPurchasePrice - lowestTotal : 0;
    const compareRate = lowestTotal ? (margin / lowestTotal) * 100 : 0;
    const marginRate = finalPurchasePrice ? (margin / finalPurchasePrice) * 100 : 0;
    const isPrepared = preparedSourceIds.has(row.sourceItemId);
    return (
      <tr className={`${isLowest ? "lowest-row" : ""} ${isPrepared ? "registered-row" : ""}`} key={row.id}>
        <td className="result-select-cell">
          <input
            type="checkbox"
            checked={selectedSet.has(row.id)}
            disabled={!selectedSet.has(row.id) && selectedBenefitIds.length >= 10}
            onChange={() => toggleBenefitSelection(row.id)}
            aria-label={`${row.name} 혜택 상세조사 선택`}
          />
        </td>
        <td><span className="result-product-type">{inferProductType(row.name)}</span></td>
        <td className="model-cell"><a className="result-model" href={row.url} target="_blank" rel="noreferrer">{row.name}</a></td>
        <td><span className="source-chip">{sourceLabel(row.collectionSource)}</span></td>
        <td><ExtractionMethodBadges methods={row.extractionMethods} /></td>
        <td>{row.mall}</td>
        <td className="number-cell">{money(row.registeredPrice || row.salePrice)}</td>
        <td className={`number-cell ${isLowest ? "lowest-price-cell" : ""}`}>{money(row.salePrice)}</td>
        <td className="number-cell">{percent(compareRate)}</td>
        <td className="number-cell">{percent(marginRate)}</td>
        <td>
          <span className={`benefit-status benefit-${row.benefitStatus}`}>{benefitStatusLabel(row.benefitStatus)}</span>
          {row.detailMethods.length > 0 && <ExtractionMethodBadges methods={row.detailMethods} />}
          {row.benefitSummary && <small className="benefit-summary">{row.benefitSummary}</small>}
          {row.benefitCondition && <small className="benefit-condition" title={row.benefitCondition}>{row.benefitCondition}</small>}
        </td>
        <td>
          {view === "excluded"
            ? <span className="exclusion-reason">{row.exclusionReason || (row.status === "abnormal" ? "가격 이상치" : "제외됨")}</span>
            : isLowest ? <span className="pill orange">최저가</span> : <span className="pill blue">비교대상</span>}
        </td>
        <td>
          <span className="result-actions">
            <button className="btn small danger" onClick={() => onExclude(row.id)}>{row.isExcluded ? "복구" : "제외"}</button>
            {view === "active" && (
              <button className={`btn small ${isPrepared ? "monitor-registered" : "orange"}`} disabled={isPrepared} onClick={() => onPrepare({
              sourceItemId: row.sourceItemId,
              source: row.collectionSource,
              mall: row.mall,
              name: row.name,
              salePrice: row.registeredPrice,
              displayPrice: row.salePrice,
              shippingFee: row.shippingFee,
              url: row.url,
              })}>{isPrepared ? "모니터등록" : "모니터링 등록"}</button>
            )}
          </span>
        </td>
      </tr>
    );
  };

  const renderBenefitInfo = (row: SearchResultRow) => (
    <>
      <span className={`benefit-status benefit-${row.benefitStatus}`}>{benefitStatusLabel(row.benefitStatus)}</span>
      {row.detailMethods.length > 0 && <ExtractionMethodBadges methods={row.detailMethods} />}
      {row.benefitSummary && <small className="benefit-summary">{row.benefitSummary}</small>}
      {row.benefitCondition && <small className="benefit-condition" title={row.benefitCondition}>{row.benefitCondition}</small>}
    </>
  );

  const renderLineRow = (row: SearchResultRow, rank: number) => {
    const isPrepared = preparedSourceIds.has(row.sourceItemId);
    const lineExcluded = Boolean(row.isExcluded) || row.status === "abnormal";
    const mallLabel = (() => {
      const mall = row.mall.trim();
      const normalizedMall = normalize(mall);
      const normalizedName = normalize(row.name);
      const normalizedKeyword = normalize(keyword);
      const mallLooksLikeProductName = (
        !mall
        || mall === "판매처"
        || (normalizedKeyword && normalizedMall.includes(normalizedKeyword))
        || (mall.length > 14 && (normalizedName.includes(normalizedMall) || normalizedMall.includes(normalizedName)))
      );
      if (!mallLooksLikeProductName) return mall;
      if (/쿠팡|coupang/i.test(`${mall} ${row.name} ${row.url}`)) return "쿠팡";
      if (/11st|11번가/i.test(`${mall} ${row.name} ${row.url}`)) return "11번가";
      if (/gmarket|g마켓/i.test(`${mall} ${row.name} ${row.url}`)) return "G마켓";
      if (/auction|옥션/i.test(`${mall} ${row.name} ${row.url}`)) return "옥션";
      if (row.url.includes("smartstore.naver.com")) return "스마트스토어";
      return sourceLabel(row.collectionSource);
    })();
    return (
      <tr id={`line-row-${row.collectionSource}-${row.id}`} key={row.id} className={`${isPrepared ? "registered-row" : ""} ${lineExcluded ? "line-excluded-row" : ""}`}>
        <td className="result-select-cell">
          <input
            type="checkbox"
            checked={selectedSet.has(row.id)}
            disabled={!selectedSet.has(row.id) && selectedBenefitIds.length >= 10}
            onChange={() => toggleBenefitSelection(row.id)}
            aria-label={`${row.mall} ${rank}위 상세스캔 선택`}
          />
        </td>
        <td className="number-cell">{rank}</td>
        <td>
          {mallLabel}
          {lineExcluded && <small className="line-exclusion-reason">{row.exclusionReason || (row.status === "abnormal" ? "가격 이상치" : "제외됨")}</small>}
        </td>
        <td className="number-cell">{money(row.registeredPrice || row.salePrice)}</td>
        <td className="number-cell">{money(row.salePrice)}</td>
        <td>{renderBenefitInfo(row)}</td>
        <td><a href={row.url} target="_blank" rel="noreferrer">link</a></td>
        <td>
          <button className={`btn small ${isPrepared ? "monitor-registered" : "orange"}`} disabled={isPrepared} onClick={() => onPrepare({
            sourceItemId: row.sourceItemId,
            source: row.collectionSource,
            mall: row.mall,
            name: row.name,
            salePrice: row.registeredPrice,
            displayPrice: row.salePrice,
            shippingFee: row.shippingFee,
            url: row.url,
          })}>{isPrepared ? "등록됨" : "모니터링"}</button>
        </td>
      </tr>
    );
  };

  if (view === "line") {
    return (
      <div className="result-list lowest-line-mode">
        <div className="result-list-head">
          <div className="lowest-line-title">
            <span>모델명</span>
            <strong>
              <span>{keyword || "검색 상품"}</span>
              {lineProductName && <em>{lineProductName}</em>}
            </strong>
          </div>
          <span className="result-list-meta">
            <span>{comparisonPlatformLabelText} TOP 10 비교</span>
            <span>{activeRows.length}개 결과</span>
          </span>
        </div>
        {activeRows.length > 0 && (
          <div className="benefit-scan-toolbar">
            <div>
              <strong>체크 항목 상세스캔</strong>
              <span>선택한 쇼핑정보 링크에서 쿠폰·행사·카드 정보를 읽어 등록가를 보정합니다. 1회 최대 10개</span>
            </div>
            <span className="benefit-scan-actions">
              <button className="btn" disabled={benefitScanning || selectedBenefitIds.length === 0} onClick={() => onBenefitScan(selectedBenefitIds)}>
                {benefitScanning ? "상세스캔 중..." : `상세스캔 (${selectedBenefitIds.length})`}
              </button>
              <button className="btn orange" disabled={benefitScanning || selectableIds.length === 0} onClick={() => onBenefitScan(selectableIds)}>
                라인 상위 10개 상세스캔
              </button>
            </span>
          </div>
        )}
        <div className="lowest-line-stack">
          {lineGroups.map((group) => (
            <section className="lowest-line-row" key={group.key}>
              <div className="lowest-line-label">
                <strong>{group.label}</strong>
                <span>{group.rows.length} / 10</span>
              </div>
              <div className="lowest-line-table-wrap">
                <table className="lowest-line-table">
                  <thead>
                    <tr>
                      <th className="result-select-cell">
                        <input
                          type="checkbox"
                          checked={group.rows.length > 0 && group.rows.every((row) => selectedSet.has(row.id))}
                          disabled={group.rows.length === 0}
                          onChange={() => {
                            const groupIds = group.rows.map((row) => row.id);
                            const withoutGroup = selectedBenefitIds.filter((id) => !groupIds.includes(id));
                            const nextIds = group.rows.every((row) => selectedSet.has(row.id))
                              ? withoutGroup
                              : [...withoutGroup, ...groupIds].slice(0, 10);
                            onBenefitSelectionChange(nextIds);
                          }}
                          aria-label={`${group.label} 라인 전체 선택`}
                        />
                      </th>
                      <th>순위</th><th>쇼핑몰</th><th>등록가</th><th>노출가</th><th>혜택상태</th><th>링크</th><th>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row, index) => renderLineRow(row, index + 1))}
                    {Array.from({ length: Math.max(0, 10 - group.rows.length) }, (_, emptyIndex) => (
                      <tr className="line-placeholder-row" key={`${group.key}-empty-${emptyIndex}`}>
                        <td className="result-select-cell"></td>
                        <td className="number-cell">{group.rows.length + emptyIndex + 1}</td>
                        <td colSpan={6}>수집된 후보가 없습니다. 해당 모델의 판매처가 부족하거나 수집이 차단된 상태입니다.</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="result-list">
      <div className="result-list-head">
        <strong>{view === "excluded" ? "제외된 항목" : `(${keyword || "검색 상품"} 모델명)`}</strong>
        <span className="result-list-meta">
          <span className="extraction-legend"><ExtractionMethodBadges methods={["crawl", "playwright", "scrapling"]} /> 크롤링 · Playwright · Scrapling</span>
          <span>{rows.length}개 결과</span>
        </span>
      </div>
      {view === "active" && rows.length > 0 && (
        <div className="benefit-scan-toolbar">
          <div>
            <strong>2차 혜택 상세조사</strong>
            <span>선택한 상품 상세페이지에서 쿠폰·행사·카드 정보를 확인해 등록가를 보정합니다. 1회 최대 10개</span>
          </div>
          <span className="benefit-scan-actions">
            <button
              className="btn"
              disabled={benefitScanning || selectedBenefitIds.length === 0}
              onClick={() => onBenefitScan(selectedBenefitIds)}
            >
              {benefitScanning ? "상세스캔 중..." : `선택 항목 상세스캔 (${selectedBenefitIds.length})`}
            </button>
            <button
              className="btn orange"
              disabled={benefitScanning}
              onClick={() => onBenefitScan(rows.slice(0, 10).map((row) => row.id))}
            >
              최저가 상위 10개 상세스캔
            </button>
          </span>
        </div>
      )}
      <div className="search-results-table-wrap">
        <table className="search-results-table">
          <thead>
            <tr>
              <th className="result-select-cell">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => onBenefitSelectionChange(allSelected ? [] : selectableIds)}
                  aria-label="혜택 상세조사 전체 선택"
                />
              </th>
              <th>상품종류</th><th>모델명</th><th>소스</th><th>추출방식</th><th>쇼핑몰</th><th>등록가</th><th>노출가</th><th>비교율</th><th>마진율</th><th>혜택상태</th><th>가격상태</th><th>작업</th>
            </tr>
          </thead>
          <tbody>
            {view === "active" && lowestRows.map((row) => renderResultRow(row, true))}
            {view === "active" && lowestRows.length > 0 && comparisonRows.length > 0 && (
              <tr className="result-divider"><td colSpan={13}>최저가 외 비교 대상</td></tr>
            )}
            {(view === "excluded" ? rows : comparisonRows).map((row) => renderResultRow(row, false))}
            {rows.length === 0 && <tr><td className="empty-result-cell" colSpan={13}>표시할 상품이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
