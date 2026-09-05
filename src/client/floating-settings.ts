export interface FloatingMascotSettings {
  enabled: boolean
  size: number
  customIcon: string | null
  freeFloat: boolean
  visibleGroups: string[] | null
  pos: { x: number; y: number }
}

const SETTINGS_KEY = 'dsh-plugin-manager:floating-settings'
const EVENT_NAME = 'dsh-plugin-manager:floating-settings-changed'

const DEFAULT_SETTINGS: FloatingMascotSettings = {
  enabled: true,
  size: 56,
  customIcon: null,
  freeFloat: true,
  visibleGroups: null, // null means all groups
  pos: { x: 0, y: 84 },
}

export function loadFloatingSettings(): FloatingMascotSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        enabled: parsed.enabled ?? true,
        size: typeof parsed.size === 'number' && parsed.size >= 32 && parsed.size <= 128 ? parsed.size : 56,
        customIcon: parsed.customIcon ?? null,
        freeFloat: parsed.freeFloat ?? true,
        visibleGroups: Array.isArray(parsed.visibleGroups) ? parsed.visibleGroups : null,
        pos: parsed.pos && Number.isFinite(parsed.pos.x) && Number.isFinite(parsed.pos.y) ? parsed.pos : { x: window.innerWidth - 80, y: 84 },
      }
    }
  } catch {}
  const initialX = typeof window !== 'undefined' ? window.innerWidth - 80 : 1200
  return { ...DEFAULT_SETTINGS, pos: { x: initialX, y: 84 } }
}

export function saveFloatingSettings(settings: Partial<FloatingMascotSettings>): FloatingMascotSettings {
  const current = loadFloatingSettings()
  const next = { ...current, ...settings }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: next }))
  } catch {}
  return next
}

export function onFloatingSettingsChange(callback: (settings: FloatingMascotSettings) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const handler = (e: Event) => {
    const custom = e as CustomEvent<FloatingMascotSettings>
    callback(custom.detail || loadFloatingSettings())
  }
  window.addEventListener(EVENT_NAME, handler)
  return () => window.removeEventListener(EVENT_NAME, handler)
}
