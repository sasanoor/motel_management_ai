import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import AddStayModal from '../components/AddStayModal'
import CheckoutModal from '../components/CheckoutModal'
import { AuthImage, PhotoGallery } from '../components/Photos'
import { Alert, BalanceCell, PageHead, PaymentModal, RefundModal, StatusPill } from '../components/ui'
import { fmtDate, fmtDateTime, fmtTime, money, num, periodText, rateTypeInfo } from '../utils'
import { confirmBox } from '../confirm'
import PaymentList from '../components/PaymentList'

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
    if (!(await confirmBox({ title: 'Delete photo?', message: `This ${p.kind_label} photo will be removed.` }))) return
    try { await api.delete(`/photos/${p.id}/`); setPhotos((l) => l.filter((x) => x.id !== p.id)) } catch (e) { setErr(errorText(e)) }
  }
  useEffect(() => { load() }, [load])

  async function act(path, confirmText, body = {}) {
    if (confirmText && !(await confirmBox({ title: 'Undo checkout?', message: confirmText, tone: 'primary', confirmText: 'Undo checkout' }))) return
    try {
      const { data } = await api.post(`/stays/${id}/${path}/`, body)
      setS(data)
      setErr('')
    } catch (e) {
      // undoing an early checkout after the room was rented again: ask, then force
      if (path === 'reopen' && e.response?.data?.overlap && await confirmBox({ title: 'Room already rented', message: e.response.data.overlap, confirmText: 'Undo anyway' })) {
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
    const ok = await confirmBox({
      title: 'Delete this check-in?',
      message: `Use this for a check-in made by mistake.${s.status === 'CHECKED_IN' ? ` Room ${s.room_number} becomes free.` : ''}`
        + `${num(s.amount_paid) !== 0 ? ` Its ${money(s.amount_paid)} in payments is taken out of the reports and cash drawer.` : ''}`
        + ' You can recover it from Deleted Guests.',
      details: [['Guest', s.guest.name], ['Room', s.room_number], ['Stay', `${fmtDate(s.check_in_date)} to ${fmtDate(s.check_out_date)}`], ['Paid', money(s.amount_paid)]],
    })
    if (!ok) return
    try {
      await api.delete(`/stays/${id}/`)
      navigate('/stays')
    } catch (e) { setErr(errorText(e)) }
  }

  async function toggleDnr() {
    const next = !s.guest.do_not_rent
    const ok = await confirmBox(next
      ? { title: 'Flag as Do Not Rent?', message: `Check-in will warn the clerk if ${s.guest.name} comes back.`, confirmText: 'Flag DNR' }
      : { title: 'Remove Do Not Rent?', message: `${s.guest.name} can be rented to again.`, tone: 'primary', confirmText: 'Remove flag' })
    if (!ok) return
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
          {s.renewed_from_info && <Row k="Continued from" v={<StayLink st={s.renewed_from_info} />} />}
          {s.renewed_to_info && <Row k="Continued in" v={<StayLink st={s.renewed_to_info} />} />}
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

      {s.extra_guests?.length > 0 && (
        <section className="card">
          <h2>Extra guests ({s.extra_guests.length})</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>DL number</th><th>DL photos</th></tr></thead>
              <tbody>
                {s.extra_guests.map((x) => (
                  <tr key={x.id}>
                    <td><strong>{x.name}</strong></td>
                    <td>{x.dl_number || '—'}</td>
                    <td>{x.photos.length ? <span className="extra-thumbs">{x.photos.map((ph) => (
                      <AuthImage key={ph.id} photo={{ ...ph, kind_label: `${x.name} · DL ${ph.kind === 'DL_BACK' ? 'back' : 'front'}` }} />
                    ))}</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
            num(s.weekend_nights) > 0 && num(s.weekend_rate) > 0 ? <>
              <div><span>Weekday rate</span><strong>{money(s.rate)} × {s.periods - s.weekend_nights} night{s.periods - s.weekend_nights === 1 ? '' : 's'}</strong></div>
              <div><span>Weekend rate (Fri, Sat)</span><strong>{money(s.weekend_rate)} × {s.weekend_nights} night{s.weekend_nights === 1 ? '' : 's'}</strong></div>
            </> : <div><span>Rate ({rateTypeInfo(s.rate_type).label.toLowerCase()})</span><strong>{money(s.rate)} × {periodText(s.periods, s.rate_type)}</strong></div>
          )}
          {num(s.balance_carried) > 0 && <div><span>Balance from previous stay</span><strong>{money(s.balance_carried)}</strong></div>}
          {num(s.balance_carried) < 0 && <div><span>Balance moved to next stay</span><strong>−{money(Math.abs(num(s.balance_carried)))}</strong></div>}
          {!s.early && num(s.extra_stay_charge) > 0 && (
            <div><span>Added stay ({s.extra_stay_nights} night{s.extra_stay_nights > 1 ? 's' : ''}, other rate)</span><strong>{money(s.extra_stay_charge)}</strong></div>
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
          {num(s.check_paid) !== 0 && <div><span>Check</span><strong>{money(s.check_paid)}</strong></div>}
          {num(s.refunded) > 0 && <div><span>Refunded (in the amounts above)</span><strong>{money(s.refunded)}</strong></div>}
          <div><span>Balance</span><strong><BalanceCell value={s.balance} /></strong></div>
        </div>
        <PaymentList stay={s} onChanged={setS} />
      </section>

      {checkingOut && <CheckoutModal stay={s} onClose={() => setCheckingOut(false)} onDone={load} />}
      {adding && <AddStayModal stay={s} onClose={() => setAdding(false)} onSaved={(d) => { setS(d); setAdding(false) }} />}
      {refunding && <RefundModal stay={s} onClose={() => setRefunding(false)} onSaved={(d) => { setS(d); setRefunding(false) }} />}
      {paying && <PaymentModal stay={s} onClose={() => setPaying(false)} onSaved={(d) => { setS(d); setPaying(false) }} />}
    </>
  )
}

/** Linked stay shown by its dates and room (never the database number). */
function StayLink({ st }) {
  return (
    <Link to={`/stays/${st.id}`}>
      {fmtDate(st.check_in_date)} → {fmtDate(st.check_out_date)} · Room {st.room_number}
    </Link>
  )
}
