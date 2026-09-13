import tempfile
import unittest
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


if __name__ == "__main__":
    unittest.main()
