/** One JSON object per line on stdout/stderr. Silent under tests unless LOG_TESTS=1. */

type Level = 'info' | 'warn' | 'error'

function serialize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value
  }
  return out
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.NODE_ENV === 'test' && process.env.LOG_TESTS !== '1') return
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...serialize(fields) })
  if (level === 'error') process.stderr.write(line + '\n')
  else process.stdout.write(line + '\n')
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
}
