const route = '/api/dsh-session-bridge/workflow-view'
const id = /^[a-zA-Z0-9_-]{1,128}$/
const validId = (value) => typeof value === 'string' && id.test(value)
const reply = (value, status = 200) => Response.json(value, {
  status,
  headers: { 'cache-control': 'no-store' },
})

export function registerWorkflowView(ctx, read) {
  // The fixed Web host admits only owner Peers to exact Connection Fetch routes.
  return ctx.connection.fetch.register({
    path: route,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') {
        return reply({ error: 'invalid_request' }, 415)
      }
      const input = await request.json().catch(() => undefined)
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return reply({ error: 'invalid_request' }, 400)
      }
      const { sessionId, task } = input
      const keys = Object.keys(input).sort().join(',')
      if (!validId(sessionId) || (keys !== 'sessionId' && (keys !== 'sessionId,task' || !validId(task)))) {
        return reply({ error: 'invalid_request' }, 400)
      }
      try {
        const result = await read(sessionId, task)
        if (task === undefined && Array.isArray(result?.tasks) &&
            result.tasks.every((entry) => entry?.owner === sessionId && validId(entry.task))) {
          return reply({ tasks: result.tasks, workflowEnabled: result.workflowEnabled })
        }
        if (task !== undefined && result?.owner === sessionId && result.task === task) return reply(result)
        return reply({ error: 'task_not_found' }, 404)
      } catch {
        return reply({ error: 'workflow_view_unavailable' }, 503)
      }
    },
  })
}
