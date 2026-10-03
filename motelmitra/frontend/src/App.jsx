import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth'
import Layout from './components/Layout'
import CheckIn from './pages/CheckIn'
import Dashboard from './pages/Dashboard'
import Deleted from './pages/Deleted'
import Login from './pages/Login'
import Reports from './pages/Reports'
import { Clients, Directory, RoomTypes, Rooms, Users } from './pages/Setup'
import StayDetail from './pages/StayDetail'
import Stays from './pages/Stays'

function Guard({ allow, children }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (allow && !allow.includes(user.role)) {
    return <Navigate to={user.role === 'SUPER_ADMIN' ? '/clients' : '/'} replace />
  }
  return children
}

const STAFF = ['CLIENT_ADMIN', 'CLIENT_USER']
const ADMIN = ['CLIENT_ADMIN']
const SUPER = ['SUPER_ADMIN']

export default function App() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route index element={<Guard allow={STAFF}><Dashboard /></Guard>} />
        <Route path="check-in" element={<Guard allow={STAFF}><CheckIn /></Guard>} />
        <Route path="stays" element={<Guard allow={STAFF}><Stays /></Guard>} />
        <Route path="stays/:id" element={<Guard allow={STAFF}><StayDetail /></Guard>} />
        <Route path="stays/:id/edit" element={<Guard allow={STAFF}><CheckIn /></Guard>} />
        <Route path="balances" element={<Guard allow={STAFF}><Stays balancesOnly /></Guard>} />
        <Route path="directory" element={<Guard allow={STAFF}><Directory /></Guard>} />
        <Route path="reports" element={<Reports />} />
        <Route path="rooms" element={<Guard allow={ADMIN}><Rooms /></Guard>} />
        <Route path="room-types" element={<Guard allow={ADMIN}><RoomTypes /></Guard>} />
        <Route path="users" element={<Guard allow={ADMIN}><Users /></Guard>} />
        <Route path="deleted" element={<Guard allow={ADMIN}><Deleted /></Guard>} />
        <Route path="clients" element={<Guard allow={SUPER}><Clients /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
