import tempfile
import unittest
import json
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from app import main


class ExtensionCollectionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(main, "DATABASE_PATH", Path(self.directory.name) / "test.sqlite")
        self.db_patch.start()
        main.init_db()
        self.quota_patch = patch.object(main, "reserve_collection_request")
        self.quota_patch.start()

    def tearDown(self):
        self.quota_patch.stop()
        self.db_patch.stop()
        self.directory.cleanup()

    def payload(self, source, price, merge_run_id="", query="노트북 MODEL-1"):
        return main.ExtensionPriceResultsPayload(
            query=query,
            sort_mode="lowest",
            merge_run_id=merge_run_id,
            page_urls={source: f"https://{source}.com/search"},
            items=[{
                "source": source,
                "mall": source,
                "name": query,
                "price": price,
                "shipping": 0,
                "total": price,
                "url": f"https://{source}.com/product/1",
            }],
        )

    def test_current_page_result_merges_into_existing_run(self):
        first = main.save_extension_price_results(self.payload("danawa", 910000))
        merged = main.save_extension_price_results(self.payload("naver", 900000, first["run"]["id"]))

        self.assertEqual(first["run"]["id"], merged["run"]["id"])
        self.assertEqual({item["source"] for item in merged["items"]}, {"danawa", "naver"})
        self.assertEqual(merged["run"]["sources"], ["danawa", "naver"])
        self.assertEqual(sum(item["is_baseline"] for item in merged["items"]), 1)

    def test_reimport_replaces_only_same_source_rows(self):
        first = main.save_extension_price_results(self.payload("danawa", 910000))
        main.save_extension_price_results(self.payload("naver", 900000, first["run"]["id"]))
        merged = main.save_extension_price_results(self.payload("naver", 880000, first["run"]["id"]))

        self.assertEqual(len(merged["items"]), 2)
        self.assertEqual(next(item["price"] for item in merged["items"] if item["source"] == "naver"), 880000)

    def test_different_query_cannot_be_merged(self):
        first = main.save_extension_price_results(self.payload("danawa", 910000))
        with self.assertRaises(HTTPException) as caught:
            main.save_extension_price_results(self.payload("naver", 900000, first["run"]["id"], "다른 상품"))
        self.assertEqual(caught.exception.status_code, 422)

    def test_final_approval_is_idempotent_and_keeps_all_four_sources(self):
        payload = self.payload("naver", 900000)
        payload.capture_id = "df561a3a-f736-415d-9e5f-4890d1da7302"
        payload.approval_scope = "user_per_step"
        payload.warnings = ["화면에서 확인한 후보입니다."]
        for source in ("danawa", "enuri", "coupang"):
            payload.items.extend(self.payload(source, 910000).items)
        first = main.save_extension_price_results(payload)
        second = main.save_extension_price_results(payload)
        self.assertEqual(first["run"]["id"], second["run"]["id"])
        self.assertEqual(len(second["items"]), 4)
        self.assertEqual(second["warnings"], payload.warnings)
        self.assertEqual(main.reserve_collection_request.call_count, 4)
        payload.items[0].price = 800000
        with self.assertRaises(HTTPException) as caught:
            main.save_extension_price_results(payload)
        self.assertEqual(caught.exception.status_code, 409)

    def test_supervised_capture_merges_once_into_existing_ai_run(self):
        first = main.save_extension_price_results(self.payload("danawa", 910000))
        payload = self.payload("naver", 900000, first["run"]["id"])
        payload.capture_id = "df561a3a-f736-415d-9e5f-4890d1da7302"
        payload.approval_scope = "server_managed_ai"
        payload.warnings = ["사용자가 로그인된 화면을 확인했습니다."]

        merged = main.save_extension_price_results(payload)
        repeated = main.save_extension_price_results(payload)

        self.assertEqual(merged["run"]["id"], first["run"]["id"])
        self.assertEqual(merged["run"]["collection_mode"], "hybrid_ai_supervised")
        self.assertEqual(merged["source_status"]["naver"]["status"], "completed")
        self.assertEqual(merged["source_status"]["naver"]["count"], 1)
        self.assertEqual({item["source"] for item in repeated["items"]}, {"danawa", "naver"})
        self.assertEqual(len(repeated["items"]), 2)

    def test_four_independent_browser_saves_complete_one_shared_run(self):
        sources = ["naver", "danawa", "enuri", "coupang"]
        run_id = "ai_four_sources"
        metadata = {
            "sources": sources,
            "collection_mode": "server_managed_browser_agent",
            "source_status": {source: {"status": "awaiting_supervision", "count": 0} for source in sources},
            "warnings": [],
        }
        with main.connect() as db:
            db.execute(
                "INSERT INTO search_runs (id, query, sort_mode, status, filters_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (run_id, "노트북 MODEL-1", "lowest", "collecting", json.dumps(metadata), main.now()),
            )

        merged = None
        capture_ids = [
            "00000000-0000-5000-8000-000000000001",
            "00000000-0000-5000-8000-000000000002",
            "00000000-0000-5000-8000-000000000003",
            "00000000-0000-5000-8000-000000000004",
        ]
        for index, source in enumerate(sources):
            payload = self.payload(source, 900000 + index * 10000, run_id)
            payload.capture_id = capture_ids[index]
            payload.approval_scope = "server_managed_ai"
            merged = main.save_extension_price_results(payload)
            expected_status = "completed" if index == len(sources) - 1 else "collecting"
            self.assertEqual(merged["run"]["status"], expected_status)

        self.assertEqual({item["source"] for item in merged["items"]}, set(sources))
        self.assertTrue(all(merged["source_status"][source]["status"] == "completed" for source in sources))


if __name__ == "__main__":
    unittest.main()
