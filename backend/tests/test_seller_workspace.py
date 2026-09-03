import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

from app.seller_workspace import create_seller_router, init_seller_workspace, offer_key


class SellerWorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = f"{self.directory.name}/test.db"

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
        with connect() as db:
            init_seller_workspace(db)
            db.executescript("CREATE TABLE search_runs (id TEXT PRIMARY KEY, payload TEXT); CREATE TABLE price_items (id TEXT PRIMARY KEY, run_id TEXT);")

        def get_payload(db, run_id):
            row = db.execute("SELECT payload FROM search_runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Search run not found")
            return json.loads(row[0])

        def auth(authorization: str = Header(default="")):
            if authorization != "Bearer test-token":
                raise HTTPException(401, "Unauthorized")

        app = FastAPI()
        app.include_router(create_seller_router(connect, auth, get_payload))
        self.client = TestClient(app, headers={"Authorization": "Bearer test-token"})
        self.root = "/seller-products"

    def tearDown(self):
        self.client.close()
        self.directory.cleanup()

    def draft(self, title="노트북 MODEL-1"):
        response = self.client.post(self.root, json={"title": title})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def seed_run(self, run_id="run-1", query="노트북 MODEL-1", price=880000, url="https://example.com/products/1", status="completed"):
        item = {"id": f"item-{run_id}", "source": "naver", "mall": "경쟁판매자", "name": query,
                "url": url, "price": price, "shipping": 3000, "total": price + 3000, "collected_at": f"2026-08-31T0{len(run_id)}:00:00+00:00"}
        payload = {"run": {"id": run_id, "query": query, "status": status, "created_at": item["collected_at"]}, "items": [item]}
        with self.connect() as db:
            db.execute("INSERT INTO search_runs VALUES (?,?)", (run_id, json.dumps(payload)))
            db.execute("INSERT INTO price_items VALUES (?,?)", (item["id"], run_id))
        return item

    def link(self, product, run="run-1", **extra):
        return self.client.post(f"{self.root}/{product['id']}/search-results", json={"run_id": run, **extra})

    def toggle(self, product, item, enabled=True):
        return self.client.post(f"{self.root}/{product['id']}/monitoring", json={"item_id": item["id"], "enabled": enabled})

    def test_draft_is_null_and_repeated_normalized_search_preserves_finance(self):
        product = self.draft()
        self.assertFalse(product["financials"]["ready"])
        self.assertIsNone(product["cost_price"])
        self.assertEqual(product["monitored"], [])
        response = self.client.patch(f"{self.root}/{product['id']}/finance", json={"cost_price": 750000})
        self.assertEqual(response.status_code, 200)
        repeated = self.draft("  노트북  model-1  ")
        self.assertEqual(product["id"], repeated["id"])
        self.assertEqual(repeated["cost_price"], 750000)
        self.assertEqual(len(self.client.get(self.root).json()), 1)

    def test_margin_and_null_vs_zero(self):
        product = self.draft()
        path = f"{self.root}/{product['id']}/finance"
        ready = self.client.patch(path, json={"sale_price": 900000, "cost_price": 750000, "fee_rate": 8, "shipping_cost": 3000}).json()
        self.assertEqual(ready["financials"]["profit"], 75000)
        zero = self.client.patch(path, json={"fee_rate": 0, "shipping_cost": 0}).json()
        self.assertEqual(zero["financials"]["profit"], 150000)
        missing = self.client.patch(path, json={"cost_price": None}).json()
        self.assertFalse(missing["financials"]["ready"])
        self.assertIsNone(missing["financials"]["profit"])
        self.assertEqual(missing["sale_price"], 900000)

    def test_rounding_and_invalid_financial_fields(self):
        product = self.draft()
        path = f"{self.root}/{product['id']}/finance"
        response = self.client.patch(path, json={"sale_price": 101, "cost_price": 0, "fee_rate": 50, "shipping_cost": 0})
        self.assertEqual(response.json()["financials"]["fee"], 51)
        for body in ({"sale_price": 0}, {"cost_price": -1}, {"cost_price": 0.5}, {"shipping_cost": 10**11}, {"fee_rate": 100}, {"fee_rate": "NaN"}):
            self.assertEqual(self.client.patch(path, json=body).status_code, 422)

    def test_monitoring_persists_by_url_with_history_after_research(self):
        product = self.draft()
        first = self.seed_run()
        self.assertEqual(self.link(product).status_code, 200)
        self.assertEqual(self.toggle(product, first).json()["monitored_count"], 1)
        second = self.seed_run("run-22", price=850000)
        updated = self.link(product, "run-22").json()
        self.assertEqual(updated["monitored_count"], 1)
        self.assertEqual(updated["monitored"][0]["id"], second["id"])
        self.assertEqual(updated["monitored"][0]["price"], 850000)
        self.assertEqual(len(updated["monitored"][0]["history"]), 2)
        self.assertTrue(updated["monitored"][0]["seen_in_latest"])
        self.assertEqual(self.toggle(product, second).json()["monitored_count"], 1)
        self.assertIsNone(updated["sale_price"])
        self.assertIsNone(updated["cost_price"])

    def test_new_entrant_not_automatically_checked_and_old_price_marked_stale(self):
        product = self.draft()
        first = self.seed_run()
        self.link(product)
        self.toggle(product, first)
        self.seed_run("run-new", price=800000, url="https://example.com/new-seller")
        result = self.link(product, "run-new").json()
        self.assertEqual(result["monitored_count"], 1)
        self.assertFalse(result["monitored"][0]["seen_in_latest"])
        self.assertEqual(result["search"]["items"][0]["price"], 800000)

    def test_uncheck_preserves_history_and_research_does_not_reenable(self):
        product = self.draft()
        item = self.seed_run()
        self.link(product)
        self.toggle(product, item)
        self.assertEqual(self.toggle(product, item, False).json()["monitored_count"], 0)
        item2 = self.seed_run("run-2")
        self.assertEqual(self.link(product, "run-2").json()["monitored_count"], 0)
        again = self.toggle(product, item2).json()
        self.assertEqual(len(again["monitored"][0]["history"]), 2)

    def test_rejects_wrong_product_and_incomplete_search(self):
        product = self.draft()
        item = self.seed_run(query="다른 노트북")
        self.assertEqual(self.link(product).status_code, 409)
        self.assertEqual(self.toggle(product, item).status_code, 409)
        self.seed_run("run-failed", status="failed")
        self.assertEqual(self.link(product, "run-failed").status_code, 409)
        self.assertEqual(self.link(product, "absent").status_code, 404)

    def test_invalid_links_and_zero_price_are_not_actionable(self):
        product = self.draft()
        item = self.seed_run(url="javascript:alert(1)")
        self.assertEqual(self.link(product).status_code, 200) # remains reviewable
        self.assertEqual(self.toggle(product, item).status_code, 422)
        zero = self.seed_run("run-zero", price=0)
        self.assertEqual(self.toggle(product, zero).status_code, 422)

    def test_warnings_persist_after_reload(self):
        product = self.draft()
        self.seed_run()
        self.link(product, warnings=["네이버 사용자 확인 필요"])
        loaded = self.client.get(f"{self.root}/{product['id']}").json()
        self.assertEqual(loaded["search"]["warnings"], ["네이버 사용자 확인 필요"])

    def test_urls_strip_only_fragments_and_keep_option_ids(self):
        self.assertEqual(offer_key("naver", "https://EXAMPLE.com/p?id=1#x"), offer_key("naver", "https://example.com/p?id=1"))
        self.assertNotEqual(offer_key("naver", "https://example.com/p?id=1"), offer_key("naver", "https://example.com/p?id=2"))

    def test_auth_and_blank_title(self):
        self.assertEqual(self.client.get(self.root, headers={"Authorization": ""}).status_code, 401)
        self.assertEqual(self.client.post(self.root, json={"title": "  "}).status_code, 422)

    def test_ai_disabled_and_consent_required(self):
        product = self.draft()
        question = {"messages": [{"role": "user", "content": "얼마가 남나요?"}]}
        with patch.dict(os.environ, {"PRICESCAN_AI_API_KEY": "", "PRICESCAN_AI_MODEL": ""}):
            self.assertFalse(self.client.get(f"{self.root}/assistant/status").json()["configured"])
            self.assertEqual(self.client.post(f"{self.root}/{product['id']}/assistant", json=question).status_code, 422)
            self.assertEqual(self.client.post(f"{self.root}/{product['id']}/assistant", json={**question, "consent": True}).status_code, 503)

    def test_ai_sends_only_selected_product_data_and_no_real_request(self):
        product = self.draft()
        self.draft("다른비밀상품")
        item = self.seed_run()
        self.link(product)
        self.toggle(product, item)
        with patch.dict(os.environ, {"PRICESCAN_AI_API_KEY": "test-secret", "PRICESCAN_AI_MODEL": "test-model"}), patch("app.seller_workspace.httpx.AsyncClient") as client_class:
            remote = AsyncMock()
            client_class.return_value.__aenter__.return_value = remote
            response = unittest.mock.Mock(status_code=200)
            response.json.return_value = {"choices": [{"message": {"content": "원가를 입력해 주세요."}}]}
            remote.post.return_value = response
            result = self.client.post(f"{self.root}/{product['id']}/assistant", json={"consent": True, "messages": [{"role": "user", "content": "마진 알려줘"}]})
            self.assertEqual(result.status_code, 200, result.text)
            content = json.dumps(remote.post.call_args.kwargs["json"], ensure_ascii=False)
            self.assertIn("노트북 MODEL-1", content)
            self.assertIn("경쟁판매자", content)
            self.assertNotIn("다른비밀상품", content)
            self.assertNotIn("test-secret", content)
            self.assertEqual(remote.post.call_args.args[0], "https://api.deepseek.com/chat/completions")


if __name__ == "__main__":
    unittest.main()
