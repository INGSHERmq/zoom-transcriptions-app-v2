// src/components/Dashboard.jsx
import { useEffect, useState } from 'react'
import { zoomApi } from '../services/zoomApi'
import MeetingCard from './MeetingCard'

export default function Dashboard() {
  const [data, setData] = useState({ live: [], past: [], scheduled: [], noAperturadas: [] })
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('live')

  useEffect(() => {
    const load = async () => {
      try {
        const res = await zoomApi.getMeetings()
        setData(res)
      } catch (err) {
        console.error(err)
      } finally {
        setLoading(false)
      }
    }
    load()
    const interval = setInterval(load, 10000)
    return () => clearInterval(interval)
  }, [])

  const tabs = [
    { id: 'live',         label: 'En curso',       count: data.live.length,         color: 'bg-green-500' },
    { id: 'finalizadas',  label: 'Finalizadas',    count: data.past.length,         color: 'bg-gray-700' },
    { id: 'proximas',     label: 'Próximas',       count: data.scheduled.length,    color: 'bg-blue-600' },
    { id: 'noAperturadas',label: 'No aperturadas', count: data.noAperturadas.length,color: 'bg-orange-600' },
  ]

  const currentList = {
    live: data.live,
    finalizadas: data.past,
    proximas: data.scheduled,
    noAperturadas: data.noAperturadas
  }[activeTab]

  const logout = () => {
    localStorage.removeItem('zoom_logged')
    window.location.reload()
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center text-3xl">Cargando...</div>

  return (
    <div className="min-h-screen bg-gray-100 flex">
      {/* Sidebar */}
      <aside className="w-80 bg-gray-900 text-white flex flex-col">
        <div className="p-8 border-b border-gray-800">
          <h1 className="text-3xl font-bold tracking-tight">Mis Clases</h1>
        </div>

        <nav className="flex-1 px-6 py-6 space-y-2">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`w-full text-left px-6 py-4 rounded-xl flex items-center justify-between transition-all
                ${activeTab === tab.id ? 'bg-gray-800 shadow-xl ring-2 ring-indigo-500' : 'hover:bg-gray-800'}`}
            >
              <span className="text-lg font-medium">{tab.label}</span>
              <span className={`px-4 py-1 rounded-full text-sm font-bold text-white ${tab.color}`}>
                {tab.count}
              </span>
            </button>
          ))}
        </nav>

        <div className="p-6 border-t border-gray-800">
          <button onClick={logout} className="w-full bg-red-600 hover:bg-red-700 py-3 rounded-xl font-bold transition">
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Contenido */}
      <main className="flex-1 p-10">
        <h2 className="text-4xl font-bold text-gray-800 mb-8">
          {tabs.find(t => t.id === activeTab)?.label} ({tabs.find(t => t.id === activeTab)?.count})
        </h2>

        {currentList?.length === 0 ? (
          <p className="text-2xl text-gray-500 text-center py-20">No hay clases en esta sección</p>
        ) : (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {currentList?.map(cls => (
              <MeetingCard
                key={cls.id || cls.uuid}
                meeting={cls}
                type={activeTab === 'live' ? 'live' : activeTab === 'finalizadas' ? 'ended' : 'scheduled'}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}