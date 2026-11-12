export const ID = /^[a-zA-Z0-9_-]{1,128}$/
export const validId = (value) => typeof value === 'string' && ID.test(value)

// The pinned Web host omits principal for its owner and assigns rpcId at admission.
export function nativeOwner(message) {
  return message.role === 'user' && message.source?.kind === 'user' &&
    message.source.principal === undefined && validId(message.source.rpcId) && validId(message.id)
}
