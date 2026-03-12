from src.collectors import fund_collector
from src.web.api import stocks


def test_fetch_fund_top_holdings_parse(monkeypatch):
    raw = (
        'var apidata={content:"<table><thead><tr><th>序号</th><th>股票代码</th>'
        '<th>股票名称</th><th>占净值比例</th></tr></thead><tbody>'
        '<tr><td>1</td><td>600519</td><td>贵州茅台</td><td>9.12%</td></tr>'
        '<tr><td>2</td><td>000858</td><td>五粮液</td><td>8.05%</td></tr>'
        '</tbody></table>",arryear:[2025],curyear:2025};'
    )

    class MockResp:
        text = raw

    class MockClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, *args, **kwargs):
            return MockResp()

    monkeypatch.setattr(fund_collector.httpx, "Client", lambda: MockClient())
    monkeypatch.setattr(fund_collector, "_fetch_tencent_quotes", lambda symbols: [
        {"symbol": "600519", "change_pct": 1.23},
        {"symbol": "000858", "change_pct": -0.45},
    ])

    rows = fund_collector.fetch_fund_top_holdings("161725")
    assert len(rows) == 2
    assert rows[0]["code"] == "600519"
    assert rows[0]["weight"] == 9.12
    assert rows[0]["change_pct"] == 1.23


def test_fetch_fund_performance_parse(monkeypatch):
    raw = """
    var Data_ACWorthTrend=[[1700000000000,1.0],[1700100000000,1.1],[1700200000000,1.2]];
    """

    class MockResp:
        text = raw

    class MockClient:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def get(self, *args, **kwargs):
            return MockResp()

    monkeypatch.setattr(fund_collector.httpx, "Client", lambda: MockClient())

    perf = fund_collector.fetch_fund_performance("161725")
    assert len(perf["points"]) == 3
    assert round(perf["since_return_pct"], 2) == 20.0


def test_fund_overview_api(monkeypatch):
    monkeypatch.setattr(stocks, "fetch_fund_top_holdings", lambda code, topline=10: [
        {
            "code": "600519",
            "name": "贵州茅台",
            "weight": 9.12,
            "weight_text": "9.12%",
            "change_pct": 1.23,
        }
    ])
    monkeypatch.setattr(stocks, "fetch_fund_performance", lambda code: {
        "points": [{"ts": 1700000000000, "value": 1.0, "return_pct": 0.0}],
        "since_return_pct": 0.0,
    })

    resp = stocks.get_fund_overview("161725")
    assert resp["fund_code"] == "161725"
    assert len(resp["top_holdings"]) == 1
    assert "performance" in resp
