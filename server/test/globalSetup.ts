import { spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import path from 'path'
import { Client } from 'pg'

/**
 * Creates a throw-away database on the test Postgres, applies the committed migrations to it (so the
 * migrations themselves are under test) and drops it afterwards.
 * DATABASE_ADMIN_URL points at the server's maintenance database; it is supplied by the test compose file.
 */
let databaseName = ''
let adminUrl = ''

export async function setup(): Promise<void> {
  adminUrl = process.env.DATABASE_ADMIN_URL ?? ''
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required (run the tests through `make test`)')
  databaseName = `ludo_test_${randomBytes(6).toString('hex')}`

  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${databaseName}`)
  await admin.end()

  const url = new URL(adminUrl)
  url.pathname = `/${databaseName}`
  process.env.DATABASE_URL = url.toString()

  const cli = require.resolve('prisma/build/index.js')
  const result = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`migrate deploy failed:\n${result.stdout}\n${result.stderr}`)
}

export async function teardown(): Promise<void> {
  if (!databaseName) return
  const admin = new Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
  await admin.end()
}
