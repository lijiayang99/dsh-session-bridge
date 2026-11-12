export const ID = /^[a-zA-Z0-9_-]{1,128}$/
export const validId = (value) => typeof value === 'string' && ID.test(value)
