import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.collection_agent import PageObservation, interpret_page  # noqa: E402


class AiObservationEvidenceRegressionTest(unittest.IsolatedAsyncioTestCase):
    # Regression: production QA — model price existed in link context but was rejected as not visible.
    # Found by /qa on 2026-09-15
    async def test_link_context_price_is_valid_visible_evidence(self):
        payload = PageObservation(
            source="danawa",
            query="삼성 SSD 990 PRO 2TB",
            stage="results",
            page_url="https://search.danawa.com/dsearch.php?query=ssd",
            page_title="다나와 검색",
            visible_text="",
            links=[{"text": "삼성전자 990 PRO", "url": "https://prod.danawa.com/info/?pcode=1"}],
            link_contexts=[{"url": "https://prod.danawa.com/info/?pcode=1", "context": "삼성전자 990 PRO 2TB 635,990원 무료배송"}],
        )
        response = {"needs_user": False, "reason": "", "items": [{
            "name": "삼성전자 990 PRO 2TB", "mall": "다나와", "price": 635990,
            "shipping": 0, "url": "https://prod.danawa.com/info/?pcode=1", "evidence": "635,990원 무료배송",
        }]}
        with patch("app.collection_agent.call_model_json", new=AsyncMock(return_value=response)):
            result = await interpret_page(payload)
        self.assertEqual(result["items"][0]["price"], 635990)
        self.assertEqual(result["items"][0]["shipping"], 0)


if __name__ == "__main__":
    unittest.main()
