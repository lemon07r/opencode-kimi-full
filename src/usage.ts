import { API_BASE_URL, PROVIDER_ID } from "./constants.ts"
import { kimiHeaders } from "./headers.ts"

export type UsageRow = {
  label: string
  used: number
  limit: number
  resetHint?: string
}

const REQUEST_TIMEOUT_MS = 120_000

export async function fetchUsage(accessToken: string) {
  const res = await fetch(`${API_BASE_URL}/usages`, {
    headers: {
      ...kimiHeaders(),
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  if (!res.ok) {
    const message =
      res.status === 401
        ? `Authorization failed. Run \`opencode auth login ${PROVIDER_ID}\` again.`
        : `Kimi usage request failed (${res.status}): ${text.slice(0, 200)}`
    const error = new Error(message) as Error & { status?: number }
    error.status = res.status
    throw error
  }
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`Kimi usage returned non-JSON response: ${text.slice(0, 200)}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function toInt(value: unknown) {
  const next = Number(value)
  if (!Number.isFinite(next)) return
  return Math.trunc(next)
}

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const parts: string[] = []
  const days = Math.floor(total / 86_400)
  if (days) parts.push(`${days}d`)
  const hours = Math.floor((total % 86_400) / 3_600)
  if (hours) parts.push(`${hours}h`)
  const minutes = Math.floor((total % 3_600) / 60)
  if (minutes) parts.push(`${minutes}m`)
  const secs = total % 60
  if (secs && parts.length === 0) parts.push(`${secs}s`)
  return parts.join(" ") || "0s"
}

function formatResetTime(value: string) {
  let input = value
  if (input.includes(".") && input.endsWith("Z")) {
    const [base, fraction] = input.slice(0, -1).split(".")
    input = `${base}.${(fraction ?? "").slice(0, 3)}Z`
  }
  const resetAt = Date.parse(input)
  if (Number.isNaN(resetAt)) return `resets at ${value}`
  const seconds = Math.max(0, Math.floor((resetAt - Date.now()) / 1000))
  return seconds === 0 ? "reset now" : `resets in ${formatDuration(seconds)}`
}

function resetHint(data: Record<string, unknown>) {
  const resetAt = data.reset_at ?? data.resetAt ?? data.reset_time ?? data.resetTime
  if (resetAt) return formatResetTime(String(resetAt))

  const seconds = toInt(data.reset_in ?? data.resetIn ?? data.ttl ?? data.window)
  if (seconds === undefined) return
  return seconds === 0 ? "reset now" : `resets in ${formatDuration(seconds)}`
}

function toUsageRow(data: Record<string, unknown>, defaultLabel: string): UsageRow | undefined {
  const limit = toInt(data.limit)
  let used = toInt(data.used)
  const remaining = toInt(data.remaining)
  if (used === undefined && remaining !== undefined && limit !== undefined) {
    used = limit - remaining
  }
  if (used === undefined && limit === undefined) return
  return {
    label: String(data.name ?? data.title ?? defaultLabel),
    used: used ?? 0,
    limit: limit ?? 0,
    resetHint: resetHint(data),
  }
}

function limitLabel(item: Record<string, unknown>, detail: Record<string, unknown>, idx: number) {
  const explicit = item.name ?? item.title ?? item.scope ?? detail.name ?? detail.title ?? detail.scope
  if (explicit) return String(explicit)

  const window = asRecord(item.window)
  const duration = toInt(window?.duration ?? item.duration ?? detail.duration)
  const unit = String(window?.timeUnit ?? item.timeUnit ?? detail.timeUnit ?? "")
  if (duration) {
    if (unit.includes("MINUTE")) {
      return duration >= 60 && duration % 60 === 0 ? `${duration / 60}h limit` : `${duration}m limit`
    }
    if (unit.includes("HOUR")) return `${duration}h limit`
    if (unit.includes("DAY")) return `${duration}d limit`
    return `${duration}s limit`
  }

  return `Limit #${idx + 1}`
}

export function parseUsagePayload(payload: Record<string, unknown>) {
  const rows: UsageRow[] = []
  const usage = asRecord(payload.usage)
  if (usage) {
    const row = toUsageRow(usage, "Weekly limit")
    if (row) rows.push(row)
  }

  const limits = payload.limits
  if (Array.isArray(limits)) {
    for (let idx = 0; idx < limits.length; idx++) {
      const item = asRecord(limits[idx])
      if (!item) continue
      const detail = asRecord(item.detail) ?? item
      const row = toUsageRow(detail, limitLabel(item, detail, idx))
      if (row) rows.push(row)
    }
  }
  return rows
}
