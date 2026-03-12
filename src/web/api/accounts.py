"""账户和持仓管理 API"""
import logging
import time
import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel

from src.web.database import get_db
from src.web.models import Account, Position, Stock
from src.collectors.akshare_collector import _tencent_symbol, _fetch_tencent_quotes
from src.models.market import MarketCode

logger = logging.getLogger(__name__)
router = APIRouter()

# 汇率缓存
_hkd_rate_cache: dict = {"rate": 0.92, "ts": 0}  # 港币默认汇率 0.92
_usd_rate_cache: dict = {"rate": 7.25, "ts": 0}  # 美元默认汇率 7.25
EXCHANGE_RATE_TTL = 3600  # 1 小时缓存

SUPPORTED_ACCOUNT_MARKETS = {"CN", "HK", "US", "FUND"}
SUPPORTED_CURRENCIES = {"CNY", "HKD", "USD"}
MARKET_CURRENCY_MAP = {
    "CN": "CNY",
    "HK": "HKD",
    "US": "USD",
    "FUND": "CNY",
}


def get_hkd_cny_rate() -> float:
    """获取港币兑人民币汇率"""
    global _hkd_rate_cache

    # 检查缓存
    if time.time() - _hkd_rate_cache["ts"] < EXCHANGE_RATE_TTL:
        return _hkd_rate_cache["rate"]

    # 从新浪财经获取汇率
    try:
        resp = httpx.get(
            "https://hq.sinajs.cn/list=fx_shkdcny",
            timeout=5,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://finance.sina.com.cn/"
            }
        )
        # 格式: var hq_str_fx_shkdcny="时间,汇率,..."
        text = resp.text
        if "=" in text and "," in text:
            data = text.split('"')[1]
            parts = data.split(",")
            if len(parts) > 1:
                rate = float(parts[1])
                _hkd_rate_cache = {"rate": rate, "ts": time.time()}
                logger.info(f"更新港币汇率: {rate}")
                return rate
    except Exception as e:
        logger.warning(f"获取港币汇率失败，使用缓存: {e}")

    return _hkd_rate_cache["rate"]


def get_usd_cny_rate() -> float:
    """获取美元兑人民币汇率"""
    global _usd_rate_cache

    # 检查缓存
    if time.time() - _usd_rate_cache["ts"] < EXCHANGE_RATE_TTL:
        return _usd_rate_cache["rate"]

    # 从新浪财经获取汇率
    try:
        resp = httpx.get(
            "https://hq.sinajs.cn/list=fx_susdcny",
            timeout=5,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Referer": "https://finance.sina.com.cn/"
            }
        )
        # 格式: var hq_str_fx_susdcny="时间,汇率,..."
        text = resp.text
        if "=" in text and "," in text:
            data = text.split('"')[1]
            parts = data.split(",")
            if len(parts) > 1:
                rate = float(parts[1])
                _usd_rate_cache = {"rate": rate, "ts": time.time()}
                logger.info(f"更新美元汇率: {rate}")
                return rate
    except Exception as e:
        logger.warning(f"获取美元汇率失败，使用缓存: {e}")

    return _usd_rate_cache["rate"]


def get_currency_rate_to_cny(currency: str, rates_to_cny: dict[str, float]) -> float:
    cur = (currency or "CNY").upper()
    return float(rates_to_cny.get(cur, 1.0))


def convert_amount(amount: float, from_currency: str, to_currency: str, rates_to_cny: dict[str, float]) -> float:
    src = (from_currency or "CNY").upper()
    dst = (to_currency or "CNY").upper()
    if src == dst:
        return float(amount)
    src_to_cny = get_currency_rate_to_cny(src, rates_to_cny)
    dst_to_cny = get_currency_rate_to_cny(dst, rates_to_cny)
    if dst_to_cny == 0:
        return float(amount)
    amount_cny = float(amount) * src_to_cny
    return amount_cny / dst_to_cny


def normalize_account_market(value: str | None) -> str:
    market = (value or "CN").upper()
    if market not in SUPPORTED_ACCOUNT_MARKETS:
        raise HTTPException(400, "market 仅支持 CN/HK/US/FUND")
    return market


def normalize_currency(value: str | None) -> str:
    currency = (value or "CNY").upper()
    if currency not in SUPPORTED_CURRENCIES:
        raise HTTPException(400, "base_currency 仅支持 CNY/HKD/USD")
    return currency


def validate_market_currency_pair(market: str, currency: str) -> None:
    expected = MARKET_CURRENCY_MAP.get(market)
    if expected and currency != expected:
        raise HTTPException(400, f"{market} 账户的 base_currency 需为 {expected}")


# ========== Pydantic Models ==========

class AccountCreate(BaseModel):
    name: str
    available_funds: float = 0
    market: str = "CN"
    base_currency: str = "CNY"


class AccountUpdate(BaseModel):
    name: str | None = None
    available_funds: float | None = None
    market: str | None = None
    base_currency: str | None = None
    enabled: bool | None = None


class AccountResponse(BaseModel):
    id: int
    name: str
    market: str
    base_currency: str
    available_funds: float
    enabled: bool

    class Config:
        from_attributes = True


class PositionCreate(BaseModel):
    account_id: int
    stock_id: int
    cost_price: float
    quantity: int
    invested_amount: float | None = None
    trading_style: str | None = None  # short: 短线, swing: 波段, long: 长线


class PositionUpdate(BaseModel):
    cost_price: float | None = None
    quantity: int | None = None
    invested_amount: float | None = None
    trading_style: str | None = None


class PositionResponse(BaseModel):
    id: int
    account_id: int
    stock_id: int
    cost_price: float
    quantity: int
    invested_amount: float | None
    sort_order: int
    trading_style: str | None
    # 关联信息
    account_name: str | None = None
    stock_symbol: str | None = None
    stock_name: str | None = None

    class Config:
        from_attributes = True


class PositionReorderItem(BaseModel):
    id: int
    sort_order: int


class PositionReorderRequest(BaseModel):
    items: list[PositionReorderItem]


# ========== Account Endpoints ==========

@router.get("/accounts", response_model=list[AccountResponse])
def list_accounts(db: Session = Depends(get_db)):
    """获取所有账户"""
    return db.query(Account).order_by(Account.id).all()


@router.get("/accounts/{account_id}", response_model=AccountResponse)
def get_account(account_id: int, db: Session = Depends(get_db)):
    """获取单个账户"""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(404, "账户不存在")
    return account


@router.post("/accounts", response_model=AccountResponse)
def create_account(data: AccountCreate, db: Session = Depends(get_db)):
    """创建账户"""
    market = normalize_account_market(data.market)
    base_currency = normalize_currency(data.base_currency)
    validate_market_currency_pair(market, base_currency)
    account = Account(
        name=data.name,
        available_funds=data.available_funds,
        market=market,
        base_currency=base_currency,
    )
    db.add(account)
    db.commit()
    db.refresh(account)
    logger.info(f"创建账户: {account.name}")
    return account


@router.put("/accounts/{account_id}", response_model=AccountResponse)
def update_account(account_id: int, data: AccountUpdate, db: Session = Depends(get_db)):
    """更新账户"""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(404, "账户不存在")

    if data.name is not None:
        account.name = data.name
    if data.available_funds is not None:
        account.available_funds = data.available_funds
    next_market = account.market
    next_currency = account.base_currency
    if data.market is not None:
        next_market = normalize_account_market(data.market)
    if data.base_currency is not None:
        next_currency = normalize_currency(data.base_currency)
    validate_market_currency_pair(next_market, next_currency)
    account.market = next_market
    account.base_currency = next_currency
    if data.enabled is not None:
        account.enabled = data.enabled

    db.commit()
    db.refresh(account)
    logger.info(f"更新账户: {account.name}")
    return account


@router.delete("/accounts/{account_id}")
def delete_account(account_id: int, db: Session = Depends(get_db)):
    """删除账户（会同时删除该账户的所有持仓）"""
    account = db.query(Account).filter(Account.id == account_id).first()
    if not account:
        raise HTTPException(404, "账户不存在")

    db.delete(account)
    db.commit()
    logger.info(f"删除账户: {account.name}")
    return {"success": True}


# ========== Position Endpoints ==========

@router.get("/positions", response_model=list[PositionResponse])
def list_positions(
    account_id: int | None = None,
    stock_id: int | None = None,
    db: Session = Depends(get_db)
):
    """获取持仓列表，可按账户或股票筛选"""
    query = db.query(Position)
    if account_id:
        query = query.filter(Position.account_id == account_id)
    if stock_id:
        query = query.filter(Position.stock_id == stock_id)

    positions = query.order_by(Position.account_id.asc(
    ), Position.sort_order.asc(), Position.id.asc()).all()
    result = []
    for pos in positions:
        result.append({
            "id": pos.id,
            "account_id": pos.account_id,
            "stock_id": pos.stock_id,
            "cost_price": pos.cost_price,
            "quantity": pos.quantity,
            "invested_amount": pos.invested_amount,
            "sort_order": pos.sort_order or 0,
            "trading_style": pos.trading_style,
            "account_name": pos.account.name if pos.account else None,
            "stock_symbol": pos.stock.symbol if pos.stock else None,
            "stock_name": pos.stock.name if pos.stock else None,
        })
    return result


@router.post("/positions", response_model=PositionResponse)
def create_position(data: PositionCreate, db: Session = Depends(get_db)):
    """创建持仓"""
    # 检查账户和股票是否存在
    account = db.query(Account).filter(Account.id == data.account_id).first()
    if not account:
        raise HTTPException(400, "账户不存在")

    stock = db.query(Stock).filter(Stock.id == data.stock_id).first()
    if not stock:
        raise HTTPException(400, "股票不存在")

    # 检查是否已存在该账户的该股票持仓
    existing = db.query(Position).filter(
        Position.account_id == data.account_id,
        Position.stock_id == data.stock_id,
    ).first()
    if existing:
        raise HTTPException(
            400, f"账户 {account.name} 已有 {stock.name} 的持仓，请编辑现有持仓")

    max_order = db.query(func.max(Position.sort_order)).filter(
        Position.account_id == data.account_id
    ).scalar() or 0

    position = Position(
        account_id=data.account_id,
        stock_id=data.stock_id,
        cost_price=data.cost_price,
        quantity=data.quantity,
        invested_amount=data.invested_amount,
        sort_order=int(max_order) + 1,
        trading_style=data.trading_style,
    )
    db.add(position)
    db.commit()
    db.refresh(position)

    logger.info(f"创建持仓: {account.name} - {stock.name}")
    return {
        "id": position.id,
        "account_id": position.account_id,
        "stock_id": position.stock_id,
        "cost_price": position.cost_price,
        "quantity": position.quantity,
        "invested_amount": position.invested_amount,
        "sort_order": position.sort_order or 0,
        "trading_style": position.trading_style,
        "account_name": account.name,
        "stock_symbol": stock.symbol,
        "stock_name": stock.name,
    }


@router.put("/positions/{position_id}", response_model=PositionResponse)
def update_position(position_id: int, data: PositionUpdate, db: Session = Depends(get_db)):
    """更新持仓"""
    position = db.query(Position).filter(Position.id == position_id).first()
    if not position:
        raise HTTPException(404, "持仓不存在")

    if data.cost_price is not None:
        position.cost_price = data.cost_price
    if data.quantity is not None:
        position.quantity = data.quantity
    if data.invested_amount is not None:
        position.invested_amount = data.invested_amount
    if data.trading_style is not None:
        # 空字符串表示清空，设为 None
        position.trading_style = data.trading_style if data.trading_style else None

    db.commit()
    db.refresh(position)

    logger.info(f"更新持仓: {position.account.name} - {position.stock.name}")
    return {
        "id": position.id,
        "account_id": position.account_id,
        "stock_id": position.stock_id,
        "cost_price": position.cost_price,
        "quantity": position.quantity,
        "invested_amount": position.invested_amount,
        "sort_order": position.sort_order or 0,
        "trading_style": position.trading_style,
        "account_name": position.account.name,
        "stock_symbol": position.stock.symbol,
        "stock_name": position.stock.name,
    }


@router.delete("/positions/{position_id}")
def delete_position(position_id: int, db: Session = Depends(get_db)):
    """删除持仓"""
    position = db.query(Position).filter(Position.id == position_id).first()
    if not position:
        raise HTTPException(404, "持仓不存在")

    db.delete(position)
    db.commit()
    logger.info(f"删除持仓: {position.account.name} - {position.stock.name}")
    return {"success": True}


@router.put("/positions/reorder/batch")
def reorder_positions(data: PositionReorderRequest, db: Session = Depends(get_db)):
    """批量更新持仓排序"""
    if not data.items:
        return {"updated": 0}
    ids = [int(x.id) for x in data.items]
    rows = db.query(Position).filter(Position.id.in_(ids)).all()
    row_map = {r.id: r for r in rows}
    updated = 0
    for item in data.items:
        row = row_map.get(int(item.id))
        if not row:
            continue
        row.sort_order = int(item.sort_order)
        updated += 1
    db.commit()
    return {"updated": updated}


# ========== Portfolio Summary ==========

@router.get("/portfolio/summary")
def get_portfolio_summary(
    account_id: int | None = None,
    include_quotes: bool = True,
    display_currency: str = "CNY",
    db: Session = Depends(get_db),
):
    """
    获取持仓汇总信息

    Args:
        account_id: 可选，指定账户ID。不指定则汇总所有账户

    Returns:
        accounts: 账户列表及各账户持仓明细
        total: 所有账户汇总
    """
    display_currency_norm = normalize_currency(display_currency)

    # 获取账户
    if account_id:
        accounts = db.query(Account).filter(
            Account.id == account_id, Account.enabled == True).all()
    else:
        accounts = db.query(Account).filter(Account.enabled == True).all()

    if not accounts:
        return {
            "accounts": [],
            "total": {
                "total_market_value": 0,
                "total_cost": 0,
                "total_pnl": 0,
                "total_pnl_pct": 0,
                "day_pnl": 0,
                "day_pnl_pct": 0,
                "available_funds": 0,
                "total_assets": 0,
                "display_currency": display_currency_norm,
            }
        }

    # 获取所有相关股票
    all_stock_ids = set()
    for acc in accounts:
        for pos in acc.positions:
            all_stock_ids.add(pos.stock_id)

    stocks = db.query(Stock).filter(Stock.id.in_(
        all_stock_ids)).all() if all_stock_ids else []
    stock_map = {s.id: s for s in stocks}

    # 获取实时行情（可选）
    quotes = _fetch_quotes_for_stocks(stocks) if include_quotes else {}

    # 获取汇率（统一先换算到 CNY，再换算到展示币种）
    hkd_rate = get_hkd_cny_rate()
    usd_rate = get_usd_cny_rate()
    rates_to_cny = {
        "CNY": 1.0,
        "HKD": hkd_rate,
        "USD": usd_rate,
    }

    # 计算各账户持仓
    account_summaries = []
    grand_total_market_value = 0
    grand_total_cost = 0
    grand_total_day_pnl = 0
    grand_total_day_cost = 0
    grand_available_funds = 0

    for acc in accounts:
        positions_data = []
        acc_market_value = 0
        acc_cost = 0
        acc_day_pnl = 0
        acc_day_cost = 0

        account_market = (acc.market or "CN").upper()
        account_base_currency = (acc.base_currency or "").upper()
        if account_base_currency not in SUPPORTED_CURRENCIES:
            account_base_currency = MARKET_CURRENCY_MAP.get(
                account_market, "CNY")

        positions_sorted = sorted(
            list(acc.positions or []),
            key=lambda p: (int(getattr(p, "sort_order", 0) or 0), int(p.id)),
        )
        for pos in positions_sorted:
            stock = stock_map.get(pos.stock_id)
            if not stock:
                continue

            quote = quotes.get(f"{stock.market}:{stock.symbol}")
            current_price = quote["current_price"] if quote else None
            change_pct = quote["change_pct"] if quote else None
            prev_close = quote["prev_close"] if quote else None

            position_currency = MARKET_CURRENCY_MAP.get(
                (stock.market or "CN").upper(), "CNY")
            rate_to_display = convert_amount(
                1.0, position_currency, display_currency_norm, rates_to_cny)

            market_value = None
            market_value_display = None
            pnl_display = None
            pnl_pct = None
            day_pnl_display = None
            day_pnl_pct = None

            cost_native = pos.cost_price * pos.quantity
            cost_display = convert_amount(
                cost_native, position_currency, display_currency_norm, rates_to_cny)
            acc_cost += cost_display

            if current_price is not None:
                market_value = current_price * pos.quantity  # 原币种市值
                market_value_display = convert_amount(
                    market_value,
                    position_currency,
                    display_currency_norm,
                    rates_to_cny,
                )
                pnl_display = market_value_display - cost_display
                pnl_pct = (pnl_display / cost_display *
                           100) if cost_display > 0 else 0

                if prev_close is not None and prev_close > 0:
                    day_cost_native = prev_close * pos.quantity
                    day_cost_display = convert_amount(
                        day_cost_native,
                        position_currency,
                        display_currency_norm,
                        rates_to_cny,
                    )
                    day_pnl_native = (
                        current_price - prev_close) * pos.quantity
                    day_pnl_display = convert_amount(
                        day_pnl_native,
                        position_currency,
                        display_currency_norm,
                        rates_to_cny,
                    )
                    day_pnl_pct = (day_pnl_display / day_cost_display *
                                   100) if day_cost_display > 0 else 0
                    acc_day_pnl += day_pnl_display
                    acc_day_cost += day_cost_display

                acc_market_value += market_value_display

            current_price_display = None
            if current_price is not None:
                current_price_display = convert_amount(
                    current_price,
                    position_currency,
                    display_currency_norm,
                    rates_to_cny,
                )

            positions_data.append({
                "id": pos.id,
                "stock_id": pos.stock_id,
                "symbol": stock.symbol,
                "name": stock.name,
                "market": stock.market,
                "cost_price": pos.cost_price,
                "quantity": pos.quantity,
                "invested_amount": pos.invested_amount,
                "sort_order": pos.sort_order or 0,
                "trading_style": pos.trading_style,
                "currency": position_currency,
                "current_price": current_price,
                "current_price_display": round(current_price_display, 4) if current_price_display is not None else None,
                # 兼容旧字段名（历史前端使用）。
                "current_price_cny": round(current_price_display, 4) if current_price_display is not None else None,
                "change_pct": change_pct,
                "market_value": round(market_value, 2) if market_value else None,
                "market_value_display": round(market_value_display, 2) if market_value_display is not None else None,
                # 兼容旧字段名（历史前端使用）。
                "market_value_cny": round(market_value_display, 2) if market_value_display is not None else None,
                "pnl": round(pnl_display, 2) if pnl_display is not None else None,
                "pnl_pct": round(pnl_pct, 2) if pnl_pct is not None else None,
                "day_pnl": round(day_pnl_display, 2) if day_pnl_display is not None else None,
                "day_pnl_pct": round(day_pnl_pct, 2) if day_pnl_pct is not None else None,
                "exchange_rate": round(rate_to_display, 6),
            })

        if include_quotes:
            acc_pnl = acc_market_value - acc_cost
            acc_pnl_pct = (acc_pnl / acc_cost * 100) if acc_cost > 0 else 0
            acc_day_pnl_pct = (acc_day_pnl / acc_day_cost *
                               100) if acc_day_cost > 0 else 0
            acc_available_funds_display = convert_amount(
                acc.available_funds,
                account_base_currency,
                display_currency_norm,
                rates_to_cny,
            )
            acc_total_assets = acc_market_value + acc_available_funds_display
        else:
            acc_pnl = 0
            acc_pnl_pct = 0
            acc_day_pnl_pct = 0
            acc_available_funds_display = convert_amount(
                acc.available_funds,
                account_base_currency,
                display_currency_norm,
                rates_to_cny,
            )
            acc_total_assets = acc_available_funds_display

        account_summaries.append({
            "id": acc.id,
            "name": acc.name,
            "market": account_market,
            "base_currency": account_base_currency,
            "display_currency": display_currency_norm,
            "available_funds": round(acc_available_funds_display, 2),
            "available_funds_native": round(acc.available_funds, 2),
            "total_market_value": round(acc_market_value, 2),
            "total_cost": round(acc_cost, 2),
            "total_pnl": round(acc_pnl, 2),
            "total_pnl_pct": round(acc_pnl_pct, 2),
            "day_pnl": round(acc_day_pnl, 2),
            "day_pnl_pct": round(acc_day_pnl_pct, 2),
            "total_assets": round(acc_total_assets, 2),
            "positions": positions_data,
        })

        grand_total_market_value += acc_market_value
        grand_total_cost += acc_cost
        grand_total_day_pnl += acc_day_pnl
        grand_total_day_cost += acc_day_cost
        grand_available_funds += acc_available_funds_display

    if include_quotes:
        grand_pnl = grand_total_market_value - grand_total_cost
        grand_pnl_pct = (grand_pnl / grand_total_cost *
                         100) if grand_total_cost > 0 else 0
        grand_day_pnl_pct = (
            grand_total_day_pnl / grand_total_day_cost * 100) if grand_total_day_cost > 0 else 0
        grand_total_assets = grand_total_market_value + grand_available_funds
    else:
        grand_pnl = 0
        grand_pnl_pct = 0
        grand_day_pnl_pct = 0
        grand_total_assets = grand_available_funds

    # 构建 quotes 字典（用于前端股票列表显示）
    quotes_dict = {}
    if include_quotes:
        for symbol, quote in quotes.items():
            quotes_dict[symbol] = {
                "current_price": quote.get("current_price"),
                "change_pct": quote.get("change_pct"),
                "prev_close": quote.get("prev_close"),
            }

    return {
        "accounts": account_summaries,
        "total": {
            "total_market_value": round(grand_total_market_value, 2),
            "total_cost": round(grand_total_cost, 2),
            "total_pnl": round(grand_pnl, 2),
            "total_pnl_pct": round(grand_pnl_pct, 2),
            "day_pnl": round(grand_total_day_pnl, 2),
            "day_pnl_pct": round(grand_day_pnl_pct, 2),
            "available_funds": round(grand_available_funds, 2),
            "total_assets": round(grand_total_assets, 2),
            "display_currency": display_currency_norm,
        },
        "display_currency": display_currency_norm,
        "exchange_rates": {
            "HKD_CNY": hkd_rate,
            "USD_CNY": usd_rate,
            "rates_to_cny": rates_to_cny,
        },
        "quotes": quotes_dict,  # 可选：返回行情数据
    }


def _fetch_quotes_for_stocks(stocks: list[Stock]) -> dict:
    """获取股票列表的实时行情"""
    if not stocks:
        return {}

    # 按市场分组
    market_stocks: dict[str, list[Stock]] = {}
    for s in stocks:
        market_stocks.setdefault(s.market, []).append(s)

    quotes = {}
    for market, stock_list in market_stocks.items():
        try:
            market_code = MarketCode(market)
        except ValueError:
            continue

        symbols = [_tencent_symbol(s.symbol, market_code) for s in stock_list]
        try:
            items = _fetch_tencent_quotes(symbols)
            for item in items:
                quote_key = f"{market}:{item['symbol']}"
                quotes[quote_key] = item
        except Exception as e:
            logger.error(f"获取 {market} 行情失败: {e}")

    return quotes
