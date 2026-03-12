import { createContext, useContext, useCallback, useRef, useState, useEffect, ReactNode } from 'react'

interface AutoRefreshProgress {
  enabled: boolean
  /** 进度 0~1，1 表示刚刷新，随时间递减至 0 */
  progress: number
}

interface RefreshState {
  loading: boolean
  triggerRefresh: () => void
  autoRefreshProgress: AutoRefreshProgress
}

interface RefreshContextValue extends RefreshState {
  registerRefreshHandler: (handler: () => Promise<void> | void) => () => void
  setAutoRefreshProgress: (progress: AutoRefreshProgress) => void
}

const RefreshContext = createContext<RefreshContextValue | null>(null)

export function RefreshProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(false)
  const [autoRefreshProgress, setAutoRefreshProgress] = useState<AutoRefreshProgress>({ enabled: false, progress: 0 })
  const handlersRef = useRef<Set<() => Promise<void> | void>>(new Set())

  const registerRefreshHandler = useCallback((handler: () => Promise<void> | void) => {
    handlersRef.current.add(handler)
    return () => {
      handlersRef.current.delete(handler)
    }
  }, [])

  const triggerRefresh = useCallback(async () => {
    if (loading) return
    setLoading(true)
    try {
      const handlers = Array.from(handlersRef.current)
      await Promise.all(handlers.map(h => h()))
    } finally {
      setLoading(false)
    }
  }, [loading])

  return (
    <RefreshContext.Provider value={{ loading, triggerRefresh, registerRefreshHandler, autoRefreshProgress, setAutoRefreshProgress }}>
      {children}
    </RefreshContext.Provider>
  )
}

/** 导航栏用 - 触发刷新和获取loading状态 */
export function useRefresh(): RefreshState {
  const ctx = useContext(RefreshContext)
  if (!ctx) {
    return { loading: false, triggerRefresh: () => {}, autoRefreshProgress: { enabled: false, progress: 0 } }
  }
  return { loading: ctx.loading, triggerRefresh: ctx.triggerRefresh, autoRefreshProgress: ctx.autoRefreshProgress }
}

/** 页面用 - 设置自动刷新进度（供 Dashboard/Stocks 调用） */
export function useAutoRefreshProgress() {
  const ctx = useContext(RefreshContext)
  return ctx?.setAutoRefreshProgress ?? (() => {})
}

/** 页面用 - 注册刷新回调 */
export function useRefreshReceiver(handler: () => Promise<void> | void) {
  const ctx = useContext(RefreshContext)
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!ctx) return undefined
    const stableHandler = () => handlerRef.current()
    return ctx.registerRefreshHandler(stableHandler)
  }, [ctx])
}
