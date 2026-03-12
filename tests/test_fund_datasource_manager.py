import unittest

from src.core.data_collector import DataCollectorManager


class DummySource:
    def __init__(self):
        self.type = "quote"
        self.provider = "eastmoney_fund"
        self.test_symbols = ["001186", "161725"]
        self.name = "天天基金"
        self.config = {}


class TestFundDatasourceManager(unittest.IsolatedAsyncioTestCase):
    async def test_quote_fund_provider_test_source(self):
        manager = DataCollectorManager()

        source = DummySource()

        import src.collectors.akshare_collector as akc

        old_fetch = akc._fetch_fund_quotes
        try:
            akc._fetch_fund_quotes = lambda symbols: [
                {
                    "symbol": "001186",
                    "name": "富国文体健康股票A",
                    "current_price": 3.0451,
                    "change_pct": 0.13,
                }
            ]
            result = await manager.test_source(source)
            self.assertTrue(result.success)
            self.assertGreaterEqual(result.count, 1)
            self.assertEqual(result.data[0]["symbol"], "001186")
        finally:
            akc._fetch_fund_quotes = old_fetch


if __name__ == "__main__":
    unittest.main()
