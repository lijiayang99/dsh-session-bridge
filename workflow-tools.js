import { denied } from './workflow-state.js'

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}

export function workflowTools(tools, current) {
  return function register(name, description, properties, execute, required = Object.keys(properties)) {
    tools.register({
      name: 'workflow_' + name,
      description,
      parameters: { type: 'object', additionalProperties: false, required, properties },
      output,
      execute(args, exec) {
        const caller = current(exec)
        if (!caller) return denied('workflow_context_required')
        return execute(args, exec, caller)
      },
    })
  }
}
