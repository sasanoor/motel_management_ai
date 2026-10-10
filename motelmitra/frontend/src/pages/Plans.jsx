import { useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { confirmBox } from '../confirm'
import { Alert, Empty, Modal, PageHead } from '../components/ui'
import { fmtDate, money, todayISO } from '../utils'
import GridFilter from '../components/GridFilter'

/* MotelMitra subscriptions.
 * Super admin: Plans (name, months, price) and, on Clients, a plan per motel.
 * Client admin: My Plan. Everyone at the motel: warning popup in the last days; after the end date
 * client users cannot use MotelMitra and the client admin only sees the "plan ended" screen. */

const monthsText = (m) => (m === 12 ? '1 year' : m % 12 === 0 ? `${m / 12} years` : `${m} month${m > 1 ? 's' : ''}`)

export function PlanPill({ plan }) {
  if (!plan || plan.status === 'none') return <span className="pill pill-grey">No plan</span>
  if (plan.status === 'expired') return <span className="pill pill-red">Expired {fmtDate(plan.paid_until)}</span>
  if (plan.status === 'expiring') return <span className="pill pill-warn">Ends in {plan.days_left} day{plan.days_left === 1 ? '' : 's'}</span>
  return <span className="pill pill-green">Active</span>
}

function daysText(n) {
  if (n <= 0) return 'today'
  return `in ${n} day${n === 1 ? '' : 's'}`
}

/** Popup in the last days of the plan (once per login session). */
export function PlanWarning({ plan, isAdmin, onClose }) {
  return (
    <Modal title="MotelMitra plan ending soon" onClose={onClose} width={480}>
      <div className="plan-warn">
        <div className="plan-warn-icon">⏳</div>
        <div>
          <p>Your <strong>{plan.plan_name}</strong> plan ends <strong>{daysText(plan.days_left)}</strong>, on <strong>{fmtDate(plan.paid_until)}</strong>.</p>
          <p className="muted">After that date your staff cannot open MotelMitra until the plan is renewed.
            {isAdmin ? ' Contact MotelMitra to renew.' : ' Please tell the motel owner.'}</p>
        </div>
      </div>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={onClose}>OK, got it</button>
      </div>
    </Modal>
  )
}

/** Shown instead of every page to the client admin once the plan has ended. */
export function PlanExpiredScreen({ plan }) {
  return (
    <div className="plan-expired card">
      <div className="plan-expired-icon">🔒</div>
      <h1>Your MotelMitra plan has ended</h1>
      <p>The <strong>{plan.plan_name}</strong> plan ended on <strong>{fmtDate(plan.paid_until)}</strong>.</p>
      <p className="muted">Your staff cannot log in until the plan is renewed. Your guests, payments and reports are kept safe.
        Contact MotelMitra to renew; the app opens again as soon as the new plan is added.</p>
    </div>
  )
}

function PlanCard({ plan }) {
  if (!plan || plan.status === 'none') return <div className="card"><Empty>No plan on record. Contact MotelMitra to set one up.</Empty></div>
  return (
    <div className={`card plan-card plan-${plan.status}`}>
      <div className="plan-card-top">
        <div>
          <div className="tiny muted">Current plan</div>
          <div className="plan-name">{plan.plan_name}</div>
        </div>
        <PlanPill plan={plan} />
      </div>
      <div className="plan-facts">
        <div><span>Started</span><strong>{fmtDate(plan.start_date)}</strong></div>
        <div><span>Paid until</span><strong>{fmtDate(plan.paid_until)}</strong></div>
        <div><span>{plan.status === 'expired' ? 'Ended' : 'Days left'}</span><strong>{plan.status === 'expired' ? `${-plan.days_left} days ago` : plan.days_left}</strong></div>
        <div><span>Price</span><strong>{money(plan.price)}</strong></div>
      </div>
    </div>
  )
}

function History({ rows, onDelete }) {
  if (!rows?.length) return null
  return (
    <div className="table-wrap"><GridFilter />
      <table className="table">
        <thead><tr><th>Plan</th><th>From</th><th>To</th><th className="num">Price</th><th>Notes</th><th>Added by</th>{onDelete && <th></th>}</tr></thead>
        <tbody>
          {rows.map((h) => (
            <tr key={h.id}>
              <td><strong>{h.plan_name}</strong><div className="tiny muted">{monthsText(h.months)}</div></td>
              <td>{fmtDate(h.start_date)}</td>
              <td>{fmtDate(h.end_date)}</td>
              <td className="num">{money(h.price)}</td>
              <td className="muted">{h.notes}</td>
              <td>{h.created_by_name}</td>
              {onDelete && <td className="row-actions"><button className="btn btn-sm btn-danger-outline" onClick={() => onDelete(h)}>Remove</button></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Client admin: My Plan */
export function MyPlan() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.get('/subscription/').then((r) => setData(r.data)).catch((e) => setErr(errorText(e))) }, [])
  return (
    <>
      <PageHead title="My Plan" sub="Your MotelMitra subscription. Contact MotelMitra to renew or change it." />
      <Alert>{err}</Alert>
      {data && <>
        <PlanCard plan={data.plan} />
        {data.history.length > 0 && <>
          <h2 className="section-title">Plan history</h2>
          <div className="card no-pad"><History rows={data.history} /></div>
        </>}
      </>}
    </>
  )
}

/** Super admin: plans and prices */
export function Plans() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [edit, setEdit] = useState(null)
  const load = () => api.get('/plans/').then((r) => setRows(r.data)).catch((e) => setErr(errorText(e)))
  useEffect(() => { load() }, [])
  async function save(e) {
    e.preventDefault()
    setErr('')
    try {
      if (edit.id) await api.patch(`/plans/${edit.id}/`, edit)
      else await api.post('/plans/', edit)
      setEdit(null); load()
    } catch (e2) { setErr(errorText(e2)) }
  }
  return (
    <>
      <PageHead title="Plans" sub="Subscription plans you sell to motels. Changing a price does not change plans already sold.">
        <button className="btn btn-primary" onClick={() => setEdit({ name: '', months: 1, price: '', is_active: true })}>+ New plan</button>
      </PageHead>
      <Alert>{err}</Alert>
      <div className="plan-grid">
        {rows?.map((p) => (
          <div key={p.id} className={`card plan-offer ${p.is_active ? '' : 'off'}`}>
            <div className="tiny muted">{monthsText(p.months)}</div>
            <div className="plan-name">{p.name}</div>
            <div className="plan-price">{money(p.price)}</div>
            <div className="tiny muted">{money(p.price / p.months)} per month</div>
            {!p.is_active && <span className="pill pill-grey">Not offered</span>}
            <button className="btn btn-sm" onClick={() => setEdit(p)}>Edit</button>
          </div>
        ))}
      </div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New plan'} onClose={() => setEdit(null)} width={440}>
          <form onSubmit={save} className="form-grid">
            <label>Plan name<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} required /></label>
            <label>Months<input type="number" min="1" max="60" value={edit.months} onChange={(e) => setEdit({ ...edit, months: e.target.value })} required /></label>
            <label>Price ($)<input type="number" min="0" step="0.01" value={edit.price} onChange={(e) => setEdit({ ...edit, price: e.target.value })} required /></label>
            <label className="check-line"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> <span>Offer this plan</span></label>
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary">Save</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

/** Super admin, Clients screen: add / renew a motel's plan */
export function SubscriptionModal({ client, onClose, onChanged }) {
  const [data, setData] = useState(null)
  const [plans, setPlans] = useState([])
  const [f, setF] = useState({ plan: '', start_date: '', price: '', notes: '' })
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const url = `/clients/${client.id}/subscriptions/`
  useEffect(() => {
    api.get(url).then((r) => setData(r.data)).catch((e) => setErr(errorText(e)))
    api.get('/plans/').then((r) => setPlans(r.data.filter((p) => p.is_active))).catch(() => {})
  }, [url])
  const plan = plans.find((p) => String(p.id) === String(f.plan))
  const st = data?.plan
  const renewing = st && (st.status === 'active' || st.status === 'expiring')
  // what the server will use when the start date is left empty
  const autoStart = renewing ? addDay(st.paid_until) : todayISO()

  async function add(e) {
    e.preventDefault()
    if (!f.plan) { setErr('Pick a plan.'); return }
    setBusy(true); setErr('')
    try {
      const { data: d } = await api.post(url, { ...f, price: f.price === '' ? plan?.price : f.price })
      setData(d); setF({ plan: '', start_date: '', price: '', notes: '' }); onChanged()
    } catch (e2) { setErr(errorText(e2)) }
    setBusy(false)
  }
  async function remove(h) {
    const ok = await confirmBox({ title: 'Remove this plan?', message: 'Use this only for a plan added by mistake.',
      details: [['Plan', h.plan_name], ['Dates', `${fmtDate(h.start_date)} to ${fmtDate(h.end_date)}`], ['Price', money(h.price)]], confirmText: 'Remove' })
    if (!ok) return
    try { const { data: d } = await api.delete(`${url}${h.id}/`); setData(d); onChanged() } catch (e2) { setErr(errorText(e2)) }
  }

  return (
    <Modal title={`${client.name}: plan`} onClose={onClose} width={820}>
      <Alert>{err}</Alert>
      {data && <PlanCard plan={st} />}
      <form onSubmit={add} className="card sub-form">
        <h3>{renewing ? 'Renew / add next plan' : 'Add plan'}</h3>
        <div className="form-grid cols-4">
          <label>Plan
            <select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value, price: '' })} required>
              <option value="">Pick plan…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price)}</option>)}
            </select>
          </label>
          <label>Starts
            <input type="date" value={f.start_date || autoStart} onChange={(e) => setF({ ...f, start_date: e.target.value })} />
            <span className="hint">{renewing ? 'Day after the current plan ends' : 'Today'}</span>
          </label>
          <label>Price ($)
            <input type="number" min="0" step="0.01" value={f.price === '' ? (plan?.price ?? '') : f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
            <span className="hint">Change for a discount</span>
          </label>
          <div className="readout">
            <span>Ends</span>
            <strong>{plan ? fmtDate(endFor(f.start_date || autoStart, plan.months)) : '—'}</strong>
          </div>
          <label className="span-4">Notes
            <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="e.g. Paid by Zelle, invoice #12" />
          </label>
        </div>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary" disabled={busy || !f.plan}>{busy ? 'Saving…' : renewing ? 'Add next plan' : 'Add plan'}</button>
        </div>
      </form>
      {data?.history?.length > 0 && <>
        <h3 className="section-title">History</h3>
        <History rows={data.history} onDelete={remove} />
      </>}
    </Modal>
  )
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function addDay(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number)
  return iso(new Date(y, m - 1, d + 1))
}

// same rule as the server: 1 month from 10/06 runs to 11/05
function endFor(startIso, months) {
  const [y, m, d] = startIso.split('-').map(Number)
  const target = new Date(y, m - 1 + months, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  const end = new Date(target.getFullYear(), target.getMonth(), Math.min(d, last))
  end.setDate(end.getDate() - 1)
  return iso(end)
}
