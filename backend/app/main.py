from __future__ import annotations

import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = Path(os.getenv("DATABASE_PATH", DATA_DIR / "pricescan.db"))
ADMIN_TOKEN = "pricescan-admin-token"


app = FastAPI(title="PriceScan API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


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
            """
        )

        platforms = [
            ("naver", "네이버 검색 API"),
            ("naver_datalab", "네이버 데이터랩"),
            ("coupang", "쿠팡"),
            ("danawa", "다나와"),
            ("enuri", "에누리"),
        ]
        for platform, label in platforms:
            db.execute(
                """
                INSERT OR IGNORE INTO api_keys (platform, label)
                VALUES (?, ?)
                """,
                (platform, label),
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


class InvoicePrintRequest(BaseModel):
    order_ids: list[str]


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
        api_ready = db.execute("SELECT COUNT(*) AS count FROM api_keys WHERE status = 'connected'").fetchone()["count"]
        latest_payload = get_run_payload(db, latest["id"]) if latest else None
    return {
        "stats": {
            "collected_products": item_count,
            "lowest_candidates": latest_payload["summary"]["lowest_count"] if latest_payload else 0,
            "pending_publish": 42,
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
        connected = bool(key["client_id"] and key["client_secret"])
        status = "connected" if connected else "warning"
        db.execute(
            "UPDATE api_keys SET status = ?, last_tested_at = ? WHERE platform = ?",
            (status, now(), platform),
        )
    log_event(f"{platform} API test: {status}", "info" if connected else "warning")
    return {
        "platform": platform,
        "status": status,
        "message": "API 키 형식 확인 완료" if connected else "Client ID/Secret 입력 필요",
    }


@app.post("/price-search", dependencies=[Depends(require_admin)])
def price_search(payload: PriceSearchRequest) -> dict[str, Any]:
    run_id = new_id("run")
    items = sample_products(payload.query)
    if payload.sort_mode == "recent":
        items = list(reversed(items))
    else:
        items = sorted(items, key=lambda item: item["total"])
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
            (run_id, payload.query, payload.sort_mode, "completed", str(payload.filters), now()),
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
        payload_out = get_run_payload(db, run_id)
    log_event(f"price search completed: {payload.query}")
    return payload_out


@app.get("/price-search/latest", dependencies=[Depends(require_admin)])
def latest_price_search() -> dict[str, Any]:
    with connect() as db:
        latest = db.execute("SELECT id FROM search_runs ORDER BY created_at DESC LIMIT 1").fetchone()
        if not latest:
            return {"run": None, "items": [], "summary": {"collected_count": 0, "lowest_count": 0, "excluded_count": 0}}
        return get_run_payload(db, latest["id"])


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
    return [
        {"name": "스마트스토어", "status": "ready", "description": "카테고리/옵션/이미지/상세설명"},
        {"name": "쿠팡", "status": "pending", "description": "승인 필요/불필요 상품 플로우"},
        {"name": "11번가", "status": "pending", "description": "가격/재고/배송 템플릿"},
        {"name": "자사몰", "status": "ready", "description": "CSV/API 업로드"},
    ]


@app.get("/logs", dependencies=[Depends(require_admin)])
def logs() -> list[dict[str, Any]]:
    with connect() as db:
        return [row_to_dict(row) or {} for row in db.execute("SELECT * FROM logs ORDER BY created_at DESC LIMIT 80").fetchall()]
