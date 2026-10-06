import { useAuth } from '../auth'
import { money } from '../utils'

/**
 * "Extra charges" (card fee) + "Payment collected" (Cash | Credit / card | Balance | Clerk),
 * laid out exactly like the check-in page. Used by the Pay and Add stay windows.
 * p = usePayment(...)
 */
export default function PaymentCollected({ p, totalNote }) {
  const { user } = useAuth()
  return (
    <div className="form-grid cols-4 pay-collected">
      <div className="subhead span-4">Extra charges</div>
      <label>Card fee
        <span className="fee-input">
          <input type="number" step="0.01" min="0" value={p.fee ?? p.cardFee}
            onChange={(e) => p.setFee(e.target.value === '' ? 0 : Number(e.target.value))} />
          {p.fee != null && <button type="button" className="fee-reset" title="Back to auto" onClick={() => p.setFee(null)}>↺</button>}
        </span>
        <span className="hint">{p.pct > 0 ? `${p.pct}% of the card amount` : 'Card fee % is 0 (Charges & Fees)'}</span>
      </label>
      <div className="readout">
        <span>Total extra charges</span>
        <strong>{money(p.cardFee)}</strong>
      </div>
      <div className="readout span-2">
        {totalNote}
      </div>

      <div className="subhead span-4">Payment collected</div>
      <label>Cash
        <input type="number" step="0.01" min="0" value={p.cash} onChange={(e) => p.setCash(e.target.value)} placeholder="0.00" />
        <button type="button" className="link-btn" onClick={p.balanceInCash}>Put balance in cash</button>
      </label>
      <label>Credit / card
        <input type="number" step="0.01" min="0" value={p.credit} onChange={(e) => p.setCredit(e.target.value)} placeholder="0.00" />
        <button type="button" className="link-btn" onClick={p.balanceOnCard}>Put balance on card</button>
      </label>
      <label>Balance
        <input type="number" step="0.01" className={p.after > 0 ? 'input-owed' : ''} {...p.balanceInput} />
        {p.after < 0 && <span className="hint">More than owed; guest will be in credit</span>}
      </label>
      <div className="readout">
        <span>Clerk</span>
        <strong>{user.full_name}</strong>
      </div>
      {p.adj !== 0 && (
        <div className="adj-note span-4">
          Balance edited: {p.adj > 0 ? 'an extra charge of' : 'a discount of'} <strong>{money(Math.abs(p.adj))}</strong> will be added to the stay.
          <button type="button" className="btn btn-sm ml" onClick={p.resetAdj}>Reset</button>
        </div>
      )}
    </div>
  )
}
