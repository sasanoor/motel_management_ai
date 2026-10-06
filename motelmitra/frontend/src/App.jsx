import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './auth'
import Layout from './components/Layout'
import CheckIn from './pages/CheckIn'
import Dashboard from './pages/Dashboard'
import Deleted from './pages/Deleted'
import Dnr from './pages/Dnr'
import Login from './pages/Login'
import Maintenance from './pages/Maintenance'
import Housekeeping from './pages/Housekeeping'
import Problems from './pages/Problems'
import Reports from './pages/Reports'
import { ChargesSettings, Clients, Directory, RoomTypes, Rooms, Users } from './pages/Setup'
import StayDetail from './pages/StayDetail'
import TodayReport from './pages/TodayReport'
import NightAudit from './pages/NightAudit'
import PhoneUpload from './pages/PhoneUpload'
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

// Maintenance users start on the housekeeping board.
function Home() {
  const { user } = useAuth()
  return user.role === 'MAINTENANCE' ? <Housekeeping /> : <Dashboard />
}
const ADMIN = ['CLIENT_ADMIN']
const SUPER = ['SUPER_ADMIN']

export default function App() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      {/* phone camera page from the QR code: no login */}
      <Route path="/m/:token" element={<PhoneUpload />} />
      <Route element={<Guard><Layout /></Guard>}>
        <Route index element={<Guard allow={[...STAFF, 'MAINTENANCE']}><Home /></Guard>} />
        <Route path="housekeeping" element={<Guard allow={[...STAFF, 'MAINTENANCE']}><Housekeeping /></Guard>} />
        <Route path="problems" element={<Guard allow={[...STAFF, 'MAINTENANCE']}><Problems /></Guard>} />
        <Route path="notes" element={<Guard allow={[...STAFF, 'MAINTENANCE']}><Maintenance /></Guard>} />
        <Route path="check-in" element={<Guard allow={STAFF}><CheckIn /></Guard>} />
        <Route path="stays" element={<Guard allow={STAFF}><Stays /></Guard>} />
        <Route path="stays/:id" element={<Guard allow={STAFF}><StayDetail /></Guard>} />
        <Route path="stays/:id/edit" element={<Guard allow={STAFF}><CheckIn /></Guard>} />
        <Route path="balances" element={<Guard allow={STAFF}><Stays balancesOnly /></Guard>} />
        <Route path="directory" element={<Guard allow={STAFF}><Directory /></Guard>} />
        <Route path="dnr" element={<Guard allow={STAFF}><Dnr /></Guard>} />
        <Route path="today" element={<Guard allow={STAFF}><TodayReport /></Guard>} />
        <Route path="night-audit" element={<Guard allow={STAFF}><NightAudit /></Guard>} />
        <Route path="reports" element={<Guard allow={[...STAFF, ...SUPER]}><Reports /></Guard>} />
        <Route path="rooms" element={<Guard allow={ADMIN}><Rooms /></Guard>} />
        <Route path="room-types" element={<Guard allow={ADMIN}><RoomTypes /></Guard>} />
        <Route path="charges" element={<Guard allow={ADMIN}><ChargesSettings /></Guard>} />
        <Route path="users" element={<Guard allow={ADMIN}><Users /></Guard>} />
        <Route path="deleted" element={<Guard allow={ADMIN}><Deleted /></Guard>} />
        <Route path="clients" element={<Guard allow={SUPER}><Clients /></Guard>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
