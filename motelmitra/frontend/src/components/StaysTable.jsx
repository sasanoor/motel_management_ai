import { useNavigate } from 'react-router-dom'
import { fmtDate, fmtTime, money, num } from '../utils'
import { CurrentDay, DaysLeft } from './RoomSheet'
import { BalanceCell, Empty, StatusPill } from './ui'

/**
 * Shared guest table.
 * actions: { onPay(stay), onCheckout(stay) } optional
 */
export default function StaysTable({ stays, actions = {}, empty = 'No guests.', highlightDate }) {
  const navigate = useNavigate()
  if (!stays?.length) return <Empty>{empty}</Empty>

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Room</th>
            <th>Guest</th>
            <th>Phone</th>
            <th>Check-in</th>
            <th>Check-out</th>
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
        <tbody>
          {stays.map((s) => (
            <tr key={s.id} className="clickable" onClick={() => navigate(`/stays/${s.id}`)}>
              <td><span className="room-chip">{s.room_number}</span><div className="tiny muted">{s.room_type}</div></td>
              <td>
                <strong>{s.guest.name}</strong>
                {s.guest.do_not_rent && <span className="pill pill-red ml">DNR</span>}
              </td>
              <td>{s.guest.phone}</td>
              <td>{fmtDate(s.check_in_date)}<div className="tiny muted">{fmtTime(s.check_in_time)}</div></td>
              <td className={highlightDate && s.check_out_date === highlightDate ? 'due' : ''}>
                {fmtDate(s.check_out_date)}<div className="tiny muted">{fmtTime(s.check_out_time)}</div>
              </td>
              <td className="num">{s.num_days}</td>
              <td className="num"><CurrentDay stay={s} date={highlightDate} /></td>
              <td><DaysLeft stay={s} date={highlightDate} /></td>
              <td className="num">{money(s.total_amount)}</td>
              <td className="num">{money(s.amount_paid)}</td>
              <td className="num"><BalanceCell value={s.balance} /></td>
              <td><StatusPill stay={s} /></td>
              <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                {actions.onPay && num(s.balance) > 0 && (
                  <button className="btn btn-sm btn-warn" onClick={() => actions.onPay(s)}>Pay</button>
                )}
                {actions.onCheckout && s.status === 'CHECKED_IN' && (
                  <button className="btn btn-sm" onClick={() => actions.onCheckout(s)}>Check out</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
