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

let refreshing = null
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config
    if (error.response?.status === 401 && tokens.refresh && !original._retry && !original.url.includes('auth/')) {
      original._retry = true
      try {
        refreshing = refreshing || api.post('/auth/refresh/', { refresh: tokens.refresh })
        const { data } = await refreshing
        tokens.set(data.access)
        return api(original)
      } catch {
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
