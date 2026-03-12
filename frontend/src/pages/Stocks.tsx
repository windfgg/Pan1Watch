import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Pencil, Search, X, TrendingUp, Bot, Play, RefreshCw, Wallet, PiggyBank, ArrowUpRight, ArrowDownRight, Building2, ChevronDown, ChevronRight, Cpu, Bell, Clock, Newspaper, BarChart3, LayoutGrid, List, FileText } from 'lucide-react'
import { fetchAPI, stocksApi, type AIService, type NotifyChannel } from '@panwatch/api'
import { useLocalStorage } from '@/lib/utils'
import { useRefreshReceiver, useAutoRefreshProgress } from '@/hooks/use-global-refresh'
import { SuggestionBadge, type SuggestionInfo, type KlineSummary } from '@panwatch/biz-ui/components/suggestion-badge'
import { buildKlineSuggestion } from '@/lib/kline-scorer'
import { KlineSummaryDialog } from '@panwatch/biz-ui/components/kline-summary-dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { Switch } from '@panwatch/base-ui/components/ui/switch'
import { Badge } from '@panwatch/base-ui/components/ui/badge'
import { Skeleton } from '@panwatch/base-ui/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@panwatch/base-ui/components/ui/dialog'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectLabel, SelectItem } from '@panwatch/base-ui/components/ui/select'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import StockInsightModal from '@panwatch/biz-ui/components/stock-insight-modal'
import StockPriceAlertPanel from '@panwatch/biz-ui/components/stock-price-alert-panel'
import FundOverviewModal from '@/components/FundOverviewModal'
import { useConfirmDialog } from '@/hooks/use-confirm-dialog'

interface AgentResult {
  success?: boolean
  message?: string
  title: string
  content: string
  should_alert: boolean
  notified: boolean
  skipped?: boolean
}

interface StockAgentInfo {
  agent_name: string
  schedule: string
  ai_model_id: number | null
  notify_channel_ids: number[]
}

interface Stock {
  id: number
  symbol: string
  name: string
  market: string
  sort_order?: number
  agents: StockAgentInfo[]
}

interface Account {
  id: number
  name: string
  market: string
  base_currency: string
  available_funds: number
  enabled: boolean
}

interface Position {
  id: number
  stock_id: number
  sort_order?: number
  symbol: string
  name: string
  market: string
  cost_price: number
  quantity: number
  invested_amount: number | null
  trading_style: string  // short: 短线, swing: 波段, long: 长线
  currency?: string
  current_price: number | null
  current_price_display?: number | null
  current_price_cny: number | null  // 人民币价格（港股换算后）
  change_pct: number | null
  market_value: number | null
  market_value_display?: number | null
  market_value_cny: number | null  // 人民币市值
  pnl: number | null
  pnl_pct: number | null
  day_pnl?: number | null
  day_pnl_pct?: number | null
  exchange_rate: number | null  // 汇率（仅港股）
}

interface AccountSummary {
  id: number
  name: string
  market: string
  base_currency: string
  display_currency?: string
  available_funds: number
  available_funds_native?: number
  total_market_value: number
  total_cost: number
  total_pnl: number
  total_pnl_pct: number
  day_pnl?: number
  day_pnl_pct?: number
  total_assets: number
  positions: Position[]
}

interface PortfolioSummary {
  display_currency?: string
  accounts: AccountSummary[]
  total: {
    total_market_value: number
    total_cost: number
    total_pnl: number
    total_pnl_pct: number
    day_pnl?: number
    day_pnl_pct?: number
    available_funds: number
    total_assets: number
    display_currency?: string
  }
  exchange_rates?: {
    HKD_CNY: number
    USD_CNY?: number
    rates_to_cny?: Record<string, number>
  }
  quotes?: Record<string, { current_price: number | null; change_pct: number | null }>
}

interface AgentConfig {
  name: string
  display_name: string
  description: string
  enabled: boolean
  schedule: string
  execution_mode: string  // batch: 批量分析, single: 逐只分析
  market_filter?: string[]  // 空数组表示无限制，["FUND"]表示仅基金可用
}

interface SchedulePreview {
  schedule: string
  timezone: string
  next_runs: string[]
}

interface SearchResult {
  symbol: string
  name: string
  market: string
}

interface RefreshListResult {
  count: number
  stock_count?: number
  fund_count?: number
}

interface QuoteRequestItem {
  symbol: string
  market: string
}

interface QuoteResponse {
  symbol: string
  market: string
  current_price: number | null
  change_pct: number | null
}

interface StockForm {
  symbol: string
  name: string
  market: string
}

interface AccountForm {
  name: string
  market: string
  base_currency: string
  available_funds: string
}

interface PositionForm {
  account_id: number
  stock_id: number
  cost_price: string
  quantity: string
  invested_amount: string
  trading_style: string
  // 搜索选中的股票信息（新增持仓时用）
  stock_symbol: string
  stock_name: string
  stock_market: string
}

// 股票建议信息（来自盘中监控 API）
interface StockSuggestionData {
  symbol: string
  suggestion: SuggestionInfo | null
  kline: KlineSummary | null
}

// 建议池中的建议（包含来源和时间信息）
interface PoolSuggestion {
  id: number
  stock_symbol: string
  stock_market?: string
  stock_name: string
  action: string
  action_label: string
  signal: string
  reason: string
  agent_name: string
  agent_label: string
  created_at: string
  expires_at: string | null
  is_expired: boolean
  prompt_context: string
  ai_response: string
  meta?: Record<string, any>
  should_alert?: boolean
}

interface MarketStatus {
  code: string
  name: string
  status: string
  status_text: string
  is_trading: boolean
  sessions: string[]
  local_time: string
}

interface PriceAlertRuleSummary {
  stock_symbol: string
  market: string
  enabled: boolean
}

const emptyStockForm: StockForm = { symbol: '', name: '', market: 'CN' }
const emptyAccountForm: AccountForm = { name: '', market: 'CN', base_currency: 'CNY', available_funds: '0' }

const round2 = (value: number) => Math.round(value * 100) / 100
type AccountSortKey = 'name' | 'total_assets' | 'total_pnl' | 'day_pnl' | 'total_market_value' | 'available_funds'
type SortDirection = 'asc' | 'desc'
type PositionSortKey = 'sort_order' | 'name' | 'current_price' | 'change_pct' | 'day_pnl' | 'cost_price' | 'quantity' | 'market_value' | 'pnl'
type PositionColumnKey = Exclude<PositionSortKey, 'sort_order'>

const POSITION_COLUMN_DEFAULT_ORDER: PositionColumnKey[] = [
  'name',
  'current_price',
  'change_pct',
  'day_pnl',
  'cost_price',
  'quantity',
  'market_value',
  'pnl',
]

const POSITION_COLUMN_META: Record<PositionColumnKey, { label: string; align: 'text-left' | 'text-right' }> = {
  name: { label: '名称', align: 'text-left' },
  current_price: { label: '现价', align: 'text-right' },
  change_pct: { label: '涨跌', align: 'text-right' },
  day_pnl: { label: '今日盈亏', align: 'text-right' },
  cost_price: { label: '成本', align: 'text-right' },
  quantity: { label: '持仓', align: 'text-right' },
  market_value: { label: '市值', align: 'text-right' },
  pnl: { label: '盈亏', align: 'text-right' },
}

const mergePortfolioQuotes = (
  portfolio: PortfolioSummary | null,
  quotes: Record<string, { current_price: number | null; change_pct: number | null }>
): PortfolioSummary | null => {
  if (!portfolio) return null

  const displayCurrency = (portfolio.display_currency || portfolio.total.display_currency || 'CNY').toUpperCase()
  const ratesToCny: Record<string, number> = {
    CNY: 1,
    HKD: portfolio.exchange_rates?.HKD_CNY ?? 0.92,
    USD: portfolio.exchange_rates?.USD_CNY ?? 7.25,
    ...(portfolio.exchange_rates?.rates_to_cny || {}),
  }
  const convertAmount = (amount: number, from: string, to: string) => {
    const src = (from || 'CNY').toUpperCase()
    const dst = (to || 'CNY').toUpperCase()
    if (src === dst) return amount
    const srcToCny = ratesToCny[src] ?? 1
    const dstToCny = ratesToCny[dst] ?? 1
    if (!dstToCny) return amount
    return (amount * srcToCny) / dstToCny
  }

  let grandMarketValue = 0
  let grandCost = 0
  let grandAvailable = 0
  let grandDayPnl = 0
  let grandPrevMv = 0

  const accounts = portfolio.accounts.map(account => {
    let accMarketValue = 0
    let accCost = 0
    let accDayPnl = 0
    let accPrevMv = 0

    const positions = account.positions.map(pos => {
      const quote = quotes[`${pos.market}:${pos.symbol}`]
      const current_price = quote?.current_price ?? pos.current_price ?? null
      const change_pct = quote?.change_pct ?? pos.change_pct ?? null
      const positionCurrency = (pos.currency || (pos.market === 'HK' ? 'HKD' : pos.market === 'US' ? 'USD' : 'CNY')).toUpperCase()

      const cost = convertAmount(pos.cost_price * pos.quantity, positionCurrency, displayCurrency)
      accCost += cost

      let market_value: number | null = null
      let market_value_display: number | null = null
      let pnl: number | null = null
      let pnl_pct: number | null = null
      let day_pnl: number | null = null
      let day_pnl_pct: number | null = null

      if (current_price != null) {
        market_value = current_price * pos.quantity
        market_value_display = convertAmount(market_value, positionCurrency, displayCurrency)
        accMarketValue += market_value_display
        pnl = market_value_display - cost
        pnl_pct = cost > 0 ? (pnl / cost * 100) : 0

        if (change_pct != null) {
          const prevPrice = change_pct === -100 ? null : (current_price / (1 + change_pct / 100))
          if (prevPrice != null && isFinite(prevPrice) && prevPrice > 0) {
            const prevMarketValue = prevPrice * pos.quantity
            const prevMarketValueDisplay = convertAmount(prevMarketValue, positionCurrency, displayCurrency)
            day_pnl = market_value_display - prevMarketValueDisplay
            day_pnl_pct = prevMarketValueDisplay > 0 ? (day_pnl / prevMarketValueDisplay * 100) : 0
            accDayPnl += day_pnl
            accPrevMv += prevMarketValueDisplay
          }
        }
      }

      const current_price_display = current_price != null
        ? convertAmount(current_price, positionCurrency, displayCurrency)
        : null

      return {
        ...pos,
        currency: positionCurrency,
        current_price,
        current_price_display,
        current_price_cny: current_price_display,
        change_pct,
        market_value,
        market_value_display,
        market_value_cny: market_value_display,
        pnl,
        pnl_pct,
        day_pnl,
        day_pnl_pct,
        exchange_rate: convertAmount(1, positionCurrency, displayCurrency),
      }
    })

    const accPnl = accMarketValue - accCost
    const accPnlPct = accCost > 0 ? (accPnl / accCost * 100) : 0
    const accDayPnlPct = accPrevMv > 0 ? (accDayPnl / accPrevMv * 100) : 0
    const accountFundsNative = account.available_funds_native ?? account.available_funds
    const accAvailable = convertAmount(accountFundsNative, account.base_currency || 'CNY', displayCurrency)
    const accTotalAssets = accMarketValue + accAvailable

    grandMarketValue += accMarketValue
    grandCost += accCost
    grandAvailable += accAvailable
    grandDayPnl += accDayPnl
    grandPrevMv += accPrevMv

    return {
      ...account,
      display_currency: displayCurrency,
      available_funds_native: accountFundsNative,
      available_funds: round2(accAvailable),
      total_market_value: round2(accMarketValue),
      total_cost: round2(accCost),
      total_pnl: round2(accPnl),
      total_pnl_pct: round2(accPnlPct),
      day_pnl: round2(accDayPnl),
      day_pnl_pct: round2(accDayPnlPct),
      total_assets: round2(accTotalAssets),
      positions,
    }
  })

  const grandPnl = grandMarketValue - grandCost
  const grandPnlPct = grandCost > 0 ? (grandPnl / grandCost * 100) : 0
  const grandDayPnlPct = grandPrevMv > 0 ? (grandDayPnl / grandPrevMv * 100) : 0
  const grandTotalAssets = grandMarketValue + grandAvailable

  return {
    ...portfolio,
    display_currency: displayCurrency,
    accounts,
    total: {
      total_market_value: round2(grandMarketValue),
      total_cost: round2(grandCost),
      total_pnl: round2(grandPnl),
      total_pnl_pct: round2(grandPnlPct),
      day_pnl: round2(grandDayPnl),
      day_pnl_pct: round2(grandDayPnlPct),
      available_funds: round2(grandAvailable),
      total_assets: round2(grandTotalAssets),
      display_currency: displayCurrency,
    },
  }
}

export default function StocksPage() {
  const [stocks, setStocks] = useState<Stock[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [services, setServices] = useState<AIService[]>([])
  const [channels, setChannels] = useState<NotifyChannel[]>([])
  const [loading, setLoading] = useState(true)

  // Portfolio
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null)
  const [portfolioRaw, setPortfolioRaw] = useState<PortfolioSummary | null>(null)
  const [portfolioLoading, setPortfolioLoading] = useState(false)
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set())
  const [accountSortKey, setAccountSortKey] = useLocalStorage<AccountSortKey>('panwatch_account_sort_key_v1', 'total_assets')
  const [accountSortDirection, setAccountSortDirection] = useLocalStorage<SortDirection>('panwatch_account_sort_dir_v1', 'desc')
  const [positionSortKey, setPositionSortKey] = useLocalStorage<PositionSortKey>('panwatch_position_sort_key_v1', 'sort_order')
  const [positionSortDirection, setPositionSortDirection] = useLocalStorage<SortDirection>('panwatch_position_sort_dir_v1', 'asc')
  const [positionColumnOrder, setPositionColumnOrder] = useLocalStorage<PositionColumnKey[]>('panwatch_position_column_order_v1', POSITION_COLUMN_DEFAULT_ORDER)
  const [draggingPositionColumn, setDraggingPositionColumn] = useState<PositionColumnKey | null>(null)

  // Quotes for all stocks (used in stock list)
  const [quotes, setQuotes] = useState<Record<string, { current_price: number | null; change_pct: number | null }>>({})
  const [, setQuotesLoading] = useState(false)
  // Keyed by `${market}:${symbol}` to avoid cross-market symbol collisions
  const [klineSummaries, setKlineSummaries] = useState<Record<string, KlineSummary>>({})

  // Auto-refresh (持久化到 localStorage)
  const [autoRefresh, setAutoRefresh] = useLocalStorage('panwatch_stocks_autoRefresh', false)
  const [refreshInterval, setRefreshInterval] = useLocalStorage('panwatch_stocks_refreshInterval', 30)
  const [displayCurrency, setDisplayCurrency] = useLocalStorage<'CNY' | 'HKD' | 'USD'>('panwatch_stocks_display_currency', 'CNY')
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(null)
  const [, setNextAutoRefreshAt] = useState<number | null>(null)
  const [, setAutoRefreshTick] = useState<number>(Date.now())
  const refreshTimerRef = useRef<ReturnType<typeof setInterval>>()
  const refreshTickRef = useRef<ReturnType<typeof setInterval>>()
  const progressTimerRef = useRef<ReturnType<typeof setInterval>>()
  const setAutoRefreshProgress = useAutoRefreshProgress()

  // Alerts / Scanning
  const [scanning, setScanning] = useState(false)

  type ViewTab = 'positions' | 'watchlist'
  const [viewTab, setViewTab] = useLocalStorage<ViewTab>('panwatch_stocks_viewTab', 'positions')

  // 股票 AI 建议（来自盘中监控 API）
  const [suggestions] = useState<Record<string, StockSuggestionData>>({})
  // 建议池建议（来自 /suggestions API）
  const [poolSuggestions, setPoolSuggestions] = useState<Record<string, PoolSuggestion>>({})
  const [poolSuggestionsLoading, setPoolSuggestionsLoading] = useState(false)
  const [priceAlertSummaryMap, setPriceAlertSummaryMap] = useState<Record<string, { total: number; enabled: number }>>({})

  // Kline Dialog
  const [klineDialogOpen, setKlineDialogOpen] = useState(false)
  const [klineDialogSymbol, setKlineDialogSymbol] = useState('')
  const [klineDialogMarket, setKlineDialogMarket] = useState('CN')
  const [klineDialogName, setKlineDialogName] = useState<string | undefined>(undefined)
  const [klineDialogHasPosition, setKlineDialogHasPosition] = useState<boolean>(false)
  const [klineDialogInitialSummary, setKlineDialogInitialSummary] = useState<KlineSummary | null>(null)
  const [insightOpen, setInsightOpen] = useState(false)
  const [insightSymbol, setInsightSymbol] = useState('')
  const [insightMarket, setInsightMarket] = useState('CN')
  const [insightName, setInsightName] = useState<string | undefined>(undefined)
  const [insightHasPosition, setInsightHasPosition] = useState(false)
  const [fundOverviewOpen, setFundOverviewOpen] = useState(false)
  const [fundOverviewSymbol, setFundOverviewSymbol] = useState('')
  const [fundOverviewName, setFundOverviewName] = useState<string | undefined>(undefined)

  // Market status
  const [marketStatus, setMarketStatus] = useState<MarketStatus[]>([])
  // Guard to prevent overlapping K线刷新任务导致实际并发超限
  const klineRefreshInFlight = useRef<Promise<void> | null>(null)

  // Stock form
  const [showStockForm, setShowStockForm] = useState(false)
  const [stockForm, setStockForm] = useState<StockForm>(emptyStockForm)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMarket, setSearchMarket] = useState('')  // 搜索市场筛选
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [refreshingStockList, setRefreshingStockList] = useState(false)

  // Account form
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [accountForm, setAccountForm] = useState<AccountForm>(emptyAccountForm)
  const [editAccountId, setEditAccountId] = useState<number | null>(null)

  // Position form
  const [positionDialogOpen, setPositionDialogOpen] = useState(false)
  const [positionForm, setPositionForm] = useState<PositionForm>({ account_id: 0, stock_id: 0, cost_price: '', quantity: '', invested_amount: '', trading_style: '', stock_symbol: '', stock_name: '', stock_market: 'CN' })
  const [editPositionId, setEditPositionId] = useState<number | null>(null)
  const [positionDialogAccountId, setPositionDialogAccountId] = useState<number | null>(null)
  const [positionSearchQuery, setPositionSearchQuery] = useState('')
  const [positionSearchMarket, setPositionSearchMarket] = useState('')  // 搜索市场筛选
  const [positionSearchResults, setPositionSearchResults] = useState<SearchResult[]>([])
  const [positionSearching, setPositionSearching] = useState(false)
  const [showPositionDropdown, setShowPositionDropdown] = useState(false)
  const positionSearchTimer = useRef<ReturnType<typeof setTimeout>>()
  const positionDropdownRef = useRef<HTMLDivElement>(null)

  // Agent dialog
  const [agentDialogStock, setAgentDialogStock] = useState<Stock | null>(null)
  const [triggeringAgent, setTriggeringAgent] = useState<string | null>(null)
  const [schedulePreviewCache, setSchedulePreviewCache] = useState<Record<string, SchedulePreview | { error: string }>>({})
  const [schedulePreviewLoading, setSchedulePreviewLoading] = useState<Record<string, boolean>>({})
  // 运行中的单只股票 Agent（按股票标记具体 Agent 名称）
  const [runningAgents, setRunningAgents] = useState<Record<number, string | null>>({})
  const [agentResultDialog, setAgentResultDialog] = useState<{ title: string; content: string; should_alert: boolean; notified: boolean } | null>(null)

  // Stock list filter
  const [stockListFilter, setStockListFilter] = useState('')  // '' = 全部, 'CN' = A股, 'HK' = 港股, 'US' = 美股, 'FUND' = 基金
  const [watchlistKeyword, setWatchlistKeyword] = useState('')
  const [watchlistOnlyAlerts, setWatchlistOnlyAlerts] = useLocalStorage<boolean>('panwatch_watchlist_only_alerts', false)
  const [watchlistViewMode, setWatchlistViewMode] = useLocalStorage<'card' | 'list'>('panwatch_watchlist_view_mode', 'card')
  const [portfolioKpiFlashMap, setPortfolioKpiFlashMap] = useState<Record<string, { key: number; dir: 'up' | 'down' | 'neutral' }>>({})
  const [watchlistQuoteFlashMap, setWatchlistQuoteFlashMap] = useState<Record<string, 'up' | 'down' | 'neutral'>>({})
  const prevPortfolioKpiRef = useRef<Record<string, number>>({})
  const prevWatchlistQuoteRef = useRef<Record<string, { current_price: number | null; change_pct: number | null }>>({})

  // Remove watchlist modal
  const [removeWatchStock, setRemoveWatchStock] = useState<Stock | null>(null)
  const [removingWatchStock, setRemovingWatchStock] = useState(false)
  const [draggingWatchStockId, setDraggingWatchStockId] = useState<number | null>(null)
  const [draggingPositionId, setDraggingPositionId] = useState<number | null>(null)
  const [draggingPositionAccountId, setDraggingPositionAccountId] = useState<number | null>(null)
  const watchDragSnapshotRef = useRef<Stock[] | null>(null)
  const positionDragSnapshotRef = useRef<PortfolioSummary | null>(null)

  const { toast } = useToast()
  const navigate = useNavigate()
  const { confirm, confirmDialog } = useConfirmDialog()

  const moveById = <T extends { id: number }>(list: T[], fromId: number, toId: number): T[] => {
    const fromIdx = list.findIndex(x => x.id === fromId)
    const toIdx = list.findIndex(x => x.id === toId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return list
    const next = [...list]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    return next
  }

  const persistWatchlistOrder = useCallback(async (ordered: Stock[]) => {
    const payload = ordered.map((s, idx) => ({ id: s.id, sort_order: idx + 1 }))
    await fetchAPI('/stocks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ items: payload }),
    })
  }, [])

  const previewWatchlistReorder = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) return
    setStocks(prev => {
      const ordered = [...prev].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
      const moved = moveById(ordered, fromId, toId)
      return moved.map((s, idx) => ({ ...s, sort_order: idx + 1 }))
    })
  }, [])

  const commitWatchlistReorder = useCallback(async () => {
    const current = stocks
    if (!current || current.length === 0) return
    try {
      await persistWatchlistOrder(current)
    } catch (e) {
      if (watchDragSnapshotRef.current) setStocks(watchDragSnapshotRef.current)
      toast(e instanceof Error ? e.message : '保存关注排序失败', 'error')
    }
  }, [persistWatchlistOrder, stocks, toast])

  const persistPositionOrder = useCallback(async (ordered: Position[]) => {
    const payload = ordered.map((p, idx) => ({ id: p.id, sort_order: idx + 1 }))
    await fetchAPI('/positions/reorder/batch', {
      method: 'PUT',
      body: JSON.stringify({ items: payload }),
    })
  }, [])

  const previewPositionReorder = useCallback((accountId: number, fromId: number, toId: number) => {
    if (fromId === toId) return
    setPortfolioRaw(prev => {
      if (!prev) return prev
      const accountsNext = prev.accounts.map(acc => {
        if (acc.id !== accountId) return acc
        const moved = moveById(acc.positions || [], fromId, toId).map((p, idx) => ({ ...p, sort_order: idx + 1 }))
        return { ...acc, positions: moved }
      })
      return { ...prev, accounts: accountsNext }
    })
  }, [])

  const commitPositionReorder = useCallback(async (accountId: number) => {
    const acc = portfolioRaw?.accounts?.find(a => a.id === accountId)
    const ordered = acc?.positions || []
    if (!ordered.length) return
    try {
      await persistPositionOrder(ordered)
    } catch (e) {
      if (positionDragSnapshotRef.current) setPortfolioRaw(positionDragSnapshotRef.current)
      toast(e instanceof Error ? e.message : '保存持仓排序失败', 'error')
    }
  }, [persistPositionOrder, portfolioRaw, toast])

  const isSuppressCardClick = () => {
    try {
      const until = (window as any).__panwatch_suppress_card_click_until
      return typeof until === 'number' && Date.now() < until
    } catch {
      return false
    }
  }
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const dropdownRef = useRef<HTMLDivElement>(null)

  // 非核心数据后台加载（不阻塞 UI）
  const loadConfigAsync = async () => {
    try {
      const [agentData, servicesData, channelsData] = await Promise.all([
        fetchAPI<AgentConfig[]>('/agents'),
        fetchAPI<AIService[]>('/providers/services'),
        fetchAPI<NotifyChannel[]>('/channels'),
      ])
      setAgents(agentData)
      setServices(servicesData)
      setChannels(channelsData)
    } catch (e) {
      console.warn('加载配置数据失败:', e)
    }
  }

  const load = async () => {
    try {
      // 核心数据（立即需要）
      const [stockData, accountData] = await Promise.all([
        fetchAPI<Stock[]>('/stocks'),
        fetchAPI<Account[]>('/accounts'),
      ])
      setStocks(stockData)
      setAccounts(accountData)
      setLastRefreshTime(new Date())
      // 默认展开所有账户
      setExpandedAccounts(new Set(accountData.map((a: Account) => a.id)))
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)  // 提前解除阻塞
    }

    // 非核心数据（后台加载，不阻塞 UI）
    loadConfigAsync()

    // 市场状态（非核心，失败不影响页面）
    try {
      const marketStatusData = await fetchAPI<MarketStatus[]>('/stocks/markets/status')
      setMarketStatus(marketStatusData)
    } catch (e) {
      console.warn('获取市场状态失败:', e)
    }
  }

  const loadPortfolio = async () => {
    setPortfolioLoading(true)
    try {
      // 核心数据：仅本地账户/持仓
      const portfolioData = await fetchAPI<PortfolioSummary>(`/portfolio/summary?include_quotes=false&display_currency=${encodeURIComponent(displayCurrency)}`)
      setPortfolioRaw(portfolioData)
      setPortfolio(mergePortfolioQuotes(portfolioData, quotes))
      setLastRefreshTime(new Date())

      // 市场状态（非核心，失败不影响页面）
      try {
        const marketStatusData = await fetchAPI<MarketStatus[]>('/stocks/markets/status')
        setMarketStatus(marketStatusData)
      } catch (e) {
        console.warn('获取市场状态失败:', e)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setPortfolioLoading(false)
    }
  }

  useEffect(() => {
    if (loading) return
    loadPortfolio()
  }, [displayCurrency])

  const buildQuoteItems = useCallback((): QuoteRequestItem[] => {
    const items: QuoteRequestItem[] = []
    const seen = new Set<string>()

    for (const stock of stocks) {
      const key = `${stock.market}:${stock.symbol}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({ symbol: stock.symbol, market: stock.market })
    }

    for (const account of portfolioRaw?.accounts || []) {
      for (const pos of account.positions) {
        const key = `${pos.market}:${pos.symbol}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({ symbol: pos.symbol, market: pos.market })
      }
    }

    return items
  }, [stocks, portfolioRaw])

  const buildKlineItems = useCallback((): QuoteRequestItem[] => {
    return buildQuoteItems().filter(item => (item.market || '').toUpperCase() !== 'FUND')
  }, [buildQuoteItems])

  const refreshQuotes = useCallback(async (options?: { silent?: boolean }) => {
    const items = buildQuoteItems()
    if (items.length === 0) return

    const silent = !!options?.silent
    if (!silent) setQuotesLoading(true)
    try {
      const data = await fetchAPI<QuoteResponse[]>('/quotes/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
      })
      const map: Record<string, { current_price: number | null; change_pct: number | null }> = {}
      for (const item of data) {
        map[`${item.market}:${item.symbol}`] = {
          current_price: item.current_price ?? null,
          change_pct: item.change_pct ?? null,
        }
      }
      setQuotes(map)
      setLastRefreshTime(new Date())
    } catch (e) {
      console.warn('刷新行情失败:', e)
    } finally {
      if (!silent) setQuotesLoading(false)
    }
  }, [buildQuoteItems])

  useEffect(() => {
    if (!portfolioRaw) return
    setPortfolio(mergePortfolioQuotes(portfolioRaw, quotes))
  }, [portfolioRaw, quotes])

  useEffect(() => {
    if (stocks.length === 0 && (!portfolioRaw || portfolioRaw.accounts.length === 0)) return
    refreshQuotes()
    // 刷新 K 线摘要（用于常驻评分徽章）
    ;(async () => {
      try { await refreshKlines() } catch {}
    })()
  }, [stocks, portfolioRaw, refreshQuotes])

  // 刷新 K 线摘要（并发受限的单个请求，避免批量接口慢）；并防止重入
  const refreshKlines = useCallback(async () => {
    if (klineRefreshInFlight.current) return klineRefreshInFlight.current
    const run = (async () => {
      const items = buildKlineItems()
      if (items.length === 0) return
      const limit = 5
      const map: Record<string, KlineSummary> = {}
      let idx = 0
      const worker = async () => {
        while (idx < items.length) {
          const i = idx++
          const it = items[i]
          try {
            const res = await fetchAPI<{ symbol: string; market: string; summary: KlineSummary }>(`/klines/${encodeURIComponent(it.symbol)}/summary?market=${encodeURIComponent(it.market)}`)
            if (res && (res as any).summary) {
              map[`${it.market}:${it.symbol}`] = (res as any).summary as KlineSummary
            }
          } catch {
            // ignore single failure
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
      // 增量合并：本轮单只失败时保留旧值，避免技术徽章闪断/消失
      setKlineSummaries(prev => ({ ...prev, ...map }))
    })()
    klineRefreshInFlight.current = run
    try { await run } finally { klineRefreshInFlight.current = null }
  }, [buildKlineItems])

  // 从建议池加载建议（包含历史建议和多来源建议）
  const loadPoolSuggestions = useCallback(async (options?: { silent?: boolean }) => {
    const silent = !!options?.silent
    if (!silent) setPoolSuggestionsLoading(true)
    try {
      const data = await fetchAPI<Record<string, PoolSuggestion>>('/suggestions?include_expired=true')
      setPoolSuggestions(data)
    } catch (e) {
      console.warn('加载建议池失败:', e)
    } finally {
      if (!silent) setPoolSuggestionsLoading(false)
    }
  }, [])

  const loadPriceAlertSummaries = useCallback(async () => {
    try {
      const rows = await fetchAPI<PriceAlertRuleSummary[]>('/price-alerts')
      const map: Record<string, { total: number; enabled: number }> = {}
      for (const r of rows || []) {
        const key = `${String(r.market || 'CN').toUpperCase()}:${String(r.stock_symbol || '').toUpperCase()}`
        if (!map[key]) map[key] = { total: 0, enabled: 0 }
        map[key].total += 1
        if (r.enabled) map[key].enabled += 1
      }
      setPriceAlertSummaryMap(map)
    } catch (e) {
      console.warn('加载提醒摘要失败:', e)
    }
  }, [])

  const openKlineDialog = useCallback((symbol: string, market: string, name?: string, hasPosition?: boolean) => {
    setKlineDialogSymbol(symbol)
    setKlineDialogMarket(market || 'CN')
    setKlineDialogName(name)
    setKlineDialogHasPosition(!!hasPosition)
    const m = market || 'CN'
    setKlineDialogInitialSummary(klineSummaries[`${m}:${symbol}`] || null)
    setKlineDialogOpen(true)
  }, [klineSummaries])

  const openIntelCenter = useCallback((tab: 'news' | 'report', symbol: string, market: string, stockName?: string) => {
    const params = new URLSearchParams()
    params.set('tab', tab)
    params.set('symbol', String(symbol || '').toUpperCase())
    params.set('market', String(market || 'CN').toUpperCase())
    if (stockName) params.set('name', stockName)
    navigate(`/intel?${params.toString()}`)
  }, [navigate])

  const openStockDetail = useCallback((stockSymbol: string, stockMarket: string, stockName?: string, hasPosition?: boolean) => {
    if ((stockMarket || '').toUpperCase() === 'FUND') {
      setFundOverviewSymbol(stockSymbol)
      setFundOverviewName(stockName)
      setFundOverviewOpen(true)
      return
    }
    setInsightSymbol(stockSymbol)
    setInsightMarket(stockMarket || 'CN')
    setInsightName(stockName)
    setInsightHasPosition(!!hasPosition)
    setInsightOpen(true)
  }, [])

  const formatPreviewTime = (iso: string, tz?: string): string => {
    try {
      const d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      return d.toLocaleString('zh-CN', {
        timeZone: tz || undefined,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    } catch {
      return iso
    }
  }

  const effectiveSchedule = (agent: AgentConfig, stockAgent?: StockAgentInfo | null): string => {
    const local = (stockAgent?.schedule || '').trim()
    if (local) return local
    return (agent.schedule || '').trim()
  }

  // Refresh quotes only (decoupled from portfolio and scans)
  const handleRefresh = useCallback(async () => {
    await Promise.all([
      refreshQuotes(),
      loadPoolSuggestions(),
      refreshKlines(),
    ])
  }, [refreshQuotes, loadPoolSuggestions, refreshKlines])

  // 注册全局刷新回调
  useRefreshReceiver(handleRefresh)

  useEffect(() => { load(); loadPortfolio(); loadPoolSuggestions(); loadPriceAlertSummaries(); refreshKlines() }, [])

  // 仅关注列表场景（无持仓）也要在列表加载后预取 K 线摘要，保证技术指标徽章可见
  const watchlistKlineInitDone = useRef(false)
  const klineMissingRetryRef = useRef<Record<string, number>>({})
  useEffect(() => {
    if (watchlistKlineInitDone.current) return
    if (!stocks || stocks.length === 0) return
    watchlistKlineInitDone.current = true
    refreshKlines()
  }, [stocks, refreshKlines])

  // 关注列表变更后，自动补齐缺失的 K 线摘要（避免未配置 agent 时没有技术指标徽章）
  useEffect(() => {
    if (!stocks || stocks.length === 0) return
    const now = Date.now()
    const retryGapMs = 2 * 60 * 1000
    const missing = stocks.filter(s => {
      if ((s.market || '').toUpperCase() === 'FUND') return false
      const key = `${s.market || 'CN'}:${s.symbol}`
      if (klineSummaries[key]) return false
      const lastTry = klineMissingRetryRef.current[key] || 0
      return (now - lastTry) > retryGapMs
    })
    if (missing.length === 0) return
    for (const s of missing) {
      const key = `${s.market || 'CN'}:${s.symbol}`
      klineMissingRetryRef.current[key] = now
    }
    refreshKlines()
  }, [stocks, klineSummaries, refreshKlines])

  // Agent 配置弹窗：预览未来触发时间（用于自检工作日/周末语义）
  useEffect(() => {
    if (!agentDialogStock) return
    if (!agents || agents.length === 0) return

    const stockAgentMap = new Map((agentDialogStock.agents || []).map(a => [a.agent_name, a]))
    const schedules = new Set<string>()
    for (const agent of agents) {
      if (agent.execution_mode === 'batch') continue
      const sa = stockAgentMap.get(agent.name)
      if (!sa) continue
      const eff = effectiveSchedule(agent, sa)
      if (eff) schedules.add(eff)
    }

    const toFetch = Array.from(schedules).filter(s => !schedulePreviewCache[s] && !schedulePreviewLoading[s])
    if (toFetch.length === 0) return

    let cancelled = false
    ;(async () => {
      // Mark loading
      setSchedulePreviewLoading(prev => {
        const next = { ...prev }
        for (const s of toFetch) next[s] = true
        return next
      })
      try {
        const pairs = await Promise.all(toFetch.map(async s => {
          try {
            const p = await fetchAPI<SchedulePreview>(`/agents/schedule/preview?schedule=${encodeURIComponent(s)}&count=5`)
            return [s, p] as const
          } catch (e) {
            const msg = e instanceof Error ? e.message : '预览失败'
            return [s, { error: msg }] as const
          }
        }))
        if (cancelled) return
        setSchedulePreviewCache(prev => ({ ...prev, ...Object.fromEntries(pairs) }))
      } finally {
        if (cancelled) return
        setSchedulePreviewLoading(prev => {
          const next = { ...prev }
          for (const s of toFetch) next[s] = false
          return next
        })
      }
    })()

    return () => { cancelled = true }
  }, [agentDialogStock, agents, schedulePreviewCache, schedulePreviewLoading])

  // 触发扫描：调用盘中监控扫描，并刷新建议池
  const scanAndReload = useCallback(async () => {
    setScanning(true)
    try {
      const url = '/agents/intraday/scan?analyze=true'
      await fetchAPI(url, { method: 'POST' })
      await loadPoolSuggestions()
      await refreshKlines()
    } catch (e) {
      console.error('扫描失败:', e)
      toast(e instanceof Error ? e.message : '扫描失败', 'error')
    } finally {
      setScanning(false)
    }
  }, [loadPoolSuggestions, refreshKlines, toast])

  // 首次加载后，按需刷新 K 线摘要与建议池
  const initialKlineDone = useRef(false)
  useEffect(() => {
    if (portfolio && portfolio.accounts.length > 0 && !initialKlineDone.current) {
      initialKlineDone.current = true
      refreshKlines()
      loadPoolSuggestions()
    }
  }, [portfolio, refreshKlines, loadPoolSuggestions])

  // Auto-refresh timer
  useEffect(() => {
    if (autoRefresh) {
      const runRefreshCycle = () => {
        refreshQuotes({ silent: true })
        refreshKlines()
        loadPoolSuggestions({ silent: true })
        setNextAutoRefreshAt(Date.now() + refreshInterval * 1000)
      }

      runRefreshCycle()
      refreshTimerRef.current = setInterval(() => {
        runRefreshCycle()
      }, refreshInterval * 1000)
      refreshTickRef.current = setInterval(() => {
        setAutoRefreshTick(Date.now())
      }, 250)
      // 进度更新定时器
      const startTime = Date.now()
      const intervalMs = refreshInterval * 1000
      const tick = () => {
        const elapsed = Date.now() - startTime
        const cycleElapsed = elapsed % intervalMs
        const progress = 1 - cycleElapsed / intervalMs
        setAutoRefreshProgress({ enabled: true, progress })
      }
      tick()
      progressTimerRef.current = setInterval(tick, 100)
    } else {
      // Clear interval when disabled
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
        refreshTimerRef.current = undefined
      }
      if (refreshTickRef.current) {
        clearInterval(refreshTickRef.current)
        refreshTickRef.current = undefined
      }
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current)
        progressTimerRef.current = undefined
      }
      setNextAutoRefreshAt(null)
      setAutoRefreshProgress({ enabled: false, progress: 0 })
    }

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current)
      }
      if (refreshTickRef.current) {
        clearInterval(refreshTickRef.current)
      }
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current)
      }
      setAutoRefreshProgress({ enabled: false, progress: 0 })
    }
  }, [autoRefresh, refreshInterval, refreshQuotes, refreshKlines, loadPoolSuggestions, setAutoRefreshProgress])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
      if (positionDropdownRef.current && !positionDropdownRef.current.contains(e.target as Node)) {
        setShowPositionDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ========== Stock handlers ==========
  const doSearch = async (q: string, market: string = searchMarket) => {
    if (q.length < 1) { setSearchResults([]); setShowDropdown(false); return }
    setSearching(true)
    try {
      const marketParam = market ? `&market=${market}` : ''
      const results = await fetchAPI<SearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}${marketParam}`)
      setSearchResults(results)
      setShowDropdown(results.length > 0)
    } catch { setSearchResults([]) }
    finally { setSearching(false) }
  }

  const handleSearchInput = (value: string) => {
    setSearchQuery(value)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => doSearch(value), 500)
  }

  const handleSearchMarketChange = (market: string) => {
    setSearchMarket(market)
    if (searchQuery) {
      doSearch(searchQuery, market)
    }
  }

  const refreshStockListCache = async () => {
    setRefreshingStockList(true)
    try {
      const result = await fetchAPI<RefreshListResult>('/stocks/refresh-list', { method: 'POST' })
      const stockCount = result.stock_count ?? result.count
      const fundCount = result.fund_count ?? 0
      const message = searchMarket === 'FUND'
        ? `已刷新列表，共 ${fundCount} 只`
        : searchMarket
          ? `已刷新列表，共 ${stockCount} 只`
          : `已刷新列表，共 ${result.count} 只（股票 ${stockCount}，基金 ${fundCount}）`
      toast(message, 'success')
      if (searchQuery) {
        doSearch(searchQuery)
      }
    } catch (e) {
      toast('刷新失败', 'error')
    } finally {
      setRefreshingStockList(false)
    }
  }

  const selectStock = (item: SearchResult) => {
    setStockForm({ symbol: item.symbol, name: item.name, market: item.market })
    setSearchQuery(`${item.symbol} ${item.name}`)
    setShowDropdown(false)
  }

  const handleStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await stocksApi.create(stockForm)
      setStockForm(emptyStockForm)
      setSearchQuery('')
      setShowStockForm(false)
      load()
      toast('添加自选完成', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : '添加自选失败', 'error')
    }
  }

  const hasAnyPositionForStockId = (id: number): boolean => {
    return (portfolio?.accounts || []).some(acc => (acc.positions || []).some(p => p.stock_id === id))
  }

  const removeFromWatchlist = async (stock: Stock) => {
    if (hasAnyPositionForStockId(stock.id)) {
      toast('该股票存在持仓，请先删除持仓后再删除股票', 'error')
      return
    }

    setRemovingWatchStock(true)
    try {
      await stocksApi.remove(stock.id)
      toast('股票已删除', 'success')
      setRemoveWatchStock(null)
      load()
      // 价格提醒/关联配置会随股票删除，刷新一次避免 UI 残留。
      loadPortfolio()
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error')
    } finally {
      setRemovingWatchStock(false)
    }
  }

  // ========== Account handlers ==========
  const openAccountDialog = (account?: Account) => {
    if (account) {
      setAccountForm({
        name: account.name,
        market: (account.market || 'CN').toUpperCase(),
        base_currency: (account.base_currency || 'CNY').toUpperCase(),
        available_funds: account.available_funds.toString(),
      })
      setEditAccountId(account.id)
    } else {
      setAccountForm(emptyAccountForm)
      setEditAccountId(null)
    }
    setAccountDialogOpen(true)
  }

  const handleAccountSubmit = async () => {
    try {
      const payload = {
        name: accountForm.name,
        market: accountForm.market,
        base_currency: accountForm.base_currency,
        available_funds: parseFloat(accountForm.available_funds) || 0,
      }
      if (editAccountId) {
        await fetchAPI(`/accounts/${editAccountId}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await fetchAPI('/accounts', { method: 'POST', body: JSON.stringify(payload) })
      }
      setAccountDialogOpen(false)
      load()
      loadPortfolio()
      toast(editAccountId ? '账户已更新' : '账户已创建', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存账户失败', 'error')
    }
  }

  const handleDeleteAccount = async (id: number) => {
    if (!(await confirm({
      title: '删除账户',
      description: '确定删除该账户？这将同时删除该账户的所有持仓记录。',
      variant: 'destructive',
      confirmText: '删除',
    }))) return
    try {
      await fetchAPI(`/accounts/${id}`, { method: 'DELETE' })
      load()
      loadPortfolio()
      toast('账户已删除', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除账户失败', 'error')
    }
  }

  // ========== Position handlers ==========
  const openPositionDialog = (accountId: number, position?: Position) => {
    setPositionDialogAccountId(accountId)
    setPositionSearchQuery('')
    setPositionSearchResults([])
    setShowPositionDropdown(false)
    if (position) {
      setPositionForm({
        account_id: accountId,
        stock_id: position.stock_id,
        cost_price: position.cost_price.toString(),
        quantity: position.quantity.toString(),
        invested_amount: position.invested_amount?.toString() || '',
        trading_style: position.trading_style || '',
        stock_symbol: position.symbol,
        stock_name: position.name,
        stock_market: position.market,
      })
      setEditPositionId(position.id)
    } else {
      setPositionForm({
        account_id: accountId,
        stock_id: 0,
        cost_price: '',
        quantity: '',
        invested_amount: '',
        trading_style: '',
        stock_symbol: '',
        stock_name: '',
        stock_market: 'CN',
      })
      setEditPositionId(null)
    }
    setPositionDialogOpen(true)
  }

  const doPositionSearch = async (q: string, market: string = positionSearchMarket) => {
    if (q.length < 1) { setPositionSearchResults([]); setShowPositionDropdown(false); return }
    setPositionSearching(true)
    try {
      const marketParam = market ? `&market=${market}` : ''
      const results = await fetchAPI<SearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}${marketParam}`)
      setPositionSearchResults(results)
      setShowPositionDropdown(results.length > 0)
    } catch { setPositionSearchResults([]) }
    finally { setPositionSearching(false) }
  }

  const handlePositionSearchInput = (value: string) => {
    setPositionSearchQuery(value)
    clearTimeout(positionSearchTimer.current)
    positionSearchTimer.current = setTimeout(() => doPositionSearch(value), 500)
  }

  const handlePositionSearchMarketChange = (market: string) => {
    setPositionSearchMarket(market)
    if (positionSearchQuery) {
      doPositionSearch(positionSearchQuery, market)
    }
  }

  const selectPositionStock = (item: SearchResult) => {
    // 检查是否已有此股票
    const existing = stocks.find(s => s.symbol === item.symbol && s.market === item.market)
    setPositionForm({
      ...positionForm,
      stock_id: existing?.id || 0,
      stock_symbol: item.symbol,
      stock_name: item.name,
      stock_market: item.market,
    })
    setPositionSearchQuery(`${item.symbol} ${item.name}`)
    setShowPositionDropdown(false)
  }

  const handlePositionSubmit = async () => {
    try {
      let stockId = positionForm.stock_id

      // 如果是新增且股票不在自选中，先添加到自选
      if (!editPositionId && !stockId && positionForm.stock_symbol) {
        try {
          const newStock = await fetchAPI<Stock>('/stocks', {
            method: 'POST',
            body: JSON.stringify({
              symbol: positionForm.stock_symbol,
              name: positionForm.stock_name,
              market: positionForm.stock_market,
            })
          })
          stockId = newStock.id
          load() // 刷新股票列表
        } catch {
          // 股票可能已存在，尝试获取（兼容并发创建/历史数据）。
          try {
            const existingStocks = await fetchAPI<Stock[]>('/stocks')
            const existing = existingStocks.find(s => s.symbol === positionForm.stock_symbol && s.market === positionForm.stock_market)
            if (existing) {
              stockId = existing.id
            } else {
              toast('添加股票失败', 'error')
              return
            }
          } catch (e) {
            toast(e instanceof Error ? e.message : '添加股票失败', 'error')
            return
          }
        }
      }

      const payload = {
        account_id: positionForm.account_id,
        stock_id: stockId,
        cost_price: parseFloat(positionForm.cost_price),
        quantity: parseInt(positionForm.quantity),
        invested_amount: positionForm.invested_amount ? parseFloat(positionForm.invested_amount) : null,
        trading_style: positionForm.trading_style,  // 空字符串表示清空
      }
      if (editPositionId) {
        await fetchAPI(`/positions/${editPositionId}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await fetchAPI('/positions', { method: 'POST', body: JSON.stringify(payload) })
      }
      setPositionDialogOpen(false)
      loadPortfolio()
      toast(editPositionId ? '持仓已更新' : '持仓已添加', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存持仓失败', 'error')
    }
  }

  const handleDeletePosition = async (id: number) => {
    if (!(await confirm({ description: '确定删除该持仓？', variant: 'destructive', confirmText: '删除' }))) return
    try {
      await fetchAPI(`/positions/${id}`, { method: 'DELETE' })
      loadPortfolio()
      toast('持仓已删除', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除持仓失败', 'error')
    }
  }

  // ========== Agent handlers ==========
  const toggleAgent = async (stock: Stock, agentName: string) => {
    try {
      const current = stock.agents || []
      const isAssigned = current.some(a => a.agent_name === agentName)
      const newAgents = isAssigned
        ? current.filter(a => a.agent_name !== agentName)
        : [...current, { agent_name: agentName, schedule: '', ai_model_id: null, notify_channel_ids: [] }]
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新 Agent 绑定失败', 'error')
    }
  }

  const triggerStockAgent = async (stockId: number, agentName: string) => {
    setTriggeringAgent(agentName)
    setRunningAgents(prev => ({ ...prev, [stockId]: agentName }))
    // 触发后立即关闭配置弹窗，避免多层弹窗干扰
    setAgentDialogStock(null)
    try {
      // 手动触发时跳过节流，方便测试
      const resp = await fetchAPI<{ result: AgentResult; success?: boolean; message?: string }>(
        `/stocks/${stockId}/agents/${agentName}/trigger?bypass_throttle=true`,
        { method: 'POST' }
      )
      const result = resp?.result
      if (result) {
        // 仅提示，不再弹出结果弹窗，避免干扰
        if (result.success === false) {
          toast(result.message || result.content || '执行未通过', 'info')
          return
        }
        const isSkipped = !!result.skipped || /已跳过执行|非交易时段/.test(result.content || '')
        if (isSkipped) {
          toast(result.content || '当前非交易时段，已跳过执行', 'info')
        } else {
          toast(result.should_alert ? 'AI 建议关注' : 'AI 判断无需关注', result.should_alert ? 'success' : 'info')
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '触发失败'
      if (/非交易时段|跳过执行/.test(msg)) {
        toast(msg, 'info')
      } else {
        toast(msg, 'error')
      }
    } finally {
      setTriggeringAgent(null)
      setRunningAgents(prev => ({ ...prev, [stockId]: null }))
    }
  }

  const updateStockAgentModel = async (stock: Stock, agentName: string, modelId: number | null) => {
    try {
      const newAgents = (stock.agents || []).map(a =>
        a.agent_name === agentName ? { ...a, ai_model_id: modelId } : a
      )
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新 Agent 模型失败', 'error')
    }
  }

  const toggleStockAgentChannel = async (stock: Stock, agentName: string, channelId: number) => {
    try {
      const newAgents = (stock.agents || []).map(a => {
        if (a.agent_name !== agentName) return a
        const current = a.notify_channel_ids || []
        const newIds = current.includes(channelId)
          ? current.filter(id => id !== channelId)
          : [...current, channelId]
        return { ...a, notify_channel_ids: newIds }
      })
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新 Agent 通知配置失败', 'error')
    }
  }

  const updateStockAgentSchedule = async (stock: Stock, agentName: string, schedule: string) => {
    try {
      const newAgents = (stock.agents || []).map(a =>
        a.agent_name === agentName ? { ...a, schedule } : a
      )
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新 Agent 调度失败', 'error')
    }
  }

  // ========== Helpers ==========
  const formatMoney = (value: number) => {
    if (Math.abs(value) >= 10000) {
      return `${(value / 10000).toFixed(2)}万`
    }
    return value.toFixed(2)
  }

  const marketLabel = (m: string) => m === 'CN' ? 'A股' : m === 'HK' ? '港股' : m === 'US' ? '美股' : m === 'FUND' ? '基金' : m

  // 市场徽章样式和短标签
  const marketBadge = (m: string) => {
    if (m === 'HK') return { style: 'bg-orange-500/10 text-orange-600', label: '港' }
    if (m === 'US') return { style: 'bg-green-500/10 text-green-600', label: '美' }
    if (m === 'FUND') return { style: 'bg-cyan-500/10 text-cyan-700', label: '基' }
    return { style: 'bg-blue-500/10 text-blue-600', label: 'A' }
  }

  // 保留原始精度显示价格（不强制截断小数位）
  const formatPrice = (value: number) => {
    // 最多显示4位小数，去除末尾的0
    const formatted = value.toFixed(4).replace(/\.?0+$/, '')
    return formatted
  }

  // 获取股票的行情信息
  const getStockQuote = (quoteKey: string) => {
    return quotes[quoteKey] || null
  }

  const getPriceAlertSummary = (symbol: string, market: string) => {
    const key = `${String(market || 'CN').toUpperCase()}:${String(symbol || '').toUpperCase()}`
    return priceAlertSummaryMap[key] || { total: 0, enabled: 0 }
  }

  // 获取股票的建议信息（优先使用建议池，包含来源和时间信息）
  const getSuggestionForStock = (symbol: string, market: string, hasPosition?: boolean): { suggestion: SuggestionInfo | null; kline: KlineSummary | null } => {
    const key = `${market || 'CN'}:${symbol}`
    // 优先使用建议池的建议（包含来源和时间信息）
    const poolSug =
      poolSuggestions[key] ||
      (() => {
        const fallback = poolSuggestions[symbol]
        if (!fallback) return null
        const fm = String(fallback.stock_market || '').toUpperCase()
        return fm && fm !== String(market || 'CN').toUpperCase() ? null : fallback
      })()
    if (poolSug) {
      const preloadedKline = klineSummaries[key] || (suggestions[symbol]?.kline as any) || null
      return {
        suggestion: {
          id: poolSug.id,
          action: poolSug.action,
          action_label: poolSug.action_label,
          signal: poolSug.signal,
          reason: poolSug.reason,
          should_alert: poolSug.should_alert ?? (['alert', 'avoid', 'sell', 'reduce'].includes(poolSug.action)),
          agent_name: poolSug.agent_name,
          agent_label: poolSug.agent_label,
          created_at: poolSug.created_at,
          is_expired: poolSug.is_expired,
          prompt_context: poolSug.prompt_context,
          ai_response: poolSug.ai_response,
          meta: poolSug.meta,
        },
        // 优先使用本页并发预取的 kline 摘要，确保徽章与弹窗一致且免加载
        kline: preloadedKline,
      }
    }

    // 无池建议时，使用 K 线评分构建轻量建议（仅用于徽章展示）
    const ks = klineSummaries[key]
    if (ks) {
      const scored = buildKlineSuggestion(ks as any, hasPosition)
      return {
        suggestion: {
          action: scored.action,
          action_label: scored.action_label,
          signal: scored.signal,
          reason: '',
          should_alert: false,
          agent_label: '技术指标',
        },
        kline: ks,
      }
    }

    return { suggestion: null, kline: null }
  }

  const positionRatio = useMemo(() => {
    if (!portfolio) return null
    const mv = portfolio.total.total_market_value || 0
    const assets = portfolio.total.total_assets || 0
    const pct = assets > 0 ? (mv / assets * 100) : 0
    return { mv, assets, pct }
  }, [portfolio])

  const portfolioDayPnl = useMemo(() => {
    if (!portfolio) return { dayPnl: 0, pct: 0 }
    if (portfolio.total.day_pnl != null) {
      return {
        dayPnl: Number(portfolio.total.day_pnl || 0),
        pct: Number(portfolio.total.day_pnl_pct || 0),
      }
    }
    let dayPnl = 0
    let prevMv = 0
    const allPos = (portfolio.accounts || []).flatMap(a => a.positions || [])
    for (const p of allPos) {
      if (p.current_price_cny == null || p.change_pct == null) continue
      const prev = p.change_pct === -100 ? null : (p.current_price_cny / (1 + p.change_pct / 100))
      if (prev == null || !isFinite(prev)) continue
      const qty = p.quantity || 0
      dayPnl += (p.current_price_cny - prev) * qty
      prevMv += prev * qty
    }
    const pct = prevMv > 0 ? (dayPnl / prevMv * 100) : 0
    return { dayPnl, pct }
  }, [portfolio])

  const positionsCount = useMemo(() => {
    return (portfolio?.accounts || []).reduce((acc, a) => acc + (a.positions?.length || 0), 0)
  }, [portfolio])

  const watchlistCount = useMemo(() => {
    return stocks.length
  }, [stocks])

  const sortedAccounts = useMemo(() => {
    const rows = [...(portfolio?.accounts || [])]
    const factor = accountSortDirection === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      if (accountSortKey === 'name') {
        return a.name.localeCompare(b.name, 'zh-CN') * factor
      }
      const av = Number((a as any)[accountSortKey] ?? 0)
      const bv = Number((b as any)[accountSortKey] ?? 0)
      if (av === bv) {
        return a.name.localeCompare(b.name, 'zh-CN')
      }
      return (av - bv) * factor
    })
    return rows
  }, [portfolio?.accounts, accountSortDirection, accountSortKey])

  const toggleAccountSort = useCallback((key: AccountSortKey) => {
    if (accountSortKey === key) {
      setAccountSortDirection(accountSortDirection === 'asc' ? 'desc' : 'asc')
      return
    }
    setAccountSortKey(key)
    setAccountSortDirection(key === 'name' ? 'asc' : 'desc')
  }, [accountSortDirection, accountSortKey, setAccountSortDirection, setAccountSortKey])

  const togglePositionSort = useCallback((key: PositionSortKey) => {
    if (positionSortKey === key) {
      setPositionSortDirection(positionSortDirection === 'asc' ? 'desc' : 'asc')
      return
    }
    setPositionSortKey(key)
    setPositionSortDirection(key === 'name' || key === 'sort_order' ? 'asc' : 'desc')
  }, [positionSortDirection, positionSortKey, setPositionSortDirection, setPositionSortKey])

  const effectivePositionColumnOrder = useMemo<PositionColumnKey[]>(() => {
    const allowed = new Set<PositionColumnKey>(POSITION_COLUMN_DEFAULT_ORDER)
    const current = Array.isArray(positionColumnOrder) ? positionColumnOrder : []
    const picked: PositionColumnKey[] = []
    for (const item of current) {
      if (!allowed.has(item)) continue
      if (picked.includes(item)) continue
      picked.push(item)
    }
    for (const key of POSITION_COLUMN_DEFAULT_ORDER) {
      if (!picked.includes(key)) picked.push(key)
    }
    return picked
  }, [positionColumnOrder])

  const movePositionColumn = useCallback((from: PositionColumnKey, to: PositionColumnKey) => {
    if (from === to) return
    const next = [...effectivePositionColumnOrder]
    const fromIdx = next.indexOf(from)
    const toIdx = next.indexOf(to)
    if (fromIdx < 0 || toIdx < 0) return
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    setPositionColumnOrder(next)
  }, [effectivePositionColumnOrder, setPositionColumnOrder])

  const flashClassByDir = (dir?: 'up' | 'down' | 'neutral') => {
    if (dir === 'up') return 'animate-highlight-fade-up'
    if (dir === 'down') return 'animate-highlight-fade-down'
    return 'animate-highlight-fade-neutral'
  }

  const getPortfolioKpiFlashClass = (key: string) => {
    const item = portfolioKpiFlashMap[key]
    return item ? flashClassByDir(item.dir) : ''
  }

  const getPortfolioKpiFlashKey = (key: string) => portfolioKpiFlashMap[key]?.key ?? 0

  useEffect(() => {
    if (!portfolio) {
      prevPortfolioKpiRef.current = {}
      return
    }
    const nextValues: Record<string, number> = {
      marketValue: portfolio.total.total_market_value || 0,
      totalPnl: portfolio.total.total_pnl || 0,
      dayPnl: portfolioDayPnl.dayPnl || 0,
      assets: portfolio.total.total_assets || 0,
    }
    const prev = prevPortfolioKpiRef.current
    const updates: Record<string, { dir: 'up' | 'down' | 'neutral' }> = {}
    for (const [k, v] of Object.entries(nextValues)) {
      if (!(k in prev)) continue
      const delta = v - prev[k]
      updates[k] = { dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral' }
    }
    if (Object.keys(updates).length > 0) {
      setPortfolioKpiFlashMap(prevMap => {
        const merged = { ...prevMap }
        for (const [k, v] of Object.entries(updates)) {
          merged[k] = {
            key: (prevMap[k]?.key ?? 0) + 1,
            dir: v.dir,
          }
        }
        return merged
      })
    }
    prevPortfolioKpiRef.current = nextValues
  }, [portfolio, portfolioDayPnl, positionRatio])

  useEffect(() => {
    const changed: Record<string, 'up' | 'down' | 'neutral'> = {}
    const nextPrev: Record<string, { current_price: number | null; change_pct: number | null }> = { ...prevWatchlistQuoteRef.current }
    for (const stock of stocks) {
      const key = `${stock.market}:${stock.symbol}`
      const quote = quotes[key]
      if (!quote) continue
      const current = {
        current_price: quote.current_price ?? null,
        change_pct: quote.change_pct ?? null,
      }
      const prev = prevWatchlistQuoteRef.current[key]
      if (prev) {
        const prevPrice = prev.current_price ?? 0
        const currPrice = current.current_price ?? 0
        const delta = currPrice - prevPrice
        changed[key] = delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral'
      }
      nextPrev[key] = current
    }
    prevWatchlistQuoteRef.current = nextPrev
    const changedKeys = Object.keys(changed)
    if (changedKeys.length === 0) return
    setWatchlistQuoteFlashMap(prev => ({ ...prev, ...changed }))
    const timer = window.setTimeout(() => {
      setWatchlistQuoteFlashMap(prev => {
        const next = { ...prev }
        for (const key of changedKeys) delete next[key]
        return next
      })
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [quotes, stocks])

  const toggleAccountExpanded = (id: number) => {
    setExpandedAccounts(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 骨架屏：初始加载时显示
  if (loading) {
    return (
      <div>
        {/* Header Skeleton */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <Skeleton className="h-6 w-16 mb-2" />
            <Skeleton className="h-4 w-32" />
          </div>
          <div className="hidden md:flex items-center gap-3">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-24" />
          </div>
        </div>
        {/* Summary Cards Skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-4">
              <Skeleton className="h-4 w-16 mb-2" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
        {/* Account List Skeleton */}
        <div className="space-y-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="card">
              <div className="px-4 py-3 border-b border-border/50">
                <Skeleton className="h-5 w-32" />
              </div>
              <div className="divide-y divide-border/50">
                {[...Array(3)].map((_, j) => (
                  <div key={j} className="px-4 py-3 flex items-center gap-4">
                    <Skeleton className="h-4 w-16" />
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-16 ml-auto" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-3 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-[20px] md:text-[22px] font-bold text-foreground tracking-tight">持仓</h1>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {marketStatus.map(m => {
                const statusColors: Record<string, string> = {
                  trading: 'bg-emerald-500',
                  pre_market: 'bg-amber-500',
                  break: 'bg-amber-500',
                  after_hours: 'bg-slate-400',
                  closed: 'bg-slate-400',
                }
                return (
                  <div key={m.code} className="flex items-center gap-1" title={`${m.sessions.join(', ')} (${m.local_time})`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusColors[m.status] || 'bg-slate-400'}`} />
                    <span className="text-[11px] text-muted-foreground">{m.name}</span>
                    <span className={`text-[10px] ${m.is_trading ? 'text-emerald-600' : 'text-muted-foreground/60'}`}>
                      {m.status_text}
                    </span>
                  </div>
                )
              })}
              {lastRefreshTime ? (
                <div className="px-2.5 py-0.5 rounded-full bg-background/70 border border-border/50 text-[10px] text-muted-foreground">
                  更新 <span className="font-mono text-foreground/90">{lastRefreshTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                </div>
              ) : null}
            </div>
          </div>
          {/* Desktop buttons + controls */}
          <div className="hidden md:flex items-center gap-3">
            {/* Controls */}
            <div className="flex items-center gap-2 md:gap-3 px-2 md:px-3 py-2 rounded-2xl bg-accent/20 border border-border/40">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] md:text-[12px] text-muted-foreground">展示</span>
                <Select value={displayCurrency} onValueChange={v => setDisplayCurrency(v as 'CNY' | 'HKD' | 'USD')}>
                  <SelectTrigger className="h-6 w-[70px] text-[10px] md:text-[11px] px-1.5 md:px-2">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CNY">CNY</SelectItem>
                    <SelectItem value="HKD">HKD</SelectItem>
                    <SelectItem value="USD">USD</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="w-px h-4 bg-border" />
              <div className="flex items-center gap-1 md:gap-1.5">
                <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} className="scale-90" />
                <span className="text-[11px] md:text-[12px] text-muted-foreground">自动刷新</span>
                {autoRefresh && (
                  <Select value={refreshInterval.toString()} onValueChange={v => setRefreshInterval(parseInt(v))}>
                    <SelectTrigger className="h-6 w-14 md:w-16 text-[10px] md:text-[11px] px-1.5 md:px-2">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="10">10s</SelectItem>
                      <SelectItem value="30">30s</SelectItem>
                      <SelectItem value="60">1分钟</SelectItem>
                      <SelectItem value="120">2分钟</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            {/* Buttons */}
            <Button variant="secondary" onClick={scanAndReload} disabled={scanning}>
              <Bot className="w-4 h-4" /> 扫描
            </Button>
            <Button variant="secondary" onClick={() => openAccountDialog()}>
              <Building2 className="w-4 h-4" /> 添加账户
            </Button>
            <Button onClick={() => { setStockForm(emptyStockForm); setSearchQuery(''); setShowStockForm(true) }}>
              <Plus className="w-4 h-4" /> 添加自选
            </Button>
          </div>
          {/* Mobile buttons */}
          <div className="flex md:hidden items-center gap-1.5">
            <Button variant="secondary" size="sm" className="h-8 w-8 p-0" onClick={scanAndReload} disabled={scanning}>
              <Bot className="w-4 h-4" />
            </Button>
            <Button variant="secondary" size="sm" className="h-8 w-8 p-0" onClick={() => openAccountDialog()}>
              <Building2 className="w-4 h-4" />
            </Button>
            <Button size="sm" className="h-8 w-8 p-0" onClick={() => { setStockForm(emptyStockForm); setSearchQuery(''); setShowStockForm(true) }}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>
        {/* Mobile Controls row */}
        <div className="flex md:hidden items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 md:gap-3 px-2 md:px-3 py-2 rounded-2xl bg-accent/20 border border-border/40">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">展示</span>
              <Select value={displayCurrency} onValueChange={v => setDisplayCurrency(v as 'CNY' | 'HKD' | 'USD')}>
                <SelectTrigger className="h-6 w-[70px] text-[10px] px-1.5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CNY">CNY</SelectItem>
                  <SelectItem value="HKD">HKD</SelectItem>
                  <SelectItem value="USD">USD</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-px h-4 bg-border" />
            <div className="flex items-center gap-1 md:gap-1.5">
              <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} className="scale-90" />
              <span className="text-[11px] text-muted-foreground">自动刷新</span>
              {autoRefresh && (
                <Select value={refreshInterval.toString()} onValueChange={v => setRefreshInterval(parseInt(v))}>
                  <SelectTrigger className="h-6 w-14 text-[10px] px-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10s</SelectItem>
                    <SelectItem value="30">30s</SelectItem>
                    <SelectItem value="60">1分钟</SelectItem>
                    <SelectItem value="120">2分钟</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
            {poolSuggestionsLoading && (
              <>
                <div className="w-px h-4 bg-border" />
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Portfolio Total Summary */}
      {portfolioLoading && !portfolio ? (
        // 首次加载时显示骨架屏
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : portfolio ? (
        <>
          <div className="mb-2 text-[11px] text-muted-foreground">汇总展示币种: {portfolio.display_currency || portfolio.total.display_currency || 'CNY'}</div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          <div key={`mv-${getPortfolioKpiFlashKey('marketValue')}`} className={`card p-4 ${getPortfolioKpiFlashClass('marketValue')}`}>
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="w-4 h-4" />
              <span className="text-[12px]">总市值</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {formatMoney(portfolio.total.total_market_value)}
            </div>
          </div>
          <div key={`pnl-${getPortfolioKpiFlashKey('totalPnl')}`} className={`card p-4 ${getPortfolioKpiFlashClass('totalPnl')}`}>
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              {portfolio.total.total_pnl >= 0 ? (
                <ArrowUpRight className="w-4 h-4 text-rose-500" />
              ) : (
                <ArrowDownRight className="w-4 h-4 text-emerald-500" />
              )}
              <span className="text-[12px]">总盈亏</span>
            </div>
            <div className={`text-[20px] font-bold font-mono ${portfolio.total.total_pnl >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
              {portfolio.total.total_pnl >= 0 ? '+' : ''}{formatMoney(portfolio.total.total_pnl)}
              <span className="text-[13px] ml-1.5">
                ({portfolio.total.total_pnl_pct >= 0 ? '+' : ''}{portfolio.total.total_pnl_pct.toFixed(2)}%)
              </span>
            </div>
          </div>

          {(() => {
            const isUp = portfolioDayPnl.dayPnl >= 0
            return (
              <div key={`day-pnl-${getPortfolioKpiFlashKey('dayPnl')}`} className={`card p-4 ${getPortfolioKpiFlashClass('dayPnl')}`}>
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  {isUp ? (
                    <ArrowUpRight className="w-4 h-4 text-rose-500" />
                  ) : (
                    <ArrowDownRight className="w-4 h-4 text-emerald-500" />
                  )}
                  <span className="text-[12px]">今日盈亏</span>
                </div>
                <div className={`text-[20px] font-bold font-mono ${isUp ? 'text-rose-500' : 'text-emerald-500'}`}>
                  {isUp ? '+' : ''}{formatMoney(portfolioDayPnl.dayPnl)}
                  <span className="text-[13px] ml-1.5">({portfolioDayPnl.pct >= 0 ? '+' : ''}{portfolioDayPnl.pct.toFixed(2)}%)</span>
                </div>
              </div>
            )
          })()}

          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Wallet className="w-4 h-4" />
              <span className="text-[12px]">可用资金</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {formatMoney(portfolio.total.available_funds)}
            </div>
          </div>
          <div key={`assets-${getPortfolioKpiFlashKey('assets')}`} className={`card p-4 ${getPortfolioKpiFlashClass('assets')}`}>
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <PiggyBank className="w-4 h-4" />
              <span className="text-[12px]">总资产</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {formatMoney(portfolio.total.total_assets)}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Bell className="w-4 h-4" />
              <span className="text-[12px]">仓位占比</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {positionRatio ? `${positionRatio.pct.toFixed(1)}%` : '--'}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground line-clamp-1">
              {positionRatio ? `持仓市值 ${formatMoney(positionRatio.mv)} / 总资产 ${formatMoney(positionRatio.assets)}` : '—'}
            </div>
          </div>
          </div>
        </>
      ) : null}

      {/* Tabs: Positions / Watchlist */}
      <div className="mb-4">
        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-accent/30">
          <button
            onClick={() => setViewTab('positions')}
            className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${
              viewTab === 'positions'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            持仓 <span className="ml-1 font-mono text-[11px] opacity-70">{positionsCount}</span>
          </button>
          <button
            onClick={() => setViewTab('watchlist')}
            className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${
              viewTab === 'watchlist'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            关注 <span className="ml-1 font-mono text-[11px] opacity-70">{watchlistCount}</span>
          </button>
        </div>
      </div>

      {/* Add Watchlist Dialog */}
      <Dialog open={showStockForm} onOpenChange={(open) => { setShowStockForm(open); if (!open) { setSearchQuery(''); setSearchMarket('') } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>添加自选</DialogTitle>
            <DialogDescription>搜索并添加股票或基金到自选列表</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleStockSubmit}>
            <div className="relative" ref={dropdownRef}>
              <div className="flex items-center gap-2 mb-2">
                <Label className="mb-0">搜索标的</Label>
                <div className="flex items-center gap-1">
                  {[
                    { value: '', label: '全部' },
                    { value: 'CN', label: 'A股' },
                    { value: 'HK', label: '港股' },
                    { value: 'US', label: '美股' },
                    { value: 'FUND', label: '基金' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleSearchMarketChange(opt.value)}
                      className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                        searchMarket === opt.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={refreshStockListCache}
                  disabled={refreshingStockList}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-2"
                  title="搜索不到？点击刷新标的列表"
                >
                  {refreshingStockList ? (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="w-3 h-3 animate-spin" /> 刷新中...
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="w-3 h-3" /> 刷新列表
                    </span>
                  )}
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                <Input
                  value={searchQuery}
                  onChange={e => handleSearchInput(e.target.value)}
                  onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
                  placeholder={searchMarket === 'HK' ? '代码或名称，如 00700 或 腾讯' : searchMarket === 'US' ? '代码或名称，如 AAPL 或 苹果' : searchMarket === 'FUND' ? '基金代码或名称，如 001186 或 富国文体健康' : '代码或名称，如 600519 或 茅台'}
                  className="pl-10"
                  autoComplete="off"
                />
                {searching && <span className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />}
              </div>
              {showDropdown && (
                <div className="absolute z-50 w-full mt-2 max-h-64 overflow-auto scrollbar card shadow-lg">
                  {searchResults.map(item => (
                    <button
                      key={`${item.market}-${item.symbol}`}
                      type="button"
                      onClick={() => selectStock(item)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-[13px] hover:bg-accent/50 text-left transition-colors"
                    >
                      <span className="font-mono text-muted-foreground text-[12px] w-14">{item.symbol}</span>
                      <span className="flex-1 font-medium text-foreground">{item.name}</span>
                      <Badge variant="secondary">{marketLabel(item.market)}</Badge>
                    </button>
                  ))}
                </div>
              )}
              {stockForm.symbol && (
                <div className="mt-2.5 flex items-center gap-2">
                  <Badge><span className="font-mono">{stockForm.symbol}</span> {stockForm.name}</Badge>
                  <Badge variant="secondary">{marketLabel(stockForm.market)}</Badge>
                </div>
              )}
            </div>
            <div className="mt-6 flex items-center gap-3 justify-end">
              <Button type="button" variant="ghost" onClick={() => { setShowStockForm(false); setSearchQuery('') }}>取消</Button>
              <Button type="submit" disabled={!stockForm.symbol}>确认添加</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Accounts & Positions */}
      {viewTab === 'positions' && (
        portfolio && portfolio.accounts.length === 0 ? (
          <div className="card flex flex-col items-center justify-center py-20">
            <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
              <Building2 className="w-6 h-6 text-primary" />
            </div>
            <p className="text-[15px] font-semibold text-foreground">还没有账户</p>
            <p className="text-[13px] text-muted-foreground mt-1.5">点击"添加账户"创建你的第一个交易账户</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="card p-2 md:p-3">
              <div className="hidden md:grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr] gap-2 text-[11px]">
                {[
                  { key: 'name', label: '账户名称' },
                  { key: 'total_assets', label: '总资产' },
                  { key: 'total_pnl', label: '总盈亏' },
                  { key: 'day_pnl', label: '今日盈亏' },
                  { key: 'available_funds', label: '可用资金' },
                ].map((col) => {
                  const active = accountSortKey === col.key
                  return (
                    <button
                      key={col.key}
                      type="button"
                      onClick={() => toggleAccountSort(col.key as AccountSortKey)}
                      className={`text-left px-2 py-1.5 rounded transition-colors ${active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'}`}
                    >
                      {col.label}{active ? (accountSortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                    </button>
                  )
                })}
              </div>
              <div className="md:hidden">
                <Select
                  value={`${accountSortKey}:${accountSortDirection}`}
                  onValueChange={(v) => {
                    const [k, d] = v.split(':')
                    setAccountSortKey(k as AccountSortKey)
                    setAccountSortDirection((d as SortDirection) || 'desc')
                  }}
                >
                  <SelectTrigger className="h-8 text-[12px]">
                    <SelectValue placeholder="账户排序" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="total_assets:desc">总资产（高→低）</SelectItem>
                    <SelectItem value="total_assets:asc">总资产（低→高）</SelectItem>
                    <SelectItem value="total_pnl:desc">总盈亏（高→低）</SelectItem>
                    <SelectItem value="total_pnl:asc">总盈亏（低→高）</SelectItem>
                    <SelectItem value="day_pnl:desc">今日盈亏（高→低）</SelectItem>
                    <SelectItem value="day_pnl:asc">今日盈亏（低→高）</SelectItem>
                    <SelectItem value="available_funds:desc">可用资金（高→低）</SelectItem>
                    <SelectItem value="available_funds:asc">可用资金（低→高）</SelectItem>
                    <SelectItem value="name:asc">账户名称（A→Z）</SelectItem>
                    <SelectItem value="name:desc">账户名称（Z→A）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {sortedAccounts.map(account => {
                const sortedPositions = [...(account.positions || [])]
                const factor = positionSortDirection === 'asc' ? 1 : -1
                sortedPositions.sort((a, b) => {
                  if (positionSortKey === 'sort_order') {
                    return ((a.sort_order || 0) - (b.sort_order || 0)) * factor
                  }
                  if (positionSortKey === 'name') {
                    return a.name.localeCompare(b.name, 'zh-CN') * factor
                  }
                  const av = Number((a as any)[positionSortKey] ?? Number.NEGATIVE_INFINITY)
                  const bv = Number((b as any)[positionSortKey] ?? Number.NEGATIVE_INFINITY)
                  if (av === bv) return a.name.localeCompare(b.name, 'zh-CN')
                  return (av - bv) * factor
                })
                const dragEnabled = positionSortKey === 'sort_order'
                const showNativeAvailableFunds = account.available_funds_native != null
                  && (account.base_currency || 'CNY').toUpperCase() !== displayCurrency
                return (
              <div key={account.id} className="card overflow-hidden">
              {/* Account Header */}
              <div
                className="flex flex-col md:flex-row md:items-center justify-between p-3 md:p-4 cursor-pointer hover:bg-accent/30 transition-colors gap-2"
                onClick={() => toggleAccountExpanded(account.id)}
              >
                <div className="flex items-center gap-2 md:gap-3">
                  {expandedAccounts.has(account.id) ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  )}
                  <Building2 className="w-4 h-4 text-primary" />
                  <span className="text-[14px] md:text-[15px] font-semibold text-foreground">{account.name}</span>
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{marketLabel(account.market)}</Badge>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0">{account.base_currency}</Badge>
                  <span className="text-[11px] md:text-[12px] text-muted-foreground">
                    {account.positions.length} 只
                  </span>
                </div>
                <div className="flex items-center justify-between md:justify-end gap-3 md:gap-4 pl-6 md:pl-0">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 md:gap-x-6 gap-y-2">
                    <div className="text-left sm:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">市值</div>
                      <div className="text-[12px] md:text-[13px] font-mono font-medium">{formatMoney(account.total_market_value)}</div>
                    </div>
                    <div className="text-left sm:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">盈亏</div>
                      <div className={`text-[12px] md:text-[13px] font-mono font-medium ${account.total_pnl >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                        {account.total_pnl >= 0 ? '+' : ''}{formatMoney(account.total_pnl)}
                        <span className="text-[10px] md:text-[11px] ml-1">({account.total_pnl_pct >= 0 ? '+' : ''}{account.total_pnl_pct.toFixed(2)}%)</span>
                      </div>
                    </div>
                    <div className="text-left sm:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">今日</div>
                      <div className={`text-[12px] md:text-[13px] font-mono font-medium ${(account.day_pnl || 0) >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                        {(account.day_pnl || 0) >= 0 ? '+' : ''}{formatMoney(account.day_pnl || 0)}
                        <span className="text-[10px] md:text-[11px] ml-1">({(account.day_pnl_pct || 0) >= 0 ? '+' : ''}{Number(account.day_pnl_pct || 0).toFixed(2)}%)</span>
                      </div>
                    </div>
                    <div className="text-left sm:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">可用</div>
                      <div className="text-[12px] md:text-[13px] font-mono">
                        {formatMoney(account.available_funds)}
                        {showNativeAvailableFunds && (
                          <span className="text-[10px] md:text-[11px] text-muted-foreground ml-1 align-middle">
                            {account.available_funds_native!.toFixed(2)} {account.base_currency}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 md:gap-1" onClick={e => e.stopPropagation()}>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8" onClick={() => openPositionDialog(account.id)}>
                      <Plus className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8" onClick={() => openAccountDialog(accounts.find(a => a.id === account.id))}>
                      <Pencil className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8 hover:text-destructive" onClick={() => handleDeleteAccount(account.id)}>
                      <Trash2 className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Positions */}
              {expandedAccounts.has(account.id) && (
                <div className="border-t border-border/30">
                  {account.positions.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground text-center py-8">暂无持仓，点击 + 添加</p>
                  ) : (
                    <>
                      {/* Desktop Table */}
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-border/30 bg-accent/20">
                              {effectivePositionColumnOrder.map((colKey) => {
                                const col = POSITION_COLUMN_META[colKey]
                                const active = positionSortKey === colKey
                                return (
                                  <th
                                    key={colKey}
                                    className={`px-4 py-2 text-[11px] font-semibold ${col.align}`}
                                    draggable
                                    onDragStart={() => setDraggingPositionColumn(colKey)}
                                    onDragOver={(e) => {
                                      e.preventDefault()
                                      e.dataTransfer.dropEffect = 'move'
                                    }}
                                    onDrop={(e) => {
                                      e.preventDefault()
                                      if (draggingPositionColumn) {
                                        movePositionColumn(draggingPositionColumn, colKey)
                                      }
                                      setDraggingPositionColumn(null)
                                    }}
                                    onDragEnd={() => setDraggingPositionColumn(null)}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => togglePositionSort(colKey as PositionSortKey)}
                                      className={`inline-flex items-center gap-1 ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                                    >
                                      {col.label}{active ? (positionSortDirection === 'asc' ? ' ↑' : ' ↓') : ''}
                                    </button>
                                  </th>
                                )
                              })}
                              <th className="text-center px-4 py-2 text-[11px] font-semibold text-muted-foreground">风格</th>
                              <th className="text-left px-4 py-2 text-[11px] font-semibold text-muted-foreground">Agent</th>
                              <th className="text-center px-4 py-2 text-[11px] font-semibold text-muted-foreground">操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sortedPositions.map((pos, i) => {
                              const stock = stocks.find(s => s.id === pos.stock_id)
                              const badge = marketBadge(pos.market)
                              const isForeign = pos.market === 'HK' || pos.market === 'US'
                              const changeColor = pos.change_pct != null
                                ? (pos.change_pct > 0 ? 'text-rose-500' : pos.change_pct < 0 ? 'text-emerald-500' : 'text-muted-foreground')
                                : 'text-muted-foreground'
                              const pnlColor = pos.pnl != null
                                ? (pos.pnl > 0 ? 'text-rose-500' : pos.pnl < 0 ? 'text-emerald-500' : 'text-muted-foreground')
                                : 'text-muted-foreground'
                              return (
                                <tr
                                  key={pos.id}
                                  draggable={dragEnabled}
                                  onDragStart={(e) => {
                                    if (!dragEnabled) return
                                    positionDragSnapshotRef.current = portfolioRaw ? JSON.parse(JSON.stringify(portfolioRaw)) : null
                                    setDraggingPositionId(pos.id)
                                    setDraggingPositionAccountId(account.id)
                                    e.dataTransfer.effectAllowed = 'move'
                                  }}
                                  onDragOver={(e) => {
                                    if (!dragEnabled) return
                                    e.preventDefault()
                                    e.dataTransfer.dropEffect = 'move'
                                    if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                      previewPositionReorder(account.id, draggingPositionId, pos.id)
                                    }
                                  }}
                                  onDrop={(e) => {
                                    if (!dragEnabled) return
                                    e.preventDefault()
                                    if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                      commitPositionReorder(account.id)
                                    }
                                    setDraggingPositionId(null)
                                    setDraggingPositionAccountId(null)
                                    positionDragSnapshotRef.current = null
                                  }}
                                  onDragEnd={() => {
                                    if (!dragEnabled) return
                                    setDraggingPositionId(null)
                                    setDraggingPositionAccountId(null)
                                    positionDragSnapshotRef.current = null
                                  }}
                                  className={`group hover:bg-accent/30 transition-colors ${i > 0 ? 'border-t border-border/20' : ''} ${draggingPositionId === pos.id ? 'opacity-60' : ''}`}
                                >
                                  {effectivePositionColumnOrder.map((colKey) => {
                                    if (colKey === 'name') {
                                      return (
                                        <td key={`${pos.id}-name`} className="px-4 py-2.5">
                                          <span className={`text-[9px] px-1 py-0.5 rounded mr-1.5 ${badge.style}`}>{badge.label}</span>
                                          <span className="font-mono text-[12px] font-semibold text-foreground">
                                            {pos.symbol}
                                          </span>
                                          <button
                                            className="ml-1.5 text-[12px] text-muted-foreground hover:text-primary"
                                            onClick={() => openStockDetail(pos.symbol, pos.market, pos.name, true)}
                                          >
                                            {pos.name}
                                          </button>
                                          {(() => {
                                            const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market, true)
                                            return (suggestion || kline) ? (
                                              <span className="ml-2">
                                                <SuggestionBadge
                                                  suggestion={suggestion}
                                                  stockName={pos.name}
                                                  stockSymbol={pos.symbol}
                                                  kline={kline}
                                                  market={pos.market}
                                                  hasPosition={true}
                                                />
                                              </span>
                                            ) : null
                                          })()}
                                        </td>
                                      )
                                    }
                                    if (colKey === 'current_price') {
                                      return (
                                        <td key={`${pos.id}-current_price`} className={`px-4 py-2.5 text-right font-mono text-[12px] ${changeColor}`}>
                                          {pos.current_price != null ? <span>{pos.current_price.toFixed(2)}{isForeign ? (pos.market === 'HK' ? ' HKD' : ' USD') : ''}</span> : '—'}
                                        </td>
                                      )
                                    }
                                    if (colKey === 'change_pct') {
                                      return (
                                        <td key={`${pos.id}-change_pct`} className={`px-4 py-2.5 text-right font-mono text-[12px] ${changeColor}`}>
                                          {pos.change_pct != null ? `${pos.change_pct >= 0 ? '+' : ''}${pos.change_pct.toFixed(2)}%` : '—'}
                                        </td>
                                      )
                                    }
                                    if (colKey === 'day_pnl') {
                                      return (
                                        <td key={`${pos.id}-day_pnl`} className={`px-4 py-2.5 text-right font-mono text-[12px] ${(pos.day_pnl || 0) >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                                          {pos.day_pnl != null ? (
                                            <div className="flex flex-col items-end">
                                              <span>{pos.day_pnl >= 0 ? '+' : ''}{formatMoney(pos.day_pnl)}</span>
                                              <span className="text-[10px] opacity-70">{pos.day_pnl_pct != null ? `${pos.day_pnl_pct >= 0 ? '+' : ''}${pos.day_pnl_pct.toFixed(2)}%` : ''}</span>
                                            </div>
                                          ) : '—'}
                                        </td>
                                      )
                                    }
                                    if (colKey === 'cost_price') {
                                      return <td key={`${pos.id}-cost_price`} className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{formatPrice(pos.cost_price)}</td>
                                    }
                                    if (colKey === 'quantity') {
                                      return <td key={`${pos.id}-quantity`} className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{pos.quantity}</td>
                                    }
                                    if (colKey === 'market_value') {
                                      return (
                                        <td key={`${pos.id}-market_value`} className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">
                                          {pos.market_value != null ? (
                                            <div className="flex flex-col items-end">
                                              {isForeign ? (
                                                <>
                                                  <span>{formatMoney(pos.market_value)} {pos.market === 'HK' ? 'HKD' : 'USD'}</span>
                                                  {pos.market_value_cny && <span className="text-[10px] text-muted-foreground/60">≈{formatMoney(pos.market_value_cny)}</span>}
                                                </>
                                              ) : <span>{formatMoney(pos.market_value)}</span>}
                                            </div>
                                          ) : '—'}
                                        </td>
                                      )
                                    }
                                    return (
                                      <td key={`${pos.id}-pnl`} className={`px-4 py-2.5 text-right font-mono text-[12px] ${pnlColor}`}>
                                        {pos.pnl != null ? (
                                          <div className="flex flex-col items-end">
                                            <span>{pos.pnl >= 0 ? '+' : ''}{formatMoney(pos.pnl)}</span>
                                            <span className="text-[10px] opacity-70">{pos.pnl_pct != null ? `${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(2)}%` : ''}{isForeign && ' CNY'}</span>
                                          </div>
                                        ) : '—'}
                                      </td>
                                    )
                                  })}
                                  <td className="px-4 py-2.5 text-center">
                                    {pos.trading_style ? (
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${pos.trading_style === 'short' ? 'bg-rose-500/10 text-rose-600' : pos.trading_style === 'long' ? 'bg-blue-500/10 text-blue-600' : 'bg-amber-500/10 text-amber-600'}`}>
                                        {pos.trading_style === 'short' ? '短线' : pos.trading_style === 'long' ? '长线' : '波段'}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-muted-foreground/50">-</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    {stock && (
                                      <button onClick={() => setAgentDialogStock(stock)} className="flex items-center gap-1.5 hover:opacity-70 transition-opacity">
                                        {stock.agents && stock.agents.length > 0 ? (
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            {stock.agents.map(sa => {
                                              const agent = agents.find(a => a.name === sa.agent_name)
                                              const isRunning = runningAgents[stock.id] === sa.agent_name
                                              return (
                                                <span key={sa.agent_name} className="inline-flex items-center gap-1">
                                                  <Badge variant="default" className="text-[10px]">{agent?.display_name || sa.agent_name}</Badge>
                                                  {isRunning && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                                                      <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                                                      执行中
                                                    </span>
                                                  )}
                                                </span>
                                              )
                                            })}
                                          </div>
                                        ) : (
                                          <span className="text-[11px] text-muted-foreground/50 flex items-center gap-1"><Bot className="w-3 h-3" /> 未配置</span>
                                        )}
                                      </button>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      {(() => { const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market, true); return (!suggestion && !kline && pos.market !== 'FUND') ? (
                                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openKlineDialog(pos.symbol, pos.market, pos.name, true)} title="K线指标"><BarChart3 className="w-3 h-3" /></Button>
                                      ) : null })()}
                                      <StockPriceAlertPanel
                                        mode="icon"
                                        stockId={pos.stock_id}
                                        symbol={pos.symbol}
                                        market={pos.market}
                                        stockName={pos.name}
                                        initialTotal={getPriceAlertSummary(pos.symbol, pos.market).total}
                                        initialEnabled={getPriceAlertSummary(pos.symbol, pos.market).enabled}
                                        onChanged={loadPriceAlertSummaries}
                                      />
                                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openIntelCenter('report', pos.symbol, pos.market, pos.name)} title="相关报告"><FileText className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openIntelCenter('news', pos.symbol, pos.market, pos.name)} title="相关资讯"><Newspaper className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openPositionDialog(account.id, pos)}><Pencil className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => handleDeletePosition(pos.id)}><Trash2 className="w-3 h-3" /></Button>
                                    </div>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile Cards */}
                      <div className="md:hidden divide-y divide-border/30">
                        {sortedPositions.map(pos => {
                          const stock = stocks.find(s => s.id === pos.stock_id)
                          const badge = marketBadge(pos.market)
                          const changeColor = pos.change_pct != null
                            ? (pos.change_pct > 0 ? 'text-rose-500' : pos.change_pct < 0 ? 'text-emerald-500' : 'text-muted-foreground')
                            : 'text-muted-foreground'
                          const pnlColor = pos.pnl != null
                            ? (pos.pnl > 0 ? 'text-rose-500' : pos.pnl < 0 ? 'text-emerald-500' : 'text-muted-foreground')
                            : 'text-muted-foreground'
                          return (
                            <div
                              key={pos.id}
                              draggable={dragEnabled}
                              onDragStart={(e) => {
                                if (!dragEnabled) return
                                positionDragSnapshotRef.current = portfolioRaw ? JSON.parse(JSON.stringify(portfolioRaw)) : null
                                setDraggingPositionId(pos.id)
                                setDraggingPositionAccountId(account.id)
                                e.dataTransfer.effectAllowed = 'move'
                              }}
                              onDragOver={(e) => {
                                if (!dragEnabled) return
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                  previewPositionReorder(account.id, draggingPositionId, pos.id)
                                }
                              }}
                              onDrop={(e) => {
                                if (!dragEnabled) return
                                e.preventDefault()
                                if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                  commitPositionReorder(account.id)
                                }
                                setDraggingPositionId(null)
                                setDraggingPositionAccountId(null)
                                positionDragSnapshotRef.current = null
                              }}
                              onDragEnd={() => {
                                if (!dragEnabled) return
                                setDraggingPositionId(null)
                                setDraggingPositionAccountId(null)
                                positionDragSnapshotRef.current = null
                              }}
                              className={`p-3 hover:bg-accent/30 transition-colors ${draggingPositionId === pos.id ? 'opacity-60' : ''}`}
                            >
                              {/* Row 1: Stock info + Current price */}
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className={`text-[9px] px-1 py-0.5 rounded ${badge.style}`}>{badge.label}</span>
                                  <span className="font-mono text-[12px] font-semibold text-foreground">
                                    {pos.symbol}
                                  </span>
                                  <button
                                    className="text-[12px] text-muted-foreground hover:text-primary"
                                    onClick={() => openStockDetail(pos.symbol, pos.market, pos.name, true)}
                                  >
                                    {pos.name}
                                  </button>
                                  {pos.trading_style && (
                                    <span className={`text-[9px] px-1 py-0.5 rounded ${pos.trading_style === 'short' ? 'bg-rose-500/10 text-rose-600' : pos.trading_style === 'long' ? 'bg-blue-500/10 text-blue-600' : 'bg-amber-500/10 text-amber-600'}`}>
                                      {pos.trading_style === 'short' ? '短' : pos.trading_style === 'long' ? '长' : '波'}
                                    </span>
                                  )}
                                  {(() => {
                                    const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market, true)
                                    return (suggestion || kline) ? (
                                      <SuggestionBadge
                                        suggestion={suggestion}
                                        stockName={pos.name}
                                        stockSymbol={pos.symbol}
                                        kline={kline}
                                        market={pos.market}
                                        hasPosition={true}
                                      />
                                    ) : null
                                  })()}
                                </div>
                                <div className={`font-mono text-[13px] font-medium ${changeColor}`}>
                                  {pos.current_price?.toFixed(2) || '—'}
                                  {pos.change_pct != null && <span className="text-[11px] ml-1">{pos.change_pct >= 0 ? '+' : ''}{pos.change_pct.toFixed(2)}%</span>}
                                </div>
                              </div>
                              {/* Row 2: Details */}
                              <div className="flex items-center justify-between text-[11px]">
                                <div className="flex items-center gap-3">
                                  <span className="text-muted-foreground">成本 <span className="font-mono text-foreground">{formatPrice(pos.cost_price)}</span></span>
                                  <span className="text-muted-foreground">数量 <span className="font-mono text-foreground">{pos.quantity}</span></span>
                                  <span className="text-muted-foreground">今日 <span className={`font-mono ${(pos.day_pnl || 0) >= 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{pos.day_pnl != null ? `${pos.day_pnl >= 0 ? '+' : ''}${formatMoney(pos.day_pnl)}` : '—'}</span></span>
                                </div>
                                <div className={`font-mono ${pnlColor}`}>
                                  {pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}${formatMoney(pos.pnl)}` : '—'}
                                  {pos.pnl_pct != null && <span className="ml-1">({pos.pnl_pct >= 0 ? '+' : ''}{pos.pnl_pct.toFixed(2)}%)</span>}
                                </div>
                              </div>
                              {/* Row 3: Actions */}
                              <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/20">
                                <div>
                                  {stock && stock.agents && stock.agents.length > 0 ? (
                                    <button onClick={() => setAgentDialogStock(stock)} className="flex items-center gap-1">
                                      {stock.agents.slice(0, 2).map(sa => {
                                        const agent = agents.find(a => a.name === sa.agent_name)
                                        const isRunning = runningAgents[stock.id] === sa.agent_name
                                        return (
                                          <span key={sa.agent_name} className="inline-flex items-center gap-1">
                                            <Badge variant="secondary" className="text-[9px]">{agent?.display_name || sa.agent_name}</Badge>
                                            {isRunning && (
                                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                                                <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                                                执行中
                                              </span>
                                            )}
                                          </span>
                                        )
                                      })}
                                    </button>
                                  ) : (
                                    <button onClick={() => stock && setAgentDialogStock(stock)} className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
                                      <Bot className="w-3 h-3" /> Agent
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-1">
                                  {(() => { const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market, true); return (!suggestion && !kline && pos.market !== 'FUND') ? (
                                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openKlineDialog(pos.symbol, pos.market, pos.name, true)} title="K线指标"><BarChart3 className="w-3 h-3" /></Button>
                                  ) : null })()}
                                  <StockPriceAlertPanel
                                    mode="icon"
                                    stockId={pos.stock_id}
                                    symbol={pos.symbol}
                                    market={pos.market}
                                    stockName={pos.name}
                                    initialTotal={getPriceAlertSummary(pos.symbol, pos.market).total}
                                    initialEnabled={getPriceAlertSummary(pos.symbol, pos.market).enabled}
                                    onChanged={loadPriceAlertSummaries}
                                  />
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openIntelCenter('report', pos.symbol, pos.market, pos.name)} title="相关报告"><FileText className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openIntelCenter('news', pos.symbol, pos.market, pos.name)} title="相关资讯"><Newspaper className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openPositionDialog(account.id, pos)}><Pencil className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => handleDeletePosition(pos.id)}><Trash2 className="w-3 h-3" /></Button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
                )
              })}
        </div>
        )
      )}

      {/* Watchlist */}
      {viewTab === 'watchlist' && (
        <div className="card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[13px] font-semibold text-foreground">列表</h3>
            <div className="flex items-center gap-1">
              {[
                { value: '', label: '全部', count: stocks.length },
                { value: 'CN', label: 'A股', count: stocks.filter(s => s.market === 'CN').length },
                { value: 'HK', label: '港股', count: stocks.filter(s => s.market === 'HK').length },
                { value: 'US', label: '美股', count: stocks.filter(s => s.market === 'US').length },
                { value: 'FUND', label: '基金', count: stocks.filter(s => s.market === 'FUND').length },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setStockListFilter(opt.value)}
                  className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                    stockListFilter === opt.value
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {opt.label} ({opt.count})
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1 p-0.5 rounded-lg bg-accent/30">
              <button
                onClick={() => setWatchlistViewMode('card')}
                className={`p-1.5 rounded-md transition-colors ${watchlistViewMode === 'card' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                title="卡片视图"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setWatchlistViewMode('list')}
                className={`p-1.5 rounded-md transition-colors ${watchlistViewMode === 'list' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                title="列表视图"
              >
                <List className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                value={watchlistKeyword}
                onChange={(e) => setWatchlistKeyword(e.target.value)}
                placeholder="搜索代码或名称"
                className="h-8 w-[170px] sm:w-[220px] text-[12px]"
              />
              <button
                onClick={() => setWatchlistOnlyAlerts(!watchlistOnlyAlerts)}
                className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${
                  watchlistOnlyAlerts
                    ? 'bg-rose-500/10 border-rose-500/30 text-rose-600'
                    : 'bg-accent/30 border-border/50 text-muted-foreground hover:border-rose-500/30'
                }`}
                title="只显示需要关注/预警的股票"
              >
                仅预警
              </button>
            </div>
          </div>
          {stocks.length === 0 ? (
            <div className="py-12 text-center">
              <div className="text-[13px] text-muted-foreground">还没有添加自选标的</div>
              <div className="mt-2 text-[11px] text-muted-foreground/70">点击右上角“添加自选”开始</div>
            </div>
          ) : watchlistViewMode === 'list' ? (
            /* 列表视图 */
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/30 bg-accent/20">
                    <th className="text-left px-3 py-2 text-[11px] font-semibold text-muted-foreground">名称</th>
                    <th className="text-right px-3 py-2 text-[11px] font-semibold text-muted-foreground">现价</th>
                    <th className="text-right px-3 py-2 text-[11px] font-semibold text-muted-foreground">涨跌</th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold text-muted-foreground hidden md:table-cell">Agent</th>
                    <th className="text-center px-3 py-2 text-[11px] font-semibold text-muted-foreground">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks
                    .filter(s => !stockListFilter || s.market === stockListFilter)
                    .filter(s => {
                      const q = watchlistKeyword.trim().toLowerCase()
                      if (!q) return true
                      return String(s.symbol || '').toLowerCase().includes(q) || String(s.name || '').toLowerCase().includes(q)
                    })
                    .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
                    .filter(stock => {
                      if (!watchlistOnlyAlerts) return true
                      const { suggestion } = getSuggestionForStock(stock.symbol, stock.market, false)
                      return !!suggestion?.should_alert
                    })
                    .map((stock, i) => {
                      const quoteKey = `${stock.market}:${stock.symbol}`
                      const quote = getStockQuote(quoteKey)
                      const flashClass = watchlistQuoteFlashMap[quoteKey] ? flashClassByDir(watchlistQuoteFlashMap[quoteKey]) : ''
                      const changeColor = quote?.change_pct != null
                        ? (quote.change_pct > 0 ? 'text-rose-500' : quote.change_pct < 0 ? 'text-emerald-500' : 'text-muted-foreground')
                        : 'text-muted-foreground'
                      return (
                        <tr
                          key={stock.id}
                          draggable={stockListFilter === '' && !watchlistOnlyAlerts}
                          onDragStart={(e) => {
                            if (stockListFilter !== '' || watchlistOnlyAlerts) return
                            watchDragSnapshotRef.current = stocks
                            setDraggingWatchStockId(stock.id)
                            e.dataTransfer.effectAllowed = 'move'
                          }}
                          onDragOver={(e) => {
                            if (stockListFilter !== '' || watchlistOnlyAlerts) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            if (draggingWatchStockId != null) {
                              previewWatchlistReorder(draggingWatchStockId, stock.id)
                            }
                          }}
                          onDrop={(e) => {
                            if (stockListFilter !== '' || watchlistOnlyAlerts) return
                            e.preventDefault()
                            if (draggingWatchStockId != null) commitWatchlistReorder()
                            setDraggingWatchStockId(null)
                            watchDragSnapshotRef.current = null
                          }}
                          onDragEnd={() => {
                            setDraggingWatchStockId(null)
                            watchDragSnapshotRef.current = null
                          }}
                          className={`group hover:bg-accent/30 transition-colors cursor-pointer ${i > 0 ? 'border-t border-border/20' : ''} ${draggingWatchStockId === stock.id ? 'opacity-60' : ''}`}
                          onClick={() => {
                            if (isSuppressCardClick()) return
                            setAgentDialogStock(stock)
                          }}
                        >
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-2">
                              <span className={`text-[9px] px-1 py-0.5 rounded ${marketBadge(stock.market).style}`}>
                                {marketBadge(stock.market).label}
                              </span>
                              <button
                                className="font-mono text-[12px] font-semibold text-foreground hover:text-primary"
                                onClick={(e) => { e.stopPropagation(); openStockDetail(stock.symbol, stock.market, stock.name, false) }}
                              >
                                {stock.symbol}
                              </button>
                              <button
                                className="text-[12px] text-muted-foreground hover:text-primary truncate max-w-[100px]"
                                onClick={(e) => { e.stopPropagation(); openStockDetail(stock.symbol, stock.market, stock.name, false) }}
                              >
                                {stock.name}
                              </button>
                            </div>
                          </td>
                          <td className={`px-3 py-2.5 text-right font-mono text-[13px] font-medium ${changeColor} ${flashClass}`}>
                            {quote?.current_price != null ? quote.current_price.toFixed(2) : '--'}
                          </td>
                          <td className={`px-3 py-2.5 text-right font-mono text-[12px] ${changeColor} ${flashClass}`}>
                            {quote?.change_pct != null ? `${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%` : '--'}
                          </td>
                          <td className="px-3 py-2.5 hidden md:table-cell">
                            <div className="flex items-center gap-1">
                              {stock.agents && stock.agents.length > 0 ? (
                                <Badge variant="secondary" className="text-[10px]">{stock.agents.length} Agent</Badge>
                              ) : (
                                <span className="text-[10px] text-muted-foreground/60">未配置</span>
                              )}
                              {runningAgents[stock.id] && (
                                <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                                  <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center justify-center gap-0.5 md:opacity-0 md:group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                              {stock.market !== 'FUND' && (
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openKlineDialog(stock.symbol, stock.market, stock.name, false)} title="K线指标">
                                  <BarChart3 className="w-3.5 h-3.5" />
                                </Button>
                              )}
                              <StockPriceAlertPanel
                                mode="icon"
                                stockId={stock.id}
                                symbol={stock.symbol}
                                market={stock.market}
                                stockName={stock.name}
                                initialTotal={getPriceAlertSummary(stock.symbol, stock.market).total}
                                initialEnabled={getPriceAlertSummary(stock.symbol, stock.market).enabled}
                                onChanged={loadPriceAlertSummaries}
                              />
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openIntelCenter('report', stock.symbol, stock.market, stock.name)} title="相关报告">
                                <FileText className="w-3.5 h-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openIntelCenter('news', stock.symbol, stock.market, stock.name)} title="相关资讯">
                                <Newspaper className="w-3.5 h-3.5" />
                              </Button>
                              <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => setRemoveWatchStock(stock)} title="删除">
                                <X className="w-3.5 h-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          ) : (
            /* 卡片视图 */
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {stocks
                .filter(s => !stockListFilter || s.market === stockListFilter)
                .filter(s => {
                  const q = watchlistKeyword.trim().toLowerCase()
                  if (!q) return true
                  return String(s.symbol || '').toLowerCase().includes(q) || String(s.name || '').toLowerCase().includes(q)
                })
                .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
                .filter(stock => {
                  if (!watchlistOnlyAlerts) return true
                  const { suggestion } = getSuggestionForStock(stock.symbol, stock.market, false)
                  return !!suggestion?.should_alert
                })
                .map((stock) => {
                const quoteKey = `${stock.market}:${stock.symbol}`
                const quote = getStockQuote(quoteKey)
                const flashClass = watchlistQuoteFlashMap[quoteKey] ? flashClassByDir(watchlistQuoteFlashMap[quoteKey]) : ''
                const changeColor = quote?.change_pct != null
                  ? (quote.change_pct > 0 ? 'text-rose-500' : quote.change_pct < 0 ? 'text-emerald-500' : 'text-muted-foreground')
                  : 'text-muted-foreground'
                const { suggestion, kline } = getSuggestionForStock(stock.symbol, stock.market, false)
                return (
                  <div
                    key={stock.id}
                    draggable={stockListFilter === '' && !watchlistOnlyAlerts}
                    onDragStart={(e) => {
                      if (stockListFilter !== '' || watchlistOnlyAlerts) return
                      watchDragSnapshotRef.current = stocks
                      setDraggingWatchStockId(stock.id)
                      e.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(e) => {
                      if (stockListFilter !== '' || watchlistOnlyAlerts) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (draggingWatchStockId != null) {
                        previewWatchlistReorder(draggingWatchStockId, stock.id)
                      }
                    }}
                    onDrop={(e) => {
                      if (stockListFilter !== '' || watchlistOnlyAlerts) return
                      e.preventDefault()
                      if (draggingWatchStockId != null) commitWatchlistReorder()
                      setDraggingWatchStockId(null)
                      watchDragSnapshotRef.current = null
                    }}
                    onDragEnd={() => {
                      setDraggingWatchStockId(null)
                      watchDragSnapshotRef.current = null
                    }}
                    className={`group rounded-xl border border-border/40 bg-background/30 hover:bg-accent/20 transition-colors p-3 cursor-pointer ${draggingWatchStockId === stock.id ? 'opacity-60' : ''}`}
                    onClick={() => {
                      if (isSuppressCardClick()) return
                      setAgentDialogStock(stock)
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={`text-[9px] px-1 py-0.5 rounded ${marketBadge(stock.market).style}`}>
                            {marketBadge(stock.market).label}
                          </span>
                          <button
                            className="font-mono text-[12px] font-semibold text-foreground hover:text-primary"
                            onClick={(e) => { e.stopPropagation(); openStockDetail(stock.symbol, stock.market, stock.name, false) }}
                          >
                            {stock.symbol}
                          </button>
                          <button
                            className="text-[12px] text-muted-foreground truncate hover:text-primary"
                            onClick={(e) => { e.stopPropagation(); openStockDetail(stock.symbol, stock.market, stock.name, false) }}
                          >
                            {stock.name}
                          </button>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`font-mono text-[14px] font-bold leading-tight ${changeColor} ${flashClass}`}>
                          {quote?.current_price != null ? quote.current_price.toFixed(2) : '--'}
                        </div>
                        <div className={`font-mono text-[11px] leading-tight ${changeColor} ${flashClass}`}>
                          {quote?.change_pct != null ? `${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%` : '--'}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2">
                      {(suggestion || kline) ? (
                        <SuggestionBadge
                          suggestion={suggestion}
                          stockName={stock.name}
                          stockSymbol={stock.symbol}
                          kline={kline}
                          market={stock.market}
                          hasPosition={false}
                        />
                      ) : (
                        <div className="text-[11px] text-muted-foreground/70 py-2">暂无技术面/AI 分析</div>
                      )}
                    </div>

                    <div className="mt-2 pt-2 border-t border-border/30 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1 flex-wrap">
                        {stock.agents && stock.agents.length > 0 ? (
                          <Badge variant="secondary" className="text-[10px]">{stock.agents.length} Agent</Badge>
                        ) : (
                          <span className="text-[10px] text-muted-foreground/60">未配置 Agent</span>
                        )}
                        {runningAgents[stock.id] && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                            <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                            {agents.find(a => a.name === runningAgents[stock.id])?.display_name || runningAgents[stock.id]}
                          </span>
                        )}
                      </div>
                      <div
                        className="flex items-center gap-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {stock.market !== 'FUND' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openKlineDialog(stock.symbol, stock.market, stock.name, false)}
                            title="K线指标"
                          >
                            <BarChart3 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        <StockPriceAlertPanel
                          mode="icon"
                          stockId={stock.id}
                          symbol={stock.symbol}
                          market={stock.market}
                          stockName={stock.name}
                          initialTotal={getPriceAlertSummary(stock.symbol, stock.market).total}
                          initialEnabled={getPriceAlertSummary(stock.symbol, stock.market).enabled}
                          onChanged={loadPriceAlertSummaries}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openIntelCenter('news', stock.symbol, stock.market, stock.name)}
                          title="相关资讯"
                        >
                          <Newspaper className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openIntelCenter('report', stock.symbol, stock.market, stock.name)}
                          title="相关报告"
                        >
                          <FileText className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 hover:text-destructive"
                          onClick={() => setRemoveWatchStock(stock)}
                          title="删除股票"
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Kline Dialog */}
      <KlineSummaryDialog
        open={klineDialogOpen}
        onOpenChange={setKlineDialogOpen}
        symbol={klineDialogSymbol}
        market={klineDialogMarket}
        stockName={klineDialogName}
        hasPosition={klineDialogHasPosition}
        initialSummary={klineDialogInitialSummary as any}
      />

      <StockInsightModal
        open={insightOpen}
        onOpenChange={setInsightOpen}
        symbol={insightSymbol}
        market={insightMarket}
        stockName={insightName}
        hasPosition={insightHasPosition}
      />

      <FundOverviewModal
        open={fundOverviewOpen}
        onOpenChange={setFundOverviewOpen}
        fundCode={fundOverviewSymbol}
        fundName={fundOverviewName}
      />

      {/* Remove Watchlist Dialog */}
      <Dialog open={!!removeWatchStock} onOpenChange={(open) => { if (!open) setRemoveWatchStock(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除股票</DialogTitle>
            <DialogDescription>删除后将从系统中移除该股票及其关注配置</DialogDescription>
          </DialogHeader>
          {removeWatchStock && (
            <div className="space-y-4 mt-2">
              <div className="rounded-lg border border-border/40 bg-accent/20 p-3">
                <div className="text-[13px] font-semibold text-foreground">
                  {removeWatchStock.name}
                  <span className="ml-2 font-mono text-[12px] text-muted-foreground">{removeWatchStock.symbol}</span>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  {hasAnyPositionForStockId(removeWatchStock.id)
                    ? '该股票存在持仓，不能直接删除。请先在“持仓”Tab 删除持仓记录。'
                    : '删除后将不再出现在关注列表，同时会清理该股票关联的价格提醒。'}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRemoveWatchStock(null)} disabled={removingWatchStock}>取消</Button>
                <Button
                  variant="destructive"
                  onClick={() => removeFromWatchlist(removeWatchStock)}
                  disabled={removingWatchStock || hasAnyPositionForStockId(removeWatchStock.id)}
                >
                  {hasAnyPositionForStockId(removeWatchStock.id) ? '请先删除持仓' : (removingWatchStock ? '处理中…' : '删除股票')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Account Dialog */}
      <Dialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editAccountId ? '编辑账户' : '添加账户'}</DialogTitle>
            <DialogDescription>设置交易账户信息</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>账户名称</Label>
              <Input
                value={accountForm.name}
                onChange={e => setAccountForm({ ...accountForm, name: e.target.value })}
                placeholder="如：招商证券、华泰证券"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>账户市场</Label>
                <Select
                  value={accountForm.market}
                  onValueChange={v => {
                    const market = (v || 'CN').toUpperCase()
                    const defaultCurrency = market === 'HK' ? 'HKD' : market === 'US' ? 'USD' : 'CNY'
                    setAccountForm({ ...accountForm, market, base_currency: defaultCurrency })
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CN">A股</SelectItem>
                    <SelectItem value="HK">港股</SelectItem>
                    <SelectItem value="US">美股</SelectItem>
                    <SelectItem value="FUND">基金</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>账户币种</Label>
                <Select
                  value={accountForm.market === 'FUND' ? 'CNY' : accountForm.base_currency}
                  onValueChange={v => {
                    const nextCurrency = accountForm.market === 'FUND' ? 'CNY' : (v || 'CNY').toUpperCase()
                    setAccountForm({ ...accountForm, base_currency: nextCurrency })
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CNY">CNY</SelectItem>
                    {accountForm.market !== 'FUND' && <SelectItem value="HKD">HKD</SelectItem>}
                    {accountForm.market !== 'FUND' && <SelectItem value="USD">USD</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>可用资金（{accountForm.base_currency}）</Label>
              <Input
                value={accountForm.available_funds}
                onChange={e => setAccountForm({ ...accountForm, available_funds: e.target.value })}
                placeholder="0"
                className="font-mono"
                inputMode="decimal"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAccountDialogOpen(false)}>取消</Button>
              <Button onClick={handleAccountSubmit} disabled={!accountForm.name}>
                {editAccountId ? '保存' : '创建'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Position Dialog */}
      <Dialog
        open={positionDialogOpen}
        onOpenChange={(open) => {
          setPositionDialogOpen(open)
          if (!open) {
            setPositionSearchQuery('')
            setPositionSearchResults([])
            setShowPositionDropdown(false)
            setPositionSearchMarket('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editPositionId ? '编辑持仓' : '添加持仓'}</DialogTitle>
            <DialogDescription>
              {accounts.find(a => a.id === positionDialogAccountId)?.name} 账户持仓
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {editPositionId ? (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-accent/30">
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${marketBadge(positionForm.stock_market).style}`}>
                  {marketBadge(positionForm.stock_market).label}
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">{positionForm.stock_symbol}</span>
                <span className="text-[13px] text-foreground">{positionForm.stock_name}</span>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Label className="mb-0">搜索股票</Label>
                  <div className="flex items-center gap-1">
                    {[
                      { value: '', label: '全部' },
                      { value: 'CN', label: 'A股' },
                      { value: 'HK', label: '港股' },
                      { value: 'US', label: '美股' },
                      { value: 'FUND', label: '基金' },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handlePositionSearchMarketChange(opt.value)}
                        className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                          positionSearchMarket === opt.value
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="relative" ref={positionDropdownRef}>
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                  <Input
                    value={positionSearchQuery}
                    onChange={e => handlePositionSearchInput(e.target.value)}
                    onFocus={() => positionSearchResults.length > 0 && setShowPositionDropdown(true)}
                    placeholder={positionSearchMarket === 'HK' ? '代码或名称，如 00700 或 腾讯' : positionSearchMarket === 'US' ? '代码或名称，如 LI 或 理想汽车' : positionSearchMarket === 'FUND' ? '基金代码或名称，如 001186 或 富国文体健康' : positionSearchMarket === 'CN' ? '代码或名称，如 600519 或 茅台' : '代码或名称，如 600519 / 00700 / AAPL / 001186'}
                    className="pl-9"
                    autoComplete="off"
                  />
                  {positionSearching && <span className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />}
                  {showPositionDropdown && positionSearchResults.length > 0 && (
                    <div className="absolute z-50 w-full mt-1 max-h-48 overflow-auto scrollbar card shadow-lg">
                      {positionSearchResults.map(item => (
                        <button
                          key={`${item.market}-${item.symbol}`}
                          type="button"
                          onClick={() => selectPositionStock(item)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-accent/50 text-left transition-colors"
                        >
                          <span className={`text-[9px] px-1 py-0.5 rounded ${marketBadge(item.market).style}`}>
                            {marketBadge(item.market).label}
                          </span>
                          <span className="font-mono text-muted-foreground text-[12px]">{item.symbol}</span>
                          <span className="flex-1 text-foreground">{item.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {positionForm.stock_symbol && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${marketBadge(positionForm.stock_market).style}`}>
                      {marketBadge(positionForm.stock_market).label}
                    </span>
                    <span className="font-mono text-[12px] text-muted-foreground">{positionForm.stock_symbol}</span>
                    <span className="text-[13px] text-foreground">{positionForm.stock_name}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setPositionForm({ ...positionForm, stock_id: 0, stock_symbol: '', stock_name: '', stock_market: '' })
                        setPositionSearchQuery('')
                      }}
                      className="ml-1 text-muted-foreground hover:text-destructive"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>成本价</Label>
                <Input
                  value={positionForm.cost_price}
                  onChange={e => setPositionForm({ ...positionForm, cost_price: e.target.value })}
                  placeholder="0.00"
                  className="font-mono"
                  inputMode="decimal"
                />
              </div>
              <div>
                <Label>持仓数量</Label>
                <Input
                  value={positionForm.quantity}
                  onChange={e => setPositionForm({ ...positionForm, quantity: e.target.value })}
                  placeholder="0"
                  className="font-mono"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>投入资金 <span className="text-muted-foreground/60 text-[11px]">(选填)</span></Label>
                <Input
                  value={positionForm.invested_amount}
                  onChange={e => setPositionForm({ ...positionForm, invested_amount: e.target.value })}
                  placeholder="选填"
                  className="font-mono"
                  inputMode="decimal"
                />
              </div>
              <div>
                <Label>交易风格 <span className="text-muted-foreground font-normal">(选填)</span></Label>
                <Select
                  value={positionForm.trading_style}
                  onValueChange={val => setPositionForm({ ...positionForm, trading_style: val === '__none__' ? '' : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="不设置" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不设置</SelectItem>
                    <SelectItem value="short">短线 (1-5天)</SelectItem>
                    <SelectItem value="swing">波段 (1-4周)</SelectItem>
                    <SelectItem value="long">长线 (数月)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setPositionDialogOpen(false)}>取消</Button>
              <Button
                onClick={handlePositionSubmit}
                disabled={!positionForm.cost_price || !positionForm.quantity || (!editPositionId && !positionForm.stock_id && !positionForm.stock_symbol)}
              >
                {editPositionId ? '保存' : '添加'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Agent Assignment Dialog */}
      <Dialog open={!!agentDialogStock} onOpenChange={open => !open && setAgentDialogStock(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>配置监控 Agent</DialogTitle>
            <DialogDescription>
              为 {agentDialogStock?.name}（{agentDialogStock?.symbol}）选择要监控的 Agent
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {(() => {
              // 根据标的类型过滤可用的Agent
              const stockMarket = (agentDialogStock?.market || '').toUpperCase()
              const isFund = stockMarket === 'FUND'
              
              // 过滤逻辑：
              // - 基金：只显示基金专属Agent（market_filter 包含 'FUND'）
              // - 股票：只显示通用Agent（market_filter 为空）
              const applicableAgents = agents.filter(agent => {
                const mf = agent.market_filter || []
                if (isFund) {
                  // 基金只能使用基金专属Agent
                  return mf.includes('FUND')
                } else {
                  // 股票只能使用通用Agent（market_filter为空）
                  return mf.length === 0
                }
              })
              
              if (applicableAgents.length === 0) {
                return <p className="text-[13px] text-muted-foreground py-4 text-center">暂无可用 Agent</p>
              }
              return applicableAgents.map(agent => {
                const stockAgent = agentDialogStock?.agents?.find(a => a.agent_name === agent.name)
                const isAssigned = !!stockAgent
                const isBatchMode = agent.execution_mode === 'batch'
                const isFundOnly = (agent.market_filter || []).includes('FUND')
                return (
                  <div key={agent.name} className="rounded-xl bg-accent/30 hover:bg-accent/50 transition-colors overflow-hidden">
                    <div className="flex items-center justify-between p-3.5">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${agent.enabled ? 'bg-emerald-500' : 'bg-border'}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium text-foreground">{agent.display_name}</span>
                            <Badge variant="secondary" className="text-[9px]">
                              {isBatchMode ? '批量' : '逐只'}
                            </Badge>
                            {isFundOnly && (
                              <Badge variant="outline" className="text-[9px] border-amber-500/50 text-amber-600">
                                基金专属
                              </Badge>
                            )}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{agent.description}</p>
                        </div>
                      </div>
                      <Switch
                        checked={isAssigned}
                        onCheckedChange={() => agentDialogStock && toggleAgent(agentDialogStock, agent.name)}
                        disabled={!agent.enabled}
                      />
                    </div>
                    {isAssigned && isBatchMode && (
                      <div className="px-3.5 pb-3.5 pt-0">
                        <p className="text-[11px] text-muted-foreground">
                          调度、AI模型、通知渠道请在 <a href="/agents" className="text-primary hover:underline">Agent 配置</a> 页面统一设置
                        </p>
                      </div>
                    )}
                    {isAssigned && !isBatchMode && (
                      <div className="px-3.5 pb-3.5 pt-0 space-y-2.5">
                        {/* Schedule/Interval Select */}
                        <div className="flex items-center gap-2">
                          <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <Select
                            value={stockAgent?.schedule || '__default__'}
                            onValueChange={val => agentDialogStock && updateStockAgentSchedule(agentDialogStock, agent.name, val === '__default__' ? '' : val)}
                          >
                            <SelectTrigger className="h-7 text-[11px] w-auto min-w-[140px] px-2.5 bg-accent/50 border-border/50">
                              <SelectValue placeholder="执行间隔" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">跟随全局</SelectItem>
                              <SelectItem value="*/1 9-15 * * 1-5">每 1 分钟</SelectItem>
                              <SelectItem value="*/3 9-15 * * 1-5">每 3 分钟</SelectItem>
                              <SelectItem value="*/5 9-15 * * 1-5">每 5 分钟</SelectItem>
                              <SelectItem value="*/10 9-15 * * 1-5">每 10 分钟</SelectItem>
                              <SelectItem value="*/15 9-15 * * 1-5">每 15 分钟</SelectItem>
                              <SelectItem value="*/30 9-15 * * 1-5">每 30 分钟</SelectItem>
                            </SelectContent>
                          </Select>
                          <span className="text-[10px] text-muted-foreground">交易时段</span>
                        </div>

                        {/* Schedule Preview */}
                        {(() => {
                          const eff = effectiveSchedule(agent, stockAgent)
                          const isFollowingGlobal = !(stockAgent?.schedule || '').trim() && !!(agent.schedule || '').trim()
                          const preview = eff ? schedulePreviewCache[eff] : null
                          const isLoading = eff ? !!schedulePreviewLoading[eff] : false
                          if (!eff) return null
                          return (
                            <div className="ml-[22px] rounded-lg border border-border/40 bg-background/30 px-2.5 py-2">
                              <div className="flex items-center justify-between">
                                <div className="text-[11px] text-muted-foreground">
                                  未来触发时间预览{isFollowingGlobal ? <span className="ml-1 opacity-70">(跟随全局)</span> : null}
                                </div>
                                {isLoading && (
                                  <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                                )}
                              </div>
                              {'error' in (preview || {}) ? (
                                <div className="mt-1 text-[11px] text-muted-foreground">{(preview as any).error}</div>
                              ) : (preview as SchedulePreview | undefined)?.next_runs?.length ? (
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                  {(preview as SchedulePreview).next_runs.map((t, i) => (
                                    <span key={i} className="px-1.5 py-0.5 rounded border border-border/60 bg-accent/20 font-mono" title={t}>
                                      {formatPreviewTime(t, (preview as SchedulePreview).timezone)}
                                    </span>
                                  ))}
                                  {(preview as SchedulePreview).timezone ? (
                                    <span className="opacity-60">({(preview as SchedulePreview).timezone})</span>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="mt-1 text-[11px] text-muted-foreground">—</div>
                              )}
                              <div className="mt-1 text-[10px] text-muted-foreground/70 font-mono">schedule: {eff}</div>
                            </div>
                          )
                        })()}

                        {/* AI Model Select */}
                        <div className="flex items-center gap-2">
                          <Cpu className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <Select
                            value={stockAgent?.ai_model_id?.toString() ?? '__default__'}
                            onValueChange={val => agentDialogStock && updateStockAgentModel(agentDialogStock, agent.name, val === '__default__' ? null : parseInt(val))}
                          >
                            <SelectTrigger className="h-7 text-[11px] w-auto min-w-[140px] px-2.5 bg-accent/50 border-border/50">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">系统默认</SelectItem>
                              {services.map(svc => (
                                <SelectGroup key={svc.id}>
                                  <SelectLabel>{svc.name}</SelectLabel>
                                  {svc.models.map(m => (
                                    <SelectItem key={m.id} value={m.id.toString()}>
                                      {m.name}{m.name !== m.model ? ` (${m.model})` : ''}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* Notification Channels */}
                        {channels.length > 0 && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Bell className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            {channels.map(ch => {
                              const isSelected = (stockAgent?.notify_channel_ids || []).includes(ch.id)
                              return (
                                <button
                                  key={ch.id}
                                  onClick={() => agentDialogStock && toggleStockAgentChannel(agentDialogStock, agent.name, ch.id)}
                                  className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${
                                    isSelected
                                      ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                                      : 'bg-accent/30 border-border/50 text-muted-foreground hover:border-primary/30'
                                  }`}
                                >
                                  {ch.name}
                                </button>
                              )
                            })}
                            {(stockAgent?.notify_channel_ids || []).length === 0 && (
                              <span className="text-[10px] text-muted-foreground">系统默认</span>
                            )}
                          </div>
                        )}
                        {/* Trigger Button */}
                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            variant="secondary" size="sm" className="h-7 text-[11px] px-2.5"
                            disabled={triggeringAgent === agent.name}
                            onClick={() => agentDialogStock && triggerStockAgent(agentDialogStock.id, agent.name)}
                          >
                            {triggeringAgent === agent.name ? (
                              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                            ) : (
                              <Play className="w-3 h-3" />
                            )}
                            立即分析
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            })()}
          </div>
        </DialogContent>
      </Dialog>

      {/* Agent 分析结果弹窗 */}
      <Dialog open={!!agentResultDialog} onOpenChange={open => !open && setAgentResultDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{agentResultDialog?.title}</DialogTitle>
            <DialogDescription className="flex items-center gap-2 pt-1">
              {agentResultDialog?.should_alert ? (
                <Badge variant="default" className="text-[10px]">建议关注</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">无需关注</Badge>
              )}
              {agentResultDialog?.notified && (
                <Badge variant="outline" className="text-[10px]">已发送通知</Badge>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 p-3 bg-accent/30 rounded-lg">
            <pre className="text-[13px] whitespace-pre-wrap font-sans leading-relaxed">
              {agentResultDialog?.content}
            </pre>
          </div>
          <div className="flex justify-end mt-2">
            <Button variant="outline" size="sm" onClick={() => setAgentResultDialog(null)}>
              关闭
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {confirmDialog}

    </div>
  )
}
