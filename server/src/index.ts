import { EnvError, getEnv } from './config/env'
import { main } from './server'

try {
  getEnv()
} catch (error) {
  if (error instanceof EnvError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(1)
  }
  throw error
}

main().catch((error: unknown) => {
  process.stderr.write(`Failed to start: ${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
