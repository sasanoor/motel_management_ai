import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import AddStayModal from '../components/AddStayModal'
import CheckoutModal from '../components/CheckoutModal'
import { PhotoGallery } from '../components/Photos'
import { Alert, BalanceCell, PageHead, PaymentModal, RefundModal, StatusPill } from '../components/ui'
import { fmtDate, fmtDateTime, fmtTime, money, num, periodText, rateTypeInfo } from '../utils'

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
  const [checkingOut, setCheckingOut] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const [adding, setAdding] = useState(false)

  const [photos, setPhotos] = useState([])
  const load = useCallback(() => {
    api.get(`/stays/${id}/`).then((r) => setS(r.data)).catch((e) => setErr(errorText(e)))
    api.get('/photos/', { params: { stay: id } }).then((r) => setPhotos(r.data)).catch(() => {})
  }, [id])

  async function deletePhoto(p) {
    if (!window.confirm(`Delete this ${p.kind_label} photo?`)) return
    try { await api.delete(`/photos/${p.id}/`); setPhotos((l) => l.filter((x) => x.id !== p.id)) } catch (e) { setErr(errorText(e)) }
  }
  useEffect(() => { load() }, [load])

  async function act(path, confirmText, body = {}) {
    if (confirmText && !window.confirm(confirmText)) return
    try {
      const { data } = await api.post(`/stays/${id}/${path}/`, body)
      setS(data)
      setErr('')
    } catch (e) {
      // undoing an early checkout after the room was rented again: ask, then force
      if (path === 'reopen' && e.response?.data?.overlap && window.confirm(e.response.data.overlap)) {
        return act('reopen', null, { force: true })
      }
      setErr(errorText(e))
    }
  }

  const undoText = (st) => st.early
    ? `Undo early checkout? Booked dates (to ${fmtDate(st.early.original_check_out_date)}) and the full charge come back.` +
      (num(st.refunded) > 0 ? ` The ${money(st.refunded)} refund stays on record, so the guest will owe it again.` : '')
    : 'Mark this guest as in house again?'

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
          ? <><button className="btn btn-add" onClick={() => setAdding(true)}>+ Add stay</button><button className="btn" onClick={() => setCheckingOut(true)}>Check out</button></>
          : <button className="btn" onClick={() => act('reopen', undoText(s))}>Undo checkout</button>}
        {num(s.balance) < 0 && <button className="btn btn-warn" onClick={() => setRefunding(true)}>Refund {money(-num(s.balance))}</button>}
        <button className="btn" onClick={toggleDnr}>{g.do_not_rent ? 'Remove DNR flag' : 'Flag Do Not Rent'}</button>
        {isAdmin && <button className="btn btn-danger-outline" onClick={remove}>Delete</button>}
      </div>

      {s.early && (
        <div className="alert alert-info early-note">
          <strong>Early checkout.</strong> Booked to {fmtDate(s.early.original_check_out_date)} ({s.early.original_nights} nights,
          total {money(s.early.original_total)}); left {fmtDate(s.check_out_date)} after {s.num_days} night{s.num_days > 1 ? 's' : ''}.
          {' '}New total {money(s.total_amount)}{num(s.refunded) > 0 && <>, refunded {money(s.refunded)}</>}.
        </div>
      )}

      <div className="grid-2">
        <section className="card">
          <h2>Stay</h2>
          <Row k="Room" v={`${s.room_number} (${s.room_type})`} />
          <Row k="Check-in" v={`${fmtDate(s.check_in_date)} ${fmtTime(s.check_in_time)}`} />
          <Row k="Checkout" v={`${fmtDate(s.check_out_date)} ${fmtTime(s.check_out_time)}`} />
          <Row k="Rent by" v={rateTypeInfo(s.rate_type).label} />
          <Row k="No. of days" v={s.rate_type === 'DAILY' ? s.num_days : `${s.num_days} (${periodText(s.periods, s.rate_type)})`} />
          <Row k="No. of guests" v={s.num_guests} />
          <Row k="Clerk" v={s.clerk_name} />
          {s.renewed_from && <Row k="Continued from" v={<Link to={`/stays/${s.renewed_from}`}>Previous stay #{s.renewed_from}</Link>} />}
          {s.renewed_to && <Row k="Continued in" v={<Link to={`/stays/${s.renewed_to}`}>Next stay #{s.renewed_to}</Link>} />}
          {s.checked_out_at && <Row k="Checked out at" v={fmtDateTime(s.checked_out_at)} />}
          <Row k="Comments" v={s.comments} />
        </section>
        <section className="card">
          <h2>Guest</h2>
          <Row k="Phone" v={g.phone} />
          <Row k="Address" v={[g.address, g.city, g.state, g.zip_code].filter(Boolean).join(', ')} />
          <Row k="Car" v={g.car} />
          <Row k="License plate" v={g.license_plate} />
          <Row k="DL number" v={g.dl_number} />
          <Row k="Previous stays" v={g.stay_count} />
          <Row k="Do not rent" v={g.do_not_rent ? 'Yes' : 'No'} />
        </section>
      </div>

      <section className="card">
        <h2>Photos <span className="tiny muted">· DL photos: Edit to replace · damage photos: added at checkout</span></h2>
        <PhotoGallery photos={photos} onDelete={deletePhoto} />
      </section>

      <section className="card">
        <h2>Payments</h2>
        <div className="pay-summary">
          {s.early ? (
            <div><span>Room charge ({s.num_days} night{s.num_days > 1 ? 's' : ''} used)</span><strong>{money(s.room_charge)}</strong></div>
          ) : (
            <div><span>Rate ({rateTypeInfo(s.rate_type).label.toLowerCase()})</span><strong>{money(s.rate)} × {periodText(s.periods, s.rate_type)}</strong></div>
          )}
          {num(s.pet_fee) > 0 && <div><span>Pets ({s.pets})</span><strong>{money(s.pet_fee)}</strong></div>}
          {num(s.extra_person_fee) > 0 && <div><span>Extra persons ({s.extra_persons})</span><strong>{money(s.extra_person_fee)}</strong></div>}
          {num(s.card_fee) > 0 && <div><span>Card fee</span><strong>{money(s.card_fee)}</strong></div>}
          {num(s.late_fee) > 0 && <div><span>Late fee</span><strong>{money(s.late_fee)}</strong></div>}
          {num(s.early_checkin_fee) > 0 && <div><span>Early check-in fee</span><strong>{money(s.early_checkin_fee)}</strong></div>}
          {num(s.adjustment) !== 0 && (
            <div><span>{num(s.adjustment) > 0 ? 'Extra charge' : 'Discount'}</span><strong>{money(Math.abs(num(s.adjustment)))}</strong></div>
          )}
          <div><span>Total</span><strong>{money(s.total_amount)}</strong></div>
          <div><span>Cash</span><strong>{money(s.cash_paid)}</strong></div>
          <div><span>Credit</span><strong>{money(s.credit_paid)}</strong></div>
          {num(s.refunded) > 0 && <div><span>Refunded (in cash / credit above)</span><strong>{money(s.refunded)}</strong></div>}
          <div><span>Balance</span><strong><BalanceCell value={s.balance} /></strong></div>
        </div>
        {s.payments.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Business day</th><th>Taken at</th><th>Type</th><th>Method</th><th className="num">Amount</th><th>Clerk</th><th>Notes</th></tr></thead>
              <tbody>
                {s.payments.map((p) => (
                  <tr key={p.id} className={p.kind === 'REFUND' ? 'refund-row' : ''}>
                    <td><strong>{fmtDate(p.business_date)}</strong></td>
                    <td className="tiny muted">{fmtDateTime(p.paid_at)}</td>
                    <td>{p.kind === 'REFUND' ? 'Refund' : p.is_initial ? 'At check-in' : 'Balance payment'}</td>
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

      {checkingOut && <CheckoutModal stay={s} onClose={() => setCheckingOut(false)} onDone={load} />}
      {adding && <AddStayModal stay={s} onClose={() => setAdding(false)} onSaved={(d) => { setS(d); setAdding(false) }} />}
      {refunding && <RefundModal stay={s} onClose={() => setRefunding(false)} onSaved={(d) => { setS(d); setRefunding(false) }} />}
      {paying && <PaymentModal stay={s} onClose={() => setPaying(false)} onSaved={(d) => { setS(d); setPaying(false) }} />}
    </>
  )
}
