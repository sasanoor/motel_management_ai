import { useCallback, useEffect, useState } from 'react'
import api, { errorText } from '../api'
import { Alert, Empty, PageHead, Stat } from '../components/ui'
import { addDays, fmtDate, fmtDateTime, fmtTime, todayISO } from '../utils'

function NoteLine({ n }) {
  return (
    <div className="note">
      <div className="note-text">{n.text}</div>
      <div className="tiny muted">{n.created_by} · {fmtDateTime(n.created_at)}</div>
    </div>
  )
}

/** Maintenance user's only screen: rooms checking out today and the day's notes. */
export default function Maintenance() {
  const [date, setDate] = useState(todayISO())
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => {
    api.get('/maintenance/', { params: { date } })
      .then((r) => { setData(r.data); setErr('') })
      .catch((e) => setErr(errorText(e)))
  }, [date])

  useEffect(() => {
    load()
    const t = setInterval(load, 60000) // refresh every minute
    return () => clearInterval(t)
  }, [load])

  const isToday = date === todayISO()

  return (
    <>
      <PageHead title={isToday ? "Today's Checkout Rooms" : `Checkout Rooms: ${fmtDate(date)}`}>
        <div className="date-nav">
          <button className="btn" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn" onClick={() => setDate(addDays(date, 1))}>›</button>
          {!isToday && <button className="btn" onClick={() => setDate(todayISO())}>Today</button>}
        </div>
        <button className="btn" onClick={load}>Refresh</button>
      </PageHead>
      <Alert>{err}</Alert>

      {data && (
        <>
          <div className="stats">
            <Stat label="Checkout rooms" value={data.summary.checkouts} />
            <Stat label="Guest left, ready" value={data.summary.ready} tone="good" />
            <Stat label="Guest not out yet" value={data.summary.waiting} tone={data.summary.waiting ? 'warn' : ''} />
            <Stat label="Notes" value={data.summary.notes} />
          </div>

          {!data.rooms.length ? (
            <div className="card"><Empty>No checkouts on this date.</Empty></div>
          ) : (
            <div className="mt-grid">
              {data.rooms.map((r) => (
                <div key={r.room_id} className={`mt-card ${r.guest_left ? 'ready' : 'waiting'}`}>
                  <div className="mt-head">
                    <div>
                      <div className="mt-room">{r.room_number}</div>
                      <div className="tiny muted">{r.room_type}</div>
                    </div>
                    {r.guest_left
                      ? <span className="pill pill-green">Guest left · ready</span>
                      : <span className="pill pill-warn">Not out yet</span>}
                  </div>
                  <div className="tiny muted mt-time">
                    Checkout {fmtTime(r.check_out_time)}
                    {r.checked_out_at && ` · left at ${fmtDateTime(r.checked_out_at)}`}
                  </div>
                  {r.notes.length > 0 && (
                    <div className="mt-notes">{r.notes.map((n) => <NoteLine key={n.id} n={n} />)}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          <h2 className="section-title">Other notes for this day</h2>
          <div className="card">
            {!data.other_notes.length ? <Empty>No other notes.</Empty> : data.other_notes.map((n) => (
              <div key={n.id} className="other-note">
                {n.room_number && <span className="room-chip">{n.room_number}</span>}
                <NoteLine n={n} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
