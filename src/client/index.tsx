import type { Context } from '@deepseek-ai/cordis'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { PluginManagerSection } from './PluginManagerSection'
import { FloatingPluginManager } from './FloatingPluginManager'

const FLOATING_HOST_ID = 'dsh-plugin-manager-floating-root'

export const inject = ['slots', 'locale']

export function apply(ctx: Context) {
  const isZh = () => {
    try {
      const loc = (ctx as any).locale?.get?.() || (ctx as any).locale?.current
      return !loc || String(loc).startsWith('zh')
    } catch {
      return true
    }
  }

  // 1. Register Plugin Manager tab in Settings -> Plugins -> Plugin Manager
  (ctx as any).slots.inject('settings.plugins.tab', () => {
    const off = (ctx as any).slots.register({
      name: 'settings.plugins.tab',
      id: 'plugin-manager',
      order: 20,
      label: () => (isZh() ? '插件管理' : 'Plugin Manager'),
    }, PluginManagerSection)

    return () => {
      if (typeof off === 'function') off()
    }
  })

  // 2. Mount Floating Mascot Widget to document.body
  if (typeof document !== 'undefined') {
    let root: ReactDOM.Root | null = null
    let host: HTMLElement | null = null

    const mount = () => {
      if (!document.body) return
      host = document.getElementById(FLOATING_HOST_ID)
      if (!host) {
        host = document.createElement('div')
        host.id = FLOATING_HOST_ID
        document.body.appendChild(host)
      }
      if (!root) {
        root = ReactDOM.createRoot(host)
      }
      root.render(React.createElement(FloatingPluginManager))
    }

    const unmount = () => {
      if (root) {
        try {
          root.unmount()
        } catch {}
        root = null
      }
      if (host && host.parentNode) {
        host.parentNode.removeChild(host)
        host = null
      }
    }

    const safeMount = () => {
      if (document.readyState === 'loading') {
        const onReady = () => {
          document.removeEventListener('DOMContentLoaded', onReady)
          mount()
        }
        document.addEventListener('DOMContentLoaded', onReady)
      } else {
        mount()
      }
    }

    if (typeof (ctx as any).effect === 'function') {
      ;(ctx as any).effect(() => {
        safeMount()
        return () => unmount()
      }, 'plugin-manager: floating mount')
    } else {
      safeMount()
    }
  }
}
