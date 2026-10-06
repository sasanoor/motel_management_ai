import { useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { Alert, Empty, PageHead } from '../components/ui'
import { fmtDate, fmtDateTime, money, num } from '../utils'
import { confirmBox } from '../confirm'

/**
 * Admin only. Everything deleted, in one place:
 *  - Guests deleted from the Guest Directory (the person; their stays stay in the reports)
 *  - Deleted check-ins (a stay record, left out of the reports while deleted)
 */
export default function Deleted() {
  const [guests, setGuests] = useState(null)
  const [stays, setStays] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => {
    api.get('/guests/', { params: { deleted: 1 } }).then((r) => setGuests(r.data)).catch((e) => setErr(errorText(e)))
    api.get('/stays/deleted/').then((r) => setStays(r.data)).catch((e) => setErr(errorText(e)))
  }
  useEffect(() => { load() }, [])

  async function restoreGuest(g) {
    const ok = await confirmBox({ title: 'Recover guest?', message: 'The guest comes back to the Guest Directory, check-in lookups and the DNR check.',
      details: [['Guest', g.name], ['Phone', g.phone || '-'], ['Deleted by', g.deleted_by_name || '-']], tone: 'primary', confirmText: 'Recover' })
    if (!ok) return
    try { await api.post(`/guests/${g.id}/restore/`); setMsg(`${g.name} recovered.`); setErr(''); load() } catch (e) { setErr(errorText(e)) }
  }

  async function restoreStay(s) {
    if (!(await confirmBox({ title: 'Recover check-in?', message: 'The stay comes back into the reports and the room sheet.', details: [['Guest', s.guest.name], ['Room', s.room_number], ['Stay', `${fmtDate(s.check_in_date)} to ${fmtDate(s.check_out_date)}`]], tone: 'primary', confirmText: 'Recover' }))) return
    const go = async (force) => {
      await api.post(`/stays/${s.id}/restore/`, force ? { force: true } : {})
      setMsg(`${s.guest.name} (room ${s.room_number}) recovered.`); setErr('')
      load()
    }
    try { await go(false) } catch (e) {
      // the room was rented to someone else since the delete: ask before making a double booking
      const overlap = e.response?.data?.overlap
      if (overlap && await confirmBox({ title: 'Room is rented again', message: String(overlap), confirmText: 'Recover anyway' })) {
        try { await go(true) } catch (e2) { setErr(errorText(e2)) }
      } else if (!overlap) setErr(errorText(e))
    }
  }

  return (
    <>
      <PageHead title="Deleted Guests" sub="Recover guests and check-ins deleted by mistake. Only the admin sees this page." />
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <h2 className="section-title">Guests deleted from the Guest Directory{guests ? ` (${guests.length})` : ''}</h2>
      <div className="card no-pad">
        {guests && !guests.length && <Empty>No deleted guests.</Empty>}
        {guests?.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Guest</th><th>Phone</th><th className="num">Stays</th><th className="num">Balance</th><th>Deleted</th><th>By</th><th></th></tr>
              </thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.id}>
                    <td><strong>{g.name}</strong>{g.do_not_rent && <span className="pill pill-red ml">DNR</span>}</td>
                    <td>{g.phone}</td>
                    <td className="num">{g.stay_count}</td>
                    <td className="num"><span className={num(g.balance) > 0 ? 'owed' : ''}>{money(g.balance)}</span></td>
                    <td>{fmtDateTime(g.deleted_at)}</td>
                    <td>{g.deleted_by_name}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => restoreGuest(g)}>Recover</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <h2 className="section-title">Deleted check-ins{stays ? ` (${stays.length})` : ''}</h2>
      <div className="card no-pad">
        {stays && !stays.length && <Empty>No deleted check-ins.</Empty>}
        {stays?.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Room</th><th>Guest</th><th>Check-in</th><th>Checkout</th><th className="num">Total</th><th>Deleted</th><th>By</th><th></th></tr>
              </thead>
              <tbody>
                {stays.map((s) => (
                  <tr key={s.id}>
                    <td><span className="room-chip">{s.room_number}</span></td>
                    <td><strong>{s.guest.name}</strong><div className="tiny muted">{s.guest.phone}</div></td>
                    <td>{fmtDate(s.check_in_date)}</td>
                    <td>{fmtDate(s.check_out_date)}</td>
                    <td className="num">{money(s.total_amount)}</td>
                    <td>{fmtDateTime(s.deleted_at)}</td>
                    <td>{s.deleted_by_name}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => restoreStay(s)}>Recover</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
