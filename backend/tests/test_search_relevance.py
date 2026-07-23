import unittest

from app.main import automatic_exclusion_reasons, build_search_intent


def product(name: str, price: int, category: str = "") -> dict:
    return {
        "name": name,
        "price": price,
        "shipping": 0,
        "total": price,
        "category": category,
    }


class SearchRelevanceTest(unittest.TestCase):
    def test_exact_model_excludes_accessories_and_other_models(self) -> None:
        items = [
            product(
                "삼성 갤럭시북6 울트라 NT960UJH-X72A",
                5_200_000,
                "디지털/가전 > 노트북",
            ),
            product(
                "NT960UJH-X72A 키스킨 보호필름",
                8_000,
                "디지털/가전 > 노트북액세서리",
            ),
            product(
                "삼성 갤럭시북5 NT960XHA-K51A",
                2_000_000,
                "디지털/가전 > 노트북",
            ),
        ]

        reasons = automatic_exclusion_reasons("NT960UJH-X72A", items, [])

        self.assertEqual(reasons[0], "")
        self.assertIn("부가상품", reasons[1])
        self.assertIn("모델 불일치", reasons[2])

    def test_accessory_query_keeps_requested_accessories(self) -> None:
        items = [
            product(
                "아이폰 S25 케이스 투명 커버",
                12_000,
                "휴대폰액세서리 > 케이스",
            ),
            product(
                "아이폰 S24 케이스",
                11_000,
                "휴대폰액세서리 > 케이스",
            ),
        ]

        reasons = automatic_exclusion_reasons("아이폰 S25 케이스", items, [])

        self.assertEqual(reasons[0], "")
        self.assertIn("모델 불일치", reasons[1])

    def test_monitor_category_is_not_treated_as_generic_accessory(self) -> None:
        items = [
            product(
                "LG전자 27UP850 UHD 모니터",
                499_000,
                "디지털/가전 > 컴퓨터주변기기 > 모니터",
            )
        ]

        reasons = automatic_exclusion_reasons("27UP850 모니터", items, [])

        self.assertEqual(reasons, [""])

    def test_short_model_token_is_detected(self) -> None:
        items = [
            product("다이슨 V15 무선청소기", 780_000, "생활/건강 > 청소기"),
            product("다이슨 V12 무선청소기", 620_000, "생활/건강 > 청소기"),
        ]

        intent = build_search_intent("다이슨 V15", items)
        reasons = automatic_exclusion_reasons("다이슨 V15", items, [])

        self.assertEqual(intent["models"], ["v15"])
        self.assertEqual(reasons[0], "")
        self.assertIn("모델 불일치", reasons[1])


if __name__ == "__main__":
    unittest.main()
