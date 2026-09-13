import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import bcrypt
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.auth_admin import AuthService


class AuthAdminTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "test.db"

        @contextmanager
        def connect():
            db = sqlite3.connect(self.path)
            db.row_factory = sqlite3.Row
            try:
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

        self.connect = connect
        self.service = AuthService(connect, Path(self.directory.name), "legacy-admin")
        self.password_hash = bcrypt.hashpw(b"1212", bcrypt.gensalt()).decode()
        self.environment = patch.dict(os.environ, {"PRICESCAN_SUPERADMIN_PASSWORD_HASH": self.password_hash}, clear=False)
        self.environment.start()
        self.service.initialize()
        app = FastAPI()
        app.include_router(self.service.router())
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.environment.stop()
        self.directory.cleanup()

    def login(self, username="superadmin", password="1212"):
        response = self.client.post("/auth/login", json={"username": username, "password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["token"]

    def test_superadmin_ai_key_is_encrypted_and_never_returned(self):
        token = self.login()
        headers = {"Authorization": f"Bearer {token}"}
        response = self.client.put("/super-admin/ai-config", headers=headers, json={
            "provider": "OpenAI", "model": "gpt-5.6-luna",
            "base_url": "https://api.openai.com/v1", "api_key": "sk-test-secret",
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["api_key"], "")
        self.assertTrue(response.json()["key_configured"])
        with self.connect() as db:
            stored = db.execute("SELECT encrypted_api_key FROM system_ai_config WHERE id='primary'").fetchone()[0]
        self.assertNotIn("sk-test-secret", stored)
        self.assertEqual(os.environ["PRICESCAN_AI_API_KEY"], "sk-test-secret")
        self.assertEqual(self.client.get("/super-admin/ai-config", headers=headers).json()["api_key"], "")

    def test_default_admin_and_new_user_have_ten_searches(self):
        super_token = self.login()
        headers = {"Authorization": f"Bearer {super_token}"}
        admin = self.client.get("/super-admin/users", headers=headers).json()[0]
        self.assertEqual(admin["daily_search_limit"], 10)
        created = self.client.post("/super-admin/users", headers=headers, json={"username": "seller1", "password": "password-123", "role": "user"})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["daily_search_limit"], 10)
        user_token = self.login("seller1", "password-123")
        user = self.service.require_authenticated(f"Bearer {user_token}")
        for _ in range(10):
            self.service.reserve_search(user)
        with self.assertRaisesRegex(Exception, "오늘 검색 한도 10회"):
            self.service.reserve_search(user)

    def test_superadmin_can_change_limit_and_disable_search(self):
        super_token = self.login()
        headers = {"Authorization": f"Bearer {super_token}"}
        user = self.client.post("/super-admin/users", headers=headers, json={"username": "seller2", "password": "password-123", "role": "user"}).json()
        updated = self.client.patch(f"/super-admin/users/{user['id']}", headers=headers, json={"daily_search_limit": 27, "can_search": False})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["daily_search_limit"], 27)
        self.assertFalse(updated.json()["can_search"])
        user_token = self.login("seller2", "password-123")
        resolved = self.service.require_authenticated(f"Bearer {user_token}")
        with self.assertRaisesRegex(Exception, "검색 권한을 중지"):
            self.service.reserve_search(resolved)

    def test_superadmin_login_is_rate_limited(self):
        for _ in range(5):
            self.client.post("/auth/login", json={"username": "superadmin", "password": "wrong"})
        blocked = self.client.post("/auth/login", json={"username": "superadmin", "password": "1212"})
        self.assertEqual(blocked.status_code, 429)

    def test_password_change_revokes_existing_superadmin_sessions(self):
        token = self.login()
        os.environ["PRICESCAN_SUPERADMIN_PASSWORD_HASH"] = bcrypt.hashpw(b"next-password", bcrypt.gensalt()).decode()
        self.service.initialize()
        response = self.client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
