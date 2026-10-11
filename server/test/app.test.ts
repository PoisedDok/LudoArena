import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import request from 'supertest'
import { createApp } from '../src/app'
import { parseEnv, parseTrustProxy } from '../src/config/env'
import { resetEnvCache } from '../src/config/env'
import { createUser, resetDb } from './helpers'

describe('http to https redirect (production behind Cloudflare)', () => {
  const original = { ...process.env }
  beforeAll(() => {
    process.env.NODE_ENV = 'production'
    process.env.CLIENT_URL = 'https://ludo.example.test'
    resetEnvCache()
  })
  afterAll(() => {
    process.env.NODE_ENV = original.NODE_ENV
    process.env.CLIENT_URL = original.CLIENT_URL
    resetEnvCache()
  })

  it('redirects a visitor who arrived over http to the configured https origin, path and query kept', async () => {
    const { app } = createApp()
    const res = await request(app).get('/api/players?x=1').set('X-Forwarded-Proto', 'http').set('Host', 'evil.example')
    expect(res.status).toBe(308)
    expect(res.headers.location).toBe('https://ludo.example.test/api/players?x=1')
  })

  it('does not redirect https visitors or direct calls without the header (health checks)', async () => {
    const { app } = createApp()
    expect((await request(app).get('/api/health')).status).toBe(200)
    expect((await request(app).get('/api/ready')).status).toBe(200)
    const viaHttps = await request(app).get('/api/health').set('X-Forwarded-Proto', 'https')
    expect(viaHttps.status).toBe(200)
  })

  it('sends a Secure session cookie', async () => {
    const { app } = createApp()
    await resetDb()
    const user = await createUser()
    const res = await request(app).post('/api/auth/login').set('X-Forwarded-Proto', 'https').send({ username: user.username, password: user.password })
    expect(res.status).toBe(200)
    expect(String((res.headers['set-cookie'] as unknown as string[])[0])).toMatch(/; Secure/)
  })
})

describe('http surface', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ludo-static-'))
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>shell</title>')
  fs.mkdirSync(path.join(dir, 'assets'))
  fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')

  it('answers unknown API paths with JSON 404, never the SPA shell', async () => {
    const { app } = createApp({ staticDir: dir })
    const res = await request(app).get('/api/nope')
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/json/)
    const legacy = await request(app).get('/uploads/anything.png')
    expect(legacy.status).toBe(404)
  })

  it('serves the SPA shell for client routes and a real 404 for a missing asset', async () => {
    const { app } = createApp({ staticDir: dir })
    const route = await request(app).get('/admin/players')
    expect(route.status).toBe(200)
    expect(route.text).toContain('shell')
    expect(route.headers['cache-control']).toBe('no-store')
    expect((await request(app).get('/assets/missing.js')).status).toBe(404)
    const asset = await request(app).get('/assets/app-abc123.js')
    expect(asset.headers['cache-control']).toMatch(/immutable/)
  })

  it('sets security headers and a strict CSP, and hides the framework', async () => {
    const { app } = createApp()
    const res = await request(app).get('/api/health')
    expect(res.headers['x-powered-by']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/)
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/)
    expect(res.headers['x-request-id']).toBeTruthy()
  })

  it('maps malformed JSON and oversize bodies to 400 and 413 JSON errors', async () => {
    const { app } = createApp()
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"username": ')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBeTruthy()
    const big = await request(app).post('/api/auth/login').send({ username: 'a', password: 'x'.repeat(200_000) })
    expect(big.status).toBe(413)
  })

  it('refuses a state-changing request from another origin', async () => {
    const { app } = createApp()
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ username: 'a', password: 'b' })
    expect(res.status).toBe(403)
  })
})

describe('environment validation', () => {
  const good = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://u:p@db:5432/ludo',
    JWT_SECRET: 'a'.repeat(8) + 'b'.repeat(24) + 'c9',
    CLIENT_URL: 'https://ludo.example.test',
  }

  it('accepts a complete production environment', () => {
    const env = parseEnv(good)
    expect(env.isProduction).toBe(true)
    expect(env.trustProxy).toBe(1)
    expect(env.clientOrigin).toBe('https://ludo.example.test')
  })

  it.each([
    ['missing JWT secret', { JWT_SECRET: undefined }, /JWT_SECRET/],
    ['short JWT secret', { JWT_SECRET: 'short' }, /at least 32/],
    ['placeholder JWT secret', { JWT_SECRET: 'change_this_to_a_long_random_string_please' }, /placeholder/],
    ['missing database', { DATABASE_URL: undefined }, /DATABASE_URL/],
    ['unknown NODE_ENV', { NODE_ENV: 'prod' }, /NODE_ENV/],
    ['http client url in production', { CLIENT_URL: 'http://ludo.example.test' }, /https/],
    ['no client url in production', { CLIENT_URL: undefined }, /CLIENT_URL/],
    ['bad port', { PORT: '99999' }, /PORT/],
    ['trust proxy true', { TRUST_PROXY: 'true' }, /TRUST_PROXY/],
  ])('refuses %s', (_label, patch, message) => {
    expect(() => parseEnv({ ...good, ...patch } as NodeJS.ProcessEnv)).toThrow(message)
  })

  it('lists every problem at once', () => {
    try {
      parseEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
      throw new Error('should have thrown')
    } catch (error) {
      expect((error as Error).message).toMatch(/DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*CLIENT_URL/)
    }
  })

  it('parses trust proxy hop counts and lists', () => {
    expect(parseTrustProxy(undefined)).toBe(1)
    expect(parseTrustProxy('2')).toBe(2)
    expect(parseTrustProxy('false')).toBe(false)
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8')
    expect(() => parseTrustProxy('banana')).toThrow()
  })
})
