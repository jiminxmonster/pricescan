import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from app import main


class DesktopCollectionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(main, "DATABASE_PATH", Path(self.directory.name) / "test.sqlite")
        self.db_patch.start()
        main.init_db()
        self.quota = patch.object(main, "reserve_collection_request")
        self.reserve = self.quota.start()

    def tearDown(self):
        self.quota.stop()
        self.db_patch.stop()
        self.directory.cleanup()

    def payload(self, source="naver", price=900000, **extra):
        return main.DesktopPriceResultsPayload(collection_id="12345678-1234-1234-1234-123456789abc", query="노트북 MODEL-1", sort_mode="lowest",
            items=[{"source": source, "mall": source, "name": "노트북 MODEL-1", "price": price, "shipping": 0, "url": f"https://{source}.com/product/1"}], **extra)

    def test_independent_source_results_merge_without_replacing_previous_items(self):
        first = main.save_desktop_price_results(self.payload())
        second = main.save_desktop_price_results(self.payload("danawa", 880000))
        self.assertEqual(first["run"]["id"], second["run"]["id"])
        self.assertEqual({item["source"] for item in second["items"]}, {"naver", "danawa"})
        self.assertEqual(next(item for item in second["items"] if item["source"] == "naver")["id"], first["items"][0]["id"])
        self.assertEqual(sum(item["is_baseline"] for item in second["items"]), 1)

    def test_retry_is_idempotent_including_quota_and_price_history_identity(self):
        first = main.save_desktop_price_results(self.payload(warnings=["원본 검토 필요"]))
        second = main.save_desktop_price_results(self.payload())
        self.assertEqual(first["items"], second["items"])
        self.assertEqual(second["warnings"], ["원본 검토 필요"])
        self.assertEqual(self.reserve.call_count, 1)

    def test_cannot_mix_queries_in_same_job(self):
        main.save_desktop_price_results(self.payload())
        wrong = self.payload("danawa").model_copy(update={"query": "다른 상품"})
        with self.assertRaises(HTTPException) as caught:
            main.save_desktop_price_results(wrong)
        self.assertEqual(caught.exception.status_code, 409)

    def test_empty_result_is_not_reported_as_completed(self):
        with self.assertRaises(HTTPException) as caught:
            main.save_desktop_price_results(self.payload().model_copy(update={"items": []}))
        self.assertEqual(caught.exception.status_code, 422)
        self.reserve.assert_not_called()

    def test_route_requires_pricescan_authentication(self):
        with TestClient(main.app) as client:
            response = client.post("/price-search/desktop-results", json=self.payload().model_dump())
        self.assertEqual(response.status_code, 401)

    def test_partial_run_can_be_linked_then_extended_without_losing_watched_items(self):
        with TestClient(main.app, headers={"Authorization": f"Bearer {main.ADMIN_TOKEN}"}) as client:
            product = client.post("/seller-products", json={"title": "노트북 MODEL-1"}).json()
            first = client.post("/price-search/desktop-results", json=self.payload().model_dump()).json()
            path = f"/seller-products/{product['id']}"
            self.assertEqual(client.post(path + "/search-results", json={"run_id": first["run"]["id"]}).status_code, 200)
            self.assertEqual(client.post(path + "/monitoring", json={"item_id": first["items"][0]["id"], "enabled": True}).status_code, 200)
            second = client.post("/price-search/desktop-results", json=self.payload("danawa").model_dump()).json()
            linked = client.post(path + "/search-results", json={"run_id": second["run"]["id"]}).json()
            self.assertEqual(len(linked["search"]["items"]), 2)
            self.assertEqual(len(linked["monitored"]), 1)


if __name__ == "__main__":
    unittest.main()
