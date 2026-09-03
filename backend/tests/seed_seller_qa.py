"""Seed synthetic UI fixtures ONLY in the disposable, explicitly opted-in QA server.

Run inside pricescan-seller-qa-backend with PRICESCAN_QA_FIXTURE=1.
Never run this against a user's database. No marketplace or AI requests are made.
"""
import os

import httpx


def main():
    if os.getenv("PRICESCAN_QA_FIXTURE") != "1" or os.getenv("DATABASE_PATH") != "/tmp/pricescan-seller-qa/pricescan.db":
        raise RuntimeError("Only the isolated, disposable QA database is allowed")
    title = "QA 샘플 노트북 MODEL-1"
    with httpx.Client(base_url="http://127.0.0.1:8000", headers={"Authorization": "Bearer pricescan-admin-token"}) as client:
        def post(path, body):
            response = client.post(path, json=body)
            response.raise_for_status()
            return response.json()

        product = post("/seller-products", {"title": title})
        for iteration in range(2):
            items = [{"source": source, "mall": f"QA 판매자 {index+1:02d}", "name": f"{title} · 16GB / 512GB · 판매자 {index+1:02d}",
                      "price": 880000 + index * 5500 + source_index * 1000 - iteration * 10000,
                      "shipping": 0 if index % 2 else 3000, "url": f"https://example.com/qa/{source}/{index}"}
                     for source_index, (source, count) in enumerate((("naver", 12), ("danawa", 11), ("enuri", 3))) for index in range(count)]
            items.append({"source": "naver", "mall": "QA 액세서리", "name": "MODEL-1 키보드 보호필름", "price": 1500, "url": "https://example.com/qa/accessory"})
            run = post("/price-search/extension-results", {"query": title, "items": items, "warnings": ["QA 샘플: 실제 시장 가격이 아닙니다. 쿠팡 결과 없음 상태를 검증합니다."]})
            post(f"/seller-products/{product['id']}/search-results", {"run_id": run["run"]["id"], "warnings": run["warnings"]})
            if iteration == 0:
                for item in [item for item in run["items"] if not item["is_excluded"]][:8]:
                    post(f"/seller-products/{product['id']}/monitoring", {"item_id": item["id"], "enabled": True})
        print("Isolated synthetic seller UI fixture ready; financial fields remain blank.")


if __name__ == "__main__":
    main()
