import { expect, test } from "bun:test"
import { parseUsagePayload } from "../src/usage.ts"

test("parseUsagePayload maps summary and rolling limits", () => {
  const rows = parseUsagePayload({
    usage: {
      limit: "100",
      used: "1",
      remaining: "99",
      reset_in: 6 * 86_400 + 13 * 3_600 + 52 * 60,
    },
    limits: [
      {
        window: {
          duration: 300,
          timeUnit: "TIME_UNIT_MINUTE",
        },
        detail: {
          limit: "100",
          remaining: "100",
          reset_in: 3 * 3_600 + 52 * 60,
        },
      },
    ],
  })

  expect(rows).toEqual([
    {
      label: "Weekly limit",
      used: 1,
      limit: 100,
      resetHint: "resets in 6d 13h 52m",
    },
    {
      label: "5h limit",
      used: 0,
      limit: 100,
      resetHint: "resets in 3h 52m",
    },
  ])
})

test("parseUsagePayload preserves immediate reset hints", () => {
  const rows = parseUsagePayload({
    usage: {
      limit: 100,
      used: 100,
      reset_in: 0,
    },
  })

  expect(rows[0]?.resetHint).toBe("reset now")
})
