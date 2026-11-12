import { randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, linkSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function read(path) {
  let fd
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  try {
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally {
    closeSync(fd)
  }
}

export function write(dir, path, record, exclusive) {
  const tmp = join(dir, `.${randomUUID()}.tmp`)
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    try {
      writeFileSync(fd, JSON.stringify(record) + '\n')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (exclusive) {
      try {
        linkSync(tmp, path)
      } catch (error) {
        if (error.code === 'EEXIST') return false
        throw error
      }
    } else {
      renameSync(tmp, path)
    }
    const directory = openSync(dir, 'r')
    try {
      fsyncSync(directory)
    } finally {
      closeSync(directory)
    }
    return true
  } finally {
    try { unlinkSync(tmp) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

