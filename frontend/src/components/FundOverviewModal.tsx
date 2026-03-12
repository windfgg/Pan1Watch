import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { TrendingUp, TrendingDown, RefreshCw, Share2, Copy, Download, ExternalLink, Bell } from 'lucide-react'
import { fetchAPI, insightApi, stocksApi } from '@panwatch/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Skeleton } from '@panwatch/base-ui/components/ui/skeleton'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import { Switch } from '@panwatch/base-ui/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { getMarketBadge, getFundType } from '@panwatch/biz-ui'
import { SuggestionBadge, type SuggestionInfo } from '@panwatch/biz-ui/components/suggestion-badge'
import StockPriceAlertPanel from '@panwatch/biz-ui/components/stock-price-alert-panel'
import InteractiveFundChart from '@panwatch/biz-ui/components/InteractiveFundChart'

interface HoldingItem {
  code: string
  name: string
  weight: number | null
  weight_text?: string
  change_pct: number | null
}

interface PerfPoint {
  ts: number
  value: number
  return_pct: number | null
}

interface FundOverview {
  fund_code: string
  top_holdings: HoldingItem[]
  performance: {
    points: PerfPoint[]
    since_return_pct: number | null
  }
  updated_at: number
}

interface NewsItem {
  source: string
  source_label: string
  external_id?: string
  title: string
  content?: string
  publish_time: string
  symbols?: string[]
  importance?: number
  url: string
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

interface HistoryRecord {
  id: number
  agent_name: string
  stock_symbol: string
  analysis_date: string
  title: string
  content: string
  suggestions?: Record<string, any> | null
  news?: Array<{ source?: string; title?: string; publish_time?: string; url?: string }> | null
  prompt_stats?: Record<string, any> | null
  created_at: string
  updated_at?: string
}

interface StockItem {
  id: number
  symbol: string
  name: string
  market: string
}

interface FundQuote {
  symbol: string
  market: string
  current_price: number | null  // 估值净值
  change_pct: number | null      // 估值涨幅
  prev_close: number | null      // 单位净值（昨日）
  gztime: string | null          // 估值时间
  jzrq: string | null            // 净值日期
}

type TimeRange = '1m' | '3m' | '6m' | '1y' | '3y' | 'all'
type FundTab = 'overview' | 'performance' | 'suggestions' | 'reports' | 'announcements' | 'news'
type ReportTab = 'fund_holding_analyst' | 'news_digest'

const AGENT_LABELS: Record<string, string> = {
  fund_holding_analyst: '基金周报',
  news_digest: '新闻速递',
}

function parseToMs(input?: string): number | null {
  if (!input) return null
  const d = new Date(input)
  if (!isNaN(d.getTime())) return d.getTime()
  return null
}

function normalizeSuggestionAction(action?: string, label?: string): string {
  const a = String(action || '').toLowerCase().trim()
  if (['buy', 'add', '买入', '加仓', '建仓'].some(k => a.includes(k) || (label || '').includes(k))) return 'buy'
  if (['sell', 'reduce', '卖出', '减仓', '清仓'].some(k => a.includes(k) || (label || '').includes(k))) return 'sell'
  if (['hold', '持有', '观望'].some(k => a.includes(k) || (label || '').includes(k))) return 'hold'
  return 'hold'
}

function pickSuggestionText(raw: unknown, key: string): string {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) return String((raw as any)[key] || '') || JSON.stringify(raw)
  return ''
}

const RANGE_TO_DAYS: Record<TimeRange, number | null> = {
  '1m': 30,
  '3m': 90,
  '6m': 180,
  '1y': 365,
  '3y': 365 * 3,
  all: null,
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

function formatCompactNumber(value: number | null | undefined): string {
  if (value == null) return '--'
  const n = Number(value)
  if (!isFinite(n)) return '--'
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万`
  return n.toFixed(2)
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text)
  }
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  area.style.left = '-9999px'
  document.body.appendChild(area)
  area.select()
  document.execCommand('copy')
  document.body.removeChild(area)
  return Promise.resolve()
}

function buildPath(points: PerfPoint[], width: number, height: number, padding: number): string {
  if (!points.length) return ''
  const values = points.map(p => Number(p.return_pct ?? 0))
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1

  return points
    .map((p, idx) => {
      const x = padding + (idx / Math.max(points.length - 1, 1)) * (width - padding * 2)
      const y = height - padding - ((Number(p.return_pct ?? 0) - min) / span) * (height - padding * 2)
      return `${idx === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

function buildAreaPath(linePath: string, points: PerfPoint[], width: number, height: number, padding: number): string {
  if (!linePath || !points.length) return ''
  const lastX = padding + (width - padding * 2)
  const firstX = padding
  const baselineY = height - padding
  return `${linePath} L ${lastX.toFixed(2)} ${baselineY.toFixed(2)} L ${firstX.toFixed(2)} ${baselineY.toFixed(2)} Z`
}

export default function FundOverviewModal({
  open,
  onOpenChange,
  fundCode,
  fundName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fundCode: string
  fundName?: string
}) {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<FundTab>('overview')
  const [range, setRange] = useState<TimeRange>('all')
  const [data, setData] = useState<FundOverview | null>(null)
  const [error, setError] = useState<string>('')
  const [newsHours, setNewsHours] = useState<string>('168')
  const [announcementHours, setAnnouncementHours] = useState<string>('168')
  const [newsLoading, setNewsLoading] = useState(false)
  const [news, setNews] = useState<NewsItem[]>([])
  const [announcements, setAnnouncements] = useState<NewsItem[]>([])
  const [suggestions, setSuggestions] = useState<SuggestionInfo[]>([])
  const [reports, setReports] = useState<HistoryRecord[]>([])
  const [reportTab, setReportTab] = useState<ReportTab>('fund_holding_analyst')
  const [includeExpiredSuggestions, setIncludeExpiredSuggestions] = useState(false)
  const [watchingStock, setWatchingStock] = useState<StockItem | null>(null)
  const [watchToggleLoading, setWatchToggleLoading] = useState(false)
  const [alerting, setAlerting] = useState(false)
  const stockCacheRef = useRef<Record<string, StockItem>>({})
  const [autoSuggesting] = useState(false)
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true)
  const [autoRefreshSec, setAutoRefreshSec] = useState<number>(60)
  const [autoRefreshProgress, setAutoRefreshProgress] = useState(0)
  const [holdingAgg, setHoldingAgg] = useState<{
    quantity: number
    cost: number
    unitCost: number
    marketValue: number
    pnl: number
    currentPrice: number | null
  } | null>(null)
  const [holdingLoaded, setHoldingLoaded] = useState(false)
  const [imageExporting, setImageExporting] = useState(false)
  const [fundQuote, setFundQuote] = useState<FundQuote | null>(null)

  const miniChartWidth = 320
  const miniChartHeight = 140
  const miniChartPadding = 20

  const badge = getMarketBadge('FUND')
  const resolvedName = fundName || fundCode

  const load = useCallback(async () => {
    if (!fundCode) return
    setLoading(true)
    setError('')
    try {
      const resp = await fetchAPI<FundOverview>(`/stocks/funds/${encodeURIComponent(fundCode)}/overview`)
      setData(resp)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载基金详情失败')
    } finally {
      setLoading(false)
    }
  }, [fundCode])

  // 加载基金实时行情（估值净值、估值涨幅等）
  const loadQuote = useCallback(async () => {
    if (!fundCode) return
    try {
      const resp = await fetchAPI<FundQuote>(`/quotes/${encodeURIComponent(fundCode)}?market=FUND`)
      setFundQuote(resp)
    } catch {
      setFundQuote(null)
    }
  }, [fundCode])

  const loadHolding = useCallback(async () => {
    if (!fundCode) return
    setHoldingLoaded(false)
    try {
      const resp = await fetchAPI<PortfolioSummaryResponse>('/portfolio/summary?include_quotes=true')
      let quantity = 0
      let cost = 0
      let marketValue = 0
      let pnl = 0
      let currentPrice: number | null = null
      for (const acc of resp?.accounts || []) {
        for (const p of acc.positions || []) {
          if (p.symbol !== fundCode || p.market !== 'FUND') continue
          quantity += Number(p.quantity || 0)
          cost += Number(p.cost_price || 0) * Number(p.quantity || 0)
          marketValue += Number(p.market_value_cny || 0)
          pnl += Number(p.pnl || 0)
        }
      }
      if (quantity > 0) {
        // Try to compute current price from market value
        currentPrice = marketValue / quantity
        setHoldingAgg({ quantity, cost, unitCost: cost / quantity, marketValue, pnl, currentPrice })
      } else {
        setHoldingAgg(null)
      }
    } catch {
      setHoldingAgg(null)
    } finally {
      setHoldingLoaded(true)
    }
  }, [fundCode])

  useEffect(() => {
    if (!open || !fundCode) return
    setTab('overview')
    setRange('all')
    load()
    loadHolding()
    loadQuote()
  }, [open, fundCode, load, loadHolding, loadQuote])

  const loadNews = useCallback(async () => {
    if (!fundName && !fundCode) return
    setNewsLoading(true)
    try {
      const params = new URLSearchParams({ hours: newsHours, limit: '20' })
      params.set('names', fundName || fundCode)
      const rows = await fetchAPI<NewsItem[]>(`/news?${params.toString()}`)
      setNews(rows || [])
    } catch {
      setNews([])
    } finally {
      setNewsLoading(false)
    }
  }, [fundCode, fundName, newsHours])

  const loadAnnouncements = useCallback(async () => {
    if (!fundName && !fundCode) return
    try {
      const params = new URLSearchParams({ hours: announcementHours, limit: '50', source: 'eastmoney' })
      params.set('names', fundName || fundCode)
      const rows = await fetchAPI<NewsItem[]>(`/news?${params.toString()}`)
      setAnnouncements(rows || [])
    } catch {
      setAnnouncements([])
    }
  }, [fundCode, fundName, announcementHours])

  const loadSuggestions = useCallback(async () => {
    if (!fundCode) return
    try {
      const data = await insightApi.suggestions<any[]>(fundCode, {
        market: 'FUND',
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
      setSuggestions(list)
    } catch {
      setSuggestions([])
    }
  }, [fundCode, includeExpiredSuggestions])

  const loadReports = useCallback(async () => {
    if (!fundCode) return
    try {
      // 优先使用基金专属Agent，其次是通用Agent
      const agents = ['fund_holding_analyst', 'premarket_outlook', 'daily_report', 'news_digest']
      const bySymbolResults = await Promise.all(
        agents.map(agent =>
          insightApi.history<HistoryRecord[]>({
            agent_name: agent,
            stock_symbol: fundCode,
            limit: 1,
          }).catch(() => [])
        )
      )
      let merged = bySymbolResults.flatMap(items => items || []).filter(Boolean)
      // 如果按代码没找到，尝试从全局记录中按名称筛选
      if (merged.length === 0 && fundName) {
        const globalResults = await Promise.all(
          agents.map(agent =>
            insightApi.history<HistoryRecord[]>({
              agent_name: agent,
              stock_symbol: '*',
              limit: 20,
            }).catch(() => [])
          )
        )
        merged = globalResults
          .map(items => {
            const rows = (items || []).filter(Boolean)
            const hit = rows.find((r) => {
              const text = `${r?.title || ''}\n${r?.content || ''}`
              if (text.includes(fundCode) || text.includes(fundName || '')) return true
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
      setReports(merged)
    } catch {
      setReports([])
    }
  }, [fundCode, fundName])

  useEffect(() => {
    if (!open || tab !== 'news') return
    loadNews()
  }, [open, tab, loadNews])

  useEffect(() => {
    if (!open || tab !== 'announcements') return
    loadAnnouncements()
  }, [open, tab, loadAnnouncements])

  useEffect(() => {
    if (!open || !fundCode) return
    loadSuggestions().catch(() => setSuggestions([]))
  }, [open, fundCode, includeExpiredSuggestions, loadSuggestions])

  useEffect(() => {
    if (!open || !fundCode) return
    loadReports().catch(() => setReports([]))
  }, [open, fundCode, loadReports])

  // Load watched stock status
  useEffect(() => {
    if (!open || !fundCode) return
    let cancelled = false
    ;(async () => {
      try {
        const key = `FUND:${fundCode}`
        const stocks = await stocksApi.list()
        if (cancelled) return
        const found = (stocks || []).find(s => s.symbol === fundCode && s.market === 'FUND') || null
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
  }, [open, fundCode])

  // Auto refresh
  useEffect(() => {
    if (!open || !fundCode || !autoRefreshEnabled) {
      setAutoRefreshProgress(0)
      return
    }
    const sec = Number(autoRefreshSec) > 0 ? Number(autoRefreshSec) : 60
    const ms = Math.max(10, sec) * 1000
    const startTime = Date.now()
    // 刷新定时器
    const refreshTimer = setInterval(() => {
      load().catch(() => undefined)
      loadHolding().catch(() => undefined)
      loadQuote().catch(() => undefined)
      if (tab === 'suggestions') loadSuggestions().catch(() => undefined)
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
  }, [open, fundCode, autoRefreshEnabled, autoRefreshSec, load, loadHolding, loadQuote, loadSuggestions, tab])

  const allPoints = useMemo(() => data?.performance?.points || [], [data])

  const filteredPoints = useMemo(() => {
    const points = allPoints
    if (!points.length) return []
    const days = RANGE_TO_DAYS[range]
    if (!days) return points
    const endTs = points[points.length - 1].ts
    const startTs = endTs - days * 24 * 60 * 60 * 1000
    const selected = points.filter(p => p.ts >= startTs)
    return selected.length >= 2 ? selected : points
  }, [allPoints, range])

  const normalizedPoints = useMemo(() => {
    if (!filteredPoints.length) return []
    const base = Number(filteredPoints[0].value || 0)
    if (!base) return filteredPoints.map(p => ({ ...p, return_pct: 0 }))
    return filteredPoints.map(p => ({
      ...p,
      return_pct: ((Number(p.value) / base) - 1) * 100,
    }))
  }, [filteredPoints])

  // Mini chart uses all-time data
  const miniNormalizedPoints = useMemo(() => {
    if (!allPoints.length) return []
    const base = Number(allPoints[0].value || 0)
    if (!base) return allPoints.map(p => ({ ...p, return_pct: 0 }))
    return allPoints.map(p => ({
      ...p,
      return_pct: ((Number(p.value) / base) - 1) * 100,
    }))
  }, [allPoints])

  const miniChartPath = useMemo(() => buildPath(miniNormalizedPoints, miniChartWidth, miniChartHeight, miniChartPadding), [miniNormalizedPoints])
  const miniAreaPath = useMemo(() => buildAreaPath(miniChartPath, miniNormalizedPoints, miniChartWidth, miniChartHeight, miniChartPadding), [miniChartPath, miniNormalizedPoints])

  const rangeReturn = useMemo(() => {
    if (normalizedPoints.length < 2) return 0
    return Number(normalizedPoints[normalizedPoints.length - 1].return_pct || 0)
  }, [normalizedPoints])

  const sinceReturn = data?.performance?.since_return_pct ?? 0
  const positive = sinceReturn >= 0

  // Latest NAV from performance data
  const latestNav = useMemo(() => {
    if (!allPoints.length) return null
    return Number(allPoints[allPoints.length - 1].value || 0)
  }, [allPoints])

  const hasHolding = !!holdingAgg

  const reportMap = useMemo(() => {
    const out: Record<string, HistoryRecord | null> = {
      premarket_outlook: null,
      daily_report: null,
      news_digest: null,
    }
    for (const r of reports) {
      if (!out[r.agent_name]) out[r.agent_name] = r
    }
    return out
  }, [reports])
  const activeReport = reportMap[reportTab]

  const handleRefreshAll = async () => {
    await Promise.allSettled([
      load(),
      loadHolding(),
      loadSuggestions(),
      loadReports(),
      tab === 'news' ? loadNews() : Promise.resolve(),
      tab === 'announcements' ? loadAnnouncements() : Promise.resolve(),
    ])
  }

  const toggleWatch = useCallback(async () => {
    if (!fundCode) return
    if (watchingStock && hasHolding) {
      toast('该基金存在持仓，请先删除持仓后再取消关注', 'error')
      return
    }
    setWatchToggleLoading(true)
    try {
      if (watchingStock) {
        await stocksApi.remove(watchingStock.id)
        setWatchingStock(null)
        delete stockCacheRef.current[`FUND:${fundCode}`]
        toast('已取消关注', 'success')
      } else {
        const created = await stocksApi.create({ symbol: fundCode, name: resolvedName || fundCode, market: 'FUND' })
        setWatchingStock(created)
        stockCacheRef.current[`FUND:${fundCode}`] = created
        toast('已添加关注', 'success')
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : '操作失败', 'error')
    } finally {
      setWatchToggleLoading(false)
    }
  }, [hasHolding, fundCode, resolvedName, toast, watchingStock])

  const handleSetAlert = async () => {
    if (!fundCode || !watchingStock) {
      toast('请先关注该基金再设置提醒', 'error')
      return
    }
    setAlerting(true)
    try {
      await stocksApi.triggerAgent(watchingStock.id, 'intraday_monitor', {
        allow_unbound: true,
        symbol: fundCode,
        market: 'FUND',
        name: resolvedName || fundCode,
        bypass_throttle: true,
        bypass_market_hours: true,
      })
      toast('已触发建议生成，稍后刷新查看', 'success')
      const before = Date.now()
      const poll = setInterval(async () => {
        if (Date.now() - before > 120_000) { clearInterval(poll); setAlerting(false); return }
        await loadSuggestions()
      }, 5_000)
      await loadSuggestions()
      setTimeout(() => clearInterval(poll), 125_000)
      return
    } catch (e) {
      toast(e instanceof Error ? e.message : '设置提醒失败', 'error')
    } finally {
      setAlerting(false)
    }
  }

  const handleShare = async () => {
    const shareText = `${resolvedName}（${fundCode}）基金详情\n成立来涨跌 ${sinceReturn >= 0 ? '+' : ''}${sinceReturn.toFixed(2)}%\n区间涨跌 ${rangeReturn >= 0 ? '+' : ''}${rangeReturn.toFixed(2)}%`
    try {
      if (navigator.share) {
        await navigator.share({ title: `${resolvedName} 基金详情`, text: shareText })
        return
      }
      await copyText(shareText)
      toast('已复制分享内容', 'success')
    } catch {
      toast('分享失败', 'error')
    }
  }

  const handleCopySummary = async () => {
    try {
      const text = `${resolvedName}（${fundCode}）\n成立来涨跌: ${sinceReturn >= 0 ? '+' : ''}${sinceReturn.toFixed(2)}%\n最新净值: ${latestNav?.toFixed(4) || '--'}`
      await copyText(text)
      toast('已复制摘要', 'success')
    } catch {
      toast('复制失败', 'error')
    }
  }

  const handleExportShareImage = async () => {
    setImageExporting(true)
    try {
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

      const changeColor = positive ? '#ef4444' : '#10b981'
      const ts = new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })

      const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="420" viewBox="0 0 800 420">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="100%" stop-color="#111827"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="800" height="420" fill="url(#bg)"/>
  <rect x="30" y="20" width="740" height="380" rx="18" fill="#0f172a" stroke="#1f2937"/>
  <text x="56" y="70" fill="#93c5fd" font-size="20" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">PanWatch 基金洞察</text>
  <text x="56" y="110" fill="#f8fafc" font-size="32" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(trim(`${resolvedName}（${fundCode}）`, 28))}</text>
  <text x="56" y="148" fill="#94a3b8" font-size="18" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(ts)}</text>

  <text x="56" y="210" fill="#94a3b8" font-size="20" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">成立来涨跌</text>
  <text x="200" y="210" fill="${changeColor}" font-size="36" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${positive ? '+' : ''}${sinceReturn.toFixed(2)}%</text>

  <text x="56" y="270" fill="#94a3b8" font-size="20" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">最新净值</text>
  <text x="200" y="270" fill="#f8fafc" font-size="28" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${latestNav?.toFixed(4) || '--'}</text>

  <text x="56" y="320" fill="#94a3b8" font-size="18" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">十大持仓股票</text>
  <text x="56" y="350" fill="#cbd5e1" font-size="16" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">${esc(trim((data?.top_holdings || []).slice(0, 5).map(h => h.name).join('、'), 60))}</text>

  <text x="56" y="388" fill="#64748b" font-size="14" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif">数据来源：东方财富 · 仅供参考，不构成投资建议</text>
</svg>`

      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 420
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('无法创建画布')
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      const png = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = png
      a.download = `panwatch-fund-${fundCode}-${Date.now()}.png`
      a.click()
      toast('分享图片已生成并下载', 'success')
    } catch {
      toast('图片生成失败，请稍后重试', 'error')
    } finally {
      setImageExporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-6xl p-5 md:p-6 overflow-x-hidden">
        <DialogHeader className="mb-3">
          <div className="flex items-start justify-between gap-3 pr-10 md:pr-8">
            <div className="shrink-0">
              <DialogTitle className="flex items-center gap-2 flex-wrap">
                <span className={`text-[10px] px-2 py-0.5 rounded ${badge.style}`}>{badge.label}</span>
                <span className="break-all">{resolvedName}</span>
                <span className="font-mono text-[12px] text-muted-foreground">({fundCode})</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{getFundType(fundCode)}</span>
              </DialogTitle>
            </div>
            <div className="hidden md:flex items-center gap-2">
              <Button variant="secondary" size="sm" className="h-8 px-2.5" onClick={() => handleExportShareImage()} disabled={imageExporting}>
                <Download className={`w-3.5 h-3.5 ${imageExporting ? 'animate-pulse' : ''}`} />
                <span>{imageExporting ? '生成中' : '图片'}</span>
              </Button>
              <Button variant="secondary" size="sm" className="h-8 px-2.5" onClick={handleShare}>
                <Share2 className="w-3.5 h-3.5" />
                <span>分享</span>
              </Button>
              <Button variant="secondary" size="sm" className="h-8 px-2.5" onClick={handleCopySummary}>
                <Copy className="w-3.5 h-3.5" />
                <span>复制</span>
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="h-8 px-2.5"
                onClick={toggleWatch}
                disabled={watchToggleLoading || (hasHolding && !!watchingStock)}
                title={hasHolding && watchingStock ? '持仓中的基金无法取消关注' : undefined}
              >
                {watchToggleLoading ? '处理中...' : (watchingStock ? (hasHolding ? '持仓中' : '取消关注') : '快速关注')}
              </Button>
              <StockPriceAlertPanel mode="inline" symbol={fundCode} market="FUND" stockName={resolvedName} />
              <Button variant="secondary" size="sm" className="h-8 px-2.5" onClick={handleSetAlert} disabled={alerting || !watchingStock}>
                <Bell className="w-3.5 h-3.5" />
                <span>{alerting ? '设置中...' : '一键设提醒'}</span>
              </Button>
            </div>
          </div>
          <div className="flex md:hidden items-center gap-2 mt-2 overflow-x-auto scrollbar-none pb-1 -mb-1">
            <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0" onClick={() => handleExportShareImage()} disabled={imageExporting}>
              <Download className={`w-3.5 h-3.5 ${imageExporting ? 'animate-pulse' : ''}`} />
            </Button>
            <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0" onClick={handleShare}>
              <Share2 className="w-3.5 h-3.5" />
            </Button>
            <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0" onClick={handleCopySummary}>
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
            <StockPriceAlertPanel mode="inline" symbol={fundCode} market="FUND" stockName={resolvedName} />
            <Button variant="secondary" size="sm" className="h-8 px-2.5 shrink-0" onClick={handleSetAlert} disabled={alerting || !watchingStock}>
              <Bell className="w-3.5 h-3.5" />
              <span>{alerting ? '设置中...' : '一键设提醒'}</span>
            </Button>
          </div>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <div className="flex items-center gap-1 flex-wrap">
            {[
              { id: 'overview', label: '概览' },
              { id: 'suggestions', label: `建议 (${suggestions.length})` },
              { id: 'reports', label: `报告 (${reports.length})` },
              { id: 'performance', label: '业绩走势' },
              { id: 'announcements', label: `公告 (${announcements.length})` },
              { id: 'news', label: `新闻 (${news.length})` },
            ].map(item => (
              <button
                key={item.id}
                onClick={() => setTab(item.id as FundTab)}
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
              {autoRefreshEnabled && !loading && (
                <svg
                  className="absolute inset-0 -rotate-90 pointer-events-none"
                  width={28}
                  height={28}
                  style={{ margin: 'auto' }}
                >
                  <circle cx={14} cy={14} r={13} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
                  <circle
                    cx={14} cy={14} r={13} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} strokeLinecap="round"
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
                  <SelectItem value="30">30秒</SelectItem>
                  <SelectItem value="60">60秒</SelectItem>
                  <SelectItem value="120">120秒</SelectItem>
                </SelectContent>
              </Select>
            )}
            {/* 桌面端：刷新按钮在最后面 */}
            <button
              onClick={() => handleRefreshAll()}
              disabled={loading}
              className="hidden md:flex w-8 h-8 rounded-xl items-center justify-center text-muted-foreground hover:text-foreground hover:bg-background/70 transition-all disabled:opacity-50 relative"
              title="刷新"
            >
              {autoRefreshEnabled && !loading && (
                <svg
                  className="absolute inset-0 -rotate-90 pointer-events-none"
                  width={28}
                  height={28}
                  style={{ margin: 'auto' }}
                >
                  <circle cx={14} cy={14} r={13} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={2} />
                  <circle
                    cx={14} cy={14} r={13} fill="none" stroke="hsl(var(--primary))" strokeWidth={2} strokeLinecap="round"
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

        <div className="max-h-[68vh] overflow-y-auto overflow-x-hidden pr-1 scrollbar">
          {loading && !data ? (
            <div className="space-y-3 py-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-64 w-full" />
              <Skeleton className="h-36 w-full" />
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 text-destructive text-sm p-3">{error}</div>
          ) : data && tab === 'overview' ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
                {/* Left card: Fund info + Holding */}
                <div className="card p-4 h-full">
                  <div className="mt-1 flex items-end justify-between gap-3">
                    <div className={`text-[34px] leading-none font-bold font-mono ${positive ? 'text-rose-500' : 'text-emerald-500'}`}>
                      {latestNav?.toFixed(4) || '--'}
                    </div>
                    <div className={`text-[16px] font-mono ${positive ? 'text-rose-500' : 'text-emerald-500'}`}>
                      成立来 {sinceReturn >= 0 ? '+' : ''}{sinceReturn.toFixed(2)}%
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-[12px]">
                    <div className="rounded bg-accent/15 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground">基金代码</div>
                      <div className="font-mono">{fundCode}</div>
                    </div>
                    <div className="rounded bg-accent/15 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground">单位净值</div>
                      <div className="font-mono">{fundQuote?.prev_close?.toFixed(4) || latestNav?.toFixed(4) || '--'}</div>
                    </div>
                    <div className="rounded bg-accent/15 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground">净值日期</div>
                      <div className="font-mono text-[11px]">{fundQuote?.jzrq || (data.updated_at ? new Date(data.updated_at).toLocaleDateString('zh-CN') : '--')}</div>
                    </div>
                  </div>

                  {/* 估值信息（如果有） */}
                  {fundQuote?.current_price != null && (
                    <div className="mt-2 grid grid-cols-3 gap-2 text-[12px]">
                      <div className="rounded bg-sky-500/10 px-2 py-1.5">
                        <div className="text-[10px] text-muted-foreground">估值净值</div>
                        <div className="font-mono text-sky-600 dark:text-sky-400">{fundQuote.current_price.toFixed(4)}</div>
                      </div>
                      <div className="rounded bg-sky-500/10 px-2 py-1.5">
                        <div className="text-[10px] text-muted-foreground">估值涨幅</div>
                        <div className={`font-mono ${(fundQuote.change_pct ?? 0) >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                          {fundQuote.change_pct != null ? `${fundQuote.change_pct >= 0 ? '+' : ''}${fundQuote.change_pct.toFixed(2)}%` : '--'}
                        </div>
                      </div>
                      <div className="rounded bg-sky-500/10 px-2 py-1.5">
                        <div className="text-[10px] text-muted-foreground">估值时间</div>
                        <div className="font-mono text-[11px]">{fundQuote.gztime || '--'}</div>
                      </div>
                    </div>
                  )}

                  {/* Holding info */}
                  <div className="mt-3 border-t border-border/50 pt-3">
                    <div className="text-[11px] text-muted-foreground mb-2">持仓信息</div>
                    {holdingAgg ? (
                      <div className="grid grid-cols-2 gap-2 text-[12px]">
                        <div className="rounded bg-emerald-500/10 px-2 py-1.5">
                          <div className="text-[10px] text-muted-foreground">持仓份额</div>
                          <div className="font-mono">{holdingAgg.quantity.toFixed(2)}</div>
                        </div>
                        <div className="rounded bg-emerald-500/10 px-2 py-1.5">
                          <div className="text-[10px] text-muted-foreground">持仓成本(单价)</div>
                          <div
                            className={`font-mono ${
                              latestNav != null
                                ? latestNav > holdingAgg.unitCost
                                  ? 'text-rose-500'
                                  : latestNav < holdingAgg.unitCost
                                    ? 'text-emerald-500'
                                    : 'text-foreground'
                                : 'text-foreground'
                            }`}
                          >
                            {holdingAgg.unitCost.toFixed(4)}
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
                      <div className="text-[11px] text-muted-foreground">{holdingLoaded ? '未在持仓中' : '加载中...'}</div>
                    )}
                  </div>
                </div>

                {/* Right card: Mini performance chart + Top holdings preview */}
                <div className="card p-4 h-full">
                  <div className="text-[12px] text-muted-foreground mb-2">自成立以来业绩走势</div>
                  {miniNormalizedPoints.length >= 2 ? (
                    <svg
                      viewBox={`0 0 ${miniChartWidth} ${miniChartHeight}`}
                      className="w-full h-32 cursor-pointer"
                      onClick={() => setTab('performance')}
                    >
                      <title>点击查看详细走势</title>
                      <defs>
                        <linearGradient id="miniArea" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={positive ? '#fb7185' : '#34d399'} stopOpacity="0.3" />
                          <stop offset="100%" stopColor={positive ? '#fb7185' : '#34d399'} stopOpacity="0.02" />
                        </linearGradient>
                      </defs>
                      <path d={miniAreaPath} fill="url(#miniArea)" />
                      <path d={miniChartPath} fill="none" stroke={positive ? '#fb7185' : '#34d399'} strokeWidth="2.5" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <div className="h-32 text-[11px] text-muted-foreground flex items-center justify-center">暂无走势数据</div>
                  )}

                  {/* Top holdings preview */}
                  <div className="mt-3 rounded bg-accent/10 p-2.5">
                    <div className="text-[11px] text-muted-foreground mb-2">十大持仓股票涨跌</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(data.top_holdings || []).slice(0, 6).map((item) => {
                        const rise = (item.change_pct || 0) >= 0
                        return (
                          <div key={`${item.code}-${item.name}`} className="flex items-center justify-between gap-1 text-[11px] px-1.5 py-1 rounded bg-accent/20">
                            <span className="truncate text-foreground">{item.name}</span>
                            <div className="flex items-center gap-1 shrink-0">
                              <span className={`font-mono ${rise ? 'text-rose-500' : 'text-emerald-500'}`}>
                                {item.change_pct != null ? `${item.change_pct >= 0 ? '+' : ''}${item.change_pct.toFixed(2)}%` : '--'}
                              </span>
                              <span className="text-sky-400 text-[10px]">{item.weight_text || `${Number(item.weight || 0).toFixed(1)}%`}</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    {(data.top_holdings || []).length > 6 && (
                      <div className="text-[10px] text-muted-foreground mt-1.5 text-center">
                        查看全部 {data.top_holdings.length} 只持仓股票 ↓
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Full top holdings list */}
              <div className="card p-4">
                <div className="text-[12px] text-muted-foreground mb-3">重仓前10</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {(data.top_holdings || []).map((item) => {
                    const rise = (item.change_pct || 0) >= 0
                    return (
                      <div key={`${item.code}-${item.name}`} className="rounded-lg border border-border bg-card p-2.5 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate text-foreground">{item.name}</div>
                          <div className="text-xs text-muted-foreground font-mono">{item.code}</div>
                        </div>
                        <div className="text-right flex items-center gap-2">
                          <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-xs ${rise ? 'text-rose-500 border-rose-500/30 bg-rose-500/10' : 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10'}`}>
                            {rise ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                            {item.change_pct != null ? `${item.change_pct >= 0 ? '+' : ''}${item.change_pct.toFixed(2)}%` : '--'}
                          </div>
                          <div className="text-lg font-semibold text-sky-400">{item.weight_text || `${Number(item.weight || 0).toFixed(2)}%`}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          ) : tab === 'performance' ? (
            <InteractiveFundChart
              points={data?.performance?.points || []}
              loading={loading}
              onRefresh={load}
              initialRange="all"
            />
          ) : tab === 'news' ? (
            <div className="space-y-3">
              <div className="flex items-center justify-end">
                <Select value={newsHours} onValueChange={setNewsHours}>
                  <SelectTrigger className="h-8 w-[110px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24">近24小时</SelectItem>
                    <SelectItem value="48">近48小时</SelectItem>
                    <SelectItem value="168">近7天</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {newsLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : news.length === 0 ? (
                <div className="card p-6 text-[12px] text-muted-foreground text-center">暂无相关新闻</div>
              ) : (
                news.map((item, idx) => (
                  <a
                    key={`${item.external_id || item.publish_time}-${idx}`}
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
          ) : tab === 'suggestions' ? (
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
                <div className="card p-6 text-[12px] text-muted-foreground text-center">
                  {autoSuggesting ? '正在自动生成 AI 建议（通常 5-15 秒）...' : '暂无建议'}
                </div>
              ) : (
                <div className="max-h-[56vh] overflow-y-auto pr-1 scrollbar space-y-3">
                  {suggestions.map((item, idx) => (
                    <div key={`${item.created_at || 's'}-${idx}`} className="card p-4">
                      <SuggestionBadge suggestion={item} stockName={resolvedName} stockSymbol={fundCode} hasPosition={hasHolding} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : tab === 'reports' ? (
            <div className="space-y-3">
              <div className="card p-3">
                <div className="flex items-center gap-1">
                  {([
                    { key: 'fund_holding_analyst', label: '基金周报' },
                    { key: 'news_digest', label: '新闻' },
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
                  {activeReport.suggestions && (activeReport.suggestions as any)?.[fundCode]?.action_label && (
                    <div className="text-[11px] inline-flex px-2 py-0.5 rounded bg-primary/10 text-primary">
                      {(activeReport.suggestions as any)[fundCode].action_label}
                    </div>
                  )}
                  <div className="rounded-lg bg-accent/10 p-3">
                    <div className="prose prose-sm dark:prose-invert max-w-none text-foreground/90 break-words">
                      <ReactMarkdown>{activeReport.content || '暂无报告内容'}</ReactMarkdown>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : tab === 'announcements' ? (
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
                    <SelectItem value="24">近24小时</SelectItem>
                    <SelectItem value="48">近48小时</SelectItem>
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
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
