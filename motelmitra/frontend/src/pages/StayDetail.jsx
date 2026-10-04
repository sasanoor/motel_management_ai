import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { Alert, BalanceCell, PageHead, PaymentModal, StatusPill } from '../components/ui'
import { fmtDate, fmtDateTime, fmtTime, money, num } from '../utils'

function Row({ k, v }) {
  return <div className="kv"><span>{k}</span><strong>{v || '—'}</strong></div>
}

export default function StayDetail() {
  const { id } = useParams()
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const [s, setS] = useState(null)
  const [err, setErr] = useState('')
  const [paying, setPaying] = useState(false)

  const load = useCallback(() => {
    api.get(`/stays/${id}/`).then((r) => setS(r.data)).catch((e) => setErr(errorText(e)))
  }, [id])
  useEffect(() => { load() }, [load])

  async function act(path, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return
    try {
      const { data } = await api.post(`/stays/${id}/${path}/`)
      setS(data)
    } catch (e) { setErr(errorText(e)) }
  }

  async function remove() {
    if (!window.confirm('Delete this guest record? You can recover it from Deleted Guests.')) return
    try {
      await api.delete(`/stays/${id}/`)
      navigate('/stays')
    } catch (e) { setErr(errorText(e)) }
  }

  async function toggleDnr() {
    const next = !s.guest.do_not_rent
    if (!window.confirm(next ? `Flag ${s.guest.name} as Do Not Rent?` : `Remove Do Not Rent flag from ${s.guest.name}?`)) return
    try {
      await api.patch(`/guests/${s.guest.id}/`, { do_not_rent: next })
      load()
    } catch (e) { setErr(errorText(e)) }
  }

  if (!s) return <Alert>{err}</Alert>
  const g = s.guest

  return (
    <>
      <PageHead title={g.name} sub={`Room ${s.room_number} · ${s.room_type}`}>
        <StatusPill stay={s} />
        {g.do_not_rent && <span className="pill pill-red">Do Not Rent</span>}
      </PageHead>
      <Alert>{err}</Alert>

      <div className="toolbar">
        {num(s.balance) > 0 && <button className="btn btn-warn" onClick={() => setPaying(true)}>Take payment</button>}
        <Link className="btn" to={`/stays/${s.id}/edit`}>Edit</Link>
        {s.status === 'CHECKED_IN'
          ? <button className="btn" onClick={() => act('checkout', `Check out ${g.name}?`)}>Check out</button>
          : <button className="btn" onClick={() => act('reopen', 'Mark this guest as in house again?')}>Undo checkout</button>}
        <button className="btn" onClick={toggleDnr}>{g.do_not_rent ? 'Remove DNR flag' : 'Flag Do Not Rent'}</button>
        {isAdmin && <button className="btn btn-danger-outline" onClick={remove}>Delete</button>}
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Stay</h2>
          <Row k="Room" v={`${s.room_number} (${s.room_type})`} />
          <Row k="Check-in" v={`${fmtDate(s.check_in_date)} ${fmtTime(s.check_in_time)}`} />
          <Row k="Checkout" v={`${fmtDate(s.check_out_date)} ${fmtTime(s.check_out_time)}`} />
          <Row k="No. of days" v={s.num_days} />
          <Row k="No. of guests" v={s.num_guests} />
          <Row k="Clerk" v={s.clerk_name} />
          {s.checked_out_at && <Row k="Checked out at" v={fmtDateTime(s.checked_out_at)} />}
          <Row k="Comments" v={s.comments} />
        </section>
        <section className="card">
          <h2>Guest</h2>
          <Row k="Phone" v={g.phone} />
          <Row k="Address" v={[g.address, g.city, g.state, g.zip_code].filter(Boolean).join(', ')} />
          <Row k="Car" v={g.car} />
          <Row k="License plate" v={g.license_plate} />
          <Row k="Previous stays" v={g.stay_count} />
          <Row k="Do not rent" v={g.do_not_rent ? 'Yes' : 'No'} />
        </section>
      </div>

      <section className="card">
        <h2>Payments</h2>
        <div className="pay-summary">
          <div><span>Rate</span><strong>{money(s.rate)} × {s.num_days}</strong></div>
          {num(s.adjustment) !== 0 && (
            <div><span>{num(s.adjustment) > 0 ? 'Extra charge' : 'Discount'}</span><strong>{money(Math.abs(num(s.adjustment)))}</strong></div>
          )}
          <div><span>Total</span><strong>{money(s.total_amount)}</strong></div>
          <div><span>Cash</span><strong>{money(s.cash_paid)}</strong></div>
          <div><span>Credit</span><strong>{money(s.credit_paid)}</strong></div>
          <div><span>Balance</span><strong><BalanceCell value={s.balance} /></strong></div>
        </div>
        {s.payments.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Type</th><th>Method</th><th className="num">Amount</th><th>Clerk</th><th>Notes</th></tr></thead>
              <tbody>
                {s.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDateTime(p.paid_at)}</td>
                    <td>{p.is_initial ? 'At check-in' : 'Balance payment'}</td>
                    <td>{p.method === 'CASH' ? 'Cash' : 'Credit'}</td>
                    <td className="num">{money(p.amount)}</td>
                    <td>{p.clerk_name}</td>
                    <td>{p.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {paying && <PaymentModal stay={s} onClose={() => setPaying(false)} onSaved={(d) => { setS(d); setPaying(false) }} />}
    </>
  )
}
