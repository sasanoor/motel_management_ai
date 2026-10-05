import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api, { errorText } from '../api'
import CheckoutModal from '../components/CheckoutModal'
import NotesPanel from '../components/NotesPanel'
import RoomSheet from '../components/RoomSheet'
import StaysTable from '../components/StaysTable'
import { Alert, Modal, PageHead, PaymentModal, Stat } from '../components/ui'
import { addDays, fmtDate, money, rateFor, todayISO } from '../utils'

export default function Dashboard() {
  const [date, setDate] = useState(todayISO())
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [paying, setPaying] = useState(null)
  const [tab, setTab] = useState('checkouts')
  const [showAvail, setShowAvail] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(() => {
    api.get('/dashboard/', { params: { date } })
      .then((r) => { setData(r.data); setErr('') })
      .catch((e) => setErr(errorText(e)))
  }, [date])

  useEffect(() => { load() }, [load])

  // opens the Check out / Check out & check in again popup
  const [checkingOut, setCheckingOut] = useState(null)
  const checkout = (stay) => setCheckingOut(stay)

  const st = data?.stats
  const isToday = date === todayISO()

  return (
    <>
      <PageHead title={isToday ? "Today's Front Desk" : `Front Desk: ${fmtDate(date)}`}>
        <div className="date-nav">
          <button className="btn" onClick={() => setDate(addDays(date, -1))}>‹</button>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <button className="btn" onClick={() => setDate(addDays(date, 1))}>›</button>
          {!isToday && <button className="btn" onClick={() => setDate(todayISO())}>Today</button>}
        </div>
        <Link to="/check-in" className="btn btn-primary">+ New Check-in</Link>
      </PageHead>
      <Alert>{err}</Alert>

      {st && (
        <div className="stats">
          <Stat label="Checkouts due" value={st.checkouts_due} tone={st.checkouts_due ? 'warn' : ''} onClick={() => setTab('checkouts')} />
          <Stat label="Checked out" value={st.checked_out} onClick={() => setTab('checkouts')} />
          <Stat label="Arrivals" value={st.arrivals} onClick={() => setTab('staying')} />
          <Stat label="Occupied" value={`${st.occupied} / ${st.total_rooms}`} onClick={() => setTab('sheet')} />
          <Stat label="Available rooms" value={st.available} tone="good" onClick={() => setShowAvail(true)} />
          <Stat label={`Open balances (${st.open_balance_count})`} value={money(st.open_balance_total)} tone={st.open_balance_count ? 'bad' : ''} onClick={() => navigate('/balances')} />
        </div>
      )}

      <div className="tabs">
        <button className={tab === 'checkouts' ? 'on' : ''} onClick={() => setTab('checkouts')}>
          Checkouts {data && <span className="count">{data.checkouts.length}</span>}
        </button>
        <button className={tab === 'staying' ? 'on' : ''} onClick={() => setTab('staying')}>
          All guests on this date {data && <span className="count">{data.staying.length}</span>}
        </button>
        <button className={tab === 'sheet' ? 'on' : ''} onClick={() => setTab('sheet')}>
          Room sheet {data && <span className="count">{data.rooms.length} rooms</span>}
        </button>
        <button className={tab === 'notes' ? 'on' : ''} onClick={() => setTab('notes')}>
          Maintenance notes {data && <span className="count">{data.stats.notes}</span>}
        </button>
      </div>

      <div className="card no-pad">
        {data && tab === 'sheet' && (
          <RoomSheet date={date} rooms={data.rooms} stays={data.staying} onPay={setPaying} onCheckout={checkout} />
        )}
        {data && tab === 'notes' && (
          <NotesPanel date={date} rooms={data.rooms} onCount={load} />
        )}
        {data && (tab === 'checkouts' || tab === 'staying') && (
          <StaysTable
            stays={tab === 'checkouts' ? data.checkouts : data.staying}
            highlightDate={date}
            actions={{ onPay: setPaying, onCheckout: checkout }}
            empty={tab === 'checkouts' ? 'No checkouts on this date.' : 'No guests on this date.'}
          />
        )}
      </div>

      {showAvail && data && (
        <AvailableRooms
          date={date}
          rooms={data.rooms.filter((r) => r.available)}
          onClose={() => setShowAvail(false)}
          onCheckIn={(r) => navigate(`/check-in?room=${r.id}&date=${date}`)}
        />
      )}

      {checkingOut && (
        <CheckoutModal stay={checkingOut} onClose={() => setCheckingOut(null)} onDone={load} />
      )}

      {paying && (
        <PaymentModal stay={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); load() }} />
      )}
    </>
  )
}

/** Vacant rooms for the night of `date`, with rates and a Check in button. */
function AvailableRooms({ date, rooms, onClose, onCheckIn }) {
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const types = [...new Set(rooms.map((r) => r.room_type))].sort()
  const list = rooms
    .filter((r) => !type || r.room_type === type)
    .filter((r) => !q || r.number.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
  const ready = rooms.filter((r) => !r.due_out).length

  return (
    <Modal title={`Available rooms · ${fmtDate(date)}`} onClose={onClose} width={760}>
      <p className="muted tiny avail-sum">
        {rooms.length} available tonight · {ready} ready now
        {rooms.length - ready > 0 && ` · ${rooms.length - ready} waiting for checkout`}
      </p>
      <div className="filters">
        <input className="search" placeholder="Room no." value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="chips">
          <button type="button" className={`chip ${!type ? 'on' : ''}`} onClick={() => setType('')}>All ({rooms.length})</button>
          {types.map((t) => (
            <button type="button" key={t} className={`chip ${type === t ? 'on' : ''}`} onClick={() => setType(t)}>
              {t} ({rooms.filter((r) => r.room_type === t).length})
            </button>
          ))}
        </div>
      </div>
      {!list.length ? <div className="empty">No available rooms match.</div> : (
        <div className="table-wrap avail-list">
          <table className="table">
            <thead>
              <tr><th>Room</th><th>Type</th><th className="num">Daily</th><th className="num">Weekly</th><th className="num">Monthly</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td><span className="room-chip">{r.number}</span></td>
                  <td>{r.room_type}</td>
                  <td className="num">{money(rateFor(r, 'DAILY'))}</td>
                  <td className="num">{money(rateFor(r, 'WEEKLY'))}</td>
                  <td className="num">{money(rateFor(r, 'MONTHLY'))}</td>
                  <td>{r.due_out
                    ? <span className="pill pill-warn">Guest checking out</span>
                    : <span className="pill pill-green">Ready</span>}</td>
                  <td className="row-actions"><button className="btn btn-sm btn-primary" onClick={() => onCheckIn(r)}>Check in</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
