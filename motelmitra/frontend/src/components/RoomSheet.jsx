import { Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { dayOfStay, daysLeft, fmtDate, fmtTime, money, num, rateTypeInfo } from '../utils'
import { BalanceCell, Empty } from './ui'

/**
 * Every room for one date. A room rented more than once gets one row per entry;
 * vacant rooms get an empty row with a Check in button.
 */
export default function RoomSheet({ date, rooms, stays, onPay, onCheckout, onAddStay }) {
  const navigate = useNavigate()
  if (!rooms?.length) return <Empty>No rooms set up yet.</Empty>

  const sorted = [...rooms].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))
  const byRoom = {}
  stays.forEach((s) => { (byRoom[s.room] ||= []).push(s) })
  Object.values(byRoom).forEach((list) =>
    list.sort((a, b) => `${a.check_in_date}${a.check_in_time}`.localeCompare(`${b.check_in_date}${b.check_in_time}`)),
  )

  // A room is free for tonight when nobody in it is staying past this date.
  const freeTonight = (list) => list.every((s) => s.status === 'CHECKED_OUT' || s.check_out_date <= date)

  function label(s) {
    if (s.status === 'CHECKED_OUT') return <span className="pill pill-grey">Checked out</span>
    if (s.check_out_date === date && s.check_in_date !== date) return <span className="pill pill-warn">Due out</span>
    if (s.check_in_date === date) return <span className="pill pill-blue">Arrived</span>
    return <span className="pill pill-green">Stay-over</span>
  }

  const checkIn = (room) => navigate(`/check-in?room=${room.id}&date=${date}`)

  // Money is counted on the business day it was taken. Earlier payments show as "Paid".
  const money4 = (s) => {
    let cash = 0, credit = 0, earlier = 0, lastDay = null
    for (const p of s.payments || []) {
      const day = p.business_date || p.paid_at?.slice(0, 10)
      if (day === date) { if (p.method === 'CASH') cash += num(p.amount); else credit += num(p.amount) }
      else if (day < date) { earlier += num(p.amount); lastDay = day }
    }
    return { cash, credit, earlier, lastDay }
  }
  const tot = { total: 0, cash: 0, credit: 0, balance: 0, arrivals: 0 }
  stays.forEach((s) => {
    const m = money4(s)
    if (s.check_in_date === date) { tot.total += num(s.total_amount); tot.arrivals += 1 }
    tot.cash += m.cash
    tot.credit += m.credit
    tot.balance += Math.max(num(s.balance), 0)
  })

  // Compact layout (9 columns): stay info merged, status under the guest name, actions pinned on the right.
  const actions = (s) => (
    <td className="row-actions sheet-actions" onClick={(e) => e.stopPropagation()}>
      <div className="sheet-btns">
        {num(s.balance) > 0 && <button className="btn btn-sm btn-warn" onClick={() => onPay(s)}>Pay</button>}
        {s.status === 'CHECKED_IN' && <button className="btn btn-sm" onClick={() => onCheckout(s)}>Check out</button>}
        {s.status === 'CHECKED_IN' && onAddStay && (
          <button className="btn btn-sm btn-add" title="Guest stays longer / pays in advance" onClick={() => onAddStay(s)}>+ Stay</button>
        )}
      </div>
    </td>
  )
  const checkInCell = (room) => (
    <td className="row-actions sheet-actions">
      <div className="sheet-btns"><button className="btn btn-sm btn-primary" onClick={() => checkIn(room)}>Check in</button></div>
    </td>
  )

  return (
    <div className="table-wrap sheet-wrap">
      <table className="table sheet">
        <thead>
          <tr>
            <th>Room</th>
            <th>Guest</th>
            <th>Stay dates</th>
            <th>Day</th>
            <th className="num">Total</th>
            <th className="num">Cash</th>
            <th className="num">Credit</th>
            <th className="num">Balance</th>
            <th className="sheet-actions"></th>
          </tr>
        </thead>
        {sorted.map((room) => {
          const list = byRoom[room.id] || []
          return (
            <tbody key={room.id} className={list.length ? 'room-group' : 'room-group vacant'}>
              {list.length === 0 ? (
                <tr>
                  <td><span className="room-chip">{room.number}</span><div className="tiny muted">{room.room_type}</div></td>
                  <td colSpan={7} className="muted vacant-cell">Vacant · {money(room.default_rate)}</td>
                  {checkInCell(room)}
                </tr>
              ) : (
                list.map((s, i) => {
                  const m = money4(s)
                  const stayOver = s.check_in_date < date
                  return (
                  <Fragment key={s.id}>
                    <tr className="clickable" onClick={() => navigate(`/stays/${s.id}`)}>
                      <td>
                        {i === 0 && <><span className="room-chip">{room.number}</span><div className="tiny muted">{room.room_type}</div></>}
                        {i > 0 && <span className="tiny muted">{room.number} · #{i + 1}</span>}
                      </td>
                      <td className="sheet-guest">
                        <strong title={s.guest.name}>{s.guest.name}</strong>
                        <div className="sheet-sub">
                          {label(s)}
                          {s.guest.do_not_rent && <span className="pill pill-red">DNR</span>}
                          {s.guest.phone && <span className="tiny muted">{s.guest.phone}</span>}
                        </div>
                      </td>
                      <td>
                        {fmtShort(s.check_in_date)} → {fmtShort(s.check_out_date)}
                        <div className="tiny muted">{s.num_days} night{s.num_days > 1 ? 's' : ''} · {fmtTime(s.check_in_time)}</div>
                      </td>
                      <td>
                        <CurrentDay stay={s} date={date} />
                        <div><DaysLeft stay={s} date={date} /></div>
                      </td>
                      <td className={`num ${stayOver ? 'sheet-earlier' : ''}`} title={stayOver ? `Checked in ${fmtDate(s.check_in_date)}; counted in that day's total` : ''}>
                        {money(s.total_amount)}<div className="tiny muted">{money(s.rate)}{rateTypeInfo(s.rate_type).short}</div>
                      </td>
                      {m.cash === 0 && m.credit === 0 && m.earlier > 0 ? (
                        <td colSpan={2} className="num">
                          {num(s.balance) > 0
                            ? <span className="pill pill-warn">Part paid</span>
                            : <span className="pill pill-green">Paid</span>}
                          <div className="tiny muted">{money(m.earlier)}{m.lastDay ? ` by ${fmtShort(m.lastDay)}` : ''}</div>
                        </td>
                      ) : (
                        <>
                          <td className="num">{m.cash ? money(m.cash) : <span className="muted">—</span>}</td>
                          <td className="num">
                            {m.credit ? money(m.credit) : <span className="muted">—</span>}
                            {m.earlier > 0 && <div className="tiny muted">+{money(m.earlier)} earlier</div>}
                          </td>
                        </>
                      )}
                      <td className="num"><BalanceCell value={s.balance} /></td>
                      {actions(s)}
                    </tr>
                    {i === list.length - 1 && freeTonight(list) && (
                      <tr className="rent-again">
                        <td></td>
                        <td colSpan={7} className="muted vacant-cell">Free for tonight</td>
                        {checkInCell(room)}
                      </tr>
                    )}
                  </Fragment>
                  )
                })
              )}
            </tbody>
          )
        })}
        <tfoot>
          <tr className="sheet-total">
            <td colSpan={4}>
              Totals for {fmtDate(date)}
              <div className="tiny muted">Total = {tot.arrivals} check-in{tot.arrivals === 1 ? '' : 's'} on this date · Cash / Credit = taken on this date</div>
            </td>
            <td className="num">{money(tot.total)}</td>
            <td className="num">{money(tot.cash)}</td>
            <td className="num">{money(tot.credit)}</td>
            <td className="num"><span className={tot.balance > 0 ? 'owed' : ''}>{money(tot.balance)}</span></td>
            <td className="num sheet-actions"><strong>{money(tot.cash + tot.credit)}</strong><div className="tiny muted">collected</div></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// 10/05 (adds the year only when it is not this year)
function fmtShort(iso) {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return y === String(new Date().getFullYear()) ? `${m}/${d}` : `${m}/${d}/${y.slice(2)}`
}

export function DaysLeft({ stay, date }) {
  const d = daysLeft(stay, date)
  return <span className={`days-left dl-${d.tone}`}>{d.text}</span>
}

export function CurrentDay({ stay, date }) {
  const n = dayOfStay(stay, date)
  if (n == null) return <span className="muted">—</span>
  if (n > stay.num_days) {
    // past the last night: checkout morning (or later if not checked out yet)
    return n === stay.num_days + 1
      ? <span className="tiny cur-out">Checkout day</span>
      : <span className="cur-day cur-over"><strong>{n}</strong></span>
  }
  return <span className="cur-day"><strong>{n}</strong><span className="tiny muted"> of {stay.num_days}</span></span>
}
