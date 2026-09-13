from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Literal

import bcrypt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field, field_validator


DEFAULT_DAILY_SEARCH_LIMIT = 10
SESSION_DAYS = 7
MAX_LOGIN_FAILURES = 5
LOGIN_LOCK_MINUTES = 15


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def timestamp() -> str:
    return utc_now().isoformat()


def usage_date() -> str:
    # PriceScan is operated in Korea; a fixed offset avoids a global TZ mutation.
    return (utc_now() + timedelta(hours=9)).date().isoformat()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def password_matches(password: str, encoded: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), encoded.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def init_auth_tables(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS app_users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
            can_search INTEGER NOT NULL DEFAULT 1,
            daily_search_limit INTEGER NOT NULL DEFAULT 10,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            role TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_login_attempts (
            username TEXT PRIMARY KEY,
            failures INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_search_usage (
            user_id TEXT NOT NULL,
            usage_date TEXT NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 0,
            last_requested_at TEXT,
            PRIMARY KEY (user_id, usage_date)
        );
        CREATE TABLE IF NOT EXISTS system_ai_config (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            base_url TEXT NOT NULL,
            encrypted_api_key TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auth_security_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        """
    )
    created = timestamp()
    db.execute(
        """
        INSERT OR IGNORE INTO app_users
            (id, username, password_hash, role, can_search, daily_search_limit, active, created_at, updated_at)
        VALUES ('user_admin', 'admin', ?, 'admin', 1, ?, 1, ?, ?)
        """,
        (password_hash("admin"), DEFAULT_DAILY_SEARCH_LIMIT, created, created),
    )
    db.execute(
        """
        INSERT OR IGNORE INTO system_ai_config
            (id, provider, model, base_url, encrypted_api_key, updated_at)
        VALUES ('primary', 'OpenAI', 'gpt-5.6-luna', 'https://api.openai.com/v1', '', ?)
        """,
        (created,),
    )


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)


class AiConfigUpdate(BaseModel):
    provider: str = Field(default="OpenAI", min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=160)
    base_url: str = Field(min_length=1, max_length=500)
    api_key: str = Field(default="", max_length=1000)

    @field_validator("base_url")
    @classmethod
    def secure_base_url(cls, value: str) -> str:
        cleaned = value.strip().rstrip("/")
        if not cleaned.startswith("https://"):
            raise ValueError("AI API 주소는 https:// 주소여야 합니다.")
        return cleaned


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=80, pattern=r"^[A-Za-z0-9_.-]+$")
    password: str = Field(min_length=8, max_length=200)
    role: Literal["admin", "user"] = "user"
    can_search: bool = True
    daily_search_limit: int = Field(default=DEFAULT_DAILY_SEARCH_LIMIT, ge=0, le=100000)


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=8, max_length=200)
    role: Literal["admin", "user"] | None = None
    can_search: bool | None = None
    daily_search_limit: int | None = Field(default=None, ge=0, le=100000)
    active: bool | None = None


class AuthService:
    def __init__(self, connect: Callable, data_dir: Path, legacy_admin_token: str):
        self.connect = connect
        self.data_dir = data_dir
        self.legacy_admin_token = legacy_admin_token

    def initialize(self) -> None:
        with self.connect() as db:
            init_auth_tables(db)
            password_fingerprint = hashlib.sha256(os.getenv("PRICESCAN_SUPERADMIN_PASSWORD_HASH", "").encode("utf-8")).hexdigest()
            previous = db.execute("SELECT value FROM auth_security_state WHERE key = 'superadmin_password'").fetchone()
            if not previous or previous["value"] != password_fingerprint:
                db.execute("DELETE FROM auth_sessions WHERE role = 'superadmin'")
                db.execute(
                    """INSERT INTO auth_security_state (key, value, updated_at) VALUES ('superadmin_password', ?, ?)
                       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
                    (password_fingerprint, timestamp()),
                )
        self.load_ai_config()

    def _fernet(self) -> Fernet:
        key_path = self.data_dir / "ai_config.key"
        if not key_path.exists():
            key_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as file:
                file.write(Fernet.generate_key())
        os.chmod(key_path, 0o600)
        return Fernet(key_path.read_bytes().strip())

    def _decrypt_key(self, encrypted: str) -> str:
        if not encrypted:
            return ""
        try:
            return self._fernet().decrypt(encrypted.encode("utf-8")).decode("utf-8")
        except (InvalidToken, ValueError):
            return ""

    def load_ai_config(self) -> None:
        with self.connect() as db:
            row = db.execute("SELECT * FROM system_ai_config WHERE id = 'primary'").fetchone()
        if not row:
            return
        key = self._decrypt_key(row["encrypted_api_key"])
        if key:
            os.environ["PRICESCAN_AI_API_KEY"] = key
        os.environ["PRICESCAN_AI_PROVIDER"] = row["provider"]
        os.environ["PRICESCAN_AI_MODEL"] = row["model"]
        os.environ["PRICESCAN_AI_BASE_URL"] = row["base_url"]

    def _check_lock(self, db: sqlite3.Connection, username: str) -> None:
        row = db.execute("SELECT * FROM auth_login_attempts WHERE username = ?", (username,)).fetchone()
        if row and row["locked_until"]:
            locked_until = datetime.fromisoformat(row["locked_until"])
            if locked_until > utc_now():
                raise HTTPException(429, "로그인 시도가 너무 많습니다. 15분 후 다시 시도해 주세요.")

    def _record_failure(self, db: sqlite3.Connection, username: str) -> None:
        row = db.execute("SELECT failures FROM auth_login_attempts WHERE username = ?", (username,)).fetchone()
        failures = int(row["failures"] if row else 0) + 1
        locked_until = (utc_now() + timedelta(minutes=LOGIN_LOCK_MINUTES)).isoformat() if failures >= MAX_LOGIN_FAILURES else None
        db.execute(
            """INSERT INTO auth_login_attempts (username, failures, locked_until, updated_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(username) DO UPDATE SET failures=excluded.failures, locked_until=excluded.locked_until, updated_at=excluded.updated_at""",
            (username, failures, locked_until, timestamp()),
        )

    def login(self, username: str, password: str) -> dict[str, str]:
        username = username.strip().lower()
        with self.connect() as db:
            self._check_lock(db, username)
            if username == "superadmin":
                encoded = os.getenv("PRICESCAN_SUPERADMIN_PASSWORD_HASH", "")
                valid = bool(encoded) and password_matches(password, encoded)
                identity = {"id": "superadmin", "username": "superadmin", "role": "superadmin"} if valid else None
            else:
                row = db.execute("SELECT * FROM app_users WHERE username = ? AND active = 1", (username,)).fetchone()
                valid = bool(row) and password_matches(password, row["password_hash"])
                identity = dict(row) if valid and row else None
            if not identity:
                self._record_failure(db, username)
                # The surrounding transaction rolls back on HTTPException, so
                # persist the security counter before returning the failure.
                db.commit()
                raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다.")
            db.execute("DELETE FROM auth_login_attempts WHERE username = ?", (username,))
            token = secrets.token_urlsafe(40)
            db.execute(
                "INSERT INTO auth_sessions (token_hash, user_id, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
                (token_hash(token), identity["id"], identity["role"], (utc_now() + timedelta(days=SESSION_DAYS)).isoformat(), timestamp()),
            )
        return {"token": token, "name": identity["username"], "role": identity["role"]}

    def _resolve(self, authorization: str | None) -> dict[str, Any]:
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "로그인이 필요합니다.")
        token = authorization[7:]
        with self.connect() as db:
            if token == self.legacy_admin_token:
                row = db.execute("SELECT * FROM app_users WHERE id = 'user_admin'").fetchone()
                if not row:
                    raise HTTPException(401, "로그인이 필요합니다.")
                return dict(row)
            session = db.execute("SELECT * FROM auth_sessions WHERE token_hash = ?", (token_hash(token),)).fetchone()
            if not session or datetime.fromisoformat(session["expires_at"]) <= utc_now():
                raise HTTPException(401, "로그인이 만료되었습니다.")
            if session["role"] == "superadmin":
                return {"id": "superadmin", "username": "superadmin", "role": "superadmin", "can_search": 1, "daily_search_limit": None, "active": 1}
            row = db.execute("SELECT * FROM app_users WHERE id = ? AND active = 1", (session["user_id"],)).fetchone()
            if not row:
                raise HTTPException(401, "비활성화되었거나 삭제된 계정입니다.")
            return dict(row)

    def require_authenticated(self, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        return self._resolve(authorization)

    def require_admin(self, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        user = self._resolve(authorization)
        if user["role"] not in {"admin", "superadmin"}:
            raise HTTPException(403, "관리자 권한이 필요합니다.")
        return user

    def require_superadmin(self, authorization: str | None = Header(default=None)) -> dict[str, Any]:
        user = self._resolve(authorization)
        if user["role"] != "superadmin":
            raise HTTPException(403, "슈퍼관리자 권한이 필요합니다.")
        return user

    def profile(self, user: dict[str, Any]) -> dict[str, Any]:
        if user["role"] == "superadmin":
            return {"id": "superadmin", "username": "superadmin", "role": "superadmin", "can_search": True, "daily_search_limit": None, "used": 0, "remaining": None, "usage_date": usage_date()}
        with self.connect() as db:
            row = db.execute("SELECT request_count FROM user_search_usage WHERE user_id = ? AND usage_date = ?", (user["id"], usage_date())).fetchone()
        used = int(row["request_count"] if row else 0)
        limit = int(user["daily_search_limit"])
        return {"id": user["id"], "username": user["username"], "role": user["role"], "can_search": bool(user["can_search"]), "daily_search_limit": limit, "used": used, "remaining": max(limit - used, 0), "usage_date": usage_date()}

    def reserve_search(self, user: dict[str, Any] | None) -> None:
        if not user or user.get("role") == "superadmin":
            return
        if not bool(user.get("can_search")):
            raise HTTPException(403, "슈퍼관리자가 검색 권한을 중지했습니다.")
        limit = int(user.get("daily_search_limit") or 0)
        with self.connect() as db:
            row = db.execute("SELECT request_count FROM user_search_usage WHERE user_id = ? AND usage_date = ?", (user["id"], usage_date())).fetchone()
            used = int(row["request_count"] if row else 0)
            if used >= limit:
                raise HTTPException(429, f"오늘 검색 한도 {limit}회를 모두 사용했습니다.")
            db.execute(
                """INSERT INTO user_search_usage (user_id, usage_date, request_count, last_requested_at) VALUES (?, ?, 1, ?)
                   ON CONFLICT(user_id, usage_date) DO UPDATE SET request_count=request_count+1, last_requested_at=excluded.last_requested_at""",
                (user["id"], usage_date(), timestamp()),
            )

    def user_payload(self, db: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
        data = dict(row)
        usage = db.execute("SELECT request_count FROM user_search_usage WHERE user_id = ? AND usage_date = ?", (data["id"], usage_date())).fetchone()
        used = int(usage["request_count"] if usage else 0)
        return {k: data[k] for k in ("id", "username", "role", "created_at", "updated_at")} | {
            "can_search": bool(data["can_search"]), "active": bool(data["active"]),
            "daily_search_limit": int(data["daily_search_limit"]), "used": used,
            "remaining": max(int(data["daily_search_limit"]) - used, 0),
        }

    def router(self) -> APIRouter:
        router = APIRouter()

        @router.post("/auth/login")
        def login(payload: LoginRequest) -> dict[str, str]:
            return self.login(payload.username, payload.password)

        @router.get("/auth/me")
        def me(user: dict[str, Any] = Depends(self.require_authenticated)) -> dict[str, Any]:
            return self.profile(user)

        @router.get("/super-admin/ai-config")
        def get_ai_config(_: dict[str, Any] = Depends(self.require_superadmin)) -> dict[str, Any]:
            with self.connect() as db:
                row = db.execute("SELECT * FROM system_ai_config WHERE id = 'primary'").fetchone()
            return {"provider": row["provider"], "model": row["model"], "base_url": row["base_url"], "key_configured": bool(row["encrypted_api_key"] or os.getenv("PRICESCAN_AI_API_KEY", "")), "api_key": ""}

        @router.put("/super-admin/ai-config")
        def save_ai_config(payload: AiConfigUpdate, _: dict[str, Any] = Depends(self.require_superadmin)) -> dict[str, Any]:
            with self.connect() as db:
                current = db.execute("SELECT encrypted_api_key FROM system_ai_config WHERE id = 'primary'").fetchone()
                encrypted = current["encrypted_api_key"] if current else ""
                if payload.api_key.strip():
                    encrypted = self._fernet().encrypt(payload.api_key.strip().encode("utf-8")).decode("utf-8")
                db.execute(
                    "UPDATE system_ai_config SET provider=?, model=?, base_url=?, encrypted_api_key=?, updated_at=? WHERE id='primary'",
                    (payload.provider.strip(), payload.model.strip(), payload.base_url, encrypted, timestamp()),
                )
            self.load_ai_config()
            return {"provider": payload.provider.strip(), "model": payload.model.strip(), "base_url": payload.base_url, "key_configured": bool(encrypted or os.getenv("PRICESCAN_AI_API_KEY", "")), "api_key": ""}

        @router.get("/super-admin/users")
        def users(_: dict[str, Any] = Depends(self.require_superadmin)) -> list[dict[str, Any]]:
            with self.connect() as db:
                return [self.user_payload(db, row) for row in db.execute("SELECT * FROM app_users ORDER BY created_at").fetchall()]

        @router.post("/super-admin/users")
        def create_user(payload: UserCreate, _: dict[str, Any] = Depends(self.require_superadmin)) -> dict[str, Any]:
            created = timestamp()
            with self.connect() as db:
                try:
                    db.execute(
                        """INSERT INTO app_users (id, username, password_hash, role, can_search, daily_search_limit, active, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)""",
                        (f"user_{secrets.token_hex(6)}", payload.username.lower(), password_hash(payload.password), payload.role, int(payload.can_search), payload.daily_search_limit, created, created),
                    )
                except sqlite3.IntegrityError as error:
                    raise HTTPException(409, "이미 사용 중인 아이디입니다.") from error
                row = db.execute("SELECT * FROM app_users WHERE username = ?", (payload.username.lower(),)).fetchone()
                return self.user_payload(db, row)

        @router.patch("/super-admin/users/{user_id}")
        def update_user(user_id: str, payload: UserUpdate, _: dict[str, Any] = Depends(self.require_superadmin)) -> dict[str, Any]:
            changes = payload.model_dump(exclude_unset=True)
            with self.connect() as db:
                row = db.execute("SELECT * FROM app_users WHERE id = ?", (user_id,)).fetchone()
                if not row:
                    raise HTTPException(404, "사용자를 찾을 수 없습니다.")
                if "password" in changes:
                    changes["password_hash"] = password_hash(changes.pop("password"))
                assignments = [f"{key} = ?" for key in changes]
                values = [int(value) if key in {"can_search", "active"} else value for key, value in changes.items()]
                if assignments:
                    db.execute(f"UPDATE app_users SET {', '.join(assignments)}, updated_at = ? WHERE id = ?", (*values, timestamp(), user_id))
                updated = db.execute("SELECT * FROM app_users WHERE id = ?", (user_id,)).fetchone()
                return self.user_payload(db, updated)

        return router
