import { Worker } from 'worker_threads'
import { AUTH } from '../config/limits'
import { HttpError } from './errors'

/**
 * bcrypt at cost 12 is deliberately expensive (hundreds of milliseconds of pure CPU). Running it on the
 * main thread would starve everything else on that thread (socket events, database handshakes) during a
 * burst of sign-ins, so it runs on one worker thread. Requests queue behind it; when the queue is long the
 * caller gets a 503 instead of an unbounded wait.
 */

const MAX_QUEUE = 40

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads')
const bcrypt = require(workerData.bcryptPath)
parentPort.on('message', async (job) => {
  try {
    const result = job.op === 'hash' ? await bcrypt.hash(job.password, job.rounds) : await bcrypt.compare(job.password, job.hash)
    parentPort.postMessage({ id: job.id, result })
  } catch (error) {
    parentPort.postMessage({ id: job.id, error: String(error && error.message ? error.message : error) })
  }
})
`

interface Pending {
  resolve: (value: string | boolean) => void
  reject: (error: Error) => void
}

let worker: Worker | undefined
let nextId = 1
const pending = new Map<number, Pending>()

function ensureWorker(): Worker {
  if (worker) return worker
  const created = new Worker(WORKER_SOURCE, { eval: true, workerData: { bcryptPath: require.resolve('bcryptjs') } })
  created.unref()
  created.on('message', (message: { id: number; result?: string | boolean; error?: string }) => {
    const job = pending.get(message.id)
    if (!job) return
    pending.delete(message.id)
    if (message.error !== undefined) job.reject(new Error(message.error))
    else job.resolve(message.result as string | boolean)
  })
  const fail = (error: Error) => {
    worker = undefined
    for (const job of pending.values()) job.reject(error)
    pending.clear()
  }
  created.on('error', fail)
  created.on('exit', (code) => {
    if (worker === created) fail(new Error(`password worker exited with code ${code}`))
  })
  worker = created
  return created
}

function run(job: { op: 'hash'; password: string; rounds: number } | { op: 'compare'; password: string; hash: string }): Promise<string | boolean> {
  if (pending.size >= MAX_QUEUE) return Promise.reject(new HttpError(503, 'The server is busy signing people in. Try again in a moment.'))
  const target = ensureWorker()
  return new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    target.postMessage({ id, ...job })
  })
}

export async function hashPassword(password: string): Promise<string> {
  return (await run({ op: 'hash', password, rounds: AUTH.bcryptRounds })) as string
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return (await run({ op: 'compare', password, hash })) as boolean
}

export async function closePasswordWorker(): Promise<void> {
  const current = worker
  worker = undefined
  if (current) await current.terminate()
}
