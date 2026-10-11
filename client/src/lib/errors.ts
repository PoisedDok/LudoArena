import axios from 'axios'
import { ContractError } from './contract'

/**
 * One place that turns a failed request into a sentence for a person. A message from the server is
 * shown as is; everything else gets a plain explanation of what kind of failure it was.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (error instanceof ContractError) {
    return 'The server sent an answer this version of the app does not understand. Reload the page; if it keeps happening, tell the admin.'
  }
  if (!axios.isAxiosError(error)) return fallback
  if (error.code === 'ECONNABORTED') return 'The request took too long. Check your connection and try again.'
  if (!error.response) return 'No connection to the server. Check your network and try again.'
  const { status, data } = error.response
  const serverMessage = typeof data?.error === 'string' ? data.error : ''
  if (status === 429) return serverMessage || 'Too many attempts. Please wait a little and try again.'
  if (status >= 500) return 'The server had a problem. Please try again in a moment.'
  if (status === 401) return serverMessage || 'Your session has ended. Please sign in again.'
  return serverMessage || fallback
}

export function isUnauthorized(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401
}
