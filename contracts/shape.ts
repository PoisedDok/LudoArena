/**
 * Shape checking against contracts/api-shapes.json. One implementation, used by the server's contract
 * test (real responses) and by the client (every answer it relies on), so the two sides cannot drift apart
 * unnoticed. Extra keys in a value are allowed; missing or mistyped listed keys are reported.
 */

export type Shape = string | { [key: string]: Shape } | { $each: Shape }

export interface Contract {
  types: Record<string, Shape>
  endpoints: Record<string, Shape>
  socket: Record<string, Shape>
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function matchesPrimitive(value: unknown, name: string): boolean {
  switch (name) {
    case 'any':
      return true
    case 'undefined':
      return value === undefined
    case 'null':
      return value === null
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'string':
    case 'boolean':
      return typeof value === name
    default:
      throw new Error(`Unknown shape type "${name}"`)
  }
}

export function checkShape(value: unknown, shape: Shape, types: Record<string, Shape>, path = '$'): string[] {
  if (typeof shape === 'string') {
    if (shape.startsWith('@')) {
      const named = types[shape.slice(1)]
      if (!named) throw new Error(`Unknown shape ${shape}`)
      return checkShape(value, named, types, path)
    }
    const options = shape.split('|')
    return options.some((name) => matchesPrimitive(value, name))
      ? []
      : [`${path}: expected ${shape}, got ${typeName(value)}`]
  }
  if ('$each' in shape && typeof shape.$each !== 'undefined' && Object.keys(shape).length === 1) {
    if (!Array.isArray(value)) return [`${path}: expected an array, got ${typeName(value)}`]
    const errors: string[] = []
    value.slice(0, 50).forEach((item, i) => errors.push(...checkShape(item, shape.$each as Shape, types, `${path}[${i}]`)))
    return errors
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${path}: expected an object, got ${typeName(value)}`]
  }
  const errors: string[] = []
  const record = value as Record<string, unknown>
  for (const [rawKey, sub] of Object.entries(shape)) {
    const optional = rawKey.endsWith('?')
    const key = optional ? rawKey.slice(0, -1) : rawKey
    if (!(key in record) || record[key] === undefined) {
      if (!optional && !(typeof sub === 'string' && sub.split('|').includes('undefined'))) errors.push(`${path}.${key}: missing`)
      continue
    }
    errors.push(...checkShape(record[key], sub as Shape, types, `${path}.${key}`))
  }
  return errors
}
