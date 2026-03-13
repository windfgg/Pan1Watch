from fastapi import APIRouter, HTTPException
from datetime import datetime
import threading
import time
from copy import deepcopy

from pydantic import BaseModel, Field

from src.collectors.kline_collector import KlineCollector
from src.models.market import MarketCode

router = APIRouter()


_KLINE_SUMMARY_CACHE_TTL_SECONDS = 60
_KLINE_SUMMARY_CACHE: dict[str, tuple[float, dict]] = {}
_KLINE_SUMMARY_LOCKS: dict[str, threading.Lock] = {}
_KLINE_SUMMARY_GUARD = threading.Lock()


# 分钟级K线周期
_INTRADAY_INTERVALS = {"1min", "5min", "15min", "30min", "60min"}


class KlineItem(BaseModel):
    symbol: str = Field(..., description="股票代码")
    market: str = Field(..., description="市场: CN/HK/US")
    days: int | None = Field(default=60, description="K线天数(日K)/条数(分钟K)")
    interval: str | None = Field(default="1d", description="周期: 1d/1w/1m/1min/5min/15min/30min/60min")


class KlineBatchRequest(BaseModel):
    items: list[KlineItem]


class KlineSummaryItem(BaseModel):
    symbol: str = Field(..., description="股票代码")
    market: str = Field(..., description="市场: CN/HK/US")


class KlineSummaryBatchRequest(BaseModel):
    items: list[KlineSummaryItem]


def _parse_market(market: str) -> MarketCode:
    try:
        return MarketCode(market)
    except ValueError:
        raise HTTPException(400, f"不支持的市场: {market}")


def _summary_cache_key(symbol: str, market: MarketCode) -> str:
    return f"{market.value}:{(symbol or '').strip().upper()}"


def _get_summary_lock(key: str) -> threading.Lock:
    with _KLINE_SUMMARY_GUARD:
        lock = _KLINE_SUMMARY_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _KLINE_SUMMARY_LOCKS[key] = lock
        return lock


def _get_cached_summary(key: str) -> dict | None:
    now = time.time()
    with _KLINE_SUMMARY_GUARD:
        cached = _KLINE_SUMMARY_CACHE.get(key)
        if not cached:
            return None
        ts, payload = cached
        if (now - ts) > _KLINE_SUMMARY_CACHE_TTL_SECONDS:
            _KLINE_SUMMARY_CACHE.pop(key, None)
            return None
        return deepcopy(payload)


def _set_cached_summary(key: str, payload: dict) -> None:
    with _KLINE_SUMMARY_GUARD:
        _KLINE_SUMMARY_CACHE[key] = (time.time(), deepcopy(payload))


def _get_kline_summary_cached(symbol: str, market_code: MarketCode) -> dict:
    key = _summary_cache_key(symbol, market_code)
    cached = _get_cached_summary(key)
    if cached is not None:
        return cached

    # 同一个 symbol+market 只允许一个线程回源计算，避免并发放大外部请求
    lock = _get_summary_lock(key)
    with lock:
        cached = _get_cached_summary(key)
        if cached is not None:
            return cached

        collector = KlineCollector(market_code)
        summary = collector.get_kline_summary(symbol)
        payload = {
            "symbol": symbol,
            "market": market_code.value,
            "summary": summary,
        }
        _set_cached_summary(key, payload)
        return payload


def _serialize_klines(klines) -> list[dict]:
    return [
        {
            "date": k.date,
            "open": k.open,
            "close": k.close,
            "high": k.high,
            "low": k.low,
            "volume": k.volume,
        }
        for k in klines
    ]


def _aggregate_klines(klines, interval: str) -> list:
    """Aggregate daily klines to week/month."""

    iv = (interval or "1d").lower()
    if iv in ("1d", "day", "d"):
        return klines
    if iv not in ("1w", "1m", "week", "month", "w", "m"):
        return klines

    parsed = []
    for k in klines or []:
        try:
            dt = datetime.strptime(k.date, "%Y-%m-%d")
        except Exception:
            continue
        parsed.append((dt, k))

    parsed.sort(key=lambda x: x[0])
    buckets: dict[str, list] = {}
    for dt, k in parsed:
        if iv in ("1w", "week", "w"):
            y, w, _ = dt.isocalendar()
            key = f"{y:04d}-W{w:02d}"
        else:
            key = f"{dt.year:04d}-{dt.month:02d}"
        buckets.setdefault(key, []).append((dt, k))

    out = []
    for _, items in buckets.items():
        items.sort(key=lambda x: x[0])
        first = items[0][1]
        last = items[-1][1]
        high = max(it[1].high for it in items)
        low = min(it[1].low for it in items)
        vol = sum(it[1].volume for it in items)
        out.append(
            type(first)(
                date=items[-1][0].strftime("%Y-%m-%d"),
                open=first.open,
                close=last.close,
                high=high,
                low=low,
                volume=vol,
            )
        )
    out.sort(key=lambda k: k.date)
    return out


@router.get("/{symbol}")
def get_klines(symbol: str, market: str = "CN", days: int = 60, interval: str = "1d"):
    """获取单只股票K线数据
    
    interval 支持:
    - 日/周/月级: 1d, 1w, 1m
    - 分钟级: 1min, 5min, 15min, 30min, 60min
    """
    market_code = _parse_market(market)
    collector = KlineCollector(market_code)
    
    iv = (interval or "1d").lower()
    if iv in _INTRADAY_INTERVALS:
        # 分钟级K线
        klines = collector.get_intraday_klines(symbol, interval=iv, limit=days)
    else:
        # 日K / 周K / 月K
        klines = collector.get_klines(symbol, days=days)
        klines = _aggregate_klines(klines, interval)
    
    return {
        "symbol": symbol,
        "market": market_code.value,
        "days": days,
        "interval": interval,
        "klines": _serialize_klines(klines),
    }


@router.post("/batch")
def get_klines_batch(payload: KlineBatchRequest):
    """批量获取K线数据"""
    if not payload.items:
        return []

    results = []
    for item in payload.items:
        market_code = _parse_market(item.market)
        collector = KlineCollector(market_code)
        days = item.days or 60
        interval = (item.interval or "1d").lower()
        
        if interval in _INTRADAY_INTERVALS:
            klines = collector.get_intraday_klines(item.symbol, interval=interval, limit=days)
        else:
            klines = collector.get_klines(item.symbol, days=days)
            klines = _aggregate_klines(klines, interval)
        
        results.append(
            {
                "symbol": item.symbol,
                "market": market_code.value,
                "days": days,
                "interval": interval,
                "klines": _serialize_klines(klines),
            }
        )

    return results


@router.get("/{symbol}/summary")
def get_kline_summary(symbol: str, market: str = "CN"):
    """获取单只股票K线摘要"""
    market_code = _parse_market(market)
    return _get_kline_summary_cached(symbol, market_code)


@router.post("/summary/batch")
def get_kline_summary_batch(payload: KlineSummaryBatchRequest):
    """批量获取K线摘要"""
    if not payload.items:
        return []

    results = []
    for item in payload.items:
        market_code = _parse_market(item.market)
        results.append(_get_kline_summary_cached(item.symbol, market_code))

    return results
