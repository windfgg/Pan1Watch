"""新闻 API - 基于数据源配置"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from pydantic import BaseModel

from src.web.database import get_db
from src.web.models import Stock, DataSource
from src.collectors.news_collector import NewsCollector, NewsItem

router = APIRouter()

# 来源显示名称
SOURCE_LABELS = {
    "xueqiu": "雪球",
    "eastmoney_news": "东财资讯",
    "eastmoney": "东财公告",
}


class NewsItemResponse(BaseModel):
    source: str
    source_label: str
    external_id: str
    title: str
    content: str
    publish_time: str
    symbols: list[str]
    importance: int
    url: str = ""


class NewsPagedResponse(BaseModel):
    items: list[NewsItemResponse]
    total: int
    page: int
    page_size: int
    has_more: bool
    ai_extension: dict


def _build_symbol_context(
    db: Session,
    symbols: str,
    names: str,
) -> tuple[dict[str, str], list[str], dict[str, str]]:
    """解析 symbol/name 过滤上下文，返回 (stock_map, symbol_list, passed_symbol_names)。"""
    all_stocks = db.query(Stock).all()
    stock_map = {s.symbol: s.name for s in all_stocks}
    name_to_symbol = {s.name: s.symbol for s in all_stocks}

    # 解析股票 - 优先使用 names 参数
    if names:
        name_list = [n.strip() for n in names.split(",") if n.strip()]
        symbol_list = [name_to_symbol.get(n) for n in name_list if name_to_symbol.get(n)]
        passed_symbol_names = {name_to_symbol.get(n, ""): n for n in name_list if name_to_symbol.get(n)}
    elif symbols:
        symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
        passed_symbol_names = {s: stock_map.get(s, s) for s in symbol_list}
    else:
        symbol_list = list(stock_map.keys())
        passed_symbol_names = stock_map

    return stock_map, symbol_list, passed_symbol_names


async def _collect_news_rows(
    db: Session,
    symbols: str,
    names: str,
    hours: int,
    filter_related: bool,
    source: str,
) -> tuple[list[NewsItemResponse], dict[str, str]]:
    """采集并过滤新闻，返回新闻列表和股票映射。"""
    stock_map, symbol_list, passed_symbol_names = _build_symbol_context(db, symbols, names)
    if not symbol_list:
        return [], stock_map

    source_filters = {s.strip() for s in source.split(",") if s.strip()} if source else set()

    # 构建匹配关键词（股票代码 + 股票名称）
    keywords = set(symbol_list)
    for sym in symbol_list:
        if sym in stock_map:
            keywords.add(stock_map[sym])

    # 基于数据源配置构建采集器，直接传递股票名称映射避免重复查库
    collector = NewsCollector.from_database()
    news_items = await collector.fetch_all(
        symbols=symbol_list,
        since_hours=hours,
        symbol_names=passed_symbol_names,
    )

    def is_related(item: NewsItem) -> bool:
        """判断新闻是否与自选股相关"""
        if item.source == "eastmoney":
            return True
        if item.symbols and any(s in symbol_list for s in item.symbols):
            return True
        text = item.title + (item.content or "")
        return any(kw in text for kw in keywords)

    rows: list[NewsItemResponse] = []
    for item in news_items:
        if source_filters and item.source not in source_filters:
            continue
        if filter_related and not is_related(item):
            continue

        matched_symbols = []
        text = item.title + (item.content or "")
        for sym, name in stock_map.items():
            if sym in symbol_list and (sym in text or name in text):
                matched_symbols.append(sym)

        rows.append(
            NewsItemResponse(
                source=item.source,
                source_label=SOURCE_LABELS.get(item.source, item.source),
                external_id=item.external_id,
                title=item.title,
                content=item.content,
                publish_time=item.publish_time.strftime("%Y-%m-%d %H:%M"),
                symbols=matched_symbols or item.symbols,
                importance=item.importance,
                url=item.url,
            )
        )

    return rows, stock_map


@router.get("", response_model=list[NewsItemResponse])
async def get_news(
    symbols: str = Query(default="", description="股票代码，逗号分隔"),
    names: str = Query(default="", description="股票名称，逗号分隔（优先使用，比 symbols 更稳定）"),
    hours: int = Query(default=168, ge=1, le=720, description="时间范围（小时，默认7天）"),
    limit: int = Query(default=50, ge=1, le=200, description="返回数量"),
    filter_related: bool = Query(default=True, description="只显示相关新闻"),
    source: str = Query(default="", description="来源过滤，逗号分隔：xueqiu/eastmoney_news/eastmoney"),
    db: Session = Depends(get_db),
):
    """
    获取新闻列表（基于数据源配置）

    - symbols: 股票代码过滤，逗号分隔，空则获取所有自选股相关新闻
    - names: 股票名称过滤，逗号分隔（前端直接传递名称，更稳定）
    - hours: 时间范围
    - limit: 返回数量限制
    - filter_related: 是否只显示与自选股相关的新闻
    """
    rows, _ = await _collect_news_rows(
        db=db,
        symbols=symbols,
        names=names,
        hours=hours,
        filter_related=filter_related,
        source=source,
    )
    return rows[:limit]


@router.get("/paged", response_model=NewsPagedResponse)
async def get_news_paged(
    symbols: str = Query(default="", description="股票代码，逗号分隔"),
    names: str = Query(default="", description="股票名称，逗号分隔（优先使用）"),
    hours: int = Query(default=168, ge=1, le=720, description="时间范围（小时）"),
    filter_related: bool = Query(default=True, description="只显示相关新闻"),
    source: str = Query(default="", description="来源过滤，逗号分隔"),
    q: str = Query(default="", description="关键词搜索（标题/正文/来源/股票）"),
    page: int = Query(default=1, ge=1, description="页码，从 1 开始"),
    page_size: int = Query(default=10, ge=1, le=100, description="每页条数"),
    db: Session = Depends(get_db),
):
    """分页获取新闻列表（支持关键词搜索）。"""
    rows, stock_map = await _collect_news_rows(
        db=db,
        symbols=symbols,
        names=names,
        hours=hours,
        filter_related=filter_related,
        source=source,
    )

    keyword = (q or "").strip().lower()
    if keyword:
        filtered: list[NewsItemResponse] = []
        for row in rows:
            symbol_names = [stock_map.get(sym, "") for sym in row.symbols]
            haystack = " ".join(
                [
                    row.title,
                    row.content,
                    row.source,
                    row.source_label,
                    " ".join(row.symbols),
                    " ".join(symbol_names),
                ]
            ).lower()
            if keyword in haystack:
                filtered.append(row)
        rows = filtered

    total = len(rows)
    start = (page - 1) * page_size
    end = start + page_size
    items = rows[start:end]

    return NewsPagedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        has_more=end < total,
        ai_extension={
            "user_note": "reserved",
            "conversation_mode": "reserved",
            "memory_scope": "reserved",
        },
    )


@router.get("/sources")
def get_news_sources(db: Session = Depends(get_db)):
    """获取已配置的新闻数据源列表"""
    data_sources = (
        db.query(DataSource)
        .filter(DataSource.type == "news")
        .order_by(DataSource.priority)
        .all()
    )

    return [
        {
            "id": ds.provider,
            "name": ds.name,
            "enabled": ds.enabled,
            "priority": ds.priority,
        }
        for ds in data_sources
    ]
