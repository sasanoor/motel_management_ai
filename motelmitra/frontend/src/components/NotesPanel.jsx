import { useCallback, useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { useAuth } from '../auth'
import { fmtDateTime } from '../utils'
import { Alert, Empty } from './ui'

/** Front desk writes notes for maintenance for a date (Home screen tab). */
export default function NotesPanel({ date, rooms, onCount }) {
  const { user, isAdmin } = useAuth()
  const [notes, setNotes] = useState([])
  const [room, setRoom] = useState('')
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(null) // { id, text }
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.get('/notes/', { params: { date } })
      .then((r) => { setNotes(r.data); onCount?.(r.data.length) })
      .catch((e) => setErr(errorText(e)))
  }, [date, onCount])
  useEffect(() => { load() }, [load])

  const sortedRooms = [...(rooms || [])].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))

  async function add(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api.post('/notes/', { date, room: room || null, text })
      setText('')
      setRoom('')
      load()
    } catch (e2) { setErr(errorText(e2)) }
    setBusy(false)
  }

  async function save() {
    try {
      await api.patch(`/notes/${editing.id}/`, { text: editing.text })
      setEditing(null)
      load()
    } catch (e) { setErr(errorText(e)) }
  }

  async function remove(n) {
    if (!window.confirm('Delete this note?')) return
    try { await api.delete(`/notes/${n.id}/`); load() } catch (e) { setErr(errorText(e)) }
  }

  const canChange = (n) => isAdmin || n.created_by === user.id

  return (
    <div className="notes-panel">
      <form onSubmit={add} className="note-form">
        <select value={room} onChange={(e) => setRoom(e.target.value)}>
          <option value="">General (no room)</option>
          {sortedRooms.map((r) => <option key={r.id} value={r.id}>Room {r.number}</option>)}
        </select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Note for maintenance, e.g. AC not cooling" required />
        <button className="btn btn-primary" disabled={busy || !text.trim()}>Add note</button>
      </form>
      <Alert>{err}</Alert>
      {!notes.length ? <Empty>No maintenance notes for this date.</Empty> : (
        <table className="table">
          <thead><tr><th>Room</th><th>Note</th><th>By</th><th>Time</th><th></th></tr></thead>
          <tbody>
            {notes.map((n) => (
              <tr key={n.id}>
                <td>{n.room_number ? <span className="room-chip">{n.room_number}</span> : <span className="muted">General</span>}</td>
                <td className="wrap">
                  {editing?.id === n.id
                    ? <input value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} autoFocus />
                    : n.text}
                </td>
                <td>{n.created_by_name}</td>
                <td>{fmtDateTime(n.created_at)}</td>
                <td className="row-actions">
                  {canChange(n) && (editing?.id === n.id ? (
                    <>
                      <button className="btn btn-sm btn-primary" onClick={save}>Save</button>
                      <button className="btn btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-sm" onClick={() => setEditing({ id: n.id, text: n.text })}>Edit</button>
                      <button className="btn btn-sm btn-danger-outline" onClick={() => remove(n)}>Delete</button>
                    </>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
