import { Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { dayOfStay, daysLeft, fmtDate, fmtTime, money, num, rateTypeInfo } from '../utils'
import { BalanceCell, Empty } from './ui'

/**
 * Every room for one date. A room rented more than once gets one row per entry;
 * vacant rooms get an empty row with a Check in button.
 */
export default function RoomSheet({ date, rooms, stays, onPay, onCheckout }) {
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

  return (
    <div className="table-wrap">
      <table className="table sheet">
        <thead>
          <tr>
            <th>Room</th>
            <th>Guest</th>
            <th>Check-in → Check-out</th>
            <th className="num">Days</th>
            <th className="num">Current day</th>
            <th>Days left</th>
            <th className="num">Total</th>
            <th className="num">Paid</th>
            <th className="num">Balance</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        {sorted.map((room) => {
          const list = byRoom[room.id] || []
          return (
            <tbody key={room.id} className={list.length ? 'room-group' : 'room-group vacant'}>
              {list.length === 0 ? (
                <tr>
                  <td><span className="room-chip">{room.number}</span><div className="tiny muted">{room.room_type}</div></td>
                  <td colSpan={8} className="muted vacant-cell">Vacant · {money(room.default_rate)}</td>
                  <td><span className="pill pill-grey">Vacant</span></td>
                  <td className="row-actions">
                    <button className="btn btn-sm btn-primary" onClick={() => checkIn(room)}>Check in</button>
                  </td>
                </tr>
              ) : (
                list.map((s, i) => (
                  <Fragment key={s.id}>
                    <tr className="clickable" onClick={() => navigate(`/stays/${s.id}`)}>
                      <td>
                        {i === 0 && <><span className="room-chip">{room.number}</span><div className="tiny muted">{room.room_type}</div></>}
                        {i > 0 && <span className="tiny muted">{room.number} · rental {i + 1}</span>}
                      </td>
                      <td>
                        <strong>{s.guest.name}</strong>{s.guest.do_not_rent && <span className="pill pill-red ml">DNR</span>}
                        <div className="tiny muted">{s.guest.phone}</div>
                      </td>
                      <td>
                        {fmtDate(s.check_in_date)} → {fmtDate(s.check_out_date)}
                        <div className="tiny muted">{fmtTime(s.check_in_time)} → {fmtTime(s.check_out_time)}</div>
                      </td>
                      <td className="num">{s.num_days}</td>
                      <td className="num"><CurrentDay stay={s} date={date} /></td>
                      <td><DaysLeft stay={s} date={date} /></td>
                      <td className="num">{money(s.total_amount)}<div className="tiny muted">{money(s.rate)}{rateTypeInfo(s.rate_type).short}</div></td>
                      <td className="num">{money(s.amount_paid)}</td>
                      <td className="num"><BalanceCell value={s.balance} /></td>
                      <td>{label(s)}</td>
                      <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                        {num(s.balance) > 0 && <button className="btn btn-sm btn-warn" onClick={() => onPay(s)}>Pay</button>}
                        {s.status === 'CHECKED_IN' && <button className="btn btn-sm" onClick={() => onCheckout(s)}>Check out</button>}
                      </td>
                    </tr>
                    {i === list.length - 1 && freeTonight(list) && (
                      <tr className="rent-again">
                        <td></td>
                        <td colSpan={9} className="muted vacant-cell">Free for tonight</td>
                        <td className="row-actions">
                          <button className="btn btn-sm btn-primary" onClick={() => checkIn(room)}>Check in</button>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          )
        })}
      </table>
    </div>
  )
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
