#!/usr/bin/env python3
"""Test all MCP tools"""
import requests
import json

BASE = "http://127.0.0.1:8000"
AUTH = ("admin", "admin123")

def call_tool(name, args=None):
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args or {}}}
    r = requests.post(f"{BASE}/api/mcp", json=payload, auth=AUTH, timeout=30)
    return r.json()

def test(name, args=None, show_result=True):
    res = call_tool(name, args)
    if "error" in res:
        print(f"❌ {name}: {res['error']}")
        return False
    else:
        content = res.get("result", {}).get("content", [{}])[0].get("text", "")
        try:
            data = json.loads(content)
            if show_result:
                print(f"✅ {name}: {json.dumps(data, ensure_ascii=False)[:180]}")
            else:
                print(f"✅ {name}: OK")
        except:
            print(f"✅ {name}: {content[:180]}")
        return True

print("=== 基础工具 ===")
test("mcp.health")
test("mcp.auth.status")
test("mcp.version")

print("\n=== 自选股工具 ===")
test("stocks.list")
test("stocks.quotes", show_result=False)
test("stocks.search", {"query": "腾讯"})

print("\n=== 持仓工具 ===")
test("positions.list")
test("portfolio.summary", {"include_quotes": False})

print("\n=== 市场工具 ===")
test("market.indices")
test("dashboard.overview", {"market": "ALL", "action_limit": 3, "risk_limit": 3, "days": 30}, show_result=False)

print("\n=== 账户工具 ===")
test("accounts.list")

print("\n=== 新闻工具 ===")
test("news.list", {"limit": 3})

print("\n=== K线工具 ===")
test("klines.get", {"symbol": "000001", "market": "CN", "period": "daily", "limit": 5})
test("klines.summary", {"symbol": "000001", "market": "CN", "period": "daily", "limit": 20})

print("\n=== 历史分析工具 ===")
test("history.list", {"limit": 3})

print("\n=== 推荐池工具 ===")
test("suggestions.latest", {"limit": 3})

print("\n=== Agent工具 ===")
test("agents.list")
test("agents.health")

print("\n=== 价格提醒工具 ===")
test("price_alerts.list")
test("price_alerts.scan")

print("\n=== 基金工具 ===")
test("funds.overview", {"fund_code": "008163"})
test("funds.holdings", {"fund_code": "008163"})

print("\n=== 工具函数 ===")
test("exchange_rates.get")
test("quotes.get", {"symbol": "000001", "market": "CN"})
test("quotes.batch", {"items": [{"symbol": "000001", "market": "CN"}, {"symbol": "399001", "market": "CN"}]})

print("\n=== 测试完成 ===")
