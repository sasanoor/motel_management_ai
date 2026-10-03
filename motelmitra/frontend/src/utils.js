export const ROLES = {
  SUPER_ADMIN: 'Super Admin',
  CLIENT_ADMIN: 'Client Admin',
  CLIENT_USER: 'Client User',
}

export function todayISO() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
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
