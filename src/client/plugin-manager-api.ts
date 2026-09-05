/**
 * Typed client API wrapper for td-integration Plugin Manager
 */

export interface PluginInfo {
  id: string
  name: string
  version: string
  description: string
  author?: string
  homepage?: string
  disabled: boolean
  system: boolean
  removable: boolean
}

export interface PluginsPayload {
  profile: string
  profileDir: string
  plugins: PluginInfo[]
  groups: Record<string, string[]>
  groupOrder: string[]
}

/**
 * Full page reload — the ONLY shared "refresh" logic for both the Settings
 * section and the floating window.
 *
 * Why a full reload: the browser's client plugin graph (`window.__DSH_BOOT__`)
 * is composed by the host at page-load time. Plugin enable/disable changes the
 * live host loader, but the running page is never told about graph membership
 * changes (the SSE `graph` frame is only sent on connect and is a no-op), so
 * the page must reload to pick up enabled/disabled plugins.
 */
export function reloadPage(): void {
  window.location.reload()
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    let errText = res.statusText
    try {
      const errJson = await res.json()
      if (errJson?.error?.message) errText = errJson.error.message
      else if (errJson?.error) errText = String(errJson.error)
    } catch {
      // ignore
    }
    throw new Error(errText || `HTTP ${res.status}`)
  }
  const json = await res.json()
  if (json.ok && json.value !== undefined) return json.value as T
  return json as T
}

export const pluginManagerApi = {
  async getPlugins(): Promise<PluginsPayload> {
    return request<PluginsPayload>('/td-integration/api/plugins')
  },

  /**
   * Toggle one plugin. Resolves only after the host loader has actually
   * applied the change (`settled: true`) — safe to `reloadPage()` right away.
   */
  async togglePlugin(id: string, enable: boolean): Promise<{ ok: boolean; settled?: boolean }> {
    return request<{ ok: boolean; settled?: boolean }>('/td-integration/api/plugins/toggle', {
      method: 'POST',
      body: JSON.stringify({ id, enable }),
    })
  },

  /** Group batch toggle; likewise resolves after the host has applied it. */
  async toggleGroup(group: string, enable: boolean): Promise<{ ok: boolean; count: number; settled?: boolean }> {
    return request<{ ok: boolean; count: number; settled?: boolean }>('/td-integration/api/plugins/toggle-group', {
      method: 'POST',
      body: JSON.stringify({ group, enable }),
    })
  },

  async createGroup(name: string): Promise<{ ok: boolean; groups: Record<string, string[]>; groupOrder: string[] }> {
    return request('/td-integration/api/plugins/groups', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', name }),
    })
  },

  async renameGroup(name: string, newName: string): Promise<{ ok: boolean; groups: Record<string, string[]>; groupOrder: string[] }> {
    return request('/td-integration/api/plugins/groups', {
      method: 'POST',
      body: JSON.stringify({ action: 'rename', name, newName }),
    })
  },

  async deleteGroup(name: string): Promise<{ ok: boolean; groups: Record<string, string[]>; groupOrder: string[] }> {
    return request('/td-integration/api/plugins/groups', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', name }),
    })
  },

  async addMember(group: string, member: string): Promise<{ ok: boolean; groups: Record<string, string[]>; groupOrder: string[] }> {
    return request('/td-integration/api/plugins/groups', {
      method: 'POST',
      body: JSON.stringify({ action: 'add-member', name: group, member }),
    })
  },

  async removeMember(group: string, member: string): Promise<{ ok: boolean; groups: Record<string, string[]>; groupOrder: string[] }> {
    return request('/td-integration/api/plugins/groups', {
      method: 'POST',
      body: JSON.stringify({ action: 'remove-member', name: group, member }),
    })
  },

  async uninstall(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/td-integration/api/plugins/uninstall', {
      method: 'POST',
      body: JSON.stringify({ id }),
    })
  },
}
