export const ROLES = {
  SUPER_ADMIN: 'Super Admin',
  CLIENT_ADMIN: 'Client Admin',
  CLIENT_USER: 'Client User',
  MAINTENANCE: 'Maintenance',
}

// Business day from the server (Night Audit / day change time). "Today" everywhere in the app.
let businessDate = null
export function setBusinessDate(iso) { businessDate = iso || null }

// HOST_ON_WIFI from the server (false = this PC only, so phones cannot reach MotelMitra)
let wifiHosted = true
export function setWifiHosted(v) { wifiHosted = v !== false }
export const isWifiHosted = () => wifiHosted

export function calendarToday() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function todayISO() {
  return businessDate || calendarToday()
}

export function fmtDay(iso) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: '2-digit', day: '2-digit', year: 'numeric' })
}

export function nowTime() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function daysBetween(a, b) {
  if (!a || !b) return 0
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000)
}

export function fmtDate(iso) {
  if (!iso) return ''
  const [y, m, d] = String(iso).slice(0, 10).split('-')
  return `${m}/${d}/${y}`
}

export function fmtTime(t) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
}

export function fmtDateTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString([], { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function money(v) {
  const n = Number(v || 0)
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export const num = (v) => Number(v || 0)

export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const last = new Date(y, m - 1 + n + 1, 0).getDate() // last day of target month
  const t = new Date(y, m - 1 + n, Math.min(d, last))
  return new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function monthsBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number)
  const [y2, m2, d2] = b.split('-').map(Number)
  return Math.max((y2 - y1) * 12 + (m2 - m1) + (d2 > d1 ? 1 : 0), 1)
}

// Rent by: daily / weekly / monthly
export const RATE_TYPES = [
  { key: 'DAILY', label: 'Daily', unit: 'night', units: 'nights', count: 'No. of days', short: '/night' },
  { key: 'WEEKLY', label: 'Weekly', unit: 'week', units: 'weeks', count: 'No. of weeks', short: '/week' },
  { key: 'MONTHLY', label: 'Monthly', unit: 'month', units: 'months', count: 'No. of months', short: '/month' },
]
export const rateTypeInfo = (key) => RATE_TYPES.find((t) => t.key === key) || RATE_TYPES[0]

/** Room-type rate for a rate type. Falls back to daily x 7 / x 30 when no weekly / monthly price is set. */
export function rateFor(room, type) {
  if (!room) return ''
  const daily = Number(room.default_rate || 0)
  if (type === 'WEEKLY') return (Number(room.weekly_rate || 0) || daily * 7).toFixed(2)
  if (type === 'MONTHLY') return (Number(room.monthly_rate || 0) || daily * 30).toFixed(2)
  return daily.toFixed(2)
}

export function periodText(n, type) {
  const t = rateTypeInfo(type)
  return `${n} ${n === 1 ? t.unit : t.units}`
}

/** Days left until checkout, counted from refDate (YYYY-MM-DD). Returns { text, tone }. */
export function daysLeft(stay, refDate = todayISO()) {
  if (stay.status === 'CHECKED_OUT') return { text: 'Checked out', tone: 'grey' }
  const n = daysBetween(refDate, stay.check_out_date)
  if (n < 0) return { text: `Overdue ${-n} day${n === -1 ? '' : 's'}`, tone: 'red' }
  if (n === 0) return { text: 'Due today', tone: 'warn' }
  if (n === 1) return { text: '1 day', tone: 'blue' }
  return { text: `${n} days`, tone: n <= 2 ? 'blue' : 'green' }
}

/** Which day of the stay refDate is (check-in day = 1). null before arrival or after checkout. */
export function dayOfStay(stay, refDate = todayISO()) {
  if (stay.status === 'CHECKED_OUT') return null
  const n = daysBetween(stay.check_in_date, refDate) + 1
  return n >= 1 ? n : null
}

// Guest name parts: { first_name, middle_name, last_name } (older records only had a full name)
export function nameParts(g = {}) {
  if (g.first_name || g.last_name || g.middle_name) {
    return { first_name: g.first_name || '', middle_name: g.middle_name || '', last_name: g.last_name || '' }
  }
  const w = (g.name || '').trim().split(/\s+/).filter(Boolean)
  if (!w.length) return { first_name: '', middle_name: '', last_name: '' }
  if (w.length === 1) return { first_name: w[0], middle_name: '', last_name: '' }
  return { first_name: w[0], middle_name: w.slice(1, -1).join(' '), last_name: w[w.length - 1] }
}

export const fullName = (p) => [p.first_name, p.middle_name, p.last_name].map((x) => (x || '').trim()).filter(Boolean).join(' ')

/**
 * One CSV cell. Text starting with = + - @ (or a tab / return) is run as a formula by Excel,
 * so a guest named =HYPERLINK(...) could plant a live link in an export. Such text gets a leading '
 * (numbers like -140.00 are left alone).
 */
export function csvCell(v) {
  let t = String(v ?? '')
  if (/^[=+\-@\t\r]/.test(t) && !/^[-+]?\d+(\.\d+)?$/.test(t)) t = `'${t}`
  return `"${t.replace(/"/g, '""')}"`
}

/** Housekeeping status of a room: label and pill colour. */
export const HK = {
  READY: { label: 'Ready', cls: 'pill-green' },
  DIRTY: { label: 'Dirty', cls: 'pill-warn' },
  CLEANING: { label: 'Cleaning', cls: 'pill-blue' },
  OUT_OF_ORDER: { label: 'Out of order', cls: 'pill-dark' },
}
