/**
 * The one place for currency, locale and timezone. Day and month boundaries (dashboard periods, statement
 * periods, chart buckets) are always computed in APP_TIMEZONE, never in the server's or the browser's zone.
 */
export const LOCALE = {
  timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata',
  locale: 'en-IN',
  currency: 'INR',
  currencySymbol: '₹',
  appName: 'Ludo Arena',
}

export function assertTimezone(): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: LOCALE.timezone })
  } catch {
    throw new Error(`APP_TIMEZONE "${LOCALE.timezone}" is not a valid IANA timezone`)
  }
}
