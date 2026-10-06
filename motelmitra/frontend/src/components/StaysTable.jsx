import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fmtDate, fmtTime, money, num } from '../utils'
import { CurrentDay, DaysLeft } from './RoomSheet'
import { BalanceCell, Empty, StatusPill } from './ui'

// Columns of the guest grid. `filter` = the box shown in the filter row under the header.
const COLUMNS = [
  { id: 'room', label: 'Room', filter: 'text', fixed: true },
  { id: 'name', label: 'Guest', filter: 'text', fixed: true },
  { id: 'phone', label: 'Phone', filter: 'text' },
  { id: 'check_in_date', label: 'Check-in', filter: 'date' },
  { id: 'check_out_date', label: 'Check-out', filter: 'date' },
  { id: 'days', label: 'Days', filter: 'number', num: true },
  { id: 'curday', label: 'Current day', num: true },
  { id: 'daysleft', label: 'Days left' },
  { id: 'total', label: 'Total', num: true },
  { id: 'paid', label: 'Paid', num: true },
  { id: 'balance', label: 'Balance', filter: 'balance', num: true },
  { id: 'status', label: 'Status', filter: 'status' },
]
const BALANCE_OPTS = [['', 'Any'], ['owed', 'Owes'], ['paid', 'Paid up'], ['credit', 'In credit']]
const STATUS_OPTS = [['', 'All'], ['CHECKED_IN', 'In house'], ['CHECKED_OUT', 'Checked out']]

// Column choice is remembered on this PC (browser storage; falls back to all columns).
function readHidden(key) {
  try { return JSON.parse(window.localStorage.getItem(`mm.cols.${key}`) || '[]') } catch { return [] }
}
function writeHidden(key, ids) {
  try { window.localStorage.setItem(`mm.cols.${key}`, JSON.stringify(ids)) } catch { /* private window: not remembered */ }
}

// Same rules as the server filters, for grids that already have all their rows (Home tabs).
function matches(s, f) {
  const has = (v, q) => String(v || '').toLowerCase().includes(String(q).trim().toLowerCase())
  if (f.room && !has(s.room_number, f.room)) return false
  if (f.name && !has(s.guest.name, f.name)) return false
  if (f.phone && !has(s.guest.phone, f.phone)) return false
  if (f.check_in_date && s.check_in_date !== f.check_in_date) return false
  if (f.check_out_date && s.check_out_date !== f.check_out_date) return false
  if (f.days && Number(s.num_days) !== Number(f.days)) return false
  if (f.status && s.status !== f.status) return false
  if (f.balance === 'owed' && !(num(s.balance) > 0)) return false
  if (f.balance === 'paid' && num(s.balance) !== 0) return false
  if (f.balance === 'credit' && !(num(s.balance) < 0)) return false
  return true
}

/**
 * Shared guest grid with a filter row (one box per column) and a Columns chooser.
 * actions: { onPay(stay), onCheckout(stay) } optional
 * Server filtering: pass filters + onFilter(key, value) (Guests, Balance Payments).
 * Without onFilter the grid filters its own rows (Home tabs).
 * gridKey: where the column choice is remembered. noFilter: column ids without a filter box.
 */
export default function StaysTable({ stays, actions = {}, empty = 'No guests.', highlightDate,
  filters, onFilter, gridKey = 'stays', noFilter = [] }) {
  const navigate = useNavigate()
  const [local, setLocal] = useState({})
  const [hidden, setHidden] = useState(() => readHidden(gridKey))
  const [menu, setMenu] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!menu) return
    const close = (e) => { if (!menuRef.current?.contains(e.target)) setMenu(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const f = onFilter ? (filters || {}) : local
  const setF = (k, v) => (onFilter ? onFilter(k, v) : setLocal((o) => ({ ...o, [k]: v })))
  const active = Object.entries(f).filter(([k, v]) => v && !noFilter.includes(k)).length
  const clearAll = () => (onFilter ? onFilter(null) : setLocal({}))
  const rows = onFilter ? (stays || []) : (stays || []).filter((s) => matches(s, f))
  const cols = COLUMNS.filter((c) => !hidden.includes(c.id))
  const toggleCol = (id) => {
    const next = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]
    setHidden(next); writeHidden(gridKey, next)
  }

  if (!stays?.length && !active) return <Empty>{empty}</Empty>

  const cell = (c, s) => {
    switch (c.id) {
      case 'room': return <td key={c.id}><span className="room-chip">{s.room_number}</span><div className="tiny muted">{s.room_type}</div></td>
      case 'name': return <td key={c.id}><strong>{s.guest.name}</strong>{s.guest.do_not_rent && <span className="pill pill-red ml">DNR</span>}</td>
      case 'phone': return <td key={c.id}>{s.guest.phone}</td>
      case 'check_in_date': return <td key={c.id}>{fmtDate(s.check_in_date)}<div className="tiny muted">{fmtTime(s.check_in_time)}</div></td>
      case 'check_out_date': return (
        <td key={c.id} className={highlightDate && s.check_out_date === highlightDate ? 'due' : ''}>
          {fmtDate(s.check_out_date)}<div className="tiny muted">{fmtTime(s.check_out_time)}</div>
        </td>
      )
      case 'days': return <td key={c.id} className="num">{s.num_days}</td>
      case 'curday': return <td key={c.id} className="num"><CurrentDay stay={s} date={highlightDate} /></td>
      case 'daysleft': return <td key={c.id}><DaysLeft stay={s} date={highlightDate} /></td>
      case 'total': return <td key={c.id} className="num">{money(s.total_amount)}</td>
      case 'paid': return <td key={c.id} className="num">{money(s.amount_paid)}</td>
      case 'balance': return <td key={c.id} className="num"><BalanceCell value={s.balance} /></td>
      case 'status': return <td key={c.id}><StatusPill stay={s} /></td>
      default: return <td key={c.id}></td>
    }
  }

  const filterBox = (c) => {
    if (!c.filter || noFilter.includes(c.id)) return <th key={c.id}></th>
    const v = f[c.id] || ''
    const on = v ? ' on' : ''
    if (c.filter === 'balance' || c.filter === 'status') {
      const opts = c.filter === 'balance' ? BALANCE_OPTS : STATUS_OPTS
      return <th key={c.id}><select className={`gf${on}`} value={v} onChange={(e) => setF(c.id, e.target.value)}>{opts.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></th>
    }
    return (
      <th key={c.id}>
        <input className={`gf${on}`} type={c.filter} min={c.filter === 'number' ? 1 : undefined}
          placeholder={c.filter === 'text' ? 'Filter…' : c.filter === 'number' ? '#' : undefined}
          value={v} onChange={(e) => setF(c.id, e.target.value)} />
      </th>
    )
  }

  return (
    <>
      <div className="grid-tools">
        {active > 0 && <span className="tiny muted">{active} filter{active === 1 ? '' : 's'} on · {onFilter ? '' : `${rows.length} of ${stays.length} rows · `}<button type="button" className="link-btn" onClick={clearAll}>Clear filters</button></span>}
        <div className="col-chooser" ref={menuRef}>
          <button type="button" className="btn btn-sm" onClick={() => setMenu((m) => !m)}>
            Columns{hidden.length ? ` (${COLUMNS.length - hidden.length}/${COLUMNS.length})` : ''} ▾
          </button>
          {menu && (
            <div className="col-menu">
              <div className="tiny muted">Show columns (saved on this PC)</div>
              {COLUMNS.map((c) => (
                <label key={c.id} className={c.fixed ? 'muted' : ''}>
                  <input type="checkbox" checked={!hidden.includes(c.id)} disabled={c.fixed} onChange={() => toggleCol(c.id)} /> {c.label}
                </label>
              ))}
              {hidden.length > 0 && <button type="button" className="link-btn" onClick={() => { setHidden([]); writeHidden(gridKey, []) }}>Show all</button>}
            </div>
          )}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table grid-filterable">
          <thead>
            <tr>
              {cols.map((c) => <th key={c.id} className={c.num ? 'num' : ''}>{c.label}</th>)}
              <th></th>
            </tr>
            <tr className="filter-row">
              {cols.map(filterBox)}
              <th>{active > 0 && <button type="button" className="btn btn-sm" title="Clear filters" onClick={clearAll}>✕</button>}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={cols.length + 1} className="muted grid-empty">No rows match these filters.</td></tr>}
            {rows.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => navigate(`/stays/${s.id}`)}>
                {cols.map((c) => cell(c, s))}
                <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {actions.onPay && num(s.balance) > 0 && (
                    <button className="btn btn-sm btn-warn" onClick={() => actions.onPay(s)}>Pay</button>
                  )}
                  {actions.onCheckout && s.status === 'CHECKED_IN' && (
                    <button className="btn btn-sm" onClick={() => actions.onCheckout(s)}>Check out</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
