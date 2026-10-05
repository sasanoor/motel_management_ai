import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { Alert, Empty, PageHead, Stat } from '../components/ui'
import { addDays, fmtDateTime, fmtDay, fmtTime, money, num } from '../utils'

/**
 * Night Audit: close the business day. The next day starts right away, so new check-ins
 * and payments count on the next day. Without it the day changes at the motel's day change time.
 */
export default function NightAudit() {
  const { isAdmin } = useAuth()
  const { applyBiz } = useOutletContext()
  const navigate = useNavigate()
  const location = useLocation()
  const [d, setD] = useState(null)
  const [history, setHistory] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [changeTime, setChangeTime] = useState('')
  const [saved, setMsg] = useState('')
  const msg = saved || location.state?.msg || ''

  useEffect(() => {
    api.get('/business-day/preview/').then((r) => { setD(r.data); setChangeTime(r.data.day_change_time) }).catch((e) => setErr(errorText(e)))
    api.get('/business-day/history/').then((r) => setHistory(r.data)).catch(() => {})
  }, [])

  async function closeDay() {
    const day = d.business_date
    const warn = []
    if (d.summary.still_due_out) warn.push(`${d.summary.still_due_out} guest(s) still due out (room ${d.summary.still_due_out_rooms.join(', ')})`)
    if (d.summary.unpaid_checkins) warn.push(`${d.summary.unpaid_checkins} check-in(s) with ${money(d.summary.unpaid_amount)} unpaid`)
    const text = `Close ${fmtDay(day)} and start ${fmtDay(addDays(day, 1))}?` +
      (warn.length ? `\n\nStill open:\n• ${warn.join('\n• ')}` : '') +
      '\n\nNew check-ins and payments will count on the next day.'
    if (!window.confirm(text)) return
    setBusy(true); setErr('')
    try {
      const { data } = await api.post('/business-day/close/', { date: day })
      applyBiz(data.business_date)
      navigate('/night-audit', { replace: true, state: { msg: `${fmtDay(day)} closed. Business day is now ${fmtDay(data.business_date)}.` } })
    } catch (e) { setErr(errorText(e)); setBusy(false) }
  }

  async function reopen() {
    const last = d.last_close
    if (!window.confirm(`Reopen ${fmtDay(last.date)}? The business day goes back to ${fmtDay(last.date)}.`)) return
    try {
      const { data } = await api.post('/business-day/reopen/')
      applyBiz(data.business_date)
      navigate('/night-audit', { replace: true, state: { msg: `${fmtDay(last.date)} reopened. ${data.note || ''}` } })
    } catch (e) { setErr(errorText(e)) }
  }

  async function saveTime(e) {
    e.preventDefault()
    try {
      await api.patch('/settings/', { day_change_time: changeTime })
      const r = await api.get('/business-day/preview/')
      setD(r.data)
      setMsg(`Saved. The day now changes automatically at ${fmtTime(changeTime)}.`)
      if (r.data.business_date !== d.business_date) {
        applyBiz(r.data.business_date)
        navigate('/night-audit', { replace: true, state: { msg: `Saved. Business day is now ${fmtDay(r.data.business_date)}.` } })
      }
    } catch (e2) { setErr(errorText(e2)) }
  }

  if (!d) return <Alert>{err}</Alert>
  const s = d.summary
  const next = addDays(d.business_date, 1)

  return (
    <>
      <PageHead title="Night Audit" sub="Close the business day. Check-ins and payments after closing count on the next day." />
      <Alert kind="success">{msg}</Alert>
      <Alert>{err}</Alert>

      <section className="card audit-card">
        <div className="audit-day">
          <span className="muted">Business day</span>
          <strong>{fmtDay(d.business_date)}</strong>
          <span className="tiny muted">
            Clock: {fmtDateTime(d.now)} · Changes on its own at {fmtTime(d.day_change_time)} if not closed
          </span>
        </div>
        <div className="audit-action">
          <button className="btn btn-primary btn-lg" onClick={closeDay} disabled={busy || !d.can_close}>
            {busy ? 'Closing…' : `Close ${fmtDay(d.business_date)} & start ${fmtDay(next)}`}
          </button>
          {!d.can_close && <span className="tiny muted">{fmtDay(d.business_date)} has not started yet, so it cannot be closed.</span>}
        </div>
      </section>

      <h2 className="section-title">{fmtDay(d.business_date)} so far</h2>
      <div className="stats">
        <Stat label="Check-ins" value={s.checkins} onClick={() => navigate(`/today?date=${d.business_date}`)} />
        <Stat label="Checked out" value={s.checkouts_done} />
        <Stat label="Still due out" value={s.still_due_out} tone={s.still_due_out ? 'bad' : ''} onClick={s.still_due_out ? () => navigate('/') : undefined} />
        <Stat label="Occupied" value={`${s.occupied} / ${s.total_rooms}`} />
        <Stat label="Cash" value={money(s.cash)} tone="good" />
        <Stat label="Credit" value={money(s.credit)} />
        {num(s.refunds) > 0 && <Stat label="Refunds (included)" value={money(s.refunds)} tone="bad" />}
        <Stat label="Total collected" value={money(s.collected)} tone="good" />
        <Stat label="Unpaid check-ins" value={s.unpaid_checkins ? `${s.unpaid_checkins} · ${money(s.unpaid_amount)}` : 0} tone={s.unpaid_checkins ? 'bad' : ''} />
      </div>
      {(s.still_due_out > 0 || s.unpaid_checkins > 0) && (
        <Alert kind="info">
          You can still close the day. {s.still_due_out > 0 && <>Guests not checked out (room {s.still_due_out_rooms.join(', ')}) stay in house. </>}
          {s.unpaid_checkins > 0 && <>Unpaid balances stay in Balance Payments.</>}
        </Alert>
      )}

      <h2 className="section-title">Closed days</h2>
      <div className="card no-pad">
        {!history.length ? <Empty>No days closed yet.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Business day</th><th>Closed at</th><th>Closed by</th><th className="num">Check-ins</th><th className="num">Cash</th><th className="num">Credit</th><th className="num">Refunds</th><th className="num">Collected</th><th></th></tr></thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.date}>
                    <td><strong>{fmtDay(h.date)}</strong></td>
                    <td>{fmtDateTime(h.closed_at)}</td>
                    <td>{h.closed_by}</td>
                    <td className="num">{h.summary.checkins}</td>
                    <td className="num">{money(h.summary.cash)}</td>
                    <td className="num">{money(h.summary.credit)}</td>
                    <td className="num">{num(h.summary.refunds) ? money(h.summary.refunds) : '—'}</td>
                    <td className="num"><strong>{money(h.summary.collected)}</strong></td>
                    <td className="row-actions">
                      <Link className="btn btn-sm" to={`/today?date=${h.date}`}>Report</Link>
                      {isAdmin && i === 0 && <button className="btn btn-sm" onClick={reopen}>Reopen</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="tiny muted">Totals are as at closing. Payments are always counted on the business day they were taken.</p>

      {isAdmin && (
        <form className="card settings-card audit-setting" onSubmit={saveTime}>
          <label>Business day changes on its own at
            <input type="time" value={changeTime} onChange={(e) => setChangeTime(e.target.value)} required />
            <span className="hint">If nobody runs Night Audit, the next day starts at this time. Use 12:00 AM for midnight.</span>
          </label>
          <div className="form-actions"><button className="btn">Save</button></div>
        </form>
      )}
    </>
  )
}
