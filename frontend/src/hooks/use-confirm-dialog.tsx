import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'

type ConfirmVariant = 'default' | 'destructive'

interface ConfirmOptions {
  title?: string
  description: string
  confirmText?: string
  cancelText?: string
  variant?: ConfirmVariant
}

interface ConfirmState {
  open: boolean
  title: string
  description: string
  confirmText: string
  cancelText: string
  variant: ConfirmVariant
}

const DEFAULT_STATE: ConfirmState = {
  open: false,
  title: '请确认操作',
  description: '',
  confirmText: '确定',
  cancelText: '取消',
  variant: 'default',
}

export function useConfirmDialog() {
  const [state, setState] = useState<ConfirmState>(DEFAULT_STATE)
  const resolverRef = useRef<((value: boolean) => void) | null>(null)

  const settle = useCallback((value: boolean) => {
    const resolver = resolverRef.current
    resolverRef.current = null
    setState(DEFAULT_STATE)
    resolver?.(value)
  }, [])

  const confirm = useCallback((options: string | ConfirmOptions) => {
    if (resolverRef.current) {
      resolverRef.current(false)
      resolverRef.current = null
    }

    const normalized: ConfirmOptions = typeof options === 'string'
      ? { description: options }
      : options

    setState({
      open: true,
      title: normalized.title || DEFAULT_STATE.title,
      description: normalized.description,
      confirmText: normalized.confirmText || DEFAULT_STATE.confirmText,
      cancelText: normalized.cancelText || DEFAULT_STATE.cancelText,
      variant: normalized.variant || DEFAULT_STATE.variant,
    })

    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
    })
  }, [])

  const confirmDialog = useMemo(() => (
    <Dialog open={state.open} onOpenChange={(open) => { if (!open) settle(false) }}>
      <DialogContent className="max-w-sm p-0 overflow-hidden">
        <div className="relative bg-gradient-to-br from-white to-slate-50 px-5 py-4 border-b border-border/50">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <DialogHeader className="mt-3 mb-0">
            <DialogTitle>{state.title}</DialogTitle>
            <DialogDescription className="mt-1.5 leading-relaxed">{state.description}</DialogDescription>
          </DialogHeader>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 bg-card">
          <Button variant="secondary" onClick={() => settle(false)}>{state.cancelText}</Button>
          <Button
            variant={state.variant === 'destructive' ? 'destructive' : 'default'}
            onClick={() => settle(true)}
          >
            {state.confirmText}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  ), [settle, state])

  useEffect(() => {
    return () => {
      if (resolverRef.current) {
        resolverRef.current(false)
        resolverRef.current = null
      }
    }
  }, [])

  return { confirm, confirmDialog }
}
