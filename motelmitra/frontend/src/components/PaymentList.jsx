import { useState } from 'react'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { confirmBox } from '../confirm'
import { fmtDate, fmtDateTime, methodInfo, money, num, todayISO } from '../utils'
import GridFilter from './GridFilter'
import { Alert, Modal } from './ui'

const TYPE = (p) => (p.kind === 'REFUND' ? 'Refund' : p.kind === 'STAYOVER' ? 'Stay-over payment' : p.is_initial ? 'At check-in' : 'Balance payment')

/**
 * Payments of one stay, with Edit / Delete for a payment typed wrong.
 * Admin: any payment. Clerk: own payments on the same business day (the server checks this too).
 * Every change is listed under "Payment changes" with who, when and why.
 */
export default function PaymentList({ stay, onChanged }) {
  const { user, isAdmin } = useAuth()
  const [edit, setEdit] = useState(null)
  const [err, setErr] = useState('')
  const [showLog, setShowLog] = useState(false)
  const canChange = (p) => isAdmin || (p.clerk === user.id && p.business_date === todayISO())

  async function remove(p) {
    const ok = await confirmBox({
      title: 'Delete this payment?',
      message: 'Use this only for a payment typed by mistake. The balance goes up by this amount. The change is logged with your name.',
      details: [['Type', TYPE(p)], ['Method', methodInfo(p.method).label], ['Amount', money(p.amount)], ['Taken', fmtDateTime(p.paid_at)]],
    })
    if (!ok) return
    try {
      const { data } = await api.delete(`/stays/${stay.id}/payments/${p.id}/`)
      setErr(''); onChanged(data)
    } catch (e) { setErr(errorText(e)) }
  }

  const changes = stay.payment_changes || []
  return (
    <>
      <Alert>{err}</Alert>
      {stay.payments.length > 0 && (
        <div className="table-wrap"><GridFilter />
          <table className="table">
            <thead><tr><th>Business day</th><th>Taken at</th><th>Type</th><th>Method</th><th className="num">Amount</th><th>Clerk</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {stay.payments.map((p) => (
                <tr key={p.id} className={p.kind === 'REFUND' ? 'refund-row' : ''}>
                  <td><strong>{fmtDate(p.business_date)}</strong></td>
                  <td className="tiny muted">{fmtDateTime(p.paid_at)}</td>
                  <td>{TYPE(p)}</td>
                  <td><span className={`pill ${methodInfo(p.method).pill}`}>{methodInfo(p.method).label}</span></td>
                  <td className="num">{money(p.amount)}</td>
                  <td>{p.clerk_name}</td>
                  <td>{p.notes}</td>
                  <td className="row-actions">
                    {canChange(p) && <>
                      <button type="button" className="btn btn-sm" onClick={() => setEdit(p)}>Edit</button>
                      <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => remove(p)}>Delete</button>
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {changes.length > 0 && (
        <div className="pay-log">
          <button type="button" className="link-btn" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Hide' : 'Show'} payment changes ({changes.length})
          </button>
          {showLog && (
            <table className="table">
              <thead><tr><th>When</th><th>By</th><th>Change</th><th>Reason</th></tr></thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.id}>
                    <td>{fmtDateTime(c.at)}</td>
                    <td>{c.by}</td>
                    <td>{c.action === 'DELETE'
                      ? <>Deleted {methodInfo(c.before.method).label} {money(Math.abs(num(c.before.amount)))} of {fmtDate(c.before.business_date)}</>
                      : <>{methodInfo(c.before.method).label} {money(Math.abs(num(c.before.amount)))} → {methodInfo(c.after.method).label} {money(Math.abs(num(c.after.amount)))}
                        {c.before.notes !== c.after.notes && <span className="tiny muted"> · note changed</span>}</>}
                    </td>
                    <td className="muted">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {edit && <EditPayment stay={stay} p={edit} onClose={() => setEdit(null)} onSaved={(d) => { setEdit(null); setErr(''); onChanged(d) }} />}
    </>
  )
}

function EditPayment({ stay, p, onClose, onSaved }) {
  const refund = p.kind === 'REFUND'
  const [f, setF] = useState({ amount: Math.abs(num(p.amount)).toFixed(2), method: p.method, notes: p.notes || '', reason: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(e) {
    e.preventDefault()
    e.stopPropagation()   // may sit inside the check-in form: do not submit that one
    setBusy(true); setErr('')
    try {
      const { data } = await api.patch(`/stays/${stay.id}/payments/${p.id}/`, f)
      onSaved(data)
    } catch (e2) { setErr(errorText(e2)); setBusy(false) }
  }
  return (
    <Modal title={`Edit ${refund ? 'refund' : 'payment'} · ${fmtDate(p.business_date)}`} onClose={onClose} width={520}>
      <Alert>{err}</Alert>
      <form onSubmit={save} className="form-grid cols-2">
        <label>{refund ? 'Refund amount' : 'Amount'}
          <input type="number" step="0.01" min="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} required autoFocus />
          <span className="hint">Was {money(Math.abs(num(p.amount)))}</span>
        </label>
        <div className="field">
          <span className="field-label">Method</span>
          <div className="seg">
            {['CASH', 'CREDIT', 'CHECK'].map((m) => (
              <button type="button" key={m} className={f.method === m ? 'on' : ''} onClick={() => setF({ ...f, method: m })}>{methodInfo(m).label}</button>
            ))}
          </div>
        </div>
        <label className="span-2">Notes
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <label className="span-2">Reason for the change
          <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. Typed 50 instead of 70" />
        </label>
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save change'}</button>
        </div>
      </form>
    </Modal>
  )
}
