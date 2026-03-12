import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.collectors.akshare_collector import _parse_fund_gz_line
from src.web.api import quotes


class TestFundSupport(unittest.TestCase):
    def test_parse_fund_gz_line(self):
        raw = (
            'jsonpgz({"fundcode":"001186","name":"富国文体健康股票A",'
            '"jzrq":"2026-03-10","dwjz":"3.0410","gsz":"3.0451",'
            '"gszzl":"0.13","gztime":"2026-03-11 15:00"});'
        )
        parsed = _parse_fund_gz_line(raw)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["symbol"], "001186")
        self.assertEqual(parsed["name"], "富国文体健康股票A")
        self.assertAlmostEqual(parsed["current_price"], 3.0451)
        self.assertAlmostEqual(parsed["prev_close"], 3.0410)
        self.assertAlmostEqual(parsed["change_pct"], 0.13)

    def test_quotes_batch_supports_fund_market(self):
        app = FastAPI()
        app.include_router(quotes.router, prefix="/api/quotes")
        client = TestClient(app)

        old_fetch = quotes._fetch_fund_quotes
        try:
            quotes._fetch_fund_quotes = lambda symbols: [
                {
                    "symbol": "001186",
                    "name": "富国文体健康股票A",
                    "current_price": 3.0451,
                    "change_pct": 0.13,
                    "change_amount": 0.0041,
                    "prev_close": 3.0410,
                }
            ]
            resp = client.post(
                "/api/quotes/batch",
                json={
                    "items": [
                        {
                            "symbol": "001186",
                            "market": "FUND",
                        }
                    ]
                },
            )
            self.assertEqual(resp.status_code, 200)
            rows = resp.json()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["market"], "FUND")
            self.assertEqual(rows[0]["symbol"], "001186")
            self.assertAlmostEqual(rows[0]["current_price"], 3.0451)
        finally:
            quotes._fetch_fund_quotes = old_fetch


if __name__ == "__main__":
    unittest.main()
