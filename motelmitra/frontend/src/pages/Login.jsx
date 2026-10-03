import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { errorText } from '../api'
import { useAuth } from '../auth'
import { Alert } from '../components/ui'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const user = await login(username.trim(), password)
      navigate(user.role === 'SUPER_ADMIN' ? '/clients' : '/')
    } catch (e2) {
      setErr(e2.response?.status === 401 ? 'Wrong username or password.' : errorText(e2))
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="brand brand-dark">
          <span className="brand-mark">M</span>
          <div>
            <div className="brand-name">MotelMitra</div>
            <div className="brand-sub">Front desk, simplified</div>
          </div>
        </div>
        <Alert>{err}</Alert>
        <label>Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required autoComplete="username" />
        </label>
        <label>Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}
