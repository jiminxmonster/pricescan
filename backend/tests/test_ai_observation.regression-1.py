import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.collection_agent import PageObservation, interpret_page  # noqa: E402


class AiObservationRegressionTest(unittest.IsolatedAsyncioTestCase):
    # Regression: ISSUE-001 — valid visible marketplace links and prices were discarded after AI extraction
    # Found by /qa on 2026-09-15
    # Report: .gstack/qa-reports/qa-report-pricescan-d2blue-com-2026-09-15.md
    async def test_subdomain_link_and_unknown_shipping_are_kept(self):
        model_result = {
            "needs_user": False,
            "reason": "",
            "items": [{
                "name": "삼성전자 990 PRO 1TB",
                "mall": "쿠팡",
                "price": 389000,
                "shipping": 0,
                "url": "https://link.coupang.com/a/visible-product",
                "evidence": "삼성전자 990 PRO 1TB 389,000원",
            }],
        }
        payload = PageObservation(
            source="coupang",
            query="삼성 SSD 990 PRO 1TB",
            stage="results",
            page_url="https://www.coupang.com/np/search?q=ssd",
            visible_text="삼성전자 990 PRO 1TB 389,000원",
            links=[{"text": "삼성전자 990 PRO 1TB", "url": "https://link.coupang.com/a/visible-product"}],
            link_contexts=[{"url": "https://link.coupang.com/a/visible-product", "context": "삼성전자 990 PRO 1TB 389,000원"}],
        )

        with patch.dict(os.environ, {"PRICESCAN_AI_API_KEY": "test", "PRICESCAN_AI_MODEL": "test"}), \
                patch("app.collection_agent.call_model_json", new=AsyncMock(return_value=model_result)):
            result = await interpret_page(payload)

        self.assertFalse(result["needs_user"])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["price"], 389000)
        self.assertIsNone(result["items"][0]["shipping"])


if __name__ == "__main__":
    unittest.main()
