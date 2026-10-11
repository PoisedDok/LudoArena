import { spawnSync } from 'child_process'
import path from 'path'
import { Client } from 'pg'
import { EnvError, getEnv } from '../config/env'

/**
 * Pre-start step: validates the environment and brings the database to the committed schema with
 * `prisma migrate deploy`. Any failure exits non-zero so the container never serves an unmigrated database.
 *
 * A database created by the first live image (`prisma db push`) has the baseline tables but no migration
 * history; it is marked as having applied 0001_init (exactly that schema) before the rest is deployed.
 */

const BASELINE = '0001_init'

function prisma(args: string[]): number {
  const cli = require.resolve('prisma/build/index.js')
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', cwd: path.resolve(__dirname, '..', '..'), env: process.env })
  return result.status ?? 1
}

async function needsBaseline(databaseUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const { rows } = await client.query<{ history: string | null; users: string | null }>(
      `SELECT to_regclass('public._prisma_migrations') AS history, to_regclass('public."User"') AS users`,
    )
    const row = rows[0]
    return row !== undefined && row.users !== null && row.history === null
  } finally {
    await client.end()
  }
}

async function main(): Promise<void> {
  const env = getEnv()
  if (await needsBaseline(env.databaseUrl)) {
    process.stdout.write(`Existing database without migration history: baselining ${BASELINE}\n`)
    if (prisma(['migrate', 'resolve', '--applied', BASELINE]) !== 0) process.exit(1)
  }
  process.exit(prisma(['migrate', 'deploy']))
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof EnvError ? error.message : `Migration failed: ${String(error)}`}\n`)
  process.exit(1)
})
