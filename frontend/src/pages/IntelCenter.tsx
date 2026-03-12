import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Newspaper, FileText, Search, Trash2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { fetchAPI } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { Badge } from '@panwatch/base-ui/components/ui/badge'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'

interface NewsItem {
  source: string
  source_label: string
  external_id: string
  title: string
  content: string
  publish_time: string
  symbols: string[]
  importance: number
  url: string
}

interface WatchStock {
  id: number
  symbol: string
  name: string
  market: string
}

interface NewsPagedResponse {
  items: NewsItem[]
  total: number
  page: number
  page_size: number
  has_more: boolean
  ai_extension?: Record<string, string>
}

interface ReportItem {
  id: number
  agent_name: string
  stock_symbol: string
  analysis_date: string
  title: string
  content: string
  updated_at: string
}

interface HistoryPagedResponse {
  items: ReportItem[]
  total: number
  page: number
  page_size: number
  has_more: boolean
  ai_extension?: Record<string, string>
}

const AGENT_LABELS: Record<string, string> = {
  daily_report: '收盘复盘',
  premarket_outlook: '盘前分析',
  intraday_monitor: '盘中监测',
  fund_holding_analyst: '基金分析',
  news_digest: '新闻速递',
  chart_analyst: '技术分析',
}

const REPORT_AGENT_OPTIONS = [
  { value: 'all', label: '全部 Agent' },
  { value: 'daily_report', label: '收盘复盘' },
  { value: 'premarket_outlook', label: '盘前分析' },
  { value: 'intraday_monitor', label: '盘中监测' },
  { value: 'fund_holding_analyst', label: '基金分析' },
  { value: 'news_digest', label: '新闻速递' },
  { value: 'chart_analyst', label: '技术分析' },
]

const formatStockScope = (value?: string) => {
  const v = String(value || '').trim().toUpperCase()
  if (!v || v === '*') return '全市场'
  return v
}

export default function IntelCenterPage() {
  const { toast } = useToast()
  const [searchParams, setSearchParams] = useSearchParams()

  const tab = (searchParams.get('tab') || 'news').toLowerCase() === 'report' ? 'report' : 'news'
  const page = Math.max(1, Number(searchParams.get('page') || '1') || 1)
  const pageSize = Math.max(1, Number(searchParams.get('page_size') || '10') || 10)
  const q = searchParams.get('q') || ''

  const source = searchParams.get('source') || 'all'
  const hours = searchParams.get('hours') || '168'
  const kind = searchParams.get('kind') || 'workflow'
  const agent = searchParams.get('agent') || 'all'
  const reportViewParam = searchParams.get('report_view')

  const ctxSymbol = (searchParams.get('symbol') || '').trim().toUpperCase()
  const ctxName = (searchParams.get('name') || '').trim()
  const ctxMarket = (searchParams.get('market') || '').trim().toUpperCase()
  const isStockContext = !!(ctxSymbol || ctxName)

  const [loading, setLoading] = useState(false)
  const [newsData, setNewsData] = useState<NewsPagedResponse | null>(null)
  const [reportData, setReportData] = useState<HistoryPagedResponse | null>(null)
  const [stockNameMap, setStockNameMap] = useState<Record<string, string>>({})
  const [isMobileViewport, setIsMobileViewport] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null)
  const [detailReport, setDetailReport] = useState<ReportItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ReportItem | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const reportView = reportViewParam === 'list'
    ? 'list'
    : reportViewParam === 'reader'
      ? 'reader'
      : (isMobileViewport ? 'list' : 'reader')

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)')
    const apply = () => setIsMobileViewport(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const updateParams = (patch: Record<string, string | null>, resetPage = false) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(patch).forEach(([k, v]) => {
      if (v == null || v === '') next.delete(k)
      else next.set(k, v)
    })
    if (resetPage) next.set('page', '1')
    setSearchParams(next)
  }

  const totalPages = useMemo(() => {
    const total = tab === 'news' ? (newsData?.total || 0) : (reportData?.total || 0)
    return Math.max(1, Math.ceil(total / pageSize))
  }, [newsData?.total, pageSize, reportData?.total, tab])

  useEffect(() => {
    let cancelled = false

    const loadStocks = async () => {
      try {
        const rows = await fetchAPI<WatchStock[]>('/stocks')
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const s of rows || []) {
          const key = String(s.symbol || '').toUpperCase()
          if (!key) continue
          map[key] = s.name || s.symbol
        }
        setStockNameMap(map)
      } catch {
        // ignore; fallback to symbol-only when stock map is unavailable
      }
    }

    loadStocks()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      setLoading(true)
      try {
        if (tab === 'news') {
          const params = new URLSearchParams()
          params.set('page', String(page))
          params.set('page_size', String(pageSize))
          params.set('hours', hours)
          if (q.trim()) params.set('q', q.trim())
          if (source !== 'all') params.set('source', source)
          if (isStockContext) {
            if (ctxName) params.set('names', ctxName)
            if (ctxSymbol) params.set('symbols', ctxSymbol)
          }
          const data = await fetchAPI<NewsPagedResponse>(`/news/paged?${params.toString()}`)
          if (!cancelled) setNewsData(data)
          return
        }

        const params = new URLSearchParams()
        params.set('page', String(page))
        params.set('page_size', String(pageSize))
        params.set('kind', kind)
        if (q.trim()) params.set('q', q.trim())
        if (agent !== 'all') params.set('agent_name', agent)
        if (isStockContext && ctxSymbol) params.set('stock_symbol', ctxSymbol)
        const data = await fetchAPI<HistoryPagedResponse>(`/history/paged?${params.toString()}`)
        if (!cancelled) setReportData(data)
      } catch (e) {
        if (!cancelled) toast(e instanceof Error ? e.message : '加载失败', 'error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [agent, ctxName, ctxSymbol, hours, isStockContext, kind, page, pageSize, q, source, tab, toast, reloadTick])

  useEffect(() => {
    if (tab !== 'report') return
    const items = reportData?.items || []
    if (items.length === 0) {
      setSelectedReportId(null)
      return
    }
    if (selectedReportId && items.some(i => i.id === selectedReportId)) return
    setSelectedReportId(items[0].id)
  }, [reportData, selectedReportId, tab])

  const headerTitle = tab === 'news' ? '资讯' : '报告'
  const selectedReport = (reportData?.items || []).find(item => item.id === selectedReportId) || null

  const executeDeleteReport = async (id: number) => {
    setDeletingId(id)
    try {
      await fetchAPI(`/history/${id}`, { method: 'DELETE' })
      toast('删除成功', 'success')
      setDeleteTarget(null)
      if (detailReport?.id === id) setDetailReport(null)
      if (selectedReportId === id) setSelectedReportId(null)
      setReloadTick(v => v + 1)
    } catch (e) {
      toast(e instanceof Error ? e.message : '删除失败', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-sm ${tab === 'news' ? 'bg-gradient-to-br from-blue-500 to-blue-500/70' : 'bg-gradient-to-br from-orange-500 to-orange-500/70'}`}>
              {tab === 'news' ? <Newspaper className="w-5 h-5 text-white" /> : <FileText className="w-5 h-5 text-white" />}
            </div>
            <div>
              <h1 className="text-[20px] font-bold text-foreground">{headerTitle}</h1>
              <p className="text-[12px] text-muted-foreground">完整的资讯报告页面，支持阅读和管理。</p>
            </div>
          </div>
          {isStockContext && (
            <Badge variant="secondary" className="text-[11px]">
              当前标的：{ctxName || ctxSymbol}{ctxMarket ? ` (${ctxMarket})` : ''}
            </Badge>
          )}
        </div>

        <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-accent/30 w-fit">
          <button
            onClick={() => updateParams({ tab: 'news' }, true)}
            className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${tab === 'news' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            资讯
          </button>
          <button
            onClick={() => updateParams({ tab: 'report' }, true)}
            className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${tab === 'report' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            报告
          </button>
        </div>

        <div className="card p-3 md:p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => updateParams({ q: e.target.value }, true)}
              placeholder={tab === 'news' ? '搜索标题、正文、来源、股票' : '搜索标题、正文、Agent、股票'}
            />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {tab === 'news' ? (
              <>
                <Select value={source} onValueChange={(v) => updateParams({ source: v }, true)}>
                  <SelectTrigger className="h-8 w-[160px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部来源</SelectItem>
                    <SelectItem value="eastmoney_news">东财资讯</SelectItem>
                    <SelectItem value="eastmoney">东财公告</SelectItem>
                    <SelectItem value="xueqiu">雪球</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={hours} onValueChange={(v) => updateParams({ hours: v }, true)}>
                  <SelectTrigger className="h-8 w-[140px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="24">近 24 小时</SelectItem>
                    <SelectItem value="72">近 72 小时</SelectItem>
                    <SelectItem value="168">近 7 天</SelectItem>
                    <SelectItem value="336">近 14 天</SelectItem>
                  </SelectContent>
                </Select>
              </>
            ) : (
              <>
                <Select value={kind} onValueChange={(v) => updateParams({ kind: v }, true)}>
                  <SelectTrigger className="h-8 w-[150px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="workflow">主流程</SelectItem>
                    <SelectItem value="capability">能力层</SelectItem>
                    <SelectItem value="all">全部</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={agent} onValueChange={(v) => updateParams({ agent: v }, true)}>
                  <SelectTrigger className="h-8 w-[180px] text-[12px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPORT_AGENT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
            <Select value={String(pageSize)} onValueChange={(v) => updateParams({ page_size: v }, true)}>
              <SelectTrigger className="h-8 w-[120px] text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">每页 10 条</SelectItem>
                <SelectItem value="20">每页 20 条</SelectItem>
                <SelectItem value="50">每页 50 条</SelectItem>
              </SelectContent>
            </Select>

            {tab === 'report' && (
              <div className="ml-auto inline-flex items-center gap-1 p-1 rounded-lg bg-accent/30">
                <button
                  onClick={() => updateParams({ report_view: 'reader' })}
                  className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${reportView === 'reader' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  目录
                </button>
                <button
                  onClick={() => updateParams({ report_view: 'list' })}
                  className={`px-3 py-1.5 rounded-md text-[12px] transition-colors ${reportView === 'list' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  列表
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="card p-12 text-center">
          <span className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin inline-block" />
        </div>
      ) : tab === 'news' ? (
        <div className="card p-3 md:p-4 space-y-2">
          {(newsData?.items || []).length === 0 ? (
            <div className="py-12 text-center text-[13px] text-muted-foreground">暂无资讯</div>
          ) : (
            (newsData?.items || []).map((item) => (
              <div key={`${item.source}-${item.external_id}`} className="rounded-lg border border-border/40 bg-accent/15 hover:bg-accent/25 transition-colors p-3">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1.5">
                  <Badge variant="secondary" className="text-[10px]">{item.source_label}</Badge>
                  {item.importance >= 2 && <Badge className="text-[10px]">重要</Badge>}
                  <span>{item.publish_time}</span>
                </div>
                <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-[14px] font-medium text-foreground hover:text-primary transition-colors">
                  {item.title}
                </a>
                {item.content ? <p className="text-[12px] text-muted-foreground mt-1 line-clamp-2">{item.content}</p> : null}
                {item.symbols?.length ? (
                  <div className="mt-2 flex items-center gap-1 flex-wrap">
                    {item.symbols.slice(0, 6).map((sym) => {
                      const code = String(sym || '').toUpperCase()
                      const name = stockNameMap[code] || code
                      const label = name && name !== code ? `${name} (${code})` : code
                      return (
                        <Badge key={`${item.external_id}-${code}`} variant="outline" className="text-[10px]">
                          {label}
                        </Badge>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      ) : (
        reportView === 'reader' ? (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-4 card overflow-hidden">
              <div className="px-4 py-3 bg-accent/20 border-b border-border/50 text-[12px] text-muted-foreground">目录</div>
              {(reportData?.items || []).length === 0 ? (
                <div className="py-12 text-center text-[13px] text-muted-foreground">暂无报告</div>
              ) : (
                <div className="max-h-[62vh] overflow-y-auto divide-y divide-border/40">
                  {(reportData?.items || []).map((item) => {
                    const active = selectedReportId === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedReportId(item.id)}
                        className={`w-full text-left px-4 py-3 transition-colors ${active ? 'bg-primary/8' : 'hover:bg-accent/20'}`}
                      >
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Badge variant="outline" className="text-[10px]">{AGENT_LABELS[item.agent_name] || item.agent_name}</Badge>
                          <span>{item.analysis_date}</span>
                        </div>
                        <div className="mt-1 text-[13px] font-medium text-foreground truncate">{item.title || '分析报告'}</div>
                        <div className="mt-1 text-[11px] text-muted-foreground font-mono">{formatStockScope(item.stock_symbol)}</div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="md:col-span-8 card p-4 md:p-5">
              {selectedReport ? (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <Badge variant="outline" className="text-[10px]">{AGENT_LABELS[selectedReport.agent_name] || selectedReport.agent_name}</Badge>
                        <span>{selectedReport.analysis_date}</span>
                        <span className="font-mono">{formatStockScope(selectedReport.stock_symbol)}</span>
                      </div>
                      <div className="mt-1 text-[15px] font-semibold text-foreground truncate">{selectedReport.title || '分析报告'}</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-destructive"
                      disabled={deletingId === selectedReport.id}
                      onClick={() => setDeleteTarget(selectedReport)}
                      title="删除报告"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                  <div className="mt-3 p-3 md:p-4 rounded-lg bg-accent/20 prose prose-sm dark:prose-invert max-w-none max-h-[52vh] overflow-y-auto">
                    <ReactMarkdown>{selectedReport.content || ''}</ReactMarkdown>
                  </div>
                </>
              ) : (
                <div className="py-12 text-center text-[13px] text-muted-foreground">请选择一条报告</div>
              )}
            </div>
          </div>
        ) : (
          <div className="card p-3 md:p-4 space-y-2">
            {(reportData?.items || []).length === 0 ? (
              <div className="py-12 text-center text-[13px] text-muted-foreground">暂无报告</div>
            ) : (
              (reportData?.items || []).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setDetailReport(item)}
                  className="w-full text-left rounded-lg border border-border/40 bg-accent/15 hover:bg-accent/25 transition-colors p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1.5 flex-wrap">
                        <Badge variant="outline" className="text-[10px]">{AGENT_LABELS[item.agent_name] || item.agent_name}</Badge>
                        <span>{item.analysis_date}</span>
                        <span className="font-mono">{formatStockScope(item.stock_symbol)}</span>
                      </div>
                      <div className="text-[14px] font-medium text-foreground">{item.title || '分析报告'}</div>
                      <p className="text-[12px] text-muted-foreground mt-1 whitespace-pre-wrap line-clamp-3">{item.content}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 hover:text-destructive"
                      disabled={deletingId === item.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(item)
                      }}
                      title="删除报告"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </button>
              ))
            )}
          </div>
        )
      )}

      <div className="card p-3 flex items-center justify-between gap-2 flex-wrap">
        <div className="text-[12px] text-muted-foreground">
          共 {tab === 'news' ? (newsData?.total || 0) : (reportData?.total || 0)} 条，第 {page} / {totalPages} 页
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => updateParams({ page: String(page - 1) })}>
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => updateParams({ page: String(page + 1) })}
          >
            下一页
          </Button>
        </div>
      </div>



      <Dialog open={!!detailReport} onOpenChange={(open) => !open && setDetailReport(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detailReport?.title || '分析报告详情'}</DialogTitle>
            <DialogDescription>
              <span className="inline-flex items-center gap-2 text-[12px]">
                <Badge variant="outline" className="text-[10px]">{detailReport ? (AGENT_LABELS[detailReport.agent_name] || detailReport.agent_name) : 'Agent'}</Badge>
                <span>{detailReport?.analysis_date || ''}</span>
                <span className="font-mono">{formatStockScope(detailReport?.stock_symbol)}</span>
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg bg-accent/20 p-3 md:p-4 prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown>{detailReport?.content || ''}</ReactMarkdown>
          </div>
          {detailReport && (
            <div className="flex justify-end">
              <Button
                variant="destructive"
                size="sm"
                disabled={deletingId === detailReport.id}
                onClick={() => setDeleteTarget(detailReport)}
              >
                删除
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除报告</DialogTitle>
            <DialogDescription>
              确认删除这条报告吗？删除后不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="rounded-lg border border-border/50 bg-accent/20 p-3 text-[12px]">
              <div className="font-medium text-foreground truncate">{deleteTarget.title || '分析报告'}</div>
              <div className="mt-1 text-muted-foreground inline-flex items-center gap-2">
                <span>{deleteTarget.analysis_date}</span>
                <span className="font-mono">{deleteTarget.stock_symbol || '-'}</span>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deletingId === deleteTarget?.id}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && executeDeleteReport(deleteTarget.id)}
              disabled={deletingId === deleteTarget?.id}
            >
              {deletingId === deleteTarget?.id ? '删除中...' : '确认删除'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
