import { randomBytes } from 'crypto'

// DATABASE_URL is set by globalSetup. The secret is random per run and never written anywhere.
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = process.env.JWT_SECRET ?? randomBytes(32).toString('hex')
process.env.CLIENT_URL = 'http://localhost:5867'
process.env.PORT = '4002'
