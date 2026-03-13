"""数据采集器 - 基于腾讯股票 HTTP API（稳定可靠，无 SSL 问题）"""
import logging
import json
import re
from abc import ABC, abstractmethod
from datetime import datetime

import httpx

from src.core.cn_symbol import get_cn_prefix
from src.models.market import MarketCode, StockData, IndexData

logger = logging.getLogger(__name__)

# 腾讯股票行情 API（HTTP，GBK 编码）
TENCENT_QUOTE_URL = "http://qt.gtimg.cn/q="
FUND_GZ_URL = "http://fundgz.1234567.com.cn/js/{code}.js"

# 预定义指数
CN_INDICES = [
    ("000001", "上证指数", "sh"),
    ("399001", "深证成指", "sz"),
    ("399006", "创业板指", "sz"),
]


def _tencent_symbol(symbol: str, market: MarketCode = MarketCode.CN) -> str:
    """转换为腾讯 API 格式: sh600519 / sz000001 / hk00700 / usAAPL / bj430047

    规则：
    - 港股：hk{symbol}
      示例：00700（腾讯控股）、03690（美团-W）
    - 美股：us{symbol}
      示例：AAPL（Apple）、NVDA（NVIDIA）
    - A股：
      - 上交所（含 ETF/LOF/B 股 等）：5/6/900 开头 -> sh{symbol}
        示例：600519（贵州茅台）、510300（沪深300ETF）、900901（B股示例）
      - 深交所（主板/中小板/创业板/B 股/ETF 等）：0/1/2/3 开头 -> sz{symbol}
        示例：000001（平安银行）、300750（宁德时代）
      - 北交所：920 开头 或 83/87/88 开头 -> bj{symbol}
        示例：920001（贝特瑞）、836239（诺思兰德）
      - 其他未知前缀，默认归为深市 sz
    """
    if market == MarketCode.HK:
        # 例如：00700（腾讯控股）→ hk00700，03690（美团-W）→ hk03690
        return f"hk{symbol}"
    if market == MarketCode.US:
        # 例如：AAPL（Apple）→ usAAPL，NVDA（NVIDIA）→ usNVDA
        return f"us{symbol}"
    if market == MarketCode.FUND:
        # 场内基金（ETF/LOF）按 A 股代码规则请求腾讯行情。
        return get_cn_prefix(symbol) + symbol
    # CN 市场代码前缀映射（统一函数）
    return get_cn_prefix(symbol) + symbol


def _parse_tencent_line(line: str) -> dict | None:
    """解析腾讯 API 单行响应"""
    if "=\"\"" in line or not line.strip():
        return None
    try:
        _, value = line.split('="', 1)
        value = value.rstrip('";')
        parts = value.split("~")
        if len(parts) < 35:
            return None

        # 解析成交额: parts[35] 格式为 "price/vol/turnover"
        turnover = 0.0
        if "/" in str(parts[35]):
            turnover_parts = parts[35].split("/")
            if len(turnover_parts) >= 3:
                try:
                    turnover = float(turnover_parts[2])
                except (ValueError, IndexError):
                    pass

        def _to_float(value: str | None) -> float | None:
            if value is None:
                return None
            v = str(value).strip()
            if not v:
                return None
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        # 处理美股 symbol（如 AAPL.OQ -> AAPL）并解析交易所后缀。
        # 注意：指数 symbol 以 . 开头（如 .IXIC, .DJI），需要保留。
        raw_symbol = parts[2]
        symbol = raw_symbol
        exchange = None
        if "." in raw_symbol and not raw_symbol.startswith("."):
            base, suffix = raw_symbol.split(".", 1)
            symbol = base
            sx = suffix.upper()
            if sx in {"OQ", "NQ", "NSDQ", "NASDAQ"}:
                exchange = "NASDAQ"
            elif sx in {"N", "NYSE"}:
                exchange = "NYSE"
            elif sx in {"A", "AMEX"}:
                exchange = "AMEX"

        # A 股按代码前缀细分板块/交易所。
        if exchange is None and symbol.isdigit():
            if symbol.startswith(("300", "301")):
                exchange = "创业板"
            elif symbol.startswith(("688",)):
                exchange = "科创板"
            elif symbol.startswith(("600", "601", "603", "605", "689", "510", "511", "512", "513", "515", "518", "588", "900")):
                exchange = "上交所"
            elif symbol.startswith(("000", "001", "002", "003", "159", "160", "161", "162", "165", "200")):
                exchange = "深交所"
            elif symbol.startswith(("920", "83", "87", "88")):
                exchange = "北交所"

        # 腾讯常见字段：
        # - 38=换手率(%)
        # - 39=市盈率(常见为静态/TTM，视市场而定)
        # - 44=流通市值
        # - 45=总市值
        turnover_rate = None
        pe_ratio = None
        if len(parts) > 39:
            turnover_rate = _to_float(parts[38])
            pe_ratio = _to_float(parts[39])

        circulating_market_value = None
        total_market_value = None
        if len(parts) > 45:
            circulating_market_value = _to_float(parts[44])
            total_market_value = _to_float(parts[45])

        return {
            "name": parts[1],
            "symbol": symbol,
            "exchange": exchange,
            "current_price": float(parts[3] or 0),
            "prev_close": float(parts[4] or 0),
            "open_price": float(parts[5] or 0),
            "volume": float(parts[6] or 0),
            "change_amount": float(parts[31] or 0),
            "change_pct": float(parts[32] or 0),
            "high_price": float(parts[33] or 0),
            "low_price": float(parts[34] or 0),
            "turnover": turnover,
            "turnover_rate": turnover_rate,
            "pe_ratio": pe_ratio,
            "circulating_market_value": circulating_market_value,
            "total_market_value": total_market_value,
        }
    except (ValueError, IndexError) as e:
        logger.debug(f"解析腾讯行情失败: {e}")
        return None


def _fetch_tencent_quotes(symbols: list[str]) -> list[dict]:
    """批量获取腾讯实时行情"""
    if not symbols:
        return []
    url = TENCENT_QUOTE_URL + ",".join(symbols)
    with httpx.Client() as client:
        resp = client.get(url, timeout=10)
        content = resp.content.decode("gbk", errors="ignore")

    results = []
    for line in content.strip().split(";"):
        parsed = _parse_tencent_line(line)
        if parsed and parsed["current_price"] > 0:
            results.append(parsed)
    return results


def _parse_fund_gz_line(raw: str) -> dict | None:
    """解析天天基金估值接口返回: jsonpgz({...});"""
    text = (raw or "").strip()
    if not text:
        return None

    m = re.search(r"jsonpgz\((.*)\)\s*;?\s*$", text)
    if not m:
        return None

    try:
        data = json.loads(m.group(1))
    except Exception:
        return None

    fundcode = str(data.get("fundcode") or "").strip()
    if not fundcode:
        return None

    def _f(v: str | None) -> float | None:
        if v is None:
            return None
        s = str(v).strip()
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None

    prev_close = _f(data.get("dwjz"))
    current_price = _f(data.get("gsz"))
    change_pct = _f(data.get("gszzl"))
    change_amount = None
    if prev_close is not None and current_price is not None:
        change_amount = current_price - prev_close

    return {
        "name": str(data.get("name") or ""),
        "symbol": fundcode,
        "current_price": current_price,
        "prev_close": prev_close,
        "open_price": None,
        "volume": None,
        "change_amount": change_amount,
        "change_pct": change_pct,
        "high_price": None,
        "low_price": None,
        "turnover": None,
        "turnover_rate": None,
        "pe_ratio": None,
        "circulating_market_value": None,
        "total_market_value": None,
        "gztime": str(data.get("gztime") or ""),
        "jzrq": str(data.get("jzrq") or ""),
    }


def _fetch_fund_quotes(symbols: list[str]) -> list[dict]:
    """批量获取基金实时估值（天天基金）。

    对于场外基金（没有实时估值），会回退到基金详情接口获取最新净值。
    """
    if not symbols:
        return []

    results: list[dict] = []
    # 去重后按输入顺序请求
    seen: set[str] = set()
    ordered = []
    for s in symbols:
        code = str(s).strip()
        if not code:
            continue
        if code in seen:
            continue
        seen.add(code)
        ordered.append(code)

    # 延迟导入避免循环引用
    from src.collectors.fund_collector import fetch_fund_performance

    with httpx.Client() as client:
        for code in ordered:
            try:
                resp = client.get(FUND_GZ_URL.format(code=code), timeout=10)
                parsed = _parse_fund_gz_line(resp.text)
                if parsed and parsed.get("current_price") is not None:
                    results.append(parsed)
                    continue
            except Exception as e:
                logger.debug(f"获取基金估值失败 {code}: {e}")

            # 估值接口无数据，尝试从基金详情获取最新净值
            try:
                perf = fetch_fund_performance(code)
                if perf and perf.get("points"):
                    latest = perf["points"][-1]
                    nav = latest.get("value")
                    ts = latest.get("ts")
                    jzrq = ""
                    if ts:
                        from datetime import datetime
                        jzrq = datetime.fromtimestamp(
                            ts / 1000).strftime("%Y-%m-%d")
                    if nav is not None:
                        results.append({
                            "symbol": code,
                            "name": perf.get("name") or code,
                            "current_price": None,  # 无实时估值
                            "prev_close": nav,      # 最新单位净值
                            "change": None,
                            "change_pct": None,
                            "volume": None,
                            "amount": None,
                            "turnover_rate": None,
                            "volume_ratio": None,
                            "total_market_value": None,
                            "gztime": "",
                            "jzrq": jzrq,
                        })
            except Exception as e:
                logger.debug(f"获取基金净值失败 {code}: {e}")

    return results


class BaseCollector(ABC):
    """数据采集器抽象基类"""

    market: MarketCode

    @abstractmethod
    async def get_index_data(self) -> list[IndexData]:
        ...

    @abstractmethod
    async def get_stock_data(self, symbols: list[str]) -> list[StockData]:
        ...


class AkshareCollector(BaseCollector):
    """基于腾讯 HTTP API 的数据采集器"""

    def __init__(self, market: MarketCode):
        self.market = market

    async def get_index_data(self) -> list[IndexData]:
        if self.market == MarketCode.CN:
            return self._get_cn_index()
        return []

    async def get_stock_data(self, symbols: list[str]) -> list[StockData]:
        if self.market == MarketCode.CN:
            return self._get_cn_stocks(symbols)
        elif self.market == MarketCode.HK:
            return self._get_hk_stocks(symbols)
        elif self.market == MarketCode.US:
            return self._get_us_stocks(symbols)
        elif self.market == MarketCode.FUND:
            return self._get_fund_stocks(symbols)
        return []

    def _get_fund_stocks(self, symbols: list[str]) -> list[StockData]:
        try:
            fund_items = _fetch_fund_quotes(symbols)
        except Exception as e:
            logger.error(f"获取基金行情失败: {e}")
            fund_items = []

        result = [
            StockData(
                symbol=item["symbol"],
                name=item["name"],
                market=MarketCode.FUND,
                current_price=item["current_price"] or 0,
                change_pct=item["change_pct"] or 0,
                change_amount=item["change_amount"] or 0,
                volume=item.get("volume") or 0,
                turnover=item.get("amount") or item.get("turnover") or 0,
                open_price=item.get(
                    "open_price") or item["current_price"] or 0,
                high_price=item.get(
                    "high_price") or item["current_price"] or 0,
                low_price=item.get("low_price") or item["current_price"] or 0,
                prev_close=item.get(
                    "prev_close") or item["current_price"] or 0,
                timestamp=datetime.now(),
            )
            for item in fund_items
            if item.get("current_price") is not None
        ]

        found_symbols = {i["symbol"] for i in fund_items if i.get("symbol")}
        missing = [s for s in symbols if s not in found_symbols]
        if missing:
            # 部分场内基金可能在估值接口无数据，回退腾讯行情。
            fallback = self._get_cn_stocks(missing)
            for row in fallback:
                row.market = MarketCode.FUND
            result.extend(fallback)

        return result

    def _get_cn_index(self) -> list[IndexData]:
        tencent_symbols = [
            f"{prefix}{symbol}" for symbol, _, prefix in CN_INDICES]
        try:
            items = _fetch_tencent_quotes(tencent_symbols)
        except Exception as e:
            logger.error(f"获取 A 股指数失败: {e}")
            return []

        return [
            IndexData(
                symbol=item["symbol"],
                name=item["name"],
                market=MarketCode.CN,
                current_price=item["current_price"],
                change_pct=item["change_pct"],
                change_amount=item["change_amount"],
                volume=item["volume"],
                turnover=item["turnover"],
                timestamp=datetime.now(),
            )
            for item in items
        ]

    def _get_cn_stocks(self, symbols: list[str]) -> list[StockData]:
        tencent_symbols = [_tencent_symbol(s, MarketCode.CN) for s in symbols]
        try:
            items = _fetch_tencent_quotes(tencent_symbols)
        except Exception as e:
            logger.error(f"获取 A 股行情失败: {e}")
            return []

        return [
            StockData(
                symbol=item["symbol"],
                name=item["name"],
                market=MarketCode.CN,
                current_price=item["current_price"],
                change_pct=item["change_pct"],
                change_amount=item["change_amount"],
                volume=item["volume"],
                turnover=item["turnover"],
                open_price=item["open_price"],
                high_price=item["high_price"],
                low_price=item["low_price"],
                prev_close=item["prev_close"],
                timestamp=datetime.now(),
            )
            for item in items
        ]

    def _get_hk_stocks(self, symbols: list[str]) -> list[StockData]:
        tencent_symbols = [_tencent_symbol(s, MarketCode.HK) for s in symbols]
        try:
            items = _fetch_tencent_quotes(tencent_symbols)
        except Exception as e:
            logger.error(f"获取港股行情失败: {e}")
            return []

        return [
            StockData(
                symbol=item["symbol"],
                name=item["name"],
                market=MarketCode.HK,
                current_price=item["current_price"],
                change_pct=item["change_pct"],
                change_amount=item["change_amount"],
                volume=item["volume"],
                turnover=item["turnover"],
                open_price=item["open_price"],
                high_price=item["high_price"],
                low_price=item["low_price"],
                prev_close=item["prev_close"],
                timestamp=datetime.now(),
            )
            for item in items
        ]

    def _get_us_stocks(self, symbols: list[str]) -> list[StockData]:
        tencent_symbols = [_tencent_symbol(s, MarketCode.US) for s in symbols]
        try:
            items = _fetch_tencent_quotes(tencent_symbols)
        except Exception as e:
            logger.error(f"获取美股行情失败: {e}")
            return []

        return [
            StockData(
                symbol=item["symbol"],
                name=item["name"],
                market=MarketCode.US,
                current_price=item["current_price"],
                change_pct=item["change_pct"],
                change_amount=item["change_amount"],
                volume=item["volume"],
                turnover=item["turnover"],
                open_price=item["open_price"],
                high_price=item["high_price"],
                low_price=item["low_price"],
                prev_close=item["prev_close"],
                timestamp=datetime.now(),
            )
            for item in items
        ]
