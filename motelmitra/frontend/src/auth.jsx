import { createContext, useContext, useState } from 'react'
import api, { tokens } from './api'

const AuthContext = createContext(null)

function storedUser() {
  try {
    return tokens.access ? JSON.parse(localStorage.getItem('mm_user')) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(storedUser)

  async function login(username, password) {
    const { data } = await api.post('/auth/login/', { username, password })
    tokens.set(data.access, data.refresh)
    localStorage.setItem('mm_user', JSON.stringify(data.user))
    setUser(data.user)
    return data.user
  }

  function logout() {
    tokens.clear()
    setUser(null)
  }

  const value = {
    user,
    login,
    logout,
    isSuper: user?.role === 'SUPER_ADMIN',
    isAdmin: user?.role === 'CLIENT_ADMIN',
    isStaff: user?.role === 'CLIENT_ADMIN' || user?.role === 'CLIENT_USER',
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext)
