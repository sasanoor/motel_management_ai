import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../auth'
import { fmtDay, ROLES, setBusinessDate } from '../utils'
import { APP_VERSION } from '../version'

const NAV = {
  SUPER_ADMIN: [
    { to: '/clients', label: 'Clients', icon: '🏨' },
    { to: '/reports', label: 'Reports', icon: '📊' },
  ],
  CLIENT_ADMIN: [
    { to: '/', label: 'Home', icon: '🏠', end: true },
    { to: '/check-in', label: 'New Check-in', icon: '➕' },
    { to: '/stays', label: 'Guests', icon: '🧾' },
    { to: '/dnr', label: 'DNR List', icon: '⛔' },
    { to: '/balances', label: 'Balance Payments', icon: '💵' },
    { to: '/today', label: "Today's Report", icon: '🗓️' },
    { to: '/night-audit', label: 'Night Audit', icon: '🌙' },
    { to: '/reports', label: 'Reports', icon: '📊' },
    { section: 'Setup' },
    { to: '/rooms', label: 'Rooms', icon: '🛏️' },
    { to: '/room-types', label: 'Room Types & Rates', icon: '🏷️' },
    { to: '/charges', label: 'Charges & Fees', icon: '💳' },
    { to: '/users', label: 'Users', icon: '👥' },
    { to: '/directory', label: 'Guest Directory', icon: '📇' },
    { to: '/deleted', label: 'Deleted Guests', icon: '🗑️' },
  ],
  MAINTENANCE: [
    { to: '/', label: 'Checkout Rooms', icon: '🧹', end: true },
  ],
  CLIENT_USER: [
    { to: '/', label: 'Home', icon: '🏠', end: true },
    { to: '/check-in', label: 'New Check-in', icon: '➕' },
    { to: '/stays', label: 'Guests', icon: '🧾' },
    { to: '/dnr', label: 'DNR List', icon: '⛔' },
    { to: '/balances', label: 'Balance Payments', icon: '💵' },
    { to: '/today', label: "Today's Report", icon: '🗓️' },
    { to: '/night-audit', label: 'Night Audit', icon: '🌙' },
    { to: '/reports', label: 'Reports', icon: '📊' },
    { to: '/directory', label: 'Guest Directory', icon: '📇' },
  ],
}

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const items = NAV[user.role] || []
  const usesDay = user.role !== 'SUPER_ADMIN'

  // Business day: pages use it as "today". Loaded before any page shows.
  const [biz, setBiz] = useState(null)        // business day the pages are showing
  const [serverBiz, setServerBiz] = useState(null) // latest from the server (changes at day change time)
  const loadBiz = useCallback(() => api.get('/business-day/').then((r) => {
    setServerBiz(r.data.business_date)
    return r.data
  }), [])

  useEffect(() => {
    if (!usesDay) return
    loadBiz()
      .then((d) => { setBusinessDate(d.business_date); setBiz(d.business_date) })
      .catch(() => setBiz('calendar'))
    const t = setInterval(() => { loadBiz().catch(() => {}) }, 60000)
    return () => clearInterval(t)
  }, [usesDay, loadBiz])

  // Updated screens + old server = broken saves. Warn loudly until the app is restarted.
  const [serverVersion, setServerVersion] = useState(null)
  useEffect(() => {
    const check = () => api.get('/version/')
      .then((r) => setServerVersion(r.data.version))
      .catch((e) => setServerVersion(e.response?.status === 404 ? 'old' : null))
    check()
    const t = setInterval(check, 60000)
    return () => clearInterval(t)
  }, [])
  const outdated = serverVersion && serverVersion !== APP_VERSION

  // switch every page to the new business day (after Night Audit, or when the day changes on its own)
  const applyBiz = useCallback((iso) => {
    setBusinessDate(iso)
    setServerBiz(iso)
    setBiz(iso)
  }, [])
  const dayChanged = usesDay && biz && biz !== 'calendar' && serverBiz && serverBiz !== biz

  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div>
            <div className="brand-name">MotelMitra</div>
            <div className="brand-sub">{user.client_name || 'Platform Admin'}</div>
          </div>
        </div>
        {usesDay && biz && biz !== 'calendar' && (
          <NavLink to={user.role === 'MAINTENANCE' ? '/' : '/night-audit'} className="biz-day" onClick={() => setOpen(false)}>
            <span>Business day</span>
            <strong>{fmtDay(biz)}</strong>
          </NavLink>
        )}
        <nav onClick={() => setOpen(false)}>
          {items.map((it, i) =>
            it.section ? (
              <div key={i} className="nav-section">{it.section}</div>
            ) : (
              <NavLink key={it.to} to={it.to} end={it.end} className="nav-link">
                <span className="nav-icon">{it.icon}</span>
                {it.label}
              </NavLink>
            ),
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <strong>{user.full_name}</strong>
            <span>{ROLES[user.role]}</span>
          </div>
          <button className="btn btn-ghost-light" onClick={() => { logout(); navigate('/login') }}>
            Log out
          </button>
          <div className="app-ver" title={serverVersion && serverVersion !== APP_VERSION ? `Server: ${serverVersion}` : 'Screens and server are on the same version'}>
            MotelMitra v{APP_VERSION}
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="menu-btn" onClick={() => setOpen(!open)} aria-label="Menu">☰</button>
          <span className="topbar-title">MotelMitra</span>
        </header>
        <main className="content">
          {outdated && (
            <div className="alert alert-error update-banner">
              <strong>MotelMitra was updated but the server is still running the old version.</strong> Saving may fail.
              Double-click <strong>stop_app.bat</strong>, then <strong>start_app.bat</strong>. (Screens {APP_VERSION}, server {serverVersion === 'old' ? 'older' : serverVersion}.)
            </div>
          )}
          {dayChanged && (
            <div className="alert alert-info day-changed">
              <span className="alert-actions">
                <button className="btn btn-sm btn-primary" onClick={() => applyBiz(serverBiz)}>Switch to {fmtDay(serverBiz)}</button>
              </span>
              The business day is now <strong>{fmtDay(serverBiz)}</strong>. Finish what you are doing, then switch.
            </div>
          )}
          {usesDay && !biz ? <div className="muted">Loading…</div> : <Outlet key={biz || 'x'} context={{ biz, applyBiz, loadBiz }} />}
        </main>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
    </div>
  )
}
