import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import PaymentHistory from '../components/PaymentHistory'
import { Alert, BalanceCell, Empty, PageHead, Stat } from '../components/ui'
import { addDays, fmtDate, fmtDateTime, money, todayISO, rateTypeInfo } from '../utils'

const TABS = [
  { key: 'checkins', label: 'Daily Check-ins', range: true },
  { key: 'collections', label: 'Collections', range: true },
  { key: 'outstanding', label: 'Outstanding Balances', range: false },
  { key: 'occupancy', label: 'Occupancy', range: true },
  { key: 'history', label: 'Payment History', range: false, own: true }, // own filters + Get report button
]

function downloadCSV(name, header, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = `${name}.csv`
  a.click()
}

export default function Reports() {
  const { isSuper } = useAuth()
  const navigate = useNavigate()
  const [tab, setTab] = useState('checkins')
  const [start, setStart] = useState(todayISO())
  const [end, setEnd] = useState(todayISO())
  const [clients, setClients] = useState([])
  const [client, setClient] = useState('')
  const [result, setResult] = useState(null) // { tab, data }
  const [err, setErr] = useState('')
  const historyCSV = useRef(null)
  const [historyReady, setHistoryReady] = useState(false)

  useEffect(() => {
    if (isSuper) api.get('/clients/').then((r) => { setClients(r.data); if (r.data[0]) setClient(String(r.data[0].id)) })
  }, [isSuper])

  useEffect(() => {
    if (isSuper && !client) return
    if (TABS.find((t) => t.key === tab).own) return
    const params = { start, end }
    if (isSuper) params.client = client
    api.get(`/reports/${tab}/`, { params })
      .then((r) => { setResult({ tab, data: r.data }); setErr('') })
      .catch((e) => setErr(errorText(e)))
  }, [tab, start, end, client, isSuper])

  // only render data that belongs to the selected tab
  const data = result?.tab === tab ? result.data : null
  const current = TABS.find((t) => t.key === tab)
  const open = (id) => !isSuper && navigate(`/stays/${id}`)

  function preset(days) {
    setEnd(todayISO())
    setStart(addDays(todayISO(), -days + 1))
  }

  function exportCSV() {
    if (tab === 'history') { historyCSV.current?.(); return }
    if (!data) return
    if (tab === 'checkins') downloadCSV(`checkins_${start}_${end}`,
      ['Check-in', 'Room', 'Type', 'Guest', 'Guests', 'Days', 'Rate', 'Fees', 'Total', 'Cash (check-in day)', 'Credit (check-in day)', 'Paid later', 'Balance', 'Clerk'],
      data.rows.map((r) => [r.check_in_date, r.room_number, r.room_type, r.guest_name, r.num_guests, r.num_days, r.rate, r.fees, r.total, r.cash, r.credit, r.paid_later, r.balance, r.clerk]))
    if (tab === 'collections') downloadCSV(`collections_${start}_${end}`,
      ['Business day', 'Paid at', 'Type', 'Method', 'Amount', 'Guest', 'Room', 'Check-in date', 'Clerk'],
      data.payments.map((p) => [p.business_date, p.paid_at, p.type, p.method, p.amount, p.guest_name, p.room_number, p.check_in_date, p.clerk]))
    if (tab === 'outstanding') downloadCSV('outstanding_balances',
      ['Check-in', 'Checkout', 'Room', 'Guest', 'Phone', 'Total', 'Paid', 'Balance'],
      data.rows.map((r) => [r.check_in_date, r.check_out_date, r.room_number, r.guest_name, r.phone, r.total, r.paid, r.balance]))
    if (tab === 'occupancy') downloadCSV(`occupancy_${start}_${end}`,
      ['Date', 'Occupied', 'Available', 'Total rooms', 'Occupancy %', 'Room revenue', 'ADR'],
      data.days.map((d) => [d.date, d.occupied, d.available, d.total_rooms, d.occupancy_pct, d.room_revenue, d.adr]))
  }

  return (
    <>
      <PageHead title="Reports">
        <button className="btn" onClick={exportCSV} disabled={tab === 'history' ? !historyReady : !data}>Export CSV</button>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHead>

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {(!current.own || isSuper) && <div className="filters no-print">
        {isSuper && (
          <select value={client} onChange={(e) => setClient(e.target.value)}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {current.range && (
          <>
            <label className="inline">From <input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value) }} /></label>
            <label className="inline">To <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></label>
            <button className="btn btn-sm" onClick={() => preset(1)}>Today</button>
            <button className="btn btn-sm" onClick={() => preset(7)}>7 days</button>
            <button className="btn btn-sm" onClick={() => preset(30)}>30 days</button>
          </>
        )}
      </div>}
      {!current.own && <div className="print-only print-title">
        {current.label} {current.range && `· ${fmtDate(start)} to ${fmtDate(end)}`}
      </div>}
      <Alert>{err}</Alert>
      {tab === 'history' && (isSuper && !client ? null : (
        <PaymentHistory isSuper={isSuper} client={client} onCSV={(fn) => { historyCSV.current = fn; setHistoryReady(true) }} />
      ))}

      {data && tab === 'checkins' && (
        <>
          <div className="stats">
            <Stat label="Check-ins" value={data.count} />
            <Stat label="Total" value={money(data.totals.total)} />
            <Stat label="Cash" value={money(data.totals.cash)} />
            <Stat label="Credit" value={money(data.totals.credit)} />
            <Stat label="Balance" value={money(data.totals.balance)} tone={Number(data.totals.balance) > 0 ? 'bad' : ''} />
          </div>
          <p className="muted tiny">Cash and credit include balance payments made later, counted against the original check-in date.</p>
          <div className="card no-pad">
            {!data.rows.length ? <Empty>No check-ins in this period.</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Check-in</th><th>Room</th><th>Guest</th><th className="num">Guests</th><th className="num">Days</th><th className="num">Rate</th><th className="num">Fees</th><th className="num">Total</th><th className="num">Cash</th><th className="num">Credit</th><th className="num">Paid later</th><th className="num">Balance</th><th>Clerk</th></tr></thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} className={isSuper ? '' : 'clickable'} onClick={() => open(r.id)}>
                        <td>{fmtDate(r.check_in_date)}</td>
                        <td><span className="room-chip">{r.room_number}</span> <span className="tiny muted">{r.room_type}</span></td>
                        <td>{r.guest_name}</td>
                        <td className="num">{r.num_guests}</td>
                        <td className="num">{r.num_days}</td>
                        <td className="num">{money(r.rate)}<span className="tiny muted">{rateTypeInfo(r.rate_type).short}</span></td>
                        <td className="num">{money(r.fees)}</td>
                        <td className="num">{money(r.total)}</td>
                        <td className="num">{money(r.cash)}</td>
                        <td className="num">{money(r.credit)}</td>
                        <td className="num">
                          {Number(r.paid_later) ? <span className="muted">{money(r.paid_later)}</span> : <span className="muted">—</span>}
                          {Number(r.balance) <= 0 && <div><span className="pill pill-green">Paid</span></div>}
                        </td>
                        <td className="num"><BalanceCell value={r.balance} /></td>
                        <td>{r.clerk}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={7}>Total</td><td className="num">{money(data.totals.total)}</td><td className="num">{money(data.totals.cash)}</td><td className="num">{money(data.totals.credit)}</td><td className="num muted">{money(data.totals.paid_later)}</td><td className="num">{money(data.totals.balance)}</td><td></td></tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {data && tab === 'collections' && (
        <>
          <div className="stats">
            <Stat label="Cash (net)" value={money(data.totals.cash)} />
            <Stat label="Credit (net)" value={money(data.totals.credit)} />
            <Stat label="Refunds given" value={money(data.totals.refunds)} tone={Number(data.totals.refunds) > 0 ? 'bad' : ''} />
            <Stat label="Net collected" value={money(data.totals.total)} tone="good" />
            <Stat label="Payments" value={data.payments.length} />
          </div>
          <div className="card no-pad">
            {!data.days.length ? <Empty>No payments in this period.</Empty> : (
              <table className="table">
                <thead><tr><th>Date</th><th className="num">Payments</th><th className="num">Cash</th><th className="num">Credit</th><th className="num">Refunds</th><th className="num">Net total</th></tr></thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={d.date}><td>{fmtDate(d.date)}</td><td className="num">{d.count}</td><td className="num">{money(d.cash)}</td><td className="num">{money(d.credit)}</td><td className="num">{Number(d.refunds) > 0 ? <span className="owed">−{money(d.refunds)}</span> : money(0)}</td><td className="num"><strong>{money(d.total)}</strong></td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {data.payments.length > 0 && (
            <>
              <h2 className="section-title">Payment detail</h2>
              <div className="card no-pad">
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Paid at</th><th>Type</th><th>Method</th><th className="num">Amount</th><th>Guest</th><th>Room</th><th>Check-in date</th><th>Clerk</th></tr></thead>
                    <tbody>
                      {data.payments.map((p) => (
                        <tr key={p.id} className={p.type === 'Refund' ? 'refund-row' : ''}>
                          <td>{fmtDateTime(p.paid_at)}</td><td>{p.type}</td><td>{p.method === 'CASH' ? 'Cash' : 'Credit'}</td>
                          <td className="num">{money(p.amount)}</td><td>{p.guest_name}</td><td>{p.room_number}</td>
                          <td>{fmtDate(p.check_in_date)}</td><td>{p.clerk}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {data && tab === 'outstanding' && (
        <>
          <div className="stats">
            <Stat label="Guests with balance" value={data.count} />
            <Stat label="Total outstanding" value={money(data.total_balance)} tone={data.count ? 'bad' : 'good'} />
          </div>
          <div className="card no-pad">
            {!data.rows.length ? <Empty>No outstanding balances.</Empty> : (
              <table className="table">
                <thead><tr><th>Check-in</th><th>Checkout</th><th>Room</th><th>Guest</th><th>Phone</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th><th>Status</th></tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className={isSuper ? '' : 'clickable'} onClick={() => open(r.id)}>
                      <td>{fmtDate(r.check_in_date)}</td><td>{fmtDate(r.check_out_date)}</td>
                      <td><span className="room-chip">{r.room_number}</span></td><td>{r.guest_name}</td><td>{r.phone}</td>
                      <td className="num">{money(r.total)}</td><td className="num">{money(r.paid)}</td>
                      <td className="num"><BalanceCell value={r.balance} /></td>
                      <td>{r.status === 'CHECKED_IN' ? 'In house' : 'Checked out'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {data && tab === 'occupancy' && (
        <>
          <div className="stats">
            <Stat label="Rooms" value={data.summary.total_rooms} />
            <Stat label="Room nights sold" value={data.summary.room_nights_sold} />
            <Stat label="Occupancy" value={`${data.summary.occupancy_pct}%`} tone="good" />
          </div>
          <div className="grid-2">
            <div className="card no-pad">
              <table className="table">
                <thead><tr><th>Date</th><th className="num">Occupied</th><th className="num">Available</th><th>Occupancy</th><th className="num">ADR</th></tr></thead>
                <tbody>
                  {data.days.map((d) => (
                    <tr key={d.date}>
                      <td>{fmtDate(d.date)}</td><td className="num">{d.occupied}</td><td className="num">{d.available}</td>
                      <td><div className="bar"><span style={{ width: `${d.occupancy_pct}%` }} /></div><span className="tiny">{d.occupancy_pct}%</span></td>
                      <td className="num">{money(d.adr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card no-pad">
              <table className="table">
                <thead><tr><th>Room type</th><th className="num">Rooms</th><th className="num">Nights sold</th><th>Occupancy</th></tr></thead>
                <tbody>
                  {data.by_type.map((t) => (
                    <tr key={t.room_type}>
                      <td>{t.room_type}</td><td className="num">{t.rooms}</td><td className="num">{t.room_nights}</td>
                      <td><div className="bar"><span style={{ width: `${t.occupancy_pct}%` }} /></div><span className="tiny">{t.occupancy_pct}%</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  )
}
