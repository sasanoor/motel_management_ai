import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth'
import { ROLES } from '../utils'

const NAV = {
  SUPER_ADMIN: [
    { to: '/clients', label: 'Clients', icon: '🏨' },
    { to: '/reports', label: 'Reports', icon: '📊' },
  ],
  CLIENT_ADMIN: [
    { to: '/', label: 'Home', icon: '🏠', end: true },
    { to: '/check-in', label: 'New Check-in', icon: '➕' },
    { to: '/stays', label: 'Guests', icon: '🧾' },
    { to: '/balances', label: 'Balance Payments', icon: '💵' },
    { to: '/reports', label: 'Reports', icon: '📊' },
    { section: 'Setup' },
    { to: '/rooms', label: 'Rooms', icon: '🛏️' },
    { to: '/room-types', label: 'Room Types & Rates', icon: '🏷️' },
    { to: '/users', label: 'Users', icon: '👥' },
    { to: '/directory', label: 'Guest Directory', icon: '📇' },
    { to: '/deleted', label: 'Deleted Guests', icon: '🗑️' },
  ],
  CLIENT_USER: [
    { to: '/', label: 'Home', icon: '🏠', end: true },
    { to: '/check-in', label: 'New Check-in', icon: '➕' },
    { to: '/stays', label: 'Guests', icon: '🧾' },
    { to: '/balances', label: 'Balance Payments', icon: '💵' },
    { to: '/reports', label: 'Reports', icon: '📊' },
    { to: '/directory', label: 'Guest Directory', icon: '📇' },
  ],
}

export default function Layout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const items = NAV[user.role] || []

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
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="menu-btn" onClick={() => setOpen(!open)} aria-label="Menu">☰</button>
          <span className="topbar-title">MotelMitra</span>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
    </div>
  )
}
