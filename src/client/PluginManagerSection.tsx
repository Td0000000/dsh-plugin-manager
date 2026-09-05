/**
 * Plugin Manager Section for DSH Settings:
 * Embedded in Settings to manage installed DSH plugins,
 * custom persistent groups (accordion collapsible bars),
 * group-level batch enable/disable, and per-plugin enable/disable/uninstall.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  pluginManagerApi,
  reloadPage,
  type PluginInfo,
  type PluginsPayload,
} from './plugin-manager-api'
import {
  loadFloatingSettings,
  saveFloatingSettings,
  type FloatingMascotSettings,
} from './floating-settings'
import { DEFAULT_PIXEL_WHALE_SVG } from './default-whale-svg'
import styles from './PluginManagerSection.module.css'

interface ModalState {
  type: 'create-group' | 'rename-group' | 'delete-group' | 'uninstall-plugin'
  groupName?: string
  pluginId?: string
  pluginName?: string
}

export function PluginManagerSection() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [profile, setProfile] = useState('web')
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [groups, setGroups] = useState<Record<string, string[]>>({})
  const [groupOrder, setGroupOrder] = useState<string[]>([])
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [operatingId, setOperatingId] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState | null>(null)
  const [modalInput, setModalInput] = useState('')

  // Floating window settings modal
  const [showFloatModal, setShowFloatModal] = useState(false)
  const [floatSettings, setFloatSettings] = useState<FloatingMascotSettings>(loadFloatingSettings)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const updateFloatSettings = (changes: Partial<FloatingMascotSettings>) => {
    const updated = saveFloatingSettings(changes)
    setFloatSettings(updated)
  }

  const handleUploadCustomIcon = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      alert('图片大小超出限制（请小于 2MB）')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const res = reader.result as string
      updateFloatSettings({ customIcon: res })
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleToggleVisibleGroup = (groupKey: string) => {
    // If null, current is all selected
    const all = [...groupOrder, '__ungrouped__']
    const current = floatSettings.visibleGroups ?? all
    let next: string[]
    if (current.includes(groupKey)) {
      next = current.filter((k) => k !== groupKey)
    } else {
      next = [...current, groupKey]
    }
    updateFloatSettings({ visibleGroups: next })
  }

  const handleToggleSelectAllGroups = () => {
    const all = [...groupOrder, '__ungrouped__']
    const current = floatSettings.visibleGroups ?? all
    if (current.length === all.length) {
      updateFloatSettings({ visibleGroups: [] })
    } else {
      updateFloatSettings({ visibleGroups: null }) // null = all
    }
  }

  const refreshData = async (silent = false) => {
    try {
      if (!silent) {
        setLoading(true)
      }
      setError(null)
      const data: PluginsPayload = await pluginManagerApi.getPlugins()
      setProfile(data.profile || 'web')
      setPlugins(data.plugins || [])
      setGroups(data.groups || {})
      setGroupOrder(data.groupOrder || Object.keys(data.groups || {}))

      // Initialize all groups as expanded by default
      setExpandedGroups((prev) => {
        const next = { ...prev }
        for (const g of data.groupOrder || []) {
          if (next[g] === undefined) next[g] = true
        }
        if (next['__ungrouped__'] === undefined) next['__ungrouped__'] = true
        return next
      })
    } catch (err: any) {
      if (!silent) setError(err?.message || '加载插件列表失败')
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }

  // Hot refresh: initial fetch + periodic polling + window focus detection
  useEffect(() => {
    void refreshData(false)

    const interval = setInterval(() => {
      void refreshData(true)
    }, 2500)

    const onFocus = () => {
      void refreshData(true)
    }
    window.addEventListener('focus', onFocus)

    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const toggleAccordion = (name: string) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [name]: !prev[name],
    }))
  }

  // Filter plugins by search query and exclude official system base plugins
  const filteredPlugins = useMemo(() => {
    // Hide DSH built-in system base/web plugins from the list
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

  // Map of pluginId -> PluginInfo
  const pluginMap = useMemo(() => {
    const map = new Map<string, PluginInfo>()
    for (const p of filteredPlugins) {
      map.set(p.id, p)
    }
    return map
  }, [filteredPlugins])

  // All plugin IDs assigned to any group
  const groupedPluginIds = useMemo(() => {
    const set = new Set<string>()
    for (const g of Object.keys(groups)) {
      for (const id of groups[g] || []) {
        set.add(id)
      }
    }
    return set
  }, [groups])

  // Ungrouped plugins
  const ungroupedPlugins = useMemo(() => {
    return filteredPlugins.filter((p) => !groupedPluginIds.has(p.id))
  }, [filteredPlugins, groupedPluginIds])

  // Single plugin toggle enable/disable
  const handleTogglePlugin = async (p: PluginInfo) => {
    if (p.system) return
    const nextEnable = p.disabled // if currently disabled, enable it
    setOperatingId(p.id)
    try {
      // The API resolves only after the host loader applied the change; the
      // full page reload then composes the fresh client plugin graph.
      const res = await pluginManagerApi.togglePlugin(p.id, nextEnable)
      syncAfterToggle(res.settled)
    } catch (err: any) {
      alert(`操作失败: ${err?.message || err}`)
      void refreshData()
    } finally {
      setOperatingId(null)
    }
  }

  /**
   * Shared post-toggle sync: the running page keeps its stale client plugin
   * graph until a full reload, so enabling a plugin would otherwise look like
   * a no-op. `settled === false` means the host timed out — leave the page
   * alone and let the user refresh manually.
   */
  const syncAfterToggle = (settled?: boolean) => {
    if (settled === false) {
      alert('插件状态同步超时，请点击「刷新」按钮重新加载页面')
      return
    }
    reloadPage()
  }

  // Group-level batch toggle enable/disable
  const handleToggleGroup = async (groupName: string, enable: boolean) => {
    const members = groups[groupName] || []
    if (members.length === 0) return
    setOperatingId(`group-${groupName}`)
    try {
      const res = await pluginManagerApi.toggleGroup(groupName, enable)
      syncAfterToggle(res.settled)
    } catch (err: any) {
      alert(`批量操作失败: ${err?.message || err}`)
      void refreshData()
    } finally {
      setOperatingId(null)
    }
  }

  // Check group active state (all enabled, all disabled, or mixed)
  const getGroupActiveState = (groupName: string) => {
    const members = groups[groupName] || []
    const memberPlugins = members.map((id) => plugins.find((p) => p.id === id)).filter(Boolean) as PluginInfo[]
    const nonSystem = memberPlugins.filter((p) => !p.system)
    if (nonSystem.length === 0) return { allEnabled: false, enabledCount: 0, total: memberPlugins.length }
    const enabledCount = nonSystem.filter((p) => !p.disabled).length
    return {
      allEnabled: enabledCount === nonSystem.length,
      enabledCount,
      total: memberPlugins.length,
    }
  }

  // Group mutations
  const handleCreateGroup = async () => {
    const name = modalInput.trim()
    if (!name) return
    try {
      const res = await pluginManagerApi.createGroup(name)
      setGroups(res.groups)
      setGroupOrder(res.groupOrder)
      setExpandedGroups((prev) => ({ ...prev, [name]: true }))
      setModal(null)
      setModalInput('')
    } catch (err: any) {
      alert(`创建分组失败: ${err?.message || err}`)
    }
  }

  const handleRenameGroup = async () => {
    if (!modal?.groupName) return
    const newName = modalInput.trim()
    if (!newName || newName === modal.groupName) {
      setModal(null)
      return
    }
    try {
      const res = await pluginManagerApi.renameGroup(modal.groupName, newName)
      setGroups(res.groups)
      setGroupOrder(res.groupOrder)
      setModal(null)
      setModalInput('')
    } catch (err: any) {
      alert(`重命名失败: ${err?.message || err}`)
    }
  }

  const handleDeleteGroup = async () => {
    if (!modal?.groupName) return
    try {
      const res = await pluginManagerApi.deleteGroup(modal.groupName)
      setGroups(res.groups)
      setGroupOrder(res.groupOrder)
      setModal(null)
    } catch (err: any) {
      alert(`删除分组失败: ${err?.message || err}`)
    }
  }

  const handleAddMember = async (groupName: string, memberId: string) => {
    try {
      const res = await pluginManagerApi.addMember(groupName, memberId)
      setGroups(res.groups)
      setGroupOrder(res.groupOrder)
    } catch (err: any) {
      alert(`加入分组失败: ${err?.message || err}`)
    }
  }

  const handleRemoveMember = async (groupName: string, memberId: string) => {
    try {
      const res = await pluginManagerApi.removeMember(groupName, memberId)
      setGroups(res.groups)
      setGroupOrder(res.groupOrder)
    } catch (err: any) {
      alert(`移出分组失败: ${err?.message || err}`)
    }
  }

  // Uninstall plugin
  const handleUninstallPlugin = async () => {
    if (!modal?.pluginId) return
    try {
      setOperatingId(modal.pluginId)
      await pluginManagerApi.uninstall(modal.pluginId)
      setModal(null)
      void refreshData()
    } catch (err: any) {
      alert(`卸载失败: ${err?.message || err}`)
    } finally {
      setOperatingId(null)
    }
  }

  const renderPluginCard = (p: PluginInfo, inGroup?: string) => {
    const isOperating = operatingId === p.id
    return (
      <div
        key={p.id}
        className={`${styles.pluginCard} ${p.disabled ? styles.pluginCardDisabled : ''}`}
      >
        <div className={styles.pluginLeft}>
          <div className={styles.pluginInfo}>
            <div className={styles.pluginTitleLine}>
              <span className={styles.pluginNameText}>{p.name}</span>
              {p.version && <span className={styles.pluginVersionText}>v{p.version}</span>}
              {p.system ? (
                <span className={`${styles.statusPill} ${styles.statusSystem}`}>系统核心</span>
              ) : p.disabled ? (
                <span className={`${styles.statusPill} ${styles.statusDisabled}`}>已停用</span>
              ) : (
                <span className={`${styles.statusPill} ${styles.statusActive}`}>已启用</span>
              )}
            </div>
            {p.description && (
              <div className={styles.pluginDescText} title={p.description}>
                {p.description}
              </div>
            )}
          </div>
        </div>

        <div className={styles.pluginRight}>
          {/* Add to group / Remove from group */}
          {inGroup ? (
            <button
              className={`${styles.btn} ${styles.btnSmall}`}
              onClick={() => handleRemoveMember(inGroup, p.id)}
              title="从当前分组移出"
            >
              移出分组
            </button>
          ) : (
            groupOrder.length > 0 && (
              <select
                className={styles.selectGroup}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) {
                    void handleAddMember(e.target.value, p.id)
                    e.target.value = ''
                  }
                }}
              >
                <option value="" disabled>
                  + 加入分组...
                </option>
                {groupOrder.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            )
          )}

          {/* Toggle enable / disable */}
          {!p.system && (
            <button
              className={`${styles.btn} ${styles.btnSmall}`}
              disabled={isOperating}
              onClick={() => handleTogglePlugin(p)}
              style={{
                color: p.disabled ? 'var(--dsw-alias-state-business-primary, #16a34a)' : 'var(--dsw-alias-state-error-primary, #ef4444)',
              }}
            >
              {p.disabled ? '启用' : '禁用'}
            </button>
          )}

          {/* Uninstall */}
          {p.removable && (
            <button
              className={`${styles.btn} ${styles.btnDanger} ${styles.btnSmall}`}
              onClick={() =>
                setModal({
                  type: 'uninstall-plugin',
                  pluginId: p.id,
                  pluginName: p.name,
                })
              }
              title="卸载插件"
            >
              卸载
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      {/* Header Toolbar */}
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <p className={styles.subtitle}>
            当前 Profile: <strong>{profile}</strong> · 共 {plugins.length} 个插件 ·
            支持自定义分组、批量开关与一键卸载
          </p>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => {
                setModalInput('')
                setModal({ type: 'create-group' })
              }}
            >
              + 新建分组
            </button>
            <button
              className={styles.btn}
              onClick={() => reloadPage()}
              title="重新加载整个页面，使插件启用/禁用状态即时生效 (Reload)"
            >
              🔄 刷新页面
            </button>
            <button
              className={styles.btn}
              onClick={() => {
                setFloatSettings(loadFloatingSettings())
                setShowFloatModal(true)
              }}
              title="设置插件管理浮动窗口"
            >
              ⚙️ 浮动窗口设置
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className={styles.toolbar}>
          <input
            type="text"
            className={styles.searchInput}
            placeholder="搜索插件名称或描述..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div style={{ color: '#ef4444', marginBottom: 16, fontSize: 13 }}>
          错误: {error}
        </div>
      )}

      {loading && plugins.length === 0 ? (
        <div className={styles.emptyTip}>正在加载插件列表...</div>
      ) : (
        <div className={styles.groupList}>
          {/* Custom Accordion Groups */}
          {groupOrder.map((groupName) => {
            const memberIds = groups[groupName] || []
            const groupPlugins = memberIds
              .map((id) => pluginMap.get(id))
              .filter(Boolean) as PluginInfo[]
            const isExpanded = expandedGroups[groupName] ?? true
            const { allEnabled, enabledCount, total } = getGroupActiveState(groupName)

            return (
              <div key={groupName} className={styles.groupItem}>
                {/* Accordion Header */}
                <div
                  className={styles.groupHeader}
                  onClick={() => toggleAccordion(groupName)}
                >
                  <div className={styles.groupHeaderLeft}>
                    <span
                      className={`${styles.chevron} ${isExpanded ? styles.chevronExpanded : ''}`}
                    >
                      ▶
                    </span>
                    <span className={styles.groupName}>{groupName}</span>
                    <span className={styles.badge}>
                      {total} 个插件 {total > 0 ? `· ${enabledCount} 启用` : ''}
                    </span>
                  </div>

                  <div
                    className={styles.groupHeaderRight}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* Batch toggle buttons */}
                    {total > 0 && (
                      <div style={{ display: 'inline-flex', gap: 6 }}>
                        <button
                          className={`${styles.btn} ${styles.btnSmall}`}
                          onClick={() => void handleToggleGroup(groupName, true)}
                          title="一键启动分组内所有插件"
                        >
                          一键启动
                        </button>
                        <button
                          className={`${styles.btn} ${styles.btnSmall}`}
                          onClick={() => void handleToggleGroup(groupName, false)}
                          title="一键禁用分组内所有插件"
                        >
                          一键禁用
                        </button>
                      </div>
                    )}

                    {/* Rename */}
                    <button
                      className={`${styles.btn} ${styles.btnSmall}`}
                      onClick={() => {
                        setModalInput(groupName)
                        setModal({ type: 'rename-group', groupName })
                      }}
                    >
                      重命名
                    </button>

                    {/* Delete Group */}
                    <button
                      className={`${styles.btn} ${styles.btnDanger} ${styles.btnSmall}`}
                      onClick={() => setModal({ type: 'delete-group', groupName })}
                    >
                      删除
                    </button>
                  </div>
                </div>

                {/* Accordion Body */}
                {isExpanded && (
                  <div className={styles.groupContent}>
                    {groupPlugins.length === 0 ? (
                      <div className={styles.emptyTip}>
                        当前分组暂无插件，可在下方未分组插件中点击「加入分组」进行添加。
                      </div>
                    ) : (
                      groupPlugins.map((p) => renderPluginCard(p, groupName))
                    )}
                  </div>
                )}
              </div>
            )
          })}

          {/* Ungrouped Plugins Accordion */}
          {ungroupedPlugins.length > 0 && (
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
                  <span className={styles.badge}>{ungroupedPlugins.length} 个插件</span>
                </div>
              </div>

              {(expandedGroups['__ungrouped__'] ?? true) && (
                <div className={styles.groupContent}>
                  {ungroupedPlugins.map((p) => renderPluginCard(p))}
                </div>
              )}
            </div>
          )}

          {plugins.length === 0 && !loading && (
            <div className={styles.emptyTip}>未发现已安装的插件</div>
          )}
        </div>
      )}

      {/* Modal Dialog */}
      {modal && (
        <div className={styles.modalOverlay} onClick={() => setModal(null)}>
          <div className={styles.modalBox} onClick={(e) => e.stopPropagation()}>
            {modal.type === 'create-group' && (
              <>
                <h3 className={styles.modalTitle}>新建插件分组</h3>
                <input
                  type="text"
                  className={styles.searchInput}
                  placeholder="输入分组名称（如：开发工具、效率增强）"
                  value={modalInput}
                  autoFocus
                  onChange={(e) => setModalInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleCreateGroup()}
                />
                <div className={styles.modalFooter}>
                  <button className={styles.btn} onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => void handleCreateGroup()}
                  >
                    确认创建
                  </button>
                </div>
              </>
            )}

            {modal.type === 'rename-group' && (
              <>
                <h3 className={styles.modalTitle}>重命名分组</h3>
                <input
                  type="text"
                  className={styles.searchInput}
                  value={modalInput}
                  autoFocus
                  onChange={(e) => setModalInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void handleRenameGroup()}
                />
                <div className={styles.modalFooter}>
                  <button className={styles.btn} onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => void handleRenameGroup()}
                  >
                    确认保存
                  </button>
                </div>
              </>
            )}

            {modal.type === 'delete-group' && (
              <>
                <h3 className={styles.modalTitle}>删除分组</h3>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted, #888)' }}>
                  确定要删除分组 <strong>{modal.groupName}</strong> 吗？
                  <br />
                  分组内的插件不会被删除，将归入「未分组插件」。
                </p>
                <div className={styles.modalFooter}>
                  <button className={styles.btn} onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => void handleDeleteGroup()}
                  >
                    确认删除
                  </button>
                </div>
              </>
            )}

            {modal.type === 'uninstall-plugin' && (
              <>
                <h3 className={styles.modalTitle}>卸载插件</h3>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted, #888)' }}>
                  确定要卸载插件 <strong>{modal.pluginName || modal.pluginId}</strong> 吗？
                  <br />
                  将从当前 profile 的 package.json 与 bundles 配置中完全移除。
                </p>
                <div className={styles.modalFooter}>
                  <button className={styles.btn} onClick={() => setModal(null)}>
                    取消
                  </button>
                  <button
                    className={`${styles.btn} ${styles.btnDanger}`}
                    onClick={() => void handleUninstallPlugin()}
                  >
                    确认卸载
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Floating Window Settings Modal */}
      {showFloatModal && (
        <div className={styles.modalOverlay} onClick={() => setShowFloatModal(false)}>
          <div
            className={`${styles.modalBox} ${styles.floatModalBox}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className={styles.modalTitle}>deepseek插件管理浮动窗口设置</h3>

            {/* 1. Switch Enable/Disable */}
            <div className={styles.settingSection}>
              <div className={styles.settingRow}>
                <div className={styles.settingRowLabel}>
                  <span className={styles.settingRowTitle}>插件管理浮动窗口总开关</span>
                  <span className={styles.settingRowHint}>在界面显示或关闭插件管理浮动窗口</span>
                </div>
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    checked={floatSettings.enabled}
                    onChange={(e) => updateFloatSettings({ enabled: e.target.checked })}
                  />
                  <span className={styles.slider} />
                </label>
              </div>

              <div className={styles.settingRow}>
                <div className={styles.settingRowLabel}>
                  <span className={styles.settingRowTitle}>窗口内自由浮动</span>
                  <span className={styles.settingRowHint}>开启后松手停在任意位置；关闭后自动磁吸贴边</span>
                </div>
                <label className={styles.switch}>
                  <input
                    type="checkbox"
                    checked={floatSettings.freeFloat}
                    onChange={(e) => updateFloatSettings({ freeFloat: e.target.checked })}
                  />
                  <span className={styles.slider} />
                </label>
              </div>

              <div className={styles.settingRow}>
                <div className={styles.settingRowLabel}>
                  <span className={styles.settingRowTitle}>图标尺寸大小</span>
                  <span className={styles.settingRowHint}>手动调节浮动图标尺寸 (32px ~ 128px)</span>
                </div>
                <div className={styles.rangeGroup}>
                  <input
                    type="range"
                    min="32"
                    max="128"
                    step="2"
                    value={floatSettings.size}
                    className={styles.rangeInput}
                    onChange={(e) => updateFloatSettings({ size: parseInt(e.target.value, 10) })}
                  />
                  <span className={styles.rangeValue}>{floatSettings.size} px</span>
                </div>
              </div>
            </div>

            {/* 2. Icon Specification & Custom Upload */}
            <div className={styles.settingSection}>
              <div className={styles.settingSectionTitle}>浮动图标规格与自定义上传</div>

              <div className={styles.specCard}>
                <div style={{ fontWeight: 600, fontSize: 11 }}>📋 图标规格要求</div>
                <ul className={styles.specList}>
                  <li>比例：<strong>1:1</strong> 正方形像素图</li>
                  <li>标准规格：推荐 <strong>64 × 64 px</strong>（兼容 32~256 px）</li>
                  <li>支持格式：<strong>PNG / SVG / GIF / WebP</strong>（需带透明背景，≤2MB）</li>
                </ul>

                <div className={styles.uploadPreviewRow}>
                  <div className={styles.previewBox}>
                    {floatSettings.customIcon ? (
                      <img src={floatSettings.customIcon} alt="Preview" className={styles.previewImg} />
                    ) : (
                      <div
                        className={styles.previewImg}
                        dangerouslySetInnerHTML={{ __html: DEFAULT_PIXEL_WHALE_SVG }}
                      />
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/svg+xml,image/gif,image/webp,image/jpeg"
                      style={{ display: 'none' }}
                      onChange={handleUploadCustomIcon}
                    />
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary} ${styles.btnSmall}`}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      上传自定义图标
                    </button>
                    {floatSettings.customIcon && (
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnSmall}`}
                        onClick={() => updateFloatSettings({ customIcon: null })}
                      >
                        恢复默认像素鲸鱼
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* 3. Visible Groups in Floating Window */}
            <div className={styles.settingSection}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className={styles.settingSectionTitle}>在浮动窗口中显示的插件分组</div>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSmall}`}
                  onClick={handleToggleSelectAllGroups}
                >
                  {(floatSettings.visibleGroups ?? [...groupOrder, '__ungrouped__']).length ===
                  groupOrder.length + 1
                    ? '全部取消'
                    : '全部选中'}
                </button>
              </div>

              <div className={styles.checkboxList}>
                {groupOrder.map((name) => {
                  const isChecked =
                    floatSettings.visibleGroups === null ||
                    floatSettings.visibleGroups.includes(name)
                  return (
                    <label key={name} className={styles.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => handleToggleVisibleGroup(name)}
                      />
                      <span>{name}</span>
                    </label>
                  )
                })}

                <label className={styles.checkboxItem}>
                  <input
                    type="checkbox"
                    checked={
                      floatSettings.visibleGroups === null ||
                      floatSettings.visibleGroups.includes('__ungrouped__')
                    }
                    onChange={() => handleToggleVisibleGroup('__ungrouped__')}
                  />
                  <span>未分组插件</span>
                </label>
              </div>
            </div>

            {/* Footer */}
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  updateFloatSettings({ pos: { x: window.innerWidth - floatSettings.size - 24, y: 84 } })
                  alert('已将浮动窗口位置重置到右上角')
                }}
              >
                重置位置到右上角
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => setShowFloatModal(false)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
