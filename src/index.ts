/**
 * Host backend for DSH Plugin Manager:
 * Scans installed DSH plugins, manages persistent groups in td-plugin-groups.json,
 * toggles plugins via cordis.patch.yml (triggers DSH live HMR),
 * and handles plugin uninstallation.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export interface Context {
  webServer: {
    register: (opts: {
      kind: 'prefix' | 'exact'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) => () => void
  }
  webRuntime?: {
    trustedHosts?: string[]
  }
  effect: (fn: () => void | (() => void), name?: string) => void
  /** Read a service without the inject requirement (undefined when absent). */
  get?: (name: string, strict?: boolean) => any
  logger?: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }
}

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

export interface PluginGroupsData {
  groups: Record<string, string[]>
  groupOrder: string[]
}

const PROTECTED_PATTERNS = [
  /^cordis:/u,
  /^@cordisjs\//u,
  /^@deepseek-ai\//u,
]

export function isSystemPlugin(nameOrId: string): boolean {
  return PROTECTED_PATTERNS.some((re) => re.test(nameOrId))
}

/**
 * Resolve the profile this plugin manages.
 *
 * DSH 0.1.x was launched with `--profile <name>`, so the original probe read
 * that flag and otherwise assumed `web`. The 0.2.x launchers (including the
 * Electron Desktop Host) instead pass the profile **directory** positionally
 * (`<dshRoot> <profileDir> <runtimeDir> <pnpm> <bin>`), so the old default sent
 * every read and write to a non-existent `profiles/web` directory. Accept the
 * explicit argument, the `--profile` flag, a positional `…/profiles/<name>`
 * path, `DSH_PROFILE`, then fall back to the only installed profile.
 */
export function resolveProfileDir(customProfile?: string): { profile: string; dir: string } {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profilesRoot = join(dshHome, 'profiles')

  /** Recognize an absolute/relative directory whose parent directory is `profiles`. */
  const fromProfileDir = (candidate: string): { profile: string; dir: string } | undefined => {
    let resolved: string
    try {
      resolved = resolve(candidate)
      if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return undefined
    } catch {
      return undefined
    }
    if (basename(dirname(resolved)).toLowerCase() !== 'profiles') return undefined
    const profile = basename(resolved)
    if (!profile || profile === '.' || profile === '..') return undefined
    return { profile, dir: resolved }
  }

  if (customProfile) {
    return fromProfileDir(customProfile) ?? { profile: customProfile, dir: join(profilesRoot, customProfile) }
  }

  const argv = process.argv

  // `dsh --profile <name>` (CLI launched profiles).
  const idx = argv.indexOf('--profile')
  if (idx !== -1 && idx + 1 < argv.length) {
    const val = argv[idx + 1]
    if (val && !val.startsWith('-')) {
      return fromProfileDir(val) ?? { profile: val, dir: join(profilesRoot, val) }
    }
  }

  // DSH 0.2 Host launchers pass the profile directory among the positional args.
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    const hit = fromProfileDir(arg)
    if (hit) return hit
  }

  const envProfile = process.env.DSH_PROFILE
  if (envProfile) {
    return fromProfileDir(envProfile) ?? { profile: envProfile, dir: join(profilesRoot, envProfile) }
  }

  // No explicit signal: use the only installed profile, preferring shipped names.
  try {
    const names = readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
    if (names.length === 1) return { profile: names[0], dir: join(profilesRoot, names[0]) }
    for (const preferred of ['desktop', 'web']) {
      if (names.includes(preferred)) return { profile: preferred, dir: join(profilesRoot, preferred) }
    }
  } catch {}

  return { profile: 'web', dir: join(profilesRoot, 'web') }
}

function getGroupsFilePath(profileDir: string): string {
  return join(profileDir, 'td-plugin-groups.json')
}

export function readGroups(profileDir: string): PluginGroupsData {
  const file = getGroupsFilePath(profileDir)
  if (!existsSync(file)) {
    return { groups: {}, groupOrder: [] }
  }
  try {
    const content = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(content)
    return {
      groups: parsed?.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      groupOrder: Array.isArray(parsed?.groupOrder) ? parsed.groupOrder : [],
    }
  } catch {
    return { groups: {}, groupOrder: [] }
  }
}

export function saveGroups(profileDir: string, data: PluginGroupsData): void {
  const file = getGroupsFilePath(profileDir)
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

function getPatchFilePath(profileDir: string): string {
  return join(profileDir, 'cordis.patch.yml')
}

interface PatchEntry {
  id?: string
  name?: string
  disabled?: boolean
  insert?: PatchEntry[]
  [key: string]: any
}

export function readPatchYaml(profileDir: string): PatchEntry[] {
  const patchFile = getPatchFilePath(profileDir)
  if (!existsSync(patchFile)) {
    return []
  }
  try {
    const raw = readFileSync(patchFile, 'utf-8')
    const parsed = parseYaml(raw)
    return Array.isArray(parsed) ? (parsed as PatchEntry[]) : []
  } catch {
    return []
  }
}

export function writePatchYaml(profileDir: string, patches: PatchEntry[]): void {
  const patchFile = getPatchFilePath(profileDir)
  const yamlStr = stringifyYaml(patches)
  writeFileSync(patchFile, yamlStr, 'utf-8')
}

function findEntryIdInPatches(entries: PatchEntry[], targetId: string): string | null {
  for (const item of entries) {
    if (item.name === targetId && item.id) {
      return item.id
    }
    if (item.id === targetId) {
      return item.id
    }
    if (Array.isArray(item.insert)) {
      const nested = findEntryIdInPatches(item.insert, targetId)
      if (nested) return nested
    }
  }
  return null
}

function findEntryIdInPluginBundle(pluginDir: string, targetId: string): string | null {
  const patchPath = join(pluginDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return null
  try {
    const raw = readFileSync(patchPath, 'utf-8')
    const parsed = parseYaml(raw)
    if (Array.isArray(parsed)) {
      return findEntryIdInPatches(parsed as PatchEntry[], targetId)
    }
  } catch {}
  return null
}

export function scanPlugins(profileDir: string): PluginInfo[] {
  const pluginsMap = new Map<string, PluginInfo>()

  const packageJsonPath = join(profileDir, 'package.json')
  let profileDependencies: Record<string, string> = {}
  let profileBundles: string[] = []

  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
      profileDependencies = pkg.dependencies || {}
      profileBundles = pkg.dsh?.profile?.bundles || []
    } catch {}
  }

  const patches = readPatchYaml(profileDir)
  const disabledMap = new Map<string, boolean>()

  function collectDisabled(entries: PatchEntry[]) {
    for (const item of entries) {
      if (item.id && typeof item.disabled === 'boolean') {
        disabledMap.set(item.id, item.disabled)
      }
      if (item.name && typeof item.disabled === 'boolean') {
        disabledMap.set(item.name, item.disabled)
      }
      if (Array.isArray(item.insert)) {
        collectDisabled(item.insert)
      }
    }
  }
  collectDisabled(patches)

  for (const dep of profileBundles) {
    if (dep.startsWith('@deepseek-ai/dsh-')) continue
    const isSys = isSystemPlugin(dep)
    pluginsMap.set(dep, {
      id: dep,
      name: dep,
      version: profileDependencies[dep] || 'bundled',
      description: '',
      disabled: false,
      system: isSys,
      removable: !isSys,
    })
  }

  for (const dep of Object.keys(profileDependencies)) {
    if (dep.startsWith('@deepseek-ai/dsh-')) continue
    const isSys = isSystemPlugin(dep)
    if (!pluginsMap.has(dep)) {
      pluginsMap.set(dep, {
        id: dep,
        name: dep,
        version: profileDependencies[dep],
        description: '',
        disabled: false,
        system: isSys,
        removable: !isSys,
      })
    }
  }

  const nodeModulesDir = join(profileDir, 'node_modules')
  if (existsSync(nodeModulesDir)) {
    try {
      const rootEntries = readdirSync(nodeModulesDir, { withFileTypes: true })
      for (const entry of rootEntries) {
        if (entry.name.startsWith('.')) continue

        if (entry.name.startsWith('@')) {
          const scopeDir = join(nodeModulesDir, entry.name)
          try {
            const scopedEntries = readdirSync(scopeDir, { withFileTypes: true })
            for (const scopedEntry of scopedEntries) {
              const fullPkgName = `${entry.name}/${scopedEntry.name}`
              if (isSystemPlugin(fullPkgName)) continue
              inspectAndRegisterNodeModule(fullPkgName, join(scopeDir, scopedEntry.name))
            }
          } catch {}
        } else {
          if (isSystemPlugin(entry.name)) continue
          inspectAndRegisterNodeModule(entry.name, join(nodeModulesDir, entry.name))
        }
      }
    } catch {}
  }

  function inspectAndRegisterNodeModule(pkgName: string, pkgDir: string) {
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return

    try {
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      const isDshPlugin =
        pkgJson.dsh !== undefined ||
        pkgJson.keywords?.includes('dsh-plugin') ||
        pkgJson.keywords?.includes('dsh') ||
        pkgName.startsWith('dsh-') ||
        pkgName.includes('dsh-plugin')

      if (!isDshPlugin && !pluginsMap.has(pkgName)) {
        return
      }

      const existing = pluginsMap.get(pkgName)
      const isSys = isSystemPlugin(pkgName)
      const version = pkgJson.version || existing?.version || 'unknown'
      const description = pkgJson.description || existing?.description || ''
      const author = typeof pkgJson.author === 'string' ? pkgJson.author : pkgJson.author?.name
      const homepage = pkgJson.homepage

      pluginsMap.set(pkgName, {
        id: pkgName,
        name: pkgJson.name || pkgName,
        version,
        description,
        author,
        homepage,
        disabled: existing?.disabled ?? false,
        system: isSys,
        removable: !isSys,
      })
    } catch {}
  }

  for (const [id, info] of pluginsMap.entries()) {
    let resolvedLoaderId = id
    const candidatePath = join(nodeModulesDir, id)
    if (existsSync(candidatePath)) {
      const insideId = findEntryIdInPluginBundle(candidatePath, id)
      if (insideId) {
        resolvedLoaderId = insideId
      }
    }

    if (disabledMap.has(resolvedLoaderId)) {
      info.disabled = Boolean(disabledMap.get(resolvedLoaderId))
    } else if (disabledMap.has(id)) {
      info.disabled = Boolean(disabledMap.get(id))
    }
  }

  return Array.from(pluginsMap.values()).filter((p) => !p.system)
}

export function togglePlugin(profileDir: string, id: string, enable: boolean): { ok: boolean; error?: string } {
  try {
    const patches = readPatchYaml(profileDir)

    let resolvedLoaderId = id
    const pluginDir = join(profileDir, 'node_modules', id)
    if (existsSync(pluginDir)) {
      const insideId = findEntryIdInPluginBundle(pluginDir, id)
      if (insideId) {
        resolvedLoaderId = insideId
      }
    }

    if (!enable) {
      // 禁用插件：在 patch 中打上 disabled: true
      let found = false
      function markDisabled(entries: PatchEntry[]): boolean {
        for (const item of entries) {
          if (item.id === resolvedLoaderId || item.name === id || item.id === id) {
            item.disabled = true
            return true
          }
          if (Array.isArray(item.insert)) {
            if (markDisabled(item.insert)) return true
          }
        }
        return false
      }
      found = markDisabled(patches)
      if (!found) {
        patches.push({
          id: resolvedLoaderId,
          disabled: true,
        })
      }
      writePatchYaml(profileDir, patches)
    } else {
      // 启用插件：彻底清除针对该 id 的纯禁用 patch，避免留下空 id 覆盖导致原生配置被抹除
      function cleanEntry(list: PatchEntry[]): PatchEntry[] {
        const result: PatchEntry[] = []
        for (const item of list) {
          const isTarget = item.id === resolvedLoaderId || item.id === id || item.name === id
          if (isTarget) {
            const extraKeys = Object.keys(item).filter(
              (k) => k !== 'id' && k !== 'disabled' && k !== 'name'
            )
            // 如果仅用于记录禁用状态（没有额外配置），彻底删除该 patch 项
            if (extraKeys.length === 0) {
              continue
            }
            // 否则保留自定义配置，仅移除 disabled 标志
            delete item.disabled
            result.push(item)
          } else {
            if (Array.isArray(item.insert)) {
              item.insert = cleanEntry(item.insert)
            }
            result.push(item)
          }
        }
        return result
      }

      const cleaned = cleanEntry(patches)
      writePatchYaml(profileDir, cleaned)
    }

    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

/**
 * One plugin whose live loader state we want to confirm before responding:
 * `expectEnabled` is the state the toggle is asking for.
 */
export interface SettledTarget {
  id: string
  expectEnabled: boolean
}

/**
 * Wait until the live Cordis loader has actually applied a patch change.
 *
 * Writing `cordis.patch.yml` only triggers the HMR watcher asynchronously:
 * the browser must NOT be told to reload before the host entry is enabled /
 * disposed, or the fresh page load would compose a stale client plugin graph
 * (this is exactly why "re-enabling" used to look like a no-op). Poll the
 * loader entry tree until every target reflects the requested state, or the
 * timeout elapses (we still resolve `true` on timeout so the UI can recover
 * via a manual page refresh).
 */
export function waitForLoaderSettled(
  ctx: Context,
  targets: SettledTarget[],
  timeoutMs = 10000,
  pollMs = 100,
): Promise<boolean> {
  const check = (): boolean => {
    // Resolve lazily per tick: at request time boot is long done, so this is
    // not racy; `undefined` (non-web context) means nothing to confirm.
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined
    if (!loader || typeof loader.entries !== 'function') return true
    let entries: any[] = []
    try {
      entries = [...loader.entries()]
    } catch {
      return true
    }
    for (const target of targets) {
      const matches = entries.filter(
        (e) => e?.options?.name === target.id || e?.options?.id === target.id,
      )
      // Not mounted in this profile's loader tree (e.g. not in bundles):
      // the patch can only be a no-op, so there is nothing to wait for.
      if (matches.length === 0) continue
      for (const entry of matches) {
        const disabled = Boolean(entry.disabled)
        if (target.expectEnabled) {
          if (disabled || entry.fiber === undefined || entry.fiber === null) return false
        } else if (!disabled) {
          return false
        }
      }
    }
    return true
  }

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (check()) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, pollMs)
    }
    tick()
  })
}

export function togglePluginGroup(profileDir: string, groupName: string, enable: boolean): { ok: boolean; count: number; error?: string } {
  try {
    const groupsData = readGroups(profileDir)
    const members = groupsData.groups[groupName] || []
    let count = 0
    for (const pluginId of members) {
      const res = togglePlugin(profileDir, pluginId, enable)
      if (res.ok) count++
    }
    return { ok: true, count }
  } catch (err: any) {
    return { ok: false, count: 0, error: err?.message || String(err) }
  }
}

export function uninstallPlugin(profileDir: string, id: string): { ok: boolean; error?: string } {
  try {
    if (isSystemPlugin(id)) {
      return { ok: false, error: 'Cannot uninstall system protected plugin' }
    }

    const pkgJsonPath = join(profileDir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        let modified = false
        if (pkg.dependencies && pkg.dependencies[id]) {
          delete pkg.dependencies[id]
          modified = true
        }
        if (pkg.dsh?.profile?.bundles) {
          const idx = pkg.dsh.profile.bundles.indexOf(id)
          if (idx !== -1) {
            pkg.dsh.profile.bundles.splice(idx, 1)
            modified = true
          }
        }
        if (modified) {
          writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2), 'utf-8')
        }
      } catch {}
    }

    const patches = readPatchYaml(profileDir)
    function cleanPatches(entries: PatchEntry[]): PatchEntry[] {
      return entries.filter((item) => {
        if (item.id === id || item.name === id) return false
        if (Array.isArray(item.insert)) {
          item.insert = cleanPatches(item.insert)
        }
        return true
      })
    }
    const cleaned = cleanPatches(patches)
    writePatchYaml(profileDir, cleaned)

    const groupsData = readGroups(profileDir)
    let groupModified = false
    for (const groupName of Object.keys(groupsData.groups)) {
      const list = groupsData.groups[groupName]
      const idx = list.indexOf(id)
      if (idx !== -1) {
        list.splice(idx, 1)
        groupModified = true
      }
    }
    if (groupModified) {
      saveGroups(profileDir, groupsData)
    }

    const targetPkgDir = join(profileDir, 'node_modules', id)
    if (existsSync(targetPkgDir)) {
      try {
        rmSync(targetPkgDir, { recursive: true, force: true })
      } catch {}
    }

    try {
      if (process.platform === 'win32') {
        spawnSync('cmd.exe', ['/c', `pnpm remove ${id}`], {
          cwd: profileDir,
          stdio: 'ignore',
        })
      } else {
        spawnSync('pnpm', ['remove', id], {
          cwd: profileDir,
          stdio: 'ignore',
        })
      }
    } catch {}

    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res: ServerResponse, status: number, data: any) {
  const str = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(str),
  })
  res.end(str)
}

function createApiHandler(ctx: Context) {
  const { profile, dir: profileDir } = resolveProfileDir()

  return async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const subpath = pathname.replace(/^(\/td-plugins\/api|\/td-integration\/api)\/?/, '')

    try {
      if (subpath === 'plugins' || subpath === 'plugins/list') {
        const plugins = scanPlugins(profileDir)
        const groupsData = readGroups(profileDir)
        writeJson(res, 200, {
          ok: true,
          value: {
            profile,
            profileDir,
            plugins,
            groups: groupsData.groups,
            groupOrder: groupsData.groupOrder,
          },
        })
        return
      }

      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { message: 'Method Not Allowed' } })
        return
      }

      const body = (await readJsonBody(req)) as any

      if (subpath === 'plugins/toggle') {
        const { id, enable } = body || {}
        if (!id || typeof enable !== 'boolean') {
          writeJson(res, 400, { ok: false, error: { message: 'Missing id or enable boolean' } })
          return
        }
        const result = togglePlugin(profileDir, id, enable)
        // Only respond once the live loader has applied the change, so the
        // client's immediate full-page reload composes the fresh plugin graph.
        const settled = result.ok ? await waitForLoaderSettled(ctx, [{ id, expectEnabled: enable }]) : true
        writeJson(res, 200, { ok: result.ok, value: { ...result, settled }, error: result.error })
        return
      }

      if (subpath === 'plugins/toggle-group') {
        const { group, enable } = body || {}
        if (!group || typeof enable !== 'boolean') {
          writeJson(res, 400, { ok: false, error: { message: 'Missing group or enable boolean' } })
          return
        }
        const groupMembers = readGroups(profileDir).groups[group] || []
        const result = togglePluginGroup(profileDir, group, enable)
        const members = result.ok ? groupMembers : []
        const settled = result.ok
          ? await waitForLoaderSettled(ctx, members.map((id) => ({ id, expectEnabled: enable })))
          : true
        writeJson(res, 200, { ok: result.ok, value: { ...result, settled }, error: result.error })
        return
      }

      if (subpath === 'plugins/groups') {
        const { action, name, newName, member, members } = body || {}
        const groupsData = readGroups(profileDir)

        if (action === 'create') {
          if (!name || typeof name !== 'string') {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid group name' } })
            return
          }
          if (groupsData.groups[name]) {
            writeJson(res, 400, { ok: false, error: { message: 'Group already exists' } })
            return
          }
          groupsData.groups[name] = []
          groupsData.groupOrder.push(name)
        } else if (action === 'rename') {
          if (!name || !newName || typeof newName !== 'string') {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid rename params' } })
            return
          }
          if (!groupsData.groups[name]) {
            writeJson(res, 404, { ok: false, error: { message: 'Group not found' } })
            return
          }
          const existing = groupsData.groups[name]
          delete groupsData.groups[name]
          groupsData.groups[newName] = existing
          const idx = groupsData.groupOrder.indexOf(name)
          if (idx !== -1) groupsData.groupOrder[idx] = newName
        } else if (action === 'delete') {
          if (!name || !groupsData.groups[name]) {
            writeJson(res, 404, { ok: false, error: { message: 'Group not found' } })
            return
          }
          delete groupsData.groups[name]
          const idx = groupsData.groupOrder.indexOf(name)
          if (idx !== -1) groupsData.groupOrder.splice(idx, 1)
        } else if (action === 'add-member') {
          if (!name || !groupsData.groups[name] || !member) {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid add-member params' } })
            return
          }
          if (!groupsData.groups[name].includes(member)) {
            groupsData.groups[name].push(member)
          }
        } else if (action === 'remove-member') {
          if (!name || !groupsData.groups[name] || !member) {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid remove-member params' } })
            return
          }
          const idx = groupsData.groups[name].indexOf(member)
          if (idx !== -1) groupsData.groups[name].splice(idx, 1)
        } else if (action === 'set-members') {
          if (!name || !groupsData.groups[name] || !Array.isArray(members)) {
            writeJson(res, 400, { ok: false, error: { message: 'Invalid set-members params' } })
            return
          }
          groupsData.groups[name] = members
        } else {
          writeJson(res, 400, { ok: false, error: { message: `Unknown action: ${action}` } })
          return
        }

        saveGroups(profileDir, groupsData)
        writeJson(res, 200, { ok: true, value: { groups: groupsData.groups, groupOrder: groupsData.groupOrder } })
        return
      }

      if (subpath === 'plugins/uninstall') {
        const { id } = body || {}
        if (!id) {
          writeJson(res, 400, { ok: false, error: { message: 'Missing plugin id' } })
          return
        }
        const result = uninstallPlugin(profileDir, id)
        writeJson(res, result.ok ? 200 : 500, { ok: result.ok, value: result, error: result.error })
        return
      }

      writeJson(res, 404, { ok: false, error: { message: `Unknown endpoint: ${subpath}` } })
    } catch (err: any) {
      writeJson(res, 500, { ok: false, error: { message: err?.message || String(err) } })
    }
  }
}

export const name = 'dsh-plugin-manager'
export const inject = ['webServer']

export function apply(ctx: Context) {
  const handler = createApiHandler(ctx)

  // Register both /td-plugins/api and /td-integration/api for compatibility
  ctx.effect(() => {
    const unreg1 = ctx.webServer.register({
      kind: 'prefix',
      path: '/td-plugins/api',
      handler,
    })
    const unreg2 = ctx.webServer.register({
      kind: 'prefix',
      path: '/td-integration/api',
      handler,
    })
    return () => {
      unreg1()
      unreg2()
    }
  }, 'dsh-plugin-manager: HTTP routes')
}
