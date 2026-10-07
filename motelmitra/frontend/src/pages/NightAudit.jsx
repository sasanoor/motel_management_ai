import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useOutletContext } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { Alert, Empty, Modal, PageHead, Stat } from '../components/ui'
import CheckoutModal from '../components/CheckoutModal'
import { addDays, fmtDateTime, fmtDay, fmtTime, money, num } from '../utils'
import { confirmBox } from '../confirm'

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
  const [dueOut, setDueOut] = useState(false)        // "guests not checked out" window before closing
  const [checkingOut, setCheckingOut] = useState(null)

  const loadPreview = () => api.get('/business-day/preview/').then((r) => { setD(r.data); setChangeTime(r.data.day_change_time); return r.data })
  useEffect(() => {
    loadPreview().catch((e) => setErr(errorText(e)))
    api.get('/business-day/history/').then((r) => setHistory(r.data)).catch(() => {})
  }, [])

  // Step 1: guests who should have left today are listed first, with a Check out button each.
  function startClose() {
    if (d.summary.still_due_out_guests?.length) setDueOut(true)
    else closeDay()
  }
  async function openCheckout(g) {
    try { const { data } = await api.get(`/stays/${g.stay_id}/`); setCheckingOut(data) } catch (e) { setErr(errorText(e)) }
  }

  async function closeDay() {
    setDueOut(false)
    const day = d.business_date
    const warn = []
    if (d.summary.still_due_out) warn.push(`${d.summary.still_due_out} guest(s) not checked out (room ${d.summary.still_due_out_rooms.join(', ')}): they stay in house`)
    if (d.summary.unpaid_checkins) warn.push(`${d.summary.unpaid_checkins} check-in(s) with ${money(d.summary.unpaid_amount)} unpaid`)
    const ok = await confirmBox({
      title: `Close ${fmtDay(day)}?`,
      message: `The new business day ${fmtDay(addDays(day, 1))} starts now. New check-ins and payments will count on the next day.` +
        (warn.length ? `\n\nStill open:\n• ${warn.join('\n• ')}` : ''),
      tone: 'primary', confirmText: 'Close day',
    })
    if (!ok) return
    setBusy(true); setErr('')
    try {
      const { data } = await api.post('/business-day/close/', { date: day })
      applyBiz(data.business_date)
      navigate('/night-audit', { replace: true, state: { msg: `${fmtDay(day)} closed. Business day is now ${fmtDay(data.business_date)}.` } })
    } catch (e) { setErr(errorText(e)); setBusy(false) }
  }

  async function reopen() {
    const last = d.last_close
    if (!(await confirmBox({
      title: `Reopen ${fmtDay(last.date)}?`,
      message: `Use this if the day was closed by mistake. The business day goes back to ${fmtDay(last.date)}. ` +
        'Payments and expenses entered after the close move back to that day.',
      details: [['Closed by', last.closed_by || '-'], ['Closed at', fmtDateTime(last.closed_at)]],
      tone: 'primary', confirmText: `Reopen ${fmtDay(last.date)}`,
    }))) return
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
  const lastClose = d.last_close
  const s = d.summary
  const next = addDays(d.business_date, 1)

  return (
    <>
      <PageHead title="Night Audit" sub="Close the business day. Check-ins and payments after closing count on the next day." />
      <Alert kind="success">{msg}</Alert>
      <Alert>{err}</Alert>

      {lastClose && lastClose.date === addDays(d.business_date, -1) && (
        <div className="card undo-close">
          <div>
            <strong>{fmtDay(lastClose.date)} was closed</strong>
            <span className="tiny muted"> {fmtDateTime(lastClose.closed_at)} by {lastClose.closed_by || 'unknown'}</span>
            <div className="tiny muted">
              {isAdmin ? 'Closed by mistake? Reopen it. Payments and expenses entered since then move back to that day.'
                : 'Closed by mistake? Ask the admin to reopen it from this page.'}
            </div>
          </div>
          {isAdmin && <button className="btn" onClick={reopen}>↩ Reopen {fmtDay(lastClose.date)}</button>}
        </div>
      )}

      <section className="card audit-card">
        <div className="audit-day">
          <span className="muted">Business day</span>
          <strong>{fmtDay(d.business_date)}</strong>
          <span className="tiny muted">
            Clock: {fmtDateTime(d.now)} · Changes on its own at {fmtTime(d.day_change_time)} if not closed
          </span>
        </div>
        <div className="audit-action">
          <button className="btn btn-primary btn-lg" onClick={startClose} disabled={busy || !d.can_close}>
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
        {Number(s.check) !== 0 && s.check !== undefined && <Stat label="Check" value={money(s.check)} />}
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
              <thead><tr><th>Business day</th><th>Closed at</th><th>Closed by</th><th className="num">Check-ins</th><th className="num">Cash</th><th className="num">Credit</th><th className="num">Check</th><th className="num">Refunds</th><th className="num">Collected</th><th></th></tr></thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={h.date}>
                    <td><strong>{fmtDay(h.date)}</strong></td>
                    <td>{fmtDateTime(h.closed_at)}</td>
                    <td>{h.closed_by}</td>
                    <td className="num">{h.summary.checkins}</td>
                    <td className="num">{money(h.summary.cash)}</td>
                    <td className="num">{money(h.summary.credit)}</td>
                    <td className="num">{num(h.summary.check) ? money(h.summary.check) : '—'}</td>
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

      {dueOut && d && (
        <Modal title={`${d.summary.still_due_out_guests.length} guest${d.summary.still_due_out_guests.length === 1 ? ' has' : 's have'} not checked out`} onClose={() => setDueOut(false)} width={680}>
          <Alert kind="info">These guests were due to leave on {fmtDay(d.business_date)} but are still checked in. Check them out now, or close the day and they stay in house.</Alert>
          {!d.summary.still_due_out_guests.length ? <Empty>Everyone due out has checked out. 🎉</Empty> : (
            <table className="table">
              <thead><tr><th>Room</th><th>Guest</th><th>Checkout time</th><th className="num">Balance</th><th></th></tr></thead>
              <tbody>
                {d.summary.still_due_out_guests.map((g) => (
                  <tr key={g.stay_id}>
                    <td><span className="room-chip">{g.room}</span></td>
                    <td><strong>{g.guest}</strong></td>
                    <td>{fmtTime(g.check_out_time)}</td>
                    <td className="num"><span className={num(g.balance) > 0 ? 'owed' : ''}>{money(g.balance)}</span></td>
                    <td className="row-actions"><button className="btn btn-sm btn-primary" onClick={() => openCheckout(g)}>Check out</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="form-actions">
            <button className="btn" onClick={() => setDueOut(false)}>Go back</button>
            <button className="btn btn-warn" onClick={closeDay}>
              {d.summary.still_due_out_guests.length ? `Close day anyway (${d.summary.still_due_out_guests.length} stay in house)` : 'Continue to close day'}
            </button>
          </div>
        </Modal>
      )}
      {checkingOut && (
        <CheckoutModal stay={checkingOut} onClose={() => setCheckingOut(null)}
          onDone={() => { setCheckingOut(null); loadPreview().catch(() => {}) }} />
      )}

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
