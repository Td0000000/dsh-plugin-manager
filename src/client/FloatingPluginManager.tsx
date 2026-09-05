import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react'
import {
  loadFloatingSettings,
  saveFloatingSettings,
  onFloatingSettingsChange,
  type FloatingMascotSettings,
} from './floating-settings'
import {
  pluginManagerApi,
  reloadPage,
  type PluginInfo,
  type PluginsPayload,
} from './plugin-manager-api'
import { DEFAULT_PIXEL_WHALE_SVG } from './default-whale-svg'
import styles from './FloatingPluginManager.module.css'

const VIEW_MARGIN = 12

function clampNumber(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val))
}

function clampPosition(x: number, y: number, size: number): { x: number; y: number } {
  const winW = (typeof window !== 'undefined' && window.innerWidth) || 1280
  const winH = (typeof window !== 'undefined' && window.innerHeight) || 800
  const maxX = Math.max(VIEW_MARGIN, winW - size - VIEW_MARGIN)
  const maxY = Math.max(VIEW_MARGIN, winH - size - VIEW_MARGIN)
  return {
    x: clampNumber(x, VIEW_MARGIN, maxX),
    y: clampNumber(y, VIEW_MARGIN, maxY),
  }
}

export function FloatingPluginManager(): ReactNode {
  const [settings, setSettings] = useState<FloatingMascotSettings>(loadFloatingSettings)
  const [open, setOpen] = useState(false)
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [groups, setGroups] = useState<Record<string, string[]>>({})
  const [groupOrder, setGroupOrder] = useState<string[]>([])
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [operatingId, setOperatingId] = useState<string | null>(null)

  const mascotRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    id: number
    startX: number
    startY: number
    baseX: number
    baseY: number
    lastX: number
    lastY: number
    moved: boolean
  } | null>(null)

  // Listen to settings changes from Settings Tab modal
  useEffect(() => {
    return onFloatingSettingsChange((newSettings) => {
      setSettings(newSettings)
    })
  }, [])

  // Fetch plugin data when window is opened or on focus
  const refreshPluginData = async (silent = false) => {
    try {
      const data: PluginsPayload = await pluginManagerApi.getPlugins()
      setPlugins(data.plugins || [])
      setGroups(data.groups || {})
      setGroupOrder(data.groupOrder || Object.keys(data.groups || {}))

      setExpandedGroups((prev) => {
        const next = { ...prev }
        for (const g of data.groupOrder || []) {
          if (next[g] === undefined) next[g] = true
        }
        if (next['__ungrouped__'] === undefined) next['__ungrouped__'] = true
        return next
      })
    } catch {}
  }

  useEffect(() => {
    if (open) {
      void refreshPluginData(false)
    }
  }, [open])

  // Drag & Pointer event handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = mascotRef.current
    if (!el || dragRef.current) return

    try {
      el.setPointerCapture(e.pointerId)
    } catch {}

    dragRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseX: settings.pos.x,
      baseY: settings.pos.y,
      lastX: settings.pos.x,
      lastY: settings.pos.y,
      moved: false,
    }

    el.classList.remove(styles.mascotSettle)
    el.classList.add(styles.mascotDragging)
    e.preventDefault()
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return

    const dx = e.clientX - d.startX
    const dy = e.clientY - d.startY

    if (!d.moved && dx * dx + dy * dy < 9) return
    d.moved = true

    const next = clampPosition(d.baseX + dx, d.baseY + dy, settings.size)
    d.lastX = next.x
    d.lastY = next.y

    const el = mascotRef.current
    if (el) {
      el.style.left = `${next.x}px`
      el.style.top = `${next.y}px`
    }
  }

  const finishDrag = (canceled = false) => {
    const d = dragRef.current
    const el = mascotRef.current
    dragRef.current = null

    if (!el) return

    el.classList.remove(styles.mascotDragging)
    el.classList.add(styles.mascotSettle)

    // Pure click: toggle floating window
    if (!canceled && d && !d.moved) {
      setOpen((prev) => !prev)
      return
    }

    const finalX = d ? d.lastX : settings.pos.x
    const finalY = d ? d.lastY : settings.pos.y

    let targetX = finalX
    // If not free-floating, snap to nearest horizontal edge
    if (!settings.freeFloat) {
      const winW = (typeof window !== 'undefined' && window.innerWidth) || 1280
      const isLeftHalf = finalX < (winW - settings.size) / 2
      targetX = isLeftHalf ? VIEW_MARGIN : winW - settings.size - VIEW_MARGIN
    }

    const next = clampPosition(targetX, finalY, settings.size)
    el.style.left = `${next.x}px`
    el.style.top = `${next.y}px`

    saveFloatingSettings({ pos: next })
  }

  // Filter plugins by search query and exclude system base
  const filteredPlugins = useMemo(() => {
    const visible = plugins.filter((p) => !p.system)
    if (!searchQuery.trim()) return visible
    const q = searchQuery.toLowerCase()
    return visible.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q))
    )
  }, [plugins, searchQuery])

  const pluginMap = useMemo(() => {
    const map = new Map<string, PluginInfo>()
    for (const p of filteredPlugins) {
      map.set(p.id, p)
    }
    return map
  }, [filteredPlugins])

  // Filter groups according to user selection in settings
  const displayedGroupNames = useMemo(() => {
    if (settings.visibleGroups === null) {
      return groupOrder
    }
    return groupOrder.filter((name) => settings.visibleGroups?.includes(name))
  }, [groupOrder, settings.visibleGroups])

  const showUngrouped = useMemo(() => {
    if (settings.visibleGroups === null) return true
    return settings.visibleGroups.includes('__ungrouped__')
  }, [settings.visibleGroups])

  const ungroupedPlugins = useMemo(() => {
    const groupedIds = new Set<string>()
    for (const g of Object.keys(groups)) {
      for (const id of groups[g] || []) groupedIds.add(id)
    }
    return filteredPlugins.filter((p) => !groupedIds.has(p.id))
  }, [filteredPlugins, groups])

  /**
   * The toggle API only resolves after the host loader has applied the change,
   * so a full page reload right away composes the fresh client plugin graph.
   * Without this reload the running page keeps the stale graph and enabling a
   * plugin would look like a no-op ("没反应").
   */
  const syncAfterToggle = (settled?: boolean) => {
    if (settled === false) {
      alert('插件状态同步超时，请点击「刷新页面」手动重新加载')
      return
    }
    reloadPage()
  }

  // Single plugin toggle
  const handleTogglePlugin = async (p: PluginInfo) => {
    if (p.system) return
    const nextEnable = p.disabled
    setOperatingId(p.id)
    try {
      const res = await pluginManagerApi.togglePlugin(p.id, nextEnable)
      syncAfterToggle(res.settled)
    } catch (err: any) {
      alert(`操作失败: ${err?.message || err}`)
      void refreshPluginData()
    } finally {
      setOperatingId(null)
    }
  }

  // Group batch toggle
  const handleToggleGroup = async (groupName: string, enable: boolean) => {
    const members = groups[groupName] || []
    if (members.length === 0) return
    setOperatingId(`group-${groupName}`)
    try {
      const res = await pluginManagerApi.toggleGroup(groupName, enable)
      syncAfterToggle(res.settled)
    } catch (err: any) {
      alert(`批量操作失败: ${err?.message || err}`)
      void refreshPluginData()
    } finally {
      setOperatingId(null)
    }
  }

  const toggleAccordion = (name: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [name]: !prev[name],
    }))
  }

  // Window position calculated relative to mascot
  const windowPosition = useMemo(() => {
    const winW = (typeof window !== 'undefined' && window.innerWidth) || 1280
    const winH = (typeof window !== 'undefined' && window.innerHeight) || 800
    const windowWidth = 380
    const windowHeight = 480

    let top = settings.pos.y + settings.size + 10
    if (top + windowHeight > winH - VIEW_MARGIN) {
      top = Math.max(VIEW_MARGIN, settings.pos.y - windowHeight - 10)
    }

    let left = settings.pos.x + settings.size - windowWidth
    if (left < VIEW_MARGIN) {
      left = Math.min(settings.pos.x, winW - windowWidth - VIEW_MARGIN)
    }
    if (left + windowWidth > winW - VIEW_MARGIN) {
      left = winW - windowWidth - VIEW_MARGIN
    }

    return {
      top: `${top}px`,
      left: `${Math.max(VIEW_MARGIN, left)}px`,
    }
  }, [settings.pos, settings.size])

  if (!settings.enabled) {
    return null
  }

  return (
    <>
      {/* ── 1. Floating Mascot Ball ── */}
      <div
        ref={mascotRef}
        className={`${styles.mascot} ${styles.mascotSettle}`}
        style={{
          left: `${settings.pos.x}px`,
          top: `${settings.pos.y}px`,
          width: `${settings.size}px`,
          height: `${settings.size}px`,
        }}
        title="deepseek插件管理 (点击打开面板，按住拖动)"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={() => finishDrag(false)}
        onPointerCancel={() => finishDrag(true)}
      >
        <div className={styles.mascotImageWrapper}>
          {settings.customIcon ? (
            <img src={settings.customIcon} alt="Mascot Icon" className={styles.mascotImage} />
          ) : (
            <div
              className={styles.mascotImage}
              dangerouslySetInnerHTML={{ __html: DEFAULT_PIXEL_WHALE_SVG }}
            />
          )}
        </div>
      </div>

      {/* ── 2. Floating Window (deepseek插件管理浮动窗口) ── */}
      {/*
        IMPORTANT REQUIREMENT:
        - Do NOT close when clicking elsewhere on the page.
        - Only close via the dedicated '✕' button or re-clicking mascot.
      */}
      {open && (
        <div
          className={styles.floatingWindow}
          style={{
            top: windowPosition.top,
            left: windowPosition.left,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className={styles.windowHeader}>
            <div className={styles.windowTitleGroup}>
              <h3 className={styles.windowTitle}>
                🐳 deepseek插件管理浮动窗口
              </h3>
              <span className={styles.tagPill}>快捷</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                type="button"
                className={styles.refreshPageBtn}
                onClick={() => reloadPage()}
                aria-label="刷新当前页面"
                title="刷新当前页面 (Reload)"
              >
                🔄 刷新页面
              </button>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => setOpen(false)}
                aria-label="关闭窗口"
                title="关闭窗口"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Toolbar */}
          <div className={styles.toolbar}>
            <div className={styles.infoLine}>
              <span>共 {filteredPlugins.length} 个可用插件</span>
              <span>自由悬浮中</span>
            </div>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="快速搜索插件..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Body: Accordion Groups */}
          <div className={styles.windowBody}>
            {displayedGroupNames.map((groupName) => {
              const memberIds = groups[groupName] || []
              const groupPlugins = memberIds
                .map((id) => pluginMap.get(id))
                .filter(Boolean) as PluginInfo[]
              const isExpanded = expandedGroups[groupName] ?? true
              const enabledCount = groupPlugins.filter((p) => !p.disabled && !p.system).length

              return (
                <div key={groupName} className={styles.groupItem}>
                  {/* Group Header */}
                  <div
                    className={styles.groupHeader}
                    onClick={() => toggleAccordion(groupName)}
                  >
                    <div className={styles.groupHeaderLeft}>
                      <span
                        className={`${styles.chevron} ${
                          isExpanded ? styles.chevronExpanded : ''
                        }`}
                      >
                        ▶
                      </span>
                      <span className={styles.groupName}>{groupName}</span>
                      <span className={styles.badge}>
                        {groupPlugins.length} 个 · {enabledCount} 启
                      </span>
                    </div>

                    <div
                      className={styles.groupHeaderRight}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {groupPlugins.length > 0 && (
                        <>
                          <button
                            className={`${styles.btn} ${styles.btnAction}`}
                            onClick={() => void handleToggleGroup(groupName, true)}
                            title="一键启动当前分组全部插件"
                          >
                            一键开启
                          </button>
                          <button
                            className={`${styles.btn} ${styles.btnAction}`}
                            onClick={() => void handleToggleGroup(groupName, false)}
                            title="一键禁用当前分组全部插件"
                          >
                            一键禁用
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Group Plugins */}
                  {isExpanded && (
                    <div className={styles.groupContent}>
                      {groupPlugins.length === 0 ? (
                        <div className={styles.emptyTip}>当前分组暂无插件</div>
                      ) : (
                        groupPlugins.map((p) => {
                          const isOperating = operatingId === p.id
                          return (
                            <div
                              key={p.id}
                              className={`${styles.pluginCard} ${
                                p.disabled ? styles.pluginCardDisabled : ''
                              }`}
                            >
                              <div className={styles.pluginInfo}>
                                <div className={styles.pluginTitleLine}>
                                  <span className={styles.pluginNameText}>{p.name}</span>
                                  {p.disabled ? (
                                    <span className={`${styles.statusPill} ${styles.statusDisabled}`}>
                                      已停用
                                    </span>
                                  ) : (
                                    <span className={`${styles.statusPill} ${styles.statusActive}`}>
                                      已启用
                                    </span>
                                  )}
                                </div>
                                {p.description && (
                                  <div className={styles.pluginDesc} title={p.description}>
                                    {p.description}
                                  </div>
                                )}
                              </div>

                              <button
                                className={`${styles.btn} ${styles.btnAction}`}
                                disabled={isOperating}
                                onClick={() => handleTogglePlugin(p)}
                                style={{
                                  color: p.disabled ? 'var(--dsw-alias-state-business-primary, #16a34a)' : 'var(--dsw-alias-state-error-primary, #ef4444)',
                                }}
                              >
                                {p.disabled ? '启用' : '禁用'}
                              </button>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Ungrouped Plugins */}
            {showUngrouped && ungroupedPlugins.length > 0 && (
              <div className={styles.groupItem}>
                <div
                  className={styles.groupHeader}
                  onClick={() => toggleAccordion('__ungrouped__')}
                >
                  <div className={styles.groupHeaderLeft}>
                    <span
                      className={`${styles.chevron} ${
                        expandedGroups['__ungrouped__'] ?? true ? styles.chevronExpanded : ''
                      }`}
                    >
                      ▶
                    </span>
                    <span className={styles.groupName}>未分组插件</span>
                    <span className={styles.badge}>{ungroupedPlugins.length} 个</span>
                  </div>
                </div>

                {(expandedGroups['__ungrouped__'] ?? true) && (
                  <div className={styles.groupContent}>
                    {ungroupedPlugins.map((p) => (
                      <div
                        key={p.id}
                        className={`${styles.pluginCard} ${
                          p.disabled ? styles.pluginCardDisabled : ''
                        }`}
                      >
                        <div className={styles.pluginInfo}>
                          <div className={styles.pluginTitleLine}>
                            <span className={styles.pluginNameText}>{p.name}</span>
                            {p.disabled ? (
                              <span className={`${styles.statusPill} ${styles.statusDisabled}`}>
                                已停用
                              </span>
                            ) : (
                              <span className={`${styles.statusPill} ${styles.statusActive}`}>
                                已启用
                              </span>
                            )}
                          </div>
                          {p.description && (
                            <div className={styles.pluginDesc} title={p.description}>
                              {p.description}
                            </div>
                          )}
                        </div>

                        <button
                          className={`${styles.btn} ${styles.btnAction}`}
                          onClick={() => handleTogglePlugin(p)}
                          style={{
                            color: p.disabled ? '#16a34a' : '#ef4444',
                          }}
                        >
                          {p.disabled ? '启用' : '禁用'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {displayedGroupNames.length === 0 && (!showUngrouped || ungroupedPlugins.length === 0) && (
              <div className={styles.emptyTip}>
                暂无可展示的分组。请在设置页中勾选要在此窗口中展示的分组。
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
