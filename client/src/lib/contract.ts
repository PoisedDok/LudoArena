import contractJson from '../../../contracts/api-shapes.json'
import { checkShape, type Contract, type Shape } from '../../../contracts/shape'

/**
 * The shapes the client relies on live in contracts/api-shapes.json, next to a server test that asserts
 * real responses against the same file. Here every answer a screen depends on is checked once more at
 * runtime: a mismatch becomes an error state with a clear sentence, never a half-drawn or blank page.
 */
const contract = contractJson as unknown as Contract

export class ContractError extends Error {
  readonly shape: string
  readonly problems: string[]

  constructor(shape: string, problems: string[]) {
    super(`The server answered in an unexpected format (${shape}).`)
    this.name = 'ContractError'
    this.shape = shape
    this.problems = problems
  }
}

export function expectShape<T>(name: string, value: unknown, kind: 'endpoints' | 'socket' = 'endpoints'): T {
  const shape = contract[kind][name] as Shape | undefined
  if (!shape) throw new Error(`No contract shape named ${name}`)
  const problems = checkShape(value, shape, contract.types)
  if (problems.length > 0) throw new ContractError(name, problems)
  return value as T
}
