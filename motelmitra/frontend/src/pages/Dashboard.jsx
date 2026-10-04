import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api, { errorText } from '../api'
import NotesPanel from '../components/NotesPanel'
import RoomSheet from '../components/RoomSheet'
import StaysTable from '../components/StaysTable'
import { Alert, PageHead, PaymentModal, Stat } from '../components/ui'
import { addDays, fmtDate, money, todayISO } from '../utils'

export default function Dashboard() {
  const [date, setDate] = useState(todayISO())
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [paying, setPaying] = useState(null)
  const [tab, setTab] = useState('checkouts')

  const load = useCallback(() => {
    api.get('/dashboard/', { params: { date } })
      .then((r) => { setData(r.data); setErr('') })
      .catch((e) => setErr(errorText(e)))
  }, [date])

  useEffect(() => { load() }, [load])

  async function checkout(stay) {
    if (!window.confirm(`Check out ${stay.guest.name} from room ${stay.room_number}?`)) return
    try {
      await api.post(`/stays/${stay.id}/checkout/`)
      load()
    } catch (e) { setErr(errorText(e)) }
  }

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
          <Stat label="Checkouts due" value={st.checkouts_due} tone={st.checkouts_due ? 'warn' : ''} />
          <Stat label="Checked out" value={st.checked_out} />
          <Stat label="Arrivals" value={st.arrivals} />
          <Stat label="Occupied" value={`${st.occupied} / ${st.total_rooms}`} />
          <Stat label="Available rooms" value={st.available} tone="good" />
          <Stat label={`Open balances (${st.open_balance_count})`} value={money(st.open_balance_total)} tone={st.open_balance_count ? 'bad' : ''} />
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

      {paying && (
        <PaymentModal stay={paying} onClose={() => setPaying(null)} onSaved={() => { setPaying(null); load() }} />
      )}
    </>
  )
}
