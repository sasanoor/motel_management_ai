import { useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { Alert, Empty, PageHead } from '../components/ui'
import { fmtDate, fmtDateTime, money } from '../utils'

export default function Deleted() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => api.get('/stays/deleted/').then((r) => setRows(r.data)).catch((e) => setErr(errorText(e)))
  useEffect(() => { load() }, [])

  async function restore(s) {
    if (!window.confirm(`Recover ${s.guest.name} (Room ${s.room_number})?`)) return
    try {
      await api.post(`/stays/${s.id}/restore/`)
      setMsg(`${s.guest.name} recovered.`)
      load()
    } catch (e) { setErr(errorText(e)) }
  }

  return (
    <>
      <PageHead title="Deleted Guests" sub="Recover guest records deleted by mistake" />
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="card no-pad">
        {rows && !rows.length && <Empty>No deleted guests.</Empty>}
        {rows?.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Room</th><th>Guest</th><th>Check-in</th><th>Checkout</th><th className="num">Total</th><th>Deleted</th><th>By</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td><span className="room-chip">{s.room_number}</span></td>
                    <td><strong>{s.guest.name}</strong><div className="tiny muted">{s.guest.phone}</div></td>
                    <td>{fmtDate(s.check_in_date)}</td>
                    <td>{fmtDate(s.check_out_date)}</td>
                    <td className="num">{money(s.total_amount)}</td>
                    <td>{fmtDateTime(s.deleted_at)}</td>
                    <td>{s.deleted_by_name}</td>
                    <td><button className="btn btn-sm btn-primary" onClick={() => restore(s)}>Recover</button></td>
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
