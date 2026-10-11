import http from 'http'
import path from 'path'
import { createApp, BuiltApp, AppOptions } from './app'
import { initSocket, closeSocket } from './lib/socket'
import { startJobs, Jobs } from './lib/jobs'
import prisma from './lib/prisma'
import { closePasswordWorker } from './lib/password'
import { getEnv } from './config/env'
import { HTTP } from './config/limits'
import { log } from './lib/logger'

export interface RunningServer {
  built: BuiltApp
  server: http.Server
  port: number
  /** Stops accepting work, lets in-flight requests finish, closes sockets and the database. */
  shutdown(): Promise<void>
}

export interface StartOptions extends AppOptions {
  port?: number
  jobs?: boolean
}

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const env = getEnv()
  const staticDir = options.staticDir ?? (env.isProduction ? path.join(process.cwd(), 'public') : undefined)
  const built = createApp({ staticDir })
  const server = http.createServer(built.app)
  // Node's keep-alive must outlive the proxy's idle connections, or a reused connection hits a closed socket.
  server.keepAliveTimeout = HTTP.keepAliveTimeoutMs
  server.headersTimeout = HTTP.headersTimeoutMs
  server.requestTimeout = HTTP.requestTimeoutMs
  const io = initSocket(server)

  // The previous process may have died without disconnecting its players; nobody is connected now.
  await prisma.user.updateMany({ where: { isActive: true }, data: { isActive: false } })
  const jobs: Jobs | undefined = options.jobs === false ? undefined : startJobs()

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? env.port, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? env.port)

  let closing: Promise<void> | undefined
  const shutdown = (): Promise<void> => {
    closing ??= (async () => {
      built.state.shuttingDown = true
      jobs?.stop()
      // socket.io closes the attached HTTP server too (no new connections, in-flight requests finish).
      await new Promise<void>((resolve) => {
        void io.close(() => resolve())
        server.closeIdleConnections()
      })
      closeSocket()
      await closePasswordWorker()
      await prisma.$disconnect()
    })()
    return closing
  }

  return { built, server, port, shutdown }
}

/** Process entry: boot, log, and turn SIGTERM/SIGINT into a bounded graceful shutdown. */
export async function main(): Promise<void> {
  const running = await startServer()
  log.info('server listening', { port: running.port })

  const stop = (signal: string) => {
    log.info('shutdown requested', { signal })
    const timer = setTimeout(() => {
      log.error('shutdown timed out, exiting')
      process.exit(1)
    }, HTTP.shutdownGraceMs)
    timer.unref()
    running.shutdown().then(
      () => process.exit(0),
      (error) => {
        log.error('shutdown failed', { err: error })
        process.exit(1)
      },
    )
  }
  process.once('SIGTERM', () => stop('SIGTERM'))
  process.once('SIGINT', () => stop('SIGINT'))
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { err: reason }))
}
