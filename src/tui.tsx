/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { ensureFreshStoredAuth } from "./auth-refresh.ts"
import { fetchUsage, parseUsagePayload, type UsageRow } from "./usage.ts"

type UsageViewRow = UsageRow & {
  remaining: number
  percent: number
  ratio: number
}

const BAR_WIDTH = 56

function usageViewRow(row: UsageRow): UsageViewRow {
  if (row.limit <= 0) {
    return { ...row, remaining: 0, percent: 0, ratio: 0 }
  }
  const remaining = Math.min(Math.max(row.limit - row.used, 0), row.limit)
  const ratio = remaining / row.limit
  return {
    ...row,
    remaining,
    ratio,
    percent: Math.round(ratio * 100),
  }
}

function usageTone(api: TuiPluginApi, row: UsageViewRow) {
  if (row.ratio <= 0.1) return api.theme.current.error
  if (row.ratio <= 0.3) return api.theme.current.warning
  return api.theme.current.primary
}

function usageBar(row: UsageViewRow) {
  const complete = Math.round(row.ratio * BAR_WIDTH)
  return {
    complete: "█".repeat(complete),
    empty: "░".repeat(BAR_WIDTH - complete),
  }
}

function UsageLoadingRow(props: { label: string; theme: TuiPluginApi["theme"]["current"] }): JSX.Element {
  return (
    <box gap={0} width="100%">
      <text fg={props.theme.text}>{props.label}</text>
      <box flexDirection="row" width="100%" overflow="hidden">
        <text fg={props.theme.textMuted} wrapMode="none" overflow="hidden">
          {"░".repeat(BAR_WIDTH)}
        </text>
      </box>
      <box flexDirection="row" width="100%">
        <text fg={props.theme.textMuted}>loading</text>
      </box>
    </box>
  )
}

function UsageDialog(props: { api: TuiPluginApi; rows?: UsageRow[]; loading?: boolean }): JSX.Element {
  const rows = (props.rows ?? []).map(usageViewRow)
  const close = () => props.api.ui.dialog.clear()
  const theme = props.api.theme.current

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <span style={{ fg: theme.text, bold: true }}>Kimi Usage</span>
        </text>
        <text fg={theme.textMuted} onMouseUp={close}>
          esc
        </text>
      </box>

      {props.loading ? (
        <box gap={1} paddingBottom={1}>
          <UsageLoadingRow label="Weekly limit" theme={theme} />
          <UsageLoadingRow label="5h limit" theme={theme} />
        </box>
      ) : rows.length === 0 ? (
        <box paddingTop={1} paddingBottom={1}>
          <text fg={theme.textMuted}>No usage data available.</text>
        </box>
      ) : (
        <box gap={1} paddingBottom={1}>
          {rows.map((row) => {
            const tone = usageTone(props.api, row)
            const bar = usageBar(row)
            return (
              <box gap={0} width="100%">
                <text fg={theme.text}>{row.label}</text>
                <box flexDirection="row" width="100%" overflow="hidden">
                  <text fg={tone} wrapMode="none" overflow="hidden">
                    {bar.complete}
                  </text>
                  <text fg={theme.textMuted} wrapMode="none" overflow="hidden">
                    {bar.empty}
                  </text>
                </box>
                <box flexDirection="row" justifyContent="space-between" width="100%">
                  <text fg={theme.textMuted}>{row.resetHint ?? ""}</text>
                  <text fg={tone}>{row.percent}% left</text>
                </box>
              </box>
            )
          })}
        </box>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "Kimi usage",
      value: "kimi.usage",
      description: "Show Kimi Code subscription usage",
      category: "Kimi",
      slash: {
        name: "kimi:usage",
      },
      onSelect: async () => {
        api.ui.dialog.replace(() => <UsageDialog api={api} loading />)
        try {
          const auth = await ensureFreshStoredAuth()
          const payload = await fetchUsage(auth.access)
          const rows = parseUsagePayload(payload)
          api.ui.dialog.replace(() => <UsageDialog api={api} rows={rows} />)
        } catch (error) {
          api.ui.dialog.clear()
          api.ui.toast({
            message: error instanceof Error ? error.message : "Failed to fetch Kimi usage.",
            variant: "error",
            duration: 6_000,
          })
        }
      },
    },
  ])
}

export default {
  id: "opencode-kimi-full-usage",
  tui,
} satisfies TuiPluginModule
