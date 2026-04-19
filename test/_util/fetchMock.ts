// Minimal typed fetch mock. Bun's `bun:test` has `mock()` but swapping
// `globalThis.fetch` with a plain function is enough here and keeps tests
// free of framework-specific mocking magic.

export type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

type MaybePromise<T> = T | Promise<T>

export type Responder = (
  call: FetchCall,
  callIndex: number,
) => MaybePromise<{ status?: number; body?: unknown; bodyText?: string }>

export function installFetchMock(responder: Responder) {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    const hs = new Headers(request?.headers)
    new Headers(init?.headers).forEach((v, k) => {
      hs.set(k, v)
    })
    hs.forEach((v, k) => {
      headers[k] = v
    })
    const body =
      typeof init?.body === "string"
        ? init.body
        : request && init?.body === undefined
          ? await request
              .clone()
              .text()
              .catch(() => undefined)
          : init?.body == null
            ? undefined
            : String(init.body)
    const call: FetchCall = { url, method: (init?.method ?? request?.method ?? "GET").toUpperCase(), headers, body }
    calls.push(call)
    const r = await responder(call, calls.length - 1)
    const status = r.status ?? 200
    const text = r.bodyText ?? (r.body === undefined ? "" : JSON.stringify(r.body))
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

export function parseForm(body: string | undefined): Record<string, string> {
  if (!body) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(body)) out[k] = v
  return out
}
