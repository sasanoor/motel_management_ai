import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { errorText } from '../api'
import { fmtDate, fmtDateTime, money, num, rateTypeInfo } from '../utils'
import { Alert, BalanceCell, Empty, Stat } from './ui'

/**
 * Reports > Payment History: pick a room, dates and / or a guest name, then Get report.
 * Shows each matching stay with the guest's details and every payment and refund.
 */
export default function PaymentHistory({ isSuper, client, onCSV }) {
  const navigate = useNavigate()
  const [rooms, setRooms] = useState([])
  const [names, setNames] = useState([])
  const [f, setF] = useState({ room: '', start: '', end: '', name: '' })
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (isSuper) return
    api.get('/rooms/').then((r) => setRooms(
      [...r.data].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })),
    )).catch(() => {})
  }, [isSuper])

  // guest name suggestions while typing
  useEffect(() => {
    if (isSuper || f.name.trim().length < 2) return
    const t = setTimeout(() => {
      api.get('/guests/', { params: { q: f.name.trim() } })
        .then((r) => setNames([...new Set((r.data.results || r.data).map((g) => g.name))].slice(0, 15)))
        .catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [f.name, isSuper])

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))
  const ready = f.room || f.start || f.end || f.name.trim()

  async function run(e) {
    e.preventDefault()
    if (!ready) { setErr('Pick a room, a date or a guest name.'); return }
    setBusy(true); setErr('')
    try {
      const params = { ...f, name: f.name.trim() }
      Object.keys(params).forEach((k) => !params[k] && delete params[k])
      if (isSuper) params.client = client
      const { data: d } = await api.get('/reports/payment-history/', { params })
      setData(d)
      onCSV?.(() => exportCSV(d))
    } catch (e2) { setErr(errorText(e2)); setData(null) }
    setBusy(false)
  }

  function exportCSV(d) {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const head = ['Guest', 'Phone', 'Room', 'Check-in', 'Checkout', 'Stay total', 'Business day', 'Taken at', 'Type', 'Method', 'Amount', 'Clerk', 'Notes', 'Balance now']
    const lines = [head.map(esc).join(',')]
    d.rows.forEach((s) => (s.payments.length ? s.payments : [{}]).forEach((p) => lines.push([
      s.guest.name, s.guest.phone, s.room_number, s.check_in_date, s.check_out_date, s.total,
      p.business_date, p.paid_at, p.type, p.method, p.amount, p.clerk, p.notes, s.balance,
    ].map(esc).join(','))))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    a.download = 'payment_history.csv'
    a.click()
  }

  return (
    <>
      <form className="filters history-filters no-print" onSubmit={run}>
        <label className="inline">Room
          {isSuper ? (
            <input value={f.room} onChange={set('room')} placeholder="Any" style={{ width: 80 }} />
          ) : (
            <select value={f.room} onChange={set('room')}>
              <option value="">Any room</option>
              {rooms.map((r) => <option key={r.id} value={r.number}>{r.number} · {r.room_type_name || r.room_type}</option>)}
            </select>
          )}
        </label>
        <label className="inline">From <input type="date" value={f.start} onChange={set('start')} /></label>
        <label className="inline">To <input type="date" value={f.end} min={f.start || undefined} onChange={set('end')} /></label>
        <label className="inline">Guest
          <input list="ph-names" value={f.name} onChange={set('name')} placeholder="Any guest name" />
          <datalist id="ph-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Loading…' : 'Get report'}</button>
        {(ready || data) && <button type="button" className="btn" onClick={() => { setF({ room: '', start: '', end: '', name: '' }); setData(null); setErr('') }}>Clear</button>}
      </form>
      <div className="print-only print-title">
        Payment History{f.room && ` · Room ${f.room}`}{f.name && ` · ${f.name}`}{(f.start || f.end) && ` · ${fmtDate(f.start) || '…'} to ${fmtDate(f.end) || '…'}`}
      </div>
      <Alert>{err}</Alert>

      {!data && !err && <Empty>Pick a room, dates and / or a guest name, then press <strong>Get report</strong>.</Empty>}

      {data && (
        <>
          <div className="stats">
            <Stat label="Stays" value={data.count} />
            <Stat label="Total charged" value={money(data.totals.total)} />
            <Stat label="Cash" value={money(data.totals.cash)} />
            <Stat label="Credit" value={money(data.totals.credit)} />
            {num(data.totals.refunds) > 0 && <Stat label="Refunds (included)" value={money(data.totals.refunds)} tone="bad" />}
            <Stat label="Paid" value={money(data.totals.paid)} tone="good" />
            <Stat label="Balance" value={money(data.totals.balance)} tone={num(data.totals.balance) > 0 ? 'bad' : ''} />
          </div>
          {data.more && <Alert kind="info">Showing the latest 200 stays. Narrow the filters to see older ones.</Alert>}
          {!data.rows.length && <Empty>No stays match these filters.</Empty>}

          {data.rows.map((s) => (
            <section key={s.id} className="card history-card">
              <div className="history-head">
                <div>
                  <h3>
                    {s.guest.name}
                    {s.guest.do_not_rent && <span className="pill pill-red ml">DNR</span>}
                    <span className={`pill ml ${s.status === 'CHECKED_IN' ? 'pill-green' : 'pill-grey'}`}>{s.status === 'CHECKED_IN' ? 'In house' : 'Checked out'}</span>
                  </h3>
                  <div className="history-guest muted">
                    {[s.guest.phone, s.guest.dl_number && `DL ${s.guest.dl_number}`, s.guest.address, [s.guest.car, s.guest.license_plate].filter(Boolean).join(' · ')].filter(Boolean).join('  |  ') || 'No contact details'}
                  </div>
                </div>
                {!isSuper && <button className="btn btn-sm no-print" onClick={() => navigate(`/stays/${s.id}`)}>Open guest</button>}
              </div>
              <div className="history-stay">
                <span><span className="room-chip">{s.room_number}</span> {s.room_type}</span>
                <span>{fmtDate(s.check_in_date)} → {fmtDate(s.check_out_date)} · {s.num_days} night{s.num_days > 1 ? 's' : ''}</span>
                <span>{money(s.rate)}{rateTypeInfo(s.rate_type).short} · {s.num_guests} guest{s.num_guests > 1 ? 's' : ''}</span>
                <span>Room {money(s.room_charge)}{num(s.fees) > 0 && ` + fees ${money(s.fees)}`}{num(s.adjustment) !== 0 && ` ${num(s.adjustment) > 0 ? '+' : '−'} ${money(Math.abs(num(s.adjustment)))}`} = <strong>{money(s.total)}</strong></span>
              </div>
              {!s.payments.length ? <Empty>No payments yet.</Empty> : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Business day</th><th>Taken at</th><th>Type</th><th>Method</th><th className="num">Amount</th><th>Clerk</th><th>Notes</th></tr></thead>
                    <tbody>
                      {s.payments.map((p) => (
                        <tr key={p.id} className={p.type === 'Refund' ? 'refund-row' : ''}>
                          <td><strong>{fmtDate(p.business_date)}</strong></td>
                          <td className="tiny muted">{fmtDateTime(p.paid_at)}</td>
                          <td>{p.type}</td>
                          <td>{p.method === 'CASH' ? 'Cash' : 'Credit'}</td>
                          <td className="num">{money(p.amount)}</td>
                          <td>{p.clerk}</td>
                          <td>{p.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4}>Paid (cash {money(s.cash)} · credit {money(s.credit)})</td>
                        <td className="num">{money(s.paid)}</td>
                        <td colSpan={2}>Balance <BalanceCell value={s.balance} /></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </>
  )
}
