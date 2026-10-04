import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { Alert, BalanceCell, Empty, PageHead, Stat } from '../components/ui'
import { addDays, fmtDate, fmtDateTime, fmtTime, money, num, todayISO } from '../utils'

/** End-of-day / shift handover report for the front desk. */
export default function TodayReport() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [date, setDate] = useState(todayISO())
  const [mine, setMine] = useState(false)
  const [result, setResult] = useState(null) // { key, data }
  const [err, setErr] = useState('')
  const key = `${date}|${mine}`

  useEffect(() => {
    api.get('/reports/today/', { params: { date, mine: mine ? 1 : undefined } })
      .then((r) => { setResult({ key: `${date}|${mine}`, data: r.data }); setErr('') })
      .catch((e) => setErr(errorText(e)))
  }, [date, mine])

  const d = result?.key === key ? result.data : null
  const isToday = date === todayISO()
  const open = (id) => navigate(`/stays/${id}`)

  return (
    <>
      <PageHead
        title={isToday ? "Today's Report" : `Daily Report: ${fmtDate(date)}`}
        sub={`${user.client_name}${mine ? ` · ${user.full_name}'s entries only` : ''}`}
      >
        <div className="date-nav no-print">
          <button className="btn" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <input type="date" value={date} max={todayISO()} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn" onClick={() => setDate(addDays(date, 1))} disabled={isToday}>›</button>
          {!isToday && <button className="btn" onClick={() => setDate(todayISO())}>Today</button>}
        </div>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHead>

      <div className="filters no-print">
        <label className="inline check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my entries (shift handover)
        </label>
      </div>

      <div className="print-only print-title">
        {user.client_name} · Daily Report {fmtDate(date)}{mine ? ` · ${user.full_name}` : ''}
      </div>
      <Alert>{err}</Alert>

      {d && (
        <>
          <h2 className="section-title">Cash drawer</h2>
          <div className="stats">
            <Stat label="Cash collected" value={money(d.money.cash)} tone="good" />
            <Stat label="Credit collected" value={money(d.money.credit)} />
            <Stat label="Total collected" value={money(d.money.collected)} tone="good" />
            <Stat label="From today's check-ins" value={money(d.money.from_todays_checkins)} />
            <Stat label="Balance payments (earlier stays)" value={money(d.money.from_earlier_stays)} />
            <Stat label="Unpaid from today's check-ins" value={money(d.money.unpaid_from_todays_checkins)} tone={num(d.money.unpaid_from_todays_checkins) > 0 ? 'bad' : ''} />
          </div>

          <h2 className="section-title">Rooms</h2>
          <div className="stats">
            <Stat label="Check-ins" value={d.summary.checkins} />
            <Stat label="Checked out" value={d.summary.checkouts_done} />
            <Stat label="Checkouts pending" value={d.summary.checkouts_due} tone={d.summary.checkouts_due ? 'warn' : ''} />
            <Stat label="Occupied tonight" value={`${d.summary.occupied} / ${d.summary.total_rooms}`} />
            <Stat label="Available" value={d.summary.available} tone="good" />
            <Stat label="Occupancy" value={`${d.summary.occupancy_pct}%`} />
          </div>

          {d.by_clerk.length > 0 && (
            <>
              <h2 className="section-title">Collections by clerk</h2>
              <div className="card no-pad">
                <table className="table">
                  <thead><tr><th>Clerk</th><th className="num">Payments</th><th className="num">Cash</th><th className="num">Credit</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {d.by_clerk.map((c) => (
                      <tr key={c.clerk}><td>{c.clerk}</td><td className="num">{c.count}</td><td className="num">{money(c.cash)}</td><td className="num">{money(c.credit)}</td><td className="num"><strong>{money(c.total)}</strong></td></tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td>Total</td><td className="num">{d.payments.length}</td><td className="num">{money(d.money.cash)}</td><td className="num">{money(d.money.credit)}</td><td className="num">{money(d.money.collected)}</td></tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}

          <h2 className="section-title">Check-ins ({d.checkins.length})</h2>
          <div className="card no-pad">
            {!d.checkins.length ? <Empty>No check-ins.</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Time</th><th>Room</th><th>Guest</th><th className="num">Guests</th><th className="num">Nights</th><th>Checkout</th><th className="num">Rate</th><th className="num">Total</th><th className="num">Cash</th><th className="num">Credit</th><th className="num">Balance</th><th>Clerk</th></tr></thead>
                  <tbody>
                    {d.checkins.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                        <td>{fmtTime(r.time)}</td>
                        <td><span className="room-chip">{r.room_number}</span> <span className="tiny muted">{r.room_type}</span></td>
                        <td>{r.guest_name}{r.do_not_rent && <span className="pill pill-red ml">DNR</span>}</td>
                        <td className="num">{r.num_guests}</td>
                        <td className="num">{r.num_days}</td>
                        <td>{fmtDate(r.check_out_date)}</td>
                        <td className="num">{money(r.rate)}</td>
                        <td className="num">{money(r.total)}</td>
                        <td className="num">{money(r.cash)}</td>
                        <td className="num">{money(r.credit)}</td>
                        <td className="num"><BalanceCell value={r.balance} /></td>
                        <td>{r.clerk}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={7}>Total</td><td className="num">{money(d.money.booked)}</td><td colSpan={4}></td></tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          <h2 className="section-title">Checkouts ({d.checkouts.length})</h2>
          <div className="card no-pad">
            {!d.checkouts.length ? <Empty>No checkouts.</Empty> : (
              <table className="table">
                <thead><tr><th>Room</th><th>Guest</th><th>Checked in</th><th className="num">Total</th><th className="num">Balance</th><th>Status</th></tr></thead>
                <tbody>
                  {d.checkouts.map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                      <td><span className="room-chip">{r.room_number}</span></td>
                      <td>{r.guest_name}</td>
                      <td>{fmtDate(r.check_in_date)}</td>
                      <td className="num">{money(r.total)}</td>
                      <td className="num"><BalanceCell value={r.balance} /></td>
                      <td>{r.status === 'CHECKED_OUT' ? <span className="pill pill-grey">Checked out</span> : <span className="pill pill-red">Pending</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2 className="section-title">Payments received ({d.payments.length})</h2>
          <div className="card no-pad">
            {!d.payments.length ? <Empty>No payments.</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Time</th><th>Type</th><th>Method</th><th className="num">Amount</th><th>Guest</th><th>Room</th><th>Check-in date</th><th>Clerk</th></tr></thead>
                  <tbody>
                    {d.payments.map((p) => (
                      <tr key={p.id} className="clickable" onClick={() => open(p.stay_id)}>
                        <td>{fmtDateTime(p.paid_at)}</td>
                        <td>{p.type}</td>
                        <td>{p.method === 'CASH' ? 'Cash' : 'Credit'}</td>
                        <td className="num">{money(p.amount)}</td>
                        <td>{p.guest_name}</td>
                        <td>{p.room_number}</td>
                        <td>{fmtDate(p.check_in_date)}</td>
                        <td>{p.clerk}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="print-only signoff">
            <div>Clerk signature: ____________________</div>
            <div>Cash counted: ____________________</div>
            <div>Manager: ____________________</div>
          </div>
        </>
      )}
    </>
  )
}
