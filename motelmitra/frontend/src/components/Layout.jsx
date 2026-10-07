import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import api from '../api'
import { useAuth } from '../auth'
import { fmtDay, ROLES, setBusinessDate, setWifiHosted } from '../utils'
import { APP_VERSION } from '../version'
import GridScroller from './GridScroller'
import { PlanExpiredScreen, PlanWarning } from '../pages/Plans'

const NAV = {
  SUPER_ADMIN: [
    { to: '/clients', label: 'Clients', icon: '🏨' },
    { to: '/plans', label: 'Plans', icon: '💳' },
    { to: '/reports', label: 'Reports', icon: '📊' },
  ],
  CLIENT_ADMIN: [
    { to: '/', label: 'Home', icon: '🏠', end: true },
    { to: '/check-in', label: 'New Check-in', icon: '➕' },
    { to: '/today', label: "Today's Report", icon: '🗓️' },
    { to: '/night-audit', label: 'Night Audit', icon: '🌙' },
    { to: '/housekeeping', label: 'Housekeeping', icon: '🧹' },
    { to: '/stays', label: 'Guests', icon: '🧾' },
    { to: '/dnr', label: 'DNR List', icon: '⛔' },
    { to: '/balances', label: 'Balance Payments', icon: '💵' },
    { to: '/problems', label: 'Room Problems', icon: '⚠️' },
    { to: '/reports', label: 'Reports', icon: '📊' },
    { to: '/directory', label: 'Guest Directory', icon: '📇' },
    { section: 'Setup' },
    { to: '/rooms', label: 'Rooms', icon: '🛏️' },
    { to: '/room-types', label: 'Room Types & Rates', icon: '🏷️' },
    { to: '/charges', label: 'Charges & Fees', icon: '💳' },
    { to: '/users', label: 'Users', icon: '👥' },
    { to: '/deleted', label: 'Deleted Guests', icon: '🗑️' },
    { to: '/plan', label: 'My Plan', icon: '📅' },
  ],
  MAINTENANCE: [
    { to: '/', label: 'Housekeeping', icon: '🧹', end: true },
    { to: '/problems', label: 'Room Problems', icon: '⚠️' },
    { to: '/notes', label: 'Checkouts & Notes', icon: '📝' },
  ],
  CLIENT_USER: [
    { to: '/', label: 'Home', icon: '🏠', end: true },
    { to: '/check-in', label: 'New Check-in', icon: '➕' },
    { to: '/today', label: "Today's Report", icon: '🗓️' },
    { to: '/night-audit', label: 'Night Audit', icon: '🌙' },
    { to: '/housekeeping', label: 'Housekeeping', icon: '🧹' },
    { to: '/stays', label: 'Guests', icon: '🧾' },
    { to: '/dnr', label: 'DNR List', icon: '⛔' },
    { to: '/balances', label: 'Balance Payments', icon: '💵' },
    { to: '/problems', label: 'Room Problems', icon: '⚠️' },
    { to: '/reports', label: 'Reports', icon: '📊' },
    { to: '/directory', label: 'Guest Directory', icon: '📇' },
  ],
}

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  // MotelMitra plan: warning popup in the last days, "plan ended" screen for the admin after the end date
  const [plan, setPlan] = useState(null)
  const [planWarn, setPlanWarn] = useState(false)
  const loadPlan = useCallback(() => {
    if (user.role === 'SUPER_ADMIN') return
    api.get('/subscription/').then((r) => {
      const p = r.data.plan
      setPlan(p)
      let seen = false
      try { seen = sessionStorage.getItem('mm.planwarn') === String(p.paid_until) } catch { /* ignore */ }
      if (p.status === 'expiring' && !seen) setPlanWarn(true)
    }).catch(() => {})
  }, [user.role])
  useEffect(() => {
    loadPlan()
    const t = setInterval(loadPlan, 10 * 60000)
    window.addEventListener('mm-plan-expired', loadPlan)
    return () => { clearInterval(t); window.removeEventListener('mm-plan-expired', loadPlan) }
  }, [loadPlan])
  const planEnded = plan?.status === 'expired'
  const closeWarn = () => {
    try { sessionStorage.setItem('mm.planwarn', String(plan.paid_until)) } catch { /* ignore */ }
    setPlanWarn(false)
  }
  const items = planEnded ? [] : (NAV[user.role] || [])
  const usesDay = user.role !== 'SUPER_ADMIN'

  // Business day: pages use it as "today". Loaded before any page shows.
  const [biz, setBiz] = useState(null)        // business day the pages are showing
  const [serverBiz, setServerBiz] = useState(null) // latest from the server (changes at day change time)
  const [diskGb, setDiskGb] = useState(null)
  const loadBiz = useCallback(() => api.get('/business-day/').then((r) => {
    setServerBiz(r.data.business_date)
    setDiskGb(r.data.disk_free_gb)
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
  const [gridButtons, setGridButtons] = useState(false) // GRID_SCROLL_BUTTONS in backend\.env
  useEffect(() => {
    const check = () => api.get('/version/')
      .then((r) => { setServerVersion(r.data.version); setWifiHosted(r.data.wifi); setGridButtons(r.data.grid_scroll_buttons !== false) })
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
          <div className="who-row">
            <div className="who">
              <strong>{user.full_name}</strong>
              <span>{ROLES[user.role]}</span>
            </div>
            <button type="button" className="logout-icon" title="Log out" aria-label="Log out" onClick={() => { logout(); navigate('/login') }}>
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
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
          {diskGb != null && diskGb < 5 && (
            <div className="alert alert-error">
              <strong>Low disk space on the MotelMitra PC: {diskGb} GB free.</strong> Photos may stop saving.
              Move old photos out of the <strong>backend\media</strong> folder or free up space.
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
          {gridButtons && <GridScroller />}
          {planEnded ? <PlanExpiredScreen plan={plan} />
            : usesDay && !biz ? <div className="muted">Loading…</div> : <Outlet key={biz || 'x'} context={{ biz, applyBiz, loadBiz }} />}
          {planWarn && plan && <PlanWarning plan={plan} isAdmin={user.role === 'CLIENT_ADMIN'} onClose={closeWarn} />}
        </main>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
    </div>
  )
}
