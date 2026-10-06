import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import AddStayModal from '../components/AddStayModal'
import CheckoutModal from '../components/CheckoutModal'
import ExpenseModal from '../components/ExpenseModal'
import RoomSheet from '../components/RoomSheet'
import { Alert, BalanceCell, Empty, PageHead, PaymentModal, Stat } from '../components/ui'
import { addDays, fmtDate, fmtDateTime, fmtTime, money, num, todayISO, rateTypeInfo } from '../utils'

/** End-of-day / shift handover report for the front desk. */
export default function TodayReport() {
  const { user, isAdmin } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [date, setDate] = useState(params.get('date') || todayISO())
  const [mine, setMine] = useState(false)
  const [result, setResult] = useState(null) // { key, data }
  const [err, setErr] = useState('')
  const key = `${date}|${mine}`
  // Room sheet: same component and same /dashboard/ data as Home, so both always match
  const [sheet, setSheet] = useState(null)   // { date, data }
  const [tick, setTick] = useState(0)        // bump to reload after a payment / checkout / add stay
  const [paying, setPaying] = useState(null)
  const [checkingOut, setCheckingOut] = useState(null)
  const [adding, setAdding] = useState(null)
  const [expense, setExpense] = useState(null)  // {} = new, or the expense being edited
  const reload = () => setTick((t) => t + 1)

  useEffect(() => {
    api.get('/reports/today/', { params: { date, mine: mine ? 1 : undefined } })
      .then((r) => { setResult({ key: `${date}|${mine}`, data: r.data }); setErr('') })
      .catch((e) => setErr(errorText(e)))
  }, [date, mine, tick])

  useEffect(() => {
    api.get('/dashboard/', { params: { date } })
      .then((r) => setSheet({ date, data: r.data }))
      .catch(() => {})
  }, [date, tick])
  const sheetData = sheet?.date === date ? sheet.data : null

  async function deleteExpense(x) {
    if (!window.confirm(`Delete expense "${x.description}" (${money(x.amount)})?`)) return
    try { await api.delete(`/expenses/${x.id}/`); reload() } catch (e) { setErr(errorText(e)) }
  }

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
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn" onClick={() => setDate(addDays(date, 1))}>›</button>
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
          <div className="section-head">
            <h2 className="section-title">Cash drawer</h2>
            {(isAdmin || isToday) && <button className="btn btn-sm no-print" onClick={() => setExpense({})}>+ Add expense</button>}
          </div>
          <div className="stats">
            <Stat label="Cash in drawer" value={money(d.money.cash_in_drawer)} tone={num(d.money.cash_in_drawer) < 0 ? 'bad' : 'good'} />
            <Stat label="Cash collected" value={money(d.money.cash)} tone="good" />
            <Stat label="Credit collected" value={money(d.money.credit)} />
            <Stat label="Total collected" value={money(d.money.collected)} tone="good" />
            {num(d.money.refunds) > 0 && <Stat label="Refunds given (included above)" value={money(d.money.refunds)} tone="bad" />}
            <Stat label="From today's check-ins" value={money(d.money.from_todays_checkins)} />
            <Stat label="Balance payments (earlier stays)" value={money(d.money.from_earlier_stays)} />
            <Stat label="Unpaid from today's check-ins" value={money(d.money.unpaid_from_todays_checkins)} tone={num(d.money.unpaid_from_todays_checkins) > 0 ? 'bad' : ''} />
            <Stat label="Expenses (cash)" value={money(d.money.expenses_cash)} tone={num(d.money.expenses_cash) > 0 ? 'bad' : ''} />
            <Stat label="Expenses (card)" value={money(d.money.expenses_card)} />
          </div>
          <p className="tiny muted drawer-note">Cash in drawer = cash collected {money(d.money.cash)} − cash expenses {money(d.money.expenses_cash)}</p>

          {d.expenses.length > 0 && (
            <div className="card no-pad expense-card">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Time</th><th>Description</th><th>Paid by</th><th className="num">Amount</th><th>Clerk</th><th className="no-print"></th></tr></thead>
                  <tbody>
                    {d.expenses.map((x) => (
                      <tr key={x.id}>
                        <td>{fmtTime(new Date(x.created_at).toTimeString().slice(0, 5))}</td>
                        <td className="wrap">{x.description}</td>
                        <td>{x.method === 'CASH' ? 'Cash' : 'Card'}</td>
                        <td className="num">{money(x.amount)}</td>
                        <td>{x.clerk_name}</td>
                        <td className="row-actions no-print">
                          {x.can_edit && <>
                            <button className="btn btn-sm" onClick={() => setExpense(x)}>Edit</button>
                            <button className="btn btn-sm btn-danger-outline" onClick={() => deleteExpense(x)}>Delete</button>
                          </>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={3}>Expenses ({d.expenses.length})</td><td className="num">{money(d.money.expenses)}</td><td colSpan={2}></td></tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          <h2 className="section-title">Rooms</h2>
          <div className="stats">
            <Stat label="Check-ins" value={d.summary.checkins} />
            <Stat label="Checked out" value={d.summary.checkouts_done} />
            <Stat label="Checkouts pending" value={d.summary.checkouts_due} tone={d.summary.checkouts_due ? 'warn' : ''} />
            <Stat label="Occupied tonight" value={`${d.summary.occupied} / ${d.summary.total_rooms}`} />
            <Stat label="Available" value={d.summary.available} tone="good" />
            <Stat label="Occupancy" value={`${d.summary.occupancy_pct}%`} />
          </div>

          {sheetData && (() => {
            const openRooms = sheetData.rooms.filter((r) => r.available)
              .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
            return (
              <div className="card open-rooms">
                <div className="open-rooms-head">
                  <strong>Open tonight ({openRooms.length})</strong>
                  <span className="tiny muted">Rooms nobody is in for the night of {fmtDate(date)}. Click one to check in.</span>
                </div>
                {openRooms.length === 0 ? <span className="muted">No rooms open. Sold out.</span> : (
                  <div className="open-rooms-list">
                    {openRooms.map((r) => (
                      <button key={r.id} type="button" className="open-room" title={`Check in to ${r.number}`}
                        onClick={() => navigate(`/check-in?room=${r.id}&date=${date}`)}>
                        <span className="room-chip">{r.number}</span>
                        <span className="tiny muted">{r.room_type} · {money(r.default_rate)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })()}

          <h2 className="section-title">Room sheet{mine && <span className="tiny muted"> · all clerks</span>}</h2>
          <div className="card no-pad report-sheet">
            {sheetData
              ? <RoomSheet report date={date} rooms={sheetData.rooms} stays={sheetData.staying} dayMoney={sheetData.day_money}
                  onPay={setPaying} onCheckout={setCheckingOut} onAddStay={setAdding} />
              : <Empty>Loading…</Empty>}
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
                  <thead><tr><th>Time</th><th>Room</th><th>Guest</th><th className="num">Guests</th><th className="num">Nights</th><th>Checkout</th><th className="num">Rate</th><th className="num">Total</th><th className="num">Cash</th><th className="num">Credit</th><th className="num">Other days</th><th className="num">Balance</th><th>Clerk</th></tr></thead>
                  <tbody>
                    {d.checkins.map((r) => (
                      <tr key={r.id} className="clickable" onClick={() => open(r.id)}>
                        <td>{fmtTime(r.time)}</td>
                        <td><span className="room-chip">{r.room_number}</span> <span className="tiny muted">{r.room_type}</span></td>
                        <td>{r.guest_name}{r.do_not_rent && <span className="pill pill-red ml">DNR</span>}</td>
                        <td className="num">{r.num_guests}</td>
                        <td className="num">{r.num_days}</td>
                        <td>{fmtDate(r.check_out_date)}</td>
                        <td className="num">{money(r.rate)}<span className="tiny muted">{rateTypeInfo(r.rate_type).short}</span></td>
                        <td className="num">{money(r.total)}</td>
                        <td className="num">{money(r.cash)}</td>
                        <td className="num">{money(r.credit)}</td>
                        <td className="num">
                          {num(r.paid_other_days) ? <span className="muted" title="Taken on another day; counted on that day">{money(r.paid_other_days)}</span> : <span className="muted">—</span>}
                          {num(r.balance) <= 0 && <div><span className="pill pill-green">Paid</span></div>}
                        </td>
                        <td className="num"><BalanceCell value={r.balance} /></td>
                        <td>{r.clerk}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr><td colSpan={7}>Total</td><td className="num">{money(d.money.booked)}</td>
                      <td className="num">{money(d.checkins.reduce((a, r) => a + num(r.cash), 0))}</td>
                      <td className="num">{money(d.checkins.reduce((a, r) => a + num(r.credit), 0))}</td>
                      <td className="num muted">{money(d.checkins.reduce((a, r) => a + num(r.paid_other_days), 0))}</td>
                      <td colSpan={2}></td></tr>
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
                      <tr key={p.id} className={`clickable ${p.type === 'Refund' ? 'refund-row' : ''}`} onClick={() => open(p.stay_id)}>
                        <td>{fmtDateTime(p.paid_at)}</td>
                        <td>{p.type}</td>
                        <td><span className={`pill ${p.method === 'CASH' ? 'pay-cash' : 'pay-credit'}`}>{p.method === 'CASH' ? 'Cash' : 'Credit'}</span></td>
                        <td className={`num ${p.type === 'Refund' ? '' : p.method === 'CASH' ? 'amt-cash' : 'amt-credit'}`}>{money(p.amount)}</td>
                        <td>{p.guest_name}</td>
                        <td>{p.room_number}</td>
                        <td>{fmtDate(p.check_in_date)}</td>
                        <td>{p.clerk}</td>
                      </tr>
                    ))}
                  </tbody>
                  <PaymentTotals payments={d.payments} m={d.money} />
                </table>
              </div>
            )}
          </div>

          {paying && <PaymentModal stay={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); reload() }} />}
          {checkingOut && <CheckoutModal stay={checkingOut} onClose={() => setCheckingOut(null)} onDone={reload} />}
          {expense && <ExpenseModal expense={expense} date={date} onClose={() => setExpense(null)} onSaved={() => { setExpense(null); reload() }} />}
          {adding && <AddStayModal stay={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); reload() }} />}

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


// Totals under "Payments received": payments, refunds, expenses and the net, split cash / credit.
// Net cash = Cash in drawer; it matches the Cash drawer cards and the Room sheet footer.
function PaymentTotals({ payments, m }) {
  const add = (rows, method) => rows.filter((p) => p.method === method).reduce((a, p) => a + num(p.amount), 0)
  const pays = payments.filter((p) => p.type !== 'Refund')
  const refunds = payments.filter((p) => p.type === 'Refund')
  const pc = add(pays, 'CASH'), pr = add(pays, 'CREDIT')
  const rc = add(refunds, 'CASH'), rr = add(refunds, 'CREDIT')
  const ec = -num(m.expenses_cash), er = -num(m.expenses_card)
  const split = (cash, credit) => (
    <td colSpan={4} className="pt-split">
      <span className="amt-cash">Cash {money(cash)}</span>
      <span className="amt-credit">Credit {money(credit)}</span>
    </td>
  )
  return (
    <tfoot className="pay-totals">
      <tr><td colSpan={3}>Payments ({pays.length})</td><td className="num">{money(pc + pr)}</td>{split(pc, pr)}</tr>
      {refunds.length > 0 && (
        <tr className="refund-row"><td colSpan={3}>Refunds ({refunds.length})</td><td className="num">{money(rc + rr)}</td>{split(rc, rr)}</tr>
      )}
      {(ec !== 0 || er !== 0) && (
        <tr className="pt-exp"><td colSpan={3}>Expenses<div className="tiny muted">Listed under Cash drawer</div></td><td className="num">{money(ec + er)}</td>{split(ec, er)}</tr>
      )}
      <tr className="pt-net">
        <td colSpan={3}>Net total<div className="tiny muted">Cash = Cash in drawer</div></td>
        <td className="num">{money(pc + pr + rc + rr + ec + er)}</td>{split(pc + rc + ec, pr + rr + er)}
      </tr>
    </tfoot>
  )
}

