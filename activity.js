// Owner-facing transient projection. The durable receipts and workflow ledger
// remain the authorities for delivery, processing, and reconciliation.
const path = '/api/dsh-session-bridge/activity'
const maxRoutes = 128
const maxStreams = 8
const activeStates = new Set(['queued', 'sending', 'delivered', 'executing'])
const encoder = new TextEncoder()

export function createActivity(allowed) {
  const routes = new Map()
  const streams = new Set()
  let sequence = 0
  let nextId = 0
  let scheduled = false

  function prune(now) {
    for (const [key, route] of routes) if (route.expiresAt <= now) routes.delete(key)
  }

  function snapshot() {
    const now = Date.now()
    prune(now)
    const rows = []
    for (const { id, from, to, kind, state, flight, startedAt, nativeParent } of routes.values()) {
      let visible
      try { visible = nativeParent ? allowed(nativeParent) : allowed(from) && allowed(to) } catch { continue }
      if (visible) rows.push({
        id, from, to, kind, state,
        ...(flight && now - startedAt < 2500 ? { flight } : {}),
      })
    }
    return JSON.stringify({ sequence, rows: rows.reverse() })
  }

  function broadcast(heartbeat = false) {
    if (!streams.size) return
    const frame = snapshot()
    for (const stream of streams) {
      try { stream.push(frame, heartbeat) } catch { stream.close() }
    }
  }

  function record({ key, from, to, kind, state, at = Date.now(), keepUntil, nativeParent }, attempt = false) {
    if (typeof key !== 'string' || typeof from !== 'string' || typeof to !== 'string' || from === to) return
    const previous = routes.get(key)
    if (previous?.state === state && (!attempt || previous.flight)) return
    const expiresAt = activeStates.has(state) && state !== 'sending'
      ? (Number.isFinite(keepUntil) ? keepUntil : at + 15 * 60_000)
      : at + (state === 'sending' ? 120_000 : 18_000)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return
    routes.delete(key)
    routes.set(key, {
      id: previous?.id ?? ++nextId, from, to, kind, state, expiresAt, nativeParent,
      ...(attempt && !previous?.flight
        ? { flight: ++sequence, startedAt: Date.now() }
        : { flight: previous?.flight, startedAt: previous?.startedAt }),
    })
    if (routes.size > maxRoutes) routes.delete(routes.keys().next().value)
    if (!scheduled && streams.size) {
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        broadcast()
      })
    }
  }

  function register(ctx) {
    // Exact Connection Fetch routes admit only owner Peers on the fixed host.
    ctx.connection.fetch.register({
      path, methods: ['GET'], requestBody: 'buffered',
      fetch(request) {
        if (streams.size >= maxStreams) return new Response(null, { status: 503 })
        let close
        const body = new ReadableStream({
          start(controller) {
            let lastFrame
            let lastWrite = Date.now()
            const stream = {
              push(frame, heartbeat) {
                if (controller.desiredSize <= 0) return
                if (frame !== lastFrame) {
                  controller.enqueue(encoder.encode((lastFrame === undefined ? 'event: baseline\n' : '') +
                    'data: ' + frame + '\n\n'))
                  lastFrame = frame
                } else if (heartbeat && Date.now() - lastWrite >= 10_000) {
                  controller.enqueue(encoder.encode(': heartbeat\n\n'))
                } else return
                lastWrite = Date.now()
              },
              close: () => close(),
            }
            close = (end = true) => {
              if (!streams.delete(stream)) return
              request.signal.removeEventListener('abort', close)
              if (end) {
                try { controller.close() } catch { /* The response stream is already closed. */ }
              }
            }
            streams.add(stream)
            request.signal.addEventListener('abort', close, { once: true })
            if (request.signal.aborted) close()
            else {
              try { stream.push(snapshot()) } catch { close() }
            }
          },
          cancel() { close?.(false) },
        })
        return new Response(body, {
          headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' },
        })
      },
    })
    ctx.effect(() => {
      // Recheck the current allowlist and retire rows even when work is quiet.
      const timer = setInterval(() => {
        if (streams.size) broadcast(true)
        else prune(Date.now())
      }, 1500)
      timer.unref()
      return () => {
        clearInterval(timer)
        for (const stream of streams) stream.close()
        routes.clear()
      }
    }, 'dsh-session-bridge activity stream')
  }

  return { record, register }
}
