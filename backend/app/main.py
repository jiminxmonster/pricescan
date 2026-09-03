from __future__ import annotations

import base64
import hashlib
import ipaddress
import mimetypes
import os
import re
import html
import json
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

import bcrypt
import httpx
try:
    from playwright.sync_api import sync_playwright
except ImportError:  # Local tooling can run without browser dependencies.
    sync_playwright = None
try:
    from scrapling.fetchers import Fetcher as ScraplingFetcher
except ImportError:  # The production image installs Scrapling.
    ScraplingFetcher = None
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from .seller_workspace import create_seller_router, init_seller_workspace


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", DATA_DIR / "pricescan.db"))
PRICESCAN_EXTENSION_LOCAL_PATH = Path(os.getenv("PRICESCAN_EXTENSION_LOCAL_PATH", BASE_DIR.parent / "extensions" / "pricescan-collector")).resolve()
PRICESCAN_WEB_LOCAL_URL = os.getenv("PRICESCAN_WEB_LOCAL_URL", "http://127.0.0.1:8300/pricescan/")
PRICESCAN_EXTENSION_DEV_PROFILE_DIR = DATA_DIR / "browser_sessions" / "pricescan_extension_dev"
ADMIN_TOKEN = "pricescan-admin-token"
HTTP_TIMEOUT_SECONDS = 8
PLAYWRIGHT_TIMEOUT_MS = int(os.getenv("PLAYWRIGHT_TIMEOUT_MS", "18000"))
PLAYWRIGHT_SEARCH_ENABLED = os.getenv("PLAYWRIGHT_SEARCH_ENABLED", "1") == "1"
SCRAPLING_SEARCH_ENABLED = os.getenv("SCRAPLING_SEARCH_ENABLED", "1") == "1"
COUPANG_SERVER_CRAWL_ENABLED = os.getenv("COUPANG_SERVER_CRAWL_ENABLED", "0") == "1"
COUPANG_BROWSER_AUTOMATION_ENABLED = os.getenv("COUPANG_BROWSER_AUTOMATION_ENABLED", "1") == "1"
COUPANG_REAL_CHROME_ENABLED = os.getenv("COUPANG_REAL_CHROME_ENABLED", "1") == "1"
CRAWLER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
NAVER_COMMERCE_API_BASE = "https://api.commerce.naver.com/external"
MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024
ALLOWED_IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}
NAVER_LIVE_PUBLISH_CONFIRMATION = "NAVER_LIVE_PUBLISH"
NAVER_PRODUCT_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/bmp"}
SMARTSTORE_CATEGORY_CACHE_TTL = 6 * 60 * 60
smartstore_category_cache: dict[str, Any] = {"fetched_at": 0.0, "items": []}
KST = ZoneInfo("Asia/Seoul")
DEFAULT_COLLECTION_LIMITS = {
    "naver": int(os.getenv("NAVER_DAILY_REQUEST_LIMIT", "200")),
    "danawa": int(os.getenv("DANAWA_DAILY_REQUEST_LIMIT", "100")),
    "enuri": int(os.getenv("ENURI_DAILY_REQUEST_LIMIT", "60")),
    "coupang": int(os.getenv("COUPANG_DAILY_REQUEST_LIMIT", "60")),
}
COMPARISON_TARGET_PLATFORMS = {"naver", "danawa", "enuri", "coupang"}
COMPARISON_PLATFORM_LABELS = {
    "naver": "네이버",
    "danawa": "다나와",
    "enuri": "에누리",
    "coupang": "쿠팡",
}
MAX_COMPETITOR_SNAPSHOT_ROWS = 3
SEARCH_LINE_SOURCE_LIMIT = 80
MAX_BROWSER_COLLECTION_ROWS = 10
MAX_EXTENSION_CANDIDATES_PER_SOURCE = 50
MAX_EXTENSION_COLLECTION_ROWS = MAX_EXTENSION_CANDIDATES_PER_SOURCE * len(COMPARISON_TARGET_PLATFORMS)
COUPANG_BROWSER_SESSION_DIR = DATA_DIR / "browser_sessions" / "coupang"
COUPANG_BROWSER_LOCK = threading.Lock()
LOCAL_BROWSER_EXECUTABLES = [
    Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
]
EXTENSION_COMPATIBLE_BROWSER_EXECUTABLES = [
    Path("/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
    Path("/Applications/Chromium.app/Contents/MacOS/Chromium"),
]


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


def usage_date() -> str:
    return datetime.now(KST).date().isoformat()


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


def parse_first_won_price(value: str | int | float | None) -> int:
    if not isinstance(value, str):
        return parse_price(value)
    text = clean_text(value)
    match = re.search(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", text)
    return parse_price(match.group(1) if match else value)


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
                registered_price INTEGER NOT NULL DEFAULT 0,
                shipping INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL,
                url TEXT NOT NULL,
                is_baseline INTEGER NOT NULL DEFAULT 0,
                is_excluded INTEGER NOT NULL DEFAULT 0,
                exclusion_reason TEXT NOT NULL DEFAULT '',
                extraction_methods_json TEXT NOT NULL DEFAULT '[]',
                benefit_status TEXT NOT NULL DEFAULT 'not_checked',
                coupon_price INTEGER NOT NULL DEFAULT 0,
                event_price INTEGER NOT NULL DEFAULT 0,
                card_price INTEGER NOT NULL DEFAULT 0,
                benefit_price INTEGER NOT NULL DEFAULT 0,
                benefit_shipping INTEGER NOT NULL DEFAULT 0,
                benefit_summary TEXT NOT NULL DEFAULT '',
                benefit_condition TEXT NOT NULL DEFAULT '',
                detail_methods_json TEXT NOT NULL DEFAULT '[]',
                benefit_checked_at TEXT,
                collected_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS search_exceptions (
                id TEXT PRIMARY KEY,
                terms_json TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                channel TEXT NOT NULL,
                product TEXT NOT NULL,
                recipient TEXT NOT NULL,
                courier TEXT NOT NULL,
                status TEXT NOT NULL,
                source_mall TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                source_price INTEGER NOT NULL DEFAULT 0,
                source_shipping INTEGER NOT NULL DEFAULT 0,
                sale_amount INTEGER NOT NULL DEFAULT 0,
                procurement_status TEXT NOT NULL DEFAULT 'source_unlinked',
                source_order_no TEXT NOT NULL DEFAULT '',
                tracking_no TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS logs (
                id TEXT PRIMARY KEY,
                message TEXT NOT NULL,
                level TEXT NOT NULL DEFAULT 'info',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collection_limits (
                source TEXT PRIMARY KEY,
                daily_limit INTEGER NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collection_usage (
                source TEXT NOT NULL,
                usage_date TEXT NOT NULL,
                request_count INTEGER NOT NULL DEFAULT 0,
                last_status TEXT NOT NULL DEFAULT '',
                last_requested_at TEXT,
                PRIMARY KEY (source, usage_date)
            );

            CREATE TABLE IF NOT EXISTS image_assets (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                original_filename TEXT NOT NULL DEFAULT '',
                content_type TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                url TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'upload',
                purpose TEXT NOT NULL DEFAULT 'product',
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

            CREATE TABLE IF NOT EXISTS prepared_products (
                id TEXT PRIMARY KEY,
                dedupe_key TEXT NOT NULL UNIQUE,
                source_item_id TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                mall TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL,
                sale_price INTEGER NOT NULL DEFAULT 0,
                display_price INTEGER NOT NULL DEFAULT 0,
                shipping_fee INTEGER NOT NULL DEFAULT 0,
                image_url TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'prepared',
                listing_draft_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS comparison_targets (
                id TEXT PRIMARY KEY,
                prepared_product_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                comparison_url TEXT NOT NULL DEFAULT '',
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'pending',
                last_scanned_at TEXT,
                last_error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(prepared_product_id, platform)
            );

            CREATE TABLE IF NOT EXISTS competitor_snapshots (
                id TEXT PRIMARY KEY,
                target_id TEXT NOT NULL,
                prepared_product_id TEXT NOT NULL,
                platform TEXT NOT NULL,
                rank INTEGER NOT NULL,
                mall TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL DEFAULT '',
                sale_price INTEGER NOT NULL DEFAULT 0,
                shipping_fee INTEGER NOT NULL DEFAULT 0,
                total_price INTEGER NOT NULL DEFAULT 0,
                detail_url TEXT NOT NULL DEFAULT '',
                is_excluded INTEGER NOT NULL DEFAULT 0,
                exclusion_reason TEXT NOT NULL DEFAULT '',
                collected_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_comparison_targets_prepared
                ON comparison_targets (prepared_product_id, platform);
            CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_target_time
                ON competitor_snapshots (target_id, collected_at);
            CREATE INDEX IF NOT EXISTS idx_competitor_snapshots_prepared
                ON competitor_snapshots (prepared_product_id, platform, collected_at);
            """
        )

        price_item_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(price_items)").fetchall()
        }
        if "exclusion_reason" not in price_item_columns:
            db.execute("ALTER TABLE price_items ADD COLUMN exclusion_reason TEXT NOT NULL DEFAULT ''")
        if "extraction_methods_json" not in price_item_columns:
            db.execute("ALTER TABLE price_items ADD COLUMN extraction_methods_json TEXT NOT NULL DEFAULT '[]'")
        benefit_column_migrations = [
            ("registered_price", "ALTER TABLE price_items ADD COLUMN registered_price INTEGER NOT NULL DEFAULT 0"),
            ("benefit_status", "ALTER TABLE price_items ADD COLUMN benefit_status TEXT NOT NULL DEFAULT 'not_checked'"),
            ("coupon_price", "ALTER TABLE price_items ADD COLUMN coupon_price INTEGER NOT NULL DEFAULT 0"),
            ("event_price", "ALTER TABLE price_items ADD COLUMN event_price INTEGER NOT NULL DEFAULT 0"),
            ("card_price", "ALTER TABLE price_items ADD COLUMN card_price INTEGER NOT NULL DEFAULT 0"),
            ("benefit_price", "ALTER TABLE price_items ADD COLUMN benefit_price INTEGER NOT NULL DEFAULT 0"),
            ("benefit_shipping", "ALTER TABLE price_items ADD COLUMN benefit_shipping INTEGER NOT NULL DEFAULT 0"),
            ("benefit_summary", "ALTER TABLE price_items ADD COLUMN benefit_summary TEXT NOT NULL DEFAULT ''"),
            ("benefit_condition", "ALTER TABLE price_items ADD COLUMN benefit_condition TEXT NOT NULL DEFAULT ''"),
            ("detail_methods_json", "ALTER TABLE price_items ADD COLUMN detail_methods_json TEXT NOT NULL DEFAULT '[]'"),
            ("benefit_checked_at", "ALTER TABLE price_items ADD COLUMN benefit_checked_at TEXT"),
        ]
        for column, statement in benefit_column_migrations:
            if column not in price_item_columns:
                db.execute(statement)
        db.execute(
            "INSERT OR IGNORE INTO search_exceptions (id, terms_json, updated_at) VALUES ('default', '[]', ?)",
            (now(),),
        )

        listing_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(listing_drafts)").fetchall()
        }
        listing_column_migrations = [
            ("validation_json", "ALTER TABLE listing_drafts ADD COLUMN validation_json TEXT NOT NULL DEFAULT '{}'"),
            ("publish_request_json", "ALTER TABLE listing_drafts ADD COLUMN publish_request_json TEXT NOT NULL DEFAULT '{}'"),
            ("publish_mode", "ALTER TABLE listing_drafts ADD COLUMN publish_mode TEXT NOT NULL DEFAULT 'protected'"),
            ("external_product_no", "ALTER TABLE listing_drafts ADD COLUMN external_product_no TEXT NOT NULL DEFAULT ''"),
            ("external_channel_product_no", "ALTER TABLE listing_drafts ADD COLUMN external_channel_product_no TEXT NOT NULL DEFAULT ''"),
            ("external_url", "ALTER TABLE listing_drafts ADD COLUMN external_url TEXT NOT NULL DEFAULT ''"),
            ("last_publish_attempt_at", "ALTER TABLE listing_drafts ADD COLUMN last_publish_attempt_at TEXT"),
            ("publish_error", "ALTER TABLE listing_drafts ADD COLUMN publish_error TEXT NOT NULL DEFAULT ''"),
            ("brand_name", "ALTER TABLE listing_drafts ADD COLUMN brand_name TEXT NOT NULL DEFAULT ''"),
            ("manufacturer_name", "ALTER TABLE listing_drafts ADD COLUMN manufacturer_name TEXT NOT NULL DEFAULT ''"),
            ("model_name", "ALTER TABLE listing_drafts ADD COLUMN model_name TEXT NOT NULL DEFAULT ''"),
            ("origin_area_code", "ALTER TABLE listing_drafts ADD COLUMN origin_area_code TEXT NOT NULL DEFAULT ''"),
            ("origin_area_name", "ALTER TABLE listing_drafts ADD COLUMN origin_area_name TEXT NOT NULL DEFAULT ''"),
            ("product_info_notice_type", "ALTER TABLE listing_drafts ADD COLUMN product_info_notice_type TEXT NOT NULL DEFAULT ''"),
            ("product_info_notice_content", "ALTER TABLE listing_drafts ADD COLUMN product_info_notice_content TEXT NOT NULL DEFAULT ''"),
            ("delivery_method", "ALTER TABLE listing_drafts ADD COLUMN delivery_method TEXT NOT NULL DEFAULT ''"),
            ("delivery_company_code", "ALTER TABLE listing_drafts ADD COLUMN delivery_company_code TEXT NOT NULL DEFAULT ''"),
            ("return_delivery_fee", "ALTER TABLE listing_drafts ADD COLUMN return_delivery_fee INTEGER NOT NULL DEFAULT 0"),
            ("exchange_delivery_fee", "ALTER TABLE listing_drafts ADD COLUMN exchange_delivery_fee INTEGER NOT NULL DEFAULT 0"),
            ("as_telephone", "ALTER TABLE listing_drafts ADD COLUMN as_telephone TEXT NOT NULL DEFAULT ''"),
            ("as_guide_content", "ALTER TABLE listing_drafts ADD COLUMN as_guide_content TEXT NOT NULL DEFAULT ''"),
            ("images_json", "ALTER TABLE listing_drafts ADD COLUMN images_json TEXT NOT NULL DEFAULT '{}'"),
            ("detail_content_html", "ALTER TABLE listing_drafts ADD COLUMN detail_content_html TEXT NOT NULL DEFAULT ''"),
        ]
        for column, statement in listing_column_migrations:
            if column not in listing_columns:
                db.execute(statement)

        prepared_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(prepared_products)").fetchall()
        }
        prepared_column_migrations = [
            ("product_type", "ALTER TABLE prepared_products ADD COLUMN product_type TEXT NOT NULL DEFAULT ''"),
            ("model_name", "ALTER TABLE prepared_products ADD COLUMN model_name TEXT NOT NULL DEFAULT ''"),
            ("fee_rate", "ALTER TABLE prepared_products ADD COLUMN fee_rate REAL NOT NULL DEFAULT 0"),
            ("seller_sale_price", "ALTER TABLE prepared_products ADD COLUMN seller_sale_price INTEGER NOT NULL DEFAULT 0"),
            ("seller_display_price", "ALTER TABLE prepared_products ADD COLUMN seller_display_price INTEGER NOT NULL DEFAULT 0"),
            ("monitoring_enabled", "ALTER TABLE prepared_products ADD COLUMN monitoring_enabled INTEGER NOT NULL DEFAULT 0"),
            ("auto_discount_enabled", "ALTER TABLE prepared_products ADD COLUMN auto_discount_enabled INTEGER NOT NULL DEFAULT 0"),
            ("auto_discount_type", "ALTER TABLE prepared_products ADD COLUMN auto_discount_type TEXT NOT NULL DEFAULT 'amount'"),
            ("auto_discount_value", "ALTER TABLE prepared_products ADD COLUMN auto_discount_value REAL NOT NULL DEFAULT 0"),
        ]
        for column, statement in prepared_column_migrations:
            if column not in prepared_columns:
                db.execute(statement)
        db.execute(
            """
            UPDATE prepared_products
            SET seller_sale_price = CASE WHEN seller_sale_price = 0 THEN sale_price ELSE seller_sale_price END,
                seller_display_price = CASE WHEN seller_display_price = 0 THEN display_price ELSE seller_display_price END
            """
        )

        order_columns = {
            row["name"] for row in db.execute("PRAGMA table_info(orders)").fetchall()
        }
        order_column_migrations = [
            ("source_mall", "ALTER TABLE orders ADD COLUMN source_mall TEXT NOT NULL DEFAULT ''"),
            ("source_url", "ALTER TABLE orders ADD COLUMN source_url TEXT NOT NULL DEFAULT ''"),
            ("source_price", "ALTER TABLE orders ADD COLUMN source_price INTEGER NOT NULL DEFAULT 0"),
            ("source_shipping", "ALTER TABLE orders ADD COLUMN source_shipping INTEGER NOT NULL DEFAULT 0"),
            ("sale_amount", "ALTER TABLE orders ADD COLUMN sale_amount INTEGER NOT NULL DEFAULT 0"),
            ("procurement_status", "ALTER TABLE orders ADD COLUMN procurement_status TEXT NOT NULL DEFAULT 'source_unlinked'"),
            ("source_order_no", "ALTER TABLE orders ADD COLUMN source_order_no TEXT NOT NULL DEFAULT ''"),
            ("tracking_no", "ALTER TABLE orders ADD COLUMN tracking_no TEXT NOT NULL DEFAULT ''"),
            ("updated_at", "ALTER TABLE orders ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''"),
        ]
        for column, statement in order_column_migrations:
            if column not in order_columns:
                db.execute(statement)
        db.execute("UPDATE orders SET updated_at = created_at WHERE updated_at = ''")

        for image_path in UPLOAD_DIR.iterdir():
            if not image_path.is_file():
                continue
            if image_path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
                continue
            row = db.execute("SELECT id FROM image_assets WHERE filename = ?", (image_path.name,)).fetchone()
            if row:
                continue
            content_type = mimetypes.guess_type(str(image_path))[0] or "application/octet-stream"
            db.execute(
                """
                INSERT INTO image_assets (
                    id, filename, original_filename, content_type, size, url, source, purpose, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("img"),
                    image_path.name,
                    image_path.name,
                    content_type,
                    image_path.stat().st_size,
                    f"/uploaded-images/{image_path.name}",
                    "server_pool",
                    "product",
                    now(),
                ),
            )

        platforms = [
            ("naver", "네이버쇼핑 크롤러"),
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
        for source, daily_limit in DEFAULT_COLLECTION_LIMITS.items():
            db.execute(
                """
                INSERT OR IGNORE INTO collection_limits (source, daily_limit, enabled, updated_at)
                VALUES (?, ?, 1, ?)
                """,
                (source, max(daily_limit, 1), now()),
            )
        db.execute(
            """
            UPDATE api_keys
            SET status = 'ready'
            WHERE platform IN ('naver', 'danawa', 'enuri', 'coupang') AND status = 'not_configured'
            """
        )
        # Remove fixed recovery-demo orders so the operations board only shows
        # orders collected from a real sales channel.
        db.execute(
            "DELETE FROM orders WHERE id IN ('ORD-260701-018', 'ORD-260701-019', 'ORD-260701-020')"
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
    with connect() as db:
        init_seller_workspace(db)


class LoginRequest(BaseModel):
    username: str
    password: str


class ApiKeyPayload(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    extra_json: str = "{}"


class CollectionLimitPayload(BaseModel):
    daily_limit: int = Field(ge=1, le=10000)
    enabled: bool = True


class PriceSearchRequest(BaseModel):
    query: str = Field(min_length=1)
    sort_mode: str = "lowest"
    filters: list[str] = []
    sources: list[str] = []


class BrowserPriceItemInput(BaseModel):
    name: str = ""
    mall: str = "쿠팡"
    price: int = Field(default=0, ge=0)
    registered_price: int = Field(default=0, ge=0)
    shipping: int = Field(default=0, ge=0)
    total: int = Field(default=0, ge=0)
    url: str = ""


class BrowserPriceResultsPayload(BaseModel):
    platform: str = "coupang"
    query: str = Field(min_length=1)
    sort_mode: str = "lowest"
    page_url: str = ""
    raw_text: str = ""
    approval_scope: str = "once"
    items: list[BrowserPriceItemInput] = Field(default_factory=list, max_length=MAX_BROWSER_COLLECTION_ROWS)


class ExtensionPriceItemInput(BrowserPriceItemInput):
    source: str = "coupang"


class ExtensionPriceResultsPayload(BaseModel):
    query: str = Field(min_length=1)
    sort_mode: str = "lowest"
    approval_scope: str = "extension"
    merge_run_id: str = ""
    page_urls: dict[str, str] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list, max_length=40)
    items: list[ExtensionPriceItemInput] = Field(default_factory=list, max_length=MAX_EXTENSION_COLLECTION_ROWS)


class DesktopPriceResultsPayload(ExtensionPriceResultsPayload):
    collection_id: str = Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


class CoupangAutoCollectPayload(BaseModel):
    query: str = Field(min_length=1)
    sort_mode: str = "lowest"
    detail_limit: int = Field(default=10, ge=1, le=MAX_BROWSER_COLLECTION_ROWS)
    approval_scope: str = "session"
    approval_wait_seconds: int = Field(default=35, ge=5, le=180)


class BenefitScanRequest(BaseModel):
    item_ids: list[str] = Field(min_length=1, max_length=10)


class SearchExceptionsPayload(BaseModel):
    terms: list[str] = Field(default_factory=list)


class InvoicePrintRequest(BaseModel):
    order_ids: list[str]


class ProcurementUpdateRequest(BaseModel):
    procurement_status: str
    source_mall: str = ""
    source_url: str = ""
    source_price: int = 0
    source_shipping: int = 0
    source_order_no: str = ""
    courier: str = ""
    tracking_no: str = ""


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
    brand_name: str = ""
    manufacturer_name: str = ""
    model_name: str = ""
    origin_area_code: str = ""
    origin_area_name: str = ""
    product_info_notice_type: str = ""
    product_info_notice_content: str = ""
    delivery_method: str = ""
    delivery_company_code: str = ""
    return_delivery_fee: int = 0
    exchange_delivery_fee: int = 0
    as_telephone: str = ""
    as_guide_content: str = ""


class ListingApprovePayload(BaseModel):
    target_platforms: list[str] = ["smartstore"]


class ListingLivePublishPayload(BaseModel):
    confirmation: str


class ListingDraftImagePayload(BaseModel):
    image_url: str = Field(min_length=1)


class ListingDraftImagesPayload(BaseModel):
    representative_url: str = ""
    optional_urls: list[str] = Field(default_factory=list)
    detail_urls: list[str] = Field(default_factory=list)
    detail_content_html: str = ""


class PreparedProductPayload(BaseModel):
    source_item_id: str = ""
    source: str = ""
    mall: str = ""
    source_url: str = ""
    title: str = Field(min_length=1)
    sale_price: int = 0
    display_price: int = 0
    shipping_fee: int = 0
    image_url: str = ""
    product_type: str = ""
    model_name: str = ""


class PreparedMonitoringPayload(BaseModel):
    monitoring_enabled: bool = False
    fee_rate: float = Field(default=0, ge=0, le=100)
    seller_sale_price: int = Field(default=0, ge=0)
    seller_display_price: int = Field(default=0, ge=0)
    auto_discount_enabled: bool = False
    auto_discount_type: str = "amount"
    auto_discount_value: float = Field(default=0, ge=0)
    product_type: str = ""
    model_name: str = ""


class ComparisonTargetInput(BaseModel):
    platform: str
    comparison_url: str = ""
    enabled: bool = True


class ComparisonTargetsPayload(BaseModel):
    targets: list[ComparisonTargetInput] = Field(default_factory=list, max_length=4)


class ComparisonScanPayload(BaseModel):
    platforms: list[str] = Field(default_factory=list, max_length=4)


def prepared_product_dedupe_key(payload: PreparedProductPayload) -> str:
    identity = payload.source_item_id.strip() or payload.source_url.strip() or " ".join(payload.title.lower().split())
    raw_key = "|".join((payload.source.strip().lower(), identity, payload.mall.strip().lower()))
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def parse_json_text(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def normalize_comparison_platform(value: str) -> str:
    platform = value.strip().lower()
    if platform not in COMPARISON_TARGET_PLATFORMS:
        raise HTTPException(status_code=422, detail="comparison platform must be naver, danawa, enuri, or coupang")
    return platform


def normalize_comparison_url(value: str) -> str:
    url = value.strip()
    if not url:
        return ""
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise HTTPException(status_code=422, detail="가격비교 URL은 http 또는 https 주소여야 합니다.")
    return url


def comparison_target_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = row_to_dict(row) or {}
    data["enabled"] = bool(data.get("enabled"))
    data["platform_label"] = COMPARISON_PLATFORM_LABELS.get(data.get("platform", ""), data.get("platform", ""))
    return data


def competitor_snapshot_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = row_to_dict(row) or {}
    data["is_excluded"] = bool(data.get("is_excluded"))
    data["platform_label"] = COMPARISON_PLATFORM_LABELS.get(data.get("platform", ""), data.get("platform", ""))
    return data


def latest_competitor_rows(db: sqlite3.Connection, prepared_id: str) -> list[sqlite3.Row]:
    return db.execute(
        """
        SELECT snapshots.*
        FROM competitor_snapshots snapshots
        JOIN comparison_targets targets ON targets.id = snapshots.target_id
        WHERE snapshots.prepared_product_id = ?
          AND snapshots.collected_at = (
              SELECT MAX(inner_snapshots.collected_at)
              FROM competitor_snapshots inner_snapshots
              WHERE inner_snapshots.target_id = snapshots.target_id
          )
        ORDER BY snapshots.platform ASC, snapshots.rank ASC
        """,
        (prepared_id,),
    ).fetchall()


def prepared_recommendation(data: dict[str, Any], competitors: list[dict[str, Any]]) -> dict[str, Any]:
    valid_totals = sorted(
        int(item.get("total_price") or 0)
        for item in competitors
        if not item.get("is_excluded") and int(item.get("total_price") or 0) > 0
    )
    lowest = valid_totals[0] if valid_totals else 0
    source_cost = int(data.get("display_price") or 0) + int(data.get("shipping_fee") or 0)
    fee_rate = max(float(data.get("fee_rate") or 0), 0)
    fee_multiplier = max(1 - fee_rate / 100, 0.01)
    break_even = int(source_cost / fee_multiplier) if source_cost else 0
    seller_display = int(data.get("seller_display_price") or 0) or int(data.get("display_price") or 0)

    recommended = 0
    reason = "저장된 경쟁가 스캔 결과가 없습니다."
    if lowest:
        target_price = lowest
        if data.get("auto_discount_enabled"):
            discount_value = float(data.get("auto_discount_value") or 0)
            if data.get("auto_discount_type") == "percent":
                target_price = int(lowest * max(0, 1 - discount_value / 100))
            else:
                target_price = int(lowest - discount_value)
        recommended = max(target_price, break_even)
        if recommended > target_price:
            reason = "손익분기 하한가 때문에 최저가보다 높게 제안됨"
        else:
            reason = "최저 경쟁가 기준 추천가"
    elif seller_display:
        recommended = seller_display

    return {
        "lowest_competitor_total": lowest,
        "recommended_display_price": max(recommended, 0),
        "recommended_reason": reason,
        "break_even_display_price": break_even,
    }


def prepared_product_row_to_dict(db: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    data = row_to_dict(row) or {}
    prepared_id = str(data.get("id") or "")
    target_rows = db.execute(
        "SELECT * FROM comparison_targets WHERE prepared_product_id = ? ORDER BY platform ASC",
        (prepared_id,),
    ).fetchall()
    competitors = [competitor_snapshot_row_to_dict(item) for item in latest_competitor_rows(db, prepared_id)]
    scanned_at_values = [
        str(item.get("collected_at") or "")
        for item in competitors
        if item.get("collected_at")
    ]
    data["comparison_targets"] = [comparison_target_row_to_dict(item) for item in target_rows]
    data["competitors"] = competitors
    data["last_competitor_scanned_at"] = max(scanned_at_values) if scanned_at_values else None
    data.update(prepared_recommendation(data, competitors))
    return data


def parse_platform_filter(value: str) -> set[str]:
    if not value:
        return set()
    selected: set[str] = set()
    for platform in value.split(","):
        platform = platform.strip().lower()
        if platform and platform in COMPARISON_TARGET_PLATFORMS:
            selected.add(platform)
    return selected


def build_comparison_history_rows(
    db: sqlite3.Connection,
    prepared_id: str,
    selected_platforms: set[str],
    limit: int,
) -> dict[str, list[sqlite3.Row]]:
    rows = db.execute(
        """
        SELECT platform, rank, mall, title, sale_price, shipping_fee, total_price, detail_url, is_excluded, collected_at
        FROM competitor_snapshots
        WHERE prepared_product_id = ?
        ORDER BY collected_at DESC, platform ASC, rank ASC
        """,
        (prepared_id,),
    ).fetchall()
    grouped: dict[str, list[sqlite3.Row]] = {}
    seen_keys: dict[str, set[str]] = {}
    for row in rows:
        platform = str(row["platform"])
        if not row["collected_at"] or row["is_excluded"]:
            continue
        if selected_platforms and platform not in selected_platforms:
            continue
        if row["rank"] != 1:
            continue
        if platform not in grouped:
            grouped[platform] = []
            seen_keys[platform] = set()
        if row["collected_at"] in seen_keys[platform]:
            continue
        if len(grouped[platform]) >= limit:
            continue
        grouped[platform].append(row)
        seen_keys[platform].add(row["collected_at"])
    for platform, items in grouped.items():
        grouped[platform] = list(reversed(items))
    return grouped


def listing_draft_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    data = row_to_dict(row) or {}
    data["target_platforms"] = parse_json_text(data.pop("target_platforms_json", "[]"), [])
    data["platform_status"] = parse_json_text(data.pop("platform_status_json", "{}"), {})
    data["validation"] = parse_json_text(data.pop("validation_json", "{}"), {})
    data["publish_request"] = parse_json_text(data.pop("publish_request_json", "{}"), {})
    data["images"] = normalize_draft_images(parse_json_text(data.pop("images_json", "{}"), {}), data.get("image_url", ""))
    return data


def normalize_url_list(values: Any, limit: int) -> list[str]:
    if not isinstance(values, list):
        values = []
    result: list[str] = []
    for value in values:
        url = str(value or "").strip()
        if not url or url in result:
            continue
        result.append(url)
        if len(result) >= limit:
            break
    return result


def normalize_draft_images(raw: Any, fallback_representative: str = "") -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    representative_url = str(
        data.get("representative_url")
        or data.get("representativeUrl")
        or fallback_representative
        or ""
    ).strip()
    optional_urls = normalize_url_list(data.get("optional_urls") or data.get("optionalUrls") or [], 9)
    detail_urls = normalize_url_list(data.get("detail_urls") or data.get("detailUrls") or [], 30)
    return {
        "representative_url": representative_url,
        "optional_urls": optional_urls,
        "detail_urls": detail_urls,
    }


def draft_images_to_json(images: dict[str, Any]) -> str:
    return json.dumps(normalize_draft_images(images), ensure_ascii=False)


def generate_detail_content_html(draft: dict[str, Any], images: dict[str, Any]) -> str:
    title = html.escape(str(draft.get("title") or "상품 상세정보").strip())
    description = html.escape(str(draft.get("description") or "").strip()).replace("\n", "<br>")
    brand = html.escape(str(draft.get("brand_name") or "").strip())
    manufacturer = html.escape(str(draft.get("manufacturer_name") or "").strip())
    model = html.escape(str(draft.get("model_name") or "").strip())
    detail_images = images.get("detail_urls") or []
    detail_image_html = "\n".join(
        f'<figure><img src="{html.escape(url)}" alt="{title} 상세 이미지" style="max-width:100%;height:auto;" /></figure>'
        for url in detail_images
    )
    spec_rows = "\n".join(
        row for row in [
            f"<li><strong>브랜드</strong> {brand}</li>" if brand else "",
            f"<li><strong>제조사</strong> {manufacturer}</li>" if manufacturer else "",
            f"<li><strong>모델명</strong> {model}</li>" if model else "",
        ] if row
    )
    return f"""
<section class="pricescan-detail">
  <h2>{title}</h2>
  <p>{description}</p>
  {detail_image_html}
  <ul>
    {spec_rows}
  </ul>
</section>
""".strip()


def validate_listing_draft_data(draft: dict[str, Any]) -> dict[str, Any]:
    missing: list[dict[str, str]] = []
    warnings: list[str] = []

    def require_text(field: str, label: str) -> None:
        if not str(draft.get(field) or "").strip():
            missing.append({"field": field, "label": label})

    require_text("title", "상품명")
    require_text("description", "상세설명")
    require_text("product_info_notice_type", "상품정보제공고시 유형")
    require_text("product_info_notice_content", "상품정보제공고시 내용")
    require_text("delivery_method", "배송방법")
    require_text("as_guide_content", "A/S 안내")

    sale_price = parse_price(draft.get("sale_price"))
    stock_quantity = parse_price(draft.get("stock_quantity"))
    shipping_fee = parse_price(draft.get("shipping_fee"))
    return_delivery_fee = parse_price(draft.get("return_delivery_fee"))
    exchange_delivery_fee = parse_price(draft.get("exchange_delivery_fee"))

    if sale_price <= 0:
        missing.append({"field": "sale_price", "label": "판매가"})
    if stock_quantity <= 0:
        missing.append({"field": "stock_quantity", "label": "재고"})
    if shipping_fee < 0:
        missing.append({"field": "shipping_fee", "label": "배송비"})
    if return_delivery_fee < 0:
        missing.append({"field": "return_delivery_fee", "label": "반품배송비"})
    if exchange_delivery_fee < 0:
        missing.append({"field": "exchange_delivery_fee", "label": "교환배송비"})

    title = str(draft.get("title") or "").strip()
    description = str(draft.get("description") or "").strip()
    image_url = str(draft.get("image_url") or "").strip()
    category_id = str(draft.get("category_id") or "").strip()
    origin_area_name = str(draft.get("origin_area_name") or "").strip()
    as_telephone = str(draft.get("as_telephone") or "").strip()
    if title and len(title) > 100:
        warnings.append("상품명이 길어 네이버 등록 시 거절될 수 있습니다.")
    if description and len(description) < 30:
        warnings.append("상세설명이 너무 짧습니다. 실제 판매용 상세설명 보강이 필요합니다.")
    if image_url and not image_url.startswith(("http://", "https://")):
        warnings.append("대표 이미지 URL은 http/https 주소여야 합니다.")
    if not category_id:
        warnings.append("네이버 실등록 전 카테고리 ID를 확정해야 합니다.")
    if not image_url:
        warnings.append("네이버 실등록 전 권리 확보된 대표 이미지를 등록해야 합니다.")
    if not origin_area_name:
        warnings.append("네이버 실등록 전 원산지를 확정해야 합니다.")
    if not as_telephone:
        warnings.append("네이버 실등록 전 A/S 전화번호를 확정해야 합니다.")
    if not str(draft.get("source_url") or "").strip():
        warnings.append("원본 상품 링크가 없어 추적이 어렵습니다.")
    if not str(draft.get("brand_name") or "").strip():
        warnings.append("브랜드가 없는 경우 카테고리에 따라 네이버 등록 시 추가 확인이 필요할 수 있습니다.")
    if not str(draft.get("manufacturer_name") or "").strip():
        warnings.append("제조사가 없는 경우 카테고리에 따라 네이버 등록 시 추가 확인이 필요할 수 있습니다.")

    return {
        "ready": len(missing) == 0,
        "missing": missing,
        "warnings": warnings,
        "checked_at": now(),
    }


def build_smartstore_publish_request(draft: dict[str, Any], validation: dict[str, Any]) -> dict[str, Any]:
    images = normalize_draft_images(
        parse_json_text(str(draft.get("images_json") or "{}"), {}),
        str(draft.get("image_url") or ""),
    )
    representative_url = images["representative_url"]
    optional_images = [{"url": url} for url in images["optional_urls"]]
    detail_content = str(draft.get("detail_content_html") or "").strip() or generate_detail_content_html(draft, images)
    return {
        "platform": "smartstore",
        "mode": "protected",
        "draft_id": draft.get("id"),
        "source": {
            "item_id": draft.get("source_item_id", ""),
            "source": draft.get("source", ""),
            "mall": draft.get("mall", ""),
            "url": draft.get("source_url", ""),
        },
        "product": {
            "name": draft.get("title", ""),
            "category_id": draft.get("category_id", ""),
            "sale_price": parse_price(draft.get("sale_price")),
            "display_price": parse_price(draft.get("display_price")),
            "stock_quantity": parse_price(draft.get("stock_quantity")),
            "representative_image_url": representative_url,
            "images": {
                "representativeImage": {"url": representative_url} if representative_url else {},
                "optionalImages": optional_images,
            },
            "option_name": draft.get("option_name", ""),
            "detail_content": draft.get("description", ""),
            "detailContent": detail_content,
            "brand_name": draft.get("brand_name", ""),
            "manufacturer_name": draft.get("manufacturer_name", ""),
            "model_name": draft.get("model_name", ""),
            "origin_area": {
                "code": draft.get("origin_area_code", ""),
                "name": draft.get("origin_area_name", ""),
            },
            "product_info_provided_notice": {
                "type": draft.get("product_info_notice_type", ""),
                "content": draft.get("product_info_notice_content", ""),
            },
            "delivery": {
                "method": draft.get("delivery_method", ""),
                "company_code": draft.get("delivery_company_code", ""),
                "base_fee": parse_price(draft.get("shipping_fee")),
                "return_fee": parse_price(draft.get("return_delivery_fee")),
                "exchange_fee": parse_price(draft.get("exchange_delivery_fee")),
            },
            "after_service": {
                "telephone": draft.get("as_telephone", ""),
                "guide_content": draft.get("as_guide_content", ""),
            },
        },
        "image_assets": {
            "representative_url": representative_url,
            "optional_urls": images["optional_urls"],
            "detail_urls": images["detail_urls"],
        },
        "validation": validation,
        "required_before_live_publish": [
            "네이버 카테고리별 옵션/속성 API 결과와 필드 재검증",
            "네이버 상품 이미지 다건 등록 API로 대표/추가 이미지 URL 전환",
            "배송/반품 템플릿 ID 또는 실제 배송정책 매핑",
            "권리 확보된 대표/상세 이미지 업로드",
        ],
        "prepared_at": now(),
    }


def validate_smartstore_live_draft_data(draft: dict[str, Any]) -> dict[str, Any]:
    validation = validate_listing_draft_data(draft)
    missing = list(validation["missing"])
    warnings = list(validation["warnings"])
    existing_fields = {item["field"] for item in missing}

    def require_live_text(field: str, label: str) -> None:
        if field not in existing_fields and not str(draft.get(field) or "").strip():
            missing.append({"field": field, "label": label})
            existing_fields.add(field)

    images = normalize_draft_images(
        parse_json_text(str(draft.get("images_json") or "{}"), {}),
        str(draft.get("image_url") or ""),
    )
    require_live_text("category_id", "네이버 리프 카테고리 ID")
    require_live_text("origin_area_code", "원산지 코드")
    require_live_text("as_telephone", "A/S 전화번호")
    if not images["representative_url"]:
        missing.append({"field": "image_url", "label": "대표 이미지"})

    origin_code = str(draft.get("origin_area_code") or "").strip()
    if origin_code and origin_code not in {"00", "01", "02", "03", "04", "05"}:
        missing.append({"field": "origin_area_code", "label": "공식 원산지 코드(00~05)"})
    if origin_code == "04":
        require_live_text("origin_area_name", "원산지 직접 입력")

    delivery_method = str(draft.get("delivery_method") or "").strip()
    if delivery_method not in {"택배/소포/등기", "직접배송"}:
        missing.append({"field": "delivery_method", "label": "지원 배송방법(택배/소포/등기 또는 직접배송)"})
    if delivery_method == "택배/소포/등기":
        require_live_text("delivery_company_code", "택배사 코드")

    return {
        "ready": len(missing) == 0,
        "missing": missing,
        "warnings": warnings,
        "checked_at": now(),
    }


def naver_notice_payload(draft: dict[str, Any]) -> dict[str, Any]:
    reference = str(draft.get("product_info_notice_content") or "상품상세 참조").strip() or "상품상세 참조"
    title = str(draft.get("title") or "상품").strip()
    model_name = str(draft.get("model_name") or title).strip()
    manufacturer = str(draft.get("manufacturer_name") or "상품상세 참조").strip()
    as_director = str(draft.get("as_guide_content") or "상품상세 참조").strip()
    return {
        "productInfoProvidedNoticeType": "ETC",
        "etc": {
            "returnCostReason": reference,
            "noRefundReason": reference,
            "qualityAssuranceStandard": reference,
            "compensationProcedure": reference,
            "troubleShootingContents": reference,
            "itemName": title[:50],
            "modelName": model_name[:50],
            "manufacturer": manufacturer[:200],
            "afterServiceDirector": as_director[:200],
            "customerServicePhoneNumber": str(draft.get("as_telephone") or "").strip()[:30],
        },
    }


def build_naver_live_product_payload(draft: dict[str, Any], uploaded_image_urls: list[str]) -> dict[str, Any]:
    if not uploaded_image_urls:
        raise RuntimeError("네이버에 등록할 대표 이미지가 없습니다.")
    shipping_fee = parse_price(draft.get("shipping_fee"))
    delivery_method = str(draft.get("delivery_method") or "").strip()
    delivery_type = "DELIVERY" if delivery_method == "택배/소포/등기" else "DIRECT"
    delivery_info: dict[str, Any] = {
        "deliveryType": delivery_type,
        "deliveryAttributeType": "NORMAL",
        "deliveryFee": {
            "deliveryFeeType": "PAID" if shipping_fee > 0 else "FREE",
            "baseFee": shipping_fee,
            "deliveryFeePayType": "PREPAID",
        },
        "claimDeliveryInfo": {
            "returnDeliveryFee": parse_price(draft.get("return_delivery_fee")),
            "exchangeDeliveryFee": parse_price(draft.get("exchange_delivery_fee")),
        },
    }
    if delivery_type == "DELIVERY":
        delivery_info["deliveryCompany"] = str(draft.get("delivery_company_code") or "").strip()

    search_info = {
        key: value
        for key, value in {
            "brandName": str(draft.get("brand_name") or "").strip(),
            "manufacturerName": str(draft.get("manufacturer_name") or "").strip(),
            "modelName": str(draft.get("model_name") or "").strip(),
        }.items()
        if value
    }
    origin_info: dict[str, Any] = {
        "originAreaCode": str(draft.get("origin_area_code") or "").strip(),
        "plural": False,
    }
    if str(draft.get("origin_area_name") or "").strip():
        origin_info["content"] = str(draft.get("origin_area_name") or "").strip()

    images = normalize_draft_images(
        parse_json_text(str(draft.get("images_json") or "{}"), {}),
        str(draft.get("image_url") or ""),
    )
    detail_content = str(draft.get("detail_content_html") or "").strip() or generate_detail_content_html(draft, images)
    detail_attribute: dict[str, Any] = {
        "afterServiceInfo": {
            "afterServiceTelephoneNumber": str(draft.get("as_telephone") or "").strip(),
            "afterServiceGuideContent": str(draft.get("as_guide_content") or "").strip(),
        },
        "originAreaInfo": origin_info,
        "productInfoProvidedNotice": naver_notice_payload(draft),
        "minorPurchasable": True,
    }
    if search_info:
        detail_attribute["naverShoppingSearchInfo"] = search_info

    return {
        "originProduct": {
            "statusType": "SALE",
            "saleType": "NEW",
            "leafCategoryId": str(draft.get("category_id") or "").strip(),
            "name": str(draft.get("title") or "").strip(),
            "detailContent": detail_content,
            "images": {
                "representativeImage": {"url": uploaded_image_urls[0]},
                "optionalImages": [{"url": url} for url in uploaded_image_urls[1:10]],
            },
            "salePrice": parse_price(draft.get("sale_price")),
            "stockQuantity": parse_price(draft.get("stock_quantity")),
            "deliveryInfo": delivery_info,
            "detailAttribute": detail_attribute,
        },
        "smartstoreChannelProduct": {
            "naverShoppingRegistration": True,
            "channelProductDisplayStatusType": "ON",
        },
    }


def naver_api_error(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return clean_text(response.text)[:500] or f"HTTP {response.status_code}"

    if not isinstance(data, dict):
        return clean_text(json.dumps(data, ensure_ascii=False))[:500]
    message = str(data.get("message") or data.get("detail") or data.get("code") or f"HTTP {response.status_code}")
    invalid_inputs = data.get("invalidInputs")
    details: list[str] = []
    if isinstance(invalid_inputs, list):
        for item in invalid_inputs:
            if not isinstance(item, dict):
                continue
            field = str(item.get("name") or item.get("field") or "필드")
            reason = str(item.get("message") or item.get("reason") or "유효하지 않은 값")
            details.append(f"{field}: {reason}")
    return " · ".join([message, *details])[:900]


def load_publish_image(image_url: str) -> tuple[str, bytes, str]:
    parsed = urllib.parse.urlparse(image_url)
    filename = safe_upload_filename(Path(parsed.path).name or "product-image.jpg")

    uploaded_marker = "/uploaded-images/"
    if uploaded_marker in parsed.path:
        stored_name = safe_upload_filename(parsed.path.split(uploaded_marker, 1)[1])
        local_path = UPLOAD_DIR / stored_name
        if not local_path.is_file():
            raise RuntimeError(f"서버 이미지 파일을 찾을 수 없습니다: {stored_name}")
        content = local_path.read_bytes()
        content_type = mimetypes.guess_type(stored_name)[0] or "application/octet-stream"
    else:
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise RuntimeError("상품 이미지는 서버 업로드 파일 또는 http/https URL이어야 합니다.")
        try:
            with httpx.Client(timeout=20, follow_redirects=True) as client:
                response = client.get(image_url, headers={"User-Agent": CRAWLER_USER_AGENT, "Accept": "image/*"})
                response.raise_for_status()
        except httpx.HTTPError as error:
            raise RuntimeError(f"상품 이미지를 가져오지 못했습니다: {error}") from error
        content = response.content
        content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
        if not content_type:
            content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    if not content:
        raise RuntimeError("빈 상품 이미지는 등록할 수 없습니다.")
    if len(content) > MAX_IMAGE_UPLOAD_BYTES:
        raise RuntimeError("네이버 등록 이미지는 장당 8MB 이하여야 합니다.")
    if content_type not in NAVER_PRODUCT_IMAGE_TYPES:
        raise RuntimeError("네이버 실제 등록 이미지는 jpg, png, gif, bmp 형식이어야 합니다. webp 이미지는 변환 후 다시 선택하세요.")
    return filename, content, content_type


def collect_response_values(data: Any, keys: set[str]) -> list[str]:
    values: list[str] = []
    if isinstance(data, dict):
        for key, value in data.items():
            if key in keys and value not in (None, ""):
                values.append(str(value))
            if isinstance(value, (dict, list)):
                values.extend(collect_response_values(value, keys))
    elif isinstance(data, list):
        for value in data:
            values.extend(collect_response_values(value, keys))
    return values


def upload_naver_product_images(access_token: str, image_urls: list[str]) -> list[str]:
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for image_url in image_urls[:10]:
        filename, content, content_type = load_publish_image(image_url)
        files.append(("imageFiles", (filename, content, content_type)))

    try:
        with httpx.Client(timeout=40) as client:
            response = client.post(
                f"{NAVER_COMMERCE_API_BASE}/v1/product-images/upload",
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
                files=files,
            )
    except httpx.HTTPError as error:
        raise RuntimeError(f"네이버 상품 이미지 업로드 연결 오류: {error}") from error
    if response.status_code not in {200, 201}:
        raise RuntimeError(f"네이버 상품 이미지 업로드 오류: HTTP {response.status_code} · {naver_api_error(response)}")

    try:
        data = response.json()
    except ValueError as error:
        raise RuntimeError("네이버 상품 이미지 업로드 응답을 해석하지 못했습니다.") from error
    uploaded_urls = collect_response_values(data, {"url", "imageUrl"})
    uploaded_urls = list(dict.fromkeys(url for url in uploaded_urls if url.startswith(("http://", "https://"))))
    if len(uploaded_urls) < len(files):
        raise RuntimeError(f"네이버 이미지 업로드 결과가 부족합니다: 요청 {len(files)}장, 응답 {len(uploaded_urls)}장")
    return uploaded_urls[: len(files)]


def create_naver_product(access_token: str, product_payload: dict[str, Any]) -> tuple[str, str, dict[str, Any]]:
    try:
        with httpx.Client(timeout=40) as client:
            response = client.post(
                f"{NAVER_COMMERCE_API_BASE}/v2/products",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/json",
                    "Content-Type": "application/json;charset=UTF-8",
                },
                json=product_payload,
            )
    except httpx.HTTPError as error:
        raise RuntimeError(f"네이버 상품등록 연결 오류: {error}") from error
    if response.status_code not in {200, 201}:
        raise RuntimeError(f"네이버 상품등록 오류: HTTP {response.status_code} · {naver_api_error(response)}")

    try:
        data = response.json()
    except ValueError as error:
        raise RuntimeError("네이버 상품등록 응답을 해석하지 못했습니다.") from error
    origin_numbers = collect_response_values(data, {"originProductNo"})
    channel_numbers = collect_response_values(data, {"smartstoreChannelProductNo", "channelProductNo"})
    origin_product_no = origin_numbers[0] if origin_numbers else ""
    channel_product_no = channel_numbers[0] if channel_numbers else ""
    if not origin_product_no and not channel_product_no:
        raise RuntimeError("네이버 상품등록 응답에 상품번호가 없습니다. 중복 등록 여부를 스마트스토어센터에서 확인하세요.")
    return origin_product_no, channel_product_no, data


def safe_upload_filename(filename: str) -> str:
    name = Path(filename or "image").name
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)[:80] or "image"


def naver_shopping_search_url(query: str, sort_mode: str, display: int = 40) -> str:
    params = urllib.parse.urlencode(
        {
            "query": query,
            "origQuery": query,
            "pagingIndex": 1,
            "pagingSize": min(max(display, 1), 80),
            "productSet": "total",
            "sort": "price_asc" if sort_mode == "lowest" else "rel",
        }
    )
    return f"https://search.shopping.naver.com/search/all?{params}"


def naver_search_shopping_url(query: str, sort_mode: str, display: int = 40) -> str:
    params = urllib.parse.urlencode(
        {
            "where": "shopping",
            "query": query,
            "sm": "tab_jum",
            "sort": "price_asc" if sort_mode == "lowest" else "rel",
            "pagingSize": min(max(display, 1), 80),
        }
    )
    return f"https://search.naver.com/search.naver?{params}"


def infer_naver_crawl_mall(raw_mall: str, title: str, detail_url: str) -> str:
    parsed = urllib.parse.urlparse(detail_url)
    host = (parsed.hostname or "").lower()
    text = f"{raw_mall} {title} {host}".lower()
    mall_rules = (
        ("coupang", "쿠팡"),
        ("11st", "11번가"),
        ("gmarket", "G마켓"),
        ("auction", "옥션"),
        ("lotteon", "롯데온"),
        ("ssg", "SSG"),
        ("wemakeprice", "위메프"),
        ("tmon", "티몬"),
        ("interpark", "인터파크"),
        ("danawa", "다나와"),
        ("enuri", "에누리"),
    )
    for marker, label in mall_rules:
        if marker in text:
            return label
    if "smartstore.naver.com" in host:
        return "스마트스토어"
    if "shopping.naver.com" in host or "search.naver.com" in host or host.endswith("naver.com"):
        return "네이버쇼핑"
    return "네이버쇼핑"


def normalize_naver_crawl_mall(raw_mall: str, title: str, detail_url: str) -> str:
    mall = clean_text(raw_mall)
    title_text = clean_text(title)
    normalized_mall = normalize_title(mall)
    normalized_title = normalize_title(title_text)
    looks_like_title = (
        not mall
        or mall == "판매처"
        or bool(re.search(r"\b[A-Z0-9]+(?:-[A-Z0-9]+)+\b", mall.upper()))
        or (len(mall) > 14 and normalized_mall in normalized_title)
        or (len(mall) > 14 and normalized_title in normalized_mall)
    )
    return infer_naver_crawl_mall(mall, title_text, detail_url) if looks_like_title else mall


def parse_naver_shopping_crawl_products(document: str, search_url: str, display: int = 40) -> list[dict[str, Any]]:
    candidates = [
        *extract_script_json_competitors(document, search_url),
        *html_competitor_candidates(document, search_url),
    ]
    products: list[dict[str, Any]] = []
    for candidate in normalize_competitor_candidates(candidates, limit=display):
        detail_url = candidate.get("detail_url") or search_url
        title = candidate.get("title") or ""
        products.append(
            {
                "source": "naver",
                "mall": normalize_naver_crawl_mall(candidate.get("mall") or "", title, detail_url),
                "name": title,
                "price": parse_price(candidate.get("sale_price")),
                "shipping": parse_price(candidate.get("shipping_fee")),
                "total": parse_price(candidate.get("total_price")),
                "url": detail_url,
                "extraction_methods": ["crawl"],
            }
        )
    return products


def fetch_naver_shopping_crawl_products(query: str, sort_mode: str, display: int = 40) -> list[dict[str, Any]]:
    attempts: list[str] = []
    crawler_headers = {
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
    }
    for search_url, referer, label in (
        (naver_shopping_search_url(query, sort_mode, display), "https://shopping.naver.com/", "네이버쇼핑"),
        (naver_search_shopping_url(query, sort_mode, display), "https://www.naver.com/", "네이버 검색 쇼핑탭"),
    ):
        status, body = read_url(search_url, {"Referer": referer, **crawler_headers})
        if status != 200:
            attempts.append(f"{label} HTTP {status}")
            continue
        products = parse_naver_shopping_crawl_products(body, search_url, display=display)
        if products:
            return products
        attempts.append(f"{label} 파싱 결과 없음")
    raise RuntimeError(f"네이버쇼핑 검색 결과 수집 실패: {' · '.join(attempts)}")


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


def normalize_smartstore_categories(data: Any) -> list[dict[str, Any]]:
    categories: list[dict[str, Any]] = []

    def visit(value: Any, parent_path: list[str] | None = None) -> None:
        path = parent_path or []
        if isinstance(value, list):
            for item in value:
                visit(item, path)
            return
        if not isinstance(value, dict):
            return
        category_id = str(first_existing(value, ("id", "categoryId", "category_id"))).strip()
        name = clean_text(str(first_existing(value, ("name", "categoryName", "category_name"))))
        whole_name = clean_text(str(first_existing(value, ("wholeCategoryName", "wholeName", "path"))))
        current_path = [*path, name] if name and name not in path else path
        children = first_existing(value, ("subCategories", "children", "childCategories"), [])
        has_children = isinstance(children, list) and bool(children)
        is_leaf = bool(first_existing(value, ("last", "isLast", "leaf", "isLeaf"), False)) or not has_children
        if category_id and name:
            categories.append({"id": category_id, "name": name, "path": whole_name or " > ".join(current_path), "is_leaf": is_leaf})
        if has_children:
            visit(children, current_path)

    visit(data)
    return list({category["id"]: category for category in categories}.values())


def fetch_smartstore_categories(client_id: str, client_secret: str) -> list[dict[str, Any]]:
    cached_at = float(smartstore_category_cache.get("fetched_at") or 0)
    cached_items = smartstore_category_cache.get("items")
    if isinstance(cached_items, list) and cached_items and time.time() - cached_at < SMARTSTORE_CATEGORY_CACHE_TTL:
        return cached_items
    access_token = fetch_smartstore_access_token(client_id, client_secret)
    status, body = read_url(
        f"{NAVER_COMMERCE_API_BASE}/v1/categories",
        {"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
    )
    if status != 200:
        raise RuntimeError(f"스마트스토어 카테고리 조회 오류: HTTP {status} · {clean_text(body)[:220]}")
    try:
        categories = normalize_smartstore_categories(json.loads(body))
    except json.JSONDecodeError as error:
        raise RuntimeError("스마트스토어 카테고리 응답을 JSON으로 해석하지 못했습니다.") from error
    if not categories:
        raise RuntimeError("스마트스토어 카테고리 응답에서 카테고리를 찾지 못했습니다.")
    smartstore_category_cache.update({"fetched_at": time.time(), "items": categories})
    return categories


def smartstore_category_suggestions(categories: list[dict[str, Any]], keyword: str, limit: int = 12) -> list[dict[str, Any]]:
    keyword_text = clean_text(keyword).lower()
    tokens = {token for token in re.findall(r"[가-힣a-zA-Z0-9]+", keyword_text) if len(token) >= 2}
    aliases = {
        "노트북": ("노트북", "랩탑", "갤럭시북", "맥북", "그램"),
        "태블릿": ("태블릿", "아이패드", "갤럭시탭"),
        "모니터": ("모니터", "디스플레이"),
        "스마트폰": ("스마트폰", "휴대폰", "아이폰", "갤럭시"),
        "텔레비전": ("tv", "텔레비전", "스마트tv"),
    }
    for category_word, words in aliases.items():
        if any(word in keyword_text for word in words):
            tokens.add(category_word)
    scored: list[tuple[int, dict[str, Any]]] = []
    for category in categories:
        if not category.get("is_leaf"):
            continue
        path = clean_text(str(category.get("path") or category.get("name") or "")).lower()
        name = str(category.get("name") or "").lower()
        score = sum(4 if token in name else 2 for token in tokens if token in path)
        if "노트북" in tokens and any(word in path for word in ("가방", "파우치", "스킨", "보호필름", "액세서리")):
            score -= 8
        if score > 0:
            scored.append((score, category))
    scored.sort(key=lambda item: (-item[0], len(str(item[1].get("path", ""))), str(item[1].get("path", ""))))
    return [{**category, "score": score} for score, category in scored[: min(max(limit, 1), 30)]]


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


def danawa_search_url(query: str, display: int = 30) -> str:
    params = urllib.parse.urlencode(
        {
            "query": query,
            "originalQuery": query,
            "volumeType": "allvs",
            "page": 1,
            "limit": min(max(display, 1), 100),
        }
    )
    return f"https://search.danawa.com/dsearch.php?{params}"


def mark_extraction_method(products: list[dict[str, Any]], method: str) -> list[dict[str, Any]]:
    return [{**product, "extraction_methods": [method]} for product in products]


def parse_danawa_mall_price_products(document: str, product_name: str, fallback_url: str, limit: int = 10) -> list[dict[str, Any]]:
    section_match = re.search(
        r"<ul\b[^>]*class=[\"'][^\"']*list__mall-price[^\"']*[\"'][^>]*>(.*?)</ul>",
        document,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not section_match:
        return []
    section = section_match.group(1)
    item_matches = re.finditer(r"<li\b[^>]*class=[\"'][^\"']*list-item[^\"']*[\"'][^>]*>(.*?)</li>", section, flags=re.IGNORECASE | re.DOTALL)
    products: list[dict[str, Any]] = []
    for item_match in item_matches:
        block = item_match.group(1)
        mall_match = re.search(r"\balt=[\"']([^\"']+)[\"']", block, flags=re.IGNORECASE)
        mall = clean_text(mall_match.group(1)) if mall_match else ""
        if not mall:
            mall_text_match = re.search(
                r"class=[\"'][^\"']*(?:mall|logo|store|shop)[^\"']*[\"'][^>]*>(.*?)</(?:a|span|div|p)>",
                block,
                flags=re.IGNORECASE | re.DOTALL,
            )
            mall = clean_text(mall_text_match.group(1)) if mall_text_match else ""

        base_price_match = re.search(r"data-base-price=[\"']([\d,]+)[\"']", block, flags=re.IGNORECASE)
        delivery_price_match = re.search(r"data-delivery-price=[\"']([\d,]+)[\"']", block, flags=re.IGNORECASE)
        price = parse_price(base_price_match.group(1) if base_price_match else "")
        shipping = parse_price(delivery_price_match.group(1) if delivery_price_match else "")
        if price <= 0:
            price_match = re.search(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", clean_text(block))
            price = parse_price(price_match.group(1) if price_match else "")
        if price <= 0:
            continue

        href_match = re.search(
            r"<a\b[^>]+href=[\"']([^\"']+)[\"'][^>]*class=[\"'][^\"']*link__(?:sell-price|buy)[^\"']*[\"']",
            block,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not href_match:
            href_match = re.search(r"<a\b[^>]+href=[\"']([^\"']+)[\"']", block, flags=re.IGNORECASE)
        detail_url = urllib.parse.urljoin(fallback_url, html.unescape(href_match.group(1))) if href_match else fallback_url
        products.append(
            {
                "source": "danawa",
                "mall": mall or "다나와 판매처",
                "name": product_name,
                "price": price,
                "shipping": shipping,
                "total": price + shipping,
                "url": detail_url,
            }
        )
        if len(products) >= limit:
            break
    return sorted(products, key=lambda item: (item["total"], item["mall"]))


def fetch_danawa_products(query: str, display: int = 30) -> list[dict[str, Any]]:
    status, body = read_url(danawa_search_url(query, display))
    if status != 200:
        raise RuntimeError(f"다나와 검색 페이지 수집 오류: HTTP {status}")
    products = parse_danawa_products(body, limit=display)
    if not products:
        raise RuntimeError("다나와 검색 결과 파싱 실패 또는 결과 없음")
    detail_products: list[dict[str, Any]] = []
    for product in products[:3]:
        detail_url = str(product.get("url") or "")
        if "prod.danawa.com/info/" not in detail_url:
            continue
        detail_status, detail_body = read_url(detail_url, {"Referer": danawa_search_url(query, display)})
        if detail_status != 200:
            continue
        detail_products.extend(
            parse_danawa_mall_price_products(
                detail_body,
                str(product.get("name") or query),
                detail_url,
                limit=max(10 - len(detail_products), 0),
            )
        )
        if len(detail_products) >= 10:
            break
    if detail_products:
        return mark_extraction_method(detail_products[:10], "crawl")
    return mark_extraction_method(products, "crawl")


def fetch_danawa_playwright_products(query: str, display: int = 30) -> list[dict[str, Any]]:
    if not PLAYWRIGHT_SEARCH_ENABLED:
        return []
    if sync_playwright is None:
        raise RuntimeError("Playwright 검색 모듈이 설치되지 않음")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            page = browser.new_page(locale="ko-KR", user_agent=CRAWLER_USER_AGENT)
            page.goto(
                danawa_search_url(query, display),
                wait_until="domcontentloaded",
                timeout=PLAYWRIGHT_TIMEOUT_MS,
            )
            try:
                page.wait_for_selector("li[id^='productItem']", timeout=min(PLAYWRIGHT_TIMEOUT_MS, 8000))
            except Exception:
                pass
            products = parse_danawa_products(page.content(), limit=display)
        finally:
            browser.close()
    if not products:
        raise RuntimeError("다나와 Playwright 렌더링 결과 파싱 실패 또는 결과 없음")
    return mark_extraction_method(products, "playwright")


def fetch_danawa_scrapling_products(query: str, display: int = 30) -> list[dict[str, Any]]:
    if not SCRAPLING_SEARCH_ENABLED:
        return []
    if ScraplingFetcher is None:
        raise RuntimeError("Scrapling 검색 모듈이 설치되지 않음")
    response = ScraplingFetcher.get(
        danawa_search_url(query, display),
        timeout=HTTP_TIMEOUT_SECONDS,
        impersonate="chrome",
        headers={"Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"},
    )
    if int(response.status) != 200:
        raise RuntimeError(f"다나와 Scrapling 수집 오류: HTTP {response.status}")
    document = response.body.decode("utf-8", errors="replace")
    products = parse_danawa_products(document, limit=display)
    if not products:
        raise RuntimeError("다나와 Scrapling 결과 파싱 실패 또는 결과 없음")
    return mark_extraction_method(products, "scrapling")


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
                price = parse_price(offers.get("lowPrice") or offers.get("price"))
                name = clean_text(str(item.get("name") or ""))
                url = str(item.get("url") or "https://www.enuri.com/")
                if not name or price <= 0:
                    continue
                image_url = str(item.get("image") or "")
                products.append(
                    {
                        "source": "enuri",
                        "mall": infer_enuri_mall(image_url, url, name),
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


def infer_enuri_mall(image_url: str, product_url: str, name: str) -> str:
    text = f"{image_url} {product_url} {name}".lower()
    mall_rules = (
        ("011st", "11번가"),
        ("11st", "11번가"),
        ("coupang", "쿠팡"),
        ("gmarket", "G마켓"),
        ("auction", "옥션"),
        ("lotteon", "롯데ON"),
        ("cjonstyle", "CJ온스타일"),
        ("ssg", "SSG.COM"),
        ("emart", "이마트몰"),
        ("hmall", "현대Hmall"),
        ("interpark", "인터파크"),
        ("shop1.phinf.naver.net", "스마트스토어"),
        ("smartstore", "스마트스토어"),
    )
    for marker, label in mall_rules:
        if marker in text:
            return label
    if "detail.jsp?modelno=" in product_url:
        return "에누리 가격비교"
    return "에누리 판매처"


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


def coupang_search_url(query: str, sort_mode: str = "lowest", display: int = 40) -> str:
    sorter = "salePriceAsc" if sort_mode == "lowest" else "scoreDesc"
    params = urllib.parse.urlencode(
        {
            "q": query,
            "sorter": sorter,
            "listSize": min(max(display, 1), 60),
        }
    )
    return f"https://www.coupang.com/np/search?{params}"


def coupang_product_blocks(document: str) -> list[str]:
    starts = [
        match.start()
        for match in re.finditer(
            r"<(?:li|div)\b[^>]*class=[\"'][^\"']*(?:search-product|baby-product|productUnit|ProductUnit|product-card|ProductCard)[^\"']*[\"']",
            document,
            flags=re.IGNORECASE,
        )
    ]
    blocks = [document[start : starts[index + 1] if index + 1 < len(starts) else len(document)] for index, start in enumerate(starts)]
    if blocks:
        return blocks

    blocks = [
        match.group(0)
        for match in re.finditer(
            r"<(?P<tag>li|div)\b[^>]*(?:data-product-id|data-item-id|data-vendor-item-id|search-product|baby-product)[^>]*>.*?</(?P=tag)>",
            document,
            flags=re.IGNORECASE | re.DOTALL,
        )
    ]
    if blocks:
        return blocks

    href_matches = list(re.finditer(r"<a\b[^>]+href=[\"']([^\"']*(?:/vp/products/|/np/products/|/products/)[^\"']*)[\"']", document, flags=re.IGNORECASE))
    window_blocks: list[str] = []
    seen_ranges: set[tuple[int, int]] = set()
    for match in href_matches:
        start_window = max(0, match.start() - 3500)
        end_window = min(len(document), match.end() + 4500)
        nearest_li = document.rfind("<li", start_window, match.start())
        nearest_div = document.rfind("<div", start_window, match.start())
        start = max(nearest_li, nearest_div, start_window)
        closing_li = document.find("</li>", match.end(), end_window)
        end = closing_li + len("</li>") if closing_li >= 0 else end_window
        block_range = (start, end)
        if block_range in seen_ranges:
            continue
        seen_ranges.add(block_range)
        window_blocks.append(document[start:end])
    return window_blocks


def extract_coupang_name(block: str) -> str:
    name_patterns = (
        r"class=[\"'][^\"']*(?:name|prod-name|product-title|productName|ProductUnit_productName|title)[^\"']*[\"'][^>]*>(.*?)</(?:div|span|strong|p|em|a)>",
        r"\bdata-product-name=[\"']([^\"']{4,240})[\"']",
        r"\btitle=[\"']([^\"']{4,240})[\"']",
        r"\baria-label=[\"']([^\"']{4,240})[\"']",
        r"\balt=[\"']([^\"']{4,240})[\"']",
    )
    for pattern in name_patterns:
        match = re.search(pattern, block, flags=re.IGNORECASE | re.DOTALL)
        if not match:
            continue
        candidate = clean_text(match.group(1))
        if candidate and not re.search(r"^\d[\d,]*\s*원?$|무료배송|장바구니|광고", candidate):
            return candidate[:240]

    text = clean_text(block)
    price_match = re.search(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", text)
    if not price_match:
        return ""
    before_price = text[: price_match.start()]
    before_price = re.sub(r"^(?:광고|AD)\s*", "", before_price, flags=re.IGNORECASE)
    before_price = re.sub(r"(?:와우할인가|쿠폰가|즉시할인가|판매가|가격)\s*$", "", before_price).strip(" -·:/")
    tokens = [segment.strip(" -·:/") for segment in re.split(r"\s{2,}|(?<=\])\s*", before_price) if segment.strip()]
    return (tokens[-1] if tokens else before_price)[-240:]


COUPANG_REGISTERED_PRICE_CONTEXT = re.compile(
    r"original|base[-_ ]?price|list[-_ ]?price|retail|regular|normal|before|was|strike|strikethrough|del|discount[-_ ]?rate|정가|정상가|할인전|할인\s*전|원가|등록가",
    flags=re.IGNORECASE,
)


def extract_coupang_price(block: str) -> int:
    price_class_matches = re.finditer(
        r"<(?P<tag>strong|span|em|div|p|b)\b(?P<attrs>[^>]*)>(?P<body>.*?)</(?P=tag)>",
        block,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for match in price_class_matches:
        attrs = match.group("attrs")
        body = match.group("body")
        target = f"{attrs} {body[:160]}"
        if not re.search(r"price-value|sale-price|sales-price|final-price|discount-price|price", attrs, flags=re.IGNORECASE):
            continue
        if COUPANG_REGISTERED_PRICE_CONTEXT.search(target):
            continue
        price = parse_first_won_price(body)
        if price > 0:
            return price

    for data_price_match in re.finditer(r"data-[^=]*(?:price|amount)=[\"']([\d,]+)[\"']", block, flags=re.IGNORECASE):
        context = block[max(0, data_price_match.start() - 80) : min(len(block), data_price_match.end() + 80)]
        if COUPANG_REGISTERED_PRICE_CONTEXT.search(context):
            continue
        price = parse_price(data_price_match.group(1))
        if price > 0:
            return price

    text = clean_text(block)
    candidates: list[int] = []
    for match in re.finditer(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", text):
        context = text[max(0, match.start() - 25) : min(len(text), match.end() + 25)]
        if COUPANG_REGISTERED_PRICE_CONTEXT.search(context):
            continue
        if re.search(r"적립|캐시|배송비|월\s*\d|개월|카드", context):
            continue
        candidates.append(parse_price(match.group(1)))
    if candidates:
        return candidates[0]
    fallback = re.search(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", text)
    return parse_price(fallback.group(1) if fallback else "")


def extract_coupang_registered_price(block: str, exposure_price: int) -> int:
    candidates: list[int] = []
    for match in re.finditer(
        r"<(?P<tag>del|s)\b[^>]*>(?P<body>.*?)</(?P=tag)>",
        block,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        price = parse_first_won_price(match.group("body"))
        if price > exposure_price:
            candidates.append(price)

    for match in re.finditer(
        r"<(?P<tag>strong|span|em|div|p|b)\b(?P<attrs>[^>]*)>(?P<body>.*?)</(?P=tag)>",
        block,
        flags=re.IGNORECASE | re.DOTALL,
    ):
        target = f"{match.group('attrs')} {match.group('body')[:160]}"
        if not COUPANG_REGISTERED_PRICE_CONTEXT.search(target):
            continue
        price = parse_first_won_price(match.group("body"))
        if price > exposure_price:
            candidates.append(price)

    text = clean_text(block)
    for match in re.finditer(
        r"(?:정가|정상가|할인전|할인\s*전|원가|등록가)[^\d]{0,30}(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원",
        text,
        flags=re.IGNORECASE,
    ):
        price = parse_price(match.group(1))
        if price > exposure_price:
            candidates.append(price)

    return candidates[0] if candidates else exposure_price


def parse_coupang_products(document: str, search_url: str, limit: int = 30) -> list[dict[str, Any]]:
    blocks = coupang_product_blocks(document)

    products: list[dict[str, Any]] = []
    seen: set[str] = set()
    for block in blocks:
        text = clean_text(block)
        if "원" not in text:
            continue
        href_match = re.search(
            r"<a\b[^>]+href=[\"']([^\"']*(?:/vp/products/|/np/products/|/products/)[^\"']*)[\"']",
            block,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not href_match:
            href_match = re.search(r"<a\b[^>]+href=[\"']([^\"']+)[\"']", block, flags=re.IGNORECASE)

        name = extract_coupang_name(block)
        price = extract_coupang_price(block)
        if not name or price <= 0:
            continue
        registered_price = extract_coupang_registered_price(block, price)

        shipping = 0
        shipping_match = re.search(r"배송비[^\d]{0,20}(\d{1,3}(?:,\d{3})+|\d{3,7})\s*원", text)
        if shipping_match and "무료배송" not in text.replace(" ", ""):
            shipping = parse_price(shipping_match.group(1))

        detail_url = urllib.parse.urljoin("https://www.coupang.com/", html.unescape(href_match.group(1))) if href_match else search_url
        key = f"{normalize_title(name)}:{price + shipping}:{detail_url}"
        if key in seen:
            continue
        seen.add(key)
        products.append(
            {
                "source": "coupang",
                "mall": "쿠팡",
                "name": name,
                "price": price,
                "registered_price": registered_price,
                "shipping": shipping,
                "total": price + shipping,
                "url": detail_url,
            }
        )
        if len(products) >= limit:
            break
    return products


def fetch_coupang_products(query: str, sort_mode: str, display: int = 30) -> list[dict[str, Any]]:
    search_url = coupang_search_url(query, sort_mode, display)
    status, body = read_url(
        search_url,
        {
            "Referer": "https://www.coupang.com/",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        },
    )
    if status != 200:
        raise RuntimeError(f"쿠팡 검색 페이지 수집 오류: HTTP {status}")
    if any(marker in body.lower() for marker in ("access denied", "captcha", "forbidden")):
        raise RuntimeError("쿠팡이 현재 자동 요청을 차단함")
    products = parse_coupang_products(body, search_url, limit=display)
    if not products:
        raise RuntimeError("쿠팡 검색 결과 파싱 실패 또는 결과 없음")
    return mark_extraction_method(products, "crawl")


def fetch_coupang_playwright_products(query: str, sort_mode: str, display: int = 30) -> list[dict[str, Any]]:
    if not PLAYWRIGHT_SEARCH_ENABLED:
        return []
    if sync_playwright is None:
        raise RuntimeError("Playwright 검색 모듈이 설치되지 않음")
    search_url = coupang_search_url(query, sort_mode, display)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            page = browser.new_page(locale="ko-KR", user_agent=CRAWLER_USER_AGENT)
            page.goto(search_url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT_MS)
            page.wait_for_timeout(1200)
            products = parse_coupang_products(page.content(), search_url, limit=display)
        finally:
            browser.close()
    if not products:
        raise RuntimeError("쿠팡 Playwright 렌더링 결과 파싱 실패 또는 결과 없음")
    return mark_extraction_method(products, "playwright")


def fetch_coupang_scrapling_products(query: str, sort_mode: str, display: int = 30) -> list[dict[str, Any]]:
    if not SCRAPLING_SEARCH_ENABLED:
        return []
    if ScraplingFetcher is None:
        raise RuntimeError("Scrapling 검색 모듈이 설치되지 않음")
    search_url = coupang_search_url(query, sort_mode, display)
    response = ScraplingFetcher.get(
        search_url,
        timeout=HTTP_TIMEOUT_SECONDS,
        impersonate="chrome",
        headers={"Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8", "Referer": "https://www.coupang.com/"},
    )
    if int(response.status) != 200:
        raise RuntimeError(f"쿠팡 Scrapling 수집 오류: HTTP {response.status}")
    document = response.body.decode("utf-8", errors="replace")
    products = parse_coupang_products(document, search_url, limit=display)
    if not products:
        raise RuntimeError("쿠팡 Scrapling 결과 파싱 실패 또는 결과 없음")
    return mark_extraction_method(products, "scrapling")


COMPETITOR_MALL_KEYS = (
    "mallName", "mall_name", "mall", "storeName", "store_name", "sellerName", "seller_name",
    "shopName", "shop_name", "merchantName", "merchant_name", "companyName", "company_name",
    "vendorName", "vendor_name", "seller", "shop",
)
COMPETITOR_TITLE_KEYS = (
    "productName", "product_name", "productTitle", "product_title", "goodsName", "goods_name",
    "name", "title",
)
COMPETITOR_PRICE_KEYS = (
    "price", "salePrice", "sale_price", "lowPrice", "low_price", "lowestPrice", "lowest_price",
    "finalPrice", "final_price", "minPrice", "min_price", "productPrice", "product_price",
    "mobileLowPrice", "mobile_low_price", "discountedPrice", "discounted_price",
)
COMPETITOR_SHIPPING_KEYS = (
    "deliveryFee", "delivery_fee", "shippingFee", "shipping_fee", "deliveryPrice", "delivery_price",
    "dlvryPrice", "dlvry_price",
)
COMPETITOR_URL_KEYS = (
    "url", "link", "productUrl", "product_url", "mallProductUrl", "mall_product_url",
    "detailUrl", "detail_url", "crUrl", "cr_url",
)
COMPETITOR_EXCLUDE_TERMS = (
    "중고", "리퍼", "리퍼비시", "반품", "전시", "파손", "부품용", "케이스", "파우치",
    "필름", "보호필름", "스킨", "호환", "어댑터", "충전기", "키스킨",
)


def first_text_value(data: dict[str, Any], keys: tuple[str, ...]) -> str:
    for key in keys:
        value = data.get(key)
        if value is None:
            continue
        if isinstance(value, (str, int, float)):
            text = clean_text(str(value))
            if text:
                return text
    return ""


def first_price_value(data: dict[str, Any], keys: tuple[str, ...]) -> int:
    for key in keys:
        value = data.get(key)
        if value is None:
            continue
        price = parse_price(value)
        if price > 0:
            return price
    return 0


def json_competitor_candidates(data: Any, base_url: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            mall = first_text_value(value, COMPETITOR_MALL_KEYS)
            title = first_text_value(value, COMPETITOR_TITLE_KEYS)
            sale_price = first_price_value(value, COMPETITOR_PRICE_KEYS)
            shipping_fee = first_price_value(value, COMPETITOR_SHIPPING_KEYS)
            detail_url = first_text_value(value, COMPETITOR_URL_KEYS)
            if mall and sale_price > 0:
                candidates.append(
                    {
                        "mall": mall,
                        "title": title or mall,
                        "sale_price": sale_price,
                        "shipping_fee": shipping_fee,
                        "total_price": sale_price + shipping_fee,
                        "detail_url": urllib.parse.urljoin(base_url, html.unescape(detail_url)) if detail_url else "",
                    }
                )
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(data)
    return candidates


def extract_script_json_competitors(document: str, base_url: str) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    scripts = re.finditer(
        r"<script\b[^>]*(?:type=[\"']application/(?:json|ld\+json)[\"']|id=[\"']__NEXT_DATA__[\"'])[^>]*>(.*?)</script>",
        document,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for script in scripts:
        raw_json = html.unescape(script.group(1).strip())
        if not raw_json:
            continue
        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        candidates.extend(json_competitor_candidates(data, base_url))
    return candidates


def html_competitor_candidates(document: str, base_url: str) -> list[dict[str, Any]]:
    block_pattern = re.compile(
        r"<(?P<tag>li|tr|div)\b[^>]*(?:mall|seller|shop|price|prod|goods|compare)[^>]*>.*?</(?P=tag)>",
        flags=re.IGNORECASE | re.DOTALL,
    )
    candidates: list[dict[str, Any]] = []
    for match in block_pattern.finditer(document):
        block = match.group(0)
        text = clean_text(block)
        if len(text) < 5 or "원" not in text:
            continue
        price_match = re.search(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", text)
        data_price_match = re.search(r"data-[^=]*price=[\"']([\d,]+)[\"']", block, flags=re.IGNORECASE)
        price = parse_price(data_price_match.group(1) if data_price_match else price_match.group(1) if price_match else "")
        if price <= 0:
            continue
        href_match = re.search(r"<a\b[^>]+href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", block, flags=re.IGNORECASE | re.DOTALL)
        mall_match = re.search(
            r"class=[\"'][^\"']*(?:mall|seller|shop|company|logo)[^\"']*[\"'][^>]*>(.*?)</(?:a|span|div|p)>",
            block,
            flags=re.IGNORECASE | re.DOTALL,
        )
        title_match = re.search(
            r"class=[\"'][^\"']*(?:prod|goods|title|name)[^\"']*[\"'][^>]*>(.*?)</(?:a|span|div|p|strong)>",
            block,
            flags=re.IGNORECASE | re.DOTALL,
        )
        link_text = clean_text(href_match.group(2)) if href_match else ""
        mall = clean_text(mall_match.group(1)) if mall_match else ""
        title = clean_text(title_match.group(1)) if title_match else ""
        if not mall:
            mall = link_text[:40]
        if not title:
            title = link_text or text[:80]
        detail_url = urllib.parse.urljoin(base_url, html.unescape(href_match.group(1))) if href_match else ""
        candidates.append(
            {
                "mall": mall or "판매처",
                "title": title,
                "sale_price": price,
                "shipping_fee": 0,
                "total_price": price,
                "detail_url": detail_url,
            }
        )
    return candidates


def normalize_competitor_candidates(candidates: list[dict[str, Any]], limit: int = MAX_COMPETITOR_SNAPSHOT_ROWS) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for item in candidates:
        sale_price = parse_price(item.get("sale_price"))
        shipping_fee = parse_price(item.get("shipping_fee"))
        total_price = parse_price(item.get("total_price")) or sale_price + shipping_fee
        if sale_price <= 0 and total_price <= 0:
            continue
        title = clean_text(str(item.get("title") or ""))
        mall = clean_text(str(item.get("mall") or "판매처"))
        detail_url = str(item.get("detail_url") or "").strip()
        key = "|".join((normalize_title(mall), normalize_title(title), str(total_price), detail_url))
        if key in unique:
            continue
        combined = f"{mall} {title}"
        exclusion_reason = next((term for term in COMPETITOR_EXCLUDE_TERMS if term in combined), "")
        unique[key] = {
            "mall": mall,
            "title": title or mall,
            "sale_price": sale_price or total_price,
            "shipping_fee": shipping_fee,
            "total_price": total_price or sale_price + shipping_fee,
            "detail_url": detail_url,
            "is_excluded": bool(exclusion_reason),
            "exclusion_reason": f"제외어: {exclusion_reason}" if exclusion_reason else "",
        }

    values = sorted(unique.values(), key=lambda item: (item["is_excluded"], item["total_price"], item["mall"]))
    valid_prices = [item["total_price"] for item in values if not item["is_excluded"]]
    if len(valid_prices) >= 4:
        middle = len(valid_prices) // 2
        median = valid_prices[middle] if len(valid_prices) % 2 else (valid_prices[middle - 1] + valid_prices[middle]) / 2
        for item in values:
            if item["is_excluded"]:
                continue
            if item["total_price"] < median * 0.35 or item["total_price"] > median * 3:
                item["is_excluded"] = True
                item["exclusion_reason"] = "중앙 가격대에서 크게 벗어난 가격"
    return values[:limit]


def fetch_comparison_competitors(platform: str, comparison_url: str, limit: int = MAX_COMPETITOR_SNAPSHOT_ROWS) -> list[dict[str, Any]]:
    safe_url = assert_public_product_url(comparison_url)
    status, body = read_url(safe_url, {"Referer": safe_url})
    if status != 200:
        raise RuntimeError(f"{COMPARISON_PLATFORM_LABELS.get(platform, platform)} 가격비교 URL 수집 오류: HTTP {status}")
    if any(marker in body.lower() for marker in ("captcha", "access denied")):
        raise RuntimeError("가격비교 페이지가 자동 요청을 차단했습니다.")
    candidates = [
        *extract_script_json_competitors(body, safe_url),
        *html_competitor_candidates(body, safe_url),
    ]
    if platform == "danawa":
        candidates.extend(
            {
                "mall": product.get("mall") or "다나와",
                "title": product.get("name") or "",
                "sale_price": product.get("price") or 0,
                "shipping_fee": product.get("shipping") or 0,
                "total_price": product.get("total") or 0,
                "detail_url": product.get("url") or "",
            }
            for product in parse_danawa_products(body, limit=limit)
        )
    if platform == "enuri":
        candidates.extend(
            {
                "mall": product.get("mall") or "에누리",
                "title": product.get("name") or "",
                "sale_price": product.get("price") or 0,
                "shipping_fee": product.get("shipping") or 0,
                "total_price": product.get("total") or 0,
                "detail_url": product.get("url") or "",
            }
            for product in parse_enuri_products(body, limit=limit)
        )
    if platform == "coupang":
        candidates.extend(
            {
                "mall": product.get("mall") or "쿠팡",
                "title": product.get("name") or "",
                "sale_price": product.get("price") or 0,
                "shipping_fee": product.get("shipping") or 0,
                "total_price": product.get("total") or 0,
                "detail_url": product.get("url") or "",
            }
            for product in parse_coupang_products(body, safe_url, limit=limit)
        )
    competitors = normalize_competitor_candidates(candidates, limit=limit)
    if not competitors:
        raise RuntimeError("가격비교 페이지에서 경쟁 판매처를 찾지 못했습니다.")
    return competitors


def dedupe_products(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    indexes: dict[str, int] = {}
    unique_items: list[dict[str, Any]] = []
    for item in items:
        price = parse_price(item.get("price"))
        shipping = parse_price(item.get("shipping"))
        total = parse_price(item.get("total")) or price + shipping
        key = f"{item.get('mall')}:{normalize_title(str(item.get('name', '')))}:{total}"
        methods = [str(method) for method in item.get("extraction_methods", []) if method]
        if key in indexes:
            existing = unique_items[indexes[key]]
            existing_methods = list(existing.get("extraction_methods", []))
            existing["extraction_methods"] = list(dict.fromkeys([*existing_methods, *methods]))
            registered_price = parse_price(item.get("registered_price"))
            if registered_price > parse_price(existing.get("registered_price")):
                existing["registered_price"] = registered_price
            continue
        normalized = dict(item)
        normalized["price"] = price
        normalized["registered_price"] = parse_price(normalized.get("registered_price")) or normalized["price"]
        if normalized["registered_price"] < normalized["price"]:
            normalized["registered_price"] = normalized["price"]
        normalized["shipping"] = shipping
        normalized["total"] = normalized["price"] + normalized["shipping"]
        normalized["extraction_methods"] = list(dict.fromkeys(methods))
        indexes[key] = len(unique_items)
        unique_items.append(normalized)
    return unique_items


BENEFIT_KEYWORDS = {
    "쿠폰": ("쿠폰적용가", "쿠폰 적용가", "쿠폰가", "쿠폰할인가", "쿠폰 할인가", "쿠폰할인", "쿠폰 할인"),
    "행사": ("행사가", "특가", "즉시할인가", "즉시 할인가", "할인판매가"),
    "카드": ("카드할인가", "카드 할인가", "카드혜택가", "카드 혜택가"),
}
CONDITIONAL_BENEFIT_TERMS = (
    "로그인", "회원가", "멤버십", "앱 전용", "앱전용", "특정 카드", "카드 결제",
    "쿠폰받기", "쿠폰 받기", "다운로드 쿠폰", "첫 구매", "신규회원",
)


def assert_public_product_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("상세조사할 수 없는 상품 URL")
    try:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(parsed.hostname, parsed.port or 443)}
    except socket.gaierror as error:
        raise RuntimeError("상품 주소를 확인하지 못함") from error
    if any(ipaddress.ip_address(address).is_private or ipaddress.ip_address(address).is_loopback for address in addresses):
        raise RuntimeError("내부 네트워크 상품 주소는 조사할 수 없음")
    return url


def benefit_visible_text(document: str) -> str:
    without_scripts = re.sub(
        r"<(?:script|style|noscript)[^>]*>.*?</(?:script|style|noscript)>",
        " ",
        document,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return clean_text(without_scripts)[:500_000]


def benefit_price_near_keywords(text: str, keywords: tuple[str, ...], reference_price: int) -> int:
    candidates: list[int] = []
    keyword_pattern = "|".join(re.escape(keyword) for keyword in keywords)
    amount_pattern = r"(\d{1,3}(?:,\d{3})+|\d{3,9})\s*원"
    patterns = (
        rf"(?:{keyword_pattern})[^\d]{{0,70}}{amount_pattern}",
        rf"{amount_pattern}[^\d가-힣]{{0,35}}(?:{keyword_pattern})",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            value = parse_price(match.group(1))
            if value <= 0:
                continue
            if reference_price and not (reference_price * 0.15 <= value <= reference_price * 1.25):
                continue
            candidates.append(value)
    return min(candidates, default=0)


def detail_price_stack(text: str, reference_price: int) -> dict[str, int]:
    price_area = text[:80_000]
    lower_bound = int(reference_price * 0.35) if reference_price else 1_000
    upper_bound = int(reference_price * 1.45) if reference_price else 20_000_000
    prices: list[int] = []
    for match in re.finditer(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", price_area):
        context = price_area[max(0, match.start() - 35) : min(len(price_area), match.end() + 35)]
        if re.search(r"배송비|반품|교환|적립|캐시|월\s*\d|개월|할부|판매자\s*평가|리뷰|문의", context):
            continue
        price = parse_price(match.group(1))
        if lower_bound <= price <= upper_bound:
            prices.append(price)

    unique_prices = list(dict.fromkeys(prices))
    if not unique_prices:
        return {"registered_price": 0, "display_price": 0}

    display_price = min(unique_prices)
    registered_price = max(unique_prices)
    if registered_price < display_price:
        registered_price = display_price
    return {"registered_price": registered_price, "display_price": display_price}


def parse_benefit_detail(text: str, reference_price: int, fallback_shipping: int) -> dict[str, Any]:
    price_stack = detail_price_stack(text, reference_price)
    coupon_price = benefit_price_near_keywords(text, BENEFIT_KEYWORDS["쿠폰"], reference_price)
    event_price = benefit_price_near_keywords(text, BENEFIT_KEYWORDS["행사"], reference_price)
    card_price = benefit_price_near_keywords(text, BENEFIT_KEYWORDS["카드"], reference_price)
    detected_labels = [
        label
        for label, keywords in BENEFIT_KEYWORDS.items()
        if any(keyword.lower() in text.lower() for keyword in keywords)
    ]
    condition_terms = [term for term in CONDITIONAL_BENEFIT_TERMS if term.lower() in text.lower()]
    shipping = 0 if "무료배송" in text.replace(" ", "") else fallback_shipping
    shipping_match = re.search(r"배송비[^\d]{0,30}(\d{1,3}(?:,\d{3})+|\d{3,7})\s*원", text)
    if shipping_match:
        parsed_shipping = parse_price(shipping_match.group(1))
        if 0 < parsed_shipping <= 100_000 and parsed_shipping != reference_price:
            shipping = parsed_shipping

    price_candidates = [price for price in (coupon_price, event_price, card_price) if price > 0]
    benefit_price = min(price_candidates, default=0)
    if price_stack["display_price"] > 0 and (not reference_price or price_stack["display_price"] <= reference_price):
        benefit_price = min([price for price in (benefit_price, price_stack["display_price"]) if price > 0], default=0)
    if benefit_price:
        status = "conditional" if condition_terms or card_price == benefit_price else "confirmed"
    elif detected_labels or condition_terms:
        status = "conditional"
    else:
        status = "none"
    summary_parts = [label for label in detected_labels]
    if "상품권" in text:
        summary_parts.append("상품권")
    if "적립" in text:
        summary_parts.append("적립")
    return {
        "benefit_status": status,
        "coupon_price": coupon_price,
        "event_price": event_price,
        "card_price": card_price,
        "benefit_price": benefit_price,
        "registered_price": price_stack["registered_price"],
        "display_price": price_stack["display_price"],
        "benefit_shipping": shipping,
        "benefit_summary": " · ".join(dict.fromkeys(summary_parts)),
        "benefit_condition": " · ".join(dict.fromkeys(condition_terms)),
    }


def fetch_benefit_detail(url: str, reference_price: int, fallback_shipping: int) -> dict[str, Any]:
    safe_url = assert_public_product_url(url)
    texts: list[str] = []
    methods: list[str] = []
    errors: list[str] = []

    if SCRAPLING_SEARCH_ENABLED and ScraplingFetcher is not None:
        try:
            response = ScraplingFetcher.get(
                safe_url,
                timeout=HTTP_TIMEOUT_SECONDS,
                impersonate="chrome",
                headers={"Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"},
            )
            if int(response.status) == 200:
                texts.append(benefit_visible_text(response.body.decode("utf-8", errors="replace")))
                methods.append("scrapling")
            else:
                errors.append(f"Scrapling HTTP {response.status}")
        except Exception as error:
            errors.append(f"Scrapling {error}")
    else:
        try:
            status, document = read_url(safe_url)
            if status == 200:
                texts.append(benefit_visible_text(document))
                methods.append("crawl")
        except Exception as error:
            errors.append(f"크롤링 {error}")

    if PLAYWRIGHT_SEARCH_ENABLED and sync_playwright is not None:
        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
                try:
                    page = browser.new_page(locale="ko-KR", user_agent=CRAWLER_USER_AGENT)
                    page.goto(safe_url, wait_until="domcontentloaded", timeout=PLAYWRIGHT_TIMEOUT_MS)
                    page.wait_for_timeout(1200)
                    texts.append(page.locator("body").inner_text(timeout=5000)[:500_000])
                    methods.append("playwright")
                finally:
                    browser.close()
        except Exception as error:
            errors.append(f"Playwright {error}")

    if not texts:
        return {
            "benefit_status": "failed",
            "coupon_price": 0,
            "event_price": 0,
            "card_price": 0,
            "benefit_price": 0,
            "registered_price": 0,
            "display_price": 0,
            "benefit_shipping": fallback_shipping,
            "benefit_summary": "",
            "benefit_condition": " · ".join(errors)[:500] or "상세페이지 확인 실패",
            "detail_methods": methods,
        }
    parsed = parse_benefit_detail(" ".join(texts), reference_price, fallback_shipping)
    parsed["detail_methods"] = list(dict.fromkeys(methods))
    return parsed


def coupang_browser_detail_targets(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    for row in rows:
        url = str(row["url"] or "")
        if row["source"] == "coupang" or "coupang.com" in url:
            targets.append(
                {
                    "id": row["id"],
                    "url": url,
                    "name": row["name"],
                    "total": int(row["total"] or row["price"] or 0),
                    "shipping": int(row["shipping"] or 0),
                }
            )
    return targets


def access_denied_text(text: str) -> bool:
    return bool(re.search(r"access denied|forbidden|권한|접근이\s*거부|captcha", text, flags=re.IGNORECASE))


def require_coupang_browser_automation() -> None:
    if not COUPANG_BROWSER_AUTOMATION_ENABLED:
        raise RuntimeError("쿠팡 브라우저 자동수집이 비활성화됨")
    if sync_playwright is None:
        raise RuntimeError("Playwright 브라우저 자동수집 모듈이 설치되지 않음")


def local_browser_executable() -> str | None:
    for executable in LOCAL_BROWSER_EXECUTABLES:
        if executable.exists():
            return str(executable)
    return None


def playwright_browser_executables() -> list[Path]:
    cache_dir = Path.home() / "Library" / "Caches" / "ms-playwright"
    if not cache_dir.exists():
        return []
    patterns = [
        "chromium-*/chrome-mac*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium",
    ]
    candidates: list[Path] = []
    for pattern in patterns:
        candidates.extend(path for path in cache_dir.glob(pattern) if path.exists())
    return sorted(candidates, key=lambda path: path.stat().st_mtime, reverse=True)


def extension_browser_executable() -> tuple[str | None, bool]:
    configured = os.getenv("PRICESCAN_EXTENSION_BROWSER_EXECUTABLE")
    if configured:
        path = Path(configured)
        if path.exists():
            return str(path), "Chrome for Testing" in path.name or "Chromium" in path.name
    for executable in playwright_browser_executables():
        return str(executable), True
    for executable in EXTENSION_COMPATIBLE_BROWSER_EXECUTABLES:
        if executable.exists():
            return str(executable), True
    fallback = local_browser_executable()
    return fallback, False


def launch_coupang_browser_context(playwright: Any, timeout_ms: int) -> Any:
    executable_path = local_browser_executable()
    launch_options: dict[str, Any] = {
        "headless": False,
        "locale": "ko-KR",
        "viewport": {"width": 1420, "height": 980},
        "args": ["--start-maximized"],
        "chromium_sandbox": True,
        "ignore_default_args": ["--enable-automation"],
        "slow_mo": 180,
        "timeout": timeout_ms,
    }
    if executable_path:
        launch_options["executable_path"] = executable_path
    try:
        return playwright.chromium.launch_persistent_context(str(COUPANG_BROWSER_SESSION_DIR), **launch_options)
    except Exception as error:
        if executable_path:
            raise
        raise RuntimeError("브라우저 실행파일이 없습니다. backend/.venv312/bin/python -m playwright install chromium 실행이 필요합니다.") from error


def open_coupang_search_like_user(page: Any, query: str, sort_mode: str, timeout_ms: int) -> str:
    search_url = coupang_search_url(query, sort_mode, SEARCH_LINE_SOURCE_LIMIT)
    page.goto("https://www.coupang.com/", wait_until="domcontentloaded", timeout=timeout_ms)
    page.wait_for_timeout(1400)
    body_text = page.locator("body").inner_text(timeout=min(timeout_ms, 8000))[:80_000]
    if access_denied_text(body_text):
        raise RuntimeError("쿠팡 홈 화면이 접근 거부 상태입니다. 열린 Chrome에서 일반 쿠팡 접속이 가능한지 먼저 확인하세요.")

    search_input = None
    selectors = (
        "input[name='q']",
        "input#headerSearchKeyword",
        "input[title*='검색']",
        "input[placeholder*='검색']",
        "input[placeholder*='찾고']",
    )
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if locator.count() > 0 and locator.is_visible(timeout=1200):
                search_input = locator
                break
        except Exception:
            continue

    if search_input is None:
        page.goto(search_url, wait_until="domcontentloaded", timeout=timeout_ms)
    else:
        search_input.click(timeout=3000)
        search_input.fill(query, timeout=3000)
        search_input.press("Enter", timeout=3000)

    try:
        page.wait_for_url(re.compile(r"/np/search|/np/campaigns|/vp/products"), timeout=timeout_ms)
    except Exception:
        pass
    page.wait_for_timeout(1800)

    if sort_mode == "lowest":
        try:
            lowest_link = page.locator("a:has-text('낮은 가격순'), button:has-text('낮은 가격순'), a:has-text('가격 낮은순'), button:has-text('가격 낮은순')").first
            if lowest_link.count() > 0 and lowest_link.is_visible(timeout=1200):
                lowest_link.click(timeout=3000)
                page.wait_for_timeout(1200)
        except Exception:
            pass

    return page.url or search_url


def visible_coupang_detail_details(targets: list[dict[str, Any]], approval_wait_seconds: int = 35) -> tuple[dict[str, dict[str, Any]], list[str]]:
    if not targets:
        return {}, []
    require_coupang_browser_automation()
    COUPANG_BROWSER_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    details: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    timeout_ms = max(PLAYWRIGHT_TIMEOUT_MS, approval_wait_seconds * 1000)

    with COUPANG_BROWSER_LOCK:
        with sync_playwright() as playwright:
            context = launch_coupang_browser_context(playwright, timeout_ms)
            page = context.pages[0] if context.pages else context.new_page()
            try:
                for index, target in enumerate(targets):
                    url = assert_public_product_url(str(target["url"]))
                    try:
                        page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                        page.wait_for_timeout(1600 if index else 2400)
                        body_text = page.locator("body").inner_text(timeout=min(timeout_ms, 8000))[:500_000]
                        if access_denied_text(body_text):
                            raise RuntimeError("쿠팡 브라우저 화면이 접근 거부/보안확인 상태입니다. 열린 브라우저에서 확인을 완료한 뒤 다시 실행하세요.")
                        detail = parse_benefit_detail(body_text, int(target["total"]), int(target["shipping"]))
                        detail["detail_methods"] = ["browser"]
                        if detail["display_price"] <= 0 and detail["benefit_price"] <= 0:
                            detail["benefit_status"] = "conditional"
                            detail["benefit_condition"] = "브라우저 화면에서 가격 묶음을 찾지 못함"
                        details[str(target["id"])] = detail
                    except Exception as error:
                        warnings.append(f"{str(target['name'])[:36]}: {error}")
                        details[str(target["id"])] = {
                            "benefit_status": "failed",
                            "coupon_price": 0,
                            "event_price": 0,
                            "card_price": 0,
                            "benefit_price": 0,
                            "registered_price": 0,
                            "display_price": 0,
                            "benefit_shipping": int(target["shipping"]),
                            "benefit_summary": "",
                            "benefit_condition": str(error)[:500],
                            "detail_methods": ["browser"],
                        }
                    page.wait_for_timeout(700)
            finally:
                context.close()
    return details, warnings


def apply_detail_to_product(product: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any]:
    updated = dict(product)
    next_price = int(detail.get("display_price") or detail.get("benefit_price") or updated.get("price") or 0)
    next_shipping = int(detail.get("benefit_shipping") if detail.get("benefit_shipping") is not None else updated.get("shipping") or 0)
    next_registered_price = int(detail.get("registered_price") or updated.get("registered_price") or next_price)
    if next_registered_price < next_price:
        next_registered_price = next_price
    updated.update(
        {
            "price": next_price,
            "registered_price": next_registered_price,
            "shipping": next_shipping,
            "total": next_price + next_shipping,
            "benefit_status": detail.get("benefit_status", "none"),
            "coupon_price": int(detail.get("coupon_price") or 0),
            "event_price": int(detail.get("event_price") or 0),
            "card_price": int(detail.get("card_price") or 0),
            "benefit_price": int(detail.get("benefit_price") or 0),
            "benefit_shipping": next_shipping,
            "benefit_summary": str(detail.get("benefit_summary") or ""),
            "benefit_condition": str(detail.get("benefit_condition") or ""),
            "detail_methods": list(detail.get("detail_methods") or ["browser"]),
            "benefit_checked_at": now(),
        }
    )
    return updated


def applescript_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def run_osascript(script: str, timeout_seconds: int = 30) -> str:
    try:
        completed = subprocess.run(
            ["osascript"],
            input=script,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except FileNotFoundError as error:
        raise RuntimeError("macOS AppleScript 실행기가 없습니다.") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Chrome 응답 대기 시간이 초과되었습니다.") from error
    if completed.returncode != 0:
        message = (completed.stderr or completed.stdout or "").strip()
        if "Allow JavaScript from Apple Events" in message or "not allowed" in message or "JavaScript" in message:
            raise RuntimeError("Chrome에서 '보기 > 개발자 > Apple Events에서 JavaScript 허용'을 먼저 켜야 합니다.")
        raise RuntimeError(message or "Chrome AppleScript 실행 실패")
    return completed.stdout.strip()


def chrome_execute_javascript(js: str, timeout_seconds: int = 30) -> str:
    script = f"""
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  execute javascript {applescript_quote(js)} in active tab of front window
end tell
"""
    return run_osascript(script, timeout_seconds=timeout_seconds)


def chrome_open_url(url: str, timeout_seconds: int = 20) -> None:
    script = f"""
tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to {applescript_quote(url)}
end tell
"""
    run_osascript(script, timeout_seconds=timeout_seconds)


def chrome_current_url(timeout_seconds: int = 10) -> str:
    script = """
tell application "Google Chrome"
  if (count of windows) = 0 then return ""
  return URL of active tab of front window
end tell
"""
    return run_osascript(script, timeout_seconds=timeout_seconds)


def chrome_wait_for_text(timeout_seconds: int = 35) -> str:
    deadline = time.time() + timeout_seconds
    last_text = ""
    while time.time() < deadline:
        try:
            text = chrome_execute_javascript("document.body ? document.body.innerText : ''", timeout_seconds=8)
            if text:
                last_text = text
                if "로딩" not in text[:200] or "원" in text or access_denied_text(text):
                    return text
        except Exception:
            pass
        time.sleep(1.0)
    return last_text


def chrome_extract_coupang_rows(timeout_seconds: int = 20) -> list[dict[str, str]]:
    js = r"""
(() => {
  const seen = new Set();
  const rows = [];
  const anchors = Array.from(document.querySelectorAll("a[href*='/vp/products/'], a[href*='/np/products/'], a[href*='/products/']"));
  for (const anchor of anchors) {
    const href = anchor.href || "";
    if (!href || seen.has(href)) continue;
    let card = anchor.closest("li, [class*='search-product'], [class*='ProductUnit'], [class*='product'], [class*='ProductCard']");
    if (!card) card = anchor;
    const text = (card.innerText || anchor.innerText || "").trim();
    if (!text || !/[0-9][0-9,]*\s*원/.test(text)) continue;
    seen.add(href);
    rows.push({url: href, text});
    if (rows.length >= 20) break;
  }
  return JSON.stringify(rows);
})()
"""
    raw = chrome_execute_javascript(js, timeout_seconds=timeout_seconds)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return []
    return [row for row in data if isinstance(row, dict)]


def product_from_coupang_browser_row(row: dict[str, str], fallback_url: str) -> dict[str, Any] | None:
    text = str(row.get("text") or "")
    lines = [clean_text(line) for line in text.splitlines() if clean_text(line)]
    price_lines = [
        line
        for line in lines
        if re.search(r"\d[\d,]*\s*원|\d{4,}", line)
        and not re.search(r"배송비|월\s*\d|개월|적립|캐시|리뷰|평점", line)
    ]
    price_values = [parse_price(line) for line in price_lines if parse_price(line) > 0]
    if not price_values:
        return None
    exposure_price = min(price_values) if len(price_values) >= 2 and re.search(r"쿠폰|할인|정가|즉시", text) else price_values[0]
    registered_price = max(price_values) if len(price_values) >= 2 else exposure_price

    price_index = next((index for index, line in enumerate(lines) if line in price_lines), 0)
    name_candidates = [
        line
        for line in lines[: max(price_index, 1) + 1]
        if not looks_like_non_product_coupang_line(line)
        and not re.search(r"\d[\d,]*\s*원|무료배송|로켓|광고|별점|평점|리뷰", line)
    ]
    name = name_candidates[-1] if name_candidates else (lines[0] if lines else "")
    if not name or parse_price(name) > 0:
        return None
    return product_from_browser_input(
        BrowserPriceItemInput(
            name=name,
            mall="쿠팡",
            price=exposure_price,
            registered_price=registered_price,
            shipping=0 if "무료배송" in text.replace(" ", "") else 0,
            url=str(row.get("url") or ""),
        ),
        "coupang",
        fallback_url,
    )


def chrome_search_coupang_like_user(query: str, sort_mode: str, approval_wait_seconds: int) -> str:
    if not COUPANG_REAL_CHROME_ENABLED:
        raise RuntimeError("실제 Chrome 세션 수집이 비활성화됨")
    chrome_open_url("https://www.coupang.com/")
    time.sleep(2.0)
    home_text = chrome_wait_for_text(timeout_seconds=max(8, min(approval_wait_seconds, 25)))
    if access_denied_text(home_text):
        raise RuntimeError("일반 Chrome에서도 쿠팡 홈이 Access Denied 상태입니다. 브라우저에서 쿠팡 접속이 정상인지 먼저 확인해야 합니다.")

    query_json = json.dumps(query, ensure_ascii=False)
    js = f"""
(() => {{
  const query = {query_json};
  const selectors = ["input[name='q']", "input#headerSearchKeyword", "input[title*='검색']", "input[placeholder*='검색']", "input[placeholder*='찾고']"];
  let input = null;
  for (const selector of selectors) {{
    input = document.querySelector(selector);
    if (input) break;
  }}
  if (!input) return "NO_INPUT";
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event("input", {{ bubbles: true }}));
  input.dispatchEvent(new Event("change", {{ bubbles: true }}));
  const form = input.closest("form");
  if (form) {{
    form.submit();
  }} else {{
    input.dispatchEvent(new KeyboardEvent("keydown", {{ key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }}));
  }}
  return "OK";
}})()
"""
    result = chrome_execute_javascript(js, timeout_seconds=12)
    if result != "OK":
        chrome_open_url(coupang_search_url(query, sort_mode, SEARCH_LINE_SOURCE_LIMIT))
    time.sleep(3.0)
    return chrome_current_url() or coupang_search_url(query, sort_mode, SEARCH_LINE_SOURCE_LIMIT)


def collect_coupang_real_chrome_products(payload: CoupangAutoCollectPayload) -> tuple[list[dict[str, Any]], list[str], str]:
    query = payload.query.strip()
    warnings: list[str] = []
    search_url = chrome_search_coupang_like_user(query, payload.sort_mode, payload.approval_wait_seconds)
    body_text = chrome_wait_for_text(timeout_seconds=payload.approval_wait_seconds)
    if access_denied_text(body_text):
        raise RuntimeError("실제 Chrome 세션에서도 쿠팡 검색결과가 Access Denied 상태입니다.")

    rows = chrome_extract_coupang_rows(timeout_seconds=18)
    products = [
        product
        for product in (product_from_coupang_browser_row(row, search_url) for row in rows)
        if product
    ]
    if not products:
        products = parse_browser_raw_text_products(body_text, "coupang", search_url)
    products = dedupe_products(mark_extraction_method(products, "browser"))[:MAX_BROWSER_COLLECTION_ROWS]
    if not products:
        raise RuntimeError("실제 Chrome 화면에서 쿠팡 검색 결과를 찾지 못했습니다.")

    enriched: list[dict[str, Any]] = []
    for index, product in enumerate(products):
        if index >= payload.detail_limit or "coupang.com" not in str(product.get("url", "")):
            enriched.append(product)
            continue
        try:
            chrome_open_url(str(product["url"]))
            time.sleep(2.2)
            detail_text = chrome_wait_for_text(timeout_seconds=max(10, min(payload.approval_wait_seconds, 35)))
            if access_denied_text(detail_text):
                raise RuntimeError("상세페이지 Access Denied")
            detail = parse_benefit_detail(detail_text, int(product["total"]), int(product["shipping"]))
            detail["detail_methods"] = ["browser"]
            enriched.append(apply_detail_to_product(product, detail))
        except Exception as error:
            warnings.append(f"{str(product['name'])[:36]} 상세수집 실패: {error}")
            enriched.append(product)
        time.sleep(0.8)
    return enriched, warnings, search_url


def collect_coupang_visible_browser_products(payload: CoupangAutoCollectPayload) -> tuple[list[dict[str, Any]], list[str], str]:
    require_coupang_browser_automation()
    COUPANG_BROWSER_SESSION_DIR.mkdir(parents=True, exist_ok=True)
    query = payload.query.strip()
    search_url = coupang_search_url(query, payload.sort_mode, SEARCH_LINE_SOURCE_LIMIT)
    timeout_ms = max(PLAYWRIGHT_TIMEOUT_MS, payload.approval_wait_seconds * 1000)
    warnings: list[str] = []

    with COUPANG_BROWSER_LOCK:
        with sync_playwright() as playwright:
            context = launch_coupang_browser_context(playwright, timeout_ms)
            page = context.pages[0] if context.pages else context.new_page()
            try:
                search_url = open_coupang_search_like_user(page, query, payload.sort_mode, timeout_ms)
                try:
                    page.wait_for_selector("a[href*='/vp/products/'], li.search-product, [class*='ProductUnit']", timeout=timeout_ms)
                except Exception:
                    pass
                page.wait_for_timeout(1800)
                body_text = page.locator("body").inner_text(timeout=min(timeout_ms, 8000))[:500_000]
                if access_denied_text(body_text):
                    raise RuntimeError("쿠팡 검색 화면이 접근 거부/보안확인 상태입니다. 열린 브라우저에서 확인을 완료한 뒤 다시 실행하세요.")
                products = parse_coupang_products(page.content(), search_url, limit=MAX_BROWSER_COLLECTION_ROWS)
                if not products:
                    products = parse_browser_raw_text_products(body_text, "coupang", search_url)
                products = dedupe_products(mark_extraction_method(products, "browser"))[:MAX_BROWSER_COLLECTION_ROWS]
                if not products:
                    raise RuntimeError("쿠팡 브라우저 화면에서 검색 결과를 찾지 못했습니다.")

                detail_targets = [
                    {
                        "id": str(index),
                        "url": product["url"],
                        "name": product["name"],
                        "total": product["total"],
                        "shipping": product["shipping"],
                    }
                    for index, product in enumerate(products[: payload.detail_limit])
                    if "coupang.com" in str(product.get("url", ""))
                ]
                detail_map: dict[str, dict[str, Any]] = {}
                for target in detail_targets:
                    try:
                        page.goto(str(target["url"]), wait_until="domcontentloaded", timeout=timeout_ms)
                        page.wait_for_timeout(1600)
                        detail_text = page.locator("body").inner_text(timeout=min(timeout_ms, 8000))[:500_000]
                        if access_denied_text(detail_text):
                            raise RuntimeError("상세페이지 접근 거부/보안확인")
                        detail = parse_benefit_detail(detail_text, int(target["total"]), int(target["shipping"]))
                        detail["detail_methods"] = ["browser"]
                        detail_map[str(target["id"])] = detail
                    except Exception as error:
                        warnings.append(f"{str(target['name'])[:36]} 상세수집 실패: {error}")
                    page.wait_for_timeout(700)

                enriched: list[dict[str, Any]] = []
                for index, product in enumerate(products):
                    detail = detail_map.get(str(index))
                    enriched.append(apply_detail_to_product(product, detail) if detail else product)
            finally:
                context.close()
    return enriched, warnings, search_url


READY_SEARCH_SOURCES = {"naver", "danawa", "enuri", "coupang"}
COLLECTION_SOURCE_LABELS = {
    "naver": "네이버쇼핑",
    "danawa": "다나와",
    "enuri": "에누리",
    "coupang": "쿠팡",
}


class CollectionQuotaExceeded(RuntimeError):
    pass


def normalize_sources(sources: list[str]) -> list[str]:
    selected = [source for source in sources if source in READY_SEARCH_SOURCES]
    return selected or ["naver", "danawa", "enuri", "coupang"]


def safe_browser_result_url(value: str, fallback_url: str = "") -> str:
    url = clean_text(value).rstrip("),.;")
    if not url:
        url = fallback_url
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return url
    return fallback_url if urllib.parse.urlparse(fallback_url).scheme in {"http", "https"} else ""


def looks_like_non_product_coupang_line(line: str) -> bool:
    normalized = re.sub(r"\s+", "", line.lower())
    blocked_terms = (
        "쿠팡홈", "장바구니", "마이쿠팡", "로그인", "회원가입", "로켓배송",
        "검색결과", "광고", "정렬", "필터", "카테고리", "고객센터",
    )
    return any(term.lower() in normalized for term in blocked_terms)


def product_from_browser_input(item: BrowserPriceItemInput, platform: str, fallback_url: str) -> dict[str, Any] | None:
    name = clean_text(item.name)[:240]
    price = parse_price(item.price)
    registered_price = parse_price(item.registered_price) or price
    shipping = parse_price(item.shipping)
    total = parse_price(item.total) or price + shipping
    if total and price <= 0:
        price = max(total - shipping, 0)
    if registered_price < price:
        registered_price = price
    if not name or price <= 0:
        return None
    return {
        "source": platform,
        "mall": clean_text(item.mall)[:80] or COMPARISON_PLATFORM_LABELS.get(platform, platform),
        "name": name,
        "price": price,
        "registered_price": registered_price,
        "shipping": shipping,
        "total": price + shipping,
        "url": safe_browser_result_url(item.url, fallback_url),
        "extraction_methods": ["browser"],
    }


def browser_products_from_json(data: Any, platform: str, fallback_url: str) -> list[dict[str, Any]]:
    rows = data.get("items", data.get("products", [])) if isinstance(data, dict) else data
    if not isinstance(rows, list):
        return []
    products: list[dict[str, Any]] = []
    for row in rows[:MAX_BROWSER_COLLECTION_ROWS]:
        if not isinstance(row, dict):
            continue
        product = product_from_browser_input(
            BrowserPriceItemInput(
                name=str(row.get("name") or row.get("title") or row.get("productName") or ""),
                mall=str(row.get("mall") or row.get("mallName") or row.get("seller") or "쿠팡"),
                price=parse_price(row.get("price") or row.get("sale_price") or row.get("salePrice") or row.get("display_price")),
                registered_price=parse_price(
                    row.get("registered_price")
                    or row.get("registeredPrice")
                    or row.get("original_price")
                    or row.get("originalPrice")
                    or row.get("list_price")
                    or row.get("listPrice")
                    or row.get("basePrice")
                ),
                shipping=parse_price(row.get("shipping") or row.get("shipping_fee") or row.get("deliveryFee") or row.get("delivery_fee")),
                total=parse_price(row.get("total") or row.get("total_price") or row.get("totalPrice")),
                url=str(row.get("url") or row.get("link") or row.get("detail_url") or row.get("detailUrl") or row.get("productUrl") or ""),
            ),
            platform,
            fallback_url,
        )
        if product:
            products.append(product)
    return products


def parse_browser_raw_text_products(raw_text: str, platform: str, fallback_url: str) -> list[dict[str, Any]]:
    text = raw_text.strip()
    if not text:
        return []
    if text.startswith("{") or text.startswith("["):
        try:
            products = browser_products_from_json(json.loads(text), platform, fallback_url)
            if products:
                return products
        except json.JSONDecodeError:
            pass

    if platform == "coupang" and "<" in text and re.search(r"coupang|/vp/products/|/np/products/|search-product|productUnit", text, flags=re.IGNORECASE):
        products = parse_coupang_products(text, fallback_url, limit=MAX_BROWSER_COLLECTION_ROWS)
        if products:
            return mark_extraction_method(products, "browser")

    products: list[dict[str, Any]] = []
    pending_names: list[str] = []
    lines = [clean_text(line) for line in text.splitlines()]
    for line in lines:
        if not line:
            continue
        urls = re.findall(r"https?://[^\s]+", line)
        line_without_urls = re.sub(r"https?://[^\s]+", " ", line)
        if "\t" in line:
            cells = [clean_text(cell) for cell in line.split("\t") if clean_text(cell)]
            price_cells = [cell for cell in cells if re.search(r"\d[\d,]*\s*원|\d{4,}", cell)]
            sale_price_cells = [cell for cell in price_cells if not re.search(r"배송|월\s*\d|개월|적립|캐시", cell)]
            if price_cells:
                name_cell = next((cell for cell in cells if cell not in price_cells and not cell.startswith("http")), "")
                price_values = [parse_price(cell) for cell in sale_price_cells] or [parse_price(price_cells[0])]
                registered_price = max(price_values) if len(price_values) > 1 else 0
                price = min(price_values) if len(price_values) > 1 else price_values[0]
                shipping = 0
                shipping_cell = next((cell for cell in cells if "배송" in cell and cell != price_cells[0]), "")
                if shipping_cell and "무료" not in shipping_cell:
                    shipping = parse_price(shipping_cell)
                product = product_from_browser_input(
                    BrowserPriceItemInput(
                        name=name_cell or (pending_names[-1] if pending_names else ""),
                        mall="쿠팡",
                        price=price,
                        registered_price=registered_price,
                        shipping=shipping,
                        url=urls[0] if urls else "",
                    ),
                    platform,
                    fallback_url,
                )
                if product:
                    products.append(product)
                    pending_names.clear()
                if len(products) >= MAX_BROWSER_COLLECTION_ROWS:
                    break
                continue

        price_matches = list(re.finditer(r"(\d{1,3}(?:,\d{3})+|\d{4,9})\s*원", line_without_urls))
        price_match = price_matches[0] if price_matches else None
        if not price_match:
            if len(line) >= 4 and not looks_like_non_product_coupang_line(line):
                pending_names.append(line)
                pending_names = pending_names[-3:]
            continue

        title_text = clean_text(line_without_urls[: price_match.start()])
        title_text = re.sub(r"(?:판매가|쿠폰가|즉시할인가|가격|원)$", "", title_text).strip(" -·:/")
        if len(title_text) < 4 and pending_names:
            title_text = pending_names[-1]
        shipping = 0
        if "무료배송" not in line_without_urls.replace(" ", ""):
            shipping_match = re.search(r"배송비[^\d]{0,20}(\d{1,3}(?:,\d{3})+|\d{3,7})\s*원", line_without_urls)
            if shipping_match:
                shipping = parse_price(shipping_match.group(1))
        price_values = [
            parse_price(match.group(1))
            for match in price_matches
            if not re.search(r"배송비|월\s*\d|개월|적립|캐시", line_without_urls[max(0, match.start() - 18) : min(len(line_without_urls), match.end() + 18)])
        ]
        registered_price = 0
        exposure_price = parse_price(price_match.group(1))
        if len(price_values) >= 2 and re.search(r"정가|정상가|할인전|할인\s*전|원가|등록가|취소선", line_without_urls):
            registered_price = max(price_values)
            exposure_price = min(price_values)
        product = product_from_browser_input(
            BrowserPriceItemInput(
                name=title_text,
                mall="쿠팡",
                price=exposure_price,
                registered_price=registered_price,
                shipping=shipping,
                url=urls[0] if urls else "",
            ),
            platform,
            fallback_url,
        )
        if product:
            products.append(product)
            pending_names.clear()
        if len(products) >= MAX_BROWSER_COLLECTION_ROWS:
            break
    return products


def browser_payload_products(payload: BrowserPriceResultsPayload) -> list[dict[str, Any]]:
    platform = payload.platform.strip().lower()
    if platform != "coupang":
        raise HTTPException(status_code=422, detail="현재 브라우저 수집은 쿠팡부터 지원합니다.")
    fallback_url = safe_browser_result_url(payload.page_url, coupang_search_url(payload.query, payload.sort_mode, MAX_BROWSER_COLLECTION_ROWS))
    products = [
        product
        for product in (product_from_browser_input(item, platform, fallback_url) for item in payload.items)
        if product
    ]
    if payload.raw_text.strip():
        products.extend(parse_browser_raw_text_products(payload.raw_text, platform, fallback_url))
    return dedupe_products(products)[:MAX_BROWSER_COLLECTION_ROWS]


def extension_payload_products(payload: ExtensionPriceResultsPayload) -> list[dict[str, Any]]:
    products: list[dict[str, Any]] = []
    for item in payload.items:
        source = item.source.strip().lower()
        if source not in COMPARISON_TARGET_PLATFORMS:
            continue
        fallback_url = safe_browser_result_url(payload.page_urls.get(source, ""), "")
        product = product_from_browser_input(item, source, fallback_url)
        if product:
            product["extraction_methods"] = ["chrome_extension"]
            products.append(product)

    limited_products: list[dict[str, Any]] = []
    per_source_counts: dict[str, int] = {}
    for product in dedupe_products(products):
        source = str(product.get("source") or "").strip().lower()
        if per_source_counts.get(source, 0) >= MAX_EXTENSION_CANDIDATES_PER_SOURCE:
            continue
        limited_products.append(product)
        per_source_counts[source] = per_source_counts.get(source, 0) + 1
    return limited_products[:MAX_EXTENSION_COLLECTION_ROWS]


def collection_quota_rows(db: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = db.execute(
        """
        SELECT limits.source, limits.daily_limit, limits.enabled, limits.updated_at,
               COALESCE(usage.request_count, 0) AS used,
               COALESCE(usage.last_status, '') AS last_status,
               usage.last_requested_at
        FROM collection_limits AS limits
        LEFT JOIN collection_usage AS usage
          ON usage.source = limits.source AND usage.usage_date = ?
        ORDER BY CASE limits.source WHEN 'naver' THEN 1 WHEN 'danawa' THEN 2 WHEN 'enuri' THEN 3 WHEN 'coupang' THEN 4 ELSE 9 END,
                 limits.source
        """,
        (usage_date(),),
    ).fetchall()
    return [
        {
            **(row_to_dict(row) or {}),
            "label": COLLECTION_SOURCE_LABELS.get(row["source"], row["source"]),
            "enabled": bool(row["enabled"]),
            "remaining": max(int(row["daily_limit"]) - int(row["used"]), 0),
            "usage_date": usage_date(),
        }
        for row in rows
    ]


def reserve_collection_request(db: sqlite3.Connection, source: str) -> None:
    quota = db.execute(
        "SELECT daily_limit, enabled FROM collection_limits WHERE source = ?",
        (source,),
    ).fetchone()
    if not quota:
        raise CollectionQuotaExceeded(f"{COLLECTION_SOURCE_LABELS.get(source, source)} 수집 한도가 설정되지 않음")
    if not quota["enabled"]:
        raise CollectionQuotaExceeded(f"{COLLECTION_SOURCE_LABELS.get(source, source)} 일일 수집이 관리자설정에서 꺼져 있음")

    today = usage_date()
    requested_at = now()
    db.execute(
        """
        INSERT OR IGNORE INTO collection_usage
        (source, usage_date, request_count, last_status, last_requested_at)
        VALUES (?, ?, 0, '', NULL)
        """,
        (source, today),
    )
    cursor = db.execute(
        """
        UPDATE collection_usage
        SET request_count = request_count + 1,
            last_status = 'running',
            last_requested_at = ?
        WHERE source = ? AND usage_date = ? AND request_count < ?
        """,
        (requested_at, source, today, int(quota["daily_limit"])),
    )
    db.commit()
    if cursor.rowcount == 0:
        raise CollectionQuotaExceeded(
            f"{COLLECTION_SOURCE_LABELS.get(source, source)} 오늘 요청 한도 {quota['daily_limit']}건을 모두 사용함"
        )


def complete_collection_request(db: sqlite3.Connection, source: str, status: str) -> None:
    db.execute(
        """
        UPDATE collection_usage
        SET last_status = ?
        WHERE source = ? AND usage_date = ?
        """,
        (status, source, usage_date()),
    )
    db.commit()


def collect_price_products(db: sqlite3.Connection, query: str, sort_mode: str, sources: list[str]) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    products: list[dict[str, Any]] = []
    selected_sources = normalize_sources(sources)

    if "naver" in selected_sources:
        try:
            reserve_collection_request(db, "naver")
            products.extend(fetch_naver_shopping_crawl_products(query, sort_mode, display=SEARCH_LINE_SOURCE_LIMIT))
            complete_collection_request(db, "naver", "success")
        except Exception as error:
            if not isinstance(error, CollectionQuotaExceeded):
                complete_collection_request(db, "naver", "error")
            warnings.append(f"네이버: {error}")

    if "danawa" in selected_sources:
        try:
            reserve_collection_request(db, "danawa")
            method_successes = 0
            collectors = (
                ("크롤링", fetch_danawa_products),
                ("Playwright", fetch_danawa_playwright_products),
                ("Scrapling", fetch_danawa_scrapling_products),
            )
            for label, collector in collectors:
                try:
                    collected = collector(query, display=SEARCH_LINE_SOURCE_LIMIT)
                    products.extend(collected)
                    if collected:
                        method_successes += 1
                    if label == "크롤링" and len(collected) >= 10:
                        break
                except Exception as error:
                    warnings.append(f"다나와 {label}: {error}")
            complete_collection_request(db, "danawa", "success" if method_successes else "error")
            if method_successes == 0:
                warnings.append("다나와의 모든 추출 방식이 실패함")
        except Exception as error:
            if not isinstance(error, CollectionQuotaExceeded):
                complete_collection_request(db, "danawa", "error")
            warnings.append(str(error))

    if "enuri" in selected_sources:
        try:
            reserve_collection_request(db, "enuri")
            products.extend(mark_extraction_method(fetch_enuri_products(query, display=SEARCH_LINE_SOURCE_LIMIT), "crawl"))
            complete_collection_request(db, "enuri", "success")
        except Exception as error:
            if not isinstance(error, CollectionQuotaExceeded):
                complete_collection_request(db, "enuri", "error")
            warnings.append(f"에누리: {error}")

    if "coupang" in selected_sources:
        try:
            if not COUPANG_SERVER_CRAWL_ENABLED:
                warnings.append("쿠팡: 서버 직접 수집은 기본 비활성화됨 · 쿠팡 브라우저 수집 버튼을 사용하세요.")
            else:
                reserve_collection_request(db, "coupang")
                method_successes = 0
                collectors = (
                    ("크롤링", fetch_coupang_products),
                    ("Playwright", fetch_coupang_playwright_products),
                    ("Scrapling", fetch_coupang_scrapling_products),
                )
                for label, collector in collectors:
                    try:
                        collected = collector(query, sort_mode, display=SEARCH_LINE_SOURCE_LIMIT)
                        products.extend(collected)
                        if collected:
                            method_successes += 1
                        if label == "크롤링" and len(collected) >= 10:
                            break
                    except Exception as error:
                        warnings.append(f"쿠팡 {label}: {error}")
                complete_collection_request(db, "coupang", "success" if method_successes else "error")
                if method_successes == 0:
                    warnings.append("쿠팡의 모든 추출 방식이 실패함")
        except Exception as error:
            if not isinstance(error, CollectionQuotaExceeded):
                complete_collection_request(db, "coupang", "error")
            warnings.append(f"쿠팡: {error}")

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
            ("coupang", "쿠팡", f"{keyword} 애플워치 호환 충전", 18900, 0, "https://www.coupang.com/"),
            ("naver", "오픈마켓", f"{keyword} 벌크 특가", 990, 3000, "https://shopping.naver.com/"),
        ]
    else:
        base = [
            ("naver", "11번가", f"{keyword} 초경량 업무용 14형 16GB", 819000, 0, "https://shopping.naver.com/"),
            ("naver", "스마트스토어", f"{keyword} 초경량 업무용 14형 8GB", 842000, 0, "https://shopping.naver.com/"),
            ("naver", "다나와", f"{keyword} 업무용 i5 512GB", 874000, 2500, "https://www.danawa.com/"),
            ("coupang", "쿠팡", f"{keyword} 고성능 15형 32GB", 1299000, 0, "https://www.coupang.com/"),
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


ACCESSORY_EXCEPTION_TERMS = {
    "케이스", "파우치", "보호필름", "강화유리", "키스킨", "스킨", "커버", "스트랩",
    "거치대", "충전기", "케이블", "어댑터", "리필", "교체용", "호환용", "부품",
    "액세서리", "보호용품",
}

PRODUCT_FAMILY_RULES = {
    "노트북": {
        "query": ("노트북", "랩탑", "그램", "갤럭시북", "맥북", "울트라북"),
        "item": ("노트북", "랩탑", "그램", "갤럭시북", "맥북", "울트라북"),
    },
    "스마트폰": {
        "query": ("스마트폰", "휴대폰", "핸드폰", "아이폰", "갤럭시s", "갤럭시z"),
        "item": ("스마트폰", "휴대폰", "핸드폰", "아이폰", "갤럭시s", "갤럭시z"),
    },
    "태블릿": {
        "query": ("태블릿", "아이패드", "갤럭시탭", "서피스프로"),
        "item": ("태블릿", "아이패드", "갤럭시탭", "서피스프로"),
    },
    "모니터": {
        "query": ("모니터", "게이밍모니터"),
        "item": ("모니터", "게이밍모니터"),
    },
    "TV": {
        "query": ("텔레비전", "스마트tv", "올레드tv", "oledtv", "qledtv"),
        "item": ("텔레비전", "스마트tv", "올레드tv", "oledtv", "qledtv"),
    },
    "냉장고": {"query": ("냉장고", "김치냉장고"), "item": ("냉장고", "김치냉장고")},
    "세탁기": {"query": ("세탁기", "워시타워"), "item": ("세탁기", "워시타워")},
    "건조기": {"query": ("건조기", "의류건조기"), "item": ("건조기", "의류건조기")},
    "청소기": {
        "query": ("청소기", "로봇청소기", "무선청소기"),
        "item": ("청소기", "로봇청소기", "무선청소기"),
    },
    "에어컨": {"query": ("에어컨", "냉난방기"), "item": ("에어컨", "냉난방기")},
    "카메라": {
        "query": ("카메라", "미러리스", "dslr"),
        "item": ("카메라", "미러리스", "dslr"),
    },
    "프린터": {
        "query": ("프린터", "복합기", "레이저프린터"),
        "item": ("프린터", "복합기", "레이저프린터"),
    },
    "이어폰": {
        "query": ("이어폰", "에어팟", "버즈"),
        "item": ("이어폰", "에어팟", "버즈"),
    },
    "헤드폰": {"query": ("헤드폰", "헤드셋"), "item": ("헤드폰", "헤드셋")},
    "스피커": {"query": ("스피커", "사운드바"), "item": ("스피커", "사운드바")},
    "신발": {
        "query": ("운동화", "스니커즈", "런닝화", "러닝화", "구두"),
        "item": ("운동화", "스니커즈", "런닝화", "러닝화", "구두"),
    },
}

MODEL_OPTION_SUFFIXES = (
    "gb", "tb", "mb", "hz", "khz", "mhz", "ghz", "mah", "wh", "inch", "인치",
)


def compact_alnum(value: str) -> str:
    return re.sub(r"[^a-z0-9가-힣]", "", clean_text(value).lower())


def search_tokens(value: str) -> list[str]:
    return [
        compact_alnum(token)
        for token in re.findall(r"[A-Za-z0-9가-힣][A-Za-z0-9가-힣._/+()-]*", clean_text(value))
        if compact_alnum(token)
    ]


def strong_model_tokens(value: str) -> list[str]:
    models: list[str] = []
    for token in search_tokens(value):
        if not re.search(r"[a-z]", token) or not re.search(r"\d", token):
            continue
        if token.endswith(MODEL_OPTION_SUFFIXES):
            continue
        if len(token) < 4 and not re.fullmatch(r"[a-z]\d{2,}", token):
            continue
        if token not in models:
            models.append(token)
    return models


def detect_product_families(value: str, field: str = "item") -> set[str]:
    compact = compact_alnum(value)
    return {
        family
        for family, rules in PRODUCT_FAMILY_RULES.items()
        if any(compact_alnum(alias) in compact for alias in rules[field])
    }


def build_search_intent(query: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    query_compact = compact_alnum(query)
    models = strong_model_tokens(query)
    families = detect_product_families(query, "query")
    accessory_intent = any(compact_alnum(term) in query_compact for term in ACCESSORY_EXCEPTION_TERMS)

    # Exact model searches often omit the product family. Infer it only from
    # model-matching results so unrelated cheap accessories cannot dominate.
    if not families and models:
        family_counts: dict[str, int] = {}
        for item in items:
            item_text = f"{item.get('name', '')} {item.get('category', '')}"
            item_compact = compact_alnum(item_text)
            if not all(model in item_compact for model in models):
                continue
            for family in detect_product_families(item_text):
                family_counts[family] = family_counts.get(family, 0) + 1
        if family_counts:
            top_family, top_count = max(family_counts.items(), key=lambda entry: entry[1])
            if top_count >= 2:
                families = {top_family}

    query_terms = [
        token
        for token in search_tokens(query)
        if len(token) >= 2 and token not in models and not token.isdigit()
    ]
    return {
        "compact": query_compact,
        "models": models,
        "families": families,
        "accessory_intent": accessory_intent,
        "terms": query_terms,
    }


def search_relevance(item: dict[str, Any], intent: dict[str, Any]) -> int:
    title = compact_alnum(str(item.get("name", "")))
    category = compact_alnum(str(item.get("category", "")))
    combined = f"{title}{category}"
    score = 0
    if intent["compact"] and intent["compact"] in title:
        score += 100
    score += sum(80 for model in intent["models"] if model in combined)
    if intent["terms"]:
        matched_terms = sum(1 for term in intent["terms"] if term in combined)
        score += round(40 * matched_terms / len(intent["terms"]))
    item_families = detect_product_families(combined)
    if intent["families"] & item_families:
        score += 50
    if intent["families"] and item_families and not intent["families"] & item_families:
        score -= 80
    return score


def normalize_exception_terms(values: list[str]) -> list[str]:
    terms: list[str] = []
    for value in values:
        for candidate in str(value).split(","):
            term = " ".join(candidate.strip().lower().split())
            if term and term not in terms:
                terms.append(term)
    return terms[:200]


def get_search_exception_terms(db: sqlite3.Connection) -> list[str]:
    row = db.execute("SELECT terms_json FROM search_exceptions WHERE id = 'default'").fetchone()
    return normalize_exception_terms(parse_json_text(row["terms_json"] if row else "[]", []))


def automatic_exclusion_reasons(
    query: str,
    items: list[dict[str, Any]],
    custom_terms: list[str],
) -> list[str]:
    intent = build_search_intent(query, items)
    reasons = ["" for _ in items]
    accessory_terms = [] if intent["accessory_intent"] else list(ACCESSORY_EXCEPTION_TERMS)

    for index, item in enumerate(items):
        title = compact_alnum(str(item.get("name", "")))
        category = compact_alnum(str(item.get("category", "")))
        combined = f"{title}{category}"
        item["relevance_score"] = search_relevance(item, intent)
        matched_custom = next(
            (term for term in custom_terms if compact_alnum(term) in title),
            "",
        )
        matched_accessory = next(
            (term for term in accessory_terms if compact_alnum(term) in title),
            "",
        )
        matched_accessory_category = next(
            (term for term in accessory_terms if compact_alnum(term) in category),
            "",
        )
        missing_model = next(
            (model for model in intent["models"] if model not in combined),
            "",
        )
        item_families = detect_product_families(combined)
        conflicting_family = bool(
            intent["families"]
            and item_families
            and not intent["families"] & item_families
        )
        if matched_custom:
            reasons[index] = f"검색 예외어: {matched_custom}"
        elif matched_accessory:
            reasons[index] = f"관련 없는 부가상품: {matched_accessory}"
        elif matched_accessory_category:
            reasons[index] = f"관련 없는 상품 카테고리: {matched_accessory_category}"
        elif missing_model:
            reasons[index] = f"검색 모델 불일치: {missing_model}"
        elif conflicting_family:
            detected = ", ".join(sorted(item_families))
            reasons[index] = f"상품군 불일치: {detected}"

    relevant_prices = sorted(
        int(item.get("total", 0))
        for index, item in enumerate(items)
        if not reasons[index] and int(item.get("total", 0)) > 0
    )
    if len(relevant_prices) >= 4:
        middle = len(relevant_prices) // 2
        median = (
            relevant_prices[middle]
            if len(relevant_prices) % 2
            else (relevant_prices[middle - 1] + relevant_prices[middle]) / 2
        )
        lower_bound = median * 0.35
        upper_bound = median * 3.0
        for index, item in enumerate(items):
            total = int(item.get("total", 0))
            if not reasons[index] and total > 0 and (total < lower_bound or total > upper_bound):
                reasons[index] = "중앙 가격대에서 크게 벗어난 가격"
    return reasons


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
        try:
            item["extraction_methods"] = json.loads(item.pop("extraction_methods_json", "[]"))
        except (TypeError, json.JSONDecodeError):
            item["extraction_methods"] = []
        try:
            item["detail_methods"] = json.loads(item.pop("detail_methods_json", "[]"))
        except (TypeError, json.JSONDecodeError):
            item["detail_methods"] = []
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
            "excluded_count": len([item for item in items if item["status"] in {"excluded", "abnormal"}]),
            "baseline_total": baseline_total,
        },
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "pricescan"}


@app.post("/extension/local-install-helper", dependencies=[Depends(require_admin)])
def open_extension_local_install_helper() -> dict[str, Any]:
    if not PRICESCAN_EXTENSION_LOCAL_PATH.exists():
        raise HTTPException(status_code=404, detail=f"익스텐션 폴더를 찾지 못했습니다: {PRICESCAN_EXTENSION_LOCAL_PATH}")
    if sys.platform != "darwin":
        raise HTTPException(status_code=422, detail="로컬 설치 보조 기능은 현재 macOS Chrome에서만 지원합니다.")

    opened: list[str] = []
    errors: list[str] = []
    for target in ("chrome://extensions/", PRICESCAN_WEB_LOCAL_URL):
        try:
            subprocess.run(
                ["open", "-a", "Google Chrome", target],
                check=True,
                capture_output=True,
                text=True,
                timeout=8,
            )
            opened.append(target)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            errors.append(str(error))
    try:
        subprocess.run(
            ["open", "-R", str(PRICESCAN_EXTENSION_LOCAL_PATH / "manifest.json")],
            check=True,
            capture_output=True,
            text=True,
            timeout=8,
        )
        opened.append(str(PRICESCAN_EXTENSION_LOCAL_PATH))
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        errors.append(str(error))

    if not opened:
        raise HTTPException(status_code=502, detail="Google Chrome을 열지 못했습니다. Chrome이 설치되어 있는지 확인하세요.")

    return {
        "status": "opened",
        "opened": opened,
        "extension_path": str(PRICESCAN_EXTENSION_LOCAL_PATH),
        "instructions": [
            "Chrome 확장 프로그램 화면에서 개발자 모드를 켭니다.",
            "압축해제된 확장 프로그램을 로드합니다.",
            "복사된 PriceScan Collector 폴더를 선택합니다.",
            "PriceScan 페이지를 새로고침한 뒤 익스텐션 연결 상태를 다시 확인합니다.",
        ],
        "warnings": errors,
    }


@app.post("/extension/reveal-local-folder", dependencies=[Depends(require_admin)])
def reveal_extension_local_folder() -> dict[str, str]:
    if not PRICESCAN_EXTENSION_LOCAL_PATH.exists():
        raise HTTPException(status_code=404, detail=f"익스텐션 폴더를 찾지 못했습니다: {PRICESCAN_EXTENSION_LOCAL_PATH}")
    if sys.platform != "darwin":
        raise HTTPException(status_code=422, detail="Finder 폴더 열기는 현재 macOS에서만 지원합니다.")
    try:
        subprocess.run(
            ["open", "-R", str(PRICESCAN_EXTENSION_LOCAL_PATH / "manifest.json")],
            check=True,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise HTTPException(status_code=502, detail=f"Finder에서 익스텐션 폴더를 열지 못했습니다: {error}") from error
    return {"status": "revealed", "extension_path": str(PRICESCAN_EXTENSION_LOCAL_PATH)}


@app.post("/extension/dev-launch-browser", dependencies=[Depends(require_admin)])
def launch_extension_dev_browser() -> dict[str, Any]:
    if not PRICESCAN_EXTENSION_LOCAL_PATH.exists():
        raise HTTPException(status_code=404, detail=f"익스텐션 폴더를 찾지 못했습니다: {PRICESCAN_EXTENSION_LOCAL_PATH}")
    executable, extension_compatible = extension_browser_executable()
    if not executable:
        raise HTTPException(status_code=404, detail="Chrome for Testing/Chromium 실행 파일을 찾지 못했습니다. backend/.venv312/bin/python -m playwright install chromium 실행이 필요합니다.")
    if not extension_compatible:
        raise HTTPException(
            status_code=409,
            detail="현재 일반 Chrome은 로컬 익스텐션 자동 로드를 지원하지 않습니다. backend/.venv312/bin/python -m playwright install chromium 실행 후 다시 시도하세요.",
        )

    PRICESCAN_EXTENSION_DEV_PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    profile_dir = PRICESCAN_EXTENSION_DEV_PROFILE_DIR / f"session_{int(time.time())}_{uuid4().hex[:8]}"
    profile_dir.mkdir(parents=True, exist_ok=True)
    collector_url = PRICESCAN_WEB_LOCAL_URL + ("&" if "?" in PRICESCAN_WEB_LOCAL_URL else "?") + "collector=dev"
    extension_args = [
        f"--user-data-dir={profile_dir}",
        f"--disable-extensions-except={PRICESCAN_EXTENSION_LOCAL_PATH}",
        f"--load-extension={PRICESCAN_EXTENSION_LOCAL_PATH}",
        "--enable-unsafe-extension-debugging",
        "--no-first-run",
        "--new-window",
        collector_url,
    ]
    try:
        if sys.platform == "darwin" and "Google Chrome.app" in executable:
            subprocess.Popen(
                [
                    "open",
                    "-na",
                    "Google Chrome",
                    "--args",
                    *extension_args,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        else:
            subprocess.Popen(
                [executable, *extension_args],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
    except OSError as error:
        raise HTTPException(status_code=502, detail=f"PriceScan 전용 Chrome 실행 실패: {error}") from error

    return {
        "status": "launched",
        "browser": executable,
        "extension_path": str(PRICESCAN_EXTENSION_LOCAL_PATH),
        "profile_dir": str(profile_dir),
        "url": collector_url,
        "message": "PriceScan 전용 Chrome 창을 열었습니다. 현재 창이 아니라 새로 열린 Chrome 창에서 PriceScan을 사용하세요.",
    }


@app.get("/search-exceptions", dependencies=[Depends(require_admin)])
def search_exceptions() -> dict[str, Any]:
    with connect() as db:
        terms = get_search_exception_terms(db)
    return {"terms": terms, "text": ", ".join(terms)}


@app.put("/search-exceptions", dependencies=[Depends(require_admin)])
def update_search_exceptions(payload: SearchExceptionsPayload) -> dict[str, Any]:
    terms = normalize_exception_terms(payload.terms)
    with connect() as db:
        db.execute(
            "UPDATE search_exceptions SET terms_json = ?, updated_at = ? WHERE id = 'default'",
            (json.dumps(terms, ensure_ascii=False), now()),
        )
    log_event(f"search exceptions updated: {len(terms)} terms")
    return {"terms": terms, "text": ", ".join(terms)}


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
            """
            SELECT COUNT(*) AS count
            FROM listing_drafts
            WHERE status IN ('draft', 'ready_to_publish', 'validated', 'validation_failed', 'publish_ready')
            """
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


@app.get("/collection-quotas", dependencies=[Depends(require_admin)])
def collection_quotas() -> list[dict[str, Any]]:
    with connect() as db:
        return collection_quota_rows(db)


@app.put("/collection-quotas/{source}", dependencies=[Depends(require_admin)])
def save_collection_quota(source: str, payload: CollectionLimitPayload) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT source FROM collection_limits WHERE source = ?", (source,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Unknown collection source")
        db.execute(
            """
            UPDATE collection_limits
            SET daily_limit = ?, enabled = ?, updated_at = ?
            WHERE source = ?
            """,
            (payload.daily_limit, int(payload.enabled), now(), source),
        )
        quota = next(item for item in collection_quota_rows(db) if item["source"] == source)
    log_event(
        f"{COLLECTION_SOURCE_LABELS.get(source, source)} daily request limit saved: {payload.daily_limit} / enabled={payload.enabled}"
    )
    return quota


@app.put("/api-keys/{platform}", dependencies=[Depends(require_admin)])
def save_api_key(platform: str, payload: ApiKeyPayload) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT platform FROM api_keys WHERE platform = ?", (platform,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Unknown platform")
        if platform in READY_SEARCH_SOURCES:
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
    log_event(f"{platform} connection setting saved")
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
            try:
                reserve_collection_request(db, "naver")
                fetch_naver_shopping_crawl_products("노트북", "lowest", display=1)
                complete_collection_request(db, "naver", "success")
                connected = True
                message = "네이버쇼핑 검색 페이지 수집/파싱 성공"
            except Exception as error:
                if not isinstance(error, CollectionQuotaExceeded):
                    complete_collection_request(db, "naver", "error")
                message = str(error)
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
                reserve_collection_request(db, "danawa")
                fetch_danawa_products("노트북", display=1)
                complete_collection_request(db, "danawa", "success")
                connected = True
                message = "다나와 검색 페이지 수집/파싱 성공"
            except Exception as error:
                if not isinstance(error, CollectionQuotaExceeded):
                    complete_collection_request(db, "danawa", "error")
                message = str(error)
        elif platform == "enuri":
            try:
                reserve_collection_request(db, "enuri")
                fetch_enuri_products("노트북", display=1)
                complete_collection_request(db, "enuri", "success")
                connected = True
                message = "에누리 검색 페이지 수집/파싱 성공"
            except Exception as error:
                if not isinstance(error, CollectionQuotaExceeded):
                    complete_collection_request(db, "enuri", "error")
                message = str(error)
        elif platform == "coupang":
            connected = True
            if COUPANG_SERVER_CRAWL_ENABLED:
                try:
                    reserve_collection_request(db, "coupang")
                    fetch_coupang_products("노트북", "lowest", display=1)
                    complete_collection_request(db, "coupang", "success")
                    message = "쿠팡 서버 검색 페이지 수집/파싱 성공"
                except Exception as error:
                    if not isinstance(error, CollectionQuotaExceeded):
                        complete_collection_request(db, "coupang", "error")
                    connected = False
                    message = str(error)
            else:
                message = "쿠팡은 사용자 승인형 브라우저 수집 모드로 사용합니다. 상품검색 화면의 쿠팡 브라우저 수집 버튼을 사용하세요."
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
        exception_terms = get_search_exception_terms(db)

    exclusion_reasons = automatic_exclusion_reasons(payload.query, items, exception_terms)
    baseline_candidates = [item for index, item in enumerate(items) if not exclusion_reasons[index]]
    baseline_item = min(baseline_candidates, key=lambda item: item["total"], default=None)
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
        for index, item in enumerate(items):
            total = item["total"]
            exclusion_reason = exclusion_reasons[index]
            is_baseline = 1 if not exclusion_reason and total == baseline_total and baseline_item and item["name"] == baseline_item["name"] else 0
            db.execute(
                """
                INSERT INTO price_items
                (id, run_id, source, mall, name, price, registered_price, shipping, total, url, is_baseline, is_excluded, exclusion_reason, extraction_methods_json, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("price"),
                    run_id,
                    item["source"],
                    item["mall"],
                    item["name"],
                    item["price"],
                    item.get("registered_price") or item["price"],
                    item["shipping"],
                    item["total"],
                    item["url"],
                    is_baseline,
                    1 if exclusion_reason else 0,
                    exclusion_reason,
                    json.dumps(item.get("extraction_methods", []), ensure_ascii=False),
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


@app.post("/price-search/browser-results", dependencies=[Depends(require_admin)])
def save_browser_price_results(payload: BrowserPriceResultsPayload) -> dict[str, Any]:
    run_id = new_id("run")
    platform = payload.platform.strip().lower()
    selected_sources = [platform]
    items = browser_payload_products(payload)
    if not items:
        raise HTTPException(status_code=422, detail="쿠팡 브라우저 수집 결과에서 상품명/가격을 찾지 못했습니다.")

    with connect() as db:
        reserve_collection_request(db, platform)
        complete_collection_request(db, platform, "browser_success")
        exception_terms = get_search_exception_terms(db)

    exclusion_reasons = automatic_exclusion_reasons(payload.query, items, exception_terms)
    baseline_candidates = [item for index, item in enumerate(items) if not exclusion_reasons[index]]
    baseline_item = min(baseline_candidates, key=lambda item: item["total"], default=None)
    baseline_total = baseline_item["total"] if baseline_item else 0
    collected_at = now()

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
                json.dumps(
                    {
                        "filters": ["browser_collection"],
                        "sources": selected_sources,
                        "collection_mode": "user_browser",
                        "approval_scope": payload.approval_scope,
                        "page_url": safe_browser_result_url(payload.page_url, ""),
                    },
                    ensure_ascii=False,
                ),
                collected_at,
            ),
        )
        for index, item in enumerate(items):
            total = item["total"]
            exclusion_reason = exclusion_reasons[index]
            is_baseline = 1 if not exclusion_reason and total == baseline_total and baseline_item and item["name"] == baseline_item["name"] else 0
            db.execute(
                """
                INSERT INTO price_items
                (id, run_id, source, mall, name, price, registered_price, shipping, total, url, is_baseline, is_excluded, exclusion_reason, extraction_methods_json, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("price"),
                    run_id,
                    item["source"],
                    item["mall"],
                    item["name"],
                    item["price"],
                    item.get("registered_price") or item["price"],
                    item["shipping"],
                    item["total"],
                    item["url"],
                    is_baseline,
                    1 if exclusion_reason else 0,
                    exclusion_reason,
                    json.dumps(item.get("extraction_methods", ["browser"]), ensure_ascii=False),
                    collected_at,
                ),
            )
        db.execute(
            "INSERT INTO logs (id, message, level, created_at) VALUES (?, ?, ?, ?)",
            (
                new_id("log"),
                f"쿠팡 브라우저 수집 저장: {payload.query} · {len(items)} items · approval={payload.approval_scope}",
                "info",
                now(),
            ),
        )
        payload_out = get_run_payload(db, run_id)
        payload_out["warnings"] = []
    return payload_out


@app.post("/price-search/desktop-results", dependencies=[Depends(require_admin)])
def save_desktop_price_results(payload: DesktopPriceResultsPayload) -> dict[str, Any]:
    """Append one completed site, atomically and idempotently, to an owned desktop run.

    The run contains only saved results; desktop pending/challenge states stay in
    the local job manager. Replaying a saved source never consumes quota twice.
    """
    run_id = f"desktop_{payload.collection_id}"
    items = extension_payload_products(payload)
    sources = {item["source"] for item in items}
    if len(sources) != 1:
        raise HTTPException(422, "쇼핑몰 하나의 유효한 수집 결과를 보내세요.")
    source = next(iter(sources))
    with connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT * FROM search_runs WHERE id = ?", (run_id,)).fetchone()
        metadata = json.loads(existing["filters_json"]) if existing else {
            "filters": ["desktop_supervised"], "collection_mode": "desktop_supervised",
            "approval_scope": "desktop_supervised", "sources": [], "page_urls": {}, "warnings": [],
        }
        if existing and (existing["query"] != payload.query or existing["sort_mode"] != payload.sort_mode):
            raise HTTPException(409, "다른 검색 작업의 결과는 합칠 수 없습니다.")
        if source in metadata["sources"]:
            result = get_run_payload(db, run_id)
            result["warnings"] = metadata.get("warnings", [])
            return result
        reserve_collection_request(db, source)
        complete_collection_request(db, source, "browser_success")
        collected_at = now()
        reasons = automatic_exclusion_reasons(payload.query, items, get_search_exception_terms(db))
        metadata["sources"].append(source)
        metadata["page_urls"][source] = safe_browser_result_url(payload.page_urls.get(source, ""), "")
        metadata["warnings"] = list(dict.fromkeys([*metadata.get("warnings", []), *[warning[:1000] for warning in payload.warnings]]))[:40]
        if not existing:
            db.execute("INSERT INTO search_runs (id, query, sort_mode, status, filters_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                       (run_id, payload.query, payload.sort_mode, "completed", json.dumps(metadata, ensure_ascii=False), collected_at))
        else:
            db.execute("UPDATE search_runs SET filters_json = ? WHERE id = ?", (json.dumps(metadata, ensure_ascii=False), run_id))
        for index, item in enumerate(items):
            db.execute("""INSERT INTO price_items
                (id, run_id, source, mall, name, price, registered_price, shipping, total, url,
                 is_baseline, is_excluded, exclusion_reason, extraction_methods_json, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (new_id("price"), run_id, source, item["mall"], item["name"], item["price"], item.get("registered_price") or item["price"],
                 item["shipping"], item["total"], item["url"], 0, int(bool(reasons[index])), reasons[index],
                 json.dumps(["desktop_visible_page", *item.get("extraction_methods", [])], ensure_ascii=False), collected_at))
        db.execute("UPDATE price_items SET is_baseline = 0 WHERE run_id = ?", (run_id,))
        baseline = db.execute("SELECT id FROM price_items WHERE run_id = ? AND is_excluded = 0 ORDER BY total, id LIMIT 1", (run_id,)).fetchone()
        if baseline:
            db.execute("UPDATE price_items SET is_baseline = 1 WHERE id = ?", (baseline["id"],))
        db.execute("INSERT INTO logs (id, message, level, created_at) VALUES (?, ?, ?, ?)",
                   (new_id("log"), f"전용 앱 수집 저장: {payload.query} · {source} · {len(items)} items", "info", collected_at))
        result = get_run_payload(db, run_id)
        result["warnings"] = metadata["warnings"]
        return result


@app.post("/price-search/extension-results", dependencies=[Depends(require_admin)])
def save_extension_price_results(payload: ExtensionPriceResultsPayload) -> dict[str, Any]:
    run_id = payload.merge_run_id.strip() or new_id("run")
    items = extension_payload_products(payload)
    if not items:
        raise HTTPException(status_code=422, detail="크롬 익스텐션 수집 결과에서 상품명/가격을 찾지 못했습니다.")

    selected_sources = sorted({item["source"] for item in items})
    with connect() as db:
        for source in selected_sources:
            reserve_collection_request(db, source)
            complete_collection_request(db, source, "browser_success")
        exception_terms = get_search_exception_terms(db)

    exclusion_reasons = automatic_exclusion_reasons(payload.query, items, exception_terms)
    collected_at = now()

    with connect() as db:
        existing = db.execute("SELECT query, filters_json FROM search_runs WHERE id = ?", (run_id,)).fetchone()
        if payload.merge_run_id and not existing:
            raise HTTPException(status_code=404, detail="합칠 기존 검색 결과를 찾지 못했습니다.")
        if existing and str(existing["query"]).strip() != payload.query.strip():
            raise HTTPException(status_code=422, detail="검색어가 다른 결과에는 합칠 수 없습니다.")

        metadata: dict[str, Any] = {}
        if existing:
            try:
                metadata = json.loads(existing["filters_json"] or "{}")
            except (TypeError, json.JSONDecodeError):
                metadata = {}
        existing_sources = [str(value) for value in metadata.get("sources", [])]
        metadata.update(
            {
                "sources": list(dict.fromkeys([*existing_sources, *selected_sources])),
                "collection_mode": "server_and_current_page" if existing else "chrome_extension_current_page",
                "approval_scope": payload.approval_scope,
                "page_urls": {
                    **(metadata.get("page_urls", {}) if isinstance(metadata.get("page_urls"), dict) else {}),
                    **{
                        key: safe_browser_result_url(value, "")
                        for key, value in payload.page_urls.items()
                        if key in COMPARISON_TARGET_PLATFORMS
                    },
                },
            }
        )
        if existing:
            db.execute(
                "UPDATE search_runs SET filters_json = ?, status = 'completed' WHERE id = ?",
                (json.dumps(metadata, ensure_ascii=False), run_id),
            )
            for source in selected_sources:
                db.execute("DELETE FROM price_items WHERE run_id = ? AND source = ?", (run_id, source))
        else:
            metadata["filters"] = ["chrome_extension_current_page"]
            db.execute(
                "INSERT INTO search_runs (id, query, sort_mode, status, filters_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (run_id, payload.query, payload.sort_mode, "completed", json.dumps(metadata, ensure_ascii=False), collected_at),
            )
        for index, item in enumerate(items):
            exclusion_reason = exclusion_reasons[index]
            db.execute(
                """
                INSERT INTO price_items
                (id, run_id, source, mall, name, price, registered_price, shipping, total, url, is_baseline, is_excluded, exclusion_reason, extraction_methods_json, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("price"),
                    run_id,
                    item["source"],
                    item["mall"],
                    item["name"],
                    item["price"],
                    item.get("registered_price") or item["price"],
                    item["shipping"],
                    item["total"],
                    item["url"],
                    0,
                    1 if exclusion_reason else 0,
                    exclusion_reason,
                    json.dumps(item.get("extraction_methods", ["chrome_extension"]), ensure_ascii=False),
                    collected_at,
                ),
            )
        db.execute("UPDATE price_items SET is_baseline = 0 WHERE run_id = ?", (run_id,))
        baseline = db.execute(
            "SELECT id FROM price_items WHERE run_id = ? AND is_excluded = 0 ORDER BY total, id LIMIT 1",
            (run_id,),
        ).fetchone()
        if baseline:
            db.execute("UPDATE price_items SET is_baseline = 1 WHERE id = ?", (baseline["id"],))
        db.execute(
            "INSERT INTO logs (id, message, level, created_at) VALUES (?, ?, ?, ?)",
            (
                new_id("log"),
                f"크롬 익스텐션 수집 저장: {payload.query} · {len(items)} items · sources={','.join(selected_sources)}",
                "warning" if payload.warnings else "info",
                now(),
            ),
        )
        payload_out = get_run_payload(db, run_id)
        payload_out["warnings"] = payload.warnings
    return payload_out


@app.post("/price-search/coupang-auto", dependencies=[Depends(require_admin)])
def collect_coupang_auto(payload: CoupangAutoCollectPayload) -> dict[str, Any]:
    run_id = new_id("run")
    collected_at = now()
    with connect() as db:
        reserve_collection_request(db, "coupang")

    try:
        try:
            items, warnings, page_url = collect_coupang_real_chrome_products(payload)
        except Exception as chrome_error:
            items, warnings, page_url = collect_coupang_visible_browser_products(payload)
            warnings.insert(0, f"실제 Chrome 세션 수집 실패 후 제어 브라우저로 전환: {chrome_error}")
    except Exception as error:
        with connect() as db:
            if not isinstance(error, CollectionQuotaExceeded):
                complete_collection_request(db, "coupang", "error")
        raise HTTPException(status_code=502, detail=str(error)) from error

    items = dedupe_products(items)[:MAX_BROWSER_COLLECTION_ROWS]
    if not items:
        with connect() as db:
            complete_collection_request(db, "coupang", "error")
        raise HTTPException(status_code=422, detail="쿠팡 브라우저 자동수집 결과가 없습니다.")

    with connect() as db:
        exception_terms = get_search_exception_terms(db)
    exclusion_reasons = automatic_exclusion_reasons(payload.query, items, exception_terms)
    baseline_candidates = [item for index, item in enumerate(items) if not exclusion_reasons[index]]
    baseline_item = min(baseline_candidates, key=lambda item: item["total"], default=None)
    baseline_total = baseline_item["total"] if baseline_item else 0

    with connect() as db:
        complete_collection_request(db, "coupang", "browser_success")
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
                json.dumps(
                    {
                        "filters": ["browser_auto"],
                        "sources": ["coupang"],
                        "collection_mode": "user_browser_auto",
                        "approval_scope": payload.approval_scope,
                        "page_url": page_url,
                    },
                    ensure_ascii=False,
                ),
                collected_at,
            ),
        )
        for index, item in enumerate(items):
            total = item["total"]
            exclusion_reason = exclusion_reasons[index]
            is_baseline = 1 if not exclusion_reason and total == baseline_total and baseline_item and item["name"] == baseline_item["name"] else 0
            db.execute(
                """
                INSERT INTO price_items
                (id, run_id, source, mall, name, price, registered_price, shipping, total, url,
                 is_baseline, is_excluded, exclusion_reason, extraction_methods_json,
                 benefit_status, coupon_price, event_price, card_price, benefit_price, benefit_shipping,
                 benefit_summary, benefit_condition, detail_methods_json, benefit_checked_at, collected_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id("price"),
                    run_id,
                    item["source"],
                    item["mall"],
                    item["name"],
                    item["price"],
                    item.get("registered_price") or item["price"],
                    item["shipping"],
                    item["total"],
                    item["url"],
                    is_baseline,
                    1 if exclusion_reason else 0,
                    exclusion_reason,
                    json.dumps(item.get("extraction_methods", ["browser"]), ensure_ascii=False),
                    item.get("benefit_status", "not_checked"),
                    int(item.get("coupon_price") or 0),
                    int(item.get("event_price") or 0),
                    int(item.get("card_price") or 0),
                    int(item.get("benefit_price") or 0),
                    int(item.get("benefit_shipping") if item.get("benefit_shipping") is not None else item["shipping"]),
                    str(item.get("benefit_summary") or ""),
                    str(item.get("benefit_condition") or ""),
                    json.dumps(item.get("detail_methods", []), ensure_ascii=False),
                    item.get("benefit_checked_at"),
                    collected_at,
                ),
            )
        db.execute(
            "INSERT INTO logs (id, message, level, created_at) VALUES (?, ?, ?, ?)",
            (
                new_id("log"),
                f"쿠팡 자동수집 완료: {payload.query} · {len(items)} items · detail_limit={payload.detail_limit}",
                "warning" if warnings else "info",
                now(),
            ),
        )
        payload_out = get_run_payload(db, run_id)
        payload_out["warnings"] = warnings
    return payload_out


@app.post("/price-search/benefits", dependencies=[Depends(require_admin)])
def scan_price_search_benefits(payload: BenefitScanRequest) -> dict[str, Any]:
    item_ids = list(dict.fromkeys(payload.item_ids))
    with connect() as db:
        placeholders = ",".join("?" for _ in item_ids)
        rows = db.execute(
            f"SELECT * FROM price_items WHERE id IN ({placeholders})",
            item_ids,
        ).fetchall()
    if len(rows) != len(item_ids):
        raise HTTPException(status_code=404, detail="일부 검색 결과를 찾지 못했습니다.")

    warnings: list[str] = []
    coupang_details: dict[str, dict[str, Any]] = {}
    coupang_targets = coupang_browser_detail_targets(rows)
    if coupang_targets:
        try:
            coupang_details, coupang_warnings = visible_coupang_detail_details(coupang_targets)
            warnings.extend(coupang_warnings)
        except Exception as error:
            for target in coupang_targets:
                coupang_details[str(target["id"])] = {
                    "benefit_status": "failed",
                    "coupon_price": 0,
                    "event_price": 0,
                    "card_price": 0,
                    "benefit_price": 0,
                    "registered_price": 0,
                    "display_price": 0,
                    "benefit_shipping": int(target["shipping"]),
                    "benefit_summary": "",
                    "benefit_condition": str(error)[:500],
                    "detail_methods": ["browser"],
                }
    for row in rows:
        detail = coupang_details.get(str(row["id"]))
        if not detail:
            try:
                detail = fetch_benefit_detail(row["url"], int(row["total"]), int(row["shipping"]))
            except Exception as error:
                detail = {
                    "benefit_status": "failed",
                    "coupon_price": 0,
                    "event_price": 0,
                    "card_price": 0,
                    "benefit_price": 0,
                    "registered_price": 0,
                    "display_price": 0,
                    "benefit_shipping": int(row["shipping"]),
                    "benefit_summary": "",
                    "benefit_condition": str(error)[:500],
                    "detail_methods": [],
                }
        if detail["benefit_status"] == "failed":
            warnings.append(f"{row['mall']} · {row['name'][:36]}: {detail['benefit_condition']}")
        next_price = int(detail.get("display_price") or detail.get("benefit_price") or row["price"])
        next_shipping = int(detail.get("benefit_shipping") if detail.get("benefit_shipping") is not None else row["shipping"])
        next_registered_price = int(detail.get("registered_price") or row["registered_price"] or next_price)
        if next_registered_price < next_price:
            next_registered_price = next_price
        with connect() as db:
            db.execute(
                """
                UPDATE price_items
                SET price = ?, registered_price = ?, shipping = ?, total = ?,
                    benefit_status = ?, coupon_price = ?, event_price = ?, card_price = ?,
                    benefit_price = ?, benefit_shipping = ?, benefit_summary = ?,
                    benefit_condition = ?, detail_methods_json = ?, benefit_checked_at = ?
                WHERE id = ?
                """,
                (
                    next_price,
                    next_registered_price,
                    next_shipping,
                    next_price + next_shipping,
                    detail["benefit_status"],
                    detail["coupon_price"],
                    detail["event_price"],
                    detail["card_price"],
                    detail["benefit_price"],
                    detail["benefit_shipping"],
                    detail["benefit_summary"],
                    detail["benefit_condition"],
                    json.dumps(detail["detail_methods"], ensure_ascii=False),
                    now(),
                    row["id"],
                ),
            )

    run_id = rows[0]["run_id"]
    with connect() as db:
        result = get_run_payload(db, run_id)
    result["warnings"] = warnings
    log_event(f"benefit detail scan completed: {len(rows)} items", "warning" if warnings else "info")
    return result


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


@app.get("/smartstore/category-suggestions", dependencies=[Depends(require_admin)])
def smartstore_categories(q: str, limit: int = 12) -> dict[str, Any]:
    if not q.strip():
        raise HTTPException(status_code=400, detail="카테고리를 추천할 상품명을 입력하세요.")
    with connect() as db:
        key = db.execute("SELECT * FROM api_keys WHERE platform = 'smartstore'").fetchone()
        if not key or not key["client_id"] or not key["client_secret"]:
            raise HTTPException(status_code=400, detail="스마트스토어 커머스API 키를 먼저 저장하세요.")
    try:
        categories = fetch_smartstore_categories(key["client_id"], key["client_secret"])
        items = smartstore_category_suggestions(categories, q, limit)
    except Exception as error:
        log_event(f"smartstore category fetch failed: {error}", "warning")
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"items": items, "count": len(items), "query": q}


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
        reason = "" if not next_value else "사용자 제외"
        db.execute(
            "UPDATE price_items SET is_excluded = ?, is_baseline = 0, exclusion_reason = ? WHERE id = ?",
            (next_value, reason, item_id),
        )
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


@app.put("/orders/{order_id}/procurement", dependencies=[Depends(require_admin)])
def update_procurement(order_id: str, payload: ProcurementUpdateRequest) -> dict[str, Any]:
    allowed_statuses = {
        "source_unlinked",
        "source_check",
        "approval_required",
        "purchase_approved",
        "ordered",
        "tracking_pending",
        "shipped",
        "purchase_failed",
        "cancelled",
    }
    if payload.procurement_status not in allowed_statuses:
        raise HTTPException(status_code=400, detail="Unsupported procurement status")

    timestamp = now()
    with connect() as db:
        current = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if not current:
            raise HTTPException(status_code=404, detail="Order not found")

        next_order_status = current["status"]
        if payload.procurement_status == "ordered":
            next_order_status = "purchase_complete"
        elif payload.procurement_status == "shipped":
            next_order_status = "shipped"
        elif payload.procurement_status == "purchase_failed":
            next_order_status = "exception"

        db.execute(
            """
            UPDATE orders
            SET source_mall = ?, source_url = ?, source_price = ?, source_shipping = ?,
                procurement_status = ?, source_order_no = ?, courier = ?, tracking_no = ?,
                status = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                payload.source_mall.strip() or current["source_mall"],
                payload.source_url.strip() or current["source_url"],
                max(payload.source_price, 0) or current["source_price"],
                max(payload.source_shipping, 0) or current["source_shipping"],
                payload.procurement_status,
                payload.source_order_no.strip() or current["source_order_no"],
                payload.courier.strip() or current["courier"],
                payload.tracking_no.strip() or current["tracking_no"],
                next_order_status,
                timestamp,
                order_id,
            ),
        )
        row = db.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
    log_event(f"procurement updated: {order_id} -> {payload.procurement_status}")
    return row_to_dict(row) or {}


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


@app.get("/prepared-products", dependencies=[Depends(require_admin)])
def prepared_products() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM prepared_products ORDER BY updated_at DESC LIMIT 300"
        ).fetchall()
        return [prepared_product_row_to_dict(db, row) for row in rows]


@app.post("/prepared-products", dependencies=[Depends(require_admin)])
def prepare_product(payload: PreparedProductPayload) -> dict[str, Any]:
    dedupe_key = prepared_product_dedupe_key(payload)
    timestamp = now()
    with connect() as db:
        existing = db.execute(
            "SELECT * FROM prepared_products WHERE dedupe_key = ?",
            (dedupe_key,),
        ).fetchone()
        if existing:
            db.execute(
                """
                UPDATE prepared_products
                SET source_item_id = ?, source = ?, mall = ?, source_url = ?, title = ?,
                    sale_price = ?, display_price = ?, shipping_fee = ?, image_url = ?,
                    product_type = CASE WHEN ? != '' THEN ? ELSE product_type END,
                    model_name = CASE WHEN ? != '' THEN ? ELSE model_name END,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    payload.source_item_id.strip(),
                    payload.source.strip(),
                    payload.mall.strip(),
                    payload.source_url.strip(),
                    payload.title.strip(),
                    max(payload.sale_price, 0),
                    max(payload.display_price, 0),
                    max(payload.shipping_fee, 0),
                    payload.image_url.strip(),
                    payload.product_type.strip(),
                    payload.product_type.strip(),
                    payload.model_name.strip(),
                    payload.model_name.strip(),
                    timestamp,
                    existing["id"],
                ),
            )
            prepared_id = existing["id"]
        else:
            prepared_id = new_id("prepared")
            db.execute(
                """
                INSERT INTO prepared_products (
                    id, dedupe_key, source_item_id, source, mall, source_url, title,
                    sale_price, display_price, shipping_fee, image_url, status,
                    listing_draft_id, product_type, model_name, seller_sale_price,
                    seller_display_price, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', '', ?, ?, ?, ?, ?, ?)
                """,
                (
                    prepared_id,
                    dedupe_key,
                    payload.source_item_id.strip(),
                    payload.source.strip(),
                    payload.mall.strip(),
                    payload.source_url.strip(),
                    payload.title.strip(),
                    max(payload.sale_price, 0),
                    max(payload.display_price, 0),
                    max(payload.shipping_fee, 0),
                    payload.image_url.strip(),
                    payload.product_type.strip(),
                    payload.model_name.strip(),
                    max(payload.sale_price, 0),
                    max(payload.display_price, 0),
                    timestamp,
                    timestamp,
                ),
            )
        row = db.execute("SELECT * FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
    log_event(f"product prepared: {payload.title}")
    with connect() as db:
        fresh = db.execute("SELECT * FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not fresh:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        return prepared_product_row_to_dict(db, fresh)


@app.patch("/prepared-products/{prepared_id}/monitoring", dependencies=[Depends(require_admin)])
def update_prepared_monitoring(prepared_id: str, payload: PreparedMonitoringPayload) -> dict[str, Any]:
    discount_type = payload.auto_discount_type.strip().lower()
    if discount_type not in {"amount", "percent"}:
        raise HTTPException(status_code=422, detail="auto_discount_type must be amount or percent")
    timestamp = now()
    with connect() as db:
        existing = db.execute("SELECT id, title FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        db.execute(
            """
            UPDATE prepared_products
            SET monitoring_enabled = ?, fee_rate = ?, seller_sale_price = ?, seller_display_price = ?,
                auto_discount_enabled = ?, auto_discount_type = ?, auto_discount_value = ?,
                product_type = ?, model_name = ?, status = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                int(payload.monitoring_enabled),
                payload.fee_rate,
                payload.seller_sale_price,
                payload.seller_display_price,
                int(payload.auto_discount_enabled),
                discount_type,
                payload.auto_discount_value,
                payload.product_type.strip(),
                payload.model_name.strip(),
                "monitoring" if payload.monitoring_enabled else "prepared",
                timestamp,
                prepared_id,
            ),
        )
    log_event(f"monitoring {'enabled' if payload.monitoring_enabled else 'disabled'}: {existing['title']}")
    with connect() as db:
        row = db.execute("SELECT * FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        return prepared_product_row_to_dict(db, row)


@app.put("/prepared-products/{prepared_id}/comparison-targets", dependencies=[Depends(require_admin)])
def save_comparison_targets(prepared_id: str, payload: ComparisonTargetsPayload) -> dict[str, Any]:
    timestamp = now()
    seen: set[str] = set()
    with connect() as db:
        existing_product = db.execute("SELECT id, title FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not existing_product:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        for target in payload.targets:
            platform = normalize_comparison_platform(target.platform)
            if platform in seen:
                continue
            seen.add(platform)
            comparison_url = normalize_comparison_url(target.comparison_url)
            if not comparison_url:
                existing_target = db.execute(
                    "SELECT id FROM comparison_targets WHERE prepared_product_id = ? AND platform = ?",
                    (prepared_id, platform),
                ).fetchone()
                if existing_target:
                    db.execute("DELETE FROM competitor_snapshots WHERE target_id = ?", (existing_target["id"],))
                    db.execute("DELETE FROM comparison_targets WHERE id = ?", (existing_target["id"],))
                continue
            db.execute(
                """
                INSERT INTO comparison_targets (
                    id, prepared_product_id, platform, comparison_url, enabled, status,
                    last_scanned_at, last_error, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 'pending', NULL, '', ?, ?)
                ON CONFLICT(prepared_product_id, platform) DO UPDATE SET
                    comparison_url = excluded.comparison_url,
                    enabled = excluded.enabled,
                    status = CASE WHEN comparison_targets.comparison_url != excluded.comparison_url THEN 'pending' ELSE comparison_targets.status END,
                    last_error = CASE WHEN comparison_targets.comparison_url != excluded.comparison_url THEN '' ELSE comparison_targets.last_error END,
                    updated_at = excluded.updated_at
                """,
                (
                    new_id("target"),
                    prepared_id,
                    platform,
                    comparison_url,
                    int(target.enabled),
                    timestamp,
                    timestamp,
                ),
            )
        db.execute("UPDATE prepared_products SET updated_at = ? WHERE id = ?", (timestamp, prepared_id))
        row = db.execute("SELECT * FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        product = prepared_product_row_to_dict(db, row)
    log_event(f"comparison targets saved: {existing_product['title']}")
    return product


@app.post("/prepared-products/{prepared_id}/comparison-scan", dependencies=[Depends(require_admin)])
def scan_comparison_targets(prepared_id: str, payload: ComparisonScanPayload) -> dict[str, Any]:
    selected_platforms = {normalize_comparison_platform(platform) for platform in payload.platforms} if payload.platforms else set()
    warnings: list[str] = []
    scanned_count = 0
    with connect() as db:
        product = db.execute("SELECT id, title FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not product:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        target_rows = db.execute(
            """
            SELECT * FROM comparison_targets
            WHERE prepared_product_id = ? AND enabled = 1 AND comparison_url != ''
            ORDER BY platform ASC
            """,
            (prepared_id,),
        ).fetchall()
        target_rows = [
            row for row in target_rows
            if not selected_platforms or row["platform"] in selected_platforms
        ]
        if not target_rows:
            raise HTTPException(status_code=400, detail="저장된 가격비교 URL이 없습니다.")
        for target in target_rows:
            platform = target["platform"]
            collected_at = now()
            try:
                reserve_collection_request(db, platform)
                competitors = fetch_comparison_competitors(platform, target["comparison_url"])
                for rank, competitor in enumerate(competitors, start=1):
                    db.execute(
                        """
                        INSERT INTO competitor_snapshots (
                            id, target_id, prepared_product_id, platform, rank, mall, title,
                            sale_price, shipping_fee, total_price, detail_url,
                            is_excluded, exclusion_reason, collected_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            new_id("competitor"),
                            target["id"],
                            prepared_id,
                            platform,
                            rank,
                            competitor["mall"],
                            competitor["title"],
                            competitor["sale_price"],
                            competitor["shipping_fee"],
                            competitor["total_price"],
                            competitor["detail_url"],
                            int(competitor["is_excluded"]),
                            competitor["exclusion_reason"],
                            collected_at,
                        ),
                    )
                db.execute(
                    """
                    UPDATE comparison_targets
                    SET status = 'success', last_scanned_at = ?, last_error = '', updated_at = ?
                    WHERE id = ?
                    """,
                    (collected_at, collected_at, target["id"]),
                )
                complete_collection_request(db, platform, "success")
                scanned_count += 1
            except Exception as error:
                message = str(error)[:500]
                warnings.append(f"{COMPARISON_PLATFORM_LABELS.get(platform, platform)}: {message}")
                db.execute(
                    """
                    UPDATE comparison_targets
                    SET status = 'error', last_error = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (message, collected_at, target["id"]),
                )
                if not isinstance(error, CollectionQuotaExceeded):
                    complete_collection_request(db, platform, "error")
        db.execute("UPDATE prepared_products SET updated_at = ? WHERE id = ?", (now(), prepared_id))
        row = db.execute("SELECT * FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        result = prepared_product_row_to_dict(db, row)
        result["scan_warnings"] = warnings
        result["scanned_target_count"] = scanned_count
    log_event(f"comparison scan completed: {product['title']} · {scanned_count} targets", "warning" if warnings else "info")
    return result


@app.get("/prepared-products/{prepared_id}/comparison-history", dependencies=[Depends(require_admin)])
def prepared_product_comparison_history(
    prepared_id: str,
    platforms: str = "",
    limit: int = 10,
) -> dict[str, list[dict[str, Any]]]:
    limit_value = max(1, min(30, int(limit)))
    selected_platforms = parse_platform_filter(platforms)
    with connect() as db:
        product = db.execute("SELECT id FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not product:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        grouped = build_comparison_history_rows(db, prepared_id, selected_platforms, limit_value)
        result: dict[str, list[dict[str, Any]]] = {}
        for platform in COMPARISON_TARGET_PLATFORMS:
            rows = [competitor_snapshot_row_to_dict(row) for row in grouped.get(platform, [])]
            if rows:
                result[platform] = rows
    return result


@app.delete("/prepared-products/{prepared_id}", dependencies=[Depends(require_admin)])
def delete_prepared_product(prepared_id: str) -> dict[str, str]:
    with connect() as db:
        row = db.execute("SELECT title FROM prepared_products WHERE id = ?", (prepared_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Prepared product not found")
        target_rows = db.execute("SELECT id FROM comparison_targets WHERE prepared_product_id = ?", (prepared_id,)).fetchall()
        for target in target_rows:
            db.execute("DELETE FROM competitor_snapshots WHERE target_id = ?", (target["id"],))
        db.execute("DELETE FROM comparison_targets WHERE prepared_product_id = ?", (prepared_id,))
        db.execute("DELETE FROM prepared_products WHERE id = ?", (prepared_id,))
    log_event(f"prepared product deleted: {row['title']}")
    return {"status": "deleted", "id": prepared_id}


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
                image_url, option_name, description, brand_name, manufacturer_name, model_name,
                origin_area_code, origin_area_name, product_info_notice_type, product_info_notice_content,
                delivery_method, delivery_company_code, return_delivery_fee, exchange_delivery_fee,
                as_telephone, as_guide_content, status, platform_status_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                payload.brand_name,
                payload.manufacturer_name,
                payload.model_name,
                payload.origin_area_code,
                payload.origin_area_name,
                payload.product_info_notice_type,
                payload.product_info_notice_content,
                payload.delivery_method,
                payload.delivery_company_code,
                max(payload.return_delivery_fee, 0),
                max(payload.exchange_delivery_fee, 0),
                payload.as_telephone,
                payload.as_guide_content,
                "draft",
                json.dumps({platform: "draft" for platform in target_platforms}, ensure_ascii=False),
                timestamp,
                timestamp,
            ),
        )
        db.execute(
            """
            UPDATE prepared_products
            SET status = 'drafting', listing_draft_id = ?, updated_at = ?
            WHERE source = ? AND source_item_id = ?
            """,
            (draft_id, timestamp, payload.source, payload.source_item_id),
        )
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing draft created: {payload.title}")
    return listing_draft_row_to_dict(row)


@app.put("/listing-drafts/{draft_id}", dependencies=[Depends(require_admin)])
def update_listing_draft(draft_id: str, payload: ListingDraftPayload) -> dict[str, Any]:
    target_platforms = [platform for platform in payload.target_platforms if platform == "smartstore"] or ["smartstore"]
    with connect() as db:
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")

        images = normalize_draft_images(parse_json_text(row["images_json"], {}), row["image_url"])
        images["representative_url"] = payload.image_url.strip()
        draft_data = row_to_dict(row) or {}
        draft_data.update(
            {
                "source_item_id": payload.source_item_id,
                "source": payload.source,
                "mall": payload.mall,
                "source_url": payload.source_url,
                "target_platforms_json": json.dumps(target_platforms, ensure_ascii=False),
                "title": payload.title,
                "sale_price": max(payload.sale_price, 0),
                "display_price": max(payload.display_price, 0),
                "shipping_fee": max(payload.shipping_fee, 0),
                "category_id": payload.category_id,
                "stock_quantity": max(payload.stock_quantity, 0),
                "image_url": images["representative_url"],
                "images_json": draft_images_to_json(images),
                "option_name": payload.option_name,
                "description": payload.description,
                "brand_name": payload.brand_name,
                "manufacturer_name": payload.manufacturer_name,
                "model_name": payload.model_name,
                "origin_area_code": payload.origin_area_code,
                "origin_area_name": payload.origin_area_name,
                "product_info_notice_type": payload.product_info_notice_type,
                "product_info_notice_content": payload.product_info_notice_content,
                "delivery_method": payload.delivery_method,
                "delivery_company_code": payload.delivery_company_code,
                "return_delivery_fee": max(payload.return_delivery_fee, 0),
                "exchange_delivery_fee": max(payload.exchange_delivery_fee, 0),
                "as_telephone": payload.as_telephone,
                "as_guide_content": payload.as_guide_content,
            }
        )
        validation = validate_listing_draft_data(draft_data)
        if row["status"] == "draft":
            next_status = "draft"
            platform_status = parse_json_text(row["platform_status_json"], {}) or {platform: "draft" for platform in target_platforms}
            publish_error = row["publish_error"]
        else:
            next_status = "validated" if validation["ready"] else "validation_failed"
            platform_status = {platform: next_status for platform in target_platforms}
            publish_error = "" if validation["ready"] else "필수값 부족"

        db.execute(
            """
            UPDATE listing_drafts
            SET source_item_id = ?, source = ?, mall = ?, source_url = ?, target_platforms_json = ?,
                title = ?, sale_price = ?, display_price = ?, shipping_fee = ?, category_id = ?,
                stock_quantity = ?, image_url = ?, images_json = ?, option_name = ?, description = ?,
                brand_name = ?, manufacturer_name = ?, model_name = ?, origin_area_code = ?,
                origin_area_name = ?, product_info_notice_type = ?, product_info_notice_content = ?,
                delivery_method = ?, delivery_company_code = ?, return_delivery_fee = ?,
                exchange_delivery_fee = ?, as_telephone = ?, as_guide_content = ?,
                status = ?, platform_status_json = ?, validation_json = ?, publish_request_json = ?,
                publish_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
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
                images["representative_url"],
                draft_images_to_json(images),
                payload.option_name,
                payload.description,
                payload.brand_name,
                payload.manufacturer_name,
                payload.model_name,
                payload.origin_area_code,
                payload.origin_area_name,
                payload.product_info_notice_type,
                payload.product_info_notice_content,
                payload.delivery_method,
                payload.delivery_company_code,
                max(payload.return_delivery_fee, 0),
                max(payload.exchange_delivery_fee, 0),
                payload.as_telephone,
                payload.as_guide_content,
                next_status,
                json.dumps(platform_status, ensure_ascii=False),
                json.dumps(validation, ensure_ascii=False),
                "{}",
                publish_error,
                now(),
                draft_id,
            ),
        )
        updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing draft updated: {payload.title}")
    return listing_draft_row_to_dict(updated)


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


@app.delete("/listing-drafts/{draft_id}", dependencies=[Depends(require_admin)])
def delete_listing_draft(draft_id: str) -> dict[str, str]:
    with connect() as db:
        row = db.execute("SELECT title FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")
        db.execute(
            """
            UPDATE prepared_products
            SET status = 'prepared', listing_draft_id = '', updated_at = ?
            WHERE listing_draft_id = ?
            """,
            (now(), draft_id),
        )
        db.execute("DELETE FROM listing_drafts WHERE id = ?", (draft_id,))
    log_event(f"listing draft deleted: {row['title']}")
    return {"status": "deleted", "id": draft_id}


@app.put("/listing-drafts/{draft_id}/image", dependencies=[Depends(require_admin)])
def update_listing_draft_image(draft_id: str, payload: ListingDraftImagePayload) -> dict[str, Any]:
    image_url = payload.image_url.strip()
    if not image_url:
        raise HTTPException(status_code=400, detail="대표 이미지 URL이 필요합니다.")
    if not image_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="대표 이미지 URL은 http/https 주소여야 합니다.")

    with connect() as db:
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")

        draft_data = row_to_dict(row) or {}
        images = normalize_draft_images(parse_json_text(row["images_json"], {}), row["image_url"])
        images["representative_url"] = image_url
        draft_data["image_url"] = image_url
        draft_data["images_json"] = draft_images_to_json(images)
        validation = validate_listing_draft_data(draft_data)
        status = row["status"]
        publish_error = row["publish_error"]
        platform_status = parse_json_text(row["platform_status_json"], {})
        publish_request = parse_json_text(row["publish_request_json"], {})

        if status in {"validated", "validation_failed"}:
            status = "validated" if validation["ready"] else "validation_failed"
            platform_status["smartstore"] = status
            publish_error = "" if validation["ready"] else "필수값 부족"
        elif status == "publish_ready":
            if validation["ready"]:
                publish_request = build_smartstore_publish_request(draft_data, validation)
                platform_status["smartstore"] = "protected_ready"
                publish_error = ""
            else:
                status = "validation_failed"
                platform_status["smartstore"] = "validation_failed"
                publish_error = "필수값 부족"

        db.execute(
            """
            UPDATE listing_drafts
            SET image_url = ?, images_json = ?, validation_json = ?, publish_request_json = ?,
                status = ?, platform_status_json = ?, publish_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                image_url,
                draft_images_to_json(images),
                json.dumps(validation, ensure_ascii=False),
                json.dumps(publish_request, ensure_ascii=False),
                status,
                json.dumps(platform_status, ensure_ascii=False),
                publish_error,
                now(),
                draft_id,
            ),
        )
        updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing draft image updated: {row['title']}")
    return listing_draft_row_to_dict(updated)


@app.put("/listing-drafts/{draft_id}/images", dependencies=[Depends(require_admin)])
def update_listing_draft_images(draft_id: str, payload: ListingDraftImagesPayload) -> dict[str, Any]:
    images = normalize_draft_images(
        {
            "representative_url": payload.representative_url,
            "optional_urls": payload.optional_urls,
            "detail_urls": payload.detail_urls,
        }
    )
    all_urls = [images["representative_url"], *images["optional_urls"], *images["detail_urls"]]
    invalid_urls = [url for url in all_urls if url and not url.startswith(("http://", "https://"))]
    if invalid_urls:
        raise HTTPException(status_code=400, detail="이미지 URL은 http/https 주소여야 합니다.")

    with connect() as db:
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")

        draft_data = row_to_dict(row) or {}
        draft_data["image_url"] = images["representative_url"]
        draft_data["images_json"] = draft_images_to_json(images)
        detail_content_html = payload.detail_content_html.strip() or generate_detail_content_html(draft_data, images)
        draft_data["detail_content_html"] = detail_content_html
        validation = validate_listing_draft_data(draft_data)
        status = row["status"]
        publish_error = row["publish_error"]
        platform_status = parse_json_text(row["platform_status_json"], {})
        publish_request = parse_json_text(row["publish_request_json"], {})

        if status in {"validated", "validation_failed"}:
            status = "validated" if validation["ready"] else "validation_failed"
            platform_status["smartstore"] = status
            publish_error = "" if validation["ready"] else "필수값 부족"
        elif status == "publish_ready":
            if validation["ready"]:
                publish_request = build_smartstore_publish_request(draft_data, validation)
                platform_status["smartstore"] = "protected_ready"
                publish_error = ""
            else:
                status = "validation_failed"
                platform_status["smartstore"] = "validation_failed"
                publish_error = "필수값 부족"

        db.execute(
            """
            UPDATE listing_drafts
            SET image_url = ?, images_json = ?, detail_content_html = ?,
                validation_json = ?, publish_request_json = ?, status = ?,
                platform_status_json = ?, publish_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                images["representative_url"],
                draft_images_to_json(images),
                detail_content_html,
                json.dumps(validation, ensure_ascii=False),
                json.dumps(publish_request, ensure_ascii=False),
                status,
                json.dumps(platform_status, ensure_ascii=False),
                publish_error,
                now(),
                draft_id,
            ),
        )
        updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing draft images updated: {row['title']}")
    return listing_draft_row_to_dict(updated)


@app.post("/listing-drafts/{draft_id}/validate", dependencies=[Depends(require_admin)])
def validate_listing_draft(draft_id: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")

        validation = validate_listing_draft_data(row_to_dict(row) or {})
        next_status = "validated" if validation["ready"] else "validation_failed"
        platform_status = {"smartstore": next_status}
        db.execute(
            """
            UPDATE listing_drafts
            SET status = ?, validation_json = ?, platform_status_json = ?, publish_error = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                next_status,
                json.dumps(validation, ensure_ascii=False),
                json.dumps(platform_status, ensure_ascii=False),
                "" if validation["ready"] else "필수값 부족",
                now(),
                draft_id,
            ),
        )
        updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing draft validation: {row['title']} · {next_status}", "info" if validation["ready"] else "warning")
    return listing_draft_row_to_dict(updated)


@app.post("/listing-drafts/{draft_id}/publish", dependencies=[Depends(require_admin)])
def prepare_listing_publish(draft_id: str) -> dict[str, Any]:
    with connect() as db:
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")
        key = db.execute("SELECT * FROM api_keys WHERE platform = 'smartstore'").fetchone()
        if not key or key["status"] not in {"connected", "configured"}:
            raise HTTPException(status_code=400, detail="네이버 스마트스토어 API 연결 후 등록 실행할 수 있습니다.")

        draft_data = row_to_dict(row) or {}
        validation = validate_listing_draft_data(draft_data)
        if not validation["ready"]:
            platform_status = {"smartstore": "validation_failed"}
            db.execute(
                """
                UPDATE listing_drafts
                SET status = ?, validation_json = ?, platform_status_json = ?, publish_error = ?, last_publish_attempt_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    "validation_failed",
                    json.dumps(validation, ensure_ascii=False),
                    json.dumps(platform_status, ensure_ascii=False),
                    "필수값 부족",
                    now(),
                    now(),
                    draft_id,
                ),
            )
            updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
            log_event(f"listing publish blocked by validation: {row['title']}", "warning")
            return listing_draft_row_to_dict(updated)

        publish_request = build_smartstore_publish_request(draft_data, validation)
        platform_status = {"smartstore": "protected_ready"}
        db.execute(
            """
            UPDATE listing_drafts
            SET status = ?, validation_json = ?, publish_request_json = ?, publish_mode = ?,
                platform_status_json = ?, publish_error = ?, last_publish_attempt_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                "publish_ready",
                json.dumps(validation, ensure_ascii=False),
                json.dumps(publish_request, ensure_ascii=False),
                "protected",
                json.dumps(platform_status, ensure_ascii=False),
                "",
                now(),
                now(),
                draft_id,
            ),
        )
        updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(f"listing publish request prepared: {row['title']}")
    return listing_draft_row_to_dict(updated)


@app.post("/listing-drafts/{draft_id}/publish-live", dependencies=[Depends(require_admin)])
def publish_listing_live(draft_id: str, payload: ListingLivePublishPayload) -> dict[str, Any]:
    if payload.confirmation != NAVER_LIVE_PUBLISH_CONFIRMATION:
        raise HTTPException(status_code=400, detail="실제 등록 확인값이 올바르지 않습니다.")

    validation_error = ""
    with connect() as db:
        row = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Listing draft not found")
        if row["external_product_no"] or row["external_channel_product_no"] or row["status"] == "published":
            raise HTTPException(status_code=409, detail="이미 네이버에 등록된 상품입니다. 등록 상품번호를 확인하세요.")
        if row["status"] == "publishing":
            raise HTTPException(status_code=409, detail="등록 요청이 진행 중입니다. 중복 등록 방지를 위해 다시 요청할 수 없습니다.")

        key = db.execute("SELECT * FROM api_keys WHERE platform = 'smartstore'").fetchone()
        if not key or key["status"] not in {"connected", "configured"}:
            raise HTTPException(status_code=400, detail="네이버 스마트스토어 커머스API 연결 테스트를 먼저 완료하세요.")

        draft_data = row_to_dict(row) or {}
        validation = validate_smartstore_live_draft_data(draft_data)
        if not validation["ready"]:
            missing_labels = ", ".join(item["label"] for item in validation["missing"])
            validation_error = f"실제 등록 필수값 부족: {missing_labels}"
            db.execute(
                """
                UPDATE listing_drafts
                SET status = 'validation_failed', validation_json = ?, platform_status_json = ?,
                    publish_error = ?, last_publish_attempt_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    json.dumps(validation, ensure_ascii=False),
                    json.dumps({"smartstore": "validation_failed"}, ensure_ascii=False),
                    validation_error,
                    now(),
                    now(),
                    draft_id,
                ),
            )
        else:
            images = normalize_draft_images(
                parse_json_text(str(draft_data.get("images_json") or "{}"), {}),
                str(draft_data.get("image_url") or ""),
            )
            image_urls = [images["representative_url"], *images["optional_urls"]]
            client_id = str(key["client_id"])
            client_secret = str(key["client_secret"])
            attempt_at = now()
            db.execute(
                """
                UPDATE listing_drafts
                SET status = 'publishing', validation_json = ?, publish_mode = 'live',
                    platform_status_json = ?, publish_error = '', last_publish_attempt_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    json.dumps(validation, ensure_ascii=False),
                    json.dumps({"smartstore": "publishing"}, ensure_ascii=False),
                    attempt_at,
                    attempt_at,
                    draft_id,
                ),
            )

    if validation_error:
        log_event(f"live listing publish blocked: {draft_data.get('title', '')} · {validation_error}", "warning")
        raise HTTPException(status_code=400, detail=validation_error)

    try:
        access_token = fetch_smartstore_access_token(client_id, client_secret)
        uploaded_image_urls = upload_naver_product_images(access_token, image_urls)
        product_request = build_naver_live_product_payload(draft_data, uploaded_image_urls)
        origin_product_no, channel_product_no, response_data = create_naver_product(access_token, product_request)
    except Exception as error:
        error_message = str(error)[:1200] or "네이버 실제 상품등록에 실패했습니다."
        with connect() as db:
            db.execute(
                """
                UPDATE listing_drafts
                SET status = 'publish_failed', platform_status_json = ?, publish_error = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    json.dumps({"smartstore": "publish_failed"}, ensure_ascii=False),
                    error_message,
                    now(),
                    draft_id,
                ),
            )
        log_event(f"live listing publish failed: {draft_data.get('title', '')} · {error_message}", "error")
        raise HTTPException(status_code=502, detail=error_message) from error

    publish_request = {
        "platform": "smartstore",
        "mode": "live",
        "request": product_request,
        "uploaded_image_urls": uploaded_image_urls,
        "response": response_data,
        "published_at": now(),
    }
    seller_center_url = "https://sell.smartstore.naver.com/#/products/origin-list"
    with connect() as db:
        db.execute(
            """
            UPDATE listing_drafts
            SET status = 'published', publish_request_json = ?, publish_mode = 'live',
                platform_status_json = ?, external_product_no = ?, external_channel_product_no = ?,
                external_url = ?, publish_error = '', updated_at = ?
            WHERE id = ?
            """,
            (
                json.dumps(publish_request, ensure_ascii=False),
                json.dumps({"smartstore": "published"}, ensure_ascii=False),
                origin_product_no,
                channel_product_no,
                seller_center_url,
                now(),
                draft_id,
            ),
        )
        updated = db.execute("SELECT * FROM listing_drafts WHERE id = ?", (draft_id,)).fetchone()
    log_event(
        f"live listing published: {draft_data.get('title', '')} · origin={origin_product_no} · channel={channel_product_no}"
    )
    return listing_draft_row_to_dict(updated)


@app.get("/image-assets", dependencies=[Depends(require_admin)])
def image_assets() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT * FROM image_assets ORDER BY created_at DESC LIMIT 120").fetchall()
        return [row_to_dict(row) or {} for row in rows]


@app.post("/uploads/product-image", dependencies=[Depends(require_admin)])
async def upload_product_image(file: UploadFile = File(...)) -> dict[str, Any]:
    content_type = (file.content_type or "").lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="jpg, png, webp, gif 이미지만 업로드할 수 있습니다.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="빈 파일은 업로드할 수 없습니다.")
    if len(content) > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="이미지는 8MB 이하만 업로드할 수 있습니다.")

    original_name = safe_upload_filename(file.filename or "image")
    original_suffix = Path(original_name).suffix.lower()
    extension = original_suffix if original_suffix in {".jpg", ".jpeg", ".png", ".webp", ".gif"} else ALLOWED_IMAGE_TYPES[content_type]
    if extension == ".jpeg":
        extension = ".jpg"
    saved_name = f"product_{uuid4().hex[:16]}{extension}"
    target_path = UPLOAD_DIR / saved_name
    target_path.write_bytes(content)
    asset_id = new_id("img")
    asset_url = f"/uploaded-images/{saved_name}"
    with connect() as db:
        db.execute(
            """
            INSERT INTO image_assets (
                id, filename, original_filename, content_type, size, url, source, purpose, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                asset_id,
                saved_name,
                original_name,
                content_type,
                len(content),
                asset_url,
                "upload",
                "product",
                now(),
            ),
        )

    log_event(f"product image uploaded: {original_name}")
    return {
        "id": asset_id,
        "filename": saved_name,
        "original_filename": original_name,
        "content_type": content_type,
        "size": len(content),
        "url": asset_url,
    }


@app.get("/uploaded-images/{filename}")
def uploaded_image(filename: str) -> FileResponse:
    safe_name = safe_upload_filename(filename)
    if safe_name != filename:
        raise HTTPException(status_code=404, detail="Image not found")
    image_path = UPLOAD_DIR / safe_name
    if not image_path.exists() or not image_path.is_file():
        raise HTTPException(status_code=404, detail="Image not found")
    media_type = mimetypes.guess_type(str(image_path))[0] or "application/octet-stream"
    return FileResponse(image_path, media_type=media_type)


@app.get("/logs", dependencies=[Depends(require_admin)])
def logs() -> list[dict[str, Any]]:
    with connect() as db:
        return [row_to_dict(row) or {} for row in db.execute("SELECT * FROM logs ORDER BY created_at DESC LIMIT 80").fetchall()]


app.include_router(create_seller_router(connect, require_admin, get_run_payload))
