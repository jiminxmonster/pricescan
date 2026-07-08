from __future__ import annotations

import base64
import os
import re
import html
import json
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import bcrypt
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", DATA_DIR / "pricescan.db"))
ADMIN_TOKEN = "pricescan-admin-token"
HTTP_TIMEOUT_SECONDS = 8
CRAWLER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
NAVER_COMMERCE_API_BASE = "https://api.commerce.naver.com/external"


app = FastAPI(title="PriceScan API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def now() -> str:
    return datetime.now().isoformat(timespec="microseconds")


@contextmanager
def connect() -> Any:
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row else None


def require_admin(authorization: str | None = Header(default=None)) -> None:
    if authorization != f"Bearer {ADMIN_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


def log_event(message: str, level: str = "info") -> None:
    with connect() as db:
        db.execute(
            "INSERT INTO logs (id, message, level, created_at) VALUES (?, ?, ?, ?)",
            (new_id("log"), message, level, now()),
        )


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def normalize_title(value: str) -> str:
    return re.sub(r"\s+", "", value.lower())


def clean_text(value: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", html.unescape(without_tags)).strip()


def parse_price(value: str | int | float | None) -> int:
    if value is None:
        return 0
    if isinstance(value, int | float):
        return int(value)
    digits = re.sub(r"[^\d]", "", value)
    return int(digits) if digits else 0


def read_url(url: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": CRAWLER_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6",
            **(headers or {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.status, response.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        return error.code, body


def post_url(url: str, body: bytes, headers: dict[str, str]) -> tuple[int, str]:
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": CRAWLER_USER_AGENT,
            "Accept": "application/json",
            **headers,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.status, response.read().decode(charset, errors="replace")
    except urllib.error.HTTPError as error:
        body_text = error.read().decode("utf-8", errors="replace")
        return error.code, body_text


def post_form(url: str, data: dict[str, Any], headers: dict[str, str] | None = None) -> tuple[int, str]:
    return post_url(
        url,
        urllib.parse.urlencode(data).encode("utf-8"),
        {"Content-Type": "application/x-www-form-urlencoded", **(headers or {})},
    )


def post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None) -> tuple[int, str]:
    return post_url(
        url,
        json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        {"Content-Type": "application/json;charset=UTF-8", **(headers or {})},
    )


def init_db() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS api_keys (
                platform TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                client_id TEXT NOT NULL DEFAULT '',
                client_secret TEXT NOT NULL DEFAULT '',
                extra_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL DEFAULT 'not_configured',
                last_tested_at TEXT
            );

            CREATE TABLE IF NOT EXISTS search_runs (
                id TEXT PRIMARY KEY,
                query TEXT NOT NULL,
                sort_mode TEXT NOT NULL,
                status TEXT NOT NULL,
                filters_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                stopped_at TEXT
            );

            CREATE TABLE IF NOT EXISTS price_items (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL REFERENCES search_runs (id),
                source TEXT NOT NULL,
                mall TEXT NOT NULL,
                name TEXT NOT NULL,
                price INTEGER NOT NULL,
                shipping INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL,
                url TEXT NOT NULL,
                is_baseline INTEGER NOT NULL DEFAULT 0,
                is_excluded INTEGER NOT NULL DEFAULT 0,
                collected_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                product TEXT NOT NULL,
                recipient TEXT NOT NULL,
                courier TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS logs (
                id TEXT PRIMARY KEY,
                message TEXT NOT NULL,
                level TEXT NOT NULL DEFAULT 'info',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS listing_drafts (
                id TEXT PRIMARY KEY,
                source_item_id TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                mall TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                target_platforms_json TEXT NOT NULL DEFAULT '[]',
                title TEXT NOT NULL,
                sale_price INTEGER NOT NULL DEFAULT 0,
                display_price INTEGER NOT NULL DEFAULT 0,
                shipping_fee INTEGER NOT NULL DEFAULT 0,
                category_id TEXT NOT NULL DEFAULT '',
                stock_quantity INTEGER NOT NULL DEFAULT 0,
                image_url TEXT NOT NULL DEFAULT '',
                option_name TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                platform_status_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )

        platforms = [
            ("naver", "네이버 쇼핑 검색 API"),
            ("smartstore", "네이버 스마트스토어 커머스API"),
            ("naver_datalab", "네이버 데이터랩"),
            ("coupang", "쿠팡"),
            ("danawa", "다나와 크롤러"),
            ("enuri", "에누리 크롤러"),
            ("elevenst", "11번가"),
            ("gmarket", "G마켓"),
            ("auction", "옥션"),
            ("google_search", "구글 검색 크롤러"),
            ("naver_search", "네이버 일반검색 크롤러"),
        ]
        for platform, label in platforms:
            db.execute(
                """
                INSERT OR IGNORE INTO api_keys (platform, label)
                VALUES (?, ?)
                """,
                (platform, label),
            )
            db.execute("UPDATE api_keys SET label = ? WHERE platform = ?", (label, platform))
        db.execute(
            """
            UPDATE api_keys
            SET status = 'ready'
            WHERE platform = 'danawa' AND status = 'not_configured'
            """
        )

        naver = db.execute("SELECT client_id, client_secret FROM api_keys WHERE platform = 'naver'").fetchone()
        legacy_naver = db.execute("SELECT client_id, client_secret FROM api_keys WHERE platform = 'naver_datalab'").fetchone()
        if (
            naver
            and legacy_naver
            and not naver["client_id"]
            and legacy_naver["client_id"]
            and legacy_naver["client_secret"]
        ):
            db.execute(
                """
                UPDATE api_keys
                SET client_id = ?, client_secret = ?, status = 'configured'
                WHERE platform = 'naver'
                """,
                (legacy_naver["client_id"], legacy_naver["client_secret"]),
            )

        order_count = db.execute("SELECT COUNT(*) AS count FROM orders").fetchone()["count"]
        if order_count == 0:
            seed_orders = [
                ("ORD-260701-018", "스마트스토어", "초경량 업무용 노트북", "김민준", "CJ대한통운", "ready"),
                ("ORD-260701-019", "11번가", "무선 충전 케이블", "이서연", "한진택배", "address_check"),
                ("ORD-260701-020", "쿠팡", "노트북 파우치", "박도윤", "롯데택배", "ready"),
            ]
            for order in seed_orders:
                db.execute(
                    """
                    INSERT INTO orders (id, channel, product, recipient, courier, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (*order, now()),
                )

        log_count = db.execute("SELECT COUNT(*) AS count FROM logs").fetchone()["count"]
        if log_count == 0:
            db.execute(
                "INSERT INTO logs (id, message, level, created_at) VALUES (?, ?, ?, ?)",
                (new_id("log"), "PriceScan backend initialized", "info", now()),
            )


@app.on_event("startup")
def startup() -> None:
    init_db()


class LoginRequest(BaseModel):
    username: str
    password: str


class ApiKeyPayload(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    extra_json: str = "{}"


class PriceSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    sort_mode: str = "lowest"
    filters: list[str] = []
    sources: list[str] = []


class InvoicePrintRequest(BaseModel):
    order_ids: list[str]


class ListingDraftPayload(BaseModel):
    source_item_id: str = ""
    source: str = ""
    mall: str = ""
    source_url: str = ""
    target_platforms: list[str] = ["smartstore"]
    title: str = Field(min_length=1)
    sale_price: int = 0
    display_price: int = 0
    shipping_fee: int = 0
    category_id: str = ""
    stock_quantity: int = 0
    image_url: str = ""
    option_name: str = ""
    description: str = ""


class ListingApprovePayload(BaseModel):
    target_platforms: list[str] = ["smartstore"]


def listing_draft_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = row_to_dict(row) or {}
    data["target_platforms"] = json.loads(data.pop("target_platforms_json") or "[]")
    data["platform_status"] = json.loads(data.pop("platform_status_json") or "{}")
    return data


def naver_sort(sort_mode: str) -> str:
    if sort_mode == "recent":
        return "date"
    if sort_mode in {"lowest", "margin"}:
        return "asc"
    return "sim"


def fetch_naver_products(query: str, sort_mode: str, client_id: str, client_secret: str, display: int = 30) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "query": query,
            "display": min(max(display, 1), 100),
            "start": 1,
            "sort": naver_sort(sort_mode),
            "exclude": "used:rental:cbshop",
        }
    )
    status, body = read_url(
        f"https://openapi.naver.com/v1/search/shop.json?{params}",
        {
            "Accept": "application/json",
            "X-Naver-Client-Id": client_id,
            "X-Naver-Client-Secret": client_secret,
        },
    )
    if status != 200:
        detail = clean_text(body)[:160]
        raise RuntimeError(f"네이버 쇼핑 API 오류: HTTP {status} · {detail}")

    try:
        data = json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError("스마트스토어 토큰 응답을 JSON으로 해석하지 못했습니다.") from error
    products: list[dict[str, Any]] = []
    for item in data.get("items", []):
        price = parse_price(item.get("lprice"))
        if price <= 0:
            continue
        products.append(
            {
                "source": "naver",
                "mall": clean_text(item.get("mallName") or "네이버"),
                "name": clean_text(item.get("title") or ""),
                "price": price,
                "shipping": 0,
                "total": price,
                "url": html.unescape(item.get("link") or "https://shopping.naver.com/"),
            }
        )
    return products


def smartstore_signature(client_id: str, client_secret: str, timestamp: int) -> str:
    password = f"{client_id}_{timestamp}".encode("utf-8")
    hashed = bcrypt.hashpw(password, client_secret.encode("utf-8"))
    return base64.b64encode(hashed).decode("utf-8")


def fetch_smartstore_access_token(client_id: str, client_secret: str) -> str:
    timestamp = int(time.time() * 1000)
    try:
        client_secret_sign = smartstore_signature(client_id, client_secret, timestamp)
    except ValueError as error:
        raise RuntimeError("스마트스토어 Client Secret 형식이 올바르지 않습니다.") from error

    status, body = post_form(
        f"{NAVER_COMMERCE_API_BASE}/v1/oauth2/token",
        {
            "client_id": client_id,
            "timestamp": str(timestamp),
            "client_secret_sign": client_secret_sign,
            "grant_type": "client_credentials",
            "type": "SELF",
        },
    )
    if status != 200:
        detail = clean_text(body)[:220]
        raise RuntimeError(f"스마트스토어 토큰 발급 오류: HTTP {status} · {detail}")

    data = json.loads(body)
    access_token = data.get("access_token")
    if not access_token:
        raise RuntimeError("스마트스토어 토큰 응답에 access_token이 없습니다.")
    return str(access_token)


def product_list_candidates(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return [item for item in data if isinstance(item, dict)]
    if not isinstance(data, dict):
        return []
    for key in ("contents", "content", "items", "products"):
        value = data.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []


def first_existing(data: dict[str, Any], keys: tuple[str, ...], fallback: Any = "") -> Any:
    for key in keys:
        value = data.get(key)
        if value not in (None, ""):
            return value
    return fallback


def normalize_smartstore_products(data: Any, keyword: str = "") -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    keyword_text = normalize_title(keyword) if keyword.strip() else ""
    for content in product_list_candidates(data):
        origin_product_no = first_existing(content, ("originProductNo", "originNo", "productNo"))
        origin_name = clean_text(str(first_existing(content, ("name", "productName", "originProductName"))))
        channel_products = content.get("channelProducts")
        if not isinstance(channel_products, list):
            channel_products = [content]

        for channel in [item for item in channel_products if isinstance(item, dict)]:
            name = clean_text(str(first_existing(channel, ("name", "productName", "channelProductName"), origin_name)))
            if not name:
                continue
            if keyword_text and keyword_text not in normalize_title(name):
                management_code = normalize_title(str(first_existing(channel, ("sellerManagementCode", "managementCode"))))
                if keyword_text not in management_code:
                    continue

            sale_price = parse_price(first_existing(channel, ("salePrice", "price", "basePrice", "discountedPrice"), 0))
            discounted_price = parse_price(first_existing(channel, ("discountedPrice", "discountPrice"), sale_price))
            delivery_fee = parse_price(first_existing(channel, ("deliveryFee", "baseFee", "shippingFee"), 0))
            channel_product_no = first_existing(channel, ("channelProductNo", "productNo", "id"), origin_product_no)
            product_url = str(first_existing(channel, ("url", "productUrl", "channelProductUrl"), "https://smartstore.naver.com/"))

            products.append(
                {
                    "id": str(channel_product_no or origin_product_no or len(products) + 1),
                    "origin_product_no": str(origin_product_no or ""),
                    "channel_product_no": str(channel_product_no or ""),
                    "name": name,
                    "seller_management_code": str(first_existing(channel, ("sellerManagementCode", "managementCode"))),
                    "status": str(first_existing(channel, ("statusType", "channelProductDisplayStatusType", "saleStatusType"))),
                    "sale_price": sale_price,
                    "discounted_price": discounted_price,
                    "stock_quantity": parse_price(first_existing(channel, ("stockQuantity", "stock", "quantity"), 0)),
                    "delivery_fee": delivery_fee,
                    "category_id": str(first_existing(channel, ("categoryId", "wholeCategoryId"))),
                    "channel_service_type": str(first_existing(channel, ("channelServiceType",), "STOREFARM")),
                    "url": product_url,
                }
            )
    return products


def fetch_smartstore_products(client_id: str, client_secret: str, keyword: str = "", page: int = 1, size: int = 50) -> list[dict[str, Any]]:
    access_token = fetch_smartstore_access_token(client_id, client_secret)
    request_payload = {"page": max(page, 1), "size": min(max(size, 1), 100)}
    status, body = post_json(
        f"{NAVER_COMMERCE_API_BASE}/v1/products/search",
        request_payload,
        {"Authorization": f"Bearer {access_token}"},
    )
    if status != 200:
        detail = clean_text(body)[:220]
        raise RuntimeError(f"스마트스토어 상품 목록 조회 오류: HTTP {status} · {detail}")

    try:
        data = json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError("스마트스토어 상품 목록 응답을 JSON으로 해석하지 못했습니다.") from error
    return normalize_smartstore_products(data, keyword)


def parse_danawa_products(document: str, limit: int = 30) -> list[dict[str, Any]]:
    starts = [match.start() for match in re.finditer(r"<li\s+id=[\"']productItem\d+[\"']", document, flags=re.IGNORECASE)]
    blocks = [document[start : starts[index + 1] if index + 1 < len(starts) else len(document)] for index, start in enumerate(starts)]
    products: list[dict[str, Any]] = []
    for block in blocks:
        name_match = re.search(
            r"class=[\"'][^\"']*prod_name[^\"']*[\"'][^>]*>.*?<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>",
            block,
            flags=re.IGNORECASE | re.DOTALL,
        )
        price_match = re.search(r"id=[\"']min_price_\d+[\"']\s+value=[\"']([\d,]+)[\"']", block, flags=re.IGNORECASE)
        if not price_match:
            price_match = re.search(
                r"class=[\"'][^\"']*price_sect[^\"']*[\"'][^>]*>.*?<strong[^>]*>(.*?)</strong>",
                block,
                flags=re.IGNORECASE | re.DOTALL,
            )
        if not price_match:
            price_match = re.search(r"data-[^=]*price=[\"']([\d,]+)[\"']", block, flags=re.IGNORECASE)
        if not name_match or not price_match:
            continue

        name = clean_text(name_match.group(2))
        price = parse_price(price_match.group(1))
        if not name or price <= 0:
            continue

        products.append(
            {
                "source": "danawa",
                "mall": "다나와",
                "name": name,
                "price": price,
                "shipping": 0,
                "total": price,
                "url": urllib.parse.urljoin("https://search.danawa.com/", html.unescape(name_match.group(1))),
            }
        )
        if len(products) >= limit:
            break
    return products


def fetch_danawa_products(query: str, display: int = 30) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode(
        {
            "query": query,
            "originalQuery": query,
            "volumeType": "allvs",
            "page": 1,
            "limit": min(max(display, 1), 100),
        }
    )
    status, body = read_url(f"https://search.danawa.com/dsearch.php?{params}")
    if status != 200:
        raise RuntimeError(f"다나와 검색 페이지 수집 오류: HTTP {status}")
    products = parse_danawa_products(body, limit=display)
    if not products:
        raise RuntimeError("다나와 검색 결과 파싱 실패 또는 결과 없음")
    return products


def parse_enuri_products(document: str, limit: int = 30) -> list[dict[str, Any]]:
    scripts = re.finditer(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        document,
        flags=re.IGNORECASE | re.DOTALL,
    )
    products: list[dict[str, Any]] = []
    for script in scripts:
        raw_json = html.unescape(script.group(1).strip())
        if not raw_json:
            continue
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError:
            continue

        candidates = data if isinstance(data, list) else [data]
        for candidate in candidates:
            if not isinstance(candidate, dict) or candidate.get("@type") != "ItemList":
                continue
            for entry in candidate.get("itemListElement", []):
                item = entry.get("item") if isinstance(entry, dict) else None
                if not isinstance(item, dict):
                    continue
                offers = item.get("offers") if isinstance(item.get("offers"), dict) else {}
                price = parse_price(offers.get("lowPrice"))
                name = clean_text(str(item.get("name") or ""))
                url = str(item.get("url") or "https://www.enuri.com/")
                if not name or price <= 0:
                    continue
                products.append(
                    {
                        "source": "enuri",
                        "mall": "에누리",
                        "name": name,
                        "price": price,
                        "shipping": 0,
                        "total": price,
                        "url": urllib.parse.urljoin("https://www.enuri.com/", html.unescape(url)),
                    }
                )
                if len(products) >= limit:
                    return products
    return products


def fetch_enuri_products(query: str, display: int = 30) -> list[dict[str, Any]]:
    params = urllib.parse.urlencode({"keyword": query})
    status, body = read_url(
        f"https://www.enuri.com/search.jsp?{params}",
        {
            "Referer": "https://www.enuri.com/",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        },
    )
    if status != 200:
        raise RuntimeError(f"에누리 검색 페이지 수집 오류: HTTP {status}")
    if "페이지를 표시할 수 없습니다" in body:
        raise RuntimeError("에누리가 현재 서버 요청에 오류 페이지를 반환함")
    products = parse_enuri_products(body, limit=display)
    if not products:
        raise RuntimeError("에누리 검색 결과 파싱 실패 또는 결과 없음")
    return products


def dedupe_products(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    unique_items: list[dict[str, Any]] = []
    for item in items:
        total = parse_price(item.get("total"))
        key = f"{item.get('source')}:{item.get('mall')}:{normalize_title(str(item.get('name', '')))}:{total}"
        if key in seen:
            continue
        seen.add(key)
        normalized = dict(item)
        normalized["price"] = parse_price(normalized.get("price"))
        normalized["shipping"] = parse_price(normalized.get("shipping"))
        normalized["total"] = normalized["price"] + normalized["shipping"]
        unique_items.append(normalized)
    return unique_items


READY_SEARCH_SOURCES = {"naver", "danawa"}


def normalize_sources(sources: list[str]) -> list[str]:
    selected = [source for source in sources if source in READY_SEARCH_SOURCES]
    return selected or ["naver", "danawa"]


def collect_price_products(db: sqlite3.Connection, query: str, sort_mode: str, sources: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    products: list[dict[str, Any]] = []
    selected_sources = normalize_sources(sources)

    if "naver" in selected_sources:
        naver_key = db.execute("SELECT * FROM api_keys WHERE platform = 'naver'").fetchone()
        if naver_key and naver_key["client_id"] and naver_key["client_secret"]:
            try:
                products.extend(fetch_naver_products(query, sort_mode, naver_key["client_id"], naver_key["client_secret"]))
            except Exception as error:
                warnings.append(str(error))
        else:
            warnings.append("네이버 쇼핑 API 키가 없어 네이버 수집을 건너뜀")

    if "danawa" in selected_sources:
        try:
            products.extend(fetch_danawa_products(query))
        except Exception as error:
            warnings.append(str(error))

    unique_products = dedupe_products(products)
    if sort_mode == "recent":
        return list(reversed(unique_products)), warnings
    return sorted(unique_products, key=lambda item: item["total"]), warnings


def sample_products(query: str) -> list[dict[str, Any]]:
    keyword = query.strip() or "노트북"
    if "케이블" in keyword:
        base = [
            ("naver", "11번가", f"{keyword} C타입 고속충전 2m", 8510, 0, "https://shopping.naver.com/"),
            ("naver", "11번가", f"{keyword} C타입 고속충전 2m", 8510, 0, "https://shopping.naver.com/"),
            ("naver", "스마트스토어", f"{keyword} 100W PD 케이블", 11900, 2500, "https://shopping.naver.com/"),
            ("naver", "쿠팡", f"{keyword} 애플워치 호환 충전", 18900, 0, "https://www.coupang.com/"),
            ("naver", "오픈마켓", f"{keyword} 벌크 특가", 990, 3000, "https://shopping.naver.com/"),
        ]
    else:
        base = [
            ("naver", "11번가", f"{keyword} 초경량 업무용 14형 16GB", 819000, 0, "https://shopping.naver.com/"),
            ("naver", "스마트스토어", f"{keyword} 초경량 업무용 14형 8GB", 842000, 0, "https://shopping.naver.com/"),
            ("naver", "다나와", f"{keyword} 업무용 i5 512GB", 874000, 2500, "https://www.danawa.com/"),
            ("naver", "쿠팡", f"{keyword} 고성능 15형 32GB", 1299000, 0, "https://www.coupang.com/"),
            ("naver", "오픈마켓", f"{keyword} 리퍼 특가 13형", 299000, 3000, "https://shopping.naver.com/"),
        ]

    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for source, mall, name, price, shipping, url in base:
        total = price + shipping
        key = f"{source}:{mall}:{normalize_title(name)}:{total}"
        if key in seen:
            continue
        seen.add(key)
        items.append(
            {
                "source": source,
                "mall": mall,
                "name": name,
                "price": price,
                "shipping": shipping,
                "total": total,
                "url": url,
            }
        )
    return items


def get_run_payload(db: sqlite3.Connection, run_id: str) -> dict[str, Any]:
    run = db.execute("SELECT * FROM search_runs WHERE id = ?", (run_id,)).fetchone()
    if not run:
        raise HTTPException(status_code=404, detail="Search run not found")
    rows = db.execute(
        "SELECT * FROM price_items WHERE run_id = ? ORDER BY total ASC, collected_at DESC",
        (run_id,),
    ).fetchall()
    visible_totals = [row["total"] for row in rows if not row["is_excluded"]]
    average = sum(visible_totals) / len(visible_totals) if visible_totals else 0

    def is_abnormal(row: sqlite3.Row) -> bool:
        return bool(average and (row["total"] < average * 0.45 or row["total"] > average * 1.75))

    baseline = next((row for row in rows if row["is_baseline"] and not row["is_excluded"] and not is_abnormal(row)), None)
    if not baseline:
        baseline = next((row for row in rows if not row["is_excluded"] and not is_abnormal(row)), None)
    if not baseline:
        baseline = next((row for row in rows if not row["is_excluded"]), rows[0] if rows else None)
    baseline_total = baseline["total"] if baseline else 0

    items = []
    for row in rows:
        total = row["total"]
        abnormal = is_abnormal(row)
        if row["is_excluded"]:
            status = "excluded"
        elif abnormal:
            status = "abnormal"
        elif row["is_baseline"]:
            status = "baseline"
        elif baseline and row["id"] == baseline["id"]:
            status = "baseline"
        else:
            status = "candidate"
        item = row_to_dict(row) or {}
        item["margin"] = total - baseline_total if baseline_total else 0
        item["status"] = status
        item["abnormal"] = abnormal
        items.append(item)

    return {
        "run": row_to_dict(run),
        "items": items,
        "summary": {
            "collected_count": len(rows),
            "lowest_count": len([item for item in items if item["status"] == "baseline"]),
            "excluded_count": len([item for item in items if item["is_excluded"]]),
            "baseline_total": baseline_total,
        },
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "pricescan"}


@app.post("/auth/login")
def login(payload: LoginRequest) -> dict[str, str]:
    if payload.username == "admin" and payload.password == "admin":
        log_event("admin login success")
        return {"token": ADMIN_TOKEN, "name": "admin"}
    raise HTTPException(status_code=401, detail="Invalid credentials")


@app.get("/dashboard", dependencies=[Depends(require_admin)])
def dashboard() -> dict[str, Any]:
    with connect() as db:
        latest = db.execute("SELECT id FROM search_runs ORDER BY created_at DESC LIMIT 1").fetchone()
        item_count = db.execute("SELECT COUNT(*) AS count FROM price_items").fetchone()["count"]
        orders_ready = db.execute("SELECT COUNT(*) AS count FROM orders WHERE status = 'ready'").fetchone()["count"]
        api_ready = db.execute("SELECT COUNT(*) AS count FROM api_keys WHERE status IN ('connected', 'ready')").fetchone()["count"]
        pending_publish = db.execute(
            "SELECT COUNT(*) AS count FROM listing_drafts WHERE status IN ('draft', 'ready_to_publish')"
        ).fetchone()["count"]
        latest_payload = get_run_payload(db, latest["id"]) if latest else None
    return {
        "stats": {
            "collected_products": item_count,
            "lowest_candidates": latest_payload["summary"]["lowest_count"] if latest_payload else 0,
            "pending_publish": pending_publish,
            "pricing_targets": 16,
            "invoice_ready": orders_ready,
            "connected_apis": api_ready,
        },
        "latest_search": latest_payload,
    }


@app.get("/api-keys", dependencies=[Depends(require_admin)])
def api_keys() -> list[dict[str, Any]]:
    with connect() as db:
        return [row_to_dict(row) or {} for row in db.execute("SELECT * FROM api_keys ORDER BY platform").fetchall()]


@app.put("/api-keys/{platform}", dependencies=[Depends(require_admin)])
def save_api_key(platform: str, payload: ApiKeyPayload) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT platform FROM api_keys WHERE platform = ?", (platform,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Unknown platform")
        if platform == "danawa":
            status = "ready"
        else:
            status = "configured" if payload.client_id and payload.client_secret else "not_configured"
        db.execute(
            """
            UPDATE api_keys
            SET client_id = ?, client_secret = ?, extra_json = ?, status = ?
            WHERE platform = ?
            """,
            (payload.client_id, payload.client_secret, payload.extra_json, status, platform),
        )
    log_event(f"{platform} API key saved")
    return {"status": status}


@app.post("/api-keys/{platform}/test", dependencies=[Depends(require_admin)])
def test_api_key(platform: str) -> dict[str, Any]:
    with connect() as db:
        key = db.execute("SELECT * FROM api_keys WHERE platform = ?", (platform,)).fetchone()
        if not key:
            raise HTTPException(status_code=404, detail="Unknown platform")
        connected = False
        message = "Client ID/Secret 입력 필요"
        if platform == "naver":
            if key["client_id"] and key["client_secret"]:
                try:
                    fetch_naver_products("노트북", "lowest", key["client_id"], key["client_secret"], display=1)
                    connected = True
                    message = "네이버 쇼핑 검색 API 실제 호출 성공"
                except Exception as error:
                    message = str(error)
            else:
                message = "네이버 Client ID/Secret 입력 필요"
        elif platform == "smartstore":
            if key["client_id"] and key["client_secret"]:
                try:
                    fetch_smartstore_products(key["client_id"], key["client_secret"], size=1)
                    connected = True
                    message = "스마트스토어 커머스API OAuth/상품 목록 조회 성공"
                except Exception as error:
                    message = str(error)
            else:
                message = "스마트스토어 Application ID/Secret 입력 필요"
        elif platform == "danawa":
            try:
                fetch_danawa_products("노트북", display=1)
                connected = True
                message = "다나와 검색 페이지 수집/파싱 성공"
            except Exception as error:
                message = str(error)
        elif platform == "enuri":
            try:
                fetch_enuri_products("노트북", display=1)
                connected = True
                message = "에누리 검색 페이지 수집/파싱 성공"
            except Exception as error:
                message = str(error)
        else:
            connected = bool(key["client_id"] and key["client_secret"])
            message = "API 키 형식 확인 완료" if connected else "Client ID/Secret 입력 필요"
        status = "connected" if connected else "warning"
        db.execute(
            "UPDATE api_keys SET status = ?, last_tested_at = ? WHERE platform = ?",
            (status, now(), platform),
        )
    log_event(f"{platform} API test: {status}", "info" if connected else "warning")
    return {
        "platform": platform,
        "status": status,
        "message": message,
    }


@app.post("/price-search", dependencies=[Depends(require_admin)])
def price_search(payload: PriceSearchRequest) -> dict[str, Any]:
    run_id = new_id("run")
    selected_sources = normalize_sources(payload.sources)
    with connect() as db:
        items, warnings = collect_price_products(db, payload.query, payload.sort_mode, selected_sources)

    average = sum(item["total"] for item in items) / len(items) if items else 0
    baseline_item = next(
        (
            item
            for item in items
            if not (average and (item["total"] < average * 0.45 or item["total"] > average * 1.75))
        ),
        items[0] if items else None,
    )
    baseline_total = baseline_item["total"] if baseline_item else 0

    with connect() as db:
        db.execute(
            """
            INSERT INTO search_runs (id, query, sort_mode, status, filters_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                run_id,
                payload.query,
                payload.sort_mode,
                "completed",
                json.dumps({"filters": payload.filters, "sources": selected_sources}, ensure_ascii=False),
                now(),
            ),
        )
        for item in items:
            total = item["total"]
            is_baseline = 1 if total == baseline_total and baseline_item and item["name"] == baseline_item["name"] else 0
            db.execute(
                """
                INSERT INTO price_items
                (id, run_id, source, mall, name, price, shipping, total, url, is_baseline, is_excluded, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("price"),
                    run_id,
                    item["source"],
                    item["mall"],
                    item["name"],
                    item["price"],
                    item["shipping"],
                    item["total"],
                    item["url"],
                    is_baseline,
                    0,
                    now(),
                ),
            )
        for warning in warnings:
            db.execute(
                "INSERT INTO logs (id, message, level, created_at) VALUES (?, ?, ?, ?)",
                (new_id("log"), warning, "warning", now()),
            )
        payload_out = get_run_payload(db, run_id)
        payload_out["warnings"] = warnings
    log_level = "warning" if warnings else "info"
    log_event(f"price search completed: {payload.query} · {len(items)} items", log_level)
    return payload_out


@app.get("/price-search/latest", dependencies=[Depends(require_admin)])
def latest_price_search() -> dict[str, Any]:
    with connect() as db:
        latest = db.execute("SELECT id FROM search_runs ORDER BY created_at DESC LIMIT 1").fetchone()
        if not latest:
            return {"run": None, "items": [], "summary": {"collected_count": 0, "lowest_count": 0, "excluded_count": 0}}
        return get_run_payload(db, latest["id"])


@app.get("/smartstore/products", dependencies=[Depends(require_admin)])
def smartstore_products(q: str = "", page: int = 1, size: int = 50) -> dict[str, Any]:
    with connect() as db:
        key = db.execute("SELECT * FROM api_keys WHERE platform = 'smartstore'").fetchone()
        if not key or not key["client_id"] or not key["client_secret"]:
            raise HTTPException(status_code=400, detail="스마트스토어 커머스API 키를 먼저 저장하세요.")

    try:
        items = fetch_smartstore_products(key["client_id"], key["client_secret"], q, page, size)
    except Exception as error:
        log_event(f"smartstore product fetch failed: {error}", "warning")
        raise HTTPException(status_code=502, detail=str(error)) from error

    log_event(f"smartstore products fetched: {len(items)} items")
    return {
        "items": items,
        "count": len(items),
        "page": max(page, 1),
        "size": min(max(size, 1), 100),
    }


@app.post("/price-search/stop", dependencies=[Depends(require_admin)])
def stop_search() -> dict[str, str]:
    log_event("price search manually stopped", "warning")
    return {"status": "stopped"}


@app.post("/price-items/{item_id}/baseline", dependencies=[Depends(require_admin)])
def select_baseline(item_id: str) -> dict[str, Any]:
    with connect() as db:
        item = db.execute("SELECT * FROM price_items WHERE id = ?", (item_id,)).fetchone()
        if not item:
            raise HTTPException(status_code=404, detail="Price item not found")
        db.execute("UPDATE price_items SET is_baseline = 0 WHERE run_id = ?", (item["run_id"],))
        db.execute("UPDATE price_items SET is_baseline = 1, is_excluded = 0 WHERE id = ?", (item_id,))
        payload = get_run_payload(db, item["run_id"])
    log_event(f"baseline selected: {item['name']}")
    return payload


@app.post("/price-items/{item_id}/exclude", dependencies=[Depends(require_admin)])
def toggle_exclude(item_id: str) -> dict[str, Any]:
    with connect() as db:
        item = db.execute("SELECT * FROM price_items WHERE id = ?", (item_id,)).fetchone()
        if not item:
            raise HTTPException(status_code=404, detail="Price item not found")
        next_value = 0 if item["is_excluded"] else 1
        db.execute("UPDATE price_items SET is_excluded = ?, is_baseline = 0 WHERE id = ?", (next_value, item_id))
        baseline = db.execute(
            """
            SELECT id FROM price_items
            WHERE run_id = ? AND is_excluded = 0
            ORDER BY total ASC
            LIMIT 1
            """,
            (item["run_id"],),
        ).fetchone()
        if baseline:
            db.execute("UPDATE price_items SET is_baseline = 0 WHERE run_id = ?", (item["run_id"],))
            db.execute("UPDATE price_items SET is_baseline = 1 WHERE id = ?", (baseline["id"],))
        payload = get_run_payload(db, item["run_id"])
    log_event(f"exclude toggled: {item['name']}")
    return payload


@app.get("/orders", dependencies=[Depends(require_admin)])
def orders() -> list[dict[str, Any]]:
    with connect() as db:
        return [row_to_dict(row) or {} for row in db.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall()]


@app.post("/invoices/print", dependencies=[Depends(require_admin)])
def print_invoices(payload: InvoicePrintRequest) -> dict[str, Any]:
    if not payload.order_ids:
        raise HTTPException(status_code=400, detail="No orders selected")
    with connect() as db:
        db.executemany("UPDATE orders SET status = 'printed' WHERE id = ?", [(order_id,) for order_id in payload.order_ids])
    log_event(f"invoices printed: {len(payload.order_ids)} orders")
    return {"status": "printed", "count": len(payload.order_ids)}


@app.get("/channels", dependencies=[Depends(require_admin)])
def channels() -> list[dict[str, Any]]:
    with connect() as db:
        smartstore = db.execute("SELECT status, last_tested_at FROM api_keys WHERE platform = 'smartstore'").fetchone()
    smartstore_status = smartstore["status"] if smartstore else "not_configured"
    return [
        {
            "name": "네이버 스마트스토어",
            "status": smartstore_status if smartstore_status in {"connected", "configured"} else "not_configured",
            "description": "커머스API 기반 상품등록 슬롯",
        },
        {"name": "쇼핑몰 추가 슬롯", "status": "pending", "description": "다음 쇼핑몰 연결 대기"},
        {"name": "쇼핑몰 추가 슬롯", "status": "pending", "description": "다음 쇼핑몰 연결 대기"},
        {"name": "쇼핑몰 추가 슬롯", "status": "pending", "description": "다음 쇼핑몰 연결 대기"},
    ]


@app.get("/listing-drafts", dependencies=[Depends(require_admin)])
def listing_drafts() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM listing_drafts ORDER BY created_at DESC LIMIT 80").fetchall()
        return [listing_draft_row_to_dict(row) for row in rows]


@app.post("/listing-drafts", dependencies=[Depends(require_admin)])
def create_listing_draft(payload: ListingDraftPayload) -> dict[str, Any]:
    draft_id = new_id("draft")
    timestamp = now()
    target_platforms = [platform for platform in payload.target_platforms if platform == "smartstore"] or ["smartstore"]
    with connect() as db:
        db.execute(
            """
            INSERT INTO listing_drafts (
                id, source_item_id, source, mall, source_url, target_platforms_json,
                title, sale_price, display_price, shipping_fee, category_id, stock_quantity,
                image_url, option_name, description, status, platform_status_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                draft_id,
                payload.source_item_id,
                payload.source,
                payload.mall,
                payload.source_url,
                json.dumps(target_platforms, ensure_ascii=False),
                payload.title,
                max(payload.sale_price, 0),
                max(payload.display_price, 0),
                max(payload.shipping_fee, 0),
                payload.category_id,
                max(payload.stock_quantity, 0),
                payload.image_url,
                payload.option_name,
                payload.description,
                "draft",
                json.dumps({platform: "draft" for platform in target_platforms}, ensure_ascii=False),
                timestamp,
                timestamp,
            ),
        )
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing draft created: {payload.title}")
    return listing_draft_row_to_dict(row)


@app.post("/listing-drafts/{draft_id}/approve", dependencies=[Depends(require_admin)])
def approve_listing_draft(draft_id: str, payload: ListingApprovePayload) -> dict[str, Any]:
    target_platforms = [platform for platform in payload.target_platforms if platform == "smartstore"] or ["smartstore"]
    platform_status = {platform: "ready_to_publish" for platform in target_platforms}
    with connect() as db:
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")
        key = db.execute("SELECT * FROM api_keys WHERE platform = 'smartstore'").fetchone()
        if "smartstore" in target_platforms and (not key or key["status"] not in {"connected", "configured"}):
            raise HTTPException(status_code=400, detail="네이버 스마트스토어 API 연결 후 등록 승인할 수 있습니다.")
        db.execute(
            """
            UPDATE listing_drafts
            SET status = ?, target_platforms_json = ?, platform_status_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                "ready_to_publish",
                json.dumps(target_platforms, ensure_ascii=False),
                json.dumps(platform_status, ensure_ascii=False),
                now(),
                draft_id,
            ),
        )
        updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing draft approved for publish: {row['title']}")
    return listing_draft_row_to_dict(updated)


@app.get("/logs", dependencies=[Depends(require_admin)])
def logs() -> list[dict[str, Any]]:
    with connect() as db:
        return [row_to_dict(row) or {} for row in db.execute("SELECT * FROM logs ORDER BY created_at DESC LIMIT 80").fetchall()]
