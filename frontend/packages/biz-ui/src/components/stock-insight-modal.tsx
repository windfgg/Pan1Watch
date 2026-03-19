import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Copy, Download, ExternalLink, RefreshCw, Share2 } from 'lucide-react'
import { insightApi, stocksApi } from '@panwatch/api'
import { getMarketBadge } from '@panwatch/biz-ui'
import { useLocalStorage } from '@/lib/utils'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { Switch } from '@panwatch/base-ui/components/ui/switch'
import { SuggestionBadge, type KlineSummary, type SuggestionInfo } from '@panwatch/biz-ui/components/suggestion-badge'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import InteractiveKline from '@panwatch/biz-ui/components/InteractiveKline'
import { KlineIndicators } from '@panwatch/biz-ui/components/kline-indicators'
import { buildKlineSuggestion } from '@/lib/kline-scorer'
import StockPriceAlertPanel from '@panwatch/biz-ui/components/stock-price-alert-panel'
import { TechnicalBadge } from '@panwatch/biz-ui/components/technical-badge'

interface QuoteResponse {
  symbol: string
  market: string
  exchange?: string | null
  name: string | null
  current_price: number | null
  change_pct: number | null
  change_amount: number | null
  prev_close: number | null
  open_price: number | null
  high_price: number | null
  low_price: number | null
  volume: number | null
  turnover: number | null
  turnover_rate?: number | null
  pe_ratio?: number | null
  total_market_value?: number | null
  circulating_market_value?: number | null
}

interface KlineSummaryResponse {
  symbol: string
  market: string
  summary: KlineSummary
}

interface MiniKlineResponse {
  symbol: string
  market: string
  klines: Array<{
    date: string
    open: number
    close: number
    high: number
    low: number
    volume: number
  }>
}

interface NewsItem {
  source: string
  source_label: string
  title: string
  content?: string
  publish_time: string
  url: string
  symbols?: string[]
}

interface HistoryRecord {
  id: number
  agent_name: string
  stock_symbol: string
  analysis_date: string
  title: string
  content: string
  suggestions?: Record<string, any> | null
  news?: Array<{
    source?: string
    title?: string
    publish_time?: string
    url?: string
  }> | null
  quality_overview?: Record<string, any> | null
  context_summary?: Record<string, any> | null
  context_payload?: Record<string, any> | null
  prompt_context?: string | null
  prompt_stats?: Record<string, any> | null
  news_debug?: Record<string, any> | null
  created_at: string
  updated_at?: string
}

interface PortfolioPosition {
  symbol: string
  market: string
  quantity: number
  cost_price: number
  market_value_cny: number | null
  pnl: number | null
}

interface PortfolioSummaryResponse {
  accounts: Array<{
    positions: PortfolioPosition[]
  }>
}

type InsightTab = 'overview' | 'kline' | 'suggestions' | 'news' | 'announcements' | 'reports'

interface StockAgentInfo {
  agent_name: string
  schedule?: string
  ai_model_id?: number | null
  notify_channel_ids?: number[]
}

interface StockItem {
  id: number
  symbol: string
  name: string
  market: string
  agents?: StockAgentInfo[]
}

const AGENT_LABELS: Record<string, string> = {
  daily_report: '盘后日报',
  premarket_outlook: '盘前分析',
  news_digest: '新闻速递',
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null) return '--'
  return value.toFixed(digits)
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value == null) return '--'
  const n = Number(value)
  if (!isFinite(n)) return '--'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return n.toFixed(0)
}

function formatMarketCap(value: number | null | undefined, market?: string): string {
  if (value == null) return '--'
  const n = Number(value)
  if (!isFinite(n)) return '--'
  const m = String(market || '').toUpperCase()
  const abs = Math.abs(n)

  // 腾讯 A 股字段常见为“亿元”口径（如 808 表示 808 亿元）
  if (m === 'CN' && abs > 0 && abs < 100000) {
    return `${n.toFixed(2)}亿元`
  }

  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿元`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万元`
  return `${n.toFixed(0)}元`
}

function getMarketText(market?: string, symbol?: string, exchange?: string | null): string {
  const value = String(market || '').toUpperCase()
  const code = String(symbol || '').trim().toUpperCase()
  const ex = String(exchange || '').trim().toUpperCase()
  if (value === 'US') {
    if (ex.includes('NASDAQ')) return '纳斯达克'
    if (ex.includes('NYSE')) return '纽交所'
    if (ex.includes('AMEX')) return '美交所'
    return '美股'
  }
  if (value === 'CN') {
    if (/^(920|83|87|88)/.test(code)) return '北交所'
    if (/^(300|301)/.test(code)) return '创业板'
    if (/^(5|6|900)/.test(code)) return '上交所'
    if (/^(0|1|2|3)/.test(code)) return '深交所'
    return 'A股'
  }
  if (value === 'HK') return '港交所'
  if (value === 'FUND') return '基金'
  return value || '--'
}

function formatTime(isoTime?: string): string {
  if (!isoTime) return ''
  const d = new Date(isoTime)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function formatClockTime(value?: string | number | Date | null): string {
  if (value == null || value === '') return '--:--:--'
  const d = value instanceof Date ? value : new Date(value)
  if (isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function isSameQuoteSnapshot(a: QuoteResponse | null | undefined, b: QuoteResponse | null | undefined): boolean {
  if (!a && !b) return true
  if (!a || !b) return false

  const norm = (v: unknown): number | null => {
    if (v == null || v === '') return null
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    return Math.round(n * 10000) / 10000
  }

  const eq = (x: unknown, y: unknown, eps = 1e-4): boolean => {
    const nx = norm(x)
    const ny = norm(y)
    if (nx == null && ny == null) return true
    if (nx == null || ny == null) return false
    return Math.abs(nx - ny) <= eps
  }

  return (
    eq(a.current_price, b.current_price)
    && eq(a.change_pct, b.change_pct)
    && eq(a.change_amount, b.change_amount)
    && eq(a.prev_close, b.prev_close)
  )
}

function parseToMs(input?: string): number | null {
  if (!input) return null
  const d = new Date(input)
  if (!isNaN(d.getTime())) return d.getTime()
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0)
  return isNaN(dt.getTime()) ? null : dt.getTime()
}

function parseSuggestionJson(raw: unknown): Record<string, any> | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  const candidates: string[] = [s]
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) candidates.unshift(fence[1].trim())
  if (/^json\s*[\r\n]/i.test(s)) candidates.unshift(s.replace(/^json\s*[\r\n]/i, '').trim())
  for (const c of candidates) {
    if (!c) continue
    const direct = c
    const sliceStart = c.indexOf('{')
    const sliceEnd = c.lastIndexOf('}')
    const sliced = sliceStart >= 0 && sliceEnd > sliceStart ? c.slice(sliceStart, sliceEnd + 1) : ''
    for (const text of [direct, sliced]) {
      if (!text || !text.startsWith('{') || !text.endsWith('}')) continue
      try {
        const obj = JSON.parse(text)
        if (obj && typeof obj === 'object') return obj as Record<string, any>
      } catch {
        // try next candidate
      }
    }
  }
  return null
}

function normalizeSuggestionAction(action?: string, actionLabel?: string): string {
  const a = String(action || '').trim().toLowerCase()
  const l = String(actionLabel || '').trim()
  if (a === 'buy/add' || a === 'add/buy') return /加仓|增持|补仓/.test(l) ? 'add' : 'buy'
  if (a === 'sell/reduce' || a === 'reduce/sell') return /减仓|减持/.test(l) ? 'reduce' : 'sell'
  return a || 'watch'
}

function pickSuggestionText(raw: unknown, field: 'signal' | 'reason'): string {
  const plain = String(raw || '').trim()
  const obj = parseSuggestionJson(plain)
  if (obj) {
    const v = String(obj[field] || '').trim()
    if (v) return v
    if (field === 'reason') {
      const rv = String(obj['raw'] || '').trim()
      if (rv) return rv
    }
    return ''
  }
  return plain
}

function normalizeTextList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(x => String(x || '').trim()).filter(Boolean)
  const s = String(raw || '').trim()
  if (!s) return []
  const bySep = s.split(/[；;、|]/).map(x => x.trim()).filter(Boolean)
  return bySep.length > 1 ? bySep : [s]
}

function markdownToPlainText(input?: string): string {
  const raw = String(input || '').trim()
  if (!raw) return ''
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstNonEmptyText(...vals: unknown[]): string {
  for (const v of vals) {
    const s = String(v || '').trim()
    if (s) return s
  }
  return ''
}

function buildShareTechnicalRisks(kline: KlineSummary | null): string[] {
  if (!kline) return []
  const out: string[] = []
  const rsi = String(kline.rsi_status || '')
  const macd = `${kline.macd_cross || ''} ${kline.macd_status || ''}`
  const vol = String(kline.volume_trend || '')
  if (rsi.includes('超买')) out.push('短线过热回撤风险')
  if (rsi.includes('超卖')) out.push('弱势延续风险')
  if (macd.includes('死叉')) out.push('趋势转弱风险')
  if (macd.includes('顶背离')) out.push('动能背离风险')
  if (vol.includes('放量')) out.push('波动放大风险')
  return out.slice(0, 3)
}

function TechnicalIndicatorStrip(props: {
  klineSummary: KlineSummary | null
  technicalSuggestion: SuggestionInfo | null
  stockName: string
  stockSymbol: string
  market: string
  hasPosition: boolean
  score?: number
  evidence?: Array<{ text: string; delta: number }>
}) {
  const { klineSummary, technicalSuggestion, stockName, stockSymbol, market, hasPosition, score, evidence = [] } = props
  if (!klineSummary) {
    return <div className="text-[12px] text-muted-foreground py-3">暂无技术指标</div>
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-muted-foreground">技术指标建议</span>
        <SuggestionBadge
          suggestion={technicalSuggestion}
          stockName={stockName}
          stockSymbol={stockSymbol}
          market={market}
          kline={klineSummary}
          hasPosition={hasPosition}
        />
        <TechnicalBadge label={`评分 ${Number(score ?? 0).toFixed(1)}`} tone="neutral" size="xs" className="text-foreground" />
      </div>
      {evidence.length > 0 && (
        <div className="flex flex-wrap gap-1.5 text-[10px]">
          {evidence.slice(0, 6).map((item, idx) => (
            <TechnicalBadge
              key={`${item.text}-${idx}`}
              label={`${item.text} ${item.delta > 0 ? `+${item.delta}` : item.delta}`}
              tone={item.delta > 0 ? 'bullish' : item.delta < 0 ? 'bearish' : 'neutral'}
              size="xs"
            />
          ))}
        </div>
      )}
      <KlineIndicators summary={klineSummary as any} />
    </div>
  )
}

export default function StockInsightModal(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  symbol: string
  market: string
  stockName?: string
  hasPosition?: boolean
}) {
  const { toast } = useToast()
  const symbol = String(props.symbol || '').trim()
  const market = String(props.market || 'CN').trim().toUpperCase()
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<InsightTab>('overview')
  const [newsHours, setNewsHours] = useLocalStorage<string>('stock_insight_news_hours', '168')
  const [announcementHours, setAnnouncementHours] = useLocalStorage<string>('stock_insight_announcement_hours', '168')
  const [includeExpiredSuggestions, setIncludeExpiredSuggestions] = useLocalStorage<boolean>(
    'stock_insight_include_expired_suggestions',
    true
  )
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useLocalStorage<boolean>(
    'stock_insight_auto_refresh_enabled',
    true
  )
  const [autoRefreshSec, setAutoRefreshSec] = useLocalStorage<number>(
    'stock_insight_auto_refresh_sec',
    20
  )
  const [autoRefreshProgress, setAutoRefreshProgress] = useState(0)
  const [autoRefreshChanged, setAutoRefreshChanged] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [klineRefreshTrigger, setKlineRefreshTrigger] = useState(0)
  const [overviewHighlightKey, setOverviewHighlightKey] = useState(0)
  const [overviewHighlightUp, setOverviewHighlightUp] = useState(false)
  const prevQuoteRef = useRef<{ current_price: number | null; change_pct: number | null } | null>(null)
  const quoteStateRef = useRef<QuoteResponse | null>(null)
  const [quote, setQuote] = useState<QuoteResponse | null>(null)
  const [klineSummary, setKlineSummary] = useState<KlineSummary | null>(null)
  const [miniKlines, setMiniKlines] = useState<MiniKlineResponse['klines']>([])
  const [miniKlineLoading, setMiniKlineLoading] = useState(false)
  const [miniHoverIdx, setMiniHoverIdx] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<SuggestionInfo[]>([])
  const [news, setNews] = useState<NewsItem[]>([])
  const [announcements, setAnnouncements] = useState<NewsItem[]>([])
  const [reports, setReports] = useState<HistoryRecord[]>([])
  const [reportTab, setReportTab] = useState<'premarket_outlook' | 'daily_report'>('premarket_outlook')
  const [klineInterval] = useState<'1d' | '1w' | '1m'>('1d')
  const [alerting, setAlerting] = useState(false)
  const [watchingStock, setWatchingStock] = useState<StockItem | null>(null)
  const [watchToggleLoading, setWatchToggleLoading] = useState(false)
  const [autoSuggesting, setAutoSuggesting] = useState(false)
  const [imageExporting, setImageExporting] = useState(false)
  const [sharePreviewOpen, setSharePreviewOpen] = useState(false)
  const [sharePreviewUrl, setSharePreviewUrl] = useState('')
  const [includeHoldingPnlRate, setIncludeHoldingPnlRate] = useState(true)
  const [includeHoldingPnlAmount, setIncludeHoldingPnlAmount] = useState(true)
  const [holdingAgg, setHoldingAgg] = useState<{
    quantity: number
    cost: number
    unitCost: number
    marketValue: number
    pnl: number
  } | null>(null)
  const [holdingLoaded, setHoldingLoaded] = useState(false)
  const [holdingLoadError, setHoldingLoadError] = useState(false)
  const autoTriggeredRef = useRef<Record<string, number>>({})
  const stockCacheRef = useRef<Record<string, StockItem>>({})
  const resolvedName = useMemo(() => props.stockName || quote?.name || symbol, [props.stockName, quote?.name, symbol])

  const loadQuote = useCallback(async () => {
    if (!symbol) return
    const data = await insightApi.quote<QuoteResponse>(symbol, market)
    const next = data || null
    setAutoRefreshChanged(!isSameQuoteSnapshot(quoteStateRef.current, next))
    setLastUpdatedAt(Date.now())
    setQuote(data || null)
  }, [symbol, market])

  const loadKline = useCallback(async () => {
    if (!symbol) return
    const data = await insightApi.klineSummary<KlineSummaryResponse>(symbol, market)
    setLastUpdatedAt(Date.now())
    setKlineSummary(data?.summary || null)
  }, [symbol, market])

  const loadMiniKline = useCallback(async (opts?: { silent?: boolean }) => {
    if (!symbol) return
    const silent = !!opts?.silent
    if (!silent) setMiniKlineLoading(true)
    try {
      const data = await insightApi.klines<MiniKlineResponse>(symbol, {
        market,
        days: 36,
        interval: '1d',
      })
      setLastUpdatedAt(Date.now())
      setMiniKlines((data?.klines || []).slice(-30))
    } catch {
      setMiniKlines([])
    } finally {
      if (!silent) setMiniKlineLoading(false)
    }
  }, [symbol, market])

  const loadSuggestions = useCallback(async () => {
    if (!symbol) return
    const data = await insightApi.suggestions<any[]>(symbol, {
      market,
      limit: 20,
      include_expired: includeExpiredSuggestions,
    })
    const list = (data || []).map(item => ({
      id: item.id,
      action: normalizeSuggestionAction(item.action, item.action_label),
      action_label: item.action_label || '',
      signal: pickSuggestionText(item.signal, 'signal'),
      reason: pickSuggestionText(item.reason, 'reason'),
      should_alert: !!item.should_alert,
      agent_name: item.agent_name,
      agent_label: item.agent_label,
      created_at: item.created_at,
      is_expired: item.is_expired,
      prompt_context: item.prompt_context,
      ai_response: item.ai_response,
      raw: item.raw || '',
      meta: item.meta,
    })) as SuggestionInfo[]
    setLastUpdatedAt(Date.now())
    setSuggestions(list)
  }, [symbol, market, includeExpiredSuggestions])

  const loadNews = useCallback(async () => {
    if (!symbol) return
    const runQuery = async (opts: { useName: boolean; filterRelated: boolean }) => {
      const params = new URLSearchParams()
      params.set('hours', newsHours)
      params.set('limit', '50')
      if (!opts.filterRelated) params.set('filter_related', 'false')
      if (opts.useName && resolvedName && resolvedName !== symbol) params.set('names', resolvedName)
      else params.set('symbols', symbol)
      return insightApi.news<NewsItem[]>(Object.fromEntries(params.entries()))
    }

    try {
      let data: NewsItem[] = await runQuery({ useName: true, filterRelated: true })
      if ((data || []).length === 0 && resolvedName && resolvedName !== symbol) {
        data = await runQuery({ useName: false, filterRelated: true })
      }
      if ((data || []).length === 0) {
        data = await runQuery({ useName: true, filterRelated: false })
      }
      if ((data || []).length === 0) {
        data = await runQuery({ useName: false, filterRelated: false })
      }
      if ((data || []).length === 0) {
        const global = await insightApi.news<NewsItem[]>({
          hours: newsHours,
          limit: 80,
        }).catch(() => [])
        const upperSymbol = symbol.toUpperCase()
        const name = (resolvedName || '').trim()
        data = (global || []).filter((n) => {
          const text = `${n.title || ''} ${n.content || ''}`.toUpperCase()
          if (upperSymbol && text.includes(upperSymbol)) return true
          if (name && `${n.title || ''} ${n.content || ''}`.includes(name)) return true
          return (n.symbols || []).map(x => String(x).toUpperCase()).includes(upperSymbol)
        })
      }
      // 兜底：实时新闻为空时，回退到 news_digest 历史快照中的新闻列表
      if ((data || []).length === 0) {
        const bySymbol = await insightApi.history<HistoryRecord[]>({
          agent_name: 'news_digest',
          stock_symbol: symbol,
          limit: 1,
        }).catch(() => [])
        let rec: HistoryRecord | null = (bySymbol || [])[0] || null
        if (!rec) {
          const globals = await insightApi.history<HistoryRecord[]>({
            agent_name: 'news_digest',
            stock_symbol: '*',
            limit: 20,
          }).catch(() => [])
          const upperSymbol = symbol.toUpperCase()
          const name = (resolvedName || '').trim()
          rec = (globals || []).find((r) => {
            const sug = r?.suggestions || {}
            const keys = Object.keys(sug || {})
            if (keys.includes(symbol) || keys.map(k => k.toUpperCase()).includes(upperSymbol)) return true
            const text = `${r?.title || ''}\n${r?.content || ''}`.toUpperCase()
            if (upperSymbol && text.includes(upperSymbol)) return true
            if (name && `${r?.title || ''}\n${r?.content || ''}`.includes(name)) return true
            return false
          }) || null
        }
        if (rec?.news && Array.isArray(rec.news)) {
          data = rec.news
            .map((n) => ({
              source: n.source || 'news_digest',
              source_label: n.source || 'news_digest',
              title: n.title || '',
              publish_time: n.publish_time || rec?.analysis_date || '',
              url: n.url || '',
            }))
            .filter((n) => !!n.title)
        }
      }
      setLastUpdatedAt(Date.now())
      setNews(data || [])
    } catch {
      setNews([])
    }
  }, [symbol, newsHours, resolvedName])

  const loadAnnouncements = useCallback(async () => {
    if (!symbol) return
    try {
      const runQuery = async (opts: { useName: boolean; filterRelated: boolean }) => {
        const params = new URLSearchParams()
        params.set('hours', announcementHours)
        params.set('limit', '50')
        if (!opts.filterRelated) params.set('filter_related', 'false')
        params.set('source', 'eastmoney')
        if (opts.useName && resolvedName && resolvedName !== symbol) params.set('names', resolvedName)
        else params.set('symbols', symbol)
        return insightApi.news<NewsItem[]>(Object.fromEntries(params.entries()))
      }
      let data: NewsItem[] = await runQuery({ useName: true, filterRelated: true })
      if ((data || []).length === 0 && resolvedName && resolvedName !== symbol) {
        data = await runQuery({ useName: false, filterRelated: true })
      }
      if ((data || []).length === 0) {
        data = await runQuery({ useName: true, filterRelated: false })
      }
      if ((data || []).length === 0) {
        data = await runQuery({ useName: false, filterRelated: false })
      }
      if ((data || []).length === 0) {
        const global = await insightApi.news<NewsItem[]>({
          hours: announcementHours,
          limit: 80,
          source: 'eastmoney',
        }).catch(() => [])
        const upperSymbol = symbol.toUpperCase()
        const name = (resolvedName || '').trim()
        data = (global || []).filter((n) => {
          const text = `${n.title || ''} ${n.content || ''}`.toUpperCase()
          if (upperSymbol && text.includes(upperSymbol)) return true
          if (name && `${n.title || ''} ${n.content || ''}`.includes(name)) return true
          return (n.symbols || []).map(x => String(x).toUpperCase()).includes(upperSymbol)
        })
      }
      setLastUpdatedAt(Date.now())
      setAnnouncements(data || [])
    } catch {
      setAnnouncements([])
    }
  }, [symbol, announcementHours, resolvedName])

  const loadHoldingAgg = useCallback(async () => {
    if (!symbol) return
    setHoldingLoaded(false)
    setHoldingLoadError(false)
    try {
      const data = await insightApi.portfolioSummary<PortfolioSummaryResponse>({ include_quotes: true })
      let quantity = 0
      let cost = 0
      let marketValue = 0
      let pnl = 0
      for (const acc of data?.accounts || []) {
        for (const p of acc.positions || []) {
          if (p.symbol !== symbol || p.market !== market) continue
          quantity += Number(p.quantity || 0)
          cost += Number(p.cost_price || 0) * Number(p.quantity || 0)
          marketValue += Number(p.market_value_cny || 0)
          pnl += Number(p.pnl || 0)
        }
      }
      setLastUpdatedAt(Date.now())
      if (quantity > 0) setHoldingAgg({ quantity, cost, unitCost: cost / quantity, marketValue, pnl })
      else setHoldingAgg(null)
    } catch {
      setHoldingAgg(null)
      setHoldingLoadError(true)
    } finally {
      setHoldingLoaded(true)
    }
  }, [symbol, market])

  const loadReports = useCallback(async () => {
    if (!symbol) return
    try {
      const agents = ['premarket_outlook', 'daily_report']
      const bySymbolResults = await Promise.all(
        agents.map(agent =>
          insightApi.history<HistoryRecord[]>({
            agent_name: agent,
            stock_symbol: symbol,
            limit: 1,
          }).catch(() => [])
        )
      )
      let merged = bySymbolResults
        .flatMap(items => items || [])
        .filter(Boolean)
      // 兼容全局记录（stock_symbol="*"）场景：从最近全局记录中筛选与当前股票相关的报告。
      if (merged.length === 0) {
        const globalResults = await Promise.all(
          agents.map(agent =>
            insightApi.history<HistoryRecord[]>({
              agent_name: agent,
              stock_symbol: '*',
              limit: 20,
            }).catch(() => [])
          )
        )
        const upperSymbol = symbol.toUpperCase()
        const name = (resolvedName || '').trim()
        merged = globalResults
          .map(items => {
            const rows = (items || []).filter(Boolean)
            const hit = rows.find((r) => {
              const sug = r?.suggestions || {}
              const keys = Object.keys(sug || {})
              if (keys.includes(symbol) || keys.map(k => k.toUpperCase()).includes(upperSymbol)) return true
              const text = `${r?.title || ''}\n${r?.content || ''}`.toUpperCase()
              if (upperSymbol && text.includes(upperSymbol)) return true
              if (name && `${r?.title || ''}\n${r?.content || ''}`.includes(name)) return true
              return false
            })
            return hit || null
          })
          .filter(Boolean) as HistoryRecord[]
      }
      merged = merged.sort((a, b) => {
        const am = parseToMs(a.updated_at || a.created_at || a.analysis_date) || 0
        const bm = parseToMs(b.updated_at || b.created_at || b.analysis_date) || 0
        return bm - am
      })
      setLastUpdatedAt(Date.now())
      setReports(merged)
    } catch {
      setReports([])
    }
  }, [symbol, resolvedName])

  useEffect(() => {
    quoteStateRef.current = quote
  }, [quote])

  const loadCore = useCallback(async () => {
    if (!symbol) return
    setLoading(true)
    try {
      await Promise.allSettled([loadQuote(), loadKline(), loadMiniKline(), loadHoldingAgg()])
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [symbol, loadQuote, loadKline, loadMiniKline, loadHoldingAgg, toast])

  const handleRefreshAll = useCallback(async () => {
    if (!symbol) return
    setLoading(true)
    try {
      await Promise.allSettled([loadQuote(), loadKline(), loadMiniKline(), loadSuggestions(), loadNews(), loadAnnouncements(), loadHoldingAgg(), loadReports()])
    } catch (e) {
      toast(e instanceof Error ? e.message : '加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [symbol, loadQuote, loadKline, loadMiniKline, loadSuggestions, loadNews, loadAnnouncements, loadHoldingAgg, loadReports, toast])

  const refreshForAuto = useCallback(async () => {
    if (!symbol) return
    const tasks: Promise<any>[] = [loadQuote(), loadHoldingAgg()]
    if (tab === 'overview' || tab === 'kline') {
      tasks.push(loadKline(), loadMiniKline({ silent: true }))
    }
    if (tab === 'overview' || tab === 'suggestions') {
      tasks.push(loadSuggestions())
    }
    if (tab === 'overview' || tab === 'news') {
      tasks.push(loadNews())
    }
    if (tab === 'overview' || tab === 'announcements') {
      tasks.push(loadAnnouncements())
    }
    if (tab === 'overview' || tab === 'reports') {
      tasks.push(loadReports())
    }
    await Promise.allSettled(tasks)
  }, [symbol, tab, loadQuote, loadHoldingAgg, loadKline, loadMiniKline, loadSuggestions, loadNews, loadAnnouncements, loadReports])

  useEffect(() => {
    if (!props.open || !symbol) return
    setTab('overview')
    setSuggestions([])
    setNews([])
    setAnnouncements([])
    setReports([])
    setMiniKlines([])
    setWatchingStock(null)
    loadCore()
  }, [props.open, symbol, market, loadCore])

  useEffect(() => {
    if (!props.open || !symbol) return
    let cancelled = false
    ;(async () => {
      try {
        const key = `${market}:${symbol}`
        const stocks = await stocksApi.list()
        if (cancelled) return
        const found = (stocks || []).find(s => s.symbol === symbol && s.market === market) || null
        if (found) {
          stockCacheRef.current[key] = found
        } else {
          delete stockCacheRef.current[key]
        }
        setWatchingStock(found)
      } catch {
        if (!cancelled) setWatchingStock(null)
      }
    })()
    return () => { cancelled = true }
  }, [props.open, symbol, market])

  useEffect(() => {
    if (!props.open || !symbol) return
    loadNews().catch(() => setNews([]))
  }, [props.open, symbol, newsHours, loadNews])

  useEffect(() => {
    if (!props.open || !symbol) return
    loadAnnouncements().catch(() => setAnnouncements([]))
  }, [props.open, symbol, announcementHours, loadAnnouncements])

  useEffect(() => {
    if (!props.open || !symbol) return
    loadSuggestions().catch(() => setSuggestions([]))
  }, [props.open, symbol, includeExpiredSuggestions, loadSuggestions])

  useEffect(() => {
    if (!props.open || !symbol) return
    loadReports().catch(() => setReports([]))
  }, [props.open, symbol, loadReports])

  useEffect(() => {
    if (!props.open || !symbol || !autoRefreshEnabled) {
      setAutoRefreshProgress(0)
      return
    }
    const sec = Number(autoRefreshSec) > 0 ? Number(autoRefreshSec) : 20
    const ms = Math.max(10, sec) * 1000
    const startTime = Date.now()
    // 刷新定时器
    const refreshTimer = setInterval(() => {
      refreshForAuto().catch(() => undefined)
      // 如果在 K线 tab，触发 InteractiveKline 刷新
      if (tab === 'kline') {
        setKlineRefreshTrigger(prev => prev + 1)
      }
    }, ms)
    // 进度更新定时器
    const tick = () => {
      const elapsed = Date.now() - startTime
      const cycleElapsed = elapsed % ms
      const progress = 1 - cycleElapsed / ms
      setAutoRefreshProgress(progress)
    }
    tick()
    const progressTimer = setInterval(tick, 100)
    return () => {
      clearInterval(refreshTimer)
      clearInterval(progressTimer)
      setAutoRefreshProgress(0)
    }
  }, [props.open, symbol, autoRefreshEnabled, autoRefreshSec, refreshForAuto, tab])

  const hasHolding = !!props.hasPosition || !!holdingAgg
  const technicalScored = useMemo(() => {
    if (!klineSummary) return null
    return buildKlineSuggestion(klineSummary as any, hasHolding)
  }, [klineSummary, hasHolding])
  const technicalFallbackSuggestion = useMemo<SuggestionInfo | null>(() => {
    if (!klineSummary || !technicalScored) return null
    const topEvidence = (technicalScored.evidence || []).filter(e => e.delta !== 0).slice(0, 3).map(e => e.text)
    return {
      action: technicalScored.action,
      action_label: technicalScored.action_label,
      signal: technicalScored.signal || '技术面中性',
      reason: topEvidence.length > 0 ? topEvidence.join('；') : '基于K线技术指标自动生成的基础建议',
      should_alert: technicalScored.action === 'buy' || technicalScored.action === 'add' || technicalScored.action === 'sell' || technicalScored.action === 'reduce',
      agent_name: 'technical_fallback',
      agent_label: '技术指标',
      created_at: new Date().toISOString(),
      is_expired: false,
      meta: {
        fallback: true,
        score: technicalScored.score,
        evidence_count: technicalScored.evidence?.length || 0,
      },
    }
  }, [klineSummary, technicalScored])
  const quoteUp = (quote?.change_pct || 0) > 0
  const quoteDown = (quote?.change_pct || 0) < 0
  const changeColor = quoteUp ? 'text-rose-500' : quoteDown ? 'text-emerald-500' : 'text-foreground'
  const priceColor = quoteUp ? 'text-rose-500' : quoteDown ? 'text-emerald-500' : 'text-foreground'

  // 检测 quote 变化，触发概览高亮
  useEffect(() => {
    if (!quote) return
    const current = {
      current_price: quote.current_price ?? null,
      change_pct: quote.change_pct ?? null,
    }
    const prev = prevQuoteRef.current
    if (prev) {
      const prevPrice = prev.current_price ?? 0
      const currPrice = current.current_price ?? 0
      const delta = currPrice - prevPrice
      if (delta !== 0) {
        setOverviewHighlightUp(delta > 0)
        setOverviewHighlightKey(k => k + 1)
      }
    }
    prevQuoteRef.current = current
  }, [quote])

  const overviewHighlightClass = overviewHighlightKey > 0
    ? overviewHighlightUp
      ? 'animate-highlight-fade-up'
      : 'animate-highlight-fade-down'
    : ''
  const levelColor = (value: number | null | undefined) => {
    if (value == null || quote?.prev_close == null) return 'text-foreground'
    if (value > quote.prev_close) return 'text-rose-500'
    if (value < quote.prev_close) return 'text-emerald-500'
    return 'text-foreground'
  }
  const badge = getMarketBadge(market)
  const amplitudePct = useMemo(() => {
    const hi = quote?.high_price
    const lo = quote?.low_price
    const pre = quote?.prev_close
    if (hi == null || lo == null || pre == null || pre === 0) return null
    return ((hi - lo) / pre) * 100
  }, [quote?.high_price, quote?.low_price, quote?.prev_close])

  const reportMap = useMemo(() => {
    const out: Record<string, HistoryRecord | null> = {
      premarket_outlook: null,
      daily_report: null,
    }
    for (const r of reports) {
      if (!out[r.agent_name]) out[r.agent_name] = r
    }
    return out
  }, [reports])
  const reportCounts = useMemo(() => {
    const counts = {
      premarket_outlook: 0,
      daily_report: 0,
    }
    for (const item of reports) {
      if (item.agent_name === 'premarket_outlook') counts.premarket_outlook += 1
      if (item.agent_name === 'daily_report') counts.daily_report += 1
    }
    return counts
  }, [reports])
  const activeReport = reportMap[reportTab]
  const latestReport = reports[0] || null
  const latestShareSuggestion = suggestions[0] || technicalFallbackSuggestion
  const shareCardPayload = useMemo(() => {
    const jsonSources = [
      parseSuggestionJson((latestShareSuggestion as any)?.signal),
      parseSuggestionJson((latestShareSuggestion as any)?.reason),
      parseSuggestionJson((latestShareSuggestion as any)?.raw),
      parseSuggestionJson((latestShareSuggestion as any)?.ai_response),
      parseSuggestionJson((latestShareSuggestion as any)?.prompt_context),
      (latestShareSuggestion as any)?.meta && typeof (latestShareSuggestion as any).meta === 'object'
        ? ((latestShareSuggestion as any).meta as Record<string, any>)
        : null,
    ].filter(Boolean) as Array<Record<string, any>>
    const pickFromJson = (...keys: string[]) => {
      for (const obj of jsonSources) {
        for (const key of keys) {
          const s = String(obj?.[key] || '').trim()
          if (s) return s
        }
      }
      return ''
    }
    const pickListFromJson = (...keys: string[]) => {
      for (const obj of jsonSources) {
        for (const key of keys) {
          const list = normalizeTextList(obj?.[key])
          if (list.length > 0) return list
        }
      }
      return [] as string[]
    }
    const marketLabel = badge.label
    const price = quote?.current_price != null ? formatNumber(quote.current_price) : '--'
    const chg = quote?.change_pct != null ? `${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%` : '--'
    const action = latestShareSuggestion?.action_label || latestShareSuggestion?.action || '暂无'
    const signal = firstNonEmptyText(
      latestShareSuggestion?.signal,
      pickFromJson('signal', 'summary', 'core_view'),
      technicalScored?.signal,
      '技术面中性'
    ) || '--'
    const reason = firstNonEmptyText(
      latestShareSuggestion?.reason,
      pickFromJson('reason', 'thesis', 'core_judgement', 'core_judgment', 'analysis'),
      technicalFallbackSuggestion?.reason,
      '暂无'
    ) || '--'
    const risksList = [
      ...normalizeTextList((latestShareSuggestion as any)?.meta?.risks),
      ...pickListFromJson('risks', 'risk', 'risk_points'),
      ...buildShareTechnicalRisks(klineSummary),
    ].filter(Boolean)
    const dedupRisks = Array.from(new Set(risksList))
    const risks = dedupRisks.length > 0 ? dedupRisks.slice(0, 2).join('；') : '市场波动风险'
    const triggerList = pickListFromJson('triggers', 'trigger', 'signals')
    const invalidList = pickListFromJson('invalidations', 'invalidation', 'stop_conditions')
    const trigger = triggerList.length > 0 ? triggerList.slice(0, 2).join('；') : '--'
    const invalidation = invalidList.length > 0 ? invalidList.slice(0, 2).join('；') : '--'
    const technicalBrief = firstNonEmptyText(
      [klineSummary?.trend, klineSummary?.macd_status, klineSummary?.rsi_status].filter(Boolean).join(' / '),
      technicalScored?.signal
    ) || '--'
    const levelsBrief = (klineSummary?.support != null && klineSummary?.resistance != null)
      ? `支撑 ${formatNumber(klineSummary.support)} / 压力 ${formatNumber(klineSummary.resistance)}`
      : '--'
    const source = latestShareSuggestion?.agent_label || latestShareSuggestion?.agent_name || '技术指标'
    const ts = new Date().toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    return { marketLabel, price, chg, action, signal, reason, risks, trigger, invalidation, technicalBrief, levelsBrief, source, ts }
  }, [badge.label, klineSummary, latestShareSuggestion, quote?.change_pct, quote?.current_price, technicalFallbackSuggestion?.reason, technicalScored?.signal])

  const shareText = useMemo(() => {
    const { marketLabel, price, chg, action, signal, reason, risks, trigger, invalidation, technicalBrief, levelsBrief, source, ts } = shareCardPayload
    const lines = [
      `Pan1Watch 洞察】${resolvedName}（${symbol} · ${marketLabel}）`,
      `时间：${ts}`,
      `现价：${price}（${chg}）`,
      `建议：${action}`,
      `信号：${signal}`,
      `理由：${reason}`,
      `风险：${risks}`,
      `技术：${technicalBrief}`,
      `关键位：${levelsBrief}`,
      `来源：${source}`,
    ]
    if (trigger !== '--') lines.splice(7, 0, `触发：${trigger}`)
    if (invalidation !== '--') lines.splice(8, 0, `失效：${invalidation}`)
    return lines.join('\n')
  }, [shareCardPayload, resolvedName, symbol])

  const holdingPnlRate = useMemo(() => {
    if (!holdingAgg || holdingAgg.cost <= 0) return null
    return (holdingAgg.pnl / holdingAgg.cost) * 100
  }, [holdingAgg])

  const shareImageWidth = 1200
  const shareImageHeight = 1680

  const buildShareSvg = useCallback((opts: {
    includePnlRate: boolean
    includePnlAmount: boolean
  }) => {
    const esc = (s: string) => String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
    const trim = (s: string, n = 42) => {
      const x = String(s || '')
      return x.length > n ? `${x.slice(0, n - 1)}…` : x
    }

    const splitLines = (s: string, maxUnits: number, maxLines: number) => {
      const text = String(s || '').replace(/\s+/g, ' ').trim()
      if (!text) return [] as string[]

      const unit = (ch: string) => {
        if (/\s/.test(ch)) return 0.3
        if (/[a-zA-Z0-9.%+\-]/.test(ch)) return 0.56
        if (/[，。；：、！？,.!?:;]/.test(ch)) return 0.45
        return 1
      }

      const lines: string[] = []
      let i = 0
      while (i < text.length && lines.length < maxLines) {
        let width = 0
        let j = i
        let lastBreak = -1
        while (j < text.length) {
          const ch = text[j]
          if (ch === '\n') break
          width += unit(ch)
          if (/[，。；：、！？,.!?:;\s]/.test(ch)) lastBreak = j
          if (width > maxUnits) {
            if (lastBreak >= i) j = lastBreak + 1
            break
          }
          j += 1
        }

        if (j <= i) j = Math.min(i + 1, text.length)
        let line = text.slice(i, j).trim()
        if (!line && i < text.length) {
          line = text.slice(i, Math.min(i + 1, text.length))
          j = i + 1
        }
        lines.push(line)
        i = j
        while (i < text.length && /\s/.test(text[i])) i += 1
      }

      if (i < text.length && lines.length > 0) {
        const last = lines.length - 1
        lines[last] = `${lines[last].slice(0, Math.max(1, lines[last].length - 1))}…`
      }
      return lines
    }

    const actionRaw = String(latestShareSuggestion?.action || '').toLowerCase()
    const actionLabel = latestShareSuggestion?.action_label || latestShareSuggestion?.action || '观望'
    const actionColor = actionRaw === 'avoid' || actionRaw === 'sell'
      ? '#8f6b2f'
      : actionRaw === 'reduce'
        ? '#9b7e42'
        : actionRaw === 'buy' || actionRaw === 'add'
          ? '#2f855a'
          : '#6b7280'
    const actionBg = actionRaw === 'avoid' || actionRaw === 'sell'
      ? '#f6ead1'
      : actionRaw === 'reduce'
        ? '#f6edd9'
        : actionRaw === 'buy' || actionRaw === 'add'
          ? '#e7f6ea'
          : '#eceff3'

    const topLeftIsHolding = opts.includePnlRate && holdingPnlRate != null
    const topRightIsHolding = opts.includePnlAmount && !!holdingAgg
    const bothHoldingTogglesOff = !opts.includePnlRate && !opts.includePnlAmount
    const anyHoldingToggleOn = opts.includePnlRate || opts.includePnlAmount
    const showTechCard = opts.includePnlRate || opts.includePnlAmount
    const changePct = quote?.change_pct ?? 0
    const gainRate = topLeftIsHolding ? holdingPnlRate : changePct
    const gainAmount = topRightIsHolding ? (holdingAgg?.pnl ?? null) : (bothHoldingTogglesOff ? quote?.current_price ?? null : changePct)
    const gainRateColor = gainRate >= 0 ? '#2f855a' : '#b45309'
    const gainAmountColor = bothHoldingTogglesOff
      ? '#2f2a23'
      : (gainAmount != null ? (gainAmount >= 0 ? '#2f855a' : '#b45309') : '#6b7280')
    const leftTitle = topLeftIsHolding ? '当前收益率:' : '当前涨跌:'
    const rightTitle = topRightIsHolding ? '累计收益金额:' : (bothHoldingTogglesOff ? '当前价格:' : '当前涨跌:')
    const rightValue = gainAmount == null
      ? '--'
      : bothHoldingTogglesOff
        ? gainAmount.toFixed(2)
        : `${gainAmount >= 0 ? '+' : ''}${gainAmount.toFixed(2)}${topRightIsHolding ? '' : '%'}`

    const signalLines = splitLines(shareCardPayload.signal || '暂无明显信号，建议等待更清晰结构。', 10.4, 4)
    const reasonLines = splitLines(shareCardPayload.reason || '暂无明确理由，建议结合市场环境复核。', 10.4, 4)
    const riskLines = splitLines(shareCardPayload.risks || '市场波动风险', 10.4, 4)
    const sourceTime = latestShareSuggestion?.created_at
      ? formatClockTime(latestShareSuggestion.created_at)
      : formatClockTime(Date.now())
    const showBottomDetails = true
    const showHolding = false
    const holdingRefLines = showBottomDetails
      ? splitLines(`技术摘要: ${shareCardPayload.technicalBrief} / ${shareCardPayload.levelsBrief}`, 44, 2)
      : []
    const techLeftTitle = anyHoldingToggleOn ? '当前涨跌' : '技术评分'
    const techLeftValue = anyHoldingToggleOn ? changePct : Number(technicalScored?.score ?? 0)
    const techLeftColor = techLeftValue >= 0 ? '#2f855a' : '#b45309'
    const holdingsBaseY = showTechCard ? 1548 : 1454
    const metricsY = holdingsBaseY + holdingRefLines.length * 32 + 20
    const lastRefY = holdingRefLines.length > 0 ? (holdingsBaseY + (holdingRefLines.length - 1) * 32) : holdingsBaseY
    const desiredSourceY = showHolding ? (metricsY + 34) : (lastRefY + 30)
    const sourceY = Math.min(showTechCard ? 1578 : 1546, desiredSourceY)

    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${shareImageWidth}" height="${shareImageHeight}" viewBox="0 0 ${shareImageWidth} ${shareImageHeight}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f3efe7"/>
      <stop offset="100%" stop-color="#e9e3d9"/>
    </linearGradient>
    <linearGradient id="topPanel" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f7faf7"/>
      <stop offset="100%" stop-color="#e9f6ed"/>
    </linearGradient>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.94"/>
      <stop offset="100%" stop-color="#f7f4ee" stop-opacity="0.9"/>
    </linearGradient>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#5e5544" flood-opacity="0.16"/>
    </filter>
    <clipPath id="signalColClip">
      <rect x="114" y="928" width="294" height="382" rx="8"/>
    </clipPath>
    <clipPath id="reasonColClip">
      <rect x="448" y="928" width="294" height="382" rx="8"/>
    </clipPath>
    <clipPath id="riskColClip">
      <rect x="782" y="928" width="294" height="382" rx="8"/>
    </clipPath>
  </defs>
  <rect x="0" y="0" width="1200" height="1680" fill="url(#bg)"/>
  <rect x="64" y="58" width="1072" height="1560" rx="38" fill="url(#glass)" stroke="#d6ccbd" filter="url(#softShadow)"/>

  <text x="94" y="116" fill="#6e6252" font-size="36" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(shareCardPayload.ts)}</text>
  <text x="1106" y="116" fill="#5f5649" font-size="56" text-anchor="end" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">Pan1Watch</text>

  <rect x="94" y="162" width="1012" height="264" rx="30" fill="url(#topPanel)" stroke="#cce4d0"/>
  <line x1="600" y1="198" x2="600" y2="390" stroke="#d7e7db"/>
  <text x="142" y="244" fill="#23201b" font-size="52" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${leftTitle}</text>
  <text x="642" y="244" fill="#23201b" font-size="52" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${rightTitle}</text>
  <text x="142" y="356" fill="${gainRateColor}" font-size="84" font-weight="800" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${gainRate >= 0 ? '+' : ''}${gainRate.toFixed(2)}%</text>
  <text x="642" y="356" fill="${gainAmountColor}" font-size="74" font-weight="800" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${rightValue}</text>

  <rect x="94" y="446" width="676" height="274" rx="30" fill="#fffdfa" stroke="#d9d0c2"/>
  <text x="130" y="520" fill="#1f1c17" font-size="62" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(trim(resolvedName, 12))}</text>
  <text x="130" y="588" fill="#2a251f" font-size="42" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">(${esc(symbol)} · ${esc(shareCardPayload.marketLabel)})</text>
  <text x="130" y="660" fill="#2a251f" font-size="54" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">现价 ${quote?.current_price != null ? quote.current_price.toFixed(2) : '--'} <tspan fill="${(quote?.change_pct || 0) >= 0 ? '#2f855a' : '#b45309'}">(${(quote?.change_pct || 0) >= 0 ? '+' : ''}${quote?.change_pct != null ? quote.change_pct.toFixed(2) : '--'}%)</tspan></text>

  <rect x="790" y="446" width="316" height="274" rx="30" fill="${actionBg}" stroke="#d8ccb3"/>
  <text x="832" y="530" fill="#5a4c37" font-size="54" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">建议</text>
  <text x="850" y="640" fill="${actionColor}" font-size="86" font-weight="800" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(trim(actionLabel, 2))}</text>
  <text x="948" y="700" text-anchor="middle" fill="#6f6658" font-size="24" font-weight="500" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(shareCardPayload.source)} · ${esc(sourceTime)}</text>

  <rect x="94" y="800" width="1012" height="560" rx="30" fill="#fffdf9" stroke="#d9d0c2"/>
  <line x1="430" y1="832" x2="430" y2="1324" stroke="#d8d0c4"/>
  <line x1="764" y1="832" x2="764" y2="1324" stroke="#d8d0c4"/>

  <text x="130" y="898" fill="#221f1a" font-size="64" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">信号</text>
  <text x="464" y="898" fill="#221f1a" font-size="64" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">理由</text>
  <text x="798" y="898" fill="#221f1a" font-size="64" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">风险</text>

  <g clip-path="url(#signalColClip)">
    ${(signalLines.length ? signalLines : ['暂无']).map((line, idx) => `<text x="130" y="${986 + idx * 60}" fill="#2d2923" font-size="28" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(line)}</text>`).join('')}
  </g>
  <g clip-path="url(#reasonColClip)">
    ${(reasonLines.length ? reasonLines : ['暂无']).map((line, idx) => `<text x="464" y="${986 + idx * 60}" fill="#2d2923" font-size="28" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(line)}</text>`).join('')}
  </g>
  <g clip-path="url(#riskColClip)">
    ${(riskLines.length ? riskLines : ['暂无']).map((line, idx) => `<text x="798" y="${986 + idx * 60}" fill="#2d2923" font-size="28" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(line)}</text>`).join('')}
  </g>

  ${showTechCard ? `<rect x="94" y="1392" width="1012" height="116" rx="20" fill="#f3f7f4" stroke="#cfe0d4"/>
  <line x1="600" y1="1410" x2="600" y2="1488" stroke="#d7e5da"/>
  <text x="130" y="1436" fill="#5f5649" font-size="20" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${techLeftTitle}</text>
  <text x="130" y="1478" fill="${techLeftColor}" font-size="32" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${techLeftValue >= 0 ? '+' : ''}${techLeftValue.toFixed(2)}${anyHoldingToggleOn ? '%' : ''}</text>
  <text x="640" y="1436" fill="#5f5649" font-size="20" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">当前价格</text>
  <text x="640" y="1478" fill="#2f2a23" font-size="32" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${quote?.current_price != null ? quote.current_price.toFixed(2) : '--'}</text>` : ''}
  ${showBottomDetails ? (holdingRefLines.length ? holdingRefLines : ['技术摘要: --']).map((line, idx) => `<text x="110" y="${holdingsBaseY + idx * 32}" fill="#7b7163" font-size="20" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(line)}</text>`).join('') : ''}

  ${showHolding ? `<text x="110" y="${metricsY}" fill="#7b7163" font-size="20" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">持仓指标已启用</text>` : ''}
  ${showBottomDetails ? `<text x="110" y="${sourceY}" fill="#918573" font-size="18" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">数据来源：行情接口与 Pan1Watch · 仅供参考，不构成投资建议</text>` : ''}
</svg>`

    return svg
  }, [holdingAgg, holdingPnlRate, latestShareSuggestion?.action, latestShareSuggestion?.action_label, latestShareSuggestion?.created_at, quote?.change_pct, quote?.current_price, resolvedName, shareCardPayload.levelsBrief, shareCardPayload.marketLabel, shareCardPayload.reason, shareCardPayload.risks, shareCardPayload.signal, shareCardPayload.source, shareCardPayload.technicalBrief, symbol, technicalScored?.score, shareImageHeight, shareImageWidth])

  const renderSharePreview = useCallback(async (opts?: {
    includePnlRate: boolean
    includePnlAmount: boolean
  }) => {
    const svg = buildShareSvg(opts || {
      includePnlRate: includeHoldingPnlRate,
      includePnlAmount: includeHoldingPnlAmount,
    })

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = shareImageWidth
      canvas.height = shareImageHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建画布')
      ctx.drawImage(img, 0, 0)
      return canvas.toDataURL('image/png')
    } finally {
      URL.revokeObjectURL(url)
    }
  }, [buildShareSvg, includeHoldingPnlAmount, includeHoldingPnlRate, shareImageHeight, shareImageWidth])

  const handleOpenSharePreview = useCallback(async () => {
    setImageExporting(true)
    try {
      const png = await renderSharePreview()
      setSharePreviewUrl(png)
      setSharePreviewOpen(true)
    } catch {
      toast('图片生成失败，请稍后重试', 'error')
    } finally {
      setImageExporting(false)
    }
  }, [renderSharePreview, toast])

  const handleSaveShareImage = useCallback(() => {
    if (!sharePreviewUrl) return
    const a = document.createElement('a')
    a.href = sharePreviewUrl
    a.download = `Pan1Watch-${symbol}-${Date.now()}.png`
    a.click()
    toast('分享图片已保存', 'success')
  }, [sharePreviewUrl, symbol, toast])

  useEffect(() => {
    if (!sharePreviewOpen) return
    let cancelled = false
    setImageExporting(true)
    renderSharePreview({
      includePnlRate: includeHoldingPnlRate,
      includePnlAmount: includeHoldingPnlAmount,
    })
      .then((png) => {
        if (!cancelled) setSharePreviewUrl(png)
      })
      .catch(() => {
        if (!cancelled) toast('预览图更新失败', 'error')
      })
      .finally(() => {
        if (!cancelled) setImageExporting(false)
      })
    return () => { cancelled = true }
  }, [includeHoldingPnlAmount, includeHoldingPnlRate, renderSharePreview, sharePreviewOpen, toast])

  const copyTextWithFallback = useCallback(async (text: string): Promise<boolean> => {
    if (!text) return false

    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // Fallback to legacy copy below.
      }
    }

    if (typeof document !== 'undefined') {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.setAttribute('readonly', '')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      textarea.style.pointerEvents = 'none'
      textarea.style.left = '-9999px'
      document.body.appendChild(textarea)
      try {
        textarea.focus()
        textarea.select()
        textarea.setSelectionRange(0, textarea.value.length)
        return !!document.execCommand?.('copy')
      } catch {
        return false
      } finally {
        document.body.removeChild(textarea)
      }
    }
    return false
  }, [])

  const handleCopyShareText = useCallback(async () => {
    try {
      const copied = await copyTextWithFallback(shareText)
      if (copied) {
        toast('洞察内容已复制', 'success')
      } else {
        toast('复制失败，请优先使用“图片”分享', 'error')
      }
    } catch {
      toast('复制失败，请优先使用“图片”分享', 'error')
    }
  }, [copyTextWithFallback, shareText, toast])

  const handleShareInsight = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).share) {
        await (navigator as any).share({
          title: `${resolvedName} 洞察`,
          text: shareText,
        })
        return
      }
      const copied = await copyTextWithFallback(shareText)
      if (copied) {
        toast('当前环境不支持系统分享，已自动复制内容', 'success')
      } else {
        toast('当前环境不支持分享且复制失败，请使用“图片”分享', 'error')
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      const copied = await copyTextWithFallback(shareText)
      if (copied) {
        toast('分享失败，已自动复制内容', 'success')
      } else {
        toast('分享失败且复制失败，请使用“图片”分享', 'error')
      }
    }
  }, [copyTextWithFallback, resolvedName, shareText, toast])

  const handleSetAlert = async () => {
    if (!symbol) return
    setAlerting(true)
    try {
      const stocks = await stocksApi.list()
      let stock = (stocks || []).find(s => s.symbol === symbol && s.market === market) || null
      if (!stock) {
        stock = await stocksApi.create({ symbol, name: resolvedName || symbol, market })
      }

      const existingAgents = (stock.agents || []).map(a => ({
        agent_name: a.agent_name,
        schedule: a.schedule || '',
        ai_model_id: a.ai_model_id ?? null,
        notify_channel_ids: a.notify_channel_ids || [],
      }))
      const hasIntraday = existingAgents.some(a => a.agent_name === 'intraday_monitor')
      const nextAgents = hasIntraday
        ? existingAgents
        : [...existingAgents, { agent_name: 'intraday_monitor', schedule: '', ai_model_id: null, notify_channel_ids: [] }]

      await stocksApi.updateAgents(stock.id, { agents: nextAgents })
      await stocksApi.triggerAgent(stock.id, 'intraday_monitor', {
        bypass_throttle: true,
        bypass_market_hours: true,
      })
      toast('已设置提醒，AI 分析已提交', 'success')
      // 轮询等待建议生成（最多 2 分钟，每 5 秒一次）
      const before = Date.now()
      const poll = setInterval(async () => {
        if (Date.now() - before > 120_000) { clearInterval(poll); setAlerting(false); return }
        await loadSuggestions()
      }, 5_000)
      await loadSuggestions()
      // 延迟清理：2 分钟后 interval 自动停止
      setTimeout(() => clearInterval(poll), 125_000)
      return
    } catch (e) {
      toast(e instanceof Error ? e.message : '设置提醒失败', 'error')
    } finally {
      setAlerting(false)
    }
  }

  const toggleWatch = useCallback(async () => {
    if (!symbol) return
    if (watchingStock && hasHolding) {
      toast('该股票存在持仓，请先删除持仓后再取消关注', 'error')
      return
    }

    setWatchToggleLoading(true)
    try {
      if (watchingStock) {
        await stocksApi.remove(watchingStock.id)
        setWatchingStock(null)
        delete stockCacheRef.current[`${market}:${symbol}`]
        toast('已取消关注', 'success')
      } else {
        const created = await stocksApi.create({ symbol, name: resolvedName || symbol, market })
        setWatchingStock(created)
        stockCacheRef.current[`${market}:${symbol}`] = created
        toast('已添加关注', 'success')
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error')
    } finally {
      setWatchToggleLoading(false)
    }
  }, [hasHolding, market, resolvedName, symbol, toast, watchingStock])

  const triggerAutoAiSuggestion = useCallback(async () => {
    // 自动建议仅针对”确认未持仓”的股票，且不自动创建股票/绑定 Agent。
    if (!symbol || !market || !holdingLoaded || holdingLoadError || hasHolding || autoSuggesting) return
    const key = `${market}:${symbol}`
    const lastTs = autoTriggeredRef.current[key] || 0
    if (Date.now() - lastTs < 5 * 60 * 1000) return
    autoTriggeredRef.current[key] = Date.now()
    setAutoSuggesting(true)
    try {
      // intraday_monitor 较 chart_analyst 更轻量、稳定，不依赖截图链路
      await stocksApi.triggerAgent(0, 'intraday_monitor', {
        allow_unbound: true,
        symbol,
        market,
        name: resolvedName || symbol,
        bypass_throttle: true,
        bypass_market_hours: true,
      })
      // 异步模式：triggerAgent 立即返回，轮询等待建议生成
      const before = Date.now()
      const poll = setInterval(async () => {
        if (Date.now() - before > 120_000) { clearInterval(poll); setAutoSuggesting(false); return }
        await loadSuggestions()
      }, 5_000)
      await loadSuggestions()
      setTimeout(() => clearInterval(poll), 125_000)
      return
    } catch (e) {
      toast(
        e instanceof Error ? e.message : '自动 AI 建议触发失败，可点击「一键设提醒」重试',
        'error'
      )
      setAutoSuggesting(false)
    }
  }, [symbol, market, resolvedName, holdingLoaded, holdingLoadError, hasHolding, autoSuggesting, loadSuggestions, toast])

  useEffect(() => {
    if (!props.open || !symbol) return
    const timer = setTimeout(() => {
      triggerAutoAiSuggestion().catch(() => undefined)
    }, 700)
    return () => clearTimeout(timer)
  }, [props.open, symbol, market, triggerAutoAiSuggestion])

  const miniKlineExtrema = useMemo(() => {
    if (!miniKlines.length) return null
    let low = Number.POSITIVE_INFINITY
    let high = Number.NEGATIVE_INFINITY
    for (const k of miniKlines) {
      low = Math.min(low, Number(k.low))
      high = Math.max(high, Number(k.high))
    }
    if (!isFinite(low) || !isFinite(high) || high <= low) return null
    return { low, high }
  }, [miniKlines])

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="w-[92vw] max-w-6xl p-5 md:p-6 overflow-x-hidden">
          <DialogHeader className="mb-3">
            <div className="flex items-start justify-between gap-3 pr-10 md:pr-8">
              <div className="shrink-0">
                <DialogTitle className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] px-2 py-0.5 rounded ${badge.style}`}>{badge.label}</span>
                  <span className="break-all">{resolvedName}</span>
                  <span className="font-mono text-[12px] text-muted-foreground">({symbol})</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{getMarketText(market, symbol, quote?.exchange)}</span>
                </DialogTitle>
              
              </div>
              <div className="hidden md:flex items-center gap-2">
                <Button variant="secondary" size="sm" className="h-8 px-2.5" onClick={() => handleOpenSharePreview()} disabled={imageExporting}>
                  <Download className={`w-3.5 h-3.5 ${imageExporting ? 'animate-pulse' : ''}`} />
                  <span>{imageExporting ? '生成中' : '图片'}</span>
                </Button>
                <Button variant="secondary" size="sm" className="h-8 px-2.5" onClick={() => handleShareInsight()}>
                  <Share2 className="w-3.5 h-3.5" />
                  <span>分享</span>
                </Button>
                <Button variant="secondary" size="sm" className="h-8 px-2.5" onClick={() => handleCopyShareText()}>
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制</span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8 px-2.5"
                  onClick={toggleWatch}
                  disabled={watchToggleLoading || (hasHolding && !!watchingStock)}
                  title={hasHolding && watchingStock ? '持仓中的股票无法取消关注' : undefined}
                >
                  {watchToggleLoading ? '处理中...' : (watchingStock ? (hasHolding ? '持仓中' : '取消关注') : '快速关注')}
                </Button>
                <StockPriceAlertPanel mode="inline" symbol={symbol} market={market} stockName={resolvedName} />
                <Button variant="secondary" size="sm" className="h-8 px-2.5 hidden" onClick={handleSetAlert} disabled={alerting}>
                  {alerting ? '设置中...' : '一键设提醒'}
                </Button>
              </div>
            </div>
            <div className="flex md:hidden items-center gap-2 mt-2 overflow-x-auto scrollbar-none pb-1 -mb-1">
              <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0" onClick={() => handleOpenSharePreview()} disabled={imageExporting}>
                <Download className={`w-3.5 h-3.5 ${imageExporting ? 'animate-pulse' : ''}`} />
              </Button>
              <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0" onClick={() => handleShareInsight()}>
                <Share2 className="w-3.5 h-3.5" />
              </Button>
              <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0" onClick={() => handleCopyShareText()}>
                <Copy className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-2.5 shrink-0"
                onClick={toggleWatch}
                disabled={watchToggleLoading || (hasHolding && !!watchingStock)}
              >
                {watchToggleLoading ? '处理中...' : (watchingStock ? (hasHolding ? '持仓中' : '取消关注') : '快速关注')}
              </Button>
              <StockPriceAlertPanel mode="inline" symbol={symbol} market={market} stockName={resolvedName} />
              <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0 hidden" onClick={handleSetAlert} disabled={alerting}>
                {alerting ? '设置中...' : '一键设提醒'}
              </Button>
            </div>
          </DialogHeader>

          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <div className="flex items-center gap-1 flex-wrap">
              {[
                { id: 'overview', label: '概览' },
                { id: 'suggestions', label: `建议 (${suggestions.length})` },
                { id: 'reports', label: `报告 (${reports.length})` },
                { id: 'kline', label: 'K线' },
                { id: 'announcements', label: `公告 (${announcements.length})` },
                { id: 'news', label: `新闻 (${news.length})` },
              ].map(item => (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id as InsightTab)}
                  className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                    tab === item.id ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {/* 移动端：刷新按钮在最前面 */}
              <button
                onClick={() => handleRefreshAll()}
                disabled={loading}
                className="flex md:hidden w-8 h-8 rounded-xl items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background/70 transition-all disabled:opacity-50 relative"
                title="刷新"
              >
                {autoRefreshEnabled && autoRefreshChanged && !loading && (
                  <svg
                    className="absolute inset-0 -rotate-90 pointer-events-none"
                    width={28}
                    height={28}
                    style={{ margin: 'auto' }}
                  >
                    <circle cx={14} cy={14} r={13} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
                    <circle
                      cx={14} cy={14} r={13} fill="none" stroke="hsl(var(--primary))" strokeOpacity={1} strokeWidth={2} strokeLinecap="round"
                      strokeDasharray={2 * Math.PI * 13}
                      strokeDashoffset={2 * Math.PI * 13 * (1 - autoRefreshProgress)}
                      style={{ transition: 'stroke-dashoffset 0.1s linear' }}
                    />
                  </svg>
                )}
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <Switch
                checked={autoRefreshEnabled}
                onCheckedChange={setAutoRefreshEnabled}
                aria-label="自动刷新"
                className="scale-90"
              />
              <span className="text-[11px] text-muted-foreground">自动刷新</span>
              {autoRefreshEnabled && (
                <Select value={String(autoRefreshSec)} onValueChange={(v) => setAutoRefreshSec(Number(v))}>
                  <SelectTrigger className="h-6 w-14 text-[10px] px-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10秒</SelectItem>
                    <SelectItem value="20">20秒</SelectItem>
                    <SelectItem value="30">30秒</SelectItem>
                    <SelectItem value="60">60秒</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <span className="hidden md:inline-flex h-7 items-center rounded-full border border-border/60 bg-accent/20 px-3 text-[11px] text-muted-foreground">
                更新 {formatClockTime(lastUpdatedAt)}
              </span>
              {/* 桌面端：刷新按钮在最后面 */}
              <button
                onClick={() => handleRefreshAll()}
                disabled={loading}
                className="hidden md:flex w-8 h-8 rounded-xl items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background/70 transition-all disabled:opacity-50 relative"
                title="刷新"
              >
                {autoRefreshEnabled && autoRefreshChanged && !loading && (
                  <svg
                    className="absolute inset-0 -rotate-90 pointer-events-none"
                    width={28}
                    height={28}
                    style={{ margin: 'auto' }}
                  >
                    <circle cx={14} cy={14} r={13} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
                    <circle
                      cx={14} cy={14} r={13} fill="none" stroke="hsl(var(--primary))" strokeOpacity={1} strokeWidth={2} strokeLinecap="round"
                      strokeDasharray={2 * Math.PI * 13}
                      strokeDashoffset={2 * Math.PI * 13 * (1 - autoRefreshProgress)}
                      style={{ transition: 'stroke-dashoffset 0.1s linear' }}
                    />
                  </svg>
                )}
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          <div className="md:hidden mb-3">
            <span className="inline-flex h-7 items-center rounded-full border border-border/60 bg-accent/20 px-3 text-[11px] text-muted-foreground">
              更新 {formatClockTime(lastUpdatedAt)}
            </span>
          </div>

          <div className="max-h-[68vh] overflow-y-auto overflow-x-hidden pr-1 scrollbar">
            {tab === 'overview' && (
              <div className="space-y-3">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
                  <div className="card p-4 h-full">
                    <div className="mt-1 flex items-end justify-between gap-3">
                      <div key={`overview-price-${overviewHighlightKey}`} className={`text-[34px] leading-none font-bold font-mono ${priceColor} ${overviewHighlightClass}`}>
                        {quote?.current_price != null ? formatNumber(quote.current_price) : '--'}
                      </div>
                      <div key={`overview-change-${overviewHighlightKey}`} className={`text-[16px] font-mono ${changeColor} ${overviewHighlightClass}`}>
                        {quote?.change_pct != null ? `${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%` : '--'}
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">今开</div><div className={`font-mono ${levelColor(quote?.open_price)}`}>{formatNumber(quote?.open_price)}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">最高</div><div className={`font-mono ${levelColor(quote?.high_price)}`}>{formatNumber(quote?.high_price)}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">最低</div><div className={`font-mono ${levelColor(quote?.low_price)}`}>{formatNumber(quote?.low_price)}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">成交量</div><div className="font-mono">{formatCompactNumber(quote?.volume)}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">成交额</div><div className="font-mono">{formatCompactNumber(quote?.turnover)}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">振幅</div><div className="font-mono">{amplitudePct != null ? `${amplitudePct.toFixed(2)}%` : '--'}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">换手率</div><div className="font-mono">{quote?.turnover_rate != null ? `${Number(quote.turnover_rate).toFixed(2)}%` : '--'}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">市盈率</div><div className="font-mono">{quote?.pe_ratio != null ? Number(quote.pe_ratio).toFixed(2) : '--'}</div></div>
                      <div className="rounded bg-accent/15 px-2 py-1.5"><div className="text-[10px] text-muted-foreground">总市值</div><div className="font-mono">{formatMarketCap(quote?.total_market_value, market)}</div></div>
                    </div>
                    <div className="mt-3 border-t border-border/50 pt-3">
                      <div className="text-[11px] text-muted-foreground mb-2">持仓信息</div>
                      {holdingAgg ? (
                        <div className="grid grid-cols-2 gap-2 text-[12px]">
                          <div className="rounded bg-emerald-500/10 px-2 py-1.5">
                            <div className="text-[10px] text-muted-foreground">持仓数量</div>
                            <div className="font-mono">{holdingAgg.quantity}</div>
                          </div>
                          <div className="rounded bg-emerald-500/10 px-2 py-1.5">
                            <div className="text-[10px] text-muted-foreground">持仓成本(单价)</div>
                            <div
                              className={`font-mono ${
                                quote?.current_price != null
                                  ? quote.current_price > holdingAgg.unitCost
                                    ? 'text-rose-500'
                                    : quote.current_price < holdingAgg.unitCost
                                      ? 'text-emerald-500'
                                      : 'text-foreground'
                                  : 'text-foreground'
                              }`}
                            >
                              {formatNumber(holdingAgg.unitCost)}
                            </div>
                          </div>
                          <div className="rounded bg-emerald-500/10 px-2 py-1.5">
                            <div className="text-[10px] text-muted-foreground">持仓市值</div>
                            <div className="font-mono">{formatCompactNumber(holdingAgg.marketValue)}</div>
                          </div>
                          <div className="rounded bg-emerald-500/10 px-2 py-1.5">
                            <div className="text-[10px] text-muted-foreground">总盈亏</div>
                            <div className={`font-mono ${holdingAgg.pnl >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                              {holdingAgg.pnl >= 0 ? '+' : ''}{formatCompactNumber(holdingAgg.pnl)}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted-foreground">未在持仓中</div>
                      )}
                    </div>
                  </div>

                  <div className="card p-4 h-full">
                    <div className="text-[12px] text-muted-foreground mb-2">迷你K线</div>
                    {!klineSummary ? (
                      <div className="text-[12px] text-muted-foreground py-8">暂无K线摘要</div>
                    ) : (
                      <>
                        {miniKlineLoading ? (
                          <div className="h-32 rounded bg-accent/30 animate-pulse" />
                        ) : miniKlines.length > 0 && miniKlineExtrema ? (
                          <svg
                            viewBox="0 0 320 120"
                            className="w-full h-32 cursor-pointer"
                            onClick={() => setTab('kline')}
                            onMouseLeave={() => setMiniHoverIdx(null)}
                            onMouseMove={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect()
                              const x = e.clientX - rect.left
                              const ratio = rect.width > 0 ? x / rect.width : 0
                              const idx = Math.floor(ratio * miniKlines.length)
                              setMiniHoverIdx(Math.max(0, Math.min(miniKlines.length - 1, idx)))
                            }}
                          >
                            <title>点击进入交互式K线</title>
                            {miniKlines.map((k, idx) => {
                              const xStep = 320 / miniKlines.length
                              const x = xStep * idx + xStep / 2
                              const bodyW = Math.max(2, xStep * 0.5)
                              const toY = (v: number) => 114 - ((v - miniKlineExtrema.low) / (miniKlineExtrema.high - miniKlineExtrema.low)) * 100
                              const yOpen = toY(Number(k.open))
                              const yClose = toY(Number(k.close))
                              const yHigh = toY(Number(k.high))
                              const yLow = toY(Number(k.low))
                              const up = Number(k.close) >= Number(k.open)
                              const color = up ? '#ef4444' : '#10b981'
                              const bodyTop = Math.min(yOpen, yClose)
                              const bodyH = Math.max(1.4, Math.abs(yOpen - yClose))
                              const active = miniHoverIdx === idx
                              return (
                                <g key={`${k.date}-${idx}`}>
                                  {active && <rect x={x - xStep / 2} y={6} width={xStep} height={108} fill="rgba(59,130,246,0.10)" />}
                                  <line x1={x} y1={yHigh} x2={x} y2={yLow} stroke={color} strokeWidth="1" />
                                  <rect x={x - bodyW / 2} y={bodyTop} width={bodyW} height={bodyH} fill={color} rx="0.6" />
                                </g>
                              )
                            })}
                          </svg>
                        ) : (
                          <div className="h-32 text-[11px] text-muted-foreground flex items-center justify-center">暂无迷你K线</div>
                        )}
                        <div className="mt-2 rounded bg-accent/10 p-2.5">
                          <TechnicalIndicatorStrip
                            klineSummary={klineSummary}
                            technicalSuggestion={technicalFallbackSuggestion}
                            stockName={resolvedName}
                            stockSymbol={symbol}
                            market={market}
                            hasPosition={!!props.hasPosition}
                            score={Number(technicalScored?.score ?? 0)}
                            evidence={technicalScored?.evidence || []}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-stretch">
                  <div className="card p-4 h-full flex flex-col">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[12px] text-muted-foreground">AI建议</div>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => setTab('suggestions')}>
                        更多
                      </Button>
                      {autoSuggesting && suggestions.length > 0 && (
                        <div className="text-[10px] text-primary">更新中...</div>
                      )}
                    </div>
                    {suggestions.length > 0 ? (
                      <div className="space-y-2">
                        <SuggestionBadge
                          suggestion={suggestions[0]}
                          stockName={resolvedName}
                          stockSymbol={symbol}
                          market={market}
                          hasPosition={!!props.hasPosition}
                          showTechnicalCompanion={false}
                        />
                        <div className="rounded bg-accent/10 p-2 text-[11px]">
                          <div className="text-muted-foreground">核心判断</div>
                          <div className="mt-1 text-foreground line-clamp-2">{suggestions[0].signal || suggestions[0].reason || '暂无说明'}</div>
                          <div className="mt-1 text-muted-foreground">动作: {suggestions[0].action_label || suggestions[0].action || '--'}</div>
                          <div className="mt-1 text-foreground line-clamp-2">依据: {suggestions[0].reason || '暂无补充依据'}</div>
                          <div className="mt-1 text-muted-foreground">
                            来源: {suggestions[0].agent_label || suggestions[0].agent_name || 'AI'}{suggestions[0].created_at ? ` · ${formatTime(suggestions[0].created_at)}` : ''}
                          </div>
                        </div>
                        {suggestions.length > 1 && (
                          <div className="rounded bg-accent/10 p-2 text-[11px]">
                            <div className="text-muted-foreground mb-1">近期补充建议</div>
                            {suggestions.slice(1, 3).map((item, idx) => (
                              <div key={`${item.created_at || 'extra'}-${idx}`} className="line-clamp-1 text-foreground">
                                {item.action_label || item.action} · {item.signal || item.reason || '--'}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="text-[10px] text-primary min-h-[14px]">{autoSuggesting && suggestions.length === 0 ? '正在自动生成 AI 建议...' : ''}</div>
                      </div>
                    ) : (
                      <div className="text-[12px] text-muted-foreground py-6">
                        {autoSuggesting ? '正在自动生成 AI 建议（通常 5-15 秒）...' : '暂无 AI 建议'}
                      </div>
                    )}
                  </div>

                  <div className="card p-4 h-full flex flex-col">
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[12px] text-muted-foreground">新闻</div>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => setTab('news')}>
                        更多
                      </Button>
                    </div>
                    <div className="flex-1 space-y-2">
                      {news.length === 0 ? (
                        <div className="text-[12px] text-muted-foreground py-6">暂无相关新闻</div>
                      ) : (
                        news.slice(0, 3).map((item, idx) => (
                          <a
                            key={`${item.publish_time || 'n'}-${idx}`}
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            className="block rounded-lg border border-border/30 bg-accent/10 p-2.5 hover:bg-accent/20 transition-colors"
                          >
                            <div className="text-[12px] text-foreground line-clamp-2">{item.title}</div>
                            <div className="mt-1 text-[10px] text-muted-foreground">{item.source_label || item.source} · {formatTime(item.publish_time)}</div>
                          </a>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="card p-4 h-full flex flex-col">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <div className="text-[12px] text-muted-foreground">AI报告</div>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-muted-foreground" onClick={() => setTab('reports')}>
                        更多
                      </Button>
                    </div>
                    {!latestReport ? (
                      <div className="text-[12px] text-muted-foreground py-3">暂无报告</div>
                    ) : (
                      <div className="rounded-lg border border-border/30 bg-accent/10 p-2.5">
                        <div className="text-[11px] text-muted-foreground">
                          {AGENT_LABELS[latestReport.agent_name] || latestReport.agent_name} · {latestReport.analysis_date}
                        </div>
                        <div className="mt-1 text-[13px] font-medium line-clamp-1">{latestReport.title || '报告摘要'}</div>
                        <div className="mt-1 text-[12px] text-foreground/90 line-clamp-3">
                          {markdownToPlainText(latestReport.content) || '暂无报告内容'}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {tab === 'kline' && (
              <InteractiveKline
                symbol={symbol}
                market={market}
                initialInterval={klineInterval}
                hideRefreshButton
                refreshTrigger={klineRefreshTrigger}
              />
            )}

            {tab === 'reports' && (
              <div className="space-y-3">
                <div className="card p-3">
                  <div className="flex items-center gap-1">
                    {([
                      { key: 'premarket_outlook', label: `盘前 (${reportCounts.premarket_outlook})` },
                      { key: 'daily_report', label: `盘后 (${reportCounts.daily_report})` },
                    ] as const).map(item => (
                      <button
                        key={item.key}
                        onClick={() => setReportTab(item.key)}
                        className={`text-[11px] px-2.5 py-1 rounded ${
                          reportTab === item.key ? 'bg-primary text-primary-foreground' : 'bg-accent/60 text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
                {!activeReport ? (
                  <div className="card p-6 text-[12px] text-muted-foreground text-center">暂无报告</div>
                ) : (
                  <div className="card p-4 space-y-3">
                    <div className="text-[11px] text-muted-foreground">
                      {AGENT_LABELS[activeReport.agent_name] || activeReport.agent_name} · {activeReport.analysis_date}
                    </div>
                    <div className="text-[15px] font-medium">{activeReport.title || '报告摘要'}</div>
                    {activeReport.suggestions && (activeReport.suggestions as any)?.[symbol]?.action_label && (
                      <div className="text-[11px] inline-flex px-2 py-0.5 rounded bg-primary/10 text-primary">
                        {(activeReport.suggestions as any)[symbol].action_label}
                      </div>
                    )}
                    <div className="rounded-lg bg-accent/10 p-3">
                      <div className="prose prose-sm dark:prose-invert max-w-none text-foreground/90 break-words">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeReport.content || '暂无报告内容'}</ReactMarkdown>
                      </div>
                    </div>
                    {(activeReport.prompt_context || activeReport.context_payload || activeReport.news_debug) && (
                      <details className="rounded-lg border border-border/40 bg-accent/10 p-3">
                        <summary className="cursor-pointer text-[12px] text-muted-foreground select-none">查看分析上下文</summary>
                        {activeReport.prompt_stats ? (
                          <div className="mt-2">
                            <div className="text-[11px] text-muted-foreground mb-1">Prompt统计</div>
                            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">{JSON.stringify(activeReport.prompt_stats, null, 2)}</pre>
                          </div>
                        ) : null}
                        {activeReport.news_debug ? (
                          <div className="mt-2">
                            <div className="text-[11px] text-muted-foreground mb-1">新闻注入明细</div>
                            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto">{JSON.stringify(activeReport.news_debug, null, 2)}</pre>
                          </div>
                        ) : null}
                        {activeReport.context_payload ? (
                          <div className="mt-2">
                            <div className="text-[11px] text-muted-foreground mb-1">上下文快照</div>
                            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto max-h-[220px] overflow-y-auto">{JSON.stringify(activeReport.context_payload, null, 2)}</pre>
                          </div>
                        ) : null}
                        {activeReport.prompt_context ? (
                          <div className="mt-2">
                            <div className="text-[11px] text-muted-foreground mb-1">Prompt原文</div>
                            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words overflow-x-auto max-h-[220px] overflow-y-auto">{activeReport.prompt_context}</pre>
                          </div>
                        ) : null}
                      </details>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === 'suggestions' && (
              <div className="space-y-3">
                <div className="card p-3 flex items-center justify-between gap-3">
                  <div className="text-[12px] text-muted-foreground">显示过期建议</div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">{includeExpiredSuggestions ? '包含过期' : '仅有效'}</span>
                    <Switch
                      checked={includeExpiredSuggestions}
                      onCheckedChange={setIncludeExpiredSuggestions}
                      aria-label="显示过期建议"
                    />
                  </div>
                </div>
                {suggestions.length === 0 ? (
                  technicalFallbackSuggestion ? (
                    <div className="card p-4">
                      <SuggestionBadge suggestion={technicalFallbackSuggestion} stockName={resolvedName} stockSymbol={symbol} kline={klineSummary} hasPosition={!!props.hasPosition} />
                      <div className="mt-2 text-[10px] text-muted-foreground">
                        {autoSuggesting ? '正在自动生成 AI 建议（通常 5-15 秒）...' : '当前显示技术指标基础建议'}
                      </div>
                    </div>
                  ) : (
                    <div className="card p-6 text-[12px] text-muted-foreground text-center">
                      {autoSuggesting ? '正在自动生成 AI 建议（通常 5-15 秒）...' : '暂无建议'}
                    </div>
                  )
                ) : (
                  <div className="max-h-[56vh] overflow-y-auto pr-1 scrollbar space-y-3">
                    {suggestions.map((item, idx) => (
                      <div key={`${item.created_at || 's'}-${idx}`} className="card p-4">
                        <SuggestionBadge suggestion={item} stockName={resolvedName} stockSymbol={symbol} kline={klineSummary} hasPosition={!!props.hasPosition} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'news' && (
              <div className="space-y-3">
                <div className="flex items-center justify-end">
                  <Select value={newsHours} onValueChange={setNewsHours}>
                    <SelectTrigger className="h-8 w-[110px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="6">近6小时</SelectItem>
                      <SelectItem value="12">近12小时</SelectItem>
                      <SelectItem value="24">近24小时</SelectItem>
                      <SelectItem value="48">近48小时</SelectItem>
                      <SelectItem value="168">近7天</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {news.length === 0 ? (
                  <div className="card p-6 text-[12px] text-muted-foreground text-center">暂无相关新闻</div>
                ) : (
                  news.map((item, idx) => (
                    <a
                      key={`${item.publish_time || 'n'}-${idx}`}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="card block p-4 hover:bg-accent/20 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[13px] font-medium text-foreground line-clamp-2">{item.title}</div>
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      </div>
                      <div className="mt-2 text-[11px] text-muted-foreground">{item.source_label || item.source} · {formatTime(item.publish_time)}</div>
                    </a>
                  ))
                )}
              </div>
            )}

            {tab === 'announcements' && (
              <div className="space-y-3">
                <div className="flex items-center justify-end">
                  <Select value={announcementHours} onValueChange={setAnnouncementHours}>
                    <SelectTrigger className="h-8 w-[110px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="168">近7天</SelectItem>
                      <SelectItem value="336">近14天</SelectItem>
                      <SelectItem value="720">近30天</SelectItem>
                      <SelectItem value="2160">近90天</SelectItem>
                      <SelectItem value="4320">近180天</SelectItem>
                      <SelectItem value="24">近24小时</SelectItem>
                      <SelectItem value="48">近48小时</SelectItem>
                      <SelectItem value="72">近72小时</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {announcements.length === 0 ? (
                  <div className="card p-6 text-[12px] text-muted-foreground text-center">暂无公告</div>
                ) : (
                  announcements.map((item, idx) => (
                    <a
                      key={`${item.publish_time || 'a'}-${idx}`}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="card block p-4 hover:bg-accent/20 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[13px] font-medium text-foreground line-clamp-2">{item.title}</div>
                        <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      </div>
                      <div className="mt-2 text-[11px] text-muted-foreground">{item.source_label || item.source} · {formatTime(item.publish_time)}</div>
                    </a>
                  ))
                )}
              </div>
            )}

          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sharePreviewOpen} onOpenChange={setSharePreviewOpen}>
        <DialogContent className="w-[94vw] max-w-5xl h-[94vh] p-4 md:p-5 overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">分享图片预览</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 flex-1 min-h-0 flex flex-col">
            {!!holdingAgg && (
              <div className="card p-3 flex items-center gap-4 flex-wrap">
                <div className="text-[12px] text-muted-foreground">持仓指标</div>
                <div className="flex items-center gap-2">
                  <Switch checked={includeHoldingPnlRate} onCheckedChange={setIncludeHoldingPnlRate} />
                  <span className="text-[12px]">收益率</span>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={includeHoldingPnlAmount} onCheckedChange={setIncludeHoldingPnlAmount} />
                  <span className="text-[12px]">收益金额</span>
                </div>
              </div>
            )}

            <div className="rounded-xl border border-border/60 bg-muted/20 p-2 flex-1 min-h-0 overflow-hidden h-[52vh] md:h-[calc(94vh-220px)]">
              {sharePreviewUrl ? (
                <div className="w-full h-full flex items-center justify-center">
                  <img src={sharePreviewUrl} alt="分享图预览" className="max-w-full max-h-full w-auto h-full rounded-lg object-contain" />
                </div>
              ) : (
                <div className="h-[220px] flex items-center justify-center text-[12px] text-muted-foreground">预览图生成中...</div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setSharePreviewOpen(false)}>取消</Button>
              <Button onClick={handleSaveShareImage} disabled={!sharePreviewUrl || imageExporting}>
                {imageExporting ? '生成中...' : '保存图片'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </>
  )
}
