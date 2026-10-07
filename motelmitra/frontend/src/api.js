import axios from 'axios'

// In dev, Vite proxies /api to Django. In production set VITE_API_URL.
const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api' })

export const tokens = {
  get access() { return localStorage.getItem('mm_access') },
  get refresh() { return localStorage.getItem('mm_refresh') },
  set(access, refresh) {
    localStorage.setItem('mm_access', access)
    if (refresh) localStorage.setItem('mm_refresh', refresh)
  },
  clear() {
    localStorage.removeItem('mm_access')
    localStorage.removeItem('mm_refresh')
    localStorage.removeItem('mm_user')
  },
}

api.interceptors.request.use((config) => {
  if (tokens.access) config.headers.Authorization = `Bearer ${tokens.access}`
  return config
})

// One login per user: when the same user logs in on another PC / phone, this screen is signed out.
const KICKED = 'mm_signed_out_reason'
export function takeSignOutReason() {
  try { const m = sessionStorage.getItem(KICKED); sessionStorage.removeItem(KICKED); return m || '' } catch { return '' }
}
function signedOutElsewhere(error) {
  const d = error?.response?.data
  if (error?.response?.status === 403 && d?.code === 'plan_expired') {
    // plan ended while the screen was open: the admin sees the "plan ended" screen, everyone else is signed out
    let role = ''
    try { role = JSON.parse(localStorage.getItem('mm_user') || '{}').role } catch { /* ignore */ }
    if (role === 'CLIENT_ADMIN') { window.dispatchEvent(new Event('mm-plan-expired')); return false }
    try { sessionStorage.setItem(KICKED, d.detail) } catch { /* ignore */ }
    tokens.clear()
    window.location.href = '/login'
    return true
  }
  if (error?.response?.status !== 401 || d?.code !== 'session_replaced') return false
  try { sessionStorage.setItem(KICKED, d.detail || 'You were signed out because this user logged in somewhere else.') } catch { /* ignore */ }
  tokens.clear()
  window.location.href = '/login'
  return true
}

let refreshing = null
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    if (signedOutElsewhere(error)) return new Promise(() => {}) // page is leaving; keep screens quiet
    const original = error.config
    if (error.response?.status === 401 && tokens.refresh && !original._retry && !original.url.includes('auth/')) {
      original._retry = true
      try {
        refreshing = refreshing || api.post('/auth/refresh/', { refresh: tokens.refresh })
        const { data } = await refreshing
        tokens.set(data.access)
        return api(original)
      } catch (e2) {
        if (signedOutElsewhere(e2)) return new Promise(() => {})
        tokens.clear()
        window.location.href = '/login'
      } finally {
        refreshing = null
      }
    }
    return Promise.reject(error)
  },
)

/** Turn a DRF error response into one readable line. */
export function errorText(err) {
  const data = err?.response?.data
  if (!data) return err?.message || 'Something went wrong.'
  if (typeof data === 'string') return data.slice(0, 200)
  if (data.detail) return data.detail
  return Object.entries(data)
    .map(([k, v]) => {
      const msg = Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : v
      return k === 'non_field_errors' ? msg : `${k.replace(/_/g, ' ')}: ${msg}`
    })
    .join(' | ')
}

export default api
