import { useEffect, useState } from 'react'
import api from './api'
import { num } from './utils'

const r2 = (n) => Math.round(n * 100) / 100

/**
 * Money taken in a window (Pay, Add stay), worked the same way as the check-in page:
 * cash + card, card fee (auto % of the card amount, editable), "Put balance in cash / on card",
 * and an editable balance (the difference is saved as an extra charge or discount).
 *
 * owed = what the guest owes before this payment, without the card fee and without a balance edit.
 */
export default function usePayment(owed, { initialCash = '' } = {}) {
  const [cash, setCashRaw] = useState(initialCash)
  const [credit, setCreditRaw] = useState('')
  const [fee, setFeeRaw] = useState(null)        // null = auto (% of card amount)
  const [pct, setPct] = useState(0)
  const [adj, setAdj] = useState(0)              // balance edited: + extra charge, - discount
  const [balanceText, setBalanceText] = useState(null)

  useEffect(() => { api.get('/settings/').then((r) => setPct(num(r.data.card_fee_percent))).catch(() => {}) }, [])

  const cardFee = fee ?? r2((num(credit) * pct) / 100)
  const base = r2(owed + cardFee - num(cash) - num(credit))   // balance before any edit
  const after = r2(base + adj)
  const paying = num(cash) + num(credit)

  // a balance edit is applied last: changing cash / card / fee clears it so it never goes stale
  const setCash = (v) => { setCashRaw(v); setAdj(0) }
  const setCredit = (v) => { setCreditRaw(v); setAdj(0) }
  const setFee = (v) => { setFeeRaw(v); setAdj(0) }

  return {
    cash, credit, fee, pct, adj, cardFee, after, paying, balanceText,
    setCash, setCredit, setFee,
    resetAdj: () => setAdj(0),
    balanceInCash: () => setCashRaw(Math.max(r2(owed + adj + cardFee - num(credit)), 0).toFixed(2)),
    balanceOnCard: () => {
      const due = owed + adj - num(cash)
      if (due <= 0) return
      const c = fee == null ? due / (1 - pct / 100) : due + num(fee)
      setCreditRaw(r2(c).toFixed(2))
    },
    // the clerk types a balance: keep the payment, store the difference as an adjustment
    balanceInput: {
      value: balanceText ?? after.toFixed(2),
      onFocus: (e) => { setBalanceText(after.toFixed(2)); e.target.select() },
      onChange: (e) => {
        const text = e.target.value
        setBalanceText(text)
        if (text !== '' && !isNaN(Number(text))) setAdj(r2(Number(text) - base))
      },
      onBlur: () => setBalanceText(null),
    },
    body: () => ({
      cash: num(cash).toFixed(2), credit: num(credit).toFixed(2),
      card_fee: cardFee.toFixed(2), adjustment_change: adj.toFixed(2),
    }),
  }
}
